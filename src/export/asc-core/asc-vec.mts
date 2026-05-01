export function vcopy(a: ArrayLike<number>, o: number, dst: Float32Array | number[], d: number): void {
    dst[d] = a[o]!
    dst[d + 1] = a[o + 1]!
    dst[d + 2] = a[o + 2]!
}

export function vsub(
    a: ArrayLike<number>,
    oa: number,
    b: ArrayLike<number>,
    ob: number,
    dst: Float32Array | number[],
    d: number,
): void {
    dst[d] = a[oa]! - b[ob]!
    dst[d + 1] = a[oa + 1]! - b[ob + 1]!
    dst[d + 2] = a[oa + 2]! - b[ob + 2]!
}

export function vadd(
    a: ArrayLike<number>,
    oa: number,
    b: ArrayLike<number>,
    ob: number,
    dst: Float32Array | number[],
    d: number,
): void {
    dst[d] = a[oa]! + b[ob]!
    dst[d + 1] = a[oa + 1]! + b[ob + 1]!
    dst[d + 2] = a[oa + 2]! + b[ob + 2]!
}

export function vscale(dst: Float32Array | number[], d: number, s: number): void {
    dst[d] *= s
    dst[d + 1] *= s
    dst[d + 2] *= s
}

export function vcross(
    a: ArrayLike<number>,
    oa: number,
    b: ArrayLike<number>,
    ob: number,
    dst: Float32Array | number[],
    d: number,
): void {
    const x = a[oa + 1]! * b[ob + 2]! - a[oa + 2]! * b[ob + 1]!
    const y = a[oa + 2]! * b[ob + 0]! - a[oa + 0]! * b[ob + 2]!
    const z = a[oa + 0]! * b[ob + 1]! - a[oa + 1]! * b[ob + 0]!
    dst[d] = x
    dst[d + 1] = y
    dst[d + 2] = z
}

export function vdot(a: ArrayLike<number>, oa: number, b: ArrayLike<number>, ob: number): number {
    return a[oa]! * b[ob]! + a[oa + 1]! * b[ob + 1]! + a[oa + 2]! * b[ob + 2]!
}

export function vlength(a: ArrayLike<number>, o: number): number {
    return Math.hypot(a[o]!, a[o + 1]!, a[o + 2]!)
}

export function vnormal(a: Float32Array | number[], o: number): void {
    const len = vlength(a, o) || 1
    a[o] /= len
    a[o + 1] /= len
    a[o + 2] /= len
}

export function vlerp(
    b: ArrayLike<number>,
    ob: number,
    a: ArrayLike<number>,
    oa: number,
    t: number,
    dst: Float32Array | number[],
    d: number,
): void {
    dst[d] = a[oa]! + t * (b[ob]! - a[oa]!)
    dst[d + 1] = a[oa + 1]! + t * (b[ob + 1]! - a[oa + 1]!)
    dst[d + 2] = a[oa + 2]! + t * (b[ob + 2]! - a[oa + 2]!)
}

export function vequal(a: ArrayLike<number>, oa: number, b: ArrayLike<number>, ob: number): boolean {
    return a[oa] === b[ob] && a[oa + 1] === b[ob + 1] && a[oa + 2] === b[ob + 2]
}
