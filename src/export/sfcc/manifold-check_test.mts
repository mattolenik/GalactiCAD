import assert from "node:assert/strict"
import test from "node:test"
import { checkManifold } from "./manifold-check.mjs"

// A closed tetrahedron (vertices 0..3), outward-wound.
const TET = [0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3]

test("closed tetrahedron passes with χ=2", () => {
    const r = checkManifold(TET, { checkVertexLinks: true })
    assert.ok(r.ok)
    assert.equal(r.components, 1)
    assert.deepEqual(r.eulerPerComponent, [2])
})

test("punctured tetrahedron reports its three open edges", () => {
    const r = checkManifold(TET.slice(0, 9))
    assert.ok(!r.ok)
    assert.equal(r.openEdges, 3)
})

test("flipped triangle reports misoriented edges", () => {
    const flipped = [...TET]
    ;[flipped[0], flipped[1]] = [flipped[1]!, flipped[0]!]
    const r = checkManifold(flipped)
    assert.ok(!r.ok)
    assert.equal(r.misorientedEdges, 3)
    assert.equal(r.openEdges, 0)
})

test("edge shared by three triangles is non-manifold", () => {
    const r = checkManifold([...TET, 0, 1, 4])
    assert.ok(!r.ok)
    assert.ok(r.nonManifoldEdges >= 1)
})

test("two disjoint tetrahedra → two components, χ=2 each", () => {
    const second = TET.map(v => v + 4)
    const r = checkManifold([...TET, ...second], { checkVertexLinks: true })
    assert.ok(r.ok)
    assert.equal(r.components, 2)
    assert.deepEqual(r.eulerPerComponent, [2, 2])
})

test("bowtie vertex caught by the vertex-link check", () => {
    // Two closed tetrahedra sharing vertex 0: every edge is fine, but 0's
    // link is two disjoint cycles.
    const second = [0, 6, 5, 0, 5, 7, 5, 6, 7, 6, 0, 7]
    const edgesOnly = checkManifold([...TET, ...second])
    assert.ok(edgesOnly.ok, "edge test alone admits the bowtie")
    const withLinks = checkManifold([...TET, ...second], { checkVertexLinks: true })
    assert.ok(!withLinks.ok)
    assert.equal(withLinks.nonManifoldVertices, 1)
})
