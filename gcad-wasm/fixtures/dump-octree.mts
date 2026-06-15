/**
 * Octree-parity dumper: builds the TS SFCC octree (compileCpuSdf + buildOctree,
 * driven by the smooth-only refinement criteria exactly as runSfccPipeline does
 * for featureless cells) on a sphere and a box, then dumps the LEAF-CELL set as
 * (level, ix, iy, iz) tuples plus the lattice/tuning the Rust side must match.
 *
 *   tsx gcad-wasm/fixtures/dump-octree.mts
 *
 * The Rust integration test (gcad-wasm/kernel/tests/octree_parity.rs) rebuilds
 * the same scene/lattice/tuning in Rust and asserts the leaf-cell set matches
 * (same count, same keys). Soft-skips if the fixture is absent.
 *
 * Format (little-endian) — one file per scene:
 *   u32  maxDepth
 *   u32  depthMin
 *   u32  depthMax
 *   u32  enforceEdgeBalance (0/1)
 *   f64  originX, originY, originZ, worldSize
 *   f64  normalVariationCos, blendNormalVariationCos
 *   u32  leafCount
 *   leafCount × { u32 level, i32 ix, i32 iy, i32 iz }
 *
 * NOTE: a NEW file — it does not touch the sibling-owned dump.mts / dump-sdf.mts.
 */
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { Sphere } from "../../src/scene/primitives/sphere.mjs"
import { Box } from "../../src/scene/primitives/box.mjs"
import type { Node } from "../../src/scene/base.mjs"
import { compileCpuSdf } from "../../src/export/sfcc/cpu-sdf.mjs"
import { makeLattice } from "../../src/export/sfcc/lattice.mjs"
import { buildOctree, type SfccCell } from "../../src/export/sfcc/octree.mjs"
import { makeProbe, needsSplitSmooth } from "../../src/export/sfcc/refine-criteria.mjs"

const here = dirname(fileURLToPath(import.meta.url))

// Octree/refine knobs for the parity scenes. Tighter normalVariationDeg than
// the default (18) so the sphere refines adaptively beyond depthMin and the
// worklist + 2:1 balance ripple are genuinely exercised. The Rust side reads
// these back from the fixture header — faithfulness = identical inputs.
const DEPTH_MIN = 4
const DEPTH_MAX = 7
const ENFORCE_EDGE_BALANCE = true
const NORMAL_VARIATION_DEG = 8
const BLEND_CURVATURE_DEG = 8
const BLEND_CURVATURE_REFINE = true

interface Cube {
    minX: number
    minY: number
    minZ: number
    size: number
}

function dumpOctree(name: string, scene: Node, cube: Cube): void {
    const tree = compileCpuSdf(scene)

    // Lattice exactly as runSfccPipeline sizes it: padding + deterministic
    // irrational jitter so rational geometry never coincides with the lattice.
    const pad = 2.0
    const step = (cube.size + 2 * pad) / (1 << DEPTH_MAX)
    const jx = (Math.SQRT2 - 1) * 0.25 * step
    const jy = (Math.sqrt(3) - 1) * 0.25 * step
    const jz = (Math.sqrt(5) - 2) * 0.25 * step
    const lat = makeLattice(
        DEPTH_MAX,
        cube.minX - pad - jx,
        cube.minY - pad - jy,
        cube.minZ - pad - jz,
        cube.size + 2 * pad,
    )

    const smoothCriteriaOpts = {
        normalVariationCos: Math.cos((NORMAL_VARIATION_DEG * Math.PI) / 180),
        blendNormalVariationCos: BLEND_CURVATURE_REFINE ? Math.cos((BLEND_CURVATURE_DEG * Math.PI) / 180) : 1,
    }

    const oct = buildOctree(tree, lat, {
        depthMin: DEPTH_MIN,
        depthMax: DEPTH_MAX,
        enforceEdgeBalance: ENFORCE_EDGE_BALANCE,
        // Smooth-only path: no features in scope for M3a, so this mirrors the
        // assemble pipeline's needsSplit for a cell with no feature classification.
        needsSplit: (cell: SfccCell, sampleAt) => {
            const probe = makeProbe(lat, tree, sampleAt, cell.level, cell.ix, cell.iy, cell.iz)
            return needsSplitSmooth(tree, probe, smoothCriteriaOpts)
        },
    })

    const leaves = oct.leaves
    const headerU32 = new Uint32Array([DEPTH_MAX, DEPTH_MIN, DEPTH_MAX, ENFORCE_EDGE_BALANCE ? 1 : 0])
    const headerF64 = new Float64Array([
        lat.originX,
        lat.originY,
        lat.originZ,
        lat.worldSize,
        smoothCriteriaOpts.normalVariationCos,
        smoothCriteriaOpts.blendNormalVariationCos,
    ])
    const countU32 = new Uint32Array([leaves.length])
    // Each leaf row: u32 level, i32 ix, i32 iy, i32 iz.
    const rows = new Int32Array(leaves.length * 4)
    for (let i = 0; i < leaves.length; i++) {
        const c = leaves[i]!
        rows[i * 4] = c.level
        rows[i * 4 + 1] = c.ix
        rows[i * 4 + 2] = c.iy
        rows[i * 4 + 3] = c.iz
    }

    const buf = Buffer.concat([
        Buffer.from(headerU32.buffer),
        Buffer.from(headerF64.buffer),
        Buffer.from(countU32.buffer),
        Buffer.from(rows.buffer),
    ])
    writeFileSync(join(here, `${name}.bin`), buf)

    const histo: Record<number, number> = {}
    for (const c of leaves) histo[c.level] = (histo[c.level] ?? 0) + 1
    console.log(`wrote ${name}.bin: ${leaves.length} leaves, per-level ${JSON.stringify(histo)}`)
}

// Sphere r=8 centered at the origin (smooth, refines adaptively).
dumpOctree("octree-sphere", new Sphere([0, 0, 0], { r: 8 }), { minX: -8, minY: -8, minZ: -8, size: 16 })
// Box half=6 centered at the origin (planar faces; uniform at depthMin minus empty culls).
dumpOctree("octree-box", new Box([0, 0, 0], [6, 6, 6]), { minX: -6, minY: -6, minZ: -6, size: 12 })
