/*
 * returns a radius given a radius or diameter. One of the two must be undefined, otherwise it throws.
 */

export function asRadius(r?: number, d?: number): number {
    if (r && !d) {
        if (r < 0) {
            throw new Error("radius must be positive")
        }
        return r
    }
    if (d && !r) {
        if (d < 0) {
            throw new Error("diameter must be positive")
        }
        return d / 2
    }
    throw new Error("must pass a positive radius or diameter")
}
