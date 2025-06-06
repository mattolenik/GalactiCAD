export class GPUHelper {
    #device: GPUDevice
    #buffers: GPUBuffer[] = []

    private constructor(device: GPUDevice) {
        this.#device = device
    }

    static async create(): Promise<GPUHelper | undefined> {
        const adapter = await navigator.gpu.requestAdapter()
        if (!adapter) return undefined

        const device = await adapter.requestDevice({
            requiredLimits: {
                maxStorageBuffersPerShaderStage: 10,
                maxComputeInvocationsPerWorkgroup: 1024,
            },
        })
        return new GPUHelper(device)
    }

    createBuffer(label: string, size: number, usage: GPUBufferUsageFlags, mappedAtCreation = true) {
        const buffer = this.#device.createBuffer({
            label,
            mappedAtCreation,
            size,
            usage,
        })
        this.#buffers.push(buffer)
        return buffer
    }

    createComputePipeline(
        module: GPUShaderModule,
        entryPoint: string,
        label = entryPoint,
        layout: GPUAutoLayoutMode = "auto",
        constants?: Record<string, GPUPipelineConstantValue>
    ) {
        return this.#device.createComputePipeline({
            label,
            layout,
            compute: {
                module,
                entryPoint,
                constants,
            },
        })
    }

    createBindGroup(groupID: number, label: string, pipeline: GPUComputePipeline | GPURenderPipeline, bindings: Binding[]) {
        return this.#device.createBindGroup({
            label,
            layout: pipeline.getBindGroupLayout(groupID),
            entries: bindings.map(v => ({
                binding: v.binding,
                resource: {
                    buffer: v.buffer,
                    label: `group ${groupID} binding ${v.binding} ${label}`,
                },
            })),
        })
    }

    async readBufferData(buffer: GPUBuffer): Promise<ArrayBuffer> {
        const readbackBuffer = this.#device.createBuffer({
            label: `${buffer.label}_readback`,
            mappedAtCreation: false,
            size: buffer.size,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        })

        const ce = this.#device.createCommandEncoder()
        ce.copyBufferToBuffer(buffer, 0, readbackBuffer, 0, buffer.size)
        this.#device.queue.submit([ce.finish()])

        await readbackBuffer.mapAsync(GPUMapMode.READ)
        const data = readbackBuffer.getMappedRange().slice(0) // slice(0) creates a copy
        readbackBuffer.unmap()
        readbackBuffer.destroy()
        return data
    }

    destroyAllBuffers() {
        for (const buffer of this.#buffers) {
            buffer.destroy()
        }
        this.#buffers = []
    }
}

export type Binding = {
    binding: number
    buffer: GPUBuffer
}
