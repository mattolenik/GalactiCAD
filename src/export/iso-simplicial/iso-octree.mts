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
    encodeEdgeFeaturePlane,
    encodeEdgeHermitePlane,
    encodeFaceFeaturePlane,
    encodeFaceHermitePlane,
    encodeFeaturePlane,
} from "./dual-vertex-qef.mjs"
import { cubeCornerIndex, cubeEdge2Orient, cubeEdge2Vert, cubeFace2Orient, cubeFace2Vert } from "./cube-tables.mjs"
import { qefAccumulatePlane, zeroQefPacked } from "./qef-normal.mjs"
import { ISO_SAMPLE_BATCH_MID_FLOATS_PER_SAMPLE, type IsoSampleBatch } from "./iso-sample-batch.mjs"

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

/**
 * Feature-driven subdivision predicate (Path I — explicit primitive features from `sceneSDF_mid`).
 * - `"off"`: existing gate `isbig || (signchange && badqef)`. No mid-feature GPU sampling.
 * - `"signchangeGated"`: `isbig || (signchange && (badqef || nearFeature))`.
 *
 * When mode is not `"off"`, mid-feature samples propagate from parent to children via inheritance:
 * the root's 8 corners are sampled once, then each subdivision step samples the parent's 19
 * midpoints (alongside the existing midSdf batch) and each child inherits 8 of those 27 grid
 * points as its own corners. The signchangeGated gate then reads the inherited corner features
 * instead of issuing a per-frontier GPU sample. See {@link BFSEntry.cornerFeature}.
 */
export type IsoFeatureRefineMode = "off" | "signchangeGated"

export interface IsoFeatureRefineOptions {
    mode: IsoFeatureRefineMode
    /** Cell counts as "near" when `featureDist < proximityFactor * cellSize`. */
    proximityFactor: number
    /** Packed `SDFResultMid` batch sampler (7 vec4 / sample). Required when `mode !== "off"`. */
    sampleMidFeature?: IsoOctreeBatchFn
    /**
     * When true, inject extra Hermite planes into the cube QEF normal equations using each
     * corner's inherited `featurePoint`/`featureN1`/`featureN2`. Pulls the cube dual vertex
     * toward feature primitives without a hard constraint. Requires `mode !== "off"` (otherwise
     * `cornerFeature` is null and there's nothing to inject). Default `false`.
     */
    planeEnabled?: boolean
    /**
     * Distance gate for feature planes: skip a corner's planes when its `featureDist`
     * (world units) exceeds `planeDistFactor * cellSize * worldScale`. Default `1.0` —
     * only inject from corners whose nearest feature is inside or just outside the cell.
     */
    planeDistFactor?: number
}

export const DEFAULT_FEATURE_REFINE_OPTIONS: IsoFeatureRefineOptions = {
    mode: "off",
    proximityFactor: 2.0,
}

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
    featureRefine?: IsoFeatureRefineOptions
    /**
     * Optional QEF worker pool. When provided, per-frontier QEF compute is parallelized across
     * the pool's workers via SharedArrayBuffer. Without it, QEF runs inline on the calling thread.
     * Plumbed through to {@link buildOctreeBFS}; safely ignored in tests / Node environments.
     */
    qefWorkerPool?: QefWorkerPoolLike
}

/** Subset of {@link QefWorkerPool} that BFS depends on — keeps iso-octree.mts decoupled from the pool module. */
export interface QefWorkerPoolLike {
    readonly workerCount: number
    processBatch(inputs: {
        sharedVerts: SharedArrayBuffer
        sharedNormPts: SharedArrayBuffer
        sharedSdf: SharedArrayBuffer
        sharedOut: SharedArrayBuffer
        nodeCount: number
        scratchProto: Phase1NormScratch
        oversampleQef: number
        dualVertexBorderFraction: number
        invWorldScale: number
        /**
         * Optional per-node packed `SDFResultMid` corner data (N × 8 × 28 floats). When provided
         * together with the `featurePlane*` fields, the worker injects feature planes into the
         * cube QEF for each node whose first u32 word (featureKind) is non-zero at any corner.
         */
        sharedCornerFeature?: SharedArrayBuffer
        featurePlaneEnabled?: boolean
        featurePlaneDistFactor?: number
        rootMinX?: number
        rootMinY?: number
        rootMinZ?: number
        worldScale?: number
    }): Promise<void>
}

/**
 * Breakdown of where {@link IsoOctree.build} spent time. All times in ms (from `performance.now()`).
 * GPU-bucket times include `await` waits for the corresponding `sample(...)` calls. CPU buckets are
 * wall time between awaits (so they include any JS GC pauses that happened during the work).
 */
export interface IsoOctreeBuildPerf {
    /** Number of BFS frontier iterations (~ tree depth). */
    frontierCount: number
    /** Number of cells per frontier iteration, in order (depth 0..N). */
    cellsPerFrontier: readonly number[]
    /** Sum across frontiers of `await sample(...)` durations for the Phase 1 lattice mega-batch. */
    phase1SampleMs: number
    /** Sum across frontiers for the Phase 2 (re-eval at dual vertices) mega-batch. */
    phase2SampleMs: number
    /** Sum across frontiers for the parent-midpoint mega-batch (only fires when subdividing). */
    midSampleMs: number
    /** Sum across frontiers for the optional nearFeature mid-feature mega-batch. */
    nearFeatureSampleMs: number
    /** CPU time in `phase1SdfToReEvalNorm` — QEF accumulation + Jacobi pseudoinverse solves. */
    qefMs: number
    /** Other CPU work (lattice construction, world packing, re-eval apply, decisions, trilerp, child build). */
    otherCpuMs: number
    /** Total wall time across all frontiers. */
    totalWallMs: number
}

function emptyPerf(): IsoOctreeBuildPerf {
    return {
        frontierCount: 0,
        cellsPerFrontier: [],
        phase1SampleMs: 0,
        phase2SampleMs: 0,
        midSampleMs: 0,
        nearFeatureSampleMs: 0,
        qefMs: 0,
        otherCpuMs: 0,
        totalWallMs: 0,
    }
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

/**
 * Adapter: {@link IsoSampleBatch.run} → {@link IsoOctreeBatchFn}.
 * `voxelSize` is a representative grid scale (mm) forwarded to the shader as
 * `uniforms.voxelSize` for inserted scene-SDF code (Lathe/Loft epsilons).
 */
export function createIsoOctreeSampleFn(
    batch: IsoSampleBatch,
    isoSampleBatchShaderModule: GPUShaderModule,
    voxelSize: number,
): IsoOctreeBatchFn {
    return async (positions, signal) => {
        const { sdf } = await batch.run(
            isoSampleBatchShaderModule,
            positions as Float32Array<ArrayBuffer>,
            voxelSize,
            { signal },
        )
        return sdf
    }
}

/** Adapter: {@link IsoSampleBatch.runMidFeature} → {@link IsoOctreeBatchFn}-shaped mid-feature sampler. */
export function createIsoOctreeMidFeatureSampleFn(
    batch: IsoSampleBatch,
    isoSampleBatchShaderModule: GPUShaderModule,
    voxelSize: number,
): IsoOctreeBatchFn {
    return async (positions, signal) => {
        const { midFeature } = await batch.runMidFeature(
            isoSampleBatchShaderModule,
            positions as Float32Array<ArrayBuffer>,
            voxelSize,
            { signal },
        )
        return midFeature
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

export interface Phase1NormScratch {
    normPts: Float32Array
    edgeOffs: number[]
    faceOffs: number[]
    totalPhase1: number
    nodeCount: number
    edgeSamples: number
    faceSamples: number
}

function buildPhase1NormPts(node: IsoOctreeNode, C: IsoOctreeRuntimeConstants): Phase1NormScratch {
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
                normPts[pi * 4] = (1 - x / O) * v0[0]! + (x / O) * v7[0]!
                normPts[pi * 4 + 1] = (1 - y / O) * v0[1]! + (y / O) * v7[1]!
                normPts[pi * 4 + 2] = (1 - z / O) * v0[2]! + (z / O) * v7[2]!
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
            p4[xi] = (1 - i / O) * ec0[xi]! + (i / O) * ec1[xi]!
            p4[yi] = ec0[yi]!
            p4[zi] = ec0[zi]!
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
                p4[xi] = (1 - x / O) * fc0[xi]! + (x / O) * fc2[xi]!
                p4[yi] = (1 - y / O) * fc0[yi]! + (y / O) * fc2[yi]!
                p4[zi] = fc0[zi]!
                normPts[pi * 4] = p4[0]!
                normPts[pi * 4 + 1] = p4[1]!
                normPts[pi * 4 + 2] = p4[2]!
                pi++
            }
        }
    }

    return { normPts, edgeOffs, faceOffs, totalPhase1, nodeCount, edgeSamples, faceSamples }
}

/**
 * Pure-function form of {@link phase1SdfToReEvalNorm} — same QEF compute but does not mutate the
 * node. Suitable for off-thread execution (worker pool). Outputs are tightly packed so the entire
 * result can fit in a single Float32Array per node (`75 floats: nodePos[3] + edges[48] + faces[24]`)
 * plus a `qefError` scalar and the 57-float `reEvalNorm` buffer.
 */
export function computeNodeQefResults(
    verts: Float32Array,
    scratch: Phase1NormScratch,
    sdfPhase1: Float32Array,
    oversampleQef: number,
    dualVertexBorderFraction: number,
    invWorldScale: number,
    cubeFeatureOpts?: CubeFeaturePlaneOptions,
): { qefError: number; nodePos: Float32Array; edges: Float32Array; faces: Float32Array; reEvalNorm: Float32Array } {
    void oversampleQef
    const v0: [number, number, number, number] = [verts[0]!, verts[1]!, verts[2]!, verts[3]!]
    const v7: [number, number, number, number] = [verts[7 * 4]!, verts[7 * 4 + 1]!, verts[7 * 4 + 2]!, verts[7 * 4 + 3]!]
    const { normPts, edgeOffs, faceOffs, nodeCount, edgeSamples, faceSamples } = scratch

    let qefError = 0
    const cellMin: [number, number, number] = [v0[0], v0[1], v0[2]]
    const cellMax: [number, number, number] = [v7[0], v7[1], v7[2]]
    const cellSize = v7[0] - v0[0]

    const reEvalNorm = new Float32Array(19 * 3)
    const nodePos = new Float32Array(4)
    const edges = new Float32Array(48)
    const faces = new Float32Array(24)

    {
        const packed = zeroQefPacked(4)
        const planeNorms4: [number, number, number, number][] = []
        const planePts4: [number, number, number, number][] = []
        for (let i = 0; i < nodeCount; i++) {
            const si = i * 4
            const px = normPts[si]!, py = normPts[si + 1]!, pz = normPts[si + 2]!
            const nx = sdfPhase1[si]!, ny = sdfPhase1[si + 1]!, nz = sdfPhase1[si + 2]!
            const dN = sdfPhase1[si + 3]! * invWorldScale
            qefAccumulatePlane(encodeCubeHermitePlane(nx, ny, nz, px, py, pz, dN), packed)
            planeNorms4.push([nx, ny, nz, -1])
            planePts4.push([px, py, pz, dN])
        }
        if (cubeFeatureOpts) {
            injectCubeFeaturePlanes(cubeFeatureOpts, cellSize, packed, planeNorms4, planePts4)
        }
        const { position, qefError: nodeQef } = computeDualVertexCube({
            cellMin, cellMax, qefPacked: packed, planeNorms4, planePts4,
            borderFraction: dualVertexBorderFraction,
        })
        nodePos[0] = position[0]!
        nodePos[1] = position[1]!
        nodePos[2] = position[2]!
        // QEF-estimated `w` at the cube dual vertex (4D QEF). When Phase 2 re-eval runs,
        // this gets overwritten with the true SDF; when skipped, it's the only `w` we have.
        nodePos[3] = position[3]!
        reEvalNorm[0] = position[0]!
        reEvalNorm[1] = position[1]!
        reEvalNorm[2] = position[2]!
        qefError += nodeQef
    }

    for (let e = 0; e < 12; e++) {
        const xi = cubeEdge2Orient[e]! as 0 | 1 | 2
        const yi = ((xi + 1) % 3) as 0 | 1 | 2
        const zi = ((xi + 2) % 3) as 0 | 1 | 2
        const ec0 = readV4(verts, cubeEdge2Vert[e]![0]!)
        const ec1 = readV4(verts, cubeEdge2Vert[e]![1]!)
        const off = edgeOffs[e]!
        const packed = zeroQefPacked(2)
        const planeNorms2: [number, number][] = []
        const planePts2: [number, number][] = []
        for (let i = 0; i < edgeSamples; i++) {
            const si = (off + i) * 4
            const pXi = normPts[si + xi]!
            const n4x = sdfPhase1[si]!, n4y = sdfPhase1[si + 1]!, n4z = sdfPhase1[si + 2]!
            const dN = sdfPhase1[si + 3]! * invWorldScale
            const nXi = (xi === 0 ? n4x : xi === 1 ? n4y : n4z) as number
            qefAccumulatePlane(encodeEdgeHermitePlane(nXi, pXi, dN), packed)
            planeNorms2.push([nXi, -1])
            planePts2.push([pXi, dN])
        }
        if (cubeFeatureOpts) {
            injectEdgeFeaturePlanes(cubeFeatureOpts, e, xi, yi, zi, ec0[yi]!, ec0[zi]!, cellSize, packed, planeNorms2, planePts2)
        }
        const { position, qefError: edgeQef } = computeDualVertexEdge({
            xi, yi, zi, c0: ec0, c1: ec1, qefPacked: packed, planeNorms2, planePts2,
            cellSizeForBorder: cellSize, borderFraction: dualVertexBorderFraction,
        })
        edges[e * 4] = position[0]!
        edges[e * 4 + 1] = position[1]!
        edges[e * 4 + 2] = position[2]!
        edges[e * 4 + 3] = position[3]!
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
        const fc0 = readV4(verts, cubeFace2Vert[f]![0]!)
        const fc2 = readV4(verts, cubeFace2Vert[f]![2]!)
        const off = faceOffs[f]!
        const packed = zeroQefPacked(3)
        const planeNorms3: [number, number, number][] = []
        const planePts3: [number, number, number][] = []
        for (let i = 0; i < faceSamples; i++) {
            const si = (off + i) * 4
            const px = normPts[si + xi]!, py = normPts[si + yi]!
            const n4x = sdfPhase1[si]!, n4y = sdfPhase1[si + 1]!, n4z = sdfPhase1[si + 2]!
            const dN = sdfPhase1[si + 3]! * invWorldScale
            const nXi = (xi === 0 ? n4x : xi === 1 ? n4y : n4z) as number
            const nYi = (yi === 0 ? n4x : yi === 1 ? n4y : n4z) as number
            qefAccumulatePlane(encodeFaceHermitePlane(nXi, nYi, px, py, dN), packed)
            planeNorms3.push([nXi, nYi, -1])
            planePts3.push([px, py, dN])
        }
        if (cubeFeatureOpts) {
            injectFaceFeaturePlanes(cubeFeatureOpts, f, xi, yi, zi, fc0[zi]!, cellSize, packed, planeNorms3, planePts3)
        }
        const { position, qefError: faceQef } = computeDualVertexFace({
            c0: fc0, c2: fc2, xi, yi, zi, qefPacked: packed, planeNorms3, planePts3,
            cellSizeForBorder: cellSize, borderFraction: dualVertexBorderFraction,
        })
        faces[f * 4] = position[0]!
        faces[f * 4 + 1] = position[1]!
        faces[f * 4 + 2] = position[2]!
        faces[f * 4 + 3] = position[3]!
        const ro = (1 + 12 + f) * 3
        reEvalNorm[ro] = position[0]!
        reEvalNorm[ro + 1] = position[1]!
        reEvalNorm[ro + 2] = position[2]!
        qefError += faceQef
    }

    return { qefError, nodePos, edges, faces, reEvalNorm }
}

/**
 * Inline (single-thread) version that writes directly into the node's existing buffers, avoiding
 * the per-cell Float32Array allocations of {@link computeNodeQefResults}. Used by the no-pool path.
 */
function phase1SdfToReEvalNorm(
    node: IsoOctreeNode,
    scratch: Phase1NormScratch,
    sdfPhase1: Float32Array,
    C: IsoOctreeRuntimeConstants,
    invWorldScale: number,
    cubeFeatureOpts?: CubeFeaturePlaneOptions,
): { qefError: number; reEvalNorm: Float32Array } {
    const v0 = readV4(node.verts, 0)
    const v7 = readV4(node.verts, 7)
    const { normPts, edgeOffs, faceOffs, nodeCount, edgeSamples, faceSamples } = scratch

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
            const si = i * 4
            const px = normPts[si]!, py = normPts[si + 1]!, pz = normPts[si + 2]!
            const nx = sdfPhase1[si]!, ny = sdfPhase1[si + 1]!, nz = sdfPhase1[si + 2]!
            const dN = sdfPhase1[si + 3]! * invWorldScale
            qefAccumulatePlane(encodeCubeHermitePlane(nx, ny, nz, px, py, pz, dN), packed)
            planeNorms4.push([nx, ny, nz, -1])
            planePts4.push([px, py, pz, dN])
        }
        if (cubeFeatureOpts) {
            injectCubeFeaturePlanes(cubeFeatureOpts, cellSize, packed, planeNorms4, planePts4)
        }
        const { position, qefError: nodeQef } = computeDualVertexCube({
            cellMin, cellMax, qefPacked: packed, planeNorms4, planePts4,
            borderFraction: C.dualVertexBorderFraction,
        })
        node.node[0] = position[0]!
        node.node[1] = position[1]!
        node.node[2] = position[2]!
        // QEF-estimated `w` at the cube dual vertex (4D QEF). When Phase 2 re-eval runs,
        // this gets overwritten with the true SDF; when skipped, it's the only `w` we have.
        node.node[3] = position[3]!
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
            const n4x = sdfPhase1[si]!, n4y = sdfPhase1[si + 1]!, n4z = sdfPhase1[si + 2]!
            const dN = sdfPhase1[si + 3]! * invWorldScale
            const nXi = (xi === 0 ? n4x : xi === 1 ? n4y : n4z) as number
            qefAccumulatePlane(encodeEdgeHermitePlane(nXi, pXi, dN), packed)
            planeNorms2.push([nXi, -1])
            planePts2.push([pXi, dN])
        }
        if (cubeFeatureOpts) {
            injectEdgeFeaturePlanes(cubeFeatureOpts, e, xi, yi, zi, ec0[yi]!, ec0[zi]!, cellSize, packed, planeNorms2, planePts2)
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
            const n4x = sdfPhase1[si]!, n4y = sdfPhase1[si + 1]!, n4z = sdfPhase1[si + 2]!
            const dN = sdfPhase1[si + 3]! * invWorldScale
            const nXi = (xi === 0 ? n4x : xi === 1 ? n4y : n4z) as number
            const nYi = (yi === 0 ? n4x : yi === 1 ? n4y : n4z) as number
            qefAccumulatePlane(encodeFaceHermitePlane(nXi, nYi, px, py, dN), packed)
            planeNorms3.push([nXi, nYi, -1])
            planePts3.push([px, py, dN])
        }
        if (cubeFeatureOpts) {
            injectFaceFeaturePlanes(cubeFeatureOpts, f, xi, yi, zi, fc0[zi]!, cellSize, packed, planeNorms3, planePts3)
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

    return { qefError, reEvalNorm }
}

function applyReEvalDistances(node: IsoOctreeNode, reEvalSdf: Float32Array): void {
    node.node[3] = reEvalSdf[3]!
    for (let e = 0; e < 12; e++) node.edges[e * 4 + 3] = reEvalSdf[(1 + e) * 4 + 3]!
    for (let f = 0; f < 6; f++) node.faces[f * 4 + 3] = reEvalSdf[(1 + 12 + f) * 4 + 3]!
}

export class IsoOctree {
    readonly root: IsoOctreeNode
    /** Cells that ran Hermite+QEF (`tree_cells` in reference). */
    readonly treeCellCount: number
    /** Per-bucket timings collected during {@link IsoOctree.build}. */
    readonly buildPerf: IsoOctreeBuildPerf

    private constructor(root: IsoOctreeNode, treeCellCount: number, buildPerf: IsoOctreeBuildPerf) {
        this.root = root
        this.treeCellCount = treeCellCount
        this.buildPerf = buildPerf
    }

    static async build(params: IsoOctreeBuildParams): Promise<IsoOctree> {
        assertCubicBounds(params.bounds.min, params.bounds.max)
        const C = mergeConstants(params.constants)
        const rootMin = params.bounds.min
        const rootMax = params.bounds.max
        const sample = params.sample
        const signal = params.signal
        const featureRefine = normalizeFeatureRefine(params.featureRefine)

        const root = createEmptyNode()
        for (let i = 0; i < 8; i++) {
            const b = indexBits(i)
            writeV4(root.verts, i, b.x, b.y, b.z, 0)
        }

        const counter = { n: 0 }
        const worldScale = rootMax[0] - rootMin[0]
        const perf = emptyPerf()

        // Frontier batching: every node at the current depth is sampled together. Each
        // frontier iteration issues at most 2–4 GPU dispatches (Phase 1 + Phase 2 + parent
        // midSdf + optional nearFeature) regardless of how wide the tree is at that depth,
        // collapsing the original recursive structure's per-cell round-trip cost.
        const tWall0 = nowMs()
        await buildOctreeBFS(root, rootMin, rootMax, worldScale, C, sample, signal, counter, featureRefine, perf, params.qefWorkerPool)
        perf.totalWallMs = nowMs() - tWall0

        return new IsoOctree(root, counter.n, perf)
    }
}

function nowMs(): number {
    return globalThis.performance?.now ? globalThis.performance.now() : Date.now()
}

function normalizeFeatureRefine(opt: IsoFeatureRefineOptions | undefined): IsoFeatureRefineOptions {
    if (!opt || opt.mode === "off") return { ...DEFAULT_FEATURE_REFINE_OPTIONS }
    if (!opt.sampleMidFeature) {
        throw new Error("IsoOctree.build: featureRefine.mode != 'off' requires sampleMidFeature")
    }
    return {
        mode: opt.mode,
        proximityFactor: opt.proximityFactor > 0 ? opt.proximityFactor : DEFAULT_FEATURE_REFINE_OPTIONS.proximityFactor,
        sampleMidFeature: opt.sampleMidFeature,
        planeEnabled: opt.planeEnabled === true,
        planeDistFactor:
            typeof opt.planeDistFactor === "number" && Number.isFinite(opt.planeDistFactor) && opt.planeDistFactor > 0
                ? opt.planeDistFactor
                : 1.0,
    }
}

/**
 * Per-sample read of `featureKind` (slot 0, bitcast u32) and `featureDist` (slot 1)
 * from the packed `SDFResultMid` layout (`midFeatureOut`, 7 vec4 per sample).
 * Used by `nearFeature` checks during subdivision.
 */
function readMidFeatureKindAndDist(midBuf: Float32Array, sampleIdx: number): { kind: number; dist: number } {
    const base = sampleIdx * ISO_SAMPLE_BATCH_MID_FLOATS_PER_SAMPLE
    const kindU = new Uint32Array(midBuf.buffer, midBuf.byteOffset + base * 4, 1)[0]!
    return { kind: kindU, dist: midBuf[base + 1]! }
}

/**
 * Full geometric payload at a single corner sample of {@link BFSEntry.cornerFeature}.
 * Decodes slot 0 (kind/dist, u32-bitcast for kind), slot 1.x (normal count, u32-bitcast),
 * slot 2 (featurePoint, world space), slot 4 (featureN1, world unit normal), slot 5
 * (featureN2, world unit normal — meaningful only when `normalCount >= 2`).
 *
 * Returned point/normals are in **world coordinates**. Callers that need them in the
 * normalized `[0,1]³` cell frame should subtract `rootMin` and divide by `worldScale`.
 */
function readMidFeatureCornerPayload(midBuf: Float32Array, sampleIdx: number): {
    kind: number
    dist: number
    normalCount: number
    pointX: number; pointY: number; pointZ: number
    n1x: number; n1y: number; n1z: number
    n2x: number; n2y: number; n2z: number
} {
    const base = sampleIdx * ISO_SAMPLE_BATCH_MID_FLOATS_PER_SAMPLE
    const u32 = new Uint32Array(midBuf.buffer, midBuf.byteOffset + base * 4, 5)
    return {
        kind: u32[0]!,
        dist: midBuf[base + 1]!,
        normalCount: u32[4]!,
        pointX: midBuf[base + 8]!,
        pointY: midBuf[base + 9]!,
        pointZ: midBuf[base + 10]!,
        n1x: midBuf[base + 16]!,
        n1y: midBuf[base + 17]!,
        n1z: midBuf[base + 18]!,
        n2x: midBuf[base + 20]!,
        n2y: midBuf[base + 21]!,
        n2z: midBuf[base + 22]!,
    }
}

const MID_FEATURE_NONE_KIND = 0

/**
 * Cube-QEF feature-plane injection options. Passed to {@link phase1SdfToReEvalNorm} and
 * {@link computeNodeQefResults}. When provided + `cornerFeature` is non-null, each of the
 * 8 corners contributes 1–2 extra Hermite planes through its inherited `featurePoint`
 * (filtered by `featureDist < distFactor * cellSize * worldScale`).
 *
 * The added planes describe surfaces that are known to pass through the feature primitive:
 * for a sharp edge feature, both adjacent face normals (`featureN1`, `featureN2`) emanate
 * from the same `featurePoint`, and their inclusion in the QEF normal equations pulls the
 * dual vertex toward the feature without a hard constraint.
 */
export interface CubeFeaturePlaneOptions {
    /** Per-corner packed SDFResultMid (8 × 28 floats), as carried by {@link BFSEntry.cornerFeature}. */
    cornerFeature: Float32Array
    /** Skip planes whose `featureDist` exceeds `distFactor · cellSize · worldScale` (world units). */
    distFactor: number
    /** Root AABB origin (world space); used to convert `featurePoint` to normalized cell coords. */
    rootMinX: number
    rootMinY: number
    rootMinZ: number
    /** Root AABB edge length (world units); convert via `(p - rootMin) / worldScale`. */
    worldScale: number
}

/**
 * Accumulate 1–2 cube Hermite planes per corner into the cube QEF, using the corner's inherited
 * `SDFResultMid`. Each plane passes through the world-space `featurePoint` (converted to the
 * normalized cell frame) with `featureN1` (and, if `featureNormalCount >= 2`, `featureN2`).
 * `dN = 0` because the feature primitive is on the modelled surface.
 *
 * Called from both {@link phase1SdfToReEvalNorm} (inline path) and {@link computeNodeQefResults}
 * (worker-pool path) so the two QEFs stay bit-identical.
 */
function injectCubeFeaturePlanes(
    opts: CubeFeaturePlaneOptions,
    cellSize: number,
    packed: Float64Array,
    planeNorms4: [number, number, number, number][],
    planePts4: [number, number, number, number][],
): void {
    const distThreshold = opts.distFactor * cellSize * opts.worldScale
    const invWS = 1 / opts.worldScale
    for (let c = 0; c < 8; c++) {
        const f = readMidFeatureCornerPayload(opts.cornerFeature, c)
        if (f.kind === MID_FEATURE_NONE_KIND) continue
        if (f.dist > distThreshold) continue
        const px = (f.pointX - opts.rootMinX) * invWS
        const py = (f.pointY - opts.rootMinY) * invWS
        const pz = (f.pointZ - opts.rootMinZ) * invWS
        qefAccumulatePlane(encodeFeaturePlane(f.n1x, f.n1y, f.n1z, px, py, pz), packed)
        planeNorms4.push([f.n1x, f.n1y, f.n1z, 0])
        planePts4.push([px, py, pz, 0])
        if (f.normalCount >= 2) {
            qefAccumulatePlane(encodeFeaturePlane(f.n2x, f.n2y, f.n2z, px, py, pz), packed)
            planeNorms4.push([f.n2x, f.n2y, f.n2z, 0])
            planePts4.push([px, py, pz, 0])
        }
    }
}

/**
 * Minimum |n[axis]| (or |n| projected onto the face plane) below which a feature plane is
 * skipped — a plane parallel to the edge axis or face plane contributes no useful constraint
 * and would amplify numerical noise through division.
 */
const FEATURE_PLANE_AXIS_EPS = 1e-4

/**
 * Project one corner's 1–2 feature normals onto an edge running along `xi`, fixed at
 * `(yEdge, zEdge)` on the other two axes (normalized cell coords). Each projection yields
 * an axis-only Hermite equation `n[xi] · (xi − xi_hit) = 0` that pulls the edge dual vertex
 * toward the line `feature point + t · feature tangent`.
 *
 * Skips normals nearly parallel to the edge (small `|n[xi]|`), since those impose no
 * constraint along the edge and would divide by a tiny number.
 */
function injectOneCornerFeatureOntoEdge(
    f: ReturnType<typeof readMidFeatureCornerPayload>,
    xi: 0 | 1 | 2, yi: 0 | 1 | 2, zi: 0 | 1 | 2,
    yEdge: number, zEdge: number,
    point: readonly [number, number, number],
    packed: Float64Array,
    planeNorms2: [number, number][],
    planePts2: [number, number][],
): void {
    const tryNormal = (nx: number, ny: number, nz: number): void => {
        const nAxis = xi === 0 ? nx : xi === 1 ? ny : nz
        if (Math.abs(nAxis) < FEATURE_PLANE_AXIS_EPS) return
        const nOff1 = yi === 0 ? nx : yi === 1 ? ny : nz
        const nOff2 = zi === 0 ? nx : zi === 1 ? ny : nz
        const xiHit = point[xi]! - (nOff1 * (yEdge - point[yi]!) + nOff2 * (zEdge - point[zi]!)) / nAxis
        qefAccumulatePlane(encodeEdgeFeaturePlane(nAxis, xiHit), packed)
        planeNorms2.push([nAxis, 0])
        planePts2.push([xiHit, 0])
    }
    tryNormal(f.n1x, f.n1y, f.n1z)
    if (f.normalCount >= 2) tryNormal(f.n2x, f.n2y, f.n2z)
}

/**
 * Edge-QEF analogue of {@link injectCubeFeaturePlanes}. Adds 0–4 feature planes to the
 * given edge's QEF (2 corners × up to 2 normals each), filtered by the same
 * `featureDist < distFactor · cellSize · worldScale` gate. The edge's two corners are
 * looked up via {@link cubeEdge2Vert}.
 */
function injectEdgeFeaturePlanes(
    opts: CubeFeaturePlaneOptions,
    e: number,
    xi: 0 | 1 | 2, yi: 0 | 1 | 2, zi: 0 | 1 | 2,
    yEdge: number, zEdge: number,
    cellSize: number,
    packed: Float64Array,
    planeNorms2: [number, number][],
    planePts2: [number, number][],
): void {
    const distThreshold = opts.distFactor * cellSize * opts.worldScale
    const invWS = 1 / opts.worldScale
    const corners = cubeEdge2Vert[e]!
    for (let k = 0; k < 2; k++) {
        const f = readMidFeatureCornerPayload(opts.cornerFeature, corners[k]!)
        if (f.kind === MID_FEATURE_NONE_KIND) continue
        if (f.dist > distThreshold) continue
        const pNorm: [number, number, number] = [
            (f.pointX - opts.rootMinX) * invWS,
            (f.pointY - opts.rootMinY) * invWS,
            (f.pointZ - opts.rootMinZ) * invWS,
        ]
        injectOneCornerFeatureOntoEdge(f, xi, yi, zi, yEdge, zEdge, pNorm, packed, planeNorms2, planePts2)
    }
}

/**
 * Project one corner's 1–2 feature normals onto a face fixed at `zi = zFace`, varying in
 * `(xi, yi)`. Each projection yields a 2D Hermite equation `n[xi]·xi + n[yi]·yi = const`
 * that pulls the face dual vertex toward the line where the feature plane intersects the
 * face. Picks the orthogonal foot of the projected feature point as the plane's `(pXi, pYi)`
 * — any point on the line would do; the foot keeps the encoded values bounded.
 *
 * Skips normals nearly parallel to the face plane (small `n[xi]² + n[yi]²`).
 */
function injectOneCornerFeatureOntoFace(
    f: ReturnType<typeof readMidFeatureCornerPayload>,
    xi: 0 | 1 | 2, yi: 0 | 1 | 2, zi: 0 | 1 | 2,
    zFace: number,
    point: readonly [number, number, number],
    packed: Float64Array,
    planeNorms3: [number, number, number][],
    planePts3: [number, number, number][],
): void {
    const tryNormal = (nx: number, ny: number, nz: number): void => {
        const nAxisX = xi === 0 ? nx : xi === 1 ? ny : nz
        const nAxisY = yi === 0 ? nx : yi === 1 ? ny : nz
        const nAxisZ = zi === 0 ? nx : zi === 1 ? ny : nz
        const denom = nAxisX * nAxisX + nAxisY * nAxisY
        if (denom < FEATURE_PLANE_AXIS_EPS * FEATURE_PLANE_AXIS_EPS) return
        const t = -nAxisZ * (zFace - point[zi]!) / denom
        const pXi = point[xi]! + nAxisX * t
        const pYi = point[yi]! + nAxisY * t
        qefAccumulatePlane(encodeFaceFeaturePlane(nAxisX, nAxisY, pXi, pYi), packed)
        planeNorms3.push([nAxisX, nAxisY, 0])
        planePts3.push([pXi, pYi, 0])
    }
    tryNormal(f.n1x, f.n1y, f.n1z)
    if (f.normalCount >= 2) tryNormal(f.n2x, f.n2y, f.n2z)
}

/**
 * Face-QEF analogue of {@link injectCubeFeaturePlanes}. Adds 0–8 feature planes to the
 * given face's QEF (4 corners × up to 2 normals each). The face's four corners are looked
 * up via {@link cubeFace2Vert}.
 */
function injectFaceFeaturePlanes(
    opts: CubeFeaturePlaneOptions,
    fIdx: number,
    xi: 0 | 1 | 2, yi: 0 | 1 | 2, zi: 0 | 1 | 2,
    zFace: number,
    cellSize: number,
    packed: Float64Array,
    planeNorms3: [number, number, number][],
    planePts3: [number, number, number][],
): void {
    const distThreshold = opts.distFactor * cellSize * opts.worldScale
    const invWS = 1 / opts.worldScale
    const corners = cubeFace2Vert[fIdx]!
    for (let k = 0; k < 4; k++) {
        const f = readMidFeatureCornerPayload(opts.cornerFeature, corners[k]!)
        if (f.kind === MID_FEATURE_NONE_KIND) continue
        if (f.dist > distThreshold) continue
        const pNorm: [number, number, number] = [
            (f.pointX - opts.rootMinX) * invWS,
            (f.pointY - opts.rootMinY) * invWS,
            (f.pointZ - opts.rootMinZ) * invWS,
        ]
        injectOneCornerFeatureOntoFace(f, xi, yi, zi, zFace, pNorm, packed, planeNorms3, planePts3)
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
    midToBatch: ReadonlyMap<number, number>,
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

/**
 * Phase-1 lattice index of cube corner `i` for oversample `O`.
 *
 * `buildPhase1NormPts` lays the lattice out in `(x, y, z)` order with `x` outermost,
 * each axis stepping `0..O`, so the flat index is `x*(O+1)^2 + y*(O+1) + z`. Cube
 * corner `i = indexBits(i) = (b.x, b.y, b.z)` sits at `(b.x*O, b.y*O, b.z*O)`.
 */
function phase1LatticeIndexForCorner(i: number, O: number): number {
    const b = indexBits(i)
    const stride = O + 1
    return (b.x * O) * stride * stride + (b.y * O) * stride + (b.z * O)
}

/** Per-frontier-node state for {@link buildOctreeBFS}. */
interface BFSEntry {
    node: IsoOctreeNode
    /** Inherited gradients at the 8 corners (24 floats). `null` only for the root — harvested from Phase 1 lattice. */
    gradCorners: Float32Array | null
    /**
     * Inherited packed `SDFResultMid` at the 8 corners (8 × 28 = 224 floats), or `null`
     * when `featureRefine.mode === "off"`. Filled at root by a one-time 8-corner GPU sample
     * (see "Feature corner seeding" in {@link buildOctreeBFS}), then inherited from parents
     * during subdivision so the signchangeGated gate can fire without a per-frontier GPU call.
     */
    cornerFeature: Float32Array | null
}

/** Constant list of the 19 flat indices `(x*3+y)*3+z` where any of `x,y,z === 1` (3×3×3 grid midpoints). */
const PARENT_MID_INDICES: readonly number[] = (() => {
    const out: number[] = []
    for (let x = 0; x < 3; x++) {
        for (let y = 0; y < 3; y++) {
            for (let z = 0; z < 3; z++) {
                if (x === 1 || y === 1 || z === 1) out.push((x * 3 + y) * 3 + z)
            }
        }
    }
    return out
})()
const PARENT_MID_COUNT = PARENT_MID_INDICES.length

/** Reverse map: flat 3×3×3 index → position 0..18 in {@link PARENT_MID_INDICES}. */
const PARENT_MID_TO_BATCH: ReadonlyMap<number, number> = new Map(PARENT_MID_INDICES.map((idx, i) => [idx, i]))

/**
 * Breadth-first octree construction with frontier-level GPU batching.
 *
 * Each iteration consumes all nodes at the current depth and issues at most 4 GPU dispatches
 * (Phase 1 lattice, Phase 2 re-eval, optional `nearFeature` mid-feature sample, parent midSdf
 * for the subdividing subset), each containing the work of every node at that depth. The
 * recursive shape — `evalNode → evalEightChildren → evalNodeAfterReEval → recurse` — would
 * have issued at least 2 round-trips per parent-of-8 octant; BFS keeps the dispatch count
 * to O(tree depth) instead of O(subdividing parent count).
 */
const QEF_OUT_STRIDE_LOCAL = 134

async function buildOctreeBFS(
    root: IsoOctreeNode,
    rootMin: readonly [number, number, number],
    rootMax: readonly [number, number, number],
    worldScale: number,
    C: IsoOctreeRuntimeConstants,
    sample: IsoOctreeBatchFn,
    signal: AbortSignal | undefined,
    counter: { n: number },
    featureRefine: IsoFeatureRefineOptions,
    perf: IsoOctreeBuildPerf,
    qefWorkerPool: QefWorkerPoolLike | undefined,
): Promise<void> {
    // Root starts with `cornerFeature: null`; the in-loop "Feature corner seeding" block
    // below issues a single mid-feature GPU batch on the first iteration to fill it.
    // Descendants inherit from their parent and never re-sample.
    let frontier: BFSEntry[] = [{ node: root, gradCorners: null, cornerFeature: null }]
    const invWorldScale = 1 / worldScale
    const minsize = 0.5 ** C.depthMax
    const maxsize = 0.5 ** C.depthMin
    const cellsPerFrontier: number[] = []

    while (frontier.length > 0) {
        counter.n += frontier.length
        cellsPerFrontier.push(frontier.length)

        // ── Phase 1 mega-batch ────────────────────────────────────────────────────
        const N = frontier.length
        const tOther0 = nowMs()
        const scratches = frontier.map(e => buildPhase1NormPts(e.node, C))
        const t1 = scratches[0]!.totalPhase1
        for (let i = 1; i < N; i++) {
            if (scratches[i]!.totalPhase1 !== t1) {
                throw new Error("iso-octree: frontier phase1 sample count mismatch (oversampleQef must match)")
            }
        }
        const bigPhase1 = new Float32Array(N * t1 * 3)
        for (let i = 0; i < N; i++) {
            const w = packWorldFromNorm4(scratches[i]!.normPts, t1, rootMin, rootMax)
            bigPhase1.set(w, i * t1 * 3)
        }
        perf.otherCpuMs += nowMs() - tOther0
        const tP10 = nowMs()
        const sdfBig = await sample(bigPhase1, signal)
        perf.phase1SampleMs += nowMs() - tP10

        // Seed root corner gradients from Phase 1 lattice (root entry has `gradCorners=null`).
        const tOther1 = nowMs()
        for (let i = 0; i < N; i++) {
            const entry = frontier[i]!
            if (!entry.gradCorners) {
                const slice = sdfBig.subarray(i * t1 * 4, (i + 1) * t1 * 4)
                const g = new Float32Array(24)
                for (let j = 0; j < 8; j++) {
                    const li = phase1LatticeIndexForCorner(j, C.oversampleQef)
                    const o = li * 4
                    entry.node.verts[j * 4 + 3] = slice[o + 3]!
                    g[j * 3] = slice[o]!
                    g[j * 3 + 1] = slice[o + 1]!
                    g[j * 3 + 2] = slice[o + 2]!
                }
                entry.gradCorners = g
            }
        }
        perf.otherCpuMs += nowMs() - tOther1

        // ── Feature corner seeding (root only; children inherit via subdivision) ─
        // Any entry whose `cornerFeature` is null at this point is unparented w.r.t.
        // feature data — in practice only the root, but the loop is general. Issues one
        // mid-feature batch for the union of all such entries' 8 corners.
        if (featureRefine.mode !== "off") {
            const seedIdx: number[] = []
            for (let i = 0; i < N; i++) if (frontier[i]!.cornerFeature === null) seedIdx.push(i)
            if (seedIdx.length > 0) {
                const tFSeedOther0 = nowMs()
                const seedPositions = new Float32Array(seedIdx.length * 8 * 3)
                for (let si = 0; si < seedIdx.length; si++) {
                    const entry = frontier[seedIdx[si]!]!
                    const baseOff = si * 8 * 3
                    for (let j = 0; j < 8; j++) {
                        const nx = entry.node.verts[j * 4]!
                        const ny = entry.node.verts[j * 4 + 1]!
                        const nz = entry.node.verts[j * 4 + 2]!
                        normToWorld(nx, ny, nz, rootMin, rootMax, seedPositions, baseOff + j * 3)
                    }
                }
                perf.otherCpuMs += nowMs() - tFSeedOther0
                const tFSeed0 = nowMs()
                const seedBuf = await featureRefine.sampleMidFeature!(seedPositions, signal)
                perf.nearFeatureSampleMs += nowMs() - tFSeed0
                const tFSeedOther1 = nowMs()
                const STRIDE = ISO_SAMPLE_BATCH_MID_FLOATS_PER_SAMPLE
                for (let si = 0; si < seedIdx.length; si++) {
                    const entry = frontier[seedIdx[si]!]!
                    const cf = new Float32Array(8 * STRIDE)
                    cf.set(seedBuf.subarray(si * 8 * STRIDE, (si + 1) * 8 * STRIDE))
                    entry.cornerFeature = cf
                }
                perf.otherCpuMs += nowMs() - tFSeedOther1
            }
        }

        // Compute per-node QEF + reEval positions (this is the hot CPU loop — 19 Jacobi solves / cell).
        const tQef0 = nowMs()
        const qefErrors = new Float64Array(N)
        const reNorms: Float32Array[] = new Array(N)
        if (qefWorkerPool && N >= qefWorkerPool.workerCount) {
            // Worker-pool path: pack inputs into SharedArrayBuffers (zero-copy across workers),
            // dispatch, then unpack the per-node results back into the node.
            const VERTS_STRIDE = 32
            const P1_STRIDE = t1 * 4
            const sharedVerts = new SharedArrayBuffer(N * VERTS_STRIDE * 4)
            const sharedNormPts = new SharedArrayBuffer(N * P1_STRIDE * 4)
            const sharedSdf = new SharedArrayBuffer(N * P1_STRIDE * 4)
            const sharedOut = new SharedArrayBuffer(N * QEF_OUT_STRIDE_LOCAL * 4)
            const vertsView = new Float32Array(sharedVerts)
            const normPtsView = new Float32Array(sharedNormPts)
            const sdfView = new Float32Array(sharedSdf)
            const outView = new Float32Array(sharedOut)
            for (let i = 0; i < N; i++) {
                vertsView.set(frontier[i]!.node.verts, i * VERTS_STRIDE)
                normPtsView.set(scratches[i]!.normPts, i * P1_STRIDE)
                sdfView.set(sdfBig.subarray(i * P1_STRIDE, (i + 1) * P1_STRIDE), i * P1_STRIDE)
            }
            // Pack per-node corner-feature data only when the feature-plane knob is on. Nodes
            // whose `cornerFeature` is null land as all-zeros (featureKind=0 at every corner),
            // which the worker skips naturally — no per-node "has-feature" flag needed.
            const planeOn = featureRefine.planeEnabled === true && featureRefine.mode === "signchangeGated"
            const CF_STRIDE = 8 * ISO_SAMPLE_BATCH_MID_FLOATS_PER_SAMPLE
            const sharedCornerFeature: SharedArrayBuffer | undefined = planeOn
                ? new SharedArrayBuffer(N * CF_STRIDE * 4)
                : undefined
            if (sharedCornerFeature) {
                const cfView = new Float32Array(sharedCornerFeature)
                for (let i = 0; i < N; i++) {
                    const cf = frontier[i]!.cornerFeature
                    if (cf) cfView.set(cf, i * CF_STRIDE)
                }
            }
            await qefWorkerPool.processBatch({
                sharedVerts, sharedNormPts, sharedSdf, sharedOut,
                nodeCount: N,
                scratchProto: scratches[0]!,
                oversampleQef: C.oversampleQef,
                dualVertexBorderFraction: C.dualVertexBorderFraction,
                invWorldScale,
                ...(sharedCornerFeature ? {
                    sharedCornerFeature,
                    featurePlaneEnabled: true,
                    featurePlaneDistFactor: featureRefine.planeDistFactor ?? 1.0,
                    rootMinX: rootMin[0], rootMinY: rootMin[1], rootMinZ: rootMin[2],
                    worldScale,
                } : {}),
            })
            for (let i = 0; i < N; i++) {
                const o = i * QEF_OUT_STRIDE_LOCAL
                const node = frontier[i]!.node
                node.node[0] = outView[o]!
                node.node[1] = outView[o + 1]!
                node.node[2] = outView[o + 2]!
                node.node[3] = outView[o + 3]!
                node.edges.set(outView.subarray(o + 4, o + 52))
                node.faces.set(outView.subarray(o + 52, o + 76))
                reNorms[i] = outView.slice(o + 76, o + 133)
                qefErrors[i] = outView[o + 133]!
            }
        } else {
            const planeOn = featureRefine.planeEnabled === true && featureRefine.mode === "signchangeGated"
            const planeDistFactor = featureRefine.planeDistFactor ?? 1.0
            for (let i = 0; i < N; i++) {
                const slice = sdfBig.subarray(i * t1 * 4, (i + 1) * t1 * 4)
                const cf = frontier[i]!.cornerFeature
                const cubeFeatureOpts: CubeFeaturePlaneOptions | undefined = planeOn && cf
                    ? {
                        cornerFeature: cf,
                        distFactor: planeDistFactor,
                        rootMinX: rootMin[0], rootMinY: rootMin[1], rootMinZ: rootMin[2],
                        worldScale,
                    }
                    : undefined
                const r = phase1SdfToReEvalNorm(frontier[i]!.node, scratches[i]!, slice, C, invWorldScale, cubeFeatureOpts)
                qefErrors[i] = r.qefError
                reNorms[i] = r.reEvalNorm
            }
        }
        perf.qefMs += nowMs() - tQef0

        // ── Phase 2 mega-batch (re-eval at chosen dual vertices) ─────────────────
        const tOther2 = nowMs()
        const bigReEval = new Float32Array(N * 19 * 3)
        for (let i = 0; i < N; i++) {
            const rn = reNorms[i]!
            const base = i * 19 * 3
            for (let j = 0; j < 19; j++) {
                normToWorld(rn[j * 3]!, rn[j * 3 + 1]!, rn[j * 3 + 2]!, rootMin, rootMax, bigReEval, base + j * 3)
            }
        }
        perf.otherCpuMs += nowMs() - tOther2
        const tP20 = nowMs()
        const sdfRe = await sample(bigReEval, signal)
        perf.phase2SampleMs += nowMs() - tP20
        const tOther3 = nowMs()
        for (let i = 0; i < N; i++) {
            applyReEvalDistances(frontier[i]!.node, sdfRe.subarray(i * 19 * 4, (i + 1) * 19 * 4))
        }
        perf.otherCpuMs += nowMs() - tOther3

        // ── Per-node subdivision decision (sync, fast) ────────────────────────────
        // `recurDecision[i]`:
        //   "no"             — definitely no subdivision (outside, hit depthMax, or all gates fail)
        //   "yes"            — definitely subdivide (isbig, or signchange+badqef)
        //   "needsFeature"   — signchangeGated + signchange + !badqef; recurs only if nearFeature
        type Decision = "no" | "yes" | "needsFeature"
        const tDecide0 = nowMs()
        const decisions: Decision[] = new Array(N)
        for (let i = 0; i < N; i++) {
            const entry = frontier[i]!
            if (isoOctreeIsOutside(entry.node.verts)) { decisions[i] = "no"; continue }
            const v0 = readV4(entry.node.verts, 0)
            const v7 = readV4(entry.node.verts, 7)
            const cellSize = v7[0] - v0[0]
            if (cellSize <= minsize) { decisions[i] = "no"; continue }
            const isbig = cellSize > maxsize
            const signchange = !isbig && isoOctreeChangesSign(entry.node.verts, entry.node.edges, entry.node.faces, entry.node.node)
            const badqef = qefErrors[i]! / cellSize > C.qefRelativeErrorRefineThreshold
            if (isbig || (signchange && badqef)) { decisions[i] = "yes" }
            else if (featureRefine.mode === "signchangeGated" && signchange && !isbig) { decisions[i] = "needsFeature" }
            else { decisions[i] = "no" }
        }
        perf.otherCpuMs += nowMs() - tDecide0

        // ── Resolve `needsFeature` from inherited corner samples (no GPU call) ─────
        // The 8 corners of every frontier cell already carry packed `SDFResultMid` data —
        // seeded at the root and inherited from parents at subdivision time. With the default
        // `proximityFactor=2.0`, any in-cell feature point is within `√3/2·cellSize ≈ 0.87·cellSize`
        // of *some* corner, so corner-only sampling covers the cell interior; a corner-derived
        // sample anywhere within the cell or within `proximityFactor·cellSize` of any corner
        // counts as "near".
        if (featureRefine.mode === "signchangeGated") {
            const tFD0 = nowMs()
            for (let i = 0; i < N; i++) {
                if (decisions[i] !== "needsFeature") continue
                const entry = frontier[i]!
                const cf = entry.cornerFeature
                if (!cf) {
                    // Defensive: bootstrap should have populated the root and every descendant inherits.
                    decisions[i] = "no"
                    continue
                }
                const v0 = readV4(entry.node.verts, 0)
                const v7 = readV4(entry.node.verts, 7)
                const cellSize = v7[0] - v0[0]
                const distThreshold = featureRefine.proximityFactor * cellSize * worldScale
                let near = false
                for (let j = 0; j < 8; j++) {
                    const { kind, dist } = readMidFeatureKindAndDist(cf, j)
                    if (kind !== MID_FEATURE_NONE_KIND && dist < distThreshold) { near = true; break }
                }
                decisions[i] = near ? "yes" : "no"
            }
            perf.otherCpuMs += nowMs() - tFD0
        }
        // (mode === "off" never produces "needsFeature" decisions — nothing to resolve.)

        // ── Parent midSdf mega-batch (only for subdividers) ───────────────────────
        const subdividerIdx: number[] = []
        for (let i = 0; i < N; i++) if (decisions[i] === "yes") subdividerIdx.push(i)
        if (subdividerIdx.length === 0) { frontier = []; continue }

        // Trilerp each subdividing parent's 27-point grid (corners + 19 midpoints in normalized coords).
        const tTrilerp0 = nowMs()
        const trilerpedGrids: Float32Array[] = new Array(subdividerIdx.length)
        const bigMidWorld = new Float32Array(subdividerIdx.length * PARENT_MID_COUNT * 3)
        for (let si = 0; si < subdividerIdx.length; si++) {
            const entry = frontier[subdividerIdx[si]!]!
            const p = new Float32Array(27 * 4)
            for (let x = 0; x < 3; x++) {
                for (let y = 0; y < 3; y++) {
                    for (let z = 0; z < 3; z++) {
                        trilinearP8(entry.node.verts, x, y, z, p, ((x * 3 + y) * 3 + z) * 4)
                    }
                }
            }
            trilerpedGrids[si] = p
            const baseOff = si * PARENT_MID_COUNT * 3
            for (let mi = 0; mi < PARENT_MID_COUNT; mi++) {
                const idxFlat = PARENT_MID_INDICES[mi]!
                normToWorld(
                    p[idxFlat * 4]!, p[idxFlat * 4 + 1]!, p[idxFlat * 4 + 2]!,
                    rootMin, rootMax,
                    bigMidWorld, baseOff + mi * 3,
                )
            }
        }
        perf.otherCpuMs += nowMs() - tTrilerp0
        // Parent midSdf + (optional) mid-feature batch at the same 19 midpoints, dispatched
        // concurrently — they don't share buffers and target different pipelines. The feature
        // batch is what lets every child inherit its 8-corner `SDFResultMid` without sampling.
        const tMid0 = nowMs()
        const wantChildFeature = featureRefine.mode === "signchangeGated" && featureRefine.sampleMidFeature !== undefined
        const sdfMidPromise = sample(bigMidWorld, signal)
        const midFeatPromise: Promise<Float32Array | null> = wantChildFeature
            ? featureRefine.sampleMidFeature!(bigMidWorld, signal)
            : Promise.resolve(null)
        const [sdfMidBig, midFeatBig] = await Promise.all([sdfMidPromise, midFeatPromise])
        const tMidElapsed = nowMs() - tMid0
        perf.midSampleMs += tMidElapsed
        if (wantChildFeature) perf.nearFeatureSampleMs += tMidElapsed
        const tChild0 = nowMs()

        // ── Construct children for each subdividing parent ────────────────────────
        const nextFrontier: BFSEntry[] = []
        for (let si = 0; si < subdividerIdx.length; si++) {
            const parentEntry = frontier[subdividerIdx[si]!]!
            const p = trilerpedGrids[si]!
            const sdfMidSlice = sdfMidBig.subarray(si * PARENT_MID_COUNT * 4, (si + 1) * PARENT_MID_COUNT * 4)
            // Fill p[idx][3] (SDF) at the 19 midpoint indices from the mega-batch readback.
            for (let mi = 0; mi < PARENT_MID_COUNT; mi++) {
                p[PARENT_MID_INDICES[mi]! * 4 + 3] = sdfMidSlice[mi * 4 + 3]!
            }
            // Slice of this parent's 19 mid-feature samples (28 floats each = 7 vec4).
            // `null` when feature mode is "off" — children get `cornerFeature = null` too.
            const midFeatSlice: Float32Array | null = midFeatBig
                ? midFeatBig.subarray(
                    si * PARENT_MID_COUNT * ISO_SAMPLE_BATCH_MID_FLOATS_PER_SAMPLE,
                    (si + 1) * PARENT_MID_COUNT * ISO_SAMPLE_BATCH_MID_FLOATS_PER_SAMPLE,
                )
                : null

            for (let ci = 0; ci < 8; ci++) {
                const child = createEmptyNode()
                parentEntry.node.children[ci] = child
                const gChild = new Float32Array(24)
                const ib = indexBits(ci)
                // Build child's 8-corner `SDFResultMid` payload by sourcing each corner from
                // the parent's 27-point feature grid: parent corners (when px,py,pz all even)
                // come from `parentEntry.cornerFeature`; midpoints come from `midFeatSlice`.
                const childCornerFeature: Float32Array | null = midFeatSlice && parentEntry.cornerFeature
                    ? new Float32Array(8 * ISO_SAMPLE_BATCH_MID_FLOATS_PER_SAMPLE)
                    : null
                for (let j = 0; j < 8; j++) {
                    const jb = indexBits(j)
                    const px = ib.x + jb.x
                    const py = ib.y + jb.y
                    const pz = ib.z + jb.z
                    const idxFlat = (px * 3 + py) * 3 + pz
                    writeV4(child.verts, j, p[idxFlat * 4]!, p[idxFlat * 4 + 1]!, p[idxFlat * 4 + 2]!, p[idxFlat * 4 + 3]!)
                    const g = gridGradient(px, py, pz, parentEntry.gradCorners!, PARENT_MID_TO_BATCH, sdfMidSlice)
                    gChild[j * 3] = g[0]!
                    gChild[j * 3 + 1] = g[1]!
                    gChild[j * 3 + 2] = g[2]!
                    if (childCornerFeature) {
                        const dstOff = j * ISO_SAMPLE_BATCH_MID_FLOATS_PER_SAMPLE
                        if (px === 1 || py === 1 || pz === 1) {
                            // Midpoint — sourced from this frontier's mid-feature batch.
                            const mi = PARENT_MID_TO_BATCH.get(idxFlat)
                            if (mi === undefined) throw new Error("iso-octree: missing midpoint feature index")
                            const srcOff = mi * ISO_SAMPLE_BATCH_MID_FLOATS_PER_SAMPLE
                            childCornerFeature.set(
                                midFeatSlice!.subarray(srcOff, srcOff + ISO_SAMPLE_BATCH_MID_FLOATS_PER_SAMPLE),
                                dstOff,
                            )
                        } else {
                            // Parent corner — sourced from the parent's inherited 8-corner feature payload.
                            const parentCornerIdx = cubeCornerIndex((px >> 1) as 0 | 1, (py >> 1) as 0 | 1, (pz >> 1) as 0 | 1)
                            const srcOff = parentCornerIdx * ISO_SAMPLE_BATCH_MID_FLOATS_PER_SAMPLE
                            childCornerFeature.set(
                                parentEntry.cornerFeature!.subarray(srcOff, srcOff + ISO_SAMPLE_BATCH_MID_FLOATS_PER_SAMPLE),
                                dstOff,
                            )
                        }
                    }
                }
                nextFrontier.push({ node: child, gradCorners: gChild, cornerFeature: childCornerFeature })
            }
        }
        perf.otherCpuMs += nowMs() - tChild0

        frontier = nextFrontier
    }

    perf.frontierCount = cellsPerFrontier.length
    perf.cellsPerFrontier = cellsPerFrontier
}
