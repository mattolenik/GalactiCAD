/**
 * Phase-1 **brick streaming** layout for ISO export: choose owned base-cube counts
 * `Bx×By×Bz` from GPU limits, partition the global cube grid with a **1-cube halo**
 * between bricks (Chebyshev-1 dilation / `iso-sparse` shell), and map brick-local
 * indices to **global** linear keys used after merge (`encodeSparseDualHashKey`, `lookup_dual_slot`).
 *
 * ## Global linear indices (full grid)
 *
 * These match `computeSparseDualSetsFromDilatedCubeLinears` and WGSL hash helpers.
 * Let `(dx, dy, dz)` be vertex counts and `nx = dx - 1`, `ny = dy - 1`, `nz = dz - 1`
 * base-cube counts along X/Y/Z for the **entire** export (same as `ISOParams` grid).
 *
 * - **Corner** (`cellType` 0): `ix + iy * dx + iz * dx * dy`, with `ix ∈ [0, dx)`, etc.
 * - **X-edge** (1): index into `(dx-1) * dy * dz` lexicographic order over `(ix, iy, iz)`.
 * - **Y-edge** (2), **Z-edge** (3): analogous strided layouts (see `iso-sparse.mts`).
 * - **XY-face** (4), **YZ-face** (5), **XZ-face** (6): same convention as sparse enumeration.
 * - **Base cube** (7) / dilated-cube compaction: `cx + cy * nx + cz * nx * ny` with
 *   `cx ∈ [0, nx)`, `cy ∈ [0, ny)`, `cz ∈ [0, nz)`.
 *
 * ## Brick-owned vs dense Pass-1 subgrid
 *
 * - **Owned** base cubes: disjoint axis-aligned boxes that tile `[0, nx) × [0, ny) × [0, nz)`.
 * - **Dense buffers** for a brick cover **owned ∪ halo**: one extra global base-cube layer on
 *   any side where there is another brick or interior space, clamped to the domain. Adjacent
 *   bricks **overlap by exactly one base cube** on shared faces so dilation sees the same
 *   neighbor mask as a monolithic grid (`ISO_BRICK_HALO_CUBES === 1`).
 *
 * ## Brick-local → global offsets
 *
 * For a brick, let `(cubeMinX, cubeMinY, cubeMinZ)` be the **global** minimum base-cube
 * indices stored in that brick’s dense subgrid (includes halo). A brick-local base-cube
 * coordinate `(lx, ly, lz)` with `lx ∈ [0, nxDense)` maps to global:
 *
 *   `cx = cubeMinX + lx`, `cy = cubeMinY + ly`, `cz = cubeMinZ + lz`.
 *
 * **Global cube linear**: `cx + cy * nx + cz * nx * ny` (same `nx, ny, nz` as full grid).
 *
 * For **corners**, brick-local vertex indices `(vx, …)` map to global vertex indices
 * `ix = vx + vertMinX` where `vertMinX = cubeMinX` (corners align with base cubes); use the
 * brick’s dense `(denseDx, denseDy, denseDy)` the same way as full-grid `(dx, dy, dz)` when
 * emitting category-local linears, then add category base offsets **after** converting to the
 * global index space if building absolute slot indices for the unified buffer.
 */

import { estimateIsoExportBufferBytes } from "./iso.mjs"

/** Halo thickness in **base cubes** for brick boundaries (matches sparse dilation shell). */
export const ISO_BRICK_HALO_CUBES = 1

export interface GpuLimitsLike {
    maxBufferSize: number
    maxStorageBufferBindingSize: number
}

/** Conservative byte budget: each Phase-1 buffer must satisfy **both** limits. */
export function effectiveGpuLimitBytes(limits: GpuLimitsLike): number {
    return Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize)
}

/**
 * Bytes for the Phase-1 **dense tier** on a grid of vertex size `(dx,dy,dz)`:
 * `activeCellFlags` plus two full `nx×ny×nz` u32 cube buffers (`gpuSparseCubeMarks`,
 * `gpuSparseDilatedCubeList`) — see `ISOExport.export`.
 */
export function isoBrickPhase1DenseTierMaxComponentBytes(dx: number, dy: number, dz: number): number {
    const flags = estimateIsoExportBufferBytes(dx, dy, dz).activeCellFlags
    const nx = Math.max(0, dx - 1)
    const ny = Math.max(0, dy - 1)
    const nz = Math.max(0, dz - 1)
    const cubeBytes = nx * ny * nz * Uint32Array.BYTES_PER_ELEMENT
    return Math.max(flags, cubeBytes)
}

/** True iff each Phase-1 dense-tier buffer fits `limitBytes`. */
export function fitsIsoBrickPhase1DenseTier(dx: number, dy: number, dz: number, limitBytes: number): boolean {
    const est = estimateIsoExportBufferBytes(dx, dy, dz)
    const nx = Math.max(0, dx - 1)
    const ny = Math.max(0, dy - 1)
    const nz = Math.max(0, dz - 1)
    const cubeBytes = nx * ny * nz * Uint32Array.BYTES_PER_ELEMENT
    return est.activeCellFlags <= limitBytes && cubeBytes <= limitBytes
}

/**
 * Dense vertex grid **(dx,dy,dz)** for an **interior** brick (all six halo directions
 * available): owned base-cube counts `(bx,by,bz)` plus `2 * ISO_BRICK_HALO_CUBES` cubes
 * along each axis → `nxDense = bx + 2`, `dx = nxDense + 1`, etc.
 */
export function interiorBrickDenseVertexDims(
    ownedBx: number,
    ownedBy: number,
    ownedBz: number,
): { dx: number; dy: number; dz: number } {
    const h = ISO_BRICK_HALO_CUBES
    const nxDense = ownedBx + 2 * h
    const nyDense = ownedBy + 2 * h
    const nzDense = ownedBz + 2 * h
    return {
        dx: nxDense + 1,
        dy: nyDense + 1,
        dz: nzDense + 1,
    }
}

/**
 * Maximum uniform owned edge length `B` such that an **interior** brick `B×B×B` fits
 * Phase-1 dense buffers under `limits`. Uses binary search; returns at least `1` if any
 * brick fits, else `0` (caller should coarsen voxel / use non-brick path).
 */
export function computeIsoBrickUniformOwnedCubeDim(limits: GpuLimitsLike): number {
    const limit = effectiveGpuLimitBytes(limits)
    const fitsUniform = (b: number) => {
        if (b < 1) return true
        const { dx, dy, dz } = interiorBrickDenseVertexDims(b, b, b)
        return fitsIsoBrickPhase1DenseTier(dx, dy, dz, limit)
    }
    if (!fitsUniform(1)) return 0
    let lo = 1
    let hi = 2
    while (hi < 1_000_000 && fitsUniform(hi)) {
        lo = hi
        hi <<= 1
    }
    while (lo + 1 < hi) {
        const mid = (lo + hi) >>> 1
        if (fitsUniform(mid)) lo = mid
        else hi = mid
    }
    return lo
}

/**
 * Same limit check as `computeIsoBrickUniformOwnedCubeDim`, but allows **axis-aligned**
 * brick boxes. Greedy: start from uniform `B`, then grow `bx`, `by`, `bz` independently
 * while interior dims still fit (helps elongated scenes).
 */
export function computeIsoBrickOwnedCubeDims(limits: GpuLimitsLike): { bx: number; by: number; bz: number } {
    const limit = effectiveGpuLimitBytes(limits)
    const B = computeIsoBrickUniformOwnedCubeDim(limits)
    if (B < 1) return { bx: 0, by: 0, bz: 0 }

    const tryGrow = (bx: number, by: number, bz: number, axis: 0 | 1 | 2): { bx: number; by: number; bz: number } => {
        const next = axis === 0
            ? { bx: bx + 1, by, bz }
            : axis === 1
            ? { bx, by: by + 1, bz }
            : { bx, by, bz: bz + 1 }
        const { dx, dy, dz } = interiorBrickDenseVertexDims(next.bx, next.by, next.bz)
        return fitsIsoBrickPhase1DenseTier(dx, dy, dz, limit) ? next : { bx, by, bz }
    }

    let bx = B
    let by = B
    let bz = B
    for (let axis = 0 as 0 | 1 | 2; axis < 3; axis++) {
        while (true) {
            const grown = tryGrow(bx, by, bz, axis)
            if (grown.bx === bx && grown.by === by && grown.bz === bz) break
            bx = grown.bx
            by = grown.by
            bz = grown.bz
        }
    }
    return { bx, by, bz }
}

export interface IsoBrickDescriptor {
    /** Brick index in scan order X fastest, then Y, then Z. */
    brickIndex: number
    /** Global owned cube range start `(ox, oy, oz)` (inclusive). */
    ownedCubeOrigin: [number, number, number]
    /** Owned base-cube counts along each axis (last bricks may be `< bx`). */
    ownedCubeCount: [number, number, number]
    /** Minimum global base-cube indices included in this brick’s dense subgrid (includes halo). */
    denseCubeOrigin: [number, number, number]
    /** Dense subgrid vertex counts `(denseDx, denseDy, denseDz)` for Pass-1 allocation. */
    denseVertexDims: [number, number, number]
}

/**
 * Partition `[0, nx) × [0, ny) × [0, nz)` into bricks of up to `(bx,by,bz)` owned cubes
 * per axis, with 1-cube halo rules encoded in `denseCubeOrigin` / `denseVertexDims`.
 */
export function enumerateIsoBricks(
    nx: number,
    ny: number,
    nz: number,
    bx: number,
    by: number,
    bz: number,
): IsoBrickDescriptor[] {
    if (nx <= 0 || ny <= 0 || nz <= 0) return []
    const obx = Math.max(1, bx)
    const oby = Math.max(1, by)
    const obz = Math.max(1, bz)
    const out: IsoBrickDescriptor[] = []
    let brickIndex = 0
    for (let oz = 0; oz < nz; oz += obz) {
        const wz = Math.min(obz, nz - oz)
        for (let oy = 0; oy < ny; oy += oby) {
            const wy = Math.min(oby, ny - oy)
            for (let ox = 0; ox < nx; ox += obx) {
                const wx = Math.min(obx, nx - ox)
                const cubeMinX = ox > 0 ? ox - ISO_BRICK_HALO_CUBES : 0
                const cubeMinY = oy > 0 ? oy - ISO_BRICK_HALO_CUBES : 0
                const cubeMinZ = oz > 0 ? oz - ISO_BRICK_HALO_CUBES : 0
                const cubeMaxExX = ox + wx < nx ? ox + wx + ISO_BRICK_HALO_CUBES : nx
                const cubeMaxExY = oy + wy < ny ? oy + wy + ISO_BRICK_HALO_CUBES : ny
                const cubeMaxExZ = oz + wz < nz ? oz + wz + ISO_BRICK_HALO_CUBES : nz
                const nxDense = cubeMaxExX - cubeMinX
                const nyDense = cubeMaxExY - cubeMinY
                const nzDense = cubeMaxExZ - cubeMinZ
                out.push({
                    brickIndex: brickIndex++,
                    ownedCubeOrigin: [ox, oy, oz],
                    ownedCubeCount: [wx, wy, wz],
                    denseCubeOrigin: [cubeMinX, cubeMinY, cubeMinZ],
                    denseVertexDims: [nxDense + 1, nyDense + 1, nzDense + 1],
                })
            }
        }
    }
    return out
}
