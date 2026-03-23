declare global {
    // Generic constructor function type, for writing mixins and decorators, avoids ugly type signatures everywhere
    type Constructor<T = {}> = new (...args: any[]) => T

    /** Build-injected version string (via esbuild version plugin) */
    const __VERSION__: string

    /** @webgpu/types omits destroy() on several objects; runtime WebGPU implements it. */
    interface GPUBindGroup {
        destroy(): void
    }
    interface GPUBindGroupLayout {
        destroy(): void
    }
    interface GPUPipelineLayout {
        destroy(): void
    }
    interface GPURenderPipeline {
        destroy(): void
    }
    interface GPUComputePipeline {
        destroy(): void
    }
    interface GPUShaderModule {
        destroy(): void
    }
}

export { }

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
