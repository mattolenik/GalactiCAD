/**
 * CPU octree for iso-simplicial export (`TNode` / `TNode::eval` from
 * docs/reference_impl/isosurf/isosurf/iso_method_ours.{h,cpp}).
 *
 * - Corner lattice, `changesSign`, `badqef`, depth caps, and `is_outside` match the reference.
 * - Hermite / QEF samples use {@link IsoOctreeBuildParams.sample} only — **no** transpiled scene
 *   evaluation on the CPU.
 * - Vertex storage is **normalized** to the cubic root AABB `[0,1]³`; `sample` receives **world**
 *   coordinates so GPU `sceneSDF` matches other export paths.
 */

import { IsoSimplicialConstants } from "./constants.mjs"
import {
    computeDualVertexCube,
    computeDualVertexEdge,
    computeDualVertexFace,
    encodeCubeHermitePlane,
    encodeEdgeHermitePlane,
    encodeFaceHermitePlane,
} from "./dual-vertex-qef.mjs"
import { cubeCornerIndex, cubeEdge2Orient, cubeEdge2Vert, cubeFace2Orient, cubeFace2Vert } from "./cube-tables.mjs"
import { qefAccumulatePlane, zeroQefPacked } from "./qef-normal.mjs"
import type { IsoSampleBatch } from "./iso-sample-batch.mjs"

/** One `vec4f` per logical slot: corners 8, edges 12, faces 6, cell body 1. */
export interface IsoOctreeNode {
    verts: Float32Array
    edges: Float32Array
    faces: Float32Array
    node: Float32Array
    children: (IsoOctreeNode | null)[]
}

export interface IsoOctreeBounds {
    min: readonly [number, number, number]
    max: readonly [number, number, number]
}

export type IsoOctreeBatchFn = (
    positions: Float32Array,
    signal?: AbortSignal,
) => Promise<Float32Array>

export interface IsoOctreeBuildConstantsOverrides {
    oversampleQef?: number
    dualVertexBorderFraction?: number
    depthMin?: number
    depthMax?: number
    findRootDepth?: number
    qefRelativeErrorRefineThreshold?: number
}

export interface IsoOctreeBuildParams {
    sample: IsoOctreeBatchFn
    bounds: IsoOctreeBounds
    signal?: AbortSignal
    constants?: IsoOctreeBuildConstantsOverrides
}

/** Mutable copy of {@link IsoSimplicialConstants} for runtime overrides. */
export interface IsoOctreeRuntimeConstants {
    oversampleQef: number
    dualVertexBorderFraction: number
    depthMin: number
    depthMax: number
    findRootDepth: number
    qefRelativeErrorRefineThreshold: number
}

function mergeConstants(p?: IsoOctreeBuildConstantsOverrides): IsoOctreeRuntimeConstants {
    return { ...IsoSimplicialConstants, ...(p ?? {}) }
}

function assertCubicBounds(min: readonly [number, number, number], max: readonly [number, number, number], eps = 1e-5): void {
    const dx = max[0] - min[0]
    const dy = max[1] - min[1]
    const dz = max[2] - min[2]
    if (Math.abs(dx - dy) > eps || Math.abs(dx - dz) > eps) {
        throw new Error("IsoOctree.build: bounds must be a cube (equal edge lengths)")
    }
}

function readV4(buf: Float32Array, cornerIndex: number): [number, number, number, number] {
    const o = cornerIndex * 4
    return [buf[o]!, buf[o + 1]!, buf[o + 2]!, buf[o + 3]!]
}

function writeV4(buf: Float32Array, cornerIndex: number, x: number, y: number, z: number, w: number): void {
    const o = cornerIndex * 4
    buf[o] = x
    buf[o + 1] = y
    buf[o + 2] = z
    buf[o + 3] = w
}

function signScalar(d: number): number {
    return d < 0 ? -1 : 1
}

/** Reference `TNode::changesSign` (iso_method_ours.cpp). */
export function isoOctreeChangesSign(
    verts: Float32Array,
    edges: Float32Array,
    faces: Float32Array,
    node: Float32Array,
): boolean {
    const s0 = signScalar(verts[3])
    for (let i = 1; i < 8; i++) {
        if (signScalar(verts[i * 4 + 3]) !== s0) return true
    }
    for (let i = 1; i < 6; i++) {
        if (signScalar(faces[i * 4 + 3]) !== s0) return true
    }
    for (let i = 1; i < 12; i++) {
        if (signScalar(edges[i * 4 + 3]) !== s0) return true
    }
    if (signScalar(node[3]) !== s0) return true
    return false
}

/** Reference `TNode::is_outside` — uses corners 0 and 7 (normalized cell). */
export function isoOctreeIsOutside(verts: Float32Array): boolean {
    const dx = verts[7 * 4] - verts[0]
    if (dx >= 1.5) return false
    const mine = [verts[0]!, verts[1]!, verts[2]!]
    const maxe = [verts[7 * 4]!, verts[7 * 4 + 1]!, verts[7 * 4 + 2]!]
    for (let i = 0; i < 3; i++) {
        if (mine[i]! < 0 || maxe[i]! > 1) return true
    }
    return false
}

function indexBits(v: number): { x: 0 | 1; y: 0 | 1; z: 0 | 1 } {
    return { x: (v & 1) as 0 | 1, y: ((v >> 1) & 1) as 0 | 1, z: ((v >> 2) & 1) as 0 | 1 }
}

/** Reference `TNode::eval` 3×3×3 trilinear stencil (`x,y,z` ∈ {0,1,2}). */
function trilinearP8(verts: Float32Array, x: number, y: number, z: number, out: Float32Array, outOff: number): void {
    const w = (i0: 0 | 1, i1: 0 | 1, i2: 0 | 1, wx: number, wy: number, wz: number) => {
        const vi = cubeCornerIndex(i0, i1, i2)
        const o = vi * 4
        const f = wx * wy * wz * 0.125
        out[outOff] += verts[o]! * f
        out[outOff + 1] += verts[o + 1]! * f
        out[outOff + 2] += verts[o + 2]! * f
        out[outOff + 3] += verts[o + 3]! * f
    }
    out[outOff] = 0
    out[outOff + 1] = 0
    out[outOff + 2] = 0
    out[outOff + 3] = 0
    w(0, 0, 0, 2 - x, 2 - y, 2 - z)
    w(0, 0, 1, 2 - x, 2 - y, z)
    w(0, 1, 0, 2 - x, y, 2 - z)
    w(0, 1, 1, 2 - x, y, z)
    w(1, 0, 0, x, 2 - y, 2 - z)
    w(1, 0, 1, x, 2 - y, z)
    w(1, 1, 0, x, y, 2 - z)
    w(1, 1, 1, x, y, z)
}

/** Adapter: {@link IsoSampleBatch.run} → {@link IsoOctreeBatchFn}. */
export function createIsoOctreeSampleFn(
    batch: IsoSampleBatch,
    isoSampleBatchShaderModule: GPUShaderModule,
): IsoOctreeBatchFn {
    return async (positions, signal) => {
        const { sdf } = await batch.run(
            isoSampleBatchShaderModule,
            positions as Float32Array<ArrayBuffer>,
            { signal },
        )
        return sdf
    }
}

function normToWorld(
    nx: number,
    ny: number,
    nz: number,
    rootMin: readonly [number, number, number],
    rootMax: readonly [number, number, number],
    out: Float32Array,
    outOff: number,
): void {
    for (let a = 0; a < 3; a++) {
        const c = a === 0 ? nx : a === 1 ? ny : nz
        out[outOff + a] = rootMin[a]! + c * (rootMax[a]! - rootMin[a]!)
    }
}

function packWorldFromNorm4(normPts: Float32Array, count: number, rootMin: readonly [number, number, number], rootMax: readonly [number, number, number]): Float32Array {
    const world = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
        normToWorld(normPts[i * 4]!, normPts[i * 4 + 1]!, normPts[i * 4 + 2]!, rootMin, rootMax, world, i * 3)
    }
    return world
}

export class IsoOctree {
    readonly root: IsoOctreeNode
    /** Cells that ran Hermite+QEF (`tree_cells` in reference). */
    readonly treeCellCount: number

    private constructor(root: IsoOctreeNode, treeCellCount: number) {
        this.root = root
        this.treeCellCount = treeCellCount
    }

    static async build(params: IsoOctreeBuildParams): Promise<IsoOctree> {
        assertCubicBounds(params.bounds.min, params.bounds.max)
        const C = mergeConstants(params.constants)
        const rootMin = params.bounds.min
        const rootMax = params.bounds.max
        const sample = params.sample
        const signal = params.signal

        const root = createEmptyNode()
        for (let i = 0; i < 8; i++) {
            const b = indexBits(i)
            writeV4(root.verts, i, b.x, b.y, b.z, 0)
        }

        const cornerWorld = packWorldFromNorm4(root.verts, 8, rootMin, rootMax)
        const cornerSdf = await sample(cornerWorld, signal)
        const gradCorners = new Float32Array(24)
        for (let i = 0; i < 8; i++) {
            root.verts[i * 4 + 3] = cornerSdf[i * 4 + 3]!
            gradCorners[i * 3] = cornerSdf[i * 4]!
            gradCorners[i * 3 + 1] = cornerSdf[i * 4 + 1]!
            gradCorners[i * 3 + 2] = cornerSdf[i * 4 + 2]!
        }

        const counter = { n: 0 }

        await evalNode(root, gradCorners, rootMin, rootMax, C, sample, signal, counter)

        return new IsoOctree(root, counter.n)
    }
}

function createEmptyNode(): IsoOctreeNode {
    return {
        verts: new Float32Array(32),
        edges: new Float32Array(48),
        faces: new Float32Array(24),
        node: new Float32Array(4),
        children: new Array(8).fill(null),
    }
}

function gridGradient(
    px: number,
    py: number,
    pz: number,
    gradParent: Float32Array,
    midToBatch: Map<number, number>,
    midSdf: Float32Array,
): [number, number, number] {
    const idxFlat = (px * 3 + py) * 3 + pz
    if (px === 1 || py === 1 || pz === 1) {
        const bi = midToBatch.get(idxFlat)
        if (bi === undefined) throw new Error("iso-octree: missing midpoint batch index")
        const o = bi * 4
        return [midSdf[o]!, midSdf[o + 1]!, midSdf[o + 2]!]
    }
    const ix = px >> 1
    const iy = py >> 1
    const iz = pz >> 1
    const gi = cubeCornerIndex(ix as 0 | 1, iy as 0 | 1, iz as 0 | 1)
    const o = gi * 3
    return [gradParent[o]!, gradParent[o + 1]!, gradParent[o + 2]!]
}

async function evalNode(
    node: IsoOctreeNode,
    gradCorners: Float32Array,
    rootMin: readonly [number, number, number],
    rootMax: readonly [number, number, number],
    C: IsoOctreeRuntimeConstants,
    sample: IsoOctreeBatchFn,
    signal: AbortSignal | undefined,
    counter: { n: number },
): Promise<void> {
    counter.n++

    const v0 = readV4(node.verts, 0)
    const v7 = readV4(node.verts, 7)
    const O = C.oversampleQef
    const nodeCount = (O + 1) ** 3
    const edgeSamples = O + 1
    const faceSamples = (O + 1) ** 2
    const totalPhase1 = nodeCount + 12 * edgeSamples + 6 * faceSamples

    const normPts = new Float32Array(totalPhase1 * 4)
    let pi = 0

    const nodeOff = 0
    for (let x = 0; x <= O; x++) {
        for (let y = 0; y <= O; y++) {
            for (let z = 0; z <= O; z++) {
                normPts[pi * 4] = (1 - x / O) * v0[0] + (x / O) * v7[0]
                normPts[pi * 4 + 1] = (1 - y / O) * v0[1] + (y / O) * v7[1]
                normPts[pi * 4 + 2] = (1 - z / O) * v0[2] + (z / O) * v7[2]
                pi++
            }
        }
    }

    const edgeOffs: number[] = []
    for (let e = 0; e < 12; e++) {
        edgeOffs.push(pi)
        const xi = cubeEdge2Orient[e]! as 0 | 1 | 2
        const yi = ((xi + 1) % 3) as 0 | 1 | 2
        const zi = ((xi + 2) % 3) as 0 | 1 | 2
        const ec0 = readV4(node.verts, cubeEdge2Vert[e]![0]!)
        const ec1 = readV4(node.verts, cubeEdge2Vert[e]![1]!)
        for (let i = 0; i <= O; i++) {
            const p4: [number, number, number] = [0, 0, 0]
            p4[xi] = (1 - i / O) * ec0[xi] + (i / O) * ec1[xi]
            p4[yi] = ec0[yi]
            p4[zi] = ec0[zi]
            normPts[pi * 4] = p4[0]!
            normPts[pi * 4 + 1] = p4[1]!
            normPts[pi * 4 + 2] = p4[2]!
            pi++
        }
    }

    const faceOffs: number[] = []
    for (let f = 0; f < 6; f++) {
        faceOffs.push(pi)
        const orient = cubeFace2Orient[f]!
        const xi = ((orient + 1) % 3) as 0 | 1 | 2
        const yi = ((orient + 2) % 3) as 0 | 1 | 2
        const zi = orient as 0 | 1 | 2
        const fc0 = readV4(node.verts, cubeFace2Vert[f]![0]!)
        const fc2 = readV4(node.verts, cubeFace2Vert[f]![2]!)
        for (let x = 0; x <= O; x++) {
            for (let y = 0; y <= O; y++) {
                const p4: [number, number, number] = [0, 0, 0]
                p4[xi] = (1 - x / O) * fc0[xi] + (x / O) * fc2[xi]
                p4[yi] = (1 - y / O) * fc0[yi] + (y / O) * fc2[yi]
                p4[zi] = fc0[zi]
                normPts[pi * 4] = p4[0]!
                normPts[pi * 4 + 1] = p4[1]!
                normPts[pi * 4 + 2] = p4[2]!
                pi++
            }
        }
    }

    const worldPhase1 = packWorldFromNorm4(normPts, totalPhase1, rootMin, rootMax)
    const sdfPhase1 = await sample(worldPhase1, signal)

    let qefError = 0
    const cellMin: [number, number, number] = [v0[0], v0[1], v0[2]]
    const cellMax: [number, number, number] = [v7[0], v7[1], v7[2]]
    const cellSize = v7[0] - v0[0]

    const reEvalNorm = new Float32Array(19 * 3)

    {
        const packed = zeroQefPacked(4)
        const planeNorms4: [number, number, number, number][] = []
        const planePts4: [number, number, number, number][] = []
        for (let i = 0; i < nodeCount; i++) {
            const si = (nodeOff + i) * 4
            const px = normPts[si]!, py = normPts[si + 1]!, pz = normPts[si + 2]!
            const nx = sdfPhase1[si]!, ny = sdfPhase1[si + 1]!, nz = sdfPhase1[si + 2]!, d = sdfPhase1[si + 3]!
            qefAccumulatePlane(encodeCubeHermitePlane(nx, ny, nz, px, py, pz, d), packed)
            planeNorms4.push([nx, ny, nz, -1])
            planePts4.push([px, py, pz, d])
        }
        const { position, qefError: nodeQef } = computeDualVertexCube({
            cellMin, cellMax, qefPacked: packed, planeNorms4, planePts4,
            borderFraction: C.dualVertexBorderFraction,
        })
        node.node[0] = position[0]!
        node.node[1] = position[1]!
        node.node[2] = position[2]!
        reEvalNorm[0] = position[0]!
        reEvalNorm[1] = position[1]!
        reEvalNorm[2] = position[2]!
        qefError += nodeQef
    }

    for (let e = 0; e < 12; e++) {
        const xi = cubeEdge2Orient[e]! as 0 | 1 | 2
        const yi = ((xi + 1) % 3) as 0 | 1 | 2
        const zi = ((xi + 2) % 3) as 0 | 1 | 2
        const ec0 = readV4(node.verts, cubeEdge2Vert[e]![0]!)
        const ec1 = readV4(node.verts, cubeEdge2Vert[e]![1]!)
        const off = edgeOffs[e]!
        const packed = zeroQefPacked(2)
        const planeNorms2: [number, number][] = []
        const planePts2: [number, number][] = []
        for (let i = 0; i < edgeSamples; i++) {
            const si = (off + i) * 4
            const pXi = normPts[si + xi]!
            const n4x = sdfPhase1[si]!, n4y = sdfPhase1[si + 1]!, n4z = sdfPhase1[si + 2]!, d = sdfPhase1[si + 3]!
            const nXi = (xi === 0 ? n4x : xi === 1 ? n4y : n4z) as number
            qefAccumulatePlane(encodeEdgeHermitePlane(nXi, pXi, d), packed)
            planeNorms2.push([nXi, -1])
            planePts2.push([pXi, d])
        }
        const { position, qefError: edgeQef } = computeDualVertexEdge({
            xi, yi, zi, c0: ec0, c1: ec1, qefPacked: packed, planeNorms2, planePts2,
            cellSizeForBorder: cellSize, borderFraction: C.dualVertexBorderFraction,
        })
        writeV4(node.edges, e, position[0]!, position[1]!, position[2]!, position[3]!)
        const ro = (1 + e) * 3
        reEvalNorm[ro] = position[0]!
        reEvalNorm[ro + 1] = position[1]!
        reEvalNorm[ro + 2] = position[2]!
        qefError += edgeQef
    }

    for (let f = 0; f < 6; f++) {
        const orient = cubeFace2Orient[f]!
        const xi = ((orient + 1) % 3) as 0 | 1 | 2
        const yi = ((orient + 2) % 3) as 0 | 1 | 2
        const zi = orient as 0 | 1 | 2
        const fc0 = readV4(node.verts, cubeFace2Vert[f]![0]!)
        const fc2 = readV4(node.verts, cubeFace2Vert[f]![2]!)
        const off = faceOffs[f]!
        const packed = zeroQefPacked(3)
        const planeNorms3: [number, number, number][] = []
        const planePts3: [number, number, number][] = []
        for (let i = 0; i < faceSamples; i++) {
            const si = (off + i) * 4
            const px = normPts[si + xi]!, py = normPts[si + yi]!
            const n4x = sdfPhase1[si]!, n4y = sdfPhase1[si + 1]!, n4z = sdfPhase1[si + 2]!, d = sdfPhase1[si + 3]!
            const nXi = (xi === 0 ? n4x : xi === 1 ? n4y : n4z) as number
            const nYi = (yi === 0 ? n4x : yi === 1 ? n4y : n4z) as number
            qefAccumulatePlane(encodeFaceHermitePlane(nXi, nYi, px, py, d), packed)
            planeNorms3.push([nXi, nYi, -1])
            planePts3.push([px, py, d])
        }
        const { position, qefError: faceQef } = computeDualVertexFace({
            c0: fc0, c2: fc2, xi, yi, zi, qefPacked: packed, planeNorms3, planePts3,
            cellSizeForBorder: cellSize, borderFraction: C.dualVertexBorderFraction,
        })
        writeV4(node.faces, f, position[0]!, position[1]!, position[2]!, position[3]!)
        const ro = (1 + 12 + f) * 3
        reEvalNorm[ro] = position[0]!
        reEvalNorm[ro + 1] = position[1]!
        reEvalNorm[ro + 2] = position[2]!
        qefError += faceQef
    }

    const reEvalWorld = new Float32Array(19 * 3)
    for (let i = 0; i < 19; i++) {
        normToWorld(reEvalNorm[i * 3]!, reEvalNorm[i * 3 + 1]!, reEvalNorm[i * 3 + 2]!, rootMin, rootMax, reEvalWorld, i * 3)
    }
    const reEvalSdf = await sample(reEvalWorld, signal)
    node.node[3] = reEvalSdf[3]!
    for (let e = 0; e < 12; e++) node.edges[e * 4 + 3] = reEvalSdf[(1 + e) * 4 + 3]!
    for (let f = 0; f < 6; f++) node.faces[f * 4 + 3] = reEvalSdf[(1 + 12 + f) * 4 + 3]!

    const minsize = 0.5 ** C.depthMax
    const maxsize = 0.5 ** C.depthMin

    if (isoOctreeIsOutside(node.verts)) return
    if (cellSize <= minsize) return

    const isbig = cellSize > maxsize
    const signchange = !isbig && isoOctreeChangesSign(node.verts, node.edges, node.faces, node.node)
    const badqef = qefError / cellSize > C.qefRelativeErrorRefineThreshold
    const recur = isbig || (signchange && badqef)
    if (!recur) return

    const p = new Float32Array(27 * 4)
    for (let x = 0; x < 3; x++) {
        for (let y = 0; y < 3; y++) {
            for (let z = 0; z < 3; z++) {
                const idxFlat = (x * 3 + y) * 3 + z
                trilinearP8(node.verts, x, y, z, p, idxFlat * 4)
            }
        }
    }

    const midList: number[] = []
    for (let x = 0; x < 3; x++) {
        for (let y = 0; y < 3; y++) {
            for (let z = 0; z < 3; z++) {
                if (x === 1 || y === 1 || z === 1) {
                    midList.push((x * 3 + y) * 3 + z)
                }
            }
        }
    }

    const midToBatch = new Map<number, number>()
    let midSdf = new Float32Array(0)
    if (midList.length > 0) {
        const midWorld = new Float32Array(midList.length * 3)
        for (let i = 0; i < midList.length; i++) {
            const idxFlat = midList[i]!
            midToBatch.set(idxFlat, i)
            normToWorld(
                p[idxFlat * 4]!,
                p[idxFlat * 4 + 1]!,
                p[idxFlat * 4 + 2]!,
                rootMin,
                rootMax,
                midWorld,
                i * 3,
            )
        }
        midSdf = new Float32Array(await sample(midWorld, signal))
        for (let i = 0; i < midList.length; i++) {
            const idxFlat = midList[i]!
            p[idxFlat * 4 + 3] = midSdf[i * 4 + 3]!
        }
    }

    const gChild = new Float32Array(24)

    for (let ci = 0; ci < 8; ci++) {
        const child = createEmptyNode()
        node.children[ci] = child
        const ib = indexBits(ci)
        for (let j = 0; j < 8; j++) {
            const jb = indexBits(j)
            const px = ib.x + jb.x
            const py = ib.y + jb.y
            const pz = ib.z + jb.z
            const idxFlat = (px * 3 + py) * 3 + pz
            writeV4(child.verts, j, p[idxFlat * 4]!, p[idxFlat * 4 + 1]!, p[idxFlat * 4 + 2]!, p[idxFlat * 4 + 3]!)
            const g = gridGradient(px, py, pz, gradCorners, midToBatch, midSdf)
            gChild[j * 3] = g[0]!
            gChild[j * 3 + 1] = g[1]!
            gChild[j * 3 + 2] = g[2]!
        }
        await evalNode(child, gChild, rootMin, rootMax, C, sample, signal, counter)
    }
}
