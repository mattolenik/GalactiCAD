/**
 * FeatureGraph debug overlay — GPU pipeline + buffer management.
 *
 * Renders alive crease/corner edges from the latest FeatureGraph build as
 * line primitives over the rendered scene. Decoupled from the main scene
 * pipeline so it can be toggled on/off at runtime without recompiling
 * shaders and so the overlay pass owns its own camera uniform (the existing
 * preview camera struct has a much larger layout we don't need here).
 *
 * Buffer layout
 * -------------
 *  - **Vertex buffer**: stride 16 bytes per FG vertex (x, y, z, flags).
 *    Includes *all* vertices so dead-feature rendering can be enabled later
 *    by populating the index buffer with dead-edge endpoints too.
 *  - **Index buffer**: pairs of `u32` per alive edge. Dead edges are simply
 *    omitted, which causes the GPU to never reference any dead vertex
 *    either — the vertex shader still pays the cost of transforming all
 *    vertices, but with line-list input assembly only the indexed subset
 *    actually fires the rasteriser.
 *  - **Camera uniform**: 80 bytes — `mat4x4f transform` (64) + `vec2f res`
 *    (8) + `f32 zoom` (4) + 4-byte pad. Same camera→world matrix the
 *    preview ray-marcher uses, so the overlay aligns with the scene.
 *
 * Render integration
 * ------------------
 * The overlay runs in its own render pass on the canvas target with
 * `loadOp: "load"` (preserves the outline pass output) and no depth
 * attachment. By default features draw on top of geometry so the user can see
 * surviving CSG-cut edges through the model. The optional occlusion mode
 * (off / hard / dim) re-introduces depth ordering by sampling a world-space
 * hit-position texture from the SDF depth-only pass; see {@link setDepthSource}.
 */

import type { GPUHelper } from "../gpu/helper.mjs"
import { scheduleShaderModuleCompilationLogging } from "../shaders/shader.mjs"
import overlayShaderSource from "../shaders/feature_graph_overlay.wgsl"
import { FG_FLAG_ALIVE, type FeatureGraphCpu } from "../scene/feature-graph-buffer.mjs"
import type { FeatureGraphWorldPositions } from "./feature-graph-stages.mjs"
import { Mat4x4f } from "../vecmat/matrix.mjs"

/** Stride in bytes for the vertex buffer (vec3<f32> position + u32 flags). */
const VERTEX_STRIDE = 16

/**
 * Size in bytes of the overlay camera uniform struct. Layout (column-major,
 * WGSL alignment):
 *   - 0  : transform (mat4x4f) = inverse of `viewTransform`, 64 bytes
 *   - 64 : origin (vec3f) = cameraPosition + (0, 0, rayDepth), 12 bytes
 *   - 76 : _pad0 (f32), 4 bytes  →  vec4 alignment
 *   - 80 : res (vec2f), 8 bytes
 *   - 88 : zoom (f32), 4 bytes
 *   - 92 : _pad1 (f32), 4 bytes  →  vec4 alignment
 *   - 96 : viewCenter (vec2f), 8 bytes
 *   - 104: occlusionMode (u32), 4 bytes  (0 = off, 1 = hard, 2 = dim)
 *   - 108: _pad2 (u32), 4 bytes  →  struct size = 112 (16-aligned)
 */
const CAMERA_UNIFORM_BYTES = 112

/** FeatureGraph overlay depth-occlusion mode. */
export type FeatureGraphOcclusionMode = "off" | "hard" | "dim"

/** Numeric encoding of {@link FeatureGraphOcclusionMode} for the GPU uniform. */
export function occlusionModeToInt(mode: FeatureGraphOcclusionMode): number {
    return mode === "hard" ? 1 : mode === "dim" ? 2 : 0
}

/**
 * Same constant the preview ray-marcher uses to push ray origins back along
 * the camera's local +Z so the SDF march has room to find intersections in
 * front of the eye. Matches `PREVIEW_RAY_ORIGIN_DEPTH` in `camera-controller`
 * + `mesh-viewer`.
 */
const PREVIEW_RAY_ORIGIN_DEPTH = 300

export class FeatureGraphOverlay {
    #helper: GPUHelper
    #device: GPUDevice
    #format: GPUTextureFormat
    #shaderModule: GPUShaderModule
    #pipeline!: GPURenderPipeline
    #cameraBuffer: GPUBuffer
    #vertexBuffer?: GPUBuffer
    #vertexCapacity = 0
    #indexBuffer?: GPUBuffer
    #indexCapacity = 0
    #bindGroup?: [number, GPUBindGroup]
    /** Number of `u32` indices currently uploaded; `drawIndexed(indexCount)`. */
    #indexCount = 0
    /**
     * 1×1 rgba32float placeholder bound at binding 1 whenever occlusion is off
     * (or no scene-depth texture has been supplied yet). The shader never reads
     * it in that state, but `layout: "auto"` still requires a valid binding.
     */
    #dummyDepthTexture: GPUTexture
    #dummyDepthView: GPUTextureView
    /** Current scene-depth texture view bound at binding 1 (dummy when off). */
    #depthView: GPUTextureView
    /** Occlusion mode written into the camera uniform (0 off / 1 hard / 2 dim). */
    #occlusionMode = 0
    /**
     * Persistent staging for the camera uniform payload. Filled in-place each
     * upload to avoid the per-frame `new ArrayBuffer(112)` + `new Float32Array(...)`
     * churn. Compared against `#cameraInputCache` to short-circuit the matrix
     * inversion + GPU writeBuffer when the camera state hasn't changed.
     */
    #cameraStaging = new ArrayBuffer(CAMERA_UNIFORM_BYTES)
    #cameraStagingF32 = new Float32Array(this.#cameraStaging)
    /**
     * Cache of the *inputs* (viewTransform[16] + cameraPosition[3] + res[2] +
     * zoom[1] + viewCenter[2] = 24 floats). Cheap to compare and lets us skip
     * the matrix inverse entirely when the camera hasn't moved.
     */
    #cameraInputCache = new Float32Array(25)
    #cameraInputValid = false
    /** Uint32 view of {@link #cameraStaging} for the integer occlusionMode slot. */
    #cameraStagingU32 = new Uint32Array(this.#cameraStaging)

    constructor(helper: GPUHelper, format: GPUTextureFormat) {
        this.#helper = helper
        this.#device = helper.device
        this.#format = format

        this.#dummyDepthTexture = this.#device.createTexture({
            label: "FeatureGraphOverlay.DummyDepth",
            size: [1, 1],
            format: "rgba32float",
            usage: GPUTextureUsage.TEXTURE_BINDING,
        })
        this.#dummyDepthView = this.#dummyDepthTexture.createView()
        this.#depthView = this.#dummyDepthView

        this.#shaderModule = this.#device.createShaderModule({
            label: "FeatureGraph Overlay",
            code: overlayShaderSource,
        })
        scheduleShaderModuleCompilationLogging(
            this.#shaderModule,
            "FeatureGraph Overlay",
            overlayShaderSource,
        )

        this.#cameraBuffer = this.#device.createBuffer({
            label: "FeatureGraphOverlay.Camera",
            size: CAMERA_UNIFORM_BYTES,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })

        this.#pipeline = this.#device.createRenderPipeline({
            label: "FeatureGraph Overlay Pipeline",
            layout: "auto",
            vertex: {
                module: this.#shaderModule,
                entryPoint: "vertexMain",
                buffers: [
                    {
                        arrayStride: VERTEX_STRIDE,
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: "float32x3" },
                            { shaderLocation: 1, offset: 12, format: "uint32" },
                        ],
                    },
                ],
            },
            fragment: {
                module: this.#shaderModule,
                entryPoint: "fragmentMain",
                targets: [
                    {
                        format: this.#format,
                        blend: {
                            color: {
                                srcFactor: "src-alpha",
                                dstFactor: "one-minus-src-alpha",
                                operation: "add",
                            },
                            alpha: {
                                srcFactor: "one",
                                dstFactor: "one-minus-src-alpha",
                                operation: "add",
                            },
                        },
                    },
                ],
            },
            primitive: {
                topology: "line-list",
            },
        })
    }

    /**
     * Upload world positions + flags + alive-edge endpoints from the latest
     * FeatureGraph build. Grow-on-demand pattern matching `IsoSampleBatch`.
     * Call once per FG rebuild; the camera uniform is uploaded separately
     * via {@link uploadCamera} on every render frame.
     */
    upload(cpu: FeatureGraphCpu, world: FeatureGraphWorldPositions): void {
        if (cpu.vertexCount === 0) {
            this.#indexCount = 0
            return
        }

        // Vertex buffer: all vertices interleaved (pos × 3, flags × 1).
        const vertexBytes = cpu.vertexCount * VERTEX_STRIDE
        this.#ensureVertexBuffer(vertexBytes)
        const vbCpu = new ArrayBuffer(vertexBytes)
        const vbF32 = new Float32Array(vbCpu)
        const vbU32 = new Uint32Array(vbCpu)
        for (let i = 0; i < cpu.vertexCount; i++) {
            vbF32[i * 4 + 0] = world.positions[i * 3 + 0]!
            vbF32[i * 4 + 1] = world.positions[i * 3 + 1]!
            vbF32[i * 4 + 2] = world.positions[i * 3 + 2]!
            vbU32[i * 4 + 3] = cpu.vertexFlags[i] ?? 0
        }
        this.#device.queue.writeBuffer(this.#vertexBuffer!, 0, vbCpu)

        // Index buffer: alive edges only. Dead edges drop out of the draw
        // call (and their dead endpoints are never rasterised).
        let aliveEdgeCount = 0
        for (let e = 0; e < cpu.edgeCount; e++) {
            if ((cpu.edgeFlags[e]! & FG_FLAG_ALIVE) !== 0) aliveEdgeCount++
        }

        if (aliveEdgeCount === 0) {
            this.#indexCount = 0
            return
        }

        const indexBytes = aliveEdgeCount * 8 // 2 u32 per edge
        this.#ensureIndexBuffer(indexBytes)
        const ibCpu = new Uint32Array(aliveEdgeCount * 2)
        let s = 0
        for (let e = 0; e < cpu.edgeCount; e++) {
            if ((cpu.edgeFlags[e]! & FG_FLAG_ALIVE) === 0) continue
            ibCpu[s * 2 + 0] = cpu.edgeEndpoints[e * 2]!
            ibCpu[s * 2 + 1] = cpu.edgeEndpoints[e * 2 + 1]!
            s++
        }
        this.#device.queue.writeBuffer(this.#indexBuffer!, 0, ibCpu)
        this.#indexCount = aliveEdgeCount * 2
    }

    /**
     * Push the per-frame camera uniform.
     *
     * @param viewTransform Camera controller's `viewTransform` (cam-to-world).
     *   The overlay uploads its *inverse* so the vertex shader can project
     *   world points directly. Matches `mesh-viewer`'s convention.
     * @param cameraPosition World-space camera position (used to shift the
     *   projection origin so geometry lines up with the SDF preview).
     * @param resX Canvas width in pixels.
     * @param resY Canvas height in pixels.
     * @param zoom Orthographic half-extent along Y (= `orthoHalfFromDolly`).
     * @param viewCenter UV-space center of the visible scene area (0–1);
     *   defaults to `(0.5, 0.5)` for canvas-centered rendering.
     */
    uploadCamera(
        viewTransform: Float32Array | ArrayBuffer,
        cameraPosition: readonly [number, number, number],
        resX: number,
        resY: number,
        zoom: number,
        viewCenter: readonly [number, number] = [0.5, 0.5],
    ): void {
        const vt = viewTransform instanceof Float32Array ? viewTransform : new Float32Array(viewTransform)

        // Compare against cached inputs — matrix inversion + writeBuffer only
        // run when the camera actually moved. Steady-state SDF preview frames
        // re-upload unchanged camera state every frame, so this short-circuit
        // saves a Mat4x4f inverse + a 112-byte GPU upload per frame.
        const cache = this.#cameraInputCache
        if (this.#cameraInputValid) {
            let same = true
            for (let i = 0; i < 16; i++) {
                if (cache[i] !== vt[i]) { same = false; break }
            }
            if (
                same &&
                cache[16] === cameraPosition[0] &&
                cache[17] === cameraPosition[1] &&
                cache[18] === cameraPosition[2] &&
                cache[19] === resX &&
                cache[20] === resY &&
                cache[21] === zoom &&
                cache[22] === viewCenter[0] &&
                cache[23] === viewCenter[1] &&
                cache[24] === this.#occlusionMode
            ) return
        }
        for (let i = 0; i < 16; i++) cache[i] = vt[i]!
        cache[16] = cameraPosition[0]
        cache[17] = cameraPosition[1]
        cache[18] = cameraPosition[2]
        cache[19] = resX
        cache[20] = resY
        cache[21] = zoom
        cache[22] = viewCenter[0]
        cache[23] = viewCenter[1]
        cache[24] = this.#occlusionMode
        this.#cameraInputValid = true

        // Invert on CPU: WGSL inversion is doable for rigid transforms but
        // mesh-viewer's reference pattern keeps it CPU-side and matches the
        // existing pivot-projection convention, so we do the same here.
        const inverse = new Mat4x4f(new Float32Array(vt)).inverse()

        const f32 = this.#cameraStagingF32
        // transform: bytes 0..63 (16 floats)
        f32.set(inverse.data.subarray(0, 16), 0)
        // origin: bytes 64..75 (3 floats), Z-shifted by PREVIEW_RAY_ORIGIN_DEPTH
        f32[16] = cameraPosition[0]
        f32[17] = cameraPosition[1]
        f32[18] = cameraPosition[2] + PREVIEW_RAY_ORIGIN_DEPTH
        f32[19] = 0 // _pad0
        // res: bytes 80..87
        f32[20] = resX
        f32[21] = resY
        // zoom: bytes 88..91
        f32[22] = zoom
        f32[23] = 0 // _pad1
        // viewCenter: bytes 96..103
        f32[24] = viewCenter[0]
        f32[25] = viewCenter[1]
        // occlusionMode (u32): bytes 104..107
        this.#cameraStagingU32[26] = this.#occlusionMode
        f32[27] = 0 // _pad2
        this.#device.queue.writeBuffer(this.#cameraBuffer, 0, this.#cameraStaging)
    }

    /**
     * Set the scene-depth source + occlusion mode for the next render. Pass a
     * world-space hit-position texture view (rgba32float, xyz = hit position,
     * w = hit mask) from the SDF depth-only pass and a non-zero mode to enable
     * depth ordering; pass `null` / mode 0 to draw lines on top as before.
     *
     * Invalidates the cached bind group when the bound texture changes so the
     * next {@link render} rebinds it. The mode is folded into the camera
     * uniform on the next {@link uploadCamera}.
     */
    setDepthSource(view: GPUTextureView | null, occlusionMode: number): void {
        const nextView = view ?? this.#dummyDepthView
        if (nextView !== this.#depthView) {
            this.#depthView = nextView
            this.#bindGroup = undefined
        }
        this.#occlusionMode = occlusionMode
    }

    /**
     * Issue draw call into an open render pass. No-op when no alive edges
     * have been uploaded. The caller is responsible for opening a render
     * pass with the canvas target and `loadOp: "load"`.
     */
    render(pass: GPURenderPassEncoder): void {
        if (this.#indexCount === 0 || !this.#vertexBuffer || !this.#indexBuffer) return
        if (!this.#bindGroup) {
            // Built directly (not via helper.createBindGroup) because binding 1
            // is a texture view, not a buffer.
            this.#bindGroup = [
                0,
                this.#device.createBindGroup({
                    label: "FeatureGraphOverlay.BindGroup",
                    layout: this.#pipeline.getBindGroupLayout(0),
                    entries: [
                        { binding: 0, resource: { buffer: this.#cameraBuffer } },
                        { binding: 1, resource: this.#depthView },
                    ],
                }),
            ]
        }
        const [groupId, bindGroup] = this.#bindGroup
        pass.setPipeline(this.#pipeline)
        pass.setBindGroup(groupId, bindGroup)
        pass.setVertexBuffer(0, this.#vertexBuffer)
        pass.setIndexBuffer(this.#indexBuffer, "uint32")
        pass.drawIndexed(this.#indexCount)
    }

    /** True if the overlay has alive features uploaded and ready to draw. */
    get hasAliveFeatures(): boolean {
        return this.#indexCount > 0
    }

    destroy(): void {
        this.#cameraBuffer.destroy()
        this.#dummyDepthTexture.destroy()
        this.#vertexBuffer?.destroy()
        this.#indexBuffer?.destroy()
        this.#vertexBuffer = undefined
        this.#indexBuffer = undefined
        this.#vertexCapacity = 0
        this.#indexCapacity = 0
        this.#bindGroup = undefined
        this.#indexCount = 0
    }

    #ensureVertexBuffer(minBytes: number): void {
        if (this.#vertexBuffer && this.#vertexCapacity >= minBytes) return
        this.#vertexBuffer?.destroy()
        // Double-on-grow with a 4 KiB floor — identical pattern to
        // `IsoSampleBatch.#ensurePositionBuffer`.
        this.#vertexCapacity = Math.max(minBytes, this.#vertexCapacity * 2 || 4096)
        this.#vertexBuffer = this.#device.createBuffer({
            label: "FeatureGraphOverlay.Vertex",
            size: this.#vertexCapacity,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        })
    }

    #ensureIndexBuffer(minBytes: number): void {
        if (this.#indexBuffer && this.#indexCapacity >= minBytes) return
        this.#indexBuffer?.destroy()
        this.#indexCapacity = Math.max(minBytes, this.#indexCapacity * 2 || 4096)
        this.#indexBuffer = this.#device.createBuffer({
            label: "FeatureGraphOverlay.Index",
            size: this.#indexCapacity,
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        })
    }
}
