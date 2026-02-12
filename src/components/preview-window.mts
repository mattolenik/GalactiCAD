import { __fg_color, __tone_1, __tone_2, __tone_3 } from "../style/style.mjs"

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
    #cameraOptCheckbox: HTMLInputElement
    #cameraOptimization: boolean = true
    #beamOptCheckbox: HTMLInputElement
    #beamOptimization: boolean = false

    /** Callback when xray mode changes */
    onXrayModeChange?: (enabled: boolean) => void

    /** Callback when camera optimization changes */
    onCameraOptimizationChange?: (enabled: boolean) => void

    /** Callback when beam optimization changes */
    onBeamOptimizationChange?: (enabled: boolean) => void

    /** Callback when benchmark button is clicked */
    onBenchmark?: () => void | Promise<void>

    /** Callback when save benchmark suite button is clicked */
    onSaveBenchmarkSuite?: () => void | Promise<void>

    get xrayMode(): boolean {
        return this.#xrayMode
    }

    set xrayMode(enabled: boolean) {
        this.#xrayMode = enabled
        this.#xrayCheckbox.checked = enabled
    }

    get cameraOptimization(): boolean {
        return this.#cameraOptimization
    }

    get beamOptimization(): boolean {
        return this.#beamOptimization
    }

    set beamOptimization(enabled: boolean) {
        this.#beamOptimization = enabled
        this.#beamOptCheckbox.checked = enabled
    }

    set cameraOptimization(enabled: boolean) {
        this.#cameraOptimization = enabled
        this.#cameraOptCheckbox.checked = enabled
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
            background: color-mix(in srgb, var(${__tone_2}) 92%, transparent);
            backdrop-filter: blur(6px);
            -webkit-backdrop-filter: blur(6px);
            padding: 4px 8px;
            border-radius: 4px;
            color: rgb(from var(${__fg_color}) r g b / 0.85);
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
        .controls button {
            cursor: pointer;
            padding: 2px 8px;
            border: 1px solid var(${__tone_1});
            background: rgb(from var(${__fg_color}) r g b / 0.1);
            color: rgb(from var(${__fg_color}) r g b / 0.85);
            font-size: 12px;
            font-family: system-ui, sans-serif;
            border-radius: 3px;
            transition: background 0.2s ease;
        }
        .controls button:hover {
            background: rgb(from var(${__fg_color}) r g b / 0.2);
        }
        .controls button:active {
            background: rgb(from var(${__fg_color}) r g b / 0.3);
        }
        .controls button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
`
        this.canvas = document.createElement("canvas")
        this.canvas.style.width = "100%"
        this.canvas.style.height = "100%"
        this.canvas.style.display = "inline-block"
        shadow.append(style, this.canvas)

        this.#counter = document.createElement("span")
        this.#counter.classList.add("overlay")
        this.#counter.style.float = "right"
        shadow.appendChild(this.#counter)

        // X-ray mode checkbox and benchmark button
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

        const cameraOptLabel = document.createElement("label")
        this.#cameraOptCheckbox = document.createElement("input")
        this.#cameraOptCheckbox.type = "checkbox"
        this.#cameraOptCheckbox.checked = this.#cameraOptimization
        this.#cameraOptCheckbox.addEventListener("change", () => {
            this.#cameraOptimization = this.#cameraOptCheckbox.checked
            this.onCameraOptimizationChange?.(this.#cameraOptimization)
        })
        cameraOptLabel.append(this.#cameraOptCheckbox, "Camera optimization")
        controls.appendChild(cameraOptLabel)

        const beamOptLabel = document.createElement("label")
        this.#beamOptCheckbox = document.createElement("input")
        this.#beamOptCheckbox.type = "checkbox"
        this.#beamOptCheckbox.checked = this.#beamOptimization
        this.#beamOptCheckbox.addEventListener("change", () => {
            this.#beamOptimization = this.#beamOptCheckbox.checked
            this.onBeamOptimizationChange?.(this.#beamOptimization)
        })
        beamOptLabel.append(this.#beamOptCheckbox, "Beam optimization")
        controls.appendChild(beamOptLabel)

        const saveSuiteButton = document.createElement("button")
        saveSuiteButton.textContent = "Save Suite"
        saveSuiteButton.addEventListener("click", async () => {
            if (this.onSaveBenchmarkSuite) {
                saveSuiteButton.disabled = true
                try {
                    await this.onSaveBenchmarkSuite()
                } finally {
                    saveSuiteButton.disabled = false
                }
            }
        })
        controls.appendChild(saveSuiteButton)

        const benchmarkButton = document.createElement("button")
        benchmarkButton.textContent = "Benchmark"
        benchmarkButton.addEventListener("click", async () => {
            if (this.onBenchmark) {
                benchmarkButton.disabled = true
                try {
                    await this.onBenchmark()
                } finally {
                    benchmarkButton.disabled = false
                }
            }
        })
        controls.appendChild(benchmarkButton)
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
