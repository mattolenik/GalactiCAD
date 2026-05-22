/**
 * FeatureGraph → per-cell QEF Hermite plane injection (Phase IS-3/IS-4 of the
 * iso-simplicial × FG plan).
 *
 * The iso-simplicial exporter solves a QEF per octree cell (one cube QEF, 12
 * edge QEFs, 6 face QEFs) to place that cell's dual vertices. These functions
 * add extra Hermite planes derived from the survival-aware FeatureGraph so the
 * dual vertices are pulled toward explicit primitive features (Box corners,
 * crease dihedrals, …) rather than approximated from SDF gradients alone.
 *
 * The planes are *soft* constraints — each is just another equation in the QEF
 * normal system; they compose additively with the GPU mid-feature planes the
 * `featurePlaneEnabled` path injects.
 *
 * Two-step API:
 *  1. {@link collectFgPlaneSources} — once per cell: gate the cell's queried
 *     `FgCellFeatures`, dedup subdivided crease segments, and convert geometry
 *     into a small list of {@link FgPlaneSource} (point + unit normals, in the
 *     normalized cell frame).
 *  2. {@link injectCubeFgFeaturePlanes} / {@link injectEdgeFgFeaturePlanes} /
 *     {@link injectFaceFgFeaturePlanes} — feed those sources into the cube /
 *     edge / face QEF respectively.
 *
 * Pure module — no octree / scene imports — so it runs unchanged on the main
 * thread and inside the QEF worker.
 *
 * Coordinate frames
 * -----------------
 * The QEFs work in the root AABB's normalized `[0,1]³` frame. FG geometry
 * (`FgCellFeatures`) is world-space. Conversion: `pn = (p - rootMin) /
 * worldScale`. The root AABB is a cube, so the world→normalized map is a
 * uniform scale and unit normals stay unit (direction unchanged).
 */

import type { FgCellFeatures } from "../../feature-graph/feature-graph-cell-query.mjs"
import { FG_CELL_NORMAL_BLOCK } from "../../feature-graph/feature-graph-cell-query.mjs"
import { encodeEdgeFeaturePlane, encodeFaceFeaturePlane, encodeFeaturePlane } from "./dual-vertex-qef.mjs"
import { qefAccumulatePlane } from "./qef-normal.mjs"

/** World↔normalized conversion + distance-gate factor for FG plane injection. */
export interface FgPlaneInjectionContext {
    /** Root AABB origin (world). */
    rootMinX: number
    rootMinY: number
    rootMinZ: number
    /** Root AABB edge length (world units). `normalized = (world - rootMin) / worldScale`. */
    worldScale: number
    /**
     * Distance gate: skip an FG feature whose world-space distance to the cell
     * AABB exceeds `distFactor * cellSize * worldScale`. Default 0 — inject a
     * feature only into cells it passes through (a factor ≥ 1 pulls whole rings
     * of flat-face cells onto feature edges, collapsing geometry).
     */
    distFactor: number
}

/**
 * One FG feature reduced to a QEF plane source: a point all the feature's
 * Hermite planes pass through, plus its unit normals — already in the
 * normalized cell frame. A corner contributes one source with up to 3 normals;
 * a crease contributes one source with 2 normals (both its face normals).
 */
export interface FgPlaneSource {
    /** Feature point, normalized `[0,1]³` root frame. */
    px: number
    py: number
    pz: number
    /** Number of unit normals (1..{@link FG_CELL_NORMAL_BLOCK}/3). */
    normalCount: number
    /** Flat unit normals, length `normalCount * 3`. */
    normals: number[]
}

/** Minimum |n·axis| below which a projected feature plane imposes no useful constraint. */
const FEATURE_PLANE_AXIS_EPS = 1e-4

/** Euclidean distance from a point to an axis-aligned box (0 when inside / on the boundary). */
export function pointAabbDistance(
    px: number, py: number, pz: number,
    minX: number, minY: number, minZ: number,
    maxX: number, maxY: number, maxZ: number,
): number {
    const dx = px < minX ? minX - px : px > maxX ? px - maxX : 0
    const dy = py < minY ? minY - py : py > maxY ? py - maxY : 0
    const dz = pz < minZ ? minZ - pz : pz > maxZ ? pz - maxZ : 0
    return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

/**
 * Closest point on segment `a→b` to point `p`, written into `out`. Standard
 * project-and-clamp: `t = clamp(dot(p-a, b-a) / |b-a|², 0, 1)`.
 */
export function closestPointOnSegment(
    px: number, py: number, pz: number,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    out: [number, number, number],
): void {
    const ex = bx - ax, ey = by - ay, ez = bz - az
    const len2 = ex * ex + ey * ey + ez * ez
    let t = 0
    if (len2 > 1e-20) {
        t = ((px - ax) * ex + (py - ay) * ey + (pz - az) * ez) / len2
        if (t < 0) t = 0
        else if (t > 1) t = 1
    }
    out[0] = ax + ex * t
    out[1] = ay + ey * t
    out[2] = az + ez * t
}

/** Reusable crease-group accumulator — module-scoped to avoid a per-call Map alloc. */
interface CreaseGroup {
    /** Distance from the cell to the closest segment of this crease. */
    dist: number
    /** Representative crease (segment) index. */
    index: number
    cpx: number
    cpy: number
    cpz: number
}
const creaseGroups = new Map<string, CreaseGroup>()

/** Quantization scale for the crease normal signature (1e-4 world-normal resolution). */
const CREASE_KEY_QUANT = 1e4

/**
 * Signature string for crease `e`'s source-face normals — subdivided segments
 * of one original crease share normals, so they collapse to one key. Distinct
 * creases of a primitive carry distinct face-normal pairs, so they stay split.
 */
function creaseNormalKey(fg: FgCellFeatures, e: number): string {
    const nc = fg.creaseNormalCounts[e]!
    const nBase = e * FG_CELL_NORMAL_BLOCK
    let key = `${nc}`
    for (let i = 0; i < nc * 3; i++) {
        key += `:${Math.round(fg.creaseNormals[nBase + i]! * CREASE_KEY_QUANT)}`
    }
    return key
}

/**
 * Gate + dedup the cell's queried FG features into {@link FgPlaneSource}s.
 * Call once per octree cell; feed the result to all of that cell's QEF
 * injections (cube + 12 edges + 6 faces).
 *
 * - **Corners**: emitted if inside the gated cell AABB.
 * - **Creases**: the FG subdivides each feature edge into many short segments;
 *   emitting per-segment would over-weight the crease in proportion to its
 *   (per-cell-varying) segment count → jagged feature edges. Segments are
 *   grouped by a quantized source-face-normal signature so one original crease
 *   contributes one source. Any point on a crease line lies in both its face
 *   planes, so the representative point (closest segment to the cell centre)
 *   does not affect the encoded planes.
 *
 * Cell AABB is given in the normalized `[0,1]³` frame; `ctx` carries the world
 * conversion and the distance gate.
 */
export function collectFgPlaneSources(
    fg: FgCellFeatures,
    ctx: FgPlaneInjectionContext,
    cellMinX: number, cellMinY: number, cellMinZ: number,
    cellMaxX: number, cellMaxY: number, cellMaxZ: number,
    cellSize: number,
): FgPlaneSource[] {
    const out: FgPlaneSource[] = []
    if (fg.cornerCount === 0 && fg.creaseCount === 0) return out

    const ws = ctx.worldScale
    const invWS = 1 / ws
    const distThreshold = ctx.distFactor * cellSize * ws

    const wMinX = ctx.rootMinX + cellMinX * ws
    const wMinY = ctx.rootMinY + cellMinY * ws
    const wMinZ = ctx.rootMinZ + cellMinZ * ws
    const wMaxX = ctx.rootMinX + cellMaxX * ws
    const wMaxY = ctx.rootMinY + cellMaxY * ws
    const wMaxZ = ctx.rootMinZ + cellMaxZ * ws

    // Corners.
    for (let c = 0; c < fg.cornerCount; c++) {
        const wx = fg.cornerPositions[c * 3 + 0]!
        const wy = fg.cornerPositions[c * 3 + 1]!
        const wz = fg.cornerPositions[c * 3 + 2]!
        if (pointAabbDistance(wx, wy, wz, wMinX, wMinY, wMinZ, wMaxX, wMaxY, wMaxZ) > distThreshold) continue
        const nc = fg.cornerNormalCounts[c]!
        const nBase = c * FG_CELL_NORMAL_BLOCK
        const normals: number[] = []
        for (let i = 0; i < nc * 3; i++) normals.push(fg.cornerNormals[nBase + i]!)
        out.push({
            px: (wx - ctx.rootMinX) * invWS,
            py: (wy - ctx.rootMinY) * invWS,
            pz: (wz - ctx.rootMinZ) * invWS,
            normalCount: nc,
            normals,
        })
    }

    // Creases — grouped so subdivided segments of one crease emit one source.
    if (fg.creaseCount > 0) {
        const wCenterX = (wMinX + wMaxX) * 0.5
        const wCenterY = (wMinY + wMaxY) * 0.5
        const wCenterZ = (wMinZ + wMaxZ) * 0.5
        const cp: [number, number, number] = [0, 0, 0]
        for (let e = 0; e < fg.creaseCount; e++) {
            closestPointOnSegment(
                wCenterX, wCenterY, wCenterZ,
                fg.creaseSegments[e * 6 + 0]!, fg.creaseSegments[e * 6 + 1]!, fg.creaseSegments[e * 6 + 2]!,
                fg.creaseSegments[e * 6 + 3]!, fg.creaseSegments[e * 6 + 4]!, fg.creaseSegments[e * 6 + 5]!,
                cp,
            )
            const d = pointAabbDistance(cp[0], cp[1], cp[2], wMinX, wMinY, wMinZ, wMaxX, wMaxY, wMaxZ)
            if (d > distThreshold) continue
            const key = creaseNormalKey(fg, e)
            const prev = creaseGroups.get(key)
            if (prev === undefined || d < prev.dist) {
                creaseGroups.set(key, { dist: d, index: e, cpx: cp[0], cpy: cp[1], cpz: cp[2] })
            }
        }
        for (const g of creaseGroups.values()) {
            const nc = fg.creaseNormalCounts[g.index]!
            const nBase = g.index * FG_CELL_NORMAL_BLOCK
            const normals: number[] = []
            for (let i = 0; i < nc * 3; i++) normals.push(fg.creaseNormals[nBase + i]!)
            out.push({
                px: (g.cpx - ctx.rootMinX) * invWS,
                py: (g.cpy - ctx.rootMinY) * invWS,
                pz: (g.cpz - ctx.rootMinZ) * invWS,
                normalCount: nc,
                normals,
            })
        }
        creaseGroups.clear()
    }

    return out
}

/** Normal component along axis `a` (0=x, 1=y, 2=z). */
function comp(normals: number[], base: number, a: 0 | 1 | 2): number {
    return normals[base + a]!
}

/**
 * Inject FG feature planes into a **cube** QEF (3D, unconstrained). Each source
 * contributes one pure-3D Hermite plane per normal, all through the source
 * point. `sources` come from {@link collectFgPlaneSources}.
 *
 * @returns the number of planes accumulated.
 */
export function injectCubeFgFeaturePlanes(
    sources: readonly FgPlaneSource[],
    packed: Float64Array,
    planeNorms4: [number, number, number, number][],
    planePts4: [number, number, number, number][],
): number {
    let added = 0
    for (const s of sources) {
        for (let k = 0; k < s.normalCount; k++) {
            const b = k * 3
            const nx = s.normals[b]!, ny = s.normals[b + 1]!, nz = s.normals[b + 2]!
            qefAccumulatePlane(encodeFeaturePlane(nx, ny, nz, s.px, s.py, s.pz), packed)
            planeNorms4.push([nx, ny, nz, 0])
            planePts4.push([s.px, s.py, s.pz, 0])
            added++
        }
    }
    return added
}

/**
 * Inject FG feature planes into an **edge** QEF (1D, constrained to cell-edge
 * axis `xi`, fixed at `(yEdge, zEdge)` on the other two axes). Each normal is
 * projected to the axis-only equation `n[xi] · (xi − xiHit) = 0`, where `xiHit`
 * is where the feature plane crosses the edge line. Normals nearly parallel to
 * the edge (small `|n[xi]|`) impose no constraint and are skipped.
 *
 * @returns the number of planes accumulated.
 */
export function injectEdgeFgFeaturePlanes(
    sources: readonly FgPlaneSource[],
    xi: 0 | 1 | 2, yi: 0 | 1 | 2, zi: 0 | 1 | 2,
    yEdge: number, zEdge: number,
    packed: Float64Array,
    planeNorms2: [number, number][],
    planePts2: [number, number][],
): number {
    let added = 0
    for (const s of sources) {
        const point = [s.px, s.py, s.pz] as const
        for (let k = 0; k < s.normalCount; k++) {
            const b = k * 3
            const nAxis = comp(s.normals, b, xi)
            if (Math.abs(nAxis) < FEATURE_PLANE_AXIS_EPS) continue
            const nOff1 = comp(s.normals, b, yi)
            const nOff2 = comp(s.normals, b, zi)
            const xiHit = point[xi]! - (nOff1 * (yEdge - point[yi]!) + nOff2 * (zEdge - point[zi]!)) / nAxis
            qefAccumulatePlane(encodeEdgeFeaturePlane(nAxis, xiHit), packed)
            planeNorms2.push([nAxis, 0])
            planePts2.push([xiHit, 0])
            added++
        }
    }
    return added
}

/**
 * Inject FG feature planes into a **face** QEF (2D, constrained to the cell
 * face `zi = zFace`, varying in `(xi, yi)`). Each normal is projected to the
 * 2D equation `n[xi]·xi + n[yi]·yi = const` describing where the feature plane
 * meets the face. Normals nearly parallel to the face plane (small
 * `n[xi]² + n[yi]²`) impose no constraint and are skipped.
 *
 * @returns the number of planes accumulated.
 */
export function injectFaceFgFeaturePlanes(
    sources: readonly FgPlaneSource[],
    xi: 0 | 1 | 2, yi: 0 | 1 | 2, zi: 0 | 1 | 2,
    zFace: number,
    packed: Float64Array,
    planeNorms3: [number, number, number][],
    planePts3: [number, number, number][],
): number {
    let added = 0
    for (const s of sources) {
        const point = [s.px, s.py, s.pz] as const
        for (let k = 0; k < s.normalCount; k++) {
            const b = k * 3
            const nAxisX = comp(s.normals, b, xi)
            const nAxisY = comp(s.normals, b, yi)
            const nAxisZ = comp(s.normals, b, zi)
            const denom = nAxisX * nAxisX + nAxisY * nAxisY
            if (denom < FEATURE_PLANE_AXIS_EPS * FEATURE_PLANE_AXIS_EPS) continue
            const t = (-nAxisZ * (zFace - point[zi]!)) / denom
            const pXi = point[xi]! + nAxisX * t
            const pYi = point[yi]! + nAxisY * t
            qefAccumulatePlane(encodeFaceFeaturePlane(nAxisX, nAxisY, pXi, pYi), packed)
            planeNorms3.push([nAxisX, nAxisY, 0])
            planePts3.push([pXi, pYi, 0])
            added++
        }
    }
    return added
}
