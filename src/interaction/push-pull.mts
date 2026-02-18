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

export type PushPullMode = "slide" | "extrude"

export class PushPullController {
    #host: PushPullHost
    #face: FaceState | null = null
    #dragging = false
    #dragStartScreen = vec2(0, 0)
    #dragOffset = 0
    #canvasHeight = 0
    #onComplete: ((nodeId: number, vertices: [number, number][]) => void) | null = null
    #onDeselect: (() => void) | null = null
    mode: PushPullMode = "slide"

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

        // Write face selection uniform to GPU (mode=0 for initial selection, no offset yet)
        this.#writeFaceSelection(extrude.id, closestEdge, 0, 0)

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
        this.#canvasHeight = this.#host.canvas.getBoundingClientRect().height
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

        // Project the face normal from world space to screen space.
        //
        // viewTransform is the camera-to-world matrix (used in the shader as
        // camera.transform * cameraSpacePoint = worldSpacePoint). Its columns
        // are the camera's basis vectors in world space:
        //   column 0 = camera right
        //   column 1 = camera up
        //   column 2 = camera -forward (ray direction is -column2)
        //
        // To project a world-space direction onto the screen plane, we dot
        // with each column (not row) of the matrix.
        const m = this.#host.controls.viewTransform.data
        const n = this.#face.normal3D
        const dotRight = m[0] * n.x + m[1] * n.y + m[2] * n.z
        const dotUp    = m[4] * n.x + m[5] * n.y + m[6] * n.z

        // Screen-space normal. Screen Y is flipped (screen down = +Y, camera up = +Y).
        const snx = dotRight
        const sny = -dotUp
        const snLenSq = snx * snx + sny * sny
        if (snLenSq < 1e-12) return true // normal points directly at/away from camera

        // Convert drag delta to world-space offset along the face normal.
        //
        // The orthographic camera has visible height = 2 * zoom, so
        // worldPerPixel = 2 * zoom / canvasHeight.
        //
        // 1 world unit along the normal produces |screenNormal| * (1/worldPerPixel) pixels.
        // Inverting: worldOffset = dot(drag, sn) * worldPerPixel / |sn|^2
        const worldPerPixel = (this.#host.controls.zoom * 2) / this.#canvasHeight
        const worldOffset = (delta.x * snx + delta.y * sny) * worldPerPixel / snLenSq

        this.#dragOffset = worldOffset
        if (this.mode === "extrude") {
            this.#applyExtrudeOffset(worldOffset)
        } else {
            this.#applyOffset(worldOffset)
        }

        return true
    }

    /** Handle pointer up: finalize drag. Returns true if the event was consumed. */
    handlePointerUp(e: PointerEvent): boolean {
        if (!this.#dragging || !this.#face) return false

        this.#dragging = false
        this.#host.controls.isDragging = false

        if (Math.abs(this.#dragOffset) > 0.001) {
            if (this.mode === "extrude") {
                // Compute expanded vertices: insert 2 new vertices for the extruded face
                const newVerts = this.#computeExtrudedVertices(this.#dragOffset)
                this.#onComplete?.(this.#face.extrude.child.id, newVerts)
            } else {
                const newVerts = this.#face.extrude.child.vertices.map(
                    v => [v[0], v[1]] as [number, number]
                )
                this.#onComplete?.(this.#face.extrude.child.id, newVerts)
            }
        }

        // Deselect after completing the drag
        this.deselect()
        return true
    }

    /** Handle Escape key: cancel drag and restore original vertices. */
    handleKeyDown(e: KeyboardEvent): boolean {
        if (e.key === "Escape" && this.#face) {
            if (this.#dragging) {
                if (this.mode === "slide") {
                    this.#restoreOriginalVertices()
                }
                // Extrude mode: vertices weren't modified during drag, just clear the uniform
                this.#dragging = false
                this.#host.controls.isDragging = false
            }
            this.deselect()
            return true
        }
        return false
    }

    #writeFaceSelection(nodeId: number, faceIndex: number, mode: number = 0, extrudeOffset: number = 0): void {
        const data = new ArrayBuffer(16)
        const u32 = new Uint32Array(data)
        const f32 = new Float32Array(data)
        u32[0] = nodeId
        u32[1] = faceIndex
        u32[2] = mode
        f32[3] = extrudeOffset
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

    /** In extrude mode, write the offset to the faceSelection uniform. No vertex modification. */
    #applyExtrudeOffset(offset: number): void {
        const face = this.#face!
        this.#writeFaceSelection(face.extrude.id, face.faceIndex, 1, offset)
        this.#host.requestRender()
    }

    /**
     * Compute the expanded vertex array for extrude completion.
     * Inserts two new vertices to create the step/bump in the polygon.
     *
     * Original: ..., v[i0], v[i1], ...
     * Result:   ..., v[i0], v[i0]+offset*n, v[i1]+offset*n, v[i1], ...
     */
    #computeExtrudedVertices(offset: number): [number, number][] {
        const face = this.#face!
        const verts = face.originalVertices
        const N = verts.length
        const i0 = face.faceIndex
        const i1 = (i0 + 1) % N
        const nx = face.normal2D.x
        const ny = face.normal2D.y

        const result: [number, number][] = []
        for (let i = 0; i < N; i++) {
            result.push([verts[i][0], verts[i][1]])
            if (i === i0) {
                // Insert the two extruded vertices after v[i0]
                result.push([verts[i0][0] + offset * nx, verts[i0][1] + offset * ny])
                result.push([verts[i1][0] + offset * nx, verts[i1][1] + offset * ny])
            }
        }
        return result
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
