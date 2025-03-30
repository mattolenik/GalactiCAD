import assert from "node:assert/strict"
import test from "node:test"
import { Mat2x2f, Mat3x3f, Mat4x4f } from "./matrix.mjs"
import { vec2, vec3, vec4 } from "./vector.mjs"

test("Mat2 operations", () => {
    // Mat2 is column‑major: elements order is [m00, m10, m01, m11]
    const m1 = new Mat2x2f(new Float32Array([1, 2, 3, 4]))
    const m2 = new Mat2x2f(new Float32Array([5, 6, 7, 8]))
    assert.deepStrictEqual(m1.add(m2).data, new Float32Array([6, 8, 10, 12]), "Mat2 add failed")
    assert.deepStrictEqual(m2.subtract(m1).data, new Float32Array([4, 4, 4, 4]), "Mat2 subtract failed")
    assert.deepStrictEqual(m1.multiply(2).data, new Float32Array([2, 4, 6, 8]), "Mat2 scalar multiply failed")
    // Expected matrix multiplication: [1*5+3*6, 2*5+4*6, 1*7+3*8, 2*7+4*8] = [23,34,31,46]
    assert.deepStrictEqual(m1.multiply(m2).data, new Float32Array([23, 34, 31, 46]), "Mat2 matrix multiply failed")
    assert.strictEqual(m1.determinant(), 1 * 4 - 2 * 3, "Mat2 determinant failed")

    const m1Inv = m1.inverse()
    const expectedInv = new Float32Array([4, -2, -3, 1]).map(v => v / (1 * 4 - 2 * 3))
    assert.deepStrictEqual(m1Inv.data, expectedInv, "Mat2 inverse failed")
    assert.deepStrictEqual(m1.transpose().data, new Float32Array([1, 3, 2, 4]), "Mat2 transpose failed")

    const v = vec2(1, 1)
    assert.deepStrictEqual(m1.transform(v).data, vec2(1 * 1 + 3 * 1, 2 * 1 + 4 * 1).data, "Mat2 transform failed")
})

test("Mat3 operations", () => {
    const m = new Mat3x3f(new Float32Array([1, 2, 3, 0, 1, 4, 5, 6, 0]))
    // In column‑major, m = [1,0,5; 2,1,6; 3,4,0]
    const det = 1 * (1 * 0 - 6 * 4) - 0 * (2 * 0 - 6 * 3) + 5 * (2 * 4 - 1 * 3)
    assert.strictEqual(m.determinant(), det, "Mat3 determinant failed")

    const expectedTranspose = new Float32Array([1, 0, 5, 2, 1, 6, 3, 4, 0])
    assert.deepStrictEqual(Array.from(m.transpose().data), Array.from(expectedTranspose), "Mat3 transpose failed")

    const v = vec3(1, 2, 3)
    // m * v = [1*1+0*2+5*3, 2*1+1*2+6*3, 3*1+4*2+0*3] = [16,22,11]
    assert.deepStrictEqual(m.transform(v).data, vec3(16, 22, 11).data, "Mat3 transform failed")

    // Singular matrix: should throw on inverse.
    const singular = new Mat3x3f(new Float32Array([1, 2, 3, 2, 4, 6, 3, 6, 9]))
    assert.throws(() => singular.inverse(), "Mat3 inverse did not throw on singular matrix")
})

test("Mat4 operations", () => {
    // Identity: transforming a vector should yield the same vector.
    const id = Mat4x4f.identity()
    const v4 = vec4(1, 2, 3, 1)
    assert.deepStrictEqual(id.transform(v4).data, v4.data, "Mat4 identity transform failed")

    // Translation.
    const translation = Mat4x4f.translation(vec3(1, 2, 3))
    const point = vec4(4, 5, 6, 1)
    assert.deepStrictEqual(translation.transform(point).data, vec4(5, 7, 9, 1).data, "Mat4 translation transform failed")
    assert.deepStrictEqual(translation.transformPoint(vec3(4, 5, 6)).data, vec3(5, 7, 9).data, "Mat4 transformPoint failed")

    // Rotation around X axis.
    const angle = Math.PI / 2
    const rotX = Mat4x4f.rotationX(angle)
    const vRot = vec4(0, 1, 0, 1)
    const resultX = rotX.transform(vRot)
    assert.ok(Math.abs(resultX.y) < 1e-6 && Math.abs(resultX.z - 1) < 1e-6, "Mat4 rotationX failed")

    // Scaling.
    const scaling = Mat4x4f.scaling(vec3(2, 3, 4))
    const vScale = vec4(1, 1, 1, 1)
    assert.deepStrictEqual(scaling.transform(vScale).data, vec4(2, 3, 4, 1).data, "Mat4 scaling failed")

    // Perspective.
    const perspective = Mat4x4f.perspective(Math.PI / 2, 1.0, 0.1, 100)
    const pTransformed = perspective.transform(vec4(1, 2, -5, 1))
    assert.ok(Number.isFinite(pTransformed.x) && Number.isFinite(pTransformed.y), "Mat4 perspective transform produced non-finite values")

    // Inversion of a singular matrix should throw.
    const singularMat4 = new Mat4x4f(new Float32Array([1, 2, 3, 4, 2, 4, 6, 8, 3, 6, 9, 12, 4, 8, 12, 16]))
    assert.throws(() => singularMat4.inverse(), "Mat4 inverse did not throw on singular matrix")
})
