import assert from "node:assert/strict"
import test from "node:test"
import {
    FeatureGraphBuilder,
    FG_FLAG_CORNER,
    FG_FLAG_CREASE_ORIGINAL,
} from "../scene/feature-graph-buffer.mjs"
import { Vec3f } from "../vecmat/vector.mjs"
import { groupChains, FgChainKind } from "./feature-graph-chains.mjs"

const v3 = (x: number, y: number, z: number) => new Vec3f([x, y, z])

test("groupChains: closed square is one ring", () => {
    const b = new FeatureGraphBuilder()
    b.beginNode(1)
    const v = [
        b.emitVertex(v3(0, 0, 0), FG_FLAG_CREASE_ORIGINAL, []),
        b.emitVertex(v3(1, 0, 0), FG_FLAG_CREASE_ORIGINAL, []),
        b.emitVertex(v3(1, 1, 0), FG_FLAG_CREASE_ORIGINAL, []),
        b.emitVertex(v3(0, 1, 0), FG_FLAG_CREASE_ORIGINAL, []),
    ]
    b.emitEdge(v[0]!, v[1]!, FG_FLAG_CREASE_ORIGINAL)
    b.emitEdge(v[1]!, v[2]!, FG_FLAG_CREASE_ORIGINAL)
    b.emitEdge(v[2]!, v[3]!, FG_FLAG_CREASE_ORIGINAL)
    b.emitEdge(v[3]!, v[0]!, FG_FLAG_CREASE_ORIGINAL)
    b.endNode()

    const g = groupChains(b.finish())
    assert.equal(g.chains.length, 1)
    assert.equal(g.chains[0]!.kind, FgChainKind.Ring)
    assert.equal(g.chains[0]!.edgeInstanceIndices.length, 4)
    assert.deepEqual(Array.from(g.edgeInstanceToChain), [0, 0, 0, 0])
})

test("groupChains: subdivided straight run collapses to one polyline", () => {
    const b = new FeatureGraphBuilder()
    b.beginNode(1)
    const vs = [
        b.emitVertex(v3(0, 0, 0), FG_FLAG_CREASE_ORIGINAL, []),
        b.emitVertex(v3(1, 0, 0), FG_FLAG_CREASE_ORIGINAL, []),
        b.emitVertex(v3(2, 0, 0), FG_FLAG_CREASE_ORIGINAL, []),
        b.emitVertex(v3(3, 0, 0), FG_FLAG_CREASE_ORIGINAL, []),
    ]
    b.emitEdge(vs[0]!, vs[1]!, FG_FLAG_CREASE_ORIGINAL)
    b.emitEdge(vs[1]!, vs[2]!, FG_FLAG_CREASE_ORIGINAL)
    b.emitEdge(vs[2]!, vs[3]!, FG_FLAG_CREASE_ORIGINAL)
    b.endNode()

    const g = groupChains(b.finish())
    assert.equal(g.chains.length, 1)
    assert.equal(g.chains[0]!.kind, FgChainKind.Polyline)
    assert.equal(g.chains[0]!.edgeInstanceIndices.length, 3)
    const vi = g.chains[0]!.vertexIndices
    assert.equal(vi.length, 4)
    assert.deepEqual([vi[0]!, vi[vi.length - 1]!].sort(), [vs[0]!, vs[3]!].sort())
})

test("groupChains: open path splits at a corner vertex", () => {
    const b = new FeatureGraphBuilder()
    b.beginNode(1)
    const v0 = b.emitVertex(v3(0, 0, 0), FG_FLAG_CREASE_ORIGINAL, [])
    const v1 = b.emitVertex(v3(1, 0, 0), FG_FLAG_CORNER, []) // corner = split
    const v2 = b.emitVertex(v3(2, 0, 0), FG_FLAG_CREASE_ORIGINAL, [])
    const v3i = b.emitVertex(v3(3, 0, 0), FG_FLAG_CREASE_ORIGINAL, [])
    b.emitEdge(v0, v1, FG_FLAG_CREASE_ORIGINAL)
    b.emitEdge(v1, v2, FG_FLAG_CREASE_ORIGINAL)
    b.emitEdge(v2, v3i, FG_FLAG_CREASE_ORIGINAL)
    b.endNode()

    const g = groupChains(b.finish())
    assert.equal(g.chains.length, 2)
    assert.ok(g.chains.every(c => c.kind === FgChainKind.Polyline))
    assert.ok(Array.from(g.edgeInstanceToChain).every(c => c >= 0))
    const sizes = g.chains.map(c => c.edgeInstanceIndices.length).sort()
    assert.deepEqual(sizes, [1, 2])
})

test("groupChains: splits at owner-node boundary", () => {
    const b = new FeatureGraphBuilder()
    b.beginNode(10)
    const v0 = b.emitVertex(v3(0, 0, 0), FG_FLAG_CREASE_ORIGINAL, [])
    const v1 = b.emitVertex(v3(1, 0, 0), FG_FLAG_CREASE_ORIGINAL, [])
    b.emitEdge(v0, v1, FG_FLAG_CREASE_ORIGINAL) // owner 10
    b.endNode()
    b.beginNode(20)
    const v2 = b.emitVertex(v3(2, 0, 0), FG_FLAG_CREASE_ORIGINAL, [])
    b.emitEdge(v1, v2, FG_FLAG_CREASE_ORIGINAL) // owner 20, shares v1
    b.endNode()

    const g = groupChains(b.finish())
    assert.equal(g.chains.length, 2)
    assert.deepEqual(g.chains.map(c => c.ownerNodeId).sort(), [10, 20])
})
