type Constructor<T = {}> = new (...args: any[]) => T

var ToStringPrecision = 2

class BaseVec2 {
    public data: Float32Array

    constructor(x: Float32Array | [number, number] | number, y?: number) {
        if (typeof x === "number") {
            if (y === undefined) {
                throw new Error("invalid vector size, must be 2")
            }
            this.data = new Float32Array([x, y])
        } else {
            if (x.length != 2) {
                throw new Error("invalid vector size, must be 2")
            }
            this.data = x instanceof Float32Array ? x : new Float32Array(x)
        }
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

    clone(): BaseVec2 {
        return vec2(this.x, this.y)
    }
    copy(v: BaseVec2): this {
        this.x = v.x
        this.y = v.y
        return this
    }
    set(x: number, y: number): this {
        this.x = x
        this.y = y
        return this
    }
    equals(v: BaseVec2): boolean {
        return this.x === v.x && this.y === v.y
    }
    add(v: BaseVec2): BaseVec2 {
        return vec2(this.x + v.x, this.y + v.y)
    }
    subtract(v: BaseVec2): BaseVec2 {
        return vec2(this.x - v.x, this.y - v.y)
    }
    multiply<T extends number | BaseVec2>(arg: T): BaseVec2 {
        if (typeof arg === "number") {
            return vec2(this.x * arg, this.y * arg)
        } else {
            return vec2(this.x * arg.x, this.y * arg.y)
        }
    }
    dot(v: BaseVec2): number {
        return this.x * v.x + this.y * v.y
    }
    length(): number {
        return Math.sqrt(this.dot(this))
    }
    normalize(): BaseVec2 {
        const len = this.length()
        return len === 0 ? this.clone() : this.multiply(1 / len)
    }
}

class BaseVec3 {
    public data: Float32Array

    constructor(x: Float32Array | [number, number, number] | number, y?: number, z?: number) {
        if (typeof x === "number") {
            if (y === undefined || z === undefined) {
                throw new Error("invalid vector size, must be 3")
            }
            this.data = new Float32Array([x, y, z])
        } else {
            if (x.length != 3) {
                throw new Error("invalid vector size, must be 3")
            }
            this.data = x instanceof Float32Array ? x : new Float32Array(x)
        }
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
    copy(v: BaseVec3): this {
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
    equals(v: BaseVec3): boolean {
        return this.x === v.x && this.y === v.y && this.z === v.z
    }
    add(v: BaseVec3): Vec3f {
        return vec3(this.x + v.x, this.y + v.y, this.z + v.z)
    }
    subtract(v: BaseVec3): Vec3f {
        return vec3(this.x - v.x, this.y - v.y, this.z - v.z)
    }
    multiply<T extends number | BaseVec3>(arg: T): Vec3f {
        if (typeof arg === "number") {
            return vec3(this.x * arg, this.y * arg, this.z * arg)
        } else {
            return vec3(this.x * arg.x, this.y * arg.y, this.z * arg.z)
        }
    }
    scale(arg: number): Vec3f {
        return this.multiply(arg)
    }
    dot(v: BaseVec3): number {
        return this.x * v.x + this.y * v.y + this.z * v.z
    }
    cross(v: BaseVec3): Vec3f {
        return vec3(this.y * v.z - this.z * v.y, this.z * v.x - this.x * v.z, this.x * v.y - this.y * v.x)
    }
    length(): number {
        return Math.sqrt(this.dot(this))
    }
    normalize(): Vec3f {
        const len = this.length()
        return len === 0 ? this.clone() : this.multiply(1 / len)
    }
}

class BaseVec4 {
    public data: Float32Array
    constructor(x?: Float32Array | [number, number, number, number] | number, y?: number, z?: number, w?: number) {
        if (x === undefined) {
            this.data = new Float32Array([0, 0, 0, 0])
            return
        }
        if (typeof x === "number") {
            if (y === undefined || z === undefined || w === undefined) {
                throw new Error("invalid vector size, must be 4")
            }
            this.data = new Float32Array([x, y, z, w])
        } else {
            if (x.length != 4) {
                throw new Error("invalid vector size, must be 4")
            }
            this.data = x instanceof Float32Array ? x : new Float32Array(x)
        }
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

    clone(): BaseVec4 {
        return vec4(this.x, this.y, this.z, this.w)
    }
    add(v: BaseVec4): BaseVec4 {
        return vec4(this.x + v.x, this.y + v.y, this.z + v.z, this.w + v.w)
    }
    subtract(v: BaseVec4): BaseVec4 {
        return vec4(this.x - v.x, this.y - v.y, this.z - v.z, this.w - v.w)
    }
    multiply<T extends number | BaseVec4>(arg: T): BaseVec4 {
        if (typeof arg === "number") {
            return vec4(this.x * arg, this.y * arg, this.z * arg, this.w * arg)
        } else {
            return vec4(this.x * arg.x, this.y * arg.y, this.z * arg.z, this.w * arg.w)
        }
    }
    dot(v: BaseVec4): number {
        return this.x * v.x + this.y * v.y + this.z * v.z + this.w * v.w
    }
    length(): number {
        return Math.sqrt(this.dot(this))
    }
    normalize(): BaseVec4 {
        const len = this.length()
        return len === 0 ? this.clone() : this.multiply(1 / len)
    }
}

function WithSwizzle2<TBase extends Constructor<{ data: Float32Array }>>(Base: TBase) {
    return class extends Base {
        get xx(): BaseVec2 {
            return vec2(this.data[0], this.data[0])
        }
        set xx(value: BaseVec2) {
            this.data[0] = value.x
            this.data[0] = value.y
        }
        get xy(): BaseVec2 {
            return vec2(this.data[0], this.data[1])
        }
        set xy(value: BaseVec2) {
            this.data[0] = value.x
            this.data[1] = value.y
        }
        get yx(): BaseVec2 {
            return vec2(this.data[1], this.data[0])
        }
        set yx(value: BaseVec2) {
            this.data[1] = value.x
            this.data[0] = value.y
        }
        get yy(): BaseVec2 {
            return vec2(this.data[1], this.data[1])
        }
        set yy(value: BaseVec2) {
            this.data[1] = value.x
            this.data[1] = value.y
        }
    }
}

function WithSwizzle3<TBase extends Constructor<{ data: Float32Array }>>(Base: TBase) {
    return class extends WithSwizzle2(Base) {
        get xxx(): BaseVec3 {
            return vec3(this.data[0], this.data[0], this.data[0])
        }
        set xxx(value: BaseVec3) {
            this.data[0] = value.x
            this.data[0] = value.y
            this.data[0] = value.z
        }
        get xxy(): BaseVec3 {
            return vec3(this.data[0], this.data[0], this.data[1])
        }
        set xxy(value: BaseVec3) {
            this.data[0] = value.x
            this.data[0] = value.y
            this.data[1] = value.z
        }
        get xxz(): BaseVec3 {
            return vec3(this.data[0], this.data[0], this.data[2])
        }
        set xxz(value: BaseVec3) {
            this.data[0] = value.x
            this.data[0] = value.y
            this.data[2] = value.z
        }
        get xyx(): BaseVec3 {
            return vec3(this.data[0], this.data[1], this.data[0])
        }
        set xyx(value: BaseVec3) {
            this.data[0] = value.x
            this.data[1] = value.y
            this.data[0] = value.z
        }
        get xyy(): BaseVec3 {
            return vec3(this.data[0], this.data[1], this.data[1])
        }
        set xyy(value: BaseVec3) {
            this.data[0] = value.x
            this.data[1] = value.y
            this.data[1] = value.z
        }
        get xyz(): BaseVec3 {
            return vec3(this.data[0], this.data[1], this.data[2])
        }
        set xyz(value: BaseVec3) {
            this.data[0] = value.x
            this.data[1] = value.y
            this.data[2] = value.z
        }
        get xzx(): BaseVec3 {
            return vec3(this.data[0], this.data[2], this.data[0])
        }
        set xzx(value: BaseVec3) {
            this.data[0] = value.x
            this.data[2] = value.y
            this.data[0] = value.z
        }
        get xzy(): BaseVec3 {
            return vec3(this.data[0], this.data[2], this.data[1])
        }
        set xzy(value: BaseVec3) {
            this.data[0] = value.x
            this.data[2] = value.y
            this.data[1] = value.z
        }
        get xzz(): BaseVec3 {
            return vec3(this.data[0], this.data[2], this.data[2])
        }
        set xzz(value: BaseVec3) {
            this.data[0] = value.x
            this.data[2] = value.y
            this.data[2] = value.z
        }

        get yxx(): BaseVec3 {
            return vec3(this.data[1], this.data[0], this.data[0])
        }
        set yxx(value: BaseVec3) {
            this.data[1] = value.x
            this.data[0] = value.y
            this.data[0] = value.z
        }
        get yxy(): BaseVec3 {
            return vec3(this.data[1], this.data[0], this.data[1])
        }
        set yxy(value: BaseVec3) {
            this.data[1] = value.x
            this.data[0] = value.y
            this.data[1] = value.z
        }
        get yxz(): BaseVec3 {
            return vec3(this.data[1], this.data[0], this.data[2])
        }
        set yxz(value: BaseVec3) {
            this.data[1] = value.x
            this.data[0] = value.y
            this.data[2] = value.z
        }
        get yyx(): BaseVec3 {
            return vec3(this.data[1], this.data[1], this.data[0])
        }
        set yyx(value: BaseVec3) {
            this.data[1] = value.x
            this.data[1] = value.y
            this.data[0] = value.z
        }
        get yyy(): BaseVec3 {
            return vec3(this.data[1], this.data[1], this.data[1])
        }
        set yyy(value: BaseVec3) {
            this.data[1] = value.x
            this.data[1] = value.y
            this.data[1] = value.z
        }
        get yyz(): BaseVec3 {
            return vec3(this.data[1], this.data[1], this.data[2])
        }
        set yyz(value: BaseVec3) {
            this.data[1] = value.x
            this.data[1] = value.y
            this.data[2] = value.z
        }
        get yzx(): BaseVec3 {
            return vec3(this.data[1], this.data[2], this.data[0])
        }
        set yzx(value: BaseVec3) {
            this.data[1] = value.x
            this.data[2] = value.y
            this.data[0] = value.z
        }
        get yzy(): BaseVec3 {
            return vec3(this.data[1], this.data[2], this.data[1])
        }
        set yzy(value: BaseVec3) {
            this.data[1] = value.x
            this.data[2] = value.y
            this.data[1] = value.z
        }
        get yzz(): BaseVec3 {
            return vec3(this.data[1], this.data[2], this.data[2])
        }
        set yzz(value: BaseVec3) {
            this.data[1] = value.x
            this.data[2] = value.y
            this.data[2] = value.z
        }

        get zxx(): BaseVec3 {
            return vec3(this.data[2], this.data[0], this.data[0])
        }
        set zxx(value: BaseVec3) {
            this.data[2] = value.x
            this.data[0] = value.y
            this.data[0] = value.z
        }
        get zxy(): BaseVec3 {
            return vec3(this.data[2], this.data[0], this.data[1])
        }
        set zxy(value: BaseVec3) {
            this.data[2] = value.x
            this.data[0] = value.y
            this.data[1] = value.z
        }
        get zxz(): BaseVec3 {
            return vec3(this.data[2], this.data[0], this.data[2])
        }
        set zxz(value: BaseVec3) {
            this.data[2] = value.x
            this.data[0] = value.y
            this.data[2] = value.z
        }
        get zyx(): BaseVec3 {
            return vec3(this.data[2], this.data[1], this.data[0])
        }
        set zyx(value: BaseVec3) {
            this.data[2] = value.x
            this.data[1] = value.y
            this.data[0] = value.z
        }
        get zyy(): BaseVec3 {
            return vec3(this.data[2], this.data[1], this.data[1])
        }
        set zyy(value: BaseVec3) {
            this.data[2] = value.x
            this.data[1] = value.y
            this.data[1] = value.z
        }
        get zyz(): BaseVec3 {
            return vec3(this.data[2], this.data[1], this.data[2])
        }
        set zyz(value: BaseVec3) {
            this.data[2] = value.x
            this.data[1] = value.y
            this.data[2] = value.z
        }
        get zzx(): BaseVec3 {
            return vec3(this.data[2], this.data[2], this.data[0])
        }
        set zzx(value: BaseVec3) {
            this.data[2] = value.x
            this.data[2] = value.y
            this.data[0] = value.z
        }
        get zzy(): BaseVec3 {
            return vec3(this.data[2], this.data[2], this.data[1])
        }
        set zzy(value: BaseVec3) {
            this.data[2] = value.x
            this.data[2] = value.y
            this.data[1] = value.z
        }
        get zzz(): BaseVec3 {
            return vec3(this.data[2], this.data[2], this.data[2])
        }
        set zzz(value: BaseVec3) {
            this.data[2] = value.x
            this.data[2] = value.y
            this.data[2] = value.z
        }
    }
}

function WithSwizzle4<TBase extends Constructor<{ data: Float32Array }>>(Base: TBase) {
    return class extends Base {
        get xxxw(): BaseVec4 {
            return vec4(this.data[0], this.data[0], this.data[0], this.data[3])
        }
        set xxxw(value: BaseVec4) {
            this.data[0] = value.x
            this.data[0] = value.y
            this.data[0] = value.z
            this.data[3] = value.w
        }
        get xxyw(): BaseVec4 {
            return vec4(this.data[0], this.data[0], this.data[1], this.data[3])
        }
        set xxyw(value: BaseVec4) {
            this.data[0] = value.x
            this.data[0] = value.y
            this.data[1] = value.z
            this.data[3] = value.w
        }
        get xxzw(): BaseVec4 {
            return vec4(this.data[0], this.data[0], this.data[2], this.data[3])
        }
        set xxzw(value: BaseVec4) {
            this.data[0] = value.x
            this.data[0] = value.y
            this.data[2] = value.z
            this.data[3] = value.w
        }
        get xyxw(): BaseVec4 {
            return vec4(this.data[0], this.data[1], this.data[0], this.data[3])
        }
        set xyxw(value: BaseVec4) {
            this.data[0] = value.x
            this.data[1] = value.y
            this.data[0] = value.z
            this.data[3] = value.w
        }
        get xyyw(): BaseVec4 {
            return vec4(this.data[0], this.data[1], this.data[1], this.data[3])
        }
        set xyyw(value: BaseVec4) {
            this.data[0] = value.x
            this.data[1] = value.y
            this.data[1] = value.z
            this.data[3] = value.w
        }
        get xyzw(): BaseVec4 {
            return vec4(this.data[0], this.data[1], this.data[2], this.data[3])
        }
        set xyzw(value: BaseVec4) {
            this.data[0] = value.x
            this.data[1] = value.y
            this.data[2] = value.z
            this.data[3] = value.w
        }
        get xzxw(): BaseVec4 {
            return vec4(this.data[0], this.data[2], this.data[0], this.data[3])
        }
        set xzxw(value: BaseVec4) {
            this.data[0] = value.x
            this.data[2] = value.y
            this.data[0] = value.z
            this.data[3] = value.w
        }
        get xzyw(): BaseVec4 {
            return vec4(this.data[0], this.data[2], this.data[1], this.data[3])
        }
        set xzyw(value: BaseVec4) {
            this.data[0] = value.x
            this.data[2] = value.y
            this.data[1] = value.z
            this.data[3] = value.w
        }
        get xzzw(): BaseVec4 {
            return vec4(this.data[0], this.data[2], this.data[2], this.data[3])
        }
        set xzzw(value: BaseVec4) {
            this.data[0] = value.x
            this.data[2] = value.y
            this.data[2] = value.z
            this.data[3] = value.w
        }
        get yxxw(): BaseVec4 {
            return vec4(this.data[1], this.data[0], this.data[0], this.data[3])
        }
        set yxxw(value: BaseVec4) {
            this.data[1] = value.x
            this.data[0] = value.y
            this.data[0] = value.z
            this.data[3] = value.w
        }
        get yxyw(): BaseVec4 {
            return vec4(this.data[1], this.data[0], this.data[1], this.data[3])
        }
        set yxyw(value: BaseVec4) {
            this.data[1] = value.x
            this.data[0] = value.y
            this.data[1] = value.z
            this.data[3] = value.w
        }
        get yxzw(): BaseVec4 {
            return vec4(this.data[1], this.data[0], this.data[2], this.data[3])
        }
        set yxzw(value: BaseVec4) {
            this.data[1] = value.x
            this.data[0] = value.y
            this.data[2] = value.z
            this.data[3] = value.w
        }
        get yyxw(): BaseVec4 {
            return vec4(this.data[1], this.data[1], this.data[0], this.data[3])
        }
        set yyxw(value: BaseVec4) {
            this.data[1] = value.x
            this.data[1] = value.y
            this.data[0] = value.z
            this.data[3] = value.w
        }
        get yyyw(): BaseVec4 {
            return vec4(this.data[1], this.data[1], this.data[1], this.data[3])
        }
        set yyyw(value: BaseVec4) {
            this.data[1] = value.x
            this.data[1] = value.y
            this.data[1] = value.z
            this.data[3] = value.w
        }
        get yyzw(): BaseVec4 {
            return vec4(this.data[1], this.data[1], this.data[2], this.data[3])
        }
        set yyzw(value: BaseVec4) {
            this.data[1] = value.x
            this.data[1] = value.y
            this.data[2] = value.z
            this.data[3] = value.w
        }
        get yzxw(): BaseVec4 {
            return vec4(this.data[1], this.data[2], this.data[0], this.data[3])
        }
        set yzxw(value: BaseVec4) {
            this.data[1] = value.x
            this.data[2] = value.y
            this.data[0] = value.z
            this.data[3] = value.w
        }
        get yzyw(): BaseVec4 {
            return vec4(this.data[1], this.data[2], this.data[1], this.data[3])
        }
        set yzyw(value: BaseVec4) {
            this.data[1] = value.x
            this.data[2] = value.y
            this.data[1] = value.z
            this.data[3] = value.w
        }
        get yzzw(): BaseVec4 {
            return vec4(this.data[1], this.data[2], this.data[2], this.data[3])
        }
        set yzzw(value: BaseVec4) {
            this.data[1] = value.x
            this.data[2] = value.y
            this.data[2] = value.z
            this.data[3] = value.w
        }
        get zxxw(): BaseVec4 {
            return vec4(this.data[2], this.data[0], this.data[0], this.data[3])
        }
        set zxxw(value: BaseVec4) {
            this.data[2] = value.x
            this.data[0] = value.y
            this.data[0] = value.z
            this.data[3] = value.w
        }
        get zxyw(): BaseVec4 {
            return vec4(this.data[2], this.data[0], this.data[1], this.data[3])
        }
        set zxyw(value: BaseVec4) {
            this.data[2] = value.x
            this.data[0] = value.y
            this.data[1] = value.z
            this.data[3] = value.w
        }
        get zxzw(): BaseVec4 {
            return vec4(this.data[2], this.data[0], this.data[2], this.data[3])
        }
        set zxzw(value: BaseVec4) {
            this.data[2] = value.x
            this.data[0] = value.y
            this.data[2] = value.z
            this.data[3] = value.w
        }
        get zyxw(): BaseVec4 {
            return vec4(this.data[2], this.data[1], this.data[0], this.data[3])
        }
        set zyxw(value: BaseVec4) {
            this.data[2] = value.x
            this.data[1] = value.y
            this.data[0] = value.z
            this.data[3] = value.w
        }
        get zyyw(): BaseVec4 {
            return vec4(this.data[2], this.data[1], this.data[1], this.data[3])
        }
        set zyyw(value: BaseVec4) {
            this.data[2] = value.x
            this.data[1] = value.y
            this.data[1] = value.z
            this.data[3] = value.w
        }
        get zyzw(): BaseVec4 {
            return vec4(this.data[2], this.data[1], this.data[2], this.data[3])
        }
        set zyzw(value: BaseVec4) {
            this.data[2] = value.x
            this.data[1] = value.y
            this.data[2] = value.z
            this.data[3] = value.w
        }
        get zzxw(): BaseVec4 {
            return vec4(this.data[2], this.data[2], this.data[0], this.data[3])
        }
        set zzxw(value: BaseVec4) {
            this.data[2] = value.x
            this.data[2] = value.y
            this.data[0] = value.z
            this.data[3] = value.w
        }
        get zzyw(): BaseVec4 {
            return vec4(this.data[2], this.data[2], this.data[1], this.data[3])
        }
        set zzyw(value: BaseVec4) {
            this.data[2] = value.x
            this.data[2] = value.y
            this.data[1] = value.z
            this.data[3] = value.w
        }
        get zzzw(): BaseVec4 {
            return vec4(this.data[2], this.data[2], this.data[2], this.data[3])
        }
        set zzzw(value: BaseVec4) {
            this.data[2] = value.x
            this.data[2] = value.y
            this.data[2] = value.z
            this.data[3] = value.w
        }
    }
}

export class Vec2f extends WithSwizzle2(BaseVec2) {
    static get zero(): Vec2f {
        return new Vec2f(0, 0)
    }
    static get byteLength(): number {
        return 8
    }
    override toString(): string {
        return `[${this.x.toFixed(ToStringPrecision)}, ${this.y.toFixed(ToStringPrecision)}]`
    }
    toStorage(): string {
        return this.x + "," + this.y
    }
    static fromStorage(val: string | null): Vec2f | null {
        if (!val) {
            return null
        }
        const parts = val.split(",")
        if (parts.length != 2) {
            throw new Error(`invalid vec2f: '${val}'`)
        }
        return new Vec2f(parseFloat(parts[0]), parseFloat(parts[1]))
    }
}

export class Vec3f extends WithSwizzle3(BaseVec3) {
    static get UP(): Vec3f {
        return new Vec3f(0, 1, 0)
    }
    static get FWD(): Vec3f {
        return new Vec3f(0, 0, 1)
    }
    static get ZERO(): Vec3f {
        return new Vec3f(0, 0, 0)
    }
    static get byteLength(): number {
        return 12
    }
    /**
     * xyzw converts to homogenous xyzw vector
     */
    get xyzw(): Vec4f {
        return vec4(this.data[0], this.data[1], this.data[2], 1)
    }
    override toString(): string {
        return `[${this.x.toFixed(ToStringPrecision)}, ${this.y.toFixed(ToStringPrecision)}, ${this.z.toFixed(ToStringPrecision)}]`
    }
    toStorage(): string {
        return this.x + "," + this.y + "," + this.z
    }
    static fromStorage(val: string | null): Vec3f | null {
        if (!val) {
            return null
        }
        const parts = val.split(",")
        if (parts.length != 3) {
            throw new Error(`invalid vec3f: '${val}'`)
        }
        return new Vec3f(parseFloat(parts[0]), parseFloat(parts[1]), parseFloat(parts[2]))
    }
}

export class Vec4f extends WithSwizzle4(BaseVec4) {
    static get zero(): Vec4f {
        return new Vec4f(0, 0, 0, 0)
    }
    static get byteLength(): number {
        return 16
    }
    override toString(): string {
        this.data.byteLength
        return `[${this.x.toFixed(ToStringPrecision)}, ${this.y.toFixed(ToStringPrecision)}, ${this.z.toFixed(
            ToStringPrecision
        )}, ${this.w.toFixed(ToStringPrecision)}]`
    }
    toStorage(): string {
        return this.x + "," + this.y + "," + this.z + "," + this.w
    }
    static fromStorage(val: string | null): Vec4f | null {
        if (!val) {
            return null
        }
        const parts = val.split(",")
        if (parts.length != 4) {
            throw new Error(`invalid vec4f: '${val}'`)
        }
        return new Vec4f(parseFloat(parts[0]), parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3]))
    }
}

export function vec2(x: number, y: number): Vec2f {
    return new Vec2f(new Float32Array([x, y]))
}

export function vec3(x: number, y: number, z: number): Vec3f {
    return new Vec3f(new Float32Array([x, y, z]))
}

export function vec4(x: number, y: number, z: number, w: number): Vec4f {
    return new Vec4f(new Float32Array([x, y, z, w]))
}
