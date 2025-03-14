//////////////////////////////
//          CONSTANTS
//////////////////////////////

const PI: f32 = 3.14159265;
const TAU: f32 = 2.0 * PI;
const PHI: f32 = sqrt(5.0) * 0.5 + 0.5;

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

// Squaring, overloaded
fn square(x: f32) -> f32 { return x * x; }
fn square2(v: vec2<f32>) -> vec2<f32> { return v * v; }
fn square3(v: vec3<f32>) -> vec3<f32> { return v * v; }

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

// Soft union
fn fOpUnionSoft(a: f32, b: f32, r: f32) -> f32 {
    let e = max(r - abs(a - b), 0.0);
    return min(a, b) - e * e * 0.25 / r;
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
