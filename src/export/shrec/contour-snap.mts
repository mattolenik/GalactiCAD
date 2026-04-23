/**
 * Per-cell contour snapping for SHREC's MergeSharp pass.
 *
 * Consumes the `ContourBufferView` produced by walking the scene tree
 * (`accumulateContours`) and, for each active DC cell, finds the best
 * contour element to snap the cell's vertex onto:
 *
 *   - **Point** in the cell → snap to the point (cell becomes a corner).
 *   - **Segment** passing through the cell → snap to the closest point on
 *     the segment within the cell.
 *   - **Multiple segments meeting in the cell** → solve their intersection
 *     (least-squares), giving a corner.
 *
 * Every snap candidate is **validated against the iso-surface** before it
 * is accepted: if the SDF (sampled from the GPU grid) at the proposed
 * snap point is significantly non-zero, the contour element has been
 * cut away by a CSG operation (e.g. a `difference`) and the snap is
 * rejected. The cell then falls through to the existing seam-aware /
 * Tikhonov path. This is what lets the contour metadata be correct
 * everywhere: contours are *hints*, the SDF is the ground truth.
 *
 * Validation tolerance is **adaptive**: when a cell has many candidates
 * (corner-like) we tighten — only the truly-coincident point survives;
 * when there's a single candidate (along an edge) we loosen — interpolation
 * noise or smooth-blend rounding is allowed without losing the snap.
 *
 * Indices, not data
 * -----------------
 * The spatial index stores **integer references** into `ContourBufferView`'s
 * flat arrays — no copies of geometry. A reference is encoded into a single
 * `int32` for compact storage:
 *
 *     ref = (kind << 28) | index           kind ∈ {0=segment, 1=point, 2=ring}
 */

import { ContourKind, type ContourBufferView } from "../../scene/contour-buffer.mjs"
import type { GridSampleResult } from "../grid-sample.mjs"

/**
 * Encoded contour reference. Top 4 bits: kind (0..2). Bottom 28 bits: index
 * into the kind-specific array (segments, points, rings). 28 bits = 268M
 * distinct contours per kind — orders of magnitude beyond practical scenes.
 */
type ContourRef = number

const REF_KIND_SHIFT = 28
const REF_INDEX_MASK = (1 << REF_KIND_SHIFT) - 1

function encodeRef(kind: ContourKind, index: number): ContourRef {
    return (kind << REF_KIND_SHIFT) | (index & REF_INDEX_MASK)
}
function refKind(ref: ContourRef): ContourKind {
    return (ref >>> REF_KIND_SHIFT) as ContourKind
}
function refIndex(ref: ContourRef): number {
    return ref & REF_INDEX_MASK
}

/**
 * Voxel-cell-keyed spatial index over a contour buffer. For each cell of
 * the SHREC voxel grid that is touched by any contour element's AABB, we
 * store the list of contour refs that touch it.
 *
 * Lookups are O(candidates per cell), which is typically ≤ 4 (a cell at a
 * box corner sees 3 incident edges + 1 corner point).
 */
export class ContourSpatialIndex {
    /**
     * `cellMap.get(cellKey) → Int32Array of refs`. We use plain JS arrays
     * during build then snapshot to `Int32Array` once frozen for cache-
     * friendlier iteration.
     */
    private cellMap: Map<bigint, Int32Array>
    readonly contours: ContourBufferView

    private constructor(contours: ContourBufferView, cellMap: Map<bigint, Int32Array>) {
        this.contours = contours
        this.cellMap = cellMap
    }

    /**
     * Build the index. `cellSize` is the SHREC voxel size in world units;
     * `gridOffset` is the world-space position of grid voxel `(0,0,0)`.
     * Cell coordinates here use the same cell-grid convention as
     * `dc-cpu.mts` (cell `(cx,cy,cz)` spans voxels `(cx,cy,cz)..(cx+1,…)`),
     * i.e. cell-origin world position = `gridOffset + cellCoord · cellSize`.
     */
    static build(
        contours: ContourBufferView,
        cellSize: number,
        gridOffset: readonly [number, number, number],
    ): ContourSpatialIndex {
        const accum = new Map<bigint, number[]>()
        const ox = gridOffset[0], oy = gridOffset[1], oz = gridOffset[2]
        const inv = 1 / cellSize

        // Cell-range epsilon. When a contour AABB lands exactly on a cell
        // boundary (very common — any axis-aligned box at integer
        // dimensions has corners that fall on `gridOffset + k·cellSize`
        // exactly), `floor` would bucket it into a single cell above the
        // boundary, but the **active** DC cell is whichever side contains
        // the iso-surface — frequently the cell *below* the boundary. We
        // expand by half a cell here so the contour registers in **both**
        // adjacent cells. The per-cell snap function still does its own
        // projection-in-cell check, so over-inclusion is harmless.
        const eps = cellSize * 0.5
        const insertRange = (
            ref: ContourRef,
            bbox: Float32Array,
            bboxIdx: number,
        ) => {
            const minX = bbox[bboxIdx]!,    minY = bbox[bboxIdx + 1]!, minZ = bbox[bboxIdx + 2]!
            const maxX = bbox[bboxIdx + 3]!, maxY = bbox[bboxIdx + 4]!, maxZ = bbox[bboxIdx + 5]!
            const cx0 = Math.floor((minX - ox - eps) * inv)
            const cy0 = Math.floor((minY - oy - eps) * inv)
            const cz0 = Math.floor((minZ - oz - eps) * inv)
            const cx1 = Math.floor((maxX - ox + eps) * inv)
            const cy1 = Math.floor((maxY - oy + eps) * inv)
            const cz1 = Math.floor((maxZ - oz + eps) * inv)
            for (let cz = cz0; cz <= cz1; cz++) {
                for (let cy = cy0; cy <= cy1; cy++) {
                    for (let cx = cx0; cx <= cx1; cx++) {
                        const k = packCellKey(cx, cy, cz)
                        const list = accum.get(k)
                        if (list) list.push(ref)
                        else accum.set(k, [ref])
                    }
                }
            }
        }

        for (let i = 0; i < contours.segmentCount; i++) {
            insertRange(encodeRef(ContourKind.Segment, i), contours.segmentBBox, i * 6)
        }
        for (let i = 0; i < contours.pointCount; i++) {
            insertRange(encodeRef(ContourKind.Point, i), contours.pointBBox, i * 6)
        }
        for (let i = 0; i < contours.ringCount; i++) {
            insertRange(encodeRef(ContourKind.Ring, i), contours.ringBBox, i * 6)
        }

        // Snapshot to Int32Array per bucket for tighter iteration.
        const sealed = new Map<bigint, Int32Array>()
        for (const [key, list] of accum) {
            sealed.set(key, Int32Array.from(list))
        }
        return new ContourSpatialIndex(contours, sealed)
    }

    /** Return refs whose AABB touches cell `(cx, cy, cz)`, or null if none. */
    queryCell(cx: number, cy: number, cz: number): Int32Array | null {
        return this.cellMap.get(packCellKey(cx, cy, cz)) ?? null
    }

    /** True if no cells are populated — caller can short-circuit per-cell loop. */
    get isEmpty(): boolean {
        return this.cellMap.size === 0
    }
}

/** 21 bits per axis (signed range ≈ ±1M cells), packed into a 64-bit BigInt key. */
function packCellKey(cx: number, cy: number, cz: number): bigint {
    return ((BigInt(cx + 0x100000) & 0x1fffffn) << 42n) |
           ((BigInt(cy + 0x100000) & 0x1fffffn) << 21n) |
           (BigInt(cz + 0x100000) & 0x1fffffn)
}

// ============================================================================
// Per-cell snap
// ============================================================================

/** Result of a successful contour snap. `klass` follows the MeshMdcDebug encoding. */
export interface ContourSnapResult {
    x: number
    y: number
    z: number
    /** 1 = line (segment), 2 = corner (point or intersection of segments). */
    klass: 1 | 2
    /** Owner node id (the scene primitive that contributed this contour). Maps to the debug record's `ownerA` slot. */
    ownerId: number
    /**
     * Stable per-feature index within the contour buffer (point index for
     * corners, segment index for lines). Maps to the debug record's
     * `ownerB` slot — the mesh viewer's feature-glyph dedup keys on
     * `(klass, ownerA, ownerB)` plus a spatial filter, so giving every
     * contour element a distinct featureIdx prevents distinct corners /
     * edges of the same primitive from merging into a single glyph while
     * still letting multiple cells snapping to the same feature collapse
     * down to one glyph (which is what we want).
     */
    featureIdx: number
    /** For segment snaps: unit tangent direction along the segment. For point/corner: zero vector. */
    tx: number
    ty: number
    tz: number
}

/** Reusable scratch passed in by the caller to avoid per-cell allocation. */
export interface SnapScratch {
    candidatePos: Float32Array  // length 3 * MAX_CANDIDATES
    candidateKind: Int32Array   // length MAX_CANDIDATES
    candidateRef: Int32Array    // length MAX_CANDIDATES
}

const MAX_CANDIDATES_PER_CELL = 32

export function makeSnapScratch(): SnapScratch {
    return {
        candidatePos: new Float32Array(MAX_CANDIDATES_PER_CELL * 3),
        candidateKind: new Int32Array(MAX_CANDIDATES_PER_CELL),
        candidateRef: new Int32Array(MAX_CANDIDATES_PER_CELL),
    }
}

/**
 * Sample the SDF at world-space `(x,y,z)` via trilinear interpolation of
 * `grid.scalar`. Used to validate proposed snap points against the actual
 * iso-surface — if `|d|` is large, the contour was cut away by a CSG
 * operation and the snap should be rejected.
 *
 * Out-of-bounds samples return a large positive value (treated as "outside,
 * far from surface" → snap rejected).
 */
function sampleScalarTrilinear(grid: GridSampleResult, x: number, y: number, z: number): number {
    const [nx, ny, nz] = grid.dims
    const ox = grid.gridOffset[0], oy = grid.gridOffset[1], oz = grid.gridOffset[2]
    const inv = 1 / grid.voxelSize
    const fx = (x - ox) * inv, fy = (y - oy) * inv, fz = (z - oz) * inv
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz)
    if (ix < 0 || iy < 0 || iz < 0 || ix + 1 >= nx || iy + 1 >= ny || iz + 1 >= nz) {
        return 1e9
    }
    const tx = fx - ix, ty = fy - iy, tz = fz - iz
    const s = grid.scalar
    const stride = nx * ny
    const i000 = iz * stride + iy * nx + ix
    const c000 = s[i000]!,        c100 = s[i000 + 1]!
    const c010 = s[i000 + nx]!,   c110 = s[i000 + nx + 1]!
    const c001 = s[i000 + stride]!,        c101 = s[i000 + stride + 1]!
    const c011 = s[i000 + stride + nx]!,   c111 = s[i000 + stride + nx + 1]!
    const c00 = c000 + (c100 - c000) * tx
    const c01 = c001 + (c101 - c001) * tx
    const c10 = c010 + (c110 - c010) * tx
    const c11 = c011 + (c111 - c011) * tx
    const c0 = c00 + (c10 - c00) * ty
    const c1 = c01 + (c11 - c01) * ty
    return c0 + (c1 - c0) * tz
}

/**
 * Trilinearly sample the grid normal `(nx,ny,nz)` at world-space `(x,y,z)` and
 * return a **unit** vector, or `null` if out of bounds or degenerate.
 */
export function sampleGradientTrilinear(
    grid: GridSampleResult,
    x: number, y: number, z: number,
): { nx: number; ny: number; nz: number } | null {
    const [nxDim, nyDim, nzDim] = grid.dims
    const ox = grid.gridOffset[0], oy = grid.gridOffset[1], oz = grid.gridOffset[2]
    const inv = 1 / grid.voxelSize
    const fx = (x - ox) * inv, fy = (y - oy) * inv, fz = (z - oz) * inv
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz)
    if (ix < 0 || iy < 0 || iz < 0 || ix + 1 >= nxDim || iy + 1 >= nyDim || iz + 1 >= nzDim) {
        return null
    }
    const tx = fx - ix, ty = fy - iy, tz = fz - iz
    const g = grid.gradient
    const stride = nxDim * nyDim
    const voxelStride = 4

    const readN = (ix_: number, iy_: number, iz_: number) => {
        const i000 = (iz_ * nyDim + iy_) * nxDim + ix_
        const o = i000 * voxelStride
        return [g[o]!, g[o + 1]!, g[o + 2]!] as const
    }

    const [n000x, n000y, n000z] = readN(ix, iy, iz)
    const [n100x, n100y, n100z] = readN(ix + 1, iy, iz)
    const [n010x, n010y, n010z] = readN(ix, iy + 1, iz)
    const [n110x, n110y, n110z] = readN(ix + 1, iy + 1, iz)
    const [n001x, n001y, n001z] = readN(ix, iy, iz + 1)
    const [n101x, n101y, n101z] = readN(ix + 1, iy, iz + 1)
    const [n011x, n011y, n011z] = readN(ix, iy + 1, iz + 1)
    const [n111x, n111y, n111z] = readN(ix + 1, iy + 1, iz + 1)

    const lerp3 = (
        ax: number, ay: number, az: number,
        bx: number, by: number, bz: number,
        t: number,
    ) => [
        ax + (bx - ax) * t,
        ay + (by - ay) * t,
        az + (bz - az) * t,
    ] as const

    const [n00x, n00y, n00z] = lerp3(n000x, n000y, n000z, n100x, n100y, n100z, tx)
    const [n01x, n01y, n01z] = lerp3(n001x, n001y, n001z, n101x, n101y, n101z, tx)
    const [n10x, n10y, n10z] = lerp3(n010x, n010y, n010z, n110x, n110y, n110z, tx)
    const [n11x, n11y, n11z] = lerp3(n011x, n011y, n011z, n111x, n111y, n111z, tx)
    const [n0x, n0y, n0z] = lerp3(n00x, n00y, n00z, n10x, n10y, n10z, ty)
    const [n1x, n1y, n1z] = lerp3(n01x, n01y, n01z, n11x, n11y, n11z, ty)
    const [vx, vy, vz] = lerp3(n0x, n0y, n0z, n1x, n1y, n1z, tz)
    const nl = Math.hypot(vx, vy, vz)
    if (nl < 1e-20) return null
    const invL = 1 / nl
    return { nx: vx * invL, ny: vy * invL, nz: vz * invL }
}

/** Project `(qx,qy,qz)` onto segment `[a, b]`, clamping `t` to `[0, 1]`. */
function projectOntoSegment(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    qx: number, qy: number, qz: number,
    out: { x: number; y: number; z: number; tx: number; ty: number; tz: number },
): void {
    const dx = bx - ax, dy = by - ay, dz = bz - az
    const lenSq = dx * dx + dy * dy + dz * dz
    if (lenSq < 1e-20) {
        out.x = ax; out.y = ay; out.z = az
        out.tx = 0; out.ty = 0; out.tz = 0
        return
    }
    let t = ((qx - ax) * dx + (qy - ay) * dy + (qz - az) * dz) / lenSq
    if (t < 0) t = 0
    else if (t > 1) t = 1
    out.x = ax + t * dx
    out.y = ay + t * dy
    out.z = az + t * dz
    const inv = 1 / Math.sqrt(lenSq)
    out.tx = dx * inv
    out.ty = dy * inv
    out.tz = dz * inv
}

/**
 * Try to snap the cell vertex to a contour. Returns the snapped position +
 * classification when at least one candidate was accepted, otherwise null
 * — caller falls through to the existing seam-aware / Tikhonov solve.
 */
export function trySnapToContours(
    index: ContourSpatialIndex,
    grid: GridSampleResult,
    cx: number, cy: number, cz: number,
    cellMinX: number, cellMinY: number, cellMinZ: number,
    cellMaxX: number, cellMaxY: number, cellMaxZ: number,
    queryX: number, queryY: number, queryZ: number,
    scratch: SnapScratch,
    ownerIdFilter?: (ownerId: number) => boolean,
): ContourSnapResult | null {
    const refs = index.queryCell(cx, cy, cz)
    if (!refs || refs.length === 0) return null

    const contours = index.contours
    const segments = contours.segments
    const segmentOwners = contours.segmentOwners
    const points = contours.points
    const pointOwners = contours.pointOwners

    // Pass 1: collect candidates whose projection lies inside the cell bounds.
    let nCandidates = 0
    const projOut = { x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0 }

    const addCandidate = (kind: ContourKind, ref: ContourRef, px: number, py: number, pz: number) => {
        if (nCandidates >= MAX_CANDIDATES_PER_CELL) return
        // Cell-bounds test (with a tiny epsilon — points exactly on the
        // cell face should still count for the cell that owns the face).
        const eps = 1e-6
        if (px < cellMinX - eps || px > cellMaxX + eps) return
        if (py < cellMinY - eps || py > cellMaxY + eps) return
        if (pz < cellMinZ - eps || pz > cellMaxZ + eps) return
        const i3 = nCandidates * 3
        scratch.candidatePos[i3]     = px
        scratch.candidatePos[i3 + 1] = py
        scratch.candidatePos[i3 + 2] = pz
        scratch.candidateKind[nCandidates] = kind
        scratch.candidateRef[nCandidates] = ref
        nCandidates++
    }

    for (let i = 0; i < refs.length; i++) {
        const ref = refs[i]!
        const kind = refKind(ref)
        const idx = refIndex(ref)
        if (kind === ContourKind.Point) {
            if (ownerIdFilter && !ownerIdFilter(pointOwners[idx]!)) continue
            const o = idx * 3
            addCandidate(kind, ref, points[o]!, points[o + 1]!, points[o + 2]!)
        } else if (kind === ContourKind.Segment) {
            if (ownerIdFilter && !ownerIdFilter(segmentOwners[idx]!)) continue
            const o = idx * 6
            projectOntoSegment(
                segments[o]!,     segments[o + 1]!, segments[o + 2]!,
                segments[o + 3]!, segments[o + 4]!, segments[o + 5]!,
                queryX, queryY, queryZ,
                projOut,
            )
            addCandidate(kind, ref, projOut.x, projOut.y, projOut.z)
        }
        // (Ring kind reserved; not consumed in the box-only first slice.)
    }

    if (nCandidates === 0) return null

    // Pass 2: validate each candidate against the iso-surface. Trilinear
    // interpolation of the SDF at a sharp feature has interpolation error
    // proportional to the voxel size — the SDF surface bends sharply over
    // one voxel, so the linear approximation can be off by a meaningful
    // fraction of `voxelSize`. Empirically, sample magnitudes at box
    // corners on a non-grid-aligned axis-aligned box land in the range
    // ~0.1·voxelSize, which is well above any tolerance smaller than
    // ~0.5·voxelSize.
    //
    // Tolerance is therefore set generously at `voxelSize * 0.75`. This is
    // still tight enough to reject CSG-cut-away contours (the SDF at a
    // cut-away point is at least one full voxel away from the surface,
    // since the cutter has to be ≥ voxelSize for the cut to be visible at
    // this resolution).
    //
    // Earlier code divided by `sqrt(nCandidates)` to "tighten near
    // corners". That's exactly backwards: corner cells have the most
    // candidates AND the most trilinear interpolation error, so the
    // tolerance should be at least as loose there as for single-edge
    // cells. The divisor has been removed.
    const adaptiveTol = grid.voxelSize * 0.75

    // Walk candidates in declaration order. We prefer points (corners) over
    // segments (lines) when both are valid — sort by kind asc since
    // ContourKind.Segment=0 < ContourKind.Point=1, so we pre-bias pass 1
    // to put points later. Easiest: do two sweeps.

    // First sweep: any valid point → corner snap.
    for (let i = 0; i < nCandidates; i++) {
        if (scratch.candidateKind[i] !== ContourKind.Point) continue
        const i3 = i * 3
        const px = scratch.candidatePos[i3]!,    py = scratch.candidatePos[i3 + 1]!, pz = scratch.candidatePos[i3 + 2]!
        const d = sampleScalarTrilinear(grid, px, py, pz)
        if (Math.abs(d) > adaptiveTol) continue
        const featureIdx = refIndex(scratch.candidateRef[i]!)
        return {
            x: px, y: py, z: pz,
            klass: 2,
            ownerId: pointOwners[featureIdx]!,
            featureIdx,
            tx: 0, ty: 0, tz: 0,
        }
    }

    // Second sweep: collect valid segment projections.
    let validSegs = 0
    let bestDistSq = Infinity
    let best = -1
    for (let i = 0; i < nCandidates; i++) {
        if (scratch.candidateKind[i] !== ContourKind.Segment) continue
        const i3 = i * 3
        const px = scratch.candidatePos[i3]!,    py = scratch.candidatePos[i3 + 1]!, pz = scratch.candidatePos[i3 + 2]!
        const d = sampleScalarTrilinear(grid, px, py, pz)
        if (Math.abs(d) > adaptiveTol) continue
        validSegs++
        // Track the segment whose projection is closest to `query` — that's
        // the one we'd snap to in the single-segment case.
        const dx = px - queryX, dy = py - queryY, dz = pz - queryZ
        const dsq = dx * dx + dy * dy + dz * dz
        if (dsq < bestDistSq) {
            bestDistSq = dsq
            best = i
        }
    }
    if (validSegs === 0 || best < 0) return null

    // For the box first slice, the box's corner cells produce 3 incident
    // segments (one per axis) — but the box's 8 corner *points* are also
    // contour elements and are caught by the first sweep above, so we
    // never reach this branch for a corner cell. Multi-segment behaviour
    // (without a covering point) is therefore deferred until a primitive
    // that has crossing segments without explicit corner points exists
    // (e.g. extrude at the convex hull of its outline).
    //
    // For now: snap to the closest valid segment projection.
    const i3 = best * 3
    const px = scratch.candidatePos[i3]!,    py = scratch.candidatePos[i3 + 1]!, pz = scratch.candidatePos[i3 + 2]!
    const segIdx = refIndex(scratch.candidateRef[best]!)
    const segOff = segIdx * 6
    const ax = segments[segOff]!,     ay = segments[segOff + 1]!, az = segments[segOff + 2]!
    const bx = segments[segOff + 3]!, by = segments[segOff + 4]!, bz = segments[segOff + 5]!
    const dx = bx - ax, dy = by - ay, dz = bz - az
    const segLen = Math.hypot(dx, dy, dz)
    const inv = segLen > 1e-12 ? 1 / segLen : 0
    return {
        x: px, y: py, z: pz,
        klass: 1,
        ownerId: segmentOwners[segIdx]!,
        featureIdx: segIdx,
        tx: dx * inv, ty: dy * inv, tz: dz * inv,
    }
}
