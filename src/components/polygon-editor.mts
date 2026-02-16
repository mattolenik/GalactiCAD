import { Subject, Subscription } from "rxjs"
import { debounceTime } from "rxjs/operators"
import { __fg_color, __tone_1, __tone_2, __tone_3, __tone_accent, __bg_color_dark } from "../style/style.mjs"

export class PolygonEditor extends HTMLElement {
    #shadow = this.attachShadow({ mode: "open" })
    #ac = new AbortController()

    // Polygon state
    #vertices: [number, number][]
    #mode: "new" | "edit"
    #selectedVertex = -1
    #dragging = false
    #snapEnabled = false
    #altHeld = false

    // View transform
    #panX = 0
    #panY = 0
    #zoom = 40
    #isPanning = false
    #panStartScreen: [number, number] = [0, 0]
    #panStartOffset: [number, number] = [0, 0]

    // Mouse tracking
    #mouseWorldX = 0
    #mouseWorldY = 0
    #mouseSX = 0
    #mouseSY = 0
    #mouseOnCanvas = false

    // rAF draw batching
    #drawPending = false
    #pendingInputUpdate = -1
    #changeDirty = false
    #canvasRect: DOMRect = new DOMRect()

    // Canvas sizing (CSS pixels)
    #canvasW = 0
    #canvasH = 0

    // DOM references
    #canvas: HTMLCanvasElement
    #ctx: CanvasRenderingContext2D
    #vertexList: HTMLDivElement
    #snapCheckbox: HTMLInputElement
    #modeLabel: HTMLSpanElement

    // Undo/redo
    #undoStack: [number, number][][] = []
    #redoStack: [number, number][][] = []

    // Source sync
    #change$ = new Subject<void>()
    #changeSub: Subscription
    onChange?: (vertices: [number, number][]) => void
    onClose?: () => void

    constructor(vertices: [number, number][]) {
        super()
        this.#vertices = vertices.map(v => [v[0], v[1]] as [number, number])
        this.#mode = vertices.length <= 2 ? "new" : "edit"

        this.#shadow.innerHTML = `
            <style>
                :host {
                    display: flex;
                    flex-direction: column;
                    width: 100%;
                    height: 100%;
                    background: var(${__tone_2});
                    color: var(${__fg_color});
                    overflow: hidden;
                }
                .titlebar {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 8px 16px;
                    background: var(${__tone_3});
                    font-size: 14px;
                    font-weight: 600;
                    user-select: none;
                    -webkit-user-select: none;
                }
                .close-btn {
                    background: none;
                    border: none;
                    color: var(${__fg_color});
                    font-size: 20px;
                    cursor: pointer;
                    padding: 0 6px;
                    border-radius: 4px;
                    line-height: 1;
                }
                .close-btn:hover {
                    background: rgba(255, 255, 255, 0.1);
                }
                .canvas-container {
                    flex: 1;
                    min-height: 0;
                    position: relative;
                    background: #1a1a1a;
                }
                canvas {
                    width: 100%;
                    height: 100%;
                    display: block;
                }
                .controls {
                    padding: 6px 16px;
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    background: var(${__tone_2});
                    border-top: 1px solid var(${__tone_3});
                    font-size: 13px;
                }
                .controls label {
                    display: flex;
                    align-items: center;
                    gap: 5px;
                    cursor: pointer;
                    user-select: none;
                    -webkit-user-select: none;
                }
                .controls input[type="checkbox"] {
                    accent-color: var(${__tone_accent});
                }
                .mode-label {
                    margin-left: auto;
                    font-size: 12px;
                    color: var(${__tone_1});
                }
                .vertex-list {
                    max-height: 150px;
                    overflow-y: auto;
                    border-top: 1px solid var(${__tone_3});
                    scrollbar-width: thin;
                }
                .vertex-row {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    padding: 4px 16px;
                    font-size: 13px;
                    cursor: pointer;
                    user-select: none;
                    -webkit-user-select: none;
                }
                .vertex-row:hover {
                    background: rgba(255, 255, 255, 0.04);
                }
                .vertex-row.selected {
                    background: rgba(0, 122, 204, 0.15);
                }
                .vertex-label {
                    width: 28px;
                    font-family: monospace;
                    font-size: 11px;
                    color: var(${__tone_1});
                }
                .axis-label {
                    font-family: monospace;
                    font-size: 11px;
                    color: var(${__tone_1});
                }
                .vertex-input {
                    width: 72px;
                    background: var(${__bg_color_dark});
                    color: var(${__fg_color});
                    border: 1px solid var(${__tone_3});
                    border-radius: 3px;
                    padding: 2px 6px;
                    font-size: 13px;
                    font-family: monospace;
                }
                .vertex-input:focus {
                    outline: none;
                    border-color: var(${__tone_accent});
                }
            </style>
            <div class="titlebar">
                <span>Polygon Editor</span>
                <button class="close-btn">\u00d7</button>
            </div>
            <div class="canvas-container">
                <canvas></canvas>
            </div>
            <div class="controls">
                <label>
                    <input type="checkbox" class="snap-checkbox">
                    Snap to grid
                </label>
                <span class="mode-label"></span>
            </div>
            <div class="vertex-list"></div>
        `

        this.#canvas = this.#shadow.querySelector("canvas")!
        this.#ctx = this.#canvas.getContext("2d", { alpha: false })!
        this.#vertexList = this.#shadow.querySelector(".vertex-list")!
        this.#snapCheckbox = this.#shadow.querySelector<HTMLInputElement>(".snap-checkbox")!
        this.#modeLabel = this.#shadow.querySelector(".mode-label")!

        // Wire UI events
        this.#shadow.querySelector(".close-btn")!.addEventListener("click", () => this.#close())
        this.#snapCheckbox.addEventListener("change", () => {
            this.#snapEnabled = this.#snapCheckbox.checked
        })

        // Canvas events
        this.#canvas.addEventListener("mousedown", this.#onCanvasMouseDown)
        this.#canvas.addEventListener("mousemove", this.#onCanvasMouseMove)
        this.#canvas.addEventListener("mouseleave", this.#onCanvasMouseLeave)
        this.#canvas.addEventListener("wheel", this.#onWheel, { passive: false })
        this.#canvas.addEventListener("contextmenu", e => e.preventDefault())

        // Debounced source sync
        this.#changeSub = this.#change$.pipe(debounceTime(300)).subscribe(() => {
            this.onChange?.(this.#vertices.map(v => [v[0], v[1]] as [number, number]))
        })

        this.#updateModeLabel()
        this.#rebuildVertexList()
    }

    connectedCallback() {
        this.#ac = new AbortController()
        const { signal } = this.#ac

        window.addEventListener("keydown", this.#onKeyDown, { signal })
        window.addEventListener("keyup", this.#onKeyUp, { signal })

        // Size canvas and render after layout
        requestAnimationFrame(() => {
            this.#resizeCanvas()
            this.#autoFit()
            this.#draw()
        })

        // Handle canvas resize
        const ro = new ResizeObserver(() => {
            this.#resizeCanvas()
            this.#draw()
        })
        ro.observe(this.#canvas)
        signal.addEventListener("abort", () => ro.disconnect())
    }

    disconnectedCallback() {
        this.#ac.abort()
        this.#changeSub.unsubscribe()
        window.removeEventListener("mousemove", this.#onDragMove)
        window.removeEventListener("mouseup", this.#onDragEnd)
    }

    #close() {
        if (!this.isConnected) return
        // Flush final state
        this.onChange?.(this.#vertices.map(v => [v[0], v[1]] as [number, number]))
        this.onChange = undefined
        this.#changeSub.unsubscribe()
        this.onClose?.()
        this.remove()
    }

    // ── Canvas sizing ──────────────────────────────────────────────

    #resizeCanvas() {
        this.#canvasRect = this.#canvas.getBoundingClientRect()
        const dpr = devicePixelRatio || 1
        this.#canvasW = this.#canvasRect.width
        this.#canvasH = this.#canvasRect.height
        this.#canvas.width = this.#canvasRect.width * dpr
        this.#canvas.height = this.#canvasRect.height * dpr
        this.#ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    #autoFit() {
        if (this.#vertices.length === 0) {
            this.#panX = 0
            this.#panY = 0
            this.#zoom = 40
            return
        }

        let minX = Infinity, maxX = -Infinity
        let minY = Infinity, maxY = -Infinity
        for (const [x, y] of this.#vertices) {
            minX = Math.min(minX, x)
            maxX = Math.max(maxX, x)
            minY = Math.min(minY, y)
            maxY = Math.max(maxY, y)
        }

        this.#panX = (minX + maxX) / 2
        this.#panY = (minY + maxY) / 2

        const spanX = maxX - minX || 10
        const spanY = maxY - minY || 10
        const margin = 1.4
        this.#zoom = Math.min(
            this.#canvasW / (spanX * margin),
            this.#canvasH / (spanY * margin)
        )
        this.#zoom = Math.max(1, Math.min(2000, this.#zoom))
    }

    #updateModeLabel() {
        this.#modeLabel.textContent = this.#mode === "new"
            ? "Click to place vertices \u2022 click first vertex to close"
            : "Drag vertices \u2022 click edge to split \u2022 Delete to remove"
    }

    // ── Coordinate transforms ──────────────────────────────────────

    #worldToScreen(wx: number, wy: number): [number, number] {
        return [
            (wx - this.#panX) * this.#zoom + this.#canvasW / 2,
            -(wy - this.#panY) * this.#zoom + this.#canvasH / 2
        ]
    }

    #screenToWorld(sx: number, sy: number): [number, number] {
        return [
            (sx - this.#canvasW / 2) / this.#zoom + this.#panX,
            -(sy - this.#canvasH / 2) / this.#zoom + this.#panY
        ]
    }

    #applySnap(wx: number, wy: number): [number, number] {
        const shouldSnap = this.#snapEnabled !== this.#altHeld
        if (shouldSnap) {
            return [Math.round(wx), Math.round(wy)]
        }
        return [Math.round(wx * 100) / 100, Math.round(wy * 100) / 100]
    }

    // ── Drawing ────────────────────────────────────────────────────

    #requestDraw() {
        if (this.#drawPending) return
        this.#drawPending = true
        requestAnimationFrame(() => {
            this.#drawPending = false
            this.#draw()
            if (this.#pendingInputUpdate >= 0) {
                this.#updateVertexInputs(this.#pendingInputUpdate)
                this.#pendingInputUpdate = -1
            }
            if (this.#changeDirty) {
                this.#changeDirty = false
                this.#emitChange()
            }
        })
    }

    #draw() {
        const ctx = this.#ctx
        const w = this.#canvasW
        const h = this.#canvasH
        if (w === 0 || h === 0) return

        ctx.clearRect(0, 0, w, h)
        this.#drawGrid()
        this.#drawEdges()
        this.#drawPreviewLine()
        this.#drawVertices()
    }

    #drawGrid() {
        const ctx = this.#ctx
        const w = this.#canvasW
        const h = this.#canvasH

        // Adaptive grid step — aim for ~15-80px between lines
        let step = 1
        const minGap = 15
        while (step * this.#zoom < minGap) {
            if (step * 2 * this.#zoom >= minGap) { step *= 2; break }
            if (step * 5 * this.#zoom >= minGap) { step *= 5; break }
            step *= 10
        }

        const [wLeft, wTop] = this.#screenToWorld(0, 0)
        const [wRight, wBottom] = this.#screenToWorld(w, h)
        const minWX = Math.min(wLeft, wRight)
        const maxWX = Math.max(wLeft, wRight)
        const minWY = Math.min(wTop, wBottom)
        const maxWY = Math.max(wTop, wBottom)

        const startX = Math.floor(minWX / step) * step
        const endX = Math.ceil(maxWX / step) * step
        const startY = Math.floor(minWY / step) * step
        const endY = Math.ceil(maxWY / step) * step

        // Minor grid lines
        ctx.strokeStyle = "rgba(255, 255, 255, 0.06)"
        ctx.lineWidth = 0.5
        ctx.beginPath()
        for (let x = startX; x <= endX; x += step) {
            if (x === 0) continue
            const [sx] = this.#worldToScreen(x, 0)
            ctx.moveTo(sx, 0)
            ctx.lineTo(sx, h)
        }
        for (let y = startY; y <= endY; y += step) {
            if (y === 0) continue
            const [, sy] = this.#worldToScreen(0, y)
            ctx.moveTo(0, sy)
            ctx.lineTo(w, sy)
        }
        ctx.stroke()

        // Axis lines
        ctx.strokeStyle = "rgba(255, 255, 255, 0.2)"
        ctx.lineWidth = 1
        ctx.beginPath()
        const [ox, oy] = this.#worldToScreen(0, 0)
        if (ox >= 0 && ox <= w) {
            ctx.moveTo(ox, 0)
            ctx.lineTo(ox, h)
        }
        if (oy >= 0 && oy <= h) {
            ctx.moveTo(0, oy)
            ctx.lineTo(w, oy)
        }
        ctx.stroke()
    }

    #drawEdges() {
        const ctx = this.#ctx
        if (this.#vertices.length < 2) return

        ctx.strokeStyle = "#0af"
        ctx.lineWidth = 2
        ctx.beginPath()

        const [fx, fy] = this.#worldToScreen(...this.#vertices[0])
        ctx.moveTo(fx, fy)

        for (let i = 1; i < this.#vertices.length; i++) {
            const [sx, sy] = this.#worldToScreen(...this.#vertices[i])
            ctx.lineTo(sx, sy)
        }

        if (this.#mode === "edit" && this.#vertices.length >= 3) {
            ctx.closePath()
        }

        ctx.stroke()
    }

    #drawPreviewLine() {
        if (this.#mode !== "new" || this.#vertices.length === 0 || !this.#mouseOnCanvas) return

        const ctx = this.#ctx
        const last = this.#vertices[this.#vertices.length - 1]
        const [sx, sy] = this.#worldToScreen(...last)
        const [mx, my] = this.#worldToScreen(this.#mouseWorldX, this.#mouseWorldY)

        ctx.strokeStyle = "rgba(0, 170, 255, 0.5)"
        ctx.lineWidth = 1.5
        ctx.setLineDash([5, 5])
        ctx.beginPath()
        ctx.moveTo(sx, sy)
        ctx.lineTo(mx, my)
        ctx.stroke()
        ctx.setLineDash([])
    }

    #drawVertices() {
        const ctx = this.#ctx

        for (let i = 0; i < this.#vertices.length; i++) {
            const [wx, wy] = this.#vertices[i]
            const [sx, sy] = this.#worldToScreen(wx, wy)

            // Highlight close-able first vertex in new mode
            const isCloseTarget = i === 0 && this.#mode === "new"
                && this.#vertices.length >= 3 && this.#mouseOnCanvas
                && Math.hypot(this.#mouseSX - sx, this.#mouseSY - sy) <= 10

            if (isCloseTarget) {
                ctx.beginPath()
                ctx.arc(sx, sy, 12, 0, Math.PI * 2)
                ctx.strokeStyle = "rgba(0, 204, 122, 0.4)"
                ctx.lineWidth = 2
                ctx.stroke()
            }

            ctx.beginPath()
            ctx.arc(sx, sy, 6, 0, Math.PI * 2)

            if (i === this.#selectedVertex) {
                ctx.fillStyle = "#007acc"
            } else if (isCloseTarget) {
                ctx.fillStyle = "#00cc7a"
            } else {
                ctx.fillStyle = "#fff"
            }

            ctx.fill()
            ctx.strokeStyle = "#000"
            ctx.lineWidth = 1.5
            ctx.stroke()
        }
    }

    // ── Hit testing ────────────────────────────────────────────────

    #findVertexAt(sx: number, sy: number): number {
        for (let i = 0; i < this.#vertices.length; i++) {
            const [vsx, vsy] = this.#worldToScreen(...this.#vertices[i])
            if (Math.hypot(sx - vsx, sy - vsy) <= 8) return i
        }
        return -1
    }

    #findEdgeAt(sx: number, sy: number): number {
        if (this.#vertices.length < 2) return -1

        const n = this.#vertices.length
        let bestDist = Infinity
        let bestEdge = -1

        const edgeCount = this.#mode === "edit" ? n : n - 1
        for (let i = 0; i < edgeCount; i++) {
            const j = (i + 1) % n
            const [ax, ay] = this.#worldToScreen(...this.#vertices[i])
            const [bx, by] = this.#worldToScreen(...this.#vertices[j])
            const dist = this.#pointToSegmentDist(sx, sy, ax, ay, bx, by)
            if (dist < bestDist) {
                bestDist = dist
                bestEdge = i
            }
        }

        return bestDist <= 6 ? bestEdge : -1
    }

    #pointToSegmentDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
        const dx = bx - ax
        const dy = by - ay
        const lenSq = dx * dx + dy * dy
        if (lenSq === 0) return Math.hypot(px - ax, py - ay)

        let t = ((px - ax) * dx + (py - ay) * dy) / lenSq
        t = Math.max(0, Math.min(1, t))

        return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
    }

    // ── Mouse handlers ─────────────────────────────────────────────

    #onCanvasMouseDown = (e: MouseEvent) => {
        const sx = e.clientX - this.#canvasRect.left
        const sy = e.clientY - this.#canvasRect.top

        // Middle click or right click for panning
        if (e.button === 1 || e.button === 2) {
            this.#isPanning = true
            this.#panStartScreen = [e.clientX, e.clientY]
            this.#panStartOffset = [this.#panX, this.#panY]
            window.addEventListener("mousemove", this.#onDragMove)
            window.addEventListener("mouseup", this.#onDragEnd)
            e.preventDefault()
            return
        }

        if (e.button !== 0) return

        if (this.#mode === "new") {
            const [wx, wy] = this.#applySnap(...this.#screenToWorld(sx, sy))

            // Check if clicking near first vertex to close the polygon
            if (this.#vertices.length >= 3) {
                const [fsx, fsy] = this.#worldToScreen(...this.#vertices[0])
                if (Math.hypot(sx - fsx, sy - fsy) <= 5) {
                    this.#pushUndo()
                    this.#mode = "edit"
                    this.#selectedVertex = -1
                    this.#emitChange()
                    this.#draw()
                    this.#updateModeLabel()
                    this.#rebuildVertexList()
                    return
                }
            }

            this.#pushUndo()
            this.#vertices.push([wx, wy])
            this.#selectedVertex = this.#vertices.length - 1
            this.#emitChange()
            this.#draw()
            this.#rebuildVertexList()
            return
        }

        // Edit mode: check vertex hit
        const hitVertex = this.#findVertexAt(sx, sy)
        if (hitVertex >= 0) {
            this.#pushUndo()
            this.#selectedVertex = hitVertex
            this.#dragging = true
            this.#highlightSelectedRow()
            this.#draw()
            window.addEventListener("mousemove", this.#onDragMove)
            window.addEventListener("mouseup", this.#onDragEnd)
            return
        }

        // Check edge hit for splitting
        const hitEdge = this.#findEdgeAt(sx, sy)
        if (hitEdge >= 0) {
            this.#pushUndo()
            const [wx, wy] = this.#applySnap(...this.#screenToWorld(sx, sy))
            this.#vertices.splice(hitEdge + 1, 0, [wx, wy])
            this.#selectedVertex = hitEdge + 1
            this.#dragging = true
            this.#emitChange()
            this.#rebuildVertexList()
            this.#draw()
            window.addEventListener("mousemove", this.#onDragMove)
            window.addEventListener("mouseup", this.#onDragEnd)
            return
        }

        // Click on empty space — deselect
        this.#selectedVertex = -1
        this.#highlightSelectedRow()
        this.#draw()
    }

    #onCanvasMouseMove = (e: MouseEvent) => {
        if (this.#dragging || this.#isPanning) return

        const sx = e.clientX - this.#canvasRect.left
        const sy = e.clientY - this.#canvasRect.top
        const [wx, wy] = this.#screenToWorld(sx, sy)

        this.#mouseWorldX = wx
        this.#mouseWorldY = wy
        this.#mouseSX = sx
        this.#mouseSY = sy
        this.#mouseOnCanvas = true

        // Update cursor
        if (this.#mode === "edit") {
            if (this.#findVertexAt(sx, sy) >= 0) {
                this.#canvas.style.cursor = "grab"
            } else if (this.#findEdgeAt(sx, sy) >= 0) {
                this.#canvas.style.cursor = "crosshair"
            } else {
                this.#canvas.style.cursor = "default"
            }
        } else {
            this.#canvas.style.cursor = "crosshair"
        }

        if (this.#mode === "new") {
            this.#requestDraw()
        }
    }

    #onCanvasMouseLeave = () => {
        this.#mouseOnCanvas = false
        if (this.#mode === "new") {
            this.#requestDraw()
        }
    }

    #onDragMove = (e: MouseEvent) => {
        if (this.#isPanning) {
            const dx = (e.clientX - this.#panStartScreen[0]) / this.#zoom
            const dy = (e.clientY - this.#panStartScreen[1]) / this.#zoom
            this.#panX = this.#panStartOffset[0] - dx
            this.#panY = this.#panStartOffset[1] + dy
            this.#requestDraw()
            return
        }

        if (this.#dragging && this.#selectedVertex >= 0) {
            const sx = e.clientX - this.#canvasRect.left
            const sy = e.clientY - this.#canvasRect.top
            const [wx, wy] = this.#applySnap(...this.#screenToWorld(sx, sy))
            this.#vertices[this.#selectedVertex] = [wx, wy]
            this.#pendingInputUpdate = this.#selectedVertex
            this.#requestDraw()
        }
    }

    #onDragEnd = () => {
        const wasDragging = this.#dragging
        this.#dragging = false
        this.#isPanning = false
        window.removeEventListener("mousemove", this.#onDragMove)
        window.removeEventListener("mouseup", this.#onDragEnd)
        if (wasDragging) {
            this.#emitChange()
        }
    }

    #onWheel = (e: WheelEvent) => {
        e.preventDefault()
        const sx = e.clientX - this.#canvasRect.left
        const sy = e.clientY - this.#canvasRect.top

        const [wxBefore, wyBefore] = this.#screenToWorld(sx, sy)

        const factor = e.deltaY > 0 ? 0.9 : 1.1
        this.#zoom = Math.max(1, Math.min(2000, this.#zoom * factor))

        const [wxAfter, wyAfter] = this.#screenToWorld(sx, sy)
        this.#panX -= wxAfter - wxBefore
        this.#panY -= wyAfter - wyBefore

        this.#requestDraw()
    }

    // ── Keyboard handlers ──────────────────────────────────────────

    #onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
            this.#close()
            return
        }

        if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "z") {
            e.preventDefault()
            this.#redo()
            return
        }

        if ((e.metaKey || e.ctrlKey) && e.key === "z") {
            e.preventDefault()
            this.#undo()
            return
        }

        if (e.key === "Alt") {
            this.#altHeld = true
            e.preventDefault()
            return
        }

        if ((e.key === "Delete" || e.key === "Backspace") && this.#selectedVertex >= 0) {
            // Don't delete if a text input is focused
            if (this.#shadow.activeElement instanceof HTMLInputElement) return

            this.#pushUndo()
            this.#vertices.splice(this.#selectedVertex, 1)
            if (this.#vertices.length <= 2) {
                this.#mode = "new"
                this.#updateModeLabel()
            }
            this.#selectedVertex = Math.min(this.#selectedVertex, this.#vertices.length - 1)
            this.#emitChange()
            this.#draw()
            this.#rebuildVertexList()
        }
    }

    #onKeyUp = (e: KeyboardEvent) => {
        if (e.key === "Alt") {
            this.#altHeld = false
        }
    }

    // ── Vertex list ────────────────────────────────────────────────

    #rebuildVertexList() {
        this.#vertexList.innerHTML = ""

        for (let i = 0; i < this.#vertices.length; i++) {
            const row = document.createElement("div")
            row.className = "vertex-row"
            if (i === this.#selectedVertex) row.classList.add("selected")

            const label = document.createElement("span")
            label.className = "vertex-label"
            label.textContent = `V${i}`

            const xLabel = document.createElement("span")
            xLabel.className = "axis-label"
            xLabel.textContent = "X"

            const xInput = document.createElement("input")
            xInput.type = "number"
            xInput.step = "0.01"
            xInput.className = "vertex-input"
            xInput.value = String(Math.round(this.#vertices[i][0] * 100) / 100)

            const yLabel = document.createElement("span")
            yLabel.className = "axis-label"
            yLabel.textContent = "Y"

            const yInput = document.createElement("input")
            yInput.type = "number"
            yInput.step = "0.01"
            yInput.className = "vertex-input"
            yInput.value = String(Math.round(this.#vertices[i][1] * 100) / 100)

            row.append(label, xLabel, xInput, yLabel, yInput)

            const idx = i
            row.addEventListener("click", (e) => {
                if (e.target instanceof HTMLInputElement) return
                this.#selectedVertex = idx
                this.#draw()
                this.#highlightSelectedRow()
            })

            xInput.addEventListener("focus", () => this.#pushUndo())
            xInput.addEventListener("input", () => {
                const val = parseFloat(xInput.value)
                if (!isNaN(val)) {
                    this.#vertices[idx][0] = Math.round(val * 100) / 100
                    this.#emitChange()
                    this.#draw()
                }
            })

            yInput.addEventListener("focus", () => this.#pushUndo())
            yInput.addEventListener("input", () => {
                const val = parseFloat(yInput.value)
                if (!isNaN(val)) {
                    this.#vertices[idx][1] = Math.round(val * 100) / 100
                    this.#emitChange()
                    this.#draw()
                }
            })

            this.#vertexList.appendChild(row)
        }
    }

    #updateVertexInputs(idx: number) {
        const row = this.#vertexList.children[idx] as HTMLElement | undefined
        if (!row) return
        const inputs = row.querySelectorAll<HTMLInputElement>(".vertex-input")
        if (inputs.length >= 2) {
            inputs[0].value = String(Math.round(this.#vertices[idx][0] * 100) / 100)
            inputs[1].value = String(Math.round(this.#vertices[idx][1] * 100) / 100)
        }
    }

    #highlightSelectedRow() {
        const rows = this.#vertexList.querySelectorAll(".vertex-row")
        rows.forEach((row, i) => {
            row.classList.toggle("selected", i === this.#selectedVertex)
        })
    }

    // ── Undo / Redo ────────────────────────────────────────────────

    #pushUndo() {
        this.#undoStack.push(this.#vertices.map(v => [v[0], v[1]] as [number, number]))
        this.#redoStack.length = 0
    }

    #undo() {
        if (this.#undoStack.length === 0) return
        this.#redoStack.push(this.#vertices.map(v => [v[0], v[1]] as [number, number]))
        this.#vertices = this.#undoStack.pop()!
        this.#restoreState()
    }

    #redo() {
        if (this.#redoStack.length === 0) return
        this.#undoStack.push(this.#vertices.map(v => [v[0], v[1]] as [number, number]))
        this.#vertices = this.#redoStack.pop()!
        this.#restoreState()
    }

    #restoreState() {
        this.#mode = this.#vertices.length <= 2 ? "new" : "edit"
        this.#selectedVertex = Math.min(this.#selectedVertex, this.#vertices.length - 1)
        this.#emitChange()
        this.#draw()
        this.#rebuildVertexList()
        this.#updateModeLabel()
    }

    // ── Source sync ────────────────────────────────────────────────

    #emitChange() {
        this.#change$.next()
    }
}

customElements.define("polygon-editor", PolygonEditor)

declare global {
    interface HTMLElementTagNameMap {
        "polygon-editor": PolygonEditor
    }
}
