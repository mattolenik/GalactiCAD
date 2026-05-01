import { XDIM, YDIM, ZDIM, PP_HRICECONSTR, PP_PADICONSTR, BOTTOM, LEFT } from "./constants.mjs"
import type { AscRuntimeContext } from "./dikelign.mjs"
import { AscLign, breakDikeSet, minDikeSet } from "./dikelign.mjs"
import { AscDoublyList } from "./doublist.mjs"
import type { AscBlockSampleRef, AscFarmSlice } from "./padi.mjs"
import { AscPadi } from "./padi.mjs"
import { AscStrip } from "./strip.mjs"
import type { AscSlab } from "./slab.mjs"

/** Asc `Farm` — one XY/XZ/YZ plane stack. */
export class AscFarm implements AscFarmSlice {
    readonly ctx: AscRuntimeContext
    xlign: AscLign[] = []
    ylign: AscLign[] = []
    xstrip: AscStrip[] = []
    padilist: AscDoublyList<AscPadi> | null = null
    private fixDimVal = 0
    private edimIs = 0

    constructor(ctx: AscRuntimeContext) {
        this.ctx = ctx
        const { N, SIZE } = ctx.tier
        for (let i = 0; i <= N; i++) {
            this.xlign.push(new AscLign(ctx, new Int8Array(SIZE), new Int16Array(SIZE)))
            this.ylign.push(new AscLign(ctx, new Int8Array(SIZE), new Int16Array(SIZE)))
        }
        for (let i = 0; i < N; i++) this.xstrip.push(new AscStrip(ctx))
    }

    cleanUp(): void {
        if (this.padilist) {
            this.padilist.clearAndDispose()
            this.padilist = null
        }
    }

    init(xis: number, yis: number, fixdimval: number, xocc: Int8Array, yocc: Int8Array, xver: Int16Array, yver: Int16Array): void {
        const { N, SIZE } = this.ctx.tier
        this.padilist = null
        this.fixDimVal = fixdimval
        this.edimIs = 0
        this.edimIs = 0x03 & ~(xis | yis)
        this.edimIs = (this.edimIs << 2) | (yis & 0x03)
        this.edimIs = (this.edimIs << 2) | (xis & 0x03)

        let multx: number
        let offx: number
        let multy: number
        let offy: number
        if (xis === XDIM && yis === YDIM) {
            multx = 1
            offx = fixdimval * (N + 1)
            multy = 1
            offy = fixdimval * (N + 1)
        } else if (xis === XDIM && yis === ZDIM) {
            multx = N + 1
            offx = fixdimval
            multy = 1
            offy = fixdimval * (N + 1)
        } else if (xis === YDIM && yis === ZDIM) {
            multx = N + 1
            offx = fixdimval
            multy = N + 1
            offy = fixdimval
        } else {
            throw new Error(`[AscFarm.init]: unsupported axis pair xis=${xis} yis=${yis}`)
        }

        let nonempty = 0
        for (let i = 0; i <= N; i++) {
            const posx = (i * multx + offx) * SIZE
            const posy = (i * multy + offy) * SIZE
            this.xlign[i]!.occ = xocc.subarray(posx, posx + SIZE)
            this.xlign[i]!.ver = xver.subarray(posx, posx + SIZE)
            this.xlign[i]!.init()
            this.ylign[i]!.occ = yocc.subarray(posy, posy + SIZE)
            this.ylign[i]!.ver = yver.subarray(posy, posy + SIZE)
            this.ylign[i]!.init()
            nonempty |= xocc[posx + 1]! | yocc[posy + 1]!
        }
        if (!nonempty) this.setEmpty()
    }

    emptyQ(): boolean {
        return (this.edimIs & 0x80) !== 0
    }

    unsetEmpty(): void {
        this.edimIs &= 0x7f
    }

    setEmpty(): void {
        this.edimIs |= 0x80
    }

    XisV(): number {
        return this.edimIs & 0x03
    }

    YisV(): number {
        return (this.edimIs >> 2) & 0x03
    }

    FixDimV(): number {
        return (this.edimIs >> 4) & 0x03
    }

    FixDimValV(): number {
        return this.fixDimVal
    }

    tagXStrip(padi: AscPadi): void {
        for (let j = this.ctx.start(padi.dike[LEFT]!); j < this.ctx.end(padi.dike[LEFT]!); j++) {
            this.xstrip[j]!.usedby[padi.dike[BOTTOM]!] = padi
        }
    }

    untagXStrip(padi: AscPadi): void {
        for (let j = this.ctx.start(padi.dike[LEFT]!); j < this.ctx.end(padi.dike[LEFT]!); j++) {
            if (this.xstrip[j]!.usedby[padi.dike[BOTTOM]!] === padi) this.xstrip[j]!.usedby[padi.dike[BOTTOM]!] = null
        }
    }

    producePadi(block: AscBlockSampleRef | null, constrain: number, handleAmbiguity: boolean): AscDoublyList<AscPadi> {
        const { N, nLevel, SIZE } = this.ctx.tier
        const ydike = new Int32Array(N)
        const holder: AscPadi[] = []
        const competitor: AscPadi[] = new Array(Math.max(1, N * Math.max(1, nLevel)))

        for (let i = 0; i < N; i++) {
            this.xstrip[i]!.init(this.xlign[i]!, this.xlign[i + 1]!)
        }

        this.cleanUp()
        this.padilist = new AscDoublyList<AscPadi>()

        for (let j = 0; j < N; j++) {
            for (let i = this.xstrip[j]!.simple[1]!; i > 0; i = this.xstrip[j]!.nextSimple(i)) {
                let jj = j + 1
                if (constrain & PP_PADICONSTR) {
                    while (
                        jj < N &&
                        this.xstrip[jj]!.simple[i] === i &&
                        this.ctx.length(this.ylign[this.ctx.start(i)]!.simple[j + N]!) > jj - j
                    )
                        jj++
                } else if (constrain & PP_HRICECONSTR) {
                    while (
                        jj < N &&
                        this.xstrip[jj]!.simple[i] === i &&
                        N - this.ylign[this.ctx.start(i)]!.simple[j]! > jj - j
                    )
                        jj++
                } else {
                    while (jj < N && this.xstrip[jj]!.simple[i] === i) jj++
                }
                const maxJ = jj - 1
                let ydikecnt = minDikeSet(this.ctx, j, maxJ, ydike)
                ydikecnt = breakDikeSet(this.ctx, ydike, ydikecnt, this.ylign, i)

                for (jj = 0; jj < ydikecnt; jj++) {
                    let holdercnt = 0
                    let currpadi = new AscPadi(this.ctx)
                    currpadi.init(i, ydike[jj]!, this, block, handleAmbiguity)

                    do {
                        if (holdercnt > 0) {
                            holdercnt--
                            currpadi = holder[holdercnt]!
                        }

                        const cc = { n: 0 }
                        for (let k = this.ctx.start(currpadi.dike[LEFT]!); k < this.ctx.end(currpadi.dike[LEFT]!); k++) {
                            this.xstrip[k]!.usedBy(currpadi.dike[BOTTOM]!, competitor, cc)
                        }
                        const competecnt = cc.n
                        let padisuccess = true
                        for (let k = 0; k < competecnt; k++) {
                            const comp = competitor[k]
                            if (!comp) continue
                            if (currpadi.enclosedByQ(comp)) {
                                padisuccess = false
                                break
                            }
                            if (comp.enclosedByQ(currpadi)) {
                                this.untagXStrip(comp)
                                this.padilist!.remove(comp)
                                competitor[k] = undefined as never
                            } else {
                                const hcnt = { n: holdercnt }
                                currpadi.clipBy(comp, holder, hcnt, this, block)
                                holdercnt = hcnt.n
                                padisuccess = false
                                break
                            }
                        }

                        if (padisuccess) {
                            this.tagXStrip(currpadi)
                            this.padilist!.append(currpadi)
                        }
                    } while (holdercnt > 0)
                }
            }
        }
        return this.padilist
    }

    initSimpleByPadi(): void {
        const { N, SIZE } = this.ctx.tier
        for (let i = 0; i <= N; i++) {
            this.ylign[i]!.simple.set(this.ctx.nullSimple)
            this.xlign[i]!.simple.set(this.ctx.nullSimple)
        }
        for (let currpadi = this.padilist!.first(); currpadi !== null; currpadi = this.padilist!.next()) {
            const ldikestart = this.ctx.start(currpadi.dike[LEFT]!)
            const ldikeend = this.ctx.end(currpadi.dike[LEFT]!)
            const bdikestart = this.ctx.start(currpadi.dike[BOTTOM]!)
            const bdikeend = this.ctx.end(currpadi.dike[BOTTOM]!)
            for (let i = ldikestart; i < ldikeend; i++) {
                this.xlign[i]!.simple[bdikestart + N] = currpadi.dike[BOTTOM]!
            }
            for (let i = bdikestart; i < bdikeend; i++) {
                this.ylign[i]!.simple[ldikestart + N] = currpadi.dike[LEFT]!
            }
        }
        for (let i = 0; i < N; i++) {
            for (let j = N - 1; j > 0; j--) {
                this.xlign[i]!.simple[j] = this.xlign[i]!.simple[j << 1]!
                this.ylign[i]!.simple[j] = this.ylign[i]!.simple[j << 1]!
            }
            this.xlign[i]!.simple[0] = -1
            this.ylign[i]!.simple[0] = -1
        }
        for (let i = 0; i < N; i++) {
            for (let j = 1; j < SIZE; j++) {
                if (this.xlign[i]!.simple[j] === -1) {
                    if (j & 1) this.xlign[i]!.simple[j] = j
                    else this.xlign[i]!.simple[j] = this.xlign[i]!.simple[j >> 1]!
                }
                if (this.ylign[i]!.simple[j] === -1) {
                    if (j & 1) this.ylign[i]!.simple[j] = j
                    else this.ylign[i]!.simple[j] = this.ylign[i]!.simple[j >> 1]!
                }
            }
        }
        for (let i = 0; i < SIZE; i++) {
            this.xlign[N]!.simple[i] = this.xlign[N - 1]!.simple[i]!
            this.ylign[N]!.simple[i] = this.ylign[N - 1]!.simple[i]!
        }
    }

    initSimpleBySlab(below: AscSlab, above: AscSlab): void {
        const { N, SIZE } = this.ctx.tier
        for (let j = 0; j <= N; j++) {
            for (let i = 0; i < SIZE; i++) {
                this.xlign[j]!.simple[i] = Math.max(below.xlign[j]!.simple[i]!, above.xlign[j]!.simple[i]!)
                this.ylign[j]!.simple[i] = Math.max(below.ylign[j]!.simple[i]!, above.ylign[j]!.simple[i]!)
            }
        }
    }
}

export type { AscFarmSlice } from "./padi.mjs"
