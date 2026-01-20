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
        console.log(
            `MDCExport.export(): grid=${gridDimX}x${gridDimY}x${gridDimZ} voxel=${voxelSize} iso=${isoValue} offset=(${gridOffsetX},${gridOffsetY},${gridOffsetZ})`
        )

        // Calculate grid totals
        const totalGridCells = gridDimX * gridDimY * gridDimZ
        const totalU32sInFlags = Math.ceil(totalGridCells / 32)
        const popcount32 = (v: number) => {
            let x = v >>> 0
            x = x - ((x >>> 1) & 0x55555555)
            x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
            return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
        }

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
        const p1_cellClassification = this.#helper.createComputePipeline(mdcShaderModule, "cellClassification_Pass1")

        const bindGroupPass1 = this.#helper.createBindGroup(
            0,
            "BindGroup Pass1",
            p1_cellClassification,
            [0, uniformBuffer],
            [1, activeCellFlagsBuffer]
        )

        // --- Stage 1: classify cells into bit flags ---
        {
            const ce = this.#device.createCommandEncoder({ label: "mdc_pass1" })
            const pass = this.#helper.beginComputePass(ce, p1_cellClassification, bindGroupPass1)

            // Pass1 dispatch is in u32-blocks; for large grids totalU32sInFlags can exceed 65535,
            // so dispatch in 2D and linearize in WGSL using @builtin(num_workgroups).
            const dispatchX = Math.min(totalU32sInFlags, 65535)
            const dispatchY = Math.ceil(totalU32sInFlags / dispatchX)
            pass.dispatchWorkgroups(dispatchX, dispatchY)
            pass.end()

            this.#device.queue.submit([ce.finish()])
            await this.#device.queue.onSubmittedWorkDone()
        }

        // Read back flags and build a compact list on CPU.
        const flagsData = await this.#helper.readBufferData(
            activeCellFlagsBuffer,
            totalU32sInFlags * Uint32Array.BYTES_PER_ELEMENT
        )
        const flagsArray = new Uint32Array(flagsData)

        // Build a compact active cell index list directly from flags.
        // This avoids any mismatch between count and enumeration.
        const activeList: number[] = []
        for (let block = 0; block < flagsArray.length; block++) {
            let v = flagsArray[block]! >>> 0
            if (v === 0) continue
            while (v !== 0) {
                const lsb = (v & -v) >>> 0
                const bit = 31 - Math.clz32(lsb)
                const cellFlatIndex = block * 32 + bit
                if (cellFlatIndex >= totalGridCells) break
                activeList.push(cellFlatIndex >>> 0)
                v = (v ^ lsb) >>> 0
            }
        }

        let activeCellCount = activeList.length
        console.log(`Active cells from flags: ${activeCellCount}`)
        if (activeCellCount === 0) {
            console.warn("No active cells found; check grid bounds and scene.")
            return
        }

        const activeCellIndicesView = Uint32Array.from(activeList)

        // Build a sparse hash table for neighbor lookup (cellFlatIndex -> activeIdx).
        // Over-allocate to keep load factor <= 0.25 (very low probe counts, no lookup failures).
        const targetEntries = Math.max(1024, activeCellCount * 4)
        let tableEntries = 1
        while (tableEntries < targetEntries) tableEntries <<= 1
        const hashMask = tableEntries - 1
        const cellToActiveHash = new Uint32Array(tableEntries * 2)
        cellToActiveHash.fill(0xffffffff)
        for (let i = 0; i < activeCellCount; i++) {
            const key = activeCellIndicesView[i]!
            let slot = (Math.imul(key, 2654435761) >>> 0) & hashMask
            while (true) {
                const base = slot * 2
                const existing = cellToActiveHash[base]!
                if (existing === 0xffffffff) {
                    cellToActiveHash[base] = key
                    cellToActiveHash[base + 1] = i
                    break
                }
                if (existing === key) {
                    cellToActiveHash[base + 1] = i
                    break
                }
                slot = (slot + 1) & hashMask
            }
        }

        // --- Stage 2: allocate buffers sized to active cells, then run MDC passes ---
        const activeCellCountBuffer = this.#helper.createBuffer(
            "ActiveCellCount",
            Uint32Array.BYTES_PER_ELEMENT,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
        )
        this.#device.queue.writeBuffer(activeCellCountBuffer, 0, new Uint32Array([activeCellCount]))

        const activeCellIndicesBuffer = this.#helper.createBuffer(
            "ActiveCellIndices",
            activeCellCount * Uint32Array.BYTES_PER_ELEMENT,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        )
        this.#device.queue.writeBuffer(activeCellIndicesBuffer, 0, activeCellIndicesView)

        const cellToActiveHashBuffer = this.#helper.createBuffer(
            "CellToActiveHash",
            cellToActiveHash.byteLength,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        )
        this.#device.queue.writeBuffer(cellToActiveHashBuffer, 0, cellToActiveHash)

        const debugSkipCountersBuffer = this.#helper.createBuffer(
            "DebugSkipCounters",
            2 * Uint32Array.BYTES_PER_ELEMENT,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
        )
        this.#device.queue.writeBuffer(debugSkipCountersBuffer, 0, new Uint32Array([0, 0]))

        const cellEdgeComponentsBuffer = this.#helper.createBuffer(
            "CellEdgeComponents",
            activeCellCount * 12 * Uint32Array.BYTES_PER_ELEMENT,
            GPUBufferUsage.STORAGE
        )
        // Edge crossings are optional debug outputs; keep tiny to avoid huge allocations.
        const edgeCrossingsXBuffer = this.#helper.createBuffer("EdgeCrossingsX", SIZEOF_EDGECROSSING, GPUBufferUsage.STORAGE)
        const edgeCrossingsYBuffer = this.#helper.createBuffer("EdgeCrossingsY", SIZEOF_EDGECROSSING, GPUBufferUsage.STORAGE)
        const edgeCrossingsZBuffer = this.#helper.createBuffer("EdgeCrossingsZ", SIZEOF_EDGECROSSING, GPUBufferUsage.STORAGE)

        const cellQEFDataBuffer = this.#helper.createBuffer(
            "CellQEFData",
            activeCellCount * MAX_COMPONENTS_PER_CELL * SIZEOF_QEFDATA_STRUCT,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        )
        const verticesBuffer = this.#helper.createBuffer(
            "Vertices",
            activeCellCount * MAX_COMPONENTS_PER_CELL * SIZEOF_VERTEX,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        )

        const maxTriangles = activeCellCount * 6
        const maxIndices = maxTriangles * 3
        const indicesBuffer = this.#helper.createBuffer(
            "Indices",
            maxIndices * Uint32Array.BYTES_PER_ELEMENT,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        )
        const indexCountFaceBuffer = this.#helper.createBuffer(
            "IndexCountFace",
            Uint32Array.BYTES_PER_ELEMENT,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
        )
        this.#device.queue.writeBuffer(indexCountFaceBuffer, 0, new Uint32Array([0]))

        const p3_edgeDetection = this.#helper.createComputePipeline(mdcShaderModule, "edgeDetection_Pass3")
        const p4_vertexGeneration = this.#helper.createComputePipeline(mdcShaderModule, "vertexGeneration_Pass4")
        const p5_generateTrianglesAtomic = this.#helper.createComputePipeline(mdcShaderModule, "generateTrianglesAtomic_Pass5")

        const bindGroupPass3 = this.#helper.createBindGroup(
            0,
            "BindGroup Pass3",
            p3_edgeDetection,
            [0, uniformBuffer],
            [5, activeCellIndicesBuffer], // activeCellIndicesIn_edge
            [22, cellEdgeComponentsBuffer],
            [6, edgeCrossingsXBuffer],
            [7, edgeCrossingsYBuffer],
            [8, edgeCrossingsZBuffer],
            [9, cellQEFDataBuffer],
            [10, activeCellCountBuffer]
        )

        const bindGroupPass4 = this.#helper.createBindGroup(
            0,
            "BindGroup Pass4",
            p4_vertexGeneration,
            [0, uniformBuffer],
            [11, activeCellIndicesBuffer], // activeCellIndicesIn_vertex
            [12, cellQEFDataBuffer],
            [13, verticesBuffer],
            [14, activeCellCountBuffer]
        )

        const bindGroupPass5 = this.#helper.createBindGroup(
            0,
            "BindGroup Pass5 (atomic)",
            p5_generateTrianglesAtomic,
            [0, uniformBuffer],
            [15, activeCellIndicesBuffer], // activeCellIndicesIn_face
            [16, activeCellFlagsBuffer], // activeCellFlagsInput_face (used for isCellActive)
            [17, indicesBuffer],
            [18, indexCountFaceBuffer],
            [20, activeCellCountBuffer],
            [22, cellEdgeComponentsBuffer],
            [23, cellToActiveHashBuffer],
            [24, debugSkipCountersBuffer]
        )

        {
            const ce = this.#device.createCommandEncoder({ label: "mdc_pass3_5" })
            let pass = this.#helper.beginComputePass(ce, p3_edgeDetection, bindGroupPass3)
            pass.dispatchWorkgroups(Math.ceil(activeCellCount / 64))
            pass.end()

            pass = this.#helper.beginComputePass(ce, p4_vertexGeneration, bindGroupPass4)
            pass.dispatchWorkgroups(Math.ceil((activeCellCount * MAX_COMPONENTS_PER_CELL) / 64))
            pass.end()

            pass = this.#helper.beginComputePass(ce, p5_generateTrianglesAtomic, bindGroupPass5)
            pass.dispatchWorkgroups(Math.ceil(activeCellCount / 64))
            pass.end()

            this.#device.queue.submit([ce.finish()])
            await this.#device.queue.onSubmittedWorkDone()
        }

        console.log("Reading back data from GPU...")
        const debugCountsData = await this.#helper.readBufferData(debugSkipCountersBuffer, 2 * Uint32Array.BYTES_PER_ELEMENT)
        const debugCounts = new Uint32Array(debugCountsData)
        console.log(
            `MDC debug: skippedQuads(neighborMissing)=${debugCounts[0]} skippedQuads(componentMissing)=${debugCounts[1]}`
        )
        const indexCountData = await this.#helper.readBufferData(indexCountFaceBuffer)
        const rawIndexCount = new Uint32Array(indexCountData)[0]!
        const actualIndexCount = Math.min(rawIndexCount, maxIndices)
        console.log(`Actual Index Count: ${actualIndexCount}${actualIndexCount !== rawIndexCount ? " (clamped)" : ""}`)

        let verts: Float32Array | null = null
        if (activeCellCount > 0) {
            const actualVertexCount = activeCellCount * MAX_COMPONENTS_PER_CELL
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
            const indicesData = await this.#helper.readBufferData(
                indicesBuffer,
                actualIndexCount * Uint32Array.BYTES_PER_ELEMENT
            )
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
                console.log(`Wrote ASCII STL: ${tris.length / 3} triangles (grid=${gridDimX} voxel=${voxelSize})`)
            }
        } else {
            console.log("No indices generated.")
        }
        console.log("MDC export process finished.")
    }
}
