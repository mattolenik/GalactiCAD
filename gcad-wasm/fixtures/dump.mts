/**
 * Parity-fixture dumper: runs the TypeScript SFCC oracle over a scene corpus and
 * writes binary mesh fixtures the Rust kernel loads in `parity::tests`
 * (`gcad-wasm/kernel/src/parity.rs`). Re-run when the oracle legitimately changes.
 *
 *   tsx gcad-wasm/fixtures/dump.mts
 *
 * Format (little-endian): [u32 vert_float_count][u32 tri_index_count]
 *                         [f32 × verts (stride 8)][u32 × tris].
 */
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { Sphere } from "../../src/scene/primitives/sphere.mjs"
import { Box } from "../../src/scene/primitives/box.mjs"
import { Subtract } from "../../src/scene/operators/subtract.mjs"
import type { Node } from "../../src/scene/base.mjs"
import { compileCpuSdf } from "../../src/export/sfcc/cpu-sdf.mjs"
import { runSfccPipeline } from "../../src/export/sfcc/assemble.mjs"
import { DEFAULT_SFCC_TUNING } from "../../src/export/sfcc/sfcc-tuning.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const tuning = { ...DEFAULT_SFCC_TUNING, depthMin: 5, depthMax: 8, boundsPaddingMm: 0 }

function dump(name: string, scene: Node, size: number): void {
    const tree = compileCpuSdf(scene)
    const r = runSfccPipeline(tree, { minX: -size / 2, minY: -size / 2, minZ: -size / 2, size }, tuning)
    // Copy into fresh (non-shared) typed arrays so .buffer is a plain ArrayBuffer.
    const verts = Float32Array.from(r.verts)
    const tris = Uint32Array.from(r.tris)
    const header = new Uint32Array([verts.length, tris.length])
    const buf = Buffer.concat([
        Buffer.from(header.buffer),
        Buffer.from(verts.buffer),
        Buffer.from(tris.buffer),
    ])
    writeFileSync(join(here, `${name}.bin`), buf)
    console.log(`wrote ${name}.bin: ${verts.length / 8} verts, ${tris.length / 3} tris`)
}

dump("sphere", new Sphere([0.13, -0.21, 0.07], { r: 8 }), 24)
dump("box-minus-sphere", new Subtract(new Box([0, 0, 0], [10, 10, 10]), new Sphere([5, 5, 5], { r: 6 })), 28)
