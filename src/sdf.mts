import { Controls } from "./controls.mjs"
import { box, group, SceneInfo, sphere, subtract, union } from "./scene/scene.mjs"
import previewShader from "./shaders/preview.wgsl"
import { ShaderCompiler as PreviewShader } from "./shaders/shader.mjs"
import { vec3 } from "./vecmat/vector.mjs"

class UniformBuffers {
    cameraPosition!: GPUBuffer
    orthoScale!: GPUBuffer
    scene!: GPUBuffer
    sceneTransform!: GPUBuffer
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
    #shader!: PreviewShader
    #uniformBuffers: UniformBuffers

    constructor(canvas: HTMLCanvasElement) {
        this.#canvas = canvas
        const dpr = window.devicePixelRatio || 1
        canvas.width = canvas.clientWidth * dpr
        canvas.height = canvas.clientHeight * dpr
        canvas.tabIndex = 1
        this.#controls = new Controls(canvas, vec3(0, 0, 0), 50) //, Math.PI / 1, Math.PI / 8)
        this.#uniformBuffers = new UniformBuffers()
        this.#initializing = this.initialize()
    }

    async testScene() {
        await this.ready() // MUST be called before building the scene

        const sceneInfo = new SceneInfo(
            new Function(
                "box",
                "group",
                "sphere",
                "subtract",
                "union",
                `return group(
                    union(
                            box( [1,-4,4], [30,5,3] ),
                            subtract( box( [0,0,0], [10,20,8] ), sphere( [0,0,-10], {r:6} ), 2),
                        3
                    )
                )`
            )(box, group, sphere, subtract, union)
        )
        await this.buildScene(sceneInfo)
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
    }

    // rebuild/refresh from the scene
    async buildScene(sceneInfo: SceneInfo): Promise<void> {
        return new Promise((resolve): void => {
            this.#scene = sceneInfo
            const bufSize = Math.max(this.#scene.bufferSize, this.#device.limits.minUniformBufferOffsetAlignment * 2)
            console.log(bufSize)
            this.#uniformBuffers.scene = this.#device.createBuffer({
                size: bufSize,
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

            this.#shader = new PreviewShader(previewShader, "Preview Window")
                .replace("replace", "NUM_ARGS", `const NUM_ARGS: u32 = ${this.#scene.args.length};`)
                .replace("insert", "sceneSDF", this.#scene.compile())
            console.log(this.#shader.text)
            const shaderModule = this.#shader.createModule(this.#device)

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
                ],
            })
            resolve()
        })
    }

    update(time: number): void {
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

        this.#scene.root.updateScene()

        this.#device.queue.writeBuffer(this.#uniformBuffers.scene, 0, this.#scene.args.data)
        this.#device.queue.writeBuffer(this.#uniformBuffers.sceneTransform, 0, this.#controls.camera.sceneTransform.data)
        this.#device.queue.writeBuffer(this.#uniformBuffers.cameraPosition, 0, this.#controls.camera.position.data)
        this.#device.queue.writeBuffer(this.#uniformBuffers.orthoScale, 0, new Float32Array([this.#controls.camera.orthoScale]))

        renderPass.setPipeline(this.#pipeline)
        renderPass.setBindGroup(0, this.#bindGroup)
        renderPass.draw(4)
        renderPass.end()

        this.#device.queue.submit([commandEncoder.finish()])
        requestAnimationFrame(time => this.update(time))
    }
}
