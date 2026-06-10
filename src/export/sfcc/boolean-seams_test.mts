import assert from "node:assert/strict"
import test from "node:test"
import { Box } from "../../scene/primitives/box.mjs"
import { Sphere } from "../../scene/primitives/sphere.mjs"
import { Cylinder } from "../../scene/primitives/cylinder.mjs"
import { Subtract } from "../../scene/operators/subtract.mjs"
import { Union } from "../../scene/operators/union.mjs"
import { compileCpuSdf, type CpuSdfTree } from "./cpu-sdf.mjs"
import { compileFeatureSet } from "./feature-set.mjs"
import { resolveTolerances } from "./tolerances.mjs"
import { runSfccPipeline, type SfccPipelineResult } from "./assemble.mjs"
import { DEFAULT_SFCC_TUNING, type SfccTuning } from "./sfcc-tuning.mjs"

const TUNING: SfccTuning = { ...DEFAULT_SFCC_TUNING, depthMin: 4, depthMax: 7, boundsPaddingMm: 0 }

function maxAbsF(tree: CpuSdfTree, r: SfccPipelineResult): number {
    let m = 0
    for (let i = 0; i < r.verts.length; i += 8) {
        m = Math.max(m, Math.abs(tree.f(r.verts[i]!, r.verts[i + 1]!, r.verts[i + 2]!)))
    }
    return m
}

function hasVertexAt(r: SfccPipelineResult, x: number, y: number, z: number, tol: number): boolean {
    for (let i = 0; i < r.verts.length; i += 8) {
        if (Math.hypot(r.verts[i]! - x, r.verts[i + 1]! - y, r.verts[i + 2]! - z) < tol) return true
    }
    return false
}

test("seam compilation: box−cylinder through-hole yields two exact closed seam rims", () => {
    const tree = compileCpuSdf(new Subtract(new Box([0, 0, 0], [3, 2, 3]), new Cylinder([0, 0, 0], { r: 1, h: 3 })))
    const tol = resolveTolerances(TUNING, Math.hypot(16, 16, 16))
    const fs = compileFeatureSet(tree, tol)
    const rims = fs.curves.filter(c => c.kind === "traced" && c.closed)
    assert.equal(rims.length, 2, `expected 2 seam rims, curves: ${fs.curves.map(c => `${c.kind}/${c.closed}`).join(",")}`)
    const p = new Float64Array(3)
    for (const rim of rims) {
        for (let k = 0; k <= 32; k++) {
            rim.pointAt(rim.tMin + ((rim.tMax - rim.tMin) * k) / 32, p)
            // On the cylinder side (ρ=1) and on a box ±y face (|y|=2).
            assert.ok(Math.abs(Math.hypot(p[0]!, p[2]!) - 1) < 1e-6, `rho off: ${Math.hypot(p[0]!, p[2]!)}`)
            assert.ok(Math.abs(Math.abs(p[1]!) - 2) < 1e-6, `y off: ${p[1]}`)
        }
    }
    // Box native edges/corners survive whole.
    assert.equal(fs.corners.length, 8)
})

test("sfcc pipeline: box−cylinder through-hole → genus-1 closed manifold with exact hole rims", () => {
    const tree = compileCpuSdf(new Subtract(new Box([0, 0, 0], [3, 2, 3]), new Cylinder([0, 0, 0], { r: 1, h: 3 })))
    const r = runSfccPipeline(tree, { minX: -8, minY: -8, minZ: -8, size: 16 }, TUNING)
    assert.equal(r.stats.failedCells, 0)
    assert.equal(r.stats.faceAuditFailures, 0)
    assert.ok(r.manifold.ok, JSON.stringify(r.manifold))
    assert.equal(r.manifold.components, 1)
    assert.deepEqual(r.manifold.eulerPerComponent, [0], "through-hole torus topology: χ = 0")
    assert.ok(maxAbsF(tree, r) <= TUNING.surfaceTolMm, `max |f| = ${maxAbsF(tree, r)}`)
    // Exact rim chain: vertices on the analytic seam circle (ρ=1, y=2).
    let rimVerts = 0
    for (let i = 0; i < r.verts.length; i += 8) {
        const rho = Math.hypot(r.verts[i]!, r.verts[i + 2]!)
        if (Math.abs(rho - 1) < 1e-6 && Math.abs(r.verts[i + 1]! - 2) < 1e-6) rimVerts++
    }
    assert.ok(rimVerts > 16, `expected an exact seam rim chain, got ${rimVerts}`)
    // The box's own corners stay exact.
    assert.ok(hasVertexAt(r, 3, 2, 3, 1e-6))
})

test("sfcc pipeline: box∪sphere corner swallow → boolean-created seam corners, exact", () => {
    // Sphere centered on the box corner (2,2,2): it swallows the corner, cuts
    // the three incident edges at distance 1.5 from the corner, and creates
    // three seam arcs wired at three BOOLEAN-CREATED corners — the
    // configuration that can never appear in a primitive-native FeatureGraph.
    const tree = compileCpuSdf(new Union([new Box([0, 0, 0], [2, 2, 2]), new Sphere([2, 2, 2], { r: 1.5 })]))
    const r = runSfccPipeline(tree, { minX: -8, minY: -8, minZ: -8, size: 16 }, TUNING)
    assert.equal(r.stats.failedCells, 0)
    assert.equal(r.stats.faceAuditFailures, 0)
    assert.ok(r.manifold.ok, JSON.stringify(r.manifold))
    assert.equal(r.manifold.components, 1)
    assert.deepEqual(r.manifold.eulerPerComponent, [2])
    assert.ok(maxAbsF(tree, r) <= TUNING.surfaceTolMm, `max |f| = ${maxAbsF(tree, r)}`)

    // The swallowed native corner is GONE...
    assert.ok(!hasVertexAt(r, 2, 2, 2, 1e-3), "swallowed corner must not be meshed")
    // ...the three seam-edge corners appear exactly: on edge (x=2, y=2) the
    // sphere cuts at z = 2 − 1.5 = 0.5, and cyclically.
    assert.ok(hasVertexAt(r, 2, 2, 0.5, 1e-5), "seam corner (2,2,0.5) missing")
    assert.ok(hasVertexAt(r, 2, 0.5, 2, 1e-5), "seam corner (2,0.5,2) missing")
    assert.ok(hasVertexAt(r, 0.5, 2, 2, 1e-5), "seam corner (0.5,2,2) missing")
    // Unswallowed native corners survive exactly.
    assert.ok(hasVertexAt(r, -2, -2, -2, 1e-6))
    assert.ok(hasVertexAt(r, 2, -2, -2, 1e-6))
})
