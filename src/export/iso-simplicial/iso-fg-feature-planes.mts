/**
 * FeatureGraph → per-cell QEF Hermite plane injection (Phase IS-3/IS-4 of the
 * iso-simplicial × FG plan).
 *
 * The iso-simplicial exporter solves a QEF per octree cell to place the cell's
 * dual vertex. {@link injectCubeFgFeaturePlanes} adds extra Hermite planes
 * derived from the survival-aware FeatureGraph so the dual vertex is pulled
 * toward explicit primitive features (Box corners, crease dihedrals, …) rather
 * than approximated from SDF gradient samples alone.
 *
 * These are *soft* constraints: each plane is just another equation in the QEF
 * normal system. They compose additively with the GPU mid-feature planes the
 * existing `featurePlaneEnabled` path injects — neither replaces the other.
 *
 * Pure module — no octree / scene imports — so it runs unchanged on the main
 * thread and inside the QEF worker.
 *
 * Coordinate frames
 * -----------------
 * The cube QEF works in the root AABB's normalized `[0,1]³` frame. FG geometry
 * (`FgCellFeatures`) is world-space. Conversion: `pn = (p - rootMin) /
 * worldScale`. The root AABB is a cube, so the world→normalized map is a
 * uniform scale and unit normals stay unit (direction unchanged) — normals are
 * injected as-is.
 */

import type { FgCellFeatures } from "../../feature-graph/feature-graph-cell-query.mjs"
import { FG_CELL_NORMAL_BLOCK } from "../../feature-graph/feature-graph-cell-query.mjs"
import { encodeFeaturePlane } from "./dual-vertex-qef.mjs"
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
     * AABB exceeds `distFactor * cellSize * worldScale`. Matches the existing
     * GPU mid-feature `planeDistFactor` convention.
     */
    distFactor: number
}

/** Euclidean distance from a point to an axis-aligned box (0 when inside). */
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

/**
 * Inject FG corner + crease Hermite planes into a cube QEF.
 *
 * - **Corner**: a 0D feature — emits one plane per source-face normal, all
 *   through the corner point. Their intersection is (approximately) the corner.
 * - **Crease**: a 1D feature — emits its two face planes. Each face plane
 *   contains the *entire* crease line (the crease is the planes' intersection),
 *   so the plane point may be any point on the segment; the closest point on
 *   the segment to the cell centre is used to keep encoded values bounded.
 *
 * Both are distance-gated against the cell's world AABB. The cell AABB is given
 * in the normalized `[0,1]³` frame; `ctx` carries the world conversion.
 *
 * @returns the number of planes accumulated.
 */
export function injectCubeFgFeaturePlanes(
    fg: FgCellFeatures,
    ctx: FgPlaneInjectionContext,
    cellMinX: number, cellMinY: number, cellMinZ: number,
    cellMaxX: number, cellMaxY: number, cellMaxZ: number,
    cellSize: number,
    packed: Float64Array,
    planeNorms4: [number, number, number, number][],
    planePts4: [number, number, number, number][],
): number {
    if (fg.cornerCount === 0 && fg.creaseCount === 0) return 0

    const ws = ctx.worldScale
    const invWS = 1 / ws
    const distThreshold = ctx.distFactor * cellSize * ws

    // Cell AABB in world space.
    const wMinX = ctx.rootMinX + cellMinX * ws
    const wMinY = ctx.rootMinY + cellMinY * ws
    const wMinZ = ctx.rootMinZ + cellMinZ * ws
    const wMaxX = ctx.rootMinX + cellMaxX * ws
    const wMaxY = ctx.rootMinY + cellMaxY * ws
    const wMaxZ = ctx.rootMinZ + cellMaxZ * ws
    const wCenterX = (wMinX + wMaxX) * 0.5
    const wCenterY = (wMinY + wMaxY) * 0.5
    const wCenterZ = (wMinZ + wMaxZ) * 0.5

    let added = 0

    const emit = (nx: number, ny: number, nz: number, pnx: number, pny: number, pnz: number): void => {
        qefAccumulatePlane(encodeFeaturePlane(nx, ny, nz, pnx, pny, pnz), packed)
        planeNorms4.push([nx, ny, nz, 0])
        planePts4.push([pnx, pny, pnz, 0])
        added++
    }

    // Corners.
    for (let c = 0; c < fg.cornerCount; c++) {
        const wx = fg.cornerPositions[c * 3 + 0]!
        const wy = fg.cornerPositions[c * 3 + 1]!
        const wz = fg.cornerPositions[c * 3 + 2]!
        const d = pointAabbDistance(wx, wy, wz, wMinX, wMinY, wMinZ, wMaxX, wMaxY, wMaxZ)
        if (d > distThreshold) continue
        const pnx = (wx - ctx.rootMinX) * invWS
        const pny = (wy - ctx.rootMinY) * invWS
        const pnz = (wz - ctx.rootMinZ) * invWS
        const nc = fg.cornerNormalCounts[c]!
        const nBase = c * FG_CELL_NORMAL_BLOCK
        for (let n = 0; n < nc; n++) {
            emit(
                fg.cornerNormals[nBase + n * 3 + 0]!,
                fg.cornerNormals[nBase + n * 3 + 1]!,
                fg.cornerNormals[nBase + n * 3 + 2]!,
                pnx, pny, pnz,
            )
        }
    }

    // Creases.
    //
    // The FG subdivides every feature edge into short segments (≤ ½ voxel) for
    // its SDF-survival pass. A cube cell overlaps a *variable* number of those
    // segments, so emitting planes per-segment would weight one crease's
    // constraint by its (per-cell-varying) segment count — adjacent cells get
    // different weights and the dual vertices wobble → jagged feature edges.
    //
    // A crease is one feature *line* and must contribute its 2 face planes
    // exactly once per cell. All segments of one original crease carry the same
    // source-face normals (copied from endpoint A through subdivision), so we
    // group segments by a quantized normal signature and emit one plane set per
    // group, using the segment closest to the cell as the representative.
    if (fg.creaseCount > 0) {
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
            const pnx = (g.cpx - ctx.rootMinX) * invWS
            const pny = (g.cpy - ctx.rootMinY) * invWS
            const pnz = (g.cpz - ctx.rootMinZ) * invWS
            const nc = fg.creaseNormalCounts[g.index]!
            const nBase = g.index * FG_CELL_NORMAL_BLOCK
            for (let n = 0; n < nc; n++) {
                emit(
                    fg.creaseNormals[nBase + n * 3 + 0]!,
                    fg.creaseNormals[nBase + n * 3 + 1]!,
                    fg.creaseNormals[nBase + n * 3 + 2]!,
                    pnx, pny, pnz,
                )
            }
        }
        creaseGroups.clear()
    }

    return added
}

/** Reusable crease-group accumulator — module-scoped to avoid a per-call Map alloc. */
interface CreaseGroup {
    /** Distance from the cell to the closest segment of this crease. */
    dist: number
    /** Representative crease (segment) index — its normals + closest point are used. */
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
