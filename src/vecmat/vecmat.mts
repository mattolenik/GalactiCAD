// =========================================
// UTILITY TYPE FOR MIXIN CONSTRUCTORS
// =========================================
type Constructor<T = {}> = new (...args: any[]) => T

// =========================================
// VECTOR CLASSES
// =========================================
// -- Base Vector Classes (immutable style) --

class BaseVec2 {
    public elements: Float32Array
    constructor(x: number, y: number) {
        this.elements = new Float32Array([x, y])
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
        return new (this.constructor as any)(this.x, this.y)
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
        return new (this.constructor as any)(this.x + v.x, this.y + v.y)
    }
    subtract(v: BaseVec2): BaseVec2 {
        return new (this.constructor as any)(this.x - v.x, this.y - v.y)
    }
    multiply<T extends number | BaseVec2>(arg: T): BaseVec2 {
        if (typeof arg === "number") {
            return new (this.constructor as any)(this.x * arg, this.y * arg)
        } else {
            return new (this.constructor as any)(this.x * arg.x, this.y * arg.y)
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
    constructor(x: number, y: number, z: number) {
        this.elements = new Float32Array([x, y, z])
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
        return new (this.constructor as any)(this.x, this.y, this.z)
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
        return new (this.constructor as any)(this.x + v.x, this.y + v.y, this.z + v.z)
    }
    subtract(v: BaseVec3): BaseVec3 {
        return new (this.constructor as any)(this.x - v.x, this.y - v.y, this.z - v.z)
    }
    multiply<T extends number | BaseVec3>(arg: T): BaseVec3 {
        if (typeof arg === "number") {
            return new (this.constructor as any)(this.x * arg, this.y * arg, this.z * arg)
        } else {
            return new (this.constructor as any)(this.x * arg.x, this.y * arg.y, this.z * arg.z)
        }
    }
    dot(v: BaseVec3): number {
        return this.x * v.x + this.y * v.y + this.z * v.z
    }
    cross(v: BaseVec3): BaseVec3 {
        return new (this.constructor as any)(this.y * v.z - this.z * v.y, this.z * v.x - this.x * v.z, this.x * v.y - this.y * v.x)
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
    constructor(x: number, y: number, z: number, w: number) {
        this.elements = new Float32Array([x, y, z, w])
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
        return new (this.constructor as any)(this.x, this.y, this.z, this.w)
    }
    copy(v: BaseVec4): this {
        this.x = v.x
        this.y = v.y
        this.z = v.z
        this.w = v.w
        return this
    }
    set(x: number, y: number, z: number, w: number): this {
        this.x = x
        this.y = y
        this.z = z
        this.w = w
        return this
    }
    equals(v: BaseVec4): boolean {
        return this.x === v.x && this.y === v.y && this.z === v.z && this.w === v.w
    }
    add(v: BaseVec4): BaseVec4 {
        return new (this.constructor as any)(this.x + v.x, this.y + v.y, this.z + v.z, this.w + v.w)
    }
    subtract(v: BaseVec4): BaseVec4 {
        return new (this.constructor as any)(this.x - v.x, this.y - v.y, this.z - v.z, this.w - v.w)
    }
    multiply<T extends number | BaseVec4>(arg: T): BaseVec4 {
        if (typeof arg === "number") {
            return new (this.constructor as any)(this.x * arg, this.y * arg, this.z * arg, this.w * arg)
        } else {
            return new (this.constructor as any)(this.x * arg.x, this.y * arg.y, this.z * arg.z, this.w * arg.w)
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

// -----------------------------------------
// SWIZZLE MIXINS
// -----------------------------------------
// --- Swizzle2: For 2-letter combinations (xx, xy, yx, yy) ---
function Swizzle2<TBase extends Constructor<{ elements: Float32Array }>>(Base: TBase) {
    return class extends Base {
        get xx(): BaseVec2 {
            return new Vec2(this.elements[0], this.elements[0])
        }
        set xx(value: BaseVec2) {
            this.elements[0] = value.x
            this.elements[0] = value.y
        }
        get xy(): BaseVec2 {
            return new Vec2(this.elements[0], this.elements[1])
        }
        set xy(value: BaseVec2) {
            this.elements[0] = value.x
            this.elements[1] = value.y
        }
        get yx(): BaseVec2 {
            return new Vec2(this.elements[1], this.elements[0])
        }
        set yx(value: BaseVec2) {
            this.elements[1] = value.x
            this.elements[0] = value.y
        }
        get yy(): BaseVec2 {
            return new Vec2(this.elements[1], this.elements[1])
        }
        set yy(value: BaseVec2) {
            this.elements[1] = value.x
            this.elements[1] = value.y
        }
    }
}

// --- Swizzle3: Adds explicit 3-letter swizzles for 3D (27 total) ---
function Swizzle3<TBase extends Constructor<{ elements: Float32Array }>>(Base: TBase) {
    return class extends Swizzle2(Base) {
        get xxx(): BaseVec3 {
            return new Vec3(this.elements[0], this.elements[0], this.elements[0])
        }
        set xxx(value: BaseVec3) {
            this.elements[0] = value.x
            this.elements[0] = value.y
            this.elements[0] = value.z
        }
        get xxy(): BaseVec3 {
            return new Vec3(this.elements[0], this.elements[0], this.elements[1])
        }
        set xxy(value: BaseVec3) {
            this.elements[0] = value.x
            this.elements[0] = value.y
            this.elements[1] = value.z
        }
        get xxz(): BaseVec3 {
            return new Vec3(this.elements[0], this.elements[0], this.elements[2])
        }
        set xxz(value: BaseVec3) {
            this.elements[0] = value.x
            this.elements[0] = value.y
            this.elements[2] = value.z
        }
        get xyx(): BaseVec3 {
            return new Vec3(this.elements[0], this.elements[1], this.elements[0])
        }
        set xyx(value: BaseVec3) {
            this.elements[0] = value.x
            this.elements[1] = value.y
            this.elements[0] = value.z
        }
        get xyy(): BaseVec3 {
            return new Vec3(this.elements[0], this.elements[1], this.elements[1])
        }
        set xyy(value: BaseVec3) {
            this.elements[0] = value.x
            this.elements[1] = value.y
            this.elements[1] = value.z
        }
        get xyz(): BaseVec3 {
            return new Vec3(this.elements[0], this.elements[1], this.elements[2])
        }
        set xyz(value: BaseVec3) {
            this.elements[0] = value.x
            this.elements[1] = value.y
            this.elements[2] = value.z
        }
        get xzx(): BaseVec3 {
            return new Vec3(this.elements[0], this.elements[2], this.elements[0])
        }
        set xzx(value: BaseVec3) {
            this.elements[0] = value.x
            this.elements[2] = value.y
            this.elements[0] = value.z
        }
        get xzy(): BaseVec3 {
            return new Vec3(this.elements[0], this.elements[2], this.elements[1])
        }
        set xzy(value: BaseVec3) {
            this.elements[0] = value.x
            this.elements[2] = value.y
            this.elements[1] = value.z
        }
        get xzz(): BaseVec3 {
            return new Vec3(this.elements[0], this.elements[2], this.elements[2])
        }
        set xzz(value: BaseVec3) {
            this.elements[0] = value.x
            this.elements[2] = value.y
            this.elements[2] = value.z
        }

        get yxx(): BaseVec3 {
            return new Vec3(this.elements[1], this.elements[0], this.elements[0])
        }
        set yxx(value: BaseVec3) {
            this.elements[1] = value.x
            this.elements[0] = value.y
            this.elements[0] = value.z
        }
        get yxy(): BaseVec3 {
            return new Vec3(this.elements[1], this.elements[0], this.elements[1])
        }
        set yxy(value: BaseVec3) {
            this.elements[1] = value.x
            this.elements[0] = value.y
            this.elements[1] = value.z
        }
        get yxz(): BaseVec3 {
            return new Vec3(this.elements[1], this.elements[0], this.elements[2])
        }
        set yxz(value: BaseVec3) {
            this.elements[1] = value.x
            this.elements[0] = value.y
            this.elements[2] = value.z
        }
        get yyx(): BaseVec3 {
            return new Vec3(this.elements[1], this.elements[1], this.elements[0])
        }
        set yyx(value: BaseVec3) {
            this.elements[1] = value.x
            this.elements[1] = value.y
            this.elements[0] = value.z
        }
        get yyy(): BaseVec3 {
            return new Vec3(this.elements[1], this.elements[1], this.elements[1])
        }
        set yyy(value: BaseVec3) {
            this.elements[1] = value.x
            this.elements[1] = value.y
            this.elements[1] = value.z
        }
        get yyz(): BaseVec3 {
            return new Vec3(this.elements[1], this.elements[1], this.elements[2])
        }
        set yyz(value: BaseVec3) {
            this.elements[1] = value.x
            this.elements[1] = value.y
            this.elements[2] = value.z
        }
        get yzx(): BaseVec3 {
            return new Vec3(this.elements[1], this.elements[2], this.elements[0])
        }
        set yzx(value: BaseVec3) {
            this.elements[1] = value.x
            this.elements[2] = value.y
            this.elements[0] = value.z
        }
        get yzy(): BaseVec3 {
            return new Vec3(this.elements[1], this.elements[2], this.elements[1])
        }
        set yzy(value: BaseVec3) {
            this.elements[1] = value.x
            this.elements[2] = value.y
            this.elements[1] = value.z
        }
        get yzz(): BaseVec3 {
            return new Vec3(this.elements[1], this.elements[2], this.elements[2])
        }
        set yzz(value: BaseVec3) {
            this.elements[1] = value.x
            this.elements[2] = value.y
            this.elements[2] = value.z
        }

        get zxx(): BaseVec3 {
            return new Vec3(this.elements[2], this.elements[0], this.elements[0])
        }
        set zxx(value: BaseVec3) {
            this.elements[2] = value.x
            this.elements[0] = value.y
            this.elements[0] = value.z
        }
        get zxy(): BaseVec3 {
            return new Vec3(this.elements[2], this.elements[0], this.elements[1])
        }
        set zxy(value: BaseVec3) {
            this.elements[2] = value.x
            this.elements[0] = value.y
            this.elements[1] = value.z
        }
        get zxz(): BaseVec3 {
            return new Vec3(this.elements[2], this.elements[0], this.elements[2])
        }
        set zxz(value: BaseVec3) {
            this.elements[2] = value.x
            this.elements[0] = value.y
            this.elements[2] = value.z
        }
        get zyx(): BaseVec3 {
            return new Vec3(this.elements[2], this.elements[1], this.elements[0])
        }
        set zyx(value: BaseVec3) {
            this.elements[2] = value.x
            this.elements[1] = value.y
            this.elements[0] = value.z
        }
        get zyy(): BaseVec3 {
            return new Vec3(this.elements[2], this.elements[1], this.elements[1])
        }
        set zyy(value: BaseVec3) {
            this.elements[2] = value.x
            this.elements[1] = value.y
            this.elements[1] = value.z
        }
        get zyz(): BaseVec3 {
            return new Vec3(this.elements[2], this.elements[1], this.elements[2])
        }
        set zyz(value: BaseVec3) {
            this.elements[2] = value.x
            this.elements[1] = value.y
            this.elements[2] = value.z
        }
        get zzx(): BaseVec3 {
            return new Vec3(this.elements[2], this.elements[2], this.elements[0])
        }
        set zzx(value: BaseVec3) {
            this.elements[2] = value.x
            this.elements[2] = value.y
            this.elements[0] = value.z
        }
        get zzy(): BaseVec3 {
            return new Vec3(this.elements[2], this.elements[2], this.elements[1])
        }
        set zzy(value: BaseVec3) {
            this.elements[2] = value.x
            this.elements[2] = value.y
            this.elements[1] = value.z
        }
        get zzz(): BaseVec3 {
            return new Vec3(this.elements[2], this.elements[2], this.elements[2])
        }
        set zzz(value: BaseVec3) {
            this.elements[2] = value.x
            this.elements[2] = value.y
            this.elements[2] = value.z
        }
    }
}

// --- Swizzle4WithQ: For homogeneous 4D swizzles ---
// Instead of 81 combinations, we provide 27 properties.
// Each property is exactly the same as one of the 27 3‑letter swizzles
// but with a trailing "q" that always maps to index 3.
function Swizzle4WithQ<TBase extends Constructor<{ elements: Float32Array }>>(Base: TBase) {
    return class extends Base {
        get xxxq(): BaseVec4 {
            return new Vec4(this.elements[0], this.elements[0], this.elements[0], this.elements[3])
        }
        set xxxq(value: BaseVec4) {
            this.elements[0] = value.x
            this.elements[0] = value.y
            this.elements[0] = value.z
            this.elements[3] = value.w
        }
        get xxyq(): BaseVec4 {
            return new Vec4(this.elements[0], this.elements[0], this.elements[1], this.elements[3])
        }
        set xxyq(value: BaseVec4) {
            this.elements[0] = value.x
            this.elements[0] = value.y
            this.elements[1] = value.z
            this.elements[3] = value.w
        }
        get xxzq(): BaseVec4 {
            return new Vec4(this.elements[0], this.elements[0], this.elements[2], this.elements[3])
        }
        set xxzq(value: BaseVec4) {
            this.elements[0] = value.x
            this.elements[0] = value.y
            this.elements[2] = value.z
            this.elements[3] = value.w
        }
        get xyxq(): BaseVec4 {
            return new Vec4(this.elements[0], this.elements[1], this.elements[0], this.elements[3])
        }
        set xyxq(value: BaseVec4) {
            this.elements[0] = value.x
            this.elements[1] = value.y
            this.elements[0] = value.z
            this.elements[3] = value.w
        }
        get xyyq(): BaseVec4 {
            return new Vec4(this.elements[0], this.elements[1], this.elements[1], this.elements[3])
        }
        set xyyq(value: BaseVec4) {
            this.elements[0] = value.x
            this.elements[1] = value.y
            this.elements[1] = value.z
            this.elements[3] = value.w
        }
        get xyzq(): BaseVec4 {
            return new Vec4(this.elements[0], this.elements[1], this.elements[2], this.elements[3])
        }
        set xyzq(value: BaseVec4) {
            this.elements[0] = value.x
            this.elements[1] = value.y
            this.elements[2] = value.z
            this.elements[3] = value.w
        }
        get xzxq(): BaseVec4 {
            return new Vec4(this.elements[0], this.elements[2], this.elements[0], this.elements[3])
        }
        set xzxq(value: BaseVec4) {
            this.elements[0] = value.x
            this.elements[2] = value.y
            this.elements[0] = value.z
            this.elements[3] = value.w
        }
        get xzyq(): BaseVec4 {
            return new Vec4(this.elements[0], this.elements[2], this.elements[1], this.elements[3])
        }
        set xzyq(value: BaseVec4) {
            this.elements[0] = value.x
            this.elements[2] = value.y
            this.elements[1] = value.z
            this.elements[3] = value.w
        }
        get xzzq(): BaseVec4 {
            return new Vec4(this.elements[0], this.elements[2], this.elements[2], this.elements[3])
        }
        set xzzq(value: BaseVec4) {
            this.elements[0] = value.x
            this.elements[2] = value.y
            this.elements[2] = value.z
            this.elements[3] = value.w
        }
        get yxxq(): BaseVec4 {
            return new Vec4(this.elements[1], this.elements[0], this.elements[0], this.elements[3])
        }
        set yxxq(value: BaseVec4) {
            this.elements[1] = value.x
            this.elements[0] = value.y
            this.elements[0] = value.z
            this.elements[3] = value.w
        }
        get yxyq(): BaseVec4 {
            return new Vec4(this.elements[1], this.elements[0], this.elements[1], this.elements[3])
        }
        set yxyq(value: BaseVec4) {
            this.elements[1] = value.x
            this.elements[0] = value.y
            this.elements[1] = value.z
            this.elements[3] = value.w
        }
        get yxzq(): BaseVec4 {
            return new Vec4(this.elements[1], this.elements[0], this.elements[2], this.elements[3])
        }
        set yxzq(value: BaseVec4) {
            this.elements[1] = value.x
            this.elements[0] = value.y
            this.elements[2] = value.z
            this.elements[3] = value.w
        }
        get yyxq(): BaseVec4 {
            return new Vec4(this.elements[1], this.elements[1], this.elements[0], this.elements[3])
        }
        set yyxq(value: BaseVec4) {
            this.elements[1] = value.x
            this.elements[1] = value.y
            this.elements[0] = value.z
            this.elements[3] = value.w
        }
        get yyyq(): BaseVec4 {
            return new Vec4(this.elements[1], this.elements[1], this.elements[1], this.elements[3])
        }
        set yyyq(value: BaseVec4) {
            this.elements[1] = value.x
            this.elements[1] = value.y
            this.elements[1] = value.z
            this.elements[3] = value.w
        }
        get yyzq(): BaseVec4 {
            return new Vec4(this.elements[1], this.elements[1], this.elements[2], this.elements[3])
        }
        set yyzq(value: BaseVec4) {
            this.elements[1] = value.x
            this.elements[1] = value.y
            this.elements[2] = value.z
            this.elements[3] = value.w
        }
        get yzxq(): BaseVec4 {
            return new Vec4(this.elements[1], this.elements[2], this.elements[0], this.elements[3])
        }
        set yzxq(value: BaseVec4) {
            this.elements[1] = value.x
            this.elements[2] = value.y
            this.elements[0] = value.z
            this.elements[3] = value.w
        }
        get yzyq(): BaseVec4 {
            return new Vec4(this.elements[1], this.elements[2], this.elements[1], this.elements[3])
        }
        set yzyq(value: BaseVec4) {
            this.elements[1] = value.x
            this.elements[2] = value.y
            this.elements[1] = value.z
            this.elements[3] = value.w
        }
        get yzzq(): BaseVec4 {
            return new Vec4(this.elements[1], this.elements[2], this.elements[2], this.elements[3])
        }
        set yzzq(value: BaseVec4) {
            this.elements[1] = value.x
            this.elements[2] = value.y
            this.elements[2] = value.z
            this.elements[3] = value.w
        }
        get zxxq(): BaseVec4 {
            return new Vec4(this.elements[2], this.elements[0], this.elements[0], this.elements[3])
        }
        set zxxq(value: BaseVec4) {
            this.elements[2] = value.x
            this.elements[0] = value.y
            this.elements[0] = value.z
            this.elements[3] = value.w
        }
        get zxyq(): BaseVec4 {
            return new Vec4(this.elements[2], this.elements[0], this.elements[1], this.elements[3])
        }
        set zxyq(value: BaseVec4) {
            this.elements[2] = value.x
            this.elements[0] = value.y
            this.elements[1] = value.z
            this.elements[3] = value.w
        }
        get zxzq(): BaseVec4 {
            return new Vec4(this.elements[2], this.elements[0], this.elements[2], this.elements[3])
        }
        set zxzq(value: BaseVec4) {
            this.elements[2] = value.x
            this.elements[0] = value.y
            this.elements[2] = value.z
            this.elements[3] = value.w
        }
        get zyxq(): BaseVec4 {
            return new Vec4(this.elements[2], this.elements[1], this.elements[0], this.elements[3])
        }
        set zyxq(value: BaseVec4) {
            this.elements[2] = value.x
            this.elements[1] = value.y
            this.elements[0] = value.z
            this.elements[3] = value.w
        }
        get zyyq(): BaseVec4 {
            return new Vec4(this.elements[2], this.elements[1], this.elements[1], this.elements[3])
        }
        set zyyq(value: BaseVec4) {
            this.elements[2] = value.x
            this.elements[1] = value.y
            this.elements[1] = value.z
            this.elements[3] = value.w
        }
        get zyzq(): BaseVec4 {
            return new Vec4(this.elements[2], this.elements[1], this.elements[2], this.elements[3])
        }
        set zyzq(value: BaseVec4) {
            this.elements[2] = value.x
            this.elements[1] = value.y
            this.elements[2] = value.z
            this.elements[3] = value.w
        }
        get zzxq(): BaseVec4 {
            return new Vec4(this.elements[2], this.elements[2], this.elements[0], this.elements[3])
        }
        set zzxq(value: BaseVec4) {
            this.elements[2] = value.x
            this.elements[2] = value.y
            this.elements[0] = value.z
            this.elements[3] = value.w
        }
        get zzyq(): BaseVec4 {
            return new Vec4(this.elements[2], this.elements[2], this.elements[1], this.elements[3])
        }
        set zzyq(value: BaseVec4) {
            this.elements[2] = value.x
            this.elements[2] = value.y
            this.elements[1] = value.z
            this.elements[3] = value.w
        }
        get zzzq(): BaseVec4 {
            return new Vec4(this.elements[2], this.elements[2], this.elements[2], this.elements[3])
        }
        set zzzq(value: BaseVec4) {
            this.elements[2] = value.x
            this.elements[2] = value.y
            this.elements[2] = value.z
            this.elements[3] = value.w
        }
    }
}

// -----------------------------------------
// FINAL VECTOR CLASSES
// -----------------------------------------
const Vec2WithSwizzle = Swizzle2(BaseVec2)
export class Vec2 extends Vec2WithSwizzle {
    // Additional Vec2 methods can be added here.
}

const Vec3WithSwizzle = Swizzle3(BaseVec3)
export class Vec3 extends Vec3WithSwizzle {
    // Additional Vec3 methods (e.g. cross) can be added here.
}

const Vec4WithSwizzleQ = Swizzle4WithQ(BaseVec4)
export class Vec4 extends Vec4WithSwizzleQ {
    // Additional Vec4 methods can be added here.
}

// =========================================
// MATRIX CLASSES
// =========================================

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
        return new Vec2(a * v.x + c * v.y, b * v.x + d * v.y)
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
        return new Vec3(m[0] * v.x + m[3] * v.y + m[6] * v.z, m[1] * v.x + m[4] * v.y + m[7] * v.z, m[2] * v.x + m[5] * v.y + m[8] * v.z)
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
        return new Vec4(
            m[0] * v.x + m[4] * v.y + m[8] * v.z + m[12] * v.w,
            m[1] * v.x + m[5] * v.y + m[9] * v.z + m[13] * v.w,
            m[2] * v.x + m[6] * v.y + m[10] * v.z + m[14] * v.w,
            m[3] * v.x + m[7] * v.y + m[11] * v.z + m[15] * v.w
        )
    }
    // Transform a 3D point (assumes w = 1 and then does perspective divide).
    transformPoint(v: Vec3): Vec3 {
        const result = this.transform(new Vec4(v.x, v.y, v.z, 1))
        return new Vec3(result.x / result.w, result.y / result.w, result.z / result.w)
    }
    // Transform a 3D vector (assumes w = 0).
    transformVector(v: Vec3): Vec3 {
        const result = this.transform(new Vec4(v.x, v.y, v.z, 0))
        return new Vec3(result.x, result.y, result.z)
    }
}
