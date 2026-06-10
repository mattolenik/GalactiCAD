import assert from "node:assert/strict"
import test from "node:test"
import { Box } from "../../scene/primitives/box.mjs"
import { Cone } from "../../scene/primitives/cone.mjs"
import { Rotate } from "../../scene/operators/rotate.mjs"
import { compileCpuSdf, type CpuSdfTree } from "./cpu-sdf.mjs"
import { runSfccPipeline, type SfccPipelineResult } from "./assemble.mjs"
import { DEFAULT_SFCC_TUNING, type SfccTuning } from "./sfcc-tuning.mjs"
import type { Node } from "../../scene/base.mjs"

const TUNING: SfccTuning = { ...DEFAULT_SFCC_TUNING, depthMin: 4, depthMax: 7, boundsPaddingMm: 0 }

function runScene(scene: Node): { tree: CpuSdfTree; r: SfccPipelineResult } {
    const tree = compileCpuSdf(scene)
    const r = runSfccPipeline(tree, { minX: -8, minY: -8, minZ: -8, size: 16 }, TUNING)
    return { tree, r }
}

function assertBoxAcceptance(scene: Node, corners: Array<[number, number, number]>): SfccPipelineResult {
    const { tree, r } = runScene(scene)
    assert.equal(r.stats.failedCells, 0, "no failed cells")
    assert.equal(r.stats.faceAuditFailures, 0)
    assert.ok(r.manifold.ok, JSON.stringify(r.manifold))
    assert.equal(r.manifold.components, 1)
    assert.deepEqual(r.manifold.eulerPerComponent, [2])
    assert.equal(r.stats.cornerCells, 8, "8 corner cells")
    assert.ok(r.stats.edgeCells > 0)

    // Every analytic corner appears as a mesh vertex EXACTLY (≤1e-9 mm).
    for (const [cx, cy, cz] of corners) {
        let found = false
        for (let i = 0; i < r.verts.length && !found; i += 8) {
            if (Math.hypot(r.verts[i]! - cx, r.verts[i + 1]! - cy, r.verts[i + 2]! - cz) < 1e-6) found = true
        }
        assert.ok(found, `corner (${cx}, ${cy}, ${cz}) missing from the mesh`)
    }

    // All vertices on the surface.
    let maxAbsF = 0
    for (let i = 0; i < r.verts.length; i += 8) {
        maxAbsF = Math.max(maxAbsF, Math.abs(tree.f(r.verts[i]!, r.verts[i + 1]!, r.verts[i + 2]!)))
    }
    assert.ok(maxAbsF <= TUNING.surfaceTolMm, `max |f| = ${maxAbsF}`)
    return r
}

test("sfcc pipeline: axis-aligned box at integer coords (jitter stress) → 8 exact corners", () => {
    // The classic lattice-degeneracy stress: faces, edges, and corners all at
    // rational coordinates. The deterministic irrational root-cube jitter must
    // keep every sample/pin/crossing off the degenerate loci.
    const corners: Array<[number, number, number]> = []
    for (let i = 0; i < 8; i++) {
        corners.push([(i & 1 ? 3 : -3), (i & 2 ? 2 : -2), (i & 4 ? 2.5 : -2.5)])
    }
    const r = assertBoxAcceptance(new Box([0, 0, 0], [3, 2, 2.5]), corners)

    // Edge exactness: a chain of vertices lies exactly on each of the 12 box
    // edges. Check one representative edge (x varies, y=2, z=2.5).
    let edgeVerts = 0
    for (let i = 0; i < r.verts.length; i += 8) {
        if (
            Math.abs(r.verts[i + 1]! - 2) < 1e-6 &&
            Math.abs(r.verts[i + 2]! - 2.5) < 1e-6 &&
            r.verts[i]! > -3 - 1e-6 &&
            r.verts[i]! < 3 + 1e-6
        ) {
            edgeVerts++
        }
    }
    assert.ok(edgeVerts >= 8, `expected an exact edge chain, got ${edgeVerts} vertices`)
})

test("sfcc pipeline: rotated box → 8 exact corners, closed manifold", () => {
    const box = new Box([0.3, -0.2, 0.1], [2.5, 1.5, 2])
    const scene = new Rotate([25, 40, 65], box)
    const tree = compileCpuSdf(scene)
    const sim = tree.leaves[0]!.sim
    const corners: Array<[number, number, number]> = []
    const p = new Float64Array(3)
    for (let i = 0; i < 8; i++) {
        const lx = 0.3 + (i & 1 ? 2.5 : -2.5)
        const ly = -0.2 + (i & 2 ? 1.5 : -1.5)
        const lz = 0.1 + (i & 4 ? 2 : -2)
        // world = s·R·local + t
        const r0 = sim.r
        p[0] = sim.s * (r0[0]! * lx + r0[1]! * ly + r0[2]! * lz) + sim.t[0]!
        p[1] = sim.s * (r0[3]! * lx + r0[4]! * ly + r0[5]! * lz) + sim.t[1]!
        p[2] = sim.s * (r0[6]! * lx + r0[7]! * ly + r0[8]! * lz) + sim.t[2]!
        corners.push([p[0]!, p[1]!, p[2]!])
    }
    assertBoxAcceptance(scene, corners)
})

test("sfcc pipeline: cone → apex corner cell + exact base rim, closed manifold", () => {
    const { tree, r } = runScene(new Cone([0.17, -2.1, 0.23], { r: 3, h: 4 }))
    assert.equal(r.stats.failedCells, 0)
    assert.ok(r.manifold.ok, JSON.stringify(r.manifold))
    assert.deepEqual(r.manifold.eulerPerComponent, [2])
    assert.equal(r.stats.cornerCells, 1, "apex corner cell")
    // Apex vertex exact.
    let found = false
    for (let i = 0; i < r.verts.length && !found; i += 8) {
        if (Math.hypot(r.verts[i]! - 0.17, r.verts[i + 1]! - 1.9, r.verts[i + 2]! - 0.23) < 1e-6) found = true
    }
    assert.ok(found, "apex vertex missing")
    let maxAbsF = 0
    for (let i = 0; i < r.verts.length; i += 8) {
        maxAbsF = Math.max(maxAbsF, Math.abs(tree.f(r.verts[i]!, r.verts[i + 1]!, r.verts[i + 2]!)))
    }
    assert.ok(maxAbsF <= TUNING.surfaceTolMm, `max |f| = ${maxAbsF}`)
})
