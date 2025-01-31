import "reflect-metadata"
import previewShader from "./shaders/preview.wgsl"

// Decorators for WGSL struct layout
function vec4f(target: any, propertyKey: string) {
    Reflect.defineMetadata("wgsl:size", 16, target, propertyKey)
    Reflect.defineMetadata("wgsl:align", 16, target, propertyKey)
}

function f32(target: any, propertyKey: string) {
    Reflect.defineMetadata("wgsl:size", 4, target, propertyKey)
    Reflect.defineMetadata("wgsl:align", 4, target, propertyKey)
}

// Helper to calculate struct size
function getStructSize(target: any): number {
    let size = 0
    let maxAlign = 0

    for (const prop of Object.getOwnPropertyNames(target)) {
        const align = Reflect.getMetadata("wgsl:align", target, prop) || 0
        const fieldSize = Reflect.getMetadata("wgsl:size", target, prop) || 0

        maxAlign = Math.max(maxAlign, align)
        size = Math.ceil(size / align) * align + fieldSize
    }

    return Math.ceil(size / maxAlign) * maxAlign
}

class Particle {
    [key: string]: any
    @vec4f position = new Float32Array([0, 0, 0, 1])
    @f32 mass = new Float32Array([1.0])
}

class Uniforms {
    [key: string]: any
    @vec4f color = new Float32Array([1.0, 0.0, 0.0, 1.0])
    @f32 radius = new Float32Array([0.25])
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
    private particles: Particle[] = []

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
            const particle = new Particle()
            particle.position = new Float32Array([Math.random() * 2 - 1, Math.random() * 2 - 1, 0, 1])
            particle.mass = new Float32Array([Math.random() * 0.5 + 0.5])
            this.particles.push(particle)
        }

        // Create storage buffer
        const particleSize = getStructSize(new Particle())
        const storageSize = particleSize * this.numParticles

        this.storageBuffer = this.device.createBuffer({
            size: storageSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        })

        const shaderModule = this.device.createShaderModule({
            label: "SDF shader",
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
        for (const particle of this.particles) {
            for (const prop of Object.getOwnPropertyNames(particle)) {
                const align = Reflect.getMetadata("wgsl:align", particle, prop)
                storageOffset = Math.ceil(storageOffset / align) * align

                this.device.queue.writeBuffer(this.storageBuffer, storageOffset, particle[prop])

                storageOffset += Reflect.getMetadata("wgsl:size", particle, prop)
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
            const align = Reflect.getMetadata("wgsl:align", this.uniforms, prop)
            offset = Math.ceil(offset / align) * align

            this.device.queue.writeBuffer(this.uniformBuffer, offset, this.uniforms[prop])

            offset += Reflect.getMetadata("wgsl:size", this.uniforms, prop)
        }

        renderPass.setPipeline(this.pipeline)
        renderPass.setBindGroup(0, this.bindGroup)
        renderPass.draw(4)
        renderPass.end()

        this.device.queue.submit([commandEncoder.finish()])
    }
}
