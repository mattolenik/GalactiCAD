import previewShader from "./shaders/preview.wgsl"

export class SDFRenderer {
    private canvas: HTMLCanvasElement
    private device!: GPUDevice
    private context!: GPUCanvasContext
    private pipeline!: GPURenderPipeline
    private bindGroup!: GPUBindGroup
    private uniformBuffer!: GPUBuffer
    // private storageBuffer!: GPUBuffer

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas
    }

    async initialize(): Promise<void> {
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

        // // Create storage buffer
        // const shapeSize = getStructSize(new SDConstruct())
        // const storageSize = shapeSize * this.shapes.length

        // this.storageBuffer = this.device.createBuffer({
        //     size: storageSize,
        //     usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        // })
        // this.updateBuffer(this.storageBuffer, this.shapes)

        // Create uniform buffer with calculated size
        const uniformsSize = 690 // TODO: nonsense
        this.uniformBuffer = this.device.createBuffer({
            size: uniformsSize,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })

        const shaderModule = this.device.createShaderModule({
            label: "SDF Preview",
            code: previewShader,
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
                // {
                //     binding: 1,
                //     resource: { buffer: this.storageBuffer },
                // },
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

        // this.updateBuffer(this.uniformBuffer, this.uniforms)

        renderPass.setPipeline(this.pipeline)
        renderPass.setBindGroup(0, this.bindGroup)
        renderPass.draw(4)
        renderPass.end()

        this.device.queue.submit([commandEncoder.finish()])
    }

    updateBuffer(buffer: GPUBuffer, obj: any) {
        // this.device.queue.writeBuffer(buffer, offset, obj[prop])
    }
}
