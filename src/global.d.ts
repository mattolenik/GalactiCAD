declare global {
    // Generic constructor function type, for writing mixins and decorators, avoids ugly type signatures everywhere
    type Constructor<T = {}> = new (...args: any[]) => T

    function toNumberMust(num: string | number): number {
        const result = toNumber(num)
        if (result === undefined) {
            throw new Error(`value is not a number: ${num}`)
        }
    }

    function toNumber(num: string | number): number | undefined {
        // Inspired by https://stackoverflow.com/a/42356340
        num = "" + num // coerce num into a string
        const parsed = parseFloat(num)
        const isNum = !isNaN(num) && !isNaN(parsed)
        return !isNum ? undefined : parsed
    }
}

export {}
