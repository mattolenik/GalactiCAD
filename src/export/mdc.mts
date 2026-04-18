import { GPUHelper } from "../gpu/helper.mjs"
import { log as dbgLog } from "../logging/debug-log.mjs"
import { MeshData } from "./export.mjs"
import {
    logExportMeshSanityStats,
    optionalSimplifyExportedMesh,
    reorientMeshTriangleWinding,
    splitCreaseVertices,
} from "./mesh-postprocess.mjs"
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

    // --- MDC tuning knobs (optional; defaults preserve current behavior) ---
    activeEpsScale?: number
    activeEpsMin?: number
    insideBiasScale?: number
    insideBiasMin?: number

    gradEpsScale?: number
    gradEpsMin?: number

    edgeProjTolScale?: number
    edgeProjIters?: number

    vertexProjTolScale?: number
    vertexProjIters?: number
    vertexProjMarginScale?: number
    vertexProjMaxStepScale?: number

    qefRegScale?: number
    qefRegMin?: number
    qefCondCutoff?: number

    orientationProbeScale?: number
    orientationProbeMin?: number

    // --- Mesh simplification (post-MDC) ---
    /** Fraction of triangles to keep, 0–1 (e.g. 0.5 = 50%). undefined or 1 = skip. */
    simplifyTargetRatio?: number
    /** Max geometric error the simplifier may introduce (default 0.01). */
    simplifyTargetError?: number
    /** Lock boundary (open) edges so they are never collapsed. */
    simplifyLockBorder?: boolean
    /** Optimize for meshes with many shared vertex positions. */
    simplifySparse?: boolean
    /** Treat targetError as absolute world-space distance instead of relative to mesh scale. */
    simplifyErrorAbsolute?: boolean
    /** Remove degenerate (zero-area) triangles from output. */
    simplifyPrune?: boolean
    /** Bias toward more uniform triangle shapes (less slivery). */
    simplifyRegularize?: boolean
    /** Weight for normal-aware simplification (0 = ignore normals, >0 = protect sharp edges). */
    simplifyNormalWeight?: number

    /**
     * Crease angle threshold in degrees for vertex splitting (default 30).
     * Adjacent triangles whose face normals differ by more than this angle
     * get separate vertex copies with per-face-group averaged normals.
     * Set to 180 to disable splitting.
     */
    creaseAngleDeg?: number
}

export interface ProgressCallback {
    updateProgress(phase: string, percentage: number): void
    cancelled: boolean
}

export class MDCExport {
    #helper: GPUHelper
    #device: GPUDevice
    #localBuffers: GPUBuffer[] = []
    #localPipelines: GPUComputePipeline[] = []
    #localBindGroups: GPUBindGroup[] = []
    #polygonVerticesBuffer: GPUBuffer
    #faceSelectionBuffer: GPUBuffer
    #mdcSceneParamsBuffer: GPUBuffer
    #cancelled = false
    #cancellationBuffer: GPUBuffer | null = null

    constructor(
        helper: GPUHelper,
        private params: MDCParams,
        polygonVerticesBuffer: GPUBuffer,
        faceSelectionBuffer: GPUBuffer,
        mdcSceneParamsBuffer: GPUBuffer,
    ) {
        this.#helper = helper
        this.#device = helper.device
        this.#polygonVerticesBuffer = polygonVerticesBuffer
        this.#faceSelectionBuffer = faceSelectionBuffer
        this.#mdcSceneParamsBuffer = mdcSceneParamsBuffer
    }

    /** Destroy all GPU buffers created during export */
    #destroyLocalBuffers() {
        for (const buffer of this.#localBuffers) {
            buffer.destroy()
        }
        this.#localBuffers = []
    }

    /** Clear tracked bind groups / pipelines (no destroy() on those types in WebGPU). */
    #clearPassResourceLists() {
        this.#localBindGroups = []
        this.#localPipelines = []
    }

    async export(mdcShaderModule: GPUShaderModule, progressCallback?: ProgressCallback): Promise<MeshData> {
        const perfNow = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now())
        const t0 = perfNow()

        // Create cancellation buffer (atomic u32, initialized to 0)
        this.#cancellationBuffer = this.#device.createBuffer({
            label: "Cancellation",
            size: Uint32Array.BYTES_PER_ELEMENT,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        })
        this.#localBuffers.push(this.#cancellationBuffer)
        this.#device.queue.writeBuffer(this.#cancellationBuffer, 0, new Uint32Array([0]))

        progressCallback?.updateProgress("Initializing...", 0)

        const checkCancelled = () => {
            if (this.#cancelled || (progressCallback && progressCallback.cancelled)) {
                this.#cancelled = true
                // Write 1 to cancellation buffer
                if (this.#cancellationBuffer) {
                    this.#device.queue.writeBuffer(this.#cancellationBuffer, 0, new Uint32Array([1]))
                }
                throw new Error("MDC export was cancelled")
            }
        }

        // Check cancellation immediately at start and before any work
        checkCancelled()

        const fmtBytes = (bytes: number) => {
            const abs = Math.abs(bytes)
            if (abs < 1024) return `${bytes} B`
            if (abs < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
            if (abs < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
            return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`
        }

        let estimatedGpuBufferBytes = 0
        let estimatedGpuReadbackBytes = 0

        // Create buffer and track it for cleanup
        const createBuffer = (label: string, size: number, usage: GPUBufferUsageFlags, mappedAtCreation?: boolean) => {
            estimatedGpuBufferBytes += size
            const buffer = this.#device.createBuffer({
                label,
                mappedAtCreation,
                size,
                usage,
            })
            this.#localBuffers.push(buffer)
            return buffer
        }

        const readBufferData = async (buffer: GPUBuffer, size = buffer.size) => {
            // Note: WebGPU doesn’t expose real device memory usage. This is an estimate of
            // temporary MAP_READ buffers allocated during readback.
            estimatedGpuReadbackBytes += Math.min(size, buffer.size)
            return await this.#helper.readBufferData(buffer, size)
        }

        const logDiag = (phase: string, extra?: Record<string, unknown>) => {
            const elapsedMs = perfNow() - t0
            dbgLog("MdcExport").debug(`${phase}`, {
                elapsedMs: Math.round(elapsedMs * 1000) / 1000,
                estimatedGpuBuffers: fmtBytes(estimatedGpuBufferBytes),
                estimatedGpuReadback: fmtBytes(estimatedGpuReadbackBytes),
                estimatedGpuTotal: fmtBytes(estimatedGpuBufferBytes + estimatedGpuReadbackBytes),
                ...extra,
            })
        }

        const {
            gridDimX,
            gridDimY,
            gridDimZ,
            isoValue,
            gridOffsetX,
            gridOffsetY,
            gridOffsetZ,
            voxelSize,

            // Defaults match previous hard-coded shader constants.
            activeEpsScale = 1e-7,
            activeEpsMin = 1e-7,
            insideBiasScale = 1e-6,
            insideBiasMin = 1e-9,

            gradEpsScale = 0.01,
            gradEpsMin = 1e-6,

            edgeProjTolScale = 1e-3,  // Relaxed from 1e-5 (was too tight for float32)
            edgeProjIters = 8,        // Increased from 5

            vertexProjTolScale = 1e-3, // Relaxed from 1e-5
            vertexProjIters = 12,      // Increased from 8
            vertexProjMarginScale = 0.01,
            vertexProjMaxStepScale = 5,

            qefRegScale = 6.4e-2,
            qefRegMin = 1e-9,
            qefCondCutoff = 1e8,

            orientationProbeScale = 0.5,
            orientationProbeMin = 1e-4,
        } = this.params
        dbgLog("MdcExport").info(
            `MDCExport.export(): grid=${gridDimX}x${gridDimY}x${gridDimZ} voxel=${voxelSize} iso=${isoValue} offset=(${gridOffsetX},${gridOffsetY},${gridOffsetZ})`
        )
        logDiag("start", {
            maxBufferSize: this.#device.limits.maxBufferSize,
            maxStorageBufferBindingSize: this.#device.limits.maxStorageBufferBindingSize,
            maxComputeInvocationsPerWorkgroup: this.#device.limits.maxComputeInvocationsPerWorkgroup,
        })

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
        // For this struct (see `src/shaders/mdc.wgsl`):
        // struct SharedUniforms {
        //   gridDimensions: vec3u,  // offset 0,  size 12 (align 16)
        //   isoValue: f32,          // offset 12, size 4
        //   gridOffset: vec3f,      // offset 16, size 12 (align 16)
        //   voxelSize: f32,         // offset 28, size 4
        //   mdcF0: vec4f,           // offset 32, size 16
        //   mdcF1: vec4f,           // offset 48, size 16
        //   mdcF2: vec4f,           // offset 64, size 16
        //   mdcF3: vec4f,           // offset 80, size 16
        //   mdcU0: vec4u,           // offset 96, size 16 (z = activeCellCount after compaction, byte offset 104)
        // } // total size = 112
        const uniformBufferData = new ArrayBuffer(112)
        new Uint32Array(uniformBufferData, 0, 3).set([gridDimX, gridDimY, gridDimZ])
        new Float32Array(uniformBufferData, 12, 1).set([isoValue])
        new Float32Array(uniformBufferData, 16, 3).set([gridOffsetX, gridOffsetY, gridOffsetZ])
        new Float32Array(uniformBufferData, 28, 1).set([voxelSize])
        // mdcF0
        new Float32Array(uniformBufferData, 32, 4).set([activeEpsScale, activeEpsMin, insideBiasScale, insideBiasMin])
        // mdcF1
        new Float32Array(uniformBufferData, 48, 4).set([gradEpsScale, gradEpsMin, edgeProjTolScale, vertexProjTolScale])
        // mdcF2
        new Float32Array(uniformBufferData, 64, 4).set([vertexProjMarginScale, vertexProjMaxStepScale, qefRegScale, qefRegMin])
        // mdcF3
        new Float32Array(uniformBufferData, 80, 4).set([qefCondCutoff, orientationProbeScale, orientationProbeMin, 0])
        // mdcU0
        new Uint32Array(uniformBufferData, 96, 4).set([
            Math.max(0, edgeProjIters) >>> 0,
            Math.max(0, vertexProjIters) >>> 0,
            0,
            0,
        ])

        try {
            checkCancelled() // Check before creating buffers

            const uniformBuffer = createBuffer(
                "Uniforms",
                uniformBufferData.byteLength,
                GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
            )
            this.#device.queue.writeBuffer(uniformBuffer, 0, uniformBufferData)
            checkCancelled() // Check after buffer operations

            // Pass 1 Buffers
            const activeCellFlagsBuffer = createBuffer(
                "ActiveCellFlags",
                totalU32sInFlags * Uint32Array.BYTES_PER_ELEMENT,
                GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
            )
            const p1_cellClassification = this.#helper.createComputePipeline(mdcShaderModule, "cellClassification_Pass1")
            this.#localPipelines.push(p1_cellClassification)

            const bindGroupPass1 = this.#helper.createBindGroup(
                0,
                "BindGroup Pass1",
                p1_cellClassification,
                [0, uniformBuffer],
                [1, activeCellFlagsBuffer],
                [27, this.#polygonVerticesBuffer],
                [28, this.#faceSelectionBuffer],
                [30, this.#mdcSceneParamsBuffer],
                [25, this.#cancellationBuffer]
            )
            this.#localBindGroups.push(bindGroupPass1[1])

            // --- Stage 1: classify cells into bit flags ---
            {
                progressCallback?.updateProgress("Pass 1: Cell Classification", 20)
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
                checkCancelled()
            }
            logDiag("after pass1 (cell classification)")

            // Read back flags and build a compact list on CPU.
            checkCancelled() // Check before CPU work
            const flagsData = await readBufferData(
                activeCellFlagsBuffer,
                totalU32sInFlags * Uint32Array.BYTES_PER_ELEMENT
            )
            checkCancelled() // Check after async operation

            const flagsArray = new Uint32Array(flagsData)

            // Build a compact active cell index list directly from flags.
            // This avoids any mismatch between count and enumeration.
            const activeList: number[] = []
            for (let block = 0; block < flagsArray.length; block++) {
                checkCancelled() // Check periodically during CPU work
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
            dbgLog("MdcExport").debug(`Active cells from flags: ${activeCellCount}`)
            if (activeCellCount === 0) {
                throw new Error("No active cells found, check grid bounds and scene")
            }
            logDiag("after flags readback + active list build", { activeCellCount })
            progressCallback?.updateProgress("Pass 2: Active Cell Compaction", 40)
            checkCancelled()

            checkCancelled() // Check before more CPU work
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
                checkCancelled() // Check periodically during hash table build
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
            logDiag("after CPU neighbor hash build", { hashEntries: tableEntries })

            // Pack activeCellCount into uniforms.mdcU0.z so Pass 3–5 stay within the
            // per-stage storage-buffer limit (Pass 5 otherwise needs 11 SSBOs).
            this.#device.queue.writeBuffer(uniformBuffer, 104, new Uint32Array([activeCellCount >>> 0]))

            // --- Stage 2: allocate buffers sized to active cells, then run MDC passes ---
            const activeCellIndicesBuffer = createBuffer(
                "ActiveCellIndices",
                activeCellCount * Uint32Array.BYTES_PER_ELEMENT,
                GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
            )
            this.#device.queue.writeBuffer(activeCellIndicesBuffer, 0, activeCellIndicesView)

            const cellToActiveHashBuffer = createBuffer(
                "CellToActiveHash",
                cellToActiveHash.byteLength,
                GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
            )
            this.#device.queue.writeBuffer(cellToActiveHashBuffer, 0, cellToActiveHash)

            const debugSkipCountersBuffer = createBuffer(
                "DebugSkipCounters",
                8 * Uint32Array.BYTES_PER_ELEMENT,
                GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
            )
            this.#device.queue.writeBuffer(debugSkipCountersBuffer, 0, new Uint32Array([0, 0, 0, 0, 0, 0, 0, 0]))

            const cellEdgeComponentsBuffer = createBuffer(
                "CellEdgeComponents",
                activeCellCount * 12 * Uint32Array.BYTES_PER_ELEMENT,
                GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
            )

            const cellQEFDataBuffer = createBuffer(
                "CellQEFData",
                activeCellCount * MAX_COMPONENTS_PER_CELL * SIZEOF_QEFDATA_STRUCT,
                GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
            )
            const verticesBuffer = createBuffer(
                "Vertices",
                activeCellCount * MAX_COMPONENTS_PER_CELL * SIZEOF_VERTEX,
                GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
            )

            const maxTriangles = activeCellCount * 6
            const maxIndices = maxTriangles * 3
            const indicesBuffer = createBuffer(
                "Indices",
                maxIndices * Uint32Array.BYTES_PER_ELEMENT,
                GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
            )
            const indexCountFaceBuffer = createBuffer(
                "IndexCountFace",
                Uint32Array.BYTES_PER_ELEMENT,
                GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
            )
            this.#device.queue.writeBuffer(indexCountFaceBuffer, 0, new Uint32Array([0]))
            logDiag("after GPU buffer allocations", { maxTriangles, maxIndices })

            const p3_edgeDetection = this.#helper.createComputePipeline(mdcShaderModule, "edgeDetection_Pass3")
            const p4_vertexGeneration = this.#helper.createComputePipeline(mdcShaderModule, "vertexGeneration_Pass4")
            const p5_generateTrianglesAtomic = this.#helper.createComputePipeline(mdcShaderModule, "generateTrianglesAtomic_Pass5")
            this.#localPipelines.push(p3_edgeDetection, p4_vertexGeneration, p5_generateTrianglesAtomic)

            const bindGroupPass3 = this.#helper.createBindGroup(
                0,
                "BindGroup Pass3",
                p3_edgeDetection,
                [0, uniformBuffer],
                [5, activeCellIndicesBuffer], // activeCellIndicesIn_edge
                [24, debugSkipCountersBuffer],
                [22, cellEdgeComponentsBuffer],
                [9, cellQEFDataBuffer],
                [27, this.#polygonVerticesBuffer],
                [28, this.#faceSelectionBuffer],
                [30, this.#mdcSceneParamsBuffer],
                [25, this.#cancellationBuffer]
            )
            this.#localBindGroups.push(bindGroupPass3[1])

            const bindGroupPass4 = this.#helper.createBindGroup(
                0,
                "BindGroup Pass4",
                p4_vertexGeneration,
                [0, uniformBuffer],
                [11, activeCellIndicesBuffer], // activeCellIndicesIn_vertex
                [12, cellQEFDataBuffer],
                [13, verticesBuffer],
                [27, this.#polygonVerticesBuffer],
                [28, this.#faceSelectionBuffer],
                [30, this.#mdcSceneParamsBuffer],
                [25, this.#cancellationBuffer]
            )
            this.#localBindGroups.push(bindGroupPass4[1])

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
                [22, cellEdgeComponentsBuffer],
                [23, cellToActiveHashBuffer],
                [24, debugSkipCountersBuffer],
                [27, this.#polygonVerticesBuffer],
                [28, this.#faceSelectionBuffer],
                [30, this.#mdcSceneParamsBuffer]
            )
            this.#localBindGroups.push(bindGroupPass5[1])

            // === Pass 3: Edge detection and per-cell union-find ===
            {
                progressCallback?.updateProgress("Pass 3: Edge Detection", 60)
                const ce = this.#device.createCommandEncoder({ label: "mdc_pass3" })
                const pass = this.#helper.beginComputePass(ce, p3_edgeDetection, bindGroupPass3)
                // Use 2D dispatch if workgroup count exceeds hardware limit
                const totalWorkgroups = Math.ceil(activeCellCount / 64)
                const dispatchX = Math.min(totalWorkgroups, 65535)
                const dispatchY = Math.ceil(totalWorkgroups / dispatchX)
                pass.dispatchWorkgroups(dispatchX, dispatchY, 1)
                pass.end()
                this.#device.queue.submit([ce.finish()])
                await this.#device.queue.onSubmittedWorkDone()
                checkCancelled()
            }
            logDiag("after pass3 (edge detection)", { activeCellCount })

            // === Pass 4: Vertex generation (per-cell, per-component) ===
            // We intentionally do NOT do any cross-cell/global connectivity here.
            // MDC requires vertices per *local* connected component within each cell.
            {
                progressCallback?.updateProgress("Pass 4: Vertex Generation", 80)
                const totalVertexRecords = activeCellCount * MAX_COMPONENTS_PER_CELL
                const ce = this.#device.createCommandEncoder({ label: "mdc_pass4" })
                const pass = this.#helper.beginComputePass(ce, p4_vertexGeneration, bindGroupPass4)
                const totalWorkgroups = Math.ceil(totalVertexRecords / 64)
                const dispatchX = Math.min(totalWorkgroups, 65535)
                const dispatchY = Math.ceil(totalWorkgroups / dispatchX)
                pass.dispatchWorkgroups(dispatchX, dispatchY, 1)
                pass.end()
                this.#device.queue.submit([ce.finish()])
                await this.#device.queue.onSubmittedWorkDone()
                checkCancelled()
            }
            logDiag("after pass4 (vertex generation)")

            // === Pass 5: Triangle generation using local component IDs ===
            {
                progressCallback?.updateProgress("Pass 5: Triangle Generation", 90)
                const ce = this.#device.createCommandEncoder({ label: "mdc_pass5" })
                const pass = this.#helper.beginComputePass(ce, p5_generateTrianglesAtomic, bindGroupPass5)
                // Use 2D dispatch if workgroup count exceeds hardware limit
                const totalWorkgroups = Math.ceil(activeCellCount / 64)
                const dispatchX = Math.min(totalWorkgroups, 65535)
                const dispatchY = Math.ceil(totalWorkgroups / dispatchX)
                pass.dispatchWorkgroups(dispatchX, dispatchY, 1)
                pass.end()
                this.#device.queue.submit([ce.finish()])
                await this.#device.queue.onSubmittedWorkDone()
                checkCancelled()
            }
            logDiag("after pass5 (triangle generation)")

            dbgLog("MdcExport").debug("Reading back data from GPU...")
            const debugCountsData = await readBufferData(debugSkipCountersBuffer, 8 * Uint32Array.BYTES_PER_ELEMENT)
            const debugCounts = new Uint32Array(debugCountsData)
            dbgLog("MdcExport").debug("MDC debug:", {
                skippedQuadsNeighborMissing: debugCounts[0],
                skippedQuadsComponentMissing: debugCounts[1],
                edgesBothNearIso: debugCounts[2],
                edgesOneNearIsoNoCross: debugCounts[3],
                cornersNearIso: debugCounts[4],
                edgesCrossing: debugCounts[5],
                faceCenterNearIso: debugCounts[6],
                faceCaseAmbiguous: debugCounts[7],
            })
            const indexCountData = await readBufferData(indexCountFaceBuffer)
            const rawIndexCount = new Uint32Array(indexCountData)[0]!
            const actualIndexCount = Math.min(rawIndexCount, maxIndices)
            dbgLog("MdcExport").debug(
                `Actual Index Count: ${actualIndexCount}${actualIndexCount !== rawIndexCount ? " (clamped)" : ""}`
            )

            const actualVertexCount = activeCellCount * MAX_COMPONENTS_PER_CELL
            const verticesData = await readBufferData(verticesBuffer, actualVertexCount * SIZEOF_VERTEX)
            let verts = new Float32Array(verticesData)

            const indicesData = await readBufferData(
                indicesBuffer,
                actualIndexCount * Uint32Array.BYTES_PER_ELEMENT
            )
            let tris = new Uint32Array(indicesData)
            logDiag("after GPU readback", {
                actualIndexCount,
                actualVertexCount,
                triCount: Math.floor(tris.length / 3),
            })

            reorientMeshTriangleWinding(verts, tris, SIZEOF_VERTEX)

            // Vertex splitting at sharp edges (crease detection).
            // The GPU produces one normal per vertex via SDF gradient, which is
            // discontinuous at sharp features. Split vertices at creases and assign
            // averaged face normals per smooth group so adjacent flat faces don't
            // share a single (wrong) normal through interpolation.
            {
                const creaseAngle = this.params.creaseAngleDeg ?? 30
                if (creaseAngle < 180) {
                    const beforeCount = (verts.length / (SIZEOF_VERTEX / 4)) | 0
                    const split = splitCreaseVertices(verts, tris, creaseAngle, SIZEOF_VERTEX)
                    verts = split.verts
                    tris = split.tris
                    const afterCount = (verts.length / (SIZEOF_VERTEX / 4)) | 0
                    dbgLog("MdcExport").debug(
                        `Crease split: ${beforeCount} → ${afterCount} verts (+${afterCount - beforeCount}, ${creaseAngle}° threshold)`
                    )
                }
            }
            logDiag("after crease split")

            {
                const simplified = await optionalSimplifyExportedMesh(verts, tris, this.params)
                verts = simplified.verts
                tris = simplified.tris
            }

            logExportMeshSanityStats(verts, tris, this.params.voxelSize, SIZEOF_VERTEX, "MdcExport", "MDC")

            progressCallback?.updateProgress("Complete", 100)
            logDiag("done")
            return { verts, tris }

        } finally {
            this.#clearPassResourceLists()
            this.#destroyLocalBuffers()
            logDiag("GPU cleanup (buffers destroyed, pass lists cleared)")
        }
    }
}
