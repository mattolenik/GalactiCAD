//:) include "hg_sdf.wgsl"
// ----------------------------
// Constants & Helpers
// ----------------------------

// Corner offsets for the 8 cube corners
const CORNER_OFFSETS: array<vec3<u32>, 8> = array(
    vec3<u32>(0,0,0), vec3<u32>(1,0,0),
    vec3<u32>(0,1,0), vec3<u32>(1,1,0),
    vec3<u32>(0,0,1), vec3<u32>(1,0,1),
    vec3<u32>(0,1,1), vec3<u32>(1,1,1)
);

// The 12 edges of a cube, each as a pair of corner indices
const EDGE_PAIRS: array<vec2<u32>, 12> = array(
    vec2<u32>(0,1), vec2<u32>(2,3), vec2<u32>(4,5), vec2<u32>(6,7),
    vec2<u32>(0,2), vec2<u32>(1,3), vec2<u32>(4,6), vec2<u32>(5,7),
    vec2<u32>(0,4), vec2<u32>(1,5), vec2<u32>(2,6), vec2<u32>(3,7)
);

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

@group(0) @binding(1) var<storage, read_write> cellActiveBuffer : array<u32>;  // [0/1 per cell]
@group(0) @binding(2) var<storage, read_write> triCountBuffer   : array<u32>;  // [numCells]
@group(0) @binding(3) var<storage, read_write> vertexBuffer     : array<vec3<f32>>; // [numCells]
@group(0) @binding(4) var<storage, read_write> indexBuffer      : array<u32>;    // [numCells*maxTrisPerCell*3]
@group(0) @binding(5) var<uniform> args: array<vec3f, 1024>;

// ----------------------------
// User’s SDF Stub (override at runtime)
// ----------------------------
fn sceneSDF(p: vec3<f32>) -> f32 {
    return 0f; //:) insert sceneSDF
}

// ----------------------------
// Decode linear index → (x,y,z)
// ----------------------------
fn decodeCellCoords(cellIndex: u32) -> vec3<u32> {
    let z = cellIndex / (uParams.dimX * uParams.dimY);
    let y = (cellIndex / uParams.dimX) % uParams.dimY;
    let x = cellIndex % uParams.dimX;
    return vec3<u32>(x,y,z);
}

// ----------------------------
// Classification: sign-change test
// ----------------------------
fn classifyCell(cellIndex: u32) -> u32 {
    let coords = decodeCellCoords(cellIndex);
    let basePos = uParams.boundsMin + vec3<f32>(f32(coords.x), f32(coords.y), f32(coords.z)) * uParams.cellSize;
    var sawInside:  bool = false;
    var sawOutside: bool = false;
    for (var i: u32 = 0u; i < 8u; i = i + 1u) {
        let off = CORNER_OFFSETS[i];
        let cornerPos = basePos + vec3<f32>(f32(off.x), f32(off.y), f32(off.z)) * uParams.cellSize;
        let d = sceneSDF(cornerPos);
        sawInside  = sawInside  || (d < 0.0);
        sawOutside = sawOutside || (d >= 0.0);
        if (sawInside && sawOutside) { return 1u; }
    }
    return 0u;
}

// ----------------------------
// Count quads → triangle count
// ----------------------------
fn countCellTris(cellIndex: u32) -> u32 {
    let coords = decodeCellCoords(cellIndex);
    var quadCount: u32 = 0u;
    // +X neighbor
    if (coords.x + 1u < uParams.dimX) {
        let nIdx = cellIndex + 1u;
        if (cellActiveBuffer[nIdx] == 1u) { quadCount = quadCount + 1u; }
    }
    // +Y neighbor
    if (coords.y + 1u < uParams.dimY) {
        let nIdx = cellIndex + uParams.dimX;
        if (cellActiveBuffer[nIdx] == 1u) { quadCount = quadCount + 1u; }
    }
    // +Z neighbor
    if (coords.z + 1u < uParams.dimZ) {
        let nIdx = cellIndex + uParams.dimX * uParams.dimY;
        if (cellActiveBuffer[nIdx] == 1u) { quadCount = quadCount + 1u; }
    }
    return quadCount * 2u;
}

// ----------------------------
// Zero-crossings & normals
// ----------------------------
fn computeZeroCrossings(cellIndex: u32, outPoints: ptr<function, array<vec3<f32>,12>>, outNormals: ptr<function, array<vec3<f32>,12>>) -> u32 {
    let coords = decodeCellCoords(cellIndex);
    let basePos = uParams.boundsMin + vec3<f32>(f32(coords.x), f32(coords.y), f32(coords.z)) * uParams.cellSize;
    var cornerPos: array<vec3<f32>, 8>;
    var cornerD:   array<f32, 8>;
    for (var i: u32 = 0u; i < 8u; i = i + 1u) {
        let off = CORNER_OFFSETS[i];
        let wpos = basePos + vec3<f32>(f32(off.x), f32(off.y), f32(off.z)) * uParams.cellSize;
        cornerPos[i] = wpos;
        cornerD[i] = sceneSDF(wpos);
    }
    let eps = min(min(uParams.cellSize.x, uParams.cellSize.y), uParams.cellSize.z) * 0.5;
    var count: u32 = 0u;
    for (var e: u32 = 0u; e < 12u; e = e + 1u) {
        let p = EDGE_PAIRS[e].x;
        let q = EDGE_PAIRS[e].y;
        let d0 = cornerD[p];
        let d1 = cornerD[q];
        if ((d0 < 0.0 && d1 < 0.0) || (d0 >= 0.0 && d1 >= 0.0)) { continue; }
        var p0 = cornerPos[p]; var p1 = cornerPos[q]; var s0 = d0; var s1 = d1;
        for (var it: u32 = 0u; it < 5u; it = it + 1u) {
            let mid = (p0 + p1) * 0.5;
            let dm  = sceneSDF(mid);
            if ((dm < 0.0) == (s0 < 0.0)) { p0 = mid; s0 = dm; } else { p1 = mid; s1 = dm; }
        }
        let ipos = (p0 + p1) * 0.5;
        (*outPoints)[count] = ipos;
        let nx = sceneSDF(ipos + vec3<f32>(eps,0,0)) - sceneSDF(ipos - vec3<f32>(eps,0,0));
        let ny = sceneSDF(ipos + vec3<f32>(0,eps,0)) - sceneSDF(ipos - vec3<f32>(0,eps,0));
        let nz = sceneSDF(ipos + vec3<f32>(0,0,eps)) - sceneSDF(ipos - vec3<f32>(0,0,eps));
        (*outNormals)[count] = normalize(vec3<f32>(nx, ny, nz));
        count = count + 1u;
    }
    return count;
}

// ----------------------------
// Solve QEF by Cramer’s rule
// ----------------------------
fn solveQEF(points: array<vec3<f32>,12>, normals: array<vec3<f32>,12>, cnt: u32) -> vec3<f32> {
    var ATA = mat3x3<f32>(vec3<f32>(0.0), vec3<f32>(0.0), vec3<f32>(0.0));
    var ATb = vec3<f32>(0.0);
    for (var i: u32 = 0u; i < cnt; i = i + 1u) {
        let n = normals[i]; let p = points[i];
        ATA[0][0] = ATA[0][0] + n.x*n.x; ATA[0][1] = ATA[0][1] + n.x*n.y; ATA[0][2] = ATA[0][2] + n.x*n.z;
        ATA[1][0] = ATA[1][0] + n.y*n.x; ATA[1][1] = ATA[1][1] + n.y*n.y; ATA[1][2] = ATA[1][2] + n.y*n.z;
        ATA[2][0] = ATA[2][0] + n.z*n.x; ATA[2][1] = ATA[2][1] + n.z*n.y; ATA[2][2] = ATA[2][2] + n.z*n.z;
        ATb = ATb + n * dot(n, p);
    }
    let detA = determinant(ATA);
    if (abs(detA) < 1e-6) {
        var sum = vec3<f32>(0.0);
        for (var i: u32 = 0u; i < cnt; i = i + 1u) { sum = sum + points[i]; }
        return sum / f32(cnt);
    }
    var M = ATA; let bx = ATb.x; let by = ATb.y; let bz = ATb.z;
    var Ax = M; Ax[0] = vec3<f32>(bx, M[1][0], M[2][0]); Ax[1] = vec3<f32>(by, M[1][1], M[2][1]); Ax[2] = vec3<f32>(bz, M[1][2], M[2][2]);
    var Ay = M; Ay[0] = vec3<f32>(M[0][0], bx, M[2][0]); Ay[1] = vec3<f32>(M[0][1], by, M[2][1]); Ay[2] = vec3<f32>(M[0][2], bz, M[2][2]);
    var Az = M; Az[0] = vec3<f32>(M[0][0], M[1][0], bx); Az[1] = vec3<f32>(M[0][1], M[1][1], by); Az[2] = vec3<f32>(M[0][2], M[1][2], bz);
    return vec3<f32>(determinant(Ax), determinant(Ay), determinant(Az)) / detA;
}

// ----------------------------
// Pass 1: classification & tri-count
// ----------------------------
@compute @workgroup_size(8, 8, 4)
fn classifyPass(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= uParams.dimX || gid.y >= uParams.dimY || gid.z >= uParams.dimZ) { return; }
    let idx    = gid.x + gid.y * uParams.dimX + gid.z * uParams.dimX * uParams.dimY;
    let actve = classifyCell(idx);
    cellActiveBuffer[idx] = actve;
    triCountBuffer[idx]   = select(0u, countCellTris(idx), actve == 1u);
}

// ----------------------------
// Pass 2: compute dual-verts & emit indices
// ----------------------------
@compute @workgroup_size(8, 8, 4)
fn emissionPass(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= uParams.dimX || gid.y >= uParams.dimY || gid.z >= uParams.dimZ) { return; }
    let idx       = gid.x + gid.y * uParams.dimX + gid.z * uParams.dimX * uParams.dimY;
    let triCount  = triCountBuffer[idx];
    if (triCount == 0u) { return; }

    var pts : array<vec3<f32>,12>;
    var nrm : array<vec3<f32>,12>;
    let cnt      = computeZeroCrossings(idx, &pts, &nrm);
    let dualVert = solveQEF(pts, nrm, cnt);
    vertexBuffer[idx] = dualVert;

    // Emit indexed triangles for each axis-aligned face
    let coords = decodeCellCoords(idx);
    let base   = idx * (uParams.maxTrisPerCell * 3u);
    var off    = 0u;
    
    // +X face
    if (coords.x + 1u < uParams.dimX && cellActiveBuffer[idx+1u] == 1u) {
        let nIdx = idx + 1u;
        let c00 = idx; let c10 = nIdx;
        let c01 = idx + uParams.dimX * uParams.dimY;
        let c11 = nIdx + uParams.dimX * uParams.dimY;
        indexBuffer[base+off    ] = c00; indexBuffer[base+off+1] = c01; indexBuffer[base+off+2] = c10;
        indexBuffer[base+off+3  ] = c10; indexBuffer[base+off+4] = c01; indexBuffer[base+off+5] = c11;
        off = off + 6u;
    }
    // +Y face
    if (coords.y + 1u < uParams.dimY && cellActiveBuffer[idx+uParams.dimX] == 1u) {
        let nIdx = idx + uParams.dimX;
        let c00 = idx; let c10 = nIdx;
        let c01 = idx + uParams.dimX * uParams.dimY;
        let c11 = nIdx + uParams.dimX * uParams.dimY;
        indexBuffer[base+off    ] = c00; indexBuffer[base+off+1] = c10; indexBuffer[base+off+2] = c01;
        indexBuffer[base+off+3  ] = c10; indexBuffer[base+off+4] = c11; indexBuffer[base+off+5] = c01;
        off = off + 6u;
    }
    // +Z face
    if (coords.z + 1u < uParams.dimZ && cellActiveBuffer[idx+uParams.dimX*uParams.dimY] == 1u) {
        let nIdx = idx + uParams.dimX * uParams.dimY;
        let c00 = idx; let c10 = nIdx;
        let c01 = idx + 1u;
        let c11 = nIdx + 1u;
        indexBuffer[base+off    ] = c00; indexBuffer[base+off+1] = c01; indexBuffer[base+off+2] = c10;
        indexBuffer[base+off+3  ] = c10; indexBuffer[base+off+4] = c01; indexBuffer[base+off+5] = c11;
        off = off + 6u;
    }
}
