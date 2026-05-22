/**
 * Per-cell FeatureGraph query (Phase IS-2 of the iso-simplicial × FG plan).
 *
 * The iso-simplicial exporter solves a QEF per octree cell. To inject
 * FG-derived Hermite planes it needs, for a given cell's world-space AABB,
 * the set of FG corners and crease edges near that cell.
 *
 * {@link queryFeatureGraphForCell} answers that: it walks the
 * {@link FeatureGraphSpatialIndex} cells overlapping the (padded) octree cell
 * AABB, unions their feature refs with dedup, and resolves each ref to packed
 * world-space geometry.
 *
 * Multi-resolution: the FG index is built at the finest octree cell size, so a
 * shallow octree cell spans many FG cells. The same feature ref can therefore
 * appear in several FG buckets (also from the index's ½-cell AABB widening) —
 * the dedup `Set` collapses those to one contribution.
 *
 * The returned set is a *superset* for the cell: it is widened by `pad` so the
 * downstream QEF injection can apply its own precise distance gate. Corners
 * and creases are kept separate because the injection treats them differently
 * (a corner is a 0D point with N planes; a crease is a 1D segment).
 *
 * Non-corner standalone vertices (crease subdivision samples, bisection
 * boundary vertices) are intentionally NOT emitted — they are implicit in the
 * crease edge segments, and emitting them again would just add redundant,
 * weaker point constraints. Same rationale as `featureGraphToContours`.
 */

import type { FeatureGraphCpu } from "../scene/feature-graph-buffer.mjs"
import { FG_FLAG_ALIVE, FG_FLAG_CORNER, FG_MAX_NORMALS_PER_VERTEX } from "../scene/feature-graph-buffer.mjs"
import type { FeatureGraphWorldPositions } from "./feature-graph-stages.mjs"
import {
    FeatureGraphSpatialIndex,
    FG_REF_KIND_EDGE,
    FG_REF_KIND_VERTEX,
    decodeFeatureRefIndex,
    decodeFeatureRefKind,
} from "./feature-graph-spatial-index.mjs"

/** Floats per packed normal block: 3 components × {@link FG_MAX_NORMALS_PER_VERTEX}. */
const NORMAL_BLOCK = 3 * FG_MAX_NORMALS_PER_VERTEX

/**
 * FG features overlapping one octree cell, as packed world-space arrays ready
 * for QEF plane injection.
 */
export interface FgCellFeatures {
    /** Corner world positions, stride 3. */
    cornerPositions: Float32Array
    /** Corner world normals, stride {@link NORMAL_BLOCK}; trailing slots zero. */
    cornerNormals: Float32Array
    /** Per-corner source-face normal count (1..{@link FG_MAX_NORMALS_PER_VERTEX}). */
    cornerNormalCounts: Uint32Array
    cornerCount: number
    /** Crease segment endpoints, stride 6 (ax,ay,az, bx,by,bz), world space. */
    creaseSegments: Float32Array
    /** Crease world normals (from segment endpoint A), stride {@link NORMAL_BLOCK}. */
    creaseNormals: Float32Array
    /** Per-crease source-face normal count (typically 2). */
    creaseNormalCounts: Uint32Array
    creaseCount: number
}

/** Shared zero-feature result. */
export function emptyFgCellFeatures(): FgCellFeatures {
    return {
        cornerPositions: new Float32Array(0),
        cornerNormals: new Float32Array(0),
        cornerNormalCounts: new Uint32Array(0),
        cornerCount: 0,
        creaseSegments: new Float32Array(0),
        creaseNormals: new Float32Array(0),
        creaseNormalCounts: new Uint32Array(0),
        creaseCount: 0,
    }
}

/**
 * Collect FG corners + crease edges overlapping the octree cell AABB
 * `[min, max]`, widened by `pad` (world units) so distance-gating headroom is
 * covered. `pad` should match the injection step's gate distance.
 *
 * @param index Spatial index built over `cpu` / `world` at the finest cell size.
 * @param cpu   FeatureGraph CPU snapshot (post-bisection — alive flags final).
 * @param world World positions for `cpu`'s vertices.
 */
export function queryFeatureGraphForCell(
    index: FeatureGraphSpatialIndex,
    cpu: FeatureGraphCpu,
    world: FeatureGraphWorldPositions,
    cellMinX: number, cellMinY: number, cellMinZ: number,
    cellMaxX: number, cellMaxY: number, cellMaxZ: number,
    pad: number,
): FgCellFeatures {
    if (index.isEmpty || cpu.vertexCount === 0) return emptyFgCellFeatures()

    const cs = index.cellSize
    const inv = 1 / cs
    const cx0 = Math.floor((cellMinX - pad) * inv)
    const cy0 = Math.floor((cellMinY - pad) * inv)
    const cz0 = Math.floor((cellMinZ - pad) * inv)
    const cx1 = Math.floor((cellMaxX + pad) * inv)
    const cy1 = Math.floor((cellMaxY + pad) * inv)
    const cz1 = Math.floor((cellMaxZ + pad) * inv)

    // Union refs across every FG cell the (padded) octree cell touches. The
    // same ref recurs across cells (multi-resolution span + ½-cell widening),
    // so dedup via Set before resolving geometry.
    const refs = new Set<number>()
    for (let cz = cz0; cz <= cz1; cz++) {
        for (let cy = cy0; cy <= cy1; cy++) {
            for (let cx = cx0; cx <= cx1; cx++) {
                const bucket = index.queryCell(cx, cy, cz)
                if (!bucket) continue
                for (let k = 0; k < bucket.length; k++) refs.add(bucket[k]!)
            }
        }
    }
    if (refs.size === 0) return emptyFgCellFeatures()

    // Pass 1: classify + count. A ref is dropped here if its feature is no
    // longer alive (the index is built from alive features, but defend anyway).
    let cornerCount = 0
    let creaseCount = 0
    for (const ref of refs) {
        if (decodeFeatureRefKind(ref) === FG_REF_KIND_VERTEX) {
            const i = decodeFeatureRefIndex(ref)
            const f = cpu.vertexFlags[i]!
            if ((f & FG_FLAG_ALIVE) !== 0 && (f & FG_FLAG_CORNER) !== 0) cornerCount++
        } else {
            const e = decodeFeatureRefIndex(ref)
            if ((cpu.edgeFlags[e]! & FG_FLAG_ALIVE) !== 0) creaseCount++
        }
    }
    if (cornerCount === 0 && creaseCount === 0) return emptyFgCellFeatures()

    const out: FgCellFeatures = {
        cornerPositions: new Float32Array(cornerCount * 3),
        cornerNormals: new Float32Array(cornerCount * NORMAL_BLOCK),
        cornerNormalCounts: new Uint32Array(cornerCount),
        cornerCount,
        creaseSegments: new Float32Array(creaseCount * 6),
        creaseNormals: new Float32Array(creaseCount * NORMAL_BLOCK),
        creaseNormalCounts: new Uint32Array(creaseCount),
        creaseCount,
    }

    // Pass 2: resolve geometry.
    let ci = 0
    let ei = 0
    for (const ref of refs) {
        if (decodeFeatureRefKind(ref) === FG_REF_KIND_VERTEX) {
            const i = decodeFeatureRefIndex(ref)
            const f = cpu.vertexFlags[i]!
            if ((f & FG_FLAG_ALIVE) === 0 || (f & FG_FLAG_CORNER) === 0) continue
            out.cornerPositions[ci * 3 + 0] = world.positions[i * 3 + 0]!
            out.cornerPositions[ci * 3 + 1] = world.positions[i * 3 + 1]!
            out.cornerPositions[ci * 3 + 2] = world.positions[i * 3 + 2]!
            const nc = cpu.vertexNormalCount[i]!
            out.cornerNormalCounts[ci] = nc
            const src = i * NORMAL_BLOCK
            const dst = ci * NORMAL_BLOCK
            for (let n = 0; n < NORMAL_BLOCK; n++) out.cornerNormals[dst + n] = cpu.vertexNormals[src + n]!
            ci++
        } else {
            const e = decodeFeatureRefIndex(ref)
            if ((cpu.edgeFlags[e]! & FG_FLAG_ALIVE) === 0) continue
            const va = cpu.edgeEndpoints[e * 2]!
            const vb = cpu.edgeEndpoints[e * 2 + 1]!
            out.creaseSegments[ei * 6 + 0] = world.positions[va * 3 + 0]!
            out.creaseSegments[ei * 6 + 1] = world.positions[va * 3 + 1]!
            out.creaseSegments[ei * 6 + 2] = world.positions[va * 3 + 2]!
            out.creaseSegments[ei * 6 + 3] = world.positions[vb * 3 + 0]!
            out.creaseSegments[ei * 6 + 4] = world.positions[vb * 3 + 1]!
            out.creaseSegments[ei * 6 + 5] = world.positions[vb * 3 + 2]!
            // Both endpoints of a feature edge share source faces; read from A
            // (matches the stage-3 / stage-4b normal-copy convention).
            const nc = cpu.vertexNormalCount[va]!
            out.creaseNormalCounts[ei] = nc
            const src = va * NORMAL_BLOCK
            const dst = ei * NORMAL_BLOCK
            for (let n = 0; n < NORMAL_BLOCK; n++) out.creaseNormals[dst + n] = cpu.vertexNormals[src + n]!
            ei++
        }
    }

    return out
}

export { NORMAL_BLOCK as FG_CELL_NORMAL_BLOCK }

// Re-export so consumers can build a query without importing the index module
// separately when they only need the query entry point.
export { FeatureGraphSpatialIndex }
