////- include "sdf.wgsl"

const NUM_ARGS: u32 = 8;
const MAX_STEPS: i32 = 100;
const MAX_DIST: f32 = 100.0;
const SURF_DIST: f32 = 0.001;
const NORMAL_EPS: f32 = 0.001;

@group(0) @binding(0) var<uniform> args: array<vec4f, NUM_ARGS>;

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
}

fn sdSphere(p: vec3f, r: f32) -> f32 {
    return length(p) - r;
}

fn sceneSDF(p: vec3f) -> f32 {
    return 0 // COMPILEDHERE
}

fn raymarch(origin: vec3f, dir: vec3f) -> f32 {
    var t: f32 = 0.0;
    for (var i: i32 = 0; i < MAX_STEPS; i = i + 1) {
         let p = origin + t * dir;
         let d = sceneSDF(p);
         if (d < SURF_DIST) {
             return t;
         }
         t = t + d;
         if (t >= MAX_DIST) {
             break;
         }
    }
    return -1.0;
}

fn estimateNormal(p: vec3f) -> vec3f {
    let eps = NORMAL_EPS;
    let dx = vec3f(eps, 0.0, 0.0);
    let dy = vec3f(0.0, eps, 0.0);
    let dz = vec3f(0.0, 0.0, eps);

    let nx = sceneSDF(p + dx) - sceneSDF(p - dx);
    let ny = sceneSDF(p + dy) - sceneSDF(p - dy);
    let nz = sceneSDF(p + dz) - sceneSDF(p - dz);

    return normalize(vec3f(nx, ny, nz));
}

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var pos = array(
        vec2f(-1.0, -1.0),
        vec2f( 1.0, -1.0),
        vec2f(-1.0,  1.0),
        vec2f( 1.0,  1.0)
    );
    var output: VertexOutput;
    output.position = vec4f(pos[vertexIndex], 0.0, 1.0);
    output.uv = (pos[vertexIndex] + vec2f(1.0)) * 0.5;
    return output;
}

@fragment
fn fragmentMain(@location(0) uv: vec2f) -> @location(0) vec4f {
    // Set up a basic camera: located at (0, 0, -3) and pointing towards positive z
    var rayOrigin = vec3f(0.0, 0.0, -3.0);
    var rayDir = normalize(vec3f(uv * 2.0 - 1.0, 1.0));

    let t = raymarch(rayOrigin, rayDir);

    if (t > 0.0) {
         let p = rayOrigin + t * rayDir;
         let normal = estimateNormal(p);
         let lightDir = normalize(vec3f(0.5, 0.8, -1.0));
         let diffuse = clamp(dot(normal, lightDir), 0.0, 1.0);
         let baseColor = vec3f(0.7, 0.7, 0.9); // Example sphere color
         let shadedColor = baseColor * diffuse;
         return vec4f(shadedColor, 1.0);
    } else {
         // Background gradient
         return vec4f(uv, 0.5, 1.0);
    }
}
