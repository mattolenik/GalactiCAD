import assert from "node:assert/strict"
import test from "node:test"
import {
    CELL_EDGES,
    cellAabb,
    cellEdgeAxis,
    cellKey,
    cellSizeAtLevel,
    collectEdgeInteriorOffsets,
    cornerOffset,
    faceAxes,
    makeLattice,
    packPoint,
    pointToWorld,
    strideAtLevel,
    unpackPoint,
} from "./lattice.mjs"

test("packPoint/unpackPoint roundtrip stays exact at max depth", () => {
    const lat = makeLattice(14, -10, -20, -30, 100)
    const probes: Array<[number, number, number]> = [
        [0, 0, 0],
        [lat.res, lat.res, lat.res],
        [1, 0, lat.res],
        [16384, 1, 16383],
        [12345, 6789, 101],
    ]
    const out: [number, number, number] = [0, 0, 0]
    for (const [gx, gy, gz] of probes) {
        const key = packPoint(lat, gx, gy, gz)
        assert.equal(key, Math.round(key), `key not integer for ${gx},${gy},${gz}`)
        assert.ok(key <= Number.MAX_SAFE_INTEGER)
        unpackPoint(lat, key, out)
        assert.deepEqual(out, [gx, gy, gz])
    }
})

test("packPoint is injective across distinct neighbors", () => {
    const lat = makeLattice(10, 0, 0, 0, 1)
    const seen = new Set<number>()
    for (let dx = 0; dx <= 2; dx++)
        for (let dy = 0; dy <= 2; dy++)
            for (let dz = 0; dz <= 2; dz++) {
                const key = packPoint(lat, 511 + dx, 511 + dy, 511 + dz)
                assert.ok(!seen.has(key))
                seen.add(key)
            }
})

test("pointToWorld maps lattice extremes onto the root cube", () => {
    const lat = makeLattice(6, -5, 2, 7, 64)
    const p = new Float64Array(3)
    pointToWorld(lat, 0, 0, 0, p)
    assert.deepEqual([p[0], p[1], p[2]], [-5, 2, 7])
    pointToWorld(lat, lat.res, lat.res, lat.res, p)
    assert.deepEqual([p[0], p[1], p[2]], [59, 66, 71])
    // One lattice step is one max-depth cell.
    assert.equal(lat.step, 1)
    assert.equal(cellSizeAtLevel(lat, lat.maxDepth), lat.step)
    assert.equal(cellSizeAtLevel(lat, 0), 64)
})

test("cell stride/key: parent and child cells key to distinct lattice corners", () => {
    const lat = makeLattice(8, 0, 0, 0, 256)
    assert.equal(strideAtLevel(lat, 8), 1)
    assert.equal(strideAtLevel(lat, 0), 256)
    // Child (level 5, 2·i+1) min corner sits halfway into parent (level 4, i).
    const parent = cellKey(lat, 4, 3, 0, 0)
    const child = cellKey(lat, 5, 6, 0, 0)
    assert.equal(parent, child) // same min corner lattice point
    const childHi = cellKey(lat, 5, 7, 0, 0)
    assert.notEqual(parent, childHi)
})

test("corner order convention: bit 0 = x, bit 1 = y, bit 2 = z", () => {
    assert.equal(cornerOffset(0, 0) + cornerOffset(0, 1) + cornerOffset(0, 2), 0)
    assert.equal(cornerOffset(1, 0), 1)
    assert.equal(cornerOffset(2, 1), 1)
    assert.equal(cornerOffset(4, 2), 1)
    assert.equal(cornerOffset(7, 0) + cornerOffset(7, 1) + cornerOffset(7, 2), 3)
})

test("CELL_EDGES: 12 edges, one differing bit, grouped by axis", () => {
    assert.equal(CELL_EDGES.length, 12)
    for (let e = 0; e < 12; e++) {
        const [a, b] = CELL_EDGES[e]!
        const diff = a ^ b
        assert.ok(diff === 1 || diff === 2 || diff === 4, `edge ${e} differs in more than one bit`)
        assert.equal(1 << cellEdgeAxis(e), diff, `edge ${e} axis grouping`)
        assert.ok(a < b)
    }
})

test("faceAxes returns the cyclic in-face axes with u × v = +axis", () => {
    assert.deepEqual(faceAxes(0), [1, 2])
    assert.deepEqual(faceAxes(1), [2, 0])
    assert.deepEqual(faceAxes(2), [0, 1])
    // Verify the cross-product convention numerically.
    for (const axis of [0, 1, 2] as const) {
        const [u, v] = faceAxes(axis)
        const uv = [0, 0, 0]
        const vv = [0, 0, 0]
        uv[u] = 1
        vv[v] = 1
        const cross = [
            uv[1]! * vv[2]! - uv[2]! * vv[1]!,
            uv[2]! * vv[0]! - uv[0]! * vv[2]!,
            uv[0]! * vv[1]! - uv[1]! * vv[0]!,
        ]
        assert.equal(cross[axis], 1, `axis ${axis}`)
    }
})

test("collectEdgeInteriorOffsets finds hanging midpoints recursively, in order", () => {
    const lat = makeLattice(4, 0, 0, 0, 16)
    // Edge from (4, 8, 0) running 8 lattice units along x. Samples exist at
    // offsets 4 (midpoint) and 2 (midpoint of the lower half) plus unrelated noise.
    const present = new Set<number>([
        packPoint(lat, 8, 8, 0), // offset 4
        packPoint(lat, 6, 8, 0), // offset 2
        packPoint(lat, 9, 9, 0), // off-edge noise — must be ignored
    ])
    const got = collectEdgeInteriorOffsets(k => present.has(k), lat, 0, 4, 8, 0, 8, [])
    assert.deepEqual(got, [2, 4])
})

test("collectEdgeInteriorOffsets: no samples → no interior points; len 1 edges have none", () => {
    const lat = makeLattice(4, 0, 0, 0, 16)
    assert.deepEqual(collectEdgeInteriorOffsets(() => false, lat, 1, 0, 0, 0, 8, []), [])
    assert.deepEqual(collectEdgeInteriorOffsets(() => true, lat, 2, 0, 0, 3, 1, []), [])
})

test("collectEdgeInteriorOffsets skips quarter points when the midpoint is absent", () => {
    // Midpoint-chain invariant: a quarter point without its midpoint cannot
    // arise from octree leaf corners, so the walk must not find it.
    const lat = makeLattice(4, 0, 0, 0, 16)
    const present = new Set<number>([packPoint(lat, 2, 0, 0)]) // offset 2 of an 8-long edge, no offset-4 sample
    const got = collectEdgeInteriorOffsets(k => present.has(k), lat, 0, 0, 0, 0, 8, [])
    assert.deepEqual(got, [])
})

test("cellAabb matches level sizing and origin", () => {
    const lat = makeLattice(5, -16, -16, -16, 32)
    const box = new Float64Array(6)
    cellAabb(lat, 5, 0, 0, 0, box)
    assert.deepEqual(Array.from(box), [-16, -16, -16, -15, -15, -15])
    cellAabb(lat, 1, 1, 0, 1, box)
    assert.deepEqual(Array.from(box), [0, -16, 0, 16, 0, 16])
})
