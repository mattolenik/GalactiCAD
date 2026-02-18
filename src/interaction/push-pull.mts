import { Vec2f, Vec3f, vec2, vec3 } from "../vecmat/vector.mjs"
import type { Extrude } from "../scene/scene.mjs"

/** Reserved object ID for face-level highlighting via the existing outline system. */
const FACE_HIGHLIGHT_ID = 1023

export interface PushPullHost {
    readonly device: GPUDevice
    readonly polygonVerticesBuffer: GPUBuffer
    readonly faceSelectionBuffer: GPUBuffer
    readonly selectedObjectIdsBuffer: GPUBuffer
    requestRender(): void
    readonly canvas: HTMLCanvasElement
    readonly controls: {
        readonly viewTransform: { data: Float32Array }
        readonly cameraPosition: Vec3f
        readonly zoom: number
        isDragging: boolean
    }
    readonly viewCenter: Vec2f
    readonly cameraRes: Vec2f
}

interface FaceState {
    extrude: Extrude
    faceIndex: number
    normal2D: Vec2f
    normal3D: Vec3f
    originalVertices: [number, number][]
}

export class PushPullController {
    #host: PushPullHost
    #face: FaceState | null = null
    #dragging = false
    #dragStartScreen = vec2(0, 0)
    #dragOffset = 0
    #onComplete: ((nodeId: number, vertices: [number, number][]) => void) | null = null
    #onDeselect: (() => void) | null = null

    constructor(host: PushPullHost) {
        this.#host = host
    }

    get isActive(): boolean {
        return this.#face !== null
    }

    get isDragging(): boolean {
        return this.#dragging
    }

    set onComplete(cb: (nodeId: number, vertices: [number, number][]) => void) {
        this.#onComplete = cb
    }

    set onDeselect(cb: () => void) {
        this.#onDeselect = cb
    }

    /** Identify and select the face of the given Extrude that was clicked at hitPos. */
    selectFace(extrude: Extrude, hitPos: Vec3f): void {
        const localPos = vec3(
            hitPos.x - extrude.pos.x,
            hitPos.y - extrude.pos.y,
            hitPos.z - extrude.pos.z,
        )

        // Project to XZ plane (polygon lives in XZ)
        const px = localPos.x
        const pz = localPos.z

        const verts = extrude.child.vertices
        const N = verts.length

        // Find closest edge
        let minDist = Infinity
        let closestEdge = 0
        for (let j = N - 1, i = 0; i < N; j = i, i++) {
            const ex = verts[i][0] - verts[j][0]
            const ey = verts[i][1] - verts[j][1]
            const wx = px - verts[j][0]
            const wy = pz - verts[j][1]
            const t = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey)))
            const bx = wx - ex * t
            const by = wy - ey * t
            const dd = bx * bx + by * by
            if (dd < minDist) {
                minDist = dd
                closestEdge = j
            }
        }

        // Compute outward normal for the edge
        const i0 = closestEdge
        const i1 = (closestEdge + 1) % N
        const edgeX = verts[i1][0] - verts[i0][0]
        const edgeY = verts[i1][1] - verts[i0][1]
        const edgeLen = Math.sqrt(edgeX * edgeX + edgeY * edgeY)

        // Perpendicular: rotate 90 degrees. Determine outward direction from polygon winding.
        const windingSign = computeSignedArea(verts) < 0 ? -1 : 1
        const nx = windingSign * edgeY / edgeLen
        const ny = windingSign * -edgeX / edgeLen

        this.#face = {
            extrude,
            faceIndex: closestEdge,
            normal2D: vec2(nx, ny),
            normal3D: vec3(nx, 0, ny),
            originalVertices: verts.map(v => [v[0], v[1]] as [number, number]),
        }

        // Write face selection uniform to GPU
        this.#writeFaceSelection(extrude.id, closestEdge)

        // Mark FACE_HIGHLIGHT_ID as selected, deselect everything else
        const selData = new Uint32Array(1024)
        selData[FACE_HIGHLIGHT_ID] = 1
        this.#host.device.queue.writeBuffer(this.#host.selectedObjectIdsBuffer, 0, selData)

        this.#host.requestRender()
    }

    /** Deselect any active face. */
    deselect(): void {
        if (!this.#face) return
        this.#face = null
        this.#dragging = false

        // Clear face selection on GPU
        this.#writeFaceSelection(0, 0)

        // Clear FACE_HIGHLIGHT_ID selection
        this.#host.device.queue.writeBuffer(
            this.#host.selectedObjectIdsBuffer,
            FACE_HIGHLIGHT_ID * 4,
            new Uint32Array([0])
        )

        this.#host.requestRender()
        this.#onDeselect?.()
    }

    /** Handle pointer down: start a drag if clicking on the selected face. */
    handlePointerDown(e: PointerEvent): boolean {
        if (!this.#face || e.button !== 0) return false

        this.#dragging = true
        this.#dragStartScreen = vec2(e.clientX, e.clientY)
        this.#dragOffset = 0
        this.#host.controls.isDragging = true
        this.#host.canvas.setPointerCapture(e.pointerId)
        return true
    }

    /** Handle pointer move during drag. Returns true if the event was consumed. */
    handlePointerMove(e: PointerEvent): boolean {
        if (!this.#dragging || !this.#face) return false

        const currentScreen = vec2(e.clientX, e.clientY)
        const delta = vec2(
            currentScreen.x - this.#dragStartScreen.x,
            currentScreen.y - this.#dragStartScreen.y,
        )

        // Project the face normal into screen space to determine drag direction
        const screenNormal = this.#projectNormalToScreen(this.#face.normal3D)
        const screenNormalLen = Math.sqrt(screenNormal.x * screenNormal.x + screenNormal.y * screenNormal.y)
        if (screenNormalLen < 1e-6) return true

        // Dot product of drag delta with screen-space normal gives pixel offset
        const pixelOffset = (delta.x * screenNormal.x + delta.y * screenNormal.y) / screenNormalLen

        // Convert pixel offset to world units using camera zoom and canvas size
        const canvas = this.#host.canvas
        const canvasHeight = canvas.getBoundingClientRect().height
        const worldOffset = pixelOffset * (this.#host.controls.zoom * 2) / canvasHeight

        this.#dragOffset = worldOffset
        this.#applyOffset(worldOffset)

        return true
    }

    /** Handle pointer up: finalize drag. Returns true if the event was consumed. */
    handlePointerUp(e: PointerEvent): boolean {
        if (!this.#dragging || !this.#face) return false

        this.#dragging = false
        this.#host.controls.isDragging = false

        if (Math.abs(this.#dragOffset) > 0.001) {
            // Commit: fire the completion callback with the new vertices
            const newVerts = this.#face.extrude.child.vertices.map(
                v => [v[0], v[1]] as [number, number]
            )
            this.#onComplete?.(this.#face.extrude.child.id, newVerts)
        }

        // Deselect after completing the drag
        this.deselect()
        return true
    }

    /** Handle Escape key: cancel drag and restore original vertices. */
    handleKeyDown(e: KeyboardEvent): boolean {
        if (e.key === "Escape" && this.#face) {
            if (this.#dragging) {
                // Restore original vertices
                this.#restoreOriginalVertices()
                this.#dragging = false
                this.#host.controls.isDragging = false
            }
            this.deselect()
            return true
        }
        return false
    }

    #writeFaceSelection(nodeId: number, faceIndex: number): void {
        const data = new Uint32Array([nodeId, faceIndex])
        this.#host.device.queue.writeBuffer(this.#host.faceSelectionBuffer, 0, data)
    }

    /** Apply a push/pull offset to the selected face, updating polygon vertices. */
    #applyOffset(offset: number): void {
        const face = this.#face!
        const verts = face.originalVertices
        const N = verts.length
        const i0 = face.faceIndex
        const i1 = (i0 + 1) % N

        // Compute new vertices by moving edge along its normal
        const newVerts: [number, number][] = verts.map(v => [v[0], v[1]])

        // The moved edge endpoints (translated along the 2D normal)
        const movedA: [number, number] = [
            verts[i0][0] + offset * face.normal2D.x,
            verts[i0][1] + offset * face.normal2D.y,
        ]
        const movedB: [number, number] = [
            verts[i1][0] + offset * face.normal2D.x,
            verts[i1][1] + offset * face.normal2D.y,
        ]

        // Edge direction of the moved edge
        const edgeDirX = movedB[0] - movedA[0]
        const edgeDirY = movedB[1] - movedA[1]

        // Compute new v[i0]: intersection of moved edge with previous edge
        const iPrev = (i0 - 1 + N) % N
        const prevDirX = verts[i0][0] - verts[iPrev][0]
        const prevDirY = verts[i0][1] - verts[iPrev][1]
        const newV0 = lineLineIntersection(
            movedA[0], movedA[1], edgeDirX, edgeDirY,
            verts[iPrev][0], verts[iPrev][1], prevDirX, prevDirY,
        )

        // Compute new v[i1]: intersection of moved edge with next edge
        const iNext = (i1 + 1) % N
        const nextDirX = verts[iNext][0] - verts[i1][0]
        const nextDirY = verts[iNext][1] - verts[i1][1]
        const newV1 = lineLineIntersection(
            movedA[0], movedA[1], edgeDirX, edgeDirY,
            verts[i1][0], verts[i1][1], nextDirX, nextDirY,
        )

        if (newV0) {
            newVerts[i0] = newV0
        }
        if (newV1) {
            newVerts[i1] = newV1
        }

        // Update the Extrude's polygon vertices in memory
        for (let i = 0; i < N; i++) {
            face.extrude.child.vertices[i] = newVerts[i]
        }

        // Write updated vertices to the GPU buffer
        this.#writePolygonVerticesToGPU(face.extrude)
        this.#host.requestRender()
    }

    #restoreOriginalVertices(): void {
        const face = this.#face!
        for (let i = 0; i < face.originalVertices.length; i++) {
            face.extrude.child.vertices[i] = [
                face.originalVertices[i][0],
                face.originalVertices[i][1],
            ]
        }
        this.#writePolygonVerticesToGPU(face.extrude)
        this.#host.requestRender()
    }

    #writePolygonVerticesToGPU(extrude: Extrude): void {
        const poly = extrude.child
        if (poly.bufferOffset < 0) return
        const data = new Float32Array(poly.vertices.length * 2)
        for (let i = 0; i < poly.vertices.length; i++) {
            data[i * 2] = poly.vertices[i][0]
            data[i * 2 + 1] = poly.vertices[i][1]
        }
        this.#host.device.queue.writeBuffer(
            this.#host.polygonVerticesBuffer,
            poly.bufferOffset * 8, // each vec2f is 8 bytes
            data,
        )
    }

    /** Project a 3D world-space direction to 2D screen-space direction. */
    #projectNormalToScreen(normal: Vec3f): Vec2f {
        const transform = this.#host.controls.viewTransform.data
        // The view transform is a 4x4 matrix (column-major in Float32Array).
        // We apply the rotation part (3x3 upper-left) to the normal to get camera-space direction.
        const cx = transform[0] * normal.x + transform[4] * normal.y + transform[8] * normal.z
        const cy = transform[1] * normal.x + transform[5] * normal.y + transform[9] * normal.z

        // In screen space, X maps to screen right, Y maps to screen up (but screen Y is flipped)
        return vec2(cx, -cy)
    }
}

/** Compute signed area of a 2D polygon. Positive = CCW, Negative = CW. */
function computeSignedArea(vertices: [number, number][]): number {
    let area = 0
    const N = vertices.length
    for (let i = 0, j = N - 1; i < N; j = i, i++) {
        area += (vertices[j][0] + vertices[i][0]) * (vertices[j][1] - vertices[i][1])
    }
    return area * 0.5
}

/**
 * Compute intersection of two 2D lines.
 * Line 1: P1 + t * D1
 * Line 2: P2 + t * D2
 * Returns the intersection point, or null if lines are parallel.
 */
function lineLineIntersection(
    p1x: number, p1y: number, d1x: number, d1y: number,
    p2x: number, p2y: number, d2x: number, d2y: number,
): [number, number] | null {
    const cross = d1x * d2y - d1y * d2x
    if (Math.abs(cross) < 1e-10) return null // parallel

    const dpx = p2x - p1x
    const dpy = p2y - p1y
    const t = (dpx * d2y - dpy * d2x) / cross

    return [p1x + t * d1x, p1y + t * d1y]
}
