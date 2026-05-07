import assert from "node:assert/strict"
import test from "node:test"

import { IsoOctree, isoOctreeChangesSign, isoOctreeIsOutside, type IsoOctreeBatchFn } from "./iso-octree.mjs"

/** Horizontal plane `z = 0.5`; outward normal `(0,0,1)` (mock GPU layout). */
const mockPlaneHalfZ: IsoOctreeBatchFn = positions => {
    const n = positions.length / 3
    const out = new Float32Array(n * 4)
    for (let i = 0; i < n; i++) {
        const z = positions[i * 3 + 2]!
        out[i * 4] = 0
        out[i * 4 + 1] = 0
        out[i * 4 + 2] = 1
        out[i * 4 + 3] = z - 0.5
    }
    return Promise.resolve(out)
}

test("isoOctreeChangesSign matches reference pattern (verts[0] baseline)", () => {
    const verts = new Float32Array(32)
    const edges = new Float32Array(48)
    const faces = new Float32Array(24)
    const node = new Float32Array(4)
    for (let i = 0; i < 8; i++) verts[i * 4 + 3] = -1
    for (let i = 0; i < 12; i++) edges[i * 4 + 3] = -1
    for (let i = 0; i < 6; i++) faces[i * 4 + 3] = -1
    node[3] = -1
    verts[7 * 4 + 3] = 1
    assert.equal(isoOctreeChangesSign(verts, edges, faces, node), true)
    verts[7 * 4 + 3] = -1
    assert.equal(isoOctreeChangesSign(verts, edges, faces, node), false)
})

test("isoOctreeIsOutside: small cell protruding past normalized +x", () => {
    const verts = new Float32Array(32)
    writeCorner(verts, 0, 0.95, 0.2, 0.2, -1)
    writeCorner(verts, 7, 1.1, 0.4, 0.4, 1)
    assert.equal(isoOctreeIsOutside(verts), true)
})

function writeCorner(verts: Float32Array, i: number, x: number, y: number, z: number, w: number): void {
    const o = i * 4
    verts[o] = x
    verts[o + 1] = y
    verts[o + 2] = z
    verts[o + 3] = w
}

test("IsoOctree.build: mock sampler only, depthMax=0 yields single evaluated cell", async () => {
    const tree = await IsoOctree.build({
        sample: mockPlaneHalfZ,
        bounds: { min: [0, 0, 0], max: [1, 1, 1] },
        constants: { depthMax: 0 },
    })
    assert.equal(tree.treeCellCount, 1)
    assert.ok(tree.root.children.every(c => c === null))
})

test("IsoOctree.build: deterministic treeCellCount for fixed mock + caps", async () => {
    const params = {
        sample: mockPlaneHalfZ,
        bounds: { min: [0, 0, 0], max: [1, 1, 1] } as const,
        constants: { depthMin: 2, depthMax: 4, qefRelativeErrorRefineThreshold: 1e30 },
    }
    const a = await IsoOctree.build(params)
    const b = await IsoOctree.build(params)
    assert.equal(a.treeCellCount, b.treeCellCount)
    assert.ok(a.treeCellCount > 1)
})
