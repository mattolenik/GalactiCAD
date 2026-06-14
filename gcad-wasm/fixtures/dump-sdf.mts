/**
 * SDF-sample parity dumper: evaluates the TS CPU SDF oracle (`compileCpuSdf().f`)
 * at a deterministic point set and writes (points, f) the Rust kernel checks in
 * `gcad-wasm/kernel/tests/sdf_parity.rs`. Companion to dump.mts (mesh fixtures).
 *
 *   tsx gcad-wasm/fixtures/dump-sdf.mts
 *
 * Format (little-endian): [u32 count][f64 × 3·count points][f64 × count f].
 */
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { Sphere } from "../../src/scene/primitives/sphere.mjs"
import { Box } from "../../src/scene/primitives/box.mjs"
import { Subtract } from "../../src/scene/operators/subtract.mjs"
import type { Node } from "../../src/scene/base.mjs"
import { compileCpuSdf } from "../../src/export/sfcc/cpu-sdf.mjs"

const here = dirname(fileURLToPath(import.meta.url))

/** Deterministic LCG (Math.random is unavailable in this environment). */
function lcg(seed: number): () => number {
    let s = seed >>> 0
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0
        return s / 0x100000000
    }
}

function dumpSdf(name: string, scene: Node, half: number, count: number): void {
    const tree = compileCpuSdf(scene)
    const rnd = lcg(0x5eed)
    const pts = new Float64Array(count * 3)
    const fs = new Float64Array(count)
    for (let i = 0; i < count; i++) {
        const x = (rnd() * 2 - 1) * half
        const y = (rnd() * 2 - 1) * half
        const z = (rnd() * 2 - 1) * half
        pts[i * 3] = x
        pts[i * 3 + 1] = y
        pts[i * 3 + 2] = z
        fs[i] = tree.f(x, y, z)
    }
    const header = new Uint32Array([count])
    const buf = Buffer.concat([Buffer.from(header.buffer), Buffer.from(pts.buffer), Buffer.from(fs.buffer)])
    writeFileSync(join(here, `${name}.bin`), buf)
    console.log(`wrote ${name}.bin: ${count} samples`)
}

// Untransformed scenes only (identity similarity) so the Rust tree is built
// trivially-equivalent. Hard CSG — unambiguous operator semantics.
dumpSdf("sdf-sphere", new Sphere([0.13, -0.21, 0.07], { r: 8 }), 12, 500)
dumpSdf("sdf-box-minus-sphere", new Subtract(new Box([0, 0, 0], [10, 10, 10]), new Sphere([5, 5, 5], { r: 6 })), 14, 500)
