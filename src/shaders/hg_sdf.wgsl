// Translated from https://mercury.sexy/hg_sdf

//////////////////////////////
//          CONSTANTS
//////////////////////////////

const PI: f32 = 3.14159265;
const TAU: f32 = 2.0 * PI;
const PHI: f32 = sqrt(5.0) * 0.5 + 0.5;
const INVERSESQRT2: f32 = 0.7071067811865476;
const SURF_DIST: f32 = 0.001;
const MID_FEATURE_NONE: u32 = 0u;
const MID_FEATURE_LINE: u32 = 1u;
const MID_FEATURE_CORNER: u32 = 2u;
const MID_FEATURE_BOOLEAN_SEAM: u32 = 3u;
const MID_FEATURE_SEAM_COS_THRESH: f32 = 0.9659258;

//////////////////////////////
//  EXTENDED SDF RESULT TYPE
//////////////////////////////

// SDFResult carries both the distance value and a gradient-magnitude estimate.
// - d: The distance value (may not be true Euclidean distance for non-SDF operators)
// - g: Gradient magnitude estimate of the field itself.
//
// IMPORTANT:
// g is not the same thing as the safe march multiplier used by the fast path.
// Those are tracked separately in FastSDFResult so the code no longer overloads
// one number with two meanings.
struct SDFResult {
    d: f32,
    g: f32,
    id: u32,
    n: vec3<f32>,
    id2: u32,     // secondary ID for smooth blend color interpolation
    blend: f32,   // blend weight: 0 = fully id, 1 = fully id2
    seamA: u32,   // operand ID at nearest hard CSG seam
    seamB: u32,
    seamOp: u32,  // 0=none, 1=union, 2=intersection, 3=difference
    seamGap: f32, // |dA - dB| near seam
    seamTangent: vec3f,
}

fn sdfR(d: f32, g: f32, id: u32, n: vec3f) -> SDFResult {
    return SDFResult(d, g, id, n, id, 0.0, id, id, 0u, 1e9, vec3f(0.0, 0.0, 1.0));
}

fn sdfTrue(d: f32, id: u32, n: vec3<f32>) -> SDFResult {
    return SDFResult(d, 1.0, id, n, id, 0.0, id, id, 0u, 1e9, vec3f(0.0, 0.0, 1.0));
}

fn sdfNeg(r: SDFResult) -> SDFResult {
    return SDFResult(-r.d, r.g, r.id, -r.n, r.id2, r.blend, r.seamA, r.seamB, r.seamOp, r.seamGap, r.seamTangent);
}

fn bestSeam(a: SDFResult, b: SDFResult, outerGap: f32, outerOp: u32, outerTangent: vec3f) -> SDFResult {
    var s: SDFResult;
    s.seamA = a.id;
    s.seamB = b.id;
    s.seamOp = outerOp;
    s.seamGap = outerGap;
    s.seamTangent = outerTangent;
    if (a.seamOp != 0u && a.seamGap < s.seamGap) {
        s.seamA = a.seamA; s.seamB = a.seamB;
        s.seamOp = a.seamOp; s.seamGap = a.seamGap;
        s.seamTangent = a.seamTangent;
    }
    if (b.seamOp != 0u && b.seamGap < s.seamGap) {
        s.seamA = b.seamA; s.seamB = b.seamB;
        s.seamOp = b.seamOp; s.seamGap = b.seamGap;
        s.seamTangent = b.seamTangent;
    }
    return s;
}

fn selectSDF(falseVal: SDFResult, trueVal: SDFResult, cond: bool) -> SDFResult {
    if (cond) { return trueVal; }
    return falseVal;
}

fn applySeam(out: ptr<function, SDFResult>, seam: SDFResult) {
    (*out).seamA = seam.seamA;
    (*out).seamB = seam.seamB;
    (*out).seamOp = seam.seamOp;
    (*out).seamGap = seam.seamGap;
    (*out).seamTangent = seam.seamTangent;
}

// SDFResultMid: d, g, n + optional feature payload for feature-aware MDC.
struct SDFResultMid {
    d: f32,
    g: f32,
    n: vec3f,
    featureKind: u32,
    featureDist: f32,
    featureIdA: u32,
    featureIdB: u32,
    featureNormalCount: u32,
    featurePoint: vec3f,
    featureTangent: vec3f,
    featureN1: vec3f,
    featureN2: vec3f,
}

fn sdfRMidNoFeature(d: f32, g: f32, n: vec3f) -> SDFResultMid {
    return SDFResultMid(
        d, g, n,
        MID_FEATURE_NONE, 1e9, 0u, 0u, 0u,
        vec3f(0.0), vec3f(0.0), vec3f(0.0), vec3f(0.0),
    );
}

fn sdfRMidLine(d: f32, g: f32, n: vec3f, featurePoint: vec3f, tangent: vec3f, n1: vec3f, featureDist: f32) -> SDFResultMid {
    return SDFResultMid(
        d, g, n,
        MID_FEATURE_LINE, featureDist, 0u, 0u, 2u,
        featurePoint, tangent, n1, vec3f(0.0),
    );
}

fn sdfRMidCorner(d: f32, g: f32, n: vec3f, featurePoint: vec3f, n1: vec3f, n2: vec3f, featureDist: f32) -> SDFResultMid {
    return SDFResultMid(
        d, g, n,
        MID_FEATURE_CORNER, featureDist, 0u, 0u, 3u,
        featurePoint, vec3f(0.0), n1, n2,
    );
}

fn orderedOwnerPair(ownerA: u32, ownerB: u32) -> vec2u {
    if (ownerA == 0u && ownerB == 0u) { return vec2u(0u, 0u); }
    if (ownerA == 0u) { return vec2u(ownerB, ownerB); }
    if (ownerB == 0u) { return vec2u(ownerA, ownerA); }
    if (ownerA <= ownerB) { return vec2u(ownerA, ownerB); }
    return vec2u(ownerB, ownerA);
}

fn sdfRMidSeam(d: f32, g: f32, n: vec3f, seamIdA: u32, seamIdB: u32, seamN0: vec3f, seamN1: vec3f, featureDist: f32) -> SDFResultMid {
    let owners = orderedOwnerPair(seamIdA, seamIdB);
    return SDFResultMid(
        d, g, n,
        MID_FEATURE_BOOLEAN_SEAM, featureDist, owners.x, owners.y, 2u,
        vec3f(0.0), vec3f(0.0), seamN0, seamN1,
    );
}

fn clearMidFeature(r: SDFResultMid) -> SDFResultMid {
    var out = r;
    out.featureKind = MID_FEATURE_NONE;
    out.featureDist = 1e9;
    out.featureNormalCount = 0u;
    out.featurePoint = vec3f(0.0);
    out.featureTangent = vec3f(0.0);
    out.featureN1 = vec3f(0.0);
    out.featureN2 = vec3f(0.0);
    return out;
}

fn sdfRMidOwned(d: f32, g: f32, n: vec3f, ownerA: u32, ownerB: u32) -> SDFResultMid {
    var out = sdfRMidNoFeature(d, g, n);
    let owners = orderedOwnerPair(ownerA, ownerB);
    out.featureIdA = owners.x;
    out.featureIdB = owners.y;
    return out;
}

fn sdfRMid(d: f32, g: f32, n: vec3f) -> SDFResultMid {
    return sdfRMidNoFeature(d, g, n);
}

fn sdfNegMid(r: SDFResultMid) -> SDFResultMid {
    var out = r;
    out.d = -r.d;
    out.n = -r.n;
    out.featureN1 = -r.featureN1;
    out.featureN2 = -r.featureN2;
    return out;
}

fn selectMid(falseVal: SDFResultMid, trueVal: SDFResultMid, cond: bool) -> SDFResultMid {
    if (cond) { return trueVal; }
    return falseVal;
}

fn sdfMidSetOwner(r: SDFResultMid, ownerId: u32) -> SDFResultMid {
    var out = r;
    out.featureIdA = ownerId;
    if (out.featureKind == MID_FEATURE_BOOLEAN_SEAM) {
        if (out.featureIdB == 0u) { out.featureIdB = ownerId; }
    } else {
        out.featureIdB = ownerId;
    }
    return out;
}

fn midPrimaryOwner(r: SDFResultMid) -> u32 {
    if (r.featureIdA != 0u) { return r.featureIdA; }
    return r.featureIdB;
}

fn sdfRotateFeatureMid(r: SDFResultMid, m: mat3x3f) -> SDFResultMid {
    if (r.featureKind == MID_FEATURE_NONE) { return r; }
    var out = r;
    out.featurePoint = m * r.featurePoint;
    out.featureTangent = safeNormalize(m * r.featureTangent, r.featureTangent);
    out.featureN1 = safeNormalize(m * r.featureN1, r.featureN1);
    out.featureN2 = safeNormalize(m * r.featureN2, r.featureN2);
    return out;
}

fn sdfScaleFeatureMid(r: SDFResultMid, s: vec3f) -> SDFResultMid {
    if (r.featureKind == MID_FEATURE_NONE) { return r; }
    var out = r;
    let m = min(abs(s.x), min(abs(s.y), abs(s.z)));
    let invs = vec3f(1.0 / s.x, 1.0 / s.y, 1.0 / s.z);
    out.featurePoint = r.featurePoint * s;
    out.featureDist = r.featureDist * m;
    out.featureTangent = safeNormalize(r.featureTangent * s, r.featureTangent);
    out.featureN1 = safeNormalize(r.featureN1 * invs, r.featureN1);
    out.featureN2 = safeNormalize(r.featureN2 * invs, r.featureN2);
    return out;
}

fn sdfMidStripFeatures(r: SDFResultMid) -> SDFResultMid {
    return clearMidFeature(r);
}

// Fast-path sample used by ray marching / broad sampling.
// - d: field value
// - g: gradient-magnitude estimate for the field
// - safeStepMul: conservative multiplier for marching by d
struct FastSDFResult {
    d: f32,
    g: f32,
    safeStepMul: f32,
}

fn sdfFast(d: f32, g: f32, safeStepMul: f32) -> FastSDFResult {
    return FastSDFResult(d, g, safeStepMul);
}

fn sdfFastNeg(r: FastSDFResult) -> FastSDFResult {
    return FastSDFResult(-r.d, r.g, r.safeStepMul);
}

fn selectFast(falseVal: FastSDFResult, trueVal: FastSDFResult, cond: bool) -> FastSDFResult {
    if (cond) { return trueVal; }
    return falseVal;
}

//////////////////////////////
//   LIGHTWEIGHT HIT DATA
//
// Strips fields unused in the fragment shading pipeline (d, g)
// to reduce register pressure in fragmentMain.  Each raymarch call returns one
// of these; holding two simultaneously (front + back hit) costs 26 scalars
// instead of 54 with the full RaymarchHit{t, SDFResult}.
//////////////////////////////

struct HitData {
    t: f32,              // ray parameter; negative = miss
    id: u32,             // primary object ID
    id2: u32,            // secondary ID for blend colour
    blend: f32,          // smooth-blend weight (0 = fully id, 1 = fully id2)
    n: vec3f,            // analytical surface normal
    seamA: u32,
    seamB: u32,
    seamOp: u32,         // 0=none, 1=union, 2=intersection, 3=difference
    seamGap: f32,
    seamTangent: vec3f,
}

fn hitDataMiss() -> HitData {
    return HitData(-1.0, 0u, 0u, 0.0, vec3f(0.0), 0u, 0u, 0u, 1e9, vec3f(0.0));
}

fn toHitData(t: f32, sdf: SDFResult) -> HitData {
    return HitData(t, sdf.id, sdf.id2, sdf.blend, sdf.n,
                   sdf.seamA, sdf.seamB, sdf.seamOp, sdf.seamGap, sdf.seamTangent);
}

//////////////////////////////
//       HELPER FUNCTIONS
//////////////////////////////

// Cheap axis-aligned bounding box distance for BVH early-out.
// Returns the signed distance to the box surface (negative = inside).
// No gradient computation, no sqrt — just a fast lower-bound test.
fn sdBound(p: vec3f, center: vec3f, half: vec3f) -> f32 {
    let q = abs(p - center) - half;
    return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}

fn modF(x: f32, y: f32) -> f32 {
    // Emulates GLSL mod() for negative values.
    // WGSL % is a remainder operator, which differs from GLSL mod.
    return x - y * floor(x / y);
}

fn saturate(x: f32) -> f32 {
    return clamp(x, 0.0, 1.0);
}

// Minimal step() + mix() re-implementations:
fn step(edge: f32, x: f32) -> f32 {
    return select(0.0, 1.0, x >= edge);
}
fn mix(a: f32, b: f32, t: f32) -> f32 {
    return a * (1.0 - t) + b * t;
}

// Sign that always returns ±1
fn sgn(x: f32) -> f32 {
    return select(1.0, -1.0, x < 0.0);
}
fn sgnVec2(v: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(sgn(v.x), sgn(v.y));
}
fn sgnVec3(v: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(sgn(v.x), sgn(v.y), sgn(v.z));
}

fn safeNormalize(v: vec3f, fallback: vec3f) -> vec3f {
    let len2 = dot(v, v);
    if (len2 > 1e-8) {
        return v * inverseSqrt(len2);
    }
    return fallback;
}

fn lengthSqr(v: vec3<f32>) -> f32 {
    return dot(v, v);
}

// vmax / vmin across different vector sizes
fn vmax2(v: vec2<f32>) -> f32 {
    return max(v.x, v.y);
}
fn vmax3(v: vec3<f32>) -> f32 {
    return max(max(v.x, v.y), v.z);
}
fn vmax4(v: vec4<f32>) -> f32 {
    return max(max(v.x, v.y), max(v.z, v.w));
}

fn vmin2(v: vec2<f32>) -> f32 {
    return min(v.x, v.y);
}
fn vmin3(v: vec3<f32>) -> f32 {
    return min(min(v.x, v.y), v.z);
}
fn vmin4(v: vec4<f32>) -> f32 {
    return min(min(v.x, v.y), min(v.z, v.w));
}

////////////////////////////////////////
//     PRIMITIVE DISTANCE FUNCTIONS
////////////////////////////////////////

fn fSphere(p: vec3<f32>, r: f32) -> f32 {
    return length(p) - r;
}

fn fPlane(p: vec3<f32>, n: vec3<f32>, distanceFromOrigin: f32) -> f32 {
    return dot(p, n) + distanceFromOrigin;
}

// Cheap box
fn fBoxCheap(p: vec3<f32>, b: vec3<f32>) -> f32 {
    return vmax3(abs(p) - b);
}

// Correct box
fn fBox(p: vec3<f32>, b: vec3<f32>) -> f32 {
    let d = abs(p) - b;
    return length(max(d, vec3<f32>(0.0))) + vmax3(min(d, vec3<f32>(0.0)));
}

////////////////////////////////////////
//  EXTENDED PRIMITIVE DISTANCE FUNCTIONS
//  These return SDFResult with gradient magnitude = 1.0
////////////////////////////////////////

fn fSphereEx(p: vec3<f32>, r: f32, id: u32) -> SDFResult {
    let d = length(p) - r;
    let n = normalize(p);
    return sdfTrue(d, id, n);
}

fn fBoxEx(p: vec3<f32>, b: vec3<f32>, id: u32) -> SDFResult {
    let d = abs(p) - b;
    let outside = max(d, vec3<f32>(0.0));
    let outsideLen = length(outside);
    var n = vec3<f32>(0.0, 0.0, 0.0);
    if (outsideLen > 0.0) {
        n = normalize(outside * sgnVec3(p));
    } else {
        if (d.x > d.y && d.x > d.z) {
            n = vec3<f32>(sgn(p.x), 0.0, 0.0);
        } else if (d.y > d.z) {
            n = vec3<f32>(0.0, sgn(p.y), 0.0);
        } else {
            n = vec3<f32>(0.0, 0.0, sgn(p.z));
        }
    }
    return sdfTrue(length(outside) + vmax3(min(d, vec3<f32>(0.0))), id, n);
}

fn fCylinderEx(p: vec3<f32>, r: f32, height: f32, id: u32) -> SDFResult {
    let dRadial = length(p.xz) - r;
    let dCap = abs(p.y) - height;
    let d = max(dRadial, dCap);
    let onBarrel = dRadial > dCap;
    let nBarrel = safeNormalize(vec3f(p.x, 0.0, p.z), vec3f(1.0, 0.0, 0.0));
    let nCap = vec3f(0.0, sgn(p.y), 0.0);
    let n = select(nCap, nBarrel, onBarrel);
    return sdfTrue(d, id, n);
}

// FDM threaded rod: sinusoidal helical radius (smooth, prints reliably).
// helixSign: +1 = right-hand (default), -1 = left-hand (flip advance along +Y vs azimuth).
// Barrel-only SDF (sceneAux emits capped variants with per-pass param reads + virtual cap IDs).
fn fThreadedRodBarrelDist(p: vec3f, r: f32, pitch: f32, amp: f32, helixSign: f32) -> f32 {
    let rho = length(p.xz);
    let k = TAU / max(pitch, 1e-6);
    let phase = helixSign * k * p.y - atan2(p.z, p.x);
    return rho - (r + amp * sin(phase));
}

// ISO-ish threaded rod: triangular helical profile (V-groove silhouette), same phase as FDM.
fn fThreadedRodBarrelDistIso(p: vec3f, r: f32, pitch: f32, amp: f32, helixSign: f32) -> f32 {
    let rho = length(p.xz);
    let k = TAU / max(pitch, 1e-6);
    let phase = helixSign * k * p.y - atan2(p.z, p.x);
    let u = fract(phase / TAU);
    let tri = select(3.0 - 4.0 * u, -1.0 + 4.0 * u, u < 0.5);
    return rho - (r + amp * tri);
}

// ACME-style threaded rod: symmetric trapezoidal helical profile (flat crest and root, two linear flanks per turn).
// Same phase as FDM/ISO; flank/flat fractions are a preview approximation (radial depth still from scene threadAmp).
fn fThreadedRodBarrelDistAcme(p: vec3f, r: f32, pitch: f32, amp: f32, helixSign: f32) -> f32 {
    let rho = length(p.xz);
    let k = TAU / max(pitch, 1e-6);
    let phase = helixSign * k * p.y - atan2(p.z, p.x);
    let u = fract(phase / TAU);
    let fw = 0.35;
    let fc = 0.15;
    let t0 = fw;
    let t1 = fw + fc;
    let t2 = t1 + fw;
    var tr: f32;
    if (u < t0) {
        tr = -1.0 + 2.0 * (u / fw);
    } else if (u < t1) {
        tr = 1.0;
    } else if (u < t2) {
        tr = 1.0 - 2.0 * ((u - t1) / fw);
    } else {
        tr = -1.0;
    }
    return rho - (r + amp * tr);
}

fn fConeEx(p: vec3<f32>, radius: f32, height: f32, id: u32) -> SDFResult {
    let lenXZ = length(p.xz);
    let q = vec2f(lenXZ, p.y);
    let tip = q - vec2f(0.0, height);
    let L = length(vec2f(height, radius));
    let mantleDir = vec2f(height, radius) / L;
    let mantle = dot(tip, mantleDir);
    let base = -q.y;
    var d = mantle;
    var region: i32 = 0;
    if (base > d) {
        d = base;
        region = 1;
    }
    let perpDir = vec2f(mantleDir.y, -mantleDir.x);
    let projected = dot(tip, perpDir);
    if (q.y > height && projected < 0.0) {
        let tipDist = length(tip);
        if (tipDist > d) {
            d = tipDist;
            region = 2;
        }
    }
    if (q.x > radius && projected > L) {
        let baseDist = length(q - vec2f(radius, 0.0));
        if (baseDist > d) {
            d = baseDist;
            region = 3;
        }
    }
    var radDir = vec3f(1.0, 0.0, 0.0);
    if (lenXZ > 1e-8) {
        radDir = vec3f(p.x / lenXZ, 0.0, p.z / lenXZ);
    }
    var n = vec3f(0.0, 1.0, 0.0);
    if (region == 3) {
        n = safeNormalize(vec3f(p.x - radius * radDir.x, p.y, p.z - radius * radDir.z), vec3f(0.0, -1.0, 0.0));
    } else if (region == 2) {
        n = safeNormalize(vec3f(p.x, p.y - height, p.z), vec3f(0.0, 1.0, 0.0));
    } else if (region == 1) {
        n = vec3f(0.0, -1.0, 0.0);
    } else {
        n = safeNormalize(vec3f(mantleDir.x * radDir.x, mantleDir.y, mantleDir.x * radDir.z), vec3f(0.0, 1.0, 0.0));
    }
    return sdfTrue(d, id, n);
}

fn fTorusEx(p: vec3<f32>, smallRadius: f32, largeRadius: f32, id: u32) -> SDFResult {
    let lenXZ = length(p.xz);
    let d = length(vec2f(lenXZ - largeRadius, p.y)) - smallRadius;
    var ringX = largeRadius;
    var ringZ = 0.0;
    if (lenXZ > 1e-8) {
        ringX = p.x / lenXZ * largeRadius;
        ringZ = p.z / lenXZ * largeRadius;
    }
    let n = safeNormalize(vec3f(p.x - ringX, p.y, p.z - ringZ), vec3f(0.0, 1.0, 0.0));
    return sdfTrue(d, id, n);
}

fn fCapsuleEx(p: vec3<f32>, r: f32, c: f32, id: u32) -> SDFResult {
    let inCap = abs(p.y) >= c;
    let q = vec3f(p.x, p.y - sgn(p.y) * c, p.z);
    let dBarrel = length(p.xz) - r;
    let dCap = length(q) - r;
    let d = select(dBarrel, dCap, inCap);
    let nBarrel = safeNormalize(vec3f(p.x, 0.0, p.z), vec3f(1.0, 0.0, 0.0));
    let nCap = safeNormalize(q, vec3f(0.0, sgn(p.y), 0.0));
    let n = select(nBarrel, nCap, inCap);
    return sdfTrue(d, id, n);
}

fn fPlaneEx(p: vec3<f32>, n_param: vec3<f32>, distanceFromOrigin: f32, id: u32) -> SDFResult {
    let d = dot(p, n_param) + distanceFromOrigin;
    return sdfTrue(d, id, n_param);
}

fn fHexagonCircumcircleEx(p: vec3<f32>, h: vec2<f32>, id: u32) -> SDFResult {
    let q = abs(p);
    let dCap = q.y - h.y;
    let dHexA = q.x * sqrt(3.0) * 0.5 + q.z * 0.5 - h.x;
    let dHexB = q.z - h.x;
    let dHex = max(dHexA, dHexB);
    let d = max(dCap, dHex);
    var n = vec3f(0.0, 1.0, 0.0);
    if (dCap > dHex) {
        n = vec3f(0.0, sgn(p.y), 0.0);
    } else if (dHexA > dHexB) {
        n = vec3f(sgn(p.x) * sqrt(3.0) * 0.5, 0.0, sgn(p.z) * 0.5);
    } else {
        n = vec3f(0.0, 0.0, sgn(p.z));
    }
    return sdfTrue(d, id, n);
}

fn fDiscEx(p: vec3<f32>, r: f32, id: u32) -> SDFResult {
    let lenXZ = length(p.xz);
    let l = lenXZ - r;
    if (l < 0.0) {
        return sdfTrue(abs(p.y), id, vec3f(0.0, sgn(p.y), 0.0));
    }
    let d = length(vec2f(p.y, l));
    var radDir = vec3f(1.0, 0.0, 0.0);
    if (lenXZ > 1e-8) {
        radDir = vec3f(p.x / lenXZ, 0.0, p.z / lenXZ);
    }
    let nearest = radDir * r;
    let n = safeNormalize(p - nearest, vec3f(0.0, sgn(p.y), 0.0));
    return sdfTrue(d, id, n);
}

fn fBlobEx(pIn: vec3<f32>, id: u32) -> SDFResult {
    let d = fBlob(pIn);
    let eps = 0.001;
    let nx = fBlob(pIn + vec3f(eps, 0.0, 0.0)) - fBlob(pIn - vec3f(eps, 0.0, 0.0));
    let ny = fBlob(pIn + vec3f(0.0, eps, 0.0)) - fBlob(pIn - vec3f(0.0, eps, 0.0));
    let nz = fBlob(pIn + vec3f(0.0, 0.0, eps)) - fBlob(pIn - vec3f(0.0, 0.0, eps));
    let n = safeNormalize(vec3f(nx, ny, nz), vec3f(0.0, 1.0, 0.0));
    return sdfTrue(d, id, n);
}

////////////////////////////////////////
//  MID PRIMITIVES (SDFResultMid: d, g, n only)
////////////////////////////////////////

fn fSphereMid(p: vec3<f32>, r: f32) -> SDFResultMid {
    let d = length(p) - r;
    let n = normalize(p);
    return sdfRMid(d, 1.0, n);
}

fn fBoxMid(p: vec3<f32>, b: vec3<f32>) -> SDFResultMid {
    let d = abs(p) - b;
    let outside = max(d, vec3<f32>(0.0));
    let outsideLen = length(outside);
    var n = vec3<f32>(0.0, 0.0, 0.0);
    if (outsideLen > 0.0) {
        n = normalize(outside * sgnVec3(p));
    } else {
        if (d.x > d.y && d.x > d.z) {
            n = vec3<f32>(sgn(p.x), 0.0, 0.0);
        } else if (d.y > d.z) {
            n = vec3<f32>(0.0, sgn(p.y), 0.0);
        } else {
            n = vec3<f32>(0.0, 0.0, sgn(p.z));
        }
    }
    let dist = length(outside) + vmax3(min(d, vec3<f32>(0.0)));
    let localAbs = abs(p);
    let closeX = abs(localAbs.x - b.x) < SURF_DIST * 4.0;
    let closeY = abs(localAbs.y - b.y) < SURF_DIST * 4.0;
    let closeZ = abs(localAbs.z - b.z) < SURF_DIST * 4.0;
    let contactCount = u32(closeX) + u32(closeY) + u32(closeZ);
    let sx = sgn(p.x);
    let sy = sgn(p.y);
    let sz = sgn(p.z);

    if (contactCount >= 3u) {
        let cp = vec3f(sx * b.x, sy * b.y, sz * b.z);
        return sdfRMidCorner(
            dist, 1.0, vec3f(sx, 0.0, 0.0), cp,
            vec3f(0.0, sy, 0.0), vec3f(0.0, 0.0, sz),
            length(p - cp),
        );
    }

    if (contactCount >= 2u) {
        if (closeX && closeY) {
            let cp = vec3f(sx * b.x, sy * b.y, clamp(p.z, -b.z, b.z));
            return sdfRMidLine(
                dist, 1.0,
                vec3f(sx, 0.0, 0.0),
                cp, vec3f(0.0, 0.0, 1.0),
                vec3f(0.0, sy, 0.0),
                length(p - cp),
            );
        }
        if (closeX && closeZ) {
            let cp = vec3f(sx * b.x, clamp(p.y, -b.y, b.y), sz * b.z);
            return sdfRMidLine(
                dist, 1.0,
                vec3f(sx, 0.0, 0.0),
                cp, vec3f(0.0, 1.0, 0.0),
                vec3f(0.0, 0.0, sz),
                length(p - cp),
            );
        }
        let cp = vec3f(clamp(p.x, -b.x, b.x), sy * b.y, sz * b.z);
        return sdfRMidLine(
            dist, 1.0,
            vec3f(0.0, sy, 0.0),
            cp, vec3f(1.0, 0.0, 0.0),
            vec3f(0.0, 0.0, sz),
            length(p - cp),
        );
    }

    return sdfRMid(dist, 1.0, n);
}

fn fCylinderMid(p: vec3<f32>, r: f32, height: f32) -> SDFResultMid {
    let dRadial = length(p.xz) - r;
    let dCap = abs(p.y) - height;
    let d = max(dRadial, dCap);
    let onBarrel = dRadial > dCap;
    let nBarrel = safeNormalize(vec3f(p.x, 0.0, p.z), vec3f(1.0, 0.0, 0.0));
    let nCap = vec3f(0.0, sgn(p.y), 0.0);
    let n = select(nCap, nBarrel, onBarrel);
    return sdfRMid(d, 1.0, n);
}

fn fConeMid(p: vec3<f32>, radius: f32, height: f32) -> SDFResultMid {
    let lenXZ = length(p.xz);
    let q = vec2f(lenXZ, p.y);
    let tip = q - vec2f(0.0, height);
    let L = length(vec2f(height, radius));
    let mantleDir = vec2f(height, radius) / L;
    let mantle = dot(tip, mantleDir);
    let base = -q.y;
    var d = mantle;
    var region: i32 = 0;
    if (base > d) {
        d = base;
        region = 1;
    }
    let perpDir = vec2f(mantleDir.y, -mantleDir.x);
    let projected = dot(tip, perpDir);
    if (q.y > height && projected < 0.0) {
        let tipDist = length(tip);
        if (tipDist > d) {
            d = tipDist;
            region = 2;
        }
    }
    if (q.x > radius && projected > L) {
        let baseDist = length(q - vec2f(radius, 0.0));
        if (baseDist > d) {
            d = baseDist;
            region = 3;
        }
    }
    var radDir = vec3f(1.0, 0.0, 0.0);
    if (lenXZ > 1e-8) {
        radDir = vec3f(p.x / lenXZ, 0.0, p.z / lenXZ);
    }
    var n = vec3f(0.0, 1.0, 0.0);
    if (region == 3) {
        n = safeNormalize(vec3f(p.x - radius * radDir.x, p.y, p.z - radius * radDir.z), vec3f(0.0, -1.0, 0.0));
    } else if (region == 2) {
        n = safeNormalize(vec3f(p.x, p.y - height, p.z), vec3f(0.0, 1.0, 0.0));
    } else if (region == 1) {
        n = vec3f(0.0, -1.0, 0.0);
    } else {
        n = safeNormalize(vec3f(mantleDir.x * radDir.x, mantleDir.y, mantleDir.x * radDir.z), vec3f(0.0, 1.0, 0.0));
    }
    return sdfRMid(d, 1.0, n);
}

fn fTorusMid(p: vec3<f32>, smallRadius: f32, largeRadius: f32) -> SDFResultMid {
    let lenXZ = length(p.xz);
    let d = length(vec2f(lenXZ - largeRadius, p.y)) - smallRadius;
    var ringX = largeRadius;
    var ringZ = 0.0;
    if (lenXZ > 1e-8) {
        ringX = p.x / lenXZ * largeRadius;
        ringZ = p.z / lenXZ * largeRadius;
    }
    let n = safeNormalize(vec3f(p.x - ringX, p.y, p.z - ringZ), vec3f(0.0, 1.0, 0.0));
    return sdfRMid(d, 1.0, n);
}

fn fCapsuleMid(p: vec3<f32>, r: f32, c: f32) -> SDFResultMid {
    let inCap = abs(p.y) >= c;
    let q = vec3f(p.x, p.y - sgn(p.y) * c, p.z);
    let dBarrel = length(p.xz) - r;
    let dCap = length(q) - r;
    let d = select(dBarrel, dCap, inCap);
    let nBarrel = safeNormalize(vec3f(p.x, 0.0, p.z), vec3f(1.0, 0.0, 0.0));
    let nCap = safeNormalize(q, vec3f(0.0, sgn(p.y), 0.0));
    let n = select(nBarrel, nCap, inCap);
    return sdfRMid(d, 1.0, n);
}

fn fPlaneMid(p: vec3<f32>, n_param: vec3<f32>, distanceFromOrigin: f32) -> SDFResultMid {
    let d = dot(p, n_param) + distanceFromOrigin;
    return sdfRMid(d, 1.0, n_param);
}

fn fHexagonCircumcircleMid(p: vec3<f32>, h: vec2<f32>) -> SDFResultMid {
    let q = abs(p);
    let dCap = q.y - h.y;
    let dHexA = q.x * sqrt(3.0) * 0.5 + q.z * 0.5 - h.x;
    let dHexB = q.z - h.x;
    let dHex = max(dHexA, dHexB);
    let d = max(dCap, dHex);
    var n = vec3f(0.0, 1.0, 0.0);
    if (dCap > dHex) {
        n = vec3f(0.0, sgn(p.y), 0.0);
    } else if (dHexA > dHexB) {
        n = vec3f(sgn(p.x) * sqrt(3.0) * 0.5, 0.0, sgn(p.z) * 0.5);
    } else {
        n = vec3f(0.0, 0.0, sgn(p.z));
    }
    return sdfRMid(d, 1.0, n);
}

fn fDiscMid(p: vec3<f32>, r: f32) -> SDFResultMid {
    let lenXZ = length(p.xz);
    let l = lenXZ - r;
    if (l < 0.0) {
        return sdfRMid(abs(p.y), 1.0, vec3f(0.0, sgn(p.y), 0.0));
    }
    let d = length(vec2f(p.y, l));
    var radDir = vec3f(1.0, 0.0, 0.0);
    if (lenXZ > 1e-8) {
        radDir = vec3f(p.x / lenXZ, 0.0, p.z / lenXZ);
    }
    let nearest = radDir * r;
    let n = safeNormalize(p - nearest, vec3f(0.0, sgn(p.y), 0.0));
    return sdfRMid(d, 1.0, n);
}

fn fBlobMid(pIn: vec3<f32>) -> SDFResultMid {
    let d = fBlob(pIn);
    let eps = 0.001;
    let nx = fBlob(pIn + vec3f(eps, 0.0, 0.0)) - fBlob(pIn - vec3f(eps, 0.0, 0.0));
    let ny = fBlob(pIn + vec3f(0.0, eps, 0.0)) - fBlob(pIn - vec3f(0.0, eps, 0.0));
    let nz = fBlob(pIn + vec3f(0.0, 0.0, eps)) - fBlob(pIn - vec3f(0.0, 0.0, eps));
    let n = safeNormalize(vec3f(nx, ny, nz), vec3f(0.0, 1.0, 0.0));
    return sdfRMid(d, 1.0, n);
}

// 2D boxes
fn fBox2Cheap(p: vec2<f32>, b: vec2<f32>) -> f32 {
    return vmax2(abs(p) - b);
}
fn fBox2(p: vec2<f32>, b: vec2<f32>) -> f32 {
    let d = abs(p) - b;
    return length(max(d, vec2<f32>(0.0))) + vmax2(min(d, vec2<f32>(0.0)));
}

fn fCorner(p: vec2<f32>) -> f32 {
    return length(max(p, vec2<f32>(0.0))) + vmax2(min(p, vec2<f32>(0.0)));
}

// Blobby ball object
fn fBlob(pIn: vec3<f32>) -> f32 {
    var p = abs(pIn);
    if p.x < max(p.y, p.z) { p = p.yzx; }
    if p.x < max(p.y, p.z) { p = p.yzx; }
    let b = max(max(max(dot(p, normalize(vec3<f32>(1.0, 1.0, 1.0))), dot(p.xz, normalize(vec2<f32>(PHI + 1.0, 1.0)))), dot(p.yx, normalize(vec2<f32>(1.0, PHI)))), dot(p.xz, normalize(vec2<f32>(1.0, PHI))));
    let l = length(p);
    return l - 1.5 - 0.2 * (1.5 / 2.0) * cos(min(sqrt(1.01 - b / l) * (PI / 0.25), PI));
}

fn fCylinder(p: vec3<f32>, r: f32, height: f32) -> f32 {
    let d = max(length(p.xz) - r, abs(p.y) - height);
    return d;
}

// Capsule with vertical round caps
fn fCapsule(p: vec3<f32>, r: f32, c: f32) -> f32 {
    let d1 = length(p.xz) - r;
    let d2 = length(vec3<f32>(p.x, abs(p.y) - c, p.z)) - r;
    let t = step(c, abs(p.y));
    return mix(d1, d2, t);
}

// Distance to line segment
fn fLineSegment(p: vec3<f32>, a: vec3<f32>, b: vec3<f32>) -> f32 {
    let ab = b - a;
    let t = saturate(dot(p - a, ab) / dot(ab, ab));
    return length(ab * t + a - p);
}

// Capsule between endpoints a, b
fn fCapsule2(p: vec3<f32>, a: vec3<f32>, b: vec3<f32>, r: f32) -> f32 {
    return fLineSegment(p, a, b) - r;
}

// Torus in XZ plane
fn fTorus(p: vec3<f32>, smallRadius: f32, largeRadius: f32) -> f32 {
    return length(vec2<f32>(length(p.xz) - largeRadius, p.y)) - smallRadius;
}

// Circle line
fn fCircle(p: vec3<f32>, r: f32) -> f32 {
    let l = length(p.xz) - r;
    return length(vec2<f32>(p.y, l));
}

// Circular disc, no thickness
fn fDisc(p: vec3<f32>, r: f32) -> f32 {
    let l = length(p.xz) - r;
    if l < 0.0 {
        return abs(p.y);
    }
    return length(vec2<f32>(p.y, l));
}

// Hex prisms
fn fHexagonCircumcircle(p: vec3<f32>, h: vec2<f32>) -> f32 {
    let q = abs(p);
    return max(q.y - h.y, max(q.x * sqrt(3.0) * 0.5 + q.z * 0.5, q.z) - h.x);
}
fn fHexagonIncircle(p: vec3<f32>, h: vec2<f32>) -> f32 {
    return fHexagonCircumcircle(p, vec2<f32>(h.x * sqrt(3.0) * 0.5, h.y));
}

// Cone with correct tip/base distance
fn fCone(p: vec3<f32>, radius: f32, height: f32) -> f32 {
    let q = vec2<f32>(length(p.xz), p.y);
    let tip = q - vec2<f32>(0.0, height);
    let mantleDir = normalize(vec2<f32>(height, radius));
    let mantle = dot(tip, mantleDir);
    var d = max(mantle, -q.y);

    let projected = dot(tip, vec2<f32>(mantleDir.y, -mantleDir.x));
    if (q.y > height) && (projected < 0.0) {
        d = max(d, length(tip));
    }
    if (q.x > radius) && (projected > length(vec2<f32>(height, radius))) {
        d = max(d, length(q - vec2<f32>(radius, 0.0)));
    }
    return d;
}

//////////////////////////////////////////////
//   GENERALIZED DISTANCE FUNCTIONS (POLYHEDRA)
//////////////////////////////////////////////

// const GDFVectors: array<vec3<f32>, 19> = array<vec3<f32>, 19>(normalize(vec3<f32>(1.0, 0.0, 0.0)), normalize(vec3<f32>(0.0, 1.0, 0.0)), normalize(vec3<f32>(0.0, 0.0, 1.0)), normalize(vec3<f32>(1.0, 1.0, 1.0)), normalize(vec3<f32>(-1.0, 1.0, 1.0)), normalize(vec3<f32>(1.0, -1.0, 1.0)), normalize(vec3<f32>(1.0, 1.0, -1.0)), normalize(vec3<f32>(0.0, 1.0, PHI + 1.0)), normalize(vec3<f32>(0.0, -1.0, PHI + 1.0)), normalize(vec3<f32>(PHI + 1.0, 0.0, 1.0)), normalize(vec3<f32>(-PHI - 1.0, 0.0, 1.0)), normalize(vec3<f32>(1.0, PHI + 1.0, 0.0)), normalize(vec3<f32>(-1.0, PHI + 1.0, 0.0)), normalize(vec3<f32>(0.0, PHI, 1.0)), normalize(vec3<f32>(0.0, -PHI, 1.0)), normalize(vec3<f32>(1.0, 0.0, PHI)), normalize(vec3<f32>(-1.0, 0.0, PHI)), normalize(vec3<f32>(PHI, 1.0, 0.0)), normalize(vec3<f32>(-PHI, 1.0, 0.0)));

// // Exponent version
// fn fGDFExp(p: vec3<f32>, r: f32, e: f32, begin: i32, end: i32) -> f32 {
//     var d = 0.0;
//     for (var i = begin; i <= end; i = i + 1) {
//         d = d + pow(abs(dot(p, GDFVectors[i])), e);
//     }
//     return pow(d, 1.0 / e) - r;
// }

// // Non-exponent version (sharp edges)
// fn fGDF(p: vec3<f32>, r: f32, begin: i32, end: i32) -> f32 {
//     var d = 0.0;
//     for (var i = begin; i <= end; i = i + 1) {
//         d = max(d, abs(dot(p, GDFVectors[i])));
//     }
//     return d - r;
// }

// // Sample polyhedra
// fn fOctahedronExp(p: vec3<f32>, r: f32, e: f32) -> f32 {
//     return fGDFExp(p, r, e, 3, 6);
// }
// fn fDodecahedronExp(p: vec3<f32>, r: f32, e: f32) -> f32 {
//     return fGDFExp(p, r, e, 13, 18);
// }
// fn fIcosahedronExp(p: vec3<f32>, r: f32, e: f32) -> f32 {
//     return fGDFExp(p, r, e, 3, 12);
// }
// fn fTruncatedOctahedronExp(p: vec3<f32>, r: f32, e: f32) -> f32 {
//     return fGDFExp(p, r, e, 0, 6);
// }
// fn fTruncatedIcosahedronExp(p: vec3<f32>, r: f32, e: f32) -> f32 {
//     return fGDFExp(p, r, e, 3, 18);
// }

// fn fOctahedron(p: vec3<f32>, r: f32) -> f32 {
//     return fGDF(p, r, 3, 6);
// }
// fn fDodecahedron(p: vec3<f32>, r: f32) -> f32 {
//     return fGDF(p, r, 13, 18);
// }
// fn fIcosahedron(p: vec3<f32>, r: f32) -> f32 {
//     return fGDF(p, r, 3, 12);
// }
// fn fTruncatedOctahedron(p: vec3<f32>, r: f32) -> f32 {
//     return fGDF(p, r, 0, 6);
// }
// fn fTruncatedIcosahedron(p: vec3<f32>, r: f32) -> f32 {
//     return fGDF(p, r, 3, 18);
// }

//////////////////////////////////////////////
//   DOMAIN MANIPULATION (POINTER-BASED)
//////////////////////////////////////////////

// Rotate 2D by angle a (modifies *p in place)
fn pR(p: ptr<function, vec2<f32>>, a: f32) {
    let x = (*p).x;
    let y = (*p).y;
    let c = cos(a);
    let s = sin(a);
    (*p) = vec2<f32>(c * x + s * y, c * y - s * x);
}

fn pR45(p: ptr<function, vec2<f32>>) {
    // 45-degree rotation
    let tmp = (*p) + vec2<f32>((*p).y, -(*p).x);
    (*p) = tmp * sqrt(0.5);
}

// Repeat space along one axis
fn pMod1(p: ptr<function, f32>, size: f32) -> f32 {
    let halfSize = size * 0.5;
    let c = floor(((*p) + halfSize) / size);
    (*p) = modF((*p) + halfSize, size) - halfSize;
    return c;
}

// Mirror every second cell
fn pModMirror1(p: ptr<function, f32>, size: f32) -> f32 {
    let halfSize = size * 0.5;
    let c = floor(((*p) + halfSize) / size);
    let t = modF((*p) + halfSize, size) - halfSize;
    let mirrorFactor = select(1.0, -1.0,(c % 2.0) != 0.0);
    (*p) = t * mirrorFactor;
    return c;
}

// Repeat only in positive direction
fn pModSingle1(p: ptr<function, f32>, size: f32) -> f32 {
    let halfSize = size * 0.5;
    let c = floor(((*p) + halfSize) / size);
    if (*p) >= 0.0 {
        (*p) = modF((*p) + halfSize, size) - halfSize;
    }
    return c;
}

// Repeat only a limited interval [start, stop]
fn pModInterval1(p: ptr<function, f32>, size: f32, start: f32, stop: f32) -> f32 {
    let halfSize = size * 0.5;
    var c = floor(((*p) + halfSize) / size);
    (*p) = modF((*p) + halfSize, size) - halfSize;
    if (c > stop) {
        (*p) = (*p) + size * (c - stop);
        c = stop;
    }
    if (c < start) {
        (*p) = (*p) + size * (c - start);
        c = start;
    }
    return c;
}

// Repeat around origin by a fixed angle
fn pModPolar(p: ptr<function, vec2<f32>>, repetitions: f32) -> f32 {
    let angle = 2.0 * PI / repetitions;
    let r = length(*p);
    let a = atan2((*p).y,(*p).x) + angle * 0.5;
    var c = floor(a / angle);
    let newA = modF(a, angle) - angle * 0.5;
    (*p) = vec2<f32>(cos(newA), sin(newA)) * r;
    // For odd # of repetitions, fix cell index in -x direction
    if abs(c) >= (repetitions * 0.5) {
        c = abs(c);
    }
    return c;
}

// // 2D repeat
// fn pMod2(p: ptr<function, vec2<f32>>, size: vec2<f32>) -> vec2<f32> {
//     let halfSize = size * 0.5;
//     let c = floor(((*p) + halfSize) / size);
//     (*p) = modF((*p) + halfSize, size) - halfSize;
//     return c;
// }

// // Mirror every second cell so boundaries match
// fn pModMirror2(p: ptr<function, vec2<f32>>, size: vec2<f32>) -> vec2<f32> {
//     let halfSize = size * 0.5;
//     let c = floor(((*p) + halfSize) / size);
//     let t = modF((*p) + halfSize, size) - halfSize;
//     let mirrorFactor = select(vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, -1.0),(c % vec2<f32>(2.0, 2.0)) != vec2<f32>(0.0, 0.0));
//     (*p) = t * mirrorFactor;
//     return c;
// }

// // Combined mirroring
// fn pModGrid2(p: ptr<function, vec2<f32>>, size: vec2<f32>) -> vec2<f32> {
//     // Original version from your snippet
//     let halfSize = size * 0.5;
//     var c = floor(((*p) + halfSize) / size);
//     (*p) = modF((*p) + halfSize, size) - halfSize;
//     (*p) = (*p)
//         * (select(vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, -1.0),(c % vec2<f32>(2.0, 2.0)) != vec2<f32>(0.0, 0.0)))
//         * 2.0
//         - vec2<f32>(1.0, 1.0);

//     // subtract size / 2.0
//     (*p) = (*p) - halfSize;
//     if ((*p).x > (*p).y) {
//         (*p) = vec2<f32>((*p).y,(*p).x);
//     }
//     return floor(c / 2.0);
// }

// 3D repeat
fn pMod3(p: ptr<function, vec3<f32>>, size: vec3<f32>) -> vec3<f32> {
    let halfSize = size * 0.5;
    let c = floor(((*p) + halfSize) / size);
    (*p) = vec3<f32>(modF((*p).x + halfSize.x, size.x) - halfSize.x, modF((*p).y + halfSize.y, size.y) - halfSize.y, modF((*p).z + halfSize.z, size.z) - halfSize.z);
    return c;
}

// Mirror at axis-aligned plane
fn pMirror(p: ptr<function, f32>, dist: f32) -> f32 {
    let s = sgn((*p));
    (*p) = abs((*p)) - dist;
    return s;
}

// Mirror in both dims & diagonal => one eighth of space
fn pMirrorOctant(p: ptr<function, vec2<f32>>, dist: vec2<f32>) -> vec2<f32> {
    let s = sgnVec2((*p));
    (*p).x = abs((*p).x) - dist.x;
    (*p).y = abs((*p).y) - dist.y;
    if ((*p).y > (*p).x) {
        (*p) = (*p).yx;
    }
    return s;
}

// Reflect space at plane
fn pReflect(p: ptr<function, vec3<f32>>, planeNormal: vec3<f32>, offset: f32) -> f32 {
    let t = dot((*p), planeNormal) + offset;
    if t < 0.0 {
        (*p) = (*p) - 2.0 * t * planeNormal;
    }
    return sgn(t);
}

////////////////////////////////////
//  OBJECT COMBINATION OPERATORS
////////////////////////////////////

// Chamfer
fn fOpUnionChamfer(a: f32, b: f32, r: f32) -> f32 {
    return min(min(a, b),(a - r + b) * sqrt(0.5));
}
fn fOpIntersectionChamfer(a: f32, b: f32, r: f32) -> f32 {
    return max(max(a, b),(a + r + b) * sqrt(0.5));
}
fn fOpDifferenceChamfer(a: f32, b: f32, r: f32) -> f32 {
    return fOpIntersectionChamfer(a, -b, r);
}

// Round
fn fOpUnionRound(a: f32, b: f32, r: f32) -> f32 {
    let u = max(vec2<f32>(r - a, r - b), vec2<f32>(0.0, 0.0));
    return max(r, min(a, b)) - length(u);
}
fn fOpUnionSoft(a:f32, b:f32, r:f32) -> f32 {
	let e = max(r - abs(a - b), 0);
	return min(a, b) - e*e*0.25/r;
}
fn fOpIntersectionRound(a: f32, b: f32, r: f32) -> f32 {
    let u = max(vec2<f32>(r + a, r + b), vec2<f32>(0.0, 0.0));
    return min(-r, max(a, b)) + length(u);
}
fn fOpDifferenceRound(a: f32, b: f32, r: f32) -> f32 {
    return fOpIntersectionRound(a, -b, r);
}

// Columns
fn fOpUnionColumns(a: f32, b: f32, r: f32, n: f32) -> f32 {
    if (a < r) && (b < r) {
        var p = vec2<f32>(a, b);
        let columnradius = r * sqrt(2.0) / ((n - 1.0) * 2.0 + sqrt(2.0));
        // rotate by 45
        let tmp = p + vec2<f32>(p.y, -p.x);
        p = tmp * sqrt(0.5);
        p.x = p.x - sqrt(0.5) * r + columnradius * sqrt(2.0);
        if (n % 2.0) != 0.0 {
            p.y = p.y + columnradius;
        }
        let py = modF(p.y, columnradius * 2.0);
        let dist = length(vec2<f32>(p.x, py)) - columnradius;
        let res = min(min(dist, p.x), a);
        return min(res, b);
    }
    return min(a, b);
}

fn fOpDifferenceColumns(aIn: f32, b: f32, r: f32, n: f32) -> f32 {
    let a = -aIn;
    let m = min(a, b);
    if (a < r) && (b < r) {
        var p = vec2<f32>(a, b);
        let columnradius = r * sqrt(2.0) / ((n - 1.0) * 2.0 + sqrt(2.0));
        // rotate by 45
        let tmp = p + vec2<f32>(p.y, -p.x);
        p = tmp * sqrt(0.5);
        p.y = p.y + columnradius;
        p.x = p.x - sqrt(0.5) * r - columnradius * sqrt(2.0) * 0.5;
        if (n % 2.0) != 0.0 {
            p.y = p.y + columnradius;
        }
        let py = modF(p.y, columnradius * 2.0);
        let res = min(max(-length(vec2<f32>(p.x, py)) + columnradius, p.x), a);
        return -min(res, b);
    }
    return -m;
}
fn fOpIntersectionColumns(a: f32, b: f32, r: f32, n: f32) -> f32 {
    return fOpDifferenceColumns(a, -b, r, n);
}

// Stairs
fn fOpUnionStairs(a: f32, b: f32, r: f32, n: f32) -> f32 {
    let s = r / n;
    let u = b - r;
    return min(min(a, b), 0.5 * (u + a + abs(modF(u - a + s, 2.0 * s) - s)));
}
fn fOpIntersectionStairs(a: f32, b: f32, r: f32, n: f32) -> f32 {
    return -fOpUnionStairs(-a, -b, r, n);
}
fn fOpDifferenceStairs(a: f32, b: f32, r: f32, n: f32) -> f32 {
    return -fOpUnionStairs(-a, b, r, n);
}

// Pipe (cylindrical hole at intersection)
fn fOpPipe(a: f32, b: f32, r: f32) -> f32 {
    return length(vec2<f32>(a, b)) - r;
}

// Engrave
fn fOpEngrave(a: f32, b: f32, r: f32) -> f32 {
    return max(a,(a + r - abs(b)) * sqrt(0.5));
}

// Carpenter groove
fn fOpGroove(a: f32, b: f32, ra: f32, rb: f32) -> f32 {
    return max(a, min(a + ra, rb - abs(b)));
}

// Carpenter tongue
fn fOpTongue(a: f32, b: f32, ra: f32, rb: f32) -> f32 {
    return min(a, max(a - ra, abs(b) - rb));
}

////////////////////////////////////////////////////
//  FAST PRIMITIVES & OPERATORS (vec2f: d, g only)
//  Used during ray marching where normals/IDs are not needed.
////////////////////////////////////////////////////

// Fast sphere: exact field, exact march step.
fn fSphereFast(p: vec3<f32>, r: f32) -> FastSDFResult {
    return sdfFast(length(p) - r, 1.0, 1.0);
}

// Fast box: exact field, exact march step.
fn fBoxFast(p: vec3<f32>, b: vec3<f32>) -> FastSDFResult {
    let d = abs(p) - b;
    return sdfFast(length(max(d, vec3<f32>(0.0))) + vmax3(min(d, vec3<f32>(0.0))), 1.0, 1.0);
}

fn fCylinderFast(p: vec3<f32>, r: f32, height: f32) -> FastSDFResult {
    return sdfFast(fCylinder(p, r, height), 1.0, 1.0);
}

fn fConeFast(p: vec3<f32>, radius: f32, height: f32) -> FastSDFResult {
    return sdfFast(fCone(p, radius, height), 1.0, 1.0);
}

fn fTorusFast(p: vec3<f32>, smallRadius: f32, largeRadius: f32) -> FastSDFResult {
    return sdfFast(fTorus(p, smallRadius, largeRadius), 1.0, 1.0);
}

fn fCapsuleFast(p: vec3<f32>, r: f32, c: f32) -> FastSDFResult {
    return sdfFast(fCapsule(p, r, c), 1.0, 1.0);
}

fn fPlaneFast(p: vec3<f32>, n: vec3<f32>, distanceFromOrigin: f32) -> FastSDFResult {
    return sdfFast(fPlane(p, n, distanceFromOrigin), 1.0, 1.0);
}

fn fHexagonCircumcircleFast(p: vec3<f32>, h: vec2<f32>) -> FastSDFResult {
    return sdfFast(fHexagonCircumcircle(p, h), 1.0, 1.0);
}

fn fDiscFast(p: vec3<f32>, r: f32) -> FastSDFResult {
    return sdfFast(fDisc(p, r), 1.0, 1.0);
}

fn fBlobFast(p: vec3<f32>) -> FastSDFResult {
    return sdfFast(fBlob(p), 1.0, 1.0);
}

// Fast hard union: just pick min distance, no tie-breaking or normals
fn opUnionFast(a: FastSDFResult, b: FastSDFResult) -> FastSDFResult {
    return selectFast(b, a, a.d < b.d);
}

// Fast hard intersection: just pick max distance
fn opIntersectionFast(a: FastSDFResult, b: FastSDFResult) -> FastSDFResult {
    return selectFast(b, a, a.d > b.d);
}

// Fast hard difference: intersection with complement
fn opDifferenceFast(a: FastSDFResult, b: FastSDFResult) -> FastSDFResult {
    return opIntersectionFast(a, sdfFastNeg(b));
}

// Fast round union: distance + gradient only, no normal blending.
// Gradient magnitude in the blend region: the round min formula d = r - |u| has
// Lipschitz constant sqrt(2) (worst case when operand gradients are aligned), so
// the safe step multiplier is 1/sqrt(2). This is tighter than the previous 0.5.
fn fOpUnionRoundFast(a: FastSDFResult, b: FastSDFResult, r: f32) -> FastSDFResult {
    let u = max(vec2f(r - a.d, r - b.d), vec2f(0.0));
    let d = max(r, min(a.d, b.d)) - length(u);
    let inBlend = a.d < r && b.d < r;
    let gradMag = select(select(b.g, a.g, a.d < b.d), INVERSESQRT2 * min(a.g, b.g), inBlend);
    let safeStepMul = select(select(b.safeStepMul, a.safeStepMul, a.d < b.d), INVERSESQRT2 * min(a.safeStepMul, b.safeStepMul), inBlend);
    return sdfFast(d, gradMag, safeStepMul);
}

// Fast soft union.
// The polynomial smooth min d = min(a,b) - e²/(4r) has gradient that is a convex
// combination of the operand gradients: ∇d = ∇a·(1-e/2r) + ∇b·(e/2r).
// This means |∇d| ≤ max(|∇a|, |∇b|) ≤ 1 — it is Lipschitz-1, so g can be the
// operand gradient (no additional reduction needed).
fn fOpUnionSoftFast(a: FastSDFResult, b: FastSDFResult, r: f32) -> FastSDFResult {
    let e = max(r - abs(a.d - b.d), 0.0);
    let d = min(a.d, b.d) - e * e * 0.25 / r;
    let inBlend = e > 0.0;
    let gradMag = select(select(b.g, a.g, a.d < b.d), min(a.g, b.g), inBlend);
    let safeStepMul = select(select(b.safeStepMul, a.safeStepMul, a.d < b.d), min(a.safeStepMul, b.safeStepMul), inBlend);
    return sdfFast(d, gradMag, safeStepMul);
}

// Fast round intersection.
// Same Lipschitz analysis as round union (sqrt(2) worst case).
fn fOpIntersectionRoundFast(a: FastSDFResult, b: FastSDFResult, r: f32) -> FastSDFResult {
    let u = max(vec2f(r + a.d, r + b.d), vec2f(0.0));
    let d = min(-r, max(a.d, b.d)) + length(u);
    let inBlend = a.d > -r && b.d > -r;
    let gradMag = select(select(b.g, a.g, a.d > b.d), INVERSESQRT2 * min(a.g, b.g), inBlend);
    let safeStepMul = select(select(b.safeStepMul, a.safeStepMul, a.d > b.d), INVERSESQRT2 * min(a.safeStepMul, b.safeStepMul), inBlend);
    return sdfFast(d, gradMag, safeStepMul);
}

// Fast round difference
fn fOpDifferenceRoundFast(a: FastSDFResult, b: FastSDFResult, r: f32) -> FastSDFResult {
    return fOpIntersectionRoundFast(a, sdfFastNeg(b), r);
}

// Fast chamfer union.
// Chamfer gradient is (∇a + ∇b)/√2, with |∇d| ≤ √2 (Lipschitz-√2).
fn fOpUnionChamferFast(a: FastSDFResult, b: FastSDFResult, r: f32) -> FastSDFResult {
    let chamferD = (a.d - r + b.d) * sqrt(0.5);
    let d = min(min(a.d, b.d), chamferD);
    let inChamfer = chamferD < a.d && chamferD < b.d;
    let gradMag = select(select(b.g, a.g, a.d < b.d), INVERSESQRT2 * min(a.g, b.g), inChamfer);
    let safeStepMul = select(select(b.safeStepMul, a.safeStepMul, a.d < b.d), INVERSESQRT2 * min(a.safeStepMul, b.safeStepMul), inChamfer);
    return sdfFast(d, gradMag, safeStepMul);
}

// Fast chamfer intersection.
fn fOpIntersectionChamferFast(a: FastSDFResult, b: FastSDFResult, r: f32) -> FastSDFResult {
    let chamferD = (a.d + r + b.d) * sqrt(0.5);
    let d = max(max(a.d, b.d), chamferD);
    let inChamfer = chamferD > a.d && chamferD > b.d;
    let gradMag = select(select(b.g, a.g, a.d > b.d), INVERSESQRT2 * min(a.g, b.g), inChamfer);
    let safeStepMul = select(select(b.safeStepMul, a.safeStepMul, a.d > b.d), INVERSESQRT2 * min(a.safeStepMul, b.safeStepMul), inChamfer);
    return sdfFast(d, gradMag, safeStepMul);
}

// Fast chamfer difference
fn fOpDifferenceChamferFast(a: FastSDFResult, b: FastSDFResult, r: f32) -> FastSDFResult {
    return fOpIntersectionChamferFast(a, sdfFastNeg(b), r);
}

// Fast columns union
fn fOpUnionColumnsFast(a: FastSDFResult, b: FastSDFResult, r: f32, n: f32) -> FastSDFResult {
    if (a.d < r) && (b.d < r) {
        var p = vec2f(a.d, b.d);
        let columnradius = r * sqrt(2.0) / ((n - 1.0) * 2.0 + sqrt(2.0));
        let tmp = p + vec2f(p.y, -p.x);
        p = tmp * sqrt(0.5);
        p.x = p.x - sqrt(0.5) * r + columnradius * sqrt(2.0);
        if (n % 2.0) != 0.0 {
            p.y = p.y + columnradius;
        }
        let py = modF(p.y, columnradius * 2.0);
        let dist = length(vec2f(p.x, py)) - columnradius;
        let d = min(min(dist, p.x), a.d);
        return sdfFast(min(d, b.d), 1.0, 1.0);
    }
    return selectFast(b, a, a.d < b.d);
}

// Fast columns difference
// Soft-clamp: allow column protrusions up to columnradius beyond the hard surface,
// but prevent unbounded overestimation far from the surface that breaks ray marching.
fn fOpDifferenceColumnsFast(aIn: FastSDFResult, b: FastSDFResult, r: f32, n: f32) -> FastSDFResult {
    let a = -aIn.d;
    let hardD = -min(a, b.d);  // standard hard difference = max(aIn.d, -b.d)
    if (a < r) && (b.d < r) {
        let columnradius = r * sqrt(2.0) / ((n - 1.0) * 2.0 + sqrt(2.0));
        var p = vec2f(a, b.d);
        let tmp = p + vec2f(p.y, -p.x);
        p = tmp * sqrt(0.5);
        p.y = p.y + columnradius;
        p.x = p.x - sqrt(0.5) * r - columnradius * sqrt(2.0) * 0.5;
        if (n % 2.0) != 0.0 {
            p.y = p.y + columnradius;
        }
        let py = modF(p.y, columnradius * 2.0);
        let res = min(max(-length(vec2f(p.x, py)) + columnradius, p.x), a);
        let colD = -min(res, b.d);
        // Bound overshoot to columnradius — prevents massive overestimation far from surface
        // while preserving column geometry near the surface where colD < hardD + columnradius.
        return sdfFast(min(colD, hardD + columnradius), 1.0, 1.0);
    }
    return sdfFast(hardD, select(b.g, aIn.g, a < b.d), select(b.safeStepMul, aIn.safeStepMul, a < b.d));
}

// Fast columns intersection
fn fOpIntersectionColumnsFast(a: FastSDFResult, b: FastSDFResult, r: f32, n: f32) -> FastSDFResult {
    return fOpDifferenceColumnsFast(a, sdfFastNeg(b), r, n);
}

// Fast stairs union
fn fOpUnionStairsFast(a: FastSDFResult, b: FastSDFResult, r: f32, n: f32) -> FastSDFResult {
    let s = r / n;
    let u = b.d - r;
    let stairD = 0.5 * (u + a.d + abs(modF(u - a.d + s, 2.0 * s) - s));
    let d = min(min(a.d, b.d), stairD);
    let inStair = stairD < a.d && stairD < b.d;
    let gradMag = select(select(b.g, a.g, a.d < b.d), INVERSESQRT2 * min(a.g, b.g), inStair);
    let safeStepMul = select(select(b.safeStepMul, a.safeStepMul, a.d < b.d), INVERSESQRT2 * min(a.safeStepMul, b.safeStepMul), inStair);
    return sdfFast(d, gradMag, safeStepMul);
}

// Fast stairs intersection
fn fOpIntersectionStairsFast(a: FastSDFResult, b: FastSDFResult, r: f32, n: f32) -> FastSDFResult {
    let result = fOpUnionStairsFast(sdfFastNeg(a), sdfFastNeg(b), r, n);
    return sdfFast(-result.d, result.g, result.safeStepMul);
}

// Fast stairs difference
fn fOpDifferenceStairsFast(a: FastSDFResult, b: FastSDFResult, r: f32, n: f32) -> FastSDFResult {
    let result = fOpUnionStairsFast(sdfFastNeg(a), b, r, n);
    return sdfFast(-result.d, result.g, result.safeStepMul);
}

// Fast pipe (cylindrical hole at intersection)
// The pipe SDF length(a,b)-r can overestimate 3D distance by up to sqrt(2)
// when the two input gradients are parallel.  Scale by 1/sqrt(2) to guarantee
// conservative steps.  No clamp discontinuity, just uniformly smaller steps.
fn fOpPipeFast(a: FastSDFResult, b: FastSDFResult, r: f32) -> FastSDFResult {
    return sdfFast((length(vec2f(a.d, b.d)) - r) * INVERSESQRT2, 1.0, 1.0);
}

// Fast engrave
fn fOpEngraveFast(a: FastSDFResult, b: FastSDFResult, r: f32) -> FastSDFResult {
    let engraveD = (a.d + r - abs(b.d)) * sqrt(0.5);
    let d = max(a.d, engraveD);
    let gradMag = select(a.g, 1.0, engraveD > a.d);
    let safeStepMul = select(a.safeStepMul, 1.0, engraveD > a.d);
    return sdfFast(d, gradMag, safeStepMul);
}

// Fast groove
fn fOpGrooveFast(a: FastSDFResult, b: FastSDFResult, ra: f32, rb: f32) -> FastSDFResult {
    let grooveD = min(a.d + ra, rb - abs(b.d));
    let d = max(a.d, grooveD);
    let gradMag = select(a.g, 1.0, grooveD > a.d);
    let safeStepMul = select(a.safeStepMul, 1.0, grooveD > a.d);
    return sdfFast(d, gradMag, safeStepMul);
}

// Fast tongue
fn fOpTongueFast(a: FastSDFResult, b: FastSDFResult, ra: f32, rb: f32) -> FastSDFResult {
    let tongueD = max(a.d - ra, abs(b.d) - rb);
    let d = min(a.d, tongueD);
    let gradMag = select(a.g, 1.0, tongueD < a.d);
    let safeStepMul = select(a.safeStepMul, 1.0, tongueD < a.d);
    return sdfFast(d, gradMag, safeStepMul);
}

////////////////////////////////////////////////////
//  MID OPERATORS (SDFResultMid: d, g, n — no IDs, blend, seam)
////////////////////////////////////////////////////

// Hard union Mid: pick by distance, blend normals when coplanar
fn opUnionMid(a: SDFResultMid, b: SDFResultMid) -> SDFResultMid {
    if (abs(a.d - b.d) < SURF_DIST) {
        let n = safeNormalize(a.n + b.n, a.n);
        if (dot(a.n, b.n) < MID_FEATURE_SEAM_COS_THRESH) {
            return sdfRMidSeam(min(a.d, b.d), min(a.g, b.g), n, midPrimaryOwner(a), midPrimaryOwner(b), a.n, b.n, abs(a.d - b.d));
        }
        return sdfRMidOwned(min(a.d, b.d), min(a.g, b.g), n, midPrimaryOwner(a), midPrimaryOwner(b));
    }
    return selectMid(b, a, a.d < b.d);
}

// Hard intersection Mid
fn opIntersectionMid(a: SDFResultMid, b: SDFResultMid) -> SDFResultMid {
    if (abs(a.d - b.d) < SURF_DIST) {
        let n = safeNormalize(a.n + b.n, a.n);
        if (dot(a.n, b.n) < MID_FEATURE_SEAM_COS_THRESH) {
            return sdfRMidSeam(max(a.d, b.d), min(a.g, b.g), n, midPrimaryOwner(a), midPrimaryOwner(b), a.n, b.n, abs(a.d - b.d));
        }
        return sdfRMidOwned(max(a.d, b.d), min(a.g, b.g), n, midPrimaryOwner(a), midPrimaryOwner(b));
    }
    return selectMid(b, a, a.d > b.d);
}

// Hard difference Mid
fn opDifferenceMid(a: SDFResultMid, b: SDFResultMid) -> SDFResultMid {
    let negB = sdfNegMid(b);
    if (abs(a.d - negB.d) < SURF_DIST) {
        let n = safeNormalize(a.n + negB.n, a.n);
        if (dot(a.n, negB.n) < MID_FEATURE_SEAM_COS_THRESH) {
            return sdfRMidSeam(max(a.d, negB.d), min(a.g, negB.g), n, midPrimaryOwner(a), midPrimaryOwner(negB), a.n, negB.n, abs(a.d - negB.d));
        }
        return sdfRMidOwned(max(a.d, negB.d), min(a.g, negB.g), n, midPrimaryOwner(a), midPrimaryOwner(negB));
    }
    return selectMid(negB, a, a.d > negB.d);
}

// Chamfer union Mid
fn fOpUnionChamferMid(a: SDFResultMid, b: SDFResultMid, r: f32) -> SDFResultMid {
    let chamferD = (a.d - r + b.d) * sqrt(0.5);
    let d = min(min(a.d, b.d), chamferD);
    if (chamferD < a.d && chamferD < b.d) {
        let n = normalize(a.n + b.n);
        return sdfRMidOwned(d, 1.0, n, midPrimaryOwner(a), midPrimaryOwner(b));
    }
    return selectMid(b, a, a.d < b.d);
}

fn fOpIntersectionChamferMid(a: SDFResultMid, b: SDFResultMid, r: f32) -> SDFResultMid {
    let chamferD = (a.d + r + b.d) * sqrt(0.5);
    let d = max(max(a.d, b.d), chamferD);
    if (chamferD > a.d && chamferD > b.d) {
        let n = normalize(a.n + b.n);
        return sdfRMidOwned(d, 1.0, n, midPrimaryOwner(a), midPrimaryOwner(b));
    }
    return selectMid(b, a, a.d > b.d);
}

fn fOpDifferenceChamferMid(a: SDFResultMid, b: SDFResultMid, r: f32) -> SDFResultMid {
    return fOpIntersectionChamferMid(a, sdfNegMid(b), r);
}

// Round union Mid
fn fOpUnionRoundMid(a: SDFResultMid, b: SDFResultMid, r: f32) -> SDFResultMid {
    let u = max(vec2f(r - a.d, r - b.d), vec2f(0.0));
    let d = max(r, min(a.d, b.d)) - length(u);
    if (a.d < r && b.d < r) {
        let n = normalize(a.n * u.x + b.n * u.y);
        return sdfRMidOwned(d, INVERSESQRT2 * min(a.g, b.g), n, midPrimaryOwner(a), midPrimaryOwner(b));
    }
    return selectMid(b, a, a.d < b.d);
}

fn fOpUnionSoftMid(a: SDFResultMid, b: SDFResultMid, r: f32) -> SDFResultMid {
    let e = max(r - abs(a.d - b.d), 0.0);
    let d = min(a.d, b.d) - e * e * 0.25 / r;
    if (e > 0.0) {
        let n = normalize(a.n * (r - a.d) + b.n * (r - b.d));
        return sdfRMidOwned(d, min(a.g, b.g), n, midPrimaryOwner(a), midPrimaryOwner(b));
    }
    return selectMid(b, a, a.d < b.d);
}

fn fOpIntersectionRoundMid(a: SDFResultMid, b: SDFResultMid, r: f32) -> SDFResultMid {
    let u = max(vec2f(r + a.d, r + b.d), vec2f(0.0));
    let d = min(-r, max(a.d, b.d)) + length(u);
    if (a.d > -r && b.d > -r) {
        let n = normalize(a.n * u.x + b.n * u.y);
        return sdfRMidOwned(d, INVERSESQRT2 * min(a.g, b.g), n, midPrimaryOwner(a), midPrimaryOwner(b));
    }
    return selectMid(b, a, a.d > b.d);
}

fn fOpDifferenceRoundMid(a: SDFResultMid, b: SDFResultMid, r: f32) -> SDFResultMid {
    return fOpIntersectionRoundMid(a, sdfNegMid(b), r);
}

// Columns union Mid
fn fOpUnionColumnsMid(a: SDFResultMid, b: SDFResultMid, r: f32, n: f32) -> SDFResultMid {
    if (a.d < r) && (b.d < r) {
        var p = vec2f(a.d, b.d);
        let columnradius = r * sqrt(2.0) / ((n - 1.0) * 2.0 + sqrt(2.0));
        let tmp = p + vec2f(p.y, -p.x);
        p = tmp * sqrt(0.5);
        p.x = p.x - sqrt(0.5) * r + columnradius * sqrt(2.0);
        if (n % 2.0) != 0.0 {
            p.y = p.y + columnradius;
        }
        let py = modF(p.y, columnradius * 2.0);
        let dist = length(vec2f(p.x, py)) - columnradius;
        let res = min(min(dist, p.x), a.d);
        let d = min(res, b.d);
        let wa = r - a.d;
        let wb = r - b.d;
        let blendN = safeNormalize(a.n * wa + b.n * wb, a.n);
        return sdfRMidOwned(d, 1.0, blendN, midPrimaryOwner(a), midPrimaryOwner(b));
    }
    return selectMid(b, a, a.d < b.d);
}

fn fOpDifferenceColumnsMid(aIn: SDFResultMid, b: SDFResultMid, r: f32, n: f32) -> SDFResultMid {
    let aD = -aIn.d;
    if (aD < r) && (b.d < r) {
        var p = vec2f(aD, b.d);
        let columnradius = r * sqrt(2.0) / ((n - 1.0) * 2.0 + sqrt(2.0));
        let tmp = p + vec2f(p.y, -p.x);
        p = tmp * sqrt(0.5);
        p.y = p.y + columnradius;
        p.x = p.x - sqrt(0.5) * r - columnradius * sqrt(2.0) * 0.5;
        if (n % 2.0) != 0.0 {
            p.y = p.y + columnradius;
        }
        let py = modF(p.y, columnradius * 2.0);
        let res = min(max(-length(vec2f(p.x, py)) + columnradius, p.x), aD);
        let d = -min(res, b.d);
        let wa = r + aIn.d;
        let wb = r - b.d;
        let blendN = safeNormalize(aIn.n * wa - b.n * wb, aIn.n);
        return sdfRMidOwned(d, 1.0, blendN, midPrimaryOwner(aIn), midPrimaryOwner(b));
    }
    let d = max(aIn.d, -b.d);
    return selectMid(
        sdfRMidOwned(d, b.g, -b.n, b.featureIdA, b.featureIdB),
        sdfRMidOwned(d, aIn.g, aIn.n, aIn.featureIdA, aIn.featureIdB),
        aIn.d > -b.d
    );
}

fn fOpIntersectionColumnsMid(a: SDFResultMid, b: SDFResultMid, r: f32, n: f32) -> SDFResultMid {
    return fOpDifferenceColumnsMid(a, sdfNegMid(b), r, n);
}

// Stairs union Mid
fn fOpUnionStairsMid(a: SDFResultMid, b: SDFResultMid, r: f32, n: f32) -> SDFResultMid {
    let s = r / n;
    let u = b.d - r;
    let stairD = 0.5 * (u + a.d + abs(modF(u - a.d + s, 2.0 * s) - s));
    let d = min(min(a.d, b.d), stairD);
    if (a.d < r && b.d < r) {
        let wa = r - a.d;
        let wb = r - b.d;
        let blendN = safeNormalize(a.n * wa + b.n * wb, a.n);
        return sdfRMidOwned(d, 1.0, blendN, midPrimaryOwner(a), midPrimaryOwner(b));
    }
    return selectMid(b, a, a.d < b.d);
}

fn fOpIntersectionStairsMid(a: SDFResultMid, b: SDFResultMid, r: f32, n: f32) -> SDFResultMid {
    var result = fOpUnionStairsMid(sdfNegMid(a), sdfNegMid(b), r, n);
    result.d = -result.d;
    result.n = -result.n;
    return clearMidFeature(result);
}

fn fOpDifferenceStairsMid(a: SDFResultMid, b: SDFResultMid, r: f32, n: f32) -> SDFResultMid {
    var result = fOpUnionStairsMid(sdfNegMid(a), b, r, n);
    result.d = -result.d;
    result.n = -result.n;
    return clearMidFeature(result);
}

// Pipe Mid
fn fOpPipeMid(a: SDFResultMid, b: SDFResultMid, r: f32) -> SDFResultMid {
    let pipeLen = length(vec2f(a.d, b.d));
    let d = pipeLen - r;
    var blendN = a.n;
    if (pipeLen > 1e-6) {
        blendN = safeNormalize(a.n * a.d + b.n * b.d, a.n);
    }
    return sdfRMidOwned(d, 1.0, blendN, midPrimaryOwner(a), midPrimaryOwner(b));
}

// Engrave Mid
fn fOpEngraveMid(a: SDFResultMid, b: SDFResultMid, r: f32) -> SDFResultMid {
    let engraveD = (a.d + r - abs(b.d)) * sqrt(0.5);
    let d = max(a.d, engraveD);
    if (engraveD > a.d) {
        let blendN = safeNormalize(a.n - sgn(b.d) * b.n, a.n);
        return sdfRMidOwned(d, 1.0, blendN, midPrimaryOwner(a), midPrimaryOwner(b));
    }
    return sdfRMidOwned(d, a.g, a.n, a.featureIdA, a.featureIdB);
}

// Groove Mid
fn fOpGrooveMid(a: SDFResultMid, b: SDFResultMid, ra: f32, rb: f32) -> SDFResultMid {
    let depthD = a.d + ra;
    let widthD = rb - abs(b.d);
    let grooveD = min(depthD, widthD);
    let d = max(a.d, grooveD);
    if (grooveD > a.d) {
        if (depthD < widthD) {
            return sdfRMidOwned(d, 1.0, a.n, a.featureIdA, a.featureIdB);
        }
        return sdfRMidOwned(d, 1.0, -sgn(b.d) * b.n, b.featureIdA, b.featureIdB);
    }
    return sdfRMidOwned(d, a.g, a.n, a.featureIdA, a.featureIdB);
}

// Tongue Mid
fn fOpTongueMid(a: SDFResultMid, b: SDFResultMid, ra: f32, rb: f32) -> SDFResultMid {
    let depthD = a.d - ra;
    let widthD = abs(b.d) - rb;
    let tongueD = max(depthD, widthD);
    let d = min(a.d, tongueD);
    if (tongueD < a.d) {
        if (depthD > widthD) {
            return sdfRMidOwned(d, 1.0, a.n, a.featureIdA, a.featureIdB);
        }
        return sdfRMidOwned(d, 1.0, sgn(b.d) * b.n, b.featureIdA, b.featureIdB);
    }
    return sdfRMidOwned(d, a.g, a.n, a.featureIdA, a.featureIdB);
}

////////////////////////////////////////////////////
//  DOMAIN TRANSFORM HELPERS (SDFResult)
////////////////////////////////////////////////////

// Rotate the normal of an SDFResult by a forward rotation matrix.
// Used after evaluating a child SDF in a rotated coordinate system.
fn sdfRotateNormal(r: SDFResult, m: mat3x3f) -> SDFResult {
    var out = r;
    out.n = safeNormalize(m * out.n, out.n);
    return out;
}

// Rotate the normal of an SDFResultMid by a forward rotation matrix.
fn sdfRotateNormalMid(r: SDFResultMid, m: mat3x3f) -> SDFResultMid {
    var out = r;
    out.n = safeNormalize(m * out.n, out.n);
    return sdfRotateFeatureMid(out, m);
}

// Scale: evaluate child at p/s; distance scaled by min(|s|) (conservative for non-uniform scale).
fn sdfScaleFast(r: FastSDFResult, s: vec3f) -> FastSDFResult {
    let m = min(abs(s.x), min(abs(s.y), abs(s.z)));
    return sdfFast(r.d * m, r.g, r.safeStepMul);
}

fn sdfScaleNormal(r: SDFResult, s: vec3f) -> SDFResult {
    var out = r;
    let m = min(abs(s.x), min(abs(s.y), abs(s.z)));
    out.d = r.d * m;
    let invs = vec3f(1.0 / s.x, 1.0 / s.y, 1.0 / s.z);
    let scaledN = r.n * invs;
    out.n = safeNormalize(scaledN, r.n);
    out.g = r.g * m * length(scaledN);
    return out;
}

fn sdfScaleNormalMid(r: SDFResultMid, s: vec3f) -> SDFResultMid {
    var out = r;
    let m = min(abs(s.x), min(abs(s.y), abs(s.z)));
    out.d = r.d * m;
    let invs = vec3f(1.0 / s.x, 1.0 / s.y, 1.0 / s.z);
    let scaledN = r.n * invs;
    out.n = safeNormalize(scaledN, r.n);
    out.g = r.g * m * length(scaledN);
    return sdfScaleFeatureMid(out, s);
}

////////////////////////////////////////////////////
//  UNARY SDF MODIFIERS (Shell, Offset)
////////////////////////////////////////////////////

// Shell Fast: hollow out a shape to a thin wall of given thickness
fn sdfShellFast(a: FastSDFResult, thickness: f32) -> FastSDFResult {
    return sdfFast(abs(a.d) - thickness, a.g, a.safeStepMul);
}

// Shell Ex: flip normal when evaluating the interior side
fn sdfShellEx(a: SDFResult, thickness: f32) -> SDFResult {
    var out = a;
    out.d = abs(a.d) - thickness;
    if (a.d < 0.0) {
        out.n = -out.n;
    }
    return out;
}

// Offset Fast: grow (positive) or shrink (negative) a shape uniformly
fn sdfOffsetFast(a: FastSDFResult, amount: f32) -> FastSDFResult {
    return sdfFast(a.d - amount, a.g, a.safeStepMul);
}

// Offset Ex: shift distance, normals unchanged
fn sdfOffsetEx(a: SDFResult, amount: f32) -> SDFResult {
    var out = a;
    out.d = a.d - amount;
    return out;
}

// Shell Mid: hollow out a shape, flip normal when interior
fn sdfShellMid(a: SDFResultMid, thickness: f32) -> SDFResultMid {
    var out = a;
    out.d = abs(a.d) - thickness;
    if (a.d < 0.0) {
        out.n = -out.n;
    }
    return clearMidFeature(out);
}

// Offset Mid: shift distance, normals unchanged
fn sdfOffsetMid(a: SDFResultMid, amount: f32) -> SDFResultMid {
    var out = a;
    out.d = a.d - amount;
    return clearMidFeature(out);
}

////////////////////////////////////////////////////
//  DOMAIN TRANSFORM HELPERS (Elongate, Twist, Bend, Taper)
////////////////////////////////////////////////////

// Elongate: clamp point to box [-h, h], stretching shape along axes
fn elongatePoint(p: vec3f, h: vec3f) -> vec3f {
    return p - clamp(p, -h, h);
}

// Twist: rotate XZ plane by p.y * rate (radians per unit Y)
fn twistPoint(p: vec3f, rate: f32) -> vec3f {
    let a = p.y * rate;
    let c = cos(a);
    let s = sin(a);
    return vec3f(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}

// Twist Fast: correct gradient overestimation from non-uniform domain distortion.
// The twist stretches space by sqrt(1 + (rate * rho)^2) where rho = length(p.xz).
// Divide distance by this factor to keep ray marching conservative.
fn sdfTwistFast(r: FastSDFResult, p: vec3f, rate: f32) -> FastSDFResult {
    let rho = length(p.xz);
    let stretch = sqrt(1.0 + rate * rate * rho * rho);
    return sdfFast(r.d / stretch, r.g * stretch, r.safeStepMul);
}

// Twist Ex: untwist the normal back to world space at the original point p.
// Apply inverse twist (negative angle) to the child's normal.
fn sdfTwistNormal(r: SDFResult, p: vec3f, rate: f32) -> SDFResult {
    var out = r;
    let a = -(p.y * rate);
    let c = cos(a);
    let s = sin(a);
    let rho = length(p.xz);
    let stretch = sqrt(1.0 + rate * rate * rho * rho);
    out.n = safeNormalize(vec3f(c * out.n.x + s * out.n.z, out.n.y, -s * out.n.x + c * out.n.z), out.n);
    out.g = out.g * stretch;
    return out;
}

// Twist Mid: untwist the normal back to world space
fn sdfTwistNormalMid(r: SDFResultMid, p: vec3f, rate: f32) -> SDFResultMid {
    var out = r;
    let a = -(p.y * rate);
    let c = cos(a);
    let s = sin(a);
    let rho = length(p.xz);
    let stretch = sqrt(1.0 + rate * rate * rho * rho);
    out.n = safeNormalize(vec3f(c * out.n.x + s * out.n.z, out.n.y, -s * out.n.x + c * out.n.z), out.n);
    out.g = out.g * stretch;
    return clearMidFeature(out);
}

// Bend: rotate XY plane by p.x * amount (cheap bend, iq)
fn bendPoint(p: vec3f, amount: f32) -> vec3f {
    let a = amount * p.x;
    let c = cos(a);
    let s = sin(a);
    return vec3f(c * p.x - s * p.y, s * p.x + c * p.y, p.z);
}

// Bend Fast: correct gradient overestimation.
// Same principle as twist but in XY plane: stretch = sqrt(1 + (amount * |p.y|)^2).
fn sdfBendFast(r: FastSDFResult, p: vec3f, amount: f32) -> FastSDFResult {
    let stretch = sqrt(1.0 + amount * amount * p.y * p.y);
    return sdfFast(r.d / stretch, r.g * stretch, r.safeStepMul);
}

// Bend Ex: unbend the normal back to world space at the original point p.
fn sdfBendNormal(r: SDFResult, p: vec3f, amount: f32) -> SDFResult {
    var out = r;
    let a = -(amount * p.x);
    let c = cos(a);
    let s = sin(a);
    let stretch = sqrt(1.0 + amount * amount * p.y * p.y);
    out.n = safeNormalize(vec3f(c * out.n.x - s * out.n.y, s * out.n.x + c * out.n.y, out.n.z), out.n);
    out.g = out.g * stretch;
    return out;
}

// Bend Mid: unbend the normal back to world space
fn sdfBendNormalMid(r: SDFResultMid, p: vec3f, amount: f32) -> SDFResultMid {
    var out = r;
    let a = -(amount * p.x);
    let c = cos(a);
    let s = sin(a);
    let stretch = sqrt(1.0 + amount * amount * p.y * p.y);
    out.n = safeNormalize(vec3f(c * out.n.x - s * out.n.y, s * out.n.x + c * out.n.y, out.n.z), out.n);
    out.g = out.g * stretch;
    return clearMidFeature(out);
}

// Taper: scale XZ cross-section linearly from 1.0 at y=0 to ratio at y=height
fn taperPoint(p: vec3f, ratio: f32, height: f32) -> vec3f {
    let t = clamp(p.y / height, 0.0, 1.0);
    let s = 1.0 + (ratio - 1.0) * t;  // scale factor: 1.0 at y=0, ratio at y=height
    return vec3f(p.x / s, p.y, p.z / s);
}

// Taper Fast: correct gradient overestimation from non-uniform scaling.
// The taper shrinks/grows XZ by scale s.  Gradient magnitude scales as ~1/s.
// When s < 1 (narrowing), gradient > 1, distance overestimates: divide by 1/s.
fn sdfTaperFast(r: FastSDFResult, p: vec3f, ratio: f32, height: f32) -> FastSDFResult {
    let t = clamp(p.y / height, 0.0, 1.0);
    let s = 1.0 + (ratio - 1.0) * t;
    // Only correct when s < 1 (narrowing taper overestimates).
    // When s >= 1 (widening), the SDF is conservative or exact.
    let correction = min(s, 1.0);
    return sdfFast(r.d * correction, r.g / correction, r.safeStepMul);
}

// Taper Ex: correct the normal for the non-uniform scaling.
// In tapered space, the XZ components of the gradient are scaled by 1/s.
// Unscale them to get the world-space normal.
fn sdfTaperNormal(r: SDFResult, p: vec3f, ratio: f32, height: f32) -> SDFResult {
    var out = r;
    let t = clamp(p.y / height, 0.0, 1.0);
    let s = 1.0 + (ratio - 1.0) * t;
    let correction = min(s, 1.0);
    // Normal in tapered space has XZ scaled by 1/s; undo this
    out.n = safeNormalize(vec3f(out.n.x / s, out.n.y, out.n.z / s), out.n);
    out.g = out.g / correction;
    return out;
}

// Taper Mid: correct the normal for the non-uniform scaling
fn sdfTaperNormalMid(r: SDFResultMid, p: vec3f, ratio: f32, height: f32) -> SDFResultMid {
    var out = r;
    let t = clamp(p.y / height, 0.0, 1.0);
    let s = 1.0 + (ratio - 1.0) * t;
    let correction = min(s, 1.0);
    out.n = safeNormalize(vec3f(out.n.x / s, out.n.y, out.n.z / s), out.n);
    out.g = out.g / correction;
    return clearMidFeature(out);
}

////////////////////////////////////////////////////
//  BINARY SDF OPERATORS (Morph, Seam)
////////////////////////////////////////////////////

// Morph Fast: interpolate between two SDFs
fn sdfMorphFast(a: FastSDFResult, b: FastSDFResult, t: f32) -> FastSDFResult {
    return sdfFast(
        a.d * (1.0 - t) + b.d * t,
        a.g * (1.0 - t) + b.g * t,
        a.safeStepMul * (1.0 - t) + b.safeStepMul * t,
    );
}

// Morph Ex: interpolate distance, blend normals, use id/id2 for color
fn sdfMorphEx(a: SDFResult, b: SDFResult, t: f32) -> SDFResult {
    let d = a.d * (1.0 - t) + b.d * t;
    let g = a.g * (1.0 - t) + b.g * t;
    let n = safeNormalize(a.n * (1.0 - t) + b.n * t, a.n);
    let seamT = safeNormalize(cross(a.n, b.n), vec3f(0.0, 0.0, 1.0));
    if (t < 0.5) {
        return SDFResult(d, g, a.id, n, b.id, t, a.id, b.id, 0u, 1e9, seamT);
    }
    return SDFResult(d, g, b.id, n, a.id, 1.0 - t, a.id, b.id, 0u, 1e9, seamT);
}

// Seam Fast: union of both shapes plus a pipe tube at their intersection (weld bead).
// The pipe component uses INVERSESQRT2 to prevent overestimation.
fn sdfSeamFast(a: FastSDFResult, b: FastSDFResult, r: f32) -> FastSDFResult {
    let unionD = min(a.d, b.d);
    let pipeD = (length(vec2f(a.d, b.d)) - r) * INVERSESQRT2;
    let usePipe = pipeD < unionD;
    let gradMag = select(select(b.g, a.g, a.d < b.d), 0.5, usePipe);
    let safeStepMul = select(select(b.safeStepMul, a.safeStepMul, a.d < b.d), 0.5, usePipe);
    return sdfFast(min(unionD, pipeD), gradMag, safeStepMul);
}

// Seam Ex: union + pipe tube with proper normals
fn sdfSeamEx(a: SDFResult, b: SDFResult, r: f32) -> SDFResult {
    // Compute union
    let unionResult = opUnionEx(a, b);
    // Compute pipe
    let pipeLen = length(vec2f(a.d, b.d));
    let pipeD = pipeLen - r;
    // If pipe surface is closer than union, use pipe
    if (pipeD < unionResult.d) {
        var blendN = a.n;
        if (pipeLen > 1e-6) {
            blendN = safeNormalize(a.n * a.d + b.n * b.d, a.n);
        }
        if (a.id <= b.id) { return sdfR(pipeD, 1.0, a.id, blendN); }
        return sdfR(pipeD, 1.0, b.id, blendN);
    }
    return unionResult;
}

// Morph Mid: interpolate distance and normals
fn sdfMorphMid(a: SDFResultMid, b: SDFResultMid, t: f32) -> SDFResultMid {
    let d = a.d * (1.0 - t) + b.d * t;
    let g = a.g * (1.0 - t) + b.g * t;
    let n = safeNormalize(a.n * (1.0 - t) + b.n * t, a.n);
    return sdfRMidOwned(d, g, n, midPrimaryOwner(a), midPrimaryOwner(b));
}

// Seam Mid: union + pipe tube with proper normals
fn sdfSeamMid(a: SDFResultMid, b: SDFResultMid, r: f32) -> SDFResultMid {
    let unionResult = opUnionMid(a, b);
    let pipeLen = length(vec2f(a.d, b.d));
    let pipeD = pipeLen - r;
    if (pipeD < unionResult.d) {
        var blendN = a.n;
        if (pipeLen > 1e-6) {
            blendN = safeNormalize(a.n * a.d + b.n * b.d, a.n);
        }
        return sdfRMidOwned(pipeD, 1.0, blendN, midPrimaryOwner(a), midPrimaryOwner(b));
    }
    return unionResult;
}

////////////////////////////////////////////////////
//  EXTENDED OBJECT COMBINATION OPERATORS
//  These return SDFResult with accurate gradient magnitude estimates
////////////////////////////////////////////////////

// Hard union: pick the closer operand (ID tiebreaker + normal blend for coplanar surfaces)
fn opUnionEx(a: SDFResult, b: SDFResult) -> SDFResult {
    let gap = abs(a.d - b.d);
    let seamTangent = safeNormalize(cross(a.n, b.n), vec3f(0.0, 0.0, 1.0));
    let seam = bestSeam(a, b, gap, 1u, seamTangent);
    if (gap < SURF_DIST) {
        let n = normalize(a.n + b.n);
        var out = selectSDF(sdfR(b.d, b.g, b.id, n), sdfR(a.d, a.g, a.id, n), a.id <= b.id);
        applySeam(&out, seam);
        return out;
    }
    var out = selectSDF(b, a, a.d < b.d);
    applySeam(&out, seam);
    return out;
}

// Hard intersection: pick the farther operand (ID tiebreaker + normal blend for coplanar surfaces)
fn opIntersectionEx(a: SDFResult, b: SDFResult) -> SDFResult {
    let gap = abs(a.d - b.d);
    let seamTangent = safeNormalize(cross(a.n, b.n), vec3f(0.0, 0.0, 1.0));
    let seam = bestSeam(a, b, gap, 2u, seamTangent);
    if (gap < SURF_DIST) {
        let n = normalize(a.n + b.n);
        var out = selectSDF(sdfR(b.d, b.g, b.id, n), sdfR(a.d, a.g, a.id, n), a.id <= b.id);
        applySeam(&out, seam);
        return out;
    }
    var out = selectSDF(b, a, a.d > b.d);
    applySeam(&out, seam);
    return out;
}

// Hard difference: intersection with complement of b
fn opDifferenceEx(a: SDFResult, b: SDFResult) -> SDFResult {
    var out = opIntersectionEx(a, sdfNeg(b));
    if (out.seamOp == 2u) {
        out.seamOp = 3u;
    }
    return out;
}

// Chamfer union - 45° bevel between operands
fn fOpUnionChamferEx(a: SDFResult, b: SDFResult, r: f32) -> SDFResult {
    let chamferD = (a.d - r + b.d) * sqrt(0.5);
    let d = min(min(a.d, b.d), chamferD);
    let diff = abs(a.d - b.d);
    let coplanar = diff < SURF_DIST;
    let n = normalize(a.n + b.n);
    let seamT = safeNormalize(cross(a.n, b.n), vec3f(0.0, 0.0, 1.0));
    let seam = bestSeam(a, b, diff, 1u, seamT);
    var out: SDFResult;
    if (chamferD < a.d && chamferD < b.d) {
        if (coplanar || a.d < b.d) {
            out = selectSDF(sdfR(d, 1.0, b.id, n), sdfR(d, 1.0, a.id, n), coplanar && b.id < a.id);
        } else {
            out = sdfR(d, 1.0, b.id, n);
        }
    } else if (coplanar) {
        out = selectSDF(sdfR(d, b.g, b.id, n), sdfR(d, a.g, a.id, n), a.id <= b.id);
    } else {
        out = selectSDF(sdfR(d, b.g, b.id, b.n), sdfR(d, a.g, a.id, a.n), a.d < b.d);
    }
    applySeam(&out, seam);
    return out;
}

fn fOpIntersectionChamferEx(a: SDFResult, b: SDFResult, r: f32) -> SDFResult {
    let chamferD = (a.d + r + b.d) * sqrt(0.5);
    let d = max(max(a.d, b.d), chamferD);
    let diff = abs(a.d - b.d);
    let coplanar = diff < SURF_DIST;
    let n = normalize(a.n + b.n);
    let seamT = safeNormalize(cross(a.n, b.n), vec3f(0.0, 0.0, 1.0));
    let seam = bestSeam(a, b, diff, 2u, seamT);
    var out: SDFResult;
    if (chamferD > a.d && chamferD > b.d) {
        if (coplanar || a.d > b.d) {
            out = selectSDF(sdfR(d, 1.0, b.id, n), sdfR(d, 1.0, a.id, n), coplanar && b.id < a.id);
        } else {
            out = sdfR(d, 1.0, b.id, n);
        }
    } else if (coplanar) {
        out = selectSDF(sdfR(d, b.g, b.id, n), sdfR(d, a.g, a.id, n), a.id <= b.id);
    } else {
        out = selectSDF(sdfR(d, b.g, b.id, b.n), sdfR(d, a.g, a.id, a.n), a.d > b.d);
    }
    applySeam(&out, seam);
    return out;
}

fn fOpDifferenceChamferEx(a: SDFResult, b: SDFResult, r: f32) -> SDFResult {
    return fOpIntersectionChamferEx(a, sdfNeg(b), r);
}

// Round union - g=0.5 signals blend region to MDC
fn fOpUnionRoundEx(a: SDFResult, b: SDFResult, r: f32) -> SDFResult {
    let u = max(vec2<f32>(r - a.d, r - b.d), vec2<f32>(0.0, 0.0));
    let d = max(r, min(a.d, b.d)) - length(u);
    let coplanar = abs(a.d - b.d) < SURF_DIST;
    let aWins = (coplanar && a.id <= b.id) || (!coplanar && a.d < b.d);
    let seamT = safeNormalize(cross(a.n, b.n), vec3f(0.0, 0.0, 1.0));
    let seam = bestSeam(a, b, abs(a.d - b.d), 1u, seamT);
    if (a.d < r && b.d < r) {
        let n = normalize(a.n * u.x + b.n * u.y);
        let w = u.y / (u.x + u.y);
        return SDFResult(d, 0.5, a.id, n, b.id, w, a.id, b.id, 0u, 1e9, seamT);
    }
    var out: SDFResult;
    if (coplanar) {
        let n = normalize(a.n + b.n);
        out = selectSDF(sdfR(d, b.g, b.id, n), sdfR(d, a.g, a.id, n), aWins);
    } else {
        out = selectSDF(sdfR(d, b.g, b.id, b.n), sdfR(d, a.g, a.id, a.n), aWins);
    }
    applySeam(&out, seam);
    return out;
}

fn fOpUnionSoftEx(a: SDFResult, b: SDFResult, r: f32) -> SDFResult {
    let e = max(r - abs(a.d - b.d), 0.0);
    let d = min(a.d, b.d) - e * e * 0.25 / r;
    let coplanar = abs(a.d - b.d) < SURF_DIST;
    let aWins = (coplanar && a.id <= b.id) || (!coplanar && a.d < b.d);
    let seamT = safeNormalize(cross(a.n, b.n), vec3f(0.0, 0.0, 1.0));
    let seam = bestSeam(a, b, abs(a.d - b.d), 1u, seamT);
    if (e > 0.0) {
        let n = normalize(a.n * (r - a.d) + b.n * (r - b.d));
        let wa = max(r - a.d, 0.0);
        let wb = max(r - b.d, 0.0);
        let w = wb / (wa + wb);
        return SDFResult(d, 0.5, a.id, n, b.id, w, a.id, b.id, 0u, 1e9, seamT);
    }
    var out: SDFResult;
    if (coplanar) {
        let n = normalize(a.n + b.n);
        out = selectSDF(sdfR(d, b.g, b.id, n), sdfR(d, a.g, a.id, n), aWins);
    } else {
        out = selectSDF(sdfR(d, b.g, b.id, b.n), sdfR(d, a.g, a.id, a.n), aWins);
    }
    applySeam(&out, seam);
    return out;
}

fn fOpIntersectionRoundEx(a: SDFResult, b: SDFResult, r: f32) -> SDFResult {
    let u = max(vec2<f32>(r + a.d, r + b.d), vec2<f32>(0.0, 0.0));
    let d = min(-r, max(a.d, b.d)) + length(u);
    let coplanar = abs(a.d - b.d) < SURF_DIST;
    let aWins = (coplanar && a.id <= b.id) || (!coplanar && a.d > b.d);
    let seamT = safeNormalize(cross(a.n, b.n), vec3f(0.0, 0.0, 1.0));
    let seam = bestSeam(a, b, abs(a.d - b.d), 2u, seamT);
    if (a.d > -r && b.d > -r) {
        let n = normalize(a.n * u.x + b.n * u.y);
        let w = u.y / (u.x + u.y);
        return SDFResult(d, 0.5, a.id, n, b.id, w, a.id, b.id, 0u, 1e9, seamT);
    }
    var out: SDFResult;
    if (coplanar) {
        let n = normalize(a.n + b.n);
        out = selectSDF(sdfR(d, b.g, b.id, n), sdfR(d, a.g, a.id, n), aWins);
    } else {
        out = selectSDF(sdfR(d, b.g, b.id, b.n), sdfR(d, a.g, a.id, a.n), aWins);
    }
    applySeam(&out, seam);
    return out;
}

fn fOpDifferenceRoundEx(a: SDFResult, b: SDFResult, r: f32) -> SDFResult {
    return fOpIntersectionRoundEx(a, sdfNeg(b), r);
}

// Columns union Ex — cylindrical columns decorate the blend between operands
fn fOpUnionColumnsEx(a: SDFResult, b: SDFResult, r: f32, n: f32) -> SDFResult {
    let seamT = safeNormalize(cross(a.n, b.n), vec3f(0.0, 0.0, 1.0));
    let seam = bestSeam(a, b, abs(a.d - b.d), 1u, seamT);
    if (a.d < r) && (b.d < r) {
        var p = vec2f(a.d, b.d);
        let columnradius = r * sqrt(2.0) / ((n - 1.0) * 2.0 + sqrt(2.0));
        let tmp = p + vec2f(p.y, -p.x);
        p = tmp * sqrt(0.5);
        p.x = p.x - sqrt(0.5) * r + columnradius * sqrt(2.0);
        if (n % 2.0) != 0.0 {
            p.y = p.y + columnradius;
        }
        let py = modF(p.y, columnradius * 2.0);
        let dist = length(vec2f(p.x, py)) - columnradius;
        let res = min(min(dist, p.x), a.d);
        let d = min(res, b.d);
        let wa = r - a.d;
        let wb = r - b.d;
        let w = wb / (wa + wb);
        let blendN = safeNormalize(a.n * wa + b.n * wb, a.n);
        return SDFResult(d, 1.0, a.id, blendN, b.id, w, a.id, b.id, 0u, 1e9, seamT);
    }
    var out: SDFResult;
    let coplanar = abs(a.d - b.d) < SURF_DIST;
    if (coplanar) {
        let cn = safeNormalize(a.n + b.n, a.n);
        out = selectSDF(sdfR(min(a.d, b.d), b.g, b.id, cn), sdfR(min(a.d, b.d), a.g, a.id, cn), a.id <= b.id);
    } else if (a.d < b.d) {
        out = sdfR(a.d, a.g, a.id, a.n);
    } else {
        out = sdfR(b.d, b.g, b.id, b.n);
    }
    applySeam(&out, seam);
    return out;
}

// Columns difference Ex — columns decorate the carved boundary
// Distance follows the scalar fOpDifferenceColumns exactly.
// Normals: mirrors the union's weight scheme in the complement space, then negates.
//   wa = r + aIn.d (= r - aD), wb = r - b.d — both guaranteed positive in blend zone.
//   Difference normal = normalize(aIn.n * wa - b.n * wb).
fn fOpDifferenceColumnsEx(aIn: SDFResult, b: SDFResult, r: f32, n: f32) -> SDFResult {
    let seamT = safeNormalize(cross(aIn.n, b.n), vec3f(0.0, 0.0, 1.0));
    let seam = bestSeam(aIn, b, abs(aIn.d + b.d), 3u, seamT);
    let aD = -aIn.d;
    if (aD < r) && (b.d < r) {
        var p = vec2f(aD, b.d);
        let columnradius = r * sqrt(2.0) / ((n - 1.0) * 2.0 + sqrt(2.0));
        let tmp = p + vec2f(p.y, -p.x);
        p = tmp * sqrt(0.5);
        p.y = p.y + columnradius;
        p.x = p.x - sqrt(0.5) * r - columnradius * sqrt(2.0) * 0.5;
        if (n % 2.0) != 0.0 {
            p.y = p.y + columnradius;
        }
        let py = modF(p.y, columnradius * 2.0);
        let res = min(max(-length(vec2f(p.x, py)) + columnradius, p.x), aD);
        let d = -min(res, b.d);
        let wa = r + aIn.d;
        let wb = r - b.d;
        let blendN = safeNormalize(aIn.n * wa - b.n * wb, aIn.n);
        let w = wb / (wa + wb);
        var out = SDFResult(d, 1.0, aIn.id, blendN, b.id, w, aIn.id, b.id, 0u, 1e9, seamT);
        applySeam(&out, seam);
        return out;
    }
    let d = max(aIn.d, -b.d);
    var out: SDFResult;
    let coplanar = abs(aIn.d + b.d) < SURF_DIST;
    if (coplanar) {
        let cn = safeNormalize(aIn.n - b.n, aIn.n);
        out = selectSDF(sdfR(d, b.g, b.id, cn), sdfR(d, aIn.g, aIn.id, cn), aIn.id <= b.id);
    } else if (aIn.d > -b.d) {
        out = sdfR(d, aIn.g, aIn.id, aIn.n);
    } else {
        out = sdfR(d, b.g, b.id, -b.n);
    }
    applySeam(&out, seam);
    return out;
}

// Columns intersection Ex
fn fOpIntersectionColumnsEx(a: SDFResult, b: SDFResult, r: f32, n: f32) -> SDFResult {
    return fOpDifferenceColumnsEx(a, sdfNeg(b), r, n);
}

// Stairs union Ex — staircase transition between operands
fn fOpUnionStairsEx(a: SDFResult, b: SDFResult, r: f32, n: f32) -> SDFResult {
    let seamT = safeNormalize(cross(a.n, b.n), vec3f(0.0, 0.0, 1.0));
    let seam = bestSeam(a, b, abs(a.d - b.d), 1u, seamT);
    let s = r / n;
    let u = b.d - r;
    let stairD = 0.5 * (u + a.d + abs(modF(u - a.d + s, 2.0 * s) - s));
    let d = min(min(a.d, b.d), stairD);

    if (a.d < r && b.d < r) {
        let wa = r - a.d;
        let wb = r - b.d;
        let w = wb / (wa + wb);
        let blendN = safeNormalize(a.n * wa + b.n * wb, a.n);
        return SDFResult(d, 1.0, a.id, blendN, b.id, w, a.id, b.id, 0u, 1e9, seamT);
    }
    var out: SDFResult;
    let coplanar = abs(a.d - b.d) < SURF_DIST;
    if (coplanar) {
        let cn = safeNormalize(a.n + b.n, a.n);
        out = selectSDF(sdfR(d, b.g, b.id, cn), sdfR(d, a.g, a.id, cn), a.id <= b.id);
    } else if (a.d < b.d) {
        out = sdfR(d, a.g, a.id, a.n);
    } else {
        out = sdfR(d, b.g, b.id, b.n);
    }
    applySeam(&out, seam);
    return out;
}

// Stairs intersection Ex
fn fOpIntersectionStairsEx(a: SDFResult, b: SDFResult, r: f32, n: f32) -> SDFResult {
    var result = fOpUnionStairsEx(sdfNeg(a), sdfNeg(b), r, n);
    result.d = -result.d;
    result.n = -result.n;
    return result;
}

// Stairs difference Ex
fn fOpDifferenceStairsEx(a: SDFResult, b: SDFResult, r: f32, n: f32) -> SDFResult {
    var result = fOpUnionStairsEx(sdfNeg(a), b, r, n);
    result.d = -result.d;
    result.n = -result.n;
    return result;
}

// Pipe Ex — cylindrical hole at intersection of two surfaces
fn fOpPipeEx(a: SDFResult, b: SDFResult, r: f32) -> SDFResult {
    let pipeLen = length(vec2f(a.d, b.d));
    let d = pipeLen - r;
    // Normal is the gradient of length(a.d, b.d): weight by distance components
    var blendN = a.n;
    if (pipeLen > 1e-6) {
        blendN = safeNormalize(a.n * a.d + b.n * b.d, a.n);
    }
    if (a.id <= b.id) { return sdfR(d, 1.0, a.id, blendN); }
    return sdfR(d, 1.0, b.id, blendN);
}

// Engrave Ex — carved groove in surface a using surface b as profile
fn fOpEngraveEx(a: SDFResult, b: SDFResult, r: f32) -> SDFResult {
    let engraveD = (a.d + r - abs(b.d)) * sqrt(0.5);
    let d = max(a.d, engraveD);
    if (engraveD > a.d) {
        // Gradient of (a.d + r - |b.d|) is (∇a - sign(b.d)·∇b)
        let blendN = safeNormalize(a.n - sgn(b.d) * b.n, a.n);
        return sdfR(d, 1.0, a.id, blendN);
    }
    return sdfR(d, a.g, a.id, a.n);
}

// Groove Ex — carpenter groove (rectangular channel in surface a along surface b)
fn fOpGrooveEx(a: SDFResult, b: SDFResult, ra: f32, rb: f32) -> SDFResult {
    let depthD = a.d + ra;
    let widthD = rb - abs(b.d);
    let grooveD = min(depthD, widthD);
    let d = max(a.d, grooveD);
    if (grooveD > a.d) {
        if (depthD < widthD) {
            // Depth-limited: normal is a's surface normal
            return sdfR(d, 1.0, a.id, a.n);
        }
        // Width-limited: gradient of (rb - |b.d|) is -sign(b.d)·∇b
        return sdfR(d, 1.0, a.id, -sgn(b.d) * b.n);
    }
    return sdfR(d, a.g, a.id, a.n);
}

// Tongue Ex — carpenter tongue (inverse of groove: protrusion from surface a)
fn fOpTongueEx(a: SDFResult, b: SDFResult, ra: f32, rb: f32) -> SDFResult {
    let depthD = a.d - ra;
    let widthD = abs(b.d) - rb;
    let tongueD = max(depthD, widthD);
    let d = min(a.d, tongueD);
    if (tongueD < a.d) {
        if (depthD > widthD) {
            // Depth-limited: normal is a's surface normal
            return sdfR(d, 1.0, a.id, a.n);
        }
        // Width-limited: gradient of (|b.d| - rb) is sign(b.d)·∇b
        return sdfR(d, 1.0, a.id, sgn(b.d) * b.n);
    }
    return sdfR(d, a.g, a.id, a.n);
}

