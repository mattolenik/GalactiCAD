/**
 * Vertex deduplication — the **"merge" half of MergeSharp**.
 *
 * After `mergeSharpRelocate` snaps each DC vertex onto its nearest sharp
 * feature, vertices in adjacent cells that all converged to the **same**
 * feature point (typically a CSG corner where 3+ surfaces meet) end up
 * geometrically co-located, separated only by the cell-bounds clamp inset
 * (~`0.001 × voxelSize` per side).
 *
 * Leaving them as distinct vertices produces:
 *   - **degenerate / near-degenerate triangles** clustered around the corner
 *     (zero or near-zero area; visible as shading artefacts and rejected by
 *     downstream simplification).
 *   - **redundant geometry**: each cell contributes a full vertex record for
 *     what is conceptually a single shared corner.
 *   - **slightly inconsistent normals** on what should be one shared point,
 *     since each contributing cell averaged a different set of edge-crossing
 *     normals.
 *
 * This pass:
 *
 *   1. Finds every pair of vertices within `radius` of each other using a
 *      spatial hash on a `radius`-sized cell grid (3³ neighbour search per
 *      vertex; O(N) for typical CAD geometry).
 *   2. Groups vertices into connected merge clusters via union-find. This is
 *      transitive: if A merges with B and B merges with C, all three end up
 *      in one cluster even if A and C are individually outside the radius.
 *   3. For each cluster, emits a single output vertex at the **mean position
 *      and mean normal** of its members.
 *   4. Rewrites the triangle index buffer with the new vertex IDs.
 *   5. Drops triangles that became degenerate (two or more identical indices
 *      after remapping — these were the near-zero-area triangles around the
 *      corner being merged).
 *   6. Compacts the vertex buffer (no unreferenced vertices).
 *
 * **Choosing the radius:** for typical CAD geometry, `0.5 × voxelSize` is a
 * good starting point — large enough to catch all corner-cluster vertices
 * (which are within ~`2 × cellBoundsInset × voxelSize ≈ 0.002 × voxelSize`
 * after relocation), small enough to leave plain-flat-surface vertices alone
 * (which are spaced one full voxel apart on adjacent cells). For aggressive
 * cleanup along sharp edges, push to ~`1.0 × voxelSize`. Setting the radius
 * to `0` disables the pass entirely.
 */

import { log as dbgLog } from "../../logging/debug-log.mjs"
import type { MeshData } from "../export.mjs"

/** Floats per vertex (matches `SIZEOF_VERTEX / 4` in `mdc.mts`). */
const VERTEX_STRIDE = 8

interface DedupStats {
    inputVertexCount: number
    outputVertexCount: number
    mergedClusters: number  // Number of clusters that merged 2+ vertices.
    inputTriCount: number
    outputTriCount: number
    droppedDegenerate: number
    elapsedMs: number
}

/**
 * Merge vertices within `radius` of each other into a single shared vertex,
 * rewrite the triangle index buffer, drop degenerate triangles, and compact
 * the result.
 *
 * Topology safety: this **does** preserve manifoldness for the common case
 * (vertices along a CSG corner snapping to the same point). It can in
 * principle create non-manifold edges if vertices on geometrically-distinct
 * surface sheets that just happen to be close together end up in the same
 * cluster — but this is rare in practice with `radius < voxelSize` because
 * the QEF cell-bounds clamp keeps each vertex inside its own cube, so two
 * vertices can only co-locate if they come from cells that share a face.
 *
 * Returns the deduplicated mesh + per-call stats. Returns the input mesh
 * unchanged if `radius <= 0` or the mesh is empty.
 */
export function deduplicateMergedVertices(
    mesh: MeshData,
    radius: number,
): { mesh: MeshData; stats: DedupStats } {
    const t0 = perfNow()
    const inVerts = mesh.verts
    const inTris = mesh.tris
    const inputVertexCount = (inVerts.length / VERTEX_STRIDE) | 0
    const inputTriCount = (inTris.length / 3) | 0

    // No-op fast paths.
    if (radius <= 0 || inputVertexCount === 0 || inputTriCount === 0) {
        return {
            mesh,
            stats: {
                inputVertexCount,
                outputVertexCount: inputVertexCount,
                mergedClusters: 0,
                inputTriCount,
                outputTriCount: inputTriCount,
                droppedDegenerate: 0,
                elapsedMs: perfNow() - t0,
            },
        }
    }

    // -----------------------------------------------------------------
    // 1. Union-find over vertex indices.
    // -----------------------------------------------------------------
    const parent = new Uint32Array(inputVertexCount)
    for (let i = 0; i < inputVertexCount; i++) parent[i] = i
    const ufFind = (x: number): number => {
        let r = x
        while (parent[r] !== r) r = parent[r]!
        // Path compression — flatten the chain so subsequent finds are O(1).
        let cur = x
        while (parent[cur] !== r) {
            const next = parent[cur]!
            parent[cur] = r
            cur = next
        }
        return r
    }
    const ufUnion = (a: number, b: number): void => {
        const ra = ufFind(a)
        const rb = ufFind(b)
        if (ra !== rb) parent[ra] = rb
    }

    // -----------------------------------------------------------------
    // 2. Spatial hash: bucket each vertex into a `radius`-sized cell.
    //    For each new vertex, scan its own cell + 26 neighbours and union
    //    with anything within `radius`.
    // -----------------------------------------------------------------
    // Hash key packs (cx, cy, cz) — each up to 21 bits — into a 64-bit BigInt.
    // BigInt keys are slower than number keys, but Map<BigInt> in V8 is fine
    // and we avoid any precision pitfalls for large grids.
    const inv = 1 / radius
    const r2 = radius * radius
    const buckets = new Map<bigint, number[]>()
    const cellKey = (x: number, y: number, z: number): bigint =>
        // Bias by 1 << 20 to keep values non-negative for the bit shifts.
        ((BigInt(x + 0x100000) & 0x1fffffn) << 42n) |
        ((BigInt(y + 0x100000) & 0x1fffffn) << 21n) |
        (BigInt(z + 0x100000) & 0x1fffffn)

    for (let vi = 0; vi < inputVertexCount; vi++) {
        const base = vi * VERTEX_STRIDE
        const x = inVerts[base]!
        const y = inVerts[base + 1]!
        const z = inVerts[base + 2]!
        const cx = Math.floor(x * inv)
        const cy = Math.floor(y * inv)
        const cz = Math.floor(z * inv)

        // Test against every vertex already in this cell or in any of the 26
        // neighbouring cells. Pairs across non-adjacent cells cannot satisfy
        // `dist < radius` since the cell size IS radius.
        for (let dz = -1; dz <= 1; dz++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const k = cellKey(cx + dx, cy + dy, cz + dz)
                    const list = buckets.get(k)
                    if (!list) continue
                    for (let li = 0; li < list.length; li++) {
                        const wi = list[li]!
                        const wb = wi * VERTEX_STRIDE
                        const ddx = x - inVerts[wb]!
                        const ddy = y - inVerts[wb + 1]!
                        const ddz = z - inVerts[wb + 2]!
                        if (ddx * ddx + ddy * ddy + ddz * ddz <= r2) {
                            ufUnion(vi, wi)
                        }
                    }
                }
            }
        }

        // Now register `vi` in its own cell so subsequent vertices can find it.
        const myKey = cellKey(cx, cy, cz)
        let myList = buckets.get(myKey)
        if (!myList) {
            myList = []
            buckets.set(myKey, myList)
        }
        myList.push(vi)
    }

    // -----------------------------------------------------------------
    // 3. Tally cluster sizes & accumulate cluster sums (mean position +
    //    mean normal). Single sweep over all input vertices; constant
    //    extra memory per cluster.
    // -----------------------------------------------------------------
    interface ClusterAcc {
        sumPx: number; sumPy: number; sumPz: number
        sumNx: number; sumNy: number; sumNz: number
        count: number
    }
    const clusters = new Map<number, ClusterAcc>()
    for (let vi = 0; vi < inputVertexCount; vi++) {
        const root = ufFind(vi)
        const base = vi * VERTEX_STRIDE
        let acc = clusters.get(root)
        if (!acc) {
            acc = { sumPx: 0, sumPy: 0, sumPz: 0, sumNx: 0, sumNy: 0, sumNz: 0, count: 0 }
            clusters.set(root, acc)
        }
        acc.sumPx += inVerts[base]!
        acc.sumPy += inVerts[base + 1]!
        acc.sumPz += inVerts[base + 2]!
        acc.sumNx += inVerts[base + 4]!
        acc.sumNy += inVerts[base + 5]!
        acc.sumNz += inVerts[base + 6]!
        acc.count++
    }

    // -----------------------------------------------------------------
    // 4. Emit one output vertex per cluster, in order of first appearance.
    //    Build old-vertex → new-vertex remap.
    // -----------------------------------------------------------------
    const oldToNew = new Int32Array(inputVertexCount).fill(-1)
    let mergedClusters = 0
    let outputVertexCount = 0
    // Allocate at the upper bound and trim later — single pass, no growth.
    const outVerts = new Float32Array(clusters.size * VERTEX_STRIDE)
    for (let vi = 0; vi < inputVertexCount; vi++) {
        const root = ufFind(vi)
        if (oldToNew[root] !== -1) {
            oldToNew[vi] = oldToNew[root]
            continue
        }
        const acc = clusters.get(root)!
        const newIdx = outputVertexCount++
        const dst = newIdx * VERTEX_STRIDE
        const invCount = 1 / acc.count
        outVerts[dst] = acc.sumPx * invCount
        outVerts[dst + 1] = acc.sumPy * invCount
        outVerts[dst + 2] = acc.sumPz * invCount
        outVerts[dst + 3] = 0
        // Re-normalise the mean normal (an average of unit vectors generally
        // isn't unit-length). splitCreaseVertices will overwrite this anyway,
        // but it's polite to leave a sane normal in the buffer in case anyone
        // reads it directly.
        const nx = acc.sumNx, ny = acc.sumNy, nz = acc.sumNz
        const nl = Math.hypot(nx, ny, nz)
        if (nl > 1e-20) {
            const k = 1 / nl
            outVerts[dst + 4] = nx * k
            outVerts[dst + 5] = ny * k
            outVerts[dst + 6] = nz * k
        } else {
            outVerts[dst + 4] = 0
            outVerts[dst + 5] = 0
            outVerts[dst + 6] = 1
        }
        outVerts[dst + 7] = 0
        oldToNew[root] = newIdx
        oldToNew[vi] = newIdx
        if (acc.count > 1) mergedClusters++
    }

    // -----------------------------------------------------------------
    // 5. Rewrite triangle indices; drop degenerate triangles (two or more
    //    indices the same after remap = collapsed corner).
    // -----------------------------------------------------------------
    const outTrisBuf = new Uint32Array(inTris.length)
    let outTriCount = 0
    let droppedDegenerate = 0
    for (let ti = 0; ti < inTris.length; ti += 3) {
        const a = oldToNew[inTris[ti]!]!
        const b = oldToNew[inTris[ti + 1]!]!
        const c = oldToNew[inTris[ti + 2]!]!
        if (a === b || b === c || c === a) {
            droppedDegenerate++
            continue
        }
        const o = outTriCount * 3
        outTrisBuf[o] = a
        outTrisBuf[o + 1] = b
        outTrisBuf[o + 2] = c
        outTriCount++
    }

    // -----------------------------------------------------------------
    // 6. Trim output buffers to the actually-used prefix.
    // -----------------------------------------------------------------
    const trimmedVerts = new Float32Array(outputVertexCount * VERTEX_STRIDE)
    trimmedVerts.set(outVerts.subarray(0, outputVertexCount * VERTEX_STRIDE))
    const trimmedTris = new Uint32Array(outTriCount * 3)
    trimmedTris.set(outTrisBuf.subarray(0, outTriCount * 3))

    const stats: DedupStats = {
        inputVertexCount,
        outputVertexCount,
        mergedClusters,
        inputTriCount,
        outputTriCount: outTriCount,
        droppedDegenerate,
        elapsedMs: perfNow() - t0,
    }
    dbgLog("ShrecExport").debug(
        `dedup: verts ${inputVertexCount} → ${outputVertexCount} ` +
        `(merged ${mergedClusters} clusters), ` +
        `tris ${inputTriCount} → ${outTriCount} (dropped ${droppedDegenerate} degenerate), ` +
        `radius=${radius.toFixed(4)} elapsed=${stats.elapsedMs.toFixed(1)}ms`,
    )

    return {
        mesh: { verts: trimmedVerts, tris: trimmedTris },
        stats,
    }
}

function perfNow(): number {
    return globalThis.performance?.now ? globalThis.performance.now() : Date.now()
}
