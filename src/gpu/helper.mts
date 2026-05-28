import { installWebGpuDeviceLogging, log } from "../logging/debug-log.mjs"

/** MAP_READ staging buffers this large often fail to map even when `createBuffer` succeeds. */
const READBACK_MAP_CHUNK_BYTES = 64 * 1024 * 1024

/**
 * Contiguous `ArrayBuffer`/`TypedArray` backing allocations above this size
 * typically fail in JS engines (~2³¹−1 bytes) even when GPU buffers succeed.
 * Do not use `(1 << 31) - 1` — `<<` is signed 32-bit and yields a negative value.
 */
export const MAX_SAFE_ARRAY_BUFFER_BYTES = 2 ** 31 - 1

export class GPUHelper {
    readonly device: GPUDevice

    private constructor(device: GPUDevice) {
        this.device = device
    }

    static async create(): Promise<GPUHelper | undefined> {
        let adapter!: GPUAdapter | null
        try {
            adapter = await navigator.gpu.requestAdapter()
            if (!adapter) return undefined
        } catch (e) {
            log("App").warn("requestAdapter failed:", e)
            return undefined
        }

        // Opt into `timestamp-query` when the adapter exposes it so the
        // render core can measure per-pass GPU time. Chrome requires the
        // browser flag `chrome://flags → "Unsafe WebGPU"` (or launching with
        // `--enable-unsafe-webgpu`) to expose this feature; otherwise the
        // adapter simply omits it and we silently skip profiling.
        const optionalFeatures: GPUFeatureName[] = []
        if (adapter.features.has("timestamp-query")) {
            optionalFeatures.push("timestamp-query")
        }

        const device = await adapter.requestDevice({
            label: "gpuHelperDevice",
            requiredFeatures: optionalFeatures,
            requiredLimits: {
                maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage,
                maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup,
                maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
                maxBufferSize: adapter.limits.maxBufferSize,
            },
        })
        installWebGpuDeviceLogging(device)
        return new GPUHelper(device)
    }

    /** Whether the device was created with `timestamp-query` enabled. */
    get hasTimestampQuery(): boolean {
        return this.device.features.has("timestamp-query")
    }

    createBuffer(label: string, size: number, usage: GPUBufferUsageFlags, mappedAtCreation?: boolean) {
        const buffer = this.device.createBuffer({
            label,
            mappedAtCreation,
            size,
            usage,
        })
        return buffer
    }

    createComputePipeline(
        module: GPUShaderModule,
        entryPoint: string,
        label = entryPoint,
        layout: GPUAutoLayoutMode = "auto",
        constants?: Record<string, GPUPipelineConstantValue>
    ) {
        return this.device.createComputePipeline({
            label,
            layout,
            compute: {
                module,
                entryPoint,
                constants,
            },
        })
    }

    createBindGroup(
        groupID: number,
        label: string,
        pipeline: GPUComputePipeline | GPURenderPipeline,
        ...bindings: [binding: number, buffer: GPUBuffer][]
    ): [groupID: number, bindgroup: GPUBindGroup] {
        return [
            groupID,
            this.device.createBindGroup({
                label,
                layout: pipeline.getBindGroupLayout(groupID),
                entries: bindings.map(([binding, buffer]) => ({
                    binding,
                    resource: {
                        buffer,
                        label: `group_${groupID}_binding_${binding}_${label}`,
                    },
                })),
            }),
        ]
    }

    beginComputePass(ce: GPUCommandEncoder, pipeline: GPUComputePipeline, ...bindgroups: [number, GPUBindGroup][]) {
        const pass = ce.beginComputePass({ label: pipeline.label })
        pass.setPipeline(pipeline)
        for (const [group, binding] of bindgroups) {
            pass.setBindGroup(group, binding)
        }
        return pass
    }

    async readBufferData(buffer: GPUBuffer, size = buffer.size): Promise<ArrayBuffer> {
        // WebGPU copy sizes must not exceed either buffer and must be 4-byte aligned.
        // Callers often want just a prefix of a large SSBO (e.g. actualVertexCount * stride),
        // so we must copy exactly `size`, not `buffer.size`.
        const copySize = Math.min(size, buffer.size)
        if (copySize % 4 !== 0) {
            throw new Error(`readBufferData: copy size ${copySize} must be a multiple of 4`)
        }
        if (copySize > MAX_SAFE_ARRAY_BUFFER_BYTES) {
            throw new Error(
                `readBufferData: cannot materialize ${copySize} bytes in one ArrayBuffer ` +
                `(max ${MAX_SAFE_ARRAY_BUFFER_BYTES}); reduce buffer size or tile the workload.`,
            )
        }

        if (copySize <= READBACK_MAP_CHUNK_BYTES) {
            const readbackBuffer = this.device.createBuffer({
                label: `${buffer.label}_readback`,
                mappedAtCreation: false,
                size: copySize,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            })

            const ce = this.device.createCommandEncoder()
            ce.copyBufferToBuffer(buffer, 0, readbackBuffer, 0, copySize)
            this.device.queue.submit([ce.finish()])

            await readbackBuffer.mapAsync(GPUMapMode.READ)
            const data = readbackBuffer.getMappedRange().slice(0) // slice(0) creates a copy
            readbackBuffer.unmap()
            readbackBuffer.destroy()
            return data
        }

        const out = new ArrayBuffer(copySize)
        const outU8 = new Uint8Array(out)
        let offset = 0
        while (offset < copySize) {
            const rawChunk = Math.min(READBACK_MAP_CHUNK_BYTES, copySize - offset)
            const thisChunk = rawChunk - (rawChunk % 4)
            if (thisChunk === 0) {
                throw new Error(`readBufferData: unaligned remainder at offset ${offset} (copySize=${copySize})`)
            }
            const readbackBuffer = this.device.createBuffer({
                label: `${buffer.label}_readback`,
                mappedAtCreation: false,
                size: thisChunk,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            })
            const ce = this.device.createCommandEncoder()
            ce.copyBufferToBuffer(buffer, offset, readbackBuffer, 0, thisChunk)
            this.device.queue.submit([ce.finish()])
            await readbackBuffer.mapAsync(GPUMapMode.READ)
            outU8.set(new Uint8Array(readbackBuffer.getMappedRange(), 0, thisChunk), offset)
            readbackBuffer.unmap()
            readbackBuffer.destroy()
            offset += thisChunk
        }
        return out
    }

    /** Read back a prefix of `source` into caller-owned `readback` (COPY_DST | MAP_READ); avoids per-call buffer alloc. */
    async readBufferDataReuse(source: GPUBuffer, readback: GPUBuffer, size: number): Promise<ArrayBuffer> {
        const copySize = Math.min(size, source.size, readback.size)
        const ce = this.device.createCommandEncoder()
        ce.copyBufferToBuffer(source, 0, readback, 0, copySize)
        this.device.queue.submit([ce.finish()])
        await readback.mapAsync(GPUMapMode.READ)
        const data = readback.getMappedRange().slice(0)
        readback.unmap()
        return data
    }
}
