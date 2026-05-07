import { GPUHelper, MAX_SAFE_ARRAY_BUFFER_BYTES } from "../../gpu/helper.mjs"
import { log as dbgLog } from "../../logging/debug-log.mjs"

/**
 * Byte size of {@link IsoSampleBatchUniforms} in WGSL (16 bytes).
 */
export const ISO_SAMPLE_BATCH_UNIFORM_BYTES = 16

/**
 * GPU readback from {@link IsoSampleBatch.run}: one `vec4f` per input position.
 * - `out[i*4 + 0..2]` — analytical unit normal `sceneSDF(p).n`
 * - `out[i*4 + 3]` — signed distance `sceneSDF(p).d`
 */
export interface IsoSampleBatchResult {
    /** Interleaved vec4 per sample: `[nx, ny, nz, d]`. */
    sdf: Float32Array<ArrayBuffer>
    sampleCount: number
}

/**
 * GPU batched evaluator for arbitrary world-space points (iso-simplicial Hermite
 * sampling). Scene SDF stays on the GPU; bind the same `polygonVertices`,
 * `faceSelection`, and `mdcSceneParams` buffers as `GridSampler` / MDC export.
 *
 * The shader source is `iso_sample_batch.wgsl`; compile with `ShaderCompiler`
 * using the same `//:) insert` replacements as `sample_grid.wgsl` (aux + `sceneSDF`;
 * no `sceneSDF_mid` / fast-path inserts required by this shader).
 */
export class IsoSampleBatch {
    #helper: GPUHelper
    #device: GPUDevice
    #localBuffers: GPUBuffer[] = []
    #polygonVerticesBuffer: GPUBuffer
    #faceSelectionBuffer: GPUBuffer
    #mdcSceneParamsBuffer: GPUBuffer

    constructor(
        helper: GPUHelper,
        polygonVerticesBuffer: GPUBuffer,
        faceSelectionBuffer: GPUBuffer,
        mdcSceneParamsBuffer: GPUBuffer,
    ) {
        this.#helper = helper
        this.#device = helper.device
        this.#polygonVerticesBuffer = polygonVerticesBuffer
        this.#faceSelectionBuffer = faceSelectionBuffer
        this.#mdcSceneParamsBuffer = mdcSceneParamsBuffer
    }

    #destroyLocalBuffers() {
        for (const buffer of this.#localBuffers) {
            buffer.destroy()
        }
        this.#localBuffers = []
    }

    /**
     * @param positions World positions as a tight `Float32Array` `[x0,y0,z0, x1,y1,z1, …]`.
     * Length must be a multiple of 3 and > 0.
     */
    async run(
        isoSampleBatchShaderModule: GPUShaderModule,
        positions: Float32Array<ArrayBuffer>,
        options?: { signal?: AbortSignal },
    ): Promise<IsoSampleBatchResult> {
        if (options?.signal?.aborted) {
            const err = new Error("IsoSampleBatch aborted")
            err.name = "AbortError"
            throw err
        }

        const sampleCount = positions.length / 3
        if (!Number.isInteger(sampleCount) || sampleCount <= 0) {
            throw new Error(`IsoSampleBatch: positions length ${positions.length} is not a positive multiple of 3`)
        }

        const positionsBytes = positions.byteLength
        const outBytes = sampleCount * 4 * Float32Array.BYTES_PER_ELEMENT
        const limit = this.#device.limits.maxStorageBufferBindingSize
        if (positionsBytes > limit || outBytes > limit) {
            throw new Error(
                `IsoSampleBatch: buffer size exceeds maxStorageBufferBindingSize=${limit} ` +
                `(positions=${positionsBytes} B, out=${outBytes} B).`,
            )
        }
        if (outBytes > MAX_SAFE_ARRAY_BUFFER_BYTES) {
            throw new Error(`IsoSampleBatch: readback ${outBytes} B exceeds safe ArrayBuffer limit`)
        }

        const t0 = globalThis.performance?.now ? globalThis.performance.now() : Date.now()

        const cancellationBuffer = this.#device.createBuffer({
            label: "IsoSampleBatch.Cancellation",
            size: Uint32Array.BYTES_PER_ELEMENT,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        })
        this.#localBuffers.push(cancellationBuffer)
        this.#device.queue.writeBuffer(cancellationBuffer, 0, new Uint32Array([0]))

        try {
            const uniformData = new ArrayBuffer(ISO_SAMPLE_BATCH_UNIFORM_BYTES)
            new Uint32Array(uniformData, 0, 4).set([sampleCount >>> 0, 0, 0, 0])

            const uniformBuffer = this.#device.createBuffer({
                label: "IsoSampleBatch.Uniforms",
                size: ISO_SAMPLE_BATCH_UNIFORM_BYTES,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            })
            this.#localBuffers.push(uniformBuffer)
            this.#device.queue.writeBuffer(uniformBuffer, 0, uniformData)

            const positionsBuffer = this.#device.createBuffer({
                label: "IsoSampleBatch.PositionsIn",
                size: positionsBytes,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            })
            this.#localBuffers.push(positionsBuffer)
            this.#device.queue.writeBuffer(positionsBuffer, 0, positions)

            const sdfBuffer = this.#device.createBuffer({
                label: "IsoSampleBatch.SdfOut",
                size: outBytes,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
            })
            this.#localBuffers.push(sdfBuffer)

            const pipeline = this.#helper.createComputePipeline(isoSampleBatchShaderModule, "isoSampleBatch")

            const bindGroup = this.#helper.createBindGroup(
                0,
                "IsoSampleBatch.BindGroup",
                pipeline,
                [0, uniformBuffer],
                [1, positionsBuffer],
                [2, sdfBuffer],
                [25, cancellationBuffer],
                [27, this.#polygonVerticesBuffer],
                [28, this.#faceSelectionBuffer],
                [30, this.#mdcSceneParamsBuffer],
            )

            const wg = Math.ceil(sampleCount / 256)
            if (wg > 65535) {
                throw new Error(`IsoSampleBatch: workgroup count ${wg} exceeds 65535; split the batch.`)
            }

            const ce = this.#device.createCommandEncoder({ label: "iso_sample_batch" })
            const pass = this.#helper.beginComputePass(ce, pipeline, bindGroup)
            pass.dispatchWorkgroups(wg)
            pass.end()
            this.#device.queue.submit([ce.finish()])
            await this.#device.queue.onSubmittedWorkDone()

            if (options?.signal?.aborted) {
                const err = new Error("IsoSampleBatch aborted")
                err.name = "AbortError"
                throw err
            }

            const sdf = new Float32Array(await this.#helper.readBufferData(sdfBuffer))

            const elapsedMs = (globalThis.performance?.now ? globalThis.performance.now() : Date.now()) - t0
            dbgLog("ShrecExport").debug(
                `IsoSampleBatch: ${sampleCount} samples elapsed=${elapsedMs.toFixed(1)}ms`,
            )

            return { sdf, sampleCount }
        } finally {
            this.#destroyLocalBuffers()
        }
    }
}
