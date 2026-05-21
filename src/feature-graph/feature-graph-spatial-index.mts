/**
 * Cell-keyed spatial index over the FeatureGraph (stage 5 v1, CPU).
 *
 * Mirrors {@link ContourSpatialIndex} in structure — `cellMap.get(cellKey)`
 * returns the list of feature refs whose AABB touches that cell, widened by
 * ½-cell to handle boundary-coincident AABBs the same way SHREC does. Cells
 * are indexed off the world origin (cell origin = `cellCoord · cellSize`); no
 * gridOffset parameter for v1 since downstream meshers haven't yet selected
 * their bounds at FeatureGraph build time.
 *
 * Phase D consumers: nothing yet — the index is built for completeness so
 * phase 6 (mesher integration) can read from a stable shape. The Phase D
 * log line reports `cellsOccupied` so we can sanity-check binning works.
 *
 * Loops are intentionally out of v1 — a cap loop covers a planar face area
 * that may overlap many cells (a 10 mm × 10 mm cap at 0.1 mm cells = 10⁴
 * cells). Phase 6 can revisit when an actual mesher needs cap-face refs.
 */

import type { FeatureGraphCpu } from "../scene/feature-graph-buffer.mjs"
import { FG_FLAG_ALIVE } from "../scene/feature-graph-buffer.mjs"
import type { FeatureGraphWorldPositions } from "./feature-graph-gpu.mjs"

export const FG_REF_KIND_VERTEX = 0
export const FG_REF_KIND_EDGE = 1

/** Packed feature reference: kind in top 2 bits, index in bottom 30. */
export type FGFeatureRef = number

export function encodeFeatureRef(kind: 0 | 1, index: number): FGFeatureRef {
    return ((kind & 0x3) << 30) | (index & 0x3fffffff)
}

export function decodeFeatureRefKind(ref: FGFeatureRef): 0 | 1 {
    return ((ref >>> 30) & 0x3) as 0 | 1
}

export function decodeFeatureRefIndex(ref: FGFeatureRef): number {
    return ref & 0x3fffffff
}

export class FeatureGraphSpatialIndex {
    /** `cellMap.get(cellKey) → Int32Array` of feature refs touching that cell. */
    private cellMap: Map<bigint, Int32Array>
    readonly cellSize: number

    private constructor(cellSize: number, cellMap: Map<bigint, Int32Array>) {
        this.cellSize = cellSize
        this.cellMap = cellMap
    }

    static empty(cellSize: number): FeatureGraphSpatialIndex {
        return new FeatureGraphSpatialIndex(cellSize, new Map())
    }

    /**
     * Build the index from alive vertices + edges. Each vertex is binned into
     * the (one or 2³) cells its ½-cell neighbourhood touches; each edge is
     * binned into all cells its AABB touches (also widened by ½-cell).
     */
    static build(
        cpu: FeatureGraphCpu,
        world: FeatureGraphWorldPositions,
        cellSize: number,
    ): FeatureGraphSpatialIndex {
        const accum = new Map<bigint, number[]>()
        const inv = 1 / cellSize
        const eps = cellSize * 0.5

        const insertRange = (
            ref: FGFeatureRef,
            minX: number, minY: number, minZ: number,
            maxX: number, maxY: number, maxZ: number,
        ): void => {
            const cx0 = Math.floor((minX - eps) * inv)
            const cy0 = Math.floor((minY - eps) * inv)
            const cz0 = Math.floor((minZ - eps) * inv)
            const cx1 = Math.floor((maxX + eps) * inv)
            const cy1 = Math.floor((maxY + eps) * inv)
            const cz1 = Math.floor((maxZ + eps) * inv)
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

        for (let i = 0; i < cpu.vertexCount; i++) {
            if ((cpu.vertexFlags[i]! & FG_FLAG_ALIVE) === 0) continue
            const x = world.positions[i * 3]!
            const y = world.positions[i * 3 + 1]!
            const z = world.positions[i * 3 + 2]!
            insertRange(encodeFeatureRef(FG_REF_KIND_VERTEX, i), x, y, z, x, y, z)
        }

        for (let e = 0; e < cpu.edgeCount; e++) {
            if ((cpu.edgeFlags[e]! & FG_FLAG_ALIVE) === 0) continue
            const va = cpu.edgeEndpoints[e * 2]!
            const vb = cpu.edgeEndpoints[e * 2 + 1]!
            const ax = world.positions[va * 3]!,    ay = world.positions[va * 3 + 1]!, az = world.positions[va * 3 + 2]!
            const bx = world.positions[vb * 3]!,    by = world.positions[vb * 3 + 1]!, bz = world.positions[vb * 3 + 2]!
            insertRange(
                encodeFeatureRef(FG_REF_KIND_EDGE, e),
                Math.min(ax, bx), Math.min(ay, by), Math.min(az, bz),
                Math.max(ax, bx), Math.max(ay, by), Math.max(az, bz),
            )
        }

        // Snapshot to Int32Array per bucket for tighter iteration downstream.
        const sealed = new Map<bigint, Int32Array>()
        for (const [key, list] of accum) {
            sealed.set(key, Int32Array.from(list))
        }
        return new FeatureGraphSpatialIndex(cellSize, sealed)
    }

    /** Refs whose AABB touches cell `(cx, cy, cz)`, or `null` if none. */
    queryCell(cx: number, cy: number, cz: number): Int32Array | null {
        return this.cellMap.get(packCellKey(cx, cy, cz)) ?? null
    }

    get cellCount(): number {
        return this.cellMap.size
    }

    get isEmpty(): boolean {
        return this.cellMap.size === 0
    }
}

/** Same 21-bit-per-axis packing as `ContourSpatialIndex` so debugging/inspection feels familiar. */
function packCellKey(cx: number, cy: number, cz: number): bigint {
    return ((BigInt(cx + 0x100000) & 0x1fffffn) << 42n) |
           ((BigInt(cy + 0x100000) & 0x1fffffn) << 21n) |
           (BigInt(cz + 0x100000) & 0x1fffffn)
}
