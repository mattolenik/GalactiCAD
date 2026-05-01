import { COMPLETEUSED, NOTUSED, PARTIALUSED } from "./constants.mjs"
import type { AscRuntimeContext } from "./dikelign.mjs"
import type { AscLign } from "./dikelign.mjs"
import type { AscPadi } from "./padi.mjs"

/** Strip between two ligns (asc `Strip`). */
export class AscStrip {
    readonly ctx: AscRuntimeContext
    simple: Int16Array
    usedby: (AscPadi | null)[]

    constructor(ctx: AscRuntimeContext) {
        this.ctx = ctx
        this.simple = new Int16Array(ctx.tier.SIZE)
        this.usedby = new Array<AscPadi | null>(ctx.tier.SIZE).fill(null)
    }

    init(lign1: AscLign, lign2: AscLign): void {
        const { SIZE } = this.ctx.tier
        for (let i = 0; i < SIZE; i++) {
            this.usedby[i] = null
            this.simple[i] = Math.max(lign1.simple[i]!, lign2.simple[i]!)
        }
    }

    nextSimple(i: number): number {
        return this.simple[this.ctx.nextDike(i)]!
    }

    /** Asc `Strip::UsedBy` — ancestors then descendants (fixes empty-body `for` in original C++). */
    usedBy(dike: number, occup: AscPadi[], cnt: { n: number }): number {
        for (let i = dike; i > 0; i >>= 1) {
            if (this.usedby[i] !== null) {
                const u = this.usedby[i]!
                let j: number
                for (j = cnt.n - 1; j >= 0; j--) {
                    if (occup[j] === u) break
                }
                if (j < 0) occup[cnt.n++] = u
                return COMPLETEUSED
            }
        }

        const dikelevel = this.ctx.level(dike)
        const dikelength = this.ctx.length(dike)
        let occlength = 0
        let lb = dike
        let ub = dike
        let level = dikelevel
        while (level <= this.ctx.tier.nLevel) {
            for (let i = lb; i <= ub; i++) {
                if (this.usedby[i] !== null) {
                    const u = this.usedby[i]!
                    let j: number
                    for (j = cnt.n - 1; j >= 0; j--) {
                        if (occup[j] === u) break
                    }
                    if (j < 0) occup[cnt.n++] = u
                    occlength += this.ctx.length(i)
                    if (dikelength === occlength) return COMPLETEUSED
                }
            }
            level++
            lb = lb << 1
            ub = (ub << 1) + 1
        }
        if (occlength > 0) return PARTIALUSED
        return NOTUSED
    }
}
