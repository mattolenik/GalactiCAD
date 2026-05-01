import {
    BOTTOM,
    HR_BOTTOM,
    HR_FARXZ,
    HR_FARYZ,
    HR_NEARXZ,
    HR_NEARYZ,
    HR_TOP,
    LEFT,
    RIGHT,
    TOP,
    XDIM,
    YDIM,
    ZDIM,
} from "./constants.mjs"
import type { AscRuntimeContext } from "./dikelign.mjs"
import type { AscFarm } from "./farm.mjs"
import { AscPadi } from "./padi.mjs"

/** 3D padi stack (asc `HighRice`, extends `Padi`). */
export class AscHighRice extends AscPadi {
    bottom = 0
    top = 0
    edgeno = 0
    readonly offset = new Int32Array(6)
    width = 0
    height = 0
    depth = 0
    private empty = false

    constructor(ctx: AscRuntimeContext) {
        super(ctx)
    }

    initHr(x: number, y: number, b: number, t: number): void {
        this.dike[TOP] = this.dike[BOTTOM] = x
        this.dike[RIGHT] = this.dike[LEFT] = y
        this.bottom = Math.min(b, t)
        this.top = Math.max(b, t)
        this.empty = false
    }

    enclosedByHr(encloser: AscHighRice): boolean {
        if (encloser.bottom > this.bottom || encloser.top < this.top) return false
        return this.enclosedByQ(encloser)
    }

    overlapHr(other: AscHighRice): boolean {
        if (other.top < this.bottom || other.bottom > this.top) return false
        return this.overlapQ(other)
    }

    clipByHr(clipper: AscHighRice, holder: AscHighRice[], cnt: { n: number }): void {
        const padis: AscPadi[] = []
        let upperbnd = this.top
        let lowerbnd = this.bottom
        if (this.top > clipper.top) {
            const h = new AscHighRice(this.ctx)
            h.initHr(this.dike[TOP]!, this.dike[RIGHT]!, clipper.top + 1, this.top)
            holder[cnt.n++] = h
            upperbnd = clipper.top
        }
        if (this.bottom < clipper.bottom) {
            const h = new AscHighRice(this.ctx)
            h.initHr(this.dike[TOP]!, this.dike[RIGHT]!, this.bottom, clipper.bottom - 1)
            holder[cnt.n++] = h
            lowerbnd = clipper.bottom
        }
        const pc = { n: 0 }
        this.clipBy(clipper, padis, pc, null, null)
        for (let i = 0; i < pc.n; i++) {
            const ph = padis[i]!
            const h = new AscHighRice(this.ctx)
            h.initHr(ph.dike[TOP]!, ph.dike[LEFT]!, lowerbnd, upperbnd)
            holder[cnt.n++] = h
        }
    }

    mapToEdgeTable(face: number, farm: AscFarm, padi: AscPadi, side: number): number {
        const ctx = this.ctx
        let fx: number
        let fy: number
        switch (side) {
            case BOTTOM:
                fx = ctx.start(padi.dike[TOP]!)
                fy = ctx.start(padi.dike[LEFT]!)
                break
            case TOP:
                fx = ctx.start(padi.dike[TOP]!)
                fy = ctx.end(padi.dike[LEFT]!)
                break
            case LEFT:
                fx = ctx.start(padi.dike[TOP]!)
                fy = ctx.start(padi.dike[LEFT]!)
                break
            case RIGHT:
                fx = ctx.end(padi.dike[TOP]!)
                fy = ctx.start(padi.dike[LEFT]!)
                break
            default:
                return -1
        }
        const horiz = side === TOP || side === BOTTOM
        const ver = horiz ? farm.xlign[fy]!.ver : farm.ylign[fx]!.ver
        const intersect = ver[padi.dike[side]!]!
        if (intersect === 0) return -1
        if (horiz) fx = intersect - ctx.tier.N
        else fy = intersect - ctx.tier.N

        let index: number
        switch (face) {
            case HR_BOTTOM:
                fx -= ctx.start(this.dike[TOP]!)
                fy -= ctx.start(this.dike[LEFT]!)
                if (horiz) {
                    if (fy === 0) index = this.offset[HR_NEARXZ]! + 2 * fx
                    else index = this.offset[HR_BOTTOM]! + 2 * ((fy - 1) * this.width + fx)
                } else if (fx === 0) index = this.offset[HR_NEARYZ]! + 2 * fy
                else index = this.offset[HR_BOTTOM]! + 2 * (fy * this.width + (fx - 1)) + 1
                break
            case HR_TOP:
                fx -= ctx.start(this.dike[TOP]!)
                fy -= ctx.start(this.dike[LEFT]!)
                if (horiz) {
                    if (fy === this.depth) index = this.offset[HR_FARXZ]! + 2 * ((this.height - 1) * this.width + fx)
                    else index = this.offset[HR_TOP]! + 2 * (fy * this.width + fx)
                } else if (fx === this.width) index = this.offset[HR_FARYZ]! + 2 * ((this.height - 1) * this.depth + fy)
                else index = this.offset[HR_TOP]! + 2 * (fy * this.width + fx) + 1
                break
            case HR_NEARXZ:
                fx -= ctx.start(this.dike[TOP]!)
                fy -= this.bottom
                if (horiz) {
                    if (fy === this.height) index = this.offset[HR_TOP]! + 2 * fx
                    else index = this.offset[HR_NEARXZ]! + 2 * (fy * this.width + fx)
                } else if (fx === this.width) index = this.offset[HR_FARYZ]! + 2 * (fy * this.depth) + 1
                else index = this.offset[HR_NEARXZ]! + 2 * (fy * this.width + fx) + 1
                break
            case HR_FARXZ:
                fx -= ctx.start(this.dike[TOP]!)
                fy -= this.bottom
                if (horiz) {
                    if (fy === 0) index = this.offset[HR_BOTTOM]! + 2 * ((this.depth - 1) * this.width + fx)
                    else index = this.offset[HR_FARXZ]! + 2 * ((fy - 1) * this.width + fx)
                } else if (fx === 0) index = this.offset[HR_NEARYZ]! + 2 * (fy * this.depth + this.depth - 1) + 1
                else index = this.offset[HR_FARXZ]! + 2 * (fy * this.width + fx - 1) + 1
                break
            case HR_NEARYZ:
                fx -= ctx.start(this.dike[LEFT]!)
                fy -= this.bottom
                if (horiz) {
                    if (fy === this.height) index = this.offset[HR_TOP]! + 2 * (fx * this.width) + 1
                    else index = this.offset[HR_NEARYZ]! + 2 * (fy * this.depth + fx)
                } else if (fx === 0) index = this.offset[HR_NEARXZ]! + 2 * (fy * this.width) + 1
                else index = this.offset[HR_NEARYZ]! + 2 * (fy * this.depth + fx - 1) + 1
                break
            case HR_FARYZ:
                fx -= ctx.start(this.dike[LEFT]!)
                fy -= this.bottom
                if (horiz) {
                    if (fy === 0) index = this.offset[HR_BOTTOM]! + 2 * (fx * this.width + this.width - 1) + 1
                    else index = this.offset[HR_FARYZ]! + 2 * ((fy - 1) * this.depth + fx)
                } else if (fx === this.depth) index = this.offset[HR_FARXZ]! + 2 * (fy * this.width + this.width - 1) + 1
                else index = this.offset[HR_FARYZ]! + 2 * (fy * this.depth + fx) + 1
                break
            default:
                return -1
        }
        return index
    }

    setupEdgeTable(xyfarm: AscFarm[], xzfarm: AscFarm[], yzfarm: AscFarm[], edge: Int32Array): void {
        const ctx = this.ctx
        this.width = ctx.length(this.dike[TOP]!)
        this.depth = ctx.length(this.dike[LEFT]!)
        this.height = this.top - this.bottom + 1
        this.edgeno = 4 * (this.width * this.depth + this.height * this.width + this.height * this.depth)
        this.offset[HR_BOTTOM] = 0
        this.offset[HR_TOP] = this.width * this.depth * 2
        this.offset[HR_NEARXZ] = this.offset[HR_TOP]! + this.width * this.depth * 2
        this.offset[HR_FARXZ] = this.offset[HR_NEARXZ]! + this.width * this.height * 2
        this.offset[HR_NEARYZ] = this.offset[HR_FARXZ]! + this.width * this.height * 2
        this.offset[HR_FARYZ] = this.offset[HR_NEARYZ]! + this.depth * this.height * 2

        edge.fill(-1)

        const edgearr = new Int8Array(4)
        const occupiant: AscPadi[] = new Array(ctx.tier.N * ctx.tier.N)

        for (let face = 0; face < 6; face++) {
            let currfarm: AscFarm
            let ybottom: number
            let ytop: number
            let xdike: number
            switch (face) {
                case HR_BOTTOM:
                    currfarm = xyfarm[this.bottom]!
                    ybottom = ctx.start(this.dike[LEFT]!)
                    ytop = ctx.end(this.dike[LEFT]!) - 1
                    xdike = this.dike[TOP]!
                    break
                case HR_TOP:
                    currfarm = xyfarm[this.top + 1]!
                    ybottom = ctx.start(this.dike[LEFT]!)
                    ytop = ctx.end(this.dike[LEFT]!) - 1
                    xdike = this.dike[TOP]!
                    break
                case HR_NEARXZ:
                    currfarm = xzfarm[ctx.start(this.dike[LEFT]!)]!
                    ybottom = this.bottom
                    ytop = this.top
                    xdike = this.dike[TOP]!
                    break
                case HR_FARXZ:
                    currfarm = xzfarm[ctx.end(this.dike[LEFT]!)]!
                    ybottom = this.bottom
                    ytop = this.top
                    xdike = this.dike[TOP]!
                    break
                case HR_NEARYZ:
                    currfarm = yzfarm[ctx.start(this.dike[TOP]!)]!
                    ybottom = this.bottom
                    ytop = this.top
                    xdike = this.dike[LEFT]!
                    break
                case HR_FARYZ:
                    currfarm = yzfarm[ctx.end(this.dike[TOP]!)]!
                    ybottom = this.bottom
                    ytop = this.top
                    xdike = this.dike[LEFT]!
                    break
                default:
                    continue
            }

            const occcnt = { n: 0 }
            for (let j = ybottom; j <= ytop; j++) {
                currfarm.xstrip[j]!.usedBy(xdike, occupiant, occcnt)
            }

            for (let j = 0; j < occcnt.n; j++) {
                const op = occupiant[j]!
                const ec = { n: 0 }
                op.genEdge(edgearr, ec)
                const edgecnt = ec.n
                for (let k = 0; k < edgecnt; k += 2) {
                    const from = this.mapToEdgeTable(face, currfarm, op, edgearr[k]!)
                    const to = this.mapToEdgeTable(face, currfarm, op, edgearr[k + 1]!)
                    if (from < 0 || to < 0 || from >= this.edgeno || to >= this.edgeno) continue
                    if (edge[from]! === -1) edge[from] = to
                    else if (edge[this.edgeno + from]! === -1) edge[this.edgeno + from] = to
                    if (edge[to]! === -1) edge[to] = from
                    else if (edge[this.edgeno + to]! === -1) edge[this.edgeno + to] = from
                }
            }
        }
    }

    generatePath(path: Int32Array, pathcnt: Int32Array, pathno: { n: number }, edge: Int32Array): void {
        let start = 0
        pathno.n = 0
        let cnt = 0
        const eno = this.edgeno
        while (start < eno) {
            while (start < eno && edge[start]! < 0) start++
            if (start >= eno) break
            let i = start
            let previdx = -1
            pathcnt[pathno.n] = 0
            path[cnt++] = start
            pathcnt[pathno.n]++
            while (true) {
                let nextidx: number
                if (edge[i] !== previdx) {
                    nextidx = edge[i]!
                    edge[i] -= eno + 1
                    edge[i + eno] -= eno + 1
                } else {
                    nextidx = edge[i + eno]!
                    edge[i] -= eno + 1
                    edge[i + eno] -= eno + 1
                }
                if (nextidx === start) break
                if (nextidx >= 0) {
                    path[cnt] = nextidx
                    cnt++
                    pathcnt[pathno.n]++
                    if (cnt > eno || pathno.n > 8) return
                } else return
                previdx = i
                i = nextidx
            }
            pathno.n++
        }
    }

    indexToCoord(idx: number, coord: Int32Array, xyz: { v: number }): void {
        const ctx = this.ctx
        if (idx < 0 || idx >= this.edgeno) return
        let face = 0
        for (; face < 5; face++) {
            if (idx >= this.offset[face]! && idx < this.offset[face + 1]!) break
        }
        let li = idx - this.offset[face]!
        const vertical = li & 1
        li >>= 1
        switch (face) {
            case HR_BOTTOM:
                xyz.v = vertical ? YDIM : XDIM
                coord[0] = vertical ? (li % this.width) + 1 + ctx.start(this.dike[TOP]!) : (li % this.width) + ctx.start(this.dike[TOP]!)
                coord[1] = vertical ? Math.floor(li / this.width) + ctx.start(this.dike[LEFT]!) : Math.floor(li / this.width) + 1 + ctx.start(this.dike[LEFT]!)
                coord[2] = this.bottom
                break
            case HR_TOP:
                xyz.v = vertical ? YDIM : XDIM
                coord[0] = (li % this.width) + ctx.start(this.dike[TOP]!)
                coord[1] = Math.floor(li / this.width) + ctx.start(this.dike[LEFT]!)
                coord[2] = this.top + 1
                break
            case HR_NEARXZ:
                xyz.v = vertical ? ZDIM : XDIM
                coord[0] = (li % this.width) + ctx.start(this.dike[TOP]!)
                coord[1] = ctx.start(this.dike[LEFT]!)
                coord[2] = Math.floor(li / this.width) + this.bottom
                break
            case HR_FARXZ:
                xyz.v = vertical ? ZDIM : XDIM
                coord[0] = vertical ? (li % this.width) + 1 + ctx.start(this.dike[TOP]!) : (li % this.width) + ctx.start(this.dike[TOP]!)
                coord[1] = ctx.end(this.dike[LEFT]!)
                coord[2] = vertical ? Math.floor(li / this.width) + this.bottom : Math.floor(li / this.width) + 1 + this.bottom
                break
            case HR_NEARYZ:
                xyz.v = vertical ? ZDIM : YDIM
                coord[0] = ctx.start(this.dike[TOP]!)
                coord[1] = vertical ? (li % this.depth) + 1 + ctx.start(this.dike[LEFT]!) : (li % this.depth) + ctx.start(this.dike[LEFT]!)
                coord[2] = Math.floor(li / this.depth) + this.bottom
                break
            case HR_FARYZ:
                xyz.v = vertical ? ZDIM : YDIM
                coord[0] = ctx.end(this.dike[TOP]!)
                coord[1] = (li % this.depth) + ctx.start(this.dike[LEFT]!)
                coord[2] = vertical ? Math.floor(li / this.depth) + this.bottom : Math.floor(li / this.depth) + 1 + this.bottom
                break
            default:
                break
        }
    }

    checkEmpty(xyfarm: AscFarm[]): boolean {
        const ctx = this.ctx
        const sx = ctx.start(this.dike[TOP]!)
        const ex = ctx.end(this.dike[TOP]!)
        const sy = this.dike[LEFT]!
        const ey = ctx.end(this.dike[LEFT]!)
        let occupied = 0
        for (let i = this.bottom; i <= this.top + 1; i++) {
            const farm = xyfarm[i]!
            occupied |= farm.xlign[sy]!.occ[1]! | farm.xlign[ey]!.occ[1]! | farm.ylign[sx]!.occ[1]! | farm.ylign[ex]!.occ[1]!
        }
        if (occupied) {
            this.empty = false
            return false
        }
        this.empty = true
        return true
    }
}
