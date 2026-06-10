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
    const scratch = new Float64Array(6)
    const wa = new Float64Array(3)
    const wb = new Float64Array(3)

    for (const walk of walks) {
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
            if (f0 < 0 !== f1 < 0) {
                // Canonical sub-edge key: min corner along the edge axis.
                const minCorner = walk.dir === 1 ? p0 : p1
                const subKey = crossingKey(packPoint(lat, minCorner[0]!, minCorner[1]!, minCorner[2]!), walk.ax)
                const id = points.getOrCreate(subKey, out => {
                    pointToWorld(lat, p0[0]!, p0[1]!, p0[2]!, wa)
                    pointToWorld(lat, p1[0]!, p1[1]!, p1[2]!, wb)
                    findRoot(tree, wa[0]!, wa[1]!, wa[2]!, wb[0]!, wb[1]!, wb[2]!, f0, f1, opts.rootTol, scratch)
                    out.set(scratch)
                })
                nodes.push({ crossing: id, inside: false })
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
    for (let i = 0; i < n; i++) {
        const c = crossings[i]!
        if (c.enter) continue // segments start at exits
        let partner = -1
        if (runs < 2 || !centerInside) {
            // Enter of this exit's own run = nearest enter BEFORE it (cyclic).
            for (let k = 1; k <= n; k++) {
                const cand = crossings[(i - k + n) % n]!
                if (cand.enter) {
                    partner = cand.id
                    break
                }
            }
        } else {
            // Center inside: connect across the face to the NEXT enter (cyclic).
            for (let k = 1; k <= n; k++) {
                const cand = crossings[(i + k) % n]!
                if (cand.enter) {
                    partner = cand.id
                    break
                }
            }
        }
        record.segments.push({ a: c.id, b: partner })
        record.consumedFwd.push(0)
        record.consumedRev.push(0)
    }
    return record
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
    return { faces, multiRunFaces, boundaryViolations, keyCollisions }
}
