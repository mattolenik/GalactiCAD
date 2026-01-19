import { saveSTLBufferToDisk } from "./fs/fs.mjs"
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

// WGSL storage-buffer layout: vec3f has Align=16, Size=12.
// struct Vertex { position: vec3f; normal: vec3f; }
// => position @0..11 (pad to 16), normal @16..27 (pad to 32) => 32-byte stride.
const SIZEOF_VERTEX = 8 * Float32Array.BYTES_PER_ELEMENT // 32 bytes

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
// Same alignment story as Vertex (two vec3f fields) => 32-byte stride in storage buffers.
const SIZEOF_EDGECROSSING = 8 * Float32Array.BYTES_PER_ELEMENT // 32 bytes

// Proper Manifold Dual Contouring may require multiple vertices per active cell.
// We use a fixed maximum for predictable GPU memory layout.
const MAX_COMPONENTS_PER_CELL = 4

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
        // Uniform Buffer layout MUST match WGSL "uniform address space layout" rules.
        //
        // WGSL types here:
        // - vec3<u32>/vec3<f32>: Align 16, Size 12
        // - f32: Align 4, Size 4
        //
        // For this struct:
        // struct SharedUniforms {
        //   gridDimensions: vec3u,  // offset 0,  size 12
        //   isoValue: f32,          // offset 12, size 4
        //   gridOffset: vec3f,      // offset 16, size 12
        //   voxelSize: f32,         // offset 28, size 4
        // } // total size rounds up to 32
        const uniformBufferData = new ArrayBuffer(32)
        new Uint32Array(uniformBufferData, 0, 3).set([gridDimX, gridDimY, gridDimZ])
        new Float32Array(uniformBufferData, 12, 1).set([isoValue])
        new Float32Array(uniformBufferData, 16, 3).set([gridOffsetX, gridOffsetY, gridOffsetZ])
        new Float32Array(uniformBufferData, 28, 1).set([voxelSize])

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
        // activeCellIndices_compaction layout (single buffer, non-overlapping regions):
        // - [0 .. totalU32sInFlags)                         : counts / prefix sums (Pass 2a-2c)
        // - [totalU32sInFlags .. totalU32sInFlags+numWg)    : workgroup totals (Pass 2b)
        // - [baseOffset .. baseOffset+maxActiveCells)       : compacted active cell indices (Pass 2d)
        const numWorkgroupsForCounts = Math.ceil(totalU32sInFlags / 256)
        const baseOffsetU32 = totalU32sInFlags + numWorkgroupsForCounts
        const activeCellIndicesCompactionBufferSize =
            (baseOffsetU32 + maxActiveCells) * Uint32Array.BYTES_PER_ELEMENT
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
        // Explicitly initialize to 0 (though WebGPU buffers are zero-initialized by default)
        this.#device.queue.writeBuffer(activeCellCountCompactionBuffer, 0, new Uint32Array([0]))

        // Pass 3 Buffers
        const cellEdgeComponentsBuffer = this.#helper.createBuffer(
            "CellEdgeComponents",
            maxActiveCells * 12 * Uint32Array.BYTES_PER_ELEMENT,
            GPUBufferUsage.STORAGE
        )
        const cellToActiveIndexBuffer = this.#helper.createBuffer(
            "CellToActiveIndex",
            totalGridCells * Uint32Array.BYTES_PER_ELEMENT,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        )
        // Initialize mapping to 0xffffffff (invalid)
        const cellToActiveInit = new Uint32Array(totalGridCells)
        cellToActiveInit.fill(0xffffffff)
        this.#device.queue.writeBuffer(cellToActiveIndexBuffer, 0, cellToActiveInit)
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
            maxActiveCells * MAX_COMPONENTS_PER_CELL * SIZEOF_QEFDATA_STRUCT,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        )

        // Pass 4 Buffers
        const verticesBuffer = this.#helper.createBuffer(
            "Vertices",
            maxActiveCells * MAX_COMPONENTS_PER_CELL * SIZEOF_VERTEX,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        )

        // Pass 5 Buffers
        const triangleOffsetsBuffer = this.#helper.createBuffer(
            "TriangleOffsets",
            maxActiveCells * Uint32Array.BYTES_PER_ELEMENT,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        )
        const triangleWorkgroupOffsetsBuffer = this.#helper.createBuffer(
            "TriangleWorkgroupOffsets",
            Math.ceil(maxActiveCells / 256) * Uint32Array.BYTES_PER_ELEMENT,
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
        const p2e_buildCellToActiveIndex = this.#helper.createComputePipeline(
            mdcShaderModule,
            "buildCellToActiveIndex_Pass2e"
        )
        const p3_edgeDetection = this.#helper.createComputePipeline(mdcShaderModule, "edgeDetection_Pass3")
        const p4_vertexGeneration = this.#helper.createComputePipeline(mdcShaderModule, "vertexGeneration_Pass4")
        const p5a_countTriangles = this.#helper.createComputePipeline(mdcShaderModule, "countTriangles_Pass5a")
        const p5b_prefixSumTriangles = this.#helper.createComputePipeline(mdcShaderModule, "prefixSumTriangles_Pass5b")
        const p5b2_prefixSumTriangleWorkgroups = this.#helper.createComputePipeline(
            mdcShaderModule,
            "prefixSumTriangleWorkgroups_Pass5b2"
        )
        const p5b3_addTriangleWorkgroupOffsets = this.#helper.createComputePipeline(
            mdcShaderModule,
            "addTriangleWorkgroupOffsets_Pass5b3"
        )
        const p5c_generateTriangles = this.#helper.createComputePipeline(mdcShaderModule, "generateTriangles_Pass5c")

        // --- 3. Create Bind Groups ---
        // Bind Group 0 (Uniforms) - used by many passes, create once

        const bindGroupPass1 = this.#helper.createBindGroup(
            0,
            "BindGroup Pass1",
            p1_cellClassification,
            [0, uniformBuffer],
            [1, activeCellFlagsBuffer]
        )

        const bindGroupPass2a = this.#helper.createBindGroup(
            0,
            "BindGroup Pass2a",
            p2a_countActiveCells,
            [0, uniformBuffer],
            [2, activeCellFlagsBuffer], // activeCellFlagsIn_compaction
            [3, activeCellIndicesCompactionBuffer] // activeCellIndices_compaction
        )
        const bindGroupPass2b = this.#helper.createBindGroup(
            0,
            "BindGroup Pass2b",
            p2b_prefixSumWorkgroup,
            [0, uniformBuffer],
            [3, activeCellIndicesCompactionBuffer] // activeCellIndices_compaction
        )
        const bindGroupPass2c = this.#helper.createBindGroup(
            0,
            "BindGroup Pass2c",
            p2c_addWorkgroupOffsets,
            [0, uniformBuffer],
            [3, activeCellIndicesCompactionBuffer] // activeCellIndices_compaction
        )
        const bindGroupPass2d = this.#helper.createBindGroup(
            0,
            "BindGroup Pass2d",
            p2d_expandActiveCells,
            [0, uniformBuffer],
            [2, activeCellFlagsBuffer], // activeCellFlagsIn_compaction
            [3, activeCellIndicesCompactionBuffer], // activeCellIndices_compaction
            [4, activeCellCountCompactionBuffer] // activeCellCount_compaction
        )
        const bindGroupPass2e = this.#helper.createBindGroup(
            0,
            "BindGroup Pass2e",
            p2e_buildCellToActiveIndex,
            [0, uniformBuffer],
            [3, activeCellIndicesCompactionBuffer],
            [4, activeCellCountCompactionBuffer],
            [23, cellToActiveIndexBuffer]
        )

        const bindGroupPass3 = this.#helper.createBindGroup(
            0,
            "BindGroup Pass3",
            p3_edgeDetection,
            [0, uniformBuffer],
            [5, activeCellIndicesCompactionBuffer], // activeCellIndicesIn_edge
            [22, cellEdgeComponentsBuffer],
            [23, cellToActiveIndexBuffer],
            [6, edgeCrossingsXBuffer],
            [7, edgeCrossingsYBuffer],
            [8, edgeCrossingsZBuffer],
            [9, cellQEFDataBuffer], // cellQEFData_edge
            [10, activeCellCountCompactionBuffer] // activeCellCount_edgeInput
        )

        const bindGroupPass4 = this.#helper.createBindGroup(
            0,
            "BindGroup Pass4",
            p4_vertexGeneration,
            [0, uniformBuffer],
            [11, activeCellIndicesCompactionBuffer], // activeCellIndicesIn_vertex
            [12, cellQEFDataBuffer], // cellQEFDataIn_vertex
            [13, verticesBuffer],
            [14, activeCellCountCompactionBuffer] // activeCellCount_vertexInput
        )

        const bindGroupPass5a = this.#helper.createBindGroup(
            0,
            "BindGroup Pass5a",
            p5a_countTriangles,
            [0, uniformBuffer],
            [15, activeCellIndicesCompactionBuffer], // activeCellIndicesIn_face
            [16, activeCellFlagsBuffer], // activeCellFlagsInput_face
            [22, cellEdgeComponentsBuffer],
            [23, cellToActiveIndexBuffer],
            // [16, indicesBuffer],
            // [17, indexCountFaceBuffer],
            [19, triangleOffsetsBuffer],
            [20, activeCellCountCompactionBuffer] // activeCellCount_faceInput
        )

        const bindGroupPass5b = this.#helper.createBindGroup(
            0,
            "BindGroup Pass5b",
            p5b_prefixSumTriangles,
            [19, triangleOffsetsBuffer],
            [20, activeCellCountCompactionBuffer], // activeCellCount_faceInput
            [21, triangleWorkgroupOffsetsBuffer]
        )
        const bindGroupPass5b2 = this.#helper.createBindGroup(
            0,
            "BindGroup Pass5b2",
            p5b2_prefixSumTriangleWorkgroups,
            [18, indexCountFaceBuffer],
            [20, activeCellCountCompactionBuffer], // activeCellCount_faceInput
            [21, triangleWorkgroupOffsetsBuffer]
        )
        const bindGroupPass5b3 = this.#helper.createBindGroup(
            0,
            "BindGroup Pass5b3",
            p5b3_addTriangleWorkgroupOffsets,
            [19, triangleOffsetsBuffer],
            [20, activeCellCountCompactionBuffer], // activeCellCount_faceInput
            [21, triangleWorkgroupOffsetsBuffer]
        )
        const bindGroupPass5c = this.#helper.createBindGroup(
            0,
            "BindGroup Pass5c",
            p5c_generateTriangles,
            [0, uniformBuffer],
            [15, activeCellIndicesCompactionBuffer], // activeCellIndicesIn_face
            [16, activeCellFlagsBuffer], // activeCellFlagsInput_face
            [22, cellEdgeComponentsBuffer],
            [23, cellToActiveIndexBuffer],
            [17, indicesBuffer],
            [19, triangleOffsetsBuffer],
            [20, activeCellCountCompactionBuffer] // activeCellCount_faceInput
        )
        // --- 4. Encode and Submit Commands ---
        const ce = this.#device.createCommandEncoder({ label: "computeMDC" })

        // Pass 1: Cell Classification
        // Each workgroup processes one u32 block (32 cells), so we need totalU32sInFlags workgroups
        let passEncoder = this.#helper.beginComputePass(ce, p1_cellClassification, bindGroupPass1)
        passEncoder.dispatchWorkgroups(totalU32sInFlags)
        passEncoder.end()

        // Pass 2a: Count Active Cells
        passEncoder = this.#helper.beginComputePass(ce, p2a_countActiveCells, bindGroupPass2a)
        passEncoder.dispatchWorkgroups(Math.ceil(totalU32sInFlags / 256))
        passEncoder.end()

        // Pass 2b: Prefix Sum Workgroup
        passEncoder = this.#helper.beginComputePass(ce, p2b_prefixSumWorkgroup, bindGroupPass2b)
        passEncoder.dispatchWorkgroups(Math.ceil(totalU32sInFlags / 256))
        passEncoder.end()

        // Pass 2c: Add Workgroup Offsets
        // Note: The WGSL for 2c has limitations for >256 blocks if not careful.
        passEncoder = this.#helper.beginComputePass(ce, p2c_addWorkgroupOffsets, bindGroupPass2c)
        passEncoder.dispatchWorkgroups(Math.ceil(totalU32sInFlags / 256))
        passEncoder.end()

        // Pass 2d: Expand Active Cells
        passEncoder = this.#helper.beginComputePass(ce, p2d_expandActiveCells, bindGroupPass2d)
        passEncoder.dispatchWorkgroups(Math.ceil(totalU32sInFlags / 256))
        passEncoder.end()

        // Pass 2e: Build cell->active index mapping
        passEncoder = this.#helper.beginComputePass(ce, p2e_buildCellToActiveIndex, bindGroupPass2e)
        passEncoder.dispatchWorkgroups(Math.ceil(maxActiveCells / 256))
        passEncoder.end()

        // Pass 3: Edge Detection
        // Dispatching based on maxActiveCells. Shader should handle out-of-bounds if actual count is lower.
        passEncoder = this.#helper.beginComputePass(ce, p3_edgeDetection, bindGroupPass3)
        passEncoder.dispatchWorkgroups(Math.ceil(maxActiveCells / 64))
        passEncoder.end()

        // Pass 4: Vertex Generation
        passEncoder = this.#helper.beginComputePass(ce, p4_vertexGeneration, bindGroupPass4)
        passEncoder.dispatchWorkgroups(Math.ceil((maxActiveCells * MAX_COMPONENTS_PER_CELL) / 64))
        passEncoder.end()

        // Pass 5a: Count Triangles
        passEncoder = this.#helper.beginComputePass(ce, p5a_countTriangles, bindGroupPass5a)
        passEncoder.dispatchWorkgroups(Math.ceil(maxActiveCells / 64))
        passEncoder.end()

        // Pass 5b: Prefix Sum Triangles
        // Multi-pass scan:
        // - 5b:  per-workgroup scan of triangle counts; write per-workgroup totals
        // - 5b2: scan workgroup totals; write indexCount
        // - 5b3: add workgroup offsets to per-cell offsets
        passEncoder = this.#helper.beginComputePass(ce, p5b_prefixSumTriangles, bindGroupPass5b)
        passEncoder.dispatchWorkgroups(Math.ceil(maxActiveCells / 256))
        passEncoder.end()
        passEncoder = this.#helper.beginComputePass(ce, p5b2_prefixSumTriangleWorkgroups, bindGroupPass5b2)
        passEncoder.dispatchWorkgroups(1)
        passEncoder.end()
        passEncoder = this.#helper.beginComputePass(ce, p5b3_addTriangleWorkgroupOffsets, bindGroupPass5b3)
        passEncoder.dispatchWorkgroups(Math.ceil(maxActiveCells / 256))
        passEncoder.end()

        // Pass 5c: Generate Triangles
        passEncoder = this.#helper.beginComputePass(ce, p5c_generateTriangles, bindGroupPass5c)
        passEncoder.dispatchWorkgroups(Math.ceil(maxActiveCells / 64))
        passEncoder.end()

        this.#device.queue.submit([ce.finish()])
        await this.#device.queue.onSubmittedWorkDone() // Wait for GPU to finish processing

        // --- 5. Readback and Print Results ---
        console.log("Reading back data from GPU...")

        // Debug: Check flags from Pass 1 to verify cells are being marked as active
        const flagsData = await this.#helper.readBufferData(activeCellFlagsBuffer, totalU32sInFlags * Uint32Array.BYTES_PER_ELEMENT)
        const flagsArray = new Uint32Array(flagsData)
        const popcount32 = (v: number) => {
            // force unsigned 32-bit
            let x = v >>> 0
            x = x - ((x >>> 1) & 0x55555555)
            x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
            return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
        }

        // Summarize first few blocks (quick sanity), and compute totals across all blocks.
        let nonzeroBlocksInFirst10 = 0
        let activeCellsInFirst10 = 0
        for (let i = 0; i < Math.min(flagsArray.length, 10); i++) {
            const count = popcount32(flagsArray[i]!)
            activeCellsInFirst10 += count
            if (flagsArray[i] !== 0) {
                nonzeroBlocksInFirst10++
                console.log(`Flags block ${i}: 0x${(flagsArray[i]! >>> 0).toString(16)} (${count} bits set)`)
            }
        }

        let totalActiveCellsFromFlags = 0
        let firstNonzeroBlock = -1
        for (let i = 0; i < flagsArray.length; i++) {
            const v = flagsArray[i]!
            if (v !== 0 && firstNonzeroBlock === -1) firstNonzeroBlock = i
            totalActiveCellsFromFlags += popcount32(v)
        }

        console.log(`Flags blocks with set bits (first 10): ${nonzeroBlocksInFirst10} of ${Math.min(flagsArray.length, 10)}`)
        console.log(`Active cells from flags (first 10 blocks): ${activeCellsInFirst10}`)
        console.log(`Active cells from flags (ALL blocks): ${totalActiveCellsFromFlags}`)
        if (firstNonzeroBlock === -1) {
            console.warn("WARNING: No active cells found in Pass 1 flags buffer! Check sceneSDF and grid parameters.")
        } else if (firstNonzeroBlock >= 10) {
            console.log(`First nonzero flags block index: ${firstNonzeroBlock}`)
        }

        const activeCountData = await this.#helper.readBufferData(activeCellCountCompactionBuffer)
        const actualActiveCellCount = new Uint32Array(activeCountData)[0]
        console.log(`Actual Active Cell Count: ${actualActiveCellCount}`)

        const indexCountData = await this.#helper.readBufferData(indexCountFaceBuffer)
        const actualIndexCount = new Uint32Array(indexCountData)[0]
        console.log(`Actual Index Count: ${actualIndexCount}`)

        let verts: Float32Array | null = null
        if (actualActiveCellCount > 0) {
            const actualVertexCount = actualActiveCellCount * MAX_COMPONENTS_PER_CELL
            const verticesData = await this.#helper.readBufferData(verticesBuffer, actualVertexCount * SIZEOF_VERTEX)
            verts = new Float32Array(verticesData)
            const previewVertexCount = Math.min(10, actualVertexCount)
            console.log(`Vertices (first ${previewVertexCount} of ${actualVertexCount}):`)
            const stride = SIZEOF_VERTEX / 4 // floats per vertex
            let defaultVertexCount = 0
            for (let i = 0; i < actualVertexCount * stride; i += stride) {
                // Vertex storage layout: position.xyz at [0..2], padding at [3],
                // normal.xyz at [4..6], padding at [7]
                const px = verts[i]!
                const py = verts[i + 1]!
                const pz = verts[i + 2]!
                const nx = verts[i + 4]!
                const ny = verts[i + 5]!
                const nz = verts[i + 6]!
                if (px === 0 && py === 0 && pz === 0 && nx === 0 && ny === 1 && nz === 0) defaultVertexCount++
                if (i / stride < previewVertexCount) {
                    console.log(
                        `  Vertex ${i / stride}: P(x:${px.toFixed(3)}, y:${py.toFixed(3)}, z:${pz.toFixed(
                            3
                        )}), N(x:${nx.toFixed(3)}, y:${ny.toFixed(3)}, z:${nz.toFixed(3)})`
                    )
                }
            }
            console.log(`Default (0,0,0)/(0,1,0) vertices: ${defaultVertexCount} of ${actualVertexCount}`)
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

            // --- 6. Export ASCII STL ---
            if (!verts) {
                console.warn("Cannot export STL: vertex buffer was not read.")
            } else {
                const stride = SIZEOF_VERTEX / 4 // floats per vertex
                const solidName = "galacticad"
                const lines: string[] = []
                lines.push(`solid ${solidName}`)

                const vpos = (vidx: number) => {
                    const base = vidx * stride
                    return [verts![base]!, verts![base + 1]!, verts![base + 2]!] as const
                }
                const sub = (a: readonly [number, number, number], b: readonly [number, number, number]) =>
                    [a[0] - b[0], a[1] - b[1], a[2] - b[2]] as const
                const cross = (a: readonly [number, number, number], b: readonly [number, number, number]) =>
                    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] as const
                const norm = (a: readonly [number, number, number]) => Math.hypot(a[0], a[1], a[2])
                const normalize = (a: readonly [number, number, number]) => {
                    const n = norm(a)
                    if (!isFinite(n) || n === 0) return [0, 0, 0] as const
                    return [a[0] / n, a[1] / n, a[2] / n] as const
                }
                const f3 = (n: number) => (Math.abs(n) < 1e-12 ? "0" : n.toString())

                for (let i = 0; i < tris.length; i += 3) {
                    const i0 = tris[i]!
                    const i1 = tris[i + 1]!
                    const i2 = tris[i + 2]!

                    const p0 = vpos(i0)
                    const p1 = vpos(i1)
                    const p2 = vpos(i2)

                    const nrm = normalize(cross(sub(p1, p0), sub(p2, p0)))

                    lines.push(`  facet normal ${f3(nrm[0])} ${f3(nrm[1])} ${f3(nrm[2])}`)
                    lines.push(`    outer loop`)
                    lines.push(`      vertex ${f3(p0[0])} ${f3(p0[1])} ${f3(p0[2])}`)
                    lines.push(`      vertex ${f3(p1[0])} ${f3(p1[1])} ${f3(p1[2])}`)
                    lines.push(`      vertex ${f3(p2[0])} ${f3(p2[1])} ${f3(p2[2])}`)
                    lines.push(`    endloop`)
                    lines.push(`  endfacet`)
                }

                lines.push(`endsolid ${solidName}`)
                const stlText = lines.join("\n") + "\n"
                const stlBytes = new TextEncoder().encode(stlText)
                await saveSTLBufferToDisk(stlBytes.buffer, `${solidName}.stl`)
                console.log(`Wrote ASCII STL: ${tris.length / 3} triangles`)
            }
        } else {
            console.log("No indices generated.")
        }
        console.log("MDC export process finished.")
    }
}
