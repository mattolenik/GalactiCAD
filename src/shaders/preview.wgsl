//:) include "hg_sdf.wgsl"

// Reduce MAX_STEPS to prevent GPU saturation
// 100 steps is usually sufficient for most scenes
const MAX_STEPS: i32 = 300;
const MAX_DIST: f32 = 300.0;

struct Camera {
    transform: mat4x4f,
    position: vec3f,
    res: vec2f,
    zoom: f32,
    // Pre-transformed light directions (camera-space → scene-space, computed on CPU)
    lightDir1: vec3f,  // Key light
    lightDir2: vec3f,  // Fill light
    lightDir3: vec3f,  // Rim light
};

// @group(0) @binding(0) var<uniform> args: array<vec3f, 1024>;
@group(0) @binding(1) var<uniform> camera: Camera;

// Click detection state
struct ClickState {
    clickPos: vec2f,     // UV coordinates of click (0-1 range)
    enabled: u32,        // Whether click detection is enabled
}

@group(0) @binding(2) var<uniform> clickState: ClickState;
@group(0) @binding(3) var<storage, read_write> clickedObjectId: atomic<u32>;

// Selected objects: boolean array indexed by object ID (0 = not selected, 1 = selected)
@group(0) @binding(4) var<storage, read> selectedObjectIds: array<u32, 1024>;

// Color palette: 32 pastel colors for shape coloring
@group(0) @binding(5) var<uniform> colorPalette: array<vec3f, 32>;

// View settings
struct ViewSettings {
    xrayMode: u32,  // 0 = normal, 1 = xray/translucent
}
@group(0) @binding(6) var<uniform> viewSettings: ViewSettings;

// Fragment output: color and object ID for MRT outline detection
struct FragmentOutput {
    @location(0) color: vec4f,
    @location(1) objectId: vec4<u32>,
}

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
}

// The contents of sceneSDF are replaced at runtime, do not modify this function.
fn sceneSDF(p: vec3f) -> SDFResult {
    return sdfTrue(0.0, 0u, vec3f(0.0)); //:) insert sceneSDF
}

// Fast version for ray marching - only returns vec2f(distance, gradientMagnitude).
// No tie-breaking, no normals, no normalize() calls.
fn sceneSDF_fast(p: vec3f) -> vec2f {
    return vec2f(0.0, 1.0); //:) insert sceneSDF_fast
}

// Raymarch result includes both distance and SDF info at hit point.
struct RaymarchHit {
    t: f32,          // distance along ray, or -1 if miss
    sdf: SDFResult,  // SDF result at hit point (includes normal)
}

fn raymarch(origin: vec3f, dir: vec3f) -> RaymarchHit {
    var t: f32 = 0.001;
    var lastStep: f32 = 0.0;
    for (var i: i32 = 0; i < MAX_STEPS; i = i + 1) {
        let p = origin + t * dir;
        let sr = sceneSDF_fast(p);  // Fast: only (d, g), no normals/IDs
        // Use g only to reduce step size when needed.
        // Note: g never exceeds 1.0 in current operators, so this is dead code but kept branchless
        let step = select(sr.x, sr.x / sr.y, sr.y > 1.0);  // .x = d, .y = g
        if (sr.x < SURF_DIST) {
            // Only refine hit when needed: large step (CSG seam) or blend region (g < 1)
            if (lastStep > SURF_DIST * 10.0 || sr.y < 1.0) {
                // Refine hit to reduce view-dependent jitter at CSG seams.
                var lo = max(0.0, t - lastStep);
                var hi = t;
                for (var j: i32 = 0; j < 6; j = j + 1) {
                    let mid = 0.5 * (lo + hi);
                    let md = sceneSDF_fast(origin + mid * dir).x;  // Fast: only need d
                    if (md > 0.0) {
                        lo = mid;
                    } else {
                        hi = mid;
                    }
                }
                // Get the full SDF result at the refined hit point (includes analytical normal + ID)
                return RaymarchHit(hi, sceneSDF(origin + hi * dir));
            }
            // Clean surface hit - skip binary search, just get full SDF result
            return RaymarchHit(t, sceneSDF(origin + t * dir));
        }
        lastStep = step;
        t = t + step;
        if (t >= MAX_DIST) {
            break;
        }
    }
    // Miss - return sentinel
    return RaymarchHit(-1.0, sdfTrue(MAX_DIST, 0u, vec3f(0.0)));
}

fn diffuseWrap(n: vec3f, l: vec3f, wrap: f32) -> f32 {
    // "Wrapped" diffuse keeps surfaces lit from multiple angles.
    return clamp((dot(n, l) + wrap) / (1.0 + wrap), 0.0, 1.0);
}

fn lighting(normalScene: vec3f) -> f32 {
    // Light directions are pre-transformed on the CPU and passed via the camera uniform.
    let wrap = 0.3;
    let key  = 0.45 * diffuseWrap(normalScene, camera.lightDir1, wrap);
    let fill = 0.25 * diffuseWrap(normalScene, camera.lightDir2, wrap);
    let rim  = 0.15 * diffuseWrap(normalScene, camera.lightDir3, wrap);

    return clamp(0.15 + key + fill + rim, 0.0, 1.2);
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

// Raymarch starting from inside the surface to find the exit point
fn raymarchFromInside(origin: vec3f, dir: vec3f, startT: f32) -> RaymarchHit {
    var t: f32 = startT + 0.5;  // Start past the entry surface
    var lastStep: f32 = 0.0;
    
    for (var i: i32 = 0; i < MAX_STEPS; i = i + 1) {
        let p = origin + t * dir;
        let sr = sceneSDF_fast(p);  // Fast: only (d, g)
        
        // We're inside, so distance is negative. March by abs(d).
        // Note: g never exceeds 1.0 in current operators, so this is dead code but kept branchless
        let stepRaw = abs(sr.x);    // .x = d
        let step = max(select(stepRaw, stepRaw / sr.y, sr.y > 1.0), 0.1);  // .y = g
        
        // Found an exit surface (going from inside to outside)
        if (sr.x > SURF_DIST) {
            // Only refine exit point when needed: large step (CSG seam) or blend region (g < 1)
            if (lastStep > SURF_DIST * 10.0 || sr.y < 1.0) {
                // Refine the exit point
                var lo = max(startT, t - lastStep);
                var hi = t;
                for (var j: i32 = 0; j < 6; j = j + 1) {
                    let mid = 0.5 * (lo + hi);
                    let md = sceneSDF_fast(origin + mid * dir).x;  // Fast: only need d
                    if (md < 0.0) {
                        lo = mid;
                    } else {
                        hi = mid;
                    }
                }
                // Full evaluation only at final hit point
                return RaymarchHit(hi, sceneSDF(origin + hi * dir));
            }
            // Clean exit surface - skip binary search, just get full SDF result
            return RaymarchHit(t, sceneSDF(origin + t * dir));
        }
        
        lastStep = step;
        t = t + step;
        if (t >= MAX_DIST) {
            break;
        }
    }
    return RaymarchHit(-1.0, sdfTrue(MAX_DIST, 0u, vec3f(0.0)));
}

// Shade a hit point and return the color
// flipNormal: true if hitting surface from inside (back surface)
fn shadeHit(hit: RaymarchHit, flipNormal: bool) -> vec3f {
    // Flip normal for back-facing surfaces
    let normal = select(hit.sdf.n, -hit.sdf.n, flipNormal);

    let diffuse = lighting(normal);
    let baseColor = colorPalette[hit.sdf.id & 31u];
    let shadedColor = baseColor * diffuse;

    let selectedColor = shadedColor * 0.9 + vec3f(0.15);
    return select(shadedColor, selectedColor, selectedObjectIds[hit.sdf.id] != 0u);
}

@fragment
fn fragmentMain(@location(0) fragCoord: vec2f) -> FragmentOutput {
    let uv = fragCoord;
    let aspect = camera.res.x / camera.res.y;

    let rayDir = vec3f(0.0, 0.0, -1.0);
    // Apply aspect correction about the center so the view stays centered.
    let uvAspect = vec2f((uv.x - 0.5) * aspect + 0.5, uv.y);
    let rayOrigin = computeRayOrigin(uvAspect, camera.position);

    // Transform the ray from camera space into scene space
    let transformedOrigin = (camera.transform * vec4f(rayOrigin, 1.0)).xyz;
    let transformedDir = normalize((camera.transform * vec4f(rayDir, 0.0)).xyz);

    // Use standard raymarching
    let hit = raymarch(transformedOrigin, transformedDir);

    // Click detection using pixel-accurate matching
    if (clickState.enabled > 0u && hit.t > 0.0) {
        // Convert UV to pixel coordinates
        let clickPixel = clickState.clickPos * camera.res;
        let currentPixel = uv * camera.res;
        let pixelDist = distance(clickPixel, currentPixel);
        
        if (pixelDist < 1.0) {
            atomicStore(&clickedObjectId, hit.sdf.id);
        }
    }

    if (hit.t > 0.0) {
        let shadedColor = shadeHit(hit, false);
        
        // X-ray mode: show front surface transparent with back surface visible
        if (viewSettings.xrayMode > 0u) {
            // Find the back/interior surface by continuing the ray
            let backHit = raymarchFromInside(transformedOrigin, transformedDir, hit.t);
            
            if (backHit.t > 0.0) {
                // Shade the back surface (flip normal since we hit from inside)
                let backColor = shadeHit(backHit, true);
                
                // Composite: front surface at 40% over back surface
                let frontAlpha = 0.4;
                let composited = shadedColor * frontAlpha + backColor * (1.0 - frontAlpha);
                return FragmentOutput(vec4f(composited, 1.0), vec4<u32>(hit.sdf.id, 0u, 0u, 0u));
            } else {
                // No back surface found, just show transparent front
                let alpha = 0.6;
                return FragmentOutput(vec4f(shadedColor * alpha, alpha), vec4<u32>(hit.sdf.id, 0u, 0u, 0u));
            }
        }
        
        return FragmentOutput(vec4f(shadedColor, 1.0), vec4<u32>(hit.sdf.id, 0u, 0u, 0u));
    } else {
        return FragmentOutput(vec4f(0, 0, 0, 0), vec4<u32>(0xFFFFFFFFu, 0u, 0u, 0u));
    }
}
