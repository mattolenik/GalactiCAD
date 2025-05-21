import { AveragedBuffer } from "./collections/averagedbuffer.mjs"
import { PreviewWindow } from "./components/preview-window.mjs"
import { CameraController } from "./controls/camera-controller.mjs"
import { SceneInfo } from "./scene/scene.mjs"
import previewShader from "./shaders/preview.wgsl"
import exportShader from "./shaders/export.wgsl"
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
    #sceneShader!: ShaderCompiler
    #started = false
    #uniformBuffers: UniformBuffers
    #exportBuffers: ExportBuffers
    #exportShader!: ShaderCompiler

    constructor(preview: PreviewWindow) {
        this.#preview = preview
        this.#controls = new CameraController(preview, vec3(0, 0, 0), 50)
        this.#uniformBuffers = new UniformBuffers()
        this.#exportBuffers = new ExportBuffers()
        this.#createExportBuffers()
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
        this.#sceneShader = new ShaderCompiler(previewShader, "Preview Window").replace("insert", "sceneSDF", sceneSDF)
        this.#exportShader = new ShaderCompiler(exportShader, "Export").replace("insert", "sceneSDF", sceneSDF)
        this.#buildPreviewPipeline()

        this.#scene.root.updateScene((index, data) => {
            this.#device.queue.writeBuffer(this.#uniformBuffers.scene, index * 16, data)
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

    #createExportBuffers() {}

    #buildPreviewPipeline() {
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

    async exportSTL(src: string): Promise<ArrayBuffer> {
        this.build(src)
        const bufferSize = 16777216 // 16 MB
        console.log(this.#exportBuffers.scene)

        this.#exportBuffers.vertexBuffer = this.#device.createBuffer({
            size: bufferSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            mappedAtCreation: false,
        })

        this.#exportBuffers.triangleBuffer = this.#device.createBuffer({
            size: bufferSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            mappedAtCreation: false,
        })

        this.#exportBuffers.triCountBuffer = this.#device.createBuffer({
            size: 4, // atomic<u32>
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            mappedAtCreation: false,
        })
        const shaderModule = this.#exportShader.createModule(this.#device)
        const bindGroupLayout = this.#device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
            ],
        })

        const pipelineLayout = this.#device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] })

        const computePipeline = this.#device.createComputePipeline({
            layout: pipelineLayout,
            compute: {
                module: shaderModule,
                entryPoint: "main",
            },
        })

        const bindGroup = this.#device.createBindGroup({
            layout: bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.#exportBuffers.scene } },
                { binding: 1, resource: { buffer: this.#exportBuffers.vertexBuffer } },
                { binding: 2, resource: { buffer: this.#exportBuffers.triangleBuffer } },
                { binding: 3, resource: { buffer: this.#exportBuffers.triCountBuffer } },
            ],
        })

        const readBufferSize = 16777216

        const readVertexBuffer = this.#device.createBuffer({
            size: readBufferSize,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        })

        const readTriangleBuffer = this.#device.createBuffer({
            size: readBufferSize,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        })

        const readTriCountBuffer = this.#device.createBuffer({
            size: 4,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        })

        const computeCE = this.#device.createCommandEncoder()
        const passEncoder = computeCE.beginComputePass()

        passEncoder.setPipeline(computePipeline)
        passEncoder.setBindGroup(0, bindGroup)

        passEncoder.dispatchWorkgroups(8, 8, 4)

        passEncoder.end()

        const copyCE = this.#device.createCommandEncoder()
        copyCE.copyBufferToBuffer(this.#uniformBuffers.scene, 0, this.#exportBuffers.scene, 0, this.#uniformBuffers.scene.size)
        copyCE.copyBufferToBuffer(this.#exportBuffers.vertexBuffer, 0, readVertexBuffer, 0, readBufferSize)
        copyCE.copyBufferToBuffer(this.#exportBuffers.triangleBuffer, 0, readTriangleBuffer, 0, readBufferSize)
        copyCE.copyBufferToBuffer(this.#exportBuffers.triCountBuffer, 0, readTriCountBuffer, 0, 4)

        this.#device.queue.submit([computeCE.finish(), copyCE.finish()])

        await Promise.allSettled([
            await readVertexBuffer.mapAsync(GPUMapMode.READ),
            await readTriangleBuffer.mapAsync(GPUMapMode.READ),
            await readTriCountBuffer.mapAsync(GPUMapMode.READ),
        ])
        console.log(this.#exportBuffers.vertexBuffer)

        const vertices = new Float32Array(readVertexBuffer.getMappedRange())
        const triangles = new Uint32Array(readTriangleBuffer.getMappedRange())
        const triCountArray = new Uint32Array(readTriCountBuffer.getMappedRange())
        const triCount = triCountArray[0]

        const stlSize = 84 + triCount * 50 // 84-byte header + 50 bytes per triangle
        const stlBuffer = new ArrayBuffer(stlSize)
        const dv = new DataView(stlBuffer)

        console.log("vertices", vertices)
        // 80-byte header (can be blank)
        let offset = 80
        dv.setUint32(offset, triCount, true)
        offset += 4

        for (let i = 0; i < triCount; i++) {
            const idx0 = triangles[i * 3] * 6
            const idx1 = triangles[i * 3 + 1] * 6
            const idx2 = triangles[i * 3 + 2] * 6

            const v0 = vertices.slice(idx0, idx0 + 3)
            const v1 = vertices.slice(idx1, idx1 + 3)
            const v2 = vertices.slice(idx2, idx2 + 3)

            // Compute normal
            const ux = v1[0] - v0[0]
            const uy = v1[1] - v0[1]
            const uz = v1[2] - v0[2]
            const vx = v2[0] - v0[0]
            const vy = v2[1] - v0[1]
            const vz = v2[2] - v0[2]

            const nx = uy * vz - uz * vy
            const ny = uz * vx - ux * vz
            const nz = ux * vy - uy * vx
            const norm = Math.hypot(nx, ny, nz) || 1

            dv.setFloat32(offset, nx / norm, true)
            dv.setFloat32(offset + 4, ny / norm, true)
            dv.setFloat32(offset + 8, nz / norm, true)

            dv.setFloat32(offset + 12, v0[0], true)
            dv.setFloat32(offset + 16, v0[1], true)
            dv.setFloat32(offset + 20, v0[2], true)

            dv.setFloat32(offset + 24, v1[0], true)
            dv.setFloat32(offset + 28, v1[1], true)
            dv.setFloat32(offset + 32, v1[2], true)

            dv.setFloat32(offset + 36, v2[0], true)
            dv.setFloat32(offset + 40, v2[1], true)
            dv.setFloat32(offset + 44, v2[2], true)

            dv.setUint16(offset + 48, 0, true) // attribute byte count
            offset += 50
        }

        readVertexBuffer.unmap()
        readTriangleBuffer.unmap()
        readTriCountBuffer.unmap()

        return stlBuffer
    }
}
