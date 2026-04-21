/**
 * Stage 4 Sessions 3 + 4: coarse + fine ISO mesh merge with boundary-snap crack closure.
 *
 * The render-worker orchestrator runs the ISO pipeline twice when adaptive refinement
 * is in play: once at the user's voxel over the full scene bounds (the "coarse" mesh)
 * and once at a finer voxel within the high-residual AABB the octree identified (the
 * "fine" mesh). This module CPU-side merges them by:
 *
 *   1. Dropping coarse triangles whose centroid lies inside the fine AABB.
 *   2. Appending all fine triangles after the surviving coarse triangles, with the
 *      fine vertex indices offset by the surviving coarse vertex count.
 *   3. Compacting unreferenced coarse vertices (the dropped triangles' exclusively-owned
 *      vertices).
 *   4. (Session 4 — `snapAndCompactMergedMesh`) Snapping fine boundary vertices to
 *      coincident coarse boundary vertices on the same AABB face plane via index
 *      remapping, so the welded mesh is watertight where the snap succeeds.
 *
 * Session 4 scope note: this is NOT the paper-faithful T-junction-aware multi-resolution
 * Marching Tetrahedra in Pass 6 originally planned — that's still future work (Sessions 5+).
 * What lands here is a much cheaper crack-closure post-process that removes the most
 * visible Session 3 artefact (cracks at the AABB boundary) by snapping fine boundary
 * vertices to nearby coarse boundary vertices, exploiting the fact that both meshes
 * approximate the SAME iso surface so their boundary iso-crossings are within ~½ coarse
 * voxel of each other. Residual cracks may remain where:
 *   - The snap tolerance fails to find a coarse match (e.g. fine resolution introduces
 *     a new iso-crossing branch that the coarse mesh missed entirely)
 *   - Sharp features intersect the AABB boundary at sub-coarse-voxel scale
 * Session 5+ will replace this whole architecture with a single watertight unified MT.
 */

import type { MeshData } from "./export.mjs"
import { SIZEOF_VERTEX } from "./mdc.mjs"
import { log as dbgLog } from "../logging/debug-log.mjs"

const VERTEX_STRIDE_F32 = SIZEOF_VERTEX / Float32Array.BYTES_PER_ELEMENT

export interface AABB3 {
    min: [number, number, number]
    max: [number, number, number]
}

/**
 * Result of `mergeIsoMeshes`: the merged mesh AND the count of surviving coarse vertices
 * at the front of the merged vertex array. Indices [0, outCoarseVertCount) are coarse;
 * indices [outCoarseVertCount, end) are fine. Used by `snapAndCompactMergedMesh` to
 * partition the merged vertex array for boundary snapping.
 */
export interface MergeResult {
    mesh: MeshData
    outCoarseVertCount: number
}

/**
 * Merge two ISO meshes: drop coarse triangles whose centroid is inside `fineAABB`,
 * then append all fine triangles. Returns a new mesh and the count of surviving coarse
 * vertices at the front of the merged vertex array.
 */
export function mergeIsoMeshes(coarse: MeshData, fine: MeshData, fineAABB: AABB3): MergeResult {
    const coarseTris = coarse.tris
    const coarseVerts = coarse.verts
    const fineTris = fine.tris
    const fineVerts = fine.verts

    const coarseTriCount = (coarseTris.length / 3) | 0
    const coarseVertCount = (coarseVerts.length / VERTEX_STRIDE_F32) | 0

    // First pass: classify coarse triangles. `keep[t]` is true if its centroid is OUTSIDE
    // the fine AABB. We compute the centroid in-line via 3 vertex lookups.
    const keep = new Uint8Array(coarseTriCount)
    let keptCount = 0
    const used = new Uint8Array(coarseVertCount)
    const minX = fineAABB.min[0], minY = fineAABB.min[1], minZ = fineAABB.min[2]
    const maxX = fineAABB.max[0], maxY = fineAABB.max[1], maxZ = fineAABB.max[2]

    for (let t = 0; t < coarseTriCount; t++) {
        const i0 = coarseTris[t * 3]!
        const i1 = coarseTris[t * 3 + 1]!
        const i2 = coarseTris[t * 3 + 2]!
        const o0 = i0 * VERTEX_STRIDE_F32
        const o1 = i1 * VERTEX_STRIDE_F32
        const o2 = i2 * VERTEX_STRIDE_F32
        const cx = (coarseVerts[o0]! + coarseVerts[o1]! + coarseVerts[o2]!) / 3
        const cy = (coarseVerts[o0 + 1]! + coarseVerts[o1 + 1]! + coarseVerts[o2 + 1]!) / 3
        const cz = (coarseVerts[o0 + 2]! + coarseVerts[o1 + 2]! + coarseVerts[o2 + 2]!) / 3
        const inside = cx >= minX && cx <= maxX && cy >= minY && cy <= maxY && cz >= minZ && cz <= maxZ
        if (!inside) {
            keep[t] = 1
            keptCount++
            // Mark these coarse vertices as referenced so we keep them.
            used[i0] = 1
            used[i1] = 1
            used[i2] = 1
        }
    }

    // Second pass: build the dense remap for surviving coarse vertices.
    const coarseRemap = new Uint32Array(coarseVertCount)
    let outCoarseVertCount = 0
    for (let v = 0; v < coarseVertCount; v++) {
        if (used[v]) {
            coarseRemap[v] = outCoarseVertCount
            outCoarseVertCount++
        }
    }

    // Compose the merged vertex array: surviving coarse + all fine.
    const fineVertCount = (fineVerts.length / VERTEX_STRIDE_F32) | 0
    const totalVertCount = outCoarseVertCount + fineVertCount
    const mergedVerts = new Float32Array(totalVertCount * VERTEX_STRIDE_F32)
    // Copy surviving coarse vertices.
    for (let v = 0; v < coarseVertCount; v++) {
        if (!used[v]) continue
        const src = v * VERTEX_STRIDE_F32
        const dst = coarseRemap[v]! * VERTEX_STRIDE_F32
        for (let k = 0; k < VERTEX_STRIDE_F32; k++) {
            mergedVerts[dst + k] = coarseVerts[src + k]!
        }
    }
    // Copy all fine vertices straight after.
    mergedVerts.set(fineVerts, outCoarseVertCount * VERTEX_STRIDE_F32)

    // Compose the merged triangle index array: surviving coarse (remapped) + all fine
    // (offset by surviving coarse vertex count).
    const fineTriCount = (fineTris.length / 3) | 0
    const totalTriCount = keptCount + fineTriCount
    const mergedTris = new Uint32Array(totalTriCount * 3)
    let writeTri = 0
    for (let t = 0; t < coarseTriCount; t++) {
        if (!keep[t]) continue
        mergedTris[writeTri * 3] = coarseRemap[coarseTris[t * 3]!]!
        mergedTris[writeTri * 3 + 1] = coarseRemap[coarseTris[t * 3 + 1]!]!
        mergedTris[writeTri * 3 + 2] = coarseRemap[coarseTris[t * 3 + 2]!]!
        writeTri++
    }
    const fineIndexOffset = outCoarseVertCount
    for (let t = 0; t < fineTriCount; t++) {
        mergedTris[writeTri * 3] = fineTris[t * 3]! + fineIndexOffset
        mergedTris[writeTri * 3 + 1] = fineTris[t * 3 + 1]! + fineIndexOffset
        mergedTris[writeTri * 3 + 2] = fineTris[t * 3 + 2]! + fineIndexOffset
        writeTri++
    }

    dbgLog("IsoExport").info(
        `Stage 4 S3 merge: coarse ${coarseTriCount} → ${keptCount} tris (dropped ${coarseTriCount - keptCount} `
        + `inside fine AABB), + fine ${fineTriCount} = ${totalTriCount} total. `
        + `verts: ${coarseVertCount} → ${outCoarseVertCount} surviving + ${fineVertCount} fine = ${totalVertCount}.`,
    )
    return { mesh: { verts: mergedVerts, tris: mergedTris }, outCoarseVertCount }
}

/**
 * Pad the fine AABB by `padMm` on each side. Used when scheduling the secondary fine
 * pass so the fine mesh extends slightly past the actual feature region — gives the
 * coarse-triangle drop step a small overlap zone where it can pick the coarse triangle
 * over the fine one (or vice versa). For Session 3 v1 this doesn't close cracks but
 * ensures we don't accidentally drop coarse triangles we have no fine replacement for.
 */
export function padAABB(aabb: AABB3, padMm: number): AABB3 {
    return {
        min: [aabb.min[0] - padMm, aabb.min[1] - padMm, aabb.min[2] - padMm],
        max: [aabb.max[0] + padMm, aabb.max[1] + padMm, aabb.max[2] + padMm],
    }
}

export interface SnapOptions {
    /** Distance below which a fine boundary vertex snaps to nearest coarse boundary
     *  vertex. Recommend ~½ × coarse voxel: large enough to catch true boundary
     *  matches across the resolution gap, small enough to avoid accidental snaps. */
    snapTolMm: number
    /** Distance from AABB face plane below which a vertex is considered "on the
     *  boundary" and eligible for snapping. Recommend ~10 × float epsilon at world
     *  scale (1e-4 mm at typical CAD scales). */
    boundaryEpsMm?: number
}

export interface SnapResult {
    mesh: MeshData
    /** How many fine boundary vertices were successfully snapped to a coarse vertex. */
    snappedCount: number
    /** How many fine vertices were on an AABB face but found no coarse vertex within
     *  `snapTolMm` (these remain in the output mesh; cracks at these positions persist). */
    unsnappedFineBoundaryCount: number
}

// Per-AABB-face metadata: index into `[-X, +X, -Y, +Y, -Z, +Z]`. The face perpendicular
// axis (0=x, 1=y, 2=z) and the world-coord plane value drive both classification (which
// vertices are ON this face) and 2D projection (the two axes that span the face).
const FACE_AXES: readonly number[] = [0, 0, 1, 1, 2, 2] as const

/**
 * Snap fine boundary vertices in a merged mesh to coincident coarse boundary vertices,
 * eliminating cracks at the AABB boundary. Operates on the result of `mergeIsoMeshes`.
 *
 * Algorithm:
 *   1. Build 6 per-AABB-face 2D spatial hashes of coarse vertices that lie within
 *      `boundaryEpsMm` of each face plane.
 *   2. For each fine vertex (index ≥ outCoarseVertCount), check which AABB faces it
 *      lies on. For each such face, query the corresponding 2D hash for the nearest
 *      coarse vertex. If within `snapTolMm` (3D distance), record an index remap
 *      fine_idx → coarse_idx.
 *   3. Apply the remap to the triangle indices and compact the vertex array (drop
 *      orphaned fine vertices that were snapped away).
 *
 * The result is watertight at every snapped boundary position. Cracks remain only where
 * the snap failed to find a coarse partner — typically because the fine resolution
 * surfaced a sub-coarse-voxel iso branch that the coarse mesh missed.
 *
 * Why we snap fine to coarse and not vice versa: each coarse boundary vertex usually
 * has multiple fine candidates (~4 fine iso-crossings per coarse iso-crossing along the
 * boundary), so snapping coarse to fine would have to choose one of N — ambiguous.
 * Snapping fine to coarse is N-to-1, deterministic.
 */
export function snapAndCompactMergedMesh(
    merged: MergeResult,
    fineAABB: AABB3,
    options: SnapOptions,
): SnapResult {
    const STRIDE = VERTEX_STRIDE_F32
    const verts = merged.mesh.verts
    const tris = merged.mesh.tris
    const coarseVertCount = merged.outCoarseVertCount
    const totalVertCount = (verts.length / STRIDE) | 0
    const fineVertCount = totalVertCount - coarseVertCount

    const eps = options.boundaryEpsMm ?? 1e-4
    const snapTol = Math.max(options.snapTolMm, 1e-9)
    const snapTolSq = snapTol * snapTol

    // Quantization for 2D hash: cell size = snapTol so any 9-cell neighborhood lookup
    // covers all candidates within `snapTol` of the query point.
    const inv = 1 / snapTol
    const BIAS = 0x80000000
    const make2DKey = (qa: number, qb: number): bigint =>
        (BigInt((qa + BIAS) >>> 0) << 32n) | BigInt((qb + BIAS) >>> 0)

    const facePlanes = [
        fineAABB.min[0], fineAABB.max[0],
        fineAABB.min[1], fineAABB.max[1],
        fineAABB.min[2], fineAABB.max[2],
    ]
    const project = (x: number, y: number, z: number, face: number): [number, number] => {
        const axis = FACE_AXES[face]!
        if (axis === 0) return [y, z]
        if (axis === 1) return [x, z]
        return [x, y]
    }

    const hashes: Array<Map<bigint, number[]>> = [
        new Map(), new Map(), new Map(), new Map(), new Map(), new Map(),
    ]
    for (let v = 0; v < coarseVertCount; v++) {
        const off = v * STRIDE
        const x = verts[off]!
        const y = verts[off + 1]!
        const z = verts[off + 2]!
        for (let f = 0; f < 6; f++) {
            const axis = FACE_AXES[f]!
            const plane = facePlanes[f]!
            const coord = axis === 0 ? x : axis === 1 ? y : z
            if (Math.abs(coord - plane) > eps) continue
            const [a, b] = project(x, y, z, f)
            const key = make2DKey(Math.round(a * inv), Math.round(b * inv))
            const list = hashes[f]!.get(key)
            if (list) list.push(v)
            else hashes[f]!.set(key, [v])
        }
    }

    // For each fine vertex, find best snap candidate. fineRemap[fv] = coarseIdx, or -1.
    const fineRemap = new Int32Array(fineVertCount).fill(-1)
    let snappedCount = 0
    let unsnappedFineBoundaryCount = 0

    for (let fv = 0; fv < fineVertCount; fv++) {
        const v = coarseVertCount + fv
        const off = v * STRIDE
        const x = verts[off]!
        const y = verts[off + 1]!
        const z = verts[off + 2]!
        let bestDistSq = snapTolSq
        let bestIdx = -1
        let onAnyFace = false

        for (let f = 0; f < 6; f++) {
            const axis = FACE_AXES[f]!
            const plane = facePlanes[f]!
            const coord = axis === 0 ? x : axis === 1 ? y : z
            if (Math.abs(coord - plane) > eps) continue
            onAnyFace = true
            const [a, b] = project(x, y, z, f)
            const qa = Math.round(a * inv)
            const qb = Math.round(b * inv)
            // Search 9 cells (qa-1..qa+1) × (qb-1..qb+1) — covers all 2D positions
            // within `snapTol` of the query point.
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    const list = hashes[f]!.get(make2DKey(qa + dx, qb + dy))
                    if (!list) continue
                    for (const ci of list) {
                        const cof = ci * STRIDE
                        const cx = verts[cof]!
                        const cy = verts[cof + 1]!
                        const cz = verts[cof + 2]!
                        const dxx = cx - x
                        const dyy = cy - y
                        const dzz = cz - z
                        const d2 = dxx * dxx + dyy * dyy + dzz * dzz
                        if (d2 < bestDistSq) {
                            bestDistSq = d2
                            bestIdx = ci
                        }
                    }
                }
            }
        }

        if (bestIdx >= 0) {
            fineRemap[fv] = bestIdx
            snappedCount++
        } else if (onAnyFace) {
            unsnappedFineBoundaryCount++
        }
    }

    if (snappedCount === 0) {
        // Nothing to do — return the merged mesh unchanged. Saves the compaction work.
        return {
            mesh: merged.mesh,
            snappedCount: 0,
            unsnappedFineBoundaryCount,
        }
    }

    // Build full vertex remap: coarse indices unchanged; snapped fine → coarse;
    // unsnapped fine compacted to fill the freed slots.
    const fullRemap = new Uint32Array(totalVertCount)
    for (let v = 0; v < coarseVertCount; v++) fullRemap[v] = v
    let outVertCount = coarseVertCount
    for (let fv = 0; fv < fineVertCount; fv++) {
        const v = coarseVertCount + fv
        if (fineRemap[fv] >= 0) {
            fullRemap[v] = fineRemap[fv]!
        } else {
            fullRemap[v] = outVertCount++
        }
    }

    // Apply remap to triangle indices.
    const outTris = new Uint32Array(tris.length)
    for (let i = 0; i < tris.length; i++) {
        outTris[i] = fullRemap[tris[i]!]!
    }

    // Build compacted vertex array.
    const outVerts = new Float32Array(outVertCount * STRIDE)
    for (let v = 0; v < coarseVertCount; v++) {
        const srcOff = v * STRIDE
        const dstOff = v * STRIDE
        for (let k = 0; k < STRIDE; k++) outVerts[dstOff + k] = verts[srcOff + k]!
    }
    for (let fv = 0; fv < fineVertCount; fv++) {
        if (fineRemap[fv] >= 0) continue // snapped away, no source data needed
        const v = coarseVertCount + fv
        const srcOff = v * STRIDE
        const dstOff = fullRemap[v]! * STRIDE
        for (let k = 0; k < STRIDE; k++) outVerts[dstOff + k] = verts[srcOff + k]!
    }

    return {
        mesh: { verts: outVerts, tris: outTris },
        snappedCount,
        unsnappedFineBoundaryCount,
    }
}
