import { AveragedBuffer } from "./collections/averagedbuffer.mjs"
import { PreviewWindow } from "./components/preview-window.mjs"
import { CameraController } from "./controls/camera-controller.mjs"
import { ODCExport } from "./odc-exporter.mjs"
import { SceneInfo } from "./scene/scene.mjs"
import exportShader from "./shaders/odc.wgsl"
import previewShader from "./shaders/preview.wgsl"
import { ShaderCompiler } from "./shaders/shader.mjs"
import { vec2, Vec2f, vec3 } from "./vecmat/vector.mjs"

class UniformBuffers {
    camera!: GPUBuffer
    scene!: GPUBuffer
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
    #lastRenderTime: number = 0
    #pipeline!: GPURenderPipeline
    #preview: PreviewWindow
    #scene!: SceneInfo
    #started = false
    #uniformBuffers: UniformBuffers
    #exportBuffers: ExportBuffers
    #shaderCompiler!: ShaderCompiler
    #sceneShader!: GPUShaderModule
    #exportShader!: GPUShaderModule

    constructor(preview: PreviewWindow) {
        this.#preview = preview
        this.#controls = new CameraController(preview, vec3(0, 0, 0), 50)
        this.#uniformBuffers = new UniformBuffers()
        this.#exportBuffers = new ExportBuffers()
        this.#initializing = this.initialize()
        this.#cameraRes = vec2(this.#preview.canvas.clientWidth, this.#preview.canvas.clientHeight)

        const observer = new ResizeObserver(entries => {
            requestAnimationFrame(() => {
                for (const entry of entries) {
                    const width = entry.devicePixelContentBoxSize?.[0].inlineSize || entry.contentBoxSize[0].inlineSize * devicePixelRatio
                    const height = entry.devicePixelContentBoxSize?.[0].blockSize || entry.contentBoxSize[0].blockSize * devicePixelRatio
                    const canvas = entry.target as HTMLCanvasElement
                    canvas.width = width
                    canvas.height = height
                    this.#cameraRes = vec2(canvas.width, canvas.height)
                }
            })
        })
        try {
            observer.observe(this.#preview.canvas, { box: "device-pixel-content-box" })
        } catch {
            observer.observe(this.#preview.canvas, { box: "content-box" })
        }
    }

    build(src: string) {
        this.#scene = new SceneInfo(src.trim())
        const sceneSDF = this.#scene.compile()
        this.#shaderCompiler = new ShaderCompiler(this.#device).replace("insert", "sceneSDF", sceneSDF)
        this.#sceneShader = this.#shaderCompiler.compile(previewShader, "Preview Window")
        this.#exportShader = this.#shaderCompiler.compile(exportShader, "Export")
        // console.log(this.#exportShader.text)
        this.#buildPreviewPipeline()

        this.#scene.root.updateScene((index, data) => {
            this.#device.queue.writeBuffer(this.#uniformBuffers.scene, index * 16, data)
            // this.#device.queue.writeBuffer(this.#exportBuffers.scene, index * 16, data)
        })
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
        this.#createBuffers()
    }

    async ready() {
        if (this.#initializing) {
            await this.#initializing
            this.#initializing = null
        }
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
            size: 96,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "camera",
        })
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
                targets: [{ format }],
            },
            primitive: {
                topology: "triangle-strip",
                stripIndexFormat: "uint32",
            },
        })
        this.#bindGroup = this.#device.createBindGroup({
            label: "scenePreview",
            layout: this.#pipeline.getBindGroupLayout(0),
            entries: [
                // { binding: 0, resource: { buffer: this.#uniformBuffers.scene } },
                { binding: 1, resource: { buffer: this.#uniformBuffers.camera } },
            ],
        })
    }

    update(time: number): void {
        this.#updateFPS(time)

        this.#device.queue.writeBuffer(this.#uniformBuffers.camera, 0, this.#controls.viewTransform.data)
        this.#device.queue.writeBuffer(this.#uniformBuffers.camera, 64, this.#controls.cameraPosition.data)
        this.#device.queue.writeBuffer(this.#uniformBuffers.camera, 64 + 16, this.#cameraRes.data)
        this.#device.queue.writeBuffer(this.#uniformBuffers.camera, 64 + 16 + 8, new Float32Array([this.#controls.zoom]))

        const commandEncoder = this.#device.createCommandEncoder()
        const renderPass = commandEncoder.beginRenderPass({
            colorAttachments: [
                {
                    view: this.#context.getCurrentTexture().createView(),
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

    #updateFPS(time: number) {
        const deltaTime = time - this.#lastRenderTime
        this.#lastRenderTime = time
        this.#framerate.update(1000 / deltaTime)
        this.#preview.updateFPS(this.#framerate.average)
    }

    async exportSTL(src: string, handle: FileSystemHandle) {
        this.build(src)
        const cs = 1 / 64
        const exporter = new ODCExport(this.#device, {
            dimX: 32,
            dimY: 32,
            dimZ: 32,
            boundsMin: [-1, -1, -1],
            cellSize: [0.01, 0.01, 0.01],
            maxTrisPerCell: 6,
        })

        await exporter.export(this.#exportShader, handle)
    }
}
