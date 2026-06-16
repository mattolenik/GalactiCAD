// FeatureGraph debug overlay — line draw over the rendered scene.
//
// The projection convention matches `mesh-viewer.mts`'s MDC overlay shader,
// which is the canonical reference for projecting world-space vertices in
// this app:
//
//   - `camera.transform` is uploaded as the *inverse* of the camera
//     controller's `viewTransform`. The vertex shader multiplies a world
//     position by this directly (no in-shader inversion).
//   - `camera.origin` is `cameraPosition + (0, 0, PREVIEW_RAY_ORIGIN_DEPTH)`
//     — the same ray-origin offset the SDF preview's ray-marcher uses, so
//     overlay geometry lines up pixel-perfectly with what the preview shows.
//   - Orthographic scaling: x in `[-zoom*aspect, +zoom*aspect]` → NDC
//     `[-1, +1]`, y in `[-zoom, +zoom]` → `[-1, +1]`.
//   - `viewCenter` offsets the scene rectangle inside the canvas (matches
//     the editor-overlay shift the preview applies).
//
// By default there is no depth attachment; lines draw on top of the outline
// pass output so the debug overlay is always visible (the user wants to see
// surviving CSG-cut edges through the model). The optional `occlusionMode`
// re-introduces depth ordering by sampling a world-space hit-position texture
// produced by the SDF raymarch's depth-only pass (see `depthOnlyMain` in
// preview.wgsl) and comparing it against each line vertex's re-projected depth.

struct OverlayCamera {
    // Inverse of camera controller's `viewTransform` — applied directly to a
    // world point gives the projection-space point.
    transform: mat4x4f,
    // `cameraPosition + (0, 0, PREVIEW_RAY_ORIGIN_DEPTH)`.
    origin: vec3f,
    _pad0: f32,
    res: vec2f,
    zoom: f32,
    _pad1: f32,
    // Center of the visible (non-editor) area in UV space (0–1).
    viewCenter: vec2f,
    // 0 = off (draw on top), 1 = hard (hide occluded), 2 = dim (fade occluded).
    occlusionMode: u32,
    _pad2: u32,
}

@group(0) @binding(0) var<uniform> camera: OverlayCamera;
// Scene surface as world-space hit position (xyz) + hit mask (w), produced by
// the SDF depth-only pass at scene render resolution. rgba32float, read with
// `textureLoad` (unfilterable). Bound to a 1×1 dummy when occlusion is off.
@group(0) @binding(1) var sceneDepthTex: texture_2d<f32>;

struct VOut {
    @builtin(position) position: vec4f,
    // Integer interpolants require @interpolate(flat).
    @location(0) @interpolate(flat) flags: u32,
    // This vertex's depth in the overlay's projection space
    // (`(camera.transform * world - origin).z`), interpolated along the line
    // so the fragment can compare it against the re-projected surface depth.
    @location(1) viewZ: f32,
}

@vertex
fn vertexMain(
    @location(0) worldPos: vec3f,
    @location(1) inFlags: u32,
) -> VOut {
    let aspect = camera.res.x / camera.res.y;
    let pCam = (camera.transform * vec4f(worldPos, 1.0)).xyz;
    let p = pCam - camera.origin;
    let ndcX = p.x / (camera.zoom * aspect);
    let ndcY = p.y / camera.zoom;
    // Use a generous near/far range so the overlay never clips against
    // the depth slice — there's no depth attachment, but the rasteriser
    // still requires `position.z` in `[0, 1]` for visible primitives.
    let near = -10000.0;
    let far = 10000.0;
    let ndcZ = clamp((far - p.z) / (far - near), 0.0, 1.0);
    let vcOffsetX = 2.0 * (camera.viewCenter.x - 0.5);
    let vcOffsetY = -2.0 * (camera.viewCenter.y - 0.5);
    var out: VOut;
    out.position = vec4f(ndcX + vcOffsetX, ndcY + vcOffsetY, ndcZ, 1.0);
    out.flags = inFlags;
    out.viewZ = p.z;
    return out;
}

// Flag bit layout — mirrors `FG_FLAG_*` constants in TS.
const FG_FLAG_ALIVE: u32 = 1u;
const FG_FLAG_CORNER: u32 = 2u;
const FG_FLAG_CREASE_ORIGINAL: u32 = 4u;
const FG_FLAG_CREASE_SUBDIVIDED: u32 = 8u;

// Depth bias in overlay view-space units (== world units). A feature edge that
// lies ON the visible surface has `viewZ` ≈ the surface's re-projected depth;
// the bias keeps such coincident edges drawn and only hides edges that sit
// clearly BEHIND the surface (CSG-cut interiors, far-side creases).
const OCCLUSION_BIAS: f32 = 0.5;
// Alpha multiplier applied to occluded edges in "dim" mode.
const OCCLUSION_DIM: f32 = 0.18;

fn featureColor(flags: u32) -> vec4f {
    let alive = (flags & FG_FLAG_ALIVE) != 0u;
    let corner = (flags & FG_FLAG_CORNER) != 0u;
    let subdivided = (flags & FG_FLAG_CREASE_SUBDIVIDED) != 0u;

    if (!alive) {
        return vec4f(0.6, 0.15, 0.15, 0.7);
    }
    if (corner) {
        return vec4f(1.0, 0.95, 0.2, 1.0);
    }
    if (subdivided) {
        return vec4f(0.25, 0.85, 0.95, 0.9);
    }
    return vec4f(0.25, 0.95, 0.35, 1.0);
}

@fragment
fn fragmentMain(in: VOut) -> @location(0) vec4f {
    var color = featureColor(in.flags);

    if (camera.occlusionMode != 0u) {
        // `in.position.xy` is in the (full-res) overlay target's framebuffer
        // pixels; normalize then index the (scene-res) depth texture. Nearest
        // load (no filtering) avoids blending surface depth with the miss
        // sentinel across silhouettes.
        let dims = vec2f(textureDimensions(sceneDepthTex));
        let uv = clamp(in.position.xy / camera.res, vec2f(0.0), vec2f(1.0));
        let texel = vec2i(min(uv * dims, dims - vec2f(1.0)));
        let surf = textureLoad(sceneDepthTex, texel, 0);
        if (surf.w > 0.5) {
            // Re-project the surface world position through the overlay's own
            // camera, identical to the vertex math, so the depths are directly
            // comparable. Larger `viewZ` is nearer the camera (see `ndcZ`), so
            // the edge is occluded when it sits behind the surface.
            let surfZ = ((camera.transform * vec4f(surf.xyz, 1.0)).xyz - camera.origin).z;
            if (in.viewZ < surfZ - OCCLUSION_BIAS) {
                if (camera.occlusionMode == 1u) {
                    discard;
                }
                color.a *= OCCLUSION_DIM;
            }
        }
    }

    return color;
}
