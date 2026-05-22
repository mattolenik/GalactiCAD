import assert from "node:assert/strict"
import test from "node:test"
import {
    FeatureGraphBuilder,
    FG_FLAG_CORNER,
    FG_FLAG_CREASE_ORIGINAL,
} from "../scene/feature-graph-buffer.mjs"
import { Vec3f } from "../vecmat/vector.mjs"
import { applyTransforms } from "./feature-graph-gpu.mjs"
import { FeatureGraphSpatialIndex } from "./feature-graph-spatial-index.mjs"
import { queryFeatureGraphForCell } from "./feature-graph-cell-query.mjs"

/** A box-style 3-face corner with three axis-aligned source normals. */
function cornerNormals(): Vec3f[] {
    return [new Vec3f([1, 0, 0]), new Vec3f([0, 1, 0]), new Vec3f([0, 0, 1])]
}

/** A 2-face crease with two source normals. */
function creaseNormals(): Vec3f[] {
    return [new Vec3f([1, 0, 0]), new Vec3f([0, 1, 0])]
}

test("queryFeatureGraphForCell: empty index → empty result", () => {
    const builder = new FeatureGraphBuilder()
    const cpu = builder.finish()
    const world = applyTransforms(cpu)
    const idx = FeatureGraphSpatialIndex.empty(1.0)
    const r = queryFeatureGraphForCell(idx, cpu, world, 0, 0, 0, 1, 1, 1, 0)
    assert.equal(r.cornerCount, 0)
    assert.equal(r.creaseCount, 0)
})

test("queryFeatureGraphForCell: single corner inside the cell → returned with normals", () => {
    const builder = new FeatureGraphBuilder()
    builder.beginNode(0)
    builder.emitVertex(new Vec3f([5, 5, 5]), FG_FLAG_CORNER, cornerNormals())
    builder.endNode()
    const cpu = builder.finish()
    const world = applyTransforms(cpu)
    const idx = FeatureGraphSpatialIndex.build(cpu, world, 1.0)

    const r = queryFeatureGraphForCell(idx, cpu, world, 4, 4, 4, 6, 6, 6, 0)
    assert.equal(r.cornerCount, 1)
    assert.equal(r.creaseCount, 0)
    assert.deepEqual([...r.cornerPositions], [5, 5, 5])
    assert.equal(r.cornerNormalCounts[0], 3)
    // First three normals are the axis triple; remaining slots zero-padded.
    assert.deepEqual([...r.cornerNormals.slice(0, 9)], [1, 0, 0, 0, 1, 0, 0, 0, 1])
})

test("queryFeatureGraphForCell: single crease edge → returned as a segment with normals", () => {
    const builder = new FeatureGraphBuilder()
    builder.beginNode(0)
    const a = builder.emitVertex(new Vec3f([2, 2, 2]), FG_FLAG_CREASE_ORIGINAL, creaseNormals())
    const b = builder.emitVertex(new Vec3f([2, 5, 2]), FG_FLAG_CREASE_ORIGINAL, creaseNormals())
    builder.emitEdge(a, b, FG_FLAG_CREASE_ORIGINAL)
    builder.endNode()
    const cpu = builder.finish()
    const world = applyTransforms(cpu)
    const idx = FeatureGraphSpatialIndex.build(cpu, world, 1.0)

    const r = queryFeatureGraphForCell(idx, cpu, world, 1, 1, 1, 6, 6, 6, 0)
    // The two endpoints are not FG_FLAG_CORNER, so no corners — only the edge.
    assert.equal(r.cornerCount, 0)
    assert.equal(r.creaseCount, 1)
    assert.deepEqual([...r.creaseSegments], [2, 2, 2, 2, 5, 2])
    assert.equal(r.creaseNormalCounts[0], 2)
    assert.deepEqual([...r.creaseNormals.slice(0, 6)], [1, 0, 0, 0, 1, 0])
})

test("queryFeatureGraphForCell: corner on an FG cell boundary is deduped across spanning cells", () => {
    // A corner exactly on the (0,0,0) FG-cell corner widens (½-cell) into 8 FG
    // cells. An octree cell spanning all of them must still see ONE corner.
    const builder = new FeatureGraphBuilder()
    builder.beginNode(0)
    builder.emitVertex(new Vec3f([0, 0, 0]), FG_FLAG_CORNER, cornerNormals())
    builder.endNode()
    const cpu = builder.finish()
    const world = applyTransforms(cpu)
    const idx = FeatureGraphSpatialIndex.build(cpu, world, 1.0)
    // Sanity: the half-cell widening really did fan the corner out to 8 cells.
    assert.equal(idx.cellCount, 8)

    const r = queryFeatureGraphForCell(idx, cpu, world, -1, -1, -1, 1, 1, 1, 0)
    assert.equal(r.cornerCount, 1, "deduped to a single corner despite 8-cell span")
})

test("queryFeatureGraphForCell: pad widens the query — far feature included only within pad", () => {
    const builder = new FeatureGraphBuilder()
    builder.beginNode(0)
    builder.emitVertex(new Vec3f([10, 10, 10]), FG_FLAG_CORNER, cornerNormals())
    builder.endNode()
    const cpu = builder.finish()
    const world = applyTransforms(cpu)
    const idx = FeatureGraphSpatialIndex.build(cpu, world, 1.0)

    // Cell [0,1]³ — corner at (10,10,10) is far. No pad → not found.
    const near = queryFeatureGraphForCell(idx, cpu, world, 0, 0, 0, 1, 1, 1, 0)
    assert.equal(near.cornerCount, 0)
    // Pad of 10 widens the query AABB out to the corner's FG cells.
    const padded = queryFeatureGraphForCell(idx, cpu, world, 0, 0, 0, 1, 1, 1, 10)
    assert.equal(padded.cornerCount, 1)
})

test("queryFeatureGraphForCell: multi-resolution — shallow cell spans many FG cells, all features returned + deduped", () => {
    // Three corners spread across a 20-unit span; FG index at cellSize 1 so a
    // single shallow octree cell of [0,20]³ overlaps hundreds of FG cells.
    const builder = new FeatureGraphBuilder()
    builder.beginNode(0)
    builder.emitVertex(new Vec3f([1, 1, 1]), FG_FLAG_CORNER, cornerNormals())
    builder.emitVertex(new Vec3f([10, 10, 10]), FG_FLAG_CORNER, cornerNormals())
    builder.emitVertex(new Vec3f([19, 19, 19]), FG_FLAG_CORNER, cornerNormals())
    builder.endNode()
    const cpu = builder.finish()
    const world = applyTransforms(cpu)
    const idx = FeatureGraphSpatialIndex.build(cpu, world, 1.0)

    const r = queryFeatureGraphForCell(idx, cpu, world, 0, 0, 0, 20, 20, 20, 0)
    assert.equal(r.cornerCount, 3, "all three corners, each exactly once")
    // Positions present (order is Set-iteration dependent — assert as a set).
    const xs = new Set<number>()
    for (let i = 0; i < r.cornerCount; i++) xs.add(r.cornerPositions[i * 3]!)
    assert.deepEqual([...xs].sort((a, b) => a - b), [1, 10, 19])
})

test("queryFeatureGraphForCell: feature outside the cell-and-pad is excluded", () => {
    const builder = new FeatureGraphBuilder()
    builder.beginNode(0)
    builder.emitVertex(new Vec3f([2, 2, 2]), FG_FLAG_CORNER, cornerNormals())
    builder.emitVertex(new Vec3f([50, 50, 50]), FG_FLAG_CORNER, cornerNormals())
    builder.endNode()
    const cpu = builder.finish()
    const world = applyTransforms(cpu)
    const idx = FeatureGraphSpatialIndex.build(cpu, world, 1.0)

    const r = queryFeatureGraphForCell(idx, cpu, world, 0, 0, 0, 4, 4, 4, 1)
    assert.equal(r.cornerCount, 1, "only the in-cell corner; the far one is gated out")
    assert.deepEqual([...r.cornerPositions], [2, 2, 2])
})

test("queryFeatureGraphForCell: standalone non-corner vertex is not emitted (implicit in edges)", () => {
    // A lone crease-original vertex with no edge — not a corner, not part of a
    // crease segment. The query emits neither a corner nor a crease for it.
    const builder = new FeatureGraphBuilder()
    builder.beginNode(0)
    builder.emitVertex(new Vec3f([3, 3, 3]), FG_FLAG_CREASE_ORIGINAL, creaseNormals())
    builder.endNode()
    const cpu = builder.finish()
    const world = applyTransforms(cpu)
    const idx = FeatureGraphSpatialIndex.build(cpu, world, 1.0)

    const r = queryFeatureGraphForCell(idx, cpu, world, 0, 0, 0, 6, 6, 6, 0)
    assert.equal(r.cornerCount, 0)
    assert.equal(r.creaseCount, 0)
})
