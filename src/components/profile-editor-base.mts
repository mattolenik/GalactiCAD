import { Subject, Subscription } from "rxjs"
import { debounceTime } from "rxjs/operators"
import { __fg_color, __tone_1, __tone_2, __tone_3, __tone_accent, __bg_color_dark } from "../style/style.mjs"

/**
 * Shared 2D profile-editor scaffolding for {@link PolygonEditor} (straight-edge
 * polygons) and the curve-aware path editor. Owns the model-agnostic machinery —
 * canvas chrome, pan/zoom/grid, coordinate transforms, snapping, rAF draw
 * batching, undo/redo, and the debounced source-sync pipeline — and delegates
 * the model-specific parts (drawing, hit-testing, the side list, undo snapshots)
 * to abstract hooks. Subclasses define a custom element and own their typed
 * `onChange` payload.
 *
 * @typeParam TState the undo/redo snapshot type (e.g. a vertex or element array).
 */
export abstract class Profile2DEditorBase<TState> extends HTMLElement {
    protected shadow = this.attachShadow({ mode: "open" })
    #ac = new AbortController()

    // View transform
    protected panX = 0
    protected panY = 0
    protected zoom = 40
    protected isPanning = false
    #panStartScreen: [number, number] = [0, 0]
    #panStartOffset: [number, number] = [0, 0]

    // Mouse tracking (world + screen + on-canvas)
    protected mouseWorldX = 0
    protected mouseWorldY = 0
    protected mouseSX = 0
    protected mouseSY = 0
    protected mouseOnCanvas = false

    // rAF draw batching
    #drawPending = false
    /** List-row index whose inputs should refresh after the next draw, or -1. */
    protected pendingInputUpdate = -1
    #canvasRect: DOMRect = new DOMRect()

    // Canvas sizing (CSS pixels)
    protected canvasW = 0
    protected canvasH = 0

    // Grid + snap
    protected gridSize = 1
    protected snapEnabled = false
    protected altHeld = false

    // DOM references
    protected canvas: HTMLCanvasElement
    protected ctx: CanvasRenderingContext2D
    protected listEl: HTMLDivElement
    #snapCheckbox: HTMLInputElement
    #gridSizeInput: HTMLInputElement
    #modeLabel: HTMLSpanElement

    // Undo/redo (snapshots provided by the subclass)
    #undoStack: TState[] = []
    #redoStack: TState[] = []

    // Per-drag AbortController for mousemove/mouseup cleanup
    protected dragAc: AbortController | null = null

    // Source sync
    #change$ = new Subject<void>()
    #changeSub: Subscription
    onClose?: () => void

    // ── Subclass hooks ─────────────────────────────────────────────

    /** Title shown in the editor titlebar. */
    protected abstract get editorTitle(): string
    /** Points the auto-fit framing should enclose (world space). */
    protected abstract fitPoints(): [number, number][]
    /** Status-bar instruction text for the current mode. */
    protected abstract modeLabelText(): string
    /** Draw the model (edges/curves/handles/vertices) over the grid. */
    protected abstract drawContent(): void
    /** Primary (left) mouse-down at canvas-space (sx, sy). */
    protected abstract onPrimaryDown(sx: number, sy: number, e: MouseEvent): void
    /** Hover move (not dragging/panning) at canvas-space (sx, sy): update cursor / redraw. */
    protected abstract onHoverMove(sx: number, sy: number): void
    /** Mouse left the canvas (not dragging). */
    protected abstract onHoverLeave(): void
    /** Model drag step (a vertex/handle drag is active). */
    protected abstract onDragMoveModel(e: MouseEvent): void
    /** Model drag finished. */
    protected abstract onDragEndModel(): void
    /** Delete/Backspace pressed with no text input focused. */
    protected abstract onDeleteKey(): void
    /** Rebuild the side list from the model. */
    protected abstract rebuildList(): void
    /** Refresh just the inputs of one list row (cheap drag update). */
    protected abstract updateListInputs(idx: number): void
    /** Deep-copy the current model state for the undo stack. */
    protected abstract snapshot(): TState
    /** Replace the model with a snapshot (during undo/redo). */
    protected abstract applySnapshot(state: TState): void
    /** Recompute derived state (mode, selection clamp) after an undo/redo restore. */
    protected abstract afterRestore(): void
    /** Push the current model to the subclass's typed `onChange`. */
    protected abstract emitChangePayload(): void

    constructor() {
        super()
        this.shadow.innerHTML = `
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
                    padding: 10px 16px;
                    background: var(${__tone_3});
                    font-size: 16px;
                    font-weight: 600;
                    user-select: none;
                    -webkit-user-select: none;
                }
                .close-btn {
                    background: none;
                    border: none;
                    color: var(${__fg_color});
                    font-size: 24px;
                    cursor: pointer;
                    padding: 0 8px;
                    border-radius: 4px;
                    line-height: 1;
                }
                .close-btn:hover {
                    background: rgb(from var(${__fg_color}) r g b / 0.1);
                }
                .canvas-container {
                    flex: 1;
                    min-height: 0;
                    position: relative;
                    background: var(--preview-bg, #1a1a1a);
                }
                canvas {
                    width: 100%;
                    height: 100%;
                    display: block;
                }
                .status-bar {
                    padding: 8px 16px;
                    display: flex;
                    align-items: center;
                    background: var(${__tone_2});
                    border-top: 1px solid var(${__tone_3});
                    font-size: 14px;
                    color: var(${__tone_1});
                }
                .bottom-panel {
                    display: flex;
                    border-top: 1px solid var(${__tone_3});
                    max-height: 180px;
                }
                .item-list {
                    flex: 1;
                    min-width: 0;
                    overflow-y: auto;
                    scrollbar-width: thin;
                }
                .prefs-pane {
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                    padding: 10px 16px;
                    border-left: 1px solid var(${__tone_3});
                    font-size: 15px;
                    user-select: none;
                    -webkit-user-select: none;
                    white-space: nowrap;
                }
                .prefs-pane label {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    cursor: pointer;
                    font-size: 14px;
                    color: var(${__tone_1});
                }
                .prefs-pane input[type="checkbox"] {
                    accent-color: var(${__tone_accent});
                    width: 16px;
                    height: 16px;
                }
                .item-row {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    padding: 6px 16px;
                    font-size: 15px;
                    cursor: pointer;
                    user-select: none;
                    -webkit-user-select: none;
                }
                .item-row:hover {
                    background: rgb(from var(${__fg_color}) r g b / 0.04);
                }
                .item-row.selected {
                    background: color-mix(in srgb, var(${__tone_accent}) 15%, transparent);
                }
                .item-label {
                    width: 32px;
                    font-family: monospace;
                    font-size: 13px;
                    color: var(${__tone_1});
                }
                .axis-label {
                    font-family: monospace;
                    font-size: 13px;
                    color: var(${__tone_1});
                }
                .item-input {
                    width: 80px;
                    background: var(${__bg_color_dark});
                    color: var(${__fg_color});
                    border: 1px solid var(${__tone_3});
                    border-radius: 3px;
                    padding: 4px 8px;
                    font-size: 15px;
                    font-family: monospace;
                }
                .item-input:focus {
                    outline: none;
                    border-color: var(${__tone_accent});
                }
                .grid-size-input {
                    width: 60px;
                    background: var(${__bg_color_dark});
                    color: var(${__fg_color});
                    border: 1px solid var(${__tone_3});
                    border-radius: 3px;
                    padding: 4px 8px;
                    font-size: 15px;
                    font-family: monospace;
                    text-align: right;
                }
                .grid-size-input:focus {
                    outline: none;
                    border-color: var(${__tone_accent});
                }
            </style>
            <div class="titlebar">
                <span class="title"></span>
                <button class="close-btn">×</button>
            </div>
            <div class="canvas-container">
                <canvas></canvas>
            </div>
            <div class="status-bar">
                <span class="mode-label"></span>
            </div>
            <div class="bottom-panel">
                <div class="item-list"></div>
                <div class="prefs-pane">
                    <label>
                        <input type="checkbox" class="snap-checkbox">
                        Snap to grid
                    </label>
                    <label>
                        Grid size
                        <input type="number" class="grid-size-input" value="1" min="1" step="1">
                    </label>
                </div>
            </div>
        `

        this.canvas = this.shadow.querySelector("canvas")!
        this.ctx = this.canvas.getContext("2d", { alpha: false })!
        this.listEl = this.shadow.querySelector(".item-list")!
        this.#snapCheckbox = this.shadow.querySelector<HTMLInputElement>(".snap-checkbox")!
        this.#gridSizeInput = this.shadow.querySelector<HTMLInputElement>(".grid-size-input")!
        this.#modeLabel = this.shadow.querySelector(".mode-label")!

        // Wire UI events
        this.shadow.querySelector(".close-btn")!.addEventListener("click", () => this.close())
        this.#snapCheckbox.addEventListener("change", () => {
            this.snapEnabled = this.#snapCheckbox.checked
        })
        this.#gridSizeInput.addEventListener("input", () => {
            const val = Math.round(parseFloat(this.#gridSizeInput.value))
            if (!isNaN(val) && val >= 1) {
                this.gridSize = val
                this.requestDraw()
            }
        })

        // Canvas events
        this.canvas.addEventListener("mousedown", this.#onCanvasMouseDown)
        this.canvas.addEventListener("mousemove", this.#onCanvasMouseMove)
        this.canvas.addEventListener("mouseleave", this.#onCanvasMouseLeave)
        this.canvas.addEventListener("wheel", this.#onWheel, { passive: false })
        this.canvas.addEventListener("contextmenu", e => e.preventDefault())

        // Debounced source sync
        this.#changeSub = this.#change$.pipe(debounceTime(300)).subscribe(() => {
            this.emitChangePayload()
        })
    }

    /** Subclasses call this at the end of their constructor (after model fields are set). */
    protected initChrome() {
        this.shadow.querySelector(".title")!.textContent = this.editorTitle
        this.updateModeLabel()
        this.rebuildList()
    }

    connectedCallback() {
        this.#ac = new AbortController()
        const { signal } = this.#ac

        window.addEventListener("keydown", this.#onKeyDown, { signal })
        window.addEventListener("keyup", this.#onKeyUp, { signal })

        // Size canvas and render after layout
        requestAnimationFrame(() => {
            this.#resizeCanvas()
            this.autoFit()
            this.draw()
        })

        // Handle canvas resize
        const ro = new ResizeObserver(() => {
            this.#resizeCanvas()
            this.draw()
        })
        ro.observe(this.canvas)
        signal.addEventListener("abort", () => ro.disconnect())
    }

    disconnectedCallback() {
        this.#ac.abort()
        this.dragAc?.abort()
        this.#changeSub.unsubscribe()
    }

    protected close() {
        if (!this.isConnected) return
        // Flush final state
        this.emitChangePayload()
        this.#changeSub.unsubscribe()
        this.onClose?.()
        this.remove()
    }

    // ── Canvas sizing ──────────────────────────────────────────────

    #resizeCanvas() {
        this.#canvasRect = this.canvas.getBoundingClientRect()
        const dpr = devicePixelRatio || 1
        this.canvasW = this.#canvasRect.width
        this.canvasH = this.#canvasRect.height
        this.canvas.width = this.#canvasRect.width * dpr
        this.canvas.height = this.#canvasRect.height * dpr
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    protected autoFit() {
        const pts = this.fitPoints()
        if (pts.length === 0) {
            this.panX = 0
            this.panY = 0
            this.zoom = 40
            return
        }

        let minX = Infinity, maxX = -Infinity
        let minY = Infinity, maxY = -Infinity
        for (const [x, y] of pts) {
            minX = Math.min(minX, x)
            maxX = Math.max(maxX, x)
            minY = Math.min(minY, y)
            maxY = Math.max(maxY, y)
        }

        this.panX = (minX + maxX) / 2
        this.panY = (minY + maxY) / 2

        const spanX = maxX - minX || 10
        const spanY = maxY - minY || 10
        const margin = 1.4
        this.zoom = Math.min(
            this.canvasW / (spanX * margin),
            this.canvasH / (spanY * margin)
        )
        this.zoom = Math.max(1, Math.min(2000, this.zoom))
    }

    protected updateModeLabel() {
        this.#modeLabel.textContent = this.modeLabelText()
    }

    // ── Coordinate transforms ──────────────────────────────────────

    protected worldToScreen(wx: number, wy: number): [number, number] {
        return [
            (wx - this.panX) * this.zoom + this.canvasW / 2,
            -(wy - this.panY) * this.zoom + this.canvasH / 2
        ]
    }

    protected screenToWorld(sx: number, sy: number): [number, number] {
        return [
            (sx - this.canvasW / 2) / this.zoom + this.panX,
            -(sy - this.canvasH / 2) / this.zoom + this.panY
        ]
    }

    protected applySnap(wx: number, wy: number): [number, number] {
        const shouldSnap = this.snapEnabled !== this.altHeld
        if (shouldSnap) {
            const gs = this.gridSize
            return [Math.round(wx / gs) * gs, Math.round(wy / gs) * gs]
        }
        return [Math.round(wx * 100) / 100, Math.round(wy * 100) / 100]
    }

    // ── Drawing ────────────────────────────────────────────────────

    protected requestDraw() {
        if (this.#drawPending) return
        this.#drawPending = true
        requestAnimationFrame(() => {
            this.#drawPending = false
            this.draw()
            if (this.pendingInputUpdate >= 0) {
                this.updateListInputs(this.pendingInputUpdate)
                this.pendingInputUpdate = -1
            }
        })
    }

    protected draw() {
        const w = this.canvasW
        const h = this.canvasH
        if (w === 0 || h === 0) return

        this.ctx.clearRect(0, 0, w, h)
        this.#drawGrid()
        this.drawContent()
    }

    #drawGrid() {
        const ctx = this.ctx
        const w = this.canvasW
        const h = this.canvasH
        const gs = this.gridSize

        const pxPerCell = this.zoom * gs
        const majorMult = 10
        const majorStep = gs * majorMult

        const [wLeft, wTop] = this.screenToWorld(0, 0)
        const [wRight, wBottom] = this.screenToWorld(w, h)
        const minWX = Math.min(wLeft, wRight)
        const maxWX = Math.max(wLeft, wRight)
        const minWY = Math.min(wTop, wBottom)
        const maxWY = Math.max(wTop, wBottom)

        // Minor grid lines at gridSize interval
        if (pxPerCell >= 4) {
            const alpha = pxPerCell >= 15 ? 0.16
                : 0.16 * (pxPerCell - 4) / 11
            ctx.strokeStyle = `rgba(255, 255, 255, ${alpha.toFixed(4)})`
            ctx.lineWidth = 0.5
            ctx.beginPath()

            const startX = Math.floor(minWX / gs) * gs
            const endX = Math.ceil(maxWX / gs) * gs
            const startY = Math.floor(minWY / gs) * gs
            const endY = Math.ceil(maxWY / gs) * gs

            for (let x = startX; x <= endX; x += gs) {
                if (Math.abs(x) < gs * 0.01) continue
                if (Math.abs(x % majorStep) < gs * 0.01) continue
                const [sx] = this.worldToScreen(x, 0)
                ctx.moveTo(sx, 0)
                ctx.lineTo(sx, h)
            }
            for (let y = startY; y <= endY; y += gs) {
                if (Math.abs(y) < gs * 0.01) continue
                if (Math.abs(y % majorStep) < gs * 0.01) continue
                const [, sy] = this.worldToScreen(0, y)
                ctx.moveTo(0, sy)
                ctx.lineTo(w, sy)
            }
            ctx.stroke()
        }

        // Major grid lines at gridSize * 10 interval
        ctx.strokeStyle = "rgba(255, 255, 255, 0.22)"
        ctx.lineWidth = 1
        ctx.beginPath()
        const majorStartX = Math.floor(minWX / majorStep) * majorStep
        const majorEndX = Math.ceil(maxWX / majorStep) * majorStep
        const majorStartY = Math.floor(minWY / majorStep) * majorStep
        const majorEndY = Math.ceil(maxWY / majorStep) * majorStep
        for (let x = majorStartX; x <= majorEndX; x += majorStep) {
            if (Math.abs(x) < gs * 0.01) continue
            const [sx] = this.worldToScreen(x, 0)
            ctx.moveTo(sx, 0)
            ctx.lineTo(sx, h)
        }
        for (let y = majorStartY; y <= majorEndY; y += majorStep) {
            if (Math.abs(y) < gs * 0.01) continue
            const [, sy] = this.worldToScreen(0, y)
            ctx.moveTo(0, sy)
            ctx.lineTo(w, sy)
        }
        ctx.stroke()

        // Axis lines
        ctx.strokeStyle = "rgba(255, 255, 255, 0.3)"
        ctx.lineWidth = 1
        ctx.beginPath()
        const [ox, oy] = this.worldToScreen(0, 0)
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

    protected pointToSegmentDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
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
            this.isPanning = true
            this.#panStartScreen = [e.clientX, e.clientY]
            this.#panStartOffset = [this.panX, this.panY]
            this.beginDrag()
            e.preventDefault()
            return
        }

        if (e.button !== 0) return
        this.onPrimaryDown(sx, sy, e)
    }

    #onCanvasMouseMove = (e: MouseEvent) => {
        if (this.isDragging() || this.isPanning) return

        const sx = e.clientX - this.#canvasRect.left
        const sy = e.clientY - this.#canvasRect.top
        const [wx, wy] = this.screenToWorld(sx, sy)

        this.mouseWorldX = wx
        this.mouseWorldY = wy
        this.mouseSX = sx
        this.mouseSY = sy
        this.mouseOnCanvas = true

        this.onHoverMove(sx, sy)
    }

    #onCanvasMouseLeave = () => {
        this.mouseOnCanvas = false
        this.onHoverLeave()
    }

    #onDragMove = (e: MouseEvent) => {
        if (this.isPanning) {
            const dx = (e.clientX - this.#panStartScreen[0]) / this.zoom
            const dy = (e.clientY - this.#panStartScreen[1]) / this.zoom
            this.panX = this.#panStartOffset[0] - dx
            this.panY = this.#panStartOffset[1] + dy
            this.requestDraw()
            return
        }
        this.onDragMoveModel(e)
    }

    #onDragEnd = () => {
        const wasPanning = this.isPanning
        this.isPanning = false
        this.dragAc?.abort()
        this.dragAc = null
        if (!wasPanning) this.onDragEndModel()
    }

    /** Drag-relative screen coords from a mouse event (for use inside onDragMoveModel). */
    protected dragScreenCoords(e: MouseEvent): [number, number] {
        return [e.clientX - this.#canvasRect.left, e.clientY - this.#canvasRect.top]
    }

    /** Wire window mousemove/mouseup for an active drag (pan or model). */
    protected beginDrag() {
        this.dragAc = new AbortController()
        const { signal } = this.dragAc
        window.addEventListener("mousemove", this.#onDragMove, { signal })
        window.addEventListener("mouseup", this.#onDragEnd, { signal })
        // Modifier keys pressed/released *during* a drag (without mouse movement)
        // need to re-run the drag step so e.g. Alt-break takes effect immediately.
        window.addEventListener("keydown", this.#onDragKey, { signal })
        window.addEventListener("keyup", this.#onDragKey, { signal })
    }

    #onDragKey = (e: KeyboardEvent) => {
        if (!this.isPanning) this.onModifierChange(e)
    }

    /** A modifier key changed during an active model drag. Default: no-op. */
    protected onModifierChange(_e: KeyboardEvent): void {}

    /** Subclass hook for editor-specific keys; return true if the key was handled. */
    protected onEditorKey(_e: KeyboardEvent): boolean { return false }

    /** Whether a model drag (not pan) is in progress — drives hover suppression. */
    protected abstract isDragging(): boolean

    #onWheel = (e: WheelEvent) => {
        e.preventDefault()
        const sx = e.clientX - this.#canvasRect.left
        const sy = e.clientY - this.#canvasRect.top

        const [wxBefore, wyBefore] = this.screenToWorld(sx, sy)

        const factor = e.deltaY > 0 ? 0.9 : 1.1
        this.zoom = Math.max(1, Math.min(2000, this.zoom * factor))

        const [wxAfter, wyAfter] = this.screenToWorld(sx, sy)
        this.panX -= wxAfter - wxBefore
        this.panY -= wyAfter - wyBefore

        this.requestDraw()
    }

    // ── Keyboard handlers ──────────────────────────────────────────

    #onKeyDown = (e: KeyboardEvent) => {
        // Let the subclass claim editor-specific keys first (e.g. node-type keys).
        if (this.onEditorKey(e)) {
            e.preventDefault()
            return
        }

        if (e.key === "Escape") {
            this.close()
            return
        }

        if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "z") {
            e.preventDefault()
            this.redo()
            return
        }

        if ((e.metaKey || e.ctrlKey) && e.key === "z") {
            e.preventDefault()
            this.undo()
            return
        }

        if (e.key === "Alt") {
            this.altHeld = true
            e.preventDefault()
            return
        }

        if (e.key === "Delete" || e.key === "Backspace") {
            // Don't delete if a text input is focused
            if (this.shadow.activeElement instanceof HTMLInputElement) return
            this.onDeleteKey()
        }
    }

    #onKeyUp = (e: KeyboardEvent) => {
        if (e.key === "Alt") {
            this.altHeld = false
        }
    }

    // ── Side list helpers ──────────────────────────────────────────

    protected highlightSelectedRow(selectedIndex: number) {
        const rows = this.listEl.querySelectorAll(".item-row")
        rows.forEach((row, i) => {
            row.classList.toggle("selected", i === selectedIndex)
        })
    }

    // ── Undo / Redo ────────────────────────────────────────────────

    protected pushUndo() {
        this.#undoStack.push(this.snapshot())
        this.#redoStack.length = 0
    }

    protected undo() {
        if (this.#undoStack.length === 0) return
        this.#redoStack.push(this.snapshot())
        this.applySnapshot(this.#undoStack.pop()!)
        this.#restoreState()
    }

    protected redo() {
        if (this.#redoStack.length === 0) return
        this.#undoStack.push(this.snapshot())
        this.applySnapshot(this.#redoStack.pop()!)
        this.#restoreState()
    }

    #restoreState() {
        this.afterRestore()
        this.emitChange()
        this.draw()
        this.rebuildList()
        this.updateModeLabel()
    }

    // ── Source sync ────────────────────────────────────────────────

    protected emitChange() {
        this.#change$.next()
    }
}
