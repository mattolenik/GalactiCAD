/**
 * MDC `edgeDetection_Pass3` Phase 1–2 feature inference for **one** surface
 * component (CPU / SHREC). Skips the GPU-only corner Newton probe.
 */

import {
    COMPONENT_FEATURE_REJECTED,
    MID_FEATURE_BOOLEAN_SEAM,
    MID_FEATURE_CORNER,
    MID_FEATURE_LINE,
    MID_FEATURE_NONE,
    MID_FEATURE_RING,
    MID_FEATURE_SEAM_COS_THRESH,
    MID_LATHE_MANTLE_NORMAL_COUNT,
    type ComponentFeatureCpu,
    type SdfMidSampleCpu,
    zeroComponentFeatureCpu,
} from "../mdc-mid-grid.mjs"
import {
    sym3AddOuter,
    sym3Eigen,
    sym3Mul,
    sym3SolveTikhonov,
    sym3Zero,
    type Sym3,
} from "./svd3.mjs"

const MDC_FEATURE_PROX_SCALE = 0.75
const MDC_CORNER_FEATURE_PROX_SCALE = 1.35
const MDC_RING_FEATURE_PROX_SCALE = 1.35
const COMPONENT_NORMAL_COS_THRESH = 0.95
const MDC_INFER_LINE_DOT_MAX = 0.7
const MDC_INFER_LINE_MIN_BUCKET_SAMPLES = 2
const MDC_INFER_LINE_BUCKET_COHERENCE = 0.95

export const MDC_FEATURE_PLANE_WEIGHT = 0.12

export interface CrossingMidInput {
    ei: number
    compIdx: number
    px: number
    py: number
    pz: number
    nx: number
    ny: number
    nz: number
    mid: SdfMidSampleCpu
}

function dot3(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
    return ax * bx + ay * by + az * bz
}

function cross3(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
): [number, number, number] {
    return [
        ay * bz - az * by,
        az * bx - ax * bz,
        ax * by - ay * bx,
    ]
}

function length3(x: number, y: number, z: number): number {
    return Math.hypot(x, y, z)
}

function safeUnit3(x: number, y: number, z: number): [number, number, number] {
    const len = length3(x, y, z)
    if (len < 1e-12) return [0, 1, 0]
    const inv = 1 / len
    return [x * inv, y * inv, z * inv]
}

function ownerPairEqual(ax: number, ay: number, bx: number, by: number): boolean {
    return ax === bx && ay === by
}

function orderedOwnerPair(ownerA: number, ownerB: number): [number, number] {
    if (ownerA === 0 && ownerB === 0) return [0, 0]
    if (ownerA === 0) return [ownerB, ownerB]
    if (ownerB === 0) return [ownerA, ownerA]
    if (ownerA <= ownerB) return [ownerA, ownerB]
    return [ownerB, ownerA]
}

function solveFeaturePointCpu(
    n0: [number, number, number], p0: [number, number, number],
    n1: [number, number, number], p1: [number, number, number],
    n2: [number, number, number], p2: [number, number, number],
    planeCount: 2 | 3,
): [number, number, number] {
    const M: Sym3 = sym3Zero()
    const ATb: [number, number, number] = [0, 0, 0]
    let mx = 0, my = 0, mz = 0
    let np = 0

    const addPlane = (n: [number, number, number], p: [number, number, number]) => {
        const [nx, ny, nz] = safeUnit3(n[0], n[1], n[2])
        sym3AddOuter(M, nx, ny, nz, 1)
        const d = dot3(nx, ny, nz, p[0], p[1], p[2])
        ATb[0] += d * nx
        ATb[1] += d * ny
        ATb[2] += d * nz
        mx += p[0]
        my += p[1]
        mz += p[2]
        np++
    }

    if (planeCount >= 1) addPlane(n0, p0)
    if (planeCount >= 2) addPlane(n1, p1)
    if (planeCount >= 3) addPlane(n2, p2)

    if (np === 0) return [0, 0, 0]
    const inv = 1 / np
    mx *= inv
    my *= inv
    mz *= inv

    const Mmass: [number, number, number] = [0, 0, 0]
    sym3Mul(M, mx, my, mz, Mmass)
    const rhsX = ATb[0] - Mmass[0]
    const rhsY = ATb[1] - Mmass[1]
    const rhsZ = ATb[2] - Mmass[2]

    const eig = sym3Eigen(M)
    const lambdaReg = Math.max(1e-9, 0.001 * Math.abs(eig.values[0]!))
    const corr: [number, number, number] = [0, 0, 0]
    sym3SolveTikhonov(eig, rhsX, rhsY, rhsZ, lambdaReg, corr)
    return [mx + corr[0], my + corr[1], mz + corr[2]]
}

export interface SingleComponentFeatureContext {
    inferred: ComponentFeatureCpu
    explicitLineDist: number
    explicitRingDist: number
    explicitCornerDist: number
    explicitSeamDist: number
    explicitLineFeature: ComponentFeatureCpu
    explicitRingFeature: ComponentFeatureCpu
    explicitCornerFeature: ComponentFeatureCpu
    explicitSeamFeature: ComponentFeatureCpu
    compPlanePoint0: [number, number, number]
    compPlanePoint1: [number, number, number]
    compPlanePoint2: [number, number, number]
    isExplicitLine: boolean
    isExplicitCorner: boolean
    isExplicitSeam: boolean
}

/**
 * Build MDC-style inferred + explicit feature state for one DC cell with a
 * **single** iso component. Caller filters `crossings` to `compIdx === 0`.
 */
export function buildSingleComponentMdcFeatureContext(
    voxelSize: number,
    crossings: readonly CrossingMidInput[],
): SingleComponentFeatureContext | null {
    if (crossings.length === 0) return null

    let compPointSum: [number, number, number] = [0, 0, 0]
    let compCrossCount = 0
    let compOwnerPair0: [number, number] = [0, 0]
    let compOwnerPair1: [number, number] = [0, 0]
    let compOwnerPairCount = 0
    let compNormalBucketCount = 0
    const compNormalSums: [[number, number, number], [number, number, number], [number, number, number]] = [
        [0, 0, 0], [0, 0, 0], [0, 0, 0],
    ]
    const compPointSums: [[number, number, number], [number, number, number], [number, number, number]] = [
        [0, 0, 0], [0, 0, 0], [0, 0, 0],
    ]
    const compPointCounts = [0, 0, 0]
    let explicitLineDist = 1e9
    let explicitRingDist = 1e9
    let explicitCornerDist = 1e9
    let explicitSeamDist = 1e9
    let explicitLineFeature = zeroComponentFeatureCpu()
    let explicitRingFeature = zeroComponentFeatureCpu()
    let explicitCornerFeature = zeroComponentFeatureCpu()
    let explicitSeamFeature = zeroComponentFeatureCpu()
    let compHasRingSample = 0
    let compLatheMantleCrossCount = 0

    for (const cr of crossings) {
        const intersectionPos: [number, number, number] = [cr.px, cr.py, cr.pz]
        const normal: [number, number, number] = [cr.nx, cr.ny, cr.nz]
        const sample = cr.mid

        compPointSum[0] += cr.px
        compPointSum[1] += cr.py
        compPointSum[2] += cr.pz
        compCrossCount++

        if (sample.featureKind === MID_FEATURE_RING) compHasRingSample = 1
        if (sample.featureKind === MID_FEATURE_NONE && sample.featureNormalCount === MID_LATHE_MANTLE_NORMAL_COUNT) {
            compLatheMantleCrossCount++
        }

        const ownerPair: [number, number] = [sample.featureIdA, sample.featureIdB]
        if (ownerPair[0] !== 0 || ownerPair[1] !== 0) {
            if (compOwnerPairCount === 0) {
                compOwnerPair0 = ownerPair
                compOwnerPairCount = 1
            } else if (compOwnerPairCount === 1 && !ownerPairEqual(compOwnerPair0[0], compOwnerPair0[1], ownerPair[0], ownerPair[1])) {
                compOwnerPair1 = ownerPair
                compOwnerPairCount = 2
            }
        }

        const explicitIdsValid = sample.featureKind === MID_FEATURE_BOOLEAN_SEAM
            ? sample.featureIdA !== 0 && sample.featureIdB !== 0 && sample.featureIdA !== sample.featureIdB
            : sample.featureIdA !== 0

        const explicitNormalsValid = sample.featureKind === MID_FEATURE_CORNER
            ? sample.featureNormalCount === 3
            : sample.featureNormalCount === 2

        let explicitProxScale = MDC_FEATURE_PROX_SCALE
        if (sample.featureKind === MID_FEATURE_CORNER) explicitProxScale = MDC_CORNER_FEATURE_PROX_SCALE
        else if (sample.featureKind === MID_FEATURE_RING) explicitProxScale = MDC_RING_FEATURE_PROX_SCALE

        const seamDotOk = sample.featureKind !== MID_FEATURE_BOOLEAN_SEAM
            || dot3(sample.featureN1[0], sample.featureN1[1], sample.featureN1[2], sample.featureN2[0], sample.featureN2[1], sample.featureN2[2]) < MID_FEATURE_SEAM_COS_THRESH

        const explicitOk = sample.featureKind !== MID_FEATURE_NONE
            && sample.featureDist <= voxelSize * explicitProxScale
            && explicitIdsValid
            && explicitNormalsValid
            && seamDotOk

        if (explicitOk) {
            if (sample.featureKind === MID_FEATURE_LINE && sample.featureDist < explicitLineDist) {
                explicitLineDist = sample.featureDist
                explicitLineFeature = {
                    kind: MID_FEATURE_LINE,
                    ownerA: sample.featureIdA,
                    ownerB: sample.featureIdB,
                    normalCount: sample.featureNormalCount,
                    point: sample.featurePoint,
                    tangent: sample.featureTangent,
                    n0: normal,
                    n1: sample.featureN1,
                    n2: [0, 0, 0],
                    axisCenter: [0, 0, 0],
                }
            } else if (sample.featureKind === MID_FEATURE_RING && sample.featureDist < explicitRingDist) {
                explicitRingDist = sample.featureDist
                explicitRingFeature = {
                    kind: MID_FEATURE_RING,
                    ownerA: sample.featureIdA,
                    ownerB: sample.featureIdB,
                    normalCount: sample.featureNormalCount,
                    point: sample.featurePoint,
                    tangent: sample.featureTangent,
                    n0: normal,
                    n1: sample.featureN1,
                    n2: [0, 0, 0],
                    axisCenter: sample.featureAxisCenter,
                }
            } else if (sample.featureKind === MID_FEATURE_CORNER && sample.featureDist < explicitCornerDist) {
                explicitCornerDist = sample.featureDist
                explicitCornerFeature = {
                    kind: MID_FEATURE_CORNER,
                    ownerA: sample.featureIdA,
                    ownerB: sample.featureIdB,
                    normalCount: sample.featureNormalCount,
                    point: sample.featurePoint,
                    tangent: [0, 0, 0],
                    n0: normal,
                    n1: sample.featureN1,
                    n2: sample.featureN2,
                    axisCenter: [0, 0, 0],
                }
            } else if (sample.featureKind === MID_FEATURE_BOOLEAN_SEAM && sample.featureDist < explicitSeamDist) {
                explicitSeamDist = sample.featureDist
                explicitSeamFeature = {
                    kind: MID_FEATURE_BOOLEAN_SEAM,
                    ownerA: sample.featureIdA,
                    ownerB: sample.featureIdB,
                    normalCount: sample.featureNormalCount,
                    point: intersectionPos,
                    tangent: [0, 0, 0],
                    n0: sample.featureN1,
                    n1: sample.featureN2,
                    n2: [0, 0, 0],
                    axisCenter: [0, 0, 0],
                }
            }
        }

        let bucket = -1
        let bestBucket = 0
        let bestDot = -2
        for (let j = 0; j < compNormalBucketCount; j++) {
            const rep = safeUnit3(compNormalSums[j]![0], compNormalSums[j]![1], compNormalSums[j]![2])
            const repDot = dot3(rep[0], rep[1], rep[2], normal[0], normal[1], normal[2])
            if (repDot > COMPONENT_NORMAL_COS_THRESH) {
                bucket = j
                break
            }
            if (repDot > bestDot) {
                bestDot = repDot
                bestBucket = j
            }
        }
        if (bucket < 0) {
            if (compNormalBucketCount < 3) {
                bucket = compNormalBucketCount
                compNormalBucketCount++
            } else {
                bucket = bestBucket
            }
        }
        const bucketIdx = bucket
        compNormalSums[bucketIdx]![0] += normal[0]
        compNormalSums[bucketIdx]![1] += normal[1]
        compNormalSums[bucketIdx]![2] += normal[2]
        compPointSums[bucketIdx]![0] += intersectionPos[0]
        compPointSums[bucketIdx]![1] += intersectionPos[1]
        compPointSums[bucketIdx]![2] += intersectionPos[2]
        compPointCounts[bucketIdx]++
    }

    const invCc = 1 / compCrossCount
    const massPoint: [number, number, number] = [
        compPointSum[0] * invCc,
        compPointSum[1] * invCc,
        compPointSum[2] * invCc,
    ]

    const bucketCount = compNormalBucketCount
    const pairCount = compOwnerPairCount

    let n0 = [0, 0, 0] as [number, number, number]
    let n1 = [0, 0, 0] as [number, number, number]
    let n2 = [0, 0, 0] as [number, number, number]
    let p0 = massPoint
    let p1 = massPoint
    let p2 = massPoint
    if (bucketCount >= 1 && compPointCounts[0]! > 0) {
        n0 = safeUnit3(compNormalSums[0]![0], compNormalSums[0]![1], compNormalSums[0]![2])
        const inv = 1 / compPointCounts[0]!
        p0 = [compPointSums[0]![0] * inv, compPointSums[0]![1] * inv, compPointSums[0]![2] * inv]
    }
    if (bucketCount >= 2 && compPointCounts[1]! > 0) {
        n1 = safeUnit3(compNormalSums[1]![0], compNormalSums[1]![1], compNormalSums[1]![2])
        const inv = 1 / compPointCounts[1]!
        p1 = [compPointSums[1]![0] * inv, compPointSums[1]![1] * inv, compPointSums[1]![2] * inv]
    }
    if (bucketCount >= 3 && compPointCounts[2]! > 0) {
        n2 = safeUnit3(compNormalSums[2]![0], compNormalSums[2]![1], compNormalSums[2]![2])
        const inv = 1 / compPointCounts[2]!
        p2 = [compPointSums[2]![0] * inv, compPointSums[2]![1] * inv, compPointSums[2]![2] * inv]
    }

    const compPlanePoint0 = p0
    const compPlanePoint1 = p1
    const compPlanePoint2 = p2

    const seamEligible = pairCount >= 2
        && compOwnerPair0[0] === compOwnerPair0[1]
        && compOwnerPair1[0] === compOwnerPair1[1]
        && compOwnerPair0[0] !== compOwnerPair1[0]

    let inferred = zeroComponentFeatureCpu()

    if (explicitCornerDist < 1e8) {
        inferred = { ...explicitCornerFeature }
    } else if (explicitRingDist < 1e8) {
        inferred = { ...explicitRingFeature }
    } else if (explicitLineDist < 1e8) {
        inferred = { ...explicitLineFeature }
    } else if (explicitSeamDist < 1e8) {
        inferred = { ...explicitSeamFeature }
    } else if (seamEligible && bucketCount >= 2) {
        const tangent = cross3(n0[0], n0[1], n0[2], n1[0], n1[1], n1[2])
        if (length3(tangent[0], tangent[1], tangent[2]) > 1e-8) {
            const tangU = safeUnit3(tangent[0], tangent[1], tangent[2])
            const owners = orderedOwnerPair(compOwnerPair0[0], compOwnerPair1[0])
            const fp = solveFeaturePointCpu(n0, p0, n1, p1, tangU, massPoint, 3)
            inferred = {
                kind: MID_FEATURE_BOOLEAN_SEAM,
                ownerA: owners[0],
                ownerB: owners[1],
                normalCount: 2,
                point: fp,
                tangent: tangU,
                n0,
                n1,
                n2: [0, 0, 0],
                axisCenter: [0, 0, 0],
            }
        } else {
            inferred = {
                kind: COMPONENT_FEATURE_REJECTED,
                ownerA: compOwnerPair0[0],
                ownerB: compOwnerPair1[0],
                normalCount: 2,
                point: massPoint,
                tangent: [0, 0, 0],
                n0,
                n1,
                n2: [0, 0, 0],
                axisCenter: [0, 0, 0],
            }
        }
    } else if (
        compHasRingSample === 0
        && compLatheMantleCrossCount !== compCrossCount
        && bucketCount === 2
        && dot3(n0[0], n0[1], n0[2], n1[0], n1[1], n1[2]) < MDC_INFER_LINE_DOT_MAX
        && compPointCounts[0]! >= MDC_INFER_LINE_MIN_BUCKET_SAMPLES
        && compPointCounts[1]! >= MDC_INFER_LINE_MIN_BUCKET_SAMPLES
        && length3(compNormalSums[0]![0], compNormalSums[0]![1], compNormalSums[0]![2]) >= MDC_INFER_LINE_BUCKET_COHERENCE * compPointCounts[0]!
        && length3(compNormalSums[1]![0], compNormalSums[1]![1], compNormalSums[1]![2]) >= MDC_INFER_LINE_BUCKET_COHERENCE * compPointCounts[1]!
    ) {
        const tangent = cross3(n0[0], n0[1], n0[2], n1[0], n1[1], n1[2])
        if (length3(tangent[0], tangent[1], tangent[2]) > 1e-8) {
            const tangU = safeUnit3(tangent[0], tangent[1], tangent[2])
            const fp = solveFeaturePointCpu(n0, p0, n1, p1, tangU, massPoint, 3)
            inferred = {
                kind: MID_FEATURE_LINE,
                ownerA: compOwnerPair0[0],
                ownerB: compOwnerPair0[1],
                normalCount: 2,
                point: fp,
                tangent: tangU,
                n0,
                n1,
                n2: [0, 0, 0],
                axisCenter: [0, 0, 0],
            }
        } else {
            inferred = {
                kind: COMPONENT_FEATURE_REJECTED,
                ownerA: compOwnerPair0[0],
                ownerB: compOwnerPair0[1],
                normalCount: 2,
                point: massPoint,
                tangent: [0, 0, 0],
                n0,
                n1,
                n2: [0, 0, 0],
                axisCenter: [0, 0, 0],
            }
        }
    }

    const isExplicitLine = inferred.kind === MID_FEATURE_LINE && explicitLineDist < 1e8
    const isExplicitCorner = inferred.kind === MID_FEATURE_CORNER && explicitCornerDist < 1e8
    const isExplicitSeam = inferred.kind === MID_FEATURE_BOOLEAN_SEAM && explicitSeamDist < 1e8

    return {
        inferred,
        explicitLineDist,
        explicitRingDist,
        explicitCornerDist,
        explicitSeamDist,
        explicitLineFeature,
        explicitRingFeature,
        explicitCornerFeature,
        explicitSeamFeature,
        compPlanePoint0,
        compPlanePoint1,
        compPlanePoint2,
        isExplicitLine,
        isExplicitCorner,
        isExplicitSeam,
    }
}
