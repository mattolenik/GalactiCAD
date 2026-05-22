import assert from "node:assert/strict"
import test from "node:test"
import {
    applyTransformsCpu,
    bisectMixedEdgesCpu,
    FG_FLAG_ALIVE,
    FG_FLAG_CORNER,
    FG_FLAG_CREASE_ORIGINAL,
    FG_FLAG_CREASE_SUBDIVIDED,
    subdivideEdgesCpu,
} from "./feature-graph-stages.mjs"
import {
    FeatureGraphBuilder,
    mat4FromScale,
    mat4FromTranslation,
} from "../scene/feature-graph-buffer.mjs"
import { Vec3f } from "../vecmat/vector.mjs"

function buildLine(ax: number, ay: number, az: number, bx: number, by: number, bz: number) {
    const builder = new FeatureGraphBuilder()
    builder.beginNode(7)
    const a = builder.emitVertex(new Vec3f([ax, ay, az]), FG_FLAG_CREASE_ORIGINAL | FG_FLAG_CORNER, [
        new Vec3f([1, 0, 0]),
        new Vec3f([0, 1, 0]),
    ])
    const b = builder.emitVertex(new Vec3f([bx, by, bz]), FG_FLAG_CREASE_ORIGINAL | FG_FLAG_CORNER, [
        new Vec3f([1, 0, 0]),
        new Vec3f([0, 1, 0]),
    ])
    const e = builder.emitEdge(a, b, FG_FLAG_CREASE_ORIGINAL)
    builder.endNode()
    return { cpu: builder.finish(), a, b, e }
}

test("subdivideEdgesCpu: short edge (≤ targetSeg) passes through unchanged", () => {
    const { cpu } = buildLine(0, 0, 0, 0.4, 0, 0)
    const world = applyTransformsCpu(cpu)
    // cellSize = 1.0 → targetSeg = 0.5; edge length 0.4 < 0.5 → no subdivision
    const next = subdivideEdgesCpu(cpu, world, 1.0)
    assert.equal(next.cpu.vertexCount, 2, "no new vertices")
    assert.equal(next.cpu.edgeCount, 1, "edge count unchanged")
    assert.ok((next.cpu.edgeFlags[0]! & FG_FLAG_ALIVE) !== 0, "original edge still alive")
})

test("subdivideEdgesCpu: 10-unit edge with cellSize=1 → 20 segments, 19 new vertices", () => {
    const { cpu } = buildLine(0, 0, 0, 10, 0, 0)
    const world = applyTransformsCpu(cpu)
    // cellSize = 1.0 → targetSeg = 0.5; edge length 10 → ceil(10/0.5) = 20 segments
    const next = subdivideEdgesCpu(cpu, world, 1.0)
    assert.equal(next.cpu.vertexCount, 2 + 19, "2 original + 19 intermediate vertices")
    assert.equal(next.cpu.edgeCount, 1 + 20, "1 original (dead) + 20 new edges")
    assert.equal(
        next.cpu.edgeFlags[0]! & FG_FLAG_ALIVE,
        0,
        "original edge marked dead",
    )
    for (let e = 1; e < next.cpu.edgeCount; e++) {
        const f = next.cpu.edgeFlags[e]!
        assert.ok((f & FG_FLAG_ALIVE) !== 0, `new edge ${e} alive`)
        assert.ok((f & FG_FLAG_CREASE_SUBDIVIDED) !== 0, `new edge ${e} flagged subdivided`)
        assert.ok((f & FG_FLAG_CREASE_ORIGINAL) !== 0, `new edge ${e} inherits crease-original lineage`)
    }
})

test("subdivideEdgesCpu: intermediate vertices linearly interpolated, never corners", () => {
    const { cpu } = buildLine(0, 0, 0, 10, 0, 0)
    const world = applyTransformsCpu(cpu)
    const next = subdivideEdgesCpu(cpu, world, 1.0)
    // 20 segments of length 0.5 → intermediate xs at 0.5, 1.0, …, 9.5
    for (let k = 0; k < 19; k++) {
        const slot = 2 + k
        const expectedX = 0.5 * (k + 1)
        assert.ok(
            Math.abs(next.world.positions[slot * 3]! - expectedX) < 1e-5,
            `vertex ${slot} x ≈ ${expectedX}`,
        )
        const f = next.cpu.vertexFlags[slot]!
        assert.ok((f & FG_FLAG_ALIVE) !== 0, `intermediate ${slot} alive`)
        assert.ok((f & FG_FLAG_CREASE_SUBDIVIDED) !== 0, `intermediate ${slot} flagged subdivided`)
        assert.equal(
            f & FG_FLAG_CORNER,
            0,
            `intermediate ${slot} never gets corner flag (0D feature only on primitive vertices)`,
        )
    }
})

test("subdivideEdgesCpu: new edges form contiguous chain va → mid1 → … → mid_{n-1} → vb", () => {
    const { cpu, a, b } = buildLine(0, 0, 0, 4, 0, 0)
    const world = applyTransformsCpu(cpu)
    // cellSize = 1.0 → targetSeg = 0.5; length 4 → 8 segments → 7 intermediate
    const next = subdivideEdgesCpu(cpu, world, 1.0)
    assert.equal(next.cpu.vertexCount, 2 + 7)
    assert.equal(next.cpu.edgeCount, 1 + 8)
    // First new edge starts at a (original endpoint), last ends at b.
    const firstNewEdge = 1
    const lastNewEdge = next.cpu.edgeCount - 1
    assert.equal(next.cpu.edgeEndpoints[firstNewEdge * 2]!, a)
    assert.equal(next.cpu.edgeEndpoints[lastNewEdge * 2 + 1]!, b)
    // Chain: each new edge's vb is the next edge's va.
    for (let e = firstNewEdge; e < lastNewEdge; e++) {
        assert.equal(
            next.cpu.edgeEndpoints[e * 2 + 1]!,
            next.cpu.edgeEndpoints[(e + 1) * 2]!,
            `edge ${e} → ${e + 1} share endpoint`,
        )
    }
})

test("bisectMixedEdgesCpu: alive-dead edge → boundary vertex at SDF linear-interp crossing", () => {
    const { cpu, a, b, e } = buildLine(0, 0, 0, 10, 0, 0)
    const world = applyTransformsCpu(cpu)
    // Fabricate an SDF result where `a` is alive (d=-0.1) and `b` is dead (d=+0.9).
    // Surface crossing at t = -0.1 / (-0.1 - 0.9) = 0.1 → boundary at x = 1.0.
    const sdf = new Float32Array(2 * 4)
    sdf[a * 4 + 3] = -0.1
    sdf[b * 4 + 3] = 0.9
    // Mark `a` alive, `b` dead.
    cpu.vertexFlags[b] = cpu.vertexFlags[b]! & ~FG_FLAG_ALIVE

    const next = bisectMixedEdgesCpu(cpu, world, sdf, 0.5)
    assert.equal(next.cpu.vertexCount, 3, "one boundary vertex appended")
    assert.equal(next.cpu.edgeCount, 2, "one alive partial edge appended")
    // Boundary vertex at x ≈ 1.0.
    assert.ok(
        Math.abs(next.world.positions[2 * 3]! - 1.0) < 1e-5,
        "boundary vertex x ≈ 1.0 (linear-interp crossing)",
    )
    // Boundary vertex is alive + crease_subdivided, never corner.
    const bvFlags = next.cpu.vertexFlags[2]!
    assert.ok((bvFlags & FG_FLAG_ALIVE) !== 0, "boundary vertex alive")
    assert.ok((bvFlags & FG_FLAG_CREASE_SUBDIVIDED) !== 0, "boundary vertex flagged subdivided")
    assert.equal(bvFlags & FG_FLAG_CORNER, 0, "boundary vertex never corner")
    // Original edge dead.
    assert.equal(next.cpu.edgeFlags[e]! & FG_FLAG_ALIVE, 0, "original mixed edge marked dead")
    // New alive edge: alive endpoint → boundary vertex.
    const ne = 1
    assert.equal(next.cpu.edgeEndpoints[ne * 2]!, a, "new alive edge starts at alive endpoint")
    assert.equal(next.cpu.edgeEndpoints[ne * 2 + 1]!, 2, "new alive edge ends at boundary vertex")
    assert.ok((next.cpu.edgeFlags[ne]! & FG_FLAG_ALIVE) !== 0, "new partial edge alive")
})

test("bisectMixedEdgesCpu: both endpoints alive → no boundary inserted", () => {
    const { cpu, e } = buildLine(0, 0, 0, 10, 0, 0)
    const world = applyTransformsCpu(cpu)
    const sdf = new Float32Array(2 * 4)
    sdf[0 * 4 + 3] = 0
    sdf[1 * 4 + 3] = 0
    // Both vertices already alive from builder default.
    const next = bisectMixedEdgesCpu(cpu, world, sdf, 0.5)
    assert.equal(next.cpu.vertexCount, 2, "no growth")
    assert.equal(next.cpu.edgeCount, 1, "no new edges")
    assert.ok((next.cpu.edgeFlags[e]! & FG_FLAG_ALIVE) !== 0, "original edge still alive")
})

test("bisectMixedEdgesCpu: both endpoints dead → edge unchanged (cascade handles in orchestrator)", () => {
    const { cpu, a, b, e } = buildLine(0, 0, 0, 10, 0, 0)
    const world = applyTransformsCpu(cpu)
    const sdf = new Float32Array(2 * 4)
    sdf[a * 4 + 3] = 5
    sdf[b * 4 + 3] = 7
    cpu.vertexFlags[a] = cpu.vertexFlags[a]! & ~FG_FLAG_ALIVE
    cpu.vertexFlags[b] = cpu.vertexFlags[b]! & ~FG_FLAG_ALIVE
    const next = bisectMixedEdgesCpu(cpu, world, sdf, 0.5)
    // No growth — bisection only triggers on mixed pairs.
    assert.equal(next.cpu.vertexCount, 2)
    assert.equal(next.cpu.edgeCount, 1)
    // Edge stays alive at this stage (the orchestrator's cascade pass clears
    // the flag for both-dead edges after bisection).
    assert.ok((next.cpu.edgeFlags[e]! & FG_FLAG_ALIVE) !== 0)
})

test("applyTransformsCpu: identity transform leaves normals unchanged", () => {
    const builder = new FeatureGraphBuilder()
    builder.beginNode(0)
    builder.emitVertex(new Vec3f([1, 2, 3]), FG_FLAG_CORNER, [
        new Vec3f([1, 0, 0]),
        new Vec3f([0, 1, 0]),
        new Vec3f([0, 0, 1]),
    ])
    builder.endNode()
    const cpu = builder.finish()
    applyTransformsCpu(cpu)
    assert.deepEqual([...cpu.vertexNormals.slice(0, 9)], [1, 0, 0, 0, 1, 0, 0, 0, 1])
})

test("applyTransformsCpu: translation does not rotate normals", () => {
    const builder = new FeatureGraphBuilder()
    builder.pushAffine(mat4FromTranslation(10, 20, 30))
    builder.beginNode(0)
    builder.emitVertex(new Vec3f([0, 0, 0]), FG_FLAG_CORNER, [new Vec3f([0, 1, 0])])
    builder.endNode()
    builder.pop()
    const cpu = builder.finish()
    const world = applyTransformsCpu(cpu)
    assert.deepEqual([...world.positions], [10, 20, 30])
    assert.deepEqual([...cpu.vertexNormals.slice(0, 3)], [0, 1, 0])
})

test("applyTransformsCpu: non-uniform scale rotates normals by the inverse-transpose", () => {
    // Under scale (2,1,1) a surface with local normal (1,1,0)/√2 — local plane
    // x+y=const — maps to world plane X/2+Y=const ⇒ X+2Y=const, world normal
    // ∝ (1,2,0). The cofactor-matrix path must reproduce that (normalised).
    const s = 1 / Math.SQRT2
    const builder = new FeatureGraphBuilder()
    builder.pushAffine(mat4FromScale(2, 1, 1))
    builder.beginNode(0)
    builder.emitVertex(new Vec3f([3, 5, 0]), FG_FLAG_CORNER, [new Vec3f([s, s, 0])])
    builder.endNode()
    builder.pop()
    const cpu = builder.finish()
    const world = applyTransformsCpu(cpu)
    assert.deepEqual([...world.positions], [6, 5, 0])
    const inv5 = 1 / Math.sqrt(5)
    const nx = cpu.vertexNormals[0]!, ny = cpu.vertexNormals[1]!, nz = cpu.vertexNormals[2]!
    assert.ok(Math.abs(nx - inv5) < 1e-6, `nx ${nx} ≈ 1/√5`)
    assert.ok(Math.abs(ny - 2 * inv5) < 1e-6, `ny ${ny} ≈ 2/√5`)
    assert.equal(nz, 0)
})
