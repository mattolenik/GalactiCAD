/**
 * Binary subdivision tier matching asc `asc.h`-style block sizes (JS port supports beyond legacy asc8).
 * Tier index `t`: macro-block edge length **N = 2^t** lattice cells per axis (`SIZE = 2^(t+1)` dikes).
 */
export type AscTierIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7

/** Inclusive maximum `AscTierIndex` (`effectiveAscTierForGrid` stops raising here). */
export const ASC_TIER_MAX_INDEX: AscTierIndex = 7

/** Dev Tools / logs (`ASC1` … `asc128`). */
const ASC_TIER_SHORT_LABELS = [
    "ASC1 (N=1)",
    "ASC2 (N=2)",
    "ASC4 (N=4)",
    "ASC8 (N=8)",
    "asc16 (N=16)",
    "asc32 (N=32)",
    "asc64 (N=64)",
    "asc128 (N=128)",
] as const

/** Human-readable tier for logs (index 2 is ASC4 / N=4; index 7 is asc128 / N=128). */
export function ascTierShortLabel(tierIndex: AscTierIndex): string {
    return ASC_TIER_SHORT_LABELS[tierIndex]
}

export interface AscBinTier {
    readonly tierIndex: AscTierIndex
    readonly nLevel: number
    /** Intervals along one lign (1 << nLevel). */
    readonly N: number
    /** Dikes in binary tree (1 << (nLevel + 1)). */
    readonly SIZE: number
    /** Double SIZE. */
    readonly DSIZE: number
}

export function ascBinTier(tierIndex: AscTierIndex): AscBinTier {
    const nLevel = tierIndex
    const N = 1 << nLevel
    const SIZE = 1 << (nLevel + 1)
    const DSIZE = 1 << (nLevel + 2)
    return { tierIndex, nLevel, N, SIZE, DSIZE }
}

/** Dike lookup tables (same recurrence as `DikeTableInit` in asc dikelign.cpp). */
export interface AscDikeTables {
    readonly tier: AscBinTier
    readonly levelTable: Int32Array
    readonly lengthTable: Int32Array
    readonly nextDikeTable: Int32Array
    readonly startTable: Int32Array
    readonly endTable: Int32Array
}

export function buildAscDikeTables(tier: AscBinTier): AscDikeTables {
    const { N, SIZE, DSIZE, nLevel } = tier
    const levelTable = new Int32Array(DSIZE)
    const lengthTable = new Int32Array(DSIZE)
    const nextDikeTable = new Int32Array(DSIZE)
    const startTable = new Int32Array(DSIZE)
    const endTable = new Int32Array(DSIZE)

    for (let k = 1; k < DSIZE; k++) {
        levelTable[k] = Math.floor(Math.log2(k))
        const exp = nLevel - levelTable[k]!
        // C++ uses 1<<(NLEVEL-level); for k with level>NLEVEL the shift is undefined — use 1.
        lengthTable[k] = exp >= 0 && exp < 31 ? 1 << exp : 1
        nextDikeTable[k] = k & (k + 1) ? k + 1 : 0
        startTable[k] = (k << (nLevel - levelTable[k]!)) - N
        endTable[k] = startTable[k]! + lengthTable[k]!
    }

    return { tier, levelTable, lengthTable, nextDikeTable, startTable, endTable }
}
