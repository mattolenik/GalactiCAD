import { MESH_MDC_CELL_VERTEX_STRIDE, MESH_MDC_DEBUG_SAMPLE_STRIDE, MESH_MDC_QEF_PLANE_STRIDE, MeshData, type MeshMdcDebugStats } from "../export/export.mjs"
import { CameraController, DOLLY_REF } from "../controls/camera-controller.mjs"
import { GPUHelper } from "../gpu/helper.mjs"
import { scheduleShaderModuleCompilationLogging } from "../shaders/shader.mjs"
import { SettingsManager, type GlobalSettings } from "../storage/settings.mjs"
import { Mat4x4f } from "../vecmat/matrix.mjs"
import { vec2, Vec2f, vec3, Vec3f, vec4 } from "../vecmat/vector.mjs"

/** Must match RAY_ORIGIN_DEPTH in preview.wgsl. */
const PREVIEW_RAY_ORIGIN_DEPTH = 300

export class MeshViewer extends HTMLElement {
    static get observedAttributes() {
        return ["translucentFaces", "wireframe"]
    }
    readonly canvas: HTMLCanvasElement

    #bindGroup!: GPUBindGroup
    #cameraRes: Vec2f
    #context!: GPUCanvasContext
    #controls: CameraController
    #depthTexture: GPUTexture | null = null
    #oitAccumTexture: GPUTexture | null = null
    #oitRevealTexture: GPUTexture | null = null
    #device!: GPUDevice
    #format!: GPUTextureFormat
    #indexCount = 0
    #indexBuffer: GPUBuffer | null = null
    #edgeIndexCount = 0
    #edgeIndexBuffer: GPUBuffer | null = null
    #initializing: Promise<void> | null
    #pipelineOpaque!: GPURenderPipeline
    #pipelineTranslucent!: GPURenderPipeline // weighted blended OIT pass
    #compositePipeline!: GPURenderPipeline
    #pipelineWireframe!: GPURenderPipeline
    #started = false
    #uniformBuffer: GPUBuffer | null = null
    #vertexBuffer: GPUBuffer | null = null
    #pendingMesh: MeshData | null = null
    #helper!: GPUHelper
    #bindGroupLayout!: GPUBindGroupLayout
    #pipelineLayout!: GPUPipelineLayout
    #compositeBindGroupLayout!: GPUBindGroupLayout
    #compositePipelineLayout!: GPUPipelineLayout
    #compositeBindGroup: GPUBindGroup | null = null
    #shaderModuleOpaque!: GPUShaderModule
    #shaderModuleTranslucent!: GPUShaderModule
    #shaderModuleComposite!: GPUShaderModule
    #shaderModuleWireframe!: GPUShaderModule
    /** Stops the render loop and skips GPU work after disconnect. */
    #disposed = false

    #settings: SettingsManager
    #translucentFaces = false
    #viewCenter: Vec2f = vec2(0.5, 0.5)
    #wireframe = false
    /**
     * Render mode shared with the SDF preview's `previewNormalShading`: false =
     * regular lighting (matches SDF lit appearance), true = scene-space normal RGB.
     * Driven by the app from the single shared toggle (toolbar normal icon /
     * dev-tools lighting option); picked up on the next continuous-rAF frame.
     */
    #renderNormals = false
    /** Edge-overlay line color (RGB). Near-white in dark mode, near-black in light mode. */
    #wireframeColor: [number, number, number] = [0.95, 0.95, 0.98]
    /**
     * When set, `update()` renders the color passes into this view instead of the canvas swap chain.
     * Used by `captureFrameToImageData` to read pixels back via the GPU (`copyTextureToBuffer`) — the
     * canvas-compositing path (`createImageBitmap`) yields blank frames for an offscreen canvas in
     * headless Chromium (agent automation).
     */
    #captureTargetView: GPUTextureView | null = null
    #debugOverlayCanvas: HTMLCanvasElement
    #debugOverlayCtx: CanvasRenderingContext2D | null
    #hoverCanvasPos: { x: number; y: number } | null = null
    /** Bottom-left mesh-export progress row (spinner + phase/elapsed text + Cancel). */
    #exportSpinner!: HTMLDivElement
    #exportStatusText!: HTMLSpanElement
    #exportCancelBtn!: HTMLButtonElement
    #onExportCancel?: () => void
    /** Visible region (excludes editor overlay); used to keep the spinner clear of the editor. */
    #getInteractionRect?: () => DOMRect
    #mdcDebug = false
    /** Per-class feature glyph overlay toggles (MDC debug). */
    #mdcFeatureGlyphLine = false
    #mdcFeatureGlyphCorner = false
    #mdcFeatureGlyphSeam = false
    #mdcFeatureGlyphRing = false
    /** Per-cell-component vertex position overlay (MDC debug, post-mesh). */
    #mdcCellVerticesEnabled = false
    /** Per-(cell, component) QEF plane overlay (MDC debug, post-mesh). */
    #mdcQefPlanesEnabled = false
    #mdcDebugSamples: Float32Array<ArrayBuffer> = new Float32Array(0)
    #mdcDebugCellVertices: Float32Array<ArrayBuffer> = new Float32Array(0)
    #mdcDebugQefPlanes: Float32Array<ArrayBuffer> = new Float32Array(0)
    #mdcDebugStats: MeshMdcDebugStats | null = null

    /** Depth-tested MDC/QEF overlay (WebGPU); rebuilt each frame when enabled. */
    #mdcOverlayLineBuffer: GPUBuffer | null = null
    #mdcOverlayTriBuffer: GPUBuffer | null = null
    #mdcOverlayLineCapVerts = 0
    #mdcOverlayTriCapVerts = 0
    #mdcOverlayLineVertCount = 0
    #mdcOverlayTriVertCount = 0
    #mdcOverlayLineScratch = new Float32Array(0)
    #mdcOverlayTriScratch = new Float32Array(0)
    #shaderModuleMdcOverlay!: GPUShaderModule
    #shaderModuleDepthPrepassFrag!: GPUShaderModule
    #pipelineMdcOverlayLine!: GPURenderPipeline
    #pipelineMdcOverlayTri!: GPURenderPipeline
    #pipelineMeshDepthPrepass!: GPURenderPipeline
    /** Sample index under cursor; rebuilt with GPU overlay each frame. */
    #mdcOverlayHoveredSampleIdx = -1

    get controls(): CameraController {
        return this.#controls
    }

    /** Set the center of the visible (non-editor) area in UV space (0-1). */
    setViewCenter(x: number, y: number): void {
        this.#viewCenter = vec2(x, y)
        this.#controls.setViewCenter(x, y)
    }

    /**
     * Show the bottom-left mesh-export progress row, positioned at the left edge of the
     * visible (non-editor) viewport so it clears the editor overlay. `onCancel` fires on
     * the Cancel click; the button is hidden when `cancellable` is false (no shared-memory
     * cancel flag).
     */
    showExportProgress(opts: { cancellable: boolean; onCancel?: () => void }): void {
        let left = 0
        if (this.#getInteractionRect) {
            const canvasRect = this.canvas.getBoundingClientRect()
            left = Math.max(0, this.#getInteractionRect().left - canvasRect.left)
        }
        this.#exportSpinner.style.setProperty("--export-spinner-left", `${left}px`)
        this.#onExportCancel = opts.onCancel
        this.#exportCancelBtn.style.display = opts.cancellable ? "" : "none"
        this.#exportCancelBtn.disabled = false
        this.#exportSpinner.style.visibility = "visible"
    }

    /** Update the export-progress label, e.g. "Building octree • 12s". */
    setExportStatus(text: string): void {
        this.#exportStatusText.textContent = text
    }

    /** Hide the bottom-left mesh-export progress row. */
    hideExportProgress(): void {
        this.#exportSpinner.style.visibility = "hidden"
        this.#onExportCancel = undefined
    }

    /**
     * @param tabsElement Optional tabs for camera persistence wiring.
     * @param getInteractionRect When set, camera/trackball drags are accepted only inside this screen rect.
     *  Omit for a standalone mesh panel (e.g. app shell); use only when the canvas overlaps a clipped region.
     */
    constructor(tabsElement?: EventTarget | null, getInteractionRect?: () => DOMRect) {
        super()
        const shadow = this.attachShadow({ mode: "open" })

        this.#settings = SettingsManager.instance

        // Initial state: HTML attribute wins (used by agent capture), otherwise persisted settings.
        const attrTranslucent = this.getAttribute("translucentFaces")
        const attrWireframe = this.getAttribute("wireframe")
        const persisted = this.#settings.getGlobal().meshViewer
        this.#translucentFaces = attrTranslucent !== null
            ? attrTranslucent.toLowerCase() === "true"
            : persisted.translucentFaces
        this.#wireframe = attrWireframe !== null
            ? attrWireframe.toLowerCase() === "true"
            : persisted.wireframe
        this.#mdcDebug = !!persisted.mdcDebugPoints
        this.#mdcFeatureGlyphLine = !!persisted.featureGlyphs?.line
        this.#mdcFeatureGlyphCorner = !!persisted.featureGlyphs?.corner
        this.#mdcFeatureGlyphSeam = !!persisted.featureGlyphs?.seam
        this.#mdcFeatureGlyphRing = !!persisted.featureGlyphs?.ring
        this.#mdcCellVerticesEnabled = !!persisted.mdcCellVertices
        this.#mdcQefPlanesEnabled = !!persisted.mdcQefPlanes

        const style = document.createElement("style")
        style.textContent = `
        canvas {
            -webkit-tap-highlight-color: transparent;
            -webkit-touch-callout: none;    /* no long-press callout */
            -webkit-user-drag: none;        /* no “drag” highlight */
            -webkit-user-select: none;      /* no text selection */
            display: block;
            height: 100%;
            overscroll-behavior: none;
            touch-action: none;             /* no scrolling/pinch zoom */
            user-select: none;
            width: 100%;
        }
        :host { display: inline-block; position: relative; }
        .debug-canvas {
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 0;
        }
        .export-spinner {
            position: absolute;
            bottom: 10px;
            left: calc(10px + var(--export-spinner-left, 0px));
            pointer-events: none;
            z-index: 1;
            visibility: hidden;
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 11px;
            color: rgb(from var(--fg-color, whitesmoke) r g b / 0.8);
        }
        .export-spinner-icon { flex: none; display: block; }
        .export-spinner-icon svg {
            display: block;
            animation: mesh-export-spin 0.8s linear infinite;
        }
        @keyframes mesh-export-spin {
            to { transform: rotate(360deg); }
        }
        .export-cancel {
            pointer-events: auto;
            padding: 1px 7px;
            border: 1px solid rgb(from var(--fg-color, whitesmoke) r g b / 0.35);
            border-radius: 4px;
            background: transparent;
            color: inherit;
            font: inherit;
            cursor: pointer;
        }
        .export-cancel:hover { background: rgb(from var(--fg-color, whitesmoke) r g b / 0.12); }
`
        this.canvas = document.createElement("canvas")
        this.canvas.style.width = "100%"
        this.canvas.style.height = "100%"
        this.canvas.style.display = "inline-block"
        this.#debugOverlayCanvas = document.createElement("canvas")
        this.#debugOverlayCanvas.className = "debug-canvas"
        this.#debugOverlayCanvas.style.width = "100%"
        this.#debugOverlayCanvas.style.height = "100%"
        this.#debugOverlayCtx = this.#debugOverlayCanvas.getContext("2d")

        // Mesh-export progress: a bottom-left row — spinner ring + phase/elapsed text +
        // Cancel button (shown only when the export is cancellable).
        this.#getInteractionRect = getInteractionRect
        this.#exportSpinner = document.createElement("div")
        this.#exportSpinner.className = "export-spinner"
        const spinnerIcon = document.createElement("div")
        spinnerIcon.className = "export-spinner-icon"
        spinnerIcon.innerHTML =
            `<svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">` +
            `<circle cx="12" cy="12" r="9" fill="none" stroke="rgb(from var(--fg-color, whitesmoke) r g b / 0.2)" stroke-width="3"/>` +
            `<path d="M12 3 a9 9 0 0 1 9 9" fill="none" stroke="rgb(from var(--fg-color, whitesmoke) r g b / 0.8)" stroke-width="3" stroke-linecap="round"/>` +
            `</svg>`
        this.#exportStatusText = document.createElement("span")
        this.#exportStatusText.className = "export-status"
        this.#exportCancelBtn = document.createElement("button")
        this.#exportCancelBtn.className = "export-cancel"
        this.#exportCancelBtn.type = "button"
        this.#exportCancelBtn.textContent = "Cancel"
        this.#exportCancelBtn.addEventListener("click", () => {
            this.#exportCancelBtn.disabled = true
            this.#onExportCancel?.()
        })
        this.#exportSpinner.append(spinnerIcon, this.#exportStatusText, this.#exportCancelBtn)

        shadow.append(style, this.canvas, this.#debugOverlayCanvas, this.#exportSpinner)

        this.setAttribute("translucentFaces", this.#translucentFaces ? "true" : "false")
        this.setAttribute("wireframe", this.#wireframe ? "true" : "false")

        this.canvas.addEventListener("pointermove", event => {
            const rect = this.canvas.getBoundingClientRect()
            const sx = rect.width > 0 ? this.canvas.width / rect.width : 1
            const sy = rect.height > 0 ? this.canvas.height / rect.height : 1
            this.#hoverCanvasPos = {
                x: (event.clientX - rect.left) * sx,
                y: (event.clientY - rect.top) * sy,
            }
        })
        this.canvas.addEventListener("pointerleave", () => {
            this.#hoverCanvasPos = null
        })

        this.#cameraRes = vec2(this.canvas.clientWidth, this.canvas.clientHeight)
        this.#controls = new CameraController(this, vec3(0, 0, 0), DOLLY_REF, 0, Math.PI / 2, tabsElement ?? null, getInteractionRect)
        this.#initializing = this.#initialize()

        const observer = new ResizeObserver(entries => {
            requestAnimationFrame(() => {
                for (const entry of entries) {
                    const w = Math.max(1,
                        entry.devicePixelContentBoxSize?.[0].inlineSize ??
                        Math.round(entry.contentRect.width * devicePixelRatio)
                    )
                    const h = Math.max(1,
                        entry.devicePixelContentBoxSize?.[0].blockSize ??
                        Math.round(entry.contentRect.height * devicePixelRatio)
                    )
                    this.canvas.width = w
                    this.canvas.height = h
                    this.#debugOverlayCanvas.width = w
                    this.#debugOverlayCanvas.height = h
                    this.#cameraRes = vec2(w, h)
                }
                if (this.#device) {
                    this.#recreateAttachments()
                }
            })
        })
        try {
            observer.observe(this, { box: "device-pixel-content-box" })
        } catch {
            observer.observe(this, { box: "content-box" })
        }
    }

    disconnectedCallback(): void {
        this.#disposed = true
        this.#controls.dispose()
        void (async () => {
            try {
                await this.ready()
            } catch {
                return
            }
            this.#disposeGpu()
        })()
    }

    connectedCallback(): void {
        if (this.getAttribute("data-skip-autostart") != null) return
        this.startLoop()
    }

    async ready() {
        if (this.#initializing) {
            await this.#initializing
            this.#initializing = null
        }
    }

    async #initialize() {
        const helper = await GPUHelper.create()
        if (!helper) {
            throw new Error("No GPU adapter found", { cause: "unsupported" })
        }
        this.#helper = helper
        this.#device = helper.device
        this.#context = this.canvas.getContext("webgpu") as GPUCanvasContext

        this.#format = navigator.gpu.getPreferredCanvasFormat()
        this.#context.configure({
            device: this.#device,
            format: this.#format,
            alphaMode: "premultiplied",
        })

        this.#uniformBuffer = this.#device.createBuffer({
            label: "meshViewer.camera",
            // 160: viewCenter (vec2f), 176: lineColor (vec4f, 16-byte aligned) => 192 total.
            size: 192,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })

        this.#bindGroupLayout = this.#device.createBindGroupLayout({
            label: "meshViewer.bindGroupLayout",
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: "uniform" },
                },
            ],
        })
        this.#pipelineLayout = this.#device.createPipelineLayout({
            label: "meshViewer.pipelineLayout",
            bindGroupLayouts: [this.#bindGroupLayout],
        })

        this.#shaderModuleOpaque = this.#device.createShaderModule({
            label: "meshViewer.shader.opaque",
            code: MESH_SHADER_OPAQUE,
        })
        scheduleShaderModuleCompilationLogging(this.#shaderModuleOpaque, "meshViewer.shader.opaque", MESH_SHADER_OPAQUE)
        this.#shaderModuleTranslucent = this.#device.createShaderModule({
            label: "meshViewer.shader.translucent",
            code: MESH_SHADER_TRANSLUCENT,
        })
        scheduleShaderModuleCompilationLogging(this.#shaderModuleTranslucent, "meshViewer.shader.translucent", MESH_SHADER_TRANSLUCENT)
        this.#shaderModuleComposite = this.#device.createShaderModule({
            label: "meshViewer.shader.composite",
            code: COMPOSITE_SHADER,
        })
        scheduleShaderModuleCompilationLogging(this.#shaderModuleComposite, "meshViewer.shader.composite", COMPOSITE_SHADER)
        this.#shaderModuleWireframe = this.#device.createShaderModule({
            label: "meshViewer.shader.wireframe",
            code: MESH_SHADER_WIREFRAME,
        })
        scheduleShaderModuleCompilationLogging(this.#shaderModuleWireframe, "meshViewer.shader.wireframe", MESH_SHADER_WIREFRAME)

        this.#pipelineOpaque = this.#device.createRenderPipeline({
            label: "MeshViewer Pipeline (opaque)",
            layout: this.#pipelineLayout,
            vertex: {
                module: this.#shaderModuleOpaque,
                entryPoint: "vertexMain",
                buffers: [
                    {
                        arrayStride: 32,
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: "float32x3" }, // position
                            { shaderLocation: 1, offset: 16, format: "float32x3" }, // normal
                        ],
                    },
                ],
            },
            fragment: {
                module: this.#shaderModuleOpaque,
                entryPoint: "fragmentMain",
                targets: [{ format: this.#format }],
            },
            primitive: {
                topology: "triangle-list",
                // We flip X in clip-space to match PreviewWindow's screen convention,
                // which also flips winding; keep backface culling correct.
                frontFace: "ccw",
                cullMode: "none",
            },
            depthStencil: {
                format: "depth24plus",
                depthWriteEnabled: true,
                depthCompare: "less",
            },
        })

        this.#pipelineWireframe = this.#device.createRenderPipeline({
            label: "MeshViewer Pipeline (wireframe overlay)",
            layout: this.#pipelineLayout,
            vertex: {
                module: this.#shaderModuleWireframe,
                entryPoint: "vertexWireframe",
                buffers: [
                    {
                        arrayStride: 32,
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: "float32x3" }, // position
                            { shaderLocation: 1, offset: 16, format: "float32x3" }, // normal
                        ],
                    },
                ],
            },
            fragment: {
                module: this.#shaderModuleWireframe,
                entryPoint: "fragmentMain",
                targets: [{ format: this.#format }],
            },
            primitive: {
                topology: "line-list",
                frontFace: "ccw",
                cullMode: "none",
            },
            // Overlay edges share vertices with surface triangles, so their depth matches the
            // surface exactly along each edge. "less-equal" lets coincident visible edges win while
            // the surface still occludes edges on the far side. No depth write: edges are decoration.
            depthStencil: {
                format: "depth24plus",
                depthWriteEnabled: false,
                depthCompare: "less-equal",
            },
        })

        this.#shaderModuleDepthPrepassFrag = this.#device.createShaderModule({
            label: "meshViewer.shader.depthPrepassFrag",
            code: MESH_DEPTH_PREPASS_FRAG,
        })
        scheduleShaderModuleCompilationLogging(
            this.#shaderModuleDepthPrepassFrag,
            "meshViewer.shader.depthPrepassFrag",
            MESH_DEPTH_PREPASS_FRAG,
        )
        this.#pipelineMeshDepthPrepass = this.#device.createRenderPipeline({
            label: "MeshViewer Pipeline (depth prepass)",
            layout: this.#pipelineLayout,
            vertex: {
                module: this.#shaderModuleOpaque,
                entryPoint: "vertexMain",
                buffers: [
                    {
                        arrayStride: 32,
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: "float32x3" },
                            { shaderLocation: 1, offset: 16, format: "float32x3" },
                        ],
                    },
                ],
            },
            fragment: {
                module: this.#shaderModuleDepthPrepassFrag,
                entryPoint: "fragmentMain",
                targets: [{ format: this.#format, writeMask: 0 }],
            },
            primitive: {
                topology: "triangle-list",
                frontFace: "ccw",
                cullMode: "none",
            },
            depthStencil: {
                format: "depth24plus",
                depthWriteEnabled: true,
                depthCompare: "less",
            },
        })

        this.#shaderModuleMdcOverlay = this.#device.createShaderModule({
            label: "meshViewer.shader.mdcOverlay",
            code: MDC_OVERLAY_SHADER,
        })
        scheduleShaderModuleCompilationLogging(this.#shaderModuleMdcOverlay, "meshViewer.shader.mdcOverlay", MDC_OVERLAY_SHADER)
        const mdcOverlayBlend: GPUBlendState = {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
        }
        this.#pipelineMdcOverlayLine = this.#device.createRenderPipeline({
            label: "MeshViewer Pipeline (mdc overlay lines)",
            layout: this.#pipelineLayout,
            vertex: {
                module: this.#shaderModuleMdcOverlay,
                entryPoint: "vertexMain",
                buffers: [
                    {
                        arrayStride: 32,
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: "float32x3" },
                            { shaderLocation: 1, offset: 16, format: "float32x4" },
                        ],
                    },
                ],
            },
            fragment: {
                module: this.#shaderModuleMdcOverlay,
                entryPoint: "fragmentMain",
                targets: [{ format: this.#format, blend: mdcOverlayBlend }],
            },
            primitive: { topology: "line-list", frontFace: "ccw", cullMode: "none" },
            depthStencil: {
                format: "depth24plus",
                depthWriteEnabled: true,
                depthCompare: "less",
            },
        })
        this.#pipelineMdcOverlayTri = this.#device.createRenderPipeline({
            label: "MeshViewer Pipeline (mdc overlay tris)",
            layout: this.#pipelineLayout,
            vertex: {
                module: this.#shaderModuleMdcOverlay,
                entryPoint: "vertexMain",
                buffers: [
                    {
                        arrayStride: 32,
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: "float32x3" },
                            { shaderLocation: 1, offset: 16, format: "float32x4" },
                        ],
                    },
                ],
            },
            fragment: {
                module: this.#shaderModuleMdcOverlay,
                entryPoint: "fragmentMain",
                targets: [{ format: this.#format, blend: mdcOverlayBlend }],
            },
            primitive: { topology: "triangle-list", frontFace: "ccw", cullMode: "none" },
            depthStencil: {
                format: "depth24plus",
                depthWriteEnabled: true,
                depthCompare: "less",
            },
        })

        this.#pipelineTranslucent = this.#device.createRenderPipeline({
            label: "MeshViewer Pipeline (translucent)",
            layout: this.#pipelineLayout,
            vertex: {
                module: this.#shaderModuleTranslucent,
                entryPoint: "vertexMain",
                buffers: [
                    {
                        arrayStride: 32,
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: "float32x3" }, // position
                            { shaderLocation: 1, offset: 16, format: "float32x3" }, // normal
                        ],
                    },
                ],
            },
            fragment: {
                module: this.#shaderModuleTranslucent,
                entryPoint: "fragmentMain",
                targets: [
                    {
                        format: "rgba16float",
                        // Accumulation buffer: additive blending.
                        blend: {
                            color: { operation: "add", srcFactor: "one", dstFactor: "one" },
                            alpha: { operation: "add", srcFactor: "one", dstFactor: "one" },
                        },
                    },
                    {
                        format: "rgba16float",
                        // Revealage buffer: multiplicative blending via dst *= (1 - srcAlpha).
                        blend: {
                            color: { operation: "add", srcFactor: "zero", dstFactor: "one-minus-src-alpha" },
                            alpha: { operation: "add", srcFactor: "zero", dstFactor: "one-minus-src-alpha" },
                        },
                    },
                ],
            },
            primitive: {
                topology: "triangle-list",
                frontFace: "ccw",
                // Show both sides for an "x-ray" look; OIT keeps it stable.
                cullMode: "none",
            },
        })

        this.#compositeBindGroupLayout = this.#device.createBindGroupLayout({
            label: "meshViewer.compositeBindGroupLayout",
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: "unfilterable-float" },
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: "unfilterable-float" },
                },
            ],
        })
        this.#compositePipelineLayout = this.#device.createPipelineLayout({
            label: "meshViewer.compositePipelineLayout",
            bindGroupLayouts: [this.#compositeBindGroupLayout],
        })
        this.#compositePipeline = this.#device.createRenderPipeline({
            label: "MeshViewer Pipeline (translucent composite)",
            layout: this.#compositePipelineLayout,
            vertex: { module: this.#shaderModuleComposite, entryPoint: "vertexMain" },
            fragment: {
                module: this.#shaderModuleComposite,
                entryPoint: "fragmentMain",
                targets: [{ format: this.#format }],
            },
            primitive: { topology: "triangle-list", cullMode: "none" },
        })

        this.#bindGroup = this.#device.createBindGroup({
            label: "meshViewer.bindGroup",
            layout: this.#bindGroupLayout,
            entries: [{ binding: 0, resource: { buffer: this.#uniformBuffer } }],
        })

        this.#recreateAttachments()

        if (this.#pendingMesh) {
            const mesh = this.#pendingMesh
            this.#pendingMesh = null
            this.#uploadMesh(mesh)
        }
    }

    #disposeGpu(): void {
        if (!this.#device) return
        // WebGPU: call destroy() only on GPUBuffer / GPUTexture. Pipelines, layouts, shader modules,
        // and bind groups have no destroy(); they are released when this instance is collected.
        try {
            this.#context.unconfigure()
        } catch {
            /* ignore */
        }
        this.#compositeBindGroup = null
        this.#mdcOverlayLineBuffer?.destroy()
        this.#mdcOverlayLineBuffer = null
        this.#mdcOverlayTriBuffer?.destroy()
        this.#mdcOverlayTriBuffer = null
        this.#mdcOverlayLineCapVerts = 0
        this.#mdcOverlayTriCapVerts = 0
        this.#depthTexture?.destroy()
        this.#depthTexture = null
        this.#oitAccumTexture?.destroy()
        this.#oitAccumTexture = null
        this.#oitRevealTexture?.destroy()
        this.#oitRevealTexture = null
        this.#vertexBuffer?.destroy()
        this.#vertexBuffer = null
        this.#indexBuffer?.destroy()
        this.#indexBuffer = null
        this.#edgeIndexBuffer?.destroy()
        this.#edgeIndexBuffer = null
        this.#uniformBuffer?.destroy()
        this.#uniformBuffer = null
    }

    #recreateAttachments() {
        if (this.#disposed) return
        this.#depthTexture?.destroy()
        this.#depthTexture = this.#device.createTexture({
            label: "meshViewer.depth",
            size: { width: Math.max(1, this.canvas.width), height: Math.max(1, this.canvas.height) },
            format: "depth24plus",
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        })

        this.#oitAccumTexture?.destroy()
        this.#oitRevealTexture?.destroy()
        const size = { width: Math.max(1, this.canvas.width), height: Math.max(1, this.canvas.height) }
        this.#oitAccumTexture = this.#device.createTexture({
            label: "meshViewer.oitAccum",
            size,
            format: "rgba16float",
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        })
        this.#oitRevealTexture = this.#device.createTexture({
            label: "meshViewer.oitReveal",
            size,
            format: "rgba16float",
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        })
        if (this.#compositeBindGroupLayout) {
            this.#compositeBindGroup = this.#device.createBindGroup({
                label: "meshViewer.compositeBindGroup",
                layout: this.#compositeBindGroupLayout,
                entries: [
                    { binding: 0, resource: this.#oitAccumTexture.createView() },
                    { binding: 1, resource: this.#oitRevealTexture.createView() },
                ],
            })
        }
    }

    async setMesh(mesh: MeshData) {
        this.#pendingMesh = mesh
        await this.ready()
        if (!this.#pendingMesh) return

        const meshToUpload = this.#pendingMesh
        this.#pendingMesh = null
        this.#mdcDebugSamples = meshToUpload.debug?.mdc?.samples ?? new Float32Array(0)
        this.#mdcDebugCellVertices = meshToUpload.debug?.mdc?.cellVertices ?? new Float32Array(0)
        this.#mdcDebugQefPlanes = meshToUpload.debug?.mdc?.qefPlanes ?? new Float32Array(0)
        this.#mdcDebugStats = meshToUpload.debug?.mdc?.stats ?? null
        this.#uploadMesh(meshToUpload)
    }

    #uploadMesh(mesh: MeshData) {
        if (this.#disposed) return
        const { verts, tris } = mesh

        this.#indexCount = tris.length
        if (this.#indexCount === 0 || verts.length === 0) {
            this.#vertexBuffer?.destroy()
            this.#indexBuffer?.destroy()
            this.#edgeIndexBuffer?.destroy()
            this.#vertexBuffer = null
            this.#indexBuffer = null
            this.#edgeIndexBuffer = null
            this.#indexCount = 0
            this.#edgeIndexCount = 0
            this.#clearDebugOverlay()
            return
        }

        // Upload vertex buffer (layout: [px,py,pz,pad,nx,ny,nz,pad] * N).
        if (!this.#vertexBuffer || this.#vertexBuffer.size !== verts.byteLength) {
            this.#vertexBuffer?.destroy()
            this.#vertexBuffer = this.#device.createBuffer({
                label: "meshViewer.vertices",
                size: verts.byteLength,
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            })
        }
        this.#device.queue.writeBuffer(this.#vertexBuffer, 0, verts)

        // Upload index buffer.
        if (!this.#indexBuffer || this.#indexBuffer.size !== tris.byteLength) {
            this.#indexBuffer?.destroy()
            this.#indexBuffer = this.#device.createBuffer({
                label: "meshViewer.indices",
                size: tris.byteLength,
                usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
            })
        }
        this.#device.queue.writeBuffer(this.#indexBuffer, 0, tris)

        // Build + upload edge index buffer for wireframe (line-list).
        const triCount = Math.floor(tris.length / 3)
        this.#edgeIndexCount = triCount * 6
        const edges = new Uint32Array(this.#edgeIndexCount)
        for (let t = 0; t < triCount; t++) {
            const i0 = tris[t * 3]!
            const i1 = tris[t * 3 + 1]!
            const i2 = tris[t * 3 + 2]!
            const o = t * 6
            edges[o] = i0
            edges[o + 1] = i1
            edges[o + 2] = i1
            edges[o + 3] = i2
            edges[o + 4] = i2
            edges[o + 5] = i0
        }
        if (!this.#edgeIndexBuffer || this.#edgeIndexBuffer.size !== edges.byteLength) {
            this.#edgeIndexBuffer?.destroy()
            this.#edgeIndexBuffer = this.#device.createBuffer({
                label: "meshViewer.edgeIndices",
                size: edges.byteLength,
                usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
            })
        }
        this.#device.queue.writeBuffer(this.#edgeIndexBuffer, 0, edges)
    }

    startLoop() {
        if (this.#started) return
        this.#started = true
        requestAnimationFrame(() => this.update(true))
    }

    update(scheduleNext = true): void {
        if (this.#disposed) return

        if (!this.#device || !this.#uniformBuffer) {
            this.#clearDebugOverlay()
            if (!this.#disposed) requestAnimationFrame(() => this.update(true))
            return
        }

        // Skip rendering if canvas is collapsed (0x0 size)
        if (this.canvas.width === 0 || this.canvas.height === 0) {
            this.#clearDebugOverlay()
            if (!this.#disposed) requestAnimationFrame(() => this.update(true))
            return
        }

        // Match preview.wgsl exactly: it transforms camera-space ray origins with viewTransform,
        // so raster projection uses the inverse to bring scene-space vertices back to camera space.
        const sceneToCamera = this.#controls.viewTransform.inverse()
        const meshCameraOrigin = this.#controls.cameraPosition.add(vec3(0, 0, PREVIEW_RAY_ORIGIN_DEPTH))
        this.#device.queue.writeBuffer(this.#uniformBuffer, 0, sceneToCamera.data as BufferSource)
        this.#device.queue.writeBuffer(this.#uniformBuffer, 64, meshCameraOrigin.data as BufferSource)
        this.#device.queue.writeBuffer(this.#uniformBuffer, 64 + 16, this.#cameraRes.data as BufferSource)
        this.#device.queue.writeBuffer(this.#uniformBuffer, 64 + 16 + 8, new Float32Array([this.#controls.zoom]))
        // Provide camera-space -> scene-space so lighting can move with the camera (matching PreviewWindow).
        const camToScene = this.#controls.viewTransform
        this.#device.queue.writeBuffer(this.#uniformBuffer, 96, camToScene.data as BufferSource)
        // 160: viewCenter (vec2f), 168: shadeMode (f32), 172: pad. One 16-byte write.
        this.#device.queue.writeBuffer(
            this.#uniformBuffer,
            160,
            new Float32Array([this.#viewCenter.x, this.#viewCenter.y, this.#renderNormals ? 1 : 0, 0]),
        )
        const [lr, lg, lb] = this.#wireframeColor
        this.#device.queue.writeBuffer(this.#uniformBuffer, 176, new Float32Array([lr, lg, lb, 1]))

        this.#rebuildMdcOverlayFrameData(sceneToCamera, meshCameraOrigin)
        const mdcOverlayGeo = this.#mdcOverlayLineVertCount > 0 || this.#mdcOverlayTriVertCount > 0

        const commandEncoder = this.#device.createCommandEncoder()
        // Base shaded render (opaque or translucent). When #wireframe is set, an edge overlay
        // pass is appended afterward to draw lines on top of the shaded surface.
        if (this.#translucentFaces) {
            if (!this.#oitAccumTexture || !this.#oitRevealTexture || !this.#compositeBindGroup) {
                this.#recreateAttachments()
            }

            // When MDC debug geometry or the wireframe overlay is shown, prime the shared depth
            // texture with the opaque mesh so glyphs / QEF markers / edges depth-test against the
            // surface after the OIT composite (OIT itself does not write the shared depth buffer).
            if ((mdcOverlayGeo || this.#wireframe) && this.#depthTexture) {
                const depthPre = commandEncoder.beginRenderPass({
                    colorAttachments: [
                        {
                            view: this.#colorAttachmentView(),
                            loadOp: "clear",
                            storeOp: "store",
                            clearValue: { r: 0, g: 0, b: 0, a: 0 },
                        },
                    ],
                    depthStencilAttachment: {
                        view: this.#depthTexture.createView(),
                        depthClearValue: 1.0,
                        depthLoadOp: "clear",
                        depthStoreOp: "store",
                    },
                })
                depthPre.setPipeline(this.#pipelineMeshDepthPrepass)
                depthPre.setBindGroup(0, this.#bindGroup)
                if (this.#vertexBuffer && this.#indexBuffer && this.#indexCount > 0) {
                    depthPre.setVertexBuffer(0, this.#vertexBuffer)
                    depthPre.setIndexBuffer(this.#indexBuffer, "uint32")
                    depthPre.drawIndexed(this.#indexCount)
                }
                depthPre.end()
            }

            // Pass 1: weighted blended OIT into offscreen buffers.
            const oitPass = commandEncoder.beginRenderPass({
                colorAttachments: [
                    {
                        view: this.#oitAccumTexture!.createView(),
                        loadOp: "clear",
                        storeOp: "store",
                        clearValue: { r: 0, g: 0, b: 0, a: 0 },
                    },
                    {
                        view: this.#oitRevealTexture!.createView(),
                        loadOp: "clear",
                        storeOp: "store",
                        // Revealage starts at 1 and gets multiplied by (1 - alpha) per fragment.
                        clearValue: { r: 0, g: 0, b: 0, a: 1 },
                    },
                ],
            })
            oitPass.setPipeline(this.#pipelineTranslucent)
            oitPass.setBindGroup(0, this.#bindGroup)
            if (this.#vertexBuffer && this.#indexBuffer && this.#indexCount > 0) {
                oitPass.setVertexBuffer(0, this.#vertexBuffer)
                oitPass.setIndexBuffer(this.#indexBuffer, "uint32")
                oitPass.drawIndexed(this.#indexCount)
            }
            oitPass.end()

            // Pass 2: composite OIT buffers onto the canvas.
            const compositePass = commandEncoder.beginRenderPass({
                colorAttachments: [
                    {
                        view: this.#colorAttachmentView(),
                        loadOp: "clear",
                        storeOp: "store",
                        clearValue: { r: 0, g: 0, b: 0, a: 0 },
                    },
                ],
            })
            compositePass.setPipeline(this.#compositePipeline)
            compositePass.setBindGroup(0, this.#compositeBindGroup)
            compositePass.draw(3)
            compositePass.end()

            if (mdcOverlayGeo && this.#depthTexture) {
                const overlayPass = commandEncoder.beginRenderPass({
                    colorAttachments: [
                        {
                            view: this.#colorAttachmentView(),
                            loadOp: "load",
                            storeOp: "store",
                        },
                    ],
                    depthStencilAttachment: {
                        view: this.#depthTexture.createView(),
                        depthLoadOp: "load",
                        depthStoreOp: "store",
                    },
                })
                this.#encodeMdcOverlayDraws(overlayPass)
                overlayPass.end()
            }
        } else {
            // Opaque pass (existing).
            const renderPass = commandEncoder.beginRenderPass({
                colorAttachments: [
                    {
                        view: this.#colorAttachmentView(),
                        loadOp: "clear",
                        storeOp: "store",
                        clearValue: { r: 0, g: 0, b: 0, a: 0 },
                    },
                ],
                depthStencilAttachment: this.#depthTexture
                    ? {
                        view: this.#depthTexture.createView(),
                        depthClearValue: 1.0,
                        depthLoadOp: "clear",
                        depthStoreOp: "store",
                    }
                    : undefined,
            })

            renderPass.setPipeline(this.#pipelineOpaque)
            renderPass.setBindGroup(0, this.#bindGroup)

            if (this.#vertexBuffer && this.#indexBuffer && this.#indexCount > 0) {
                renderPass.setVertexBuffer(0, this.#vertexBuffer)
                renderPass.setIndexBuffer(this.#indexBuffer, "uint32")
                renderPass.drawIndexed(this.#indexCount)
            }

            this.#encodeMdcOverlayDraws(renderPass)
            renderPass.end()
        }

        // Wireframe overlay: draw mesh edges on top of the shaded surface. The base pass left the
        // surface depth in #depthTexture (opaque pass, or the OIT depth-prime above), so the edge
        // pass depth-tests (less-equal) and only visible edges show through.
        if (this.#wireframe && this.#depthTexture && this.#vertexBuffer && this.#edgeIndexBuffer && this.#edgeIndexCount > 0) {
            const overlayPass = commandEncoder.beginRenderPass({
                colorAttachments: [
                    {
                        view: this.#colorAttachmentView(),
                        loadOp: "load",
                        storeOp: "store",
                    },
                ],
                depthStencilAttachment: {
                    view: this.#depthTexture.createView(),
                    depthLoadOp: "load",
                    depthStoreOp: "store",
                },
            })
            overlayPass.setPipeline(this.#pipelineWireframe)
            overlayPass.setBindGroup(0, this.#bindGroup)
            overlayPass.setVertexBuffer(0, this.#vertexBuffer)
            overlayPass.setIndexBuffer(this.#edgeIndexBuffer, "uint32")
            overlayPass.drawIndexed(this.#edgeIndexCount)
            overlayPass.end()
        }

        this.#device.queue.submit([commandEncoder.finish()])
        this.#drawMdcDebugOverlay(sceneToCamera, meshCameraOrigin)

        if (scheduleNext && !this.#disposed) requestAnimationFrame(() => this.update(true))
    }

    /**
     * Renders one frame (normal RGB surface, plus the edge overlay / translucent faces when enabled)
     * and reads pixels for automation.
     *
     * Renders into an offscreen texture we own and reads it back with `copyTextureToBuffer`, rather
     * than snapshotting the canvas with `createImageBitmap`. An offscreen (`left:-9999px`) WebGPU
     * canvas is never composited in headless Chromium, so `createImageBitmap(canvas)` returned a
     * constant blank frame for agent automation; a GPU readback is deterministic and presentation-free.
     */
    async captureFrameToImageData(): Promise<ImageData> {
        await this.ready()
        if (!this.#device) {
            throw new Error("Mesh viewer GPU not ready")
        }
        const w = Math.max(1, this.canvas.width)
        const h = Math.max(1, this.canvas.height)

        const captureTexture = this.#device.createTexture({
            label: "meshViewer.capture",
            size: { width: w, height: h },
            format: this.#format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        })
        // copyTextureToBuffer requires bytesPerRow to be a multiple of 256.
        const unpaddedBytesPerRow = w * 4
        const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256

        try {
            // Route update()'s color passes into the capture texture, render one frame, then detach
            // immediately (synchronous) so a concurrent rAF loop can't target the texture mid-readback.
            this.#captureTargetView = captureTexture.createView()
            this.update(false)
            this.#captureTargetView = null

            const staging = this.#device.createBuffer({
                label: "meshViewer.capture.staging",
                size: bytesPerRow * h,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            })
            try {
                const ce = this.#device.createCommandEncoder()
                ce.copyTextureToBuffer(
                    { texture: captureTexture },
                    { buffer: staging, bytesPerRow, rowsPerImage: h },
                    { width: w, height: h },
                )
                this.#device.queue.submit([ce.finish()])
                await staging.mapAsync(GPUMapMode.READ)
                const padded = new Uint8Array(staging.getMappedRange())
                // The preferred canvas format is typically bgra8unorm; ImageData wants RGBA. Repack
                // tightly (drop per-row padding) and swizzle B<->R when the texture is BGRA.
                const bgra = this.#format === "bgra8unorm"
                const out = new Uint8ClampedArray(w * h * 4)
                for (let y = 0; y < h; y++) {
                    const srcRow = y * bytesPerRow
                    const dstRow = y * w * 4
                    for (let x = 0; x < w; x++) {
                        const s = srcRow + x * 4
                        const d = dstRow + x * 4
                        if (bgra) {
                            out[d] = padded[s + 2]!
                            out[d + 1] = padded[s + 1]!
                            out[d + 2] = padded[s]!
                        } else {
                            out[d] = padded[s]!
                            out[d + 1] = padded[s + 1]!
                            out[d + 2] = padded[s + 2]!
                        }
                        out[d + 3] = padded[s + 3]!
                    }
                }
                staging.unmap()
                return new ImageData(out, w, h)
            } finally {
                staging.destroy()
            }
        } finally {
            this.#captureTargetView = null
            captureTexture.destroy()
        }
    }

    /** Keep orthographic projection in sync when canvas backing store size is set directly (agent capture). */
    syncCameraResolutionFromCanvas(): void {
        this.#cameraRes = vec2(this.canvas.width, this.canvas.height)
        // Keep the stacked 2D overlay canvas in sync with the WebGPU canvas
        // dimensions. The interactive path normally relies on the
        // `ResizeObserver` to do this, but agent captures size `this.canvas`
        // imperatively (no layout change), so without an explicit copy the
        // overlay stays at its initial 0×0 and `#drawMdcDebugOverlay` paints
        // into nothing.
        this.#debugOverlayCanvas.width = this.canvas.width
        this.#debugOverlayCanvas.height = this.canvas.height
        if (this.#device) {
            this.#recreateAttachments()
        }
    }

    /** Color attachment for render passes: the offscreen capture texture when capturing, else the canvas. */
    #colorAttachmentView(): GPUTextureView {
        return this.#captureTargetView ?? this.#context.getCurrentTexture().createView()
    }

    #clearDebugOverlay(): void {
        this.#debugOverlayCtx?.clearRect(0, 0, this.#debugOverlayCanvas.width, this.#debugOverlayCanvas.height)
    }

    #encodeMdcOverlayDraws(renderPass: GPURenderPassEncoder): void {
        if (!this.#device) return
        renderPass.setBindGroup(0, this.#bindGroup)
        if (this.#mdcOverlayTriVertCount > 0 && this.#mdcOverlayTriBuffer) {
            renderPass.setPipeline(this.#pipelineMdcOverlayTri)
            renderPass.setVertexBuffer(0, this.#mdcOverlayTriBuffer)
            renderPass.draw(this.#mdcOverlayTriVertCount)
        }
        if (this.#mdcOverlayLineVertCount > 0 && this.#mdcOverlayLineBuffer) {
            renderPass.setPipeline(this.#pipelineMdcOverlayLine)
            renderPass.setVertexBuffer(0, this.#mdcOverlayLineBuffer)
            renderPass.draw(this.#mdcOverlayLineVertCount)
        }
    }

    #ensureMdcOverlayLineVerts(minVerts: number): void {
        if (!this.#device || minVerts <= 0) return
        const needBytes = minVerts * 32
        if (!this.#mdcOverlayLineBuffer || this.#mdcOverlayLineBuffer.size < needBytes) {
            this.#mdcOverlayLineBuffer?.destroy()
            const size = Math.max(needBytes, 65536)
            this.#mdcOverlayLineBuffer = this.#device.createBuffer({
                label: "meshViewer.mdcOverlayLines",
                size,
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            })
            this.#mdcOverlayLineCapVerts = Math.floor(size / 32)
        }
    }

    #ensureMdcOverlayTriVerts(minVerts: number): void {
        if (!this.#device || minVerts <= 0) return
        const needBytes = minVerts * 32
        if (!this.#mdcOverlayTriBuffer || this.#mdcOverlayTriBuffer.size < needBytes) {
            this.#mdcOverlayTriBuffer?.destroy()
            const size = Math.max(needBytes, 65536)
            this.#mdcOverlayTriBuffer = this.#device.createBuffer({
                label: "meshViewer.mdcOverlayTris",
                size,
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            })
            this.#mdcOverlayTriCapVerts = Math.floor(size / 32)
        }
    }

    #uploadMdcOverlayScratch(lineVerts: number, triVerts: number): void {
        this.#mdcOverlayLineVertCount = lineVerts
        this.#mdcOverlayTriVertCount = triVerts
        if (!this.#device) return
        if (lineVerts > 0) {
            this.#ensureMdcOverlayLineVerts(lineVerts)
            this.#device.queue.writeBuffer(this.#mdcOverlayLineBuffer!, 0, this.#mdcOverlayLineScratch.buffer, 0, lineVerts * 32)
        }
        if (triVerts > 0) {
            this.#ensureMdcOverlayTriVerts(triVerts)
            this.#device.queue.writeBuffer(this.#mdcOverlayTriBuffer!, 0, this.#mdcOverlayTriScratch.buffer, 0, triVerts * 32)
        }
    }

    /** Rebuild depth-tested overlay geometry (WebGPU) and hover pick state. Call before the render pass. */
    #rebuildMdcOverlayFrameData(cameraTransform: Mat4x4f, cameraOrigin: Vec3f): void {
        this.#mdcOverlayLineVertCount = 0
        this.#mdcOverlayTriVertCount = 0
        this.#mdcOverlayHoveredSampleIdx = -1

        const showRawSamples = this.#mdcDebug
        const showFeatureGlyphs =
            this.#mdcFeatureGlyphLine
            || this.#mdcFeatureGlyphCorner
            || this.#mdcFeatureGlyphSeam
            || this.#mdcFeatureGlyphRing
        const showCellVertices = this.#mdcCellVerticesEnabled && this.#mdcDebugCellVertices.length > 0
        const showQefPlanes = this.#mdcQefPlanesEnabled && this.#mdcDebugQefPlanes.length > 0
        const haveSampleData = this.#mdcDebugSamples.length > 0
        const samplesNeeded = showRawSamples || showFeatureGlyphs
        if (!samplesNeeded && !showCellVertices && !showQefPlanes) return

        const FP = 8
        let li = 0
        let ti = 0
        const growLine = (extraVerts: number) => {
            const need = (li + extraVerts) * FP
            if (need > this.#mdcOverlayLineScratch.length) {
                const n = Math.max(need, Math.ceil(this.#mdcOverlayLineScratch.length * 1.25) + 8192)
                this.#mdcOverlayLineScratch = new Float32Array(n)
            }
        }
        const growTri = (extraVerts: number) => {
            const need = (ti + extraVerts) * FP
            if (need > this.#mdcOverlayTriScratch.length) {
                const n = Math.max(need, Math.ceil(this.#mdcOverlayTriScratch.length * 1.25) + 8192)
                this.#mdcOverlayTriScratch = new Float32Array(n)
            }
        }
        const pl = (x: number, y: number, z: number, r: number, g: number, b: number, a: number) => {
            growLine(1)
            const o = li * FP
            const B = this.#mdcOverlayLineScratch
            B[o] = x
            B[o + 1] = y
            B[o + 2] = z
            B[o + 3] = 0
            B[o + 4] = r
            B[o + 5] = g
            B[o + 6] = b
            B[o + 7] = a
            li++
        }
        const plSeg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, g: number, b: number, a: number) => {
            pl(ax, ay, az, r, g, b, a)
            pl(bx, by, bz, r, g, b, a)
        }
        const pt = (x: number, y: number, z: number, r: number, g: number, b: number, a: number) => {
            growTri(1)
            const o = ti * FP
            const B = this.#mdcOverlayTriScratch
            B[o] = x
            B[o + 1] = y
            B[o + 2] = z
            B[o + 3] = 0
            B[o + 4] = r
            B[o + 5] = g
            B[o + 6] = b
            B[o + 7] = a
            ti++
        }
        const triPush = (
            ax: number,
            ay: number,
            az: number,
            bx: number,
            by: number,
            bz: number,
            cx: number,
            cy: number,
            cz: number,
            r: number,
            g: number,
            b: number,
            a: number,
        ) => {
            pt(ax, ay, az, r, g, b, a)
            pt(bx, by, bz, r, g, b, a)
            pt(cx, cy, cz, r, g, b, a)
        }

        const rgbaForKlass = (klass: number): [number, number, number, number] => {
            switch (klass) {
                case 1: return [86 / 255, 214 / 255, 191 / 255, 1]
                case 2: return [255 / 255, 199 / 255, 92 / 255, 0.92]
                case 3: return [214 / 255, 138 / 255, 255 / 255, 1]
                case 4: return [120 / 255, 220 / 255, 255 / 255, 0.95]
                case 5: return [255 / 255, 102 / 255, 102 / 255, 0.95]
                default: return [190 / 255, 195 / 255, 205 / 255, 0.45]
            }
        }

        const worldUnitsPerPixel =
            this.#debugOverlayCanvas.height > 0
                ? (2 * this.#controls.zoom) / this.#debugOverlayCanvas.height
                : this.#controls.zoom * 0.01

        const billboardHalfAxes = (px: number, py: number, pz: number, half: number) => {
            const eye = this.#controls.cameraPosition
            const wx = px - eye.x
            const wy = py - eye.y
            const wz = pz - eye.z
            const wlen = Math.hypot(wx, wy, wz)
            if (wlen < 1e-12) return null
            const nx = wx / wlen
            const ny = wy / wlen
            const nz = wz / wlen
            let upx = 0
            let upy = 1
            let upz = 0
            if (Math.abs(ny) > 0.92) {
                upx = 1
                upy = 0
                upz = 0
            }
            let ux = ny * upz - nz * upy
            let uy = nz * upx - nx * upz
            let uz = nx * upy - ny * upx
            const ulen = Math.hypot(ux, uy, uz)
            if (ulen < 1e-12) return null
            ux = (ux / ulen) * half
            uy = (uy / ulen) * half
            uz = (uz / ulen) * half
            const vx = (ny * uz - nz * uy) * half
            const vy = (nz * ux - nx * uz) * half
            const vz = (nx * uy - ny * ux) * half
            return { ux, uy, uz, vx, vy, vz }
        }

        const pushBillboardQuad = (px: number, py: number, pz: number, half: number, r: number, g: number, b: number, a: number) => {
            const ax = billboardHalfAxes(px, py, pz, half)
            if (!ax) return
            const x0 = px + ax.ux + ax.vx
            const y0 = py + ax.uy + ax.vy
            const z0 = pz + ax.uz + ax.vz
            const x1 = px - ax.ux + ax.vx
            const y1 = py - ax.uy + ax.vy
            const z1 = pz - ax.uz + ax.vz
            const x2 = px - ax.ux - ax.vx
            const y2 = py - ax.uy - ax.vy
            const z2 = pz - ax.uz - ax.vz
            const x3 = px + ax.ux - ax.vx
            const y3 = py + ax.uy - ax.vy
            const z3 = pz + ax.uz - ax.vz
            triPush(x0, y0, z0, x1, y1, z1, x2, y2, z2, r, g, b, a)
            triPush(x0, y0, z0, x2, y2, z2, x3, y3, z3, r, g, b, a)
        }

        /** Camera-facing ribbon (2 tris); avoids WebGPU ~1px line-list limits. */
        const pushLineRibbon = (
            ax: number,
            ay: number,
            az: number,
            bx: number,
            by: number,
            bz: number,
            halfWidth: number,
            r: number,
            g: number,
            b: number,
            a: number,
        ) => {
            const dx = bx - ax
            const dy = by - ay
            const dz = bz - az
            const len = Math.hypot(dx, dy, dz)
            if (len < 1e-9 || halfWidth < 1e-12) return
            const ox = dx / len
            const oy = dy / len
            const oz = dz / len
            const eye = this.#controls.cameraPosition
            const mx = (ax + bx) * 0.5
            const my = (ay + by) * 0.5
            const mz = (az + bz) * 0.5
            let vx = mx - eye.x
            let vy = my - eye.y
            let vz = mz - eye.z
            const vlen = Math.hypot(vx, vy, vz)
            if (vlen > 1e-12) {
                vx /= vlen
                vy /= vlen
                vz /= vlen
            } else {
                vx = 0
                vy = 0
                vz = 1
            }
            let px = oy * vz - oz * vy
            let py = oz * vx - ox * vz
            let pz = ox * vy - oy * vx
            let plen = Math.hypot(px, py, pz)
            if (plen < 1e-6) {
                let refx = 0
                let refy = 1
                let refz = 0
                if (Math.abs(oy) > 0.9) {
                    refx = 1
                    refy = 0
                    refz = 0
                }
                px = oy * refz - oz * refy
                py = oz * refx - ox * refz
                pz = ox * refy - oy * refx
                plen = Math.hypot(px, py, pz)
                if (plen < 1e-12) return
            }
            px = (px / plen) * halfWidth
            py = (py / plen) * halfWidth
            pz = (pz / plen) * halfWidth
            triPush(ax + px, ay + py, az + pz, ax - px, ay - py, az - pz, bx - px, by - py, bz - pz, r, g, b, a)
            triPush(ax + px, ay + py, az + pz, bx - px, by - py, bz - pz, bx + px, by + py, bz + pz, r, g, b, a)
        }

        const cellR = 1
        const cellG = 235 / 255
        const cellB = 70 / 255
        const cellA = 1
        const cellCrossHalfW = Math.max(worldUnitsPerPixel * 2.8, 1e-5)
        if (showCellVertices) {
            const data = this.#mdcDebugCellVertices
            const stride = MESH_MDC_CELL_VERTEX_STRIDE
            const half = Math.max(worldUnitsPerPixel * 4.2, 1e-5)
            for (let i = 0; i + stride <= data.length; i += stride) {
                const cx = data[i]!
                const cy = data[i + 1]!
                const cz = data[i + 2]!
                pushBillboardQuad(cx, cy, cz, half, cellR, cellG, cellB, cellA)
                const cr = 0.12
                const cg = 0.12
                const cb = 0.12
                const ca = 0.98
                pushLineRibbon(cx - half, cy, cz, cx + half, cy, cz, cellCrossHalfW, cr, cg, cb, ca)
                pushLineRibbon(cx, cy - half, cz, cx, cy + half, cz, cellCrossHalfW, cr, cg, cb, ca)
            }
        }
        if (showQefPlanes) {
            const data = this.#mdcDebugQefPlanes
            const stride = MESH_MDC_QEF_PLANE_STRIDE
            const len = Math.min(Math.max(this.#controls.zoom * 0.11, 0.16), 3.5)
            const qStickHalfW = Math.max(worldUnitsPerPixel * 3.2, 2.5e-4)
            const qr = 90 / 255
            const qg = 210 / 255
            const qb = 1
            const qa = 0.98
            for (let i = 0; i + stride <= data.length; i += stride) {
                const ax = data[i]!
                const ay = data[i + 1]!
                const az = data[i + 2]!
                const nx = data[i + 4]!
                const ny = data[i + 5]!
                const nz = data[i + 6]!
                const tx = ax + nx * len
                const ty = ay + ny * len
                const tz = az + nz * len
                pushLineRibbon(ax, ay, az, tx, ty, tz, qStickHalfW, qr, qg, qb, qa)
                pushBillboardQuad(ax, ay, az, Math.max(worldUnitsPerPixel * 3.2, 1e-5), qr, qg, qb, 1)
            }
        }

        if (!samplesNeeded || !haveSampleData) {
            this.#uploadMdcOverlayScratch(li, ti)
            return
        }

        const samples = this.#mdcDebugSamples
        const hoverPos = this.#hoverCanvasPos
        const stride = MESH_MDC_DEBUG_SAMPLE_STRIDE
        const interestingSampleCount =
            (this.#mdcDebugStats?.acceptedLine ?? 0)
            + (this.#mdcDebugStats?.acceptedCorner ?? 0)
            + (this.#mdcDebugStats?.acceptedSeam ?? 0)
            + (this.#mdcDebugStats?.rejected ?? 0)
        const hideNoneSamples = interestingSampleCount > 0
        const pointSize = samples.length / stride > 2000 ? 3 : 4
        let bestHoverDistSq = 9 * 9
        let bestHoverPriority = -1
        const vectorLen = Math.min(Math.max(this.#controls.zoom * 0.045, 0.08), 2.0)
        const lineGlyphHalfW = Math.max(worldUnitsPerPixel * 6.2, 1.8e-4)

        const drawPriorityForClass = (klass: number): number => {
            switch (klass) {
                case 0: return 0
                case 1: return 1
                case 3: return 2
                case 5: return 3
                case 4: return 4
                case 2: return 5
                default: return 1
            }
        }
        const drawRecords: {
            sampleIdx: number
            klass: number
            x: number
            y: number
            depth: number
            priority: number
        }[] = []
        const featureRecords: {
            sampleIdx: number
            klass: number
            x: number
            y: number
            depth: number
            fx: number
            fy: number
            fz: number
            n1x: number
            n1y: number
            n1z: number
            n2x: number
            n2y: number
            n2z: number
            ax: number
            ay: number
            az: number
            ownerA: number
            ownerB: number
            featureDist: number
        }[] = []
        const featureDedupWorld = Math.max(worldUnitsPerPixel * 8, 1e-4)
        const featureDedupWorldSq = featureDedupWorld * featureDedupWorld
        const featurePriorityForClass = (klass: number): number => {
            switch (klass) {
                case 1: return 1
                case 3: return 2
                case 4: return 3
                case 2: return 4
                default: return 0
            }
        }
        const tangentFromNormals = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
            const tx = ay * bz - az * by
            const ty = az * bx - ax * bz
            const tz = ax * by - ay * bx
            const len = Math.hypot(tx, ty, tz)
            if (len < 1e-6) return null
            return { x: tx / len, y: ty / len, z: tz / len }
        }
        const project = (ox: number, oy: number, oz: number) => this.#projectDebugPoint(cameraTransform, cameraOrigin, ox, oy, oz)
        const updateHover = (sampleIdx: number, px: number, py: number, priority: number) => {
            if (!hoverPos) return
            const dx = px - hoverPos.x
            const dy = py - hoverPos.y
            const distSq = dx * dx + dy * dy
            if (distSq < bestHoverDistSq || (distSq === bestHoverDistSq && priority >= bestHoverPriority)) {
                bestHoverDistSq = distSq
                bestHoverPriority = priority
                this.#mdcOverlayHoveredSampleIdx = sampleIdx
            }
        }

        for (let sampleIdx = 0; sampleIdx < samples.length / stride; sampleIdx++) {
            const base = sampleIdx * stride
            const klass = Math.round(samples[base + 3]!)
            if (hideNoneSamples && klass === 0) continue
            const px = samples[base]!
            const py = samples[base + 1]!
            const pz = samples[base + 2]!
            const projected = project(px, py, pz)
            if (!projected) continue
            drawRecords.push({
                sampleIdx,
                klass,
                x: projected.x,
                y: projected.y,
                depth: projected.depth,
                priority: drawPriorityForClass(klass),
            })

            const fx = samples[base + 8]!
            const fy = samples[base + 9]!
            const fz = samples[base + 10]!
            if (klass !== 0 && klass !== 5 && Math.abs(fx) + Math.abs(fy) + Math.abs(fz) > 1e-6) {
                const projectedFeature = project(fx, fy, fz)
                if (projectedFeature) {
                    const ownerA = Math.round(samples[base + 15]!)
                    const ownerB = Math.round(samples[base + 19]!)
                    const featureDist = samples[base + 11]!
                    const ax = samples[base + 20]!
                    const ay = samples[base + 21]!
                    const az = samples[base + 22]!
                    const isRing = klass === 4
                    let merged = false
                    for (const existing of featureRecords) {
                        if (existing.klass === klass && existing.ownerA === ownerA && existing.ownerB === ownerB) {
                            const dfx = existing.fx - fx
                            const dfy = existing.fy - fy
                            const dfz = existing.fz - fz
                            const spatialOk = isRing || (dfx * dfx + dfy * dfy + dfz * dfz <= featureDedupWorldSq)
                            if (spatialOk) {
                                if (featureDist < existing.featureDist || (featureDist === existing.featureDist && sampleIdx < existing.sampleIdx)) {
                                    existing.sampleIdx = sampleIdx
                                    existing.x = projectedFeature.x
                                    existing.y = projectedFeature.y
                                    existing.depth = projectedFeature.depth
                                    existing.fx = fx
                                    existing.fy = fy
                                    existing.fz = fz
                                    existing.n1x = samples[base + 12]!
                                    existing.n1y = samples[base + 13]!
                                    existing.n1z = samples[base + 14]!
                                    existing.n2x = samples[base + 16]!
                                    existing.n2y = samples[base + 17]!
                                    existing.n2z = samples[base + 18]!
                                    existing.ax = ax
                                    existing.ay = ay
                                    existing.az = az
                                    existing.featureDist = featureDist
                                }
                                merged = true
                                break
                            }
                        }
                    }
                    if (!merged) {
                        featureRecords.push({
                            sampleIdx,
                            klass,
                            x: projectedFeature.x,
                            y: projectedFeature.y,
                            depth: projectedFeature.depth,
                            fx,
                            fy,
                            fz,
                            n1x: samples[base + 12]!,
                            n1y: samples[base + 13]!,
                            n1z: samples[base + 14]!,
                            n2x: samples[base + 16]!,
                            n2y: samples[base + 17]!,
                            n2z: samples[base + 18]!,
                            ax,
                            ay,
                            az,
                            ownerA,
                            ownerB,
                            featureDist,
                        })
                    }
                }
            }
        }

        const halfPx = worldUnitsPerPixel * (pointSize * 0.5)
        if (showRawSamples) {
            drawRecords.sort((a, b) => b.depth - a.depth || a.priority - b.priority || a.sampleIdx - b.sampleIdx)
            for (const record of drawRecords) {
                const base = record.sampleIdx * stride
                const px = samples[base]!
                const py = samples[base + 1]!
                const pz = samples[base + 2]!
                const [r, g, b, a] = rgbaForKlass(record.klass)
                const h = record.klass === 0 ? halfPx : halfPx * 1.15
                pushBillboardQuad(px, py, pz, h, r, g, b, a)
                updateHover(record.sampleIdx, record.x, record.y, record.priority)
            }
        }

        const featureGlyphEnabled = (klass: number): boolean => {
            switch (klass) {
                case 1: return this.#mdcFeatureGlyphLine
                case 2: return this.#mdcFeatureGlyphCorner
                case 3: return this.#mdcFeatureGlyphSeam
                case 4: return this.#mdcFeatureGlyphRing
                default: return false
            }
        }

        const cornerHalfWorld = worldUnitsPerPixel * (pointSize + 3)

        if (showFeatureGlyphs) {
            featureRecords.sort((a, b) =>
                b.depth - a.depth
                || featurePriorityForClass(a.klass) - featurePriorityForClass(b.klass)
                || a.sampleIdx - b.sampleIdx
            )
            for (const record of featureRecords) {
                if (!featureGlyphEnabled(record.klass)) continue
                const [r, g, b, a] = rgbaForKlass(record.klass)
                const [rf, gf, bf, af] = [r, g, b, 1]
                if (record.klass === 1 || record.klass === 3) {
                    const tangent = tangentFromNormals(record.n1x, record.n1y, record.n1z, record.n2x, record.n2y, record.n2z)
                    if (tangent) {
                        const halfLen = vectorLen * 1.05
                        pushLineRibbon(
                            record.fx - tangent.x * halfLen,
                            record.fy - tangent.y * halfLen,
                            record.fz - tangent.z * halfLen,
                            record.fx + tangent.x * halfLen,
                            record.fy + tangent.y * halfLen,
                            record.fz + tangent.z * halfLen,
                            lineGlyphHalfW,
                            rf,
                            gf,
                            bf,
                            af,
                        )
                    }
                    pushBillboardQuad(record.fx, record.fy, record.fz, worldUnitsPerPixel * (pointSize + 2.2), rf, gf, bf, af)
                } else if (record.klass === 2) {
                    const rW = cornerHalfWorld
                    const fx = record.fx
                    const fy = record.fy
                    const fz = record.fz
                    plSeg(fx, fy - rW, fz, fx + rW, fy, fz, rf, gf, bf, af)
                    plSeg(fx + rW, fy, fz, fx, fy + rW, fz, rf, gf, bf, af)
                    plSeg(fx, fy + rW, fz, fx - rW, fy, fz, rf, gf, bf, af)
                    plSeg(fx - rW, fy, fz, fx, fy - rW, fz, rf, gf, bf, af)
                    const d = rW * 0.65
                    plSeg(fx - d, fy - d, fz, fx + d, fy + d, fz, rf, gf, bf, af)
                    plSeg(fx + d, fy - d, fz, fx - d, fy + d, fz, rf, gf, bf, af)
                } else if (record.klass === 4) {
                    const radialX = record.fx - record.ax
                    const radialY = record.fy - record.ay
                    const radialZ = record.fz - record.az
                    const radius = Math.hypot(radialX, radialY, radialZ)
                    const tangent = tangentFromNormals(record.n1x, record.n1y, record.n1z, record.n2x, record.n2y, record.n2z)
                    if (radius > 1e-8 && tangent) {
                        const axisX = tangent.y * radialZ - tangent.z * radialY
                        const axisY = tangent.z * radialX - tangent.x * radialZ
                        const axisZ = tangent.x * radialY - tangent.y * radialX
                        const axisLen = Math.hypot(axisX, axisY, axisZ)
                        if (axisLen > 1e-8) {
                            const aX = axisX / axisLen
                            const aY = axisY / axisLen
                            const aZ = axisZ / axisLen
                            const uX = radialX / radius
                            const uY = radialY / radius
                            const uZ = radialZ / radius
                            const vX = aY * uZ - aZ * uY
                            const vY = aZ * uX - aX * uZ
                            const vZ = aX * uY - aY * uX
                            const SEG = 64
                            for (let i = 0; i < SEG; i++) {
                                const t0 = (i / SEG) * Math.PI * 2
                                const t1 = ((i + 1) / SEG) * Math.PI * 2
                                const wx0 = record.ax + radius * (uX * Math.cos(t0) + vX * Math.sin(t0))
                                const wy0 = record.ay + radius * (uY * Math.cos(t0) + vY * Math.sin(t0))
                                const wz0 = record.az + radius * (uZ * Math.cos(t0) + vZ * Math.sin(t0))
                                const wx1 = record.ax + radius * (uX * Math.cos(t1) + vX * Math.sin(t1))
                                const wy1 = record.ay + radius * (uY * Math.cos(t1) + vY * Math.sin(t1))
                                const wz1 = record.az + radius * (uZ * Math.cos(t1) + vZ * Math.sin(t1))
                                pushLineRibbon(wx0, wy0, wz0, wx1, wy1, wz1, lineGlyphHalfW, rf, gf, bf, af)
                            }
                        }
                    }
                    pushBillboardQuad(record.fx, record.fy, record.fz, worldUnitsPerPixel * pointSize, rf, gf, bf, af)
                }
                updateHover(record.sampleIdx, record.x, record.y, 10 + featurePriorityForClass(record.klass))
            }
        }

        this.#uploadMdcOverlayScratch(li, ti)
    }

    #projectDebugPoint(cameraTransform: Mat4x4f, cameraOrigin: Vec3f, x: number, y: number, z: number): { x: number; y: number; depth: number } | null {
        const pCam = cameraTransform.transform(vec4(x, y, z, 1))
        const p = {
            x: pCam.x - cameraOrigin.x,
            y: pCam.y - cameraOrigin.y,
            z: pCam.z - cameraOrigin.z,
        }
        const aspect = this.#cameraRes.y !== 0 ? this.#cameraRes.x / this.#cameraRes.y : 1
        const ndcX = p.x / (this.#controls.zoom * aspect)
        const ndcY = p.y / this.#controls.zoom
        const near = -10000.0
        const far = 10000.0
        // Preview rays march along camera -Z, so larger camera-space Z is closer.
        const ndcZ = (far - p.z) / (far - near)
        if (!Number.isFinite(ndcX) || !Number.isFinite(ndcY) || !Number.isFinite(ndcZ) || ndcZ < 0 || ndcZ > 1) {
            return null
        }
        const vcOffsetX = 2 * (this.#viewCenter.x - 0.5)
        const vcOffsetY = -2 * (this.#viewCenter.y - 0.5)
        const clipX = ndcX + vcOffsetX
        const clipY = ndcY + vcOffsetY
        if (clipX < -1.1 || clipX > 1.1 || clipY < -1.1 || clipY > 1.1) {
            return null
        }
        return {
            x: (clipX * 0.5 + 0.5) * this.#debugOverlayCanvas.width,
            y: (1 - (clipY * 0.5 + 0.5)) * this.#debugOverlayCanvas.height,
            depth: ndcZ,
        }
    }

    /** Stacked 2D canvas: stats HUD + hover callouts only; MDC geometry is GPU depth-tested on the WebGPU canvas. */
    #drawMdcDebugOverlay(cameraTransform: Mat4x4f, cameraOrigin: Vec3f): void {
        const ctx = this.#debugOverlayCtx
        if (!ctx) return
        ctx.clearRect(0, 0, this.#debugOverlayCanvas.width, this.#debugOverlayCanvas.height)

        const hoveredIndex = this.#mdcOverlayHoveredSampleIdx
        const samples = this.#mdcDebugSamples
        const stride = MESH_MDC_DEBUG_SAMPLE_STRIDE
        if (hoveredIndex < 0 || samples.length === 0) return
        const base = hoveredIndex * stride
        if (base + stride > samples.length) return

        const vectorLen = Math.min(Math.max(this.#controls.zoom * 0.045, 0.08), 2.0)
        const labelForClass = (klass: number): string => {
            switch (klass) {
                case 1: return "line"
                case 2: return "corner"
                case 3: return "seam"
                case 4: return "ring"
                case 5: return "rejected"
                default: return "none"
            }
        }
        const project = (ox: number, oy: number, oz: number) => this.#projectDebugPoint(cameraTransform, cameraOrigin, ox, oy, oz)
        const drawLine = (
            ax: number,
            ay: number,
            az: number,
            bx: number,
            by: number,
            bz: number,
            color: string,
            width: number,
            dashed = false,
        ) => {
            const p0 = project(ax, ay, az)
            const p1 = project(bx, by, bz)
            if (!p0 || !p1) return
            ctx.save()
            ctx.strokeStyle = color
            ctx.lineWidth = width
            if (dashed) ctx.setLineDash([5, 4])
            ctx.beginPath()
            ctx.moveTo(p0.x, p0.y)
            ctx.lineTo(p1.x, p1.y)
            ctx.stroke()
            ctx.restore()
        }

        const px = samples[base]!
        const py = samples[base + 1]!
        const pz = samples[base + 2]!
        const klass = Math.round(samples[base + 3]!)
        const nx = samples[base + 4]!
        const ny = samples[base + 5]!
        const nz = samples[base + 6]!
        const normalCount = Math.round(samples[base + 7]!)
        const fx = samples[base + 8]!
        const fy = samples[base + 9]!
        const fz = samples[base + 10]!
        const featureDist = samples[base + 11]!
        const n1x = samples[base + 12]!
        const n1y = samples[base + 13]!
        const n1z = samples[base + 14]!
        const ownerA = Math.round(samples[base + 15]!)
        const n2x = samples[base + 16]!
        const n2y = samples[base + 17]!
        const n2z = samples[base + 18]!
        const ownerB = Math.round(samples[base + 19]!)
        const point = project(px, py, pz)
        if (!point) return

        drawLine(px, py, pz, px + nx * vectorLen, py + ny * vectorLen, pz + nz * vectorLen, "rgba(120, 220, 255, 0.95)", 2)
        if (Math.abs(fx) + Math.abs(fy) + Math.abs(fz) > 1e-6) {
            drawLine(px, py, pz, fx, fy, fz, "rgba(255, 255, 255, 0.55)", 1.5, true)
            drawLine(fx, fy, fz, fx + n1x * vectorLen, fy + n1y * vectorLen, fz + n1z * vectorLen, "rgba(255, 199, 92, 0.95)", 2)
            if (normalCount >= 3 || klass === 3) {
                drawLine(fx, fy, fz, fx + n2x * vectorLen, fy + n2y * vectorLen, fz + n2z * vectorLen, "rgba(214, 138, 255, 0.95)", 2)
            }
        }

        ctx.save()
        ctx.strokeStyle = "rgba(255, 255, 255, 0.95)"
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(point.x, point.y, 7, 0, Math.PI * 2)
        ctx.stroke()
        const featurePoint = project(fx, fy, fz)
        if (featurePoint) {
            ctx.fillStyle = "rgba(255, 255, 255, 0.95)"
            ctx.fillRect(featurePoint.x - 3, featurePoint.y - 3, 6, 6)
        }
        ctx.font = "12px system-ui, sans-serif"
        ctx.textBaseline = "top"
        const info = `${labelForClass(klass)}  n=${normalCount}  d=${featureDist.toFixed(3)}  ids=${ownerA}/${ownerB}`
        const infoWidth = ctx.measureText(info).width + 16
        const boxX = Math.min(point.x + 12, this.#debugOverlayCanvas.width - infoWidth - 8)
        const boxY = Math.max(8, point.y - 28)
        ctx.fillStyle = "rgba(12, 14, 18, 0.78)"
        ctx.fillRect(boxX, boxY, infoWidth, 22)
        ctx.fillStyle = "rgba(245, 247, 250, 0.96)"
        ctx.fillText(info, boxX + 8, boxY + 5)
        ctx.restore()
    }

    get translucentFaces(): boolean {
        return this.#translucentFaces
    }

    set translucentFaces(enabled: boolean) {
        const next = !!enabled
        if (next === this.#translucentFaces) return
        this.#syncBool("translucentFaces", next)
    }

    get wireframe(): boolean {
        return this.#wireframe
    }

    set wireframe(enabled: boolean) {
        const next = !!enabled
        if (next === this.#wireframe) return
        this.#syncBool("wireframe", next)
    }

    get renderNormals(): boolean {
        return this.#renderNormals
    }

    /**
     * Toggle scene-space normal RGB vs regular lighting. The continuous render
     * loop reflects the change on the next frame, so no explicit re-render is
     * needed. Not persisted here — the shared `preview.previewNormalShading`
     * setting is the single source of truth (app drives this from it).
     */
    set renderNormals(enabled: boolean) {
        this.#renderNormals = !!enabled
    }

    /**
     * Set the edge-overlay line color from the effective theme: near-white on dark,
     * near-black on light. Picked up on the next render frame (continuous rAF loop).
     */
    setEffectiveTheme(theme: "light" | "dark"): void {
        this.#wireframeColor = theme === "light" ? [0.05, 0.05, 0.05] : [0.95, 0.95, 0.98]
    }

    #syncBool(name: "translucentFaces" | "wireframe", value: boolean) {
        if (name === "translucentFaces") {
            this.#translucentFaces = value
        } else {
            this.#wireframe = value
        }
        this.setAttribute(name, value ? "true" : "false")
    }

    attributeChangedCallback(name: string, _oldVal: string | null, newVal: string | null) {
        if (name === "translucentFaces") {
            const next = (newVal ?? "").toLowerCase() === "true"
            if (next !== this.#translucentFaces) this.#syncBool("translucentFaces", next)
            return
        }
        if (name === "wireframe") {
            const next = (newVal ?? "").toLowerCase() === "true"
            if (next !== this.#wireframe) this.#syncBool("wireframe", next)
        }
    }

    /**
     * Apply full overlay/render state from external UI (dev tools). Does not persist;
     * the caller is responsible for storing settings.
     */
    applyMeshViewerSettings(s: GlobalSettings["meshViewer"]): void {
        if (s.translucentFaces !== this.#translucentFaces) this.#syncBool("translucentFaces", s.translucentFaces)
        if (s.wireframe !== this.#wireframe) this.#syncBool("wireframe", s.wireframe)
        this.#mdcDebug = !!s.mdcDebugPoints
        const fg = s.featureGlyphs ?? { line: false, corner: false, seam: false, ring: false }
        this.#mdcFeatureGlyphLine = !!fg.line
        this.#mdcFeatureGlyphCorner = !!fg.corner
        this.#mdcFeatureGlyphSeam = !!fg.seam
        this.#mdcFeatureGlyphRing = !!fg.ring
        this.#mdcCellVerticesEnabled = !!s.mdcCellVertices
        this.#mdcQefPlanesEnabled = !!s.mdcQefPlanes
    }

    /**
     * Snapshot overlay toggles for off-screen thumbnail capture; does not persist.
     * Matches the worker thumbnail camera when paired with `THUMBNAIL_MESH_PREVIEW_CAMERA`.
     */
    applyThumbnailGlyphOverlay(opts: {
        mdcDebugPoints: boolean
        featureGlyphs: { line: boolean; corner: boolean; seam: boolean; ring: boolean }
        mdcCellVertices?: boolean
        mdcQefPlanes?: boolean
    }): void {
        this.#mdcDebug = opts.mdcDebugPoints
        this.#mdcFeatureGlyphLine = opts.featureGlyphs.line
        this.#mdcFeatureGlyphCorner = opts.featureGlyphs.corner
        this.#mdcFeatureGlyphSeam = opts.featureGlyphs.seam
        this.#mdcFeatureGlyphRing = opts.featureGlyphs.ring
        this.#mdcCellVerticesEnabled = !!opts.mdcCellVertices
        this.#mdcQefPlanesEnabled = !!opts.mdcQefPlanes
    }
}

const MESH_DEPTH_PREPASS_FRAG = /* wgsl */ `
@fragment
fn fragmentMain() -> @location(0) vec4f {
    return vec4f(0.0, 0.0, 0.0, 1.0);
}
`

const MDC_OVERLAY_SHADER = /* wgsl */ `
struct Camera {
    transform: mat4x4f,
    origin: vec3f,
    res: vec2f,
    zoom: f32,
    camToScene: mat4x4f,
    viewCenter: vec2f,
};

@group(0) @binding(0) var<uniform> camera: Camera;

struct OverlayIn {
    @location(0) position: vec3f,
    @location(1) color: vec4f,
};

struct OverlayVsOut {
    @builtin(position) position: vec4f,
    @location(0) color: vec4f,
};

@vertex
fn vertexMain(v: OverlayIn) -> OverlayVsOut {
    let aspect = camera.res.x / camera.res.y;
    let pCam = (camera.transform * vec4f(v.position, 1.0)).xyz;
    let p = pCam - camera.origin;
    let ndcX = p.x / (camera.zoom * aspect);
    let ndcY = p.y / camera.zoom;
    let near = -10000.0;
    let far = 10000.0;
    let ndcZ = clamp((far - p.z) / (far - near), 0.0, 1.0);
    let vcOffsetX = 2.0 * (camera.viewCenter.x - 0.5);
    let vcOffsetY = -2.0 * (camera.viewCenter.y - 0.5);
    var out: OverlayVsOut;
    out.position = vec4f(ndcX + vcOffsetX, ndcY + vcOffsetY, ndcZ, 1.0);
    out.color = v.color;
    return out;
}

@fragment
fn fragmentMain(v: OverlayVsOut) -> @location(0) vec4f {
    return v.color;
}
`

const MESH_SHADER_COMMON = /* wgsl */ `
struct Camera {
    transform: mat4x4f,
    origin: vec3f,
    res: vec2f,
    zoom: f32,
    camToScene: mat4x4f,
    viewCenter: vec2f,
    // 0 = regular lighting (matches SDF preview lit mode), 1 = render normals (RGB).
    shadeMode: f32,
    _pad0: f32,
    lineColor: vec4f,
};

// Regular lighting that mirrors preview.wgsl's lit mode: a 4-light wrap-diffuse
// (wrap = 0) + Blinn-Phong specular (exponent 32) + Schlick fresnel rim, using
// the DEFAULT_PREVIEW_SHADING weights and the same camera-space light
// directions transformed to scene space via camToScene. SDF ambient occlusion
// is field-specific (no analytic SDF here), so it's omitted (ao = 1). The mesh
// carries no per-object id, so a single neutral clay albedo stands in for the
// SDF's per-shape palette color.
const MESH_AMBIENT = 0.1;
const MESH_KEY_WEIGHT = 0.62;
const MESH_FILL_WEIGHT = 0.16;
const MESH_RIM_WEIGHT = 0.18;
const MESH_BACK_WEIGHT = 0.12;
const MESH_SPEC_INTENSITY = 0.13;
const MESH_FRESNEL_INTENSITY = 0.27;
const MESH_BASE_COLOR = vec3f(0.82, 0.82, 0.85);

// Camera-space light direction -> unit scene-space direction. Matches the CPU
// camTransform.transformVector(dir) the render worker uses for the SDF preview
// (camToScene is camera->scene, the rotation preserves length).
fn meshLightDir(camDir: vec3f) -> vec3f {
    return normalize((camera.camToScene * vec4f(camDir, 0.0)).xyz);
}

@group(0) @binding(0) var<uniform> camera: Camera;

struct VertexIn {
    @location(0) position: vec3f,
    @location(1) normal: vec3f,
};

struct VertexOut {
    @builtin(position) position: vec4f,
    @location(0) worldPos: vec3f,
    @location(1) normal: vec3f,
    // For wireframe: a per-primitive (flat) facing hint so edges don't split bright/dim mid-segment.
    // Integer varyings are flat-interpolated by definition.
    @location(2) @interpolate(flat) wireFront: u32,
};

fn projectVertex(v: VertexIn) -> VertexOut {
    let aspect = camera.res.x / camera.res.y;
    // camera.transform is scene-space -> camera-space (uploaded as inverse of PreviewWindow camera.transform).
    let pCam = (camera.transform * vec4f(v.position, 1.0)).xyz;
    // Shift by the same camera-space ray origin used by preview.wgsl.
    // offsetX/offsetY become the orthographic projection coordinates below.
    let p = pCam - camera.origin;

    // Match the raymarch preview's screen-space scaling:
    // x in [-zoom*aspect, zoom*aspect] maps to [-1, 1]
    // y in [-zoom, zoom] maps to [-1, 1]
    let ndcX = p.x / (camera.zoom * aspect);
    let ndcY = p.y / camera.zoom;

    // Depth: WebGPU NDC z is 0..1 (not -1..1 like OpenGL).
    // Use a wide-ish orthographic range to avoid clipping.
    let near = -10000.0;
    let far = 10000.0;
    // Preview rays march along camera -Z, so larger camera-space Z is closer.
    let ndcZ = clamp((far - p.z) / (far - near), 0.0, 1.0);

    // Shift NDC so the scene center aligns with the viewCenter screen position,
    // matching the SDF preview's camera offset for the editor overlay.
    let vcOffsetX = 2.0 * (camera.viewCenter.x - 0.5);
    let vcOffsetY = -2.0 * (camera.viewCenter.y - 0.5);

    var out: VertexOut;
    out.position = vec4f(ndcX + vcOffsetX, ndcY + vcOffsetY, ndcZ, 1.0);
    // Used to compute a per-triangle (flat) normal in the fragment shader.
    out.worldPos = v.position;
    out.normal = v.normal;
    // Classify using camera-space normal Z. Sign convention is tricky here due to our camera conventions;
    // empirically, nCam.z <= 0 corresponds to "facing the camera" in this viewer.
    let nCam = normalize((camera.transform * vec4f(v.normal, 0.0)).xyz);
    out.wireFront = select(0u, 1u, nCam.z <= 0.0);
    return out;
}

@vertex
fn vertexMain(v: VertexIn) -> VertexOut {
    return projectVertex(v);
}

// RGB from scene-space normal (diagnostic: interpolated vertex normals show seams when
// adjacent triangles disagree; non-flat shading inside a triangle shows per-corner mismatch).
fn normalToRgb(nScene: vec3f) -> vec3f {
    let len2 = dot(nScene, nScene);
    let n = select(vec3f(0.0, 0.0, 1.0), nScene * inverseSqrt(len2), len2 > 1e-20);
    return n * 0.5 + 0.5;
}

// Regular lit shading matching preview.wgsl (see constants above).
fn shadeMeshLit(nScene: vec3f) -> vec3f {
    let len2 = dot(nScene, nScene);
    let n = select(vec3f(0.0, 0.0, 1.0), nScene * inverseSqrt(len2), len2 > 1e-20);

    let l1 = meshLightDir(vec3f(0.5, 0.6, 1.0));   // key
    let l2 = meshLightDir(vec3f(-0.6, 0.3, 0.8));  // fill
    let l3 = meshLightDir(vec3f(0.1, -0.5, 0.9));  // rim
    let l4 = meshLightDir(vec3f(-0.2, 0.2, 1.0));  // back
    // Ortho camera: direction toward the viewer is the camera +Z axis in scene space.
    let viewDir = meshLightDir(vec3f(0.0, 0.0, 1.0));

    // 4-light wrap diffuse (diffuseWrap = 0, so wrap folds out to a plain clamp).
    let dots = vec4f(dot(n, l1), dot(n, l2), dot(n, l3), dot(n, l4));
    let wrapped = clamp(dots, vec4f(0.0), vec4f(1.0));
    let weights = vec4f(MESH_KEY_WEIGHT, MESH_FILL_WEIGHT, MESH_RIM_WEIGHT, MESH_BACK_WEIGHT);
    let diffuse = clamp(MESH_AMBIENT + dot(wrapped, weights), 0.0, 1.35);

    // Blinn-Phong specular = (n·H)^32 via repeated squaring; key light only.
    let h = max(dot(n, normalize(l1 + viewDir)), 0.0);
    let h2 = h * h;
    let h4 = h2 * h2;
    let h8 = h4 * h4;
    let h16 = h8 * h8;
    let h32 = h16 * h16;
    let spec = h32 * MESH_SPEC_INTENSITY;

    // Schlick fresnel = (1 - n·viewDir)^5.
    let ndv = clamp(dot(n, viewDir), 0.0, 1.0);
    let x = 1.0 - ndv;
    let x2 = x * x;
    let x4 = x2 * x2;
    let fresnel = x4 * x * MESH_FRESNEL_INTENSITY;

    let specRim = vec3f(0.96, 0.98, 1.0) * spec + vec3f(fresnel);
    return MESH_BASE_COLOR * diffuse + specRim;
}
`

const MESH_SHADER_OPAQUE = /* wgsl */ `
${MESH_SHADER_COMMON}

@fragment
fn fragmentMain(v: VertexOut, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4f {
    var n = v.normal;
    if (!frontFacing) {
        n = -n;
    }
    if (camera.shadeMode > 0.5) {
        return vec4f(normalToRgb(n), 1.0);
    }
    return vec4f(shadeMeshLit(n), 1.0);
}
`

// Weighted blended order-independent transparency (OIT).
// We accumulate premultiplied color+alpha into one buffer, and "revealage" into another:
// reveal *= (1 - alpha). Then composite in a fullscreen pass.
const MESH_SHADER_TRANSLUCENT = /* wgsl */ `
${MESH_SHADER_COMMON}

struct OitOut {
    @location(0) accum: vec4f,
    @location(1) reveal: vec4f,
};

@fragment
fn fragmentMain(v: VertexOut, @builtin(front_facing) frontFacing: bool) -> OitOut {
    var n = v.normal;
    if (!frontFacing) {
        n = -n;
    }
    var c = shadeMeshLit(n);
    if (camera.shadeMode > 0.5) {
        c = normalToRgb(n);
    }

    let a = 0.35;
    var out: OitOut;
    out.accum = vec4f(c * a, a);
    // Only alpha is used for revealage blending; keep it in .a.
    out.reveal = vec4f(0.0, 0.0, 0.0, a);
    return out;
}
`

const MESH_SHADER_WIREFRAME = /* wgsl */ `
${MESH_SHADER_COMMON}

// Edge lines share vertices with the surface triangles, but line vs triangle rasterization compute
// depth slightly differently along a shared edge, so a plain less-equal test fails intermittently and
// breaks each edge into dashes. Nudge edges a hair toward the camera (smaller NDC z = closer here) so
// coincident edges win reliably. Tiny relative to feature spacing, so it never reveals hidden edges.
const WIRE_DEPTH_BIAS = 2.0e-5;

@vertex
fn vertexWireframe(v: VertexIn) -> VertexOut {
    var out = projectVertex(v);
    out.position.z = max(out.position.z - WIRE_DEPTH_BIAS, 0.0);
    return out;
}

// Edge overlay: a solid theme-driven line color drawn over the shaded surface. Depth testing
// (less-equal) handles occlusion, so no front/back facing distinction is needed here.
@fragment
fn fragmentMain(v: VertexOut) -> @location(0) vec4f {
    return vec4f(camera.lineColor.rgb, 1.0);
}
`

const COMPOSITE_SHADER = /* wgsl */ `
@group(0) @binding(0) var accumTex: texture_2d<f32>;
@group(0) @binding(1) var revealTex: texture_2d<f32>;

struct VsOut {
    @builtin(position) pos: vec4f,
};

@vertex
fn vertexMain(@builtin(vertex_index) i: u32) -> VsOut {
    // Fullscreen triangle.
    var pos = array<vec2f, 3>(
        vec2f(-1.0, -1.0),
        vec2f( 3.0, -1.0),
        vec2f(-1.0,  3.0),
    );
    var out: VsOut;
    out.pos = vec4f(pos[i], 0.0, 1.0);
    return out;
}

@fragment
fn fragmentMain(@builtin(position) p: vec4f) -> @location(0) vec4f {
    let xy = vec2i(p.xy);
    let accum = textureLoad(accumTex, xy, 0);
    let reveal = textureLoad(revealTex, xy, 0);
    let alpha = clamp(1.0 - reveal.a, 0.0, 1.0);
    if (alpha <= 0.00001) {
        return vec4f(0.0, 0.0, 0.0, 0.0);
    }
    let color = accum.rgb / max(accum.a, 0.00001);
    // Canvas is configured with alphaMode: "premultiplied".
    return vec4f(color * alpha, alpha);
}
`

customElements.define("mesh-viewer", MeshViewer)

declare global {
    interface HTMLElementTagNameMap {
        "mesh-viewer": MeshViewer
    }
}