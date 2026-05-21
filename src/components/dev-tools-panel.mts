import { __fg_color, __tone_2 } from "../style/style.mjs"
import { SettingsManager } from "../storage/settings.mjs"
import type { DocumentTabs } from "./document-tabs.mjs"
import {
    loadBenchmarkSuite,
    saveBenchmarkSuite,
    runBenchmarkSuite,
    formatBenchmarkResultsHtml,
    type BenchmarkCase,
} from "../benchmark/benchmark.mjs"
import type {
    ExporterKind,
    IsoSimplicialTuning,
    MdcExportLevers,
    RayMarchParams,
    ShrecTuning,
    SimplifyTuning,
} from "../render-worker-protocol.mjs"
import { log, type DebugLogModulesState } from "../logging/debug-log.mjs"
import {
    DEFAULT_APP_DEVTOOLS_STATE,
    DEVTOOLS_COLLAPSE,
    DEVTOOLS_STATE_CHANGE_EVENT,
    isDevToolsPersistable,
    type DevToolsPersistable,
    type JSONValue,
} from "./dev-tools-protocol.mjs"
import { DevToolsAppSection } from "./dev-tools-app-section.mjs"
import { DevToolsMeshExportCoreSection, DevToolsMeshSimplifySection, DevToolsShrecExportSection } from "./dev-tools-mesh-export-section.mjs"
import { DevToolsLogsSection } from "./dev-tools-logs-section.mjs"
import { DevToolsRendererSection } from "./dev-tools-renderer-section.mjs"
import "./dev-tools-collapse.mjs"
import { serializeAgentTestcaseYaml, type AgentTestcase } from "../agent-autotest/agent-testcase.mjs"

export type DevToolsSectionScope = "global" | "document"

export type DevToolsSectionRegistration = {
    element: HTMLElement
    scope?: DevToolsSectionScope
    order?: number
}

export class DevToolsPanel extends HTMLElement {
    #settings: SettingsManager
    #tabs: DocumentTabs
    #appSection: DevToolsAppSection
    #meshExportCoreSection: DevToolsMeshExportCoreSection
    #meshSimplifySection: DevToolsMeshSimplifySection
    #shrecExportSection: DevToolsShrecExportSection
    #rendererSection: DevToolsRendererSection
    #logsSection: DevToolsLogsSection
    #extraSectionHosts: HTMLDivElement[] = []
    #debounceTimers = new Map<string, number>()
    #persistListener: ((e: Event) => void) | null = null
    #shadow: ShadowRoot
    #benchmarkSectionEl: HTMLElement

    /** Callback when camera optimization changes */
    onCameraOptimizationChange?: (enabled: boolean) => void
    onBeamOptimizationChange?: (enabled: boolean) => void
    onBvhOptimizationChange?: (enabled: boolean) => void
    onFeatureGraphOverlayChange?: (enabled: boolean) => void
    onShowFpsChange?: (enabled: boolean) => void
    onMeshViewerChange?: (enabled: boolean) => void
    onMeshSimplifyChange?: (enabled: boolean) => void
    onVoxelSizeMmChange?: (mm: number) => void
    onMeshExporterChange?: (exporter: ExporterKind) => void
    onIsoSimplicialTuningChange?: (tuning: IsoSimplicialTuning) => void
    onShrecTuningChange?: (tuning: ShrecTuning) => void
    onSimplifyTuningChange?: (tuning: SimplifyTuning) => void
    onMdcExportLeversChange?: () => void
    onRayMarchParamsChange?: (params: RayMarchParams) => void
    onBenchmarkThisRequest?: () => BenchmarkCase | null
    onGetViewportSize?: () => { width: number; height: number } | null

    /**
     * Serialize current scene + camera + mesh export settings for agent replay.
     * Returns null when no active document or capture fails.
     */
    onAgentTestcaseExportRequest?: () => AgentTestcase | null

    /** After debug log toggles are persisted; apply flags and sync worker. */
    onDebugLogModulesChange?: () => void

    get appSection(): DevToolsAppSection {
        return this.#appSection
    }

    get rendererSection(): DevToolsRendererSection {
        return this.#rendererSection
    }

    get logsSection(): DevToolsLogsSection {
        return this.#logsSection
    }

    get cameraOptimization(): boolean {
        return this.#rendererSection.cameraOptimization
    }

    set cameraOptimization(enabled: boolean) {
        this.#rendererSection.cameraOptimization = enabled
    }

    get beamOptimization(): boolean {
        return this.#rendererSection.beamOptimization
    }

    set beamOptimization(enabled: boolean) {
        this.#rendererSection.beamOptimization = enabled
    }

    get bvhOptimization(): boolean {
        return this.#rendererSection.bvhOptimization
    }

    set bvhOptimization(enabled: boolean) {
        this.#rendererSection.bvhOptimization = enabled
    }

    get featureGraphOverlay(): boolean {
        return this.#rendererSection.featureGraphOverlay
    }

    set featureGraphOverlay(enabled: boolean) {
        this.#rendererSection.featureGraphOverlay = enabled
    }

    get showFps(): boolean {
        return this.#appSection.showFps
    }

    set showFps(enabled: boolean) {
        this.#appSection.showFps = enabled
    }

    get meshViewer(): boolean {
        return this.#appSection.meshViewer
    }

    set meshViewer(enabled: boolean) {
        this.#appSection.meshViewer = enabled
    }

    get meshSimplifyOnExport(): boolean {
        return this.#appSection.meshSimplifyOnExport
    }

    set meshSimplifyOnExport(enabled: boolean) {
        this.#appSection.meshSimplifyOnExport = enabled
    }

    get voxelSizeMm(): number {
        return this.#meshExportCoreSection.voxelSizeMm
    }

    set voxelSizeMm(mm: number) {
        this.#meshExportCoreSection.voxelSizeMm = mm
    }

    get meshExporter(): ExporterKind {
        return this.#meshExportCoreSection.meshExporter
    }

    set meshExporter(v: ExporterKind) {
        this.#meshExportCoreSection.meshExporter = v
    }

    get isoSimplicialTuning(): IsoSimplicialTuning {
        return this.#meshExportCoreSection.isoSimplicialTuning
    }

    get shrecTuning(): ShrecTuning {
        return this.#shrecExportSection.shrecTuning
    }

    get simplifyTuning(): SimplifyTuning {
        return this.#meshSimplifySection.simplifyTuning
    }

    syncVoxelSizeMmFromSettings(mm: number): void {
        this.#meshExportCoreSection.syncVoxelSizeMmFromSettings(mm)
    }

    syncSimplifyTuningFromSettings(tuning: SimplifyTuning): void {
        this.#meshSimplifySection.syncSimplifyTuningFromSettings(tuning)
        this.#meshExportCoreSection.syncRenormalizeFromSimplifyTuning(tuning)
    }

    syncMdcLeversFromSettings(levers: MdcExportLevers): void {
        this.#meshExportCoreSection.syncMdcLeversFromSettings(levers)
    }

    syncMeshExporterFromSettings(exporter: ExporterKind): void {
        this.#meshExportCoreSection.syncMeshExporterFromSettings(exporter)
    }

    syncIsoSimplicialTuningFromSettings(tuning: IsoSimplicialTuning): void {
        this.#meshExportCoreSection.syncIsoSimplicialTuningFromSettings(tuning)
    }

    syncShrecTuningFromSettings(tuning: ShrecTuning): void {
        this.#shrecExportSection.syncShrecTuningFromSettings(tuning)
    }

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

        this.#shadow = this.attachShadow({ mode: "open" })

        const style = document.createElement("style")
        style.textContent = `
        :host {
            position: absolute;
            top: 12px;
            right: 10px;
            z-index: 1;
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            gap: 6px;
            box-sizing: border-box;
            max-width: 20%;
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
        .extra-slot {
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            gap: 6px;
            align-self: stretch;
        }
`
        this.#shadow.appendChild(style)

        this.#appSection = new DevToolsAppSection()
        this.#meshExportCoreSection = new DevToolsMeshExportCoreSection()
        this.#meshSimplifySection = new DevToolsMeshSimplifySection()
        this.#shrecExportSection = new DevToolsShrecExportSection()
        this.#rendererSection = new DevToolsRendererSection()
        this.#logsSection = new DevToolsLogsSection()

        this.#meshExportCoreSection.onVoxelSizeMmChange = v => this.onVoxelSizeMmChange?.(v)
        this.#meshExportCoreSection.onMdcExportLeversChange = () => this.onMdcExportLeversChange?.()
        this.#meshExportCoreSection.onSimplifyTuningChange = v => this.onSimplifyTuningChange?.(v)
        this.#meshExportCoreSection.onMeshExporterChange = v => this.onMeshExporterChange?.(v)
        this.#meshExportCoreSection.onIsoSimplicialTuningChange = v => this.onIsoSimplicialTuningChange?.(v)

        this.#meshSimplifySection.onSimplifyTuningChange = v => this.onSimplifyTuningChange?.(v)

        this.#shrecExportSection.onShrecTuningChange = v => this.onShrecTuningChange?.(v)

        this.#rendererSection.onCameraOptimizationChange = v => this.onCameraOptimizationChange?.(v)
        this.#rendererSection.onBeamOptimizationChange = v => this.onBeamOptimizationChange?.(v)
        this.#rendererSection.onBvhOptimizationChange = v => this.onBvhOptimizationChange?.(v)
        this.#rendererSection.onFeatureGraphOverlayChange = v => this.onFeatureGraphOverlayChange?.(v)
        this.#rendererSection.onRayMarchParamsChange = p => this.onRayMarchParamsChange?.(p)

        this.#logsSection.onDebugLogModulesChange = () => this.onDebugLogModulesChange?.()

        this.#appSection.addEventListener("galacticad-show-fps-change", () => {
            this.onShowFpsChange?.(this.#appSection.showFps)
        })
        this.#appSection.addEventListener("galacticad-mesh-viewer-change", () => {
            this.onMeshViewerChange?.(this.#appSection.meshViewer)
        })
        this.#appSection.addEventListener("galacticad-mesh-simplify-change", () => {
            this.onMeshSimplifyChange?.(this.#appSection.meshSimplifyOnExport)
        })

        const mkSection = (label: string, collapseId: string, ...nodes: Node[]) => {
            const wrap = document.createElement("dev-tools-collapse")
            wrap.setAttribute("label", label)
            wrap.setAttribute("collapse-id", collapseId)
            for (const n of nodes) wrap.appendChild(n)
            return wrap
        }

        this.#shadow.append(
            mkSection("App", DEVTOOLS_COLLAPSE.panelApp, this.#appSection),
            mkSection("Mesh export", DEVTOOLS_COLLAPSE.panelMeshExport, this.#meshExportCoreSection),
            mkSection("Mesh Simplify", DEVTOOLS_COLLAPSE.panelMeshSimplify, this.#meshSimplifySection),
            mkSection("SHREC export", DEVTOOLS_COLLAPSE.panelShrecExport, this.#shrecExportSection),
            mkSection("Renderer", DEVTOOLS_COLLAPSE.panelRenderer, this.#rendererSection),
            mkSection("Logs", DEVTOOLS_COLLAPSE.panelLogs, this.#logsSection),
        )

        this.#restorePersistableSection(this.#appSection)
        this.#restorePersistableSection(this.#logsSection)

        this.#persistListener = (ev: Event) => {
            if (!(ev instanceof CustomEvent)) return
            const id = (ev as CustomEvent<{ sectionId?: string }>).detail?.sectionId
            if (typeof id !== "string") return
            const t = ev.target
            if (!isDevToolsPersistable(t) || t.devToolsSectionId !== id) return
            this.#schedulePersistGlobal(id, t)
        }
        this.#shadow.addEventListener(DEVTOOLS_STATE_CHANGE_EVENT, this.#persistListener)

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

        const exportAgentTestcaseButton = document.createElement("button")
        exportAgentTestcaseButton.textContent = "Export agent testcase"
        exportAgentTestcaseButton.title =
            "Save YAML: scene source (multiline), camera, viewport, and mesh export settings for agent render replay"
        exportAgentTestcaseButton.addEventListener("click", async () => {
            exportAgentTestcaseButton.disabled = true
            try {
                await this.#exportAgentTestcaseToDisk()
            } finally {
                exportAgentTestcaseButton.disabled = false
            }
        })

        const benchmarkWrap = mkSection(
            "Benchmark",
            DEVTOOLS_COLLAPSE.panelBenchmark,
            saveSuiteButton,
            benchmarkButton,
            benchmarkThisButton,
            exportAgentTestcaseButton,
        )
        this.#benchmarkSectionEl = benchmarkWrap

        const factoryResetButton = document.createElement("button")
        factoryResetButton.textContent = "Factory Reset"
        factoryResetButton.addEventListener("click", () => this.factoryReset())

        const resetWrap = mkSection("Reset", DEVTOOLS_COLLAPSE.panelReset, factoryResetButton)

        this.#shadow.append(benchmarkWrap, resetWrap)

        this.style.display = "none"
    }

    /**
     * Append a custom dev tools block. When `element` implements `DevToolsPersistable` and
     * `scope` is `"global"`, state is restored from `app.devToolsSections` and changes are persisted.
     */
    registerSection(reg: DevToolsSectionRegistration): void {
        const scope = reg.scope ?? "global"
        const host = document.createElement("div")
        host.className = "extra-slot"
        host.appendChild(reg.element)
        const order = reg.order ?? 1000
        host.style.order = String(order)
        this.#extraSectionHosts.push(host)
        this.#shadow.insertBefore(host, this.#benchmarkSectionEl)

        if (scope === "document") {
            log("Settings").warn("registerSection: document scope not implemented; section mounted without persistence")
        }
        if (scope === "global" && isDevToolsPersistable(reg.element)) {
            this.#restorePersistableSection(reg.element)
        }
    }

    unregisterSection(element: HTMLElement): void {
        const host = this.#extraSectionHosts.find(h => h.contains(element))
        if (!host) return
        if (isDevToolsPersistable(element)) {
            this.#flushPersistTimer(element.devToolsSectionId)
            this.#settings.mergeGlobalDevToolsSection(element.devToolsSectionId, element.getDevToolsState() as Record<string, unknown>)
        }
        host.remove()
        const i = this.#extraSectionHosts.indexOf(host)
        if (i >= 0) this.#extraSectionHosts.splice(i, 1)
    }

    #restorePersistableSection(el: DevToolsPersistable): void {
        const saved = this.#settings.getGlobal().app.devToolsSections[el.devToolsSectionId]
        const defaults: Record<string, JSONValue> =
            el.devToolsSectionId === this.#appSection.devToolsSectionId ? { ...DEFAULT_APP_DEVTOOLS_STATE } : {}
        el.setDevToolsState({ ...defaults, ...(saved as Record<string, JSONValue>) })
    }

    #schedulePersistGlobal(sectionId: string, source: DevToolsPersistable): void {
        const prev = this.#debounceTimers.get(sectionId)
        if (prev !== undefined) clearTimeout(prev)
        this.#debounceTimers.set(
            sectionId,
            window.setTimeout(() => {
                this.#debounceTimers.delete(sectionId)
                this.#settings.mergeGlobalDevToolsSection(sectionId, source.getDevToolsState() as Record<string, unknown>)
            }, 100),
        )
    }

    #flushPersistTimer(sectionId: string): void {
        const t = this.#debounceTimers.get(sectionId)
        if (t !== undefined) {
            clearTimeout(t)
            this.#debounceTimers.delete(sectionId)
        }
    }

    syncDebugLogModulesFromSettings(state: DebugLogModulesState): void {
        this.#logsSection.syncFromSettings(state)
    }

    disconnectedCallback(): void {
        for (const t of this.#debounceTimers.values()) clearTimeout(t)
        this.#debounceTimers.clear()
        if (this.#persistListener) {
            this.#shadow.removeEventListener(DEVTOOLS_STATE_CHANGE_EVENT, this.#persistListener)
            this.#persistListener = null
        }
        this.#settings.mergeGlobalDevToolsSection(
            this.#appSection.devToolsSectionId,
            this.#appSection.getDevToolsState() as Record<string, unknown>,
        )
        this.#settings.mergeGlobalDevToolsSection(
            this.#logsSection.devToolsSectionId,
            this.#logsSection.getDevToolsState() as Record<string, unknown>,
        )
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
        const statusDialog = new StatusDialog(`Saved benchmark suite with ${suite.length} case(s) to storage.`, true)
        await statusDialog.show()
    }

    async #runBenchmark(): Promise<void> {
        const { StatusDialog } = await import("./status-dialog.mjs")
        const suite = await loadBenchmarkSuite()
        if (suite.length === 0) {
            const statusDialog = new StatusDialog("No benchmark suite found. Save a suite first using the Save Suite button.", true)
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
                    r.result.error ?
                        { document: r.name, error: r.result.error }
                    :   {
                            document: r.name,
                            "avg (ms)": r.result.averageFrameTime.toFixed(2),
                            fps: r.result.framesPerSecond.toFixed(2),
                            "min (ms)": r.result.minFrameTime.toFixed(2),
                            "max (ms)": r.result.maxFrameTime.toFixed(2),
                        },
                ),
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

    async #exportAgentTestcaseToDisk(): Promise<void> {
        const { StatusDialog } = await import("./status-dialog.mjs")
        const tc = this.onAgentTestcaseExportRequest?.() ?? null
        if (!tc) {
            const statusDialog = new StatusDialog("No active document. Open a document to export an agent testcase.", true)
            await statusDialog.show()
            return
        }

        try {
            const rawName = tc.documentName ?? "scene"
            const suggested = `${rawName.replace(/[^\w.-]+/g, "_")}-agent-testcase.yaml`
            const handle = await window.showSaveFilePicker({
                suggestedName: suggested,
                startIn: "desktop",
                types: [
                    {
                        description: "Agent testcase YAML",
                        accept: { "application/x-yaml": [".yaml", ".yml"] },
                    },
                ],
                excludeAcceptAllOption: false,
            })
            const writable = await handle.createWritable()
            await writable.write(serializeAgentTestcaseYaml(tc))
            await writable.close()
            const ok = new StatusDialog("Agent testcase saved")
            await ok.show()
        } catch (err) {
            if (`${err}`.includes("AbortError")) {
                return
            }
            const msg = err instanceof Error ? err.message : String(err)
            const statusDialog = new StatusDialog(`Could not save testcase: ${msg}`, true)
            await statusDialog.show()
        }
    }

    async #runBenchmarkThis(): Promise<void> {
        const { StatusDialog } = await import("./status-dialog.mjs")
        const benchCase = this.onBenchmarkThisRequest?.() ?? null
        if (!benchCase) {
            const statusDialog = new StatusDialog("No active document. Open a document to benchmark the current view.", true)
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
                    r.result.error ?
                        { document: r.name, error: r.result.error }
                    :   {
                            document: r.name,
                            "avg (ms)": r.result.averageFrameTime.toFixed(2),
                            fps: r.result.framesPerSecond.toFixed(2),
                            "min (ms)": r.result.minFrameTime.toFixed(2),
                            "max (ms)": r.result.maxFrameTime.toFixed(2),
                        },
                ),
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

    async factoryReset(): Promise<void> {
        return this.#doFactoryReset()
    }

    async #doFactoryReset(): Promise<void> {
        const { YesNoDialog } = await import("./yesno-dialog.mjs")
        const dialog = new YesNoDialog("Clear all localStorage, IndexedDB, and CacheStorage, then reload? This cannot be undone.")
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
                        }),
                ),
        )

        const cacheNames = await caches.keys()
        await Promise.all(cacheNames.map(name => caches.delete(name)))

        location.reload()
    }
}

customElements.define("dev-tools-panel", DevToolsPanel)

declare global {
    interface HTMLElementTagNameMap {
        "dev-tools-panel": DevToolsPanel
    }
}
