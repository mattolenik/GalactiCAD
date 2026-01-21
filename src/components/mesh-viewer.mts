import { MeshData } from "../export/export.mjs"
import { CameraController } from "../controls/camera-controller.mjs"
import { GPUHelper } from "../gpu/helper.mjs"
import { Mat4x4f } from "../vecmat/matrix.mjs"
import { vec2, Vec2f, vec3 } from "../vecmat/vector.mjs"

export class MeshViewer extends HTMLElement {
    static get observedAttributes() {
        return ["translucentFaces"]
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
    #initializing: Promise<void> | null
    #pipelineOpaque!: GPURenderPipeline
    #pipelineTranslucent!: GPURenderPipeline // weighted blended OIT pass
    #compositePipeline!: GPURenderPipeline
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

    #translucentFaces = false
    #translucentCheckbox!: HTMLInputElement

    get controls(): CameraController {
        return this.#controls
    }

    constructor() {
        super()
        const shadow = this.attachShadow({ mode: "open" })

        // Initialize state from attribute (if present in HTML).
        this.#translucentFaces = (this.getAttribute("translucentFaces") ?? "").toLowerCase() === "true"

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
        .overlay {
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
            background: color-mix(in srgb, var(--tone-2, #444) 92%, transparent);
            color: rgb(from var(--fg-color, whitesmoke) r g b / 0.85);
            backdrop-filter: blur(6px);
            -webkit-backdrop-filter: blur(6px);
            user-select: none;
        }
        .overlay input[type="checkbox"] {
            accent-color: var(--tone-accent, #88f);
        }
`
        this.canvas = document.createElement("canvas")
        this.canvas.style.width = "100%"
        this.canvas.style.height = "100%"
        this.canvas.style.display = "inline-block"
        shadow.appendChild(this.canvas)
        shadow.append(style, this.canvas)

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
        shadow.appendChild(overlay)

        this.#translucentCheckbox.addEventListener("change", () => {
            this.translucentFaces = this.#translucentCheckbox.checked
        })

        this.#cameraRes = vec2(this.canvas.clientWidth, this.canvas.clientHeight)
        this.#controls = new CameraController(this, vec3(0, 0, 0), 50)
        this.#initializing = this.#initialize()

        const observer = new ResizeObserver(entries => {
            requestAnimationFrame(() => {
                for (const entry of entries) {
                    const w =
                        entry.devicePixelContentBoxSize?.[0].inlineSize ??
                        Math.max(1, Math.round(entry.contentRect.width * devicePixelRatio))
                    const h =
                        entry.devicePixelContentBoxSize?.[0].blockSize ??
                        Math.max(1, Math.round(entry.contentRect.height * devicePixelRatio))
                    this.canvas.width = w
                    this.canvas.height = h
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
            size: 160,
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

        const shaderModuleOpaque = this.#device.createShaderModule({
            label: "meshViewer.shader.opaque",
            code: MESH_SHADER_OPAQUE,
        })
        const shaderModuleTranslucent = this.#device.createShaderModule({
            label: "meshViewer.shader.translucent",
            code: MESH_SHADER_TRANSLUCENT,
        })
        const shaderModuleComposite = this.#device.createShaderModule({
            label: "meshViewer.shader.composite",
            code: COMPOSITE_SHADER,
        })

        this.#pipelineOpaque = this.#device.createRenderPipeline({
            label: "MeshViewer Pipeline (opaque)",
            layout: this.#pipelineLayout,
            vertex: {
                module: shaderModuleOpaque,
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
                module: shaderModuleOpaque,
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

        this.#pipelineTranslucent = this.#device.createRenderPipeline({
            label: "MeshViewer Pipeline (translucent)",
            layout: this.#pipelineLayout,
            vertex: {
                module: shaderModuleTranslucent,
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
                module: shaderModuleTranslucent,
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
            vertex: { module: shaderModuleComposite, entryPoint: "vertexMain" },
            fragment: {
                module: shaderModuleComposite,
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

    #recreateAttachments() {
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
        this.#uploadMesh(meshToUpload)
    }

    #uploadMesh(mesh: MeshData) {
        const { verts, tris } = mesh

        this.#indexCount = tris.length
        if (this.#indexCount === 0 || verts.length === 0) {
            this.#vertexBuffer?.destroy()
            this.#indexBuffer?.destroy()
            this.#vertexBuffer = null
            this.#indexBuffer = null
            this.#indexCount = 0
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
    }

    startLoop() {
        if (this.#started) return
        this.#started = true
        requestAnimationFrame(this.update.bind(this))
    }

    update(): void {
        if (!this.#device || !this.#uniformBuffer) {
            requestAnimationFrame(() => this.update())
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

        const commandEncoder = this.#device.createCommandEncoder()
        if (this.#translucentFaces) {
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

        requestAnimationFrame(() => this.update())
    }

    get translucentFaces(): boolean {
        return this.#translucentFaces
    }

    set translucentFaces(enabled: boolean) {
        const next = !!enabled
        if (next === this.#translucentFaces) return
        this.#translucentFaces = next
        if (this.#translucentCheckbox) {
            this.#translucentCheckbox.checked = next
        }
        this.setAttribute("translucentFaces", next ? "true" : "false")
    }

    attributeChangedCallback(name: string, oldVal: string | null, newVal: string | null) {
        if (name !== "translucentFaces") return
        const next = (newVal ?? "").toLowerCase() === "true"
        if (next === this.#translucentFaces) return
        this.#translucentFaces = next
        if (this.#translucentCheckbox) {
            this.#translucentCheckbox.checked = next
        }
    }
}

const MESH_SHADER_COMMON = /* wgsl */ `
struct Camera {
    transform: mat4x4f,
    position: vec3f,
    res: vec2f,
    zoom: f32,
    camToScene: mat4x4f,
};

@group(0) @binding(0) var<uniform> camera: Camera;

struct VertexIn {
    @location(0) position: vec3f,
    @location(1) normal: vec3f,
};

struct VertexOut {
    @builtin(position) position: vec4f,
    @location(0) worldPos: vec3f,
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

    var out: VertexOut;
    out.position = vec4f(ndcX, ndcY, ndcZ, 1.0);
    // Used to compute a per-triangle (flat) normal in the fragment shader.
    out.worldPos = v.position;
    return out;
}

fn diffuseWrap(n: vec3f, l: vec3f, wrap: f32) -> f32 {
    return clamp((dot(n, l) + wrap) / (1.0 + wrap), 0.0, 1.0);
}

fn lighting(normalScene: vec3f) -> f32 {
    // Same light rig as PreviewWindow, defined in camera-space so it moves with the camera.
    let lCam1 = normalize(vec3f(0.6, 0.7, -1.0));
    let lCam2 = normalize(vec3f(-0.8, 0.2, -1.0));
    let lCam3 = normalize(vec3f(0.2, -0.9, -1.0));
    let lCamBack = normalize(vec3f(-0.2, 0.2, 1.0));

    // Convert to scene-space using camToScene (camera-space -> scene-space).
    let l1 = normalize((camera.camToScene * vec4f(lCam1, 0.0)).xyz);
    let l2 = normalize((camera.camToScene * vec4f(lCam2, 0.0)).xyz);
    let l3 = normalize((camera.camToScene * vec4f(lCam3, 0.0)).xyz);
    let lb = normalize((camera.camToScene * vec4f(lCamBack, 0.0)).xyz);

    let wrap = 0.25;
    let key = 0.55 * diffuseWrap(normalScene, l1, wrap);
    let fill = 0.30 * diffuseWrap(normalScene, l2, wrap);
    let rim = 0.20 * diffuseWrap(normalScene, l3, wrap);
    let back = 0.15 * diffuseWrap(normalScene, lb, 0.40);

    let ambient = 0.18;
    return clamp(ambient + key + fill + rim + back, 0.0, 1.3);
}
`

const MESH_SHADER_OPAQUE = /* wgsl */ `
${MESH_SHADER_COMMON}

@fragment
fn fragmentMain(v: VertexOut, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4f {
    // Flat shading: compute face normal from screen-space derivatives of world position.
    // This yields a constant normal across the triangle.
    let dx = dpdx(v.worldPos);
    let dy = dpdy(v.worldPos);
    var n = normalize(cross(dx, dy));
    // Two-sided shading: keep normal consistent for back faces.
    if (!frontFacing) {
        n = -n;
    }

    let diffuse = lighting(n);
    let baseColor = vec3f(0.9, 0.9, 0.95);
    let shaded = baseColor * diffuse;
    return vec4f(shaded, 1.0);
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
    let dx = dpdx(v.worldPos);
    let dy = dpdy(v.worldPos);
    var n = normalize(cross(dx, dy));
    if (!frontFacing) {
        n = -n;
    }
    let diffuse = lighting(n);
    let baseColor = vec3f(0.9, 0.9, 0.95);
    let shaded = baseColor * diffuse;

    let a = 0.35;
    var out: OitOut;
    out.accum = vec4f(shaded * a, a);
    // Only alpha is used for revealage blending; keep it in .a.
    out.reveal = vec4f(0.0, 0.0, 0.0, a);
    return out;
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