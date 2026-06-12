import assert from "node:assert/strict"
import test from "node:test"
import { Extrude } from "../../scene/primitives/extrude.mjs"
import { Polygon2D } from "../../scene/primitives/polygon2d.mjs"
import { Cylinder } from "../../scene/primitives/cylinder.mjs"
import { Subtract } from "../../scene/operators/subtract.mjs"
import { Rotate } from "../../scene/operators/rotate.mjs"
import { compileCpuSdf, type CpuSdfTree } from "./cpu-sdf.mjs"
import { runSfccPipeline, type SfccPipelineResult } from "./assemble.mjs"
import { DEFAULT_SFCC_TUNING, type SfccTuning } from "./sfcc-tuning.mjs"

const TUNING: SfccTuning = { ...DEFAULT_SFCC_TUNING, depthMin: 4, depthMax: 7, boundsPaddingMm: 0 }

/** Concave L-profile (6 vertices, one reflex corner), in the xz plane. */
const L_VERTS: [number, number][] = [
    [-2, -2],
    [2, -2],
    [2, 0],
    [0, 0],
    [0, 2],
    [-2, 2],
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

test("cpu evaluator: extrude distance/normal parity and interval containment", () => {
    const tree = compileCpuSdf(new Extrude(new Polygon2D(L_VERTS), { h: 2 }))
    // Hand-checked values: outside the +x side wall.
    assert.ok(Math.abs(tree.f(3, 0.5, -1) - 1) < 1e-12)
    // Inside the L near the reflex corner.
    assert.ok(tree.f(-1, 0, 1) < 0)
    // In the L's notch (outside material, inside the bounding box).
    assert.ok(tree.f(1, 0, 1) > 0)
    // Above the cap.
    assert.ok(Math.abs(tree.f(-1, 3, -1) - 1) < 1e-12)

    // Twisted: interval containment property (the certificate the octree uses).
    const twisted = compileCpuSdf(new Extrude(new Polygon2D(L_VERTS), { h: 2, t: 90 }))
    let seed = 424242
    const rnd = (): number => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        return seed / 0x7fffffff
    }
    for (let k = 0; k < 150; k++) {
        const cx = (rnd() - 0.5) * 7
        const cy = (rnd() - 0.5) * 7
        const cz = (rnd() - 0.5) * 7
        const hx = rnd() * 0.7 + 0.01
        const [lo, hi] = twisted.intervalOverBox(cx, cy, cz, hx, hx, hx)
        for (let m = 0; m < 8; m++) {
            const v = twisted.f(cx + (rnd() * 2 - 1) * hx, cy + (rnd() * 2 - 1) * hx, cz + (rnd() * 2 - 1) * hx)
            assert.ok(v >= lo - 1e-9 && v <= hi + 1e-9, `f=${v} outside [${lo}, ${hi}]`)
        }
    }
})

test("sfcc pipeline: L-extrude (concave profile) → closed manifold, exact edges incl. the reflex edge", () => {
    const tree = compileCpuSdf(new Extrude(new Polygon2D(L_VERTS), { h: 2 }))
    const r = runSfccPipeline(tree, { minX: -8, minY: -8, minZ: -8, size: 16 }, TUNING)
    assert.equal(r.stats.failedCells, 0)
    assert.equal(r.stats.faceAuditFailures, 0)
    assert.ok(r.manifold.ok, JSON.stringify(r.manifold))
    assert.equal(r.manifold.components, 1)
    assert.deepEqual(r.manifold.eulerPerComponent, [2])
    assert.ok(maxAbsF(tree, r) <= TUNING.surfaceTolMm)
    // All 12 cap corners exact — including the two REFLEX corners at (0, ±2, 0).
    for (const [vx, vz] of L_VERTS) {
        assert.ok(hasVertexAt(r, vx, 2, vz, 1e-6), `top corner (${vx}, 2, ${vz}) missing`)
        assert.ok(hasVertexAt(r, vx, -2, vz, 1e-6), `bottom corner (${vx}, −2, ${vz}) missing`)
    }
    // Vertical reflex edge chain at (0, y, 0).
    let reflexVerts = 0
    for (let i = 0; i < r.verts.length; i += 8) {
        if (Math.hypot(r.verts[i]!, r.verts[i + 2]!) < 1e-6 && Math.abs(r.verts[i + 1]!) < 2 + 1e-6) reflexVerts++
    }
    assert.ok(reflexVerts >= 6, `reflex edge chain: ${reflexVerts} vertices`)
})

test("sfcc pipeline: twisted L-extrude → closed manifold, helical edges exactly on-locus", () => {
    const twistDeg = 90
    const scene = new Extrude(new Polygon2D(L_VERTS), { h: 2, t: twistDeg })
    const tree = compileCpuSdf(scene)
    const r = runSfccPipeline(tree, { minX: -8, minY: -8, minZ: -8, size: 16 }, TUNING)
    assert.equal(r.stats.failedCells, 0)
    assert.equal(r.stats.featureCellFallbacks, 0)
    assert.equal(r.stats.faceAuditFailures, 0)
    assert.ok(r.manifold.ok, JSON.stringify(r.manifold))
    assert.equal(r.manifold.components, 1)
    assert.deepEqual(r.manifold.eulerPerComponent, [2])
    assert.ok(maxAbsF(tree, r) <= TUNING.surfaceTolMm, `max |f| = ${maxAbsF(tree, r)}`)

    // Helical edge exactness: mesh vertices within 1e-5 of the helix swept by
    // polygon vertex (2, −2): for a vertex at (x, y, z) on it,
    // R(−angle(y))·(x, z) must equal (2, −2).
    const k = (twistDeg * Math.PI) / 180
    let helixVerts = 0
    for (let i = 0; i < r.verts.length; i += 8) {
        const x = r.verts[i]!
        const y = r.verts[i + 1]!
        const z = r.verts[i + 2]!
        if (Math.abs(y) > 2 + 1e-9) continue
        const angle = k * Math.max(0, Math.min(1, (y + 2) / 4))
        const ca = Math.cos(angle)
        const sa = Math.sin(angle)
        const ux = ca * x + sa * z
        const uz = -sa * x + ca * z
        if (Math.hypot(ux - 2, uz - -2) < 1e-5) helixVerts++
    }
    assert.ok(helixVerts >= 8, `helical edge chain: ${helixVerts} vertices`)

    // All 12 cap corners exact under twist: slim wedges invisible to lattice
    // samples are recovered via per-stratum carrier crossings and routed by
    // stratum-tagged pairing (face-contour.mts) — no wedge tips dropped.
    const ca = Math.cos(k)
    const sa = Math.sin(k)
    for (const [vx, vz] of L_VERTS) {
        assert.ok(hasVertexAt(r, vx, -2, vz, 1e-6), `bottom corner (${vx}, −2, ${vz}) missing`)
        assert.ok(
            hasVertexAt(r, ca * vx - sa * vz, 2, sa * vx + ca * vz, 1e-6),
            `top corner for profile (${vx}, ${vz}) missing`,
        )
    }
})

test("sfcc pipeline: rotated twisted extrude minus cylinder bore → genus-1, seams on twisted carriers", () => {
    const part = new Rotate(
        [15, 0, 10],
        new Subtract(new Extrude(new Polygon2D(L_VERTS), { h: 2, t: 60 }), new Cylinder([-0.9, 0, -0.9], { r: 0.5, h: 3 })),
    )
    const tree = compileCpuSdf(part)
    const r = runSfccPipeline(tree, { minX: -8, minY: -8, minZ: -8, size: 16 }, TUNING)
    assert.equal(r.stats.failedCells, 0)
    assert.equal(r.stats.faceAuditFailures, 0)
    assert.ok(r.manifold.ok, JSON.stringify(r.manifold))
    assert.equal(r.manifold.components, 1)
    assert.deepEqual(r.manifold.eulerPerComponent, [0], "through-bore ⇒ genus 1")
    assert.ok(maxAbsF(tree, r) <= TUNING.surfaceTolMm, `max |f| = ${maxAbsF(tree, r)}`)
})
