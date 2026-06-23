import { Profile2DEditorBase } from "./profile-editor-base.mjs"
import type { PathElement, Vec2 } from "../scene/primitives/path2d.mjs"
import {
    anchorEndpoints,
    anchorIndexOfRef,
    angleSnap,
    autoSmoothHandles,
    axisConstrain,
    ensureAnchorHandles,
    getAnchors,
    inferNodeType,
    isControlHandle,
    normalizeToType,
    parseNodeType,
    partnerHandle,
    partnerUpdate,
    type NodeType,
    type PointRef,
} from "./path2d-node-edit.mjs"

/** Hotkey → node type: 1 Sharp, 2 Smooth, 3 Symmetric, 4 Smart (Affinity-style). */
const NODE_TYPE_KEYS: Record<string, NodeType> = {
    "1": "cusp", "2": "smooth", "3": "symmetric", "4": "smart",
}

/** Undo snapshot: the authored elements plus the explicit node-type overrides. */
interface PathState {
    elements: PathElement[]
    overrides: [number, NodeType][]
}

/**
 * Curve-aware editor for `path2d(...)`. The model is the authored
 * {@link PathElement}[] — vertices `[x,y]` and 2/3/4-point bezier control
 * polygons. Every point (anchor endpoints *and* control handles) is draggable;
 * curves render as canvas beziers with their control tethers shown. Vertex↔
 * control conversion and click-to-add are deferred to a later revision.
 *
 * Shares all canvas/pan/zoom/grid/undo/source-sync machinery with the polygon
 * editor via {@link Profile2DEditorBase}.
 */
export class Path2DEditor extends Profile2DEditorBase<PathState> {
    #elements: PathElement[]
    #selected: PointRef | null = null
    #dragging = false

    // Active-drag context, captured on mouse-down so the node mode and partner
    // link stay stable for the whole drag instead of being re-inferred each
    // frame (which would let a cusp flip to smooth when passing through colinear).
    #dragKind: "handle" | "anchor" | null = null
    #dragMode: NodeType = "cusp"
    #dragLink: { partner: PointRef; anchor: Vec2 } | null = null
    #dragAnchor: { startAnchor: Vec2; refs: { ref: PointRef; start: Vec2 }[] } | null = null
    #dragHandleAnchor: Vec2 | null = null
    #lastDragScreen: [number, number] | null = null
    #mod = { alt: false, ctrl: false, meta: false, shift: false }

    /** Explicit per-anchor node type, keyed by anchor index (see getAnchors).
     *  Overrides geometry inference; re-inferred (cleared) on structural edits. */
    #nodeTypeOverride = new Map<number, NodeType>()

    /** Degrees per step for Ctrl/⌘ handle-angle snapping (dev knob). */
    angleSnapDeg = 15
    /** Catmull-Rom handle-length fraction for `smart`/auto nodes (dev knob). */
    autoK = 1 / 3
    /** `|sinθ|` tolerance for inferring a node as colinear (smooth/symmetric). */
    colinearEps = 0.05
    /** Relative tolerance for inferring two handle lengths as equal (symmetric). */
    equalLenEps = 0.02

    onChange?: (elements: PathElement[], nodeTypes: (NodeType | null)[]) => void

    constructor(elements: PathElement[], nodeTypes?: (string | null)[]) {
        super()
        this.#elements = cloneElements(elements)
        // Seed explicit node types persisted in the source (keyed by element/anchor index).
        if (nodeTypes) {
            for (let i = 0; i < nodeTypes.length; i++) {
                const t = parseNodeType(nodeTypes[i])
                if (t) this.#nodeTypeOverride.set(i, t)
            }
        }
        this.initChrome()
        this.#addEditorPrefs()
    }

    /** Append editor-specific knobs (angle-snap step) to the shared prefs pane. */
    #addEditorPrefs() {
        const pane = this.shadow.querySelector(".prefs-pane")
        if (!pane) return
        const label = document.createElement("label")
        label.textContent = "Angle snap °"
        const input = document.createElement("input")
        input.type = "number"
        input.className = "grid-size-input"
        input.min = "1"
        input.step = "1"
        input.value = String(this.angleSnapDeg)
        input.addEventListener("input", () => {
            const v = parseFloat(input.value)
            if (!isNaN(v) && v > 0) this.angleSnapDeg = v
        })
        label.appendChild(input)
        pane.appendChild(label)
    }

    protected get editorTitle(): string { return "Path Editor" }

    protected modeLabelText(): string {
        return "Drag anchors & handles • 1–4 node type (Sharp/Smooth/Symmetric/Smart) • "
            + "⌥ break · ⌃ angle-snap · ⇧ axis • Delete removes a segment"
    }

    protected isDragging(): boolean { return this.#dragging }

    protected fitPoints(): [number, number][] {
        const out: [number, number][] = []
        for (const el of this.#elements) for (const p of elPoints(el)) out.push([p[0], p[1]])
        return out
    }

    // ── Point access ───────────────────────────────────────────────

    #getPoint(ref: PointRef): Vec2 {
        const el = this.#elements[ref.ei]!
        return isVertex(el) ? (el as Vec2) : (el as Vec2[])[ref.pi]!
    }

    #setPoint(ref: PointRef, x: number, y: number) {
        const el = this.#elements[ref.ei]!
        if (isVertex(el)) {
            this.#elements[ref.ei] = [x, y]
        } else {
            (el as Vec2[])[ref.pi] = [x, y]
        }
    }

    /** Last point of an element = its anchor endpoint (what the list row edits). */
    #endpointRef(ei: number): PointRef {
        const el = this.#elements[ei]!
        return { ei, pi: isVertex(el) ? 0 : (el as Vec2[]).length - 1 }
    }

    // ── Drawing ────────────────────────────────────────────────────

    protected drawContent() {
        this.#drawPath()
        this.#drawControlTethers()
        this.#drawPoints()
    }

    #drawPath() {
        const ctx = this.ctx
        if (this.#elements.length === 0) return

        ctx.strokeStyle = "#0af"
        ctx.lineWidth = 2
        ctx.beginPath()

        let prevLast: Vec2 | null = null
        let firstPoint: Vec2 | null = null
        for (const el of this.#elements) {
            const pts = elPoints(el)
            if (!prevLast) {
                const [mx, my] = this.worldToScreen(pts[0]![0], pts[0]![1])
                ctx.moveTo(mx, my)
                firstPoint = pts[0]!
            } else if (!samePt(prevLast, pts[0]!)) {
                const [lx, ly] = this.worldToScreen(pts[0]![0], pts[0]![1])
                ctx.lineTo(lx, ly)   // implicit straight connector between elements
            }

            if (pts.length === 2) {
                const [x1, y1] = this.worldToScreen(pts[1]![0], pts[1]![1])
                ctx.lineTo(x1, y1)
            } else if (pts.length === 3) {
                const [cx, cy] = this.worldToScreen(pts[1]![0], pts[1]![1])
                const [x2, y2] = this.worldToScreen(pts[2]![0], pts[2]![1])
                ctx.quadraticCurveTo(cx, cy, x2, y2)
            } else if (pts.length === 4) {
                const [c1x, c1y] = this.worldToScreen(pts[1]![0], pts[1]![1])
                const [c2x, c2y] = this.worldToScreen(pts[2]![0], pts[2]![1])
                const [x3, y3] = this.worldToScreen(pts[3]![0], pts[3]![1])
                ctx.bezierCurveTo(c1x, c1y, c2x, c2y, x3, y3)
            }
            prevLast = pts[pts.length - 1]!
        }

        // Close the loop (matches Polygon2D's implicit closure).
        if (firstPoint && prevLast && !samePt(prevLast, firstPoint)) {
            const [fx, fy] = this.worldToScreen(firstPoint[0], firstPoint[1])
            ctx.lineTo(fx, fy)
        }
        ctx.stroke()
    }

    #drawControlTethers() {
        const ctx = this.ctx
        ctx.strokeStyle = "rgba(255, 170, 0, 0.55)"
        ctx.lineWidth = 1
        for (const el of this.#elements) {
            if (isVertex(el)) continue
            const pts = el as Vec2[]
            if (pts.length < 3) continue   // linear: no control handle
            // tether each interior control to its nearest endpoint
            const anchors: [Vec2, Vec2[]][] = pts.length === 3
                ? [[pts[0]!, [pts[1]!]], [pts[2]!, [pts[1]!]]]
                : [[pts[0]!, [pts[1]!]], [pts[3]!, [pts[2]!]]]
            for (const [anchor, controls] of anchors) {
                const [ax, ay] = this.worldToScreen(anchor[0], anchor[1])
                for (const c of controls) {
                    if (samePt(anchor, c)) continue   // retracted handle: not shown
                    const [cx, cy] = this.worldToScreen(c[0], c[1])
                    ctx.beginPath()
                    ctx.moveTo(ax, ay)
                    ctx.lineTo(cx, cy)
                    ctx.stroke()
                }
            }
        }
    }

    #drawPoints() {
        const ctx = this.ctx

        // Resolve each endpoint's node type once (anchors are drawn with a
        // type-specific glyph; control handles stay orange squares).
        const anchors = getAnchors(this.#elements)
        const typeByEndpoint = new Map<string, NodeType>()
        for (let ai = 0; ai < anchors.length; ai++) {
            const t = this.#anchorType(ai, anchors[ai]!)
            for (const r of anchors[ai]!.endpointRefs) typeByEndpoint.set(`${r.ei}:${r.pi}`, t)
        }

        for (let ei = 0; ei < this.#elements.length; ei++) {
            const el = this.#elements[ei]!
            const pts = elPoints(el)
            const n = pts.length
            for (let pi = 0; pi < n; pi++) {
                const [sx, sy] = this.worldToScreen(pts[pi]![0], pts[pi]![1])
                const isControl = !isVertex(el) && pi > 0 && pi < n - 1
                if (isControl && isRetractedControl(pts, pi, n)) continue   // retracted: not shown
                const selected = this.#selected?.ei === ei && this.#selected?.pi === pi

                if (isControl) {
                    ctx.beginPath()
                    ctx.rect(sx - 4, sy - 4, 8, 8)
                    ctx.fillStyle = selected ? "#007acc" : "#fa0"
                    ctx.fill()
                    ctx.strokeStyle = "#000"
                    ctx.lineWidth = 1.5
                    ctx.stroke()
                } else {
                    this.#drawAnchorGlyph(sx, sy, typeByEndpoint.get(`${ei}:${pi}`) ?? "cusp", selected)
                }
            }
        }
    }

    /** The current type of anchor `ai`: explicit override, else inferred geometry. */
    #anchorType(ai: number, a: ReturnType<typeof getAnchors>[number]): NodeType {
        const override = this.#nodeTypeOverride.get(ai)
        if (override) return override
        const inH = a.inHandle ? this.#getPoint(a.inHandle) : null
        const outH = a.outHandle ? this.#getPoint(a.outHandle) : null
        return inferNodeType(a.pos, inH, outH, this.colinearEps, this.equalLenEps)
    }

    /** Anchor glyph: cusp ◇ diamond, smooth ○ circle, symmetric ◎ haloed, smart ⊙ dotted. */
    #drawAnchorGlyph(sx: number, sy: number, type: NodeType, selected: boolean) {
        const ctx = this.ctx
        ctx.fillStyle = selected ? "#007acc" : "#fff"
        ctx.strokeStyle = "#000"
        ctx.lineWidth = 1.5

        if (type === "cusp") {
            ctx.beginPath()
            ctx.moveTo(sx, sy - 6)
            ctx.lineTo(sx + 6, sy)
            ctx.lineTo(sx, sy + 6)
            ctx.lineTo(sx - 6, sy)
            ctx.closePath()
            ctx.fill()
            ctx.stroke()
            return
        }

        ctx.beginPath()
        ctx.arc(sx, sy, 6, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()

        if (type === "symmetric") {
            ctx.beginPath()
            ctx.arc(sx, sy, 8.5, 0, Math.PI * 2)
            ctx.stroke()
        } else if (type === "smart") {
            ctx.beginPath()
            ctx.arc(sx, sy, 1.8, 0, Math.PI * 2)
            ctx.fillStyle = "#000"
            ctx.fill()
        }
    }

    // ── Hit testing ────────────────────────────────────────────────

    #findPointAt(sx: number, sy: number): PointRef | null {
        let best: PointRef | null = null
        let bestDist = 8
        for (let ei = 0; ei < this.#elements.length; ei++) {
            const pts = elPoints(this.#elements[ei]!)
            for (let pi = 0; pi < pts.length; pi++) {
                const [px, py] = this.worldToScreen(pts[pi]![0], pts[pi]![1])
                const d = Math.hypot(sx - px, sy - py)
                if (d <= bestDist) { bestDist = d; best = { ei, pi } }
            }
        }
        return best
    }

    // ── Interaction ────────────────────────────────────────────────

    protected onPrimaryDown(sx: number, sy: number) {
        const hit = this.#findPointAt(sx, sy)
        if (hit) {
            this.pushUndo()
            this.#selected = hit
            this.#dragging = true
            this.#beginPointDrag(hit)
            this.highlightSelectedRow(hit.ei)
            this.draw()
            this.beginDrag()
            return
        }
        this.#selected = null
        this.#dragKind = null
        this.highlightSelectedRow(-1)
        this.draw()
    }

    /**
     * Capture the drag context for the hit point: a control handle (with its
     * optional partner link + inferred node mode) or an anchor (a rigid move of
     * every coincident endpoint copy and its attached handles).
     */
    #beginPointDrag(hit: PointRef) {
        this.#mod = { alt: false, ctrl: false, meta: false, shift: false }
        this.#lastDragScreen = null
        if (isControlHandle(this.#elements, hit)) {
            this.#dragKind = "handle"
            this.#dragHandleAnchor = this.#handleAnchor(hit)
            this.#dragLink = partnerHandle(this.#elements, hit)
            if (this.#dragLink) {
                const ai = anchorIndexOfRef(this.#elements, hit)
                const override = ai != null ? this.#nodeTypeOverride.get(ai) : undefined
                const handlePos = this.#getPoint(hit)
                const partnerPos = this.#getPoint(this.#dragLink.partner)
                // Explicit type wins; otherwise infer from current handle geometry.
                this.#dragMode = override ?? inferNodeType(
                    this.#dragLink.anchor, handlePos, partnerPos, this.colinearEps, this.equalLenEps)
            } else {
                this.#dragMode = "cusp"
            }
        } else {
            this.#dragKind = "anchor"
            this.#dragHandleAnchor = null
            const { pos, pointRefs } = anchorEndpoints(this.#elements, hit)
            this.#dragAnchor = {
                startAnchor: pos,
                refs: pointRefs.map(ref => ({ ref, start: this.#getPoint(ref) })),
            }
        }
    }

    /** The element endpoint a control handle is anchored to (for angle snapping). */
    #handleAnchor(ref: PointRef): Vec2 {
        const pts = elPoints(this.#elements[ref.ei]!)
        return ref.pi === 1 ? pts[0]! : pts[pts.length - 1]!
    }

    protected onHoverMove(sx: number, sy: number) {
        this.canvas.style.cursor = this.#findPointAt(sx, sy) ? "grab" : "default"
    }

    protected onHoverLeave() { /* no rubber-band preview */ }

    protected onDragMoveModel(e: MouseEvent) {
        if (!this.#dragging || !this.#selected) return
        this.#readMods(e)
        const [sx, sy] = this.dragScreenCoords(e)
        this.#lastDragScreen = [sx, sy]
        this.#applyDrag(sx, sy)
    }

    /** A modifier changed mid-drag with no mouse movement — re-run with current keys. */
    protected override onModifierChange(e: KeyboardEvent) {
        if (!this.#dragging || !this.#lastDragScreen) return
        this.#readMods(e)
        this.#applyDrag(this.#lastDragScreen[0], this.#lastDragScreen[1])
    }

    #readMods(e: MouseEvent | KeyboardEvent) {
        this.#mod.alt = e.altKey
        this.#mod.ctrl = e.ctrlKey
        this.#mod.meta = e.metaKey
        this.#mod.shift = e.shiftKey
    }

    #applyDrag(sx: number, sy: number) {
        if (!this.#selected) return
        const [mx, my] = this.screenToWorld(sx, sy)

        if (this.#dragKind === "anchor" && this.#dragAnchor) {
            // Rigid anchor move: snap the anchor to grid, then translate every
            // coincident endpoint copy and attached handle by the same delta so
            // the path doesn't split and the local curve shape is preserved.
            const [ax, ay] = this.applySnap(mx, my)
            const dx = ax - this.#dragAnchor.startAnchor[0]
            const dy = ay - this.#dragAnchor.startAnchor[1]
            for (const { ref, start } of this.#dragAnchor.refs) {
                this.#setPoint(ref, start[0] + dx, start[1] + dy)
            }
            this.#recomputeSmart()   // smart nodes follow their neighbours
        } else {
            // Control handle: handles don't grid-snap (only round to 2dp). Ctrl/⌘
            // snaps the handle angle to steps; Shift constrains to 0/45/90°; Alt
            // breaks the link (cusp) for this drag.
            let wx = Math.round(mx * 100) / 100
            let wy = Math.round(my * 100) / 100
            const anchor = this.#dragHandleAnchor
            if (anchor && (this.#mod.ctrl || this.#mod.meta)) {
                const s = angleSnap(anchor, [wx, wy], this.angleSnapDeg)
                wx = s[0]; wy = s[1]
            } else if (anchor && this.#mod.shift) {
                const s = axisConstrain(anchor, [wx, wy])
                wx = s[0]; wy = s[1]
            }
            this.#setPoint(this.#selected, wx, wy)

            const mode: NodeType = this.#mod.alt ? "cusp" : this.#dragMode
            if (this.#dragLink && mode !== "cusp") {
                const np = partnerUpdate(
                    mode, this.#dragLink.anchor, [wx, wy],
                    this.#getPoint(this.#dragLink.partner),
                )
                if (np) this.#setPoint(this.#dragLink.partner, np[0], np[1])
            }
        }
        this.pendingInputUpdate = this.#selected.ei
        this.requestDraw()
    }

    protected onDragEndModel() {
        if (this.#dragging) {
            this.#dragging = false
            this.#dragKind = null
            this.#dragLink = null
            this.#dragAnchor = null
            this.#dragHandleAnchor = null
            this.#lastDragScreen = null
            this.emitChange()
        }
    }

    // ── Node-type assignment (1 Sharp / 2 Smooth / 3 Symmetric / 4 Smart) ──

    protected override onEditorKey(e: KeyboardEvent): boolean {
        // Let numeric input in the X/Y fields type normally.
        if (this.shadow.activeElement instanceof HTMLInputElement) return false
        if (e.metaKey || e.ctrlKey || e.altKey) return false
        const type = NODE_TYPE_KEYS[e.key]
        if (!type || !this.#selected) return false
        this.#setNodeType(this.#selected, type)
        return true
    }

    /** Set a node's type: create handles if needed, reshape them, store the override. */
    #setNodeType(ref: PointRef, type: NodeType) {
        const ai = anchorIndexOfRef(this.#elements, ref)
        if (ai == null) return

        this.pushUndo()

        // Smooth/Symmetric/Smart need handles. If an adjacent element is a
        // vertex/line/quad, promote it to a cubic so this anchor gets dedicated
        // in/out handles (vertex↔control conversion). Element count is preserved.
        const ni = (ai + 1) % this.#elements.length
        const lacksHandles = (i: number) => elPoints(this.#elements[i]!).length !== 4
        const structural = type !== "cusp" && (lacksHandles(ai) || (ni !== ai && lacksHandles(ni)))
        if (structural) {
            this.#elements = ensureAnchorHandles(this.#elements, ai)
            this.#selected = this.#endpointRef(ai)   // keep selection on the anchor
        }

        const a = getAnchors(this.#elements)[ai]
        if (a) {
            const inH = a.inHandle ? this.#getPoint(a.inHandle) : null
            const outH = a.outHandle ? this.#getPoint(a.outHandle) : null
            const res = normalizeToType(type, a.pos, inH, outH, a.prevPos, a.nextPos, this.autoK)
            if (res.inH && a.inHandle) this.#setPoint(a.inHandle, res.inH[0], res.inH[1])
            if (res.outH && a.outHandle) this.#setPoint(a.outHandle, res.outH[0], res.outH[1])
        }

        this.#nodeTypeOverride.set(ai, type)
        this.emitChange()
        if (structural) this.rebuildList()
        this.draw()
    }

    /**
     * Node-type tags to persist into source, one per element (== anchor) index.
     * Only persists what geometry can't re-derive on reload: `smart` always, and
     * an explicit `cusp` on a node whose handles happen to be colinear (otherwise
     * inference would read it as smooth). Smooth/symmetric round-trip for free.
     */
    #persistTags(): (NodeType | null)[] {
        if (this.#nodeTypeOverride.size === 0) return this.#elements.map(() => null)
        const anchors = getAnchors(this.#elements)
        return this.#elements.map((_, i) => {
            const t = this.#nodeTypeOverride.get(i)
            if (!t) return null
            if (t === "smart") return "smart"
            if (t === "cusp") {
                const a = anchors[i]
                if (!a) return null
                const inH = a.inHandle ? this.#getPoint(a.inHandle) : null
                const outH = a.outHandle ? this.#getPoint(a.outHandle) : null
                const inferred = inferNodeType(a.pos, inH, outH, this.colinearEps, this.equalLenEps)
                return inferred !== "cusp" ? "cusp" : null
            }
            return null
        })
    }

    /** Recompute every `smart` node's handles from its current neighbour anchors. */
    #recomputeSmart() {
        if (this.#nodeTypeOverride.size === 0) return
        let anchors: ReturnType<typeof getAnchors> | null = null
        for (const [ai, type] of this.#nodeTypeOverride) {
            if (type !== "smart") continue
            anchors ??= getAnchors(this.#elements)
            const a = anchors[ai]
            if (!a) continue
            const { inH, outH } = autoSmoothHandles(a.prevPos, a.pos, a.nextPos, this.autoK)
            if (a.inHandle) this.#setPoint(a.inHandle, inH[0], inH[1])
            if (a.outHandle) this.#setPoint(a.outHandle, outH[0], outH[1])
        }
    }

    protected onDeleteKey() {
        if (!this.#selected) return
        this.pushUndo()
        this.#elements.splice(this.#selected.ei, 1)
        this.#selected = null
        // Anchor indices shift on a structural edit; drop overrides (types
        // re-infer from geometry on the next interaction).
        this.#nodeTypeOverride.clear()
        this.emitChange()
        this.draw()
        this.rebuildList()
    }

    // ── Element list (one row per element; edits the anchor endpoint) ──

    protected rebuildList() {
        this.listEl.innerHTML = ""

        for (let ei = 0; ei < this.#elements.length; ei++) {
            const el = this.#elements[ei]!
            const ref = this.#endpointRef(ei)
            const [x, y] = this.#getPoint(ref)

            const row = document.createElement("div")
            row.className = "item-row"
            if (this.#selected?.ei === ei) row.classList.add("selected")

            const label = document.createElement("span")
            label.className = "item-label"
            label.textContent = `${kindLabel(el)}${ei}`

            const xLabel = document.createElement("span")
            xLabel.className = "axis-label"
            xLabel.textContent = "X"

            const xInput = document.createElement("input")
            xInput.type = "number"
            xInput.step = "0.01"
            xInput.className = "item-input"
            xInput.value = String(Math.round(x * 100) / 100)

            const yLabel = document.createElement("span")
            yLabel.className = "axis-label"
            yLabel.textContent = "Y"

            const yInput = document.createElement("input")
            yInput.type = "number"
            yInput.step = "0.01"
            yInput.className = "item-input"
            yInput.value = String(Math.round(y * 100) / 100)

            row.append(label, xLabel, xInput, yLabel, yInput)

            const idx = ei
            row.addEventListener("click", (e) => {
                if (e.target instanceof HTMLInputElement) return
                this.#selected = this.#endpointRef(idx)
                this.draw()
                this.highlightSelectedRow(idx)
            })

            xInput.addEventListener("focus", () => this.pushUndo())
            xInput.addEventListener("input", () => {
                const val = parseFloat(xInput.value)
                if (!isNaN(val)) {
                    const r = this.#endpointRef(idx)
                    this.#setPoint(r, Math.round(val * 100) / 100, this.#getPoint(r)[1])
                    this.emitChange()
                    this.draw()
                }
            })

            yInput.addEventListener("focus", () => this.pushUndo())
            yInput.addEventListener("input", () => {
                const val = parseFloat(yInput.value)
                if (!isNaN(val)) {
                    const r = this.#endpointRef(idx)
                    this.#setPoint(r, this.#getPoint(r)[0], Math.round(val * 100) / 100)
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
            const [x, y] = this.#getPoint(this.#endpointRef(idx))
            inputs[0].value = String(Math.round(x * 100) / 100)
            inputs[1].value = String(Math.round(y * 100) / 100)
        }
    }

    // ── Undo / source-sync hooks ───────────────────────────────────

    protected snapshot(): PathState {
        return { elements: cloneElements(this.#elements), overrides: [...this.#nodeTypeOverride] }
    }

    protected applySnapshot(state: PathState) {
        this.#elements = state.elements
        this.#nodeTypeOverride = new Map(state.overrides)
    }

    protected afterRestore() {
        if (this.#selected && this.#selected.ei >= this.#elements.length) {
            this.#selected = null
        }
    }

    protected emitChangePayload() {
        this.onChange?.(cloneElements(this.#elements), this.#persistTags())
    }
}

// ── Element helpers ────────────────────────────────────────────────

function isVertex(el: PathElement): boolean {
    return typeof el[0] === "number"
}

function elPoints(el: PathElement): Vec2[] {
    return isVertex(el) ? [el as Vec2] : (el as Vec2[])
}

function kindLabel(el: PathElement): string {
    if (isVertex(el)) return "V"
    const n = (el as Vec2[]).length
    return n === 2 ? "L" : n === 3 ? "Q" : "C"
}

function samePt(a: Vec2, b: Vec2): boolean {
    return a[0] === b[0] && a[1] === b[1]
}

/** Whether an interior control handle is retracted onto its adjacent anchor
 *  (so it should not be drawn — a corner, not a real handle). */
function isRetractedControl(pts: Vec2[], pi: number, n: number): boolean {
    if (pi === 1) return samePt(pts[1]!, pts[0]!)
    if (pi === n - 2) return samePt(pts[pi]!, pts[n - 1]!)
    return false
}

function cloneElements(els: PathElement[]): PathElement[] {
    return els.map(el =>
        typeof el[0] === "number"
            ? [el[0], el[1]] as Vec2
            : (el as Vec2[]).map(p => [p[0], p[1]] as Vec2),
    )
}

customElements.define("path2d-editor", Path2DEditor)

declare global {
    interface HTMLElementTagNameMap {
        "path2d-editor": Path2DEditor
    }
}
