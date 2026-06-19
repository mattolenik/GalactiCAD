/**
 * M4 LOFT feature-honoring full-mesh parity dumper + loftSide carrier parity.
 * Runs the TS SFCC `runSfccPipeline` (the FULL feature-aware pipeline) over a
 * 2-profile morph (square → rotated square, equal vertex counts — the SFCC v1
 * loft subset), and writes:
 *
 *   - mesh-loft.bin        the morphed solid: loftSide RULED carriers + cap
 *                          planes → cap-rim segments + (curved) vertical morph
 *                          curves + cap corners.
 *   - loft-carrier.txt     the loft leaf's side-stratum f/normal at a
 *                          deterministic point cloud (localizes the bug-prone
 *                          ruled-carrier port — Rust checks it < 1e-9).
 *
 *   tsx gcad-wasm/fixtures/dump-mesh-loft.mts
 *
 * `pos` is the f32-exact origin; every profile vertex / h is a plain-f64 literal,
 * so the Rust scene rebuilt from the same literals has bit-identical inputs
 * (cross-engine libm ULP drift only, absorbed by `pos_eps`).
 *
 * Mesh format (little-endian), the layout `parity::load_fixture` reads:
 *   [u32 vert_float_count][u32 tri_index_count][f32 × verts (stride 8)][u32 × tris]
 *
 * NOTE: NEW file — does not touch sibling dumpers/Makefile. *.bin / *.txt gitignored.
 */
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { Loft } from "../../src/scene/primitives/loft.mjs"
import { Polygon2D } from "../../src/scene/primitives/polygon2d.mjs"
import { compileCpuSdf } from "../../src/export/sfcc/cpu-sdf.mjs"
import { runSfccPipeline } from "../../src/export/sfcc/assemble.mjs"
import { DEFAULT_SFCC_TUNING } from "../../src/export/sfcc/sfcc-tuning.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const tuning = { ...DEFAULT_SFCC_TUNING, depthMin: 4, depthMax: 7 }
const cube = { minX: -3.5, minY: -3.5, minZ: -3.5, size: 7 }

// MUST stay identical to the literals in mesh_loft_parity.rs. Bottom square,
// top a SMALLER square rotated 45° (a genuinely curved / non-prismatic morph so
// the loftSide ruled carriers + curved morph-curve path are exercised).
const BOTTOM: [number, number][] = [[2, 2], [-2, 2], [-2, -2], [2, -2]]
const TOP: [number, number][] = [[1.4, 0], [0, 1.4], [-1.4, 0], [0, -1.4]]
const LOFT_H = 2

const scene = new Loft([0, 0, 0], [new Polygon2D(BOTTOM), new Polygon2D(TOP)], { h: LOFT_H })
const tree = compileCpuSdf(scene)
const r = runSfccPipeline(tree, cube, tuning)
const verts = Float32Array.from(r.verts)
const tris = Uint32Array.from(r.tris)
const header = new Uint32Array([verts.length, tris.length])
const buf = Buffer.concat([Buffer.from(header.buffer), Buffer.from(verts.buffer), Buffer.from(tris.buffer)])
writeFileSync(join(here, "mesh-loft.bin"), buf)
console.log(
    `wrote mesh-loft.bin: ${verts.length / 8} verts, ${tris.length / 3} tris` +
        ` (manifold ok=${r.manifold.ok} χ=[${r.manifold.eulerPerComponent.join(",")}]` +
        ` curves=${r.stats.featureCurves} edgeCells=${r.stats.edgeCells} cornerCells=${r.stats.cornerCells}` +
        ` fallbacks=${r.stats.featureCellFallbacks} failed=${r.stats.failedCells})`,
)

// loftSide carrier parity: the loft leaf's N side strata (one segment), f/normal
// at a deterministic point cloud around the solid.
function lcg(seed: number): () => number {
    let s = seed >>> 0
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0
        return s / 0x100000000
    }
}
const leaf = tree.leaves[0]!
const rnd = lcg(0x10f7)
const K = 64
const pts: [number, number, number][] = []
for (let i = 0; i < K; i++) {
    pts.push([(rnd() * 2 - 1) * 3, (rnd() * 2 - 1) * 3, (rnd() * 2 - 1) * 3])
}
const N = BOTTOM.length // one segment → side strata are indices 0..N-1
const lines: string[] = []
lines.push(`NPTS ${K}`)
for (const q of pts) lines.push(`${q[0]} ${q[1]} ${q[2]}`)
lines.push(`NSIDES ${N}`)
const n3 = new Float64Array(3)
for (let si = 0; si < N; si++) {
    const st = leaf.strata[si]!
    lines.push(`STRATUM ${st.kind}`)
    for (const q of pts) {
        const f = st.f(q[0], q[1], q[2])
        st.normal(q[0], q[1], q[2], n3)
        lines.push(`${f} ${n3[0]} ${n3[1]} ${n3[2]}`)
    }
}
writeFileSync(join(here, "loft-carrier.txt"), lines.join("\n") + "\n")
console.log(`wrote loft-carrier.txt: ${N} side strata × ${K} pts`)
