//:) include "hg_sdf.wgsl"

// ============================================================================
// sample_grid.wgsl
//
// Compute shader that samples the scene SDF on a uniform 3D grid and writes
// (scalar distance, gradient direction, gradient magnitude) per voxel into
// CPU-readable storage buffers. This is the GPU half of the SHREC / MergeSharp
// exporter pipeline.
//
// The scene SDF must stay on the GPU (see AGENTS.md), so we evaluate it here
// and read back a precomputed volume. Downstream CPU code (dual contouring,
// MergeSharp vertex relocation) consumes the readback.
//
// Bind point numbers for shared scene data deliberately match mdc.wgsl
// (polygonVertices=27, faceSelection=28, mdcSceneParams=30) so the same
// uniform buffers in render-worker-core.mts can be reused as-is.
// ============================================================================

struct SampleGridUniforms {
    // xyz = grid dimensions in voxels, w = total voxel count (for bounds-checking).
    gridDims: vec4u,
    // xyz = world-space origin of voxel (0,0,0), w = unused.
    gridOffset: vec4f,
    // x = voxel size (mm). y,z,w reserved for future tuning knobs.
    voxelSize: vec4f,
}

@group(0) @binding(0) var<uniform> uniforms: SampleGridUniforms;

// Output: scalar distance per voxel. Layout: idx = (z*ny + y)*nx + x.
@group(0) @binding(1) var<storage, read_write> scalarOut: array<f32>;

// Output: gradient (analytical normal) per voxel. xyz = unit normal, w = |∇f|.
@group(0) @binding(2) var<storage, read_write> gradientOut: array<vec4f>;

// Output: per-voxel CSG seam metadata used by MergeSharp's seam-aware QEF.
//   xyz = unit seam-tangent direction (from `r.seamTangent`).
//   w   = validity flag (0/1/2 — see `sample_grid.wgsl` packing below).
// MergeSharp uses this to constrain its per-cell QEF to a 1D solve along the
// known seam line, eliminating the residual sub-voxel jitter that the pure
// gradient-based QEF leaves on long sharp edges.
@group(0) @binding(3) var<storage, read_write> seamTangentOut: array<vec4f>;

// Output: per-voxel seam verification data.
//   x = seamSdfA  — operand-A's distance at this voxel (signed; from `bestSeam`).
//   y = seamSdfB  — operand-B's distance at this voxel.
//   z = seamGap   — `|sdfA - sdfB|` at the voxel (the smaller, the closer to the seam line).
//   w = seamOp as f32 (0 = no seam at this voxel, 1 = union, 2 = intersection, 3 = difference).
// Used by the CPU SHREC verifier to confirm a candidate vertex genuinely
// sits on the seam line: trilinear-interpolate `sdfA(p)` and `sdfB(p)`
// from the 8 corner voxels of the cell, then check (per operator):
//   union/intersection (w=1 or 2): |sdfA(p) - sdfB(p)| < tol
//   difference        (w=3):       |sdfA(p) + sdfB(p)| < tol
// AND |sdfA(p)| < tol (vertex is on the operand surfaces themselves).
@group(0) @binding(4) var<storage, read_write> seamVerifyOut: array<vec4f>;

// Cancellation flag (matches mdc.wgsl convention).
@group(0) @binding(25) var<storage, read_write> cancelled: atomic<u32>;

// Polygon vertex buffer (shared storage for all Polygon2D vertex data).
@group(0) @binding(27) var<storage, read> polygonVertices: array<vec2f>;

// Face selection (must exist for compilation; not used here).
struct FaceSelection { nodeId: u32, faceIndex: u32, mode: u32, extrudeOffset: f32, pushPullActive: u32, }
@group(0) @binding(28) var<uniform> faceSelection: FaceSelection;
const FACE_HIGHLIGHT_ID: u32 = 1023u;
const FACE_HIGHLIGHT_TOP: u32 = 1023u;
const FACE_HIGHLIGHT_BOTTOM: u32 = 1022u;

// Scene parameter storage (flat f32 layout, same as MDC).
@group(0) @binding(30) var<storage, read> mdcSceneParams: array<f32>;
//:) include "mdc_scene_params_read.wgsl"

fn rectSDF2D(p: vec2f, center: vec2f, tangent: vec2f, normal: vec2f, halfW: f32, halfH: f32) -> f32 {
    let rel = p - center;
    let localX = dot(rel, tangent);
    let localY = dot(rel, normal);
    let dd = vec2f(abs(localX) - halfW, abs(localY) - halfH);
    return length(max(dd, vec2f(0.0))) + min(max(dd.x, dd.y), 0.0);
}

// Auxiliary SDF functions (e.g., per-polygon evaluators) injected at runtime.
//:) insert sceneAuxFast
//:) insert sceneAux

// Full SDF — provides analytical normal in r.n and gradient magnitude r.g.
fn sceneSDF(p: vec3f) -> SDFResult {
    _ = polygonVertices[0];
    _ = faceSelection.nodeId;
    _ = mdcSceneParams[0];
    return sdfTrue(0.0, 0u, vec3f(0.0)); //:) insert sceneSDF
}

// Mid-path SDF (feature payloads for MDC / MergeSharp crossing projection).
fn sceneSDF_mid(p: vec3f) -> SDFResultMid {
    _ = polygonVertices[0];
    _ = faceSelection.nodeId;
    _ = mdcSceneParams[0];
    return sdfRMid(0.0, 1.0, vec3f(0.0)); //:) insert sceneSDF_mid
}

// Packed `SDFResultMid` per voxel for CPU MergeSharp (7 vec4 = 28 f32 / voxel).
@group(0) @binding(5) var<storage, read_write> midFeatureOut: array<vec4f>;

// 3D dispatch: each invocation handles one voxel.
@compute @workgroup_size(4, 4, 4)
fn sampleGrid(@builtin(global_invocation_id) gid: vec3u) {
    if (atomicLoad(&cancelled) != 0u) { return; }

    let dims = uniforms.gridDims.xyz;
    if (gid.x >= dims.x || gid.y >= dims.y || gid.z >= dims.z) { return; }

    let voxelSize = uniforms.voxelSize.x;
    let pos = uniforms.gridOffset.xyz + vec3f(gid) * voxelSize;

    let r = sceneSDF(pos);
    let rmid = sceneSDF_mid(pos);

    let idx = (gid.z * dims.y + gid.y) * dims.x + gid.x;
    scalarOut[idx] = r.d;
    gradientOut[idx] = vec4f(r.n, r.g);

    let midBase = idx * 7u;
    midFeatureOut[midBase + 0u] = vec4f(
        bitcast<f32>(rmid.featureKind),
        rmid.featureDist,
        bitcast<f32>(rmid.featureIdA),
        bitcast<f32>(rmid.featureIdB),
    );
    midFeatureOut[midBase + 1u] = vec4f(
        bitcast<f32>(rmid.featureNormalCount),
        rmid.d,
        rmid.g,
        0.0,
    );
    midFeatureOut[midBase + 2u] = vec4f(rmid.featurePoint, 0.0);
    midFeatureOut[midBase + 3u] = vec4f(rmid.featureTangent, 0.0);
    midFeatureOut[midBase + 4u] = vec4f(rmid.featureN1, 0.0);
    midFeatureOut[midBase + 5u] = vec4f(rmid.featureN2, 0.0);
    midFeatureOut[midBase + 6u] = vec4f(rmid.featureAxisCenter, 0.0);

    // Seam tangent + bevel flag, packed into the w-component:
    //   w = 0.0  →  voxel is OFF any CSG seam (gradient is the unique
    //              per-primitive normal — clean for QEF use).
    //   w = 1.0  →  voxel is ON a CSG seam (within ~1.5 voxels) AND
    //              its analytical SDF gradient `r.n` is the unique
    //              per-plane normal (gap > SURF_DIST in `opUnionEx`/
    //              `opIntersectionEx`, so the operator picked the
    //              dominant operand's normal).
    //   w = 2.0  →  voxel is ON a CSG seam AND in the **bevel band**
    //              (gap < SURF_DIST = 0.001 mm). Inside this band the
    //              CSG operators return `normalize(a.n + b.n)` —
    //              the bevel-direction average — instead of a per-plane
    //              normal. Linear interpolation of bevel and clean
    //              gradients across a cube edge biases the per-cell
    //              QEF and shifts rank-3 corner vertices inward away
    //              from the true 3-plane intersection. CPU MergeSharp
    //              uses this flag to skip bevel-endpoint contributions
    //              when interpolating crossing normals.
    //
    // The 1.5-voxel envelope catches every cell that contains a seam
    // while excluding cells that merely look toward it; the bevel band
    // is much narrower (1 µm) and is a strict subset.
    let onSeam = (r.seamOp != 0u) && (r.seamGap < voxelSize * 1.5);
    let inBevelBand = (r.seamOp != 0u) && (r.seamGap < 0.001);
    let w = select(0.0, select(1.0, 2.0, inBevelBand), onSeam);
    seamTangentOut[idx] = vec4f(r.seamTangent, w);

    // Per-voxel seam verification data — see binding(4) header. The CPU
    // SHREC verifier interpolates these to check whether a candidate
    // vertex is genuinely on the seam (`|sdfA - ±sdfB|` and `|sdfA|`
    // both small) before accepting the seam classification.
    seamVerifyOut[idx] = vec4f(r.seamSdfA, r.seamSdfB, r.seamGap, f32(r.seamOp));
}
