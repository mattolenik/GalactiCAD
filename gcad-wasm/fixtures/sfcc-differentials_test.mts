import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { load } from "js-yaml"
import { SceneInfo } from "../../src/scene/scene.mjs"
import { serializeSceneToBridgeJson } from "../../src/export/sfcc-rs/scene-bridge.mjs"
import { initSync, audit_field_samples } from "../wasm/pkg/gcad_wasm.js"

initSync({ module: readFileSync(new URL("../wasm/pkg/gcad_wasm_bg.wasm", import.meta.url)) })

function check(scene: string, points: Float64Array): void {
    const samples = audit_field_samples(scene, points)
    assert.equal(samples.length, points.length / 3 * 15)
    for (let i = 0; i < samples.length; i += 15) {
        for (const offset of [7, 11]) {
            assert.ok(Math.abs(samples[i]! - samples[i + offset]!) < 1e-10,
                `paired scalar differs at point ${i / 15}: ${samples.slice(i, i + 15)}`)
            for (let k = 0; k < 3; k++) {
                assert.ok(Math.abs(samples[i + 4 + k]! - samples[i + offset + 1 + k]!) < 1e-10,
                    `paired normal differs at point ${i / 15}, axis ${k}: ${samples.slice(i, i + 15)}`)
            }
        }
    }
}

test("WASM paired differentials retain all blend modes, signs and nearest-pair selection", () => {
    const sphere = (x: number, y: number, r: number) => ({ kind: "sphere", pos: [x, y, 0], r })
    const inner = { kind: "union", mode: "round", radius: 0.7,
        children: [sphere(-0.8, 0, 2), sphere(0.6, 0.2, 1.7)] }
    const points = new Float64Array(Array.from({ length: 41 }, (_, i) =>
        [0.17 + i * 0.061, 0.31 + i * 0.023, 0.53]).flat())
    for (const mode of ["round", "soft", "chamfer", "stairs", "columns"]) {
        for (const kind of ["union", "intersect", "subtract"]) {
            for (const reverse of [false, true]) {
                const children = [inner, sphere(0, 0.6, 1.8)]
                if (reverse) children.reverse()
                const node = kind === "union"
                    ? { kind, mode, radius: 0.8, n: 3, children }
                    : { kind, mode, radius: 0.8, n: 3, lh: children[0], rh: children[1] }
                check(JSON.stringify(node), points)
                if (kind === "union") check(JSON.stringify({ ...node,
                    children: [...children, sphere(0.5, 0, 1.4)] }), points)
            }
        }
    }
})

test("WASM paired differentials agree on the serialized bracket and housing", () => {
    for (const name of ["torture_bracket", "torture_housing"]) {
        const { source } = load(readFileSync(new URL(`../../docs/manim/scenes/${name}.yaml`, import.meta.url), "utf8")) as { source: string }
        const scene = new SceneInfo(source)
        const points = new Float64Array(Array.from({ length: 81 }, (_, i) =>
            [-20.13 + i * 0.51, 0.21 + (i % 17) * 0.7, -12.17 + (i % 29) * 0.9]).flat())
        check(serializeSceneToBridgeJson(scene.root), points)
    }
})
