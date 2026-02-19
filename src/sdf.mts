import { Subject } from "rxjs"
import { fromEvent } from "rxjs"
import { throttleTime } from "rxjs"
import type { Subscription } from "rxjs"
import { AveragedBuffer } from "./collections/averagedbuffer.mjs"
import { SettingsManager } from "./storage/settings.mjs"
import { PreviewWindow } from "./components/preview-window.mjs"
import { CameraController } from "./controls/camera-controller.mjs"
import { GPUHelper } from "./gpu/helper.mjs"
import { MDCParams, MDCExport } from "./export/mdc.mjs"
import { Extrude, Loft, Polygon2D, SceneInfo } from "./scene/scene.mjs"
import type { SelectionInfo } from "./components/preview-window.mjs"
import exportShader from "./shaders/mdc.wgsl"
import previewShader from "./shaders/preview.wgsl"
import beamShader from "./shaders/beam.wgsl"
import boundsShader from "./shaders/bounds.wgsl"
import outlineShader from "./shaders/outline.wgsl"
import { ShaderCompiler } from "./shaders/shader.mjs"
import { vec2, Vec2f, vec3, Vec3f } from "./vecmat/vector.mjs"
import { MeshData } from "./export/export.mjs"
import { PALETTE_SIZE, DEFAULT_PALETTE, paletteToFloat32Array } from "./colorPalette.mjs"
import { PushPullController, type PushPullMode } from "./interaction/push-pull.mjs"

/** Max AABB slots for subtree culling. Each slot is 32 bytes (center vec4f + halfExtent vec4f). */
const MAX_AABB_SLOTS = 128
/** Byte size of the AABB uniform buffer. */
const AABB_BUFFER_SIZE = MAX_AABB_SLOTS * 32

/** Max vec2f slots in the shared polygon vertex buffer. */
const MAX_POLYGON_VERTICES = 1024
/** Byte size of the polygon vertex buffer. Each vec2f is 8 bytes. */
const POLYGON_VERTEX_BUFFER_SIZE = MAX_POLYGON_VERTICES * 8

/** Max node slots in the nodeParams uniform. Each slot is a vec4f (16 bytes): .x = h, .y = posYDelta. */
const MAX_NODE_PARAMS = 256
const NODE_PARAMS_BUFFER_SIZE = MAX_NODE_PARAMS * 16

class UniformBuffers {
    camera!: GPUBuffer
    scene!: GPUBuffer
    clickState!: GPUBuffer
    clickedObjectId!: GPUBuffer
    selectedObjectIds!: GPUBuffer
    colorPalette!: GPUBuffer
    viewSettings!: GPUBuffer
    outlineSettings!: GPUBuffer
    subtreeAABBs!: GPUBuffer
    /** Shared storage buffer for all Polygon2D vertex data (vec2f per vertex). */
    polygonVertices!: GPUBuffer
    /** Storage buffer for the 3D hit position of the clicked pixel (vec3f + t). */
    clickedHitPos!: GPUBuffer
    /** Uniform buffer for face selection state (nodeId, faceIndex). */
    faceSelection!: GPUBuffer
    /** Per-node parameters (h, posYDelta) for Extrude/Loft. Updated during cap drag. */
    nodeParams!: GPUBuffer
    edgeHit!: GPUBuffer
    selectedEdges!: GPUBuffer
    hoverEdgeHit!: GPUBuffer
    hoveredEdge!: GPUBuffer
}

type EdgeHitData = { kind: number; primaryId: number; secondaryId: number; featureA: number; opType: number; objectId: number; seedPoint: [number, number, number] }
type SelectedEdgeData = { kind: number; primaryId: number; secondaryId: number; featureA: number; opType: number; lineWidthPx: number; epsilon: number }

/** Outline style for selected objects. */
export type OutlineMode = "none" | "solid" | "dashed" | "dotted"

const OUTLINE_MODE_VALUES: Record<OutlineMode, number> = {
    none: 0,
    solid: 1,
    dashed: 2,
    dotted: 3,
}

class ExportBuffers {
    scene!: GPUBuffer
    vertexBuffer!: GPUBuffer
    triangleBuffer!: GPUBuffer
    triCountBuffer!: GPUBuffer
}

/** Cached scene build state for fast tab switching without shader recompilation. */
interface SceneCacheEntry {
    src: string
    scene: SceneInfo
    sceneShader: GPUShaderModule
    exportShader: GPUShaderModule
    boundsShader: GPUShaderModule
    beamShader: GPUShaderModule
    pipeline: GPURenderPipeline
    beamPipeline: GPUComputePipeline
    polygonVertexData: ArrayBuffer
    totalPolygonVertices: number
    nodeParamsData: Float32Array
    compiledPosY: Map<number, number>
    aabbData: Float32Array
}

export class SDFRenderer {
    #bindGroup!: GPUBindGroup
    #cameraRes!: Vec2f
    #viewCenter: Vec2f = vec2(0.5, 0.5)
    #context!: GPUCanvasContext
    #controls: CameraController
    #device!: GPUDevice
    #format!: GPUTextureFormat
    #framerate = new AveragedBuffer(4)
    #initializing: Promise<void> | null
    #lastActualRenderTime: number = 0  // Time of last actual GPU render
    #lastRenderEndTime: number = 0
    #targetFPS: number = 120  // Limit frame rate to reduce GPU saturation
    #needsRender: boolean = true  // Dirty flag - only render when true
    #pipeline: GPURenderPipeline | null = null
    #preview: PreviewWindow
    #scene!: SceneInfo
    #started = false
    #uniformBuffers: UniformBuffers
    #selectedObjectIds: boolean[] = new Array<boolean>(1024).fill(false)
    #selectedEdges: SelectedEdgeData[] = []
    #hoveredEdgeData: SelectedEdgeData | null = null
    #hoveredEdges: SelectedEdgeData[] = []
    #hoveredObjectId: number = 0
    #clickPending = false
    #lastClickPos: Vec2f = vec2(0, 0)
    #exportBuffers: ExportBuffers
    #shaderCompiler!: ShaderCompiler
    #sceneShader!: GPUShaderModule
    #exportShader!: GPUShaderModule
    #boundsShader!: GPUShaderModule
    #helper!: GPUHelper
    #builtSrc: string | null = null
    #compiledPosY = new Map<number, number>()
    #xrayMode: boolean = false
    #beamEnabled: boolean = false
    #outlineMode: OutlineMode = "solid"
    #outlineThickness: number = 3
    #outlineColor: [number, number, number] = [0.9, 0.9, 0.9]
    #colorTexture!: GPUTexture
    #idTexture!: GPUTexture
    #colorTextureView!: GPUTextureView
    #idTextureView!: GPUTextureView
    #outlinePipeline!: GPURenderPipeline
    #outlineBindGroup!: GPUBindGroup
    #outlineShaderModule!: GPUShaderModule
    #colorSampler!: GPUSampler
    #renderTextureWidth: number = 0
    #renderTextureHeight: number = 0
    // Beam optimization: tile-based SDF pre-pass
    #beamShader!: GPUShaderModule
    #beamPipeline: GPUComputePipeline | null = null
    #beamBindGroup!: GPUBindGroup
    #tStartTexture!: GPUTexture
    #tStartTextureView!: GPUTextureView
    // Generation counter to discard stale async AABB results
    #aabbGeneration = 0
    // Generation counter to discard stale async pipeline creation
    #buildGeneration = 0
    /** Per-document cache of compiled shaders and buffers for fast tab switching. */
    #sceneCache = new Map<string, SceneCacheEntry>()

    // Pre-allocated buffers reused every frame to avoid GC pressure
    #zoomBuf = new Float32Array(1)
    #lightDirBuf = new Float32Array(12)
    #viewSettingsBuf = new Uint32Array(3)
    #outlineBuf = new ArrayBuffer(32)
    #outlineU32 = new Uint32Array(this.#outlineBuf, 0, 1)
    #outlineThicknessF32 = new Float32Array(this.#outlineBuf, 4, 1)
    #outlineColorF32 = new Float32Array(this.#outlineBuf, 16, 3)
    #outlineWidthF32 = new Float32Array(this.#outlineBuf, 28, 1)

    // Resolution scaling: render at reduced res during camera movement for responsiveness
    #settings: SettingsManager = SettingsManager.instance
    #fullWidth: number = 0
    #fullHeight: number = 0
    #sceneWidth: number = 0   // scene rendering resolution (may differ from canvas during movement)
    #sceneHeight: number = 0
    #resolutionScale: number = 1.0
    #movementScale: number = 0.5
    #cameraOptimization: boolean = true
    #movementTimer: ReturnType<typeof setTimeout> | null = null
    #movementSettleMs: number = 150 // ms of inactivity before restoring full resolution
    #documentName: string | null = null
    #tabChangeSub: Subscription | null = null
    #tabCloseSub: Subscription | null = null
    #tabRenameSub: Subscription | null = null
    #resizeObserver: ResizeObserver | null = null
    #controlSubs: Subscription[] = []
    #pushPullController: PushPullController | null = null

    #loadPreviewSettings(): void {
        const prev = this.#settings.getPreview()
        this.#xrayMode = prev.xrayMode
        this.#cameraOptimization = prev.cameraOptimization
        this.#beamEnabled = prev.beamOptimization
        this.previewSettingsLoaded$.next()
        this.#needsRender = true
    }

    /**
     * Observable emitted when object selection changes.
     * Provides the array of currently selected object IDs.
     */
    readonly selectionChange$ = new Subject<number[]>()

    /** Emitted when an object is double-clicked in the preview (node ID). */
    readonly objectDoubleClick$ = new Subject<number>()

    /** Emitted when a push/pull drag completes with the new polygon vertices. */
    readonly pushPullComplete$ = new Subject<{ nodeId: number; vertices: [number, number][] }>()

    /** Emitted when a cap push/pull drag completes with the new h and pos.y. */
    readonly capPullComplete$ = new Subject<{ nodeId: number; newH: number; newPosY: number }>()

    /** Emitted after preview settings are loaded (e.g. on document switch) so the UI can sync */
    readonly previewSettingsLoaded$ = new Subject<void>()

    get controls(): CameraController {
        return this.#controls
    }

    /** Set the center of the visible (non-editor) area in UV space (0-1). */
    setViewCenter(x: number, y: number, editorOffsetPx?: number): void {
        this.#viewCenter = vec2(x, y)
        this.#preview.setSelectionInfoLeft(editorOffsetPx ?? 0)
        this.#needsRender = true
    }

    get selectedObjectIds(): number[] {
        const ids: number[] = []
        for (let i = 0; i < this.#selectedObjectIds.length; i++) {
            if (this.#selectedObjectIds[i]) ids.push(i)
        }
        return ids
    }

    set xrayMode(enabled: boolean) {
        this.#xrayMode = enabled
        this.#settings.updatePreview("xrayMode", enabled)
        this.#needsRender = true
    }

    get xrayMode(): boolean {
        return this.#xrayMode
    }

    set beamEnabled(enabled: boolean) {
        this.#beamEnabled = enabled
        this.#settings.updatePreview("beamOptimization", enabled)
        this.#needsRender = true
    }

    get beamEnabled(): boolean {
        return this.#beamEnabled
    }

    set outlineMode(mode: OutlineMode) {
        this.#outlineMode = mode
        this.#needsRender = true
    }

    get outlineMode(): OutlineMode {
        return this.#outlineMode
    }

    private set lastClickPos(pos: Vec2f) {
        this.#lastClickPos = pos
    }

    get lastClickPos(): Vec2f {
        return this.#lastClickPos
    }

    /** Outline thickness in pixels (1-8). */
    set outlineThickness(px: number) {
        this.#outlineThickness = Math.max(1, Math.min(8, Math.round(px)))
        this.#needsRender = true
    }

    get outlineThickness(): number {
        return this.#outlineThickness
    }

    /** Outline color as [r, g, b] in 0-1 range. */
    set outlineColor(rgb: [number, number, number]) {
        this.#outlineColor = [rgb[0], rgb[1], rgb[2]]
        this.#needsRender = true
    }

    get outlineColor(): [number, number, number] {
        return [...this.#outlineColor] as [number, number, number]
    }

    /** Resolution scale used during camera movement (0.25–1.0). Lower = faster interaction. */
    set movementScale(scale: number) {
        this.#movementScale = Math.max(0.25, Math.min(1.0, scale))
        this.#settings.updateGlobal({ preview: { movementScale: this.#movementScale } })
    }

    get movementScale(): number {
        return this.#movementScale
    }

    /** Whether resolution scaling during camera movement is enabled. */
    set cameraOptimization(enabled: boolean) {
        this.#cameraOptimization = enabled
        this.#settings.updatePreview("cameraOptimization", enabled)
        // If disabling while at reduced resolution, restore full res immediately
        if (!enabled && this.#resolutionScale !== 1.0) {
            if (this.#movementTimer !== null) {
                clearTimeout(this.#movementTimer)
                this.#movementTimer = null
            }
            this.#resolutionScale = 1.0
            this.#applyResolutionScale()
            this.#needsRender = true
        }
    }

    get cameraOptimization(): boolean {
        return this.#cameraOptimization
    }

    /**
     * Set the selection programmatically (for editor-to-preview selection sync).
     * @param ids Array of node IDs to select
     */
    setSelection(ids: number[], notify = false) {
        this.#selectedObjectIds.fill(false)
        for (const id of ids) {
            this.#selectedObjectIds[id] = true
        }
        this.#clearSelectedEdges()
        this.#writeSelectionBuffer()
        this.#pushSelectionInfo()
        if (notify) {
            this.selectionChange$.next(this.selectedObjectIds)
        }
    }

    /**
     * Get all nodes from the current scene for matching with source code.
     */
    getSceneNodes() {
        return this.#scene?.getAllNodes() ?? []
    }

    /** Read back the clicked object ID (u32) from the GPU storage buffer. */
    async #readClickedObjectId(): Promise<number> {
        const readback = await this.#helper.readBufferData(this.#uniformBuffers.clickedObjectId, 4)
        return new Uint32Array(readback)[0] ?? 0
    }

    /** Read back the 3D hit position from the GPU storage buffer. */
    async #readClickedHitPos(): Promise<Vec3f> {
        const readback = await this.#helper.readBufferData(this.#uniformBuffers.clickedHitPos, 16)
        const f = new Float32Array(readback)
        return vec3(f[0], f[1], f[2])
    }

    async #readEdgeHits(): Promise<EdgeHitData[]> {
        const readback = await this.#helper.readBufferData(this.#uniformBuffers.edgeHit, 96)
        const u32 = new Uint32Array(readback)
        const f32 = new Float32Array(readback)
        const result: EdgeHitData[] = []
        for (let slot = 0; slot < 2; slot++) {
            const o = slot * 12
            const kind = u32[o]
            if (kind === 0) continue
            result.push({
                kind,
                primaryId: u32[o + 1],
                secondaryId: u32[o + 2],
                featureA: u32[o + 3],
                opType: u32[o + 4],
                objectId: u32[o + 5],
                seedPoint: [f32[o + 8], f32[o + 9], f32[o + 10]],
            })
        }
        return result
    }

    async #readHoverEdgeHits(): Promise<EdgeHitData[]> {
        const readback = await this.#helper.readBufferData(this.#uniformBuffers.hoverEdgeHit, 96)
        const u32 = new Uint32Array(readback)
        const f32 = new Float32Array(readback)
        const result: EdgeHitData[] = []
        for (let slot = 0; slot < 2; slot++) {
            const o = slot * 12
            const kind = u32[o]
            const objectId = u32[o + 5]
            if (kind === 0 && objectId === 0) continue
            result.push({
                kind,
                primaryId: u32[o + 1],
                secondaryId: u32[o + 2],
                featureA: u32[o + 3],
                opType: u32[o + 4],
                objectId,
                seedPoint: [f32[o + 8], f32[o + 9], f32[o + 10]],
            })
        }
        return result
    }

    #writeSelectedEdgesBuffer(): void {
        const header = new ArrayBuffer(16)
        new Uint32Array(header)[0] = this.#selectedEdges.length
        this.#device.queue.writeBuffer(this.#uniformBuffers.selectedEdges, 0, header)
        for (let i = 0; i < Math.min(this.#selectedEdges.length, 16); i++) {
            const e = this.#selectedEdges[i]
            const buf = new ArrayBuffer(32)
            const u32 = new Uint32Array(buf)
            const f32 = new Float32Array(buf)
            u32[0] = e.kind
            u32[1] = e.primaryId
            u32[2] = e.secondaryId
            u32[3] = e.featureA
            u32[4] = e.opType
            f32[5] = e.lineWidthPx ?? 4.0
            f32[6] = e.epsilon ?? 0.015
            this.#device.queue.writeBuffer(this.#uniformBuffers.selectedEdges, 16 + i * 32, buf)
        }
    }

    #setSelectedEdgeFromHit(hit: EdgeHitData): void {
        this.#setSelectedEdgesFromHits([hit])
    }

    #setSelectedEdgesFromHits(hits: EdgeHitData[]): void {
        const seen = new Set<string>()
        this.#selectedEdges = []
        for (const hit of hits) {
            const key = `${hit.kind}:${hit.primaryId}:${hit.secondaryId}:${hit.featureA}:${hit.opType}`
            if (seen.has(key)) continue
            seen.add(key)
            this.#selectedEdges.push({
                kind: hit.kind,
                primaryId: hit.primaryId,
                secondaryId: hit.secondaryId,
                featureA: hit.featureA,
                opType: hit.opType,
                lineWidthPx: 4.0,
                epsilon: 0.02,
            })
        }
        if (this.#selectedEdges.length > 16) {
            this.#selectedEdges = this.#selectedEdges.slice(0, 16)
        }
        this.#writeSelectedEdgesBuffer()
        this.#pushSelectionInfo()
    }

    #addSelectedEdgeFromHit(hit: EdgeHitData): void {
        const edge: SelectedEdgeData = {
            kind: hit.kind,
            primaryId: hit.primaryId,
            secondaryId: hit.secondaryId,
            featureA: hit.featureA,
            opType: hit.opType,
            lineWidthPx: 4.0,
            epsilon: 0.02,
        }
        const key = `${hit.kind}:${hit.primaryId}:${hit.secondaryId}:${hit.featureA}:${hit.opType}`
        if (this.#selectedEdges.some(e => `${e.kind}:${e.primaryId}:${e.secondaryId}:${e.featureA}:${e.opType}` === key)) return
        this.#selectedEdges.push(edge)
        if (this.#selectedEdges.length > 16) this.#selectedEdges = this.#selectedEdges.slice(-16)
        this.#writeSelectedEdgesBuffer()
        this.#pushSelectionInfo()
    }

    #clearSelectedEdges(): void {
        this.#selectedEdges = []
        this.#writeSelectedEdgesBuffer()
        this.#pushSelectionInfo()
    }

    #setHoveredEdge(edge: SelectedEdgeData | null): void {
        this.#setHoveredEdges(edge ? [edge] : [])
    }

    #setHoveredEdges(edges: SelectedEdgeData[]): void {
        this.#hoveredEdges = edges
        this.#hoveredEdgeData = edges.length > 0 ? edges[0] : null
        const header = new ArrayBuffer(16)
        new Uint32Array(header)[0] = Math.min(edges.length, 16)
        this.#device.queue.writeBuffer(this.#uniformBuffers.hoveredEdge, 0, header)
        for (let i = 0; i < Math.min(edges.length, 16); i++) {
            const edge = edges[i]
            const buf = new ArrayBuffer(32)
            const u32 = new Uint32Array(buf)
            const f32 = new Float32Array(buf)
            u32[0] = edge.kind
            u32[1] = edge.primaryId
            u32[2] = edge.secondaryId
            u32[3] = edge.featureA
            u32[4] = edge.opType
            f32[5] = edge.lineWidthPx ?? 6.0
            f32[6] = edge.epsilon ?? 0.02
            this.#device.queue.writeBuffer(this.#uniformBuffers.hoveredEdge, 16 + i * 32, buf)
        }
        this.#pushSelectionInfo()
    }

    /** Write click state to GPU buffers and trigger render. Converts screen pos to UV. */
    #writeClickState(screenPos: Vec2f): void {
        const canvas = this.#preview.canvas
        const rect = canvas.getBoundingClientRect()
        const x = (screenPos.x - rect.left) / rect.width
        const y = 1.0 - (screenPos.y - rect.top) / rect.height // Flip Y for WGSL UV space

        this.#lastClickPos = vec2(x, y)

        // Store click state: must match WGSL ClickState struct layout (32 bytes)
        const clickData = new ArrayBuffer(32)
        const clickF32 = new Float32Array(clickData)
        const clickU32 = new Uint32Array(clickData)
        clickF32[0] = x
        clickF32[1] = y
        clickU32[2] = 1  // click enabled
        clickU32[3] = 0  // hover disabled
        clickF32[4] = 0
        clickF32[5] = 0
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickState, 0, clickData)

        this.#device.queue.writeBuffer(
            this.#uniformBuffers.clickedObjectId, 0, new Uint32Array([0])
        )
        this.#device.queue.writeBuffer(
            this.#uniformBuffers.clickedHitPos, 0, new Float32Array([0, 0, 0, 0]).buffer
        )
        this.#device.queue.writeBuffer(
            this.#uniformBuffers.edgeHit, 0, new ArrayBuffer(96)
        )

        this.#needsRender = true
    }

    #writeHoverState(screenPos: Vec2f, enabled: boolean): void {
        if (this.#clickPending) return
        const canvas = this.#preview.canvas
        const rect = canvas.getBoundingClientRect()
        const x = (screenPos.x - rect.left) / rect.width
        const y = 1.0 - (screenPos.y - rect.top) / rect.height

        const clickData = new ArrayBuffer(32)
        const clickF32 = new Float32Array(clickData)
        const clickU32 = new Uint32Array(clickData)
        clickF32[0] = this.#lastClickPos.x
        clickF32[1] = this.#lastClickPos.y
        clickU32[2] = 0
        clickU32[3] = enabled ? 1 : 0
        clickF32[4] = x
        clickF32[5] = y
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickState, 0, clickData)

        if (enabled) {
            this.#device.queue.writeBuffer(
                this.#uniformBuffers.hoverEdgeHit, 0, new ArrayBuffer(96)
            )
        }
        this.#needsRender = true
    }

    /** Schedule async readback of clicked object ID after a few frames. */
    #scheduleClickReadback(onResult: (id: number) => void): void {
        setTimeout(async () => {
            try {
                const id = await this.#readClickedObjectId()
                onResult(id)
            } catch (error) {
                console.error("Error reading clicked object ID:", error)
            }
        }, 200)
    }

    #handleClick(screenPos: Vec2f, shiftKey: boolean, altKey: boolean) {
        if (!this.#device) return
        this.#clickPending = true
        this.#writeClickState(screenPos)

        setTimeout(async () => {
            try {
                const [clickedId, edgeHits] = await Promise.all([
                    this.#readClickedObjectId(),
                    this.#readEdgeHits(),
                ])
                this.#clickPending = false
                if (altKey && edgeHits.length > 0) {
                    if (shiftKey) {
                        for (const hit of edgeHits) {
                            this.#addSelectedEdgeFromHit(hit)
                        }
                    } else {
                        this.#setSelectedEdgesFromHits(edgeHits)
                    }
                    this.#selectedObjectIds.fill(false)
                    this.#writeSelectionBuffer()
                    this.selectionChange$.next([])
                } else {
                    this.#clearSelectedEdges()
                    if (clickedId !== 0) {
                        this.#updateSelection(clickedId, shiftKey)
                    } else if (!shiftKey) {
                        this.#selectedObjectIds.fill(false)
                        this.#writeSelectionBuffer()
                        this.selectionChange$.next([])
                    }
                }
            } catch (error) {
                this.#clickPending = false
                console.error("Error reading click data:", error)
            }
        }, 200)
    }

    #handleHover(screenPos: Vec2f, altKey: boolean) {
        if (!this.#device) return
        this.#writeHoverState(screenPos, true)
        if (!altKey) {
            this.#setHoveredEdge(null)
        }
        setTimeout(async () => {
            try {
                const hits = await this.#readHoverEdgeHits()
                this.#hoveredObjectId = hits.length > 0 ? hits[hits.length - 1].objectId : 0
                const edges: SelectedEdgeData[] = altKey
                    ? hits.filter(h => h.kind !== 0).map(h => ({
                          kind: h.kind,
                          primaryId: h.primaryId,
                          secondaryId: h.secondaryId,
                          featureA: h.featureA,
                          opType: h.opType,
                          lineWidthPx: 6.0,
                          epsilon: 0.02,
                      }))
                    : []
                this.#setHoveredEdges(edges)
                this.#pushSelectionInfo()
                this.#needsRender = true
            } catch (error) {
                console.error("Error reading hover edge:", error)
            }
        }, 50)
    }

    #handleDoubleClick(screenPos: Vec2f) {
        this.#writeClickState(screenPos)

        // Extended readback for double-click: read object ID and hit position.
        setTimeout(async () => {
            try {
                const [clickedId, hitPos] = await Promise.all([
                    this.#readClickedObjectId(),
                    this.#readClickedHitPos(),
                ])
                if (clickedId !== 0) {
                    if (this.#scene && this.#pushPullController) {
                        const node = this.#scene.get(clickedId)
                        // Side face of a no-twist Extrude
                        if (node instanceof Extrude && node.twist === 0) {
                            this.#pushPullController.selectFace(node, hitPos)
                            this.#pushSelectionInfo()
                            return
                        }
                        // Cap face: Polygon2D child of an Extrude or Loft
                        if (node instanceof Polygon2D) {
                            const parent = this.#findCapParent(node)
                            if (parent) {
                                const localY = hitPos.y - parent.pos.y
                                const isTop = localY >= 0
                                this.#pushPullController.selectCapFace(parent, isTop)
                                this.#pushSelectionInfo()
                                return
                            }
                        }
                    }
                    this.objectDoubleClick$.next(clickedId)
                }
            } catch (error) {
                console.error("Error reading double-click data:", error)
            }
        }, 200)
    }

    /** Find the parent Extrude or Loft that owns this Polygon2D cap. */
    #findCapParent(poly: Polygon2D): Extrude | Loft | null {
        if (!this.#scene) return null
        for (const node of this.#scene.getAllNodes()) {
            if (node instanceof Extrude && node.child === poly) return node
            if (node instanceof Loft) {
                if (node.profiles[0] === poly || node.profiles[node.profiles.length - 1] === poly) {
                    return node
                }
            }
        }
        return null
    }

    #updateSelection(clickedId: number, shiftKey: boolean) {
        const wasSelected = this.#selectedObjectIds[clickedId] === true

        if (shiftKey) {
            // Multiselect mode: toggle the clicked object
            this.#selectedObjectIds[clickedId] = !wasSelected
            console.log(wasSelected ? `Removed object ${clickedId} from selection` : `Added object ${clickedId} to selection`)
        } else {
            // Single select mode
            if (wasSelected && this.selectedObjectIds.length === 1) {
                // Clicking the only selected object deselects it
                this.#selectedObjectIds.fill(false)
                console.log('Deselected object')
            } else {
                // Select only the clicked object
                this.#selectedObjectIds.fill(false)
                this.#selectedObjectIds[clickedId] = true
                console.log(`Selected object ID: ${clickedId}`)
            }
        }

        this.#writeSelectionBuffer()
        this.#pushSelectionInfo()
        this.selectionChange$.next(this.selectedObjectIds)
    }

    #pushSelectionInfo(): void {
        const rawObjects = this.selectedObjectIds
        const faceSel = this.#pushPullController?.getFaceSelection()
        const objects = faceSel
            ? rawObjects.filter(id => id !== 1023)
            : rawObjects
        const objectNames: Record<number, string> = {}
        if (this.#scene) {
            const ids = new Set([...objects, this.#hoveredObjectId, faceSel?.nodeId].filter((id): id is number => id != null && id > 0))
            for (const id of ids) {
                const node = this.#scene.get(id)
                objectNames[id] = node?.getShapeType?.() ?? "?"
            }
        }
        const edges = this.#selectedEdges.map(e => ({
            kind: e.kind,
            primaryId: e.primaryId,
            secondaryId: e.secondaryId,
            featureA: e.featureA,
            opType: e.opType,
        }))
        const face = this.#pushPullController?.getFaceSelection() ?? null
        const hover: SelectionInfo["hover"] =
            this.#hoveredObjectId > 0
                ? {
                      objectId: this.#hoveredObjectId,
                      edges: this.#hoveredEdges.map(e => ({
                          kind: e.kind,
                          primaryId: e.primaryId,
                          secondaryId: e.secondaryId,
                          featureA: e.featureA,
                          opType: e.opType,
                      })),
                  }
                : null
        this.#preview.updateSelectionInfo({ objects, objectNames, edges, face, hover })
    }

    #writeSelectionBuffer() {
        // Write selection as boolean array to GPU buffer
        // Format: selectedObjectIds[objectId] = 1 if selected, 0 if not (1024 slots, 4096 bytes)
        const data = new Uint32Array(1024)
        for (let i = 0; i < this.#selectedObjectIds.length && i < 1024; i++) {
            data[i] = this.#selectedObjectIds[i] ? 1 : 0
        }
        this.#device.queue.writeBuffer(this.#uniformBuffers.selectedObjectIds, 0, data)
        this.#needsRender = true
    }

    constructor(preview: PreviewWindow, tabsElement?: EventTarget | null, getInteractionRect?: () => DOMRect) {
        this.#preview = preview
        this.#controls = new CameraController(preview, vec3(0, 0, 0), 50, 0, Math.PI / 2, tabsElement, getInteractionRect)
        this.#controlSubs.push(
            this.#controls.select$.subscribe(({ screenPos, shiftKey, altKey }) =>
                this.#handleClick(screenPos, shiftKey, altKey)
            ),
            this.#controls.doubleClick$.subscribe(screenPos => this.#handleDoubleClick(screenPos)),
            this.#controls.hover$.pipe(throttleTime(80)).subscribe(({ screenPos, altKey }) =>
                this.#handleHover(screenPos, altKey)
            ),
            this.#controls.change$.subscribe(() => {
                this.#needsRender = true
                this.#onCameraMovement()
            })
        )
        this.#movementScale = this.#settings.getGlobal().preview.movementScale
        this.#documentName = (tabsElement as { active?: string })?.active ?? null
        this.#uniformBuffers = new UniformBuffers()
        this.#exportBuffers = new ExportBuffers()
        this.#initializing = this.initialize()
        this.#cameraRes = vec2(this.#preview.canvas.clientWidth, this.#preview.canvas.clientHeight)

        this.#loadPreviewSettings()

        if (tabsElement) {
            this.#tabChangeSub = fromEvent(tabsElement, "activeTabChanged").subscribe((e: Event) => {
                const customEvent = e as CustomEvent<string | undefined>
                // SettingsManager.switchDocument (called from DocumentTabs) handles
                // flushing the old doc and loading the new one. We just need to
                // reload our in-memory preview flags from the (already-switched) settings.
                this.#documentName = customEvent.detail ?? null
                this.#loadPreviewSettings()
            })
            this.#tabCloseSub = fromEvent(tabsElement, "tabClosed").subscribe((e: Event) => {
                this.#sceneCache.delete((e as CustomEvent<string>).detail)
            })
            this.#tabRenameSub = fromEvent(tabsElement, "tabRenamed").subscribe((e: Event) => {
                const { oldName } = (e as CustomEvent<{ oldName: string; newName: string }>).detail
                this.#sceneCache.delete(oldName)
            })
        }

        const observer = new ResizeObserver(entries => {
            requestAnimationFrame(() => {
                for (const entry of entries) {
                    const w =
                        entry.devicePixelContentBoxSize?.[0].inlineSize ??
                        Math.max(1, Math.round(entry.contentRect.width * devicePixelRatio))
                    const h =
                        entry.devicePixelContentBoxSize?.[0].blockSize ??
                        Math.max(1, Math.round(entry.contentRect.height * devicePixelRatio))
                    this.#fullWidth = w
                    this.#fullHeight = h
                    this.#applyResolutionScale()
                    this.#needsRender = true
                }
            })
        })
        try {
            observer.observe(this.#preview, { box: "device-pixel-content-box" })
        } catch {
            observer.observe(this.#preview, { box: "content-box" })
        }
        this.#resizeObserver = observer
    }

    /** Clean up subscriptions and listeners. Call when the renderer is no longer needed. */
    dispose(): void {
        for (const sub of this.#controlSubs) sub.unsubscribe()
        this.#controlSubs.length = 0
        this.#tabChangeSub?.unsubscribe()
        this.#tabChangeSub = null
        this.#tabCloseSub?.unsubscribe()
        this.#tabCloseSub = null
        this.#tabRenameSub?.unsubscribe()
        this.#tabRenameSub = null
        this.#resizeObserver?.disconnect()
        this.#resizeObserver = null
        this.#controls.dispose()
        this.selectionChange$.complete()
        this.objectDoubleClick$.complete()
        this.previewSettingsLoaded$.complete()
    }

    build(src: string, documentName?: string | null): Promise<void> {
        const trimmed = src.trim()

        // Restore from cache if we have a matching entry (avoids shader recompilation on tab switch)
        if (documentName) {
            const cached = this.#sceneCache.get(documentName)
            if (cached && cached.src === trimmed) {
                return this.#restoreFromCache(cached)
            }
        }

        return this.#buildFromSource(trimmed, documentName)
    }

    #restoreFromCache(cached: SceneCacheEntry): Promise<void> {
        this.#builtSrc = cached.src
        this.#scene = cached.scene
        this.#sceneShader = cached.sceneShader
        this.#exportShader = cached.exportShader
        this.#boundsShader = cached.boundsShader
        this.#beamShader = cached.beamShader
        this.#pipeline = cached.pipeline
        this.#beamPipeline = cached.beamPipeline

        this.#device.queue.writeBuffer(this.#uniformBuffers.polygonVertices, 0, cached.polygonVertexData as BufferSource)
        this.#device.queue.writeBuffer(this.#uniformBuffers.nodeParams, 0, cached.nodeParamsData as BufferSource)
        this.#device.queue.writeBuffer(this.#uniformBuffers.subtreeAABBs, 0, cached.aabbData as BufferSource)

        this.#compiledPosY.clear()
        for (const [k, v] of cached.compiledPosY) this.#compiledPosY.set(k, v)

        this.#renderTextureWidth = 0
        this.#renderTextureHeight = 0
        this.#needsRender = true
        this.#controls.loadCameraFromSettings()
        return Promise.resolve()
    }

    #buildFromSource(trimmed: string, documentName?: string | null): Promise<void> {
        this.#builtSrc = trimmed
        this.#scene = new SceneInfo(trimmed)
        const sceneAux = this.#scene.compileAux()
        const sceneAuxFast = this.#scene.compileAuxFast()
        const sceneSDF = this.#scene.compile()
        const sceneSDF_fast = this.#scene.compileFast()
        const sceneEdgeHelpers = this.#scene.compileEdgeHelpers()
        this.#shaderCompiler = new ShaderCompiler(this.#device)
            .replace("insert", "sceneAuxFast", sceneAuxFast)
            .replace("insert", "sceneAux", sceneAux)
            .replace("insert", "sceneSDF_fast", sceneSDF_fast)
            .replace("insert", "sceneSDF", sceneSDF)
            .replace("insert", "sceneEdgeHelpers", sceneEdgeHelpers)
        this.#sceneShader = this.#shaderCompiler.compile(previewShader, "Preview Window")
        this.#exportShader = this.#shaderCompiler.compile(exportShader, "Export")
        this.#boundsShader = this.#shaderCompiler.compile(boundsShader, "Bounds (scene bbox)")
        this.#beamShader = this.#shaderCompiler.compile(beamShader, "Beam Pre-Pass")

        // Capture data for cache before async work
        const polygonVertexData: ArrayBuffer = this.#scene.totalPolygonVertices > 0
            ? (this.#scene.getPolygonVertexData().buffer.slice(0) as ArrayBuffer)
            : new ArrayBuffer(0)
        const totalPolygonVertices = this.#scene.totalPolygonVertices
        const nodeParamsData = new Float32Array(MAX_NODE_PARAMS * 4)
        this.#compiledPosY.clear()
        for (const node of this.#scene.getAllNodes()) {
            if ((node instanceof Extrude || node instanceof Loft) && node.id < MAX_NODE_PARAMS) {
                nodeParamsData[node.id * 4] = node.h
                nodeParamsData[node.id * 4 + 1] = 0
                this.#compiledPosY.set(node.id, node.pos.y)
            }
        }
        const compiledPosYCopy = new Map<number, number>(this.#compiledPosY)

        // Populate the polygon vertex buffer with all Polygon2D vertex data.
        if (totalPolygonVertices > 0) {
            this.#device.queue.writeBuffer(this.#uniformBuffers.polygonVertices, 0, polygonVertexData as BufferSource)
        }

        // Populate nodeParams buffer
        this.#device.queue.writeBuffer(this.#uniformBuffers.nodeParams, 0, nodeParamsData)

        // Reset AABB buffer to infinite (no culling) for immediate rendering,
        // then kick off async GPU-based bounds computation.
        this.#initAABBBufferInfinite()
        this.#aabbGeneration++
        const aabbPromise = this.#scene.numAABBSlots > 0
            ? this.#computeSubtreeAABBs(this.#aabbGeneration)
            : Promise.resolve(this.#getInfiniteAABBData())

        // Create pipelines asynchronously to avoid blocking the main thread.
        const generation = ++this.#buildGeneration
        const pipelinesPromise = this.#createPipelinesAsync(generation)

        return Promise.all([pipelinesPromise, aabbPromise]).then(([, aabbData]) => {
            if (generation !== this.#buildGeneration) return
            if (documentName) {
                this.#storeCache(documentName, trimmed, {
                    polygonVertexData,
                    totalPolygonVertices,
                    nodeParamsData,
                    compiledPosY: compiledPosYCopy,
                    aabbData,
                })
            }
        })
    }

    #getInfiniteAABBData(): Float32Array {
        const data = new Float32Array(MAX_AABB_SLOTS * 8)
        for (let i = 0; i < MAX_AABB_SLOTS; i++) {
            data[i * 8 + 4] = 9999
            data[i * 8 + 5] = 9999
            data[i * 8 + 6] = 9999
        }
        return data
    }

    #storeCache(
        documentName: string,
        src: string,
        data: {
            polygonVertexData: ArrayBuffer
            totalPolygonVertices: number
            nodeParamsData: Float32Array
            compiledPosY: Map<number, number>
            aabbData: Float32Array
        }
    ): void {
        if (!this.#pipeline || !this.#beamPipeline) return
        this.#sceneCache.set(documentName, {
            src,
            scene: this.#scene,
            sceneShader: this.#sceneShader,
            exportShader: this.#exportShader,
            boundsShader: this.#boundsShader,
            beamShader: this.#beamShader,
            pipeline: this.#pipeline,
            beamPipeline: this.#beamPipeline,
            polygonVertexData: data.polygonVertexData,
            totalPolygonVertices: data.totalPolygonVertices,
            nodeParamsData: data.nodeParamsData,
            compiledPosY: data.compiledPosY,
            aabbData: data.aabbData,
        })
    }

    /**
     * Create preview and beam pipelines asynchronously.
     * When complete, updates pipelines and forces bind group recreation.
     * Discards results if a newer build has started (generation mismatch).
     */
    async #createPipelinesAsync(generation: number): Promise<void> {
        const format = this.#format
        try {
            const [pipeline, beamPipeline] = await Promise.all([
                this.#device.createRenderPipelineAsync({
                    label: "Preview Pipeline",
                    layout: "auto",
                    vertex: {
                        module: this.#sceneShader,
                        entryPoint: "vertexMain",
                    },
                    fragment: {
                        module: this.#sceneShader,
                        entryPoint: "fragmentMain",
                        targets: [
                            { format },
                            { format: "r32uint" as GPUTextureFormat },
                        ],
                    },
                    primitive: {
                        topology: "triangle-strip",
                        stripIndexFormat: "uint32",
                    },
                }),
                this.#device.createComputePipelineAsync({
                    label: "Beam Pre-Pass Pipeline",
                    layout: "auto",
                    compute: {
                        module: this.#beamShader,
                        entryPoint: "beamMarch",
                    },
                }),
            ])
            if (generation !== this.#buildGeneration) return
            this.#pipeline = pipeline
            this.#beamPipeline = beamPipeline
            this.#renderTextureWidth = 0
            this.#renderTextureHeight = 0
            this.#needsRender = true
            this.#controls.loadCameraFromSettings()
        } catch (err) {
            if (generation !== this.#buildGeneration) return
            console.error("[SDFRenderer] Pipeline creation failed:", err)
        }
    }

    /**
     * Asynchronously compute AABBs for each guarded subtree using the GPU bounds shader.
     * Runs bounds.wgsl with each subtree's SDF injected, then writes results to the
     * AABB uniform buffer. Called after build(); the scene renders with infinite AABBs
     * (no culling) until this completes.
     * @param generation Build generation counter — results are discarded if a newer build started.
     * @returns The AABB data (for caching).
     */
    async #computeSubtreeAABBs(generation: number): Promise<Float32Array> {
        const aabbData = new Float32Array(MAX_AABB_SLOTS * 8)
        for (let i = 0; i < MAX_AABB_SLOTS; i++) {
            aabbData[i * 8 + 4] = 9999
            aabbData[i * 8 + 5] = 9999
            aabbData[i * 8 + 6] = 9999
        }

        const scene = this.#scene
        const subtrees = scene.getGuardedSubtrees()
        if (subtrees.length === 0) return aabbData

        const SEARCH_HALF = 250
        const STEP = 5.0
        const SCALE = 1000
        const searchMin: [number, number, number] = [-SEARCH_HALF, -SEARCH_HALF, -SEARCH_HALF]
        const searchMax: [number, number, number] = [SEARCH_HALF, SEARCH_HALF, SEARCH_HALF]

        const dimsX = Math.max(1, Math.ceil((searchMax[0] - searchMin[0]) / STEP) + 1)
        const dimsY = Math.max(1, Math.ceil((searchMax[1] - searchMin[1]) / STEP) + 1)
        const dimsZ = Math.max(1, Math.ceil((searchMax[2] - searchMin[2]) / STEP) + 1)

        const totalSamples = dimsX * dimsY * dimsZ
        const totalWorkgroups = Math.ceil(totalSamples / 256)
        const dispatchX = Math.min(totalWorkgroups, 65535)
        const dispatchY = Math.ceil(totalWorkgroups / dispatchX)
        const dispatchedWorkgroups = dispatchX * dispatchY
        const TILE_STRIDE_BYTES = 48
        const outSize = dispatchedWorkgroups * TILE_STRIDE_BYTES

        // Shared uniform buffer for all subtree dispatches
        const uniformsData = new ArrayBuffer(80)
        new Float32Array(uniformsData, 0, 4).set([searchMin[0], searchMin[1], searchMin[2], STEP])
        new Float32Array(uniformsData, 16, 4).set([searchMax[0], searchMax[1], searchMax[2], 0.0])
        new Uint32Array(uniformsData, 32, 4).set([dimsX >>> 0, dimsY >>> 0, dimsZ >>> 0, 0])
        new Float32Array(uniformsData, 48, 1).set([SCALE])

        const uniformBuffer = this.#helper.createBuffer(
            "SubtreeAABBUniforms", uniformsData.byteLength,
            GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        )
        this.#device.queue.writeBuffer(uniformBuffer, 0, uniformsData)

        const outBuffer = this.#helper.createBuffer(
            "SubtreeAABBTiles", outSize,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
        )

        for (const sub of subtrees) {
            // Build a per-subtree bounds shader with only this subtree's SDF
            const subtreeShaderCode = boundsShader
            const compiler = new ShaderCompiler(this.#device)
                .replace("insert", "sceneAuxFast", sub.fastAux)
                .replace("insert", "sceneAux", "")
                .replace("insert", "sceneSDF_fast", `\nreturn ${sub.fastSDF};\n`)
            const module = compiler.compile(subtreeShaderCode, `SubtreeBounds_${sub.aabbIndex}`)

            const pipeline = this.#helper.createComputePipeline(module, "computeBounds", `SubtreeBounds_${sub.aabbIndex}`)
            const [, bindGroup] = this.#helper.createBindGroup(
                0, `SubtreeBounds_BG_${sub.aabbIndex}`, pipeline,
                [0, uniformBuffer],
                [1, outBuffer],
                [2, this.#uniformBuffers.subtreeAABBs],
                [3, this.#uniformBuffers.polygonVertices],
                [4, this.#uniformBuffers.faceSelection],
                [5, this.#uniformBuffers.nodeParams],
                [99, this.#uniformBuffers.selectedObjectIds]
            )

            const ce = this.#device.createCommandEncoder({ label: `subtree_bounds_${sub.aabbIndex}` })
            const pass = this.#helper.beginComputePass(ce, pipeline, [0, bindGroup])
            pass.dispatchWorkgroups(dispatchX, dispatchY, 1)
            pass.end()
            this.#device.queue.submit([ce.finish()])
            await this.#device.queue.onSubmittedWorkDone()
            if (generation !== this.#aabbGeneration) {
                uniformBuffer.destroy()
                outBuffer.destroy()
                return aabbData
            }

            // Read back and reduce the tile results
            const outData = await this.#helper.readBufferData(outBuffer, outSize)
            const dv = new DataView(outData)

            let any = false
            let minXq = 2147483647, minYq = 2147483647, minZq = 2147483647
            let maxXq = -2147483648, maxYq = -2147483648, maxZq = -2147483648

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

            if (any) {
                const minX = minXq / SCALE
                const minY = minYq / SCALE
                const minZ = minZq / SCALE
                const maxX = maxXq / SCALE
                const maxY = maxYq / SCALE
                const maxZ = maxZq / SCALE

                // Inflate slightly for safety (coarse grid + blend regions)
                const pad = STEP + 2.0
                const cx = (minX + maxX) * 0.5
                const cy = (minY + maxY) * 0.5
                const cz = (minZ + maxZ) * 0.5
                const hx = (maxX - minX) * 0.5 + pad
                const hy = (maxY - minY) * 0.5 + pad
                const hz = (maxZ - minZ) * 0.5 + pad

                const base = sub.aabbIndex * 8
                aabbData[base + 0] = cx
                aabbData[base + 1] = cy
                aabbData[base + 2] = cz
                aabbData[base + 3] = 0
                aabbData[base + 4] = hx
                aabbData[base + 5] = hy
                aabbData[base + 6] = hz
                aabbData[base + 7] = 0
            }
        }

        // Write all computed AABBs to the uniform buffer in one call (if still current)
        if (generation === this.#aabbGeneration) {
            this.#device.queue.writeBuffer(this.#uniformBuffers.subtreeAABBs, 0, aabbData)
            this.#needsRender = true
        }

        // Clean up temporary buffers
        uniformBuffer.destroy()
        outBuffer.destroy()
        return aabbData
    }

    async initialize() {
        const helper = await GPUHelper.create()
        if (!helper) {
            throw new Error("No GPU adapter found", { cause: "unsupported" })
        }
        this.#helper = helper
        this.#device = this.#helper.device
        this.#context = this.#preview.canvas.getContext("webgpu") as GPUCanvasContext

        this.#format = navigator.gpu.getPreferredCanvasFormat()
        this.#context.configure({
            device: this.#device,
            format: this.#format,
            alphaMode: "premultiplied",
        })
        this.#createBuffers()

        // Sampler for bilinear upscaling of the scene color texture in the outline pass.
        this.#colorSampler = this.#device.createSampler({
            magFilter: "linear",
            minFilter: "linear",
        })

        // Create outline post-process shader and pipeline (scene-independent)
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
    }

    async ready() {
        if (this.#initializing) {
            await this.#initializing
            this.#initializing = null
        }
        // Initialize click detection buffers (32 bytes: clickPos, enabled, hoverEnabled, hoverPos)
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickState, 0, new ArrayBuffer(32))
        // Initialize selection buffer with count=0
        this.#device.queue.writeBuffer(this.#uniformBuffers.selectedObjectIds, 0, new Uint32Array(1024))
        // Initialize face selection as disabled (nodeId=0, faceIndex=0, mode=0, extrudeOffset=0.0)
        this.#device.queue.writeBuffer(this.#uniformBuffers.faceSelection, 0, new ArrayBuffer(16))

        this.#initPushPull()
    }

    #initPushPull(): void {
        const self = this
        this.#pushPullController = new PushPullController({
            get device() { return self.#device },
            get polygonVerticesBuffer() { return self.#uniformBuffers.polygonVertices },
            get faceSelectionBuffer() { return self.#uniformBuffers.faceSelection },
            get nodeParamsBuffer() { return self.#uniformBuffers.nodeParams },
            getCompiledPosY(nodeId: number) { return self.#compiledPosY.get(nodeId) ?? 0 },
            get selectedObjectIdsBuffer() { return self.#uniformBuffers.selectedObjectIds },
            requestRender() {
                self.#needsRender = true
                if (self.#pushPullController?.isDragging) {
                    self.#onCameraMovement()
                }
            },
            get canvas() { return self.#preview.canvas },
            get controls() { return self.#controls },
            get viewCenter() { return self.#viewCenter },
            get cameraRes() { return self.#cameraRes },
        })

        this.#pushPullController.onComplete = (nodeId: number, vertices: [number, number][]) => {
            this.pushPullComplete$.next({ nodeId, vertices })
        }

        this.#pushPullController.onCapComplete = (nodeId: number, newH: number, newPosY: number) => {
            this.capPullComplete$.next({ nodeId, newH, newPosY })
        }

        this.#pushPullController.onDeselect = () => {
            // Restore the normal selection buffer state
            this.#writeSelectionBuffer()
            this.#pushSelectionInfo()
        }

        // Intercept pointer events on the canvas for push/pull
        const canvas = this.#preview.canvas
        canvas.addEventListener("pointerdown", (e: PointerEvent) => {
            if (this.#pushPullController?.isActive && !this.#pushPullController.isDragging) {
                if (this.#pushPullController.handlePointerDown(e)) {
                    e.preventDefault()
                    e.stopPropagation()
                }
            }
        }, { capture: true })

        canvas.addEventListener("pointermove", (e: PointerEvent) => {
            if (this.#pushPullController?.isDragging) {
                if (this.#pushPullController.handlePointerMove(e)) {
                    e.preventDefault()
                    e.stopPropagation()
                }
            }
        }, { capture: true })

        canvas.addEventListener("pointerup", (e: PointerEvent) => {
            if (this.#pushPullController?.isDragging) {
                if (this.#pushPullController.handlePointerUp(e)) {
                    e.preventDefault()
                    e.stopPropagation()
                }
            }
        }, { capture: true })

        document.addEventListener("keydown", (e: KeyboardEvent) => {
            if (this.#pushPullController?.isActive) {
                this.#pushPullController.handleKeyDown(e)
            }
        })
    }

    startLoop() {
        if (this.#started) return
        this.#started = true
        requestAnimationFrame(this.update.bind(this))
    }

    #createBuffers() {
        this.#uniformBuffers.scene = this.#device.createBuffer({
            size: 16384,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
            label: "scene",
        })

        this.#exportBuffers.scene = this.#device.createBuffer({
            size: 16384,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "scene",
        })

        this.#uniformBuffers.camera = this.#device.createBuffer({
            size: 160, // Camera struct: transform(64) + position(16) + res(8) + zoom(4) + pad(4) + 3x lightDir vec3f(48) + viewCenter(8) + pad(8)
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "camera",
        })

        // Click detection buffers - includes hover fields
        this.#uniformBuffers.clickState = this.#device.createBuffer({
            size: 32, // vec2f clickPos (8) + u32 enabled (4) + u32 hoverEnabled (4) + vec2f hoverPos (8) + padding (8)
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "clickState",
        })

        this.#uniformBuffers.clickedObjectId = this.#device.createBuffer({
            size: 4, // atomic<u32> — shader writes clicked object ID here
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            label: "clickedObjectId",
        })

        this.#uniformBuffers.selectedObjectIds = this.#device.createBuffer({
            size: 4096, // 1024 u32s: boolean array indexed by object ID (0 = not selected, 1 = selected)
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            label: "selectedObjectIds",
        })

        // Color palette buffer: 32 colors × 3 floats (vec3f) = 384 bytes
        // Using vec3f in WGSL requires 16 byte alignment per element (4 floats)
        // So we need 32 × 16 = 512 bytes
        this.#uniformBuffers.colorPalette = this.#device.createBuffer({
            size: PALETTE_SIZE * 16, // 32 colors × 16 bytes (vec3f with alignment)
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "colorPalette",
        })

        // Initialize palette with default colors
        const paletteData = paletteToFloat32Array(DEFAULT_PALETTE)
        // Need to write with 16-byte alignment per color (4 floats per color, last is padding)
        const alignedData = new Float32Array(PALETTE_SIZE * 4)
        for (let i = 0; i < PALETTE_SIZE; i++) {
            alignedData[i * 4] = paletteData[i * 3]
            alignedData[i * 4 + 1] = paletteData[i * 3 + 1]
            alignedData[i * 4 + 2] = paletteData[i * 3 + 2]
            alignedData[i * 4 + 3] = 0.0 // padding
        }
        this.#device.queue.writeBuffer(this.#uniformBuffers.colorPalette, 0, alignedData)

        // View settings buffer: xrayMode (u32) + padding
        this.#uniformBuffers.viewSettings = this.#device.createBuffer({
            size: 16, // u32 + padding to 16 bytes for alignment
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "viewSettings",
        })

        // Outline settings buffer: mode (u32) + thickness (f32) + pad + color (vec3f)
        this.#uniformBuffers.outlineSettings = this.#device.createBuffer({
            size: 32, // u32(4) + f32(4) + pad(8) + vec3f(12) + pad(4) = 32
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "outlineSettings",
        })

        // Subtree AABB buffer for spatial culling during ray marching.
        // 128 entries × 32 bytes (center vec4f + halfExtent vec4f) = 4096 bytes.
        // Initialized with infinite half-extents so all guards pass (no culling) until
        // actual AABBs are computed asynchronously on the GPU.
        this.#uniformBuffers.subtreeAABBs = this.#device.createBuffer({
            size: AABB_BUFFER_SIZE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "subtreeAABBs",
        })
        this.#initAABBBufferInfinite()

        // Polygon vertex buffer: shared storage for all Polygon2D vertex data.
        // Each vertex is a vec2f (8 bytes). Populated during build(), updated during push/pull drag.
        this.#uniformBuffers.polygonVertices = this.#device.createBuffer({
            size: POLYGON_VERTEX_BUFFER_SIZE,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            label: "polygonVertices",
        })

        // Clicked hit position: written by fragment shader on click, read back for face picking.
        // Layout: vec3f position (12 bytes) + f32 t (4 bytes) = 16 bytes.
        this.#uniformBuffers.clickedHitPos = this.#device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            label: "clickedHitPos",
        })

        // Face selection uniform: tells the Extrude shader which face to highlight.
        // Layout: nodeId (u32) + faceIndex (u32) + mode (u32) + extrudeOffset (f32) = 16 bytes.
        this.#uniformBuffers.faceSelection = this.#device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "faceSelection",
        })

        this.#uniformBuffers.nodeParams = this.#device.createBuffer({
            size: NODE_PARAMS_BUFFER_SIZE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "nodeParams",
        })

        const EDGE_HIT_SIZE = 48
        const EDGE_HITS_SIZE = 96  // 2 slots for xray (front + back)
        const SELECTED_EDGES_HEADER = 16
        const SELECTED_EDGE_SIZE = 32
        const SELECTED_EDGES_COUNT = 16
        const SELECTED_EDGES_TOTAL = SELECTED_EDGES_HEADER + SELECTED_EDGES_COUNT * SELECTED_EDGE_SIZE

        this.#uniformBuffers.edgeHit = this.#device.createBuffer({
            size: EDGE_HITS_SIZE,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            label: "edgeHit",
        })
        this.#uniformBuffers.selectedEdges = this.#device.createBuffer({
            size: SELECTED_EDGES_TOTAL,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            label: "selectedEdges",
        })
        this.#uniformBuffers.hoverEdgeHit = this.#device.createBuffer({
            size: EDGE_HITS_SIZE,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            label: "hoverEdgeHit",
        })
        this.#uniformBuffers.hoveredEdge = this.#device.createBuffer({
            size: SELECTED_EDGES_TOTAL,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            label: "hoveredEdge",
        })
        this.#writeSelectedEdgesBuffer()
        this.#setHoveredEdge(null)
    }

    /** Fill the AABB buffer with infinite half-extents so guards never trigger (no culling). */
    #initAABBBufferInfinite() {
        const data = new Float32Array(MAX_AABB_SLOTS * 8)
        for (let i = 0; i < MAX_AABB_SLOTS; i++) {
            const base = i * 8
            // center = (0,0,0,0)
            // halfExtent = (9999,9999,9999,0)
            data[base + 4] = 9999
            data[base + 5] = 9999
            data[base + 6] = 9999
        }
        this.#device.queue.writeBuffer(this.#uniformBuffers.subtreeAABBs, 0, data)
    }

    /**
     * Ensure scene-resolution textures (color, ID, beam t_start) exist at the given size.
     * Called each frame with scene dimensions (which may be lower during camera movement).
     */
    #ensureRenderTextures(width: number, height: number) {
        // Skip if dimensions haven't changed
        if (width === this.#renderTextureWidth && height === this.#renderTextureHeight) {
            return
        }

        // Destroy old textures if they exist
        if (this.#colorTexture) this.#colorTexture.destroy()
        if (this.#idTexture) this.#idTexture.destroy()
        if (this.#tStartTexture) this.#tStartTexture.destroy()

        this.#colorTexture = this.#device.createTexture({
            label: "Preview Color (offscreen)",
            size: [width, height],
            format: this.#format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        })
        this.#idTexture = this.#device.createTexture({
            label: "Object ID",
            size: [width, height],
            format: "r32uint",
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        })
        this.#colorTextureView = this.#colorTexture.createView()
        this.#idTextureView = this.#idTexture.createView()

        // Beam optimization: create low-res t_start texture (one texel per 8x8 tile)
        const BEAM_TILE_SIZE = 8
        const tilesX = Math.ceil(width / BEAM_TILE_SIZE)
        const tilesY = Math.ceil(height / BEAM_TILE_SIZE)
        this.#tStartTexture = this.#device.createTexture({
            label: "Beam t_start (tile resolution)",
            size: [tilesX, tilesY],
            format: "r32float",
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
        })
        this.#tStartTextureView = this.#tStartTexture.createView()

        // Recreate outline bind group with new texture views
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

        // Recreate beam bind group with new t_start texture
        if (this.#beamPipeline) {
            this.#beamBindGroup = this.#device.createBindGroup({
                label: "beamPrePass",
                layout: this.#beamPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: this.#uniformBuffers.camera } },
                    { binding: 1, resource: this.#tStartTextureView },
                    { binding: 2, resource: { buffer: this.#uniformBuffers.subtreeAABBs } },
                    { binding: 3, resource: { buffer: this.#uniformBuffers.polygonVertices } },
                    { binding: 4, resource: { buffer: this.#uniformBuffers.nodeParams } },
                ],
            })
        }

        // Recreate preview bind group (references the t_start texture)
        // Bindings must match preview.wgsl declarations
        if (this.#pipeline) {
            this.#bindGroup = this.#device.createBindGroup({
                label: "scenePreview",
                layout: this.#pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 1, resource: { buffer: this.#uniformBuffers.camera } },
                    { binding: 2, resource: { buffer: this.#uniformBuffers.clickState } },
                    { binding: 3, resource: { buffer: this.#uniformBuffers.clickedObjectId } },
                    { binding: 4, resource: { buffer: this.#uniformBuffers.selectedObjectIds } },
                    { binding: 5, resource: { buffer: this.#uniformBuffers.colorPalette } },
                    { binding: 6, resource: { buffer: this.#uniformBuffers.viewSettings } },
                    { binding: 7, resource: this.#tStartTextureView },
                    { binding: 8, resource: { buffer: this.#uniformBuffers.subtreeAABBs } },
                    { binding: 9, resource: { buffer: this.#uniformBuffers.polygonVertices } },
                    { binding: 10, resource: { buffer: this.#uniformBuffers.clickedHitPos } },
                    { binding: 11, resource: { buffer: this.#uniformBuffers.faceSelection } },
                    { binding: 12, resource: { buffer: this.#uniformBuffers.nodeParams } },
                    { binding: 13, resource: { buffer: this.#uniformBuffers.edgeHit } },
                    { binding: 14, resource: { buffer: this.#uniformBuffers.selectedEdges } },
                    { binding: 15, resource: { buffer: this.#uniformBuffers.hoverEdgeHit } },
                    { binding: 16, resource: { buffer: this.#uniformBuffers.hoveredEdge } },
                ],
            })
        }

        this.#renderTextureWidth = width
        this.#renderTextureHeight = height
    }

    /**
     * Internal method to perform a single frame render.
     * @param waitForGPU If true, wait for GPU to complete before returning (for accurate benchmarking)
     */
    async #renderFrame(waitForGPU = false): Promise<void> {
        // Skip rendering if scene dimensions haven't been set yet (before ResizeObserver fires)
        if (this.#sceneWidth === 0 || this.#sceneHeight === 0) return
        // Skip if pipelines are not ready yet (async build in progress)
        if (!this.#pipeline) return

        this.#device.queue.writeBuffer(this.#uniformBuffers.camera, 0, this.#controls.viewTransform.data as BufferSource)
        this.#device.queue.writeBuffer(this.#uniformBuffers.camera, 64, this.#controls.cameraPosition.data as BufferSource)
        this.#device.queue.writeBuffer(this.#uniformBuffers.camera, 64 + 16, this.#cameraRes.data as BufferSource)
        this.#zoomBuf[0] = this.#controls.zoom
        this.#device.queue.writeBuffer(this.#uniformBuffers.camera, 64 + 16 + 8, this.#zoomBuf)

        // Pre-transform light directions from camera-space into scene-space on the CPU.
        // This eliminates 3 matrix-vector multiplies per pixel in the fragment shader.
        const camTransform = this.#controls.viewTransform
        const l1 = camTransform.transformVector(vec3(0.5, 0.6, 1.0).normalize())
        const l2 = camTransform.transformVector(vec3(-0.6, 0.3, 0.8).normalize())
        const l3 = camTransform.transformVector(vec3(0.1, -0.5, 0.9).normalize())
        // Each vec3f in uniform layout occupies 16 bytes (12 data + 4 padding).
        // lightDir1 at offset 96, lightDir2 at offset 112, lightDir3 at offset 128.
        const ld = this.#lightDirBuf
        ld[0] = l1.x; ld[1] = l1.y; ld[2] = l1.z; ld[3] = 0
        ld[4] = l2.x; ld[5] = l2.y; ld[6] = l2.z; ld[7] = 0
        ld[8] = l3.x; ld[9] = l3.y; ld[10] = l3.z; ld[11] = 0
        this.#device.queue.writeBuffer(this.#uniformBuffers.camera, 96, ld)
        this.#device.queue.writeBuffer(this.#uniformBuffers.camera, 144, this.#viewCenter.data as BufferSource)

        // Write view settings (xray mode + refinement steps + beam enabled)
        const refinementSteps = this.#resolutionScale < 1.0 ? 6 : 8
        const beamActive = this.#beamEnabled
        const vs = this.#viewSettingsBuf
        vs[0] = this.#xrayMode ? 1 : 0
        vs[1] = refinementSteps
        vs[2] = beamActive ? 1 : 0
        this.#device.queue.writeBuffer(this.#uniformBuffers.viewSettings, 0, vs)

        // Write outline settings (mode + thickness + color + canvasWidth)
        this.#outlineU32[0] = OUTLINE_MODE_VALUES[this.#outlineMode]
        this.#outlineThicknessF32[0] = this.#outlineThickness
        this.#outlineColorF32.set(this.#outlineColor)
        this.#outlineWidthF32[0] = this.#fullWidth
        this.#device.queue.writeBuffer(this.#uniformBuffers.outlineSettings, 0, this.#outlineBuf)

        const canvasTexture = this.#context.getCurrentTexture()
        // Offscreen scene textures use scene resolution (may be lower during camera movement);
        // the outline pass upscales them to the full-res canvas with bilinear interpolation.
        this.#ensureRenderTextures(this.#sceneWidth, this.#sceneHeight)

        const commandEncoder = this.#device.createCommandEncoder()

        // Pass 0: Beam pre-pass - march one ray per 8x8 tile through empty space
        if (beamActive && this.#beamPipeline && this.#beamBindGroup) {
            const BEAM_TILE_SIZE = 8
            const tilesX = Math.ceil(this.#sceneWidth / BEAM_TILE_SIZE)
            const tilesY = Math.ceil(this.#sceneHeight / BEAM_TILE_SIZE)
            const beamPass = commandEncoder.beginComputePass({ label: "Beam Pre-Pass" })
            beamPass.setPipeline(this.#beamPipeline)
            beamPass.setBindGroup(0, this.#beamBindGroup)
            beamPass.dispatchWorkgroups(
                Math.ceil(tilesX / 8),
                Math.ceil(tilesY / 8)
            )
            beamPass.end()
        }

        // Pass 1: Render scene to offscreen color + object ID textures (MRT, scene resolution)
        const scenePass = commandEncoder.beginRenderPass({
            colorAttachments: [
                {
                    view: this.#colorTextureView,
                    loadOp: "clear",
                    storeOp: "store",
                },
                {
                    view: this.#idTextureView,
                    loadOp: "clear",
                    storeOp: "store",
                    clearValue: { r: 0xFFFFFFFF, g: 0, b: 0, a: 0 },
                },
            ],
        })
        scenePass.setPipeline(this.#pipeline)
        scenePass.setBindGroup(0, this.#bindGroup)
        scenePass.draw(4)
        scenePass.end()

        // Pass 2: Outline post-process, compositing dark outline at selection boundaries
        const outlinePass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: canvasTexture.createView(),
                loadOp: "clear",
                storeOp: "store",
            }],
        })
        outlinePass.setPipeline(this.#outlinePipeline)
        outlinePass.setBindGroup(0, this.#outlineBindGroup)
        outlinePass.draw(4)
        outlinePass.end()

        this.#device.queue.submit([commandEncoder.finish()])

        if (waitForGPU) {
            await this.#device.queue.onSubmittedWorkDone()
        }
    }

    update(time: number): void {
        // Schedule next frame first
        requestAnimationFrame(t => this.update(t))

        // Only render when camera changed or scene needs update
        if (!this.#needsRender) {
            return
        }

        // Frame rate limiting: skip if rendering too fast
        const minFrameTime = 1000 / this.#targetFPS
        const timeSinceLastRender = time - this.#lastRenderEndTime
        if (timeSinceLastRender < minFrameTime) {
            return
        }

        // Clear dirty flag before rendering
        this.#needsRender = false

        // Perform the render (non-blocking for normal loop)
        this.#renderFrame(false)

        // Update FPS after actual render
        const now = performance.now()
        const deltaTime = now - this.#lastActualRenderTime
        if (deltaTime > 0 && this.#lastActualRenderTime > 0) {
            this.#framerate.update(1000 / deltaTime)
            this.#preview.updateFPS(this.#framerate.average)
        }
        this.#lastActualRenderTime = now
        this.#lastRenderEndTime = now
    }

    /** Request a re-render (e.g., after scene change) */
    requestRender(): void {
        this.#needsRender = true
    }

    /** Set the push/pull interaction mode ("slide" or "extrude"). */
    setPushPullMode(mode: PushPullMode): void {
        if (this.#pushPullController) {
            this.#pushPullController.mode = mode
        }
    }

    /**
     * Called when the camera moves (rotate, pan, zoom).
     * Drops to half resolution immediately for responsiveness,
     * then restores full resolution after movement settles.
     */
    #onCameraMovement(): void {
        if (!this.#cameraOptimization) return

        // Drop to reduced resolution on first movement
        if (this.#resolutionScale === 1.0) {
            this.#resolutionScale = this.#movementScale
            this.#applyResolutionScale()
        }

        // Reset the settle timer
        if (this.#movementTimer !== null) {
            clearTimeout(this.#movementTimer)
        }
        this.#movementTimer = setTimeout(() => {
            this.#movementTimer = null
            this.#resolutionScale = 1.0
            this.#applyResolutionScale()
            this.#needsRender = true
        }, this.#movementSettleMs)
    }

    /**
     * Applies the current resolution scale to scene dimensions and camera resolution.
     * The canvas always stays at full resolution; only the offscreen scene textures
     * are scaled, and the outline pass upscales them back to full resolution with
     * hardware bilinear interpolation.
     */
    #applyResolutionScale(): void {
        if (this.#fullWidth === 0 || this.#fullHeight === 0) return
        this.#preview.canvas.width = this.#fullWidth
        this.#preview.canvas.height = this.#fullHeight
        this.#sceneWidth = Math.max(1, Math.round(this.#fullWidth * this.#resolutionScale))
        this.#sceneHeight = Math.max(1, Math.round(this.#fullHeight * this.#resolutionScale))
        this.#cameraRes = vec2(this.#sceneWidth, this.#sceneHeight)
    }

    /**
     * Benchmark rendering performance by rendering n frames and measuring time.
     * @param frameCount Number of frames to render (default: 100)
     * @param waitForGPU If true, wait for GPU completion after each frame for accurate timing (default: true)
     * @returns Benchmark results with timing statistics
     */
    async benchmark(frameCount = 100, waitForGPU = true): Promise<{
        totalTime: number
        averageFrameTime: number
        minFrameTime: number
        maxFrameTime: number
        framesPerSecond: number
        frameTimes: number[]
    }> {
        const frameTimes: number[] = []
        const startTime = performance.now()

        // Ensure we have a valid scene before benchmarking
        if (!this.#pipeline) {
            throw new Error("Cannot benchmark: renderer not initialized. Call build() first.")
        }

        // Warm-up frame to ensure GPU is ready
        await this.#renderFrame(waitForGPU)

        // Benchmark loop
        for (let i = 0; i < frameCount; i++) {
            const frameStart = performance.now()
            await this.#renderFrame(waitForGPU)
            const frameEnd = performance.now()
            frameTimes.push(frameEnd - frameStart)
        }

        const endTime = performance.now()
        const totalTime = endTime - startTime

        // Calculate statistics
        const averageFrameTime = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length
        const minFrameTime = Math.min(...frameTimes)
        const maxFrameTime = Math.max(...frameTimes)
        const framesPerSecond = 1000 / averageFrameTime

        return {
            totalTime,
            averageFrameTime,
            minFrameTime,
            maxFrameTime,
            framesPerSecond,
            frameTimes,
        }
    }

    async #computeSceneBounds(searchMin: [number, number, number], searchMax: [number, number, number], stepMm: number) {
        // Quantize to microns for integer reduction.
        const SCALE = 1000

        const dimsX = Math.max(1, Math.ceil((searchMax[0] - searchMin[0]) / stepMm) + 1)
        const dimsY = Math.max(1, Math.ceil((searchMax[1] - searchMin[1]) / stepMm) + 1)
        const dimsZ = Math.max(1, Math.ceil((searchMax[2] - searchMin[2]) / stepMm) + 1)

        // Must match WGSL uniform layout for `BoundsUniforms` in `bounds.wgsl`.
        // Layout (uniform address space):
        // - searchMinStep: vec4f  @0   size 16
        // - searchMaxIso : vec4f  @16  size 16
        // - dims         : vec4u  @32  size 16
        // - scale        : f32    @48  size 4
        // - _pad0        : vec3f  @64  size 12 (but occupies 16 due to alignment)
        // Total size = 80 bytes.
        const uniformsData = new ArrayBuffer(80)
        // searchMinStep vec4f @0
        new Float32Array(uniformsData, 0, 4).set([searchMin[0], searchMin[1], searchMin[2], stepMm])
        // searchMaxIso vec4f @16
        new Float32Array(uniformsData, 16, 4).set([searchMax[0], searchMax[1], searchMax[2], 0.0])
        // dims vec4u @32
        new Uint32Array(uniformsData, 32, 4).set([dimsX >>> 0, dimsY >>> 0, dimsZ >>> 0, 0])
        // scale f32 @48
        new Float32Array(uniformsData, 48, 1).set([SCALE])

        const uniformBuffer = this.#helper.createBuffer(
            "BoundsUniforms",
            uniformsData.byteLength,
            GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        )
        this.#device.queue.writeBuffer(uniformBuffer, 0, uniformsData)

        // Output is one record per dispatched workgroup (see `TileBounds` in `bounds.wgsl`):
        //   minQ: vec4i (16) + maxQ: vec4i (16) + anyInside: u32 (4) + pad u32*3 (12) = 48 bytes
        const TILE_STRIDE_BYTES = 48

        const totalSamples = dimsX * dimsY * dimsZ
        const totalWorkgroups = Math.ceil(totalSamples / 256)
        const dispatchX = Math.min(totalWorkgroups, 65535)
        const dispatchY = Math.ceil(totalWorkgroups / dispatchX)
        const dispatchedWorkgroups = dispatchX * dispatchY

        const outSize = dispatchedWorkgroups * TILE_STRIDE_BYTES
        if (!Number.isFinite(outSize) || outSize <= 0) {
            throw new Error(
                `Bounds compute: invalid out buffer size (dims=${dimsX}x${dimsY}x${dimsZ} step=${stepMm} -> outSize=${outSize})`
            )
        }
        if (outSize > this.#device.limits.maxBufferSize) {
            throw new Error(
                `Bounds compute: out buffer too large (${outSize} bytes) for device maxBufferSize=${this.#device.limits.maxBufferSize}. Try increasing bounds step.`
            )
        }

        const outBuffer = this.#helper.createBuffer(
            "BoundsTiles",
            outSize,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
        )
        // No initialization needed: each dispatched workgroup writes exactly one record.

        const pipeline = this.#helper.createComputePipeline(this.#boundsShader, "computeBounds", "Bounds (compute)")
        const [, bindGroup] = this.#helper.createBindGroup(
            0,
            "Bounds BG",
            pipeline,
            [0, uniformBuffer],
            [1, outBuffer],
            [2, this.#uniformBuffers.subtreeAABBs],
            [3, this.#uniformBuffers.polygonVertices],
            [4, this.#uniformBuffers.faceSelection],
            [5, this.#uniformBuffers.nodeParams],
            [99, this.#uniformBuffers.selectedObjectIds]
        )

        const ce = this.#device.createCommandEncoder({ label: "bounds_compute" })
        const pass = this.#helper.beginComputePass(ce, pipeline, [0, bindGroup])
        pass.dispatchWorkgroups(dispatchX, dispatchY, 1)
        pass.end()
        this.#device.queue.submit([ce.finish()])
        await this.#device.queue.onSubmittedWorkDone()

        const outData = await this.#helper.readBufferData(outBuffer, outSize)
        const dv = new DataView(outData)

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

        const minX = minXq / SCALE
        const minY = minYq / SCALE
        const minZ = minZq / SCALE
        const maxX = maxXq / SCALE
        const maxY = maxYq / SCALE
        const maxZ = maxZq / SCALE

        return { min: [minX, minY, minZ] as const, max: [maxX, maxY, maxZ] as const }
    }

    async #computeSceneBoundsRefined() {
        // Coarse search over a generous region, then refine around result.
        const COARSE_HALF = 250
        const coarse = await this.#computeSceneBounds([-COARSE_HALF, -COARSE_HALF, -COARSE_HALF], [COARSE_HALF, COARSE_HALF, COARSE_HALF], 2.0)
        if (!coarse) return null

        const inflate = 4.0
        const min = [coarse.min[0] - inflate, coarse.min[1] - inflate, coarse.min[2] - inflate] as const
        const max = [coarse.max[0] + inflate, coarse.max[1] + inflate, coarse.max[2] + inflate] as const
        const refined = await this.#computeSceneBounds([min[0], min[1], min[2]], [max[0], max[1], max[2]], 0.5)
        return refined ?? coarse
    }

    async renderMesh(src: string): Promise<MeshData> {
        const trimmed = src.trim()
        if (this.#builtSrc !== trimmed) {
            this.build(trimmed)
        }

        // World units are millimeters (mm).
        // Voxel size is fixed; grid dimensions are derived from a computed scene AABB.
        const voxelSizeMm = 0.5
        const bounds = await this.#computeSceneBoundsRefined()
        if (!bounds) {
            throw new Error("Bounds compute found no inside samples; is the SDF empty or far from origin?")
        }

        // Slightly inflate bounds so we don't clip due to sampling/quantization.
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
            simplifyTargetRatio: 0.1,
            simplifyRegularize: false,
            simplifyLockBorder: true,
            simplifyPrune: false,
            simplifySparse: false,
            simplifyTargetError: 0.001,
            // simplifyErrorAbsolute: true,
        }
        console.log(
            `MDC export params: dim=${gridDimX}x${gridDimY}x${gridDimZ} voxel=${voxelSizeMm}mm bbox=[${minX.toFixed(
                3
            )},${minY.toFixed(3)},${minZ.toFixed(3)}]..[${maxX.toFixed(3)},${maxY.toFixed(3)},${maxZ.toFixed(3)}]`
        )

        const mdc = new MDCExport(this.#helper, params, this.#uniformBuffers.subtreeAABBs, this.#uniformBuffers.polygonVertices, this.#uniformBuffers.faceSelection, this.#uniformBuffers.nodeParams)

        // Create and show progress dialog
        const { ProgressDialog } = await import("./components/progress-dialog.mjs")
        const progressDialog = new ProgressDialog()
        const progressPromise = progressDialog.show()

        // Track cancellation state
        let cancelled = false

        // Create progress callback that updates the dialog
        const progressCallback: import("./export/mdc.mjs").ProgressCallback = {
            updateProgress: (phase: string, percentage: number) => {
                if (!cancelled) {
                    progressDialog.updateProgress(phase, percentage)
                }
            },
            get cancelled() {
                return cancelled || progressDialog.cancelled
            }
        }

        // Update cancelled flag when dialog is cancelled - use synchronous check
        // The promise resolves when cancelled, so we need to handle it immediately
        let cancellationHandled = false
        progressPromise.then(completed => {
            if (!completed && !cancellationHandled) {
                cancelled = true
                cancellationHandled = true
            }
        }).catch(() => {
            if (!cancellationHandled) {
                cancelled = true
                cancellationHandled = true
            }
        })

        let mesh: MeshData
        try {
            mesh = await mdc.export(this.#exportShader, progressCallback)
            if (!progressDialog.cancelled) {
                progressDialog.complete()
            }
            await progressPromise.catch(() => { }) // Wait for dialog to close, ignore errors

            return mesh
        } catch (err) {
            if (!progressDialog.cancelled) {
                progressDialog.complete()
            }
            await progressPromise.catch(() => { }) // Wait for dialog to close, ignore errors
            if (err instanceof Error && err.message.includes("cancelled")) {
                throw new Error("Mesh generation was cancelled")
            }
            throw err
        }
    }
}
