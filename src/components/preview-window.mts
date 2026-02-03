export class PreviewWindow extends HTMLElement {
    static get observedAttributes() {
        return ["showFPS"]
    }
    readonly canvas: HTMLCanvasElement

    #counter: HTMLSpanElement
    #framerateThreshold: number = 120
    #showFps: boolean
    #xrayCheckbox: HTMLInputElement
    #xrayMode: boolean = false

    /** Callback when xray mode changes */
    onXrayModeChange?: (enabled: boolean) => void

    get xrayMode(): boolean {
        return this.#xrayMode
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
        }
        .controls {
            position: absolute;
            top: 10px;
            right: 10px;
            z-index: 1;
            display: flex;
            align-items: center;
            gap: 6px;
            background: rgba(0, 0, 0, 0.5);
            padding: 4px 8px;
            border-radius: 4px;
            color: #ccc;
            font-size: 12px;
            font-family: system-ui, sans-serif;
        }
        .controls label {
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .controls input[type="checkbox"] {
            cursor: pointer;
            margin: 0;
        }
`
        this.canvas = document.createElement("canvas")
        this.canvas.style.width = "100%"
        this.canvas.style.height = "100%"
        this.canvas.style.display = "inline-block"
        shadow.appendChild(this.canvas)
        shadow.append(style, this.canvas)

        this.#counter = document.createElement("span")
        this.#counter.classList.add("overlay")
        this.#counter.style.float = "right"
        shadow.appendChild(this.#counter)

        // X-ray mode checkbox
        const controls = document.createElement("div")
        controls.classList.add("controls")
        const xrayLabel = document.createElement("label")
        this.#xrayCheckbox = document.createElement("input")
        this.#xrayCheckbox.type = "checkbox"
        this.#xrayCheckbox.addEventListener("change", () => {
            this.#xrayMode = this.#xrayCheckbox.checked
            this.onXrayModeChange?.(this.#xrayMode)
        })
        xrayLabel.append(this.#xrayCheckbox, "X-ray")
        controls.appendChild(xrayLabel)
        shadow.appendChild(controls)

        this.#showFps = !!(this.getAttribute("showFPS")?.toLocaleLowerCase() === "true")
    }

    updateFPS(fps: number) {
        if (!this.#showFps) return

        if (fps <= this.#framerateThreshold) {
            this.#counter.textContent = fps.toFixed(0)
        } else {
            this.#counter.textContent = ""
        }
    }

    attributeChangedCallback(name: string, oldVal: string | null, newVal: string | null) {
        if (name === "showFPS") {
            this.#showFps = !!(newVal?.toLocaleLowerCase() === "true")
            this.#counter.style.visibility = this.#showFps ? "visible" : "hidden"
        }
    }
}

customElements.define("preview-window", PreviewWindow)

declare global {
    interface HTMLElementTagNameMap {
        "preview-window": PreviewWindow
    }
}
