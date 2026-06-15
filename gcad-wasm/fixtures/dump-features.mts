/**
 * M4a parity fixture: TS `compileNativeFeatures` on a rotated+translated box →
 * the native feature curves + corners the Rust `compile_native_features` must
 * reproduce. New file (does not touch sibling-owned dumpers/Makefile). `*.bin`
 * gitignored; regenerate with `tsx gcad-wasm/fixtures/dump-features.mts`.
 *
 * Text format (whitespace-separated), so the Rust loader needs no deps:
 *   SIM r0..r8 t0 t1 t2 s
 *   POS px py pz
 *   HALF hx hy hz
 *   C id <s0> <s1>  p0x p0y p0z  p1x p1y p1z       (segment: adjacentStrata, endpoints)
 *   K id x y z n s0..s(n-1)                          (corner: pos, incident strata)
 */
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { Box } from "../../src/scene/primitives/box.mjs"
import { Rotate } from "../../src/scene/operators/rotate.mjs"
import { Translate } from "../../src/scene/operators/translate.mjs"
import { compileCpuSdf } from "../../src/export/sfcc/cpu-sdf.mjs"
import { compileNativeFeatures } from "../../src/export/sfcc/feature-set.mjs"

const here = dirname(fileURLToPath(import.meta.url))

const box = new Box([1, 2, 3], [0.5, 0.6, 0.7])
const tree = compileCpuSdf(new Translate([2, -1, 0.5], new Rotate([30, 40, 50], box)))
const leaf = tree.leaves[0]!
const sim = leaf.sim
const fs = compileNativeFeatures(tree)

const p = new Float64Array(3)
const lines: string[] = []
lines.push(`SIM ${Array.from(sim.r).join(" ")} ${Array.from(sim.t).join(" ")} ${sim.s}`)
lines.push(`POS ${box.pos.x} ${box.pos.y} ${box.pos.z}`)
lines.push(`HALF ${box.size.x} ${box.size.y} ${box.size.z}`)
for (const c of fs.curves) {
    c.pointAt(0, p)
    const a = `${p[0]} ${p[1]} ${p[2]}`
    c.pointAt(1, p)
    const b = `${p[0]} ${p[1]} ${p[2]}`
    lines.push(`C ${c.id} ${c.adjacentStrata[0]} ${c.adjacentStrata[1]} ${a} ${b}`)
}
for (const k of fs.corners) {
    lines.push(`K ${k.id} ${k.x} ${k.y} ${k.z} ${k.strata.length} ${k.strata.join(" ")}`)
}
writeFileSync(join(here, "features-box.txt"), lines.join("\n") + "\n")
console.log(`wrote features-box.txt: ${fs.curves.length} curves, ${fs.corners.length} corners`)
