// Regenerate fixtures/bowl-taper.json (the bowl sample as kernel bridge JSON,
// consumed by kernel/tests/bowl_exact.rs) and optionally run the browser's wasm
// SFCC export on it for a bit-exact native-vs-wasm comparison.
//   node --import tsx gcad-wasm/fixtures/dump-bowl-taper.mts [depthMax] [--no-export]
import { readFileSync, writeFileSync } from "node:fs"
import { SceneInfo } from "../../src/scene/scene.mjs"
import { serializeSceneToBridgeJson } from "../../src/export/sfcc-rs/scene-bridge.mjs"
import { initSync, export_sfcc } from "../wasm/pkg/gcad_wasm.js"

const here = new URL(".", import.meta.url)
const source = readFileSync(new URL("../../src/scene/samples/bowl.gcad", here), "utf8")
const json = serializeSceneToBridgeJson(new SceneInfo(source).root)
const out = new URL("bowl-taper.json", here)
writeFileSync(out, json)
console.log("wrote", out.pathname, json.length, "bytes")
if (process.argv.includes("--no-export")) process.exit(0)
const depthMax = Number(process.argv[2] ?? 8)
initSync({ module: readFileSync(new URL("../wasm/pkg/gcad_wasm_bg.wasm", here)) })
// The app's cube for this scene: padded sampled bounds, side 183, centre (0, 75, 0).
const t0 = performance.now()
const mesh = export_sfcc(json, JSON.stringify({ depthMax }), -91.5, 75 - 91.5, -91.5, 183, undefined, undefined)
const stats = JSON.parse(mesh.stats_json)
const m = stats.manifold ?? stats
console.log(JSON.stringify({ depthMax, ms: Math.round(performance.now() - t0), tris: mesh.tris.length / 3, degenerateCells: stats.degenerateCells, components: m.components, euler: m.euler ?? stats.euler, manifoldOk: m.manifoldOk ?? stats.manifoldOk }))
