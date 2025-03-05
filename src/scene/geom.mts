/*
 * returns a radius given a radius or diameter. One of the two must be undefined, otherwise it throws.
 */

export function asRadius(r?: number, d?: number): number {
    if (r && !d) {
        return r
    }
    if (d && !r) {
        return d / 2
    }
    throw new Error("must pass a non-zero radius or diameter")
}
