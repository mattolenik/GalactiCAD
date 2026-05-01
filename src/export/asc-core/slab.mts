import type { AscRuntimeContext } from "./dikelign.mjs"
import { AscLign } from "./dikelign.mjs"

/** Minimal farm for slab merge (avoids farm↔slab import cycle). */
export interface AscFarmPlaneRef {
    emptyQ(): boolean
    xlign: AscLign[]
    ylign: AscLign[]
}

/** Volume between two farms (asc `Slab`). */
export class AscSlab {
    readonly ctx: AscRuntimeContext
    xlign: AscLign[] = []
    ylign: AscLign[] = []
    private empty = false
    private bitmap: Uint8Array
    private py = 0
    private xdike = 0

    constructor(ctx: AscRuntimeContext) {
        this.ctx = ctx
        const { N, SIZE } = ctx.tier
        const totalbyte = ((N * N) >> 3) + 1
        this.bitmap = new Uint8Array(totalbyte)
        for (let i = 0; i < N; i++) {
            this.xlign.push(new AscLign(ctx, new Int8Array(SIZE), new Int16Array(SIZE)))
            this.ylign.push(new AscLign(ctx, new Int8Array(SIZE), new Int16Array(SIZE)))
        }
    }

    emptyQ(): boolean {
        return this.empty
    }

    init(farmk: AscFarmPlaneRef, farmkplus1: AscFarmPlaneRef): void {
        const { N, SIZE } = this.ctx.tier
        this.empty = farmk.emptyQ() && farmkplus1.emptyQ()
        for (let i = 0; i < N; i++) {
            for (let j = 0; j < SIZE; j++) {
                this.xlign[i]!.simple[j] = Math.max(farmk.xlign[i]!.simple[j]!, farmkplus1.xlign[i]!.simple[j]!)
                this.ylign[i]!.simple[j] = Math.max(farmk.ylign[i]!.simple[j]!, farmkplus1.ylign[i]!.simple[j]!)
            }
        }
    }

    firstPadi(xydike: Int32Array): boolean {
        const { N } = this.ctx.tier
        const totalbyte = this.bitmap.length
        for (let i = 0; i < totalbyte; i++) this.bitmap[i] = 0

        for (this.py = 0; this.py < N; this.py++) {
            for (this.xdike = this.xlign[this.py]!.simple[1]!; this.xdike > 0; this.xdike = this.xlign[this.py]!.nextSimple(this.xdike)) {
                let off = this.py * N + this.ctx.start(this.xdike)
                if (!(this.bitmap[off >> 3]! & (0x80 >> (off & 7)))) {
                    xydike[0] = this.xdike
                    xydike[1] = this.ylign[this.ctx.start(this.xdike)]!.simple[this.py + N]!
                    const endpy = this.py + this.ctx.length(xydike[1]!)
                    for (let j = this.py; j < endpy; j++, off += N) {
                        this.bitmap[off >> 3] |= 0x80 >> (off & 7)
                    }
                    return true
                }
            }
        }
        return false
    }

    nextPadi(xydike: Int32Array): boolean {
        const { N } = this.ctx.tier
        for (; this.py < N; this.py++) {
            if (this.xdike > 0) this.xdike = this.xlign[this.py]!.nextSimple(this.xdike)
            else this.xdike = this.xlign[this.py]!.simple[1]!
            for (; this.xdike > 0; this.xdike = this.xlign[this.py]!.nextSimple(this.xdike)) {
                let off = this.py * N + this.ctx.start(this.xdike)
                if (!(this.bitmap[off >> 3]! & (0x80 >> (off & 7)))) {
                    xydike[0] = this.xdike
                    xydike[1] = this.ylign[this.ctx.start(this.xdike)]!.simple[this.py + N]!
                    const endpy = this.py + this.ctx.length(xydike[1]!)
                    for (let j = this.py; j < endpy; j++, off += N) {
                        this.bitmap[off >> 3] |= 0x80 >> (off & 7)
                    }
                    return true
                }
            }
        }
        return false
    }
}
