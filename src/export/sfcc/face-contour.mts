/**
 * S3a — face data, computed once per canonical octree face (the CMS
 * invariant): edge iso-crossings on minimal sub-edges plus the boundary-walk
 * contour segments. Both incident cells consume the same FaceRecord, so the
 * mesh is crack-free and the closedness audit is exact by construction.
 *
 * Segment orientation convention: in the face's (u, v) frame (u × v = +axis),
 * the boundary walk is CCW viewed from the +axis side, and every contour
 * segment is directed with the f < 0 region on its LEFT viewed from +axis.
 * The cell on the +axis side of the face consumes segments as stored; the
 * cell on the −axis side reverses them (pinned by the outward-winding
 * pipeline test) — which is what makes every interior face segment traversed
 * exactly twice in opposite directions.
 *
 * No 16-case MS table: the boundary walk handles hanging lattice points,
 * arbitrary even crossing counts, and (later) pinned feature points uniformly.
 * Ambiguous pairings are resolved by an actual `f` sample at the face center —
 * computed once per face, hence automatically consistent for both cells.
 */

import type { CpuSdfTree } from "./cpu-sdf.mjs"
import type { SfccFeatureSet } from "./feature-set.mjs"
import {
    collectEdgeInteriorOffsets,
    faceAxes,
    packPoint,
    pointToWorld,
    strideAtLevel,
    type SfccLattice,
} from "./lattice.mjs"
import type { SfccOctree } from "./octree.mjs"
import { crossingKey, type PointTable } from "./point-table.mjs"

export interface FaceSegment {
    /** Point ids; directed with f<0 on the left viewed from +axis. */
    a: number
    b: number
}

export interface FacePin {
    /** PointTable id of the exact curve–face crossing. */
    pointId: number
    curveId: number
    /** Curve parameter at the crossing. */
    t: number
}

export interface FaceRecord {
    readonly axis: 0 | 1 | 2
    /** Lattice key of the face min corner. */
    readonly key: number
    /** Face edge length in lattice units. */
    readonly len: number
    readonly segments: FaceSegment[]
    /** Pinned feature-curve crossings routed through by `segments`. */
    readonly pins: FacePin[]
    /** Consumption counters for the S4 face audit (filled by cell meshing). */
    readonly consumedFwd: number[]
    readonly consumedRev: number[]
}

export interface FaceContourOptions {
    /** Absolute world-space tolerance for edge root-finding. */
    rootTol: number
    /** Feature set for face pinning (absent in feature-free runs/tests). */
    features?: SfccFeatureSet
    /**
     * Sub-sample boundary-crossing recovery cache, keyed by canonical sub-edge
     * (crossingKey). Near a feature, a surface arc can enter and exit a face
     * through ONE boundary sub-edge without flipping any corner sample — the
     * crease's arc endpoints are then invisible to tree-f signs, the pin can't
     * be routed, and the cell falls back to smooth meshing (the dominant
     * quality loss on high-twist scenes: ~22% of pin faces at twist 500°).
     * Each endpoint lies on a smooth stratum carrier whose sign DOES change
     * along the sub-edge, so it is recoverable. The cache guarantees all faces
     * sharing a sub-edge see identical recovered crossings; only even counts
     * per sub-edge are kept (walk-parity safe).
     */
    recovered?: Map<number, RecoveredCrossing[]>
    /**
     * Per-crossing stratum tag cache (point id → stratum id, −1 for none),
     * shared across faces like `recovered`. Visible (tree-f) crossings near a
     * feature curve are tagged with the stratum carrier they lie on so the
     * per-stratum pairing pass routes them ALONG the wedge — walk-order /
     * center-sample pairing is blind to thin slivers and connects the two
     * strata ACROSS the wedge, capping the tube (the cell's loop then pinches
     * into two loops, one per pin: the dominant fallback mode at twist 500°).
     */
    stratumTags?: Map<number, number>
}

export interface RecoveredCrossing {
    /** PointTable id. */
    id: number
    /** Position along the canonical (+axis) direction of the sub-edge, t ∈ (0, 1). */
    t: number
    /** Stratum whose carrier vanishes here — recovered crossings pair per-stratum. */
    stratum: number
}

export interface FaceContourResult {
    /** Per axis: face min-corner lattice key → record. NOTE: keys collide across levels (a face and its min-corner quarter share the key) — consumers must validate `record.len`. */
    faces: Array<Map<number, FaceRecord>>
    /** Faces with ≥3 inside runs (beyond simple ambiguity) — certificate gap diagnostics. */
    multiRunFaces: number
    /** Crossings found on root-boundary faces (must be 0 — bounds padding violated). */
    boundaryViolations: number
    /** Same-key different-size enumeration conflicts (must be 0 — canonical-face selection bug). */
    keyCollisions: number
}

interface BoundaryNode {
    /** Crossing point id, or −1 for a lattice sample point. */
    crossing: number
    /** For sample nodes: whether f < 0. */
    inside: boolean
}

/** Root-find the iso-crossing on a world segment with f0 < 0 ≤ f1 or f1 < 0 ≤ f0. */
function findRoot(
    tree: CpuSdfTree,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    f0: number,
    f1: number,
    tol: number,
    out: Float64Array,
): void {
    let lo = 0
    let hi = 1
    let flo = f0
    const segLen = Math.hypot(bx - ax, by - ay, bz - az)
    for (let i = 0; i < 60 && (hi - lo) * segLen > tol; i++) {
        const mid = (lo + hi) / 2
        const fm = tree.f(ax + (bx - ax) * mid, ay + (by - ay) * mid, az + (bz - az) * mid)
        if (fm < 0 === flo < 0) {
            lo = mid
            flo = fm
        } else {
            hi = mid
        }
    }
    const t = (lo + hi) / 2
    out[0] = ax + (bx - ax) * t
    out[1] = ay + (by - ay) * t
    out[2] = az + (bz - az) * t
    tree.grad(out[0]!, out[1]!, out[2]!, out, 3)
}

/**
 * Compute (once, globally cached) the recovered per-stratum boundary crossings
 * of a sub-edge with no tree-f sign change. For each feature curve near the
 * edge, each adjacent stratum carrier with an endpoint sign change is
 * root-found along the edge; candidates survive only where the full tree SDF
 * also vanishes (a genuine surface point, not a virtual carrier crossing).
 * Odd candidate sets are dropped entirely — a missed sliver is better than
 * corrupting boundary parity.
 */
function recoveredCrossingsFor(
    cacheKey: number,
    aWorld: Float64Array, // canonical sub-edge min endpoint (world)
    bWorld: Float64Array, // canonical sub-edge max endpoint (world)
    tree: CpuSdfTree,
    points: PointTable,
    opts: FaceContourOptions,
): RecoveredCrossing[] {
    const cache = opts.recovered!
    const hit = cache.get(cacheKey)
    if (hit !== undefined) return hit

    const features = opts.features!
    const edgeLen = Math.hypot(bWorld[0]! - aWorld[0]!, bWorld[1]! - aWorld[1]!, bWorld[2]! - aWorld[2]!)
    const inflate = edgeLen * 2
    const out: RecoveredCrossing[] = []
    const curveIds = features.index.curvesInBox(
        Math.min(aWorld[0]!, bWorld[0]!) - inflate,
        Math.min(aWorld[1]!, bWorld[1]!) - inflate,
        Math.min(aWorld[2]!, bWorld[2]!) - inflate,
        Math.max(aWorld[0]!, bWorld[0]!) + inflate,
        Math.max(aWorld[1]!, bWorld[1]!) + inflate,
        Math.max(aWorld[2]!, bWorld[2]!) + inflate,
    )
    if (curveIds.length === 0) {
        cache.set(cacheKey, out)
        return out
    }
    const seen = new Set<number>()
    const q = new Float64Array(3)
    for (const cid of curveIds) {
        const curve = features.curves[cid]!
        for (const sid of curve.adjacentStrata) {
            if (seen.has(sid)) continue
            seen.add(sid)
            const st = features.strata[sid]!
            const sa = st.f(aWorld[0]!, aWorld[1]!, aWorld[2]!)
            const sb = st.f(bWorld[0]!, bWorld[1]!, bWorld[2]!)
            if (sa < 0 === sb < 0) continue
            // Bisect the smooth carrier along the edge.
            let lo = 0
            let hi = 1
            let flo = sa
            for (let i = 0; i < 50 && (hi - lo) * edgeLen > opts.rootTol; i++) {
                const mid = (lo + hi) / 2
                const fm = st.f(
                    aWorld[0]! + (bWorld[0]! - aWorld[0]!) * mid,
                    aWorld[1]! + (bWorld[1]! - aWorld[1]!) * mid,
                    aWorld[2]! + (bWorld[2]! - aWorld[2]!) * mid,
                )
                if (fm < 0 === flo < 0) {
                    lo = mid
                    flo = fm
                } else {
                    hi = mid
                }
            }
            const t = (lo + hi) / 2
            q[0] = aWorld[0]! + (bWorld[0]! - aWorld[0]!) * t
            q[1] = aWorld[1]! + (bWorld[1]! - aWorld[1]!) * t
            q[2] = aWorld[2]! + (bWorld[2]! - aWorld[2]!) * t
            if (Math.abs(tree.f(q[0]!, q[1]!, q[2]!)) > opts.rootTol * 4) continue
            const qx = q[0]!
            const qy = q[1]!
            const qz = q[2]!
            const id = points.getOrCreateStr(`SC:${cacheKey}:${sid}`, o => {
                o[0] = qx
                o[1] = qy
                o[2] = qz
                tree.grad(qx, qy, qz, o, 3)
            })
            out.push({ id, t, stratum: sid })
        }
    }
    // Gate to the canonical arc-through configuration: exactly TWO crossings
    // on DISTINCT strata that flank a common curve's wedge (both strata
    // adjacent to one nearby curve). Gating must be on the strata pair, not
    // per-curve attribution: adjacent feature curves share side strata, so the
    // `seen` dedup attributes a shared stratum's crossing to whichever curve
    // iterates first — a one-curve count gate then rejects genuine pairs
    // (measured: every zero-crossing pin face at twist 500°). Multi-crossing /
    // partial sets (corner zones) still recover nothing — ad-hoc pairings
    // there fabricate conflicting arcs (residual non-manifold edges).
    let wedgePair = false
    if (out.length === 2 && out[0]!.stratum !== out[1]!.stratum) {
        for (const cid of curveIds) {
            const adj = features.curves[cid]!.adjacentStrata
            if (adj.includes(out[0]!.stratum) && adj.includes(out[1]!.stratum)) {
                wedgePair = true
                break
            }
        }
    }
    if (!wedgePair) out.length = 0
    out.sort((x, y) => x.t - y.t)
    cache.set(cacheKey, out)
    return out
}

/**
 * Stratum tag for a visible (tree-f) crossing: the feature-adjacent stratum
 * carrier the point lies on (|carrier f| within the recovery tolerance AND
 * normal agreement with the tree gradient — same flank test as trim), or −1.
 * Cached globally by point id so all faces sharing the crossing agree.
 */
function stratumTagFor(
    id: number,
    aWorld: Float64Array, // canonical sub-edge endpoints (world) — curve query box
    bWorld: Float64Array,
    tree: CpuSdfTree,
    points: PointTable,
    opts: FaceContourOptions,
): number {
    const cache = opts.stratumTags!
    const hit = cache.get(id)
    if (hit !== undefined) return hit
    const features = opts.features!
    const edgeLen = Math.hypot(bWorld[0]! - aWorld[0]!, bWorld[1]! - aWorld[1]!, bWorld[2]! - aWorld[2]!)
    const inflate = edgeLen * 2
    const curveIds = features.index.curvesInBox(
        Math.min(aWorld[0]!, bWorld[0]!) - inflate,
        Math.min(aWorld[1]!, bWorld[1]!) - inflate,
        Math.min(aWorld[2]!, bWorld[2]!) - inflate,
        Math.max(aWorld[0]!, bWorld[0]!) + inflate,
        Math.max(aWorld[1]!, bWorld[1]!) + inflate,
        Math.max(aWorld[2]!, bWorld[2]!) + inflate,
    )
    let best = -1
    if (curveIds.length > 0) {
        const qx = points.x(id)
        const qy = points.y(id)
        const qz = points.z(id)
        const grad = new Float64Array(3)
        tree.grad(qx, qy, qz, grad)
        const gl = Math.hypot(grad[0]!, grad[1]!, grad[2]!)
        const n = new Float64Array(3)
        const tol = opts.rootTol * 4
        let bestAbs = Infinity
        const seen = new Set<number>()
        for (const cid of curveIds) {
            for (const sid of features.curves[cid]!.adjacentStrata) {
                if (seen.has(sid)) continue
                seen.add(sid)
                const st = features.strata[sid]!
                const fv = Math.abs(st.f(qx, qy, qz))
                if (fv > tol || fv >= bestAbs) continue
                st.normal(qx, qy, qz, n)
                // |dot|: wrapped carriers (twisted sides) can present the
                // back side of a branch — identity matters here, not
                // orientation.
                if (gl > 1e-12 && Math.abs(grad[0]! * n[0]! + grad[1]! * n[1]! + grad[2]! * n[2]!) / gl < 0.9) continue
                best = sid
                bestAbs = fv
            }
        }
    }
    cache.set(id, best)
    return best
}

/**
 * Contour one face. `gx,gy,gz` is the face min corner (lattice), `len` its
 * edge length in lattice units.
 */
export function contourFace(
    oct: SfccOctree,
    tree: CpuSdfTree,
    points: PointTable,
    axis: 0 | 1 | 2,
    gx: number,
    gy: number,
    gz: number,
    len: number,
    opts: FaceContourOptions,
): FaceRecord {
    const lat: SfccLattice = oct.lat
    const [u, v] = faceAxes(axis)
    const key = packPoint(lat, gx, gy, gz)

    // The 4 boundary edges in CCW walk order (viewed from +axis):
    // +u at v=0 → +v at u=len → −u at v=len → −v at u=0.
    // Each entry: start offset (du, dv), walk axis, walk direction (+1/−1).
    const walks: Array<{ du: number; dv: number; ax: 0 | 1 | 2; dir: 1 | -1 }> = [
        { du: 0, dv: 0, ax: u, dir: 1 },
        { du: len, dv: 0, ax: v, dir: 1 },
        { du: len, dv: len, ax: u, dir: -1 },
        { du: 0, dv: len, ax: v, dir: -1 },
    ]

    const latticeOf = (du: number, dv: number): [number, number, number] => {
        const g: [number, number, number] = [gx, gy, gz]
        g[u] = g[u]! + du
        g[v] = g[v]! + dv
        return g
    }

    const nodes: BoundaryNode[] = []
    /** Crossing point id → face boundary side (walk index 0-3): segments whose
     * endpoints lie on the SAME side run along a cell-edge line shared by up
     * to four faces and must be split with a face-owned midpoint. */
    const nodeSide = new Map<number, number>()
    /** Crossing point id → stratum id (stratum-tagged crossings pair per-stratum):
     * recovered crossings carry their carrier's id; visible crossings near a
     * feature curve are tagged via `stratumTagFor`. */
    const nodeStratum = new Map<number, number>()
    const scratch = new Float64Array(6)
    const wa = new Float64Array(3)
    const wb = new Float64Array(3)

    let walkIndex = -1
    for (const walk of walks) {
        walkIndex++
        // Lattice point sequence along this boundary edge: start, interior
        // (existing samples only), end-exclusive (next walk supplies it).
        const [sgx, sgy, sgz] = latticeOf(walk.du, walk.dv)
        // Min corner of the full edge along walk.ax for interior discovery:
        const edgeMin: [number, number, number] = [sgx, sgy, sgz]
        if (walk.dir === -1) edgeMin[walk.ax] = edgeMin[walk.ax]! - len
        const interior = collectEdgeInteriorOffsets(
            k => oct.hasSampleKey(k),
            lat,
            walk.ax,
            edgeMin[0]!,
            edgeMin[1]!,
            edgeMin[2]!,
            len,
            [],
        )
        // Offsets along the walk direction, start-inclusive, end-exclusive.
        const offsets: number[] = [0]
        if (walk.dir === 1) {
            for (const o of interior) offsets.push(o)
        } else {
            for (let i = interior.length - 1; i >= 0; i--) offsets.push(len - interior[i]!)
        }
        offsets.push(len) // end (used for the last sub-edge, not emitted as a node)

        for (let i = 0; i < offsets.length - 1; i++) {
            const o0 = offsets[i]!
            const o1 = offsets[i + 1]!
            const p0: [number, number, number] = [sgx, sgy, sgz]
            p0[walk.ax] = p0[walk.ax]! + walk.dir * o0
            const p1: [number, number, number] = [sgx, sgy, sgz]
            p1[walk.ax] = p1[walk.ax]! + walk.dir * o1
            const f0 = oct.sampleAt(p0[0]!, p0[1]!, p0[2]!)
            const f1 = oct.sampleAt(p1[0]!, p1[1]!, p1[2]!)
            nodes.push({ crossing: -1, inside: f0 < 0 })
            // Canonical sub-edge key: min corner along the edge axis.
            const minCorner = walk.dir === 1 ? p0 : p1
            const subKey = crossingKey(packPoint(lat, minCorner[0]!, minCorner[1]!, minCorner[2]!), walk.ax)
            if (f0 < 0 !== f1 < 0) {
                const id = points.getOrCreate(subKey, out => {
                    pointToWorld(lat, p0[0]!, p0[1]!, p0[2]!, wa)
                    pointToWorld(lat, p1[0]!, p1[1]!, p1[2]!, wb)
                    findRoot(tree, wa[0]!, wa[1]!, wa[2]!, wb[0]!, wb[1]!, wb[2]!, f0, f1, opts.rootTol, scratch)
                    out.set(scratch)
                })
                nodes.push({ crossing: id, inside: false })
                nodeSide.set(id, walkIndex)
                if (opts.features && opts.stratumTags) {
                    pointToWorld(lat, p0[0]!, p0[1]!, p0[2]!, wa)
                    pointToWorld(lat, p1[0]!, p1[1]!, p1[2]!, wb)
                    const tag = stratumTagFor(id, wa, wb, tree, points, opts)
                    if (tag >= 0) nodeStratum.set(id, tag)
                }
            } else if (opts.features && opts.recovered) {
                // Sub-sample arc-endpoint recovery (see FaceContourOptions.recovered).
                const canonMin = walk.dir === 1 ? p0 : p1
                const canonMax = walk.dir === 1 ? p1 : p0
                pointToWorld(lat, canonMin[0]!, canonMin[1]!, canonMin[2]!, wa)
                pointToWorld(lat, canonMax[0]!, canonMax[1]!, canonMax[2]!, wb)
                const rec = recoveredCrossingsFor(subKey, wa, wb, tree, points, opts)
                if (rec.length > 0) {
                    // Insert in walk order (cache is sorted by canonical +axis t).
                    if (walk.dir === 1) {
                        for (const r of rec) {
                            nodes.push({ crossing: r.id, inside: false })
                            nodeSide.set(r.id, walkIndex)
                            nodeStratum.set(r.id, r.stratum)
                        }
                    } else {
                        for (let r = rec.length - 1; r >= 0; r--) {
                            nodes.push({ crossing: rec[r]!.id, inside: false })
                            nodeSide.set(rec[r]!.id, walkIndex)
                            nodeStratum.set(rec[r]!.id, rec[r]!.stratum)
                        }
                    }
                }
            }
        }
    }

    // Extract crossings with enter/exit tags by walking the cyclic node list.
    const crossings: Array<{ id: number; enter: boolean }> = []
    let state = nodes.length > 0 ? nodes[0]!.inside : false
    for (const n of nodes) {
        if (n.crossing >= 0) {
            state = !state
            crossings.push({ id: n.crossing, enter: state })
        } else {
            state = n.inside
        }
    }

    const record: FaceRecord = { axis, key, len, segments: [], pins: [], consumedFwd: [], consumedRev: [] }

    // --- Feature pinning: exact curve–face crossings (computed once, shared) ---
    if (opts.features) {
        const minW = new Float64Array(3)
        pointToWorld(lat, gx, gy, gz, minW)
        const ext = len * lat.step
        const maxU = minW[u]! + ext
        const maxV = minW[v]! + ext
        const coord = minW[axis]!
        const eps = 1e-12 * lat.worldSize
        const qMin: [number, number, number] = [minW[0]!, minW[1]!, minW[2]!]
        const qMax: [number, number, number] = [minW[0]!, minW[1]!, minW[2]!]
        qMax[u] = maxU
        qMax[v] = maxV
        for (const curveId of opts.features.index.curvesInBox(
            qMin[0]! - eps,
            qMin[1]! - eps,
            qMin[2]! - eps,
            qMax[0]! + eps,
            qMax[1]! + eps,
            qMax[2]! + eps,
        )) {
            const curve = opts.features.curves[curveId]!
            for (const cr of curve.axisPlaneCrossings(axis, coord)) {
                const pos = [cr.x, cr.y, cr.z]
                if (pos[u]! < minW[u]! || pos[u]! > maxU || pos[v]! < minW[v]! || pos[v]! > maxV) continue
                const pid = points.getOrCreateStr(`F${axis}:${key}:${curveId}:${cr.t.toFixed(12)}`, out => {
                    // Averaged adjacent-strata normal as the shared shading normal;
                    // crisp creases come from the crease-split post-pass.
                    const sa = opts.features!.strata[curve.adjacentStrata[0]!]!
                    const sb = opts.features!.strata[curve.adjacentStrata[1]!]!
                    const na = new Float64Array(3)
                    const nb = new Float64Array(3)
                    sa.normal(cr.x, cr.y, cr.z, na)
                    sb.normal(cr.x, cr.y, cr.z, nb)
                    let nx = na[0]! + nb[0]!
                    let ny = na[1]! + nb[1]!
                    let nz = na[2]! + nb[2]!
                    const nl = Math.hypot(nx, ny, nz)
                    if (nl > 1e-12) {
                        nx /= nl
                        ny /= nl
                        nz /= nl
                    } else {
                        nx = 0
                        ny = 1
                        nz = 0
                    }
                    out[0] = cr.x
                    out[1] = cr.y
                    out[2] = cr.z
                    out[3] = nx
                    out[4] = ny
                    out[5] = nz
                })
                record.pins.push({ pointId: pid, curveId, t: cr.t })
            }
        }
    }

    // Route through pinned feature points: the certified case is one pin with
    // one boundary inside-run (exit → pin → enter, a single kinked arc).
    if (record.pins.length === 1 && crossings.length === 2) {
        const pin = record.pins[0]!
        const exit = crossings.find(c => !c.enter)!
        const enter = crossings.find(c => c.enter)!
        record.segments.push({ a: exit.id, b: pin.pointId }, { a: pin.pointId, b: enter.id })
        record.consumedFwd.push(0, 0)
        record.consumedRev.push(0, 0)
        return record
    }
    // Pins in any other configuration aren't certified yet (corner faces land
    // in P5) — fall through to the featureless pairing, which keeps the mesh
    // closed; callers see the pins and count the fallback.

    if (crossings.length === 0) return record

    // Pair exits with enters. With one inside run the rules coincide; with two
    // runs (the classic ambiguous face) the face-center sample decides; more
    // runs follow the same rule (certificates refine these away later).
    const runs = crossings.length / 2
    let centerInside = false
    if (runs >= 2) {
        const cg: [number, number, number] = latticeOf(len / 2, len / 2)
        pointToWorld(lat, cg[0]!, cg[1]!, cg[2]!, wa)
        centerInside = tree.f(wa[0]!, wa[1]!, wa[2]!) < 0
    }
    const n = crossings.length
    // Pairing must be a PERFECT matching (every enter consumed exactly once) —
    // it is built in two coordinated passes over a shared "matched" set:
    //   1. Stratum-tagged crossings (recovered ones, and visible ones tagged
    //      by stratumTagFor) pair PER-STRATUM: a thin feature wedge crossing
    //      the face yields one entry/exit per stratum side, and the contour arc
    //      runs ALONG the wedge on its own stratum — walk-order pairing alone
    //      would connect across the wedge, fabricating caps that pinch the
    //      wedge tube (and, for same-sub-edge pairs, tubes around the
    //      cell-edge line).
    //   2. Everything else pairs by the run rule (prev/next enter per the
    //      face-center sample), restricted to still-unmatched enters.
    const matchedEnter = new Set<number>()
    const partnerOf = new Map<number, number>() // exit index → enter id
    // Pass 1 pairs only strata with exactly ONE tagged exit and ONE tagged
    // enter (the wedge-side configuration). Ambiguous groups (a wrapped
    // carrier crossing the face twice) defer to the run rule, which keeps the
    // face-center sample as the oracle there.
    const tally = new Map<number, { enters: number[]; exits: number[] }>() // stratum → crossing indexes
    for (let i = 0; i < n; i++) {
        const s = nodeStratum.get(crossings[i]!.id)
        if (s === undefined) continue
        let t = tally.get(s)
        if (!t) tally.set(s, (t = { enters: [], exits: [] }))
        ;(crossings[i]!.enter ? t.enters : t.exits).push(i)
    }
    for (const t of tally.values()) {
        if (t.enters.length === 1 && t.exits.length === 1) {
            matchedEnter.add(t.enters[0]!)
            partnerOf.set(t.exits[0]!, crossings[t.enters[0]!]!.id)
        }
    }
    for (let i = 0; i < n; i++) {
        const c = crossings[i]!
        if (c.enter || partnerOf.has(i)) continue
        if (runs < 2 || !centerInside) {
            // Enter of this exit's own run = nearest unmatched enter BEFORE it.
            for (let k = 1; k <= n; k++) {
                const j = (i - k + n) % n
                if (crossings[j]!.enter && !matchedEnter.has(j)) {
                    matchedEnter.add(j)
                    partnerOf.set(i, crossings[j]!.id)
                    break
                }
            }
        } else {
            // Center inside: connect across the face to the NEXT unmatched enter.
            for (let k = 1; k <= n; k++) {
                const j = (i + k) % n
                if (crossings[j]!.enter && !matchedEnter.has(j)) {
                    matchedEnter.add(j)
                    partnerOf.set(i, crossings[j]!.id)
                    break
                }
            }
        }
    }
    for (let i = 0; i < n; i++) {
        const c = crossings[i]!
        if (c.enter) continue
        const partner = partnerOf.get(i) ?? -1
        // Collinear guard: when both endpoints lie on the SAME boundary side
        // of the face (a sliver arc hugging it), the straight segment
        // degenerates onto the cell-edge line shared by up to four faces —
        // split it with a face-owned, in-plane surface-projected midpoint so
        // each face's arc is geometrically distinct.
        const se = nodeSide.get(c.id)
        if (se !== undefined && se === nodeSide.get(partner)) {
            const mid = splitMidpoint(tree, points, axis, c.id, partner, opts.rootTol)
            record.segments.push({ a: c.id, b: mid }, { a: mid, b: partner })
            record.consumedFwd.push(0, 0)
            record.consumedRev.push(0, 0)
            continue
        }
        record.segments.push({ a: c.id, b: partner })
        record.consumedFwd.push(0)
        record.consumedRev.push(0)
    }

    // Pin-anchored splice: a pin is a REAL point of surface ∩ face (the crease
    // pierces the face interior there), so the face's arc set must pass
    // through it — a loop that misses a pin loses the wedge in BOTH incident
    // cells (the dominant residual chip source: wedge tips grazing a cell-edge
    // line produce 4-crossing pin faces the certified exit→pin→enter case
    // doesn't cover, and stratum-consistent pairing then routes AROUND the
    // pin). Splice each unrouted pin into the segment that crosses its curve's
    // wedge — endpoint strata = the curve's two flanks — or, when pairing
    // produced no such segment (sub-tolerance caps near the tip), the segment
    // nearest to the pin. Face-owned, so both cells consume identical routing.
    if (record.pins.length > 0 && record.segments.length > 0 && opts.features) {
        for (const pin of record.pins) {
            if (record.segments.some(s => s.a === pin.pointId || s.b === pin.pointId)) continue
            const adj = opts.features.curves[pin.curveId]!.adjacentStrata
            const px = points.x(pin.pointId)
            const py = points.y(pin.pointId)
            const pz = points.z(pin.pointId)
            let bestIdx = -1
            let bestDist = Infinity
            let bestCross = false
            for (let i = 0; i < record.segments.length; i++) {
                const s = record.segments[i]!
                const sa = nodeStratum.get(s.a)
                const sb = nodeStratum.get(s.b)
                const cross =
                    sa !== undefined && sb !== undefined && sa !== sb && adj.includes(sa) && adj.includes(sb)
                if (bestCross && !cross) continue
                const d = pointSegmentDist(points, px, py, pz, s.a, s.b)
                if ((cross && !bestCross) || d < bestDist) {
                    bestIdx = i
                    bestDist = d
                    bestCross = cross
                }
            }
            const s = record.segments[bestIdx]!
            record.segments.splice(bestIdx, 1, { a: s.a, b: pin.pointId }, { a: pin.pointId, b: s.b })
            record.consumedFwd.push(0)
            record.consumedRev.push(0)
        }
    }
    return record
}

/** Distance from a point to the segment between two PointTable points. */
function pointSegmentDist(points: PointTable, px: number, py: number, pz: number, a: number, b: number): number {
    const ax = points.x(a)
    const ay = points.y(a)
    const az = points.z(a)
    const dx = points.x(b) - ax
    const dy = points.y(b) - ay
    const dz = points.z(b) - az
    const len2 = dx * dx + dy * dy + dz * dz
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / len2)) : 0
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy), pz - (az + t * dz))
}

/** Face-owned midpoint between two crossings, Newton-projected onto the surface within the face plane. */
function splitMidpoint(
    tree: CpuSdfTree,
    points: PointTable,
    axis: 0 | 1 | 2,
    aId: number,
    bId: number,
    rootTol: number,
): number {
    const q = new Float64Array(3)
    q[0] = (points.x(aId) + points.x(bId)) / 2
    q[1] = (points.y(aId) + points.y(bId)) / 2
    q[2] = (points.z(aId) + points.z(bId)) / 2
    const grad = new Float64Array(3)
    for (let it = 0; it < 6; it++) {
        const fv = tree.f(q[0]!, q[1]!, q[2]!)
        if (Math.abs(fv) <= rootTol) break
        tree.grad(q[0]!, q[1]!, q[2]!, grad)
        grad[axis] = 0 // stay in the face plane
        const g2 = grad[0]! * grad[0]! + grad[1]! * grad[1]! + grad[2]! * grad[2]!
        if (g2 < 1e-20) break
        const k = fv / g2
        q[0] = q[0]! - k * grad[0]!
        q[1] = q[1]! - k * grad[1]!
        q[2] = q[2]! - k * grad[2]!
    }
    tree.grad(q[0]!, q[1]!, q[2]!, grad)
    return points.add(q[0]!, q[1]!, q[2]!, grad[0]!, grad[1]!, grad[2]!)
}

/** Enumerate canonical faces of all leaves and contour each exactly once. */
export function contourAllFaces(
    oct: SfccOctree,
    tree: CpuSdfTree,
    points: PointTable,
    opts: FaceContourOptions,
    signal?: AbortSignal,
): FaceContourResult {
    const lat = oct.lat
    const faces: Array<Map<number, FaceRecord>> = [new Map(), new Map(), new Map()]
    let multiRunFaces = 0
    let boundaryViolations = 0
    let keyCollisions = 0
    // Shared sub-edge recovery + stratum-tag caches for this contouring pass
    // (see options doc).
    if (opts.features && !opts.recovered) opts = { ...opts, recovered: new Map() }
    if (opts.features && !opts.stratumTags) opts = { ...opts, stratumTags: new Map() }

    let cellCounter = 0
    for (const cell of oct.leaves) {
        if ((cellCounter++ & 0xff) === 0 && signal?.aborted) throw new Error("sfcc: aborted")
        const stride = strideAtLevel(lat, cell.level)
        const base: [number, number, number] = [cell.ix * stride, cell.iy * stride, cell.iz * stride]
        for (let axis = 0 as 0 | 1 | 2; axis < 3; axis = (axis + 1) as 0 | 1 | 2) {
            for (let side = 0; side <= 1; side++) {
                // Faces are evaluated at the finer of the two incident levels:
                // if the neighbor across this side is subdivided, its finer
                // leaves enumerate the quarter faces instead.
                const ncoord: [number, number, number] = [cell.ix, cell.iy, cell.iz]
                ncoord[axis] = ncoord[axis]! + (side === 1 ? 1 : -1)
                if (oct.isInternal(cell.level, ncoord[0]!, ncoord[1]!, ncoord[2]!)) continue
                const g: [number, number, number] = [base[0]!, base[1]!, base[2]!]
                if (side === 1) g[axis] = g[axis]! + stride
                const key = packPoint(lat, g[0]!, g[1]!, g[2]!)
                const existing = faces[axis]!.get(key)
                if (existing) {
                    if (existing.len !== stride) keyCollisions++
                    continue
                }
                const rec = contourFace(oct, tree, points, axis, g[0]!, g[1]!, g[2]!, stride, opts)
                faces[axis]!.set(key, rec)
                if (rec.segments.length >= 3) multiRunFaces++
                const onRootBoundary = g[axis] === 0 || g[axis] === lat.res
                if (onRootBoundary && rec.segments.length > 0) boundaryViolations++
            }
        }
    }

    // Global duplicate-segment repair: two faces must never emit the same
    // undirected (a, b) segment — adjacent cells would collapse two distinct
    // surface arcs onto one mesh edge (3+ triangle uses ⇒ non-manifold). Can
    // arise when recovered sliver arcs on different faces share both
    // endpoints. Split EVERY occurrence with its own face-owned midpoint.
    const EDGE_BASE = 0x8000000
    const pairOwners = new Map<number, Array<{ rec: FaceRecord; idx: number }>>()
    for (const perAxis of faces) {
        for (const rec of perAxis.values()) {
            for (let i = 0; i < rec.segments.length; i++) {
                const s = rec.segments[i]!
                const k = s.a < s.b ? s.a * EDGE_BASE + s.b : s.b * EDGE_BASE + s.a
                let list = pairOwners.get(k)
                if (!list) {
                    list = []
                    pairOwners.set(k, list)
                }
                list.push({ rec, idx: i })
            }
        }
    }
    for (const list of pairOwners.values()) {
        if (list.length < 2) continue
        // Split later occurrences first so stored indices stay valid per record.
        list.sort((x, y) => y.idx - x.idx)
        for (const { rec, idx } of list) {
            const s = rec.segments[idx]!
            const mid = splitMidpoint(tree, points, rec.axis, s.a, s.b, opts.rootTol)
            rec.segments.splice(idx, 1, { a: s.a, b: mid }, { a: mid, b: s.b })
            rec.consumedFwd.push(0)
            rec.consumedRev.push(0)
        }
    }

    return { faces, multiRunFaces, boundaryViolations, keyCollisions }
}
