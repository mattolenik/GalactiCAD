//- include "sdf.wgsl"

const NUM_ARGS: u32 = 0;
const MAX_STEPS: i32 = 5000;
const MAX_DIST: f32 = 500.0;
const SURF_DIST: f32 = 0.001;
const NORMAL_EPS: f32 = 0.001;

@group(0) @binding(0) var<uniform> args: array<vec4f, NUM_ARGS>;
@group(0) @binding(1) var<uniform> sceneTransform: mat4x4f;
@group(0) @binding(2) var<uniform> cameraPosition: vec4f;
@group(0) @binding(3) var<uniform> orthoScale: f32;

// struct CameraInfo {
// }

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
}

fn sceneSDF(p: vec3f) -> f32 {
    return 0; // COMPILEDHERE
}

fn raymarch(origin: vec3f, dir: vec3f) -> f32 {
    var t: f32 = 0.001;
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
    var pos = array(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(1.0, 1.0));
    var output: VertexOutput;
    output.position = vec4f(pos[vertexIndex], 0.0, 1.0);
    output.uv = (pos[vertexIndex] + vec2f(1.0)) * 0.5;
    return output;
}

fn computeRayDirection() -> vec3f {
    // For an orthographic camera, all rays have the same direction.
    return vec3f(0.0, 0.0, -1.0);
}
fn computeRayOrigin(uv: vec2f, camPos: vec3f) -> vec3f {
    // Map uv from [0, 1] to [-1, 1] and scale by orthScale.
    let offsetX = (uv.x * 2.0 - 1.0) * orthoScale;
    let offsetY = (uv.y * 2.0 - 1.0) * orthoScale;
    // For an orthographic camera, the ray origin in camera space is camPos offset in x and y.
    return camPos + vec3f(offsetX, offsetY, 100.00);
}

@fragment
fn fragmentMain(@location(0) uv: vec2f) -> @location(0) vec4f {
    // Get the fixed camera position from uniform.
    let camPos = cameraPosition.xyz;

    // Compute the ray in camera space.
    let rayOriginCamera = computeRayOrigin(uv, camPos);
    let rayDirCamera = computeRayDirection();

    // Transform the ray from camera space into scene space.
    // sceneTransform here is V⁻¹, which takes points from camera space to world (scene) space.
    let transformedOrigin = (sceneTransform * vec4f(rayOriginCamera, 1.0)).xyz;
    let transformedDir = normalize((sceneTransform * vec4f(rayDirCamera, 0.0)).xyz);

    // Use the transformed ray for raymarching.
    let t = raymarch(transformedOrigin, transformedDir);

    if (t > 0) {
        let p = transformedOrigin + t * transformedDir;
        let normal = estimateNormal(p);
        let lightDir = normalize(vec3f(0.5, 0.8, -1.0));
        let diffuse = clamp(dot(normal, lightDir), 0.0, 1.0);
        let baseColor = vec3f(1.0, 0.5, 0.2);
        let shadedColor = baseColor * diffuse;
        return vec4f(shadedColor, 1.0);
    } else {
        // Background gradient.
        return vec4f(uv, 0.5, 1.0);
    }
}
