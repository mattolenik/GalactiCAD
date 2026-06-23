import { Profile2DEditorBase } from "./profile-editor-base.mjs"

/**
 * Straight-edge polygon editor for `polygon2d(...)`. The model is a flat list of
 * `[x, y]` vertices; edges are straight. Shared canvas/pan/zoom/grid/undo/source-
 * sync machinery lives in {@link Profile2DEditorBase}.
 */
export class PolygonEditor extends Profile2DEditorBase<[number, number][]> {
    #vertices: [number, number][]
    #mode: "new" | "edit"
    #selectedVertex = -1
    #dragging = false

    onChange?: (vertices: [number, number][]) => void

    constructor(vertices: [number, number][]) {
        super()
        this.#vertices = vertices.map(v => [v[0], v[1]] as [number, number])
        this.#mode = vertices.length <= 2 ? "new" : "edit"
        this.initChrome()
    }

    protected get editorTitle(): string { return "Polygon Editor" }

    protected fitPoints(): [number, number][] { return this.#vertices }

    protected modeLabelText(): string {
        return this.#mode === "new"
            ? "Click to place vertices • click first vertex to close"
            : "Drag vertices • click edge to split • Delete to remove"
    }

    protected isDragging(): boolean { return this.#dragging }

    // ── Drawing ────────────────────────────────────────────────────

    protected drawContent() {
        this.#drawEdges()
        this.#drawPreviewLine()
        this.#drawVertices()
    }

    #drawEdges() {
        const ctx = this.ctx
        if (this.#vertices.length < 2) return

        ctx.strokeStyle = "#0af"
        ctx.lineWidth = 2
        ctx.beginPath()

        const [fx, fy] = this.worldToScreen(...this.#vertices[0])
        ctx.moveTo(fx, fy)

        for (let i = 1; i < this.#vertices.length; i++) {
            const [sx, sy] = this.worldToScreen(...this.#vertices[i])
            ctx.lineTo(sx, sy)
        }

        if (this.#mode === "edit" && this.#vertices.length >= 3) {
            ctx.closePath()
        }

        ctx.stroke()
    }

    #drawPreviewLine() {
        if (this.#mode !== "new" || this.#vertices.length === 0 || !this.mouseOnCanvas) return

        const ctx = this.ctx
        const last = this.#vertices[this.#vertices.length - 1]
        const [sx, sy] = this.worldToScreen(...last)
        const [mx, my] = this.worldToScreen(this.mouseWorldX, this.mouseWorldY)

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
        const ctx = this.ctx

        for (let i = 0; i < this.#vertices.length; i++) {
            const [wx, wy] = this.#vertices[i]
            const [sx, sy] = this.worldToScreen(wx, wy)

            // Highlight close-able first vertex in new mode
            const isCloseTarget = i === 0 && this.#mode === "new"
                && this.#vertices.length >= 3 && this.mouseOnCanvas
                && Math.hypot(this.mouseSX - sx, this.mouseSY - sy) <= 10

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
            const [vsx, vsy] = this.worldToScreen(...this.#vertices[i])
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
            const [ax, ay] = this.worldToScreen(...this.#vertices[i])
            const [bx, by] = this.worldToScreen(...this.#vertices[j])
            const dist = this.pointToSegmentDist(sx, sy, ax, ay, bx, by)
            if (dist < bestDist) {
                bestDist = dist
                bestEdge = i
            }
        }

        return bestDist <= 6 ? bestEdge : -1
    }

    // ── Interaction ────────────────────────────────────────────────

    protected onPrimaryDown(sx: number, sy: number) {
        if (this.#mode === "new") {
            const [wx, wy] = this.applySnap(...this.screenToWorld(sx, sy))

            // Check if clicking near first vertex to close the polygon
            if (this.#vertices.length >= 3) {
                const [fsx, fsy] = this.worldToScreen(...this.#vertices[0])
                if (Math.hypot(sx - fsx, sy - fsy) <= 5) {
                    this.pushUndo()
                    this.#mode = "edit"
                    this.#selectedVertex = -1
                    this.emitChange()
                    this.draw()
                    this.updateModeLabel()
                    this.rebuildList()
                    return
                }
            }

            this.pushUndo()
            this.#vertices.push([wx, wy])
            this.#selectedVertex = this.#vertices.length - 1
            this.emitChange()
            this.draw()
            this.rebuildList()
            return
        }

        // Edit mode: check vertex hit
        const hitVertex = this.#findVertexAt(sx, sy)
        if (hitVertex >= 0) {
            this.pushUndo()
            this.#selectedVertex = hitVertex
            this.#dragging = true
            this.highlightSelectedRow(this.#selectedVertex)
            this.draw()
            this.beginDrag()
            return
        }

        // Check edge hit for splitting
        const hitEdge = this.#findEdgeAt(sx, sy)
        if (hitEdge >= 0) {
            this.pushUndo()
            const [wx, wy] = this.applySnap(...this.screenToWorld(sx, sy))
            this.#vertices.splice(hitEdge + 1, 0, [wx, wy])
            this.#selectedVertex = hitEdge + 1
            this.#dragging = true
            this.emitChange()
            this.rebuildList()
            this.draw()
            this.beginDrag()
            return
        }

        // Click on empty space — deselect
        this.#selectedVertex = -1
        this.highlightSelectedRow(this.#selectedVertex)
        this.draw()
    }

    protected onHoverMove(sx: number, sy: number) {
        if (this.#mode === "edit") {
            if (this.#findVertexAt(sx, sy) >= 0) {
                this.canvas.style.cursor = "grab"
            } else if (this.#findEdgeAt(sx, sy) >= 0) {
                this.canvas.style.cursor = "crosshair"
            } else {
                this.canvas.style.cursor = "default"
            }
        } else {
            this.canvas.style.cursor = "crosshair"
        }

        if (this.#mode === "new") {
            this.requestDraw()
        }
    }

    protected onHoverLeave() {
        if (this.#mode === "new") {
            this.requestDraw()
        }
    }

    protected onDragMoveModel(e: MouseEvent) {
        if (this.#dragging && this.#selectedVertex >= 0) {
            const [sx, sy] = this.dragScreenCoords(e)
            const [wx, wy] = this.applySnap(...this.screenToWorld(sx, sy))
            this.#vertices[this.#selectedVertex] = [wx, wy]
            this.pendingInputUpdate = this.#selectedVertex
            this.requestDraw()
        }
    }

    protected onDragEndModel() {
        if (this.#dragging) {
            this.#dragging = false
            this.emitChange()
        }
    }

    protected onDeleteKey() {
        if (this.#selectedVertex < 0) return

        this.pushUndo()
        this.#vertices.splice(this.#selectedVertex, 1)
        if (this.#vertices.length <= 2) {
            this.#mode = "new"
            this.updateModeLabel()
        }
        this.#selectedVertex = Math.min(this.#selectedVertex, this.#vertices.length - 1)
        this.emitChange()
        this.draw()
        this.rebuildList()
    }

    // ── Vertex list ────────────────────────────────────────────────

    protected rebuildList() {
        this.listEl.innerHTML = ""

        for (let i = 0; i < this.#vertices.length; i++) {
            const row = document.createElement("div")
            row.className = "item-row"
            if (i === this.#selectedVertex) row.classList.add("selected")

            const label = document.createElement("span")
            label.className = "item-label"
            label.textContent = `V${i}`

            const xLabel = document.createElement("span")
            xLabel.className = "axis-label"
            xLabel.textContent = "X"

            const xInput = document.createElement("input")
            xInput.type = "number"
            xInput.step = "0.01"
            xInput.className = "item-input"
            xInput.value = String(Math.round(this.#vertices[i][0] * 100) / 100)

            const yLabel = document.createElement("span")
            yLabel.className = "axis-label"
            yLabel.textContent = "Y"

            const yInput = document.createElement("input")
            yInput.type = "number"
            yInput.step = "0.01"
            yInput.className = "item-input"
            yInput.value = String(Math.round(this.#vertices[i][1] * 100) / 100)

            row.append(label, xLabel, xInput, yLabel, yInput)

            const idx = i
            row.addEventListener("click", (e) => {
                if (e.target instanceof HTMLInputElement) return
                this.#selectedVertex = idx
                this.draw()
                this.highlightSelectedRow(this.#selectedVertex)
            })

            xInput.addEventListener("focus", () => this.pushUndo())
            xInput.addEventListener("input", () => {
                const val = parseFloat(xInput.value)
                if (!isNaN(val)) {
                    this.#vertices[idx][0] = Math.round(val * 100) / 100
                    this.emitChange()
                    this.draw()
                }
            })

            yInput.addEventListener("focus", () => this.pushUndo())
            yInput.addEventListener("input", () => {
                const val = parseFloat(yInput.value)
                if (!isNaN(val)) {
                    this.#vertices[idx][1] = Math.round(val * 100) / 100
                    this.emitChange()
                    this.draw()
                }
            })

            this.listEl.appendChild(row)
        }
    }

    protected updateListInputs(idx: number) {
        const row = this.listEl.children[idx] as HTMLElement | undefined
        if (!row) return
        const inputs = row.querySelectorAll<HTMLInputElement>(".item-input")
        if (inputs.length >= 2) {
            inputs[0].value = String(Math.round(this.#vertices[idx][0] * 100) / 100)
            inputs[1].value = String(Math.round(this.#vertices[idx][1] * 100) / 100)
        }
    }

    // ── Undo / source-sync hooks ───────────────────────────────────

    protected snapshot(): [number, number][] {
        return this.#vertices.map(v => [v[0], v[1]] as [number, number])
    }

    protected applySnapshot(state: [number, number][]) {
        this.#vertices = state
    }

    protected afterRestore() {
        this.#mode = this.#vertices.length <= 2 ? "new" : "edit"
        this.#selectedVertex = Math.min(this.#selectedVertex, this.#vertices.length - 1)
    }

    protected emitChangePayload() {
        this.onChange?.(this.#vertices.map(v => [v[0], v[1]] as [number, number]))
    }
}

customElements.define("polygon-editor", PolygonEditor)

declare global {
    interface HTMLElementTagNameMap {
        "polygon-editor": PolygonEditor
    }
}
