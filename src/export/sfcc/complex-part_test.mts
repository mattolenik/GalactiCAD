import assert from "node:assert/strict"
import test from "node:test"
import { Box } from "../../scene/primitives/box.mjs"
import { Sphere } from "../../scene/primitives/sphere.mjs"
import { Cylinder } from "../../scene/primitives/cylinder.mjs"
import { Union } from "../../scene/operators/union.mjs"
import { Subtract } from "../../scene/operators/subtract.mjs"
import { Rotate } from "../../scene/operators/rotate.mjs"
import type { Node } from "../../scene/base.mjs"
import { compileCpuSdf, type CpuSdfTree } from "./cpu-sdf.mjs"
import { runSfccPipeline, type SfccPipelineResult } from "./assemble.mjs"
import { DEFAULT_SFCC_TUNING, type SfccTuning } from "./sfcc-tuning.mjs"

const TUNING: SfccTuning = { ...DEFAULT_SFCC_TUNING, depthMin: 5, depthMax: 7, boundsPaddingMm: 0 }

/**
 * A bracket-like part exercising the full S1 pipeline at once: three unioned
 * shapes (plate, boss cylinder, corner bump sphere) minus three cutters
 * (through-bore, corner notch box, rotated slot box). The slot is sized to end
 * in a blind pocket INSIDE the plate — a longer slot (half-length 3.2) pokes
 * past the plate's x=−3 wall and punches a genuine window through the bump's
 * overhang flange, raising the genus to 2 (verified by ablation; the mesh was
 * correct, the expectation wasn't). Mirrors
 * test/testcases/meshing/sfcc-complex-bracket.yaml.
 */
function complexPart(): Node {
    const plate = new Box([0, 0, 0], [3, 1, 2.4])
    const boss = new Cylinder([1.2, 1.2, 0], { r: 1.2, h: 1.6 })
    const bump = new Sphere([-3, 1, -2.4], { r: 1.1 })
    const body = new Union([plate, boss, bump])
    const bore = new Cylinder([1.2, 0, 0], { r: 0.55, h: 4 })
    const notch = new Box([3, 1, 2.4], [0.8, 1.2, 0.8])
    const slot = new Rotate([0, 25, 0], new Box([-1.6, 1.2, 0], [0.5, 1.4, 2.4]))
    return new Subtract(new Subtract(new Subtract(body, bore), notch), slot)
}

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

test("sfcc pipeline: complex bracket (3 unions, 3 subtractions) → closed genus-1 manifold with exact features", () => {
    const tree = compileCpuSdf(complexPart())
    const r = runSfccPipeline(tree, { minX: -8, minY: -8, minZ: -8, size: 16 }, TUNING)

    // Structural certification.
    assert.equal(r.stats.failedCells, 0, "no failed cells")
    assert.equal(r.stats.faceAuditFailures, 0, "face audit clean")
    assert.equal(r.stats.boundaryViolations, 0)
    assert.ok(r.manifold.ok, JSON.stringify(r.manifold))
    assert.equal(r.manifold.components, 1, "one connected part")
    // One through-hole (the bore) ⇒ genus 1 ⇒ χ = 0; the notch is an open cut
    // and the slot is a top-open groove ending in a blind pocket (material
    // remains beneath and beyond it) — neither adds a handle.
    assert.deepEqual(r.manifold.eulerPerComponent, [0])

    // Every vertex on the exact surface.
    const mf = maxAbsF(tree, r)
    assert.ok(mf <= TUNING.surfaceTolMm, `max |f| at vertices = ${mf}`)

    // Feature cells dominate failures budget: fallbacks stay a small fraction.
    assert.ok(
        r.stats.featureCellFallbacks <= Math.max(2, 0.15 * (r.stats.edgeCells + r.stats.cornerCells)),
        `fallbacks ${r.stats.featureCellFallbacks} vs ${r.stats.edgeCells} edge + ${r.stats.cornerCells} corner cells`,
    )
    assert.ok(r.stats.edgeCells > 0)
    assert.ok(r.stats.cornerCells > 0)

    // --- exact boolean features, spot-checked --------------------------------
    // Bore rim on the boss top (y = 1.2 + 1.6 = 2.8): an exact vertex chain on
    // the circle ρ((x,z) − (1.2, 0)) = 0.55.
    let boreRim = 0
    for (let i = 0; i < r.verts.length; i += 8) {
        const rho = Math.hypot(r.verts[i]! - 1.2, r.verts[i + 2]!)
        if (Math.abs(rho - 0.55) < 1e-6 && Math.abs(r.verts[i + 1]! - 2.8) < 1e-6) boreRim++
    }
    assert.ok(boreRim > 8, `bore rim chain on boss top: ${boreRim} vertices`)

    // Notch: triple corner where the notch's two inner faces (x = 2.2, z = 1.6)
    // meet the plate top (y = 1) — a boolean-created corner.
    assert.ok(hasVertexAt(r, 2.2, 1, 1.6, 1e-5), "notch triple corner (2.2, 1, 1.6) missing")
    // Notch inner vertical edge crosses the plate's native top-front edge too:
    // corners where the notch walls meet the plate edge (y=1, z=2.4).
    assert.ok(hasVertexAt(r, 2.2, 1, 2.4, 1e-5), "notch–edge corner (2.2, 1, 2.4) missing")

    // Bump sphere centered on the plate corner (−3, 1, −2.4): cuts the plate's
    // top edge (y=1, z=−2.4) at x = −3 + 1.1 = −1.9 — same boolean-corner
    // pattern as the P6 acceptance, embedded in a busier scene.
    assert.ok(hasVertexAt(r, -1.9, 1, -2.4, 1e-5), "bump seam corner (−1.9, 1, −2.4) missing")
    // The swallowed plate corner itself must NOT be meshed.
    assert.ok(!hasVertexAt(r, -3, 1, -2.4, 1e-3), "swallowed corner must not appear")

    // Surviving native corners stay exact.
    assert.ok(hasVertexAt(r, -3, -1, 2.4, 1e-6), "native plate corner missing")

    // Unsupported-scene guard still works on a variant (sanity that the scene
    // itself is fully supported — compile threw nothing above).
    assert.ok(r.stats.featureCurves > 20, `curve census: ${r.stats.featureCurves}`)
})
