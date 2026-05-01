import { BOTTOM, LEFT, RIGHT, TOP } from "./constants.mjs"
import { XDIM, YDIM, ZDIM } from "./constants.mjs"
import type { AscVoxelGrid } from "./data-grid.mjs"
import type { AscRuntimeContext } from "./dikelign.mjs"
import { minDikeSet } from "./dikelign.mjs"
import type { AscListLink } from "./doublist.mjs"
import type { AscLign } from "./dikelign.mjs"

/** Minimal block ref for ambiguity sampling (asc `Block` fields used by `Padi`). */
export interface AscBlockSampleRef {
    readonly grid: AscVoxelGrid
    readonly offX: number
    readonly offY: number
    readonly offZ: number
    readonly dataDimX: number
    readonly dataDimY: number
    readonly dataDimZ: number
}

/** XY / XZ / YZ farm slice (asc `Farm`). */
export interface AscFarmSlice {
    readonly ctx: AscRuntimeContext
    XisV(): number
    YisV(): number
    FixDimV(): number
    FixDimValV(): number
    xlign: AscLign[]
    ylign: AscLign[]
}

let edgeTableInited = false
const edgeTable: Int8Array = new Int8Array(256 * 4).fill(-1)

export function ensureAscPadiEdgeTable(): void {
    if (edgeTableInited) return
    edgeTableInited = true
    const set = (idx: number, a: number, b: number, c = -1, d = -1) => {
        const o = idx * 4
        edgeTable[o] = a
        edgeTable[o + 1] = b
        edgeTable[o + 2] = c
        edgeTable[o + 3] = d
    }
    set(0x81, BOTTOM, RIGHT)
    set(0x60, RIGHT, TOP)
    set(0x21, BOTTOM, TOP)
    set(0x18, TOP, LEFT)
    set(0x99, TOP, LEFT, BOTTOM, RIGHT)
    set(0x48, RIGHT, LEFT)
    set(0x09, BOTTOM, LEFT)
    set(0x06, LEFT, BOTTOM)
    set(0x84, LEFT, RIGHT)
    set(0x66, RIGHT, TOP, LEFT, BOTTOM)
    set(0x24, LEFT, TOP)
    set(0x12, TOP, BOTTOM)
    set(0x90, TOP, RIGHT)
    set(0x42, RIGHT, BOTTOM)
}

export class AscPadi implements AscListLink {
    next: AscPadi | null = null
    previous: AscPadi | null = null

    readonly ctx: AscRuntimeContext
    lignavail = false
    occ: Int8Array = new Int8Array(4)
    lign: (AscLign | null)[] = [null, null, null, null]
    dike = new Int16Array(4)
    lookupidx = 0

    constructor(ctx: AscRuntimeContext) {
        this.ctx = ctx
    }

    init(xdike: number, ydike: number, farm: AscFarmSlice | null, block: AscBlockSampleRef | null, handleAmbiguity: boolean): void {
        this.dike[RIGHT] = this.dike[LEFT] = ydike
        this.dike[TOP] = this.dike[BOTTOM] = xdike
        if (farm === null) return
        this.lignavail = true
        ensureAscPadiEdgeTable()
        this.lign[RIGHT] = farm.ylign[this.ctx.end(xdike)]!
        this.lign[TOP] = farm.xlign[this.ctx.end(ydike)]!
        this.lign[LEFT] = farm.ylign[this.ctx.start(xdike)]!
        this.lign[BOTTOM] = farm.xlign[this.ctx.start(ydike)]!
        for (let i = 0; i < 4; i++) this.occ[i] = this.lign[i]!.occ[this.dike[i]!]!
        for (const i of [1, 2]) this.occ[i] = ((this.occ[i]! & 1) << 1) | ((this.occ[i]! & 2) >> 1)

        this.lookupidx = 0
        for (let i = 0; i < 4; i++) this.lookupidx = (this.lookupidx << 2) | (3 & this.occ[i]!)
        if (handleAmbiguity && (this.lookupidx === 0x99 || this.lookupidx === 0x66) && block !== null) {
            this.resolveAmbiguity(xdike, ydike, farm, block)
        }
    }

    private resolveAmbiguity(xdike: number, ydike: number, farm: AscFarmSlice, block: AscBlockSampleRef): void {
        const xmid = (this.ctx.start(xdike) + this.ctx.end(xdike)) >> 1
        const ymid = (this.ctx.start(ydike) + this.ctx.end(ydike)) >> 1
        const xodd = this.ctx.length(xdike) & 1
        const yodd = this.ctx.length(ydike) & 1
        const { offX, offY, offZ, grid } = block
        const kz = farm.FixDimValV()
        const g = grid
        const v = (lx: number, ly: number, lz: number) => g.valueAt(offX + lx, offY + ly, offZ + lz)
        let bl: number
        let br: number
        let tl: number
        let tr: number
        if (farm.XisV() === XDIM && farm.YisV() === YDIM) {
            bl = v(xmid, ymid, kz)
            br = xodd ? v(xmid + 1, ymid, kz) : bl
            if (!yodd) {
                tl = bl
                tr = br
            } else {
                tl = v(xmid, ymid + 1, kz)
                tr = xodd ? v(xmid + 1, ymid + 1, kz) : tl
            }
        } else if (farm.XisV() === XDIM && farm.YisV() === ZDIM) {
            bl = v(xmid, kz, ymid)
            br = xodd ? v(xmid + 1, kz, ymid) : bl
            if (!yodd) {
                tl = bl
                tr = br
            } else {
                tl = v(xmid, kz, ymid + 1)
                tr = xodd ? v(xmid + 1, kz, ymid + 1) : tl
            }
        } else {
            bl = v(kz, xmid, ymid)
            br = xodd ? v(kz, xmid + 1, ymid) : bl
            if (!yodd) {
                tl = bl
                tr = br
            } else {
                tl = v(kz, xmid, ymid + 1)
                tr = xodd ? v(kz, xmid + 1, ymid + 1) : tl
            }
        }
        const sample = (tl + tr + bl + br) / 4
        if (sample >= block.grid.threshold) {
            if (this.lookupidx === 0x99) this.lookupidx = 0x66
            else this.lookupidx = 0x99
        }
    }

    genEdge(edgearr: Int8Array, cnt: { n: number }): void {
        if (!this.lignavail) return
        for (let i = 0; i < 3; i += 2) {
            const o = this.lookupidx * 4
            const k = edgeTable[o + i]!
            const l = edgeTable[o + i + 1]!
            if (k !== -1 && l !== -1) {
                edgearr[cnt.n++] = k
                edgearr[cnt.n++] = l
            }
        }
    }

    enclosedByQ(encloser: AscPadi): boolean {
        if (encloser.dike[TOP]! > this.dike[TOP]! || encloser.dike[LEFT]! > this.dike[LEFT]!) return false
        const lt = this.ctx.level(this.dike[TOP]!) - this.ctx.level(encloser.dike[TOP]!)
        if ((this.dike[TOP]! >> lt) !== encloser.dike[TOP]) return false
        const ll = this.ctx.level(this.dike[LEFT]!) - this.ctx.level(encloser.dike[LEFT]!)
        if ((this.dike[LEFT]! >> ll) !== encloser.dike[LEFT]) return false
        return true
    }

    overlapQ(p: AscPadi): boolean {
        for (let i = RIGHT; i <= TOP; i++) {
            let large: number
            let small: number
            if (p.dike[i]! > this.dike[i]!) {
                large = this.dike[i]!
                small = p.dike[i]!
            } else {
                large = p.dike[i]!
                small = this.dike[i]!
            }
            const ll = this.ctx.level(small) - this.ctx.level(large)
            if ((small >> ll) !== large) return false
        }
        return true
    }

    clipBy(clipper: AscPadi, holder: AscPadi[], cntRef: { n: number }, farm: AscFarmSlice | null, block: AscBlockSampleRef | null): void {
        const { N } = this.ctx.tier
        const dikeset = new Int32Array(N)
        const ligngiven = this.lignavail && farm !== null
        const clipxstart = this.ctx.start(clipper.dike[BOTTOM]!)
        const clipxend = this.ctx.end(clipper.dike[BOTTOM]!)
        const clipystart = this.ctx.start(clipper.dike[LEFT]!)
        const clipyend = this.ctx.end(clipper.dike[LEFT]!)
        const thisxstart = this.ctx.start(this.dike[BOTTOM]!)
        const thisxend = this.ctx.end(this.dike[BOTTOM]!)
        const thisystart = this.ctx.start(this.dike[LEFT]!)
        const thisyend = this.ctx.end(this.dike[LEFT]!)

        if (thisxstart < clipxstart || thisxend > clipxend) {
            if (thisxstart < clipxstart) {
                const dc = minDikeSet(this.ctx, thisxstart, clipxstart - 1, dikeset)
                for (let i = 0; i < dc; i++) {
                    const p = new AscPadi(this.ctx)
                    if (!ligngiven) p.init(dikeset[i]!, this.dike[LEFT]!, null, null, false)
                    else p.init(dikeset[i]!, this.dike[LEFT]!, farm, block, false)
                    holder[cntRef.n++] = p
                }
            }
            if (thisxend > clipxend) {
                const dc = minDikeSet(this.ctx, clipxend, thisxend - 1, dikeset)
                for (let i = 0; i < dc; i++) {
                    const p = new AscPadi(this.ctx)
                    if (!ligngiven) p.init(dikeset[i]!, this.dike[LEFT]!, null, null, false)
                    else p.init(dikeset[i]!, this.dike[LEFT]!, farm, block, false)
                    holder[cntRef.n++] = p
                }
            }
        }
        if (thisystart < clipystart || thisyend > clipyend) {
            if (thisystart < clipystart) {
                const dc = minDikeSet(this.ctx, thisystart, clipystart - 1, dikeset)
                for (let i = 0; i < dc; i++) {
                    const p = new AscPadi(this.ctx)
                    if (!ligngiven) p.init(this.dike[BOTTOM]!, dikeset[i]!, null, null, false)
                    else p.init(this.dike[BOTTOM]!, dikeset[i]!, farm, block, false)
                    holder[cntRef.n++] = p
                }
            }
            if (thisyend > clipyend) {
                const dc = minDikeSet(this.ctx, clipyend, thisyend - 1, dikeset)
                for (let i = 0; i < dc; i++) {
                    const p = new AscPadi(this.ctx)
                    if (!ligngiven) p.init(this.dike[BOTTOM]!, dikeset[i]!, null, null, false)
                    else p.init(this.dike[BOTTOM]!, dikeset[i]!, farm, block, false)
                    holder[cntRef.n++] = p
                }
            }
        }
    }
}
