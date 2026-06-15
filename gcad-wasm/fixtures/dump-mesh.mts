/**
 * Mesh-parity dumper (M3c): runs the TS SFCC `runSfccPipeline` over the SMOOTH
 * acceptance scenes and writes verts+tris mesh fixtures the Rust kernel loads in
 * `kernel/tests/mesh_parity.rs`.
 *
 *   tsx gcad-wasm/fixtures/dump-mesh.mts
 *
 * Smooth-only corpus (no native features / no boolean seam — those are M4, and
 * the smooth Rust mesh would legitimately differ on a box or box−sphere):
 *   - sphere  (r=8 at the origin) — the canonical smooth case.
 *   - smooth-union of two overlapping spheres (a HARD union whose seam SFCC
 *     contours as smooth geometry for now) — closed manifold, χ=2.
 *
 * Format (little-endian), the SAME layout `parity::load_fixture` already reads:
 *   [u32 vert_float_count][u32 tri_index_count][f32 × verts (stride 8)][u32 × tris]
 *
 * The Rust integration test rebuilds the identical scenes + tuning, runs the
 * Rust smooth pipeline, and asserts (a) topology+winding match exactly with a
 * small position eps absorbing V8↔Rust libm ULP drift in the interior-vertex
 * projection, (b) closed 2-manifold with χ=2 per component, (c) the Rust
 * double-run is bit-identical. Soft-skips if absent.
 *
 * NOTE: a NEW file — it does not touch the sibling-owned dump*.mts / Makefile.
 */
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { Sphere } from "../../src/scene/primitives/sphere.mjs"
import { Union } from "../../src/scene/operators/union.mjs"
import type { Node } from "../../src/scene/base.mjs"
import { compileCpuSdf } from "../../src/export/sfcc/cpu-sdf.mjs"
import { runSfccPipeline } from "../../src/export/sfcc/assemble.mjs"
import { DEFAULT_SFCC_TUNING } from "../../src/export/sfcc/sfcc-tuning.mjs"

const here = dirname(fileURLToPath(import.meta.url))

// Same tuning as sfcc-pipeline_test.mts: depthMin 5, depthMax 8, no padding so
// the lattice origin/jitter math is identical and trivially reproduced in Rust.
const tuning = { ...DEFAULT_SFCC_TUNING, depthMin: 5, depthMax: 8, boundsPaddingMm: 0 }

function dump(name: string, scene: Node, size: number): void {
    const tree = compileCpuSdf(scene)
    const r = runSfccPipeline(tree, { minX: -size / 2, minY: -size / 2, minZ: -size / 2, size }, tuning)
    // Copy into fresh (non-shared) typed arrays so .buffer is a plain ArrayBuffer.
    const verts = Float32Array.from(r.verts)
    const tris = Uint32Array.from(r.tris)
    const header = new Uint32Array([verts.length, tris.length])
    const buf = Buffer.concat([Buffer.from(header.buffer), Buffer.from(verts.buffer), Buffer.from(tris.buffer)])
    writeFileSync(join(here, `${name}.bin`), buf)
    console.log(
        `wrote ${name}.bin: ${verts.length / 8} verts, ${tris.length / 3} tris` +
            ` (manifold ok=${r.manifold.ok} components=${r.manifold.components} χ=[${r.manifold.eulerPerComponent.join(",")}])`,
    )
}

// (1) sphere r=8 at the origin — the canonical smooth case (matches the Rust
//     test scene; centered at the origin, not the jittered dump.mts sphere).
dump("mesh-sphere", new Sphere([0, 0, 0], { r: 8 }), 24)

// (2) overlapping smooth union — the sfcc-pipeline_test "overlapping smooth
//     union" scene exactly (two r=3 spheres, hard Union, size 16).
dump(
    "mesh-smooth-union",
    new Union([new Sphere([-1.4, 0.2, 0.1], { r: 3 }), new Sphere([1.5, -0.3, 0.2], { r: 3 })]),
    16,
)
