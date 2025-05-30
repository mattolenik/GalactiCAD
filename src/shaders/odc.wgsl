//:) include "hg_sdf.wgsl"
// ----------------------------
// Constants & Helpers
// ----------------------------

// Corner offsets for the 8 cube corners
const CORNER_OFFSETS: array<vec3<u32>, 8> = array<vec3<u32>, 8>(
    vec3<u32>(0,0,0), vec3<u32>(1,0,0),
    vec3<u32>(0,1,0), vec3<u32>(1,1,0),
    vec3<u32>(0,0,1), vec3<u32>(1,0,1),
    vec3<u32>(0,1,1), vec3<u32>(1,1,1)
);

// Edges as pairs of corner indices
const EDGE_PAIRS: array<vec2<u32>, 12> = array<vec2<u32>,12>(
    vec2<u32>(0,1), vec2<u32>(2,3), vec2<u32>(4,5), vec2<u32>(6,7),
    vec2<u32>(0,2), vec2<u32>(1,3), vec2<u32>(4,6), vec2<u32>(5,7),
    vec2<u32>(0,4), vec2<u32>(1,5), vec2<u32>(2,6), vec2<u32>(3,7)
);

// User's SDF stub
fn sceneSDF(p: vec3<f32>) -> f32 {
    return 0f; //:) insert sceneSDF
}

// 1D Search: binary bisection along an edge
fn searchEdge(p0: vec3<f32>, p1: vec3<f32>) -> vec3<f32> {
    var a = p0;
    var b = p1;
    var fa = sceneSDF(a);
    for (var i: u32 = 0u; i < 5u; i++) {
        let m = (a + b) * 0.5;
        let fm = sceneSDF(m);
        if ((fm < 0.0) == (fa < 0.0)) {
            a = m;
            fa = fm;
        } else {
            b = m;
        }
    }
    return (a + b) * 0.5;
}

// 2D Search: central-difference normal
fn faceNormal(ipos: vec3<f32>, eps: f32) -> vec3<f32> {
    let dx = sceneSDF(ipos + vec3<f32>(eps,0,0)) - sceneSDF(ipos - vec3<f32>(eps,0,0));
    let dy = sceneSDF(ipos + vec3<f32>(0,eps,0)) - sceneSDF(ipos - vec3<f32>(0,eps,0));
    let dz = sceneSDF(ipos + vec3<f32>(0,0,eps)) - sceneSDF(ipos - vec3<f32>(0,0,eps));
    return normalize(vec3<f32>(dx, dy, dz));
}

// ----------------------------
// Uniforms & Buffers
// ----------------------------
struct Params {
    dimX:           u32,
    dimY:           u32,
    dimZ:           u32,
    cellSize:       vec3<f32>,
    boundsMin:      vec3<f32>,
    maxTrisPerCell: u32,
};
@group(0) @binding(0) var<uniform> uParams: Params;
@group(0) @binding(1) var<storage, read_write> cellActiveBuffer: array<u32>;
@group(0) @binding(2) var<storage, read_write> triCountBuffer: array<u32>;
@group(0) @binding(3) var<storage, read_write> vertexBuffer: array<vec3<f32>>;
@group(0) @binding(4) var<storage, read_write> indexBuffer: array<u32>;

// Decode linear index → (x,y,z)
fn decodeCellCoords(idx: u32) -> vec3<u32> {
    let z = idx / (uParams.dimX * uParams.dimY);
    let y = (idx / uParams.dimX) % uParams.dimY;
    let x = idx % uParams.dimX;
    return vec3<u32>(x, y, z);
}

// ----------------------------
// Pass 1: classify occupancy
// ----------------------------
@compute @workgroup_size(8, 8, 4)
fn classifyPass(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (any(gid >= vec3<u32>(uParams.dimX, uParams.dimY, uParams.dimZ))) { return; }
    let idx = gid.x + gid.y * uParams.dimX + gid.z * uParams.dimX * uParams.dimY;
    let coords = decodeCellCoords(idx);
    // skip boundary
    if (coords.x + 1u >= uParams.dimX || coords.y + 1u >= uParams.dimY || coords.z + 1u >= uParams.dimZ) {
        cellActiveBuffer[idx] = 0u;
        return;
    }
    var sawIn = false;
    var sawOut = false;
    let base = uParams.boundsMin + vec3<f32>(f32(coords.x), f32(coords.y), f32(coords.z)) * uParams.cellSize;
    for (var i: u32 = 0u; i < 8u; i++) {
        let off = CORNER_OFFSETS[i];
        let p = base + vec3<f32>(f32(off.x), f32(off.y), f32(off.z)) * uParams.cellSize;
        let d = sceneSDF(p);
        sawIn  = sawIn  || (d < 0.0);
        sawOut = sawOut || (d >= 0.0);
        if (sawIn && sawOut) { cellActiveBuffer[idx] = 1u; return; }
    }
    cellActiveBuffer[idx] = 0u;
}

// ----------------------------
// Pass 2: count triangles
// ----------------------------
fn countCellTris(idx: u32) -> u32 {
    let c = decodeCellCoords(idx);
    var q: u32 = 0u;
    if (c.x + 1u < uParams.dimX && cellActiveBuffer[idx+1u] == 1u) { q++; }
    if (c.y + 1u < uParams.dimY && cellActiveBuffer[idx+uParams.dimX] == 1u) { q++; }
    if (c.z + 1u < uParams.dimZ && cellActiveBuffer[idx+uParams.dimX*uParams.dimY] == 1u) { q++; }
    return q * 2u;
}

@compute @workgroup_size(8, 8, 4)
fn countPass(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (any(gid >= vec3<u32>(uParams.dimX, uParams.dimY, uParams.dimZ))) { return; }
    let idx = gid.x + gid.y * uParams.dimX + gid.z * uParams.dimX * uParams.dimY;
    triCountBuffer[idx] = countCellTris(idx);
}

// ----------------------------
// Pass 3: emit mesh
// ----------------------------
fn computeZeroCrossings(
    idx: u32,
    outPts:  ptr<function, array<vec3<f32>,12>>,
    outNrm:  ptr<function, array<vec3<f32>,12>>
) -> u32 {
    let c = decodeCellCoords(idx);
    let base = uParams.boundsMin + vec3<f32>(f32(c.x), f32(c.y), f32(c.z)) * uParams.cellSize;
    var d0: array<f32,8>;
    var p0: array<vec3<f32>,8>;
    for (var i: u32 = 0u; i < 8u; i++) {
        let off = CORNER_OFFSETS[i];
        let pos = base + vec3<f32>(f32(off.x), f32(off.y), f32(off.z)) * uParams.cellSize;
        p0[i] = pos;
        d0[i] = sceneSDF(pos);
    }
    let eps = min(min(uParams.cellSize.x, uParams.cellSize.y), uParams.cellSize.z) * 0.5;
    var cnt: u32 = 0u;
    for (var e: u32 = 0u; e < 12u; e++) {
        let i0 = EDGE_PAIRS[e].x;
        let i1 = EDGE_PAIRS[e].y;
        if ((d0[i0] < 0.0) == (d0[i1] < 0.0)) { continue; }
        let ip = searchEdge(p0[i0], p0[i1]);
        (*outPts)[cnt] = ip;
        (*outNrm)[cnt] = faceNormal(ip, eps);
        cnt++;
    }
    return cnt;
}

fn solveQEF(
    pts: array<vec3<f32>,12>,
    nrms: array<vec3<f32>,12>,
    cnt: u32
) -> vec3<f32> {
    var A: mat3x3<f32> = mat3x3<f32>();
    var b: vec3<f32> = vec3<f32>(0.0);
    for (var i: u32 = 0u; i < cnt; i++) {
        let n = nrms[i];
        A[0][0] += n.x*n.x; A[0][1] += n.x*n.y; A[0][2] += n.x*n.z;
        A[1][0] += n.y*n.x; A[1][1] += n.y*n.y; A[1][2] += n.y*n.z;
        A[2][0] += n.z*n.x; A[2][1] += n.z*n.y; A[2][2] += n.z*n.z;
        b += n * dot(n, pts[i]);
    }
    let detA = determinant(A);
    if (abs(detA) < 1e-6) {
        var sum = vec3<f32>(0.0);
        for (var i: u32 = 0u; i < cnt; i++) { sum += pts[i]; }
        return sum / f32(cnt);
    }
    // Cramer
    var M = A;
    let bx = b.x; let by = b.y; let bz = b.z;
    var Ax = M; Ax[0] = vec3<f32>(bx, M[1][0], M[2][0]);
    var Ay = M; Ay[1] = vec3<f32>(by, M[1][1], M[2][1]);
    var Az = M; Az[2] = vec3<f32>(bz, M[1][2], M[2][2]);
    return vec3<f32>(determinant(Ax)/detA, determinant(Ay)/detA, determinant(Az)/detA);
}

@compute @workgroup_size(8, 8, 4)
fn emissionPass(@builtin(global_invocation_id) gid: vec3<u32>) {
    // Bounds check
    if (any(gid >= vec3<u32>(uParams.dimX, uParams.dimY, uParams.dimZ))) {
        return;
    }
    // Compute flat index
    let idx = gid.x + gid.y * uParams.dimX + gid.z * (uParams.dimX * uParams.dimY);
    let tc  = triCountBuffer[idx];
    if (tc == 0u) {
        return;
    }

    // Compute intersections & normals
    var pts: array<vec3<f32>, 12>;
    var nrms: array<vec3<f32>, 12>;
    let cnt = computeZeroCrossings(idx, &pts, &nrms);
    if (cnt == 0u) {
        return;
    }

    // Solve QEF for dual vertex
    let dv = solveQEF(pts, nrms, cnt);
    vertexBuffer[idx] = dv;

    // Prepare to emit triangles
    let c = decodeCellCoords(idx);
    let base = idx * (uParams.maxTrisPerCell * 3u);
    var off: u32 = 0u;

    // +X face: quad between cells (x,y,z),(x+1,y,z),(x,y+1,z),(x+1,y+1,z)
    if (c.x + 1u < uParams.dimX && cellActiveBuffer[idx + 1u] == 1u && cellActiveBuffer[idx + uParams.dimX] == 1u && cellActiveBuffer[idx + uParams.dimX + 1u] == 1u) {
        let c00 = idx;
        let c10 = idx + 1u;
        let c01 = idx + uParams.dimX;
        let c11 = idx + uParams.dimX + 1u;
        // Triangles: (c00, c01, c10), (c10, c01, c11)
        indexBuffer[base + off    ] = c00;
        indexBuffer[base + off + 1] = c01;
        indexBuffer[base + off + 2] = c10;
        off = off + 3u;
        indexBuffer[base + off    ] = c10;
        indexBuffer[base + off + 1] = c01;
        indexBuffer[base + off + 2] = c11;
        off = off + 3u;
    }

    // +Y face: quad between (x,y,z),(x,y+1,z),(x+1,y,z),(x+1,y+1,z)
    if (c.y + 1u < uParams.dimY && cellActiveBuffer[idx + uParams.dimX] == 1u && cellActiveBuffer[idx + 1u] == 1u && cellActiveBuffer[idx + uParams.dimX + 1u] == 1u) {
        let c00 = idx;
        let c10 = idx + uParams.dimX;
        let c01 = idx + 1u;
        let c11 = idx + uParams.dimX + 1u;
        // Triangles: (c00, c10, c01), (c01, c10, c11)
        indexBuffer[base + off    ] = c00;
        indexBuffer[base + off + 1] = c10;
        indexBuffer[base + off + 2] = c01;
        off = off + 3u;
        indexBuffer[base + off    ] = c01;
        indexBuffer[base + off + 1] = c10;
        indexBuffer[base + off + 2] = c11;
        off = off + 3u;
    }

    // +Z face: quad between (x,y,z),(x,y,z+1),(x+1,y,z),(x+1,y,z+1)
    if (c.z + 1u < uParams.dimZ && cellActiveBuffer[idx + uParams.dimX * uParams.dimY] == 1u && cellActiveBuffer[idx + 1u] == 1u && cellActiveBuffer[idx + uParams.dimX * uParams.dimY + 1u] == 1u) {
        let c00 = idx;
        let c10 = idx + uParams.dimX * uParams.dimY;
        let c01 = idx + 1u;
        let c11 = idx + uParams.dimX * uParams.dimY + 1u;
        // Triangles: (c00, c10, c01), (c01, c10, c11)
        indexBuffer[base + off    ] = c00;
        indexBuffer[base + off + 1] = c10;
        indexBuffer[base + off + 2] = c01;
        off = off + 3u;
        indexBuffer[base + off    ] = c01;
        indexBuffer[base + off + 1] = c10;
        indexBuffer[base + off + 2] = c11;
        off = off + 3u;
    }
}