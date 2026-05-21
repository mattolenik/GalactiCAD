import assert from "node:assert/strict"
import test from "node:test"
import { box, subtract, translate, twist } from "../scene.mjs"
import {
    FeatureGraphBuilder,
    FG_FLAG_ALIVE,
    FG_FLAG_CORNER,
    FG_FLAG_CREASE_ORIGINAL,
} from "../feature-graph-buffer.mjs"

test("Box.accumulateFeatureGraph: 8 corners, 12 edges, 6 face loops", () => {
    const root = box([2, 4, 6])
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()
    assert.equal(cpu.vertexCount, 8)
    assert.equal(cpu.edgeCount, 12)
    assert.equal(cpu.loopCount, 6)
})

test("Box.accumulateFeatureGraph: every corner is FG_FLAG_CORNER with 3 face normals", () => {
    const root = box([2, 4, 6])
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()
    for (let i = 0; i < cpu.vertexCount; i++) {
        const f = cpu.vertexFlags[i]!
        assert.ok((f & FG_FLAG_ALIVE) !== 0)
        assert.ok((f & FG_FLAG_CORNER) !== 0, `corner ${i} has CORNER flag`)
        assert.ok((f & FG_FLAG_CREASE_ORIGINAL) !== 0, `corner ${i} has CREASE_ORIGINAL flag`)
        assert.equal(cpu.vertexNormalCount[i]!, 3, `corner ${i} carries 3 source-face normals`)
    }
})

test("Box.accumulateFeatureGraph: corner positions are (±hx, ±hy, ±hz) bit-encoded by (z,y,x)", () => {
    const root = box([2, 4, 6]) // half-extents (2, 4, 6) per existing Box constructor
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()
    // Index `i` packs (z, y, x). Sign per bit: 0 → -, 1 → +.
    for (let i = 0; i < 8; i++) {
        const xb = (i & 1) ? 1 : -1
        const yb = ((i >> 1) & 1) ? 1 : -1
        const zb = ((i >> 2) & 1) ? 1 : -1
        const expectedX = xb * 2
        const expectedY = yb * 4
        const expectedZ = zb * 6
        assert.equal(cpu.vertexPositions[i * 3]!, expectedX, `corner ${i} x`)
        assert.equal(cpu.vertexPositions[i * 3 + 1]!, expectedY, `corner ${i} y`)
        assert.equal(cpu.vertexPositions[i * 3 + 2]!, expectedZ, `corner ${i} z`)
    }
})

test("Box.accumulateFeatureGraph: corner 7 (+,+,+) carries (+X, +Y, +Z) face normals", () => {
    const root = box([2, 2, 2])
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()
    const NORMALS_PER_VERTEX = 3
    const stride = NORMALS_PER_VERTEX * 3
    // Corner 7 = (+x, +y, +z) → expect normals (+1,0,0), (0,+1,0), (0,0,+1).
    const base = 7 * stride
    assert.deepEqual(
        [cpu.vertexNormals[base + 0]!, cpu.vertexNormals[base + 1]!, cpu.vertexNormals[base + 2]!],
        [1, 0, 0],
        "corner 7 normal[0] = +X",
    )
    assert.deepEqual(
        [cpu.vertexNormals[base + 3]!, cpu.vertexNormals[base + 4]!, cpu.vertexNormals[base + 5]!],
        [0, 1, 0],
        "corner 7 normal[1] = +Y",
    )
    assert.deepEqual(
        [cpu.vertexNormals[base + 6]!, cpu.vertexNormals[base + 7]!, cpu.vertexNormals[base + 8]!],
        [0, 0, 1],
        "corner 7 normal[2] = +Z",
    )
    // Corner 0 = (-,-,-) → (-1,0,0), (0,-1,0), (0,0,-1).
    const base0 = 0 * stride
    assert.deepEqual(
        [cpu.vertexNormals[base0 + 0]!, cpu.vertexNormals[base0 + 1]!, cpu.vertexNormals[base0 + 2]!],
        [-1, 0, 0],
    )
    assert.deepEqual(
        [cpu.vertexNormals[base0 + 3]!, cpu.vertexNormals[base0 + 4]!, cpu.vertexNormals[base0 + 5]!],
        [0, -1, 0],
    )
    assert.deepEqual(
        [cpu.vertexNormals[base0 + 6]!, cpu.vertexNormals[base0 + 7]!, cpu.vertexNormals[base0 + 8]!],
        [0, 0, -1],
    )
})

test("Box.accumulateFeatureGraph: face loops have correct outward normals + 4 indices each", () => {
    const root = box([2, 2, 2])
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()
    const expectedNormals: [number, number, number][] = [
        [+1, 0, 0],
        [-1, 0, 0],
        [0, +1, 0],
        [0, -1, 0],
        [0, 0, +1],
        [0, 0, -1],
    ]
    for (let l = 0; l < 6; l++) {
        assert.equal(cpu.loopIndexCount[l]!, 4, `loop ${l} has 4 vertices`)
        const [nx, ny, nz] = expectedNormals[l]!
        assert.equal(cpu.loopNormals[l * 3]!, nx)
        assert.equal(cpu.loopNormals[l * 3 + 1]!, ny)
        assert.equal(cpu.loopNormals[l * 3 + 2]!, nz)
    }
})

test("Box.accumulateFeatureGraph: face winding agrees with outward normal", () => {
    // For each face, cross(loop[1] - loop[0], loop[2] - loop[1]) should be a
    // positive multiple of the stored normal.
    const root = box([2, 2, 2])
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()
    const pos = (i: number) => [
        cpu.vertexPositions[i * 3]!,
        cpu.vertexPositions[i * 3 + 1]!,
        cpu.vertexPositions[i * 3 + 2]!,
    ]
    const sub = (a: number[], b: number[]) => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!]
    const cross = (a: number[], b: number[]) => [
        a[1]! * b[2]! - a[2]! * b[1]!,
        a[2]! * b[0]! - a[0]! * b[2]!,
        a[0]! * b[1]! - a[1]! * b[0]!,
    ]
    const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!

    for (let l = 0; l < cpu.loopCount; l++) {
        const start = cpu.loopIndexStart[l]!
        const i0 = cpu.loopVertexIndices[start]!
        const i1 = cpu.loopVertexIndices[start + 1]!
        const i2 = cpu.loopVertexIndices[start + 2]!
        const e0 = sub(pos(i1), pos(i0))
        const e1 = sub(pos(i2), pos(i1))
        const c = cross(e0, e1)
        const n = [cpu.loopNormals[l * 3]!, cpu.loopNormals[l * 3 + 1]!, cpu.loopNormals[l * 3 + 2]!]
        assert.ok(dot(c, n) > 0, `loop ${l} winding agrees with outward normal`)
    }
})

test("Box under translate: positions shift; transform stack records affine matrix", () => {
    const root = translate([10, 20, 30], box([1, 1, 1]))
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()
    assert.equal(cpu.vertexCount, 8)
    // Local positions still in box's local frame; transform matrix carries the offset.
    // Corner 7 (+,+,+) local = (1,1,1).
    assert.equal(cpu.vertexPositions[7 * 3]!, 1)
    assert.equal(cpu.vertexPositions[7 * 3 + 1]!, 1)
    assert.equal(cpu.vertexPositions[7 * 3 + 2]!, 1)
    // Translate slot 1 m[12..14] = (10, 20, 30).
    assert.equal(cpu.transforms[16 + 12]!, 10)
    assert.equal(cpu.transforms[16 + 13]!, 20)
    assert.equal(cpu.transforms[16 + 14]!, 30)
})

test("Box under twist: non-affine gate produces zero emission", () => {
    const root = twist(45, box([1, 1, 1]))
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()
    assert.equal(cpu.vertexCount, 0)
    assert.equal(cpu.edgeCount, 0)
    assert.equal(cpu.loopCount, 0)
})

test("CSG smoke: subtract(box, translated box) — both extractors emit, total counts compose", () => {
    // Two boxes, second translated so it overlaps but doesn't contain the first.
    // The smoke test here is structural — extraction adds both contributions
    // unconditionally; stage 4 survival decides which vertices/edges actually
    // stay alive at the SDF query (verified live in the dev console log).
    const root = subtract(box([4, 4, 4]), translate([2, 0, 0], box([4, 4, 4])))
    const builder = new FeatureGraphBuilder()
    root.accumulateFeatureGraph(builder)
    const cpu = builder.finish()
    assert.equal(cpu.vertexCount, 16, "two boxes × 8 corners")
    assert.equal(cpu.edgeCount, 24, "two boxes × 12 edges")
    assert.equal(cpu.loopCount, 12, "two boxes × 6 faces")
    // Slot 0 root identity + slot 1 for the translate on the second box.
    assert.equal(cpu.transformCount, 2)
})
