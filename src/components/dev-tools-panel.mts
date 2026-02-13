import { __fg_color, __tone_1, __tone_2 } from "../style/style.mjs"
import { SettingsManager } from "../storage/settings.mjs"
import type { DocumentTabs } from "./document-tabs.mjs"
import {
    loadBenchmarkSuite,
    saveBenchmarkSuite,
    runBenchmarkSuite,
    formatBenchmarkResultsHtml,
    type BenchmarkCase,
} from "../benchmark/benchmark.mjs"

export class DevToolsPanel extends HTMLElement {
    #cameraOptCheckbox: HTMLInputElement
    #cameraOptimization: boolean = true
    #beamOptCheckbox: HTMLInputElement
    #beamOptimization: boolean = false
    #showFpsCheckbox: HTMLInputElement
    #meshViewerCheckbox: HTMLInputElement
    #settings: SettingsManager
    #tabs: DocumentTabs

    /** Callback when camera optimization changes */
    onCameraOptimizationChange?: (enabled: boolean) => void

    /** Callback when beam optimization changes */
    onBeamOptimizationChange?: (enabled: boolean) => void

    /** Callback when show FPS changes */
    onShowFpsChange?: (enabled: boolean) => void

    /** Callback when mesh viewer toggle changes */
    onMeshViewerChange?: (enabled: boolean) => void

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

    get showFps(): boolean {
        return this.#showFpsCheckbox.checked
    }

    set showFps(enabled: boolean) {
        this.#showFpsCheckbox.checked = enabled
    }

    get meshViewer(): boolean {
        return this.#meshViewerCheckbox.checked
    }

    set meshViewer(enabled: boolean) {
        this.#meshViewerCheckbox.checked = enabled
    }

    /** Show or hide the panel */
    get visible(): boolean {
        return this.style.display !== "none"
    }

    set visible(show: boolean) {
        this.style.display = show ? "" : "none"
    }

    constructor(settings: SettingsManager, tabs: DocumentTabs) {
        super()
        this.#settings = settings
        this.#tabs = tabs

        const shadow = this.attachShadow({ mode: "open" })

        const style = document.createElement("style")
        style.textContent = `
        :host {
            position: absolute;
            top: 46px;
            right: 10px;
            z-index: 1;
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
            font-size: 16px;
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

        // Show FPS checkbox
        const showFpsLabel = document.createElement("label")
        this.#showFpsCheckbox = document.createElement("input")
        this.#showFpsCheckbox.type = "checkbox"
        this.#showFpsCheckbox.addEventListener("change", () => {
            const enabled = this.#showFpsCheckbox.checked
            this.#settings.updateGlobal({ app: { showFps: enabled } })
            this.onShowFpsChange?.(enabled)
        })
        showFpsLabel.append(this.#showFpsCheckbox, "Show FPS")
        shadow.appendChild(showFpsLabel)

        // Mesh viewer checkbox
        const meshViewerLabel = document.createElement("label")
        this.#meshViewerCheckbox = document.createElement("input")
        this.#meshViewerCheckbox.type = "checkbox"
        this.#meshViewerCheckbox.checked = this.#settings.getGlobal().app.meshViewerEnabled
        this.#meshViewerCheckbox.addEventListener("change", () => {
            const enabled = this.#meshViewerCheckbox.checked
            this.#settings.updateGlobal({ app: { meshViewerEnabled: enabled } })
            this.onMeshViewerChange?.(enabled)
        })
        meshViewerLabel.append(this.#meshViewerCheckbox, "Export preview")
        shadow.appendChild(meshViewerLabel)

        // Camera optimization checkbox
        const cameraOptLabel = document.createElement("label")
        this.#cameraOptCheckbox = document.createElement("input")
        this.#cameraOptCheckbox.type = "checkbox"
        this.#cameraOptCheckbox.checked = this.#cameraOptimization
        this.#cameraOptCheckbox.addEventListener("change", () => {
            this.#cameraOptimization = this.#cameraOptCheckbox.checked
            this.onCameraOptimizationChange?.(this.#cameraOptimization)
        })
        cameraOptLabel.append(this.#cameraOptCheckbox, "Camera halfres")
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
        beamOptLabel.append(this.#beamOptCheckbox, "Beam render")
        shadow.appendChild(beamOptLabel)

        // Save Suite button
        const saveSuiteButton = document.createElement("button")
        saveSuiteButton.textContent = "Save Bench Suite"
        saveSuiteButton.addEventListener("click", async () => {
            saveSuiteButton.disabled = true
            try {
                await this.#saveBenchmarkSuite()
            } finally {
                saveSuiteButton.disabled = false
            }
        })
        shadow.appendChild(saveSuiteButton)

        // Benchmark button
        const benchmarkButton = document.createElement("button")
        benchmarkButton.textContent = "Benchmark"
        benchmarkButton.addEventListener("click", async () => {
            benchmarkButton.disabled = true
            try {
                await this.#runBenchmark()
            } finally {
                benchmarkButton.disabled = false
            }
        })
        shadow.appendChild(benchmarkButton)

        // Hidden by default
        this.style.display = "none"
    }

    async #saveBenchmarkSuite(): Promise<void> {
        this.#settings.flushDocNow()
        const suite: BenchmarkCase[] = []
        for (const name of this.#tabs.documentNames) {
            const model = this.#tabs.getByName(name)
            const docSettings = this.#settings.getDocumentSettings(name)
            if (model) {
                suite.push({
                    name,
                    source: model.getValue(),
                    camera: docSettings.camera,
                    preview: docSettings.preview,
                })
            }
        }
        saveBenchmarkSuite(suite)
        const { StatusDialog } = await import("./status-dialog.mjs")
        const statusDialog = new StatusDialog(
            `Saved benchmark suite with ${suite.length} case(s) to localStorage.`,
            true
        )
        await statusDialog.show()
    }

    async #runBenchmark(): Promise<void> {
        const { StatusDialog } = await import("./status-dialog.mjs")
        const suite = loadBenchmarkSuite()
        if (suite.length === 0) {
            const statusDialog = new StatusDialog(
                "No benchmark suite found. Save a suite first using the Save Suite button.",
                true
            )
            await statusDialog.show()
            return
        }

        const statusDialog = new StatusDialog("Running benchmark suite...", false)
        const dialogPromise = statusDialog.show()

        try {
            const frameCount = 100
            const results = await runBenchmarkSuite(suite, frameCount)

            // Log to console
            console.log("Benchmark Results:")
            console.table(
                results.map(r =>
                    r.result.error
                        ? { document: r.name, error: r.result.error }
                        : {
                            document: r.name,
                            "avg (ms)": r.result.averageFrameTime.toFixed(2),
                            fps: r.result.framesPerSecond.toFixed(2),
                            "min (ms)": r.result.minFrameTime.toFixed(2),
                            "max (ms)": r.result.maxFrameTime.toFixed(2),
                        }
                )
            )

            const html = formatBenchmarkResultsHtml(results)
            statusDialog.updateContentHtml(html, true)
            await dialogPromise
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err)
            statusDialog.updateMessage(`Benchmark failed: ${errorMsg}`, true)
            await dialogPromise
        }
    }
}

customElements.define("dev-tools-panel", DevToolsPanel)

declare global {
    interface HTMLElementTagNameMap {
        "dev-tools-panel": DevToolsPanel
    }
}
