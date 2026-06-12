import assert from "node:assert/strict"
import test from "node:test"
import { Lathe } from "../../scene/primitives/lathe.mjs"
import { Polygon2D } from "../../scene/primitives/polygon2d.mjs"
import { Box } from "../../scene/primitives/box.mjs"
import { Subtract } from "../../scene/operators/subtract.mjs"
import { Rotate } from "../../scene/operators/rotate.mjs"
import { compileCpuSdf, SfccUnsupportedError, type CpuSdfTree } from "./cpu-sdf.mjs"
import { compileFeatureSet } from "./feature-set.mjs"
import { resolveTolerances } from "./tolerances.mjs"
import { runSfccPipeline, type SfccPipelineResult } from "./assemble.mjs"
import { DEFAULT_SFCC_TUNING, type SfccTuning } from "./sfcc-tuning.mjs"

const TUNING: SfccTuning = { ...DEFAULT_SFCC_TUNING, depthMin: 4, depthMax: 7, boundsPaddingMm: 0 }
const BOUNDS = { minX: -8, minY: -8, minZ: -8, size: 16 }

/** Square tube cross-section at radius 2..3, height −1..+1 → a square-section washer (genus 1). */
const SQUARE_TUBE: [number, number][] = [
    [2, -1],
    [3, -1],
    [3, 1],
    [2, 1],
]

/**
 * Cone-like profile touching the axis at the apex (0, 2) and the base center
 * (0, −2). The apex angle matches the proven Cone-primitive configuration
 * (tan α = 3/4): an on-axis apex tip is visible to face contouring only while
 * its cross-circle at the first lattice plane (tan α × jitter offset) clears
 * the jittered lattice lines — slimmer tips drop at max-cell scale (the
 * accepted sub-sample limitation, see the slim-apex test below).
 */
const CONE_PROFILE: [number, number][] = [
    [0, 2],
    [3, -2],
    [0, -2],
]

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

/** Count mesh vertices exactly on the Y-axis ring (radius rr, height ry). */
function ringVertexCount(r: SfccPipelineResult, rr: number, ry: number): number {
    let n = 0
    for (let i = 0; i < r.verts.length; i += 8) {
        const rho = Math.hypot(r.verts[i]!, r.verts[i + 2]!)
        if (Math.abs(rho - rr) < 1e-6 && Math.abs(r.verts[i + 1]! - ry) < 1e-6) n++
    }
    return n
}

test("cpu evaluator: lathe distance/normal parity, axis interior, interval containment", () => {
    const tree = compileCpuSdf(new Lathe(new Polygon2D(SQUARE_TUBE)))
    // Outside the outer wall (ρ = 4 vs wall at 3).
    assert.ok(Math.abs(tree.f(4, 0, 0) - 1) < 1e-12)
    // Inside the tube (nearest walls 0.5 away).
    assert.ok(Math.abs(tree.f(2.5, 0, 0) - -0.5) < 1e-12)
    // In the bore (air): distance to the inner wall, measured off-axis too.
    assert.ok(Math.abs(tree.f(0, 0, 0) - 2) < 1e-12)
    assert.ok(Math.abs(tree.f(0, 0, 1) - 1) < 1e-12)
    // Above the cap.
    assert.ok(Math.abs(tree.f(2.5, 2, 0) - 1) < 1e-12)
    // Rotational symmetry.
    assert.ok(Math.abs(tree.f(2.5 * Math.SQRT1_2, 0.3, 2.5 * Math.SQRT1_2) - tree.f(2.5, 0.3, 0)) < 1e-12)

    // Profile edges ON the axis are interior, not boundary: f on the axis deep
    // inside a coned solid must be strictly negative (the WGSL meridian trick
    // would report 0 there — the documented deviation).
    const cone = compileCpuSdf(new Lathe(new Polygon2D(CONE_PROFILE)))
    // At the origin: mantle line through (0,2)-(3,-2) is 1.2 away, base 2.
    assert.ok(Math.abs(cone.f(0, 0, 0) - -1.2) < 1e-12, `axis interior f = ${cone.f(0, 0, 0)}`)
    // Sign-correct at the apex and just above it.
    assert.ok(Math.abs(cone.f(0, 2, 0)) < 1e-12)
    assert.ok(Math.abs(cone.f(0, 2.5, 0) - 0.5) < 1e-12)

    // Exact SDF ⇒ the default L = 1 interval certificate must contain f.
    let seed = 987654
    const rnd = (): number => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        return seed / 0x7fffffff
    }
    for (let k = 0; k < 150; k++) {
        const cx = (rnd() - 0.5) * 8
        const cy = (rnd() - 0.5) * 8
        const cz = (rnd() - 0.5) * 8
        const hx = rnd() * 0.7 + 0.01
        const [lo, hi] = cone.intervalOverBox(cx, cy, cz, hx, hx, hx)
        for (let m = 0; m < 8; m++) {
            const v = cone.f(cx + (rnd() * 2 - 1) * hx, cy + (rnd() * 2 - 1) * hx, cz + (rnd() * 2 - 1) * hx)
            assert.ok(v >= lo - 1e-9 && v <= hi + 1e-9, `f=${v} outside [${lo}, ${hi}]`)
        }
    }
})

test("cpu evaluator: lathe profile crossing the axis is unsupported", () => {
    assert.throws(
        () =>
            compileCpuSdf(
                new Lathe(
                    new Polygon2D([
                        [-1, 0],
                        [2, 0],
                        [2, 1],
                    ]),
                ),
            ),
        SfccUnsupportedError,
    )
})

test("feature compile: lathe rings, pole corners, trim survival", () => {
    const tol = resolveTolerances(TUNING, Math.hypot(16, 16, 16))

    // Washer: 4 sharp profile vertices → 4 closed ring circles, no corners.
    const washer = compileCpuSdf(new Lathe(new Polygon2D(SQUARE_TUBE)))
    const fsW = compileFeatureSet(washer, tol)
    assert.equal(fsW.curves.length, 4)
    for (const c of fsW.curves) {
        assert.equal(c.kind, "circle")
        assert.ok(c.closed)
    }
    assert.equal(fsW.corners.length, 0)

    // Cone profile: base rim ring + apex pole corner; the base-center pole
    // (flat disk interior) must NOT become a corner.
    const cone = compileCpuSdf(new Lathe(new Polygon2D(CONE_PROFILE)))
    const fsC = compileFeatureSet(cone, tol)
    assert.equal(fsC.curves.length, 1)
    assert.equal(fsC.curves[0]!.kind, "circle")
    assert.equal(fsC.corners.length, 1)
    assert.ok(Math.hypot(fsC.corners[0]!.x, fsC.corners[0]!.y - 2, fsC.corners[0]!.z) < 1e-12)
})

test("sfcc pipeline: square-section washer → genus-1 manifold, 4 exact feature rings", () => {
    const tree = compileCpuSdf(new Lathe(new Polygon2D(SQUARE_TUBE)))
    const r = runSfccPipeline(tree, BOUNDS, TUNING)
    assert.equal(r.stats.failedCells, 0)
    assert.equal(r.stats.faceAuditFailures, 0)
    assert.ok(r.manifold.ok, JSON.stringify(r.manifold))
    assert.equal(r.manifold.components, 1)
    assert.deepEqual(r.manifold.eulerPerComponent, [0], "washer ⇒ genus 1")
    assert.ok(maxAbsF(tree, r) <= TUNING.surfaceTolMm, `max |f| = ${maxAbsF(tree, r)}`)
    // Every ring carries a chain of vertices exactly on the analytic circle.
    for (const [rr, ry] of SQUARE_TUBE) {
        const n = ringVertexCount(r, rr, ry)
        assert.ok(n >= 8, `ring (r=${rr}, y=${ry}): ${n} exact vertices`)
    }
})

test("sfcc pipeline: coned lathe → exact apex corner and base rim, smooth base center", () => {
    const tree = compileCpuSdf(new Lathe(new Polygon2D(CONE_PROFILE)))
    const r = runSfccPipeline(tree, BOUNDS, TUNING)
    assert.equal(r.stats.failedCells, 0)
    assert.equal(r.stats.faceAuditFailures, 0)
    assert.ok(r.manifold.ok, JSON.stringify(r.manifold))
    assert.equal(r.manifold.components, 1)
    assert.deepEqual(r.manifold.eulerPerComponent, [2])
    assert.ok(maxAbsF(tree, r) <= TUNING.surfaceTolMm, `max |f| = ${maxAbsF(tree, r)}`)
    assert.ok(r.stats.cornerCells >= 1, `apex corner cell (got ${r.stats.cornerCells})`)
    assert.ok(hasVertexAt(r, 0, 2, 0, 1e-6), "apex vertex missing")
    const rim = ringVertexCount(r, 3, -2)
    assert.ok(rim >= 8, `base rim: ${rim} exact vertices`)
})

test("sfcc pipeline: slim on-axis apex → tip drops at cell scale but the mesh stays closed", () => {
    // tan α = 3/7: the apex cross-circle at the first lattice plane is smaller
    // than the irrational lattice jitter, so no lattice edge ever sees the tip
    // (self-similar with depth — the same accepted sub-sample class as twisted
    // wedge tips). The corner cell has no visible crossings and meshes
    // nothing; the neighbor below lids the surface, keeping the mesh closed
    // and certified.
    const tree = compileCpuSdf(
        new Lathe(
            new Polygon2D([
                [0, 5],
                [3, -2],
                [0, -2],
            ]),
        ),
    )
    const r = runSfccPipeline(tree, BOUNDS, TUNING)
    assert.equal(r.stats.failedCells, 0)
    assert.equal(r.stats.faceAuditFailures, 0)
    assert.ok(r.manifold.ok, JSON.stringify(r.manifold))
    assert.equal(r.manifold.components, 1)
    assert.deepEqual(r.manifold.eulerPerComponent, [2])
    assert.ok(maxAbsF(tree, r) <= TUNING.surfaceTolMm, `max |f| = ${maxAbsF(tree, r)}`)
    // The tip loss is bounded by ~a max-depth cell.
    let gap = Infinity
    for (let i = 0; i < r.verts.length; i += 8) {
        gap = Math.min(gap, Math.hypot(r.verts[i]!, r.verts[i + 1]! - 5, r.verts[i + 2]!))
    }
    assert.ok(gap <= 16 / (1 << TUNING.depthMax), `apex gap ${gap}`)
})

test("sfcc pipeline: rotated washer minus box → seams over revolved carriers, genus drops to 0", () => {
    // The box severs the ring solid (full cross-section near (2.5, 0, 0)), so
    // the genus-1 washer becomes a C-channel (genus 0); the whole part is then
    // rotated to exercise the baked-similarity carriers off-axis.
    const part = new Rotate([15, 0, 10], new Subtract(new Lathe(new Polygon2D(SQUARE_TUBE)), new Box([2.5, 0, 0], [0.8, 1.4, 0.8])))
    const tree = compileCpuSdf(part)
    const r = runSfccPipeline(tree, BOUNDS, TUNING)
    assert.equal(r.stats.failedCells, 0)
    assert.equal(r.stats.faceAuditFailures, 0)
    assert.ok(r.manifold.ok, JSON.stringify(r.manifold))
    assert.equal(r.manifold.components, 1)
    assert.deepEqual(r.manifold.eulerPerComponent, [2], "severed washer ⇒ genus 0")
    assert.ok(maxAbsF(tree, r) <= TUNING.surfaceTolMm, `max |f| = ${maxAbsF(tree, r)}`)
})
