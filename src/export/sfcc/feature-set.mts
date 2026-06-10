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
import { makeCircleCurve, makeSegmentCurve, type SfccFeatureCurve } from "./feature-curves.mjs"
import { SfccSpatialIndex } from "./spatial-index.mjs"
import { traceAllSeams, type SeamTraceDiagnostics } from "./seam-trace.mjs"
import { trimAndWire } from "./trim.mjs"
import { Box } from "../../scene/primitives/box.mjs"
import { Cylinder } from "../../scene/primitives/cylinder.mjs"
import { Cone } from "../../scene/primitives/cone.mjs"

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
