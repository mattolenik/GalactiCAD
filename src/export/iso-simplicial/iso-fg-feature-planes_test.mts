import assert from "node:assert/strict"
import test from "node:test"
import {
    closestPointOnSegment,
    injectCubeFgFeaturePlanes,
    pointAabbDistance,
    type FgPlaneInjectionContext,
} from "./iso-fg-feature-planes.mjs"
import { zeroQefPacked } from "./qef-normal.mjs"
import type { FgCellFeatures } from "../../feature-graph/feature-graph-cell-query.mjs"
import { emptyFgCellFeatures } from "../../feature-graph/feature-graph-cell-query.mjs"

/** Build an `FgCellFeatures` from explicit corners + creases (normals padded to 9 floats). */
function makeFeatures(
    corners: { pos: [number, number, number]; normals: [number, number, number][] }[],
    creases: { a: [number, number, number]; b: [number, number, number]; normals: [number, number, number][] }[] = [],
): FgCellFeatures {
    const out = emptyFgCellFeatures()
    const cornerPositions = new Float32Array(corners.length * 3)
    const cornerNormals = new Float32Array(corners.length * 9)
    const cornerNormalCounts = new Uint32Array(corners.length)
    corners.forEach((c, i) => {
        cornerPositions.set(c.pos, i * 3)
        cornerNormalCounts[i] = c.normals.length
        c.normals.forEach((n, k) => cornerNormals.set(n, i * 9 + k * 3))
    })
    const creaseSegments = new Float32Array(creases.length * 6)
    const creaseNormals = new Float32Array(creases.length * 9)
    const creaseNormalCounts = new Uint32Array(creases.length)
    creases.forEach((c, i) => {
        creaseSegments.set([...c.a, ...c.b], i * 6)
        creaseNormalCounts[i] = c.normals.length
        c.normals.forEach((n, k) => creaseNormals.set(n, i * 9 + k * 3))
    })
    return {
        ...out,
        cornerPositions, cornerNormals, cornerNormalCounts, cornerCount: corners.length,
        creaseSegments, creaseNormals, creaseNormalCounts, creaseCount: creases.length,
    }
}

/** Identity world↔normalized context: world == normalized, gate = distFactor·cellSize. */
const IDENTITY_CTX: FgPlaneInjectionContext = { rootMinX: 0, rootMinY: 0, rootMinZ: 0, worldScale: 1, distFactor: 2 }

/** Per-element approximate equality — FG positions round-trip through Float32Array. */
function assertApprox(actual: ArrayLike<number>, expected: number[], eps = 1e-6): void {
    assert.equal(actual.length, expected.length)
    for (let i = 0; i < expected.length; i++) {
        assert.ok(Math.abs(actual[i]! - expected[i]!) < eps, `[${i}] ${actual[i]} ≈ ${expected[i]}`)
    }
}

test("pointAabbDistance: zero inside, axis distance outside, corner distance", () => {
    assert.equal(pointAabbDistance(0.5, 0.5, 0.5, 0, 0, 0, 1, 1, 1), 0)
    assert.equal(pointAabbDistance(3, 0.5, 0.5, 0, 0, 0, 1, 1, 1), 2)
    assert.equal(pointAabbDistance(4, 5, 0.5, 0, 0, 0, 1, 1, 1), 5) // (3,4,0) → 5
})

test("closestPointOnSegment: mid-projection, endpoint clamp, degenerate segment", () => {
    const out: [number, number, number] = [0, 0, 0]
    closestPointOnSegment(0.5, 9, 0, 0, 0, 0, 1, 0, 0, out)
    assert.deepEqual(out, [0.5, 0, 0]) // projects to mid, off-axis ignored
    closestPointOnSegment(-5, 0, 0, 0, 0, 0, 1, 0, 0, out)
    assert.deepEqual(out, [0, 0, 0]) // clamped to A
    closestPointOnSegment(5, 0, 0, 0, 0, 0, 1, 0, 0, out)
    assert.deepEqual(out, [1, 0, 0]) // clamped to B
    closestPointOnSegment(9, 9, 9, 2, 2, 2, 2, 2, 2, out)
    assert.deepEqual(out, [2, 2, 2]) // zero-length → endpoint A
})

test("injectCubeFgFeaturePlanes: empty features → 0 planes", () => {
    const packed = zeroQefPacked(4)
    const n: [number, number, number, number][] = []
    const p: [number, number, number, number][] = []
    const added = injectCubeFgFeaturePlanes(emptyFgCellFeatures(), IDENTITY_CTX, 0, 0, 0, 1, 1, 1, 1, packed, n, p)
    assert.equal(added, 0)
    assert.equal(n.length, 0)
})

test("injectCubeFgFeaturePlanes: corner inside cell → one plane per normal, encoded at the corner", () => {
    const fg = makeFeatures([{ pos: [0.3, 0.4, 0.5], normals: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }])
    const packed = zeroQefPacked(4)
    const n: [number, number, number, number][] = []
    const p: [number, number, number, number][] = []
    const added = injectCubeFgFeaturePlanes(fg, IDENTITY_CTX, 0, 0, 0, 1, 1, 1, 1, packed, n, p)
    assert.equal(added, 3, "3 normals → 3 planes")
    assert.deepEqual(n, [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]])
    // worldScale 1, rootMin 0 → plane point is the corner itself in all 3.
    for (const pt of p) assertApprox(pt, [0.3, 0.4, 0.5, 0])
})

test("injectCubeFgFeaturePlanes: distFactor 0 — corner just outside the cell is not injected", () => {
    // The default gate (distFactor 0) injects only features the cell contains,
    // so flat-face cells next to a feature edge are never pulled onto it.
    const ctx0: FgPlaneInjectionContext = { rootMinX: 0, rootMinY: 0, rootMinZ: 0, worldScale: 1, distFactor: 0 }
    const packed = zeroQefPacked(4)
    const n: [number, number, number, number][] = []
    const p: [number, number, number, number][] = []
    // Corner 0.2 outside the cell's +x face → distFactor 0 → gated out.
    const outside = makeFeatures([{ pos: [1.2, 0.5, 0.5], normals: [[1, 0, 0]] }])
    assert.equal(injectCubeFgFeaturePlanes(outside, ctx0, 0, 0, 0, 1, 1, 1, 1, packed, n, p), 0)
    // A corner inside the cell still injects at distFactor 0.
    const inside = makeFeatures([{ pos: [0.5, 0.5, 0.5], normals: [[1, 0, 0]] }])
    assert.equal(injectCubeFgFeaturePlanes(inside, ctx0, 0, 0, 0, 1, 1, 1, 1, packed, n, p), 1)
})

test("injectCubeFgFeaturePlanes: distance gate excludes a far corner", () => {
    const fg = makeFeatures([{ pos: [10, 10, 10], normals: [[1, 0, 0]] }])
    const packed = zeroQefPacked(4)
    const n: [number, number, number, number][] = []
    const p: [number, number, number, number][] = []
    // Cell [0,1]³, cellSize 1, distFactor 2 → threshold 2; corner ~15.6 away → gated.
    const added = injectCubeFgFeaturePlanes(fg, IDENTITY_CTX, 0, 0, 0, 1, 1, 1, 1, packed, n, p)
    assert.equal(added, 0)
})

test("injectCubeFgFeaturePlanes: crease → 2 planes through the closest point on the segment", () => {
    // Crease segment runs in z at x=0.3,y=0.7; cell centre (0.5,0.5,0.5) →
    // closest point (0.3,0.7,0.5).
    const fg = makeFeatures([], [{ a: [0.3, 0.7, 0.1], b: [0.3, 0.7, 0.9], normals: [[1, 0, 0], [0, 1, 0]] }])
    const packed = zeroQefPacked(4)
    const n: [number, number, number, number][] = []
    const p: [number, number, number, number][] = []
    const added = injectCubeFgFeaturePlanes(fg, IDENTITY_CTX, 0, 0, 0, 1, 1, 1, 1, packed, n, p)
    assert.equal(added, 2)
    assert.deepEqual(n, [[1, 0, 0, 0], [0, 1, 0, 0]])
    for (const pt of p) assertApprox(pt, [0.3, 0.7, 0.5, 0])
})

test("injectCubeFgFeaturePlanes: subdivided segments of one crease emit 2 planes, not 2-per-segment", () => {
    // Three colinear segments of the SAME crease (identical normals) — as the
    // FG subdivision produces. They must collapse to a single 2-plane
    // contribution, else the crease is over-weighted per cell → jagged edges.
    const fg = makeFeatures([], [
        { a: [0.3, 0.7, 0.0], b: [0.3, 0.7, 0.3], normals: [[1, 0, 0], [0, 1, 0]] },
        { a: [0.3, 0.7, 0.3], b: [0.3, 0.7, 0.6], normals: [[1, 0, 0], [0, 1, 0]] },
        { a: [0.3, 0.7, 0.6], b: [0.3, 0.7, 1.0], normals: [[1, 0, 0], [0, 1, 0]] },
    ])
    const packed = zeroQefPacked(4)
    const n: [number, number, number, number][] = []
    const p: [number, number, number, number][] = []
    const added = injectCubeFgFeaturePlanes(fg, IDENTITY_CTX, 0, 0, 0, 1, 1, 1, 1, packed, n, p)
    assert.equal(added, 2, "one crease → 2 planes regardless of subdivision count")
    assert.deepEqual(n, [[1, 0, 0, 0], [0, 1, 0, 0]])
})

test("injectCubeFgFeaturePlanes: two distinct creases stay separate (4 planes)", () => {
    const fg = makeFeatures([], [
        { a: [0.3, 0.7, 0.0], b: [0.3, 0.7, 1.0], normals: [[1, 0, 0], [0, 1, 0]] },
        { a: [0.6, 0.2, 0.0], b: [0.6, 0.2, 1.0], normals: [[0, 0, 1], [0, 1, 0]] },
    ])
    const packed = zeroQefPacked(4)
    const n: [number, number, number, number][] = []
    const p: [number, number, number, number][] = []
    const added = injectCubeFgFeaturePlanes(fg, IDENTITY_CTX, 0, 0, 0, 1, 1, 1, 1, packed, n, p)
    assert.equal(added, 4, "two distinct creases → 2 + 2 planes")
})

test("injectCubeFgFeaturePlanes: worldScale conversion maps world corner to normalized point", () => {
    // Root AABB origin (10,10,10), edge length 4. A world corner at (12,11,13)
    // → normalized ((12-10)/4, (11-10)/4, (13-10)/4) = (0.5, 0.25, 0.75).
    const ctx: FgPlaneInjectionContext = { rootMinX: 10, rootMinY: 10, rootMinZ: 10, worldScale: 4, distFactor: 2 }
    const fg = makeFeatures([{ pos: [12, 11, 13], normals: [[1, 0, 0]] }])
    const packed = zeroQefPacked(4)
    const n: [number, number, number, number][] = []
    const p: [number, number, number, number][] = []
    // Normalized cell AABB [0,1]³ (the whole root).
    const added = injectCubeFgFeaturePlanes(fg, ctx, 0, 0, 0, 1, 1, 1, 1, packed, n, p)
    assert.equal(added, 1)
    assert.equal(p[0]![0], 0.5)
    assert.equal(p[0]![1], 0.25)
    assert.equal(p[0]![2], 0.75)
})
