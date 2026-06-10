import assert from "node:assert/strict"
import test from "node:test"
import { Sphere } from "../../scene/primitives/sphere.mjs"
import { Union } from "../../scene/operators/union.mjs"
import { compileCpuSdf, type CpuSdfTree } from "./cpu-sdf.mjs"
import { runSfccPipeline, type SfccPipelineResult } from "./assemble.mjs"
import { DEFAULT_SFCC_TUNING, type SfccTuning } from "./sfcc-tuning.mjs"

const TUNING: SfccTuning = { ...DEFAULT_SFCC_TUNING, depthMin: 5, depthMax: 8, boundsPaddingMm: 0 }

function run(tree: CpuSdfTree, size = 24): SfccPipelineResult {
    return runSfccPipeline(tree, { minX: -size / 2, minY: -size / 2, minZ: -size / 2, size }, TUNING)
}

/** Assert geometric invariants shared by all smooth acceptance scenes. */
function assertSmoothInvariants(tree: CpuSdfTree, r: SfccPipelineResult): void {
    assert.ok(r.tris.length > 0, "produced triangles")
    assert.equal(r.stats.failedCells, 0, "no failed cells")
    assert.equal(r.stats.faceAuditFailures, 0, "face audit clean")
    assert.equal(r.stats.boundaryViolations, 0, "no root-boundary crossings")
    assert.ok(r.manifold.ok, `manifold: ${JSON.stringify(r.manifold)}`)
    assert.ok(r.ok)

    // Every vertex on the surface to tolerance.
    let maxAbsF = 0
    for (let i = 0; i < r.verts.length; i += 8) {
        const f = Math.abs(tree.f(r.verts[i]!, r.verts[i + 1]!, r.verts[i + 2]!))
        if (f > maxAbsF) maxAbsF = f
    }
    assert.ok(maxAbsF <= TUNING.surfaceTolMm, `max |f| at vertices = ${maxAbsF}`)

    // Outward winding: triangle normal agrees with ∇f at the centroid.
    const g = new Float64Array(3)
    let flipped = 0
    for (let t = 0; t < r.tris.length; t += 3) {
        const a = r.tris[t]! * 8
        const b = r.tris[t + 1]! * 8
        const c = r.tris[t + 2]! * 8
        const abx = r.verts[b]! - r.verts[a]!
        const aby = r.verts[b + 1]! - r.verts[a + 1]!
        const abz = r.verts[b + 2]! - r.verts[a + 2]!
        const acx = r.verts[c]! - r.verts[a]!
        const acy = r.verts[c + 1]! - r.verts[a + 1]!
        const acz = r.verts[c + 2]! - r.verts[a + 2]!
        const nx = aby * acz - abz * acy
        const ny = abz * acx - abx * acz
        const nz = abx * acy - aby * acx
        const cx = (r.verts[a]! + r.verts[b]! + r.verts[c]!) / 3
        const cy = (r.verts[a + 1]! + r.verts[b + 1]! + r.verts[c + 1]!) / 3
        const cz = (r.verts[a + 2]! + r.verts[b + 2]! + r.verts[c + 2]!) / 3
        tree.grad(cx, cy, cz, g)
        if (nx * g[0]! + ny * g[1]! + nz * g[2]! < 0) flipped++
    }
    assert.equal(flipped, 0, `${flipped}/${r.tris.length / 3} triangles wound inward`)
}

test("sfcc pipeline: sphere → closed 2-manifold, χ=2, vertices on surface, outward winding", () => {
    const tree = compileCpuSdf(new Sphere([0.13, -0.21, 0.07], { r: 8 }))
    const r = run(tree)
    assertSmoothInvariants(tree, r)
    assert.equal(r.manifold.components, 1)
    assert.deepEqual(r.manifold.eulerPerComponent, [2])
})

test("sfcc pipeline: disjoint sphere union → two χ=2 components", () => {
    const tree = compileCpuSdf(
        new Union([new Sphere([-5.5, 0.3, 0.2], { r: 3 }), new Sphere([5.5, -0.4, -0.1], { r: 3 })]),
    )
    const r = run(tree)
    assertSmoothInvariants(tree, r)
    assert.equal(r.manifold.components, 2)
    assert.deepEqual(r.manifold.eulerPerComponent, [2, 2])
})

test("sfcc pipeline: overlapping smooth union (no seam meshing yet) still closed", () => {
    // Two spheres overlapping: the seam circle is a feature SFCC can't mesh
    // exactly until P6, but the assembled mesh must still be closed and
    // manifold (the seam is simply contoured as smooth geometry for now).
    const tree = compileCpuSdf(new Union([new Sphere([-1.4, 0.2, 0.1], { r: 3 }), new Sphere([1.5, -0.3, 0.2], { r: 3 })]))
    const r = run(tree, 16)
    assert.equal(r.stats.failedCells, 0)
    assert.ok(r.manifold.ok, JSON.stringify(r.manifold))
    assert.equal(r.manifold.components, 1)
    assert.deepEqual(r.manifold.eulerPerComponent, [2])
})
