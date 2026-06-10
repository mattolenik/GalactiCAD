/**
 * S4 — pipeline driver, certification, and MeshData assembly.
 *
 * Runs S2 (octree) → S3 (face contour + cell meshing) → audits:
 *   1. face-segment audit — every interior canonical face segment must be
 *      consumed exactly twice, once per direction (the CMS closedness
 *      invariant, checked structurally);
 *   2. mesh-edge audit — the emitted triangle mesh must be a closed oriented
 *      2-manifold (manifold-check.mts).
 *
 * Failure policy is the caller's (`partial` returns the mesh + diagnostics;
 * `throw` raises). Re-refinement rounds land in P7.
 */

import type { CpuSdfTree } from "./cpu-sdf.mjs"
import type { SfccTuning } from "./sfcc-tuning.mjs"
import { cellAabb, makeLattice, type SfccLattice } from "./lattice.mjs"
import { buildOctree, type SfccOctree } from "./octree.mjs"
import { classifyCellFeatures, hasCornerSignChange, makeProbe, needsSplitSmooth } from "./refine-criteria.mjs"
import { compileFeatureSet, type SfccFeatureSet } from "./feature-set.mjs"
import { resolveTolerances } from "./tolerances.mjs"
import { contourAllFaces } from "./face-contour.mjs"
import { meshAllCells } from "./cell-mesh.mjs"
import { PointTable } from "./point-table.mjs"
import { checkManifold, type ManifoldReport } from "./manifold-check.mjs"

export interface SfccStats {
    leaves: number
    degenerateCells: number
    /** Leaf count per octree level (index = level). */
    levelHistogram: number[]
    faces: number
    crossPoints: number
    tris: number
    failedCells: number
    multiLoopCells: number
    multiRunFaces: number
    boundaryViolations: number
    faceAuditFailures: number
    featureCurves: number
    edgeCells: number
    cornerCells: number
    featureCellFallbacks: number
    reRefineRounds: number
}

export interface SfccPipelineResult {
    verts: Float32Array<ArrayBuffer>
    tris: Uint32Array<ArrayBuffer>
    stats: SfccStats
    manifold: ManifoldReport
    ok: boolean
    /** World AABBs of failed cells (6 floats each) for debug overlays. */
    failedCellBoxes: Float32Array<ArrayBuffer>
    /** Feature polyline overlay segments (xyz pairs), when tuning.debugOutput. */
    featurePolylines?: Float32Array<ArrayBuffer>
}

export interface SfccWorldCube {
    minX: number
    minY: number
    minZ: number
    size: number
}

export function runSfccPipeline(
    tree: CpuSdfTree,
    cube: SfccWorldCube,
    tuning: SfccTuning,
    signal?: AbortSignal,
): SfccPipelineResult {
    const pad = tuning.boundsPaddingMm
    // Lattice-degeneracy guard: axis-aligned CAD geometry at "nice" coordinates
    // lands exactly on lattice planes (sample signs, face rects, and pin
    // positions all tie). Always offset the root cube by distinct irrational
    // fractions of a max-depth cell so rational geometry can never coincide
    // with the dyadic lattice. Deterministic — no Math.random.
    const step = (cube.size + 2 * pad) / (1 << tuning.depthMax)
    const jx = (Math.SQRT2 - 1) * 0.25 * step
    const jy = (Math.sqrt(3) - 1) * 0.25 * step
    const jz = (Math.sqrt(5) - 2) * 0.25 * step
    const lat: SfccLattice = makeLattice(
        tuning.depthMax,
        cube.minX - pad - jx,
        cube.minY - pad - jy,
        cube.minZ - pad - jz,
        cube.size + 2 * pad,
    )

    const sceneDiag = Math.hypot(cube.size, cube.size, cube.size)
    const tolerances = resolveTolerances(tuning, sceneDiag)
    const features: SfccFeatureSet = compileFeatureSet(tree, tolerances)

    // Forced-split markers from prior rounds' failed/fallback cells: any leaf
    // containing such a center at ≤ the recorded level must split. The
    // re-refinement loop is the designed answer to sub-sample face slivers —
    // splitting moves face boundaries, making invisible arcs visible.
    const forced: Array<{ x: number; y: number; z: number; level: number }> = []
    const forcedSplit = (cell: { level: number; ix: number; iy: number; iz: number }): boolean => {
        if (forced.length === 0) return false
        const size = (cube.size + 2 * pad) / (1 << cell.level)
        const minX = lat.originX + cell.ix * size
        const minY = lat.originY + cell.iy * size
        const minZ = lat.originZ + cell.iz * size
        for (const f of forced) {
            if (
                cell.level <= f.level &&
                f.x >= minX &&
                f.x <= minX + size &&
                f.y >= minY &&
                f.y <= minY + size &&
                f.z >= minZ &&
                f.z <= minZ + size
            ) {
                return true
            }
        }
        return false
    }

    let oct!: SfccOctree
    let points!: PointTable
    let faceResult!: ReturnType<typeof contourAllFaces>
    let cellResult!: ReturnType<typeof meshAllCells>
    let reRefineRounds = 0
    const maxDepth = Math.min(tuning.depthMax, lat.maxDepth)
    for (let round = 0; ; round++) {
        oct = buildOctree(tree, lat, {
            depthMin: tuning.depthMin,
            depthMax: maxDepth,
            enforceEdgeBalance: tuning.enforceEdgeBalance,
            needsSplit: (cell, sampleAt) => {
                // Feature criteria (i)/(ii) first; on pass they classify the cell.
                const cls = classifyCellFeatures(features, lat, cell.level, cell.ix, cell.iy, cell.iz, {
                    featureQueryInflate: tuning.featureQueryInflate,
                    tangentialEpsilon: tuning.tangentialEpsilon,
                })
                if (cls.split) return true
                if (forcedSplit(cell)) return true
                const probe = makeProbe(lat, tree, sampleAt, cell.level, cell.ix, cell.iy, cell.iz)
                if (cls.corner >= 0) {
                    // Corner cells are exempt from the per-stratum smoothness
                    // certificates: the corner IS the carrier singularity (cone
                    // apex normals never converge), and the wedge fan around the
                    // exact corner point needs no smooth-patch guarantees.
                    if (!hasCornerSignChange(probe)) return true
                    cell.featureCurve = cls.curve
                    cell.featureCorner = cls.corner
                    return false
                }
                // A feature in a cell whose corners don't see a sign change is
                // invisible to face contouring — keep splitting.
                if (cls.curve >= 0 && !hasCornerSignChange(probe)) return true
                if (needsSplitSmooth(tree, probe, { normalVariationCos: tuning.normalVariationCos })) return true
                cell.featureCurve = cls.curve
                cell.featureCorner = cls.corner
                return false
            },
            signal,
        })
        points = new PointTable()
        const rootTol = Math.min(tuning.edgeRootTolFraction * lat.step, tuning.surfaceTolMm * 0.1)
        faceResult = contourAllFaces(oct, tree, points, { rootTol, features }, signal)
        cellResult = meshAllCells(
            oct,
            faceResult.faces,
            tree,
            points,
            {
                surfaceTol: tuning.surfaceTolMm,
                interiorVertexMode: tuning.interiorVertexMode,
                projectMaxIters: tuning.projectMaxIters,
                curveChordTol: tuning.curveChordTolMm,
                maxPolylinePointsPerCell: tuning.maxPolylinePointsPerCell,
                features,
            },
            signal,
        )
        // Failed cells (broken loops) re-refine every round; fallback cells
        // (invisible feature arcs) get ONE forced round — measurements show
        // the grazing-face sliver configuration recurs at finer levels, so
        // further rounds only burn rebuilds without curing them.
        const suspects = [
            ...cellResult.failedCells,
            ...(round === 0 ? cellResult.fallbackCells : []),
        ].filter(c => c.level < maxDepth)
        if (round >= tuning.reRefineMaxRounds || suspects.length === 0) break
        reRefineRounds++
        const half = new Float64Array(3)
        for (const c of suspects) {
            const size = (cube.size + 2 * pad) / (1 << c.level)
            half[0] = lat.originX + (c.ix + 0.5) * size
            half[1] = lat.originY + (c.iy + 0.5) * size
            half[2] = lat.originZ + (c.iz + 0.5) * size
            forced.push({ x: half[0]!, y: half[1]!, z: half[2]!, level: c.level })
        }
    }

    // Face-segment audit: interior segments must be consumed once forward and
    // once reversed. (Faces adjacent to a failed cell legitimately miss a
    // consumption — those cells are already reported separately.)
    let faceAuditFailures = 0
    let faceCount = 0
    if (cellResult.failedCells.length === 0) {
        for (const perAxis of faceResult.faces) {
            for (const rec of perAxis.values()) {
                faceCount++
                for (let i = 0; i < rec.segments.length; i++) {
                    if (rec.consumedFwd[i] !== 1 || rec.consumedRev[i] !== 1) faceAuditFailures++
                }
            }
        }
    } else {
        for (const perAxis of faceResult.faces) faceCount += perAxis.size
    }

    const mesh = points.buildMesh(cellResult.tris)
    const manifold = checkManifold(mesh.tris, { checkVertexLinks: tuning.checkVertexLinks })

    const levelHistogram: number[] = []
    for (const cell of oct.leaves) {
        levelHistogram[cell.level] = (levelHistogram[cell.level] ?? 0) + 1
    }
    for (let l = 0; l < levelHistogram.length; l++) levelHistogram[l] = levelHistogram[l] ?? 0

    const stats: SfccStats = {
        leaves: oct.leaves.length,
        degenerateCells: oct.degenerateCells,
        levelHistogram,
        faces: faceCount,
        crossPoints: points.count,
        tris: mesh.tris.length / 3,
        failedCells: cellResult.failedCells.length,
        multiLoopCells: cellResult.multiLoopCells,
        multiRunFaces: faceResult.multiRunFaces,
        boundaryViolations: faceResult.boundaryViolations,
        faceAuditFailures,
        featureCurves: features.curves.length,
        edgeCells: cellResult.edgeCells,
        cornerCells: cellResult.cornerCells,
        featureCellFallbacks: cellResult.featureCellFallbacks,
        reRefineRounds,
    }
    const ok =
        manifold.ok && faceAuditFailures === 0 && cellResult.failedCells.length === 0 && faceResult.boundaryViolations === 0

    if (!ok && tuning.failurePolicy === "throw") {
        throw new Error(
            `SFCC certification failed: ${JSON.stringify({
                openEdges: manifold.openEdges,
                nonManifoldEdges: manifold.nonManifoldEdges,
                misorientedEdges: manifold.misorientedEdges,
                faceAuditFailures,
                failedCells: cellResult.failedCells.length,
                boundaryViolations: faceResult.boundaryViolations,
            })}`,
        )
    }

    // Debug overlays: failed-cell boxes always (cheap, empty when clean);
    // feature polylines only behind the knob.
    const failedCellBoxes = new Float32Array(cellResult.failedCells.length * 6)
    const boxScratch = new Float64Array(6)
    for (let i = 0; i < cellResult.failedCells.length; i++) {
        const c = cellResult.failedCells[i]!
        cellAabb(lat, c.level, c.ix, c.iy, c.iz, boxScratch)
        failedCellBoxes.set(boxScratch, i * 6)
    }
    let featurePolylines: Float32Array<ArrayBuffer> | undefined
    if (tuning.debugOutput) {
        const segs: number[] = []
        for (const curve of features.curves) {
            const poly = curve.indexPolyline
            for (let i = 0; i + 5 < poly.length; i += 3) {
                segs.push(poly[i]!, poly[i + 1]!, poly[i + 2]!, poly[i + 3]!, poly[i + 4]!, poly[i + 5]!)
            }
        }
        featurePolylines = new Float32Array(segs)
    }

    return { verts: mesh.verts, tris: mesh.tris, stats, manifold, ok, failedCellBoxes, featurePolylines }
}
