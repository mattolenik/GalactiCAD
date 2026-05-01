import ascGridSampleShader from "../shaders/asc-grid-sample.wgsl"
import { GPUHelper } from "../gpu/helper.mjs"
import { log as dbgLog } from "../logging/debug-log.mjs"
import { MeshData } from "./export.mjs"
import { stripSamplingGridShellTriangles } from "./grid-shell-filter.mjs"
import { SIZEOF_VERTEX, splitCreaseVertices, type ProgressCallback } from "./mdc.mjs"
import { AscVoxelGrid, runAscLayerSweep, type AscLayerSweepResult, type AscTierIndex } from "./asc-core/index.mjs"

export * from "./asc-core/index.mjs"

/** Raw WGSL (includes resolved); compile with `ShaderCompiler` + same `//:) insert` replacements as MDC. */
export { ascGridSampleShader }

/** Grid framing aligned with MDC export / `SharedUniforms` in mdc.wgsl. */
export interface AscGridSampleParams {
    gridDimX: number
    gridDimY: number
    gridDimZ: number
    isoValue: number
    gridOffsetX: number
    gridOffsetY: number
    gridOffsetZ: number
    voxelSize: number
    /**
     * Refuse sampling if nx*ny*nz exceeds this (default 50M ≈ 200 MiB f32 buffer).
     * Also clamped by `device.limits.maxStorageBufferBindingSize`.
     */
    maxScalarSamples?: number
}

/** ASC mesh extraction parameters (grid + CPU extractor + optional post-process like MDC). */
export interface AscParams extends AscGridSampleParams {
    tierIndex: AscTierIndex
    /** Use layered CommunicateSimple (recommended). False can crack across macro-blocks. */
    communicate?: boolean
    handleAmbiguity?: boolean
    /** When true, skips triangles that fail ASC beauty angle test (slower, cleaner). */
    handleBeauty?: boolean
    /** Beauty path threshold in degrees (only if `handleBeauty`). Default 30. */
    angleThreshDeg?: number
    /** World mm per grid step along each axis (defaults to `voxelSize`). */
    widthScale?: number
    depthScale?: number
    heightScale?: number

    /**
     * Crease angle threshold in degrees for vertex splitting (default 30).
     * Set to 180 to disable (same semantics as MDC).
     */
    creaseAngleDeg?: number

    /** Fraction of triangles to keep after extraction (0–1); undefined or 1 skips simplify. */
    simplifyTargetRatio?: number
    simplifyTargetError?: number
    simplifyLockBorder?: boolean
    simplifySparse?: boolean
    simplifyErrorAbsolute?: boolean
    simplifyPrune?: boolean
    simplifyRegularize?: boolean
    simplifyNormalWeight?: number
}

/** Pack `SharedUniforms` (112 bytes) — same layout as `MDCExport.export` uniform init. */
export function packAscGridSharedUniforms(params: AscGridSampleParams): ArrayBuffer {
    const { gridDimX, gridDimY, gridDimZ, isoValue, gridOffsetX, gridOffsetY, gridOffsetZ, voxelSize } = params
    // Unused by ASC sampling, but must match mdc.wgsl `SharedUniforms` for layout parity.
    const activeEpsScale = 0.01
    const activeEpsMin = 1e-6
    const insideBiasScale = 0.01
    const insideBiasMin = 1e-6
    const gradEpsScale = 0.01
    const gradEpsMin = 1e-6
    const edgeProjTolScale = 1e-3
    const vertexProjTolScale = 1e-3
    const vertexProjMarginScale = 0.01
    const vertexProjMaxStepScale = 5
    const qefRegScale = 6.4e-2
    const qefRegMin = 1e-9
    const qefCondCutoff = 1e8
    const orientationProbeScale = 0.5
    const orientationProbeMin = 1e-4
    const edgeProjIters = 8
    const vertexProjIters = 12

    const uniformBufferData = new ArrayBuffer(112)
    new Uint32Array(uniformBufferData, 0, 3).set([gridDimX, gridDimY, gridDimZ])
    new Float32Array(uniformBufferData, 12, 1).set([isoValue])
    new Float32Array(uniformBufferData, 16, 3).set([gridOffsetX, gridOffsetY, gridOffsetZ])
    new Float32Array(uniformBufferData, 28, 1).set([voxelSize])
    new Float32Array(uniformBufferData, 32, 4).set([activeEpsScale, activeEpsMin, insideBiasScale, insideBiasMin])
    new Float32Array(uniformBufferData, 48, 4).set([gradEpsScale, gradEpsMin, edgeProjTolScale, vertexProjTolScale])
    new Float32Array(uniformBufferData, 64, 4).set([vertexProjMarginScale, vertexProjMaxStepScale, qefRegScale, qefRegMin])
    new Float32Array(uniformBufferData, 80, 4).set([qefCondCutoff, orientationProbeScale, orientationProbeMin, 0])
    new Uint32Array(uniformBufferData, 96, 4).set([
        Math.max(0, edgeProjIters) >>> 0,
        Math.max(0, vertexProjIters) >>> 0,
        0,
        0,
    ])
    return uniformBufferData
}

/**
 * ASC partitions the grid into N×N×N-cell macro-blocks per axis with N = 2^tierIndex.
 * Tier 0 (N=1) implies one block per base cell → block count ~ product of (dim−1), which is
 * untenable on large dense grids (tens of millions of JS block walks).
 */
export function ascMacroBlockCount(
    gridDimX: number,
    gridDimY: number,
    gridDimZ: number,
    tierIndex: AscTierIndex,
): number {
    const N = 1 << tierIndex
    const bx = Math.ceil((gridDimX - 1) / N)
    const by = Math.ceil((gridDimY - 1) / N)
    const bz = Math.ceil((gridDimZ - 1) / N)
    return bx * by * bz
}

/** Hard cap on macro-blocks to avoid pathological CPU extraction runs. */
const ASC_MACRO_BLOCK_HARD_CAP = 2_500_000

/** Raise tier only when the requested one would exceed the hard extraction safety cap. */
export function effectiveAscTierForGrid(
    requested: AscTierIndex,
    gridDimX: number,
    gridDimY: number,
    gridDimZ: number,
    maxMacroBlocks = ASC_MACRO_BLOCK_HARD_CAP,
): AscTierIndex {
    let t = requested
    while (t < 3 && ascMacroBlockCount(gridDimX, gridDimY, gridDimZ, t) > maxMacroBlocks) {
        t = (t + 1) as AscTierIndex
    }
    return t
}

const WORKGROUP_X = 256

/**
 * GPU dense scalar grid: `sceneSDF_fast(p).d - iso` at each lattice vertex, same world framing as MDC.
 * Bindings @group(0): 0 uniform, 1 output f32[], 27 polygon vertices, 28 face selection, 30 mdcSceneParams.
 */
export async function sampleAscScalarGrid(
    helper: GPUHelper,
    ascGridShaderModule: GPUShaderModule,
    params: AscGridSampleParams,
    polygonVerticesBuffer: GPUBuffer,
    faceSelectionBuffer: GPUBuffer,
    mdcSceneParamsBuffer: GPUBuffer,
): Promise<Float32Array> {
    const device = helper.device
    const {
        gridDimX,
        gridDimY,
        gridDimZ,
        isoValue,
        gridOffsetX,
        gridOffsetY,
        gridOffsetZ,
        voxelSize,
        maxScalarSamples = 50_000_000,
    } = params

    const total = gridDimX * gridDimY * gridDimZ
    const maxByDevice = Math.floor(device.limits.maxStorageBufferBindingSize / Float32Array.BYTES_PER_ELEMENT)
    const limit = Math.min(maxScalarSamples, maxByDevice)
    if (total > limit) {
        throw new Error(
            `ASC grid sample: ${gridDimX}x${gridDimY}x${gridDimZ} = ${total} vertices exceeds limit ${limit} (maxStorageBufferBindingSize / 4 or maxScalarSamples)`,
        )
    }

    dbgLog("AscExport").info(
        `sampleAscScalarGrid: grid=${gridDimX}x${gridDimY}x${gridDimZ} voxel=${voxelSize} iso=${isoValue} offset=(${gridOffsetX},${gridOffsetY},${gridOffsetZ})`,
    )

    const uniformBuffer = device.createBuffer({
        label: "AscGridUniforms",
        size: 112,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    device.queue.writeBuffer(uniformBuffer, 0, packAscGridSharedUniforms(params))

    const outSize = total * Float32Array.BYTES_PER_ELEMENT
    const outBuffer = device.createBuffer({
        label: "AscGridScalars",
        size: outSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    })

    const pipeline = helper.createComputePipeline(ascGridShaderModule, "ascGridScalar_sample", "AscGridScalar_sample")

    const bindGroup = helper.createBindGroup(
        0,
        "AscGridScalar_sample",
        pipeline,
        [0, uniformBuffer],
        [1, outBuffer],
        [27, polygonVerticesBuffer],
        [28, faceSelectionBuffer],
        [30, mdcSceneParamsBuffer],
    )

    const linearWg = Math.ceil(total / WORKGROUP_X)
    const dispatchX = Math.min(linearWg, 65535)
    const dispatchY = Math.ceil(linearWg / dispatchX)

    const ce = device.createCommandEncoder({ label: "asc_grid_sample" })
    const pass = helper.beginComputePass(ce, pipeline, bindGroup)
    pass.dispatchWorkgroups(dispatchX, dispatchY)
    pass.end()
    device.queue.submit([ce.finish()])
    await device.queue.onSubmittedWorkDone()

    const raw = await helper.readBufferData(outBuffer, outSize)
    uniformBuffer.destroy()
    outBuffer.destroy()

    return new Float32Array(raw, 0, total)
}

const VERTEX_STRIDE_F32 = SIZEOF_VERTEX / Float32Array.BYTES_PER_ELEMENT

function packAscLayerResultToMeshData(
    asc: AscLayerSweepResult,
    originX: number,
    originY: number,
    originZ: number,
): MeshData {
    const n = (asc.positions.length / 3) | 0
    if (n === 0) {
        return { verts: new Float32Array(0), tris: new Uint32Array(0) }
    }
    const verts = new Float32Array(n * VERTEX_STRIDE_F32)
    for (let i = 0; i < n; i++) {
        const b = i * VERTEX_STRIDE_F32
        verts[b] = asc.positions[i * 3]! + originX
        verts[b + 1] = asc.positions[i * 3 + 1]! + originY
        verts[b + 2] = asc.positions[i * 3 + 2]! + originZ
        verts[b + 3] = 0
        verts[b + 4] = asc.normals[i * 3]!
        verts[b + 5] = asc.normals[i * 3 + 1]!
        verts[b + 6] = asc.normals[i * 3 + 2]!
        verts[b + 7] = 0
    }
    const tris = new Uint32Array(asc.indices.length)
    for (let i = 0; i < asc.indices.length; i++) tris[i] = asc.indices[i]!
    return { verts, tris }
}

/**
 * ASC mesh export: GPU scalar grid sample → CPU ASC extraction → same vertex stride as MDC (see `SIZEOF_VERTEX`).
 */
export class AscExport {
    #helper: GPUHelper
    #params: AscParams
    #polygonVerticesBuffer: GPUBuffer
    #faceSelectionBuffer: GPUBuffer
    #mdcSceneParamsBuffer: GPUBuffer

    constructor(
        helper: GPUHelper,
        params: AscParams,
        polygonVerticesBuffer: GPUBuffer,
        faceSelectionBuffer: GPUBuffer,
        mdcSceneParamsBuffer: GPUBuffer,
    ) {
        this.#helper = helper
        this.#params = params
        this.#polygonVerticesBuffer = polygonVerticesBuffer
        this.#faceSelectionBuffer = faceSelectionBuffer
        this.#mdcSceneParamsBuffer = mdcSceneParamsBuffer
    }

    async export(ascGridShaderModule: GPUShaderModule, progressCallback?: ProgressCallback): Promise<MeshData> {
        const perfNow = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now())
        const t0 = perfNow()

        const checkCancelled = () => {
            if (progressCallback?.cancelled) throw new Error("ASC export was cancelled")
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
            tierIndex,
            communicate = true,
            handleAmbiguity = true,
            handleBeauty = false,
            angleThreshDeg = 30,
            widthScale = voxelSize,
            depthScale = voxelSize,
            heightScale = voxelSize,
        } = this.#params

        const effectiveTier = effectiveAscTierForGrid(tierIndex, gridDimX, gridDimY, gridDimZ)
        const macroBlocks = ascMacroBlockCount(gridDimX, gridDimY, gridDimZ, effectiveTier)
        const requestedMacroBlocks = ascMacroBlockCount(gridDimX, gridDimY, gridDimZ, tierIndex)

        dbgLog("AscExport").info(
            `AscExport.export(): grid=${gridDimX}x${gridDimY}x${gridDimZ} voxel=${voxelSize} iso=${isoValue} tier=${effectiveTier}` +
            (effectiveTier !== tierIndex ? ` (raised from ${tierIndex}; ~${requestedMacroBlocks.toLocaleString()} blocks at tier ${tierIndex} exceeds safety cap)` : "") +
            ` macro-blocks≈${macroBlocks.toLocaleString()} communicate=${communicate}`,
        )

        if (macroBlocks > ASC_MACRO_BLOCK_HARD_CAP) {
            throw new Error(
                `ASC needs ~${macroBlocks.toLocaleString()} macro-blocks at tier ${effectiveTier}. Use MDC export or increase voxel step / reduce bounds.`,
            )
        }

        checkCancelled()
        progressCallback?.updateProgress("ASC: sampling distance grid", 10)

        const sampleParams: AscGridSampleParams = {
            gridDimX,
            gridDimY,
            gridDimZ,
            isoValue,
            gridOffsetX,
            gridOffsetY,
            gridOffsetZ,
            voxelSize,
            maxScalarSamples: this.#params.maxScalarSamples,
        }

        const scalars = await sampleAscScalarGrid(
            this.#helper,
            ascGridShaderModule,
            sampleParams,
            this.#polygonVerticesBuffer,
            this.#faceSelectionBuffer,
            this.#mdcSceneParamsBuffer,
        )

        let sMin = Infinity
        let sMax = -Infinity
        for (let i = 0; i < scalars.length; i++) {
            const v = scalars[i]!
            if (v < sMin) sMin = v
            if (v > sMax) sMax = v
        }
        const fmt = Number.isFinite(sMin) && Number.isFinite(sMax) ? `${sMin.toExponential(3)} … ${sMax.toExponential(3)}` : "n/a"
        const below =
            Number.isFinite(sMin) && sMin <= 0 && Number.isFinite(sMax) && sMax >= 0
                ? " (crosses iso)"
                : sMax < 0
                    ? " — all samples inside (negative); mesh bounds likely miss empty space"
                    : sMin > 0
                        ? " — all samples outside (positive); mesh bounds likely miss solid"
                        : ""

        dbgLog("AscExport").info(
            `ASC GPU sampling readback: ${scalars.length.toLocaleString()} floats (${((scalars.length * 4) / (1024 * 1024)).toFixed(1)} MiB); scalar min/max=${fmt}${below}`,
        )

        checkCancelled()
        progressCallback?.updateProgress("ASC: CPU extraction", 45)

        const grid = new AscVoxelGrid(scalars, gridDimX, gridDimY, gridDimZ, 0)
        const angleThreshRad = (angleThreshDeg * Math.PI) / 180
        dbgLog("AscExport").info(`ASC CPU extraction starting (tier ${effectiveTier}, ~${macroBlocks.toLocaleString()} macro-blocks)`)
        const ascOut = runAscLayerSweep({
            tierIndex: effectiveTier,
            grid,
            handleAmbiguity,
            communicate,
            widthScale,
            depthScale,
            heightScale,
            handleBeauty,
            angleThreshRad,
        })

        checkCancelled()
        progressCallback?.updateProgress("ASC: packing mesh", 75)

        let { verts, tris } = packAscLayerResultToMeshData(ascOut, gridOffsetX, gridOffsetY, gridOffsetZ)

        {
            const before = (tris.length / 3) | 0
            const stripped = stripSamplingGridShellTriangles(
                { verts, tris },
                gridOffsetX,
                gridOffsetY,
                gridOffsetZ,
                gridDimX,
                gridDimY,
                gridDimZ,
                voxelSize,
            )
            verts = stripped.verts
            tris = stripped.tris
            const after = (tris.length / 3) | 0
            if (after < before) {
                dbgLog("AscExport").info(`ASC grid-shell filter: removed ${before - after} triangles on sampling-box faces (${before} -> ${after})`)
            }
        }

        const creaseAngle = this.#params.creaseAngleDeg ?? 30
        if (creaseAngle < 180 && tris.length > 0) {
            const split = splitCreaseVertices(verts, tris, creaseAngle)
            verts = split.verts
            tris = split.tris
            dbgLog("AscExport").debug(
                `ASC crease split applied (${creaseAngle}° threshold): verts=${verts.length / VERTEX_STRIDE_F32}`,
            )
        }

        if (this.#params.simplifyTargetRatio !== undefined && this.#params.simplifyTargetRatio < 1 && tris.length > 0) {
            progressCallback?.updateProgress("ASC: simplifying mesh", 88)
            const { simplifyMesh } = await import("./simplify.mjs")
            const simplified = await simplifyMesh(
                { verts, tris },
                this.#params.simplifyTargetRatio,
                this.#params.simplifyTargetError,
                {
                    lockBorder: this.#params.simplifyLockBorder,
                    sparse: this.#params.simplifySparse,
                    errorAbsolute: this.#params.simplifyErrorAbsolute,
                    prune: this.#params.simplifyPrune,
                    regularize: this.#params.simplifyRegularize,
                    normalWeight: this.#params.simplifyNormalWeight,
                },
            )
            verts = simplified.verts
            tris = simplified.tris
        }

        progressCallback?.updateProgress("Complete", 100)
        dbgLog("AscExport").debug(`AscExport.export done in ${(perfNow() - t0).toFixed(1)} ms; tris=${(tris.length / 3) | 0}`)

        return { verts, tris }
    }
}
