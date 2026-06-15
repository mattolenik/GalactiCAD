/**
 * M4 EXTRUDE feature-honoring full-mesh parity dumper + twistedSide carrier
 * parity. Runs the TS SFCC `runSfccPipeline` (the FULL feature-aware pipeline)
 * over an untwisted hex prism and a twisted square, and writes:
 *
 *   - mesh-extrude-hex.bin     untwisted: side PLANES + 2 cap planes → 12
 *                              vertical segment edges + 12 cap-rim segments.
 *   - mesh-extrude-twist.bin   twisted 60°: twistedSide RULED carriers + helical
 *                              traced vertical edges + rotated cap rims.
 *   - extrude-carrier.txt      the twisted scene's side-stratum f/normal at a
 *                              deterministic point cloud (localizes the bug-prone
 *                              ruled-carrier port — Rust checks it < 1e-9).
 *
 *   tsx gcad-wasm/fixtures/dump-mesh-extrude.mts
 *
 * `pos` is the f32-exact origin; every profile vertex / h / twist is a plain-f64
 * literal, so the Rust scene rebuilt from the same literals has bit-identical
 * inputs (cross-engine libm ULP drift only, absorbed by `pos_eps`).
 *
 * Mesh format (little-endian), the layout `parity::load_fixture` reads:
 *   [u32 vert_float_count][u32 tri_index_count][f32 × verts (stride 8)][u32 × tris]
 *
 * NOTE: NEW file — does not touch sibling dumpers/Makefile. *.bin / *.txt gitignored.
 */
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { Extrude } from "../../src/scene/primitives/extrude.mjs"
import { Polygon2D } from "../../src/scene/primitives/polygon2d.mjs"
import type { Node } from "../../src/scene/base.mjs"
import { compileCpuSdf } from "../../src/export/sfcc/cpu-sdf.mjs"
import { runSfccPipeline } from "../../src/export/sfcc/assemble.mjs"
import { DEFAULT_SFCC_TUNING } from "../../src/export/sfcc/sfcc-tuning.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const tuning = { ...DEFAULT_SFCC_TUNING, depthMin: 4, depthMax: 7 }

// MUST stay identical to the literals in mesh_extrude_parity.rs.
const HEX: [number, number][] = [[2, 0], [1, 1.5], [-1, 1.5], [-2, 0], [-1, -1.5], [1, -1.5]]
const HEX_H = 2
const SQUARE: [number, number][] = [[1.5, 1.5], [-1.5, 1.5], [-1.5, -1.5], [1.5, -1.5]]
const TWIST_H = 2.5
const TWIST_DEG = 60

function dumpMesh(name: string, scene: Node, cube: { minX: number; minY: number; minZ: number; size: number }): void {
    const tree = compileCpuSdf(scene)
    const r = runSfccPipeline(tree, cube, tuning)
    const verts = Float32Array.from(r.verts)
    const tris = Uint32Array.from(r.tris)
    const header = new Uint32Array([verts.length, tris.length])
    const buf = Buffer.concat([Buffer.from(header.buffer), Buffer.from(verts.buffer), Buffer.from(tris.buffer)])
    writeFileSync(join(here, `${name}.bin`), buf)
    console.log(
        `wrote ${name}.bin: ${verts.length / 8} verts, ${tris.length / 3} tris` +
            ` (manifold ok=${r.manifold.ok} χ=[${r.manifold.eulerPerComponent.join(",")}]` +
            ` curves=${r.stats.featureCurves} edgeCells=${r.stats.edgeCells} cornerCells=${r.stats.cornerCells}` +
            ` fallbacks=${r.stats.featureCellFallbacks} failed=${r.stats.failedCells})`,
    )
}

// (1) untwisted hex prism.
dumpMesh("mesh-extrude-hex", new Extrude([0, 0, 0], new Polygon2D(HEX), { h: HEX_H }), {
    minX: -3,
    minY: -3,
    minZ: -3,
    size: 6,
})

// (2) twisted square — twistedSide ruled carriers + helical edges.
const twistScene = new Extrude([0, 0, 0], new Polygon2D(SQUARE), { h: TWIST_H, t: TWIST_DEG })
dumpMesh("mesh-extrude-twist", twistScene, { minX: -3.5, minY: -3.5, minZ: -3.5, size: 7 })

// (3) twistedSide carrier parity: the twisted leaf's N side strata, f/normal at
// a deterministic point cloud around the solid.
function lcg(seed: number): () => number {
    let s = seed >>> 0
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0
        return s / 0x100000000
    }
}
const twistTree = compileCpuSdf(twistScene)
const leaf = twistTree.leaves[0]!
const rnd = lcg(0x7c1d)
const K = 64
const pts: [number, number, number][] = []
for (let i = 0; i < K; i++) {
    pts.push([(rnd() * 2 - 1) * 3, (rnd() * 2 - 1) * 3, (rnd() * 2 - 1) * 3])
}
const N = SQUARE.length // side strata are indices 0..N-1; caps N, N+1
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
writeFileSync(join(here, "extrude-carrier.txt"), lines.join("\n") + "\n")
console.log(`wrote extrude-carrier.txt: ${N} twistedSide strata × ${K} pts`)
