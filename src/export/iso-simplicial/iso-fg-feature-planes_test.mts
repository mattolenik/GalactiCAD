import assert from "node:assert/strict"
import test from "node:test"
import {
    closestPointOnSegment,
    collectFgPlaneSources,
    injectCubeFgFeaturePlanes,
    injectEdgeFgFeaturePlanes,
    injectFaceFgFeaturePlanes,
    pointAabbDistance,
    type FgPlaneInjectionContext,
    type FgPlaneSource,
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

/** Identity world↔normalized context with a loose gate (distFactor 2). */
const CTX2: FgPlaneInjectionContext = { rootMinX: 0, rootMinY: 0, rootMinZ: 0, worldScale: 1, distFactor: 2 }
/** Identity context with the default tight gate (distFactor 0). */
const CTX0: FgPlaneInjectionContext = { rootMinX: 0, rootMinY: 0, rootMinZ: 0, worldScale: 1, distFactor: 0 }

/** Collect sources over the unit cell [0,1]³. */
function collectUnit(fg: FgCellFeatures, ctx: FgPlaneInjectionContext): FgPlaneSource[] {
    return collectFgPlaneSources(fg, ctx, 0, 0, 0, 1, 1, 1, 1)
}

/** Per-element approximate equality — FG positions round-trip through Float32Array. */
function assertApprox(actual: ArrayLike<number>, expected: number[], eps = 1e-6): void {
    assert.equal(actual.length, expected.length)
    for (let i = 0; i < expected.length; i++) {
        assert.ok(Math.abs(actual[i]! - expected[i]!) < eps, `[${i}] ${actual[i]} ≈ ${expected[i]}`)
    }
}

// ── helpers ──────────────────────────────────────────────────────────────────

test("pointAabbDistance: zero inside, axis distance outside, corner distance", () => {
    assert.equal(pointAabbDistance(0.5, 0.5, 0.5, 0, 0, 0, 1, 1, 1), 0)
    assert.equal(pointAabbDistance(3, 0.5, 0.5, 0, 0, 0, 1, 1, 1), 2)
    assert.equal(pointAabbDistance(4, 5, 0.5, 0, 0, 0, 1, 1, 1), 5) // (3,4,0) → 5
})

test("closestPointOnSegment: mid-projection, endpoint clamp, degenerate segment", () => {
    const out: [number, number, number] = [0, 0, 0]
    closestPointOnSegment(0.5, 9, 0, 0, 0, 0, 1, 0, 0, out)
    assert.deepEqual(out, [0.5, 0, 0])
    closestPointOnSegment(-5, 0, 0, 0, 0, 0, 1, 0, 0, out)
    assert.deepEqual(out, [0, 0, 0])
    closestPointOnSegment(5, 0, 0, 0, 0, 0, 1, 0, 0, out)
    assert.deepEqual(out, [1, 0, 0])
    closestPointOnSegment(9, 9, 9, 2, 2, 2, 2, 2, 2, out)
    assert.deepEqual(out, [2, 2, 2])
})

// ── collectFgPlaneSources ────────────────────────────────────────────────────

test("collectFgPlaneSources: empty features → no sources", () => {
    assert.equal(collectUnit(emptyFgCellFeatures(), CTX2).length, 0)
})

test("collectFgPlaneSources: corner inside the cell → one source with its normals", () => {
    const s = collectUnit(makeFeatures([{ pos: [0.3, 0.4, 0.5], normals: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }]), CTX2)
    assert.equal(s.length, 1)
    assertApprox([s[0]!.px, s[0]!.py, s[0]!.pz], [0.3, 0.4, 0.5])
    assert.equal(s[0]!.normalCount, 3)
    assert.deepEqual(s[0]!.normals, [1, 0, 0, 0, 1, 0, 0, 0, 1])
})

test("collectFgPlaneSources: distFactor 0 — corner outside cell excluded, inside kept", () => {
    assert.equal(collectUnit(makeFeatures([{ pos: [1.2, 0.5, 0.5], normals: [[1, 0, 0]] }]), CTX0).length, 0)
    assert.equal(collectUnit(makeFeatures([{ pos: [0.5, 0.5, 0.5], normals: [[1, 0, 0]] }]), CTX0).length, 1)
})

test("collectFgPlaneSources: subdivided segments of one crease collapse to one source", () => {
    const s = collectUnit(makeFeatures([], [
        { a: [0.3, 0.7, 0.0], b: [0.3, 0.7, 0.3], normals: [[1, 0, 0], [0, 1, 0]] },
        { a: [0.3, 0.7, 0.3], b: [0.3, 0.7, 0.6], normals: [[1, 0, 0], [0, 1, 0]] },
        { a: [0.3, 0.7, 0.6], b: [0.3, 0.7, 1.0], normals: [[1, 0, 0], [0, 1, 0]] },
    ]), CTX2)
    assert.equal(s.length, 1, "one crease → one source regardless of subdivision")
    assert.equal(s[0]!.normalCount, 2)
})

test("collectFgPlaneSources: two distinct creases stay separate", () => {
    const s = collectUnit(makeFeatures([], [
        { a: [0.3, 0.7, 0.0], b: [0.3, 0.7, 1.0], normals: [[1, 0, 0], [0, 1, 0]] },
        { a: [0.6, 0.2, 0.0], b: [0.6, 0.2, 1.0], normals: [[0, 0, 1], [0, 1, 0]] },
    ]), CTX2)
    assert.equal(s.length, 2)
})

test("collectFgPlaneSources: worldScale conversion maps world point to normalized frame", () => {
    // Root origin (10,10,10), edge 4 → world (12,11,13) → normalized (0.5,0.25,0.75).
    const ctx: FgPlaneInjectionContext = { rootMinX: 10, rootMinY: 10, rootMinZ: 10, worldScale: 4, distFactor: 2 }
    const s = collectFgPlaneSources(makeFeatures([{ pos: [12, 11, 13], normals: [[1, 0, 0]] }]), ctx, 0, 0, 0, 1, 1, 1, 1)
    assert.equal(s.length, 1)
    assertApprox([s[0]!.px, s[0]!.py, s[0]!.pz], [0.5, 0.25, 0.75])
})

// ── injectCubeFgFeaturePlanes ────────────────────────────────────────────────

test("injectCubeFgFeaturePlanes: one plane per normal, encoded at the source point", () => {
    const s = collectUnit(makeFeatures([{ pos: [0.3, 0.4, 0.5], normals: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }]), CTX2)
    const packed = zeroQefPacked(4)
    const n: [number, number, number, number][] = []
    const p: [number, number, number, number][] = []
    assert.equal(injectCubeFgFeaturePlanes(s, packed, n, p), 3)
    assert.deepEqual(n, [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]])
    for (const pt of p) assertApprox(pt, [0.3, 0.4, 0.5, 0])
})

test("injectCubeFgFeaturePlanes: empty source list → 0 planes", () => {
    const packed = zeroQefPacked(4)
    assert.equal(injectCubeFgFeaturePlanes([], packed, [], []), 0)
})

// ── injectEdgeFgFeaturePlanes ────────────────────────────────────────────────

test("injectEdgeFgFeaturePlanes: normal along the edge axis → xiHit at the source's axis coord", () => {
    const s = collectUnit(makeFeatures([{ pos: [0.3, 0.4, 0.5], normals: [[1, 0, 0]] }]), CTX2)
    const packed = zeroQefPacked(2)
    const n: [number, number][] = []
    const p: [number, number][] = []
    // Edge along x (xi=0), fixed (yEdge,zEdge) = (0,0).
    assert.equal(injectEdgeFgFeaturePlanes(s, 0, 1, 2, 0, 0, packed, n, p), 1)
    assert.deepEqual(n, [[1, 0]])
    assertApprox(p[0]!, [0.3, 0])
})

test("injectEdgeFgFeaturePlanes: normal perpendicular to the edge axis is skipped", () => {
    const s = collectUnit(makeFeatures([{ pos: [0.3, 0.4, 0.5], normals: [[0, 1, 0]] }]), CTX2)
    const packed = zeroQefPacked(2)
    const n: [number, number][] = []
    const p: [number, number][] = []
    // Edge along x: n[xi=0] = 0 → no constraint.
    assert.equal(injectEdgeFgFeaturePlanes(s, 0, 1, 2, 0, 0, packed, n, p), 0)
})

// ── injectFaceFgFeaturePlanes ────────────────────────────────────────────────

test("injectFaceFgFeaturePlanes: in-face normal → 2D plane at the source's in-face coords", () => {
    const s = collectUnit(makeFeatures([{ pos: [0.3, 0.4, 0.5], normals: [[1, 0, 0]] }]), CTX2)
    const packed = zeroQefPacked(3)
    const n: [number, number, number][] = []
    const p: [number, number, number][] = []
    // Face varying (xi,yi)=(0,1), fixed zi=2 at zFace=0.5.
    assert.equal(injectFaceFgFeaturePlanes(s, 0, 1, 2, 0.5, packed, n, p), 1)
    assert.deepEqual(n, [[1, 0, 0]])
    assertApprox(p[0]!, [0.3, 0.4, 0])
})

test("injectFaceFgFeaturePlanes: normal parallel to the face plane is skipped", () => {
    const s = collectUnit(makeFeatures([{ pos: [0.3, 0.4, 0.5], normals: [[0, 0, 1]] }]), CTX2)
    const packed = zeroQefPacked(3)
    const n: [number, number, number][] = []
    const p: [number, number, number][] = []
    // Face varying (xi,yi)=(0,1): normal (0,0,1) has n[xi]=n[yi]=0 → skipped.
    assert.equal(injectFaceFgFeaturePlanes(s, 0, 1, 2, 0.5, packed, n, p), 0)
})
