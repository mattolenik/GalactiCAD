export class PreviewWindow extends HTMLElement {
    public readonly canvas: HTMLCanvasElement
    #resizeObserver: ResizeObserver

    constructor() {
        super()
        const shadow = this.attachShadow({ mode: "open" })

        this.canvas = document.createElement("canvas")
        this.canvas.style.width = "100%"
        this.canvas.style.height = "100%"
        this.canvas.style.display = "block"
        shadow.appendChild(this.canvas)

        // observe size changes on the host element
        this.#resizeObserver = new ResizeObserver(() => this.#updateSize())
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
