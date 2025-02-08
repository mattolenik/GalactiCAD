import "reflect-metadata"
import previewShader from "./shaders/preview.wgsl"
import { vec4f, f32, getStructSize, Metadata } from "./wgsl.mjs"

class Shape {
    [key: string]: any
    @vec4f position = new Float32Array([0, 0, 0, 1])
    @f32 mass = new Float32Array([1.0])
}

class Uniforms {
    [key: string]: any
}

export class SDFRenderer {
    private canvas: HTMLCanvasElement
    private device!: GPUDevice
    private context!: GPUCanvasContext
    private pipeline!: GPURenderPipeline
    private bindGroup!: GPUBindGroup
    private uniformBuffer!: GPUBuffer
    private storageBuffer!: GPUBuffer
    private numParticles = 100
    private shapes: Shape[] = []

    private uniforms = new Uniforms()

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

        // Initialize particles
        for (let i = 0; i < this.numParticles; i++) {
            const particle = new Shape()
            particle.position = new Float32Array([Math.random() * 2 - 1, Math.random() * 2 - 1, 0, 1])
            particle.mass = new Float32Array([Math.random() * 0.5 + 0.5])
            this.shapes.push(particle)
        }

        // Create storage buffer
        const particleSize = getStructSize(new Shape())
        const storageSize = particleSize * this.numParticles

        this.storageBuffer = this.device.createBuffer({
            size: storageSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        })

        const shaderModule = this.device.createShaderModule({
            label: "SDF Preview",
            code: previewShader,
        })

        // Create uniform buffer with calculated size
        const uniformsSize = getStructSize(this.uniforms)
        this.uniformBuffer = this.device.createBuffer({
            size: uniformsSize,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })

        // Create bind group
        // Update storage buffer
        let storageOffset = 0
        for (const shape of this.shapes) {
            for (const prop of Object.getOwnPropertyNames(shape)) {
                const align = Reflect.getMetadata(Metadata.ALIGN, shape, prop)
                storageOffset = Math.ceil(storageOffset / align) * align

                this.device.queue.writeBuffer(this.storageBuffer, storageOffset, shape[prop])

                storageOffset += Reflect.getMetadata(Metadata.SIZE, shape, prop)
            }
        }

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
                {
                    binding: 1,
                    resource: { buffer: this.storageBuffer },
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

        // Update uniform buffer using offsets from metadata
        let offset = 0
        for (const prop of Object.getOwnPropertyNames(this.uniforms)) {
            const align = Reflect.getMetadata(Metadata.ALIGN, this.uniforms, prop)
            offset = Math.ceil(offset / align) * align

            this.device.queue.writeBuffer(this.uniformBuffer, offset, this.uniforms[prop])

            offset += Reflect.getMetadata(Metadata.SIZE, this.uniforms, prop)
        }

        renderPass.setPipeline(this.pipeline)
        renderPass.setBindGroup(0, this.bindGroup)
        renderPass.draw(4)
        renderPass.end()

        this.device.queue.submit([commandEncoder.finish()])
    }
}
