import type { AscVoxelGrid } from "./asc-core/data-grid.mjs"

export const ASC_HERMITE_VERTEX_STRIDE_F32 = 8

type Vec3 = [number, number, number]

interface HermiteSample {
    key: string
    p: Vec3
    n: Vec3
}

export interface AscHermiteQefOptions {
    originX: number
    originY: number
    originZ: number
    scaleX: number
    scaleY: number
    scaleZ: number
    /** Pairwise normal dot below this is considered a sharp feature. Default cos(35deg). */
    featureNormalDot?: number
    /** Reject QEF moves larger than this many voxels. */
    maxMoveVoxels?: number
}

const CUBE_CORNERS: readonly Vec3[] = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [1, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [0, 1, 1],
    [1, 1, 1],
]

const CUBE_EDGES: readonly [number, number][] = [
    [0, 1],
    [2, 3],
    [4, 5],
    [6, 7],
    [0, 2],
    [1, 3],
    [4, 6],
    [5, 7],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
]

function clamp(x: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, x))
}

function dot(a: Vec3, b: Vec3): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function len(v: Vec3): number {
    return Math.hypot(v[0], v[1], v[2])
}

function normalize(v: Vec3): Vec3 | null {
    const l = len(v)
    if (!Number.isFinite(l) || l < 1e-12) return null
    return [v[0] / l, v[1] / l, v[2] / l]
}

function cornerKey(grid: AscVoxelGrid, x: number, y: number, z: number): number {
    return z * grid.width * grid.depth + y * grid.width + x
}

function sampleTrilinear(grid: AscVoxelGrid, x: number, y: number, z: number): number {
    const gx = clamp(x, 0, grid.width - 1)
    const gy = clamp(y, 0, grid.depth - 1)
    const gz = clamp(z, 0, grid.height - 1)
    const x0 = Math.floor(gx)
    const y0 = Math.floor(gy)
    const z0 = Math.floor(gz)
    const x1 = Math.min(grid.width - 1, x0 + 1)
    const y1 = Math.min(grid.depth - 1, y0 + 1)
    const z1 = Math.min(grid.height - 1, z0 + 1)
    const tx = gx - x0
    const ty = gy - y0
    const tz = gz - z0
    const v000 = grid.valueAt(x0, y0, z0)
    const v100 = grid.valueAt(x1, y0, z0)
    const v010 = grid.valueAt(x0, y1, z0)
    const v110 = grid.valueAt(x1, y1, z0)
    const v001 = grid.valueAt(x0, y0, z1)
    const v101 = grid.valueAt(x1, y0, z1)
    const v011 = grid.valueAt(x0, y1, z1)
    const v111 = grid.valueAt(x1, y1, z1)
    const x00 = v000 + (v100 - v000) * tx
    const x10 = v010 + (v110 - v010) * tx
    const x01 = v001 + (v101 - v001) * tx
    const x11 = v011 + (v111 - v011) * tx
    const y0v = x00 + (x10 - x00) * ty
    const y1v = x01 + (x11 - x01) * ty
    return y0v + (y1v - y0v) * tz
}

function normalAtGridPoint(grid: AscVoxelGrid, x: number, y: number, z: number, sx: number, sy: number, sz: number): Vec3 | null {
    const eps = 0.5
    const dx = (sampleTrilinear(grid, x + eps, y, z) - sampleTrilinear(grid, x - eps, y, z)) / (2 * eps * sx)
    const dy = (sampleTrilinear(grid, x, y + eps, z) - sampleTrilinear(grid, x, y - eps, z)) / (2 * eps * sy)
    const dz = (sampleTrilinear(grid, x, y, z + eps) - sampleTrilinear(grid, x, y, z - eps)) / (2 * eps * sz)
    return normalize([dx, dy, dz])
}

function collectCellSamples(
    grid: AscVoxelGrid,
    cellX: number,
    cellY: number,
    cellZ: number,
    opts: AscHermiteQefOptions,
): HermiteSample[] {
    if (cellX < 0 || cellY < 0 || cellZ < 0 || cellX >= grid.width - 1 || cellY >= grid.depth - 1 || cellZ >= grid.height - 1) {
        return []
    }

    const values = CUBE_CORNERS.map(([x, y, z]) => grid.valueAt(cellX + x, cellY + y, cellZ + z) - grid.threshold)
    const samples: HermiteSample[] = []
    for (const [a, b] of CUBE_EDGES) {
        const va = values[a]!
        const vb = values[b]!
        if ((va < 0 && vb < 0) || (va >= 0 && vb >= 0) || va === vb) continue
        const ca = CUBE_CORNERS[a]!
        const cb = CUBE_CORNERS[b]!
        const t = clamp(-va / (vb - va), 0, 1)
        const gx = cellX + ca[0] + (cb[0] - ca[0]) * t
        const gy = cellY + ca[1] + (cb[1] - ca[1]) * t
        const gz = cellZ + ca[2] + (cb[2] - ca[2]) * t
        const n = normalAtGridPoint(grid, gx, gy, gz, opts.scaleX, opts.scaleY, opts.scaleZ)
        if (!n) continue
        const ka = cornerKey(grid, cellX + ca[0], cellY + ca[1], cellZ + ca[2])
        const kb = cornerKey(grid, cellX + cb[0], cellY + cb[1], cellZ + cb[2])
        samples.push({
            key: ka < kb ? `${ka}:${kb}` : `${kb}:${ka}`,
            p: [
                opts.originX + gx * opts.scaleX,
                opts.originY + gy * opts.scaleY,
                opts.originZ + gz * opts.scaleZ,
            ],
            n,
        })
    }
    return samples
}

function hasSharpNormalSet(samples: readonly HermiteSample[], featureDot: number): boolean {
    for (let i = 0; i < samples.length; i++) {
        for (let j = i + 1; j < samples.length; j++) {
            if (Math.abs(dot(samples[i]!.n, samples[j]!.n)) < featureDot) return true
        }
    }
    return false
}

function qefCost(ata: Float64Array, atb: Vec3, x: Vec3): number {
    const ax: Vec3 = [
        ata[0]! * x[0] + ata[1]! * x[1] + ata[2]! * x[2],
        ata[3]! * x[0] + ata[4]! * x[1] + ata[5]! * x[2],
        ata[6]! * x[0] + ata[7]! * x[1] + ata[8]! * x[2],
    ]
    return dot(x, ax) - 2 * dot(x, atb)
}

function solve3x3(a: Float64Array, b: Vec3): Vec3 | null {
    const m00 = a[0]!, m01 = a[1]!, m02 = a[2]!
    const m10 = a[3]!, m11 = a[4]!, m12 = a[5]!
    const m20 = a[6]!, m21 = a[7]!, m22 = a[8]!
    const det =
        m00 * (m11 * m22 - m12 * m21) -
        m01 * (m10 * m22 - m12 * m20) +
        m02 * (m10 * m21 - m11 * m20)
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null
    const invDet = 1 / det
    const x =
        (b[0] * (m11 * m22 - m12 * m21) -
            m01 * (b[1] * m22 - m12 * b[2]) +
            m02 * (b[1] * m21 - m11 * b[2])) * invDet
    const y =
        (m00 * (b[1] * m22 - m12 * b[2]) -
            b[0] * (m10 * m22 - m12 * m20) +
            m02 * (m10 * b[2] - b[1] * m20)) * invDet
    const z =
        (m00 * (m11 * b[2] - b[1] * m21) -
            m01 * (m10 * b[2] - b[1] * m20) +
            b[0] * (m10 * m21 - m11 * m20)) * invDet
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
    return [x, y, z]
}

function solveQef(samples: readonly HermiteSample[], current: Vec3): Vec3 | null {
    const ata = new Float64Array(9)
    const atb: Vec3 = [0, 0, 0]
    const mass: Vec3 = [0, 0, 0]
    for (const { p, n } of samples) {
        ata[0] += n[0] * n[0]
        ata[1] += n[0] * n[1]
        ata[2] += n[0] * n[2]
        ata[3] += n[1] * n[0]
        ata[4] += n[1] * n[1]
        ata[5] += n[1] * n[2]
        ata[6] += n[2] * n[0]
        ata[7] += n[2] * n[1]
        ata[8] += n[2] * n[2]
        const np = dot(n, p)
        atb[0] += n[0] * np
        atb[1] += n[1] * np
        atb[2] += n[2] * np
        mass[0] += p[0]
        mass[1] += p[1]
        mass[2] += p[2]
    }
    mass[0] /= samples.length
    mass[1] /= samples.length
    mass[2] /= samples.length

    const reg = Math.max(1e-8, samples.length * 1e-4)
    ata[0] += reg
    ata[4] += reg
    ata[8] += reg
    const b: Vec3 = [atb[0] + mass[0] * reg, atb[1] + mass[1] * reg, atb[2] + mass[2] * reg]
    const solved = solve3x3(ata, b)
    if (!solved) return null
    return qefCost(ata, b, solved) <= qefCost(ata, b, current) ? solved : null
}

/**
 * Hermite QEF vertex pass for vertices `[viStart, viEnd)` (half-open). Disjoint ranges are race-free.
 */
export function applyAscHermiteQefVertexRange(
    verts: Float32Array,
    grid: AscVoxelGrid,
    opts: AscHermiteQefOptions,
    featureDot: number,
    maxMove: number,
    viStart: number,
    viEnd: number,
): number {
    const vi0 = Math.max(0, viStart | 0)
    const vi1 = Math.min((verts.length / ASC_HERMITE_VERTEX_STRIDE_F32) | 0, viEnd | 0)
    let movedVertices = 0
    for (let vi = vi0; vi < vi1; vi++) {
        const b = vi * ASC_HERMITE_VERTEX_STRIDE_F32
        const current: Vec3 = [verts[b]!, verts[b + 1]!, verts[b + 2]!]
        const gx = (current[0] - opts.originX) / opts.scaleX
        const gy = (current[1] - opts.originY) / opts.scaleY
        const gz = (current[2] - opts.originZ) / opts.scaleZ
        if (!Number.isFinite(gx) || !Number.isFinite(gy) || !Number.isFinite(gz)) continue

        const x0 = Math.floor(gx)
        const y0 = Math.floor(gy)
        const z0 = Math.floor(gz)
        const unique = new Map<string, HermiteSample>()
        for (let z = z0 - 1; z <= z0; z++) {
            for (let y = y0 - 1; y <= y0; y++) {
                for (let x = x0 - 1; x <= x0; x++) {
                    for (const sample of collectCellSamples(grid, x, y, z, opts)) {
                        unique.set(sample.key, sample)
                    }
                }
            }
        }

        const samples = [...unique.values()]
        if (samples.length < 3 || !hasSharpNormalSet(samples, featureDot)) continue
        const qef = solveQef(samples, current)
        if (!qef) continue
        const dx = qef[0] - current[0]
        const dy = qef[1] - current[1]
        const dz = qef[2] - current[2]
        if (Math.hypot(dx, dy, dz) > maxMove) continue

        verts[b] = qef[0]
        verts[b + 1] = qef[1]
        verts[b + 2] = qef[2]
        const n = normalAtGridPoint(
            grid,
            (qef[0] - opts.originX) / opts.scaleX,
            (qef[1] - opts.originY) / opts.scaleY,
            (qef[2] - opts.originZ) / opts.scaleZ,
            opts.scaleX,
            opts.scaleY,
            opts.scaleZ,
        )
        if (n) {
            verts[b + 4] = n[0]
            verts[b + 5] = n[1]
            verts[b + 6] = n[2]
        }
        movedVertices++
    }
    return movedVertices
}
