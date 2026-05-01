//:) include "hg_sdf.wgsl"

// Grid + MDC tuning layout — byte-for-byte compatible with `SharedUniforms` in mdc.wgsl
// so the same uniform packing as MDCExport can be reused.
struct SharedUniforms {
    gridDimensions: vec3u,
    isoValue: f32,
    gridOffset: vec3f,
    voxelSize: f32,
    mdcF0: vec4f,
    mdcF1: vec4f,
    mdcF2: vec4f,
    mdcF3: vec4f,
    mdcU0: vec4u,
}

@group(0) @binding(0) var<uniform> uniforms: SharedUniforms;

// Dense scalar samples at each grid vertex (linear index matches mdc `gridIndexTo3D`).
@group(0) @binding(1) var<storage, read_write> ascGridScalars: array<f32>;

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

// Same helper as mdc.wgsl / bounds.wgsl — injected `sceneAux*` may call `rectSDF2D` (e.g. polygon2d).
fn rectSDF2D(p: vec2f, center: vec2f, tangent: vec2f, normal: vec2f, halfW: f32, halfH: f32) -> f32 {
    let rel = p - center;
    let localX = dot(rel, tangent);
    let localY = dot(rel, normal);
    let dd = vec2f(abs(localX) - halfW, abs(localY) - halfH);
    return length(max(dd, vec2f(0.0))) + min(max(dd.x, dd.y), 0.0);
}

// Auxiliary SDF functions (e.g., per-polygon evaluators) are injected here at runtime.
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

// Fast path: must reference polygon / face / params so all @group(0) bindings stay in the
// pipeline layout (this module has only one entry point; otherwise binding 28 is elided).
fn sceneSDF_fast(p: vec3f) -> FastSDFResult {
    _ = polygonVertices[0];
    _ = faceSelection.nodeId;
    _ = mdcSceneParams[0];
    return sdfFast(0.0, 1.0, 1.0); //:) insert sceneSDF_fast
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

// One thread per grid vertex. Dispatch as 2D grid of workgroups (see mdc edge pass).
@compute @workgroup_size(256u, 1u, 1u)
fn ascGridScalar_sample(
    @builtin(global_invocation_id) globalId: vec3u,
    @builtin(num_workgroups) numWg: vec3u,
) {
    let idx = globalId.x + globalId.y * (numWg.x * 256u);
    let nx = uniforms.gridDimensions.x;
    let ny = uniforms.gridDimensions.y;
    let nz = uniforms.gridDimensions.z;
    let total = nx * ny * nz;
    if (idx >= total) {
        return;
    }
    let g = gridIndexTo3D(idx);
    let p = gridPosToWorldPos(g);
    let d = sceneSDF_fast(p).d;
    ascGridScalars[idx] = d - uniforms.isoValue;
}
