import { GPUHelper } from "../gpu/helper.mjs"
import { MeshData } from "./export.mjs"
import { exportStlAscii } from "./stl.mjs"

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
export const SIZEOF_VERTEX = 8 * Float32Array.BYTES_PER_ELEMENT // 32 bytes

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

    async export(mdcShaderModule: GPUShaderModule): Promise<MeshData> {
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
            throw new Error("No active cells found, check grid bounds and scene")
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
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
        )
        // Edge crossings are optional debug outputs; keep tiny to avoid huge allocations.
        const edgeCrossingsXBuffer = this.#helper.createBuffer("EdgeCrossingsX", SIZEOF_EDGECROSSING, GPUBufferUsage.STORAGE)
        const edgeCrossingsYBuffer = this.#helper.createBuffer("EdgeCrossingsY", SIZEOF_EDGECROSSING, GPUBufferUsage.STORAGE)
        const edgeCrossingsZBuffer = this.#helper.createBuffer("EdgeCrossingsZ", SIZEOF_EDGECROSSING, GPUBufferUsage.STORAGE)

        // Cross-cell union-find buffers for CPU-side global component assignment
        const cellUFParentBuffer = this.#helper.createBuffer(
            "CellUFParent",
            activeCellCount * 12 * Uint32Array.BYTES_PER_ELEMENT,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        )
        const cellEdgeCrossingPosBuffer = this.#helper.createBuffer(
            "CellEdgeCrossingPos",
            activeCellCount * 12 * 4 * Float32Array.BYTES_PER_ELEMENT, // vec4f per edge
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        )
        const cellEdgeCrossingNormalBuffer = this.#helper.createBuffer(
            "CellEdgeCrossingNormal",
            activeCellCount * 12 * 4 * Float32Array.BYTES_PER_ELEMENT, // vec4f per edge
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        )

        const cellQEFDataBuffer = this.#helper.createBuffer(
            "CellQEFData",
            activeCellCount * MAX_COMPONENTS_PER_CELL * SIZEOF_QEFDATA_STRUCT,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        )
        const verticesBuffer = this.#helper.createBuffer(
            "Vertices",
            activeCellCount * MAX_COMPONENTS_PER_CELL * SIZEOF_VERTEX,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
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
            [9, cellQEFDataBuffer],
            [10, activeCellCountBuffer],
            [25, cellUFParentBuffer],
            [26, cellEdgeCrossingPosBuffer],
            [27, cellEdgeCrossingNormalBuffer]
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
            [13, verticesBuffer],
            [15, activeCellIndicesBuffer], // activeCellIndicesIn_face
            [16, activeCellFlagsBuffer], // activeCellFlagsInput_face (used for isCellActive)
            [17, indicesBuffer],
            [18, indexCountFaceBuffer],
            [20, activeCellCountBuffer],
            [22, cellEdgeComponentsBuffer],
            [23, cellToActiveHashBuffer],
            [24, debugSkipCountersBuffer]
        )

        // === Pass 3: Edge detection and per-cell union-find ===
        {
            const ce = this.#device.createCommandEncoder({ label: "mdc_pass3" })
            const pass = this.#helper.beginComputePass(ce, p3_edgeDetection, bindGroupPass3)
            pass.dispatchWorkgroups(Math.ceil(activeCellCount / 64))
            pass.end()
            this.#device.queue.submit([ce.finish()])
            await this.#device.queue.onSubmittedWorkDone()
        }

        // === CPU Global Union-Find ===
        // Read back per-cell UF parents and edge crossing data
        console.log("Reading per-cell connectivity for global union-find...")
        const ufParentData = await this.#helper.readBufferData(
            cellUFParentBuffer,
            activeCellCount * 12 * Uint32Array.BYTES_PER_ELEMENT
        )
        const cellUFParent = new Uint32Array(ufParentData)

        const crossingPosData = await this.#helper.readBufferData(
            cellEdgeCrossingPosBuffer,
            activeCellCount * 12 * 4 * Float32Array.BYTES_PER_ELEMENT
        )
        const cellEdgeCrossingPos = new Float32Array(crossingPosData)

        const crossingNormalData = await this.#helper.readBufferData(
            cellEdgeCrossingNormalBuffer,
            activeCellCount * 12 * 4 * Float32Array.BYTES_PER_ELEMENT
        )
        const cellEdgeCrossingNormal = new Float32Array(crossingNormalData)

        // Build global union-find across grid edges
        // A grid edge is identified by (axis, x, y, z) where the edge runs from (x,y,z) to (x+dx,y+dy,z+dz)
        // Each cube edge in a cell maps to a specific grid edge
        const { globalComponentIds, globalVertices, globalVertexCount } = this.buildGlobalUnionFind(
            activeCellCount,
            activeCellIndicesView,
            cellUFParent,
            cellEdgeCrossingPos,
            cellEdgeCrossingNormal,
            gridDimX,
            gridDimY,
            gridDimZ,
            voxelSize,
            gridOffsetX,
            gridOffsetY,
            gridOffsetZ
        )

        console.log(`Global union-find complete: ${globalVertexCount} global components`)

        // Write global component IDs back to GPU
        this.#device.queue.writeBuffer(cellEdgeComponentsBuffer, 0, new Uint32Array(globalComponentIds))

        // Write CPU-computed vertices to GPU
        this.#device.queue.writeBuffer(verticesBuffer, 0, new Float32Array(globalVertices))

        // === Pass 4 is now done on CPU, skip it ===
        // === Pass 5: Triangle generation using global component IDs ===
        {
            const ce = this.#device.createCommandEncoder({ label: "mdc_pass5" })
            const pass = this.#helper.beginComputePass(ce, p5_generateTrianglesAtomic, bindGroupPass5)
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

        const actualVertexCount = activeCellCount * MAX_COMPONENTS_PER_CELL
        const verticesData = await this.#helper.readBufferData(verticesBuffer, actualVertexCount * SIZEOF_VERTEX)
        const verts = new Float32Array(verticesData)

        const indicesData = await this.#helper.readBufferData(
            indicesBuffer,
            actualIndexCount * Uint32Array.BYTES_PER_ELEMENT
        )
        const tris = new Uint32Array(indicesData)

        // Re-orient triangles to a consistent winding.
        //
        // A watertight manifold can still *look* like it has holes if triangle winding is inconsistent
        // and the viewer uses backface culling. Dual contouring quad emission can produce locally
        // inconsistent winding on sharp features / near-degenerate quads.
        //
        // This post-pass:
        // - makes adjacent triangles traverse shared edges in opposite directions (consistent orientation)
        // - then flips entire connected components to produce positive signed volume (outward by convention)
        {
            const stride = SIZEOF_VERTEX / 4 // floats per vertex
            const triCount = Math.floor(tris.length / 3)
            if (triCount > 0) {
                type EdgeEntry = { t0: number; d0: number; t1: number; d1: number; count: number }
                const edgeMap = new Map<bigint, EdgeEntry>()

                const edgeKey = (a: number, b: number) => {
                    const lo = a < b ? a : b
                    const hi = a < b ? b : a
                    return (BigInt(lo) << 32n) | BigInt(hi >>> 0)
                }
                const edgeDir = (a: number, b: number) => {
                    // Direction of this edge in the triangle, relative to (min,max).
                    // 0 => min->max, 1 => max->min
                    return a < b ? 0 : 1
                }

                for (let t = 0; t < triCount; t++) {
                    const i0 = tris[t * 3]!
                    const i1 = tris[t * 3 + 1]!
                    const i2 = tris[t * 3 + 2]!
                    const edges: [number, number][] = [
                        [i0, i1],
                        [i1, i2],
                        [i2, i0],
                    ]
                    for (const [a, b] of edges) {
                        if (a === b) continue
                        const k = edgeKey(a, b)
                        const d = edgeDir(a, b)
                        const e = edgeMap.get(k)
                        if (!e) {
                            edgeMap.set(k, { t0: t, d0: d, t1: -1, d1: 0, count: 1 })
                        } else {
                            e.count++
                            if (e.t1 === -1) {
                                e.t1 = t
                                e.d1 = d
                            }
                        }
                    }
                }

                const visited = new Uint8Array(triCount)
                const flip = new Uint8Array(triCount)
                const comps: number[][] = []

                for (let seed = 0; seed < triCount; seed++) {
                    if (visited[seed]) continue
                    visited[seed] = 1
                    flip[seed] = 0
                    const stack = [seed]
                    const comp: number[] = []

                    while (stack.length) {
                        const t = stack.pop()!
                        comp.push(t)

                        const i0 = tris[t * 3]!
                        const i1 = tris[t * 3 + 1]!
                        const i2 = tris[t * 3 + 2]!
                        const edges: [number, number][] = [
                            [i0, i1],
                            [i1, i2],
                            [i2, i0],
                        ]

                        for (const [a, b] of edges) {
                            if (a === b) continue
                            const k = edgeKey(a, b)
                            const e = edgeMap.get(k)
                            if (!e || e.count !== 2 || e.t1 === -1) continue
                            const curIs0 = e.t0 === t
                            const nt = curIs0 ? e.t1 : e.t0
                            if (nt < 0) continue

                            const dCur = curIs0 ? e.d0 : e.d1
                            const dNei = curIs0 ? e.d1 : e.d0

                            // Effective edge direction after flipping:
                            // effDir = dOrig XOR flipTri
                            // We need neighbor to traverse edge in opposite direction:
                            // effNei = effCur XOR 1
                            const desiredFlipNei = (dNei ^ dCur ^ flip[t] ^ 1) & 1

                            if (!visited[nt]) {
                                visited[nt] = 1
                                flip[nt] = desiredFlipNei
                                stack.push(nt)
                            }
                        }
                    }
                    comps.push(comp)
                }

                // Apply BFS-derived flips.
                for (let t = 0; t < triCount; t++) {
                    if (!flip[t]) continue
                    const off = t * 3
                    const tmp = tris[off + 1]!
                    tris[off + 1] = tris[off + 2]!
                    tris[off + 2] = tmp
                }

                // Flip whole components to get positive signed volume (outward by convention).
                const vpos = (vidx: number) => {
                    const base = vidx * stride
                    return [verts[base]!, verts[base + 1]!, verts[base + 2]!] as const
                }
                const cross = (a: readonly [number, number, number], b: readonly [number, number, number]) =>
                    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] as const
                const dot = (a: readonly [number, number, number], b: readonly [number, number, number]) =>
                    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
                const sub = (a: readonly [number, number, number], b: readonly [number, number, number]) =>
                    [a[0] - b[0], a[1] - b[1], a[2] - b[2]] as const

                for (const comp of comps) {
                    let vol6 = 0 // 6x signed volume
                    for (const t of comp) {
                        const off = t * 3
                        const i0 = tris[off + 0]!
                        const i1 = tris[off + 1]!
                        const i2 = tris[off + 2]!
                        const p0 = vpos(i0)
                        const p1 = vpos(i1)
                        const p2 = vpos(i2)
                        // signed volume contribution: dot(p0, cross(p1, p2))
                        vol6 += dot(p0, cross(p1, p2))
                    }
                    if (vol6 < 0) {
                        // Flip all triangles in the component.
                        for (const t of comp) {
                            const off = t * 3
                            const tmp = tris[off + 1]!
                            tris[off + 1] = tris[off + 2]!
                            tris[off + 2] = tmp
                        }
                    }
                }
            }
        }

        // Basic mesh sanity stats to help diagnose “holes”:
        // - boundary edges (count==1) indicate actual holes / open surface
        // - degenerate triangles can look like missing faces
        {
            const stride = SIZEOF_VERTEX / 4 // floats per vertex
            const triCount = Math.floor(tris.length / 3)
            const areaEpsSq = Math.pow(this.params.voxelSize * this.params.voxelSize * 1e-6, 2)
            let degenerate = 0

            const edgeCounts = new Map<bigint, number>()
            const addEdge = (a: number, b: number) => {
                if (a === b) return
                const lo = a < b ? a : b
                const hi = a < b ? b : a
                const key = (BigInt(lo) << 32n) | BigInt(hi >>> 0)
                edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1)
            }

            const vpos = (vidx: number) => {
                const base = vidx * stride
                return [verts[base]!, verts[base + 1]!, verts[base + 2]!] as const
            }
            const sub = (a: readonly [number, number, number], b: readonly [number, number, number]) =>
                [a[0] - b[0], a[1] - b[1], a[2] - b[2]] as const
            const cross = (a: readonly [number, number, number], b: readonly [number, number, number]) =>
                [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] as const

            for (let t = 0; t < triCount; t++) {
                const i0 = tris[t * 3]!
                const i1 = tris[t * 3 + 1]!
                const i2 = tris[t * 3 + 2]!

                addEdge(i0, i1)
                addEdge(i1, i2)
                addEdge(i2, i0)

                const p0 = vpos(i0)
                const p1 = vpos(i1)
                const p2 = vpos(i2)
                const e0 = sub(p1, p0)
                const e1 = sub(p2, p0)
                const n = cross(e0, e1)
                const a2 = n[0] * n[0] + n[1] * n[1] + n[2] * n[2]
                if (!isFinite(a2) || a2 <= areaEpsSq) degenerate++
            }

            let boundaryEdges = 0
            let nonManifoldEdges = 0
            for (const c of edgeCounts.values()) {
                if (c === 1) boundaryEdges++
                else if (c !== 2) nonManifoldEdges++
            }
            console.log(
                `MDC mesh stats: tris=${triCount} degenerateTris=${degenerate} boundaryEdges=${boundaryEdges} nonManifoldEdges=${nonManifoldEdges}`
            )
        }

        return { verts, tris }
    }

    /**
     * Build global union-find across all cells to ensure consistent component assignment.
     * 
     * The algorithm:
     * 1. Map each (activeCellIdx, cubeEdgeIdx) to a global grid edge index
     * 2. For each cell, union grid edges that belong to the same local component
     * 3. Assign a global component ID to each grid edge based on its UF root
     * 4. Map back to (activeCellIdx, cubeEdgeIdx) -> globalComponentId
     * 5. Aggregate QEF data per global component and solve for vertex positions
     */
    private buildGlobalUnionFind(
        activeCellCount: number,
        activeCellIndices: Uint32Array,
        cellUFParent: Uint32Array,
        cellEdgeCrossingPos: Float32Array,
        cellEdgeCrossingNormal: Float32Array,
        gridDimX: number,
        gridDimY: number,
        gridDimZ: number,
        voxelSize: number,
        gridOffsetX: number,
        gridOffsetY: number,
        gridOffsetZ: number
    ): { globalComponentIds: Uint32Array; globalVertices: Float32Array; globalVertexCount: number } {
        const EDGES_PER_CELL = 12

        // Cube edge definitions: [corner0, corner1, axis, isOwned]
        // Axis: 0=X, 1=Y, 2=Z
        const CUBE_EDGES: [number, number, number][] = [
            [0, 1, 0], [2, 3, 0], [4, 5, 0], [6, 7, 0], // X edges
            [0, 2, 1], [1, 3, 1], [4, 6, 1], [5, 7, 1], // Y edges
            [0, 4, 2], [1, 5, 2], [2, 6, 2], [3, 7, 2], // Z edges
        ]

        // Corner offsets from cell min corner
        const CORNER_OFFSETS: [number, number, number][] = [
            [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
            [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
        ]

        // Convert flat cell index to 3D position
        const cellIndexTo3D = (flatIdx: number): [number, number, number] => {
            const x = flatIdx % gridDimX
            const y = Math.floor(flatIdx / gridDimX) % gridDimY
            const z = Math.floor(flatIdx / (gridDimX * gridDimY))
            return [x, y, z]
        }

        // Compute grid edge index from cell position and cube edge index
        // Grid edges are enumerated as:
        // X-edges: index = x + y*(gridDimX-1) + z*(gridDimX-1)*gridDimY
        // Y-edges: offset by total X-edges
        // Z-edges: offset by total X+Y edges
        const totalXEdges = (gridDimX - 1) * gridDimY * gridDimZ
        const totalYEdges = gridDimX * (gridDimY - 1) * gridDimZ
        const totalZEdges = gridDimX * gridDimY * (gridDimZ - 1)
        const totalGridEdges = totalXEdges + totalYEdges + totalZEdges

        const getGridEdgeIndex = (cellX: number, cellY: number, cellZ: number, cubeEdge: number): number => {
            const [c0, c1, axis] = CUBE_EDGES[cubeEdge]!
            const [ox, oy, oz] = CORNER_OFFSETS[c0]!

            // The grid edge starts at cell corner c0
            const edgeX = cellX + ox
            const edgeY = cellY + oy
            const edgeZ = cellZ + oz

            if (axis === 0) {
                // X-edge at (edgeX, edgeY, edgeZ)
                if (edgeX >= gridDimX - 1) return -1
                return edgeX + edgeY * (gridDimX - 1) + edgeZ * (gridDimX - 1) * gridDimY
            } else if (axis === 1) {
                // Y-edge at (edgeX, edgeY, edgeZ)
                if (edgeY >= gridDimY - 1) return -1
                return totalXEdges + edgeY + edgeZ * (gridDimY - 1) + edgeX * (gridDimY - 1) * gridDimZ
            } else {
                // Z-edge at (edgeX, edgeY, edgeZ)
                if (edgeZ >= gridDimZ - 1) return -1
                return totalXEdges + totalYEdges + edgeX + edgeY * gridDimX + edgeZ * gridDimX * gridDimY
            }
        }

        // Initialize global union-find for grid edges
        const gridEdgeParent = new Int32Array(totalGridEdges)
        for (let i = 0; i < totalGridEdges; i++) {
            gridEdgeParent[i] = i
        }

        const ufFind = (x: number): number => {
            let root = x
            while (gridEdgeParent[root] !== root) {
                root = gridEdgeParent[root]!
            }
            // Path compression
            while (gridEdgeParent[x] !== root) {
                const next = gridEdgeParent[x]!
                gridEdgeParent[x] = root
                x = next
            }
            return root
        }

        const ufUnion = (a: number, b: number): void => {
            const ra = ufFind(a)
            const rb = ufFind(b)
            if (ra !== rb) {
                gridEdgeParent[rb] = ra
            }
        }

        // For each cell, union grid edges that have the same local UF root
        for (let cellIdx = 0; cellIdx < activeCellCount; cellIdx++) {
            const cellFlatIndex = activeCellIndices[cellIdx]!
            const [cellX, cellY, cellZ] = cellIndexTo3D(cellFlatIndex)

            // Group cube edges by their local UF root
            const rootToGridEdges = new Map<number, number[]>()

            for (let e = 0; e < EDGES_PER_CELL; e++) {
                const ufIdx = cellIdx * EDGES_PER_CELL + e
                const localRoot = cellUFParent[ufIdx]!

                if (localRoot === 0xffffffff) continue // Edge doesn't cross

                const gridEdge = getGridEdgeIndex(cellX, cellY, cellZ, e)
                if (gridEdge < 0) continue // Out of bounds

                if (!rootToGridEdges.has(localRoot)) {
                    rootToGridEdges.set(localRoot, [])
                }
                rootToGridEdges.get(localRoot)!.push(gridEdge)
            }

            // Union all grid edges with the same local root
            for (const gridEdges of rootToGridEdges.values()) {
                if (gridEdges.length < 2) continue
                const first = gridEdges[0]!
                for (let i = 1; i < gridEdges.length; i++) {
                    ufUnion(first, gridEdges[i]!)
                }
            }
        }

        // Assign global component IDs based on grid edge UF roots
        const rootToGlobalId = new Map<number, number>()
        let nextGlobalId = 0

        const getGlobalId = (gridEdge: number): number => {
            const root = ufFind(gridEdge)
            if (!rootToGlobalId.has(root)) {
                rootToGlobalId.set(root, nextGlobalId++)
            }
            return rootToGlobalId.get(root)!
        }

        // Build per-(cell,edge) -> localComponentIdx mapping
        // The key insight: we need to map global component IDs to LOCAL indices (0-3)
        // within each cell, but ensure that neighboring cells assign the SAME local index
        // to edges that share a grid edge (and thus global component).
        //
        // To achieve consistency: for each cell, collect the global component IDs of its
        // crossing edges, sort them, and assign local indices based on sorted order.
        // Since global IDs are deterministic, cells sharing an edge will sort the same way.
        const localComponentIds = new Uint32Array(activeCellCount * EDGES_PER_CELL)
        localComponentIds.fill(0xffffffff)

        // First pass: compute global component ID for each (cell, edge)
        const edgeGlobalIds = new Int32Array(activeCellCount * EDGES_PER_CELL)
        edgeGlobalIds.fill(-1)

        for (let cellIdx = 0; cellIdx < activeCellCount; cellIdx++) {
            const cellFlatIndex = activeCellIndices[cellIdx]!
            const [cellX, cellY, cellZ] = cellIndexTo3D(cellFlatIndex)

            for (let e = 0; e < EDGES_PER_CELL; e++) {
                const ufIdx = cellIdx * EDGES_PER_CELL + e
                const localRoot = cellUFParent[ufIdx]!

                if (localRoot === 0xffffffff) continue

                const gridEdge = getGridEdgeIndex(cellX, cellY, cellZ, e)
                if (gridEdge < 0) continue

                edgeGlobalIds[ufIdx] = getGlobalId(gridEdge)
            }
        }

        const globalVertexCount = nextGlobalId
        console.log(`Global components: ${globalVertexCount}`)

        // Second pass: for each cell, map global IDs to local indices (0-3)
        for (let cellIdx = 0; cellIdx < activeCellCount; cellIdx++) {
            // Collect unique global IDs for this cell
            const globalIdsInCell = new Set<number>()
            for (let e = 0; e < EDGES_PER_CELL; e++) {
                const ufIdx = cellIdx * EDGES_PER_CELL + e
                const gid = edgeGlobalIds[ufIdx]!
                if (gid >= 0) {
                    globalIdsInCell.add(gid)
                }
            }

            // Sort global IDs to get consistent local indices
            const sortedGlobalIds = Array.from(globalIdsInCell).sort((a, b) => a - b)
            const globalToLocal = new Map<number, number>()
            for (let i = 0; i < sortedGlobalIds.length && i < MAX_COMPONENTS_PER_CELL; i++) {
                globalToLocal.set(sortedGlobalIds[i]!, i)
            }

            // Assign local component indices
            for (let e = 0; e < EDGES_PER_CELL; e++) {
                const ufIdx = cellIdx * EDGES_PER_CELL + e
                const gid = edgeGlobalIds[ufIdx]!
                if (gid >= 0 && globalToLocal.has(gid)) {
                    localComponentIds[ufIdx] = globalToLocal.get(gid)!
                }
            }
        }

        // Aggregate QEF data per (cell, localComponent) - this is the standard DC approach
        // Each cell gets its own vertices, but with consistent component indices across cells
        interface QEFData {
            ATA: number[][] // 3x3 matrix
            ATb: number[]   // 3-vector
            massPoint: number[] // 3-vector
            numPoints: number
        }

        // QEF per (cellIdx * MAX_COMPONENTS_PER_CELL + localComponentIdx)
        const totalVertexSlots = activeCellCount * MAX_COMPONENTS_PER_CELL
        const qefData: QEFData[] = []
        for (let i = 0; i < totalVertexSlots; i++) {
            qefData.push({
                ATA: [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
                ATb: [0, 0, 0],
                massPoint: [0, 0, 0],
                numPoints: 0,
            })
        }

        for (let cellIdx = 0; cellIdx < activeCellCount; cellIdx++) {
            for (let e = 0; e < EDGES_PER_CELL; e++) {
                const ufIdx = cellIdx * EDGES_PER_CELL + e
                const localCompIdx = localComponentIds[ufIdx]!
                if (localCompIdx === 0xffffffff) continue

                const posIdx = ufIdx * 4
                const px = cellEdgeCrossingPos[posIdx]!
                const py = cellEdgeCrossingPos[posIdx + 1]!
                const pz = cellEdgeCrossingPos[posIdx + 2]!

                const nx = cellEdgeCrossingNormal[posIdx]!
                const ny = cellEdgeCrossingNormal[posIdx + 1]!
                const nz = cellEdgeCrossingNormal[posIdx + 2]!

                // Skip zero normals (invalid crossings)
                if (nx === 0 && ny === 0 && nz === 0) continue

                const vertexSlot = cellIdx * MAX_COMPONENTS_PER_CELL + localCompIdx
                const qef = qefData[vertexSlot]!

                // ATA += n * n^T
                qef.ATA[0]![0]! += nx * nx
                qef.ATA[0]![1]! += nx * ny
                qef.ATA[0]![2]! += nx * nz
                qef.ATA[1]![0]! += ny * nx
                qef.ATA[1]![1]! += ny * ny
                qef.ATA[1]![2]! += ny * nz
                qef.ATA[2]![0]! += nz * nx
                qef.ATA[2]![1]! += nz * ny
                qef.ATA[2]![2]! += nz * nz

                // ATb += n * dot(n, p)
                const d = nx * px + ny * py + nz * pz
                qef.ATb[0]! += nx * d
                qef.ATb[1]! += ny * d
                qef.ATb[2]! += nz * d

                // massPoint += p
                qef.massPoint[0]! += px
                qef.massPoint[1]! += py
                qef.massPoint[2]! += pz
                qef.numPoints++
            }
        }

        // Solve QEF for each (cell, localComponent) to get vertex positions
        const perCellVertices = new Float32Array(totalVertexSlots * 8) // 8 floats per vertex
        perCellVertices.fill(0)

        // Helper to solve QEF
        const solveQEF = (qef: QEFData): { pos: number[]; normal: number[] } => {
            if (qef.numPoints === 0) {
                return { pos: [0, 0, 0], normal: [0, 1, 0] }
            }

            const mp = [
                qef.massPoint[0]! / qef.numPoints,
                qef.massPoint[1]! / qef.numPoints,
                qef.massPoint[2]! / qef.numPoints,
            ]

            let vertexPos: number[]

            if (qef.numPoints < 3) {
                vertexPos = mp
            } else {
                const lambda = 1e-6
                const A = [
                    [qef.ATA[0]![0]! + lambda, qef.ATA[0]![1]!, qef.ATA[0]![2]!],
                    [qef.ATA[1]![0]!, qef.ATA[1]![1]! + lambda, qef.ATA[1]![2]!],
                    [qef.ATA[2]![0]!, qef.ATA[2]![1]!, qef.ATA[2]![2]! + lambda],
                ]
                const b = [
                    qef.ATb[0]! + lambda * mp[0]!,
                    qef.ATb[1]! + lambda * mp[1]!,
                    qef.ATb[2]! + lambda * mp[2]!,
                ]

                const det = (m: number[][]) =>
                    m[0]![0]! * (m[1]![1]! * m[2]![2]! - m[1]![2]! * m[2]![1]!) -
                    m[0]![1]! * (m[1]![0]! * m[2]![2]! - m[1]![2]! * m[2]![0]!) +
                    m[0]![2]! * (m[1]![0]! * m[2]![1]! - m[1]![1]! * m[2]![0]!)

                const detA = det(A)
                if (Math.abs(detA) < 1e-12) {
                    vertexPos = mp
                } else {
                    const Ax = [[b[0]!, A[0]![1]!, A[0]![2]!], [b[1]!, A[1]![1]!, A[1]![2]!], [b[2]!, A[2]![1]!, A[2]![2]!]]
                    const Ay = [[A[0]![0]!, b[0]!, A[0]![2]!], [A[1]![0]!, b[1]!, A[1]![2]!], [A[2]![0]!, b[2]!, A[2]![2]!]]
                    const Az = [[A[0]![0]!, A[0]![1]!, b[0]!], [A[1]![0]!, A[1]![1]!, b[1]!], [A[2]![0]!, A[2]![1]!, b[2]!]]
                    vertexPos = [det(Ax) / detA, det(Ay) / detA, det(Az) / detA]

                    if (!isFinite(vertexPos[0]!) || !isFinite(vertexPos[1]!) || !isFinite(vertexPos[2]!)) {
                        vertexPos = mp
                    }
                }
            }

            return { pos: vertexPos, normal: [0, 1, 0] } // Normal will be computed from gradient
        }

        // Solve QEF for each vertex slot
        for (let cellIdx = 0; cellIdx < activeCellCount; cellIdx++) {
            for (let comp = 0; comp < MAX_COMPONENTS_PER_CELL; comp++) {
                const vertexSlot = cellIdx * MAX_COMPONENTS_PER_CELL + comp
                const qef = qefData[vertexSlot]!

                if (qef.numPoints === 0) continue

                const { pos } = solveQEF(qef)

                // Compute average normal from crossing normals
                let avgNormal = [0, 0, 0]
                for (let e = 0; e < EDGES_PER_CELL; e++) {
                    const ufIdx = cellIdx * EDGES_PER_CELL + e
                    if (localComponentIds[ufIdx] !== comp) continue

                    const posIdx = ufIdx * 4
                    avgNormal[0] += cellEdgeCrossingNormal[posIdx]!
                    avgNormal[1] += cellEdgeCrossingNormal[posIdx + 1]!
                    avgNormal[2] += cellEdgeCrossingNormal[posIdx + 2]!
                }
                const len = Math.sqrt(avgNormal[0]! ** 2 + avgNormal[1]! ** 2 + avgNormal[2]! ** 2)
                if (len > 1e-12) {
                    avgNormal[0]! /= len
                    avgNormal[1]! /= len
                    avgNormal[2]! /= len
                } else {
                    avgNormal = [0, 1, 0]
                }

                const vertexBase = vertexSlot * 8
                perCellVertices[vertexBase + 0] = pos[0]!
                perCellVertices[vertexBase + 1] = pos[1]!
                perCellVertices[vertexBase + 2] = pos[2]!
                perCellVertices[vertexBase + 3] = 0
                perCellVertices[vertexBase + 4] = avgNormal[0]!
                perCellVertices[vertexBase + 5] = avgNormal[1]!
                perCellVertices[vertexBase + 6] = avgNormal[2]!
                perCellVertices[vertexBase + 7] = 0
            }
        }

        return { globalComponentIds: localComponentIds, globalVertices: perCellVertices, globalVertexCount }
    }
}

