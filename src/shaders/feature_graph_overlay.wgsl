// FeatureGraph debug overlay — anti-aliased edges + corner markers over the scene.
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
// Two draw paths share this module + bind group:
//   - `vertexMain`/`fragmentMain`: alive crease edges as instanced screen-space
//     quads (one instance per edge), expanded to `camera.lineWidthPx` and
//     feathered with a smoothstep for analytic AA. Caps are *butt* (no length
//     extension), so the many subdivided polyline vertices on a smooth curve
//     leave no visible node — only the line itself shows.
//   - `pointVertexMain`/`pointFragmentMain`: a small AA disc at each *explicit*
//     0D feature (corner) vertex, so corners read as a marked point while plain
//     polyline vertices do not.
//
// By default there is no depth attachment; geometry draws on top of the outline
// pass output so the debug overlay is always visible (the user wants to see
// surviving CSG-cut edges through the model). The optional `occlusionMode`
// re-introduces depth ordering by sampling a world-space hit-position texture
// produced by the SDF raymarch's depth-only pass (see `depthOnlyMain` in
// preview.wgsl) and comparing it against each fragment's re-projected depth.

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
    // Edge line width in framebuffer pixels (dev-tools knob).
    lineWidthPx: f32,
    // 0 = all edges cyan (default); 1 = paint original creases green to
    // distinguish them from subdivided polyline segments (dev-tools knob).
    differentiateSegments: u32,
    // Auto mode is subtle: when 1, ONLY hovered (faded by `hoverFade`) and
    // selected features draw; everything else is hidden (alpha 0).
    autoSubtle: u32,
    // Hover fade-in factor [0,1] for `autoSubtle` mode (quick smoothing).
    hoverFade: f32,
    // struct auto-pads to 128 bytes (16-aligned).
}

@group(0) @binding(0) var<uniform> camera: OverlayCamera;
// Scene surface as world-space hit position (xyz) + hit mask (w), produced by
// the SDF depth-only pass at scene render resolution. rgba32float, read with
// `textureLoad` (unfilterable). Bound to a 1×1 dummy when occlusion is off.
@group(0) @binding(1) var sceneDepthTex: texture_2d<f32>;
// Per-instance highlight state (0 = none, 1 = hover, 2 = selected), one u32 per
// alive edge / corner instance, indexed by `instance_index`. Drives the
// hover-whiten / select-blue recolor for interactive feature selection.
@group(0) @binding(2) var<storage, read> edgeState: array<u32>;
@group(0) @binding(3) var<storage, read> cornerState: array<u32>;

// Highlight state values (mirror the TS overlay's setHighlights encoding).
const FG_SEL_HOVER: u32 = 1u;
const FG_SEL_SELECTED: u32 = 2u;
// Selected features paint solid blue (0x0000FF).
const FG_SELECT_COLOR: vec4f = vec4f(0.0, 0.0, 1.0, 1.0);

// Apply hover/select recolor to a base feature color. Hover mixes 50% toward
// white (preserving alpha); select overrides to solid blue.
fn applyHighlight(color: vec4f, state: u32) -> vec4f {
    if (state == FG_SEL_SELECTED) {
        return FG_SELECT_COLOR;
    }
    if (state == FG_SEL_HOVER) {
        return vec4f(mix(color.rgb, vec3f(1.0), 0.5), color.a);
    }
    return color;
}

// Auto mode is subtle: hide everything except the hovered feature (faded in via
// `hoverFade`) and any selected features. Identity when `autoSubtle` is off.
fn applyAutoSubtle(color: vec4f, state: u32) -> vec4f {
    if (camera.autoSubtle == 0u || state == FG_SEL_SELECTED) {
        return color;
    }
    if (state == FG_SEL_HOVER) {
        return vec4f(color.rgb, color.a * camera.hoverFade);
    }
    return vec4f(color.rgb, 0.0);
}

// Feathering band, in framebuffer pixels, applied at the outer edge of both
// the line core and the corner disc.
const LINE_AA_PX: f32 = 1.0;

struct VOut {
    @builtin(position) position: vec4f,
    @location(0) @interpolate(flat) flags: u32,
    // View-space depth, interpolated, for depth-occlusion comparison.
    @location(1) viewZ: f32,
    // Signed perpendicular distance from the line center, in framebuffer
    // pixels, for the analytic-AA falloff.
    @location(2) perpPx: f32,
    // Highlight state (0 none / 1 hover / 2 selected) for this edge instance.
    @location(3) @interpolate(flat) state: u32,
}

struct PointVOut {
    @builtin(position) position: vec4f,
    @location(0) viewZ: f32,
    // Offset from the disc center, in framebuffer pixels, for radial AA.
    @location(1) offsetPx: vec2f,
    // Highlight state (0 none / 1 hover / 2 selected) for this corner instance.
    @location(2) @interpolate(flat) state: u32,
}

// World point → overlay projection space. Returns the NDC x/y (with the
// viewCenter shift folded in, w = 1) plus the view-space Z used for both
// depth-occlusion and the rasteriser's clamped `position.z`.
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
    let vcOffsetY = -2.0 * (camera.viewCenter.y - 0.5);
    var o: Proj;
    o.clip = vec2f(ndcX + vcOffsetX, ndcY + vcOffsetY);
    o.viewZ = p.z;
    return o;
}

// NDC clip x/y → framebuffer pixels (centered). NDC spans [-1, 1] across `res`
// pixels. clip.x already accounts for aspect, so this yields true pixels.
fn clipToPixels(clip: vec2f) -> vec2f {
    return clip * (camera.res * 0.5);
}

fn pixelsToClip(pix: vec2f) -> vec2f {
    return pix / (camera.res * 0.5);
}

// Generous near/far so the overlay never clips against the (absent) depth
// slice — the rasteriser still requires `position.z` in `[0, 1]`.
fn ndcZFromViewZ(viewZ: f32) -> f32 {
    let near = -10000.0;
    let far = 10000.0;
    return clamp((far - viewZ) / (far - near), 0.0, 1.0);
}

@vertex
fn vertexMain(
    // Per-instance: the two world-space endpoints of one alive edge + flags.
    @location(0) posA: vec3f,
    @location(1) posB: vec3f,
    @location(2) inFlags: u32,
    @builtin(vertex_index) vid: u32,
    @builtin(instance_index) iid: u32,
) -> VOut {
    let a = project(posA);
    let b = project(posB);

    let pixA = clipToPixels(a.clip);
    let pixB = clipToPixels(b.clip);

    var dir = pixB - pixA;
    let len = max(length(dir), 1e-6);
    dir = dir / len;
    let normal = vec2f(-dir.y, dir.x);

    let halfExtent = camera.lineWidthPx * 0.5 + LINE_AA_PX;

    // Two triangles → quad. `along` ∈ {0 at A, 1 at B}; `side` ∈ {-1, +1}.
    // Butt caps (no length extension): the long edges stay continuous across
    // joints, so subdivided polyline vertices leave no node.
    var alongLUT = array<f32, 6>(0.0, 1.0, 1.0, 0.0, 1.0, 0.0);
    var sideLUT = array<f32, 6>(-1.0, -1.0, 1.0, -1.0, 1.0, 1.0);
    let along = alongLUT[vid];
    let side = sideLUT[vid];

    let basePix = mix(pixA, pixB, along);
    let pix = basePix + normal * (side * halfExtent);

    let viewZ = mix(a.viewZ, b.viewZ, along);

    var out: VOut;
    out.position = vec4f(pixelsToClip(pix), ndcZFromViewZ(viewZ), 1.0);
    out.flags = inFlags;
    out.viewZ = viewZ;
    out.perpPx = side * halfExtent;
    out.state = edgeState[iid];
    return out;
}

@vertex
fn pointVertexMain(
    // Per-instance: one corner vertex's world position.
    @location(0) worldPos: vec3f,
    @builtin(vertex_index) vid: u32,
    @builtin(instance_index) iid: u32,
) -> PointVOut {
    let a = project(worldPos);
    let centerPix = clipToPixels(a.clip);

    // Disc radius scales with line width so markers stay proportional.
    let radius = camera.lineWidthPx + 1.0;
    let half = radius + LINE_AA_PX;

    // Centered unit quad covering the disc.
    var qx = array<f32, 6>(-1.0, 1.0, 1.0, -1.0, 1.0, -1.0);
    var qy = array<f32, 6>(-1.0, -1.0, 1.0, -1.0, 1.0, 1.0);
    let offsetPx = vec2f(qx[vid], qy[vid]) * half;

    var out: PointVOut;
    out.position = vec4f(pixelsToClip(centerPix + offsetPx), ndcZFromViewZ(a.viewZ), 1.0);
    out.viewZ = a.viewZ;
    out.offsetPx = offsetPx;
    out.state = cornerState[iid];
    return out;
}

// Flag bit layout — mirrors `FG_FLAG_*` constants in TS.
const FG_FLAG_ALIVE: u32 = 1u;
const FG_FLAG_CORNER: u32 = 2u;
const FG_FLAG_CREASE_ORIGINAL: u32 = 4u;
const FG_FLAG_CREASE_SUBDIVIDED: u32 = 8u;

// Depth bias in overlay view-space units (== world units). A feature that lies
// ON the visible surface has `viewZ` ≈ the surface's re-projected depth; the
// bias keeps such coincident features drawn and only hides ones that sit
// clearly BEHIND the surface (CSG-cut interiors, far-side creases).
const OCCLUSION_BIAS: f32 = 0.5;
// Alpha multiplier applied to occluded fragments in "dim" mode.
const OCCLUSION_DIM: f32 = 0.18;

// Corner marker color (yellow) — corners are the only "explicit feature"
// vertices that get a point marker.
const CORNER_COLOR: vec4f = vec4f(1.0, 0.95, 0.2, 1.0);

// Edge color. Corner-ness is a *vertex* property shown via the point markers,
// so edges carry no corner color. By default every alive edge is cyan; when
// `differentiateSegments` is set, original (non-subdivided) creases are painted
// green so the subdivided polyline segments stand out from the emitted ones.
fn lineColor(flags: u32) -> vec4f {
    if ((flags & FG_FLAG_ALIVE) == 0u) {
        return vec4f(0.6, 0.15, 0.15, 0.7);
    }
    if (camera.differentiateSegments != 0u && (flags & FG_FLAG_CREASE_SUBDIVIDED) == 0u) {
        return vec4f(0.25, 0.95, 0.35, 1.0);
    }
    return vec4f(0.25, 0.85, 0.95, 0.9);
}

// Does the SDF surface occlude a fragment at `fragXY` (framebuffer pixels) with
// the given view-space depth? Always false when occlusion is off.
fn surfaceOccludes(fragXY: vec2f, viewZ: f32) -> bool {
    if (camera.occlusionMode == 0u) {
        return false;
    }
    // `fragXY` is in the (full-res) overlay target's framebuffer pixels;
    // normalize then index the (scene-res) depth texture. Nearest load (no
    // filtering) avoids blending surface depth with the miss sentinel across
    // silhouettes.
    let dims = vec2f(textureDimensions(sceneDepthTex));
    let uv = clamp(fragXY / camera.res, vec2f(0.0), vec2f(1.0));
    let texel = vec2i(min(uv * dims, dims - vec2f(1.0)));
    let surf = textureLoad(sceneDepthTex, texel, 0);
    if (surf.w <= 0.5) {
        return false;
    }
    // Re-project the surface world position through the overlay's own camera,
    // identical to the vertex math, so the depths are directly comparable.
    // Larger `viewZ` is nearer the camera, so a fragment is occluded when it
    // sits behind the surface.
    let surfZ = ((camera.transform * vec4f(surf.xyz, 1.0)).xyz - camera.origin).z;
    return viewZ < surfZ - OCCLUSION_BIAS;
}

@fragment
fn fragmentMain(in: VOut) -> @location(0) vec4f {
    var color = applyAutoSubtle(applyHighlight(lineColor(in.flags), in.state), in.state);

    // Analytic AA across the line width: full coverage inside the solid core,
    // smooth falloff over the AA band at each edge.
    let coreHalf = camera.lineWidthPx * 0.5;
    color.a *= 1.0 - smoothstep(coreHalf, coreHalf + LINE_AA_PX, abs(in.perpPx));

    if (surfaceOccludes(in.position.xy, in.viewZ)) {
        if (camera.occlusionMode == 1u) {
            discard;
        }
        color.a *= OCCLUSION_DIM;
    }

    return color;
}

@fragment
fn pointFragmentMain(in: PointVOut) -> @location(0) vec4f {
    var color = applyAutoSubtle(applyHighlight(CORNER_COLOR, in.state), in.state);

    // Radial AA disc.
    let radius = camera.lineWidthPx + 1.0;
    let dist = length(in.offsetPx);
    color.a *= 1.0 - smoothstep(radius, radius + LINE_AA_PX, dist);
    if (color.a <= 0.0) {
        discard;
    }

    if (surfaceOccludes(in.position.xy, in.viewZ)) {
        if (camera.occlusionMode == 1u) {
            discard;
        }
        color.a *= OCCLUSION_DIM;
    }

    return color;
}
