import assert from "node:assert/strict"
import test from "node:test"
import { lathe, polygon2d } from "../scene.mjs"
import {
    FeatureGraphBuilder,
    FG_FLAG_ALIVE,
    FG_FLAG_CORNER,
    FG_FLAG_CREASE_ORIGINAL,
} from "../feature-graph-buffer.mjs"

const RING_SEGMENTS = 32

/**
 * Right-angle profile in (r, y) space: a unit square at radius 2..3, height -1..+1.
 * All 4 vertices are sharp 90° turns → 4 feature rings expected.
 */
const SQUARE_TUBE: [number, number][] = [
    [2, -1],
    [3, -1],
    [3, 1],
    [2, 1],
]

test("Lathe.accumulateFeatureGraph: 4 sharp profile vertices → 4 rings × 32 segments", () => {
    const root = lathe.profile(polygon2d(SQUARE_TUBE))
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()

    assert.equal(cpu.vertexCount, 4 * RING_SEGMENTS, "4 rings × 32 segments each")
    assert.equal(cpu.edgeCount, 4 * RING_SEGMENTS, "4 rings × 32 closing edges")
    // No cap loops for lathe rings (revolved rings aren't planar cap faces).
    assert.equal(cpu.loopCount, 0)
})

test("Lathe.accumulateFeatureGraph: ring vertices are crease (not corner) with 2 source-face normals", () => {
    const root = lathe.profile(polygon2d(SQUARE_TUBE))
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()

    for (let i = 0; i < cpu.vertexCount; i++) {
        const f = cpu.vertexFlags[i]!
        assert.ok((f & FG_FLAG_ALIVE) !== 0)
        assert.ok((f & FG_FLAG_CREASE_ORIGINAL) !== 0)
        assert.equal(f & FG_FLAG_CORNER, 0, "rings never get FG_FLAG_CORNER")
        assert.equal(cpu.vertexNormalCount[i]!, 2)
    }
})

test("Lathe.accumulateFeatureGraph: rings sit at the profile vertex's (r, y) revolved around Y", () => {
    const root = lathe.profile(polygon2d(SQUARE_TUBE))
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()

    // Profile vertex order: (2,-1), (3,-1), (3,1), (2,1).
    // Rings emitted in that order, each = 32 vertices.
    const expected = [
        { r: 2, y: -1 },
        { r: 3, y: -1 },
        { r: 3, y: 1 },
        { r: 2, y: 1 },
    ]
    for (let ring = 0; ring < 4; ring++) {
        const { r, y } = expected[ring]!
        for (let i = 0; i < RING_SEGMENTS; i++) {
            const slot = ring * RING_SEGMENTS + i
            const x = cpu.vertexPositions[slot * 3]!
            const yi = cpu.vertexPositions[slot * 3 + 1]!
            const z = cpu.vertexPositions[slot * 3 + 2]!
            assert.ok(Math.abs(Math.sqrt(x * x + z * z) - r) < 1e-5, `ring ${ring} v${i} radius ≈ ${r}`)
            assert.ok(Math.abs(yi - y) < 1e-5, `ring ${ring} v${i} y ≈ ${y}`)
        }
    }
})

test("Lathe.accumulateFeatureGraph: smooth (collinear) profile vertices produce no rings", () => {
    // A linear ramp profile — 3 vertices but they're all collinear, so
    // there's only 1 actual feature edge between the closing-loop edges.
    // The closing edge does create a sharp turn at vertex 0 and vertex 2.
    // Let's pick a profile that has NO sharp turns at all: a smooth-looking
    // polygon that's an obvious test for the dot threshold.
    //
    // Hexagon at radius 5: each interior angle is 120°, so the dot of
    // adjacent outward normals is cos(60°) = 0.5 — that's < 0.95, so they
    // DO qualify as sharp. Let me instead build a profile where the
    // outward normals nearly agree (dot > 0.95).
    //
    // Approximated circle with 64 vertices around a regular polygon: each
    // turn is 360/64 = 5.6°, outward normal change is 5.6°,
    // dot = cos(5.6°) ≈ 0.995 > 0.95 → smooth, no rings.
    const N = 64
    const SMOOTH_CIRCLE: [number, number][] = []
    for (let i = 0; i < N; i++) {
        const t = (i / N) * 2 * Math.PI
        SMOOTH_CIRCLE.push([3 + Math.cos(t), Math.sin(t)])
    }
    const root = lathe.profile(polygon2d(SMOOTH_CIRCLE))
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()
    assert.equal(cpu.vertexCount, 0, "smooth profile (dot > threshold) → no feature rings")
})

test("Lathe.accumulateFeatureGraph: profile vertex at r=0 (axis) is skipped", () => {
    // Cone-like profile with an apex on the Y axis.
    const CONE: [number, number][] = [
        [0, 5],   // apex (axis pole)
        [3, -2],
        [0, -2],  // base center (axis pole)
    ]
    const root = lathe.profile(polygon2d(CONE))
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()
    // Only the single non-axis vertex (3, -2) qualifies. Its turn between
    // the two profile edges is sharp (apex→base rim vs base rim→base center).
    assert.equal(cpu.vertexCount, RING_SEGMENTS, "1 ring × 32 segments (the rim at (3, -2))")
})
