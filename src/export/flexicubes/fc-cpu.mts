import type { GridSampleResult } from "../grid-sample.mjs"
import {
    sym3Zero, sym3AddOuter, sym3Mul, sym3Eigen, sym3SolveTikhonov,
    type Sym3,
} from "../shrec/svd3.mjs"
import { DMC_TABLE, NUM_VD_TABLE, CHECK_TABLE, CUBE_CORNERS, CUBE_EDGES, EDGE_CANONICAL } from "./fc-tables.mjs"

/** Global edge ID encoding for a regular voxel grid.
 * Edges are partitioned: x-edges first, then y-edges, then z-edges.
 * Lower-voxel corner is canonical for each edge direction.
 */
function edgeGlobalId(
    axis: number, vx: number, vy: number, vz: number,
    nx: number, ny: number,
    numXEdges: number, numYEdges: number,
): number {
    if (axis === 0) return vz * ny * (nx - 1) + vy * (nx - 1) + vx          // x-edge
    if (axis === 1) return numXEdges + vz * (ny - 1) * nx + vy * nx + vx    // y-edge
    return numXEdges + numYEdges + vz * ny * nx + vy * nx + vx               // z-edge
}

/** For cube (cx, cy, cz) and local edge index e, compute the global edge ID. */
function cubeLocalEdgeGlobalId(
    cx: number, cy: number, cz: number, e: number,
    nx: number, ny: number,
    numXEdges: number, numYEdges: number,
): number {
    const [axis, dvx, dvy, dvz] = EDGE_CANONICAL[e]!
    return edgeGlobalId(axis, cx + dvx, cy + dvy, cz + dvz, nx, ny, numXEdges, numYEdges)
}

/** Solve one dual vertex QEF from accumulated normal+point constraints. */
function solveQef(
    ata: Sym3,
    atb0: number, atb1: number, atb2: number,
    mass0: number, mass1: number, mass2: number,
    relCutoff: number,
    out: [number, number, number],
): void {
    const eig = sym3Eigen(ata)
    const lambdaReg = relCutoff * Math.abs(eig.values[0] ?? 0)
    // residual = atb - A*mass
    const tmp: [number, number, number] = [0, 0, 0]
    sym3Mul(ata, mass0, mass1, mass2, tmp)
    const rx = atb0 - tmp[0], ry = atb1 - tmp[1], rz = atb2 - tmp[2]
    const corr: [number, number, number] = [0, 0, 0]
    sym3SolveTikhonov(eig, rx, ry, rz, lambdaReg, corr)
    out[0] = mass0 + corr[0]
    out[1] = mass1 + corr[1]
    out[2] = mass2 + corr[2]
}

/**
 * CPU implementation of FlexiCubes mesh extraction (non-ML, QEF mode).
 *
 * Operates on a pre-sampled uniform grid (from GridSampler). Dual vertices
 * are placed by solving a QEF over the edge crossings within each DMC group.
 * No learned weights (beta/alpha/gamma) — analytic SDF gradients used directly.
 *
 * Returns raw position-only vertices ([x,y,z] each) and triangle indices.
 * Caller must run splitCreaseVertices to derive normals.
 */
export function flexiCubesCPU(
    grid: GridSampleResult,
    isoValue: number,
    relCutoff = 0.1,
): { verts: Float32Array<ArrayBuffer>; tris: Uint32Array<ArrayBuffer> } {
    const [nx, ny, nz] = grid.dims
    const { scalar, gradient, voxelSize, gridOffset } = grid
    const [ox, oy, oz] = gridOffset

    const cnx = nx - 1, cny = ny - 1, cnz = nz - 1
    const totalCubes = cnx * cny * cnz
    if (totalCubes === 0) return { verts: new Float32Array(0), tris: new Uint32Array(0) }

    // Pre-compute edge count offsets
    const numXEdges = cnx * ny * nz
    const numYEdges = nx * cny * nz
    // numZEdges = nx * ny * cnz

    // ── Pass A: Compute case IDs for all cubes ────────────────────────────────
    // caseIdGrid[cubeIdx] = 0 for non-surface, or the MC case ID for surface cubes
    const caseIdGrid = new Uint8Array(totalCubes)
    const isSurface = new Uint8Array(totalCubes)  // 1 if surface cube
    const surfCubeIndices: number[] = []

    for (let cz = 0; cz < cnz; cz++) {
        for (let cy = 0; cy < cny; cy++) {
            for (let cx = 0; cx < cnx; cx++) {
                const cubeIdx = cz * cny * cnx + cy * cnx + cx
                let caseId = 0
                let bitOccSum = 0
                for (let i = 0; i < 8; i++) {
                    const [dx, dy, dz] = CUBE_CORNERS[i]!
                    const vi = (cz + dz) * ny * nx + (cy + dy) * nx + (cx + dx)
                    if (scalar[vi]! < isoValue) {
                        caseId |= (1 << i)
                        bitOccSum++
                    }
                }
                if (bitOccSum > 0 && bitOccSum < 8) {
                    caseIdGrid[cubeIdx] = caseId
                    isSurface[cubeIdx] = 1
                    surfCubeIndices.push(cubeIdx)
                }
            }
        }
    }

    if (surfCubeIndices.length === 0) return { verts: new Float32Array(0), tris: new Uint32Array(0) }

    // ── Pass B: Ambiguity resolution (C16/C19) ────────────────────────────────
    // Collect inversions first, then apply atomically
    const inversions = new Map<number, number>()  // cubeIdx → invertedCaseId
    for (const cubeIdx of surfCubeIndices) {
        const caseId = caseIdGrid[cubeIdx]!
        const base = caseId * 5
        if (CHECK_TABLE[base] !== 1) continue
        const dx = CHECK_TABLE[base + 1]!, dy = CHECK_TABLE[base + 2]!, dz = CHECK_TABLE[base + 3]!
        const invertedId = CHECK_TABLE[base + 4]!

        // Cube coordinates
        const cz = (cubeIdx / (cny * cnx)) | 0
        const rem = cubeIdx - cz * cny * cnx
        const cy = (rem / cnx) | 0
        const cx = rem - cy * cnx

        const adjCx = cx + dx, adjCy = cy + dy, adjCz = cz + dz
        if (adjCx < 0 || adjCx >= cnx || adjCy < 0 || adjCy >= cny || adjCz < 0 || adjCz >= cnz) continue
        const adjCubeIdx = adjCz * cny * cnx + adjCy * cnx + adjCx
        const adjCaseId = caseIdGrid[adjCubeIdx]!
        const adjBase = adjCaseId * 5
        if (CHECK_TABLE[adjBase] === 1) {
            inversions.set(cubeIdx, invertedId)
        }
    }
    for (const [cubeIdx, invertedId] of inversions) {
        caseIdGrid[cubeIdx] = invertedId
    }

    // ── Pass C: Surface edge identification ───────────────────────────────────
    // For each (surfCube, localEdge) count refs; record crossing data for surface edges.
    // edgeRefCount: globalEdgeId → number of surf-cube references (all 12 edges counted)
    // surfaceEdgeCrossing: globalEdgeId → { crossingPos, normal, v0IsInside }
    const edgeRefCount = new Map<number, number>()
    type EdgeCrossing = { px: number; py: number; pz: number; nx: number; ny: number; nz: number; v0Inside: boolean }
    const edgeCrossings = new Map<number, EdgeCrossing>()

    const numSurfCubes = surfCubeIndices.length

    for (const cubeIdx of surfCubeIndices) {
        const cz = (cubeIdx / (cny * cnx)) | 0
        const rem = cubeIdx - cz * cny * cnx
        const cy = (rem / cnx) | 0
        const cx = rem - cy * cnx

        for (let e = 0; e < 12; e++) {
            const geid = cubeLocalEdgeGlobalId(cx, cy, cz, e, nx, ny, numXEdges, numYEdges)
            edgeRefCount.set(geid, (edgeRefCount.get(geid) ?? 0) + 1)

            if (edgeCrossings.has(geid)) continue

            // Edge endpoints
            const v0c = CUBE_EDGES[e * 2]!
            const v1c = CUBE_EDGES[e * 2 + 1]!
            const [dx0, dy0, dz0] = CUBE_CORNERS[v0c]!
            const [dx1, dy1, dz1] = CUBE_CORNERS[v1c]!
            const vi0 = (cz + dz0) * ny * nx + (cy + dy0) * nx + (cx + dx0)
            const vi1 = (cz + dz1) * ny * nx + (cy + dy1) * nx + (cx + dx1)
            const s0 = scalar[vi0]!, s1 = scalar[vi1]!
            const occ0 = s0 < isoValue, occ1 = s1 < isoValue
            if (occ0 === occ1) continue  // not a surface edge

            const t = (isoValue - s0) / (s1 - s0)
            const wx0 = ox + (cx + dx0) * voxelSize, wy0 = oy + (cy + dy0) * voxelSize, wz0 = oz + (cz + dz0) * voxelSize
            const wx1 = ox + (cx + dx1) * voxelSize, wy1 = oy + (cy + dy1) * voxelSize, wz1 = oz + (cz + dz1) * voxelSize
            const cpx = wx0 + t * (wx1 - wx0), cpy = wy0 + t * (wy1 - wy0), cpz = wz0 + t * (wz1 - wz0)

            // Interpolate and normalize gradient
            const gi0 = vi0 * 4, gi1 = vi1 * 4
            let gnx = gradient[gi0]! + t * (gradient[gi1]! - gradient[gi0]!)
            let gny = gradient[gi0 + 1]! + t * (gradient[gi1 + 1]! - gradient[gi0 + 1]!)
            let gnz = gradient[gi0 + 2]! + t * (gradient[gi1 + 2]! - gradient[gi0 + 2]!)
            const gl = Math.hypot(gnx, gny, gnz)
            if (gl > 1e-20) { gnx /= gl; gny /= gl; gnz /= gl }

            edgeCrossings.set(geid, { px: cpx, py: cpy, pz: cpz, nx: gnx, ny: gny, nz: gnz, v0Inside: occ0 })
        }
    }

    // ── Pass D: Dual vertex placement (QEF) ───────────────────────────────────
    // cubeEdgeToVd[surfCubePos * 12 + localEdge] = global dual vertex ID (-1 = none)
    const cubeEdgeToVd = new Int32Array(numSurfCubes * 12).fill(-1)
    // surfCubePos: the index into surfCubeIndices (different from cubeIdx)
    const cubeIdxToSurfPos = new Map<number, number>()
    for (let i = 0; i < numSurfCubes; i++) cubeIdxToSurfPos.set(surfCubeIndices[i]!, i)

    const dualVerts: number[] = []  // [x0, y0, z0, x1, ...]
    let totalVd = 0

    for (let sci = 0; sci < numSurfCubes; sci++) {
        const cubeIdx = surfCubeIndices[sci]!
        const caseId = caseIdGrid[cubeIdx]!
        const numVd = NUM_VD_TABLE[caseId]!

        const cz = (cubeIdx / (cny * cnx)) | 0
        const rem = cubeIdx - cz * cny * cnx
        const cy = (rem / cnx) | 0
        const cx = rem - cy * cnx

        for (let slot = 0; slot < numVd; slot++) {
            const vdId = totalVd + slot
            const slotBase = caseId * 28 + slot * 7

            const ata = sym3Zero()
            let atb0 = 0, atb1 = 0, atb2 = 0
            let mass0 = 0, mass1 = 0, mass2 = 0
            let count = 0

            for (let k = 0; k < 7; k++) {
                const localEdge = DMC_TABLE[slotBase + k]!
                if (localEdge < 0) break

                const geid = cubeLocalEdgeGlobalId(cx, cy, cz, localEdge, nx, ny, numXEdges, numYEdges)
                const crossing = edgeCrossings.get(geid)
                if (!crossing) continue

                // Mark this edge → this dual vertex
                cubeEdgeToVd[sci * 12 + localEdge] = vdId

                const { px, py, pz, nx: gx, ny: gy, nz: gz } = crossing
                const dot = gx * px + gy * py + gz * pz
                sym3AddOuter(ata, gx, gy, gz)
                atb0 += dot * gx; atb1 += dot * gy; atb2 += dot * gz
                mass0 += px; mass1 += py; mass2 += pz
                count++
            }

            if (count === 0) {
                // Fall back to cube center
                dualVerts.push(
                    ox + (cx + 0.5) * voxelSize,
                    oy + (cy + 0.5) * voxelSize,
                    oz + (cz + 0.5) * voxelSize,
                )
            } else {
                mass0 /= count; mass1 /= count; mass2 /= count
                const out: [number, number, number] = [mass0, mass1, mass2]
                solveQef(ata, atb0, atb1, atb2, mass0, mass1, mass2, relCutoff, out)
                dualVerts.push(out[0], out[1], out[2])
            }
        }
        totalVd += numVd
    }

    // ── Pass E: Quad emission → triangles ─────────────────────────────────────
    // Build (globalEdgeId, dualVertexId) pairs for all valid (surfCube, edge) slots.
    type EdgeVdEntry = { geid: number; vdId: number }
    const edgeVdEntries: EdgeVdEntry[] = []

    for (let sci = 0; sci < numSurfCubes; sci++) {
        const cubeIdx = surfCubeIndices[sci]!
        const cz = (cubeIdx / (cny * cnx)) | 0
        const rem = cubeIdx - cz * cny * cnx
        const cy = (rem / cnx) | 0
        const cx = rem - cy * cnx

        for (let e = 0; e < 12; e++) {
            const vdId = cubeEdgeToVd[sci * 12 + e]!
            if (vdId < 0) continue  // this edge slot not in any dual vertex group

            const geid = cubeLocalEdgeGlobalId(cx, cy, cz, e, nx, ny, numXEdges, numYEdges)
            if (!edgeCrossings.has(geid)) continue  // not a surface edge
            if ((edgeRefCount.get(geid) ?? 0) !== 4) continue  // boundary edge, skip

            edgeVdEntries.push({ geid, vdId })
        }
    }

    // Stable sort by globalEdgeId
    edgeVdEntries.sort((a, b) => a.geid - b.geid)

    const triangles: number[] = []
    const n = edgeVdEntries.length

    for (let i = 0; i < n; i += 4) {
        if (i + 3 >= n) break
        const geid = edgeVdEntries[i]!.geid
        // Verify all 4 belong to same edge (should always be true after sort)
        if (edgeVdEntries[i + 1]!.geid !== geid ||
            edgeVdEntries[i + 2]!.geid !== geid ||
            edgeVdEntries[i + 3]!.geid !== geid) continue

        const vd0 = edgeVdEntries[i]!.vdId
        const vd1 = edgeVdEntries[i + 1]!.vdId
        const vd2 = edgeVdEntries[i + 2]!.vdId
        const vd3 = edgeVdEntries[i + 3]!.vdId

        // Winding: for Z-outer scan order the 4 adjacent cubes arrive in
        // row-major order in the plane ⊥ to the edge axis:
        //   (da=0,db=0),(da=1,db=0),(da=0,db=1),(da=1,db=1)
        // CCW in that plane is [0,1,3,2]; CW is [0,2,3,1].
        // We want outward normals pointing from inside → outside.
        //
        // CUBE_EDGES defines v0c as the LOWER endpoint for x-edges (axis 0)
        // and z-edges (axis 2), but as the UPPER-y endpoint for y-edges
        // (axis 1, edges 8–11 use corner order (2,0),(3,1),(7,5),(6,4)).
        // So crossing.v0Inside has inverted meaning for y-edges.
        const edgeAxis = geid < numXEdges ? 0 : geid < numXEdges + numYEdges ? 1 : 2
        const crossing = edgeCrossings.get(geid)!
        const lowerEndpointInside = edgeAxis === 1 ? !crossing.v0Inside : crossing.v0Inside
        let q0: number, q1: number, q2: number, q3: number
        if (lowerEndpointInside) {
            // lower endpoint inside → outward normal in edge direction → CCW → [0,1,3,2]
            q0 = vd0; q1 = vd1; q2 = vd3; q3 = vd2
        } else {
            // lower endpoint outside → outward normal against edge direction → CW → [0,2,3,1]
            q0 = vd0; q1 = vd2; q2 = vd3; q3 = vd1
        }

        // quad_split_1: [0, 1, 2, 0, 2, 3]
        triangles.push(q0, q1, q2, q0, q2, q3)
    }

    // ── Pack output ───────────────────────────────────────────────────────────
    // Vertex layout: 8 floats per vertex [px, py, pz, 0, 0, 0, 0, 0]
    // Normals are filled in by splitCreaseVertices.
    const S = 8
    const verts = new Float32Array(totalVd * S)
    for (let i = 0; i < totalVd; i++) {
        verts[i * S] = dualVerts[i * 3]!
        verts[i * S + 1] = dualVerts[i * 3 + 1]!
        verts[i * S + 2] = dualVerts[i * 3 + 2]!
    }
    const tris = new Uint32Array(triangles)
    return { verts, tris }
}
