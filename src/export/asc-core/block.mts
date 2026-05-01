import { HR_BOTTOM, HR_FARXZ, HR_FARYZ, HR_NEARXZ, HR_NEARYZ, HR_TOP, LEFT, TOP, XDIM, YDIM, ZDIM } from "./constants.mjs"
import { AscVoxelGrid } from "./data-grid.mjs"
import type { AscRuntimeContext } from "./dikelign.mjs"
import { AscLign } from "./dikelign.mjs"
import { AscDoublyList } from "./doublist.mjs"
import { AscFarm } from "./farm.mjs"
import { AscHighRice } from "./highrice.mjs"
import type { AscBlockSampleRef } from "./padi.mjs"
import { AscSlab } from "./slab.mjs"
import { vadd, vcross, vdot, vnormal, vscale, vsub, vequal } from "./asc-vec.mjs"

/** One ASC macro-block (asc `Block`). */
export class AscBlock implements AscBlockSampleRef {
    readonly ctx: AscRuntimeContext
    grid: AscVoxelGrid
    dataDimX: number
    dataDimY: number
    dataDimZ: number
    offX!: number
    offY!: number
    offZ!: number
    highricelist: AscDoublyList<AscHighRice> | null = null
    xyfarm: AscFarm[] = []
    xzfarm: AscFarm[] = []
    yzfarm: AscFarm[] = []
    slab: AscSlab[] = []
    xver: Int16Array
    yver: Int16Array
    zver: Int16Array
    xocc: Int8Array
    yocc: Int8Array
    zocc: Int8Array
    private exyz = 0
    private lcfarm: AscFarm[] | null = null
    private hzfarm: AscFarm[] | null = null

    constructor(ctx: AscRuntimeContext, grid: AscVoxelGrid, dataDimX: number, dataDimY: number, dataDimZ: number) {
        this.ctx = ctx
        this.grid = grid
        this.dataDimX = dataDimX
        this.dataDimY = dataDimY
        this.dataDimZ = dataDimZ
        const { N, SIZE } = ctx.tier
        const sz = (N + 1) * (N + 1) * SIZE
        this.xver = new Int16Array(sz)
        this.yver = new Int16Array(sz)
        this.zver = new Int16Array(sz)
        this.xocc = new Int8Array(sz)
        this.yocc = new Int8Array(sz)
        this.zocc = new Int8Array(sz)
        for (let i = 0; i <= N; i++) {
            this.xyfarm.push(new AscFarm(ctx))
            this.xzfarm.push(new AscFarm(ctx))
            this.yzfarm.push(new AscFarm(ctx))
        }
        for (let i = 0; i < N; i++) this.slab.push(new AscSlab(ctx))
    }

    private ensureTempFarms(): void {
        if (this.lcfarm) return
        const { N } = this.ctx.tier
        this.lcfarm = []
        this.hzfarm = []
        for (let k = 0; k <= N; k++) {
            this.lcfarm.push(new AscFarm(this.ctx))
            this.hzfarm.push(new AscFarm(this.ctx))
        }
    }

    setOrientation(xis: number, yis: number, zis: number): void {
        this.exyz = 0
        this.exyz = (this.exyz & 0xfc) | (xis & 0x03)
        this.exyz = (this.exyz & 0xf3) | ((yis & 0x03) << 2)
        this.exyz = (this.exyz & 0xcf) | ((zis & 0x03) << 4)
    }

    emptyQ(): boolean {
        return (this.exyz & 0x80) !== 0
    }

    unsetEmpty(): void {
        this.exyz &= 0x7f
    }

    setEmpty(): void {
        this.exyz |= 0x80
    }

    private xisQ(): number {
        return this.exyz & 0x03
    }

    private yisQ(): number {
        return (this.exyz >> 2) & 0x03
    }

    private zisQ(): number {
        return (this.exyz >> 4) & 0x03
    }

    init(offx: number, offy: number, offz: number): void {
        this.offX = offx
        this.offY = offy
        this.offZ = offz
        this.highricelist = null
        const { N, SIZE } = this.ctx.tier
        let nonempty = 0
        for (let j = 0; j <= N; j++) {
            for (let i = 0; i <= N; i++) {
                const pos = (j * (N + 1) + i) * SIZE
                this.initOccLine(-1, i, j, this.xocc.subarray(pos, pos + SIZE))
                this.initVerLine(this.xocc.subarray(pos, pos + SIZE), this.xver.subarray(pos, pos + SIZE))
                this.initOccLine(i, -1, j, this.yocc.subarray(pos, pos + SIZE))
                this.initVerLine(this.yocc.subarray(pos, pos + SIZE), this.yver.subarray(pos, pos + SIZE))
                this.initOccLine(i, j, -1, this.zocc.subarray(pos, pos + SIZE))
                this.initVerLine(this.zocc.subarray(pos, pos + SIZE), this.zver.subarray(pos, pos + SIZE))
                nonempty |= this.xocc[pos + 1]! | this.yocc[pos + 1]! | this.zocc[pos + 1]!
            }
        }
        if (!nonempty) this.setEmpty()
    }

    private initOccLine(x: number, y: number, z: number, occ: Int8Array): void {
        const { N } = this.ctx.tier
        const lr = this.grid.lineReader(x, y, z, this.offX, this.offY, this.offZ)
        for (let i = 0; i < N; i++) {
            const d1 = lr.at(i)
            const d2 = lr.at(i + 1)
            occ[i + N] = ((d1 << 1) | (~d1 & 0x01)) & (((~d2 & 0x01) << 1) | d2)
        }
        for (let i = N - 1; i > 0; i--) occ[i] = occ[i << 1]! | occ[(i << 1) + 1]!
        occ[0] = 0
    }

    private initVerLine(occ: Int8Array, ver: Int16Array): void {
        const { N } = this.ctx.tier
        for (let i = 0; i < N; i++) {
            if (occ[i + N]!) ver[i + N] = i + N
            else ver[i + N] = 0
        }
        for (let i = N - 1; i > 0; i--) {
            if (ver[i << 1]! > 0) ver[i] = ver[i << 1]!
            else if (ver[(i << 1) + 1]! > 0) ver[i] = ver[(i << 1) + 1]!
            else ver[i] = 0
        }
        ver[0] = 0
    }

    cleanUp(): void {
        const { N } = this.ctx.tier
        for (let i = 0; i <= N; i++) {
            this.xyfarm[i]!.cleanUp()
            this.xzfarm[i]!.cleanUp()
            this.yzfarm[i]!.cleanUp()
        }
        if (this.highricelist) {
            this.highricelist.clearAndDispose()
            this.highricelist = null
        }
        this.setEmpty()
    }

    private produceHighRice(xyfarm: AscFarm[]): AscDoublyList<AscHighRice> {
        const { N } = this.ctx.tier
        const xydike = new Int32Array(2)
        const holder: AscHighRice[] = []

        for (let i = 0; i < N; i++) {
            this.slab[i]!.init(xyfarm[i]!, xyfarm[i + 1]!)
        }

        if (this.highricelist) this.highricelist.clearAndDispose()
        this.highricelist = new AscDoublyList<AscHighRice>()

        for (let j = 0; j < N; j++) {
            for (let go_on = this.slab[j]!.firstPadi(xydike); go_on; go_on = this.slab[j]!.nextPadi(xydike)) {
                const x = xydike[0]!
                const y = xydike[1]!
                let jj = j + 1
                while (jj < N && this.slab[jj]!.xlign[this.ctx.start(y)]!.simple[x] === x && this.slab[jj]!.ylign[this.ctx.start(x)]!.simple[y] === y)
                    jj++
                jj--
                let holdercnt = 0
                let curr = new AscHighRice(this.ctx)
                curr.initHr(x, y, j, jj)
                do {
                    if (holdercnt > 0) {
                        holdercnt--
                        curr = holder[holdercnt]!
                    }
                    const competitor: AscHighRice[] = []
                    for (let h = this.highricelist.first(); h !== null; h = this.highricelist.next()) {
                        if (curr.overlapHr(h)) competitor.push(h)
                    }
                    let ok = true
                    for (const comp of competitor) {
                        if (curr.enclosedByHr(comp)) {
                            ok = false
                            break
                        }
                        if (comp.enclosedByHr(curr)) {
                            this.highricelist.remove(comp)
                        } else {
                            const hc = { n: holdercnt }
                            curr.clipByHr(comp, holder, hc)
                            holdercnt = hc.n
                            ok = false
                            break
                        }
                    }
                    if (ok) this.highricelist.append(curr)
                } while (holdercnt > 0)
            }
        }
        return this.highricelist
    }

    initSimpleByHighRice(): void {
        this.ensureTempFarms()
        const { N, SIZE } = this.ctx.tier
        const lcfarm = this.lcfarm!
        const hzfarm = this.hzfarm!
        for (let k = 0; k <= N; k++) {
            for (let j = 0; j <= N; j++) {
                for (let i = 0; i < SIZE; i++) {
                    lcfarm[k]!.xlign[j]!.simple.set(this.ctx.nullSimple)
                    lcfarm[k]!.ylign[j]!.simple.set(this.ctx.nullSimple)
                    hzfarm[k]!.xlign[j]!.simple.set(this.ctx.nullSimple)
                    this.xyfarm[k]!.xlign[j]!.simple.set(this.ctx.nullSimple)
                    this.xyfarm[k]!.ylign[j]!.simple.set(this.ctx.nullSimple)
                    this.xzfarm[k]!.xlign[j]!.simple.set(this.ctx.nullSimple)
                    this.xzfarm[k]!.ylign[j]!.simple.set(this.ctx.nullSimple)
                    this.yzfarm[k]!.xlign[j]!.simple.set(this.ctx.nullSimple)
                    this.yzfarm[k]!.ylign[j]!.simple.set(this.ctx.nullSimple)
                }
            }
        }

        for (let curr = this.highricelist!.first(); curr !== null; curr = this.highricelist!.next()) {
            const xznear = this.ctx.start(curr.dike[LEFT]!)
            const xzfar = this.ctx.end(curr.dike[LEFT]!)
            const yznear = this.ctx.start(curr.dike[TOP]!)
            const yzfar = this.ctx.end(curr.dike[TOP]!)
            const xzdikestart = N + yznear
            const yzdikestart = N + xznear
            const xzdike = curr.dike[TOP]!
            const yzdike = curr.dike[LEFT]!
            for (let j = xznear; j < xzfar; j++) {
                this.xyfarm[curr.bottom]!.xlign[j]!.simple[xzdikestart] = xzdike
                hzfarm[curr.top + 1]!.xlign[j]!.simple[xzdikestart] = xzdike
                const N_l = N - (xzfar - j)
                for (let i = yznear; i < yzfar; i++) {
                    this.xyfarm[curr.bottom]!.ylign[i]!.simple[j] = Math.max(N_l, this.xyfarm[curr.bottom]!.ylign[i]!.simple[j]!)
                    this.xyfarm[curr.top + 1]!.ylign[i]!.simple[j] = Math.max(N_l, this.xyfarm[curr.top + 1]!.ylign[i]!.simple[j]!)
                }
            }
            for (let j = curr.bottom; j <= curr.top; j++) {
                this.xzfarm[xznear]!.xlign[j]!.simple[xzdikestart] = xzdike
                lcfarm[xzfar]!.xlign[j]!.simple[xzdikestart] = xzdike
                this.yzfarm[yznear]!.xlign[j]!.simple[yzdikestart] = yzdike
                lcfarm[yzfar]!.ylign[j]!.simple[yzdikestart] = yzdike
            }
            for (let j = curr.bottom; j <= curr.top; j++) {
                const N_l = N - (curr.top - j + 1)
                for (let i = yznear; i < yzfar; i++) {
                    this.xzfarm[xznear]!.ylign[i]!.simple[j] = Math.max(N_l, this.xzfarm[xznear]!.ylign[i]!.simple[j]!)
                    this.xzfarm[xzfar]!.ylign[i]!.simple[j] = Math.max(N_l, this.xzfarm[xzfar]!.ylign[i]!.simple[j]!)
                }
                for (let i = xznear; i < xzfar; i++) {
                    this.yzfarm[yznear]!.ylign[i]!.simple[j] = Math.max(N_l, this.yzfarm[yznear]!.ylign[i]!.simple[j]!)
                    this.yzfarm[yzfar]!.ylign[i]!.simple[j] = Math.max(N_l, this.yzfarm[yzfar]!.ylign[i]!.simple[j]!)
                }
            }
        }

        for (let k = 0; k <= N; k++) {
            for (let j = 0; j < N; j++) {
                this.xyfarm[k]!.ylign[j]!.fillSpecSimpleVacancy()
                this.xzfarm[k]!.ylign[j]!.fillSpecSimpleVacancy()
                this.yzfarm[k]!.ylign[j]!.fillSpecSimpleVacancy()
                this.xyfarm[k]!.xlign[j]!.fillSimpleVacancy()
                hzfarm[k]!.xlign[j]!.fillSimpleVacancy()
                this.xzfarm[k]!.xlign[j]!.fillSimpleVacancy()
                lcfarm[k]!.xlign[j]!.fillSimpleVacancy()
                this.yzfarm[k]!.xlign[j]!.fillSimpleVacancy()
                lcfarm[k]!.ylign[j]!.fillSimpleVacancy()
                this.xyfarm[k]!.xlign[j]!.propagateUpSimple()
                hzfarm[k]!.xlign[j]!.propagateUpSimple()
                this.xzfarm[k]!.xlign[j]!.propagateUpSimple()
                lcfarm[k]!.xlign[j]!.propagateUpSimple()
                this.yzfarm[k]!.xlign[j]!.propagateUpSimple()
                lcfarm[k]!.ylign[j]!.propagateUpSimple()
                this.xyfarm[k]!.xlign[j]!.propagateDownSimple()
                hzfarm[k]!.xlign[j]!.propagateDownSimple()
                this.xyfarm[k]!.xlign[j]!.maxSimple(hzfarm[k]!.xlign[j]!)
                this.xzfarm[k]!.xlign[j]!.propagateDownSimple()
                lcfarm[k]!.xlign[j]!.propagateDownSimple()
                this.xzfarm[k]!.xlign[j]!.maxSimple(lcfarm[k]!.xlign[j]!)
                this.yzfarm[k]!.xlign[j]!.propagateDownSimple()
                lcfarm[k]!.ylign[j]!.propagateDownSimple()
                this.yzfarm[k]!.xlign[j]!.maxSimple(lcfarm[k]!.ylign[j]!)
            }
        }
        for (let k = 0; k <= N; k++) {
            for (let i = 0; i < SIZE; i++) {
                this.xyfarm[k]!.xlign[N]!.simple[i] = this.xyfarm[k]!.xlign[N - 1]!.simple[i]!
                this.xzfarm[k]!.xlign[N]!.simple[i] = this.xzfarm[k]!.xlign[N - 1]!.simple[i]!
                this.yzfarm[k]!.xlign[N]!.simple[i] = this.yzfarm[k]!.xlign[N - 1]!.simple[i]!
            }
        }
    }

    buildHighRice(handleAmbiguity: boolean): void {
        const { N } = this.ctx.tier
        const ref: AscBlockSampleRef = this
        for (let i = 0; i <= N; i++) {
            this.xyfarm[i]!.init(this.xisQ(), this.yisQ(), i, this.xocc, this.yocc, this.xver, this.yver)
            this.xzfarm[i]!.init(this.xisQ(), this.zisQ(), i, this.xocc, this.zocc, this.xver, this.zver)
            this.yzfarm[i]!.init(this.yisQ(), this.zisQ(), i, this.yocc, this.zocc, this.yver, this.zver)
            this.xyfarm[i]!.producePadi(ref, 0, handleAmbiguity)
            this.xyfarm[i]!.initSimpleByPadi()
        }
        this.highricelist = this.produceHighRice(this.xyfarm)
        this.initSimpleByHighRice()
    }

    communicateSimple(
        bottom: AscBlock | null,
        top: AscBlock | null,
        nearxz: AscBlock | null,
        farxz: AscBlock | null,
        nearyz: AscBlock | null,
        faryz: AscBlock | null,
    ): void {
        const { N, SIZE } = this.ctx.tier
        const validface = [
            bottom !== null && !bottom.emptyQ(),
            top !== null && !top.emptyQ(),
            nearxz !== null && !nearxz.emptyQ(),
            farxz !== null && !farxz.emptyQ(),
            nearyz !== null && !nearyz.emptyQ(),
            faryz !== null && !faryz.emptyQ(),
        ]
        for (let face = 0; face < 6; face++) {
            if (!validface[face]) continue
            for (let j = 0; j <= N; j++) {
                let myx: Int16Array
                let myy: Int16Array
                let nbx: Int16Array
                let nby: Int16Array
                switch (face) {
                    case HR_BOTTOM:
                        myx = this.xyfarm[0]!.xlign[j]!.simple
                        myy = this.xyfarm[0]!.ylign[j]!.simple
                        nbx = bottom!.xyfarm[N]!.xlign[j]!.simple
                        nby = bottom!.xyfarm[N]!.ylign[j]!.simple
                        break
                    case HR_TOP:
                        myx = this.xyfarm[N]!.xlign[j]!.simple
                        myy = this.xyfarm[N]!.ylign[j]!.simple
                        nbx = top!.xyfarm[0]!.xlign[j]!.simple
                        nby = top!.xyfarm[0]!.ylign[j]!.simple
                        break
                    case HR_NEARXZ:
                        myx = this.xzfarm[0]!.xlign[j]!.simple
                        myy = this.xzfarm[0]!.ylign[j]!.simple
                        nbx = nearxz!.xzfarm[N]!.xlign[j]!.simple
                        nby = nearxz!.xzfarm[N]!.ylign[j]!.simple
                        break
                    case HR_FARXZ:
                        myx = this.xzfarm[N]!.xlign[j]!.simple
                        myy = this.xzfarm[N]!.ylign[j]!.simple
                        nbx = farxz!.xzfarm[0]!.xlign[j]!.simple
                        nby = farxz!.xzfarm[0]!.ylign[j]!.simple
                        break
                    case HR_NEARYZ:
                        myx = this.yzfarm[0]!.xlign[j]!.simple
                        myy = this.yzfarm[0]!.ylign[j]!.simple
                        nbx = nearyz!.yzfarm[N]!.xlign[j]!.simple
                        nby = nearyz!.yzfarm[N]!.ylign[j]!.simple
                        break
                    case HR_FARYZ:
                        myx = this.yzfarm[N]!.xlign[j]!.simple
                        myy = this.yzfarm[N]!.ylign[j]!.simple
                        nbx = faryz!.yzfarm[0]!.xlign[j]!.simple
                        nby = faryz!.yzfarm[0]!.ylign[j]!.simple
                        break
                    default:
                        continue
                }
                for (let i = 0; i < SIZE; i++) {
                    myx[i] = Math.max(myx[i]!, nbx[i]!)
                    myy[i] = Math.max(myy[i]!, nby[i]!)
                }
            }
        }
    }

    collectTriangles(
        out: { positions: number[]; normals: number[]; indices: number[] },
        opts: { widthScale: number; depthScale: number; heightScale: number; handleBeauty: boolean; angleThreshRad: number },
    ): void {
        const { N } = this.ctx.tier
        const maxE = 4 * 3 * N * N * 8
        const edge = new Int32Array(2 * maxE).fill(-1)
        const path = new Int32Array(2 * 6 * N * N + 1)
        const pathcnt = new Int32Array(8)
        const pathno = { n: 0 }
        const ref: AscBlockSampleRef = this

        for (let i = 0; i <= N; i++) {
            this.xyfarm[i]!.producePadi(ref, 0x02, false)
            this.xzfarm[i]!.producePadi(ref, 0x02, false)
            this.yzfarm[i]!.producePadi(ref, 0x02, false)
        }

        for (let hr = this.highricelist!.first(); hr !== null; hr = this.highricelist!.next()) {
            edge.fill(-1)
            hr.setupEdgeTable(this.xyfarm, this.xzfarm, this.yzfarm, edge)
            pathno.n = 0
            hr.generatePath(path, pathcnt, pathno, edge)
            if (pathno.n > 0) this.outTriangle(hr, path, pathcnt, pathno.n, out, opts)
        }
    }

    private outTriangle(
        hr: AscHighRice,
        path: Int32Array,
        pathcnt: Int32Array,
        pathno: number,
        out: { positions: number[]; normals: number[]; indices: number[] },
        opts: { widthScale: number; depthScale: number; heightScale: number; handleBeauty: boolean; angleThreshRad: number },
    ): void {
        const wx = opts.widthScale
        const wy = opts.depthScale
        const wz = opts.heightScale
        const wx2 = wx / 2
        const wy2 = wy / 2
        const wz2 = wz / 2
        const elementno = 3 * (2 * 6 * this.ctx.tier.N * this.ctx.tier.N + 1)
        const vert = new Float32Array(elementno)
        const grad = new Float32Array(elementno)
        const cell = new Int32Array(3)
        const xyz = { v: 0 }

        for (let k = 0, start = 0; k < pathno; start += pathcnt[k]!, k++) {
            for (let i = start; i < start + pathcnt[k]!; i++) {
                const o = i * 3
                hr.indexToCoord(path[i]!, cell, xyz)
                this.calVertex(vert, o, cell, xyz.v)
                this.calFastGradient(grad, o, cell)
                grad[o] *= wx2
                grad[o + 1] *= wy2
                grad[o + 2] *= wz2
                vnormal(grad, o)
            }
        }

        for (let k = 0, start = 0; k < pathno; start += pathcnt[k]!, k++) {
            let segcnt = pathcnt[k]!
            const vidx = [0, 0, 0]
            vidx[0] = (start - 1) * 3
            let anglethresh = opts.handleBeauty ? opts.angleThreshRad : Math.PI
            let cosanglethresh = Math.cos(anglethresh)
            let idlecnt = 0
            while (segcnt >= 3) {
                const searchstart = Math.floor(vidx[0]! / 3) + 1 - start
                let j = 0
                for (let i = searchstart; j < 3; ) {
                    const off = (i % pathcnt[k]!) + start
                    if (path[off]! >= 0) vidx[j++] = 3 * off
                    i = i >= 2000 ? (i % pathcnt[k]!) + 1 : i + 1
                }
                idlecnt++
                if (idlecnt > segcnt) {
                    anglethresh = Math.min(Math.PI, anglethresh + 0.15)
                    cosanglethresh = Math.cos(anglethresh)
                    idlecnt = 1
                }
                let finished = vidx[1]!
                const o0 = vidx[0]!
                const o1 = vidx[1]!
                const o2 = vidx[2]!
                if (!vequal(vert, o0, vert, o1) && !vequal(vert, o0, vert, o2) && !vequal(vert, o1, vert, o2)) {
                    const cv1 = [0, 0, 0]
                    const cv2 = [0, 0, 0]
                    const cross = [0, 0, 0]
                    vsub(vert, o2, vert, o1, cv1, 0)
                    vsub(vert, o0, vert, o1, cv2, 0)
                    vcross(cv1, 0, cv2, 0, cross, 0)
                    if (vdot(cross, 0, grad, o1) < 0) {
                        const t = vidx[0]!
                        vidx[0] = vidx[2]!
                        vidx[2] = t
                    }
                    if (opts.handleBeauty) {
                        const avgn = [0, 0, 0]
                        vadd(grad, vidx[0]!, grad, vidx[1]!, avgn, 0)
                        vadd(grad, vidx[2]!, avgn, 0, avgn, 0)
                        vscale(avgn, 0, 1 / 3)
                        vnormal(avgn, 0)
                        vnormal(cross, 0)
                        let dp = vdot(avgn, 0, cross, 0)
                        if (dp < 0) dp = -dp
                        if (dp < cosanglethresh) {
                            // skip
                        } else {
                            this.emitTri(out, vert, grad, vidx, wx, wy, wz)
                        }
                    } else {
                        this.emitTri(out, vert, grad, vidx, wx, wy, wz)
                    }
                } else {
                    if (!vequal(vert, o0, vert, o1) && !vequal(vert, o2, vert, o1)) finished = vidx[0]!
                }
                const fi = Math.floor(finished / 3)
                path[start + fi] = -path[start + fi]! - 1
                segcnt--
                idlecnt = 0
            }
        }
    }

    private emitTri(
        out: { positions: number[]; normals: number[]; indices: number[] },
        vert: Float32Array,
        grad: Float32Array,
        vidx: number[],
        wx: number,
        wy: number,
        wz: number,
    ): void {
        const base = out.positions.length / 3
        for (const o of vidx) {
            out.positions.push(vert[o]! * wx, vert[o + 1]! * wy, vert[o + 2]! * wz)
            out.normals.push(grad[o]!, grad[o + 1]!, grad[o + 2]!)
        }
        out.indices.push(base, base + 1, base + 2)
    }

    private calVertex(coord: Float32Array, o: number, cell: Int32Array, side: number): void {
        const x = cell[0]!
        const y = cell[1]!
        const z = cell[2]!
        coord[o] = this.offX + x
        coord[o + 1] = this.offY + y
        coord[o + 2] = this.offZ + z
        const th = this.grid.threshold
        let ratio = 0
        if (side === XDIM) {
            const x1 = this.grid.valueAt(this.offX + x, this.offY + y, this.offZ + z)
            const x2 = this.grid.valueAt(this.offX + x + 1, this.offY + y, this.offZ + z)
            ratio = (th - x1) / (x2 - x1 || 1e-12)
            coord[o] += ratio
        } else if (side === YDIM) {
            const y1 = this.grid.valueAt(this.offX + x, this.offY + y, this.offZ + z)
            const y2 = this.grid.valueAt(this.offX + x, this.offY + y + 1, this.offZ + z)
            ratio = (th - y1) / (y2 - y1 || 1e-12)
            coord[o + 1] += ratio
        } else {
            const z1 = this.grid.valueAt(this.offX + x, this.offY + y, this.offZ + z)
            const z2 = this.grid.valueAt(this.offX + x, this.offY + y, this.offZ + z + 1)
            ratio = (th - z1) / (z2 - z1 || 1e-12)
            coord[o + 2] += ratio
        }
    }

    private calFastGradient(g: Float32Array, o: number, cell: Int32Array): void {
        const x = cell[0]! + this.offX
        const y = cell[1]! + this.offY
        const z = cell[2]! + this.offZ
        const xprev = x === 0 ? 0 : x - 1
        const yprev = y === 0 ? 0 : y - 1
        const zprev = z === 0 ? 0 : z - 1
        const xnext = x >= this.dataDimX - 1 ? x : x + 1
        const ynext = y >= this.dataDimY - 1 ? y : y + 1
        const znext = z >= this.dataDimZ - 1 ? z : z + 1
        g[o] = this.grid.valueAt(xnext, y, z) - this.grid.valueAt(xprev, y, z)
        g[o + 1] = this.grid.valueAt(x, ynext, z) - this.grid.valueAt(x, yprev, z)
        g[o + 2] = this.grid.valueAt(x, y, znext) - this.grid.valueAt(x, y, zprev)
    }
}
