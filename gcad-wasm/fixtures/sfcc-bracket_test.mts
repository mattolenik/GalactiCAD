/** Exercise the actual animation scene through serialization and the WASM exporter. */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { load } from "js-yaml"
import { SceneInfo } from "../../src/scene/scene.mjs"
import { serializeSceneToBridgeJson } from "../../src/export/sfcc-rs/scene-bridge.mjs"
import { initSync, export_sfcc } from "../wasm/pkg/gcad_wasm.js"

initSync({ module: readFileSync(new URL("../wasm/pkg/gcad_wasm_bg.wasm", import.meta.url)) })

test("bracket mesh preserves displaced cap rims and intersecting rib seams", () => {
    const { source } = load(readFileSync(new URL("../../docs/manim/scenes/torture_bracket.yaml", import.meta.url), "utf8")) as { source: string }
    const scene = new SceneInfo(source)
    const result = export_sfcc(serializeSceneToBridgeJson(scene.root), "{}", -26.4, -21.1, -26.4, 52.8)
    try {
        const stats = JSON.parse(result.stats_json)
        for (const check of ["edgeIncidence", "vertexLinks", "faceSegments", "vertexResiduals"]) {
            assert.equal(stats.validation[check], "passed", check)
        }
        // Reference solutions of cap/side equality + chamfer zero, the sharp
        // continuation of a nested chamfer, and the native rib junctions.
        // These constants are not another implementation of the scene field.
        const points = [
            [12.34563989286355, 5, 6.8456398928635505],
            [-12.20434801732704, 5, 6.992666769587309],
            [-12.880145836270044, 6, 6.258266529775746],
            [12.8, 8, -6.349803146555017],
            [9.631632963518237, 4.703601671153187, 6.7993262593107895],
            [9.43751334525502, 4.682120384517046, 6.854848834953285],
            [-8.159496869903307, 4.200000000905028, 6.815423684661727],
            [4.894351432635451, 3.7, -2.3683542502653836],
            [-12, 5.8, 6.444199773305718],
        ]
        const verts = result.verts
        const tris = result.tris
        for (const p of points) {
            let gap = Infinity
            for (let i = 0; i < tris.length; i += 3) {
                for (let j = 0; j < 3; j++) {
                    const a = tris[i+j]! * 8, b = tris[i+(j+1)%3]! * 8
                    const d = [0,1,2].map(k => verts[b+k]! - verts[a+k]!)
                    const q = p.map((v,k) => v - verts[a+k]!)
                    const length2 = d.reduce((sum,v) => sum+v*v, 0)
                    const t = length2 ? Math.max(0,Math.min(1,q.reduce((sum,v,k) => sum+v*d[k]!,0)/length2)) : 0
                    gap = Math.min(gap,Math.hypot(...q.map((v,k) => v-t*d[k]!)))
                }
            }
            assert.ok(gap < 0.02, `bracket seam at ${p} misses mesh edges by ${gap} mm`)
        }
    } finally {
        result.free()
    }
})
