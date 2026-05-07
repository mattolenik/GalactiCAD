import assert from "node:assert/strict"
import test from "node:test"

import { extractIsoSimplicialMesh, isoExtractFindZero } from "./iso-extract.mjs"
import { IsoOctree, type IsoOctreeBatchFn } from "./iso-octree.mjs"

/** Horizontal plane `z = 0.5`; matches `iso-octree_test.mts`. */
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

test("isoExtractFindZero: linear crossing", () => {
    const a = new Float32Array([0, 0, 0, -1])
    const b = new Float32Array([1, 0, 0, 1])
    const p = isoExtractFindZero(a, b)
    assert.ok(Math.abs(p[2]!) < 1e-6)
    assert.ok(Math.abs(p[0]! - 0.5) < 1e-6)
})

test("extractIsoSimplicialMesh: mock plane yields triangles (subdivided octree)", async () => {
    const tree = await IsoOctree.build({
        sample: mockPlaneHalfZ,
        bounds: { min: [0, 0, 0], max: [1, 1, 1] },
        constants: { depthMin: 2, depthMax: 4, qefRelativeErrorRefineThreshold: 1e30 },
    })
    assert.ok(tree.treeCellCount > 1)

    const mesh = extractIsoSimplicialMesh(tree)
    const triCount = mesh.tris.length / 3
    assert.ok(triCount > 0)

    for (let i = 0; i < mesh.verts.length; i++) {
        assert.ok(Number.isFinite(mesh.verts[i]!))
    }
})

test("extractIsoSimplicialMesh: worldBounds scales positions", async () => {
    const tree = await IsoOctree.build({
        sample: mockPlaneHalfZ,
        bounds: { min: [0, 0, 0], max: [1, 1, 1] },
        constants: { depthMin: 2, depthMax: 4, qefRelativeErrorRefineThreshold: 1e30 },
    })
    const mesh = extractIsoSimplicialMesh(tree, {
        worldBounds: { min: [0, 0, 0], max: [2, 2, 2] },
    })
    assert.ok(mesh.verts.length >= 8)
    let maxZ = -Infinity
    const stride = 8
    const nv = mesh.verts.length / stride
    for (let i = 0; i < nv; i++) {
        maxZ = Math.max(maxZ, mesh.verts[i * stride + 2]!)
    }
    assert.ok(maxZ <= 2.01)
})
