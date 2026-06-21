import assert from "node:assert/strict"
import test from "node:test"
import { loft, polygon2d } from "../scene.mjs"
import {
    FeatureGraphBuilder,
    FG_FLAG_CORNER,
    FG_FLAG_CREASE_ORIGINAL,
} from "../feature-graph-buffer.mjs"

const TRIANGLE: [number, number][] = [
    [0, 0],
    [10, 0],
    [5, 8],
]

const SQUARE: [number, number][] = [
    [-3, -3],
    [3, -3],
    [3, 3],
    [-3, 3],
]

test("Loft.accumulateFeatureGraph: 2 same-topology profiles → top + bot caps + connecting edges", () => {
    const root = loft.sections(polygon2d(...TRIANGLE), polygon2d(...TRIANGLE))
    root.h = 5
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()

    // 3 top corners + 3 bottom corners = 6 vertices
    assert.equal(cpu.vertexCount, 6, "3 top + 3 bottom corners (no intermediates with M=2)")
    // 3 top cap edges + 3 bottom cap edges + 3 vertical side edges (all sharp)
    assert.equal(cpu.edgeCount, 9, "3 + 3 + 3")
    assert.equal(cpu.loopCount, 2, "top + bottom cap loops")
})

test("Loft.accumulateFeatureGraph: 3 same-topology profiles → intermediate vertices on side edges", () => {
    const root = loft.sections(polygon2d(...TRIANGLE), polygon2d(...TRIANGLE), polygon2d(...TRIANGLE))
    root.h = 5
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()

    // 3 top + 3 bottom corners + 3 sides × 1 intermediate (mid profile vertex k) = 9 vertices.
    // (Chain length = M-2 intermediates per side, here M=3 → 1 intermediate.)
    assert.equal(cpu.vertexCount, 9)
    // 3 top cap + 3 bot cap + 3 sides × 2 chain edges = 12 edges.
    assert.equal(cpu.edgeCount, 12)
    assert.equal(cpu.loopCount, 2)
})

test("Loft.accumulateFeatureGraph: different vertex counts → caps + correspondence side creases", () => {
    // Concentric square (4) → triangle (3): sameTopology = false, so the side
    // creases come from the angular-correspondence tracer (Stage 1b) rather than
    // the 1:1 vertex chains.
    const SQ: [number, number][] = [
        [-2, -2],
        [2, -2],
        [2, 2],
        [-2, 2],
    ]
    const TRI: [number, number][] = [
        [0, 2.4],
        [-2.1, -1.2],
        [2.1, -1.2],
    ]
    const root = loft.sections(polygon2d(...SQ), polygon2d(...TRI))
    root.h = 5
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()

    // 4 bottom + 3 top cap corners are still emitted, plus crease-chain samples.
    assert.ok(cpu.vertexCount >= 7, `at least the 7 cap corners, got ${cpu.vertexCount}`)
    // 4 + 3 = 7 cap edges, plus differing-topology side creases beyond them.
    assert.ok(cpu.edgeCount > 7, `side creases emitted beyond the 7 cap edges, got ${cpu.edgeCount}`)
    assert.equal(cpu.loopCount, 2, "top + bottom cap loops")
})

test("Loft.accumulateFeatureGraph: different vertex counts → caps still intact when no side crease survives", () => {
    // SQUARE and TRIANGLE here are far apart / mismatched, so creases may be
    // degenerate; the caps (corners + loops) must still be emitted regardless.
    const root = loft.sections(polygon2d(...SQUARE), polygon2d(...TRIANGLE))
    root.h = 5
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()

    assert.ok(cpu.vertexCount >= 7, "3 top + 4 bottom cap corners")
    assert.ok(cpu.edgeCount >= 7, "3 + 4 cap edges")
    assert.equal(cpu.loopCount, 2, "top + bottom cap loops")
})

test("Loft.accumulateFeatureGraph: cap corners get FG_FLAG_CORNER when polygon turn is sharp", () => {
    const root = loft.sections(polygon2d(...TRIANGLE), polygon2d(...TRIANGLE))
    root.h = 5
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()

    for (let i = 0; i < cpu.vertexCount; i++) {
        const f = cpu.vertexFlags[i]!
        assert.ok((f & FG_FLAG_CORNER) !== 0, `vertex ${i} corner flag`)
        assert.ok((f & FG_FLAG_CREASE_ORIGINAL) !== 0)
    }
})

test("Loft.accumulateFeatureGraph: cap positions at y = ±h", () => {
    const root = loft.sections(polygon2d(...TRIANGLE), polygon2d(...TRIANGLE))
    root.h = 3
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()

    // Top corners emitted first (indices 0..2).
    for (let i = 0; i < 3; i++) {
        assert.equal(cpu.vertexPositions[i * 3 + 1]!, 3, `top corner ${i} at y = +h`)
    }
    // Bottom corners (indices 3..5).
    for (let i = 3; i < 6; i++) {
        assert.equal(cpu.vertexPositions[i * 3 + 1]!, -3, `bot corner ${i - 3} at y = -h`)
    }
})
