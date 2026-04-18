/**
 * CPU dual contouring over a precomputed (scalar, gradient) volume.
 *
 * This is the v1 mesher used by the SHREC pipeline. It produces a quad-based
 * dual mesh from the GPU-sampled grid (see `grid-sample.mts`). Vertices are
 * placed at the per-cell **mass point** (mean of the cube's edge crossings),
 * which is the simplest correct DC placement.
 *
 * Sharp-feature snapping is handled later by MergeSharp; this module
 * intentionally does not solve a QEF — that lets the MergeSharp stage do the
 * work without conflicting "feature-aware" vertex placement here.
 *
 * Inputs:
 *  - `scalar[idx]`    : SDF value at voxel `idx = (z*ny + y)*nx + x`.
 *  - `gradient[idx*4 + (0..3)]` : analytical normal (xyz) and gradient
 *    magnitude (w) at voxel `idx`.
 *
 * Output: interleaved mesh with the same vertex layout as MDCExport, i.e.
 * `[px, py, pz, pad, nx, ny, nz, pad]` (8 floats per vertex).
 */

import { log as dbgLog } from "../../logging/debug-log.mjs"
import type { GridSampleResult } from "../grid-sample.mjs"

/** Floats per vertex (matches `SIZEOF_VERTEX / 4` in `mdc.mts`). */
const VERTEX_STRIDE = 8

export interface DualContourParams {
    /** Iso-surface value (SDFs typically use 0). */
    isoValue: number
}

/**
 * Output of `dualContourCPU`. Extends `MeshData` with per-vertex cell coords
 * so downstream stages (MergeSharp) can recover the cube each vertex came
 * from and re-enumerate its 12 edge crossings without an inverse lookup.
 *
 * `cellCoords[3*vi + 0..2]` = `(cx, cy, cz)` in cell-grid coordinates
 * (i.e. cell `(0,0,0)` spans voxels `(0,0,0)..(1,1,1)`).
 */
export interface DualContourMesh {
    verts: Float32Array<ArrayBuffer>
    tris: Uint32Array<ArrayBuffer>
    cellCoords: Uint32Array<ArrayBuffer>
}

/**
 * Per-axis layout of the four cube cells touching a voxel-grid edge.
 *
 * For an edge along axis `a` from voxel (vx, vy, vz) to its `+a` neighbour,
 * `cellOffsets` lists the four surrounding cells (as `[dx, dy, dz]` offsets
 * applied to the edge's lower voxel coord) in **CCW order around the +a
 * axis**. Following this order yields a quad whose normal points in +a when
 * the SDF transitions from inside → outside along +a.
 *
 * Derived geometrically — see the per-axis cross-product checks in the source
 * commit message; each entry has been verified to give a +axis-facing
 * triangle normal for the (c00, c10, c11) winding.
 */
const EDGE_AXIS_INFO: ReadonlyArray<{
    axis: 0 | 1 | 2
    /** Offset to the second voxel of the edge (e.g. `[1,0,0]` for x-axis). */
    edgeStep: readonly [number, number, number]
    /** 4 cell offsets, in CCW order around +axis. */
    cellOffsets: ReadonlyArray<readonly [number, number, number]>
}> = [
    {
        // x-axis edge (vx,vy,vz) → (vx+1,vy,vz). CCW around +x.
        axis: 0,
        edgeStep: [1, 0, 0],
        cellOffsets: [
            [0, -1, -1],
            [0, 0, -1],
            [0, 0, 0],
            [0, -1, 0],
        ],
    },
    {
        // y-axis edge (vx,vy,vz) → (vx,vy+1,vz). CCW around +y.
        axis: 1,
        edgeStep: [0, 1, 0],
        cellOffsets: [
            [-1, 0, -1],
            [-1, 0, 0],
            [0, 0, 0],
            [0, 0, -1],
        ],
    },
    {
        // z-axis edge (vx,vy,vz) → (vx,vy,vz+1). CCW around +z.
        axis: 2,
        edgeStep: [0, 0, 1],
        cellOffsets: [
            [-1, -1, 0],
            [0, -1, 0],
            [0, 0, 0],
            [-1, 0, 0],
        ],
    },
]

/**
 * Build an iso-surface mesh from a sampled (scalar, gradient) volume using
 * dual contouring with mass-point vertex placement.
 *
 * Time complexity: O(voxels) for edge enumeration + O(active cells) for
 * vertex emission. Memory: dense per-cell accumulators (3 vec3 + counter per
 * cell) — adequate for the grid sizes the existing MDC pipeline already
 * supports. Sparsification can come later if larger volumes become routine.
 */
export function dualContourCPU(
    grid: GridSampleResult,
    params: DualContourParams,
): DualContourMesh {
    const t0 = perfNow()
    const [nx, ny, nz] = grid.dims
    const { scalar, gradient, voxelSize, gridOffset } = grid
    const iso = params.isoValue

    const ncx = nx - 1
    const ncy = ny - 1
    const ncz = nz - 1
    if (ncx < 1 || ncy < 1 || ncz < 1) {
        return emptyMesh()
    }

    const ncells = ncx * ncy * ncz

    // Per-cell accumulators. Each cell collects the sum of edge-intersection
    // positions and (un-normalised) interpolated normals, plus a count.
    const sumPos = new Float32Array(ncells * 3)
    const sumNrm = new Float32Array(ncells * 3)
    const edgeCount = new Uint32Array(ncells)

    // Index conversions are inlined in the hot loops below for speed; see
    // `voxelIdx` and `cellIdx` for the canonical formulas.
    const ox = gridOffset[0]
    const oy = gridOffset[1]
    const oz = gridOffset[2]
    const vs = voxelSize

    let crossingEdges = 0

    // -----------------------------------------------------------------
    // Pass 1: enumerate interior edges per axis, accumulate intersections
    // into the 4 surrounding cells.
    // -----------------------------------------------------------------
    for (const info of EDGE_AXIS_INFO) {
        const [dx, dy, dz] = info.edgeStep
        // Interior edge ranges: the edge endpoint must lie inside the grid,
        // and ALL four surrounding cells must lie inside the cell grid (so
        // each perpendicular axis must be ≥ 1 and ≤ nv - 1).
        const vxLo = info.axis === 0 ? 0 : 1
        const vxHi = info.axis === 0 ? nx - 2 : nx - 1
        const vyLo = info.axis === 1 ? 0 : 1
        const vyHi = info.axis === 1 ? ny - 2 : ny - 1
        const vzLo = info.axis === 2 ? 0 : 1
        const vzHi = info.axis === 2 ? nz - 2 : nz - 1

        for (let vz = vzLo; vz <= vzHi; vz++) {
            for (let vy = vyLo; vy <= vyHi; vy++) {
                for (let vx = vxLo; vx <= vxHi; vx++) {
                    const idxA = (vz * ny + vy) * nx + vx
                    const idxB = ((vz + dz) * ny + (vy + dy)) * nx + (vx + dx)
                    const sA = scalar[idxA]!
                    const sB = scalar[idxB]!

                    // Treat samples exactly at the iso-value as "inside" (≤ iso).
                    const insideA = sA <= iso
                    const insideB = sB <= iso
                    if (insideA === insideB) continue

                    crossingEdges++

                    let t = (iso - sA) / (sB - sA)
                    // Guard against floating-point sA ≈ sB even when signs differ
                    // (can happen with tiny denormals at very flat regions).
                    if (!isFinite(t)) t = 0.5
                    if (t < 0) t = 0
                    else if (t > 1) t = 1

                    const px = ox + vs * (vx + t * dx)
                    const py = oy + vs * (vy + t * dy)
                    const pz = oz + vs * (vz + t * dz)

                    const gA = idxA * 4
                    const gB = idxB * 4
                    const nax = gradient[gA]!,     nay = gradient[gA + 1]!, naz = gradient[gA + 2]!
                    const nbx = gradient[gB]!,     nby = gradient[gB + 1]!, nbz = gradient[gB + 2]!
                    const nx_ = nax + (nbx - nax) * t
                    const ny_ = nay + (nby - nay) * t
                    const nz_ = naz + (nbz - naz) * t

                    // Add this intersection to each of the 4 surrounding cells.
                    for (let i = 0; i < 4; i++) {
                        const off = info.cellOffsets[i]!
                        const cx = vx + off[0]
                        const cy = vy + off[1]
                        const cz = vz + off[2]
                        // Range guard (defensive — interior ranges above should
                        // already keep us in-bounds).
                        if (cx < 0 || cy < 0 || cz < 0) continue
                        if (cx >= ncx || cy >= ncy || cz >= ncz) continue

                        const ci = (cz * ncy + cy) * ncx + cx
                        const ci3 = ci * 3
                        sumPos[ci3] += px
                        sumPos[ci3 + 1] += py
                        sumPos[ci3 + 2] += pz
                        sumNrm[ci3] += nx_
                        sumNrm[ci3 + 1] += ny_
                        sumNrm[ci3 + 2] += nz_
                        edgeCount[ci]++
                    }
                }
            }
        }
    }

    // -----------------------------------------------------------------
    // Pass 2: emit one vertex per active cell at its mass point.
    // -----------------------------------------------------------------
    // -1 sentinel for inactive cells. Int32Array for fast index lookups.
    const cellVertIdx = new Int32Array(ncells)
    cellVertIdx.fill(-1)

    let activeCells = 0
    for (let i = 0; i < ncells; i++) {
        if (edgeCount[i] > 0) activeCells++
    }

    const verts = new Float32Array(activeCells * VERTEX_STRIDE)
    const cellCoords = new Uint32Array(activeCells * 3)
    let vCursor = 0
    for (let i = 0; i < ncells; i++) {
        const n = edgeCount[i]
        if (n === 0) continue
        const inv = 1 / n
        const i3 = i * 3
        const px = sumPos[i3]! * inv
        const py = sumPos[i3 + 1]! * inv
        const pz = sumPos[i3 + 2]! * inv

        // Recover (cx, cy, cz) from flat cell index.
        const cz = (i / (ncx * ncy)) | 0
        const remainder = i - cz * ncx * ncy
        const cy = (remainder / ncx) | 0
        const cx = remainder - cy * ncx
        const cco = vCursor * 3
        cellCoords[cco] = cx
        cellCoords[cco + 1] = cy
        cellCoords[cco + 2] = cz
        let nxv = sumNrm[i3]!
        let nyv = sumNrm[i3 + 1]!
        let nzv = sumNrm[i3 + 2]!
        const nl = Math.hypot(nxv, nyv, nzv)
        if (nl > 1e-20) {
            const ninv = 1 / nl
            nxv *= ninv
            nyv *= ninv
            nzv *= ninv
        } else {
            // Degenerate normal — fall back to +Z. This shouldn't normally
            // happen because the GPU sampler returns analytical SDF normals.
            nxv = 0
            nyv = 0
            nzv = 1
        }
        const base = vCursor * VERTEX_STRIDE
        verts[base] = px
        verts[base + 1] = py
        verts[base + 2] = pz
        verts[base + 3] = 0
        verts[base + 4] = nxv
        verts[base + 5] = nyv
        verts[base + 6] = nzv
        verts[base + 7] = 0
        cellVertIdx[i] = vCursor
        vCursor++
    }

    // -----------------------------------------------------------------
    // Pass 3: emit one quad (= 2 triangles) per crossing edge.
    // -----------------------------------------------------------------
    // Upper bound: each crossing edge → 2 triangles → 6 indices.
    const trisBuf = new Uint32Array(crossingEdges * 6)
    let tCursor = 0
    let skippedQuads = 0

    for (const info of EDGE_AXIS_INFO) {
        const [dx, dy, dz] = info.edgeStep
        const vxLo = info.axis === 0 ? 0 : 1
        const vxHi = info.axis === 0 ? nx - 2 : nx - 1
        const vyLo = info.axis === 1 ? 0 : 1
        const vyHi = info.axis === 1 ? ny - 2 : ny - 1
        const vzLo = info.axis === 2 ? 0 : 1
        const vzHi = info.axis === 2 ? nz - 2 : nz - 1
        const off = info.cellOffsets

        for (let vz = vzLo; vz <= vzHi; vz++) {
            for (let vy = vyLo; vy <= vyHi; vy++) {
                for (let vx = vxLo; vx <= vxHi; vx++) {
                    const idxA = (vz * ny + vy) * nx + vx
                    const idxB = ((vz + dz) * ny + (vy + dy)) * nx + (vx + dx)
                    const sA = scalar[idxA]!
                    const sB = scalar[idxB]!
                    const insideA = sA <= iso
                    const insideB = sB <= iso
                    if (insideA === insideB) continue

                    // Look up the 4 cell vertices in CCW order around +axis.
                    let v0 = -1, v1 = -1, v2 = -1, v3 = -1
                    {
                        const o0 = off[0]!, o1 = off[1]!, o2 = off[2]!, o3 = off[3]!
                        const c0x = vx + o0[0], c0y = vy + o0[1], c0z = vz + o0[2]
                        const c1x = vx + o1[0], c1y = vy + o1[1], c1z = vz + o1[2]
                        const c2x = vx + o2[0], c2y = vy + o2[1], c2z = vz + o2[2]
                        const c3x = vx + o3[0], c3y = vy + o3[1], c3z = vz + o3[2]
                        v0 = cellVertIdx[(c0z * ncy + c0y) * ncx + c0x]!
                        v1 = cellVertIdx[(c1z * ncy + c1y) * ncx + c1x]!
                        v2 = cellVertIdx[(c2z * ncy + c2y) * ncx + c2x]!
                        v3 = cellVertIdx[(c3z * ncy + c3y) * ncx + c3x]!
                    }
                    if (v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0) {
                        // A surrounding cell didn't accumulate any edge — should
                        // be impossible since this very edge would have added
                        // to it. Skip defensively to keep the mesh valid.
                        skippedQuads++
                        continue
                    }

                    // Inside-to-outside along +axis (sA inside, sB outside):
                    // CCW order gives +axis-facing normal — outward from solid.
                    // Flip when traversal goes outside-to-inside.
                    if (insideA && !insideB) {
                        trisBuf[tCursor++] = v0
                        trisBuf[tCursor++] = v1
                        trisBuf[tCursor++] = v2
                        trisBuf[tCursor++] = v0
                        trisBuf[tCursor++] = v2
                        trisBuf[tCursor++] = v3
                    } else {
                        trisBuf[tCursor++] = v0
                        trisBuf[tCursor++] = v2
                        trisBuf[tCursor++] = v1
                        trisBuf[tCursor++] = v0
                        trisBuf[tCursor++] = v3
                        trisBuf[tCursor++] = v2
                    }
                }
            }
        }
    }

    // Trim triangle buffer to the actually-emitted prefix.
    const tris = new Uint32Array(tCursor)
    tris.set(trisBuf.subarray(0, tCursor))

    const elapsedMs = perfNow() - t0
    dbgLog("ShrecExport").debug(
        `dualContourCPU: grid=${nx}x${ny}x${nz} crossingEdges=${crossingEdges} ` +
        `activeCells=${activeCells} verts=${vCursor} tris=${tCursor / 3} ` +
        `skippedQuads=${skippedQuads} elapsed=${elapsedMs.toFixed(1)}ms`,
    )

    return { verts, tris, cellCoords }
}

function emptyMesh(): DualContourMesh {
    return {
        verts: new Float32Array(new ArrayBuffer(0)),
        tris: new Uint32Array(new ArrayBuffer(0)),
        cellCoords: new Uint32Array(new ArrayBuffer(0)),
    }
}

function perfNow(): number {
    return globalThis.performance?.now ? globalThis.performance.now() : Date.now()
}
