/**
 * S1 feature compilation. P4/P5 scope: primitive-native features, recomputed
 * analytically from the baked similarities (NOT reused from the FeatureGraph,
 * whose edges are 32-segment polylines without parameterization):
 *
 * - Box: 12 segment edges + 8 valence-3 corners
 * - Cylinder (fillet/chamfer = 0): 2 rim circles, no corners
 * - Cone: base circle + apex corner
 * - Lathe: one ring circle per non-collinear off-axis profile vertex; axis
 *   poles where a revolved cone touches the axis become 0D apex corners
 * - Loft (same-topology profiles): cap rim segments + cap corners; junction
 *   crease segments + valence-4 corners at intermediate profiles; vertical
 *   column curves only where the edge×edge ruled-carrier model is exact
 *   (validity-gated: stationary columns; moving convex columns have
 *   vertex-cone-blended flanks and contour as smooth surface — v2)
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
import {
    LATHE_AXIS_R,
    latheProfileEdges,
    outwardEdgeNormal2D,
    polygonDist2D,
    type Polygon2DResult,
} from "./cpu-sdf-primitives.mjs"
import { carrierPairTangent, projectToCarrierPair } from "./newton.mjs"
import { SfccSpatialIndex } from "./spatial-index.mjs"
import { traceAllSeams, type SeamTraceDiagnostics } from "./seam-trace.mjs"
import { trimAndWire } from "./trim.mjs"
import { Box } from "../../scene/primitives/box.mjs"
import { Cylinder } from "../../scene/primitives/cylinder.mjs"
import { Cone } from "../../scene/primitives/cone.mjs"
import { Extrude } from "../../scene/primitives/extrude.mjs"
import { Loft } from "../../scene/primitives/loft.mjs"
import { Lathe } from "../../scene/primitives/lathe.mjs"
import { polygon2dWindingSign } from "../../scene/primitives/polygon2d.mjs"

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
        } else if (node instanceof Loft) {
            const px = node.pos.x
            const py = node.pos.y
            const pz = node.pos.z
            const h = node.h
            const profiles = node.profiles
            const M = profiles.length
            const N = profiles[0]!.vertices.length
            // Strata layout from the evaluator: side(seg, j) = seg·N + j for
            // seg 0..M−2, then capTop (M−1)·N, capBottom (M−1)·N + 1.
            const sideStratum = (seg: number, j: number): SfccStratum =>
                leaf.strata[seg * N + (((j % N) + N) % N)]!
            const capTop = leaf.strata[(M - 1) * N]!
            const capBottom = leaf.strata[(M - 1) * N + 1]!
            const segH = (2 * h) / (M - 1)
            const yOf = (pi: number): number => -h + pi * segH
            const winds = profiles.map(pr => polygon2dWindingSign(pr.vertices))
            const vertScale = Math.max(
                1,
                ...profiles.flatMap(pr => pr.vertices.map(([x, z]) => Math.max(Math.abs(x), Math.abs(z)))),
            )

            /** True OUTWARD unit 2D normal of profile pi's edge e (must match the loft side carriers). */
            const edgeNormal = (pi: number, e: number): [number, number] => {
                const vs = profiles[pi]!.vertices
                const k = ((e % N) + N) % N
                const [ax, az] = vs[k]!
                const [bx, bz] = vs[(k + 1) % N]!
                const ex = bx - ax
                const ez = bz - az
                return outwardEdgeNormal2D(ex, ez, winds[pi]!)
            }

            // Corners at every profile vertex. Cap corners carry the two
            // incident side strata + cap; junction corners (intermediate
            // profiles) the four side strata meeting there.
            const cornerIdx: number[][] = []
            for (let pi = 0; pi < M; pi++) {
                const row: number[] = []
                for (let j = 0; j < N; j++) {
                    const [vx, vz] = profiles[pi]!.vertices[j]!
                    applyPoint(sim, px + vx, py + yOf(pi), pz + vz, p)
                    const strataIds: number[] = []
                    if (pi === 0) {
                        strataIds.push(sideStratum(0, j - 1).id, sideStratum(0, j).id, capBottom.id)
                    } else if (pi === M - 1) {
                        strataIds.push(sideStratum(M - 2, j - 1).id, sideStratum(M - 2, j).id, capTop.id)
                    } else {
                        strataIds.push(
                            sideStratum(pi - 1, j - 1).id,
                            sideStratum(pi - 1, j).id,
                            sideStratum(pi, j - 1).id,
                            sideStratum(pi, j).id,
                        )
                    }
                    row.push(corners.length)
                    corners.push({ id: corners.length, x: p[0]!, y: p[1]!, z: p[2]!, strata: strataIds, curveEnds: [] })
                }
                cornerIdx.push(row)
            }

            // Vertical morph curves: per segment per vertex j, the exact
            // intersection of the two adjacent ruled side carriers. At height
            // parameter t it is the crossing of the two MIXED supporting
            // lines (closed-form 2×2 solve) — generally a curved locus, NOT
            // the chord between corresponding vertices.
            const q = new Float64Array(3)
            const polyScratch: Polygon2DResult = { d: 0, gx: 0, gz: 0, edge: 0 }
            const flatVerts = profiles.map(pr => new Float64Array(pr.vertices.flat()))
            const SAMPLES = 64
            for (let seg = 0; seg < M - 1; seg++) {
                const profA = profiles[seg]!
                const profB = profiles[seg + 1]!
                for (let j = 0; j < N; j++) {
                    const sL = sideStratum(seg, j - 1)
                    const sR = sideStratum(seg, j)
                    const [nALx, nALz] = edgeNormal(seg, j - 1)
                    const [nARx, nARz] = edgeNormal(seg, j)
                    const [nBLx, nBLz] = edgeNormal(seg + 1, j - 1)
                    const [nBRx, nBRz] = edgeNormal(seg + 1, j)
                    const [vAx, vAz] = profA.vertices[j]!
                    const [vBx, vBz] = profB.vertices[j]!
                    const cAL = nALx * vAx + nALz * vAz
                    const cAR = nARx * vAx + nARz * vAz
                    const cBL = nBLx * vBx + nBLz * vBz
                    const cBR = nBRx * vBx + nBRz * vBz
                    /** Mixed-line crossing at height parameter t; null when the vertex degenerates. */
                    const q2At = (t: number): [number, number] | null => {
                        const m1x = (1 - t) * nALx + t * nBLx
                        const m1z = (1 - t) * nALz + t * nBLz
                        const m2x = (1 - t) * nARx + t * nBRx
                        const m2z = (1 - t) * nARz + t * nBRz
                        const c1 = (1 - t) * cAL + t * cBL
                        const c2 = (1 - t) * cAR + t * cBR
                        const det = m1x * m2z - m1z * m2x
                        if (Math.abs(det) < 1e-3 * Math.hypot(m1x, m1z) * Math.hypot(m2x, m2z)) return null
                        return [(c1 * m2z - c2 * m1z) / det, (m1x * c2 - m2x * c1) / det]
                    }
                    let valid = true
                    const samples = new Float64Array((SAMPLES + 1) * 3)
                    for (let i = 0; i <= SAMPLES && valid; i++) {
                        const t = i / SAMPLES
                        const pt = q2At(t)
                        if (!pt) {
                            valid = false
                            break
                        }
                        // Carrier model validity: the crossing must lie on the
                        // true profile-mix zero set (aggressive morphs push it
                        // into vertex-fan regions the per-edge carriers don't
                        // describe — skip the curve, cells there fall back).
                        polygonDist2D(flatVerts[seg]!, winds[seg]!, pt[0], pt[1], polyScratch)
                        const dA = polyScratch.d
                        polygonDist2D(flatVerts[seg + 1]!, winds[seg + 1]!, pt[0], pt[1], polyScratch)
                        if (Math.abs((1 - t) * dA + t * polyScratch.d) > 1e-6 * vertScale) {
                            valid = false
                            break
                        }
                        applyPoint(sim, px + pt[0], py + yOf(seg) + t * segH, pz + pt[1], samples, i * 3)
                    }
                    if (!valid) continue
                    // Straightness: collapse to an exact segment when the locus
                    // is a line (prismatic, translate/scale morphs).
                    const ax = samples[0]!
                    const ay = samples[1]!
                    const az = samples[2]!
                    const bx = samples[SAMPLES * 3]!
                    const by = samples[SAMPLES * 3 + 1]!
                    const bz = samples[SAMPLES * 3 + 2]!
                    const chord = Math.hypot(bx - ax, by - ay, bz - az)
                    let maxDev = 0
                    for (let i = 1; i < SAMPLES; i++) {
                        const t = i / SAMPLES
                        maxDev = Math.max(
                            maxDev,
                            Math.hypot(
                                samples[i * 3]! - (ax + (bx - ax) * t),
                                samples[i * 3 + 1]! - (ay + (by - ay) * t),
                                samples[i * 3 + 2]! - (az + (bz - az) * t),
                            ),
                        )
                    }
                    const curveId = curves.length
                    let curve: SfccFeatureCurve
                    if (maxDev < 1e-9 * Math.max(chord, 1)) {
                        curve = makeSegmentCurve(curveId, leaf.nodeId, [sL.id, sR.id], ax, ay, az, bx, by, bz)
                    } else {
                        curve = makeTracedCurve(
                            curveId,
                            [sL.id, sR.id],
                            samples,
                            false,
                            (x, y, z, out, off = 0) => projectToCarrierPair(sL, sR, x, y, z, 1e-10, 1e-3, 0.5, out, off),
                            (x, y, z, out, off = 0) => {
                                carrierPairTangent(sL, sR, x, y, z, out, off)
                            },
                            leaf.nodeId,
                        )
                    }
                    curve.cornerStart = cornerIdx[seg]![j]!
                    curve.cornerEnd = cornerIdx[seg + 1]![j]!
                    corners[curve.cornerStart]!.curveEnds.push({ curveId, end: 0 })
                    corners[curve.cornerEnd]!.curveEnds.push({ curveId, end: 1 })
                    curves.push(curve)
                }
            }

            // Junction creases: the loft surface is only C0 across an
            // intermediate profile; where consecutive segments' carriers
            // genuinely differ, the crease is exactly that profile's edge
            // (straight — the surface at the junction plane IS the profile
            // boundary). Smooth linear-morph continuations share one carrier
            // and are skipped here; shallower-than-tangency joins die in trim.
            const nBelow = new Float64Array(3)
            const nAbove = new Float64Array(3)
            for (let pi = 1; pi < M - 1; pi++) {
                for (let j = 0; j < N; j++) {
                    const j2 = (j + 1) % N
                    const sBelow = sideStratum(pi - 1, j)
                    const sAbove = sideStratum(pi, j)
                    const [v0x, v0z] = profiles[pi]!.vertices[j]!
                    const [v1x, v1z] = profiles[pi]!.vertices[j2]!
                    applyPoint(sim, px + (v0x + v1x) / 2, py + yOf(pi), pz + (v0z + v1z) / 2, p)
                    sBelow.normal(p[0]!, p[1]!, p[2]!, nBelow)
                    sAbove.normal(p[0]!, p[1]!, p[2]!, nAbove)
                    const dot = nBelow[0]! * nAbove[0]! + nBelow[1]! * nAbove[1]! + nBelow[2]! * nAbove[2]!
                    if (dot > 1 - 1e-9) continue
                    const curveId = curves.length
                    applyPoint(sim, px + v0x, py + yOf(pi), pz + v0z, p)
                    applyPoint(sim, px + v1x, py + yOf(pi), pz + v1z, q)
                    const crease = makeSegmentCurve(
                        curveId,
                        leaf.nodeId,
                        [sBelow.id, sAbove.id],
                        p[0]!,
                        p[1]!,
                        p[2]!,
                        q[0]!,
                        q[1]!,
                        q[2]!,
                    )
                    crease.cornerStart = cornerIdx[pi]![j]!
                    crease.cornerEnd = cornerIdx[pi]![j2]!
                    corners[crease.cornerStart]!.curveEnds.push({ curveId, end: 0 })
                    corners[crease.cornerEnd]!.curveEnds.push({ curveId, end: 1 })
                    curves.push(crease)
                }
            }

            // Cap rim segments (caps are planar; rims are the end profiles' edges).
            for (let j = 0; j < N; j++) {
                const j2 = (j + 1) % N
                for (const [cap, pi, seg] of [
                    [capBottom, 0, 0],
                    [capTop, M - 1, M - 2],
                ] as const) {
                    const [v0x, v0z] = profiles[pi]!.vertices[j]!
                    const [v1x, v1z] = profiles[pi]!.vertices[j2]!
                    const curveId = curves.length
                    applyPoint(sim, px + v0x, py + yOf(pi), pz + v0z, p)
                    applyPoint(sim, px + v1x, py + yOf(pi), pz + v1z, q)
                    const rim = makeSegmentCurve(
                        curveId,
                        leaf.nodeId,
                        [sideStratum(seg, j).id, cap.id],
                        p[0]!,
                        p[1]!,
                        p[2]!,
                        q[0]!,
                        q[1]!,
                        q[2]!,
                    )
                    rim.cornerStart = cornerIdx[pi]![j]!
                    rim.cornerEnd = cornerIdx[pi]![j2]!
                    corners[rim.cornerStart]!.curveEnds.push({ curveId, end: 0 })
                    corners[rim.cornerEnd]!.curveEnds.push({ curveId, end: 1 })
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
        } else if (node instanceof Lathe) {
            const px = node.pos.x
            const py = node.pos.y
            const pz = node.pos.z
            const polyVerts = node.child.vertices
            const N = polyVerts.length
            const edges = latheProfileEdges(polyVerts, polygon2dWindingSign(polyVerts))
            // Strata layout from the evaluator: one stratum per non-axis
            // profile edge, in edge order.
            const edgeStratum: Array<SfccStratum | null> = []
            let cursor = 0
            for (const e of edges) edgeStratum.push(e.kind === "none" ? null : leaf.strata[cursor++]!)
            rotateVector(sim, 0, 1, 0, w)
            for (let k = 0; k < N; k++) {
                const [r, y] = polyVerts[k]!
                const ePrev = edges[(k + N - 1) % N]!
                const eNext = edges[k]!
                const sPrev = edgeStratum[(k + N - 1) % N]
                const sNext = edgeStratum[k]
                applyPoint(sim, px, py + y, pz, p)
                if (Math.abs(r) <= LATHE_AXIS_R) {
                    // Axis pole: a 0D cone-apex corner when a revolved cone
                    // touches the axis here (like the Cone primitive's apex).
                    // A plane edge reaching the axis is a flat disk's center —
                    // smooth interior, no feature.
                    const strataIds: number[] = []
                    if (sPrev && ePrev.kind === "cone") strataIds.push(sPrev.id)
                    if (sNext && eNext.kind === "cone") strataIds.push(sNext.id)
                    if (strataIds.length > 0) {
                        // Include a non-cone patch sharing the pole (incident).
                        if (sPrev && ePrev.kind !== "cone") strataIds.push(sPrev.id)
                        if (sNext && eNext.kind !== "cone") strataIds.push(sNext.id)
                        corners.push({
                            id: corners.length,
                            x: p[0]!,
                            y: p[1]!,
                            z: p[2]!,
                            strata: strataIds,
                            curveEnds: [],
                        })
                    }
                    continue
                }
                if (!sPrev || !sNext) continue
                // Exactly-collinear turns have a degenerate carrier pair — skip;
                // near-tangent rings below minTangencyAngleDeg die in trim.
                if (ePrev.nr * eNext.nr + ePrev.ny * eNext.ny >= 1 - 1e-12) continue
                // Feature ring: the profile vertex revolved around the Y axis —
                // a closed circle with the two adjacent revolved strata.
                curves.push(
                    makeCircleCurve(
                        curves.length,
                        leaf.nodeId,
                        [sPrev.id, sNext.id],
                        p[0]!,
                        p[1]!,
                        p[2]!,
                        w[0]!,
                        w[1]!,
                        w[2]!,
                        sim.s * Math.abs(r),
                    ),
                )
            }
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
