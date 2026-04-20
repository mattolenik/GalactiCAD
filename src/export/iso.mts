import { GPUHelper } from "../gpu/helper.mjs"
import { log as dbgLog } from "../logging/debug-log.mjs"
import { MeshData } from "./export.mjs"
import {
    logExportMeshSanityStats,
    optionalSimplifyExportedMesh,
    reorientMeshTriangleWinding,
    smoothNormalsByAreaWeightedFaceAverage,
    splitCreaseVertices,
} from "./mesh-postprocess.mjs"
import { computeSparseDualSets } from "./iso-sparse.mjs"
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
    // vertices on adjacent tet edges (typically ≥10% of a voxel apart) never collide.
    const quant = Math.max(voxelSize * 1e-3, Number.EPSILON * 2)
    const invQuant = 1 / quant

    // Open-addressing hash table on quantized 3D coords (qx, qy, qz). We use a 4-Uint32-
    // per-slot layout: (qx, qy, qz, dstSlot). Comparison on insert/lookup is 3 i32 equals
    // — much faster than BigInt key allocation + Map<bigint, number> at ~10M+ vertices.
    // Power-of-2 size, ≤ 50% load factor → average probe count well under 2.
    let hashEntries = 1
    const target = Math.max(64, vertexCount * 2)
    while (hashEntries < target) hashEntries <<= 1
    const hashMask = hashEntries - 1
    const hash = new Int32Array(hashEntries * 4)
    hash.fill(-2147483648) // sentinel: no slot key can be INT32_MIN since we offset/round.
    const HASH_KNUTH = 0x9e3779b1 | 0
    const remap = new Uint32Array(vertexCount)
    let outVerts = 0

    for (let i = 0; i < vertexCount; i++) {
        const src = i * VERTEX_STRIDE_F32
        const qx = Math.round(verts[src]! * invQuant) | 0
        const qy = Math.round(verts[src + 1]! * invQuant) | 0
        const qz = Math.round(verts[src + 2]! * invQuant) | 0
        // Mix the 3 quantized coords into a single 32-bit hash via two Knuth multiplies.
        let h = Math.imul(qx ^ Math.imul(qy, HASH_KNUTH) ^ Math.imul(qz, HASH_KNUTH ^ 0x12345678), HASH_KNUTH)
        let probe = (h >>> 0) & hashMask
        while (true) {
            const base = probe * 4
            const ekx = hash[base]!
            if (ekx === -2147483648) {
                hash[base] = qx
                hash[base + 1] = qy
                hash[base + 2] = qz
                hash[base + 3] = outVerts
                remap[i] = outVerts++
                break
            }
            if (ekx === qx && hash[base + 1]! === qy && hash[base + 2]! === qz) {
                remap[i] = hash[base + 3]!
                break
            }
            probe = (probe + 1) & hashMask
        }
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

/**
 * Uniform layout must match `SharedUniforms` in `src/shaders/iso.wgsl`. Phase 5B added
 * sparse bases / counts / hash mask, growing the struct to 192 bytes.
 *
 * Byte map:
 *   000–015 : gridDimensions (vec3u) + isoValue (f32)
 *   016–031 : gridOffset (vec3f) + voxelSize (f32)
 *   032–047 : mdcF0 (vec4f)
 *   048–063 : mdcF1 (vec4f)
 *   064–079 : mdcF2 (vec4f)
 *   080–095 : mdcF3 (vec4f)
 *   096–111 : mdcU0 (vec4u)
 *   112–127 : sparseBases0  = (cornerBase, edgeXBase, edgeYBase, edgeZBase)
 *   128–143 : sparseBases1  = (faceXYBase, faceYZBase, faceXZBase, cubeBase)
 *   144–159 : sparseCounts0 = (cornerCount, edgeXCount, edgeYCount, edgeZCount)
 *   160–175 : sparseCounts1 = (faceXYCount, faceYZCount, faceXZCount, cubeCount)
 *   176–191 : sparseHash    = (hashMask, hashEntries, _, _)
 */
const ISO_UNIFORM_BYTE_SIZE = 192

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
    // Phase 5B: only `activeCellFlags` is dense; everything else (allDuals, hash, mesh
    // output) is sized after Pass 1 from the sparse cube count. We model worst-case
    // sparse memory as a small fraction of the dense estimate:
    //   sparse fraction ≈ surface-area / volume × voxel_size  →  typically 1–5%.
    // The mesh output is sized by `sparseCubeCount × 96 verts × stride`, where sparse-
    // cube count is at most ~3% of dense cube count for a 1-cell-thick surface shell.
    // We use 5% as a conservative upper bound to stay safe on weirdly-shaped scenes.
    const sparseFrac = 0.05
    const sparseAllDuals = Math.ceil(e.allDuals * sparseFrac)
    // Mesh output scales with sparse CUBE count × per-cube vertex factor. The dense
    // estimate uses cellCount × 96 verts; sparse uses sparseCubes × 36 verts. Sparse
    // cubes are ~ 1/10 of dense slots (cubes ≈ 1/8 of slots × ~ sparseFrac applies),
    // and the factor reduction is 36/96 = 0.375.
    const sparseMeshVerts = Math.ceil(e.meshVertices * sparseFrac * 0.375)
    const sparseMeshIndices = Math.ceil(e.meshIndices * sparseFrac * 0.375)
    // Hash table: 2× sparse slots × 8 bytes per entry = 1× slot bytes (since slots are
    // 16 B). Approximately equal to sparseAllDuals.
    const sparseHash = sparseAllDuals
    return (
        sparseAllDuals <= maxB && sparseAllDuals <= maxS
        && sparseHash <= maxB && sparseHash <= maxS
        && sparseMeshVerts <= maxB && sparseMeshVerts <= maxS
        && sparseMeshIndices <= maxB && sparseMeshIndices <= maxS
        && e.activeCellFlags <= maxB && e.activeCellFlags <= maxS
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

        const limits = this.#device.limits
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
        // Phase 5B: don't pre-check the dense allDuals / meshVertices size — they're sized
        // from the sparse cube count after Pass 1 runs. We still pre-check `activeCellFlags`
        // because that's allocated on the dense grid before Pass 1.
        const est = estimateIsoExportBufferBytes(dx, dy, dz)
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

            // `allDuals`, `meshVertices`, `meshIndices`, `meshIndexCount` and bind groups for
            // passes 2..6 are all allocated AFTER Pass 1 + sparse compute — they need to be
            // sized by the sparse cube count, not the dense `cellCount`. Only Pass 1 (which
            // needs only `activeCellFlags`) runs before sparse setup.

            const p1 = this.#helper.createComputePipeline(isoShaderModule, "classifyActiveCells_Pass1")
            const p2 = this.#helper.createComputePipeline(isoShaderModule, "placeCornerSamples_Pass2")
            const p3 = this.#helper.createComputePipeline(isoShaderModule, "placeEdgeDuals_Pass3")
            const p4 = this.#helper.createComputePipeline(isoShaderModule, "placeFaceDuals_Pass4")
            const p5 = this.#helper.createComputePipeline(isoShaderModule, "placeCubeDuals_Pass5")
            const p6 = this.#helper.createComputePipeline(isoShaderModule, "emitTetMeshTriangles_Pass6")
            // Phase 3 (paper §4.1) — triangulation improvement: relax edge / face duals onto
            // the iso surface when the per-cell topology safety test passes. Cube
            // improvement deferred (Union-Find on 26 boundary duals).
            const p8 = this.#helper.createComputePipeline(isoShaderModule, "improveEdgeDuals_Pass8")
            const p9 = this.#helper.createComputePipeline(isoShaderModule, "improveFaceDuals_Pass9")
            this.#localPipelines.push(p1, p2, p3, p4, p5, p6, p8, p9)

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

            // Phase 5B: read back active flags, compute the dilated sparse set, allocate
            // and upload sparse buffers, and update the per-pass uniforms with bases / counts.
            const flagsData = await readBufferData(activeCellFlagsBuffer)
            const flags = new Uint32Array(flagsData)
            const tSparse0 = perfNow()
            const sparse = computeSparseDualSets(flags, dx, dy, dz)
            const sparseMs = perfNow() - tSparse0
            if (sparse.totalDualSlots === 0) {
                throw new Error("ISO export: no active cells found in sparse set; scene SDF may be empty.")
            }
            const denseSlotsForLog = totalDualSlots
            const ratio = denseSlotsForLog > 0 ? sparse.totalDualSlots / denseSlotsForLog : 1
            dbgLog("IsoExport").debug(
                `Sparse build (CPU ${sparseMs.toFixed(1)}ms): `
                + `slots ${sparse.totalDualSlots} / ${denseSlotsForLog} (${(ratio * 100).toFixed(2)}% of dense), `
                + `corners=${sparse.cornerCompactList.length} `
                + `edgesXYZ=${sparse.edgeXCompactList.length}+${sparse.edgeYCompactList.length}+${sparse.edgeZCompactList.length} `
                + `facesXY/YZ/XZ=${sparse.faceXYCompactList.length}+${sparse.faceYZCompactList.length}+${sparse.faceXZCompactList.length} `
                + `cubes=${sparse.cubeCompactList.length} `
                + `hash=${sparse.hashEntries} entries (${fmtBytes(sparse.hashTable.byteLength)}) `
                + `timing=${JSON.stringify(sparse.timingMs)}`,
            )

            // Concatenate per-category compact lists in the order matching the WGSL bases.
            const allCompactList = new Uint32Array(sparse.totalDualSlots)
            allCompactList.set(sparse.cornerCompactList, sparse.cornerBase)
            allCompactList.set(sparse.edgeXCompactList, sparse.edgeXBase)
            allCompactList.set(sparse.edgeYCompactList, sparse.edgeYBase)
            allCompactList.set(sparse.edgeZCompactList, sparse.edgeZBase)
            allCompactList.set(sparse.faceXYCompactList, sparse.faceXYBase)
            allCompactList.set(sparse.faceYZCompactList, sparse.faceYZBase)
            allCompactList.set(sparse.faceXZCompactList, sparse.faceXZBase)
            allCompactList.set(sparse.cubeCompactList, sparse.cubeBase)

            const sparseAllDualsBytes = sparse.totalDualSlots * 16
            const sparseAllDualsBuffer = createBuffer(
                "ISO sparseAllDuals",
                sparseAllDualsBytes,
                GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
            )
            const sparseHashBuffer = createBuffer(
                "ISO sparseHashTable",
                sparse.hashTable.byteLength,
                GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            )
            this.#device.queue.writeBuffer(sparseHashBuffer, 0, sparse.hashTable.buffer, sparse.hashTable.byteOffset, sparse.hashTable.byteLength)
            const sparseCompactBuffer = createBuffer(
                "ISO sparseCompactList",
                allCompactList.byteLength,
                GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            )
            this.#device.queue.writeBuffer(sparseCompactBuffer, 0, allCompactList.buffer, allCompactList.byteOffset, allCompactList.byteLength)

            // Patch uniforms with sparse bases / counts / hash. The byte ranges below match
            // the `SharedUniforms` doc-comment on `ISO_UNIFORM_BYTE_SIZE`.
            const sparseBases0 = new Uint32Array([
                sparse.cornerBase, sparse.edgeXBase, sparse.edgeYBase, sparse.edgeZBase,
            ])
            const sparseBases1 = new Uint32Array([
                sparse.faceXYBase, sparse.faceYZBase, sparse.faceXZBase, sparse.cubeBase,
            ])
            const sparseCounts0 = new Uint32Array([
                sparse.cornerCompactList.length, sparse.edgeXCompactList.length,
                sparse.edgeYCompactList.length, sparse.edgeZCompactList.length,
            ])
            const sparseCounts1 = new Uint32Array([
                sparse.faceXYCompactList.length, sparse.faceYZCompactList.length,
                sparse.faceXZCompactList.length, sparse.cubeCompactList.length,
            ])
            const sparseHash = new Uint32Array([sparse.hashMask, sparse.hashEntries, 0, 0])
            this.#device.queue.writeBuffer(uniformBuffer, 112, sparseBases0)
            this.#device.queue.writeBuffer(uniformBuffer, 128, sparseBases1)
            this.#device.queue.writeBuffer(uniformBuffer, 144, sparseCounts0)
            this.#device.queue.writeBuffer(uniformBuffer, 160, sparseCounts1)
            this.#device.queue.writeBuffer(uniformBuffer, 176, sparseHash)

            // Mesh output sized to sparse cube count. Theoretical worst case per cube:
            // 16 tets × 2 triangles × 3 verts = 96 vertices. Empirically actual emission
            // averages 4–8 verts per cube on smooth surfaces, 12–24 on sharp-feature
            // CAD parts. We use 36 (~12 tris/cube) as a generous-but-fits-in-4GB cap;
            // Pass 6's atomicAdd-with-cap cleanly drops anything above this.
            const PER_CUBE_VERT_FACTOR = 36
            const sparseMaxTriangles = sparse.cubeCompactList.length * PER_CUBE_VERT_FACTOR
            const sparseMaxIndices = sparseMaxTriangles * 3
            const meshVerticesBuffer = createBuffer(
                "ISO meshVertices",
                sparseMaxIndices * SIZEOF_VERTEX,
                GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
            )
            const meshIndicesBuffer = createBuffer(
                "ISO meshIndices",
                sparseMaxIndices * Uint32Array.BYTES_PER_ELEMENT,
                GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
            )
            const meshIndexCountBuffer = createBuffer(
                "ISO meshIndexCount",
                Uint32Array.BYTES_PER_ELEMENT,
                GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            )
            this.#device.queue.writeBuffer(meshIndexCountBuffer, 0, new Uint32Array([0]))

            // Bind groups for passes 2..6 — created here because they depend on the sparse
            // buffers we just allocated. Pass 2/3/4 only write to sparseAllDualsBuffer (no
            // hash lookups). Pass 5 also reads activeCellFlags for its is_active fallback.
            // Pass 6 uses the hash table for its dual lookups + the dispatch list to know
            // which active edge each thread processes.
            const bgPass2 = this.#helper.createBindGroup(
                0, "ISO Pass2 sparse", p2,
                [0, uniformBuffer],
                [2, sparseAllDualsBuffer],
                [8, sparseCompactBuffer],
                [25, cancelBuf],
                [27, this.#polygonVerticesBuffer],
                [28, this.#faceSelectionBuffer],
                [30, this.#mdcSceneParamsBuffer],
            )
            // Pass 3/4/5 all read endpoint corner duals via `dual_corner` → hash lookup →
            // they need binding 6 (`dualHashTable`) too, even though they only WRITE through
            // their absolute slot. WGSL strips bindings the entry point doesn't reference,
            // so leaving binding 6 out causes the layout-vs-bind-group mismatch.
            const bgPass3 = this.#helper.createBindGroup(
                0, "ISO Pass3 sparse", p3,
                [0, uniformBuffer],
                [2, sparseAllDualsBuffer],
                [6, sparseHashBuffer],
                [8, sparseCompactBuffer],
                [25, cancelBuf],
                [27, this.#polygonVerticesBuffer],
                [28, this.#faceSelectionBuffer],
                [30, this.#mdcSceneParamsBuffer],
            )
            const bgPass4 = this.#helper.createBindGroup(
                0, "ISO Pass4 sparse", p4,
                [0, uniformBuffer],
                [2, sparseAllDualsBuffer],
                [6, sparseHashBuffer],
                [8, sparseCompactBuffer],
                [25, cancelBuf],
                [27, this.#polygonVerticesBuffer],
                [28, this.#faceSelectionBuffer],
                [30, this.#mdcSceneParamsBuffer],
            )
            const bgPass5 = this.#helper.createBindGroup(
                0, "ISO Pass5 sparse", p5,
                [0, uniformBuffer],
                [1, activeCellFlagsBuffer],
                [2, sparseAllDualsBuffer],
                [6, sparseHashBuffer],
                [8, sparseCompactBuffer],
                [25, cancelBuf],
                [27, this.#polygonVerticesBuffer],
                [28, this.#faceSelectionBuffer],
                [30, this.#mdcSceneParamsBuffer],
            )
            const bgPass6 = this.#helper.createBindGroup(
                0, "ISO Pass6 sparse", p6,
                [0, uniformBuffer],
                [2, sparseAllDualsBuffer],
                [3, meshVerticesBuffer],
                [4, meshIndicesBuffer],
                [5, meshIndexCountBuffer],
                [6, sparseHashBuffer],
                [8, sparseCompactBuffer],
                [25, cancelBuf],
                [27, this.#polygonVerticesBuffer],
                [28, this.#faceSelectionBuffer],
                [30, this.#mdcSceneParamsBuffer],
            )
            // Phase 3 improvement passes: same buffer set as passes 3/4 (read corner duals
            // through the hash, write to allDuals through absolute slot).
            const bgPass8 = this.#helper.createBindGroup(
                0, "ISO Pass8 improveEdge", p8,
                [0, uniformBuffer],
                [2, sparseAllDualsBuffer],
                [6, sparseHashBuffer],
                [8, sparseCompactBuffer],
                [25, cancelBuf],
                [27, this.#polygonVerticesBuffer],
                [28, this.#faceSelectionBuffer],
                [30, this.#mdcSceneParamsBuffer],
            )
            const bgPass9 = this.#helper.createBindGroup(
                0, "ISO Pass9 improveFace", p9,
                [0, uniformBuffer],
                [2, sparseAllDualsBuffer],
                [6, sparseHashBuffer],
                [8, sparseCompactBuffer],
                [25, cancelBuf],
                [27, this.#polygonVerticesBuffer],
                [28, this.#faceSelectionBuffer],
                [30, this.#mdcSceneParamsBuffer],
            )
            this.#localBindGroups.push(bgPass2[1], bgPass3[1], bgPass4[1], bgPass5[1], bgPass6[1], bgPass8[1], bgPass9[1])

            // Pass 2 (corners)
            progressCallback?.updateProgress("ISO Pass 2: corner duals", 25)
            {
                const wg = Math.ceil(sparse.cornerCompactList.length / 64)
                const dispatchX = Math.min(wg, 65535)
                const dispatchY = Math.ceil(wg / dispatchX)
                const ce = this.#device.createCommandEncoder({ label: "iso_pass2" })
                const pass = this.#helper.beginComputePass(ce, p2, bgPass2)
                pass.dispatchWorkgroups(dispatchX, dispatchY, 1)
                pass.end()
                this.#device.queue.submit([ce.finish()])
                await this.#device.queue.onSubmittedWorkDone()
                checkCancelled()
            }
            logDiag("after pass2")

            // Passes 3–5 (single encoder; each dispatched per its sparse category count).
            progressCallback?.updateProgress("ISO Pass 3–5: edge/face/cube duals", 55)
            {
                const enc = this.#device.createCommandEncoder({ label: "iso_pass345" })
                {
                    const total = sparse.edgeXCompactList.length + sparse.edgeYCompactList.length
                        + sparse.edgeZCompactList.length
                    const wg = Math.ceil(total / 64)
                    const dx_ = Math.min(wg, 65535)
                    const dy_ = Math.ceil(wg / dx_)
                    const pass = this.#helper.beginComputePass(enc, p3, bgPass3)
                    pass.dispatchWorkgroups(dx_, dy_, 1)
                    pass.end()
                }
                {
                    const total = sparse.faceXYCompactList.length + sparse.faceYZCompactList.length
                        + sparse.faceXZCompactList.length
                    const wg = Math.ceil(total / 64)
                    const dx_ = Math.min(wg, 65535)
                    const dy_ = Math.ceil(wg / dx_)
                    const pass = this.#helper.beginComputePass(enc, p4, bgPass4)
                    pass.dispatchWorkgroups(dx_, dy_, 1)
                    pass.end()
                }
                {
                    const wg = Math.ceil(sparse.cubeCompactList.length / 64)
                    const dx_ = Math.min(wg, 65535)
                    const dy_ = Math.ceil(wg / dx_)
                    const pass = this.#helper.beginComputePass(enc, p5, bgPass5)
                    pass.dispatchWorkgroups(dx_, dy_, 1)
                    pass.end()
                }
                this.#device.queue.submit([enc.finish()])
                await this.#device.queue.onSubmittedWorkDone()
                checkCancelled()
            }
            logDiag("after pass3-5")

            // Phase 3 (paper §4.1): edge + face dual improvement. Each pass moves duals
            // ONTO the iso surface (fval = 0) when the per-cell topology safety test
            // passes. This collapses MT crossings on tet edges incident to those duals
            // onto the dual position — producing degenerate triangles that we drop after
            // the weld. Per the paper this gives ~3× triangle reduction.
            progressCallback?.updateProgress("ISO Pass 8/9: improve duals", 75)
            {
                const enc = this.#device.createCommandEncoder({ label: "iso_pass89_improve" })
                {
                    const total = sparse.edgeXCompactList.length + sparse.edgeYCompactList.length
                        + sparse.edgeZCompactList.length
                    const wg = Math.ceil(total / 64)
                    const dx_ = Math.min(wg, 65535)
                    const dy_ = Math.ceil(wg / dx_)
                    const pass = this.#helper.beginComputePass(enc, p8, bgPass8)
                    pass.dispatchWorkgroups(dx_, dy_, 1)
                    pass.end()
                }
                {
                    const total = sparse.faceXYCompactList.length + sparse.faceYZCompactList.length
                        + sparse.faceXZCompactList.length
                    const wg = Math.ceil(total / 64)
                    const dx_ = Math.min(wg, 65535)
                    const dy_ = Math.ceil(wg / dx_)
                    const pass = this.#helper.beginComputePass(enc, p9, bgPass9)
                    pass.dispatchWorkgroups(dx_, dy_, 1)
                    pass.end()
                }
                this.#device.queue.submit([enc.finish()])
                await this.#device.queue.onSubmittedWorkDone()
                checkCancelled()
            }
            logDiag("after pass8-9 improvement")

            // Pass 6 — one thread per active edge in the sparse set.
            progressCallback?.updateProgress("ISO Pass 6: emit triangles", 85)
            {
                const totalActiveEdges = sparse.edgeXCompactList.length + sparse.edgeYCompactList.length
                    + sparse.edgeZCompactList.length
                const wg = Math.ceil(totalActiveEdges / 64)
                const dispatchX = Math.min(wg, 65535)
                const dispatchY = Math.ceil(wg / dispatchX)
                const ce = this.#device.createCommandEncoder({ label: "iso_pass6" })
                const pass = this.#helper.beginComputePass(ce, p6, bgPass6)
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
            const actualIndexCount = Math.min(rawCount, sparseMaxIndices)
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

            // Phase 3 produces many "topologically degenerate" triangles: where the same
            // welded vertex appears at 2 or 3 corners of a triangle (because the MT
            // crossings landed on iso-relaxed dual positions and welded together). They
            // render as zero-area but pollute downstream stats and waste vertices. Drop
            // them here. Empirically ~50–70% of pre-weld tris are degenerate after
            // improvement — exactly the paper's promised triangle reduction.
            {
                const before = (tris.length / 3) | 0
                const dropped = dropDegenerateTriangles(verts, tris, voxelSize)
                tris = dropped.tris
                if (dropped.dropped > 0) {
                    dbgLog("IsoExport").debug(
                        `Phase-3 collapse: dropped ${dropped.dropped}/${before} degenerate `
                        + `tris (${((dropped.dropped / before) * 100).toFixed(1)}%) → ${(tris.length / 3) | 0} surviving`,
                    )
                }
            }
            logDiag("after degenerate drop")

            // Re-orient triangle winding to consistent outward direction (BFS over
            // shared-edge adjacency, then flip components for positive signed volume).
            // Same pipeline MDC uses; works well now that Phase-3 + GPU degenerate-skip
            // remove the worst slivers that previously fragmented BFS.
            reorientMeshTriangleWinding(verts, tris, SIZEOF_VERTEX)
            logDiag("after BFS reorient")

            // Crease-aware vertex splitting using **geometric face normals** (cross product
            // of edge vectors). For smooth surfaces produced by lathe / twisted extrude,
            // the analytic SDF gradient is piecewise (one direction per polygon segment) and
            // gives "garbled" per-vertex normals across the surface. Geometric face normals
            // are inherently smooth across the iso surface regardless of the underlying
            // SDF's gradient discontinuities — so smooth-group averaging produces uniform
            // Phong shading across a polygon-profile lathe instead of per-segment noise.
            //
            // creaseAngleDeg ≥ 180 falls back to uniform Phong smoothing (no splits).
            const creaseAngle = this.params.creaseAngleDeg ?? 60
            if (creaseAngle >= 180) {
                smoothNormalsByAreaWeightedFaceAverage(verts, tris, SIZEOF_VERTEX)
                logDiag("after uniform Phong smoothing")
            } else {
                const before = (verts.length / VERTEX_STRIDE_F32) | 0
                const split = splitCreaseVertices(verts, tris, creaseAngle, SIZEOF_VERTEX)
                verts = split.verts
                tris = split.tris
                const after = (verts.length / VERTEX_STRIDE_F32) | 0
                dbgLog("IsoExport").debug(
                    `Geometric crease split @ ${creaseAngle}°: verts ${before} → ${after} `
                    + `(${before > 0 ? ((after / before - 1) * 100).toFixed(1) : "0"}% growth)`,
                )
                logDiag("after geometric crease split")
            }

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
