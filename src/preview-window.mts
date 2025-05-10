import { debounce, debounceTime, fromEventPattern } from "rxjs"

export class PreviewWindow extends HTMLElement {
    displayThreshold: number = 50 // hide FPS display until there's a significant drop
    static get observedAttributes() {
        return ["showFPS"]
    }
    public readonly canvas: HTMLCanvasElement
    #counter: HTMLSpanElement
    #showFps: boolean

    constructor() {
        super()
        const shadow = this.attachShadow({ mode: "open" })
        const style = document.createElement("style")
        style.textContent = `
        canvas {
            display: block;
            width: 100%;
            height: 100%;
            touch-action: none;            /* no scrolling/pinch-zoom */
            -webkit-tap-highlight-color: transparent;
            overscroll-behavior: none;
            -webkit-user-select: none;      /* no text selection */
            user-select: none;
            -webkit-touch-callout: none;    /* no long-press callout */
            -webkit-user-drag: none;        /* no “drag” highlight */
        }
        :host { display: inline-block; position: relative; }
        .overlay {
            position: absolute;
            bottom: 10px;
            right: 10px;
            pointer-events: none;
            z-index: 1;
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

        this.#showFps = !!(this.getAttribute("showFPS")?.toLocaleLowerCase() === "true")

        // observe size changes on the host element
    }

    updateFps(fps: number) {
        if (!this.#showFps) return

        if (fps <= this.displayThreshold) {
            this.#counter.textContent = fps.toFixed(0)
        } else {
            this.#counter.textContent = ""
        }
    }

    attributeChangedCallback(name: string, oldVal: string | null, newVal: string | null) {
        console.log(name)
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
