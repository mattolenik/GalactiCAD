import { MESH_MDC_DEBUG_SAMPLE_STRIDE, MeshData, type MeshMdcDebugStats } from "../export/export.mjs"
import { CameraController } from "../controls/camera-controller.mjs"
import { GPUHelper } from "../gpu/helper.mjs"
import { scheduleShaderModuleCompilationLogging } from "../shaders/shader.mjs"
import { SettingsManager } from "../storage/settings.mjs"
import { __fg_color, __tone_2, __tone_accent } from "../style/style.mjs"
import { Mat4x4f } from "../vecmat/matrix.mjs"
import { vec2, Vec2f, vec3, vec4 } from "../vecmat/vector.mjs"

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
    #translucentCheckbox!: HTMLInputElement
    #viewCenter: Vec2f = vec2(0.5, 0.5)
    #wireframe = false
    #wireframeCheckbox!: HTMLInputElement
    #debugOverlayCanvas: HTMLCanvasElement
    #debugOverlayCtx: CanvasRenderingContext2D | null
    #hoverCanvasPos: { x: number; y: number } | null = null
    #mdcDebug = false
    #mdcDebugCheckbox!: HTMLInputElement
    #mdcFeatureDebug = false
    #mdcFeatureDebugCheckbox!: HTMLInputElement
    #mdcDebugSamples: Float32Array<ArrayBuffer> = new Float32Array(0)
    #mdcDebugStats: MeshMdcDebugStats | null = null

    get controls(): CameraController {
        return this.#controls
    }

    /** Set the center of the visible (non-editor) area in UV space (0-1). */
    setViewCenter(x: number, y: number): void {
        this.#viewCenter = vec2(x, y)
    }

    /**
     * @param tabsElement Optional tabs for camera persistence wiring.
     * @param getInteractionRect When set, camera/trackball input is limited to this screen rect (same as SDF preview).
     */
    constructor(tabsElement?: EventTarget | null, getInteractionRect?: () => DOMRect) {
        super()
        const shadow = this.attachShadow({ mode: "open" })

        this.#settings = SettingsManager.instance

        // Initialize state from attribute (if present in HTML), then load from storage.
        this.#translucentFaces = (this.getAttribute("translucentFaces") ?? "").toLowerCase() === "true"
        this.#wireframe = (this.getAttribute("wireframe") ?? "").toLowerCase() === "true"
        this.#loadViewerState()

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
        .overlay {
            display: flex;
            flex-direction: column;
            gap: 6px;
            position: absolute;
            bottom: 10px;
            right: 10px;
            pointer-events: auto;
            z-index: 1;
        }
        .overlay label {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 6px 10px;
            border-radius: 6px;
            font-size: 12px;
            background: color-mix(in srgb, var(${__tone_2}) 92%, transparent);
            color: rgb(from var(${__fg_color}) r g b / 0.85);
            backdrop-filter: blur(6px);
            -webkit-backdrop-filter: blur(6px);
            user-select: none;
        }
        .overlay input[type="checkbox"] {
            accent-color: var(${__tone_accent});
            font-size: 16px;
        }
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
        shadow.append(style, this.canvas, this.#debugOverlayCanvas)

        const overlay = document.createElement("div")
        overlay.classList.add("overlay")
        const label = document.createElement("label")
        this.#translucentCheckbox = document.createElement("input")
        this.#translucentCheckbox.type = "checkbox"
        this.#translucentCheckbox.checked = this.#translucentFaces
        const text = document.createElement("span")
        text.textContent = "Translucent faces"
        label.append(this.#translucentCheckbox, text)
        overlay.append(label)

        const wireLabel = document.createElement("label")
        wireLabel.style.marginTop = "6px"
        this.#wireframeCheckbox = document.createElement("input")
        this.#wireframeCheckbox.type = "checkbox"
        this.#wireframeCheckbox.checked = this.#wireframe
        const wireText = document.createElement("span")
        wireText.textContent = "Wireframe"
        wireLabel.append(this.#wireframeCheckbox, wireText)
        overlay.append(wireLabel)

        const debugLabel = document.createElement("label")
        this.#mdcDebugCheckbox = document.createElement("input")
        this.#mdcDebugCheckbox.type = "checkbox"
        this.#mdcDebugCheckbox.checked = this.#mdcDebug
        const debugText = document.createElement("span")
        debugText.textContent = "MDC debug"
        debugLabel.append(this.#mdcDebugCheckbox, debugText)
        overlay.append(debugLabel)

        const featureDebugLabel = document.createElement("label")
        this.#mdcFeatureDebugCheckbox = document.createElement("input")
        this.#mdcFeatureDebugCheckbox.type = "checkbox"
        this.#mdcFeatureDebugCheckbox.checked = this.#mdcFeatureDebug
        const featureDebugText = document.createElement("span")
        featureDebugText.textContent = "MDC feature glyphs"
        featureDebugLabel.append(this.#mdcFeatureDebugCheckbox, featureDebugText)
        overlay.append(featureDebugLabel)
        shadow.appendChild(overlay)

        this.#translucentCheckbox.addEventListener("change", () => {
            this.translucentFaces = this.#translucentCheckbox.checked
        })
        this.#wireframeCheckbox.addEventListener("change", () => {
            this.wireframe = this.#wireframeCheckbox.checked
        })
        this.#mdcDebugCheckbox.addEventListener("change", () => {
            this.#mdcDebug = this.#mdcDebugCheckbox.checked
        })
        this.#mdcFeatureDebugCheckbox.addEventListener("change", () => {
            this.#mdcFeatureDebug = this.#mdcFeatureDebugCheckbox.checked
        })
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
        this.#controls = new CameraController(this, vec3(0, 0, 0), 50, 0, Math.PI / 2, tabsElement ?? null, getInteractionRect)
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
            size: 176,
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
            label: "MeshViewer Pipeline (wireframe)",
            layout: this.#pipelineLayout,
            vertex: {
                module: this.#shaderModuleWireframe,
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
                module: this.#shaderModuleWireframe,
                entryPoint: "fragmentMain",
                targets: [{ format: this.#format }],
            },
            primitive: {
                topology: "line-list",
                frontFace: "ccw",
                cullMode: "none",
            },
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
        requestAnimationFrame(this.update.bind(this))
    }

    update(): void {
        if (this.#disposed) return

        if (!this.#device || !this.#uniformBuffer) {
            this.#clearDebugOverlay()
            if (!this.#disposed) requestAnimationFrame(() => this.update())
            return
        }

        // Skip rendering if canvas is collapsed (0x0 size)
        if (this.canvas.width === 0 || this.canvas.height === 0) {
            this.#clearDebugOverlay()
            if (!this.#disposed) requestAnimationFrame(() => this.update())
            return
        }

        // The raymarch preview uses `camera.transform` as a camera-space -> scene-space transform.
        // For rasterizing scene-space vertices, we upload the inverse (scene-space -> camera-space).
        const sceneToCamera = this.#controls.viewTransform.inverse()
        // Rotate 180° to match PreviewWindow's handedness/orientation.
        const rotated = Mat4x4f.rotationY(Math.PI).multiply(sceneToCamera)
        this.#device.queue.writeBuffer(this.#uniformBuffer, 0, rotated.data as BufferSource)
        this.#device.queue.writeBuffer(this.#uniformBuffer, 64, this.#controls.cameraPosition.data as BufferSource)
        this.#device.queue.writeBuffer(this.#uniformBuffer, 64 + 16, this.#cameraRes.data as BufferSource)
        this.#device.queue.writeBuffer(this.#uniformBuffer, 64 + 16 + 8, new Float32Array([this.#controls.zoom]))
        // Provide camera-space -> scene-space so lighting can move with the camera (matching PreviewWindow).
        const camToScene = rotated.inverse()
        this.#device.queue.writeBuffer(this.#uniformBuffer, 96, camToScene.data as BufferSource)
        this.#device.queue.writeBuffer(this.#uniformBuffer, 160, this.#viewCenter.data as BufferSource)

        const commandEncoder = this.#device.createCommandEncoder()
        // Wireframe mode overrides face rendering.
        if (this.#wireframe) {
            const renderPass = commandEncoder.beginRenderPass({
                colorAttachments: [
                    {
                        view: this.#context.getCurrentTexture().createView(),
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
            renderPass.setPipeline(this.#pipelineWireframe)
            renderPass.setBindGroup(0, this.#bindGroup)
            if (this.#vertexBuffer && this.#edgeIndexBuffer && this.#edgeIndexCount > 0) {
                renderPass.setVertexBuffer(0, this.#vertexBuffer)
                renderPass.setIndexBuffer(this.#edgeIndexBuffer, "uint32")
                renderPass.drawIndexed(this.#edgeIndexCount)
            }
            renderPass.end()
        } else if (this.#translucentFaces) {
            if (!this.#oitAccumTexture || !this.#oitRevealTexture || !this.#compositeBindGroup) {
                this.#recreateAttachments()
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
                        view: this.#context.getCurrentTexture().createView(),
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
        } else {
            // Opaque pass (existing).
            const renderPass = commandEncoder.beginRenderPass({
                colorAttachments: [
                    {
                        view: this.#context.getCurrentTexture().createView(),
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

            renderPass.end()
        }
        this.#device.queue.submit([commandEncoder.finish()])
        this.#drawMdcDebugOverlay(rotated)

        if (!this.#disposed) requestAnimationFrame(() => this.update())
    }

    #clearDebugOverlay(): void {
        this.#debugOverlayCtx?.clearRect(0, 0, this.#debugOverlayCanvas.width, this.#debugOverlayCanvas.height)
    }

    #projectDebugPoint(cameraTransform: Mat4x4f, x: number, y: number, z: number): { x: number; y: number; depth: number } | null {
        const pCam = cameraTransform.transform(vec4(x, y, z, 1))
        const p = {
            x: pCam.x - this.#controls.cameraPosition.x,
            y: pCam.y - this.#controls.cameraPosition.y,
            z: pCam.z - (this.#controls.cameraPosition.z + 100.0),
        }
        const aspect = this.#cameraRes.y !== 0 ? this.#cameraRes.x / this.#cameraRes.y : 1
        const ndcX = -p.x / (this.#controls.zoom * aspect)
        const ndcY = p.y / this.#controls.zoom
        const near = -10000.0
        const far = 10000.0
        const ndcZ = (p.z - near) / (far - near)
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

    #drawMdcDebugOverlay(cameraTransform: Mat4x4f): void {
        const ctx = this.#debugOverlayCtx
        if (!ctx) return
        ctx.clearRect(0, 0, this.#debugOverlayCanvas.width, this.#debugOverlayCanvas.height)
        const showRawSamples = this.#mdcDebug
        const showFeatureGlyphs = this.#mdcFeatureDebug
        if ((!showRawSamples && !showFeatureGlyphs) || this.#mdcDebugSamples.length === 0) return

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
        let hoveredIndex = -1
        let bestHoverDistSq = 9 * 9
        let bestHoverPriority = -1
        const vectorLen = Math.min(Math.max(this.#controls.zoom * 0.045, 0.08), 2.0)

        const colorForClass = (klass: number): string => {
            switch (klass) {
                case 1: return "rgba(86, 214, 191, 0.90)"  // line — teal
                case 2: return "rgba(255, 199, 92, 0.92)"  // corner — amber
                case 3: return "rgba(214, 138, 255, 0.92)" // seam — violet
                case 4: return "rgba(120, 220, 255, 0.95)" // ring — cyan
                case 5: return "rgba(255, 102, 102, 0.95)" // rejected — red
                default: return "rgba(190, 195, 205, 0.45)"
            }
        }
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
        const project = (ox: number, oy: number, oz: number) => this.#projectDebugPoint(cameraTransform, ox, oy, oz)
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

        const drawPriorityForClass = (klass: number): number => {
            switch (klass) {
                case 0: return 0
                case 1: return 1 // line
                case 3: return 2 // seam
                case 5: return 3 // rejected
                case 4: return 4 // ring
                case 2: return 5 // corner
                default: return 1
            }
        }
        const drawRecords: { sampleIdx: number, klass: number, x: number, y: number, depth: number, priority: number }[] = []
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
        const worldUnitsPerPixel =
            this.#debugOverlayCanvas.height > 0
                ? (2 * this.#controls.zoom) / this.#debugOverlayCanvas.height
                : this.#controls.zoom * 0.01
        const featureDedupWorld = Math.max(worldUnitsPerPixel * 8, 1e-4)
        const featureDedupWorldSq = featureDedupWorld * featureDedupWorld
        const featurePriorityForClass = (klass: number): number => {
            switch (klass) {
                case 1: return 1 // line
                case 3: return 2 // seam
                case 4: return 3 // ring
                case 2: return 4 // corner
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
        const updateHover = (sampleIdx: number, px: number, py: number, priority: number) => {
            if (!hoverPos) return
            const dx = px - hoverPos.x
            const dy = py - hoverPos.y
            const distSq = dx * dx + dy * dy
            if (distSq < bestHoverDistSq || (distSq === bestHoverDistSq && priority >= bestHoverPriority)) {
                bestHoverDistSq = distSq
                bestHoverPriority = priority
                hoveredIndex = sampleIdx
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
            // Skip the "none" (0) and "rejected" (5) classes; everything else is
            // a real feature payload worth a glyph (line/corner/seam/ring).
            if (klass !== 0 && klass !== 5 && Math.abs(fx) + Math.abs(fy) + Math.abs(fz) > 1e-6) {
                const projectedFeature = project(fx, fy, fz)
                if (projectedFeature) {
                    const ownerA = Math.round(samples[base + 15]!)
                    const ownerB = Math.round(samples[base + 19]!)
                    const featureDist = samples[base + 11]!
                    const ax = samples[base + 20]!
                    const ay = samples[base + 21]!
                    const az = samples[base + 22]!
                    // Rings have a globally-unique identity (latheId in ownerA,
                    // per-profile-vertex tag in ownerB) so cells anywhere on the
                    // same circle dedup down to a single record purely by id —
                    // their per-cell `feat` points scatter around the ring and
                    // would never satisfy the spatial filter.
                    const isRing = klass === 4
                    let merged = false
                    for (const existing of featureRecords) {
                        if (
                            existing.klass === klass &&
                            existing.ownerA === ownerA &&
                            existing.ownerB === ownerB
                        ) {
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
        if (showRawSamples) {
            drawRecords.sort((a, b) => b.depth - a.depth || a.priority - b.priority || a.sampleIdx - b.sampleIdx)
            for (const record of drawRecords) {
                ctx.fillStyle = colorForClass(record.klass)
                const size = record.klass === 0 ? pointSize : pointSize + 2
                ctx.fillRect(record.x - size * 0.5, record.y - size * 0.5, size, size)
                updateHover(record.sampleIdx, record.x, record.y, record.priority)
            }
        }
        if (showFeatureGlyphs) {
            featureRecords.sort((a, b) => b.depth - a.depth || featurePriorityForClass(a.klass) - featurePriorityForClass(b.klass) || a.sampleIdx - b.sampleIdx)
            for (const record of featureRecords) {
                const featureColor = colorForClass(record.klass).replace(/0\.\d+\)/, "1.0)")
                ctx.save()
                ctx.strokeStyle = featureColor
                ctx.fillStyle = featureColor
                ctx.lineWidth = 2.5
                if (record.klass === 1 || record.klass === 3) {
                    const tangent = tangentFromNormals(record.n1x, record.n1y, record.n1z, record.n2x, record.n2y, record.n2z)
                    if (tangent) {
                        const halfLen = vectorLen * 0.75
                        drawLine(
                            record.fx - tangent.x * halfLen,
                            record.fy - tangent.y * halfLen,
                            record.fz - tangent.z * halfLen,
                            record.fx + tangent.x * halfLen,
                            record.fy + tangent.y * halfLen,
                            record.fz + tangent.z * halfLen,
                            featureColor,
                            2.5,
                            record.klass === 3,
                        )
                    }
                    ctx.beginPath()
                    ctx.arc(record.x, record.y, pointSize + 1.5, 0, Math.PI * 2)
                    ctx.stroke()
                } else if (record.klass === 2) {
                    const r = pointSize + 3
                    ctx.beginPath()
                    ctx.moveTo(record.x, record.y - r)
                    ctx.lineTo(record.x + r, record.y)
                    ctx.lineTo(record.x, record.y + r)
                    ctx.lineTo(record.x - r, record.y)
                    ctx.closePath()
                    ctx.stroke()
                    ctx.beginPath()
                    ctx.moveTo(record.x - r * 0.65, record.y - r * 0.65)
                    ctx.lineTo(record.x + r * 0.65, record.y + r * 0.65)
                    ctx.moveTo(record.x + r * 0.65, record.y - r * 0.65)
                    ctx.lineTo(record.x - r * 0.65, record.y + r * 0.65)
                    ctx.stroke()
                } else if (record.klass === 4) {
                    // Ring: reconstruct the full circle from the dedup'd record.
                    //   radial = featurePoint - axisCenter   (in the ring plane, magnitude = radius)
                    //   tangent = unit(cross(n0, n1))        (perpendicular to both face normals,
                    //                                         which lie in the radial-axis plane)
                    //   axis    = unit(cross(tangent, radial))
                    //   ring plane basis: u = radial/radius, v = cross(axis, u)
                    const radialX = record.fx - record.ax
                    const radialY = record.fy - record.ay
                    const radialZ = record.fz - record.az
                    const radius = Math.hypot(radialX, radialY, radialZ)
                    const tangent = tangentFromNormals(record.n1x, record.n1y, record.n1z, record.n2x, record.n2y, record.n2z)
                    if (radius > 1e-8 && tangent) {
                        // axis = cross(tangent, radial)
                        const axisX = tangent.y * radialZ - tangent.z * radialY
                        const axisY = tangent.z * radialX - tangent.x * radialZ
                        const axisZ = tangent.x * radialY - tangent.y * radialX
                        const axisLen = Math.hypot(axisX, axisY, axisZ)
                        if (axisLen > 1e-8) {
                            const aX = axisX / axisLen, aY = axisY / axisLen, aZ = axisZ / axisLen
                            const uX = radialX / radius, uY = radialY / radius, uZ = radialZ / radius
                            // v = cross(axis, u)
                            const vX = aY * uZ - aZ * uY
                            const vY = aZ * uX - aX * uZ
                            const vZ = aX * uY - aY * uX
                            // 64 segments is plenty for typical lathe scales without flooding the canvas.
                            const SEG = 64
                            ctx.beginPath()
                            let started = false
                            for (let i = 0; i <= SEG; i++) {
                                const t = (i / SEG) * Math.PI * 2
                                const cosT = Math.cos(t), sinT = Math.sin(t)
                                const wx = record.ax + radius * (uX * cosT + vX * sinT)
                                const wy = record.ay + radius * (uY * cosT + vY * sinT)
                                const wz = record.az + radius * (uZ * cosT + vZ * sinT)
                                const sp = project(wx, wy, wz)
                                if (!sp) { started = false; continue }
                                if (!started) {
                                    ctx.moveTo(sp.x, sp.y)
                                    started = true
                                } else {
                                    ctx.lineTo(sp.x, sp.y)
                                }
                            }
                            ctx.stroke()
                        }
                    }
                    // Mark the dedup anchor with a small ring so hover targeting works.
                    ctx.beginPath()
                    ctx.arc(record.x, record.y, pointSize, 0, Math.PI * 2)
                    ctx.stroke()
                }
                ctx.restore()
                updateHover(record.sampleIdx, record.x, record.y, 10 + featurePriorityForClass(record.klass))
            }
        }

        const stats = this.#mdcDebugStats
        if (stats) {
            const text1 = `MDC debug ${stats.totalSamples} raw samples`
            const text2 = `L ${stats.acceptedLine}  C ${stats.acceptedCorner}  S ${stats.acceptedSeam}  Ring ${stats.acceptedRing}  Rej ${stats.rejected}`
            const overlayMode =
                showRawSamples && showFeatureGlyphs ? "raw squares + feature glyphs"
                    : showRawSamples ? "raw squares only"
                        : "feature glyphs only"
            const text3 = hideNoneSamples ? `${overlayMode}  gray hidden  N ${stats.acceptedNone}` : `${overlayMode}  N ${stats.acceptedNone}`
            ctx.save()
            ctx.font = "12px system-ui, sans-serif"
            ctx.textBaseline = "top"
            const width = Math.max(ctx.measureText(text1).width, ctx.measureText(text2).width, ctx.measureText(text3).width) + 16
            const height = 50
            const margin = 12
            // Keep the HUD close to the bottom-right mesh-viewer controls without sitting directly under them.
            const hudX = this.#debugOverlayCanvas.width - width - margin
            const hudY = this.#debugOverlayCanvas.height - height - 118
            ctx.fillStyle = "rgba(12, 14, 18, 0.66)"
            ctx.fillRect(hudX, hudY, width, height)
            ctx.fillStyle = "rgba(245, 247, 250, 0.92)"
            ctx.fillText(text1, hudX + 8, hudY + 6)
            ctx.fillText(text2, hudX + 8, hudY + 20)
            ctx.fillText(text3, hudX + 8, hudY + 34)
            ctx.restore()
        }

        if (hoveredIndex < 0) return
        const base = hoveredIndex * stride
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
        this.#saveViewerState()
    }

    get wireframe(): boolean {
        return this.#wireframe
    }

    set wireframe(enabled: boolean) {
        const next = !!enabled
        if (next === this.#wireframe) return
        this.#syncBool("wireframe", next)
        this.#saveViewerState()
    }

    #syncBool(name: "translucentFaces" | "wireframe", value: boolean) {
        if (name === "translucentFaces") {
            this.#translucentFaces = value
            if (this.#translucentCheckbox) this.#translucentCheckbox.checked = value
        } else {
            this.#wireframe = value
            if (this.#wireframeCheckbox) this.#wireframeCheckbox.checked = value
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

    #saveViewerState(): void {
        this.#settings.updateGlobal({
            meshViewer: {
                translucentFaces: this.#translucentFaces,
                wireframe: this.#wireframe,
            },
        })
    }

    #loadViewerState(): void {
        const g = this.#settings.getGlobal().meshViewer
        this.#syncBool("translucentFaces", g.translucentFaces)
        this.#syncBool("wireframe", g.wireframe)
    }
}

const MESH_SHADER_COMMON = /* wgsl */ `
struct Camera {
    transform: mat4x4f,
    position: vec3f,
    res: vec2f,
    zoom: f32,
    camToScene: mat4x4f,
    viewCenter: vec2f,
};

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

@vertex
fn vertexMain(v: VertexIn) -> VertexOut {
    let aspect = camera.res.x / camera.res.y;
    // camera.transform is scene-space -> camera-space (uploaded as inverse of PreviewWindow camera.transform).
    let pCam = (camera.transform * vec4f(v.position, 1.0)).xyz;
    // PreviewWindow's camera ray origin is (camera.position + vec3(offsetX, offsetY, 100.0)) in camera-space,
    // so shift vertices by the same camera origin (offsetX/offsetY are handled by projection below).
    let p = pCam - (camera.position + vec3f(0.0, 0.0, 100.0));

    // Match the raymarch preview's screen-space scaling:
    // x in [-zoom*aspect, zoom*aspect] maps to [-1, 1]
    // y in [-zoom, zoom] maps to [-1, 1]
    // Flip X so the mesh matches the raymarch preview orientation.
    let ndcX = -p.x / (camera.zoom * aspect);
    let ndcY = p.y / camera.zoom;

    // Depth: WebGPU NDC z is 0..1 (not -1..1 like OpenGL).
    // Use a wide-ish orthographic range to avoid clipping.
    let near = -10000.0;
    let far = 10000.0;
    let ndcZ = clamp((p.z - near) / (far - near), 0.0, 1.0);

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

// RGB from scene-space normal (diagnostic: interpolated vertex normals show seams when
// adjacent triangles disagree; non-flat shading inside a triangle shows per-corner mismatch).
fn normalToRgb(nScene: vec3f) -> vec3f {
    let len2 = dot(nScene, nScene);
    let n = select(vec3f(0.0, 0.0, 1.0), nScene * inverseSqrt(len2), len2 > 1e-20);
    return n * 0.5 + 0.5;
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
    return vec4f(normalToRgb(n), 1.0);
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
    let c = normalToRgb(n);

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

@fragment
fn fragmentMain(v: VertexOut) -> @location(0) vec4f {
    // Note: line primitives don't have true front/back faces. We use a flat per-edge hint (wireFront)
    // so an edge doesn't flip mid-segment as the interpolated normal changes.
    let isFront = v.wireFront != 0u;
    let frontColor = vec3f(0.95, 0.95, 0.98);
    let backColor = frontColor * 0.35;
    let c = select(backColor, frontColor, isFront);
    return vec4f(c, 0.9);
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