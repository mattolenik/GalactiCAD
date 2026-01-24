import { AveragedBuffer } from "./collections/averagedbuffer.mjs"
import { PreviewWindow } from "./components/preview-window.mjs"
import { CameraController } from "./controls/camera-controller.mjs"
import { GPUHelper } from "./gpu/helper.mjs"
import { MDCParams, MDCExport } from "./export/mdc.mjs"
import { ZSliceExport } from "./export/zslice.mjs"
import { exportStlBinary } from "./export/stl.mjs"
import { SceneInfo } from "./scene/scene.mjs"
import exportShader from "./shaders/mdc.wgsl"
import zsliceShader from "./shaders/zslice.wgsl"
import previewShader from "./shaders/preview.wgsl"
import { ShaderCompiler } from "./shaders/shader.mjs"
import { vec2, Vec2f, vec3 } from "./vecmat/vector.mjs"
import { MeshData } from "./export/export.mjs"
import { mergeCoplanar } from "./export/postprocess.mjs"

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
    #zsliceShader!: GPUShaderModule
    #helper!: GPUHelper
    #builtSrc: string | null = null

    #meshEdgeStats(mesh: MeshData) {
        // `mesh.tris` is a flat triangle index buffer (u32 indices).
        // A watertight manifold surface should have exactly 2 incident triangles per undirected edge.
        const tris = mesh.tris
        const verts = mesh.verts
        const stride = 8 // floats per vertex in MeshData (pos vec3 + pad + normal vec3 + pad)
        const vertexCount = Math.floor(verts.length / stride)
        const triCount = Math.floor(tris.length / 3)

        const edgeCounts = new Map<bigint, number>()
        let degenerateTris = 0
        let outOfRangeIndices = 0

        const edgeKey = (a: number, b: number) => {
            const lo = a < b ? a : b
            const hi = a < b ? b : a
            return (BigInt(lo) << 32n) | BigInt(hi >>> 0)
        }
        const addEdge = (a: number, b: number) => {
            if (a === b) return
            if (a < 0 || b < 0 || a >= vertexCount || b >= vertexCount) {
                outOfRangeIndices++
                return
            }
            const k = edgeKey(a, b)
            edgeCounts.set(k, (edgeCounts.get(k) ?? 0) + 1)
        }

        for (let t = 0; t < triCount; t++) {
            const i0 = tris[t * 3]!
            const i1 = tris[t * 3 + 1]!
            const i2 = tris[t * 3 + 2]!
            if (i0 === i1 || i1 === i2 || i2 === i0) degenerateTris++
            addEdge(i0, i1)
            addEdge(i1, i2)
            addEdge(i2, i0)
        }

        let boundaryEdges = 0
        let nonManifoldEdges = 0
        let maxIncidence = 0
        for (const c of edgeCounts.values()) {
            if (c === 1) boundaryEdges++
            else if (c > 2) nonManifoldEdges++
            if (c > maxIncidence) maxIncidence = c
        }

        const worst: Array<{ k: bigint; c: number }> = []
        if (nonManifoldEdges > 0) {
            for (const [k, c] of edgeCounts) {
                if (c > 2) worst.push({ k, c })
            }
            worst.sort((a, b) => b.c - a.c)
        }

        return {
            vertexCount,
            triCount,
            uniqueEdges: edgeCounts.size,
            boundaryEdges,
            nonManifoldEdges,
            maxIncidence,
            degenerateTris,
            outOfRangeIndices,
            worstEdges: worst,
        }
    }

    #logMeshEdgeStats(mesh: MeshData, label: string) {
        const s = this.#meshEdgeStats(mesh)
        console.log(
            `[${label}] mesh edge stats: verts=${s.vertexCount} tris=${s.triCount} uniqueEdges=${s.uniqueEdges} boundaryEdges=${s.boundaryEdges} nonManifoldEdges=${s.nonManifoldEdges} maxIncidence=${s.maxIncidence} degenerateTris=${s.degenerateTris} outOfRangeEdgeRefs=${s.outOfRangeIndices}`
        )

        // Print a few examples of the worst offenders (counts > 2).
        if (s.nonManifoldEdges > 0) {
            const top = s.worstEdges.slice(0, 10)
            console.log(
                `[${label}] top non-manifold edges (undirected vertex pairs): ` +
                top
                    .map(e => {
                        const lo = Number(e.k >> 32n)
                        const hi = Number(e.k & 0xffffffffn)
                        return `(${lo},${hi}):${e.c}`
                    })
                    .join(", ")
            )

            // For the top offenders, also print incident triangle indices and vertex positions.
            const tris = mesh.tris
            const verts = mesh.verts
            const stride = 8
            const triCount = Math.floor(tris.length / 3)

            const vpos = (vidx: number) => {
                const base = vidx * stride
                return [verts[base]!, verts[base + 1]!, verts[base + 2]!] as const
            }

            const topSet = new Set<bigint>(top.map(e => e.k))
            const incident = new Map<bigint, number[]>()
            for (const e of top) incident.set(e.k, [])

            const edgeKey = (a: number, b: number) => {
                const lo = a < b ? a : b
                const hi = a < b ? b : a
                return (BigInt(lo) << 32n) | BigInt(hi >>> 0)
            }

            // Second pass: collect up to 16 incident triangles per top edge.
            for (let t = 0; t < triCount; t++) {
                const i0 = tris[t * 3]!
                const i1 = tris[t * 3 + 1]!
                const i2 = tris[t * 3 + 2]!
                const edges: [number, number][] = [
                    [i0, i1],
                    [i1, i2],
                    [i2, i0],
                ]
                for (const [a, b] of edges) {
                    if (a === b) continue
                    const k = edgeKey(a, b)
                    if (!topSet.has(k)) continue
                    const arr = incident.get(k)!
                    if (arr.length < 16) arr.push(t)
                }
            }

            for (const e of top) {
                const lo = Number(e.k >> 32n)
                const hi = Number(e.k & 0xffffffffn)
                const p0 = vpos(lo)
                const p1 = vpos(hi)
                const trisList = incident.get(e.k) ?? []
                console.log(
                    `[${label}] edge (${lo},${hi}) count=${e.c} p0=(${p0[0].toFixed(4)},${p0[1].toFixed(4)},${p0[2].toFixed(4)}) p1=(${p1[0].toFixed(4)},${p1[1].toFixed(4)},${p1[2].toFixed(4)}) incidentTris=[${trisList.join(
                        ","
                    )}]`
                )
            }
        }
    }

    get controls(): CameraController {
        return this.#controls
    }

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
                    const w =
                        entry.devicePixelContentBoxSize?.[0].inlineSize ??
                        Math.max(1, Math.round(entry.contentRect.width * devicePixelRatio))
                    const h =
                        entry.devicePixelContentBoxSize?.[0].blockSize ??
                        Math.max(1, Math.round(entry.contentRect.height * devicePixelRatio))
                    this.#preview.canvas.width = w
                    this.#preview.canvas.height = h
                    this.#cameraRes = vec2(w, h)
                }
            })
        })
        try {
            observer.observe(this.#preview, { box: "device-pixel-content-box" })
        } catch {
            observer.observe(this.#preview, { box: "content-box" })
        }
    }

    build(src: string) {
        const trimmed = src.trim()
        this.#builtSrc = trimmed
        this.#scene = new SceneInfo(trimmed)
        const sceneSDF = this.#scene.compile()
        this.#shaderCompiler = new ShaderCompiler(this.#device).replace("insert", "sceneSDF", sceneSDF)
        this.#sceneShader = this.#shaderCompiler.compile(previewShader, "Preview Window")
        this.#exportShader = this.#shaderCompiler.compile(exportShader, "Export")
        this.#zsliceShader = this.#shaderCompiler.compile(zsliceShader, "Export (Z-slice)")
        // console.log(this.#exportShader.text)
        this.#buildPreviewPipeline()

        // this.#scene.root.updateScene((index, data) => {
        //     this.#device.queue.writeBuffer(this.#uniformBuffers.scene, index * 16, data)
        //     // this.#device.queue.writeBuffer(this.#exportBuffers.scene, index * 16, data)
        // })
    }

    async initialize() {
        const helper = await GPUHelper.create()
        if (!helper) {
            throw new Error("No GPU adapter found", { cause: "unsupported" })
        }
        this.#helper = helper
        this.#device = this.#helper.device
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

        this.#device.queue.writeBuffer(this.#uniformBuffers.camera, 0, this.#controls.viewTransform.data as BufferSource)
        this.#device.queue.writeBuffer(this.#uniformBuffers.camera, 64, this.#controls.cameraPosition.data as BufferSource)
        this.#device.queue.writeBuffer(this.#uniformBuffers.camera, 64 + 16, this.#cameraRes.data as BufferSource)
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

    async renderMesh(src: string): Promise<MeshData> {
        const trimmed = src.trim()
        if (this.#builtSrc !== trimmed) {
            this.build(trimmed)
        }
        // World units are millimeters (mm).
        // Default export volume is a 1000mm cube centered at the origin: [-500, 500]^3.
        const DEFAULT_BBOX_MM = 50
        const GRID_DIM = 512  // increase for higher resolution (cost grows ~ cubic)
        const voxelSizeMm = DEFAULT_BBOX_MM / GRID_DIM
        const half = DEFAULT_BBOX_MM / 2

        const params: MDCParams = {
            gridDimX: GRID_DIM,
            gridDimY: GRID_DIM,
            gridDimZ: GRID_DIM,
            isoValue: 0.0,
            gridOffsetX: -half,
            gridOffsetY: -half,
            gridOffsetZ: -half,
            voxelSize: voxelSizeMm,
        }
        console.log(
            `MDC export params: dim=${GRID_DIM} bbox=${DEFAULT_BBOX_MM}mm voxel=${voxelSizeMm}mm offset=${-half}..${half}`
        )

        const mdc = new MDCExport(this.#helper, params)
        const mesh = await mdc.export(this.#exportShader)
        const pre = this.#meshEdgeStats(mesh)
        if (pre.nonManifoldEdges > 0) {
            console.warn("[renderMesh] base mesh has non-manifold edges (before mergeCoplanar)")
            this.#logMeshEdgeStats(mesh, "renderMesh:preMerge")
            return mesh
        }

        // Compare manifoldness before/after post-processing. If merging introduces
        // non-manifold edges, fall back to the unmerged mesh.
        const merged = mergeCoplanar(mesh)
        const post = this.#meshEdgeStats(merged)
        console.log(
            `[renderMesh] mergeCoplanar delta: tris ${pre.triCount} -> ${post.triCount}, boundaryEdges ${pre.boundaryEdges} -> ${post.boundaryEdges}, nonManifoldEdges ${pre.nonManifoldEdges} -> ${post.nonManifoldEdges}`
        )
        if (post.nonManifoldEdges > pre.nonManifoldEdges) {
            console.warn("[renderMesh] mergeCoplanar increased non-manifold edges; returning unmerged mesh")
            this.#logMeshEdgeStats(mesh, "renderMesh:preMerge")
            this.#logMeshEdgeStats(merged, "renderMesh:postMerge")
            return mesh
        }
        if (post.nonManifoldEdges > 0) {
            this.#logMeshEdgeStats(merged, "renderMesh:postMerge")
        }
        return merged
    }

    async renderMeshZSlice(src: string): Promise<MeshData> {
        const trimmed = src.trim()
        if (this.#builtSrc !== trimmed) {
            this.build(trimmed)
        }

        // World units are millimeters (mm).
        // Default export volume is a 100mm cube centered at the origin: [-50, 50]^3.
        // NOTE: z-step defaults to 0.02mm as requested; this can get expensive for tall volumes.
        const DEFAULT_BBOX_MM = 50
        const half = DEFAULT_BBOX_MM / 2
        const GRID_XY_CELLS = 256
        const stepXY = DEFAULT_BBOX_MM / GRID_XY_CELLS
        const stepZ = 0.01

        const zs = new ZSliceExport(this.#helper, {
            minX: -half,
            minY: -half,
            minZ: -half,
            sizeX: DEFAULT_BBOX_MM,
            sizeY: DEFAULT_BBOX_MM,
            sizeZ: DEFAULT_BBOX_MM,
            stepX: stepXY,
            stepY: stepXY,
            stepZ,
            isoValue: 0.0,
        })
        return await zs.export(this.#zsliceShader)
    }
}
