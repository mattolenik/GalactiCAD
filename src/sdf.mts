import { AveragedBuffer } from "./collections/averagedbuffer.mjs"
import { Controls } from "./controls.mjs"
import { PreviewWindow } from "./preview-window.mjs"
import { SceneInfo } from "./scene/scene.mjs"
import previewShader from "./shaders/preview.wgsl"
import { ShaderCompiler } from "./shaders/shader.mjs"
import { vec2, Vec2f, vec3, Vec4f } from "./vecmat/vector.mjs"

class UniformBuffers {
    cameraPosition!: GPUBuffer
    orthoScale!: GPUBuffer
    scene!: GPUBuffer
    sceneTransform!: GPUBuffer
    canvasRes!: GPUBuffer
    bgColor!: GPUBuffer
}

export class SDFRenderer {
    #framerate = new AveragedBuffer(4)
    #bindGroup!: GPUBindGroup
    #cameraRes!: Vec2f
    #context!: GPUCanvasContext
    #controls: Controls
    #device!: GPUDevice
    #format!: GPUTextureFormat
    #initializing: Promise<void> | null
    #lastRenderTime: number = 0
    #pipeline!: GPURenderPipeline
    #preview: PreviewWindow
    #scene!: SceneInfo
    #sceneShader!: ShaderCompiler
    #started = false
    #uniformBuffers: UniformBuffers
    bgColor = new Vec4f([0, 0, 0, 0])

    constructor(preview: PreviewWindow) {
        this.#preview = preview
        // this.#preview.canvas.tabIndex = 1
        this.#controls = new Controls(preview, vec3(0, 0, 0), 50)
        this.#uniformBuffers = new UniformBuffers()
        this.#initializing = this.initialize()
        this.#cameraRes = vec2(this.#preview.canvas.clientWidth, this.#preview.canvas.clientHeight)

        const observer = new ResizeObserver(entries => {
            for (const entry of entries) {
                const width = entry.devicePixelContentBoxSize?.[0].inlineSize || entry.contentBoxSize[0].inlineSize * devicePixelRatio
                const height = entry.devicePixelContentBoxSize?.[0].blockSize || entry.contentBoxSize[0].blockSize * devicePixelRatio
                const canvas = entry.target as HTMLCanvasElement
                canvas.width = width
                canvas.height = height
                this.#cameraRes = vec2(canvas.width, canvas.height)
            }
        })
        try {
            observer.observe(this.#preview.canvas, { box: "device-pixel-content-box" })
        } catch {
            observer.observe(this.#preview.canvas, { box: "content-box" })
        }
    }

    build(src: string) {
        src = "return " + src.trim().replace(/return\s+/, "")
        this.#scene = new SceneInfo(src)
        this.#sceneShader = new ShaderCompiler(previewShader, "Preview Window")
            .replace("replace", "NUM_ARGS", `const NUM_ARGS: u32 = ${this.#scene.args.length};`)
            .replace("insert", "sceneSDF", this.#scene.compile())

        this.buildPipeline()
        // console.log(this.#sceneShader.text)
    }

    async initialize() {
        const adapter = await navigator.gpu.requestAdapter()
        if (!adapter) throw new Error("No GPU adapter found")

        this.#device = await adapter.requestDevice()
        this.#context = this.#preview.canvas.getContext("webgpu") as GPUCanvasContext

        this.#format = navigator.gpu.getPreferredCanvasFormat()
        this.#context.configure({
            device: this.#device,
            format: this.#format,
            alphaMode: "premultiplied",
        })
    }

    async ready() {
        if (this.#initializing) {
            await this.#initializing
            this.#initializing = null
        }
        return this
    }

    startLoop() {
        if (this.#started) return
        this.#started = true
        requestAnimationFrame(this.update.bind(this))
    }

    private buildPipeline() {
        this.#uniformBuffers.scene = this.#device.createBuffer({
            size: 16384,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "scene",
        })

        this.#uniformBuffers.sceneTransform = this.#device.createBuffer({
            size: 64,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "sceneTransform",
        })

        this.#uniformBuffers.cameraPosition = this.#device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "cameraPosition",
        })

        this.#uniformBuffers.orthoScale = this.#device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "orthoScale",
        })

        this.#uniformBuffers.canvasRes = this.#device.createBuffer({
            size: 8,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "canvasRes",
        })

        this.#uniformBuffers.bgColor = this.#device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "bgColor",
        })

        const shaderModule = this.#sceneShader.createModule(this.#device)

        const format = this.#format
        this.#pipeline = this.#device.createRenderPipeline({
            label: "Preview Pipeline",
            layout: "auto",
            vertex: {
                module: shaderModule,
                entryPoint: "vertexMain",
            },
            fragment: {
                module: shaderModule,
                entryPoint: "fragmentMain",
                targets: [{ format }],
            },
            primitive: {
                topology: "triangle-strip",
                stripIndexFormat: "uint32",
            },
        })
        this.#bindGroup = this.#device.createBindGroup({
            label: "scene",
            layout: this.#pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.#uniformBuffers.scene } },
                { binding: 1, resource: { buffer: this.#uniformBuffers.sceneTransform } },
                { binding: 2, resource: { buffer: this.#uniformBuffers.cameraPosition } },
                { binding: 3, resource: { buffer: this.#uniformBuffers.orthoScale } },
                { binding: 4, resource: { buffer: this.#uniformBuffers.canvasRes } },
                { binding: 5, resource: { buffer: this.#uniformBuffers.bgColor } },
            ],
        })
    }

    update(time: number): void {
        this.updateFPS(time)

        if (this.#scene.root) {
            this.#scene.root.updateScene()
            this.#device.queue.writeBuffer(this.#uniformBuffers.scene, 0, this.#scene.args.data)
            this.#device.queue.writeBuffer(this.#uniformBuffers.sceneTransform, 0, this.#controls.sceneTransform.data)
            this.#device.queue.writeBuffer(this.#uniformBuffers.cameraPosition, 0, this.#controls.cameraPosition.data)
            this.#device.queue.writeBuffer(this.#uniformBuffers.orthoScale, 0, new Float32Array([this.#controls.orthoScale]))
            this.#device.queue.writeBuffer(this.#uniformBuffers.canvasRes, 0, this.#cameraRes.data)
            this.#device.queue.writeBuffer(this.#uniformBuffers.bgColor, 0, this.bgColor.data)
        }

        const commandEncoder = this.#device.createCommandEncoder()
        const renderPass = commandEncoder.beginRenderPass({
            colorAttachments: [
                {
                    view: this.#context.getCurrentTexture().createView(),
                    clearValue: { r: 0, g: 0, b: 0, a: 1 },
                    loadOp: "clear",
                    storeOp: "store",
                },
            ],
        })

        renderPass.setPipeline(this.#pipeline)
        renderPass.setBindGroup(0, this.#bindGroup)
        renderPass.draw(4)
        renderPass.end()

        this.#device.queue.submit([commandEncoder.finish()])
        requestAnimationFrame(time => this.update(time))
    }

    private updateFPS(time: number) {
        const deltaTime = time - this.#lastRenderTime
        this.#lastRenderTime = time
        this.#framerate.update(1000 / deltaTime)
        this.#preview.updateFps(this.#framerate.average)
    }
}
