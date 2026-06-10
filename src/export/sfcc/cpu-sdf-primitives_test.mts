import assert from "node:assert/strict"
import test from "node:test"
import {
    boxDist,
    boxNormal,
    coneDist,
    coneNormal,
    cylinderDist,
    cylinderNormal,
    sphereDist,
    sphereNormal,
} from "./cpu-sdf-primitives.mjs"

type Dist = (x: number, y: number, z: number) => number
type Normal = (x: number, y: number, z: number, out: Float64Array) => void

/** Central-difference gradient cross-check (valid away from region boundaries). */
function assertGradMatchesNormal(dist: Dist, normal: Normal, x: number, y: number, z: number, tag: string): void {
    const h = 1e-6
    const g = new Float64Array(3)
    g[0] = (dist(x + h, y, z) - dist(x - h, y, z)) / (2 * h)
    g[1] = (dist(x, y + h, z) - dist(x, y - h, z)) / (2 * h)
    g[2] = (dist(x, y, z + h) - dist(x, y, z - h)) / (2 * h)
    const n = new Float64Array(3)
    normal(x, y, z, n)
    for (let a = 0; a < 3; a++) {
        assert.ok(Math.abs(g[a]! - n[a]!) < 1e-4, `${tag}: grad[${a}] ${g[a]} vs normal ${n[a]}`)
    }
}

test("sphere: distance and normal", () => {
    assert.ok(Math.abs(sphereDist(3, 0, 0, 2) - 1) < 1e-15)
    assert.ok(Math.abs(sphereDist(0, 0, 0, 2) + 2) < 1e-15)
    assert.ok(Math.abs(sphereDist(1, 2, 2, 3) - 0) < 1e-15) // |(1,2,2)| = 3
    assertGradMatchesNormal(
        (x, y, z) => sphereDist(x, y, z, 2),
        (x, y, z, o) => sphereNormal(x, y, z, o),
        1.3,
        -0.4,
        2.2,
        "sphere",
    )
})

test("box: face / edge / corner / inside distances (half-extents 1,2,3)", () => {
    const d: Dist = (x, y, z) => boxDist(x, y, z, 1, 2, 3)
    // Face: outside +x
    assert.ok(Math.abs(d(2.5, 0, 0) - 1.5) < 1e-15)
    // Edge: outside +x+y → diagonal distance
    assert.ok(Math.abs(d(2, 3, 0) - Math.hypot(1, 1)) < 1e-15)
    // Corner: outside all three
    assert.ok(Math.abs(d(2, 3, 5) - Math.hypot(1, 1, 2)) < 1e-15)
    // Inside: −min wall distance (here the x wall: 1 − 0.5)
    assert.ok(Math.abs(d(0.5, 0, 0) + 0.5) < 1e-15)
    // Surface points
    assert.ok(Math.abs(d(1, 0, 0)) < 1e-15)
    assert.ok(Math.abs(d(1, 2, 3)) < 1e-15)
})

test("box: gradient cross-check in all regions", () => {
    const d: Dist = (x, y, z) => boxDist(x, y, z, 1, 2, 3)
    const n: Normal = (x, y, z, o) => boxNormal(x, y, z, 1, 2, 3, o)
    assertGradMatchesNormal(d, n, 2.5, 0.3, -0.2, "box face +x")
    assertGradMatchesNormal(d, n, 1.8, 2.9, 0.4, "box edge +x+y")
    assertGradMatchesNormal(d, n, 2, 3, 4.5, "box corner")
    assertGradMatchesNormal(d, n, 0.6, 0.2, -0.1, "box inside (x wall closest)")
})

test("cylinder: side / cap / rim / inside (r=2, h=1)", () => {
    const d: Dist = (x, y, z) => cylinderDist(x, y, z, 2, 1)
    // Side
    assert.ok(Math.abs(d(3, 0, 0) - 1) < 1e-15)
    // Cap
    assert.ok(Math.abs(d(0.5, 2, 0) - 1) < 1e-15)
    // Outside rim corner
    assert.ok(Math.abs(d(3, 2, 0) - Math.hypot(1, 1)) < 1e-15)
    // Surface
    assert.ok(Math.abs(d(2, 0.5, 0)) < 1e-15)
    assert.ok(Math.abs(d(0, 1, 1)) < 1e-15) // on the cap
    // Inside center: exact interior distance — NOT the WGSL phantom-axis value.
    assert.ok(Math.abs(d(0, 0, 0) + 1) < 1e-15, "axis center should be −min(r, h) = −1")
    // On the axis the value must be strictly negative (no phantom zero).
    assert.ok(d(0, 0.5, 0) < -0.4)
})

test("cylinder: gradient cross-check", () => {
    const d: Dist = (x, y, z) => cylinderDist(x, y, z, 2, 1)
    const n: Normal = (x, y, z, o) => cylinderNormal(x, y, z, 2, 1, o)
    assertGradMatchesNormal(d, n, 3, 0.3, 0.4, "cyl side")
    assertGradMatchesNormal(d, n, 0.5, 1.8, 0.3, "cyl cap")
    assertGradMatchesNormal(d, n, 2.5, 1.5, 1.0, "cyl rim corner")
    assertGradMatchesNormal(d, n, 1.2, 0.2, 0.5, "cyl inside side-closest")
    assertGradMatchesNormal(d, n, 0.3, 0.85, 0.2, "cyl inside cap-closest")
})

test("cone: all four regions (r=2, h=3)", () => {
    const d: Dist = (x, y, z) => coneDist(x, y, z, 2, 3)
    const L = Math.hypot(3, 2)
    // Mantle: surface point at base rim (ρ=2, y=0) and mid-slope (ρ=1, y=1.5)
    assert.ok(Math.abs(d(2, 0, 0)) < 1e-15)
    assert.ok(Math.abs(d(1, 1.5, 0)) < 1e-15)
    // Base region: directly below the center
    assert.ok(Math.abs(d(0.5, -1, 0) - 1) < 1e-15)
    // Tip region: directly above the apex
    assert.ok(Math.abs(d(0, 4, 0) - 1) < 1e-15)
    // Base-rim region: outside radius, below base level diagonal
    assert.ok(Math.abs(d(3, -1, 0) - Math.hypot(1, 1)) < 1e-15)
    // Inside on the axis at y=1: base plane (dist 1) is closer than the mantle (4/L ≈ 1.109)
    assert.ok(4 / L > 1) // sanity: the base really is the winner here
    assert.ok(Math.abs(d(0, 1, 0) + 1) < 1e-15)
})

test("cone: gradient cross-check", () => {
    const d: Dist = (x, y, z) => coneDist(x, y, z, 2, 3)
    const n: Normal = (x, y, z, o) => coneNormal(x, y, z, 2, 3, o)
    assertGradMatchesNormal(d, n, 2.2, 0.8, 0.5, "cone mantle outside")
    assertGradMatchesNormal(d, n, 0.4, -0.7, 0.2, "cone base")
    assertGradMatchesNormal(d, n, 0.15, 4.2, -0.1, "cone tip")
    assertGradMatchesNormal(d, n, 3.1, -0.9, 0.7, "cone base rim")
    assertGradMatchesNormal(d, n, 0.3, 0.8, 0.2, "cone inside")
})
