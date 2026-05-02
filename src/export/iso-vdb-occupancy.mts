/**
 * Coarse **CPU** occupancy for ISO Pass-1 brick streaming (plan Phase 2).
 *
 * OpenVDB-style top levels are approximated as a single axis-aligned shell around the
 * **tight** scene AABB from the bounds pass: any brick whose **owned core** (base-cube
 * indices `core0* .. core1*`) has a world AABB that does not intersect that shell is
 * skipped before gpuSparse work. This is conservative for void outside geometry; if tight
 * bounds are omitted, no bricks are culled.
 *
 * The margin is chosen to avoid false negatives: sampling error in bounds, Chebyshev-1
 * dilation, and the largest brick extent along a body diagonal.
 */

/** Subset of `IsoPass1Brick` — structural typing from `iso.mts` bricks. */
export type IsoPass1BrickCore = {
    core0X: number
    core0Y: number
    core0Z: number
    core1X: number
    core1Y: number
    core1Z: number
}

export type CoarseSceneOccupancyOptions = {
    gridOffsetX: number
    gridOffsetY: number
    gridOffsetZ: number
    voxelSize: number
    /** Same `pass1BrickCoreSpan` as brick tiling (`chooseIsoPass1BrickCoreSpan`). */
    pass1BrickCoreSpan: number
    /** Tight scene bounds (mm), same frame as `gridOffset*` / `voxelSize`. */
    sceneMinMm: readonly [number, number, number]
    sceneMaxMm: readonly [number, number, number]
}

/** Axis-aligned box min/max corners (index 0=min, 1=max per axis). */
export type Aabb3 = {
    x: readonly [number, number]
    y: readonly [number, number]
    z: readonly [number, number]
}

function isFinite3(t: readonly [number, number, number]): boolean {
    return Number.isFinite(t[0]) && Number.isFinite(t[1]) && Number.isFinite(t[2])
}

function aabbIntersects(a: Aabb3, b: Aabb3): boolean {
    if (a.x[1] < b.x[0] || a.x[0] > b.x[1]) return false
    if (a.y[1] < b.y[0] || a.y[0] > b.y[1]) return false
    if (a.z[1] < b.z[0] || a.z[0] > b.z[1]) return false
    return true
}

/**
 * World-space AABB for a brick's **owned core** base cubes `[core0, core1)` in mm.
 * Cube `cx` occupies X ∈ [gridOffset + cx*voxel, gridOffset + (cx+1)*voxel).
 */
export function isoBrickCoreWorldAabb(
    b: IsoPass1BrickCore,
    gridOffsetX: number,
    gridOffsetY: number,
    gridOffsetZ: number,
    voxelSize: number,
): Aabb3 {
    const v = voxelSize
    return {
        x: [
            gridOffsetX + b.core0X * v,
            gridOffsetX + b.core1X * v,
        ] as const,
        y: [
            gridOffsetY + b.core0Y * v,
            gridOffsetY + b.core1Y * v,
        ] as const,
        z: [
            gridOffsetZ + b.core0Z * v,
            gridOffsetZ + b.core1Z * v,
        ] as const,
    }
}

/**
 * Conservative expansion around tight scene bounds so iso crossings near the hull are
 * never culled. Includes half a brick diagonal (core span) and several voxel layers for
 * dilation / gradient band / sampling slack.
 */
export function coarseIsoOccupancyMarginMm(voxelSize: number, pass1BrickCoreSpan: number): number {
    const bw = Math.max(1, pass1BrickCoreSpan | 0)
    const halfBrickDiagMm = 0.5 * Math.sqrt(3) * bw * voxelSize
    const bandMm = voxelSize * (4 + 0.5 * bw)
    const floatSlackMm = 1e-4 * Math.max(
        1,
        Math.abs(halfBrickDiagMm),
        Math.abs(bandMm),
    )
    return halfBrickDiagMm + bandMm + floatSlackMm
}

export function inflateSceneAabbForIsoOccupancy(
    sceneMinMm: readonly [number, number, number],
    sceneMaxMm: readonly [number, number, number],
    marginMm: number,
): Aabb3 {
    const m = marginMm
    return {
        x: [sceneMinMm[0] - m, sceneMaxMm[0] + m] as const,
        y: [sceneMinMm[1] - m, sceneMaxMm[1] + m] as const,
        z: [sceneMinMm[2] - m, sceneMaxMm[2] + m] as const,
    }
}

export function filterIsoPass1BricksByCoarseSceneOccupancy<T extends IsoPass1BrickCore>(
    bricks: readonly T[],
    opts: CoarseSceneOccupancyOptions,
): { bricks: T[]; skipped: number; marginMm: number } {
    const {
        gridOffsetX,
        gridOffsetY,
        gridOffsetZ,
        voxelSize,
        pass1BrickCoreSpan,
        sceneMinMm,
        sceneMaxMm,
    } = opts

    if (bricks.length === 0) {
        return { bricks: [], skipped: 0, marginMm: 0 }
    }

    if (!isFinite3(sceneMinMm) || !isFinite3(sceneMaxMm)) {
        return { bricks: [...bricks], skipped: 0, marginMm: 0 }
    }

    if (
        sceneMinMm[0] > sceneMaxMm[0]
        || sceneMinMm[1] > sceneMaxMm[1]
        || sceneMinMm[2] > sceneMaxMm[2]
    ) {
        return { bricks: [...bricks], skipped: 0, marginMm: 0 }
    }

    if (!(voxelSize > 0 && Number.isFinite(voxelSize))) {
        return { bricks: [...bricks], skipped: 0, marginMm: 0 }
    }

    const marginMm = coarseIsoOccupancyMarginMm(voxelSize, pass1BrickCoreSpan)
    const shell = inflateSceneAabbForIsoOccupancy(sceneMinMm, sceneMaxMm, marginMm)

    const out: T[] = []
    let skipped = 0
    for (const b of bricks) {
        const core = isoBrickCoreWorldAabb(b, gridOffsetX, gridOffsetY, gridOffsetZ, voxelSize)
        if (aabbIntersects(core, shell)) {
            out.push(b)
        } else {
            skipped++
        }
    }

    return { bricks: out, skipped, marginMm }
}
