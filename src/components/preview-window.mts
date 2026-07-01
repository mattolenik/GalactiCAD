import { EdgeKind } from "../edge-kind.mjs"
import type { ThemeMode } from "../storage/settings.mjs"
import type { FrameTimings } from "../render-worker-protocol.mjs"

export interface EdgeSelectionInfo {
    kind: number
    primaryId: number
    secondaryId: number
    featureA?: number
    opType?: number
    seedPoint?: [number, number, number]
    seedTangent?: [number, number, number]
    seedNormal?: [number, number, number]
}

export interface FaceSelectionInfo {
    nodeId: number
    faceIndex: number
    mode: number
}

export interface HoverInfo {
    objectId: number
    edges: EdgeSelectionInfo[]
    /** World hit position under the cursor — drives face-hover preview resolution. */
    hitPos?: [number, number, number]
}

/** FeatureGraph (polyline/ring/corner) selection summary for the debug readout. */
export interface FgFeatureInfo {
    polylines: number
    rings: number
    corners: number
    hoverKind?: "polyline" | "ring" | "corner" | null
    hoverId?: number
}

export type SelectionInfo = {
    objects: number[]
    objectNames: Record<number, string>  // id -> shape type (e.g. "box", "union")
    edges: EdgeSelectionInfo[]
    face: FaceSelectionInfo | null
    hover: HoverInfo | null
    fgFeatures?: FgFeatureInfo | null
}

const THEME_CYCLE: ThemeMode[] = ["light", "dark", "auto"]
const THEME_LABELS: Record<ThemeMode, string> = { light: "☀", dark: "☽", auto: "◐" }

export class PreviewWindow extends HTMLElement {
    readonly canvas: HTMLCanvasElement
    /** Transparent 2D overlay layered above the (worker-owned, offscreen-
     * transferred) WebGPU canvas. Used for main-thread UI — currently the
     * transform gizmo — so hover/drag redraw a few paths instead of forcing a
     * full scene raymarch in the worker. `pointer-events:none` so events still
     * reach the WebGPU canvas underneath. */
    readonly gizmoCanvas: HTMLCanvasElement

    #framerateOverlay: HTMLDivElement
    #selInfo: HTMLDivElement
    #themeBtn: HTMLButtonElement
    #showFramerate: boolean = false
    /** Blender-style 3D pivot cursor — was a per-pixel SDF in `preview.wgsl`; now a DOM overlay positioned via `setPivotCursor()`. */
    #pivotCursor: HTMLDivElement

    onThemeCycle?: () => void

    get showFramerate(): boolean {
        return this.#showFramerate
    }

    set showFramerate(enabled: boolean) {
        this.#showFramerate = enabled
        this.#framerateOverlay.style.visibility = enabled ? "visible" : "hidden"
        if (!enabled) {
            this.#framerateOverlay.textContent = ""
        } else if (!this.#framerateOverlay.textContent) {
            // Timings only arrive while the camera moves (rendering is event-driven),
            // so prompt rather than show a blank box until the first sample lands.
            this.#framerateOverlay.textContent = "GPU ms · move camera…"
        }
    }

    constructor() {
        super()
        const shadow = this.attachShadow({ mode: "open" })
        const style = document.createElement("style")
        style.textContent = `
        canvas {
            -webkit-tap-highlight-color: transparent;
            -webkit-touch-callout: none;    /* no long-press callout */
            -webkit-user-drag: none;        /* no "drag" highlight */
            -webkit-user-select: none;      /* no text selection */
            display: block;
            height: 100%;
            overscroll-behavior: none;
            touch-action: none;             /* no scrolling/pinch zoom */
            user-select: none;
            width: 100%;
        }
        :host { display: inline-block; position: relative; }
        .gizmo-layer {
            position: absolute;
            top: 0;
            left: 0;
            pointer-events: none;
            z-index: 1;
        }
        .overlay {
            position: absolute;
            bottom: 10px;
            right: 10px;
            pointer-events: none;
            z-index: 1;
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            gap: 2px;
        }
        .framerate-overlay {
            position: absolute;
            /* Clear the editor overlay: it covers the left column (landscape,
               --fr-left) or top row (portrait, --fr-top) of #main-panels. Those
               vars are set per-orientation in index.css and inherit through the
               shadow boundary; their % resolves against this host (== #main-panels
               box), so the overlay stays pinned to the visible viewport's top-left
               and tracks editor-split drags live. */
            top: calc(10px + var(--fr-top, 0px));
            left: calc(10px + var(--fr-left, 0px));
            pointer-events: none;
            z-index: 1;
            font-family: ui-monospace, "SF Mono", Menlo, monospace;
            font-size: 11px;
            line-height: 1.35;
            white-space: pre;
            color: rgb(from var(--fg-color, whitesmoke) r g b / 0.7);
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.85);
            visibility: hidden;
        }
        .sel-info {
            position: absolute;
            bottom: 10px;
            left: calc(10px + var(--sel-info-left, 0px));
            pointer-events: none;
            z-index: 1;
            font-size: 11px;
            color: rgb(from var(--fg-color, whitesmoke) r g b / 0.6);
        }
        .theme-btn {
            pointer-events: auto;
            flex-shrink: 0;
            width: 32px;
            height: 32px;
            padding: 0;
            border: none;
            border-radius: 6px;
            background: rgb(from var(--fg-color, whitesmoke) r g b / 0.12);
            color: rgb(from var(--fg-color, whitesmoke) r g b / 0.7);
            font-size: 14px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: background 0.15s, color 0.15s;
        }
        .theme-btn:hover {
            background: rgb(from var(--fg-color, whitesmoke) r g b / 0.2);
            color: rgb(from var(--fg-color, whitesmoke) r g b / 0.9);
        }
        .theme-btn:active {
            background: rgb(from var(--fg-color, whitesmoke) r g b / 0.28);
        }
        .pivot-cursor {
            position: absolute;
            top: 0;
            left: 0;
            width: 32px;
            height: 32px;
            margin-left: -16px;
            margin-top: -16px;
            pointer-events: none;
            z-index: 1;
            will-change: transform;
            visibility: hidden;
        }
`
        this.canvas = document.createElement("canvas")
        this.canvas.style.width = "100%"
        this.canvas.style.height = "100%"
        this.canvas.style.display = "inline-block"
        shadow.append(style, this.canvas)

        // Transparent gizmo overlay, layered on top of the WebGPU canvas. Its
        // backing store is sized to device pixels by the renderer on resize.
        this.gizmoCanvas = document.createElement("canvas")
        this.gizmoCanvas.classList.add("gizmo-layer")
        shadow.appendChild(this.gizmoCanvas)

        const overlay = document.createElement("div")
        overlay.classList.add("overlay")
        shadow.appendChild(overlay)

        // Per-pass GPU frame-time readout, top-left. Fed by `updateFrameTimings`
        // (worker `frameTimings` messages); hidden until "Show Framerate" is on.
        this.#framerateOverlay = document.createElement("div")
        this.#framerateOverlay.classList.add("framerate-overlay")
        shadow.appendChild(this.#framerateOverlay)

        this.#themeBtn = document.createElement("button")
        this.#themeBtn.classList.add("theme-btn")
        this.#themeBtn.type = "button"
        this.#themeBtn.title = "Cycle theme (light / dark / auto)"
        this.#themeBtn.setAttribute("aria-label", "Cycle theme")
        this.#themeBtn.addEventListener("click", () => this.onThemeCycle?.())
        overlay.appendChild(this.#themeBtn)

        this.#selInfo = document.createElement("div")
        this.#selInfo.classList.add("sel-info")
        shadow.appendChild(this.#selInfo)

        // Pivot cursor: dashed red/white ring + white crosshair. Matches the
        // visual the old WGSL `pivotCursorRgba` produced; lives in the DOM
        // so the SDF fragment shader doesn't pay a per-pixel screen-space
        // SDF eval just to draw a UI overlay.
        this.#pivotCursor = document.createElement("div")
        this.#pivotCursor.classList.add("pivot-cursor")
        this.#pivotCursor.innerHTML =
            `<svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" style="display:block">` +
            `<circle cx="16" cy="16" r="15" fill="none" stroke="#ffffff" stroke-width="2"/>` +
            `<circle cx="16" cy="16" r="15" fill="none" stroke="#e6241c" stroke-width="2" stroke-dasharray="6.7 6.7"/>` +
            `<line x1="3" y1="16" x2="29" y2="16" stroke="#f0f0f5" stroke-width="1.5"/>` +
            `<line x1="16" y1="3" x2="16" y2="29" stroke="#f0f0f5" stroke-width="1.5"/>` +
            `</svg>`
        shadow.appendChild(this.#pivotCursor)
    }

    /**
     * Position the pivot cursor (CSS pixels, relative to the canvas's top-
     * left). Pass `visible: false` to hide it (off-screen, between-renders,
     * etc.). Cheap — sets a CSS transform, no layout/paint beyond the cursor
     * element itself.
     */
    setPivotCursor(x: number, y: number, visible: boolean): void {
        if (!visible) {
            this.#pivotCursor.style.visibility = "hidden"
            return
        }
        this.#pivotCursor.style.visibility = "visible"
        this.#pivotCursor.style.transform = `translate(${x}px, ${y}px)`
    }

    setThemeMode(mode: ThemeMode): void {
        this.#themeBtn.textContent = THEME_LABELS[mode]
    }

    updateSelectionInfo(info: SelectionInfo): void {
        const parts: string[] = []
        if (info.objects.length > 0) {
            const objLabels = info.objects.map(id => {
                const name = info.objectNames?.[id]
                return name ? `${id} (${name})` : String(id)
            }).join(", ")
            parts.push(`Objects: ${objLabels}`)
        }
        if (info.edges.length > 0) {
            const edgeLabels = info.edges.map(e =>
                e.kind === EdgeKind.Seam
                    ? `Seam [${e.primaryId},${e.secondaryId}]`
                    : e.kind === EdgeKind.SeamSegment
                      ? `Seam seg [${e.primaryId},${e.secondaryId}]`
                      : `Edge [${e.primaryId}]`
            ).join(" ")
            parts.push(`Edges: ${edgeLabels}`)
        }
        if (info.face) {
            const modeLabel = ["slide", "extrude", "top", "bottom"][info.face.mode] ?? "?"
            const faceName = info.objectNames?.[info.face.nodeId]
            const nodeLabel = faceName ? `${info.face.nodeId} (${faceName})` : String(info.face.nodeId)
            parts.push(`Face: node ${nodeLabel} edge ${info.face.faceIndex} (${modeLabel})`)
        }
        if (info.hover) {
            const hoverName = info.objectNames?.[info.hover.objectId]
            const hoverParts: string[] = [
                hoverName ? `Object ${info.hover.objectId} (${hoverName})` : `Object ${info.hover.objectId}`,
            ]
            if (info.hover.edges.length > 0) {
                const edgeLabels = info.hover.edges.map(e =>
                    e.kind === EdgeKind.Seam ? `Seam [${e.primaryId},${e.secondaryId}]` : e.kind === EdgeKind.SeamSegment ? `Seam seg [${e.primaryId},${e.secondaryId}]` : `Edge [${e.primaryId}]`
                )
                hoverParts.push(edgeLabels.join(" "))
            }
            parts.push(`Hover: ${hoverParts.join(" · ")}`)
        }
        if (info.fgFeatures) {
            const f = info.fgFeatures
            const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`
            const sel: string[] = []
            if (f.polylines > 0) sel.push(plural(f.polylines, "polyline"))
            if (f.rings > 0) sel.push(plural(f.rings, "ring"))
            if (f.corners > 0) sel.push(plural(f.corners, "corner"))
            if (sel.length > 0) parts.push(`Features: ${sel.join(", ")}`)
            if (f.hoverKind) {
                parts.push(`Hover: ${f.hoverKind}${f.hoverId !== undefined ? ` [${f.hoverId}]` : ""}`)
            }
        }
        this.#selInfo.textContent = parts.join(" · ")
        this.#selInfo.style.visibility = parts.length > 0 ? "visible" : "hidden"
    }

    setSelectionInfoLeft(offsetPx: number): void {
        this.#selInfo.style.setProperty("--sel-info-left", `${offsetPx}px`)
    }

    /**
     * Render the per-pass GPU frame timings (15-frame averages, ms) in the top-left
     * overlay. No-op while "Show Framerate" is off. Rendering is event-driven, so
     * these are per-frame GPU costs, not a steady-state frame rate.
     */
    updateFrameTimings(t: FrameTimings) {
        if (!this.#showFramerate) return
        const row = (label: string, ms: number) => label.padEnd(8) + ms.toFixed(2).padStart(6)
        this.#framerateOverlay.textContent =
            "GPU ms · avg 15 frames\n" +
            row("frame", t.frame) + "\n" +
            row("scene", t.scene) + "\n" +
            row("shade", t.shade) + "\n" +
            row("beam", t.beam) + "\n" +
            row("easu", t.easu) + "\n" +
            row("fxaa", t.fxaa) + "\n" +
            row("outline", t.outline) + "\n" +
            row("overlay", t.overlay) + "\n" +
            `${t.res} · ${t.scale}× · ao ${t.ao}${t.deferred ? " · deferred" : ""}`
    }
}

customElements.define("preview-window", PreviewWindow)

declare global {
    interface HTMLElementTagNameMap {
        "preview-window": PreviewWindow
    }
}
