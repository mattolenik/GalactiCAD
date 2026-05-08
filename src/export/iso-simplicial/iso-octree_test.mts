import assert from "node:assert/strict"
import test from "node:test"

import { IsoSimplicialConstants } from "./constants.mjs"
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

test("IsoOctree.build: dual vertex stays in cell interior for non-unit worldBounds (unit-mismatch regression)", async () => {
    // Sphere of radius 30 centered at world origin; world cube spans [-50, 50]³. The sphere surface
    // crosses well inside the root cell, and varying gradients across samples make the cube QEF full
    // rank, so the unconstrained minimizer must pin to the sphere center: world (0,0,0) → normalized
    // (0.5, 0.5, 0.5). Returns world `d = |p|-30` and unit world normal `p/|p|`, matching the GPU
    // `iso_sample_batch.wgsl` contract.
    const RADIUS_WORLD = 30
    const sphereField: IsoOctreeBatchFn = positions => {
        const n = positions.length / 3
        const out = new Float32Array(n * 4)
        for (let i = 0; i < n; i++) {
            const x = positions[i * 3]!
            const y = positions[i * 3 + 1]!
            const z = positions[i * 3 + 2]!
            const r = Math.sqrt(x * x + y * y + z * z)
            const inv = r > 1e-12 ? 1 / r : 0
            out[i * 4] = x * inv
            out[i * 4 + 1] = y * inv
            out[i * 4 + 2] = z * inv
            out[i * 4 + 3] = r - RADIUS_WORLD
        }
        return Promise.resolve(out)
    }

    const tree = await IsoOctree.build({
        sample: sphereField,
        bounds: { min: [-50, -50, -50], max: [50, 50, 50] },
        constants: { depthMin: 0, depthMax: 0, qefRelativeErrorRefineThreshold: 1e30 },
    })

    // Root cube dual vertex must land near the sphere center in normalized coords (0.5, 0.5, 0.5),
    // not be clamped to {0,1} by the constrained-cascade fallback that fires when the unconstrained
    // QEF returns junk (which is what happens when world d is mixed with normalized positions).
    const nx = tree.root.node[0]!
    const ny = tree.root.node[1]!
    const nz = tree.root.node[2]!
    for (const [name, v] of [["x", nx], ["y", ny], ["z", nz]] as const) {
        assert.ok(
            v > 0.4 && v < 0.6,
            `root cube dual-vertex ${name}=${v} expected near 0.5 (sphere center, normalized); ` +
                `values near {0,1} indicate QEF unit mismatch (world d vs normalized p)`,
        )
    }
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

test("IsoOctree.build: sibling megabatch coalesces phase1 and reEval sample counts", async () => {
    const O = IsoSimplicialConstants.oversampleQef
    const nodeCount = (O + 1) ** 3
    const edgeSamples = O + 1
    const faceSamples = (O + 1) ** 2
    const totalPhase1 = nodeCount + 12 * edgeSamples + 6 * faceSamples

    const batchSampleCounts: number[] = []
    const trackingSampler: IsoOctreeBatchFn = positions => {
        batchSampleCounts.push(positions.length / 3)
        return mockPlaneHalfZ(positions)
    }

    await IsoOctree.build({
        sample: trackingSampler,
        bounds: { min: [0, 0, 0], max: [1, 1, 1] },
        constants: { depthMin: 2, depthMax: 4, qefRelativeErrorRefineThreshold: 1e30 },
    })

    assert.ok(
        batchSampleCounts.some(n => n === 8 * totalPhase1),
        `expected 8×phase1 megabatch (${8 * totalPhase1}), got ${batchSampleCounts.join(",")}`,
    )
    assert.ok(
        batchSampleCounts.some(n => n === 8 * 19),
        `expected 8×19 reEval megabatch (152), got ${batchSampleCounts.join(",")}`,
    )
})
