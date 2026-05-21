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
// No depth attachment; lines draw on top of the outline pass output so the
// debug overlay is always visible (intentional — the user wants to see
// surviving CSG-cut edges through the model).

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
    _pad2: vec2f,
}

@group(0) @binding(0) var<uniform> camera: OverlayCamera;

struct VOut {
    @builtin(position) position: vec4f,
    // Integer interpolants require @interpolate(flat).
    @location(0) @interpolate(flat) flags: u32,
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
    return out;
}

// Flag bit layout — mirrors `FG_FLAG_*` constants in TS.
const FG_FLAG_ALIVE: u32 = 1u;
const FG_FLAG_CORNER: u32 = 2u;
const FG_FLAG_CREASE_ORIGINAL: u32 = 4u;
const FG_FLAG_CREASE_SUBDIVIDED: u32 = 8u;

@fragment
fn fragmentMain(in: VOut) -> @location(0) vec4f {
    let alive = (in.flags & FG_FLAG_ALIVE) != 0u;
    let corner = (in.flags & FG_FLAG_CORNER) != 0u;
    let subdivided = (in.flags & FG_FLAG_CREASE_SUBDIVIDED) != 0u;

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
