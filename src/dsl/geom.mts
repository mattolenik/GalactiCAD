/*
 * returns a radius given a radius or diameter. One of the two must be undefined, otherwise it throws.
 */
export function rOrD(r: number | undefined, d: number | undefined): number {
    if (r == undefined && d == undefined) {
        throw new Error("either radius or diameter must be specified")
    }
    if (r != undefined && d == undefined) {
        if (r <= 0) {
            throw new Error("radius must be greater than 0")
        }
        return r
    }
    if (r == undefined && d != undefined) {
        if (d <= 0) {
            throw new Error("diameter must be greater than 0")
        }
        return d / 2
    }
    throw new Error("cannot define both radius and diameter")
}
