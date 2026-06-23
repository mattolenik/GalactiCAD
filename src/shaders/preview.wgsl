//:) include "hg_sdf.wgsl"

struct RayMarchParams {
    maxSteps: i32,
    maxBeamSteps: i32,
    hitRefineSteps: i32,
    _pad0: i32,
    maxDist: f32,
    rayOriginDepth: f32,
    _pad1: f32,
    _pad2: f32,
}

@group(0) @binding(25) var<uniform> rayMarchParams: RayMarchParams;

struct Camera {
    transform: mat4x4f,
    position: vec3f,
    res: vec2f,
    zoom: f32,
    // Pre-transformed light directions (camera-space → scene-space, computed on CPU)
    lightDir1: vec3f,  // Key light
    lightDir2: vec3f,  // Fill light
    lightDir3: vec3f,  // Rim light
    // Center of the visible (non-editor) area in UV space (0-1).
    // When the editor overlays part of the canvas, the scene is centered here.
    viewCenter: vec2f,
    _padView: vec2f,
    lightDir4: vec3f,  // Back / bounce fill
    _padLight4: f32,
    // x=ambient, y=diffuseWrap, z=keyWeight, w=fillWeight
    previewShade0: vec4f,
    // x=rimWeight, y=backWeight, z=specIntensity, w=specShininess
    previewShade1: vec4f,
    // x=fresnelPower, y=fresnelIntensity, z=preview normal RGB mode (0/1), w=unused
    previewShade2: vec4f,
    // x=aoStrength, y=aoRadius, z=aoSteps (rounded 1–8), w=aoBias
    previewShade3: vec4f,
    // Pre-computed Blinn-Phong half-vector for the key light:
    // `normalize(lightDir1 + viewDir)`. Both inputs are uniform per frame
    // (lightDir1 is camera-space pre-baked; viewDir is the camera +Z column
    // in scene space), so computing this on the CPU once per frame replaces
    // a per-pixel vec3 add + normalize in `specularAndFresnelRim`. Re-uses
    // the 16 bytes the now-DOM pivot cursor previously occupied.
    keyHalfDir: vec3f,
    _padKeyHalf: f32,
};

@group(0) @binding(1) var<uniform> camera: Camera;

// Click detection state
struct ClickState {
    clickPos: vec2f,      // UV coordinates of click (0-1 range)
    enabled: u32,         // Whether click detection is enabled
    hoverEnabled: u32,    // Whether hover edge detection is enabled
    hoverPos: vec2f,      // UV coordinates of hover (0-1 range)
}

@group(0) @binding(2) var<uniform> clickState: ClickState;
@group(0) @binding(3) var<storage, read_write> clickedObjectId: atomic<u32>;

// Selected objects: boolean array indexed by object ID (0 = not selected, 1 = selected)
@group(0) @binding(4) var<storage, read> selectedObjectIds: array<u32, 1024>;

// Color palette: 32 pastel colors for shape coloring
@group(0) @binding(5) var<uniform> colorPalette: array<vec3f, 32>;

// View settings
const SELECTION_MODE_OBJECT: u32 = 0u;
const SELECTION_MODE_SEAM: u32 = 1u;
const SELECTION_MODE_EDGE: u32 = 2u;
const SELECTION_MODE_FACE: u32 = 3u;
const SELECTION_MODE_AUTO: u32 = 4u;
// "View Isolated" no longer rides this uniform: isolation recompiles the preview
// SDF from the isolated subtree(s) as root (SceneInfo.isolationRoot +
// RenderWorkerCore.recompileIsolation), so the live shader carries no isolate
// scaffolding at all.
struct ViewSettings {
    xrayMode: u32,       // 0 = normal, 1 = xray/translucent
    debugHeatmap: u32,   // 0 = normal shading, 1 = render per-pixel sceneSDF_fast call count as a turbo-like color ramp
    beamEnabled: u32,    // 0 = disabled (start from t=0), 1 = use beam pre-pass t_start
    selectionMode: u32,  // 0=object, 1=seam, 2=edge, 3=face, 4=auto
    ghostEnabled: u32,   // 0 = off, 1 = show subtracted cutters as a translucent red ghost overlay
    flatShading: u32,    // 0 = smooth (Phong) extrude side normals (default), 1 = flat per-edge facets
    debugTessEdges: u32, // 1 = draw markers at path2d tessellation vertices on extrude sides (debug)
}
@group(0) @binding(6) var<uniform> viewSettings: ViewSettings;

// Beam optimization: low-res texture with per-tile starting-t from beam pre-pass
const BEAM_TILE_SIZE: i32 = 8;
@group(0) @binding(7) var tStartTex: texture_2d<f32>;
// Beam compute writes tile t_start here (same GPUTexture as tStartTex, storage view in bind group).
@group(0) @binding(8) var tStartOut: texture_storage_2d<r32float, write>;

// Polygon vertex buffer: shared storage for all Polygon2D vertex data.
// Each Polygon2D reads its vertices from a contiguous slice starting at its compile-time BASE offset.
@group(0) @binding(9) var<storage, read> polygonVertices: array<vec2f>;

// Hit position of the clicked pixel — written alongside clickedObjectId for face picking.
@group(0) @binding(10) var<storage, read_write> clickedHitPos: array<f32, 4>;
@group(0) @binding(17) var<storage, read_write> clickedNormal: array<f32, 4>;

// Face selection: tells the Extrude shader which face to highlight with FACE_HIGHLIGHT_ID.
// mode: 0=slide, 1=extrude, 2=top cap, 3=bottom cap, 4=box, 5=cylinder, 6=cone
struct FaceSelection {
    nodeId: u32,         // Extrude/primitive node ID (0 = disabled)
    faceIndex: u32,      // edge index or primitive face index
    mode: u32,           // 0 = slide, 1 = extrude, 2 = top cap, 3 = bottom cap, 4 = box, 5 = cylinder, 6 = cone
    extrudeOffset: f32,  // world-space offset (extrude mode only)
    pushPullActive: u32, // 1 = push/pull active (dither); 0 = normal selection (no dither)
    segStart: u32,       // mode-0 side highlight: wall-surface segment edge range
    segEnd: u32,         //   [segStart, segEnd); wraps when segEnd <= segStart
}
@group(0) @binding(11) var<uniform> faceSelection: FaceSelection;

// Preview-only typed uniform banks (≤64 KiB each). TS codegen indexes `vec4` banks with fixed swizzles (no unpack helpers).
@group(0) @binding(19) var<uniform> previewParamsF32: array<vec4f, 4096>;
@group(0) @binding(20) var<uniform> previewParamsVec2: array<vec4f, 4096>;
@group(0) @binding(21) var<uniform> previewParamsVec3: array<vec4f, 4096>;
@group(0) @binding(23) var<uniform> previewParamsMat3: array<mat3x3f, 1024>;
// Live cap push/pull (h, posYDelta): vec4-packed like `previewParamsF32` (uniform — storage buffer budget is capped at 10 in the fragment stage).
@group(0) @binding(24) var<uniform> previewCapParamDrag: array<vec4f, 4096>;
// BVH union guards read AABB center/half from `previewParamsVec3` (packed on CPU with other preview vec3 data).

// Edge selection: hit at click/hover pixel
const EDGE_KIND_NONE: u32 = 0u;
const EDGE_KIND_PRIMITIVE: u32 = 1u;
const EDGE_KIND_SEAM: u32 = 2u;
const EDGE_KIND_SEAM_SEGMENT: u32 = 3u;

struct EdgeHit {
    kind: u32,
    primaryId: u32,
    secondaryId: u32,
    featureA: u32,        // box edge 0-11, or 0 for seam
    opType: u32,          // 1=union, 2=intersection, 3=difference
    objectId: u32,
    seedPoint: vec4f,     // xyz = world hit pos, w = unused  (offset 32)
    seedTangent: vec3f,   // for seam segments: tangent at seed              (offset 48)
    seedNormal: vec3f,    // for seam segments: arc plane normal (from curvature), camera-independent (offset 64)
}
// Four slots: [0]=front, [1]=back (xray), [2]=front seam segment, [3]=back seam segment
@group(0) @binding(13) var<storage, read_write> edgeHits: array<EdgeHit, 4>;

struct SelectedEdge {
    kind: u32,
    primaryId: u32,
    secondaryId: u32,
    featureA: u32,
    opType: u32,
    lineWidthPx: f32,
    epsilon: f32,
    seedPoint: vec3f,   // for seam segments: world pos of click            (offset 32)
    seedTangent: vec3f, // for seam segments: tangent at click               (offset 48)
    seedNormal: vec3f,  // for seam segments: arc plane normal (camera-independent) (offset 64)
}
struct SelectedEdgesBuffer {
    count: u32,
    pad: u32,
    pad2: u32,
    pad3: u32,
    edges: array<SelectedEdge, 16>,
}
@group(0) @binding(14) var<storage, read> selectedEdges: SelectedEdgesBuffer;

@group(0) @binding(15) var<storage, read_write> hoverEdgeHits: array<EdgeHit, 4>;
@group(0) @binding(16) var<storage, read> hoveredEdge: SelectedEdgesBuffer;

struct SelectionStyles {
    faceDarken: f32,
    _pad1: f32, _pad2: f32, _pad3: f32,
    faceTint: vec3f,
    _pad4: f32,
    edgeColor: vec3f,
    _pad5: f32,
    edgeSelectedStrength: f32,
    edgeHoverStrength: f32,
    faceDotSpacing: f32,
    faceDotRadius: f32,
    faceDotDarken: f32,
    resolutionScale: f32,  // 1.0 = full res, 0.5 = halfres; dot pattern uses full-canvas pixels
}
@group(0) @binding(18) var<uniform> selectionStyles: SelectionStyles;

// ── Deferred selection shading G-buffer ───────────────────────────────────
// One entry per pixel (linear index = py*width + px at scene resolution).
// Written by `geometryMain` (the expensive SDF march + AO + lighting), read by
// `shadeMain` (the cheap selection-dependent tail). GPU-internal: never mapped
// or read by the CPU, so the byte layout lives only here. `_pad*` round the
// struct to a 16-byte multiple. Used only when RenderWorkerCore #deferredShading
// is on; otherwise unbound and unallocated.
struct GBufferPixel {
    shadedColor: vec3f,   // pre-selection lit colour (shadeHitBase output)
    t: f32,               // hit ray param; <= 0 => miss
    n: vec3f,             // surface normal (drives primitiveFaceIndexFromNormal)
    blend: f32,           // smooth-blend weight
    seamTangent: vec3f,   // seam tangent — magnitude matters for edge distance
    seamGap: f32,
    id: u32,
    id2: u32,
    seamA: u32,
    seamB: u32,
    seamOp: u32,
    steps: u32,           // cumulative sceneSDF_fast calls (debug heatmap)
    lit: f32,             // BaseShade.lit — surface diffuse*AO for the lit crosshatch
    _pad1: u32,
}
@group(0) @binding(26) var<storage, read_write> gbuffer: array<GBufferPixel>;

// Linear G-buffer index from the fragment's framebuffer position (px+0.5, py+0.5).
fn gbufferIndex(pos: vec4f) -> u32 {
    return u32(pos.y) * u32(camera.res.x) + u32(pos.x);
}

const FACE_HIGHLIGHT_ID: u32 = 1023u;       // Side/edge face highlight (unchanged)
const FACE_HIGHLIGHT_TOP: u32 = 1023u;     // Top cap when selected
const FACE_HIGHLIGHT_BOTTOM: u32 = 1022u;  // Bottom cap when selected (distinct from top)

// Fragment output: color and object ID for MRT outline detection
// FragmentOutput dropped — the previous `@location(1) objectId: vec4<u32>`
// existed to feed the old outline post-process pass, which is gone. Click
// picking uses the `clickedObjectId` atomic written from inside the shader,
// not a read-back ID texture. Scene fragments now return a single vec4
// color and write directly into the canvas swapchain.

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
}

// Oriented rectangle SDF in 2D (used by extrude mode for the bump rectangle).
fn rectSDF2D(p: vec2f, center: vec2f, tangent: vec2f, normal: vec2f, halfW: f32, halfH: f32) -> f32 {
    let rel = p - center;
    let localX = dot(rel, tangent);
    let localY = dot(rel, normal);
    let dd = vec2f(abs(localX) - halfW, abs(localY) - halfH);
    return length(max(dd, vec2f(0.0))) + min(max(dd.x, dd.y), 0.0);
}

// Edge helpers: box parameter lookup (injected from scene)
fn getBoxParamsForId(id: u32, posOut: ptr<function, vec3f>, halfOut: ptr<function, vec3f>) -> bool {
    switch id {
        //:) insert sceneEdgeHelpers
        default: { return false; }
    }
}

// Box edge encoding: 0-3 = Z-parallel, 4-7 = Y-parallel, 8-11 = X-parallel.
// Returns 0xFFFFFFFF if not near any edge.
fn classifyBoxEdgeFeature(localP: vec3f, half: vec3f, eps: f32) -> u32 {
    let d = abs(localP) - half;
    let ex = abs(d.x) < eps;
    let ey = abs(d.y) < eps;
    let ez = abs(d.z) < eps;
    if (ex && ey) {
        let sx = select(0u, 1u, localP.x > 0.0);
        let sy = select(0u, 1u, localP.y > 0.0);
        return sx * 2u + sy;
    }
    if (ex && ez) {
        let sx = select(0u, 1u, localP.x > 0.0);
        let sz = select(0u, 1u, localP.z > 0.0);
        return 4u + sx * 2u + sz;
    }
    if (ey && ez) {
        let sy = select(0u, 1u, localP.y > 0.0);
        let sz = select(0u, 1u, localP.z > 0.0);
        return 8u + sy * 2u + sz;
    }
    return 0xFFFFFFFFu;
}

// Distance from p to a specific box edge. Each edge is a line segment; we need the perpendicular distance.
// Features 0-3: Z-parallel at (sx*half.x, sy*half.y, z). Features 4-7: Y-parallel. Features 8-11: X-parallel.
fn boxEdgeDistance(localP: vec3f, half: vec3f, feature: u32) -> f32 {
    if (feature < 4u) {
        let sx = select(-1.0, 1.0, (feature & 2u) != 0u);
        let sy = select(-1.0, 1.0, (feature & 1u) != 0u);
        let cx = sx * half.x;
        let cy = sy * half.y;
        let dx = localP.x - cx;
        let dy = localP.y - cy;
        let zClamp = clamp(localP.z, -half.z, half.z);
        return length(vec3f(dx, dy, localP.z - zClamp));
    }
    if (feature < 8u) {
        let sx = select(-1.0, 1.0, ((feature - 4u) & 2u) != 0u);
        let sz = select(-1.0, 1.0, ((feature - 4u) & 1u) != 0u);
        let cx = sx * half.x;
        let cz = sz * half.z;
        let dx = localP.x - cx;
        let dz = localP.z - cz;
        let yClamp = clamp(localP.y, -half.y, half.y);
        return length(vec3f(dx, localP.y - yClamp, dz));
    }
    let sy = select(-1.0, 1.0, ((feature - 8u) & 2u) != 0u);
    let sz = select(-1.0, 1.0, ((feature - 8u) & 1u) != 0u);
    let cy = sy * half.y;
    let cz = sz * half.z;
    let dy = localP.y - cy;
    let dz = localP.z - cz;
    let xClamp = clamp(localP.x, -half.x, half.x);
    return length(vec3f(localP.x - xClamp, dy, dz));
}

fn nearestBoxEdgeFeature(localP: vec3f, half: vec3f) -> u32 {
    var bestFeature = 0xFFFFFFFFu;
    var bestDist = 1e9;
    for (var i: u32 = 0u; i < 12u; i = i + 1u) {
        let dist = boxEdgeDistance(localP, half, i);
        if (dist < bestDist) {
            bestDist = dist;
            bestFeature = i;
        }
    }
    return bestFeature;
}

// Lathe primitive edges: ring at profile vertex (featureA = vertex index) or pole when radius ~ 0.
fn tryLathePrimitiveEdgeHit(hitId: u32, hitWorld: vec3f, out: ptr<function, EdgeHit>) -> bool {
    switch hitId {
        //:) insert sceneLatheEdgeHitCases
        default: { return false; }
    }
}

fn lathePrimitiveRingDistance(latheId: u32, profileVtx: u32, hitWorld: vec3f) -> f32 {
    switch latheId {
        //:) insert sceneLatheRingDistanceCases
        default: { return 1e30; }
    }
}

// Closest point on a box edge segment. Projects hit onto the edge geometry for camera-invariant selection.
fn closestPointOnBoxEdge(localP: vec3f, half: vec3f, feature: u32) -> vec3f {
    if (feature < 4u) {
        let sx = select(-1.0, 1.0, (feature & 2u) != 0u);
        let sy = select(-1.0, 1.0, (feature & 1u) != 0u);
        let cx = sx * half.x;
        let cy = sy * half.y;
        let zClamp = clamp(localP.z, -half.z, half.z);
        return vec3f(cx, cy, zClamp);
    }
    if (feature < 8u) {
        let sx = select(-1.0, 1.0, ((feature - 4u) & 2u) != 0u);
        let sz = select(-1.0, 1.0, ((feature - 4u) & 1u) != 0u);
        let cx = sx * half.x;
        let cz = sz * half.z;
        let yClamp = clamp(localP.y, -half.y, half.y);
        return vec3f(cx, yClamp, cz);
    }
    let sy = select(-1.0, 1.0, ((feature - 8u) & 2u) != 0u);
    let sz = select(-1.0, 1.0, ((feature - 8u) & 1u) != 0u);
    let cy = sy * half.y;
    let cz = sz * half.z;
    let xClamp = clamp(localP.x, -half.x, half.x);
    return vec3f(xClamp, cy, cz);
}

// Project hit point onto the seam line. Returns hitWorld if projection is degenerate.
fn projectHitOntoSeam(hitWorld: vec3f, hit: HitData) -> vec3f {
    let t = hit.seamTangent;
    let tLen = max(length(t), 1e-6);
    let perp = hit.n - dot(hit.n, t) / (tLen * tLen) * t;
    let perpDot = dot(perp, perp);
    if (perpDot <= 1e-12) { return hitWorld; }
    let perpNorm = perp * inverseSqrt(perpDot);
    let d = hit.seamGap / tLen;
    return hitWorld - perpNorm * d;
}

// Return dominant axis index 1-6 for +X,-X,+Y,-Y,+Z,-Z. 0 if vector is degenerate.
fn dominantAxisIndex(v: vec3f) -> u32 {
    let ax = abs(v.x);
    let ay = abs(v.y);
    let az = abs(v.z);
    if (ax >= ay && ax >= az && ax > 1e-6) { return select(1u, 2u, v.x > 0.0); }
    if (ay >= ax && ay >= az && ay > 1e-6) { return select(3u, 4u, v.y > 0.0); }
    if (az >= ax && az >= ay && az > 1e-6) { return select(5u, 6u, v.z > 0.0); }
    return 0u;
}

fn classifyEdgeAtHit(hitWorld: vec3f, hit: HitData, wppu: f32) -> EdgeHit {
    var out: EdgeHit;
    out.kind = EDGE_KIND_NONE;
    out.primaryId = 0u;
    out.secondaryId = 0u;
    out.featureA = 0u;
    out.opType = 0u;
    out.objectId = hit.id;
    out.seedPoint = vec4f(hitWorld, 0.0);
    out.seedTangent = vec3f(0.0, 0.0, 0.0);
    out.seedNormal = vec3f(0.0, 0.0, 0.0);

    var pos = vec3f(0.0);
    var half = vec3f(0.0);
    if (getBoxParamsForId(hit.id, &pos, &half)) {
        let localP = hitWorld - pos;
        let feat = nearestBoxEdgeFeature(localP, half);
        let nearestDist = boxEdgeDistance(localP, half, feat);
        let minHalf = min(min(half.x, half.y), half.z);
        let edgeThreshold = max(minHalf * 0.12, 0.012);
        if (nearestDist < edgeThreshold) {
            out.kind = EDGE_KIND_PRIMITIVE;
            out.primaryId = hit.id;
            out.featureA = feat;
            let onEdge = pos + closestPointOnBoxEdge(localP, half, feat);
            out.seedPoint = vec4f(onEdge, 0.0);
            return out;
        }
    }

    if (tryLathePrimitiveEdgeHit(hit.id, hitWorld, &out)) {
        return out;
    }

    if (hit.seamOp != 0u && hit.seamGap < 0.10) {
        out.kind = EDGE_KIND_SEAM;
        out.primaryId = hit.seamA;
        out.secondaryId = hit.seamB;
        out.opType = hit.seamOp;
        let t = hit.seamTangent;
        let tLen = max(length(t), 1e-6);
        out.seedTangent = t / tLen;
        out.seedPoint = vec4f(projectHitOntoSeam(hitWorld, hit), 0.0);
        return out;
    }
    return out;
}

// Classify seam segment for edge mode: detect corners (tangent changes > 15°) and identify segment by dominant axis.
fn classifySeamSegment(hitWorld: vec3f, hit: HitData) -> EdgeHit {
    var out: EdgeHit;
    out.kind = EDGE_KIND_NONE;
    out.primaryId = hit.seamA;
    out.secondaryId = hit.seamB;
    out.featureA = 0u;
    out.opType = hit.seamOp;
    out.objectId = hit.id;
    out.seedTangent = vec3f(0.0, 0.0, 0.0);
    out.seedNormal = vec3f(0.0, 0.0, 0.0);
    let t = hit.seamTangent;
    let tLen = length(t);
    if (tLen > 1e-6 && hit.seamOp != 0u && hit.seamGap < 0.10) {
        out.seedPoint = vec4f(projectHitOntoSeam(hitWorld, hit), 0.0);
    } else {
        out.seedPoint = vec4f(hitWorld, 0.0);
    }
    if (hit.seamOp == 0u || hit.seamGap >= 0.10) { return out; }
    if (tLen < 1e-6) { return out; }
    let tNorm = t / tLen;
    let epsilon: f32 = 0.02;
    // sceneSDF is called here for the look-ahead point; its full SDFResult is
    // only alive for this brief local scope, not held in fragmentMain.
    let sdfAhead = sceneSDF(hitWorld + epsilon * tNorm);
    if (sdfAhead.seamOp == 0u) { return out; }
    let tAhead = sdfAhead.seamTangent;
    let tAheadLen = length(tAhead);
    let cos15: f32 = 0.9659258;
    let atCorner = tAheadLen > 1e-6 && dot(tNorm, tAhead / tAheadLen) < cos15;
    let segTangent = select(t, tAhead, atCorner);
    let tangentAxis = dominantAxisIndex(segTangent);
    let normalAxis = dominantAxisIndex(hit.n);
    if (tangentAxis == 0u) { return out; }
    out.kind = EDGE_KIND_SEAM_SEGMENT;
    out.featureA = tangentAxis * 8u + normalAxis;
    out.seedTangent = tNorm;
    // Arc plane normal: cross(tangent, curvature direction). Derived purely from how the
    // seam tangent changes — camera-independent. Used to reject parallel arcs on other faces.
    if (tAheadLen > 1e-6) {
        let tAheadNorm = tAhead / tAheadLen;
        let curvPerp = tAheadNorm - dot(tAheadNorm, tNorm) * tNorm;
        let curvPerpLen = length(curvPerp);
        if (curvPerpLen > 1e-4) {
            out.seedNormal = normalize(cross(tNorm, curvPerp / curvPerpLen));
        }
    }
    return out;
}

fn applyEdgeHighlight(result: ptr<function, vec3f>, e: SelectedEdge, hitWorld: vec3f, hit: HitData, wppu: f32, strength: f32) {
    let highlight = selectionStyles.edgeColor;
    let lineWidth = e.lineWidthPx;
    let epsilon = e.epsilon;

    if (e.kind == EDGE_KIND_PRIMITIVE) {
        var pos = vec3f(0.0);
        var half = vec3f(0.0);
        if (getBoxParamsForId(e.primaryId, &pos, &half) && e.primaryId == hit.id) {
            let localP = hitWorld - pos;
            let feat = nearestBoxEdgeFeature(localP, half);
            if (feat == e.featureA) {
                let dist = boxEdgeDistance(localP, half, feat);
                let edgeDistPx = dist / wppu;
                let t = 1.0 - smoothstep(lineWidth - epsilon, lineWidth + epsilon, edgeDistPx);
                *result = *result * (1.0 - t * strength) + highlight * (t * strength);
            }
        } else if (e.primaryId == hit.id) {
            let latheD = lathePrimitiveRingDistance(e.primaryId, e.featureA, hitWorld);
            let edgeDistPx = latheD / wppu;
            let t = 1.0 - smoothstep(lineWidth - epsilon, lineWidth + epsilon, edgeDistPx);
            *result = *result * (1.0 - t * strength) + highlight * (t * strength);
        }
    } else if (e.kind == EDGE_KIND_SEAM && hit.seamOp != 0u && hit.blend < 0.01) {
        let objOnSeam = hit.id == e.primaryId || hit.id == e.secondaryId;
        if (objOnSeam && hit.seamA == e.primaryId && hit.seamB == e.secondaryId && hit.seamOp == e.opType) {
            let tLen = max(length(hit.seamTangent), 1e-6);
            let seamDist = hit.seamGap / tLen;
            let edgeDistPx = seamDist / wppu;
            let t = 1.0 - smoothstep(lineWidth - epsilon, lineWidth + epsilon, edgeDistPx);
            *result = *result * (1.0 - t * strength) + highlight * (t * strength);
        }
    } else if (e.kind == EDGE_KIND_SEAM_SEGMENT && hit.seamOp != 0u && hit.blend < 0.01) {
        let objOnSeam = hit.id == e.primaryId || hit.id == e.secondaryId;
        let idsMatch = objOnSeam && hit.seamA == e.primaryId && hit.seamB == e.secondaryId && hit.seamOp == e.opType;
        let toSeed = hitWorld - e.seedPoint;
        let distToSeed = length(toSeed);
        let tLen = max(length(hit.seamTangent), 1e-6);
        let tNorm = hit.seamTangent / tLen;
        let seedTanLen = length(e.seedTangent);
        let tangentContinuous = seedTanLen > 1e-6 && dot(tNorm, e.seedTangent / seedTanLen) > 0.342;
        let seedNormLen = length(e.seedNormal);
        let onSamePlane = seedNormLen < 1e-4 || abs(dot(toSeed, e.seedNormal)) < 0.5;
        let onSameSegment = idsMatch && tangentContinuous && onSamePlane && distToSeed < 15.0;
        if (onSameSegment) {
            let seamDist = hit.seamGap / tLen;
            let edgeDistPx = seamDist / wppu;
            let t = 1.0 - smoothstep(lineWidth - epsilon, lineWidth + epsilon, edgeDistPx);
            *result = *result * (1.0 - t * strength) + highlight * (t * strength);
        }
    }
}

fn applySelectedEdgeHighlight(color: vec3f, hitWorld: vec3f, hit: HitData, wppu: f32) -> vec3f {
    var result = color;
    for (var i: u32 = 0u; i < selectedEdges.count; i = i + 1u) {
        applyEdgeHighlight(&result, selectedEdges.edges[i], hitWorld, hit, wppu, selectionStyles.edgeSelectedStrength);
    }
    for (var j: u32 = 0u; j < hoveredEdge.count; j = j + 1u) {
        applyEdgeHighlight(&result, hoveredEdge.edges[j], hitWorld, hit, wppu, selectionStyles.edgeHoverStrength);
    }
    return result;
}

// Auxiliary SDF functions (e.g., per-polygon evaluators) are injected here at runtime.
//:) insert sceneAuxFast
// Extrude smooth-shading toggle source. Preview reads the live flag; the
// mesh/FG/bounds shaders define their own (always-flat) sdfFlatShadingFlag,
// because the shared extrude Ex function calls it.
fn sdfFlatShadingFlag() -> u32 { return viewSettings.flatShading; }
fn sdfDebugTessEdgesFlag() -> u32 { return viewSettings.debugTessEdges; }
//:) insert sceneAux

// The contents of sceneSDF are replaced at runtime, do not modify this function.
fn sceneSDF(p: vec3f) -> SDFResult {
    return sdfTrue(0.0, 0u, vec3f(0.0)); //:) insert sceneSDF
}

// Fast version for ray marching.
// Returns field value, gradient-magnitude estimate, and a separate conservative
// march-step multiplier.
fn sceneSDF_fast(p: vec3f) -> FastSDFResult {
    return sdfFast(0.0, 1.0, 1.0); //:) insert sceneSDF_fast
}

// ── Subtracted-cutter "ghost" overlay ──────────────────────────────────────
// Subtracted cutters are normally invisible once a `subtract` carves them away.
// When the toolbar ghost toggle is on (`viewSettings.ghostEnabled`), the ghost
// pass re-evaluates ALL cutters as full solids in a second SDF and composites
// them as a translucent red overlay wherever they sit in front of the opaque
// surface. The toggle is a runtime uniform, so the body below is always emitted;
// when the scene has no subtracts it is the inert (far-away) default.
const GHOST_COLOR: vec3f = vec3f(0.85, 0.12, 0.12);
const GHOST_ALPHA: f32 = 0.45;

// Union of all subtracted cutters as full solids. Replaced at runtime.
fn ghostSDF_fast(p: vec3f) -> FastSDFResult {
    return sdfFast(1e9, 1.0, 1.0); //:) insert ghostSDF_fast
}

// Narrow the ray parameter so the full sceneSDF sample is not stuck at the first
// in-band fast sample (important when t_start is shared per 8x8 beam tile).
// `stepCount` accumulates `sceneSDF_fast` invocations for the debug heatmap;
// the cost (one ALU op per loop iter) is negligible vs. an SDF eval, so it
// runs unconditionally rather than behind a uniform branch.
fn refineRayHit(origin: vec3f, dir: vec3f, tLo: f32, tHi: f32, stepCount: ptr<function, u32>) -> f32 {
    var lo = tLo;
    var hi = tHi;
    for (var r: i32 = 0; r < rayMarchParams.hitRefineSteps; r = r + 1) {
        // Adaptive early-terminate: once the bracket is tighter than the surface
        // tolerance the hit is localized to within SURF_DIST, so the remaining
        // fixed iterations only halve nothing useful. Head-on rays (the majority)
        // start with a tiny last-step bracket and exit in a few iters; grazing
        // rays still run up to `hitRefineSteps`. Same precision, fewer SDF taps.
        if (hi - lo < SURF_DIST) {
            break;
        }
        let mid = 0.5 * (lo + hi);
        let dm = sceneSDF_fast(origin + mid * dir).d;
        *stepCount = *stepCount + 1u;
        if (dm < SURF_DIST) {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    return hi;
}

// Raymarch: returns HitData (slim post-hit struct) rather than the full SDFResult.
// The full SDFResult is only alive transiently inside this function while
// projecting to HitData; it does not persist into fragmentMain's register file.
fn raymarch(origin: vec3f, dir: vec3f, t_start: f32, stepCount: ptr<function, u32>) -> HitData {
    var t: f32 = t_start;
    var tLastOutside: f32 = -1.0;
    for (var i: i32 = 0; i < rayMarchParams.maxSteps; i = i + 1) {
        let p = origin + t * dir;
        let sr = sceneSDF_fast(p);  // Fast: distance + gradMag + safeStepMul
        *stepCount = *stepCount + 1u;
        let step = sr.d * sr.safeStepMul;
        if (sr.d < SURF_DIST) {
            let tLo = select(0.0, tLastOutside, tLastOutside >= 0.0);
            let tHit = refineRayHit(origin, dir, tLo, t, stepCount);
            return toHitData(tHit, sceneSDF(origin + tHit * dir));
        }
        tLastOutside = t;
        t = t + step;
        if (t >= rayMarchParams.maxDist) {
            break;
        }
    }
    return hitDataMiss();
}

// Refine a sign change bracket along the ray. lo must be inside (d < 0),
// hi must be outside (d >= 0).
fn bisectSurfaceCrossing(origin: vec3f, dir: vec3f, tInside: f32, tOutside: f32, stepCount: ptr<function, u32>) -> f32 {
    var lo = tInside;
    var hi = tOutside;
    for (var k: i32 = 0; k < 6; k = k + 1) {
        let mid = 0.5 * (lo + hi);
        let d = sceneSDF_fast(origin + mid * dir).d;
        *stepCount = *stepCount + 1u;
        if (d < 0.0) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    return hi;
}

// Finite-difference normal of the ghost field — it has no analytic normal like
// sceneSDF. Tetrahedron sampling; `eps` scales with the on-screen pixel size so
// it adapts to zoom and scene scale.
fn ghostNormal(p: vec3f, eps: f32) -> vec3f {
    let k = vec2f(1.0, -1.0);
    let n = k.xyy * ghostSDF_fast(p + k.xyy * eps).d
          + k.yyx * ghostSDF_fast(p + k.yyx * eps).d
          + k.yxy * ghostSDF_fast(p + k.yxy * eps).d
          + k.xxx * ghostSDF_fast(p + k.xxx * eps).d;
    return normalize(n);
}

// March the ghost field for the nearest front surface, stopping at `maxT` (the
// opaque hit, so a ghost behind solid material stays hidden). Returns t<=0 miss.
fn raymarchGhost(origin: vec3f, dir: vec3f, maxT: f32, stepCount: ptr<function, u32>) -> f32 {
    var t: f32 = 0.0;
    for (var i: i32 = 0; i < rayMarchParams.maxSteps; i = i + 1) {
        let d = ghostSDF_fast(origin + t * dir).d;
        *stepCount = *stepCount + 1u;
        if (d < SURF_DIST) {
            return t;
        }
        t = t + max(d, SURF_DIST);
        if (t >= maxT) {
            return -1.0;
        }
    }
    return -1.0;
}

// Composite the translucent-red ghost over a PREMULTIPLIED base color (`base.rgb`
// already scaled by `base.a`, matching every fragmentMain/shadeMain return). Uses
// the standard premultiplied src-over operator, so it works on miss pixels
// (base.a == 0) too. `opaqueT` is the opaque hit distance — <=0 for a miss, where
// the ghost shows against the background. A no-op when the toggle is off.
fn compositeGhost(base: vec4f, origin: vec3f, dir: vec3f, viewDir: vec3f, opaqueT: f32, wppu: f32, stepCount: ptr<function, u32>) -> vec4f {
    if (viewSettings.ghostEnabled == 0u) { return base; }
    let maxT = select(rayMarchParams.maxDist, opaqueT, opaqueT > 0.0);
    if (maxT <= 0.0) { return base; }
    let t = raymarchGhost(origin, dir, maxT, stepCount);
    if (t <= 0.0) { return base; }
    let p = origin + t * dir;
    let n = ghostNormal(p, max(wppu, 1e-4));
    let diff = 0.35 + 0.65 * clamp(dot(n, viewDir), 0.0, 1.0);
    let a = GHOST_ALPHA;
    let srcPremult = GHOST_COLOR * diff * a;
    let outRgb = srcPremult + base.rgb * (1.0 - a);
    let outA = a + base.a * (1.0 - a);
    return vec4f(outRgb, outA);
}

fn diffuseWrap(n: vec3f, l: vec3f, wrap: f32) -> f32 {
    return clamp((dot(n, l) + wrap) / (1.0 + wrap), 0.0, 1.0);
}

// Vectorised 4-light wrap-diffuse: the per-light `diffuseWrap` divides by the
// same `(1 + wrap)` and clamps to the same range, so we compute the reciprocal
// once and fold the four dots + the four weights into a single `dot` against
// the per-light vec4 of weighted contributions. Saves three divides and three
// vec3 clamps versus the previous per-light call style.
fn lightingDiffuse(normalScene: vec3f) -> f32 {
    let s0 = camera.previewShade0;
    let s1 = camera.previewShade1;
    let wrap = s0.y;
    let amb = s0.x;
    let invDiv = 1.0 / (1.0 + wrap);
    let dots = vec4f(
        dot(normalScene, camera.lightDir1),
        dot(normalScene, camera.lightDir2),
        dot(normalScene, camera.lightDir3),
        dot(normalScene, camera.lightDir4),
    );
    let wrapped = clamp((dots + vec4f(wrap)) * invDiv, vec4f(0.0), vec4f(1.0));
    let weights = vec4f(s0.z, s0.w, s1.x, s1.y); // key, fill, rim, back
    return clamp(amb + dot(wrapped, weights), 0.0, 1.35);
}

// View-dependent specular (Blinn–Phong, key light) + fresnel rim; linear RGB add.
//
// Specular exponent is locked at 32 (canonical Blinn–Phong "medium plastic"
// shininess) and Fresnel exponent at 5 (Schlick's analytic approximation to
// the dielectric Fresnel equation, accurate within ~1%). Both were
// previously user-tunable via `camera.previewShade1.w` (specPow) and
// `camera.previewShade2.x` (frPow); those slots are now dead, the sliders
// in the dev-tools "Lighting" panel are no-ops, and the per-pixel cost
// drops from two `pow` calls (~40 cycles) to ~10 multiplies (~10 cycles).
fn specularAndFresnelRim(n: vec3f, viewDir: vec3f) -> vec3f {
    let specInt = camera.previewShade1.z;
    let frInt = camera.previewShade2.y;

    // Blinn–Phong specular = (n·H)^32 via repeated squaring. `keyHalfDir`
    // is the CPU-baked `normalize(lightDir1 + viewDir)`.
    let h = max(dot(n, camera.keyHalfDir), 0.0);
    let h2 = h * h;
    let h4 = h2 * h2;
    let h8 = h4 * h4;
    let h16 = h8 * h8;
    let h32 = h16 * h16;
    let spec = h32 * specInt;

    // Schlick fresnel = (1 - n·viewDir)^5 — five multiplies via x⁴·x.
    let ndv = clamp(dot(n, viewDir), 0.0, 1.0);
    let x = 1.0 - ndv;
    let x2 = x * x;
    let x4 = x2 * x2;
    let fresnel = x4 * x * frInt;

    let specColor = vec3f(0.96, 0.98, 1.0);
    return specColor * spec + vec3f(fresnel);
}

// Contact AO along analytical normal; sceneSDF_fast only. Returns multiplier in [0,1] for diffuse (1 = no darkening).
fn sdfAmbientOcclusion(worldPos: vec3f, n: vec3f, stepCount: ptr<function, u32>) -> f32 {
    let cfg = camera.previewShade3;
    let strength = cfg.x;
    if (strength <= 0.0) {
        return 1.0;
    }
    let radius = max(cfg.y, 1e-6);
    let nSteps = i32(clamp(round(cfg.z), 1.0, 8.0));
    let bias = max(cfg.w, 0.0);
    let p0 = worldPos + n * bias;
    var sum = 0.0;
    for (var i: i32 = 1; i <= nSteps; i = i + 1) {
        let h = radius * f32(i) / f32(nSteps);
        let d = sceneSDF_fast(p0 + n * h).d;
        *stepCount = *stepCount + 1u;
        sum = sum + clamp((h - d) / h, 0.0, 1.0);
    }
    let occ = sum / f32(nSteps);
    return clamp(1.0 - strength * occ, 0.0, 1.0);
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
    return camPos + vec3f(offsetX, offsetY, rayMarchParams.rayOriginDepth);
}

// Pivot cursor (dashed red/white ring + crosshair) moved out of the
// fragment shader — it's now a DOM overlay rendered by `PreviewWindow`.
// Saved one screen-space SDF + dashed-ring evaluation per pixel per frame.

// Raymarch from inside the surface to find the exit point. Returns HitData; the
// full SDFResult is only transiently alive during the toHitData() projection.
fn raymarchFromInside(origin: vec3f, dir: vec3f, startT: f32, stepCount: ptr<function, u32>) -> HitData {
    let eps = max(SURF_DIST * 4.0, 1e-3);
    var t: f32 = startT + eps;  // Start just inside the entry surface
    var tInside = startT;

    for (var i: i32 = 0; i < rayMarchParams.maxSteps; i = i + 1) {
        let p = origin + t * dir;
        let sr = sceneSDF_fast(p);  // Fast: distance + gradMag + safeStepMul
        *stepCount = *stepCount + 1u;
        let step = max(abs(sr.d) * sr.safeStepMul, eps);

        // Found an exit surface (going from inside to outside)
        if (sr.d > SURF_DIST) {
            let tExit = bisectSurfaceCrossing(origin, dir, tInside, t, stepCount);
            return toHitData(tExit, sceneSDF(origin + tExit * dir));
        }
        if (sr.d >= 0.0) {
            return toHitData(t, sceneSDF(origin + t * dir));
        }

        tInside = t;
        t = t + step;
        if (t >= rayMarchParams.maxDist) {
            break;
        }
    }
    return hitDataMiss();
}

// Compute primitive face index from normal. mode 4=box, 5=cylinder, 6=cone.
fn primitiveFaceIndexFromNormal(n: vec3f, mode: u32) -> u32 {
    let ax = abs(n.x);
    let ay = abs(n.y);
    let az = abs(n.z);
    if (mode == 4u) {
        // Box: axis 0=x,1=y,2=z; sign 0=+, 1=-
        let axis = select(2u, select(1u, 0u, ax >= ay && ax >= az), ay >= ax && ay >= az);
        let comp = select(n.z, select(n.y, n.x, axis == 0u), axis == 1u);
        let sign = select(0u, 1u, comp < 0.0);
        return axis * 2u + sign;
    }
    if (mode == 5u) {
        // Cylinder: 0=bottom, 1=side, 2=top
        if (n.y > 0.9) { return 2u; }
        if (n.y < -0.9) { return 0u; }
        return 1u;
    }
    if (mode == 6u) {
        // Cone: 0=base, 1=side
        if (n.y < -0.9) { return 0u; }
        return 1u;
    }
    return 0xFFFFFFFFu;
}

struct ShadeResult {
    color: vec3f,
    faceSelected: f32,
    lit: f32,   // surface diffuse*AO term, so the selection crosshatch can be lit by the scene
}

// Match mesh-viewer opaque: RGB from scene-space shading normal (± for front/back).
fn hitNormalToRgb(nScene: vec3f) -> vec3f {
    let len2 = dot(nScene, nScene);
    let n = select(vec3f(0.0, 0.0, 1.0), nScene * inverseSqrt(len2), len2 > 1e-20);
    return n * 0.5 + 0.5;
}

// Shade a hit point and return the color.
// flipNormal: true if hitting surface from inside (back surface).
// viewDir: direction from hit toward camera (unit), for specular / fresnel.
// worldPos: hit position in scene space (for ambient occlusion samples).
// hitSel: pre-computed `f32(selectedObjectIds[hit.id] != 0u)`. The caller
//   already needs this value to compute the boundary outline in fragmentMain;
//   threading it in here saves a duplicate storage read per pixel. May still
//   be overridden by face-highlight matching below.
// stepCount: cumulative sceneSDF_fast counter; passed to AO so the heatmap
//   covers AO-dominated pixels (typical near contact zones / fillets).
// Face/object selection weight for a hit. Pure function of HitData + the
// selection uniforms (selectedObjectIds, faceSelection) — NO SDF. Shared by the
// inline shadeHit and the deferred shadeMain so both tint identically. The
// normal-RGB and lit branches of shadeHit used byte-identical copies of this
// logic; it is hoisted here once.
fn computeSelBlend(hit: HitData, hitSel: f32) -> f32 {
    var sel1 = hitSel;
    let bw = hit.blend;
    // Primitive face selection (mode 4=box, 5=cylinder, 6=cone)
    if (faceSelection.mode >= 4u && faceSelection.nodeId == hit.id && bw < 0.01) {
        let faceIdx = primitiveFaceIndexFromNormal(hit.n, faceSelection.mode);
        if (faceIdx == faceSelection.faceIndex) {
            sel1 = 1.0;
        }
    }
    var selBlend = sel1;
    if (bw > 0.0) {
        var sel2 = f32(selectedObjectIds[hit.id2] != 0u);
        if (faceSelection.mode >= 4u && faceSelection.nodeId == hit.id2 && bw > 0.99) {
            let faceIdx = primitiveFaceIndexFromNormal(hit.n, faceSelection.mode);
            if (faceIdx == faceSelection.faceIndex) {
                sel2 = 1.0;
            }
        }
        selBlend = mix(sel1, sel2, bw);
    }
    return selBlend;
}

// Pre-selection surface shading, deferred-friendly: the colour plus the `lit`
// term (surface diffuse*AO, or 1.0 in render-normals mode) that the crosshatch
// uses to light itself by the scene. The geometry pass bakes BOTH into the
// G-buffer so a selection-only repaint re-tints without re-marching.
struct BaseShade {
    color: vec3f,
    lit: f32,
}

// Pre-selection lit surface colour: everything shadeHit computes EXCEPT the
// selection tint. This is the only part that touches the SDF (via AO), so the
// deferred geometry pass runs it once and bakes the result into the G-buffer;
// a selection-only repaint then re-tints without re-marching.
fn shadeHitBase(hit: HitData, flipNormal: bool, viewDir: vec3f, worldPos: vec3f, stepCount: ptr<function, u32>) -> BaseShade {
    let normal = select(hit.n, -hit.n, flipNormal);
    if (camera.previewShade2.z > 0.5) {
        return BaseShade(hitNormalToRgb(normal), 1.0); // render-normals mode: full-bright hatch
    }
    // AO should sample away from the actual surface, not the x-ray lighting normal.
    // For back/exit surfaces, the flipped shading normal points into the solid and
    // creates contour-like bands inside the volume.
    let aoNormal = hit.n;

    let diffuse = lightingDiffuse(normal);
    let specRim = specularAndFresnelRim(normal, viewDir);
    let ao = sdfAmbientOcclusion(worldPos, aoNormal, stepCount);

    // Color and selection: only do second lookups when blending is active
    let color1 = colorPalette[hit.id & 31u];
    let bw = hit.blend;
    var baseColor = color1;
    if (bw > 0.0) {
        let color2 = colorPalette[hit.id2 & 31u];
        baseColor = color1 * (1.0 - bw) + color2 * bw;
    }
    return BaseShade(baseColor * diffuse * ao + specRim, diffuse * ao);
}

// Tint a pre-selection colour by the selection weight. Shared by shadeHit and
// shadeMain. With base.color = nrm this reproduces the normal-RGB branch too.
fn applyFaceSelectionTint(base: BaseShade, hit: HitData, hitSel: f32) -> ShadeResult {
    let selBlend = computeSelBlend(hit, hitSel);
    let selectedColor = base.color * selectionStyles.faceDarken + selectionStyles.faceTint;
    let color = base.color * (1.0 - selBlend) + selectedColor * selBlend;
    return ShadeResult(color, selBlend, base.lit);
}

fn shadeHit(hit: HitData, flipNormal: bool, viewDir: vec3f, worldPos: vec3f, hitSel: f32, stepCount: ptr<function, u32>) -> ShadeResult {
    let base = shadeHitBase(hit, flipNormal, viewDir, worldPos, stepCount);
    return applyFaceSelectionTint(base, hit, hitSel);
}

// Debug heatmap: map cumulative `sceneSDF_fast` calls per pixel to a coarse
// blue → green → yellow → red ramp. `rayMarchParams.maxSteps` is the natural
// upper reference — a pixel that exhausts its primary raymarch loop reaches
// the green/yellow band; AO and refinement push it higher. Pixels that go
// well over `maxSteps` saturate to red and indicate genuinely pathological
// cost (silhouettes, deep grazing rays, dense AO halos).
fn heatmapOverlay(base: vec4f, stepCount: u32) -> vec4f {
    if (viewSettings.debugHeatmap == 0u) { return base; }
    let t = f32(stepCount) / max(f32(rayMarchParams.maxSteps), 1.0);
    let c = clamp(t, 0.0, 1.5);
    let r = clamp(2.0 * (c - 0.5), 0.0, 1.0);
    let g = clamp(2.0 * c, 0.0, 1.0) - clamp(2.0 * (c - 1.0), 0.0, 1.0);
    let b = clamp(1.0 - 2.0 * c, 0.0, 1.0);
    return vec4f(r, g, b, 1.0);
}

// Apply dotted grid overlay on face-selected surfaces (screen-space dot pattern).
// Uses full-canvas pixel space so dots stay consistent regardless of render resolution.
fn applyFaceDottedPattern(color: vec3f, pixelCoord: vec2f) -> vec3f {
    let spacing = selectionStyles.faceDotSpacing;
    let radius = selectionStyles.faceDotRadius;
    let darken = selectionStyles.faceDotDarken;
    let scale = max(selectionStyles.resolutionScale, 0.25);
    let fullResCoord = pixelCoord / scale;
    let cell = floor(fullResCoord / spacing);
    let local = (fullResCoord / spacing - cell) * spacing;
    let center = spacing * 0.5;
    let dist = length(local - center);
    let inDot = dist < radius;
    let dotColor = color * darken;
    return select(color, dotColor, inDot);
}

// Plain-selection surface overlay — a screen-space diagonal CROSS-HATCH in the
// SELECTION COLOR, clearly distinct from the push/pull DOT dither so "selected"
// and "push/pull active" read as related but different. Kept light (low tint) so
// it reads as a subtle wash. `sel` confines it to the selected surface and fades
// it through blend regions.
fn applySelectionPattern(color: vec3f, pixelCoord: vec2f, sel: f32, lit: f32) -> vec3f {
    let scale = selectionStyles.resolutionScale;
    let p = pixelCoord / scale;
    let spacing = selectionStyles.faceDotSpacing * 1.4;            // hatch line spacing
    let halfWidth = max(selectionStyles.faceDotRadius * 1.0, 0.8); // half line thickness (thinner hatch)
    // Two perpendicular 45° line sets → cross-hatch. For each, distance (in the
    // diagonal coordinate) to the nearest line.
    let d1 = p.x + p.y;
    let d2 = p.x - p.y;
    let ph1 = d1 - floor(d1 / spacing) * spacing;
    let ph2 = d2 - floor(d2 / spacing) * spacing;
    let dist1 = min(ph1, spacing - ph1);
    let dist2 = min(ph2, spacing - ph2);
    // Anti-aliased coverage of either line set (smoothstep across ~1.4px).
    let cover1 = 1.0 - smoothstep(halfWidth - 0.7, halfWidth + 0.7, dist1);
    let cover2 = 1.0 - smoothstep(halfWidth - 0.7, halfWidth + 0.7, dist2);
    let cover = max(cover1, cover2);
    // Hatch lines take the FULL selection color, LIT by the scene (`lit` = the
    // surface's diffuse*AO) so the crosshatch reads as part of the shaded object
    // and brightens with the lighting — but with a brightness floor (0.75) so it
    // never sinks into shadow. This is why selected objects stay legible in dark
    // areas where the old fixed dim color faded out.
    let ec = selectionStyles.edgeColor;
    let litHatch = ec * (0.75 + 0.85 * clamp(lit, 0.0, 1.35));
    // Lerp toward the lit hatch color. Explicit lerp: Tint rejects
    // `mix(vec3, vec3, f32)` on this Dawn build.
    let t = 0.1 * clamp(sel, 0.0, 1.0) * cover;   // hatch opacity
    return color * (1.0 - t) + litHatch * t;
}

// Dispatch the selected-surface overlay: push/pull mode keeps its darkened-dot
// dither; plain selection uses the distinct selection-color pattern above. Both
// are confined to the selected surface (sel > 0).
fn applySelectionOverlay(color: vec3f, pixelCoord: vec2f, sel: f32, lit: f32) -> vec3f {
    if (sel <= 0.0) { return color; }
    if (faceSelection.pushPullActive != 0u) {
        return applyFaceDottedPattern(color, pixelCoord);
    }
    return applySelectionPattern(color, pixelCoord, sel, lit);
}

@fragment
fn fragmentMain(@location(0) fragCoord: vec2f) -> @location(0) vec4f {
    // Force bindings into the bind group layout (auto-layout strips unused bindings)
    _ = polygonVertices[0];
    _ = clickedHitPos[0];
    _ = clickedNormal[0];
    _ = faceSelection.nodeId;
    _ = previewParamsF32[0];
    _ = previewParamsVec2[0];
    _ = previewParamsVec3[0];
    _ = previewParamsMat3[0];
    _ = previewCapParamDrag[0];
    _ = edgeHits[0].kind;
    _ = selectedEdges.count;
    _ = hoverEdgeHits[0].kind;
    _ = hoveredEdge.count;
    _ = selectionStyles.faceDarken;

    let uv = fragCoord;
    let pixelCoord = uv * camera.res;
    let aspect = camera.res.x / camera.res.y;
    let wppu = (2.0 * camera.zoom) / camera.res.y;

    // Shift UV so camera.viewCenter maps to the camera center (0.5, 0.5).
    // This keeps the scene centered in the visible (non-editor) area while
    // the rendering extends underneath the translucent editor overlay.
    let uvAspect = vec2f(
        (uv.x - camera.viewCenter.x) * aspect + 0.5,
        uv.y - camera.viewCenter.y + 0.5
    );
    let rayOrigin = computeRayOrigin(uvAspect, camera.position);

    // Transform the ray from camera space into scene space
    let transformedOrigin = (camera.transform * vec4f(rayOrigin, 1.0)).xyz;
    let transformedDir = -camera.transform[2].xyz;
    // `camera.transform[2].xyz` is the camera's local +Z column transformed to
    // scene space. For the orthonormal camera basis this is already unit
    // length, so the previous `normalize(-transformedDir)` was a no-op — just
    // use the column directly.
    let viewDir = camera.transform[2].xyz;

    // Read beam pre-pass starting distance for this tile (or 0 if beam disabled)
    var t_start = 0.0;
    if (viewSettings.beamEnabled != 0u) {
        let tileCoord = vec2i(uv * camera.res) / BEAM_TILE_SIZE;
        t_start = textureLoad(tStartTex, tileCoord, 0).x;
    }

    // Cumulative `sceneSDF_fast` call counter — drives the debug heatmap.
    // Plumbed through raymarch/AO/refinement so the count covers everything
    // a typical pixel pays for. Single u32 in VGPR; the per-call increment
    // is negligible next to an SDF eval.
    var stepCount: u32 = 0u;

    // Both raymarch calls return HitData (13 scalars) rather than the full
    // SDFResult (17 scalars).  The full SDFResult only exists transiently inside
    // those functions; it is projected to HitData before returning, so it never
    // enters fragmentMain's register file.
    let hit = raymarch(transformedOrigin, transformedDir, t_start, &stepCount);
    let hitPos = transformedOrigin + transformedDir * hit.t;

    // Object-selection indicator. `selFloat` is the binary "is the pixel's hit
    // on a selected object?" value — 0 for unselected hits and misses, 1 for
    // selected hits. `hitDataMiss` returns id=0 and `selectedObjectIds[0]` is
    // always 0, so the lookup is safe on misses. It feeds the per-surface face
    // tint inside `shadeHit`; the selected-surface pattern overlay (a
    // screen-space dot pattern in the selection color — see
    // `applySelectionOverlay`) is applied to the shaded color below.
    let selFloat = select(0.0, f32(selectedObjectIds[hit.id] != 0u), hit.t > 0.0);
    // AO samples from the converged hit position directly. raymarch's refineRayHit
    // (hitRefineSteps bisection) already lands hit.t on the surface, so the former
    // separate refineHitAlongRay de-seam march only re-derived a position matching
    // hitPos to sub-pixel — pure redundant SDF taps, now dropped.
    let aoPos = hitPos;

    // In xray mode, find the back (inner) surface and use it for selection so
    // inner edges are selectable.  useBack replaces the old selecHit alias
    // (which was a redundant third HitData copy) — saving ~13 live scalars.
    var backHit = hitDataMiss();
    var backAoPos = vec3f(0.0);
    var useBack = false;
    if (viewSettings.xrayMode > 0u && hit.t > 0.0) {
        backHit = raymarchFromInside(transformedOrigin, transformedDir, hit.t, &stepCount);
        if (backHit.t > 0.0) {
            useBack = true;
            // backHit.t is already the converged exit surface (raymarchFromInside's
            // bisectSurfaceCrossing). The former extra back-AO bisect only re-bracketed
            // it to (exit-front)/64 — coarser, not finer — so sample AO here directly.
            backAoPos = transformedOrigin + transformedDir * backHit.t;
        }
    }
    // Click detection using pixel-accurate matching
    let needSeamSegment = viewSettings.selectionMode == SELECTION_MODE_EDGE || viewSettings.selectionMode == SELECTION_MODE_AUTO;
    if (clickState.enabled > 0u && hit.t > 0.0) {
        let clickPixel = clickState.clickPos * camera.res;
        let currentPixel = uv * camera.res;
        let pixelDist = distance(clickPixel, currentPixel);
        if (pixelDist < 2.0) {
            // selecPos: world pos of the "selection hit" (back surface in xray, front otherwise).
            // Computed here rather than at function scope so the 3 FMAs only run for the
            // 1-2 click pixels per frame, not every pixel.
            let selecPos = select(hitPos, transformedOrigin + transformedDir * backHit.t, useBack);
            atomicStore(&clickedObjectId, select(hit.id, backHit.id, useBack));
            clickedHitPos[0] = selecPos.x;
            clickedHitPos[1] = selecPos.y;
            clickedHitPos[2] = selecPos.z;
            clickedHitPos[3] = select(hit.t, backHit.t, useBack);
            let selecN = select(hit.n, backHit.n, useBack);
            clickedNormal[0] = selecN.x;
            clickedNormal[1] = selecN.y;
            clickedNormal[2] = selecN.z;
            clickedNormal[3] = 0.0;
            let frontEdge = classifyEdgeAtHit(hitPos, hit, wppu);
            edgeHits[0] = frontEdge;
            if (needSeamSegment) {
                edgeHits[2] = classifySeamSegment(hitPos, hit);
            } else {
                edgeHits[2] = EdgeHit();
            }
            if (useBack) {
                let backEdge = classifyEdgeAtHit(selecPos, backHit, wppu);
                edgeHits[1] = backEdge;
                if (needSeamSegment) {
                    edgeHits[3] = classifySeamSegment(selecPos, backHit);
                } else {
                    edgeHits[3] = EdgeHit();
                }
            } else {
                edgeHits[1] = EdgeHit();
                edgeHits[3] = EdgeHit();
            }
        }
    }

    if (clickState.hoverEnabled > 0u && hit.t > 0.0) {
        let hoverPixel = clickState.hoverPos * camera.res;
        let currentPixel = uv * camera.res;
        let pixelDist = distance(hoverPixel, currentPixel);
        if (pixelDist < 2.0) {
            let selecPos = select(hitPos, transformedOrigin + transformedDir * backHit.t, useBack);
            let frontEdge = classifyEdgeAtHit(hitPos, hit, wppu);
            hoverEdgeHits[0] = frontEdge;
            if (needSeamSegment) {
                hoverEdgeHits[2] = classifySeamSegment(hitPos, hit);
            } else {
                hoverEdgeHits[2] = EdgeHit();
            }
            if (useBack) {
                let backEdge = classifyEdgeAtHit(selecPos, backHit, wppu);
                hoverEdgeHits[1] = backEdge;
                if (needSeamSegment) {
                    hoverEdgeHits[3] = classifySeamSegment(selecPos, backHit);
                } else {
                    hoverEdgeHits[3] = EdgeHit();
                }
            } else {
                hoverEdgeHits[1] = EdgeHit();
                hoverEdgeHits[3] = EdgeHit();
            }
        }
    }

    if (hit.t > 0.0) {
        // `selFloat` was computed above as the selection indicator — same
        // storage read shadeHit would otherwise repeat, so reuse it here.
        var frontResult = shadeHit(hit, false, viewDir, aoPos, selFloat, &stepCount);
        var shadedColor = frontResult.color;
        shadedColor = applySelectionOverlay(shadedColor, pixelCoord, frontResult.faceSelected, frontResult.lit);
        shadedColor = applySelectedEdgeHighlight(shadedColor, hitPos, hit, wppu);

        // X-ray mode: front surface transparent over the visible back surface.
        if (viewSettings.xrayMode > 0u) {
            if (backHit.t > 0.0) {
                let backSel = f32(selectedObjectIds[backHit.id] != 0u);
                var backResult = shadeHit(backHit, true, viewDir, backAoPos, backSel, &stepCount);
                var backColor = backResult.color;
                backColor = applySelectionOverlay(backColor, pixelCoord, backResult.faceSelected, backResult.lit);
                let backPos = transformedOrigin + transformedDir * backHit.t;
                backColor = applySelectedEdgeHighlight(backColor, backPos, backHit, wppu);
                let frontAlpha = 0.4;
                let composited = shadedColor * frontAlpha + backColor * (1.0 - frontAlpha);
                let withGhost = compositeGhost(vec4f(composited, 1.0), transformedOrigin, transformedDir, viewDir, hit.t, wppu, &stepCount);
                return heatmapOverlay(withGhost, stepCount);
            } else {
                let alpha = 0.6;
                let withGhost = compositeGhost(vec4f(shadedColor * alpha, alpha), transformedOrigin, transformedDir, viewDir, hit.t, wppu, &stepCount);
                return heatmapOverlay(withGhost, stepCount);
            }
        }

        let withGhost = compositeGhost(vec4f(shadedColor, 1.0), transformedOrigin, transformedDir, viewDir, hit.t, wppu, &stepCount);
        return heatmapOverlay(withGhost, stepCount);
    } else {
        // Miss pixel — fully transparent, unless a highlighted ghost sits here.
        let withGhost = compositeGhost(vec4f(0.0), transformedOrigin, transformedDir, viewDir, hit.t, wppu, &stepCount);
        return heatmapOverlay(withGhost, stepCount);
    }
}

// ── Deferred selection shading: geometry + shade passes ────────────────────
// Together these reproduce fragmentMain's NON-x-ray output exactly, split so a
// selection/hover change re-runs only the cheap shade pass. The CPU keeps
// x-ray (and any unsupported mode) on fragmentMain. Both force-reference the
// full scene binding set (+ the G-buffer) so they share one bind group, exactly
// like depthOnlyMain.

// Force the full scene bind-group layout (bindings 1-7,9-11,13-25) + gbuffer(26).
fn forceDeferredBindings() {
    _ = camera.res;
    _ = clickState.enabled;
    _ = atomicLoad(&clickedObjectId);
    _ = selectedObjectIds[0];
    _ = colorPalette[0];
    _ = viewSettings.xrayMode;
    _ = textureLoad(tStartTex, vec2i(0, 0), 0);
    _ = polygonVertices[0];
    _ = clickedHitPos[0];
    _ = faceSelection.nodeId;
    _ = edgeHits[0].kind;
    _ = selectedEdges.count;
    _ = hoverEdgeHits[0].kind;
    _ = hoveredEdge.count;
    _ = clickedNormal[0];
    _ = selectionStyles.faceDarken;
    _ = previewParamsF32[0];
    _ = previewParamsVec2[0];
    _ = previewParamsVec3[0];
    _ = previewParamsMat3[0];
    _ = previewCapParamDrag[0];
    _ = rayMarchParams.maxSteps;
    _ = gbuffer[0].t;
}

// Geometry pass: the expensive, selection-independent half of fragmentMain —
// SDF raymarch + AO + view-dependent lighting + click/hover picking. Stores the
// result per pixel in the G-buffer. The returned colour is a throwaway target;
// the visible frame comes from shadeMain.
@fragment
fn geometryMain(@builtin(position) pos: vec4f, @location(0) fragCoord: vec2f) -> @location(0) vec4f {
    forceDeferredBindings();

    let uv = fragCoord;
    let aspect = camera.res.x / camera.res.y;
    let wppu = (2.0 * camera.zoom) / camera.res.y;
    let uvAspect = vec2f(
        (uv.x - camera.viewCenter.x) * aspect + 0.5,
        uv.y - camera.viewCenter.y + 0.5
    );
    let rayOrigin = computeRayOrigin(uvAspect, camera.position);
    let transformedOrigin = (camera.transform * vec4f(rayOrigin, 1.0)).xyz;
    let transformedDir = -camera.transform[2].xyz;
    let viewDir = camera.transform[2].xyz;

    var t_start = 0.0;
    if (viewSettings.beamEnabled != 0u) {
        let tileCoord = vec2i(uv * camera.res) / BEAM_TILE_SIZE;
        t_start = textureLoad(tStartTex, tileCoord, 0).x;
    }

    var stepCount: u32 = 0u;
    let hit = raymarch(transformedOrigin, transformedDir, t_start, &stepCount);
    let hitPos = transformedOrigin + transformedDir * hit.t;

    // AO samples from the converged hit position directly (matches fragmentMain).
    let aoPos = hitPos;

    // Click / hover picking — fragmentMain's NON-x-ray front-surface path.
    let needSeamSegment = viewSettings.selectionMode == SELECTION_MODE_EDGE || viewSettings.selectionMode == SELECTION_MODE_AUTO;
    if (clickState.enabled > 0u && hit.t > 0.0) {
        let clickPixel = clickState.clickPos * camera.res;
        let currentPixel = uv * camera.res;
        if (distance(clickPixel, currentPixel) < 2.0) {
            atomicStore(&clickedObjectId, hit.id);
            clickedHitPos[0] = hitPos.x;
            clickedHitPos[1] = hitPos.y;
            clickedHitPos[2] = hitPos.z;
            clickedHitPos[3] = hit.t;
            clickedNormal[0] = hit.n.x;
            clickedNormal[1] = hit.n.y;
            clickedNormal[2] = hit.n.z;
            clickedNormal[3] = 0.0;
            edgeHits[0] = classifyEdgeAtHit(hitPos, hit, wppu);
            edgeHits[1] = EdgeHit();
            if (needSeamSegment) { edgeHits[2] = classifySeamSegment(hitPos, hit); } else { edgeHits[2] = EdgeHit(); }
            edgeHits[3] = EdgeHit();
        }
    }
    if (clickState.hoverEnabled > 0u && hit.t > 0.0) {
        let hoverPixel = clickState.hoverPos * camera.res;
        let currentPixel = uv * camera.res;
        if (distance(hoverPixel, currentPixel) < 2.0) {
            hoverEdgeHits[0] = classifyEdgeAtHit(hitPos, hit, wppu);
            hoverEdgeHits[1] = EdgeHit();
            if (needSeamSegment) { hoverEdgeHits[2] = classifySeamSegment(hitPos, hit); } else { hoverEdgeHits[2] = EdgeHit(); }
            hoverEdgeHits[3] = EdgeHit();
        }
    }

    var g: GBufferPixel;
    if (hit.t > 0.0) {
        let base = shadeHitBase(hit, false, viewDir, aoPos, &stepCount);
        g.shadedColor = base.color;
        g.lit = base.lit;
    } else {
        g.shadedColor = vec3f(0.0);
        g.lit = 0.0;
    }
    g.t = hit.t;
    g.n = hit.n;
    g.blend = hit.blend;
    g.seamTangent = hit.seamTangent;
    g.seamGap = hit.seamGap;
    g.id = hit.id;
    g.id2 = hit.id2;
    g.seamA = hit.seamA;
    g.seamB = hit.seamB;
    g.seamOp = hit.seamOp;
    g.steps = stepCount;
    g._pad1 = 0u;
    gbuffer[gbufferIndex(pos)] = g;

    return vec4f(g.shadedColor, select(0.0, 1.0, hit.t > 0.0));
}

// Shade pass: reads the G-buffer and runs ONLY the selection-dependent tail —
// face/object tint, crosshatch overlay, edge highlight. No SDF. Bit-identical to
// fragmentMain's non-x-ray hit branch because every input is the same value
// fragmentMain would have used, sourced from the G-buffer instead of recomputed.
@fragment
fn shadeMain(@builtin(position) pos: vec4f, @location(0) fragCoord: vec2f) -> @location(0) vec4f {
    forceDeferredBindings();

    let g = gbuffer[gbufferIndex(pos)];

    let uv = fragCoord;
    let pixelCoord = uv * camera.res;
    let wppu = (2.0 * camera.zoom) / camera.res.y;

    // Ray reconstruction (same ray as geometryMain) — hoisted above the miss
    // check so the ghost overlay can march on miss pixels too. `stepCount` seeds
    // from the geometry pass so the heatmap keeps counting through the ghost march.
    let aspect = camera.res.x / camera.res.y;
    let uvAspect = vec2f(
        (uv.x - camera.viewCenter.x) * aspect + 0.5,
        uv.y - camera.viewCenter.y + 0.5
    );
    let rayOrigin = computeRayOrigin(uvAspect, camera.position);
    let transformedOrigin = (camera.transform * vec4f(rayOrigin, 1.0)).xyz;
    let transformedDir = -camera.transform[2].xyz;
    let viewDir = camera.transform[2].xyz;
    var stepCount: u32 = g.steps;

    if (g.t <= 0.0) {
        // Miss pixel — fully transparent (matches fragmentMain), unless a
        // highlighted ghost sits in front of the background here.
        let withGhost = compositeGhost(vec4f(0.0), transformedOrigin, transformedDir, viewDir, -1.0, wppu, &stepCount);
        return heatmapOverlay(withGhost, stepCount);
    }

    var hit: HitData;
    hit.t = g.t;
    hit.id = g.id;
    hit.id2 = g.id2;
    hit.blend = g.blend;
    hit.n = g.n;
    hit.seamA = g.seamA;
    hit.seamB = g.seamB;
    hit.seamOp = g.seamOp;
    hit.seamGap = g.seamGap;
    hit.seamTangent = g.seamTangent;

    // World hit position — same ray as geometryMain (origin/dir hoisted above).
    let hitPos = transformedOrigin + transformedDir * hit.t;

    let selFloat = f32(selectedObjectIds[hit.id] != 0u);
    let frontResult = applyFaceSelectionTint(BaseShade(g.shadedColor, g.lit), hit, selFloat);
    var shadedColor = frontResult.color;
    shadedColor = applySelectionOverlay(shadedColor, pixelCoord, frontResult.faceSelected, frontResult.lit);
    shadedColor = applySelectedEdgeHighlight(shadedColor, hitPos, hit, wppu);

    let withGhost = compositeGhost(vec4f(shadedColor, 1.0), transformedOrigin, transformedDir, viewDir, g.t, wppu, &stepCount);
    return heatmapOverlay(withGhost, stepCount);
}

// Occlusion depth for the FeatureGraph overlay, reconstructed from the deferred
// G-buffer instead of a second full SDF raymarch (depthOnlyMain). Output is
// byte-identical to depthOnlyMain — world hit position (xyz) + hit mask (w) — so
// the overlay consumes it unchanged. Used only when deferred shading AND overlay
// occlusion are both active; the G-buffer is already populated (or retained) for
// the current camera, so this is a cheap O(pixels) pass with no SDF evals.
@fragment
fn occlusionFromGBufferMain(@builtin(position) pos: vec4f, @location(0) fragCoord: vec2f) -> @location(0) vec4f {
    forceDeferredBindings();
    let g = gbuffer[gbufferIndex(pos)];
    if (g.t <= 0.0) {
        return vec4f(0.0);
    }
    let uv = fragCoord;
    let aspect = camera.res.x / camera.res.y;
    let uvAspect = vec2f(
        (uv.x - camera.viewCenter.x) * aspect + 0.5,
        uv.y - camera.viewCenter.y + 0.5
    );
    let rayOrigin = computeRayOrigin(uvAspect, camera.position);
    let transformedOrigin = (camera.transform * vec4f(rayOrigin, 1.0)).xyz;
    let transformedDir = -camera.transform[2].xyz;
    return vec4f(transformedOrigin + transformedDir * g.t, 1.0);
}

// Depth-only variant of the scene raymarch, used by the FeatureGraph overlay's
// occlusion modes. Writes the WORLD-SPACE hit position (xyz) + a hit mask
// (w: 1 on hit, 0 on miss) to an rgba32float target. The overlay re-projects
// this world position through ITS OWN camera matrix to derive a depth that's
// directly comparable to its line vertices — that sidesteps the fact that this
// shader (camera→world) and the overlay (world→camera) use opposite transform
// conventions, and keeps the comparison independent of `rayOriginDepth`.
//
// References the full scene bind-group set (via the `_ =` block, exactly like
// `fragmentMain`) so its `layout: "auto"` bind-group layout is identical to the
// preview pipeline's and the same scene bind group binds to both pipelines.
// Only invoked when the overlay's occlusion mode is on (otherwise never run).
@fragment
fn depthOnlyMain(@location(0) fragCoord: vec2f) -> @location(0) vec4f {
    // Force the full scene binding set into the auto layout (see fragmentMain).
    _ = clickState.enabled;
    _ = atomicLoad(&clickedObjectId);
    _ = selectedObjectIds[0];
    _ = colorPalette[0];
    _ = polygonVertices[0];
    _ = clickedHitPos[0];
    _ = clickedNormal[0];
    _ = faceSelection.nodeId;
    _ = edgeHits[0].kind;
    _ = selectedEdges.count;
    _ = hoverEdgeHits[0].kind;
    _ = hoveredEdge.count;
    _ = selectionStyles.faceDarken;
    _ = previewParamsF32[0];
    _ = previewParamsVec2[0];
    _ = previewParamsVec3[0];
    _ = previewParamsMat3[0];
    _ = previewCapParamDrag[0];

    let uv = fragCoord;
    let aspect = camera.res.x / camera.res.y;
    let uvAspect = vec2f(
        (uv.x - camera.viewCenter.x) * aspect + 0.5,
        uv.y - camera.viewCenter.y + 0.5
    );
    let rayOrigin = computeRayOrigin(uvAspect, camera.position);
    let transformedOrigin = (camera.transform * vec4f(rayOrigin, 1.0)).xyz;
    let transformedDir = -camera.transform[2].xyz;

    var t_start = 0.0;
    if (viewSettings.beamEnabled != 0u) {
        let tileCoord = vec2i(uv * camera.res) / BEAM_TILE_SIZE;
        t_start = textureLoad(tStartTex, tileCoord, 0).x;
    }

    var stepCount: u32 = 0u;
    let hit = raymarch(transformedOrigin, transformedDir, t_start, &stepCount);
    if (hit.t <= 0.0) {
        // Miss → mask 0; the overlay treats this as "no surface" and never
        // occludes lines that project onto empty space.
        return vec4f(0.0);
    }
    let hitPos = transformedOrigin + transformedDir * hit.t;
    return vec4f(hitPos, 1.0);
}

// Beam optimization compute: one march per tile; shares sceneSDF_fast / sceneAuxFast with preview (single shader module).
@compute @workgroup_size(8, 8)
fn beamMarch(@builtin(global_invocation_id) gid: vec3u) {
    let tileU = u32(BEAM_TILE_SIZE);
    // Match fragmentMain: keep preview uniform banks in layout (Tint strips unused bindings).
    _ = polygonVertices[0];
    _ = previewParamsF32[0];
    _ = previewParamsVec2[0];
    _ = previewParamsVec3[0];
    _ = previewParamsMat3[0];
    _ = previewCapParamDrag[0];
    // viewSettings (binding 6): the beam bind group always binds it, but the fast
    // SDF often doesn't read viewSettings at all, which would strip binding 6 from
    // the beam pipeline's auto layout → "binding index 6 not present" → invalid
    // bind group. Force the static reference so binding 6 is always in the layout.
    _ = viewSettings.selectionMode;

    let outDims = textureDimensions(tStartOut);
    if (gid.x >= outDims.x || gid.y >= outDims.y) {
        return;
    }

    let res = camera.res;
    let aspect = res.x / res.y;
    let resX = max(u32(res.x), 1u);
    let resY = max(u32(res.y), 1u);

    let pMin = gid.x * tileU;
    let pMax = min(pMin + tileU - 1u, resX - 1u);
    let qMin = gid.y * tileU;
    let qMax = min(qMin + tileU - 1u, resY - 1u);

    let tileCenterPixel = vec2f(
        (f32(pMin) + f32(pMax)) * 0.5 + 0.5,
        (f32(qMin) + f32(qMax)) * 0.5 + 0.5
    );
    let uv = tileCenterPixel / res;

    let uvAspect = vec2f(
        (uv.x - camera.viewCenter.x) * aspect + 0.5,
        uv.y - camera.viewCenter.y + 0.5
    );

    let offsetX = (uvAspect.x * 2.0 - 1.0) * camera.zoom;
    let offsetY = (uvAspect.y * 2.0 - 1.0) * camera.zoom;
    let rayOrigin = camera.position + vec3f(offsetX, offsetY, rayMarchParams.rayOriginDepth);

    let transformedOrigin = (camera.transform * vec4f(rayOrigin, 1.0)).xyz;
    let transformedDir = -camera.transform[2].xyz;

    let pixelSizeY = 2.0 * camera.zoom / res.y;
    let pixelSizeX = 2.0 * camera.zoom * aspect / res.x;
    let hx = 0.5 * f32(pMax - pMin) * pixelSizeX;
    let hy = 0.5 * f32(qMax - qMin) * pixelSizeY;
    let tileRadius = sqrt(hx * hx + hy * hy);

    var t: f32 = 0.001;
    for (var i: i32 = 0; i < rayMarchParams.maxBeamSteps; i = i + 1) {
        let p = transformedOrigin + t * transformedDir;
        let sr = sceneSDF_fast(p);
        let d = sr.d * sr.safeStepMul;
        let safeStep = d - tileRadius;

        if (safeStep < tileRadius || t >= rayMarchParams.maxDist) {
            break;
        }
        t = t + safeStep;
    }

    let beamTStartExtra = 2.0 * SURF_DIST;
    textureStore(
        tStartOut,
        vec2i(gid.xy),
        vec4f(max(t - tileRadius - beamTStartExtra, 0.0), 0.0, 0.0, 0.0),
    );
}
