/**
 * S3b — per-cell meshing: assemble each leaf's boundary face segments into
 * closed loops and triangulate each loop as a disk.
 *
 * Consumption rule (matches the face-contour orientation convention): the
 * cell on the +axis side of a face (the face is the cell's MIN-axis side)
 * consumes segments as stored; the −axis-side cell reverses them. Loops then
 * come out CCW viewed from outside the solid (outward triangle winding —
 * pinned by the pipeline test), and every interior face segment is consumed
 * exactly twice in opposite directions — counted into FaceRecord for the S4
 * audit.
 *
 * Smooth-cell triangulation: 3-loops emit directly; 4-loops split along the
 * shorter diagonal; larger loops fan from an interior vertex Newton-projected
 * onto the surface (fallback: unprojected centroid). Triangle winding is
 * outward (normal toward f > 0): loops as assembled here are CCW viewed from
 * OUTSIDE the solid.
 */

import type { CpuSdfTree } from "./cpu-sdf.mjs"
import type { SfccFeatureSet } from "./feature-set.mjs"
import { cellAabb, faceAxes, packPoint, strideAtLevel, unpackPoint } from "./lattice.mjs"
import type { SfccOctree, SfccCell } from "./octree.mjs"
import type { FacePin, FaceRecord } from "./face-contour.mjs"
import type { PointTable } from "./point-table.mjs"

export interface CellMeshOptions {
    surfaceTol: number
    interiorVertexMode: "project" | "centroid" | "fan"
    projectMaxIters: number
    /** Max chord deviation (mm) of in-cell feature polylines. */
    curveChordTol: number
    maxPolylinePointsPerCell: number
    features?: SfccFeatureSet
}

export interface CellMeshResult {
    tris: number[]
    /** Cells whose segment soup did not assemble into closed loops. */
    failedCells: SfccCell[]
    /** Cells that produced 2+ loops (legal, but certificate-noteworthy). */
    multiLoopCells: number
    /** Cells meshed with an explicit feature-edge split. */
    edgeCells: number
    /** Cells meshed as wedge fans around an exact corner point. */
    cornerCells: number
    /** Feature cells that fell back to smooth meshing (kept closed; reported). */
    featureCellFallbacks: number
    /** The fallback cells themselves — candidates for forced re-refinement. */
    fallbackCells: SfccCell[]
}

/**
 * Gather the cell's boundary segments. Each side is either one face at the
 * cell's own level, or — when the neighbor is one level finer (2:1 balance)
 * — up to four quarter faces at level+1, consumed CMS-style: segments
 * reference global point ids, so the coarse cell just unions them.
 */
function gatherSegments(
    oct: SfccOctree,
    faces: Array<Map<number, FaceRecord>>,
    cell: SfccCell,
    out: Array<{ a: number; b: number; face: FaceRecord; idx: number; reversed: boolean }>,
    pinsOut: FacePin[],
): void {
    const lat = oct.lat
    const stride = strideAtLevel(lat, cell.level)
    const base: [number, number, number] = [cell.ix * stride, cell.iy * stride, cell.iz * stride]
    for (let axis = 0 as 0 | 1 | 2; axis < 3; axis = (axis + 1) as 0 | 1 | 2) {
        const [u, v] = faceAxes(axis)
        for (let side = 0; side <= 1; side++) {
            const g: [number, number, number] = [base[0]!, base[1]!, base[2]!]
            if (side === 1) g[axis] = g[axis]! + stride
            // side === 0: face is the cell's min-axis side ⇒ cell is on the
            // face's +axis side ⇒ consume as stored. side === 1: reversed.
            const reversed = side === 1
            // Face keys are min-corner lattice points, which COLLIDE across
            // levels (a face and its own min-corner quarter share the key), so
            // every lookup must validate the record's size.
            const rec = faces[axis]!.get(packPoint(lat, g[0]!, g[1]!, g[2]!))
            if (rec && rec.len === stride) {
                pushSegments(rec, reversed, out)
                pinsOut.push(...rec.pins)
                continue
            }
            // Neighbor is finer: consume the quarter faces (absent quarters
            // border certified-empty regions and carry no segments).
            const half = stride / 2
            if (half < 1) continue
            for (let a = 0; a <= 1; a++) {
                for (let b = 0; b <= 1; b++) {
                    const q: [number, number, number] = [g[0]!, g[1]!, g[2]!]
                    q[u] = q[u]! + a * half
                    q[v] = q[v]! + b * half
                    const qrec = faces[axis]!.get(packPoint(lat, q[0]!, q[1]!, q[2]!))
                    if (qrec && qrec.len === half) {
                        pushSegments(qrec, reversed, out)
                        pinsOut.push(...qrec.pins)
                    }
                }
            }
        }
    }
}

function pushSegments(
    rec: FaceRecord,
    reversed: boolean,
    out: Array<{ a: number; b: number; face: FaceRecord; idx: number; reversed: boolean }>,
): void {
    for (let i = 0; i < rec.segments.length; i++) {
        const s = rec.segments[i]!
        out.push(
            reversed
                ? { a: s.b, b: s.a, face: rec, idx: i, reversed: true }
                : { a: s.a, b: s.b, face: rec, idx: i, reversed: false },
        )
    }
}

export function meshAllCells(
    oct: SfccOctree,
    faces: Array<Map<number, FaceRecord>>,
    tree: CpuSdfTree,
    points: PointTable,
    opts: CellMeshOptions,
    signal?: AbortSignal,
): CellMeshResult {
    const tris: number[] = []
    const failedCells: SfccCell[] = []
    let multiLoopCells = 0
    let edgeCells = 0
    let cornerCells = 0
    let featureCellFallbacks = 0
    const fallbackCells: SfccCell[] = []

    const segs: Array<{ a: number; b: number; face: FaceRecord; idx: number; reversed: boolean }> = []
    const pins: FacePin[] = []
    const box = new Float64Array(6)
    const g = new Float64Array(3)

    let counter = 0
    for (const cell of oct.leaves) {
        if ((counter++ & 0xff) === 0 && signal?.aborted) throw new Error("sfcc: aborted")
        segs.length = 0
        pins.length = 0
        gatherSegments(oct, faces, cell, segs, pins)
        if (segs.length === 0) continue

        // Loop walk: every point must have exactly one outgoing segment.
        const outgoing = new Map<number, number>() // from-point → seg index
        let degenerate = false
        for (let i = 0; i < segs.length; i++) {
            const s = segs[i]!
            if (outgoing.has(s.a)) {
                degenerate = true
                break
            }
            outgoing.set(s.a, i)
        }
        if (degenerate) {
            failedCells.push(cell)
            continue
        }

        const visited = new Uint8Array(segs.length)
        const loops: number[][] = []
        let broken = false
        for (let start = 0; start < segs.length; start++) {
            if (visited[start]) continue
            const loop: number[] = []
            let cur = start
            let guard = 0
            for (;;) {
                if (visited[cur]) {
                    broken = true // re-entered a consumed segment mid-walk
                    break
                }
                visited[cur] = 1
                const s = segs[cur]!
                loop.push(s.a)
                const next = outgoing.get(s.b)
                if (next === undefined) {
                    broken = true // dangling endpoint
                    break
                }
                if (next === start) break // closed
                cur = next
                if (++guard > segs.length) {
                    broken = true
                    break
                }
            }
            if (broken) break
            loops.push(loop)
        }
        if (broken || loops.length === 0) {
            failedCells.push(cell)
            continue
        }
        if (loops.length > 1) multiLoopCells++

        // Loops are valid — record consumption for the S4 face audit.
        for (const s of segs) {
            if (s.reversed) s.face.consumedRev[s.idx]!++
            else s.face.consumedFwd[s.idx]!++
        }

        cellAabb(oct.lat, cell.level, cell.ix, cell.iy, cell.iz, box)

        const meshedLoops = new Set<number>()

        if (cell.featureCorner >= 0 && opts.features) {
            // Corner cells: every loop touching an incident-curve pin is fanned
            // from the EXACT corner point — arbitrary valence, no classification
            // step exists to fail. (A valence-0 corner — the cone apex — fans
            // every loop.)
            const corner = opts.features.corners[cell.featureCorner]!
            const incident = new Set(corner.curveEnds.map(e => e.curveId))
            let fanned = 0
            for (let li = 0; li < loops.length; li++) {
                const loop = loops[li]!
                const hasPin =
                    incident.size === 0 || pins.some(p => incident.has(p.curveId) && loop.includes(p.pointId))
                if (!hasPin) continue
                const cid = cornerPointId(corner, opts.features, points)
                for (let k = 0; k < loop.length; k++) {
                    tris.push(cid, loop[k]!, loop[(k + 1) % loop.length]!)
                }
                meshedLoops.add(li)
                fanned++
            }
            if (fanned > 0) cornerCells++
            else {
                featureCellFallbacks++
                fallbackCells.push(cell)
            }
        } else if (cell.featureCurve >= 0 && opts.features) {
            // Edge cells: split the loop containing the two pinned feature
            // points and mesh each stratum side against the sampled analytic
            // curve. Other loops (disjoint sheets) mesh as disks below.
            const myPins: FacePin[] = []
            for (const p of pins) {
                if (p.curveId === cell.featureCurve && !myPins.some(q => q.pointId === p.pointId)) myPins.push(p)
            }
            if (myPins.length === 2) {
                const idx = loops.findIndex(
                    L => L.includes(myPins[0]!.pointId) && L.includes(myPins[1]!.pointId),
                )
                if (
                    idx >= 0 &&
                    meshEdgeCell(loops[idx]!, myPins[0]!, myPins[1]!, cell, box, tree, points, opts, tris)
                ) {
                    meshedLoops.add(idx)
                }
            }
            if (meshedLoops.size > 0) edgeCells++
            else {
                featureCellFallbacks++
                fallbackCells.push(cell)
            }
        }

        for (let li = 0; li < loops.length; li++) {
            if (meshedLoops.has(li)) continue
            triangulateLoop(loops[li]!, tree, points, box, opts, tris)
        }
    }

    return { tris, failedCells, multiLoopCells, edgeCells, cornerCells, featureCellFallbacks, fallbackCells }

    function triangulateLoop(
        loop: number[],
        tree2: CpuSdfTree,
        pts: PointTable,
        cellBox: Float64Array,
        o: CellMeshOptions,
        outTris: number[],
    ): void {
        const m = loop.length
        if (m < 3) return
        if (m === 3) {
            outTris.push(loop[0]!, loop[1]!, loop[2]!)
            return
        }
        if (m === 4) {
            const d02 = dist2(pts, loop[0]!, loop[2]!)
            const d13 = dist2(pts, loop[1]!, loop[3]!)
            if (d02 <= d13) {
                outTris.push(loop[0]!, loop[1]!, loop[2]!, loop[0]!, loop[2]!, loop[3]!)
            } else {
                outTris.push(loop[1]!, loop[2]!, loop[3]!, loop[1]!, loop[3]!, loop[0]!)
            }
            return
        }
        if (o.interiorVertexMode === "fan") {
            const k = bestFanApex(pts, loop)
            for (let i = 1; i < m - 1; i++) {
                outTris.push(loop[k]!, loop[(k + i) % m]!, loop[(k + i + 1) % m]!)
            }
            return
        }
        // Interior vertex: loop average, optionally Newton-projected onto the surface.
        let cx = 0
        let cy = 0
        let cz = 0
        for (const id of loop) {
            cx += pts.x(id)
            cy += pts.y(id)
            cz += pts.z(id)
        }
        cx /= m
        cy /= m
        cz /= m
        let px = cx
        let py = cy
        let pz = cz
        if (o.interiorVertexMode === "project") {
            const margin = (cellBox[3]! - cellBox[0]!) * 0.1
            for (let it = 0; it < o.projectMaxIters; it++) {
                const fv = tree2.f(px, py, pz)
                if (Math.abs(fv) <= o.surfaceTol * 0.25) break
                tree2.grad(px, py, pz, g)
                const g2 = g[0]! * g[0]! + g[1]! * g[1]! + g[2]! * g[2]!
                if (g2 < 1e-20) break
                const k = fv / g2
                px -= k * g[0]!
                py -= k * g[1]!
                pz -= k * g[2]!
                if (
                    px < cellBox[0]! - margin ||
                    px > cellBox[3]! + margin ||
                    py < cellBox[1]! - margin ||
                    py > cellBox[4]! + margin ||
                    pz < cellBox[2]! - margin ||
                    pz > cellBox[5]! + margin
                ) {
                    break
                }
            }
            // Accept only a vertex that (1) reached the surface, (2) stayed in
            // the cell — Newton from a centroid inside a thin slab can walk
            // straight through it and converge on the slab's FAR side, which
            // is genuine surface (passes the |f| check) but fans a multi-cell
            // pit through the material — and (3) lies on the SAME sheet as
            // the loop: gradient roughly along the loop's average normal (the
            // far side of a slab faces the opposite way, dot ≈ −1).
            let sameSheet = true
            if (Math.abs(tree2.f(px, py, pz)) <= o.surfaceTol && inBox(cellBox, px, py, pz, margin)) {
                let ax = 0
                let ay = 0
                let az = 0
                for (const id of loop) {
                    ax += pts.nx(id)
                    ay += pts.ny(id)
                    az += pts.nz(id)
                }
                tree2.grad(px, py, pz, g)
                sameSheet = ax * g[0]! + ay * g[1]! + az * g[2]! > 0
            }
            if (
                Math.abs(tree2.f(px, py, pz)) > o.surfaceTol ||
                !inBox(cellBox, px, py, pz, margin) ||
                !sameSheet
            ) {
                // Projection failed to reach the surface (concave pockets,
                // escaped cells, far-side landings): fan from the loop vertex
                // with the best worst-ear quality — every loop vertex IS on
                // the surface, so the max-|f| guarantee holds.
                const k = bestFanApex(pts, loop)
                for (let i = 1; i < m - 1; i++) {
                    outTris.push(loop[k]!, loop[(k + i) % m]!, loop[(k + i + 1) % m]!)
                }
                return
            }
        }
        tree2.grad(px, py, pz, g)
        const c = pts.add(px, py, pz, g[0]!, g[1]!, g[2]!)
        for (let i = 0; i < m; i++) {
            outTris.push(c, loop[i]!, loop[(i + 1) % m]!)
        }
    }
}

/**
 * Fan apex choice: the loop vertex maximizing the worst ear quality
 * (2·area/lmax² of each fan triangle). A fan from an arbitrary vertex mints
 * near-degenerate ears whenever the loop contains collinear runs (multiple
 * crossings along one face line) and the apex sits on the run — the source of
 * micron-high, half-millimetre-long sliver chains in lattice face planes.
 */
function bestFanApex(pts: PointTable, loop: number[]): number {
    const m = loop.length
    const quality = (a: number, b: number, c: number): number => {
        const ax = pts.x(a), ay = pts.y(a), az = pts.z(a)
        const ux = pts.x(b) - ax, uy = pts.y(b) - ay, uz = pts.z(b) - az
        const vx = pts.x(c) - ax, vy = pts.y(c) - ay, vz = pts.z(c) - az
        const area2 = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
        const e0 = Math.hypot(ux, uy, uz)
        const e1 = Math.hypot(vx, vy, vz)
        const e2 = Math.hypot(pts.x(c) - pts.x(b), pts.y(c) - pts.y(b), pts.z(c) - pts.z(b))
        const lmax = Math.max(e0, e1, e2)
        return lmax > 1e-20 ? area2 / (lmax * lmax) : 0
    }
    let bestK = 0
    let bestQ = -1
    for (let k = 0; k < m; k++) {
        let worst = Infinity
        for (let i = 1; i < m - 1 && worst > bestQ; i++) {
            const q = quality(loop[k]!, loop[(k + i) % m]!, loop[(k + i + 1) % m]!)
            if (q < worst) worst = q
        }
        if (worst > bestQ) {
            bestQ = worst
            bestK = k
        }
    }
    return bestK
}

function dist2(pts: PointTable, a: number, b: number): number {
    const dx = pts.x(a) - pts.x(b)
    const dy = pts.y(a) - pts.y(b)
    const dz = pts.z(a) - pts.z(b)
    return dx * dx + dy * dy + dz * dz
}

/** Shared, exact corner mesh vertex (keyed; averaged incident-strata normal). */
function cornerPointId(
    corner: SfccFeatureSet["corners"][number],
    features: SfccFeatureSet,
    points: PointTable,
): number {
    return points.getOrCreateStr(`corner:${corner.id}`, out => {
        out[0] = corner.x
        out[1] = corner.y
        out[2] = corner.z
        const n = new Float64Array(3)
        let nx = 0
        let ny = 0
        let nz = 0
        for (const sid of corner.strata) {
            features.strata[sid]!.normal(corner.x, corner.y, corner.z, n)
            nx += n[0]!
            ny += n[1]!
            nz += n[2]!
        }
        const nl = Math.hypot(nx, ny, nz)
        if (nl > 1e-12) {
            out[3] = nx / nl
            out[4] = ny / nl
            out[5] = nz / nl
        } else {
            out[3] = 0
            out[4] = 1
            out[5] = 0
        }
    })
}

function inBox(box: Float64Array, x: number, y: number, z: number, margin: number): boolean {
    return (
        x >= box[0]! - margin &&
        x <= box[3]! + margin &&
        y >= box[1]! - margin &&
        y <= box[4]! + margin &&
        z >= box[2]! - margin &&
        z <= box[5]! + margin
    )
}

/**
 * Mesh an edge cell: the loop contains the curve's two pinned face crossings;
 * split it there into the two stratum chains, sample the analytic curve
 * between the pins (every sample exactly on the locus), and fan each side
 * from an interior vertex projected onto that side's smooth carrier. The two
 * sides consume the feature polyline in opposite directions, so feature edges
 * satisfy the same two-use audit as everything else.
 */
function meshEdgeCell(
    loop: number[],
    pinA: FacePin,
    pinB: FacePin,
    cell: SfccCell,
    cellBox: Float64Array,
    tree: CpuSdfTree,
    points: PointTable,
    opts: CellMeshOptions,
    outTris: number[],
): boolean {
    const features = opts.features!
    const curve = features.curves[cell.featureCurve]!
    const i = loop.indexOf(pinA.pointId)
    const j = loop.indexOf(pinB.pointId)
    if (i < 0 || j < 0 || i === j) return false
    const m = loop.length

    // Chains inclusive of both pins, following loop order.
    const chain1: number[] = []
    for (let k = i; ; k = (k + 1) % m) {
        chain1.push(loop[k]!)
        if (k === j) break
    }
    const chain2: number[] = []
    for (let k = j; ; k = (k + 1) % m) {
        chain2.push(loop[k]!)
        if (k === i) break
    }
    if (chain1.length < 3 || chain2.length < 3) return false

    // Sample the in-cell arc from pinA.t to pinB.t (interior points only).
    const interior = sampleInCellArc(curve, pinA.t, pinB.t, cellBox, points, features, opts)
    if (interior === null) return false

    // side1 = chain1 (A→…→B) closed by the polyline B→A (reversed interior);
    // side2 = chain2 (B→…→A) closed by the polyline A→B.
    const side1 = [...chain1]
    for (let k = interior.length - 1; k >= 0; k--) side1.push(interior[k]!)
    const side2 = [...chain2]
    for (let k = 0; k < interior.length; k++) side2.push(interior[k]!)

    // Assign strata to sides by aggregate NORMAL-AGREEMENT margin over ALL
    // non-pin chain vertices: |dot(vertex normal, carrier normal)| is ≈1 on a
    // vertex's own flank and ≤|cos dihedral| on the other. Carrier DISTANCE is
    // the wrong discriminator under heavy twist — wrapped virtual branches of
    // the other carrier pass arbitrarily close to a flank (measured: |sB.f| <
    // |sA.f| at vertices ON flank A), and per-chain representatives tie at
    // the crease. There are exactly two possible assignments; score both and
    // take the better — never reject (the chop was the residual chip source,
    // and a mis-pick is caught by fanFromStratumVertex's guards).
    const sA = features.strata[curve.adjacentStrata[0]!]!
    const sB = features.strata[curve.adjacentStrata[1]!]!
    const n = new Float64Array(3)
    const agree = (v: number, st: typeof sA): number => {
        const x = points.x(v)
        const y = points.y(v)
        const z = points.z(v)
        st.normal(x, y, z, n)
        const vx = points.nx(v)
        const vy = points.ny(v)
        const vz = points.nz(v)
        const vl = Math.hypot(vx, vy, vz)
        if (vl < 1e-12) return 0
        return Math.abs((vx * n[0]! + vy * n[1]! + vz * n[2]!) / vl)
    }
    let score = 0
    for (let idx = 1; idx < chain1.length - 1; idx++) {
        const v = chain1[idx]!
        score += agree(v, sA) - agree(v, sB)
    }
    for (let idx = 1; idx < chain2.length - 1; idx++) {
        const v = chain2[idx]!
        score += agree(v, sB) - agree(v, sA)
    }
    const side1IsA = score >= 0
    const side2IsA = !side1IsA

    fanFromStratumVertex(side1, side1IsA ? sA : sB, cellBox, tree, points, opts, outTris)
    fanFromStratumVertex(side2, side2IsA ? sA : sB, cellBox, tree, points, opts, outTris)
    return true
}

/**
 * Interior polyline points along the curve between two parameters, choosing
 * the in-cell arc for closed curves. Returns point ids (exactly on the
 * analytic curve), or null when no arc stays in the cell.
 */
function sampleInCellArc(
    curve: SfccFeatureSet["curves"][number],
    tA: number,
    tB: number,
    cellBox: Float64Array,
    points: PointTable,
    features: SfccFeatureSet,
    opts: CellMeshOptions,
): number[] | null {
    const margin = (cellBox[3]! - cellBox[0]!) * 0.25
    const p = new Float64Array(3)
    let delta: number
    if (curve.closed && curve.paramWrap !== undefined) {
        const wrap = curve.paramWrap
        const fwd = ((tB - tA) % wrap + wrap) % wrap
        const candidates = [fwd, fwd - wrap] // the two arcs between the pins
        let chosen: number | null = null
        for (const d of candidates) {
            curve.pointAt(tA + d / 2, p)
            if (inBox(cellBox, p[0]!, p[1]!, p[2]!, margin)) {
                if (chosen === null || Math.abs(d) < Math.abs(chosen)) chosen = d
            }
        }
        if (chosen === null) return null
        delta = chosen
    } else {
        delta = tB - tA
    }
    const arcLen = curve.paramDistance(tA, tA + delta) || Math.abs(delta)
    // Interior-point count from the chord tolerance (straight segments: none).
    let n = 1
    if (curve.kind === "circle") {
        // chord error of arc dθ at radius r: r(1 − cos(dθ/2)) ≤ tol
        const r = arcLen / Math.abs(delta || 1)
        const maxStep = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - opts.curveChordTol / Math.max(r, 1e-9))))
        n = Math.max(1, Math.ceil(Math.abs(delta) / Math.max(maxStep, 1e-6)))
        n = Math.min(n, opts.maxPolylinePointsPerCell)
    } else if (curve.kind === "traced") {
        // Tracer polylines are already chord-tolerance spaced: one interior
        // point per integer param strictly between the pins, capped.
        n = Math.max(1, Math.min(Math.ceil(Math.abs(delta)), opts.maxPolylinePointsPerCell))
    }
    const sA = features.strata[curve.adjacentStrata[0]!]!
    const sB = features.strata[curve.adjacentStrata[1]!]!
    const na = new Float64Array(3)
    const nb = new Float64Array(3)
    const ids: number[] = []
    for (let k = 1; k < n; k++) {
        const t = tA + (delta * k) / n
        curve.pointAt(t, p)
        sA.normal(p[0]!, p[1]!, p[2]!, na)
        sB.normal(p[0]!, p[1]!, p[2]!, nb)
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
        ids.push(points.add(p[0]!, p[1]!, p[2]!, nx, ny, nz))
    }
    return ids
}

/** Fan a disk from an interior vertex projected onto the side's smooth carrier. */
function fanFromStratumVertex(
    boundary: number[],
    stratum: SfccFeatureSet["strata"][number],
    cellBox: Float64Array,
    tree: CpuSdfTree,
    points: PointTable,
    opts: CellMeshOptions,
    outTris: number[],
): void {
    const m = boundary.length
    let cx = 0
    let cy = 0
    let cz = 0
    for (const id of boundary) {
        cx += points.x(id)
        cy += points.y(id)
        cz += points.z(id)
    }
    cx /= m
    cy /= m
    cz /= m
    const proj = new Float64Array(3)
    stratum.project(cx, cy, cz, proj)
    const margin = (cellBox[3]! - cellBox[0]!) * 0.1
    const px = proj[0]!
    const py = proj[1]!
    const pz = proj[2]!
    // Guards: the projection must stay in the cell, land on the actual
    // surface, AND land on the carrier's OWN patch of it — under heavy twist
    // a wrapped virtual branch of the carrier can coincide with a different
    // real wall (|tree.f| ≈ 0 there too), and fanning from that point digs a
    // pit straight through the wedge. On the right patch the carrier normal
    // and the tree gradient are parallel up to branch orientation (|dot| ≈ 1).
    const n = new Float64Array(3)
    const g = new Float64Array(3)
    let wrongPatch = false
    if (inBox(cellBox, px, py, pz, margin)) {
        stratum.normal(px, py, pz, n)
        tree.grad(px, py, pz, g)
        const gl = Math.hypot(g[0]!, g[1]!, g[2]!)
        wrongPatch = gl > 1e-12 && Math.abs(g[0]! * n[0]! + g[1]! * n[1]! + g[2]! * n[2]!) / gl < 0.8
    }
    if (!inBox(cellBox, px, py, pz, margin) || wrongPatch || Math.abs(tree.f(px, py, pz)) > opts.surfaceTol) {
        // The carrier projection left the cell or the actual surface: fan from
        // the best-quality boundary vertex instead — boundary vertices are on
        // the surface, so the max-|f| guarantee holds.
        const kb = bestFanApex(points, boundary)
        for (let k = 1; k < m - 1; k++) {
            outTris.push(boundary[kb]!, boundary[(kb + k) % m]!, boundary[(kb + k + 1) % m]!)
        }
        return
    }
    stratum.normal(px, py, pz, n)
    const c = points.add(px, py, pz, n[0]!, n[1]!, n[2]!)
    for (let k = 0; k < m; k++) {
        outTris.push(c, boundary[k]!, boundary[(k + 1) % m]!)
    }
}
