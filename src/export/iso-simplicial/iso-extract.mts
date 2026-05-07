/**
 * Iso-simplicial mesh extraction: reference `traverse.h` (`TraversalType::trav_edge`)
 * plus `VisitorExtract` (`visitorextract.cpp`), Marching Tetrahedra (`tet_arrays`).
 *
 * Positions in `IsoOctreeNode` are stored in **normalized root-cell** coordinates in `[0,1]³`
 * (same as `IsoOctree.build`). Pass `worldBounds` to map vertices to world space for `MeshData`.
 *
 * **Phase 5 quality** (paper §4.1-style snap, reference `rootfind.h`): optional GPU bisection along
 * each Marching-Tetrahedra edge bracket (`binarySearch` + `function(p)`), then degenerate removal.
 * New field values always come from `phase5.sample` — never from CPU SDF. When `phase5.enabled` is
 * false, output matches the Agent-5 linear `findZero` path only.
 */

import type { MeshData } from "../export.mjs"
import { renormalizeTriangleNormals } from "../crease-split.mjs"
import { IsoSimplicialConstants } from "./constants.mjs"
import { cubeCornerIndex, cubeEdge2Vert, cubeFace2Opposite, cubeOrient2Edge } from "./cube-tables.mjs"
import { extractFaceTable, extractFlipTable } from "./extract-tables.mjs"
import { isoOctreeIsOutside, type IsoOctreeBatchFn, type IsoOctreeBounds, type IsoOctreeNode } from "./iso-octree.mjs"
import { tetEdge2Vert, tetTris } from "./tet-tables.mjs"

const VERT_STRIDE = 8

/** Default squared-area cutoff for {@link IsoExtractPhase5Options.minTriangleAreaSq}. */
export const ISO_EXTRACT_DEFAULT_MIN_TRIANGLE_AREA_SQ = 1e-28

export interface TraversalData {
    node: IsoOctreeNode
    depth: number
}

/**
 * Optional Phase 5 pass: GPU isosurface snap (`rootfind.h` bisection) plus degenerate triangle drop.
 * With `enabled: false` (default), {@link extractIsoSimplicialMesh} behaves as Agent 5 only.
 */
export interface IsoExtractPhase5Options {
    /** When true, apply degenerate filtering; when `sample` is set, also snap MT edge crossings. */
    enabled: boolean
    /**
     * GPU batch sampler (same contract as `IsoOctree.build` `sample`: world-space positions in,
     * interleaved `vec4` SDF out). Required for snap; omit to only filter degenerates (sync path).
     */
    sample?: IsoOctreeBatchFn
    /** Reference `FIND_ROOT_DEPTH` — bisection steps before terminal `findZero`. Default from constants. */
    findRootDepth?: number
    /** Squared triangle area below which triangles are dropped (after snap, in output coordinates). */
    minTriangleAreaSq?: number
    signal?: AbortSignal
}

export interface IsoExtractOptions {
    /** If set, maps normalized octree coordinates into world space (axis-aligned cube). */
    worldBounds?: IsoOctreeBounds
    phase5?: IsoExtractPhase5Options
}

/** One extracted triangle worth of Marching-Tetrahedra wedges for GPU snap (normalized coords). */
export interface IsoExtractPendingSnapTri {
    /** Copy of the six-point `vect4f` wedge (`visitorextract.cpp` layout), length 24. */
    wedge: Float32Array
    /** Three MT edges as corner indices 0..5 into `wedge`. */
    edgePairs: readonly [readonly [number, number], readonly [number, number], readonly [number, number]]
}

/** Reference `TNode::is_leaf` tests `children[0] == 0` only. */
export function isOctreeLeaf(node: IsoOctreeNode): boolean {
    return node.children[0] === null
}

export function genTrav(parent: TraversalData, childOctant: number, out: TraversalData): void {
    if (!isOctreeLeaf(parent.node)) {
        const ch = parent.node.children[childOctant]
        if (!ch) throw new Error("iso-extract: internal node missing child")
        out.node = ch
        out.depth = parent.depth + 1
    } else {
        out.node = parent.node
        out.depth = parent.depth
    }
}

function readVec4(buf: Float32Array, slot: number, into: Float32Array, intoOff: number): void {
    const b = slot * 4
    into[intoOff] = buf[b]!
    into[intoOff + 1] = buf[b + 1]!
    into[intoOff + 2] = buf[b + 2]!
    into[intoOff + 3] = buf[b + 3]!
}

function writeVec4(out: Float32Array, o: number, src: Float32Array, srcOff: number): void {
    out[o] = src[srcOff]!
    out[o + 1] = src[srcOff + 1]!
    out[o + 2] = src[srcOff + 2]!
    out[o + 3] = src[srcOff + 3]!
}

function avgVec4(a: Float32Array, aOff: number, b: Float32Array, bOff: number, out: Float32Array, o: number): void {
    out[o] = (a[aOff]! + b[bOff]!) * 0.5
    out[o + 1] = (a[aOff + 1]! + b[bOff + 1]!) * 0.5
    out[o + 2] = (a[aOff + 2]! + b[bOff + 2]!) * 0.5
    out[o + 3] = (a[aOff + 3]! + b[bOff + 3]!) * 0.5
}

function copyVec4(out: Float32Array, o: number, src: Float32Array, srcOff: number): void {
    out[o] = src[srcOff]!
    out[o + 1] = src[srcOff + 1]!
    out[o + 2] = src[srcOff + 2]!
    out[o + 3] = src[srcOff + 3]!
}

/** Linear zero crossing between two `vec4f` samples `(xyz, w)` — reference `findZero`. */
export function isoExtractFindZero(a: Float32Array, b: Float32Array): [number, number, number] {
    const fa = a[3]!
    const fb = b[3]!
    const denom = fa - fb
    if (!(Math.abs(denom) > 1e-30)) {
        return [(a[0]! + b[0]!) * 0.5, (a[1]! + b[1]!) * 0.5, (a[2]! + b[2]!) * 0.5]
    }
    const t = fa / denom
    return [a[0]! + t * (b[0]! - a[0]!), a[1]! + t * (b[1]! - a[1]!), a[2]! + t * (b[2]! - a[2]!)]
}

function isoExtractFindZeroFlat(p: Float32Array, ia: number, ib: number): [number, number, number] {
    const fa = p[ia + 3]!
    const fb = p[ib + 3]!
    const denom = fa - fb
    if (!(Math.abs(denom) > 1e-30)) {
        return [(p[ia]! + p[ib]!) * 0.5, (p[ia + 1]! + p[ib + 1]!) * 0.5, (p[ia + 2]! + p[ib + 2]!) * 0.5]
    }
    const t = fa / denom
    return [p[ia]! + t * (p[ib]! - p[ia]!), p[ia + 1]! + t * (p[ib + 1]! - p[ia + 1]!), p[ia + 2]! + t * (p[ib + 2]! - p[ia + 2]!)]
}

/** Reference `sign` in `rootfind.h` (`x[3] < 0 ? -1 : 1`). */
function isoExtractP5SignW(buf: Float32Array, off: number): number {
    return buf[off + 3]! < 0 ? -1 : 1
}

/** Map normalized octree xyz into coordinates passed to `IsoOctree.build` / `sample` (world AABB or identity). */
function isoExtractNormToSampleWorld(
    x: number,
    y: number,
    z: number,
    worldBounds: IsoOctreeBounds | undefined,
    out3: Float32Array,
): void {
    if (!worldBounds) {
        out3[0] = x
        out3[1] = y
        out3[2] = z
        return
    }
    const mn = worldBounds.min
    const mx = worldBounds.max
    out3[0] = mn[0]! + x * (mx[0]! - mn[0]!)
    out3[1] = mn[1]! + y * (mx[1]! - mn[1]!)
    out3[2] = mn[2]! + z * (mx[2]! - mn[2]!)
}

/**
 * Reference `binarySearch` in `rootfind.h` (iterative): bracket `a`/`b` as `vect4` in normalized space,
 * midpoint SDF from `sample` only. Returns crossing position in normalized coordinates.
 */
async function isoExtractSnapEdgeVertexGpu(
    sample: IsoOctreeBatchFn,
    signal: AbortSignal | undefined,
    findRootDepth: number,
    worldBounds: IsoOctreeBounds | undefined,
    wedge: Float32Array,
    i0: number,
    i1: number,
    scratchMid: Float32Array,
    copyA: Float32Array,
    copyB: Float32Array,
    worldIn: Float32Array,
): Promise<[number, number, number]> {
    const o0 = i0 * 4
    const o1 = i1 * 4
    if (findRootDepth <= 0) {
        return isoExtractFindZero(wedge.subarray(o0, o0 + 4), wedge.subarray(o1, o1 + 4))
    }
    copyA.set(wedge.subarray(o0, o0 + 4))
    copyB.set(wedge.subarray(o1, o1 + 4))
    for (let step = 0; step < findRootDepth; step++) {
        scratchMid[0] = (copyA[0]! + copyB[0]!) * 0.5
        scratchMid[1] = (copyA[1]! + copyB[1]!) * 0.5
        scratchMid[2] = (copyA[2]! + copyB[2]!) * 0.5
        isoExtractNormToSampleWorld(scratchMid[0]!, scratchMid[1]!, scratchMid[2]!, worldBounds, worldIn)
        const sdf = await sample(worldIn, signal)
        scratchMid[3] = sdf[3]!
        const sa = isoExtractP5SignW(copyA, 0)
        const sm = isoExtractP5SignW(scratchMid, 0)
        if (sa !== sm) {
            copyB.set(scratchMid)
        } else {
            copyA.set(scratchMid)
        }
    }
    return isoExtractFindZero(copyA, copyB)
}

/**
 * Drop triangles with squared area below `minAreaSq` (or non-finite area), compacting vertices.
 * Re-runs {@link renormalizeTriangleNormals} on the compact mesh.
 */
export function filterIsoExtractDegenerateTriangles(mesh: MeshData, minAreaSq: number): MeshData {
    const S = VERT_STRIDE
    const { verts, tris } = mesh
    const triCount = (tris.length / 3) | 0
    if (triCount === 0) return mesh

    const triAreaSq = (t: number): number => {
        const b = t * 3
        const i0 = tris[b]!
        const i1 = tris[b + 1]!
        const i2 = tris[b + 2]!
        const o0 = i0 * S
        const o1 = i1 * S
        const o2 = i2 * S
        const ax = verts[o1]! - verts[o0]!
        const ay = verts[o1 + 1]! - verts[o0 + 1]!
        const az = verts[o1 + 2]! - verts[o0 + 2]!
        const bx = verts[o2]! - verts[o0]!
        const by = verts[o2 + 1]! - verts[o0 + 1]!
        const bz = verts[o2 + 2]! - verts[o0 + 2]!
        const cx = ay * bz - az * by
        const cy = az * bx - ax * bz
        const cz = ax * by - ay * bx
        return cx * cx + cy * cy + cz * cz
    }

    const kept: number[] = []
    for (let t = 0; t < triCount; t++) {
        const a2 = triAreaSq(t)
        if (a2 >= minAreaSq && Number.isFinite(a2)) kept.push(t)
    }
    if (kept.length === triCount) return mesh

    const vertCount = (verts.length / S) | 0
    const used = new Uint8Array(vertCount)
    for (const t of kept) {
        const b = t * 3
        used[tris[b]!] = 1
        used[tris[b + 1]!] = 1
        used[tris[b + 2]!] = 1
    }
    const map = new Int32Array(vertCount).fill(-1)
    let nv = 0
    for (let i = 0; i < vertCount; i++) {
        if (used[i]) map[i] = nv++
    }
    const newVerts = new Float32Array(new ArrayBuffer(nv * S * 4))
    for (let i = 0; i < vertCount; i++) {
        const ni = map[i]!
        if (ni < 0) continue
        const src = i * S
        const dst = ni * S
        for (let k = 0; k < S; k++) {
            newVerts[dst + k] = verts[src + k]!
        }
    }
    const newTris = new Uint32Array(kept.length * 3)
    for (let j = 0; j < kept.length; j++) {
        const t = kept[j]!
        const b = t * 3
        newTris[j * 3] = map[tris[b]!]!
        newTris[j * 3 + 1] = map[tris[b + 1]!]!
        newTris[j * 3 + 2] = map[tris[b + 2]!]!
    }
    return renormalizeTriangleNormals(newVerts as Float32Array<ArrayBuffer>, newTris as Uint32Array<ArrayBuffer>)
}

class IsoExtractVisitor {
    private readonly scratchA = new Float32Array(4)
    private readonly scratchB = new Float32Array(4)
    private readonly verts: number[] = []
    private readonly tris: number[] = []
    private readonly pendingSnap: IsoExtractPendingSnapTri[] = []

    constructor(private readonly capturePendingSnap: boolean = false) {}

    getPendingSnapTris(): readonly IsoExtractPendingSnapTri[] {
        return this.pendingSnap
    }

    onNode(td: TraversalData): boolean {
        return !isOctreeLeaf(td.node)
    }

    onFace(td0: TraversalData, td1: TraversalData): boolean {
        return !(isOctreeLeaf(td0.node) && isOctreeLeaf(td1.node))
    }

    onEdge(td00: TraversalData, td10: TraversalData, td01: TraversalData, td11: TraversalData, orient: 0 | 1 | 2): boolean {
        if (!(isOctreeLeaf(td00.node) && isOctreeLeaf(td10.node) && isOctreeLeaf(td01.node) && isOctreeLeaf(td11.node))) {
            return true
        }

        const n: IsoOctreeNode[] = [td00.node, td10.node, td01.node, td11.node]
        const depths = [td00.depth, td10.depth, td01.depth, td11.depth]
        let small = 0
        for (let i = 1; i < 4; i++) {
            if (depths[i]! > depths[small]!) small = i
        }

        const edgeIdx = cubeOrient2Edge[orient]![small ^ 3]!
        const ev = cubeEdge2Vert[edgeIdx]!
        const edgeMid = n[small]!.edges
        const edgeLow = n[small]!.verts
        const edgeHigh = n[small]!.verts

        const p = new Float32Array(6 * 4)
        readVec4(edgeLow, ev[0], p, 0)
        readVec4(edgeMid, edgeIdx, p, 4)
        copyVec4(p, 16, p, 4)
        readVec4(edgeHigh, ev[1], p, 20)

        const faceTable = extractFaceTable[orient]!
        const flipTable = extractFlipTable[orient]!

        for (let i = 0; i < 4; i++) {
            if (isoOctreeIsOutside(n[i]!.verts)) continue

            const i1 = i ^ 1
            const i2 = i ^ 2
            const do1 = n[i] !== n[i1]
            const do2 = n[i] !== n[i2]

            const ft = faceTable[i ^ 3]!
            let face1 = this.scratchA
            let face2 = this.scratchB

            if (depths[i] === depths[i1]) {
                avgVec4(
                    n[i]!.faces,
                    ft[0]! * 4,
                    n[i1]!.faces,
                    cubeFace2Opposite[ft[0]!]! * 4,
                    face1,
                    0,
                )
            } else if (depths[i]! > depths[i1]!) {
                copyVec4(face1, 0, n[i]!.faces, ft[0]! * 4)
            } else {
                copyVec4(face1, 0, n[i1]!.faces, cubeFace2Opposite[ft[0]!]! * 4)
            }

            if (depths[i] === depths[i2]) {
                avgVec4(
                    n[i]!.faces,
                    ft[1]! * 4,
                    n[i2]!.faces,
                    cubeFace2Opposite[ft[1]!]! * 4,
                    face2,
                    0,
                )
            } else if (depths[i]! > depths[i2]!) {
                copyVec4(face2, 0, n[i]!.faces, ft[1]! * 4)
            } else {
                copyVec4(face2, 0, n[i2]!.faces, cubeFace2Opposite[ft[1]!]! * 4)
            }

            const flip = flipTable[i]!
            const cellNode = n[i]!.node

            if (flip) {
                if (do1) {
                    copyVec4(p, 8, face1, 0)
                    copyVec4(p, 12, cellNode, 0)
                    this.processTetHalf(p, [0, 1, 2, 3])
                    this.processTetHalf(p, [2, 3, 4, 5])
                }
                if (do2) {
                    copyVec4(p, 8, cellNode, 0)
                    copyVec4(p, 12, face2, 0)
                    this.processTetHalf(p, [0, 1, 2, 3])
                    this.processTetHalf(p, [2, 3, 4, 5])
                }
            } else {
                if (do1) {
                    copyVec4(p, 8, cellNode, 0)
                    copyVec4(p, 12, face1, 0)
                    this.processTetHalf(p, [0, 1, 2, 3])
                    this.processTetHalf(p, [2, 3, 4, 5])
                }
                if (do2) {
                    copyVec4(p, 8, face2, 0)
                    copyVec4(p, 12, cellNode, 0)
                    this.processTetHalf(p, [0, 1, 2, 3])
                    this.processTetHalf(p, [2, 3, 4, 5])
                }
            }
        }
        return false
    }

    /** Marching tetrahedra on four corners of `p` selected by global indices 0..5 (six-point wedge). */
    private processTetHalf(p: Float32Array, g: readonly [number, number, number, number]): void {
        const [g0, g1, g2, g3] = g
        const idx =
            (p[g0 * 4 + 3]! >= 0 ? 1 : 0) |
            (p[g1 * 4 + 3]! >= 0 ? 2 : 0) |
            (p[g2 * 4 + 3]! >= 0 ? 4 : 0) |
            (p[g3 * 4 + 3]! >= 0 ? 8 : 0)

        const row = tetTris[idx]!
        for (let t = 0; t < row.length; t += 3) {
            const e0 = row[t]
            if (e0 === undefined || e0 < 0) break
            const e1 = row[t + 1]!
            const e2 = row[t + 2]!
            const gc = [g0, g1, g2, g3]
            if (this.capturePendingSnap) {
                const wedge = new Float32Array(24)
                wedge.set(p)
                const ec0 = tetEdge2Vert[e0]!
                const ec1 = tetEdge2Vert[e1]!
                const ec2 = tetEdge2Vert[e2]!
                const ep0: readonly [number, number] = [gc[ec0[0]!]!, gc[ec0[1]!]!]
                const ep1: readonly [number, number] = [gc[ec1[0]!]!, gc[ec1[1]!]!]
                const ep2: readonly [number, number] = [gc[ec2[0]!]!, gc[ec2[1]!]!]
                this.pendingSnap.push({ wedge, edgePairs: [ep0, ep1, ep2] })
            } else {
                const tri: [number, number, number][] = []
                for (const e of [e0, e1, e2]) {
                    const ec = tetEdge2Vert[e]!
                    tri.push(isoExtractFindZeroFlat(p, gc[ec[0]!]! * 4, gc[ec[1]!]! * 4))
                }
                this.pushTriangle(tri[0]!, tri[1]!, tri[2]!)
            }
        }
    }

    private pushTriangle(a: [number, number, number], b: [number, number, number], c: [number, number, number]): void {
        const base = (this.verts.length / VERT_STRIDE) | 0
        for (const p of [a, b, c]) {
            this.verts.push(p[0]!, p[1]!, p[2]!, 0, 0, 0, 0, 0)
        }
        this.tris.push(base, base + 1, base + 2)
    }

    finish(worldBounds?: IsoOctreeBounds): MeshData {
        if (this.capturePendingSnap) {
            throw new Error("iso-extract: finish() is invalid in pending-snap mode — use extractIsoSimplicialMeshAsync")
        }
        const vn = this.verts.length / VERT_STRIDE
        const verts = new Float32Array(new ArrayBuffer(vn * VERT_STRIDE * 4))
        verts.set(this.verts)
        if (worldBounds) {
            const mn = worldBounds.min
            const mx = worldBounds.max
            const sx = mx[0]! - mn[0]!
            const sy = mx[1]! - mn[1]!
            const sz = mx[2]! - mn[2]!
            for (let i = 0; i < vn; i++) {
                const o = i * VERT_STRIDE
                verts[o] = mn[0]! + verts[o]! * sx
                verts[o + 1] = mn[1]! + verts[o + 1]! * sy
                verts[o + 2] = mn[2]! + verts[o + 2]! * sz
            }
        }
        const tris = new Uint32Array(this.tris)
        return renormalizeTriangleNormals(verts as Float32Array<ArrayBuffer>, tris as Uint32Array<ArrayBuffer>)
    }
}

const yzPairs = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
] as const

/** `TraversalType::trav_edge` — faces + edges, no vertex lattice. */
export function traverseIsoExtract(visitor: IsoExtractVisitor, td: TraversalData): void {
    traverseNode(visitor, td)
}

function traverseNode(visitor: IsoExtractVisitor, td: TraversalData): void {
    if (!visitor.onNode(td)) return

    const c: TraversalData[] = new Array(8)
    for (let i = 0; i < 8; i++) {
        c[i] = { node: td.node, depth: td.depth }
        genTrav(td, i, c[i]!)
        traverseNode(visitor, c[i]!)
    }

    for (const [iy, iz] of yzPairs) {
        traverseFaceX(visitor, c[cubeCornerIndex(0, iy, iz)]!, c[cubeCornerIndex(1, iy, iz)]!)
    }
    for (const [ix, iz] of yzPairs) {
        traverseFaceY(visitor, c[cubeCornerIndex(ix, 0, iz)]!, c[cubeCornerIndex(ix, 1, iz)]!)
    }
    for (const [ix, iy] of yzPairs) {
        traverseFaceZ(visitor, c[cubeCornerIndex(ix, iy, 0)]!, c[cubeCornerIndex(ix, iy, 1)]!)
    }

    for (const i of [0, 1] as const) {
        traverseEdgeX(
            visitor,
            c[cubeCornerIndex(i, 0, 0)]!,
            c[cubeCornerIndex(i, 1, 0)]!,
            c[cubeCornerIndex(i, 0, 1)]!,
            c[cubeCornerIndex(i, 1, 1)]!,
        )
        traverseEdgeY(
            visitor,
            c[cubeCornerIndex(0, i, 0)]!,
            c[cubeCornerIndex(1, i, 0)]!,
            c[cubeCornerIndex(0, i, 1)]!,
            c[cubeCornerIndex(1, i, 1)]!,
        )
        traverseEdgeZ(
            visitor,
            c[cubeCornerIndex(0, 0, i)]!,
            c[cubeCornerIndex(1, 0, i)]!,
            c[cubeCornerIndex(0, 1, i)]!,
            c[cubeCornerIndex(1, 1, i)]!,
        )
    }
}

function traverseFaceX(visitor: IsoExtractVisitor, n0: TraversalData, n1: TraversalData): void {
    if (!visitor.onFace(n0, n1)) return

    const c: TraversalData[] = new Array(8)
    for (const [iy, iz] of yzPairs) {
        const idxA = cubeCornerIndex(0, iy, iz)
        const idxB = cubeCornerIndex(1, iy, iz)
        c[idxA] = { node: n0.node, depth: n0.depth }
        c[idxB] = { node: n1.node, depth: n1.depth }
        genTrav(n0, cubeCornerIndex(1, iy, iz), c[idxA]!)
        genTrav(n1, cubeCornerIndex(0, iy, iz), c[idxB]!)
    }
    for (const [iy, iz] of yzPairs) {
        traverseFaceX(visitor, c[cubeCornerIndex(0, iy, iz)]!, c[cubeCornerIndex(1, iy, iz)]!)
    }

    for (const i of [0, 1] as const) {
        traverseEdgeY(
            visitor,
            c[cubeCornerIndex(0, i, 0)]!,
            c[cubeCornerIndex(1, i, 0)]!,
            c[cubeCornerIndex(0, i, 1)]!,
            c[cubeCornerIndex(1, i, 1)]!,
        )
        traverseEdgeZ(
            visitor,
            c[cubeCornerIndex(0, 0, i)]!,
            c[cubeCornerIndex(1, 0, i)]!,
            c[cubeCornerIndex(0, 1, i)]!,
            c[cubeCornerIndex(1, 1, i)]!,
        )
    }
}

function traverseFaceY(visitor: IsoExtractVisitor, n0: TraversalData, n1: TraversalData): void {
    if (!visitor.onFace(n0, n1)) return

    const c: TraversalData[] = new Array(8)
    for (const [ix, iz] of yzPairs) {
        const idxA = cubeCornerIndex(ix, 0, iz)
        const idxB = cubeCornerIndex(ix, 1, iz)
        c[idxA] = { node: n0.node, depth: n0.depth }
        c[idxB] = { node: n1.node, depth: n1.depth }
        genTrav(n0, cubeCornerIndex(ix, 1, iz), c[idxA]!)
        genTrav(n1, cubeCornerIndex(ix, 0, iz), c[idxB]!)
    }
    for (const [ix, iz] of yzPairs) {
        traverseFaceY(visitor, c[cubeCornerIndex(ix, 0, iz)]!, c[cubeCornerIndex(ix, 1, iz)]!)
    }

    for (const i of [0, 1] as const) {
        traverseEdgeX(
            visitor,
            c[cubeCornerIndex(i, 0, 0)]!,
            c[cubeCornerIndex(i, 1, 0)]!,
            c[cubeCornerIndex(i, 0, 1)]!,
            c[cubeCornerIndex(i, 1, 1)]!,
        )
        traverseEdgeZ(
            visitor,
            c[cubeCornerIndex(0, 0, i)]!,
            c[cubeCornerIndex(1, 0, i)]!,
            c[cubeCornerIndex(0, 1, i)]!,
            c[cubeCornerIndex(1, 1, i)]!,
        )
    }
}

function traverseFaceZ(visitor: IsoExtractVisitor, n0: TraversalData, n1: TraversalData): void {
    if (!visitor.onFace(n0, n1)) return

    const c: TraversalData[] = new Array(8)
    for (const [ix, iy] of yzPairs) {
        const idxA = cubeCornerIndex(ix, iy, 0)
        const idxB = cubeCornerIndex(ix, iy, 1)
        c[idxA] = { node: n0.node, depth: n0.depth }
        c[idxB] = { node: n1.node, depth: n1.depth }
        genTrav(n0, cubeCornerIndex(ix, iy, 1), c[idxA]!)
        genTrav(n1, cubeCornerIndex(ix, iy, 0), c[idxB]!)
    }
    for (const [ix, iy] of yzPairs) {
        traverseFaceZ(visitor, c[cubeCornerIndex(ix, iy, 0)]!, c[cubeCornerIndex(ix, iy, 1)]!)
    }

    for (const i of [0, 1] as const) {
        traverseEdgeX(
            visitor,
            c[cubeCornerIndex(i, 0, 0)]!,
            c[cubeCornerIndex(i, 1, 0)]!,
            c[cubeCornerIndex(i, 0, 1)]!,
            c[cubeCornerIndex(i, 1, 1)]!,
        )
        traverseEdgeY(
            visitor,
            c[cubeCornerIndex(0, i, 0)]!,
            c[cubeCornerIndex(1, i, 0)]!,
            c[cubeCornerIndex(0, i, 1)]!,
            c[cubeCornerIndex(1, i, 1)]!,
        )
    }
}

function traverseEdgeX(visitor: IsoExtractVisitor, n00: TraversalData, n10: TraversalData, n01: TraversalData, n11: TraversalData): void {
    if (!visitor.onEdge(n00, n10, n01, n11, 0)) return

    const c: TraversalData[] = new Array(8)
    for (const i of [0, 1] as const) {
        const i00 = cubeCornerIndex(i, 0, 0)
        const i10 = cubeCornerIndex(i, 1, 0)
        const i01 = cubeCornerIndex(i, 0, 1)
        const i11 = cubeCornerIndex(i, 1, 1)
        c[i00] = { node: n00.node, depth: n00.depth }
        c[i10] = { node: n10.node, depth: n10.depth }
        c[i01] = { node: n01.node, depth: n01.depth }
        c[i11] = { node: n11.node, depth: n11.depth }
        genTrav(n00, cubeCornerIndex(i, 1, 1), c[i00]!)
        genTrav(n10, cubeCornerIndex(i, 0, 1), c[i10]!)
        genTrav(n01, cubeCornerIndex(i, 1, 0), c[i01]!)
        genTrav(n11, cubeCornerIndex(i, 0, 0), c[i11]!)
    }
    for (const i of [0, 1] as const) {
        traverseEdgeX(
            visitor,
            c[cubeCornerIndex(i, 0, 0)]!,
            c[cubeCornerIndex(i, 1, 0)]!,
            c[cubeCornerIndex(i, 0, 1)]!,
            c[cubeCornerIndex(i, 1, 1)]!,
        )
    }
}

function traverseEdgeY(visitor: IsoExtractVisitor, n00: TraversalData, n10: TraversalData, n01: TraversalData, n11: TraversalData): void {
    if (!visitor.onEdge(n00, n10, n01, n11, 1)) return

    const c: TraversalData[] = new Array(8)
    for (const i of [0, 1] as const) {
        const i00 = cubeCornerIndex(0, i, 0)
        const i10 = cubeCornerIndex(1, i, 0)
        const i01 = cubeCornerIndex(0, i, 1)
        const i11 = cubeCornerIndex(1, i, 1)
        c[i00] = { node: n00.node, depth: n00.depth }
        c[i10] = { node: n10.node, depth: n10.depth }
        c[i01] = { node: n01.node, depth: n01.depth }
        c[i11] = { node: n11.node, depth: n11.depth }
        genTrav(n00, cubeCornerIndex(1, i, 1), c[i00]!)
        genTrav(n10, cubeCornerIndex(0, i, 1), c[i10]!)
        genTrav(n01, cubeCornerIndex(1, i, 0), c[i01]!)
        genTrav(n11, cubeCornerIndex(0, i, 0), c[i11]!)
    }
    for (const i of [0, 1] as const) {
        traverseEdgeY(
            visitor,
            c[cubeCornerIndex(0, i, 0)]!,
            c[cubeCornerIndex(1, i, 0)]!,
            c[cubeCornerIndex(0, i, 1)]!,
            c[cubeCornerIndex(1, i, 1)]!,
        )
    }
}

function traverseEdgeZ(visitor: IsoExtractVisitor, n00: TraversalData, n10: TraversalData, n01: TraversalData, n11: TraversalData): void {
    if (!visitor.onEdge(n00, n10, n01, n11, 2)) return

    const c: TraversalData[] = new Array(8)
    for (const i of [0, 1] as const) {
        const i00 = cubeCornerIndex(0, 0, i)
        const i10 = cubeCornerIndex(1, 0, i)
        const i01 = cubeCornerIndex(0, 1, i)
        const i11 = cubeCornerIndex(1, 1, i)
        c[i00] = { node: n00.node, depth: n00.depth }
        c[i10] = { node: n10.node, depth: n10.depth }
        c[i01] = { node: n01.node, depth: n01.depth }
        c[i11] = { node: n11.node, depth: n11.depth }
        genTrav(n00, cubeCornerIndex(1, 1, i), c[i00]!)
        genTrav(n10, cubeCornerIndex(0, 1, i), c[i10]!)
        genTrav(n01, cubeCornerIndex(1, 0, i), c[i01]!)
        genTrav(n11, cubeCornerIndex(0, 0, i), c[i11]!)
    }
    for (const i of [0, 1] as const) {
        traverseEdgeZ(
            visitor,
            c[cubeCornerIndex(0, 0, i)]!,
            c[cubeCornerIndex(1, 0, i)]!,
            c[cubeCornerIndex(0, 1, i)]!,
            c[cubeCornerIndex(1, 1, i)]!,
        )
    }
}

async function meshFromPendingSnap(
    pending: readonly IsoExtractPendingSnapTri[],
    worldBounds: IsoOctreeBounds | undefined,
    phase5: IsoExtractPhase5Options,
): Promise<MeshData> {
    const sample = phase5.sample
    if (!sample) {
        throw new Error("iso-extract: meshFromPendingSnap requires phase5.sample")
    }
    const findRootDepth = phase5.findRootDepth ?? IsoSimplicialConstants.findRootDepth
    const signal = phase5.signal
    const scratchMid = new Float32Array(4)
    const copyA = new Float32Array(4)
    const copyB = new Float32Array(4)
    const worldIn = new Float32Array(3)
    const verts: number[] = []
    const tris: number[] = []

    for (const tri of pending) {
        const p0 = await isoExtractSnapEdgeVertexGpu(
            sample,
            signal,
            findRootDepth,
            worldBounds,
            tri.wedge,
            tri.edgePairs[0]![0],
            tri.edgePairs[0]![1],
            scratchMid,
            copyA,
            copyB,
            worldIn,
        )
        const p1 = await isoExtractSnapEdgeVertexGpu(
            sample,
            signal,
            findRootDepth,
            worldBounds,
            tri.wedge,
            tri.edgePairs[1]![0],
            tri.edgePairs[1]![1],
            scratchMid,
            copyA,
            copyB,
            worldIn,
        )
        const p2 = await isoExtractSnapEdgeVertexGpu(
            sample,
            signal,
            findRootDepth,
            worldBounds,
            tri.wedge,
            tri.edgePairs[2]![0],
            tri.edgePairs[2]![1],
            scratchMid,
            copyA,
            copyB,
            worldIn,
        )
        const base = (verts.length / VERT_STRIDE) | 0
        for (const p of [p0, p1, p2]) {
            verts.push(p[0]!, p[1]!, p[2]!, 0, 0, 0, 0, 0)
        }
        tris.push(base, base + 1, base + 2)
    }

    const vn = (verts.length / VERT_STRIDE) | 0
    const vertBuf = new Float32Array(new ArrayBuffer(vn * VERT_STRIDE * 4))
    vertBuf.set(verts)
    if (worldBounds) {
        const mn = worldBounds.min
        const mx = worldBounds.max
        const sx = mx[0]! - mn[0]!
        const sy = mx[1]! - mn[1]!
        const sz = mx[2]! - mn[2]!
        for (let i = 0; i < vn; i++) {
            const o = i * VERT_STRIDE
            vertBuf[o] = mn[0]! + vertBuf[o]! * sx
            vertBuf[o + 1] = mn[1]! + vertBuf[o + 1]! * sy
            vertBuf[o + 2] = mn[2]! + vertBuf[o + 2]! * sz
        }
    }
    const triBuf = new Uint32Array(tris)
    return renormalizeTriangleNormals(vertBuf as Float32Array<ArrayBuffer>, triBuf as Uint32Array<ArrayBuffer>)
}

/**
 * Extract a triangle mesh from a built iso-simplicial octree (`IsoOctree.build`).
 *
 * When `options.phase5.enabled` is true and `phase5.sample` is set, throws — use
 * {@link extractIsoSimplicialMeshAsync} so midpoint refinement can call the GPU batch.
 */
export function extractIsoSimplicialMesh(tree: { root: IsoOctreeNode }, options?: IsoExtractOptions): MeshData {
    const p5 = options?.phase5
    if (p5?.enabled && p5.sample) {
        throw new Error(
            "extractIsoSimplicialMesh: phase5 with sample requires extractIsoSimplicialMeshAsync (GPU snap is async)",
        )
    }
    const visitor = new IsoExtractVisitor(false)
    traverseIsoExtract(visitor, { node: tree.root, depth: 0 })
    let mesh = visitor.finish(options?.worldBounds)
    if (p5?.enabled) {
        const minA = p5.minTriangleAreaSq ?? ISO_EXTRACT_DEFAULT_MIN_TRIANGLE_AREA_SQ
        mesh = filterIsoExtractDegenerateTriangles(mesh, minA)
    }
    return mesh
}

/**
 * Same as {@link extractIsoSimplicialMesh}, but resolves Phase 5 GPU snap when `phase5.enabled` and
 * `phase5.sample` are both set.
 */
export async function extractIsoSimplicialMeshAsync(
    tree: { root: IsoOctreeNode },
    options?: IsoExtractOptions,
): Promise<MeshData> {
    const p5 = options?.phase5
    if (!p5?.enabled || !p5.sample) {
        return extractIsoSimplicialMesh(tree, options)
    }
    const visitor = new IsoExtractVisitor(true)
    traverseIsoExtract(visitor, { node: tree.root, depth: 0 })
    let mesh = await meshFromPendingSnap(visitor.getPendingSnapTris(), options?.worldBounds, p5)
    const minA = p5.minTriangleAreaSq ?? ISO_EXTRACT_DEFAULT_MIN_TRIANGLE_AREA_SQ
    mesh = filterIsoExtractDegenerateTriangles(mesh, minA)
    return mesh
}
