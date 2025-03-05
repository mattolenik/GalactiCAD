////- include "sdf.wgsl"

// replaced at runtime
const NUM_ARGS = 0;

@group(0) @binding(0) var<uniform> args: array<vec4f, NUM_ARGS>;

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
}

fn sdSphere(p: vec3f, r: f32) -> f32 {
    return length(p) - r;
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
fn fragmentMain(@location(0) uv: vec2f) -> @location(0) vec4f {
    // COMPILEDHERE
    var color = vec4f(0.0);
    return color;
}
