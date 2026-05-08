//:) include "hg_sdf.wgsl"

// ============================================================================
// iso_sample_batch.wgsl
//
// Batched world-space samples of the scene SDF for iso-simplicial / Hermite
// pipelines. Each invocation evaluates `sceneSDF` once at a caller-provided
// position and writes one `vec4f`:
//   xyz — analytical unit normal `sceneSDF(p).n`
//   w   — signed distance `sceneSDF(p).d`
//
// Input positions are packed as contiguous `f32` triples [x,y,z, x,y,z, …]
// in `positionsIn` (binding 1) so host layouts match tight `Float32Array`
// uploads without WGSL `array<vec3f>` 16-byte stride padding.
//
// Bindings 25 / 27 / 28 / 30 align with `sample_grid.wgsl` / `mdc.wgsl` so
// the same `polygonVertices`, `faceSelection`, and `mdcSceneParams` buffers
// from a scene build bind without rebinding layouts.
// ============================================================================

struct IsoSampleBatchUniforms {
    sampleCount: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
}

@group(0) @binding(0) var<uniform> uniforms: IsoSampleBatchUniforms;

// Tightly packed world positions: index `base = 3u * i` → x,y,z at f32[base..base+2].
@group(0) @binding(1) var<storage, read> positionsIn: array<f32>;

// Per sample: vec4(nx, ny, nz, distance d).
@group(0) @binding(2) var<storage, read_write> sdfOut: array<vec4f>;

@group(0) @binding(25) var<storage, read_write> cancelled: atomic<u32>;

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

fn rectSDF2D(p: vec2f, center: vec2f, tangent: vec2f, normal: vec2f, halfW: f32, halfH: f32) -> f32 {
    let rel = p - center;
    let localX = dot(rel, tangent);
    let localY = dot(rel, normal);
    let dd = vec2f(abs(localX) - halfW, abs(localY) - halfH);
    return length(max(dd, vec2f(0.0))) + min(max(dd.x, dd.y), 0.0);
}

//:) insert sceneAuxFast
//:) insert sceneAux

fn sceneSDF(p: vec3f) -> SDFResult {
    _ = polygonVertices[0];
    _ = faceSelection.nodeId;
    _ = mdcSceneParams[0];
    return sdfTrue(0.0, 0u, vec3f(0.0)); //:) insert sceneSDF
}

@compute @workgroup_size(256)
fn isoSampleBatch(@builtin(global_invocation_id) gid: vec3u) {
    if (atomicLoad(&cancelled) != 0u) { return; }

    let i = gid.x;
    if (i >= uniforms.sampleCount) { return; }

    let base = 3u * i;
    let p = vec3f(positionsIn[base], positionsIn[base + 1u], positionsIn[base + 2u]);
    let r = sceneSDF(p);
    sdfOut[i] = vec4f(r.n, r.d);
}
