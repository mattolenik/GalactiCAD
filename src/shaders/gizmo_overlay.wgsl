// Transform gizmo overlay — 3 axis arrows (translate) + 3 rotation rings,
// drawn on top of the scene for the selected object.
//
// Projection convention is identical to `feature_graph_overlay.wgsl` (and the
// `mesh-viewer` MDC overlay): `camera.transform` is the *inverse* of the camera
// controller's `viewTransform`, `camera.origin` is the ray-origin-pushed camera
// position, and orthographic scaling maps x∈[-zoom*aspect,+zoom*aspect] and
// y∈[-zoom,+zoom] to NDC [-1,+1], with `viewCenter` shifting the scene rect.
//
// Gizmo geometry is authored in a unit-scale "gizmo-local" space where 1.0
// equals `gizmo.sizeWorld` WORLD units. The vertex shaders convert local →
// world via `world = gizmo.center + local * gizmo.sizeWorld`, so the gizmo is a
// fixed WORLD size anchored to the object: it scales with zoom (grows on screen
// as you zoom in) and rotation rings project to correct ellipses when viewed at
// an angle. Arrowheads + line widths are sized in pixel space below (after
// projection), so they stay a constant on-screen size regardless of zoom.
//
// Two draw paths share this module + bind group:
//   - `lineVertexMain`/`lineFragmentMain`: axis shafts + tessellated rotation
//     rings as instanced screen-space line quads (one instance per segment),
//     expanded to `gizmo.lineWidthPx` and analytically AA'd.
//   - `headVertexMain`/`headFragmentMain`: one billboarded, screen-space
//     arrowhead triangle per axis at the shaft tip.
//
// No depth attachment: the gizmo always draws on top so its handles stay
// grabbable even when behind geometry.

struct OverlayCamera {
    // Inverse of the camera controller's `viewTransform` — world → projection.
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

struct Gizmo {
    // World orientation of the object's local frame — applied to ROTATION RING
    // vertices so the rings align to the object's local axes (translate arrows
    // stay world-aligned). Identity for an unrotated object.
    orient: mat3x3f,
    // World-space center the gizmo is anchored to (object bbox center).
    center: vec3f,
    // Gizmo radius in WORLD units (local unit 1.0 == sizeWorld world units).
    sizeWorld: f32,
    // Handle currently hovered / active, or -1. Handle id = axisId + kind*3,
    // where kind 0 = translate arrow, 1 = rotation ring (so 0..5).
    hoverHandle: i32,
    activeHandle: i32,
    // Line width in framebuffer pixels for shafts + rings.
    lineWidthPx: f32,
    // 0 = hidden (no draws), 1 = visible.
    visible: u32,
}

@group(0) @binding(0) var<uniform> camera: OverlayCamera;
@group(0) @binding(1) var<uniform> gizmo: Gizmo;

// Feathering band, in framebuffer pixels, at the outer edge of the line core.
const LINE_AA_PX: f32 = 1.0;

// Highlight states (mirror the gizmo controller's encoding).
const SEL_HOVER: u32 = 1u;
const SEL_ACTIVE: u32 = 2u;

struct Proj {
    clip: vec2f,
    viewZ: f32,
}

fn project(world: vec3f) -> Proj {
    let aspect = camera.res.x / camera.res.y;
    let pCam = (camera.transform * vec4f(world, 1.0)).xyz;
    let p = pCam - camera.origin;
    let ndcX = p.x / (camera.zoom * aspect);
    let ndcY = p.y / camera.zoom;
    let vcOffsetX = 2.0 * (camera.viewCenter.x - 0.5);
    // Both axes use the SAME sign. The SDF raymarcher (and the gizmo's own CPU
    // hit-test in `gizmo-controller.mts#project`, plus `sdf.mts#updatePivotCursor`)
    // apply viewCenter symmetrically as `uv - viewCenter` in x and y, so the
    // overlay must too. The negated-Y this was copied from (mesh-viewer's opposite
    // uv convention) drifted the drawn gizmo vertically by the editor height
    // whenever viewCenter.y != 0.5 — i.e. when the editor docks to the top in
    // portrait — while the hit regions stayed put. (See featuregraph fix e13def5c.)
    let vcOffsetY = 2.0 * (camera.viewCenter.y - 0.5);
    var o: Proj;
    o.clip = vec2f(ndcX + vcOffsetX, ndcY + vcOffsetY);
    o.viewZ = p.z;
    return o;
}

fn clipToPixels(clip: vec2f) -> vec2f {
    return clip * (camera.res * 0.5);
}

fn pixelsToClip(pix: vec2f) -> vec2f {
    return pix / (camera.res * 0.5);
}

// Local-unit → world scale. The gizmo is a fixed WORLD size, so this is just
// `sizeWorld` (no zoom/resolution term) — the gizmo therefore scales with zoom
// on screen and stays anchored to the object at the same world footprint.
fn gizmoScale() -> f32 {
    return gizmo.sizeWorld;
}

fn localToWorld(local: vec3f) -> vec3f {
    return gizmo.center + local * gizmoScale();
}

// Per-axis base color: X red, Y green, Z blue.
fn axisColor(axisId: u32) -> vec3f {
    if (axisId == 0u) { return vec3f(0.92, 0.26, 0.30); }
    if (axisId == 1u) { return vec3f(0.40, 0.82, 0.36); }
    return vec3f(0.30, 0.52, 0.95);
}

// Hover brightens toward white; active overrides to yellow.
fn applyHighlight(color: vec3f, state: u32) -> vec3f {
    if (state == SEL_ACTIVE) { return vec3f(1.0, 0.85, 0.10); }
    if (state == SEL_HOVER) { return mix(color, vec3f(1.0), 0.4); }
    return color;
}

fn handleState(handleId: i32) -> u32 {
    if (handleId == gizmo.activeHandle) { return SEL_ACTIVE; }
    if (handleId == gizmo.hoverHandle) { return SEL_HOVER; }
    return 0u;
}

// flags bit layout: bits 0..1 = axisId (0/1/2), bit 2 = kind (0 arrow, 1 ring).
// (`meta` is a WGSL reserved keyword, so the instance tag is named `flags`.)
fn metaAxis(flags: u32) -> u32 { return flags & 3u; }
fn metaKind(flags: u32) -> u32 { return (flags >> 2u) & 1u; }
fn metaHandle(flags: u32) -> i32 { return i32(metaAxis(flags) + metaKind(flags) * 3u); }

// Rotation-ring vertices (kind 1) are oriented into the object's local frame;
// arrow vertices (kind 0) stay world-aligned.
fn orientedLocalToWorld(local: vec3f, flags: u32) -> vec3f {
    if (metaKind(flags) == 1u) {
        return gizmo.center + (gizmo.orient * local) * gizmoScale();
    }
    return gizmo.center + local * gizmoScale();
}

struct LineVOut {
    @builtin(position) position: vec4f,
    @location(0) @interpolate(flat) axisId: u32,
    @location(1) @interpolate(flat) state: u32,
    // Signed perpendicular distance from the line center, in framebuffer px.
    @location(2) perpPx: f32,
}

@vertex
fn lineVertexMain(
    @location(0) localA: vec3f,
    @location(1) localB: vec3f,
    @location(2) flags: u32,
    @builtin(vertex_index) vid: u32,
) -> LineVOut {
    let a = project(orientedLocalToWorld(localA, flags));
    let b = project(orientedLocalToWorld(localB, flags));

    let pixA = clipToPixels(a.clip);
    let pixB = clipToPixels(b.clip);

    var dir = pixB - pixA;
    let len = max(length(dir), 1e-6);
    dir = dir / len;
    let normal = vec2f(-dir.y, dir.x);

    let halfExtent = gizmo.lineWidthPx * 0.5 + LINE_AA_PX;

    var alongLUT = array<f32, 6>(0.0, 1.0, 1.0, 0.0, 1.0, 0.0);
    var sideLUT = array<f32, 6>(-1.0, -1.0, 1.0, -1.0, 1.0, 1.0);
    let along = alongLUT[vid];
    let side = sideLUT[vid];

    let basePix = mix(pixA, pixB, along);
    let pix = basePix + normal * (side * halfExtent);

    var out: LineVOut;
    out.position = vec4f(pixelsToClip(pix), 0.5, 1.0);
    out.axisId = metaAxis(flags);
    out.state = handleState(metaHandle(flags));
    out.perpPx = side * halfExtent;
    return out;
}

@fragment
fn lineFragmentMain(in: LineVOut) -> @location(0) vec4f {
    var color = vec4f(applyHighlight(axisColor(in.axisId), in.state), 1.0);
    let coreHalf = gizmo.lineWidthPx * 0.5;
    color.a *= 1.0 - smoothstep(coreHalf, coreHalf + LINE_AA_PX, abs(in.perpPx));
    if (color.a <= 0.0) { discard; }
    return color;
}

struct HeadVOut {
    @builtin(position) position: vec4f,
    @location(0) @interpolate(flat) axisId: u32,
    @location(1) @interpolate(flat) state: u32,
}

// Arrowhead size in framebuffer pixels.
const HEAD_LEN_PX: f32 = 14.0;
const HEAD_HALF_WIDTH_PX: f32 = 6.0;

@vertex
fn headVertexMain(
    @location(0) localTip: vec3f,
    @location(1) localBack: vec3f,
    @location(2) flags: u32,
    @builtin(vertex_index) vid: u32,
) -> HeadVOut {
    let tip = project(localToWorld(localTip));
    let back = project(localToWorld(localBack));
    let tipPix = clipToPixels(tip.clip);
    let backPix = clipToPixels(back.clip);

    var dir = tipPix - backPix;
    let len = max(length(dir), 1e-6);
    dir = dir / len;
    let perp = vec2f(-dir.y, dir.x);

    let baseCenter = tipPix - dir * HEAD_LEN_PX;

    var pix = tipPix;
    if (vid == 1u) { pix = baseCenter + perp * HEAD_HALF_WIDTH_PX; }
    if (vid == 2u) { pix = baseCenter - perp * HEAD_HALF_WIDTH_PX; }

    var out: HeadVOut;
    out.position = vec4f(pixelsToClip(pix), 0.5, 1.0);
    out.axisId = metaAxis(flags);
    out.state = handleState(metaHandle(flags));
    return out;
}

@fragment
fn headFragmentMain(in: HeadVOut) -> @location(0) vec4f {
    return vec4f(applyHighlight(axisColor(in.axisId), in.state), 1.0);
}
