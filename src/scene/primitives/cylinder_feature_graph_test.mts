import assert from "node:assert/strict"
import test from "node:test"
import { cylinder } from "../scene.mjs"
import { RING_SEGMENTS } from "./cylinder.mjs"
import {
    FeatureGraphBuilder,
    FG_FLAG_ALIVE,
    FG_FLAG_CORNER,
    FG_FLAG_CREASE_ORIGINAL,
} from "../feature-graph-buffer.mjs"

test(`Cylinder.accumulateFeatureGraph: discretises both cap rings into ${RING_SEGMENTS}-segment polylines`, () => {
    const root = cylinder.radius(5)
    root.h = 10
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()

    // 2 caps × RING_SEGMENTS ring vertices each
    assert.equal(cpu.vertexCount, 2 * RING_SEGMENTS)
    // 2 caps × RING_SEGMENTS closing edges
    assert.equal(cpu.edgeCount, 2 * RING_SEGMENTS)
    // 2 cap loops (top + bottom)
    assert.equal(cpu.loopCount, 2)
})

test("Cylinder.accumulateFeatureGraph: ring vertices are crease (not corner) with 2 source-face normals", () => {
    const root = cylinder.radius(3)
    root.h = 2
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()

    for (let i = 0; i < cpu.vertexCount; i++) {
        const f = cpu.vertexFlags[i]!
        assert.ok((f & FG_FLAG_ALIVE) !== 0)
        assert.ok((f & FG_FLAG_CREASE_ORIGINAL) !== 0)
        assert.equal(f & FG_FLAG_CORNER, 0, "rings never get FG_FLAG_CORNER (smooth circle, no 0D feature)")
        assert.equal(cpu.vertexNormalCount[i]!, 2, "ring sample has cap normal + side normal")
    }
})

test("Cylinder.accumulateFeatureGraph: ring vertices lie on the circle at y = ±h", () => {
    const r = 5
    const h = 3
    const root = cylinder.radius(r)
    root.h = h
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()

    // Top ring is emitted first (indices 0..RING_SEGMENTS-1).
    for (let i = 0; i < RING_SEGMENTS; i++) {
        const x = cpu.vertexPositions[i * 3]!
        const y = cpu.vertexPositions[i * 3 + 1]!
        const z = cpu.vertexPositions[i * 3 + 2]!
        assert.ok(Math.abs(Math.sqrt(x * x + z * z) - r) < 1e-5, `vertex ${i} on radius ${r}`)
        assert.ok(Math.abs(y - h) < 1e-5, `vertex ${i} at top y = ${h}`)
    }
    // Bottom ring (indices RING_SEGMENTS..2*RING_SEGMENTS-1).
    for (let i = 0; i < RING_SEGMENTS; i++) {
        const slot = RING_SEGMENTS + i
        const y = cpu.vertexPositions[slot * 3 + 1]!
        assert.ok(Math.abs(y - (-h)) < 1e-5, `vertex ${slot} at bottom y = ${-h}`)
    }
})

test("Cylinder.accumulateFeatureGraph: filletTop suppresses top ring only", () => {
    const root = cylinder.radius(5)
    root.h = 5
    root.filletTop = 0.3
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()

    // Only bottom ring emitted.
    assert.equal(cpu.vertexCount, RING_SEGMENTS)
    assert.equal(cpu.edgeCount, RING_SEGMENTS)
    assert.equal(cpu.loopCount, 1)
    // All bottom vertices at y = -h
    for (let i = 0; i < RING_SEGMENTS; i++) {
        assert.ok(Math.abs(cpu.vertexPositions[i * 3 + 1]! - (-5)) < 1e-5)
    }
})

test("Cylinder.accumulateFeatureGraph: chamferBottom suppresses bottom ring only", () => {
    const root = cylinder.radius(5)
    root.h = 5
    root.chamferBottom = 0.2
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()

    // Only top ring emitted.
    assert.equal(cpu.vertexCount, RING_SEGMENTS)
    assert.equal(cpu.loopCount, 1)
    for (let i = 0; i < RING_SEGMENTS; i++) {
        assert.ok(Math.abs(cpu.vertexPositions[i * 3 + 1]! - 5) < 1e-5)
    }
})

test("Cylinder.accumulateFeatureGraph: both caps filleted → zero emission", () => {
    const root = cylinder.radius(5)
    root.h = 5
    root.filletTop = 0.3
    root.filletBottom = 0.3
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()
    assert.equal(cpu.vertexCount, 0)
})
