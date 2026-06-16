import assert from "node:assert/strict"
import test from "node:test"

import { transpileCadSource } from "../../cad-transpile.mjs"
import { SceneInfo } from "../scene.mjs"

function build(src: string, bvhEnabled: boolean): SceneInfo {
    return new SceneInfo(transpileCadSource(src), { bvhEnabled })
}

function countSdBound(wgsl: string): number {
    return wgsl.match(/\bsdBound\(/g)?.length ?? 0
}

// A cutter wrapped in `translate` has codegenCost = primitive(1) + BVH_MIN_COST(8)
// = 9 >= 8 and computable bounds, so `#assignBvhBoundsSlots` gives it a BVH slot
// and `Subtract._compileGuarded` wraps it in an `sdBound` skip-guard.
const SRC_BOUNDED = "return subtract(box([20, 20, 20]), translate([5, 5, 5], sphere.radius(2)))"
// A bare-primitive cutter has codegenCost 1 < 8, so it gets no slot and the
// subtract falls back to the plain (un-guarded) difference.
const SRC_CHEAP = "return subtract(box([20, 20, 20]), sphere.radius(2).shift([5, 5, 5]))"

test("subtract wraps an expensive bounded cutter in an sdBound guard (all variants)", () => {
    const scene = build(SRC_BOUNDED, true)
    for (const wgsl of [scene.compileFast(), scene.compileForPreview(), scene.compileMid()]) {
        assert.equal(countSdBound(wgsl), 1, "exactly one cutter guard expected")
        // Guard threshold is the negated body distance (sharp cut, no radius).
        assert.match(wgsl, /if \(sdBound\(p, [^)]*\)[^<]*< \(-[^)]*\.d\)\) \{/)
        assert.match(wgsl, /opDifference/)
    }
})

test("subtract does NOT guard a cheap bare-primitive cutter", () => {
    const scene = build(SRC_CHEAP, true)
    for (const wgsl of [scene.compileFast(), scene.compileForPreview(), scene.compileMid()]) {
        assert.equal(countSdBound(wgsl), 0)
        assert.match(wgsl, /opDifference/)
    }
})

test("disabling BVH suppresses the subtract guard (plain difference)", () => {
    const off = build(SRC_BOUNDED, false)
    for (const wgsl of [off.compileFast(), off.compileForPreview(), off.compileMid()]) {
        assert.equal(countSdBound(wgsl), 0)
        assert.match(wgsl, /opDifference/)
    }
})

test("a subtract chain guards every bounded cutter independently", () => {
    // subtract(body, c1, c2) lowers to Subtract(Subtract(body, c1), c2); each
    // bounded cutter gets its own guard and mutates one shared accumulator.
    const scene = build(
        "return subtract(box([20, 20, 20]), translate([5, 5, 5], sphere.radius(2)), translate([-5, -5, -5], sphere.radius(2)))",
        true,
    )
    assert.equal(countSdBound(scene.compileFast()), 2)
})
