import { GPUHelper } from "../gpu/helper.mjs"
import { log as dbgLog } from "../logging/debug-log.mjs"
import { MeshData } from "./export.mjs"
import {
    logExportMeshSanityStats,
    optionalSimplifyExportedMesh,
    orientTrianglesToMatchAnalyticNormals,
    smoothNormalsByAreaWeightedFaceAverage,
} from "./mesh-postprocess.mjs"
import { SIZEOF_VERTEX, type MDCParams, type ProgressCallback } from "./mdc.mjs"

const VERTEX_STRIDE_F32 = SIZEOF_VERTEX / Float32Array.BYTES_PER_ELEMENT

/**
 * Drop triangles whose welded-vertex positions are coincident or near-coincident.
 * MT inherently produces zero-area slivers when an iso-crossing lands on a dual vertex
 * with `fval ≈ 0` and adjacent tet-edges all collapse to that point. Welding then
 * leaves several triangles with 2 or 3 identical vertex indices. Such triangles
 * fragment downstream BFS reorientation (count-2 edges become count > 2 once neighbours
 * share a degenerate triangle), so removing them before reorient/sign-flip restores
 * a clean manifold.
 *
 * `areaEpsRel` is the relative threshold; absolute area cutoff is `voxelSize² * areaEpsRel²`.
 * Returns the new (verts unchanged, tris filtered) pair plus drop count for logging.
 */
function dropDegenerateTriangles(
    verts: Float32Array<ArrayBuffer>,
    tris: Uint32Array<ArrayBuffer>,
    voxelSize: number,
    areaEpsRel: number = 1e-4,
): { tris: Uint32Array<ArrayBuffer>; dropped: number } {
    const triCount = (tris.length / 3) | 0
    if (triCount === 0) return { tris, dropped: 0 }
    const stride = VERTEX_STRIDE_F32
    const areaEpsSq = (voxelSize * voxelSize * areaEpsRel) ** 2
    const out = new Uint32Array(tris.length)
    let n = 0
    for (let t = 0; t < triCount; t++) {
        const i0 = tris[t * 3]!
        const i1 = tris[t * 3 + 1]!
        const i2 = tris[t * 3 + 2]!
        if (i0 === i1 || i1 === i2 || i0 === i2) continue
        const b0 = i0 * stride, b1 = i1 * stride, b2 = i2 * stride
        const ax = verts[b1]! - verts[b0]!
        const ay = verts[b1 + 1]! - verts[b0 + 1]!
        const az = verts[b1 + 2]! - verts[b0 + 2]!
        const bx = verts[b2]! - verts[b0]!
        const by = verts[b2 + 1]! - verts[b0 + 1]!
        const bz = verts[b2 + 2]! - verts[b0 + 2]!
        const nx = ay * bz - az * by
        const ny = az * bx - ax * bz
        const nz = ax * by - ay * bx
        const a2 = nx * nx + ny * ny + nz * nz
        if (!isFinite(a2) || a2 <= areaEpsSq) continue
        out[n * 3 + 0] = i0
        out[n * 3 + 1] = i1
        out[n * 3 + 2] = i2
        n++
    }
    const compact = new Uint32Array(n * 3)
    compact.set(out.subarray(0, n * 3))
    return { tris: compact, dropped: triCount - n }
}

/**
 * Deduplicate Pass-6 mesh vertices by quantized world position. Sums the analytic-gradient
 * normals across collapsed duplicates (Pass 6 writes `safeUnit3(sceneSDF_mid(pos).n)` per
 * triangle corner) and renormalizes; positions remain bit-identical because they come from
 * deterministic `interp_iso_crossing` of the same DualVertex pair.
 *
 * Quant step is `voxelSize * 1e-2` — well above float32 ULP for typical CAD coordinates
 * but small enough that adjacent grid crossings never collide (closest spacing is ~voxel).
 */
function weldIsoMeshByQuantizedPosition(verts: Float32Array, tris: Uint32Array, voxelSize: number): MeshData {
    const vertexCount = (verts.length / VERTEX_STRIDE_F32) | 0

    // 0.1% of a voxel = 0.5 µm at voxel=0.5 mm. Large enough to absorb any ULP-level drift
    // (~12 nm at world-coord 100 mm) yet small enough that legitimately distinct contour
    // vertices on adjacent tet edges (typically ≥10% of a voxel apart) never collide. A
    // wider tolerance over-merges hub crossings (where face/cube duals near fval=0 attract
    // many tets to coincident contour points) into degenerate triangles + non-manifold edges.
    const quant = Math.max(voxelSize * 1e-3, Number.EPSILON * 2)
    const invQuant = 1 / quant
    const u64Mask = (1n << 64n) - 1n
    const asU64 = (n: bigint) => n & u64Mask
    const posKey = (px: number, py: number, pz: number): bigint => {
        const qx = BigInt(Math.round(px * invQuant))
        const qy = BigInt(Math.round(py * invQuant))
        const qz = BigInt(Math.round(pz * invQuant))
        return (asU64(qx) << 128n) | (asU64(qy) << 64n) | asU64(qz)
    }

    const remap = new Uint32Array(vertexCount)
    const consolidated = new Map<bigint, number>()
    let outVerts = 0

    for (let i = 0; i < vertexCount; i++) {
        const src = i * VERTEX_STRIDE_F32
        const key = posKey(verts[src]!, verts[src + 1]!, verts[src + 2]!)

        let dst = consolidated.get(key)
        if (dst === undefined) {
            dst = outVerts++
            consolidated.set(key, dst)
        }
        remap[i] = dst
    }

    const weldedVerts = new Float32Array(outVerts * VERTEX_STRIDE_F32)
    // First pass: copy positions from any contributing source vertex (positions are bit-identical
    // for a given quantization bucket — see weld preconditions in the doc comment).
    const wrote = new Uint8Array(outVerts)
    for (let i = 0; i < vertexCount; i++) {
        const dst = remap[i]!
        if (wrote[dst]) continue
        wrote[dst] = 1
        const dstOff = dst * VERTEX_STRIDE_F32
        const srcOff = i * VERTEX_STRIDE_F32
        // Position (px, py, pz, pad) — slots 0..3
        weldedVerts[dstOff + 0] = verts[srcOff + 0]!
        weldedVerts[dstOff + 1] = verts[srcOff + 1]!
        weldedVerts[dstOff + 2] = verts[srcOff + 2]!
    }
    // Second pass: sum normals from every contributing source vertex.
    for (let i = 0; i < vertexCount; i++) {
        const dst = remap[i]!
        const dstOff = dst * VERTEX_STRIDE_F32
        const srcOff = i * VERTEX_STRIDE_F32
        weldedVerts[dstOff + 4] += verts[srcOff + 4]!
        weldedVerts[dstOff + 5] += verts[srcOff + 5]!
        weldedVerts[dstOff + 6] += verts[srcOff + 6]!
    }
    // Renormalize summed normals; fall back to (0, 0, 0) if degenerate.
    for (let d = 0; d < outVerts; d++) {
        const off = d * VERTEX_STRIDE_F32
        const nx = weldedVerts[off + 4]!
        const ny = weldedVerts[off + 5]!
        const nz = weldedVerts[off + 6]!
        const len = Math.hypot(nx, ny, nz)
        if (len > 1e-12) {
            const inv = 1 / len
            weldedVerts[off + 4] = nx * inv
            weldedVerts[off + 5] = ny * inv
            weldedVerts[off + 6] = nz * inv
        }
    }

    const newTris = new Uint32Array(tris.length)
    for (let i = 0; i < tris.length; i++) {
        newTris[i] = remap[tris[i]!]!
    }

    return { verts: weldedVerts, tris: newTris }
}

/** ISO Phase-1 uniform grid export — same tuning/grid fields as `MDCParams`. */
export type ISOParams = MDCParams

/** Uniform layout must match `SharedUniforms` in `src/shaders/iso.wgsl` (128 bytes). */
const ISO_UNIFORM_BYTE_SIZE = 128

/**
 * Per-buffer byte sizes for Phase-1 ISO dense layout (must match `ISOExport.export` allocations).
 * Dense `allDuals` scales ~O(grid³); large scenes exceed `maxBufferSize` unless voxel is coarsened.
 */
export function estimateIsoExportBufferBytes(gridDimX: number, gridDimY: number, gridDimZ: number): {
    allDuals: number
    meshVertices: number
    meshIndices: number
    activeCellFlags: number
} {
    const dx = gridDimX
    const dy = gridDimY
    const dz = gridDimZ
    const nx = Math.max(0, dx - 1)
    const ny = Math.max(0, dy - 1)
    const nz = Math.max(0, dz - 1)
    const nEdgeX = Math.max(0, dx - 1) * dy * dz
    const nEdgeY = dx * Math.max(0, dy - 1) * dz
    const nEdgeZ = dx * dy * Math.max(0, dz - 1)
    const totalEdges = nEdgeX + nEdgeY + nEdgeZ
    const nFaceXY = Math.max(0, dx - 1) * Math.max(0, dy - 1) * dz
    const nFaceYZ = dx * Math.max(0, dy - 1) * Math.max(0, dz - 1)
    const nFaceXZ = Math.max(0, dx - 1) * dy * Math.max(0, dz - 1)
    const totalFaces = nFaceXY + nFaceYZ + nFaceXZ
    const cornerCount = dx * dy * dz
    const cellCount = nx * ny * nz
    const totalDualSlots = cornerCount + totalEdges + totalFaces + cellCount
    const dualStride = 4 * Float32Array.BYTES_PER_ELEMENT
    const allDuals = totalDualSlots * dualStride
    const maxTriangles = cellCount * 96
    const maxIndices = maxTriangles * 3
    const meshVertices = maxIndices * SIZEOF_VERTEX
    const meshIndices = maxIndices * Uint32Array.BYTES_PER_ELEMENT
    const totalGridCells = dx * dy * dz
    const totalU32sInFlags = Math.ceil(totalGridCells / 32)
    const activeCellFlags = totalU32sInFlags * Uint32Array.BYTES_PER_ELEMENT
    return { allDuals, meshVertices, meshIndices, activeCellFlags }
}

export function isoExportBuffersFitDeviceLimits(
    gridDimX: number,
    gridDimY: number,
    gridDimZ: number,
    limits: { maxBufferSize: number; maxStorageBufferBindingSize: number },
): boolean {
    const e = estimateIsoExportBufferBytes(gridDimX, gridDimY, gridDimZ)
    const maxB = limits.maxBufferSize
    const maxS = limits.maxStorageBufferBindingSize
    return (
        e.allDuals <= maxB
        && e.allDuals <= maxS
        && e.meshVertices <= maxB
        && e.meshVertices <= maxS
        && e.meshIndices <= maxB
        && e.meshIndices <= maxS
        && e.activeCellFlags <= maxB
        && e.activeCellFlags <= maxS
    )
}

/**
 * Increase voxel (coarser grid) until ISO dense buffers fit both `maxBufferSize` and
 * `maxStorageBufferBindingSize`. Phase-1 ISO uses much more GPU memory than MDC per cell.
 */
export function chooseIsoVoxelForGpuLimits(
    sizeX: number,
    sizeY: number,
    sizeZ: number,
    baseVoxelMm: number,
    limits: { maxBufferSize: number; maxStorageBufferBindingSize: number },
): { voxelSizeMm: number; gridDimX: number; gridDimY: number; gridDimZ: number } {
    const minVox = Math.max(baseVoxelMm, 1e-6)
    let voxel = minVox
    /** Beyond this, prefer MDC or tighter bounds — dense ISO duals are O(grid³). */
    const maxVoxelMm = 128.0
    for (let iter = 0; iter < 64; iter++) {
        const gridDimX = Math.max(2, Math.ceil(sizeX / voxel) + 1)
        const gridDimY = Math.max(2, Math.ceil(sizeY / voxel) + 1)
        const gridDimZ = Math.max(2, Math.ceil(sizeZ / voxel) + 1)
        if (isoExportBuffersFitDeviceLimits(gridDimX, gridDimY, gridDimZ, limits)) {
            return { voxelSizeMm: voxel, gridDimX, gridDimY, gridDimZ }
        }
        const next = voxel * 1.25
        if (next > maxVoxelMm) {
            break
        }
        voxel = next
    }
    const gridDimX = Math.max(2, Math.ceil(sizeX / voxel) + 1)
    const gridDimY = Math.max(2, Math.ceil(sizeY / voxel) + 1)
    const gridDimZ = Math.max(2, Math.ceil(sizeZ / voxel) + 1)
    const e = estimateIsoExportBufferBytes(gridDimX, gridDimY, gridDimZ)
    throw new Error(
        `ISO export: grid still too large for GPU after coarsening voxel up to ${maxVoxelMm} mm `
        + `(allDuals≈${e.allDuals} B, maxBufferSize=${limits.maxBufferSize}). `
        + `Use MDC export or reduce scene bounds.`,
    )
}

export class ISOExport {
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
        private params: ISOParams,
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

    #destroyLocalBuffers() {
        for (const buffer of this.#localBuffers) {
            buffer.destroy()
        }
        this.#localBuffers = []
    }

    #clearPassResourceLists() {
        this.#localBindGroups = []
        this.#localPipelines = []
    }

    async export(isoShaderModule: GPUShaderModule, progressCallback?: ProgressCallback): Promise<MeshData> {
        const perfNow = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now())
        const t0 = perfNow()

        this.#cancellationBuffer = this.#device.createBuffer({
            label: "ISO Cancellation",
            size: Uint32Array.BYTES_PER_ELEMENT,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        })
        this.#localBuffers.push(this.#cancellationBuffer)
        this.#device.queue.writeBuffer(this.#cancellationBuffer, 0, new Uint32Array([0]))

        progressCallback?.updateProgress("Initializing...", 0)

        const checkCancelled = () => {
            if (this.#cancelled || (progressCallback && progressCallback.cancelled)) {
                this.#cancelled = true
                if (this.#cancellationBuffer) {
                    this.#device.queue.writeBuffer(this.#cancellationBuffer, 0, new Uint32Array([1]))
                }
                throw new Error("ISO export was cancelled")
            }
        }

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
            estimatedGpuReadbackBytes += Math.min(size, buffer.size)
            return await this.#helper.readBufferData(buffer, size)
        }

        const logDiag = (phase: string, extra?: Record<string, unknown>) => {
            const elapsedMs = perfNow() - t0
            dbgLog("IsoExport").debug(`${phase}`, {
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

            activeEpsScale = 1e-7,
            activeEpsMin = 1e-7,
            insideBiasScale = 1e-6,
            insideBiasMin = 1e-9,

            gradEpsScale = 0.01,
            gradEpsMin = 1e-6,

            edgeProjTolScale = 1e-3,
            edgeProjIters = 8,

            vertexProjTolScale = 1e-3,
            vertexProjIters = 12,
            vertexProjMarginScale = 0.01,
            vertexProjMaxStepScale = 5,

            qefRegScale = 6.4e-2,
            qefRegMin = 1e-9,
            qefCondCutoff = 1e8,

            orientationProbeScale = 0.5,
            orientationProbeMin = 1e-4,
        } = this.params

        dbgLog("IsoExport").info(
            `ISOExport.export(): grid=${gridDimX}x${gridDimY}x${gridDimZ} voxel=${voxelSize} iso=${isoValue} offset=(${gridOffsetX},${gridOffsetY},${gridOffsetZ})`
        )
        if (gridDimX < 2 || gridDimY < 2 || gridDimZ < 2) {
            throw new Error("ISO export requires gridDimensions >= 2 on each axis")
        }
        logDiag("start", {
            maxBufferSize: this.#device.limits.maxBufferSize,
            maxStorageBufferBindingSize: this.#device.limits.maxStorageBufferBindingSize,
        })

        const dx = gridDimX
        const dy = gridDimY
        const dz = gridDimZ
        const nx = Math.max(0, dx - 1)
        const ny = Math.max(0, dy - 1)
        const nz = Math.max(0, dz - 1)

        const nEdgeX = Math.max(0, dx - 1) * dy * dz
        const nEdgeY = dx * Math.max(0, dy - 1) * dz
        const nEdgeZ = dx * dy * Math.max(0, dz - 1)
        const totalEdges = nEdgeX + nEdgeY + nEdgeZ

        const nFaceXY = Math.max(0, dx - 1) * Math.max(0, dy - 1) * dz
        const nFaceYZ = dx * Math.max(0, dy - 1) * Math.max(0, dz - 1)
        const nFaceXZ = Math.max(0, dx - 1) * dy * Math.max(0, dz - 1)
        const totalFaces = nFaceXY + nFaceYZ + nFaceXZ

        const cornerCount = dx * dy * dz
        const cellCount = nx * ny * nz

        const cornerBase = 0
        const edgeBase = cornerBase + cornerCount
        const faceBase = edgeBase + totalEdges
        const cubeBase = faceBase + totalFaces
        const totalDualSlots = cubeBase + cellCount

        const totalGridCells = dx * dy * dz
        const totalU32sInFlags = Math.ceil(totalGridCells / 32)

        const maxTriangles = cellCount * 96
        const maxIndices = maxTriangles * 3

        const limits = this.#device.limits
        const est = estimateIsoExportBufferBytes(dx, dy, dz)
        const assertFitsGpuLimit = (label: string, bytes: number) => {
            if (bytes > limits.maxBufferSize) {
                throw new Error(
                    `ISO export: ${label} (${bytes} B) exceeds maxBufferSize (${limits.maxBufferSize}). `
                    + `Use MDC export, increase voxel size, or tighten bounds.`,
                )
            }
            if (bytes > limits.maxStorageBufferBindingSize) {
                throw new Error(
                    `ISO export: ${label} (${bytes} B) exceeds maxStorageBufferBindingSize (${limits.maxStorageBufferBindingSize}). `
                    + `Use MDC export, increase voxel size, or tighten bounds.`,
                )
            }
        }
        assertFitsGpuLimit("allDuals", est.allDuals)
        assertFitsGpuLimit("meshVertices", est.meshVertices)
        assertFitsGpuLimit("meshIndices", est.meshIndices)
        assertFitsGpuLimit("activeCellFlags", est.activeCellFlags)

        try {
            checkCancelled()

            const uniformBufferData = new ArrayBuffer(ISO_UNIFORM_BYTE_SIZE)
            new Uint32Array(uniformBufferData, 0, 3).set([dx, dy, dz])
            new Float32Array(uniformBufferData, 12, 1).set([isoValue])
            new Float32Array(uniformBufferData, 16, 3).set([gridOffsetX, gridOffsetY, gridOffsetZ])
            new Float32Array(uniformBufferData, 28, 1).set([voxelSize])
            new Float32Array(uniformBufferData, 32, 4).set([activeEpsScale, activeEpsMin, insideBiasScale, insideBiasMin])
            new Float32Array(uniformBufferData, 48, 4).set([gradEpsScale, gradEpsMin, edgeProjTolScale, vertexProjTolScale])
            new Float32Array(uniformBufferData, 64, 4).set([
                vertexProjMarginScale,
                vertexProjMaxStepScale,
                qefRegScale,
                qefRegMin,
            ])
            new Float32Array(uniformBufferData, 80, 4).set([qefCondCutoff, orientationProbeScale, orientationProbeMin, 0])
            new Uint32Array(uniformBufferData, 96, 4).set([
                Math.max(0, edgeProjIters) >>> 0,
                Math.max(0, vertexProjIters) >>> 0,
                0,
                0,
            ])
            new Uint32Array(uniformBufferData, 112, 4).set([
                cornerBase >>> 0,
                edgeBase >>> 0,
                faceBase >>> 0,
                cubeBase >>> 0,
            ])

            const uniformBuffer = createBuffer("ISO Uniforms", ISO_UNIFORM_BYTE_SIZE, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)
            this.#device.queue.writeBuffer(uniformBuffer, 0, uniformBufferData)

            const activeCellFlagsBuffer = createBuffer(
                "ISO ActiveCellFlags",
                totalU32sInFlags * Uint32Array.BYTES_PER_ELEMENT,
                GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            )

            const allDualsBuffer = createBuffer("ISO allDuals", est.allDuals, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC)

            const meshVerticesBuffer = createBuffer(
                "ISO meshVertices",
                maxIndices * SIZEOF_VERTEX,
                GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
            )
            const meshIndicesBuffer = createBuffer(
                "ISO meshIndices",
                maxIndices * Uint32Array.BYTES_PER_ELEMENT,
                GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
            )
            const meshIndexCountBuffer = createBuffer(
                "ISO meshIndexCount",
                Uint32Array.BYTES_PER_ELEMENT,
                GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            )
            this.#device.queue.writeBuffer(meshIndexCountBuffer, 0, new Uint32Array([0]))

            const p1 = this.#helper.createComputePipeline(isoShaderModule, "classifyActiveCells_Pass1")
            const p2 = this.#helper.createComputePipeline(isoShaderModule, "placeCornerSamples_Pass2")
            const p3 = this.#helper.createComputePipeline(isoShaderModule, "placeEdgeDuals_Pass3")
            const p4 = this.#helper.createComputePipeline(isoShaderModule, "placeFaceDuals_Pass4")
            const p5 = this.#helper.createComputePipeline(isoShaderModule, "placeCubeDuals_Pass5")
            const p6 = this.#helper.createComputePipeline(isoShaderModule, "emitTetMeshTriangles_Pass6")
            const p7 = this.#helper.createComputePipeline(isoShaderModule, "projectAndNormalVertices_Pass7")
            this.#localPipelines.push(p1, p2, p3, p4, p5, p6, p7)

            const cancelBuf = this.#cancellationBuffer!

            const bg1 = this.#helper.createBindGroup(
                0,
                "ISO Pass1",
                p1,
                [0, uniformBuffer],
                [1, activeCellFlagsBuffer],
                [25, cancelBuf],
                [27, this.#polygonVerticesBuffer],
                [28, this.#faceSelectionBuffer],
                [30, this.#mdcSceneParamsBuffer],
            )
            this.#localBindGroups.push(bg1[1])

            const bgDual = this.#helper.createBindGroup(
                0,
                "ISO Pass2-5 dual",
                p2,
                [0, uniformBuffer],
                [2, allDualsBuffer],
                [25, cancelBuf],
                [27, this.#polygonVerticesBuffer],
                [28, this.#faceSelectionBuffer],
                [30, this.#mdcSceneParamsBuffer],
            )
            this.#localBindGroups.push(bgDual[1])

            // Pass3/Pass4 do not reference `activeCellFlags` (binding 1). Pass5 calls
            // `is_active_cell_at_min_corner` → layout includes binding 1; WebGPU requires exact entry counts.
            const bgDualPass34 = (pl: GPUComputePipeline) =>
                this.#helper.createBindGroup(
                    0,
                    `ISO ${pl.label}`,
                    pl,
                    [0, uniformBuffer],
                    [2, allDualsBuffer],
                    [25, cancelBuf],
                    [27, this.#polygonVerticesBuffer],
                    [28, this.#faceSelectionBuffer],
                    [30, this.#mdcSceneParamsBuffer],
                )

            const bg3 = bgDualPass34(p3)
            const bg4 = bgDualPass34(p4)
            const bg5 = this.#helper.createBindGroup(
                0,
                "ISO placeCubeDuals_Pass5",
                p5,
                [0, uniformBuffer],
                [1, activeCellFlagsBuffer],
                [2, allDualsBuffer],
                [25, cancelBuf],
                [27, this.#polygonVerticesBuffer],
                [28, this.#faceSelectionBuffer],
                [30, this.#mdcSceneParamsBuffer],
            )
            this.#localBindGroups.push(bg3[1], bg4[1], bg5[1])

            // Pass6 calls sceneSDF_mid for analytic vertex normals, so it needs scene SDF bindings
            // (27/28/30) plus the dual + mesh-output buffers.
            const bg6 = this.#helper.createBindGroup(
                0,
                "ISO Pass6",
                p6,
                [0, uniformBuffer],
                [2, allDualsBuffer],
                [3, meshVerticesBuffer],
                [4, meshIndicesBuffer],
                [5, meshIndexCountBuffer],
                [25, cancelBuf],
                [27, this.#polygonVerticesBuffer],
                [28, this.#faceSelectionBuffer],
                [30, this.#mdcSceneParamsBuffer],
            )
            this.#localBindGroups.push(bg6[1])

            // Pass 1
            progressCallback?.updateProgress("ISO Pass 1: classify cells", 10)
            {
                const ce = this.#device.createCommandEncoder({ label: "iso_pass1" })
                const pass = this.#helper.beginComputePass(ce, p1, bg1)
                const dispatchX = Math.min(totalU32sInFlags, 65535)
                const dispatchY = Math.ceil(totalU32sInFlags / dispatchX)
                pass.dispatchWorkgroups(dispatchX, dispatchY)
                pass.end()
                this.#device.queue.submit([ce.finish()])
                await this.#device.queue.onSubmittedWorkDone()
                checkCancelled()
            }
            logDiag("after pass1")

            // Pass 2
            progressCallback?.updateProgress("ISO Pass 2: corner duals", 25)
            {
                const totalWorkgroups = Math.ceil(cornerCount / 64)
                const dispatchX = Math.min(totalWorkgroups, 65535)
                const dispatchY = Math.ceil(totalWorkgroups / dispatchX)
                const ce = this.#device.createCommandEncoder({ label: "iso_pass2" })
                const pass = this.#helper.beginComputePass(ce, p2, bgDual)
                pass.dispatchWorkgroups(dispatchX, dispatchY, 1)
                pass.end()
                this.#device.queue.submit([ce.finish()])
                await this.#device.queue.onSubmittedWorkDone()
                checkCancelled()
            }
            logDiag("after pass2")

            // Passes 3–5 (single encoder)
            progressCallback?.updateProgress("ISO Pass 3–5: edge/face/cube duals", 55)
            {
                const enc = this.#device.createCommandEncoder({ label: "iso_pass345" })
                {
                    const wg = Math.ceil(totalEdges / 64)
                    const dx_ = Math.min(wg, 65535)
                    const dy_ = Math.ceil(wg / dx_)
                    let pass = this.#helper.beginComputePass(enc, p3, bg3)
                    pass.dispatchWorkgroups(dx_, dy_, 1)
                    pass.end()
                }
                {
                    const wg = Math.ceil(totalFaces / 64)
                    const dx_ = Math.min(wg, 65535)
                    const dy_ = Math.ceil(wg / dx_)
                    let pass = this.#helper.beginComputePass(enc, p4, bg4)
                    pass.dispatchWorkgroups(dx_, dy_, 1)
                    pass.end()
                }
                {
                    const wg = Math.ceil(cellCount / 64)
                    const dx_ = Math.min(wg, 65535)
                    const dy_ = Math.ceil(wg / dx_)
                    let pass = this.#helper.beginComputePass(enc, p5, bg5)
                    pass.dispatchWorkgroups(dx_, dy_, 1)
                    pass.end()
                }
                this.#device.queue.submit([enc.finish()])
                await this.#device.queue.onSubmittedWorkDone()
                checkCancelled()
            }
            logDiag("after pass3-5")

            // Pass 6
            progressCallback?.updateProgress("ISO Pass 6: emit triangles", 85)
            {
                const wg = Math.ceil(totalEdges / 64)
                const dispatchX = Math.min(wg, 65535)
                const dispatchY = Math.ceil(wg / dispatchX)
                const ce = this.#device.createCommandEncoder({ label: "iso_pass6" })
                const pass = this.#helper.beginComputePass(ce, p6, bg6)
                pass.dispatchWorkgroups(dispatchX, dispatchY, 1)
                pass.end()
                this.#device.queue.submit([ce.finish()])
                await this.#device.queue.onSubmittedWorkDone()
                checkCancelled()
            }
            logDiag("after pass6")

            progressCallback?.updateProgress("ISO: readback", 95)
            const countData = await readBufferData(meshIndexCountBuffer)
            const rawCount = new Uint32Array(countData)[0]!
            const actualIndexCount = Math.min(rawCount, maxIndices)
            dbgLog("IsoExport").debug(`mesh index count: ${actualIndexCount}${actualIndexCount !== rawCount ? " (clamped)" : ""}`)

            const verticesData = await readBufferData(meshVerticesBuffer, actualIndexCount * SIZEOF_VERTEX)
            const indicesData = await readBufferData(meshIndicesBuffer, actualIndexCount * Uint32Array.BYTES_PER_ELEMENT)

            let verts = new Float32Array(verticesData)
            let tris = new Uint32Array(indicesData)
            const rawVertexSlots = (verts.length / VERTEX_STRIDE_F32) | 0
            logDiag("after readback", {
                actualIndexCount,
                triCount: Math.floor(tris.length / 3),
                rawVertexSlots,
            })

            {
                const welded = weldIsoMeshByQuantizedPosition(verts, tris, voxelSize)
                const weldedCount = (welded.verts.length / VERTEX_STRIDE_F32) | 0
                const triCount = Math.floor(tris.length / 3)
                // Ideal weld: each interior tet face contributes 1 contour vertex shared by 2 tets
                // → weldedCount ≈ rawVertexSlots / 6 in well-meshed regions. If weldedCount is
                // close to rawVertexSlots, welding is failing to merge — typically a tolerance
                // mismatch or a per-tet position drift bug.
                const mergeRatio = rawVertexSlots > 0 ? (weldedCount / rawVertexSlots) : 1
                dbgLog("IsoExport").debug(
                    `CPU weld (quant=${(voxelSize * 1e-3).toExponential(3)} mm): `
                    + `verts ${rawVertexSlots} → ${weldedCount} (ratio ${mergeRatio.toFixed(3)}, `
                    + `tris ${triCount}, ${(weldedCount / Math.max(triCount, 1)).toFixed(2)} verts/tri; manifold target ≈ 0.5)`,
                )
                verts = welded.verts
                tris = welded.tris
            }
            logDiag("after CPU weld")

            // Pass 7: overwrite welded vertex normals with the analytic SDF gradient
            // (`sceneSDF_mid(p).n`). Deliberately does NOT move positions — a previous Newton
            // projection variant could split near-coincident welded vertices apart, undoing the
            // welding and reintroducing per-triangle facets in the mesh-viewer's normal-RGB
            // shading. Per AGENTS.md every scene SDF eval stays on the GPU.
            {
                const projVertCount = (verts.length / VERTEX_STRIDE_F32) | 0
                if (projVertCount > 0) {
                    const projBytes = projVertCount * SIZEOF_VERTEX
                    const projBuffer = createBuffer(
                        "ISO projectVertices",
                        projBytes,
                        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
                    )
                    this.#device.queue.writeBuffer(projBuffer, 0, verts.buffer, verts.byteOffset, projBytes)

                    // Pass 7 (normal-only) does NOT reference `uniforms`, so WGSL strips binding 0
                    // from the layout. Including it in the bind group fails validation.
                    const bg7 = this.#helper.createBindGroup(
                        0,
                        "ISO projectAndNormalVertices_Pass7",
                        p7,
                        [7, projBuffer],
                        [25, cancelBuf],
                        [27, this.#polygonVerticesBuffer],
                        [28, this.#faceSelectionBuffer],
                        [30, this.#mdcSceneParamsBuffer],
                    )
                    this.#localBindGroups.push(bg7[1])

                    progressCallback?.updateProgress("ISO Pass 7: project & normal", 92)
                    {
                        const wg = Math.ceil(projVertCount / 64)
                        const dispatchX = Math.min(wg, 65535)
                        const dispatchY = Math.ceil(wg / dispatchX)
                        const ce = this.#device.createCommandEncoder({ label: "iso_pass7" })
                        const pass = this.#helper.beginComputePass(ce, p7, bg7)
                        pass.dispatchWorkgroups(dispatchX, dispatchY, 1)
                        pass.end()
                        this.#device.queue.submit([ce.finish()])
                        await this.#device.queue.onSubmittedWorkDone()
                        checkCancelled()
                    }

                    const projData = await readBufferData(projBuffer, projBytes)
                    verts = new Float32Array(projData)
                    dbgLog("IsoExport").debug(`Pass 7 projected & normaled ${projVertCount} verts`)
                }
            }
            logDiag("after pass7 (project + analytic normals)")

            // Per-triangle winding alignment to the analytic SDF gradient (∇F is canonically
            // outward in SDF convention). This replaces BFS-based reorientation, which fragments
            // wherever a non-manifold edge appears (degenerate "hub" triangles produce many of
            // those for ISO's dense MT contour). Per-triangle alignment is robust and stateless.
            {
                const flipped = orientTrianglesToMatchAnalyticNormals(verts, tris, SIZEOF_VERTEX)
                const triCount = (tris.length / 3) | 0
                dbgLog("IsoExport").debug(
                    `Per-triangle analytic-normal orient: flipped ${flipped}/${triCount} `
                    + `(${triCount > 0 ? ((flipped / triCount) * 100).toFixed(1) : "0.0"}%)`,
                )
            }
            logDiag("after analytic-normal triangle orient")

            // Replace per-vertex analytic gradients with area-weighted face-normal averages.
            // The analytic ∇F from `sceneSDF_mid` is piecewise smooth (discontinuous at polygon
            // segment boundaries, CSG seams, smooth-blend transitions), which renders as
            // visible facets on otherwise-smooth surfaces (e.g. a torus lathed from a polygon
            // profile). Phong-style smoothing across each vertex's triangle ring removes those
            // facets at the cost of softening real sharp features (Phase 4 will handle those
            // properly via 4D-QEF dual placement).
            smoothNormalsByAreaWeightedFaceAverage(verts, tris, SIZEOF_VERTEX)
            logDiag("after Phong smoothing")

            // Note: we deliberately skip `splitCreaseVertices` here. That pass
            // would overwrite Pass 7's analytical normals with face-averaged
            // ones, which on the dense MT triangulation re-introduces the
            // jagged shading we just fixed. Sharp-feature recovery is Phase 4
            // (proper 4D-QEF dual placement); until then, smooth analytic
            // normals are the right Phase-1 trade-off across all surfaces.

            {
                const simplified = await optionalSimplifyExportedMesh(verts, tris, this.params)
                verts = simplified.verts
                tris = simplified.tris
            }

            logExportMeshSanityStats(verts, tris, voxelSize, SIZEOF_VERTEX, "IsoExport", "ISO")

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
