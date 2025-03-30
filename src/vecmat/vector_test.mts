import assert from "node:assert/strict"
import test from "node:test"
import { vec2, Vec2f, vec3, Vec3f, vec4, Vec4f } from "./vector.mjs"

function expectedVec3FromSwizzle(v: Vec3f, swizzle: string): Vec3f {
    const mapping: Record<string, number> = { x: v.x, y: v.y, z: v.z }
    const components = swizzle.split("").map(c => mapping[c]) as [number, number, number]
    return new Vec3f(components)
}

function expectedVec4FromSwizzle(v: Vec4f, swizzle: string): Vec4f {
    const mapping: Record<string, number> = { x: v.x, y: v.y, z: v.z, w: v.w }
    const components = swizzle.split("").map(c => mapping[c]) as [number, number, number, number]
    return new Vec4f(components)
}

// -----------------------------------------------------------------------------
// Vec2 tests
// -----------------------------------------------------------------------------

test("Vec2 swizzle getters", () => {
    const v = vec2(1, 2)
    const cases = [
        { prop: "xx", expected: vec2(1, 1) },
        { prop: "xy", expected: vec2(1, 2) },
        { prop: "yx", expected: vec2(2, 1) },
        { prop: "yy", expected: vec2(2, 2) },
    ]

    cases.forEach(({ prop, expected }) => {
        const actual = (v as any)[prop] as Vec2f
        assert.deepStrictEqual(actual.data, expected.data, `Vec2.${prop} getter failed`)
    })
})

test("Vec2 swizzle setters", () => {
    const cases = [
        { prop: "xy", initial: vec2(1, 2), value: vec2(10, 20), expected: [10, 20] },
        { prop: "xx", initial: vec2(1, 2), value: vec2(10, 20), expected: [20, 2] },
        { prop: "yx", initial: vec2(1, 2), value: vec2(10, 20), expected: [20, 10] },
        { prop: "yy", initial: vec2(1, 2), value: vec2(10, 20), expected: [1, 20] },
    ]

    cases.forEach(({ prop, initial, value, expected }) => {
        ;(initial as any)[prop] = value
        assert.deepStrictEqual(Array.from(initial.data), expected, `Vec2.${prop} setter failed`)
    })
})

test("Vec2 arithmetic", () => {
    const v1 = vec2(1, 2)
    const v2 = vec2(3, 4)
    assert.deepStrictEqual(v1.add(v2).data, vec2(4, 6).data, "Vec2 add failed")
    assert.deepStrictEqual(v2.subtract(v1).data, vec2(2, 2).data, "Vec2 subtract failed")
    assert.deepStrictEqual(v1.multiply(2).data, vec2(2, 4).data, "Vec2 scalar multiply failed")
    assert.deepStrictEqual(v1.multiply(v2).data, vec2(3, 8).data, "Vec2 component-wise multiply failed")
    assert.strictEqual(v1.dot(v2), 11, "Vec2 dot failed")

    // Normalizing a zero vector should return a zero vector.
    const zero = vec2(0, 0)
    assert.deepStrictEqual(zero.normalize().data, zero.data, "Vec2 normalization of zero failed")
})

// -----------------------------------------------------------------------------
// Vec3 tests
// -----------------------------------------------------------------------------

test("Vec3 swizzle getters", () => {
    const v = vec3(1, 2, 3)
    const keys: string[] = []
    for (const a of ["x", "y", "z"]) {
        for (const b of ["x", "y", "z"]) {
            for (const c of ["x", "y", "z"]) {
                keys.push(a + b + c)
            }
        }
    }
    keys.forEach(key => {
        const expected = expectedVec3FromSwizzle(v, key)
        const actual = (v as any)[key] as Vec3f
        assert.deepStrictEqual(actual.data, expected.data, `Vec3.${key} getter failed: expected [${expected.data}], got [${actual.data}]`)
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
    const newVal = vec3(10, 20, 30)
    const mapping: Record<string, number> = { x: 0, y: 1, z: 2 }
    keys.forEach(key => {
        const v = vec3(1, 2, 3)
        ;(v as any)[key] = newVal
        // Simulate sequential assignment:
        const expected: number[] = [1, 2, 3]
        for (let i = 0; i < key.length; i++) {
            const idx = mapping[key[i]]
            expected[idx] = newVal.data[i]
        }
        assert.deepStrictEqual(
            Array.from(v.data),
            expected,
            `Vec3.${key} setter failed: expected [${expected}], got [${Array.from(v.data)}]`
        )
    })
})

test("Vec3 arithmetic", () => {
    const v1 = vec3(1, 2, 3)
    const v2 = vec3(4, 5, 6)
    assert.deepStrictEqual(v1.add(v2).data, vec3(5, 7, 9).data, "Vec3 add failed")
    assert.deepStrictEqual(v2.subtract(v1).data, vec3(3, 3, 3).data, "Vec3 subtract failed")
    assert.deepStrictEqual(v1.multiply(3).data, vec3(3, 6, 9).data, "Vec3 scalar multiply failed")
    assert.deepStrictEqual(v1.multiply(v2).data, vec3(4, 10, 18).data, "Vec3 component-wise multiply failed")
    assert.strictEqual(v1.dot(v2), 32, "Vec3 dot failed")
    assert.deepStrictEqual(v1.cross(v2).data, vec3(-3, 6, -3).data, "Vec3 cross failed")

    // Zero vector normalization edge case.
    const zero = vec3(0, 0, 0)
    assert.deepStrictEqual(zero.normalize().data, zero.data, "Vec3 normalization of zero failed")
})

// -----------------------------------------------------------------------------
// Vec4 tests (with homogeneous swizzles)
// -----------------------------------------------------------------------------

test("Vec4 swizzle getters", () => {
    const v = vec4(1, 2, 3, 4)
    const keys: string[] = []
    for (const a of ["x", "y", "z"]) {
        for (const b of ["x", "y", "z"]) {
            for (const c of ["x", "y", "z"]) {
                keys.push(a + b + c + "w")
            }
        }
    }
    keys.forEach(key => {
        const expected = expectedVec4FromSwizzle(v, key)
        const actual = (v as any)[key] as Vec4f
        assert.deepStrictEqual(actual.data, expected.data, `Vec4.${key} getter failed: expected [${expected.data}], got [${actual.data}]`)
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
    const newVal = vec4(10, 20, 30, 40)
    const mapping: Record<string, number> = { x: 0, y: 1, z: 2, w: 3 }
    keys.forEach(key => {
        const v = vec4(1, 2, 3, 4)
        ;(v as any)[key] = newVal
        const expected: number[] = [1, 2, 3, 4]
        for (let i = 0; i < key.length; i++) {
            const idx = mapping[key[i]]
            expected[idx] = newVal.data[i]
        }
        assert.deepStrictEqual(
            Array.from(v.data),
            expected,
            `Vec4.${key} setter failed: expected [${expected}], got [${Array.from(v.data)}]`
        )
    })
})

test("Vec4 arithmetic", () => {
    const v1 = vec4(1, 2, 3, 4)
    const v2 = vec4(5, 6, 7, 8)
    assert.deepStrictEqual(v1.add(v2).data, vec4(6, 8, 10, 12).data, "Vec4 add failed")
    assert.deepStrictEqual(v2.subtract(v1).data, vec4(4, 4, 4, 4).data, "Vec4 subtract failed")
    assert.deepStrictEqual(v1.multiply(2).data, vec4(2, 4, 6, 8).data, "Vec4 scalar multiply failed")
    assert.deepStrictEqual(v1.multiply(v2).data, vec4(5, 12, 21, 32).data, "Vec4 component-wise multiply failed")
    assert.strictEqual(v1.dot(v2), 70, "Vec4 dot failed")

    const zero = vec4(0, 0, 0, 0)
    assert.deepStrictEqual(zero.normalize().data, zero.data, "Vec4 normalization of zero failed")
})
