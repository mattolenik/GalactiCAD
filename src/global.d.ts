declare global {
    // Generic constructor function type, for writing mixins and decorators, avoids ugly type signatures everywhere
    type Constructor<T = {}> = new (...args: any[]) => T
}

export {}

declare module "monaco-editor-env" {
    /**
     * Re‐use the official Monaco Environment type
     * (which declares getWorkerUrl, getWorker, etc.).
     */
    import type { Environment } from "monaco-editor"

    /**
     * The virtual module exports the global MonacoEnvironment object.
     */
    const MonacoEnvironment: Environment
    export default MonacoEnvironment
}
