function createBuffers(device: GPUDevice) {
    const bufferSize = 16777216 // 16 MB

    const vertexBuffer = device.createBuffer({
        size: bufferSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        mappedAtCreation: false,
    })

    const triangleBuffer = device.createBuffer({
        size: bufferSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        mappedAtCreation: false,
    })

    const triCountBuffer = device.createBuffer({
        size: 4, // atomic<u32>
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        mappedAtCreation: false,
    })

    return { vertexBuffer, triangleBuffer, triCountBuffer }
}

export async function exportSTL(
    device: GPUDevice,
    vertexBuffer: GPUBuffer,
    triangleBuffer: GPUBuffer,
    triCountBuffer: GPUBuffer
): Promise<ArrayBuffer> {
    const readBufferSize = 16777216

    const readVertexBuffer = device.createBuffer({
        size: readBufferSize,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })

    const readTriangleBuffer = device.createBuffer({
        size: readBufferSize,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })

    const readTriCountBuffer = device.createBuffer({
        size: 4,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })

    const commandEncoder = device.createCommandEncoder()

    commandEncoder.copyBufferToBuffer(vertexBuffer, 0, readVertexBuffer, 0, readBufferSize)
    commandEncoder.copyBufferToBuffer(triangleBuffer, 0, readTriangleBuffer, 0, readBufferSize)
    commandEncoder.copyBufferToBuffer(triCountBuffer, 0, readTriCountBuffer, 0, 4)

    device.queue.submit([commandEncoder.finish()])

    await Promise.allSettled([
        readVertexBuffer.mapAsync(GPUMapMode.READ),
        readTriangleBuffer.mapAsync(GPUMapMode.READ),
        readTriCountBuffer.mapAsync(GPUMapMode.READ),
    ])

    const vertices = new Float32Array(readVertexBuffer.getMappedRange())
    const triangles = new Uint32Array(readTriangleBuffer.getMappedRange())
    const triCountArray = new Uint32Array(readTriCountBuffer.getMappedRange())
    const triCount = triCountArray[0]

    const stlSize = 84 + triCount * 50 // 84-byte header + 50 bytes per triangle
    const stlBuffer = new ArrayBuffer(stlSize)
    const dv = new DataView(stlBuffer)

    // 80-byte header (can be blank)
    let offset = 80
    dv.setUint32(offset, triCount, true)
    offset += 4

    for (let i = 0; i < triCount; i++) {
        const idx0 = triangles[i * 3] * 6
        const idx1 = triangles[i * 3 + 1] * 6
        const idx2 = triangles[i * 3 + 2] * 6

        const v0 = vertices.slice(idx0, idx0 + 3)
        const v1 = vertices.slice(idx1, idx1 + 3)
        const v2 = vertices.slice(idx2, idx2 + 3)

        // Compute normal
        const ux = v1[0] - v0[0]
        const uy = v1[1] - v0[1]
        const uz = v1[2] - v0[2]
        const vx = v2[0] - v0[0]
        const vy = v2[1] - v0[1]
        const vz = v2[2] - v0[2]

        const nx = uy * vz - uz * vy
        const ny = uz * vx - ux * vz
        const nz = ux * vy - uy * vx
        const norm = Math.hypot(nx, ny, nz) || 1

        dv.setFloat32(offset, nx / norm, true)
        dv.setFloat32(offset + 4, ny / norm, true)
        dv.setFloat32(offset + 8, nz / norm, true)

        dv.setFloat32(offset + 12, v0[0], true)
        dv.setFloat32(offset + 16, v0[1], true)
        dv.setFloat32(offset + 20, v0[2], true)

        dv.setFloat32(offset + 24, v1[0], true)
        dv.setFloat32(offset + 28, v1[1], true)
        dv.setFloat32(offset + 32, v1[2], true)

        dv.setFloat32(offset + 36, v2[0], true)
        dv.setFloat32(offset + 40, v2[1], true)
        dv.setFloat32(offset + 44, v2[2], true)

        dv.setUint16(offset + 48, 0, true) // attribute byte count
        offset += 50
    }

    readVertexBuffer.unmap()
    readTriangleBuffer.unmap()
    readTriCountBuffer.unmap()

    return stlBuffer
}
