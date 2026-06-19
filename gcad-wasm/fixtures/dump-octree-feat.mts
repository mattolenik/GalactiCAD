/**
 * M4c-1 FEATURE-AWARE octree parity dumper. Builds the TS SFCC octree with the
 * FULL feature-aware refinement criteria — exactly as `runSfccPipeline`'s
 * `needsSplit` does (round 0; the re-refine `forcedSplit` markers are empty
 * there) — on `box` and `box − sphere`, then dumps the leaf-cell set
 * (level, ix, iy, iz) PLUS each leaf's featureCurve / featureCorner tags, along
 * with the lattice + tuning + tolerances the Rust side must match byte-for-byte.
 *
 *   tsx gcad-wasm/fixtures/dump-octree-feat.mts
 *
 * The Rust test (gcad-wasm/kernel/tests/octree_feat_parity.rs) rebuilds the same
 * scene/lattice/tuning/feature-set in Rust, runs `build_octree_feature_aware`,
 * and asserts the leaf-cell SET + feature tags match EXACTLY. This octree is
 * finer near edges/seams than the smooth-only octree-parity one — that is the
 * whole point of the feature-aware path. Soft-skips if the fixture is absent.
 *
 * NOTE: a NEW file — it does not touch the sibling-owned dumpers / Makefile.
 * `octree-feat-*.bin` is gitignored (fixtures/*.bin).
 *
 * Format (little-endian) — one file per scene:
 *   u32  maxDepth, depthMin, depthMax, enforceEdgeBalance(0/1)
 *   f64  originX, originY, originZ, worldSize
 *   f64  normalVariationCos, blendNormalVariationCos
 *   f64  featureQueryInflate, tangentialEpsilon
 *   TOL  10 f64 + 1 u32 (surfaceTol maxChordError curveEps probeDelta
 *        minDihedralCos nativeCreaseCos minTangencySin cornerMergeTol
 *        seedCellSize | maxTraceSteps as u32)
 *   u32  leafCount
 *   leafCount × { u32 level, i32 ix, i32 iy, i32 iz, i32 featureCurve, i32 featureCorner }
 */
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { Box } from "../../src/scene/primitives/box.mjs"
import { Sphere } from "../../src/scene/primitives/sphere.mjs"
import { Subtract } from "../../src/scene/operators/subtract.mjs"
import type { Node } from "../../src/scene/base.mjs"
import { compileCpuSdf } from "../../src/export/sfcc/cpu-sdf.mjs"
import { makeLattice, cellAabb, type SfccLattice } from "../../src/export/sfcc/lattice.mjs"
import { buildOctree, type SfccCell } from "../../src/export/sfcc/octree.mjs"
import {
    classifyCellFeatures,
    hasCornerSignChange,
    makeProbe,
    needsSplitSmooth,
} from "../../src/export/sfcc/refine-criteria.mjs"
import { compileFeatureSet } from "../../src/export/sfcc/feature-set.mjs"
import { resolveTolerances } from "../../src/export/sfcc/tolerances.mjs"
import { DEFAULT_SFCC_TUNING } from "../../src/export/sfcc/sfcc-tuning.mjs"

const here = dirname(fileURLToPath(import.meta.url))

// Octree/refine knobs for the parity scenes. depthMin/Max kept modest so the
// leaf count stays tractable while the feature-aware path is genuinely
// exercised near the box edges + seam circles. The Rust side reads these back
// from the fixture header — faithfulness = identical inputs.
const DEPTH_MIN = 4
const DEPTH_MAX = 7
const ENFORCE_EDGE_BALANCE = true
const NORMAL_VARIATION_DEG = DEFAULT_SFCC_TUNING.normalVariationDeg
const BLEND_CURVATURE_DEG = DEFAULT_SFCC_TUNING.blendCurvatureDeg
const BLEND_CURVATURE_REFINE = DEFAULT_SFCC_TUNING.blendCurvatureRefine
const FEATURE_QUERY_INFLATE = DEFAULT_SFCC_TUNING.featureQueryInflate
const TANGENTIAL_EPSILON = DEFAULT_SFCC_TUNING.tangentialEpsilon

function dumpOctree(name: string, scene: Node): void {
    const tree = compileCpuSdf(scene)

    // World cube from the leaves' AABBs (a tight bounding cube), exactly as
    // dump-seams.mts derives it — so the scene diagonal feeding resolveTolerances
    // matches the Rust rebuild.
    const lo = [Infinity, Infinity, Infinity]
    const hi = [-Infinity, -Infinity, -Infinity]
    for (const leaf of tree.leaves) {
        for (let a = 0; a < 3; a++) {
            lo[a] = Math.min(lo[a]!, leaf.aabb[a]!)
            hi[a] = Math.max(hi[a]!, leaf.aabb[a + 3]!)
        }
    }
    const cube = {
        minX: lo[0]!,
        minY: lo[1]!,
        minZ: lo[2]!,
        size: Math.max(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!),
    }
    const sceneDiag = Math.hypot(cube.size, cube.size, cube.size)
    const tol = resolveTolerances(DEFAULT_SFCC_TUNING, sceneDiag)

    // Lattice exactly as runSfccPipeline sizes it: padding + deterministic
    // irrational jitter so rational geometry never coincides with the lattice.
    const pad = DEFAULT_SFCC_TUNING.boundsPaddingMm
    const step = (cube.size + 2 * pad) / (1 << DEPTH_MAX)
    const jx = (Math.SQRT2 - 1) * 0.25 * step
    const jy = (Math.sqrt(3) - 1) * 0.25 * step
    const jz = (Math.sqrt(5) - 2) * 0.25 * step
    const lat: SfccLattice = makeLattice(
        DEPTH_MAX,
        cube.minX - pad - jx,
        cube.minY - pad - jy,
        cube.minZ - pad - jz,
        cube.size + 2 * pad,
    )

    const features = compileFeatureSet(tree, tol)

    const featureCriteriaOpts = {
        featureQueryInflate: FEATURE_QUERY_INFLATE,
        tangentialEpsilon: TANGENTIAL_EPSILON,
    }
    const smoothCriteriaOpts = {
        normalVariationCos: Math.cos((NORMAL_VARIATION_DEG * Math.PI) / 180),
        blendNormalVariationCos: BLEND_CURVATURE_REFINE ? Math.cos((BLEND_CURVATURE_DEG * Math.PI) / 180) : 1,
    }
    const maxDepth = Math.min(DEPTH_MAX, lat.maxDepth)
    const cornerClaimBox = new Float64Array(6)

    // The full feature-aware needsSplit, mirroring runSfccPipeline (round 0:
    // no forcedSplit markers).
    const needsSplit = (cell: SfccCell, sampleAt: (gx: number, gy: number, gz: number) => number): boolean => {
        const cls = classifyCellFeatures(features, lat, cell.level, cell.ix, cell.iy, cell.iz, featureCriteriaOpts)
        if (cls.split) {
            cell.featureCurve = cls.curve
            cell.featureCorner = cls.corner
            if (cell.level >= maxDepth && cls.corner < 0) {
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
        const probe = makeProbe(lat, tree, sampleAt, cell.level, cell.ix, cell.iy, cell.iz)
        if (cls.corner >= 0) {
            cell.featureCurve = cls.curve
            cell.featureCorner = cls.corner
            return false
        }
        cell.featureCurve = cls.curve
        cell.featureCorner = cls.corner
        if (cls.curve >= 0 && !hasCornerSignChange(probe)) return true
        return needsSplitSmooth(tree, probe, smoothCriteriaOpts)
    }

    const oct = buildOctree(tree, lat, {
        depthMin: DEPTH_MIN,
        depthMax: maxDepth,
        enforceEdgeBalance: ENFORCE_EDGE_BALANCE,
        needsSplit,
    })

    const leaves = oct.leaves
    const headerU32 = new Uint32Array([DEPTH_MAX, DEPTH_MIN, maxDepth, ENFORCE_EDGE_BALANCE ? 1 : 0])
    const headerF64 = new Float64Array([
        lat.originX,
        lat.originY,
        lat.originZ,
        lat.worldSize,
        smoothCriteriaOpts.normalVariationCos,
        smoothCriteriaOpts.blendNormalVariationCos,
        FEATURE_QUERY_INFLATE,
        TANGENTIAL_EPSILON,
        // Resolved tolerances (so the Rust side uses byte-identical knobs).
        tol.surfaceTol,
        tol.maxChordError,
        tol.curveEps,
        tol.probeDelta,
        tol.minDihedralCos,
        tol.nativeCreaseCos,
        tol.minTangencySin,
        tol.cornerMergeTol,
        tol.seedCellSize,
    ])
    const tolU32 = new Uint32Array([tol.maxTraceSteps])
    const countU32 = new Uint32Array([leaves.length])
    // Each leaf row: u32 level, i32 ix, i32 iy, i32 iz, i32 featureCurve, i32 featureCorner.
    const rows = new Int32Array(leaves.length * 6)
    for (let i = 0; i < leaves.length; i++) {
        const c = leaves[i]!
        rows[i * 6] = c.level
        rows[i * 6 + 1] = c.ix
        rows[i * 6 + 2] = c.iy
        rows[i * 6 + 3] = c.iz
        rows[i * 6 + 4] = c.featureCurve
        rows[i * 6 + 5] = c.featureCorner
    }

    const buf = Buffer.concat([
        Buffer.from(headerU32.buffer),
        Buffer.from(headerF64.buffer),
        Buffer.from(tolU32.buffer),
        Buffer.from(countU32.buffer),
        Buffer.from(rows.buffer),
    ])
    writeFileSync(join(here, `${name}.bin`), buf)

    const histo: Record<number, number> = {}
    let tagged = 0
    let corners = 0
    for (const c of leaves) {
        histo[c.level] = (histo[c.level] ?? 0) + 1
        if (c.featureCurve >= 0) tagged++
        if (c.featureCorner >= 0) corners++
    }
    console.log(
        `wrote ${name}.bin: ${leaves.length} leaves (per-level ${JSON.stringify(histo)}), ` +
            `${features.curves.length} curves, ${tagged} curve-tagged, ${corners} corner-tagged`,
    )
}

// Box half=10 centered at origin (the seam-parity solid before subtraction).
dumpOctree("octree-feat-box", new Box([0, 0, 0], [10, 10, 10]))
// Box − Sphere: the seam-parity scene (12 edges + 8 corners + 3 traced seam circles).
dumpOctree("octree-feat-box-minus-sphere", new Subtract(new Box([0, 0, 0], [10, 10, 10]), new Sphere([5, 5, 5], { r: 6 })))
