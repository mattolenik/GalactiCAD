/**
 * Integer-lattice addressing for the SFCC octree.
 *
 * All topological identity in SFCC is integer: octree corners, cells, faces and
 * edges are keyed by lattice coordinates at the finest level (`maxDepth`).
 * Float positions are payload, never keys — this is what makes shared face data,
 * hanging-node handling, and the S4 closedness audit exact.
 *
 * A lattice point (gx, gy, gz) ∈ [0, res]³ (res = 1 << maxDepth cells per axis,
 * span = res + 1 points per axis) packs into a single f64-exact integer key:
 * with SFCC_MAX_DEPTH = 14, span = 16385 and span³ ≈ 4.4e12 < 2^53.
 *
 * Math here is f64 scalars only — never Vec3f (f32-backed).
 */

import { SFCC_MAX_DEPTH } from "./sfcc-tuning.mjs"

export interface SfccLattice {
    /** Finest octree level; lattice resolution is 2^maxDepth cells per axis. */
    readonly maxDepth: number
    /** Cells per axis at maxDepth: 1 << maxDepth. */
    readonly res: number
    /** Lattice points per axis: res + 1. */
    readonly span: number
    /** World position (mm) of lattice point (0, 0, 0) — root cube min corner, jitter included. */
    readonly originX: number
    readonly originY: number
    readonly originZ: number
    /** Root cube edge length (mm). */
    readonly worldSize: number
    /** World size (mm) of one lattice step (= max-depth cell edge). */
    readonly step: number
}

export function makeLattice(
    maxDepth: number,
    originX: number,
    originY: number,
    originZ: number,
    worldSize: number,
): SfccLattice {
    if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > SFCC_MAX_DEPTH) {
        throw new Error(`sfcc lattice: maxDepth ${maxDepth} outside [1, ${SFCC_MAX_DEPTH}]`)
    }
    if (!(worldSize > 0) || !Number.isFinite(worldSize)) {
        throw new Error(`sfcc lattice: invalid worldSize ${worldSize}`)
    }
    const res = 1 << maxDepth
    return {
        maxDepth,
        res,
        span: res + 1,
        originX,
        originY,
        originZ,
        worldSize,
        step: worldSize / res,
    }
}

/** Pack a lattice point into its unique f64-exact integer key. */
export function packPoint(lat: SfccLattice, gx: number, gy: number, gz: number): number {
    return (gx * lat.span + gy) * lat.span + gz
}

/** Inverse of {@link packPoint}; writes [gx, gy, gz] into `out`. */
export function unpackPoint(lat: SfccLattice, key: number, out: [number, number, number]): void {
    const s = lat.span
    const gz = key % s
    const rest = (key - gz) / s
    const gy = rest % s
    out[0] = (rest - gy) / s
    out[1] = gy
    out[2] = gz
}

/** World position (mm) of a lattice point; writes x,y,z into `out` at `off`. */
export function pointToWorld(
    lat: SfccLattice,
    gx: number,
    gy: number,
    gz: number,
    out: Float64Array,
    off = 0,
): void {
    out[off] = lat.originX + gx * lat.step
    out[off + 1] = lat.originY + gy * lat.step
    out[off + 2] = lat.originZ + gz * lat.step
}

/** Lattice units spanned by one cell edge at `level`: 1 << (maxDepth − level). */
export function strideAtLevel(lat: SfccLattice, level: number): number {
    return 1 << (lat.maxDepth - level)
}

/** World edge length (mm) of a cell at `level`. */
export function cellSizeAtLevel(lat: SfccLattice, level: number): number {
    return lat.worldSize / (1 << level)
}

/**
 * Key of a cell at (level, ix, iy, iz) — the packed lattice point of its min
 * corner. Unique per level; callers store cells in per-level maps.
 */
export function cellKey(lat: SfccLattice, level: number, ix: number, iy: number, iz: number): number {
    const s = strideAtLevel(lat, level)
    return packPoint(lat, ix * s, iy * s, iz * s)
}

/**
 * Corner order convention used everywhere in SFCC: corner index c ∈ [0, 8) has
 * lattice offset (c&1, (c>>1)&1, (c>>2)&1) × stride — bit 0 = x, bit 1 = y,
 * bit 2 = z.
 */
export function cornerOffset(c: number, axis: 0 | 1 | 2): number {
    return (c >> axis) & 1
}

/**
 * The 12 cell edges as [cornerA, cornerB] index pairs (A < B, differing in one
 * bit). Grouped by axis: edges 0–3 along x, 4–7 along y, 8–11 along z.
 */
export const CELL_EDGES: ReadonlyArray<readonly [number, number]> = [
    // x-axis (bit 0)
    [0, 1],
    [2, 3],
    [4, 5],
    [6, 7],
    // y-axis (bit 1)
    [0, 2],
    [1, 3],
    [4, 6],
    [5, 7],
    // z-axis (bit 2)
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
]

/** Axis (0|1|2) of CELL_EDGES[e]. */
export function cellEdgeAxis(e: number): 0 | 1 | 2 {
    return (e >> 2) as 0 | 1 | 2
}

/**
 * In-face axes (u, v) for a face with normal `axis`, in the cyclic order that
 * makes u × v = +axis — so a boundary walk in (u, v) order is CCW viewed from
 * the +axis side for every axis (ascending order would flip axis 1).
 */
export function faceAxes(axis: 0 | 1 | 2): readonly [0 | 1 | 2, 0 | 1 | 2] {
    return axis === 0 ? [1, 2] : axis === 1 ? [2, 0] : [0, 1]
}

/**
 * Collect existing interior lattice points on an axis-aligned edge, in order.
 *
 * The edge runs from lattice point (gx, gy, gz) for `len` lattice units along
 * `axis`. `hasPoint(key)` answers whether a corner sample exists at a lattice
 * key (the global octree corner-sample map). Interior points are discovered by
 * recursive midpoint subdivision, which is exhaustive for octree-generated
 * samples: any leaf corner interior to a segment implies a leaf corner at that
 * segment's midpoint chain (leaf corners sit at dyadic positions, and each
 * leaf's opposite corner along the edge line is also in the map).
 *
 * Appends the interior offsets (relative to the edge start, exclusive of 0 and
 * `len`) into `out`, sorted ascending. Returns `out`.
 */
export function collectEdgeInteriorOffsets(
    hasPoint: (key: number) => boolean,
    lat: SfccLattice,
    axis: 0 | 1 | 2,
    gx: number,
    gy: number,
    gz: number,
    len: number,
    out: number[],
): number[] {
    collectInterior(hasPoint, lat, axis, gx, gy, gz, 0, len, out)
    return out
}

function collectInterior(
    hasPoint: (key: number) => boolean,
    lat: SfccLattice,
    axis: 0 | 1 | 2,
    gx: number,
    gy: number,
    gz: number,
    lo: number,
    hi: number,
    out: number[],
): void {
    const span = hi - lo
    if (span < 2 || span % 2 !== 0) return
    const mid = lo + span / 2
    const mx = axis === 0 ? gx + mid : gx
    const my = axis === 1 ? gy + mid : gy
    const mz = axis === 2 ? gz + mid : gz
    if (!hasPoint(packPoint(lat, mx, my, mz))) return
    collectInterior(hasPoint, lat, axis, gx, gy, gz, lo, mid, out)
    out.push(mid)
    collectInterior(hasPoint, lat, axis, gx, gy, gz, mid, hi, out)
}

/** World-space AABB of a cell; writes [minX, minY, minZ, maxX, maxY, maxZ] into `out`. */
export function cellAabb(
    lat: SfccLattice,
    level: number,
    ix: number,
    iy: number,
    iz: number,
    out: Float64Array,
): void {
    const size = cellSizeAtLevel(lat, level)
    const x = lat.originX + ix * size
    const y = lat.originY + iy * size
    const z = lat.originZ + iz * size
    out[0] = x
    out[1] = y
    out[2] = z
    out[3] = x + size
    out[4] = y + size
    out[5] = z + size
}
