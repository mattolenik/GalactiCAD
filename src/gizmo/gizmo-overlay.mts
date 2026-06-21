/**
 * Transform gizmo overlay — GPU pipeline + buffer management.
 *
 * Renders a single transform gizmo (3 axis arrows for translation + 3 rotation
 * rings) anchored at the selected object's center, over the rendered scene.
 * Decoupled from the main scene pipeline so it can toggle on/off at runtime
 * without recompiling shaders and owns its own slim camera uniform (the preview
 * camera struct has a much larger layout we don't need here).
 *
 * Geometry is authored once in unit-scale "gizmo-local" space (1.0 ==
 * `sizePx` framebuffer pixels) and transformed to world in the vertex shader
 * via `world = center + local * (sizePx * worldPerPixel)`, so the gizmo stays a
 * constant pixel size and the rings project to correct ellipses. See
 * `gizmo_overlay.wgsl` for the projection convention (shared with the
 * FeatureGraph overlay).
 *
 * Buffer layout
 * -------------
 *  - **Line instance buffer**: one record per segment (3 axis shafts +
 *    3·`RING_SEGMENTS` ring segments), stride 32 bytes — localA (vec3f) +
 *    localB (vec3f) + meta (u32) + 4-byte pad. Drawn as a 6-vertex screen-space
 *    line quad per instance.
 *  - **Head instance buffer**: one record per axis (3), stride 32 bytes —
 *    localTip (vec3f) + localBack (vec3f) + meta (u32) + 4-byte pad. Drawn as a
 *    3-vertex billboarded arrowhead triangle per instance.
 *  - **Camera uniform**: 112 bytes (see {@link CAMERA_UNIFORM_BYTES}).
 *  - **Gizmo uniform**: 32 bytes (center + sizePx + hover/active handle +
 *    lineWidthPx + visible).
 *
 * No depth attachment: the gizmo always draws on top so handles stay grabbable.
 */

import type { GPUHelper } from "../gpu/helper.mjs"
import { scheduleShaderModuleCompilationLogging } from "../shaders/shader.mjs"
import overlayShaderSource from "../shaders/gizmo_overlay.wgsl"
import { Mat4x4f } from "../vecmat/matrix.mjs"
import {
    GIZMO_AXES as AXES,
    GIZMO_CENTER_GAP as CENTER_GAP,
    GIZMO_RING_RADIUS as RING_RADIUS,
    GIZMO_SHAFT_END as SHAFT_END,
    GIZMO_TIP as TIP,
} from "./gizmo-geometry.mjs"

/** localA (vec3f,12) + localB (vec3f,12) + meta (u32,4) + pad (4) = 32. */
const LINE_STRIDE = 32
/** localTip (vec3f,12) + localBack (vec3f,12) + meta (u32,4) + pad (4) = 32. */
const HEAD_STRIDE = 32

/** Camera uniform size (bytes). Layout mirrors `OverlayCamera` in the shader. */
const CAMERA_UNIFORM_BYTES = 112
/** Gizmo uniform size (bytes). Layout mirrors `Gizmo` in the shader. */
const GIZMO_UNIFORM_BYTES = 32

/** Default shaft/ring line width in framebuffer pixels. */
const DEFAULT_LINE_WIDTH_PX = 2.5

/** Segments per rotation ring (smooth circle → ellipse when projected). Visual
 * only — the hit-tester samples rings independently. */
const RING_SEGMENTS = 48

/**
 * Same ray-origin push the preview ray-marcher uses (matches
 * `PREVIEW_RAY_ORIGIN_DEPTH` in camera-controller / mesh-viewer / FG overlay),
 * so gizmo geometry lines up pixel-perfectly with the SDF render.
 */
const PREVIEW_RAY_ORIGIN_DEPTH = 300

const OVERLAY_BLEND: GPUBlendState = {
    color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
    alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
}

export class GizmoOverlay {
    #device: GPUDevice
    #shaderModule: GPUShaderModule
    #linePipeline: GPURenderPipeline
    #headPipeline: GPURenderPipeline
    #bindGroupLayout: GPUBindGroupLayout
    #cameraBuffer: GPUBuffer
    #gizmoBuffer: GPUBuffer
    #lineBuffer: GPUBuffer
    #headBuffer: GPUBuffer
    #lineCount = 0
    #headCount = 0
    #bindGroup?: GPUBindGroup

    #cameraStaging = new ArrayBuffer(CAMERA_UNIFORM_BYTES)
    #cameraF32 = new Float32Array(this.#cameraStaging)

    #gizmoStaging = new ArrayBuffer(GIZMO_UNIFORM_BYTES)
    #gizmoF32 = new Float32Array(this.#gizmoStaging)
    #gizmoI32 = new Int32Array(this.#gizmoStaging)
    #gizmoU32 = new Uint32Array(this.#gizmoStaging)

    #visible = false

    constructor(helper: GPUHelper, format: GPUTextureFormat) {
        this.#device = helper.device

        this.#shaderModule = this.#device.createShaderModule({
            label: "Gizmo Overlay",
            code: overlayShaderSource,
        })
        scheduleShaderModuleCompilationLogging(this.#shaderModule, "Gizmo Overlay", overlayShaderSource)

        this.#cameraBuffer = this.#device.createBuffer({
            label: "GizmoOverlay.Camera",
            size: CAMERA_UNIFORM_BYTES,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })
        this.#gizmoBuffer = this.#device.createBuffer({
            label: "GizmoOverlay.Gizmo",
            size: GIZMO_UNIFORM_BYTES,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })

        this.#bindGroupLayout = this.#device.createBindGroupLayout({
            label: "GizmoOverlay.BindGroupLayout",
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
                { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
            ],
        })
        const pipelineLayout = this.#device.createPipelineLayout({
            label: "GizmoOverlay.PipelineLayout",
            bindGroupLayouts: [this.#bindGroupLayout],
        })

        const target: GPUColorTargetState = { format, blend: OVERLAY_BLEND }

        this.#linePipeline = this.#device.createRenderPipeline({
            label: "Gizmo Overlay Line Pipeline",
            layout: pipelineLayout,
            vertex: {
                module: this.#shaderModule,
                entryPoint: "lineVertexMain",
                buffers: [
                    {
                        arrayStride: LINE_STRIDE,
                        stepMode: "instance",
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: "float32x3" },
                            { shaderLocation: 1, offset: 12, format: "float32x3" },
                            { shaderLocation: 2, offset: 24, format: "uint32" },
                        ],
                    },
                ],
            },
            fragment: { module: this.#shaderModule, entryPoint: "lineFragmentMain", targets: [target] },
            primitive: { topology: "triangle-list" },
        })

        this.#headPipeline = this.#device.createRenderPipeline({
            label: "Gizmo Overlay Head Pipeline",
            layout: pipelineLayout,
            vertex: {
                module: this.#shaderModule,
                entryPoint: "headVertexMain",
                buffers: [
                    {
                        arrayStride: HEAD_STRIDE,
                        stepMode: "instance",
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: "float32x3" },
                            { shaderLocation: 1, offset: 12, format: "float32x3" },
                            { shaderLocation: 2, offset: 24, format: "uint32" },
                        ],
                    },
                ],
            },
            fragment: { module: this.#shaderModule, entryPoint: "headFragmentMain", targets: [target] },
            primitive: { topology: "triangle-list" },
        })

        const { lineBuffer, lineCount, headBuffer, headCount } = this.#buildGeometry()
        this.#lineBuffer = lineBuffer
        this.#lineCount = lineCount
        this.#headBuffer = headBuffer
        this.#headCount = headCount
    }

    /**
     * Generate the static gizmo geometry (3 axis shafts + 3 rotation rings as
     * line segments, 3 arrowheads) into GPU instance buffers. Called once.
     */
    #buildGeometry(): { lineBuffer: GPUBuffer; lineCount: number; headBuffer: GPUBuffer; headCount: number } {
        const lineCount = AXES.length * (1 + RING_SEGMENTS)
        const lineBuf = new ArrayBuffer(lineCount * LINE_STRIDE)
        const lf = new Float32Array(lineBuf)
        const lu = new Uint32Array(lineBuf)
        let li = 0
        const pushLine = (a: readonly number[], b: readonly number[], meta: number): void => {
            const o = li * 8
            lf[o + 0] = a[0]!
            lf[o + 1] = a[1]!
            lf[o + 2] = a[2]!
            lf[o + 3] = b[0]!
            lf[o + 4] = b[1]!
            lf[o + 5] = b[2]!
            lu[o + 6] = meta
            li++
        }

        for (let axis = 0; axis < AXES.length; axis++) {
            const u = AXES[axis]!
            // Translate shaft: meta kind 0.
            pushLine([u[0] * CENTER_GAP, u[1] * CENTER_GAP, u[2] * CENTER_GAP], [u[0] * SHAFT_END, u[1] * SHAFT_END, u[2] * SHAFT_END], axis)
            // Rotation ring in the plane perpendicular to this axis: meta kind 1.
            const e0 = AXES[(axis + 1) % 3]!
            const e1 = AXES[(axis + 2) % 3]!
            const ringMeta = axis | (1 << 2)
            let prev = ringPoint(e0, e1, 0)
            for (let s = 1; s <= RING_SEGMENTS; s++) {
                const cur = ringPoint(e0, e1, (s / RING_SEGMENTS) * Math.PI * 2)
                pushLine(prev, cur, ringMeta)
                prev = cur
            }
        }

        const lineBuffer = this.#device.createBuffer({
            label: "GizmoOverlay.Line",
            size: lineBuf.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        })
        this.#device.queue.writeBuffer(lineBuffer, 0, lineBuf)

        // Arrowheads: one per axis.
        const headBuf = new ArrayBuffer(AXES.length * HEAD_STRIDE)
        const hf = new Float32Array(headBuf)
        const hu = new Uint32Array(headBuf)
        for (let axis = 0; axis < AXES.length; axis++) {
            const u = AXES[axis]!
            const o = axis * 8
            hf[o + 0] = u[0] * TIP
            hf[o + 1] = u[1] * TIP
            hf[o + 2] = u[2] * TIP
            hf[o + 3] = u[0] * SHAFT_END
            hf[o + 4] = u[1] * SHAFT_END
            hf[o + 5] = u[2] * SHAFT_END
            hu[o + 6] = axis
        }
        const headBuffer = this.#device.createBuffer({
            label: "GizmoOverlay.Head",
            size: headBuf.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        })
        this.#device.queue.writeBuffer(headBuffer, 0, headBuf)

        return { lineBuffer, lineCount, headBuffer, headCount: AXES.length }
    }

    /** Push the per-frame camera uniform (same convention as FeatureGraphOverlay). */
    uploadCamera(
        viewTransform: Float32Array | ArrayBuffer,
        cameraPosition: readonly [number, number, number],
        resX: number,
        resY: number,
        zoom: number,
        viewCenter: readonly [number, number] = [0.5, 0.5],
    ): void {
        const vt = viewTransform instanceof Float32Array ? viewTransform : new Float32Array(viewTransform)
        const inverse = new Mat4x4f(new Float32Array(vt)).inverse()
        const f32 = this.#cameraF32
        f32.set(inverse.data.subarray(0, 16), 0)
        f32[16] = cameraPosition[0]
        f32[17] = cameraPosition[1]
        f32[18] = cameraPosition[2] + PREVIEW_RAY_ORIGIN_DEPTH
        f32[19] = 0
        f32[20] = resX
        f32[21] = resY
        f32[22] = zoom
        f32[23] = 0
        f32[24] = viewCenter[0]
        f32[25] = viewCenter[1]
        f32[26] = 0
        f32[27] = 0
        this.#device.queue.writeBuffer(this.#cameraBuffer, 0, this.#cameraStaging)
    }

    /**
     * Set the gizmo's anchor + interaction state. `hoverHandle`/`activeHandle`
     * are -1 when none (handle id = axisId + kind*3, 0..5).
     */
    setState(
        center: readonly [number, number, number],
        sizePx: number,
        visible: boolean,
        hoverHandle = -1,
        activeHandle = -1,
        lineWidthPx = DEFAULT_LINE_WIDTH_PX,
    ): void {
        this.#visible = visible
        this.#gizmoF32[0] = center[0]
        this.#gizmoF32[1] = center[1]
        this.#gizmoF32[2] = center[2]
        this.#gizmoF32[3] = sizePx
        this.#gizmoI32[4] = hoverHandle
        this.#gizmoI32[5] = activeHandle
        this.#gizmoF32[6] = lineWidthPx
        this.#gizmoU32[7] = visible ? 1 : 0
        this.#device.queue.writeBuffer(this.#gizmoBuffer, 0, this.#gizmoStaging)
    }

    get visible(): boolean {
        return this.#visible
    }

    /** Issue draw calls into an open render pass (rings/shafts first, heads on top). */
    render(pass: GPURenderPassEncoder): void {
        if (!this.#visible) return
        if (!this.#bindGroup) {
            this.#bindGroup = this.#device.createBindGroup({
                label: "GizmoOverlay.BindGroup",
                layout: this.#bindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: this.#cameraBuffer } },
                    { binding: 1, resource: { buffer: this.#gizmoBuffer } },
                ],
            })
        }
        pass.setBindGroup(0, this.#bindGroup)
        pass.setPipeline(this.#linePipeline)
        pass.setVertexBuffer(0, this.#lineBuffer)
        pass.draw(6, this.#lineCount)
        pass.setPipeline(this.#headPipeline)
        pass.setVertexBuffer(0, this.#headBuffer)
        pass.draw(3, this.#headCount)
    }

    destroy(): void {
        this.#cameraBuffer.destroy()
        this.#gizmoBuffer.destroy()
        this.#lineBuffer.destroy()
        this.#headBuffer.destroy()
        this.#bindGroup = undefined
    }
}

/** A point on a unit ring spanned by axes `e0`/`e1`, scaled by RING_RADIUS. */
function ringPoint(e0: readonly number[], e1: readonly number[], theta: number): [number, number, number] {
    const c = Math.cos(theta) * RING_RADIUS
    const s = Math.sin(theta) * RING_RADIUS
    return [e0[0]! * c + e1[0]! * s, e0[1]! * c + e1[1]! * s, e0[2]! * c + e1[2]! * s]
}
