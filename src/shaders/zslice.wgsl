//:) include "hg_sdf.wgsl"

// Z-slice meshing via slab-by-slab marching tetrahedra.
// The pipeline is:
// - evalSlice: evaluate SDF on an (x,y) grid for a given zIndex
// - countSlabTriangles: count triangles for slab between zIndex and zIndex+1 (uses two slices)
// - emitSlabTriangles: emit triangle soup (duplicated vertices) for slab
//
// This design keeps memory O(Nx*Ny) for SDF samples and allows fine zStep (e.g. 0.02mm).

struct SharedUniforms {
    // gridDims.xy = number of sample points in x/y (NOT cells)
    // gridDims.z  = unused (reserved)
    // gridDims.w  = unused (reserved)
    gridDims: vec4u,
    // gridOffset.xyz is min corner in world units (mm)
    gridOffset: vec4f,
    // steps.xyz are sample steps in world units, steps.w is isoValue
    steps: vec4f,
}

struct SlabUniforms {
    // For evalSlice: zIndex of the plane being evaluated.
    // For slab passes: zIndex of the LOWER plane of the slab (upper is zIndex+1).
    zIndex: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
}

struct Vertex {
    position: vec3f,
    normal: vec3f,
}

@group(0) @binding(0) var<uniform> uniforms: SharedUniforms;
@group(0) @binding(1) var<uniform> slab: SlabUniforms;

// Slice evaluation target (Nx*Ny floats).
@group(0) @binding(2) var<storage, read_write> sliceTarget: array<f32>;

// Two slices (Nx*Ny floats each) for slab processing.
@group(0) @binding(3) var<storage, read> slice0: array<f32>;
@group(0) @binding(4) var<storage, read> slice1: array<f32>;

// Triangle counter for counting pass (counts TRIANGLES, not vertices).
@group(0) @binding(5) var<storage, read_write> triangleCount: atomic<u32>;

// Vertex counter for emit pass (counts VERTICES, not triangles).
@group(0) @binding(6) var<storage, read_write> vertexCount: atomic<u32>;
@group(0) @binding(7) var<storage, read_write> vertices: array<Vertex>;
@group(0) @binding(8) var<storage, read_write> indices: array<u32>;

// Placeholder for the actual scene Signed Distance Function
fn sceneSDF(p: vec3f) -> f32 {
    return 0.0; //:) insert sceneSDF
}

fn sampleSDF(p: vec3f) -> f32 {
    return sceneSDF(p) - uniforms.steps.w;
}

fn gridX() -> u32 { return uniforms.gridDims.x; }
fn gridY() -> u32 { return uniforms.gridDims.y; }
fn gridZ() -> u32 { return uniforms.gridDims.z; }

fn stepX() -> f32 { return uniforms.steps.x; }
fn stepY() -> f32 { return uniforms.steps.y; }
fn stepZ() -> f32 { return uniforms.steps.z; }

fn sliceIndex(x: u32, y: u32) -> u32 {
    return x + y * gridX();
}

fn gridToWorldPoint(x: u32, y: u32, zIndex: u32) -> vec3f {
    return vec3f(
        uniforms.gridOffset.x + f32(x) * stepX(),
        uniforms.gridOffset.y + f32(y) * stepY(),
        uniforms.gridOffset.z + f32(zIndex) * stepZ()
    );
}

fn mix3(a: vec3f, b: vec3f, t: f32) -> vec3f {
    return a * (1.0 - t) + b * t;
}

fn interpIso(p0: vec3f, p1: vec3f, v0: f32, v1: f32) -> vec3f {
    let denom = (v0 - v1);
    var t = 0.5;
    if (abs(denom) > 1e-20) {
        // For iso=0: t = v0 / (v0 - v1)
        t = clamp(v0 / denom, 0.0, 1.0);
    }
    // Linear edge interpolation finds the isosurface of the *interpolated* scalar field.
    // To reduce beveling/artifacts on sharp features (e.g. boxes), we do one SDF projection
    // step onto the true implicit surface: p <- p - sdf(p) * grad(p).
    var p = mix3(p0, p1, t);
    let d = sampleSDF(p);
    p = p - d * computeGradient(p);
    return p;
}

fn computeGradient(p: vec3f) -> vec3f {
    // Use a small epsilon tied to sampling density (anisotropic).
    let eps = max(1e-6, min(stepX(), min(stepY(), stepZ())) * 0.5);
    let dx = sampleSDF(p + vec3f(eps, 0.0, 0.0)) - sampleSDF(p - vec3f(eps, 0.0, 0.0));
    let dy = sampleSDF(p + vec3f(0.0, eps, 0.0)) - sampleSDF(p - vec3f(0.0, eps, 0.0));
    let dz = sampleSDF(p + vec3f(0.0, 0.0, eps)) - sampleSDF(p - vec3f(0.0, 0.0, eps));
    let g = vec3f(dx, dy, dz);
    let len = length(g);
    if (len == 0.0) { return vec3f(0.0, 1.0, 0.0); }
    return g / len;
}

fn emitTriangle(p0: vec3f, p1: vec3f, p2: vec3f) {
    // Ensure we don't write out of bounds.
    let cap = arrayLength(&vertices);
    let base = atomicAdd(&vertexCount, 3u);
    if (base + 2u >= cap) {
        return;
    }

    // Orient triangle so that face normal roughly matches SDF gradient (outward).
    let e0 = p1 - p0;
    let e1 = p2 - p0;
    var faceN = cross(e0, e1);
    let nlen = length(faceN);
    if (nlen > 0.0) { faceN = faceN / nlen; }

    let c = (p0 + p1 + p2) * (1.0 / 3.0);
    let gn = computeGradient(c);
    var a = p0;
    var b = p1;
    var c2 = p2;
    if (dot(faceN, gn) < 0.0) {
        // swap b and c2
        let tmp = b;
        b = c2;
        c2 = tmp;
    }

    let n0 = computeGradient(a);
    let n1 = computeGradient(b);
    let n2 = computeGradient(c2);

    vertices[base + 0u] = Vertex(a, n0);
    vertices[base + 1u] = Vertex(b, n1);
    vertices[base + 2u] = Vertex(c2, n2);
    // Triangle soup indices are sequential.
    indices[base + 0u] = base + 0u;
    indices[base + 1u] = base + 1u;
    indices[base + 2u] = base + 2u;
}

fn countOneBits4(mask: u32) -> u32 {
    // mask is only in [0,15]
    return countOneBits(mask);
}

// Marching tetrahedra on a tetrahedron with vertices (p,v) in arrays of length 4.
// Returns number of triangles emitted (0,1,2) for counting pass, and emits in emit pass.
fn tetraTriCount(v0: f32, v1: f32, v2: f32, v3: f32) -> u32 {
    let m =
        (select(0u, 1u, v0 < 0.0) << 0u) |
        (select(0u, 1u, v1 < 0.0) << 1u) |
        (select(0u, 1u, v2 < 0.0) << 2u) |
        (select(0u, 1u, v3 < 0.0) << 3u);
    let c = countOneBits4(m);
    if (c == 0u || c == 4u) { return 0u; }
    if (c == 1u || c == 3u) { return 1u; }
    return 2u;
}

fn emitTetra(p0: vec3f, p1: vec3f, p2: vec3f, p3: vec3f, v0: f32, v1: f32, v2: f32, v3: f32) {
    // mask bits are "inside" (v < 0)
    var mask =
        (select(0u, 1u, v0 < 0.0) << 0u) |
        (select(0u, 1u, v1 < 0.0) << 1u) |
        (select(0u, 1u, v2 < 0.0) << 2u) |
        (select(0u, 1u, v3 < 0.0) << 3u);
    var cnt = countOneBits4(mask);
    if (cnt == 0u || cnt == 4u) { return; }

    // For the 3-inside case, flip (treat the single outside as the "inside" of a flipped tetra)
    var flip = false;
    if (cnt == 3u) {
        flip = true;
        mask = (~mask) & 15u;
        // After flipping, there is exactly 1 "inside" vertex.
        cnt = 1u;
    }

    // Identify inside/outside vertex indices.
    // WGSL doesn't allow variable-length arrays, so we branch on the mask patterns.
    // We'll map indices explicitly in a compact way.
    var i0: u32 = 0u;
    var o0: u32 = 0u;
    var o1: u32 = 0u;
    var o2: u32 = 0u;
    var i1: u32 = 0u;

    // Helper lambdas (inline via selects) are not supported; do it directly.
    if (cnt == 1u) {
        // find the single inside vertex i0
        if ((mask & 1u) != 0u) { i0 = 0u; o0 = 1u; o1 = 2u; o2 = 3u; }
        else if ((mask & 2u) != 0u) { i0 = 1u; o0 = 0u; o1 = 2u; o2 = 3u; }
        else if ((mask & 4u) != 0u) { i0 = 2u; o0 = 0u; o1 = 1u; o2 = 3u; }
        else { i0 = 3u; o0 = 0u; o1 = 1u; o2 = 2u; }

        // fetch positions/values by index
        var pi: vec3f = p0;
        var vi: f32 = v0;
        if (i0 == 1u) { pi = p1; vi = v1; }
        if (i0 == 2u) { pi = p2; vi = v2; }
        if (i0 == 3u) { pi = p3; vi = v3; }

        var pA: vec3f = p0; var vA: f32 = v0;
        var pB: vec3f = p0; var vB: f32 = v0;
        var pC: vec3f = p0; var vC: f32 = v0;
        if (o0 == 1u) { pA = p1; vA = v1; }
        if (o0 == 2u) { pA = p2; vA = v2; }
        if (o0 == 3u) { pA = p3; vA = v3; }
        if (o1 == 1u) { pB = p1; vB = v1; }
        if (o1 == 2u) { pB = p2; vB = v2; }
        if (o1 == 3u) { pB = p3; vB = v3; }
        if (o2 == 1u) { pC = p1; vC = v1; }
        if (o2 == 2u) { pC = p2; vC = v2; }
        if (o2 == 3u) { pC = p3; vC = v3; }

        let q0 = interpIso(pi, pA, vi, vA);
        let q1 = interpIso(pi, pB, vi, vB);
        let q2 = interpIso(pi, pC, vi, vC);

        if (!flip) {
            emitTriangle(q0, q1, q2);
        } else {
            emitTriangle(q0, q2, q1);
        }
        return;
    }

    // cnt == 2
    // Two inside vertices i0,i1 and two outside o0,o1
    // We enumerate possible combinations by scanning bits.
    // i0 = first set bit
    if ((mask & 1u) != 0u) { i0 = 0u; }
    else if ((mask & 2u) != 0u) { i0 = 1u; }
    else if ((mask & 4u) != 0u) { i0 = 2u; }
    else { i0 = 3u; }

    // i1 = second set bit
    if (i0 == 0u) {
        if ((mask & 2u) != 0u) { i1 = 1u; }
        else if ((mask & 4u) != 0u) { i1 = 2u; }
        else { i1 = 3u; }
    } else if (i0 == 1u) {
        if ((mask & 4u) != 0u) { i1 = 2u; }
        else { i1 = 3u; }
    } else {
        i1 = 3u;
    }

    // outside vertices are the remaining two
    var outMask = (~mask) & 15u;
    if ((outMask & 1u) != 0u) { o0 = 0u; }
    else if ((outMask & 2u) != 0u) { o0 = 1u; }
    else if ((outMask & 4u) != 0u) { o0 = 2u; }
    else { o0 = 3u; }

    // o1 is the other outside
    if (o0 == 0u) {
        if ((outMask & 2u) != 0u) { o1 = 1u; }
        else if ((outMask & 4u) != 0u) { o1 = 2u; }
        else { o1 = 3u; }
    } else if (o0 == 1u) {
        if ((outMask & 4u) != 0u) { o1 = 2u; }
        else { o1 = 3u; }
    } else {
        o1 = 3u;
    }

    var pI0: vec3f = p0; var vI0: f32 = v0;
    var pI1: vec3f = p0; var vI1: f32 = v0;
    var pO0: vec3f = p0; var vO0: f32 = v0;
    var pO1: vec3f = p0; var vO1: f32 = v0;

    if (i0 == 1u) { pI0 = p1; vI0 = v1; }
    if (i0 == 2u) { pI0 = p2; vI0 = v2; }
    if (i0 == 3u) { pI0 = p3; vI0 = v3; }
    if (i1 == 1u) { pI1 = p1; vI1 = v1; }
    if (i1 == 2u) { pI1 = p2; vI1 = v2; }
    if (i1 == 3u) { pI1 = p3; vI1 = v3; }
    if (o0 == 1u) { pO0 = p1; vO0 = v1; }
    if (o0 == 2u) { pO0 = p2; vO0 = v2; }
    if (o0 == 3u) { pO0 = p3; vO0 = v3; }
    if (o1 == 1u) { pO1 = p1; vO1 = v1; }
    if (o1 == 2u) { pO1 = p2; vO1 = v2; }
    if (o1 == 3u) { pO1 = p3; vO1 = v3; }

    // Four edge intersections define a quad; triangulate consistently.
    let q0 = interpIso(pI0, pO0, vI0, vO0);
    let q1 = interpIso(pI0, pO1, vI0, vO1);
    let q2 = interpIso(pI1, pO0, vI1, vO0);
    let q3 = interpIso(pI1, pO1, vI1, vO1);

    if (!flip) {
        // Two triangles (q0, q1, q3) and (q0, q3, q2)
        emitTriangle(q0, q1, q3);
        emitTriangle(q0, q3, q2);
    } else {
        emitTriangle(q0, q3, q1);
        emitTriangle(q0, q2, q3);
    }
}

@compute @workgroup_size(8, 8, 1)
fn evalSlice(@builtin(global_invocation_id) gid: vec3u) {
    let x = gid.x;
    let y = gid.y;
    if (x >= gridX() || y >= gridY()) { return; }
    let p = gridToWorldPoint(x, y, slab.zIndex);
    let v = sampleSDF(p);
    sliceTarget[sliceIndex(x, y)] = v;
}

var<workgroup> wgCounts: array<u32, 64>;

// Count triangles for a slab using marching tetrahedra (6 tets per cell).
@compute @workgroup_size(8, 8, 1)
fn countSlabTriangles(@builtin(local_invocation_id) lid: vec3u, @builtin(global_invocation_id) gid: vec3u) {
    let x = gid.x;
    let y = gid.y;
    // IMPORTANT: workgroupBarrier() must be called from uniform control flow.
    // So we avoid early returns and always participate in the reduction.
    var t: u32 = 0u;
    if (x + 1u < gridX() && y + 1u < gridY()) {
        let i00 = sliceIndex(x, y);
        let i10 = sliceIndex(x + 1u, y);
        let i01 = sliceIndex(x, y + 1u);
        let i11 = sliceIndex(x + 1u, y + 1u);

        // 8 corners (lower z slice0, upper z slice1)
        let v0 = slice0[i00];
        let v1 = slice0[i10];
        let v2 = slice0[i01];
        let v3 = slice0[i11];
        let v4 = slice1[i00];
        let v5 = slice1[i10];
        let v6 = slice1[i01];
        let v7 = slice1[i11];

        // 6 tetrahedra: (0,1,3,7), (0,3,2,7), (0,2,6,7), (0,6,4,7), (0,4,5,7), (0,5,1,7)
        t = t + tetraTriCount(v0, v1, v3, v7);
        t = t + tetraTriCount(v0, v3, v2, v7);
        t = t + tetraTriCount(v0, v2, v6, v7);
        t = t + tetraTriCount(v0, v6, v4, v7);
        t = t + tetraTriCount(v0, v4, v5, v7);
        t = t + tetraTriCount(v0, v5, v1, v7);
    }

    let li = lid.x + lid.y * 8u;
    wgCounts[li] = t;
    workgroupBarrier();

    // Parallel reduction to one atomicAdd per workgroup.
    var stride = 32u;
    while (stride > 0u) {
        if (li < stride) { wgCounts[li] = wgCounts[li] + wgCounts[li + stride]; }
        stride = stride >> 1u;
        workgroupBarrier();
    }
    if (li == 0u) {
        atomicAdd(&triangleCount, wgCounts[0u]);
    }
}

// Emit slab triangles into triangle soup buffers.
@compute @workgroup_size(8, 8, 1)
fn emitSlabTriangles(@builtin(global_invocation_id) gid: vec3u) {
    let x = gid.x;
    let y = gid.y;
    if (x + 1u >= gridX() || y + 1u >= gridY()) { return; }

    let i00 = sliceIndex(x, y);
    let i10 = sliceIndex(x + 1u, y);
    let i01 = sliceIndex(x, y + 1u);
    let i11 = sliceIndex(x + 1u, y + 1u);

    let v0 = slice0[i00];
    let v1 = slice0[i10];
    let v2 = slice0[i01];
    let v3 = slice0[i11];
    let v4 = slice1[i00];
    let v5 = slice1[i10];
    let v6 = slice1[i01];
    let v7 = slice1[i11];

    // Compute the 8 corner positions for this cell and slab.
    let z0 = slab.zIndex;
    let base = gridToWorldPoint(x, y, z0);
    let dx = vec3f(stepX(), 0.0, 0.0);
    let dy = vec3f(0.0, stepY(), 0.0);
    let dz = vec3f(0.0, 0.0, stepZ());

    let p0 = base;
    let p1 = base + dx;
    let p2 = base + dy;
    let p3 = base + dx + dy;
    let p4 = base + dz;
    let p5 = base + dx + dz;
    let p6 = base + dy + dz;
    let p7 = base + dx + dy + dz;

    // Emit triangles for the 6 tetrahedra
    emitTetra(p0, p1, p3, p7, v0, v1, v3, v7);
    emitTetra(p0, p3, p2, p7, v0, v3, v2, v7);
    emitTetra(p0, p2, p6, p7, v0, v2, v6, v7);
    emitTetra(p0, p6, p4, p7, v0, v6, v4, v7);
    emitTetra(p0, p4, p5, p7, v0, v4, v5, v7);
    emitTetra(p0, p5, p1, p7, v0, v5, v1, v7);
}

// ===========================
// Fully-parallel 3D slab pass
// ===========================
//
// These entry points process the entire (x,y,z) cell grid in one dispatch.
// This avoids per-slice CPU orchestration while still using z-step sampling.

fn cellCountX() -> u32 { return gridX() - 1u; }
fn cellCountY() -> u32 { return gridY() - 1u; }
fn cellCountZ() -> u32 { return gridZ() - 1u; }

fn cellRadius() -> f32 {
    // Max distance from cell center to any point in the cell (half diagonal).
    return 0.5 * length(vec3f(stepX(), stepY(), stepZ()));
}

@compute @workgroup_size(4, 4, 4)
fn countAllSlabsTriangles3D(
    @builtin(local_invocation_id) lid: vec3u,
    @builtin(global_invocation_id) gid: vec3u
) {
    let cx = gid.x;
    let cy = gid.y;
    let cz = gid.z;

    // Default to zero so out-of-range invocations still participate in reduction.
    var t: u32 = 0u;

    if (cx < cellCountX() && cy < cellCountY() && cz < cellCountZ()) {
        let base = gridToWorldPoint(cx, cy, cz);
        let dx = vec3f(stepX(), 0.0, 0.0);
        let dy = vec3f(0.0, stepY(), 0.0);
        let dz = vec3f(0.0, 0.0, stepZ());

        // --- Narrow-band culling + simple adaptive refinement ---
        // For a true SDF (Lipschitz <= 1), if |d(center)| > cellRadius, the surface cannot intersect the cell.
        // This both speeds up meshing and lets us locally refine only near the surface.
        let center = base + 0.5 * dx + 0.5 * dy + 0.5 * dz;
        let vc = sampleSDF(center);
        let rad = cellRadius();
        if (abs(vc) <= rad * 1.05) {
            // Refine by 2x near the surface band.
            let refine2 = abs(vc) < rad * 0.25;

            if (!refine2) {
                let p0 = base;
                let p1 = base + dx;
                let p2 = base + dy;
                let p3 = base + dx + dy;
                let p4 = base + dz;
                let p5 = base + dx + dz;
                let p6 = base + dy + dz;
                let p7 = base + dx + dy + dz;

                let v0 = sampleSDF(p0);
                let v1 = sampleSDF(p1);
                let v2 = sampleSDF(p2);
                let v3 = sampleSDF(p3);
                let v4 = sampleSDF(p4);
                let v5 = sampleSDF(p5);
                let v6 = sampleSDF(p6);
                let v7 = sampleSDF(p7);

                // 6 tetrahedra
                t = t + tetraTriCount(v0, v1, v3, v7);
                t = t + tetraTriCount(v0, v3, v2, v7);
                t = t + tetraTriCount(v0, v2, v6, v7);
                t = t + tetraTriCount(v0, v6, v4, v7);
                t = t + tetraTriCount(v0, v4, v5, v7);
                t = t + tetraTriCount(v0, v5, v1, v7);
            } else {
                // Sample a 3x3x3 grid at half-step resolution within this cell, then run 8 sub-cells.
                let dxh = 0.5 * dx;
                let dyh = 0.5 * dy;
                let dzh = 0.5 * dz;

                var vg: array<f32, 27>;
                // Fill vg[ix + 3*iy + 9*iz], where ix/iy/iz in {0,1,2} correspond to 0, 0.5, 1.0 along each axis.
                for (var iz = 0u; iz < 3u; iz = iz + 1u) {
                    for (var iy = 0u; iy < 3u; iy = iy + 1u) {
                        for (var ix = 0u; ix < 3u; ix = ix + 1u) {
                            let p = base + f32(ix) * dxh + f32(iy) * dyh + f32(iz) * dzh;
                            vg[ix + 3u * iy + 9u * iz] = sampleSDF(p);
                        }
                    }
                }

                // Iterate 2x2x2 subcells.
                for (var sz = 0u; sz < 2u; sz = sz + 1u) {
                    for (var sy = 0u; sy < 2u; sy = sy + 1u) {
                        for (var sx = 0u; sx < 2u; sx = sx + 1u) {
                            // corners in vg at (sx,sy,sz) and (sx+1, sy+1, sz+1)
                            let i000 = (sx + 0u) + 3u * (sy + 0u) + 9u * (sz + 0u);
                            let i100 = (sx + 1u) + 3u * (sy + 0u) + 9u * (sz + 0u);
                            let i010 = (sx + 0u) + 3u * (sy + 1u) + 9u * (sz + 0u);
                            let i110 = (sx + 1u) + 3u * (sy + 1u) + 9u * (sz + 0u);
                            let i001 = (sx + 0u) + 3u * (sy + 0u) + 9u * (sz + 1u);
                            let i101 = (sx + 1u) + 3u * (sy + 0u) + 9u * (sz + 1u);
                            let i011 = (sx + 0u) + 3u * (sy + 1u) + 9u * (sz + 1u);
                            let i111 = (sx + 1u) + 3u * (sy + 1u) + 9u * (sz + 1u);

                            let v0 = vg[i000];
                            let v1 = vg[i100];
                            let v2 = vg[i010];
                            let v3 = vg[i110];
                            let v4 = vg[i001];
                            let v5 = vg[i101];
                            let v6 = vg[i011];
                            let v7 = vg[i111];

                            // 6 tetrahedra within the subcell
                            t = t + tetraTriCount(v0, v1, v3, v7);
                            t = t + tetraTriCount(v0, v3, v2, v7);
                            t = t + tetraTriCount(v0, v2, v6, v7);
                            t = t + tetraTriCount(v0, v6, v4, v7);
                            t = t + tetraTriCount(v0, v4, v5, v7);
                            t = t + tetraTriCount(v0, v5, v1, v7);
                        }
                    }
                }
            }
        }
    }

    let li = lid.x + lid.y * 4u + lid.z * 16u; // 4*4*4 = 64
    wgCounts[li] = t;
    workgroupBarrier();

    // reduction to wgCounts[0]
    var stride = 32u;
    while (stride > 0u) {
        if (li < stride) {
            wgCounts[li] = wgCounts[li] + wgCounts[li + stride];
        }
        stride = stride >> 1u;
        workgroupBarrier();
    }

    if (li == 0u) {
        atomicAdd(&triangleCount, wgCounts[0u]);
    }
}

@compute @workgroup_size(4, 4, 4)
fn emitAllSlabsTriangles3D(@builtin(global_invocation_id) gid: vec3u) {
    let cx = gid.x;
    let cy = gid.y;
    let cz = gid.z;
    if (cx >= cellCountX() || cy >= cellCountY() || cz >= cellCountZ()) { return; }

    let base = gridToWorldPoint(cx, cy, cz);
    let dx = vec3f(stepX(), 0.0, 0.0);
    let dy = vec3f(0.0, stepY(), 0.0);
    let dz = vec3f(0.0, 0.0, stepZ());

    let center = base + 0.5 * dx + 0.5 * dy + 0.5 * dz;
    let vc = sampleSDF(center);
    let rad = cellRadius();
    if (abs(vc) > rad * 1.05) { return; }

    let refine2 = abs(vc) < rad * 0.25;
    if (!refine2) {
        let p0 = base;
        let p1 = base + dx;
        let p2 = base + dy;
        let p3 = base + dx + dy;
        let p4 = base + dz;
        let p5 = base + dx + dz;
        let p6 = base + dy + dz;
        let p7 = base + dx + dy + dz;

        let v0 = sampleSDF(p0);
        let v1 = sampleSDF(p1);
        let v2 = sampleSDF(p2);
        let v3 = sampleSDF(p3);
        let v4 = sampleSDF(p4);
        let v5 = sampleSDF(p5);
        let v6 = sampleSDF(p6);
        let v7 = sampleSDF(p7);

        emitTetra(p0, p1, p3, p7, v0, v1, v3, v7);
        emitTetra(p0, p3, p2, p7, v0, v3, v2, v7);
        emitTetra(p0, p2, p6, p7, v0, v2, v6, v7);
        emitTetra(p0, p6, p4, p7, v0, v6, v4, v7);
        emitTetra(p0, p4, p5, p7, v0, v4, v5, v7);
        emitTetra(p0, p5, p1, p7, v0, v5, v1, v7);
    } else {
        let dxh = 0.5 * dx;
        let dyh = 0.5 * dy;
        let dzh = 0.5 * dz;

        var vg: array<f32, 27>;
        for (var iz = 0u; iz < 3u; iz = iz + 1u) {
            for (var iy = 0u; iy < 3u; iy = iy + 1u) {
                for (var ix = 0u; ix < 3u; ix = ix + 1u) {
                    let p = base + f32(ix) * dxh + f32(iy) * dyh + f32(iz) * dzh;
                    vg[ix + 3u * iy + 9u * iz] = sampleSDF(p);
                }
            }
        }

        for (var sz = 0u; sz < 2u; sz = sz + 1u) {
            for (var sy = 0u; sy < 2u; sy = sy + 1u) {
                for (var sx = 0u; sx < 2u; sx = sx + 1u) {
                    let subBase = base + f32(sx) * dxh + f32(sy) * dyh + f32(sz) * dzh;

                    let p0 = subBase;
                    let p1 = subBase + dxh;
                    let p2 = subBase + dyh;
                    let p3 = subBase + dxh + dyh;
                    let p4 = subBase + dzh;
                    let p5 = subBase + dxh + dzh;
                    let p6 = subBase + dyh + dzh;
                    let p7 = subBase + dxh + dyh + dzh;

                    let i000 = (sx + 0u) + 3u * (sy + 0u) + 9u * (sz + 0u);
                    let i100 = (sx + 1u) + 3u * (sy + 0u) + 9u * (sz + 0u);
                    let i010 = (sx + 0u) + 3u * (sy + 1u) + 9u * (sz + 0u);
                    let i110 = (sx + 1u) + 3u * (sy + 1u) + 9u * (sz + 0u);
                    let i001 = (sx + 0u) + 3u * (sy + 0u) + 9u * (sz + 1u);
                    let i101 = (sx + 1u) + 3u * (sy + 0u) + 9u * (sz + 1u);
                    let i011 = (sx + 0u) + 3u * (sy + 1u) + 9u * (sz + 1u);
                    let i111 = (sx + 1u) + 3u * (sy + 1u) + 9u * (sz + 1u);

                    let v0 = vg[i000];
                    let v1 = vg[i100];
                    let v2 = vg[i010];
                    let v3 = vg[i110];
                    let v4 = vg[i001];
                    let v5 = vg[i101];
                    let v6 = vg[i011];
                    let v7 = vg[i111];

                    emitTetra(p0, p1, p3, p7, v0, v1, v3, v7);
                    emitTetra(p0, p3, p2, p7, v0, v3, v2, v7);
                    emitTetra(p0, p2, p6, p7, v0, v2, v6, v7);
                    emitTetra(p0, p6, p4, p7, v0, v6, v4, v7);
                    emitTetra(p0, p4, p5, p7, v0, v4, v5, v7);
                    emitTetra(p0, p5, p1, p7, v0, v5, v1, v7);
                }
            }
        }
    }
}

