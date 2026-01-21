import { GPUHelper } from "../gpu/helper.mjs"
import { MeshData } from "./export.mjs"

// Matches `Vertex` in `zslice.wgsl`: vec3f position + vec3f normal with std430 padding => 32 bytes stride.
export const SIZEOF_VERTEX = 8 * Float32Array.BYTES_PER_ELEMENT // 32 bytes

export interface ZSliceParams {
    // Bounds in world units (mm).
    minX: number
    minY: number
    minZ: number
    sizeX: number
    sizeY: number
    sizeZ: number

    // Sampling steps in mm. Per request, default zStep should be 0.02mm.
    stepX: number
    stepY: number
    stepZ: number

    isoValue: number
}

export class ZSliceExport {
    #helper: GPUHelper
    #device: GPUDevice
    constructor(helper: GPUHelper, private params: ZSliceParams) {
        this.#helper = helper
        this.#device = helper.device
    }

    async export(zsliceShaderModule: GPUShaderModule): Promise<MeshData> {
        const { minX, minY, minZ, sizeX, sizeY, sizeZ, stepX, stepY, stepZ, isoValue } = this.params

        // Sample point counts (cells + 1).
        const gridX = Math.max(2, Math.floor(sizeX / stepX) + 1)
        const gridY = Math.max(2, Math.floor(sizeY / stepY) + 1)
        const gridZ = Math.max(2, Math.floor(sizeZ / stepZ) + 1)

        const cellX = gridX - 1
        const cellY = gridY - 1
        const cellZ = gridZ - 1

        console.log(
            `ZSliceExport.export(): grid=${gridX}x${gridY}x${gridZ} steps=(${stepX},${stepY},${stepZ}) iso=${isoValue} offset=(${minX},${minY},${minZ})`
        )

        // SharedUniforms layout in WGSL:
        // struct SharedUniforms {
        //   gridDims: vec4u;    // 16
        //   gridOffset: vec4f; // 16
        //   steps: vec4f;      // 16
        // } total 48 bytes
        const sharedUniformData = new ArrayBuffer(48)
        new Uint32Array(sharedUniformData, 0, 4).set([gridX, gridY, gridZ, 0])
        new Float32Array(sharedUniformData, 16, 4).set([minX, minY, minZ, 0])
        new Float32Array(sharedUniformData, 32, 4).set([stepX, stepY, stepZ, isoValue])

        const sharedUniformBuffer = this.#helper.createBuffer(
            "ZSlice.Uniforms",
            sharedUniformData.byteLength,
            GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        )
        this.#device.queue.writeBuffer(sharedUniformBuffer, 0, sharedUniformData)

        // Counters (atomics in WGSL storage address space).
        const triangleCountBuffer = this.#helper.createBuffer(
            "ZSlice.TriangleCount",
            Uint32Array.BYTES_PER_ELEMENT,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
        )
        const vertexCountBuffer = this.#helper.createBuffer(
            "ZSlice.VertexCount",
            Uint32Array.BYTES_PER_ELEMENT,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
        )

        // Pipelines
        const pCount = this.#helper.createComputePipeline(zsliceShaderModule, "countAllSlabsTriangles3D")
        const pEmit = this.#helper.createComputePipeline(zsliceShaderModule, "emitAllSlabsTriangles3D")

        const bindCount = this.#helper.createBindGroup(0, "ZSlice.BindCount", pCount, [0, sharedUniformBuffer], [
            5,
            triangleCountBuffer,
        ])

        // --- Pass 1: count triangles ---
        this.#device.queue.writeBuffer(triangleCountBuffer, 0, new Uint32Array([0]))
        {
            const ce = this.#device.createCommandEncoder({ label: "zslice_count" })
            const pass = this.#helper.beginComputePass(ce, pCount, bindCount)
            pass.dispatchWorkgroups(Math.ceil(cellX / 4), Math.ceil(cellY / 4), Math.ceil(cellZ / 4))
            pass.end()
            this.#device.queue.submit([ce.finish()])
            await this.#device.queue.onSubmittedWorkDone()
        }

        const triCountData = await this.#helper.readBufferData(triangleCountBuffer, Uint32Array.BYTES_PER_ELEMENT)
        const triCount = new Uint32Array(triCountData)[0]! >>> 0
        console.log(`ZSlice triangles: ${triCount}`)

        if (triCount === 0) {
            return { verts: new Float32Array(), tris: new Uint32Array() }
        }

        // Triangle soup: 3 vertices per triangle, 1 index per vertex (0..N-1).
        const vertexCapacity = triCount * 3
        const verticesBuffer = this.#helper.createBuffer(
            "ZSlice.Vertices",
            vertexCapacity * SIZEOF_VERTEX,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        )
        const indicesBuffer = this.#helper.createBuffer(
            "ZSlice.Indices",
            vertexCapacity * Uint32Array.BYTES_PER_ELEMENT,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        )

        const bindEmit = this.#helper.createBindGroup(
            0,
            "ZSlice.BindEmit",
            pEmit,
            [0, sharedUniformBuffer],
            [6, vertexCountBuffer],
            [7, verticesBuffer],
            [8, indicesBuffer]
        )

        // --- Pass 2: emit triangles ---
        this.#device.queue.writeBuffer(vertexCountBuffer, 0, new Uint32Array([0]))
        {
            const ce = this.#device.createCommandEncoder({ label: "zslice_emit" })
            const pass = this.#helper.beginComputePass(ce, pEmit, bindEmit)
            pass.dispatchWorkgroups(Math.ceil(cellX / 4), Math.ceil(cellY / 4), Math.ceil(cellZ / 4))
            pass.end()
            this.#device.queue.submit([ce.finish()])
            await this.#device.queue.onSubmittedWorkDone()
        }

        const vCountData = await this.#helper.readBufferData(vertexCountBuffer, Uint32Array.BYTES_PER_ELEMENT)
        const rawVertexCount = new Uint32Array(vCountData)[0]! >>> 0
        const actualVertexCount = Math.min(rawVertexCount, vertexCapacity)
        const actualIndexCount = actualVertexCount

        console.log(
            `ZSlice vertices: ${actualVertexCount}${rawVertexCount !== actualVertexCount ? ` (clamped from ${rawVertexCount})` : ""}`
        )

        const vertsData = await this.#helper.readBufferData(verticesBuffer, actualVertexCount * SIZEOF_VERTEX)
        const trisData = await this.#helper.readBufferData(indicesBuffer, actualIndexCount * Uint32Array.BYTES_PER_ELEMENT)

        return {
            verts: new Float32Array(vertsData),
            tris: new Uint32Array(trisData),
        }
    }
}

