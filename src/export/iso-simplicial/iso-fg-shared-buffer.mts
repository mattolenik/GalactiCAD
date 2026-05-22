/**
 * SharedArrayBuffer packing for per-cell FeatureGraph plane sources (Phase IS-5).
 *
 * The QEF worker pool needs each frontier cell's {@link FgPlaneSource} list
 * available off-thread. The main thread queries + collects the sources (the
 * distance gate and crease dedup run once, on the main thread), packs them
 * into a flat SharedArrayBuffer pair, and the worker decodes its slice.
 *
 * Layout
 * ------
 * - `offsets` — `Uint32Array(N + 1)`, a prefix sum of per-cell source counts;
 *   cell `i` owns source records `[offsets[i], offsets[i+1])`.
 * - `data` — `Float32Array(totalSources * strideFloats)`. One record per source:
 *   `[px, py, pz, normalCount, n0x,n0y,n0z, n1x,n1y,n1z, …]`.
 *
 * `strideFloats = 4 + maxNormals * 3` is **per-batch dynamic**: it's sized from
 * the largest `normalCount` observed across the whole batch, so a batch whose
 * features all have ≤2 normals never pays for a third normal slot, while a
 * batch with a high-valence vertex still packs losslessly.
 */

import type { FgPlaneSource } from "./iso-fg-feature-planes.mjs"

/** Packed FG sidecar — `data`/`offsets` are `null` when the batch has no FG sources. */
export interface PackedFgSidecar {
    /** `Float32Array` SAB: `totalSources * strideFloats`. */
    data: SharedArrayBuffer | null
    /** `Uint32Array` SAB: `(N + 1)` prefix-sum offsets (in source-record units). */
    offsets: SharedArrayBuffer | null
    /** Floats per source record: `4 + maxNormals * 3`. 0 when there are no sources. */
    strideFloats: number
}

/**
 * Pack each cell's collected {@link FgPlaneSource}s into the shared sidecar.
 * `perCell[i]` is cell `i`'s source list (may be empty). Returns a sidecar with
 * `data`/`offsets` null when no cell has any source.
 */
export function packFgPlaneSources(perCell: ReadonlyArray<readonly FgPlaneSource[]>): PackedFgSidecar {
    const N = perCell.length
    let maxNormals = 0
    let totalSources = 0
    for (const cell of perCell) {
        for (const s of cell) {
            if (s.normalCount > maxNormals) maxNormals = s.normalCount
            totalSources++
        }
    }
    if (totalSources === 0) return { data: null, offsets: null, strideFloats: 0 }

    const strideFloats = 4 + maxNormals * 3
    const offsetsSab = new SharedArrayBuffer((N + 1) * 4)
    const offsets = new Uint32Array(offsetsSab)
    const dataSab = new SharedArrayBuffer(totalSources * strideFloats * 4)
    const data = new Float32Array(dataSab)

    let cursor = 0
    for (let i = 0; i < N; i++) {
        offsets[i] = cursor
        for (const s of perCell[i]!) {
            const base = cursor * strideFloats
            data[base] = s.px
            data[base + 1] = s.py
            data[base + 2] = s.pz
            data[base + 3] = s.normalCount
            const nFloats = s.normalCount * 3
            for (let k = 0; k < nFloats; k++) data[base + 4 + k] = s.normals[k]!
            cursor++
        }
    }
    offsets[N] = cursor

    return { data: dataSab, offsets: offsetsSab, strideFloats }
}

/**
 * Decode cell `cellIdx`'s {@link FgPlaneSource}s from the packed sidecar views.
 * `data` / `offsets` are `Float32Array` / `Uint32Array` over the shared buffers.
 */
export function unpackFgPlaneSourcesForCell(
    data: Float32Array,
    offsets: Uint32Array,
    cellIdx: number,
    strideFloats: number,
): FgPlaneSource[] {
    const start = offsets[cellIdx]!
    const end = offsets[cellIdx + 1]!
    const out: FgPlaneSource[] = []
    for (let s = start; s < end; s++) {
        const base = s * strideFloats
        const normalCount = data[base + 3]! | 0
        const normals: number[] = []
        const nFloats = normalCount * 3
        for (let k = 0; k < nFloats; k++) normals.push(data[base + 4 + k]!)
        out.push({ px: data[base]!, py: data[base + 1]!, pz: data[base + 2]!, normalCount, normals })
    }
    return out
}
