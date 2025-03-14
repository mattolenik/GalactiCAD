import assert from "node:assert/strict"
import test from "node:test"
import { Vec2, Vec3, Vec4 } from "./vector.mjs"

function expectedVec3FromSwizzle(v: Vec3, swizzle: string): Vec3 {
    const mapping: Record<string, number> = { x: v.x, y: v.y, z: v.z }
    const components = swizzle.split("").map((c) => mapping[c]) as [number, number, number]
    return new Vec3(components)
}

function expectedVec4FromSwizzle(v: Vec4, swizzle: string): Vec4 {
    const mapping: Record<string, number> = { x: v.x, y: v.y, z: v.z, w: v.w }
    const components = swizzle.split("").map((c) => mapping[c]) as [number, number, number, number]
    return new Vec4(components)
}

// -----------------------------------------------------------------------------
// Vec2 tests
// -----------------------------------------------------------------------------

test("Vec2 swizzle getters", () => {
    const v = new Vec2(1, 2)
    const cases = [
        { prop: "xx", expected: new Vec2(1, 1) },
        { prop: "xy", expected: new Vec2(1, 2) },
        { prop: "yx", expected: new Vec2(2, 1) },
        { prop: "yy", expected: new Vec2(2, 2) },
    ]

    cases.forEach(({ prop, expected }) => {
        const actual = (v as any)[prop] as Vec2
        assert.deepStrictEqual(actual.elements, expected.elements, `Vec2.${prop} getter failed`)
    })
})

test("Vec2 swizzle setters", () => {
    const cases = [
        { prop: "xy", initial: new Vec2(1, 2), value: new Vec2(10, 20), expected: [10, 20] },
        { prop: "xx", initial: new Vec2(1, 2), value: new Vec2(10, 20), expected: [20, 2] },
        { prop: "yx", initial: new Vec2(1, 2), value: new Vec2(10, 20), expected: [20, 10] },
        { prop: "yy", initial: new Vec2(1, 2), value: new Vec2(10, 20), expected: [1, 20] },
    ]

    cases.forEach(({ prop, initial, value, expected }) => {
        ;(initial as any)[prop] = value
        assert.deepStrictEqual(Array.from(initial.elements), expected, `Vec2.${prop} setter failed`)
    })
})

test("Vec2 arithmetic", () => {
    const v1 = new Vec2(1, 2)
    const v2 = new Vec2(3, 4)
    assert.deepStrictEqual(v1.add(v2).elements, new Vec2(4, 6).elements, "Vec2 add failed")
    assert.deepStrictEqual(v2.subtract(v1).elements, new Vec2(2, 2).elements, "Vec2 subtract failed")
    assert.deepStrictEqual(v1.multiply(2).elements, new Vec2(2, 4).elements, "Vec2 scalar multiply failed")
    assert.deepStrictEqual(v1.multiply(v2).elements, new Vec2(3, 8).elements, "Vec2 component-wise multiply failed")
    assert.strictEqual(v1.dot(v2), 11, "Vec2 dot failed")

    // Normalizing a zero vector should return a zero vector.
    const zero = new Vec2(0, 0)
    assert.deepStrictEqual(zero.normalize().elements, zero.elements, "Vec2 normalization of zero failed")
})

// -----------------------------------------------------------------------------
// Vec3 tests
// -----------------------------------------------------------------------------

test("Vec3 swizzle getters", () => {
    const v = new Vec3(1, 2, 3)
    const keys: string[] = []
    for (const a of ["x", "y", "z"]) {
        for (const b of ["x", "y", "z"]) {
            for (const c of ["x", "y", "z"]) {
                keys.push(a + b + c)
            }
        }
    }
    keys.forEach((key) => {
        const expected = expectedVec3FromSwizzle(v, key)
        const actual = (v as any)[key] as Vec3
        assert.deepStrictEqual(
            actual.elements,
            expected.elements,
            `Vec3.${key} getter failed: expected [${expected.elements}], got [${actual.elements}]`
        )
    })
})

test("Vec3 swizzle setters", () => {
    const keys: string[] = []
    for (const a of ["x", "y", "z"]) {
        for (const b of ["x", "y", "z"]) {
            for (const c of ["x", "y", "z"]) {
                keys.push(a + b + c)
            }
        }
    }
    const newVal = new Vec3(10, 20, 30)
    const mapping: Record<string, number> = { x: 0, y: 1, z: 2 }
    keys.forEach((key) => {
        const v = new Vec3(1, 2, 3)
        ;(v as any)[key] = newVal
        // Simulate sequential assignment:
        const expected: number[] = [1, 2, 3]
        for (let i = 0; i < key.length; i++) {
            const idx = mapping[key[i]]
            expected[idx] = newVal.elements[i]
        }
        assert.deepStrictEqual(
            Array.from(v.elements),
            expected,
            `Vec3.${key} setter failed: expected [${expected}], got [${Array.from(v.elements)}]`
        )
    })
})

test("Vec3 arithmetic", () => {
    const v1 = new Vec3(1, 2, 3)
    const v2 = new Vec3(4, 5, 6)
    assert.deepStrictEqual(v1.add(v2).elements, new Vec3(5, 7, 9).elements, "Vec3 add failed")
    assert.deepStrictEqual(v2.subtract(v1).elements, new Vec3(3, 3, 3).elements, "Vec3 subtract failed")
    assert.deepStrictEqual(v1.multiply(3).elements, new Vec3(3, 6, 9).elements, "Vec3 scalar multiply failed")
    assert.deepStrictEqual(v1.multiply(v2).elements, new Vec3(4, 10, 18).elements, "Vec3 component-wise multiply failed")
    assert.strictEqual(v1.dot(v2), 32, "Vec3 dot failed")
    assert.deepStrictEqual(v1.cross(v2).elements, new Vec3(-3, 6, -3).elements, "Vec3 cross failed")

    // Zero vector normalization edge case.
    const zero = new Vec3(0, 0, 0)
    assert.deepStrictEqual(zero.normalize().elements, zero.elements, "Vec3 normalization of zero failed")
})

// -----------------------------------------------------------------------------
// Vec4 tests (with homogeneous swizzles)
// -----------------------------------------------------------------------------

test("Vec4 swizzle getters", () => {
    const v = new Vec4(1, 2, 3, 4)
    const keys: string[] = []
    for (const a of ["x", "y", "z"]) {
        for (const b of ["x", "y", "z"]) {
            for (const c of ["x", "y", "z"]) {
                keys.push(a + b + c + "w")
            }
        }
    }
    keys.forEach((key) => {
        const expected = expectedVec4FromSwizzle(v, key)
        const actual = (v as any)[key] as Vec4
        assert.deepStrictEqual(
            actual.elements,
            expected.elements,
            `Vec4.${key} getter failed: expected [${expected.elements}], got [${actual.elements}]`
        )
    })
})

test("Vec4 swizzle setters", () => {
    const keys: string[] = []
    for (const a of ["x", "y", "z"]) {
        for (const b of ["x", "y", "z"]) {
            for (const c of ["x", "y", "z"]) {
                keys.push(a + b + c + "w")
            }
        }
    }
    const newVal = new Vec4(10, 20, 30, 40)
    const mapping: Record<string, number> = { x: 0, y: 1, z: 2, w: 3 }
    keys.forEach((key) => {
        const v = new Vec4(1, 2, 3, 4)
        ;(v as any)[key] = newVal
        const expected: number[] = [1, 2, 3, 4]
        for (let i = 0; i < key.length; i++) {
            const idx = mapping[key[i]]
            expected[idx] = newVal.elements[i]
        }
        assert.deepStrictEqual(
            Array.from(v.elements),
            expected,
            `Vec4.${key} setter failed: expected [${expected}], got [${Array.from(v.elements)}]`
        )
    })
})

test("Vec4 arithmetic", () => {
    const v1 = new Vec4(1, 2, 3, 4)
    const v2 = new Vec4(5, 6, 7, 8)
    assert.deepStrictEqual(v1.add(v2).elements, new Vec4(6, 8, 10, 12).elements, "Vec4 add failed")
    assert.deepStrictEqual(v2.subtract(v1).elements, new Vec4(4, 4, 4, 4).elements, "Vec4 subtract failed")
    assert.deepStrictEqual(v1.multiply(2).elements, new Vec4(2, 4, 6, 8).elements, "Vec4 scalar multiply failed")
    assert.deepStrictEqual(v1.multiply(v2).elements, new Vec4(5, 12, 21, 32).elements, "Vec4 component-wise multiply failed")
    assert.strictEqual(v1.dot(v2), 70, "Vec4 dot failed")

    const zero = new Vec4(0, 0, 0, 0)
    assert.deepStrictEqual(zero.normalize().elements, zero.elements, "Vec4 normalization of zero failed")
})
