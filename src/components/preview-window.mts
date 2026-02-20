import { VERSION } from "../version.mjs"
import { EdgeKind } from "../edge-kind.mjs"

export interface EdgeSelectionInfo {
    kind: number
    primaryId: number
    secondaryId: number
    featureA?: number
    opType?: number
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

export class PreviewWindow extends HTMLElement {
    readonly canvas: HTMLCanvasElement

    #counter: HTMLSpanElement
    #selInfo: HTMLDivElement
    #framerateThreshold: number = 120
    #showFps: boolean = false

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
        .version {
            font-size: 10px;
            color: rgba(255, 255, 255, 0.35);
        }
        .sel-info {
            position: absolute;
            bottom: 10px;
            left: calc(var(--sel-info-left, 0px) + 10px);
            pointer-events: none;
            z-index: 1;
            font-size: 11px;
            color: rgba(255, 255, 255, 0.6);
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
        shadow.appendChild(overlay)
        overlay.appendChild(this.#counter)

        const versionEl = document.createElement("span")
        versionEl.classList.add("version")
        versionEl.textContent = VERSION
        overlay.appendChild(versionEl)

        this.#selInfo = document.createElement("div")
        this.#selInfo.classList.add("sel-info")
        shadow.appendChild(this.#selInfo)
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
