/**
 * Uniform hash-grid spatial index over feature-curve polyline segments and
 * corner points. Conservative: queries return candidate ids whose indexed
 * geometry touches the inflated query box — callers do exact filtering.
 */

export class SfccSpatialIndex {
    #cellSize: number
    #curveCells = new Map<number, Set<number>>()
    #cornerCells = new Map<number, number[]>()

    constructor(cellSize: number) {
        this.#cellSize = Math.max(cellSize, 1e-9)
    }

    #key(ix: number, iy: number, iz: number): number {
        // Offset to keep components positive. B = 2^17 keeps the packed key
        // below 2^51 — exactly representable in f64. (2^20 overflowed 2^53 and
        // produced colliding keys → duplicate query results.)
        const B = 1 << 17
        const HB = 1 << 16
        return ((ix + HB) * B + (iy + HB)) * B + (iz + HB)
    }

    #cellsOfBox(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): number[] {
        const s = this.#cellSize
        const x0 = Math.floor(minX / s)
        const y0 = Math.floor(minY / s)
        const z0 = Math.floor(minZ / s)
        const x1 = Math.floor(maxX / s)
        const y1 = Math.floor(maxY / s)
        const z1 = Math.floor(maxZ / s)
        const keys: number[] = []
        for (let x = x0; x <= x1; x++)
            for (let y = y0; y <= y1; y++)
                for (let z = z0; z <= z1; z++) keys.push(this.#key(x, y, z))
        return keys
    }

    insertCurvePolyline(curveId: number, polyline: Float64Array): void {
        const n = polyline.length / 3 - 1
        for (let i = 0; i < n; i++) {
            const ax = polyline[i * 3]!
            const ay = polyline[i * 3 + 1]!
            const az = polyline[i * 3 + 2]!
            const bx = polyline[i * 3 + 3]!
            const by = polyline[i * 3 + 4]!
            const bz = polyline[i * 3 + 5]!
            for (const key of this.#cellsOfBox(
                Math.min(ax, bx),
                Math.min(ay, by),
                Math.min(az, bz),
                Math.max(ax, bx),
                Math.max(ay, by),
                Math.max(az, bz),
            )) {
                let set = this.#curveCells.get(key)
                if (!set) {
                    set = new Set()
                    this.#curveCells.set(key, set)
                }
                set.add(curveId)
            }
        }
    }

    insertCorner(cornerId: number, x: number, y: number, z: number): void {
        const key = this.#key(
            Math.floor(x / this.#cellSize),
            Math.floor(y / this.#cellSize),
            Math.floor(z / this.#cellSize),
        )
        let list = this.#cornerCells.get(key)
        if (!list) {
            list = []
            this.#cornerCells.set(key, list)
        }
        list.push(cornerId)
    }

    curvesInBox(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): number[] {
        const out = new Set<number>()
        for (const key of this.#cellsOfBox(minX, minY, minZ, maxX, maxY, maxZ)) {
            const set = this.#curveCells.get(key)
            if (set) for (const id of set) out.add(id)
        }
        return [...out]
    }

    cornersInBox(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): number[] {
        const out: number[] = []
        for (const key of this.#cellsOfBox(minX, minY, minZ, maxX, maxY, maxZ)) {
            const list = this.#cornerCells.get(key)
            if (list) out.push(...list)
        }
        return out
    }
}
