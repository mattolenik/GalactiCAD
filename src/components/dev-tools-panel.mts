import { BehaviorSubject, skip } from "rxjs"
import type { Subscription } from "rxjs"
import { __fg_color, __tone_1, __tone_2 } from "../style/style.mjs"
import { connectCheckbox } from "../binding/bind.mjs"
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
    #cameraOptimization$: BehaviorSubject<boolean>
    #beamOptCheckbox: HTMLInputElement
    #beamOptimization$: BehaviorSubject<boolean>
    #showFpsCheckbox: HTMLInputElement
    #showFps$: BehaviorSubject<boolean>
    #meshViewerCheckbox: HTMLInputElement
    #meshViewer$: BehaviorSubject<boolean>
    #settings: SettingsManager
    #tabs: DocumentTabs
    #subscriptions: Subscription[] = []

    /** Callback when camera optimization changes */
    onCameraOptimizationChange?: (enabled: boolean) => void

    /** Callback when beam optimization changes */
    onBeamOptimizationChange?: (enabled: boolean) => void

    /** Callback when show FPS changes */
    onShowFpsChange?: (enabled: boolean) => void

    /** Callback when mesh viewer toggle changes */
    onMeshViewerChange?: (enabled: boolean) => void

    get cameraOptimization(): boolean {
        return this.#cameraOptimization$.value
    }

    set cameraOptimization(enabled: boolean) {
        this.#cameraOptimization$.next(enabled)
    }

    get beamOptimization(): boolean {
        return this.#beamOptimization$.value
    }

    set beamOptimization(enabled: boolean) {
        this.#beamOptimization$.next(enabled)
    }

    get showFps(): boolean {
        return this.#showFps$.value
    }

    set showFps(enabled: boolean) {
        this.#showFps$.next(enabled)
    }

    get meshViewer(): boolean {
        return this.#meshViewer$.value
    }

    set meshViewer(enabled: boolean) {
        this.#meshViewer$.next(enabled)
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
            top: 76px;
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

        const g = this.#settings.getGlobal().app
        this.#showFps$ = new BehaviorSubject(g.showFps)
        this.#meshViewer$ = new BehaviorSubject(g.meshViewerEnabled)
        this.#cameraOptimization$ = new BehaviorSubject(true)
        this.#beamOptimization$ = new BehaviorSubject(false)

        this.#showFpsCheckbox = this.#addCheckbox(shadow, "Show FPS", this.#showFps$.value)
        this.#subscriptions.push(connectCheckbox(this.#showFpsCheckbox, this.#showFps$))
        this.#showFps$.pipe(skip(1)).subscribe(v => {
            this.#settings.updateGlobal({ app: { showFps: v } })
            this.onShowFpsChange?.(v)
        })

        this.#meshViewerCheckbox = this.#addCheckbox(shadow, "Export preview", this.#meshViewer$.value)
        this.#subscriptions.push(connectCheckbox(this.#meshViewerCheckbox, this.#meshViewer$))
        this.#meshViewer$.pipe(skip(1)).subscribe(v => {
            this.#settings.updateGlobal({ app: { meshViewerEnabled: v } })
            this.onMeshViewerChange?.(v)
        })

        this.#cameraOptCheckbox = this.#addCheckbox(shadow, "Camera halfres", this.#cameraOptimization$.value)
        this.#subscriptions.push(connectCheckbox(this.#cameraOptCheckbox, this.#cameraOptimization$))
        this.#cameraOptimization$.pipe(skip(1)).subscribe(v => {
            this.onCameraOptimizationChange?.(v)
        })

        this.#beamOptCheckbox = this.#addCheckbox(shadow, "Beam render", this.#beamOptimization$.value)
        this.#subscriptions.push(connectCheckbox(this.#beamOptCheckbox, this.#beamOptimization$))
        this.#beamOptimization$.pipe(skip(1)).subscribe(v => {
            this.onBeamOptimizationChange?.(v)
        })

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

    #addCheckbox(shadow: ShadowRoot, label: string, checked: boolean): HTMLInputElement {
        const el = document.createElement("label")
        const cb = document.createElement("input")
        cb.type = "checkbox"
        cb.checked = checked
        el.append(cb, label)
        shadow.appendChild(el)
        return cb
    }

    disconnectedCallback() {
        for (const sub of this.#subscriptions) {
            sub.unsubscribe()
        }
        this.#subscriptions = []
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
