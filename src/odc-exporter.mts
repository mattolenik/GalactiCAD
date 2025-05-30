export interface ODCParams {
    dimX: number
    dimY: number
    dimZ: number
    cellSize: [number, number, number]
    boundsMin: [number, number, number]
    maxTrisPerCell: number
}

export class ODCExport {
    private device: GPUDevice
    private params: ODCParams

    constructor(device: GPUDevice, params: ODCParams) {
        this.device = device
        this.params = params
    }

    async export(sceneShader: GPUShaderModule, outputFile: FileSystemHandle) {
        const { dimX, dimY, dimZ, cellSize, boundsMin, maxTrisPerCell } = this.params
        const cellCount = dimX * dimY * dimZ
        const maxIndicesPerCell = maxTrisPerCell * 3

        // Buffer size constants
        const uniformBufferSize = 64
        const cellActiveBufferSize = cellCount * 4
        const triCountBufferSize = cellCount * 4
        const vertexBufferSize = cellCount * 12
        const indexBufferSize = cellCount * maxIndicesPerCell * 4

        // 1. Uniform buffer
        const uniformBuffer = this.device.createBuffer({
            label: "uniformBuffer",
            size: uniformBufferSize,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })
        {
            const arrayBuffer = new ArrayBuffer(uniformBufferSize)
            const dv = new DataView(arrayBuffer)
            dv.setUint32(0, dimX, true)
            dv.setUint32(4, dimY, true)
            dv.setUint32(8, dimZ, true)
            dv.setFloat32(16, cellSize[0], true)
            dv.setFloat32(20, cellSize[1], true)
            dv.setFloat32(24, cellSize[2], true)
            dv.setFloat32(32, boundsMin[0], true)
            dv.setFloat32(36, boundsMin[1], true)
            dv.setFloat32(40, boundsMin[2], true)
            dv.setUint32(48, maxTrisPerCell, true)
            this.device.queue.writeBuffer(uniformBuffer, 0, arrayBuffer)
        }

        // 2. Storage buffers
        const cellActiveBuffer = this.device.createBuffer({
            label: "cellActiveBuffer",
            size: cellActiveBufferSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        })
        const triCountBuffer = this.device.createBuffer({
            label: "triCountBuffer",
            size: triCountBufferSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        })
        const vertexBuffer = this.device.createBuffer({
            label: "vertexBuffer",
            size: vertexBufferSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        })
        const indexBuffer = this.device.createBuffer({
            label: "indexBuffer",
            size: indexBufferSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        })

        // 3. Readback buffers
        const cellActiveRead = this.device.createBuffer({
            label: "cellActiveReadBuffer",
            size: cellActiveBufferSize,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        })
        const triCountRead = this.device.createBuffer({
            label: "triCountReadBuffer",
            size: triCountBufferSize,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        })
        const vertexRead = this.device.createBuffer({
            label: "vertexReadBuffer",
            size: vertexBufferSize,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        })
        const indexRead = this.device.createBuffer({
            label: "indexReadBuffer",
            size: indexBufferSize,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        })

        // 4. Pipeline setup
        const bindGroupLayout = this.device.createBindGroupLayout({
            label: "odc_bind_group_layout",
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
            ],
        })
        const pipelineLayout = this.device.createPipelineLayout({
            label: "odc_pipeline_layout",
            bindGroupLayouts: [bindGroupLayout],
        })
        const classifyPipeline = this.device.createComputePipeline({
            label: "odc_classify_pipeline",
            layout: pipelineLayout,
            compute: { module: sceneShader, entryPoint: "classifyPass" },
        })
        const countPipeline = this.device.createComputePipeline({
            label: "odc_count_pipeline",
            layout: pipelineLayout,
            compute: { module: sceneShader, entryPoint: "countPass" },
        })
        const emitPipeline = this.device.createComputePipeline({
            label: "odc_emit_pipeline",
            layout: pipelineLayout,
            compute: { module: sceneShader, entryPoint: "emissionPass" },
        })
        const bindGroup = this.device.createBindGroup({
            label: "odc_bind_group",
            layout: bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: uniformBuffer } },
                { binding: 1, resource: { buffer: cellActiveBuffer } },
                { binding: 2, resource: { buffer: triCountBuffer } },
                { binding: 3, resource: { buffer: vertexBuffer } },
                { binding: 4, resource: { buffer: indexBuffer } },
            ],
        })

        // 5. Dispatch
        const encoder: GPUCommandEncoder = this.device.createCommandEncoder({ label: "odc_command_encoder" })
        const pass = encoder.beginComputePass({ label: "odc_compute_pass" })
        pass.setPipeline(classifyPipeline)
        pass.setBindGroup(0, bindGroup)
        pass.dispatchWorkgroups(Math.ceil(dimX / 8), Math.ceil(dimY / 8), Math.ceil(dimZ / 4))
        pass.setPipeline(countPipeline)
        pass.dispatchWorkgroups(Math.ceil(dimX / 8), Math.ceil(dimY / 8), Math.ceil(dimZ / 4))
        pass.setPipeline(emitPipeline)
        pass.dispatchWorkgroups(Math.ceil(dimX / 8), Math.ceil(dimY / 8), Math.ceil(dimZ / 4))
        pass.end()

        // 6. Copy to staging
        encoder.copyBufferToBuffer(cellActiveBuffer, 0, cellActiveRead, 0, cellActiveBufferSize)
        encoder.copyBufferToBuffer(triCountBuffer, 0, triCountRead, 0, triCountBufferSize)
        encoder.copyBufferToBuffer(vertexBuffer, 0, vertexRead, 0, vertexBufferSize)
        encoder.copyBufferToBuffer(indexBuffer, 0, indexRead, 0, indexBufferSize)
        this.device.queue.submit([encoder.finish()])

        // 7. Map and read
        await Promise.all([
            cellActiveRead.mapAsync(GPUMapMode.READ),
            triCountRead.mapAsync(GPUMapMode.READ),
            vertexRead.mapAsync(GPUMapMode.READ),
            indexRead.mapAsync(GPUMapMode.READ),
        ])
        const triCountArray = new Uint32Array(triCountRead.getMappedRange())
        const vertexArray = new Float32Array(vertexRead.getMappedRange())
        const indexArray = new Uint32Array(indexRead.getMappedRange())
        console.log("triCountArray", triCountArray)
        console.log("vertexArray", vertexArray)
        console.log("indexArray", indexArray)

        // 8. Write binary STL
        let totalTris = 0
        for (let c = 0; c < cellCount; c++) totalTris += triCountArray[c]
        const writable = await (outputFile as any).createWritable()
        await writable.write(new Uint8Array(80))
        await writable.write(new Uint8Array(new Uint32Array([totalTris]).buffer))
        for (let cell = 0; cell < cellCount; cell++) {
            const triCount = triCountArray[cell]
            const base = cell * maxIndicesPerCell
            for (let t = 0; t < triCount; t++) {
                const i0 = indexArray[base + t * 3]
                const i1 = indexArray[base + t * 3 + 1]
                const i2 = indexArray[base + t * 3 + 2]
                const v0 = [vertexArray[i0 * 3], vertexArray[i0 * 3 + 1], vertexArray[i0 * 3 + 2]]
                const v1 = [vertexArray[i1 * 3], vertexArray[i1 * 3 + 1], vertexArray[i1 * 3 + 2]]
                const v2 = [vertexArray[i2 * 3], vertexArray[i2 * 3 + 1], vertexArray[i2 * 3 + 2]]
                const ux = v1[0] - v0[0],
                    uy = v1[1] - v0[1],
                    uz = v1[2] - v0[2]
                const vx = v2[0] - v0[0],
                    vy = v2[1] - v0[1],
                    vz = v2[2] - v0[2]
                let nx = uy * vz - uz * vy,
                    ny = uz * vx - ux * vz,
                    nz = ux * vy - uy * vx
                const len = Math.hypot(nx, ny, nz) || 1
                nx /= len
                ny /= len
                nz /= len
                const triBuf = new Float32Array([nx, ny, nz, v0[0], v0[1], v0[2], v1[0], v1[1], v1[2], v2[0], v2[1], v2[2]])
                await writable.write(new Uint8Array(triBuf.buffer))
                await writable.write(new Uint8Array([0, 0]))
            }
        }
        await writable.close()
    }
}
