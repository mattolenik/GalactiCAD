import assert from "node:assert/strict"
import test from "node:test"
import { Cylinder } from "../../scene/primitives/cylinder.mjs"
import { Translate } from "../../scene/operators/translate.mjs"
import { Rotate } from "../../scene/operators/rotate.mjs"
import { compileCpuSdf, type CpuSdfTree } from "./cpu-sdf.mjs"
import { compileNativeFeatures } from "./feature-set.mjs"
import { runSfccPipeline } from "./assemble.mjs"
import { DEFAULT_SFCC_TUNING, type SfccTuning } from "./sfcc-tuning.mjs"
import type { Node } from "../../scene/base.mjs"

const TUNING: SfccTuning = { ...DEFAULT_SFCC_TUNING, depthMin: 4, depthMax: 7, boundsPaddingMm: 0 }

test("native features: cylinder emits two exact rim circles", () => {
    const tree = compileCpuSdf(new Translate([1, 2, 3], new Cylinder([0, 0, 0], { r: 4, h: 2 })))
    const features = compileNativeFeatures(tree)
    assert.equal(features.curves.length, 2)
    assert.equal(features.corners.length, 0)
    const p = new Float64Array(3)
    for (const curve of features.curves) {
        assert.equal(curve.kind, "circle")
        assert.ok(curve.closed)
        // Every pointAt lies exactly on the analytic rim: distance 4 from the
        // axis through (1,2,3) along y, at y = 2±2.
        for (let k = 0; k < 16; k++) {
            curve.pointAt((k / 16) * 2 * Math.PI, p)
            const rho = Math.hypot(p[0]! - 1, p[2]! - 3)
            assert.ok(Math.abs(rho - 4) < 1e-12, `rho ${rho}`)
            assert.ok(Math.abs(Math.abs(p[1]! - 2) - 2) < 1e-12, `y ${p[1]}`)
            // Exactly on the SDF zero set.
            assert.ok(Math.abs(tree.f(p[0]!, p[1]!, p[2]!)) < 1e-12)
        }
    }
})

/**
 * P4 acceptance: cylinder → closed 2-manifold with ZERO rim roundover —
 * every mesh vertex near a rim lies within 1e-6 mm of the analytic circle.
 * This is the configuration every grid/QEF exporter rounds off.
 */
function assertCylinderAcceptance(scene: Node, axisCheck: (x: number, y: number, z: number) => { rho: number; ay: number }): void {
    const tree: CpuSdfTree = compileCpuSdf(scene)
    const r = runSfccPipeline(tree, { minX: -8, minY: -8, minZ: -8, size: 16 }, TUNING)

    assert.equal(r.stats.failedCells, 0, "no failed cells")
    assert.equal(r.stats.faceAuditFailures, 0)
    // Feature cells whose surface arc is invisible at sample resolution
    // (sub-sample slivers near grazing faces) mesh smooth-but-closed and are
    // counted as fallbacks — P7's re-refinement round force-splits them.
    // Rotated cylinder measures ~11%; axis-aligned ~0%.
    assert.ok(
        r.stats.featureCellFallbacks <= Math.max(1, 0.15 * r.stats.edgeCells),
        `fallbacks ${r.stats.featureCellFallbacks} vs edge cells ${r.stats.edgeCells}`,
    )
    assert.ok(r.stats.edgeCells > 0, "edge cells present")
    assert.ok(r.manifold.ok, JSON.stringify(r.manifold))
    assert.equal(r.manifold.components, 1)
    assert.deepEqual(r.manifold.eulerPerComponent, [2])

    // Rim exactness: a substantial chain of vertices lies EXACTLY on the
    // analytic rim circle (within 1e-6 mm — grid/QEF exporters place none
    // there). Together with max|f| ≤ tol below, corner-cutting roundover
    // vertices (which sit inside the material wedge, |f| ≫ tol) are excluded.
    let rimVerts = 0
    for (let i = 0; i < r.verts.length; i += 8) {
        const { rho, ay } = axisCheck(r.verts[i]!, r.verts[i + 1]!, r.verts[i + 2]!)
        if (Math.hypot(rho - 4, ay - 2) < 1e-6) rimVerts++
    }
    assert.ok(rimVerts > 32, `expected an exact rim vertex chain, got ${rimVerts}`)

    // All vertices on the surface.
    let maxAbsF = 0
    for (let i = 0; i < r.verts.length; i += 8) {
        maxAbsF = Math.max(maxAbsF, Math.abs(tree.f(r.verts[i]!, r.verts[i + 1]!, r.verts[i + 2]!)))
    }
    assert.ok(maxAbsF <= TUNING.surfaceTolMm, `max |f| = ${maxAbsF}`)
}

test("sfcc pipeline: axis-aligned-ish cylinder → closed manifold with exact rims", () => {
    // Slight offset keeps the caps/axis off exact lattice planes (the jitter
    // guard for exactly-aligned CAD geometry lands in P5).
    const scene = new Translate([0.13, 0.21, -0.17], new Cylinder([0, 0, 0], { r: 4, h: 2 }))
    assertCylinderAcceptance(scene, (x, y, z) => ({
        rho: Math.hypot(x - 0.13, z + 0.17),
        ay: Math.abs(y - 0.21),
    }))
})

test("sfcc pipeline: rotated cylinder → closed manifold with exact rims", () => {
    const rot = new Rotate([30, 20, 10], new Cylinder([0, 0, 0], { r: 4, h: 2 }))
    const tree = compileCpuSdf(rot)
    const sim = tree.leaves[0]!.sim
    // axisCheck in the rotated frame via the leaf's similarity inverse.
    const local = new Float64Array(3)
    assertCylinderAcceptance(rot, (x, y, z) => {
        // local = Rᵀ(p − t)/s — reuse the baked inverse through f64 math.
        const r0 = sim.r
        const dx = (x - sim.t[0]!) / sim.s
        const dy = (y - sim.t[1]!) / sim.s
        const dz = (z - sim.t[2]!) / sim.s
        local[0] = r0[0]! * dx + r0[3]! * dy + r0[6]! * dz
        local[1] = r0[1]! * dx + r0[4]! * dy + r0[7]! * dz
        local[2] = r0[2]! * dx + r0[5]! * dy + r0[8]! * dz
        return { rho: Math.hypot(local[0]!, local[2]!), ay: Math.abs(local[1]!) }
    })
})
