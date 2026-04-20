/**
 * Per-chain Laplacian smoothing for seam-classified cells.
 *
 * Background
 * ----------
 * After `mergeSharpRelocate`, every cell that `classifyCellSeam` flagged as
 * sitting on a CSG seam has its vertex placed via the rank-aware
 * pseudo-inverse — mathematically exact for a clean rank-2 case. In
 * practice the chain's vertices still trace a faintly wavy curve rather
 * than a perfect line: per-cell QEF noise, slight asymmetries in how the
 * seam tangent aligns with the voxel grid, and 3-plane corner cells at
 * chain ends all introduce sub-voxel wobble. Visually the seam reads as
 * almost-but-not-quite straight.
 *
 * Why we don't just project onto a fitted line
 * --------------------------------------------
 * An obvious "make the chain straight" approach is to fit a 3D line
 * through the chain's vertices (via SVD or via the SDF's seam tangent)
 * and project every vertex onto it. Two failure modes killed this:
 *
 * 1. **SDF-tangent line** — the SDF's analytical seam tangent doesn't
 *    always match the actual chain trajectory (e.g. a chain with cells
 *    spanning multiple voxel rows in the perpendicular axes). Projecting
 *    onto an axis-aligned line then pushes most chain vertices into
 *    *neighbouring* DC cells, breaking the topology guarantee.
 * 2. **SVD principal-axis line** — picks up per-cell perpendicular
 *    jitter as a small tilt in the principal direction, so end-of-chain
 *    cells get projected significantly off-axis. Same topology breakage,
 *    just from a different cause.
 *
 * Either way the global line approach is fundamentally incompatible with
 * Dual Contouring's "vertex stays in its own cell" invariant for chains
 * that aren't perfectly aligned to the voxel grid.
 *
 * What this pass does instead
 * ---------------------------
 * 1. **Chain construction.** Group seam cells into connected chains by
 *    walking the 6-neighbourhood graph, gating each neighbour on
 *    SDF-seam-tangent agreement (cosine threshold). One chain per
 *    coherent seam feature.
 * 2. **Order along the chain.** Walk each chain along its dominant
 *    seam-tangent axis and produce an ordered list — adjacent entries
 *    correspond to neighbouring cells along the seam.
 * 3. **Laplacian smoothing.** Apply N iterations of `vᵢ ← vᵢ + λ ·
 *    (½(vᵢ₋₁ + vᵢ₊₁) − vᵢ)`. Each step nudges every vertex toward the
 *    midpoint of its two chain-neighbours, cancelling per-cell
 *    perpendicular wobble while preserving the chain's overall shape.
 *    Endpoints stay pinned (they may be at 3-plane corner cells). The
 *    nudge per iteration is at most λ × (perpendicular distance to the
 *    midpoint), so a small `λ` keeps every vertex inside its DC cell —
 *    no clamp needed under normal conditions, with a defensive clamp
 *    retained for safety.
 */

import { log as dbgLog } from "../../logging/debug-log.mjs"
import { MESH_MDC_DEBUG_SAMPLE_STRIDE } from "../export.mjs"

/** Floats per vertex (matches `SIZEOF_VERTEX / 4` in `mdc.mts`). */
const VERTEX_STRIDE = 8

/**
 * Per-cell metadata captured by `mergeSharpRelocate` for cells classified
 * as on a CSG seam (klass=3). Used as input to the line-fit pass.
 */
export interface SeamCellRecord {
    /** Vertex index in the output mesh. */
    vi: number
    /** Cell coordinates within the SHREC voxel grid (used for adjacency). */
    cx: number
    cy: number
    cz: number
    /** Seam tangent (sign-disambiguated by `classifyCellSeam`). */
    tx: number
    ty: number
    tz: number
    /** Cell bounds (world space) for the post-fit clamp. */
    cellLoX: number
    cellLoY: number
    cellLoZ: number
    cellHiX: number
    cellHiY: number
    cellHiZ: number
}

export interface EdgeFitOptions {
    /**
     * Cosine of the angle threshold for tangent agreement when walking
     * the seam-cell adjacency graph. Default `cos(15°) ≈ 0.97` — same as
     * `seamAgreementCosThreshold` in `merge-sharp.mts`.
     */
    chainCosThreshold?: number
    /**
     * Skip chains shorter than this many cells — a 1- or 2-cell chain
     * has no interior vertex to smooth. Default 3.
     */
    minChainLength?: number
    /**
     * Number of Laplacian smoothing iterations. Each iteration pulls
     * interior vertices toward the midpoint of their chain-neighbours.
     * 2-4 iterations are usually enough to flatten sub-voxel wobble
     * without significantly shortening the chain. Default 3.
     */
    iterations?: number
    /**
     * Smoothing strength per iteration ∈ (0, 1]. λ=1 snaps each interior
     * vertex exactly to its chain-neighbours' midpoint per iteration
     * (over-smoothing); λ=0.5 is a balanced default that keeps every
     * single-iteration nudge to under half the perpendicular wobble.
     */
    lambda?: number
}

export interface EdgeFitStats {
    seamCellCount: number
    chainCount: number
    chainsSmoothed: number
    chainsTooShort: number
    /** Chains rejected because the per-cell tangent average came out near zero (cancelled-out signs). */
    chainsDegenerateTangent: number
    /** Interior chain vertices that received any displacement from smoothing. */
    verticesUpdated: number
    /** Vertices clamped to cell bounds after smoothing — should be 0 with a small λ. */
    verticesClamped: number
    /** Largest distance any single smoothing nudge moved a vertex (mm). */
    maxDisplacement: number
    /** Largest distance any single clamp moved a vertex (mm) — diagnostic for whether the clamp matters visually. */
    maxClampDistance: number
    elapsedMs: number
    /** Distribution of chain lengths (cells per chain) for telemetry. Sorted ascending. */
    chainLengths: number[]
}

/** Pack `(cx, cy, cz)` into a 64-bit BigInt key for the seam-cell adjacency map. */
function packCellKey(cx: number, cy: number, cz: number): bigint {
    return ((BigInt(cx + 0x100000) & 0x1fffffn) << 42n) |
           ((BigInt(cy + 0x100000) & 0x1fffffn) << 21n) |
           (BigInt(cz + 0x100000) & 0x1fffffn)
}

/** Six face-neighbour offsets used to walk the seam-cell adjacency graph. */
const FACE_NEIGHBOR_OFFSETS: ReadonlyArray<readonly [number, number, number]> = [
    [+1, 0, 0], [-1, 0, 0],
    [0, +1, 0], [0, -1, 0],
    [0, 0, +1], [0, 0, -1],
]

/**
 * Refine seam-cell vertex positions by fitting a 3D line per coherent
 * chain and projecting all chain vertices onto it.
 *
 * `verts` is mutated in place. When `debugSamples` is non-null its
 * position fields (`[0..2]` and `[8..10]` per record) are also updated so
 * the mesh-viewer overlay reflects the new positions. Returns per-chain
 * statistics for the dev log.
 */
export function fitSeamEdges(
    verts: Float32Array,
    debugSamples: Float32Array | null,
    seamCells: SeamCellRecord[],
    opts: EdgeFitOptions = {},
): EdgeFitStats {
    const t0 = perfNow()
    const cosThreshold = opts.chainCosThreshold ?? 0.97
    const minChainLength = Math.max(3, opts.minChainLength ?? 3)
    const iterations = Math.max(1, opts.iterations ?? 3)
    const lambda = Math.max(0, Math.min(1, opts.lambda ?? 0.5))

    // Index seam cells by cell coord for O(1) neighbour lookup.
    const cellMap = new Map<bigint, SeamCellRecord>()
    for (const s of seamCells) {
        cellMap.set(packCellKey(s.cx, s.cy, s.cz), s)
    }

    const visited = new Set<bigint>()
    const chainLengths: number[] = []
    let chainCount = 0
    let chainsSmoothed = 0
    let chainsTooShort = 0
    let chainsDegenerateTangent = 0
    let verticesUpdated = 0
    let verticesClamped = 0
    let maxDisplacement = 0
    let maxClampDistance = 0

    for (const seed of seamCells) {
        const seedKey = packCellKey(seed.cx, seed.cy, seed.cz)
        if (visited.has(seedKey)) continue

        // BFS this connected component, gating each neighbour on
        // tangent-agreement so distinct seams don't merge into one chain
        // (e.g. two perpendicular seams meeting at a corner).
        const chain: SeamCellRecord[] = []
        const stack: SeamCellRecord[] = [seed]
        while (stack.length > 0) {
            const c = stack.pop()!
            const key = packCellKey(c.cx, c.cy, c.cz)
            if (visited.has(key)) continue
            visited.add(key)
            chain.push(c)
            for (const off of FACE_NEIGHBOR_OFFSETS) {
                const nKey = packCellKey(c.cx + off[0], c.cy + off[1], c.cz + off[2])
                if (visited.has(nKey)) continue
                const n = cellMap.get(nKey)
                if (!n) continue
                // Sign-corrected dot — the seam tangents are already
                // sign-disambiguated within their own cells, but two
                // adjacent cells can independently flip sign.
                const dot = c.tx * n.tx + c.ty * n.ty + c.tz * n.tz
                if (Math.abs(dot) < cosThreshold) continue
                stack.push(n)
            }
        }

        chainCount++
        chainLengths.push(chain.length)
        if (chain.length < minChainLength) {
            chainsTooShort++
            continue
        }

        // Establish the chain's dominant tangent axis (averaged from
        // per-cell SDF seam tangents, sign-corrected) so we can sort the
        // cells along it. Adjacent cells in the sorted order are then
        // chain-neighbours for smoothing.
        const ref = chain[0]!
        let dx0 = 0, dy0 = 0, dz0 = 0
        for (const s of chain) {
            const dot = s.tx * ref.tx + s.ty * ref.ty + s.tz * ref.tz
            const sign = dot >= 0 ? 1 : -1
            dx0 += sign * s.tx
            dy0 += sign * s.ty
            dz0 += sign * s.tz
        }
        const dlen = Math.hypot(dx0, dy0, dz0)
        if (dlen < 1e-12) {
            chainsDegenerateTangent++
            continue
        }
        dx0 /= dlen; dy0 /= dlen; dz0 /= dlen

        // Sort cells along the chain by their projection onto the seam
        // tangent. For an axis-aligned seam this just sorts by the
        // dominant cell coord (cellX/cellY/cellZ); for a slightly tilted
        // seam the projection still gives a monotonic order along the
        // chain. Keep the SeamCellRecord and a 1-D parameter together for
        // O(N log N) sort and O(N) smoothing iterations.
        const ordered = chain.map(s => {
            const b = s.vi * VERTEX_STRIDE
            return {
                s,
                vx: verts[b]!,
                vy: verts[b + 1]!,
                vz: verts[b + 2]!,
                t: verts[b]! * dx0 + verts[b + 1]! * dy0 + verts[b + 2]! * dz0,
            }
        })
        ordered.sort((a, b) => a.t - b.t)

        chainsSmoothed++

        // Laplacian smoothing along the chain. Iterate `iterations`
        // passes; each pass nudges every interior vertex by `λ × (mid −
        // current)` where `mid` is the midpoint of its two
        // chain-neighbours. Endpoints are pinned. Per-pass nudge ≤ λ ×
        // perpendicular wobble — for λ=0.5 and ~0.05 mm wobble that's
        // 0.025 mm per pass, well under a voxel. After 3 passes a
        // sub-voxel zigzag flattens out essentially completely.
        // Use scratch arrays so each iteration reads from the current
        // state and writes into the next state, avoiding chain-direction
        // smoothing bias.
        const N = ordered.length
        const curX = new Float64Array(N)
        const curY = new Float64Array(N)
        const curZ = new Float64Array(N)
        for (let i = 0; i < N; i++) {
            curX[i] = ordered[i]!.vx
            curY[i] = ordered[i]!.vy
            curZ[i] = ordered[i]!.vz
        }
        const nextX = new Float64Array(N)
        const nextY = new Float64Array(N)
        const nextZ = new Float64Array(N)
        for (let it = 0; it < iterations; it++) {
            nextX[0] = curX[0]!; nextY[0] = curY[0]!; nextZ[0] = curZ[0]!
            nextX[N - 1] = curX[N - 1]!; nextY[N - 1] = curY[N - 1]!; nextZ[N - 1] = curZ[N - 1]!
            for (let i = 1; i < N - 1; i++) {
                const mx = 0.5 * (curX[i - 1]! + curX[i + 1]!)
                const my = 0.5 * (curY[i - 1]! + curY[i + 1]!)
                const mz = 0.5 * (curZ[i - 1]! + curZ[i + 1]!)
                nextX[i] = curX[i]! + lambda * (mx - curX[i]!)
                nextY[i] = curY[i]! + lambda * (my - curY[i]!)
                nextZ[i] = curZ[i]! + lambda * (mz - curZ[i]!)
            }
            curX.set(nextX); curY.set(nextY); curZ.set(nextZ)
        }

        // Write back, with a defensive cell-bounds clamp for safety.
        // With λ=0.5 and small wobble, the clamp normally never fires;
        // count + report any clamp so we know if a chain misbehaves.
        for (let i = 0; i < N; i++) {
            const o = ordered[i]!
            const b = o.s.vi * VERTEX_STRIDE
            let nx = curX[i]!, ny = curY[i]!, nz = curZ[i]!
            const ox_ = nx, oy_ = ny, oz_ = nz
            if (nx < o.s.cellLoX) nx = o.s.cellLoX
            else if (nx > o.s.cellHiX) nx = o.s.cellHiX
            if (ny < o.s.cellLoY) ny = o.s.cellLoY
            else if (ny > o.s.cellHiY) ny = o.s.cellHiY
            if (nz < o.s.cellLoZ) nz = o.s.cellLoZ
            else if (nz > o.s.cellHiZ) nz = o.s.cellHiZ
            const cdx = nx - ox_, cdy = ny - oy_, cdz = nz - oz_
            const cdist = Math.hypot(cdx, cdy, cdz)
            if (cdist > 0) {
                verticesClamped++
                if (cdist > maxClampDistance) maxClampDistance = cdist
            }

            const ddx = nx - o.vx, ddy = ny - o.vy, ddz = nz - o.vz
            const ddist = Math.hypot(ddx, ddy, ddz)
            if (ddist > 0) {
                verticesUpdated++
                if (ddist > maxDisplacement) maxDisplacement = ddist
            }

            verts[b] = nx
            verts[b + 1] = ny
            verts[b + 2] = nz

            if (debugSamples) {
                const d = o.s.vi * MESH_MDC_DEBUG_SAMPLE_STRIDE
                debugSamples[d] = nx
                debugSamples[d + 1] = ny
                debugSamples[d + 2] = nz
                debugSamples[d + 8] = nx
                debugSamples[d + 9] = ny
                debugSamples[d + 10] = nz
            }
        }
    }

    chainLengths.sort((a, b) => a - b)
    const stats: EdgeFitStats = {
        seamCellCount: seamCells.length,
        chainCount,
        chainsSmoothed,
        chainsTooShort,
        chainsDegenerateTangent,
        verticesUpdated,
        verticesClamped,
        maxDisplacement,
        maxClampDistance,
        elapsedMs: perfNow() - t0,
        chainLengths,
    }
    dbgLog("ShrecExport").debug(
        `fitSeamEdges (Laplacian): cells=${stats.seamCellCount} chains=${stats.chainCount} ` +
        `smoothed=${stats.chainsSmoothed} tooShort=${stats.chainsTooShort} ` +
        `degenerateTangent=${stats.chainsDegenerateTangent} ` +
        `verticesUpdated=${stats.verticesUpdated} verticesClamped=${stats.verticesClamped} ` +
        `maxDisp=${stats.maxDisplacement.toExponential(2)}mm ` +
        `maxClampDist=${stats.maxClampDistance.toExponential(2)}mm ` +
        `chainLengths=[${stats.chainLengths.join(",")}] ` +
        `elapsed=${stats.elapsedMs.toFixed(1)}ms`,
    )
    return stats
}

function perfNow(): number {
    return globalThis.performance?.now ? globalThis.performance.now() : Date.now()
}
