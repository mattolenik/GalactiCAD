import { GPUHelper } from "./gpu/helper.mjs"

/**
 * Represents a 3D vertex with position and normal.
 * Matches the Vertex struct in WGSL.
 * Size: 2 vec3f = 2 * 3 * 4 = 24 bytes.
 * WGSL vec3f in storage buffers often aligns to 16 bytes.
 * If so, position (12 bytes, padded to 16), normal (12 bytes, padded to 16). Total 32 bytes.
 * For simplicity and common packing, we'll assume 24 bytes here for ArrayBuffer views,
 * but be mindful of actual device alignment requirements if issues arise.
 * Let's assume natural packing: position vec3f (12 bytes), normal vec3f (12 bytes). Total 24 bytes.
 */
interface Vertex {
    position: [number, number, number]
    normal: [number, number, number]
}

const SIZEOF_VERTEX = 6 * Float32Array.BYTES_PER_ELEMENT // 24 bytes

/**
 * Represents QEF data.
 * Matches QEFData struct in WGSL.
 * ATA: mat3x3f (typically 3 columns, each a vec3f padded to vec4f in UBO/SSBO -> 3 * 4 * 4 = 48 bytes)
 * ATb: vec3f (padded to vec4f -> 4 * 4 = 16 bytes)
 * massPoint: vec3f (padded to vec4f -> 4 * 4 = 16 bytes)
 * numPoints: u32 (4 bytes)
 * Total: 48 + 16 + 16 + 4 = 84 bytes. Padded to align to largest member (16 bytes for vec4f layout) -> 96 bytes.
 * Let's assume this structured layout.
 */
const SIZEOF_QEFDATA = (3 * 4 + 3 + 1) * Float32Array.BYTES_PER_ELEMENT // mat3x3f (3*vec4f) + vec3f + vec3f + u32 -> (12+3+3+1)*4 = 76, pad to 80 or 96.
// More precise: mat3x3 (48), vec3 (16), vec3 (16), u32 (4). Total = 84. Align to 16 => 96 bytes.
const SIZEOF_QEFDATA_ATA = 3 * 4 * Float32Array.BYTES_PER_ELEMENT // 48 bytes
const SIZEOF_QEFDATA_ATB = 3 * Float32Array.BYTES_PER_ELEMENT // 12 bytes
const SIZEOF_QEFDATA_MASSPOINT = 3 * Float32Array.BYTES_PER_ELEMENT // 12 bytes
const SIZEOF_QEFDATA_NUMPOINTS = 1 * Uint32Array.BYTES_PER_ELEMENT // 4 bytes
// Assuming std430 packing for SSBOs:
// mat3x3f: 3 columns of vec3f. Each vec3f is 12 bytes. Total 36 bytes. Alignment of vec3f is 16. So columns might be 16 byte stride. 3*16 = 48 bytes.
// vec3f: 12 bytes. Alignment 16.
// QEFData:
// ATA: mat3x3f - offset 0, size 48 (align 16)
// ATb: vec3f - offset 48, size 12 (align 16, so next is 48+16=64)
// massPoint: vec3f - offset 64, size 12 (align 16, so next is 64+16=80)
// numPoints: u32 - offset 80, size 4 (align 4)
// Total size of QEFData: 84 bytes. Padded to multiple of 16 (largest alignment) = 96 bytes.
const SIZEOF_QEFDATA_STRUCT = 96

/**
 * Represents an edge crossing.
 * Matches EdgeCrossing struct in WGSL.
 * position: vec3f (12 bytes)
 * normal: vec3f (12 bytes)
 * Total: 24 bytes. (Similar to Vertex, could be 32 if vec3s are padded to 16 byte alignment).
 * Assuming 24 bytes.
 */
const SIZEOF_EDGECROSSING = 6 * Float32Array.BYTES_PER_ELEMENT // 24 bytes

export interface MDCParams {
    gridDimX: number
    gridDimY: number
    gridDimZ: number
    isoValue: number
    gridOffsetX: number
    gridOffsetY: number
    gridOffsetZ: number
    voxelSize: number
}

export class MDCExport {
    #helper: GPUHelper
    #device: GPUDevice
    constructor(helper: GPUHelper, private params: MDCParams) {
        this.#helper = helper
        this.#device = helper.device
    }

    async export(mdcShaderModule: GPUShaderModule): Promise<void> {
        const { gridDimX, gridDimY, gridDimZ, isoValue, gridOffsetX, gridOffsetY, gridOffsetZ, voxelSize } = this.params

        // Calculate grid totals
        const totalGridCells = gridDimX * gridDimY * gridDimZ
        const totalU32sInFlags = Math.ceil(totalGridCells / 32)

        // Max possible active cells is totalGridCells. Used for initial buffer sizing.
        const maxActiveCells = totalGridCells
        // Max possible triangles: each active cell can (in theory) generate quads on 3 faces = 6 triangles.
        const maxTriangles = maxActiveCells * 6
        const maxIndices = maxTriangles * 3

        // --- 1. Create Buffers ---
        // Uniform Buffer
        const uniformBufferSize = 16 + 4 + 4 + 16 + 4 + 4 // vec3u + f32 + pad + vec3f + f32 + pad (std140 alignment)
        // gridDimensions: vec3u (align 16 in std140 due to vec3) -> 12 bytes, use 16
        // isoValue: f32 (align 4) -> 4 bytes
        // gridOffset: vec3f (align 16) -> 12 bytes, use 16
        // voxelSize: f32 (align 4) -> 4 bytes
        // Corrected UBO layout for std140:
        // gridDimensions: vec3u (offset 0, size 12, baseAlign 16)
        // isoValue: f32 (offset 16, size 4, baseAlign 4)
        // gridOffset: vec3f (offset 32, size 12, baseAlign 16)
        // voxelSize: f32 (offset 48, size 4, baseAlign 4)
        // Total size: 52 bytes, padded to next multiple of 16 -> 64 bytes.
        const uniformBufferData = new ArrayBuffer(64)
        new Uint32Array(uniformBufferData, 0, 3).set([gridDimX, gridDimY, gridDimZ])
        new Float32Array(uniformBufferData, 16, 1).set([isoValue])
        new Float32Array(uniformBufferData, 32, 3).set([gridOffsetX, gridOffsetY, gridOffsetZ])
        new Float32Array(uniformBufferData, 48, 1).set([voxelSize])

        const uniformBuffer = this.#helper.createBuffer(
            "Uniforms",
            uniformBufferData.byteLength,
            GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        )
        this.#device.queue.writeBuffer(uniformBuffer, 0, uniformBufferData)

        // Pass 1 Buffers
        const activeCellFlagsBuffer = this.#helper.createBuffer(
            "ActiveCellFlags",
            totalU32sInFlags * Uint32Array.BYTES_PER_ELEMENT,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
        )

        // Pass 2 Buffers
        // activeCellIndices_compaction needs to be large enough for:
        // 1. Counts: totalU32sInFlags elements
        // 2. Workgroup totals for prefix sum: ceil(totalU32sInFlags / 256) elements
        // 3. Final compacted indices: maxActiveCells elements
        const sizeForCountsAndTotals = (totalU32sInFlags + Math.ceil(totalU32sInFlags / 256)) * Uint32Array.BYTES_PER_ELEMENT
        const sizeForCompactedIndices = maxActiveCells * Uint32Array.BYTES_PER_ELEMENT
        const activeCellIndicesCompactionBufferSize = Math.max(sizeForCountsAndTotals, sizeForCompactedIndices)
        const activeCellIndicesCompactionBuffer = this.#helper.createBuffer(
            "ActiveCellIndicesCompaction",
            activeCellIndicesCompactionBufferSize,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
        )

        const activeCellCountCompactionBuffer = this.#helper.createBuffer(
            "ActiveCellCountCompaction",
            Uint32Array.BYTES_PER_ELEMENT,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
        )

        // Pass 3 Buffers
        const edgeCrossingsXBuffer = this.#helper.createBuffer(
            "EdgeCrossingsX",
            maxActiveCells * SIZEOF_EDGECROSSING,
            GPUBufferUsage.STORAGE
        ) // Max possible, actual depends on grid dim
        const edgeCrossingsYBuffer = this.#helper.createBuffer(
            "EdgeCrossingsY",
            maxActiveCells * SIZEOF_EDGECROSSING,
            GPUBufferUsage.STORAGE
        )
        const edgeCrossingsZBuffer = this.#helper.createBuffer(
            "EdgeCrossingsZ",
            maxActiveCells * SIZEOF_EDGECROSSING,
            GPUBufferUsage.STORAGE
        )
        const cellQEFDataBuffer = this.#helper.createBuffer(
            "CellQEFData",
            maxActiveCells * SIZEOF_QEFDATA_STRUCT,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        )

        // Pass 4 Buffers
        const verticesBuffer = this.#helper.createBuffer(
            "Vertices",
            maxActiveCells * SIZEOF_VERTEX,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        )

        // Pass 5 Buffers
        const triangleOffsetsBuffer = this.#helper.createBuffer(
            "TriangleOffsets",
            maxActiveCells * Uint32Array.BYTES_PER_ELEMENT,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        )
        const indexCountFaceBuffer = this.#helper.createBuffer(
            "IndexCountFace",
            Uint32Array.BYTES_PER_ELEMENT,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
        )
        const indicesBuffer = this.#helper.createBuffer(
            "Indices",
            maxIndices * Uint32Array.BYTES_PER_ELEMENT,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        )

        const p1_cellClassification = this.#helper.createComputePipeline(mdcShaderModule, "cellClassification_Pass1")
        const p2a_countActiveCells = this.#helper.createComputePipeline(mdcShaderModule, "countActiveCells_Pass2a")
        const p2b_prefixSumWorkgroup = this.#helper.createComputePipeline(mdcShaderModule, "prefixSumWorkgroup_Pass2b")
        const p2c_addWorkgroupOffsets = this.#helper.createComputePipeline(mdcShaderModule, "addWorkgroupOffsets_Pass2c")
        const p2d_expandActiveCells = this.#helper.createComputePipeline(mdcShaderModule, "expandActiveCells_Pass2d")
        const p3_edgeDetection = this.#helper.createComputePipeline(mdcShaderModule, "edgeDetection_Pass3")
        const p4_vertexGeneration = this.#helper.createComputePipeline(mdcShaderModule, "vertexGeneration_Pass4")
        const p5a_countTriangles = this.#helper.createComputePipeline(mdcShaderModule, "countTriangles_Pass5a")
        const p5b_prefixSumTriangles = this.#helper.createComputePipeline(mdcShaderModule, "prefixSumTriangles_Pass5b")
        const p5c_generateTriangles = this.#helper.createComputePipeline(mdcShaderModule, "generateTriangles_Pass5c")

        // --- 3. Create Bind Groups ---
        // Bind Group 0 (Uniforms) - used by many passes, create once
        const bindGroup0 = this.#helper.createBindGroup(0, "BindGroup0 Uniforms", p1_cellClassification, [0, uniformBuffer])

        const bindGroupPass1 = this.#helper.createBindGroup(1, "BindGroup Pass1", p1_cellClassification, [0, activeCellFlagsBuffer])

        const bindGroupPass2 = this.#helper.createBindGroup(
            2,
            "BindGroup Pass2",
            p2a_countActiveCells,
            [0, activeCellFlagsBuffer], // activeCellFlagsIn_compaction
            [1, activeCellIndicesCompactionBuffer], // activeCellIndices_compaction
            [2, activeCellCountCompactionBuffer] // activeCellCount_compaction
        )

        const bindGroupPass3 = this.#helper.createBindGroup(
            3,
            "BindGroup Pass3",
            p3_edgeDetection,
            [0, activeCellIndicesCompactionBuffer], // activeCellIndicesIn_edge
            [1, edgeCrossingsXBuffer],
            [2, edgeCrossingsYBuffer],
            [3, edgeCrossingsZBuffer],
            [4, cellQEFDataBuffer], // cellQEFData_edge
            [5, activeCellCountCompactionBuffer] // activeCellCount_edgeInput
        )

        const bindGroupPass4 = this.#helper.createBindGroup(
            4,
            "BindGroup Pass4",
            p4_vertexGeneration,
            [0, activeCellIndicesCompactionBuffer], // activeCellIndicesIn_vertex (can be same as edge)
            [1, cellQEFDataBuffer], // cellQEFDataIn_vertex
            [2, verticesBuffer],
            [3, activeCellCountCompactionBuffer] // activeCellCount_vertexInput
        )

        const bindGroupPass5 = this.#helper.createBindGroup(
            5,
            "BindGroup Pass5",
            p5a_countTriangles,
            [0, activeCellIndicesCompactionBuffer], // activeCellIndicesIn_face
            [1, activeCellFlagsBuffer], // activeCellFlagsInput_face
            [2, indicesBuffer],
            [3, indexCountFaceBuffer],
            [4, triangleOffsetsBuffer],
            [5, activeCellCountCompactionBuffer] // activeCellCount_faceInput
        )

        // --- 4. Encode and Submit Commands ---
        const ce = this.#device.createCommandEncoder({ label: "computeMDC" })

        // Pass 1: Cell Classification
        let passEncoder = this.#helper.beginComputePass(ce, p1_cellClassification, bindGroup0, bindGroupPass1)
        passEncoder.dispatchWorkgroups(Math.ceil(totalU32sInFlags / 32)) // WGSL has @workgroup_size(32,1,1) but totalGridCells / 32 dispatches. totalU32sInFlags is already totalGridCells/32 essentially.
        passEncoder.end()

        // Pass 2a: Count Active Cells
        passEncoder = this.#helper.beginComputePass(ce, p2a_countActiveCells, bindGroup0, bindGroupPass2)
        passEncoder.dispatchWorkgroups(Math.ceil(totalU32sInFlags / 256))
        passEncoder.end()

        // Pass 2b: Prefix Sum Workgroup
        passEncoder = this.#helper.beginComputePass(ce, p2b_prefixSumWorkgroup, bindGroup0, bindGroupPass2)
        passEncoder.dispatchWorkgroups(Math.ceil(totalU32sInFlags / 256))
        passEncoder.end()

        // Pass 2c: Add Workgroup Offsets
        // Note: The WGSL for 2c has limitations for >256 blocks if not careful.
        passEncoder = this.#helper.beginComputePass(ce, p2c_addWorkgroupOffsets, bindGroup0, bindGroupPass2)
        passEncoder.dispatchWorkgroups(Math.ceil(totalU32sInFlags / 256))
        passEncoder.end()

        // Pass 2d: Expand Active Cells
        passEncoder = this.#helper.beginComputePass(ce, p2d_expandActiveCells, bindGroup0, bindGroupPass2)
        passEncoder.dispatchWorkgroups(Math.ceil(totalU32sInFlags / 256))
        passEncoder.end()

        // Pass 3: Edge Detection
        // Dispatching based on maxActiveCells. Shader should handle out-of-bounds if actual count is lower.
        passEncoder = this.#helper.beginComputePass(ce, p3_edgeDetection, bindGroup0, bindGroupPass3)
        passEncoder.dispatchWorkgroups(Math.ceil(maxActiveCells / 64))
        passEncoder.end()

        // Pass 4: Vertex Generation
        passEncoder = this.#helper.beginComputePass(ce, p4_vertexGeneration, bindGroup0, bindGroupPass4)
        passEncoder.dispatchWorkgroups(Math.ceil(maxActiveCells / 64))
        passEncoder.end()

        // Pass 5a: Count Triangles
        passEncoder = this.#helper.beginComputePass(ce, p5a_countTriangles, bindGroup0, bindGroupPass5)
        passEncoder.dispatchWorkgroups(Math.ceil(maxActiveCells / 64))
        passEncoder.end()

        // Pass 5b: Prefix Sum Triangles
        // Note: WGSL for 5b also has limitations for >256 active cells if not part of a larger scan.
        passEncoder = this.#helper.beginComputePass(ce, p5b_prefixSumTriangles, bindGroup0, bindGroupPass5)
        passEncoder.dispatchWorkgroups(Math.ceil(maxActiveCells / 256))
        passEncoder.end()

        // Pass 5c: Generate Triangles
        passEncoder = this.#helper.beginComputePass(ce, p5c_generateTriangles, bindGroup0, bindGroupPass5)
        passEncoder.dispatchWorkgroups(Math.ceil(maxActiveCells / 64))
        passEncoder.end()

        this.#device.queue.submit([ce.finish()])
        await this.#device.queue.onSubmittedWorkDone() // Wait for GPU to finish processing

        // --- 5. Readback and Print Results ---
        console.log("Reading back data from GPU...")

        const activeCountData = await this.#helper.readBufferData(activeCellCountCompactionBuffer)
        const actualActiveCellCount = new Uint32Array(activeCountData)[0]
        console.log(`Actual Active Cell Count: ${actualActiveCellCount}`)

        const indexCountData = await this.#helper.readBufferData(indexCountFaceBuffer)
        const actualIndexCount = new Uint32Array(indexCountData)[0]
        console.log(`Actual Index Count: ${actualIndexCount}`)

        if (actualActiveCellCount > 0) {
            const verticesData = await this.#helper.readBufferData(verticesBuffer, actualActiveCellCount * SIZEOF_VERTEX)
            const verts = new Float32Array(verticesData)
            console.log(`Vertices (first ${Math.min(10, actualActiveCellCount)} of ${actualActiveCellCount}):`)
            for (let i = 0; i < Math.min(actualActiveCellCount * (SIZEOF_VERTEX / 4), 10 * (SIZEOF_VERTEX / 4)); i += SIZEOF_VERTEX / 4) {
                console.log(
                    `  Vertex ${i / (SIZEOF_VERTEX / 4)}: P(x:${verts[i].toFixed(3)}, y:${verts[i + 1].toFixed(3)}, z:${verts[
                        i + 2
                    ].toFixed(3)}), N(x:${verts[i + 3].toFixed(3)}, y:${verts[i + 4].toFixed(3)}, z:${verts[i + 5].toFixed(3)})`
                )
            }
        } else {
            console.log("No active cells, so no vertices generated.")
        }

        if (actualIndexCount > 0) {
            const indicesData = await this.#helper.readBufferData(indicesBuffer, actualIndexCount * Uint32Array.BYTES_PER_ELEMENT)
            const tris = new Uint32Array(indicesData)
            console.log(`Triangle Indices (first ${Math.min(10, actualIndexCount / 3)} triangles of ${actualIndexCount / 3}):`)
            for (let i = 0; i < Math.min(actualIndexCount, 30); i += 3) {
                console.log(`  Triangle ${i / 3}: (${tris[i]}, ${tris[i + 1]}, ${tris[i + 2]})`)
            }
        } else {
            console.log("No indices generated.")
        }

        // --- Cleanup (Important for long-running apps) ---
        uniformBuffer.destroy()
        activeCellFlagsBuffer.destroy()
        activeCellIndicesCompactionBuffer.destroy()
        activeCellCountCompactionBuffer.destroy()
        edgeCrossingsXBuffer.destroy()
        edgeCrossingsYBuffer.destroy()
        edgeCrossingsZBuffer.destroy()
        cellQEFDataBuffer.destroy()
        verticesBuffer.destroy()
        triangleOffsetsBuffer.destroy()
        indexCountFaceBuffer.destroy()
        indicesBuffer.destroy()

        console.log("MDC export process finished.")
        console.log("MDC export process finished.")
    }
}
