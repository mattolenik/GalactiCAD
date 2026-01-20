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

// @group(0) @binding(0) var<uniform> args: array<vec3f, 1024>;
@group(0) @binding(1) var<uniform> camera: Camera;

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
}

// The contents of sceneSDF are replaced at runtime, do not modify this function.
fn sceneSDF(p: vec3f) -> f32 {
    return 0.0; //:) insert sceneSDF
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

fn diffuseWrap(n: vec3f, l: vec3f, wrap: f32) -> f32 {
    // "Wrapped" diffuse keeps surfaces lit from multiple angles.
    return clamp((dot(n, l) + wrap) / (1.0 + wrap), 0.0, 1.0);
}

fn lighting(normalScene: vec3f) -> f32 {
    // Define lights in camera-space so they move with the camera.
    let lCam1 = normalize(vec3f(0.6, 0.7, -1.0));
    let lCam2 = normalize(vec3f(-0.8, 0.2, -1.0));
    let lCam3 = normalize(vec3f(0.2, -0.9, -1.0));
    let lCamBack = normalize(vec3f(-0.2, 0.2, 1.0));

    // Transform light directions into scene-space (same convention as rays).
    let l1 = normalize((camera.transform * vec4f(lCam1, 0.0)).xyz);
    let l2 = normalize((camera.transform * vec4f(lCam2, 0.0)).xyz);
    let l3 = normalize((camera.transform * vec4f(lCam3, 0.0)).xyz);
    let lb = normalize((camera.transform * vec4f(lCamBack, 0.0)).xyz);

    let wrap = 0.25;
    let key = 0.55 * diffuseWrap(normalScene, l1, wrap);
    let fill = 0.30 * diffuseWrap(normalScene, l2, wrap);
    let rim = 0.20 * diffuseWrap(normalScene, l3, wrap);
    let back = 0.15 * diffuseWrap(normalScene, lb, 0.40);

    let ambient = 0.18;
    return clamp(ambient + key + fill + rim + back, 0.0, 1.3);
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
    // Apply aspect correction about the center so the view stays centered.
    let uvAspect = vec2f((uv.x - 0.5) * aspect + 0.5, uv.y);
    let rayOrigin = computeRayOrigin(uvAspect, camera.position);

    // Transform the ray from camera space into scene space
    let transformedOrigin = (camera.transform * vec4f(rayOrigin, 1.0)).xyz;
    let transformedDir = normalize((camera.transform * vec4f(rayDir, 0.0)).xyz);

    // Use the transformed ray for raymarching.
    let t = raymarch(transformedOrigin, transformedDir);

    if (t > 0) {
        let p = transformedOrigin + t * transformedDir;
        let normal = estimateNormal(p);
        let diffuse = lighting(normal);
        let baseColor = vec3f(1.0, 0.5, 0.2);
        let shadedColor = baseColor * diffuse;
        return vec4f(shadedColor, 1.0);
    } else {
        return vec4f(0, 0, 0, 0);
    }
}
