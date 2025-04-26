import { Controls } from "./controls.mjs"
import { SceneInfo } from "./scene/scene.mjs"
import previewShader from "./shaders/preview.wgsl"
import { ShaderCompiler } from "./shaders/shader.mjs"
import { vec2, Vec2f, vec3 } from "./vecmat/vector.mjs"

class UniformBuffers {
    cameraPosition!: GPUBuffer
    orthoScale!: GPUBuffer
    scene!: GPUBuffer
    sceneTransform!: GPUBuffer
    canvasRes!: GPUBuffer
}

export class SDFRenderer {
    #bindGroup!: GPUBindGroup
    #canvas: HTMLCanvasElement
    #context!: GPUCanvasContext
    #controls: Controls
    #device!: GPUDevice
    #format!: GPUTextureFormat
    #initializing: Promise<void> | null
    #pipeline!: GPURenderPipeline
    #scene!: SceneInfo
    #sceneShader!: ShaderCompiler
    #uniformBuffers: UniformBuffers

    #cameraRes!: Vec2f
    #averageFramerate: number[] = []
    #lastRenderTime: number = 0
    #framerateChanged?: (fps: number) => void

    constructor(canvas: HTMLCanvasElement, framerateChanged?: (fps: number) => void) {
        this.#canvas = canvas
        this.#canvas.tabIndex = 1
        this.#framerateChanged = framerateChanged
        this.#controls = new Controls(canvas, vec3(0, 0, 0), 50) //, Math.PI / 1, Math.PI / 8)
        this.#uniformBuffers = new UniformBuffers()
        this.#initializing = this.initialize()
        this.#cameraRes = vec2(this.#canvas.clientWidth, this.#canvas.clientHeight)

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
            observer.observe(this.#canvas, { box: "device-pixel-content-box" })
        } catch {
            observer.observe(this.#canvas, { box: "content-box" })
        }
    }

    build(src: string) {
        this.#scene = new SceneInfo(src)
        this.#sceneShader = new ShaderCompiler(previewShader, "Preview Window")
            .replace("replace", "NUM_ARGS", `const NUM_ARGS: u32 = ${this.#scene.args.length};`)
            .replace("insert", "sceneSDF", this.#scene.compile())

        this.buildPipeline()
        console.log(this.#sceneShader.text)
    }

    async initialize() {
        const adapter = await navigator.gpu.requestAdapter()
        if (!adapter) throw new Error("No GPU adapter found")

        this.#device = await adapter.requestDevice()
        this.#context = this.#canvas.getContext("webgpu") as GPUCanvasContext

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

    buildPipeline() {
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
            ],
        })
    }

    update(time: number): void {
        this.updateFPS(time)

        this.#scene.root.updateScene()

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

        this.#device.queue.writeBuffer(this.#uniformBuffers.scene, 0, this.#scene.args.data)
        this.#device.queue.writeBuffer(this.#uniformBuffers.sceneTransform, 0, this.#controls.camera.sceneTransform.data)
        this.#device.queue.writeBuffer(this.#uniformBuffers.cameraPosition, 0, this.#controls.camera.position.data)
        this.#device.queue.writeBuffer(this.#uniformBuffers.orthoScale, 0, new Float32Array([this.#controls.camera.orthoScale]))
        this.#device.queue.writeBuffer(this.#uniformBuffers.canvasRes, 0, this.#cameraRes.data)

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
        this.#averageFramerate.push(1000 / deltaTime)
        if (this.#averageFramerate.length > 10) {
            this.#averageFramerate.shift()
        }
        const framerate = this.#averageFramerate.reduce((p, c) => p + c, 0) / this.#averageFramerate.length
        this.#framerateChanged?.(framerate)
    }
}
