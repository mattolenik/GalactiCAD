// Translated from https://mercury.sexy/hg_sdf

//////////////////////////////
//          CONSTANTS
//////////////////////////////

const PI: f32 = 3.14159265;
const TAU: f32 = 2.0 * PI;
const PHI: f32 = sqrt(5.0) * 0.5 + 0.5;
const SURF_DIST: f32 = 0.001;

//////////////////////////////
//  EXTENDED SDF RESULT TYPE
//////////////////////////////

// SDFResult carries both the distance value and gradient magnitude estimate.
// - d: The distance value (may not be true Euclidean distance for smooth CSG)
// - g: Gradient magnitude estimate (1.0 for true SDFs, <1.0 in smooth blend regions)
//
// The gradient magnitude is used to correct projection steps in MDC:
// when |∇f| < 1, naive projection by `d` overshoots the surface.
struct SDFResult {
    d: f32,
    g: f32,
    s: f32,
    id: u32,
    n: vec3<f32>,
    id2: u32,     // secondary ID for smooth blend color interpolation
    blend: f32,   // blend weight: 0 = fully id, 1 = fully id2
    seamA: u32,   // provenance primary operand for hard CSG seams
    seamB: u32,   // provenance secondary operand for hard CSG seams
    seamOp: u32,  // 0 = none, 1 = union, 2 = intersection, 3 = difference
    seamGap: f32, // |dA - dB| near seam, lower means stronger seam candidate
    seamTangent: vec3f, // approximate seam tangent (cross of contributing normals)
    _seamPad: f32,
}

// Create SDFResult with no color blending (gradient magnitude g, sign s)
fn sdfR(d: f32, g: f32, s: f32, id: u32, n: vec3f) -> SDFResult {
    return SDFResult(d, g, s, id, n, id, 0.0, id, id, 0u, 1e9, vec3f(0.0, 0.0, 1.0), 0.0);
}

// Create SDFResult from a true distance (gradient magnitude = 1.0)
fn sdfTrue(d: f32, id: u32, n: vec3<f32>) -> SDFResult {
    return SDFResult(d, 1.0, 1.0, id, n, id, 0.0, id, id, 0u, 1e9, vec3f(0.0, 0.0, 1.0), 0.0);
}

// Negate an SDFResult (complement the surface: flip distance, sign, and normal)
fn sdfNeg(r: SDFResult) -> SDFResult {
    return SDFResult(-r.d, r.g, -r.s, r.id, -r.n, r.id2, r.blend, r.seamA, r.seamB, r.seamOp, r.seamGap, r.seamTangent, r._seamPad);
}

//////////////////////////////
//       HELPER FUNCTIONS
//////////////////////////////

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

// Fast sphere: returns vec2f(distance, gradientMagnitude=1.0)
fn fSphereFast(p: vec3<f32>, r: f32) -> vec2f {
    return vec2f(length(p) - r, 1.0);
}

// Fast box: returns vec2f(distance, gradientMagnitude=1.0)
fn fBoxFast(p: vec3<f32>, b: vec3<f32>) -> vec2f {
    let d = abs(p) - b;
    return vec2f(length(max(d, vec3<f32>(0.0))) + vmax3(min(d, vec3<f32>(0.0))), 1.0);
}

fn fCylinderFast(p: vec3<f32>, r: f32, height: f32) -> vec2f {
    return vec2f(fCylinder(p, r, height), 1.0);
}

fn fConeFast(p: vec3<f32>, radius: f32, height: f32) -> vec2f {
    return vec2f(fCone(p, radius, height), 1.0);
}

fn fTorusFast(p: vec3<f32>, smallRadius: f32, largeRadius: f32) -> vec2f {
    return vec2f(fTorus(p, smallRadius, largeRadius), 1.0);
}

fn fCapsuleFast(p: vec3<f32>, r: f32, c: f32) -> vec2f {
    return vec2f(fCapsule(p, r, c), 1.0);
}

fn fPlaneFast(p: vec3<f32>, n: vec3<f32>, distanceFromOrigin: f32) -> vec2f {
    return vec2f(fPlane(p, n, distanceFromOrigin), 1.0);
}

fn fHexagonCircumcircleFast(p: vec3<f32>, h: vec2<f32>) -> vec2f {
    return vec2f(fHexagonCircumcircle(p, h), 1.0);
}

fn fDiscFast(p: vec3<f32>, r: f32) -> vec2f {
    return vec2f(fDisc(p, r), 1.0);
}

fn fBlobFast(p: vec3<f32>) -> vec2f {
    return vec2f(fBlob(p), 1.0);
}

// Fast hard union: just pick min distance, no tie-breaking or normals
fn opUnionFast(a: vec2f, b: vec2f) -> vec2f {
    return select(b, a, a.x < b.x);
}

// Fast hard intersection: just pick max distance
fn opIntersectionFast(a: vec2f, b: vec2f) -> vec2f {
    return select(b, a, a.x > b.x);
}

// Fast hard difference: intersection with complement
fn opDifferenceFast(a: vec2f, b: vec2f) -> vec2f {
    return opIntersectionFast(a, vec2f(-b.x, b.y));
}

// Fast round union: distance + gradient only, no normal blending
fn fOpUnionRoundFast(a: vec2f, b: vec2f, r: f32) -> vec2f {
    let u = max(vec2f(r - a.x, r - b.x), vec2f(0.0));
    let d = max(r, min(a.x, b.x)) - length(u);
    let inBlend = a.x < r && b.x < r;
    let g = select(select(b.y, a.y, a.x < b.x), 0.5, inBlend);
    return vec2f(d, g);
}

// Fast soft union
fn fOpUnionSoftFast(a: vec2f, b: vec2f, r: f32) -> vec2f {
    let e = max(r - abs(a.x - b.x), 0.0);
    let d = min(a.x, b.x) - e * e * 0.25 / r;
    let inBlend = e > 0.0;
    let g = select(select(b.y, a.y, a.x < b.x), 0.5, inBlend);
    return vec2f(d, g);
}

// Fast round intersection
fn fOpIntersectionRoundFast(a: vec2f, b: vec2f, r: f32) -> vec2f {
    let u = max(vec2f(r + a.x, r + b.x), vec2f(0.0));
    let d = min(-r, max(a.x, b.x)) + length(u);
    let inBlend = a.x > -r && b.x > -r;
    let g = select(select(b.y, a.y, a.x > b.x), 0.5, inBlend);
    return vec2f(d, g);
}

// Fast round difference
fn fOpDifferenceRoundFast(a: vec2f, b: vec2f, r: f32) -> vec2f {
    return fOpIntersectionRoundFast(a, vec2f(-b.x, b.y), r);
}

// Fast chamfer union
fn fOpUnionChamferFast(a: vec2f, b: vec2f, r: f32) -> vec2f {
    let chamferD = (a.x - r + b.x) * sqrt(0.5);
    let d = min(min(a.x, b.x), chamferD);
    let inChamfer = chamferD < a.x && chamferD < b.x;
    let g = select(select(b.y, a.y, a.x < b.x), 1.0, inChamfer);
    return vec2f(d, g);
}

// Fast chamfer intersection
fn fOpIntersectionChamferFast(a: vec2f, b: vec2f, r: f32) -> vec2f {
    let chamferD = (a.x + r + b.x) * sqrt(0.5);
    let d = max(max(a.x, b.x), chamferD);
    let inChamfer = chamferD > a.x && chamferD > b.x;
    let g = select(select(b.y, a.y, a.x > b.x), 1.0, inChamfer);
    return vec2f(d, g);
}

// Fast chamfer difference
fn fOpDifferenceChamferFast(a: vec2f, b: vec2f, r: f32) -> vec2f {
    return fOpIntersectionChamferFast(a, vec2f(-b.x, b.y), r);
}

// Fast columns union
fn fOpUnionColumnsFast(a: vec2f, b: vec2f, r: f32, n: f32) -> vec2f {
    if (a.x < r) && (b.x < r) {
        var p = vec2f(a.x, b.x);
        let columnradius = r * sqrt(2.0) / ((n - 1.0) * 2.0 + sqrt(2.0));
        let tmp = p + vec2f(p.y, -p.x);
        p = tmp * sqrt(0.5);
        p.x = p.x - sqrt(0.5) * r + columnradius * sqrt(2.0);
        if (n % 2.0) != 0.0 {
            p.y = p.y + columnradius;
        }
        let py = modF(p.y, columnradius * 2.0);
        let dist = length(vec2f(p.x, py)) - columnradius;
        let d = min(min(dist, p.x), a.x);
        return vec2f(min(d, b.x), 1.0);
    }
    return select(b, a, a.x < b.x);
}

// Fast columns difference
fn fOpDifferenceColumnsFast(aIn: vec2f, b: vec2f, r: f32, n: f32) -> vec2f {
    let a = -aIn.x;
    if (a < r) && (b.x < r) {
        var p = vec2f(a, b.x);
        let columnradius = r * sqrt(2.0) / ((n - 1.0) * 2.0 + sqrt(2.0));
        let tmp = p + vec2f(p.y, -p.x);
        p = tmp * sqrt(0.5);
        p.y = p.y + columnradius;
        p.x = p.x - sqrt(0.5) * r - columnradius * sqrt(2.0) * 0.5;
        if (n % 2.0) != 0.0 {
            p.y = p.y + columnradius;
        }
        let py = modF(p.y, columnradius * 2.0);
        let res = min(max(-length(vec2f(p.x, py)) + columnradius, p.x), a);
        return vec2f(-min(res, b.x), 1.0);
    }
    let m = min(a, b.x);
    return vec2f(-m, select(b.y, aIn.y, a < b.x));
}

// Fast columns intersection
fn fOpIntersectionColumnsFast(a: vec2f, b: vec2f, r: f32, n: f32) -> vec2f {
    return fOpDifferenceColumnsFast(a, vec2f(-b.x, b.y), r, n);
}

// Fast stairs union
fn fOpUnionStairsFast(a: vec2f, b: vec2f, r: f32, n: f32) -> vec2f {
    let s = r / n;
    let u = b.x - r;
    let stairD = 0.5 * (u + a.x + abs(modF(u - a.x + s, 2.0 * s) - s));
    let d = min(min(a.x, b.x), stairD);
    let inStair = stairD < a.x && stairD < b.x;
    let g = select(select(b.y, a.y, a.x < b.x), 1.0, inStair);
    return vec2f(d, g);
}

// Fast stairs intersection
fn fOpIntersectionStairsFast(a: vec2f, b: vec2f, r: f32, n: f32) -> vec2f {
    let result = fOpUnionStairsFast(vec2f(-a.x, a.y), vec2f(-b.x, b.y), r, n);
    return vec2f(-result.x, result.y);
}

// Fast stairs difference
fn fOpDifferenceStairsFast(a: vec2f, b: vec2f, r: f32, n: f32) -> vec2f {
    let result = fOpUnionStairsFast(vec2f(-a.x, a.y), b, r, n);
    return vec2f(-result.x, result.y);
}

// Fast pipe (cylindrical hole at intersection)
fn fOpPipeFast(a: vec2f, b: vec2f, r: f32) -> vec2f {
    return vec2f(length(vec2f(a.x, b.x)) - r, 1.0);
}

// Fast engrave
fn fOpEngraveFast(a: vec2f, b: vec2f, r: f32) -> vec2f {
    let engraveD = (a.x + r - abs(b.x)) * sqrt(0.5);
    let d = max(a.x, engraveD);
    let g = select(a.y, 1.0, engraveD > a.x);
    return vec2f(d, g);
}

// Fast groove
fn fOpGrooveFast(a: vec2f, b: vec2f, ra: f32, rb: f32) -> vec2f {
    let grooveD = min(a.x + ra, rb - abs(b.x));
    let d = max(a.x, grooveD);
    let g = select(a.y, 1.0, grooveD > a.x);
    return vec2f(d, g);
}

// Fast tongue
fn fOpTongueFast(a: vec2f, b: vec2f, ra: f32, rb: f32) -> vec2f {
    let tongueD = max(a.x - ra, abs(b.x) - rb);
    let d = min(a.x, tongueD);
    let g = select(a.y, 1.0, tongueD < a.x);
    return vec2f(d, g);
}

////////////////////////////////////////////////////
//  DOMAIN TRANSFORM HELPERS (SDFResult)
////////////////////////////////////////////////////

// Rotate the normal and seam tangent of an SDFResult by a forward rotation matrix.
// Used after evaluating a child SDF in a rotated coordinate system.
fn sdfRotateNormal(r: SDFResult, m: mat3x3f) -> SDFResult {
    var out = r;
    out.n = safeNormalize(m * out.n, out.n);
    out.seamTangent = safeNormalize(m * out.seamTangent, out.seamTangent);
    return out;
}

////////////////////////////////////////////////////
//  EXTENDED OBJECT COMBINATION OPERATORS
//  These return SDFResult with accurate gradient magnitude estimates
////////////////////////////////////////////////////

// Pick the tightest seam from: the outer seam between a and b, and any
// inner seam already carried by either operand.  This ensures nested CSG
// trees (e.g. Union(Union(A,B),C)) propagate ALL seam provenance — not
// just the outermost operator's.
fn bestSeam(a: SDFResult, b: SDFResult, outerGap: f32, outerOp: u32, outerTangent: vec3f) -> SDFResult {
    // Start with the outer seam.
    var s: SDFResult;
    s.seamA = a.id;
    s.seamB = b.id;
    s.seamOp = outerOp;
    s.seamGap = outerGap;
    s.seamTangent = outerTangent;
    // If operand a carries a tighter inner seam, prefer it.
    if (a.seamOp != 0u && a.seamGap < s.seamGap) {
        s.seamA = a.seamA;
        s.seamB = a.seamB;
        s.seamOp = a.seamOp;
        s.seamGap = a.seamGap;
        s.seamTangent = a.seamTangent;
    }
    // If operand b carries an even tighter seam, prefer that.
    if (b.seamOp != 0u && b.seamGap < s.seamGap) {
        s.seamA = b.seamA;
        s.seamB = b.seamB;
        s.seamOp = b.seamOp;
        s.seamGap = b.seamGap;
        s.seamTangent = b.seamTangent;
    }
    return s;
}

// Hard union: pick the closer operand (ID tiebreaker + normal blend for coplanar surfaces)
fn opUnionEx(a: SDFResult, b: SDFResult) -> SDFResult {
    let gap = abs(a.d - b.d);
    let seamTangent = safeNormalize(cross(a.n, b.n), vec3f(0.0, 0.0, 1.0));
    let seam = bestSeam(a, b, gap, 1u, seamTangent);
    if (abs(a.d - b.d) < SURF_DIST) {
        let n = normalize(a.n + b.n);
        if (a.id <= b.id) {
            var out = sdfR(a.d, a.g, a.s, a.id, n);
            out.seamA = seam.seamA; out.seamB = seam.seamB;
            out.seamOp = seam.seamOp; out.seamGap = seam.seamGap;
            out.seamTangent = seam.seamTangent;
            return out;
        }
        var out = sdfR(b.d, b.g, b.s, b.id, n);
        out.seamA = seam.seamA; out.seamB = seam.seamB;
        out.seamOp = seam.seamOp; out.seamGap = seam.seamGap;
        out.seamTangent = seam.seamTangent;
        return out;
    }
    if (a.d < b.d) {
        var out = a;
        out.seamA = seam.seamA; out.seamB = seam.seamB;
        out.seamOp = seam.seamOp; out.seamGap = seam.seamGap;
        out.seamTangent = seam.seamTangent;
        return out;
    }
    var out = b;
    out.seamA = seam.seamA; out.seamB = seam.seamB;
    out.seamOp = seam.seamOp; out.seamGap = seam.seamGap;
    out.seamTangent = seam.seamTangent;
    return out;
}

// Hard intersection: pick the farther operand (ID tiebreaker + normal blend for coplanar surfaces)
fn opIntersectionEx(a: SDFResult, b: SDFResult) -> SDFResult {
    let gap = abs(a.d - b.d);
    let seamTangent = safeNormalize(cross(a.n, b.n), vec3f(0.0, 0.0, 1.0));
    let seam = bestSeam(a, b, gap, 2u, seamTangent);
    if (abs(a.d - b.d) < SURF_DIST) {
        let n = normalize(a.n + b.n);
        if (a.id <= b.id) {
            var out = sdfR(a.d, a.g, a.s, a.id, n);
            out.seamA = seam.seamA; out.seamB = seam.seamB;
            out.seamOp = seam.seamOp; out.seamGap = seam.seamGap;
            out.seamTangent = seam.seamTangent;
            return out;
        }
        var out = sdfR(b.d, b.g, b.s, b.id, n);
        out.seamA = seam.seamA; out.seamB = seam.seamB;
        out.seamOp = seam.seamOp; out.seamGap = seam.seamGap;
        out.seamTangent = seam.seamTangent;
        return out;
    }
    if (a.d > b.d) {
        var out = a;
        out.seamA = seam.seamA; out.seamB = seam.seamB;
        out.seamOp = seam.seamOp; out.seamGap = seam.seamGap;
        out.seamTangent = seam.seamTangent;
        return out;
    }
    var out = b;
    out.seamA = seam.seamA; out.seamB = seam.seamB;
    out.seamOp = seam.seamOp; out.seamGap = seam.seamGap;
    out.seamTangent = seam.seamTangent;
    return out;
}

// Hard difference: intersection with complement of b
fn opDifferenceEx(a: SDFResult, b: SDFResult) -> SDFResult {
    let bNeg = SDFResult(-b.d, b.g, -b.s, b.id, -b.n, b.id2, b.blend, b.seamA, b.seamB, b.seamOp, b.seamGap, b.seamTangent, b._seamPad);
    var out = opIntersectionEx(a, bNeg);
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
    
    // In chamfer region: blend normals
    if (chamferD < a.d && chamferD < b.d) {
        if (coplanar || a.d < b.d) {
            if (coplanar && b.id < a.id) { return sdfR(d, 1.0, b.s, b.id, n); }
            return sdfR(d, 1.0, a.s, a.id, n);
        }
        return sdfR(d, 1.0, b.s, b.id, n);
    }
    // Outside chamfer: coplanar tiebreaker
    if (coplanar) {
        if (a.id <= b.id) { return sdfR(d, a.g, a.s, a.id, n); }
        return sdfR(d, b.g, b.s, b.id, n);
    }
    if (a.d < b.d) { return sdfR(d, a.g, a.s, a.id, a.n); }
    return sdfR(d, b.g, b.s, b.id, b.n);
}

fn fOpIntersectionChamferEx(a: SDFResult, b: SDFResult, r: f32) -> SDFResult {
    let chamferD = (a.d + r + b.d) * sqrt(0.5);
    let d = max(max(a.d, b.d), chamferD);
    let diff = abs(a.d - b.d);
    let coplanar = diff < SURF_DIST;
    let n = normalize(a.n + b.n);
    
    // In chamfer region: blend normals
    if (chamferD > a.d && chamferD > b.d) {
        if (coplanar || a.d > b.d) {
            if (coplanar && b.id < a.id) { return sdfR(d, 1.0, b.s, b.id, n); }
            return sdfR(d, 1.0, a.s, a.id, n);
        }
        return sdfR(d, 1.0, b.s, b.id, n);
    }
    // Outside chamfer: coplanar tiebreaker
    if (coplanar) {
        if (a.id <= b.id) { return sdfR(d, a.g, a.s, a.id, n); }
        return sdfR(d, b.g, b.s, b.id, n);
    }
    if (a.d > b.d) { return sdfR(d, a.g, a.s, a.id, a.n); }
    return sdfR(d, b.g, b.s, b.id, b.n);
}

fn fOpDifferenceChamferEx(a: SDFResult, b: SDFResult, r: f32) -> SDFResult {
    return fOpIntersectionChamferEx(a, SDFResult(-b.d, b.g, -b.s, b.id, -b.n, b.id2, b.blend, b.seamA, b.seamB, b.seamOp, b.seamGap, b.seamTangent, b._seamPad), r);
}

// Round union - g=0.5 signals blend region to MDC
fn fOpUnionRoundEx(a: SDFResult, b: SDFResult, r: f32) -> SDFResult {
    let u = max(vec2<f32>(r - a.d, r - b.d), vec2<f32>(0.0, 0.0));
    let d = max(r, min(a.d, b.d)) - length(u);
    let coplanar = abs(a.d - b.d) < SURF_DIST;
    let aWins = (coplanar && a.id <= b.id) || (!coplanar && a.d < b.d);
    
    // In blend region: smooth color interpolation between both operands
    if (a.d < r && b.d < r) {
        let n = normalize(a.n * u.x + b.n * u.y);
        let w = u.y / (u.x + u.y);  // 0 = fully a, 1 = fully b
        return SDFResult(d, 0.5, select(b.s, a.s, a.d < b.d), a.id, n, b.id, w, a.id, b.id, 0u, 1e9, safeNormalize(cross(a.n, b.n), vec3f(0.0, 0.0, 1.0)), 0.0);
    }
    // Outside blend
    if (coplanar) {
        let n = normalize(a.n + b.n);
        if (aWins) { return sdfR(d, a.g, a.s, a.id, n); }
        return sdfR(d, b.g, b.s, b.id, n);
    }
    if (aWins) { return sdfR(d, a.g, a.s, a.id, a.n); }
    return sdfR(d, b.g, b.s, b.id, b.n);
}

fn fOpUnionSoftEx(a: SDFResult, b: SDFResult, r: f32) -> SDFResult {
    let e = max(r - abs(a.d - b.d), 0.0);
    let d = min(a.d, b.d) - e * e * 0.25 / r;
    let coplanar = abs(a.d - b.d) < SURF_DIST;
    let aWins = (coplanar && a.id <= b.id) || (!coplanar && a.d < b.d);
    
    // In blend region: smooth color interpolation between both operands
    if (e > 0.0) {
        let n = normalize(a.n * (r - a.d) + b.n * (r - b.d));
        let wa = max(r - a.d, 0.0);
        let wb = max(r - b.d, 0.0);
        let w = wb / (wa + wb);  // 0 = fully a, 1 = fully b
        return SDFResult(d, 0.5, select(b.s, a.s, a.d < b.d), a.id, n, b.id, w, a.id, b.id, 0u, 1e9, safeNormalize(cross(a.n, b.n), vec3f(0.0, 0.0, 1.0)), 0.0);
    }
    // Outside blend
    if (coplanar) {
        let n = normalize(a.n + b.n);
        if (aWins) { return sdfR(d, a.g, a.s, a.id, n); }
        return sdfR(d, b.g, b.s, b.id, n);
    }
    if (aWins) { return sdfR(d, a.g, a.s, a.id, a.n); }
    return sdfR(d, b.g, b.s, b.id, b.n);
}

fn fOpIntersectionRoundEx(a: SDFResult, b: SDFResult, r: f32) -> SDFResult {
    let u = max(vec2<f32>(r + a.d, r + b.d), vec2<f32>(0.0, 0.0));
    let d = min(-r, max(a.d, b.d)) + length(u);
    let coplanar = abs(a.d - b.d) < SURF_DIST;
    let aWins = (coplanar && a.id <= b.id) || (!coplanar && a.d > b.d);
    
    // In blend region: smooth color interpolation between both operands
    if (a.d > -r && b.d > -r) {
        let n = normalize(a.n * u.x + b.n * u.y);
        let w = u.y / (u.x + u.y);  // 0 = fully a, 1 = fully b
        return SDFResult(d, 0.5, select(b.s, a.s, a.d > b.d), a.id, n, b.id, w, a.id, b.id, 0u, 1e9, safeNormalize(cross(a.n, b.n), vec3f(0.0, 0.0, 1.0)), 0.0);
    }
    // Outside blend
    if (coplanar) {
        let n = normalize(a.n + b.n);
        if (aWins) { return sdfR(d, a.g, a.s, a.id, n); }
        return sdfR(d, b.g, b.s, b.id, n);
    }
    if (aWins) { return sdfR(d, a.g, a.s, a.id, a.n); }
    return sdfR(d, b.g, b.s, b.id, b.n);
}

fn fOpDifferenceRoundEx(a: SDFResult, b: SDFResult, r: f32) -> SDFResult {
    return fOpIntersectionRoundEx(a, SDFResult(-b.d, b.g, -b.s, b.id, -b.n, b.id2, b.blend, b.seamA, b.seamB, b.seamOp, b.seamGap, b.seamTangent, b._seamPad), r);
}

// Columns union Ex — cylindrical columns decorate the blend between operands
fn fOpUnionColumnsEx(a: SDFResult, b: SDFResult, r: f32, n: f32) -> SDFResult {
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
        let blendN = safeNormalize(a.n + b.n, a.n);
        if (a.d <= b.d) { return sdfR(d, 1.0, a.s, a.id, blendN); }
        return sdfR(d, 1.0, b.s, b.id, blendN);
    }
    let coplanar = abs(a.d - b.d) < SURF_DIST;
    if (coplanar) {
        let cn = safeNormalize(a.n + b.n, a.n);
        if (a.id <= b.id) { return sdfR(min(a.d, b.d), a.g, a.s, a.id, cn); }
        return sdfR(min(a.d, b.d), b.g, b.s, b.id, cn);
    }
    if (a.d < b.d) { return sdfR(a.d, a.g, a.s, a.id, a.n); }
    return sdfR(b.d, b.g, b.s, b.id, b.n);
}

// Columns difference Ex — columns decorate the carved boundary
fn fOpDifferenceColumnsEx(aIn: SDFResult, b: SDFResult, r: f32, n: f32) -> SDFResult {
    let aD = -aIn.d;
    let aN = -aIn.n;
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
        let blendN = safeNormalize(aN + b.n, aN);
        if (aD <= b.d) { return sdfR(d, 1.0, -aIn.s, aIn.id, blendN); }
        return sdfR(d, 1.0, b.s, b.id, blendN);
    }
    let m = min(aD, b.d);
    let d = -m;
    let coplanar = abs(aD - b.d) < SURF_DIST;
    if (coplanar) {
        let cn = safeNormalize(aN + b.n, aN);
        if (aIn.id <= b.id) { return sdfR(d, aIn.g, -aIn.s, aIn.id, cn); }
        return sdfR(d, b.g, b.s, b.id, cn);
    }
    if (aD < b.d) { return sdfR(d, aIn.g, -aIn.s, aIn.id, aN); }
    return sdfR(d, b.g, b.s, b.id, b.n);
}

// Columns intersection Ex
fn fOpIntersectionColumnsEx(a: SDFResult, b: SDFResult, r: f32, n: f32) -> SDFResult {
    return fOpDifferenceColumnsEx(a, sdfNeg(b), r, n);
}

// Stairs union Ex — staircase transition between operands
fn fOpUnionStairsEx(a: SDFResult, b: SDFResult, r: f32, n: f32) -> SDFResult {
    let s = r / n;
    let u = b.d - r;
    let stairD = 0.5 * (u + a.d + abs(modF(u - a.d + s, 2.0 * s) - s));
    let d = min(min(a.d, b.d), stairD);
    let coplanar = abs(a.d - b.d) < SURF_DIST;
    // In stair region: blend normals
    if (stairD < a.d && stairD < b.d) {
        let blendN = safeNormalize(a.n + b.n, a.n);
        if (a.d <= b.d) { return sdfR(d, 1.0, a.s, a.id, blendN); }
        return sdfR(d, 1.0, b.s, b.id, blendN);
    }
    // Outside stair region
    if (coplanar) {
        let cn = safeNormalize(a.n + b.n, a.n);
        if (a.id <= b.id) { return sdfR(d, a.g, a.s, a.id, cn); }
        return sdfR(d, b.g, b.s, b.id, cn);
    }
    if (a.d < b.d) { return sdfR(d, a.g, a.s, a.id, a.n); }
    return sdfR(d, b.g, b.s, b.id, b.n);
}

// Stairs intersection Ex
fn fOpIntersectionStairsEx(a: SDFResult, b: SDFResult, r: f32, n: f32) -> SDFResult {
    var result = fOpUnionStairsEx(sdfNeg(a), sdfNeg(b), r, n);
    result.d = -result.d;
    result.s = -result.s;
    result.n = -result.n;
    return result;
}

// Stairs difference Ex
fn fOpDifferenceStairsEx(a: SDFResult, b: SDFResult, r: f32, n: f32) -> SDFResult {
    var result = fOpUnionStairsEx(sdfNeg(a), b, r, n);
    result.d = -result.d;
    result.s = -result.s;
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
    if (a.id <= b.id) { return sdfR(d, 1.0, a.s, a.id, blendN); }
    return sdfR(d, 1.0, b.s, b.id, blendN);
}

// Engrave Ex — carved groove in surface a using surface b as profile
fn fOpEngraveEx(a: SDFResult, b: SDFResult, r: f32) -> SDFResult {
    let engraveD = (a.d + r - abs(b.d)) * sqrt(0.5);
    let d = max(a.d, engraveD);
    if (engraveD > a.d) {
        // Gradient of (a.d + r - |b.d|) is (∇a - sign(b.d)·∇b)
        let blendN = safeNormalize(a.n - sgn(b.d) * b.n, a.n);
        return sdfR(d, 1.0, a.s, a.id, blendN);
    }
    return sdfR(d, a.g, a.s, a.id, a.n);
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
            return sdfR(d, 1.0, a.s, a.id, a.n);
        }
        // Width-limited: gradient of (rb - |b.d|) is -sign(b.d)·∇b
        return sdfR(d, 1.0, a.s, a.id, -sgn(b.d) * b.n);
    }
    return sdfR(d, a.g, a.s, a.id, a.n);
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
            return sdfR(d, 1.0, a.s, a.id, a.n);
        }
        // Width-limited: gradient of (|b.d| - rb) is sign(b.d)·∇b
        return sdfR(d, 1.0, a.s, a.id, sgn(b.d) * b.n);
    }
    return sdfR(d, a.g, a.s, a.id, a.n);
}
