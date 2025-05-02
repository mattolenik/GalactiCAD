export class PreviewWindow extends HTMLElement {
    static get observedAttributes() {
        return ["showFPS"]
    }
    public readonly canvas: HTMLCanvasElement
    #resizeObserver: ResizeObserver
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
            touch-action: manipulate;            /* no scrolling/pinch-zoom */
            -webkit-tap-highlight-color: transparent;
            overscroll-behavior: none;
            -webkit-user-select: none;      /* no text selection */
            user-select: none;
            -webkit-touch-callout: none;    /* no long-press callout */
            -webkit-user-drag: none;        /* no “drag” highlight */
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
        this.#resizeObserver = new ResizeObserver(this.#updateSize.bind(this))
    }

    updateFps(fps: number) {
        if (this.#showFps) {
            this.#counter.textContent = fps.toFixed(0)
        }
    }

    attributeChangedCallback(name: string, oldVal: string | null, newVal: string | null) {
        console.log(name)
        if (name === "showFPS") {
            this.#showFps = !!(newVal?.toLocaleLowerCase() === "true")
            this.#counter.style.visibility = this.#showFps ? "visible" : "hidden"
        }
    }

    connectedCallback(): void {
        this.#resizeObserver.observe(this)
        this.#updateSize()
    }

    disconnectedCallback(): void {
        this.#resizeObserver.disconnect()
    }

    #updateSize(): void {
        const { width, height } = this.getBoundingClientRect()
        this.canvas.width = Math.floor(width)
        this.canvas.height = Math.floor(height)
    }
}

customElements.define("preview-window", PreviewWindow)

declare global {
    interface HTMLElementTagNameMap {
        "preview-window": PreviewWindow
    }
}
