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
import {
    DEFAULT_PREVIEW_SHADING,
    type PreviewShadingParams,
} from "../render-worker-protocol.mjs"
import { DEBUG_LOG_MODULES, log, type DebugLogModulesState, type LogModule } from "../logging/debug-log.mjs"

const PREVIEW_SHADING_KNOBS: {
    key: keyof PreviewShadingParams
    label: string
    min: number
    max: number
    step: number
}[] = [
        { key: "ambient", label: "Ambient", min: 0, max: 0.45, step: 0.01 },
        { key: "diffuseWrap", label: "Diffuse wrap", min: 0, max: 1, step: 0.02 },
        { key: "keyWeight", label: "Key light", min: 0, max: 1, step: 0.02 },
        { key: "fillWeight", label: "Fill light", min: 0, max: 1, step: 0.02 },
        { key: "rimWeight", label: "Rim light", min: 0, max: 1, step: 0.02 },
        { key: "backWeight", label: "Back light", min: 0, max: 1, step: 0.02 },
        { key: "specIntensity", label: "Specular", min: 0, max: 0.45, step: 0.01 },
        { key: "specShininess", label: "Spec power", min: 1, max: 256, step: 1 },
        { key: "fresnelPower", label: "Fresnel pow", min: 0.5, max: 8, step: 0.1 },
        { key: "fresnelIntensity", label: "Fresnel", min: 0, max: 0.45, step: 0.01 },
        { key: "aoStrength", label: "AO strength", min: 0, max: 1, step: 0.02 },
        { key: "aoRadius", label: "AO radius", min: 0.01, max: 0.5, step: 0.01 },
        { key: "aoSteps", label: "AO steps", min: 1, max: 8, step: 1 },
        { key: "aoBias", label: "AO bias", min: 0, max: 0.1, step: 0.005 },
    ]

export class DevToolsPanel extends HTMLElement {
    #cameraOptCheckbox: HTMLInputElement
    #cameraOptimization$: BehaviorSubject<boolean>
    #beamOptCheckbox: HTMLInputElement
    #beamOptimization$: BehaviorSubject<boolean>
    #bvhOptCheckbox: HTMLInputElement
    #bvhOptimization$: BehaviorSubject<boolean>
    #normalPreviewCheckbox: HTMLInputElement
    #shadingState: PreviewShadingParams = { ...DEFAULT_PREVIEW_SHADING }
    #shadingRows = new Map<keyof PreviewShadingParams, { range: HTMLInputElement; valueEl: HTMLSpanElement }>()
    #showFpsCheckbox: HTMLInputElement
    #showFps$: BehaviorSubject<boolean>
    #meshViewerCheckbox: HTMLInputElement
    #meshViewer$: BehaviorSubject<boolean>
    #meshSimplifyCheckbox: HTMLInputElement
    #meshSimplify$: BehaviorSubject<boolean>
    #useShrecCheckbox: HTMLInputElement
    #useShrec$: BehaviorSubject<boolean>
    #lightingExpandedCheckbox: HTMLInputElement
    #lightingExpanded$: BehaviorSubject<boolean>
    #lightingSection: HTMLDivElement
    #settings: SettingsManager
    #tabs: DocumentTabs
    #subscriptions: Subscription[] = []
    #debugLogCheckboxes = new Map<LogModule, HTMLInputElement>()

    /** Callback when camera optimization changes */
    onCameraOptimizationChange?: (enabled: boolean) => void

    /** Callback when beam optimization changes */
    onBeamOptimizationChange?: (enabled: boolean) => void

    /** Callback when BVH optimization changes */
    onBvhOptimizationChange?: (enabled: boolean) => void

    /** Callback when show FPS changes */
    onShowFpsChange?: (enabled: boolean) => void

    /** Callback when mesh viewer toggle changes */
    onMeshViewerChange?: (enabled: boolean) => void

    /** Callback when mesh simplify on export toggle changes */
    onMeshSimplifyChange?: (enabled: boolean) => void

    /** Callback when the SHREC/MergeSharp exporter toggle changes (off = MDC). */
    onUseShrecExporterChange?: (enabled: boolean) => void

    /** Preview shading uniforms; knob values are not persisted (section visibility is). */
    onPreviewShadingChange?: (params: PreviewShadingParams) => void

    /** SDF preview: scene-space normal RGB like mesh viewer (not persisted). */
    onPreviewNormalShadingChange?: (enabled: boolean) => void

    /** Callback to get current view as a benchmark case. Returns null if no active document. */
    onBenchmarkThisRequest?: () => BenchmarkCase | null

    /** Callback to get current viewport size for benchmark. When null, benchmark uses 800×600. */
    onGetViewportSize?: () => { width: number; height: number } | null

    /** After debug log toggles are persisted; apply flags and sync worker. */
    onDebugLogModulesChange?: () => void

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

    get bvhOptimization(): boolean {
        return this.#bvhOptimization$.value
    }

    set bvhOptimization(enabled: boolean) {
        this.#bvhOptimization$.next(enabled)
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

    get meshSimplifyOnExport(): boolean {
        return this.#meshSimplify$.value
    }

    set meshSimplifyOnExport(enabled: boolean) {
        this.#meshSimplify$.next(enabled)
    }

    get useShrecExporter(): boolean {
        return this.#useShrec$.value
    }

    set useShrecExporter(enabled: boolean) {
        this.#useShrec$.next(enabled)
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
        .shade-head {
            font-size: 10px;
            opacity: 0.75;
            margin-top: 6px;
            align-self: stretch;
        }
        .shade-row {
            display: flex;
            align-items: center;
            gap: 6px;
            width: 100%;
        }
        .shade-row label.knob-label {
            flex: 0 0 92px;
            font-size: 11px;
            cursor: default;
        }
        .shade-row input[type="range"] {
            flex: 1;
            min-width: 0;
            margin: 0;
        }
        .shade-val {
            flex: 0 0 44px;
            text-align: right;
            font-variant-numeric: tabular-nums;
            font-size: 11px;
        }
        .lighting-section {
            display: flex;
            flex-direction: column;
            gap: 2px;
            align-self: stretch;
            width: 100%;
        }
        .lighting-section > .shade-head {
            margin-top: 2px;
        }
        .lighting-section[hidden] {
            display: none !important;
        }
        .debug-log-list {
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            gap: 1px;
            align-self: start;
        }
        .debug-log-list label {
            font-size: 11px;
            display: flex;
            align-items: center;
            gap: 4px;
            width: max-content;
        }
`
        shadow.appendChild(style)

        const g = this.#settings.getGlobal().app
        this.#showFps$ = new BehaviorSubject(g.showFps)
        this.#meshViewer$ = new BehaviorSubject(g.meshViewerEnabled)
        this.#meshSimplify$ = new BehaviorSubject(g.meshSimplifyOnExport)
        this.#useShrec$ = new BehaviorSubject(g.useShrecExporter)
        this.#cameraOptimization$ = new BehaviorSubject(true)
        this.#beamOptimization$ = new BehaviorSubject(false)
        this.#bvhOptimization$ = new BehaviorSubject(true)

        this.#lightingExpanded$ = new BehaviorSubject(g.devToolsLightingExpanded)
        this.#lightingSection = document.createElement("div")
        this.#lightingSection.className = "lighting-section"
        this.#lightingSection.hidden = !this.#lightingExpanded$.value

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

        this.#meshSimplifyCheckbox = this.#addCheckbox(shadow, "Mesh simplify", this.#meshSimplify$.value)
        this.#subscriptions.push(connectCheckbox(this.#meshSimplifyCheckbox, this.#meshSimplify$))
        this.#meshSimplify$.pipe(skip(1)).subscribe(v => {
            this.#settings.updateGlobal({ app: { meshSimplifyOnExport: v } })
            this.onMeshSimplifyChange?.(v)
        })

        this.#useShrecCheckbox = this.#addCheckbox(shadow, "SHREC exporter", this.#useShrec$.value)
        this.#subscriptions.push(connectCheckbox(this.#useShrecCheckbox, this.#useShrec$))
        this.#useShrec$.pipe(skip(1)).subscribe(v => {
            this.#settings.updateGlobal({ app: { useShrecExporter: v } })
            this.onUseShrecExporterChange?.(v)
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

        this.#bvhOptCheckbox = this.#addCheckbox(shadow, "BVH optimize", this.#bvhOptimization$.value)
        this.#subscriptions.push(connectCheckbox(this.#bvhOptCheckbox, this.#bvhOptimization$))
        this.#bvhOptimization$.pipe(skip(1)).subscribe(v => {
            this.onBvhOptimizationChange?.(v)
        })

        this.#normalPreviewCheckbox = this.#addCheckbox(shadow, "Normal mode", false)
        this.#normalPreviewCheckbox.addEventListener("change", () => {
            this.onPreviewNormalShadingChange?.(this.#normalPreviewCheckbox.checked)
        })

        const debugHead = document.createElement("div")
        debugHead.className = "shade-head"
        debugHead.textContent = "Logs"
        shadow.appendChild(debugHead)

        const debugAllRow = document.createElement("div")
        debugAllRow.style.display = "flex"
        debugAllRow.style.gap = "6px"
        debugAllRow.style.flexWrap = "wrap"
        const allOn = document.createElement("button")
        allOn.textContent = "All on"
        const allOff = document.createElement("button")
        allOff.textContent = "All off"
        const setAllDebugLogs = (on: boolean) => {
            const base = { ...this.#settings.getGlobal().app.debugLogModules }
            for (const mod of DEBUG_LOG_MODULES) {
                base[mod] = on
                const cb = this.#debugLogCheckboxes.get(mod)
                if (cb) cb.checked = on
            }
            this.#settings.updateGlobal({ app: { debugLogModules: base } })
            this.onDebugLogModulesChange?.()
        }
        allOn.addEventListener("click", () => setAllDebugLogs(true))
        allOff.addEventListener("click", () => setAllDebugLogs(false))
        debugAllRow.append(allOn, allOff)
        shadow.appendChild(debugAllRow)

        const debugLogGrid = document.createElement("div")
        debugLogGrid.className = "debug-log-list"
        shadow.appendChild(debugLogGrid)

        for (const mod of DEBUG_LOG_MODULES) {
            const checked = g.debugLogModules?.[mod] === true
            const cb = this.#addCheckbox(debugLogGrid, mod, checked)
            this.#debugLogCheckboxes.set(mod, cb)
            cb.addEventListener("change", () => {
                const next = { ...this.#settings.getGlobal().app.debugLogModules, [mod]: cb.checked }
                this.#settings.updateGlobal({ app: { debugLogModules: next } })
                this.onDebugLogModulesChange?.()
            })
        }

        this.#lightingExpandedCheckbox = this.#addCheckbox(shadow, "Show lighting", this.#lightingExpanded$.value)
        this.#subscriptions.push(connectCheckbox(this.#lightingExpandedCheckbox, this.#lightingExpanded$))
        this.#lightingExpanded$.pipe(skip(1)).subscribe(v => {
            this.#settings.updateGlobal({ app: { devToolsLightingExpanded: v } })
            this.#lightingSection.hidden = !v
        })
        shadow.appendChild(this.#lightingSection)

        const shadeHead = document.createElement("div")
        shadeHead.className = "shade-head"
        shadeHead.textContent = "Preview lighting"
        this.#lightingSection.appendChild(shadeHead)

        for (const k of PREVIEW_SHADING_KNOBS) {
            const row = document.createElement("div")
            row.className = "shade-row"
            const lab = document.createElement("label")
            lab.className = "knob-label"
            lab.textContent = k.label
            const range = document.createElement("input")
            range.type = "range"
            range.min = String(k.min)
            range.max = String(k.max)
            range.step = String(k.step)
            const v0 = this.#shadingState[k.key]
            range.value = String(v0)
            const valueEl = document.createElement("span")
            valueEl.className = "shade-val"
            valueEl.textContent = DevToolsPanel.#formatShadeValue(k.key, v0)
            range.addEventListener("input", () => {
                const v = parseFloat(range.value)
                this.#shadingState[k.key] = v
                valueEl.textContent = DevToolsPanel.#formatShadeValue(k.key, v)
                this.onPreviewShadingChange?.({ ...this.#shadingState })
            })
            row.append(lab, range, valueEl)
            this.#lightingSection.appendChild(row)
            this.#shadingRows.set(k.key, { range, valueEl })
        }

        const shadeDefaults = document.createElement("button")
        shadeDefaults.textContent = "Lighting defaults"
        shadeDefaults.addEventListener("click", () => {
            this.#shadingState = { ...DEFAULT_PREVIEW_SHADING }
            for (const knob of PREVIEW_SHADING_KNOBS) {
                const row = this.#shadingRows.get(knob.key)!
                const v = this.#shadingState[knob.key]
                row.range.value = String(v)
                row.valueEl.textContent = DevToolsPanel.#formatShadeValue(knob.key, v)
            }
            this.onPreviewShadingChange?.({ ...this.#shadingState })
        })
        this.#lightingSection.appendChild(shadeDefaults)

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
        benchmarkButton.textContent = "Bench Suite"
        benchmarkButton.addEventListener("click", async () => {
            benchmarkButton.disabled = true
            try {
                await this.#runBenchmark()
            } finally {
                benchmarkButton.disabled = false
            }
        })
        shadow.appendChild(benchmarkButton)

        // Benchmark this button (current view, no save)
        const benchmarkThisButton = document.createElement("button")
        benchmarkThisButton.textContent = "Benchmark"
        benchmarkThisButton.addEventListener("click", async () => {
            benchmarkThisButton.disabled = true
            try {
                await this.#runBenchmarkThis()
            } finally {
                benchmarkThisButton.disabled = false
            }
        })
        shadow.appendChild(benchmarkThisButton)

        // Factory Reset button
        const factoryResetButton = document.createElement("button")
        factoryResetButton.textContent = "Factory Reset"
        factoryResetButton.addEventListener("click", () => this.factoryReset())
        shadow.appendChild(factoryResetButton)

        // Hidden by default
        this.style.display = "none"
    }

    /** Sync debug-log checkboxes from persisted settings (e.g. after storage load). */
    syncDebugLogModulesFromSettings(state: DebugLogModulesState): void {
        for (const mod of DEBUG_LOG_MODULES) {
            const cb = this.#debugLogCheckboxes.get(mod)
            if (cb) cb.checked = state[mod] === true
        }
    }

    /** Sync range UI from renderer (e.g. after settings load). */
    syncPreviewShadingFromRenderer(params: PreviewShadingParams): void {
        this.#shadingState = { ...params }
        for (const knob of PREVIEW_SHADING_KNOBS) {
            const row = this.#shadingRows.get(knob.key)
            if (!row) continue
            const v = params[knob.key]
            row.range.value = String(v)
            row.valueEl.textContent = DevToolsPanel.#formatShadeValue(knob.key, v)
        }
    }

    syncPreviewNormalShadingFromRenderer(enabled: boolean): void {
        this.#normalPreviewCheckbox.checked = enabled
    }

    static #formatShadeValue(key: keyof PreviewShadingParams, v: number): string {
        if (key === "specShininess" || key === "aoSteps") return String(Math.round(v))
        return v.toFixed(2)
    }

    #addCheckbox(parent: ParentNode, label: string, checked: boolean): HTMLInputElement {
        const el = document.createElement("label")
        const cb = document.createElement("input")
        cb.type = "checkbox"
        cb.checked = checked
        el.append(cb, label)
        parent.appendChild(el)
        return cb
    }

    disconnectedCallback() {
        for (const sub of this.#subscriptions) {
            sub.unsubscribe()
        }
        this.#subscriptions = []
    }

    async #saveBenchmarkSuite(): Promise<void> {
        await this.#settings.flushDocNow()
        const suite: BenchmarkCase[] = []
        for (const name of this.#tabs.documentNames) {
            const model = this.#tabs.getByName(name)
            const docSettings = await this.#settings.getDocumentSettings(name)
            if (model) {
                suite.push({
                    name,
                    source: model.getValue(),
                    camera: docSettings.camera,
                    preview: docSettings.preview,
                })
            }
        }
        await saveBenchmarkSuite(suite)
        const { StatusDialog } = await import("./status-dialog.mjs")
        const statusDialog = new StatusDialog(
            `Saved benchmark suite with ${suite.length} case(s) to storage.`,
            true
        )
        await statusDialog.show()
    }

    async #runBenchmark(): Promise<void> {
        const { StatusDialog } = await import("./status-dialog.mjs")
        const suite = await loadBenchmarkSuite()
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
            const viewport = this.onGetViewportSize?.() ?? undefined
            const results = await runBenchmarkSuite(suite, undefined, viewport)

            log("App").info("Benchmark Results:")
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

    async #runBenchmarkThis(): Promise<void> {
        const { StatusDialog } = await import("./status-dialog.mjs")
        const benchCase = this.onBenchmarkThisRequest?.() ?? null
        if (!benchCase) {
            const statusDialog = new StatusDialog(
                "No active document. Open a document to benchmark the current view.",
                true
            )
            await statusDialog.show()
            return
        }

        const statusDialog = new StatusDialog("Running benchmark...", false)
        const dialogPromise = statusDialog.show()

        try {
            const viewport = this.onGetViewportSize?.() ?? undefined
            const results = await runBenchmarkSuite([benchCase], undefined, viewport)

            log("App").info("Benchmark this Results:")
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

    /** Public API for console: factoryReset() */
    async factoryReset(): Promise<void> {
        return this.#doFactoryReset()
    }

    async #doFactoryReset(): Promise<void> {
        const { YesNoDialog } = await import("./yesno-dialog.mjs")
        const dialog = new YesNoDialog(
            "Clear all localStorage, IndexedDB, and CacheStorage, then reload? This cannot be undone."
        )
        const confirmed = await dialog.show()
        if (!confirmed) return

        localStorage.clear()
        sessionStorage.clear()

        const dbNames = await indexedDB.databases()
        await Promise.all(
            (dbNames ?? [])
                .filter((db): db is { name: string } => !!db.name)
                .map(
                    ({ name }) =>
                        new Promise<void>((resolve, reject) => {
                            const req = indexedDB.deleteDatabase(name)
                            req.onsuccess = () => resolve()
                            req.onerror = () => reject(req.error)
                        })
                )
        )

        const cacheNames = await caches.keys()
        await Promise.all(cacheNames.map((name) => caches.delete(name)))

        location.reload()
    }
}

customElements.define("dev-tools-panel", DevToolsPanel)

declare global {
    interface HTMLElementTagNameMap {
        "dev-tools-panel": DevToolsPanel
    }
}
