import assert from "node:assert/strict"
import test from "node:test"
import { packFgPlaneSources, unpackFgPlaneSourcesForCell } from "./iso-fg-shared-buffer.mjs"
import type { FgPlaneSource } from "./iso-fg-feature-planes.mjs"

function src(px: number, py: number, pz: number, normals: number[][]): FgPlaneSource {
    return { px, py, pz, normalCount: normals.length, normals: normals.flat() }
}

/** Round-trip: pack `perCell`, decode every cell, return the decoded lists. */
function roundTrip(perCell: FgPlaneSource[][]): FgPlaneSource[][] {
    const packed = packFgPlaneSources(perCell)
    if (!packed.data || !packed.offsets) return perCell.map(() => [])
    const data = new Float32Array(packed.data)
    const offsets = new Uint32Array(packed.offsets)
    return perCell.map((_, i) => unpackFgPlaneSourcesForCell(data, offsets, i, packed.strideFloats))
}

test("packFgPlaneSources: no sources anywhere → null buffers, stride 0", () => {
    const packed = packFgPlaneSources([[], [], []])
    assert.equal(packed.data, null)
    assert.equal(packed.offsets, null)
    assert.equal(packed.strideFloats, 0)
})

test("packFgPlaneSources: dynamic stride = 4 + maxNormals*3", () => {
    // Batch whose largest source has 2 normals → stride 10.
    assert.equal(packFgPlaneSources([[src(0, 0, 0, [[1, 0, 0], [0, 1, 0]])]]).strideFloats, 10)
    // Largest has 3 normals → stride 13.
    assert.equal(packFgPlaneSources([[src(0, 0, 0, [[1, 0, 0], [0, 1, 0], [0, 0, 1]])]]).strideFloats, 13)
    // Largest has 1 normal → stride 7.
    assert.equal(packFgPlaneSources([[src(0, 0, 0, [[1, 0, 0]])]]).strideFloats, 7)
})

test("packFgPlaneSources: round-trip preserves a single source", () => {
    const out = roundTrip([[src(0.25, 0.5, 0.75, [[1, 0, 0], [0, 1, 0]])]])
    assert.equal(out.length, 1)
    assert.equal(out[0]!.length, 1)
    const s = out[0]![0]!
    assert.deepEqual([s.px, s.py, s.pz], [0.25, 0.5, 0.75])
    assert.equal(s.normalCount, 2)
    assert.deepEqual(s.normals, [1, 0, 0, 0, 1, 0])
})

test("packFgPlaneSources: offset table partitions sources per cell", () => {
    // cell0: 2 sources, cell1: 0, cell2: 1.
    const perCell: FgPlaneSource[][] = [
        [src(0, 0, 0, [[1, 0, 0]]), src(1, 1, 1, [[0, 1, 0]])],
        [],
        [src(2, 2, 2, [[0, 0, 1]])],
    ]
    const packed = packFgPlaneSources(perCell)
    const offsets = new Uint32Array(packed.offsets!)
    assert.deepEqual([...offsets], [0, 2, 2, 3], "prefix sum of per-cell source counts")
    const out = roundTrip(perCell)
    assert.equal(out[0]!.length, 2)
    assert.equal(out[1]!.length, 0)
    assert.equal(out[2]!.length, 1)
})

test("packFgPlaneSources: mixed normal counts in one batch unpack losslessly", () => {
    // A 1-normal source and a 3-normal source share the batch stride (13);
    // the 1-normal source must still decode with exactly 1 normal.
    const perCell: FgPlaneSource[][] = [
        [src(0.1, 0.2, 0.3, [[1, 0, 0]])],
        [src(0.4, 0.5, 0.6, [[1, 0, 0], [0, 1, 0], [0, 0, 1]])],
    ]
    assert.equal(packFgPlaneSources(perCell).strideFloats, 13)
    const out = roundTrip(perCell)
    assert.equal(out[0]![0]!.normalCount, 1)
    assert.deepEqual(out[0]![0]!.normals, [1, 0, 0])
    assert.equal(out[1]![0]!.normalCount, 3)
    assert.deepEqual(out[1]![0]!.normals, [1, 0, 0, 0, 1, 0, 0, 0, 1])
})

test("packFgPlaneSources: a cell with no sources decodes to an empty list", () => {
    const out = roundTrip([[src(0, 0, 0, [[1, 0, 0]])], []])
    assert.equal(out[1]!.length, 0)
})
