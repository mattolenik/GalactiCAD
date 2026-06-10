import assert from "node:assert/strict"
import test from "node:test"
import { compileCpuSdf, SfccUnsupportedError } from "./cpu-sdf.mjs"
import { Box } from "../../scene/primitives/box.mjs"
import { Sphere } from "../../scene/primitives/sphere.mjs"
import { Cylinder } from "../../scene/primitives/cylinder.mjs"
import { Torus } from "../../scene/primitives/torus.mjs"
import { Union } from "../../scene/operators/union.mjs"
import { Subtract } from "../../scene/operators/subtract.mjs"
import { Intersect } from "../../scene/operators/intersect.mjs"
import { Scale } from "../../scene/operators/scale.mjs"

test("union/subtract/intersect distance semantics", () => {
    const a = new Sphere([0, 0, 0], { r: 1 })
    const b = new Sphere([1.5, 0, 0], { r: 1 })

    const u = compileCpuSdf(new Union([a, b]))
    assert.ok(Math.abs(u.f(-1, 0, 0)) < 1e-15) // surface of a
    assert.ok(Math.abs(u.f(2.5, 0, 0)) < 1e-15) // surface of b
    assert.ok(u.f(0.75, 0, 0) < 0) // inside both
    assert.ok(Math.abs(u.f(0.75, 3, 0) - Math.min(Math.hypot(0.75, 3) - 1, Math.hypot(0.75, 3) - 1)) < 1e-12)

    const i = compileCpuSdf(new Intersect(new Sphere([0, 0, 0], { r: 1 }), new Sphere([1.5, 0, 0], { r: 1 })))
    assert.ok(i.f(0, 0, 0) > 0) // outside b → outside intersection
    assert.ok(i.f(0.75, 0, 0) < 0) // inside lens
    assert.ok(Math.abs(i.f(0.5, 0, 0)) < 1e-15) // on b's surface inside a

    const s = compileCpuSdf(new Subtract(new Sphere([0, 0, 0], { r: 1 }), new Sphere([1.5, 0, 0], { r: 1 })))
    assert.ok(s.f(0.75, 0, 0) > 0) // carved away
    assert.ok(s.f(0, 0, 0) < 0) // still inside a
    assert.ok(Math.abs(s.f(0.5, 0, 0)) < 1e-15) // on the cutter wall
})

test("subtract bakes cutter orientation: gradient points into the cutter", () => {
    // Box minus cylinder drilled along y through the middle.
    const box = new Box([0, 0, 0], [2, 1, 2])
    const cyl = new Cylinder([0, 0, 0], { r: 0.5, h: 2 })
    const tree = compileCpuSdf(new Subtract(box, cyl))
    // Point on the hole wall (x = 0.5, inside the box material region).
    assert.ok(Math.abs(tree.f(0.5, 0, 0)) < 1e-15)
    const g = new Float64Array(3)
    tree.grad(0.5, 0, 0, g)
    // Outward normal of the final solid points toward the hole axis (−x here).
    assert.ok(g[0]! < -0.99, `grad ${g[0]},${g[1]},${g[2]}`)
    // Just outside the hole wall (inside material): f < 0.
    assert.ok(tree.f(0.6, 0, 0) < 0)
    // Inside the hole (air): f > 0.
    assert.ok(tree.f(0.3, 0, 0) > 0)
})

test("nested subtract flips twice: cutter-of-cutter material is solid again", () => {
    // a − (b − c): points in (a ∩ c ∩ b) remain solid.
    const a = new Box([0, 0, 0], [3, 3, 3])
    const b = new Box([0, 0, 0], [1, 1, 1])
    const c = new Box([0, 0, 0], [0.5, 0.5, 0.5])
    const tree = compileCpuSdf(new Subtract(a, new Subtract(b, c)))
    assert.ok(tree.f(0, 0, 0) < 0, "center is inside c → not carved")
    assert.ok(tree.f(0.75, 0, 0) > 0, "inside b−c → carved")
    assert.ok(tree.f(2, 0, 0) < 0, "outside b → solid a")
})

test("unsupported nodes are all collected with reasons", () => {
    const ok = new Sphere([0, 0, 0], { r: 1 })
    const torus = new Torus([0, 0, 0], { sr: 0.2, lr: 1 })
    const nonUniform = new Scale([1, 2, 1], new Sphere([0, 0, 0], { r: 1 }))
    const blended = new Union([ok, torus], 0.5)
    const scene = new Union([blended, nonUniform])
    let err: SfccUnsupportedError | null = null
    try {
        compileCpuSdf(scene)
    } catch (e) {
        err = e as SfccUnsupportedError
    }
    assert.ok(err instanceof SfccUnsupportedError)
    const types = err.unsupported.map(u => u.shapeType).sort()
    assert.deepEqual(types, ["scale", "union"])
    assert.match(err.message, /blended union/)
    assert.match(err.message, /non-uniform scale/)
})

test("cylinder fillet/chamfer rejected", () => {
    const cyl = new Cylinder([0, 0, 0], { r: 1, h: 1 })
    cyl.filletTop = 0.1
    assert.throws(() => compileCpuSdf(cyl), SfccUnsupportedError)
})

test("intervalOverBox contains all sampled values (Lipschitz certificate)", () => {
    const tree = compileCpuSdf(
        new Subtract(new Union([new Box([0, 0, 0], [1, 1, 1]), new Sphere([1, 1, 0], { r: 0.8 })]), new Cylinder([0, 0, 0], { r: 0.4, h: 2 })),
    )
    // Deterministic pseudo-random probes (no Math.random in tests for reproducibility).
    let seed = 1234567
    const rnd = (): number => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        return seed / 0x7fffffff
    }
    for (let k = 0; k < 200; k++) {
        const cx = (rnd() - 0.5) * 4
        const cy = (rnd() - 0.5) * 4
        const cz = (rnd() - 0.5) * 4
        const hx = rnd() * 0.8 + 0.01
        const hy = rnd() * 0.8 + 0.01
        const hz = rnd() * 0.8 + 0.01
        const [lo, hi] = tree.intervalOverBox(cx, cy, cz, hx, hy, hz)
        for (let m = 0; m < 8; m++) {
            const x = cx + (rnd() * 2 - 1) * hx
            const y = cy + (rnd() * 2 - 1) * hy
            const z = cz + (rnd() * 2 - 1) * hz
            const v = tree.f(x, y, z)
            assert.ok(v >= lo - 1e-12 && v <= hi + 1e-12, `f=${v} outside [${lo}, ${hi}]`)
        }
    }
})

test("activeOwnersAt: seam points report two owners, smooth points one", () => {
    const box = new Box([0, 0, 0], [1, 1, 1])
    const sph = new Sphere([1, 0, 0], { r: 0.8 })
    const tree = compileCpuSdf(new Union([box, sph]))
    // Smooth box face point far from the sphere.
    assert.equal(tree.activeOwnersAt(-1, 0, 0, 1e-9).length, 1)
    // Seam: the sphere pokes through the +x face at x=1; the seam circle is
    // x=1, y²+z² = 0.8² − 0² … sphere center (1,0,0) r=0.8 → on the plane x=1
    // the sphere section is a great circle of radius 0.8.
    const sy = 0.8
    const owners = tree.activeOwnersAt(1, sy, 0, 1e-9)
    assert.equal(owners.length, 2, "box face + sphere surface tie at the seam")
})

test("activeStrataAt: face/edge/corner of a box report 1/2/3 strata", () => {
    const tree = compileCpuSdf(new Box([0, 0, 0], [1, 2, 3]))
    assert.equal(tree.activeStrataAt(1, 0, 0, 1e-9, 1e-9).length, 1)
    assert.equal(tree.activeStrataAt(1, 2, 0, 1e-9, 1e-9).length, 2)
    assert.equal(tree.activeStrataAt(1, 2, 3, 1e-9, 1e-9).length, 3)
})

test("strata: world carriers vanish on transformed primitive surfaces", () => {
    const tree = compileCpuSdf(new Scale([2, 2, 2], new Cylinder([0.5, 0, 0], { r: 1, h: 0.5 })))
    const leaf = tree.leaves[0]!
    assert.equal(leaf.strata.length, 3)
    const side = leaf.strata[0]!
    const top = leaf.strata[1]!
    // World cylinder: center (1,0,0), r=2, h=1 (uniform scale 2).
    assert.ok(Math.abs(side.f(3, 0.3, 0)) < 1e-12)
    assert.ok(Math.abs(side.f(1, 5, 2) - 0) < 1e-12) // on the infinite carrier above the cap
    assert.ok(Math.abs(top.f(0, 1, 0)) < 1e-12)
    const n = new Float64Array(3)
    top.normal(0, 1, 0, n)
    assert.deepEqual([n[0], n[1], n[2]], [0, 1, 0])
    // project() lands on the carrier
    const p = new Float64Array(3)
    side.project(4, 7, 0.5, p)
    assert.ok(Math.abs(side.f(p[0]!, p[1]!, p[2]!)) < 1e-12)
})

test("strata sign baking: cutter strata describe the final solid", () => {
    const tree = compileCpuSdf(new Subtract(new Box([0, 0, 0], [2, 1, 2]), new Cylinder([0, 0, 0], { r: 0.5, h: 2 })))
    const cutterLeaf = tree.leaves.find(l => l.shapeType === "cylinder")!
    assert.equal(cutterLeaf.sign, -1)
    const side = cutterLeaf.strata[0]!
    // Inside the material (x=0.6 between hole wall and box wall): f < 0.
    assert.ok(side.f(0.6, 0, 0) < 0)
    // Inside the hole (air): f > 0.
    assert.ok(side.f(0.3, 0, 0) > 0)
    // Outward normal on the hole wall points toward the axis.
    const n = new Float64Array(3)
    side.normal(0.5, 0, 0, n)
    assert.ok(n[0]! < -0.99)
})
