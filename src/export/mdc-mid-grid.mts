/**
 * CPU-side packed `sceneSDF_mid` samples read back from `sample_grid.wgsl`
 * (`midFeatureOut`). Layout must stay byte-for-byte aligned with the shader pack.
 */

export interface ComponentFeatureCpu {
    kind: number
    ownerA: number
    ownerB: number
    normalCount: number
    point: readonly [number, number, number]
    tangent: readonly [number, number, number]
    n0: readonly [number, number, number]
    n1: readonly [number, number, number]
    n2: readonly [number, number, number]
    axisCenter: readonly [number, number, number]
}

/** Matches `hg_sdf.wgsl` — keep aligned with WGSL. */
export const MID_FEATURE_NONE = 0
export const MID_FEATURE_LINE = 1
export const MID_FEATURE_CORNER = 2
export const MID_FEATURE_BOOLEAN_SEAM = 3
export const MID_FEATURE_RING = 4
export const COMPONENT_FEATURE_REJECTED = 5
export const MID_LATHE_MANTLE_NORMAL_COUNT = 5
export const MID_FEATURE_SEAM_COS_THRESH = 0.9659258

/** vec4 slots per voxel in `midFeatureOut`. */
export const MID_GRID_VEC4_STRIDE = 7

export interface SdfMidSampleCpu {
    featureKind: number
    featureDist: number
    featureIdA: number
    featureIdB: number
    featureNormalCount: number
    d: number
    g: number
    featurePoint: [number, number, number]
    featureTangent: [number, number, number]
    featureN1: [number, number, number]
    featureN2: [number, number, number]
    featureAxisCenter: [number, number, number]
}

export function zeroComponentFeatureCpu(): ComponentFeatureCpu {
    const z = [0, 0, 0] as const
    return {
        kind: MID_FEATURE_NONE,
        ownerA: 0,
        ownerB: 0,
        normalCount: 0,
        point: z,
        tangent: z,
        n0: z,
        n1: z,
        n2: z,
        axisCenter: z,
    }
}

function readU32FromF32Array(arr: Float32Array<ArrayBuffer>, floatIndex: number): number {
    const u = new Uint32Array(arr.buffer, arr.byteOffset + floatIndex * 4, 1)
    return u[0]!
}

/** Decode one voxel's packed mid sample from `grid.midFeature`. */
export function decodeMidGridSample(gridMid: Float32Array<ArrayBuffer>, voxelIdx: number): SdfMidSampleCpu {
    const baseFloat = voxelIdx * MID_GRID_VEC4_STRIDE * 4
    const rk = readU32FromF32Array(gridMid, baseFloat + 0)
    const featureDist = gridMid[baseFloat + 1]!
    const featureIdA = readU32FromF32Array(gridMid, baseFloat + 2)
    const featureIdB = readU32FromF32Array(gridMid, baseFloat + 3)

    const featureNormalCount = readU32FromF32Array(gridMid, baseFloat + 4)
    const d = gridMid[baseFloat + 5]!
    const g = gridMid[baseFloat + 6]!

    const fp: [number, number, number] = [gridMid[baseFloat + 8]!, gridMid[baseFloat + 9]!, gridMid[baseFloat + 10]!]
    const ft: [number, number, number] = [gridMid[baseFloat + 12]!, gridMid[baseFloat + 13]!, gridMid[baseFloat + 14]!]
    const fn1: [number, number, number] = [gridMid[baseFloat + 16]!, gridMid[baseFloat + 17]!, gridMid[baseFloat + 18]!]
    const fn2: [number, number, number] = [gridMid[baseFloat + 20]!, gridMid[baseFloat + 21]!, gridMid[baseFloat + 22]!]
    const fac: [number, number, number] = [gridMid[baseFloat + 24]!, gridMid[baseFloat + 25]!, gridMid[baseFloat + 26]!]

    return {
        featureKind: rk,
        featureDist,
        featureIdA,
        featureIdB,
        featureNormalCount,
        d,
        g,
        featurePoint: fp,
        featureTangent: ft,
        featureN1: fn1,
        featureN2: fn2,
        featureAxisCenter: fac,
    }
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t
}

function lerp3(
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    t: number,
): [number, number, number] {
    return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]
}

/** Linear blend of continuous mid fields along a cube edge; discrete fields follow the endpoint with smaller `featureDist`. */
export function interpMidSampleAlongEdge(a: SdfMidSampleCpu, b: SdfMidSampleCpu, t: number): SdfMidSampleCpu {
    const pickA = a.featureDist <= b.featureDist
    const kind = pickA ? a.featureKind : b.featureKind
    const idA = pickA ? a.featureIdA : b.featureIdA
    const idB = pickA ? a.featureIdB : b.featureIdB
    const normCount = pickA ? a.featureNormalCount : b.featureNormalCount
    return {
        featureKind: kind,
        featureDist: lerp(a.featureDist, b.featureDist, t),
        featureIdA: idA,
        featureIdB: idB,
        featureNormalCount: normCount,
        d: lerp(a.d, b.d, t),
        g: lerp(a.g, b.g, t),
        featurePoint: lerp3(a.featurePoint, b.featurePoint, t),
        featureTangent: lerp3(a.featureTangent, b.featureTangent, t),
        featureN1: lerp3(a.featureN1, b.featureN1, t),
        featureN2: lerp3(a.featureN2, b.featureN2, t),
        featureAxisCenter: lerp3(a.featureAxisCenter, b.featureAxisCenter, t),
    }
}

export function midSampleToComponentFeature(s: SdfMidSampleCpu, n: readonly [number, number, number]): ComponentFeatureCpu {
    return {
        kind: s.featureKind,
        ownerA: s.featureIdA,
        ownerB: s.featureIdB,
        normalCount: s.featureNormalCount,
        point: s.featurePoint,
        tangent: s.featureTangent,
        n0: n,
        n1: s.featureN1,
        n2: s.featureN2,
        axisCenter: s.featureAxisCenter,
    }
}
