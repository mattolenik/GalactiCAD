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
    DEFAULT_MDC_EXPORT_LEVERS,
    DEFAULT_PREVIEW_SHADING,
    DEFAULT_SHREC_TUNING,
    DEFAULT_SIMPLIFY_TUNING,
    type MdcExportLevers,
    type PreviewShadingParams,
    type ShrecTuning,
    type SimplifyTuning,
} from "../render-worker-protocol.mjs"
import { DEBUG_LOG_MODULES, log, type DebugLogModulesState, type LogModule } from "../logging/debug-log.mjs"

/** Boolean fields on `SimplifyTuning` (meshoptimizer flags). */
type SimplifyBoolKey = "lockBorder" | "sparse" | "errorAbsolute" | "prune" | "regularize"

/** MDC-only knobs (voxel + mesh simplify use the shared sliders above). */
const MDC_RANGE_KNOBS: {
    key: keyof Pick<MdcExportLevers, "isoValue" | "creaseAngleDeg">
    label: string
    min: number
    max: number
    step: number
}[] = [
    { key: "isoValue", label: "Iso value", min: -0.2, max: 0.2, step: 0.002 },
    { key: "creaseAngleDeg", label: "Crease °", min: -1, max: 180, step: 1 },
]

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
    #voxelSizeMm$: BehaviorSubject<number>
    #voxelSizeRange: HTMLInputElement
    #voxelSizeValueEl: HTMLSpanElement
    #mdcExpandedCheckbox: HTMLInputElement
    #mdcExpanded$: BehaviorSubject<boolean>
    #mdcSection: HTMLDivElement
    #mdcRows = new Map<
        (typeof MDC_RANGE_KNOBS)[number]["key"],
        { range: HTMLInputElement; valueEl: HTMLSpanElement }
    >()
    #useShrecCheckbox: HTMLInputElement
    #useShrec$: BehaviorSubject<boolean>
    #shrecTuningState: ShrecTuning = { ...DEFAULT_SHREC_TUNING }
    #shrecMergeSharpCheckbox: HTMLInputElement
    #shrecRelCutoffRange: HTMLInputElement
    #shrecRelCutoffValueEl: HTMLSpanElement
    #shrecMaxDispRange: HTMLInputElement
    #shrecMaxDispValueEl: HTMLSpanElement
    #shrecCreaseRange: HTMLInputElement
    #shrecCreaseValueEl: HTMLSpanElement
    #shrecGradWeightRange: HTMLInputElement
    #shrecGradWeightValueEl: HTMLSpanElement
    #shrecDedupRange: HTMLInputElement
    #shrecDedupValueEl: HTMLSpanElement
    #shrecSeamAwareCheckbox: HTMLInputElement
    #shrecSeamAgreementRange: HTMLInputElement
    #shrecSeamAgreementValueEl: HTMLSpanElement
    #shrecEdgeFitCheckbox: HTMLInputElement
    #shrecSection: HTMLDivElement
    #simplifyTuningState: SimplifyTuning = { ...DEFAULT_SIMPLIFY_TUNING }
    #simplifySection: HTMLDivElement
    #simplifyTargetRatioRange: HTMLInputElement
    #simplifyTargetRatioValueEl: HTMLSpanElement
    #simplifyTargetErrorRange: HTMLInputElement
    #simplifyTargetErrorValueEl: HTMLSpanElement
    #simplifyNormalWeightRange: HTMLInputElement
    #simplifyNormalWeightValueEl: HTMLSpanElement
    #simplifyBoolCheckboxes: Map<SimplifyBoolKey, HTMLInputElement> = new Map()
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

    /** Callback when the mesh-export voxel-size slider changes (mm). */
    onVoxelSizeMmChange?: (mm: number) => void

    /** Callback when the SHREC/MergeSharp exporter toggle changes (off = MDC). */
    onUseShrecExporterChange?: (enabled: boolean) => void

    /** Callback when any SHREC tuning knob changes; receives the full tuning object. */
    onShrecTuningChange?: (tuning: ShrecTuning) => void

    /** Callback when MDC mesh simplification tuning changes. */
    onSimplifyTuningChange?: (tuning: SimplifyTuning) => void

    /** Callback when MDC iso/crease levers change (mesh export preview). */
    onMdcExportLeversChange?: () => void

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

    /** Mesh-export grid voxel size in mm. Master quality knob; affects MDC and SHREC equally. */
    get voxelSizeMm(): number {
        return this.#voxelSizeMm$.value
    }

    set voxelSizeMm(mm: number) {
        this.#voxelSizeMm$.next(mm)
    }

    /** Sync the voxel-size slider from persisted settings. */
    syncVoxelSizeMmFromSettings(mm: number): void {
        this.#voxelSizeMm$.next(mm)
        this.#voxelSizeRange.value = String(mm)
        this.#voxelSizeValueEl.textContent = DevToolsPanel.#formatVoxelSize(mm)
    }

    get useShrecExporter(): boolean {
        return this.#useShrec$.value
    }

    set useShrecExporter(enabled: boolean) {
        this.#useShrec$.next(enabled)
    }

    /** Read-only view of current SHREC tuning state (mutate via setter or sync method). */
    get shrecTuning(): ShrecTuning {
        return { ...this.#shrecTuningState }
    }

    get simplifyTuning(): SimplifyTuning {
        return { ...this.#simplifyTuningState }
    }

    /** Sync MDC simplification knobs from persisted settings. */
    syncSimplifyTuningFromSettings(tuning: SimplifyTuning): void {
        this.#simplifyTuningState = { ...tuning }
        this.#simplifyTargetRatioRange.value = String(tuning.targetRatio)
        this.#simplifyTargetRatioValueEl.textContent = DevToolsPanel.#formatSimplifyValue("targetRatio", tuning.targetRatio)
        this.#simplifyTargetErrorRange.value = String(tuning.targetError)
        this.#simplifyTargetErrorValueEl.textContent = DevToolsPanel.#formatSimplifyValue("targetError", tuning.targetError)
        this.#simplifyNormalWeightRange.value = String(tuning.normalWeight)
        this.#simplifyNormalWeightValueEl.textContent = DevToolsPanel.#formatSimplifyValue("normalWeight", tuning.normalWeight)
        for (const key of this.#simplifyBoolCheckboxes.keys()) {
            const cb = this.#simplifyBoolCheckboxes.get(key)!
            cb.checked = tuning[key]
        }
    }

    /** Sync SHREC knobs from persisted settings (e.g. after storage load). */
    /** Sync MDC iso/crease sliders from persisted settings (e.g. after storage load). */
    syncMdcLeversFromSettings(levers: MdcExportLevers): void {
        for (const k of MDC_RANGE_KNOBS) {
            const row = this.#mdcRows.get(k.key)
            if (!row) continue
            row.range.value = String(levers[k.key])
            row.valueEl.textContent = DevToolsPanel.#formatMdcValue(k.key, levers[k.key])
        }
    }

    syncShrecTuningFromSettings(tuning: ShrecTuning): void {
        this.#shrecTuningState = { ...tuning }
        this.#shrecMergeSharpCheckbox.checked = tuning.mergeSharpEnabled
        this.#shrecRelCutoffRange.value = String(tuning.mergeRelCutoff)
        this.#shrecRelCutoffValueEl.textContent = DevToolsPanel.#formatShrecValue("mergeRelCutoff", tuning.mergeRelCutoff)
        this.#shrecMaxDispRange.value = String(tuning.mergeMaxDisplacement)
        this.#shrecMaxDispValueEl.textContent = DevToolsPanel.#formatShrecValue("mergeMaxDisplacement", tuning.mergeMaxDisplacement)
        this.#shrecCreaseRange.value = String(tuning.creaseAngleDeg)
        this.#shrecCreaseValueEl.textContent = DevToolsPanel.#formatShrecValue("creaseAngleDeg", tuning.creaseAngleDeg)
        this.#shrecGradWeightRange.value = String(tuning.mergeGradientWeightPower)
        this.#shrecGradWeightValueEl.textContent = DevToolsPanel.#formatShrecValue("mergeGradientWeightPower", tuning.mergeGradientWeightPower)
        this.#shrecDedupRange.value = String(tuning.dedupRadiusVoxels)
        this.#shrecDedupValueEl.textContent = DevToolsPanel.#formatShrecValue("dedupRadiusVoxels", tuning.dedupRadiusVoxels)
        this.#shrecSeamAwareCheckbox.checked = tuning.seamAwareEnabled
        this.#shrecSeamAgreementRange.value = String(tuning.seamAgreementCosThreshold)
        this.#shrecSeamAgreementValueEl.textContent = DevToolsPanel.#formatShrecValue("seamAgreementCosThreshold", tuning.seamAgreementCosThreshold)
        this.#shrecEdgeFitCheckbox.checked = tuning.edgeFitEnabled
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
        this.#voxelSizeMm$ = new BehaviorSubject(g.meshExportVoxelSizeMm)
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

        // Voxel-size slider — the master quality / cost knob for mesh export.
        // Halving voxel size → ~8× the voxel count → ~8× the time and memory.
        // Applies to both MDC and SHREC; lives at the top level rather than in
        // the SHREC subsection because it's exporter-agnostic.
        {
            const row = document.createElement("div")
            row.className = "shade-row"
            const lab = document.createElement("label")
            lab.className = "knob-label"
            lab.textContent = "Voxel (mm)"
            const range = document.createElement("input")
            range.type = "range"
            range.min = "0.02"
            range.max = "0.5"
            range.step = "0.01"
            range.value = String(this.#voxelSizeMm$.value)
            const valueEl = document.createElement("span")
            valueEl.className = "shade-val"
            valueEl.textContent = DevToolsPanel.#formatVoxelSize(this.#voxelSizeMm$.value)
            range.addEventListener("input", () => {
                const v = parseFloat(range.value)
                this.#voxelSizeMm$.next(v)
                valueEl.textContent = DevToolsPanel.#formatVoxelSize(v)
            })
            row.append(lab, range, valueEl)
            shadow.appendChild(row)
            this.#voxelSizeRange = range
            this.#voxelSizeValueEl = valueEl
        }
        this.#voxelSizeMm$.pipe(skip(1)).subscribe(v => {
            this.#settings.updateGlobal({ app: { meshExportVoxelSizeMm: v } })
            this.onVoxelSizeMmChange?.(v)
        })

        this.#mdcExpanded$ = new BehaviorSubject(g.devToolsMdcExportExpanded)
        this.#mdcSection = document.createElement("div")
        this.#mdcSection.className = "lighting-section"
        this.#mdcSection.hidden = !this.#mdcExpanded$.value

        this.#mdcExpandedCheckbox = this.#addCheckbox(shadow, "Show MDC export", this.#mdcExpanded$.value)
        this.#subscriptions.push(connectCheckbox(this.#mdcExpandedCheckbox, this.#mdcExpanded$))
        this.#mdcExpanded$.pipe(skip(1)).subscribe(v => {
            this.#settings.updateGlobal({ app: { devToolsMdcExportExpanded: v } })
            this.#mdcSection.hidden = !v
        })
        shadow.appendChild(this.#mdcSection)

        const mdcHead = document.createElement("div")
        mdcHead.className = "shade-head"
        mdcHead.textContent = "Mesh export (MDC)"
        this.#mdcSection.appendChild(mdcHead)

        const mdcLevers = this.#settings.getMdcExportLevers()
        for (const k of MDC_RANGE_KNOBS) {
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
            range.value = String(mdcLevers[k.key])
            const valueEl = document.createElement("span")
            valueEl.className = "shade-val"
            valueEl.textContent = DevToolsPanel.#formatMdcValue(k.key, mdcLevers[k.key])
            range.addEventListener("input", () => {
                let v = parseFloat(range.value)
                if (!Number.isFinite(v)) v = k.min
                v = Math.max(k.min, Math.min(k.max, v))
                this.#settings.updateGlobal({
                    app: { mdcExportLevers: { [k.key]: v } },
                })
                valueEl.textContent = DevToolsPanel.#formatMdcValue(k.key, v)
                this.onMdcExportLeversChange?.()
            })
            row.append(lab, range, valueEl)
            this.#mdcSection.appendChild(row)
            this.#mdcRows.set(k.key, { range, valueEl })
        }

        const mdcDefaults = document.createElement("button")
        mdcDefaults.textContent = "MDC iso/crease defaults"
        mdcDefaults.addEventListener("click", () => {
            this.#settings.updateGlobal({
                app: {
                    mdcExportLevers: {
                        isoValue: DEFAULT_MDC_EXPORT_LEVERS.isoValue,
                        creaseAngleDeg: DEFAULT_MDC_EXPORT_LEVERS.creaseAngleDeg,
                    },
                },
            })
            const next = this.#settings.getGlobal().app.mdcExportLevers
            for (const knob of MDC_RANGE_KNOBS) {
                const row = this.#mdcRows.get(knob.key)
                if (!row) continue
                row.range.value = String(next[knob.key])
                row.valueEl.textContent = DevToolsPanel.#formatMdcValue(knob.key, next[knob.key])
            }
            this.onMdcExportLeversChange?.()
        })
        this.#mdcSection.appendChild(mdcDefaults)

        this.#simplifyTuningState = { ...DEFAULT_SIMPLIFY_TUNING, ...g.simplifyTuning }
        this.#simplifySection = document.createElement("div")
        this.#simplifySection.className = "lighting-section"
        shadow.appendChild(this.#simplifySection)

        const simpHead = document.createElement("div")
        simpHead.className = "shade-head"
        simpHead.textContent = "MDC simplification"
        this.#simplifySection.appendChild(simpHead)

        {
            const row = document.createElement("div")
            row.className = "shade-row"
            const lab = document.createElement("label")
            lab.className = "knob-label"
            lab.textContent = "Tri ratio"
            const range = document.createElement("input")
            range.type = "range"
            range.min = "0.01"
            range.max = "1"
            range.step = "0.01"
            range.value = String(this.#simplifyTuningState.targetRatio)
            const valueEl = document.createElement("span")
            valueEl.className = "shade-val"
            valueEl.textContent = DevToolsPanel.#formatSimplifyValue("targetRatio", this.#simplifyTuningState.targetRatio)
            range.addEventListener("input", () => {
                const v = parseFloat(range.value)
                this.#simplifyTuningState = { ...this.#simplifyTuningState, targetRatio: v }
                valueEl.textContent = DevToolsPanel.#formatSimplifyValue("targetRatio", v)
                this.#persistSimplifyTuning()
            })
            row.append(lab, range, valueEl)
            this.#simplifySection.appendChild(row)
            this.#simplifyTargetRatioRange = range
            this.#simplifyTargetRatioValueEl = valueEl
        }

        {
            const row = document.createElement("div")
            row.className = "shade-row"
            const lab = document.createElement("label")
            lab.className = "knob-label"
            lab.textContent = "Max error"
            const range = document.createElement("input")
            range.type = "range"
            range.min = "0.00005"
            range.max = "0.05"
            range.step = "0.00005"
            range.value = String(this.#simplifyTuningState.targetError)
            const valueEl = document.createElement("span")
            valueEl.className = "shade-val"
            valueEl.textContent = DevToolsPanel.#formatSimplifyValue("targetError", this.#simplifyTuningState.targetError)
            range.addEventListener("input", () => {
                const v = parseFloat(range.value)
                this.#simplifyTuningState = { ...this.#simplifyTuningState, targetError: v }
                valueEl.textContent = DevToolsPanel.#formatSimplifyValue("targetError", v)
                this.#persistSimplifyTuning()
            })
            row.append(lab, range, valueEl)
            this.#simplifySection.appendChild(row)
            this.#simplifyTargetErrorRange = range
            this.#simplifyTargetErrorValueEl = valueEl
        }

        {
            const row = document.createElement("div")
            row.className = "shade-row"
            const lab = document.createElement("label")
            lab.className = "knob-label"
            lab.textContent = "Normal wt"
            const range = document.createElement("input")
            range.type = "range"
            range.min = "0"
            range.max = "4"
            range.step = "0.05"
            range.value = String(this.#simplifyTuningState.normalWeight)
            const valueEl = document.createElement("span")
            valueEl.className = "shade-val"
            valueEl.textContent = DevToolsPanel.#formatSimplifyValue("normalWeight", this.#simplifyTuningState.normalWeight)
            range.addEventListener("input", () => {
                const v = parseFloat(range.value)
                this.#simplifyTuningState = { ...this.#simplifyTuningState, normalWeight: v }
                valueEl.textContent = DevToolsPanel.#formatSimplifyValue("normalWeight", v)
                this.#persistSimplifyTuning()
            })
            row.append(lab, range, valueEl)
            this.#simplifySection.appendChild(row)
            this.#simplifyNormalWeightRange = range
            this.#simplifyNormalWeightValueEl = valueEl
        }

        const simplifyBoolRows: { key: SimplifyBoolKey; label: string }[] = [
            { key: "lockBorder", label: "Lock border" },
            { key: "sparse", label: "Sparse" },
            { key: "errorAbsolute", label: "Absolute error" },
            { key: "prune", label: "Prune" },
            { key: "regularize", label: "Regularize" },
        ]
        for (const { key, label } of simplifyBoolRows) {
            const cb = this.#addCheckbox(this.#simplifySection, label, this.#simplifyTuningState[key])
            this.#simplifyBoolCheckboxes.set(key, cb)
            cb.addEventListener("change", () => {
                const next: SimplifyTuning = { ...this.#simplifyTuningState }
                next[key] = cb.checked
                this.#simplifyTuningState = next
                this.#persistSimplifyTuning()
            })
        }

        const simplifyDefaults = document.createElement("button")
        simplifyDefaults.textContent = "Simplify defaults"
        simplifyDefaults.addEventListener("click", () => {
            this.syncSimplifyTuningFromSettings({ ...DEFAULT_SIMPLIFY_TUNING })
            this.#persistSimplifyTuning()
        })
        this.#simplifySection.appendChild(simplifyDefaults)

        this.#useShrecCheckbox = this.#addCheckbox(shadow, "SHREC exporter", this.#useShrec$.value)
        this.#subscriptions.push(connectCheckbox(this.#useShrecCheckbox, this.#useShrec$))
        this.#useShrec$.pipe(skip(1)).subscribe(v => {
            this.#settings.updateGlobal({ app: { useShrecExporter: v } })
            this.onUseShrecExporterChange?.(v)
        })

        // SHREC tuning subsection (visible regardless of toggle so it can be
        // dialled in pre-flight; values only take effect when the SHREC
        // exporter is selected and `mergeSharpEnabled` is true).
        this.#shrecTuningState = { ...DEFAULT_SHREC_TUNING, ...g.shrecTuning }
        this.#shrecSection = document.createElement("div")
        this.#shrecSection.className = "lighting-section"
        shadow.appendChild(this.#shrecSection)

        const shrecHead = document.createElement("div")
        shrecHead.className = "shade-head"
        shrecHead.textContent = "SHREC tuning"
        this.#shrecSection.appendChild(shrecHead)

        // MergeSharp on/off (within SHREC). When false, plain DC mass-point
        // output is returned — useful for A/B testing the relocation pass.
        this.#shrecMergeSharpCheckbox = this.#addCheckbox(this.#shrecSection, "MergeSharp", this.#shrecTuningState.mergeSharpEnabled)
        this.#shrecMergeSharpCheckbox.addEventListener("change", () => {
            this.#shrecTuningState = { ...this.#shrecTuningState, mergeSharpEnabled: this.#shrecMergeSharpCheckbox.checked }
            this.#persistShrecTuning()
        })

        // Rel cutoff slider: smaller → more vertices snap to detected features.
        {
            const row = document.createElement("div")
            row.className = "shade-row"
            const lab = document.createElement("label")
            lab.className = "knob-label"
            lab.textContent = "Rel cutoff"
            const range = document.createElement("input")
            range.type = "range"
            range.min = "0.005"
            range.max = "0.5"
            range.step = "0.005"
            range.value = String(this.#shrecTuningState.mergeRelCutoff)
            const valueEl = document.createElement("span")
            valueEl.className = "shade-val"
            valueEl.textContent = DevToolsPanel.#formatShrecValue("mergeRelCutoff", this.#shrecTuningState.mergeRelCutoff)
            range.addEventListener("input", () => {
                const v = parseFloat(range.value)
                this.#shrecTuningState = { ...this.#shrecTuningState, mergeRelCutoff: v }
                valueEl.textContent = DevToolsPanel.#formatShrecValue("mergeRelCutoff", v)
                this.#persistShrecTuning()
            })
            row.append(lab, range, valueEl)
            this.#shrecSection.appendChild(row)
            this.#shrecRelCutoffRange = range
            this.#shrecRelCutoffValueEl = valueEl
        }

        // Max displacement slider (mm). 0 = disabled (only cell-bounds clamp applies).
        {
            const row = document.createElement("div")
            row.className = "shade-row"
            const lab = document.createElement("label")
            lab.className = "knob-label"
            lab.textContent = "Max disp (mm)"
            const range = document.createElement("input")
            range.type = "range"
            range.min = "0"
            range.max = "2"
            range.step = "0.05"
            range.value = String(this.#shrecTuningState.mergeMaxDisplacement)
            const valueEl = document.createElement("span")
            valueEl.className = "shade-val"
            valueEl.textContent = DevToolsPanel.#formatShrecValue("mergeMaxDisplacement", this.#shrecTuningState.mergeMaxDisplacement)
            range.addEventListener("input", () => {
                const v = parseFloat(range.value)
                this.#shrecTuningState = { ...this.#shrecTuningState, mergeMaxDisplacement: v }
                valueEl.textContent = DevToolsPanel.#formatShrecValue("mergeMaxDisplacement", v)
                this.#persistShrecTuning()
            })
            row.append(lab, range, valueEl)
            this.#shrecSection.appendChild(row)
            this.#shrecMaxDispRange = range
            this.#shrecMaxDispValueEl = valueEl
        }

        // Crease angle slider (deg). 180 = no splitting (single smooth group),
        // 0 = every triangle its own face. -1 skips the crease-split pass. Default 30.
        {
            const row = document.createElement("div")
            row.className = "shade-row"
            const lab = document.createElement("label")
            lab.className = "knob-label"
            lab.textContent = "Crease (°)"
            const range = document.createElement("input")
            range.type = "range"
            range.min = "-1"
            range.max = "180"
            range.step = "1"
            range.value = String(this.#shrecTuningState.creaseAngleDeg)
            const valueEl = document.createElement("span")
            valueEl.className = "shade-val"
            valueEl.textContent = DevToolsPanel.#formatShrecValue("creaseAngleDeg", this.#shrecTuningState.creaseAngleDeg)
            range.addEventListener("input", () => {
                const v = parseFloat(range.value)
                this.#shrecTuningState = { ...this.#shrecTuningState, creaseAngleDeg: v }
                valueEl.textContent = DevToolsPanel.#formatShrecValue("creaseAngleDeg", v)
                this.#persistShrecTuning()
            })
            row.append(lab, range, valueEl)
            this.#shrecSection.appendChild(row)
            this.#shrecCreaseRange = range
            this.#shrecCreaseValueEl = valueEl
        }

        // Gradient-weight power slider. 0 = uniform weights (every crossing
        // counts the same; current default). 1 = linear weighting w = g.
        // 2 = squared weighting w = g² (the IJK reference). Higher = even
        // more aggressive de-weighting of smooth-blend regions where g < 1.
        // Has no visible effect on scenes built from true SDFs only.
        {
            const row = document.createElement("div")
            row.className = "shade-row"
            const lab = document.createElement("label")
            lab.className = "knob-label"
            lab.textContent = "Grad weight"
            const range = document.createElement("input")
            range.type = "range"
            range.min = "0"
            range.max = "4"
            range.step = "0.1"
            range.value = String(this.#shrecTuningState.mergeGradientWeightPower)
            const valueEl = document.createElement("span")
            valueEl.className = "shade-val"
            valueEl.textContent = DevToolsPanel.#formatShrecValue("mergeGradientWeightPower", this.#shrecTuningState.mergeGradientWeightPower)
            range.addEventListener("input", () => {
                const v = parseFloat(range.value)
                this.#shrecTuningState = { ...this.#shrecTuningState, mergeGradientWeightPower: v }
                valueEl.textContent = DevToolsPanel.#formatShrecValue("mergeGradientWeightPower", v)
                this.#persistShrecTuning()
            })
            row.append(lab, range, valueEl)
            this.#shrecSection.appendChild(row)
            this.#shrecGradWeightRange = range
            this.#shrecGradWeightValueEl = valueEl
        }

        // Dedup radius slider (in voxels). 0 = off (no merging). 0.5 = typical
        // for collapsing CSG-corner clusters into a single shared vertex.
        // 1.0 = aggressive (can also collapse across edge-shared cells).
        // This is the "Merge" half of MergeSharp's name.
        {
            const row = document.createElement("div")
            row.className = "shade-row"
            const lab = document.createElement("label")
            lab.className = "knob-label"
            lab.textContent = "Dedup (vx)"
            const range = document.createElement("input")
            range.type = "range"
            range.min = "0"
            range.max = "1"
            range.step = "0.05"
            range.value = String(this.#shrecTuningState.dedupRadiusVoxels)
            const valueEl = document.createElement("span")
            valueEl.className = "shade-val"
            valueEl.textContent = DevToolsPanel.#formatShrecValue("dedupRadiusVoxels", this.#shrecTuningState.dedupRadiusVoxels)
            range.addEventListener("input", () => {
                const v = parseFloat(range.value)
                this.#shrecTuningState = { ...this.#shrecTuningState, dedupRadiusVoxels: v }
                valueEl.textContent = DevToolsPanel.#formatShrecValue("dedupRadiusVoxels", v)
                this.#persistShrecTuning()
            })
            row.append(lab, range, valueEl)
            this.#shrecSection.appendChild(row)
            this.#shrecDedupRange = range
            this.#shrecDedupValueEl = valueEl
        }

        // Seam-aware QEF toggle. When on, cells whose corner voxels report
        // a coherent CSG seam tangent are solved with a 1D constrained
        // QEF along the known seam line — eliminates residual sub-voxel
        // jitter that the unconstrained Tikhonov path leaves on long
        // sharp edges.
        this.#shrecSeamAwareCheckbox = this.#addCheckbox(this.#shrecSection, "Seam-aware QEF", this.#shrecTuningState.seamAwareEnabled)
        this.#shrecSeamAwareCheckbox.addEventListener("change", () => {
            this.#shrecTuningState = { ...this.#shrecTuningState, seamAwareEnabled: this.#shrecSeamAwareCheckbox.checked }
            this.#persistShrecTuning()
        })

        // Seam tangent-agreement threshold (cos-of-angle). Higher values
        // are stricter (fewer cells admitted to the seam path); lower
        // values admit more cells but risk over-constraining cells that
        // are near a seam but not on a single line.
        {
            const row = document.createElement("div")
            row.className = "shade-row"
            const lab = document.createElement("label")
            lab.className = "knob-label"
            lab.textContent = "Seam agree"
            const range = document.createElement("input")
            range.type = "range"
            range.min = "0.5"
            range.max = "1"
            range.step = "0.01"
            range.value = String(this.#shrecTuningState.seamAgreementCosThreshold)
            const valueEl = document.createElement("span")
            valueEl.className = "shade-val"
            valueEl.textContent = DevToolsPanel.#formatShrecValue("seamAgreementCosThreshold", this.#shrecTuningState.seamAgreementCosThreshold)
            range.addEventListener("input", () => {
                const v = parseFloat(range.value)
                this.#shrecTuningState = { ...this.#shrecTuningState, seamAgreementCosThreshold: v }
                valueEl.textContent = DevToolsPanel.#formatShrecValue("seamAgreementCosThreshold", v)
                this.#persistShrecTuning()
            })
            row.append(lab, range, valueEl)
            this.#shrecSection.appendChild(row)
            this.#shrecSeamAgreementRange = range
            this.#shrecSeamAgreementValueEl = valueEl
        }

        // Edge-fit refinement toggle. When on, post-MergeSharp groups
        // seam-classified cells into chains and projects each chain's
        // vertices onto an SVD-fitted line — eliminates per-cell QEF
        // jitter on long CSG seams. Off-by-toggle for A/B comparison.
        this.#shrecEdgeFitCheckbox = this.#addCheckbox(this.#shrecSection, "Edge fit (line)", this.#shrecTuningState.edgeFitEnabled)
        this.#shrecEdgeFitCheckbox.addEventListener("change", () => {
            this.#shrecTuningState = { ...this.#shrecTuningState, edgeFitEnabled: this.#shrecEdgeFitCheckbox.checked }
            this.#persistShrecTuning()
        })

        const shrecDefaults = document.createElement("button")
        shrecDefaults.textContent = "SHREC defaults"
        shrecDefaults.addEventListener("click", () => {
            this.syncShrecTuningFromSettings({ ...DEFAULT_SHREC_TUNING })
            this.#persistShrecTuning()
        })
        this.#shrecSection.appendChild(shrecDefaults)

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

    /** Format a voxel-size value in mm for the slider readout. */
    static #formatVoxelSize(mm: number): string {
        // Sub-mm values render with extra precision; ≥1 mm rounds nicely.
        if (mm < 0.1) return mm.toFixed(3)
        return mm.toFixed(2)
    }

    static #formatShrecValue(key: keyof ShrecTuning, v: number | boolean): string {
        if (typeof v === "boolean") return v ? "on" : "off"
        if (key === "mergeRelCutoff") return v.toFixed(3)
        if (key === "mergeMaxDisplacement") return v === 0 ? "off" : v.toFixed(2)
        if (key === "creaseAngleDeg") return `${Math.round(v)}°`
        if (key === "mergeGradientWeightPower") return v === 0 ? "off" : `g^${v.toFixed(1)}`
        if (key === "dedupRadiusVoxels") return v === 0 ? "off" : v.toFixed(2)
        if (key === "seamAgreementCosThreshold") {
            // Show as the equivalent angle (in degrees) for readability —
            // the slider's underlying value is the cosine.
            const deg = Math.acos(Math.max(-1, Math.min(1, v))) * 180 / Math.PI
            return `${deg.toFixed(0)}°`
        }
        return v.toFixed(2)
    }

    /** Persist the current SHREC tuning state and notify listeners. */
    #persistShrecTuning(): void {
        const next = { ...this.#shrecTuningState }
        this.#settings.updateGlobal({ app: { shrecTuning: next } })
        this.onShrecTuningChange?.(next)
    }

    #persistSimplifyTuning(): void {
        const next = { ...this.#simplifyTuningState }
        this.#settings.updateGlobal({ app: { simplifyTuning: next } })
        this.onSimplifyTuningChange?.(next)
    }

    static #formatSimplifyValue(key: "targetRatio" | "targetError" | "normalWeight", v: number): string {
        if (key === "targetRatio") return `${(v * 100).toFixed(0)}%`
        if (key === "targetError") return v < 0.001 ? v.toExponential(2) : v.toFixed(4)
        return v === 0 ? "0" : v.toFixed(2)
    }

    static #formatMdcValue(key: (typeof MDC_RANGE_KNOBS)[number]["key"], v: number): string {
        if (key === "isoValue") return v.toFixed(3)
        if (key === "creaseAngleDeg") return String(Math.round(v))
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
