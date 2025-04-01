import { toNumberMust } from "../math.mjs"
import { Storable } from "../storage/storage.mjs"

export type Vec2 = Vec2f | Float32Array | [number, number] | string
export type Vec3 = Vec3f | Float32Array | [number, number, number] | string
export type Vec4 = Vec4f | Float32Array | [number, number, number, number] | string
export type Vec = Vec2 | Vec3 | Vec4

export function vec2(x: number, y: number): Vec2f {
    return new Vec2f([x, y])
}

export function vec3(x: number, y: number, z: number): Vec3f {
    return new Vec3f([x, y, z])
}

export function vec4(x: number, y: number, z: number, w: number): Vec4f {
    return new Vec4f([x, y, z, w])
}

export abstract class Vecf implements Storable {
    public static StringPrecision = 2
    private _data: Float32Array
    get data() {
        return this._data
    }
    get byteLength() {
        return this._data.byteLength
    }
    constructor(elements: Vec, expectedLength?: number) {
        let src: Float32Array | number[]
        if (typeof elements === "string") {
            src = new Float32Array(parseVec(elements, expectedLength))
        } else if (elements instanceof Float32Array) {
            src = elements
        } else if (elements instanceof Vecf) {
            src = elements.data
        } else if (Array.isArray(elements)) {
            src = new Float32Array(elements)
        } else {
            throw new Error("invalid vector elements type")
        }
        if (src.length < 2 || src.length > 4) {
            throw new Error("only vector lengths 2, 3, and 4 are supported")
        }
        if (expectedLength) {
            if (expectedLength < 2 || expectedLength > 4) {
                throw new Error("expectedLength must be a valid vector length: 2, 3, or 4")
            }
            if (src.length != expectedLength) {
                throw new Error(`vector length mismatch, expected ${expectedLength} but input has ${src.length}`)
            }
        }

        this._data = new Float32Array(src.length)
        this._data.set(src)
    }
    toStorage(): string {
        return Array.from(this._data).join(",")
    }
    loadStorage(s: string): void {
        this._data.set(parseVec(s, this._data.length))
    }
    toString(): string {
        return `[${Array.from(this._data)
            .map(e => e.toFixed(Vecf.StringPrecision))
            .join(", ")}]`
    }
}

export class Vec2f extends Vecf {
    /**
     * Creates a new vector, clones an existing vector, or parses a vector from a string
     * @param elements the elements of the vector. May be a tuple/array, Float32Array, another vector, or a string
     */
    constructor(elements?: Vec2 | null) {
        super(elements ?? [0, 0], 2)
    }
    get x(): number {
        return this.data[0]
    }
    set x(val: number) {
        this.data[0] = val
    }
    get y(): number {
        return this.data[1]
    }
    set y(val: number) {
        this.data[1] = val
    }

    clone(): Vec2f {
        return new Vec2f(this)
    }
    copy(v: Vec2f) {
        this.data.set(v.data)
    }
    set(x: number, y: number) {
        this.x = x
        this.y = y
    }
    equals(v: Vec2f): boolean {
        return this.x === v.x && this.y === v.y
    }
    add(v: Vec2f): Vec2f {
        return vec2(this.x + v.x, this.y + v.y)
    }
    subtract(v: Vec2f): Vec2f {
        return vec2(this.x - v.x, this.y - v.y)
    }
    multiply<T extends number | Vec2f>(arg: T): Vec2f {
        if (typeof arg === "number") {
            return vec2(this.x * arg, this.y * arg)
        } else {
            return vec2(this.x * arg.x, this.y * arg.y)
        }
    }
    dot(v: Vec2f): number {
        return this.x * v.x + this.y * v.y
    }
    length(): number {
        return Math.sqrt(this.dot(this))
    }
    normalize(): Vec2f {
        const len = this.length()
        return len === 0 ? this.clone() : this.multiply(1 / len)
    }

    get xx(): Vec2f {
        return vec2(this.data[0], this.data[0])
    }
    set xx(value: Vec2f) {
        this.data[0] = value.x
        this.data[0] = value.y
    }
    get xy(): Vec2f {
        return vec2(this.data[0], this.data[1])
    }
    set xy(value: Vec2f) {
        this.data[0] = value.x
        this.data[1] = value.y
    }
    get yx(): Vec2f {
        return vec2(this.data[1], this.data[0])
    }
    set yx(value: Vec2f) {
        this.data[1] = value.x
        this.data[0] = value.y
    }
    get yy(): Vec2f {
        return vec2(this.data[1], this.data[1])
    }
    set yy(value: Vec2f) {
        this.data[1] = value.x
        this.data[1] = value.y
    }
}

export class Vec3f extends Vecf {
    constructor(elements?: Vec3 | null) {
        super(elements ?? [0, 0, 0], 3)
    }
    get x(): number {
        return this.data[0]
    }
    set x(val: number) {
        this.data[0] = val
    }
    get y(): number {
        return this.data[1]
    }
    set y(val: number) {
        this.data[1] = val
    }
    get z(): number {
        return this.data[2]
    }
    set z(val: number) {
        this.data[2] = val
    }

    clone(): Vec3f {
        return vec3(this.x, this.y, this.z)
    }
    copy(v: Vec3f): this {
        this.x = v.x
        this.y = v.y
        this.z = v.z
        return this
    }
    set(x: number, y: number, z: number): this {
        this.x = x
        this.y = y
        this.z = z
        return this
    }
    equals(v: Vec3f): boolean {
        return this.x === v.x && this.y === v.y && this.z === v.z
    }
    add(v: Vec3f): Vec3f {
        return vec3(this.x + v.x, this.y + v.y, this.z + v.z)
    }
    subtract(v: Vec3f): Vec3f {
        return vec3(this.x - v.x, this.y - v.y, this.z - v.z)
    }
    multiply<T extends number | Vec3f>(arg: T): Vec3f {
        if (typeof arg === "number") {
            return vec3(this.x * arg, this.y * arg, this.z * arg)
        } else {
            return vec3(this.x * arg.x, this.y * arg.y, this.z * arg.z)
        }
    }
    scale(arg: number): Vec3f {
        return this.multiply(arg)
    }
    dot(v: Vec3f): number {
        return this.x * v.x + this.y * v.y + this.z * v.z
    }
    cross(v: Vec3f): Vec3f {
        return vec3(this.y * v.z - this.z * v.y, this.z * v.x - this.x * v.z, this.x * v.y - this.y * v.x)
    }
    length(): number {
        return Math.sqrt(this.dot(this))
    }
    normalize(): Vec3f {
        const len = this.length()
        return len === 0 ? this.clone() : this.multiply(1 / len)
    }
    get xxx(): Vec3f {
        return vec3(this.data[0], this.data[0], this.data[0])
    }
    set xxx(value: Vec3f) {
        this.data[0] = value.x
        this.data[0] = value.y
        this.data[0] = value.z
    }
    get xxy(): Vec3f {
        return vec3(this.data[0], this.data[0], this.data[1])
    }
    set xxy(value: Vec3f) {
        this.data[0] = value.x
        this.data[0] = value.y
        this.data[1] = value.z
    }
    get xxz(): Vec3f {
        return vec3(this.data[0], this.data[0], this.data[2])
    }
    set xxz(value: Vec3f) {
        this.data[0] = value.x
        this.data[0] = value.y
        this.data[2] = value.z
    }
    get xyx(): Vec3f {
        return vec3(this.data[0], this.data[1], this.data[0])
    }
    set xyx(value: Vec3f) {
        this.data[0] = value.x
        this.data[1] = value.y
        this.data[0] = value.z
    }
    get xyy(): Vec3f {
        return vec3(this.data[0], this.data[1], this.data[1])
    }
    set xyy(value: Vec3f) {
        this.data[0] = value.x
        this.data[1] = value.y
        this.data[1] = value.z
    }
    get xyz(): Vec3f {
        return vec3(this.data[0], this.data[1], this.data[2])
    }
    set xyz(value: Vec3f) {
        this.data[0] = value.x
        this.data[1] = value.y
        this.data[2] = value.z
    }
    get xzx(): Vec3f {
        return vec3(this.data[0], this.data[2], this.data[0])
    }
    set xzx(value: Vec3f) {
        this.data[0] = value.x
        this.data[2] = value.y
        this.data[0] = value.z
    }
    get xzy(): Vec3f {
        return vec3(this.data[0], this.data[2], this.data[1])
    }
    set xzy(value: Vec3f) {
        this.data[0] = value.x
        this.data[2] = value.y
        this.data[1] = value.z
    }
    get xzz(): Vec3f {
        return vec3(this.data[0], this.data[2], this.data[2])
    }
    set xzz(value: Vec3f) {
        this.data[0] = value.x
        this.data[2] = value.y
        this.data[2] = value.z
    }

    get yxx(): Vec3f {
        return vec3(this.data[1], this.data[0], this.data[0])
    }
    set yxx(value: Vec3f) {
        this.data[1] = value.x
        this.data[0] = value.y
        this.data[0] = value.z
    }
    get yxy(): Vec3f {
        return vec3(this.data[1], this.data[0], this.data[1])
    }
    set yxy(value: Vec3f) {
        this.data[1] = value.x
        this.data[0] = value.y
        this.data[1] = value.z
    }
    get yxz(): Vec3f {
        return vec3(this.data[1], this.data[0], this.data[2])
    }
    set yxz(value: Vec3f) {
        this.data[1] = value.x
        this.data[0] = value.y
        this.data[2] = value.z
    }
    get yyx(): Vec3f {
        return vec3(this.data[1], this.data[1], this.data[0])
    }
    set yyx(value: Vec3f) {
        this.data[1] = value.x
        this.data[1] = value.y
        this.data[0] = value.z
    }
    get yyy(): Vec3f {
        return vec3(this.data[1], this.data[1], this.data[1])
    }
    set yyy(value: Vec3f) {
        this.data[1] = value.x
        this.data[1] = value.y
        this.data[1] = value.z
    }
    get yyz(): Vec3f {
        return vec3(this.data[1], this.data[1], this.data[2])
    }
    set yyz(value: Vec3f) {
        this.data[1] = value.x
        this.data[1] = value.y
        this.data[2] = value.z
    }
    get yzx(): Vec3f {
        return vec3(this.data[1], this.data[2], this.data[0])
    }
    set yzx(value: Vec3f) {
        this.data[1] = value.x
        this.data[2] = value.y
        this.data[0] = value.z
    }
    get yzy(): Vec3f {
        return vec3(this.data[1], this.data[2], this.data[1])
    }
    set yzy(value: Vec3f) {
        this.data[1] = value.x
        this.data[2] = value.y
        this.data[1] = value.z
    }
    get yzz(): Vec3f {
        return vec3(this.data[1], this.data[2], this.data[2])
    }
    set yzz(value: Vec3f) {
        this.data[1] = value.x
        this.data[2] = value.y
        this.data[2] = value.z
    }

    get zxx(): Vec3f {
        return vec3(this.data[2], this.data[0], this.data[0])
    }
    set zxx(value: Vec3f) {
        this.data[2] = value.x
        this.data[0] = value.y
        this.data[0] = value.z
    }
    get zxy(): Vec3f {
        return vec3(this.data[2], this.data[0], this.data[1])
    }
    set zxy(value: Vec3f) {
        this.data[2] = value.x
        this.data[0] = value.y
        this.data[1] = value.z
    }
    get zxz(): Vec3f {
        return vec3(this.data[2], this.data[0], this.data[2])
    }
    set zxz(value: Vec3f) {
        this.data[2] = value.x
        this.data[0] = value.y
        this.data[2] = value.z
    }
    get zyx(): Vec3f {
        return vec3(this.data[2], this.data[1], this.data[0])
    }
    set zyx(value: Vec3f) {
        this.data[2] = value.x
        this.data[1] = value.y
        this.data[0] = value.z
    }
    get zyy(): Vec3f {
        return vec3(this.data[2], this.data[1], this.data[1])
    }
    set zyy(value: Vec3f) {
        this.data[2] = value.x
        this.data[1] = value.y
        this.data[1] = value.z
    }
    get zyz(): Vec3f {
        return vec3(this.data[2], this.data[1], this.data[2])
    }
    set zyz(value: Vec3f) {
        this.data[2] = value.x
        this.data[1] = value.y
        this.data[2] = value.z
    }
    get zzx(): Vec3f {
        return vec3(this.data[2], this.data[2], this.data[0])
    }
    set zzx(value: Vec3f) {
        this.data[2] = value.x
        this.data[2] = value.y
        this.data[0] = value.z
    }
    get zzy(): Vec3f {
        return vec3(this.data[2], this.data[2], this.data[1])
    }
    set zzy(value: Vec3f) {
        this.data[2] = value.x
        this.data[2] = value.y
        this.data[1] = value.z
    }
    get zzz(): Vec3f {
        return vec3(this.data[2], this.data[2], this.data[2])
    }
    set zzz(value: Vec3f) {
        this.data[2] = value.x
        this.data[2] = value.y
        this.data[2] = value.z
    }
}

export class Vec4f extends Vecf {
    constructor(elements?: Vec4 | null) {
        super(elements ?? [0, 0, 0, 0], 4)
    }

    get x(): number {
        return this.data[0]
    }
    set x(val: number) {
        this.data[0] = val
    }
    get y(): number {
        return this.data[1]
    }
    set y(val: number) {
        this.data[1] = val
    }
    get z(): number {
        return this.data[2]
    }
    set z(val: number) {
        this.data[2] = val
    }
    get w(): number {
        return this.data[3]
    }
    set w(val: number) {
        this.data[3] = val
    }

    clone(): Vec4f {
        return vec4(this.x, this.y, this.z, this.w)
    }
    add(v: Vec4f): Vec4f {
        return vec4(this.x + v.x, this.y + v.y, this.z + v.z, this.w + v.w)
    }
    subtract(v: Vec4f): Vec4f {
        return vec4(this.x - v.x, this.y - v.y, this.z - v.z, this.w - v.w)
    }
    multiply<T extends number | Vec4f>(arg: T): Vec4f {
        if (typeof arg === "number") {
            return vec4(this.x * arg, this.y * arg, this.z * arg, this.w * arg)
        } else {
            return vec4(this.x * arg.x, this.y * arg.y, this.z * arg.z, this.w * arg.w)
        }
    }
    dot(v: Vec4f): number {
        return this.x * v.x + this.y * v.y + this.z * v.z + this.w * v.w
    }
    length(): number {
        return Math.sqrt(this.dot(this))
    }
    normalize(): Vec4f {
        const len = this.length()
        return len === 0 ? this.clone() : this.multiply(1 / len)
    }
    get xxxw(): Vec4f {
        return vec4(this.data[0], this.data[0], this.data[0], this.data[3])
    }
    set xxxw(value: Vec4f) {
        this.data[0] = value.x
        this.data[0] = value.y
        this.data[0] = value.z
        this.data[3] = value.w
    }
    get xxyw(): Vec4f {
        return vec4(this.data[0], this.data[0], this.data[1], this.data[3])
    }
    set xxyw(value: Vec4f) {
        this.data[0] = value.x
        this.data[0] = value.y
        this.data[1] = value.z
        this.data[3] = value.w
    }
    get xxzw(): Vec4f {
        return vec4(this.data[0], this.data[0], this.data[2], this.data[3])
    }
    set xxzw(value: Vec4f) {
        this.data[0] = value.x
        this.data[0] = value.y
        this.data[2] = value.z
        this.data[3] = value.w
    }
    get xyxw(): Vec4f {
        return vec4(this.data[0], this.data[1], this.data[0], this.data[3])
    }
    set xyxw(value: Vec4f) {
        this.data[0] = value.x
        this.data[1] = value.y
        this.data[0] = value.z
        this.data[3] = value.w
    }
    get xyyw(): Vec4f {
        return vec4(this.data[0], this.data[1], this.data[1], this.data[3])
    }
    set xyyw(value: Vec4f) {
        this.data[0] = value.x
        this.data[1] = value.y
        this.data[1] = value.z
        this.data[3] = value.w
    }
    get xyzw(): Vec4f {
        return vec4(this.data[0], this.data[1], this.data[2], this.data[3])
    }
    set xyzw(value: Vec4f) {
        this.data[0] = value.x
        this.data[1] = value.y
        this.data[2] = value.z
        this.data[3] = value.w
    }
    get xzxw(): Vec4f {
        return vec4(this.data[0], this.data[2], this.data[0], this.data[3])
    }
    set xzxw(value: Vec4f) {
        this.data[0] = value.x
        this.data[2] = value.y
        this.data[0] = value.z
        this.data[3] = value.w
    }
    get xzyw(): Vec4f {
        return vec4(this.data[0], this.data[2], this.data[1], this.data[3])
    }
    set xzyw(value: Vec4f) {
        this.data[0] = value.x
        this.data[2] = value.y
        this.data[1] = value.z
        this.data[3] = value.w
    }
    get xzzw(): Vec4f {
        return vec4(this.data[0], this.data[2], this.data[2], this.data[3])
    }
    set xzzw(value: Vec4f) {
        this.data[0] = value.x
        this.data[2] = value.y
        this.data[2] = value.z
        this.data[3] = value.w
    }
    get yxxw(): Vec4f {
        return vec4(this.data[1], this.data[0], this.data[0], this.data[3])
    }
    set yxxw(value: Vec4f) {
        this.data[1] = value.x
        this.data[0] = value.y
        this.data[0] = value.z
        this.data[3] = value.w
    }
    get yxyw(): Vec4f {
        return vec4(this.data[1], this.data[0], this.data[1], this.data[3])
    }
    set yxyw(value: Vec4f) {
        this.data[1] = value.x
        this.data[0] = value.y
        this.data[1] = value.z
        this.data[3] = value.w
    }
    get yxzw(): Vec4f {
        return vec4(this.data[1], this.data[0], this.data[2], this.data[3])
    }
    set yxzw(value: Vec4f) {
        this.data[1] = value.x
        this.data[0] = value.y
        this.data[2] = value.z
        this.data[3] = value.w
    }
    get yyxw(): Vec4f {
        return vec4(this.data[1], this.data[1], this.data[0], this.data[3])
    }
    set yyxw(value: Vec4f) {
        this.data[1] = value.x
        this.data[1] = value.y
        this.data[0] = value.z
        this.data[3] = value.w
    }
    get yyyw(): Vec4f {
        return vec4(this.data[1], this.data[1], this.data[1], this.data[3])
    }
    set yyyw(value: Vec4f) {
        this.data[1] = value.x
        this.data[1] = value.y
        this.data[1] = value.z
        this.data[3] = value.w
    }
    get yyzw(): Vec4f {
        return vec4(this.data[1], this.data[1], this.data[2], this.data[3])
    }
    set yyzw(value: Vec4f) {
        this.data[1] = value.x
        this.data[1] = value.y
        this.data[2] = value.z
        this.data[3] = value.w
    }
    get yzxw(): Vec4f {
        return vec4(this.data[1], this.data[2], this.data[0], this.data[3])
    }
    set yzxw(value: Vec4f) {
        this.data[1] = value.x
        this.data[2] = value.y
        this.data[0] = value.z
        this.data[3] = value.w
    }
    get yzyw(): Vec4f {
        return vec4(this.data[1], this.data[2], this.data[1], this.data[3])
    }
    set yzyw(value: Vec4f) {
        this.data[1] = value.x
        this.data[2] = value.y
        this.data[1] = value.z
        this.data[3] = value.w
    }
    get yzzw(): Vec4f {
        return vec4(this.data[1], this.data[2], this.data[2], this.data[3])
    }
    set yzzw(value: Vec4f) {
        this.data[1] = value.x
        this.data[2] = value.y
        this.data[2] = value.z
        this.data[3] = value.w
    }
    get zxxw(): Vec4f {
        return vec4(this.data[2], this.data[0], this.data[0], this.data[3])
    }
    set zxxw(value: Vec4f) {
        this.data[2] = value.x
        this.data[0] = value.y
        this.data[0] = value.z
        this.data[3] = value.w
    }
    get zxyw(): Vec4f {
        return vec4(this.data[2], this.data[0], this.data[1], this.data[3])
    }
    set zxyw(value: Vec4f) {
        this.data[2] = value.x
        this.data[0] = value.y
        this.data[1] = value.z
        this.data[3] = value.w
    }
    get zxzw(): Vec4f {
        return vec4(this.data[2], this.data[0], this.data[2], this.data[3])
    }
    set zxzw(value: Vec4f) {
        this.data[2] = value.x
        this.data[0] = value.y
        this.data[2] = value.z
        this.data[3] = value.w
    }
    get zyxw(): Vec4f {
        return vec4(this.data[2], this.data[1], this.data[0], this.data[3])
    }
    set zyxw(value: Vec4f) {
        this.data[2] = value.x
        this.data[1] = value.y
        this.data[0] = value.z
        this.data[3] = value.w
    }
    get zyyw(): Vec4f {
        return vec4(this.data[2], this.data[1], this.data[1], this.data[3])
    }
    set zyyw(value: Vec4f) {
        this.data[2] = value.x
        this.data[1] = value.y
        this.data[1] = value.z
        this.data[3] = value.w
    }
    get zyzw(): Vec4f {
        return vec4(this.data[2], this.data[1], this.data[2], this.data[3])
    }
    set zyzw(value: Vec4f) {
        this.data[2] = value.x
        this.data[1] = value.y
        this.data[2] = value.z
        this.data[3] = value.w
    }
    get zzxw(): Vec4f {
        return vec4(this.data[2], this.data[2], this.data[0], this.data[3])
    }
    set zzxw(value: Vec4f) {
        this.data[2] = value.x
        this.data[2] = value.y
        this.data[0] = value.z
        this.data[3] = value.w
    }
    get zzyw(): Vec4f {
        return vec4(this.data[2], this.data[2], this.data[1], this.data[3])
    }
    set zzyw(value: Vec4f) {
        this.data[2] = value.x
        this.data[2] = value.y
        this.data[1] = value.z
        this.data[3] = value.w
    }
    get zzzw(): Vec4f {
        return vec4(this.data[2], this.data[2], this.data[2], this.data[3])
    }
    set zzzw(value: Vec4f) {
        this.data[2] = value.x
        this.data[2] = value.y
        this.data[2] = value.z
        this.data[3] = value.w
    }
}

function parseVec(v: string, expectedLength?: number): [number, number] | [number, number, number] | [number, number, number, number] {
    let elements: number[]
    try {
        elements = v
            .trim()
            .replace(/^[\{\[\(]/, "")
            .replace(/[\}\]\)]$/, "")
            .split(/,\s*/)
            .map(e => toNumberMust(e))
    } catch (e) {
        throw new Error(`invalid vector string '${v}': ${e}`)
    }
    if (expectedLength) {
        if (expectedLength < 2 || expectedLength > 4) {
            throw new Error("expectedLength must be a valid vector length: 2, 3, or 4")
        }
        if (elements.length != expectedLength) {
            throw new Error(`vector length mismatch, expected ${expectedLength} but input string has ${elements.length}`)
        }
    }
    if (elements.length === 2) {
        return [elements[0], elements[1]]
    }
    if (elements.length === 3) {
        return [elements[0], elements[1], elements[2]]
    }
    if (elements.length === 4) {
        return [elements[0], elements[1], elements[2], elements[3]]
    }
    throw new Error(`invalid vector size ${elements.length}`)
}
