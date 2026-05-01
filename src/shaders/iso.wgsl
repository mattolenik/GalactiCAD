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
    // Stage 4 Session 6: separate sparse hash for sub-cell duals. Keys use the
    // CELL_TYPE_SUB_* constants; slot is the absolute index into `subCellAllDuals`
    // (post-base offset by Session 7's unification).
    subSparseHash: vec4u,  // x=subHashMask y=subHashEntries z=0 w=0
    // Stage 4 Session 7: write-side base offsets for `subCellAllDuals`. Pass 11
    // writes to `subCellAllDuals[subCellBases.x + dispatch_idx]`, Pass 12 uses .y,
    // Pass 13 uses .z. (Implied: cube_base = 0, edge_base = numSubCubes,
    // face_base = numSubCubes + numSubEdges; .w = total = numSubCubes + numSubEdges
    // + numSubFaces, useful as a sanity check.)
    subCellBases: vec4u,
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

// Stage 4 Session 6: separate sparse hash for sub-cell duals. Same vec2u (key, slot)
// layout as the base hash; key = (subCellType<<28)|sub_grid_linear_idx with subCellType
// in {CELL_TYPE_SUB_CUBE..CELL_TYPE_SUB_FACE_XY} and slot indexing into childDuals
// (sub-cubes), childEdgeDuals (sub-edges), or childFaceDuals (sub-faces) — the cellType
// embedded in the key tells the WGSL helper which buffer to read from. Sized to the
// post-octree sub-cell count and uploaded after Pass 11/12/13 dispatch (the dispatch
// indices are the slot values, so the hash builder runs CPU-side after the deduplicated
// sub-cell list is finalized).
@group(0) @binding(20) var<storage, read> subDualHashTable: array<vec2u>;

// Sparse compact list (Phase 5B): slot → linear grid index for each element of the
// dilated set, concatenated by category in the same order as the bases. Drives the
// per-slot dispatch in passes 2/3/4/5/6.
@group(0) @binding(8) var<storage, read> dualCompactList: array<u32>;

// Pass 6 — non-deduplicated mesh output (CPU weld in orchestrator).
@group(0) @binding(3) var<storage, read_write> meshVertices: array<Vertex>;
@group(0) @binding(4) var<storage, read_write> meshIndices: array<u32>;
@group(0) @binding(5) var<storage, read_write> meshIndexCount: atomic<u32>;

// Stage 4 (octree adaptivity foundation): Pass 5 writes per-cube QEF residual here.
// One f32 per active cube, indexed by `local_slot` in `cubeCompactList`. Used by the
// CPU-side adaptive driver to decide which cubes to subdivide. Allocated by the
// orchestrator only when `adaptiveOctree` mode is enabled; bound to Pass 5 unconditionally
// (WGSL strips unused bindings per entry point — when adaptive mode is off, the WGSL
// reference still requires the binding to exist, so the orchestrator allocates a tiny
// 1-element placeholder in the non-adaptive path). Residual = 4D QEF cost at the
// solved spatial position; near-zero on flat regions, large at sharp features and
// CSG seams (precisely the cells the paper §5.1 wants to refine).
@group(0) @binding(9) var<storage, read_write> cubeQefResidual: array<f32>;

// Pass 7 — Newton-project welded vertex positions onto the iso surface
// and write analytical surface normals from sceneSDF_mid. The welded vertex
// array is uploaded by the orchestrator after CPU welding and read back in
// place. Pass 7 fixes the jagged appearance that arises from Marching
// Tetrahedra emitting many tiny slivers whose face-averaged normals would
// otherwise dominate the displayed shading.
@group(0) @binding(7) var<storage, read_write> projectVertices: array<Vertex>;

// Stage 4 Sessions 2 / 5 / 6 / 7: per-child sub-cell descriptors + outputs.
// All descriptors use GLOBAL sub-grid coordinates (parent-independent), enabling
// canonical-owner dedup via Set on the CPU side (`iso-octree.mts`).
// Sub-grid resolution at depth-1 refinement: sub_voxel = base voxel × ½, with
// (2*nx, 2*ny, 2*nz) sub-cells and (2*nx+1, 2*ny+1, 2*nz+1) sub-corners along each axis.
//
// Layouts:
//   childCubeInfo[i]  = vec4u(gsx, gsy, gsz, _padding)
//   childEdgeInfo[i]  = vec4u(gsx, gsy, gsz, axis)   — axis: 0=X, 1=Y, 2=Z (edge direction)
//   childFaceInfo[i]  = vec4u(gsx, gsy, gsz, axis)   — axis: 0=YZ, 1=XZ, 2=XY (perp axis)
//
// Session 7: ALL sub-cell duals live in a single `subCellAllDuals` buffer with bases
// (cube=0, edge=numSubCubes, face=numSubCubes+numSubEdges) supplied via
// `uniforms.subCellBases`. This unification saves 2 bindings vs the original
// per-cell-type buffers, fitting Pass 14 (multi-resolution MT) within the WebGPU
// 10-storage-per-stage default.
@group(0) @binding(11) var<storage, read> childCubeInfo: array<vec4u>;
@group(0) @binding(13) var<storage, read_write> childResiduals: array<f32>;

@group(0) @binding(14) var<storage, read> childEdgeInfo: array<vec4u>;
@group(0) @binding(16) var<storage, read_write> childEdgeResiduals: array<f32>;

@group(0) @binding(17) var<storage, read> childFaceInfo: array<vec4u>;
@group(0) @binding(19) var<storage, read_write> childFaceResiduals: array<f32>;

// Unified sub-cell dual buffer: layout = [N_subCubes sub-cubes | N_subEdges sub-edges
// | N_subFaces sub-faces]. Bases in `uniforms.subCellBases.xyz`. Pass 11/12/13 write
// at base + dispatch_index; `dual_sub_*` helpers read at the absolute slot returned
// by the sub-cell sparse hash.
@group(0) @binding(22) var<storage, read_write> subCellAllDuals: array<DualVertex>;

// Stage 4 Session 8 (storage-budget fix): refinement is now derived from the sub-cell
// hash itself (see `is_base_cube_refined`). The dedicated `cubeRefinedFlags` buffer was
// dropped to free a storage binding so Pass 14 fits under the WebGPU 10-storage-per-stage
// limit. (Binding 21 is intentionally left unused — could be reclaimed for something else.)

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
// Stage 4 Session 6: sub-cell types for the depth-aware sparse hash. Keys are
// `(cellType << 28) | sub_grid_linear_idx`; slots index into the per-axis sub-cell
// output buffers (childDuals, childEdgeDuals, childFaceDuals).
const CELL_TYPE_SUB_CUBE:    u32 = 8u;
const CELL_TYPE_SUB_EDGE_X:  u32 = 9u;
const CELL_TYPE_SUB_EDGE_Y:  u32 = 10u;
const CELL_TYPE_SUB_EDGE_Z:  u32 = 11u;
const CELL_TYPE_SUB_FACE_YZ: u32 = 12u;
const CELL_TYPE_SUB_FACE_XZ: u32 = 13u;
const CELL_TYPE_SUB_FACE_XY: u32 = 14u;
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

// ============================== Stage 4 Session 6: sub-cell hash lookup ==============================
// Sub-cell linear-index helpers. Mirror `iso-octree.mts`'s `subCubeLinearIdx` / family
// exactly so CPU-side hash insertion and GPU-side lookup agree.
//
// The sub-grid at depth-1 refinement has dimensions:
//   sub-cell counts:    sub_nx = 2*nx, sub_ny = 2*ny, sub_nz = 2*nz
//   sub-corner counts:  2*nx + 1, 2*ny + 1, 2*nz + 1
// (where nx/ny/nz are the BASE-grid cell counts from `uniforms.gridDimensions - 1`).

fn sub_cube_linear_idx(gsx: u32, gsy: u32, gsz: u32) -> u32 {
    let nx = uniforms.gridDimensions.x - 1u;
    let ny = uniforms.gridDimensions.y - 1u;
    return gsx + gsy * (2u * nx) + gsz * (2u * nx) * (2u * ny);
}

fn sub_edge_x_linear_idx(gsx: u32, gsy: u32, gsz: u32) -> u32 {
    let nx = uniforms.gridDimensions.x - 1u;
    let ny = uniforms.gridDimensions.y - 1u;
    return gsx + gsy * (2u * nx) + gsz * (2u * nx) * (2u * ny + 1u);
}

fn sub_edge_y_linear_idx(gsx: u32, gsy: u32, gsz: u32) -> u32 {
    let nx = uniforms.gridDimensions.x - 1u;
    let ny = uniforms.gridDimensions.y - 1u;
    return gsx + gsy * (2u * nx + 1u) + gsz * (2u * nx + 1u) * (2u * ny);
}

fn sub_edge_z_linear_idx(gsx: u32, gsy: u32, gsz: u32) -> u32 {
    let nx = uniforms.gridDimensions.x - 1u;
    let ny = uniforms.gridDimensions.y - 1u;
    return gsx + gsy * (2u * nx + 1u) + gsz * (2u * nx + 1u) * (2u * ny + 1u);
}

fn sub_face_yz_linear_idx(gsx: u32, gsy: u32, gsz: u32) -> u32 {
    let nx = uniforms.gridDimensions.x - 1u;
    let ny = uniforms.gridDimensions.y - 1u;
    return gsx + gsy * (2u * nx + 1u) + gsz * (2u * nx + 1u) * (2u * ny);
}

fn sub_face_xz_linear_idx(gsx: u32, gsy: u32, gsz: u32) -> u32 {
    let nx = uniforms.gridDimensions.x - 1u;
    let ny = uniforms.gridDimensions.y - 1u;
    return gsx + gsy * (2u * nx) + gsz * (2u * nx) * (2u * ny + 1u);
}

fn sub_face_xy_linear_idx(gsx: u32, gsy: u32, gsz: u32) -> u32 {
    let nx = uniforms.gridDimensions.x - 1u;
    let ny = uniforms.gridDimensions.y - 1u;
    return gsx + gsy * (2u * nx) + gsz * (2u * nx) * (2u * ny);
}

/// Hash-table lookup for a (subCellType, subLinearIdx) pair. Returns the slot index
/// in the appropriate sub-cell output buffer (childDuals / childEdgeDuals /
/// childFaceDuals — caller's responsibility to read from the right one based on
/// cellType), or `SPARSE_HASH_EMPTY` if the sub-cell isn't in the dedup'd set.
fn lookup_sub_dual_slot(key: u32) -> u32 {
    let mask = uniforms.subSparseHash.x;
    if (mask == 0u) {
        // No sub-cells exist (non-adaptive run, or all cubes below threshold).
        return SPARSE_HASH_EMPTY;
    }
    var slot = (key * SPARSE_HASH_KNUTH) & mask;
    for (var probe = 0u; probe < 256u; probe = probe + 1u) {
        let entry = subDualHashTable[slot];
        if (entry.x == key) { return entry.y; }
        if (entry.x == SPARSE_HASH_EMPTY) { return SPARSE_HASH_EMPTY; }
        slot = (slot + 1u) & mask;
    }
    return SPARSE_HASH_EMPTY;
}

/// Read a sub-cube DualVertex at global sub-grid coords (gsx, gsy, gsz). Returns
/// a synthetic zero-valued vertex if not in the sub-cell set (most cubes won't be
/// refined, so most lookups return EMPTY — caller handles that case). All sub-cell
/// duals live in the unified `subCellAllDuals` buffer; the slot returned by the hash
/// is an absolute index into that buffer.
fn dual_sub_cube(gsx: u32, gsy: u32, gsz: u32) -> DualVertex {
    let slot = lookup_sub_dual_slot(make_sparse_key(CELL_TYPE_SUB_CUBE, sub_cube_linear_idx(gsx, gsy, gsz)));
    if (slot == SPARSE_HASH_EMPTY) { return DualVertex(vec3f(0.0), 0.0); }
    return subCellAllDuals[slot];
}

fn dual_sub_edge_x(gsx: u32, gsy: u32, gsz: u32) -> DualVertex {
    let slot = lookup_sub_dual_slot(make_sparse_key(CELL_TYPE_SUB_EDGE_X, sub_edge_x_linear_idx(gsx, gsy, gsz)));
    if (slot == SPARSE_HASH_EMPTY) { return DualVertex(vec3f(0.0), 0.0); }
    return subCellAllDuals[slot];
}

fn dual_sub_edge_y(gsx: u32, gsy: u32, gsz: u32) -> DualVertex {
    let slot = lookup_sub_dual_slot(make_sparse_key(CELL_TYPE_SUB_EDGE_Y, sub_edge_y_linear_idx(gsx, gsy, gsz)));
    if (slot == SPARSE_HASH_EMPTY) { return DualVertex(vec3f(0.0), 0.0); }
    return subCellAllDuals[slot];
}

fn dual_sub_edge_z(gsx: u32, gsy: u32, gsz: u32) -> DualVertex {
    let slot = lookup_sub_dual_slot(make_sparse_key(CELL_TYPE_SUB_EDGE_Z, sub_edge_z_linear_idx(gsx, gsy, gsz)));
    if (slot == SPARSE_HASH_EMPTY) { return DualVertex(vec3f(0.0), 0.0); }
    return subCellAllDuals[slot];
}

fn dual_sub_face_yz(gsx: u32, gsy: u32, gsz: u32) -> DualVertex {
    let slot = lookup_sub_dual_slot(make_sparse_key(CELL_TYPE_SUB_FACE_YZ, sub_face_yz_linear_idx(gsx, gsy, gsz)));
    if (slot == SPARSE_HASH_EMPTY) { return DualVertex(vec3f(0.0), 0.0); }
    return subCellAllDuals[slot];
}

fn dual_sub_face_xz(gsx: u32, gsy: u32, gsz: u32) -> DualVertex {
    let slot = lookup_sub_dual_slot(make_sparse_key(CELL_TYPE_SUB_FACE_XZ, sub_face_xz_linear_idx(gsx, gsy, gsz)));
    if (slot == SPARSE_HASH_EMPTY) { return DualVertex(vec3f(0.0), 0.0); }
    return subCellAllDuals[slot];
}

fn dual_sub_face_xy(gsx: u32, gsy: u32, gsz: u32) -> DualVertex {
    let slot = lookup_sub_dual_slot(make_sparse_key(CELL_TYPE_SUB_FACE_XY, sub_face_xy_linear_idx(gsx, gsy, gsz)));
    if (slot == SPARSE_HASH_EMPTY) { return DualVertex(vec3f(0.0), 0.0); }
    return subCellAllDuals[slot];
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

/// Stage 4 Session 7: returns true iff this base cube has been subdivided (octree
/// produced sub-cubes inside it). Pass 6 skips edges where any of the 4 surrounding
/// base cubes is refined; Pass 14 uses this to decide between sub-cube and base-cube
/// dual lookups. Bit-packed: 1 bit per base cube, indexed by base cube linear idx
/// (cx + cy*nx + cz*nx*ny). Returns false out-of-range or when the buffer is the
/// 1-element placeholder (non-adaptive mode → no cubes refined → all return false).
/// Session 8 (storage-budget fix): refinement is derived from the sub-cell sparse hash
/// rather than a dedicated `cubeRefinedFlags` buffer. A refined parent always has all 8
/// of its sub-cubes in the hash (Pass 11 wrote them), so testing whether the LL-corner
/// sub-cube `(2*bcx, 2*bcy, 2*bcz)` is in the hash is equivalent to "is this base cube
/// refined". Drops one storage binding so Pass 14 fits under the 10-per-stage limit.
/// When the hash is empty (mask=0, e.g. non-adaptive runs), `lookup_sub_dual_slot`
/// short-circuits to EMPTY → returns false → Pass 6 emits as standard non-adaptive MT.
fn is_base_cube_refined(base_cx: u32, base_cy: u32, base_cz: u32) -> bool {
    let key = make_sparse_key(CELL_TYPE_SUB_CUBE, sub_cube_linear_idx(base_cx * 2u, base_cy * 2u, base_cz * 2u));
    return lookup_sub_dual_slot(key) != SPARSE_HASH_EMPTY;
}

/// Phase 5: returns true iff ANY of the 4 base cubes around a given X/Y/Z base edge is
/// refined. Pass 6 uses this to skip base edges adjacent to refined cubes — those edges'
/// tets are non-minimal and Pass 15 emits the equivalent sub-resolution tets via its
/// per-minimal-cube walk (which includes the unrefined neighbours of refined cubes).
///
/// Pass 6 + Pass 15 form a partition of mesh emission: every minimal cube's tets are
/// emitted by exactly one of them, never both, never neither. Pass 6 handles unrefined
/// cubes whose neighbours are also all unrefined (the all-base-cells common case). Pass 15
/// handles refined cubes' sub-cubes plus any unrefined cubes that border a refined region.
///
/// If a referenced cube is out of bounds (the edge sits on the global grid boundary), it
/// counts as unrefined → returns false → Pass 6 emits as usual.
fn any_cube_around_x_edge_refined(ex: u32, ey: u32, ez: u32, dx: u32, dy: u32, dz: u32) -> bool {
    // 4 cubes around X-edge at (ex, ey, ez)→(ex+1, ey, ez):
    //   A=(ex, ey-1, ez-1), B=(ex, ey, ez-1), C=(ex, ey-1, ez), D=(ex, ey, ez)
    let nx = dx - 1u;
    let ny = dy - 1u;
    let nz = dz - 1u;
    if (ex < nx && ey < ny && ez < nz) {
        if (is_base_cube_refined(ex, ey, ez)) { return true; }
    }
    if (ex < nx && ey >= 1u && ey - 1u < ny && ez < nz) {
        if (is_base_cube_refined(ex, ey - 1u, ez)) { return true; }
    }
    if (ex < nx && ey < ny && ez >= 1u && ez - 1u < nz) {
        if (is_base_cube_refined(ex, ey, ez - 1u)) { return true; }
    }
    if (ex < nx && ey >= 1u && ey - 1u < ny && ez >= 1u && ez - 1u < nz) {
        if (is_base_cube_refined(ex, ey - 1u, ez - 1u)) { return true; }
    }
    return false;
}

fn any_cube_around_y_edge_refined(ex: u32, ey: u32, ez: u32, dx: u32, dy: u32, dz: u32) -> bool {
    let nx = dx - 1u;
    let ny = dy - 1u;
    let nz = dz - 1u;
    if (ex < nx && ey < ny && ez < nz) {
        if (is_base_cube_refined(ex, ey, ez)) { return true; }
    }
    if (ex >= 1u && ex - 1u < nx && ey < ny && ez < nz) {
        if (is_base_cube_refined(ex - 1u, ey, ez)) { return true; }
    }
    if (ex < nx && ey < ny && ez >= 1u && ez - 1u < nz) {
        if (is_base_cube_refined(ex, ey, ez - 1u)) { return true; }
    }
    if (ex >= 1u && ex - 1u < nx && ey < ny && ez >= 1u && ez - 1u < nz) {
        if (is_base_cube_refined(ex - 1u, ey, ez - 1u)) { return true; }
    }
    return false;
}

fn any_cube_around_z_edge_refined(ex: u32, ey: u32, ez: u32, dx: u32, dy: u32, dz: u32) -> bool {
    let nx = dx - 1u;
    let ny = dy - 1u;
    let nz = dz - 1u;
    if (ex < nx && ey < ny && ez < nz) {
        if (is_base_cube_refined(ex, ey, ez)) { return true; }
    }
    if (ex >= 1u && ex - 1u < nx && ey < ny && ez < nz) {
        if (is_base_cube_refined(ex - 1u, ey, ez)) { return true; }
    }
    if (ex < nx && ey >= 1u && ey - 1u < ny && ez < nz) {
        if (is_base_cube_refined(ex, ey - 1u, ez)) { return true; }
    }
    if (ex >= 1u && ex - 1u < nx && ey >= 1u && ey - 1u < ny && ez < nz) {
        if (is_base_cube_refined(ex - 1u, ey - 1u, ez)) { return true; }
    }
    return false;
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
    /// Σᵢ (n̄ᵢ · p̄ᵢ)² — the constant offset in ‖Ax̄ − b‖². Needed by `qefCost4` to
    /// return the true non-negative squared residual (Stage 4 octree subdivision driver
    /// thresholds against this). Without it the cost is x̄ᵀATAx̄ − 2x̄ᵀATb, which evaluates
    /// to −x*ᵀATb at the minimum — generally negative and uninformative for refinement.
    bsq: f32,
}

fn qef4_zero() -> QEF4Data {
    return QEF4Data(mat3x3f(), vec3f(0.0), 0.0, vec3f(0.0), 0.0, vec3f(0.0), 0u, 0.0);
}

/// Accumulate one tangent-hyperplane sample (p, ∇F(p), F(p)) into the 4D QEF.
/// Caller is responsible for projecting the gradient onto the cell's subspace
/// (e.g. zero out off-axis components for face/edge cells) before calling this.
fn qef4_add(qef: ptr<function, QEF4Data>, p: vec3f, g: vec3f, fval: f32) {
    let dp = dot(g, p) - fval;       // = n̄ · p̄  (the scalar appearing in ATb rows)
    (*qef).ATA3[0] = (*qef).ATA3[0] + g * g.x;
    (*qef).ATA3[1] = (*qef).ATA3[1] + g * g.y;
    (*qef).ATA3[2] = (*qef).ATA3[2] + g * g.z;
    (*qef).g_col = (*qef).g_col - g;     // accumulating −Σ g
    (*qef).n_count = (*qef).n_count + 1.0;
    (*qef).ATb3 = (*qef).ATb3 + g * dp;
    (*qef).ATb4 = (*qef).ATb4 - dp;      // = Σ (F − g·p)
    (*qef).massPoint = (*qef).massPoint + p;
    (*qef).numPoints = (*qef).numPoints + 1u;
    (*qef).bsq = (*qef).bsq + dp * dp;   // Σᵢ (n̄ᵢ·p̄ᵢ)² — see struct doc above
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

/// 4D QEF residual at point `x4 = ⟨x, F⟩`: the sum-of-squared-perpendicular-distances
/// from x̄ to each tangent hyperplane the QEF was built from. Equals
///     residual = ‖A·x̄ − b‖² = x̄ᵀ·ATA·x̄ − 2·x̄ᵀ·ATb + Σᵢ (n̄ᵢ·p̄ᵢ)²
/// where the trailing constant `Σ (n̄ᵢ·p̄ᵢ)²` is accumulated as `qef.bsq` during
/// `qef4_add`. The result is non-negative for any input x̄ — a meaningful curvature
/// measure for Stage 4 octree refinement (small for flat / linearly-fitable regions,
/// large where multiple tangent planes disagree i.e. high curvature or sharp features).
fn qefCost4(qef: QEF4Data, x4: vec4f) -> f32 {
    // Reconstruct the full 4×4 ATA matrix-vector product Ax₄ from the block decomposition.
    let Ax_top = qef.ATA3 * x4.xyz + qef.g_col * x4.w;
    let Ax_w = dot(qef.g_col, x4.xyz) + qef.n_count * x4.w;
    let Ax = vec4f(Ax_top, Ax_w);
    let b = vec4f(qef.ATb3, qef.ATb4);
    return dot(x4, Ax) - 2.0 * dot(x4, b) + qef.bsq;
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
    if (qef.numPoints < 2u) {
        // Truly empty system; nothing to fit. Cells with this few samples should
        // never reach this entry point in practice.
        return vec4f(mass, 0.0);
    }
    // For 2 ≤ numPoints < 4, ATA is rank-deficient in some dimensions — but
    // for sub-3D cells (1-cells/2-cells) that's the EXPECTED case after the
    // gradient projection, and Tikhonov regularization (added below) plus the
    // mass-point bias term handle the unconstrained dimensions correctly:
    //   - Edge cells (Pass 3): 3 samples × edge-projected gradient → rank-2
    //     ATA (along-edge + F). Solver returns iso-crossing along edge for
    //     the 1 constrained spatial dim and mass-point values for the other 2.
    //   - Face cells (Pass 4): 2–4 samples × face-projected gradient → rank-3
    //     ATA (face-u + face-v + F). Off-face dim falls back to mass-point.
    //   - Cube cells (Pass 5): 4–12 samples × full gradient → rank-3 to 4.
    // The earlier `< 4u` cutoff caused edges and most faces to fall back
    // wholesale to the cell centroid, losing iso-crossing alignment that
    // Phase 1 already had — that was a regression visible as a "smoothed"
    // contour following grid centers rather than the iso surface.

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
        // Reserve three contiguous Vertex/u32 slots before writing. A prior version used
        // atomicAdd then bounds-checked and continued — that incremented `meshIndexCount`
        // without writing vertices/indices, so readback saw a larger count than populated
        // slots (stale/garbage indices → triangles fanning to one vertex).
        let len = arrayLength(&meshVertices);
        var base = 0xffffffffu;
        loop {
            let cur = atomicLoad(&meshIndexCount);
            if (cur + 3u > len) {
                base = 0xffffffffu;
                break;
            }
            let res = atomicCompareExchangeWeak(&meshIndexCount, cur, cur + 3u);
            if (res.exchanged) {
                base = cur;
                break;
            }
        }
        if (base == 0xffffffffu) {
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
        // Stage 4: inactive cubes (no iso intersection) never refine. Residual 0
        // distinguishes them from active-but-flat cubes (which write a small but
        // possibly-positive residual below).
        cubeQefResidual[local_slot] = 0.0;
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

    // Stage 4: per-cube QEF residual at the (clamped) solution. Used CPU-side by the
    // adaptive octree driver to drive subdivision (paper §5.1: refine cubes whose dual
    // residual exceeds threshold). Residual is computed at the post-clamp `pos` paired
    // with the QEF-predicted F* (`solution.w`), so the metric reflects how well the
    // clamped position fits the local SDF tangent planes — i.e. how curved/sharp this
    // cube actually is. Flat regions: residual ≈ 0. Sharp features clamped to the cell
    // boundary: residual ≫ 0 (signalling "feature wants to live outside this cell").
    let x4_solved = vec4f(pos, solution.w);
    cubeQefResidual[local_slot] = qefCost4(qef4, x4_solved);
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
// → edges (depend on corners). 0-cells (corners) never move. Cube improvement (Pass 10)
// must dispatch BEFORE face/edge improvement (Pass 9 / Pass 8) — otherwise its
// topology test would partition by relaxed near-zero fvals on its boundary and lose
// the inside/outside sign distinction.
//
// Topology safety tests:
//   - Edge (Pass 8):  endpoint corners have opposite sign       (1 sign-change pair)
//   - Face (Pass 9):  4-corner ring has exactly 2 sign changes  (single contour segment)
//   - Cube (Pass 10): Union-Find on 26 boundary duals shows ≤1 component per side
//                     (iso surface in cube is a single topological disk)
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

    // Sharp-feature gate: Phase 4 places the edge dual at the QEF-optimal point along the
    // edge. For edges that pass through a sharp feature (CSG seam, box edge, polygon corner)
    // the QEF position has F* ≠ 0 — that's the algorithm's signal that this is a sharp
    // intersection that should be preserved, NOT relaxed onto the smooth iso surface.
    // Empirically `|fval| > 0.05 × voxel` is a reliable sharp-feature detector that's still
    // generous enough to relax all smooth-surface duals.
    let edge_dual = allDuals[absolute_slot];
    let sharp_eps = uniforms.voxelSize * 5e-2;
    if (abs(edge_dual.fval) > sharp_eps) {
        return;
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
    // Store the ACTUAL F value at the bisected position (small but non-zero) rather than
    // forcing fval=0. Setting fval=0 makes MT crossings on adjacent tet edges all land at
    // the dual position — coincident vertices that GPU degen-skip then drops, leaving
    // visible holes around the relaxed dual. Preserving the small actual fval keeps MT
    // crossings near (but not at) the dual, so triangles survive.
    let f_at_pos = sceneSDF_fast(pos).d - uniforms.isoValue;
    write_dual_slot(absolute_slot, DualVertex(pos, f_at_pos));
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

    // See improveEdgeDuals_Pass8 sharp-feature gate.
    let sharp_eps = uniforms.voxelSize * 5e-2;
    if (abs(face_f) > sharp_eps) {
        return;
    }

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
    let f_at_pos = sceneSDF_fast(pos).d - uniforms.isoValue;
    write_dual_slot(absolute_slot, DualVertex(pos, f_at_pos));
}

// ============================== Pass 10: Cube dual improvement (paper §4.1, cube case) ==============================
//
// Move the cube dual onto the iso surface only when the boundary topology test passes.
// The boundary of a cube has 26 dual vertices of dimension i<3:
//   8 corners + 12 edge duals + 6 face duals
// connected by simplicial-subdivision graph edges from each cube face's barycentric
// triangulation: per face, 4 (corner-edge_dual) + 4 (edge_dual-face_dual) + 4
// (corner-face_dual) = 12 graph edges; 6 faces × 12 = 72 with shared duplicates that
// Union-Find harmlessly no-ops.
//
// Topology test: partition the 26 boundary vertices by sign(fval) and run Union-Find on
// graph edges where both endpoints share a sign. The test passes iff each side has at
// most one connected component — i.e., the iso surface inside the cube forms a single
// topological disk and pinching the cube dual onto it cannot create a non-manifold vertex
// (paper Figure 7 / 8).
//
// MUST run before Pass 9 / Pass 8 — those modify face / edge dual fvals (relax onto iso),
// after which the topology test would see ambiguous near-zero signs.
//
// Boundary vertex indexing into parent[26]:
//   0..7   = 8 corners (matching getCellCornerPos)
//   8..19  = 12 edge duals (4 X-edges, 4 Y-edges, 4 Z-edges; matching cube_edges_v)
//   20..25 = 6 face duals (-X, +X, -Y, +Y, -Z, +Z)

const CUBE_FACE_CORNERS: array<vec4u, 6> = array<vec4u, 6>(
    vec4u(0u, 2u, 6u, 4u),  // -X face (x=cx),     CCW from outside
    vec4u(1u, 5u, 7u, 3u),  // +X face (x=cx+1)
    vec4u(0u, 4u, 5u, 1u),  // -Y face (y=cy)
    vec4u(2u, 3u, 7u, 6u),  // +Y face (y=cy+1)
    vec4u(0u, 1u, 3u, 2u),  // -Z face (z=cz)
    vec4u(4u, 6u, 7u, 5u),  // +Z face (z=cz+1)
);

// CUBE_FACE_EDGE_LOCALS[f][i] = the cube edge index (0..11) for the face edge between
// CUBE_FACE_CORNERS[f][i] and CUBE_FACE_CORNERS[f][(i+1)%4]. Cube edge numbering matches
// edges_v in placeCubeDuals_Pass5 (0..3=X, 4..7=Y, 8..11=Z).
const CUBE_FACE_EDGE_LOCALS: array<vec4u, 6> = array<vec4u, 6>(
    vec4u(4u, 10u, 6u,  8u),  // -X
    vec4u(9u, 7u,  11u, 5u),  // +X
    vec4u(8u, 2u,  9u,  0u),  // -Y
    vec4u(1u, 11u, 3u,  10u), // +Y
    vec4u(0u, 5u,  1u,  4u),  // -Z
    vec4u(6u, 3u,  7u,  2u),  // +Z
);

// Base offsets for the cube's 12 edges (low-coordinate endpoint relative to cell_pos).
// edges 0..3 are X-edges (vary in x), 4..7 are Y-edges, 8..11 are Z-edges.
const CUBE_EDGE_BASE: array<vec3u, 12> = array<vec3u, 12>(
    vec3u(0u, 0u, 0u), vec3u(0u, 1u, 0u), vec3u(0u, 0u, 1u), vec3u(0u, 1u, 1u),  // X-edges
    vec3u(0u, 0u, 0u), vec3u(1u, 0u, 0u), vec3u(0u, 0u, 1u), vec3u(1u, 0u, 1u),  // Y-edges
    vec3u(0u, 0u, 0u), vec3u(1u, 0u, 0u), vec3u(0u, 1u, 0u), vec3u(1u, 1u, 0u),  // Z-edges
);

/// Linear (per-category) grid index for the cube's `edge_i`-th edge. Caller passes
/// `cube_edge_cell_type(edge_i)` separately to read the dual.
fn cube_edge_grid_index(cell_pos: vec3u, edge_i: u32, dx: u32, dy: u32) -> u32 {
    let p = cell_pos + CUBE_EDGE_BASE[edge_i];
    if (edge_i < 4u) {
        // X-edge: count = (dx-1) * dy * dz, indexed x + y*(dx-1) + z*(dx-1)*dy
        return p.x + p.y * (dx - 1u) + p.z * (dx - 1u) * dy;
    } else if (edge_i < 8u) {
        // Y-edge: count = dx * (dy-1) * dz, indexed x + y*dx + z*dx*(dy-1)
        return p.x + p.y * dx + p.z * dx * (dy - 1u);
    } else {
        // Z-edge: count = dx * dy * (dz-1), indexed x + y*dx + z*dx*dy
        return p.x + p.y * dx + p.z * dx * dy;
    }
}

fn cube_edge_cell_type(edge_i: u32) -> u32 {
    if (edge_i < 4u) { return CELL_TYPE_EDGE_X; }
    if (edge_i < 8u) { return CELL_TYPE_EDGE_Y; }
    return CELL_TYPE_EDGE_Z;
}

/// Linear (per-category) grid index for the cube's `face_i`-th face.
/// face_i 0=-X, 1=+X (YZ planes); 2=-Y, 3=+Y (XZ planes); 4=-Z, 5=+Z (XY planes).
fn cube_face_grid_index(cell_pos: vec3u, face_i: u32, dx: u32, dy: u32) -> u32 {
    if (face_i < 2u) {
        let p = vec3u(cell_pos.x + face_i, cell_pos.y, cell_pos.z);
        return p.x + p.y * dx + p.z * dx * (dy - 1u);
    } else if (face_i < 4u) {
        let p = vec3u(cell_pos.x, cell_pos.y + (face_i - 2u), cell_pos.z);
        return p.x + p.y * (dx - 1u) + p.z * (dx - 1u) * dy;
    } else {
        let p = vec3u(cell_pos.x, cell_pos.y, cell_pos.z + (face_i - 4u));
        return p.x + p.y * (dx - 1u) + p.z * (dx - 1u) * (dy - 1u);
    }
}

fn cube_face_cell_type(face_i: u32) -> u32 {
    if (face_i < 2u) { return CELL_TYPE_FACE_YZ; }
    if (face_i < 4u) { return CELL_TYPE_FACE_XZ; }
    return CELL_TYPE_FACE_XY;
}

/// 26-element Union-Find with one-step path compression. Iterating to fixpoint is fine
/// in WGSL because the tree depth is bounded by `log₂(26) ≈ 5` after path compression.
fn ufFindCube(parent: ptr<function, array<u32, 26>>, x: u32) -> u32 {
    var i = x;
    var p = (*parent)[i];
    while (p != i) {
        let pp = (*parent)[p];
        (*parent)[i] = pp;
        i = p;
        p = pp;
    }
    return i;
}

fn ufUnionCube(parent: ptr<function, array<u32, 26>>, a: u32, b: u32) {
    let ra = ufFindCube(parent, a);
    let rb = ufFindCube(parent, b);
    if (ra != rb) {
        (*parent)[ra] = rb;
    }
}

@compute @workgroup_size(64, 1, 1)
fn improveCubeDuals_Pass10(
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

    // Sharp-feature gate (matches Pass 8/9). Pass 5 places the cube dual at the
    // QEF-optimal point; if F* there is significantly non-zero, this cube contains a
    // sharp feature (CSG seam, box edge interior). Don't relax it onto the smooth iso.
    let cube_dual = allDuals[absolute_slot];
    let sharp_eps = uniforms.voxelSize * 5e-2;
    if (abs(cube_dual.fval) > sharp_eps) {
        return;
    }

    // Read all 26 boundary duals' fvals (and positions, for later bisection target choice).
    // 0..7 = corners, 8..19 = edge duals, 20..25 = face duals.
    var fvals: array<f32, 26>;
    var positions: array<vec3f, 26>;

    // Corners
    for (var i = 0u; i < 8u; i = i + 1u) {
        let g = getCellCornerPos(cell_pos, i);
        let world_p = gridPosToWorldPos(g);
        let dv = dual_corner(gridPosToIndex(g));
        fvals[i] = dv.fval;
        positions[i] = world_p;
    }

    // Edge duals
    for (var e = 0u; e < 12u; e = e + 1u) {
        let cell_type = cube_edge_cell_type(e);
        let grid_i = cube_edge_grid_index(cell_pos, e, dx, dy);
        let dv = read_dual(cell_type, grid_i);
        fvals[8u + e] = dv.fval;
        positions[8u + e] = dv.pos;
    }

    // Face duals
    for (var f = 0u; f < 6u; f = f + 1u) {
        let cell_type = cube_face_cell_type(f);
        let grid_i = cube_face_grid_index(cell_pos, f, dx, dy);
        let dv = read_dual(cell_type, grid_i);
        fvals[20u + f] = dv.fval;
        positions[20u + f] = dv.pos;
    }

    // Per-vertex sign: 1u = outside (fval > 0), 0u = inside. (We're on Pass 5/3/4 fvals
    // here, before any relax-to-iso, so signs are unambiguous well away from zero. Even
    // for vertices at exactly zero we make a deterministic choice — the Union-Find
    // outcome only matters for the topology check, where degenerate singletons won't
    // form additional components beyond the two well-defined sides.)
    var signs: array<u32, 26>;
    for (var v = 0u; v < 26u; v = v + 1u) {
        signs[v] = select(0u, 1u, fvals[v] > 0.0);
    }

    // Initialize Union-Find with each vertex as its own component.
    var parent: array<u32, 26>;
    for (var v = 0u; v < 26u; v = v + 1u) {
        parent[v] = v;
    }

    // Process the 6 face triangulations, unioning same-side endpoints of each graph edge.
    for (var f = 0u; f < 6u; f = f + 1u) {
        let face_dual_v = 20u + f;
        let s_face = signs[face_dual_v];
        for (var k = 0u; k < 4u; k = k + 1u) {
            let corner_a_v = CUBE_FACE_CORNERS[f][k];
            let corner_b_v = CUBE_FACE_CORNERS[f][(k + 1u) % 4u];
            let edge_v = 8u + CUBE_FACE_EDGE_LOCALS[f][k];

            // corner_a — edge_dual
            if (signs[corner_a_v] == signs[edge_v]) {
                ufUnionCube(&parent, corner_a_v, edge_v);
            }
            // corner_b — edge_dual
            if (signs[corner_b_v] == signs[edge_v]) {
                ufUnionCube(&parent, corner_b_v, edge_v);
            }
            // edge_dual — face_dual
            if (signs[edge_v] == s_face) {
                ufUnionCube(&parent, edge_v, face_dual_v);
            }
            // corner_a — face_dual
            if (signs[corner_a_v] == s_face) {
                ufUnionCube(&parent, corner_a_v, face_dual_v);
            }
        }
    }

    // Count distinct roots per side. We expect ≤2 roots total in a well-formed cube;
    // a small fixed bound is safer than dynamic allocation in WGSL.
    var inside_root_count = 0u;
    var outside_root_count = 0u;
    var inside_roots: array<u32, 8>;
    var outside_roots: array<u32, 8>;

    for (var v = 0u; v < 26u; v = v + 1u) {
        let r = ufFindCube(&parent, v);
        if (signs[v] == 0u) {
            var found = false;
            for (var k = 0u; k < inside_root_count; k = k + 1u) {
                if (inside_roots[k] == r) { found = true; break; }
            }
            if (!found && inside_root_count < 8u) {
                inside_roots[inside_root_count] = r;
                inside_root_count = inside_root_count + 1u;
            }
        } else {
            var found = false;
            for (var k = 0u; k < outside_root_count; k = k + 1u) {
                if (outside_roots[k] == r) { found = true; break; }
            }
            if (!found && outside_root_count < 8u) {
                outside_roots[outside_root_count] = r;
                outside_root_count = outside_root_count + 1u;
            }
        }
    }

    // Topology test: each side ≤ 1 connected component. (0 components is fine — that
    // side is empty, e.g. all corners outside, surface a single sheet entering only via
    // edge / face duals; relaxing the cube dual onto iso just collapses an isolated
    // disk to a point, which is still manifold per paper Figure 8.)
    if (inside_root_count > 1u || outside_root_count > 1u) {
        return;
    }

    // Pick the bisection target: boundary vertex with opposite sign to the cube dual,
    // smallest |fval| (closest to iso → bisection converges fastest and lands near the
    // existing surface region rather than yanking across the cell).
    let cube_sign = select(0u, 1u, cube_dual.fval > 0.0);
    var best_v = 26u;
    var best_abs_f = 1e30f;
    for (var v = 0u; v < 26u; v = v + 1u) {
        if (signs[v] == cube_sign) { continue; }
        let af = abs(fvals[v]);
        if (af < best_abs_f) {
            best_abs_f = af;
            best_v = v;
        }
    }
    if (best_v >= 26u) {
        // No opposite-sign neighbor (would imply both topology counts are 0/1 with all
        // same sign — a closed disconnected pocket). Leave dual where Pass 5 placed it.
        return;
    }

    // Bisect from cube dual (current side) toward best_v (opposite side).
    var lo = cube_dual.pos;
    var hi = positions[best_v];
    var fl = cube_dual.fval;
    var fh = fvals[best_v];
    if (fl > 0.0) {
        let tp = lo; lo = hi; hi = tp;
        let tf = fl; fl = fh; fh = tf;
    }
    let pos = bisect_to_iso(lo, hi, fl, fh);
    let f_at_pos = sceneSDF_fast(pos).d - uniforms.isoValue;
    write_dual_slot(absolute_slot, DualVertex(pos, f_at_pos));
}

// ============================== Pass 11 (Stage 4 Session 2): GPU sub-cube dual placement ==============================
//
// Manson & Schaefer §5.1 adaptive octree, GPU side: for each child sub-cube the CPU
// driver flagged for refinement (depth ≥ 1 leaves of the octree built after Pass 5),
// place a child cube dual via the same 4D-QEF-on-iso-crossings recipe `placeCubeDuals`
// uses at base resolution, but at sub-voxel scale within the parent cube.
//
// Session 2 limitation: descriptor encodes one level of refinement only — `octant`
// 0..7 selects an immediate child of the parent base cube. Sub-voxel = base voxel × ½.
// Deeper refinement (grand-children at depth 2+) needs a richer descriptor and arrives
// in Session 3 along with the multi-resolution Marching Tetrahedra rewrite of Pass 6.
//
// The output `childDuals[i]` and `childResiduals[i]` live in a buffer parallel to the
// CPU child list — i.e. `childDuals[i]` is the dual for `childCubeInfo[i]`. Mesh output
// is unchanged in Session 2: Pass 6 still walks the base-grid edges and uses base-cube
// duals only. The child duals exist so the user (and Session 3+) can verify refinement
// is producing meaningful per-cube placements via the residual histogram.
@compute @workgroup_size(64, 1, 1)
fn placeChildCubeDuals_Pass11(
    @builtin(global_invocation_id) globalId: vec3u,
    @builtin(num_workgroups) numWg: vec3u,
) {
    if (isCancelled()) {
        return;
    }
    let i = globalId.x + globalId.y * (numWg.x * 64u);
    let n = arrayLength(&childCubeInfo);
    if (i >= n) {
        return;
    }

    let info = childCubeInfo[i];
    let gsx = info.x;
    let gsy = info.y;
    let gsz = info.z;

    // Global sub-grid coords → world position. Sub-voxel = base voxel × ½ at depth-1.
    // Sub-grid origin matches base grid origin: world(gsx) = gridOffset + gsx × sub_voxel.
    let sub_voxel = uniforms.voxelSize * 0.5;
    let sub_min = uniforms.gridOffset + vec3f(f32(gsx), f32(gsy), f32(gsz)) * sub_voxel;
    let sub_max = sub_min + vec3f(sub_voxel);

    let eps = max(uniforms.mdcF0.x, 1e-6);
    let t_max = 1.0 - eps;
    let shrink = sub_voxel * eps;
    let clamp_min = sub_min + vec3f(shrink);
    let clamp_max = sub_max - vec3f(shrink);

    // Sample the 8 sub-cube corners' shifted SDF values (no gradient yet — gradient is
    // only sampled at iso-crossings below, where the QEF tangent plane is actually
    // built). `_fast` is enough for the sign + interpolation `t`.
    var sub_corners: array<vec3f, 8>;
    var sub_fvals: array<f32, 8>;
    for (var c = 0u; c < 8u; c = c + 1u) {
        let off = vec3f(
            f32(c & 1u),
            f32((c >> 1u) & 1u),
            f32((c >> 2u) & 1u),
        );
        let p = sub_min + off * sub_voxel;
        sub_corners[c] = p;
        sub_fvals[c] = sceneSDF_fast(p).d - uniforms.isoValue;
    }

    // Edge index pairs match `placeCubeDuals_Pass5`'s `edges_v` so the QEF-residual
    // metric is comparable across depths.
    let edges_v = array<vec2u, 12>(
        vec2u(0u, 1u), vec2u(2u, 3u), vec2u(4u, 5u), vec2u(6u, 7u),
        vec2u(0u, 2u), vec2u(1u, 3u), vec2u(4u, 6u), vec2u(5u, 7u),
        vec2u(0u, 4u), vec2u(1u, 5u), vec2u(2u, 6u), vec2u(3u, 7u),
    );

    var qef4 = qef4_zero();
    for (var e = 0u; e < 12u; e = e + 1u) {
        let a = edges_v[e].x;
        let b = edges_v[e].y;
        let f0 = sub_fvals[a];
        let f1 = sub_fvals[b];
        if (sdf_sign_bit_positive(f0) == sdf_sign_bit_positive(f1)) {
            continue;
        }
        let denom = f1 - f0;
        var t = 0.5;
        if (abs(denom) > 1e-20) {
            t = clamp(-f0 / denom, eps, t_max);
        }
        let pw = mix3f(sub_corners[a], sub_corners[b], t);
        let sdf_m = sceneSDF_mid(pw);
        qef4_add(&qef4, pw, sdf_m.n, sdf_m.d - uniforms.isoValue);
    }

    let solution = solveQEF4(qef4);
    let pos = clamp(solution.xyz, clamp_min, clamp_max);
    let f_shifted = sceneSDF_fast(pos).d - uniforms.isoValue;
    // Stage 4 Session 7: write to unified `subCellAllDuals` at the cube base + index.
    subCellAllDuals[uniforms.subCellBases.x + i] = DualVertex(pos, f_shifted);

    let x4_solved = vec4f(pos, solution.w);
    childResiduals[i] = qefCost4(qef4, x4_solved);
}

// ============================== Pass 12 (Stage 4 Session 5): GPU sub-edge dual placement ==============================
//
// Mirrors `placeEdgeDuals_Pass3`'s 4D-QEF-with-edge-projected-gradient approach but at
// sub-voxel resolution within a refined parent cube. One thread per sub-edge descriptor
// in `childEdgeInfo`. Sub-edge has 2 endpoints; we sample at each endpoint plus the
// midpoint (or iso-crossing if there's a sign change), build a 4D QEF on the
// edge-direction-projected gradients, solve, and project back onto the edge axis.
//
// Session 5 limitation (matches Session 2): depth-1 only. Sub-voxel = base voxel × ½.
// Per-parent emission means a sub-edge shared between two refined parents gets placed
// twice; Session 6 will add a canonical-owner rule (parent with smallest base linear
// index wins) so the depth-aware sparse hash sees one entry per unique sub-edge.
@compute @workgroup_size(64, 1, 1)
fn placeChildEdgeDuals_Pass12(
    @builtin(global_invocation_id) globalId: vec3u,
    @builtin(num_workgroups) numWg: vec3u,
) {
    if (isCancelled()) {
        return;
    }
    let i = globalId.x + globalId.y * (numWg.x * 64u);
    let n = arrayLength(&childEdgeInfo);
    if (i >= n) {
        return;
    }

    let info = childEdgeInfo[i];
    let gsx = info.x;
    let gsy = info.y;
    let gsz = info.z;
    let axis = info.w & 3u;

    // Global sub-grid coords → world endpoints. The sub-edge spans from its lo-corner
    // (gsx, gsy, gsz) to its hi-corner (one axis incremented).
    let sub_voxel = uniforms.voxelSize * 0.5;
    let lo_world = uniforms.gridOffset + vec3f(f32(gsx), f32(gsy), f32(gsz)) * sub_voxel;
    var w0: vec3f;
    var w1: vec3f;
    if (axis == 0u) {
        w0 = lo_world;
        w1 = lo_world + vec3f(sub_voxel, 0.0, 0.0);
    } else if (axis == 1u) {
        w0 = lo_world;
        w1 = lo_world + vec3f(0.0, sub_voxel, 0.0);
    } else {
        w0 = lo_world;
        w1 = lo_world + vec3f(0.0, 0.0, sub_voxel);
    }
    let edge_dir = normalize(w1 - w0);

    let eps = max(uniforms.mdcF0.x, 1e-6);
    let t_max = 1.0 - eps;

    // 4D QEF: 2 endpoint samples + 1 mid/iso-crossing sample. With 3 samples and
    // edge-projected gradients (rank-2 ATA after projection), `solveQEF4`'s lowered
    // numPoints<2 cutoff (the fix from earlier in this stage) lets the regularization
    // place the spatial part along the edge axis at the iso-crossing while the off-axis
    // dimensions fall back to the mass point (corrected by the edge projection below).
    var qef4 = qef4_zero();
    let sdf0 = sceneSDF_mid(w0);
    let sdf1 = sceneSDF_mid(w1);
    let g0 = edge_dir * dot(sdf0.n, edge_dir);
    let g1 = edge_dir * dot(sdf1.n, edge_dir);
    let f0 = sdf0.d - uniforms.isoValue;
    let f1 = sdf1.d - uniforms.isoValue;
    qef4_add(&qef4, w0, g0, f0);
    qef4_add(&qef4, w1, g1, f1);

    let s0 = sdf_sign_bit_positive(f0);
    let s1 = sdf_sign_bit_positive(f1);
    var pmid: vec3f;
    if (s0 != s1) {
        let denom = f1 - f0;
        var t = 0.5;
        if (abs(denom) > 1e-20) {
            t = clamp(-f0 / denom, eps, t_max);
        }
        pmid = mix3f(w0, w1, t);
    } else {
        pmid = mix3f(w0, w1, 0.5);
    }
    let sdfm = sceneSDF_mid(pmid);
    let gm = edge_dir * dot(sdfm.n, edge_dir);
    qef4_add(&qef4, pmid, gm, sdfm.d - uniforms.isoValue);

    // Solve, then project the spatial part onto the edge axis (numerical drift can
    // pull it slightly off the line; the 1-cell subspace is the line through w0).
    let solution = solveQEF4(qef4);
    let edge_len = length(w1 - w0);
    let along = clamp(dot(solution.xyz - w0, edge_dir), eps * edge_len, t_max * edge_len);
    let pos = w0 + edge_dir * along;
    let f_shifted = sceneSDF_fast(pos).d - uniforms.isoValue;
    // Stage 4 Session 7: unified subCellAllDuals at edge base + index.
    subCellAllDuals[uniforms.subCellBases.y + i] = DualVertex(pos, f_shifted);
    childEdgeResiduals[i] = qefCost4(qef4, vec4f(pos, solution.w));
}

// ============================== Pass 13 (Stage 4 Session 5): GPU sub-face dual placement ==============================
//
// Mirrors `placeFaceDuals_Pass4`'s 4D-QEF-with-face-plane-projected-gradient approach but
// at sub-voxel resolution within a refined parent. One thread per sub-face descriptor.
// 4 corners → up to 4 iso-crossing samples on the face's 4 edges → 4D QEF.
//
// Session 5 same depth-1 / per-parent-duplicates limitations as Pass 12.
@compute @workgroup_size(64, 1, 1)
fn placeChildFaceDuals_Pass13(
    @builtin(global_invocation_id) globalId: vec3u,
    @builtin(num_workgroups) numWg: vec3u,
) {
    if (isCancelled()) {
        return;
    }
    let i = globalId.x + globalId.y * (numWg.x * 64u);
    let n = arrayLength(&childFaceInfo);
    if (i >= n) {
        return;
    }

    let info = childFaceInfo[i];
    let gsx = info.x;
    let gsy = info.y;
    let gsz = info.z;
    let axis = info.w & 3u;  // 0 = YZ-face (perp X), 1 = XZ (perp Y), 2 = XY (perp Z)

    // Global sub-grid coords → world corners. The sub-face's min-corner is at
    // (gsx, gsy, gsz); the other 3 corners are reached by stepping +1 along each of the
    // 2 axes the face spans (i.e., NOT the perpendicular axis).
    let sub_voxel = uniforms.voxelSize * 0.5;
    let min_world = uniforms.gridOffset + vec3f(f32(gsx), f32(gsy), f32(gsz)) * sub_voxel;
    var w00: vec3f; var w10: vec3f; var w01: vec3f; var w11: vec3f;
    var face_normal: vec3f;
    if (axis == 0u) {
        // YZ-face: spans in y, z — fixed x.
        w00 = min_world;
        w10 = min_world + vec3f(0.0, sub_voxel, 0.0);
        w01 = min_world + vec3f(0.0, 0.0, sub_voxel);
        w11 = min_world + vec3f(0.0, sub_voxel, sub_voxel);
        face_normal = vec3f(1.0, 0.0, 0.0);
    } else if (axis == 1u) {
        // XZ-face: spans in x, z — fixed y.
        w00 = min_world;
        w10 = min_world + vec3f(sub_voxel, 0.0, 0.0);
        w01 = min_world + vec3f(0.0, 0.0, sub_voxel);
        w11 = min_world + vec3f(sub_voxel, 0.0, sub_voxel);
        face_normal = vec3f(0.0, 1.0, 0.0);
    } else {
        // XY-face: spans in x, y — fixed z.
        w00 = min_world;
        w10 = min_world + vec3f(sub_voxel, 0.0, 0.0);
        w01 = min_world + vec3f(0.0, sub_voxel, 0.0);
        w11 = min_world + vec3f(sub_voxel, sub_voxel, 0.0);
        face_normal = vec3f(0.0, 0.0, 1.0);
    }

    let f00 = sceneSDF_fast(w00).d - uniforms.isoValue;
    let f10 = sceneSDF_fast(w10).d - uniforms.isoValue;
    let f01 = sceneSDF_fast(w01).d - uniforms.isoValue;
    let f11 = sceneSDF_fast(w11).d - uniforms.isoValue;

    let p_center = (w00 + w10 + w01 + w11) * 0.25;
    let s00 = sdf_sign_bit_positive(f00);
    let s10 = sdf_sign_bit_positive(f10);
    let s01 = sdf_sign_bit_positive(f01);
    let s11 = sdf_sign_bit_positive(f11);
    let face_has_sign_change = (s00 != s10) || (s01 != s11) || (s00 != s01) || (s10 != s11);

    var pos = p_center;
    var qef4 = qef4_zero();
    var solution_w = 0.0;

    if (face_has_sign_change) {
        // 4-corner CCW ring (00 → 10 → 11 → 01) — matches `placeFaceDuals_Pass4`'s
        // edge enumeration so per-cell QEF residuals are directly comparable across
        // depth levels.
        let edges = array<vec4u, 4>(
            vec4u(0u, 1u, 0u, 0u),
            vec4u(1u, 2u, 0u, 0u),
            vec4u(2u, 3u, 0u, 0u),
            vec4u(3u, 0u, 0u, 0u),
        );
        let corner_pos = array<vec3f, 4>(w00, w10, w11, w01);
        let corner_f   = array<f32, 4>(f00, f10, f11, f01);

        let eps_uv = max(uniforms.mdcF0.x, 1e-6);
        let uv_max = 1.0 - eps_uv;
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
            // Drop the off-face gradient component — F-derivative perpendicular to
            // the face is undefined for a 2-cell (paper §3 subspace projection).
            let g_proj = sdf_m.n - face_normal * dot(sdf_m.n, face_normal);
            qef4_add(&qef4, p, g_proj, sdf_m.d - uniforms.isoValue);
        }

        let solution = solveQEF4(qef4);
        solution_w = solution.w;

        // Pin the off-face axis exactly to the face plane (regularization-driven
        // mass-point bias can wander a few ULPs off otherwise).
        var pos_solved = solution.xyz;
        if (axis == 0u) {
            pos_solved.x = w00.x;
        } else if (axis == 1u) {
            pos_solved.y = w00.y;
        } else {
            pos_solved.z = w00.z;
        }

        // (1−ε)·sub-face box clamp in the 2D face coords.
        let vs = sub_voxel;
        let rel = pos_solved - w00;
        var u = 0.5;
        var v = 0.5;
        if (axis == 0u) {
            u = clamp(rel.y / vs, eps_uv, uv_max);
            v = clamp(rel.z / vs, eps_uv, uv_max);
        } else if (axis == 1u) {
            u = clamp(rel.x / vs, eps_uv, uv_max);
            v = clamp(rel.z / vs, eps_uv, uv_max);
        } else {
            u = clamp(rel.x / vs, eps_uv, uv_max);
            v = clamp(rel.y / vs, eps_uv, uv_max);
        }
        pos = w00 * (1.0 - u) * (1.0 - v) + w10 * u * (1.0 - v) + w01 * (1.0 - u) * v + w11 * u * v;
    }

    let f_out = sceneSDF_fast(pos).d - uniforms.isoValue;
    // Stage 4 Session 7: unified subCellAllDuals at face base + index.
    subCellAllDuals[uniforms.subCellBases.z + i] = DualVertex(pos, f_out);

    if (face_has_sign_change) {
        childFaceResiduals[i] = qefCost4(qef4, vec4f(pos, solution_w));
    } else {
        // No sign change → empty QEF, residual is meaningless. Zero is the same
        // sentinel `placeCubeDuals_Pass5` writes for inactive cubes.
        childFaceResiduals[i] = 0.0;
    }
}

// ============================== Pass 14 (Stage 4 Session 7): GPU multi-resolution sub-edge MT ==============================
//
// For each sub-edge in `childEdgeInfo`, walk the 4 surrounding sub-grid cube cells.
// If ALL 4 cells are in refined parents (interior + refined-refined boundary cases),
// emit MT triangles using sub-cube/sub-face/sub-edge duals — same `emit_four_tets_face_pair`
// pattern as Pass 6, just at sub-resolution.
//
// Skipped (Session 8 work): sub-edges with any cell in an unrefined neighbor parent
// (refined↔unrefined T-junction). Those leave cracks in the mesh at the refined-region
// boundary; Session 8 will fan-triangulate the unrefined cube's contribution to close them.
//
// The combination of:
//   - Pass 6 modified to skip base edges adjacent to refined parents (`any_cube_around_*_refined`)
//   - Pass 14 emitting MT for sub-edges where all 4 cells are refined
// produces a mesh that's correct + watertight INSIDE refined regions and INSIDE unrefined
// regions, with a (visible) crack only at the refined-unrefined transition.

/// Build a DualVertex for a sub-grid corner at global sub-grid coords (gsx, gsy, gsz).
/// Always samples sceneSDF inline (does NOT call `dual_corner` even when the sub-corner
/// aligns with a base corner) — this trade-off lets Pass 14 omit `allDuals` (binding 2)
/// and `dualHashTable` (binding 6) from its call graph, freeing 2 storage bindings to
/// stay within the WebGPU 10-storage-per-stage default. Cost: 1 extra sceneSDF_fast eval
/// per sub-edge endpoint (4× per refined sub-edge); negligible compared to Pass 11/12/13's
/// inline sceneSDF cost.
fn make_subcorner_dual(gsx: u32, gsy: u32, gsz: u32) -> DualVertex {
    let sub_voxel = uniforms.voxelSize * 0.5;
    let pos = uniforms.gridOffset + vec3f(f32(gsx), f32(gsy), f32(gsz)) * sub_voxel;
    let fval = sceneSDF_fast(pos).d - uniforms.isoValue;
    return DualVertex(pos, fval);
}

/// ============================== Stage 4 Session 8: multi-resolution duals ==============================
/// Per the paper's "minimal m-cell" rule, for any (cube|face|edge) position the dual we
/// emit MT against is the deepest available one. For our 2-level (depth 0..1) implementation:
///   - cube: sub-cube dual if the parent base cube is refined; otherwise the parent's BASE
///           cube dual.
///   - face: sub-face dual if EITHER adjacent base cube is refined (the sub-face exists in
///           `subCellAllDuals` because at least one refined parent emitted it). Otherwise
///           the BASE face dual at the boundary face that the sub-face position lies on
///           (only valid when the sub-face position is on a base-grid line — i.e. its
///           "thin" coordinate is even). For sub-face positions on an INTERIOR base-cube
///           plane (thin coord odd), the only valid form is the sub-face — and that only
///           exists if the containing base cube is refined.
///
/// `cube_dual_at_subpos` and `face_*_dual_at_subpos` encapsulate this; callers (Pass 14)
/// just ask for "the cube dual at this sub-position" and get the right one back.

fn cube_dual_at_subpos(gscx: u32, gscy: u32, gscz: u32) -> DualVertex {
    let bcx = gscx >> 1u;
    let bcy = gscy >> 1u;
    let bcz = gscz >> 1u;
    if (is_base_cube_refined(bcx, bcy, bcz)) {
        return dual_sub_cube(gscx, gscy, gscz);
    }
    let nx = uniforms.gridDimensions.x - 1u;
    let ny = uniforms.gridDimensions.y - 1u;
    return dual_cube(bcx + bcy * nx + bcz * nx * ny);
}

/// Returns true iff a sub-edge X at (gsx, gsy, gsz) has at least one of its 4 surrounding
/// sub-cubes in a refined parent. Only such sub-edges are minimal; the rest are covered by
/// some base-grid edge that Pass 6 emits.
fn sub_edge_x_is_minimal(gsx: u32, gsy: u32, gsz: u32) -> bool {
    // Same 4-cube indexing as pass14_emit_x_sub_edge.
    if (gsy < 1u || gsz < 1u) { return false; }
    let bcx = gsx >> 1u;
    return is_base_cube_refined(bcx, (gsy - 1u) >> 1u, (gsz - 1u) >> 1u)
        || is_base_cube_refined(bcx, gsy        >> 1u, (gsz - 1u) >> 1u)
        || is_base_cube_refined(bcx, (gsy - 1u) >> 1u, gsz        >> 1u)
        || is_base_cube_refined(bcx, gsy        >> 1u, gsz        >> 1u);
}

fn sub_edge_y_is_minimal(gsx: u32, gsy: u32, gsz: u32) -> bool {
    if (gsx < 1u || gsz < 1u) { return false; }
    let bcy = gsy >> 1u;
    return is_base_cube_refined((gsx - 1u) >> 1u, bcy, (gsz - 1u) >> 1u)
        || is_base_cube_refined(gsx        >> 1u, bcy, (gsz - 1u) >> 1u)
        || is_base_cube_refined((gsx - 1u) >> 1u, bcy, gsz        >> 1u)
        || is_base_cube_refined(gsx        >> 1u, bcy, gsz        >> 1u);
}

fn sub_edge_z_is_minimal(gsx: u32, gsy: u32, gsz: u32) -> bool {
    if (gsx < 1u || gsy < 1u) { return false; }
    let bcz = gsz >> 1u;
    return is_base_cube_refined((gsx - 1u) >> 1u, (gsy - 1u) >> 1u, bcz)
        || is_base_cube_refined(gsx        >> 1u, (gsy - 1u) >> 1u, bcz)
        || is_base_cube_refined((gsx - 1u) >> 1u, gsy        >> 1u, bcz)
        || is_base_cube_refined(gsx        >> 1u, gsy        >> 1u, bcz);
}

/// XY-face at sub-position (gsfx, gsfy, gsfz). Adjacent sub-cubes (in z): low z=gsfz-1, high z=gsfz.
/// `lo_ref`/`hi_ref` are the refinement of the low/high adjacent cubes' parents, pre-computed
/// by the caller (we reuse the cube refinement checks already done for the sub-edge's 4 cubes).
/// Returns (face_dual, should_emit). `should_emit=false` means the face-pair is INSIDE a single
/// unrefined base cube (no real face there) — caller should skip emit_four_tets_face_pair.
struct FaceDualResult { dual: DualVertex, should_emit: bool };

fn face_xy_dual_at_subpos(gsfx: u32, gsfy: u32, gsfz: u32, lo_ref: bool, hi_ref: bool) -> FaceDualResult {
    var r: FaceDualResult;
    if (lo_ref || hi_ref) {
        r.dual = dual_sub_face_xy(gsfx, gsfy, gsfz);
        r.should_emit = true;
        return r;
    }
    // Both adjacent cubes unrefined. Sub-face is "real" only if it sits on a base z-line:
    // the sub-face z-coord must be EVEN (so it's the boundary between two distinct base cubes
    // in z). Otherwise it's interior to a single unrefined cube — skip.
    if ((gsfz & 1u) != 0u) {
        r.dual = DualVertex(vec3f(0.0), 0.0);
        r.should_emit = false;
        return r;
    }
    let dx = uniforms.gridDimensions.x;
    let dy = uniforms.gridDimensions.y;
    r.dual = face_xy_dual_at(gsfx >> 1u, gsfy >> 1u, gsfz >> 1u, dx, dy);
    r.should_emit = true;
    return r;
}

fn face_yz_dual_at_subpos(gsfx: u32, gsfy: u32, gsfz: u32, lo_ref: bool, hi_ref: bool) -> FaceDualResult {
    var r: FaceDualResult;
    if (lo_ref || hi_ref) {
        r.dual = dual_sub_face_yz(gsfx, gsfy, gsfz);
        r.should_emit = true;
        return r;
    }
    if ((gsfx & 1u) != 0u) {
        r.dual = DualVertex(vec3f(0.0), 0.0);
        r.should_emit = false;
        return r;
    }
    let dx = uniforms.gridDimensions.x;
    let dy = uniforms.gridDimensions.y;
    r.dual = face_yz_dual_at(gsfx >> 1u, gsfy >> 1u, gsfz >> 1u, dx, dy);
    r.should_emit = true;
    return r;
}

fn face_xz_dual_at_subpos(gsfx: u32, gsfy: u32, gsfz: u32, lo_ref: bool, hi_ref: bool) -> FaceDualResult {
    var r: FaceDualResult;
    if (lo_ref || hi_ref) {
        r.dual = dual_sub_face_xz(gsfx, gsfy, gsfz);
        r.should_emit = true;
        return r;
    }
    if ((gsfy & 1u) != 0u) {
        r.dual = DualVertex(vec3f(0.0), 0.0);
        r.should_emit = false;
        return r;
    }
    let dx = uniforms.gridDimensions.x;
    let dy = uniforms.gridDimensions.y;
    r.dual = face_xz_dual_at(gsfx >> 1u, gsfy >> 1u, gsfz >> 1u, dx, dy);
    r.should_emit = true;
    return r;
}

// ============================== Phase 5 (Session 9): mixed-depth corner + edge duals ==============================
//
// Pass 15 (`emitMinimalCubeMT_Pass15`) walks per-minimal-cube and needs to look up the
// "minimal dual" at any corner (0-cell) or edge (1-cell) sub-position. Mirrors the existing
// `cube_dual_at_subpos` / `face_*_dual_at_subpos` helpers from Session 8.
//
// Corner: if (gsx, gsy, gsz) are all even → base corner (lookup via base sparse hash).
//         Otherwise → sub-corner (only exists inside refined regions; inline-sample SDF).
//
// Edge: if `sub_edge_*_is_minimal` returns true → sub-edge dual (subDualHashTable).
//       Otherwise → base edge dual (sparseHash). When the sub-edge is NOT minimal, both
//       gsy and gsz must be even (for X-axis), so the parent base edge is unambiguous.

fn corner_dual_at_subpos(gsx: u32, gsy: u32, gsz: u32) -> DualVertex {
    if ((gsx & 1u) == 0u && (gsy & 1u) == 0u && (gsz & 1u) == 0u) {
        let dx = uniforms.gridDimensions.x;
        let dy = uniforms.gridDimensions.y;
        return dual_corner((gsx >> 1u) + (gsy >> 1u) * dx + (gsz >> 1u) * dx * dy);
    }
    return make_subcorner_dual(gsx, gsy, gsz);
}

fn edge_x_dual_at_subpos(gsx: u32, gsy: u32, gsz: u32) -> DualVertex {
    if (sub_edge_x_is_minimal(gsx, gsy, gsz)) {
        return dual_sub_edge_x(gsx, gsy, gsz);
    }
    // Base edge fallback: when not minimal, (gsy, gsz) are both on base-grid lines (even),
    // and (gsx, gsy/2, gsz/2) is the unique base-edge linear index. The sub-edge spans
    // sub_x ∈ [gsx, gsx+1] which is one half of the base edge spanning base_x ∈ [gsx>>1,
    // (gsx>>1)+1] — both halves of the same base edge resolve to the same dual.
    let dx = uniforms.gridDimensions.x;
    let dy = uniforms.gridDimensions.y;
    return dual_edge_x((gsx >> 1u) + (gsy >> 1u) * (dx - 1u) + (gsz >> 1u) * (dx - 1u) * dy);
}

fn edge_y_dual_at_subpos(gsx: u32, gsy: u32, gsz: u32) -> DualVertex {
    if (sub_edge_y_is_minimal(gsx, gsy, gsz)) {
        return dual_sub_edge_y(gsx, gsy, gsz);
    }
    let dx = uniforms.gridDimensions.x;
    let dy = uniforms.gridDimensions.y;
    return dual_edge_y((gsx >> 1u) + (gsy >> 1u) * dx + (gsz >> 1u) * dx * (dy - 1u));
}

fn edge_z_dual_at_subpos(gsx: u32, gsy: u32, gsz: u32) -> DualVertex {
    if (sub_edge_z_is_minimal(gsx, gsy, gsz)) {
        return dual_sub_edge_z(gsx, gsy, gsz);
    }
    let dx = uniforms.gridDimensions.x;
    let dy = uniforms.gridDimensions.y;
    return dual_edge_z((gsx >> 1u) + (gsy >> 1u) * dx + (gsz >> 1u) * dx * dy);
}

// Convenience wrappers around the Session 8 face_*_dual_at_subpos helpers that compute
// (lo_ref, hi_ref) from the sub-face position itself, so Pass 15 doesn't have to track
// neighbour refinement explicitly per face. Adjacent base cubes for a sub-face F are the
// 2 cubes on either side of F's "thin" axis (the axis perpendicular to the face plane).

fn face_xy_dual_auto(gsfx: u32, gsfy: u32, gsfz: u32) -> FaceDualResult {
    // XY-face's thin axis is Z. Adjacent sub-cubes at z = gsfz-1 and z = gsfz; their
    // parent cubes are at z>>1.
    let bfx = gsfx >> 1u;
    let bfy = gsfy >> 1u;
    let lo_ref = select(false, is_base_cube_refined(bfx, bfy, (gsfz - 1u) >> 1u), gsfz >= 1u);
    let hi_ref = is_base_cube_refined(bfx, bfy, gsfz >> 1u);
    return face_xy_dual_at_subpos(gsfx, gsfy, gsfz, lo_ref, hi_ref);
}

fn face_yz_dual_auto(gsfx: u32, gsfy: u32, gsfz: u32) -> FaceDualResult {
    // YZ-face's thin axis is X.
    let bfy = gsfy >> 1u;
    let bfz = gsfz >> 1u;
    let lo_ref = select(false, is_base_cube_refined((gsfx - 1u) >> 1u, bfy, bfz), gsfx >= 1u);
    let hi_ref = is_base_cube_refined(gsfx >> 1u, bfy, bfz);
    return face_yz_dual_at_subpos(gsfx, gsfy, gsfz, lo_ref, hi_ref);
}

fn face_xz_dual_auto(gsfx: u32, gsfy: u32, gsfz: u32) -> FaceDualResult {
    // XZ-face's thin axis is Y.
    let bfx = gsfx >> 1u;
    let bfz = gsfz >> 1u;
    let lo_ref = select(false, is_base_cube_refined(bfx, (gsfy - 1u) >> 1u, bfz), gsfy >= 1u);
    let hi_ref = is_base_cube_refined(bfx, gsfy >> 1u, bfz);
    return face_xz_dual_at_subpos(gsfx, gsfy, gsfz, lo_ref, hi_ref);
}

/// Per-axis sub-edge MT. `axis` is the edge direction: 0=X, 1=Y, 2=Z.
/// Cell-array indexing convention (matches Pass 6's emit_pass6_*_edge logic):
///   X-edge cells: A=(gsx, gsy-1, gsz-1), B=(gsx, gsy, gsz-1), C=(gsx, gsy-1, gsz), D=(gsx, gsy, gsz)
///   Y-edge cells: A=(gsx-1, gsy, gsz-1), B=(gsx, gsy, gsz-1), C=(gsx-1, gsy, gsz), D=(gsx, gsy, gsz)
///   Z-edge cells: A=(gsx-1, gsy-1, gsz), B=(gsx, gsy-1, gsz), C=(gsx-1, gsy, gsz), D=(gsx, gsy, gsz)
/// Face pairs around the edge: AB, CD share a face perpendicular to one axis; AC, BD share
/// a face perpendicular to another. See per-axis comments below for the exact face types.

fn pass14_emit_x_sub_edge(gsx: u32, gsy: u32, gsz: u32) {
    let nx_sub = 2u * (uniforms.gridDimensions.x - 1u);
    let ny_sub = 2u * (uniforms.gridDimensions.y - 1u);
    let nz_sub = 2u * (uniforms.gridDimensions.z - 1u);

    // Bounds check 4 cells. If any cell is outside the sub-grid, this sub-edge is on
    // the global grid boundary — skip (no surface activity beyond the bounds).
    if (gsy < 1u || gsz < 1u || gsy > ny_sub || gsz > nz_sub) {
        return;
    }
    if (gsx >= nx_sub) {
        return;
    }
    let a_cy = gsy - 1u;
    let a_cz = gsz - 1u;
    let b_cy = gsy;
    let b_cz = gsz - 1u;
    let c_cy = gsy - 1u;
    let c_cz = gsz;
    let d_cy = gsy;
    let d_cz = gsz;
    if (b_cy >= ny_sub || d_cy >= ny_sub || c_cz >= nz_sub || d_cz >= nz_sub) {
        return;
    }

    // Refinement check on all 4 base parents. The sub-edge is "minimal" iff at least one
    // surrounding sub-cube's parent is refined. (If none refined, the covering base edge is
    // the minimal one and Pass 6 emits MT at base resolution there — Pass 14 must NOT.)
    let a_ref = is_base_cube_refined(gsx >> 1u, a_cy >> 1u, a_cz >> 1u);
    let b_ref = is_base_cube_refined(gsx >> 1u, b_cy >> 1u, b_cz >> 1u);
    let c_ref = is_base_cube_refined(gsx >> 1u, c_cy >> 1u, c_cz >> 1u);
    let d_ref = is_base_cube_refined(gsx >> 1u, d_cy >> 1u, d_cz >> 1u);
    if (!(a_ref || b_ref || c_ref || d_ref)) {
        return;
    }

    // Cube duals: sub-cube dual on the refined side, BASE cube dual on the unrefined side.
    // This is the "minimal cube" rule from the paper — the deepest available dual at each
    // surrounding cube position. Mixing depths is correct and produces a single connected
    // surface (refined-side neighbours share their base-dual with all other unrefined cells
    // touching them, so the manifold is preserved).
    let a_dual = cube_dual_at_subpos(gsx, a_cy, a_cz);
    let b_dual = cube_dual_at_subpos(gsx, b_cy, b_cz);
    let c_dual = cube_dual_at_subpos(gsx, c_cy, c_cz);
    let d_dual = cube_dual_at_subpos(gsx, d_cy, d_cz);

    let edge = dual_sub_edge_x(gsx, gsy, gsz);
    let p0d = make_subcorner_dual(gsx,       gsy, gsz);
    let p1d = make_subcorner_dual(gsx + 1u,  gsy, gsz);

    // Face-adjacent cube pairs around X-edge:
    //   PD: B↔D differ in z.   Face XY at sub_pos=(gsx, gsy, gsz)         (z = gsz)
    //   PC: A↔C differ in z.   Face XY at sub_pos=(gsx, gsy - 1, gsz)     (z = gsz)
    //   PB: C↔D differ in y.   Face XZ at sub_pos=(gsx, gsy, gsz)         (y = gsy)
    //   PA: A↔B differ in y.   Face XZ at sub_pos=(gsx, gsy, gsz - 1)     (y = gsy)
    let bd = face_xy_dual_at_subpos(gsx, gsy,      gsz,        b_ref, d_ref);
    if (bd.should_emit) { emit_four_tets_face_pair(p0d, p1d, edge, bd.dual, b_dual, d_dual); }
    let ac = face_xy_dual_at_subpos(gsx, gsy - 1u, gsz,        a_ref, c_ref);
    if (ac.should_emit) { emit_four_tets_face_pair(p0d, p1d, edge, ac.dual, a_dual, c_dual); }
    let cd = face_xz_dual_at_subpos(gsx, gsy,      gsz,        c_ref, d_ref);
    if (cd.should_emit) { emit_four_tets_face_pair(p0d, p1d, edge, cd.dual, c_dual, d_dual); }
    let ab = face_xz_dual_at_subpos(gsx, gsy,      gsz - 1u,   a_ref, b_ref);
    if (ab.should_emit) { emit_four_tets_face_pair(p0d, p1d, edge, ab.dual, a_dual, b_dual); }
}

fn pass14_emit_y_sub_edge(gsx: u32, gsy: u32, gsz: u32) {
    let nx_sub = 2u * (uniforms.gridDimensions.x - 1u);
    let ny_sub = 2u * (uniforms.gridDimensions.y - 1u);
    let nz_sub = 2u * (uniforms.gridDimensions.z - 1u);

    if (gsx < 1u || gsz < 1u || gsx > nx_sub || gsz > nz_sub) {
        return;
    }
    if (gsy >= ny_sub) {
        return;
    }
    let a_cx = gsx - 1u;
    let a_cz = gsz - 1u;
    let b_cx = gsx;
    let b_cz = gsz - 1u;
    let c_cx = gsx - 1u;
    let c_cz = gsz;
    let d_cx = gsx;
    let d_cz = gsz;
    if (b_cx >= nx_sub || d_cx >= nx_sub || c_cz >= nz_sub || d_cz >= nz_sub) {
        return;
    }

    let a_ref = is_base_cube_refined(a_cx >> 1u, gsy >> 1u, a_cz >> 1u);
    let b_ref = is_base_cube_refined(b_cx >> 1u, gsy >> 1u, b_cz >> 1u);
    let c_ref = is_base_cube_refined(c_cx >> 1u, gsy >> 1u, c_cz >> 1u);
    let d_ref = is_base_cube_refined(d_cx >> 1u, gsy >> 1u, d_cz >> 1u);
    if (!(a_ref || b_ref || c_ref || d_ref)) {
        return;
    }

    let a_dual = cube_dual_at_subpos(a_cx, gsy, a_cz);
    let b_dual = cube_dual_at_subpos(b_cx, gsy, b_cz);
    let c_dual = cube_dual_at_subpos(c_cx, gsy, c_cz);
    let d_dual = cube_dual_at_subpos(d_cx, gsy, d_cz);

    let edge = dual_sub_edge_y(gsx, gsy, gsz);
    let p0d = make_subcorner_dual(gsx, gsy,       gsz);
    let p1d = make_subcorner_dual(gsx, gsy + 1u,  gsz);

    // Face-adjacent pairs around Y-edge:
    //   PD: C↔D differ in x.   Face YZ at sub_pos=(gsx, gsy, gsz)         (x = gsx)
    //   PA: A↔B differ in x.   Face YZ at sub_pos=(gsx, gsy, gsz - 1)     (x = gsx)
    //   PB: B↔D differ in z.   Face XY at sub_pos=(gsx, gsy, gsz)         (z = gsz)
    //   PC: A↔C differ in z.   Face XY at sub_pos=(gsx - 1, gsy, gsz)     (z = gsz)
    let cd = face_yz_dual_at_subpos(gsx,      gsy, gsz,        c_ref, d_ref);
    if (cd.should_emit) { emit_four_tets_face_pair(p0d, p1d, edge, cd.dual, c_dual, d_dual); }
    let ab = face_yz_dual_at_subpos(gsx,      gsy, gsz - 1u,   a_ref, b_ref);
    if (ab.should_emit) { emit_four_tets_face_pair(p0d, p1d, edge, ab.dual, a_dual, b_dual); }
    let bd = face_xy_dual_at_subpos(gsx,      gsy, gsz,        b_ref, d_ref);
    if (bd.should_emit) { emit_four_tets_face_pair(p0d, p1d, edge, bd.dual, b_dual, d_dual); }
    let ac = face_xy_dual_at_subpos(gsx - 1u, gsy, gsz,        a_ref, c_ref);
    if (ac.should_emit) { emit_four_tets_face_pair(p0d, p1d, edge, ac.dual, a_dual, c_dual); }
}

fn pass14_emit_z_sub_edge(gsx: u32, gsy: u32, gsz: u32) {
    let nx_sub = 2u * (uniforms.gridDimensions.x - 1u);
    let ny_sub = 2u * (uniforms.gridDimensions.y - 1u);
    let nz_sub = 2u * (uniforms.gridDimensions.z - 1u);

    if (gsx < 1u || gsy < 1u || gsx > nx_sub || gsy > ny_sub) {
        return;
    }
    if (gsz >= nz_sub) {
        return;
    }
    let a_cx = gsx - 1u;
    let a_cy = gsy - 1u;
    let b_cx = gsx;
    let b_cy = gsy - 1u;
    let c_cx = gsx - 1u;
    let c_cy = gsy;
    let d_cx = gsx;
    let d_cy = gsy;
    if (b_cx >= nx_sub || d_cx >= nx_sub || c_cy >= ny_sub || d_cy >= ny_sub) {
        return;
    }

    let a_ref = is_base_cube_refined(a_cx >> 1u, a_cy >> 1u, gsz >> 1u);
    let b_ref = is_base_cube_refined(b_cx >> 1u, b_cy >> 1u, gsz >> 1u);
    let c_ref = is_base_cube_refined(c_cx >> 1u, c_cy >> 1u, gsz >> 1u);
    let d_ref = is_base_cube_refined(d_cx >> 1u, d_cy >> 1u, gsz >> 1u);
    if (!(a_ref || b_ref || c_ref || d_ref)) {
        return;
    }

    let a_dual = cube_dual_at_subpos(a_cx, a_cy, gsz);
    let b_dual = cube_dual_at_subpos(b_cx, b_cy, gsz);
    let c_dual = cube_dual_at_subpos(c_cx, c_cy, gsz);
    let d_dual = cube_dual_at_subpos(d_cx, d_cy, gsz);

    let edge = dual_sub_edge_z(gsx, gsy, gsz);
    let p0d = make_subcorner_dual(gsx, gsy, gsz);
    let p1d = make_subcorner_dual(gsx, gsy, gsz + 1u);

    // Face-adjacent pairs around Z-edge:
    //   PD: B↔D differ in y.   Face XZ at sub_pos=(gsx, gsy, gsz)         (y = gsy)
    //   PA: A↔C differ in y.   Face XZ at sub_pos=(gsx - 1, gsy, gsz)     (y = gsy)
    //   PB: C↔D differ in x.   Face YZ at sub_pos=(gsx, gsy, gsz)         (x = gsx)
    //   PC: A↔B differ in x.   Face YZ at sub_pos=(gsx, gsy - 1, gsz)     (x = gsx)
    let bd = face_xz_dual_at_subpos(gsx,      gsy,      gsz, b_ref, d_ref);
    if (bd.should_emit) { emit_four_tets_face_pair(p0d, p1d, edge, bd.dual, b_dual, d_dual); }
    let ac = face_xz_dual_at_subpos(gsx - 1u, gsy,      gsz, a_ref, c_ref);
    if (ac.should_emit) { emit_four_tets_face_pair(p0d, p1d, edge, ac.dual, a_dual, c_dual); }
    let cd = face_yz_dual_at_subpos(gsx,      gsy,      gsz, c_ref, d_ref);
    if (cd.should_emit) { emit_four_tets_face_pair(p0d, p1d, edge, cd.dual, c_dual, d_dual); }
    let ab = face_yz_dual_at_subpos(gsx,      gsy - 1u, gsz, a_ref, b_ref);
    if (ab.should_emit) { emit_four_tets_face_pair(p0d, p1d, edge, ab.dual, a_dual, b_dual); }
}

// ============================== Phase 5 (Session 9): paper-correct multi-resolution MT ==============================
//
// `walk_minimal_cube_tets` implements Manson & Schaefer's recursive simplicial
// decomposition (paper §4) for one MINIMAL CUBE. For each of the cube's 6 sides it:
//
//   1. Determines the minimal face(s) on that side: 1 base face if both M and the neighbour
//      are unrefined-base (so M is depth-0 with neighbour mask bit cleared), or 4 sub-faces
//      if M is depth-0 and the face neighbour is refined, or 1 sub-face if M is depth-1.
//   2. For each minimal face F, walks F's 4 boundary edges. Each boundary edge is either
//      a base edge (1 minimal edge of length 2 sub-grid units) or a sub-edge (1 minimal
//      edge of length 1) — the latter when the underlying base edge is "split" because at
//      least one of its 4 surrounding cubes is refined. For base faces with split edges,
//      that boundary side contributes 2 sub-edges instead of 1 base edge.
//   3. For each minimal edge E, looks up its 2 endpoint corners (base corner if all coords
//      are even, sub-corner via inline SDF sample otherwise) and emits one tet
//      `(Dp, De, Df, Dc)` per endpoint via `emit_mt_tetra`.
//
// Adjacent minimal cubes share their boundary minimal cells by construction, so the tets
// on either side of a shared face share full 3-vertex faces and their MT contour edges
// weld during the CPU position-quantize weld. This is the correctness property that
// Sessions 7/8 violated by walking edges directly.

// ----- per-axis-pair edge walks (one per face's boundary edge orientation) -----
//
// `walk_face_y_edge` (etc.) emits the tets contributed by ONE boundary edge of one
// minimal face. The edge's axis (Y here) is fixed; (sx, sy, sz) is the edge's min corner
// in sub-grid coordinates; `S` is the edge length in sub-grid units (1 for sub-edge,
// 2 for base edge — although when S=2 we may further split into 2 sub-edges).

// Pass 15 / Pass 6 partition rule: for each base edge slot in a minimal cube's face
// boundary, Pass 15 only emits tets if the underlying base edge is "split" (has at least
// one refined surrounding cube → Pass 6's `any_cube_around_*_edge_refined` skips it).
// If the base edge has NO refined surrounding cube, Pass 6 emits it at base resolution
// and Pass 15 must skip — otherwise we'd emit the same tet twice and the welded mesh
// would have phantom non-manifold edges + duplicated triangles.
//
// For S==1 (sub-edge from a depth-1 sub-cube): always emit (Pass 6 doesn't see sub-edges).
// For S==2 + split: emit 2 sub-edges' tets.
// For S==2 + not split: SKIP (Pass 6 handles).

fn walk_face_y_edge(sx: u32, sy: u32, sz: u32, S: u32, Df: DualVertex, Dc: DualVertex) {
    if (S == 1u) {
        let De = edge_y_dual_at_subpos(sx, sy, sz);
        let Dp0 = corner_dual_at_subpos(sx, sy,        sz);
        let Dp1 = corner_dual_at_subpos(sx, sy + 1u,   sz);
        emit_mt_tetra(array<DualVertex, 4>(Dp0, De, Df, Dc));
        emit_mt_tetra(array<DualVertex, 4>(Dp1, De, Df, Dc));
        return;
    }
    // S == 2: base edge. Emit only if Pass 6 would skip it, i.e. it's split.
    if (!sub_edge_y_is_minimal(sx, sy, sz)) {
        return;
    }
    for (var k = 0u; k < 2u; k = k + 1u) {
        let ey = sy + k;
        let De = edge_y_dual_at_subpos(sx, ey, sz);
        let Dp0 = corner_dual_at_subpos(sx, ey,        sz);
        let Dp1 = corner_dual_at_subpos(sx, ey + 1u,   sz);
        emit_mt_tetra(array<DualVertex, 4>(Dp0, De, Df, Dc));
        emit_mt_tetra(array<DualVertex, 4>(Dp1, De, Df, Dc));
    }
}

fn walk_face_x_edge(sx: u32, sy: u32, sz: u32, S: u32, Df: DualVertex, Dc: DualVertex) {
    if (S == 1u) {
        let De = edge_x_dual_at_subpos(sx, sy, sz);
        let Dp0 = corner_dual_at_subpos(sx,        sy, sz);
        let Dp1 = corner_dual_at_subpos(sx + 1u,   sy, sz);
        emit_mt_tetra(array<DualVertex, 4>(Dp0, De, Df, Dc));
        emit_mt_tetra(array<DualVertex, 4>(Dp1, De, Df, Dc));
        return;
    }
    if (!sub_edge_x_is_minimal(sx, sy, sz)) {
        return;
    }
    for (var k = 0u; k < 2u; k = k + 1u) {
        let ex = sx + k;
        let De = edge_x_dual_at_subpos(ex, sy, sz);
        let Dp0 = corner_dual_at_subpos(ex,        sy, sz);
        let Dp1 = corner_dual_at_subpos(ex + 1u,   sy, sz);
        emit_mt_tetra(array<DualVertex, 4>(Dp0, De, Df, Dc));
        emit_mt_tetra(array<DualVertex, 4>(Dp1, De, Df, Dc));
    }
}

fn walk_face_z_edge(sx: u32, sy: u32, sz: u32, S: u32, Df: DualVertex, Dc: DualVertex) {
    if (S == 1u) {
        let De = edge_z_dual_at_subpos(sx, sy, sz);
        let Dp0 = corner_dual_at_subpos(sx, sy, sz);
        let Dp1 = corner_dual_at_subpos(sx, sy, sz + 1u);
        emit_mt_tetra(array<DualVertex, 4>(Dp0, De, Df, Dc));
        emit_mt_tetra(array<DualVertex, 4>(Dp1, De, Df, Dc));
        return;
    }
    if (!sub_edge_z_is_minimal(sx, sy, sz)) {
        return;
    }
    for (var k = 0u; k < 2u; k = k + 1u) {
        let ez = sz + k;
        let De = edge_z_dual_at_subpos(sx, sy, ez);
        let Dp0 = corner_dual_at_subpos(sx, sy, ez);
        let Dp1 = corner_dual_at_subpos(sx, sy, ez + 1u);
        emit_mt_tetra(array<DualVertex, 4>(Dp0, De, Df, Dc));
        emit_mt_tetra(array<DualVertex, 4>(Dp1, De, Df, Dc));
    }
}

// ----- per-side walk: enumerates minimal face(s) on one side of M and walks each face's
// 4 boundary edges. `nbr_refined` indicates whether the face neighbour on this side is
// a refined base cube (only meaningful for depth-0 M; for depth-1 M the face is always
// a sub-face regardless of neighbour state).

fn walk_side_x(msx: u32, msy: u32, msz: u32, S: u32, depth: u32, nbr_refined: bool, Dc: DualVertex) {
    // Side X means face perpendicular to X axis. Caller passes msx = either the cube's
    // -X coord (left face) or the cube's +X coord (right face). Face is YZ-axis.
    let one_face = (depth == 1u) || !nbr_refined;
    if (one_face) {
        // 1 minimal face of width S (S=2 base, S=1 sub).
        let f = face_yz_dual_auto(msx, msy, msz);
        if (f.should_emit) {
            let Df = f.dual;
            walk_face_y_edge(msx, msy, msz,         S, Df, Dc);
            walk_face_y_edge(msx, msy, msz + S,     S, Df, Dc);
            walk_face_z_edge(msx, msy, msz,         S, Df, Dc);
            walk_face_z_edge(msx, msy + S, msz,     S, Df, Dc);
        }
    } else {
        // 4 minimal sub-faces, each width 1, at offsets (a, b) in (y, z).
        for (var a = 0u; a < 2u; a = a + 1u) {
            for (var b = 0u; b < 2u; b = b + 1u) {
                let sfy = msy + a;
                let sfz = msz + b;
                let f = face_yz_dual_auto(msx, sfy, sfz);
                if (!f.should_emit) { continue; }
                let Df = f.dual;
                walk_face_y_edge(msx, sfy, sfz,         1u, Df, Dc);
                walk_face_y_edge(msx, sfy, sfz + 1u,    1u, Df, Dc);
                walk_face_z_edge(msx, sfy, sfz,         1u, Df, Dc);
                walk_face_z_edge(msx, sfy + 1u, sfz,    1u, Df, Dc);
            }
        }
    }
}

fn walk_side_y(msx: u32, msy: u32, msz: u32, S: u32, depth: u32, nbr_refined: bool, Dc: DualVertex) {
    // Face perpendicular to Y. Face axis is XZ.
    let one_face = (depth == 1u) || !nbr_refined;
    if (one_face) {
        let f = face_xz_dual_auto(msx, msy, msz);
        if (f.should_emit) {
            let Df = f.dual;
            walk_face_x_edge(msx, msy, msz,         S, Df, Dc);
            walk_face_x_edge(msx, msy, msz + S,     S, Df, Dc);
            walk_face_z_edge(msx, msy, msz,         S, Df, Dc);
            walk_face_z_edge(msx + S, msy, msz,     S, Df, Dc);
        }
    } else {
        for (var a = 0u; a < 2u; a = a + 1u) {
            for (var b = 0u; b < 2u; b = b + 1u) {
                let sfx = msx + a;
                let sfz = msz + b;
                let f = face_xz_dual_auto(sfx, msy, sfz);
                if (!f.should_emit) { continue; }
                let Df = f.dual;
                walk_face_x_edge(sfx, msy, sfz,         1u, Df, Dc);
                walk_face_x_edge(sfx, msy, sfz + 1u,    1u, Df, Dc);
                walk_face_z_edge(sfx, msy, sfz,         1u, Df, Dc);
                walk_face_z_edge(sfx + 1u, msy, sfz,    1u, Df, Dc);
            }
        }
    }
}

fn walk_side_z(msx: u32, msy: u32, msz: u32, S: u32, depth: u32, nbr_refined: bool, Dc: DualVertex) {
    // Face perpendicular to Z. Face axis is XY.
    let one_face = (depth == 1u) || !nbr_refined;
    if (one_face) {
        let f = face_xy_dual_auto(msx, msy, msz);
        if (f.should_emit) {
            let Df = f.dual;
            walk_face_x_edge(msx, msy, msz,         S, Df, Dc);
            walk_face_x_edge(msx, msy + S, msz,     S, Df, Dc);
            walk_face_y_edge(msx, msy, msz,         S, Df, Dc);
            walk_face_y_edge(msx + S, msy, msz,     S, Df, Dc);
        }
    } else {
        for (var a = 0u; a < 2u; a = a + 1u) {
            for (var b = 0u; b < 2u; b = b + 1u) {
                let sfx = msx + a;
                let sfy = msy + b;
                let f = face_xy_dual_auto(sfx, sfy, msz);
                if (!f.should_emit) { continue; }
                let Df = f.dual;
                walk_face_x_edge(sfx, sfy, msz,         1u, Df, Dc);
                walk_face_x_edge(sfx, sfy + 1u, msz,    1u, Df, Dc);
                walk_face_y_edge(sfx, sfy, msz,         1u, Df, Dc);
                walk_face_y_edge(sfx + 1u, sfy, msz,    1u, Df, Dc);
            }
        }
    }
}

fn walk_minimal_cube_tets(M_idx: u32) {
    // Minimal-cube descriptor packed into the tail of subCellAllDuals (after the
    // totalSlots dual entries), one vec4u per descriptor, format:
    //   pos.x = gsx (sub-grid coord of cube's min corner)
    //   pos.y = gsy
    //   pos.z = gsz
    //   fval (bitcast u32):
    //     bit  0     = depth (0 = unrefined base cube of size 2 sub-grid units;
    //                          1 = sub-cube of a refined parent of size 1 sub-grid unit)
    //     bits 1..6  = neighbourRefinedMask (bit 0=-X, 1=+X, 2=-Y, 3=+Y, 4=-Z, 5=+Z)
    //                  Only meaningful for depth=0; for depth=1 it's ignored (sub-cubes
    //                  always have sub-faces regardless of neighbour state).
    let dv = subCellAllDuals[uniforms.subCellBases.w + M_idx];
    let msx = bitcast<u32>(dv.pos.x);
    let msy = bitcast<u32>(dv.pos.y);
    let msz = bitcast<u32>(dv.pos.z);
    let word3 = bitcast<u32>(dv.fval);
    let depth = word3 & 1u;
    let mask = (word3 >> 1u) & 0x3fu;
    let S = select(1u, 2u, depth == 0u);

    let Dc = cube_dual_at_subpos(msx, msy, msz);

    // 6 sides — bit positions in mask: 0=-X, 1=+X, 2=-Y, 3=+Y, 4=-Z, 5=+Z.
    walk_side_x(msx,     msy, msz, S, depth, (mask & (1u << 0u)) != 0u, Dc); // -X
    walk_side_x(msx + S, msy, msz, S, depth, (mask & (1u << 1u)) != 0u, Dc); // +X
    walk_side_y(msx, msy,     msz, S, depth, (mask & (1u << 2u)) != 0u, Dc); // -Y
    walk_side_y(msx, msy + S, msz, S, depth, (mask & (1u << 3u)) != 0u, Dc); // +Y
    walk_side_z(msx, msy, msz,     S, depth, (mask & (1u << 4u)) != 0u, Dc); // -Z
    walk_side_z(msx, msy, msz + S, S, depth, (mask & (1u << 5u)) != 0u, Dc); // +Z
}

@compute @workgroup_size(64, 1, 1)
fn emitMinimalCubeMT_Pass15(
    @builtin(global_invocation_id) globalId: vec3u,
    @builtin(num_workgroups) numWg: vec3u,
) {
    if (isCancelled()) {
        return;
    }
    let i = globalId.x + globalId.y * (numWg.x * 64u);
    // Phase 5: minimal-cube descriptors are packed at the END of `subCellAllDuals` (after
    // the totalSlots dual entries). `subSparseHash.z` carries the descriptor count;
    // `subCellBases.w` is the base offset in slots (= totalSlots).
    let n = uniforms.subSparseHash.z;
    if (i >= n) {
        return;
    }
    walk_minimal_cube_tets(i);
}

@compute @workgroup_size(64, 1, 1)
fn emitSubedgeMT_Pass14(
    @builtin(global_invocation_id) globalId: vec3u,
    @builtin(num_workgroups) numWg: vec3u,
) {
    if (isCancelled()) {
        return;
    }
    let i = globalId.x + globalId.y * (numWg.x * 64u);
    // Stage 4 Session 8 (storage-budget fix): childEdgeInfo is packed at the END of
    // `subCellAllDuals` (after the totalSlots dual entries), so Pass 14 doesn't need to
    // bind a separate `childEdgeInfo` buffer. The CPU writes 4 packed u32s per sub-edge
    // into 16-byte slots that we read back here via `bitcast`. `subSparseHash.z` carries
    // the sub-edge count; `subCellBases.w` is the base offset (= totalSlots).
    let n = uniforms.subSparseHash.z;
    if (i >= n) {
        return;
    }
    let info_dv = subCellAllDuals[uniforms.subCellBases.w + i];
    let gsx  = bitcast<u32>(info_dv.pos.x);
    let gsy  = bitcast<u32>(info_dv.pos.y);
    let gsz  = bitcast<u32>(info_dv.pos.z);
    let axis = bitcast<u32>(info_dv.fval) & 3u;

    if (axis == 0u) {
        pass14_emit_x_sub_edge(gsx, gsy, gsz);
    } else if (axis == 1u) {
        pass14_emit_y_sub_edge(gsx, gsy, gsz);
    } else {
        pass14_emit_z_sub_edge(gsx, gsy, gsz);
    }
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
        // Session 8: skip base edges where ANY surrounding cube is refined. Pass 14 emits
        // sub-edge MT for those at sub-resolution, using mixed-depth duals so the surface
        // remains a single connected manifold across the refined↔unrefined boundary.
        if (any_cube_around_x_edge_refined(ex, ey, ez, dx, dy, dz)) {
            return;
        }
        emit_pass6_x_edge(ex, ey, ez, dx, dy, dz, nx, ny, nz);
    } else if (slot < nx_count + ny_count) {
        let j = slot - nx_count;
        let grid_idx = dualCompactList[uniforms.sparseBases0.z + j];
        let ex = grid_idx % dx;
        let ey = (grid_idx / dx) % (dy - 1u);
        let ez = grid_idx / (dx * (dy - 1u));
        if (any_cube_around_y_edge_refined(ex, ey, ez, dx, dy, dz)) {
            return;
        }
        emit_pass6_y_edge(ex, ey, ez, dx, dy, dz, nx, ny, nz);
    } else {
        let j = slot - nx_count - ny_count;
        let grid_idx = dualCompactList[uniforms.sparseBases0.w + j];
        let ex = grid_idx % dx;
        let ey = (grid_idx / dx) % dy;
        let ez = grid_idx / (dx * dy);
        if (any_cube_around_z_edge_refined(ex, ey, ez, dx, dy, dz)) {
            return;
        }
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
