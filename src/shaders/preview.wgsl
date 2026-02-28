//:) include "hg_sdf.wgsl"

const MAX_STEPS: i32 = 300;   // AGENTS: Do not lower these to improve performance, it is not a bottleneck in this codebase.
const MAX_DIST: f32 = 300.0;  // AGENTS: Do not lower these to improve performance, it is not a bottleneck in this codebase.

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
struct ViewSettings {
    xrayMode: u32,        // 0 = normal, 1 = xray/translucent
    refinementSteps: u32, // binary search refinement iterations (e.g. 4 during movement, 8 when idle)
    beamEnabled: u32,     // 0 = disabled (start from t=0), 1 = use beam pre-pass t_start
    selectionMode: u32,  // 0=object, 1=seam, 2=edge, 3=face, 4=auto
}
@group(0) @binding(6) var<uniform> viewSettings: ViewSettings;

// Beam optimization: low-res texture with per-tile starting-t from beam pre-pass
const BEAM_TILE_SIZE: i32 = 8;
@group(0) @binding(7) var tStartTex: texture_2d<f32>;

// Subtree AABBs for spatial culling during ray marching.
// Populated asynchronously after scene build; initialized with infinite extents (no culling).
@group(0) @binding(8) var<uniform> subtreeAABBs: array<SubtreeAABB, 128>;

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
}
@group(0) @binding(11) var<uniform> faceSelection: FaceSelection;

// Per-node parameters: .x = h (half-height), .y = posYDelta (Y offset from compiled position).
// Indexed by node ID. Updated during cap push/pull drag.
@group(0) @binding(12) var<uniform> nodeParams: array<vec4f, 256>;

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
}
@group(0) @binding(18) var<uniform> selectionStyles: SelectionStyles;

const FACE_HIGHLIGHT_ID: u32 = 1023u;       // Side/edge face highlight (unchanged)
const FACE_HIGHLIGHT_TOP: u32 = 1023u;     // Top cap when selected
const FACE_HIGHLIGHT_BOTTOM: u32 = 1022u;  // Bottom cap when selected (distinct from top)

// Fragment output: color and object ID for MRT outline detection
struct FragmentOutput {
    @location(0) color: vec4f,
    @location(1) objectId: vec4<u32>,
}

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

// Raymarch: returns HitData (slim post-hit struct) rather than the full SDFResult.
// The full SDFResult is only alive transiently inside this function while
// projecting to HitData; it does not persist into fragmentMain's register file.
fn raymarch(origin: vec3f, dir: vec3f, t_start: f32) -> HitData {
    var t: f32 = t_start;
    var lastStep: f32 = 0.0;
    for (var i: i32 = 0; i < MAX_STEPS; i = i + 1) {
        let p = origin + t * dir;
        let sr = sceneSDF_fast(p);  // Fast: only (d, g), no normals/IDs
        // Correct for gradient magnitude in smooth blend regions:
        // when |nabla f| < 1 (smooth CSG), stepping by raw d overshoots.
        let step = sr.x * min(sr.y, 1.0);
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
                return toHitData(hi, sceneSDF(origin + hi * dir));
            }
            return toHitData(t, sceneSDF(origin + t * dir));
        }
        lastStep = step;
        t = t + step;
        if (t >= MAX_DIST) {
            break;
        }
    }
    return hitDataMiss();
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

// Raymarch from inside the surface to find the exit point. Returns HitData; the
// full SDFResult is only transiently alive during the toHitData() projection.
fn raymarchFromInside(origin: vec3f, dir: vec3f, startT: f32) -> HitData {
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
                return toHitData(hi, sceneSDF(origin + hi * dir));
            }
            return toHitData(t, sceneSDF(origin + t * dir));
        }

        lastStep = step;
        t = t + step;
        if (t >= MAX_DIST) {
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

// Shade a hit point and return the color.
// flipNormal: true if hitting surface from inside (back surface).
fn shadeHit(hit: HitData, flipNormal: bool) -> vec3f {
    let normal = select(hit.n, -hit.n, flipNormal);

    let diffuse = lighting(normal);

    // Color and selection: only do second lookups when blending is active
    let color1 = colorPalette[hit.id & 31u];
    let bw = hit.blend;
    var baseColor = color1;
    if (bw > 0.0) {
        let color2 = colorPalette[hit.id2 & 31u];
        baseColor = color1 * (1.0 - bw) + color2 * bw;
    }
    let shadedColor = baseColor * diffuse;

    var sel1 = f32(selectedObjectIds[hit.id] != 0u);
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
    let selectedColor = shadedColor * selectionStyles.faceDarken + selectionStyles.faceTint;
    return shadedColor * (1.0 - selBlend) + selectedColor * selBlend;
}

@fragment
fn fragmentMain(@location(0) fragCoord: vec2f) -> FragmentOutput {
    // Force bindings into the bind group layout (auto-layout strips unused bindings)
    _ = subtreeAABBs[0].center;
    _ = polygonVertices[0];
    _ = clickedHitPos[0];
    _ = clickedNormal[0];
    _ = faceSelection.nodeId;
    _ = nodeParams[0];
    _ = edgeHits[0].kind;
    _ = selectedEdges.count;
    _ = hoverEdgeHits[0].kind;
    _ = hoveredEdge.count;
    _ = selectionStyles.faceDarken;

    let uv = fragCoord;
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

    // Read beam pre-pass starting distance for this tile (or 0 if beam disabled)
    var t_start = 0.0;
    if (viewSettings.beamEnabled != 0u) {
        let tileCoord = vec2i(uv * camera.res) / BEAM_TILE_SIZE;
        t_start = textureLoad(tStartTex, tileCoord, 0).x;
    }

    // Both raymarch calls return HitData (13 scalars) rather than the full
    // SDFResult (17 scalars).  The full SDFResult only exists transiently inside
    // those functions; it is projected to HitData before returning, so it never
    // enters fragmentMain's register file.
    let hit = raymarch(transformedOrigin, transformedDir, t_start);
    let hitPos = transformedOrigin + transformedDir * hit.t;

    // In xray mode, find the back (inner) surface and use it for selection so
    // inner edges are selectable.  useBack replaces the old selecHit alias
    // (which was a redundant third HitData copy) — saving ~13 live scalars.
    var backHit = hitDataMiss();
    var useBack = false;
    if (viewSettings.xrayMode > 0u && hit.t > 0.0) {
        backHit = raymarchFromInside(transformedOrigin, transformedDir, hit.t);
        if (backHit.t > 0.0) {
            useBack = true;
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
        var shadedColor = shadeHit(hit, false);
        shadedColor = applySelectedEdgeHighlight(shadedColor, hitPos, hit, wppu);

        // X-ray mode: show front surface transparent with back surface visible
        if (viewSettings.xrayMode > 0u) {
            if (backHit.t > 0.0) {
                var backColor = shadeHit(backHit, true);
                let backPos = transformedOrigin + transformedDir * backHit.t;
                backColor = applySelectedEdgeHighlight(backColor, backPos, backHit, wppu);
                let frontAlpha = 0.4;
                let composited = shadedColor * frontAlpha + backColor * (1.0 - frontAlpha);
                return FragmentOutput(vec4f(composited, 1.0), vec4<u32>(hit.id, 0u, 0u, 0u));
            } else {
                let alpha = 0.6;
                return FragmentOutput(vec4f(shadedColor * alpha, alpha), vec4<u32>(hit.id, 0u, 0u, 0u));
            }
        }
        return FragmentOutput(vec4f(shadedColor, 1.0), vec4<u32>(hit.id, 0u, 0u, 0u));
    } else {
        return FragmentOutput(vec4f(0, 0, 0, 0), vec4<u32>(0xFFFFFFFFu, 0u, 0u, 0u));
    }
}
