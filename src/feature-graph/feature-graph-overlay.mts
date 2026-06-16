/**
 * FeatureGraph debug overlay — GPU pipeline + buffer management.
 *
 * Renders alive crease edges from the latest FeatureGraph build as anti-aliased
 * screen-space quads, plus a marker disc at each explicit corner (0D feature)
 * vertex, over the rendered scene. Decoupled from the main scene pipeline so it
 * can be toggled on/off at runtime without recompiling shaders and so the
 * overlay pass owns its own camera uniform (the existing preview camera struct
 * has a much larger layout we don't need here).
 *
 * Buffer layout
 * -------------
 *  - **Edge instance buffer**: one record per *alive* edge, stride 32 bytes —
 *    endpoint A (vec3f) + endpoint B (vec3f) + flags (u32) + 4-byte pad. Drawn
 *    as a 6-vertex quad (`draw(6, edgeCount)`); the shader expands it in screen
 *    space to a pixel-width, anti-aliased line. `flags` is endpoint A's vertex
 *    flags (crease lineage drives the edge color).
 *  - **Corner instance buffer**: one record per *alive corner* vertex, stride
 *    12 bytes (vec3f position). Drawn as a 6-vertex quad per corner; the shader
 *    paints an AA disc. Plain (non-corner) polyline vertices get no marker.
 *  - **Camera uniform**: 112 bytes — see {@link CAMERA_UNIFORM_BYTES}. Same
 *    camera→world matrix the preview ray-marcher uses, so the overlay aligns
 *    with the scene. The edge + corner pipelines share one explicit bind-group
 *    layout (camera uniform + scene-depth texture) and therefore one bind group.
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
import { FG_FLAG_ALIVE, FG_FLAG_CORNER, type FeatureGraphCpu } from "../scene/feature-graph-buffer.mjs"
import type { FeatureGraphWorldPositions } from "./feature-graph-stages.mjs"
import { Mat4x4f } from "../vecmat/matrix.mjs"

/**
 * Stride in bytes for the per-edge instance buffer: endpoint A (vec3f, 12) +
 * endpoint B (vec3f, 12) + flags (u32, 4) + 4-byte pad = 32 (8 floats/edge).
 */
const INSTANCE_STRIDE = 32

/** Stride in bytes for the per-corner instance buffer: position (vec3f, 12). */
const CORNER_STRIDE = 12

/** Default edge line width in framebuffer pixels (dev-tools knob overrides). */
const DEFAULT_LINE_WIDTH_PX = 2

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
 *   - 108: lineWidthPx (f32), 4 bytes  →  struct size = 112 (16-aligned)
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

const OVERLAY_BLEND: GPUBlendState = {
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
}

export class FeatureGraphOverlay {
    #device: GPUDevice
    #format: GPUTextureFormat
    #shaderModule: GPUShaderModule
    /** Edge pipeline (instanced screen-space line quads). */
    #linePipeline!: GPURenderPipeline
    /** Corner-marker pipeline (instanced AA discs). */
    #pointPipeline!: GPURenderPipeline
    /** Explicit bind-group layout shared by both pipelines. */
    #bindGroupLayout: GPUBindGroupLayout
    #cameraBuffer: GPUBuffer
    #instanceBuffer?: GPUBuffer
    #instanceCapacity = 0
    #cornerBuffer?: GPUBuffer
    #cornerCapacity = 0
    /** Single bind group (camera uniform + scene-depth tex) shared by both pipelines. */
    #bindGroup?: GPUBindGroup
    /** Number of alive-edge instances uploaded; `draw(6, edgeCount)`. */
    #edgeCount = 0
    /** Number of alive-corner instances uploaded; `draw(6, cornerCount)`. */
    #cornerCount = 0
    /**
     * 1×1 rgba32float placeholder bound at binding 1 whenever occlusion is off
     * (or no scene-depth texture has been supplied yet). The shader never reads
     * it in that state, but the bind group still requires a valid binding.
     */
    #dummyDepthTexture: GPUTexture
    #dummyDepthView: GPUTextureView
    /** Current scene-depth texture view bound at binding 1 (dummy when off). */
    #depthView: GPUTextureView
    /** Occlusion mode written into the camera uniform (0 off / 1 hard / 2 dim). */
    #occlusionMode = 0
    /** Edge line width in framebuffer pixels, written into the camera uniform. */
    #lineWidthPx = DEFAULT_LINE_WIDTH_PX
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
     * zoom[1] + viewCenter[2] + occlusionMode[1] + lineWidthPx[1] = 26 floats).
     * Cheap to compare and lets us skip the matrix inverse + upload when nothing
     * relevant changed.
     */
    #cameraInputCache = new Float32Array(26)
    #cameraInputValid = false
    /** Uint32 view of {@link #cameraStaging} for the integer occlusionMode slot. */
    #cameraStagingU32 = new Uint32Array(this.#cameraStaging)

    constructor(helper: GPUHelper, format: GPUTextureFormat) {
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

        // Explicit layout shared by both pipelines so a single bind group binds
        // to either (auto layouts produce distinct, non-interchangeable objects).
        this.#bindGroupLayout = this.#device.createBindGroupLayout({
            label: "FeatureGraphOverlay.BindGroupLayout",
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: "uniform" },
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: "unfilterable-float", viewDimension: "2d" },
                },
            ],
        })
        const pipelineLayout = this.#device.createPipelineLayout({
            label: "FeatureGraphOverlay.PipelineLayout",
            bindGroupLayouts: [this.#bindGroupLayout],
        })

        const target: GPUColorTargetState = { format: this.#format, blend: OVERLAY_BLEND }

        this.#linePipeline = this.#device.createRenderPipeline({
            label: "FeatureGraph Overlay Line Pipeline",
            layout: pipelineLayout,
            vertex: {
                module: this.#shaderModule,
                entryPoint: "vertexMain",
                buffers: [
                    {
                        // Per-edge instance: posA (vec3f) + posB (vec3f) + flags (u32).
                        arrayStride: INSTANCE_STRIDE,
                        stepMode: "instance",
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: "float32x3" },
                            { shaderLocation: 1, offset: 12, format: "float32x3" },
                            { shaderLocation: 2, offset: 24, format: "uint32" },
                        ],
                    },
                ],
            },
            fragment: { module: this.#shaderModule, entryPoint: "fragmentMain", targets: [target] },
            // Two triangles per instance form the expanded line quad.
            primitive: { topology: "triangle-list" },
        })

        this.#pointPipeline = this.#device.createRenderPipeline({
            label: "FeatureGraph Overlay Corner Pipeline",
            layout: pipelineLayout,
            vertex: {
                module: this.#shaderModule,
                entryPoint: "pointVertexMain",
                buffers: [
                    {
                        // Per-corner instance: position (vec3f).
                        arrayStride: CORNER_STRIDE,
                        stepMode: "instance",
                        attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
                    },
                ],
            },
            fragment: { module: this.#shaderModule, entryPoint: "pointFragmentMain", targets: [target] },
            primitive: { topology: "triangle-list" },
        })
    }

    /**
     * Upload one instance per alive edge (endpoint A + endpoint B world
     * positions + endpoint-A flags) and one instance per alive *corner* vertex.
     * Dead edges and non-corner vertices are skipped. Grow-on-demand pattern
     * matching `IsoSampleBatch`. Call once per FG rebuild; the camera uniform is
     * uploaded separately via {@link uploadCamera} on every render frame.
     */
    upload(cpu: FeatureGraphCpu, world: FeatureGraphWorldPositions): void {
        this.#edgeCount = 0
        this.#cornerCount = 0
        if (cpu.vertexCount === 0) return

        // --- Edges: one instance per alive edge ---
        let aliveEdgeCount = 0
        for (let e = 0; e < cpu.edgeCount; e++) {
            if ((cpu.edgeFlags[e]! & FG_FLAG_ALIVE) !== 0) aliveEdgeCount++
        }
        if (aliveEdgeCount > 0) {
            const instanceBytes = aliveEdgeCount * INSTANCE_STRIDE
            this.#ensureInstanceBuffer(instanceBytes)
            const buf = new ArrayBuffer(instanceBytes)
            const f32 = new Float32Array(buf)
            const u32 = new Uint32Array(buf)
            let s = 0
            for (let e = 0; e < cpu.edgeCount; e++) {
                if ((cpu.edgeFlags[e]! & FG_FLAG_ALIVE) === 0) continue
                const a = cpu.edgeEndpoints[e * 2]!
                const b = cpu.edgeEndpoints[e * 2 + 1]!
                const o = s * 8
                f32[o + 0] = world.positions[a * 3 + 0]!
                f32[o + 1] = world.positions[a * 3 + 1]!
                f32[o + 2] = world.positions[a * 3 + 2]!
                f32[o + 3] = world.positions[b * 3 + 0]!
                f32[o + 4] = world.positions[b * 3 + 1]!
                f32[o + 5] = world.positions[b * 3 + 2]!
                // Endpoint A's crease flags drive the line color. Slot o+7 is pad.
                u32[o + 6] = cpu.vertexFlags[a] ?? 0
                s++
            }
            this.#device.queue.writeBuffer(this.#instanceBuffer!, 0, buf)
            this.#edgeCount = aliveEdgeCount
        }

        // --- Corners: one marker per alive 0D-feature vertex ---
        const cornerMask = FG_FLAG_ALIVE | FG_FLAG_CORNER
        let cornerCount = 0
        for (let i = 0; i < cpu.vertexCount; i++) {
            if ((cpu.vertexFlags[i]! & cornerMask) === cornerMask) cornerCount++
        }
        if (cornerCount > 0) {
            const cornerBytes = cornerCount * CORNER_STRIDE
            this.#ensureCornerBuffer(cornerBytes)
            const cbuf = new Float32Array(cornerCount * 3)
            let c = 0
            for (let i = 0; i < cpu.vertexCount; i++) {
                if ((cpu.vertexFlags[i]! & cornerMask) !== cornerMask) continue
                cbuf[c * 3 + 0] = world.positions[i * 3 + 0]!
                cbuf[c * 3 + 1] = world.positions[i * 3 + 1]!
                cbuf[c * 3 + 2] = world.positions[i * 3 + 2]!
                c++
            }
            this.#device.queue.writeBuffer(this.#cornerBuffer!, 0, cbuf)
            this.#cornerCount = cornerCount
        }
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
        // run when the camera (or occlusion mode / line width) actually changed.
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
                cache[24] === this.#occlusionMode &&
                cache[25] === this.#lineWidthPx
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
        cache[25] = this.#lineWidthPx
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
        // lineWidthPx (f32): bytes 108..111
        f32[27] = this.#lineWidthPx
        this.#device.queue.writeBuffer(this.#cameraBuffer, 0, this.#cameraStaging)
    }

    /**
     * Set the scene-depth source + occlusion mode for the next render. Pass a
     * world-space hit-position texture view (rgba32float, xyz = hit position,
     * w = hit mask) from the SDF depth-only pass and a non-zero mode to enable
     * depth ordering; pass `null` / mode 0 to draw on top as before.
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

    /** Set the edge line width (framebuffer pixels). Applied on next {@link uploadCamera}. */
    setLineWidth(px: number): void {
        this.#lineWidthPx = px
    }

    /**
     * Issue draw calls into an open render pass: edges first, then corner
     * markers on top. No-op when nothing has been uploaded. The caller is
     * responsible for opening a render pass with the canvas target and
     * `loadOp: "load"`.
     */
    render(pass: GPURenderPassEncoder): void {
        if (this.#edgeCount === 0 && this.#cornerCount === 0) return
        if (!this.#bindGroup) {
            this.#bindGroup = this.#device.createBindGroup({
                label: "FeatureGraphOverlay.BindGroup",
                layout: this.#bindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: this.#cameraBuffer } },
                    { binding: 1, resource: this.#depthView },
                ],
            })
        }
        pass.setBindGroup(0, this.#bindGroup)
        if (this.#edgeCount > 0 && this.#instanceBuffer) {
            pass.setPipeline(this.#linePipeline)
            pass.setVertexBuffer(0, this.#instanceBuffer)
            pass.draw(6, this.#edgeCount) // 6 verts (2 triangles) per edge instance
        }
        if (this.#cornerCount > 0 && this.#cornerBuffer) {
            pass.setPipeline(this.#pointPipeline)
            pass.setVertexBuffer(0, this.#cornerBuffer)
            pass.draw(6, this.#cornerCount) // 6 verts per corner-marker instance
        }
    }

    /** True if the overlay has alive features uploaded and ready to draw. */
    get hasAliveFeatures(): boolean {
        return this.#edgeCount > 0 || this.#cornerCount > 0
    }

    destroy(): void {
        this.#cameraBuffer.destroy()
        this.#dummyDepthTexture.destroy()
        this.#instanceBuffer?.destroy()
        this.#cornerBuffer?.destroy()
        this.#instanceBuffer = undefined
        this.#cornerBuffer = undefined
        this.#instanceCapacity = 0
        this.#cornerCapacity = 0
        this.#bindGroup = undefined
        this.#edgeCount = 0
        this.#cornerCount = 0
    }

    #ensureInstanceBuffer(minBytes: number): void {
        if (this.#instanceBuffer && this.#instanceCapacity >= minBytes) return
        this.#instanceBuffer?.destroy()
        // Double-on-grow with a 4 KiB floor — identical pattern to
        // `IsoSampleBatch.#ensurePositionBuffer`.
        this.#instanceCapacity = Math.max(minBytes, this.#instanceCapacity * 2 || 4096)
        this.#instanceBuffer = this.#device.createBuffer({
            label: "FeatureGraphOverlay.Instance",
            size: this.#instanceCapacity,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        })
    }

    #ensureCornerBuffer(minBytes: number): void {
        if (this.#cornerBuffer && this.#cornerCapacity >= minBytes) return
        this.#cornerBuffer?.destroy()
        this.#cornerCapacity = Math.max(minBytes, this.#cornerCapacity * 2 || 4096)
        this.#cornerBuffer = this.#device.createBuffer({
            label: "FeatureGraphOverlay.Corner",
            size: this.#cornerCapacity,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        })
    }
}
