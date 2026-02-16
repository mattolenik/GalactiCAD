import { AveragedBuffer } from "./collections/averagedbuffer.mjs"
import { SettingsManager } from "./storage/settings.mjs"
import { PreviewWindow } from "./components/preview-window.mjs"
import { CameraController } from "./controls/camera-controller.mjs"
import { GPUHelper } from "./gpu/helper.mjs"
import { MDCParams, MDCExport } from "./export/mdc.mjs"
import { SceneInfo, Node, BinaryOperator, Box, Sphere, Union, Subtract, Intersect, Pipe, Engrave, Groove, Tongue, Shell, Offset, Elongate, Twist, Bend, Taper, Morph, Seam, Group, Cylinder, Cone, Torus, Capsule, PlaneNode, HexPrism, Disc, Blob, Rotate, Polygon2D, Extrude, Loft, Lathe } from "./scene/scene.mjs"
import exportShader from "./shaders/mdc.wgsl"
import previewShader from "./shaders/preview.wgsl"
import beamShader from "./shaders/beam.wgsl"
import boundsShader from "./shaders/bounds.wgsl"
import outlineShader from "./shaders/outline.wgsl"
import { ShaderCompiler } from "./shaders/shader.mjs"
import { vec2, Vec2f, vec3 } from "./vecmat/vector.mjs"
import { MeshData } from "./export/export.mjs"
import { PALETTE_SIZE, DEFAULT_PALETTE, paletteToFloat32Array } from "./colorPalette.mjs"

class UniformBuffers {
    camera!: GPUBuffer
    scene!: GPUBuffer
    clickState!: GPUBuffer
    clickedObjectId!: GPUBuffer
    selectedObjectIds!: GPUBuffer
    edgeHit!: GPUBuffer
    selectedEdge!: GPUBuffer
    seamPolyline!: GPUBuffer
    colorPalette!: GPUBuffer
    viewSettings!: GPUBuffer
    outlineSettings!: GPUBuffer
    hoverEdgeHit!: GPUBuffer
    hoveredEdge!: GPUBuffer
}

type EdgeHitData = {
    kind: number
    primaryId: number
    secondaryId: number
    featureA: number
    featureB: number
    opType: number
    objectId: number
    seedPoint: [number, number, number]
    seamDir: [number, number, number]
    segmentHalfLen: number
    segmentHalfWidth: number
}

type SelectedEdgeData = {
    kind: number
    primaryId: number
    secondaryId: number
    featureA: number
    featureB: number
    opType: number
    lineWidthPx: number
    epsilon: number
    seedPoint: [number, number, number]
    seamDir: [number, number, number]
    segmentHalfLen: number
    segmentHalfWidth: number
    seamPolylineCount: number
}

const EDGE_KIND_NONE = 0
const EDGE_KIND_PRIMITIVE = 1
const EDGE_KIND_CSG_SEAM = 2
const NO_HIT_SENTINEL = 0xFFFFFFFF
const NO_FEATURE = 0xFFFFFFFF
const MAX_SEAM_POLYLINE_POINTS = 256
const MAX_SELECTED_EDGES = 16

/** Outline style for selected objects. */
export type OutlineMode = "none" | "solid" | "dashed" | "dotted"

const OUTLINE_MODE_VALUES: Record<OutlineMode, number> = {
    none: 0,
    solid: 1,
    dashed: 2,
    dotted: 3,
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
    #lastActualRenderTime: number = 0  // Time of last actual GPU render
    #lastRenderEndTime: number = 0
    #targetFPS: number = 120  // Limit frame rate to reduce GPU saturation
    #needsRender: boolean = true  // Dirty flag - only render when true
    #pipeline!: GPURenderPipeline
    #preview: PreviewWindow
    #scene!: SceneInfo
    #started = false
    #uniformBuffers: UniformBuffers
    #selectedObjectIds: boolean[] = new Array<boolean>(1024).fill(false)
    #selectedEdges: SelectedEdgeData[] = []
    #edgeLineWidthPx = 3.2
    #edgeEpsilon = 0.03
    #hoverPending = false
    #lastHoverTime = 0
    #hoverThrottleMs = 80
    #lastClickPos: Vec2f = vec2(0, 0)
    #exportBuffers: ExportBuffers
    #shaderCompiler!: ShaderCompiler
    #sceneShader!: GPUShaderModule
    #exportShader!: GPUShaderModule
    #boundsShader!: GPUShaderModule
    #helper!: GPUHelper
    #builtSrc: string | null = null
    #xrayMode: boolean = false
    #selectionMode: import("./storage/settings.mjs").SelectionMode = "object"
    #cameraRotationMode: import("./storage/settings.mjs").CameraRotationMode = "arcball"
    #beamEnabled: boolean = false
    #outlineMode: OutlineMode = "solid"
    #outlineThickness: number = 3
    #outlineColor: [number, number, number] = [0.9, 0.9, 0.9]
    #colorTexture!: GPUTexture
    #idTexture!: GPUTexture
    #colorTextureView!: GPUTextureView
    #idTextureView!: GPUTextureView
    #outlinePipeline!: GPURenderPipeline
    #outlineBindGroup!: GPUBindGroup
    #outlineShaderModule!: GPUShaderModule
    #colorSampler!: GPUSampler
    #renderTextureWidth: number = 0
    #renderTextureHeight: number = 0
    // Beam optimization: tile-based SDF pre-pass
    #beamShader!: GPUShaderModule
    #beamPipeline!: GPUComputePipeline
    #beamBindGroup!: GPUBindGroup
    #tStartTexture!: GPUTexture
    #tStartTextureView!: GPUTextureView

    // Resolution scaling: render at reduced res during camera movement for responsiveness
    #settings: SettingsManager = SettingsManager.instance
    #fullWidth: number = 0
    #fullHeight: number = 0
    #sceneWidth: number = 0   // scene rendering resolution (may differ from canvas during movement)
    #sceneHeight: number = 0
    #resolutionScale: number = 1.0
    #movementScale: number = 0.5
    #cameraOptimization: boolean = true
    #movementTimer: ReturnType<typeof setTimeout> | null = null
    #movementSettleMs: number = 150 // ms of inactivity before restoring full resolution
    #documentName: string | null = null
    #tabChangeListener: ((e: Event) => void) | null = null

    #savePreviewSettings(): void {
        this.#settings.setPreview({
            xrayMode: this.#xrayMode,
            cameraOptimization: this.#cameraOptimization,
            beamOptimization: this.#beamEnabled,
            selectionMode: this.#selectionMode,
            cameraRotationMode: this.#cameraRotationMode,
        })
    }

    #loadPreviewSettings(): void {
        const prev = this.#settings.getPreview()
        this.#xrayMode = prev.xrayMode
        this.#cameraOptimization = prev.cameraOptimization
        this.#beamEnabled = prev.beamOptimization
        this.#selectionMode = prev.selectionMode
        this.#cameraRotationMode = prev.cameraRotationMode
        this.#controls.setRotationMode(this.#cameraRotationMode)
        this.onPreviewSettingsLoaded?.()
        this.#needsRender = true
    }

    /**
     * Callback invoked when object selection changes
     * Provides the array of currently selected object IDs
     */
    onSelectionChange?: (selectedIds: number[]) => void

    /** Callback invoked when an object is double-clicked in the preview */
    onObjectDoubleClick?: (nodeId: number) => void

    /** Called after preview settings are loaded (e.g. on document switch) so the UI can sync */
    onPreviewSettingsLoaded?: () => void

    get controls(): CameraController {
        return this.#controls
    }

    get selectedObjectIds(): number[] {
        const ids: number[] = []
        for (let i = 0; i < this.#selectedObjectIds.length; i++) {
            if (this.#selectedObjectIds[i]) ids.push(i)
        }
        return ids
    }

    set xrayMode(enabled: boolean) {
        this.#xrayMode = enabled
        this.#settings.updatePreview("xrayMode", enabled)
        this.#needsRender = true
    }

    get xrayMode(): boolean {
        return this.#xrayMode
    }

    set selectionMode(mode: import("./storage/settings.mjs").SelectionMode) {
        this.#selectionMode = mode
        this.#settings.updatePreview("selectionMode", mode)
        this.#needsRender = true
    }

    get selectionMode(): import("./storage/settings.mjs").SelectionMode {
        return this.#selectionMode
    }

    set cameraRotationMode(mode: import("./storage/settings.mjs").CameraRotationMode) {
        this.#cameraRotationMode = mode
        this.#settings.updatePreview("cameraRotationMode", mode)
        this.#controls.setRotationMode(mode)
    }

    get cameraRotationMode(): import("./storage/settings.mjs").CameraRotationMode {
        return this.#cameraRotationMode
    }

    set beamEnabled(enabled: boolean) {
        this.#beamEnabled = enabled
        this.#settings.updatePreview("beamOptimization", enabled)
        this.#needsRender = true
    }

    get beamEnabled(): boolean {
        return this.#beamEnabled
    }

    set outlineMode(mode: OutlineMode) {
        this.#outlineMode = mode
        this.#needsRender = true
    }

    get outlineMode(): OutlineMode {
        return this.#outlineMode
    }

    private set lastClickPos(pos: Vec2f) {
        this.#lastClickPos = pos
    }

    get lastClickPos(): Vec2f {
        return this.#lastClickPos
    }

    /** Outline thickness in pixels (1-8). */
    set outlineThickness(px: number) {
        this.#outlineThickness = Math.max(1, Math.min(8, Math.round(px)))
        this.#needsRender = true
    }

    get outlineThickness(): number {
        return this.#outlineThickness
    }

    /** Outline color as [r, g, b] in 0-1 range. */
    set outlineColor(rgb: [number, number, number]) {
        this.#outlineColor = [rgb[0], rgb[1], rgb[2]]
        this.#needsRender = true
    }

    get outlineColor(): [number, number, number] {
        return [...this.#outlineColor] as [number, number, number]
    }

    /** Resolution scale used during camera movement (0.25–1.0). Lower = faster interaction. */
    set movementScale(scale: number) {
        this.#movementScale = Math.max(0.25, Math.min(1.0, scale))
        this.#settings.updateGlobal({ preview: { movementScale: this.#movementScale } })
    }

    get movementScale(): number {
        return this.#movementScale
    }

    /** Whether resolution scaling during camera movement is enabled. */
    set cameraOptimization(enabled: boolean) {
        this.#cameraOptimization = enabled
        this.#settings.updatePreview("cameraOptimization", enabled)
        // If disabling while at reduced resolution, restore full res immediately
        if (!enabled && this.#resolutionScale !== 1.0) {
            if (this.#movementTimer !== null) {
                clearTimeout(this.#movementTimer)
                this.#movementTimer = null
            }
            this.#resolutionScale = 1.0
            this.#applyResolutionScale()
            this.#needsRender = true
        }
    }

    get cameraOptimization(): boolean {
        return this.#cameraOptimization
    }

    /**
     * Set the selection programmatically (for editor-to-preview selection sync).
     * @param ids Array of node IDs to select
     * @param notify If true, trigger onSelectionChange callback (default: false to avoid loops)
     */
    setSelection(ids: number[], notify = false) {
        this.#selectedObjectIds.fill(false)
        for (const id of ids) {
            this.#selectedObjectIds[id] = true
        }
        this.#writeSelectionBuffer()

        if (notify && this.onSelectionChange) {
            this.onSelectionChange(this.selectedObjectIds)
        }
    }

    /**
     * Get all nodes from the current scene for matching with source code.
     */
    getSceneNodes() {
        return this.#scene?.getAllNodes() ?? []
    }

    /** Read back the clicked object ID (u32) from the GPU storage buffer. */
    async #readClickedObjectId(): Promise<number> {
        const readback = await this.#helper.readBufferData(this.#uniformBuffers.clickedObjectId, 4)
        return new Uint32Array(readback)[0] ?? 0
    }

    async #readEdgeHit(): Promise<EdgeHitData> {
        // Read back EdgeHit struct (80 bytes) from storage buffer.
        const readback = await this.#helper.readBufferData(this.#uniformBuffers.edgeHit, 80)
        const u32 = new Uint32Array(readback)
        const f32 = new Float32Array(readback)
        return {
            kind: u32[0] ?? EDGE_KIND_NONE,
            primaryId: u32[1] ?? NO_HIT_SENTINEL,
            secondaryId: u32[2] ?? NO_HIT_SENTINEL,
            featureA: u32[3] ?? NO_FEATURE,
            featureB: u32[4] ?? 0,
            opType: u32[5] ?? 0,
            objectId: u32[6] ?? NO_HIT_SENTINEL,
            seedPoint: [f32[8] ?? 0, f32[9] ?? 0, f32[10] ?? 0],
            seamDir: [f32[12] ?? 0, f32[13] ?? 0, f32[14] ?? 1],
            segmentHalfLen: f32[16] ?? 0,
            segmentHalfWidth: f32[17] ?? 0,
        }
    }

    /** Write the full selected-edges buffer to the GPU (header + all edges). */
    #writeSelectedEdgesBuffer() {
        // Header: 4 u32 (count + 3 pad), then up to 16 edges at 80 bytes each.
        const EDGE_STRIDE = 80  // bytes per SelectedEdge in WGSL
        const HEADER_SIZE = 16  // 4 * u32
        const bufSize = HEADER_SIZE + MAX_SELECTED_EDGES * EDGE_STRIDE
        const data = new ArrayBuffer(bufSize)
        const headerU32 = new Uint32Array(data, 0, 4)
        headerU32[0] = this.#selectedEdges.length

        for (let ei = 0; ei < this.#selectedEdges.length && ei < MAX_SELECTED_EDGES; ei++) {
            const edge = this.#selectedEdges[ei]
            const offset = HEADER_SIZE + ei * EDGE_STRIDE
            const u32 = new Uint32Array(data, offset, 20)
            const f32 = new Float32Array(data, offset, 20)
            u32[0] = edge.kind >>> 0
            u32[1] = edge.primaryId >>> 0
            u32[2] = edge.secondaryId >>> 0
            u32[3] = edge.featureA >>> 0
            u32[4] = edge.featureB >>> 0
            u32[5] = edge.opType >>> 0
            f32[6] = this.#edgeLineWidthPx
            f32[7] = this.#edgeEpsilon
            f32[8] = edge.seedPoint[0]
            f32[9] = edge.seedPoint[1]
            f32[10] = edge.seedPoint[2]
            f32[12] = edge.seamDir[0]
            f32[13] = edge.seamDir[1]
            f32[14] = edge.seamDir[2]
            f32[16] = edge.segmentHalfLen
            f32[17] = edge.segmentHalfWidth
            f32[18] = edge.seamPolylineCount
            f32[19] = ei * MAX_SEAM_POLYLINE_POINTS  // polyline offset (in points)
        }
        this.#device.queue.writeBuffer(this.#uniformBuffers.selectedEdge, 0, data)
    }

    /** Write a polyline for a specific edge slot into the shared polyline buffer. */
    #writeSeamPolylineSlot(edgeIndex: number, points: Array<[number, number, number]>) {
        const clipped = points.slice(0, MAX_SEAM_POLYLINE_POINTS)
        const data = new Float32Array(MAX_SEAM_POLYLINE_POINTS * 4)
        for (let i = 0; i < clipped.length; i++) {
            const p = clipped[i]
            data[i * 4 + 0] = p[0]
            data[i * 4 + 1] = p[1]
            data[i * 4 + 2] = p[2]
            data[i * 4 + 3] = 1.0
        }
        const byteOffset = edgeIndex * MAX_SEAM_POLYLINE_POINTS * 16
        this.#device.queue.writeBuffer(this.#uniformBuffers.seamPolyline, byteOffset, data)
    }

    /** Clear all polyline slots in the shared polyline buffer. */
    #clearAllPolylineSlots() {
        const totalFloats = MAX_SELECTED_EDGES * MAX_SEAM_POLYLINE_POINTS * 4
        this.#device.queue.writeBuffer(this.#uniformBuffers.seamPolyline, 0, new Float32Array(totalFloats))
    }

    #clearSelectedEdges() {
        this.#selectedEdges = []
        this.#clearAllPolylineSlots()
        this.#writeSelectedEdgesBuffer()
    }

    #normalize3(v: [number, number, number]): [number, number, number] {
        const len = Math.hypot(v[0], v[1], v[2])
        if (len < 1e-8) return [0, 0, 1]
        return [v[0] / len, v[1] / len, v[2] / len]
    }

    #dot3(a: [number, number, number], b: [number, number, number]): number {
        return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    }

    #cross3(a: [number, number, number], b: [number, number, number]): [number, number, number] {
        return [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0],
        ]
    }

    /** Evaluate scalar SDF for any scene node recursively. */
    #evalNodeDist(node: Node, px: number, py: number, pz: number): number | null {
        if (node instanceof Sphere) {
            const qx = px - node.pos.x, qy = py - node.pos.y, qz = pz - node.pos.z
            return Math.hypot(qx, qy, qz) - node.r
        }
        if (node instanceof Box) {
            const dx = Math.abs(px - node.pos.x) - node.size.x
            const dy = Math.abs(py - node.pos.y) - node.size.y
            const dz = Math.abs(pz - node.pos.z) - node.size.z
            const ox = Math.max(dx, 0), oy = Math.max(dy, 0), oz = Math.max(dz, 0)
            return Math.hypot(ox, oy, oz) + Math.max(Math.min(dx, 0), Math.min(dy, 0), Math.min(dz, 0))
        }
        if (node instanceof Cylinder) {
            const qx = px - node.pos.x, qy = py - node.pos.y, qz = pz - node.pos.z
            return Math.max(Math.hypot(qx, qz) - node.r, Math.abs(qy) - node.h)
        }
        if (node instanceof Cone) {
            const qx = px - node.pos.x, qy = py - node.pos.y, qz = pz - node.pos.z
            const lenXZ = Math.hypot(qx, qz)
            const tipR = lenXZ, tipY = qy - node.h
            const L = Math.hypot(node.h, node.r)
            const mdR = node.h / L, mdY = node.r / L
            const mantle = tipR * mdR + tipY * mdY
            let d = Math.max(mantle, -qy)
            const projected = tipR * mdY + tipY * (-mdR)
            if (qy > node.h && projected < 0) {
                d = Math.max(d, Math.hypot(tipR, tipY))
            }
            if (lenXZ > node.r && projected > L) {
                d = Math.max(d, Math.hypot(lenXZ - node.r, qy))
            }
            return d
        }
        if (node instanceof Torus) {
            const qx = px - node.pos.x, qy = py - node.pos.y, qz = pz - node.pos.z
            const lenXZ = Math.hypot(qx, qz)
            return Math.hypot(lenXZ - node.lr, qy) - node.sr
        }
        if (node instanceof Capsule) {
            const qx = px - node.pos.x, qy = py - node.pos.y, qz = pz - node.pos.z
            const absQy = Math.abs(qy)
            if (absQy >= node.c) {
                return Math.hypot(qx, absQy - node.c, qz) - node.r
            }
            return Math.hypot(qx, qz) - node.r
        }
        if (node instanceof PlaneNode) {
            const qx = px - node.pos.x, qy = py - node.pos.y, qz = pz - node.pos.z
            return qx * node.normal.x + qy * node.normal.y + qz * node.normal.z + node.dist
        }
        if (node instanceof HexPrism) {
            const qx = Math.abs(px - node.pos.x), qy = Math.abs(py - node.pos.y), qz = Math.abs(pz - node.pos.z)
            return Math.max(qy - node.h, Math.max(qx * Math.sqrt(3) * 0.5 + qz * 0.5, qz) - node.r)
        }
        if (node instanceof Disc) {
            const qx = px - node.pos.x, qy = py - node.pos.y, qz = pz - node.pos.z
            const lenXZ = Math.hypot(qx, qz)
            const l = lenXZ - node.r
            if (l < 0) return Math.abs(qy)
            return Math.hypot(qy, l)
        }
        if (node instanceof Blob) {
            const qx = px - node.pos.x, qy = py - node.pos.y, qz = pz - node.pos.z
            // Approximate blob as a sphere of radius ~1.5
            return Math.hypot(qx, qy, qz) - 1.5
        }
        if (node instanceof Union) {
            const a = this.#evalNodeDist(node.lh, px, py, pz)
            const b = this.#evalNodeDist(node.rh, px, py, pz)
            if (a === null || b === null) return null
            if (node.radius && node.radius > 0) {
                // fOpUnionRound
                const r = node.radius
                const ux = Math.max(r - a, 0), uy = Math.max(r - b, 0)
                return Math.max(r, Math.min(a, b)) - Math.hypot(ux, uy)
            }
            return Math.min(a, b)
        }
        if (node instanceof Subtract) {
            const a = this.#evalNodeDist(node.lh, px, py, pz)
            const b = this.#evalNodeDist(node.rh, px, py, pz)
            if (a === null || b === null) return null
            if (node.radius && node.radius > 0) {
                // fOpDifferenceRound = fOpIntersectionRound(a, -b, r)
                const r = node.radius
                const nb = -b
                const ux = Math.max(r + a, 0), uy = Math.max(r + nb, 0)
                return Math.min(-r, Math.max(a, nb)) + Math.hypot(ux, uy)
            }
            return Math.max(a, -b)
        }
        if (node instanceof Intersect) {
            const a = this.#evalNodeDist(node.lh, px, py, pz)
            const b = this.#evalNodeDist(node.rh, px, py, pz)
            if (a === null || b === null) return null
            if (node.radius && node.radius > 0) {
                // fOpIntersectionRound
                const r = node.radius
                const ux = Math.max(r + a, 0), uy = Math.max(r + b, 0)
                return Math.min(-r, Math.max(a, b)) + Math.hypot(ux, uy)
            }
            return Math.max(a, b)
        }
        if (node instanceof Pipe) {
            const a = this.#evalNodeDist(node.lh, px, py, pz)
            const b = this.#evalNodeDist(node.rh, px, py, pz)
            if (a === null || b === null) return null
            return Math.hypot(a, b) - node.radius
        }
        if (node instanceof Engrave) {
            const a = this.#evalNodeDist(node.lh, px, py, pz)
            const b = this.#evalNodeDist(node.rh, px, py, pz)
            if (a === null || b === null) return null
            return Math.max(a, (a + node.radius - Math.abs(b)) * Math.SQRT1_2)
        }
        if (node instanceof Groove) {
            const a = this.#evalNodeDist(node.lh, px, py, pz)
            const b = this.#evalNodeDist(node.rh, px, py, pz)
            if (a === null || b === null) return null
            return Math.max(a, Math.min(a + node.ra, node.rb - Math.abs(b)))
        }
        if (node instanceof Tongue) {
            const a = this.#evalNodeDist(node.lh, px, py, pz)
            const b = this.#evalNodeDist(node.rh, px, py, pz)
            if (a === null || b === null) return null
            return Math.min(a, Math.max(a - node.ra, Math.abs(b) - node.rb))
        }
        if (node instanceof Shell) {
            const d = this.#evalNodeDist(node.arg, px, py, pz)
            if (d === null) return null
            return Math.abs(d) - node.thickness
        }
        if (node instanceof Offset) {
            const d = this.#evalNodeDist(node.arg, px, py, pz)
            if (d === null) return null
            return d - node.amount
        }
        if (node instanceof Elongate) {
            // Clamp point to elongation box, evaluate child at offset
            const qx = px - Math.max(-node.hx, Math.min(px, node.hx))
            const qy = py - Math.max(-node.hy, Math.min(py, node.hy))
            const qz = pz - Math.max(-node.hz, Math.min(pz, node.hz))
            return this.#evalNodeDist(node.arg, qx, qy, qz)
        }
        if (node instanceof Twist) {
            // Rotate XZ by p.y * rate
            const a = py * node.rate
            const c = Math.cos(a), s = Math.sin(a)
            const qx = c * px + s * pz
            const qz = -s * px + c * pz
            return this.#evalNodeDist(node.arg, qx, py, qz)
        }
        if (node instanceof Bend) {
            // Rotate XY by p.x * amount
            const a = node.amount * px
            const c = Math.cos(a), s = Math.sin(a)
            const qx = c * px - s * py
            const qy = s * px + c * py
            return this.#evalNodeDist(node.arg, qx, qy, pz)
        }
        if (node instanceof Taper) {
            // Scale XZ by linear function of Y
            const t = Math.max(0, Math.min(py / node.height, 1))
            const scale = 1 + (node.ratio - 1) * t
            return this.#evalNodeDist(node.arg, px / scale, py, pz / scale)
        }
        if (node instanceof Morph) {
            const a = this.#evalNodeDist(node.lh, px, py, pz)
            const b = this.#evalNodeDist(node.rh, px, py, pz)
            if (a === null || b === null) return null
            return a * (1 - node.t) + b * node.t
        }
        if (node instanceof Seam) {
            const a = this.#evalNodeDist(node.lh, px, py, pz)
            const b = this.#evalNodeDist(node.rh, px, py, pz)
            if (a === null || b === null) return null
            const unionD = Math.min(a, b)
            const pipeD = Math.hypot(a, b) - node.radius
            return Math.min(unionD, pipeD)
        }
        if (node instanceof Rotate) {
            const [rx, ry, rz] = node.applyInvRotation(px, py, pz)
            return this.#evalNodeDist(node.arg, rx, ry, rz)
        }
        if (node instanceof Group) {
            if (node.children.length > 0) {
                return this.#evalNodeDist(node.children[0], px, py, pz)
            }
            return null
        }
        return null
    }

    /** Evaluate SDF + gradient for any scene node. Uses numerical gradient
     *  via central differences so it's smooth across all discontinuities. */
    #evalNodeAt(node: Node, p: [number, number, number]): { d: number; n: [number, number, number] } | null {
        const d = this.#evalNodeDist(node, p[0], p[1], p[2])
        if (d === null) return null
        const eps = 0.005
        const dxp = this.#evalNodeDist(node, p[0] + eps, p[1], p[2])
        const dxn = this.#evalNodeDist(node, p[0] - eps, p[1], p[2])
        const dyp = this.#evalNodeDist(node, p[0], p[1] + eps, p[2])
        const dyn = this.#evalNodeDist(node, p[0], p[1] - eps, p[2])
        const dzp = this.#evalNodeDist(node, p[0], p[1], p[2] + eps)
        const dzn = this.#evalNodeDist(node, p[0], p[1], p[2] - eps)
        if (dxp === null || dxn === null || dyp === null || dyn === null || dzp === null || dzn === null) return null
        const n = this.#normalize3([dxp - dxn, dyp - dyn, dzp - dzn])
        return { d, n }
    }

    #projectToSeam(nodeA: Node, nodeB: Node, seed: [number, number, number]): [number, number, number] | null {
        let p: [number, number, number] = [seed[0], seed[1], seed[2]]
        for (let i = 0; i < 20; i++) {
            const a = this.#evalNodeAt(nodeA, p)
            const b = this.#evalNodeAt(nodeB, p)
            if (!a || !b) return null
            const f1 = a.d
            const f2 = b.d
            const n1 = a.n
            const n2 = b.n
            const a11 = this.#dot3(n1, n1) + 1e-6
            const a12 = this.#dot3(n1, n2)
            const a22 = this.#dot3(n2, n2) + 1e-6
            const det = a11 * a22 - a12 * a12
            if (Math.abs(det) < 1e-10) break
            const inv11 = a22 / det
            const inv12 = -a12 / det
            const inv22 = a11 / det
            const l1 = -(inv11 * f1 + inv12 * f2)
            const l2 = -(inv12 * f1 + inv22 * f2)
            const step: [number, number, number] = [
                l1 * n1[0] + l2 * n2[0],
                l1 * n1[1] + l2 * n2[1],
                l1 * n1[2] + l2 * n2[2],
            ]
            // Damp large steps to handle gradient discontinuities (box edges)
            const stepLen = Math.hypot(step[0], step[1], step[2])
            const maxStep = 0.5
            if (stepLen > maxStep) {
                const s = maxStep / stepLen
                step[0] *= s; step[1] *= s; step[2] *= s
            }
            p = [p[0] + step[0], p[1] + step[1], p[2] + step[2]]
            if (stepLen < 1e-4) break
        }
        const aEnd = this.#evalNodeAt(nodeA, p)
        const bEnd = this.#evalNodeAt(nodeB, p)
        if (!aEnd || !bEnd) return null
        if (Math.max(Math.abs(aEnd.d), Math.abs(bEnd.d)) > 0.12) return null
        return p
    }

    #collectPrimitiveLeaves(node: Node): Node[] {
        const ids = node.getAllDescendantIds()
        const seen = new Set<number>()
        const leaves: Node[] = []
        for (const id of ids) {
            if (seen.has(id)) continue
            seen.add(id)
            const n = this.#scene.get<Node>(id)
            if (n instanceof Box || n instanceof Sphere || n instanceof Cylinder || n instanceof Cone || n instanceof Torus || n instanceof Capsule || n instanceof PlaneNode || n instanceof HexPrism || n instanceof Disc || n instanceof Blob) {
                leaves.push(n)
            }
        }
        // If node itself is primitive but descendants API changes in future, keep it robust.
        if ((node instanceof Box || node instanceof Sphere || node instanceof Cylinder || node instanceof Cone || node instanceof Torus || node instanceof Capsule || node instanceof PlaneNode || node instanceof HexPrism || node instanceof Disc || node instanceof Blob) && !seen.has(node.id)) {
            leaves.push(node)
        }
        return leaves
    }

    /** Build a map from node ID → parent node for the scene tree. */
    #buildParentMap(): Map<number, Node> {
        const map = new Map<number, Node>()
        const walk = (node: Node) => {
            if (node instanceof BinaryOperator) {
                map.set(node.lh.id, node)
                map.set(node.rh.id, node)
                walk(node.lh)
                walk(node.rh)
            } else if (node instanceof Rotate) {
                map.set(node.arg.id, node)
                walk(node.arg)
            } else if (node instanceof Group) {
                for (const child of node.children) {
                    map.set(child.id, node)
                    walk(child)
                }
            }
        }
        walk(this.#scene.root)
        return map
    }

    /** Find the lowest common ancestor of two node IDs in the scene tree. */
    #findLCA(idA: number, idB: number, parentMap: Map<number, Node>): Node | null {
        // Collect all ancestors of A (including A itself).
        const ancestorsA = new Set<number>()
        let cur: Node | undefined = this.#scene.get<Node>(idA)
        while (cur) {
            ancestorsA.add(cur.id)
            cur = parentMap.get(cur.id)
        }
        // Walk up from B until we find a common ancestor.
        cur = this.#scene.get<Node>(idB)
        while (cur) {
            if (ancestorsA.has(cur.id)) return cur
            cur = parentMap.get(cur.id)
        }
        return null
    }

    /** Find which direct child of a binary operator contains a given node ID. */
    #findChildContaining(op: BinaryOperator, nodeId: number): Node | null {
        if (op.lh.id === nodeId || op.lh.getAllDescendantIds().includes(nodeId)) return op.lh
        if (op.rh.id === nodeId || op.rh.getAllDescendantIds().includes(nodeId)) return op.rh
        return null
    }

    /** Resolve seam node pair from edge hit IDs.
     *  The shader's seamA/seamB are always primitive IDs (SDFResult.id),
     *  not operator IDs.  We find the lowest common ancestor (LCA) in the
     *  scene tree — that's the CSG operator whose children form the actual
     *  seam pair.  This correctly returns composite subtrees (e.g.,
     *  SoftSubtract(A,B)) instead of raw primitives. */
    #resolveSeamPair(edgeHit: EdgeHitData): [Node, Node] | null {
        const idA = edgeHit.primaryId
        const idB = edgeHit.secondaryId
        if (idA === idB) return null

        const parentMap = this.#buildParentMap()
        const lca = this.#findLCA(idA, idB, parentMap)

        if (lca && lca instanceof BinaryOperator) {
            const childA = this.#findChildContaining(lca, idA)
            const childB = this.#findChildContaining(lca, idB)
            if (childA && childB && childA.id !== childB.id) {
                // Verify both children are evaluable.
                const a = this.#evalNodeAt(childA, edgeHit.seedPoint)
                const b = this.#evalNodeAt(childB, edgeHit.seedPoint)
                if (a && b) return [childA, childB]
            }
        }

        // Fallback: use the raw primitive IDs.
        const nodeA = this.#scene.get<Node>(idA)
        const nodeB = this.#scene.get<Node>(idB)
        if (!nodeA || !nodeB) return null
        const a = this.#evalNodeAt(nodeA, edgeHit.seedPoint)
        const b = this.#evalNodeAt(nodeB, edgeHit.seedPoint)
        if (!a || !b) return null
        return [nodeA, nodeB]
    }

    /** Estimate the bounding "size" of any node subtree for contour length estimation. */
    #estimateNodeSize(node: Node): number {
        if (node instanceof Sphere) return node.r * Math.PI
        if (node instanceof Box) return (node.size.x + node.size.y + node.size.z) * 2
        if (node instanceof Cylinder) return Math.max(node.r * 2, node.h * 2) * Math.PI
        if (node instanceof Cone) return Math.max(node.r, node.h) * Math.PI
        if (node instanceof Torus) return (node.lr + node.sr) * Math.PI * 2
        if (node instanceof Capsule) return (node.c + node.r) * Math.PI * 2
        if (node instanceof PlaneNode) return 100
        if (node instanceof HexPrism) return Math.max(node.r * 2, node.h * 2) * Math.PI
        if (node instanceof Disc) return node.r * Math.PI * 2
        if (node instanceof Blob) return 3 * Math.PI
        if (node instanceof Rotate) return this.#estimateNodeSize(node.arg)
        // For composite nodes, collect primitive leaves and use the largest.
        const leaves = this.#collectPrimitiveLeaves(node)
        let maxSize = 1.0
        for (const leaf of leaves) {
            const s = this.#estimateNodeSize(leaf)
            if (s > maxSize) maxSize = s
        }
        return maxSize
    }

    /** Estimate a generous upper bound on contour half-length from node sizes. */
    #estimateMaxHalfLength(nodeA: Node, nodeB: Node): number {
        const sizeA = this.#estimateNodeSize(nodeA)
        const sizeB = this.#estimateNodeSize(nodeB)
        // The contour is bounded by the smaller shape's perimeter.
        return Math.max(Math.min(sizeA, sizeB), 4.0)
    }

    /** Core bidirectional trace from a start point with a given initial tangent. */
    #traceFromPoint(
        nodeA: Node, nodeB: Node,
        start: [number, number, number],
        initTangent: [number, number, number],
        maxHalfLength: number,
        baseStepSize: number,
    ): Array<[number, number, number]> {
        const traceDir = (sign: number): Array<[number, number, number]> => {
            const pts: Array<[number, number, number]> = []
            let p: [number, number, number] = [start[0], start[1], start[2]]
            let traveled = 0
            let prevTan: [number, number, number] = initTangent
            let failStreak = 0
            for (let i = 0; i < 250; i++) {
                const a = this.#evalNodeAt(nodeA, p)
                const b = this.#evalNodeAt(nodeB, p)
                if (!a || !b) break

                let tan = this.#normalize3(this.#cross3(a.n, b.n))
                if (this.#dot3(tan, prevTan) < 0) tan = [-tan[0], -tan[1], -tan[2]]

                // Adaptive step: shrink near gradient discontinuities (box edges)
                const crossMag = Math.hypot(
                    a.n[1] * b.n[2] - a.n[2] * b.n[1],
                    a.n[2] * b.n[0] - a.n[0] * b.n[2],
                    a.n[0] * b.n[1] - a.n[1] * b.n[0],
                )
                const step = baseStepSize * Math.max(0.25, Math.min(1.0, crossMag * 3))

                const guess: [number, number, number] = [
                    p[0] + tan[0] * step * sign,
                    p[1] + tan[1] * step * sign,
                    p[2] + tan[2] * step * sign,
                ]

                let projected = this.#projectToSeam(nodeA, nodeB, guess)
                if (!projected) {
                    const half: [number, number, number] = [
                        p[0] + tan[0] * step * sign * 0.5,
                        p[1] + tan[1] * step * sign * 0.5,
                        p[2] + tan[2] * step * sign * 0.5,
                    ]
                    projected = this.#projectToSeam(nodeA, nodeB, half)
                }
                if (!projected) {
                    const quarter: [number, number, number] = [
                        p[0] + tan[0] * step * sign * 0.25,
                        p[1] + tan[1] * step * sign * 0.25,
                        p[2] + tan[2] * step * sign * 0.25,
                    ]
                    projected = this.#projectToSeam(nodeA, nodeB, quarter)
                }
                if (!projected) {
                    failStreak++
                    if (failStreak >= 3) break
                    p = [
                        p[0] + prevTan[0] * baseStepSize * sign * 0.3,
                        p[1] + prevTan[1] * baseStepSize * sign * 0.3,
                        p[2] + prevTan[2] * baseStepSize * sign * 0.3,
                    ]
                    continue
                }
                failStreak = 0
                prevTan = tan

                const seg = Math.hypot(projected[0] - p[0], projected[1] - p[1], projected[2] - p[2])
                if (seg < 1e-5) break
                traveled += seg
                if (traveled > maxHalfLength) break
                p = projected
                pts.push([p[0], p[1], p[2]])
                // Closed loop detection
                if (Math.hypot(p[0] - start[0], p[1] - start[1], p[2] - start[2]) < baseStepSize * 0.8 && traveled > baseStepSize * 8) {
                    break
                }
            }
            return pts
        }

        const backward = traceDir(-1).reverse()
        const forward = traceDir(1)
        const polyline = [...backward, [start[0], start[1], start[2]] as [number, number, number], ...forward]

        // Close the loop if endpoints are near each other.
        if (polyline.length >= 4) {
            const first = polyline[0]
            const last = polyline[polyline.length - 1]
            if (Math.hypot(first[0] - last[0], first[1] - last[1], first[2] - last[2]) < baseStepSize * 2) {
                polyline.push([first[0], first[1], first[2]])
            }
        }

        return polyline
    }

    /** Compute polyline arc-length. */
    #polylineLength(pts: Array<[number, number, number]>): number {
        let len = 0
        for (let i = 1; i < pts.length; i++) {
            len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2])
        }
        return len
    }

    /** Derive a tangent from a polyline endpoint (forward from first, backward from last). */
    #tangentFromPolylineEnd(pts: Array<[number, number, number]>, fromEnd: boolean): [number, number, number] {
        if (pts.length < 2) return [0, 0, 1]
        const i = fromEnd ? pts.length - 1 : 0
        const j = fromEnd ? pts.length - 2 : 1
        return this.#normalize3([pts[i][0] - pts[j][0], pts[i][1] - pts[j][1], pts[i][2] - pts[j][2]])
    }

    #traceSeamPolyline(edgeHit: EdgeHitData): Array<[number, number, number]> {
        const pair = this.#resolveSeamPair(edgeHit)
        if (!pair) return []
        const [nodeA, nodeB] = pair
        const start = this.#projectToSeam(nodeA, nodeB, edgeHit.seedPoint)
        if (!start) return []
        const maxHalfLength = this.#estimateMaxHalfLength(nodeA, nodeB)
        const baseStepSize = Math.max(0.04, Math.min(0.3, maxHalfLength / 60))
        const initTangent = this.#normalize3(edgeHit.seamDir)

        // Initial trace from the click seed point.
        let best = this.#traceFromPoint(nodeA, nodeB, start, initTangent, maxHalfLength, baseStepSize)
        let bestLen = this.#polylineLength(best)

        // Re-trace from each endpoint of the initial result.  If the initial
        // seed was near a gradient discontinuity (box edge) and one direction
        // terminated early, re-tracing from the far endpoint will start in a
        // smooth region and cover the full contour.
        if (best.length >= 3) {
            for (const fromEnd of [false, true]) {
                const endPt = fromEnd ? best[best.length - 1] : best[0]
                const projected = this.#projectToSeam(nodeA, nodeB, endPt)
                if (!projected) continue
                const tan = this.#tangentFromPolylineEnd(best, fromEnd)
                const candidate = this.#traceFromPoint(nodeA, nodeB, projected, tan, maxHalfLength, baseStepSize)
                const candidateLen = this.#polylineLength(candidate)
                if (candidateLen > bestLen * 1.05 && candidate.length > best.length) {
                    best = candidate
                    bestLen = candidateLen
                }
            }
        }

        return best
    }

    /** Build a SelectedEdgeData from an edge hit, tracing its polyline. */
    #buildEdgeData(edgeHit: EdgeHitData): { edge: SelectedEdgeData; polyline: Array<[number, number, number]> } {
        let seamPolylineCount = 0
        let polyline: Array<[number, number, number]> = []
        if (edgeHit.kind === EDGE_KIND_CSG_SEAM) {
            polyline = this.#traceSeamPolyline(edgeHit)
            if (polyline.length > 1) {
                seamPolylineCount = Math.min(polyline.length, MAX_SEAM_POLYLINE_POINTS)
            }
        }
        return {
            edge: {
                kind: edgeHit.kind,
                primaryId: edgeHit.primaryId,
                secondaryId: edgeHit.secondaryId,
                featureA: edgeHit.featureA,
                featureB: edgeHit.featureB,
                opType: edgeHit.opType,
                lineWidthPx: this.#edgeLineWidthPx,
                epsilon: this.#edgeEpsilon,
                seedPoint: edgeHit.seedPoint,
                seamDir: edgeHit.seamDir,
                segmentHalfLen: edgeHit.segmentHalfLen,
                segmentHalfWidth: edgeHit.segmentHalfWidth,
                seamPolylineCount,
            },
            polyline,
        }
    }

    /** Replace the entire edge selection with a single edge. */
    #setSelectedEdgeFromHit(edgeHit: EdgeHitData) {
        const { edge, polyline } = this.#buildEdgeData(edgeHit)
        this.#selectedEdges = [edge]
        this.#clearAllPolylineSlots()
        if (polyline.length > 1) {
            this.#writeSeamPolylineSlot(0, polyline)
        }
        this.#writeSelectedEdgesBuffer()
    }

    /** Add an edge to the multi-selection (Alt+Shift). */
    #addSelectedEdgeFromHit(edgeHit: EdgeHitData) {
        if (this.#selectedEdges.length >= MAX_SELECTED_EDGES) return
        const { edge, polyline } = this.#buildEdgeData(edgeHit)
        const idx = this.#selectedEdges.length
        this.#selectedEdges.push(edge)
        if (polyline.length > 1) {
            this.#writeSeamPolylineSlot(idx, polyline)
        }
        this.#writeSelectedEdgesBuffer()
    }

    #handleClick(screenPos: Vec2f, shiftKey: boolean, altKey: boolean) {
        // Clear hover on click
        this.#hoverPending = false
        this.#clearHoveredEdge()

        // Convert screen coordinates to UV coordinates (0-1 range)
        const canvas = this.#preview.canvas
        const rect = canvas.getBoundingClientRect()
        const x = (screenPos.x - rect.left) / rect.width
        const y = 1.0 - (screenPos.y - rect.top) / rect.height // Flip Y for WGSL UV space

        this.#lastClickPos = vec2(x, y)

        console.log(`Click at UV: (${x.toFixed(3)}, ${y.toFixed(3)}), shift: ${shiftKey}, alt: ${altKey}`)

        // Store click state: must match WGSL ClickState struct layout (32 bytes)
        const clickData = new ArrayBuffer(32)
        const clickF32 = new Float32Array(clickData)
        const clickU32 = new Uint32Array(clickData)
        clickF32[0] = x
        clickF32[1] = y
        clickU32[2] = 1  // click enabled
        clickU32[3] = 0  // hover disabled
        clickF32[4] = 0
        clickF32[5] = 0
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickState, 0, clickData)

        // Clear clickedObjectId buffer to 0 before rendering.
        // The shader writes the hit object ID (non-zero) via atomicStore;
        // 0 means "no hit" since valid object IDs start at 1.
        this.#device.queue.writeBuffer(
            this.#uniformBuffers.clickedObjectId, 0, new Uint32Array([0])
        )

        // Trigger a render so the shader can evaluate the click
        this.#needsRender = true

        // Read back result after a few frames
        setTimeout(async () => {
            try {
                const clickedId = await this.#readClickedObjectId()

                // Clear any active edge selection when selecting objects
                this.#clearSelectedEdges()

                if (clickedId !== 0) {
                    this.#updateSelection(clickedId, shiftKey)
                } else if (!shiftKey) {
                    // Clicked on empty space — deselect all
                    this.#selectedObjectIds.fill(false)
                    this.#writeSelectionBuffer()
                    if (this.onSelectionChange) {
                        this.onSelectionChange([])
                    }
                    console.log('Deselected all objects (clicked empty space)')
                }
            } catch (error) {
                console.error('Error reading clicked object ID:', error)
            }
        }, 200)
    }

    #handleDoubleClick(screenPos: Vec2f) {
        const canvas = this.#preview.canvas
        const rect = canvas.getBoundingClientRect()
        const x = (screenPos.x - rect.left) / rect.width
        const y = 1.0 - (screenPos.y - rect.top) / rect.height

        // Write click state for GPU pick
        const clickData = new ArrayBuffer(32)
        const clickF32 = new Float32Array(clickData)
        const clickU32 = new Uint32Array(clickData)
        clickF32[0] = x
        clickF32[1] = y
        clickU32[2] = 1  // click enabled
        clickU32[3] = 0  // hover disabled
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickState, 0, clickData)
        this.#device.queue.writeBuffer(
            this.#uniformBuffers.clickedObjectId, 0, new Uint32Array([0])
        )
        this.#needsRender = true

        setTimeout(async () => {
            try {
                const clickedId = await this.#readClickedObjectId()
                if (clickedId !== 0 && this.onObjectDoubleClick) {
                    this.onObjectDoubleClick(clickedId)
                }
            } catch (error) {
                console.error('Error reading double-clicked object ID:', error)
            }
        }, 200)
    }

    #handleHover(screenPos: Vec2f, altKey: boolean) {
        if (!altKey) {
            // Only show edge hover when Alt is held
            this.#clearHoveredEdge()
            this.#preview.canvas.style.cursor = ""
            return
        }
        const now = performance.now()
        if (now - this.#lastHoverTime < this.#hoverThrottleMs) return
        this.#lastHoverTime = now

        const canvas = this.#preview.canvas
        const rect = canvas.getBoundingClientRect()
        const x = (screenPos.x - rect.left) / rect.width
        const y = 1.0 - (screenPos.y - rect.top) / rect.height

        // Write hover UV to clickState buffer (hoverEnabled at offset 12, hoverPos at offset 16)
        const hoverData = new ArrayBuffer(32)
        const f32 = new Float32Array(hoverData)
        const u32 = new Uint32Array(hoverData)
        // Preserve existing click fields (clickPos, enabled) — write full struct
        f32[0] = this.#lastClickPos.x
        f32[1] = this.#lastClickPos.y
        u32[2] = 0  // click not enabled
        u32[3] = 1  // hover enabled
        f32[4] = x
        f32[5] = y
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickState, 0, hoverData)

        // Clear hover edge hit buffer
        const clearBuf = new ArrayBuffer(80)
        const clearU32 = new Uint32Array(clearBuf)
        clearU32[0] = EDGE_KIND_NONE
        clearU32[1] = NO_HIT_SENTINEL
        clearU32[6] = NO_HIT_SENTINEL
        this.#device.queue.writeBuffer(this.#uniformBuffers.hoverEdgeHit, 0, clearBuf)

        this.#needsRender = true
        this.#hoverPending = true

        // Read back after render
        setTimeout(async () => {
            if (!this.#hoverPending) return
            this.#hoverPending = false
            try {
                const hoverHit = await this.#readHoverEdgeHit()
                if (hoverHit.objectId !== NO_HIT_SENTINEL &&
                    (hoverHit.kind === EDGE_KIND_PRIMITIVE || hoverHit.kind === EDGE_KIND_CSG_SEAM)) {
                    this.#setHoveredEdgeFromHit(hoverHit)
                    this.#preview.canvas.style.cursor = "pointer"
                } else {
                    this.#clearHoveredEdge()
                    this.#preview.canvas.style.cursor = ""
                }
            } catch {
                this.#clearHoveredEdge()
            }
            // Disable hover detection after readback
            const disableHover = new Uint32Array([0])
            this.#device.queue.writeBuffer(this.#uniformBuffers.clickState, 12, disableHover)
        }, 100)
    }

    async #readHoverEdgeHit(): Promise<EdgeHitData> {
        const readback = await this.#helper.readBufferData(this.#uniformBuffers.hoverEdgeHit, 80)
        const u32 = new Uint32Array(readback)
        const f32 = new Float32Array(readback)
        return {
            kind: u32[0] ?? EDGE_KIND_NONE,
            primaryId: u32[1] ?? NO_HIT_SENTINEL,
            secondaryId: u32[2] ?? NO_HIT_SENTINEL,
            featureA: u32[3] ?? NO_FEATURE,
            featureB: u32[4] ?? 0,
            opType: u32[5] ?? 0,
            objectId: u32[6] ?? NO_HIT_SENTINEL,
            seedPoint: [f32[8] ?? 0, f32[9] ?? 0, f32[10] ?? 0],
            seamDir: [f32[12] ?? 0, f32[13] ?? 0, f32[14] ?? 1],
            segmentHalfLen: f32[16] ?? 0,
            segmentHalfWidth: f32[17] ?? 0,
        }
    }

    #setHoveredEdgeFromHit(edgeHit: EdgeHitData) {
        const { edge, polyline } = this.#buildEdgeData(edgeHit)
        // Write hovered edge to GPU as a SelectedEdgesBuffer with count=1
        const HEADER_SIZE = 16
        const EDGE_STRIDE = 80
        const bufSize = HEADER_SIZE + MAX_SELECTED_EDGES * EDGE_STRIDE
        const data = new ArrayBuffer(bufSize)
        const headerU32 = new Uint32Array(data, 0, 4)
        headerU32[0] = 1
        const u32 = new Uint32Array(data, HEADER_SIZE, 20)
        const f32 = new Float32Array(data, HEADER_SIZE, 20)
        u32[0] = edge.kind >>> 0
        u32[1] = edge.primaryId >>> 0
        u32[2] = edge.secondaryId >>> 0
        u32[3] = edge.featureA >>> 0
        u32[4] = edge.featureB >>> 0
        u32[5] = edge.opType >>> 0
        f32[6] = this.#edgeLineWidthPx
        f32[7] = this.#edgeEpsilon
        f32[8] = edge.seedPoint[0]
        f32[9] = edge.seedPoint[1]
        f32[10] = edge.seedPoint[2]
        f32[12] = edge.seamDir[0]
        f32[13] = edge.seamDir[1]
        f32[14] = edge.seamDir[2]
        f32[16] = edge.segmentHalfLen
        f32[17] = edge.segmentHalfWidth
        f32[18] = edge.seamPolylineCount
        f32[19] = MAX_SELECTED_EDGES * MAX_SEAM_POLYLINE_POINTS // hover polyline offset (after all selection slots)
        this.#device.queue.writeBuffer(this.#uniformBuffers.hoveredEdge, 0, data)
        // Write polyline to the last slot area of seamPolyline
        if (polyline.length > 1) {
            const hoverPolyOffset = MAX_SELECTED_EDGES * MAX_SEAM_POLYLINE_POINTS
            const clipped = polyline.slice(0, MAX_SEAM_POLYLINE_POINTS)
            const pData = new Float32Array(MAX_SEAM_POLYLINE_POINTS * 4)
            for (let i = 0; i < clipped.length; i++) {
                pData[i * 4] = clipped[i][0]
                pData[i * 4 + 1] = clipped[i][1]
                pData[i * 4 + 2] = clipped[i][2]
                pData[i * 4 + 3] = 1.0
            }
            this.#device.queue.writeBuffer(this.#uniformBuffers.seamPolyline, hoverPolyOffset * 16, pData)
        }
        this.#needsRender = true
    }

    #clearHoveredEdge() {
        const HEADER_SIZE = 16
        const bufSize = HEADER_SIZE + MAX_SELECTED_EDGES * 80
        const data = new ArrayBuffer(bufSize)
        // count = 0 → no hovered edge
        this.#device.queue.writeBuffer(this.#uniformBuffers.hoveredEdge, 0, data)
        this.#needsRender = true
    }

    #updateSelection(clickedId: number, shiftKey: boolean) {
        const wasSelected = this.#selectedObjectIds[clickedId] === true

        if (shiftKey) {
            // Multiselect mode: toggle the clicked object
            this.#selectedObjectIds[clickedId] = !wasSelected
            console.log(wasSelected ? `Removed object ${clickedId} from selection` : `Added object ${clickedId} to selection`)
        } else {
            // Single select mode
            if (wasSelected && this.selectedObjectIds.length === 1) {
                // Clicking the only selected object deselects it
                this.#selectedObjectIds.fill(false)
                console.log('Deselected object')
            } else {
                // Select only the clicked object
                this.#selectedObjectIds.fill(false)
                this.#selectedObjectIds[clickedId] = true
                console.log(`Selected object ID: ${clickedId}`)
            }
        }

        this.#writeSelectionBuffer()

        // Notify listeners about selection change
        if (this.onSelectionChange) {
            this.onSelectionChange(this.selectedObjectIds)
        }
    }

    #writeSelectionBuffer() {
        // Write selection as boolean array to GPU buffer
        // Format: selectedObjectIds[objectId] = 1 if selected, 0 if not (1024 slots, 4096 bytes)
        const data = new Uint32Array(1024)
        for (let i = 0; i < this.#selectedObjectIds.length && i < 1024; i++) {
            data[i] = this.#selectedObjectIds[i] ? 1 : 0
        }
        this.#device.queue.writeBuffer(this.#uniformBuffers.selectedObjectIds, 0, data)
        this.#needsRender = true
    }

    constructor(preview: PreviewWindow, tabsElement?: EventTarget | null) {
        this.#preview = preview
        this.#controls = new CameraController(preview, vec3(0, 0, 0), 50, 0, Math.PI / 2, tabsElement)
        this.#controls.onSelect = (screenPos: Vec2f, shiftKey: boolean, altKey: boolean) => this.#handleClick(screenPos, shiftKey, altKey)
        this.#controls.onDoubleClick = (screenPos: Vec2f) => this.#handleDoubleClick(screenPos)
        this.#controls.onHover = (screenPos: Vec2f, altKey: boolean) => this.#handleHover(screenPos, altKey)
        this.#controls.onChange = () => {
            this.#needsRender = true
            this.#onCameraMovement()
        }
        this.#movementScale = this.#settings.getGlobal().preview.movementScale
        this.#documentName = (tabsElement as { active?: string })?.active ?? null
        this.#uniformBuffers = new UniformBuffers()
        this.#exportBuffers = new ExportBuffers()
        this.#initializing = this.initialize()
        this.#cameraRes = vec2(this.#preview.canvas.clientWidth, this.#preview.canvas.clientHeight)

        this.#loadPreviewSettings()

        if (tabsElement) {
            this.#tabChangeListener = (e: Event) => {
                const customEvent = e as CustomEvent<string | undefined>
                // SettingsManager.switchDocument (called from DocumentTabs) handles
                // flushing the old doc and loading the new one. We just need to
                // reload our in-memory preview flags from the (already-switched) settings.
                this.#documentName = customEvent.detail ?? null
                this.#loadPreviewSettings()
            }
            tabsElement.addEventListener("activeTabChanged", this.#tabChangeListener)
        }

        const observer = new ResizeObserver(entries => {
            requestAnimationFrame(() => {
                for (const entry of entries) {
                    const w =
                        entry.devicePixelContentBoxSize?.[0].inlineSize ??
                        Math.max(1, Math.round(entry.contentRect.width * devicePixelRatio))
                    const h =
                        entry.devicePixelContentBoxSize?.[0].blockSize ??
                        Math.max(1, Math.round(entry.contentRect.height * devicePixelRatio))
                    this.#fullWidth = w
                    this.#fullHeight = h
                    this.#applyResolutionScale()
                    this.#needsRender = true
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
        const sceneAux = this.#scene.compileAux()       // Auxiliary WGSL functions (e.g., polygon SDF evaluators)
        const sceneSDF = this.#scene.compile()        // Full SDFResult (distance + gradient + normal + ID)
        const sceneSDF_fast = this.#scene.compileFast() // Fast vec2f (distance + gradient only)
        const sceneEdgeHelpers = this.#scene.compileEdgeHelpers()
        this.#shaderCompiler = new ShaderCompiler(this.#device)
            .replace("insert", "sceneAux", sceneAux)
            .replace("insert", "sceneSDF_fast", sceneSDF_fast)
            .replace("insert", "sceneSDF", sceneSDF)
            .replace("insert", "sceneEdgeHelpers", sceneEdgeHelpers)
        this.#sceneShader = this.#shaderCompiler.compile(previewShader, "Preview Window")
        this.#exportShader = this.#shaderCompiler.compile(exportShader, "Export")
        this.#boundsShader = this.#shaderCompiler.compile(boundsShader, "Bounds (scene bbox)")
        this.#beamShader = this.#shaderCompiler.compile(beamShader, "Beam Pre-Pass")
        this.#buildPreviewPipeline()
        this.#buildBeamPipeline()
        // Force render texture recreation so bind groups are rebuilt with new pipelines
        this.#renderTextureWidth = 0
        this.#renderTextureHeight = 0
        this.#needsRender = true

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

        // Sampler for bilinear upscaling of the scene color texture in the outline pass.
        this.#colorSampler = this.#device.createSampler({
            magFilter: "linear",
            minFilter: "linear",
        })

        // Create outline post-process shader and pipeline (scene-independent)
        this.#outlineShaderModule = this.#device.createShaderModule({
            label: "Outline Post-Process",
            code: outlineShader,
        })
        this.#outlinePipeline = this.#device.createRenderPipeline({
            label: "Outline Pipeline",
            layout: "auto",
            vertex: {
                module: this.#outlineShaderModule,
                entryPoint: "vertexMain",
            },
            fragment: {
                module: this.#outlineShaderModule,
                entryPoint: "fragmentMain",
                targets: [{ format: this.#format }],
            },
            primitive: {
                topology: "triangle-strip",
                stripIndexFormat: "uint32",
            },
        })
    }

    async ready() {
        if (this.#initializing) {
            await this.#initializing
            this.#initializing = null
        }
        // Initialize click detection buffers (32 bytes: clickPos, enabled, hoverEnabled, hoverPos)
        this.#device.queue.writeBuffer(this.#uniformBuffers.clickState, 0, new ArrayBuffer(32))
        // Initialize edge hit buffer to sentinel values (no click result yet).
        const edgeHitInit = new ArrayBuffer(80)
        const edgeHitU32 = new Uint32Array(edgeHitInit)
        edgeHitU32[0] = EDGE_KIND_NONE
        edgeHitU32[1] = NO_HIT_SENTINEL
        edgeHitU32[2] = NO_HIT_SENTINEL
        edgeHitU32[3] = NO_FEATURE
        edgeHitU32[4] = 0
        edgeHitU32[5] = 0
        edgeHitU32[6] = NO_HIT_SENTINEL
        edgeHitU32[7] = 0
        this.#device.queue.writeBuffer(this.#uniformBuffers.edgeHit, 0, edgeHitInit)
        this.#device.queue.writeBuffer(this.#uniformBuffers.hoverEdgeHit, 0, edgeHitInit)
        // Initialize selection buffer with count=0
        this.#device.queue.writeBuffer(this.#uniformBuffers.selectedObjectIds, 0, new Uint32Array(1024))
        this.#clearAllPolylineSlots()
        this.#writeSelectedEdgesBuffer()
        this.#clearHoveredEdge()
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
            size: 144, // Camera struct: transform(64) + position(16) + res(8) + zoom(4) + pad(4) + 3x lightDir vec3f(48)
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "camera",
        })

        // Click detection buffers - includes hover fields
        this.#uniformBuffers.clickState = this.#device.createBuffer({
            size: 32, // vec2f clickPos (8) + u32 enabled (4) + u32 hoverEnabled (4) + vec2f hoverPos (8) + padding (8)
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "clickState",
        })

        this.#uniformBuffers.clickedObjectId = this.#device.createBuffer({
            size: 4, // atomic<u32> — shader writes clicked object ID here
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            label: "clickedObjectId",
        })

        this.#uniformBuffers.selectedObjectIds = this.#device.createBuffer({
            size: 4096, // 1024 u32s: boolean array indexed by object ID (0 = not selected, 1 = selected)
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            label: "selectedObjectIds",
        })

        this.#uniformBuffers.edgeHit = this.#device.createBuffer({
            size: 80, // EdgeHit struct in preview.wgsl
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            label: "edgeHit",
        })

        this.#uniformBuffers.selectedEdge = this.#device.createBuffer({
            size: 16 + MAX_SELECTED_EDGES * 80, // header (count + pad) + edges
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            label: "selectedEdges",
        })

        this.#uniformBuffers.seamPolyline = this.#device.createBuffer({
            size: (MAX_SELECTED_EDGES + 1) * MAX_SEAM_POLYLINE_POINTS * 16, // +1 slot for hover
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            label: "seamPolyline",
        })

        this.#uniformBuffers.hoverEdgeHit = this.#device.createBuffer({
            size: 80,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            label: "hoverEdgeHit",
        })

        this.#uniformBuffers.hoveredEdge = this.#device.createBuffer({
            size: 16 + MAX_SELECTED_EDGES * 80, // same layout as selectedEdges
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            label: "hoveredEdge",
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

        // View settings buffer: xrayMode (u32) + padding
        this.#uniformBuffers.viewSettings = this.#device.createBuffer({
            size: 16, // u32 + padding to 16 bytes for alignment
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "viewSettings",
        })

        // Outline settings buffer: mode (u32) + thickness (f32) + pad + color (vec3f)
        this.#uniformBuffers.outlineSettings = this.#device.createBuffer({
            size: 32, // u32(4) + f32(4) + pad(8) + vec3f(12) + pad(4) = 32
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: "outlineSettings",
        })
    }

    /**
     * Ensure scene-resolution textures (color, ID, beam t_start) exist at the given size.
     * Called each frame with scene dimensions (which may be lower during camera movement).
     */
    #ensureRenderTextures(width: number, height: number) {
        // Skip if dimensions haven't changed
        if (width === this.#renderTextureWidth && height === this.#renderTextureHeight) {
            return
        }

        // Destroy old textures if they exist
        if (this.#colorTexture) this.#colorTexture.destroy()
        if (this.#idTexture) this.#idTexture.destroy()
        if (this.#tStartTexture) this.#tStartTexture.destroy()

        this.#colorTexture = this.#device.createTexture({
            label: "Preview Color (offscreen)",
            size: [width, height],
            format: this.#format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        })
        this.#idTexture = this.#device.createTexture({
            label: "Object ID",
            size: [width, height],
            format: "r32uint",
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        })
        this.#colorTextureView = this.#colorTexture.createView()
        this.#idTextureView = this.#idTexture.createView()

        // Beam optimization: create low-res t_start texture (one texel per 8x8 tile)
        const BEAM_TILE_SIZE = 8
        const tilesX = Math.ceil(width / BEAM_TILE_SIZE)
        const tilesY = Math.ceil(height / BEAM_TILE_SIZE)
        this.#tStartTexture = this.#device.createTexture({
            label: "Beam t_start (tile resolution)",
            size: [tilesX, tilesY],
            format: "r32float",
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
        })
        this.#tStartTextureView = this.#tStartTexture.createView()

        // Recreate outline bind group with new texture views
        this.#outlineBindGroup = this.#device.createBindGroup({
            label: "outlinePostProcess",
            layout: this.#outlinePipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: this.#colorTextureView },
                { binding: 1, resource: this.#idTextureView },
                { binding: 2, resource: { buffer: this.#uniformBuffers.selectedObjectIds } },
                { binding: 3, resource: { buffer: this.#uniformBuffers.outlineSettings } },
                { binding: 4, resource: this.#colorSampler },
            ],
        })

        // Recreate beam bind group with new t_start texture
        if (this.#beamPipeline) {
            this.#beamBindGroup = this.#device.createBindGroup({
                label: "beamPrePass",
                layout: this.#beamPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: this.#uniformBuffers.camera } },
                    { binding: 1, resource: this.#tStartTextureView },
                ],
            })
        }

        // Recreate preview bind group (references the t_start texture)
        // Bindings must match preview.wgsl declarations:
        //   1: camera, 2: clickState, 3: clickedObjectId, 4: selectedObjectIds,
        //   5: colorPalette, 6: viewSettings, 7: tStartTex
        if (this.#pipeline) {
            this.#bindGroup = this.#device.createBindGroup({
                label: "scenePreview",
                layout: this.#pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 1, resource: { buffer: this.#uniformBuffers.camera } },
                    { binding: 2, resource: { buffer: this.#uniformBuffers.clickState } },
                    { binding: 3, resource: { buffer: this.#uniformBuffers.clickedObjectId } },
                    { binding: 4, resource: { buffer: this.#uniformBuffers.selectedObjectIds } },
                    { binding: 5, resource: { buffer: this.#uniformBuffers.colorPalette } },
                    { binding: 6, resource: { buffer: this.#uniformBuffers.viewSettings } },
                    { binding: 7, resource: this.#tStartTextureView },
                ],
            })
        }

        this.#renderTextureWidth = width
        this.#renderTextureHeight = height
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
                targets: [
                    { format },
                    { format: "r32uint" as GPUTextureFormat },
                ],
            },
            primitive: {
                topology: "triangle-strip",
                stripIndexFormat: "uint32",
            },
        })
        // Note: preview bind group is created in #ensureRenderTextures() because
        // it references the beam t_start texture which depends on canvas dimensions.
    }

    #buildBeamPipeline() {
        this.#beamPipeline = this.#device.createComputePipeline({
            label: "Beam Pre-Pass Pipeline",
            layout: "auto",
            compute: {
                module: this.#beamShader,
                entryPoint: "beamMarch",
            },
        })
    }

    /**
     * Internal method to perform a single frame render.
     * @param waitForGPU If true, wait for GPU to complete before returning (for accurate benchmarking)
     */
    async #renderFrame(waitForGPU = false): Promise<void> {
        // Skip rendering if scene dimensions haven't been set yet (before ResizeObserver fires)
        if (this.#sceneWidth === 0 || this.#sceneHeight === 0) return

        this.#device.queue.writeBuffer(this.#uniformBuffers.camera, 0, this.#controls.viewTransform.data as BufferSource)
        this.#device.queue.writeBuffer(this.#uniformBuffers.camera, 64, this.#controls.cameraPosition.data as BufferSource)
        this.#device.queue.writeBuffer(this.#uniformBuffers.camera, 64 + 16, this.#cameraRes.data as BufferSource)
        this.#device.queue.writeBuffer(this.#uniformBuffers.camera, 64 + 16 + 8, new Float32Array([this.#controls.zoom]))

        // Pre-transform light directions from camera-space into scene-space on the CPU.
        // This eliminates 3 matrix-vector multiplies per pixel in the fragment shader.
        const camTransform = this.#controls.viewTransform
        const l1 = camTransform.transformVector(vec3(0.5, 0.6, 1.0).normalize())
        const l2 = camTransform.transformVector(vec3(-0.6, 0.3, 0.8).normalize())
        const l3 = camTransform.transformVector(vec3(0.1, -0.5, 0.9).normalize())
        // Each vec3f in uniform layout occupies 16 bytes (12 data + 4 padding).
        // lightDir1 at offset 96, lightDir2 at offset 112, lightDir3 at offset 128.
        const lightDirs = new Float32Array([
            l1.x, l1.y, l1.z, 0,
            l2.x, l2.y, l2.z, 0,
            l3.x, l3.y, l3.z, 0,
        ])
        this.#device.queue.writeBuffer(this.#uniformBuffers.camera, 96, lightDirs)

        // Write view settings (xray mode + refinement steps + beam enabled)
        const refinementSteps = this.#resolutionScale < 1.0 ? 6 : 8
        const beamActive = this.#beamEnabled && this.#resolutionScale >= 1.0
        this.#device.queue.writeBuffer(this.#uniformBuffers.viewSettings, 0, new Uint32Array([
            this.#xrayMode ? 1 : 0,
            refinementSteps,
            beamActive ? 1 : 0,
        ]))

        // Write outline settings (mode + thickness + color + canvasWidth)
        const outlineData = new ArrayBuffer(32)
        new Uint32Array(outlineData, 0, 1).set([OUTLINE_MODE_VALUES[this.#outlineMode]])
        new Float32Array(outlineData, 4, 1).set([this.#outlineThickness])
        new Float32Array(outlineData, 16, 3).set(this.#outlineColor)
        new Float32Array(outlineData, 28, 1).set([this.#fullWidth])
        this.#device.queue.writeBuffer(this.#uniformBuffers.outlineSettings, 0, outlineData)

        const canvasTexture = this.#context.getCurrentTexture()
        // Offscreen scene textures use scene resolution (may be lower during camera movement);
        // the outline pass upscales them to the full-res canvas with bilinear interpolation.
        this.#ensureRenderTextures(this.#sceneWidth, this.#sceneHeight)

        const commandEncoder = this.#device.createCommandEncoder()

        // Pass 0: Beam pre-pass - march one ray per 8x8 tile through empty space
        // Skip beam during reduced-resolution rendering (camera movement) to avoid artifacts
        if (beamActive && this.#beamPipeline && this.#beamBindGroup) {
            const BEAM_TILE_SIZE = 8
            const tilesX = Math.ceil(this.#sceneWidth / BEAM_TILE_SIZE)
            const tilesY = Math.ceil(this.#sceneHeight / BEAM_TILE_SIZE)
            const beamPass = commandEncoder.beginComputePass({ label: "Beam Pre-Pass" })
            beamPass.setPipeline(this.#beamPipeline)
            beamPass.setBindGroup(0, this.#beamBindGroup)
            beamPass.dispatchWorkgroups(
                Math.ceil(tilesX / 8),
                Math.ceil(tilesY / 8)
            )
            beamPass.end()
        }

        // Pass 1: Render scene to offscreen color + object ID textures (MRT, scene resolution)
        const scenePass = commandEncoder.beginRenderPass({
            colorAttachments: [
                {
                    view: this.#colorTextureView,
                    loadOp: "clear",
                    storeOp: "store",
                },
                {
                    view: this.#idTextureView,
                    loadOp: "clear",
                    storeOp: "store",
                    clearValue: { r: 0xFFFFFFFF, g: 0, b: 0, a: 0 },
                },
            ],
        })
        scenePass.setPipeline(this.#pipeline)
        scenePass.setBindGroup(0, this.#bindGroup)
        scenePass.draw(4)
        scenePass.end()

        // Pass 2: Outline post-process, compositing dark outline at selection boundaries
        const outlinePass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: canvasTexture.createView(),
                loadOp: "clear",
                storeOp: "store",
            }],
        })
        outlinePass.setPipeline(this.#outlinePipeline)
        outlinePass.setBindGroup(0, this.#outlineBindGroup)
        outlinePass.draw(4)
        outlinePass.end()

        this.#device.queue.submit([commandEncoder.finish()])

        if (waitForGPU) {
            await this.#device.queue.onSubmittedWorkDone()
        }
    }

    update(time: number): void {
        // Schedule next frame first
        requestAnimationFrame(t => this.update(t))

        // Only render when camera changed or scene needs update
        if (!this.#needsRender) {
            return
        }

        // Frame rate limiting: skip if rendering too fast
        const minFrameTime = 1000 / this.#targetFPS
        const timeSinceLastRender = time - this.#lastRenderEndTime
        if (timeSinceLastRender < minFrameTime) {
            return
        }

        // Clear dirty flag before rendering
        this.#needsRender = false

        // Perform the render (non-blocking for normal loop)
        this.#renderFrame(false)

        // Update FPS after actual render
        const now = performance.now()
        const deltaTime = now - this.#lastActualRenderTime
        if (deltaTime > 0 && this.#lastActualRenderTime > 0) {
            this.#framerate.update(1000 / deltaTime)
            this.#preview.updateFPS(this.#framerate.average)
        }
        this.#lastActualRenderTime = now
        this.#lastRenderEndTime = now
    }

    /** Request a re-render (e.g., after scene change) */
    requestRender(): void {
        this.#needsRender = true
    }

    /**
     * Called when the camera moves (rotate, pan, zoom).
     * Drops to half resolution immediately for responsiveness,
     * then restores full resolution after movement settles.
     */
    #onCameraMovement(): void {
        if (!this.#cameraOptimization) return

        // Drop to reduced resolution on first movement
        if (this.#resolutionScale === 1.0) {
            this.#resolutionScale = this.#movementScale
            this.#applyResolutionScale()
        }

        // Reset the settle timer
        if (this.#movementTimer !== null) {
            clearTimeout(this.#movementTimer)
        }
        this.#movementTimer = setTimeout(() => {
            this.#movementTimer = null
            this.#resolutionScale = 1.0
            this.#applyResolutionScale()
            this.#needsRender = true
        }, this.#movementSettleMs)
    }

    /**
     * Applies the current resolution scale to scene dimensions and camera resolution.
     * The canvas always stays at full resolution; only the offscreen scene textures
     * are scaled, and the outline pass upscales them back to full resolution with
     * hardware bilinear interpolation.
     */
    #applyResolutionScale(): void {
        if (this.#fullWidth === 0 || this.#fullHeight === 0) return
        this.#preview.canvas.width = this.#fullWidth
        this.#preview.canvas.height = this.#fullHeight
        this.#sceneWidth = Math.max(1, Math.round(this.#fullWidth * this.#resolutionScale))
        this.#sceneHeight = Math.max(1, Math.round(this.#fullHeight * this.#resolutionScale))
        this.#cameraRes = vec2(this.#sceneWidth, this.#sceneHeight)
    }

    /**
     * Benchmark rendering performance by rendering n frames and measuring time.
     * @param frameCount Number of frames to render (default: 100)
     * @param waitForGPU If true, wait for GPU completion after each frame for accurate timing (default: true)
     * @returns Benchmark results with timing statistics
     */
    async benchmark(frameCount = 100, waitForGPU = true): Promise<{
        totalTime: number
        averageFrameTime: number
        minFrameTime: number
        maxFrameTime: number
        framesPerSecond: number
        frameTimes: number[]
    }> {
        const frameTimes: number[] = []
        const startTime = performance.now()

        // Ensure we have a valid scene before benchmarking
        if (!this.#pipeline) {
            throw new Error("Cannot benchmark: renderer not initialized. Call build() first.")
        }

        // Warm-up frame to ensure GPU is ready
        await this.#renderFrame(waitForGPU)

        // Benchmark loop
        for (let i = 0; i < frameCount; i++) {
            const frameStart = performance.now()
            await this.#renderFrame(waitForGPU)
            const frameEnd = performance.now()
            frameTimes.push(frameEnd - frameStart)
        }

        const endTime = performance.now()
        const totalTime = endTime - startTime

        // Calculate statistics
        const averageFrameTime = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length
        const minFrameTime = Math.min(...frameTimes)
        const maxFrameTime = Math.max(...frameTimes)
        const framesPerSecond = 1000 / averageFrameTime

        return {
            totalTime,
            averageFrameTime,
            minFrameTime,
            maxFrameTime,
            framesPerSecond,
            frameTimes,
        }
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
            simplifyTargetRatio: 0.1,
            simplifyRegularize: false,
            simplifyLockBorder: true,
            simplifyPrune: false,
            simplifySparse: false,
            simplifyTargetError: 0.001,
            // simplifyErrorAbsolute: true,
        }
        console.log(
            `MDC export params: dim=${gridDimX}x${gridDimY}x${gridDimZ} voxel=${voxelSizeMm}mm bbox=[${minX.toFixed(
                3
            )},${minY.toFixed(3)},${minZ.toFixed(3)}]..[${maxX.toFixed(3)},${maxY.toFixed(3)},${maxZ.toFixed(3)}]`
        )

        const mdc = new MDCExport(this.#helper, params, this.#uniformBuffers.selectedObjectIds)

        // Create and show progress dialog
        const { ProgressDialog } = await import("./components/progress-dialog.mjs")
        const progressDialog = new ProgressDialog()
        const progressPromise = progressDialog.show()

        // Track cancellation state
        let cancelled = false

        // Create progress callback that updates the dialog
        const progressCallback: import("./export/mdc.mjs").ProgressCallback = {
            updateProgress: (phase: string, percentage: number) => {
                if (!cancelled) {
                    progressDialog.updateProgress(phase, percentage)
                }
            },
            get cancelled() {
                return cancelled || progressDialog.cancelled
            }
        }

        // Update cancelled flag when dialog is cancelled - use synchronous check
        // The promise resolves when cancelled, so we need to handle it immediately
        let cancellationHandled = false
        progressPromise.then(completed => {
            if (!completed && !cancellationHandled) {
                cancelled = true
                cancellationHandled = true
            }
        }).catch(() => {
            if (!cancellationHandled) {
                cancelled = true
                cancellationHandled = true
            }
        })

        let mesh: MeshData
        try {
            mesh = await mdc.export(this.#exportShader, progressCallback)
            if (!progressDialog.cancelled) {
                progressDialog.complete()
            }
            await progressPromise.catch(() => { }) // Wait for dialog to close, ignore errors

            return mesh
        } catch (err) {
            if (!progressDialog.cancelled) {
                progressDialog.complete()
            }
            await progressPromise.catch(() => { }) // Wait for dialog to close, ignore errors
            if (err instanceof Error && err.message.includes("cancelled")) {
                throw new Error("Mesh generation was cancelled")
            }
            throw err
        }
    }
}
