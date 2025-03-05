import { Group, SceneArgsUniform as SceneUniform, Sphere } from "./scene/scene.mjs"
import previewShader from "./shaders/preview.wgsl"
import { vec3 } from "./vecmat/vector.mjs"

export class SDFRenderer {
    private canvas: HTMLCanvasElement
    private device!: GPUDevice
    private context!: GPUCanvasContext
    private pipeline!: GPURenderPipeline
    private bindGroup!: GPUBindGroup
    private uniformBuffer!: GPUBuffer
    private scene!: SceneUniform

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas
    }

    async initialize() {
        const adapter = await navigator.gpu.requestAdapter()
        if (!adapter) throw new Error("No GPU adapter found")

        this.device = await adapter.requestDevice()
        this.context = this.canvas.getContext("webgpu") as GPUCanvasContext

        const format = navigator.gpu.getPreferredCanvasFormat()
        this.context.configure({
            device: this.device,
            format,
            alphaMode: "premultiplied",
        })

        const sceneRoot = new Group([new Sphere({ pos: vec3(0, 0, 0), r: 10 })])

        sceneRoot.sceneSetup()
        this.scene = new SceneUniform(sceneRoot.scene.numArgs)

        const uniformsSize = this.scene.bufferSize
        this.uniformBuffer = this.device.createBuffer({
            size: uniformsSize,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })

        let shader = previewShader
            .replace(/NUM_ARGS\s*=\s*\d+/, `NUM_ARGS = ${this.scene.args.length}`)
            .replace("// COMPILEDHERE", sceneRoot.compile())

        console.log(shader)

        const shaderModule = this.device.createShaderModule({
            label: "SDF Preview",
            code: shader,
        })

        this.pipeline = this.device.createRenderPipeline({
            label: "SDF pipeline",
            layout: "auto",
            vertex: {
                module: shaderModule,
                entryPoint: "vertexMain",
            },
            fragment: {
                module: shaderModule,
                entryPoint: "fragmentMain",
                targets: [
                    {
                        format,
                    },
                ],
            },
            primitive: {
                topology: "triangle-strip",
                stripIndexFormat: "uint32",
            },
        })

        this.bindGroup = this.device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(0),
            entries: [
                {
                    binding: 0,
                    resource: { buffer: this.uniformBuffer },
                },
            ],
        })
    }

    render(): void {
        const commandEncoder = this.device.createCommandEncoder()
        const renderPass = commandEncoder.beginRenderPass({
            colorAttachments: [
                {
                    view: this.context.getCurrentTexture().createView(),
                    clearValue: { r: 0, g: 0, b: 0, a: 1 },
                    loadOp: "clear",
                    storeOp: "store",
                },
            ],
        })

        this.scene.writeBuffer(this.device, this.uniformBuffer)

        renderPass.setPipeline(this.pipeline)
        renderPass.setBindGroup(0, this.bindGroup)
        renderPass.draw(4)
        renderPass.end()

        this.device.queue.submit([commandEncoder.finish()])
    }
}
