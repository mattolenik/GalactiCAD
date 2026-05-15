import { GPUHelper, MAX_SAFE_ARRAY_BUFFER_BYTES } from "../../gpu/helper.mjs"

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

/** Float count per sample in `IsoSampleBatch.runMidFeature` output (7 vec4 = 28 floats). */
export const ISO_SAMPLE_BATCH_MID_FLOATS_PER_SAMPLE = 28

/** GPU readback from {@link IsoSampleBatch.runMidFeature}: packed `SDFResultMid` per input position. */
export interface IsoSampleBatchMidResult {
    /** Packed mid-feature layout — decode with `decodeMidGridSample` (treat as gridMid with stride 7). */
    midFeature: Float32Array<ArrayBuffer>
    sampleCount: number
}

/**
 * GPU batched evaluator for arbitrary world-space points (iso-simplicial Hermite
 * sampling). Scene SDF stays on the GPU; bind the same `polygonVertices`,
 * `faceSelection`, and `mdcSceneParams` buffers as `GridSampler` / MDC export.
 *
 * Reuses the compute pipeline and grows persistent GPU buffers across {@link IsoSampleBatch.run}
 * calls with the same shader module (typical: one export session).
 *
 * The shader source is `iso_sample_batch.wgsl`; compile with `ShaderCompiler`
 * using the same `//:) insert` replacements as `sample_grid.wgsl` (aux + `sceneSDF`;
 * no `sceneSDF_mid` / fast-path inserts required by this shader).
 */
export class IsoSampleBatch {
    #helper: GPUHelper
    #device: GPUDevice
    #polygonVerticesBuffer: GPUBuffer
    #faceSelectionBuffer: GPUBuffer
    #mdcSceneParamsBuffer: GPUBuffer

    #pipelineModule: GPUShaderModule | undefined
    #pipeline: GPUComputePipeline | undefined
    #midPipeline: GPUComputePipeline | undefined
    #cancellationBuffer: GPUBuffer | undefined
    #uniformBuffer: GPUBuffer | undefined
    #positionsBuffer: GPUBuffer | undefined
    #positionsCapacity = 0
    #sdfBuffer: GPUBuffer | undefined
    #sdfCapacity = 0
    #midBuffer: GPUBuffer | undefined
    #midCapacity = 0
    #stagingBuffer: GPUBuffer | undefined
    #stagingCapacity = 0
    #midStagingBuffer: GPUBuffer | undefined
    #midStagingCapacity = 0
    #bindGroup: [number, GPUBindGroup] | undefined
    #midBindGroup: [number, GPUBindGroup] | undefined

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

    /** Release cached pipeline and pooled GPU buffers (e.g. when abandoning an export). */
    destroy(): void {
        this.#pipeline = undefined
        this.#midPipeline = undefined
        this.#pipelineModule = undefined
        this.#bindGroup = undefined
        this.#midBindGroup = undefined
        this.#cancellationBuffer?.destroy()
        this.#cancellationBuffer = undefined
        this.#uniformBuffer?.destroy()
        this.#uniformBuffer = undefined
        this.#positionsBuffer?.destroy()
        this.#positionsBuffer = undefined
        this.#positionsCapacity = 0
        this.#sdfBuffer?.destroy()
        this.#sdfBuffer = undefined
        this.#sdfCapacity = 0
        this.#midBuffer?.destroy()
        this.#midBuffer = undefined
        this.#midCapacity = 0
        this.#stagingBuffer?.destroy()
        this.#stagingBuffer = undefined
        this.#stagingCapacity = 0
        this.#midStagingBuffer?.destroy()
        this.#midStagingBuffer = undefined
        this.#midStagingCapacity = 0
    }

    #ensurePipeline(isoSampleBatchShaderModule: GPUShaderModule): GPUComputePipeline {
        if (this.#pipelineModule !== isoSampleBatchShaderModule || !this.#pipeline) {
            this.#pipelineModule = isoSampleBatchShaderModule
            this.#pipeline = this.#helper.createComputePipeline(isoSampleBatchShaderModule, "isoSampleBatch")
            this.#midPipeline = undefined
            this.#bindGroup = undefined
            this.#midBindGroup = undefined
        }
        return this.#pipeline
    }

    #ensureMidPipeline(isoSampleBatchShaderModule: GPUShaderModule): GPUComputePipeline {
        this.#ensurePipeline(isoSampleBatchShaderModule)
        if (!this.#midPipeline) {
            this.#midPipeline = this.#helper.createComputePipeline(isoSampleBatchShaderModule, "isoSampleBatchMid")
            this.#midBindGroup = undefined
        }
        return this.#midPipeline
    }

    #ensureCancellationBuffer(): GPUBuffer {
        if (!this.#cancellationBuffer) {
            this.#cancellationBuffer = this.#device.createBuffer({
                label: "IsoSampleBatch.Cancellation",
                size: Uint32Array.BYTES_PER_ELEMENT,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            })
        }
        return this.#cancellationBuffer
    }

    #ensureUniformBuffer(): GPUBuffer {
        if (!this.#uniformBuffer) {
            this.#uniformBuffer = this.#device.createBuffer({
                label: "IsoSampleBatch.Uniforms",
                size: ISO_SAMPLE_BATCH_UNIFORM_BYTES,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            })
        }
        return this.#uniformBuffer
    }

    #ensurePositionBuffer(minBytes: number): GPUBuffer {
        if (!this.#positionsBuffer || this.#positionsCapacity < minBytes) {
            this.#positionsBuffer?.destroy()
            this.#positionsCapacity = Math.max(minBytes, this.#positionsCapacity * 2 || 4096)
            this.#positionsBuffer = this.#device.createBuffer({
                label: "IsoSampleBatch.PositionsIn",
                size: this.#positionsCapacity,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            })
            this.#bindGroup = undefined
        }
        return this.#positionsBuffer
    }

    #ensureSdfBuffer(minBytes: number): GPUBuffer {
        if (!this.#sdfBuffer || this.#sdfCapacity < minBytes) {
            this.#sdfBuffer?.destroy()
            this.#sdfCapacity = Math.max(minBytes, this.#sdfCapacity * 2 || 4096)
            this.#sdfBuffer = this.#device.createBuffer({
                label: "IsoSampleBatch.SdfOut",
                size: this.#sdfCapacity,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
            })
            this.#bindGroup = undefined
        }
        return this.#sdfBuffer
    }

    #ensureStagingBuffer(minBytes: number): GPUBuffer {
        if (!this.#stagingBuffer || this.#stagingCapacity < minBytes) {
            this.#stagingBuffer?.destroy()
            this.#stagingCapacity = Math.max(minBytes, this.#stagingCapacity * 2 || 4096)
            this.#stagingBuffer = this.#device.createBuffer({
                label: "IsoSampleBatch.Staging",
                size: this.#stagingCapacity,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            })
        }
        return this.#stagingBuffer
    }

    #ensureMidBuffer(minBytes: number): GPUBuffer {
        if (!this.#midBuffer || this.#midCapacity < minBytes) {
            this.#midBuffer?.destroy()
            this.#midCapacity = Math.max(minBytes, this.#midCapacity * 2 || 4096)
            this.#midBuffer = this.#device.createBuffer({
                label: "IsoSampleBatch.MidFeatureOut",
                size: this.#midCapacity,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
            })
            this.#midBindGroup = undefined
        }
        return this.#midBuffer
    }

    #ensureMidStagingBuffer(minBytes: number): GPUBuffer {
        if (!this.#midStagingBuffer || this.#midStagingCapacity < minBytes) {
            this.#midStagingBuffer?.destroy()
            this.#midStagingCapacity = Math.max(minBytes, this.#midStagingCapacity * 2 || 4096)
            this.#midStagingBuffer = this.#device.createBuffer({
                label: "IsoSampleBatch.MidStaging",
                size: this.#midStagingCapacity,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            })
        }
        return this.#midStagingBuffer
    }

    #ensureBindGroup(
        pipeline: GPUComputePipeline,
        uniformBuffer: GPUBuffer,
        positionsBuffer: GPUBuffer,
        sdfBuffer: GPUBuffer,
        cancellationBuffer: GPUBuffer,
    ): [number, GPUBindGroup] {
        if (!this.#bindGroup) {
            this.#bindGroup = this.#helper.createBindGroup(
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
        }
        return this.#bindGroup
    }

    #ensureMidBindGroup(
        pipeline: GPUComputePipeline,
        uniformBuffer: GPUBuffer,
        positionsBuffer: GPUBuffer,
        midBuffer: GPUBuffer,
        cancellationBuffer: GPUBuffer,
    ): [number, GPUBindGroup] {
        if (!this.#midBindGroup) {
            this.#midBindGroup = this.#helper.createBindGroup(
                0,
                "IsoSampleBatch.MidBindGroup",
                pipeline,
                [0, uniformBuffer],
                [1, positionsBuffer],
                [3, midBuffer],
                [25, cancellationBuffer],
                [27, this.#polygonVerticesBuffer],
                [28, this.#faceSelectionBuffer],
                [30, this.#mdcSceneParamsBuffer],
            )
        }
        return this.#midBindGroup
    }

    /**
     * @param positions World positions as a tight `Float32Array` `[x0,y0,z0, x1,y1,z1, …]`.
     * Length must be a multiple of 3 and > 0.
     */
    async run(
        isoSampleBatchShaderModule: GPUShaderModule,
        positions: Float32Array<ArrayBuffer>,
        voxelSize: number,
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

        const pipeline = this.#ensurePipeline(isoSampleBatchShaderModule)
        const cancellationBuffer = this.#ensureCancellationBuffer()
        this.#device.queue.writeBuffer(cancellationBuffer, 0, new Uint32Array([0]))

        const uniformBuffer = this.#ensureUniformBuffer()
        const uniformData = new ArrayBuffer(ISO_SAMPLE_BATCH_UNIFORM_BYTES)
        new Uint32Array(uniformData, 0, 4).set([sampleCount >>> 0, 0, 0, 0])
        new Float32Array(uniformData, 4, 1).set([voxelSize])
        this.#device.queue.writeBuffer(uniformBuffer, 0, uniformData)

        const positionsBuffer = this.#ensurePositionBuffer(positionsBytes)
        this.#device.queue.writeBuffer(positionsBuffer, 0, positions)

        const sdfBuffer = this.#ensureSdfBuffer(outBytes)
        const stagingBuffer = this.#ensureStagingBuffer(outBytes)
        const bindGroup = this.#ensureBindGroup(pipeline, uniformBuffer, positionsBuffer, sdfBuffer, cancellationBuffer)

        const wg = Math.ceil(sampleCount / 256)
        if (wg > 65535) {
            throw new Error(`IsoSampleBatch: workgroup count ${wg} exceeds 65535; split the batch.`)
        }

        // One command encoder: compute pass + copy-to-staging, single submit.
        // Avoids the redundant `onSubmittedWorkDone` wait between dispatch and copy
        // that a separate `readBufferData` round would impose.
        const ce = this.#device.createCommandEncoder({ label: "iso_sample_batch" })
        const pass = this.#helper.beginComputePass(ce, pipeline, bindGroup)
        pass.dispatchWorkgroups(wg)
        pass.end()
        ce.copyBufferToBuffer(sdfBuffer, 0, stagingBuffer, 0, outBytes)
        this.#device.queue.submit([ce.finish()])

        await stagingBuffer.mapAsync(GPUMapMode.READ, 0, outBytes)
        try {
            if (options?.signal?.aborted) {
                const err = new Error("IsoSampleBatch aborted")
                err.name = "AbortError"
                throw err
            }
            const sdf = new Float32Array(stagingBuffer.getMappedRange(0, outBytes).slice(0))
            return { sdf, sampleCount }
        } finally {
            stagingBuffer.unmap()
        }
    }

    /**
     * Like {@link IsoSampleBatch.run} but returns packed `SDFResultMid` data per sample
     * (28 floats / sample = 7 vec4, matching `sample_grid.wgsl` `midFeatureOut`).
     * Used by iso-simplicial feature-driven subdivision; decode with {@link decodeMidGridSample}.
     */
    async runMidFeature(
        isoSampleBatchShaderModule: GPUShaderModule,
        positions: Float32Array<ArrayBuffer>,
        voxelSize: number,
        options?: { signal?: AbortSignal },
    ): Promise<IsoSampleBatchMidResult> {
        if (options?.signal?.aborted) {
            const err = new Error("IsoSampleBatch aborted")
            err.name = "AbortError"
            throw err
        }

        const sampleCount = positions.length / 3
        if (!Number.isInteger(sampleCount) || sampleCount <= 0) {
            throw new Error(`IsoSampleBatch.runMidFeature: positions length ${positions.length} is not a positive multiple of 3`)
        }

        const positionsBytes = positions.byteLength
        const midOutBytes = sampleCount * ISO_SAMPLE_BATCH_MID_FLOATS_PER_SAMPLE * Float32Array.BYTES_PER_ELEMENT
        const limit = this.#device.limits.maxStorageBufferBindingSize
        if (positionsBytes > limit || midOutBytes > limit) {
            throw new Error(
                `IsoSampleBatch.runMidFeature: buffer size exceeds maxStorageBufferBindingSize=${limit} ` +
                `(positions=${positionsBytes} B, mid=${midOutBytes} B).`,
            )
        }
        if (midOutBytes > MAX_SAFE_ARRAY_BUFFER_BYTES) {
            throw new Error(`IsoSampleBatch.runMidFeature: readback ${midOutBytes} B exceeds safe ArrayBuffer limit`)
        }

        const pipeline = this.#ensureMidPipeline(isoSampleBatchShaderModule)
        const cancellationBuffer = this.#ensureCancellationBuffer()
        this.#device.queue.writeBuffer(cancellationBuffer, 0, new Uint32Array([0]))

        const uniformBuffer = this.#ensureUniformBuffer()
        const uniformData = new ArrayBuffer(ISO_SAMPLE_BATCH_UNIFORM_BYTES)
        new Uint32Array(uniformData, 0, 4).set([sampleCount >>> 0, 0, 0, 0])
        new Float32Array(uniformData, 4, 1).set([voxelSize])
        this.#device.queue.writeBuffer(uniformBuffer, 0, uniformData)

        const positionsBuffer = this.#ensurePositionBuffer(positionsBytes)
        this.#device.queue.writeBuffer(positionsBuffer, 0, positions)

        const midBuffer = this.#ensureMidBuffer(midOutBytes)
        const midStagingBuffer = this.#ensureMidStagingBuffer(midOutBytes)
        const bindGroup = this.#ensureMidBindGroup(pipeline, uniformBuffer, positionsBuffer, midBuffer, cancellationBuffer)

        const wg = Math.ceil(sampleCount / 256)
        if (wg > 65535) {
            throw new Error(`IsoSampleBatch.runMidFeature: workgroup count ${wg} exceeds 65535; split the batch.`)
        }

        const ce = this.#device.createCommandEncoder({ label: "iso_sample_batch_mid" })
        const pass = this.#helper.beginComputePass(ce, pipeline, bindGroup)
        pass.dispatchWorkgroups(wg)
        pass.end()
        ce.copyBufferToBuffer(midBuffer, 0, midStagingBuffer, 0, midOutBytes)
        this.#device.queue.submit([ce.finish()])

        await midStagingBuffer.mapAsync(GPUMapMode.READ, 0, midOutBytes)
        try {
            if (options?.signal?.aborted) {
                const err = new Error("IsoSampleBatch aborted")
                err.name = "AbortError"
                throw err
            }
            const midFeature = new Float32Array(midStagingBuffer.getMappedRange(0, midOutBytes).slice(0))
            return { midFeature, sampleCount }
        } finally {
            midStagingBuffer.unmap()
        }
    }
}
