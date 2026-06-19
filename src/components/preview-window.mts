import { EdgeKind } from "../edge-kind.mjs"
import type { ThemeMode } from "../storage/settings.mjs"

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
}

export type SelectionInfo = {
    objects: number[]
    objectNames: Record<number, string>  // id -> shape type (e.g. "box", "union")
    edges: EdgeSelectionInfo[]
    face: FaceSelectionInfo | null
    hover: HoverInfo | null
}

const THEME_CYCLE: ThemeMode[] = ["light", "dark", "auto"]
const THEME_LABELS: Record<ThemeMode, string> = { light: "☀", dark: "☽", auto: "◐" }

export class PreviewWindow extends HTMLElement {
    readonly canvas: HTMLCanvasElement

    #counter: HTMLSpanElement
    #selInfo: HTMLDivElement
    #themeBtn: HTMLButtonElement
    #framerateThreshold: number = 120
    #showFps: boolean = false
    /** Blender-style 3D pivot cursor — was a per-pixel SDF in `preview.wgsl`; now a DOM overlay positioned via `setPivotCursor()`. */
    #pivotCursor: HTMLDivElement
    /** Bottom-left export-progress line (spinner + phase/elapsed + Cancel), above `.sel-info`. */
    #exportProgress: HTMLDivElement
    #exportProgressText: HTMLSpanElement
    #exportProgressCancel: HTMLButtonElement
    #onExportCancel?: () => void

    onThemeCycle?: () => void

    get showFps(): boolean {
        return this.#showFps
    }

    set showFps(enabled: boolean) {
        this.#showFps = enabled
        this.#counter.style.visibility = enabled ? "visible" : "hidden"
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
        .fps-counter {
            font-size: 20px;
            color: rgb(from var(--fg-color, whitesmoke) r g b / 0.35);
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
        .export-progress {
            position: absolute;
            bottom: 28px;
            left: calc(10px + var(--sel-info-left, 0px));
            z-index: 2;
            display: none;
            align-items: center;
            gap: 7px;
            pointer-events: auto;
            font-size: 11px;
            color: rgb(from var(--fg-color, whitesmoke) r g b / 0.85);
        }
        .export-progress.visible { display: flex; }
        .export-progress-spinner {
            width: 11px;
            height: 11px;
            flex: none;
            border: 2px solid rgb(from var(--fg-color, whitesmoke) r g b / 0.25);
            border-top-color: rgb(from var(--fg-color, whitesmoke) r g b / 0.85);
            border-radius: 50%;
            animation: export-progress-spin 0.8s linear infinite;
        }
        @keyframes export-progress-spin { to { transform: rotate(360deg); } }
        .export-progress-cancel {
            pointer-events: auto;
            padding: 1px 7px;
            border: 1px solid rgb(from var(--fg-color, whitesmoke) r g b / 0.35);
            border-radius: 4px;
            background: transparent;
            color: inherit;
            font: inherit;
            cursor: pointer;
        }
        .export-progress-cancel:hover {
            background: rgb(from var(--fg-color, whitesmoke) r g b / 0.12);
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

        const overlay = document.createElement("div")
        overlay.classList.add("overlay")
        this.#counter = document.createElement("span")
        this.#counter.classList.add("fps-counter")
        shadow.appendChild(overlay)
        overlay.appendChild(this.#counter)

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

        // Export-progress line: spinner + phase/elapsed text + Cancel, in the same
        // editor-aware bottom-left zone as `.sel-info` (one row above it).
        this.#exportProgress = document.createElement("div")
        this.#exportProgress.classList.add("export-progress")
        const exportSpinner = document.createElement("div")
        exportSpinner.classList.add("export-progress-spinner")
        this.#exportProgressText = document.createElement("span")
        this.#exportProgressText.classList.add("export-progress-text")
        this.#exportProgressCancel = document.createElement("button")
        this.#exportProgressCancel.classList.add("export-progress-cancel")
        this.#exportProgressCancel.type = "button"
        this.#exportProgressCancel.textContent = "Cancel"
        this.#exportProgressCancel.addEventListener("click", () => {
            this.#exportProgressCancel.disabled = true
            this.#onExportCancel?.()
        })
        this.#exportProgress.append(exportSpinner, this.#exportProgressText, this.#exportProgressCancel)
        shadow.appendChild(this.#exportProgress)

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
        this.#selInfo.textContent = parts.join(" · ")
        this.#selInfo.style.visibility = parts.length > 0 ? "visible" : "hidden"
    }

    setSelectionInfoLeft(offsetPx: number): void {
        this.#selInfo.style.setProperty("--sel-info-left", `${offsetPx}px`)
        // The export-progress line shares the editor-aware bottom-left zone.
        this.#exportProgress.style.setProperty("--sel-info-left", `${offsetPx}px`)
    }

    /** Show the bottom-left export-progress line. `onCancel` fires on the Cancel click;
     *  the button is hidden when `cancellable` is false (no shared-memory cancel flag). */
    showExportProgress(opts: { cancellable: boolean; onCancel?: () => void }): void {
        this.#onExportCancel = opts.onCancel
        this.#exportProgressCancel.style.display = opts.cancellable ? "" : "none"
        this.#exportProgressCancel.disabled = false
        this.#exportProgress.classList.add("visible")
    }

    /** Update the export-progress label, e.g. "Building octree • 12s". */
    setExportProgressText(text: string): void {
        this.#exportProgressText.textContent = text
    }

    /** Hide the export-progress line. */
    hideExportProgress(): void {
        this.#exportProgress.classList.remove("visible")
        this.#onExportCancel = undefined
    }

    updateFPS(fps: number) {
        if (!this.#showFps) return

        if (fps <= this.#framerateThreshold) {
            this.#counter.textContent = fps.toFixed(0)
        } else {
            this.#counter.textContent = ""
        }
    }
}

customElements.define("preview-window", PreviewWindow)

declare global {
    interface HTMLElementTagNameMap {
        "preview-window": PreviewWindow
    }
}
