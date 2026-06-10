/**
 * S1c — CSG trimming and corner wiring.
 *
 * A curve sample p is ALIVE (a real crease of the final solid) iff:
 *   1. |f_tree(p)| ≤ surfaceTol — p is on the final surface;
 *   2. the adjacent strata disagree by more than the minimum dihedral
 *      (sign-adjusted normals: dot ≤ minDihedralCos) — else it's a tangential
 *      join, not a crease;
 *   3. BOTH strata have a surviving flank: probing `probeDelta` off the curve
 *      within each stratum's surface (projected onto its carrier), the full
 *      tree SDF still vanishes and the CSG winner set contains that stratum's
 *      leaf. This one predicate removes carrier over-tracing, material cut
 *      away by booleans, and buried seams — no local CSG model needed.
 *
 * Alive/dead transitions are bisected on the curve parameter (every probe
 * exactly on-curve via pointAt) and become CORNER candidates: where a curve's
 * aliveness flips, a third surface cuts it. Candidates merge by distance
 * (union-find-lite), curves are split at corners lying on them, and corner
 * records are wired with incident curve ends.
 */

import type { CpuSdfTree } from "./cpu-sdf.mjs"
import type { ResolvedTolerances } from "./tolerances.mjs"
import { makeCircleCurve, makeSegmentCurve, makeTracedCurve, type SfccFeatureCurve } from "./feature-curves.mjs"
import type { SfccCorner } from "./feature-set.mjs"
import { projectToTriple } from "./newton.mjs"
import type { SfccStratum } from "./strata.mjs"

const pA = new Float64Array(3)
const nA = new Float64Array(3)
const nB = new Float64Array(3)
const tg = new Float64Array(3)
const probe = new Float64Array(3)
const proj = new Float64Array(3)

/** One-sided flank survival: does the final surface ε off the curve consist of this stratum? */
function flankSurvives(
    tree: CpuSdfTree,
    stratum: SfccStratum,
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    dz: number,
    tol: ResolvedTolerances,
): boolean {
    for (const sign of [1, -1]) {
        probe[0] = x + sign * tol.probeDelta * dx
        probe[1] = y + sign * tol.probeDelta * dy
        probe[2] = z + sign * tol.probeDelta * dz
        stratum.project(probe[0]!, probe[1]!, probe[2]!, proj)
        if (Math.abs(tree.f(proj[0]!, proj[1]!, proj[2]!)) > tol.probeDelta * 0.2) continue
        // The surviving surface there must actually BE this stratum.
        const owners = tree.activeOwnersAt(proj[0]!, proj[1]!, proj[2]!, tol.probeDelta * 0.5)
        let ok = false
        for (const o of owners) {
            if (o.leaf.index !== stratum.leafIndex) continue
            let minAbs = Infinity
            let best = -1
            for (const st of o.leaf.strata) {
                const a = Math.abs(st.f(proj[0]!, proj[1]!, proj[2]!))
                if (a < minAbs) {
                    minAbs = a
                    best = st.id
                }
            }
            if (best === stratum.id) {
                ok = true
                break
            }
        }
        if (ok) return true
    }
    return false
}

/** Aliveness of a single on-curve point. */
export function curvePointAlive(
    tree: CpuSdfTree,
    strata: SfccStratum[],
    curve: SfccFeatureCurve,
    t: number,
    tol: ResolvedTolerances,
): boolean {
    curve.pointAt(t, pA)
    const x = pA[0]!
    const y = pA[1]!
    const z = pA[2]!
    if (Math.abs(tree.f(x, y, z)) > tol.surfaceTol) return false
    const sA = strata[curve.adjacentStrata[0]!]!
    const sB = strata[curve.adjacentStrata[1]!]!
    sA.normal(x, y, z, nA)
    sB.normal(x, y, z, nB)
    if (nA[0]! * nB[0]! + nA[1]! * nB[1]! + nA[2]! * nB[2]! > tol.minDihedralCos) return false
    curve.tangentAt(t, tg)
    // In-surface, ⊥-curve probe directions: w = n × tangent.
    const wAx = nA[1]! * tg[2]! - nA[2]! * tg[1]!
    const wAy = nA[2]! * tg[0]! - nA[0]! * tg[2]!
    const wAz = nA[0]! * tg[1]! - nA[1]! * tg[0]!
    if (!flankSurvives(tree, sA, x, y, z, wAx, wAy, wAz, tol)) return false
    const wBx = nB[1]! * tg[2]! - nB[2]! * tg[1]!
    const wBy = nB[2]! * tg[0]! - nB[0]! * tg[2]!
    const wBz = nB[0]! * tg[1]! - nB[1]! * tg[0]!
    return flankSurvives(tree, sB, x, y, z, wBx, wBy, wBz, tol)
}

export interface TrimmedRun {
    curve: SfccFeatureCurve
    t0: number
    t1: number
    /** Whole closed curve survived (no splitting needed). */
    fullClosed: boolean
}

/**
 * Sample params for aliveness classification, spacing ≈ probeDelta along the
 * curve. OPEN curves are inset by ~2·probeDelta at both ends: flank probes AT
 * an endpoint walk along the adjacent edge (two carriers tie) and
 * misclassify — runs reaching the inset boundary are extended back to the
 * true endpoint by the caller.
 */
function classificationParams(curve: SfccFeatureCurve, tol: ResolvedTolerances): number[] {
    const span = curve.tMax - curve.tMin
    const arcLen = Math.max(curve.paramDistance(curve.tMin, curve.tMin + span / 2) * 2, 1e-9)
    const n = Math.max(8, Math.min(2048, Math.ceil(arcLen / Math.max(tol.probeDelta, 1e-6))))
    let lo = curve.tMin
    let hi = curve.tMax
    if (!curve.closed) {
        const inset = Math.min(span / 4, span * ((2 * tol.probeDelta) / arcLen))
        lo += inset
        hi -= inset
    }
    const out: number[] = []
    for (let i = 0; i <= n; i++) out.push(lo + ((hi - lo) * i) / n)
    return out
}

/** Bisect an alive/dead transition to trimEps (param units scaled by local arc length). */
function bisectTransition(
    tree: CpuSdfTree,
    strata: SfccStratum[],
    curve: SfccFeatureCurve,
    tAlive: number,
    tDead: number,
    tol: ResolvedTolerances,
): number {
    let a = tAlive
    let d = tDead
    for (let i = 0; i < 40; i++) {
        const m = (a + d) / 2
        if (curve.paramDistance(a, d) < tol.cornerMergeTol / 4) break
        if (curvePointAlive(tree, strata, curve, m, tol)) a = m
        else d = m
    }
    return (a + d) / 2
}

/** Classify a curve into alive parameter runs (with transitions bisected). */
export function trimCurve(
    tree: CpuSdfTree,
    strata: SfccStratum[],
    curve: SfccFeatureCurve,
    tol: ResolvedTolerances,
): TrimmedRun[] {
    const params = classificationParams(curve, tol)
    const alive = params.map(t => curvePointAlive(tree, strata, curve, t, tol))
    if (alive.every(a => a)) {
        return [{ curve, t0: curve.tMin, t1: curve.tMax, fullClosed: curve.closed }]
    }
    if (alive.every(a => !a)) return []

    const runs: TrimmedRun[] = []
    // Walk sample intervals; refine boundaries at transitions. Runs touching
    // the first/last (inset) sample extend to the curve's true endpoint.
    let runStart: number | null = alive[0]! ? curve.tMin : null
    for (let i = 1; i < params.length; i++) {
        if (alive[i]! && runStart === null) {
            runStart = bisectTransition(tree, strata, curve, params[i]!, params[i - 1]!, tol)
        } else if (!alive[i]! && runStart !== null) {
            const end = bisectTransition(tree, strata, curve, params[i - 1]!, params[i]!, tol)
            if (curve.paramDistance(runStart, end) > tol.cornerMergeTol) {
                runs.push({ curve, t0: runStart, t1: end, fullClosed: false })
            }
            runStart = null
        }
    }
    if (runStart !== null) {
        runs.push({ curve, t0: runStart, t1: curve.tMax, fullClosed: false })
    }
    // Closed curve whose first AND last samples are alive: merge the wrap-pair.
    if (curve.closed && runs.length >= 2 && alive[0]! && alive[alive.length - 1]!) {
        const first = runs[0]!
        const last = runs[runs.length - 1]!
        if (first.t0 === params[0] && last.t1 === params[params.length - 1]) {
            runs.pop()
            runs.shift()
            // Shift the wrapped run by one period so [t0, t1] stays increasing.
            runs.push({ curve, t0: last.t0 - (curve.paramWrap ?? 0), t1: first.t1, fullClosed: false })
        }
    }
    return runs
}

export interface TrimResult {
    curves: SfccFeatureCurve[]
    corners: SfccCorner[]
}

/**
 * Trim all raw curves, derive corners (trim transitions + surviving native
 * corners), merge them, split curves at on-curve corners, and wire curveEnds.
 */
export function trimAndWire(
    tree: CpuSdfTree,
    strata: SfccStratum[],
    rawCurves: SfccFeatureCurve[],
    nativeCorners: SfccCorner[],
    tol: ResolvedTolerances,
): TrimResult {
    interface Candidate {
        x: number
        y: number
        z: number
    }
    const candidates: Candidate[] = []
    const addCandidate = (x: number, y: number, z: number): number => {
        for (let i = 0; i < candidates.length; i++) {
            const c = candidates[i]!
            if (Math.hypot(c.x - x, c.y - y, c.z - z) <= tol.cornerMergeTol) return i
        }
        candidates.push({ x, y, z })
        return candidates.length - 1
    }

    // Trim transitions have probe-resolution accuracy (~probeDelta). The exact
    // corner is the triple point {fA = fB = fC = 0}: identify the third
    // carrier (nearest foreign stratum among the CSG winners at the
    // transition) and refine by 3×3 Newton.
    const refineTransition = (curve: SfccFeatureCurve, t: number, out: Float64Array): void => {
        curve.pointAt(t, out)
        const sA = strata[curve.adjacentStrata[0]!]!
        const sB = strata[curve.adjacentStrata[1]!]!
        let best: SfccStratum | null = null
        let bestAbs = tol.probeDelta * 2
        for (const owner of tree.activeOwnersAt(out[0]!, out[1]!, out[2]!, tol.probeDelta * 2)) {
            for (const st of owner.leaf.strata) {
                if (st.id === sA.id || st.id === sB.id) continue
                const a = Math.abs(st.f(out[0]!, out[1]!, out[2]!))
                if (a < bestAbs) {
                    bestAbs = a
                    best = st
                }
            }
        }
        if (best) {
            const refined = new Float64Array(3)
            if (projectToTriple(sA, sB, best, out[0]!, out[1]!, out[2]!, tol.curveEps, tol.probeDelta * 4, refined)) {
                out.set(refined)
            }
        }
    }

    // 1. Trim every curve; collect run endpoints as corner candidates. A run
    //    end at the curve's own end is exact already (native corner); interior
    //    ends are trim transitions and get Newton-refined.
    const allRuns: TrimmedRun[] = []
    const endP = new Float64Array(3)
    const isCurveEnd = (curve: SfccFeatureCurve, t: number): boolean =>
        !curve.closed && (Math.abs(t - curve.tMin) < 1e-9 || Math.abs(t - curve.tMax) < 1e-9)
    for (const curve of rawCurves) {
        for (const run of trimCurve(tree, strata, curve, tol)) {
            allRuns.push(run)
            if (!run.fullClosed) {
                for (const t of [run.t0, run.t1]) {
                    if (isCurveEnd(curve, t)) {
                        curve.pointAt(t, endP)
                    } else {
                        refineTransition(curve, t, endP)
                    }
                    addCandidate(endP[0]!, endP[1]!, endP[2]!)
                }
            }
        }
    }
    // 2. Surviving native corners join the candidate set (dead ones — swallowed
    //    by another solid — have no alive incident runs and produce no record).
    for (const nc of nativeCorners) {
        if (Math.abs(tree.f(nc.x, nc.y, nc.z)) <= tol.surfaceTol) addCandidate(nc.x, nc.y, nc.z)
    }

    // 3. Split runs at interior on-curve candidates (e.g. a seam circle cut by
    //    a trimmed box edge's transition point).
    const splitRuns: TrimmedRun[] = []
    for (const run of allRuns) {
        const cuts: number[] = []
        for (const c of candidates) {
            const pr = run.curve.project(c.x, c.y, c.z)
            if (pr.dist > tol.cornerMergeTol * 2) continue
            let t = pr.t
            if (run.curve.paramWrap !== undefined && t > run.t1) t -= run.curve.paramWrap
            if (t > run.t0 + 1e-12 && t < run.t1 - 1e-12) {
                // Interior cut — but only if meaningfully inside.
                if (
                    run.curve.paramDistance(run.t0, t) > tol.cornerMergeTol &&
                    run.curve.paramDistance(t, run.t1) > tol.cornerMergeTol
                ) {
                    cuts.push(t)
                }
            }
        }
        if (run.fullClosed && cuts.length > 0) {
            cuts.sort((a, b) => a - b)
            // Closed loop cut k times → k arcs around the loop.
            for (let i = 0; i < cuts.length; i++) {
                const t0 = cuts[i]!
                const t1 = i + 1 < cuts.length ? cuts[i + 1]! : cuts[0]! + (run.curve.paramWrap ?? 0)
                splitRuns.push({ curve: run.curve, t0, t1, fullClosed: false })
            }
        } else if (cuts.length > 0) {
            cuts.sort((a, b) => a - b)
            let prev = run.t0
            for (const t of cuts) {
                splitRuns.push({ curve: run.curve, t0: prev, t1: t, fullClosed: false })
                prev = t
            }
            splitRuns.push({ curve: run.curve, t0: prev, t1: run.t1, fullClosed: false })
        } else {
            splitRuns.push(run)
        }
    }

    // 4. Emit final curves, snapping endpoints to candidates and wiring corners.
    const corners: SfccCorner[] = candidates.map((c, i) => ({
        id: i,
        x: c.x,
        y: c.y,
        z: c.z,
        strata: [],
        curveEnds: [],
    }))
    const out: SfccFeatureCurve[] = []
    const q0 = new Float64Array(3)
    const q1 = new Float64Array(3)
    // Run ends carry trim-resolution error (~probeDelta); corners are
    // Newton-exact. Snap within the trim resolution and re-parameterize the
    // run so its emitted geometry ends exactly at the corner.
    const snapRadius = Math.max(tol.cornerMergeTol * 2, tol.probeDelta * 2.5)
    for (const run of splitRuns) {
        const src = run.curve
        const id = out.length
        let next: SfccFeatureCurve
        if (run.fullClosed) {
            next = remakeCurve(src, id, run.t0, run.t1, true)
        } else {
            src.pointAt(run.t0, q0)
            src.pointAt(run.t1, q1)
            const c0 = nearestCandidate(candidates, q0, snapRadius)
            const c1 = nearestCandidate(candidates, q1, snapRadius)
            let t0 = run.t0
            let t1 = run.t1
            if (c0 >= 0) {
                const cand = candidates[c0]!
                const pr = src.project(cand.x, cand.y, cand.z)
                let tc = pr.t
                if (src.paramWrap !== undefined && tc > t1) tc -= src.paramWrap
                if (tc < t1) t0 = tc
            }
            if (c1 >= 0) {
                const cand = candidates[c1]!
                const pr = src.project(cand.x, cand.y, cand.z)
                let tc = pr.t
                if (src.paramWrap !== undefined && tc < t0) tc += src.paramWrap
                if (tc > t0) t1 = tc
            }
            // Over-trace tails: aliveness has ~probeDelta resolution, so trimmed
            // runs overshoot corners slightly and splitting leaves stubs that
            // loop back to one corner or fall below the trim resolution. Drop
            // them — they carry no geometry the corner itself doesn't.
            if (c0 >= 0 && c0 === c1) continue
            if (src.paramDistance(t0, t1) < snapRadius) continue
            next = remakeCurve(src, id, t0, t1, false)
            if (c0 >= 0) {
                next.cornerStart = c0
                corners[c0]!.curveEnds.push({ curveId: id, end: 0 })
                for (const s of src.adjacentStrata) if (!corners[c0]!.strata.includes(s)) corners[c0]!.strata.push(s)
            }
            if (c1 >= 0) {
                next.cornerEnd = c1
                corners[c1]!.curveEnds.push({ curveId: id, end: 1 })
                for (const s of src.adjacentStrata) if (!corners[c1]!.strata.includes(s)) corners[c1]!.strata.push(s)
            }
        }
        out.push(next)
    }
    // Corners with no incident curve ends are spurious (e.g. native corner of
    // a fully-buried edge set) — keep only wired ones, compacting ids.
    const keep = corners.filter(c => c.curveEnds.length > 0 || nearAliveSurface(tree, c, tol))
    const remap = new Map<number, number>()
    keep.forEach((c, i) => remap.set(c.id, i))
    for (const curve of out) {
        curve.cornerStart = curve.cornerStart >= 0 ? remap.get(curve.cornerStart) ?? -1 : -1
        curve.cornerEnd = curve.cornerEnd >= 0 ? remap.get(curve.cornerEnd) ?? -1 : -1
    }
    const finalCorners = keep.map((c, i) => ({ ...c, id: i }))
    return { curves: out, corners: finalCorners }
}

function nearAliveSurface(tree: CpuSdfTree, c: SfccCorner, tol: ResolvedTolerances): boolean {
    // Valence-0 corners (cone apex) keep their record if still on the surface.
    return c.curveEnds.length === 0 && c.strata.length === 0 && Math.abs(tree.f(c.x, c.y, c.z)) <= tol.surfaceTol
}

function nearestCandidate(candidates: Array<{ x: number; y: number; z: number }>, p: Float64Array, tol: number): number {
    let best = -1
    let bestD = tol
    for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i]!
        const d = Math.hypot(c.x - p[0]!, c.y - p[1]!, c.z - p[2]!)
        if (d < bestD) {
            bestD = d
            best = i
        }
    }
    return best
}

/** Re-emit a parameter sub-range of a curve as a standalone curve. */
function remakeCurve(src: SfccFeatureCurve, id: number, t0: number, t1: number, fullClosed: boolean): SfccFeatureCurve {
    if (fullClosed) {
        // Unchanged closed curve — re-id only.
        return cloneWithId(src, id)
    }
    if (src.kind === "segment") {
        const a = new Float64Array(3)
        const b = new Float64Array(3)
        src.pointAt(t0, a)
        src.pointAt(t1, b)
        return makeSegmentCurve(id, src.ownerNodeId, src.adjacentStrata, a[0]!, a[1]!, a[2]!, b[0]!, b[1]!, b[2]!)
    }
    if (src.kind === "circle") {
        // Rebuild from three on-curve points (center/axis/radius recovery).
        return circleFromSource(src, id, t0, t1)
    }
    // traced: re-sample the sub-range from the source polyline density.
    const span = t1 - t0
    const n = Math.max(2, Math.ceil(Math.abs(span)) + 1)
    const samples = new Float64Array(n * 3)
    for (let i = 0; i < n; i++) {
        src.pointAt(t0 + (span * i) / (n - 1), samples, i * 3)
    }
    const tang = new Float64Array(3)
    return makeTracedCurve(
        id,
        src.adjacentStrata,
        samples,
        false,
        (x, y, z, out, off = 0) => {
            const pr = src.project(x, y, z)
            src.pointAt(pr.t, out as Float64Array, off)
            return true
        },
        (x, y, z, out, off = 0) => {
            const pr = src.project(x, y, z)
            src.tangentAt(pr.t, tang)
            out[off] = tang[0]!
            out[off + 1] = tang[1]!
            out[off + 2] = tang[2]!
        },
    )
}

function cloneWithId(src: SfccFeatureCurve, id: number): SfccFeatureCurve {
    // Curves are plain objects with closure methods — spread re-binds nothing.
    return { ...src, id, cornerStart: -1, cornerEnd: -1 }
}

/** Recover an arc curve from a source circle's geometry. */
function circleFromSource(src: SfccFeatureCurve, id: number, t0: number, t1: number): SfccFeatureCurve {
    // Reconstruct center/axis/r from three points on the circle.
    const a = new Float64Array(3)
    const b = new Float64Array(3)
    const c = new Float64Array(3)
    src.pointAt(0, a)
    src.pointAt((2 * Math.PI) / 3, b)
    src.pointAt((4 * Math.PI) / 3, c)
    // Circumcenter of three points in 3D.
    const abx = b[0]! - a[0]!
    const aby = b[1]! - a[1]!
    const abz = b[2]! - a[2]!
    const acx = c[0]! - a[0]!
    const acy = c[1]! - a[1]!
    const acz = c[2]! - a[2]!
    const nx = aby * acz - abz * acy
    const ny = abz * acx - abx * acz
    const nz = abx * acy - aby * acx
    const n2 = nx * nx + ny * ny + nz * nz
    const ab2 = abx * abx + aby * aby + abz * abz
    const ac2 = acx * acx + acy * acy + acz * acz
    // center = a + (|AC|²(AB×AC)×AB + |AB|²AC×(AB×AC)) / (2|AB×AC|²)
    const t1x = (ny * abz - nz * aby) * ac2
    const t1y = (nz * abx - nx * abz) * ac2
    const t1z = (nx * aby - ny * abx) * ac2
    const t2x = (acy * nz - acz * ny) * ab2
    const t2y = (acz * nx - acx * nz) * ab2
    const t2z = (acx * ny - acy * nx) * ab2
    const cx = a[0]! + (t1x + t2x) / (2 * n2)
    const cy = a[1]! + (t1y + t2y) / (2 * n2)
    const cz = a[2]! + (t1z + t2z) / (2 * n2)
    const r = Math.hypot(a[0]! - cx, a[1]! - cy, a[2]! - cz)
    const nl = Math.sqrt(n2)
    // NOTE: the rebuilt basis differs from the source's, so arc angles must be
    // recomputed via projection of the source's t0/t1 points.
    const arcCurve = makeCircleCurve(id, src.ownerNodeId, src.adjacentStrata, cx, cy, cz, nx / nl, ny / nl, nz / nl, r)
    const p0 = new Float64Array(3)
    const p1 = new Float64Array(3)
    src.pointAt(t0, p0)
    src.pointAt(t1, p1)
    let a0 = arcCurve.project(p0[0]!, p0[1]!, p0[2]!).t
    let a1 = arcCurve.project(p1[0]!, p1[1]!, p1[2]!).t
    // Choose the arc that contains the source's midpoint.
    const mid = new Float64Array(3)
    src.pointAt((t0 + t1) / 2, mid)
    const am = arcCurve.project(mid[0]!, mid[1]!, mid[2]!).t
    const TAU = 2 * Math.PI
    let sweep = (a1 - a0) % TAU
    if (sweep <= 0) sweep += TAU
    let inArc = (am - a0 + TAU) % TAU <= sweep
    if (!inArc) {
        // Take the complementary arc by swapping direction.
        const tmp = a0
        a0 = a1
        a1 = tmp
        sweep = TAU - sweep
        inArc = true
    }
    return makeCircleCurve(id, src.ownerNodeId, src.adjacentStrata, cx, cy, cz, nx / nl, ny / nl, nz / nl, r, {
        t0: a0,
        t1: a0 + sweep,
    })
}
