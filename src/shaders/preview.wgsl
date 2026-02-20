//:) include "hg_sdf.wgsl"

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
struct ViewSettings {
    xrayMode: u32,        // 0 = normal, 1 = xray/translucent
    refinementSteps: u32, // binary search refinement iterations (e.g. 4 during movement, 8 when idle)
    beamEnabled: u32,     // 0 = disabled (start from t=0), 1 = use beam pre-pass t_start
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

// Face selection: tells the Extrude shader which face to highlight with FACE_HIGHLIGHT_ID.
struct FaceSelection {
    nodeId: u32,         // Extrude node ID (0 = disabled)
    faceIndex: u32,      // edge index of the selected face
    mode: u32,           // 0 = slide, 1 = extrude
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
    seedPoint: vec4f,     // xyz = world hit pos, w = unused
    seedTangent: vec3f,   // for seam segments: tangent at seed for sharp-boundary matching
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
    seedPoint: vec3f,   // for seam segments: disambiguate parallel seams
    seedTangent: vec3f, // for seam segments: tangent at seed, segment ends when dot < cos(angle)
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

const FACE_HIGHLIGHT_ID: u32 = 1023u;

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

fn classifyEdgeAtHit(hitWorld: vec3f, sdf: SDFResult, wppu: f32) -> EdgeHit {
    var out: EdgeHit;
    out.kind = EDGE_KIND_NONE;
    out.primaryId = 0u;
    out.secondaryId = 0u;
    out.featureA = 0u;
    out.opType = 0u;
    out.objectId = sdf.id;
    out.seedPoint = vec4f(hitWorld, 0.0);
    out.seedTangent = vec3f(0.0, 0.0, 0.0);

    var pos = vec3f(0.0);
    var half = vec3f(0.0);
    if (getBoxParamsForId(sdf.id, &pos, &half)) {
        let localP = hitWorld - pos;
        let feat = nearestBoxEdgeFeature(localP, half);
        let nearestDist = boxEdgeDistance(localP, half, feat);
        let minHalf = min(min(half.x, half.y), half.z);
        let edgeThreshold = max(minHalf * 0.12, 0.012);
        if (nearestDist < edgeThreshold) {
            out.kind = EDGE_KIND_PRIMITIVE;
            out.primaryId = sdf.id;
            out.featureA = feat;
            let onEdge = pos + closestPointOnBoxEdge(localP, half, feat);
            out.seedPoint = vec4f(onEdge, 0.0);
            return out;
        }
    }

    if (sdf.seamOp != 0u && sdf.seamGap < 0.10) {
        out.kind = EDGE_KIND_SEAM;
        out.primaryId = sdf.seamA;
        out.secondaryId = sdf.seamB;
        out.opType = sdf.seamOp;
        let t = sdf.seamTangent;
        let tLen = max(length(t), 1e-6);
        out.seedTangent = t / tLen;
        let perp = sdf.n - dot(sdf.n, t) / (tLen * tLen) * t;
        let perpLen = length(perp);
        if (perpLen > 1e-6) {
            let d = sdf.seamGap / tLen;
            let onSeam = hitWorld - (perp / perpLen) * d;
            out.seedPoint = vec4f(onSeam, 0.0);
        }
        return out;
    }
    return out;
}

// Classify seam segment for edge mode: detect corners (tangent changes > 15°) and identify segment by dominant axis.
fn classifySeamSegment(hitWorld: vec3f, sdf: SDFResult) -> EdgeHit {
    var out: EdgeHit;
    out.kind = EDGE_KIND_NONE;
    out.primaryId = sdf.seamA;
    out.secondaryId = sdf.seamB;
    out.featureA = 0u;
    out.opType = sdf.seamOp;
    out.objectId = sdf.id;
    out.seedTangent = vec3f(0.0, 0.0, 0.0);
    let t = sdf.seamTangent;
    let tLen = length(t);
    if (tLen > 1e-6 && sdf.seamOp != 0u && sdf.seamGap < 0.10) {
        let perp = sdf.n - dot(sdf.n, t) / (tLen * tLen) * t;
        let perpLen = length(perp);
        if (perpLen > 1e-6) {
            let d = sdf.seamGap / tLen;
            out.seedPoint = vec4f(hitWorld - (perp / perpLen) * d, 0.0);
        } else {
            out.seedPoint = vec4f(hitWorld, 0.0);
        }
    } else {
        out.seedPoint = vec4f(hitWorld, 0.0);
    }
    if (sdf.seamOp == 0u || sdf.seamGap >= 0.10) { return out; }
    if (tLen < 1e-6) { return out; }
    let tNorm = t / tLen;
    let epsilon: f32 = 0.02;
    let sdfAhead = sceneSDF(hitWorld + epsilon * tNorm);
    if (sdfAhead.seamOp == 0u) { return out; }
    let tAhead = sdfAhead.seamTangent;
    let tAheadLen = length(tAhead);
    let cos15: f32 = 0.9659258;
    let atCorner = tAheadLen > 1e-6 && dot(tNorm, tAhead / tAheadLen) < cos15;
    let segTangent = select(t, tAhead, atCorner);
    let tangentAxis = dominantAxisIndex(segTangent);
    let normalAxis = dominantAxisIndex(sdf.n);
    if (tangentAxis == 0u) { return out; }
    out.kind = EDGE_KIND_SEAM_SEGMENT;
    out.featureA = tangentAxis * 8u + normalAxis;
    out.seedTangent = tNorm;
    return out;
}

fn applySelectedEdgeHighlight(color: vec3f, hitWorld: vec3f, sdf: SDFResult, wppu: f32) -> vec3f {
    var result = color;
    let highlight = vec3f(1.0, 1.0, 0.0);

    for (var i: u32 = 0u; i < selectedEdges.count; i = i + 1u) {
        let e = selectedEdges.edges[i];
        var lineWidth = e.lineWidthPx;
        var epsilon = e.epsilon;
        let strength = 0.8;

        if (e.kind == EDGE_KIND_PRIMITIVE) {
            var pos = vec3f(0.0);
            var half = vec3f(0.0);
            if (getBoxParamsForId(e.primaryId, &pos, &half) && e.primaryId == sdf.id) {
                let localP = hitWorld - pos;
                let feat = nearestBoxEdgeFeature(localP, half);
                if (feat == e.featureA) {
                    let dist = boxEdgeDistance(localP, half, feat);
                    let edgeDistPx = dist / wppu;
                    let t = 1.0 - smoothstep(lineWidth - epsilon, lineWidth + epsilon, edgeDistPx);
                    result = result * (1.0 - t * strength) + highlight * (t * strength);
                }
            }
        } else if (e.kind == EDGE_KIND_SEAM && sdf.seamOp != 0u && sdf.blend < 0.01) {
            if (sdf.seamA == e.primaryId && sdf.seamB == e.secondaryId && sdf.seamOp == e.opType) {
                let seamThresh = max(length(sdf.seamTangent), 1e-6);
                let seamDist = sdf.seamGap / seamThresh;
                let edgeDistPx = seamDist / wppu;
                let t = 1.0 - smoothstep(lineWidth - epsilon, lineWidth + epsilon, edgeDistPx);
                result = result * (1.0 - t * strength) + highlight * (t * strength);
            }
        } else if (e.kind == EDGE_KIND_SEAM_SEGMENT && sdf.seamOp != 0u && sdf.blend < 0.01) {
            let idsMatch = sdf.seamA == e.primaryId && sdf.seamB == e.secondaryId && sdf.seamOp == e.opType;
            let toSeed = hitWorld - e.seedPoint;
            let distToSeed = length(toSeed);
            let tangent = sdf.seamTangent;
            let tLen = max(length(tangent), 1e-6);
            let tNorm = tangent / tLen;
            let seedTanLen = length(e.seedTangent);
            let tangentContinuous = seedTanLen > 1e-6 && dot(tNorm, e.seedTangent / seedTanLen) > 0.342;
            let onSameSegment = idsMatch && tangentContinuous && distToSeed < 15.0;
            if (onSameSegment) {
                let seamThresh = max(length(sdf.seamTangent), 1e-6);
                let seamDist = sdf.seamGap / seamThresh;
                let edgeDistPx = seamDist / wppu;
                let t = 1.0 - smoothstep(lineWidth - epsilon, lineWidth + epsilon, edgeDistPx);
                result = result * (1.0 - t * strength) + highlight * (t * strength);
            }
        }
    }

    for (var j: u32 = 0u; j < hoveredEdge.count; j = j + 1u) {
        let e = hoveredEdge.edges[j];
        var lineWidth = e.lineWidthPx;
        var epsilon = e.epsilon;
        let strength = 0.4;

        if (e.kind == EDGE_KIND_PRIMITIVE) {
            var pos = vec3f(0.0);
            var half = vec3f(0.0);
            if (getBoxParamsForId(e.primaryId, &pos, &half) && e.primaryId == sdf.id) {
                let localP = hitWorld - pos;
                let feat = nearestBoxEdgeFeature(localP, half);
                if (feat == e.featureA) {
                    let dist = boxEdgeDistance(localP, half, feat);
                    let edgeDistPx = dist / wppu;
                    let t = 1.0 - smoothstep(lineWidth - epsilon, lineWidth + epsilon, edgeDistPx);
                    result = result * (1.0 - t * strength) + highlight * (t * strength);
                }
            }
        } else if (e.kind == EDGE_KIND_SEAM && sdf.seamOp != 0u && sdf.blend < 0.01) {
            if (sdf.seamA == e.primaryId && sdf.seamB == e.secondaryId && sdf.seamOp == e.opType) {
                let seamThresh = max(length(sdf.seamTangent), 1e-6);
                let seamDist = sdf.seamGap / seamThresh;
                let edgeDistPx = seamDist / wppu;
                let t = 1.0 - smoothstep(lineWidth - epsilon, lineWidth + epsilon, edgeDistPx);
                result = result * (1.0 - t * strength) + highlight * (t * strength);
            }
        } else if (e.kind == EDGE_KIND_SEAM_SEGMENT && sdf.seamOp != 0u && sdf.blend < 0.01) {
            let idsMatch = sdf.seamA == e.primaryId && sdf.seamB == e.secondaryId && sdf.seamOp == e.opType;
            let toSeed = hitWorld - e.seedPoint;
            let distToSeed = length(toSeed);
            let tangent = sdf.seamTangent;
            let tLen = max(length(tangent), 1e-6);
            let tNorm = tangent / tLen;
            let seedTanLen = length(e.seedTangent);
            let tangentContinuous = seedTanLen > 1e-6 && dot(tNorm, e.seedTangent / seedTanLen) > 0.342;
            let onSameSegment = idsMatch && tangentContinuous && distToSeed < 15.0;
            if (onSameSegment) {
                let seamThresh = max(length(sdf.seamTangent), 1e-6);
                let seamDist = sdf.seamGap / seamThresh;
                let edgeDistPx = seamDist / wppu;
                let t = 1.0 - smoothstep(lineWidth - epsilon, lineWidth + epsilon, edgeDistPx);
                result = result * (1.0 - t * strength) + highlight * (t * strength);
            }
        }
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
    // Force bindings into the bind group layout (auto-layout strips unused bindings)
    _ = subtreeAABBs[0].center;
    _ = polygonVertices[0];
    _ = clickedHitPos[0];
    _ = faceSelection.nodeId;
    _ = nodeParams[0];
    _ = edgeHits[0].kind;
    _ = selectedEdges.count;
    _ = hoverEdgeHits[0].kind;
    _ = hoveredEdge.count;

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

    // Use standard raymarching, starting from beam distance
    let hit = raymarch(transformedOrigin, transformedDir, t_start);
    let hitPos = transformedOrigin + transformedDir * hit.t;

    // In xray mode, find the back (inner) surface and use it for selection so inner edges are selectable.
    // We compute backHit here and reuse it for shading below.
    var selecHit = hit;
    var selecPos = transformedOrigin + transformedDir * hit.t;
    var backHit = RaymarchHit(-1.0, sdfTrue(MAX_DIST, 0u, vec3f(0.0)));
    if (viewSettings.xrayMode > 0u && hit.t > 0.0) {
        backHit = raymarchFromInside(transformedOrigin, transformedDir, hit.t);
        if (backHit.t > 0.0) {
            selecHit = backHit;
            selecPos = transformedOrigin + transformedDir * backHit.t;
        }
    }

    // Click detection using pixel-accurate matching
    if (clickState.enabled > 0u && hit.t > 0.0) {
        let clickPixel = clickState.clickPos * camera.res;
        let currentPixel = uv * camera.res;
        let pixelDist = distance(clickPixel, currentPixel);
        if (pixelDist < 2.0) {
            atomicStore(&clickedObjectId, selecHit.sdf.id);
            clickedHitPos[0] = selecPos.x;
            clickedHitPos[1] = selecPos.y;
            clickedHitPos[2] = selecPos.z;
            clickedHitPos[3] = selecHit.t;
            let frontEdge = classifyEdgeAtHit(hitPos, hit.sdf, wppu);
            edgeHits[0] = frontEdge;
            let frontSeg = classifySeamSegment(hitPos, hit.sdf);
            edgeHits[2] = frontSeg;
            if (viewSettings.xrayMode > 0u && backHit.t > 0.0) {
                let backEdge = classifyEdgeAtHit(selecPos, selecHit.sdf, wppu);
                edgeHits[1] = backEdge;
                let backSeg = classifySeamSegment(selecPos, selecHit.sdf);
                edgeHits[3] = backSeg;
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
            let frontEdge = classifyEdgeAtHit(hitPos, hit.sdf, wppu);
            hoverEdgeHits[0] = frontEdge;
            let frontSeg = classifySeamSegment(hitPos, hit.sdf);
            hoverEdgeHits[2] = frontSeg;
            if (viewSettings.xrayMode > 0u && backHit.t > 0.0) {
                let backEdge = classifyEdgeAtHit(selecPos, selecHit.sdf, wppu);
                hoverEdgeHits[1] = backEdge;
                let backSeg = classifySeamSegment(selecPos, selecHit.sdf);
                hoverEdgeHits[3] = backSeg;
            } else {
                hoverEdgeHits[1] = EdgeHit();
                hoverEdgeHits[3] = EdgeHit();
            }
        }
    }

    if (hit.t > 0.0) {
        var shadedColor = shadeHit(hit, false);
        shadedColor = applySelectedEdgeHighlight(shadedColor, hitPos, hit.sdf, wppu);

        // X-ray mode: show front surface transparent with back surface visible
        if (viewSettings.xrayMode > 0u) {
            if (backHit.t > 0.0) {
                var backColor = shadeHit(backHit, true);
                let backPos = transformedOrigin + transformedDir * backHit.t;
                backColor = applySelectedEdgeHighlight(backColor, backPos, backHit.sdf, wppu);
                let frontAlpha = 0.4;
                let composited = shadedColor * frontAlpha + backColor * (1.0 - frontAlpha);
                return FragmentOutput(vec4f(composited, 1.0), vec4<u32>(hit.sdf.id, 0u, 0u, 0u));
            } else {
                let alpha = 0.6;
                return FragmentOutput(vec4f(shadedColor * alpha, alpha), vec4<u32>(hit.sdf.id, 0u, 0u, 0u));
            }
        }
        return FragmentOutput(vec4f(shadedColor, 1.0), vec4<u32>(hit.sdf.id, 0u, 0u, 0u));
    } else {
        return FragmentOutput(vec4f(0, 0, 0, 0), vec4<u32>(0xFFFFFFFFu, 0u, 0u, 0u));
    }
}
