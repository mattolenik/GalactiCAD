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

    async export(sceneShader: GPUShaderModule, sceneArgs: GPUBuffer, outputFile: FileSystemHandle) {
        const { dimX, dimY, dimZ, cellSize, boundsMin, maxTrisPerCell } = this.params
        const cellCount = dimX * dimY * dimZ
        const maxIndicesPerCell = maxTrisPerCell * 3

        // 1. Uniform buffer
        // 1. Uniform buffer (std140-like layout, 64 bytes)
        const uniformBufferSize = 64
        const uniformBuffer = this.device.createBuffer({
            size: uniformBufferSize,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })
        // Pack Params with proper alignment:
        // offset 0: dimX, offset 4: dimY, offset 8: dimZ
        // offset 12: pad
        // offset 16: cellSize.x,y,z (12 bytes), offset 28: pad
        // offset 32: boundsMin.x,y,z (12 bytes), offset 44: pad
        // offset 48: maxTrisPerCell, offsets 52-63: pad
        {
            const arrayBuffer = new ArrayBuffer(uniformBufferSize)
            const dv = new DataView(arrayBuffer)
            dv.setUint32(0, dimX, true)
            dv.setUint32(4, dimY, true)
            dv.setUint32(8, dimZ, true)
            // cellSize at offset 16
            dv.setFloat32(16, cellSize[0], true)
            dv.setFloat32(20, cellSize[1], true)
            dv.setFloat32(24, cellSize[2], true)
            // boundsMin at offset 32
            dv.setFloat32(32, boundsMin[0], true)
            dv.setFloat32(36, boundsMin[1], true)
            dv.setFloat32(40, boundsMin[2], true)
            // maxTrisPerCell at offset 48
            dv.setUint32(48, maxTrisPerCell, true)
            this.device.queue.writeBuffer(uniformBuffer, 0, arrayBuffer)
        }

        // 2. Storage buffers
        const cellActiveBuffer = this.device.createBuffer({
            size: cellCount * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        })
        const triCountBuffer = this.device.createBuffer({
            size: cellCount * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        })
        const vertexBuffer = this.device.createBuffer({
            size: cellCount * 12,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        })
        const indexBuffer = this.device.createBuffer({
            size: cellCount * maxIndicesPerCell * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        })

        // 3. Readback buffers
        const cellActiveRead = this.device.createBuffer({
            size: cellCount * 4,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        })
        const triCountRead = this.device.createBuffer({
            size: cellCount * 4,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        })
        const vertexRead = this.device.createBuffer({
            size: cellCount * 12,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        })
        const indexRead = this.device.createBuffer({
            size: cellCount * maxIndicesPerCell * 4,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        })

        // 4. Pipeline setup
        const bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
            ],
        })
        const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] })
        const classifyPipeline = this.device.createComputePipeline({
            layout: pipelineLayout,
            compute: { module: sceneShader, entryPoint: "classifyPass" },
        })
        const emitPipeline = this.device.createComputePipeline({
            layout: pipelineLayout,
            compute: { module: sceneShader, entryPoint: "emissionPass" },
        })
        const bindGroup = this.device.createBindGroup({
            layout: bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: uniformBuffer } },
                { binding: 1, resource: { buffer: cellActiveBuffer } },
                { binding: 2, resource: { buffer: triCountBuffer } },
                { binding: 3, resource: { buffer: vertexBuffer } },
                { binding: 4, resource: { buffer: indexBuffer } },
                { binding: 5, resource: { buffer: sceneArgs } },
            ],
        })

        // 5. Dispatch
        const encoder: GPUCommandEncoder = this.device.createCommandEncoder()
        const pass = encoder.beginComputePass()
        pass.setPipeline(classifyPipeline)
        pass.setBindGroup(0, bindGroup)
        pass.dispatchWorkgroups(Math.ceil(dimX / 8), Math.ceil(dimY / 8), Math.ceil(dimZ / 4))
        pass.setPipeline(emitPipeline)
        pass.dispatchWorkgroups(Math.ceil(dimX / 8), Math.ceil(dimY / 8), Math.ceil(dimZ / 4))
        pass.end()

        // 6. Copy to staging
        encoder.copyBufferToBuffer(cellActiveBuffer, 0, cellActiveRead, 0, cellCount * 4)
        encoder.copyBufferToBuffer(triCountBuffer, 0, triCountRead, 0, cellCount * 4)
        encoder.copyBufferToBuffer(vertexBuffer, 0, vertexRead, 0, cellCount * 12)
        encoder.copyBufferToBuffer(indexBuffer, 0, indexRead, 0, cellCount * maxIndicesPerCell * 4)
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
        const fileHandle = outputFile as any
        const writable = await fileHandle.createWritable()
        // 80-byte header
        await writable.write(new Uint8Array(80))
        // triangle count
        const headerCount = new Uint32Array([totalTris])
        await writable.write(new Uint8Array(headerCount.buffer))

        // Triangles
        for (let cell = 0; cell < cellCount; cell++) {
            const triCount = triCountArray[cell]
            const base = cell * maxIndicesPerCell
            for (let t = 0; t < triCount; t++) {
                const i0 = indexArray[base + t * 3 + 0]
                const i1 = indexArray[base + t * 3 + 1]
                const i2 = indexArray[base + t * 3 + 2]
                const v0 = [vertexArray[i0 * 3], vertexArray[i0 * 3 + 1], vertexArray[i0 * 3 + 2]]
                const v1 = [vertexArray[i1 * 3], vertexArray[i1 * 3 + 1], vertexArray[i1 * 3 + 2]]
                const v2 = [vertexArray[i2 * 3], vertexArray[i2 * 3 + 1], vertexArray[i2 * 3 + 2]]
                // normal
                let ux = v1[0] - v0[0],
                    uy = v1[1] - v0[1],
                    uz = v1[2] - v0[2]
                let vx = v2[0] - v0[0],
                    vy = v2[1] - v0[1],
                    vz = v2[2] - v0[2]
                let nx = uy * vz - uz * vy
                let ny = uz * vx - ux * vz
                let nz = ux * vy - uy * vx
                const len = Math.hypot(nx, ny, nz) || 1
                nx /= len
                ny /= len
                nz /= len
                // pack triangle
                const triBuf = new Float32Array([nx, ny, nz, v0[0], v0[1], v0[2], v1[0], v1[1], v1[2], v2[0], v2[1], v2[2]])
                await writable.write(new Uint8Array(triBuf.buffer))
                // attribute byte count (0)
                await writable.write(new Uint8Array([0, 0]))
            }
        }
        await writable.close()
    }
}
