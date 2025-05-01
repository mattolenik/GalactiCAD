import { numbersAreDefined, toNumberMust } from "../math.mjs"
import { Storable } from "../storage/storage.mjs"

export type Vec2n = Vec2f | Float32Array | [number, number]
export type Vec2 = Vec2n | string
export type Vec3n = Vec3f | Float32Array | [number, number, number]
export type Vec3 = Vec3n | string
export type Vec4n = Vec4f | Float32Array | [number, number, number, number]
export type Vec4 = Vec4n | string
export type Vecn = Vec2n | Vec3n | Vec4n
export type Vec = Vec2 | Vec3 | Vec4

export abstract class Vecf<TVec extends Vecn> implements Storable {
    public static StringPrecision = 3
    #elements: Float32Array
    get data() {
        return this.#elements
    }
    get byteLength() {
        return this.#elements.byteLength
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

        this.#elements = new Float32Array(src.length)
        this.#elements.set(src)
    }
    toStorage(): string {
        return Array.from(this.#elements).join(",")
    }
    loadStorage(s: string): void {
        this.#elements.set(parseVec(s, this.#elements.length))
    }
    toString(): string {
        return `[${Array.from(this.#elements)
            .map(e => e.toFixed(Vecf.StringPrecision))
            .join(", ")}]`
    }

    set(vec: TVec): void {
        this.data.set(vec instanceof Vecf ? vec.data : vec)
    }
}

export class Vec2f extends Vecf<Vec2n> {
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
    copy(v: Vec2) {
        v = vec2(v)
        this.data.set(v.data)
    }

    equals(v: Vec2): boolean {
        v = vec2(v)
        return this.x === v.x && this.y === v.y
    }
    add(v: Vec2): Vec2f {
        v = vec2(v)
        return vec2(this.x + v.x, this.y + v.y)
    }
    subtract(v: Vec2): Vec2f {
        v = vec2(v)
        return vec2(this.x - v.x, this.y - v.y)
    }
    multiply<T extends number | Vec2f>(arg: T): Vec2f {
        if (typeof arg === "number") {
            return vec2(this.x * arg, this.y * arg)
        } else {
            return vec2(this.x * arg.x, this.y * arg.y)
        }
    }
    dot(v: Vec2): number {
        v = vec2(v)
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
    get xy(): Vec2f {
        return vec2(this.data[0], this.data[1])
    }
    set xy(v: Vec2) {
        this.set(vec2(v))
    }
    get yx(): Vec2f {
        return vec2(this.data[1], this.data[0])
    }
    get yy(): Vec2f {
        return vec2(this.data[1], this.data[1])
    }
}

export class Vec3f extends Vecf<Vec3n> {
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
    set xy(v: Vec2) {
        v = vec2(v)
        this.set([v.x, v.y, this.z])
    }
    get r() {
        return this.x
    }
    set r(v: number) {
        this.x = v
    }
    get g() {
        return this.y
    }
    set g(v: number) {
        this.y = v
    }
    get b() {
        return this.z
    }
    set b(v: number) {
        this.z = v
    }
    set rgb(v: Vec3) {
        this.set(vec3(v))
    }
    get rgb() {
        return this.xyz
    }

    clone(): Vec3f {
        return vec3(this.x, this.y, this.z)
    }
    copy(v: Vec3): this {
        v = vec3(v)
        this.x = v.x
        this.y = v.y
        this.z = v.z
        return this
    }
    equals(v: Vec3): boolean {
        v = vec3(v)
        return this.x === v.x && this.y === v.y && this.z === v.z
    }
    add(v: Vec3): Vec3f {
        v = vec3(v)
        return vec3(this.x + v.x, this.y + v.y, this.z + v.z)
    }
    subtract(v: Vec3): Vec3f {
        v = vec3(v)
        return vec3(this.x - v.x, this.y - v.y, this.z - v.z)
    }
    multiply<T extends number | Vec3>(arg: T): Vec3f {
        if (typeof arg === "number") {
            return vec3(this.x * arg, this.y * arg, this.z * arg)
        } else {
            const v = vec3(arg)
            return vec3(this.x * v.x, this.y * v.y, this.z * v.z)
        }
    }
    scale(arg: number): Vec3f {
        return this.multiply(arg)
    }
    dot(v: Vec3): number {
        v = vec3(v)
        return this.x * v.x + this.y * v.y + this.z * v.z
    }
    cross(v: Vec3): Vec3f {
        v = vec3(v)
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
    get xxy(): Vec3f {
        return vec3(this.data[0], this.data[0], this.data[1])
    }
    get xxz(): Vec3f {
        return vec3(this.data[0], this.data[0], this.data[2])
    }
    get xyx(): Vec3f {
        return vec3(this.data[0], this.data[1], this.data[0])
    }
    get xyy(): Vec3f {
        return vec3(this.data[0], this.data[1], this.data[1])
    }
    get xyz(): Vec3f {
        return vec3(this.data[0], this.data[1], this.data[2])
    }
    get xzx(): Vec3f {
        return vec3(this.data[0], this.data[2], this.data[0])
    }
    get xzy(): Vec3f {
        return vec3(this.data[0], this.data[2], this.data[1])
    }
    get xzz(): Vec3f {
        return vec3(this.data[0], this.data[2], this.data[2])
    }
    get yxx(): Vec3f {
        return vec3(this.data[1], this.data[0], this.data[0])
    }
    get yxy(): Vec3f {
        return vec3(this.data[1], this.data[0], this.data[1])
    }
    get yxz(): Vec3f {
        return vec3(this.data[1], this.data[0], this.data[2])
    }
    get yyx(): Vec3f {
        return vec3(this.data[1], this.data[1], this.data[0])
    }
    get yyy(): Vec3f {
        return vec3(this.data[1], this.data[1], this.data[1])
    }
    get yyz(): Vec3f {
        return vec3(this.data[1], this.data[1], this.data[2])
    }
    get yzx(): Vec3f {
        return vec3(this.data[1], this.data[2], this.data[0])
    }
    get yzy(): Vec3f {
        return vec3(this.data[1], this.data[2], this.data[1])
    }
    get yzz(): Vec3f {
        return vec3(this.data[1], this.data[2], this.data[2])
    }
    get zxx(): Vec3f {
        return vec3(this.data[2], this.data[0], this.data[0])
    }
    get zxy(): Vec3f {
        return vec3(this.data[2], this.data[0], this.data[1])
    }
    get zxz(): Vec3f {
        return vec3(this.data[2], this.data[0], this.data[2])
    }
    get zyx(): Vec3f {
        return vec3(this.data[2], this.data[1], this.data[0])
    }
    get zyy(): Vec3f {
        return vec3(this.data[2], this.data[1], this.data[1])
    }
    get zyz(): Vec3f {
        return vec3(this.data[2], this.data[1], this.data[2])
    }
    get zzx(): Vec3f {
        return vec3(this.data[2], this.data[2], this.data[0])
    }
    get zzy(): Vec3f {
        return vec3(this.data[2], this.data[2], this.data[1])
    }
    get zzz(): Vec3f {
        return vec3(this.data[2], this.data[2], this.data[2])
    }
}

export class Vec4f extends Vecf<Vec4n> {
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
    set xy(v: Vec2) {
        v = vec2(v)
        this.set([v.x, v.y, this.z, this.w])
    }
    get xyz(): Vec3f {
        return vec3(this.x, this.y, this.z)
    }
    set xyz(v: Vec3) {
        v = vec3(v)
        this.set([v.x, v.y, v.z, this.w])
    }
    set xyzw(v: Vec4) {
        v = vec4(v)
        this.set(v)
    }
    get r() {
        return this.x
    }
    set r(v: number) {
        this.x = v
    }
    get g() {
        return this.y
    }
    set g(v: number) {
        this.y = v
    }
    get b() {
        return this.z
    }
    set b(v: number) {
        this.z = v
    }
    get a() {
        return this.w
    }
    set a(v: number) {
        this.w = v
    }
    set rgb(v: Vec3) {
        v = vec3(v)
        this.xyz = v
    }
    get rgb() {
        return this.xyz
    }
    set rgba(v: Vec4) {
        v = vec4(v)
        this.xyzw = v
    }
    get rgba() {
        return this.xyzw
    }

    clone(): Vec4f {
        return vec4(this.x, this.y, this.z, this.w)
    }
    add(v: Vec4): Vec4f {
        v = vec4(v)
        return vec4(this.x + v.x, this.y + v.y, this.z + v.z, this.w + v.w)
    }
    subtract(v: Vec4): Vec4f {
        v = vec4(v)
        return vec4(this.x - v.x, this.y - v.y, this.z - v.z, this.w - v.w)
    }
    multiply<T extends number | Vec4f>(arg: T): Vec4f {
        if (typeof arg === "number") {
            return vec4(this.x * arg, this.y * arg, this.z * arg, this.w * arg)
        } else {
            const v = vec4(arg)
            return vec4(this.x * v.x, this.y * v.y, this.z * v.z, this.w * v.w)
        }
    }
    dot(v: Vec4): number {
        v = vec4(v)
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
    get xxyw(): Vec4f {
        return vec4(this.data[0], this.data[0], this.data[1], this.data[3])
    }
    get xxzw(): Vec4f {
        return vec4(this.data[0], this.data[0], this.data[2], this.data[3])
    }
    get xyxw(): Vec4f {
        return vec4(this.data[0], this.data[1], this.data[0], this.data[3])
    }
    get xyyw(): Vec4f {
        return vec4(this.data[0], this.data[1], this.data[1], this.data[3])
    }
    get xyzw(): Vec4f {
        return vec4(this.data[0], this.data[1], this.data[2], this.data[3])
    }
    get xzxw(): Vec4f {
        return vec4(this.data[0], this.data[2], this.data[0], this.data[3])
    }
    get xzyw(): Vec4f {
        return vec4(this.data[0], this.data[2], this.data[1], this.data[3])
    }
    get xzzw(): Vec4f {
        return vec4(this.data[0], this.data[2], this.data[2], this.data[3])
    }
    get yxxw(): Vec4f {
        return vec4(this.data[1], this.data[0], this.data[0], this.data[3])
    }
    get yxyw(): Vec4f {
        return vec4(this.data[1], this.data[0], this.data[1], this.data[3])
    }
    get yxzw(): Vec4f {
        return vec4(this.data[1], this.data[0], this.data[2], this.data[3])
    }
    get yyxw(): Vec4f {
        return vec4(this.data[1], this.data[1], this.data[0], this.data[3])
    }
    get yyyw(): Vec4f {
        return vec4(this.data[1], this.data[1], this.data[1], this.data[3])
    }
    get yyzw(): Vec4f {
        return vec4(this.data[1], this.data[1], this.data[2], this.data[3])
    }
    get yzxw(): Vec4f {
        return vec4(this.data[1], this.data[2], this.data[0], this.data[3])
    }
    get yzyw(): Vec4f {
        return vec4(this.data[1], this.data[2], this.data[1], this.data[3])
    }
    get yzzw(): Vec4f {
        return vec4(this.data[1], this.data[2], this.data[2], this.data[3])
    }
    get zxxw(): Vec4f {
        return vec4(this.data[2], this.data[0], this.data[0], this.data[3])
    }
    get zxyw(): Vec4f {
        return vec4(this.data[2], this.data[0], this.data[1], this.data[3])
    }
    get zxzw(): Vec4f {
        return vec4(this.data[2], this.data[0], this.data[2], this.data[3])
    }
    get zyxw(): Vec4f {
        return vec4(this.data[2], this.data[1], this.data[0], this.data[3])
    }
    get zyyw(): Vec4f {
        return vec4(this.data[2], this.data[1], this.data[1], this.data[3])
    }
    get zyzw(): Vec4f {
        return vec4(this.data[2], this.data[1], this.data[2], this.data[3])
    }
    get zzxw(): Vec4f {
        return vec4(this.data[2], this.data[2], this.data[0], this.data[3])
    }
    get zzyw(): Vec4f {
        return vec4(this.data[2], this.data[2], this.data[1], this.data[3])
    }
    get zzzw(): Vec4f {
        return vec4(this.data[2], this.data[2], this.data[2], this.data[3])
    }
}

export function vec2(x: number, y: number): Vec2f
export function vec2(vec: Vec2): Vec2f
export function vec2(vec: Vec2 | number, y?: number): Vec2f {
    if (typeof vec === "number") {
        if (y === undefined || y === null) {
            throw new Error("if X is specified as a number, y must also be specified")
        }
        return new Vec2f([vec, y])
    }
    if (numbersAreDefined(y)) {
        throw new Error("y cannot be specified if the first argument is a vector")
    }
    if (typeof vec === "string") {
        return new Vec2f(parseVec(vec, 2) as [number, number])
    }
    if (Array.isArray(vec)) {
        if (vec.length !== 2) {
            throw new Error(`invalid vector length, expected 2, got: ${(vec as any).length}`)
        }
        return new Vec2f(vec)
    }
    if (vec instanceof Vec2f) {
        return vec
    }
    throw new Error("unsupported vec2 type")
}

export function vec3(x: number, y: number, z: number): Vec3f
export function vec3(vec: Vec3): Vec3f
export function vec3(vec: Vec3 | number, y?: number, z?: number): Vec3f {
    if (typeof vec === "number") {
        if (!numbersAreDefined(vec, y, z)) {
            throw new Error("if X is specified as a number, y, and z must also be specified")
        }
        return new Vec3f([vec, y!, z!])
    }
    if (numbersAreDefined(y, z)) {
        throw new Error("y and z cannot be specified if the first argument is a vector")
    }
    if (typeof vec === "string") {
        return new Vec3f(parseVec(vec, 3) as [number, number, number])
    }
    if (Array.isArray(vec)) {
        if (vec.length !== 3) {
            throw new Error(`invalid vector length, expected 3, got: ${(vec as any).length}`)
        }
        return new Vec3f(vec)
    }
    if (vec instanceof Vec3f) {
        return vec
    }
    throw new Error("unsupported vec3 type")
}

export function vec4(x: number, y: number, z: number, w: number): Vec4f
export function vec4(vec: Vec4): Vec4f
export function vec4(vec: Vec4 | number, y?: number, z?: number, w?: number): Vec4f {
    if (typeof vec === "number") {
        if (!numbersAreDefined(vec, y, z, w)) {
            throw new Error("if X is specified as a number, y, z, and w must also be specified")
        }
        return new Vec4f([vec, y!, z!, w!])
    }
    if (numbersAreDefined(y, z, w)) {
        throw new Error("y and z cannot be specified if the first argument is a vector")
    }
    if (typeof vec === "string") {
        return new Vec4f(parseVec(vec, 4) as [number, number, number, number])
    }
    if (Array.isArray(vec)) {
        if (vec.length !== 4) {
            throw new Error(`invalid vector length, expected 4, got: ${(vec as any).length}`)
        }
        return new Vec4f(vec)
    }
    if (vec instanceof Vec4f) {
        return vec
    }
    throw new Error("unsupported vec4 type")
}

function parseVec(v: string, expectedLength?: number): [number, number] | [number, number, number] | [number, number, number, number] {
    let elements: number[]
    try {
        elements = v
            .trim()
            .replace(/^[\{\[\(]/, "")
            .replace(/[\}\]\)]$/, "")
            .split(/(?:\s*,\s*)|\s+/)
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
