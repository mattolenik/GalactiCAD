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

export function numbersAreDefined(...nums: (number | undefined | null)[]): boolean {
    if (nums.length === 0) {
        throw new Error("expected at least 1 argument")
    }
    for (const n of nums) {
        if (n === undefined || n === null || !Number.isFinite(n)) {
            return false
        }
    }
    return true
}

export function clampedAngle<
    D extends {
        get?: () => number
        set?: (v: number) => void
    }
>(descriptor: D, context: ClassAccessorDecoratorContext): D {
    if (context.kind !== "accessor") {
        throw new Error("@clampedAngle can only be applied to an accessor")
    }
    return {
        get: descriptor.get,
        set(this: any, raw: number) {
            descriptor.set!.call(this, clampAngle(raw))
        },
    } as D
}

export function clamped(min: number, max: number) {
    return function <D extends { get?: () => number; set?: (v: number) => void }>(
        descriptor: D,
        context: ClassAccessorDecoratorContext
    ): D {
        if (context.kind !== "accessor") {
            throw new Error("@clamped can only be applied to accessors")
        }
        return {
            get: descriptor.get,
            set(this: any, raw: number) {
                descriptor.set!.call(this, clamp(raw, min, max))
            },
        } as D
    }
}
