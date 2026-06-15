/**
 * M4c-2 FEATURE-HONORING full-mesh parity dumper. Runs the TS SFCC
 * `runSfccPipeline` (the FULL feature-aware pipeline — native curves + traced
 * boolean seams + feature-aware refine/contour/cell-mesh) over `box` and
 * `box − sphere`, then writes verts+tris mesh fixtures the Rust kernel loads in
 * `kernel/tests/mesh_feat_parity.rs`.
 *
 *   tsx gcad-wasm/fixtures/dump-mesh-feat.mts
 *
 * Scenes (sharp edges + boolean seam — the M4c-2 deliverable):
 *   - box        Box([0,0,0],[10,10,10]) — 12 sharp edges + 8 corners, no seam.
 *   - box-minus-sphere  Subtract(Box([0,0,0],[10,10,10]), Sphere([5,5,5],{r:6}))
 *                       — 12 surviving edges + 8 corners + 3 traced seam circles.
 *
 * Cube + tuning are FIXED constants the Rust test reconstructs byte-for-byte:
 * the cube is the tight bounding cube of the box (min −10, size 20); the tuning
 * is DEFAULT_SFCC_TUNING with depthMin 4 / depthMax 7 (modest, keeps the leaf
 * count tractable while genuinely exercising the feature-honoring paths). The
 * Rust kernel derives the same lattice + tolerances from those inputs.
 *
 * Format (little-endian), the SAME layout `parity::load_fixture` reads:
 *   [u32 vert_float_count][u32 tri_index_count][f32 × verts (stride 8)][u32 × tris]
 *
 * NOTE: a NEW file — it does not touch the sibling-owned dump*.mts / Makefile.
 * `mesh-feat-*.bin` is gitignored (fixtures/*.bin).
 */
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { Box } from "../../src/scene/primitives/box.mjs"
import { Sphere } from "../../src/scene/primitives/sphere.mjs"
import { Subtract } from "../../src/scene/operators/subtract.mjs"
import type { Node } from "../../src/scene/base.mjs"
import { compileCpuSdf } from "../../src/export/sfcc/cpu-sdf.mjs"
import { runSfccPipeline } from "../../src/export/sfcc/assemble.mjs"
import { DEFAULT_SFCC_TUNING } from "../../src/export/sfcc/sfcc-tuning.mjs"

const here = dirname(fileURLToPath(import.meta.url))

// Modest depths (as in dump-octree-feat.mts) so the leaf count stays tractable
// while the feature-aware path is genuinely exercised near edges + seam circles.
const tuning = { ...DEFAULT_SFCC_TUNING, depthMin: 4, depthMax: 7 }

// Tight bounding cube of the box half=10 at the origin (min −10, size 20). The
// box dominates the box−sphere AABB, so both scenes use the identical cube.
const cube = { minX: -10, minY: -10, minZ: -10, size: 20 }

function dump(name: string, scene: Node): void {
    const tree = compileCpuSdf(scene)
    const r = runSfccPipeline(tree, cube, tuning)
    const verts = Float32Array.from(r.verts)
    const tris = Uint32Array.from(r.tris)
    const header = new Uint32Array([verts.length, tris.length])
    const buf = Buffer.concat([Buffer.from(header.buffer), Buffer.from(verts.buffer), Buffer.from(tris.buffer)])
    writeFileSync(join(here, `${name}.bin`), buf)
    console.log(
        `wrote ${name}.bin: ${verts.length / 8} verts, ${tris.length / 3} tris` +
            ` (manifold ok=${r.manifold.ok} components=${r.manifold.components} χ=[${r.manifold.eulerPerComponent.join(",")}]` +
            ` curves=${r.stats.featureCurves} edgeCells=${r.stats.edgeCells} cornerCells=${r.stats.cornerCells}` +
            ` fallbacks=${r.stats.featureCellFallbacks} failed=${r.stats.failedCells})`,
    )
}

// (1) box — 12 sharp edges + 8 corners, no boolean seam.
dump("mesh-feat-box", new Box([0, 0, 0], [10, 10, 10]))

// (2) box − sphere — surviving edges + corners + 3 traced seam circles.
dump("mesh-feat-box-minus-sphere", new Subtract(new Box([0, 0, 0], [10, 10, 10]), new Sphere([5, 5, 5], { r: 6 })))
