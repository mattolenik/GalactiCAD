import assert from "node:assert/strict"
import test from "node:test"
import { extrude, polygon2d, translate, twist, scale } from "../scene.mjs"
import {
    FG_FLAG_ALIVE,
    FG_FLAG_CORNER,
    FG_FLAG_CREASE_ORIGINAL,
    FG_FLAG_NON_AFFINE_ANCESTOR,
    FeatureGraphBuilder,
} from "../feature-graph-buffer.mjs"
import { Vec3f } from "../../vecmat/vector.mjs"

/**
 * A right triangle in the XZ plane — all three vertices are sharp (right
 * angles aren't sharp by `dot < 0.95` for adjacent right-angle outward
 * normals; let me pick an obtuse / acute mix so they all qualify).
 *
 * Side lengths chosen so each polygon-vertex turn-angle produces a dihedral
 * between adjacent side faces with `dot(n0, n1) < 0.95`. A near-equilateral
 * triangle (60° internal angles → 120° external) has adjacent outward
 * normals 60° apart → `cos 60° = 0.5` ≪ 0.95 → sharp by our threshold.
 */
const TRIANGLE: [number, number][] = [
    [0, 0],
    [10, 0],
    [5, 8],
]

test("Extrude.accumulateFeatureGraph: triangle emits 6 verts, 9 edges, 2 loops", () => {
    const root = extrude.profile(polygon2d(TRIANGLE)).height(5)
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()

    assert.equal(cpu.vertexCount, 6, "two corners per polygon vertex (top + bottom) × 3 vertices")
    // 3 top cap edges + 3 bottom cap edges + 3 vertical side edges (all sharp)
    assert.equal(cpu.edgeCount, 9, "3 top + 3 bottom + 3 vertical")
    assert.equal(cpu.loopCount, 2, "one cap loop top, one bottom")
    // Slot 0 is the implicit-root identity; no operator added more frames.
    assert.equal(cpu.transformCount, 1, "no transform operators, only the implicit root frame")
})

test("Extrude.accumulateFeatureGraph: all sharp polygon vertices get FG_FLAG_CORNER", () => {
    const root = extrude.profile(polygon2d(TRIANGLE)).height(5)
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()

    for (let i = 0; i < cpu.vertexCount; i++) {
        const f = cpu.vertexFlags[i]!
        assert.ok((f & FG_FLAG_ALIVE) !== 0, `vertex ${i} alive`)
        assert.ok((f & FG_FLAG_CORNER) !== 0, `vertex ${i} corner flag set (acute/obtuse triangle)`)
        assert.ok((f & FG_FLAG_CREASE_ORIGINAL) !== 0, `vertex ${i} crease_original flag set`)
    }
})

test("Extrude.accumulateFeatureGraph: top/bottom vertex positions match polygon × ±h", () => {
    const root = extrude.profile(polygon2d(TRIANGLE)).height(5)
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()

    // The extractor emits top then bottom per polygon vertex, in polygon order.
    // Top y = +h = +5, bottom y = -h = -5; XZ should match the polygon vertex.
    const pos = (i: number) => [
        cpu.vertexPositions[i * 3]!,
        cpu.vertexPositions[i * 3 + 1]!,
        cpu.vertexPositions[i * 3 + 2]!,
    ]
    assert.deepEqual(pos(0), [0, 5, 0], "polygon vertex 0 top")
    assert.deepEqual(pos(1), [0, -5, 0], "polygon vertex 0 bottom")
    assert.deepEqual(pos(2), [10, 5, 0], "polygon vertex 1 top")
    assert.deepEqual(pos(3), [10, -5, 0], "polygon vertex 1 bottom")
    assert.deepEqual(pos(4), [5, 5, 8], "polygon vertex 2 top")
    assert.deepEqual(pos(5), [5, -5, 8], "polygon vertex 2 bottom")
})

test("Extrude.accumulateFeatureGraph: cap loops have +Y / -Y normals", () => {
    const root = extrude.profile(polygon2d(TRIANGLE)).height(5)
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()

    const loop0Normal = [
        cpu.loopNormals[0]!,
        cpu.loopNormals[1]!,
        cpu.loopNormals[2]!,
    ]
    const loop1Normal = [
        cpu.loopNormals[3]!,
        cpu.loopNormals[4]!,
        cpu.loopNormals[5]!,
    ]
    assert.deepEqual(loop0Normal, [0, 1, 0], "top loop +Y normal")
    assert.deepEqual(loop1Normal, [0, -1, 0], "bottom loop -Y normal")

    // Top loop preserves polygon order; bottom loop is reversed so its winding
    // agrees with the -Y outward normal.
    const start0 = cpu.loopIndexStart[0]!
    const count0 = cpu.loopIndexCount[0]!
    const start1 = cpu.loopIndexStart[1]!
    const count1 = cpu.loopIndexCount[1]!
    assert.equal(count0, 3)
    assert.equal(count1, 3)
    const top = [
        cpu.loopVertexIndices[start0]!,
        cpu.loopVertexIndices[start0 + 1]!,
        cpu.loopVertexIndices[start0 + 2]!,
    ]
    const bot = [
        cpu.loopVertexIndices[start1]!,
        cpu.loopVertexIndices[start1 + 1]!,
        cpu.loopVertexIndices[start1 + 2]!,
    ]
    assert.deepEqual(top, [0, 2, 4], "top loop: 0→2→4 (top verts in polygon order)")
    assert.deepEqual(bot, [5, 3, 1], "bottom loop: reversed bottom verts")
})

test("Extrude.accumulateFeatureGraph: each vertex carries 3 source-face normals", () => {
    const root = extrude.profile(polygon2d(TRIANGLE)).height(5)
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()

    for (let i = 0; i < cpu.vertexCount; i++) {
        assert.equal(cpu.vertexNormalCount[i]!, 3, `vertex ${i} normal count = 3`)
    }
    // Top vertex 0 (polygon vertex 0) — first normal should be top cap (+Y).
    assert.equal(cpu.vertexNormals[0]!, 0, "top vertex first-normal x")
    assert.equal(cpu.vertexNormals[1]!, 1, "top vertex first-normal y")
    assert.equal(cpu.vertexNormals[2]!, 0, "top vertex first-normal z")
    // Bottom vertex 1 — first normal should be bottom cap (-Y).
    assert.equal(cpu.vertexNormals[9]!, 0, "bottom vertex first-normal x")
    assert.equal(cpu.vertexNormals[10]!, -1, "bottom vertex first-normal y")
    assert.equal(cpu.vertexNormals[11]!, 0, "bottom vertex first-normal z")
})

test("Extrude under Twist: non-affine gate produces zero emission", () => {
    const root = twist(45, extrude.profile(polygon2d(TRIANGLE)).height(5))
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()

    assert.equal(cpu.vertexCount, 0, "twist ancestor → no vertices emitted")
    assert.equal(cpu.edgeCount, 0)
    assert.equal(cpu.loopCount, 0)
    // Frame interning is lazy — slots are only reserved at emit time, so a
    // subtree that emits nothing also interns nothing. Just the slot-0 root.
    assert.equal(cpu.transformCount, 1, "no emission → no transform frames beyond root")
})

test("FeatureGraphBuilder.pushNonAffine: emitter that runs anyway tags vertices with non-affine flag", () => {
    // Direct test of the builder gate semantics: pushNonAffine() doesn't block
    // emission, it just sets the flag. The Extrude extractor checks
    // hasNonAffineAncestor() and bails — but if it didn't, the flag would
    // propagate. Verify that path explicitly so the bit-layout invariant holds.
    const builder = new FeatureGraphBuilder()
    builder.pushNonAffine()
    builder.beginNode(0)
    const idx = builder.emitVertex(new Vec3f([1, 2, 3]), FG_FLAG_CREASE_ORIGINAL, [])
    builder.endNode()
    builder.pop()
    const cpu = builder.finish()
    assert.equal(idx, 0)
    assert.equal(cpu.vertexCount, 1)
    assert.ok(
        (cpu.vertexFlags[0]! & FG_FLAG_NON_AFFINE_ANCESTOR) !== 0,
        "vertex inherits non-affine flag from the current stack frame",
    )
})

test("Extrude with .twist(45): top corners rotated, bottom corners unrotated", () => {
    const root = extrude.profile(polygon2d(TRIANGLE)).height(5).twist(45)
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()

    // 3 polygon vertices × (top + bottom corners) + helical intermediate
    // vertices on the 3 side edges. At 45°, helixSegments = ceil(45/10) = 5,
    // so each side edge contributes (5 - 1) = 4 intermediate vertices.
    // 6 corners + 3 × 4 intermediates = 18 vertices.
    assert.equal(cpu.vertexCount, 18, "6 corners + 12 helical intermediates")

    // Bottom corners are unrotated — match the original polygon (with pos).
    // Vertex emission order is interleaved (top, bot) per polygon vertex.
    // So index 1 = bot corner 0, index 3 = bot 1, index 5 = bot 2.
    const pos = (i: number) => [
        cpu.vertexPositions[i * 3]!,
        cpu.vertexPositions[i * 3 + 1]!,
        cpu.vertexPositions[i * 3 + 2]!,
    ]
    assert.deepEqual(pos(1), [0, -5, 0], "bot corner 0 unrotated")
    assert.deepEqual(pos(3), [10, -5, 0], "bot corner 1 unrotated")
    assert.deepEqual(pos(5), [5, -5, 8], "bot corner 2 unrotated")

    // Top corners are rotated by +45° around the extrude's Y axis.
    // Rotation by 45°: (x, z) → (x*cos45 - z*sin45, x*sin45 + z*cos45)
    const ca = Math.cos(Math.PI / 4)
    const sa = Math.sin(Math.PI / 4)
    const rotated = (vx: number, vz: number) => [vx * ca - vz * sa, 5, vx * sa + vz * ca]
    const approx = (a: number[], b: number[], eps = 1e-5) => {
        for (let i = 0; i < 3; i++) assert.ok(Math.abs(a[i]! - b[i]!) < eps, `[${i}] ${a[i]} ≈ ${b[i]}`)
    }
    approx(pos(0), rotated(0, 0))
    approx(pos(2), rotated(10, 0))
    approx(pos(4), rotated(5, 8))
})

test("Extrude with .twist(0): no helical subdivision; behaves identically to untwisted case", () => {
    const root = extrude.profile(polygon2d(TRIANGLE)).height(5).twist(0)
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()
    assert.equal(cpu.vertexCount, 6, "no intermediates when twist=0")
    assert.equal(cpu.edgeCount, 9, "3 top cap + 3 bot cap + 3 vertical")
})

test("Extrude under Translate: transform stack records affine matrix", () => {
    const root = translate([10, 0, 0], extrude.profile(polygon2d(TRIANGLE)).height(5))
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()

    assert.equal(cpu.vertexCount, 6, "translate is affine — emission proceeds")
    // Slot 0 identity + slot 1 translate(10, 0, 0).
    assert.equal(cpu.transformCount, 2)
    // All vertices reference slot 1.
    for (let i = 0; i < cpu.vertexCount; i++) {
        assert.equal(cpu.vertexTransformIdx[i]!, 1, `vertex ${i} uses translate frame`)
    }
    // Local positions are unchanged (transform applied at stage 2, not here).
    const localPos0 = [
        cpu.vertexPositions[0]!,
        cpu.vertexPositions[1]!,
        cpu.vertexPositions[2]!,
    ]
    assert.deepEqual(localPos0, [0, 5, 0], "local position unchanged by transform stack")
    // Translate matrix column-major: m[12,13,14] = (dx, dy, dz).
    assert.equal(cpu.transforms[1 * 16 + 12]!, 10, "translate frame m[12] = dx")
    assert.equal(cpu.transforms[1 * 16 + 13]!, 0)
    assert.equal(cpu.transforms[1 * 16 + 14]!, 0)
})

test("Extrude under Scale: transform stack records scale matrix", () => {
    const root = scale([2, 1, 1], extrude.profile(polygon2d(TRIANGLE)).height(5))
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()

    assert.equal(cpu.vertexCount, 6)
    assert.equal(cpu.transforms[1 * 16 + 0]!, 2, "scale frame m[0] = sx")
    assert.equal(cpu.transforms[1 * 16 + 5]!, 1, "scale frame m[5] = sy")
    assert.equal(cpu.transforms[1 * 16 + 10]!, 1, "scale frame m[10] = sz")
})
