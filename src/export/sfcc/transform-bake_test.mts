import assert from "node:assert/strict"
import test from "node:test"
import {
    applyPoint,
    composeSimilarity,
    identitySimilarity,
    invApplyPoint,
    invRotateVector,
    rotateVector,
    similarityFromRotationWgslFwd,
    similarityFromTranslation,
    similarityFromUniformScale,
} from "./transform-bake.mjs"
import { Box } from "../../scene/primitives/box.mjs"
import { Rotate } from "../../scene/operators/rotate.mjs"
import { Translate } from "../../scene/operators/translate.mjs"
import { Scale } from "../../scene/operators/scale.mjs"
import { FeatureGraphBuilder } from "../../scene/feature-graph-buffer.mjs"
import { applyTransformsCpu } from "../../feature-graph/feature-graph-stages.mjs"
import { compileCpuSdf } from "./cpu-sdf.mjs"
import type { Node } from "../../scene/base.mjs"

function rotationSim(rx: number, ry: number, rz: number) {
    const rot = new Rotate([rx, ry, rz], new Box([0, 0, 0], [1, 1, 1]))
    return similarityFromRotationWgslFwd(rot.getWgslMatrices().fwd)
}

test("apply/invApply roundtrip on a composite chain", () => {
    const sim = composeSimilarity(
        composeSimilarity(similarityFromTranslation(3, -2, 5), rotationSim(30, 40, 50)),
        similarityFromUniformScale(2.5),
    )
    const p = new Float64Array(3)
    const q = new Float64Array(3)
    for (const [x, y, z] of [
        [0, 0, 0],
        [1, 2, 3],
        [-7.5, 0.25, 11],
    ] as const) {
        applyPoint(sim, x, y, z, p)
        invApplyPoint(sim, p[0]!, p[1]!, p[2]!, q)
        assert.ok(Math.abs(q[0]! - x) < 1e-12 && Math.abs(q[1]! - y) < 1e-12 && Math.abs(q[2]! - z) < 1e-12)
    }
})

test("rotation preserves lengths and rotateVector/invRotateVector invert", () => {
    const sim = rotationSim(13, -77, 138)
    const v = new Float64Array(3)
    rotateVector(sim, 1, 2, 3, v)
    assert.ok(Math.abs(Math.hypot(v[0]!, v[1]!, v[2]!) - Math.hypot(1, 2, 3)) < 1e-12)
    const back = new Float64Array(3)
    invRotateVector(sim, v[0]!, v[1]!, v[2]!, back)
    assert.ok(Math.abs(back[0]! - 1) < 1e-12 && Math.abs(back[1]! - 2) < 1e-12 && Math.abs(back[2]! - 3) < 1e-12)
})

test("composition order: child transform applies first", () => {
    // translate(1,0,0) ∘ scale(2): local x=1 → scaled 2 → translated 3.
    const sim = composeSimilarity(similarityFromTranslation(1, 0, 0), similarityFromUniformScale(2))
    const p = new Float64Array(3)
    applyPoint(sim, 1, 0, 0, p)
    assert.deepEqual([p[0], p[1], p[2]], [3, 0, 0])
})

/**
 * THE rotation-convention regression (the repo's historical transpose bug):
 * bake the same scene through (a) the FeatureGraph transform stack
 * (`accumulateFeatureGraph` + `applyTransformsCpu`, the canonical path) and
 * (b) the SFCC similarity bake — world positions must agree.
 */
test("similarity bake matches the FeatureGraph transform path (rotate)", () => {
    const mkScene = (): Node => {
        const box = new Box([1, 2, 3], [0.5, 0.6, 0.7])
        box.id = 3
        const rot = new Rotate([30, 40, 50], box)
        rot.id = 2
        return rot
    }
    const scene = mkScene()
    const builder = new FeatureGraphBuilder()
    scene.accumulateFeatureGraph(builder)
    const cpu = builder.finish()
    const world = applyTransformsCpu(cpu)
    assert.equal(cpu.vertexCount, 8)

    const rot = scene as Rotate
    const sim = similarityFromRotationWgslFwd(rot.getWgslMatrices().fwd)
    const p = new Float64Array(3)
    for (let i = 0; i < cpu.vertexCount; i++) {
        const lx = cpu.vertexPositions[i * 3]!
        const ly = cpu.vertexPositions[i * 3 + 1]!
        const lz = cpu.vertexPositions[i * 3 + 2]!
        applyPoint(sim, lx, ly, lz, p)
        for (let a = 0; a < 3; a++) {
            assert.ok(
                Math.abs(p[a]! - world.positions[i * 3 + a]!) < 1e-5,
                `vertex ${i} axis ${a}: sfcc ${p[a]} vs fg ${world.positions[i * 3 + a]}`,
            )
        }
    }
})

test("similarity bake matches the FeatureGraph path (translate ∘ rotate ∘ scale ∘ rotate)", () => {
    const box = new Box([0.5, -0.25, 1], [0.4, 0.3, 0.2])
    box.id = 9
    const chain = new Translate([2, 1, -3], new Rotate([15, 30, 45], new Scale([1.5, 1.5, 1.5], new Rotate([0, 0, 60], box))))

    const builder = new FeatureGraphBuilder()
    chain.accumulateFeatureGraph(builder)
    const cpu = builder.finish()
    const world = applyTransformsCpu(cpu)
    assert.equal(cpu.vertexCount, 8)

    const tree = compileCpuSdf(chain)
    assert.equal(tree.leaves.length, 1)
    const sim = tree.leaves[0]!.sim
    const p = new Float64Array(3)
    for (let i = 0; i < cpu.vertexCount; i++) {
        applyPoint(sim, cpu.vertexPositions[i * 3]!, cpu.vertexPositions[i * 3 + 1]!, cpu.vertexPositions[i * 3 + 2]!, p)
        for (let a = 0; a < 3; a++) {
            assert.ok(
                Math.abs(p[a]! - world.positions[i * 3 + a]!) < 1e-4,
                `vertex ${i} axis ${a}: sfcc ${p[a]} vs fg ${world.positions[i * 3 + a]}`,
            )
        }
        // Independent cross-check: the evaluator must vanish at every transformed
        // corner. Tolerance is f32-emission-limited (FG corners are Float32Array
        // sums of f32 params); a convention error would be O(1).
        const fv = tree.f(p[0]!, p[1]!, p[2]!)
        assert.ok(Math.abs(fv) < 1e-5, `f at corner ${i} = ${fv}`)
    }
})
