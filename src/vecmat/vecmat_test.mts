import test from "node:test"
import assert from "node:assert/strict"
import { Vec2, Vec3, Vec4, Mat2, Mat3, Mat4, vec3, vec2, vec4 } from "./vecmat.mjs"

function expectedVec3FromSwizzle(v: Vec3, swizzle: string): Vec3 {
    const mapping: Record<string, number> = { x: v.x, y: v.y, z: v.z }
    const components = swizzle.split("").map((c) => mapping[c]) as [number, number, number]
    return vec3(...components)
}

function expectedVec4FromSwizzle(v: Vec4, swizzle: string): Vec4 {
    const mapping: Record<string, number> = { x: v.x, y: v.y, z: v.z, q: v.w }
    const components = swizzle.split("").map((c) => mapping[c]) as [number, number, number, number]
    return vec4(...components)
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
        const actual = (v as any)[prop] as Vec2
        assert.deepStrictEqual(actual.elements, expected.elements, `Vec2.${prop} getter failed`)
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
        assert.deepStrictEqual(Array.from(initial.elements), expected, `Vec2.${prop} setter failed`)
    })
})

test("Vec2 arithmetic", () => {
    const v1 = vec2(1, 2)
    const v2 = vec2(3, 4)
    assert.deepStrictEqual(v1.add(v2).elements, vec2(4, 6).elements, "Vec2 add failed")
    assert.deepStrictEqual(v2.subtract(v1).elements, vec2(2, 2).elements, "Vec2 subtract failed")
    assert.deepStrictEqual(v1.multiply(2).elements, vec2(2, 4).elements, "Vec2 scalar multiply failed")
    assert.deepStrictEqual(v1.multiply(v2).elements, vec2(3, 8).elements, "Vec2 component-wise multiply failed")
    assert.strictEqual(v1.dot(v2), 11, "Vec2 dot failed")

    // Normalizing a zero vector should return a zero vector.
    const zero = vec2(0, 0)
    assert.deepStrictEqual(zero.normalize().elements, zero.elements, "Vec2 normalization of zero failed")
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
    const newVal = vec3(10, 20, 30)
    const mapping: Record<string, number> = { x: 0, y: 1, z: 2 }
    keys.forEach((key) => {
        const v = vec3(1, 2, 3)
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
    const v1 = vec3(1, 2, 3)
    const v2 = vec3(4, 5, 6)
    assert.deepStrictEqual(v1.add(v2).elements, vec3(5, 7, 9).elements, "Vec3 add failed")
    assert.deepStrictEqual(v2.subtract(v1).elements, vec3(3, 3, 3).elements, "Vec3 subtract failed")
    assert.deepStrictEqual(v1.multiply(3).elements, vec3(3, 6, 9).elements, "Vec3 scalar multiply failed")
    assert.deepStrictEqual(v1.multiply(v2).elements, vec3(4, 10, 18).elements, "Vec3 component-wise multiply failed")
    assert.strictEqual(v1.dot(v2), 32, "Vec3 dot failed")
    assert.deepStrictEqual(v1.cross(v2).elements, vec3(-3, 6, -3).elements, "Vec3 cross failed")

    // Zero vector normalization edge case.
    const zero = vec3(0, 0, 0)
    assert.deepStrictEqual(zero.normalize().elements, zero.elements, "Vec3 normalization of zero failed")
})

// -----------------------------------------------------------------------------
// Vec4 tests (with homogeneous swizzles)
// -----------------------------------------------------------------------------

test("Vec4 swizzle getters with Q", () => {
    const v = vec4(1, 2, 3, 4)
    const keys: string[] = []
    for (const a of ["x", "y", "z"]) {
        for (const b of ["x", "y", "z"]) {
            for (const c of ["x", "y", "z"]) {
                keys.push(a + b + c + "q")
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

test("Vec4 swizzle setters with Q", () => {
    const keys: string[] = []
    for (const a of ["x", "y", "z"]) {
        for (const b of ["x", "y", "z"]) {
            for (const c of ["x", "y", "z"]) {
                keys.push(a + b + c + "q")
            }
        }
    }
    const newVal = vec4(10, 20, 30, 40)
    const mapping: Record<string, number> = { x: 0, y: 1, z: 2, q: 3 }
    keys.forEach((key) => {
        const v = vec4(1, 2, 3, 4)
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
    const v1 = vec4(1, 2, 3, 4)
    const v2 = vec4(5, 6, 7, 8)
    assert.deepStrictEqual(v1.add(v2).elements, vec4(6, 8, 10, 12).elements, "Vec4 add failed")
    assert.deepStrictEqual(v2.subtract(v1).elements, vec4(4, 4, 4, 4).elements, "Vec4 subtract failed")
    assert.deepStrictEqual(v1.multiply(2).elements, vec4(2, 4, 6, 8).elements, "Vec4 scalar multiply failed")
    assert.deepStrictEqual(v1.multiply(v2).elements, vec4(5, 12, 21, 32).elements, "Vec4 component-wise multiply failed")
    assert.strictEqual(v1.dot(v2), 70, "Vec4 dot failed")

    const zero = vec4(0, 0, 0, 0)
    assert.deepStrictEqual(zero.normalize().elements, zero.elements, "Vec4 normalization of zero failed")
})

// -----------------------------------------------------------------------------
// Matrices tests
// -----------------------------------------------------------------------------

test("Mat2 operations", () => {
    // Mat2 is column‑major: elements order is [m00, m10, m01, m11]
    const m1 = new Mat2(new Float32Array([1, 2, 3, 4]))
    const m2 = new Mat2(new Float32Array([5, 6, 7, 8]))
    assert.deepStrictEqual(m1.add(m2).elements, new Float32Array([6, 8, 10, 12]), "Mat2 add failed")
    assert.deepStrictEqual(m2.subtract(m1).elements, new Float32Array([4, 4, 4, 4]), "Mat2 subtract failed")
    assert.deepStrictEqual(m1.multiply(2).elements, new Float32Array([2, 4, 6, 8]), "Mat2 scalar multiply failed")
    // Expected matrix multiplication: [1*5+3*6, 2*5+4*6, 1*7+3*8, 2*7+4*8] = [23,34,31,46]
    assert.deepStrictEqual(m1.multiply(m2).elements, new Float32Array([23, 34, 31, 46]), "Mat2 matrix multiply failed")
    assert.strictEqual(m1.determinant(), 1 * 4 - 2 * 3, "Mat2 determinant failed")

    const m1Inv = m1.inverse()
    const expectedInv = new Float32Array([4, -2, -3, 1]).map((v) => v / (1 * 4 - 2 * 3))
    assert.deepStrictEqual(m1Inv.elements, expectedInv, "Mat2 inverse failed")
    assert.deepStrictEqual(m1.transpose().elements, new Float32Array([1, 3, 2, 4]), "Mat2 transpose failed")

    const v = vec2(1, 1)
    assert.deepStrictEqual(m1.transform(v).elements, vec2(1 * 1 + 3 * 1, 2 * 1 + 4 * 1).elements, "Mat2 transform failed")
})

test("Mat3 operations", () => {
    const m = new Mat3(new Float32Array([1, 2, 3, 0, 1, 4, 5, 6, 0]))
    // In column‑major, m = [1,0,5; 2,1,6; 3,4,0]
    const det = 1 * (1 * 0 - 6 * 4) - 0 * (2 * 0 - 6 * 3) + 5 * (2 * 4 - 1 * 3)
    assert.strictEqual(m.determinant(), det, "Mat3 determinant failed")

    const expectedTranspose = new Float32Array([1, 0, 5, 2, 1, 6, 3, 4, 0])
    assert.deepStrictEqual(Array.from(m.transpose().elements), Array.from(expectedTranspose), "Mat3 transpose failed")

    const v = vec3(1, 2, 3)
    // m * v = [1*1+0*2+5*3, 2*1+1*2+6*3, 3*1+4*2+0*3] = [16,22,11]
    assert.deepStrictEqual(m.transform(v).elements, vec3(16, 22, 11).elements, "Mat3 transform failed")

    // Singular matrix: should throw on inverse.
    const singular = new Mat3(new Float32Array([1, 2, 3, 2, 4, 6, 3, 6, 9]))
    assert.throws(() => singular.inverse(), "Mat3 inverse did not throw on singular matrix")
})

test("Mat4 operations", () => {
    // Identity: transforming a vector should yield the same vector.
    const id = Mat4.identity()
    const v4 = vec4(1, 2, 3, 1)
    assert.deepStrictEqual(id.transform(v4).elements, v4.elements, "Mat4 identity transform failed")

    // Translation.
    const translation = Mat4.translation(1, 2, 3)
    const point = vec4(4, 5, 6, 1)
    assert.deepStrictEqual(translation.transform(point).elements, vec4(5, 7, 9, 1).elements, "Mat4 translation transform failed")
    assert.deepStrictEqual(translation.transformPoint(vec3(4, 5, 6)).elements, vec3(5, 7, 9).elements, "Mat4 transformPoint failed")

    // Rotation around X axis.
    const angle = Math.PI / 2
    const rotX = Mat4.rotationX(angle)
    const vRot = vec4(0, 1, 0, 1)
    const resultX = rotX.transform(vRot)
    assert.ok(Math.abs(resultX.y) < 1e-6 && Math.abs(resultX.z - 1) < 1e-6, "Mat4 rotationX failed")

    // Scaling.
    const scaling = Mat4.scaling(2, 3, 4)
    const vScale = vec4(1, 1, 1, 1)
    assert.deepStrictEqual(scaling.transform(vScale).elements, vec4(2, 3, 4, 1).elements, "Mat4 scaling failed")

    // Perspective.
    const perspective = Mat4.perspective(Math.PI / 2, 1.0, 0.1, 100)
    const pTransformed = perspective.transform(vec4(1, 2, -5, 1))
    assert.ok(Number.isFinite(pTransformed.x) && Number.isFinite(pTransformed.y), "Mat4 perspective transform produced non-finite values")

    // Inversion of a singular matrix should throw.
    const singularMat4 = new Mat4(new Float32Array([1, 2, 3, 4, 2, 4, 6, 8, 3, 6, 9, 12, 4, 8, 12, 16]))
    assert.throws(() => singularMat4.inverse(), "Mat4 inverse did not throw on singular matrix")
})
