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
    // mdcU0: x=edgeProjIters, y=vertexProjIters, z=reserved, w=reserved
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

// ============================== MDC CONSTANTS ==============================
// "Proper" Manifold Dual Contouring requires multiple vertices per cell
// (one per connected surface component within the cell).
//
// Practical bound: for a single isosurface in a cube, you rarely need >4
// components. We allocate a fixed maximum for simplicity and GPU-friendly
// memory layout.
const MAX_COMPONENTS_PER_CELL: u32 = 4u;
const EDGES_PER_CELL: u32 = 12u;

// ============================== BIND GROUPS ==============================

// Group 0: Shared parameters across all passes
@group(0) @binding(0) var<uniform> uniforms: SharedUniforms;

// Dummy selection array (boolean array indexed by object ID, required for binding compatibility)
@group(0) @binding(99) var<storage, read> selectedObjectIds: array<u32, 1024>;

// Subtree AABBs for spatial culling (required by hg_sdf.wgsl subtreeAABBDist).
@group(0) @binding(26) var<uniform> subtreeAABBs: array<SubtreeAABB, 128>;

// Pass 1: Cell Classification
@group(0) @binding(1) var<storage, read_write> activeCellFlags: array<u32>; // Bit-packed flags

// Pass 2: Active Cell Compaction
// Pass 2a (Count) uses activeCellFlagsIn_compaction, writes counts to activeCellIndices_compaction
// Pass 2b (Prefix Sum Workgroup) reads counts from activeCellIndices_compaction, writes partial sums and workgroup totals to activeCellIndices_compaction
// Pass 2c (Add Offsets) reads partial sums and workgroup totals from activeCellIndices_compaction, writes exclusive prefix sums to activeCellIndices_compaction
// Pass 2d (Expand) reads activeCellFlagsIn_compaction and exclusive prefix sums from activeCellIndices_compaction, writes expanded cell indices to activeCellIndices_compaction, writes total activeCellCount_compaction
@group(0) @binding(2) var<storage, read> activeCellFlagsIn_compaction: array<u32>; // Input for 2a, 2d (this is 'activeCellFlags' from Pass 1)
@group(0) @binding(3) var<storage, read_write> activeCellIndices_compaction: array<u32>; // Used for counts, prefix sums, and final compacted indices
@group(0) @binding(4) var<storage, read_write> activeCellCount_compaction: u32; // Output of Pass 2d

// Pass 3: Edge Detection
@group(0) @binding(5) var<storage, read> activeCellIndicesIn_edge: array<u32>; // Compacted list of active cell indices (output of Pass 2d)
@group(0) @binding(9) var<storage, read_write> cellQEFData_edge: array<QEFData>; // QEF data per (active cell * component)
@group(0) @binding(10) var<storage, read> activeCellCount_edgeInput: u32; // Total active cells (output of Pass 2d)

// Pass 4: Vertex Generation
@group(0) @binding(11) var<storage, read> activeCellIndicesIn_vertex: array<u32>; // Compacted list (not strictly needed if vertices map 1:1 to active cells)
@group(0) @binding(12) var<storage, read> cellQEFDataIn_vertex: array<QEFData>;    // QEF data per (active cell * component) (output of Pass 3)
@group(0) @binding(13) var<storage, read_write> vertices: array<Vertex>;          // Output vertices
@group(0) @binding(14) var<storage, read> activeCellCount_vertexInput: u32;   // Total active cells (output of Pass 2d)

// Pass 5: Face Generation
// Pass 5a (Count Triangles) uses activeCellIndicesIn_face, activeCellFlagsInput_face, activeCellCount_faceInput, writes counts to triangleOffsets_face
// Pass 5b (Prefix Sum Triangles) uses activeCellCount_faceInput, reads counts from triangleOffsets_face, writes prefix sums to triangleOffsets_face, writes total indexCount_face
// Pass 5c (Generate Triangles) uses activeCellIndicesIn_face, activeCellFlagsInput_face, activeCellCount_faceInput, triangleOffsets_face, writes to indices
@group(0) @binding(15) var<storage, read> activeCellIndicesIn_face: array<u32>;     // Compacted list of active cell indices
@group(0) @binding(16) var<storage, read> activeCellFlagsInput_face: array<u32>; // Original cell flags (output of Pass 1)
@group(0) @binding(17) var<storage, read_write> indices: array<u32>;              // Output triangle indices
@group(0) @binding(18) var<storage, read_write> indexCount_face: atomic<u32>;       // Total number of indices
@group(0) @binding(19) var<storage, read_write> triangleOffsets_face: array<u32>;   // Per-cell triangle counts, then prefix sums
@group(0) @binding(20) var<storage, read> activeCellCount_faceInput: u32;       // Total active cells (output of Pass 2d)
@group(0) @binding(21) var<storage, read_write> triangleWorkgroupOffsets_face: array<u32>; // workgroup totals -> workgroup exclusive offsets

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
@group(0) @binding(24) var<storage, read_write> debugSkipCounters: array<atomic<u32>, 8>;

// Cancellation flag: 0 = continue, 1 = cancelled
@group(0) @binding(25) var<storage, read_write> cancelled: atomic<u32>;


// ============================== UTILITY FUNCTIONS ==============================

// Auxiliary SDF functions (e.g., per-polygon evaluators) are injected here at runtime.
//:) insert sceneAuxFast
//:) insert sceneAux

// Placeholder for the actual scene Signed Distance Function
fn sceneSDF(p: vec3f) -> SDFResult {
    // Reference selectedObjectIds to prevent optimization (unused but required for binding)
    let dummy = selectedObjectIds[0];
    return sdfTrue(0.0, 0u, vec3f(0.0)); //:) insert sceneSDF
}

// Fast version for distance-only evaluations - only returns vec2f(distance, gradientMagnitude).
// No tie-breaking, no normals, no normalize() calls.
fn sceneSDF_fast(p: vec3f) -> vec2f {
    return vec2f(0.0, 1.0); //:) insert sceneSDF_fast
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

// Base offset into activeCellIndices_compaction where the compacted list is stored.
// Layout is:
// - [0 .. totalU32sInFlags)              : counts/prefix sums
// - [totalU32sInFlags .. +numWorkgroups) : workgroup totals
// - [baseOffset .. ]                      : compacted cell indices
fn activeCellIndexListBaseOffset() -> u32 {
    let n = totalU32sInFlags();
    let wg = (n + 255u) / 256u;
    return n + wg;
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
    return sceneSDF_fast(worldPos).x;
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
    let sdf = sceneSDF(p);
    let n = sdf.n * sdf.s;
    if (length(n) > 0.0) {
        let nudge = min(eps, uniforms.voxelSize * 0.02);
        let d2p = sceneSDF_fast(p + n * nudge).x - uniforms.isoValue;
        let d2m = sceneSDF_fast(p - n * nudge).x - uniforms.isoValue;
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


// --- Edge Indexing Functions ---
fn getEdgeIndexX(cellPos: vec3u) -> u32 {
    return cellPos.x + cellPos.y * (uniforms.gridDimensions.x - 1u) + 
           cellPos.z * (uniforms.gridDimensions.x - 1u) * uniforms.gridDimensions.y;
}

fn getEdgeIndexY(cellPos: vec3u) -> u32 {
    return cellPos.y + cellPos.z * (uniforms.gridDimensions.y - 1u) +
           cellPos.x * (uniforms.gridDimensions.y - 1u) * uniforms.gridDimensions.z; 
}

fn getEdgeIndexZ(cellPos: vec3u) -> u32 {
    return cellPos.x + cellPos.y * uniforms.gridDimensions.x + 
           cellPos.z * uniforms.gridDimensions.x * uniforms.gridDimensions.y; 
}


// Workgroup shared memory (declared at module scope)
var<workgroup> workgroup_thread_flags: array<u32, 256>; // General purpose flags, max workgroup size used (e.g. 256 or 32 for Pass1)
var<workgroup> workgroup_compaction_counts: array<u32, 256>; // For Pass 2b prefix sum
var<workgroup> workgroup_triangle_counts_ps: array<u32, 256>; // For Pass 5b prefix sum on triangle counts


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


// Pass 2a: Count active cells per u32 block from activeCellFlagsIn_compaction
// Dispatch: num_workgroups = ceil(totalU32sInFlags / 256.0)
@compute @workgroup_size(256, 1, 1)
fn countActiveCells_Pass2a(@builtin(global_invocation_id) globalId: vec3u) {
    let u32_block_id = globalId.x; 
    let totalU32sInFlags = (uniforms.gridDimensions.x * uniforms.gridDimensions.y * uniforms.gridDimensions.z + 31u) / 32u;

    // Using activeCellFlagsIn_compaction as defined in bind group
    if (u32_block_id < totalU32sInFlags && u32_block_id < arrayLength(&activeCellFlagsIn_compaction)) {
        let count = countOneBits(activeCellFlagsIn_compaction[u32_block_id]);
        if (u32_block_id < arrayLength(&activeCellIndices_compaction)) { 
            activeCellIndices_compaction[u32_block_id] = count;
        }
    }
}

// Pass 2b: Hierarchical parallel prefix sum (within each workgroup)
// Dispatch: num_workgroups = ceil(totalU32sInFlags / 256.0)
@compute @workgroup_size(256, 1, 1)
fn prefixSumWorkgroup_Pass2b(
    @builtin(global_invocation_id) globalId: vec3u, 
    @builtin(local_invocation_id) localId: vec3u,
    @builtin(workgroup_id) workgroupId: vec3u
) {
    let local_idx = localId.x;
    let global_idx = globalId.x; 
    
    let numCountsToSum = (uniforms.gridDimensions.x * uniforms.gridDimensions.y * uniforms.gridDimensions.z + 31u) / 32u;

    var value_to_sum = 0u;
    if (global_idx < numCountsToSum && global_idx < arrayLength(&activeCellIndices_compaction)) {
        value_to_sum = activeCellIndices_compaction[global_idx];
    }
    workgroup_compaction_counts[local_idx] = value_to_sum;
    workgroupBarrier();

    // Blelloch exclusive scan (race-free) over 256 elements.
    // Up-sweep
    for (var d = 1u; d < 256u; d = d << 1u) {
        let idx = ((local_idx + 1u) * d * 2u) - 1u;
        if (idx < 256u) {
            workgroup_compaction_counts[idx] =
                workgroup_compaction_counts[idx] + workgroup_compaction_counts[idx - d];
        }
        workgroupBarrier();
    }

    // Store workgroup total and prepare for exclusive down-sweep.
    if (local_idx == 255u) {
        let workgroup_total_storage_idx = numCountsToSum + workgroupId.x;
        if (workgroup_total_storage_idx < arrayLength(&activeCellIndices_compaction)) {
            activeCellIndices_compaction[workgroup_total_storage_idx] = workgroup_compaction_counts[255u];
        }
        workgroup_compaction_counts[255u] = 0u;
    }
    workgroupBarrier();

    // Down-sweep
    var d2 = 128u;
    loop {
        let idx = ((local_idx + 1u) * d2 * 2u) - 1u;
        if (idx < 256u) {
            let t = workgroup_compaction_counts[idx - d2];
            workgroup_compaction_counts[idx - d2] = workgroup_compaction_counts[idx];
            workgroup_compaction_counts[idx] = workgroup_compaction_counts[idx] + t;
        }
        workgroupBarrier();
        if (d2 == 1u) { break; }
        d2 = d2 >> 1u;
    }

    // Write EXCLUSIVE scan results for this workgroup.
    if (global_idx < numCountsToSum && global_idx < arrayLength(&activeCellIndices_compaction)) {
        activeCellIndices_compaction[global_idx] = workgroup_compaction_counts[local_idx];
    }
}

// Pass 2c: Add workgroup offsets to complete global EXCLUSIVE prefix sum
@compute @workgroup_size(256, 1, 1)
fn addWorkgroupOffsets_Pass2c(
    @builtin(global_invocation_id) globalId: vec3u,
    @builtin(local_invocation_id) localId: vec3u,
    @builtin(workgroup_id) workgroupId: vec3u
) {
    let global_idx = globalId.x; 
    let local_idx = localId.x;

    let numCountsToSum = (uniforms.gridDimensions.x * uniforms.gridDimensions.y * uniforms.gridDimensions.z + 31u) / 32u;

    // Compute offset from all previous workgroups
    var offset_from_prev_workgroups = 0u;
    if (workgroupId.x > 0u) {
        for (var i = 0u; i < workgroupId.x; i = i + 1u) {
             let prev_wg_total_idx = numCountsToSum + i;
             if(prev_wg_total_idx < arrayLength(&activeCellIndices_compaction)) { 
                offset_from_prev_workgroups = offset_from_prev_workgroups + activeCellIndices_compaction[prev_wg_total_idx];
             }
        }
    }

    if (global_idx < numCountsToSum && global_idx < arrayLength(&activeCellIndices_compaction)) {
        // After Pass 2b, activeCellIndices_compaction[global_idx] contains the EXCLUSIVE sum
        // within this workgroup. Add previous-workgroup totals to make it global.
        _ = local_idx;
        activeCellIndices_compaction[global_idx] = activeCellIndices_compaction[global_idx] + offset_from_prev_workgroups;
    }

    // Handle the edge case where numCountsToSum == 0 (shouldn't happen in practice, but be safe)
    if (numCountsToSum == 0u && global_idx == 0u) {
        activeCellIndices_compaction[0] = 0u;
    }
}


// Pass 2d: Expand active cells using prefix sum results
@compute @workgroup_size(256, 1, 1)
fn expandActiveCells_Pass2d(
    @builtin(global_invocation_id) globalId: vec3u
) {
    let u32_block_id = globalId.x; 
    let num_u32_blocks_in_flags = (uniforms.gridDimensions.x * uniforms.gridDimensions.y * uniforms.gridDimensions.z + 31u) / 32u;
    let baseOffset = activeCellIndexListBaseOffset();

    // Using activeCellFlagsIn_compaction as defined in bind group
    if (u32_block_id < num_u32_blocks_in_flags && 
        u32_block_id < arrayLength(&activeCellFlagsIn_compaction) && 
        u32_block_id < arrayLength(&activeCellIndices_compaction)) {   

        let flags_for_this_block = activeCellFlagsIn_compaction[u32_block_id];
        let num_set_bits_in_this_block = countOneBits(flags_for_this_block);

        if (num_set_bits_in_this_block > 0u) {
            let output_base_storage_idx = activeCellIndices_compaction[u32_block_id]; 
            let first_cell_flat_idx_in_this_block = u32_block_id * 32u;
            
            var current_output_offset_within_block = 0u;
            for (var bit_pos = 0u; bit_pos < 32u; bit_pos = bit_pos + 1u) {
                if ((flags_for_this_block & (1u << bit_pos)) != 0u) {
                    let actual_cell_flat_idx = first_cell_flat_idx_in_this_block + bit_pos;
                    if (actual_cell_flat_idx < uniforms.gridDimensions.x * uniforms.gridDimensions.y * uniforms.gridDimensions.z) {
                        let final_compacted_array_write_idx = baseOffset + output_base_storage_idx + current_output_offset_within_block;
                        if (final_compacted_array_write_idx < arrayLength(&activeCellIndices_compaction)) { 
                            activeCellIndices_compaction[final_compacted_array_write_idx] = actual_cell_flat_idx;
                        }
                        current_output_offset_within_block = current_output_offset_within_block + 1u;
                    }
                }
            }
        }
    }

    // Calculate total active cell count
    // Only the thread processing the last block should write the final count
    // to avoid race conditions
    if (num_u32_blocks_in_flags > 0u) {
        if (globalId.x == num_u32_blocks_in_flags - 1u) {
            // We're processing the last block - calculate total count
            let exclusive_sum_of_last_block = activeCellIndices_compaction[num_u32_blocks_in_flags - 1u];
            let count_in_last_block = countOneBits(activeCellFlagsIn_compaction[num_u32_blocks_in_flags - 1u]);
            activeCellCount_compaction = exclusive_sum_of_last_block + count_in_last_block;
        }
    } else {
        // Edge case: no blocks at all
        if (globalId.x == 0u) {
            activeCellCount_compaction = 0u;
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

    let totalActiveCells = activeCellCount_edgeInput; 
    if (cancelled || active_cell_array_idx >= totalActiveCells) { return; }
    if (active_cell_array_idx >= arrayLength(&activeCellIndicesIn_edge)) { return; }

    // activeCellIndicesIn_edge is a direct compact list of active cell flat indices.
    let cellFlatIndex = activeCellIndicesIn_edge[active_cell_array_idx];
    let cellPos = gridIndexTo3D(cellFlatIndex);

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
            let inBlendRegion = initialSdfFast.y < 0.95;
            
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
            // Use analytic normals from SDFResult instead of finite-difference gradients
            // for stability at CSG seams where gradients are discontinuous.
            // Note: n is already correctly oriented by CSG operators (they negate n when needed)
            var sdfResult = sceneSDF(intersectionPos);
            var normal = sdfResult.n;
            for (var iter = 0u; iter < uniforms.mdcU0.x; iter = iter + 1u) {
                sdfResult = sceneSDF(intersectionPos);
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
            let finalSdf = sceneSDF(intersectionPos);
            normal = finalSdf.n;
            
            crossingPos[e] = intersectionPos;
            crossingNormal[e] = normal;
        } else {
            crossingPos[e] = vec3f(0.0);
            crossingNormal[e] = vec3f(0.0);
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

        // Write edge->component mapping for this cell.
        if (edgeCompBase + e < arrayLength(&cellEdgeComponents)) {
            var outComp = 0xffffffffu;
            if (compIdx >= 0) { outComp = u32(compIdx); }
            cellEdgeComponents[edgeCompBase + e] = outComp;
        }
    }

    // Accumulate QEFs per component.
    var qefs: array<QEFData, 4>;
    for (var c = 0u; c < 4u; c = c + 1u) {
        qefs[c] = QEFData(mat3x3f(), vec3f(0.0), vec3f(0.0), 0u);
    }

    for (var e = 0u; e < 12u; e = e + 1u) {
        if (edgeCrossMask[e] == 0u) { continue; }
        let compIdx = edgeComponent[e];
        if (compIdx < 0) { continue; }

        // Use pre-computed crossing data from earlier in this function
        let intersectionPos = crossingPos[e];
        let normal = crossingNormal[e];

        let c = u32(compIdx);
        qefs[c].ATA[0] = qefs[c].ATA[0] + normal * normal.x;
        qefs[c].ATA[1] = qefs[c].ATA[1] + normal * normal.y;
        qefs[c].ATA[2] = qefs[c].ATA[2] + normal * normal.z;
        let d_val = dot(normal, intersectionPos);
        qefs[c].ATb = qefs[c].ATb + normal * d_val;
        qefs[c].massPoint = qefs[c].massPoint + intersectionPos;
        qefs[c].numPoints = qefs[c].numPoints + 1u;
    }

    // Write per-component QEFs for this active cell.
    let qefBase = active_cell_array_idx * MAX_COMPONENTS_PER_CELL;
    for (var c = 0u; c < MAX_COMPONENTS_PER_CELL; c = c + 1u) {
        let outIdx = qefBase + c;
        if (outIdx < arrayLength(&cellQEFData_edge)) {
            cellQEFData_edge[outIdx] = qefs[c];
        }
    }
}


// Pass 4: Vertex Generation
@compute @workgroup_size(64, 1, 1)
fn vertexGeneration_Pass4(
    @builtin(local_invocation_id) localId: vec3u,
    @builtin(workgroup_id) workgroupId: vec3u,
    @builtin(num_workgroups) numWg: vec3u
) {
    // We generate up to MAX_COMPONENTS_PER_CELL vertices per active cell.
    let wgLinear = workgroupId.x + workgroupId.y * numWg.x + workgroupId.z * numWg.x * numWg.y;
    
    // Check cancellation but don't return early (to maintain uniform control flow)
    let cancelled = isCancelled();
    let vertexRecordIdx = wgLinear * 64u + localId.x;
    let totalActiveCells = activeCellCount_vertexInput;
    let totalVertexRecords = totalActiveCells * MAX_COMPONENTS_PER_CELL;
    if (cancelled || vertexRecordIdx >= totalVertexRecords) { return; }
    if (vertexRecordIdx >= arrayLength(&cellQEFDataIn_vertex) || vertexRecordIdx >= arrayLength(&vertices)) { return; }

    let active_cell_array_idx = vertexRecordIdx / MAX_COMPONENTS_PER_CELL;
    let qef = cellQEFDataIn_vertex[vertexRecordIdx];
    // Constrain the QEF solution to this cell's bounds to avoid vertices drifting
    // outside the cell (which causes overhanging/jutting polygons, especially on
    // anisotropic shapes like rectangular prisms).
    if (active_cell_array_idx >= arrayLength(&activeCellIndicesIn_vertex)) { return; }
    let cellFlatIndex = activeCellIndicesIn_vertex[active_cell_array_idx];
    let cellPos = gridIndexTo3D(cellFlatIndex);
    let cellMin = gridPosToWorldPos(cellPos);
    let cellMax = cellMin + vec3f(uniforms.voxelSize);

    // Robust in-cell candidate selection:
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

    // Iterative projection to ensure vertex is on the true iso-surface.
    // Uses gradient-magnitude-aware stepping to handle smooth CSG regions
    // where |∇f| < 1 and naive projection overshoots.
    // Uses analytic normals from SDFResult for stability at CSG seams.
    // Note: n is already correctly oriented by CSG operators (they negate n when needed)
    var finalSdfResult = sceneSDF(vertexPos);
    for (var iter = 0u; iter < uniforms.mdcU0.y; iter = iter + 1u) {
        let sdfResult = sceneSDF(vertexPos);
        let d = sdfResult.d - uniforms.isoValue;
        if (abs(d) < uniforms.voxelSize * uniforms.mdcF1.w) { 
            finalSdfResult = sdfResult;
            break; 
        }
        // Use analytic normal from SDF result (already correctly oriented)
        let n = sdfResult.n;
        
        // Only use gradient magnitude to reduce step size.
        let gradScale = max(1.0, sdfResult.g);
        let correctedD = d / gradScale;
        
        var projected = vertexPos - n * correctedD;
        // Clamp to cell bounds, but allow slight relaxation for high-curvature surfaces
        let margin = uniforms.voxelSize * uniforms.mdcF2.x;
        let relaxedMin = cellMin - vec3f(margin);
        let relaxedMax = cellMax + vec3f(margin);
        projected = clamp(projected, relaxedMin, relaxedMax);
        // If projection would move vertex too far, use a damped step
        // Use smaller steps in blend regions to avoid oscillation
        let step = projected - vertexPos;
        let stepLen = length(step);
        let baseMaxStep = uniforms.voxelSize * uniforms.mdcF2.y;
        let maxStep = baseMaxStep * select(1.0, 0.5, sdfResult.g < 0.8);
        if (stepLen > maxStep) {
            vertexPos = vertexPos + step * (maxStep / stepLen);
        } else {
            vertexPos = projected;
        }
        // Final clamp to strict cell bounds
        vertexPos = clamp(vertexPos, cellMin, cellMax);
        finalSdfResult = sdfResult;
    }
    
    // Use analytic normal from final SDF evaluation for vertex normal
    var vertexNormal = finalSdfResult.n;
    if (qef.numPoints == 0u || length(vertexNormal) < 0.001) { 
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

// NOTE: previous implementation had an O(N) scan (`findVertexIndexForCell`) which caused
// O(N^2) work in Pass 5 and can manifest as missing faces / incomplete meshes.


// Pass 5a: Count triangles per active cell
@compute @workgroup_size(64, 1, 1)
fn countTriangles_Pass5a(@builtin(global_invocation_id) globalId: vec3u) {
    let active_cell_array_idx = globalId.x;

    let totalActiveCells = activeCellCount_faceInput;
    if (active_cell_array_idx >= totalActiveCells) { return; }
    if (active_cell_array_idx >= arrayLength(&activeCellIndicesIn_face)) { return; }

    let cellFlatIndex = activeCellIndicesIn_face[active_cell_array_idx];
    let cellPos = gridIndexTo3D(cellFlatIndex);

    var cornerSDFValues_cell: array<f32, 8>;
    for (var i = 0u; i < 8u; i = i + 1u) {
        let cgp = getCellCornerPos(cellPos, i);
        cornerSDFValues_cell[i] = sampleSDF(gridPosToWorldPos(cgp));
    }

    var numTrianglesForThisCell = 0u;
    if (hasEdgeCrossingX(cellPos, cornerSDFValues_cell) && areFourCellsAroundXEdgeActive(cellPos)) {
        let a0 = i32(active_cell_array_idx);
        let a1 = activeIndexForCellPos(cellPos - vec3u(0u, 1u, 0u));
        let a2 = activeIndexForCellPos(cellPos - vec3u(0u, 0u, 1u));
        let a3 = activeIndexForCellPos(cellPos - vec3u(0u, 1u, 1u));
        if (a0 >= 0 && a1 >= 0 && a2 >= 0 && a3 >= 0) {
            // Local cube edge indices around this X grid edge:
            // owner: (0-1)=0, y-1: (2-3)=1, z-1: (4-5)=2, y-1 z-1: (6-7)=3
            let c0 = getEdgeComponent(u32(a0), 0u);
            let c1 = getEdgeComponent(u32(a1), 1u);
            let c2 = getEdgeComponent(u32(a2), 2u);
            let c3 = getEdgeComponent(u32(a3), 3u);
            if (c0 != 0xffffffffu && c1 != 0xffffffffu && c2 != 0xffffffffu && c3 != 0xffffffffu) {
                numTrianglesForThisCell = numTrianglesForThisCell + 2u;
            }
        }
    }
    if (hasEdgeCrossingY(cellPos, cornerSDFValues_cell) && areFourCellsAroundYEdgeActive(cellPos)) {
        let a0 = i32(active_cell_array_idx);
        let a1 = activeIndexForCellPos(cellPos - vec3u(1u, 0u, 0u));
        let a2 = activeIndexForCellPos(cellPos - vec3u(0u, 0u, 1u));
        let a3 = activeIndexForCellPos(cellPos - vec3u(1u, 0u, 1u));
        if (a0 >= 0 && a1 >= 0 && a2 >= 0 && a3 >= 0) {
            // Local cube edge indices around this Y grid edge:
            // owner: (0-2)=4, x-1: (1-3)=5, z-1: (4-6)=6, x-1 z-1: (5-7)=7
            let c0 = getEdgeComponent(u32(a0), 4u);
            let c1 = getEdgeComponent(u32(a1), 5u);
            let c2 = getEdgeComponent(u32(a2), 6u);
            let c3 = getEdgeComponent(u32(a3), 7u);
            if (c0 != 0xffffffffu && c1 != 0xffffffffu && c2 != 0xffffffffu && c3 != 0xffffffffu) {
                numTrianglesForThisCell = numTrianglesForThisCell + 2u;
            }
        }
    }
    if (hasEdgeCrossingZ(cellPos, cornerSDFValues_cell) && areFourCellsAroundZEdgeActive(cellPos)) {
        let a0 = i32(active_cell_array_idx);
        let a1 = activeIndexForCellPos(cellPos - vec3u(1u, 0u, 0u));
        let a2 = activeIndexForCellPos(cellPos - vec3u(0u, 1u, 0u));
        let a3 = activeIndexForCellPos(cellPos - vec3u(1u, 1u, 0u));
        if (a0 >= 0 && a1 >= 0 && a2 >= 0 && a3 >= 0) {
            // Local cube edge indices around this Z grid edge:
            // owner: (0-4)=8, x-1: (1-5)=9, y-1: (2-6)=10, x-1 y-1: (3-7)=11
            let c0 = getEdgeComponent(u32(a0), 8u);
            let c1 = getEdgeComponent(u32(a1), 9u);
            let c2 = getEdgeComponent(u32(a2), 10u);
            let c3 = getEdgeComponent(u32(a3), 11u);
            if (c0 != 0xffffffffu && c1 != 0xffffffffu && c2 != 0xffffffffu && c3 != 0xffffffffu) {
                numTrianglesForThisCell = numTrianglesForThisCell + 2u;
            }
        }
    }
    
    if (active_cell_array_idx < arrayLength(&triangleOffsets_face)) {
        triangleOffsets_face[active_cell_array_idx] = numTrianglesForThisCell;
    }
}

// Pass 5b: Per-workgroup prefix sum on triangle counts.
// Outputs:
// - triangleOffsets_face: per-cell EXCLUSIVE offsets (within workgroup)
// - triangleWorkgroupOffsets_face[workgroupId.x]: total triangles in this workgroup (will be scanned in 5b2)
@compute @workgroup_size(256, 1, 1)
fn prefixSumTriangles_Pass5b(
    @builtin(global_invocation_id) globalId: vec3u, 
    @builtin(local_invocation_id) localId: vec3u,
    @builtin(workgroup_id) workgroupId: vec3u 
) {
    let element_idx_global = globalId.x; 
    let local_idx = localId.x;
    let totalActiveCellsToProcess = activeCellCount_faceInput; 

    var count_val = 0u;
    if (element_idx_global < totalActiveCellsToProcess && element_idx_global < arrayLength(&triangleOffsets_face)) {
        count_val = triangleOffsets_face[element_idx_global];
    }
    workgroup_triangle_counts_ps[local_idx] = count_val;
    workgroupBarrier();

    // Blelloch exclusive scan (race-free) over 256 elements.
    // Up-sweep
    for (var d = 1u; d < 256u; d = d << 1u) {
        let idx = ((local_idx + 1u) * d * 2u) - 1u;
        if (idx < 256u) {
            workgroup_triangle_counts_ps[idx] =
                workgroup_triangle_counts_ps[idx] + workgroup_triangle_counts_ps[idx - d];
        }
        workgroupBarrier();
    }

    // Store workgroup total and prepare for exclusive down-sweep.
    if (local_idx == 255u) {
        if (workgroupId.x < arrayLength(&triangleWorkgroupOffsets_face)) {
            triangleWorkgroupOffsets_face[workgroupId.x] = workgroup_triangle_counts_ps[255u];
        }
        workgroup_triangle_counts_ps[255u] = 0u;
    }
    workgroupBarrier();

    // Down-sweep
    var d2 = 128u;
    loop {
        let idx = ((local_idx + 1u) * d2 * 2u) - 1u;
        if (idx < 256u) {
            let t = workgroup_triangle_counts_ps[idx - d2];
            workgroup_triangle_counts_ps[idx - d2] = workgroup_triangle_counts_ps[idx];
            workgroup_triangle_counts_ps[idx] = workgroup_triangle_counts_ps[idx] + t;
        }
        workgroupBarrier();
        if (d2 == 1u) { break; }
        d2 = d2 >> 1u;
    }

    // Write per-cell EXCLUSIVE offsets (within this workgroup).
    if (element_idx_global < totalActiveCellsToProcess && element_idx_global < arrayLength(&triangleOffsets_face)) {
        triangleOffsets_face[element_idx_global] = workgroup_triangle_counts_ps[local_idx];
    }
}

// Pass 5b2: Scan workgroup totals (single workgroup, since maxActiveCells <= 32768 => <= 128 workgroups)
// After this pass:
// - triangleWorkgroupOffsets_face[i] becomes EXCLUSIVE prefix sum of totals for workgroup i
// - indexCount_face is written
@compute @workgroup_size(256, 1, 1)
fn prefixSumTriangleWorkgroups_Pass5b2(
    @builtin(local_invocation_id) localId: vec3u
) {
    let local_idx = localId.x;
    let totalActiveCellsToProcess = activeCellCount_faceInput;
    let numWorkgroups = (totalActiveCellsToProcess + 255u) / 256u;

    // If there are no cells, every lane takes this path (uniform), so it's safe to early-return.
    if (totalActiveCellsToProcess == 0u) {
        if (local_idx == 0u) { atomicStore(&indexCount_face, 0u); }
        return;
    }

    var v = 0u;
    if (local_idx < numWorkgroups && local_idx < arrayLength(&triangleWorkgroupOffsets_face)) {
        v = triangleWorkgroupOffsets_face[local_idx];
    }
    workgroup_triangle_counts_ps[local_idx] = v;
    workgroupBarrier();

    // Blelloch exclusive scan (race-free).
    // Up-sweep
    for (var d = 1u; d < 256u; d = d << 1u) {
        let idx = ((local_idx + 1u) * d * 2u) - 1u;
        if (idx < 256u) {
            workgroup_triangle_counts_ps[idx] =
                workgroup_triangle_counts_ps[idx] + workgroup_triangle_counts_ps[idx - d];
        }
        workgroupBarrier();
    }

    // Total triangles is in lane 255 after up-sweep (zeros do not affect sum).
    if (local_idx == 255u) {
        atomicStore(&indexCount_face, workgroup_triangle_counts_ps[255u] * 3u);
        workgroup_triangle_counts_ps[255u] = 0u;
    }
    workgroupBarrier();

    // Down-sweep
    var d2 = 128u;
    loop {
        let idx = ((local_idx + 1u) * d2 * 2u) - 1u;
        if (idx < 256u) {
            let t = workgroup_triangle_counts_ps[idx - d2];
            workgroup_triangle_counts_ps[idx - d2] = workgroup_triangle_counts_ps[idx];
            workgroup_triangle_counts_ps[idx] = workgroup_triangle_counts_ps[idx] + t;
        }
        workgroupBarrier();
        if (d2 == 1u) { break; }
        d2 = d2 >> 1u;
    }

    // Write exclusive offsets back.
    if (local_idx < numWorkgroups && local_idx < arrayLength(&triangleWorkgroupOffsets_face)) {
        triangleWorkgroupOffsets_face[local_idx] = workgroup_triangle_counts_ps[local_idx];
    }
}

// Pass 5b3: Add workgroup offsets to per-cell offsets to get a global exclusive prefix sum
@compute @workgroup_size(256, 1, 1)
fn addTriangleWorkgroupOffsets_Pass5b3(
    @builtin(global_invocation_id) globalId: vec3u
) {
    let element_idx_global = globalId.x;
    let totalActiveCellsToProcess = activeCellCount_faceInput;
    if (element_idx_global >= totalActiveCellsToProcess || element_idx_global >= arrayLength(&triangleOffsets_face)) { return; }

    let block = element_idx_global / 256u;
    if (block < arrayLength(&triangleWorkgroupOffsets_face)) {
        triangleOffsets_face[element_idx_global] = triangleOffsets_face[element_idx_global] + triangleWorkgroupOffsets_face[block];
    }
}

// Pass 5c: Generate actual triangles
fn generateQuadIndices(
    baseOutputIdx: u32, 
    v0_idx: u32, v1_idx: u32, v2_idx: u32, v3_idx: u32, 
    flipWinding: bool
) {
    // Quad loop is (v0 -> v1 -> v3 -> v2).
    // Choose diagonal and orient winding using generated vertex normals to reduce creases
    // and avoid "missing" faces due to flipped winding/backface culling.
    if (baseOutputIdx + 5u >= arrayLength(&indices)) { return; }
    if (v0_idx >= arrayLength(&vertices) || v1_idx >= arrayLength(&vertices) ||
        v2_idx >= arrayLength(&vertices) || v3_idx >= arrayLength(&vertices)) { return; }

    let p0 = vertices[v0_idx].position;
    let p1 = vertices[v1_idx].position;
    let p2 = vertices[v2_idx].position;
    let p3 = vertices[v3_idx].position;

    // Score diagonal by how consistent the two triangle normals are (lower score = less crease).
    let a0 = safeUnit3(cross(p1 - p0, p3 - p0));
    let a1 = safeUnit3(cross(p3 - p0, p2 - p0));
    let b0 = safeUnit3(cross(p1 - p0, p2 - p0));
    let b1 = safeUnit3(cross(p3 - p1, p2 - p1));

    let diag03Deg = dot(a0, a0) == 0.0 || dot(a1, a1) == 0.0;
    let diag12Deg = dot(b0, b0) == 0.0 || dot(b1, b1) == 0.0;

    var useDiag03 = false;
    if (!diag03Deg && !diag12Deg) {
        let score03 = 1.0 - dot(a0, a1);
        let score12 = 1.0 - dot(b0, b1);
        useDiag03 = score03 <= score12;
    } else {
        // Fallback: shorter diagonal.
        useDiag03 = dot(p0 - p3, p0 - p3) <= dot(p1 - p2, p1 - p2);
    }

    // Winding: orient using SDF gradient at quad centroid (more robust than axis heuristics).
    var needFlip = flipWinding;
    let center = (p0 + p1 + p2 + p3) * 0.25;
    let gn = computeGradient(center);
    if (dot(gn, gn) > 1e-12) {
        var faceN: vec3f;
        if (useDiag03) {
            faceN = cross(p1 - p0, p3 - p0);
        } else {
            faceN = cross(p1 - p0, p2 - p0);
        }
        needFlip = dot(faceN, gn) < 0.0;
    }

    if (useDiag03) {
        if (!needFlip) {
            indices[baseOutputIdx + 0u] = v0_idx;
            indices[baseOutputIdx + 1u] = v1_idx;
            indices[baseOutputIdx + 2u] = v3_idx;
            indices[baseOutputIdx + 3u] = v0_idx;
            indices[baseOutputIdx + 4u] = v3_idx;
            indices[baseOutputIdx + 5u] = v2_idx;
        } else {
            indices[baseOutputIdx + 0u] = v0_idx;
            indices[baseOutputIdx + 1u] = v3_idx;
            indices[baseOutputIdx + 2u] = v1_idx;
            indices[baseOutputIdx + 3u] = v0_idx;
            indices[baseOutputIdx + 4u] = v2_idx;
            indices[baseOutputIdx + 5u] = v3_idx;
        }
    } else {
        if (!needFlip) {
            indices[baseOutputIdx + 0u] = v0_idx;
            indices[baseOutputIdx + 1u] = v1_idx;
            indices[baseOutputIdx + 2u] = v2_idx;
            indices[baseOutputIdx + 3u] = v1_idx;
            indices[baseOutputIdx + 4u] = v3_idx;
            indices[baseOutputIdx + 5u] = v2_idx;
        } else {
            indices[baseOutputIdx + 0u] = v0_idx;
            indices[baseOutputIdx + 1u] = v2_idx;
            indices[baseOutputIdx + 2u] = v1_idx;
            indices[baseOutputIdx + 3u] = v1_idx;
            indices[baseOutputIdx + 4u] = v2_idx;
            indices[baseOutputIdx + 5u] = v3_idx;
        }
    }
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

    // Orient both triangles consistently using SDF gradient at quad center.
    let center = (p0 + p1 + p2 + p3) * 0.25;
    // Use field sampling along the triangle normal to decide outward orientation.
    // This is more robust than gradient-based orientation on sharp features / CSG seams.
    let faceN0 = cross(vertices[t0.y].position - vertices[t0.x].position,
                       vertices[t0.z].position - vertices[t0.x].position);
    let nHat = safeUnit3(faceN0);
    if (dot(nHat, nHat) > 0.0) {
        let probe = max(uniforms.mdcF3.z, uniforms.voxelSize * uniforms.mdcF3.y);
        let dPlus = sampleSDF(center + nHat * probe) - uniforms.isoValue;
        let dMinus = sampleSDF(center - nHat * probe) - uniforms.isoValue;
        // Outside should be on the +normal side for outward-facing triangles.
        if (dPlus < dMinus) {
            // Flip BOTH triangles.
            t0 = vec3u(t0.x, t0.z, t0.y);
            t1 = vec3u(t1.x, t1.z, t1.y);
        }
    }

    return TriPair(t0, t1, 1u);
}


@compute @workgroup_size(64, 1, 1)
fn generateTriangles_Pass5c(@builtin(global_invocation_id) globalId: vec3u) {
    let active_cell_array_idx = globalId.x; 

    let totalActiveCells = activeCellCount_faceInput;
    if (active_cell_array_idx >= totalActiveCells) { return; }
    if (active_cell_array_idx >= arrayLength(&activeCellIndicesIn_face)) { return; }
    if (active_cell_array_idx >= arrayLength(&triangleOffsets_face)) { return; }

    let cellFlatIndex = activeCellIndicesIn_face[active_cell_array_idx];
    let cellPos = gridIndexTo3D(cellFlatIndex);

    let output_triangle_start_offset_for_this_cell = triangleOffsets_face[active_cell_array_idx];
    var current_triangle_base_write_idx = output_triangle_start_offset_for_this_cell * 3u; 

    var cornerSDFValues_cell: array<f32, 8>;
    var cornerWorldPos_cell: array<vec3f, 8>; 
    for (var i = 0u; i < 8u; i = i + 1u) {
        let cgp = getCellCornerPos(cellPos, i);
        cornerWorldPos_cell[i] = gridPosToWorldPos(cgp);
        cornerSDFValues_cell[i] = sampleSDF(cornerWorldPos_cell[i]);
        // Count corners near iso-surface for debugging.
        let d = cornerSDFValues_cell[i] - uniforms.isoValue;
        let eps = max(uniforms.mdcF0.y, uniforms.voxelSize * uniforms.mdcF0.x);
        if (abs(d) <= eps) {
            atomicAdd(&debugSkipCounters[4], 1u);
        }
    }

    // X-edge: C(x,y,z) to C(x+1,y,z). Quad vertices from cells:
    // v0_cell: C(x,y,z) (owner)
    // v1_cell: C(x,y-1,z)
    // v2_cell: C(x,y,z-1)
    // v3_cell: C(x,y-1,z-1) (diagonal to owner across the quad face)
    // Quad vertices for generateQuadIndices (v0, v1, v2, v3):
    // v0_owner, v1_adj_ym, v2_adj_zm, v3_diag_ymzm
    if (hasEdgeCrossingX(cellPos, cornerSDFValues_cell) && areFourCellsAroundXEdgeActive(cellPos)) {
        let v0_vert_idx = i32(active_cell_array_idx); 
        let v1_vert_idx = activeIndexForCellPos(cellPos - vec3u(0u, 1u, 0u)); 
        let v2_vert_idx = activeIndexForCellPos(cellPos - vec3u(0u, 0u, 1u)); 
        let v3_vert_idx = activeIndexForCellPos(cellPos - vec3u(0u, 1u, 1u)); 

        if (v0_vert_idx >=0 && v1_vert_idx >=0 && v2_vert_idx >=0 && v3_vert_idx >=0) { 
            let c0 = getEdgeComponent(u32(v0_vert_idx), 0u);
            let c1 = getEdgeComponent(u32(v1_vert_idx), 1u);
            let c2 = getEdgeComponent(u32(v2_vert_idx), 2u);
            let c3 = getEdgeComponent(u32(v3_vert_idx), 3u);
            if (c0 == 0xffffffffu || c1 == 0xffffffffu || c2 == 0xffffffffu || c3 == 0xffffffffu) {
                // Topology mapping missing; skip.
            } else {
            let edge_mid_point = mix3f(cornerWorldPos_cell[0], cornerWorldPos_cell[1], 0.5); 
            let surface_gradient = computeGradient(edge_mid_point);
            let flip = dot(surface_gradient, vec3f(1.0, 0.0, 0.0)) < 0.0; 
            let vv0 = u32(v0_vert_idx) * MAX_COMPONENTS_PER_CELL + c0;
            let vv1 = u32(v1_vert_idx) * MAX_COMPONENTS_PER_CELL + c1;
            let vv2 = u32(v2_vert_idx) * MAX_COMPONENTS_PER_CELL + c2;
            let vv3 = u32(v3_vert_idx) * MAX_COMPONENTS_PER_CELL + c3;
            generateQuadIndices(current_triangle_base_write_idx, vv0, vv1, vv2, vv3, flip);
            current_triangle_base_write_idx = current_triangle_base_write_idx + 6u; 
            }
        }
    }

    // Y-edge: C(x,y,z) to C(x,y+1,z). Quad vertices from cells:
    // v0_cell: C(x,y,z) (owner)
    // v1_cell: C(x-1,y,z)
    // v2_cell: C(x,y,z-1)
    // v3_cell: C(x-1,y,z-1) (diagonal)
    // Quad vertices for generateQuadIndices (v0, v1, v2, v3):
    // v0_owner, v1_adj_xm, v2_adj_zm, v3_diag_xmzm
    if (hasEdgeCrossingY(cellPos, cornerSDFValues_cell) && areFourCellsAroundYEdgeActive(cellPos)) {
        let v0_vert_idx = i32(active_cell_array_idx); 
        let v1_vert_idx = activeIndexForCellPos(cellPos - vec3u(1u, 0u, 0u)); 
        let v2_vert_idx = activeIndexForCellPos(cellPos - vec3u(0u, 0u, 1u)); 
        let v3_vert_idx = activeIndexForCellPos(cellPos - vec3u(1u, 0u, 1u)); 

        if (v0_vert_idx >=0 && v1_vert_idx >=0 && v2_vert_idx >=0 && v3_vert_idx >=0) {
            let c0 = getEdgeComponent(u32(v0_vert_idx), 4u);
            let c1 = getEdgeComponent(u32(v1_vert_idx), 5u);
            let c2 = getEdgeComponent(u32(v2_vert_idx), 6u);
            let c3 = getEdgeComponent(u32(v3_vert_idx), 7u);
            if (c0 == 0xffffffffu || c1 == 0xffffffffu || c2 == 0xffffffffu || c3 == 0xffffffffu) {
                // Topology mapping missing; skip.
            } else {
            let edge_mid_point = mix3f(cornerWorldPos_cell[0], cornerWorldPos_cell[2], 0.5); 
            let surface_gradient = computeGradient(edge_mid_point);
            let flip = dot(surface_gradient, vec3f(0.0, 1.0, 0.0)) < 0.0;
            let vv0 = u32(v0_vert_idx) * MAX_COMPONENTS_PER_CELL + c0;
            let vv1 = u32(v1_vert_idx) * MAX_COMPONENTS_PER_CELL + c1;
            let vv2 = u32(v2_vert_idx) * MAX_COMPONENTS_PER_CELL + c2;
            let vv3 = u32(v3_vert_idx) * MAX_COMPONENTS_PER_CELL + c3;
            generateQuadIndices(current_triangle_base_write_idx, vv0, vv1, vv2, vv3, !flip); // Y often flips convention
            current_triangle_base_write_idx = current_triangle_base_write_idx + 6u;
            }
        }
    }

    // Z-edge: C(x,y,z) to C(x,y,z+1). Quad vertices from cells:
    // v0_cell: C(x,y,z) (owner)
    // v1_cell: C(x-1,y,z)
    // v2_cell: C(x,y-1,z)
    // v3_cell: C(x-1,y-1,z) (diagonal)
    // Quad vertices for generateQuadIndices (v0, v1, v2, v3):
    // v0_owner, v1_adj_xm, v2_adj_ym, v3_diag_xmym
    if (hasEdgeCrossingZ(cellPos, cornerSDFValues_cell) && areFourCellsAroundZEdgeActive(cellPos)) {
        let v0_vert_idx = i32(active_cell_array_idx); 
        let v1_vert_idx = activeIndexForCellPos(cellPos - vec3u(1u, 0u, 0u)); 
        let v2_vert_idx = activeIndexForCellPos(cellPos - vec3u(0u, 1u, 0u)); 
        let v3_vert_idx = activeIndexForCellPos(cellPos - vec3u(1u, 1u, 0u)); 

        if (v0_vert_idx >=0 && v1_vert_idx >=0 && v2_vert_idx >=0 && v3_vert_idx >=0) {
            let c0 = getEdgeComponent(u32(v0_vert_idx), 8u);
            let c1 = getEdgeComponent(u32(v1_vert_idx), 9u);
            let c2 = getEdgeComponent(u32(v2_vert_idx), 10u);
            let c3 = getEdgeComponent(u32(v3_vert_idx), 11u);
            if (c0 == 0xffffffffu || c1 == 0xffffffffu || c2 == 0xffffffffu || c3 == 0xffffffffu) {
                // Topology mapping missing; skip.
            } else {
            let edge_mid_point = mix3f(cornerWorldPos_cell[0], cornerWorldPos_cell[4], 0.5); 
            let surface_gradient = computeGradient(edge_mid_point);
            let flip = dot(surface_gradient, vec3f(0.0, 0.0, 1.0)) < 0.0;
            let vv0 = u32(v0_vert_idx) * MAX_COMPONENTS_PER_CELL + c0;
            let vv1 = u32(v1_vert_idx) * MAX_COMPONENTS_PER_CELL + c1;
            let vv2 = u32(v2_vert_idx) * MAX_COMPONENTS_PER_CELL + c2;
            let vv3 = u32(v3_vert_idx) * MAX_COMPONENTS_PER_CELL + c3;
            generateQuadIndices(current_triangle_base_write_idx, vv0, vv1, vv2, vv3, flip);
            current_triangle_base_write_idx = current_triangle_base_write_idx + 6u;
            }
        }
    }
}

// Pass 5 (scalable): Generate triangles using an atomic index counter.
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
    
    let totalActiveCells = activeCellCount_faceInput;
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
            let c0 = getEdgeComponent(u32(v0_vert_idx), 0u);
            let c1 = getEdgeComponent(u32(v1_vert_idx), 1u);
            let c2 = getEdgeComponent(u32(v2_vert_idx), 2u);
            let c3 = getEdgeComponent(u32(v3_vert_idx), 3u);
            if (c0 == 0xffffffffu || c1 == 0xffffffffu || c2 == 0xffffffffu || c3 == 0xffffffffu) {
                atomicAdd(&debugSkipCounters[1], 1u);
            } else {
                let vv0 = u32(v0_vert_idx) * MAX_COMPONENTS_PER_CELL + c0;
                let vv1 = u32(v1_vert_idx) * MAX_COMPONENTS_PER_CELL + c1;
                let vv2 = u32(v2_vert_idx) * MAX_COMPONENTS_PER_CELL + c2;
                let vv3 = u32(v3_vert_idx) * MAX_COMPONENTS_PER_CELL + c3;
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
            let c0 = getEdgeComponent(u32(v0_vert_idx), 4u);
            let c1 = getEdgeComponent(u32(v1_vert_idx), 5u);
            let c2 = getEdgeComponent(u32(v2_vert_idx), 6u);
            let c3 = getEdgeComponent(u32(v3_vert_idx), 7u);
            if (c0 == 0xffffffffu || c1 == 0xffffffffu || c2 == 0xffffffffu || c3 == 0xffffffffu) {
                atomicAdd(&debugSkipCounters[1], 1u);
            } else {
                let vv0 = u32(v0_vert_idx) * MAX_COMPONENTS_PER_CELL + c0;
                let vv1 = u32(v1_vert_idx) * MAX_COMPONENTS_PER_CELL + c1;
                let vv2 = u32(v2_vert_idx) * MAX_COMPONENTS_PER_CELL + c2;
                let vv3 = u32(v3_vert_idx) * MAX_COMPONENTS_PER_CELL + c3;
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
            let c0 = getEdgeComponent(u32(v0_vert_idx), 8u);
            let c1 = getEdgeComponent(u32(v1_vert_idx), 9u);
            let c2 = getEdgeComponent(u32(v2_vert_idx), 10u);
            let c3 = getEdgeComponent(u32(v3_vert_idx), 11u);
            if (c0 == 0xffffffffu || c1 == 0xffffffffu || c2 == 0xffffffffu || c3 == 0xffffffffu) {
                atomicAdd(&debugSkipCounters[1], 1u);
            } else {
                let vv0 = u32(v0_vert_idx) * MAX_COMPONENTS_PER_CELL + c0;
                let vv1 = u32(v1_vert_idx) * MAX_COMPONENTS_PER_CELL + c1;
                let vv2 = u32(v2_vert_idx) * MAX_COMPONENTS_PER_CELL + c2;
                let vv3 = u32(v3_vert_idx) * MAX_COMPONENTS_PER_CELL + c3;
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

