export function clamp(x: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, x))
}

export function clampAngle(rad: number): number {
    return Math.atan2(Math.sin(rad), Math.cos(rad))
}

export function toNumberMust(num: string | number): number {
    const result = toNumber(num)
    if (result === undefined) {
        throw new Error(`value is not a number: ${num}`)
    }
    return result
}

export function toNumber(num: string | number): number | undefined {
    // Inspired by https://stackoverflow.com/a/42356340
    num = "" + num // coerce num into a string
    const parsed = parseFloat(num)
    const isNum = !isNaN(num as any) && !isNaN(parsed)
    return !isNum ? undefined : parsed
}
