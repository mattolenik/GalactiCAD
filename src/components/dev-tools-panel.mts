import { __fg_color, __tone_1, __tone_2 } from "../style/style.mjs"

export class DevToolsPanel extends HTMLElement {
    #cameraOptCheckbox: HTMLInputElement
    #cameraOptimization: boolean = true
    #beamOptCheckbox: HTMLInputElement
    #beamOptimization: boolean = false

    /** Callback when camera optimization changes */
    onCameraOptimizationChange?: (enabled: boolean) => void

    /** Callback when beam optimization changes */
    onBeamOptimizationChange?: (enabled: boolean) => void

    /** Callback when benchmark button is clicked */
    onBenchmark?: () => void | Promise<void>

    /** Callback when save benchmark suite button is clicked */
    onSaveBenchmarkSuite?: () => void | Promise<void>

    get cameraOptimization(): boolean {
        return this.#cameraOptimization
    }

    set cameraOptimization(enabled: boolean) {
        this.#cameraOptimization = enabled
        this.#cameraOptCheckbox.checked = enabled
    }

    get beamOptimization(): boolean {
        return this.#beamOptimization
    }

    set beamOptimization(enabled: boolean) {
        this.#beamOptimization = enabled
        this.#beamOptCheckbox.checked = enabled
    }

    /** Show or hide the panel */
    get visible(): boolean {
        return this.style.display !== "none"
    }

    set visible(show: boolean) {
        this.style.display = show ? "" : "none"
    }

    constructor() {
        super()
        const shadow = this.attachShadow({ mode: "open" })

        const style = document.createElement("style")
        style.textContent = `
        :host {
            display: flex;
            flex-direction: column;
            align-items: flex-start;
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
        :host([hidden]) { display: none; }
        label {
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        input[type="checkbox"] {
            cursor: pointer;
            margin: 0;
        }
        button {
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
        button:hover {
            background: rgb(from var(${__fg_color}) r g b / 0.2);
        }
        button:active {
            background: rgb(from var(${__fg_color}) r g b / 0.3);
        }
        button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
`
        shadow.appendChild(style)

        // Camera optimization checkbox
        const cameraOptLabel = document.createElement("label")
        this.#cameraOptCheckbox = document.createElement("input")
        this.#cameraOptCheckbox.type = "checkbox"
        this.#cameraOptCheckbox.checked = this.#cameraOptimization
        this.#cameraOptCheckbox.addEventListener("change", () => {
            this.#cameraOptimization = this.#cameraOptCheckbox.checked
            this.onCameraOptimizationChange?.(this.#cameraOptimization)
        })
        cameraOptLabel.append(this.#cameraOptCheckbox, "Camera optimization")
        shadow.appendChild(cameraOptLabel)

        // Beam optimization checkbox
        const beamOptLabel = document.createElement("label")
        this.#beamOptCheckbox = document.createElement("input")
        this.#beamOptCheckbox.type = "checkbox"
        this.#beamOptCheckbox.checked = this.#beamOptimization
        this.#beamOptCheckbox.addEventListener("change", () => {
            this.#beamOptimization = this.#beamOptCheckbox.checked
            this.onBeamOptimizationChange?.(this.#beamOptimization)
        })
        beamOptLabel.append(this.#beamOptCheckbox, "Beam optimization")
        shadow.appendChild(beamOptLabel)

        // Save Suite button
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
        shadow.appendChild(saveSuiteButton)

        // Benchmark button
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
        shadow.appendChild(benchmarkButton)

        // Hidden by default
        this.style.display = "none"
    }
}

customElements.define("dev-tools-panel", DevToolsPanel)

declare global {
    interface HTMLElementTagNameMap {
        "dev-tools-panel": DevToolsPanel
    }
}
