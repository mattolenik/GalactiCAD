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
import { flipSliverTriangles } from "./sliver-flip.mjs"
import { createSfccPerf, makeCountingTree, nowMs, type SfccPerf } from "./sfcc-perf.mjs"

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
    /** Build-time perf breakdown, present only when tuning.profile is on. */
    perf?: SfccPerf
}

export interface SfccWorldCube {
    minX: number
    minY: number
    minZ: number
    size: number
}

/**
 * Remove coincident triangle pairs with opposite winding: a surface lens
 * contained in a cell interface gets triangulated identically by BOTH
 * incident cells (one from each side) — a zero-volume pancake whose every
 * edge is non-manifold. Each pancake pair contributes nothing geometrically;
 * removing both members restores its edges to two uses.
 */
function dropCoincidentTrianglePairs(tris: number[]): number[] {
    // Group triangles by their UNORDERED vertex triple. Key = the sorted triple
    // packed into one f64 when ids are small enough to stay collision-free
    // (base³ ≤ 2^53 ⇐ base ≤ 2^17), else a string fallback. The inline 3-sort
    // avoids the per-triangle array alloc + comparator closure the old
    // `[a,b,c].sort().join(",")` paid on every triangle (run twice per export).
    // Grouping is identical to the sorted-join, and `tris` is never mutated, so
    // the downstream orient()/pairing is byte-for-byte unchanged.
    let maxId = 0
    for (let t = 0; t < tris.length; t++) if (tris[t]! > maxId) maxId = tris[t]!
    const base = maxId + 1
    const packable = base <= 0x20000
    const byVerts = new Map<number | string, number[]>() // sorted vertex triple → tri offsets
    for (let t = 0; t < tris.length; t += 3) {
        let a = tris[t]!
        let b = tris[t + 1]!
        let c = tris[t + 2]!
        if (a > b) { const s = a; a = b; b = s }
        if (b > c) { const s = b; b = c; c = s }
        if (a > b) { const s = a; a = b; b = s }
        const k = packable ? (a * base + b) * base + c : `${a},${b},${c}`
        let list = byVerts.get(k)
        if (!list) {
            list = []
            byVerts.set(k, list)
        }
        list.push(t)
    }
    const drop = new Set<number>()
    for (const list of byVerts.values()) {
        if (list.length < 2) continue
        // Pair opposite orientations greedily; identical orientations are left
        // alone (they would be a different defect, not a pancake).
        const orient = (t: number): boolean => {
            // true iff (a,b,c) is an even permutation of the sorted order.
            const a = tris[t]!
            const b = tris[t + 1]!
            const c = tris[t + 2]!
            return (a < b && b < c) || (b < c && c < a) || (c < a && a < b)
        }
        const even: number[] = []
        const odd: number[] = []
        for (const t of list) (orient(t) ? even : odd).push(t)
        const pairs = Math.min(even.length, odd.length)
        for (let i = 0; i < pairs; i++) {
            drop.add(even[i]!)
            drop.add(odd[i]!)
        }
    }
    if (drop.size === 0) return tris
    const out: number[] = []
    for (let t = 0; t < tris.length; t += 3) {
        if (!drop.has(t)) out.push(tris[t]!, tris[t + 1]!, tris[t + 2]!)
    }
    return out
}

/**
 * Remove debris components. Two classes, both artifacts of sub-sample feature
 * recovery:
 * - micro: AABB diagonal below `maxDiag` (a few max-depth cells);
 * - feature-hugging tubes: small components (≤ `hugMaxVerts`) every vertex of
 *   which lies within `hugDist` of a feature curve — closed ribbons wrapped
 *   around crease lines whose connection to the main body is invisible at
 *   sampling resolution. Legitimate small parts away from features are
 *   untouched, and anything genuinely visible spans depthMin cells anyway.
 */
function dropDebrisComponents(
    points: PointTable,
    tris: number[],
    maxDiag: number,
    features: SfccFeatureSet,
    hugDist: number,
    hugMaxVerts: number,
): number[] {
    if (tris.length === 0) return tris
    const parent = new Map<number, number>()
    const find = (v: number): number => {
        let r = parent.get(v) ?? v
        if (r !== v) {
            r = find(r)
            parent.set(v, r)
        }
        return r
    }
    const union = (a: number, b: number): void => {
        const ra = find(a)
        const rb = find(b)
        if (ra !== rb) parent.set(ra, rb)
    }
    for (let t = 0; t < tris.length; t += 3) {
        union(tris[t]!, tris[t + 1]!)
        union(tris[t + 1]!, tris[t + 2]!)
    }
    const bounds = new Map<number, Float64Array>()
    const members = new Map<number, Set<number>>()
    for (let t = 0; t < tris.length; t++) {
        const v = tris[t]!
        const root = find(v)
        let b = bounds.get(root)
        if (!b) {
            b = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity])
            bounds.set(root, b)
            members.set(root, new Set())
        }
        members.get(root)!.add(v)
        const x = points.x(v)
        const y = points.y(v)
        const z = points.z(v)
        if (x < b[0]!) b[0] = x
        if (y < b[1]!) b[1] = y
        if (z < b[2]!) b[2] = z
        if (x > b[3]!) b[3] = x
        if (y > b[4]!) b[4] = y
        if (z > b[5]!) b[5] = z
    }
    // Never drop the dominant component.
    let mainRoot = -1
    let mainSize = -1
    for (const [root, verts] of members) {
        if (verts.size > mainSize) {
            mainSize = verts.size
            mainRoot = root
        }
    }
    const drop = new Set<number>()
    for (const [root, b] of bounds) {
        if (root === mainRoot) continue
        if (Math.hypot(b[3]! - b[0]!, b[4]! - b[1]!, b[5]! - b[2]!) < maxDiag) {
            drop.add(root)
            continue
        }
        const verts = members.get(root)!
        if (verts.size > hugMaxVerts) continue
        let hugging = true
        for (const v of verts) {
            const x = points.x(v)
            const y = points.y(v)
            const z = points.z(v)
            let near = false
            for (const cid of features.index.curvesInBox(x - hugDist, y - hugDist, z - hugDist, x + hugDist, y + hugDist, z + hugDist)) {
                if (features.curves[cid]!.project(x, y, z).dist <= hugDist) {
                    near = true
                    break
                }
            }
            if (!near) {
                hugging = false
                break
            }
        }
        if (hugging) drop.add(root)
    }
    if (drop.size === 0) return tris
    const out: number[] = []
    for (let t = 0; t < tris.length; t += 3) {
        if (!drop.has(find(tris[t]!))) out.push(tris[t]!, tris[t + 1]!, tris[t + 2]!)
    }
    return out
}

export function runSfccPipeline(
    treeArg: CpuSdfTree,
    cube: SfccWorldCube,
    tuning: SfccTuning,
    signal?: AbortSignal,
): SfccPipelineResult {
    // Opt-in profiling: wrap the tree so top-level f/grad/interval/owner calls
    // are counted, and arm the phase/sub-bucket timers. Off → no wrapping, the
    // timer reads below all short-circuit, default path stays as-is.
    const perf = tuning.profile ? createSfccPerf() : undefined
    const tStart = perf ? nowMs() : 0
    const tree = perf ? makeCountingTree(treeArg, perf) : treeArg

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
    const tFeat = perf ? nowMs() : 0
    const features: SfccFeatureSet = compileFeatureSet(tree, tolerances)
    if (perf) perf.featureCompileMs += nowMs() - tFeat

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

    const cornerClaimBox = new Float64Array(6)
    let oct!: SfccOctree
    let points!: PointTable
    let faceResult!: ReturnType<typeof contourAllFaces>
    let cellResult!: ReturnType<typeof meshAllCells>
    let reRefineRounds = 0
    const maxDepth = Math.min(tuning.depthMax, lat.maxDepth)
    // Loop-invariant criteria options (depend only on tuning): hoisted out of the
    // per-cell needsSplit callback so it allocates nothing per cell.
    const featureCriteriaOpts = {
        featureQueryInflate: tuning.featureQueryInflate,
        tangentialEpsilon: tuning.tangentialEpsilon,
    }
    const smoothCriteriaOpts = {
        normalVariationCos: Math.cos((tuning.normalVariationDeg * Math.PI) / 180),
        blendNormalVariationCos: tuning.blendCurvatureRefine
            ? Math.cos((tuning.blendCurvatureDeg * Math.PI) / 180)
            : 1, // ≥1 disables (iii-d)
    }
    for (let round = 0; ; round++) {
        const tOct = perf ? nowMs() : 0
        oct = buildOctree(tree, lat, {
            depthMin: tuning.depthMin,
            depthMax: maxDepth,
            enforceEdgeBalance: tuning.enforceEdgeBalance,
            needsSplit: (cell, sampleAt) => {
                // Feature criteria (i)/(ii) first; on pass they classify the cell.
                const tCls = perf ? nowMs() : 0
                const cls = classifyCellFeatures(features, lat, cell.level, cell.ix, cell.iy, cell.iz, featureCriteriaOpts, perf)
                if (perf) perf.classifyMs += nowMs() - tCls
                if (cls.split) {
                    // Classify even though we demand a split: at depthMax the
                    // cell CANNOT split, and an unclassified wedge cell
                    // smooth-meshes its wedge-wrapping loop — the interior
                    // fan then digs a multi-cell pit through the wedge (the
                    // doubly-crossed-face configuration at near-horizontal
                    // helix pitch: perFace > 1 ⇒ split:true with the curve id
                    // attached). Below depthMax the assignment is discarded
                    // with the split, so this is depthMax-only best effort.
                    cell.featureCurve = cls.curve
                    cell.featureCorner = cls.corner
                    if (cell.level >= maxDepth && cls.corner < 0) {
                        // Multi-curve cell that can never split apart: feature
                        // curves CONVERGE at corners, so the ring of cells
                        // around a corner cell can contain two curves at any
                        // depth (measured: helix + rim one cell below a twisted
                        // cap corner — meshing only one chops the other's wedge
                        // by ~half a cell, the corner V-notch). If a nearby
                        // corner exists, claim it: the corner fan tracks every
                        // incident curve's wedge to within the chord sag of the
                        // curve-to-apex distance (~1e-3 mm at one cell), since
                        // the curves meet AT the apex. Fanning from an apex
                        // slightly outside the cell is structurally fine —
                        // boundary segments are consumed identically.
                        const cellSize = (cube.size + 2 * pad) / (1 << cell.level)
                        cellAabb(lat, cell.level, cell.ix, cell.iy, cell.iz, cornerClaimBox)
                        const reach = cellSize * 1.25
                        let bestCorner = -1
                        let bestD = Infinity
                        for (const cornerId of features.index.cornersInBox(
                            cornerClaimBox[0]! - reach,
                            cornerClaimBox[1]! - reach,
                            cornerClaimBox[2]! - reach,
                            cornerClaimBox[3]! + reach,
                            cornerClaimBox[4]! + reach,
                            cornerClaimBox[5]! + reach,
                        )) {
                            const c = features.corners[cornerId]!
                            const dx = Math.max(cornerClaimBox[0]! - c.x, 0, c.x - cornerClaimBox[3]!)
                            const dy = Math.max(cornerClaimBox[1]! - c.y, 0, c.y - cornerClaimBox[4]!)
                            const dz = Math.max(cornerClaimBox[2]! - c.z, 0, c.z - cornerClaimBox[5]!)
                            const d = Math.hypot(dx, dy, dz)
                            if (d < bestD) {
                                bestD = d
                                bestCorner = cornerId
                            }
                        }
                        if (bestCorner >= 0 && bestD <= reach) cell.featureCorner = bestCorner
                    }
                    return true
                }
                if (forcedSplit(cell)) return true
                const tProbe = perf ? nowMs() : 0
                const probe = makeProbe(lat, tree, sampleAt, cell.level, cell.ix, cell.iy, cell.iz)
                if (perf) perf.smoothCritMs += nowMs() - tProbe
                if (cls.corner >= 0) {
                    // Corner cells are exempt from the per-stratum smoothness
                    // certificates (the corner IS the carrier singularity) AND
                    // from the sign-change gate: under twist, slim wedges at
                    // lattice-aligned corners can miss every sample at every
                    // level (the untwist displacement k·ρ·cell shears the
                    // sample row coherently, beating the jitter) — splitting
                    // would just degenerate the whole neighborhood (cone apex:
                    // the tip goes sub-sample and meshes nothing; measured as
                    // lost corner cells when splitting to depthMax). A corner
                    // cell with no visible crossings meshes nothing: the wedge
                    // tip is dropped at cell scale (closed mesh, reported via
                    // featureCellFallbacks).
                    cell.featureCurve = cls.curve
                    cell.featureCorner = cls.corner
                    return false
                }
                // A feature in a cell whose corners don't see a sign change is
                // invisible to face contouring — keep splitting. Classify
                // FIRST: at depthMax a true return cannot split (the cell is
                // kept as a degenerate leaf), and an unclassified leaf meshes
                // smooth, silently chopping the wedge at cell scale. The shear
                // configuration is scale-self-similar (untwist displacement
                // k·ρ·cell beats the jitter at every level), so without this
                // the chips shrink with depth but never disappear; with the
                // classification the pin + per-stratum recovery machinery
                // meshes the wedge from analytic crossings alone.
                cell.featureCurve = cls.curve
                cell.featureCorner = cls.corner
                if (cls.curve >= 0 && !hasCornerSignChange(probe)) return true
                const tSmooth = perf ? nowMs() : 0
                const needSmooth = needsSplitSmooth(tree, probe, smoothCriteriaOpts, perf)
                if (perf) perf.smoothCritMs += nowMs() - tSmooth
                if (needSmooth) return true
                return false
            },
            signal,
            perf,
        })
        if (perf) perf.octreeBuildMs += nowMs() - tOct
        points = new PointTable()
        const rootTol = Math.min(tuning.edgeRootTolFraction * lat.step, tuning.surfaceTolMm * 0.1)
        const tFace = perf ? nowMs() : 0
        faceResult = contourAllFaces(oct, tree, points, { rootTol, features, perf, recoveryCull: tuning.recoveryCull }, signal)
        if (perf) perf.faceContourMs += nowMs() - tFace
        const tCell = perf ? nowMs() : 0
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
        if (perf) perf.cellMeshMs += nowMs() - tCell
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

    const tAssemble = perf ? nowMs() : 0

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
    if (perf) perf.assembleAuditMs += nowMs() - tAssemble

    // Sub-resolution debris filter: recovered sliver arcs can close into tiny
    // satellite blobs that are genuinely disconnected at sampling resolution
    // (wedge fragments around feature lines whose connection to the main body
    // is invisible). Drop vertex-connected components whose extent is below a
    // few max-depth cells — geometry beneath export resolution by construction.
    // (Sub-buckets hoist the two coincident-pair passes into named temps so the
    // string-keyed pancake removal is timed apart from the union-find debris pass
    // — same call order/args, so byte-identical.)
    const tCoin1 = perf ? nowMs() : 0
    const deduped1 = dropCoincidentTrianglePairs(cellResult.tris)
    if (perf) perf.assembleCoincidentMs += nowMs() - tCoin1

    const tDebris = perf ? nowMs() : 0
    const filteredTris = dropDebrisComponents(points, deduped1, lat.step * 4, features, lat.step * 2, 600)
    if (perf) perf.assembleDebrisMs += nowMs() - tDebris

    // Long-thin slivers (no close vertex pairs — weld can't reach them):
    // shape-improving flips across their longest edges.
    const tCoin2 = perf ? nowMs() : 0
    const deduped2 = dropCoincidentTrianglePairs(filteredTris)
    if (perf) perf.assembleCoincidentMs += nowMs() - tCoin2

    const tSliver = perf ? nowMs() : 0
    const flipped = flipSliverTriangles(points, deduped2)
    if (perf) perf.assembleSliverMs += nowMs() - tSliver

    const tManifold = perf ? nowMs() : 0
    const mesh = points.buildMesh(flipped.tris)
    const manifold = checkManifold(mesh.tris, { checkVertexLinks: tuning.checkVertexLinks })
    if (perf) perf.assembleManifoldMs += nowMs() - tManifold

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

    if (perf) {
        perf.assembleMs += nowMs() - tAssemble
        perf.rounds = reRefineRounds
        perf.totalMs = nowMs() - tStart
    }

    return { verts: mesh.verts, tris: mesh.tris, stats, manifold, ok, failedCellBoxes, featurePolylines, perf }
}
