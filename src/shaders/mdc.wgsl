//:) include "hg_sdf.wgsl"

// ============================== SHARED STRUCTS ==============================

struct SharedUniforms {
    gridDimensions: vec3u,
    isoValue: f32,
    // gridScale: vec3f, // Not used in the provided code, can be removed if not needed elsewhere
    gridOffset: vec3f,
    voxelSize: f32,
    // MDC tuning knobs (packed to preserve 16-byte alignment rules for uniforms)
    //
    // mdcF0: x=activeEpsScale, y=activeEpsMin, z=insideBiasScale, w=insideBiasMin
    // mdcF1: x=gradEpsScale,   y=gradEpsMin,   z=edgeProjTolScale, w=vertexProjTolScale
    // mdcF2: x=vertexProjMarginScale, y=vertexProjMaxStepScale, z=qefRegScale, w=qefRegMin
    // mdcF3: x=qefCondCutoff, y=orientationProbeScale, z=orientationProbeMin, w=reserved
    // mdcU0: x=edgeProjIters, y=vertexProjIters, z=activeCellCount (set after compaction), w=featureConstrainedPlacement
    mdcF0: vec4f,
    mdcF1: vec4f,
    mdcF2: vec4f,
    mdcF3: vec4f,
    mdcU0: vec4u,
}

struct Vertex {
    position: vec3f,
    normal: vec3f,
}

struct QEFData {
    ATA: mat3x3f,  // 3x3 symmetric matrix for QEF
    ATb: vec3f,    // Right hand side of QEF equation
    massPoint: vec3f,
    numPoints: u32,
}

struct EdgeDebugSample {
    crossingPos: vec4f,
    normal: vec4f,
    featurePoint: vec4f,
    featureN1: vec4f,
    featureN2: vec4f,
    // For RING (and only RING): xyz = ring axisCenter (a point on the axis of
    // revolution closest to featurePoint); .w reserved. The viewer derives
    // axis = cross(tangent, normalize(featurePoint - axisCenter)) and
    // radius = length(featurePoint - axisCenter).
    axisCenter: vec4f,
}

struct ComponentFeature {
    kind: u32,
    ownerA: u32,
    ownerB: u32,
    normalCount: u32,
    point: vec3f,
    tangent: vec3f,
    n0: vec3f,
    n1: vec3f,
    n2: vec3f,
    // For MID_FEATURE_RING: a point on the ring's axis of revolution closest
    // to `point`. Together with `point` and `tangent` it fully reconstructs the
    // circle, letting Pass 4 snap the sub-vertex to the true ring instead of
    // its local tangent linearization. Zero for other feature kinds.
    axisCenter: vec3f,
}

//:) include "mdc_feature_crossing_project.wgsl"

// ============================== MDC CONSTANTS ==============================
// "Proper" Manifold Dual Contouring requires multiple vertices per cell
// (one per connected surface component within the cell).
//
// Practical bound: for a single isosurface in a cube, you rarely need >4
// components. We allocate a fixed maximum for simplicity and GPU-friendly
// memory layout.
const MAX_COMPONENTS_PER_CELL: u32 = 4u;
const EDGES_PER_CELL: u32 = 12u;

// Stage C: per-subcomponent vertex splitting.
// A cell-component with a crease emits up to MAX_SUBCOMPONENTS_PER_COMPONENT
// sub-vertices (one per face-normal bucket), each carrying that face's normal.
// Smooth (single-bucket) components only populate subcomp 0; the other slots
// remain sentinel and are never referenced by the index buffer.
const MAX_SUBCOMPONENTS_PER_COMPONENT: u32 = 3u;
const VERTICES_PER_CELL: u32 = MAX_COMPONENTS_PER_CELL * MAX_SUBCOMPONENTS_PER_COMPONENT; // 12

// Packs (componentIdx in low 16 bits, subcomponentIdx in next 8 bits) into a
// single u32 for cellEdgeComponents. Sentinel 0xffffffffu keeps "no crossing".
fn packCompSub(c: u32, s: u32) -> u32 { return c | (s << 16u); }
fn unpackComp(v: u32) -> u32 { return v & 0xffffu; }
fn unpackSub(v: u32) -> u32 { return (v >> 16u) & 0xffu; }
fn vertexIndexFor(activeCellIdx: u32, c: u32, s: u32) -> u32 {
    return activeCellIdx * VERTICES_PER_CELL + c * MAX_SUBCOMPONENTS_PER_COMPONENT + s;
}

// ============================== BIND GROUPS ==============================

// Group 0: Shared parameters across all passes
@group(0) @binding(0) var<uniform> uniforms: SharedUniforms;

// Selection array indexed by object ID (not used in MDC; only needed in preview shader).
// Deliberately omitted to stay within the 10 storage buffer per-stage limit in Pass 5.

// Polygon vertex buffer (shared storage for all Polygon2D vertex data).
@group(0) @binding(27) var<storage, read> polygonVertices: array<vec2f>;

// Face selection (for Extrude face highlighting; not used in MDC, but must exist for compilation).
struct FaceSelection { nodeId: u32, faceIndex: u32, mode: u32, extrudeOffset: f32, pushPullActive: u32, segStart: u32, segEnd: u32, }
@group(0) @binding(28) var<uniform> faceSelection: FaceSelection;
const FACE_HIGHLIGHT_ID: u32 = 1023u;
const FACE_HIGHLIGHT_TOP: u32 = 1023u;
const FACE_HIGHLIGHT_BOTTOM: u32 = 1022u;

@group(0) @binding(30) var<storage, read> mdcSceneParams: array<f32>;
//:) include "mdc_scene_params_read.wgsl"

// Pass 1: Cell Classification
@group(0) @binding(1) var<storage, read_write> activeCellFlags: array<u32>; // Bit-packed flags

// Pass 3: Edge Detection
@group(0) @binding(5) var<storage, read> activeCellIndicesIn_edge: array<u32>; // Compacted list of active cell indices (output of Pass 2d)
@group(0) @binding(9) var<storage, read_write> cellQEFData_edge: array<QEFData>; // QEF data per (active cell * component)

// Pass 4: Vertex Generation
@group(0) @binding(11) var<storage, read> activeCellIndicesIn_vertex: array<u32>; // Compacted list (not strictly needed if vertices map 1:1 to active cells)
@group(0) @binding(12) var<storage, read> cellQEFDataIn_vertex: array<QEFData>;    // QEF data per (active cell * component) (output of Pass 3)
@group(0) @binding(13) var<storage, read_write> vertices: array<Vertex>;          // Output vertices
@group(0) @binding(14) var<storage, read_write> componentFeatures: array<ComponentFeature>;
// Pass 5: Face Generation (atomic triangle generation)
@group(0) @binding(15) var<storage, read> activeCellIndicesIn_face: array<u32>;     // Compacted list of active cell indices
@group(0) @binding(16) var<storage, read> activeCellFlagsInput_face: array<u32>; // Original cell flags (output of Pass 1)
@group(0) @binding(17) var<storage, read_write> indices: array<u32>;              // Output triangle indices
@group(0) @binding(18) var<storage, read_write> indexCount_face: atomic<u32>;       // Total number of indices
// Manifold DC connectivity:
// For each active cell we store which surface component each of the 12 cube edges belongs to.
// Layout: cellEdgeComponents[(activeCellIdx * 12) + edgeIdx] = componentIdx (0..MAX_COMPONENTS_PER_CELL-1),
// or 0xffffffff if that cube edge does not cross the isosurface.
@group(0) @binding(22) var<storage, read_write> cellEdgeComponents: array<u32>;

// Fast neighbor lookup (sparse):
// Open-addressing hash table stored as interleaved u32 pairs:
//   cellToActiveHash[2*i + 0] = cellFlatIndex (key) or 0xffffffffu if empty
//   cellToActiveHash[2*i + 1] = activeCellIdx  (value)
// Table size MUST be a power of two, and should be >= 2 * activeCellCount for low probe counts.
@group(0) @binding(23) var<storage, read> cellToActiveHash: array<u32>;

// Debug counters (optional):
// [0] = quads skipped because a neighbor cell was missing
// [1] = quads skipped because component mapping was missing (0xffffffff)
// [8] = crossings with no feature payload
// [9] = crossings classified as line feature
// [10] = crossings classified as corner feature
// [11] = crossings classified as boolean seam feature
// [12] = feature hints rejected (too far / too weak)
// [13] = extra QEF planes injected from features
// [14] = crossings classified as ring feature (closed circular crease)
@group(0) @binding(24) var<storage, read_write> debugSkipCounters: array<atomic<u32>, 16>;

// Cancellation flag: 0 = continue, 1 = cancelled
@group(0) @binding(25) var<storage, read_write> cancelled: atomic<u32>;

// Optional pass-3 debug overlay samples for the mesh viewer.
@group(0) @binding(26) var<storage, read_write> debugEdgeSampleCount: atomic<u32>;
@group(0) @binding(29) var<storage, read_write> debugEdgeSamples: array<EdgeDebugSample>;


// ============================== UTILITY FUNCTIONS ==============================

fn rectSDF2D(p: vec2f, center: vec2f, tangent: vec2f, normal: vec2f, halfW: f32, halfH: f32) -> f32 {
    let rel = p - center;
    let localX = dot(rel, tangent);
    let localY = dot(rel, normal);
    let dd = vec2f(abs(localX) - halfW, abs(localY) - halfH);
    return length(max(dd, vec2f(0.0))) + min(max(dd.x, dd.y), 0.0);
}

// Auxiliary SDF functions (e.g., per-polygon evaluators) are injected here at runtime.
//:) insert sceneAuxFast
// Mesh/FG/bounds use true geometry; the extrude smooth-shading toggle is
// preview-only (preview.wgsl reads viewSettings), so force flat here.
fn sdfFlatShadingFlag() -> u32 { return 1u; }
fn sdfDebugTessEdgesFlag() -> u32 { return 0u; }
//:) insert sceneAux
//:) insert sceneAuxMid

// Placeholder for the actual scene Signed Distance Function
fn sceneSDF(p: vec3f) -> SDFResult {
    _ = polygonVertices[0];
    _ = faceSelection.nodeId;
    _ = mdcSceneParams[0];
    return sdfTrue(0.0, 0u, vec3f(0.0)); //:) insert sceneSDF
}

// Mid-tier SDF: d, g, n plus optional feature payload for feature-aware MDC.
fn sceneSDF_mid(p: vec3f) -> SDFResultMid {
    _ = polygonVertices[0];
    _ = faceSelection.nodeId;
    _ = mdcSceneParams[0];
    return sdfRMid(0.0, 1.0, vec3f(0.0)); //:) insert sceneSDF_mid
}

// Fast version for distance-only evaluations.
fn sceneSDF_fast(p: vec3f) -> FastSDFResult {
    _ = mdcSceneParams[0];
    return sdfFast(0.0, 1.0, 1.0); //:) insert sceneSDF_fast
}

fn mix3f(a: vec3f, b: vec3f, t: f32) -> vec3f {
    return a * (1.0f - t) + b * t;
}

fn safeUnit3(v: vec3f) -> vec3f {
    let l = length(v);
    if (l > 1e-12) { return v / l; }
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
    // Ensure pos is within bounds before calling this, or handle clamping if necessary
    // This function assumes valid pos.
    return pos.x + pos.y * uniforms.gridDimensions.x +
           pos.z * uniforms.gridDimensions.x * uniforms.gridDimensions.y;
}

fn totalU32sInFlags() -> u32 {
    return (uniforms.gridDimensions.x * uniforms.gridDimensions.y * uniforms.gridDimensions.z + 31u) / 32u;
}

// Check if the operation has been cancelled
fn isCancelled() -> bool {
    return atomicLoad(&cancelled) != 0u;
}

fn activeIndexForCellPos(cellPos: vec3u) -> i32 {
    // Cells live in [0 .. gridDimensions-2] in each axis.
    if (any(cellPos >= uniforms.gridDimensions - 1u)) { return -1; }
    let cellFlatIndex = gridPosToIndex(cellPos);

    let len = arrayLength(&cellToActiveHash);
    if (len < 2u) { return -1; }
    let entries = len >> 1u;
    let mask = entries - 1u;

    // Knuth multiplicative hash
    var slot = (cellFlatIndex * 2654435761u) & mask;
    // Probe up to a safe constant; with the CPU-sized table (<= 25% load) this should
    // still be very small in practice, but we avoid false "missing neighbor" reports.
    for (var probe = 0u; probe < 256u; probe = probe + 1u) {
        let base = slot << 1u;
        let key = cellToActiveHash[base + 0u];
        if (key == cellFlatIndex) {
            return i32(cellToActiveHash[base + 1u]);
        }
        if (key == 0xffffffffu) {
            return -1;
        }
        slot = (slot + 1u) & mask;
    }
    return -1;
}

// Gets the grid coordinates of one of the 8 corners of a cell.
// cellPos is the min-corner of the cell.
// cornerIndex is 0-7.
fn getCellCornerPos(cellPos: vec3u, cornerIndex: u32) -> vec3u {
    return cellPos + vec3u(
        cornerIndex & 1u,          // x offset (0 or 1)
        (cornerIndex >> 1u) & 1u,  // y offset (0 or 1)
        (cornerIndex >> 2u) & 1u   // z offset (0 or 1)
    );
}

fn sampleSDF(worldPos: vec3f) -> f32 {
    return sceneSDF_fast(worldPos).d;
}

fn computeGradient(p: vec3f) -> vec3f {
    // Finite-difference epsilon in world units.
    // Keep this small to preserve sharp features (boxes, CSG seams), but not *too* small
    // (avoid catastrophic cancellation / denorm noise).
    let eps = max(uniforms.mdcF1.y, uniforms.voxelSize * uniforms.mdcF1.x);
    let dx = sampleSDF(p + vec3f(eps, 0.0, 0.0)) - sampleSDF(p - vec3f(eps, 0.0, 0.0));
    let dy = sampleSDF(p + vec3f(0.0, eps, 0.0)) - sampleSDF(p - vec3f(0.0, eps, 0.0));
    let dz = sampleSDF(p + vec3f(0.0, 0.0, eps)) - sampleSDF(p - vec3f(0.0, 0.0, eps));
    let grad = vec3f(dx, dy, dz);
    let len = length(grad);
    if (len == 0.0) {
        return vec3f(0.0, 1.0, 0.0); // Or some default normal
    }
    return grad / len; // Normalized gradient
}

// Checks if a cell is active based on the bit-packed flags.
// This version is used in Pass 5 where activeCellFlagsInput_face is available.
fn isCellActive(cellPos: vec3u) -> bool {
    if (any(cellPos >= uniforms.gridDimensions - 1u)) { // Cells on the max boundary cannot be fully formed for DC
        return false;
    }
    let cellIndex = gridPosToIndex(cellPos);
    let arrayIndex = cellIndex / 32u;
    let bitIndex = cellIndex % 32u;

    let nFlags = totalU32sInFlags();
    if (arrayIndex >= nFlags || arrayIndex >= arrayLength(&activeCellFlagsInput_face)) {
        return false; // Out of bounds for the flags array
    }
    return (activeCellFlagsInput_face[arrayIndex] & (1u << bitIndex)) != 0u;
}


// Finds the intersection point t (0-1 range) along an edge.
fn findEdgeIntersection(p0_val: f32, p1_val: f32) -> f32 {
    // Avoid division by zero if p0_val and p1_val are too close
    let diff = p1_val - p0_val;
    if (abs(diff) < 0.00001) {
        return 0.5; // Midpoint if values are too similar
    }
    return clamp((uniforms.isoValue - p0_val) / diff, 0.0, 1.0);
}

// Robust grid-vertex classification (3-state) for topology decisions:
// -1 = inside, +1 = outside, 0 = on-surface (within epsilon band)
//
// IMPORTANT: Avoid hash-based tie-breaks here. They are stable, but when many samples
// fall into the epsilon band (common near CSG seams), they create spatially-correlated
// alternation -> "checkerboard" missing polygons.
fn resolveSignAtPos(p: vec3f, d: f32) -> i32 {
    let eps = max(uniforms.mdcF0.y * 0.5, uniforms.voxelSize * uniforms.mdcF0.x * 0.5);
    if (d > eps) { return 1; }
    if (d < -eps) { return -1; }

    // Use analytic normal to resolve on-surface samples deterministically.
    let sdf = sceneSDF_mid(p);
    let n = sdf.n * select(-1.0, 1.0, sdf.d >= 0.0);
    if (length(n) > 0.0) {
        let nudge = min(eps, uniforms.voxelSize * 0.02);
        let d2p = sceneSDF_fast(p + n * nudge).d - uniforms.isoValue;
        let d2m = sceneSDF_fast(p - n * nudge).d - uniforms.isoValue;
        if (d2p > 0.0 && d2m > 0.0) { return 1; }
        if (d2p < 0.0 && d2m < 0.0) { return -1; }
    }
    return 0;
}

fn vertexClassAtGridVertex(p: vec3f, sdfValue: f32) -> i32 {
    let d = sdfValue - uniforms.isoValue;
    return resolveSignAtPos(p, d);
}

fn vertexInsideForCases(sdfValue: f32) -> bool {
    // IMPORTANT:
    // Exact zero crossings (common for axis-aligned boxes landing on the sampling grid)
    // cause topology ambiguity. A per-vertex tie-break creates checkerboard holes.
    //
    // Use a tiny *global* bias so "exactly on the surface" is classified consistently,
    // avoiding missing triangles along sharp edges without introducing spatial alternation.
    let d = sdfValue - uniforms.isoValue;
    let bias = max(uniforms.mdcF0.w, uniforms.voxelSize * uniforms.mdcF0.z);
    return d < -bias;
}

fn edgeCrossesIso(v0: f32, p0: vec3f, v1: f32, p1: vec3f) -> bool {
    // Classify endpoints with a deterministic sign resolution that uses normals
    // when the sample is very close to the iso-surface.
    let d0 = (v0 - uniforms.isoValue);
    let d1 = (v1 - uniforms.isoValue);
    let s0 = resolveSignAtPos(p0, d0) < 0;
    let s1 = resolveSignAtPos(p1, d1) < 0;
    return s0 != s1;
}

fn edgeCrossesIsoWithStats(p0: vec3f, p1: vec3f, v0: f32, v1: f32) -> bool {
    let d0 = (v0 - uniforms.isoValue);
    let d1 = (v1 - uniforms.isoValue);
    let s0 = resolveSignAtPos(p0, d0) < 0;
    let s1 = resolveSignAtPos(p1, d1) < 0;

    let eps = max(uniforms.mdcF0.y, uniforms.voxelSize * uniforms.mdcF0.x);
    let near0 = abs(d0) <= eps;
    let near1 = abs(d1) <= eps;
    if (near0 && near1) {
        atomicAdd(&debugSkipCounters[2], 1u);
    } else if ((near0 || near1) && (s0 == s1)) {
        atomicAdd(&debugSkipCounters[3], 1u);
    }
    if (s0 != s1) {
        atomicAdd(&debugSkipCounters[5], 1u);
    }
    return s0 != s1;
}

// --- NaN/Inf Helper Functions ---
fn isNan(x: f32) -> bool {
    let high = 100000000.0; // A large representable float
    return max(x, high) == high && x != x;
}

fn isInf(x: f32) -> bool {
    // Check against the bit pattern for infinity.
    // Positive Infinity: 0x7F800000
    // Negative Infinity: 0xFF800000
    // abs(x) handles both positive and negative infinity.
    return abs(x) >= f32(bitcast<u32>(0x7f800000u)-1u);
}


// --- QEF Solver Helper Functions ---
// Estimate condition number (simplified)
fn estimateConditionNumber(A: mat3x3f) -> f32 {
    var v = vec3f(1.0, 1.0, 1.0);
    var lambda_max = 0.0;
    for (var i = 0; i < 5; i = i + 1) {
        v = A * v;
        let norm_v = length(v);
        if (norm_v > 1e-6) { // Avoid division by zero or tiny numbers
            lambda_max = norm_v;
            v = v / norm_v;
        } else {
            break;
        }
    }
    let trace_A = A[0][0] + A[1][1] + A[2][2];
    let lambda_min_est = max(1e-6, abs(trace_A / 3.0 - lambda_max * 0.666)); 
    if (lambda_min_est == 0.0) { return 1e9; } 
    return abs(lambda_max / lambda_min_est);
}

// Solve symmetric positive definite system A*x = b using Cholesky decomposition
fn solveCholesky(A: mat3x3f, b: vec3f) -> vec3f {
    var L: mat3x3f; 

    L[0][0] = sqrt(max(A[0][0], 1e-6));
    if (L[0][0] == 0.0) { return vec3f(0.0); } // Avoid division by zero early
    L[1][0] = A[1][0] / L[0][0];
    L[2][0] = A[2][0] / L[0][0];

    L[0][1] = 0.0;
    var val_L11_sq = A[1][1] - L[1][0] * L[1][0];
    L[1][1] = sqrt(max(val_L11_sq, 1e-6));
    if (L[1][1] == 0.0) { return vec3f(0.0); }
    L[2][1] = (A[2][1] - L[2][0] * L[1][0]) / L[1][1];
    
    L[0][2] = 0.0;
    L[1][2] = 0.0;
    var val_L22_sq = A[2][2] - L[2][0] * L[2][0] - L[2][1] * L[2][1];
    L[2][2] = sqrt(max(val_L22_sq, 1e-6));
    if (L[2][2] == 0.0) { return vec3f(0.0); }


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
    // Keep regularization extremely small, but scale it with voxel size to maintain
    // consistent behavior across different grid resolutions.
    //
    // IMPORTANT: We *do* use the regularization to bias the solution toward the mass point
    // for rank-deficient QEFs (planar faces / edges). Without this, the solver can pick
    // arbitrary tangential coordinates (e.g. y=z=0 on an X-face), which shows up as
    // wrinkled faces and non-90° edges.
    //
    // We implement this as:
    //   (A + λI) x = b + λ m
    // where m is the mass point.
    // Scale regularization with voxel size to prevent over-smoothing at high resolutions.
    // The regularization should scale proportionally with voxel size so the relative
    // smoothing effect remains constant across different grid resolutions.
    // At GRID_DIM=64, voxelSize ≈ 1.5625mm, and we want regularization ≈ 1e-5,
    // so we scale by voxelSize / 1.5625 to maintain the same ratio.
    let regularization = max(uniforms.mdcF2.w, uniforms.voxelSize * uniforms.mdcF2.z);
    ATA_reg[0][0] += regularization;
    ATA_reg[1][1] += regularization;
    ATA_reg[2][2] += regularization;

    // The field can be rank-deficient on planar regions (expected).
    // Avoid bailing out too aggressively here; instead rely on clamping and surface projection later.
    // Still bail out on *extreme* numerical instability.
    if (estimateConditionNumber(ATA_reg) > uniforms.mdcF3.x) { return massPoint; }

    let b_reg = qef.ATb + massPoint * regularization;
    let solution = solveCholesky(ATA_reg, b_reg);
    
    // Corrected NaN/Inf check using vec3<bool> and any()
    let solution_is_nan = vec3<bool>(isNan(solution.x), isNan(solution.y), isNan(solution.z));
    let solution_is_inf = vec3<bool>(isInf(solution.x), isInf(solution.y), isInf(solution.z));
    if (any(solution_is_nan) || any(solution_is_inf)) {
        return massPoint;
    }

    return solution;
}

// Evaluate the (constant-free) QEF quadratic form at x:
// E(x) = x^T * ATA * x - 2 * x^T * ATb (+ const)
// Lower is better. This lets us compare candidate vertex positions without storing all planes.
fn qefCost(qef: QEFData, x: vec3f) -> f32 {
    let Ax = qef.ATA * x;
    return dot(x, Ax) - 2.0 * dot(x, qef.ATb);
}

fn clampFeatureVertex(p: vec3f, cellMin: vec3f, cellMax: vec3f) -> vec3f {
    // Feature constraints intentionally pull neighboring cell vertices onto a
    // shared line/ring/corner. Hard-clamping back to the owning voxel cell turns
    // those exact loci into cell-boundary stair steps, especially on lathe rings.
    let margin = uniforms.voxelSize * 0.75;
    return clamp(p, cellMin - vec3f(margin), cellMax + vec3f(margin));
}

fn clampRingFeatureVertex(p: vec3f, cellMin: vec3f, cellMax: vec3f) -> vec3f {
    // A valid ring snap should land exactly on the shared circular locus.
    // Any cell-local clamp moves some vertices off that circle while their
    // neighbors remain on it, which creates tiny fins around the ring.
    _ = cellMin;
    _ = cellMax;
    return p;
}

const MDC_FEATURE_PROX_SCALE: f32 = 0.75;
const MDC_FEATURE_PLANE_WEIGHT: f32 = 0.12;
// Sentinel `kind` for inferred-component features whose tangent solve failed
// (e.g. parallel bucket normals). Distinct from any MID_FEATURE_* value so the
// debug pipeline can count it separately.
const COMPONENT_FEATURE_REJECTED: u32 = 5u;
const COMPONENT_NORMAL_COS_THRESH: f32 = 0.95;
/** Inferred-line acceptance: the two bucket normals must form at least a ~45° crease (cosine ≤ 0.7).
 * Prevents smooth high-curvature regions (e.g., lathed spheroids) from registering as line creases. */
const MDC_INFER_LINE_DOT_MAX: f32 = 0.7;
/** Inferred-line acceptance: each of the two normal buckets must contain this many edge-crossing samples.
 * Single-sample buckets are usually curvature noise on a smooth surface. */
const MDC_INFER_LINE_MIN_BUCKET_SAMPLES: u32 = 2u;
/** Inferred-line acceptance: each bucket's normals must be tightly aligned (sum length per sample
 * close to 1). On a real crease both faces are flat and coherence is ~1.0. On a small-radius
 * lathe / cone section, azimuthal sweep across a single cell spreads a bucket's normals over an
 * arc, dropping coherence well below 1. Filtering at 0.95 (~18° max effective bucket spread)
 * eliminates the sporadic ghost LINE glyphs that scattered along smooth lathe surfaces, while
 * still allowing real flat-face creases (cylinder caps, cone bases, hexprism faces) through. */
const MDC_INFER_LINE_BUCKET_COHERENCE: f32 = 0.95;
const MDC_CORNER_FEATURE_PROX_SCALE: f32 = 1.35;
const MDC_CORNER_PROBE_PROX_SCALE: f32 = 1.9;
/** Cell-interior LINE probe acceptance: a probe sampled at the 2-plane
 * intersection passes if the SDF reports a LINE feature within voxelSize ×
 * this scale of the probe point. The probe sits in the cube interior (the
 * QEF intersection of the two face buckets), not on the surface — its
 * distance to the analytic line locus is the cube-diagonal-scale cell radius
 * plus whatever 2D offset the polygon vertex gives, so the threshold has to
 * cover roughly one full voxel diagonal (~1.73). Up to 3.0 to be safe with
 * twisted edges where the polygon vertex curves in 3D. */
const MDC_LINE_PROBE_PROX_SCALE: f32 = 3.0;
// Rings (closed circular creases) deserve a more permissive proximity threshold
// than straight LINE creases: every cell that touches the ring should pick it
// up, otherwise neighbors that miss it fall back to the inferred-LINE path and
// emit ghost edge glyphs along the same circle. 1.35 voxels matches CORNER and
// covers the corner-to-cell-center distance for grids aligned to the ring.
const MDC_RING_FEATURE_PROX_SCALE: f32 = 1.35;
fn mdcQefAddPlane(qef: ptr<function, QEFData>, normal: vec3f, point: vec3f, weight: f32) {
    let n = safeNormalize(normal, vec3f(0.0, 1.0, 0.0));
    (*qef).ATA[0] = (*qef).ATA[0] + n * (n.x * weight);
    (*qef).ATA[1] = (*qef).ATA[1] + n * (n.y * weight);
    (*qef).ATA[2] = (*qef).ATA[2] + n * (n.z * weight);
    let d = dot(n, point);
    (*qef).ATb = (*qef).ATb + n * (d * weight);
}

fn zeroComponentFeature() -> ComponentFeature {
    return ComponentFeature(
        MID_FEATURE_NONE, 0u, 0u, 0u,
        vec3f(0.0), vec3f(0.0), vec3f(0.0), vec3f(0.0), vec3f(0.0), vec3f(0.0),
    );
}

fn ownerPairEqual(a: vec2u, b: vec2u) -> bool {
    return a.x == b.x && a.y == b.y;
}

fn solveFeaturePoint(n0: vec3f, p0: vec3f, n1: vec3f, p1: vec3f, n2: vec3f, p2: vec3f, planeCount: u32) -> vec3f {
    var qef = QEFData(mat3x3f(), vec3f(0.0), vec3f(0.0), 0u);
    if (planeCount >= 1u) {
        mdcQefAddPlane(&qef, n0, p0, 1.0);
        qef.massPoint = qef.massPoint + p0;
        qef.numPoints = qef.numPoints + 1u;
    }
    if (planeCount >= 2u) {
        mdcQefAddPlane(&qef, n1, p1, 1.0);
        qef.massPoint = qef.massPoint + p1;
        qef.numPoints = qef.numPoints + 1u;
    }
    if (planeCount >= 3u) {
        mdcQefAddPlane(&qef, n2, p2, 1.0);
        qef.massPoint = qef.massPoint + p2;
        qef.numPoints = qef.numPoints + 1u;
    }
    return solveQEF(qef);
}


// Workgroup shared memory (declared at module scope)
var<workgroup> workgroup_thread_flags: array<u32, 256>; // General purpose flags, max workgroup size used (e.g. 256 or 32 for Pass1)


// ============================== MDC TOPOLOGY HELPERS ==============================

// Cube corner indices follow getCellCornerPos bit convention:
// 0:(0,0,0) 1:(1,0,0) 2:(0,1,0) 3:(1,1,0)
// 4:(0,0,1) 5:(1,0,1) 6:(0,1,1) 7:(1,1,1)
//
// Cube edge indices follow Pass3 edges_info ordering:
// X: (0-1)=0, (2-3)=1, (4-5)=2, (6-7)=3
// Y: (0-2)=4, (1-3)=5, (4-6)=6, (5-7)=7
// Z: (0-4)=8, (1-5)=9, (2-6)=10,(3-7)=11
const FACE_CORNERS: array<vec4u, 6> = array<vec4u, 6>(
    // z = 0
    vec4u(0u, 1u, 3u, 2u),
    // z = 1
    vec4u(4u, 5u, 7u, 6u),
    // y = 0
    vec4u(0u, 1u, 5u, 4u),
    // y = 1
    vec4u(2u, 3u, 7u, 6u),
    // x = 0
    vec4u(0u, 2u, 6u, 4u),
    // x = 1
    vec4u(1u, 3u, 7u, 5u)
);

// For each face, the 4 corresponding cube edges in the same cyclic order as FACE_CORNERS.
// Face edges are e0:(c0-c1), e1:(c1-c2), e2:(c2-c3), e3:(c3-c0).
const FACE_EDGES: array<vec4u, 6> = array<vec4u, 6>(
    // z = 0: (0-1)=0, (1-3)=5, (3-2)=1, (2-0)=4
    vec4u(0u, 5u, 1u, 4u),
    // z = 1: (4-5)=2, (5-7)=7, (7-6)=3, (6-4)=6
    vec4u(2u, 7u, 3u, 6u),
    // y = 0: (0-1)=0, (1-5)=9, (5-4)=2, (4-0)=8
    vec4u(0u, 9u, 2u, 8u),
    // y = 1: (2-3)=1, (3-7)=11,(7-6)=3, (6-2)=10
    vec4u(1u, 11u, 3u, 10u),
    // x = 0: (0-2)=4, (2-6)=10,(6-4)=6, (4-0)=8
    vec4u(4u, 10u, 6u, 8u),
    // x = 1: (1-3)=5, (3-7)=11,(7-5)=7, (5-1)=9
    vec4u(5u, 11u, 7u, 9u)
);

fn ufFind(parent: ptr<function, array<u32, 12>>, x: u32) -> u32 {
    var r = x;
    loop {
        let p = (*parent)[r];
        if (p == r) { break; }
        r = p;
    }
    // Path compression
    var y = x;
    loop {
        let p = (*parent)[y];
        if (p == r) { break; }
        (*parent)[y] = r;
        y = p;
    }
    return r;
}

fn ufUnion(parent: ptr<function, array<u32, 12>>, a: u32, b: u32) {
    let ra = ufFind(parent, a);
    let rb = ufFind(parent, b);
    if (ra == rb) { return; }
    (*parent)[rb] = ra;
}


// ============================== COMPUTE SHADERS ==============================

// Pass 1: Cell Classification (Corrected for @workgroup_size(32,1,1) and atomic-free packing)
// Dispatch: num_workgroups = ceil(totalGridCells / 32.0)
// activeCellFlags stores 1 bit per cell, packed into u32s.
@compute @workgroup_size(32, 1, 1) // Workgroup size must be 32 for this packing logic
fn cellClassification_Pass1(
    @builtin(local_invocation_id) localId: vec3u, // localId.x is bit_index_in_u32 (0-31)
    @builtin(workgroup_id) workgroupId: vec3u,   // u32 block index (linearized)
    @builtin(num_workgroups) numWg: vec3u
) {
    let u32_block_index = workgroupId.x + workgroupId.y * numWg.x + workgroupId.z * numWg.x * numWg.y;
    let bit_index_in_u32 = localId.x;

    let cellFlatIndex = u32_block_index * 32u + bit_index_in_u32;
    
    let totalGridCells = uniforms.gridDimensions.x * uniforms.gridDimensions.y * uniforms.gridDimensions.z;

    // Check cancellation - store in variable to ensure binding is included in layout
    let cancelled = isCancelled();

    var cell_is_active = 0u;
    // Skip work if cancelled, but still participate in barrier
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
                if (c == 0) { hasPositive = true; hasNegative = true; } // on-surface => definitely active
                if (hasPositive && hasNegative) { break; }
            }
            if (hasPositive && hasNegative) {
                cell_is_active = 1u;
            }
        }
    }
    
    // workgroup_thread_flags is sized based on max workgroup size, ensure using correct indices for 32.
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


// Pass 3: Edge Detection and QEF Accumulation
@compute @workgroup_size(64, 1, 1)
fn edgeDetection_Pass3(
    @builtin(global_invocation_id) globalId: vec3u,
    @builtin(num_workgroups) numWg: vec3u
) {
    // Linearize 2D dispatch for large workgroup counts
    let active_cell_array_idx = globalId.x + globalId.y * (numWg.x * 64u);

    // Check cancellation but don't return early (to maintain uniform control flow)
    let cancelled = isCancelled();

    let totalActiveCells = uniforms.mdcU0.z; 
    if (cancelled || active_cell_array_idx >= totalActiveCells) { return; }
    if (active_cell_array_idx >= arrayLength(&activeCellIndicesIn_edge)) { return; }

    // activeCellIndicesIn_edge is a direct compact list of active cell flat indices.
    let cellFlatIndex = activeCellIndicesIn_edge[active_cell_array_idx];
    let cellPos = gridIndexTo3D(cellFlatIndex);
    let cellMin = gridPosToWorldPos(cellPos);
    let cellMax = cellMin + vec3f(uniforms.voxelSize);

    var cornerSDFValues: array<f32, 8>;
    var cornerWorldPositions: array<vec3f, 8>;
    var cornerGridPositions: array<vec3u, 8>;
    for (var i = 0u; i < 8u; i = i + 1u) {
        let cornerGridPos = getCellCornerPos(cellPos, i);
        cornerGridPositions[i] = cornerGridPos;
        cornerWorldPositions[i] = gridPosToWorldPos(cornerGridPos);
        cornerSDFValues[i] = sampleSDF(cornerWorldPositions[i]);
    }
    
    let edges_info = array<vec4u, 12>( 
        vec4u(0u, 1u, 0u, 1u), vec4u(2u, 3u, 0u, 0u), vec4u(4u, 5u, 0u, 0u), vec4u(6u, 7u, 0u, 0u),
        vec4u(0u, 2u, 1u, 1u), vec4u(1u, 3u, 1u, 0u), vec4u(4u, 6u, 1u, 0u), vec4u(5u, 7u, 1u, 0u),
        vec4u(0u, 4u, 2u, 1u), vec4u(1u, 5u, 2u, 0u), vec4u(2u, 6u, 2u, 0u), vec4u(3u, 7u, 2u, 0u)
    );

    // Determine which of the 12 cube edges cross the isosurface.
    // Then, using per-face marching-squares connectivity (with an asymptotic decider),
    // we connect those edge crossings into connected surface components.
    var edgeCrossMask: array<u32, 12>;
    var parent: array<u32, 12>;
    for (var e = 0u; e < 12u; e = e + 1u) {
        parent[e] = e;
        let c1_idx = edges_info[e][0];
        let c2_idx = edges_info[e][1];
        let val0 = cornerSDFValues[c1_idx];
        let val1 = cornerSDFValues[c2_idx];
        let p0 = cornerWorldPositions[c1_idx];
        let p1 = cornerWorldPositions[c2_idx];
        edgeCrossMask[e] = select(
            0u,
            1u,
            edgeCrossesIsoWithStats(p0, p1, val0, val1)
        );
    }

    // Union edge-crossing nodes across faces.
    for (var f = 0u; f < 6u; f = f + 1u) {
        let fc = FACE_CORNERS[f];
        let fe = FACE_EDGES[f];
        let e0 = fe.x;
        let e1 = fe.y;
        let e2 = fe.z;
        let e3 = fe.w;
        let m0 = edgeCrossMask[e0];
        let m1 = edgeCrossMask[e1];
        let m2 = edgeCrossMask[e2];
        let m3 = edgeCrossMask[e3];
        let cnt = m0 + m1 + m2 + m3;

        if (cnt == 2u) {
            var a: u32 = 0xffffffffu;
            var b: u32 = 0xffffffffu;
            if (m0 == 1u) { if (a == 0xffffffffu) { a = e0; } else { b = e0; } }
            if (m1 == 1u) { if (a == 0xffffffffu) { a = e1; } else { b = e1; } }
            if (m2 == 1u) { if (a == 0xffffffffu) { a = e2; } else { b = e2; } }
            if (m3 == 1u) { if (a == 0xffffffffu) { a = e3; } else { b = e3; } }
            if (a != 0xffffffffu && b != 0xffffffffu) {
                ufUnion(&parent, a, b);
            }
        } else if (cnt == 4u) {
            // Ambiguous marching-squares face (checkerboard). Disambiguate by sampling face center.
            let in0 = vertexInsideForCases(cornerSDFValues[fc.x]);
            let in1 = vertexInsideForCases(cornerSDFValues[fc.y]);
            let in2 = vertexInsideForCases(cornerSDFValues[fc.z]);
            let in3 = vertexInsideForCases(cornerSDFValues[fc.w]);
            let s0: u32 = select(0u, 1u, in0);
            let s1: u32 = select(0u, 1u, in1);
            let s2: u32 = select(0u, 1u, in2);
            let s3: u32 = select(0u, 1u, in3);
            let faceCase = s0 | (s1 << 1u) | (s2 << 2u) | (s3 << 3u);

            if (faceCase == 5u || faceCase == 10u) {
                atomicAdd(&debugSkipCounters[7], 1u);
            }

            let faceCenterPos =
                (cornerWorldPositions[fc.x] + cornerWorldPositions[fc.y] + cornerWorldPositions[fc.z] + cornerWorldPositions[fc.w]) * 0.25;
            // Use the same globally-biased inside test as vertexInsideForCases to avoid
            // ambiguous on-surface centers causing inconsistent face resolution.
            let bias = max(uniforms.mdcF0.w, uniforms.voxelSize * uniforms.mdcF0.z);
            let centerD = sampleSDF(faceCenterPos) - uniforms.isoValue;
            let centerInside = centerD < -bias;
            let eps = max(uniforms.mdcF0.y, uniforms.voxelSize * uniforms.mdcF0.x);
            if (abs(centerD) <= eps) {
                atomicAdd(&debugSkipCounters[6], 1u);
            }

            // For faceCase 5 (0101): centerInside => pair (0-1) & (2-3), else pair (0-3) & (1-2)
            // For faceCase 10 (1010): centerInside => pair (0-3) & (1-2), else pair (0-1) & (2-3)
            if (faceCase == 5u) {
                if (centerInside) {
                    ufUnion(&parent, e0, e1);
                    ufUnion(&parent, e2, e3);
                } else {
                    ufUnion(&parent, e0, e3);
                    ufUnion(&parent, e1, e2);
                }
            } else if (faceCase == 10u) {
                if (centerInside) {
                    ufUnion(&parent, e0, e3);
                    ufUnion(&parent, e1, e2);
                } else {
                    ufUnion(&parent, e0, e1);
                    ufUnion(&parent, e2, e3);
                }
            } else {
                // Not expected (cnt==4 implies checkerboard), but keep robust.
                ufUnion(&parent, e0, e1);
                ufUnion(&parent, e2, e3);
            }
        }
    }

    // Compute per-edge Hermite samples for this cell (position + normal).
    // Uses gradient-magnitude-aware projection and bisection refinement for smooth CSG regions.
    let edgeCompBase = active_cell_array_idx * EDGES_PER_CELL;
    var crossingPos: array<vec3f, 12>;
    var crossingNormal: array<vec3f, 12>;
    var crossingMid: array<SDFResultMid, 12>;
    
    for (var e = 0u; e < 12u; e = e + 1u) {
        if (edgeCrossMask[e] == 1u) {
            let c1_idx = edges_info[e][0];
            let c2_idx = edges_info[e][1];
            let val0 = cornerSDFValues[c1_idx];
            let val1 = cornerSDFValues[c2_idx];
            let p0_world = cornerWorldPositions[c1_idx];
            let p1_world = cornerWorldPositions[c2_idx];
            
            // Start with linear interpolation
            let t = findEdgeIntersection(val0, val1);
            var intersectionPos = mix3f(p0_world, p1_world, t);
            
            // Check if we're in a smooth blend region (gradient magnitude < 1)
            let initialSdfFast = sceneSDF_fast(intersectionPos);
            let inBlendRegion = initialSdfFast.g < 0.95;
            
            if (inBlendRegion) {
                // Use bisection for accurate edge intersection in blend regions
                // where the SDF is non-linear along the edge
                var pA = p0_world;
                var pB = p1_world;
                var dA = val0 - uniforms.isoValue;
                var dB = val1 - uniforms.isoValue;
                
                // Bisection refinement (8 iterations = 1/256 accuracy)
                for (var bisect = 0u; bisect < 8u; bisect = bisect + 1u) {
                    let pMid = mix3f(pA, pB, 0.5);
                    let dMid = sampleSDF(pMid) - uniforms.isoValue;
                    
                    // Use same tolerance as edge projection (uniforms.mdcF1.z)
                    if (abs(dMid) < uniforms.voxelSize * uniforms.mdcF1.z) {
                        intersectionPos = pMid;
                        break;
                    }
                    
                    if (dMid * dA < 0.0) {
                        pB = pMid;
                        dB = dMid;
                    } else {
                        pA = pMid;
                        dA = dMid;
                    }
                    intersectionPos = mix3f(pA, pB, 0.5);
                }
            }
            
            // Final projection with gradient-magnitude correction
            // Use analytic normals from SDFResultMid instead of finite-difference gradients
            // for stability at CSG seams where gradients are discontinuous.
            // Note: n is already correctly oriented by CSG operators (they negate n when needed)
            var sdfResult = sceneSDF_mid(intersectionPos);
            var normal = sdfResult.n;
            for (var iter = 0u; iter < uniforms.mdcU0.x; iter = iter + 1u) {
                sdfResult = sceneSDF_mid(intersectionPos);
                let d = sdfResult.d - uniforms.isoValue;
                if (abs(d) < uniforms.voxelSize * uniforms.mdcF1.z) { break; }
                // Use analytic normal from SDF result (already correctly oriented)
                normal = sdfResult.n;
                // Only use gradient magnitude to reduce step size.
                let gradScale = max(1.0, sdfResult.g);
                let correctedStep = d / gradScale;
                // Tighter step limit in blend regions to avoid oscillation
                let maxStep = uniforms.voxelSize * select(0.75, 0.4, sdfResult.g < 0.8);
                let clampedStep = clamp(correctedStep, -maxStep, maxStep);
                intersectionPos = intersectionPos - normal * clampedStep;
            }
            // Get final analytic normal at converged position
            let finalSdf = sceneSDF_mid(intersectionPos);
            normal = finalSdf.n;
            
            crossingPos[e] = intersectionPos;
            crossingNormal[e] = normal;
            crossingMid[e] = finalSdf;
        } else {
            crossingPos[e] = vec3f(0.0);
            crossingNormal[e] = vec3f(0.0);
            crossingMid[e] = sdfRMidNoFeature(0.0, 1.0, vec3f(0.0, 1.0, 0.0));
        }
    }

    // Map union-find roots to local component indices (0..MAX_COMPONENTS_PER_CELL-1).
    var compRoots: array<u32, 12>;
    var compCount: u32 = 0u;
    var edgeComponent: array<i32, 12>;

    for (var e = 0u; e < 12u; e = e + 1u) {
        var compIdx: i32 = -1;
        if (edgeCrossMask[e] == 1u) {
            let root = ufFind(&parent, e);
            // find/insert root in compRoots
            for (var j = 0u; j < compCount; j = j + 1u) {
                if (compRoots[j] == root) { compIdx = i32(j); }
            }
            if (compIdx < 0) {
                if (compCount < MAX_COMPONENTS_PER_CELL) {
                    compRoots[compCount] = root;
                    compIdx = i32(compCount);
                    compCount = compCount + 1u;
                } else {
                    // Overflow: merge into last component slot.
                    compIdx = i32(MAX_COMPONENTS_PER_CELL - 1u);
                }
            }
        }
        edgeComponent[e] = compIdx;
        // cellEdgeComponents write deferred to after Phase 1 (collect) so we can
        // pack the per-edge subcomponent (face bucket) index alongside the
        // component index.
    }

    // Accumulate per-subcomponent QEFs ([component][subcomponent]). Each
    // sub-vertex is solved separately in Pass 4 so that creases produce real
    // sharp mesh edges with face-specific normals. Smooth components only fill
    // subcomponent 0.
    var subQefs: array<array<QEFData, 3>, 4>;
    var inferredFeatures: array<ComponentFeature, 4>;
    var compPointSum: array<vec3f, 4>;
    var compCrossCount: array<u32, 4>;
    var compOwnerPair0: array<vec2u, 4>;
    var compOwnerPair1: array<vec2u, 4>;
    var compOwnerPairCount: array<u32, 4>;
    var compNormalBucketCount: array<u32, 4>;
    var compPlanePoint0: array<vec3f, 4>;
    var compPlanePoint1: array<vec3f, 4>;
    var compPlanePoint2: array<vec3f, 4>;
    var explicitLineFeature: array<ComponentFeature, 4>;
    var explicitCornerFeature: array<ComponentFeature, 4>;
    var explicitSeamFeature: array<ComponentFeature, 4>;
    var explicitRingFeature: array<ComponentFeature, 4>;
    var explicitLineDist: array<f32, 4>;
    var explicitCornerDist: array<f32, 4>;
    var explicitSeamDist: array<f32, 4>;
    var explicitRingDist: array<f32, 4>;
    // Sticky per-component flag: any sample in this component had featureKind ==
    // MID_FEATURE_RING (regardless of acceptance distance). Used in Phase 2 to
    // suppress inferred-LINE fallback for cells that sit on a ring crease but
    // are slightly outside the explicit RING acceptance threshold — without
    // this they emit ghost LINE features that show up as scattered edge glyphs
    // along the same circle as the real RING glyph.
    var compHasRingSample: array<u32, 4>;
    // Count of crossings whose sceneSDF_mid sample is a lathe mantle tag
    // (MID_FEATURE_NONE + MID_LATHE_MANTLE_NORMAL_COUNT). When this equals
    // compCrossCount[c], every crossing in the component is pure lathe mantle
    // (no CSG partner), so inferred LINE creases are disabled — lathe uses
    // explicit RING/CORNER only, never open LINE features.
    var compLatheMantleCrossCount: array<u32, 4>;
    var compNormalSums: array<array<vec3f, 3>, 4>;
    var compPointSums: array<array<vec3f, 3>, 4>;
    var compPointCounts: array<array<u32, 3>, 4>;
    for (var c = 0u; c < 4u; c = c + 1u) {
        inferredFeatures[c] = zeroComponentFeature();
        compPointSum[c] = vec3f(0.0);
        compCrossCount[c] = 0u;
        compOwnerPair0[c] = vec2u(0u);
        compOwnerPair1[c] = vec2u(0u);
        compOwnerPairCount[c] = 0u;
        compNormalBucketCount[c] = 0u;
        compPlanePoint0[c] = vec3f(0.0);
        compPlanePoint1[c] = vec3f(0.0);
        compPlanePoint2[c] = vec3f(0.0);
        explicitLineFeature[c] = zeroComponentFeature();
        explicitCornerFeature[c] = zeroComponentFeature();
        explicitSeamFeature[c] = zeroComponentFeature();
        explicitRingFeature[c] = zeroComponentFeature();
        explicitLineDist[c] = 1e9;
        explicitCornerDist[c] = 1e9;
        explicitSeamDist[c] = 1e9;
        explicitRingDist[c] = 1e9;
        compHasRingSample[c] = 0u;
        compLatheMantleCrossCount[c] = 0u;
        for (var j = 0u; j < 3u; j = j + 1u) {
            compNormalSums[c][j] = vec3f(0.0);
            compPointSums[c][j] = vec3f(0.0);
            compPointCounts[c][j] = 0u;
            subQefs[c][j] = QEFData(mat3x3f(), vec3f(0.0), vec3f(0.0), 0u);
        }
    }

    // Per-edge bucket index assigned during collect; used by Stage B projection
    // and (later) Stage C subcomponent vertex splitting. Sentinel 0xffffffffu means
    // "no crossing on this edge".
    var crossingSubcomp: array<u32, 12>;
    for (var e = 0u; e < 12u; e = e + 1u) { crossingSubcomp[e] = 0xffffffffu; }

    // Phase 1 (collect): tally per-component normal buckets, owner pairs, and explicit
    // feature data without yet adding any plane to the QEF. This lets Phase 2 infer the
    // explicit feature locus, after which Phase 3 projects each crossing onto that locus
    // before accumulation in Phase 4.
    for (var e = 0u; e < 12u; e = e + 1u) {
        if (edgeCrossMask[e] == 0u) { continue; }
        let compIdx = edgeComponent[e];
        if (compIdx < 0) { continue; }

        // Use pre-computed crossing data from earlier in this function
        let intersectionPos = crossingPos[e];
        let normal = crossingNormal[e];

        let c = u32(compIdx);
        let sample = crossingMid[e];

        compPointSum[c] = compPointSum[c] + intersectionPos;
        compCrossCount[c] = compCrossCount[c] + 1u;

        if (sample.featureKind == MID_FEATURE_RING) { compHasRingSample[c] = 1u; }
        if (sample.featureKind == MID_FEATURE_NONE && sample.featureNormalCount == MID_LATHE_MANTLE_NORMAL_COUNT) {
            compLatheMantleCrossCount[c] = compLatheMantleCrossCount[c] + 1u;
        }

        let ownerPair = vec2u(sample.featureIdA, sample.featureIdB);
        if (ownerPair.x != 0u || ownerPair.y != 0u) {
            if (compOwnerPairCount[c] == 0u) {
                compOwnerPair0[c] = ownerPair;
                compOwnerPairCount[c] = 1u;
            } else if (compOwnerPairCount[c] == 1u && !ownerPairEqual(compOwnerPair0[c], ownerPair)) {
                compOwnerPair1[c] = ownerPair;
                compOwnerPairCount[c] = 2u;
            }
        }

        let explicitIdsValid =
            select(
                sample.featureIdA != 0u,
                sample.featureIdA != 0u && sample.featureIdB != 0u && sample.featureIdA != sample.featureIdB,
                sample.featureKind == MID_FEATURE_BOOLEAN_SEAM
            );
        let explicitNormalsValid =
            select(
                sample.featureNormalCount == 2u,
                sample.featureNormalCount == 3u,
                sample.featureKind == MID_FEATURE_CORNER
            );
        var explicitProxScale = MDC_FEATURE_PROX_SCALE;
        if (sample.featureKind == MID_FEATURE_CORNER) { explicitProxScale = MDC_CORNER_FEATURE_PROX_SCALE; }
        else if (sample.featureKind == MID_FEATURE_RING) { explicitProxScale = MDC_RING_FEATURE_PROX_SCALE; }
        let explicitOk =
            sample.featureKind != MID_FEATURE_NONE &&
            sample.featureDist <= uniforms.voxelSize * explicitProxScale &&
            explicitIdsValid &&
            explicitNormalsValid &&
            (sample.featureKind != MID_FEATURE_BOOLEAN_SEAM || dot(sample.featureN1, sample.featureN2) < MID_FEATURE_SEAM_COS_THRESH);
        if (explicitOk) {
            if (sample.featureKind == MID_FEATURE_LINE && sample.featureDist < explicitLineDist[c]) {
                explicitLineDist[c] = sample.featureDist;
                explicitLineFeature[c] = ComponentFeature(
                    MID_FEATURE_LINE,
                    sample.featureIdA,
                    sample.featureIdB,
                    sample.featureNormalCount,
                    sample.featurePoint,
                    sample.featureTangent,
                    sample.n,
                    sample.featureN1,
                    vec3f(0.0),
                    vec3f(0.0),
                );
            } else if (sample.featureKind == MID_FEATURE_RING && sample.featureDist < explicitRingDist[c]) {
                explicitRingDist[c] = sample.featureDist;
                explicitRingFeature[c] = ComponentFeature(
                    MID_FEATURE_RING,
                    sample.featureIdA,
                    sample.featureIdB,
                    sample.featureNormalCount,
                    sample.featurePoint,
                    sample.featureTangent,
                    sample.n,
                    sample.featureN1,
                    vec3f(0.0),
                    sample.featureAxisCenter,
                );
            } else if (sample.featureKind == MID_FEATURE_CORNER && sample.featureDist < explicitCornerDist[c]) {
                explicitCornerDist[c] = sample.featureDist;
                explicitCornerFeature[c] = ComponentFeature(
                    MID_FEATURE_CORNER,
                    sample.featureIdA,
                    sample.featureIdB,
                    sample.featureNormalCount,
                    sample.featurePoint,
                    vec3f(0.0),
                    sample.n,
                    sample.featureN1,
                    sample.featureN2,
                    vec3f(0.0),
                );
            } else if (sample.featureKind == MID_FEATURE_BOOLEAN_SEAM && sample.featureDist < explicitSeamDist[c]) {
                explicitSeamDist[c] = sample.featureDist;
                explicitSeamFeature[c] = ComponentFeature(
                    MID_FEATURE_BOOLEAN_SEAM,
                    sample.featureIdA,
                    sample.featureIdB,
                    sample.featureNormalCount,
                    intersectionPos,
                    vec3f(0.0),
                    sample.featureN1,
                    sample.featureN2,
                    vec3f(0.0),
                    vec3f(0.0),
                );
            }
        }

        var bucket: i32 = -1;
        var bestBucket: i32 = 0;
        var bestDot = -2.0;
        for (var j = 0u; j < compNormalBucketCount[c]; j = j + 1u) {
            let rep = safeUnit3(compNormalSums[c][j]);
            let repDot = dot(rep, normal);
            if (repDot > COMPONENT_NORMAL_COS_THRESH) {
                bucket = i32(j);
                break;
            }
            if (repDot > bestDot) {
                bestDot = repDot;
                bestBucket = i32(j);
            }
        }
        if (bucket < 0) {
            if (compNormalBucketCount[c] < 3u) {
                bucket = i32(compNormalBucketCount[c]);
                compNormalBucketCount[c] = compNormalBucketCount[c] + 1u;
            } else {
                bucket = bestBucket;
            }
        }
        let bucketIdx = u32(bucket);
        crossingSubcomp[e] = bucketIdx;
        compNormalSums[c][bucketIdx] = compNormalSums[c][bucketIdx] + normal;
        compPointSums[c][bucketIdx] = compPointSums[c][bucketIdx] + intersectionPos;
        compPointCounts[c][bucketIdx] = compPointCounts[c][bucketIdx] + 1u;
    }

    // Phase 2 (infer): existing component-level explicit-feature resolution and
    // inferred-feature classification. Reads from Phase 1 collect outputs only.
    for (var c = 0u; c < MAX_COMPONENTS_PER_CELL; c = c + 1u) {
        if (compCrossCount[c] == 0u) { continue; }

        let massPoint = compPointSum[c] / f32(compCrossCount[c]);
        let bucketCount = compNormalBucketCount[c];
        let pairCount = compOwnerPairCount[c];

        var n0 = vec3f(0.0);
        var n1 = vec3f(0.0);
        var n2 = vec3f(0.0);
        var p0 = massPoint;
        var p1 = massPoint;
        var p2 = massPoint;
        if (bucketCount >= 1u && compPointCounts[c][0] > 0u) {
            n0 = safeUnit3(compNormalSums[c][0]);
            p0 = compPointSums[c][0] / f32(compPointCounts[c][0]);
        }
        if (bucketCount >= 2u && compPointCounts[c][1] > 0u) {
            n1 = safeUnit3(compNormalSums[c][1]);
            p1 = compPointSums[c][1] / f32(compPointCounts[c][1]);
        }
        if (bucketCount >= 3u && compPointCounts[c][2] > 0u) {
            n2 = safeUnit3(compNormalSums[c][2]);
            p2 = compPointSums[c][2] / f32(compPointCounts[c][2]);
        }
        compPlanePoint0[c] = p0;
        compPlanePoint1[c] = p1;
        compPlanePoint2[c] = p2;

        if (explicitCornerDist[c] >= 1e8 && bucketCount >= 3u) {
            var probePos = clamp(solveFeaturePoint(n0, p0, n1, p1, n2, p2, 3u), cellMin, cellMax);
            var probeSdf = sceneSDF_mid(probePos);
            for (var probeIter = 0u; probeIter < 4u; probeIter = probeIter + 1u) {
                let d = probeSdf.d - uniforms.isoValue;
                if (abs(d) < uniforms.voxelSize * uniforms.mdcF1.z) { break; }
                let maxStep = uniforms.voxelSize * 0.4;
                let clampedStep = clamp(d, -maxStep, maxStep);
                probePos = clamp(probePos - probeSdf.n * clampedStep, cellMin, cellMax);
                probeSdf = sceneSDF_mid(probePos);
            }
            let probeCornerOk =
                probeSdf.featureKind == MID_FEATURE_CORNER &&
                probeSdf.featureIdA != 0u &&
                probeSdf.featureNormalCount == 3u &&
                probeSdf.featureDist <= uniforms.voxelSize * MDC_CORNER_PROBE_PROX_SCALE;
            if (probeCornerOk) {
                explicitCornerDist[c] = probeSdf.featureDist;
                explicitCornerFeature[c] = ComponentFeature(
                    MID_FEATURE_CORNER,
                    probeSdf.featureIdA,
                    probeSdf.featureIdB,
                    probeSdf.featureNormalCount,
                    probeSdf.featurePoint,
                    vec3f(0.0),
                    probeSdf.n,
                    probeSdf.featureN1,
                    probeSdf.featureN2,
                    vec3f(0.0),
                );
            }
        }

        // LINE probe: when no Hermite sample on a cube edge classified as LINE
        // (e.g. a helical sharp edge from a twisted polygon threads diagonally
        // across the cube interior without crossing a cube edge near a polygon
        // vertex, so the polygon-vertex test in `Extrude.compileMid` never
        // fires on a Hermite sample), sample `sceneSDF_mid` at the 2-plane
        // intersection — geometrically where the sharp edge lives in this
        // cell — and accept any LINE classification the SDF reports.
        // Operator-agnostic: we don't ask what kind of curve; we trust the
        // SDF's local LINE classification at the probe.
        //
        // Requires bucketCount >= 2 with a sharp-enough dot: with only one
        // bucket we can't form an intersection line. Newton-stepping to the
        // surface is intentionally NOT done — it would push the probe
        // perpendicular to ∇SDF toward whichever face is nearest, which on a
        // curved sharp edge lands on a side face where the operator-level
        // LINE classifier (e.g. polygon-vertex `tt < 1e-4`) doesn't fire.
        if (
            explicitLineDist[c] >= 1e8 &&
            explicitCornerDist[c] >= 1e8 &&
            explicitRingDist[c] >= 1e8 &&
            bucketCount >= 2u &&
            dot(n0, n1) < MDC_INFER_LINE_DOT_MAX
        ) {
            let probePos = clamp(solveFeaturePoint(n0, p0, n1, p1, vec3f(0.0), vec3f(0.0), 2u), cellMin, cellMax);
            let probeSdf = sceneSDF_mid(probePos);
            let probeLineOk =
                probeSdf.featureKind == MID_FEATURE_LINE &&
                probeSdf.featureIdA != 0u &&
                probeSdf.featureNormalCount == 2u &&
                probeSdf.featureDist <= uniforms.voxelSize * MDC_LINE_PROBE_PROX_SCALE;
            if (probeLineOk) {
                explicitLineDist[c] = probeSdf.featureDist;
                explicitLineFeature[c] = ComponentFeature(
                    MID_FEATURE_LINE,
                    probeSdf.featureIdA,
                    probeSdf.featureIdB,
                    probeSdf.featureNormalCount,
                    probeSdf.featurePoint,
                    probeSdf.featureTangent,
                    probeSdf.n,
                    probeSdf.featureN1,
                    vec3f(0.0),
                    vec3f(0.0),
                );
            }
        }

        let seamEligible =
            pairCount >= 2u &&
            compOwnerPair0[c].x == compOwnerPair0[c].y &&
            compOwnerPair1[c].x == compOwnerPair1[c].y &&
            compOwnerPair0[c].x != compOwnerPair1[c].x;

        var inferred = zeroComponentFeature();
        if (explicitCornerDist[c] < 1e8) {
            inferred = explicitCornerFeature[c];
        } else if (explicitRingDist[c] < 1e8) {
            // RING is a closed circular crease (e.g. lathe ring); it carries
            // strictly more information than a generic LINE so it wins when
            // both are present at the same cell-component.
            inferred = explicitRingFeature[c];
        } else if (explicitLineDist[c] < 1e8) {
            inferred = explicitLineFeature[c];
        } else if (explicitSeamDist[c] < 1e8) {
            inferred = explicitSeamFeature[c];
        } else if (seamEligible && bucketCount >= 2u) {
            let tangent = safeUnit3(cross(n0, n1));
            if (lengthSqr(tangent) > 1e-8) {
                let owners = orderedOwnerPair(compOwnerPair0[c].x, compOwnerPair1[c].x);
                inferred = ComponentFeature(
                    MID_FEATURE_BOOLEAN_SEAM,
                    owners.x,
                    owners.y,
                    2u,
                    solveFeaturePoint(n0, p0, n1, p1, tangent, massPoint, 3u),
                    tangent,
                    n0,
                    n1,
                    vec3f(0.0),
                    vec3f(0.0),
                );
            } else {
                inferred = ComponentFeature(
                    COMPONENT_FEATURE_REJECTED,
                    compOwnerPair0[c].x,
                    compOwnerPair1[c].x,
                    2u,
                    massPoint,
                    vec3f(0.0),
                    n0,
                    n1,
                    vec3f(0.0),
                    vec3f(0.0),
                );
            }
        } else if (
            compHasRingSample[c] == 0u &&
            compLatheMantleCrossCount[c] != compCrossCount[c] &&
            bucketCount == 2u &&
            dot(n0, n1) < MDC_INFER_LINE_DOT_MAX &&
            compPointCounts[c][0] >= MDC_INFER_LINE_MIN_BUCKET_SAMPLES &&
            compPointCounts[c][1] >= MDC_INFER_LINE_MIN_BUCKET_SAMPLES &&
            // Bucket coherence: sum length / sample count.  ~1.0 = a flat face,
            // < 0.95 = the bucket spans an arc (smooth swept surface, not a real
            // crease).  This is what ultimately suppresses the sporadic ghost
            // LINE glyphs scattered around lathe smooth sections at small radii.
            length(compNormalSums[c][0]) >= MDC_INFER_LINE_BUCKET_COHERENCE * f32(compPointCounts[c][0]) &&
            length(compNormalSums[c][1]) >= MDC_INFER_LINE_BUCKET_COHERENCE * f32(compPointCounts[c][1])
        ) {
            let tangent = safeUnit3(cross(n0, n1));
            if (lengthSqr(tangent) > 1e-8) {
                inferred = ComponentFeature(
                    MID_FEATURE_LINE,
                    compOwnerPair0[c].x,
                    compOwnerPair0[c].y,
                    2u,
                    solveFeaturePoint(n0, p0, n1, p1, tangent, massPoint, 3u),
                    tangent,
                    n0,
                    n1,
                    vec3f(0.0),
                    vec3f(0.0),
                );
            } else {
                inferred = ComponentFeature(
                    COMPONENT_FEATURE_REJECTED,
                    compOwnerPair0[c].x,
                    compOwnerPair0[c].y,
                    2u,
                    massPoint,
                    vec3f(0.0),
                    n0,
                    n1,
                    vec3f(0.0),
                    vec3f(0.0),
                );
            }
        }
        inferredFeatures[c] = inferred;
    }

    let featureConstraintsEnabled = uniforms.mdcU0.w != 0u;

    // Collapse every component to a single sub-vertex (subcomp 0).
    //
    // Stage C's per-bucket sub-vertex splitting was designed to give creases
    // real geometric edges by emitting one vertex per face bucket within a
    // component. In practice that needs neighbor cells to agree on which
    // bucket index represents "face A" for every shared cube edge.
    //
    // - Non-explicit / inferred / smooth components have no canonical face-
    //   normal source, so neighbor agreement on bucket index is impossible.
    // - Explicit features (LINE / RING / CORNER / SEAM) DO have canonical face
    //   normals, but for revolution features (rings) they're computed from each
    //   cell's local `radDir`. Tiny per-cell numerical differences flip the
    //   `dot(normal, f.n_s)` winner between neighbors, so two cells around the
    //   same cube edge can pick different sub-buckets. Pass 5 then references
    //   different cell sub-vertices for the same shared edge and the dual
    //   triangles fail to share an edge — visible as missing triangles right
    //   along the ring crease.
    //
    // With `featureConstrainedPlacement` enabled, every cell's vertex (across
    // all sub-components) snaps to the same explicit feature locus anyway, so
    // multi-bucket sub-vertices would collapse to coincident positions even
    // when bucket indices DID agree. Collapsing to a single sub-vertex keeps
    // the dual mesh manifold; the crease split CPU post-pass still recreates
    // sharp shading at the geometric crease via per-face-group normals.
    for (var c = 0u; c < MAX_COMPONENTS_PER_CELL; c = c + 1u) {
        if (compCrossCount[c] == 0u) { continue; }
        for (var e = 0u; e < 12u; e = e + 1u) {
            if (edgeCrossMask[e] == 0u) { continue; }
            if (edgeComponent[e] != i32(c)) { continue; }
            crossingSubcomp[e] = 0u;
        }
    }

    // Now that subcomponent assignment is canonical, write the packed
    // (componentIdx, subcomponentIdx) per cube edge so Pass 5 can resolve the
    // correct sub-vertex per neighbor cell.
    for (var e = 0u; e < 12u; e = e + 1u) {
        if (edgeCompBase + e >= arrayLength(&cellEdgeComponents)) { continue; }
        var packed = 0xffffffffu;
        let cIdx = edgeComponent[e];
        let s = crossingSubcomp[e];
        if (cIdx >= 0 && s != 0xffffffffu) {
            packed = packCompSub(u32(cIdx), s);
        }
        cellEdgeComponents[edgeCompBase + e] = packed;
    }

    // Phase 3 (project) + Phase 4 (accumulate): project crossings onto the
    // explicit feature locus when present, then add the (possibly projected)
    // crossing plane to the per-component QEF.
    //
    // For explicit feature loci, projection is all-or-none per component.
    // Mixing projected crossings with raw surface crossings builds an
    // inconsistent QEF and can add flat bands or divots near the crease.
    var lineQefProjection: array<bool, 4>;
    var ringQefCircleProjection: array<bool, 4>;
    for (var c = 0u; c < MAX_COMPONENTS_PER_CELL; c = c + 1u) {
        lineQefProjection[c] = false;
        ringQefCircleProjection[c] = false;
        if (compCrossCount[c] == 0u) { continue; }
        let feature = inferredFeatures[c];
        if (featureConstraintsEnabled && feature.kind == MID_FEATURE_LINE && explicitLineDist[c] < 1e8) {
            // Measure the projection gap with the same curve-following iteration
            // that Phase 3 will use. Crossings whose own local sample classifies
            // as LINE land on the curve and contribute zero gap; crossings whose
            // sample falls off the LINE feature locus return `intersectionPos`
            // unchanged and likewise contribute zero gap. Cells where every
            // crossing fails to attach to the curve still see the projection
            // disabled (so the soft feature-plane bias takes over), but cells
            // whose crossings *can* attach are no longer mis-rejected because
            // the static tangent line was a poor approximation of the curve.
            var maxLineGap = 0.0;
            var refinedAny = false;
            for (var e = 0u; e < 12u; e = e + 1u) {
                if (edgeCrossMask[e] == 0u) { continue; }
                if (edgeComponent[e] != i32(c)) { continue; }
                let onCurve = mdcLineFeatureFollow(crossingPos[e]);
                let gap = length(crossingPos[e] - onCurve);
                if (gap > 0.0) { refinedAny = true; }
                maxLineGap = max(maxLineGap, gap);
            }
            lineQefProjection[c] = refinedAny && maxLineGap <= uniforms.voxelSize * MDC_LINE_QEF_PROJECT_SCALE;
        }
        if (!(featureConstraintsEnabled && feature.kind == MID_FEATURE_RING && explicitRingDist[c] < 1e8)) {
            continue;
        }

        var maxRingGap = 0.0;
        for (var e = 0u; e < 12u; e = e + 1u) {
            if (edgeCrossMask[e] == 0u) { continue; }
            if (edgeComponent[e] != i32(c)) { continue; }
            let onRing = mdcClosestPointOnRingFeature(explicitRingFeature[c], crossingPos[e]);
            maxRingGap = max(maxRingGap, length(crossingPos[e] - onRing));
        }
        ringQefCircleProjection[c] = maxRingGap <= uniforms.voxelSize * MDC_RING_QEF_PROJECT_SCALE;
    }

    var projectedPos: array<vec3f, 12>;
    for (var e = 0u; e < 12u; e = e + 1u) {
        if (edgeCrossMask[e] == 0u) { continue; }
        let compIdx = edgeComponent[e];
        if (compIdx < 0) { continue; }
        let c = u32(compIdx);
        let intersectionPos = crossingPos[e];
        let normal = crossingNormal[e];
        let feature = inferredFeatures[c];

        let projPos = mdcFeatureProjectCrossingPosition(
            intersectionPos,
            feature,
            explicitRingFeature[c],
            featureConstraintsEnabled,
            explicitLineDist[c],
            explicitRingDist[c],
            explicitCornerDist[c],
            explicitSeamDist[c],
            lineQefProjection[c],
            ringQefCircleProjection[c],
        );
        projectedPos[e] = projPos;

        let s = crossingSubcomp[e];
        subQefs[c][s].ATA[0] = subQefs[c][s].ATA[0] + normal * normal.x;
        subQefs[c][s].ATA[1] = subQefs[c][s].ATA[1] + normal * normal.y;
        subQefs[c][s].ATA[2] = subQefs[c][s].ATA[2] + normal * normal.z;
        let d_val = dot(normal, projPos);
        subQefs[c][s].ATb = subQefs[c][s].ATb + normal * d_val;
        subQefs[c][s].massPoint = subQefs[c][s].massPoint + projPos;
        subQefs[c][s].numPoints = subQefs[c][s].numPoints + 1u;
    }

    // For inferred (non-explicit) features the soft feature-plane bias nudges
    // the QEF toward the inferred locus. We *also* apply it to explicit-LINE
    // cells where Phase 3 projection was disabled (gap test failed): without
    // it those cells get no curve constraint at all and the QEF wanders into
    // visible chips along curved sharp edges (helices from twist, arcs from
    // bend, etc.).
    for (var c = 0u; c < MAX_COMPONENTS_PER_CELL; c = c + 1u) {
        if (compCrossCount[c] == 0u) { continue; }
        let feature = inferredFeatures[c];
        let isExplicitLine = featureConstraintsEnabled && (feature.kind == MID_FEATURE_LINE) && (explicitLineDist[c] < 1e8);
        let isExplicitCorner = featureConstraintsEnabled && (feature.kind == MID_FEATURE_CORNER) && (explicitCornerDist[c] < 1e8);
        let isExplicitSeam = featureConstraintsEnabled && (feature.kind == MID_FEATURE_BOOLEAN_SEAM) && (explicitSeamDist[c] < 1e8);
        let lineNeedsBias = (feature.kind == MID_FEATURE_LINE) && !lineQefProjection[c];
        for (var s = 0u; s < MAX_SUBCOMPONENTS_PER_COMPONENT; s = s + 1u) {
            if (subQefs[c][s].numPoints == 0u) { continue; }
            if (lineNeedsBias) {
                mdcQefAddPlane(&subQefs[c][s], feature.n0, compPlanePoint0[c], MDC_FEATURE_PLANE_WEIGHT);
                mdcQefAddPlane(&subQefs[c][s], feature.n1, compPlanePoint1[c], MDC_FEATURE_PLANE_WEIGHT);
                atomicAdd(&debugSkipCounters[13], 2u);
            } else if (feature.kind == MID_FEATURE_CORNER && !isExplicitCorner) {
                mdcQefAddPlane(&subQefs[c][s], feature.n0, compPlanePoint0[c], MDC_FEATURE_PLANE_WEIGHT);
                mdcQefAddPlane(&subQefs[c][s], feature.n1, compPlanePoint1[c], MDC_FEATURE_PLANE_WEIGHT);
                mdcQefAddPlane(&subQefs[c][s], feature.n2, compPlanePoint2[c], MDC_FEATURE_PLANE_WEIGHT);
                atomicAdd(&debugSkipCounters[13], 3u);
            } else if (feature.kind == MID_FEATURE_BOOLEAN_SEAM && !isExplicitSeam) {
                mdcQefAddPlane(&subQefs[c][s], feature.n0, compPlanePoint0[c], MDC_FEATURE_PLANE_WEIGHT);
                mdcQefAddPlane(&subQefs[c][s], feature.n1, compPlanePoint1[c], MDC_FEATURE_PLANE_WEIGHT);
                atomicAdd(&debugSkipCounters[13], 2u);
            }
        }
    }

    for (var e = 0u; e < 12u; e = e + 1u) {
        if (edgeCrossMask[e] == 0u) { continue; }
        let compIdx = edgeComponent[e];
        if (compIdx < 0) { continue; }
        let c = u32(compIdx);
        let intersectionPos = crossingPos[e];
        let normal = crossingNormal[e];
        let feature = inferredFeatures[c];
        let featurePoint = select(intersectionPos, feature.point, length(feature.point) > 1e-6);
        var debugClass = f32(feature.kind);

        if (feature.kind == MID_FEATURE_LINE) {
            atomicAdd(&debugSkipCounters[9], 1u);
        } else if (feature.kind == MID_FEATURE_CORNER) {
            atomicAdd(&debugSkipCounters[10], 1u);
        } else if (feature.kind == MID_FEATURE_BOOLEAN_SEAM) {
            atomicAdd(&debugSkipCounters[11], 1u);
        } else if (feature.kind == MID_FEATURE_RING) {
            atomicAdd(&debugSkipCounters[14], 1u);
        } else if (feature.kind == COMPONENT_FEATURE_REJECTED) {
            atomicAdd(&debugSkipCounters[12], 1u);
        } else {
            atomicAdd(&debugSkipCounters[8], 1u);
            debugClass = 0.0;
        }

        let debugIdx = atomicAdd(&debugEdgeSampleCount, 1u);
        if (debugIdx < arrayLength(&debugEdgeSamples)) {
            // For RING the per-component axisCenter recorded in the
            // ComponentFeature lets the viewer reconstruct the full circle;
            // other kinds leave it zero.
            let axisCenter = select(
                vec3f(0.0),
                feature.axisCenter,
                feature.kind == MID_FEATURE_RING,
            );
            debugEdgeSamples[debugIdx] = EdgeDebugSample(
                vec4f(intersectionPos, debugClass),
                vec4f(normal, f32(feature.normalCount)),
                vec4f(featurePoint, length(intersectionPos - featurePoint)),
                vec4f(feature.n0, f32(feature.ownerA)),
                vec4f(select(vec3f(0.0), feature.n1, feature.normalCount >= 2u), f32(feature.ownerB)),
                vec4f(axisCenter, 0.0),
            );
        }
    }

    // Write per-subcomponent QEFs (one slot per face bucket) and per-component
    // inferred features for this active cell. componentFeatures stays per
    // component (one entry per cell-component, not per sub-vertex).
    //
    // All components were collapsed to subcomp 0 above, so feature.n0 is the
    // shading normal for that single sub-vertex. Use the bucket-averaged
    // direction across ALL physical buckets so soft chamfers and explicit
    // features alike pick a normal that represents the surface at this cell
    // without picking one side arbitrarily. The crease split CPU post-pass
    // then re-derives per-face-group normals from triangle face normals so
    // sharp shading creases are recreated even though the GPU only stores one
    // averaged normal per cell vertex.
    let compBase = active_cell_array_idx * MAX_COMPONENTS_PER_CELL;
    let vertBase = active_cell_array_idx * VERTICES_PER_CELL;
    for (var c = 0u; c < MAX_COMPONENTS_PER_CELL; c = c + 1u) {
        var cf = inferredFeatures[c];
        var nSum = vec3f(0.0);
        for (var b = 0u; b < 3u; b = b + 1u) {
            if (b < compNormalBucketCount[c] && compPointCounts[c][b] > 0u) {
                nSum = nSum + compNormalSums[c][b];
            }
        }
        cf.n0 = safeUnit3(nSum);
        cf.n1 = vec3f(0.0);
        cf.n2 = vec3f(0.0);
        let cFeatIdx = compBase + c;
        if (cFeatIdx < arrayLength(&componentFeatures)) {
            componentFeatures[cFeatIdx] = cf;
        }
        for (var s = 0u; s < MAX_SUBCOMPONENTS_PER_COMPONENT; s = s + 1u) {
            let outIdx = vertBase + c * MAX_SUBCOMPONENTS_PER_COMPONENT + s;
            if (outIdx < arrayLength(&cellQEFData_edge)) {
                cellQEFData_edge[outIdx] = subQefs[c][s];
            }
        }
    }
}


// Pass 4: Vertex Generation
//
// Stage C: each active cell now produces up to VERTICES_PER_CELL = 12 sub-vertices
// (MAX_COMPONENTS_PER_CELL * MAX_SUBCOMPONENTS_PER_COMPONENT). Smooth components
// fill only subcomp 0; crease components fill 2-3 subcomps, one per face bucket,
// each with that bucket's average normal. Empty subcomp slots are written as
// sentinel vertices that no quad ever references (since cellEdgeComponents only
// points at populated buckets).
@compute @workgroup_size(64, 1, 1)
fn vertexGeneration_Pass4(
    @builtin(local_invocation_id) localId: vec3u,
    @builtin(workgroup_id) workgroupId: vec3u,
    @builtin(num_workgroups) numWg: vec3u
) {
    let wgLinear = workgroupId.x + workgroupId.y * numWg.x + workgroupId.z * numWg.x * numWg.y;

    // Check cancellation but don't return early (to maintain uniform control flow)
    let cancelled = isCancelled();
    let vertexRecordIdx = wgLinear * 64u + localId.x;
    let totalActiveCells = uniforms.mdcU0.z;
    let totalVertexRecords = totalActiveCells * VERTICES_PER_CELL;
    if (cancelled || vertexRecordIdx >= totalVertexRecords) { return; }
    if (vertexRecordIdx >= arrayLength(&cellQEFDataIn_vertex) || vertexRecordIdx >= arrayLength(&vertices)) { return; }

    let active_cell_array_idx = vertexRecordIdx / VERTICES_PER_CELL;
    let withinCell = vertexRecordIdx % VERTICES_PER_CELL;
    let componentIdx = withinCell / MAX_SUBCOMPONENTS_PER_COMPONENT;
    let subcomponentIdx = withinCell % MAX_SUBCOMPONENTS_PER_COMPONENT;

    let qef = cellQEFDataIn_vertex[vertexRecordIdx];

    // Empty subcomp slot: write sentinel vertex (never referenced from indices).
    if (qef.numPoints == 0u) {
        vertices[vertexRecordIdx] = Vertex(vec3f(0.0), vec3f(0.0, 1.0, 0.0));
        return;
    }

    if (active_cell_array_idx >= arrayLength(&activeCellIndicesIn_vertex)) { return; }
    let cellFlatIndex = activeCellIndicesIn_vertex[active_cell_array_idx];
    let cellPos = gridIndexTo3D(cellFlatIndex);
    let cellMin = gridPosToWorldPos(cellPos);
    let cellMax = cellMin + vec3f(uniforms.voxelSize);

    // Robust in-cell candidate selection (per-subcomp QEF):
    // Hard-clamping a drifting QEF solution can create spikes/pinholes near sharp features
    // and CSG seams. Choose among stable candidates using the full QEF cost.
    let mp = qef.massPoint / max(1.0, f32(qef.numPoints));
    let vUnclamped = solveQEF(qef);
    let vClamped = clamp(vUnclamped, cellMin, cellMax);
    let vMp = clamp(mp, cellMin, cellMax);
    let vCenter = (cellMin + cellMax) * 0.5;

    var best = vClamped;
    var bestCost = qefCost(qef, vClamped);

    let cMp = qefCost(qef, vMp);
    if (cMp < bestCost) { bestCost = cMp; best = vMp; }

    let cC = qefCost(qef, vCenter);
    if (cC < bestCost) { bestCost = cC; best = vCenter; }

    var vertexPos = best;

    let cFeatIdx = active_cell_array_idx * MAX_COMPONENTS_PER_CELL + componentIdx;
    let featureStart = componentFeatures[cFeatIdx];
    let featureConstraintsEnabled = uniforms.mdcU0.w != 0u;
    let isExplicit = featureConstraintsEnabled &&
        (featureStart.kind == MID_FEATURE_LINE
            || featureStart.kind == MID_FEATURE_RING
            || featureStart.kind == MID_FEATURE_CORNER
            || featureStart.kind == MID_FEATURE_BOOLEAN_SEAM) &&
        featureStart.ownerA != 0u &&
        featureStart.normalCount >= 2u;
    var snappedToFeature = false;

    // Snap modes:
    //  - line:   project onto a straight tangent line through featureStart.point
    //            (LINE / SEAM, and degenerate RING).
    //  - ring:   project onto the actual circle (axisCenter + axis + radius).
    //  - corner: snap to the single feature point.
    var snappedToLine = false;
    var snappedToRing = false;
    var lineTangent = vec3f(0.0);
    var ringRadius = 0.0;
    var ringAxis = vec3f(0.0, 1.0, 0.0);
    if (isExplicit) {
        var featureTarget = featureStart.point;
        if (featureStart.kind == MID_FEATURE_RING) {
            // Build the ring frame from the stored anchor + axisCenter + tangent.
            // axis = unit(cross(tangent, radial)) — the axis of revolution.
            // Project the QEF best onto the ring (plane perpendicular to axis through
            // axisCenter, scaled to radius) instead of onto the local tangent line:
            // the latter degrades for cells that don't sit exactly under the anchor
            // and can pull the sub-vertex off the surface.
            let radial = featureStart.point - featureStart.axisCenter;
            ringRadius = length(radial);
            var ringFrameBuilt = false;
            if (ringRadius > 1e-8 && length(featureStart.tangent) > 1e-6) {
                let tang = safeUnit3(featureStart.tangent);
                let axisRaw = cross(tang, radial);
                if (lengthSqr(axisRaw) > 1e-12) {
                    ringAxis = safeUnit3(axisRaw);
                    ringFrameBuilt = true;
                    // Use unconstrained QEF winner (`best`) — not a prior vertexPos edit.
                    let toBest = best - featureStart.axisCenter;
                    let inPlaneBest = toBest - ringAxis * dot(toBest, ringAxis);
                    let inPlaneBestLen = length(inPlaneBest);
                    if (inPlaneBestLen > 1e-8) {
                        featureTarget = featureStart.axisCenter + inPlaneBest * (ringRadius / inPlaneBestLen);
                    } else {
                        featureTarget = featureStart.point;
                    }
                    snappedToRing = true;
                }
            }
            if (!snappedToRing && length(featureStart.tangent) > 1e-6 && !ringFrameBuilt) {
                // Degenerate ring geometry only — never tangent-fallback when we built a
                // ring frame but refused snap (distance): that would still relocate mantle vertices.
                lineTangent = safeUnit3(featureStart.tangent);
                featureTarget = featureStart.point + lineTangent * dot(vertexPos - featureStart.point, lineTangent);
                snappedToLine = true;
            }
        } else if (featureStart.kind == MID_FEATURE_LINE
                || featureStart.kind == MID_FEATURE_BOOLEAN_SEAM) {
            lineTangent = featureLineTangent(featureStart);
            if (lengthSqr(lineTangent) > 1e-8) {
                featureTarget = featureStart.point + lineTangent * dot(vertexPos - featureStart.point, lineTangent);
                snappedToLine = true;
            }
        } else if (featureStart.kind == MID_FEATURE_CORNER) {
            snappedToFeature = true;
        }
        if (snappedToLine || snappedToRing || snappedToFeature) {
            if (snappedToRing) {
                vertexPos = clampRingFeatureVertex(featureTarget, cellMin, cellMax);
            } else {
                vertexPos = clampFeatureVertex(featureTarget, cellMin, cellMax);
            }
            snappedToFeature = true;
        }
    }

    // Iso-projection.
    //
    // - Corner snap (single point feature): skip entirely — the corner IS on the
    //   iso-surface by construction, and the analytic normal at a corner is
    //   multi-valued so a gradient step would chatter.
    //
    // - Ring snap: alternate iso-projection with circle re-projection so the
    //   vertex converges to the curve-vs-iso intersection (the actual ring-
    //   crease point) rather than chattering off the circle.
    //
    // - Line/seam snap: the snap above projected onto a *straight* tangent line
    //   through featureStart.point. For straight crease features that line is the
    //   actual surface intersection so iso-projection is a no-op. For curved
    //   crease features (twisted-extrude helical side) the local tangent
    //   linearizes the curve; alternate iso-step + tangent-re-snap converges.
    //
    // - No snap: full iso-projection as before.
    if (!snappedToFeature) {
        for (var iter = 0u; iter < uniforms.mdcU0.y; iter = iter + 1u) {
            let sdfResult = sceneSDF_mid(vertexPos);
            let d = sdfResult.d - uniforms.isoValue;
            if (abs(d) < uniforms.voxelSize * uniforms.mdcF1.w) {
                break;
            }
            let n = sdfResult.n;
            let gradScale = max(1.0, sdfResult.g);
            let correctedD = d / gradScale;

            var projected = vertexPos - n * correctedD;
            let margin = uniforms.voxelSize * uniforms.mdcF2.x;
            let relaxedMin = cellMin - vec3f(margin);
            let relaxedMax = cellMax + vec3f(margin);
            projected = clamp(projected, relaxedMin, relaxedMax);
            let step = projected - vertexPos;
            let stepLen = length(step);
            let baseMaxStep = uniforms.voxelSize * uniforms.mdcF2.y;
            let maxStep = baseMaxStep * select(1.0, 0.5, sdfResult.g < 0.8);
            if (stepLen > maxStep) {
                vertexPos = vertexPos + step * (maxStep / stepLen);
            } else {
                vertexPos = projected;
            }
            vertexPos = clamp(vertexPos, cellMin, cellMax);
        }
    } else if (snappedToRing) {
        for (var iter = 0u; iter < 4u; iter = iter + 1u) {
            let sdfResult = sceneSDF_mid(vertexPos);
            let d = sdfResult.d - uniforms.isoValue;
            if (abs(d) < uniforms.voxelSize * uniforms.mdcF1.w) { break; }
            let n = sdfResult.n;
            let gradScale = max(1.0, sdfResult.g);
            let stepSize = clamp(d / gradScale, -uniforms.voxelSize * 0.4, uniforms.voxelSize * 0.4);
            vertexPos = vertexPos - n * stepSize;
            // Re-project onto the circle.
            let toV = vertexPos - featureStart.axisCenter;
            let inPlane = toV - ringAxis * dot(toV, ringAxis);
            let inPlaneLen = length(inPlane);
            if (inPlaneLen > 1e-8) {
                vertexPos = featureStart.axisCenter + inPlane * (ringRadius / inPlaneLen);
            }
            vertexPos = clampRingFeatureVertex(vertexPos, cellMin, cellMax);
        }
    } else if (snappedToLine) {
        for (var iter = 0u; iter < 4u; iter = iter + 1u) {
            let sdfResult = sceneSDF_mid(vertexPos);
            let d = sdfResult.d - uniforms.isoValue;
            if (abs(d) < uniforms.voxelSize * uniforms.mdcF1.w) { break; }
            let n = sdfResult.n;
            let gradScale = max(1.0, sdfResult.g);
            let stepSize = clamp(d / gradScale, -uniforms.voxelSize * 0.4, uniforms.voxelSize * 0.4);
            vertexPos = vertexPos - n * stepSize;
            vertexPos = featureStart.point + lineTangent * dot(vertexPos - featureStart.point, lineTangent);
            vertexPos = clampFeatureVertex(vertexPos, cellMin, cellMax);
        }
    }

    // Sub-vertex normal: prefer the bucket-aligned face normal stored in
    // componentFeatures.n[subcomp]. This is what makes creases shade with sharp
    // edges — neighboring sub-vertices on the other side of the crease carry the
    // other face's normal. Fall back to the analytic SDF normal when the bucket
    // slot is empty (single-bucket smooth surface should already be subcomp 0).
    var vertexNormal = vec3f(0.0);
    if (subcomponentIdx == 0u) { vertexNormal = featureStart.n0; }
    else if (subcomponentIdx == 1u) { vertexNormal = featureStart.n1; }
    else { vertexNormal = featureStart.n2; }
    if (length(vertexNormal) < 0.001) {
        vertexNormal = sceneSDF_mid(vertexPos).n;
    }
    if (length(vertexNormal) < 0.001) {
        vertexNormal = vec3f(0.0, 1.0, 0.0);
    }

    vertices[vertexRecordIdx] = Vertex(vertexPos, vertexNormal);
}

// --- Triangle Generation Helper Functions (for Pass 5c) ---
fn getEdgeComponent(activeCellIdx: u32, edgeIdx: u32) -> u32 {
    let idx = activeCellIdx * EDGES_PER_CELL + edgeIdx;
    if (idx >= arrayLength(&cellEdgeComponents)) { return 0xffffffffu; }
    return cellEdgeComponents[idx];
}

fn hasEdgeCrossingX(cellPos: vec3u, cornerSDFValues: array<f32, 8>) -> bool {
    let g0 = getCellCornerPos(cellPos, 0u);
    let g1 = getCellCornerPos(cellPos, 1u);
    let p0 = gridPosToWorldPos(g0);
    let p1 = gridPosToWorldPos(g1);
    return edgeCrossesIso(cornerSDFValues[0], p0, cornerSDFValues[1], p1);
}

fn hasEdgeCrossingY(cellPos: vec3u, cornerSDFValues: array<f32, 8>) -> bool {
    let g0 = getCellCornerPos(cellPos, 0u);
    let g1 = getCellCornerPos(cellPos, 2u);
    let p0 = gridPosToWorldPos(g0);
    let p1 = gridPosToWorldPos(g1);
    return edgeCrossesIso(cornerSDFValues[0], p0, cornerSDFValues[2], p1);
}

fn hasEdgeCrossingZ(cellPos: vec3u, cornerSDFValues: array<f32, 8>) -> bool {
    let g0 = getCellCornerPos(cellPos, 0u);
    let g1 = getCellCornerPos(cellPos, 4u);
    let p0 = gridPosToWorldPos(g0);
    let p1 = gridPosToWorldPos(g1);
    return edgeCrossesIso(cornerSDFValues[0], p0, cornerSDFValues[4], p1);
}

fn areFourCellsAroundXEdgeActive(cellPos: vec3u) -> bool {
    if (cellPos.y == 0u || cellPos.z == 0u) { return false; } 
    return isCellActive(cellPos) && 
           isCellActive(cellPos - vec3u(0u, 1u, 0u)) && 
           isCellActive(cellPos - vec3u(0u, 0u, 1u)) && 
           isCellActive(cellPos - vec3u(0u, 1u, 1u));   
}

fn areFourCellsAroundYEdgeActive(cellPos: vec3u) -> bool {
    if (cellPos.x == 0u || cellPos.z == 0u) { return false; }
    return isCellActive(cellPos) && 
           isCellActive(cellPos - vec3u(1u, 0u, 0u)) && 
           isCellActive(cellPos - vec3u(0u, 0u, 1u)) && 
           isCellActive(cellPos - vec3u(1u, 0u, 1u));   
}

fn areFourCellsAroundZEdgeActive(cellPos: vec3u) -> bool {
    if (cellPos.x == 0u || cellPos.y == 0u) { return false; }
    return isCellActive(cellPos) && 
           isCellActive(cellPos - vec3u(1u, 0u, 0u)) && 
           isCellActive(cellPos - vec3u(0u, 1u, 0u)) && 
           isCellActive(cellPos - vec3u(1u, 1u, 0u));   
}

struct TriPair {
    t0: vec3u,
    t1: vec3u,
    valid: u32,
}

fn triArea2(p0: vec3f, p1: vec3f, p2: vec3f) -> f32 {
    let n = cross(p1 - p0, p2 - p0);
    return dot(n, n);
}

fn chooseQuadTris(v0_idx: u32, v1_idx: u32, v2_idx: u32, v3_idx: u32) -> TriPair {
    // Returns 2 triangles for the quad loop (v0 -> v1 -> v3 -> v2), oriented outward,
    // and avoids degenerate triangulations when possible.
    if (v0_idx >= arrayLength(&vertices) || v1_idx >= arrayLength(&vertices) ||
        v2_idx >= arrayLength(&vertices) || v3_idx >= arrayLength(&vertices)) {
        return TriPair(vec3u(), vec3u(), 0u);
    }

    let p0 = vertices[v0_idx].position;
    let p1 = vertices[v1_idx].position;
    let p2 = vertices[v2_idx].position;
    let p3 = vertices[v3_idx].position;

    // Two triangulations:
    // A: (0,1,3) + (0,3,2)   diagonal (0-3)
    // B: (0,1,2) + (1,3,2)   diagonal (1-2)
    let a0 = triArea2(p0, p1, p3);
    let a1 = triArea2(p0, p3, p2);
    let b0 = triArea2(p0, p1, p2);
    let b1 = triArea2(p1, p3, p2);

    let minA = min(a0, a1);
    let minB = min(b0, b1);
    // Always emit a triangulation to keep the surface watertight.
    // Prefer the triangulation with the larger minimum triangle area (more stable).
    let useA = minA >= minB;

    var t0: vec3u;
    var t1: vec3u;
    if (useA) {
        t0 = vec3u(v0_idx, v1_idx, v3_idx);
        t1 = vec3u(v0_idx, v3_idx, v2_idx);
    } else {
        t0 = vec3u(v0_idx, v1_idx, v2_idx);
        t1 = vec3u(v1_idx, v3_idx, v2_idx);
    }

    // Orient both triangles consistently using a per-vertex vote against the
    // analytic outward normals stored in `vertices[].normal` (from
    // `sceneSDF_mid`). Averaging the 4 vertex normals and dotting with the
    // face normal fails at right-angle ring/seam creases where vertex
    // normals from opposite sides cancel out, leaving the legacy SDF probe
    // (unreliable on crease points) to decide. Voting picks the dominant
    // outward direction even when the average is near zero.
    let faceN0 = cross(vertices[t0.y].position - vertices[t0.x].position,
                       vertices[t0.z].position - vertices[t0.x].position);
    if (dot(faceN0, faceN0) > 0.0) {
        var pos: i32 = 0;
        var neg: i32 = 0;
        let n0v = vertices[v0_idx].normal;
        let n1v = vertices[v1_idx].normal;
        let n2v = vertices[v2_idx].normal;
        let n3v = vertices[v3_idx].normal;
        if (dot(n0v, n0v) > 1e-12) {
            if (dot(faceN0, n0v) > 0.0) { pos = pos + 1; } else { neg = neg + 1; }
        }
        if (dot(n1v, n1v) > 1e-12) {
            if (dot(faceN0, n1v) > 0.0) { pos = pos + 1; } else { neg = neg + 1; }
        }
        if (dot(n2v, n2v) > 1e-12) {
            if (dot(faceN0, n2v) > 0.0) { pos = pos + 1; } else { neg = neg + 1; }
        }
        if (dot(n3v, n3v) > 1e-12) {
            if (dot(faceN0, n3v) > 0.0) { pos = pos + 1; } else { neg = neg + 1; }
        }
        var flip = false;
        if (pos + neg > 0) {
            flip = neg > pos;
        } else {
            // Fallback: SDF probe at quad center when no vertex normals are
            // available (all degenerate).
            let center = (p0 + p1 + p2 + p3) * 0.25;
            let nHat = safeUnit3(faceN0);
            let probe = max(uniforms.mdcF3.z, uniforms.voxelSize * uniforms.mdcF3.y);
            let dPlus = sampleSDF(center + nHat * probe) - uniforms.isoValue;
            let dMinus = sampleSDF(center - nHat * probe) - uniforms.isoValue;
            flip = dPlus < dMinus;
        }
        if (flip) {
            t0 = vec3u(t0.x, t0.z, t0.y);
            t1 = vec3u(t1.x, t1.z, t1.y);
        }
    }

    return TriPair(t0, t1, 1u);
}

// Pass 5: Generate triangles using an atomic index counter.
// This avoids prefix-sum limitations for large active cell counts.
@compute @workgroup_size(64, 1, 1)
fn generateTrianglesAtomic_Pass5(
    @builtin(global_invocation_id) globalId: vec3u,
    @builtin(num_workgroups) numWg: vec3u
) {
    // Linearize 2D dispatch for large workgroup counts
    let active_cell_array_idx = globalId.x + globalId.y * (numWg.x * 64u);
    
    // Note: Cancellation buffer not included in Pass 5 to stay within storage buffer limit (10 max)
    // Cancellation is still checked between passes in TypeScript code.
    
    let totalActiveCells = uniforms.mdcU0.z;
    if (active_cell_array_idx >= totalActiveCells) { return; }
    if (active_cell_array_idx >= arrayLength(&activeCellIndicesIn_face)) { return; }

    let cellFlatIndex = activeCellIndicesIn_face[active_cell_array_idx];
    let cellPos = gridIndexTo3D(cellFlatIndex);

    var cornerSDFValues_cell: array<f32, 8>;
    var cornerWorldPos_cell: array<vec3f, 8>;
    for (var i = 0u; i < 8u; i = i + 1u) {
        let cgp = getCellCornerPos(cellPos, i);
        cornerWorldPos_cell[i] = gridPosToWorldPos(cgp);
        cornerSDFValues_cell[i] = sampleSDF(cornerWorldPos_cell[i]);
    }

    // X-edge quad
    if (hasEdgeCrossingX(cellPos, cornerSDFValues_cell) && areFourCellsAroundXEdgeActive(cellPos)) {
        let v0_vert_idx = i32(active_cell_array_idx);
        let v1_vert_idx = activeIndexForCellPos(cellPos - vec3u(0u, 1u, 0u));
        let v2_vert_idx = activeIndexForCellPos(cellPos - vec3u(0u, 0u, 1u));
        let v3_vert_idx = activeIndexForCellPos(cellPos - vec3u(0u, 1u, 1u));

        if (v0_vert_idx < 0 || v1_vert_idx < 0 || v2_vert_idx < 0 || v3_vert_idx < 0) {
            atomicAdd(&debugSkipCounters[0], 1u);
        } else {
            let p0 = getEdgeComponent(u32(v0_vert_idx), 0u);
            let p1 = getEdgeComponent(u32(v1_vert_idx), 1u);
            let p2 = getEdgeComponent(u32(v2_vert_idx), 2u);
            let p3 = getEdgeComponent(u32(v3_vert_idx), 3u);
            if (p0 == 0xffffffffu || p1 == 0xffffffffu || p2 == 0xffffffffu || p3 == 0xffffffffu) {
                atomicAdd(&debugSkipCounters[1], 1u);
            } else {
                let vv0 = vertexIndexFor(u32(v0_vert_idx), unpackComp(p0), unpackSub(p0));
                let vv1 = vertexIndexFor(u32(v1_vert_idx), unpackComp(p1), unpackSub(p1));
                let vv2 = vertexIndexFor(u32(v2_vert_idx), unpackComp(p2), unpackSub(p2));
                let vv3 = vertexIndexFor(u32(v3_vert_idx), unpackComp(p3), unpackSub(p3));
                let tp = chooseQuadTris(vv0, vv1, vv2, vv3);
                if (tp.valid != 0u) {
                    let base = atomicAdd(&indexCount_face, 6u);
                    if (base + 5u < arrayLength(&indices)) {
                        indices[base + 0u] = tp.t0.x;
                        indices[base + 1u] = tp.t0.y;
                        indices[base + 2u] = tp.t0.z;
                        indices[base + 3u] = tp.t1.x;
                        indices[base + 4u] = tp.t1.y;
                        indices[base + 5u] = tp.t1.z;
                    }
                }
            }
        }
    }

    // Y-edge quad
    if (hasEdgeCrossingY(cellPos, cornerSDFValues_cell) && areFourCellsAroundYEdgeActive(cellPos)) {
        let v0_vert_idx = i32(active_cell_array_idx);
        let v1_vert_idx = activeIndexForCellPos(cellPos - vec3u(1u, 0u, 0u));
        let v2_vert_idx = activeIndexForCellPos(cellPos - vec3u(0u, 0u, 1u));
        let v3_vert_idx = activeIndexForCellPos(cellPos - vec3u(1u, 0u, 1u));

        if (v0_vert_idx < 0 || v1_vert_idx < 0 || v2_vert_idx < 0 || v3_vert_idx < 0) {
            atomicAdd(&debugSkipCounters[0], 1u);
        } else {
            let p0 = getEdgeComponent(u32(v0_vert_idx), 4u);
            let p1 = getEdgeComponent(u32(v1_vert_idx), 5u);
            let p2 = getEdgeComponent(u32(v2_vert_idx), 6u);
            let p3 = getEdgeComponent(u32(v3_vert_idx), 7u);
            if (p0 == 0xffffffffu || p1 == 0xffffffffu || p2 == 0xffffffffu || p3 == 0xffffffffu) {
                atomicAdd(&debugSkipCounters[1], 1u);
            } else {
                let vv0 = vertexIndexFor(u32(v0_vert_idx), unpackComp(p0), unpackSub(p0));
                let vv1 = vertexIndexFor(u32(v1_vert_idx), unpackComp(p1), unpackSub(p1));
                let vv2 = vertexIndexFor(u32(v2_vert_idx), unpackComp(p2), unpackSub(p2));
                let vv3 = vertexIndexFor(u32(v3_vert_idx), unpackComp(p3), unpackSub(p3));
                let tp = chooseQuadTris(vv0, vv1, vv2, vv3);
                if (tp.valid != 0u) {
                    let base = atomicAdd(&indexCount_face, 6u);
                    if (base + 5u < arrayLength(&indices)) {
                        indices[base + 0u] = tp.t0.x;
                        indices[base + 1u] = tp.t0.y;
                        indices[base + 2u] = tp.t0.z;
                        indices[base + 3u] = tp.t1.x;
                        indices[base + 4u] = tp.t1.y;
                        indices[base + 5u] = tp.t1.z;
                    }
                }
            }
        }
    }

    // Z-edge quad
    if (hasEdgeCrossingZ(cellPos, cornerSDFValues_cell) && areFourCellsAroundZEdgeActive(cellPos)) {
        let v0_vert_idx = i32(active_cell_array_idx);
        let v1_vert_idx = activeIndexForCellPos(cellPos - vec3u(1u, 0u, 0u));
        let v2_vert_idx = activeIndexForCellPos(cellPos - vec3u(0u, 1u, 0u));
        let v3_vert_idx = activeIndexForCellPos(cellPos - vec3u(1u, 1u, 0u));

        if (v0_vert_idx < 0 || v1_vert_idx < 0 || v2_vert_idx < 0 || v3_vert_idx < 0) {
            atomicAdd(&debugSkipCounters[0], 1u);
        } else {
            let p0 = getEdgeComponent(u32(v0_vert_idx), 8u);
            let p1 = getEdgeComponent(u32(v1_vert_idx), 9u);
            let p2 = getEdgeComponent(u32(v2_vert_idx), 10u);
            let p3 = getEdgeComponent(u32(v3_vert_idx), 11u);
            if (p0 == 0xffffffffu || p1 == 0xffffffffu || p2 == 0xffffffffu || p3 == 0xffffffffu) {
                atomicAdd(&debugSkipCounters[1], 1u);
            } else {
                let vv0 = vertexIndexFor(u32(v0_vert_idx), unpackComp(p0), unpackSub(p0));
                let vv1 = vertexIndexFor(u32(v1_vert_idx), unpackComp(p1), unpackSub(p1));
                let vv2 = vertexIndexFor(u32(v2_vert_idx), unpackComp(p2), unpackSub(p2));
                let vv3 = vertexIndexFor(u32(v3_vert_idx), unpackComp(p3), unpackSub(p3));
                let tp = chooseQuadTris(vv0, vv1, vv2, vv3);
                if (tp.valid != 0u) {
                    let base = atomicAdd(&indexCount_face, 6u);
                    if (base + 5u < arrayLength(&indices)) {
                        indices[base + 0u] = tp.t0.x;
                        indices[base + 1u] = tp.t0.y;
                        indices[base + 2u] = tp.t0.z;
                        indices[base + 3u] = tp.t1.x;
                        indices[base + 4u] = tp.t1.y;
                        indices[base + 5u] = tp.t1.z;
                    }
                }
            }
        }
    }
}

