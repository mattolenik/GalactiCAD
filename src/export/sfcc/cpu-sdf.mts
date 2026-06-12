/**
 * CPU-side f64 SDF evaluator for the SFCC v1 scene subset.
 *
 * `compileCpuSdf` walks the scene tree and builds closure-based evaluators
 * mirroring the hg_sdf.wgsl formulas (see cpu-sdf-primitives.mts for the one
 * documented deviation: the exact cylinder interior). Subtract is folded into
 * pure min/max form by tracking negation parity, so the compiled tree is
 * min/max combiners over *signed leaves* — which makes the CSG-aware
 * winner-set ownership queries (`activeOwnersAt` / `activeStrataAt`) a uniform
 * recursion, and pre-bakes difference orientation into every leaf's
 * f/normal/strata (downstream code never thinks about it again).
 *
 * Supported subset: Box, Sphere, Cylinder (fillet/chamfer = 0), Cone, Extrude
 * (straight-segment Polygon2D profiles, twist included); hard
 * Union/Subtract/Intersect (radius = 0); Translate / Rotate / uniform positive
 * Scale. Anything else throws {@link SfccUnsupportedError} listing every
 * offending node — no silent degradation: a primitive missing from the
 * certified pipeline would falsify every certificate downstream.
 *
 * Lipschitz: every leaf except the twisted extrude is an exact SDF (L = 1;
 * rigid transforms and the WGSL min-axis uniform-scale compensation preserve
 * it). Twisted extrudes exceed 1 by twistRate × radial distance and publish
 * {@link CpuSdfLeaf.localLipschitz}; `intervalOverBox` composes per-leaf
 * centered forms through the min/max tree, so certificates stay sound.
 */

import type { Node } from "../../scene/base.mjs"
import { Box } from "../../scene/primitives/box.mjs"
import { Sphere } from "../../scene/primitives/sphere.mjs"
import { Cylinder } from "../../scene/primitives/cylinder.mjs"
import { Cone } from "../../scene/primitives/cone.mjs"
import { Extrude } from "../../scene/primitives/extrude.mjs"
import { polygon2dWindingSign } from "../../scene/primitives/polygon2d.mjs"
import { Union } from "../../scene/operators/union.mjs"
import { Subtract } from "../../scene/operators/subtract.mjs"
import { Intersect } from "../../scene/operators/intersect.mjs"
import { Translate } from "../../scene/operators/translate.mjs"
import { Rotate } from "../../scene/operators/rotate.mjs"
import { Scale } from "../../scene/operators/scale.mjs"
import {
    applyPoint,
    composeSimilarity,
    identitySimilarity,
    rotateVector,
    invApplyPoint,
    similarityFromRotationWgslFwd,
    similarityFromTranslation,
    similarityFromUniformScale,
    type Similarity,
} from "./transform-bake.mjs"
import {
    boxDist,
    boxNormal,
    coneDist,
    coneNormal,
    cylinderDist,
    cylinderNormal,
    extrudeDist,
    extrudeNormal,
    sphereDist,
    sphereNormal,
} from "./cpu-sdf-primitives.mjs"
import {
    makeConeStratum,
    makeCylinderStratum,
    makePlaneStratum,
    makeSphereStratum,
    makeTwistedSideStratum,
    type SfccStratum,
} from "./strata.mjs"

export interface SfccUnsupportedNode {
    nodeId: number
    shapeType: string
    reason: string
}

export class SfccUnsupportedError extends Error {
    readonly unsupported: SfccUnsupportedNode[]

    constructor(unsupported: SfccUnsupportedNode[]) {
        const list = unsupported.map(u => `${u.shapeType} (#${u.nodeId}): ${u.reason}`).join("; ")
        super(`SFCC export does not support: ${list}`)
        this.name = "SfccUnsupportedError"
        this.unsupported = unsupported
    }
}

export interface CpuSdfLeaf {
    /** Index into CpuSdfTree.leaves. */
    readonly index: number
    /** Scene node id (−1 when the tree was never built into a SceneInfo, e.g. unit tests). */
    readonly nodeId: number
    /** The source primitive node (for native-feature extraction). */
    readonly sceneNode: Node
    readonly shapeType: string
    /** −1 iff under an odd number of Subtract right-hand ancestors (baked into f/normal/strata). */
    readonly sign: 1 | -1
    /** Baked world-from-local similarity. */
    readonly sim: Similarity
    /** Signed world distance, orientation-baked: negative inside the *final* solid's material contributed by this leaf. */
    f(px: number, py: number, pz: number): number
    /** Unit gradient direction of `f` (world space, sign-baked); writes into `out` at `off`. */
    normal(px: number, py: number, pz: number, out: Float64Array, off?: number): void
    /** This leaf's smooth patches. */
    readonly strata: SfccStratum[]
    /** Conservative world AABB [minX,minY,minZ,maxX,maxY,maxZ] of the primitive surface. */
    readonly aabb: Float64Array
    /**
     * Bound on |∇f| over the world-space ball (center, radius). Absent = 1
     * (exact SDF). Twisted extrudes exceed 1 by twistRate × radial distance —
     * certificates must use this, never assume global 1-Lipschitz.
     */
    localLipschitz?(cx: number, cy: number, cz: number, r: number): number
}

export interface ActiveOwner {
    leaf: CpuSdfLeaf
    /** The leaf's signed distance at the query point. */
    d: number
}

export interface ActiveStratum {
    stratum: SfccStratum
    /** The stratum's signed carrier distance at the query point. */
    d: number
}

export interface CpuSdfTree {
    /** Signed distance of the full tree (~exact SDF, 1-Lipschitz, negative inside). */
    f(px: number, py: number, pz: number): number
    /** One-sided unit gradient (the winning leaf's analytic normal); writes into `out` at `off`. */
    grad(px: number, py: number, pz: number, out: Float64Array, off?: number): void
    /** Certified enclosure of f over an axis-aligned box via the L=1 centered form. */
    intervalOverBox(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): [number, number]
    readonly leaves: CpuSdfLeaf[]
    /** All strata across all leaves; index = stratum id. */
    readonly strata: SfccStratum[]
    /**
     * CSG-aware winner set: the leaves whose surfaces can own the point, i.e.
     * leaves within `tol` of the winning value at every min/max combiner on
     * their path. Two owners ⇒ boolean seam, three+ ⇒ seam corner. Only
     * meaningful near the surface; `tol` should scale with the caller's probe
     * geometry.
     */
    activeOwnersAt(px: number, py: number, pz: number, tol: number): ActiveOwner[]
    /**
     * Active smooth patches at a near-surface point: for each active owner
     * leaf, its strata whose |carrier distance| is within `stratumTol` of the
     * leaf's closest patch. One ⇒ smooth, two ⇒ primitive edge or seam pair,
     * three ⇒ native corner.
     */
    activeStrataAt(px: number, py: number, pz: number, ownerTol: number, stratumTol: number): ActiveStratum[]
}

type CsgNode =
    | { readonly op: "leaf"; readonly leaf: CpuSdfLeaf }
    | { readonly op: "min" | "max"; readonly children: CsgNode[] }

interface CompileState {
    unsupported: SfccUnsupportedNode[]
    leaves: CpuSdfLeaf[]
    strata: SfccStratum[]
}

function nodeIdOf(node: Node): number {
    const id = (node as { id?: number }).id
    return typeof id === "number" ? id : -1
}

function unsupported(state: CompileState, node: Node, reason: string): null {
    state.unsupported.push({ nodeId: nodeIdOf(node), shapeType: node.getShapeType(), reason })
    return null
}

/** World AABB of a local box [cx±hx, cy±hy, cz±hz] under a similarity (8-corner transform). */
function worldAabbOfLocalBox(
    sim: Similarity,
    cx: number,
    cy: number,
    cz: number,
    hx: number,
    hy: number,
    hz: number,
): Float64Array {
    const out = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity])
    const p = new Float64Array(3)
    for (let i = 0; i < 8; i++) {
        const x = cx + ((i & 1) ? hx : -hx)
        const y = cy + ((i & 2) ? hy : -hy)
        const z = cz + ((i & 4) ? hz : -hz)
        applyPoint(sim, x, y, z, p)
        for (let a = 0; a < 3; a++) {
            if (p[a]! < out[a]!) out[a] = p[a]!
            if (p[a]! > out[a + 3]!) out[a + 3] = p[a]!
        }
    }
    return out
}

interface LeafSpec {
    node: Node
    /** Local distance after the `p − pos` shift is already applied by the caller. */
    dist(lx: number, ly: number, lz: number): number
    normalLocal(lx: number, ly: number, lz: number, out: Float64Array): void
    posX: number
    posY: number
    posZ: number
    /** Local AABB (center ± half) of the primitive, pos included. */
    aabbLocal: [number, number, number, number, number, number]
    /** Build strata in world space (identity fields filled by the caller). */
    buildStrata(leafIndex: number, sign: 1 | -1, sim: Similarity, firstId: number): SfccStratum[]
    /** Optional non-unit gradient bound (see CpuSdfLeaf.localLipschitz). */
    localLipschitz?(sim: Similarity): (cx: number, cy: number, cz: number, r: number) => number
}

function makeLeaf(state: CompileState, spec: LeafSpec, sim: Similarity, neg: boolean): CsgNode {
    const sign: 1 | -1 = neg ? -1 : 1
    const index = state.leaves.length
    const { posX, posY, posZ } = spec
    const scratch = new Float64Array(3)
    const nScratch = new Float64Array(3)
    const f = (px: number, py: number, pz: number): number => {
        invApplyPoint(sim, px, py, pz, scratch)
        return sign * sim.s * spec.dist(scratch[0]! - posX, scratch[1]! - posY, scratch[2]! - posZ)
    }
    const normal = (px: number, py: number, pz: number, out: Float64Array, off = 0): void => {
        invApplyPoint(sim, px, py, pz, scratch)
        spec.normalLocal(scratch[0]! - posX, scratch[1]! - posY, scratch[2]! - posZ, nScratch)
        rotateVector(sim, nScratch[0]!, nScratch[1]!, nScratch[2]!, out, off)
        out[off] = sign * out[off]!
        out[off + 1] = sign * out[off + 1]!
        out[off + 2] = sign * out[off + 2]!
    }
    const [acx, acy, acz, ahx, ahy, ahz] = spec.aabbLocal
    const strata = spec.buildStrata(index, sign, sim, state.strata.length)
    const leaf: CpuSdfLeaf = {
        index,
        nodeId: nodeIdOf(spec.node),
        sceneNode: spec.node,
        shapeType: spec.node.getShapeType(),
        sign,
        sim,
        f,
        normal,
        strata,
        aabb: worldAabbOfLocalBox(sim, acx, acy, acz, ahx, ahy, ahz),
        localLipschitz: spec.localLipschitz?.(sim),
    }
    state.leaves.push(leaf)
    state.strata.push(...strata)
    return { op: "leaf", leaf }
}

/** World-space plane stratum from a local plane f = n·x + off under `sim` (sign applied by the stratum). */
function worldPlane(
    ident: { id: number; ownerNodeId: number; leafIndex: number; localIndex: number; sign: 1 | -1 },
    sim: Similarity,
    nx: number,
    ny: number,
    nz: number,
    off: number,
): SfccStratum {
    const n = new Float64Array(3)
    rotateVector(sim, nx, ny, nz, n)
    const offW = sim.s * off - (n[0]! * sim.t[0]! + n[1]! * sim.t[1]! + n[2]! * sim.t[2]!)
    return makePlaneStratum(ident, n[0]!, n[1]!, n[2]!, offW)
}

function walk(state: CompileState, node: Node, sim: Similarity, neg: boolean): CsgNode | null {
    // --- primitives ----------------------------------------------------------
    if (node instanceof Box) {
        const px = node.pos.x
        const py = node.pos.y
        const pz = node.pos.z
        const hx = node.size.x
        const hy = node.size.y
        const hz = node.size.z
        return makeLeaf(
            state,
            {
                node,
                dist: (x, y, z) => boxDist(x, y, z, hx, hy, hz),
                normalLocal: (x, y, z, out) => boxNormal(x, y, z, hx, hy, hz, out),
                posX: px,
                posY: py,
                posZ: pz,
                aabbLocal: [px, py, pz, hx, hy, hz],
                buildStrata: (leafIndex, sign, s, firstId) => {
                    const mk = (i: number, nx: number, ny: number, nz: number, off: number) =>
                        worldPlane(
                            { id: firstId + i, ownerNodeId: nodeIdOf(node), leafIndex, localIndex: i, sign },
                            s,
                            nx,
                            ny,
                            nz,
                            off,
                        )
                    return [
                        mk(0, 1, 0, 0, -(px + hx)),
                        mk(1, -1, 0, 0, px - hx),
                        mk(2, 0, 1, 0, -(py + hy)),
                        mk(3, 0, -1, 0, py - hy),
                        mk(4, 0, 0, 1, -(pz + hz)),
                        mk(5, 0, 0, -1, pz - hz),
                    ]
                },
            },
            sim,
            neg,
        )
    }
    if (node instanceof Sphere) {
        const px = node.pos.x
        const py = node.pos.y
        const pz = node.pos.z
        const r = node.r
        return makeLeaf(
            state,
            {
                node,
                dist: (x, y, z) => sphereDist(x, y, z, r),
                normalLocal: (x, y, z, out) => sphereNormal(x, y, z, out),
                posX: px,
                posY: py,
                posZ: pz,
                aabbLocal: [px, py, pz, r, r, r],
                buildStrata: (leafIndex, sign, s, firstId) => {
                    const c = new Float64Array(3)
                    applyPoint(s, px, py, pz, c)
                    return [
                        makeSphereStratum(
                            { id: firstId, ownerNodeId: nodeIdOf(node), leafIndex, localIndex: 0, sign },
                            c[0]!,
                            c[1]!,
                            c[2]!,
                            s.s * r,
                        ),
                    ]
                },
            },
            sim,
            neg,
        )
    }
    if (node instanceof Cylinder) {
        if (node.filletTop !== 0 || node.filletBottom !== 0 || node.chamferTop !== 0 || node.chamferBottom !== 0) {
            return unsupported(state, node, "cylinder fillet/chamfer (needs a torus carrier — v1.5)")
        }
        const px = node.pos.x
        const py = node.pos.y
        const pz = node.pos.z
        const r = node.r
        const h = node.h
        return makeLeaf(
            state,
            {
                node,
                dist: (x, y, z) => cylinderDist(x, y, z, r, h),
                normalLocal: (x, y, z, out) => cylinderNormal(x, y, z, r, h, out),
                posX: px,
                posY: py,
                posZ: pz,
                aabbLocal: [px, py, pz, r, h, r],
                buildStrata: (leafIndex, sign, s, firstId) => {
                    const ownerNodeId = nodeIdOf(node)
                    const a = new Float64Array(3)
                    applyPoint(s, px, py, pz, a)
                    const u = new Float64Array(3)
                    rotateVector(s, 0, 1, 0, u)
                    return [
                        makeCylinderStratum(
                            { id: firstId, ownerNodeId, leafIndex, localIndex: 0, sign },
                            a[0]!,
                            a[1]!,
                            a[2]!,
                            u[0]!,
                            u[1]!,
                            u[2]!,
                            s.s * r,
                        ),
                        worldPlane({ id: firstId + 1, ownerNodeId, leafIndex, localIndex: 1, sign }, s, 0, 1, 0, -(py + h)),
                        worldPlane({ id: firstId + 2, ownerNodeId, leafIndex, localIndex: 2, sign }, s, 0, -1, 0, py - h),
                    ]
                },
            },
            sim,
            neg,
        )
    }
    if (node instanceof Cone) {
        const px = node.pos.x
        const py = node.pos.y
        const pz = node.pos.z
        const r = node.r
        const h = node.h
        return makeLeaf(
            state,
            {
                node,
                dist: (x, y, z) => coneDist(x, y, z, r, h),
                normalLocal: (x, y, z, out) => coneNormal(x, y, z, r, h, out),
                posX: px,
                posY: py,
                posZ: pz,
                aabbLocal: [px, py + h * 0.5, pz, r, h * 0.5, r],
                buildStrata: (leafIndex, sign, s, firstId) => {
                    const ownerNodeId = nodeIdOf(node)
                    const apex = new Float64Array(3)
                    applyPoint(s, px, py + h, pz, apex)
                    const u = new Float64Array(3)
                    rotateVector(s, 0, -1, 0, u)
                    const L = Math.hypot(h, r)
                    return [
                        makeConeStratum(
                            { id: firstId, ownerNodeId, leafIndex, localIndex: 0, sign },
                            apex[0]!,
                            apex[1]!,
                            apex[2]!,
                            u[0]!,
                            u[1]!,
                            u[2]!,
                            r / L,
                            h / L,
                        ),
                        worldPlane({ id: firstId + 1, ownerNodeId, leafIndex, localIndex: 1, sign }, s, 0, -1, 0, py),
                    ]
                },
            },
            sim,
            neg,
        )
    }

    if (node instanceof Extrude) {
        const px = node.pos.x
        const py = node.pos.y
        const pz = node.pos.z
        const h = node.h
        const twistRad = (node.twistDegrees * Math.PI) / 180
        const polyVerts = node.child.vertices
        const N = polyVerts.length
        const verts = new Float64Array(N * 2)
        let rMax = 0
        for (let i = 0; i < N; i++) {
            verts[i * 2] = polyVerts[i]![0]
            verts[i * 2 + 1] = polyVerts[i]![1]
            rMax = Math.max(rMax, Math.hypot(polyVerts[i]![0], polyVerts[i]![1]))
        }
        const windSign = polygon2dWindingSign(polyVerts)
        const k = Math.abs(h) > 1e-9 ? twistRad / (2 * h) : 0
        return makeLeaf(
            state,
            {
                node,
                dist: (x, y, z) => extrudeDist(verts, windSign, h, twistRad, x, y, z),
                normalLocal: (x, y, z, out) => extrudeNormal(verts, windSign, h, twistRad, x, y, z, out),
                posX: px,
                posY: py,
                posZ: pz,
                // The twist sweeps the polygon within its circumradius.
                aabbLocal: [px, py, pz, rMax, h, rMax],
                buildStrata: (leafIndex, sign, s, firstId) => {
                    const ownerNodeId = nodeIdOf(node)
                    const out: SfccStratum[] = []
                    for (let i = 0; i < N; i++) {
                        const v0x = verts[i * 2]!
                        const v0z = verts[i * 2 + 1]!
                        const v1x = verts[((i + 1) % N) * 2]!
                        const v1z = verts[((i + 1) % N) * 2 + 1]!
                        const ex = v1x - v0x
                        const ez = v1z - v0z
                        const eLen = Math.hypot(ex, ez)
                        // Outward 2D normal (matches the WGSL face-selection math):
                        // eNorm = (eTan.z, −eTan.x) · windSign.
                        const nx2 = ((ez / eLen) * windSign) as number
                        const nz2 = ((-ex / eLen) * windSign) as number
                        const ident = { id: firstId + i, ownerNodeId, leafIndex, localIndex: i, sign }
                        if (twistRad === 0) {
                            out.push(
                                worldPlane(ident, s, nx2, 0, nz2, -(nx2 * (px + v0x) + nz2 * (pz + v0z))),
                            )
                        } else {
                            out.push(
                                makeTwistedSideStratum(ident, {
                                    sim: s,
                                    posX: px,
                                    posY: py,
                                    posZ: pz,
                                    h,
                                    twistRad,
                                    v0x,
                                    v0z,
                                    nx2,
                                    nz2,
                                }),
                            )
                        }
                    }
                    out.push(
                        worldPlane({ id: firstId + N, ownerNodeId, leafIndex, localIndex: N, sign }, s, 0, 1, 0, -(py + h)),
                        worldPlane(
                            { id: firstId + N + 1, ownerNodeId, leafIndex, localIndex: N + 1, sign },
                            s,
                            0,
                            -1,
                            0,
                            py - h,
                        ),
                    )
                    return out
                },
                localLipschitz:
                    twistRad === 0
                        ? undefined
                        : s => {
                              const scratch = new Float64Array(3)
                              return (cx, cy, cz, r) => {
                                  invApplyPoint(s, cx, cy, cz, scratch)
                                  const rl = r / s.s
                                  const rho = Math.hypot(scratch[0]! - px, scratch[2]! - pz) + rl
                                  return Math.sqrt(1 + k * rho * (k * rho))
                              }
                          },
            },
            sim,
            neg,
        )
    }

    // --- transforms -----------------------------------------------------------
    if (node instanceof Translate) {
        return walk(state, node.arg, composeSimilarity(sim, similarityFromTranslation(node.dx, node.dy, node.dz)), neg)
    }
    if (node instanceof Rotate) {
        return walk(state, node.arg, composeSimilarity(sim, similarityFromRotationWgslFwd(node.getWgslMatrices().fwd)), neg)
    }
    if (node instanceof Scale) {
        if (node.sx !== node.sy || node.sy !== node.sz) {
            return unsupported(state, node, `non-uniform scale (${node.sx}, ${node.sy}, ${node.sz})`)
        }
        if (!(node.sx > 0)) {
            return unsupported(state, node, `negative/zero scale (${node.sx})`)
        }
        return walk(state, node.arg, composeSimilarity(sim, similarityFromUniformScale(node.sx)), neg)
    }

    // --- booleans (folded to min/max via negation parity) ----------------------
    if (node instanceof Union) {
        if ((node.radius ?? 0) > 0) return unsupported(state, node, "blended union (radius > 0)")
        const children = node.children.map(c => walk(state, c, sim, neg)).filter((c): c is CsgNode => c !== null)
        if (children.length === 0) return null
        return { op: neg ? "max" : "min", children }
    }
    if (node instanceof Subtract) {
        if (node.radius > 0) return unsupported(state, node, "blended subtract (radius > 0)")
        const lh = walk(state, node.lh, sim, neg)
        const rh = walk(state, node.rh, sim, !neg)
        const children = [lh, rh].filter((c): c is CsgNode => c !== null)
        if (children.length === 0) return null
        return { op: neg ? "min" : "max", children }
    }
    if (node instanceof Intersect) {
        if (node.radius > 0) return unsupported(state, node, "blended intersect (radius > 0)")
        const lh = walk(state, node.lh, sim, neg)
        const rh = walk(state, node.rh, sim, neg)
        const children = [lh, rh].filter((c): c is CsgNode => c !== null)
        if (children.length === 0) return null
        return { op: neg ? "min" : "max", children }
    }

    return unsupported(state, node, "shape type not in the SFCC v1 subset")
}

function evalNode(n: CsgNode, px: number, py: number, pz: number): number {
    if (n.op === "leaf") return n.leaf.f(px, py, pz)
    let best = n.op === "min" ? Infinity : -Infinity
    for (const c of n.children) {
        const d = evalNode(c, px, py, pz)
        if (n.op === "min" ? d < best : d > best) best = d
    }
    return best
}

function winnerLeaf(n: CsgNode, px: number, py: number, pz: number): { d: number; leaf: CpuSdfLeaf } {
    if (n.op === "leaf") return { d: n.leaf.f(px, py, pz), leaf: n.leaf }
    let best: { d: number; leaf: CpuSdfLeaf } | null = null
    for (const c of n.children) {
        const w = winnerLeaf(c, px, py, pz)
        if (best === null || (n.op === "min" ? w.d < best.d : w.d > best.d)) best = w
    }
    return best!
}

/**
 * Certified enclosure of f over the ball (center, r): per-leaf centered forms
 * with each leaf's local Lipschitz bound, composed through the min/max tree by
 * interval arithmetic. Sound for non-unit-gradient leaves (twisted extrudes).
 */
function intervalNode(n: CsgNode, cx: number, cy: number, cz: number, r: number): [number, number] {
    if (n.op === "leaf") {
        const fc = n.leaf.f(cx, cy, cz)
        const L = n.leaf.localLipschitz ? n.leaf.localLipschitz(cx, cy, cz, r) : 1
        return [fc - L * r, fc + L * r]
    }
    let lo = n.op === "min" ? Infinity : -Infinity
    let hi = lo
    for (const c of n.children) {
        const [clo, chi] = intervalNode(c, cx, cy, cz, r)
        if (n.op === "min") {
            lo = Math.min(lo, clo)
            hi = Math.min(hi, chi)
        } else {
            lo = Math.max(lo, clo)
            hi = Math.max(hi, chi)
        }
    }
    return [lo, hi]
}

function collectOwners(
    n: CsgNode,
    px: number,
    py: number,
    pz: number,
    tol: number,
    out: ActiveOwner[],
): number {
    if (n.op === "leaf") {
        const d = n.leaf.f(px, py, pz)
        out.push({ leaf: n.leaf, d })
        return d
    }
    const ds = n.children.map(c => evalNode(c, px, py, pz))
    let best = n.op === "min" ? Infinity : -Infinity
    for (const d of ds) {
        if (n.op === "min" ? d < best : d > best) best = d
    }
    for (let i = 0; i < n.children.length; i++) {
        if (Math.abs(ds[i]! - best) <= tol) collectOwners(n.children[i]!, px, py, pz, tol, out)
    }
    return best
}

/**
 * Compile the scene tree into the SFCC CPU evaluator. Throws
 * {@link SfccUnsupportedError} listing *all* unsupported nodes.
 */
export function compileCpuSdf(root: Node): CpuSdfTree {
    const state: CompileState = { unsupported: [], leaves: [], strata: [] }
    const csg = walk(state, root, identitySimilarity(), false)
    if (state.unsupported.length > 0) throw new SfccUnsupportedError(state.unsupported)
    if (csg === null) throw new SfccUnsupportedError([{ nodeId: nodeIdOf(root), shapeType: root.getShapeType(), reason: "empty scene" }])

    const f = (px: number, py: number, pz: number): number => evalNode(csg, px, py, pz)
    return {
        f,
        grad: (px, py, pz, out, off = 0) => {
            const w = winnerLeaf(csg, px, py, pz)
            w.leaf.normal(px, py, pz, out, off)
        },
        intervalOverBox: (cx, cy, cz, hx, hy, hz) => {
            const r = Math.hypot(hx, hy, hz)
            return intervalNode(csg, cx, cy, cz, r)
        },
        leaves: state.leaves,
        strata: state.strata,
        activeOwnersAt: (px, py, pz, tol) => {
            const out: ActiveOwner[] = []
            collectOwners(csg, px, py, pz, tol, out)
            return out
        },
        activeStrataAt: (px, py, pz, ownerTol, stratumTol) => {
            const owners: ActiveOwner[] = []
            collectOwners(csg, px, py, pz, ownerTol, owners)
            const out: ActiveStratum[] = []
            for (const { leaf } of owners) {
                let minAbs = Infinity
                for (const st of leaf.strata) {
                    const a = Math.abs(st.f(px, py, pz))
                    if (a < minAbs) minAbs = a
                }
                for (const st of leaf.strata) {
                    const d = st.f(px, py, pz)
                    if (Math.abs(d) <= minAbs + stratumTol) out.push({ stratum: st, d })
                }
            }
            return out
        },
    }
}
