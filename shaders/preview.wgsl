// #include "sdf.wgsl"

struct Particle {
    position: vec4f,
    mass: f32,
}

struct Uniforms {
    color: vec4f,
    radius: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage> particles: array<Particle>;

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
fn fragmentMain(@location(0) uv: vec2f) -> @location(0) vec4f {
    var color = vec4f(0.0);

    for (var i = 0u; i < arrayLength(&particles); i++) {
        let p = particles[i];
        let pos = p.position.xy * 0.5 + 0.5; // Convert to UV space
        let d = distance(uv, pos) - uniforms.radius * p.mass;
        let edge = smoothstep(0.01, 0.0, abs(d));
        color += uniforms.color * edge;
    }

    return color;
}
