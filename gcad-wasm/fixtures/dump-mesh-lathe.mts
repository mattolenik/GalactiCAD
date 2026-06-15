/**
 * M4 LATHE feature-honoring full-mesh parity dumper. Runs the TS SFCC
 * `runSfccPipeline` (the FULL feature-aware pipeline) over a simple revolve and
 * writes the verts+tris mesh fixture the Rust kernel loads in
 * `kernel/tests/mesh_lathe_parity.rs`.
 *
 *   tsx gcad-wasm/fixtures/dump-mesh-lathe.mts
 *
 * Scene (rings + plane/cylinder/cone revolved edges):
 *   - lathe  Lathe(Polygon2D([[0,-2],[1.6,-2],[0.9,1.0],[1.2,2.0],[0,2]]))
 *            revolved about local Y → a stepped goblet-like solid with ring
 *            feature circles where the off-axis profile vertices turn.
 *
 * Cube + tuning are FIXED constants the Rust test reconstructs byte-for-byte:
 * the profile stays on one side of the axis (SFCC v1 lathe subset), `pos` is the
 * f32-exact origin, and every profile vertex is a plain-f64 literal — so the
 * Rust scene rebuilt from the same literals has bit-identical inputs (only
 * cross-engine libm ULP drift remains, absorbed by `pos_eps`).
 *
 * Format (little-endian), the SAME layout `parity::load_fixture` reads:
 *   [u32 vert_float_count][u32 tri_index_count][f32 × verts (stride 8)][u32 × tris]
 *
 * NOTE: a NEW file — it does not touch the sibling-owned dump*.mts / Makefile.
 * `mesh-lathe.bin` is gitignored (fixtures/*.bin).
 */
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { Lathe } from "../../src/scene/primitives/lathe.mjs"
import { Polygon2D } from "../../src/scene/primitives/polygon2d.mjs"
import { compileCpuSdf } from "../../src/export/sfcc/cpu-sdf.mjs"
import { runSfccPipeline } from "../../src/export/sfcc/assemble.mjs"
import { DEFAULT_SFCC_TUNING } from "../../src/export/sfcc/sfcc-tuning.mjs"

const here = dirname(fileURLToPath(import.meta.url))

const tuning = { ...DEFAULT_SFCC_TUNING, depthMin: 4, depthMax: 7 }
const cube = { minX: -3, minY: -3, minZ: -3, size: 6 }

// MUST stay identical to the literals in mesh_lathe_parity.rs.
const LATHE_PROFILE: [number, number][] = [[0, -2], [1.6, -2], [0.9, 1.0], [1.2, 2.0], [0, 2]]

const scene = new Lathe([0, 0, 0], new Polygon2D(LATHE_PROFILE))
const tree = compileCpuSdf(scene)
const r = runSfccPipeline(tree, cube, tuning)
const verts = Float32Array.from(r.verts)
const tris = Uint32Array.from(r.tris)
const header = new Uint32Array([verts.length, tris.length])
const buf = Buffer.concat([Buffer.from(header.buffer), Buffer.from(verts.buffer), Buffer.from(tris.buffer)])
writeFileSync(join(here, "mesh-lathe.bin"), buf)
console.log(
    `wrote mesh-lathe.bin: ${verts.length / 8} verts, ${tris.length / 3} tris` +
        ` (manifold ok=${r.manifold.ok} components=${r.manifold.components} χ=[${r.manifold.eulerPerComponent.join(",")}]` +
        ` curves=${r.stats.featureCurves} edgeCells=${r.stats.edgeCells} cornerCells=${r.stats.cornerCells}` +
        ` fallbacks=${r.stats.featureCellFallbacks} failed=${r.stats.failedCells})`,
)
