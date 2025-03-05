import { Vec2, Vec3, Vec4 } from "./vector.mjs"

export class Mat2 {
    public elements: Float32Array
    constructor(elements?: Float32Array) {
        this.elements = elements ? new Float32Array(elements) : new Float32Array([1, 0, 0, 1])
    }
    clone(): Mat2 {
        return new Mat2(this.elements)
    }
    copy(m: Mat2): this {
        this.elements.set(m.elements)
        return this
    }
    equals(m: Mat2): boolean {
        for (let i = 0; i < 4; i++) {
            if (this.elements[i] !== m.elements[i]) return false
        }
        return true
    }
    add(m: Mat2): Mat2 {
        const e = this.elements,
            f = m.elements
        return new Mat2(new Float32Array([e[0] + f[0], e[1] + f[1], e[2] + f[2], e[3] + f[3]]))
    }
    subtract(m: Mat2): Mat2 {
        const e = this.elements,
            f = m.elements
        return new Mat2(new Float32Array([e[0] - f[0], e[1] - f[1], e[2] - f[2], e[3] - f[3]]))
    }
    multiply<T extends number | Mat2>(arg: T): Mat2 {
        if (typeof arg === "number") {
            const e = this.elements
            return new Mat2(new Float32Array([e[0] * arg, e[1] * arg, e[2] * arg, e[3] * arg]))
        } else {
            const a = this.elements,
                b = arg.elements
            return new Mat2(
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
        const [a, b, c, d] = this.elements
        return a * d - b * c
    }
    inverse(): Mat2 {
        const det = this.determinant()
        if (det === 0) throw new Error("Matrix is not invertible")
        const [a, b, c, d] = this.elements
        return new Mat2(new Float32Array([d / det, -b / det, -c / det, a / det]))
    }
    transpose(): Mat2 {
        const [a, b, c, d] = this.elements
        return new Mat2(new Float32Array([a, c, b, d]))
    }
    transform(v: Vec2): Vec2 {
        const [a, b, c, d] = this.elements
        return new Vec2([a * v.x + c * v.y, b * v.x + d * v.y])
    }
}

export class Mat3 {
    public elements: Float32Array
    constructor(elements?: Float32Array) {
        this.elements = elements ? new Float32Array(elements) : new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1])
    }
    clone(): Mat3 {
        return new Mat3(this.elements)
    }
    copy(m: Mat3): this {
        this.elements.set(m.elements)
        return this
    }
    equals(m: Mat3): boolean {
        for (let i = 0; i < 9; i++) {
            if (this.elements[i] !== m.elements[i]) return false
        }
        return true
    }
    add(m: Mat3): Mat3 {
        const result = new Float32Array(9)
        for (let i = 0; i < 9; i++) result[i] = this.elements[i] + m.elements[i]
        return new Mat3(result)
    }
    subtract(m: Mat3): Mat3 {
        const result = new Float32Array(9)
        for (let i = 0; i < 9; i++) result[i] = this.elements[i] - m.elements[i]
        return new Mat3(result)
    }
    multiply<T extends number | Mat3>(arg: T): Mat3 {
        if (typeof arg === "number") {
            const result = new Float32Array(9)
            for (let i = 0; i < 9; i++) result[i] = this.elements[i] * arg
            return new Mat3(result)
        } else {
            const a = this.elements,
                b = arg.elements
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
            return new Mat3(result)
        }
    }
    determinant(): number {
        const m = this.elements
        return m[0] * (m[4] * m[8] - m[7] * m[5]) - m[3] * (m[1] * m[8] - m[7] * m[2]) + m[6] * (m[1] * m[5] - m[4] * m[2])
    }
    inverse(): Mat3 {
        const m = this.elements
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
        return new Mat3(inv)
    }
    transpose(): Mat3 {
        const m = this.elements
        return new Mat3(new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]))
    }
    transform(v: Vec3): Vec3 {
        const m = this.elements
        return new Vec3([m[0] * v.x + m[3] * v.y + m[6] * v.z, m[1] * v.x + m[4] * v.y + m[7] * v.z, m[2] * v.x + m[5] * v.y + m[8] * v.z])
    }
}

export class Mat4 {
    public elements: Float32Array
    constructor(elements?: Float32Array) {
        this.elements = elements ? new Float32Array(elements) : new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    }
    static identity(): Mat4 {
        return new Mat4()
    }
    static translation(tx: number, ty: number, tz: number): Mat4 {
        return new Mat4(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, ty, tz, 1]))
    }
    static rotationX(angle: number): Mat4 {
        const c = Math.cos(angle),
            s = Math.sin(angle)
        return new Mat4(new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]))
    }
    static rotationY(angle: number): Mat4 {
        const c = Math.cos(angle),
            s = Math.sin(angle)
        return new Mat4(new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]))
    }
    static rotationZ(angle: number): Mat4 {
        const c = Math.cos(angle),
            s = Math.sin(angle)
        return new Mat4(new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]))
    }
    static scaling(sx: number, sy: number, sz: number): Mat4 {
        return new Mat4(new Float32Array([sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, 0, 0, 0, 1]))
    }
    static perspective(fov: number, aspect: number, near: number, far: number): Mat4 {
        const f = 1 / Math.tan(fov / 2)
        const nf = 1 / (near - far)
        return new Mat4(new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]))
    }
    static orthographic(left: number, right: number, bottom: number, top: number, near: number, far: number): Mat4 {
        const lr = 1 / (left - right)
        const bt = 1 / (bottom - top)
        const nf = 1 / (near - far)
        return new Mat4(
            new Float32Array([
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
        )
    }
    clone(): Mat4 {
        return new Mat4(this.elements)
    }
    copy(m: Mat4): this {
        this.elements.set(m.elements)
        return this
    }
    equals(m: Mat4): boolean {
        for (let i = 0; i < 16; i++) {
            if (this.elements[i] !== m.elements[i]) return false
        }
        return true
    }
    add(m: Mat4): Mat4 {
        const result = new Float32Array(16)
        for (let i = 0; i < 16; i++) result[i] = this.elements[i] + m.elements[i]
        return new Mat4(result)
    }
    subtract(m: Mat4): Mat4 {
        const result = new Float32Array(16)
        for (let i = 0; i < 16; i++) result[i] = this.elements[i] - m.elements[i]
        return new Mat4(result)
    }
    multiply<T extends number | Mat4>(arg: T): Mat4 {
        if (typeof arg === "number") {
            const result = new Float32Array(16)
            for (let i = 0; i < 16; i++) result[i] = this.elements[i] * arg
            return new Mat4(result)
        } else {
            const a = this.elements,
                b = arg.elements
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
            return new Mat4(result)
        }
    }
    determinant(): number {
        const m = this.elements
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
    inverse(): Mat4 {
        const m = this.elements
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

        return new Mat4(inv)
    }
    transpose(): Mat4 {
        const m = this.elements
        return new Mat4(
            new Float32Array([m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14], m[3], m[7], m[11], m[15]])
        )
    }
    // Transform a 4D vector.
    transform(v: Vec4): Vec4 {
        const m = this.elements
        return new Vec4([
            m[0] * v.x + m[4] * v.y + m[8] * v.z + m[12] * v.w,
            m[1] * v.x + m[5] * v.y + m[9] * v.z + m[13] * v.w,
            m[2] * v.x + m[6] * v.y + m[10] * v.z + m[14] * v.w,
            m[3] * v.x + m[7] * v.y + m[11] * v.z + m[15] * v.w,
        ])
    }
    // Transform a 3D point (assumes w = 1 and then does perspective divide).
    transformPoint(v: Vec3): Vec3 {
        const result = this.transform(new Vec4([v.x, v.y, v.z, 1]))
        return new Vec3([result.x / result.w, result.y / result.w, result.z / result.w])
    }
    // Transform a 3D vector (assumes w = 0).
    transformVector(v: Vec3): Vec3 {
        const result = this.transform(new Vec4([v.x, v.y, v.z, 0]))
        return new Vec3([result.x, result.y, result.z])
    }
}
