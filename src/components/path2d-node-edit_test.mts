import assert from "node:assert/strict"
import test from "node:test"
import type { PathElement, Vec2 } from "../scene/primitives/path2d.mjs"
import {
    anchorEndpoints,
    anchorIndexOfRef,
    angleSnap,
    autoSmoothHandles,
    axisConstrain,
    ensureAnchorHandles,
    getAnchors,
    inferNodeType,
    isAnchorEndpoint,
    isControlHandle,
    normalizeToType,
    parseNodeType,
    partnerHandle,
    partnerUpdate,
    pointCount,
    promoteToCubic,
} from "./path2d-node-edit.mjs"

function assertVec(actual: Vec2 | null, expected: Vec2, msg?: string, eps = 1e-9) {
    assert.ok(actual, `${msg ?? ""}: expected a vector, got null`)
    assert.ok(
        Math.abs(actual![0] - expected[0]) <= eps && Math.abs(actual![1] - expected[1]) <= eps,
        `${msg ?? ""}: got [${actual}], expected [${expected}]`,
    )
}

// A closed loop of two cubics: A=[0,0] ─el0→ B=[10,0] ─el1→ A.
const cubic0: PathElement = [[0, 0], [2, 3], [8, 3], [10, 0]]
const cubic1: PathElement = [[10, 0], [12, -3], [-2, -3], [0, 0]]
const loop: PathElement[] = [cubic0, cubic1]

// ── partnerHandle: the element-boundary crossing ───────────────────────

test("partnerHandle: out-handle wraps to previous element's in-handle", () => {
    // el0 pi=1 is A's outgoing handle; partner is A's incoming handle in el1 (wrap).
    const r = partnerHandle(loop, { ei: 0, pi: 1 })
    assert.deepStrictEqual(r, { partner: { ei: 1, pi: 2 }, anchor: [0, 0] })
})

test("partnerHandle: in-handle links to next element's out-handle", () => {
    // el0 pi=2 is B's incoming handle; partner is B's outgoing handle in el1.
    const r = partnerHandle(loop, { ei: 0, pi: 2 })
    assert.deepStrictEqual(r, { partner: { ei: 1, pi: 1 }, anchor: [10, 0] })
})

test("partnerHandle: null at a line neighbour", () => {
    const els: PathElement[] = [cubic0, [[10, 0], [20, 0]]] // el1 is a straight line
    assert.equal(partnerHandle(els, { ei: 0, pi: 2 }), null)
})

test("partnerHandle: null at a vertex neighbour", () => {
    const els: PathElement[] = [cubic0, [20, 0]] // el1 is a bare vertex
    assert.equal(partnerHandle(els, { ei: 0, pi: 2 }), null)
})

test("partnerHandle: null across a gap (non-coincident join)", () => {
    // el1 starts at [11,0], not at B=[10,0] → a corner, not a shared anchor.
    const els: PathElement[] = [cubic0, [[11, 0], [13, -3], [-2, -3], [0, 0]]]
    assert.equal(partnerHandle(els, { ei: 0, pi: 2 }), null)
})

test("partnerHandle: null for quadratic (v1 links only cubics)", () => {
    const els: PathElement[] = [[[0, 0], [5, 5], [10, 0]], [[10, 0], [5, -5], [0, 0]]]
    assert.equal(partnerHandle(els, { ei: 0, pi: 1 }), null)
})

// ── classification helpers ─────────────────────────────────────────────

test("isControlHandle / isAnchorEndpoint", () => {
    assert.equal(isControlHandle(loop, { ei: 0, pi: 1 }), true)
    assert.equal(isControlHandle(loop, { ei: 0, pi: 2 }), true)
    assert.equal(isControlHandle(loop, { ei: 0, pi: 0 }), false)
    assert.equal(isControlHandle(loop, { ei: 0, pi: 3 }), false)
    assert.equal(isAnchorEndpoint(loop, { ei: 0, pi: 0 }), true)
    assert.equal(isAnchorEndpoint(loop, { ei: 0, pi: 3 }), true)
    assert.equal(isAnchorEndpoint(loop, { ei: 0, pi: 1 }), false)
})

// ── inferNodeType ──────────────────────────────────────────────────────

test("inferNodeType: missing handle → cusp", () => {
    assert.equal(inferNodeType([0, 0], null, [1, 0]), "cusp")
    assert.equal(inferNodeType([0, 0], [-1, 0], null), "cusp")
})

test("inferNodeType: colinear + equal length → symmetric", () => {
    assert.equal(inferNodeType([0, 0], [-1, 0], [1, 0]), "symmetric")
})

test("inferNodeType: colinear + unequal length → smooth", () => {
    assert.equal(inferNodeType([0, 0], [-2, 0], [1, 0]), "smooth")
})

test("inferNodeType: non-colinear → cusp", () => {
    assert.equal(inferNodeType([0, 0], [-1, 0], [0, 1]), "cusp")
})

test("inferNodeType: same-side (not opposite) → cusp", () => {
    assert.equal(inferNodeType([0, 0], [1, 0], [1, 0]), "cusp")
})

// ── partnerUpdate math ─────────────────────────────────────────────────

test("partnerUpdate: cusp leaves partner alone", () => {
    assert.equal(partnerUpdate("cusp", [0, 0], [2, 3], [1, -2]), null)
})

test("partnerUpdate: symmetric reflects across the anchor", () => {
    assertVec(partnerUpdate("symmetric", [0, 0], [2, 3], [9, 9]), [-2, -3])
    assertVec(partnerUpdate("symmetric", [5, 5], [7, 8], [9, 9]), [3, 2])
})

test("partnerUpdate: smooth rotates partner, preserving its length", () => {
    const r = partnerUpdate("smooth", [0, 0], [0, 4], [1, -2]) // partner len = √5
    assertVec(r, [0, -Math.sqrt(5)], "smooth keeps length, flips direction")
})

test("partnerUpdate: smooth extends a retracted partner to equal length", () => {
    const r = partnerUpdate("smooth", [0, 0], [0, 4], [0, 0]) // partner retracted
    assertVec(r, [0, -4], "retracted partner extends to dragged length")
})

// ── autoSmoothHandles ──────────────────────────────────────────────────

test("autoSmoothHandles: Catmull-Rom tangent, k·neighbour distance", () => {
    const { inH, outH } = autoSmoothHandles([-3, 0], [0, 0], [3, 0], 1 / 3)
    assertVec(inH, [-1, 0])
    assertVec(outH, [1, 0])
})

// ── modifier snapping ──────────────────────────────────────────────────

test("angleSnap: rounds handle angle to 15° steps, keeps radius", () => {
    const r = angleSnap([0, 0], [1, 0.1], 15) // ~5.7° → 0°
    assertVec(r, [Math.hypot(1, 0.1), 0], "snaps to 0°", 1e-9)
})

test("axisConstrain: snaps to nearest 45°", () => {
    const r = axisConstrain([0, 0], [1, 0.9]) // ~42° → 45°
    const rad = Math.hypot(1, 0.9)
    assertVec(r, [rad * Math.SQRT1_2, rad * Math.SQRT1_2], "snaps to 45°", 1e-9)
})

// ── getAnchors ─────────────────────────────────────────────────────────

test("getAnchors: shared cubic join exposes both endpoints + both handles", () => {
    const anchors = getAnchors(loop)
    assert.equal(anchors.length, 2)
    const b = anchors[0]! // join at end of el0 = B
    assert.deepStrictEqual(b.pos, [10, 0])
    assert.equal(b.shared, true)
    assert.deepStrictEqual(b.endpointRefs, [{ ei: 0, pi: 3 }, { ei: 1, pi: 0 }])
    assert.deepStrictEqual(b.inHandle, { ei: 0, pi: 2 })
    assert.deepStrictEqual(b.outHandle, { ei: 1, pi: 1 })
})

test("getAnchors: gap join is not shared and has no outgoing handle", () => {
    const els: PathElement[] = [cubic0, [[11, 0], [13, -3], [-2, -3], [0, 0]]]
    const b = getAnchors(els)[0]!
    assert.equal(b.shared, false)
    assert.deepStrictEqual(b.endpointRefs, [{ ei: 0, pi: 3 }]) // only el0's end
    assert.equal(b.outHandle, null)
})

test("getAnchors: prevPos/nextPos are the neighbour anchors, even for a vertex", () => {
    // All-vertex triangle: each anchor's neighbours are the *other* vertices,
    // not the element's own start (which would collapse onto the vertex itself).
    const tri: PathElement[] = [[0, 0], [10, 0], [5, 8]]
    const a0 = getAnchors(tri)[0]!
    assert.deepStrictEqual(a0.pos, [0, 0])
    assert.deepStrictEqual(a0.prevPos, [5, 8])   // anchor2 (el2.end), not [0,0]
    assert.deepStrictEqual(a0.nextPos, [10, 0])  // anchor1 (el1.end)
})

// ── anchorIndexOfRef ───────────────────────────────────────────────────

test("anchorIndexOfRef: endpoints and handles resolve to their anchor", () => {
    // loop: anchor0 = B (end of el0), anchor1 = A (end of el1).
    assert.equal(anchorIndexOfRef(loop, { ei: 0, pi: 3 }), 0) // B endpoint
    assert.equal(anchorIndexOfRef(loop, { ei: 1, pi: 0 }), 0) // B coincident copy
    assert.equal(anchorIndexOfRef(loop, { ei: 0, pi: 2 }), 0) // B in-handle
    assert.equal(anchorIndexOfRef(loop, { ei: 1, pi: 1 }), 0) // B out-handle
    assert.equal(anchorIndexOfRef(loop, { ei: 1, pi: 3 }), 1) // A endpoint
    assert.equal(anchorIndexOfRef(loop, { ei: 0, pi: 1 }), 1) // A out-handle
})

// ── anchorEndpoints (rigid anchor move) ────────────────────────────────

test("anchorEndpoints: gathers both coincident endpoints + their handles", () => {
    const r = anchorEndpoints(loop, { ei: 0, pi: 3 }) // B
    assert.deepStrictEqual(r.pos, [10, 0])
    assert.deepStrictEqual(r.pointRefs, [
        { ei: 0, pi: 3 }, // the endpoint
        { ei: 0, pi: 2 }, // its in-handle
        { ei: 1, pi: 0 }, // coincident endpoint copy
        { ei: 1, pi: 1 }, // its out-handle
    ])
})

test("anchorEndpoints: a vertex endpoint pulls in nothing but coincident copies", () => {
    // vertex V at [10,0] between two lines that meet there.
    const els: PathElement[] = [[[0, 0], [10, 0]], [10, 0], [[10, 0], [20, 5]]]
    const r = anchorEndpoints(els, { ei: 1, pi: 0 }) // the vertex
    assert.deepStrictEqual(r.pos, [10, 0])
    // vertex (ei1) + its prev line's end (ei0 pi1) + next line's start (ei2 pi0); no handles.
    assert.deepStrictEqual(
        r.pointRefs.slice().sort(refSort),
        [{ ei: 0, pi: 1 }, { ei: 1, pi: 0 }, { ei: 2, pi: 0 }].sort(refSort),
    )
})

function refSort(a: { ei: number; pi: number }, b: { ei: number; pi: number }) {
    return a.ei - b.ei || a.pi - b.pi
}

// ── normalizeToType ────────────────────────────────────────────────────

test("normalizeToType: symmetric → colinear, equal averaged length", () => {
    const r = normalizeToType("symmetric", [0, 0], [-2, 0], [1, 0], [0, 0], [0, 0])
    assertVec(r.inH ?? null, [-1.5, 0])
    assertVec(r.outH ?? null, [1.5, 0])
})

test("normalizeToType: smooth → colinear, each length preserved", () => {
    const anchor: Vec2 = [0, 0]
    const inH: Vec2 = [-2, 1]
    const outH: Vec2 = [3, 0.5]
    const r = normalizeToType("smooth", anchor, inH, outH, [0, 0], [0, 0])
    // result must be colinear (inferred smooth/symmetric) and preserve lengths.
    const lIn = Math.hypot(...inH)
    const lOut = Math.hypot(...outH)
    assert.ok(Math.abs(Math.hypot(...r.inH!) - lIn) < 1e-9, "in length preserved")
    assert.ok(Math.abs(Math.hypot(...r.outH!) - lOut) < 1e-9, "out length preserved")
    assert.notEqual(inferNodeType(anchor, r.inH!, r.outH!), "cusp")
})

test("normalizeToType: cusp leaves geometry untouched", () => {
    assert.deepStrictEqual(normalizeToType("cusp", [0, 0], [-2, 1], [3, 0.5], [0, 0], [0, 0]), {})
})

test("normalizeToType: smart uses Catmull-Rom from neighbours", () => {
    const r = normalizeToType("smart", [0, 0], [-9, 9], [9, 9], [-3, 0], [3, 0], 1 / 3)
    assertVec(r.inH ?? null, [-1, 0])
    assertVec(r.outH ?? null, [1, 0])
})

test("normalizeToType: missing handle is a no-op for smooth/symmetric", () => {
    assert.deepStrictEqual(normalizeToType("smooth", [0, 0], null, [1, 0], [0, 0], [0, 0]), {})
})

test("normalizeToType: a retracted handle is seeded from the neighbour chord", () => {
    // out-handle retracted onto the anchor; smooth must still produce a real
    // out-handle (seeded from the prev/next chord) rather than leaving it stuck.
    const r = normalizeToType("smooth", [0, 0], [-2, 0], [0, 0], [-3, 0], [3, 0], 1 / 3)
    assert.ok(r.inH && r.outH, "both handles produced")
    assert.ok(Math.hypot(r.outH![0], r.outH![1]) > 0.1, "retracted out-handle was extended")
    assert.notEqual(inferNodeType([0, 0], r.inH!, r.outH!), "cusp")
})

// ── promoteToCubic / ensureAnchorHandles (vertex↔control) ──────────────

test("promoteToCubic: a bare vertex is elevated as the [start,end] segment", () => {
    const c = promoteToCubic([5, 5], [0, 0], [9, 0]) // vertex's own point ignored; span drives it
    assert.equal(c.length, 4)
    assertVec(c[0]!, [0, 0])
    assertVec(c[1]!, [3, 0])
    assertVec(c[2]!, [6, 0])
    assertVec(c[3]!, [9, 0])
})

test("promoteToCubic: a line is degree-elevated from its own points", () => {
    const c = promoteToCubic([[0, 0], [9, 0]], [0, 0], [0, 0])
    assert.deepStrictEqual(c, [[0, 0], [3, 0], [6, 0], [9, 0]])
})

test("promoteToCubic: an existing cubic is returned unchanged", () => {
    const cubic: PathElement = [[0, 0], [1, 1], [2, 1], [3, 0]]
    assert.deepStrictEqual(promoteToCubic(cubic, [0, 0], [3, 0]), cubic)
})

test("ensureAnchorHandles: a vertex polygon corner gains in+out handles", () => {
    const square: PathElement[] = [[0, 0], [10, 0], [10, 10], [0, 10]]
    const out = ensureAnchorHandles(square, 0)
    assert.equal(out.length, 4, "element count preserved (anchor indices stable)")
    assert.equal(pointCount(out[0]!), 4, "incoming side promoted to cubic")
    assert.equal(pointCount(out[1]!), 4, "outgoing side promoted to cubic")

    const a = getAnchors(out)[0]!
    assertVec(a.pos, [0, 0], "anchor position unchanged (geometry preserved)")
    assert.notEqual(a.inHandle, null, "anchor now has an incoming handle")
    assert.notEqual(a.outHandle, null, "anchor now has an outgoing handle")
    // Promoted handles lie on the original straight edges → still a corner (cusp).
    assert.equal(inferNodeType(a.pos,
        a.inHandle ? out[a.inHandle.ei]![a.inHandle.pi] as Vec2 : null,
        a.outHandle ? out[a.outHandle.ei]![a.outHandle.pi] as Vec2 : null), "cusp")
})

test("ensureAnchorHandles: neighbours stay corners (no stray half-handles)", () => {
    const square: PathElement[] = [[0, 0], [10, 0], [10, 10], [0, 10]]
    const out = ensureAnchorHandles(square, 1) // convert the [10,0] corner
    const A = getAnchors(out)
    const pos = (r: { ei: number; pi: number }) => out[r.ei]![r.pi] as Vec2
    const offAnchor = (a: typeof A[number], r: typeof A[number]["inHandle"]) =>
        Math.hypot(pos(r!)[0] - a.pos[0], pos(r!)[1] - a.pos[1])

    // The converted anchor gets both handles, pulled off the anchor.
    assert.ok(A[1]!.inHandle && offAnchor(A[1]!, A[1]!.inHandle) > 1e-6, "anchor1 in-handle pulled out")
    assert.ok(A[1]!.outHandle && offAnchor(A[1]!, A[1]!.outHandle) > 1e-6, "anchor1 out-handle pulled out")
    // Each neighbour's handle (if present) is retracted onto it → stays a corner.
    assert.ok(!A[0]!.outHandle || offAnchor(A[0]!, A[0]!.outHandle) < 1e-9, "anchor0 no stray handle")
    assert.ok(!A[2]!.inHandle || offAnchor(A[2]!, A[2]!.inHandle) < 1e-9, "anchor2 no stray handle")
})

// ── parseNodeType (persistence tag validation) ─────────────────────────

test("parseNodeType: accepts known tags, rejects junk", () => {
    assert.equal(parseNodeType("smart"), "smart")
    assert.equal(parseNodeType("symmetric"), "symmetric")
    assert.equal(parseNodeType("bogus"), null)
    assert.equal(parseNodeType(null), null)
    assert.equal(parseNodeType(undefined), null)
})
