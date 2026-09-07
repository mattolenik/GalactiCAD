import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { SceneInfo } from "../../src/scene/scene.mjs"
import { serializeSceneToBridgeJson } from "../../src/export/sfcc-rs/scene-bridge.mjs"
import { initSync, audit_field_samples } from "../wasm/pkg/gcad_wasm.js"

initSync({ module: readFileSync(new URL("../wasm/pkg/gcad_wasm_bg.wasm", import.meta.url)) })

test("serialized compound and variadic cutters obey independent boolean algebra", () => {
    const cases: [string, (a: number, b: number, c: number) => number][] = [
        ["subtract(a, union(b,c))", (a,b,c) => Math.max(a,-Math.min(b,c))],
        ["subtract(a, intersect(b,c))", (a,b,c) => Math.max(a,-Math.max(b,c))],
        ["subtract(a, subtract(b,c))", (a,b,c) => Math.max(a,-Math.max(b,-c))],
        ["subtract(a,b,c)", (a,b,c) => Math.max(a,-b,-c)],
    ]
    for (const [expression, expected] of cases) {
        const scene = new SceneInfo(`let a=sphere.radius(5); let b=sphere.radius(1).shift(-2,0,0); let c=sphere.radius(1).shift(2,0,0); return ${expression}`)
        const points = new Float64Array(Array.from({ length: 141 }, (_, i) => [(i-70)*0.1,0.13,0.21]).flat())
        const samples = audit_field_samples(serializeSceneToBridgeJson(scene.root), points)
        for (let i=0; i<points.length/3; i++) {
            const x=points[i*3]!, y=points[i*3+1]!, z=points[i*3+2]!
            const value=expected(Math.hypot(x,y,z)-5, Math.hypot(x+2,y,z)-1, Math.hypot(x-2,y,z)-1)
            for (const offset of [0,7,11]) assert.ok(Math.abs(samples[i*15+offset]!-value)<1e-10, `${expression} at ${x}`)
        }
    }
})

test("transformed compound cutter keeps cavity orientation", () => {
    // Rotation about Z maps centers +/-2X to +/-2Y; scale and translation
    // put their world centers at (1,-2,0) and (1,6,0), both radius 2.
    const scene = new SceneInfo("return subtract(sphere.radius(20), scale([2,2,2], union(sphere.radius(1).shift(-2,0,0), sphere.radius(1).shift(2,0,0)).rotate(0,0,90)).shift(1,2,0))")
    const points = new Float64Array([3,-2,0, 3,6,0, 1,2,0])
    const samples = audit_field_samples(serializeSceneToBridgeJson(scene.root),points)
    for (let i=0; i<3; i++) {
        const x=points[i*3]!, y=points[i*3+1]!
        const expected=Math.max(Math.hypot(x,y)-20,-Math.min(Math.hypot(x-1,y+2)-2,Math.hypot(x-1,y-6)-2))
        assert.ok(Math.abs(samples[i*15]!-expected)<1e-6)
        if (i<2) assert.ok(samples[i*15+4]! < -0.999999, "cavity normal points toward cutter center")
    }
})
