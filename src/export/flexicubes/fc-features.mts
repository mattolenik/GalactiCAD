/**
 * FeatureGraph → FlexiCubes QEF constraint injection.
 *
 * FlexiCubes places each dual vertex by solving a plane-QEF over the surface
 * edge-crossings inside its cell (see `fc-cpu.mts`, Pass D). On coarse grids
 * that QEF alone rounds sharp corners and lets crease vertices drift, because
 * the SDF carries no explicit notion of *where* the sharp features are.
 *
 * This module folds the authoritative, CSG-survival-filtered features from the
 * FeatureGraph (delivered as a {@link ContourSpatialIndex} of corner points and
 * crease segments) **directly into the per-cell QEF** as extra weighted
 * constraints, rather than snapping the vertex after the fact:
 *
 *   - **Corner point `c`** → isotropic point pull: `ATA += w·I`, `ATb += w·c`.
 *     With a large weight this drives the solution to `c`, but it still blends
 *     with the surface planes (graceful, unlike a hard snap).
 *   - **Crease line** through `q` with unit tangent `t` → line constraint:
 *     `ATA += w·(I − t⊗t)`, `ATb += w·(I − t⊗t)·q`. This pins the two
 *     cross-tangent directions onto the line and leaves the along-`t` slide to
 *     be resolved by the surface crossings already in the QEF.
 *
 * Both terms add into the same `ATA`/`ATb` the surface crossings accumulated,
 * so the SDF surface and the feature locus are solved *jointly*: the surface
 * corrects gross feature error and resolves the unconstrained slide, while the
 * feature pins the vertex onto the true crease/corner.
 *
 * Every candidate is **validated against the SDF** (`sampleScalarTrilinear`)
 * before injection — the FeatureGraph is already survival-filtered, but a long
 * crease can be partially cut, so a per-cell check keeps the snap honest. This
 * mirrors the validation SHREC's `trySnapToContours` performs.
 */

import { ContourKind } from "../../scene/contour-buffer.mjs"
import type { GridSampleResult } from "../grid-sample.mjs"
import {
    type ContourSpatialIndex,
    projectOntoSegment,
    sampleScalarTrilinear,
} from "../shrec/contour-snap.mjs"
import { type Sym3 } from "../shrec/svd3.mjs"

/** A validated feature lying inside a cube cell, ready to inject into a QEF. */
export interface CellFeature {
    /** {@link ContourKind.Point} (corner) or {@link ContourKind.Segment} (crease line). */
    kind: ContourKind
    /** Locus: the corner position, or the query's projection onto the segment. */
    x: number
    y: number
    z: number
    /** Unit tangent along the crease; zero vector for corners. */
    tx: number
    ty: number
    tz: number
}

/** Reusable per-cube scratch so the inner loop allocates nothing. */
export interface FeatureScratch {
    features: CellFeature[]
}

const MAX_CELL_FEATURES = 16

export function makeFeatureScratch(): FeatureScratch {
    const features: CellFeature[] = []
    for (let i = 0; i < MAX_CELL_FEATURES; i++) {
        features.push({ kind: ContourKind.Point, x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0 })
    }
    return { features }
}

/**
 * Collect FeatureGraph corners/creases that fall inside cube cell `(cx,cy,cz)`
 * and survive the SDF validation. Results are written into `scratch.features`;
 * the returned count is how many entries are valid.
 *
 * `queryX/Y/Z` is the position used to project segments (typically the cube
 * center or a slot mass point). Validation tolerance matches SHREC's
 * `voxelSize · 0.75` — loose enough for trilinear interpolation error at a
 * sharp feature, tight enough to reject contours a CSG cut moved off-surface.
 */
export function collectCellFeatures(
    index: ContourSpatialIndex,
    grid: GridSampleResult,
    cx: number, cy: number, cz: number,
    cellMinX: number, cellMinY: number, cellMinZ: number,
    cellMaxX: number, cellMaxY: number, cellMaxZ: number,
    queryX: number, queryY: number, queryZ: number,
    scratch: FeatureScratch,
): number {
    const refs = index.queryCell(cx, cy, cz)
    if (!refs || refs.length === 0) return 0

    const contours = index.contours
    const segments = contours.segments
    const points = contours.points
    const tol = grid.voxelSize * 0.75
    const eps = 1e-6
    const proj = { x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0 }

    let n = 0
    const inCell = (px: number, py: number, pz: number) =>
        px >= cellMinX - eps && px <= cellMaxX + eps &&
        py >= cellMinY - eps && py <= cellMaxY + eps &&
        pz >= cellMinZ - eps && pz <= cellMaxZ + eps

    for (let i = 0; i < refs.length && n < MAX_CELL_FEATURES; i++) {
        const ref = refs[i]!
        const kind = (ref >>> 28) as ContourKind
        const idx = ref & 0x0fffffff
        let px: number, py: number, pz: number
        let tx = 0, ty = 0, tz = 0
        if (kind === ContourKind.Point) {
            const o = idx * 3
            px = points[o]!; py = points[o + 1]!; pz = points[o + 2]!
        } else if (kind === ContourKind.Segment) {
            const o = idx * 6
            projectOntoSegment(
                segments[o]!, segments[o + 1]!, segments[o + 2]!,
                segments[o + 3]!, segments[o + 4]!, segments[o + 5]!,
                queryX, queryY, queryZ,
                proj,
            )
            px = proj.x; py = proj.y; pz = proj.z
            tx = proj.tx; ty = proj.ty; tz = proj.tz
        } else {
            continue // rings unmodeled in v1
        }
        if (!inCell(px, py, pz)) continue
        if (Math.abs(sampleScalarTrilinear(grid, px, py, pz)) > tol) continue

        const f = scratch.features[n]!
        f.kind = kind
        f.x = px; f.y = py; f.z = pz
        f.tx = tx; f.ty = ty; f.tz = tz
        n++
    }
    return n
}

/** Add an isotropic point pull `w·I`, `w·c` for a corner at `(cx,cy,cz)`. */
export function addPointConstraint(
    ata: Sym3, atb: [number, number, number], w: number,
    cx: number, cy: number, cz: number,
): void {
    ata.a00 += w
    ata.a11 += w
    ata.a22 += w
    atb[0] += w * cx
    atb[1] += w * cy
    atb[2] += w * cz
}

/**
 * Add a crease-line constraint `w·(I − t⊗t)` to `ata` and `w·(I − t⊗t)·q` to
 * `atb`, pinning the cross-tangent directions onto the line through `q` with
 * unit tangent `t` while leaving the along-`t` slide free.
 */
export function addLineConstraint(
    ata: Sym3, atb: [number, number, number], w: number,
    qx: number, qy: number, qz: number,
    tx: number, ty: number, tz: number,
): void {
    ata.a00 += w * (1 - tx * tx)
    ata.a11 += w * (1 - ty * ty)
    ata.a22 += w * (1 - tz * tz)
    ata.a01 += w * (-tx * ty)
    ata.a02 += w * (-tx * tz)
    ata.a12 += w * (-ty * tz)
    // (I − t⊗t)·q = q − (t·q) t
    const tq = tx * qx + ty * qy + tz * qz
    atb[0] += w * (qx - tq * tx)
    atb[1] += w * (qy - tq * ty)
    atb[2] += w * (qz - tq * tz)
}
