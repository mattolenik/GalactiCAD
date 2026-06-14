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
import { nowMs, type FaceContourPerf } from "./sfcc-perf.mjs"
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
    /** Opt-in profiling sub-buckets (findRoot / recovery / pinning), absent off the profile path. */
    perf?: FaceContourPerf
    /** Lipschitz pre-cull in `recoveredCrossingsFor` (skip the SUBDIV scan when the carrier can't reach zero on the sub-edge). */
    recoveryCull?: boolean
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

/**
 * Per-face scratch pooled across an entire contouring pass: the boundary walk
 * builds these fresh on every one of ~tens-of-thousands of faces, so reusing
 * one set (cleared per face) trades that allocation churn for a clear()/length=0.
 * Safe because contouring is serial and each buffer is fully rewritten before
 * read within a face — so the meshes are byte-identical.
 */
interface FaceContourScratch {
    nodes: BoundaryNode[]
    nodeSide: Map<number, number>
    nodeStratum: Map<number, number>
    scratch: Float64Array
    wa: Float64Array
    wb: Float64Array
}

/**
 * Root-find the iso-crossing on a world segment with f0 < 0 ≤ f1 or f1 < 0 ≤ f0.
 * Exported for the edge-root determinism probe; call sites should use
 * `canonicalEdgeRoot` so the result is independent of endpoint order.
 */
export function findRoot(
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
 * Iso-crossing on an axis-aligned sub-edge, computed INDEPENDENTLY of the
 * direction the caller discovered the edge: the endpoints are canonicalized to a
 * fixed (lexicographically-least-first) order before root-finding, so a sub-edge
 * shared by faces that walk it in opposite directions yields a BIT-IDENTICAL
 * point and normal.
 *
 * This is what keeps the keyed point table (crossingKey) first-writer-wins
 * correct under a PARALLEL meshing pass: the create closure becomes a pure
 * function of the sub-edge key, so whichever thread wins the race stores the same
 * value (see determinism_test / mesh-canonical; required for the Rust port's
 * rayon weld). The edge is axis-aligned, so the lexicographically-least endpoint
 * is exactly the lattice min corner that keys the point — keeping this
 * canonicalization consistent with crossingKey().
 */
export function canonicalEdgeRoot(
    tree: CpuSdfTree,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    fa: number,
    fb: number,
    tol: number,
    out: Float64Array,
): void {
    const bFirst = bx < ax || (bx === ax && (by < ay || (by === ay && bz < az)))
    if (bFirst) findRoot(tree, bx, by, bz, ax, ay, az, fb, fa, tol, out)
    else findRoot(tree, ax, ay, az, bx, by, bz, fa, fb, tol, out)
}

/**
 * Compute (once, globally cached) the recovered per-stratum boundary crossings
 * of a sub-edge with no tree-f sign change.
 *
 * Detection: each nearby stratum carrier is scanned for ALL roots along the
 * sub-edge (multi-bracket subdivision — one carrier can legitimately cross
 * twice, e.g. the cap under both wedges flanking a corner), weakly filtered to
 * points where the full tree SDF also vanishes.
 *
 * Verification (parity-exact): candidates are sorted by t and each is kept iff
 * the tree SDF actually changes sign between its neighboring gap midpoints —
 * the ground-truth test for "this carrier root IS a surface crossing". Since
 * the sub-edge endpoint samples agree in sign, the surviving set is even by
 * construction, so boundary parity is safe for ANY survivor count. This is
 * what makes corner zones recoverable: a sub-edge there can carry 3+ carrier
 * candidates (two walls + cap), where the old exactly-2 gate dropped
 * everything and the contour shortcut across the corner wedge (≈half-cell
 * V-notch at the apex).
 *
 * Gating: 2 survivors must still form a wedge pair (distinct strata flanking a
 * common curve, or both incident to a common corner) — unrelated stray pairs
 * fabricate arcs. 4+ survivors are accepted as-is: each is stratum-tagged and
 * the pairing passes (1:1 per-stratum, run rule, pin splice) route them.
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

    if (opts.perf) opts.perf.recoverCalls++
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
    const atT = (t: number, o: Float64Array): void => {
        o[0] = aWorld[0]! + (bWorld[0]! - aWorld[0]!) * t
        o[1] = aWorld[1]! + (bWorld[1]! - aWorld[1]!) * t
        o[2] = aWorld[2]! + (bWorld[2]! - aWorld[2]!) * t
    }
    const q = new Float64Array(3)

    // --- detection: all carrier roots per nearby stratum ---
    const SUBDIV = 8
    const cand: Array<{ t: number; stratum: number; fAbs: number }> = []
    const seen = new Set<number>()
    for (const cid of curveIds) {
        for (const sid of features.curves[cid]!.adjacentStrata) {
            if (seen.has(sid)) continue
            seen.add(sid)
            const st = features.strata[sid]!
            // Lipschitz pre-cull: the farthest sub-edge point is halfLen from the
            // midpoint, so |st.f(mid)| > halfLen·gradBound proves the carrier has
            // no root anywhere on the edge (single OR double crossing) — skip its
            // SUBDIV scan. gradBound is the same Lipschitz constant the octree's
            // certified-empty cull trusts. Sound ⇒ byte-identical (only skips
            // scans that would find nothing); one eval replaces ~9.
            if (opts.recoveryCull) {
                atT(0.5, q)
                if (opts.perf) opts.perf.recoverScanEvals++
                if (Math.abs(st.f(q[0]!, q[1]!, q[2]!)) > (edgeLen / 2) * tree.gradBound) continue
            }
            let prevT = 0
            atT(0, q)
            let prevF = st.f(q[0]!, q[1]!, q[2]!)
            if (opts.perf) opts.perf.recoverScanEvals++
            for (let k = 1; k <= SUBDIV; k++) {
                const tk = k / SUBDIV
                atT(tk, q)
                const fk = st.f(q[0]!, q[1]!, q[2]!)
                if (opts.perf) opts.perf.recoverScanEvals++
                if (prevF < 0 !== fk < 0) {
                    // Bisect the carrier root in [prevT, tk].
                    let lo = prevT
                    let hi = tk
                    let flo = prevF
                    for (let i = 0; i < 50 && (hi - lo) * edgeLen > opts.rootTol; i++) {
                        const mid = (lo + hi) / 2
                        atT(mid, q)
                        const fm = st.f(q[0]!, q[1]!, q[2]!)
                        if (opts.perf) opts.perf.recoverBisectEvals++
                        if (fm < 0 === flo < 0) {
                            lo = mid
                            flo = fm
                        } else {
                            hi = mid
                        }
                    }
                    const t = (lo + hi) / 2
                    atT(t, q)
                    const fAbs = Math.abs(tree.f(q[0]!, q[1]!, q[2]!))
                    if (fAbs <= opts.rootTol * 4) cand.push({ t, stratum: sid, fAbs })
                }
                prevT = tk
                prevF = fk
            }
        }
    }
    if (cand.length === 0) {
        cache.set(cacheKey, out)
        return out
    }
    cand.sort((x, y) => x.t - y.t)
    // Dedupe near-coincident candidates (two carriers rooting at the same
    // point = the crease itself pierces the sub-edge); keep the better fit.
    // AMBIGUOUS sets only: a sub-tolerance wedge pair is two legitimately
    // near-coincident crossings — merging it leaves an odd singleton and the
    // pair is lost (measured: fallback chips on sharp helical edges).
    let dd = cand
    if (cand.length > 2) {
        dd = []
        for (const c of cand) {
            const last = dd[dd.length - 1]
            if (last && (c.t - last.t) * edgeLen < opts.rootTol * 2) {
                if (c.fAbs < last.fAbs) dd[dd.length - 1] = c
                continue
            }
            dd.push(c)
        }
    }

    // --- verification: ground-truth sign flips at gap midpoints ---
    // Applied only to AMBIGUOUS sets (3+ candidates) to select the real even
    // subset. Two-candidate sets keep the legacy un-verified acceptance: a
    // sub-tolerance sliver's interior midpoint can sample outside (positions
    // are only rootTol-accurate), and vetoing such pairs regresses cells that
    // meshed fine for years (measured: fallback chips on sharp helical edges).
    let survivors = dd
    let gapInside: boolean[] | null = null
    if (dd.length > 2) {
        const ts = [0, ...dd.map(c => c.t), 1]
        gapInside = []
        for (let g = 0; g < ts.length - 1; g++) {
            atT((ts[g]! + ts[g + 1]!) / 2, q)
            gapInside.push(tree.f(q[0]!, q[1]!, q[2]!) < 0)
        }
        const gi = gapInside
        survivors = dd.filter((_, i) => gi[i]! !== gi[i + 1]!)
    }
    // Parity defense: endpoint samples agree, so survivors must be even; an
    // odd set means a real crossing escaped detection — drop everything
    // rather than corrupt boundary parity.
    if (survivors.length === 0 || survivors.length % 2 !== 0) {
        cache.set(cacheKey, out)
        return out
    }

    // Structural gate shared by the 2-case and the dips of larger sets: a
    // crossing pair bounding a material dip must flank a common curve's wedge
    // or share a common corner's strata — anything else is a stray pairing
    // that fabricates arcs.
    const isWedgePair = (sa: number, sb: number): boolean => {
        if (sa === sb) return false
        for (const cid of curveIds) {
            const adj = features.curves[cid]!.adjacentStrata
            if (adj.includes(sa) && adj.includes(sb)) return true
        }
        for (const cornerId of features.index.cornersInBox(
            Math.min(aWorld[0]!, bWorld[0]!) - inflate,
            Math.min(aWorld[1]!, bWorld[1]!) - inflate,
            Math.min(aWorld[2]!, bWorld[2]!) - inflate,
            Math.max(aWorld[0]!, bWorld[0]!) + inflate,
            Math.max(aWorld[1]!, bWorld[1]!) + inflate,
            Math.max(aWorld[2]!, bWorld[2]!) + inflate,
        )) {
            const st = features.corners[cornerId]!.strata
            if (st.includes(sa) && st.includes(sb)) return true
        }
        return false
    }
    if (survivors.length > 2) {
        // Each "dip" (gap whose inside-ness differs from the endpoints') is
        // bounded by two consecutive survivors — require every dip to be a
        // wedge pair. Unstructured 4+ sets measurably fabricate fallback
        // cells and pits.
        const endInside = gapInside![0]!
        // Recompute gap structure over survivors only.
        const sTs = [0, ...survivors.map(c => c.t), 1]
        let ok = true
        for (let g = 1; g < sTs.length - 2 && ok; g++) {
            atT((sTs[g]! + sTs[g + 1]!) / 2, q)
            const inside = tree.f(q[0]!, q[1]!, q[2]!) < 0
            if (inside !== endInside) {
                // dip bounded by survivors g−1 and g
                if (!isWedgePair(survivors[g - 1]!.stratum, survivors[g]!.stratum)) ok = false
            }
        }
        if (!ok) {
            cache.set(cacheKey, out)
            return out
        }
    }

    // --- gating ---
    if (survivors.length === 2 && !isWedgePair(survivors[0]!.stratum, survivors[1]!.stratum)) {
        // The canonical arc-through pair must be a wedge pair (distinct
        // strata flanking a common curve, or sharing a common corner —
        // wall/wall and wall/cap slivers near an apex have no single
        // flanking curve).
        cache.set(cacheKey, out)
        return out
    }

    for (const c of survivors) {
        atT(c.t, q)
        const qx = q[0]!
        const qy = q[1]!
        const qz = q[2]!
        const id = points.getOrCreateStr(`SC:${cacheKey}:${c.stratum}:${c.t.toFixed(9)}`, o => {
            o[0] = qx
            o[1] = qy
            o[2] = qz
            tree.grad(qx, qy, qz, o, 3)
        })
        out.push({ id, t: c.t, stratum: c.stratum })
    }
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
    pool: FaceContourScratch,
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

    const nodes = pool.nodes
    nodes.length = 0
    /** Crossing point id → face boundary side (walk index 0-3): segments whose
     * endpoints lie on the SAME side run along a cell-edge line shared by up
     * to four faces and must be split with a face-owned midpoint. */
    const nodeSide = pool.nodeSide
    nodeSide.clear()
    /** Crossing point id → stratum id (stratum-tagged crossings pair per-stratum):
     * recovered crossings carry their carrier's id; visible crossings near a
     * feature curve are tagged via `stratumTagFor`. */
    const nodeStratum = pool.nodeStratum
    nodeStratum.clear()
    const scratch = pool.scratch
    const wa = pool.wa
    const wb = pool.wb

    // faceWalkMs = the boundary walk MINUS the root/recover/tag kernels timed
    // inside it (snapshot-and-subtract → disjoint from those buckets).
    const tWalk = opts.perf ? nowMs() : 0
    const walkRootBefore = opts.perf ? opts.perf.faceRootMs : 0
    const walkRecoverBefore = opts.perf ? opts.perf.faceRecoverMs : 0
    const walkTagBefore = opts.perf ? opts.perf.faceTagMs : 0
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
                    const tR = opts.perf ? nowMs() : 0
                    canonicalEdgeRoot(tree, wa[0]!, wa[1]!, wa[2]!, wb[0]!, wb[1]!, wb[2]!, f0, f1, opts.rootTol, scratch)
                    if (opts.perf) opts.perf.faceRootMs += nowMs() - tR
                    out.set(scratch)
                })
                nodes.push({ crossing: id, inside: false })
                nodeSide.set(id, walkIndex)
                if (opts.features && opts.stratumTags) {
                    pointToWorld(lat, p0[0]!, p0[1]!, p0[2]!, wa)
                    pointToWorld(lat, p1[0]!, p1[1]!, p1[2]!, wb)
                    const tTag = opts.perf ? nowMs() : 0
                    const tag = stratumTagFor(id, wa, wb, tree, points, opts)
                    if (opts.perf) opts.perf.faceTagMs += nowMs() - tTag
                    if (tag >= 0) nodeStratum.set(id, tag)
                }
            } else if (opts.features && opts.recovered) {
                // Sub-sample arc-endpoint recovery (see FaceContourOptions.recovered).
                const canonMin = walk.dir === 1 ? p0 : p1
                const canonMax = walk.dir === 1 ? p1 : p0
                pointToWorld(lat, canonMin[0]!, canonMin[1]!, canonMin[2]!, wa)
                pointToWorld(lat, canonMax[0]!, canonMax[1]!, canonMax[2]!, wb)
                const tRec = opts.perf ? nowMs() : 0
                const rec = recoveredCrossingsFor(subKey, wa, wb, tree, points, opts)
                if (opts.perf) opts.perf.faceRecoverMs += nowMs() - tRec
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

    if (opts.perf) {
        opts.perf.faceWalkMs +=
            nowMs() -
            tWalk -
            (opts.perf.faceRootMs - walkRootBefore) -
            (opts.perf.faceRecoverMs - walkRecoverBefore) -
            (opts.perf.faceTagMs - walkTagBefore)
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
        // facePinQueryMs = the pin block MINUS axisPlaneCrossings (facePinMs):
        // the curvesInBox query + in-rect filter + averaged-normal getOrCreateStr.
        const tPinBlock = opts.perf ? nowMs() : 0
        const pinFacePinBefore = opts.perf ? opts.perf.facePinMs : 0
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
            const tPin = opts.perf ? nowMs() : 0
            const pinCrossings = curve.axisPlaneCrossings(axis, coord)
            if (opts.perf) opts.perf.facePinMs += nowMs() - tPin
            for (const cr of pinCrossings) {
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
        if (opts.perf) {
            opts.perf.facePinQueryMs += nowMs() - tPinBlock - (opts.perf.facePinMs - pinFacePinBefore)
        }
    }

    // facePairMs = everything from here to the return: pin-route, two-pass
    // pairing (tally + run rule + collinear split), and pin-anchored splice.
    const tPair = opts.perf ? nowMs() : 0
    // Route through pinned feature points: the certified case is one pin with
    // one boundary inside-run (exit → pin → enter, a single kinked arc).
    if (record.pins.length === 1 && crossings.length === 2) {
        const pin = record.pins[0]!
        const exit = crossings.find(c => !c.enter)!
        const enter = crossings.find(c => c.enter)!
        record.segments.push({ a: exit.id, b: pin.pointId }, { a: pin.pointId, b: enter.id })
        record.consumedFwd.push(0, 0)
        record.consumedRev.push(0, 0)
        if (opts.perf) opts.perf.facePairMs += nowMs() - tPair
        return record
    }
    // Pins in any other configuration aren't certified yet (corner faces land
    // in P5) — fall through to the featureless pairing, which keeps the mesh
    // closed; callers see the pins and count the fallback.

    if (crossings.length === 0) {
        if (opts.perf) opts.perf.facePairMs += nowMs() - tPair
        return record
    }

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
    // face-center sample as the oracle there. The chord between the pair must
    // also stay on the surface: with multi-dip recovery, one carrier can
    // legitimately cross the face at two SEPARATE slivers (e.g. the cap under
    // both wedges flanking a corner) — pairing those connects through open
    // air; the run rule handles them correctly instead.
    const tally = new Map<number, { enters: number[]; exits: number[] }>() // stratum → crossing indexes
    for (let i = 0; i < n; i++) {
        const s = nodeStratum.get(crossings[i]!.id)
        if (s === undefined) continue
        let t = tally.get(s)
        if (!t) tally.set(s, (t = { enters: [], exits: [] }))
        ;(crossings[i]!.enter ? t.enters : t.exits).push(i)
    }
    const ext = len * lat.step
    for (const t of tally.values()) {
        if (t.enters.length === 1 && t.exits.length === 1) {
            const ea = crossings[t.enters[0]!]!.id
            const xa = crossings[t.exits[0]!]!.id
            const mx = (points.x(ea) + points.x(xa)) / 2
            const my = (points.y(ea) + points.y(xa)) / 2
            const mz = (points.z(ea) + points.z(xa)) / 2
            if (Math.abs(tree.f(mx, my, mz)) > ext * 0.05) continue
            matchedEnter.add(t.enters[0]!)
            partnerOf.set(t.exits[0]!, ea)
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
            // Host selection: skip near-degenerate segments first (recovered
            // cap pairs where the wedge tip grazes a cell-edge line are
            // micro-arcs coincident with the pin itself — a distance- or
            // tag-based preference would pick them and strand the pin in a
            // micro-loop, away from the wedge loop that carries the other
            // pin). Among the remaining, prefer the segment crossing the
            // pin's wedge (endpoint strata = the curve's two flanks), then
            // the nearest.
            const minLen = opts.rootTol * 8
            for (const lengthFloor of [minLen, 0]) {
                let bestIdx = -1
                let bestDist = Infinity
                let bestCross = false
                for (let i = 0; i < record.segments.length; i++) {
                    const s = record.segments[i]!
                    const dx = points.x(s.b) - points.x(s.a)
                    const dy = points.y(s.b) - points.y(s.a)
                    const dz = points.z(s.b) - points.z(s.a)
                    if (lengthFloor > 0 && dx * dx + dy * dy + dz * dz < lengthFloor * lengthFloor) continue
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
                if (bestIdx < 0) continue // every segment below the floor — retry without it
                const s = record.segments[bestIdx]!
                record.segments.splice(bestIdx, 1, { a: s.a, b: pin.pointId }, { a: pin.pointId, b: s.b })
                record.consumedFwd.push(0)
                record.consumedRev.push(0)
                break
            }
        }
    }
    if (opts.perf) opts.perf.facePairMs += nowMs() - tPair
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
    const mx = (points.x(aId) + points.x(bId)) / 2
    const my = (points.y(aId) + points.y(bId)) / 2
    const mz = (points.z(aId) + points.z(bId)) / 2
    const segLen = Math.hypot(
        points.x(bId) - points.x(aId),
        points.y(bId) - points.y(aId),
        points.z(bId) - points.z(aId),
    )
    const q = new Float64Array(3)
    q[0] = mx
    q[1] = my
    q[2] = mz
    const grad = new Float64Array(3)
    for (let it = 0; it < 6; it++) {
        const fv = tree.f(q[0]!, q[1]!, q[2]!)
        if (Math.abs(fv) <= rootTol) break
        tree.grad(q[0]!, q[1]!, q[2]!, grad)
        // Full 3D projection (deliberately NOT face-plane-constrained): the
        // split midpoints of the SAME chord on different faces then converge
        // to the SAME surface point, collapsing the sliver strip between the
        // two arcs to zero width — combinatorially the arcs stay distinct
        // (separate point ids), so the duplicate-segment non-manifold guard
        // is unaffected. In-plane projection separated them along the
        // surface, leaving visibly folded micro-strips along cell-edge lines.
        const g2 = grad[0]! * grad[0]! + grad[1]! * grad[1]! + grad[2]! * grad[2]!
        if (g2 < 1e-20) break
        const k = fv / g2
        q[0] = q[0]! - k * grad[0]!
        q[1] = q[1]! - k * grad[1]!
        q[2] = q[2]! - k * grad[2]!
    }
    // Validate: near-degenerate in-plane gradients (surface ⟂ face) make the
    // Newton step explode — an unvalidated result is a vertex floating off
    // the surface that fans into protruding spikes. The true arc midpoint
    // can't be farther from the chord midpoint than ~the chord itself; on
    // drift or residual failure fall back to the plain average of the two
    // on-surface endpoints (error bounded by the chord sag).
    const drift = Math.hypot(q[0]! - mx, q[1]! - my, q[2]! - mz)
    if (drift > segLen + rootTol * 8 || Math.abs(tree.f(q[0]!, q[1]!, q[2]!)) > rootTol * 8) {
        q[0] = mx
        q[1] = my
        q[2] = mz
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

    // One pooled scratch set reused for every face (see FaceContourScratch).
    const pool: FaceContourScratch = {
        nodes: [],
        nodeSide: new Map(),
        nodeStratum: new Map(),
        scratch: new Float64Array(6),
        wa: new Float64Array(3),
        wb: new Float64Array(3),
    }

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
                const rec = contourFace(oct, tree, points, axis, g[0]!, g[1]!, g[2]!, stride, opts, pool)
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
    const tDedup = opts.perf ? nowMs() : 0
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
    if (opts.perf) opts.perf.faceDedupMs += nowMs() - tDedup

    return { faces, multiRunFaces, boundaryViolations, keyCollisions }
}
