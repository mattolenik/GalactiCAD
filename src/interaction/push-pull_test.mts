import assert from "node:assert/strict"
import test from "node:test"
import type { Extrude } from "../scene/scene.mjs"
import { twistAngleAt, toProfileXZ, closestPolygonEdge, faceFrame } from "./push-pull.mjs"

/**
 * Tests for the twist un-projection used by push/pull surface selection on
 * twisted extrudes. These are the math that lets selection + push/pull work
 * "through" the twist: a world-space hit is rotated back into the polygon
 * (profile) space the SDF extrudes, so the picked edge matches the GPU's.
 */

/** Minimal Extrude duck for the pure helpers (they read only twistDegrees/h/pos). */
function fakeExtrude(twistDegrees: number, h: number, posY = 0): Extrude {
    return { twistDegrees, h, pos: { x: 0, y: posY, z: 0 } } as unknown as Extrude
}

/** CCW unit square in profile XZ; edge 0=−Z, 1=+X, 2=+Z, 3=−X (start-vertex indexing). */
const SQUARE: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]]

test("twistAngleAt: untwisted extrude → 0 at any height", () => {
    const e = fakeExtrude(0, 2)
    assert.equal(twistAngleAt(e, 2), 0)
    assert.equal(twistAngleAt(e, -2), 0)
    assert.equal(twistAngleAt(e, 0), 0)
})

test("twistAngleAt: linear ramp from 0 at bottom to full twist at top, clamped", () => {
    const full = Math.PI / 2 // 90°
    const e = fakeExtrude(90, 2) // half-height 2 → spans local y ∈ [−2, 2]
    assert.ok(Math.abs(twistAngleAt(e, -2) - 0) < 1e-9, "bottom → 0")
    assert.ok(Math.abs(twistAngleAt(e, 0) - full / 2) < 1e-9, "mid → half")
    assert.ok(Math.abs(twistAngleAt(e, 2) - full) < 1e-9, "top → full")
    // clamps outside [−h, h]
    assert.ok(Math.abs(twistAngleAt(e, 100) - full) < 1e-9, "above top clamps")
    assert.ok(Math.abs(twistAngleAt(e, -100) - 0) < 1e-9, "below bottom clamps")
})

test("twistAngleAt: respects pos.y offset and degenerate height", () => {
    assert.ok(Math.abs(twistAngleAt(fakeExtrude(90, 2, 10), 10) - Math.PI / 4) < 1e-9, "mid at pos.y=10")
    assert.equal(twistAngleAt(fakeExtrude(90, 0), 0), 0, "h≈0 → no twist (avoids /0)")
})

test("toProfileXZ: matches WGSL twisted = (ca*x + sa*z, -sa*x + ca*z)", () => {
    const a = Math.PI / 2 // ca=0, sa=1
    const [px, pz] = toProfileXZ(0, 1, a)
    assert.ok(Math.abs(px - 1) < 1e-9 && Math.abs(pz - 0) < 1e-9)
    // angle 0 is identity
    assert.deepEqual(toProfileXZ(0.3, -0.7, 0), [0.3, -0.7])
})

test("round-trip: a world hit on the +X profile face of a 90° twist top selects edge 1", () => {
    // At the top (full 90° twist) the +X profile face has rotated to face +Z in
    // world. World point (0, top, 1) un-twists back to profile (1, 0) → edge 1.
    const e = fakeExtrude(90, 2)
    const angle = twistAngleAt(e, 2)
    const [px, pz] = toProfileXZ(0 - e.pos.x, 1 - e.pos.z, angle)
    assert.ok(Math.abs(px - 1) < 1e-9 && Math.abs(pz - 0) < 1e-9)
    assert.equal(closestPolygonEdge(SQUARE, px, pz), 1)
})

test("round-trip: same +X face at the bottom (zero twist) selects edge 1 directly", () => {
    const e = fakeExtrude(90, 2)
    const angle = twistAngleAt(e, -2) // 0
    const [px, pz] = toProfileXZ(1, 0, angle) // world +X
    assert.equal(closestPolygonEdge(SQUARE, px, pz), 1)
})

test("round-trip: untwisted picker is unchanged (every face maps to its own edge)", () => {
    const e = fakeExtrude(0, 2)
    const cases: Array<[number, number, number]> = [
        [0, -1, 0], // −Z face → edge 0
        [1, 0, 1],  // +X face → edge 1
        [0, 1, 2],  // +Z face → edge 2
        [-1, 0, 3], // −X face → edge 3
    ]
    for (const [wx, wz, expected] of cases) {
        const [px, pz] = toProfileXZ(wx, wz, twistAngleAt(e, 0))
        assert.equal(closestPolygonEdge(SQUARE, px, pz), expected, `world (${wx},${wz})`)
    }
})

test("faceFrame: angle 0 → world normal == profile normal lifted to XZ", () => {
    // The 2D normal lives in profile space and drives the vertex edit; with no
    // twist it lifts straight to world as (nx, 0, ny). (Outward sign comes from
    // the polygon winding via the shipped computeSignedArea logic, preserved
    // verbatim here, so we assert the lift relationship rather than a fixed sign.)
    const f = faceFrame(SQUARE, 1, 0)
    assert.ok(Math.abs(f.normal3D.x - f.normal2D.x) < 1e-9)
    assert.ok(Math.abs(f.normal3D.y) < 1e-9)
    assert.ok(Math.abs(f.normal3D.z - f.normal2D.y) < 1e-9)
    assert.ok(Math.abs(f.normal2D.x ** 2 + f.normal2D.y ** 2 - 1) < 1e-9, "unit normal")
})

test("faceFrame: world normal is the profile normal rotated by the inverse twist R(-angle)", () => {
    const EPS = 1e-5 // Vec3f is Float32Array-backed (~1e-7 relative precision)
    for (const i of [0, 1, 2, 3]) {
        for (const angle of [Math.PI / 6, Math.PI / 2, -1.1]) {
            const f = faceFrame(SQUARE, i, angle)
            const ca = Math.cos(angle), sa = Math.sin(angle)
            // R(-angle) applied to (nx, ny): (ca*nx - sa*ny, sa*nx + ca*ny).
            const wantX = ca * f.normal2D.x - sa * f.normal2D.y
            const wantZ = sa * f.normal2D.x + ca * f.normal2D.y
            assert.ok(Math.abs(f.normal3D.x - wantX) < EPS, `edge ${i} a ${angle} x`)
            assert.ok(Math.abs(f.normal3D.z - wantZ) < EPS, `edge ${i} a ${angle} z`)
            assert.ok(Math.abs(f.normal3D.y) < EPS, "stays in XZ plane")
            // Rotation preserves length: world normal is still unit.
            assert.ok(Math.abs(f.normal3D.x ** 2 + f.normal3D.z ** 2 - 1) < EPS, "unit")
        }
    }
})
