//:) include "hg_sdf.wgsl"

const MAX_STEPS: i32 = 500;
const MAX_DIST: f32 = 300.0;
const SURF_DIST: f32 = 0.001;
const NORMAL_EPS: f32 = 0.001;

struct Camera {
    transform: mat4x4f,
    position: vec3f,
    res: vec2f,
    zoom: f32,
};

@group(0) @binding(0) var<uniform> args: array<vec3f, 1024>;
@group(0) @binding(1) var<uniform> camera: Camera;

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
}

fn sceneSDF(p: vec3f) -> f32 {
    return 0; //:) insert sceneSDF
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

fn computeRayOrigin(uv: vec2f, camPos: vec3f) -> vec3f {
    let offsetX = (uv.x * 2.0 - 1.0) * camera.zoom;
    let offsetY = (uv.y * 2.0 - 1.0) * camera.zoom;
    return camPos + vec3f(offsetX, offsetY, 100.0);
}

@fragment
fn fragmentMain(@location(0) fragCoord: vec2f) -> @location(0) vec4f {
    let uv = fragCoord;
    let aspect = camera.res.x / camera.res.y;

    let rayDir = vec3f(0.0, 0.0, -1.0);
    let rayOrigin = computeRayOrigin(vec2f(uv.x*aspect, uv.y), camera.position);

    // Transform the ray from camera space into scene space
    let transformedOrigin = (camera.transform * vec4f(rayOrigin, 1.0)).xyz;
    let transformedDir = normalize((camera.transform * vec4f(rayDir, 0.0)).xyz);

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
        return vec4f(0, 0, 0, 0);
    }
}
