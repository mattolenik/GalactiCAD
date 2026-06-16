/**
 * OpenSCAD value model (subset). OpenSCAD is dynamically typed over a small tower:
 * number, boolean, string, list/vector, range, undef. See implementation plan §3.1.
 *
 * SCAFFOLD: vector arithmetic is partial (element-wise +/-, scalar*vector); matrix mult,
 * string ops, and the full numeric tower are TODO as the evaluator grows.
 */

export type Value =
    | { t: "num"; v: number }
    | { t: "bool"; v: boolean }
    | { t: "str"; v: string }
    | { t: "vec"; v: Value[] }
    | { t: "range"; start: number; step: number; end: number }
    | { t: "undef" }

export const UNDEF: Value = { t: "undef" }
export const num = (v: number): Value => ({ t: "num", v })
export const bool = (v: boolean): Value => ({ t: "bool", v })
export const str = (v: string): Value => ({ t: "str", v })
export const vec = (v: Value[]): Value => ({ t: "vec", v })

/** OpenSCAD truthiness: undef/false/0/""/[] are falsy. */
export function truthy(val: Value): boolean {
    switch (val.t) {
        case "bool":
            return val.v
        case "num":
            return val.v !== 0 && !Number.isNaN(val.v)
        case "str":
            return val.v.length > 0
        case "vec":
            return val.v.length > 0
        case "range":
            return true
        case "undef":
            return false
    }
}

export function asNumber(val: Value): number | undefined {
    return val.t === "num" ? val.v : undefined
}

/** Extract a fixed- or any-length number tuple from a vec value; undefined if it doesn't fit. */
export function asNumberArray(val: Value, len?: number): number[] | undefined {
    if (val.t !== "vec") return undefined
    const out: number[] = []
    for (const el of val.v) {
        if (el.t !== "num") return undefined
        out.push(el.v)
    }
    if (len !== undefined && out.length !== len) return undefined
    return out
}

/** Expand a range value into its concrete numeric sequence (capped). */
export function rangeToNumbers(r: { start: number; step: number; end: number }, cap = 1_000_000): number[] {
    const out: number[] = []
    if (r.step === 0 || !Number.isFinite(r.step)) return out
    if (r.step > 0) {
        for (let x = r.start; x <= r.end + 1e-9 && out.length < cap; x += r.step) out.push(x)
    } else {
        for (let x = r.start; x >= r.end - 1e-9 && out.length < cap; x += r.step) out.push(x)
    }
    return out
}
