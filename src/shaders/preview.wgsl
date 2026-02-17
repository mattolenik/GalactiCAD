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
    xrayMode: u32,        // 0 = normal, 1 = xray/translucent
    refinementSteps: u32, // binary search refinement iterations (e.g. 4 during movement, 8 when idle)
    beamEnabled: u32,     // 0 = disabled (start from t=0), 1 = use beam pre-pass t_start
}
@group(0) @binding(6) var<uniform> viewSettings: ViewSettings;

// Beam optimization: low-res texture with per-tile starting-t from beam pre-pass
const BEAM_TILE_SIZE: i32 = 8;
@group(0) @binding(7) var tStartTex: texture_2d<f32>;

// Fragment output: color and object ID for MRT outline detection
struct FragmentOutput {
    @location(0) color: vec4f,
    @location(1) objectId: vec4<u32>,
}

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
}

// Auxiliary SDF functions (e.g., per-polygon evaluators) are injected here at runtime.
//:) insert sceneAux

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

fn raymarch(origin: vec3f, dir: vec3f, t_start: f32) -> RaymarchHit {
    var t: f32 = t_start;
    var lastStep: f32 = 0.0;
    for (var i: i32 = 0; i < MAX_STEPS; i = i + 1) {
        let p = origin + t * dir;
        let sr = sceneSDF_fast(p);  // Fast: only (d, g), no normals/IDs
        let step = sr.x;
        if (sr.x < SURF_DIST) {
            // Only refine hit when needed: large step (CSG seam) or blend region (g < 1)
            if (lastStep > SURF_DIST * 10.0 || sr.y < 1.0) {
                // Refine hit to reduce view-dependent jitter at CSG seams.
                var lo = max(0.0, t - lastStep);
                var hi = t;
                for (var j: u32 = 0; j < viewSettings.refinementSteps; j = j + 1) {
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

fn lighting(normalScene: vec3f) -> f32 {
    // Light directions are pre-transformed on the CPU and passed via the camera uniform.
    let key  = 0.45 * dot(normalScene, camera.lightDir1);
    let fill = 0.25 * dot(normalScene, camera.lightDir2);
    let rim  = 0.15 * dot(normalScene, camera.lightDir3);

    return clamp(0.25 + key + fill + rim, 0.0, 1.2);
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
        let step = max(abs(sr.x), 0.1);
        
        // Found an exit surface (going from inside to outside)
        if (sr.x > SURF_DIST) {
            // Only refine exit point when needed: large step (CSG seam) or blend region (g < 1)
            if (lastStep > SURF_DIST * 10.0 || sr.y < 1.0) {
                // Refine the exit point
                var lo = max(startT, t - lastStep);
                var hi = t;
                for (var j: u32 = 0; j < viewSettings.refinementSteps; j = j + 1) {
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

    // Color and selection: only do second lookups when blending is active
    let color1 = colorPalette[hit.sdf.id & 31u];
    let bw = hit.sdf.blend;
    var baseColor = color1;
    if (bw > 0.0) {
        let color2 = colorPalette[hit.sdf.id2 & 31u];
        baseColor = color1 * (1.0 - bw) + color2 * bw;
    }
    let shadedColor = baseColor * diffuse;

    let sel1 = f32(selectedObjectIds[hit.sdf.id] != 0u);
    var selBlend = sel1;
    if (bw > 0.0) {
        let sel2 = f32(selectedObjectIds[hit.sdf.id2] != 0u);
        selBlend = mix(sel1, sel2, bw);
    }
    let selectedColor = shadedColor * 0.9 + vec3f(0.15);
    return shadedColor * (1.0 - selBlend) + selectedColor * selBlend;
}

@fragment
fn fragmentMain(@location(0) fragCoord: vec2f) -> FragmentOutput {
    let uv = fragCoord;
    let aspect = camera.res.x / camera.res.y;

    // Apply aspect correction about the center so the view stays centered.
    let uvAspect = vec2f((uv.x - 0.5) * aspect + 0.5, uv.y);
    let rayOrigin = computeRayOrigin(uvAspect, camera.position);

    // Transform the ray from camera space into scene space
    let transformedOrigin = (camera.transform * vec4f(rayOrigin, 1.0)).xyz;
    let transformedDir = -camera.transform[2].xyz;

    // Read beam pre-pass starting distance for this tile (or 0 if beam disabled)
    var t_start = 0.0;
    if (viewSettings.beamEnabled != 0u) {
        let tileCoord = vec2i(uv * camera.res) / BEAM_TILE_SIZE;
        t_start = textureLoad(tStartTex, tileCoord, 0).x;
    }

    // Use standard raymarching, starting from beam distance
    let hit = raymarch(transformedOrigin, transformedDir, t_start);

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
