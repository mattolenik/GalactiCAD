// Post-process blit pass — upsamples the scene-resolution color attachment
// to the canvas. Selection rendering (object tint + 1-pixel boundary
// outline via fwidth) is now inline in the SDF scene shader (preview.wgsl
// `fragmentMain` / `shadeHit`), so this pass has no selection logic — it's
// a pure bilinear sample. When the canvas size equals the scene-color
// texture size, the worker skips this pass entirely and uses
// `commandEncoder.copyTextureToTexture` instead.
//
// Bindings 1 (idTex) and 2 (selectedObjectIds) remain declared for
// backwards-compatibility with the existing bind group entries; they're
// kept alive in the auto-derived bind group layout via `_ =` references
// below. They can be removed in a follow-up cleanup along with the now-
// dead `OutlineSettings` uniform.

@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var idTex: texture_2d<u32>;
@group(0) @binding(2) var<storage, read> selectedObjectIds: array<u32, 1024>;
@group(0) @binding(4) var colorSampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
}

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var pos = array(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(1.0, 1.0));
    var output: VertexOutput;
    output.position = vec4f(pos[vertexIndex], 0.0, 1.0);
    output.uv = (pos[vertexIndex] + vec2f(1.0)) * 0.5;
    return output;
}

@fragment
fn fragmentMain(@builtin(position) fragPos: vec4f, @location(0) uv: vec2f) -> @location(0) vec4f {
    // Keep idTex / selectedObjectIds in the auto-derived bind group layout
    // so the existing TS-side bind group entries don't error out. Cheap to
    // touch and the compiler folds these into no-ops.
    let dims = textureDimensions(idTex);
    _ = textureLoad(idTex, vec2i(0), 0).x;
    _ = selectedObjectIds[0];
    _ = dims;
    // Y flip: vertex UV has Y=0 at bottom (clip-space convention);
    // textureSample uses Y=0 at top.
    let texUV = vec2f(uv.x, 1.0 - uv.y);
    return textureSample(colorTex, colorSampler, texUV);
}
