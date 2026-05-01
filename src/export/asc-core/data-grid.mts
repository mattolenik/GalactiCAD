import { XDIM, YDIM, ZDIM } from "./constants.mjs"

const VARYX = 0
const VARYY = 1
const VARYZ = 2
const OUTBND = 3

/**
 * Read-only 3D scalar grid (asc `Data` / `G_data1`) with threshold → binary classification.
 * Layout: index z * (w*d) + y * w + x (same as asc `Data` for VARYX).
 *
 * **Must match asc `Data::operator[]`:** `(raw >= threshold) ? 1 : 0`. For SDF samples `d - iso`
 * with iso ≈ 0, **outside** (positive distance) → **1**, **inside** (negative) → **0**. `Initocc`
 * and the farm/slab logic depend on these bit patterns; inverting breaks extraction (often **0 tris**).
 */
export class AscVoxelGrid {
    readonly data: Float32Array
    readonly width: number
    readonly depth: number
    readonly height: number
    threshold: number

    constructor(
        data: Float32Array,
        width: number,
        depth: number,
        height: number,
        threshold = 0,
    ) {
        this.data = data
        this.width = width
        this.depth = depth
        this.height = height
        this.threshold = threshold
    }

    /** Raw sample (asc `Data::Value`). Out-of-bounds -> large positive = outside (SDF), not 0 (iso). */
    valueAt(x: number, y: number, z: number): number {
        if (x < 0 || y < 0 || z < 0 || x >= this.width || y >= this.depth || z >= this.height) {
            return 1e30
        }
        return this.data[z * this.width * this.depth + y * this.width + x]
    }

    /** Binary 0/1 per asc `Data::operator[]`: **1** iff **value >= threshold** (same as metaball port). */
    binaryLine(
        vary: number,
        fixedx: number,
        fixedy: number,
        fixedz: number,
        offx: number,
        offy: number,
        offz: number,
        i: number,
    ): number {
        let offset: number
        let mult: number
        if (vary === VARYX) {
            if (i + offx >= this.width) return 1
            offset = fixedz * this.width * this.depth + fixedy * this.width + offx
            return this.data[offset + i]! >= this.threshold ? 1 : 0
        }
        if (vary === VARYY) {
            if (i + offy >= this.depth) return 1
            offset = fixedz * this.width * this.depth + offy * this.width + fixedx
            return this.data[offset + i * this.width]! >= this.threshold ? 1 : 0
        }
        if (vary === VARYZ) {
            if (i + offz >= this.height) return 1
            mult = this.width * this.depth
            offset = offz * mult + fixedy * this.width + fixedx
            return this.data[offset + i * mult]! >= this.threshold ? 1 : 0
        }
        return 1
    }

    /** Line reader for `Initocc` / `Initver` style walks (one varying axis). */
    lineReader(
        x: number,
        y: number,
        z: number,
        offx: number,
        offy: number,
        offz: number,
    ): { vary: number; at: (i: number) => number } {
        const fixedx = x + offx
        const fixedy = y + offy
        const fixedz = z + offz
        if (fixedx >= this.width || fixedy >= this.depth || fixedz >= this.height) {
            return { vary: OUTBND, at: () => 1 }
        }
        if (x < 0) {
            return {
                vary: VARYX,
                at: (i: number) => this.binaryLine(VARYX, fixedx, fixedy, fixedz, offx, offy, offz, i),
            }
        }
        if (y < 0) {
            return {
                vary: VARYY,
                at: (i: number) => this.binaryLine(VARYY, fixedx, fixedy, fixedz, offx, offy, offz, i),
            }
        }
        if (z < 0) {
            return {
                vary: VARYZ,
                at: (i: number) => this.binaryLine(VARYZ, fixedx, fixedy, fixedz, offx, offy, offz, i),
            }
        }
        return { vary: OUTBND, at: () => 1 }
    }
}

/** Sample center cell for padi ambiguity (float threshold). */
export function ascGridCenterSample(
    grid: AscVoxelGrid,
    dim: readonly [number, number, number],
    xis: number,
    yis: number,
    xmid: number,
    ymid: number,
    xodd: number,
    yodd: number,
): number {
    const [d0, d1, d2] = dim
    const g = grid
    const v = (a: number, b: number, c: number) => g.valueAt(a, b, c)
    let bl: number
    let br: number
    let tl: number
    let tr: number
    if (xis === XDIM && yis === YDIM) {
        bl = v(xmid, ymid, d2)
        br = xodd ? v(xmid + 1, ymid, d2) : bl
        if (!yodd) {
            tl = bl
            tr = br
        } else {
            tl = v(xmid, ymid + 1, d2)
            tr = xodd ? v(xmid + 1, ymid + 1, d2) : tl
        }
    } else if (xis === XDIM && yis === ZDIM) {
        bl = v(xmid, d1, ymid)
        br = xodd ? v(xmid + 1, d1, ymid) : bl
        if (!yodd) {
            tl = bl
            tr = br
        } else {
            tl = v(xmid, d1, ymid + 1)
            tr = xodd ? v(xmid + 1, d1, ymid + 1) : tl
        }
    } else {
        bl = v(d0, xmid, ymid)
        br = xodd ? v(d0, xmid + 1, ymid) : bl
        if (!yodd) {
            tl = bl
            tr = br
        } else {
            tl = v(d0, xmid, ymid + 1)
            tr = xodd ? v(d0, xmid + 1, ymid + 1) : tl
        }
    }
    return (tl + tr + bl + br) / 4
}
