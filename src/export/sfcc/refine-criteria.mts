/**
 * S2 refinement criteria as pure functions (P3 scope: the smooth-surface
 * certificates). Cheap-first ordering; `true` means the cell must split.
 *
 * Criterion (0), the certified empty cull (|f(center)| > √3·halfSize via the
 * L=1 Lipschitz bound), lives in the octree descent itself — culled cells are
 * never created. Feature criteria (i)/(ii) land in P4.
 *
 * Implemented here (v1 surrogates per the design doc §3.2):
 * - (iii-a) hidden-component guard is deliberately NOT a split rule in v1:
 *   the centered Lipschitz bound can never certify cells that touch the
 *   surface tangentially from outside, so a blanket "no corner sign change →
 *   split" refines the entire surface-adjacent shell to depthMax (measured:
 *   ~150k degenerate cells on a plain sphere). No-sign-change cells are
 *   simply inactive — sub-cell blobs/tangencies below depthMin resolution are
 *   missed, as in every grid contouring method; the full Varadhan/PV interval
 *   certificate is deferred behind this interface.
 * - (iii-b) per-stratum normal variation: for each smooth patch active near
 *   the cell, stratum normals sampled at the 8 corners + center must agree
 *   pairwise to `normalVariationCos` — the Plantinga–Vegter small-normal-
 *   variation surrogate, applied per stratum where the CSG SDF is smooth.
 * - (iii-c) per-stratum edge-crossing uniqueness: equal-sign cell edges must
 *   Lipschitz-certify no double crossing of the stratum carrier; sign-change
 *   edges must have monotone directional derivative.
 */

import type { CpuSdfTree } from "./cpu-sdf.mjs"
import type { SfccStratum } from "./strata.mjs"
import type { SfccFeatureSet } from "./feature-set.mjs"
import {
    CELL_EDGES,
    cellAabb,
    cellSizeAtLevel,
    cornerOffset,
    pointToWorld,
    strideAtLevel,
    type SfccLattice,
} from "./lattice.mjs"

export interface RefineProbe {
    /** World positions of the 8 cell corners (xyz × 8) then the center (xyz). */
    pts: Float64Array
    /** f at the 8 corners (from the shared sample map) and the center. */
    f: Float64Array
    level: number
    cellSize: number
}

/** Build the probe data for a cell; corner f values come from the octree's shared sample map. */
export function makeProbe(
    lat: SfccLattice,
    tree: CpuSdfTree,
    sampleAt: (gx: number, gy: number, gz: number) => number,
    level: number,
    ix: number,
    iy: number,
    iz: number,
): RefineProbe {
    const stride = strideAtLevel(lat, level)
    const pts = new Float64Array(27)
    const f = new Float64Array(9)
    for (let c = 0; c < 8; c++) {
        const gx = (ix + cornerOffset(c, 0)) * stride
        const gy = (iy + cornerOffset(c, 1)) * stride
        const gz = (iz + cornerOffset(c, 2)) * stride
        pointToWorld(lat, gx, gy, gz, pts, c * 3)
        f[c] = sampleAt(gx, gy, gz)
    }
    pointToWorld(lat, (ix + 0.5) * stride, (iy + 0.5) * stride, (iz + 0.5) * stride, pts, 24)
    f[8] = tree.f(pts[24]!, pts[25]!, pts[26]!)
    return { pts, f, level, cellSize: cellSizeAtLevel(lat, level) }
}

export function hasCornerSignChange(probe: RefineProbe): boolean {
    const first = probe.f[0]! < 0
    for (let c = 1; c < 8; c++) {
        if (probe.f[c]! < 0 !== first) return true
    }
    return false
}

/**
 * Strata active near this cell: for each probe point within √3·cellSize of
 * the surface, the winning leaf's closest patch. Deduplicated by stratum id.
 */
export function activeStrata(tree: CpuSdfTree, probe: RefineProbe): SfccStratum[] {
    const out: SfccStratum[] = []
    const seen = new Set<number>()
    const reach = Math.sqrt(3) * probe.cellSize
    for (let i = 0; i < 9; i++) {
        if (Math.abs(probe.f[i]!) >= reach) continue
        const x = probe.pts[i * 3]!
        const y = probe.pts[i * 3 + 1]!
        const z = probe.pts[i * 3 + 2]!
        for (const owner of tree.activeOwnersAt(x, y, z, 0)) {
            let best: SfccStratum | null = null
            let bestAbs = Infinity
            for (const st of owner.leaf.strata) {
                const a = Math.abs(st.f(x, y, z))
                if (a < bestAbs) {
                    bestAbs = a
                    best = st
                }
            }
            if (best && !seen.has(best.id)) {
                seen.add(best.id)
                out.push(best)
            }
        }
    }
    return out
}

/** (iii-b): max pairwise normal deviation of `stratum` over the 9 probe points. */
export function stratumNormalVariationOk(stratum: SfccStratum, probe: RefineProbe, minCos: number): boolean {
    const n = new Float64Array(27)
    for (let i = 0; i < 9; i++) {
        stratum.normal(probe.pts[i * 3]!, probe.pts[i * 3 + 1]!, probe.pts[i * 3 + 2]!, n, i * 3)
    }
    for (let i = 0; i < 9; i++) {
        for (let j = i + 1; j < 9; j++) {
            const dot =
                n[i * 3]! * n[j * 3]! + n[i * 3 + 1]! * n[j * 3 + 1]! + n[i * 3 + 2]! * n[j * 3 + 2]!
            if (dot < minCos) return false
        }
    }
    return true
}

/**
 * (iii-c): per-cell-edge single-crossing check for one stratum, applied to
 * SIGN-CHANGE edges only: the directional derivative along the edge must not
 * change sign between the endpoints (else the carrier may cross 3×).
 *
 * Deliberately NOT checked: same-sign edges. The Lipschitz midpoint test
 * (|f(mid)| > len/2 certifies no hidden double crossing) is only an absence
 * certificate — it stays inconclusive forever for edges running parallel to
 * the surface at distance < len/2, which exist in every surface cell, so
 * using its failure as a split criterion refines the whole shell to depthMax
 * (measured: ~126k degenerate cells on a plain sphere). A hidden even
 * crossing on a same-sign edge produces a consistent closed mesh with a
 * local deviation bounded by the edge sagitta (O(len²·κ)) — accepted in v1,
 * like every grid contouring method.
 */
export function stratumEdgeCrossingsOk(stratum: SfccStratum, probe: RefineProbe): boolean {
    const g = new Float64Array(3)
    for (let e = 0; e < 12; e++) {
        const [ca, cb] = CELL_EDGES[e]!
        const ax = probe.pts[ca * 3]!
        const ay = probe.pts[ca * 3 + 1]!
        const az = probe.pts[ca * 3 + 2]!
        const bx = probe.pts[cb * 3]!
        const by = probe.pts[cb * 3 + 1]!
        const bz = probe.pts[cb * 3 + 2]!
        const fa = stratum.f(ax, ay, az)
        const fb = stratum.f(bx, by, bz)
        if (fa < 0 === fb < 0) continue
        const len = probe.cellSize
        const ex = (bx - ax) / len
        const ey = (by - ay) / len
        const ez = (bz - az) / len
        stratum.normal(ax, ay, az, g)
        const da = g[0]! * ex + g[1]! * ey + g[2]! * ez
        stratum.normal(bx, by, bz, g)
        const db = g[0]! * ex + g[1]! * ey + g[2]! * ez
        if (da * db <= 0) return false
    }
    return true
}

export interface SmoothCriteriaOptions {
    normalVariationCos: number
}

/** Combined P3 criteria: returns true when the cell needs splitting. */
export function needsSplitSmooth(tree: CpuSdfTree, probe: RefineProbe, opts: SmoothCriteriaOptions): boolean {
    if (!hasCornerSignChange(probe)) return false // inactive cell — see (iii-a) note above
    for (const st of activeStrata(tree, probe)) {
        if (!stratumNormalVariationOk(st, probe, opts.normalVariationCos)) return true
        if (!stratumEdgeCrossingsOk(st, probe)) return true
    }
    return false
}

// ---------------------------------------------------------------------------
// Feature criteria (i)/(ii) — design doc §3.2 S2
// ---------------------------------------------------------------------------

export interface FeatureCriteriaOptions {
    /** Cell AABB inflation, in fractions of the cell size, for index queries. */
    featureQueryInflate: number
    /** |tangent·faceNormal| below this counts as tangential → split. */
    tangentialEpsilon: number
}

export interface FeatureCellClass {
    split: boolean
    /** Curve passing through the cell (−1 = none). Valid when !split. */
    curve: number
    /** Corner inside the cell (−1 = none). Handled from P5. */
    corner: number
}

/**
 * Classify a cell against the feature set:
 * - (i) at most one curve passes through (entry/exit = exactly 2 boundary
 *   crossings); corners → split until P5's corner cells land;
 * - (ii) each curve crosses each face at most once, transversally; an in-cell
 *   curve portion with no boundary crossings (contained loop / endpoint
 *   inside) splits.
 */
export function classifyCellFeatures(
    features: SfccFeatureSet,
    lat: SfccLattice,
    level: number,
    ix: number,
    iy: number,
    iz: number,
    opts: FeatureCriteriaOptions,
): FeatureCellClass {
    const box = new Float64Array(6)
    cellAabb(lat, level, ix, iy, iz, box)
    const size = cellSizeAtLevel(lat, level)
    const inflate = opts.featureQueryInflate * size
    const b0 = box[0]! - inflate
    const b1 = box[1]! - inflate
    const b2 = box[2]! - inflate
    const b3 = box[3]! + inflate
    const b4 = box[4]! + inflate
    const b5 = box[5]! + inflate

    // Corner clause of (i): a cell containing exactly ONE corner passes iff
    // every feature curve touching the cell is incident to that corner; the
    // corner cell is then meshed as wedge fans around the exact corner point.
    let cornerInCell = -1
    for (const cid of features.index.cornersInBox(b0, b1, b2, b3, b4, b5)) {
        const c = features.corners[cid]!
        if (
            c.x >= box[0]! &&
            c.x <= box[3]! &&
            c.y >= box[1]! &&
            c.y <= box[4]! &&
            c.z >= box[2]! &&
            c.z <= box[5]!
        ) {
            if (cornerInCell >= 0) return { split: true, curve: -1, corner: cid } // two corners
            cornerInCell = cid
        }
    }
    const cornerCurves =
        cornerInCell >= 0 ? new Set(features.corners[cornerInCell]!.curveEnds.map(e => e.curveId)) : null

    let throughCurve = -1
    for (const curveId of features.index.curvesInBox(b0, b1, b2, b3, b4, b5)) {
        const curve = features.curves[curveId]!
        let total = 0
        const crossingFaces: Array<[0 | 1 | 2, number]> = []
        for (let axis = 0 as 0 | 1 | 2; axis < 3; axis = (axis + 1) as 0 | 1 | 2) {
            for (let side = 0; side <= 1; side++) {
                const coord = box[axis + (side === 1 ? 3 : 0)]!
                let perFace = 0
                for (const cr of curve.axisPlaneCrossings(axis, coord)) {
                    // In-rect test on the other two axes (closed interval).
                    const px = [cr.x, cr.y, cr.z]
                    let inside = true
                    for (let a = 0; a < 3; a++) {
                        if (a === axis) continue
                        if (px[a]! < box[a]! || px[a]! > box[a + 3]!) {
                            inside = false
                            break
                        }
                    }
                    if (!inside) continue
                    perFace++
                    if (cr.tangentialDot < opts.tangentialEpsilon) {
                        return { split: true, curve: curveId, corner: -1 } // tangential crossing
                    }
                }
                if (perFace > 1) return { split: true, curve: curveId, corner: -1 } // (ii)
                if (perFace === 1) crossingFaces.push([axis, coord])
                total += perFace
            }
        }
        // Pin-visibility certificate: on a pinned face, the surface arc through
        // the pin must reach the face boundary on BOTH stratum sides — i.e.
        // each adjacent stratum's carrier changes sign over the face corners.
        // Otherwise the arc enters and exits through one boundary sub-edge
        // (an invisible even crossing) and the pin cannot be routed: split,
        // generic tangencies resolve at finer levels.
        if (total === 2) {
            for (const [axis, coord] of crossingFaces) {
                for (const sid of curve.adjacentStrata) {
                    const st = features.strata[sid]!
                    let neg = false
                    let pos = false
                    const pt: [number, number, number] = [0, 0, 0]
                    pt[axis] = coord
                    const [u, v] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1]
                    for (let cu = 0; cu <= 1; cu++) {
                        for (let cv = 0; cv <= 1; cv++) {
                            pt[u as 0 | 1 | 2] = box[(u as number) + cu * 3]!
                            pt[v as 0 | 1 | 2] = box[(v as number) + cv * 3]!
                            if (st.f(pt[0]!, pt[1]!, pt[2]!) < 0) neg = true
                            else pos = true
                        }
                    }
                    if (!neg || !pos) return { split: true, curve: curveId, corner: -1 }
                }
            }
        }
        if (total === 0) {
            // No boundary crossings — is any part of the curve inside the cell?
            const cx = (box[0]! + box[3]!) / 2
            const cy = (box[1]! + box[4]!) / 2
            const cz = (box[2]! + box[5]!) / 2
            const pr = curve.project(cx, cy, cz)
            const q = new Float64Array(3)
            curve.pointAt(pr.t, q)
            const insideCell =
                q[0]! >= box[0]! &&
                q[0]! <= box[3]! &&
                q[1]! >= box[1]! &&
                q[1]! <= box[4]! &&
                q[2]! >= box[2]! &&
                q[2]! <= box[5]!
            if (insideCell) return { split: true, curve: curveId, corner: -1 } // contained loop/segment
            continue // index false positive — curve does not touch the cell
        }
        if (cornerCurves) {
            // Corner cell: every touching curve must be one of the corner's
            // incident curves, entering once (its other end is the corner).
            if (!cornerCurves.has(curveId) || total !== 1) {
                return { split: true, curve: curveId, corner: cornerInCell }
            }
            continue
        }
        if (total !== 2) return { split: true, curve: curveId, corner: -1 } // endpoint inside, or multi-entry
        if (throughCurve >= 0) return { split: true, curve: curveId, corner: -1 } // (i): two curves
        throughCurve = curveId
    }
    if (cornerInCell >= 0) return { split: false, curve: -1, corner: cornerInCell }
    return { split: false, curve: throughCurve, corner: -1 }
}
