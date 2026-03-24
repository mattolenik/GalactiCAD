/**
 * Render worker core - GPU logic extracted from SDFRenderer.
 * Runs in the render worker; owns device, buffers, pipelines.
 */

import { AveragedBuffer } from "./collections/averagedbuffer.mjs"
import { GPUHelper } from "./gpu/helper.mjs"
import { PALETTE_SIZE, DEFAULT_PALETTE, paletteToFloat32Array } from "./colorPalette.mjs"
import { DEFAULT_SELECTION_STYLES } from "./selectionStyles.mjs"
import outlineShader from "./shaders/outline.wgsl"
import previewShader from "./shaders/preview.wgsl"
import beamShader from "./shaders/beam.wgsl"
import boundsShader from "./shaders/bounds.wgsl"
import mdcShader from "./shaders/mdc.wgsl"
import { ShaderCompiler } from "./shaders/shader.mjs"
import { MDCExport, type MDCParams } from "./export/mdc.mjs"
import { SceneInfo } from "./scene/scene.mjs"
import { Extrude, Loft } from "./scene/scene.mjs"
import { serializeSceneNodes } from "./scene-serializer.mjs"
import { vec3, Vec3f } from "./vecmat/vector.mjs"
import { lookAt, Mat4x4f } from "./vecmat/matrix.mjs"
import {
    DEFAULT_PREVIEW_SHADING,
    type MainToWorkerMessage,
    type PreviewShadingParams,
    type RenderSelectionState,
    type SelectedEdgePayload,
} from "./render-worker-protocol.mjs"
import type { SelectionInfo } from "./components/preview-window.mjs"
import { EdgeKind } from "./edge-kind.mjs"
import { writeFps, SAB_LAYOUT, readSelectionStateFromSAB, getPublishedRenderSlot, getSlotByteOffset } from "./shared-render-buffer.mjs"

const MAX_POLYGON_VERTICES = 1024
const POLYGON_VERTEX_BUFFER_SIZE = MAX_POLYGON_VERTICES * 8
const MAX_NODE_PARAMS = 256
const NODE_PARAMS_BUFFER_SIZE = MAX_NODE_PARAMS * 16

const EDGE_HITS_SIZE = 320
const SELECTED_EDGES_HEADER = 16
const SELECTED_EDGE_SIZE = 80
const SELECTED_EDGES_COUNT = 16
const SELECTED_EDGES_TOTAL = SELECTED_EDGES_HEADER + SELECTED_EDGES_COUNT * SELECTED_EDGE_SIZE

class UniformBuffers {
    camera!: GPUBuffer
    scene!: GPUBuffer
    clickState!: GPUBuffer
    clickedObjectId!: GPUBuffer
    selectedObjectIds!: GPUBuffer
    colorPalette!: GPUBuffer
    viewSettings!: GPUBuffer
    outlineSettings!: GPUBuffer
    selectionStyles!: GPUBuffer
    polygonVertices!: GPUBuffer
    clickedHitPos!: GPUBuffer
    clickedNormal!: GPUBuffer
    faceSelection!: GPUBuffer
    nodeParams!: GPUBuffer
    edgeHit!: GPUBuffer
    selectedEdges!: GPUBuffer
    hoverEdgeHit!: GPUBuffer
    hoveredEdge!: GPUBuffer
}

class ExportBuffers {
    scene!: GPUBuffer
    vertexBuffer!: GPUBuffer
    triangleBuffer!: GPUBuffer
    triCountBuffer!: GPUBuffer
}

export class RenderWorkerCore {
    #canvas!: OffscreenCanvas
    #device!: GPUDevice
    #context!: GPUCanvasContext
    #format!: GPUTextureFormat
    #helper!: GPUHelper
    #uniformBuffers = new UniformBuffers()
    #exportBuffers = new ExportBuffers()
    #colorSampler!: GPUSampler
    #outlineShaderModule!: GPUShaderModule
    #outlinePipeline!: GPURenderPipeline
    #outlineBindGroup!: GPUBindGroup | undefined
    #scene: SceneInfo | null = null
    #sceneShader: GPUShaderModule | null = null
    #beamShader: GPUShaderModule | null = null
    #pipeline: GPURenderPipeline | null = null
    #beamPipeline: GPUComputePipeline | null = null
    #beamBindGroupInvalid = false
    #sceneBindGroupInvalid = false
    #bvhEnabled = true
    #buildGeneration = 0
    #buildLock: Promise<void> = Promise.resolve()
    #compiledPosY = new Map<number, number>()
    #colorTexture!: GPUTexture
    #idTexture!: GPUTexture
    #tStartTexture!: GPUTexture
    #colorTextureView!: GPUTextureView
    #idTextureView!: GPUTextureView
    #tStartTextureView!: GPUTextureView
    #bindGroup?: GPUBindGroup
    #beamBindGroup?: GPUBindGroup
    #renderTextureWidth = 0
    #renderTextureHeight = 0
    #fullWidth = 0
    #fullHeight = 0
    #framerate = new AveragedBuffer(4)
    #lastRenderTime = 0
    #fpsFrameCount = 0
    #lastFpsSendTime = 0
    #lightDirBuf = new Float32Array(12)
    #viewSettingsBuf = new Uint32Array(4)
    #selDataBuf = new Uint32Array(1024)
    #outlineBuf = new ArrayBuffer(48)
    #outlineU32 = new Uint32Array(this.#outlineBuf, 0, 1)
    #outlineThicknessF32 = new Float32Array(this.#outlineBuf, 4, 1)
    #outlineColorF32 = new Float32Array(this.#outlineBuf, 16, 3)
    #outlineWidthF32 = new Float32Array(this.#outlineBuf, 28, 1)
    #selectionStylesBuf = new ArrayBuffer(80)
    #selectionStylesF32 = new Float32Array(this.#selectionStylesBuf)
    #edgeHeaderBuf = new ArrayBuffer(SELECTED_EDGES_HEADER)
    #edgeHeaderU32 = new Uint32Array(this.#edgeHeaderBuf)
    #edgeStrideBuf = new ArrayBuffer(SELECTED_EDGE_SIZE)
    #edgeStrideU32 = new Uint32Array(this.#edgeStrideBuf)
    #edgeStrideF32 = new Float32Array(this.#edgeStrideBuf)
    #camTransform = new Mat4x4f(new Float32Array(16))
    /** Dirty-state caches: last uploaded bytes. Compare before writeBuffer to skip redundant uploads. */
    #cameraCache = new ArrayBuffer(240)
    #viewSettingsCache = new ArrayBuffer(16)
    #outlineCache = new ArrayBuffer(48)
    #selectionStylesCache = new ArrayBuffer(80)
    #selectedIdsCache = new ArrayBuffer(4096)
    #selectedEdgesCache = new ArrayBuffer(SELECTED_EDGES_TOTAL)
    #hoveredEdgesCache = new ArrayBuffer(SELECTED_EDGES_TOTAL)
    #cameraStagingBuf = new ArrayBuffer(240)
    #edgesStagingBuf = new ArrayBuffer(SELECTED_EDGES_TOTAL)
    /** Worker-owned staging for SAB snapshot; max(SELECTED_OBJECT_IDS_SIZE, SELECTED_EDGES_TOTAL) */
    #sabStagingBuf = new ArrayBuffer(4096)
    #lastRenderMsg: Extract<MainToWorkerMessage, { type: "render" }> | null = null
    #lastSharedBuffer: SharedArrayBuffer | null = null
    #lastSelectionMode = 0
    #builtBody: string | null = null
    #fpsVersion = 0

    async init(canvas: OffscreenCanvas): Promise<void> {
        this.#canvas = canvas
        const helper = await GPUHelper.create()
        if (!helper) {
            throw new Error("No GPU adapter found", { cause: "unsupported" })
        }
        this.#helper = helper
        this.#device = this.#helper.device
        this.#context = canvas.getContext("webgpu") as GPUCanvasContext
        if (!this.#context) {
            throw new Error("Failed to get WebGPU context from OffscreenCanvas")
        }

        this.#format = navigator.gpu.getPreferredCanvasFormat()
        this.#context.configure({
            device: this.#device,
            format: this.#format,
            alphaMode: "premultiplied",
        })

        this.#createBuffers()

        this.#colorSampler = this.#device.createSampler({
            magFilter: "linear",
            minFilter: "linear",
        })

        this.#outlineShaderModule = this.#device.createShaderModule({
            label: "Outline Post-Process",
            code: outlineShader,
        })
        this.#outlinePipeline = this.#device.createRenderPipeline({
            label: "Outline Pipeline",
            layout: "auto",
            vertex: {
                module: this.#outlineShaderModule,
                entryPoint: "vertexMain",
            },
            fragment: {
                module: this.#outlineShaderModule,
                entryPoint: "fragmentMain",
                targets: [{ format: this.#format }],
            },
            primitive: {
                topology: "triangle-strip",
                stripIndexFormat: "uint32",
            },
        })

        // Outline bind group created in ensureRenderTextures when we have color/id textures

        // Init click/selection/face buffers
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickState, 0, new ArrayBuffer(32))
        this.#device.queue.writeBuffer(this.#uniformBuffers.selectedObjectIds, 0, new Uint32Array(1024))
        this.#device.queue.writeBuffer(this.#uniformBuffers.faceSelection, 0, new ArrayBuffer(20))

        // Init empty edges
        this.#writeEdgesToBuffer(this.#uniformBuffers.selectedEdges, [], DEFAULT_SELECTION_STYLES.edge.lineWidthPx, DEFAULT_SELECTION_STYLES.edge.epsilon)
        this.#writeEdgesToBuffer(this.#uniformBuffers.hoveredEdge, [], 6.0, 0.02)
    }

    async build(body: string, _documentName?: string | null): Promise<{ sceneNodes: import("./render-worker-protocol.mjs").SerializedNode[]; compiledPosY: [number, number][] } | { superseded: true }> {
        const prev = this.#buildLock
        let release!: () => void
        this.#buildLock = new Promise<void>(r => (release = r))
        await prev
        try {
            return await this.#doBuild(body)
        } finally {
            release()
        }
    }

    setBvhEnabled(enabled: boolean): void {
        this.#bvhEnabled = enabled
    }

    cancelBuilds(): void {
        this.#buildGeneration++
    }

    async #doBuild(body: string): Promise<{ sceneNodes: import("./render-worker-protocol.mjs").SerializedNode[]; compiledPosY: [number, number][] } | { superseded: true }> {
        this.#builtBody = body
        this.#scene = new SceneInfo(body, { bvhEnabled: this.#bvhEnabled })
        const scene = this.#scene
        const allNodes = scene.getAllNodes()

        const sceneAux = scene.compileAux()
        const sceneAuxFast = scene.compileAuxFast()
        const sceneAuxMid = scene.compileAuxMid()
        const sceneSDF = scene.compile()
        const sceneSDF_fast = scene.compileFast()
        const sceneSDF_mid = scene.compileMid()
        const sceneEdgeHelpers = scene.compileEdgeHelpers()

        const shaderCompiler = new ShaderCompiler(this.#device)
            .replace("insert", "sceneAuxFast", sceneAuxFast)
            .replace("insert", "sceneAux", sceneAux)
            .replace("insert", "sceneAuxMid", sceneAuxMid)
            .replace("insert", "sceneSDF_fast", sceneSDF_fast)
            .replace("insert", "sceneSDF", sceneSDF)
            .replace("insert", "sceneSDF_mid", sceneSDF_mid)
            .replace("insert", "sceneEdgeHelpers", sceneEdgeHelpers)

        const nextSceneShader = shaderCompiler.compile(previewShader, "Preview Window")
        const nextBeamShader = shaderCompiler.compile(beamShader, "Beam Pre-Pass")

        const polygonVertexData = scene.totalPolygonVertices > 0
            ? (scene.getPolygonVertexData().buffer.slice(0) as ArrayBuffer)
            : new ArrayBuffer(0)
        const nodeParamsData = new Float32Array(MAX_NODE_PARAMS * 4)
        const newCompiledPosY = new Map<number, number>()
        for (const node of allNodes) {
            if ((node instanceof Extrude || node instanceof Loft) && node.id < MAX_NODE_PARAMS) {
                nodeParamsData[node.id * 4] = node.h
                nodeParamsData[node.id * 4 + 1] = 0
                newCompiledPosY.set(node.id, node.pos.y)
            }
        }

        this.#buildGeneration++
        const generation = this.#buildGeneration

        const [pipeline, beamPipeline] = await Promise.all([
            this.#device.createRenderPipelineAsync({
                label: "Preview Pipeline",
                layout: "auto",
                vertex: { module: nextSceneShader, entryPoint: "vertexMain" },
                fragment: {
                    module: nextSceneShader,
                    entryPoint: "fragmentMain",
                    targets: [{ format: this.#format }, { format: "r32uint" as GPUTextureFormat }],
                },
                primitive: { topology: "triangle-strip", stripIndexFormat: "uint32" },
            }),
            this.#device.createComputePipelineAsync({
                label: "Beam Pre-Pass Pipeline",
                layout: "auto",
                compute: { module: nextBeamShader, entryPoint: "beamMarch" },
            }),
        ])
        if (generation !== this.#buildGeneration) {
            return { superseded: true } as { sceneNodes: never; compiledPosY: never; superseded: true }
        }

        // WebGPU: only buffers, textures, and query sets have destroy(). Pipelines, shader modules,
        // and bind groups do not — replace fields so previous objects can be GC'd.
        this.#pipeline = pipeline
        this.#beamPipeline = beamPipeline
        this.#sceneShader = nextSceneShader
        this.#beamShader = nextBeamShader

        // Write GPU buffers only after the new pipeline is ready so the old pipeline
        // continues rendering with the correct drag-time nodeParams (posYDelta != 0)
        // until the atomic swap. This prevents the visible jump where the object briefly
        // snaps back to its pre-drag position during pipeline compilation.
        this.#compiledPosY = newCompiledPosY
        if (scene.totalPolygonVertices > 0) {
            this.#device.queue.writeBuffer(this.#uniformBuffers.polygonVertices, 0, polygonVertexData as BufferSource)
        }
        this.#device.queue.writeBuffer(this.#uniformBuffers.nodeParams, 0, nodeParamsData)
        this.#beamBindGroupInvalid = true
        this.#sceneBindGroupInvalid = true

        return { sceneNodes: serializeSceneNodes(scene, allNodes), compiledPosY: Array.from(this.#compiledPosY) }
    }

    resize(fullWidth: number, fullHeight: number): void {
        this.#fullWidth = Math.max(0, fullWidth)
        this.#fullHeight = Math.max(0, fullHeight)
        this.#canvas.width = Math.max(1, fullWidth)
        this.#canvas.height = Math.max(1, fullHeight)
    }

    render(msg: Extract<MainToWorkerMessage, { type: "render" }>, outputTextureView?: GPUTextureView, sharedBuffer?: SharedArrayBuffer): void {
        const now = performance.now()
        if (this.#lastRenderTime > 0) {
            const delta = now - this.#lastRenderTime
            if (delta > 0) {
                this.#framerate.update(1000 / delta)
                this.#fpsFrameCount++
                const timeSinceFps = now - this.#lastFpsSendTime
                if (this.#fpsFrameCount >= 5 || timeSinceFps >= 100) {
                    this.#fpsFrameCount = 0
                    this.#lastFpsSendTime = now
                    if (sharedBuffer) {
                        this.#fpsVersion++
                        writeFps(sharedBuffer, this.#framerate.average, this.#fpsVersion)
                    } else {
                        self.postMessage({ type: "fps", fps: this.#framerate.average })
                    }
                }
            }
        }
        this.#lastRenderTime = now

        this.#lastRenderMsg = msg
        this.#lastSelectionMode = msg.viewSettings.selectionMode
        const { viewTransform, cameraPosition, cameraRes, viewSettings, viewCenter, resolutionScale, selectionState } = msg
        if (!this.#pipeline) return
        const sceneWidth = Math.max(1, Math.round(cameraRes[0] * resolutionScale))
        const sceneHeight = Math.max(1, Math.round(cameraRes[1] * resolutionScale))
        if (sceneWidth === 0 || sceneHeight === 0) return
        if (!outputTextureView && (this.#fullWidth <= 0 || this.#fullHeight <= 0)) return

        this.#ensureRenderTextures(sceneWidth, sceneHeight)

        this.#uploadCameraIfDirty(
            viewTransform,
            cameraPosition,
            sceneWidth,
            sceneHeight,
            msg.cameraState.zoom,
            viewCenter,
            msg.viewSettings.previewShading ?? DEFAULT_PREVIEW_SHADING,
        )

        this.#viewSettingsBuf[0] = viewSettings.xrayMode ? 1 : 0
        this.#viewSettingsBuf[1] = 0  // unused (was refinementSteps)
        this.#viewSettingsBuf[2] = viewSettings.beamEnabled ? 1 : 0
        this.#viewSettingsBuf[3] = viewSettings.selectionMode
        this.#writeBufferViewIfDirty(this.#uniformBuffers.viewSettings, this.#viewSettingsBuf, this.#viewSettingsCache)

        this.#outlineU32[0] = viewSettings.outlineMode
        this.#outlineThicknessF32[0] = viewSettings.outlineThickness
        this.#outlineColorF32.set(viewSettings.outlineColor)
        this.#outlineWidthF32[0] = outputTextureView ? sceneWidth : this.#fullWidth
        const outline = DEFAULT_SELECTION_STYLES.outline
        new Float32Array(this.#outlineBuf, 32, 1)[0] = outline.dashSpacing
        new Float32Array(this.#outlineBuf, 36, 1)[0] = outline.dashLength
        new Float32Array(this.#outlineBuf, 40, 1)[0] = outline.dotSizeMin
        new Float32Array(this.#outlineBuf, 44, 1)[0] = outline.dotSpacingMultiplier
        this.#writeBufferViewIfDirty(this.#uniformBuffers.outlineSettings, new Uint8Array(this.#outlineBuf), this.#outlineCache)

        const ss = viewSettings.selectionStyles
        const def = DEFAULT_SELECTION_STYLES
        this.#selectionStylesF32[0] = ss.face.darken
        this.#selectionStylesF32[4] = ss.face.tint[0]
        this.#selectionStylesF32[5] = ss.face.tint[1]
        this.#selectionStylesF32[6] = ss.face.tint[2]
        this.#selectionStylesF32[8] = ss.edge.color[0]
        this.#selectionStylesF32[9] = ss.edge.color[1]
        this.#selectionStylesF32[10] = ss.edge.color[2]
        this.#selectionStylesF32[12] = def.edge.selectedStrength
        this.#selectionStylesF32[13] = def.edge.hoverStrength
        this.#selectionStylesF32[14] = def.face.dotSpacing
        this.#selectionStylesF32[15] = def.face.dotRadius
        this.#selectionStylesF32[16] = def.face.dotDarken
        this.#selectionStylesF32[17] = resolutionScale
        this.#writeBufferViewIfDirty(this.#uniformBuffers.selectionStyles, this.#selectionStylesF32, this.#selectionStylesCache)

        this.#selDataBuf.fill(0)
        for (const id of selectionState.selectedObjectIds) {
            this.#selDataBuf[id] = 1
        }
        this.#writeBufferViewIfDirty(this.#uniformBuffers.selectedObjectIds, this.#selDataBuf, this.#selectedIdsCache)

        this.#writeEdgesToBufferIfDirty(
            this.#uniformBuffers.selectedEdges,
            selectionState.selectedEdges,
            DEFAULT_SELECTION_STYLES.edge.lineWidthPx,
            DEFAULT_SELECTION_STYLES.edge.epsilon,
            this.#selectedEdgesCache,
        )
        this.#writeEdgesToBufferIfDirty(
            this.#uniformBuffers.hoveredEdge,
            selectionState.hoveredEdges,
            6.0,
            0.02,
            this.#hoveredEdgesCache,
        )

        const canvasTexture = outputTextureView ? null : this.#context.getCurrentTexture()
        const outlineTarget = outputTextureView ?? canvasTexture!.createView()
        const commandEncoder = this.#device.createCommandEncoder()

        if (viewSettings.beamEnabled && this.#beamPipeline) {
            if (this.#beamBindGroupInvalid) {
                this.#beamBindGroup = this.#device.createBindGroup({
                    label: "beamPrePass",
                    layout: this.#beamPipeline.getBindGroupLayout(0),
                    entries: [
                        { binding: 0, resource: { buffer: this.#uniformBuffers.camera } },
                        { binding: 1, resource: this.#tStartTextureView },
                        { binding: 3, resource: { buffer: this.#uniformBuffers.polygonVertices } },
                        { binding: 4, resource: { buffer: this.#uniformBuffers.nodeParams } },
                    ],
                })
                this.#beamBindGroupInvalid = false
            }
            const BEAM_TILE_SIZE = 8
            const tilesX = Math.ceil(sceneWidth / BEAM_TILE_SIZE)
            const tilesY = Math.ceil(sceneHeight / BEAM_TILE_SIZE)
            const beamPass = commandEncoder.beginComputePass({ label: "Beam Pre-Pass" })
            beamPass.setPipeline(this.#beamPipeline)
            beamPass.setBindGroup(0, this.#beamBindGroup!)
            beamPass.dispatchWorkgroups(Math.ceil(tilesX / 8), Math.ceil(tilesY / 8))
            beamPass.end()
        }

        const scenePass = commandEncoder.beginRenderPass({
            colorAttachments: [
                { view: this.#colorTextureView, loadOp: "clear", storeOp: "store" },
                { view: this.#idTextureView, loadOp: "clear", storeOp: "store", clearValue: { r: 0xFFFFFFFF, g: 0, b: 0, a: 0 } },
            ],
        })
        scenePass.setPipeline(this.#pipeline)
        scenePass.setBindGroup(0, this.#bindGroup!)
        scenePass.draw(4)
        scenePass.end()

        const outlinePass = commandEncoder.beginRenderPass({
            colorAttachments: [{ view: outlineTarget, loadOp: "clear", storeOp: "store" }],
        })
        outlinePass.setPipeline(this.#outlinePipeline)
        outlinePass.setBindGroup(0, this.#outlineBindGroup!)
        outlinePass.draw(4)
        outlinePass.end()

        this.#device.queue.submit([commandEncoder.finish()])
    }

    /**
     * Render from SAB-backed scratch storage. Reads directly from typed-array views
     * without rebuilding a full payload object. Use for the interactive preview hot path.
     */
    renderFromSharedBuffer(buffer: SharedArrayBuffer): void {
        this.#lastSharedBuffer = buffer
        this.#renderFromSAB(buffer)
    }

    #renderFromSAB(buffer: SharedArrayBuffer): void {
        const now = performance.now()
        if (this.#lastRenderTime > 0) {
            const delta = now - this.#lastRenderTime
            if (delta > 0) {
                this.#framerate.update(1000 / delta)
                this.#fpsFrameCount++
                const timeSinceFps = now - this.#lastFpsSendTime
                if (this.#fpsFrameCount >= 5 || timeSinceFps >= 100) {
                    this.#fpsFrameCount = 0
                    this.#lastFpsSendTime = now
                    this.#fpsVersion++
                    writeFps(buffer, this.#framerate.average, this.#fpsVersion)
                }
            }
        }
        this.#lastRenderTime = now

        const slot = getPublishedRenderSlot(buffer)
        const slotBase = getSlotByteOffset(slot)
        const L = SAB_LAYOUT
        const u32 = new Uint32Array(buffer)
        const f32 = new Float32Array(buffer)
        const b4 = slotBase / 4

        const resolutionScale = f32[b4 + L.O_RESOLUTION_SCALE / 4]
        const cameraRes0 = f32[b4 + L.O_CAMERA_RES / 4]
        const cameraRes1 = f32[b4 + L.O_CAMERA_RES / 4 + 1]
        const sceneWidth = Math.max(1, Math.round(cameraRes0 * resolutionScale))
        const sceneHeight = Math.max(1, Math.round(cameraRes1 * resolutionScale))

        if (!this.#pipeline) return
        if (sceneWidth === 0 || sceneHeight === 0) return
        if (this.#fullWidth <= 0 || this.#fullHeight <= 0) return

        const packed = u32[b4 + L.O_VIEW_SETTINGS / 4]
        this.#lastSelectionMode = (packed >> 2) & 7
        const beamEnabled = (packed & 2) !== 0

        this.#ensureRenderTextures(sceneWidth, sceneHeight)

        const viewTransform = new Float32Array(buffer, slotBase + L.O_VIEW_TRANSFORM, 16)
        const cameraPosition: [number, number, number] = [
            f32[b4 + L.O_CAMERA_POSITION / 4],
            f32[b4 + L.O_CAMERA_POSITION / 4 + 1],
            f32[b4 + L.O_CAMERA_POSITION / 4 + 2],
        ]
        const viewCenter: [number, number] = [f32[b4 + L.O_VIEW_CENTER / 4], f32[b4 + L.O_VIEW_CENTER / 4 + 1]]
        const psBase = b4 + L.O_PREVIEW_SHADING / 4
        const previewShading: PreviewShadingParams = {
            ambient: f32[psBase],
            diffuseWrap: f32[psBase + 1],
            keyWeight: f32[psBase + 2],
            fillWeight: f32[psBase + 3],
            rimWeight: f32[psBase + 4],
            backWeight: f32[psBase + 5],
            specIntensity: f32[psBase + 6],
            specShininess: f32[psBase + 7],
            fresnelPower: f32[psBase + 8],
            fresnelIntensity: f32[psBase + 9],
            aoStrength: f32[psBase + 10],
            aoRadius: f32[psBase + 11],
            aoSteps: f32[psBase + 12],
            aoBias: f32[psBase + 13],
        }
        this.#uploadCameraIfDirty(
            viewTransform,
            cameraPosition,
            sceneWidth,
            sceneHeight,
            f32[b4 + L.O_ZOOM / 4],
            viewCenter,
            previewShading,
        )

        this.#viewSettingsBuf[0] = (packed & 1) ? 1 : 0
        this.#viewSettingsBuf[1] = 0
        this.#viewSettingsBuf[2] = beamEnabled ? 1 : 0
        this.#viewSettingsBuf[3] = this.#lastSelectionMode
        this.#writeBufferViewIfDirty(this.#uniformBuffers.viewSettings, this.#viewSettingsBuf, this.#viewSettingsCache)

        this.#outlineU32[0] = (packed >> 5) & 3
        this.#outlineThicknessF32[0] = u32[b4 + L.O_OUTLINE_THICKNESS / 4]
        this.#outlineColorF32[0] = f32[b4 + L.O_OUTLINE_COLOR / 4]
        this.#outlineColorF32[1] = f32[b4 + L.O_OUTLINE_COLOR / 4 + 1]
        this.#outlineColorF32[2] = f32[b4 + L.O_OUTLINE_COLOR / 4 + 2]
        this.#outlineWidthF32[0] = this.#fullWidth
        const outline = DEFAULT_SELECTION_STYLES.outline
        new Float32Array(this.#outlineBuf, 32, 1)[0] = outline.dashSpacing
        new Float32Array(this.#outlineBuf, 36, 1)[0] = outline.dashLength
        new Float32Array(this.#outlineBuf, 40, 1)[0] = outline.dotSizeMin
        new Float32Array(this.#outlineBuf, 44, 1)[0] = outline.dotSpacingMultiplier
        this.#writeBufferViewIfDirty(this.#uniformBuffers.outlineSettings, new Uint8Array(this.#outlineBuf), this.#outlineCache)

        const def = DEFAULT_SELECTION_STYLES
        const so = L.O_SELECTION_STYLES / 4
        this.#selectionStylesF32[0] = f32[b4 + so]
        this.#selectionStylesF32[4] = f32[b4 + so + 1]
        this.#selectionStylesF32[5] = f32[b4 + so + 2]
        this.#selectionStylesF32[6] = f32[b4 + so + 3]
        this.#selectionStylesF32[8] = f32[b4 + so + 4]
        this.#selectionStylesF32[9] = f32[b4 + so + 5]
        this.#selectionStylesF32[10] = f32[b4 + so + 6]
        this.#selectionStylesF32[12] = def.edge.selectedStrength
        this.#selectionStylesF32[13] = def.edge.hoverStrength
        this.#selectionStylesF32[14] = def.face.dotSpacing
        this.#selectionStylesF32[15] = def.face.dotRadius
        this.#selectionStylesF32[16] = def.face.dotDarken
        this.#selectionStylesF32[17] = resolutionScale
        this.#writeBufferViewIfDirty(this.#uniformBuffers.selectionStyles, this.#selectionStylesF32, this.#selectionStylesCache)

        this.#writeBufferFromSABIfDirty(this.#uniformBuffers.selectedObjectIds, buffer, slotBase + L.O_SELECTED_OBJECT_IDS, L.SELECTED_OBJECT_IDS_SIZE, this.#selectedIdsCache)
        this.#writeBufferFromSABIfDirty(this.#uniformBuffers.selectedEdges, buffer, slotBase + L.O_SELECTED_EDGES_HEADER, L.SELECTED_EDGES_TOTAL, this.#selectedEdgesCache)
        this.#writeBufferFromSABIfDirty(this.#uniformBuffers.hoveredEdge, buffer, slotBase + L.O_HOVERED_EDGES_HEADER, L.SELECTED_EDGES_TOTAL, this.#hoveredEdgesCache)

        const canvasTexture = this.#context.getCurrentTexture()
        const outlineTarget = canvasTexture.createView()
        const commandEncoder = this.#device.createCommandEncoder()

        if (beamEnabled && this.#beamPipeline) {
            if (this.#beamBindGroupInvalid) {
                this.#beamBindGroup = this.#device.createBindGroup({
                    label: "beamPrePass",
                    layout: this.#beamPipeline.getBindGroupLayout(0),
                    entries: [
                        { binding: 0, resource: { buffer: this.#uniformBuffers.camera } },
                        { binding: 1, resource: this.#tStartTextureView },
                        { binding: 3, resource: { buffer: this.#uniformBuffers.polygonVertices } },
                        { binding: 4, resource: { buffer: this.#uniformBuffers.nodeParams } },
                    ],
                })
                this.#beamBindGroupInvalid = false
            }
            const BEAM_TILE_SIZE = 8
            const tilesX = Math.ceil(sceneWidth / BEAM_TILE_SIZE)
            const tilesY = Math.ceil(sceneHeight / BEAM_TILE_SIZE)
            const beamPass = commandEncoder.beginComputePass({ label: "Beam Pre-Pass" })
            beamPass.setPipeline(this.#beamPipeline)
            beamPass.setBindGroup(0, this.#beamBindGroup!)
            beamPass.dispatchWorkgroups(Math.ceil(tilesX / 8), Math.ceil(tilesY / 8))
            beamPass.end()
        }

        const scenePass = commandEncoder.beginRenderPass({
            colorAttachments: [
                { view: this.#colorTextureView, loadOp: "clear", storeOp: "store" },
                { view: this.#idTextureView, loadOp: "clear", storeOp: "store", clearValue: { r: 0xFFFFFFFF, g: 0, b: 0, a: 0 } },
            ],
        })
        scenePass.setPipeline(this.#pipeline)
        scenePass.setBindGroup(0, this.#bindGroup!)
        scenePass.draw(4)
        scenePass.end()

        const outlinePass = commandEncoder.beginRenderPass({
            colorAttachments: [{ view: outlineTarget, loadOp: "clear", storeOp: "store" }],
        })
        outlinePass.setPipeline(this.#outlinePipeline)
        outlinePass.setBindGroup(0, this.#outlineBindGroup!)
        outlinePass.draw(4)
        outlinePass.end()

        this.#device.queue.submit([commandEncoder.finish()])
    }

    async #renderFrameAndWait(): Promise<void> {
        if (!this.#lastRenderMsg || !this.#pipeline) return
        this.render(this.#lastRenderMsg)
        await this.#device.queue.onSubmittedWorkDone()
    }

    async handleRenderMesh(body: string, requestId?: number, documentName?: string, simplifyOnExport = true): Promise<void> {
        try {
            if (!this.#scene || this.#builtBody !== body) {
                await this.build(body, undefined)
            }
            const bounds = await this.#computeSceneBoundsRefined()
            if (!bounds) {
                self.postMessage({ type: "renderMeshResult", error: "Bounds compute found no inside samples; is the SDF empty or far from origin?", requestId, documentName })
                return
            }
            const voxelSizeMm = 0.5
            const pad = 3.2
            const minX = bounds.min[0] - pad
            const minY = bounds.min[1] - pad
            const minZ = bounds.min[2] - pad
            const maxX = bounds.max[0] + pad
            const maxY = bounds.max[1] + pad
            const maxZ = bounds.max[2] + pad
            const sizeX = Math.max(voxelSizeMm, maxX - minX)
            const sizeY = Math.max(voxelSizeMm, maxY - minY)
            const sizeZ = Math.max(voxelSizeMm, maxZ - minZ)
            const gridDimX = Math.max(2, Math.ceil(sizeX / voxelSizeMm) + 1)
            const gridDimY = Math.max(2, Math.ceil(sizeY / voxelSizeMm) + 1)
            const gridDimZ = Math.max(2, Math.ceil(sizeZ / voxelSizeMm) + 1)
            const params: MDCParams = {
                gridDimX,
                gridDimY,
                gridDimZ,
                isoValue: 0.0,
                gridOffsetX: minX,
                gridOffsetY: minY,
                gridOffsetZ: minZ,
                voxelSize: voxelSizeMm,
                ...(simplifyOnExport && {
                    simplifyTargetRatio: 0.1,
                    simplifyRegularize: false,
                    simplifyLockBorder: true,
                    simplifyPrune: false,
                    simplifySparse: false,
                    simplifyTargetError: 0.001,
                }),
            }
            const scene = this.#scene!
            const sceneAux = scene.compileAux()
            const sceneAuxFast = scene.compileAuxFast()
            const sceneAuxMid = scene.compileAuxMid()
            const sceneSDF = scene.compile()
            const sceneSDF_fast = scene.compileFast()
            const sceneSDF_mid = scene.compileMid()
            const sceneEdgeHelpers = scene.compileEdgeHelpers()
            const shaderCompiler = new ShaderCompiler(this.#device)
                .replace("insert", "sceneAuxFast", sceneAuxFast)
                .replace("insert", "sceneAux", sceneAux)
                .replace("insert", "sceneAuxMid", sceneAuxMid)
                .replace("insert", "sceneSDF_fast", sceneSDF_fast)
                .replace("insert", "sceneSDF", sceneSDF)
                .replace("insert", "sceneSDF_mid", sceneSDF_mid)
                .replace("insert", "sceneEdgeHelpers", sceneEdgeHelpers)
            const mdcShaderModule = shaderCompiler.compile(mdcShader, "MDC Export")
            const mdc = new MDCExport(
                this.#helper,
                params,
                this.#uniformBuffers.polygonVertices,
                this.#uniformBuffers.faceSelection,
                this.#uniformBuffers.nodeParams,
            )
            const mesh = await mdc.export(mdcShaderModule)
            self.postMessage({ type: "renderMeshResult", mesh, requestId, documentName }, { transfer: [mesh.verts.buffer, mesh.tris.buffer] })
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err)
            self.postMessage({ type: "renderMeshResult", error: errorMsg, requestId, documentName })
        }
    }

    async #computeSceneBounds(searchMin: [number, number, number], searchMax: [number, number, number], stepMm: number): Promise<{ min: readonly [number, number, number]; max: readonly [number, number, number] } | null> {
        const SCALE = 1000
        const dimsX = Math.max(1, Math.ceil((searchMax[0] - searchMin[0]) / stepMm) + 1)
        const dimsY = Math.max(1, Math.ceil((searchMax[1] - searchMin[1]) / stepMm) + 1)
        const dimsZ = Math.max(1, Math.ceil((searchMax[2] - searchMin[2]) / stepMm) + 1)
        const uniformsData = new ArrayBuffer(80)
        new Float32Array(uniformsData, 0, 4).set([searchMin[0], searchMin[1], searchMin[2], stepMm])
        new Float32Array(uniformsData, 16, 4).set([searchMax[0], searchMax[1], searchMax[2], 0.0])
        new Uint32Array(uniformsData, 32, 4).set([dimsX >>> 0, dimsY >>> 0, dimsZ >>> 0, 0])
        new Float32Array(uniformsData, 48, 1).set([SCALE])
        const uniformBuffer = this.#device.createBuffer({
            size: 80,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "BoundsUniforms",
        })
        this.#device.queue.writeBuffer(uniformBuffer, 0, uniformsData)
        const TILE_STRIDE_BYTES = 48
        const totalSamples = dimsX * dimsY * dimsZ
        const totalWorkgroups = Math.ceil(totalSamples / 256)
        const dispatchX = Math.min(totalWorkgroups, 65535)
        const dispatchY = Math.ceil(totalWorkgroups / dispatchX)
        const dispatchedWorkgroups = dispatchX * dispatchY
        const outBuffer = this.#device.createBuffer({
            size: dispatchedWorkgroups * TILE_STRIDE_BYTES,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
            label: "BoundsOut",
        })
        const scene = this.#scene!
        const sceneAux = scene.compileAux()
        const sceneAuxFast = scene.compileAuxFast()
        const sceneSDF_fast = scene.compileFast()
        const sceneEdgeHelpers = scene.compileEdgeHelpers()
        const shaderCompiler = new ShaderCompiler(this.#device)
            .replace("insert", "sceneAuxFast", sceneAuxFast)
            .replace("insert", "sceneAux", sceneAux)
            .replace("insert", "sceneSDF_fast", sceneSDF_fast)
            .replace("insert", "sceneEdgeHelpers", sceneEdgeHelpers)
        let boundsShaderModule: GPUShaderModule | undefined
        let boundsPipeline: GPUComputePipeline | undefined
        let bindGroup: GPUBindGroup | undefined
        try {
            boundsShaderModule = shaderCompiler.compile(boundsShader, "Bounds")
            boundsPipeline = this.#device.createComputePipeline({
                layout: "auto",
                compute: { module: boundsShaderModule, entryPoint: "computeBounds" },
            })
            const layout = boundsPipeline.getBindGroupLayout(0)
            bindGroup = this.#device.createBindGroup({
                layout,
                entries: [
                    { binding: 0, resource: { buffer: uniformBuffer } },
                    { binding: 1, resource: { buffer: outBuffer } },
                    { binding: 3, resource: { buffer: this.#uniformBuffers.polygonVertices } },
                    { binding: 4, resource: { buffer: this.#uniformBuffers.faceSelection } },
                    { binding: 5, resource: { buffer: this.#uniformBuffers.nodeParams } },
                    { binding: 99, resource: { buffer: this.#uniformBuffers.selectedObjectIds } },
                ],
            })
            const encoder = this.#device.createCommandEncoder()
            const pass = encoder.beginComputePass()
            pass.setPipeline(boundsPipeline)
            pass.setBindGroup(0, bindGroup)
            pass.dispatchWorkgroups(dispatchedWorkgroups)
            pass.end()
            this.#device.queue.submit([encoder.finish()])
            await this.#device.queue.onSubmittedWorkDone()
            const readback = await this.#helper.readBufferData(outBuffer, dispatchedWorkgroups * TILE_STRIDE_BYTES)
            const dv = new DataView(readback)
            let any = false
            let minXq = 2147483647
            let minYq = 2147483647
            let minZq = 2147483647
            let maxXq = -2147483648
            let maxYq = -2147483648
            let maxZq = -2147483648
            for (let t = 0; t < dispatchedWorkgroups; t++) {
                const base = t * TILE_STRIDE_BYTES
                const anyInside = dv.getUint32(base + 32, true)
                if (!anyInside) continue
                any = true
                const txMinX = dv.getInt32(base + 0, true)
                const txMinY = dv.getInt32(base + 4, true)
                const txMinZ = dv.getInt32(base + 8, true)
                const txMaxX = dv.getInt32(base + 16, true)
                const txMaxY = dv.getInt32(base + 20, true)
                const txMaxZ = dv.getInt32(base + 24, true)
                if (txMinX < minXq) minXq = txMinX
                if (txMinY < minYq) minYq = txMinY
                if (txMinZ < minZq) minZq = txMinZ
                if (txMaxX > maxXq) maxXq = txMaxX
                if (txMaxY > maxYq) maxYq = txMaxY
                if (txMaxZ > maxZq) maxZq = txMaxZ
            }
            if (!any) return null
            return {
                min: [minXq / SCALE, minYq / SCALE, minZq / SCALE] as const,
                max: [maxXq / SCALE, maxYq / SCALE, maxZq / SCALE] as const,
            }
        } finally {
            // Shader module, pipeline, bind group: no destroy(); locals go out of scope. Buffers we allocated:
            uniformBuffer.destroy()
            outBuffer.destroy()
        }
    }

    async #computeSceneBoundsRefined(): Promise<{ min: readonly [number, number, number]; max: readonly [number, number, number] } | null> {
        const COARSE_HALF = 250
        const coarse = await this.#computeSceneBounds([-COARSE_HALF, -COARSE_HALF, -COARSE_HALF], [COARSE_HALF, COARSE_HALF, COARSE_HALF], 2.0)
        if (!coarse) return null
        const inflate = 4.0
        const min = [coarse.min[0] - inflate, coarse.min[1] - inflate, coarse.min[2] - inflate] as const
        const max = [coarse.max[0] + inflate, coarse.max[1] + inflate, coarse.max[2] + inflate] as const
        const refined = await this.#computeSceneBounds([min[0], min[1], min[2]], [max[0], max[1], max[2]], 0.5)
        return refined ?? coarse
    }

    async handleBenchmark(frameCount: number, waitForGPU: boolean, requestId?: number): Promise<void> {
        if (!this.#pipeline) {
            self.postMessage({ type: "benchmarkResult", result: { totalTime: 0, averageFrameTime: 0, minFrameTime: 0, maxFrameTime: 0, framesPerSecond: 0, frameTimes: [], error: "Cannot benchmark: renderer not initialized. Call build() first." }, requestId })
            return
        }
        const frameTimes: number[] = []
        const startTime = performance.now()
        if (waitForGPU) {
            await this.#renderFrameAndWait()
        }
        for (let i = 0; i < frameCount; i++) {
            const frameStart = performance.now()
            if (waitForGPU) {
                await this.#renderFrameAndWait()
            } else {
                if (this.#lastRenderMsg) this.render(this.#lastRenderMsg)
            }
            frameTimes.push(performance.now() - frameStart)
        }
        const totalTime = performance.now() - startTime
        const n = frameTimes.length
        const averageFrameTime = n > 0 ? totalTime / n : 0
        const minFrameTime = n > 0 ? Math.min(...frameTimes) : 0
        const maxFrameTime = n > 0 ? Math.max(...frameTimes) : 0
        const framesPerSecond = totalTime > 0 ? (n / totalTime) * 1000 : 0
        self.postMessage({
            type: "benchmarkResult",
            result: { totalTime, averageFrameTime, minFrameTime, maxFrameTime, framesPerSecond, frameTimes },
            requestId,
        })
    }

    async handleThumbnail(body: string, width?: number, height?: number, requestId?: number, documentName?: string): Promise<void> {
        const thumbWidth = Math.max(1, Math.min(512, width ?? 256))
        const thumbHeight = Math.max(1, Math.min(512, height ?? 256))
        const previousBody = this.#builtBody
        let builtForThisThumb = false
        try {
            if (!this.#device) {
                self.postMessage({ type: "thumbnailResult", error: "WebGPU device unavailable", requestId, documentName })
                return
            }
            if (!this.#scene || this.#builtBody !== body) {
                await this.build(body, undefined)
                builtForThisThumb = true
            }
            if (!this.#pipeline) {
                self.postMessage({ type: "thumbnailResult", error: "Scene failed to build", requestId, documentName })
                return
            }
            const eye = vec3(30, 25, 30)
            const center = vec3(0, 0, 0)
            const up = vec3(0, 1, 0)
            const viewMatrix = lookAt(eye, center, up)
            const thumbMsg: Extract<MainToWorkerMessage, { type: "render" }> = {
                type: "render",
                cameraState: { rotation: [1, 0, 0, 0], zoom: 50, translation: vec3(0, 0, 0) },
                viewTransform: viewMatrix.data,
                cameraPosition: [eye.x, eye.y, eye.z],
                cameraRes: [thumbWidth, thumbHeight],
                selectionState: {
                    selectedObjectIds: [],
                    selectedEdges: [],
                    hoveredObjectId: 0,
                    hoveredEdges: [],
                },
                viewSettings: {
                    xrayMode: false,
                    beamEnabled: false,
                    selectionMode: 0,
                    outlineMode: 0,
                    outlineThickness: 1,
                    outlineColor: [1, 1, 0],
                    selectionStyles: {
                        face: { darken: DEFAULT_SELECTION_STYLES.face.darken, tint: [...DEFAULT_SELECTION_STYLES.face.tint] },
                        edge: { color: [...DEFAULT_SELECTION_STYLES.edge.color] },
                    },
                    previewShading: DEFAULT_PREVIEW_SHADING,
                },
                viewCenter: [0.5, 0.5],
                resolutionScale: 1.0,
            }
            let thumbOutputTexture: GPUTexture | undefined
            let readbackBuffer: GPUBuffer | undefined
            let readbackMapped = false
            try {
                thumbOutputTexture = this.#device.createTexture({
                    label: "ThumbnailOutput",
                    size: [thumbWidth, thumbHeight],
                    format: this.#format,
                    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
                })
                this.render(thumbMsg, thumbOutputTexture.createView())
                await this.#device.queue.onSubmittedWorkDone()
                const bytesPerRow = Math.ceil((thumbWidth * 4) / 256) * 256
                const bufferSize = bytesPerRow * thumbHeight
                readbackBuffer = this.#device.createBuffer({
                    label: "ThumbnailReadback",
                    size: bufferSize,
                    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
                })
                const encoder = this.#device.createCommandEncoder()
                encoder.copyTextureToBuffer(
                    { texture: thumbOutputTexture },
                    { buffer: readbackBuffer, bytesPerRow, rowsPerImage: thumbHeight },
                    [thumbWidth, thumbHeight, 1],
                )
                this.#device.queue.submit([encoder.finish()])
                await readbackBuffer.mapAsync(GPUMapMode.READ)
                readbackMapped = true
                const mapped = new Uint8Array(readbackBuffer.getMappedRange())
                const imageData = new ImageData(thumbWidth, thumbHeight)
                const isBgra = this.#format.includes("bgra")
                for (let y = 0; y < thumbHeight; y++) {
                    const srcRow = y * bytesPerRow
                    const dstRow = y * thumbWidth * 4
                    for (let x = 0; x < thumbWidth; x++) {
                        const srcOff = srcRow + x * 4
                        const dstOff = dstRow + x * 4
                        if (isBgra) {
                            imageData.data[dstOff + 0] = mapped[srcOff + 2]
                            imageData.data[dstOff + 1] = mapped[srcOff + 1]
                            imageData.data[dstOff + 2] = mapped[srcOff + 0]
                            imageData.data[dstOff + 3] = mapped[srcOff + 3]
                        } else {
                            imageData.data[dstOff + 0] = mapped[srcOff + 0]
                            imageData.data[dstOff + 1] = mapped[srcOff + 1]
                            imageData.data[dstOff + 2] = mapped[srcOff + 2]
                            imageData.data[dstOff + 3] = mapped[srcOff + 3]
                        }
                    }
                }
                self.postMessage({ type: "thumbnailResult", imageData, requestId, documentName }, { transfer: [imageData.data.buffer] })
            } finally {
                if (readbackMapped) {
                    try {
                        readbackBuffer?.unmap()
                    } catch {
                        /* ignore */
                    }
                }
                readbackBuffer?.destroy()
                thumbOutputTexture?.destroy()
            }
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err)
            self.postMessage({ type: "thumbnailResult", error: errorMsg, requestId, documentName })
        } finally {
            // Thumbnails call build() directly (not the render worker queue). If the user opens a document
            // while welcome thumbnails are still loading, a later thumb can overwrite the preview pipeline.
            // Restore whatever scene was current before this thumbnail when we actually switched bodies.
            if (
                builtForThisThumb &&
                previousBody !== null &&
                previousBody !== body &&
                this.#builtBody === body
            ) {
                try {
                    await this.build(previousBody, undefined)
                } catch {
                    // Ignore: preview may rebuild on next main-thread build()
                }
            }
        }
    }

    #ensureRenderTextures(width: number, height: number): void {
        const w = Math.max(1, width)
        const h = Math.max(1, height)
        const dimensionsChanged = w !== this.#renderTextureWidth || h !== this.#renderTextureHeight
        if (!dimensionsChanged && !this.#sceneBindGroupInvalid) return

        if (dimensionsChanged) {
            // Bind groups: no destroy(); clear refs before attaching new textures.
            this.#outlineBindGroup = undefined
            this.#beamBindGroup = undefined

            if (this.#colorTexture) this.#colorTexture.destroy()
            if (this.#idTexture) this.#idTexture.destroy()
            if (this.#tStartTexture) this.#tStartTexture.destroy()

            this.#colorTexture = this.#device.createTexture({
                label: "Preview Color",
                size: [w, h],
                format: this.#format,
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            })
            this.#idTexture = this.#device.createTexture({
                label: "Object ID",
                size: [w, h],
                format: "r32uint",
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            })
            this.#colorTextureView = this.#colorTexture.createView()
            this.#idTextureView = this.#idTexture.createView()

            const BEAM_TILE_SIZE = 8
            const tilesX = Math.ceil(w / BEAM_TILE_SIZE)
            const tilesY = Math.ceil(h / BEAM_TILE_SIZE)
            this.#tStartTexture = this.#device.createTexture({
                label: "Beam t_start",
                size: [tilesX, tilesY],
                format: "r32float",
                usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
            })
            this.#tStartTextureView = this.#tStartTexture.createView()

            this.#outlineBindGroup = this.#device.createBindGroup({
                label: "outlinePostProcess",
                layout: this.#outlinePipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: this.#colorTextureView },
                    { binding: 1, resource: this.#idTextureView },
                    { binding: 2, resource: { buffer: this.#uniformBuffers.selectedObjectIds } },
                    { binding: 3, resource: { buffer: this.#uniformBuffers.outlineSettings } },
                    { binding: 4, resource: this.#colorSampler },
                ],
            })

            if (this.#beamPipeline) {
                this.#beamBindGroup = this.#device.createBindGroup({
                    label: "beamPrePass",
                    layout: this.#beamPipeline.getBindGroupLayout(0),
                    entries: [
                        { binding: 0, resource: { buffer: this.#uniformBuffers.camera } },
                        { binding: 1, resource: this.#tStartTextureView },
                        { binding: 3, resource: { buffer: this.#uniformBuffers.polygonVertices } },
                        { binding: 4, resource: { buffer: this.#uniformBuffers.nodeParams } },
                    ],
                })
                this.#beamBindGroupInvalid = false
            }

            this.#renderTextureWidth = w
            this.#renderTextureHeight = h
        }

        if (dimensionsChanged || this.#sceneBindGroupInvalid) {
            // Previous #bindGroup is dropped here (no destroy() on GPUBindGroup).
            this.#bindGroup = this.#device.createBindGroup({
                label: "scenePreview",
                layout: this.#pipeline!.getBindGroupLayout(0),
                entries: [
                    { binding: 1, resource: { buffer: this.#uniformBuffers.camera } },
                    { binding: 2, resource: { buffer: this.#uniformBuffers.clickState } },
                    { binding: 3, resource: { buffer: this.#uniformBuffers.clickedObjectId } },
                    { binding: 4, resource: { buffer: this.#uniformBuffers.selectedObjectIds } },
                    { binding: 5, resource: { buffer: this.#uniformBuffers.colorPalette } },
                    { binding: 6, resource: { buffer: this.#uniformBuffers.viewSettings } },
                    { binding: 7, resource: this.#tStartTextureView },
                    { binding: 9, resource: { buffer: this.#uniformBuffers.polygonVertices } },
                    { binding: 10, resource: { buffer: this.#uniformBuffers.clickedHitPos } },
                    { binding: 11, resource: { buffer: this.#uniformBuffers.faceSelection } },
                    { binding: 12, resource: { buffer: this.#uniformBuffers.nodeParams } },
                    { binding: 13, resource: { buffer: this.#uniformBuffers.edgeHit } },
                    { binding: 14, resource: { buffer: this.#uniformBuffers.selectedEdges } },
                    { binding: 15, resource: { buffer: this.#uniformBuffers.hoverEdgeHit } },
                    { binding: 16, resource: { buffer: this.#uniformBuffers.hoveredEdge } },
                    { binding: 17, resource: { buffer: this.#uniformBuffers.clickedNormal } },
                    { binding: 18, resource: { buffer: this.#uniformBuffers.selectionStyles } },
                ],
            })
            this.#sceneBindGroupInvalid = false
        }
    }

    #createBuffers(): void {
        const ub = this.#uniformBuffers
        ub.scene = this.#device.createBuffer({
            size: 16384,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
            label: "scene",
        })

        this.#exportBuffers.scene = this.#device.createBuffer({
            size: 16384,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "scene",
        })

        ub.camera = this.#device.createBuffer({
            size: 240,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "camera",
        })

        ub.clickState = this.#device.createBuffer({
            size: 32,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "clickState",
        })

        ub.clickedObjectId = this.#device.createBuffer({
            size: 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            label: "clickedObjectId",
        })

        ub.selectedObjectIds = this.#device.createBuffer({
            size: 4096,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            label: "selectedObjectIds",
        })

        ub.colorPalette = this.#device.createBuffer({
            size: PALETTE_SIZE * 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "colorPalette",
        })

        const paletteData = paletteToFloat32Array(DEFAULT_PALETTE)
        const alignedData = new Float32Array(PALETTE_SIZE * 4)
        for (let i = 0; i < PALETTE_SIZE; i++) {
            alignedData[i * 4] = paletteData[i * 3]
            alignedData[i * 4 + 1] = paletteData[i * 3 + 1]
            alignedData[i * 4 + 2] = paletteData[i * 3 + 2]
            alignedData[i * 4 + 3] = 0.0
        }
        this.#device.queue.writeBuffer(ub.colorPalette, 0, alignedData)

        ub.viewSettings = this.#device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "viewSettings",
        })

        ub.outlineSettings = this.#device.createBuffer({
            size: 48,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "outlineSettings",
        })

        ub.selectionStyles = this.#device.createBuffer({
            size: 80,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "selectionStyles",
        })

        ub.polygonVertices = this.#device.createBuffer({
            size: POLYGON_VERTEX_BUFFER_SIZE,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            label: "polygonVertices",
        })

        ub.clickedHitPos = this.#device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            label: "clickedHitPos",
        })

        ub.clickedNormal = this.#device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            label: "clickedNormal",
        })

        ub.faceSelection = this.#device.createBuffer({
            size: 20,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "faceSelection",
        })

        ub.nodeParams = this.#device.createBuffer({
            size: NODE_PARAMS_BUFFER_SIZE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "nodeParams",
        })

        ub.edgeHit = this.#device.createBuffer({
            size: EDGE_HITS_SIZE,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            label: "edgeHit",
        })
        ub.selectedEdges = this.#device.createBuffer({
            size: SELECTED_EDGES_TOTAL,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            label: "selectedEdges",
        })
        ub.hoverEdgeHit = this.#device.createBuffer({
            size: EDGE_HITS_SIZE,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            label: "hoverEdgeHit",
        })
        ub.hoveredEdge = this.#device.createBuffer({
            size: SELECTED_EDGES_TOTAL,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            label: "hoveredEdge",
        })
    }

    #writeClickState(clickUV: [number, number], enableClick: boolean, enableHover: boolean, hoverUV?: [number, number]): void {
        const clickData = new ArrayBuffer(32)
        const clickF32 = new Float32Array(clickData)
        const clickU32 = new Uint32Array(clickData)
        clickF32[0] = clickUV[0]
        clickF32[1] = clickUV[1]
        clickU32[2] = enableClick ? 1 : 0
        clickU32[3] = enableHover ? 1 : 0
        clickF32[4] = hoverUV?.[0] ?? 0
        clickF32[5] = hoverUV?.[1] ?? 0
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickState, 0, clickData)
    }

    async #readClickResult(): Promise<{ clickedId: number; edgeHits: import("./render-worker-protocol.mjs").EdgeHitData[]; hitPos: [number, number, number, number]; clickedNormal: [number, number, number] }> {
        const [idBuf, edgeBuf, hitBuf, normalBuf] = await Promise.all([
            this.#helper.readBufferData(this.#uniformBuffers.clickedObjectId, 4),
            this.#helper.readBufferData(this.#uniformBuffers.edgeHit, 320),
            this.#helper.readBufferData(this.#uniformBuffers.clickedHitPos, 16),
            this.#helper.readBufferData(this.#uniformBuffers.clickedNormal, 16),
        ])
        const clickedId = new Uint32Array(idBuf)[0] ?? 0
        const u32 = new Uint32Array(edgeBuf)
        const f32 = new Float32Array(edgeBuf)
        const edgeHits: import("./render-worker-protocol.mjs").EdgeHitData[] = []
        const STRIDE = 20
        for (let slot = 0; slot < 4; slot++) {
            const o = slot * STRIDE
            const kind = u32[o]
            if (kind === EdgeKind.None) continue
            edgeHits.push({
                kind,
                primaryId: u32[o + 1],
                secondaryId: u32[o + 2],
                featureA: u32[o + 3],
                opType: u32[o + 4],
                objectId: u32[o + 5],
                seedPoint: [f32[o + 8], f32[o + 9], f32[o + 10]],
                seedTangent: [f32[o + 12], f32[o + 13], f32[o + 14]],
                seedNormal: [f32[o + 16], f32[o + 17], f32[o + 18]],
            })
        }
        const hitF32 = new Float32Array(hitBuf)
        const hitPos: [number, number, number, number] = [hitF32[0], hitF32[1], hitF32[2], hitF32[3]]
        const normF32 = new Float32Array(normalBuf)
        const clickedNormal: [number, number, number] = [normF32[0], normF32[1], normF32[2]]
        return { clickedId, edgeHits, hitPos, clickedNormal }
    }

    async #readHoverResult(): Promise<{ hoveredObjectId: number; hoveredEdges: SelectedEdgePayload[] }> {
        const readback = await this.#helper.readBufferData(this.#uniformBuffers.hoverEdgeHit, 320)
        const u32 = new Uint32Array(readback)
        const f32 = new Float32Array(readback)
        const edges: SelectedEdgePayload[] = []
        let hoveredObjectId = 0
        const STRIDE = 20
        for (let slot = 0; slot < 4; slot++) {
            const o = slot * STRIDE
            const kind = u32[o]
            const objectId = u32[o + 5]
            if (kind === EdgeKind.None && objectId === 0) continue
            hoveredObjectId = objectId
            if (kind !== EdgeKind.None) {
                edges.push({
                    kind,
                    primaryId: u32[o + 1],
                    secondaryId: u32[o + 2],
                    featureA: u32[o + 3],
                    opType: u32[o + 4],
                    lineWidthPx: 6.0,
                    epsilon: 0.02,
                    seedPoint: [f32[o + 8], f32[o + 9], f32[o + 10]],
                    seedTangent: [f32[o + 12], f32[o + 13], f32[o + 14]],
                    seedNormal: [f32[o + 16], f32[o + 17], f32[o + 18]],
                })
            }
        }
        return { hoveredObjectId, hoveredEdges: edges }
    }

    async handleClick(clickUV: [number, number], shiftKey: boolean, altKey: boolean, documentName?: string, sab?: SharedArrayBuffer): Promise<void> {
        if (!this.#pipeline) return
        if (!sab && !this.#lastRenderMsg) return
        this.#writeClickState(clickUV, true, false)
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickedObjectId, 0, new Uint32Array([0]))
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickedHitPos, 0, new Float32Array(4).buffer)
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickedNormal, 0, new Float32Array(4).buffer)
        this.#device.queue.writeBuffer(this.#uniformBuffers.edgeHit, 0, new ArrayBuffer(320))

        if (sab) this.#renderFromSAB(sab)
        else this.render(this.#lastRenderMsg!)
        const result = await this.#readClickResult()
        self.postMessage({
            type: "clickResult",
            clickedId: result.clickedId,
            edgeHits: result.edgeHits,
            hitPos: result.hitPos,
            clickedNormal: result.clickedNormal,
            shiftKey,
            altKey,
            documentName,
        })
    }

    async handleHover(clickUV: [number, number], altKey: boolean, documentName?: string, hoverRequestId?: number, sab?: SharedArrayBuffer): Promise<void> {
        if (!this.#pipeline) return
        if (!sab && !this.#lastRenderMsg) return
        this.#writeClickState(clickUV, false, true, clickUV)
        this.#device.queue.writeBuffer(this.#uniformBuffers.hoverEdgeHit, 0, new ArrayBuffer(320))

        if (sab) {
            this.#renderFromSAB(sab)
        } else {
            this.render(this.#lastRenderMsg!)
        }
        const selectionMode = sab
            ? (new Uint32Array(sab)[(getSlotByteOffset(getPublishedRenderSlot(sab)) + SAB_LAYOUT.O_VIEW_SETTINGS) / 4] >> 2) & 7
            : this.#lastSelectionMode
        const effectiveMode = altKey && selectionMode === 0 ? 1 : selectionMode

        const { hoveredObjectId, hoveredEdges } = await this.#readHoverResult()
        let edges: SelectedEdgePayload[] = []
        if (effectiveMode === 1) {
            edges = hoveredEdges.filter(h => h.kind === EdgeKind.Seam)
        } else if (effectiveMode === 2) {
            edges = hoveredEdges.filter(h => h.kind === EdgeKind.Primitive || h.kind === EdgeKind.SeamSegment)
        }

        const selectionState = sab ? readSelectionStateFromSAB(sab) : this.#lastRenderMsg!.selectionState
        const objects = selectionState.selectedObjectIds
        const objectNames: Record<number, string> = {}
        if (this.#scene) {
            const ids = new Set([...objects, hoveredObjectId].filter(id => id > 0))
            for (const id of ids) {
                const node = this.#scene.get(id)
                objectNames[id] = node?.getShapeType?.() ?? "?"
            }
        }
        const info: SelectionInfo = {
            objects,
            objectNames,
            edges: selectionState.selectedEdges.map(e => ({
                kind: e.kind,
                primaryId: e.primaryId,
                secondaryId: e.secondaryId,
                featureA: e.featureA,
                opType: e.opType,
            })),
            face: null,
            hover: hoveredObjectId > 0 ? {
                objectId: hoveredObjectId,
                edges: edges.map(e => ({
                    kind: e.kind,
                    primaryId: e.primaryId,
                    secondaryId: e.secondaryId,
                    featureA: e.featureA,
                    opType: e.opType,
                    seedPoint: e.seedPoint,
                    seedTangent: e.seedTangent,
                    seedNormal: e.seedNormal,
                })),
            } : null,
        }
        self.postMessage({ type: "selectionInfo", info, documentName, hoverRequestId })
    }

    async handlePickObject(clickUV: [number, number], requestId: number, sab?: SharedArrayBuffer): Promise<void> {
        if (!this.#pipeline) {
            self.postMessage({ type: "pickObjectResult", objectId: 0, requestId })
            return
        }
        if (!sab && !this.#lastRenderMsg) {
            self.postMessage({ type: "pickObjectResult", objectId: 0, requestId })
            return
        }
        this.#writeClickState(clickUV, false, true, clickUV)
        this.#device.queue.writeBuffer(this.#uniformBuffers.hoverEdgeHit, 0, new ArrayBuffer(320))
        if (sab) this.#renderFromSAB(sab)
        else this.render(this.#lastRenderMsg!)
        const { hoveredObjectId } = await this.#readHoverResult()
        self.postMessage({ type: "pickObjectResult", objectId: hoveredObjectId, requestId })
    }

    async handleDoubleClick(clickUV: [number, number], documentName?: string, sab?: SharedArrayBuffer): Promise<void> {
        if (!this.#pipeline) return
        if (!sab && !this.#lastRenderMsg) return
        this.#writeClickState(clickUV, true, false)
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickedObjectId, 0, new Uint32Array([0]))
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickedHitPos, 0, new Float32Array(4).buffer)
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickedNormal, 0, new Float32Array(4).buffer)
        this.#device.queue.writeBuffer(this.#uniformBuffers.edgeHit, 0, new ArrayBuffer(320))

        if (sab) this.#renderFromSAB(sab)
        else this.render(this.#lastRenderMsg!)
        const result = await this.#readClickResult()
        if (result.clickedId !== 0) {
            self.postMessage({
                type: "objectDoubleClick",
                nodeId: result.clickedId,
                hitPos: [result.hitPos[0], result.hitPos[1], result.hitPos[2]],
                documentName,
            })
        }
    }

    async handlePickPos(clickUV: [number, number], requestId: number, sab?: SharedArrayBuffer): Promise<void> {
        if (!this.#pipeline) {
            self.postMessage({ type: "pickPosResult", hitPos: null, requestId })
            return
        }
        if (!sab && !this.#lastRenderMsg) {
            self.postMessage({ type: "pickPosResult", hitPos: null, requestId })
            return
        }
        this.#writeClickState(clickUV, true, false)
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickedObjectId, 0, new Uint32Array([0]))
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickedHitPos, 0, new Float32Array(4).buffer)
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickedNormal, 0, new Float32Array(4).buffer)
        this.#device.queue.writeBuffer(this.#uniformBuffers.edgeHit, 0, new ArrayBuffer(320))
        if (sab) this.#renderFromSAB(sab)
        else this.render(this.#lastRenderMsg!)
        const result = await this.#readClickResult()
        // hitPos[3] is the ray travel distance t; 0 means no hit
        const hasHit = result.hitPos[3] > 0
        self.postMessage({
            type: "pickPosResult",
            hitPos: hasHit ? [result.hitPos[0], result.hitPos[1], result.hitPos[2]] : null,
            requestId,
        })
    }

    writeBuffers(msg: Extract<MainToWorkerMessage, { type: "writeBuffers" }>): void {
        if (msg.faceSelection) {
            this.#device.queue.writeBuffer(this.#uniformBuffers.faceSelection, 0, msg.faceSelection)
        }
        if (msg.polygonVertices) {
            this.#device.queue.writeBuffer(
                this.#uniformBuffers.polygonVertices,
                msg.polygonVertices.offset,
                msg.polygonVertices.data,
            )
        }
        if (msg.nodeParams) {
            this.#device.queue.writeBuffer(
                this.#uniformBuffers.nodeParams,
                msg.nodeParams.nodeId * 16,
                msg.nodeParams.data,
            )
        }
        if (msg.selectedObjectIds) {
            if (msg.selectedObjectIds instanceof ArrayBuffer) {
                this.#device.queue.writeBuffer(this.#uniformBuffers.selectedObjectIds, 0, msg.selectedObjectIds)
                new Uint8Array(this.#selectedIdsCache).set(new Uint8Array(msg.selectedObjectIds))
            } else {
                this.#device.queue.writeBuffer(
                    this.#uniformBuffers.selectedObjectIds,
                    msg.selectedObjectIds.offset,
                    msg.selectedObjectIds.data,
                )
                new Uint8Array(this.#selectedIdsCache, msg.selectedObjectIds.offset, msg.selectedObjectIds.data.byteLength).set(
                    new Uint8Array(msg.selectedObjectIds.data),
                )
            }
        }
        if (msg.colorPalette) {
            this.#device.queue.writeBuffer(this.#uniformBuffers.colorPalette, 0, msg.colorPalette)
        }
    }

    /** Build full 240-byte camera uniform and upload if dirty. */
    #uploadCameraIfDirty(
        viewTransform: Float32Array | ArrayBuffer,
        cameraPosition: [number, number, number],
        sceneWidth: number,
        sceneHeight: number,
        zoom: number,
        viewCenter: [number, number],
        previewShading: PreviewShadingParams,
    ): void {
        this.#camTransform.data.set(viewTransform instanceof Float32Array ? viewTransform : new Float32Array(viewTransform))
        const v1 = this.#camTransform.transformVector(vec3(0.5, 0.6, 1.0).normalize())
        const v2 = this.#camTransform.transformVector(vec3(-0.6, 0.3, 0.8).normalize())
        const v3 = this.#camTransform.transformVector(vec3(0.1, -0.5, 0.9).normalize())
        const v4 = this.#camTransform.transformVector(vec3(-0.2, 0.2, 1.0).normalize())
        const ld = this.#lightDirBuf
        ld[0] = v1.x; ld[1] = v1.y; ld[2] = v1.z; ld[3] = 0
        ld[4] = v2.x; ld[5] = v2.y; ld[6] = v2.z; ld[7] = 0
        ld[8] = v3.x; ld[9] = v3.y; ld[10] = v3.z; ld[11] = 0
        const staging = new Uint8Array(this.#cameraStagingBuf)
        const f32 = new Float32Array(this.#cameraStagingBuf)
        const viewF32 = viewTransform instanceof Float32Array ? viewTransform : new Float32Array(viewTransform)
        staging.set(new Uint8Array(viewF32.buffer, viewF32.byteOffset, 64), 0)
        f32[16] = cameraPosition[0]
        f32[17] = cameraPosition[1]
        f32[18] = cameraPosition[2]
        f32[19] = 0
        f32[20] = sceneWidth
        f32[21] = sceneHeight
        f32[22] = zoom
        f32[23] = 0
        f32[24] = ld[0]; f32[25] = ld[1]; f32[26] = ld[2]; f32[27] = 0
        f32[28] = ld[4]; f32[29] = ld[5]; f32[30] = ld[6]; f32[31] = 0
        f32[32] = ld[8]; f32[33] = ld[9]; f32[34] = ld[10]; f32[35] = 0
        f32[36] = viewCenter[0]
        f32[37] = viewCenter[1]
        f32[38] = 0
        f32[39] = 0
        f32[40] = v4.x; f32[41] = v4.y; f32[42] = v4.z; f32[43] = 0
        const ps = previewShading
        f32[44] = ps.ambient
        f32[45] = ps.diffuseWrap
        f32[46] = ps.keyWeight
        f32[47] = ps.fillWeight
        f32[48] = ps.rimWeight
        f32[49] = ps.backWeight
        f32[50] = ps.specIntensity
        f32[51] = ps.specShininess
        f32[52] = ps.fresnelPower
        f32[53] = ps.fresnelIntensity
        f32[54] = 0
        f32[55] = 0
        f32[56] = ps.aoStrength
        f32[57] = ps.aoRadius
        f32[58] = ps.aoSteps
        f32[59] = ps.aoBias
        this.#writeBufferIfDirty(this.#uniformBuffers.camera, this.#cameraStagingBuf, 0, 240, this.#cameraCache)
    }

    /** Compare src[offset:offset+byteLength] with cache; if different, write to GPU and update cache. Returns true if wrote. */
    #writeBufferIfDirty(
        gpuBuffer: GPUBuffer,
        src: ArrayBuffer | SharedArrayBuffer,
        srcOffset: number,
        byteLength: number,
        cache: ArrayBuffer,
    ): boolean {
        const srcU8 = new Uint8Array(src, srcOffset, byteLength)
        const cacheU8 = new Uint8Array(cache)
        for (let i = 0; i < byteLength; i++) {
            if (srcU8[i] !== cacheU8[i]) {
                this.#device.queue.writeBuffer(gpuBuffer, 0, src, srcOffset, byteLength)
                cacheU8.set(srcU8)
                return true
            }
        }
        return false
    }

    /**
     * SAB variant: snapshot byte range into worker-owned staging, then compare/write/update
     * from that snapshot. Ensures GPU upload and cache state stay consistent when the main
     * thread may be modifying the SAB concurrently.
     */
    #writeBufferFromSABIfDirty(
        gpuBuffer: GPUBuffer,
        sab: SharedArrayBuffer,
        sabOffset: number,
        byteLength: number,
        cache: ArrayBuffer,
    ): boolean {
        const staging = new Uint8Array(this.#sabStagingBuf, 0, byteLength)
        staging.set(new Uint8Array(sab, sabOffset, byteLength))
        return this.#writeBufferIfDirty(gpuBuffer, this.#sabStagingBuf, 0, byteLength, cache)
    }

    /** Compare src view with cache; if different, write to GPU and update cache. Returns true if wrote. */
    #writeBufferViewIfDirty(gpuBuffer: GPUBuffer, src: ArrayBufferView, cache: ArrayBuffer): boolean {
        const byteLength = src.byteLength
        const srcU8 = new Uint8Array(src.buffer, src.byteOffset, byteLength)
        const cacheU8 = new Uint8Array(cache)
        for (let i = 0; i < byteLength; i++) {
            if (srcU8[i] !== cacheU8[i]) {
                this.#device.queue.writeBuffer(gpuBuffer, 0, src as BufferSource)
                cacheU8.set(srcU8)
                return true
            }
        }
        return false
    }

    /** Build edges into staging, upload to GPU if dirty. */
    #writeEdgesToBufferIfDirty(
        gpuBuffer: GPUBuffer,
        edges: (SelectedEdgePayload | { kind: number; primaryId: number; secondaryId: number; featureA: number; opType: number; lineWidthPx?: number; epsilon?: number; seedPoint?: [number, number, number]; seedTangent?: [number, number, number]; seedNormal?: [number, number, number] })[],
        lineWidthPx: number,
        epsilon: number,
        cache: ArrayBuffer,
    ): void {
        const u32 = new Uint32Array(this.#edgesStagingBuf)
        const f32 = new Float32Array(this.#edgesStagingBuf)
        const count = Math.min(edges.length, SELECTED_EDGES_COUNT)
        u32[0] = count
        for (let i = 1; i < SELECTED_EDGES_HEADER / 4; i++) u32[i] = 0
        for (let i = 0; i < count; i++) {
            const e = edges[i]
            const base = SELECTED_EDGES_HEADER / 4 + i * (SELECTED_EDGE_SIZE / 4)
            u32[base] = e.kind
            u32[base + 1] = e.primaryId
            u32[base + 2] = e.secondaryId
            u32[base + 3] = e.featureA
            u32[base + 4] = e.opType
            f32[base + 5] = e.lineWidthPx ?? lineWidthPx
            f32[base + 6] = e.epsilon ?? epsilon
            const sp = e.seedPoint ?? [0, 0, 0]
            f32[base + 8] = sp[0]; f32[base + 9] = sp[1]; f32[base + 10] = sp[2]
            const st = e.seedTangent ?? [0, 0, 0]
            f32[base + 12] = st[0]; f32[base + 13] = st[1]; f32[base + 14] = st[2]
            const sn = e.seedNormal ?? [0, 0, 0]
            f32[base + 16] = sn[0]; f32[base + 17] = sn[1]; f32[base + 18] = sn[2]
        }
        new Uint8Array(this.#edgesStagingBuf).fill(0, SELECTED_EDGES_HEADER + count * SELECTED_EDGE_SIZE, SELECTED_EDGES_TOTAL)
        this.#writeBufferIfDirty(gpuBuffer, this.#edgesStagingBuf, 0, SELECTED_EDGES_TOTAL, cache)
    }

    #writeEdgesToBuffer(
        buffer: GPUBuffer,
        edges: (SelectedEdgePayload | { kind: number; primaryId: number; secondaryId: number; featureA: number; opType: number; lineWidthPx?: number; epsilon?: number; seedPoint?: [number, number, number]; seedTangent?: [number, number, number]; seedNormal?: [number, number, number] })[],
        lineWidthPx: number,
        epsilon: number,
    ): void {
        this.#edgeHeaderU32[0] = Math.min(edges.length, SELECTED_EDGES_COUNT)
        this.#device.queue.writeBuffer(buffer, 0, this.#edgeHeaderBuf)
        const u32 = this.#edgeStrideU32
        const f32 = this.#edgeStrideF32
        for (let i = 0; i < Math.min(edges.length, SELECTED_EDGES_COUNT); i++) {
            const e = edges[i]
            u32[0] = e.kind
            u32[1] = e.primaryId
            u32[2] = e.secondaryId
            u32[3] = e.featureA
            u32[4] = e.opType
            f32[5] = e.lineWidthPx ?? lineWidthPx
            f32[6] = e.epsilon ?? epsilon
            const sp = e.seedPoint ?? [0, 0, 0]
            f32[8] = sp[0]
            f32[9] = sp[1]
            f32[10] = sp[2]
            const st = e.seedTangent ?? [0, 0, 0]
            f32[12] = st[0]
            f32[13] = st[1]
            f32[14] = st[2]
            const sn = e.seedNormal ?? [0, 0, 0]
            f32[16] = sn[0]
            f32[17] = sn[1]
            f32[18] = sn[2]
            this.#device.queue.writeBuffer(buffer, SELECTED_EDGES_HEADER + i * SELECTED_EDGE_SIZE, this.#edgeStrideBuf)
        }
    }
}
