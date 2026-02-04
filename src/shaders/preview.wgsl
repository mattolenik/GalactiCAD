//:) include "hg_sdf.wgsl"

// Reduce MAX_STEPS to prevent GPU saturation
// 100 steps is usually sufficient for most scenes
const MAX_STEPS: i32 = 100;
const MAX_DIST: f32 = 300.0;

struct Camera {
    transform: mat4x4f,
    position: vec3f,
    res: vec2f,
    zoom: f32,
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

// Selected objects array: [count, id1, id2, ...]
// Using storage buffer because uniform requires 16-byte alignment per element
@group(0) @binding(4) var<storage, read> selectedObjectIds: array<u32, 64>;

// Color palette: 32 pastel colors for shape coloring
@group(0) @binding(5) var<uniform> colorPalette: array<vec3f, 32>;

// View settings
struct ViewSettings {
    xrayMode: u32,  // 0 = normal, 1 = xray/translucent
}
@group(0) @binding(6) var<uniform> viewSettings: ViewSettings;

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
}

// The contents of sceneSDF are replaced at runtime, do not modify this function.
fn sceneSDF(p: vec3f) -> SDFResult {
    return sdfTrue(0.0, 0u, vec3f(0.0)); //:) insert sceneSDF
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
        let sr = sceneSDF(p);
        // Use g only to reduce step size when needed.
        var step = sr.d;
        if (sr.g > 1.0) {
            step = sr.d / sr.g;
        }
        if (sr.d < SURF_DIST) {
            // Refine hit to reduce view-dependent jitter at CSG seams.
            // 4 iterations = 1/16 precision (reduced from 8 for performance)
            var lo = max(0.0, t - lastStep);
            var hi = t;
            for (var j: i32 = 0; j < 4; j = j + 1) {
                let mid = 0.5 * (lo + hi);
                let md = sceneSDF(origin + mid * dir).d;
                if (md > 0.0) {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            // Get the SDF result at the refined hit point (includes analytical normal)
            let hitSdf = sceneSDF(origin + hi * dir);
            return RaymarchHit(hi, hitSdf);
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

// Fallback normal estimation using tetrahedron gradient (4 samples instead of 6)
fn estimateNormalFallback(p: vec3f) -> vec3f {
    let eps = SURF_DIST * 0.5;
    let k = vec2f(1.0, -1.0);
    return normalize(
        k.xyy * sceneSDF(p + k.xyy * eps).d +
        k.yyx * sceneSDF(p + k.yyx * eps).d +
        k.yxy * sceneSDF(p + k.yxy * eps).d +
        k.xxx * sceneSDF(p + k.xxx * eps).d
    );
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

// Raymarch starting from inside the surface to find the exit point
fn raymarchFromInside(origin: vec3f, dir: vec3f, startT: f32) -> RaymarchHit {
    var t: f32 = startT + 0.5;  // Start past the entry surface
    var lastStep: f32 = 0.0;
    
    for (var i: i32 = 0; i < MAX_STEPS; i = i + 1) {
        let p = origin + t * dir;
        let sr = sceneSDF(p);
        
        // We're inside, so distance is negative. March by abs(d).
        var step = abs(sr.d);
        if (sr.g > 1.0) {
            step = step / sr.g;
        }
        step = max(step, 0.1);
        
        // Found an exit surface (going from inside to outside)
        if (sr.d > SURF_DIST) {
            // Refine the exit point
            var lo = max(startT, t - lastStep);
            var hi = t;
            for (var j: i32 = 0; j < 6; j = j + 1) {
                let mid = 0.5 * (lo + hi);
                let md = sceneSDF(origin + mid * dir).d;
                if (md < 0.0) {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            let hitSdf = sceneSDF(origin + hi * dir);
            return RaymarchHit(hi, hitSdf);
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
fn shadeHit(origin: vec3f, dir: vec3f, hit: RaymarchHit, flipNormal: bool) -> vec3f {
    var normal = hit.sdf.n;
    if (dot(normal, normal) < 0.001) {
        let p = origin + hit.t * dir;
        normal = estimateNormalFallback(p);
    } else {
        normal = normalize(normal);
    }
    
    // Flip normal for back-facing surfaces
    if (flipNormal) {
        normal = -normal;
    }
    
    let diffuse = lighting(normal);
    var baseColor = colorPalette[hit.sdf.id % 32u];
    
    // Check if selected
    let selectedCount = selectedObjectIds[0];
    var isSelected = false;
    for (var i: u32 = 1u; i <= selectedCount && i < 64u; i = i + 1u) {
        if (hit.sdf.id == selectedObjectIds[i]) {
            isSelected = true;
            break;
        }
    }
    
    var shadedColor = baseColor * diffuse;
    if (isSelected) {
        shadedColor = shadedColor * 0.85 + vec3f(0.15);
    }
    
    return shadedColor;
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
        // Use analytical normal from SDF result (already computed during raymarch)
        var normal = hit.sdf.n;
        if (dot(normal, normal) < 0.001) {
            // Fallback to numerical gradient if analytical normal is degenerate
            let p = transformedOrigin + hit.t * transformedDir;
            normal = estimateNormalFallback(p);
        } else {
            normal = normalize(normal);
        }
        
        let diffuse = lighting(normal);
        
        // Get color from palette using shape ID modulo palette size
        var baseColor = colorPalette[hit.sdf.id % 32u];
        
        // Check if this object is in the selection array
        let selectedCount = selectedObjectIds[0];
        var isSelected = false;
        for (var i: u32 = 1u; i <= selectedCount && i < 64u; i = i + 1u) {
            if (hit.sdf.id == selectedObjectIds[i]) {
                isSelected = true;
                break;
            }
        }
        
        // Calculate base shaded color
        var shadedColor = baseColor * diffuse;
        
        // Add highlight tint for selected objects
        if (isSelected) {
            shadedColor = shadedColor * 0.85 + vec3f(0.15);
        }
        
        // X-ray mode: show front surface transparent with back surface visible
        if (viewSettings.xrayMode > 0u) {
            // Find the back/interior surface by continuing the ray
            let backHit = raymarchFromInside(transformedOrigin, transformedDir, hit.t);
            
            if (backHit.t > 0.0) {
                // Shade the back surface (flip normal since we hit from inside)
                let backColor = shadeHit(transformedOrigin, transformedDir, backHit, true);
                
                // Composite: front surface at 40% over back surface
                let frontAlpha = 0.4;
                let composited = shadedColor * frontAlpha + backColor * (1.0 - frontAlpha);
                return vec4f(composited, 1.0);
            } else {
                // No back surface found, just show transparent front
                let alpha = 0.6;
                return vec4f(shadedColor * alpha, alpha);
            }
        }
        
        return vec4f(shadedColor, 1.0);
    } else {
        return vec4f(0, 0, 0, 0);
    }
}
