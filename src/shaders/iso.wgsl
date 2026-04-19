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
    // Phase 5B sparse layout. `allDuals` is allocated to `sparse.totalDualSlots` (one slot
    // per element of the dilated active-cube set's union of corners/edges/faces/cubes).
    // Each pass dispatches per its category's slot count and reads the linear grid index
    // from `dualCompactList[base + threadId]`. Pass 6 looks up duals by grid index via
    // the open-addressed `dualHashTable` (key = (cellType<<28) | linearIdx).
    sparseBases0: vec4u,   // x=cornerBase  y=edgeXBase  z=edgeYBase  w=edgeZBase
    sparseBases1: vec4u,   // x=faceXYBase  y=faceYZBase z=faceXZBase w=cubeBase
    sparseCounts0: vec4u,  // x=cornerCount y=edgeXCount z=edgeYCount w=edgeZCount
    sparseCounts1: vec4u,  // x=faceXYCount y=faceYZCount z=faceXZCount w=cubeCount
    sparseHash: vec4u,     // x=hashMask    y=hashEntries z=reserved   w=reserved
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

// Sparse `allDuals` (Phase 5B): one slot per (corner | edgeX/Y/Z | faceXY/YZ/XZ | cube)
// in the dilated active-cube set. Layout: [corners | edgeX | edgeY | edgeZ |
// faceXY | faceYZ | faceXZ | cubes]. Bases / counts in `uniforms.sparseBases{0,1}` and
// `sparseCounts{0,1}`. Total size = sum of the 8 counts.
@group(0) @binding(2) var<storage, read_write> allDuals: array<DualVertex>;

// Sparse hash table (Phase 5B): open-addressed (key, slot) pairs for grid-indexed dual
// lookups in Pass 6. Power-of-two entries; key = (cellType<<28)|linearIdx with
// 0xffffffffu marking empty. Knuth multiplicative hash + linear probe.
@group(0) @binding(6) var<storage, read> dualHashTable: array<vec2u>;

// Sparse compact list (Phase 5B): slot → linear grid index for each element of the
// dilated set, concatenated by category in the same order as the bases. Drives the
// per-slot dispatch in passes 2/3/4/5/6.
@group(0) @binding(8) var<storage, read> dualCompactList: array<u32>;

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

// ---------- Sparse hash lookups (Phase 5B) ----------
// Key layout: high 4 bits = cell type tag, low 28 bits = linear grid index per category.
const CELL_TYPE_CORNER:  u32 = 0u;
const CELL_TYPE_EDGE_X:  u32 = 1u;
const CELL_TYPE_EDGE_Y:  u32 = 2u;
const CELL_TYPE_EDGE_Z:  u32 = 3u;
const CELL_TYPE_FACE_XY: u32 = 4u;
const CELL_TYPE_FACE_YZ: u32 = 5u;
const CELL_TYPE_FACE_XZ: u32 = 6u;
const CELL_TYPE_CUBE:    u32 = 7u;
const SPARSE_HASH_EMPTY: u32 = 0xffffffffu;
const SPARSE_HASH_KNUTH: u32 = 2654435761u;

fn make_sparse_key(cell_type: u32, linear_idx: u32) -> u32 {
    return (cell_type << 28u) | (linear_idx & 0x0fffffffu);
}

/// Hash-table lookup for a (cellType, linearIdx) pair. Returns the absolute slot
/// in `allDuals`, or `SPARSE_HASH_EMPTY` if not present in the dilated set.
fn lookup_dual_slot(key: u32) -> u32 {
    let mask = uniforms.sparseHash.x;
    var slot = (key * SPARSE_HASH_KNUTH) & mask;
    for (var probe = 0u; probe < 256u; probe = probe + 1u) {
        let entry = dualHashTable[slot];
        if (entry.x == key) { return entry.y; }
        if (entry.x == SPARSE_HASH_EMPTY) { return SPARSE_HASH_EMPTY; }
        slot = (slot + 1u) & mask;
    }
    return SPARSE_HASH_EMPTY;
}

/// Read a DualVertex by (cellType, linearIdx). Returns a synthetic zero-valued vertex
/// when the slot is missing from the dilated set; callers should generally avoid this
/// path because Pass 6 only dispatches over edges whose neighbors are guaranteed in the
/// set (active-cube dilation), but we still want a defined behavior.
fn read_dual(cell_type: u32, linear_idx: u32) -> DualVertex {
    let slot = lookup_dual_slot(make_sparse_key(cell_type, linear_idx));
    if (slot == SPARSE_HASH_EMPTY) {
        return DualVertex(vec3f(0.0), 0.0);
    }
    return allDuals[slot];
}

fn dual_corner(i: u32) -> DualVertex { return read_dual(CELL_TYPE_CORNER,  i); }
fn dual_edge_x(i: u32) -> DualVertex { return read_dual(CELL_TYPE_EDGE_X,  i); }
fn dual_edge_y(i: u32) -> DualVertex { return read_dual(CELL_TYPE_EDGE_Y,  i); }
fn dual_edge_z(i: u32) -> DualVertex { return read_dual(CELL_TYPE_EDGE_Z,  i); }
fn dual_face_xy(i: u32) -> DualVertex { return read_dual(CELL_TYPE_FACE_XY, i); }
fn dual_face_yz(i: u32) -> DualVertex { return read_dual(CELL_TYPE_FACE_YZ, i); }
fn dual_face_xz(i: u32) -> DualVertex { return read_dual(CELL_TYPE_FACE_XZ, i); }
fn dual_cube(i: u32)   -> DualVertex { return read_dual(CELL_TYPE_CUBE,    i); }

/// Direct allDuals write at an absolute slot (used by passes 2/3/4/5 which receive their
/// slot via dispatch index, so no hash lookup is needed for writes).
fn write_dual_slot(absolute_slot: u32, dv: DualVertex) {
    allDuals[absolute_slot] = dv;
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

// ============================== 4D QEF (Phase 4 — sharp-feature recovery) ==============================
//
// Manson & Schaefer Eq. (1) minimizes Σᵢ (n̄ᵢ · x̄ − n̄ᵢ · p̄ᵢ)² where
//   n̄ᵢ = ⟨∇F(pᵢ), −1⟩ ∈ R⁴ ,   p̄ᵢ = ⟨pᵢ, F(pᵢ)⟩ ∈ R⁴ ,   x̄ = ⟨x, F⟩
// Solution: ATA·x̄ = ATb, where ATA ∈ R⁴ˣ⁴ symmetric and ATb ∈ R⁴.
//
// Block structure of ATA from n̄ = ⟨g, −1⟩:
//   top-left 3×3 = Σ g·gᵀ            (the 3D ATA we already accumulate)
//   right column = Σ g · (−1) = −Σ g  (negated gradient sum)
//   bottom-right = Σ (−1)² = N        (sample count)
// Block of ATb (n̄ᵢ · p̄ᵢ = g · p − F):
//   top  3 = Σ g · (g·p − F)
//   bottom = Σ (−1) · (g·p − F) = Σ (F − g·p)
//
// We discard the QEF-predicted F* and re-evaluate F at the (clamped) spatial solution
// (paper recommendation: avoids the dimpling artifact for high-curvature regions).
struct QEF4Data {
    // Stored as two halves to avoid the 4×4 packing surprises in WGSL storage layouts.
    ATA3: mat3x3f,        // top-left 3×3 (Σ g·gᵀ)
    g_col: vec3f,         // right column (above the bottom-right scalar) = −Σ g
    n_count: f32,         // bottom-right diagonal = number of samples (= numPoints)
    ATb3: vec3f,          // top 3 of ATb = Σ g · (g·p − F)
    ATb4: f32,            // bottom of ATb = Σ (F − g·p)
    massPoint: vec3f,     // average of sample positions (fallback target for ill-conditioned QEF)
    numPoints: u32,
}

fn qef4_zero() -> QEF4Data {
    return QEF4Data(mat3x3f(), vec3f(0.0), 0.0, vec3f(0.0), 0.0, vec3f(0.0), 0u);
}

/// Accumulate one tangent-hyperplane sample (p, ∇F(p), F(p)) into the 4D QEF.
/// Caller is responsible for projecting the gradient onto the cell's subspace
/// (e.g. zero out off-axis components for face/edge cells) before calling this.
fn qef4_add(qef: ptr<function, QEF4Data>, p: vec3f, g: vec3f, fval: f32) {
    let dp = dot(g, p) - fval;       // = g · p − F  (the scalar appearing in ATb rows)
    (*qef).ATA3[0] = (*qef).ATA3[0] + g * g.x;
    (*qef).ATA3[1] = (*qef).ATA3[1] + g * g.y;
    (*qef).ATA3[2] = (*qef).ATA3[2] + g * g.z;
    (*qef).g_col = (*qef).g_col - g;     // accumulating −Σ g
    (*qef).n_count = (*qef).n_count + 1.0;
    (*qef).ATb3 = (*qef).ATb3 + g * dp;
    (*qef).ATb4 = (*qef).ATb4 - dp;      // = Σ (F − g·p)
    (*qef).massPoint = (*qef).massPoint + p;
    (*qef).numPoints = (*qef).numPoints + 1u;
}

/// Symmetric 4×4 Cholesky solver. Same recipe as `solveCholesky` (3×3) extended one
/// row/column. Returns vec4f(0) on failure (caller should fall back to mass point).
/// A is laid out as four columns (a0, a1, a2, a3); we read only the lower triangle.
fn solveCholesky4(a0: vec4f, a1: vec4f, a2: vec4f, a3: vec4f, b: vec4f) -> vec4f {
    var L00 = sqrt(max(a0.x, 1e-9));
    if (L00 == 0.0) { return vec4f(0.0); }
    let L10 = a0.y / L00;
    let L20 = a0.z / L00;
    let L30 = a0.w / L00;

    var L11 = sqrt(max(a1.y - L10 * L10, 1e-9));
    if (L11 == 0.0) { return vec4f(0.0); }
    let L21 = (a1.z - L20 * L10) / L11;
    let L31 = (a1.w - L30 * L10) / L11;

    var L22 = sqrt(max(a2.z - L20 * L20 - L21 * L21, 1e-9));
    if (L22 == 0.0) { return vec4f(0.0); }
    let L32 = (a2.w - L30 * L20 - L31 * L21) / L22;

    var L33 = sqrt(max(a3.w - L30 * L30 - L31 * L31 - L32 * L32, 1e-9));
    if (L33 == 0.0) { return vec4f(0.0); }

    // Forward substitution: L · y = b
    var y0 = b.x / L00;
    var y1 = (b.y - L10 * y0) / L11;
    var y2 = (b.z - L20 * y0 - L21 * y1) / L22;
    var y3 = (b.w - L30 * y0 - L31 * y1 - L32 * y2) / L33;

    // Back substitution: Lᵀ · x = y
    var x3 = y3 / L33;
    var x2 = (y2 - L32 * x3) / L22;
    var x1 = (y1 - L21 * x2 - L31 * x3) / L11;
    var x0 = (y0 - L10 * x1 - L20 * x2 - L30 * x3) / L00;
    return vec4f(x0, x1, x2, x3);
}

/// Solve the 4D QEF and return ⟨x, F*⟩. The spatial part should be box-clamped to the
/// containing cell by the caller; the F* part is typically discarded in favor of
/// re-evaluating sceneSDF at the clamped position (avoids the dimpling artifact).
/// Returns mass-point + 0 fval when the system is ill-conditioned or under-determined.
fn solveQEF4(qef: QEF4Data) -> vec4f {
    if (qef.numPoints == 0u) {
        return vec4f(0.0);
    }
    let mass = qef.massPoint / f32(qef.numPoints);
    if (qef.numPoints < 4u) {
        // Under-determined: not enough hyperplane samples to pin all 4 dimensions.
        // Returning the mass point is the standard fallback (matches paper's behavior
        // for cells with too few sign-change edges to constrain a sharp feature).
        return vec4f(mass, 0.0);
    }

    // Build the 4×4 ATA columns from the stored block decomposition.
    let reg = max(uniforms.mdcF2.w, uniforms.voxelSize * uniforms.mdcF2.z);
    let A0 = vec4f(qef.ATA3[0].x + reg, qef.ATA3[0].y, qef.ATA3[0].z, qef.g_col.x);
    let A1 = vec4f(qef.ATA3[1].x, qef.ATA3[1].y + reg, qef.ATA3[1].z, qef.g_col.y);
    let A2 = vec4f(qef.ATA3[2].x, qef.ATA3[2].y, qef.ATA3[2].z + reg, qef.g_col.z);
    let A3 = vec4f(qef.g_col.x,   qef.g_col.y,   qef.g_col.z,   qef.n_count + reg);

    // Same condition-number heuristic as solveQEF: bail to mass point if the matrix
    // is too poorly scaled to trust. We approximate with the 3D ATA condition number;
    // the 4th row/column adds the gradient sum which generally improves conditioning.
    var ATA3_reg = qef.ATA3;
    ATA3_reg[0][0] += reg;
    ATA3_reg[1][1] += reg;
    ATA3_reg[2][2] += reg;
    if (estimateConditionNumber(ATA3_reg) > uniforms.mdcF3.x) {
        return vec4f(mass, 0.0);
    }

    // Bias the system toward the mass point (regularization on x: (x − mass)ᵀ·reg·(x − mass)).
    // ATb_reg = ATb + reg · ⟨mass, 0⟩  (no F bias — the QEF is unbiased in F).
    let b_reg = vec4f(qef.ATb3 + mass * reg, qef.ATb4);

    let solution = solveCholesky4(A0, A1, A2, A3, b_reg);
    let bad = isNan(solution.x) || isNan(solution.y) || isNan(solution.z) || isNan(solution.w)
           || isInf(solution.x) || isInf(solution.y) || isInf(solution.z) || isInf(solution.w);
    if (bad) {
        return vec4f(mass, 0.0);
    }
    return solution;
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
        // Phase 3 collapses many MT crossings onto improved dual positions (because the
        // dual's fval is now exactly 0, so iso-crossings on tet edges incident to that
        // dual interpolate to the dual position). The resulting triangles have 2 or 3
        // coincident vertices — they render as zero-area but inflate post-process cost
        // (welding 30M+ vertices per export). Skip emission GPU-side instead.
        let degen_eps = uniforms.voxelSize * 1e-4;
        let degen_eps2 = degen_eps * degen_eps;
        if (length(tp1 - tp0) * length(tp1 - tp0) < degen_eps2) { continue; }
        if (length(tp2 - tp0) * length(tp2 - tp0) < degen_eps2) { continue; }
        if (length(tp2 - tp1) * length(tp2 - tp1) < degen_eps2) { continue; }

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
    return dual_face_xy(face_idx_xy(fx, fy, fz, dx, dy));
}

fn face_yz_dual_at(ix: u32, iy: u32, iz: u32, dx: u32, dy: u32) -> DualVertex {
    return dual_face_yz(face_idx_yz(ix, iy, iz, dx, dy));
}

fn face_xz_dual_at(ix: u32, iy: u32, iz: u32, dx: u32, dy: u32) -> DualVertex {
    return dual_face_xz(face_idx_xz(ix, iy, iz, dx, dy));
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

/// One thread per sparse corner slot. Reads its grid index from
/// `dualCompactList[cornerBase + slot]`, evaluates F at the corner world position, and
/// writes the DualVertex to its dedicated slot in `allDuals` (no hash lookup needed for
/// writes — writers know their absolute slot from dispatch index + base).
@compute @workgroup_size(64, 1, 1)
fn placeCornerSamples_Pass2(
    @builtin(global_invocation_id) global_id: vec3u,
    @builtin(num_workgroups) numWg: vec3u,
) {
    if (isCancelled()) {
        return;
    }
    let local_slot = global_id.x + global_id.y * (numWg.x * 64u);
    let count = uniforms.sparseCounts0.x;
    if (local_slot >= count) {
        return;
    }
    let absolute_slot = uniforms.sparseBases0.x + local_slot;
    let grid_idx = dualCompactList[absolute_slot];

    let grid_pos = gridIndexTo3D(grid_idx);
    let world_pos = gridPosToWorldPos(grid_pos);
    let f_shifted = sceneSDF_fast(world_pos).d - uniforms.isoValue;
    write_dual_slot(absolute_slot, DualVertex(world_pos, f_shifted));
}

/// One thread per sparse edge slot (X, Y, Z categories combined). Branches on slot range
/// to determine axis, then decodes the linear edge index from `dualCompactList[base + i]`.
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

    let nx_count = uniforms.sparseCounts0.y;
    let ny_count = uniforms.sparseCounts0.z;
    let nz_count = uniforms.sparseCounts0.w;
    let total = nx_count + ny_count + nz_count;
    let idx = globalId.x + globalId.y * (numWg.x * 64u);
    if (idx >= total) {
        return;
    }

    var p0: vec3u;
    var p1: vec3u;
    var absolute_slot: u32;

    if (idx < nx_count) {
        absolute_slot = uniforms.sparseBases0.y + idx;
        let grid_idx = dualCompactList[absolute_slot];
        // X-edge index: x + y*(dx-1) + z*(dx-1)*dy
        let x = grid_idx % (dx - 1u);
        let y = (grid_idx / (dx - 1u)) % dy;
        let z = grid_idx / ((dx - 1u) * dy);
        p0 = vec3u(x, y, z);
        p1 = vec3u(x + 1u, y, z);
    } else if (idx < nx_count + ny_count) {
        let j = idx - nx_count;
        absolute_slot = uniforms.sparseBases0.z + j;
        let grid_idx = dualCompactList[absolute_slot];
        // Y-edge index: x + y*dx + z*dx*(dy-1)
        let x = grid_idx % dx;
        let y = (grid_idx / dx) % (dy - 1u);
        let z = grid_idx / (dx * (dy - 1u));
        p0 = vec3u(x, y, z);
        p1 = vec3u(x, y + 1u, z);
    } else {
        let j = idx - nx_count - ny_count;
        absolute_slot = uniforms.sparseBases0.w + j;
        let grid_idx = dualCompactList[absolute_slot];
        // Z-edge index: x + y*dx + z*dx*dy
        let x = grid_idx % dx;
        let y = (grid_idx / dx) % dy;
        let z = grid_idx / (dx * dy);
        p0 = vec3u(x, y, z);
        p1 = vec3u(x, y, z + 1u);
    }

    let eps_t = max(uniforms.mdcF0.x, 1e-6);
    let t_max = 1.0 - eps_t;

    let i0 = gridPosToIndex(p0);
    let i1 = gridPosToIndex(p1);
    let d0 = dual_corner(i0).fval;
    let d1 = dual_corner(i1).fval;
    let w0 = gridPosToWorldPos(p0);
    let w1 = gridPosToWorldPos(p1);
    let edge_dir = normalize(w1 - w0);

    // Phase 4: 4D QEF on edge samples, with gradient projected onto the edge axis (the
    // 1-cell subspace). Sample the two endpoints (analytic gradients there constrain F
    // along the edge) plus the iso-crossing if one exists. With ≥4 samples the QEF can
    // resolve a sharp feature on the edge; with fewer it gracefully falls back to the
    // mass point (linear interpolation on the iso-crossing case).
    var qef4 = qef4_zero();

    let sdf0 = sceneSDF_mid(w0);
    let sdf1 = sceneSDF_mid(w1);
    let g0 = edge_dir * dot(sdf0.n, edge_dir);
    let g1 = edge_dir * dot(sdf1.n, edge_dir);
    qef4_add(&qef4, w0, g0, sdf0.d - uniforms.isoValue);
    qef4_add(&qef4, w1, g1, sdf1.d - uniforms.isoValue);

    let s0 = sdf_sign_bit_positive(d0);
    let s1 = sdf_sign_bit_positive(d1);
    if (s0 != s1) {
        let denom = d1 - d0;
        var t = 0.5;
        if (abs(denom) > 1e-20) {
            t = clamp(-d0 / denom, eps_t, t_max);
        }
        let pmid = mix3f(w0, w1, t);
        let sdfm = sceneSDF_mid(pmid);
        let gm = edge_dir * dot(sdfm.n, edge_dir);
        qef4_add(&qef4, pmid, gm, sdfm.d - uniforms.isoValue);
    } else {
        // Sample the midpoint to give the QEF enough samples for a sharp feature.
        let pmid = mix3f(w0, w1, 0.5);
        let sdfm = sceneSDF_mid(pmid);
        let gm = edge_dir * dot(sdfm.n, edge_dir);
        qef4_add(&qef4, pmid, gm, sdfm.d - uniforms.isoValue);
    }

    let solution = solveQEF4(qef4);
    // Project the QEF spatial solution onto the edge axis (numerical drift can pull it
    // slightly off the edge line; the 1-cell subspace is the line through w0 along edge_dir).
    let edge_len = length(w1 - w0);
    let along = clamp(dot(solution.xyz - w0, edge_dir), eps_t * edge_len, t_max * edge_len);
    let pos = w0 + edge_dir * along;
    let f_shifted = sceneSDF_fast(pos).d - uniforms.isoValue;
    write_dual_slot(absolute_slot, DualVertex(pos, f_shifted));
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

    let nxy_count = uniforms.sparseCounts1.x;
    let nyz_count = uniforms.sparseCounts1.y;
    let nxz_count = uniforms.sparseCounts1.z;
    let total = nxy_count + nyz_count + nxz_count;
    let idx = globalId.x + globalId.y * (numWg.x * 64u);
    if (idx >= total) {
        return;
    }

    var c00: vec3u;
    var c10: vec3u;
    var c01: vec3u;
    var c11: vec3u;
    var face_normal: vec3f;
    var axis: u32;
    var absolute_slot: u32;

    if (idx < nxy_count) {
        axis = 0u;
        absolute_slot = uniforms.sparseBases1.x + idx;
        let grid_idx = dualCompactList[absolute_slot];
        let fx = grid_idx % (dx - 1u);
        let fy = (grid_idx / (dx - 1u)) % (dy - 1u);
        let fz = grid_idx / ((dx - 1u) * (dy - 1u));
        c00 = vec3u(fx, fy, fz);
        c10 = vec3u(fx + 1u, fy, fz);
        c01 = vec3u(fx, fy + 1u, fz);
        c11 = vec3u(fx + 1u, fy + 1u, fz);
        face_normal = vec3f(0.0, 0.0, 1.0);
    } else if (idx < nxy_count + nyz_count) {
        axis = 1u;
        let j = idx - nxy_count;
        absolute_slot = uniforms.sparseBases1.y + j;
        let grid_idx = dualCompactList[absolute_slot];
        let ix = grid_idx % dx;
        let iy = (grid_idx / dx) % (dy - 1u);
        let iz = grid_idx / (dx * (dy - 1u));
        c00 = vec3u(ix, iy, iz);
        c10 = vec3u(ix, iy + 1u, iz);
        c01 = vec3u(ix, iy, iz + 1u);
        c11 = vec3u(ix, iy + 1u, iz + 1u);
        face_normal = vec3f(1.0, 0.0, 0.0);
    } else {
        axis = 2u;
        let j = idx - nxy_count - nyz_count;
        absolute_slot = uniforms.sparseBases1.z + j;
        let grid_idx = dualCompactList[absolute_slot];
        let ix = grid_idx % (dx - 1u);
        let iy = (grid_idx / (dx - 1u)) % dy;
        let iz = grid_idx / ((dx - 1u) * dy);
        c00 = vec3u(ix, iy, iz);
        c10 = vec3u(ix + 1u, iy, iz);
        c01 = vec3u(ix, iy, iz + 1u);
        c11 = vec3u(ix + 1u, iy, iz + 1u);
        face_normal = vec3f(0.0, 1.0, 0.0);
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

    let p_center = (w00 + w10 + w01 + w11) * 0.25;
    let s00 = sdf_sign_bit_positive(f00);
    let s10 = sdf_sign_bit_positive(f10);
    let s01 = sdf_sign_bit_positive(f01);
    let s11 = sdf_sign_bit_positive(f11);
    let face_has_sign_change = (s00 != s10) || (s01 != s11) || (s00 != s01) || (s10 != s11);

    var pos = p_center;

    if (face_has_sign_change) {
        // Phase 4: 4D QEF on iso-crossings of the 4 face edges (each contributes a tangent
        // hyperplane sample). Gradient is projected onto the face plane so the spatial
        // part stays inside the 2D face subspace; the F dimension is unconstrained.
        var qef4 = qef4_zero();

        // Helper inlined for clarity: add a sample if endpoints have opposite sign.
        // We re-evaluate the gradient at the iso-crossing and project onto face plane.
        let edges = array<vec4u, 4>(
            // (corner_a_idx, corner_b_idx, ...) where 0..3 = (00, 10, 11, 01) traversed CCW.
            // Edge endpoints encoded as indices into [w00, w10, w11, w01] / [f00, f10, f11, f01].
            vec4u(0u, 1u, 0u, 0u),
            vec4u(1u, 2u, 0u, 0u),
            vec4u(2u, 3u, 0u, 0u),
            vec4u(3u, 0u, 0u, 0u),
        );
        let corner_pos = array<vec3f, 4>(w00, w10, w11, w01);
        let corner_f   = array<f32, 4>(f00, f10, f11, f01);

        for (var e = 0u; e < 4u; e = e + 1u) {
            let ia = edges[e].x;
            let ib = edges[e].y;
            let fa = corner_f[ia];
            let fb = corner_f[ib];
            if (sdf_sign_bit_positive(fa) == sdf_sign_bit_positive(fb)) {
                continue;
            }
            let denom = fb - fa;
            var t = 0.5;
            if (abs(denom) > 1e-20) {
                t = clamp(-fa / denom, eps_uv, uv_max);
            }
            let p = mix3f(corner_pos[ia], corner_pos[ib], t);
            let sdf_m = sceneSDF_mid(p);
            // Project gradient onto the face plane: the F-derivative perpendicular to the
            // face is undefined for a 2-cell, so we drop that component (paper §3).
            let g_proj = sdf_m.n - face_normal * dot(sdf_m.n, face_normal);
            qef4_add(&qef4, p, g_proj, sdf_m.d - uniforms.isoValue);
        }

        // Solve and clamp spatial part to (1−ε)·face. Re-evaluate F at the clamped pos.
        let solution = solveQEF4(qef4);

        // Pin the off-face axis to the face plane (it can drift due to regularization
        // toward the mass point, which lies on the face but Cholesky float noise can
        // wander off by a few ULPs).
        var pos_solved = solution.xyz;
        if (axis == 0u) {
            pos_solved.z = w00.z;
        } else if (axis == 1u) {
            pos_solved.x = w00.x;
        } else {
            pos_solved.y = w00.y;
        }

        // (1−ε) box clamp inside the face's 2D AABB.
        let rel = pos_solved - w00;
        var u = 0.5;
        var v = 0.5;
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
    }

    let f_out = sceneSDF_fast(pos).d - uniforms.isoValue;
    write_dual_slot(absolute_slot, DualVertex(pos, f_out));
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
    let cube_count = uniforms.sparseCounts1.w;
    let local_slot = globalId.x + globalId.y * (numWg.x * 64u);
    if (local_slot >= cube_count) {
        return;
    }
    let absolute_slot = uniforms.sparseBases1.w + local_slot;
    let cell_idx = dualCompactList[absolute_slot];

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
        write_dual_slot(absolute_slot, DualVertex(c, f_shifted));
        return;
    }

    let edges_v = array<vec2u, 12>(
        vec2u(0u, 1u), vec2u(2u, 3u), vec2u(4u, 5u), vec2u(6u, 7u),
        vec2u(0u, 2u), vec2u(1u, 3u), vec2u(4u, 6u), vec2u(5u, 7u),
        vec2u(0u, 4u), vec2u(1u, 5u), vec2u(2u, 6u), vec2u(3u, 7u)
    );

    // Phase 4: 4D QEF on iso-crossings of the 12 cube edges.  Each crossing samples a
    // tangent hyperplane (p, ∇F(p), F(p)) — F at the crossing is ≈0 by definition but we
    // pass the actual sceneSDF_mid value to keep the linear system unbiased near the iso.
    var qef4 = qef4_zero();

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
        let f_at_p = sdf_m.d - uniforms.isoValue;
        qef4_add(&qef4, pw, sdf_m.n, f_at_p);
    }

    // Solve 4D, clamp spatial part to (1−ε)·cell, then re-evaluate F at the clamped
    // position (paper §3 fallback to avoid the dimpled-surface artifact in high-curvature
    // regions where the QEF-predicted F* is biased convex- or concave-ward).
    let solution = solveQEF4(qef4);
    let pos = clamp(solution.xyz, clamp_min, clamp_max);
    let f_shifted = sceneSDF_fast(pos).d - uniforms.isoValue;
    write_dual_slot(absolute_slot, DualVertex(pos, f_shifted));
}

// ============================== Phase 3: Triangulation improvement (paper §4.1) ==============================
//
// After dual placement (passes 2..5) converges, each m-cell dual sits inside its cell at
// the position that minimizes the QEF residual. Phase 3 moves those duals ONTO the iso
// surface (fval = 0 exactly) when a topology safety test passes. This collapses MT
// crossings on tet edges incident to the moved dual onto the dual position itself,
// producing degenerate triangles that we drop in CPU post-process.
//
// Order matters: cubes (depend on faces+edges+corners) → faces (depend on edges+corners)
// → edges (depend on corners). 0-cells (corners) never move. We currently implement
// edges + faces; cubes are deferred because the Union-Find topology test on 26 boundary
// duals is significantly more complex.
//
// Topology safety tests:
//   - Edge: endpoint corners have opposite sign           (always 1 sign-change pair)
//   - Face: 4-corner boundary ring has exactly 2 sign changes (single contour segment)
//   - Cube: Union-Find shows 1 connected sign-change component on boundary (deferred)
//
// When the test fails, the dual stays where Pass 3/4/5 left it.

/// Bisect along the line from `lo` (negative side) to `hi` (positive side) until
/// `sceneSDF_fast(p).d - iso ≈ 0`, with a fixed iteration cap. Returns the converged
/// position. Both endpoints must have opposite sign with respect to `isoValue`.
fn bisect_to_iso(lo: vec3f, hi: vec3f, lo_v: f32, hi_v: f32) -> vec3f {
    var a = lo;
    var b = hi;
    var fa = lo_v;
    var fb = hi_v;
    let conv = max(uniforms.mdcF1.z * uniforms.voxelSize, 1e-7 * uniforms.voxelSize);
    var mid = (a + b) * 0.5;
    for (var iter = 0u; iter < 16u; iter = iter + 1u) {
        mid = (a + b) * 0.5;
        let fm = sceneSDF_fast(mid).d - uniforms.isoValue;
        if (abs(fm) < conv) {
            return mid;
        }
        // Choose the half-interval that still brackets the iso surface.
        if ((fa < 0.0 && fm < 0.0) || (fa > 0.0 && fm > 0.0)) {
            a = mid;
            fa = fm;
        } else {
            b = mid;
            fb = fm;
        }
    }
    return mid;
}

/// Pass 8: edge dual improvement. If the two endpoint corners have opposite sign, bisect
/// the edge from corner-to-corner until F = 0 and write that position with fval = 0.
/// Topology test for edges is trivially the opposite-sign-endpoint check (paper §4.1).
@compute @workgroup_size(64, 1, 1)
fn improveEdgeDuals_Pass8(
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
    let nx_count = uniforms.sparseCounts0.y;
    let ny_count = uniforms.sparseCounts0.z;
    let nz_count = uniforms.sparseCounts0.w;
    let total = nx_count + ny_count + nz_count;
    let idx = globalId.x + globalId.y * (numWg.x * 64u);
    if (idx >= total) {
        return;
    }

    var p0: vec3u;
    var p1: vec3u;
    var absolute_slot: u32;

    if (idx < nx_count) {
        absolute_slot = uniforms.sparseBases0.y + idx;
        let grid_idx = dualCompactList[absolute_slot];
        let x = grid_idx % (dx - 1u);
        let y = (grid_idx / (dx - 1u)) % dy;
        let z = grid_idx / ((dx - 1u) * dy);
        p0 = vec3u(x, y, z);
        p1 = vec3u(x + 1u, y, z);
    } else if (idx < nx_count + ny_count) {
        let j = idx - nx_count;
        absolute_slot = uniforms.sparseBases0.z + j;
        let grid_idx = dualCompactList[absolute_slot];
        let x = grid_idx % dx;
        let y = (grid_idx / dx) % (dy - 1u);
        let z = grid_idx / (dx * (dy - 1u));
        p0 = vec3u(x, y, z);
        p1 = vec3u(x, y + 1u, z);
    } else {
        let j = idx - nx_count - ny_count;
        absolute_slot = uniforms.sparseBases0.w + j;
        let grid_idx = dualCompactList[absolute_slot];
        let x = grid_idx % dx;
        let y = (grid_idx / dx) % dy;
        let z = grid_idx / (dx * dy);
        p0 = vec3u(x, y, z);
        p1 = vec3u(x, y, z + 1u);
    }

    let i0 = gridPosToIndex(p0);
    let i1 = gridPosToIndex(p1);
    let d0 = dual_corner(i0).fval;
    let d1 = dual_corner(i1).fval;

    let s0 = sdf_sign_bit_positive(d0);
    let s1 = sdf_sign_bit_positive(d1);
    if (s0 == s1) {
        return;  // topology test fails; leave dual where Pass 3 placed it.
    }

    let w0 = gridPosToWorldPos(p0);
    let w1 = gridPosToWorldPos(p1);
    var lo = w0;
    var hi = w1;
    var fl = d0;
    var fh = d1;
    if (fl > 0.0) {
        lo = w1; hi = w0;
        fl = d1; fh = d0;
    }
    let pos = bisect_to_iso(lo, hi, fl, fh);
    write_dual_slot(absolute_slot, DualVertex(pos, 0.0));
}

/// Pass 9: face dual improvement. The 4-corner ring around an axis-aligned face must
/// have exactly 2 sign changes for the face's portion of the iso surface to be a
/// single contour segment (topological disk in 2D); only then can we collapse the face
/// dual onto the iso surface without changing topology. Bisects along the line between
/// the face's center and the opposite-sign corner with the smallest |fval|.
@compute @workgroup_size(64, 1, 1)
fn improveFaceDuals_Pass9(
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
    let nxy_count = uniforms.sparseCounts1.x;
    let nyz_count = uniforms.sparseCounts1.y;
    let nxz_count = uniforms.sparseCounts1.z;
    let total = nxy_count + nyz_count + nxz_count;
    let idx = globalId.x + globalId.y * (numWg.x * 64u);
    if (idx >= total) {
        return;
    }

    var c00: vec3u;
    var c10: vec3u;
    var c01: vec3u;
    var c11: vec3u;
    var absolute_slot: u32;

    if (idx < nxy_count) {
        absolute_slot = uniforms.sparseBases1.x + idx;
        let grid_idx = dualCompactList[absolute_slot];
        let fx = grid_idx % (dx - 1u);
        let fy = (grid_idx / (dx - 1u)) % (dy - 1u);
        let fz = grid_idx / ((dx - 1u) * (dy - 1u));
        c00 = vec3u(fx, fy, fz);
        c10 = vec3u(fx + 1u, fy, fz);
        c01 = vec3u(fx, fy + 1u, fz);
        c11 = vec3u(fx + 1u, fy + 1u, fz);
    } else if (idx < nxy_count + nyz_count) {
        let j = idx - nxy_count;
        absolute_slot = uniforms.sparseBases1.y + j;
        let grid_idx = dualCompactList[absolute_slot];
        let ix = grid_idx % dx;
        let iy = (grid_idx / dx) % (dy - 1u);
        let iz = grid_idx / (dx * (dy - 1u));
        c00 = vec3u(ix, iy, iz);
        c10 = vec3u(ix, iy + 1u, iz);
        c01 = vec3u(ix, iy, iz + 1u);
        c11 = vec3u(ix, iy + 1u, iz + 1u);
    } else {
        let j = idx - nxy_count - nyz_count;
        absolute_slot = uniforms.sparseBases1.z + j;
        let grid_idx = dualCompactList[absolute_slot];
        let ix = grid_idx % (dx - 1u);
        let iy = (grid_idx / (dx - 1u)) % dy;
        let iz = grid_idx / ((dx - 1u) * dy);
        c00 = vec3u(ix, iy, iz);
        c10 = vec3u(ix + 1u, iy, iz);
        c01 = vec3u(ix, iy, iz + 1u);
        c11 = vec3u(ix + 1u, iy, iz + 1u);
    }

    let f00 = dual_corner(gridPosToIndex(c00)).fval;
    let f10 = dual_corner(gridPosToIndex(c10)).fval;
    let f11 = dual_corner(gridPosToIndex(c11)).fval;
    let f01 = dual_corner(gridPosToIndex(c01)).fval;

    // 4-corner CCW ring: 00 → 10 → 11 → 01 → 00. Count sign changes between adjacent
    // pairs. The paper's topology test passes iff exactly 2 changes (single segment).
    var sign_changes = 0u;
    if (sdf_sign_bit_positive(f00) != sdf_sign_bit_positive(f10)) { sign_changes = sign_changes + 1u; }
    if (sdf_sign_bit_positive(f10) != sdf_sign_bit_positive(f11)) { sign_changes = sign_changes + 1u; }
    if (sdf_sign_bit_positive(f11) != sdf_sign_bit_positive(f01)) { sign_changes = sign_changes + 1u; }
    if (sdf_sign_bit_positive(f01) != sdf_sign_bit_positive(f00)) { sign_changes = sign_changes + 1u; }
    if (sign_changes != 2u) {
        return;  // topology test fails (0, 4 changes = no contour or saddle).
    }

    let face_dual = allDuals[absolute_slot];
    let face_pos = face_dual.pos;
    let face_f = face_dual.fval;
    let face_sign_pos = sdf_sign_bit_positive(face_f);

    // Pick the corner with opposite sign to face_dual and smallest |fval| (closest to iso).
    let w00 = gridPosToWorldPos(c00);
    let w10 = gridPosToWorldPos(c10);
    let w11 = gridPosToWorldPos(c11);
    let w01 = gridPosToWorldPos(c01);
    let positions = array<vec3f, 4>(w00, w10, w11, w01);
    let fvals = array<f32, 4>(f00, f10, f11, f01);

    var best_idx = 4u;
    var best_abs_f = 1e30f;
    for (var i = 0u; i < 4u; i = i + 1u) {
        if (sdf_sign_bit_positive(fvals[i]) == face_sign_pos) { continue; }
        let af = abs(fvals[i]);
        if (af < best_abs_f) {
            best_abs_f = af;
            best_idx = i;
        }
    }
    if (best_idx >= 4u) {
        return;  // no opposite-sign neighbor (shouldn't happen if test passed, but safe).
    }

    var lo = face_pos;
    var hi = positions[best_idx];
    var fl = face_f;
    var fh = fvals[best_idx];
    if (fl > 0.0) {
        let tp = lo; lo = hi; hi = tp;
        let tf = fl; fl = fh; fh = tf;
    }
    let pos = bisect_to_iso(lo, hi, fl, fh);
    write_dual_slot(absolute_slot, DualVertex(pos, 0.0));
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
) {
    let p0 = vec3u(ex, ey, ez);
    let p1 = vec3u(ex + 1u, ey, ez);
    let i0 = gridPosToIndex(p0);
    let i1 = gridPosToIndex(p1);
    let p0d = dual_corner(i0);
    let p1d = dual_corner(i1);
    let edge_i = ex + ey * (dx - 1u) + ez * (dx - 1u) * dy;
    let edge = dual_edge_x(edge_i);

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
                face_xz_dual_at(ex, ey, ez, dx, dy),
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
                face_xz_dual_at(ex, ey, ez - 1u, dx, dy),
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
) {
    let p0 = vec3u(ex, ey, ez);
    let p1 = vec3u(ex, ey + 1u, ez);
    let i0 = gridPosToIndex(p0);
    let i1 = gridPosToIndex(p1);
    let p0d = dual_corner(i0);
    let p1d = dual_corner(i1);
    let edge_i = ex + ey * dx + ez * dx * (dy - 1u);
    let edge = dual_edge_y(edge_i);

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
                face_yz_dual_at(ex, ey, ez, dx, dy),
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
                face_yz_dual_at(ex, ey, ez - 1u, dx, dy),
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
) {
    let p0 = vec3u(ex, ey, ez);
    let p1 = vec3u(ex, ey, ez + 1u);
    let i0 = gridPosToIndex(p0);
    let i1 = gridPosToIndex(p1);
    let p0d = dual_corner(i0);
    let p1d = dual_corner(i1);
    let edge_i = ex + ey * dx + ez * dx * dy;
    let edge = dual_edge_z(edge_i);

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
                face_xz_dual_at(ex, ey, ez, dx, dy),
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
                face_xz_dual_at(ex - 1u, ey, ez, dx, dy),
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
                face_yz_dual_at(ex, ey, ez, dx, dy),
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
                face_yz_dual_at(ex, ey - 1u, ez, dx, dy),
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

    // Sparse Pass 6: dispatch one thread per active edge in the sparse set
    // (concatenated X | Y | Z). Each thread reads its grid index from
    // `dualCompactList[edgeBase + slot]` and decodes (ex, ey, ez) for that axis.
    // Active-cube dilation guarantees the 4 incident cubes / 4 incident faces of any
    // active edge are all in the sparse set, so the per-axis emit_pass6 helpers will
    // hash-lookup valid duals for every neighbor.
    let nx_count = uniforms.sparseCounts0.y;
    let ny_count = uniforms.sparseCounts0.z;
    let nz_count = uniforms.sparseCounts0.w;
    let total_active_edges = nx_count + ny_count + nz_count;

    let slot = globalId.x + globalId.y * (numWg.x * 64u);
    if (slot >= total_active_edges) {
        return;
    }

    let nx = dx - 1u;
    let ny = dy - 1u;
    let nz = dz - 1u;

    if (slot < nx_count) {
        let grid_idx = dualCompactList[uniforms.sparseBases0.y + slot];
        let ex = grid_idx % (dx - 1u);
        let ey = (grid_idx / (dx - 1u)) % dy;
        let ez = grid_idx / ((dx - 1u) * dy);
        emit_pass6_x_edge(ex, ey, ez, dx, dy, dz, nx, ny, nz);
    } else if (slot < nx_count + ny_count) {
        let j = slot - nx_count;
        let grid_idx = dualCompactList[uniforms.sparseBases0.z + j];
        let ex = grid_idx % dx;
        let ey = (grid_idx / dx) % (dy - 1u);
        let ez = grid_idx / (dx * (dy - 1u));
        emit_pass6_y_edge(ex, ey, ez, dx, dy, dz, nx, ny, nz);
    } else {
        let j = slot - nx_count - ny_count;
        let grid_idx = dualCompactList[uniforms.sparseBases0.w + j];
        let ex = grid_idx % dx;
        let ey = (grid_idx / dx) % dy;
        let ez = grid_idx / (dx * dy);
        emit_pass6_z_edge(ex, ey, ez, dx, dy, dz, nx, ny, nz);
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
