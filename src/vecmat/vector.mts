type Constructor<T = {}> = new (...args: any[]) => T

class BaseVec2 {
    public elements: Float32Array

    constructor(x: Float32Array | [number, number] | number, y?: number) {
        if (typeof x === "number") {
            if (y === undefined) {
                throw new Error("invalid vector size, must be 2")
            }
            this.elements = new Float32Array([x, y])
        } else {
            if (x.length != 2) {
                throw new Error("invalid vector size, must be 2")
            }
            this.elements = x instanceof Float32Array ? x : new Float32Array(x)
        }
    }
    get x(): number {
        return this.elements[0]
    }
    set x(val: number) {
        this.elements[0] = val
    }
    get y(): number {
        return this.elements[1]
    }
    set y(val: number) {
        this.elements[1] = val
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
    public elements: Float32Array

    constructor(x: Float32Array | [number, number, number] | number, y?: number, z?: number) {
        if (typeof x === "number") {
            if (y === undefined || z === undefined) {
                throw new Error("invalid vector size, must be 3")
            }
            this.elements = new Float32Array([x, y, z])
        } else {
            if (x.length != 3) {
                throw new Error("invalid vector size, must be 3")
            }
            this.elements = x instanceof Float32Array ? x : new Float32Array(x)
        }
    }
    get x(): number {
        return this.elements[0]
    }
    set x(val: number) {
        this.elements[0] = val
    }
    get y(): number {
        return this.elements[1]
    }
    set y(val: number) {
        this.elements[1] = val
    }
    get z(): number {
        return this.elements[2]
    }
    set z(val: number) {
        this.elements[2] = val
    }

    clone(): BaseVec3 {
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
    add(v: BaseVec3): BaseVec3 {
        return vec3(this.x + v.x, this.y + v.y, this.z + v.z)
    }
    subtract(v: BaseVec3): BaseVec3 {
        return vec3(this.x - v.x, this.y - v.y, this.z - v.z)
    }
    multiply<T extends number | BaseVec3>(arg: T): BaseVec3 {
        if (typeof arg === "number") {
            return vec3(this.x * arg, this.y * arg, this.z * arg)
        } else {
            return vec3(this.x * arg.x, this.y * arg.y, this.z * arg.z)
        }
    }
    dot(v: BaseVec3): number {
        return this.x * v.x + this.y * v.y + this.z * v.z
    }
    cross(v: BaseVec3): BaseVec3 {
        return vec3(this.y * v.z - this.z * v.y, this.z * v.x - this.x * v.z, this.x * v.y - this.y * v.x)
    }
    length(): number {
        return Math.sqrt(this.dot(this))
    }
    normalize(): BaseVec3 {
        const len = this.length()
        return len === 0 ? this.clone() : this.multiply(1 / len)
    }
}

class BaseVec4 {
    public elements: Float32Array
    constructor(x: Float32Array | [number, number, number, number] | number, y?: number, z?: number, w?: number) {
        if (typeof x === "number") {
            if (y === undefined || z === undefined || w === undefined) {
                throw new Error("invalid vector size, must be 4")
            }
            this.elements = new Float32Array([x, y, z, w])
        } else {
            if (x.length != 4) {
                throw new Error("invalid vector size, must be 4")
            }
            this.elements = x instanceof Float32Array ? x : new Float32Array(x)
        }
    }
    get x(): number {
        return this.elements[0]
    }
    set x(val: number) {
        this.elements[0] = val
    }
    get y(): number {
        return this.elements[1]
    }
    set y(val: number) {
        this.elements[1] = val
    }
    get z(): number {
        return this.elements[2]
    }
    set z(val: number) {
        this.elements[2] = val
    }
    get w(): number {
        return this.elements[3]
    }
    set w(val: number) {
        this.elements[3] = val
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

function WithSwizzle2<TBase extends Constructor<{ elements: Float32Array }>>(Base: TBase) {
    return class extends Base {
        get xx(): BaseVec2 {
            return vec2(this.elements[0], this.elements[0])
        }
        set xx(value: BaseVec2) {
            this.elements[0] = value.x
            this.elements[0] = value.y
        }
        get xy(): BaseVec2 {
            return vec2(this.elements[0], this.elements[1])
        }
        set xy(value: BaseVec2) {
            this.elements[0] = value.x
            this.elements[1] = value.y
        }
        get yx(): BaseVec2 {
            return vec2(this.elements[1], this.elements[0])
        }
        set yx(value: BaseVec2) {
            this.elements[1] = value.x
            this.elements[0] = value.y
        }
        get yy(): BaseVec2 {
            return vec2(this.elements[1], this.elements[1])
        }
        set yy(value: BaseVec2) {
            this.elements[1] = value.x
            this.elements[1] = value.y
        }
    }
}

function WithSwizzle3<TBase extends Constructor<{ elements: Float32Array }>>(Base: TBase) {
    return class extends WithSwizzle2(Base) {
        get xxx(): BaseVec3 {
            return vec3(this.elements[0], this.elements[0], this.elements[0])
        }
        set xxx(value: BaseVec3) {
            this.elements[0] = value.x
            this.elements[0] = value.y
            this.elements[0] = value.z
        }
        get xxy(): BaseVec3 {
            return vec3(this.elements[0], this.elements[0], this.elements[1])
        }
        set xxy(value: BaseVec3) {
            this.elements[0] = value.x
            this.elements[0] = value.y
            this.elements[1] = value.z
        }
        get xxz(): BaseVec3 {
            return vec3(this.elements[0], this.elements[0], this.elements[2])
        }
        set xxz(value: BaseVec3) {
            this.elements[0] = value.x
            this.elements[0] = value.y
            this.elements[2] = value.z
        }
        get xyx(): BaseVec3 {
            return vec3(this.elements[0], this.elements[1], this.elements[0])
        }
        set xyx(value: BaseVec3) {
            this.elements[0] = value.x
            this.elements[1] = value.y
            this.elements[0] = value.z
        }
        get xyy(): BaseVec3 {
            return vec3(this.elements[0], this.elements[1], this.elements[1])
        }
        set xyy(value: BaseVec3) {
            this.elements[0] = value.x
            this.elements[1] = value.y
            this.elements[1] = value.z
        }
        get xyz(): BaseVec3 {
            return vec3(this.elements[0], this.elements[1], this.elements[2])
        }
        set xyz(value: BaseVec3) {
            this.elements[0] = value.x
            this.elements[1] = value.y
            this.elements[2] = value.z
        }
        get xzx(): BaseVec3 {
            return vec3(this.elements[0], this.elements[2], this.elements[0])
        }
        set xzx(value: BaseVec3) {
            this.elements[0] = value.x
            this.elements[2] = value.y
            this.elements[0] = value.z
        }
        get xzy(): BaseVec3 {
            return vec3(this.elements[0], this.elements[2], this.elements[1])
        }
        set xzy(value: BaseVec3) {
            this.elements[0] = value.x
            this.elements[2] = value.y
            this.elements[1] = value.z
        }
        get xzz(): BaseVec3 {
            return vec3(this.elements[0], this.elements[2], this.elements[2])
        }
        set xzz(value: BaseVec3) {
            this.elements[0] = value.x
            this.elements[2] = value.y
            this.elements[2] = value.z
        }

        get yxx(): BaseVec3 {
            return vec3(this.elements[1], this.elements[0], this.elements[0])
        }
        set yxx(value: BaseVec3) {
            this.elements[1] = value.x
            this.elements[0] = value.y
            this.elements[0] = value.z
        }
        get yxy(): BaseVec3 {
            return vec3(this.elements[1], this.elements[0], this.elements[1])
        }
        set yxy(value: BaseVec3) {
            this.elements[1] = value.x
            this.elements[0] = value.y
            this.elements[1] = value.z
        }
        get yxz(): BaseVec3 {
            return vec3(this.elements[1], this.elements[0], this.elements[2])
        }
        set yxz(value: BaseVec3) {
            this.elements[1] = value.x
            this.elements[0] = value.y
            this.elements[2] = value.z
        }
        get yyx(): BaseVec3 {
            return vec3(this.elements[1], this.elements[1], this.elements[0])
        }
        set yyx(value: BaseVec3) {
            this.elements[1] = value.x
            this.elements[1] = value.y
            this.elements[0] = value.z
        }
        get yyy(): BaseVec3 {
            return vec3(this.elements[1], this.elements[1], this.elements[1])
        }
        set yyy(value: BaseVec3) {
            this.elements[1] = value.x
            this.elements[1] = value.y
            this.elements[1] = value.z
        }
        get yyz(): BaseVec3 {
            return vec3(this.elements[1], this.elements[1], this.elements[2])
        }
        set yyz(value: BaseVec3) {
            this.elements[1] = value.x
            this.elements[1] = value.y
            this.elements[2] = value.z
        }
        get yzx(): BaseVec3 {
            return vec3(this.elements[1], this.elements[2], this.elements[0])
        }
        set yzx(value: BaseVec3) {
            this.elements[1] = value.x
            this.elements[2] = value.y
            this.elements[0] = value.z
        }
        get yzy(): BaseVec3 {
            return vec3(this.elements[1], this.elements[2], this.elements[1])
        }
        set yzy(value: BaseVec3) {
            this.elements[1] = value.x
            this.elements[2] = value.y
            this.elements[1] = value.z
        }
        get yzz(): BaseVec3 {
            return vec3(this.elements[1], this.elements[2], this.elements[2])
        }
        set yzz(value: BaseVec3) {
            this.elements[1] = value.x
            this.elements[2] = value.y
            this.elements[2] = value.z
        }

        get zxx(): BaseVec3 {
            return vec3(this.elements[2], this.elements[0], this.elements[0])
        }
        set zxx(value: BaseVec3) {
            this.elements[2] = value.x
            this.elements[0] = value.y
            this.elements[0] = value.z
        }
        get zxy(): BaseVec3 {
            return vec3(this.elements[2], this.elements[0], this.elements[1])
        }
        set zxy(value: BaseVec3) {
            this.elements[2] = value.x
            this.elements[0] = value.y
            this.elements[1] = value.z
        }
        get zxz(): BaseVec3 {
            return vec3(this.elements[2], this.elements[0], this.elements[2])
        }
        set zxz(value: BaseVec3) {
            this.elements[2] = value.x
            this.elements[0] = value.y
            this.elements[2] = value.z
        }
        get zyx(): BaseVec3 {
            return vec3(this.elements[2], this.elements[1], this.elements[0])
        }
        set zyx(value: BaseVec3) {
            this.elements[2] = value.x
            this.elements[1] = value.y
            this.elements[0] = value.z
        }
        get zyy(): BaseVec3 {
            return vec3(this.elements[2], this.elements[1], this.elements[1])
        }
        set zyy(value: BaseVec3) {
            this.elements[2] = value.x
            this.elements[1] = value.y
            this.elements[1] = value.z
        }
        get zyz(): BaseVec3 {
            return vec3(this.elements[2], this.elements[1], this.elements[2])
        }
        set zyz(value: BaseVec3) {
            this.elements[2] = value.x
            this.elements[1] = value.y
            this.elements[2] = value.z
        }
        get zzx(): BaseVec3 {
            return vec3(this.elements[2], this.elements[2], this.elements[0])
        }
        set zzx(value: BaseVec3) {
            this.elements[2] = value.x
            this.elements[2] = value.y
            this.elements[0] = value.z
        }
        get zzy(): BaseVec3 {
            return vec3(this.elements[2], this.elements[2], this.elements[1])
        }
        set zzy(value: BaseVec3) {
            this.elements[2] = value.x
            this.elements[2] = value.y
            this.elements[1] = value.z
        }
        get zzz(): BaseVec3 {
            return vec3(this.elements[2], this.elements[2], this.elements[2])
        }
        set zzz(value: BaseVec3) {
            this.elements[2] = value.x
            this.elements[2] = value.y
            this.elements[2] = value.z
        }
    }
}

function WithSwizzle4<TBase extends Constructor<{ elements: Float32Array }>>(Base: TBase) {
    return class extends Base {
        get xxxq(): BaseVec4 {
            return vec4(this.elements[0], this.elements[0], this.elements[0], this.elements[3])
        }
        set xxxq(value: BaseVec4) {
            this.elements[0] = value.x
            this.elements[0] = value.y
            this.elements[0] = value.z
            this.elements[3] = value.w
        }
        get xxyq(): BaseVec4 {
            return vec4(this.elements[0], this.elements[0], this.elements[1], this.elements[3])
        }
        set xxyq(value: BaseVec4) {
            this.elements[0] = value.x
            this.elements[0] = value.y
            this.elements[1] = value.z
            this.elements[3] = value.w
        }
        get xxzq(): BaseVec4 {
            return vec4(this.elements[0], this.elements[0], this.elements[2], this.elements[3])
        }
        set xxzq(value: BaseVec4) {
            this.elements[0] = value.x
            this.elements[0] = value.y
            this.elements[2] = value.z
            this.elements[3] = value.w
        }
        get xyxq(): BaseVec4 {
            return vec4(this.elements[0], this.elements[1], this.elements[0], this.elements[3])
        }
        set xyxq(value: BaseVec4) {
            this.elements[0] = value.x
            this.elements[1] = value.y
            this.elements[0] = value.z
            this.elements[3] = value.w
        }
        get xyyq(): BaseVec4 {
            return vec4(this.elements[0], this.elements[1], this.elements[1], this.elements[3])
        }
        set xyyq(value: BaseVec4) {
            this.elements[0] = value.x
            this.elements[1] = value.y
            this.elements[1] = value.z
            this.elements[3] = value.w
        }
        get xyzq(): BaseVec4 {
            return vec4(this.elements[0], this.elements[1], this.elements[2], this.elements[3])
        }
        set xyzq(value: BaseVec4) {
            this.elements[0] = value.x
            this.elements[1] = value.y
            this.elements[2] = value.z
            this.elements[3] = value.w
        }
        get xzxq(): BaseVec4 {
            return vec4(this.elements[0], this.elements[2], this.elements[0], this.elements[3])
        }
        set xzxq(value: BaseVec4) {
            this.elements[0] = value.x
            this.elements[2] = value.y
            this.elements[0] = value.z
            this.elements[3] = value.w
        }
        get xzyq(): BaseVec4 {
            return vec4(this.elements[0], this.elements[2], this.elements[1], this.elements[3])
        }
        set xzyq(value: BaseVec4) {
            this.elements[0] = value.x
            this.elements[2] = value.y
            this.elements[1] = value.z
            this.elements[3] = value.w
        }
        get xzzq(): BaseVec4 {
            return vec4(this.elements[0], this.elements[2], this.elements[2], this.elements[3])
        }
        set xzzq(value: BaseVec4) {
            this.elements[0] = value.x
            this.elements[2] = value.y
            this.elements[2] = value.z
            this.elements[3] = value.w
        }
        get yxxq(): BaseVec4 {
            return vec4(this.elements[1], this.elements[0], this.elements[0], this.elements[3])
        }
        set yxxq(value: BaseVec4) {
            this.elements[1] = value.x
            this.elements[0] = value.y
            this.elements[0] = value.z
            this.elements[3] = value.w
        }
        get yxyq(): BaseVec4 {
            return vec4(this.elements[1], this.elements[0], this.elements[1], this.elements[3])
        }
        set yxyq(value: BaseVec4) {
            this.elements[1] = value.x
            this.elements[0] = value.y
            this.elements[1] = value.z
            this.elements[3] = value.w
        }
        get yxzq(): BaseVec4 {
            return vec4(this.elements[1], this.elements[0], this.elements[2], this.elements[3])
        }
        set yxzq(value: BaseVec4) {
            this.elements[1] = value.x
            this.elements[0] = value.y
            this.elements[2] = value.z
            this.elements[3] = value.w
        }
        get yyxq(): BaseVec4 {
            return vec4(this.elements[1], this.elements[1], this.elements[0], this.elements[3])
        }
        set yyxq(value: BaseVec4) {
            this.elements[1] = value.x
            this.elements[1] = value.y
            this.elements[0] = value.z
            this.elements[3] = value.w
        }
        get yyyq(): BaseVec4 {
            return vec4(this.elements[1], this.elements[1], this.elements[1], this.elements[3])
        }
        set yyyq(value: BaseVec4) {
            this.elements[1] = value.x
            this.elements[1] = value.y
            this.elements[1] = value.z
            this.elements[3] = value.w
        }
        get yyzq(): BaseVec4 {
            return vec4(this.elements[1], this.elements[1], this.elements[2], this.elements[3])
        }
        set yyzq(value: BaseVec4) {
            this.elements[1] = value.x
            this.elements[1] = value.y
            this.elements[2] = value.z
            this.elements[3] = value.w
        }
        get yzxq(): BaseVec4 {
            return vec4(this.elements[1], this.elements[2], this.elements[0], this.elements[3])
        }
        set yzxq(value: BaseVec4) {
            this.elements[1] = value.x
            this.elements[2] = value.y
            this.elements[0] = value.z
            this.elements[3] = value.w
        }
        get yzyq(): BaseVec4 {
            return vec4(this.elements[1], this.elements[2], this.elements[1], this.elements[3])
        }
        set yzyq(value: BaseVec4) {
            this.elements[1] = value.x
            this.elements[2] = value.y
            this.elements[1] = value.z
            this.elements[3] = value.w
        }
        get yzzq(): BaseVec4 {
            return vec4(this.elements[1], this.elements[2], this.elements[2], this.elements[3])
        }
        set yzzq(value: BaseVec4) {
            this.elements[1] = value.x
            this.elements[2] = value.y
            this.elements[2] = value.z
            this.elements[3] = value.w
        }
        get zxxq(): BaseVec4 {
            return vec4(this.elements[2], this.elements[0], this.elements[0], this.elements[3])
        }
        set zxxq(value: BaseVec4) {
            this.elements[2] = value.x
            this.elements[0] = value.y
            this.elements[0] = value.z
            this.elements[3] = value.w
        }
        get zxyq(): BaseVec4 {
            return vec4(this.elements[2], this.elements[0], this.elements[1], this.elements[3])
        }
        set zxyq(value: BaseVec4) {
            this.elements[2] = value.x
            this.elements[0] = value.y
            this.elements[1] = value.z
            this.elements[3] = value.w
        }
        get zxzq(): BaseVec4 {
            return vec4(this.elements[2], this.elements[0], this.elements[2], this.elements[3])
        }
        set zxzq(value: BaseVec4) {
            this.elements[2] = value.x
            this.elements[0] = value.y
            this.elements[2] = value.z
            this.elements[3] = value.w
        }
        get zyxq(): BaseVec4 {
            return vec4(this.elements[2], this.elements[1], this.elements[0], this.elements[3])
        }
        set zyxq(value: BaseVec4) {
            this.elements[2] = value.x
            this.elements[1] = value.y
            this.elements[0] = value.z
            this.elements[3] = value.w
        }
        get zyyq(): BaseVec4 {
            return vec4(this.elements[2], this.elements[1], this.elements[1], this.elements[3])
        }
        set zyyq(value: BaseVec4) {
            this.elements[2] = value.x
            this.elements[1] = value.y
            this.elements[1] = value.z
            this.elements[3] = value.w
        }
        get zyzq(): BaseVec4 {
            return vec4(this.elements[2], this.elements[1], this.elements[2], this.elements[3])
        }
        set zyzq(value: BaseVec4) {
            this.elements[2] = value.x
            this.elements[1] = value.y
            this.elements[2] = value.z
            this.elements[3] = value.w
        }
        get zzxq(): BaseVec4 {
            return vec4(this.elements[2], this.elements[2], this.elements[0], this.elements[3])
        }
        set zzxq(value: BaseVec4) {
            this.elements[2] = value.x
            this.elements[2] = value.y
            this.elements[0] = value.z
            this.elements[3] = value.w
        }
        get zzyq(): BaseVec4 {
            return vec4(this.elements[2], this.elements[2], this.elements[1], this.elements[3])
        }
        set zzyq(value: BaseVec4) {
            this.elements[2] = value.x
            this.elements[2] = value.y
            this.elements[1] = value.z
            this.elements[3] = value.w
        }
        get zzzq(): BaseVec4 {
            return vec4(this.elements[2], this.elements[2], this.elements[2], this.elements[3])
        }
        set zzzq(value: BaseVec4) {
            this.elements[2] = value.x
            this.elements[2] = value.y
            this.elements[2] = value.z
            this.elements[3] = value.w
        }
    }
}

export class Vec2 extends WithSwizzle2(BaseVec2) {}

export class Vec3 extends WithSwizzle3(BaseVec3) {
    /**
     * xyzw converts to homogenous xyzw vector
     */
    get xyzw(): Vec4 {
        return vec4(this.elements[0], this.elements[1], this.elements[2], 1)
    }
}

export class Vec4 extends WithSwizzle4(BaseVec4) {}

export function vec2(x: number, y: number): Vec2 {
    return new Vec2(new Float32Array([x, y]))
}

export function vec3(x: number, y: number, z: number): Vec3 {
    return new Vec3(new Float32Array([x, y, z]))
}

export function vec4(x: number, y: number, z: number, w: number): Vec4 {
    return new Vec4(new Float32Array([x, y, z, w]))
}
