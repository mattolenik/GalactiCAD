import assert from "node:assert/strict"
import test from "node:test"

import {
    extractIsoSimplicialMesh,
    extractIsoSimplicialMeshAsync,
    filterIsoExtractDegenerateTriangles,
    isoExtractFindZero,
} from "./iso-extract.mjs"
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

test("extractIsoSimplicialMesh: phase5 + sample throws (use async)", async () => {
    const tree = await IsoOctree.build({
        sample: mockPlaneHalfZ,
        bounds: { min: [0, 0, 0], max: [1, 1, 1] },
        constants: { depthMin: 2, depthMax: 3, qefRelativeErrorRefineThreshold: 1e30 },
    })
    assert.throws(
        () =>
            extractIsoSimplicialMesh(tree, {
                phase5: { enabled: true, sample: mockPlaneHalfZ },
            }),
        /extractIsoSimplicialMeshAsync/,
    )
})

test("extractIsoSimplicialMeshAsync: findRootDepth 0 matches sync mesh (same Phase 5 filter)", async () => {
    const tree = await IsoOctree.build({
        sample: mockPlaneHalfZ,
        bounds: { min: [0, 0, 0], max: [1, 1, 1] },
        constants: { depthMin: 2, depthMax: 4, qefRelativeErrorRefineThreshold: 1e30 },
    })
    const a = extractIsoSimplicialMesh(tree, { phase5: { enabled: true } })
    const b = await extractIsoSimplicialMeshAsync(tree, {
        phase5: { enabled: true, sample: mockPlaneHalfZ, findRootDepth: 0 },
    })
    assert.equal(a.tris.length, b.tris.length)
    assert.equal(a.verts.length, b.verts.length)
    for (let i = 0; i < a.verts.length; i++) {
        assert.ok(Math.abs(a.verts[i]! - b.verts[i]!) < 1e-5)
    }
})

test("extractIsoSimplicialMeshAsync (batched bisection): findRootDepth > 0 on a linear field equals findRootDepth 0", async () => {
    // Linearly interpolated zero crossings of a linear SDF are exact, so any number of bisection
    // steps must reach the same final position as the no-bisection baseline. Counts the number of
    // sample-batch dispatches and confirms it equals findRootDepth (not 3·triCount·findRootDepth).
    let batchDispatchCount = 0
    const countingPlane: IsoOctreeBatchFn = positions => {
        batchDispatchCount++
        return mockPlaneHalfZ(positions)
    }

    const tree = await IsoOctree.build({
        sample: mockPlaneHalfZ,
        bounds: { min: [0, 0, 0], max: [1, 1, 1] },
        constants: { depthMin: 2, depthMax: 4, qefRelativeErrorRefineThreshold: 1e30 },
    })

    const a = await extractIsoSimplicialMeshAsync(tree, {
        phase5: { enabled: true, sample: mockPlaneHalfZ, findRootDepth: 0 },
    })

    batchDispatchCount = 0
    const FIND_ROOT_DEPTH = 4
    const b = await extractIsoSimplicialMeshAsync(tree, {
        phase5: { enabled: true, sample: countingPlane, findRootDepth: FIND_ROOT_DEPTH },
    })

    assert.equal(a.tris.length, b.tris.length)
    assert.equal(a.verts.length, b.verts.length)
    for (let i = 0; i < a.verts.length; i++) {
        assert.ok(
            Math.abs(a.verts[i]! - b.verts[i]!) < 1e-4,
            `vert[${i}] mismatch: a=${a.verts[i]} b=${b.verts[i]}`,
        )
    }
    assert.equal(
        batchDispatchCount,
        FIND_ROOT_DEPTH,
        `expected exactly ${FIND_ROOT_DEPTH} batched sample dispatches (one per bisection step), got ${batchDispatchCount}`,
    )
})

test("filterIsoExtractDegenerateTriangles: removes flat triangle", () => {
    const S = 8
    const verts = new Float32Array(new ArrayBuffer(3 * S * 4))
    verts[0] = 0
    verts[1] = 0
    verts[2] = 0
    verts[S] = 1
    verts[S + 1] = 0
    verts[S + 2] = 0
    verts[2 * S] = 0.5
    verts[2 * S + 1] = 0
    verts[2 * S + 2] = 0
    const tris = new Uint32Array([0, 1, 2])
    const mesh = filterIsoExtractDegenerateTriangles({ verts: verts as Float32Array<ArrayBuffer>, tris: tris as Uint32Array<ArrayBuffer> }, 1e-20)
    assert.equal(mesh.tris.length, 0)
})
