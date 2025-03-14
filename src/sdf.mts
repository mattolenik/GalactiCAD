import { OrbitControls } from "./orbitcontrols.mjs"
import { Group, SceneInfo, SceneUniform, Sphere, Union } from "./scene/scene.mjs"
import previewShader from "./shaders/preview.wgsl"
import { vec3 } from "./vecmat/vector.mjs"

export class SDFRenderer {
    private bindGroup!: GPUBindGroup
    private canvas: HTMLCanvasElement
    private context!: GPUCanvasContext
    private controls: OrbitControls
    private device!: GPUDevice
    private pipeline!: GPURenderPipeline
    private scene!: SceneUniform
    private uniformBuffer!: GPUBuffer

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas
        const dpr = window.devicePixelRatio || 1
        canvas.width = canvas.clientWidth * dpr
        canvas.height = canvas.clientHeight * dpr
        this.controls = new OrbitControls(canvas, vec3(0, 0, 0), 10, Math.PI / 4, Math.PI / 8)
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

        const sceneRoot = new Group(
            new Union(new Sphere({ pos: vec3(0, 0, 20), r: 10 }), new Sphere({ pos: vec3(10, 0, 20), r: 6 }), 2)
        ).init()

        this.scene = new SceneUniform(sceneRoot)

        this.uniformBuffer = this.device.createBuffer({
            size: Math.max(this.scene.bufferSize, this.device.limits.minUniformBufferOffsetAlignment * 2),
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "scene",
        })

        let shader = previewShader
            .replace(/const\s+NUM_ARGS(\s*:\s*u32)?\s*=\s*\d+.*/, `const NUM_ARGS: u32 = ${this.scene.args.length};`)
            .replace("0; // COMPILEDHERE", sceneRoot.compile())

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
            layout: this.pipeline.getBindGroupLayout(0),
            entries: [
                {
                    binding: 0,
                    resource: { buffer: this.uniformBuffer },
                },
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

        this.controls.updateCamera()
        console.log(`camera ${this.controls.cameraPosition}`)
        this.scene.setCameraPosition(this.controls.cameraPosition)
        this.scene.root.uniformCopy(this.scene)
        this.scene.writeBuffer(this.device, this.uniformBuffer)

        renderPass.setPipeline(this.pipeline)
        renderPass.setBindGroup(0, this.bindGroup)
        renderPass.draw(4)
        renderPass.end()

        this.device.queue.submit([commandEncoder.finish()])
        requestAnimationFrame((time) => this.update(time))
    }
}
