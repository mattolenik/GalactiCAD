import type { MeshData } from "./export.mjs"

/**
 * Vertex stride in float32 units for the standard `MeshData` layout
 * (`[px, py, pz, pad, nx, ny, nz, pad]` — 8 floats, 32 bytes).
 *
 * Kept here so both `mdc.mts` and `shrec.mts` can share the same constant
 * without one depending on the other.
 */
export const VERTEX_STRIDE_F32 = 8

/**
 * Two triangles share an edge through `sharedVert` iff they share a second
 * vertex (in addition to `sharedVert` itself).
 */
function triSharesEdge(tris: Uint32Array, t0: number, t1: number, sharedVert: number): boolean {
    const base0 = t0 * 3, base1 = t1 * 3
    for (let c0 = 0; c0 < 3; c0++) {
        const v0 = tris[base0 + c0]!
        if (v0 === sharedVert) continue
        for (let c1 = 0; c1 < 3; c1++) {
            const v1 = tris[base1 + c1]!
            if (v1 === sharedVert) continue
            if (v0 === v1) return true
        }
    }
    return false
}

/**
 * Split mesh vertices at crease edges and assign averaged face normals per
 * smooth group. This replaces noisy per-vertex normals (e.g. SDF gradient
 * normals at sharp features, or interpolated edge-crossing normals from dual
 * contouring) with **face-derived normals**, eliminating both:
 *
 *   1. Banding on flat surfaces — adjacent triangles on a flat surface have
 *      identical face normals, so per-vertex averages match exactly across
 *      cell boundaries (no interpolation gradient).
 *   2. Smearing across sharp features — vertices whose adjacent triangles
 *      span a crease angle larger than `creaseAngleDeg` are split into
 *      separate output vertices, each with its own smooth-group normal.
 *
 * Algorithm:
 *  1. Compute unit face normals from triangle geometry.
 *  2. Build CSR vertex → triangle adjacency.
 *  3. For each vertex, flood-fill its adjacent triangles into smooth groups
 *     (connected via shared edges, face normals within the cosine threshold).
 *  4. Emit one output vertex per group with the group-averaged face normal.
 *
 * Unreferenced input vertices are dropped (implicit compaction). Set
 * `creaseAngleDeg` to 180 to disable splitting (one smooth group per vertex,
 * normals still re-derived from face geometry).
 */
export function renormalizeTriangleNormals(
    verts: Float32Array<ArrayBuffer>,
    tris: Uint32Array<ArrayBuffer>,
): MeshData {
    return splitCreaseVertices(verts, tris, 180)
}

export function splitCreaseVertices(
    verts: Float32Array<ArrayBuffer>,
    tris: Uint32Array<ArrayBuffer>,
    creaseAngleDeg: number,
): MeshData {
    const S = VERTEX_STRIDE_F32
    const cosThresh = Math.cos(creaseAngleDeg * Math.PI / 180)
    const triCount = (tris.length / 3) | 0
    const vertCount = (verts.length / S) | 0
    if (triCount === 0 || vertCount === 0) return { verts, tris }

    // 1. Unit face normals
    const fnx = new Float32Array(triCount)
    const fny = new Float32Array(triCount)
    const fnz = new Float32Array(triCount)
    for (let t = 0; t < triCount; t++) {
        const b0 = tris[t * 3]! * S, b1 = tris[t * 3 + 1]! * S, b2 = tris[t * 3 + 2]! * S
        const ax = verts[b1]! - verts[b0]!, ay = verts[b1 + 1]! - verts[b0 + 1]!, az = verts[b1 + 2]! - verts[b0 + 2]!
        const bx = verts[b2]! - verts[b0]!, by = verts[b2 + 1]! - verts[b0 + 1]!, bz = verts[b2 + 2]! - verts[b0 + 2]!
        let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx
        const l = Math.hypot(nx, ny, nz)
        if (l > 1e-20) { nx /= l; ny /= l; nz /= l }
        fnx[t] = nx; fny[t] = ny; fnz[t] = nz
    }

    // 2. CSR adjacency: vertex → (triangle, corner) pairs
    const deg = new Uint32Array(vertCount)
    for (let k = 0; k < tris.length; k++) {
        const vi = tris[k]!
        if (vi < vertCount) deg[vi]++
    }
    const adjOff = new Uint32Array(vertCount + 1)
    for (let i = 0; i < vertCount; i++) adjOff[i + 1] = adjOff[i]! + deg[i]!
    const totalAdj = adjOff[vertCount]!
    const adjT = new Uint32Array(totalAdj)
    const adjC = new Uint8Array(totalAdj)
    const cursor = new Uint32Array(vertCount)
    for (let t = 0; t < triCount; t++)
        for (let c = 0; c < 3; c++) {
            const vi = tris[t * 3 + c]!
            if (vi < vertCount) {
                const off = adjOff[vi]! + cursor[vi]!
                adjT[off] = t
                adjC[off] = c
                cursor[vi]++
            }
        }

    // 3. Cluster and emit
    const outTris = new Uint32Array(tris)
    let cap = Math.max(vertCount * 2, 1024)
    let outV = new Float32Array(cap * S)
    let nOut = 0

    const ensureCap = () => {
        if (nOut < cap) return
        cap *= 2
        const nv = new Float32Array(cap * S)
        nv.set(outV.subarray(0, nOut * S))
        outV = nv
    }

    let visBuf = new Uint8Array(64)

    for (let vi = 0; vi < vertCount; vi++) {
        const s0 = adjOff[vi]!, s1 = adjOff[vi + 1]!
        const n = s1 - s0
        if (n === 0) continue

        if (visBuf.length < n) visBuf = new Uint8Array(Math.max(n, visBuf.length * 2))
        const vis = visBuf
        vis.fill(0, 0, n)

        for (let seed = 0; seed < n; seed++) {
            if (vis[seed]) continue
            vis[seed] = 1

            // Flood-fill one smooth group
            const grp: number[] = [seed]
            const stk: number[] = [seed]
            while (stk.length > 0) {
                const ci = stk.pop()!
                const ct = adjT[s0 + ci]!
                for (let j = 0; j < n; j++) {
                    if (vis[j]) continue
                    const jt = adjT[s0 + j]!
                    const dot = fnx[ct]! * fnx[jt]! + fny[ct]! * fny[jt]! + fnz[ct]! * fnz[jt]!
                    if (dot < cosThresh) continue
                    if (!triSharesEdge(tris, ct, jt, vi)) continue
                    vis[j] = 1
                    grp.push(j)
                    stk.push(j)
                }
            }

            let nx = 0, ny = 0, nz = 0
            for (const idx of grp) {
                const t = adjT[s0 + idx]!
                nx += fnx[t]!; ny += fny[t]!; nz += fnz[t]!
            }
            const l = Math.hypot(nx, ny, nz)
            if (l > 1e-12) { nx /= l; ny /= l; nz /= l }

            ensureCap()
            const sb = vi * S, db = nOut * S
            outV[db] = verts[sb]!
            outV[db + 1] = verts[sb + 1]!
            outV[db + 2] = verts[sb + 2]!
            outV[db + 3] = 0
            outV[db + 4] = nx
            outV[db + 5] = ny
            outV[db + 6] = nz
            outV[db + 7] = 0

            for (const idx of grp) {
                outTris[adjT[s0 + idx]! * 3 + adjC[s0 + idx]!] = nOut
            }
            nOut++
        }
    }

    const resultVerts = new Float32Array(nOut * S)
    resultVerts.set(outV.subarray(0, nOut * S))
    const resultTris = new Uint32Array(outTris.length)
    resultTris.set(outTris)
    return { verts: resultVerts, tris: resultTris }
}
