import { AveragedBuffer } from "./collections/averagedbuffer.mjs"
import { PreviewWindow } from "./components/preview-window.mjs"
import { CameraController } from "./controls/camera-controller.mjs"
import { GPUHelper } from "./gpu/helper.mjs"
import { MDCParams, MDCExport } from "./export/mdc.mjs"
import { SceneInfo } from "./scene/scene.mjs"
import exportShader from "./shaders/mdc.wgsl"
import previewShader from "./shaders/preview.wgsl"
import boundsShader from "./shaders/bounds.wgsl"
import { ShaderCompiler } from "./shaders/shader.mjs"
import { vec2, Vec2f, vec3 } from "./vecmat/vector.mjs"
import { MeshData } from "./export/export.mjs"
import { PALETTE_SIZE, DEFAULT_PALETTE, paletteToFloat32Array } from "./colorPalette.mjs"

class UniformBuffers {
    camera!: GPUBuffer
    scene!: GPUBuffer
    clickState!: GPUBuffer
    selectedObjectIds!: GPUBuffer
    clickedObjectId!: GPUBuffer
    colorPalette!: GPUBuffer
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
    #selectedObjectIds: number[] = []
    #clickPos: Vec2f = vec2(0, 0)
    #exportBuffers: ExportBuffers
    #shaderCompiler!: ShaderCompiler
    #sceneShader!: GPUShaderModule
    #exportShader!: GPUShaderModule
    #boundsShader!: GPUShaderModule
    #helper!: GPUHelper
    #builtSrc: string | null = null

    /**
     * Callback invoked when object selection changes
     * Provides the array of currently selected object IDs
     */
    onSelectionChange?: (selectedIds: number[]) => void

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

    get selectedObjectIds(): number[] {
        return [...this.#selectedObjectIds]
    }
    
    /**
     * Get all nodes from the current scene for matching with source code.
     */
    getSceneNodes() {
        return this.#scene?.getAllNodes() ?? []
    }

    async #readClickedObjectId(): Promise<number> {
        // Read back clicked object ID from storage buffer
        const readback = await this.#helper.readBufferData(this.#uniformBuffers.clickedObjectId, 4)
        return new Uint32Array(readback)[0]
    }

    #handleClick(screenPos: Vec2f, shiftKey: boolean) {
        // Convert screen coordinates to UV coordinates (0-1 range)
        const canvas = this.#preview.canvas
        const rect = canvas.getBoundingClientRect()
        const x = (screenPos.x - rect.left) / rect.width
        const y = 1.0 - (screenPos.y - rect.top) / rect.height // Flip Y for WGSL UV space
        
        this.#clickPos = vec2(x, y)
        
        console.log(`Click at UV: (${x.toFixed(3)}, ${y.toFixed(3)}), shift: ${shiftKey}`)
        
        // Store click state: must match WGSL ClickState struct layout
        const clickData = new ArrayBuffer(16)
        new Float32Array(clickData, 0, 2).set([x, y])
        new Uint32Array(clickData, 8, 1).set([1])
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickState, 0, clickData)
        
        // Clear clicked object ID buffer
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickedObjectId, 0, new Uint32Array([0]))
        
        // Read back result after a few frames
        setTimeout(async () => {
            try {
                const clickedId = await this.#readClickedObjectId()
                if (clickedId > 0) {
                    this.#updateSelection(clickedId, shiftKey)
                } else {
                    console.log('No object clicked - clickedId was 0')
                }
            } catch (error) {
                console.error('Error reading clicked object ID:', error)
            }
        }, 200)
    }

    #updateSelection(clickedId: number, shiftKey: boolean) {
        const index = this.#selectedObjectIds.indexOf(clickedId)
        
        if (shiftKey) {
            // Multiselect mode: toggle the clicked object
            if (index >= 0) {
                // Remove from selection
                this.#selectedObjectIds.splice(index, 1)
                console.log(`Removed object ${clickedId} from selection`)
            } else {
                // Add to selection
                this.#selectedObjectIds.push(clickedId)
                console.log(`Added object ${clickedId} to selection`)
            }
        } else {
            // Single select mode
            if (index >= 0 && this.#selectedObjectIds.length === 1) {
                // Clicking the only selected object deselects it
                this.#selectedObjectIds = []
                console.log('Deselected object')
            } else {
                // Select only the clicked object
                this.#selectedObjectIds = [clickedId]
                console.log(`Selected object ID: ${clickedId}`)
            }
        }
        
        this.#writeSelectionBuffer()
        
        // Notify listeners about selection change
        if (this.onSelectionChange) {
            this.onSelectionChange([...this.#selectedObjectIds])
        }
    }

    #writeSelectionBuffer() {
        // Write selection array to GPU buffer
        // Format: [count, id1, id2, ...] with 64 slots available (256 bytes total)
        const data = new Uint32Array(64)
        data[0] = this.#selectedObjectIds.length
        for (let i = 0; i < this.#selectedObjectIds.length; i++) {
            data[i + 1] = this.#selectedObjectIds[i]
        }
        this.#device.queue.writeBuffer(this.#uniformBuffers.selectedObjectIds, 0, data)
    }

    constructor(preview: PreviewWindow) {
        this.#preview = preview
        this.#controls = new CameraController(preview, vec3(0, 0, 0), 50)
        this.#controls.onSelect = (screenPos: Vec2f, shiftKey: boolean) => this.#handleClick(screenPos, shiftKey)
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
        const sceneSDF = this.#scene.compile()    // Returns SDFResult (distance + gradient magnitude)
        this.#shaderCompiler = new ShaderCompiler(this.#device)
            .replace("insert", "sceneSDF", sceneSDF)
        this.#sceneShader = this.#shaderCompiler.compile(previewShader, "Preview Window")
        this.#exportShader = this.#shaderCompiler.compile(exportShader, "Export")
        this.#boundsShader = this.#shaderCompiler.compile(boundsShader, "Bounds (scene bbox)")
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
        // Initialize click detection buffers to 0
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickState, 0, new Uint32Array([0, 0]))
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickedObjectId, 0, new Uint32Array([0]))
        // Initialize selection buffer with count=0
        this.#device.queue.writeBuffer(this.#uniformBuffers.selectedObjectIds, 0, new Uint32Array(64))
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

        // Click detection buffers - pad to 16 bytes for alignment
        this.#uniformBuffers.clickState = this.#device.createBuffer({
            size: 16, // vec2f (8) + u32 (4) + u32 (4 padding) = 16
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "clickState",
        })

        this.#uniformBuffers.selectedObjectIds = this.#device.createBuffer({
            size: 256, // 64 u32s: [count, id1, id2, ...] up to 63 selected objects
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "selectedObjectIds",
        })

        this.#uniformBuffers.clickedObjectId = this.#device.createBuffer({
            size: 4, // u32
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            label: "clickedObjectId",
        })

        // Color palette buffer: 32 colors × 3 floats (vec3f) = 384 bytes
        // Using vec3f in WGSL requires 16 byte alignment per element (4 floats)
        // So we need 32 × 16 = 512 bytes
        this.#uniformBuffers.colorPalette = this.#device.createBuffer({
            size: PALETTE_SIZE * 16, // 32 colors × 16 bytes (vec3f with alignment)
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "colorPalette",
        })

        // Initialize palette with default colors
        const paletteData = paletteToFloat32Array(DEFAULT_PALETTE)
        // Need to write with 16-byte alignment per color (4 floats per color, last is padding)
        const alignedData = new Float32Array(PALETTE_SIZE * 4)
        for (let i = 0; i < PALETTE_SIZE; i++) {
            alignedData[i * 4] = paletteData[i * 3]
            alignedData[i * 4 + 1] = paletteData[i * 3 + 1]
            alignedData[i * 4 + 2] = paletteData[i * 3 + 2]
            alignedData[i * 4 + 3] = 0.0 // padding
        }
        this.#device.queue.writeBuffer(this.#uniformBuffers.colorPalette, 0, alignedData)
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
                { binding: 2, resource: { buffer: this.#uniformBuffers.clickState } },
                { binding: 3, resource: { buffer: this.#uniformBuffers.clickedObjectId } },
                { binding: 4, resource: { buffer: this.#uniformBuffers.selectedObjectIds } },
                { binding: 5, resource: { buffer: this.#uniformBuffers.colorPalette } },
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

    async #computeSceneBounds(searchMin: [number, number, number], searchMax: [number, number, number], stepMm: number) {
        // Quantize to microns for integer reduction.
        const SCALE = 1000

        const dimsX = Math.max(1, Math.ceil((searchMax[0] - searchMin[0]) / stepMm) + 1)
        const dimsY = Math.max(1, Math.ceil((searchMax[1] - searchMin[1]) / stepMm) + 1)
        const dimsZ = Math.max(1, Math.ceil((searchMax[2] - searchMin[2]) / stepMm) + 1)

        // Must match WGSL uniform layout for `BoundsUniforms` in `bounds.wgsl`.
        // Layout (uniform address space):
        // - searchMinStep: vec4f  @0   size 16
        // - searchMaxIso : vec4f  @16  size 16
        // - dims         : vec4u  @32  size 16
        // - scale        : f32    @48  size 4
        // - _pad0        : vec3f  @64  size 12 (but occupies 16 due to alignment)
        // Total size = 80 bytes.
        const uniformsData = new ArrayBuffer(80)
        // searchMinStep vec4f @0
        new Float32Array(uniformsData, 0, 4).set([searchMin[0], searchMin[1], searchMin[2], stepMm])
        // searchMaxIso vec4f @16
        new Float32Array(uniformsData, 16, 4).set([searchMax[0], searchMax[1], searchMax[2], 0.0])
        // dims vec4u @32
        new Uint32Array(uniformsData, 32, 4).set([dimsX >>> 0, dimsY >>> 0, dimsZ >>> 0, 0])
        // scale f32 @48
        new Float32Array(uniformsData, 48, 1).set([SCALE])

        const uniformBuffer = this.#helper.createBuffer(
            "BoundsUniforms",
            uniformsData.byteLength,
            GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        )
        this.#device.queue.writeBuffer(uniformBuffer, 0, uniformsData)

        // Output is one record per dispatched workgroup (see `TileBounds` in `bounds.wgsl`):
        //   minQ: vec4i (16) + maxQ: vec4i (16) + anyInside: u32 (4) + pad u32*3 (12) = 48 bytes
        const TILE_STRIDE_BYTES = 48

        const totalSamples = dimsX * dimsY * dimsZ
        const totalWorkgroups = Math.ceil(totalSamples / 256)
        const dispatchX = Math.min(totalWorkgroups, 65535)
        const dispatchY = Math.ceil(totalWorkgroups / dispatchX)
        const dispatchedWorkgroups = dispatchX * dispatchY

        const outSize = dispatchedWorkgroups * TILE_STRIDE_BYTES
        if (!Number.isFinite(outSize) || outSize <= 0) {
            throw new Error(
                `Bounds compute: invalid out buffer size (dims=${dimsX}x${dimsY}x${dimsZ} step=${stepMm} -> outSize=${outSize})`
            )
        }
        if (outSize > this.#device.limits.maxBufferSize) {
            throw new Error(
                `Bounds compute: out buffer too large (${outSize} bytes) for device maxBufferSize=${this.#device.limits.maxBufferSize}. Try increasing bounds step.`
            )
        }

        const outBuffer = this.#helper.createBuffer(
            "BoundsTiles",
            outSize,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
        )
        // No initialization needed: each dispatched workgroup writes exactly one record.

        const pipeline = this.#helper.createComputePipeline(this.#boundsShader, "computeBounds", "Bounds (compute)")
        const [, bindGroup] = this.#helper.createBindGroup(
            0,
            "Bounds BG",
            pipeline,
            [0, uniformBuffer],
            [1, outBuffer],
            [99, this.#uniformBuffers.selectedObjectIds]
        )

        const ce = this.#device.createCommandEncoder({ label: "bounds_compute" })
        const pass = this.#helper.beginComputePass(ce, pipeline, [0, bindGroup])
        pass.dispatchWorkgroups(dispatchX, dispatchY, 1)
        pass.end()
        this.#device.queue.submit([ce.finish()])
        await this.#device.queue.onSubmittedWorkDone()

        const outData = await this.#helper.readBufferData(outBuffer, outSize)
        const dv = new DataView(outData)

        let any = false
        let minXq = 2147483647
        let minYq = 2147483647
        let minZq = 2147483647
        let maxXq = -2147483648
        let maxYq = -2147483648
        let maxZq = -2147483648

        for (let t = 0; t < dispatchedWorkgroups; t++) {
            const base = t * TILE_STRIDE_BYTES
            const anyInside = dv.getUint32(base + 32, true)
            if (!anyInside) continue
            any = true

            const txMinX = dv.getInt32(base + 0, true)
            const txMinY = dv.getInt32(base + 4, true)
            const txMinZ = dv.getInt32(base + 8, true)
            const txMaxX = dv.getInt32(base + 16, true)
            const txMaxY = dv.getInt32(base + 20, true)
            const txMaxZ = dv.getInt32(base + 24, true)

            if (txMinX < minXq) minXq = txMinX
            if (txMinY < minYq) minYq = txMinY
            if (txMinZ < minZq) minZq = txMinZ
            if (txMaxX > maxXq) maxXq = txMaxX
            if (txMaxY > maxYq) maxYq = txMaxY
            if (txMaxZ > maxZq) maxZq = txMaxZ
        }

        if (!any) return null

        const minX = minXq / SCALE
        const minY = minYq / SCALE
        const minZ = minZq / SCALE
        const maxX = maxXq / SCALE
        const maxY = maxYq / SCALE
        const maxZ = maxZq / SCALE

        return { min: [minX, minY, minZ] as const, max: [maxX, maxY, maxZ] as const }
    }

    async #computeSceneBoundsRefined() {
        // Coarse search over a generous region, then refine around result.
        const COARSE_HALF = 250
        const coarse = await this.#computeSceneBounds([-COARSE_HALF, -COARSE_HALF, -COARSE_HALF], [COARSE_HALF, COARSE_HALF, COARSE_HALF], 2.0)
        if (!coarse) return null

        const inflate = 4.0
        const min = [coarse.min[0] - inflate, coarse.min[1] - inflate, coarse.min[2] - inflate] as const
        const max = [coarse.max[0] + inflate, coarse.max[1] + inflate, coarse.max[2] + inflate] as const
        const refined = await this.#computeSceneBounds([min[0], min[1], min[2]], [max[0], max[1], max[2]], 0.5)
        return refined ?? coarse
    }

    async renderMesh(src: string): Promise<MeshData> {
        const trimmed = src.trim()
        if (this.#builtSrc !== trimmed) {
            this.build(trimmed)
        }

        // World units are millimeters (mm).
        // Voxel size is fixed; grid dimensions are derived from a computed scene AABB.
        const voxelSizeMm = 0.1
        const bounds = await this.#computeSceneBoundsRefined()
        if (!bounds) {
            throw new Error("Bounds compute found no inside samples; is the SDF empty or far from origin?")
        }

        // Slightly inflate bounds so we don't clip due to sampling/quantization.
        const pad = 3.2
        const minX = bounds.min[0] - pad
        const minY = bounds.min[1] - pad
        const minZ = bounds.min[2] - pad
        const maxX = bounds.max[0] + pad
        const maxY = bounds.max[1] + pad
        const maxZ = bounds.max[2] + pad

        const sizeX = Math.max(voxelSizeMm, maxX - minX)
        const sizeY = Math.max(voxelSizeMm, maxY - minY)
        const sizeZ = Math.max(voxelSizeMm, maxZ - minZ)

        const gridDimX = Math.max(2, Math.ceil(sizeX / voxelSizeMm) + 1)
        const gridDimY = Math.max(2, Math.ceil(sizeY / voxelSizeMm) + 1)
        const gridDimZ = Math.max(2, Math.ceil(sizeZ / voxelSizeMm) + 1)

        const params: MDCParams = {
            gridDimX,
            gridDimY,
            gridDimZ,
            isoValue: 0.0,
            gridOffsetX: minX,
            gridOffsetY: minY,
            gridOffsetZ: minZ,
            voxelSize: voxelSizeMm,
        }
        console.log(
            `MDC export params: dim=${gridDimX}x${gridDimY}x${gridDimZ} voxel=${voxelSizeMm}mm bbox=[${minX.toFixed(
                3
            )},${minY.toFixed(3)},${minZ.toFixed(3)}]..[${maxX.toFixed(3)},${maxY.toFixed(3)},${maxZ.toFixed(3)}]`
        )

        const mdc = new MDCExport(this.#helper, params, this.#uniformBuffers.selectedObjectIds)
        const mesh = await mdc.export(this.#exportShader)
        const pre = this.#meshEdgeStats(mesh)
        if (pre.nonManifoldEdges > 0) {
            console.warn("[renderMesh] base mesh has non-manifold edges (before mergeCoplanar)")
            this.#logMeshEdgeStats(mesh, "renderMesh:preMerge")
        }
        return mesh
    }
}
