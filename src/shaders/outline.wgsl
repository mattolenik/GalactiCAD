// Post-process blit pass — upsamples the scene-resolution color attachment
// to a caller-supplied output target. Selection rendering (object tint + 1
// px boundary outline via fwidth) lives inline in the SDF scene shader
// (preview.wgsl `fragmentMain` / `shadeHit`).
//
// Used only when the worker renders to a foreign `outputTextureView`
// (off-screen captures, thumbnails). The interactive canvas path skips
// this pass entirely and writes scene fragments straight into the
// canvas swapchain texture.
//
// Previous bindings (`idTex`, `selectedObjectIds`, `outlineSettings`)
// were dropped along with the per-pixel stencil scan that read them.

@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var colorSampler: sampler;

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
    // Y flip: vertex UV has Y=0 at bottom (clip-space convention);
    // textureSample uses Y=0 at top.
    let texUV = vec2f(uv.x, 1.0 - uv.y);
    return textureSample(colorTex, colorSampler, texUV);
}
