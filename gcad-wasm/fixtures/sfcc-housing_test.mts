/** The video housing's bore must meet the chamfer-generated flange surface. */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { load } from "js-yaml"
import { SceneInfo } from "../../src/scene/scene.mjs"
import { serializeSceneToBridgeJson } from "../../src/export/sfcc-rs/scene-bridge.mjs"
import { initSync, export_sfcc } from "../wasm/pkg/gcad_wasm.js"

initSync({ module: readFileSync(new URL("../wasm/pkg/gcad_wasm_bg.wasm", import.meta.url)) })

test("housing bore follows the circular rim on the chamfer-generated flange", () => {
    const { source } = load(readFileSync(new URL("../../docs/manim/scenes/torture_housing.yaml", import.meta.url), "utf8")) as { source: string }
    const scene = new SceneInfo(source)
    const result = export_sfcc(serializeSceneToBridgeJson(scene.root), "{}", -23.5, 10.300000190734863 - 23.5, -23.5, 47)
    try {
        const stats = JSON.parse(result.stats_json)
        assert.equal(stats.validation.edgeIncidence, "passed")
        assert.equal(stats.validation.vertexLinks, "passed")
        assert.equal(stats.validation.faceSegments, "passed")
        const verts = result.verts
        const tris = result.tris
        const rim = new Set<number>()
        for (let i = 0; i < verts.length; i += 8) {
            if (Math.abs(verts[i + 2]! - 19.75) < 1e-4 && Math.abs(Math.hypot(verts[i]!, verts[i + 1]!) - 5.5) < 1e-4) rim.add(i / 8)
        }
        assert.ok(rim.size > 50, "the blend/cutter seam must be sampled explicitly")
        const angles = [...rim].map(i => Math.atan2(verts[i * 8 + 1]!, verts[i * 8]!)).sort((a, b) => a - b)
        for (let i = 0; i < angles.length; i++) {
            const gap = i + 1 < angles.length ? angles[i + 1]! - angles[i]! : angles[0]! + 2 * Math.PI - angles[i]!
            assert.ok(5.5 * (1 - Math.cos(gap / 2)) <= 0.02, "no missing arc of the rim")
        }
        let samples = 0
        let maxError = 0
        for (let t = 0; t < tris.length; t += 3) {
            const ids = [tris[t]!, tris[t + 1]!, tris[t + 2]!]
            // In this neighborhood the exact surface is the cylindrical bore
            // meeting the shifted chamfer plane. Check triangle interiors too:
            // the old mesh's vertices were on-surface while triangles bridged it.
            if (!ids.every(i => verts[i * 8 + 2]! > 19.1 && Math.hypot(verts[i * 8]!, verts[i * 8 + 1]!) < 6.2)) continue
            for (const weights of [[1/3, 1/3, 1/3], [0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5]]) {
                const p = [0, 1, 2].map(k => ids.reduce((sum, id, j) => sum + weights[j]! * verts[id * 8 + k]!, 0))
                const error = Math.abs(Math.max(Math.SQRT2 * (p[2]! - 19.75), 5.5 - Math.hypot(p[0]!, p[1]!)))
                maxError = Math.max(maxError, error)
                samples++
            }
        }
        assert.ok(samples > 100, "exercise the pipe/flange neighborhood")
        assert.ok(maxError < 0.02, `rim triangle error ${maxError} exceeds chord tolerance`)
    } finally { result.free() }
})
