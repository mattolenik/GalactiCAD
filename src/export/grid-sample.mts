import { GPUHelper } from "../gpu/helper.mjs"
import { log as dbgLog } from "../logging/debug-log.mjs"

/**
 * Parameters defining the world-space grid to sample.
 *
 * The grid is a uniform 3D lattice of `gridDim{X,Y,Z}` voxels with spacing
 * `voxelSize` (mm), starting at world position `gridOffset{X,Y,Z}` for
 * voxel (0,0,0).
 */
export interface GridSampleParams {
    gridDimX: number
    gridDimY: number
    gridDimZ: number
    voxelSize: number
    gridOffsetX: number
    gridOffsetY: number
    gridOffsetZ: number
}

/**
 * Result of a GPU grid sampling pass.
 *
 * - `scalar[idx]` is the scene SDF distance at voxel `idx`.
 * - `gradient[idx*4 + (0..3)]` is the analytical normal (xyz) and gradient
 *   magnitude (w) at voxel `idx`.
 * - Indexing convention: `idx = (z * gridDimY + y) * gridDimX + x`.
 */
export interface GridSampleResult {
    scalar: Float32Array<ArrayBuffer>
    /** Interleaved vec4 per voxel: [nx, ny, nz, |∇f|]. */
    gradient: Float32Array<ArrayBuffer>
    dims: readonly [number, number, number]
    voxelSize: number
    gridOffset: readonly [number, number, number]
}

const SAMPLE_GRID_UNIFORM_BYTES = 48 // 3 * vec4 = 48 bytes

/**
 * GPU helper that samples the scene SDF on a uniform 3D grid.
 *
 * Use this as the front-end of any CPU-side mesh extractor (SHREC, MergeSharp,
 * Marching Cubes for verification, etc.). The scene SDF stays on the GPU; only
 * the precomputed scalar+gradient volume is read back.
 *
 * The constructor takes the scene-param storage buffers used by mdc.wgsl
 * (`polygonVertices`, `faceSelection`, `mdcSceneParams`) so the same scene
 * data path that powers MDC export drives the sampler.
 */
export class GridSampler {
    #helper: GPUHelper
    #device: GPUDevice
    #localBuffers: GPUBuffer[] = []
    #polygonVerticesBuffer: GPUBuffer
    #faceSelectionBuffer: GPUBuffer
    #mdcSceneParamsBuffer: GPUBuffer

    constructor(
        helper: GPUHelper,
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

    /** Destroy GPU buffers created during this sampling pass. */
    #destroyLocalBuffers() {
        for (const buffer of this.#localBuffers) {
            buffer.destroy()
        }
        this.#localBuffers = []
    }

    /**
     * Run one grid sampling pass.
     *
     * `sampleGridShaderModule` must have been compiled from `sample_grid.wgsl`
     * with the scene SDF inserts applied (see `compileSampleGridShader` in
     * `render-worker-core.mts`).
     */
    async sample(
        sampleGridShaderModule: GPUShaderModule,
        params: GridSampleParams,
    ): Promise<GridSampleResult> {
        const t0 = (globalThis.performance?.now ? globalThis.performance.now() : Date.now())

        const { gridDimX, gridDimY, gridDimZ, voxelSize, gridOffsetX, gridOffsetY, gridOffsetZ } = params
        const totalVoxels = gridDimX * gridDimY * gridDimZ

        // Validate against device limits before we allocate. Each scalar voxel is 4 bytes,
        // each gradient voxel is 16 bytes (vec4f).
        const scalarBytes = totalVoxels * Float32Array.BYTES_PER_ELEMENT
        const gradientBytes = totalVoxels * 4 * Float32Array.BYTES_PER_ELEMENT
        const limit = this.#device.limits.maxStorageBufferBindingSize
        if (gradientBytes > limit) {
            throw new Error(
                `GridSampler: gradient buffer ${gradientBytes} bytes exceeds device limit ${limit}. ` +
                `Reduce grid dims (currently ${gridDimX}x${gridDimY}x${gridDimZ} = ${totalVoxels} voxels) or split into tiles.`,
            )
        }

        // Cancellation buffer (matches mdc.wgsl convention; not currently driven from outside but the
        // shader still references it).
        const cancellationBuffer = this.#device.createBuffer({
            label: "GridSampler.Cancellation",
            size: Uint32Array.BYTES_PER_ELEMENT,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        })
        this.#localBuffers.push(cancellationBuffer)
        this.#device.queue.writeBuffer(cancellationBuffer, 0, new Uint32Array([0]))

        try {
            // Uniforms: see SampleGridUniforms in sample_grid.wgsl.
            const uniformsData = new ArrayBuffer(SAMPLE_GRID_UNIFORM_BYTES)
            new Uint32Array(uniformsData, 0, 4).set([gridDimX >>> 0, gridDimY >>> 0, gridDimZ >>> 0, totalVoxels >>> 0])
            new Float32Array(uniformsData, 16, 4).set([gridOffsetX, gridOffsetY, gridOffsetZ, 0])
            new Float32Array(uniformsData, 32, 4).set([voxelSize, 0, 0, 0])

            const uniformBuffer = this.#device.createBuffer({
                label: "GridSampler.Uniforms",
                size: SAMPLE_GRID_UNIFORM_BYTES,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            })
            this.#localBuffers.push(uniformBuffer)
            this.#device.queue.writeBuffer(uniformBuffer, 0, uniformsData)

            const scalarBuffer = this.#device.createBuffer({
                label: "GridSampler.ScalarOut",
                size: scalarBytes,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
            })
            this.#localBuffers.push(scalarBuffer)

            const gradientBuffer = this.#device.createBuffer({
                label: "GridSampler.GradientOut",
                size: gradientBytes,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
            })
            this.#localBuffers.push(gradientBuffer)

            const pipeline = this.#helper.createComputePipeline(sampleGridShaderModule, "sampleGrid")

            const bindGroup = this.#helper.createBindGroup(
                0,
                "GridSampler.BindGroup",
                pipeline,
                [0, uniformBuffer],
                [1, scalarBuffer],
                [2, gradientBuffer],
                [25, cancellationBuffer],
                [27, this.#polygonVerticesBuffer],
                [28, this.#faceSelectionBuffer],
                [30, this.#mdcSceneParamsBuffer],
            )

            // Workgroup size in the shader is (4, 4, 4) → 64 threads.
            const wgX = Math.ceil(gridDimX / 4)
            const wgY = Math.ceil(gridDimY / 4)
            const wgZ = Math.ceil(gridDimZ / 4)
            // Each dispatch dim is capped at 65535. For voxel grids beyond ~262k per axis we'd
            // need to tile; that's far beyond practical SHREC input sizes.
            if (wgX > 65535 || wgY > 65535 || wgZ > 65535) {
                throw new Error(`GridSampler: dispatch (${wgX},${wgY},${wgZ}) exceeds 65535 per axis; tile the grid.`)
            }

            const ce = this.#device.createCommandEncoder({ label: "sample_grid" })
            const pass = this.#helper.beginComputePass(ce, pipeline, bindGroup)
            pass.dispatchWorkgroups(wgX, wgY, wgZ)
            pass.end()
            this.#device.queue.submit([ce.finish()])
            await this.#device.queue.onSubmittedWorkDone()

            const scalarData = new Float32Array(await this.#helper.readBufferData(scalarBuffer))
            const gradientData = new Float32Array(await this.#helper.readBufferData(gradientBuffer))

            const elapsedMs = (globalThis.performance?.now ? globalThis.performance.now() : Date.now()) - t0
            dbgLog("ShrecExport").debug(
                `GridSampler: ${gridDimX}x${gridDimY}x${gridDimZ} voxels (${totalVoxels} total) ` +
                `voxelSize=${voxelSize} elapsed=${elapsedMs.toFixed(1)}ms`,
            )

            return {
                scalar: scalarData,
                gradient: gradientData,
                dims: [gridDimX, gridDimY, gridDimZ] as const,
                voxelSize,
                gridOffset: [gridOffsetX, gridOffsetY, gridOffsetZ] as const,
            }
        } finally {
            this.#destroyLocalBuffers()
        }
    }
}
