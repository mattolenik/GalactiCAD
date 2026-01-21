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
}


