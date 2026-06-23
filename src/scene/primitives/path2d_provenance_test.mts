import assert from "node:assert/strict"
import test from "node:test"
import { path2d, tessellatePath, type PathElement } from "./path2d.mjs"
import { polygon2d } from "./polygon2d.mjs"

test("tessellatePath: bare vertices are all anchors", () => {
    const els: PathElement[] = [[0, 0], [10, 0], [10, 10], [0, 10]]
    const { vertices, isAnchor } = tessellatePath(els)
    assert.equal(vertices.length, 4)
    assert.equal(isAnchor.length, vertices.length, "flags parallel to vertices")
    assert.deepEqual(isAnchor, [true, true, true, true], "every authored vertex is an anchor")
})

test("tessellatePath: a curve's endpoints are anchors, interior samples are not", () => {
    // One cubic from (0,0) to (10,0) bowed up — tessellates into several samples.
    const els: PathElement[] = [[[0, 0], [3, 8], [7, 8], [10, 0]]]
    const { vertices, isAnchor } = tessellatePath(els)
    assert.ok(vertices.length > 2, "curve subdivides into interior samples")
    assert.equal(isAnchor.length, vertices.length)
    assert.equal(isAnchor[0], true, "start anchor (P0)")
    assert.equal(isAnchor[isAnchor.length - 1], true, "end anchor (P3)")
    for (let i = 1; i < isAnchor.length - 1; i++) {
        assert.equal(isAnchor[i], false, `interior sample ${i} is not an anchor`)
    }
    assert.equal(isAnchor.filter(Boolean).length, 2, "exactly two anchors on a single curve")
})

test("tessellatePath: shared boundary between two curves is a single anchor", () => {
    // Two cubics meeting at (10,0): the shared boundary appears once and is an anchor.
    const els: PathElement[] = [
        [[0, 0], [3, 8], [7, 8], [10, 0]],
        [[10, 0], [13, -8], [17, -8], [20, 0]],
    ]
    const { vertices, isAnchor } = tessellatePath(els)
    assert.equal(isAnchor.length, vertices.length)
    // Three authored anchors: start, shared join, end.
    assert.equal(isAnchor.filter(Boolean).length, 3, "start + shared join + end")
    // The join point (10,0) appears exactly once and is flagged.
    const joinIdxs = vertices
        .map((v, i) => (v[0] === 10 && v[1] === 0 ? i : -1))
        .filter(i => i >= 0)
    assert.equal(joinIdxs.length, 1, "shared boundary not duplicated")
    assert.equal(isAnchor[joinIdxs[0]!], true, "shared boundary is an anchor")
})

test("tessellatePath: a straight (linear) curve element tessellates to just its anchors", () => {
    const els: PathElement[] = [[[0, 0], [10, 0]], [[10, 0], [10, 10]]]
    const { vertices, isAnchor } = tessellatePath(els)
    // Linear cubics pass flatness immediately → only endpoints, all anchors.
    assert.deepEqual(isAnchor, isAnchor.map(() => true), "no interior samples on straight spans")
})

test("Path2DNode exposes vertexIsAnchor parallel to vertices", () => {
    const node = path2d([0, 0], [[10, 0], [13, 8], [17, 8], [20, 0]], [20, 10], [0, 10])
    assert.ok(node.vertexIsAnchor !== null, "path2d carries anchor provenance")
    assert.equal(node.vertexIsAnchor!.length, node.vertices.length, "mask parallel to vertices")
    // The bare vertices and curve endpoints are anchors; interior curve samples are not.
    assert.ok(node.vertexIsAnchor!.filter(Boolean).length >= 4, "at least the four authored nodes are anchors")
    assert.ok(
        node.vertexIsAnchor!.some(a => !a),
        "the bowed curve contributes non-anchor interior samples",
    )
})

test("plain polygon2d has no anchor provenance (vertexIsAnchor === null)", () => {
    const poly = polygon2d([0, 0], [10, 0], [10, 10], [0, 10])
    assert.equal(poly.vertexIsAnchor, null, "hand-specified polygons carry no authored-node mask")
})
