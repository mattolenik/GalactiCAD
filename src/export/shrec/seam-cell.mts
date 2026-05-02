/**
 * CSG seam cell classification shared by MergeSharp and pre-DC snapping.
 *
 * Reads per-voxel `seamTangent` at the 8 corners of a dual cell and tests
 * whether they agree on a single seam-line direction.
 */

/** The 8 cube-corner offsets in cell-local voxel coordinates. */
export const CELL_CORNERS: ReadonlyArray<readonly [number, number, number]> = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
    [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
]

/**
 * True when the cell at `(cx, cy, cz)` sits on a coherent CSG seam line.
 * See `merge-sharp.mts` history for the full rationale.
 */
export function classifyCellSeam(
    seamTangent: Float32Array,
    nx: number,
    ny: number,
    cx: number,
    cy: number,
    cz: number,
    cosThreshold: number,
    outT: [number, number, number],
): boolean {
    let sumX = 0, sumY = 0, sumZ = 0
    let firstX = 0, firstY = 0, firstZ = 0
    let count = 0

    for (let i = 0; i < 8; i++) {
        const off = CELL_CORNERS[i]!
        const vidx = ((cz + off[2]) * ny + (cy + off[1])) * nx + (cx + off[0])
        const k = vidx * 4
        if (seamTangent[k + 3]! < 0.5) continue
        let tx = seamTangent[k]!, ty = seamTangent[k + 1]!, tz = seamTangent[k + 2]!
        if (count === 0) {
            firstX = tx; firstY = ty; firstZ = tz
        } else if (tx * firstX + ty * firstY + tz * firstZ < 0) {
            tx = -tx; ty = -ty; tz = -tz
        }
        sumX += tx; sumY += ty; sumZ += tz
        count++
    }
    if (count < 2) return false

    const len = Math.hypot(sumX, sumY, sumZ)
    if (len < 1e-12) return false
    const Tx = sumX / len, Ty = sumY / len, Tz = sumZ / len

    for (let i = 0; i < 8; i++) {
        const off = CELL_CORNERS[i]!
        const vidx = ((cz + off[2]) * ny + (cy + off[1])) * nx + (cx + off[0])
        const k = vidx * 4
        if (seamTangent[k + 3]! < 0.5) continue
        const tx = seamTangent[k]!, ty = seamTangent[k + 1]!, tz = seamTangent[k + 2]!
        const agreement = Math.abs(tx * Tx + ty * Ty + tz * Tz)
        if (agreement < cosThreshold) return false
    }

    outT[0] = Tx; outT[1] = Ty; outT[2] = Tz
    return true
}
