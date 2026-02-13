import { AveragedBuffer } from "./collections/averagedbuffer.mjs"
import { SettingsManager } from "./storage/settings.mjs"
import { PreviewWindow } from "./components/preview-window.mjs"
import { CameraController } from "./controls/camera-controller.mjs"
import { GPUHelper } from "./gpu/helper.mjs"
import { MDCParams, MDCExport } from "./export/mdc.mjs"
import { SceneInfo } from "./scene/scene.mjs"
import exportShader from "./shaders/mdc.wgsl"
import previewShader from "./shaders/preview.wgsl"
import beamShader from "./shaders/beam.wgsl"
import boundsShader from "./shaders/bounds.wgsl"
import outlineShader from "./shaders/outline.wgsl"
import { ShaderCompiler } from "./shaders/shader.mjs"
import { vec2, Vec2f, vec3 } from "./vecmat/vector.mjs"
import { MeshData } from "./export/export.mjs"
import { PALETTE_SIZE, DEFAULT_PALETTE, paletteToFloat32Array } from "./colorPalette.mjs"

class UniformBuffers {
    camera!: GPUBuffer
    scene!: GPUBuffer
    clickState!: GPUBuffer
    selectedObjectIds!: GPUBuffer
    clickedObjectId!: GPUBuffer
    colorPalette!: GPUBuffer
    viewSettings!: GPUBuffer
    outlineSettings!: GPUBuffer
}

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

export class SDFRenderer {
    #bindGroup!: GPUBindGroup
    #cameraRes!: Vec2f
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
    #pipeline!: GPURenderPipeline
    #preview: PreviewWindow
    #scene!: SceneInfo
    #started = false
    #uniformBuffers: UniformBuffers
    #selectedObjectIds: boolean[] = new Array<boolean>(1024).fill(false)
    #lastClickPos: Vec2f = vec2(0, 0)
    #exportBuffers: ExportBuffers
    #shaderCompiler!: ShaderCompiler
    #sceneShader!: GPUShaderModule
    #exportShader!: GPUShaderModule
    #boundsShader!: GPUShaderModule
    #helper!: GPUHelper
    #builtSrc: string | null = null
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
    #beamPipeline!: GPUComputePipeline
    #beamBindGroup!: GPUBindGroup
    #tStartTexture!: GPUTexture
    #tStartTextureView!: GPUTextureView

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
    #tabChangeListener: ((e: Event) => void) | null = null

    #savePreviewSettings(): void {
        this.#settings.setPreview({
            xrayMode: this.#xrayMode,
            cameraOptimization: this.#cameraOptimization,
            beamOptimization: this.#beamEnabled,
        })
    }

    #loadPreviewSettings(): void {
        const prev = this.#settings.getPreview()
        this.#xrayMode = prev.xrayMode
        this.#cameraOptimization = prev.cameraOptimization
        this.#beamEnabled = prev.beamOptimization
        this.#preview.xrayMode = this.#xrayMode
        this.onPreviewSettingsLoaded?.()
        this.#needsRender = true
    }

    /**
     * Callback invoked when object selection changes
     * Provides the array of currently selected object IDs
     */
    onSelectionChange?: (selectedIds: number[]) => void

    /** Called after preview settings are loaded (e.g. on document switch) so the UI can sync */
    onPreviewSettingsLoaded?: () => void

    get controls(): CameraController {
        return this.#controls
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
     * @param notify If true, trigger onSelectionChange callback (default: false to avoid loops)
     */
    setSelection(ids: number[], notify = false) {
        this.#selectedObjectIds.fill(false)
        for (const id of ids) {
            this.#selectedObjectIds[id] = true
        }
        this.#writeSelectionBuffer()

        if (notify && this.onSelectionChange) {
            this.onSelectionChange(this.selectedObjectIds)
        }
    }

    /**
     * Get all nodes from the current scene for matching with source code.
     */
    getSceneNodes() {
        return this.#scene?.getAllNodes() ?? []
    }

    async #readClickedObjectId(): Promise<number> {
        // Read back clicked object ID from storage buffer
        const readback = await this.#helper.readBufferData(this.#uniformBuffers.clickedObjectId, 4)
        return new Uint32Array(readback)[0]
    }

    #handleClick(screenPos: Vec2f, shiftKey: boolean) {
        // Convert screen coordinates to UV coordinates (0-1 range)
        const canvas = this.#preview.canvas
        const rect = canvas.getBoundingClientRect()
        const x = (screenPos.x - rect.left) / rect.width
        const y = 1.0 - (screenPos.y - rect.top) / rect.height // Flip Y for WGSL UV space

        this.#lastClickPos = vec2(x, y)

        console.log(`Click at UV: (${x.toFixed(3)}, ${y.toFixed(3)}), shift: ${shiftKey}`)

        // Store click state: must match WGSL ClickState struct layout
        const clickData = new ArrayBuffer(16)
        new Float32Array(clickData, 0, 2).set([x, y])
        new Uint32Array(clickData, 8, 1).set([1])
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickState, 0, clickData)

        // Clear clicked object ID buffer to sentinel value (0xFFFFFFFF = no hit)
        const NO_HIT_SENTINEL = 0xFFFFFFFF
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickedObjectId, 0, new Uint32Array([NO_HIT_SENTINEL]))

        // Trigger a render so the shader can evaluate the click
        this.#needsRender = true

        // Read back result after a few frames
        setTimeout(async () => {
            try {
                const clickedId = await this.#readClickedObjectId()
                if (clickedId !== NO_HIT_SENTINEL) {
                    this.#updateSelection(clickedId, shiftKey)
                } else {
                    // Clicked on empty space - deselect all
                    if (!shiftKey) {
                        this.#selectedObjectIds.fill(false)
                        this.#writeSelectionBuffer()
                        if (this.onSelectionChange) {
                            this.onSelectionChange([])
                        }
                        console.log('Deselected all objects (clicked empty space)')
                    } else {
                        console.log('No object clicked - clickedId was sentinel')
                    }
                }
            } catch (error) {
                console.error('Error reading clicked object ID:', error)
            }
        }, 200)
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

        // Notify listeners about selection change
        if (this.onSelectionChange) {
            this.onSelectionChange(this.selectedObjectIds)
        }
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

    constructor(preview: PreviewWindow, tabsElement?: EventTarget | null) {
        this.#preview = preview
        this.#controls = new CameraController(preview, vec3(0, 0, 0), 50, 0, Math.PI / 2, tabsElement)
        this.#controls.onSelect = (screenPos: Vec2f, shiftKey: boolean) => this.#handleClick(screenPos, shiftKey)
        this.#controls.onChange = () => {
            this.#needsRender = true
            this.#onCameraMovement()
        }
        this.#movementScale = this.#settings.getGlobal().preview.movementScale
        this.#documentName = (tabsElement as { active?: string })?.active ?? null
        this.#uniformBuffers = new UniformBuffers()
        this.#exportBuffers = new ExportBuffers()
        this.#initializing = this.initialize()
        this.#cameraRes = vec2(this.#preview.canvas.clientWidth, this.#preview.canvas.clientHeight)

        // Wire up xray mode change from preview window
        preview.onXrayModeChange = (enabled: boolean) => {
            this.xrayMode = enabled
        }

        this.#loadPreviewSettings()

        if (tabsElement) {
            this.#tabChangeListener = (e: Event) => {
                const customEvent = e as CustomEvent<string | undefined>
                // SettingsManager.switchDocument (called from DocumentTabs) handles
                // flushing the old doc and loading the new one. We just need to
                // reload our in-memory preview flags from the (already-switched) settings.
                this.#documentName = customEvent.detail ?? null
                this.#loadPreviewSettings()
            }
            tabsElement.addEventListener("activeTabChanged", this.#tabChangeListener)
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
    }

    build(src: string) {
        const trimmed = src.trim()
        this.#builtSrc = trimmed
        this.#scene = new SceneInfo(trimmed)
        const sceneSDF = this.#scene.compile()        // Full SDFResult (distance + gradient + normal + ID)
        const sceneSDF_fast = this.#scene.compileFast() // Fast vec2f (distance + gradient only)
        this.#shaderCompiler = new ShaderCompiler(this.#device)
            .replace("insert", "sceneSDF_fast", sceneSDF_fast)
            .replace("insert", "sceneSDF", sceneSDF)
        this.#sceneShader = this.#shaderCompiler.compile(previewShader, "Preview Window")
        this.#exportShader = this.#shaderCompiler.compile(exportShader, "Export")
        this.#boundsShader = this.#shaderCompiler.compile(boundsShader, "Bounds (scene bbox)")
        this.#beamShader = this.#shaderCompiler.compile(beamShader, "Beam Pre-Pass")
        this.#buildPreviewPipeline()
        this.#buildBeamPipeline()
        // Force render texture recreation so bind groups are rebuilt with new pipelines
        this.#renderTextureWidth = 0
        this.#renderTextureHeight = 0
        this.#needsRender = true

        // this.#scene.root.updateScene((index, data) => {
        //     this.#device.queue.writeBuffer(this.#uniformBuffers.scene, index * 16, data)
        //     // this.#device.queue.writeBuffer(this.#exportBuffers.scene, index * 16, data)
        // })
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
        // Initialize click detection buffers
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickState, 0, new Uint32Array([0, 0]))
        // Initialize clickedObjectId to sentinel value (0xFFFFFFFF = no hit)
        const NO_HIT_SENTINEL = 0xFFFFFFFF
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickedObjectId, 0, new Uint32Array([NO_HIT_SENTINEL]))
        // Initialize selection buffer with count=0
        this.#device.queue.writeBuffer(this.#uniformBuffers.selectedObjectIds, 0, new Uint32Array(1024))
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
            size: 144, // Camera struct: transform(64) + position(16) + res(8) + zoom(4) + pad(4) + 3x lightDir vec3f(48)
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "camera",
        })

        // Click detection buffers - pad to 16 bytes for alignment
        this.#uniformBuffers.clickState = this.#device.createBuffer({
            size: 16, // vec2f (8) + u32 (4) + u32 (4 padding) = 16
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "clickState",
        })

        this.#uniformBuffers.selectedObjectIds = this.#device.createBuffer({
            size: 4096, // 1024 u32s: boolean array indexed by object ID (0 = not selected, 1 = selected)
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            label: "selectedObjectIds",
        })

        this.#uniformBuffers.clickedObjectId = this.#device.createBuffer({
            size: 4, // u32
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            label: "clickedObjectId",
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
                ],
            })
        }

        // Recreate preview bind group (references the t_start texture)
        if (this.#pipeline) {
            this.#bindGroup = this.#device.createBindGroup({
                label: "scenePreview",
                layout: this.#pipeline.getBindGroupLayout(0),
                entries: [
                    // { binding: 0, resource: { buffer: this.#uniformBuffers.scene } },
                    { binding: 1, resource: { buffer: this.#uniformBuffers.camera } },
                    { binding: 2, resource: { buffer: this.#uniformBuffers.clickState } },
                    { binding: 3, resource: { buffer: this.#uniformBuffers.clickedObjectId } },
                    { binding: 4, resource: { buffer: this.#uniformBuffers.selectedObjectIds } },
                    { binding: 5, resource: { buffer: this.#uniformBuffers.colorPalette } },
                    { binding: 6, resource: { buffer: this.#uniformBuffers.viewSettings } },
                    { binding: 7, resource: this.#tStartTextureView },
                ],
            })
        }

        this.#renderTextureWidth = width
        this.#renderTextureHeight = height
    }

    #buildPreviewPipeline() {
        const format = this.#format
        this.#pipeline = this.#device.createRenderPipeline({
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
        })
        // Note: preview bind group is created in #ensureRenderTextures() because
        // it references the beam t_start texture which depends on canvas dimensions.
    }

    #buildBeamPipeline() {
        this.#beamPipeline = this.#device.createComputePipeline({
            label: "Beam Pre-Pass Pipeline",
            layout: "auto",
            compute: {
                module: this.#beamShader,
                entryPoint: "beamMarch",
            },
        })
    }

    /**
     * Internal method to perform a single frame render.
     * @param waitForGPU If true, wait for GPU to complete before returning (for accurate benchmarking)
     */
    async #renderFrame(waitForGPU = false): Promise<void> {
        // Skip rendering if scene dimensions haven't been set yet (before ResizeObserver fires)
        if (this.#sceneWidth === 0 || this.#sceneHeight === 0) return

        this.#device.queue.writeBuffer(this.#uniformBuffers.camera, 0, this.#controls.viewTransform.data as BufferSource)
        this.#device.queue.writeBuffer(this.#uniformBuffers.camera, 64, this.#controls.cameraPosition.data as BufferSource)
        this.#device.queue.writeBuffer(this.#uniformBuffers.camera, 64 + 16, this.#cameraRes.data as BufferSource)
        this.#device.queue.writeBuffer(this.#uniformBuffers.camera, 64 + 16 + 8, new Float32Array([this.#controls.zoom]))

        // Pre-transform light directions from camera-space into scene-space on the CPU.
        // This eliminates 3 matrix-vector multiplies per pixel in the fragment shader.
        const camTransform = this.#controls.viewTransform
        const l1 = camTransform.transformVector(vec3(0.5, 0.6, 1.0).normalize())
        const l2 = camTransform.transformVector(vec3(-0.6, 0.3, 0.8).normalize())
        const l3 = camTransform.transformVector(vec3(0.1, -0.5, 0.9).normalize())
        // Each vec3f in uniform layout occupies 16 bytes (12 data + 4 padding).
        // lightDir1 at offset 96, lightDir2 at offset 112, lightDir3 at offset 128.
        const lightDirs = new Float32Array([
            l1.x, l1.y, l1.z, 0,
            l2.x, l2.y, l2.z, 0,
            l3.x, l3.y, l3.z, 0,
        ])
        this.#device.queue.writeBuffer(this.#uniformBuffers.camera, 96, lightDirs)

        // Write view settings (xray mode + refinement steps + beam enabled)
        const refinementSteps = this.#resolutionScale < 1.0 ? 6 : 8
        const beamActive = this.#beamEnabled && this.#resolutionScale >= 1.0
        this.#device.queue.writeBuffer(this.#uniformBuffers.viewSettings, 0, new Uint32Array([
            this.#xrayMode ? 1 : 0,
            refinementSteps,
            beamActive ? 1 : 0,
        ]))

        // Write outline settings (mode + thickness + color + canvasWidth)
        const outlineData = new ArrayBuffer(32)
        new Uint32Array(outlineData, 0, 1).set([OUTLINE_MODE_VALUES[this.#outlineMode]])
        new Float32Array(outlineData, 4, 1).set([this.#outlineThickness])
        new Float32Array(outlineData, 16, 3).set(this.#outlineColor)
        new Float32Array(outlineData, 28, 1).set([this.#fullWidth])
        this.#device.queue.writeBuffer(this.#uniformBuffers.outlineSettings, 0, outlineData)

        const canvasTexture = this.#context.getCurrentTexture()
        // Offscreen scene textures use scene resolution (may be lower during camera movement);
        // the outline pass upscales them to the full-res canvas with bilinear interpolation.
        this.#ensureRenderTextures(this.#sceneWidth, this.#sceneHeight)

        const commandEncoder = this.#device.createCommandEncoder()

        // Pass 0: Beam pre-pass - march one ray per 8x8 tile through empty space
        // Skip beam during reduced-resolution rendering (camera movement) to avoid artifacts
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
            simplifyTargetRatio: 0.5,
            simplifyRegularize: false,
            simplifyLockBorder: false,
            simplifyPrune: true,
            simplifySparse: false,
            // simplifyErrorAbsolute: true,
        }
        console.log(
            `MDC export params: dim=${gridDimX}x${gridDimY}x${gridDimZ} voxel=${voxelSizeMm}mm bbox=[${minX.toFixed(
                3
            )},${minY.toFixed(3)},${minZ.toFixed(3)}]..[${maxX.toFixed(3)},${maxY.toFixed(3)},${maxZ.toFixed(3)}]`
        )

        const mdc = new MDCExport(this.#helper, params, this.#uniformBuffers.selectedObjectIds)

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
