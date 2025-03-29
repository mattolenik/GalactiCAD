declare global {
    // Generic constructor function type, for writing mixins and decorators, avoids ugly type signatures everywhere
    type Constructor<T = {}> = new (...args: any[]) => T
}

export {}
