
struct CapParams {
    loopCount: u32,
    maxLoopVerts: u32,
    isFirstSlice: u32, // 1=first, 0=last
};
const ZSTEP=0.01;
@group(0) @binding(0) var<uniform>         cparams: CapParams;
@group(0) @binding(1) var<storage, read>  loopStarts: array<u32>;
@group(0) @binding(2) var<storage, read>  loopVerts:  array<vec2<f32>>;
@group(0) @binding(3) var<storage, read_write> triangles: array<vec3<f32>>;
@group(0) @binding(4) var<storage, read_write> triCount: atomic<u32>;

const MAX_LOOP_VERTS: u32 = 1024u;
var<private> prevArr:  array<u32, MAX_LOOP_VERTS>;
var<private> nextArr:  array<u32, MAX_LOOP_VERTS>;
var<private> startOff: u32;  // base index into loopVerts for this loop

// Return true if the 2D point p lies strictly inside triangle a–b–c.
fn pointInTriangle(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>, c: vec2<f32>) -> bool {
    let v0 = c - a;
    let v1 = b - a;
    let v2 = p - a;
    let d00 = dot(v0, v0);
    let d01 = dot(v0, v1);
    let d11 = dot(v1, v1);
    let d20 = dot(v2, v0);
    let d21 = dot(v2, v1);
    let denom = d00 * d11 - d01 * d01;
    if (denom == 0.0) {
        return false;
    }
    let inv = 1.0 / denom;
    let u = (d11 * d20 - d01 * d21) * inv;
    let v = (d00 * d21 - d01 * d20) * inv;
    return (u > 0.0) && (v > 0.0) && (u + v < 1.0);
}

// Return true if vertex i’s corner is convex (CCW winding)
fn isConvex(i: u32) -> bool {
    let pi = prevArr[i];
    let ni = nextArr[i];
    let Pp = loopVerts[startOff + pi];
    let Pc = loopVerts[startOff + i];
    let Pn = loopVerts[startOff + ni];
    let cross = (Pn.x - Pc.x) * (Pp.y - Pc.y) - (Pn.y - Pc.y) * (Pp.x - Pc.x);
    return cross > 0.0;
}

// Return true if no other loop vertex lies inside the triangle (pi, i, ni)
fn noOtherInside(i: u32, n: u32) -> bool {
    let pi = prevArr[i];
    let ni = nextArr[i];
    let A = loopVerts[startOff + pi];
    let B = loopVerts[startOff + i];
    let C = loopVerts[startOff + ni];

    // walk the linked list of vertices
    var j = nextArr[i];
    loop {
        if (j == i) {
            break;
        }
        if (j != pi && j != ni) {
            let Pj = loopVerts[startOff + j];
            if (pointInTriangle(Pj, A, B, C)) {
                return false;
            }
        }
        j = nextArr[j];
    }
    return true;
}


@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let loopId = gid.x;
    if loopId >= cparams.loopCount { return; }
    var sliceIdx = 0u;
    if cparams.isFirstSlice != 1u {
        sliceIdx = cparams.loopCount + 1u;
    }
    let start = loopStarts[sliceIdx + loopId];
    let next = loopStarts[sliceIdx + 1u + loopId];
    let n = next - start;
    // build prev/next arrays in private memory
    var prev = array<u32, 1024>(); // maxLoopVerts
    var nex = array<u32, 1024>();
    for (var i = 0u; i < n; i = i + 1u) {
        prev[i] = (i + n-1u)%n;
        nex [i] = (i + 1u) % n;
    }
    var vcount = n;
    var cur = 0u;
    while vcount >= 3u {

        var ear: u32 = 0xFFFFFFFFu;
        for (var i = 0u; i < n; i = i + 1u) {
            if isConvex(i) && noOtherInside(i, n) {
                ear = i;
                break;
            }
        }

        if ear == 0xFFFFFFFFu { break; }
        // emit triangle (ear, next[ear], prev[ear])
        let pa = loopVerts[start + ear];
        let pb = loopVerts[start + nex[ear]];
        let pc = loopVerts[start + prev[ear]];
        let z = f32(sliceIdx) * ZSTEP;
        let base = atomicAdd(&triCount, 1u) * 3u;
        triangles[base + 0] = vec3<f32>(pa, z);
        triangles[base + 1] = vec3<f32>(pb, z);
        triangles[base + 2] = vec3<f32>(pc, z);

        // remove ear
        nex[ prev[ear] ] = nex[ear];
        prev[ nex[ear] ] = prev[ear];
        vcount = vcount - 1u;
    }
}
