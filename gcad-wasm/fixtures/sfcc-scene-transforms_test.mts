import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { SceneInfo } from "../../src/scene/scene.mjs"
import { serializeSceneToBridgeJson } from "../../src/export/sfcc-rs/scene-bridge.mjs"
import { initSync, audit_field_samples } from "../wasm/pkg/gcad_wasm.js"

initSync({ module: readFileSync(new URL("../wasm/pkg/gcad_wasm_bg.wasm", import.meta.url)) })

const profile = "polygon2d([-2,-1], [2,-1], [1,2], [-1,1])"
const primitives = [
    "box(2,1,3)",
    "cylinder.radius(1.25).height(3)",
    "cone.radius(1.5).height(3)",
    `extrude.profile(${profile}).height(3).twist(17)`,
    `loft.sections(${profile}, polygon2d([-1,-1], [2,-1], [1,1], [-1,2])).height(3)`,
    "lathe.profile(polygon2d([0,-1], [2,-1], [1,2], [0,2]))",
]
const points = new Float64Array([
    4.7, -1.1, 1.4, 2.3, -3.2, 0.6, 3.4, 0.7, -0.8,
    1.8, -0.3, 3.2, 3.1, -1.9, 1.2, 5.2, -4.1, 2.7,
])

function sample(source: string, positions = points): Float64Array {
    return audit_field_samples(serializeSceneToBridgeJson(new SceneInfo(`return ${source}`).root), positions)
}

test("SFCC primitive-local rotations match wrapper rotations about the primitive position", () => {
    for (const primitive of primitives) {
        const local = sample(`${primitive}.rotate(23,-31,47).shift(3,-2,1)`)
        const wrapped = sample(`translate([3,-2,1], rotate([23,-31,47], ${primitive}))`)
        for (let i = 0; i < local.length; i++) {
            assert.ok(Math.abs(local[i]! - wrapped[i]!) < 2e-6,
                `${primitive}, sample component ${i}: ${local[i]} != ${wrapped[i]}`)
        }
    }
})

test("SFCC preserves primitive rotation pivots and fluent transform order", () => {
    // A quarter turn about Z swaps the box's X/Y extents. Local rotation leaves
    // its position (3,-2,1) fixed; rotation after shift moves it to (2,3,1).
    for (const [source, center] of [
        ["box(2,1,3).rotate(0,0,90).shift(3,-2,1)", [3,-2,1]],
        ["box(2,1,3).shift(3,-2,1).rotate(0,0,90)", [2,3,1]],
    ] as const) {
        const probes = new Float64Array([center[0] + 1.5, center[1], center[2], center[0], center[1] + 1.5, center[2]])
        const values = sample(source, probes)
        assert.ok(Math.abs(values[0]! - 0.5) < 1e-12, source)
        assert.ok(Math.abs(values[15]! + 0.5) < 1e-12, source)
        assert.ok(values[4]! > 0.999999 && values[20]! > 0.999999, source)
    }
    const local = sample("box(2,1,3).rotate(23,-31,47).rotate(-13,29,7).shift(3,-2,1)")
    const wrapped = sample("translate([3,-2,1], rotate([23,-31,47], rotate([-13,29,7], box(2,1,3))))")
    for (let i = 0; i < local.length; i++) assert.ok(Math.abs(local[i]! - wrapped[i]!) < 2e-6, `composed rotation, ${i}`)
})

test("SFCC uniform scales preserve smooth boolean geometry and nested cutter fields", () => {
    const positions = new Float64Array(Array.from({ length: 31 }, (_, i) => [0.13 + i * 0.071, 0.37, 0.59]).flat())
    const a = "sphere.radius(1.5).shift(-0.6,0,0)"
    const b = "sphere.radius(1.25).shift(0.6,0.2,0)"
    const sources = [
        ...["round", "chamfer", "stairs", "columns"].flatMap(mode =>
            ["union", "intersect", "subtract"].map(op => `${op}(${a},${b}).${mode}(0.7)`)),
        `union(${a},${b}).soft(0.7)`,
        `subtract(sphere.radius(3), union(${a},${b}).round(0.7))`,
        `intersect(union(${a},${b}).soft(0.7), sphere.radius(2)).chamfer(0.3)`,
        `union(scale([2,2,2], union(${a},${b}).round(0.7)).shift(0.5,-0.25,0.75), sphere.radius(1)).soft(0.4)`,
    ]
    for (const source of sources) {
        const unscaled = sample(source, positions)
        for (const scale of [0.25, 2, 4]) {
            const scaled = sample(`scale([${scale},${scale},${scale}], ${source})`, positions.map(v => v * scale))
            for (let i = 0; i < unscaled.length; i++) {
                const expected = unscaled[i]! * ([0, 7, 11].includes(i % 15) ? scale : 1)
                assert.ok(Math.abs(scaled[i]! - expected) < 1e-9,
                    `${source}, scale=${scale}, component=${i}: ${scaled[i]} != ${expected}`)
            }
        }
    }
    // soft(d,d,0.8)=d-0.2; the scaled cutter and outer sphere have radii 0.6
    // and 1.25. This checks absolute geometry as well as scale equivariance.
    const radii = [0.1, 0.5, 0.65, 0.9, 1.3, 2]
    const shell = sample("scale([0.25,0.25,0.25], subtract(sphere.radius(5), scale([2,2,2], union(sphere.radius(1),sphere.radius(1)).soft(0.8))))",
        new Float64Array(radii.flatMap(r => [r, 0, 0])))
    radii.forEach((r, i) => assert.ok(Math.abs(shell[i * 15]! - Math.max(r - 1.25, 0.6 - r)) < 1e-12))
})
