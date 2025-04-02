import { Controls } from "./controls.mjs"
import { Box, Group, Node, SceneUniform, Sphere, Subtract, Union } from "./scene/scene.mjs"
import previewShader from "./shaders/preview.wgsl"
import { vec3, Vec4f } from "./vecmat/vector.mjs"

class UniformBuffers {
    cameraPosition!: GPUBuffer
    scene!: GPUBuffer
    orthoScale!: GPUBuffer
    sceneTransform!: GPUBuffer
    inverseSceneTransform!: GPUBuffer
    group = 0
}

export class SDFRenderer {
    private bindGroup!: GPUBindGroup
    private canvas: HTMLCanvasElement
    private context!: GPUCanvasContext
    private controls: Controls
    private device!: GPUDevice
    private pipeline!: GPURenderPipeline
    private scene!: SceneUniform
    private uniformBuffers: UniformBuffers

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas
        const dpr = window.devicePixelRatio || 1
        canvas.width = canvas.clientWidth * dpr
        canvas.height = canvas.clientHeight * dpr
        canvas.tabIndex = 1
        this.controls = new Controls(canvas, vec3(0, 0, 0), 50) //, Math.PI / 1, Math.PI / 8)
        this.uniformBuffers = new UniformBuffers()
    }

    async testScene() {
        await this.initialize(
            // new Group(new Union(new Sphere({ pos: vec3(0, 0, 0), r: 10 }), new Sphere({ pos: vec3(0, 0, -14), r: 6 }), 10)).init()
            new Group(
                new Union(
                    new Box({ pos: vec3(10, -10, 4), l: 30, w: 5, h: 3 }),
                    new Subtract(new Box({ pos: vec3(0, 0, 0), l: 10, w: 20, h: 8 }), new Sphere({ pos: vec3(0, 0, -8), r: 6 }), 1),
                    3
                )
            ).init()
        )
    }

    async initialize(sceneRoot: Node) {
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

        this.scene = new SceneUniform(sceneRoot)

        console.log(Math.max(this.scene.bufferSize, this.device.limits.minUniformBufferOffsetAlignment * 2))
        this.uniformBuffers.scene = this.device.createBuffer({
            size: Math.max(this.scene.bufferSize, this.device.limits.minUniformBufferOffsetAlignment * 2),
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "scene",
        })

        this.uniformBuffers.sceneTransform = this.device.createBuffer({
            size: 64,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "sceneTransform",
        })

        this.uniformBuffers.cameraPosition = this.device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "cameraPosition",
        })

        this.uniformBuffers.orthoScale = this.device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "orthoScale",
        })

        let shader = previewShader
            .replace(/NUM_ARGS.*\/\:\) replace/, `NUM_ARGS: u32 = ${this.scene.args.length};`)
            .replace(/.*\/\/:\) insert sceneSDF/, "    return " + this.scene.root.compile())

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
                targets: [{ format }],
            },
            primitive: {
                topology: "triangle-strip",
                stripIndexFormat: "uint32",
            },
        })

        this.bindGroup = this.device.createBindGroup({
            label: "scene",
            layout: this.pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuffers.scene } },
                { binding: 1, resource: { buffer: this.uniformBuffers.sceneTransform } },
                { binding: 2, resource: { buffer: this.uniformBuffers.cameraPosition } },
                { binding: 3, resource: { buffer: this.uniformBuffers.orthoScale } },
            ],
        })
    }

    update(time: number): void {
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

        this.scene.root.uniformCopy(this.scene)

        this.device.queue.writeBuffer(this.uniformBuffers.scene, 0, this.scene.args.data)
        this.device.queue.writeBuffer(this.uniformBuffers.sceneTransform, 0, this.controls.camera.sceneTransform.data)
        this.device.queue.writeBuffer(this.uniformBuffers.cameraPosition, 0, this.controls.camera.position.data)
        this.device.queue.writeBuffer(this.uniformBuffers.orthoScale, 0, new Float32Array([this.controls.camera.orthoScale]))

        renderPass.setPipeline(this.pipeline)
        renderPass.setBindGroup(0, this.bindGroup)
        renderPass.draw(4)
        renderPass.end()

        this.device.queue.submit([commandEncoder.finish()])
        requestAnimationFrame(time => this.update(time))
    }
}
