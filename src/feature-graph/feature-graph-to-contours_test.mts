import assert from "node:assert/strict"
import test from "node:test"
import { featureGraphToContours } from "./feature-graph-to-contours.mjs"
import {
    FG_FLAG_ALIVE,
    FG_FLAG_CORNER,
    FG_FLAG_CREASE_ORIGINAL,
    FeatureGraphBuilder,
} from "../scene/feature-graph-buffer.mjs"
import { applyTransformsCpu } from "./feature-graph-stages.mjs"
import { Vec3f } from "../vecmat/vector.mjs"

test("featureGraphToContours: empty input returns empty view", () => {
    const builder = new FeatureGraphBuilder()
    const cpu = builder.finish()
    const view = featureGraphToContours(cpu, { positions: new Float32Array(0), count: 0 })
    assert.equal(view.segmentCount, 0)
    assert.equal(view.pointCount, 0)
    assert.equal(view.ringCount, 0)
})

test("featureGraphToContours: alive corners → points, alive edges → segments", () => {
    const builder = new FeatureGraphBuilder()
    builder.beginNode(11)
    const a = builder.emitVertex(new Vec3f([0, 0, 0]), FG_FLAG_CREASE_ORIGINAL | FG_FLAG_CORNER, [
        new Vec3f([1, 0, 0]),
    ])
    const b = builder.emitVertex(new Vec3f([5, 0, 0]), FG_FLAG_CREASE_ORIGINAL | FG_FLAG_CORNER, [
        new Vec3f([1, 0, 0]),
    ])
    builder.emitEdge(a, b, FG_FLAG_CREASE_ORIGINAL)
    builder.endNode()
    const cpu = builder.finish()
    const world = applyTransformsCpu(cpu)
    const view = featureGraphToContours(cpu, world)
    assert.equal(view.pointCount, 2)
    assert.equal(view.segmentCount, 1)
    // Point positions match world positions.
    assert.equal(view.points[0]!, 0)
    assert.equal(view.points[1]!, 0)
    assert.equal(view.points[2]!, 0)
    assert.equal(view.points[3]!, 5)
    // Segment endpoints (packed [ax,ay,az,bx,by,bz]).
    assert.equal(view.segments[0]!, 0)
    assert.equal(view.segments[3]!, 5)
    // Owner ids propagate.
    assert.equal(view.pointOwners[0]!, 11)
    assert.equal(view.segmentOwners[0]!, 11)
})

test("featureGraphToContours: dead vertex omitted from points + segments", () => {
    const builder = new FeatureGraphBuilder()
    builder.beginNode(1)
    const a = builder.emitVertex(new Vec3f([0, 0, 0]), FG_FLAG_CREASE_ORIGINAL | FG_FLAG_CORNER, [])
    const b = builder.emitVertex(new Vec3f([5, 0, 0]), FG_FLAG_CREASE_ORIGINAL | FG_FLAG_CORNER, [])
    const c = builder.emitVertex(new Vec3f([0, 5, 0]), FG_FLAG_CREASE_ORIGINAL | FG_FLAG_CORNER, [])
    builder.emitEdge(a, b, FG_FLAG_CREASE_ORIGINAL)
    builder.emitEdge(b, c, FG_FLAG_CREASE_ORIGINAL)
    builder.endNode()
    const cpu = builder.finish()
    // Mark vertex b dead — `a→b` and `b→c` edges should also die (both have a dead endpoint).
    cpu.vertexFlags[b] = cpu.vertexFlags[b]! & ~FG_FLAG_ALIVE
    cpu.edgeFlags[0] = cpu.edgeFlags[0]! & ~FG_FLAG_ALIVE
    cpu.edgeFlags[1] = cpu.edgeFlags[1]! & ~FG_FLAG_ALIVE
    void a; void c
    const world = applyTransformsCpu(cpu)
    const view = featureGraphToContours(cpu, world)
    assert.equal(view.pointCount, 2, "vertices a + c alive; b dropped")
    assert.equal(view.segmentCount, 0, "both edges dead")
})

test("featureGraphToContours: non-corner vertices not emitted as points", () => {
    const builder = new FeatureGraphBuilder()
    builder.beginNode(0)
    // Subdivided sample — alive but NOT a corner.
    builder.emitVertex(new Vec3f([1, 0, 0]), FG_FLAG_CREASE_ORIGINAL, [])
    builder.endNode()
    const cpu = builder.finish()
    const world = applyTransformsCpu(cpu)
    const view = featureGraphToContours(cpu, world)
    assert.equal(view.pointCount, 0, "non-corner alive vertex not a point")
})

test("featureGraphToContours: segment AABB tight, point AABB collapsed", () => {
    const builder = new FeatureGraphBuilder()
    builder.beginNode(0)
    const a = builder.emitVertex(new Vec3f([1, 2, 3]), FG_FLAG_CREASE_ORIGINAL | FG_FLAG_CORNER, [])
    const b = builder.emitVertex(new Vec3f([7, 5, 3]), FG_FLAG_CREASE_ORIGINAL | FG_FLAG_CORNER, [])
    builder.emitEdge(a, b, FG_FLAG_CREASE_ORIGINAL)
    builder.endNode()
    const cpu = builder.finish()
    const world = applyTransformsCpu(cpu)
    const view = featureGraphToContours(cpu, world)
    // Point AABBs collapse to position (min == max).
    for (let i = 0; i < view.pointCount; i++) {
        assert.equal(view.pointBBox[i * 6 + 0]!, view.pointBBox[i * 6 + 3]!)
        assert.equal(view.pointBBox[i * 6 + 1]!, view.pointBBox[i * 6 + 4]!)
        assert.equal(view.pointBBox[i * 6 + 2]!, view.pointBBox[i * 6 + 5]!)
    }
    // Segment AABB tight to endpoint bounds.
    assert.equal(view.segmentBBox[0]!, 1) // minX
    assert.equal(view.segmentBBox[1]!, 2) // minY
    assert.equal(view.segmentBBox[2]!, 3) // minZ
    assert.equal(view.segmentBBox[3]!, 7) // maxX
    assert.equal(view.segmentBBox[4]!, 5) // maxY
    assert.equal(view.segmentBBox[5]!, 3) // maxZ
})
