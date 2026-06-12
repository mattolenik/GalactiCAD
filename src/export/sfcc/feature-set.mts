/**
 * S1 feature compilation. P4/P5 scope: primitive-native features, recomputed
 * analytically from the baked similarities (NOT reused from the FeatureGraph,
 * whose edges are 32-segment polylines without parameterization):
 *
 * - Box: 12 segment edges + 8 valence-3 corners
 * - Cylinder (fillet/chamfer = 0): 2 rim circles, no corners
 * - Cone: base circle + apex corner
 * - Sphere: none
 *
 * Boolean seam curves + CSG trimming land in P6 behind the same interfaces.
 * Until then, native features of boolean operands are emitted untrimmed.
 */

import type { CpuSdfTree } from "./cpu-sdf.mjs"
import type { SfccStratum } from "./strata.mjs"
import type { ResolvedTolerances } from "./tolerances.mjs"
import { applyPoint, rotateVector } from "./transform-bake.mjs"
import { makeCircleCurve, makeSegmentCurve, makeTracedCurve, type SfccFeatureCurve } from "./feature-curves.mjs"
import { carrierPairTangent, projectToCarrierPair } from "./newton.mjs"
import { SfccSpatialIndex } from "./spatial-index.mjs"
import { traceAllSeams, type SeamTraceDiagnostics } from "./seam-trace.mjs"
import { trimAndWire } from "./trim.mjs"
import { Box } from "../../scene/primitives/box.mjs"
import { Cylinder } from "../../scene/primitives/cylinder.mjs"
import { Cone } from "../../scene/primitives/cone.mjs"
import { Extrude } from "../../scene/primitives/extrude.mjs"

export interface SfccCorner {
    readonly id: number
    readonly x: number
    readonly y: number
    readonly z: number
    /** Incident stratum ids. */
    readonly strata: number[]
    readonly curveEnds: Array<{ curveId: number; end: 0 | 1 }>
}

export interface SfccFeatureSet {
    readonly curves: SfccFeatureCurve[]
    readonly corners: SfccCorner[]
    readonly index: SfccSpatialIndex
    /** All strata of the compiled tree (curve.adjacentStrata index into this). */
    readonly strata: SfccStratum[]
}

export function compileNativeFeatures(tree: CpuSdfTree): SfccFeatureSet {
    const curves: SfccFeatureCurve[] = []
    const corners: SfccCorner[] = []

    // Index cell size: scale with overall scene size.
    let diag = 1
    for (const leaf of tree.leaves) {
        const d = Math.hypot(leaf.aabb[3]! - leaf.aabb[0]!, leaf.aabb[4]! - leaf.aabb[1]!, leaf.aabb[5]! - leaf.aabb[2]!)
        if (d > diag) diag = d
    }
    const index = new SfccSpatialIndex(diag / 32)

    const p = new Float64Array(3)
    const w = new Float64Array(3)

    for (const leaf of tree.leaves) {
        const node = leaf.sceneNode
        const sim = leaf.sim
        if (node instanceof Box) {
            const cx = node.pos.x
            const cy = node.pos.y
            const cz = node.pos.z
            const hx = node.size.x
            const hy = node.size.y
            const hz = node.size.z
            // World corners, indexed bit0=x, bit1=y, bit2=z (matches strata
            // order +x,−x,+y,−y,+z,−z = localIndex 0..5).
            const cornerPos: number[][] = []
            for (let i = 0; i < 8; i++) {
                applyPoint(
                    sim,
                    cx + ((i & 1) ? hx : -hx),
                    cy + ((i & 2) ? hy : -hy),
                    cz + ((i & 4) ? hz : -hz),
                    p,
                )
                cornerPos.push([p[0]!, p[1]!, p[2]!])
            }
            const stratumOf = (axis: 0 | 1 | 2, positive: boolean): number =>
                leaf.strata[axis * 2 + (positive ? 0 : 1)]!.id
            const cornerIds: number[] = []
            for (let i = 0; i < 8; i++) {
                const id = corners.length
                cornerIds.push(id)
                corners.push({
                    id,
                    x: cornerPos[i]![0]!,
                    y: cornerPos[i]![1]!,
                    z: cornerPos[i]![2]!,
                    strata: [stratumOf(0, !!(i & 1)), stratumOf(1, !!(i & 2)), stratumOf(2, !!(i & 4))],
                    curveEnds: [],
                })
            }
            // 12 edges: corner pairs differing in one bit; adjacent strata are
            // the faces of the two unchanged axes.
            for (let a = 0; a < 8; a++) {
                for (const bit of [1, 2, 4]) {
                    if (a & bit) continue
                    const b = a | bit
                    const axis = bit === 1 ? 0 : bit === 2 ? 1 : 2
                    const others = [0, 1, 2].filter(x => x !== axis) as Array<0 | 1 | 2>
                    const strataPair: [number, number] = [
                        stratumOf(others[0]!, !!(a & (1 << others[0]!))),
                        stratumOf(others[1]!, !!(a & (1 << others[1]!))),
                    ]
                    const curveId = curves.length
                    const curve = makeSegmentCurve(
                        curveId,
                        leaf.nodeId,
                        strataPair,
                        cornerPos[a]![0]!,
                        cornerPos[a]![1]!,
                        cornerPos[a]![2]!,
                        cornerPos[b]![0]!,
                        cornerPos[b]![1]!,
                        cornerPos[b]![2]!,
                    )
                    curve.cornerStart = cornerIds[a]!
                    curve.cornerEnd = cornerIds[b]!
                    corners[cornerIds[a]!]!.curveEnds.push({ curveId, end: 0 })
                    corners[cornerIds[b]!]!.curveEnds.push({ curveId, end: 1 })
                    curves.push(curve)
                }
            }
        } else if (node instanceof Cylinder) {
            const r = node.r * sim.s
            rotateVector(sim, 0, 1, 0, w)
            for (const [side, localY] of [
                [1, node.pos.y + node.h],
                [2, node.pos.y - node.h],
            ] as const) {
                applyPoint(sim, node.pos.x, localY, node.pos.z, p)
                curves.push(
                    makeCircleCurve(
                        curves.length,
                        leaf.nodeId,
                        [leaf.strata[0]!.id, leaf.strata[side]!.id],
                        p[0]!,
                        p[1]!,
                        p[2]!,
                        w[0]!,
                        w[1]!,
                        w[2]!,
                        r,
                    ),
                )
            }
        } else if (node instanceof Extrude) {
            const px = node.pos.x
            const py = node.pos.y
            const pz = node.pos.z
            const h = node.h
            const twistRad = (node.twistDegrees * Math.PI) / 180
            const polyVerts = node.child.vertices
            const N = polyVerts.length
            // Strata layout from the evaluator: sides 0..N−1, capTop N, capBottom N+1.
            const sideStratum = (i: number) => leaf.strata[((i % N) + N) % N]!
            const capTop = leaf.strata[N]!
            const capBottom = leaf.strata[N + 1]!

            /** World point of polygon vertex j at local height y (twist applied). */
            const vertexAt = (j: number, y: number, out: Float64Array, off = 0): void => {
                const t = Math.max(0, Math.min(1, (y + h) / (2 * h)))
                const angle = twistRad * t
                const ca = Math.cos(angle)
                const sa = Math.sin(angle)
                const vx = polyVerts[j]![0]
                const vz = polyVerts[j]![1]
                // Surface = base polygon rotated FORWARD by angle(y).
                applyPoint(sim, px + ca * vx - sa * vz, py + y, pz + sa * vx + ca * vz, out, off)
            }

            const bottomCornerIds: number[] = []
            const topCornerIds: number[] = []
            for (let j = 0; j < N; j++) {
                vertexAt(j, -h, p)
                bottomCornerIds.push(corners.length)
                corners.push({
                    id: corners.length,
                    x: p[0]!,
                    y: p[1]!,
                    z: p[2]!,
                    strata: [sideStratum(j - 1).id, sideStratum(j).id, capBottom.id],
                    curveEnds: [],
                })
                vertexAt(j, h, p)
                topCornerIds.push(corners.length)
                corners.push({
                    id: corners.length,
                    x: p[0]!,
                    y: p[1]!,
                    z: p[2]!,
                    strata: [sideStratum(j - 1).id, sideStratum(j).id, capTop.id],
                    curveEnds: [],
                })
            }

            // Vertical edges: straight segments untwisted; helices (exactly the
            // adjacent side carriers' intersection — traced-curve machinery with
            // closed-form sampling) when twisted.
            const q = new Float64Array(3)
            for (let j = 0; j < N; j++) {
                const sA = sideStratum(j - 1)
                const sB = sideStratum(j)
                const curveId = curves.length
                let curve: SfccFeatureCurve
                if (twistRad === 0) {
                    vertexAt(j, -h, p)
                    vertexAt(j, h, q)
                    curve = makeSegmentCurve(curveId, leaf.nodeId, [sA.id, sB.id], p[0]!, p[1]!, p[2]!, q[0]!, q[1]!, q[2]!)
                } else {
                    const rho = Math.hypot(polyVerts[j]![0], polyVerts[j]![1])
                    // Sample density from the helix's rotational chord error.
                    const maxStep = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - 0.005 / Math.max(rho, 1e-6))))
                    const n = Math.max(8, Math.min(512, Math.ceil(Math.abs(twistRad) / Math.max(maxStep, 1e-4))))
                    const samples = new Float64Array((n + 1) * 3)
                    for (let i = 0; i <= n; i++) {
                        vertexAt(j, -h + (2 * h * i) / n, samples, i * 3)
                    }
                    curve = makeTracedCurve(
                        curveId,
                        [sA.id, sB.id],
                        samples,
                        false,
                        (x, y, z, out, off = 0) => projectToCarrierPair(sA, sB, x, y, z, 1e-10, 1e-3, 0.5, out, off),
                        (x, y, z, out, off = 0) => {
                            carrierPairTangent(sA, sB, x, y, z, out, off)
                        },
                        leaf.nodeId,
                    )
                }
                curve.cornerStart = bottomCornerIds[j]!
                curve.cornerEnd = topCornerIds[j]!
                corners[bottomCornerIds[j]!]!.curveEnds.push({ curveId, end: 0 })
                corners[topCornerIds[j]!]!.curveEnds.push({ curveId, end: 1 })
                curves.push(curve)
            }

            // Cap rim segments (the caps are flat — rim edges stay straight even
            // when twisted, just rotated by the cap's twist angle).
            for (let i = 0; i < N; i++) {
                const j2 = (i + 1) % N
                for (const [cap, yLoc, ids] of [
                    [capBottom, -h, bottomCornerIds],
                    [capTop, h, topCornerIds],
                ] as const) {
                    const curveId = curves.length
                    vertexAt(i, yLoc, p)
                    vertexAt(j2, yLoc, q)
                    const rim = makeSegmentCurve(
                        curveId,
                        leaf.nodeId,
                        [sideStratum(i).id, cap.id],
                        p[0]!,
                        p[1]!,
                        p[2]!,
                        q[0]!,
                        q[1]!,
                        q[2]!,
                    )
                    rim.cornerStart = ids[i]!
                    rim.cornerEnd = ids[j2]!
                    corners[ids[i]!]!.curveEnds.push({ curveId, end: 0 })
                    corners[ids[j2]!]!.curveEnds.push({ curveId, end: 1 })
                    curves.push(rim)
                }
            }
        } else if (node instanceof Cone) {
            const r = node.r * sim.s
            rotateVector(sim, 0, 1, 0, w)
            applyPoint(sim, node.pos.x, node.pos.y, node.pos.z, p)
            curves.push(
                makeCircleCurve(
                    curves.length,
                    leaf.nodeId,
                    [leaf.strata[0]!.id, leaf.strata[1]!.id],
                    p[0]!,
                    p[1]!,
                    p[2]!,
                    w[0]!,
                    w[1]!,
                    w[2]!,
                    r,
                ),
            )
            // Apex: a 0D corner with only the mantle stratum incident.
            applyPoint(sim, node.pos.x, node.pos.y + node.h, node.pos.z, p)
            corners.push({ id: corners.length, x: p[0]!, y: p[1]!, z: p[2]!, strata: [leaf.strata[0]!.id], curveEnds: [] })
        }
        // Sphere: no native features.
    }

    for (const c of curves) index.insertCurvePolyline(c.id, c.indexPolyline)
    for (const c of corners) index.insertCorner(c.id, c.x, c.y, c.z)
    return { curves, corners, index, strata: tree.strata }
}

/** Index cell size heuristic shared by both compilers. */
function indexCellSize(tree: CpuSdfTree): number {
    let diag = 1
    for (const leaf of tree.leaves) {
        const d = Math.hypot(leaf.aabb[3]! - leaf.aabb[0]!, leaf.aabb[4]! - leaf.aabb[1]!, leaf.aabb[5]! - leaf.aabb[2]!)
        if (d > diag) diag = d
    }
    return diag / 32
}

/**
 * Full S1 feature compilation: native curves + traced boolean seams, all
 * CSG-trimmed, with corners derived from trim transitions and surviving
 * native corners, and curves split/wired at them.
 */
export function compileFeatureSet(
    tree: CpuSdfTree,
    tol: ResolvedTolerances,
): SfccFeatureSet & { seamDiagnostics: SeamTraceDiagnostics } {
    const native = compileNativeFeatures(tree)
    // Provenance marker for the trim's crease gate: modeled curves are design
    // intent and survive at any dihedral; only seams use minDihedralDeg.
    for (const c of native.curves) c.native = true
    let nextId = native.curves.length
    const seams = traceAllSeams(tree, tol, () => nextId++)
    const raw = [...native.curves, ...seams.curves]
    const trimmed = trimAndWire(tree, tree.strata, raw, native.corners, tol)
    const index = new SfccSpatialIndex(indexCellSize(tree))
    for (const c of trimmed.curves) index.insertCurvePolyline(c.id, c.indexPolyline)
    for (const c of trimmed.corners) index.insertCorner(c.id, c.x, c.y, c.z)
    return {
        curves: trimmed.curves,
        corners: trimmed.corners,
        index,
        strata: tree.strata,
        seamDiagnostics: seams.diagnostics,
    }
}
