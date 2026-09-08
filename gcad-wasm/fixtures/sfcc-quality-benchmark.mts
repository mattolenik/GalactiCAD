/** Release WASM A/B benchmark. SFCC_BENCH_RUNS defaults to one warmup + five runs.
 * Run with node --import tsx gcad-wasm/fixtures/sfcc-quality-benchmark.mts.
 * SFCC_BENCH_SCENE=housing|bracket and SFCC_BENCH_MODE=baseline|triangulation|all
 * narrow investigation runs. Output includes digests, all samples and medians.
 */
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { load } from "js-yaml"
import { SceneInfo } from "../../src/scene/scene.mjs"
import { serializeSceneToBridgeJson } from "../../src/export/sfcc-rs/scene-bridge.mjs"
import { initSync, export_sfcc } from "../wasm/pkg/gcad_wasm.js"

const wasm = readFileSync(new URL("../wasm/pkg/gcad_wasm_bg.wasm", import.meta.url))
const instance = initSync({ module: wasm })
const digest = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex")
const configurations = {
    baseline: {},
    audit: { qualityAudit: true },
    triangulation: { qualityTriangulation: true },
    all: { qualityTriangulation: true, qualityRefinement: true, qualityRemeshing: true },
}
const fixtures: Array<{ name: string; cube: [number, number, number, number] }> = [
    { name: "housing", cube: [-23.5, 10.300000190734863 - 23.5, -23.5, 47] },
    { name: "bracket", cube: [-26.4, -21.1, -26.4, 52.8] },
]
const runs = Number(process.env.SFCC_BENCH_RUNS ?? 5)
if (!Number.isSafeInteger(runs) || runs < 1) throw new Error("SFCC_BENCH_RUNS must be positive")
console.log(JSON.stringify({ head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), wasmSha256: digest(wasm), backend: "release WASM", node: process.version }))
for (const fixture of fixtures) {
    if (process.env.SFCC_BENCH_SCENE && process.env.SFCC_BENCH_SCENE !== fixture.name) continue
    const { source } = load(readFileSync(new URL(`../../docs/manim/scenes/torture_${fixture.name}.yaml`, import.meta.url), "utf8")) as { source: string }
    const sceneJson = serializeSceneToBridgeJson(new SceneInfo(source).root)
    for (const [mode, tuning] of Object.entries(configurations)) {
        if (process.env.SFCC_BENCH_MODE && process.env.SFCC_BENCH_MODE !== mode) continue
        const timings: number[] = []
        for (let run = -1; run < runs; run++) {
            console.log(JSON.stringify({ starting: fixture.name, mode, run }))
            const start = performance.now()
            const mesh = export_sfcc(sceneJson, JSON.stringify(tuning), ...fixture.cube,
                (phase: number, label: string) => console.log(JSON.stringify({ phase, label, elapsedMs: performance.now() - start })))
            const ms = performance.now() - start
            try {
                if (run >= 0) timings.push(ms)
                const verts = mesh.verts, tris = mesh.tris
                let slivers = 0
                const angles: number[] = []
                for (let i = 0; i < tris.length; i += 3) {
                    const ids = [tris[i]!, tris[i + 1]!, tris[i + 2]!]
                    const edges = ids.map((a, k) => [0, 1, 2].map(j => verts[ids[(k + 1) % 3]! * 8 + j]! - verts[a * 8 + j]!))
                    const lengths = edges.map(e => Math.hypot(...e))
                    const u = edges[0]!, v = edges[1]!
                    const area2 = Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!)
                    const longest = Math.max(...lengths)
                    if (area2 / longest / longest < 0.02) slivers++
                    angles.push(Math.min(...lengths.map((_, k) => {
                        const a = edges[k]!, b = edges[(k + 2) % 3]!
                        return Math.atan2(area2, -a.reduce((s, x, j) => s + x * b[j]!, 0)) * 180 / Math.PI
                    })))
                }
                angles.sort((a, b) => a - b)
                console.log(JSON.stringify({ scene: fixture.name, sourceSha256: digest(source), sceneSha256: digest(sceneJson), tuning, cube: fixture.cube, mode, run, ms, triangles: tris.length / 3, slivers, p5Angle: angles[Math.floor((angles.length - 1) * 0.05)], outputBytes: verts.byteLength + tris.byteLength, wasmPagesBytes: instance.memory.buffer.byteLength, validation: JSON.parse(mesh.stats_json).validation }))
            } finally { mesh.free() }
        }
        timings.sort((a, b) => a - b)
        console.log(JSON.stringify({ scene: fixture.name, mode, measuredRuns: timings.length, medianMs: timings[Math.floor(timings.length / 2)], timings }))
    }
}
