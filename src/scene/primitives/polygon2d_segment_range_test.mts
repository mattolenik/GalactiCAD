import assert from "node:assert/strict"
import test from "node:test"
import { surfaceSegmentEdgeRange } from "./polygon2d.mjs"

test("surfaceSegmentEdgeRange: all-anchor ring → each edge is its own segment", () => {
    const mask = [true, true, true, true]
    for (let e = 0; e < 4; e++) {
        assert.deepEqual(surfaceSegmentEdgeRange(mask, e, 4), { start: e, end: (e + 1) % 4 })
    }
})

test("surfaceSegmentEdgeRange: interior samples collapse into one segment", () => {
    // v0 anchor, v1/v2 interior, v3 anchor, v4 anchor (n=5).
    const mask = [true, false, false, true, true]
    // Edges 0,1,2 all belong to the segment spanning anchor v0 → anchor v3.
    assert.deepEqual(surfaceSegmentEdgeRange(mask, 0, 5), { start: 0, end: 3 })
    assert.deepEqual(surfaceSegmentEdgeRange(mask, 1, 5), { start: 0, end: 3 })
    assert.deepEqual(surfaceSegmentEdgeRange(mask, 2, 5), { start: 0, end: 3 })
    // Edge 3 is its own segment (anchor v3 → anchor v4).
    assert.deepEqual(surfaceSegmentEdgeRange(mask, 3, 5), { start: 3, end: 4 })
})

test("surfaceSegmentEdgeRange: a segment wrapping the seam reports end <= start", () => {
    // Anchors at v0, v2; v1, v3 interior (n=4). Edge 3 (v3→v0) and edge 2 (v2→v3)
    // form the segment from anchor v2 wrapping back to anchor v0.
    const mask = [true, false, true, false]
    const r = surfaceSegmentEdgeRange(mask, 3, 4)
    assert.deepEqual(r, { start: 2, end: 0 }, "wraps: start=2, end=0")
    assert.ok(r.end <= r.start, "wrap signalled by end <= start")
    // Edge 2 lands in the same wrapped segment.
    assert.deepEqual(surfaceSegmentEdgeRange(mask, 2, 4), { start: 2, end: 0 })
})

test("surfaceSegmentEdgeRange: no anchors → degrades to a single edge (guarded)", () => {
    const mask = [false, false, false]
    const r = surfaceSegmentEdgeRange(mask, 1, 3)
    // Guards stop the walk after n steps; the result is bounded, not infinite.
    assert.ok(r.start >= 0 && r.start < 3 && r.end >= 0 && r.end < 3)
})
