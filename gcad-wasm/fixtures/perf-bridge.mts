/**
 * M5 single-thread perf baseline: TS `runSfccPipeline` (V8) vs the Rust/WASM
 * `export_sfcc` (one thread), on the same scenes + tuning, under Node. This is
 * the apples-to-apples kernel-only timing (no GPU SDF render, no app) the M6
 * rayon speedup will be measured against.
 *
 *   tsx gcad-wasm/fixtures/perf-bridge.mts
 *
 * Prereqs: wasm-pack build --target web; the scenes are rebuilt here.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { Box } from "../../src/scene/primitives/box.mjs"
import { Sphere } from "../../src/scene/primitives/sphere.mjs"
import { Extrude } from "../../src/scene/primitives/extrude.mjs"
import { Polygon2D } from "../../src/scene/primitives/polygon2d.mjs"
import { Subtract } from "../../src/scene/operators/subtract.mjs"
import type { Node } from "../../src/scene/base.mjs"
import { compileCpuSdf } from "../../src/export/sfcc/cpu-sdf.mjs"
import { runSfccPipeline } from "../../src/export/sfcc/assemble.mjs"
import { DEFAULT_SFCC_TUNING } from "../../src/export/sfcc/sfcc-tuning.mjs"
import { serializeSceneToBridgeJson } from "../../src/export/sfcc-rs/scene-bridge.mjs"
import initWasm, { export_sfcc } from "../wasm/pkg/gcad_wasm.js"

const here = dirname(fileURLToPath(import.meta.url))
const tuning = { ...DEFAULT_SFCC_TUNING, depthMin: 4, depthMax: 7 }
const TUNING_JSON = JSON.stringify(tuning)

interface Cube {
    minX: number
    minY: number
    minZ: number
    size: number
}
interface Scene {
    name: string
    node: Node
    cube: Cube
}

const SCENES: Scene[] = [
    { name: "box", node: new Box([0, 0, 0], [10, 10, 10]), cube: { minX: -10, minY: -10, minZ: -10, size: 20 } },
    {
        name: "box-minus-sphere",
        node: new Subtract(new Box([0, 0, 0], [10, 10, 10]), new Sphere([5, 5, 5], { r: 6 })),
        cube: { minX: -10, minY: -10, minZ: -10, size: 20 },
    },
    {
        name: "extrude-twist",
        node: new Extrude([0, 0, 0], new Polygon2D([[1.5, 1.5], [-1.5, 1.5], [-1.5, -1.5], [1.5, -1.5]]), { h: 2.5, t: 60 }),
        cube: { minX: -3.5, minY: -3.5, minZ: -3.5, size: 7 },
    },
]

const REPS = 5
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

async function main(): Promise<void> {
    await initWasm({ module_or_path: readFileSync(join(here, "../wasm/pkg/gcad_wasm_bg.wasm")) })

    console.log(`single-thread SFCC export — median of ${REPS} reps (ms), depthMin4/Max7\n`)
    console.log(`${"scene".padEnd(18)} ${"TS (V8)".padStart(10)} ${"Rust/WASM".padStart(10)}   ratio`)
    for (const sc of SCENES) {
        const ts: number[] = []
        for (let i = 0; i < REPS; i++) {
            const tree = compileCpuSdf(sc.node)
            const t0 = performance.now()
            runSfccPipeline(tree, sc.cube, tuning)
            ts.push(performance.now() - t0)
        }
        const sceneJson = serializeSceneToBridgeJson(sc.node)
        const rs: number[] = []
        for (let i = 0; i < REPS; i++) {
            const t0 = performance.now()
            const r = export_sfcc(sceneJson, TUNING_JSON, sc.cube.minX, sc.cube.minY, sc.cube.minZ, sc.cube.size)
            // Touch the buffers so the copy-out cost is included.
            void r.verts.length
            void r.tris.length
            rs.push(performance.now() - t0)
            r.free()
        }
        const tsMed = median(ts)
        const rsMed = median(rs)
        console.log(
            `${sc.name.padEnd(18)} ${tsMed.toFixed(1).padStart(10)} ${rsMed.toFixed(1).padStart(10)}   ${(tsMed / rsMed).toFixed(2)}×`,
        )
    }
}

await main()
