import { MemoryShareable } from "../reflect/reflect.mjs"
import { Vec2f, Vec3f, Vec4f } from "./vector.mjs"

export type Mat2x2 = Mat2x2f | Float32Array | [number, number, number, number]
export type Mat3x3 = Mat3x3f | Float32Array | [number, number, number, number, number, number, number, number, number]
export type Mat4x4 =
    | Mat4x4f
    | Float32Array
    | [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number]

export class Mat2x2f implements MemoryShareable {
    data: Float32Array
    byteLength = 16
    length = 4
    constructor(elements: Mat2x2 = [1, 0, 0, 1]) {
        if (elements.length != this.length) {
            throw new Error(`size mismatch, expected incoming elements to have length of ${this.length}, got ${elements.length}`)
        }
        this.data = new Float32Array(this.length)
        this.data.set(elements instanceof Mat2x2f ? elements.data : elements)
    }
    clone(): Mat2x2f {
        return new Mat2x2f(this)
    }
    copy(m: Mat2x2f): this {
        this.data.set(m.data)
        return this
    }
    equals(m: Mat2x2f): boolean {
        for (let i = 0; i < 4; i++) {
            if (this.data[i] !== m.data[i]) return false
        }
        return true
    }
    add(m: Mat2x2f): Mat2x2f {
        const e = this.data,
            f = m.data
        return new Mat2x2f(new Float32Array([e[0] + f[0], e[1] + f[1], e[2] + f[2], e[3] + f[3]]))
    }
    subtract(m: Mat2x2f): Mat2x2f {
        const e = this.data,
            f = m.data
        return new Mat2x2f(new Float32Array([e[0] - f[0], e[1] - f[1], e[2] - f[2], e[3] - f[3]]))
    }
    multiply<T extends number | Mat2x2f>(arg: T): Mat2x2f {
        if (typeof arg === "number") {
            const e = this.data
            return new Mat2x2f(new Float32Array([e[0] * arg, e[1] * arg, e[2] * arg, e[3] * arg]))
        } else {
            const a = this.data,
                b = arg.data
            return new Mat2x2f(
                new Float32Array([
                    a[0] * b[0] + a[2] * b[1],
                    a[1] * b[0] + a[3] * b[1],
                    a[0] * b[2] + a[2] * b[3],
                    a[1] * b[2] + a[3] * b[3],
                ])
            )
        }
    }
    determinant(): number {
        const [a, b, c, d] = this.data
        return a * d - b * c
    }
    inverse(): Mat2x2f {
        const det = this.determinant()
        if (det === 0) throw new Error("Matrix is not invertible")
        const [a, b, c, d] = this.data
        return new Mat2x2f(new Float32Array([d / det, -b / det, -c / det, a / det]))
    }
    transpose(): Mat2x2f {
        const [a, b, c, d] = this.data
        return new Mat2x2f(new Float32Array([a, c, b, d]))
    }
    transform(v: Vec2f): Vec2f {
        const [a, b, c, d] = this.data
        return new Vec2f([a * v.x + c * v.y, b * v.x + d * v.y])
    }
}

export class Mat3x3f implements MemoryShareable {
    data: Float32Array
    byteLength = 36
    length = 9
    constructor(elements: Mat3x3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]) {
        if (elements.length != this.length) {
            throw new Error(`size mismatch, expected incoming elements to have length of ${this.length}, got ${elements.length}`)
        }
        this.data = new Float32Array(this.length)
        this.data.set(elements instanceof Mat3x3f ? elements.data : elements)
    }
    clone(): Mat3x3f {
        return new Mat3x3f(this.data)
    }
    copy(m: Mat3x3f): this {
        this.data.set(m.data)
        return this
    }
    equals(m: Mat3x3f): boolean {
        for (let i = 0; i < 9; i++) {
            if (this.data[i] !== m.data[i]) return false
        }
        return true
    }
    add(m: Mat3x3f): Mat3x3f {
        const result = new Float32Array(9)
        for (let i = 0; i < 9; i++) result[i] = this.data[i] + m.data[i]
        return new Mat3x3f(result)
    }
    subtract(m: Mat3x3f): Mat3x3f {
        const result = new Float32Array(9)
        for (let i = 0; i < 9; i++) result[i] = this.data[i] - m.data[i]
        return new Mat3x3f(result)
    }
    multiply<T extends number | Mat3x3f>(arg: T): Mat3x3f {
        if (typeof arg === "number") {
            const result = new Float32Array(9)
            for (let i = 0; i < 9; i++) result[i] = this.data[i] * arg
            return new Mat3x3f(result)
        } else {
            const a = this.data,
                b = arg.data
            const result = new Float32Array(9)
            for (let col = 0; col < 3; col++) {
                for (let row = 0; row < 3; row++) {
                    let sum = 0
                    for (let k = 0; k < 3; k++) {
                        sum += a[row + k * 3] * b[k + col * 3]
                    }
                    result[row + col * 3] = sum
                }
            }
            return new Mat3x3f(result)
        }
    }
    determinant(): number {
        const m = this.data
        return m[0] * (m[4] * m[8] - m[7] * m[5]) - m[3] * (m[1] * m[8] - m[7] * m[2]) + m[6] * (m[1] * m[5] - m[4] * m[2])
    }
    inverse(): Mat3x3f {
        const m = this.data
        const det = this.determinant()
        if (det === 0) throw new Error("Matrix not invertible")
        const inv = new Float32Array(9)
        inv[0] = (m[4] * m[8] - m[5] * m[7]) / det
        inv[1] = (m[2] * m[7] - m[1] * m[8]) / det
        inv[2] = (m[1] * m[5] - m[2] * m[4]) / det
        inv[3] = (m[5] * m[6] - m[3] * m[8]) / det
        inv[4] = (m[0] * m[8] - m[2] * m[6]) / det
        inv[5] = (m[2] * m[3] - m[0] * m[5]) / det
        inv[6] = (m[3] * m[7] - m[4] * m[6]) / det
        inv[7] = (m[1] * m[6] - m[0] * m[7]) / det
        inv[8] = (m[0] * m[4] - m[1] * m[3]) / det
        return new Mat3x3f(inv)
    }
    transpose(): Mat3x3f {
        const m = this.data
        return new Mat3x3f(new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]))
    }
    transform(v: Vec3f): Vec3f {
        const m = this.data
        return new Vec3f([m[0] * v.x + m[3] * v.y + m[6] * v.z, m[1] * v.x + m[4] * v.y + m[7] * v.z, m[2] * v.x + m[5] * v.y + m[8] * v.z])
    }
}

export class Mat4x4f implements MemoryShareable {
    data: Float32Array
    byteLength = 64
    length = 16
    constructor(elements: Mat4x4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) {
        if (elements.length != this.length) {
            throw new Error(`size mismatch, expected incoming elements to have length of ${this.length}, got ${elements.length}`)
        }
        this.data = new Float32Array(this.length)
        this.data.set(elements instanceof Mat4x4f ? elements.data : elements)
    }
    static identity(): Mat4x4f {
        return new Mat4x4f()
    }
    static translation(v: Vec3f): Mat4x4f {
        return new Mat4x4f(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, v.x, v.y, v.z, 1]))
    }
    static rotationX(angle: number): Mat4x4f {
        const c = Math.cos(angle),
            s = Math.sin(angle)
        return new Mat4x4f(new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]))
    }
    static rotationY(angle: number): Mat4x4f {
        const c = Math.cos(angle),
            s = Math.sin(angle)
        return new Mat4x4f(new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]))
    }
    static rotationZ(angle: number): Mat4x4f {
        const c = Math.cos(angle),
            s = Math.sin(angle)
        return new Mat4x4f(new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]))
    }
    static scaling(v: Vec3f): Mat4x4f {
        return new Mat4x4f(new Float32Array([v.x, 0, 0, 0, 0, v.y, 0, 0, 0, 0, v.z, 0, 0, 0, 0, 1]))
    }
    static perspective(fov: number, aspect: number, near: number, far: number): Mat4x4f {
        const f = 1 / Math.tan(fov / 2)
        const nf = 1 / (near - far)
        return new Mat4x4f(new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]))
    }
    static orthographic(left: number, right: number, bottom: number, top: number, near: number, far: number): Mat4x4f {
        const lr = 1 / (left - right)
        const bt = 1 / (bottom - top)
        const nf = 1 / (near - far)
        return new Mat4x4f([
            -2 * lr,
            0,
            0,
            0,
            0,
            -2 * bt,
            0,
            0,
            0,
            0,
            2 * nf,
            0,
            (left + right) * lr,
            (top + bottom) * bt,
            (far + near) * nf,
            1,
        ])
    }
    clone(): Mat4x4f {
        return new Mat4x4f(this)
    }
    copy(m: Mat4x4f): this {
        this.data.set(m.data)
        return this
    }
    equals(m: Mat4x4f): boolean {
        for (let i = 0; i < 16; i++) {
            if (this.data[i] !== m.data[i]) return false
        }
        return true
    }
    add(m: Mat4x4f): Mat4x4f {
        const result = new Float32Array(16)
        for (let i = 0; i < 16; i++) result[i] = this.data[i] + m.data[i]
        return new Mat4x4f(result)
    }
    subtract(m: Mat4x4f): Mat4x4f {
        const result = new Float32Array(16)
        for (let i = 0; i < 16; i++) result[i] = this.data[i] - m.data[i]
        return new Mat4x4f(result)
    }
    multiply<T extends number | Mat4x4f>(arg: T): Mat4x4f {
        if (typeof arg === "number") {
            const result = new Float32Array(16)
            for (let i = 0; i < 16; i++) result[i] = this.data[i] * arg
            return new Mat4x4f(result)
        } else {
            const a = this.data,
                b = arg.data
            const result = new Float32Array(16)
            for (let i = 0; i < 4; i++) {
                // row
                for (let j = 0; j < 4; j++) {
                    // col
                    let sum = 0
                    for (let k = 0; k < 4; k++) {
                        sum += a[i + k * 4] * b[k + j * 4]
                    }
                    result[i + j * 4] = sum
                }
            }
            return new Mat4x4f(result)
        }
    }
    determinant(): number {
        const m = this.data
        const m0 = m[0],
            m1 = m[1],
            m2 = m[2],
            m3 = m[3],
            m4 = m[4],
            m5 = m[5],
            m6 = m[6],
            m7 = m[7],
            m8 = m[8],
            m9 = m[9],
            m10 = m[10],
            m11 = m[11],
            m12 = m[12],
            m13 = m[13],
            m14 = m[14],
            m15 = m[15]
        return (
            m12 * m9 * m6 * m3 -
            m8 * m13 * m6 * m3 -
            m12 * m5 * m10 * m3 +
            m4 * m13 * m10 * m3 +
            m8 * m5 * m14 * m3 -
            m4 * m9 * m14 * m3 -
            m12 * m9 * m2 * m7 +
            m8 * m13 * m2 * m7 +
            m12 * m1 * m10 * m7 -
            m0 * m13 * m10 * m7 -
            m8 * m1 * m14 * m7 +
            m0 * m9 * m14 * m7 +
            m12 * m5 * m2 * m11 -
            m4 * m13 * m2 * m11 -
            m12 * m1 * m6 * m11 +
            m0 * m13 * m6 * m11 +
            m4 * m1 * m14 * m11 -
            m0 * m5 * m14 * m11 -
            m8 * m5 * m2 * m15 +
            m4 * m9 * m2 * m15 +
            m8 * m1 * m6 * m15 -
            m0 * m9 * m6 * m15 -
            m4 * m1 * m10 * m15 +
            m0 * m5 * m10 * m15
        )
    }
    inverse(): Mat4x4f {
        const m = this.data
        const inv = new Float32Array(16)
        inv[0] =
            m[5] * m[10] * m[15] -
            m[5] * m[11] * m[14] -
            m[9] * m[6] * m[15] +
            m[9] * m[7] * m[14] +
            m[13] * m[6] * m[11] -
            m[13] * m[7] * m[10]

        inv[4] =
            -m[4] * m[10] * m[15] +
            m[4] * m[11] * m[14] +
            m[8] * m[6] * m[15] -
            m[8] * m[7] * m[14] -
            m[12] * m[6] * m[11] +
            m[12] * m[7] * m[10]

        inv[8] =
            m[4] * m[9] * m[15] -
            m[4] * m[11] * m[13] -
            m[8] * m[5] * m[15] +
            m[8] * m[7] * m[13] +
            m[12] * m[5] * m[11] -
            m[12] * m[7] * m[9]

        inv[12] =
            -m[4] * m[9] * m[14] +
            m[4] * m[10] * m[13] +
            m[8] * m[5] * m[14] -
            m[8] * m[6] * m[13] -
            m[12] * m[5] * m[10] +
            m[12] * m[6] * m[9]

        inv[1] =
            -m[1] * m[10] * m[15] +
            m[1] * m[11] * m[14] +
            m[9] * m[2] * m[15] -
            m[9] * m[3] * m[14] -
            m[13] * m[2] * m[11] +
            m[13] * m[3] * m[10]

        inv[5] =
            m[0] * m[10] * m[15] -
            m[0] * m[11] * m[14] -
            m[8] * m[2] * m[15] +
            m[8] * m[3] * m[14] +
            m[12] * m[2] * m[11] -
            m[12] * m[3] * m[10]

        inv[9] =
            -m[0] * m[9] * m[15] +
            m[0] * m[11] * m[13] +
            m[8] * m[1] * m[15] -
            m[8] * m[3] * m[13] -
            m[12] * m[1] * m[11] +
            m[12] * m[3] * m[9]

        inv[13] =
            m[0] * m[9] * m[14] -
            m[0] * m[10] * m[13] -
            m[8] * m[1] * m[14] +
            m[8] * m[2] * m[13] +
            m[12] * m[1] * m[10] -
            m[12] * m[2] * m[9]

        inv[2] =
            m[1] * m[6] * m[15] -
            m[1] * m[7] * m[14] -
            m[5] * m[2] * m[15] +
            m[5] * m[3] * m[14] +
            m[13] * m[2] * m[7] -
            m[13] * m[3] * m[6]

        inv[6] =
            -m[0] * m[6] * m[15] +
            m[0] * m[7] * m[14] +
            m[4] * m[2] * m[15] -
            m[4] * m[3] * m[14] -
            m[12] * m[2] * m[7] +
            m[12] * m[3] * m[6]

        inv[10] =
            m[0] * m[5] * m[15] -
            m[0] * m[7] * m[13] -
            m[4] * m[1] * m[15] +
            m[4] * m[3] * m[13] +
            m[12] * m[1] * m[7] -
            m[12] * m[3] * m[5]

        inv[14] =
            -m[0] * m[5] * m[14] +
            m[0] * m[6] * m[13] +
            m[4] * m[1] * m[14] -
            m[4] * m[2] * m[13] -
            m[12] * m[1] * m[6] +
            m[12] * m[2] * m[5]

        inv[3] =
            -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6]

        inv[7] =
            m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6]

        inv[11] =
            -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5]

        inv[15] =
            m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5]

        let det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12]
        if (det === 0) throw new Error("Matrix not invertible")
        det = 1.0 / det
        for (let i = 0; i < 16; i++) inv[i] = inv[i] * det

        return new Mat4x4f(inv)
    }
    transpose(): Mat4x4f {
        const m = this.data
        return new Mat4x4f(
            new Float32Array([m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14], m[3], m[7], m[11], m[15]])
        )
    }
    // Transform a 4D vector.
    transform(v: Vec4f): Vec4f {
        const m = this.data
        return new Vec4f([
            m[0] * v.x + m[4] * v.y + m[8] * v.z + m[12] * v.w,
            m[1] * v.x + m[5] * v.y + m[9] * v.z + m[13] * v.w,
            m[2] * v.x + m[6] * v.y + m[10] * v.z + m[14] * v.w,
            m[3] * v.x + m[7] * v.y + m[11] * v.z + m[15] * v.w,
        ])
    }
    // Transform a 3D point (assumes w = 1 and then does perspective divide).
    transformPoint(v: Vec3f): Vec3f {
        const result = this.transform(new Vec4f([v.x, v.y, v.z, 1]))
        return new Vec3f([result.x / result.w, result.y / result.w, result.z / result.w])
    }
    // Transform a 3D vector (assumes w = 0).
    transformVector(v: Vec3f): Vec3f {
        const result = this.transform(new Vec4f([v.x, v.y, v.z, 0]))
        return new Vec3f([result.x, result.y, result.z])
    }
}

export function lookAt(eye: Vec3f, center: Vec3f, up: Vec3f): Mat4x4f {
    const f = center.subtract(eye).normalize() // forward
    const s = f.cross(up).normalize() // side/right
    const u = s.cross(f) // recalculated up

    const m = new Float32Array(16)
    // Column 0
    m[0] = s.x
    m[1] = u.x
    m[2] = -f.x
    m[3] = 0
    // Column 1
    m[4] = s.y
    m[5] = u.y
    m[6] = -f.y
    m[7] = 0
    // Column 2
    m[8] = s.z
    m[9] = u.z
    m[10] = -f.z
    m[11] = 0
    // Column 3
    m[12] = -s.dot(eye)
    m[13] = -u.dot(eye)
    m[14] = f.dot(eye)
    m[15] = 1

    return new Mat4x4f(m)
}
