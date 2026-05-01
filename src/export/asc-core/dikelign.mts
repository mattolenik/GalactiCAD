import { COMPLEX } from "./constants.mjs"
import { ascBinTier, buildAscDikeTables, type AscBinTier, type AscDikeTables, type AscTierIndex } from "./tier.mjs"

/** Shared tier + dike tables + null simple row (asc globals / `LignNullSimpleInit`). */
export class AscRuntimeContext {
    readonly tier: AscBinTier
    readonly tables: AscDikeTables
    readonly nullSimple: Int16Array

    constructor(tier: AscBinTier, tables: AscDikeTables) {
        this.tier = tier
        this.tables = tables
        this.nullSimple = new Int16Array(tier.SIZE).fill(-1)
    }

    level(i: number): number {
        return this.tables.levelTable[i]!
    }

    length(i: number): number {
        return this.tables.lengthTable[i]!
    }

    nextDike(i: number): number {
        return this.tables.nextDikeTable[i]!
    }

    start(i: number): number {
        return this.tables.startTable[i]!
    }

    end(i: number): number {
        return this.tables.endTable[i]!
    }
}

export function createAscRuntimeContext(tierIndex: AscTierIndex): AscRuntimeContext {
    const tier = ascBinTier(tierIndex)
    return new AscRuntimeContext(tier, buildAscDikeTables(tier))
}

export function minDikeSet(ctx: AscRuntimeContext, minidx: number, maxidx: number, out: Int32Array): number {
    const { N } = ctx.tier
    let min = Math.min(minidx, maxidx)
    let max = Math.max(minidx, maxidx)
    min += N
    max += N + 1
    const mask = 1
    let dikecnt = 0
    while (min < max) {
        let currdike = min
        if (currdike & mask) {
            out[dikecnt++] = currdike
            min += ctx.length(currdike)
        } else {
            let t = ctx.length(currdike)
            while (min + (t << 1) <= max && (currdike & mask) !== 1) {
                t <<= 1
                currdike >>= 1
            }
            out[dikecnt++] = currdike
            min += t
        }
    }
    return dikecnt
}

/** Split dikes when crossing is complex (asc `BreakDikeSet`). Returns new count. */
export function breakDikeSet(ctx: AscRuntimeContext, ydike: Int32Array, ydikecnt: number, ylign: AscLign[], i: number): number {
    let cnt = ydikecnt
    for (let jj = 0; jj < cnt; jj++) {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            let ii: number
            for (ii = ctx.start(i); ii <= ctx.end(i); ii++) {
                if (ylign[ii]!.occ[ydike[jj]!] === COMPLEX) {
                    ydike[jj] <<= 1
                    ydike[cnt] = ydike[jj]! + 1
                    cnt++
                    break
                }
            }
            if (ii > ctx.end(i)) break
        }
    }
    return cnt
}

/** Mutable lign: occ[SIZE], ver[SIZE], simple[SIZE] (asc `Lign`). */
export class AscLign {
    readonly ctx: AscRuntimeContext
    occ: Int8Array
    ver: Int16Array
    simple: Int16Array

    constructor(ctx: AscRuntimeContext, occ: Int8Array, ver: Int16Array) {
        this.ctx = ctx
        this.occ = occ
        this.ver = ver
        this.simple = new Int16Array(ctx.tier.SIZE)
    }

    nextSimple(i: number): number {
        return this.simple[this.ctx.nextDike(i)]!
    }

    init(): void {
        this.simple.set(this.ctx.nullSimple)
        this.simpleQ(1, -1)
    }

    private simpleQ(myid: number, inherent: number): number {
        const { SIZE } = this.ctx.tier
        if (myid >= SIZE) return myid >> 1

        if (inherent > 0) {
            if (myid & 1) this.simple[myid] = myid
            else this.simple[myid] = inherent
            this.simpleQ(myid << 1, this.simple[myid]!)
            this.simpleQ((myid << 1) + 1, this.simple[myid]!)
        } else {
            if (this.occ[myid]! < COMPLEX) {
                this.simple[myid] = myid
                this.simpleQ(myid << 1, this.simple[myid]!)
                this.simpleQ((myid << 1) + 1, this.simple[myid]!)
            } else {
                const descendant = this.simpleQ(myid << 1, this.simple[myid]!)
                this.simpleQ((myid << 1) + 1, this.simple[myid]!)
                this.simple[myid] = descendant
            }
        }
        return this.simple[myid]!
    }

    propagateUpSimple(): void {
        const { N } = this.ctx.tier
        for (let i = N - 1; i > 0; i--) this.simple[i] = this.simple[i << 1]!
        this.simple[0] = -1
    }

    propagateDownSimple(): void {
        const { SIZE } = this.ctx.tier
        for (let i = 1; i < SIZE; i++) {
            if (this.simple[i] === -1) {
                if (i & 1) this.simple[i] = i
                else this.simple[i] = this.simple[i >> 1]!
            }
        }
    }

    maxSimple(neighbor: AscLign): void {
        const { SIZE } = this.ctx.tier
        for (let i = 1; i < SIZE; i++) this.simple[i] = Math.max(this.simple[i]!, neighbor.simple[i]!)
    }

    fillSimpleVacancy(): void {
        const { N } = this.ctx.tier
        const dikearr = new Int32Array(N)
        let empbegin = 0
        for (let i = 0; i < N; i++) {
            if (this.simple[i + N] !== -1) {
                if (empbegin < i) {
                    const dikecnt = minDikeSet(this.ctx, empbegin, i - 1, dikearr)
                    for (let l = 0; l < dikecnt; l++) {
                        this.simple[this.ctx.start(dikearr[l]!) + N] = dikearr[l]!
                    }
                    empbegin = i
                }
                empbegin++
            }
        }
        if (empbegin < N) {
            const dikecnt = minDikeSet(this.ctx, empbegin, N - 1, dikearr)
            for (let l = 0; l < dikecnt; l++) {
                this.simple[this.ctx.start(dikearr[l]!) + N] = dikearr[l]!
            }
        }
    }

    fillSpecSimpleVacancy(): void {
        const { N } = this.ctx.tier
        let empbegin = 0
        for (let i = 0; i < N; i++) {
            if (this.simple[i] !== -1) {
                if (empbegin < i) {
                    for (let l = empbegin; l < i; l++) this.simple[l] = N - (i - l)
                    empbegin = i
                }
                empbegin++
            }
        }
        if (empbegin < N) {
            for (let l = empbegin; l < N; l++) this.simple[l] = N - (N - l)
        }
    }
}
