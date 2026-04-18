//:) include "hg_sdf.wgsl"

// ============================== SHARED STRUCTS ==============================

struct SharedUniforms {
    gridDimensions: vec3u,
    isoValue: f32,
    gridOffset: vec3f,
    voxelSize: f32,
    // Same tuning slots as MDC export (iso export reuses packing).
    mdcF0: vec4f,
    mdcF1: vec4f,
    mdcF2: vec4f,
    mdcF3: vec4f,
    mdcU0: vec4u,
    /// x,y,z,w = base element indices in `allDuals` for corners, edges, faces, cubes (DualVertex units).
    isoDualBases: vec4u,
}

struct Vertex {
    position: vec3f,
    normal: vec3f,
}

struct QEFData {
    ATA: mat3x3f,
    ATb: vec3f,
    massPoint: vec3f,
    numPoints: u32,
}

/// Per-sample dual vertex for simplicial ISO export (position + shifted scalar field value).
struct DualVertex {
    pos: vec3f,
    fval: f32,
}

// ============================== BIND GROUPS ==============================

@group(0) @binding(0) var<uniform> uniforms: SharedUniforms;

@group(0) @binding(27) var<storage, read> polygonVertices: array<vec2f>;

struct FaceSelection {
    nodeId: u32,
    faceIndex: u32,
    mode: u32,
    extrudeOffset: f32,
    pushPullActive: u32,
}
@group(0) @binding(28) var<uniform> faceSelection: FaceSelection;
const FACE_HIGHLIGHT_ID: u32 = 1023u;
const FACE_HIGHLIGHT_TOP: u32 = 1023u;
const FACE_HIGHLIGHT_BOTTOM: u32 = 1022u;

@group(0) @binding(30) var<storage, read> mdcSceneParams: array<f32>;
//:) include "mdc_scene_params_read.wgsl"

// Pass 1 — bit-packed active cell flags (same layout as MDC Pass 1).
@group(0) @binding(1) var<storage, read_write> activeCellFlags: array<u32>;

// Packed: [corners | X/Y/Z edges | XY/YZ/XZ faces | cube duals] — offsets in `uniforms.isoDualBases`.
@group(0) @binding(2) var<storage, read_write> allDuals: array<DualVertex>;

// Pass 6 — non-deduplicated mesh output (CPU weld in orchestrator).
@group(0) @binding(3) var<storage, read_write> meshVertices: array<Vertex>;
@group(0) @binding(4) var<storage, read_write> meshIndices: array<u32>;
@group(0) @binding(5) var<storage, read_write> meshIndexCount: atomic<u32>;

// Pass 7 — Newton-project welded vertex positions onto the iso surface
// and write analytical surface normals from sceneSDF_mid. The welded vertex
// array is uploaded by the orchestrator after CPU welding and read back in
// place. Pass 7 fixes the jagged appearance that arises from Marching
// Tetrahedra emitting many tiny slivers whose face-averaged normals would
// otherwise dominate the displayed shading.
@group(0) @binding(7) var<storage, read_write> projectVertices: array<Vertex>;

// Cancellation flag: 0 = continue, 1 = cancelled
@group(0) @binding(25) var<storage, read_write> cancelled: atomic<u32>;

// ============================== SCENE SDF HELPERS (must precede inserts; same as mdc.wgsl) ==============================

fn rectSDF2D(p: vec2f, center: vec2f, tangent: vec2f, normal: vec2f, halfW: f32, halfH: f32) -> f32 {
    let rel = p - center;
    let localX = dot(rel, tangent);
    let localY = dot(rel, normal);
    let dd = vec2f(abs(localX) - halfW, abs(localY) - halfH);
    return length(max(dd, vec2f(0.0))) + min(max(dd.x, dd.y), 0.0);
}

// ============================== SCENE SDF (inserts match mdc.wgsl) ==============================

//:) insert sceneAuxFast
//:) insert sceneAux
//:) insert sceneAuxMid

fn sceneSDF(p: vec3f) -> SDFResult {
    _ = polygonVertices[0];
    _ = faceSelection.nodeId;
    _ = mdcSceneParams[0];
    return sdfTrue(0.0, 0u, vec3f(0.0)); //:) insert sceneSDF
}

fn sceneSDF_mid(p: vec3f) -> SDFResultMid {
    _ = polygonVertices[0];
    _ = faceSelection.nodeId;
    _ = mdcSceneParams[0];
    return sdfRMid(0.0, 1.0, vec3f(0.0)); //:) insert sceneSDF_mid
}

fn sceneSDF_fast(p: vec3f) -> FastSDFResult {
    // Keep polygonVertices + faceSelection in this entry point's dependency set so every
    // @compute pass that only calls sceneSDF_fast still gets the same bind group layout as
    // passes that use sceneSDF_mid (WebGPU omits unused bindings per entry point).
    _ = polygonVertices[0];
    _ = faceSelection.nodeId;
    _ = mdcSceneParams[0];
    return sdfFast(0.0, 1.0, 1.0); //:) insert sceneSDF_fast
}

// ============================== LIFTED HELPERS (from mdc.wgsl) ==============================

fn mix3f(a: vec3f, b: vec3f, t: f32) -> vec3f {
    return a * (1.0f - t) + b * t;
}

fn safeUnit3(v: vec3f) -> vec3f {
    let l = length(v);
    if (l > 1e-12) {
        return v / l;
    }
    return vec3f(0.0, 0.0, 0.0);
}

fn gridPosToWorldPos(gridPos: vec3u) -> vec3f {
    return vec3f(gridPos) * uniforms.voxelSize + uniforms.gridOffset;
}

fn gridIndexTo3D(index: u32) -> vec3u {
    let x = index % uniforms.gridDimensions.x;
    let y = (index / uniforms.gridDimensions.x) % uniforms.gridDimensions.y;
    let z = index / (uniforms.gridDimensions.x * uniforms.gridDimensions.y);
    return vec3u(x, y, z);
}

fn gridPosToIndex(pos: vec3u) -> u32 {
    return pos.x + pos.y * uniforms.gridDimensions.x +
        pos.z * uniforms.gridDimensions.x * uniforms.gridDimensions.y;
}

fn edge_count_x(dx: u32, dy: u32, dz: u32) -> u32 {
    return (dx - 1u) * dy * dz;
}
fn edge_count_y(dx: u32, dy: u32, dz: u32) -> u32 {
    return dx * (dy - 1u) * dz;
}
fn edge_count_z(dx: u32, dy: u32, dz: u32) -> u32 {
    return dx * dy * (dz - 1u);
}

fn face_count_xy(dx: u32, dy: u32, dz: u32) -> u32 {
    return (dx - 1u) * (dy - 1u) * dz;
}
fn face_count_yz(dx: u32, dy: u32, dz: u32) -> u32 {
    return dx * (dy - 1u) * (dz - 1u);
}
fn face_count_xz(dx: u32, dy: u32, dz: u32) -> u32 {
    return (dx - 1u) * dy * (dz - 1u);
}

fn cell_count_interior(dx: u32, dy: u32, dz: u32) -> u32 {
    return (dx - 1u) * (dy - 1u) * (dz - 1u);
}

fn dual_corner(i: u32) -> DualVertex {
    return allDuals[uniforms.isoDualBases.x + i];
}
fn dual_edge(i: u32) -> DualVertex {
    return allDuals[uniforms.isoDualBases.y + i];
}
fn dual_face(i: u32) -> DualVertex {
    return allDuals[uniforms.isoDualBases.z + i];
}
fn dual_cube(i: u32) -> DualVertex {
    return allDuals[uniforms.isoDualBases.w + i];
}
fn set_dual_corner(i: u32, dv: DualVertex) {
    allDuals[uniforms.isoDualBases.x + i] = dv;
}
fn set_dual_edge(i: u32, dv: DualVertex) {
    allDuals[uniforms.isoDualBases.y + i] = dv;
}
fn set_dual_face(i: u32, dv: DualVertex) {
    allDuals[uniforms.isoDualBases.z + i] = dv;
}
fn set_dual_cube(i: u32, dv: DualVertex) {
    allDuals[uniforms.isoDualBases.w + i] = dv;
}

fn face_idx_xy(fx: u32, fy: u32, fz: u32, dx: u32, dy: u32) -> u32 {
    return fx + fy * (dx - 1u) + fz * (dx - 1u) * (dy - 1u);
}
fn face_idx_yz(ix: u32, iy: u32, iz: u32, dx: u32, dy: u32) -> u32 {
    return ix + iy * dx + iz * dx * (dy - 1u);
}
fn face_idx_xz(ix: u32, iy: u32, iz: u32, dx: u32, dy: u32) -> u32 {
    return ix + iy * (dx - 1u) + iz * (dx - 1u) * dy;
}

fn cell_linear(c: vec3u, nx: u32, ny: u32) -> u32 {
    return c.x + c.y * nx + c.z * nx * ny;
}
fn cell_valid(c: vec3u, nx: u32, ny: u32, nz: u32) -> bool {
    return c.x < nx && c.y < ny && c.z < nz;
}

fn is_active_cell_at_min_corner(cellMinCorner: vec3u) -> bool {
    let cellFlat = gridPosToIndex(cellMinCorner);
    let word = cellFlat / 32u;
    let bit = cellFlat % 32u;
    if (word >= arrayLength(&activeCellFlags)) {
        return false;
    }
    return (activeCellFlags[word] & (1u << bit)) != 0u;
}

fn sdf_sign_bit_positive(f: f32) -> bool {
    return f > 0.0;
}

fn totalU32sInFlags() -> u32 {
    return (uniforms.gridDimensions.x * uniforms.gridDimensions.y * uniforms.gridDimensions.z + 31u) / 32u;
}

fn isCancelled() -> bool {
    return atomicLoad(&cancelled) != 0u;
}

fn getCellCornerPos(cellPos: vec3u, cornerIndex: u32) -> vec3u {
    return cellPos + vec3u(
        cornerIndex & 1u,
        (cornerIndex >> 1u) & 1u,
        (cornerIndex >> 2u) & 1u
    );
}

fn sampleSDF(worldPos: vec3f) -> f32 {
    return sceneSDF_fast(worldPos).d;
}

fn findEdgeIntersection(p0_val: f32, p1_val: f32) -> f32 {
    let diff = p1_val - p0_val;
    if (abs(diff) < 0.00001) {
        return 0.5;
    }
    return clamp((uniforms.isoValue - p0_val) / diff, 0.0, 1.0);
}

fn resolveSignAtPos(p: vec3f, d: f32) -> i32 {
    let eps = max(uniforms.mdcF0.y * 0.5, uniforms.voxelSize * uniforms.mdcF0.x * 0.5);
    if (d > eps) {
        return 1;
    }
    if (d < -eps) {
        return -1;
    }

    let sdf = sceneSDF_mid(p);
    let n = sdf.n * select(-1.0, 1.0, sdf.d >= 0.0);
    if (length(n) > 0.0) {
        let nudge = min(eps, uniforms.voxelSize * 0.02);
        let d2p = sceneSDF_fast(p + n * nudge).d - uniforms.isoValue;
        let d2m = sceneSDF_fast(p - n * nudge).d - uniforms.isoValue;
        if (d2p > 0.0 && d2m > 0.0) {
            return 1;
        }
        if (d2p < 0.0 && d2m < 0.0) {
            return -1;
        }
    }
    return 0;
}

fn vertexClassAtGridVertex(p: vec3f, sdfValue: f32) -> i32 {
    let d = sdfValue - uniforms.isoValue;
    return resolveSignAtPos(p, d);
}

fn isNan(x: f32) -> bool {
    let high = 100000000.0;
    return max(x, high) == high && x != x;
}

fn isInf(x: f32) -> bool {
    return abs(x) >= f32(bitcast<u32>(0x7f800000u) - 1u);
}

fn estimateConditionNumber(A: mat3x3f) -> f32 {
    var v = vec3f(1.0, 1.0, 1.0);
    var lambda_max = 0.0;
    for (var i = 0; i < 5; i = i + 1) {
        v = A * v;
        let norm_v = length(v);
        if (norm_v > 1e-6) {
            lambda_max = norm_v;
            v = v / norm_v;
        } else {
            break;
        }
    }
    let trace_A = A[0][0] + A[1][1] + A[2][2];
    let lambda_min_est = max(1e-6, abs(trace_A / 3.0 - lambda_max * 0.666));
    if (lambda_min_est == 0.0) {
        return 1e9;
    }
    return abs(lambda_max / lambda_min_est);
}

fn solveCholesky(A: mat3x3f, b: vec3f) -> vec3f {
    var L: mat3x3f;

    L[0][0] = sqrt(max(A[0][0], 1e-6));
    if (L[0][0] == 0.0) {
        return vec3f(0.0);
    }
    L[1][0] = A[1][0] / L[0][0];
    L[2][0] = A[2][0] / L[0][0];

    L[0][1] = 0.0;
    var val_L11_sq = A[1][1] - L[1][0] * L[1][0];
    L[1][1] = sqrt(max(val_L11_sq, 1e-6));
    if (L[1][1] == 0.0) {
        return vec3f(0.0);
    }
    L[2][1] = (A[2][1] - L[2][0] * L[1][0]) / L[1][1];

    L[0][2] = 0.0;
    L[1][2] = 0.0;
    var val_L22_sq = A[2][2] - L[2][0] * L[2][0] - L[2][1] * L[2][1];
    L[2][2] = sqrt(max(val_L22_sq, 1e-6));
    if (L[2][2] == 0.0) {
        return vec3f(0.0);
    }

    var y: vec3f;
    y.x = b.x / L[0][0];
    y.y = (b.y - L[1][0] * y.x) / L[1][1];
    y.z = (b.z - L[2][0] * y.x - L[2][1] * y.y) / L[2][2];

    var x: vec3f;
    x.z = y.z / L[2][2];
    x.y = (y.y - L[2][1] * x.z) / L[1][1];
    x.x = (y.x - L[1][0] * x.y - L[2][0] * x.z) / L[0][0];

    return x;
}

fn solveQEF(qef: QEFData) -> vec3f {
    if (qef.numPoints == 0u) {
        return vec3f(0.0);
    }

    let massPoint = qef.massPoint / f32(qef.numPoints);

    if (qef.numPoints < 3u) {
        return massPoint;
    }

    var ATA_reg = qef.ATA;
    let regularization = max(uniforms.mdcF2.w, uniforms.voxelSize * uniforms.mdcF2.z);
    ATA_reg[0][0] += regularization;
    ATA_reg[1][1] += regularization;
    ATA_reg[2][2] += regularization;

    if (estimateConditionNumber(ATA_reg) > uniforms.mdcF3.x) {
        return massPoint;
    }

    let b_reg = qef.ATb + massPoint * regularization;
    let solution = solveCholesky(ATA_reg, b_reg);

    let solution_is_nan = vec3<bool>(isNan(solution.x), isNan(solution.y), isNan(solution.z));
    let solution_is_inf = vec3<bool>(isInf(solution.x), isInf(solution.y), isInf(solution.z));
    if (any(solution_is_nan) || any(solution_is_inf)) {
        return massPoint;
    }

    return solution;
}

fn qefCost(qef: QEFData, x: vec3f) -> f32 {
    let Ax = qef.ATA * x;
    return dot(x, Ax) - 2.0 * dot(x, qef.ATb);
}

// Marching tetrahedra (canonical tet edges): e0=(v0,v1), e1=(v1,v2), e2=(v2,v0), e3=(v0,v3), e4=(v1,v3), e5=(v2,v3).
// Case index: bit i = vertex i has fval > 0 (outside). Table from mikolalysenko/isosurface marchingtetrahedra.js
// with `ourCase = 15u - triindex` so bits match "outside = positive shifted SDF".
const MARCHING_TETRAHEDRA_NUM_TRIS: array<u32, 16> = array<u32, 16>(
    0u, 1u, 1u, 2u, 1u, 2u, 2u, 1u, 1u, 2u, 2u, 1u, 2u, 1u, 1u, 0u
);
// Six u32 per case: tri0 (e0,e1,e2), tri1 (e3,e4,e5); unused slots = 255u.
const MARCHING_TETRAHEDRA_EDGES: array<u32, 96> = array<u32, 96>(
    255u, 255u, 255u, 255u, 255u, 255u,
    0u, 3u, 2u, 255u, 255u, 255u,
    0u, 1u, 4u, 255u, 255u, 255u,
    1u, 4u, 2u, 4u, 3u, 2u,
    1u, 5u, 2u, 255u, 255u, 255u,
    0u, 3u, 1u, 3u, 5u, 1u,
    5u, 4u, 2u, 4u, 0u, 2u,
    3u, 5u, 4u, 255u, 255u, 255u,
    3u, 4u, 5u, 255u, 255u, 255u,
    5u, 2u, 4u, 2u, 0u, 4u,
    0u, 1u, 3u, 1u, 5u, 3u,
    1u, 2u, 5u, 255u, 255u, 255u,
    1u, 2u, 4u, 2u, 3u, 4u,
    0u, 4u, 1u, 255u, 255u, 255u,
    0u, 2u, 3u, 255u, 255u, 255u,
    255u, 255u, 255u, 255u, 255u, 255u
);

fn marching_tetra_num_tris(case_id: u32) -> u32 {
    return MARCHING_TETRAHEDRA_NUM_TRIS[case_id];
}

fn marching_tetra_edge(case_id: u32, tri_i: u32, corner_in_tri: u32) -> u32 {
    let base = case_id * 6u + tri_i * 3u + corner_in_tri;
    return MARCHING_TETRAHEDRA_EDGES[base];
}

fn tet_edge_v0(e: u32) -> u32 {
    switch e {
        case 0u, 3u: { return 0u; }
        case 1u, 4u: { return 1u; }
        case 2u, 5u: { return 2u; }
        default: { return 0u; }
    }
}

fn tet_edge_v1(e: u32) -> u32 {
    switch e {
        case 0u: { return 1u; }
        case 1u: { return 2u; }
        case 2u: { return 0u; }
        case 3u, 4u, 5u: { return 3u; }
        default: { return 0u; }
    }
}

fn interp_iso_crossing(va: DualVertex, vb: DualVertex) -> vec3f {
    let fi = va.fval;
    let fj = vb.fval;
    let denom = fi - fj;
    if (abs(denom) < 1e-20) {
        return va.pos;
    }
    let t = clamp(fi / denom, 0.0, 1.0);
    return mix3f(va.pos, vb.pos, t);
}

fn emit_mt_tetra(verts: array<DualVertex, 4>) {
    let case_id =
        (select(0u, 1u, verts[0].fval > 0.0)) |
        (select(0u, 2u, verts[1].fval > 0.0)) |
        (select(0u, 4u, verts[2].fval > 0.0)) |
        (select(0u, 8u, verts[3].fval > 0.0));
    let nt = marching_tetra_num_tris(case_id);
    for (var ti = 0u; ti < 2u; ti = ti + 1u) {
        if (ti >= nt) {
            break;
        }
        var tp0 = vec3f(0.0);
        var tp1 = vec3f(0.0);
        var tp2 = vec3f(0.0);
        for (var k = 0u; k < 3u; k = k + 1u) {
            let eid = marching_tetra_edge(case_id, ti, k);
            let a = tet_edge_v0(eid);
            let b = tet_edge_v1(eid);
            let pos = interp_iso_crossing(verts[a], verts[b]);
            if (k == 0u) {
                tp0 = pos;
            } else if (k == 1u) {
                tp1 = pos;
            } else {
                tp2 = pos;
            }
        }
        // Analytic normals from the SDF gradient (sceneSDF_mid). Smooth surfaces would otherwise
        // get face-averaged shading via splitCreaseVertices, which breaks badly when our coarse
        // mesh produces adjacent face normals > crease threshold (every edge ends up a "crease").
        let n0 = safeUnit3(sceneSDF_mid(tp0).n);
        let n1 = safeUnit3(sceneSDF_mid(tp1).n);
        let n2 = safeUnit3(sceneSDF_mid(tp2).n);
        let base = atomicAdd(&meshIndexCount, 3u);
        if (base + 2u >= arrayLength(&meshVertices)) {
            continue;
        }
        meshVertices[base + 0u] = Vertex(tp0, n0);
        meshVertices[base + 1u] = Vertex(tp1, n1);
        meshVertices[base + 2u] = Vertex(tp2, n2);
        meshIndices[base + 0u] = base + 0u;
        meshIndices[base + 1u] = base + 1u;
        meshIndices[base + 2u] = base + 2u;
    }
}

fn emit_four_tets_face_pair(
    p0: DualVertex,
    p1: DualVertex,
    edge: DualVertex,
    face: DualVertex,
    cube_a: DualVertex,
    cube_b: DualVertex,
) {
    var t: array<DualVertex, 4>;
    t[1] = edge;
    t[2] = face;
    t[0] = p0;
    t[3] = cube_a;
    emit_mt_tetra(t);
    t[0] = p1;
    t[3] = cube_a;
    emit_mt_tetra(t);
    t[0] = p0;
    t[3] = cube_b;
    emit_mt_tetra(t);
    t[0] = p1;
    t[3] = cube_b;
    emit_mt_tetra(t);
}

fn face_xy_dual_at(fx: u32, fy: u32, fz: u32, dx: u32, dy: u32) -> DualVertex {
    return dual_face(face_idx_xy(fx, fy, fz, dx, dy));
}

fn face_yz_dual_at(ix: u32, iy: u32, iz: u32, dx: u32, dy: u32, n_xy: u32) -> DualVertex {
    return dual_face(n_xy + face_idx_yz(ix, iy, iz, dx, dy));
}

fn face_xz_dual_at(ix: u32, iy: u32, iz: u32, dx: u32, dy: u32, n_xy: u32, n_yz: u32) -> DualVertex {
    return dual_face(n_xy + n_yz + face_idx_xz(ix, iy, iz, dx, dy));
}

// Workgroup scratch (same pattern as mdc.wgsl Pass 1).
var<workgroup> workgroup_thread_flags: array<u32, 256>;

// ============================== COMPUTE ENTRY POINTS (stubs) ==============================
// Full implementations follow in ISO orchestrator work; stubs keep the module linkable.

// Pass 1: bit-packed active cell flags (1 bit per cell, same layout as MDC `cellClassification_Pass1`).
// Dispatch: num_workgroups = ceil(totalGridCells / 32) with 1D linearized workgroups.
// Active = any sign change among 8 corners (or on-surface corner), using `vertexClassAtGridVertex`.
@compute @workgroup_size(32, 1, 1)
fn classifyActiveCells_Pass1(
    @builtin(local_invocation_id) localId: vec3u,
    @builtin(workgroup_id) workgroupId: vec3u,
    @builtin(num_workgroups) numWg: vec3u
) {
    let u32_block_index = workgroupId.x + workgroupId.y * numWg.x + workgroupId.z * numWg.x * numWg.y;
    let bit_index_in_u32 = localId.x;

    let cellFlatIndex = u32_block_index * 32u + bit_index_in_u32;
    let totalGridCells = uniforms.gridDimensions.x * uniforms.gridDimensions.y * uniforms.gridDimensions.z;

    // Do not return early on cancel — every thread must reach the workgroup barrier.
    let cancelled = isCancelled();

    var cell_is_active = 0u;
    if (!cancelled && cellFlatIndex < totalGridCells) {
        let cellPos = gridIndexTo3D(cellFlatIndex);
        if (all(cellPos < uniforms.gridDimensions - 1u)) {
            var hasPositive = false;
            var hasNegative = false;
            for (var i = 0u; i < 8u; i = i + 1u) {
                let cornerGridPos = getCellCornerPos(cellPos, i);
                let cornerWorldPos = gridPosToWorldPos(cornerGridPos);
                let sdfValue = sampleSDF(cornerWorldPos);
                let c = vertexClassAtGridVertex(cornerWorldPos, sdfValue);
                if (c > 0) { hasPositive = true; }
                if (c < 0) { hasNegative = true; }
                if (c == 0) { hasPositive = true; hasNegative = true; }
                if (hasPositive && hasNegative) { break; }
            }
            if (hasPositive && hasNegative) {
                cell_is_active = 1u;
            }
        }
    }

    workgroup_thread_flags[bit_index_in_u32] = cell_is_active;
    workgroupBarrier();

    if (bit_index_in_u32 == 0u) {
        var packedFlags = 0u;
        for (var i = 0u; i < 32u; i = i + 1u) {
            if (workgroup_thread_flags[i] != 0u) {
                packedFlags = packedFlags | (1u << i);
            }
        }
        let totalU32sToStore = (totalGridCells + 31u) / 32u;
        if (u32_block_index < totalU32sToStore && u32_block_index < arrayLength(&activeCellFlags)) {
            activeCellFlags[u32_block_index] = packedFlags;
        }
    }
}

/// One thread per grid corner: world position and F-iso (for downstream sign tests / marching).
/// Dispatch: 1D or 2D workgroups of 64; the host falls back to 2D when total
/// workgroups exceed 65535 (`maxComputeWorkgroupsPerDimension`). Linearize
/// `(globalId.x, globalId.y)` so the 2D path doesn't silently drop work past
/// the first 4M corners — same convention as `mdc.wgsl` Pass 3 / Pass 5.
@compute @workgroup_size(64, 1, 1)
fn placeCornerSamples_Pass2(
    @builtin(global_invocation_id) global_id: vec3u,
    @builtin(num_workgroups) numWg: vec3u,
) {
    if (isCancelled()) {
        return;
    }
    let corner_idx = global_id.x + global_id.y * (numWg.x * 64u);
    let dx = uniforms.gridDimensions.x;
    let dy = uniforms.gridDimensions.y;
    let dz = uniforms.gridDimensions.z;
    let total_corners = dx * dy * dz;
    if (corner_idx >= total_corners) {
        return;
    }

    let grid_pos = gridIndexTo3D(corner_idx);
    let world_pos = gridPosToWorldPos(grid_pos);
    let f_shifted = sceneSDF_fast(world_pos).d - uniforms.isoValue;
    set_dual_corner(corner_idx, DualVertex(world_pos, f_shifted));
}

@compute @workgroup_size(64, 1, 1)
fn placeEdgeDuals_Pass3(
    @builtin(global_invocation_id) globalId: vec3u,
    @builtin(num_workgroups) numWg: vec3u,
) {
    if (isCancelled()) {
        return;
    }
    let dx = uniforms.gridDimensions.x;
    let dy = uniforms.gridDimensions.y;
    let dz = uniforms.gridDimensions.z;
    if (dx < 2u || dy < 2u || dz < 2u) {
        return;
    }

    let n_x = edge_count_x(dx, dy, dz);
    let n_y = edge_count_y(dx, dy, dz);
    let n_z = edge_count_z(dx, dy, dz);
    let total_edges = n_x + n_y + n_z;
    let idx = globalId.x + globalId.y * (numWg.x * 64u);
    if (idx >= total_edges) {
        return;
    }

    var buf_idx: u32;
    var p0: vec3u;
    var p1: vec3u;

    if (idx < n_x) {
        buf_idx = idx;
        let x = idx % (dx - 1u);
        let y = (idx / (dx - 1u)) % dy;
        let z = idx / ((dx - 1u) * dy);
        p0 = vec3u(x, y, z);
        p1 = vec3u(x + 1u, y, z);
    } else if (idx < n_x + n_y) {
        let j = idx - n_x;
        buf_idx = n_x + j;
        let x = j % dx;
        let y = (j / dx) % (dy - 1u);
        let z = j / (dx * (dy - 1u));
        p0 = vec3u(x, y, z);
        p1 = vec3u(x, y + 1u, z);
    } else {
        let j = idx - n_x - n_y;
        buf_idx = n_x + n_y + j;
        let x = j % dx;
        let y = (j / dx) % dy;
        let z = j / (dx * dy);
        p0 = vec3u(x, y, z);
        p1 = vec3u(x, y, z + 1u);
    }

    let edge_total = uniforms.isoDualBases.z - uniforms.isoDualBases.y;
    if (buf_idx >= edge_total) {
        return;
    }

    let eps_t = max(uniforms.mdcF0.x, 1e-6);
    let t_max = 1.0 - eps_t;

    let i0 = gridPosToIndex(p0);
    let i1 = gridPosToIndex(p1);
    let d0 = dual_corner(i0).fval;
    let d1 = dual_corner(i1).fval;
    let w0 = gridPosToWorldPos(p0);
    let w1 = gridPosToWorldPos(p1);

    let pos_out = sdf_sign_bit_positive(d0);
    let pos_in1 = sdf_sign_bit_positive(d1);
    let sign_change = pos_out != pos_in1;

    if (sign_change) {
        let denom = d1 - d0;
        var t = 0.5;
        if (abs(denom) > 1e-20) {
            t = clamp(-d0 / denom, eps_t, t_max);
        }
        let pos = mix3f(w0, w1, t);
        set_dual_edge(buf_idx, DualVertex(pos, 0.0));
    } else {
        let pos = mix3f(w0, w1, 0.5);
        let f_shifted = sceneSDF_fast(pos).d - uniforms.isoValue;
        set_dual_edge(buf_idx, DualVertex(pos, f_shifted));
    }
}

@compute @workgroup_size(64, 1, 1)
fn placeFaceDuals_Pass4(
    @builtin(global_invocation_id) globalId: vec3u,
    @builtin(num_workgroups) numWg: vec3u,
) {
    if (isCancelled()) {
        return;
    }
    let dx = uniforms.gridDimensions.x;
    let dy = uniforms.gridDimensions.y;
    let dz = uniforms.gridDimensions.z;
    if (dx < 2u || dy < 2u || dz < 2u) {
        return;
    }

    let n_xy = face_count_xy(dx, dy, dz);
    let n_yz = face_count_yz(dx, dy, dz);
    let n_xz = face_count_xz(dx, dy, dz);
    let total_faces = n_xy + n_yz + n_xz;
    let idx = globalId.x + globalId.y * (numWg.x * 64u);
    if (idx >= total_faces) {
        return;
    }

    var buf_idx: u32;
    var c00: vec3u;
    var c10: vec3u;
    var c01: vec3u;
    var c11: vec3u;
    var face_normal: vec3f;
    var axis: u32;

    if (idx < n_xy) {
        axis = 0u;
        buf_idx = idx;
        let fx = idx % (dx - 1u);
        let fy = (idx / (dx - 1u)) % (dy - 1u);
        let fz = idx / ((dx - 1u) * (dy - 1u));
        c00 = vec3u(fx, fy, fz);
        c10 = vec3u(fx + 1u, fy, fz);
        c01 = vec3u(fx, fy + 1u, fz);
        c11 = vec3u(fx + 1u, fy + 1u, fz);
        face_normal = vec3f(0.0, 0.0, 1.0);
    } else if (idx < n_xy + n_yz) {
        axis = 1u;
        let j = idx - n_xy;
        buf_idx = n_xy + j;
        let ix = j % dx;
        let iy = (j / dx) % (dy - 1u);
        let iz = j / (dx * (dy - 1u));
        c00 = vec3u(ix, iy, iz);
        c10 = vec3u(ix, iy + 1u, iz);
        c01 = vec3u(ix, iy, iz + 1u);
        c11 = vec3u(ix, iy + 1u, iz + 1u);
        face_normal = vec3f(1.0, 0.0, 0.0);
    } else {
        axis = 2u;
        let j = idx - n_xy - n_yz;
        buf_idx = n_xy + n_yz + j;
        let ix = j % (dx - 1u);
        let iy = (j / (dx - 1u)) % dy;
        let iz = j / ((dx - 1u) * dy);
        c00 = vec3u(ix, iy, iz);
        c10 = vec3u(ix + 1u, iy, iz);
        c01 = vec3u(ix, iy, iz + 1u);
        c11 = vec3u(ix + 1u, iy, iz + 1u);
        face_normal = vec3f(0.0, 1.0, 0.0);
    }

    let face_total = uniforms.isoDualBases.w - uniforms.isoDualBases.z;
    if (buf_idx >= face_total) {
        return;
    }

    let eps_uv = max(uniforms.mdcF0.x, 1e-6);
    let uv_max = 1.0 - eps_uv;
    let vs = uniforms.voxelSize;

    let i00 = gridPosToIndex(c00);
    let i10 = gridPosToIndex(c10);
    let i01 = gridPosToIndex(c01);
    let i11 = gridPosToIndex(c11);

    let f00 = dual_corner(i00).fval;
    let f10 = dual_corner(i10).fval;
    let f01 = dual_corner(i01).fval;
    let f11 = dual_corner(i11).fval;

    let w00 = gridPosToWorldPos(c00);
    let w10 = gridPosToWorldPos(c10);
    let w01 = gridPosToWorldPos(c01);
    let w11 = gridPosToWorldPos(c11);

    var u = 0.5;
    var v = 0.5;
    var pos = w00 * (1.0 - u) * (1.0 - v) + w10 * u * (1.0 - v) + w01 * (1.0 - u) * v + w11 * u * v;
    let f_center = sceneSDF_fast(pos).d - uniforms.isoValue;

    let c_pos = sdf_sign_bit_positive(f_center);
    let iso_crosses_face = (c_pos != sdf_sign_bit_positive(f00)) ||
        (c_pos != sdf_sign_bit_positive(f10)) ||
        (c_pos != sdf_sign_bit_positive(f01)) ||
        (c_pos != sdf_sign_bit_positive(f11));

    if (iso_crosses_face) {
        let sdf_mid = sceneSDF_mid(pos);
        var g = sdf_mid.n - face_normal * dot(sdf_mid.n, face_normal);
        let gl = length(g);
        if (gl > 1e-12) {
            g = g / gl;
        } else {
            g = vec3f(0.0);
        }

        let step = clamp(f_center * vs * 0.35, -vs * 0.45, vs * 0.45);
        var pos_g = pos - g * step;

        if (axis == 0u) {
            pos_g.z = w00.z;
        } else if (axis == 1u) {
            pos_g.x = w00.x;
        } else {
            pos_g.y = w00.y;
        }

        let rel = pos_g - w00;
        if (axis == 0u) {
            u = clamp(rel.x / vs, eps_uv, uv_max);
            v = clamp(rel.y / vs, eps_uv, uv_max);
        } else if (axis == 1u) {
            u = clamp(rel.y / vs, eps_uv, uv_max);
            v = clamp(rel.z / vs, eps_uv, uv_max);
        } else {
            u = clamp(rel.x / vs, eps_uv, uv_max);
            v = clamp(rel.z / vs, eps_uv, uv_max);
        }

        pos = w00 * (1.0 - u) * (1.0 - v) + w10 * u * (1.0 - v) + w01 * (1.0 - u) * v + w11 * u * v;

        let f_g = sceneSDF_fast(pos).d - uniforms.isoValue;
        if (f_center * f_g < 0.0) {
            pos = (pos_g + pos) * 0.5;
            let rel2 = pos - w00;
            if (axis == 0u) {
                u = clamp(rel2.x / vs, eps_uv, uv_max);
                v = clamp(rel2.y / vs, eps_uv, uv_max);
            } else if (axis == 1u) {
                u = clamp(rel2.y / vs, eps_uv, uv_max);
                v = clamp(rel2.z / vs, eps_uv, uv_max);
            } else {
                u = clamp(rel2.x / vs, eps_uv, uv_max);
                v = clamp(rel2.z / vs, eps_uv, uv_max);
            }
            pos = w00 * (1.0 - u) * (1.0 - v) + w10 * u * (1.0 - v) + w01 * (1.0 - u) * v + w11 * u * v;
        }
    }

    let f_out = sceneSDF_fast(pos).d - uniforms.isoValue;
    set_dual_face(buf_idx, DualVertex(pos, f_out));
}

@compute @workgroup_size(64, 1, 1)
fn placeCubeDuals_Pass5(
    @builtin(global_invocation_id) globalId: vec3u,
    @builtin(num_workgroups) numWg: vec3u,
) {
    if (isCancelled()) {
        return;
    }
    let dx = uniforms.gridDimensions.x;
    let dy = uniforms.gridDimensions.y;
    let dz = uniforms.gridDimensions.z;
    if (dx < 2u || dy < 2u || dz < 2u) {
        return;
    }

    let nx = dx - 1u;
    let ny = dy - 1u;
    let nz = dz - 1u;
    let total_cells = nx * ny * nz;
    let cell_idx = globalId.x + globalId.y * (numWg.x * 64u);
    if (cell_idx >= total_cells) {
        return;
    }
    let cube_total = arrayLength(&allDuals) - uniforms.isoDualBases.w;
    if (cell_idx >= cube_total) {
        return;
    }

    let x = cell_idx % nx;
    let y = (cell_idx / nx) % ny;
    let z = cell_idx / (nx * ny);
    let cell_pos = vec3u(x, y, z);

    let eps_t = max(uniforms.mdcF0.x, 1e-6);
    let t_max = 1.0 - eps_t;
    let cell_min = gridPosToWorldPos(cell_pos);
    let cell_max = cell_min + vec3f(uniforms.voxelSize);
    let shrink = uniforms.voxelSize * eps_t;
    let clamp_min = cell_min + vec3f(shrink);
    let clamp_max = cell_max - vec3f(shrink);

    if (!is_active_cell_at_min_corner(cell_pos)) {
        let c = (cell_min + cell_max) * 0.5;
        let f_shifted = sceneSDF_fast(c).d - uniforms.isoValue;
        set_dual_cube(cell_idx, DualVertex(c, f_shifted));
        return;
    }

    let edges_v = array<vec2u, 12>(
        vec2u(0u, 1u), vec2u(2u, 3u), vec2u(4u, 5u), vec2u(6u, 7u),
        vec2u(0u, 2u), vec2u(1u, 3u), vec2u(4u, 6u), vec2u(5u, 7u),
        vec2u(0u, 4u), vec2u(1u, 5u), vec2u(2u, 6u), vec2u(3u, 7u)
    );

    var qef = QEFData(mat3x3f(), vec3f(0.0), vec3f(0.0), 0u);

    for (var e = 0u; e < 12u; e = e + 1u) {
        let a = edges_v[e].x;
        let b = edges_v[e].y;
        let ga = getCellCornerPos(cell_pos, a);
        let gb = getCellCornerPos(cell_pos, b);
        let ia = gridPosToIndex(ga);
        let ib = gridPosToIndex(gb);
        let f0 = dual_corner(ia).fval;
        let f1 = dual_corner(ib).fval;
        if (sdf_sign_bit_positive(f0) == sdf_sign_bit_positive(f1)) {
            continue;
        }

        let denom = f1 - f0;
        var t = 0.5;
        if (abs(denom) > 1e-20) {
            t = clamp(-f0 / denom, eps_t, t_max);
        }
        let wa = gridPosToWorldPos(ga);
        let wb = gridPosToWorldPos(gb);
        let pw = mix3f(wa, wb, t);
        let sdf_m = sceneSDF_mid(pw);
        let nn = sdf_m.n;
        qef.ATA[0] = qef.ATA[0] + nn * nn.x;
        qef.ATA[1] = qef.ATA[1] + nn * nn.y;
        qef.ATA[2] = qef.ATA[2] + nn * nn.z;
        let d_plane = dot(nn, pw);
        qef.ATb = qef.ATb + nn * d_plane;
        qef.massPoint = qef.massPoint + pw;
        qef.numPoints = qef.numPoints + 1u;
    }

    let v_unclamped = solveQEF(qef);
    let pos = clamp(v_unclamped, clamp_min, clamp_max);
    let f_shifted = sceneSDF_fast(pos).d - uniforms.isoValue;
    set_dual_cube(cell_idx, DualVertex(pos, f_shifted));
}

fn emit_pass6_x_edge(
    ex: u32,
    ey: u32,
    ez: u32,
    dx: u32,
    dy: u32,
    dz: u32,
    nx: u32,
    ny: u32,
    nz: u32,
    n_xy: u32,
    n_yz: u32,
) {
    let p0 = vec3u(ex, ey, ez);
    let p1 = vec3u(ex + 1u, ey, ez);
    let i0 = gridPosToIndex(p0);
    let i1 = gridPosToIndex(p1);
    let p0d = dual_corner(i0);
    let p1d = dual_corner(i1);
    let edge_i = ex + ey * (dx - 1u) + ez * (dx - 1u) * dy;
    let edge = dual_edge(edge_i);

    // No early-out on (p0, p1, edge_dual) signs alone: each tet's contour also depends on
    // the face_dual and cube_dual signs, e.g. (+, +, +, −) when the surface dips into a
    // cube interior without flipping its corners (small features, inactive cubes, etc.).
    // emit_mt_tetra short-circuits empty MT cases internally.

    // X-edge at (ex, ey, ez) → (ex+1, ey, ez) is shared by 4 cubes:
    //   A=(ex, ey-1, ez-1)  B=(ex, ey, ez-1)  C=(ex, ey-1, ez)  D=(ex, ey, ez)
    // Four edge-incident face-pairs:
    //   PD: B↔D  z-vary, y=ey      → xy face at (ex, ey, ez)
    //   PC: A↔C  z-vary, y=ey-1    → xy face at (ex, ey-1, ez)
    //   PB: C↔D  y-vary, z=ez      → xz face at (ex, ey, ez)
    //   PA: A↔B  y-vary, z=ez-1    → xz face at (ex, ey, ez-1)
    if (ex < dx - 1u && ey < dy - 1u && ez >= 1u) {
        let c_lo = vec3u(ex, ey, ez - 1u);
        let c_hi = vec3u(ex, ey, ez);
        if (cell_valid(c_lo, nx, ny, nz) && cell_valid(c_hi, nx, ny, nz)) {
            emit_four_tets_face_pair(
                p0d, p1d, edge,
                face_xy_dual_at(ex, ey, ez, dx, dy),
                dual_cube(cell_linear(c_lo, nx, ny)),
                dual_cube(cell_linear(c_hi, nx, ny)),
            );
        }
    }
    if (ex < dx - 1u && ey >= 1u && ez >= 1u) {
        let c_lo = vec3u(ex, ey - 1u, ez - 1u);
        let c_hi = vec3u(ex, ey - 1u, ez);
        if (cell_valid(c_lo, nx, ny, nz) && cell_valid(c_hi, nx, ny, nz)) {
            emit_four_tets_face_pair(
                p0d, p1d, edge,
                face_xy_dual_at(ex, ey - 1u, ez, dx, dy),
                dual_cube(cell_linear(c_lo, nx, ny)),
                dual_cube(cell_linear(c_hi, nx, ny)),
            );
        }
    }
    if (ex < dx - 1u && ey >= 1u && ey < dy - 1u && ez < dz - 1u) {
        let c_lo = vec3u(ex, ey - 1u, ez);
        let c_hi = vec3u(ex, ey, ez);
        if (cell_valid(c_lo, nx, ny, nz) && cell_valid(c_hi, nx, ny, nz)) {
            emit_four_tets_face_pair(
                p0d, p1d, edge,
                face_xz_dual_at(ex, ey, ez, dx, dy, n_xy, n_yz),
                dual_cube(cell_linear(c_lo, nx, ny)),
                dual_cube(cell_linear(c_hi, nx, ny)),
            );
        }
    }
    if (ex < dx - 1u && ey >= 1u && ey < dy - 1u && ez >= 1u) {
        let c_lo = vec3u(ex, ey - 1u, ez - 1u);
        let c_hi = vec3u(ex, ey, ez - 1u);
        if (cell_valid(c_lo, nx, ny, nz) && cell_valid(c_hi, nx, ny, nz)) {
            emit_four_tets_face_pair(
                p0d, p1d, edge,
                face_xz_dual_at(ex, ey, ez - 1u, dx, dy, n_xy, n_yz),
                dual_cube(cell_linear(c_lo, nx, ny)),
                dual_cube(cell_linear(c_hi, nx, ny)),
            );
        }
    }
}

fn emit_pass6_y_edge(
    ex: u32,
    ey: u32,
    ez: u32,
    dx: u32,
    dy: u32,
    dz: u32,
    nx: u32,
    ny: u32,
    nz: u32,
    n_x: u32,
    n_xy: u32,
    n_yz: u32,
) {
    let p0 = vec3u(ex, ey, ez);
    let p1 = vec3u(ex, ey + 1u, ez);
    let i0 = gridPosToIndex(p0);
    let i1 = gridPosToIndex(p1);
    let p0d = dual_corner(i0);
    let p1d = dual_corner(i1);
    let edge_i = n_x + ex + ey * dx + ez * dx * (dy - 1u);
    let edge = dual_edge(edge_i);

    // See note in emit_pass6_x_edge: the (p0, p1, edge_dual) sign trio is not sufficient
    // to skip — face/cube duals can be opposite-sign and produce real contour triangles.

    // Y-edge at (ex, ey, ez) → (ex, ey+1, ez) is shared by 4 cubes:
    //   A=(ex-1, ey, ez-1)  B=(ex, ey, ez-1)  C=(ex-1, ey, ez)  D=(ex, ey, ez)
    // Four edge-incident face-pairs:
    //   PD: C↔D  x-vary, z=ez      → yz face at (ex, ey, ez)
    //   PA: A↔B  x-vary, z=ez-1    → yz face at (ex, ey, ez-1)
    //   PB: B↔D  z-vary, x=ex      → xy face at (ex, ey, ez)
    //   PC: A↔C  z-vary, x=ex-1    → xy face at (ex-1, ey, ez)
    if (ex >= 1u && ex < dx - 1u && ey < dy - 1u && ez < dz - 1u) {
        let c_lo = vec3u(ex - 1u, ey, ez);
        let c_hi = vec3u(ex, ey, ez);
        if (cell_valid(c_lo, nx, ny, nz) && cell_valid(c_hi, nx, ny, nz)) {
            emit_four_tets_face_pair(
                p0d, p1d, edge,
                face_yz_dual_at(ex, ey, ez, dx, dy, n_xy),
                dual_cube(cell_linear(c_lo, nx, ny)),
                dual_cube(cell_linear(c_hi, nx, ny)),
            );
        }
    }
    if (ex >= 1u && ex < dx - 1u && ey < dy - 1u && ez >= 1u) {
        let c_lo = vec3u(ex - 1u, ey, ez - 1u);
        let c_hi = vec3u(ex, ey, ez - 1u);
        if (cell_valid(c_lo, nx, ny, nz) && cell_valid(c_hi, nx, ny, nz)) {
            emit_four_tets_face_pair(
                p0d, p1d, edge,
                face_yz_dual_at(ex, ey, ez - 1u, dx, dy, n_xy),
                dual_cube(cell_linear(c_lo, nx, ny)),
                dual_cube(cell_linear(c_hi, nx, ny)),
            );
        }
    }
    if (ex < dx - 1u && ey < dy - 1u && ez >= 1u && ez < dz - 1u) {
        let c_lo = vec3u(ex, ey, ez - 1u);
        let c_hi = vec3u(ex, ey, ez);
        if (cell_valid(c_lo, nx, ny, nz) && cell_valid(c_hi, nx, ny, nz)) {
            emit_four_tets_face_pair(
                p0d, p1d, edge,
                face_xy_dual_at(ex, ey, ez, dx, dy),
                dual_cube(cell_linear(c_lo, nx, ny)),
                dual_cube(cell_linear(c_hi, nx, ny)),
            );
        }
    }
    if (ex >= 1u && ey < dy - 1u && ez >= 1u && ez < dz - 1u) {
        let c_lo = vec3u(ex - 1u, ey, ez - 1u);
        let c_hi = vec3u(ex - 1u, ey, ez);
        if (cell_valid(c_lo, nx, ny, nz) && cell_valid(c_hi, nx, ny, nz)) {
            emit_four_tets_face_pair(
                p0d, p1d, edge,
                face_xy_dual_at(ex - 1u, ey, ez, dx, dy),
                dual_cube(cell_linear(c_lo, nx, ny)),
                dual_cube(cell_linear(c_hi, nx, ny)),
            );
        }
    }
}

fn emit_pass6_z_edge(
    ex: u32,
    ey: u32,
    ez: u32,
    dx: u32,
    dy: u32,
    dz: u32,
    nx: u32,
    ny: u32,
    nz: u32,
    n_x: u32,
    n_y: u32,
    n_xy: u32,
    n_yz: u32,
) {
    let p0 = vec3u(ex, ey, ez);
    let p1 = vec3u(ex, ey, ez + 1u);
    let i0 = gridPosToIndex(p0);
    let i1 = gridPosToIndex(p1);
    let p0d = dual_corner(i0);
    let p1d = dual_corner(i1);
    let edge_i = n_x + n_y + ex + ey * dx + ez * dx * dy;
    let edge = dual_edge(edge_i);

    // See note in emit_pass6_x_edge: the (p0, p1, edge_dual) sign trio is not sufficient
    // to skip — face/cube duals can be opposite-sign and produce real contour triangles.

    // Z-edge at (ex, ey, ez) → (ex, ey, ez+1) is shared by 4 cubes:
    //   A=(ex-1, ey-1, ez)  B=(ex, ey-1, ez)  C=(ex-1, ey, ez)  D=(ex, ey, ez)
    // Four edge-incident face-pairs:
    //   PD: B↔D  y-vary, x=ex      → xz face at (ex, ey, ez)
    //   PA: A↔C  y-vary, x=ex-1    → xz face at (ex-1, ey, ez)
    //   PB: C↔D  x-vary, y=ey      → yz face at (ex, ey, ez)
    //   PC: A↔B  x-vary, y=ey-1    → yz face at (ex, ey-1, ez)
    if (ex < dx - 1u && ey >= 1u && ey < dy - 1u && ez < dz - 1u) {
        let c_lo = vec3u(ex, ey - 1u, ez);
        let c_hi = vec3u(ex, ey, ez);
        if (cell_valid(c_lo, nx, ny, nz) && cell_valid(c_hi, nx, ny, nz)) {
            emit_four_tets_face_pair(
                p0d, p1d, edge,
                face_xz_dual_at(ex, ey, ez, dx, dy, n_xy, n_yz),
                dual_cube(cell_linear(c_lo, nx, ny)),
                dual_cube(cell_linear(c_hi, nx, ny)),
            );
        }
    }
    if (ex >= 1u && ey >= 1u && ey < dy - 1u && ez < dz - 1u) {
        let c_lo = vec3u(ex - 1u, ey - 1u, ez);
        let c_hi = vec3u(ex - 1u, ey, ez);
        if (cell_valid(c_lo, nx, ny, nz) && cell_valid(c_hi, nx, ny, nz)) {
            emit_four_tets_face_pair(
                p0d, p1d, edge,
                face_xz_dual_at(ex - 1u, ey, ez, dx, dy, n_xy, n_yz),
                dual_cube(cell_linear(c_lo, nx, ny)),
                dual_cube(cell_linear(c_hi, nx, ny)),
            );
        }
    }
    if (ex >= 1u && ex < dx - 1u && ey < dy - 1u && ez < dz - 1u) {
        let c_lo = vec3u(ex - 1u, ey, ez);
        let c_hi = vec3u(ex, ey, ez);
        if (cell_valid(c_lo, nx, ny, nz) && cell_valid(c_hi, nx, ny, nz)) {
            emit_four_tets_face_pair(
                p0d, p1d, edge,
                face_yz_dual_at(ex, ey, ez, dx, dy, n_xy),
                dual_cube(cell_linear(c_lo, nx, ny)),
                dual_cube(cell_linear(c_hi, nx, ny)),
            );
        }
    }
    if (ex >= 1u && ex < dx - 1u && ey >= 1u && ez < dz - 1u) {
        let c_lo = vec3u(ex - 1u, ey - 1u, ez);
        let c_hi = vec3u(ex, ey - 1u, ez);
        if (cell_valid(c_lo, nx, ny, nz) && cell_valid(c_hi, nx, ny, nz)) {
            emit_four_tets_face_pair(
                p0d, p1d, edge,
                face_yz_dual_at(ex, ey - 1u, ez, dx, dy, n_xy),
                dual_cube(cell_linear(c_lo, nx, ny)),
                dual_cube(cell_linear(c_hi, nx, ny)),
            );
        }
    }
}

@compute @workgroup_size(64, 1, 1)
fn emitTetMeshTriangles_Pass6(
    @builtin(global_invocation_id) globalId: vec3u,
    @builtin(num_workgroups) numWg: vec3u,
) {
    if (isCancelled()) {
        return;
    }
    let dx = uniforms.gridDimensions.x;
    let dy = uniforms.gridDimensions.y;
    let dz = uniforms.gridDimensions.z;
    if (dx < 2u || dy < 2u || dz < 2u) {
        return;
    }

    let n_x = edge_count_x(dx, dy, dz);
    let n_y = edge_count_y(dx, dy, dz);
    let n_z = edge_count_z(dx, dy, dz);
    let total_edges = n_x + n_y + n_z;

    let edge_idx = globalId.x + globalId.y * (numWg.x * 64u);
    if (edge_idx >= total_edges) {
        return;
    }

    let nx = dx - 1u;
    let ny = dy - 1u;
    let nz = dz - 1u;
    let n_xy = face_count_xy(dx, dy, dz);
    let n_yz = face_count_yz(dx, dy, dz);

    if (edge_idx < n_x) {
        let ex = edge_idx % (dx - 1u);
        let ey = (edge_idx / (dx - 1u)) % dy;
        let ez = edge_idx / ((dx - 1u) * dy);
        emit_pass6_x_edge(ex, ey, ez, dx, dy, dz, nx, ny, nz, n_xy, n_yz);
    } else if (edge_idx < n_x + n_y) {
        let j = edge_idx - n_x;
        let ex = j % dx;
        let ey = (j / dx) % (dy - 1u);
        let ez = j / (dx * (dy - 1u));
        emit_pass6_y_edge(ex, ey, ez, dx, dy, dz, nx, ny, nz, n_x, n_xy, n_yz);
    } else {
        let j = edge_idx - n_x - n_y;
        let ex = j % dx;
        let ey = (j / dx) % dy;
        let ez = j / (dx * dy);
        emit_pass6_z_edge(ex, ey, ez, dx, dy, dz, nx, ny, nz, n_x, n_y, n_xy, n_yz);
    }
}

/// Pass 7: snap welded mesh vertices onto the iso surface (Newton along
/// analytic gradient) and overwrite their normals with the analytical surface
/// normal from `sceneSDF_mid`. One thread per welded vertex.
///
/// Triangle vertices come from MT linear interpolation between dual positions
/// — generally NOT exactly on the iso surface. With per-vertex face-averaged
/// normals over a sliver-rich tetrahedral mesh this reads as jagged shading
/// even when the geometry is manifold. Replacing both the position (Newton
/// snap) and the normal (analytic) makes smooth regions of the SDF render
/// smoothly without changing topology or triangle count.
/// Pass 7: overwrite each welded vertex's normal with the analytic SDF gradient at the
/// welded position. We deliberately do NOT move positions (a previous version ran a Newton
/// projection that could converge two near-coincident welded vertices to slightly different
/// points, re-fragmenting the mesh into per-triangle facets after welding had unified it).
@compute @workgroup_size(64, 1, 1)
fn projectAndNormalVertices_Pass7(
    @builtin(global_invocation_id) globalId: vec3u,
    @builtin(num_workgroups) numWg: vec3u,
) {
    if (isCancelled()) {
        return;
    }
    let i = globalId.x + globalId.y * (numWg.x * 64u);
    let n = arrayLength(&projectVertices);
    if (i >= n) {
        return;
    }

    let p = projectVertices[i].position;
    let r = sceneSDF_mid(p);
    var nrm = r.n;
    let nl = length(nrm);
    if (nl > 1e-20) {
        nrm = nrm / nl;
    } else {
        // Fall back to the welded average normal Pass 6 deposited; if that's
        // also degenerate (rare), use a neutral up-vector so we never render
        // an undefined normal.
        nrm = projectVertices[i].normal;
        let pl = length(nrm);
        if (pl > 1e-20) {
            nrm = nrm / pl;
        } else {
            nrm = vec3f(0.0, 1.0, 0.0);
        }
    }

    projectVertices[i].normal = nrm;
}
