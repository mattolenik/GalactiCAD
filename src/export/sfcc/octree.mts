/**
 * SFCC octree — S2: certified worklist refinement with 2:1 balance.
 *
 * Build: descend from the root cube to `depthMin`, certified-empty-culling
 * subtrees whose Lipschitz interval excludes 0 (|f(center)| > √3·halfSize ⇒
 * no surface, and since features lie on the surface, no features). Then run
 * the refinement worklist: every leaf failing the criteria callback splits
 * (children are empty-culled on creation) until it passes or hits `depthMax`
 * (→ tagged degenerate). Splitting ripples a 2:1 balance constraint to
 * face-adjacent (and, by default, edge-adjacent) coarser neighbor leaves.
 *
 * Corner SDF samples live in a single global map keyed by lattice point —
 * every sample is evaluated exactly once, so neighboring faces and cells
 * always agree on signs. Sign convention: inside ⇔ f < 0.
 */

import type { CpuSdfTree } from "./cpu-sdf.mjs"
import { nowMs, type OctreeSamplePerf } from "./sfcc-perf.mjs"
import {
    cellKey,
    cellSizeAtLevel,
    pointToWorld,
    packPoint,
    strideAtLevel,
    type SfccLattice,
} from "./lattice.mjs"

export interface SfccCell {
    readonly level: number
    readonly ix: number
    readonly iy: number
    readonly iz: number
    /** Lattice key of the min corner (= per-level cell key). */
    readonly key: number
    /** Criteria still failing at depthMax — meshed best-effort, reported. */
    degenerate: boolean
    /** Feature curve passing through this cell (−1 = none); set by the criteria callback on pass. */
    featureCurve: number
    /** Feature corner inside this cell (−1 = none); used from P5. */
    featureCorner: number
}

export interface SfccOctree {
    readonly lat: SfccLattice
    /** Leaf cells per level, by min-corner lattice key. */
    readonly cellsByLevel: Array<Map<number, SfccCell>>
    /** Split (non-leaf) cells per level, by min-corner lattice key. */
    readonly internalByLevel: Array<Set<number>>
    readonly leaves: SfccCell[]
    readonly degenerateCells: number
    /** f at a lattice point, evaluated once and cached. */
    sampleAt(gx: number, gy: number, gz: number): number
    hasSampleKey(key: number): boolean
    isInternal(level: number, ix: number, iy: number, iz: number): boolean
}

export interface OctreeBuildOptions {
    depthMin: number
    depthMax: number
    enforceEdgeBalance: boolean
    /** Returns true when the leaf must split. Never called above depthMin. */
    needsSplit(cell: SfccCell, sampleAt: (gx: number, gy: number, gz: number) => number): boolean
    signal?: AbortSignal
    /** Opt-in profiling accumulators (intervalOverBox / tree.f memo-miss times + count). */
    perf?: OctreeSamplePerf
}

/** Face neighbors (6) and edge neighbors (12) as coordinate offsets. */
const FACE_NEIGHBORS: ReadonlyArray<readonly [number, number, number]> = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
]
const EDGE_NEIGHBORS: ReadonlyArray<readonly [number, number, number]> = [
    [1, 1, 0],
    [1, -1, 0],
    [-1, 1, 0],
    [-1, -1, 0],
    [1, 0, 1],
    [1, 0, -1],
    [-1, 0, 1],
    [-1, 0, -1],
    [0, 1, 1],
    [0, 1, -1],
    [0, -1, 1],
    [0, -1, -1],
]

export function buildOctree(tree: CpuSdfTree, lat: SfccLattice, opts: OctreeBuildOptions): SfccOctree {
    const { depthMin, depthMax, signal, perf } = opts
    if (depthMax > lat.maxDepth) throw new Error(`sfcc octree: depthMax ${depthMax} > lattice maxDepth ${lat.maxDepth}`)

    const samples = new Map<number, number>()
    const scratch = new Float64Array(3)
    const sampleAt = (gx: number, gy: number, gz: number): number => {
        const key = packPoint(lat, gx, gy, gz)
        const hit = samples.get(key)
        if (hit !== undefined) return hit
        pointToWorld(lat, gx, gy, gz, scratch)
        // Time only the memo MISS (the actual field eval — what a GPU batch would
        // replace); hits are a map lookup and stay uncounted.
        const t = perf ? nowMs() : 0
        const v = tree.f(scratch[0]!, scratch[1]!, scratch[2]!)
        if (perf) {
            perf.sampleMs += nowMs() - t
            perf.sampleEvals++
        }
        samples.set(key, v)
        return v
    }

    const cellsByLevel: Array<Map<number, SfccCell>> = []
    const internalByLevel: Array<Set<number>> = []
    for (let l = 0; l <= lat.maxDepth; l++) {
        cellsByLevel.push(new Map())
        internalByLevel.push(new Set())
    }

    const certifiedEmpty = (level: number, ix: number, iy: number, iz: number): boolean => {
        const half = cellSizeAtLevel(lat, level) / 2
        const stride = strideAtLevel(lat, level)
        pointToWorld(lat, (ix + 0.5) * stride, (iy + 0.5) * stride, (iz + 0.5) * stride, scratch)
        // Per-node interval bound (NOT a bare ±√3·half: twisted-extrude leaves
        // are locally super-1-Lipschitz and compose through the CSG min/max).
        const t = perf ? nowMs() : 0
        const [lo, hi] = tree.intervalOverBox(scratch[0]!, scratch[1]!, scratch[2]!, half, half, half)
        if (perf) perf.intervalMs += nowMs() - t
        return lo > 0 || hi < 0
    }

    const makeLeaf = (level: number, ix: number, iy: number, iz: number): SfccCell => {
        const key = cellKey(lat, level, ix, iy, iz)
        const cell: SfccCell = { level, ix, iy, iz, key, degenerate: false, featureCurve: -1, featureCorner: -1 }
        cellsByLevel[level]!.set(key, cell)
        const stride = strideAtLevel(lat, level)
        for (let c = 0; c < 8; c++) {
            sampleAt((ix + (c & 1)) * stride, (iy + ((c >> 1) & 1)) * stride, (iz + ((c >> 2) & 1)) * stride)
        }
        return cell
    }

    // --- initial descent to depthMin -----------------------------------------
    const worklist: SfccCell[] = []
    const descend = (level: number, ix: number, iy: number, iz: number): void => {
        if (signal?.aborted) throw new Error("sfcc: aborted")
        if (certifiedEmpty(level, ix, iy, iz)) return
        if (level === depthMin) {
            worklist.push(makeLeaf(level, ix, iy, iz))
            return
        }
        internalByLevel[level]!.add(cellKey(lat, level, ix, iy, iz))
        for (let c = 0; c < 8; c++) {
            descend(level + 1, ix * 2 + (c & 1), iy * 2 + ((c >> 1) & 1), iz * 2 + ((c >> 2) & 1))
        }
    }
    descend(0, 0, 0, 0)

    // --- refinement worklist with balance ripple ------------------------------
    const split = (cell: SfccCell): void => {
        cellsByLevel[cell.level]!.delete(cell.key)
        internalByLevel[cell.level]!.add(cell.key)
        for (let c = 0; c < 8; c++) {
            const cx = cell.ix * 2 + (c & 1)
            const cy = cell.iy * 2 + ((c >> 1) & 1)
            const cz = cell.iz * 2 + ((c >> 2) & 1)
            if (certifiedEmpty(cell.level + 1, cx, cy, cz)) continue
            worklist.push(makeLeaf(cell.level + 1, cx, cy, cz))
        }
        rippleBalance(cell)
    }

    /** After splitting `cell` (level L), coarser neighbors at level L−1 must split too. */
    const rippleBalance = (cell: SfccCell): void => {
        if (cell.level === 0) return
        const neighborSets = opts.enforceEdgeBalance ? [FACE_NEIGHBORS, EDGE_NEIGHBORS] : [FACE_NEIGHBORS]
        const parentLevel = cell.level - 1
        const maxIdx = (1 << cell.level) - 1
        for (const set of neighborSets) {
            for (const [dx, dy, dz] of set) {
                const nx = cell.ix + dx
                const ny = cell.iy + dy
                const nz = cell.iz + dz
                if (nx < 0 || ny < 0 || nz < 0 || nx > maxIdx || ny > maxIdx || nz > maxIdx) continue
                const coarse = cellsByLevel[parentLevel]!.get(cellKey(lat, parentLevel, nx >> 1, ny >> 1, nz >> 1))
                if (coarse) split(coarse)
            }
        }
    }

    let counter = 0
    while (worklist.length > 0) {
        const cell = worklist.pop()!
        if ((counter++ & 0x3f) === 0 && signal?.aborted) throw new Error("sfcc: aborted")
        // The cell may have been split by a balance ripple while queued.
        if (cellsByLevel[cell.level]!.get(cell.key) !== cell) continue
        if (!opts.needsSplit(cell, sampleAt)) continue
        if (cell.level >= depthMax) {
            cell.degenerate = true
            continue
        }
        split(cell)
    }

    const leaves: SfccCell[] = []
    let degenerateCells = 0
    for (const perLevel of cellsByLevel) {
        for (const cell of perLevel.values()) {
            leaves.push(cell)
            if (cell.degenerate) degenerateCells++
        }
    }

    return {
        lat,
        cellsByLevel,
        internalByLevel,
        leaves,
        degenerateCells,
        sampleAt,
        hasSampleKey: key => samples.has(key),
        isInternal: (level, ix, iy, iz) => {
            if (level < 0 || ix < 0 || iy < 0 || iz < 0) return false
            const maxIdx = (1 << level) - 1
            if (ix > maxIdx || iy > maxIdx || iz > maxIdx) return false
            return internalByLevel[level]!.has(cellKey(lat, level, ix, iy, iz))
        },
    }
}

/** Uniform-depth build (no refinement criteria) — used by tests. */
export function buildUniformOctree(
    tree: CpuSdfTree,
    lat: SfccLattice,
    leafDepth: number,
    signal?: AbortSignal,
): SfccOctree {
    return buildOctree(tree, lat, {
        depthMin: leafDepth,
        depthMax: leafDepth,
        enforceEdgeBalance: true,
        needsSplit: () => false,
        signal,
    })
}
