export class GPUHelper implements Disposable {
    readonly device: GPUDevice
    #buffers: GPUBuffer[] = []

    private constructor(device: GPUDevice) {
        this.device = device
    }

    static async create(): Promise<GPUHelper | undefined> {
        let adapter!: GPUAdapter | null
        try {
            adapter = await navigator.gpu.requestAdapter()
            if (!adapter) return undefined
        } catch (e) {
            console.log(e)
            return undefined
        }

        const device = await adapter.requestDevice({
            requiredLimits: {
                maxStorageBuffersPerShaderStage: 10,
                maxComputeInvocationsPerWorkgroup: 1024,
            },
        })
        return new GPUHelper(device)
    }

    createBuffer(label: string, size: number, usage: GPUBufferUsageFlags, mappedAtCreation?: boolean) {
        const buffer = this.device.createBuffer({
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
                        label: `group ${groupID} binding ${binding} ${label}`,
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
        const readbackBuffer = this.device.createBuffer({
            label: `${buffer.label}_readback`,
            mappedAtCreation: false,
            size,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        })

        const ce = this.device.createCommandEncoder()
        ce.copyBufferToBuffer(buffer, 0, readbackBuffer, 0, buffer.size)
        this.device.queue.submit([ce.finish()])

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

    [Symbol.dispose](): void {
        this.destroyAllBuffers()
    }
}
