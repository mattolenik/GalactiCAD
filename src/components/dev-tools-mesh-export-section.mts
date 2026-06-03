import { BehaviorSubject, type Subscription } from "rxjs"
import { SettingsManager } from "../storage/settings.mjs"
import { DEFAULT_SIMPLIFY_TUNING, type SimplifyTuning } from "../render-worker-protocol.mjs"
import { EXPORTER_KINDS, type ExporterKind } from "../export/mesh-exporter.mjs"
import { DEFAULT_MDC_TUNING, MDC_DISPLAY_NAME, type MdcTuning } from "../export/mdc-tuning.mjs"
import { DEFAULT_SHREC_TUNING, SHREC_DISPLAY_NAME, type ShrecTuning } from "../export/shrec/shrec-tuning.mjs"
import { DEFAULT_FLEXICUBES_TUNING, FLEXICUBES_DISPLAY_NAME, type FlexiCubesTuning } from "../export/flexicubes/flexicubes-tuning.mjs"
import {
    DEFAULT_ISO_SIMPLICIAL_BOUNDS_PADDING_MM,
    DEFAULT_ISO_SIMPLICIAL_TUNING,
    ISO_SIMPLICIAL_DISPLAY_NAME,
    type IsoSimplicialTuning,
} from "../export/iso-simplicial/iso-tuning.mjs"
import { devToolsBaseShadowCss } from "./dev-tools-styles.mjs"
import { IsoSimplicialConstants } from "../export/iso-simplicial/constants.mjs"
import "./dev-tools-collapse.mjs"

/** Boolean fields on `SimplifyTuning` for the meshoptimizer simplify panel (excludes renormalize). */
type SimplifyBoolKey = "lockBorder" | "sparse" | "errorAbsolute" | "prune" | "regularize"

const MDC_RANGE_KNOBS: {
    key: keyof Pick<MdcTuning, "isoValue" | "creaseAngleDeg">
    label: string
    min: number
    max: number
    step: number
}[] = [
    { key: "isoValue", label: "Iso value", min: -0.2, max: 0.2, step: 0.002 },
    { key: "creaseAngleDeg", label: "Crease °", min: -1, max: 180, step: 1 },
]

const VOXEL_SLIDER_MIN = 0.02
const VOXEL_SLIDER_MAX = 1.0
const VOXEL_SLIDER_STEP = 0.01

function formatVoxelSize(mm: number): string {
    if (mm < 0.1) return mm.toFixed(3)
    return mm.toFixed(2)
}

function formatShrecValue(key: keyof ShrecTuning, v: number | boolean): string {
    if (typeof v === "boolean") return v ? "on" : "off"
    if (key === "mergeRelCutoff") return v.toFixed(3)
    if (key === "mergeMaxDisplacement") return v === 0 ? "off" : v.toFixed(2)
    if (key === "creaseAngleDeg") return `${Math.round(v)}°`
    if (key === "mergeGradientWeightPower") return v === 0 ? "off" : `g^${v.toFixed(1)}`
    if (key === "dedupRadiusVoxels") return v === 0 ? "off" : v.toFixed(2)
    if (key === "seamAgreementCosThreshold") {
        const deg = (Math.acos(Math.max(-1, Math.min(1, v))) * 180) / Math.PI
        return `${deg.toFixed(0)}°`
    }
    if (key === "voxelSizeMm") return formatVoxelSize(v)
    return v.toFixed(2)
}

function formatSimplifyValue(key: "targetRatio" | "targetError" | "normalWeight", v: number): string {
    if (key === "targetRatio") return `${(v * 100).toFixed(0)}%`
    if (key === "targetError") return v < 0.001 ? v.toExponential(2) : v.toFixed(4)
    return v === 0 ? "0" : v.toFixed(2)
}

function formatMdcValue(key: (typeof MDC_RANGE_KNOBS)[number]["key"], v: number): string {
    if (key === "isoValue") return v.toFixed(3)
    if (key === "creaseAngleDeg") return String(Math.round(v))
    return v.toFixed(2)
}

function addCheckbox(parent: ParentNode, label: string, checked: boolean): HTMLInputElement {
    const el = document.createElement("label")
    const cb = document.createElement("input")
    cb.type = "checkbox"
    cb.checked = checked
    el.append(cb, label)
    parent.appendChild(el)
    return cb
}

function addVoxelSliderRow(
    parent: ParentNode,
    initial: number,
    onInput: (v: number) => void,
): { range: HTMLInputElement; valueEl: HTMLSpanElement } {
    const row = document.createElement("div")
    row.className = "shade-row"
    const lab = document.createElement("label")
    lab.className = "knob-label"
    lab.textContent = "Voxel (mm)"
    const range = document.createElement("input")
    range.type = "range"
    range.min = String(VOXEL_SLIDER_MIN)
    range.max = String(VOXEL_SLIDER_MAX)
    range.step = String(VOXEL_SLIDER_STEP)
    range.value = String(initial)
    const valueEl = document.createElement("span")
    valueEl.className = "shade-val"
    valueEl.textContent = formatVoxelSize(initial)
    range.addEventListener("input", () => {
        const v = parseFloat(range.value)
        valueEl.textContent = formatVoxelSize(v)
        onInput(v)
    })
    row.append(lab, range, valueEl)
    parent.appendChild(row)
    return { range, valueEl }
}

/**
 * Exporter dropdown — sits at the top of the parent "Mesh export" panel so it's
 * clearly the parent-level choice (which exporter runs); exporter-specific knobs
 * live in their own sibling collapses below.
 */
export class DevToolsExporterSelect extends HTMLElement {
    #settings = SettingsManager.instance
    #meshExporter$: BehaviorSubject<ExporterKind>
    #exporterSelect: HTMLSelectElement
    #subscriptions: Subscription[] = []

    onMeshExporterChange?: (exporter: ExporterKind) => void

    get meshExporter(): ExporterKind {
        return this.#meshExporter$.value
    }

    set meshExporter(v: ExporterKind) {
        this.#meshExporter$.next(v)
    }

    constructor() {
        super()
        const shadow = this.attachShadow({ mode: "open" })
        const style = document.createElement("style")
        style.textContent = devToolsBaseShadowCss()
        shadow.appendChild(style)

        const g = this.#settings.getGlobal().app
        this.#meshExporter$ = new BehaviorSubject<ExporterKind>(g.meshExporter)

        const row = document.createElement("div")
        row.className = "shade-row"
        const lab = document.createElement("label")
        lab.className = "knob-label"
        lab.textContent = "Exporter"
        const sel = document.createElement("select")
        // Labels live with each exporter; the list is just the kind enumeration.
        const DISPLAY_NAMES: Record<ExporterKind, string> = {
            mdc: MDC_DISPLAY_NAME,
            shrec: SHREC_DISPLAY_NAME,
            isoSimplicial: ISO_SIMPLICIAL_DISPLAY_NAME,
            flexicubes: FLEXICUBES_DISPLAY_NAME,
        }
        const EXPORTER_OPTIONS: ReadonlyArray<readonly [ExporterKind, string]> = EXPORTER_KINDS.map(
            k => [k, DISPLAY_NAMES[k]] as const,
        )
        for (const [val, label] of EXPORTER_OPTIONS) {
            const o = document.createElement("option")
            o.value = val
            o.textContent = label
            if (this.#meshExporter$.value === val) o.selected = true
            sel.appendChild(o)
        }
        sel.addEventListener("change", () => {
            this.#meshExporter$.next(sel.value as ExporterKind)
        })
        row.append(lab, sel)
        shadow.appendChild(row)
        this.#exporterSelect = sel

        this.#subscriptions.push(
            this.#meshExporter$.subscribe(v => {
                if (this.#exporterSelect.value !== v) this.#exporterSelect.value = v
                if (v !== this.#settings.getGlobal().app.meshExporter) {
                    this.#settings.updateGlobal({ app: { meshExporter: v } })
                    this.onMeshExporterChange?.(v)
                }
            })
        )
    }

    syncMeshExporterFromSettings(exporter: ExporterKind): void {
        this.#meshExporter$.next(exporter)
    }

    disconnectedCallback(): void {
        for (const s of this.#subscriptions) s.unsubscribe()
        this.#subscriptions = []
    }
}

customElements.define("dev-tools-exporter-select", DevToolsExporterSelect)

/** Iso-simplicial exporter tuning (persisted on `app.exporterTuning.isoSimplicial`). */
export class DevToolsIsoSimplicialSection extends HTMLElement {
    #settings = SettingsManager.instance
    #isoPhase5Checkbox: HTMLInputElement
    #isoFeatureRefineCheckbox: HTMLInputElement
    #isoFeaturePlaneCheckbox: HTMLInputElement
    #isoFeaturePlaneDistFactorRange: HTMLInputElement
    #isoFeaturePlaneDistFactorValueEl: HTMLSpanElement
    #isoFgPlaneCheckbox: HTMLInputElement
    #isoFgPlaneDistFactorRange: HTMLInputElement
    #isoFgPlaneDistFactorValueEl: HTMLSpanElement
    #isoFgEdgeFaceCheckbox: HTMLInputElement
    #isoBoundsPadRange: HTMLInputElement
    #isoBoundsPadValueEl: HTMLSpanElement
    #isoDepthMinRange: HTMLInputElement
    #isoDepthMinValueEl: HTMLSpanElement
    #isoDepthMaxRange: HTMLInputElement
    #isoDepthMaxValueEl: HTMLSpanElement
    #isoOversampleQefRange: HTMLInputElement
    #isoOversampleQefValueEl: HTMLSpanElement

    onIsoSimplicialTuningChange?: (tuning: IsoSimplicialTuning) => void

    get isoSimplicialTuning(): IsoSimplicialTuning {
        return { ...this.#settings.getIsoSimplicialTuning() }
    }

    constructor() {
        super()
        const shadow = this.attachShadow({ mode: "open" })
        const style = document.createElement("style")
        style.textContent = devToolsBaseShadowCss()
        shadow.appendChild(style)

        const isoT = this.#settings.getIsoSimplicialTuning()
        const depthMinDisp = isoT.depthMin ?? IsoSimplicialConstants.depthMin
        const depthMaxDisp = isoT.depthMax ?? IsoSimplicialConstants.depthMax
        const oversampleQefDisp = isoT.oversampleQef ?? IsoSimplicialConstants.oversampleQef
        const isoPadDisp = isoT.boundingBoxPaddingMm ?? DEFAULT_ISO_SIMPLICIAL_BOUNDS_PADDING_MM

        this.#isoPhase5Checkbox = addCheckbox(shadow, "Phase 5 GPU edge snap", isoT.phase5Snap ?? false)
        this.#isoPhase5Checkbox.addEventListener("change", () => {
            this.#persistIsoTuning({ phase5Snap: this.#isoPhase5Checkbox.checked })
        })

        this.#isoFeatureRefineCheckbox = addCheckbox(
            shadow,
            "Feature-aware refine (signchangeGated)",
            (isoT.featureRefineMode ?? "off") === "signchangeGated",
        )
        this.#isoFeatureRefineCheckbox.addEventListener("change", () => {
            this.#persistIsoTuning({
                featureRefineMode: this.#isoFeatureRefineCheckbox.checked ? "signchangeGated" : "off",
            })
        })

        this.#isoFeaturePlaneCheckbox = addCheckbox(shadow, "SDF feature planes", isoT.featurePlaneEnabled === true)
        this.#isoFeaturePlaneCheckbox.addEventListener("change", () => {
            this.#persistIsoTuning({ featurePlaneEnabled: this.#isoFeaturePlaneCheckbox.checked })
        })

        {
            const row = document.createElement("div")
            row.className = "shade-row"
            const lab = document.createElement("label")
            lab.className = "knob-label"
            lab.textContent = "SDF feature plane dist factor"
            const range = document.createElement("input")
            range.type = "range"
            range.min = "0.1"
            range.max = "4"
            range.step = "0.1"
            const dfInit = isoT.featurePlaneDistFactor ?? 1.0
            range.value = String(dfInit)
            const valueEl = document.createElement("span")
            valueEl.className = "shade-val"
            valueEl.textContent = dfInit.toFixed(1)
            range.addEventListener("input", () => {
                let v = parseFloat(range.value)
                if (!Number.isFinite(v)) v = 1.0
                v = Math.max(0.1, Math.min(4, v))
                valueEl.textContent = v.toFixed(1)
                this.#persistIsoTuning({ featurePlaneDistFactor: v })
            })
            row.append(lab, range, valueEl)
            shadow.appendChild(row)
            this.#isoFeaturePlaneDistFactorRange = range
            this.#isoFeaturePlaneDistFactorValueEl = valueEl
        }

        this.#isoFgPlaneCheckbox = addCheckbox(shadow, "FeatureGraph planes", isoT.featureGraphPlanesEnabled === true)
        this.#isoFgPlaneCheckbox.addEventListener("change", () => {
            this.#persistIsoTuning({ featureGraphPlanesEnabled: this.#isoFgPlaneCheckbox.checked })
        })

        {
            const row = document.createElement("div")
            row.className = "shade-row"
            const lab = document.createElement("label")
            lab.className = "knob-label"
            lab.textContent = "FeatureGraph plane dist factor"
            const range = document.createElement("input")
            range.type = "range"
            range.min = "0"
            range.max = "4"
            range.step = "0.1"
            const dfInit = isoT.featureGraphPlaneDistFactor ?? 0
            range.value = String(dfInit)
            const valueEl = document.createElement("span")
            valueEl.className = "shade-val"
            valueEl.textContent = dfInit.toFixed(1)
            range.addEventListener("input", () => {
                let v = parseFloat(range.value)
                if (!Number.isFinite(v)) v = 0
                v = Math.max(0, Math.min(4, v))
                valueEl.textContent = v.toFixed(1)
                this.#persistIsoTuning({ featureGraphPlaneDistFactor: v })
            })
            row.append(lab, range, valueEl)
            shadow.appendChild(row)
            this.#isoFgPlaneDistFactorRange = range
            this.#isoFgPlaneDistFactorValueEl = valueEl
        }

        this.#isoFgEdgeFaceCheckbox = addCheckbox(
            shadow,
            "FG planes in edge/face QEF",
            isoT.featureGraphEdgeFacePlanes === true,
        )
        this.#isoFgEdgeFaceCheckbox.addEventListener("change", () => {
            this.#persistIsoTuning({ featureGraphEdgeFacePlanes: this.#isoFgEdgeFaceCheckbox.checked })
        })

        {
            const row = document.createElement("div")
            row.className = "shade-row"
            const lab = document.createElement("label")
            lab.className = "knob-label"
            lab.textContent = "Bounds padding (mm)"
            const range = document.createElement("input")
            range.type = "range"
            range.min = "0"
            range.max = "20"
            range.step = "0.1"
            range.value = String(isoPadDisp)
            const valueEl = document.createElement("span")
            valueEl.className = "shade-val"
            valueEl.textContent = isoPadDisp.toFixed(1)
            range.addEventListener("input", () => {
                let v = parseFloat(range.value)
                if (!Number.isFinite(v)) v = 0
                v = Math.max(0, Math.min(20, v))
                valueEl.textContent = v.toFixed(1)
                this.#persistIsoTuning({ boundingBoxPaddingMm: v })
            })
            row.append(lab, range, valueEl)
            shadow.appendChild(row)
            this.#isoBoundsPadRange = range
            this.#isoBoundsPadValueEl = valueEl
        }

        {
            const row = document.createElement("div")
            row.className = "shade-row"
            const lab = document.createElement("label")
            lab.className = "knob-label"
            lab.textContent = "Octree depth min"
            const range = document.createElement("input")
            range.type = "range"
            range.min = "3"
            range.max = "12"
            range.step = "1"
            range.value = String(depthMinDisp)
            const valueEl = document.createElement("span")
            valueEl.className = "shade-val"
            valueEl.textContent = String(depthMinDisp)
            range.addEventListener("input", () => {
                const v = parseInt(range.value, 10)
                valueEl.textContent = String(v)
                this.#persistIsoTuning({ depthMin: v })
            })
            row.append(lab, range, valueEl)
            shadow.appendChild(row)
            this.#isoDepthMinRange = range
            this.#isoDepthMinValueEl = valueEl
        }
        {
            const row = document.createElement("div")
            row.className = "shade-row"
            const lab = document.createElement("label")
            lab.className = "knob-label"
            lab.textContent = "Octree depth max"
            const range = document.createElement("input")
            range.type = "range"
            range.min = "3"
            range.max = "14"
            range.step = "1"
            range.value = String(depthMaxDisp)
            const valueEl = document.createElement("span")
            valueEl.className = "shade-val"
            valueEl.textContent = String(depthMaxDisp)
            range.addEventListener("input", () => {
                const v = parseInt(range.value, 10)
                valueEl.textContent = String(v)
                this.#persistIsoTuning({ depthMax: v })
            })
            row.append(lab, range, valueEl)
            shadow.appendChild(row)
            this.#isoDepthMaxRange = range
            this.#isoDepthMaxValueEl = valueEl
        }
        {
            const row = document.createElement("div")
            row.className = "shade-row"
            const lab = document.createElement("label")
            lab.className = "knob-label"
            lab.textContent = "QEF Hermite oversample"
            lab.title =
                "Denser internal/edge/face sample lattices for Hermite+QEF (higher = more sceneSDF work per cell, often sharper)."
            const range = document.createElement("input")
            range.type = "range"
            range.min = "1"
            range.max = "8"
            range.step = "1"
            range.value = String(oversampleQefDisp)
            const valueEl = document.createElement("span")
            valueEl.className = "shade-val"
            valueEl.textContent = String(oversampleQefDisp)
            range.addEventListener("input", () => {
                let v = parseInt(range.value, 10)
                if (!Number.isFinite(v)) v = IsoSimplicialConstants.oversampleQef
                v = Math.max(1, Math.min(8, Math.round(v)))
                valueEl.textContent = String(v)
                this.#persistIsoTuning({ oversampleQef: v })
            })
            row.append(lab, range, valueEl)
            shadow.appendChild(row)
            this.#isoOversampleQefRange = range
            this.#isoOversampleQefValueEl = valueEl
        }
        const isoDefaults = document.createElement("button")
        isoDefaults.textContent = "Iso defaults"
        isoDefaults.addEventListener("click", () => {
            this.#settings.updateGlobal({ app: { exporterTuning: { isoSimplicial: { ...DEFAULT_ISO_SIMPLICIAL_TUNING } } } })
            this.syncIsoSimplicialTuningFromSettings(this.#settings.getIsoSimplicialTuning())
            this.onIsoSimplicialTuningChange?.(this.#settings.getIsoSimplicialTuning())
        })
        shadow.appendChild(isoDefaults)
    }

    syncIsoSimplicialTuningFromSettings(tuning: IsoSimplicialTuning): void {
        this.#isoPhase5Checkbox.checked = tuning.phase5Snap ?? false
        this.#isoFeatureRefineCheckbox.checked = (tuning.featureRefineMode ?? "off") === "signchangeGated"
        this.#isoFeaturePlaneCheckbox.checked = tuning.featurePlaneEnabled === true
        const dfSync = tuning.featurePlaneDistFactor ?? 1.0
        this.#isoFeaturePlaneDistFactorRange.value = String(dfSync)
        this.#isoFeaturePlaneDistFactorValueEl.textContent = dfSync.toFixed(1)
        this.#isoFgPlaneCheckbox.checked = tuning.featureGraphPlanesEnabled === true
        const fgDfSync = tuning.featureGraphPlaneDistFactor ?? 0
        this.#isoFgPlaneDistFactorRange.value = String(fgDfSync)
        this.#isoFgPlaneDistFactorValueEl.textContent = fgDfSync.toFixed(1)
        this.#isoFgEdgeFaceCheckbox.checked = tuning.featureGraphEdgeFacePlanes === true
        const pad = tuning.boundingBoxPaddingMm ?? DEFAULT_ISO_SIMPLICIAL_BOUNDS_PADDING_MM
        this.#isoBoundsPadRange.value = String(pad)
        this.#isoBoundsPadValueEl.textContent = pad.toFixed(1)
        const dmin = tuning.depthMin ?? IsoSimplicialConstants.depthMin
        const dmax = tuning.depthMax ?? IsoSimplicialConstants.depthMax
        this.#isoDepthMinRange.value = String(dmin)
        this.#isoDepthMinValueEl.textContent = String(dmin)
        this.#isoDepthMaxRange.value = String(dmax)
        this.#isoDepthMaxValueEl.textContent = String(dmax)
        const oq = tuning.oversampleQef ?? IsoSimplicialConstants.oversampleQef
        this.#isoOversampleQefRange.value = String(oq)
        this.#isoOversampleQefValueEl.textContent = String(oq)
    }

    #persistIsoTuning(patch: Partial<IsoSimplicialTuning>): void {
        const cur = this.#settings.getIsoSimplicialTuning()
        const next: IsoSimplicialTuning = { ...cur, ...patch }
        this.#settings.updateGlobal({ app: { exporterTuning: { isoSimplicial: next } } })
        this.onIsoSimplicialTuningChange?.(next)
    }
}

customElements.define("dev-tools-iso-simplicial-section", DevToolsIsoSimplicialSection)

/** MDC mesh export: voxel size + iso/crease/feature-constrained levers (persisted on `mdcExportLevers`). */
export class DevToolsMdcExportSection extends HTMLElement {
    #settings = SettingsManager.instance
    #voxelSizeRange: HTMLInputElement
    #voxelSizeValueEl: HTMLSpanElement
    #mdcRows = new Map<
        (typeof MDC_RANGE_KNOBS)[number]["key"],
        { range: HTMLInputElement; valueEl: HTMLSpanElement }
    >()
    #mdcFeatureConstrainedPlacementCheckbox: HTMLInputElement
    #subscriptions: Subscription[] = []

    onMdcExportLeversChange?: () => void
    /** Fired when renormalize toggle changes (full `SimplifyTuning` after merge). */
    onSimplifyTuningChange?: (tuning: SimplifyTuning) => void

    /** The MDC tuning currently shown in this section. */
    getTuning(): MdcTuning {
        return this.#settings.getMdcExportLevers()
    }

    constructor() {
        super()
        const shadow = this.attachShadow({ mode: "open" })
        const style = document.createElement("style")
        style.textContent = devToolsBaseShadowCss()
        shadow.appendChild(style)

        const mdcLevers = this.#settings.getMdcExportLevers()

        const voxel = addVoxelSliderRow(shadow, mdcLevers.voxelSizeMm, v => {
            this.#settings.updateGlobal({ app: { exporterTuning: { mdc: { voxelSizeMm: v } } } })
            this.onMdcExportLeversChange?.()
        })
        this.#voxelSizeRange = voxel.range
        this.#voxelSizeValueEl = voxel.valueEl

        this.#mdcFeatureConstrainedPlacementCheckbox = addCheckbox(
            shadow,
            "Feature-constrained vertices",
            mdcLevers.featureConstrainedPlacement
        )
        this.#mdcFeatureConstrainedPlacementCheckbox.addEventListener("change", () => {
            this.#settings.updateGlobal({
                app: {
                    exporterTuning: {
                        mdc: { featureConstrainedPlacement: this.#mdcFeatureConstrainedPlacementCheckbox.checked },
                    },
                },
            })
            this.onMdcExportLeversChange?.()
        })
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
            valueEl.textContent = formatMdcValue(k.key, mdcLevers[k.key])
            range.addEventListener("input", () => {
                let v = parseFloat(range.value)
                if (!Number.isFinite(v)) v = k.min
                v = Math.max(k.min, Math.min(k.max, v))
                this.#settings.updateGlobal({
                    app: { exporterTuning: { mdc: { [k.key]: v } } },
                })
                valueEl.textContent = formatMdcValue(k.key, v)
                this.onMdcExportLeversChange?.()
            })
            row.append(lab, range, valueEl)
            shadow.appendChild(row)
            this.#mdcRows.set(k.key, { range, valueEl })
        }

        const mdcDefaults = document.createElement("button")
        mdcDefaults.textContent = "MDC defaults"
        mdcDefaults.addEventListener("click", () => {
            this.#settings.updateGlobal({
                app: {
                    exporterTuning: {
                        mdc: {
                            voxelSizeMm: DEFAULT_MDC_TUNING.voxelSizeMm,
                            isoValue: DEFAULT_MDC_TUNING.isoValue,
                            creaseAngleDeg: DEFAULT_MDC_TUNING.creaseAngleDeg,
                            featureConstrainedPlacement: DEFAULT_MDC_TUNING.featureConstrainedPlacement,
                        },
                    },
                },
            })
            this.syncMdcLeversFromSettings(this.#settings.getMdcExportLevers())
            this.onMdcExportLeversChange?.()
        })
        shadow.appendChild(mdcDefaults)
    }

    syncMdcLeversFromSettings(levers: MdcTuning): void {
        this.#voxelSizeRange.value = String(levers.voxelSizeMm)
        this.#voxelSizeValueEl.textContent = formatVoxelSize(levers.voxelSizeMm)
        this.#mdcFeatureConstrainedPlacementCheckbox.checked = levers.featureConstrainedPlacement
        for (const k of MDC_RANGE_KNOBS) {
            const row = this.#mdcRows.get(k.key)
            if (!row) continue
            row.range.value = String(levers[k.key])
            row.valueEl.textContent = formatMdcValue(k.key, levers[k.key])
        }
    }

    disconnectedCallback(): void {
        for (const s of this.#subscriptions) s.unsubscribe()
        this.#subscriptions = []
    }
}

/**
 * Meshoptimizer / QEM simplification tuning, including the renormalize-triangles toggle
 * (persisted on `SimplifyTuning`).
 */
export class DevToolsMeshSimplifySection extends HTMLElement {
    #settings = SettingsManager.instance
    #simplifyTuningState: SimplifyTuning = { ...DEFAULT_SIMPLIFY_TUNING }
    #simplifyTargetRatioRange: HTMLInputElement
    #simplifyTargetRatioValueEl: HTMLSpanElement
    #simplifyTargetErrorRange: HTMLInputElement
    #simplifyTargetErrorValueEl: HTMLSpanElement
    #simplifyNormalWeightRange: HTMLInputElement
    #simplifyNormalWeightValueEl: HTMLSpanElement
    #simplifyBoolCheckboxes: Map<SimplifyBoolKey, HTMLInputElement> = new Map()
    #renormalizeTrianglesCheckbox: HTMLInputElement

    onSimplifyTuningChange?: (tuning: SimplifyTuning) => void

    get simplifyTuning(): SimplifyTuning {
        return { ...this.#simplifyTuningState }
    }

    constructor() {
        super()
        const shadow = this.attachShadow({ mode: "open" })
        const style = document.createElement("style")
        style.textContent = devToolsBaseShadowCss()
        shadow.appendChild(style)

        const g = this.#settings.getGlobal().app
        this.#simplifyTuningState = { ...DEFAULT_SIMPLIFY_TUNING, ...g.simplifyTuning }

        const root = document.createElement("div")
        root.className = "lighting-section"
        shadow.appendChild(root)

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
            valueEl.textContent = formatSimplifyValue("targetRatio", this.#simplifyTuningState.targetRatio)
            range.addEventListener("input", () => {
                const v = parseFloat(range.value)
                this.#simplifyTuningState = { ...this.#simplifyTuningState, targetRatio: v }
                valueEl.textContent = formatSimplifyValue("targetRatio", v)
                this.#persistSimplifyTuning()
            })
            row.append(lab, range, valueEl)
            root.appendChild(row)
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
            valueEl.textContent = formatSimplifyValue("targetError", this.#simplifyTuningState.targetError)
            range.addEventListener("input", () => {
                const v = parseFloat(range.value)
                this.#simplifyTuningState = { ...this.#simplifyTuningState, targetError: v }
                valueEl.textContent = formatSimplifyValue("targetError", v)
                this.#persistSimplifyTuning()
            })
            row.append(lab, range, valueEl)
            root.appendChild(row)
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
            valueEl.textContent = formatSimplifyValue("normalWeight", this.#simplifyTuningState.normalWeight)
            range.addEventListener("input", () => {
                const v = parseFloat(range.value)
                this.#simplifyTuningState = { ...this.#simplifyTuningState, normalWeight: v }
                valueEl.textContent = formatSimplifyValue("normalWeight", v)
                this.#persistSimplifyTuning()
            })
            row.append(lab, range, valueEl)
            root.appendChild(row)
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
            const cb = addCheckbox(root, label, this.#simplifyTuningState[key])
            this.#simplifyBoolCheckboxes.set(key, cb)
            cb.addEventListener("change", () => {
                const next: SimplifyTuning = { ...this.#simplifyTuningState }
                next[key] = cb.checked
                this.#simplifyTuningState = next
                this.#persistSimplifyTuning()
            })
        }

        this.#renormalizeTrianglesCheckbox = addCheckbox(
            root,
            "Renormalize triangles",
            this.#simplifyTuningState.renormalizeTriangles
        )
        this.#renormalizeTrianglesCheckbox.addEventListener("change", () => {
            this.#simplifyTuningState = {
                ...this.#simplifyTuningState,
                renormalizeTriangles: this.#renormalizeTrianglesCheckbox.checked,
            }
            this.#persistSimplifyTuning()
        })

        const simplifyDefaults = document.createElement("button")
        simplifyDefaults.textContent = "Simplify defaults"
        simplifyDefaults.addEventListener("click", () => {
            this.syncSimplifyTuningFromSettings({ ...DEFAULT_SIMPLIFY_TUNING })
            this.#persistSimplifyTuning()
        })
        root.appendChild(simplifyDefaults)
    }

    syncSimplifyTuningFromSettings(tuning: SimplifyTuning): void {
        this.#simplifyTuningState = { ...tuning }
        this.#simplifyTargetRatioRange.value = String(tuning.targetRatio)
        this.#simplifyTargetRatioValueEl.textContent = formatSimplifyValue("targetRatio", tuning.targetRatio)
        this.#simplifyTargetErrorRange.value = String(tuning.targetError)
        this.#simplifyTargetErrorValueEl.textContent = formatSimplifyValue("targetError", tuning.targetError)
        this.#simplifyNormalWeightRange.value = String(tuning.normalWeight)
        this.#simplifyNormalWeightValueEl.textContent = formatSimplifyValue("normalWeight", tuning.normalWeight)
        for (const key of this.#simplifyBoolCheckboxes.keys()) {
            const cb = this.#simplifyBoolCheckboxes.get(key)!
            cb.checked = tuning[key]
        }
        this.#renormalizeTrianglesCheckbox.checked = tuning.renormalizeTriangles
    }

    #persistSimplifyTuning(): void {
        const next = { ...this.#simplifyTuningState }
        this.#settings.updateGlobal({ app: { simplifyTuning: next } })
        this.onSimplifyTuningChange?.(next)
    }
}

/** SHREC MergeSharp tuning (select **SHREC** under Mesh export → Exporter). */
export class DevToolsShrecExportSection extends HTMLElement {
    #settings = SettingsManager.instance
    #shrecTuningState: ShrecTuning = { ...DEFAULT_SHREC_TUNING }
    #shrecVoxelSizeRange: HTMLInputElement
    #shrecVoxelSizeValueEl: HTMLSpanElement
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
    #shrecFeatureGraphContoursCheckbox: HTMLInputElement
    #subscriptions: Subscription[] = []

    onShrecTuningChange?: (tuning: ShrecTuning) => void

    get shrecTuning(): ShrecTuning {
        return { ...this.#shrecTuningState }
    }

    constructor() {
        super()
        const shadow = this.attachShadow({ mode: "open" })
        const style = document.createElement("style")
        style.textContent = devToolsBaseShadowCss()
        shadow.appendChild(style)


        this.#shrecTuningState = this.#settings.getShrecTuning()
        const root = document.createElement("div")
        root.className = "lighting-section"
        shadow.appendChild(root)

        const voxel = addVoxelSliderRow(root, this.#shrecTuningState.voxelSizeMm, v => {
            this.#shrecTuningState = { ...this.#shrecTuningState, voxelSizeMm: v }
            this.#persistShrecTuning()
        })
        this.#shrecVoxelSizeRange = voxel.range
        this.#shrecVoxelSizeValueEl = voxel.valueEl

        this.#shrecMergeSharpCheckbox = addCheckbox(root, "MergeSharp", this.#shrecTuningState.mergeSharpEnabled)
        this.#shrecMergeSharpCheckbox.addEventListener("change", () => {
            this.#shrecTuningState = { ...this.#shrecTuningState, mergeSharpEnabled: this.#shrecMergeSharpCheckbox.checked }
            this.#persistShrecTuning()
        })

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
            valueEl.textContent = formatShrecValue("mergeRelCutoff", this.#shrecTuningState.mergeRelCutoff)
            range.addEventListener("input", () => {
                const v = parseFloat(range.value)
                this.#shrecTuningState = { ...this.#shrecTuningState, mergeRelCutoff: v }
                valueEl.textContent = formatShrecValue("mergeRelCutoff", v)
                this.#persistShrecTuning()
            })
            row.append(lab, range, valueEl)
            root.appendChild(row)
            this.#shrecRelCutoffRange = range
            this.#shrecRelCutoffValueEl = valueEl
        }

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
            valueEl.textContent = formatShrecValue("mergeMaxDisplacement", this.#shrecTuningState.mergeMaxDisplacement)
            range.addEventListener("input", () => {
                const v = parseFloat(range.value)
                this.#shrecTuningState = { ...this.#shrecTuningState, mergeMaxDisplacement: v }
                valueEl.textContent = formatShrecValue("mergeMaxDisplacement", v)
                this.#persistShrecTuning()
            })
            row.append(lab, range, valueEl)
            root.appendChild(row)
            this.#shrecMaxDispRange = range
            this.#shrecMaxDispValueEl = valueEl
        }

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
            valueEl.textContent = formatShrecValue("creaseAngleDeg", this.#shrecTuningState.creaseAngleDeg)
            range.addEventListener("input", () => {
                const v = parseFloat(range.value)
                this.#shrecTuningState = { ...this.#shrecTuningState, creaseAngleDeg: v }
                valueEl.textContent = formatShrecValue("creaseAngleDeg", v)
                this.#persistShrecTuning()
            })
            row.append(lab, range, valueEl)
            root.appendChild(row)
            this.#shrecCreaseRange = range
            this.#shrecCreaseValueEl = valueEl
        }

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
            valueEl.textContent = formatShrecValue("mergeGradientWeightPower", this.#shrecTuningState.mergeGradientWeightPower)
            range.addEventListener("input", () => {
                const v = parseFloat(range.value)
                this.#shrecTuningState = { ...this.#shrecTuningState, mergeGradientWeightPower: v }
                valueEl.textContent = formatShrecValue("mergeGradientWeightPower", v)
                this.#persistShrecTuning()
            })
            row.append(lab, range, valueEl)
            root.appendChild(row)
            this.#shrecGradWeightRange = range
            this.#shrecGradWeightValueEl = valueEl
        }

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
            valueEl.textContent = formatShrecValue("dedupRadiusVoxels", this.#shrecTuningState.dedupRadiusVoxels)
            range.addEventListener("input", () => {
                const v = parseFloat(range.value)
                this.#shrecTuningState = { ...this.#shrecTuningState, dedupRadiusVoxels: v }
                valueEl.textContent = formatShrecValue("dedupRadiusVoxels", v)
                this.#persistShrecTuning()
            })
            row.append(lab, range, valueEl)
            root.appendChild(row)
            this.#shrecDedupRange = range
            this.#shrecDedupValueEl = valueEl
        }

        this.#shrecSeamAwareCheckbox = addCheckbox(root, "Seam-aware QEF", this.#shrecTuningState.seamAwareEnabled)
        this.#shrecSeamAwareCheckbox.addEventListener("change", () => {
            this.#shrecTuningState = { ...this.#shrecTuningState, seamAwareEnabled: this.#shrecSeamAwareCheckbox.checked }
            this.#persistShrecTuning()
        })

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
            valueEl.textContent = formatShrecValue("seamAgreementCosThreshold", this.#shrecTuningState.seamAgreementCosThreshold)
            range.addEventListener("input", () => {
                const v = parseFloat(range.value)
                this.#shrecTuningState = { ...this.#shrecTuningState, seamAgreementCosThreshold: v }
                valueEl.textContent = formatShrecValue("seamAgreementCosThreshold", v)
                this.#persistShrecTuning()
            })
            row.append(lab, range, valueEl)
            root.appendChild(row)
            this.#shrecSeamAgreementRange = range
            this.#shrecSeamAgreementValueEl = valueEl
        }

        this.#shrecEdgeFitCheckbox = addCheckbox(root, "Edge fit (line)", this.#shrecTuningState.edgeFitEnabled)
        this.#shrecEdgeFitCheckbox.addEventListener("change", () => {
            this.#shrecTuningState = { ...this.#shrecTuningState, edgeFitEnabled: this.#shrecEdgeFitCheckbox.checked }
            this.#persistShrecTuning()
        })

        // FeatureGraph contour feed (Stage 6). When on, SHREC's snap pass
        // consumes CSG-survival-aware feature data from the FeatureGraph
        // pipeline; when off, falls back to the legacy `accumulateContours`
        // walk (primitive contours without CSG filtering).
        this.#shrecFeatureGraphContoursCheckbox = addCheckbox(
            root,
            "FeatureGraph contours",
            this.#shrecTuningState.featureGraphContours,
        )
        this.#shrecFeatureGraphContoursCheckbox.addEventListener("change", () => {
            this.#shrecTuningState = {
                ...this.#shrecTuningState,
                featureGraphContours: this.#shrecFeatureGraphContoursCheckbox.checked,
            }
            this.#persistShrecTuning()
        })

        const shrecDefaults = document.createElement("button")
        shrecDefaults.textContent = "SHREC defaults"
        shrecDefaults.addEventListener("click", () => {
            this.syncShrecTuningFromSettings({ ...DEFAULT_SHREC_TUNING })
            this.#persistShrecTuning()
        })
        root.appendChild(shrecDefaults)
    }

    syncShrecTuningFromSettings(tuning: ShrecTuning): void {
        this.#shrecTuningState = { ...tuning }
        this.#shrecVoxelSizeRange.value = String(tuning.voxelSizeMm)
        this.#shrecVoxelSizeValueEl.textContent = formatVoxelSize(tuning.voxelSizeMm)
        this.#shrecMergeSharpCheckbox.checked = tuning.mergeSharpEnabled
        this.#shrecRelCutoffRange.value = String(tuning.mergeRelCutoff)
        this.#shrecRelCutoffValueEl.textContent = formatShrecValue("mergeRelCutoff", tuning.mergeRelCutoff)
        this.#shrecMaxDispRange.value = String(tuning.mergeMaxDisplacement)
        this.#shrecMaxDispValueEl.textContent = formatShrecValue("mergeMaxDisplacement", tuning.mergeMaxDisplacement)
        this.#shrecCreaseRange.value = String(tuning.creaseAngleDeg)
        this.#shrecCreaseValueEl.textContent = formatShrecValue("creaseAngleDeg", tuning.creaseAngleDeg)
        this.#shrecGradWeightRange.value = String(tuning.mergeGradientWeightPower)
        this.#shrecGradWeightValueEl.textContent = formatShrecValue("mergeGradientWeightPower", tuning.mergeGradientWeightPower)
        this.#shrecDedupRange.value = String(tuning.dedupRadiusVoxels)
        this.#shrecDedupValueEl.textContent = formatShrecValue("dedupRadiusVoxels", tuning.dedupRadiusVoxels)
        this.#shrecSeamAwareCheckbox.checked = tuning.seamAwareEnabled
        this.#shrecSeamAgreementRange.value = String(tuning.seamAgreementCosThreshold)
        this.#shrecSeamAgreementValueEl.textContent = formatShrecValue("seamAgreementCosThreshold", tuning.seamAgreementCosThreshold)
        this.#shrecEdgeFitCheckbox.checked = tuning.edgeFitEnabled
        this.#shrecFeatureGraphContoursCheckbox.checked = tuning.featureGraphContours
    }

    #persistShrecTuning(): void {
        const next = { ...this.#shrecTuningState }
        this.#settings.updateGlobal({ app: { exporterTuning: { shrec: next } } })
        this.onShrecTuningChange?.(next)
    }

    disconnectedCallback(): void {
        for (const s of this.#subscriptions) s.unsubscribe()
        this.#subscriptions = []
    }
}

/** FlexiCubes exporter voxel size and tuning (persisted on `app.exporterTuning.flexicubes`). */
export class DevToolsFlexiCubesExportSection extends HTMLElement {
    #settings = SettingsManager.instance
    #tuningState: FlexiCubesTuning = { ...DEFAULT_FLEXICUBES_TUNING }
    #voxelSizeRange: HTMLInputElement
    #voxelSizeValueEl: HTMLSpanElement
    #isoValueRange: HTMLInputElement
    #isoValueValueEl: HTMLSpanElement
    #creaseRange: HTMLInputElement
    #creaseValueEl: HTMLSpanElement
    #qefCutoffRange: HTMLInputElement
    #qefCutoffValueEl: HTMLSpanElement
    #featureConstrainedCheckbox: HTMLInputElement
    #featureWeightRange: HTMLInputElement
    #featureWeightValueEl: HTMLSpanElement
    #subscriptions: Subscription[] = []

    onFlexiCubesTuningChange?: (tuning: FlexiCubesTuning) => void

    get flexicubesTuning(): FlexiCubesTuning {
        return { ...this.#tuningState }
    }

    constructor() {
        super()
        const shadow = this.attachShadow({ mode: "open" })
        const style = document.createElement("style")
        style.textContent = devToolsBaseShadowCss()
        shadow.appendChild(style)

        this.#tuningState = this.#settings.getFlexicubesTuning()
        const root = document.createElement("div")
        root.className = "lighting-section"
        shadow.appendChild(root)

        const voxel = addVoxelSliderRow(root, this.#tuningState.voxelSizeMm, v => {
            this.#tuningState = { ...this.#tuningState, voxelSizeMm: v }
            this.#persist()
        })
        this.#voxelSizeRange = voxel.range
        this.#voxelSizeValueEl = voxel.valueEl

        const addRow = (
            label: string,
            min: number,
            max: number,
            step: number,
            initial: number,
            format: (v: number) => string,
            onInput: (v: number) => void,
        ): { range: HTMLInputElement; valueEl: HTMLSpanElement } => {
            const row = document.createElement("div")
            row.className = "shade-row"
            const lab = document.createElement("label")
            lab.className = "knob-label"
            lab.textContent = label
            const range = document.createElement("input")
            range.type = "range"
            range.min = String(min)
            range.max = String(max)
            range.step = String(step)
            range.value = String(initial)
            const valueEl = document.createElement("span")
            valueEl.className = "shade-val"
            valueEl.textContent = format(initial)
            range.addEventListener("input", () => {
                const v = parseFloat(range.value)
                valueEl.textContent = format(v)
                onInput(v)
            })
            row.append(lab, range, valueEl)
            root.appendChild(row)
            return { range, valueEl }
        }

        const iso = addRow(
            "Iso value",
            -0.2,
            0.2,
            0.002,
            this.#tuningState.isoValue,
            v => v.toFixed(3),
            v => {
                this.#tuningState = { ...this.#tuningState, isoValue: v }
                this.#persist()
            },
        )
        this.#isoValueRange = iso.range
        this.#isoValueValueEl = iso.valueEl

        const crease = addRow(
            "Crease (°)",
            -1,
            180,
            1,
            this.#tuningState.creaseAngleDeg,
            v => `${Math.round(v)}°`,
            v => {
                this.#tuningState = { ...this.#tuningState, creaseAngleDeg: v }
                this.#persist()
            },
        )
        this.#creaseRange = crease.range
        this.#creaseValueEl = crease.valueEl

        const qef = addRow(
            "QEF cutoff",
            0.005,
            0.5,
            0.005,
            this.#tuningState.qefRelCutoff,
            v => v.toFixed(3),
            v => {
                this.#tuningState = { ...this.#tuningState, qefRelCutoff: v }
                this.#persist()
            },
        )
        this.#qefCutoffRange = qef.range
        this.#qefCutoffValueEl = qef.valueEl

        this.#featureConstrainedCheckbox = addCheckbox(
            root,
            "Feature-constrained vertices",
            this.#tuningState.featureConstrainedPlacement,
        )
        this.#featureConstrainedCheckbox.addEventListener("change", () => {
            this.#tuningState = {
                ...this.#tuningState,
                featureConstrainedPlacement: this.#featureConstrainedCheckbox.checked,
            }
            this.#persist()
        })

        const featWeight = addRow(
            "Feature weight",
            0,
            64,
            0.5,
            this.#tuningState.featureWeight,
            v => v.toFixed(1),
            v => {
                this.#tuningState = { ...this.#tuningState, featureWeight: v }
                this.#persist()
            },
        )
        this.#featureWeightRange = featWeight.range
        this.#featureWeightValueEl = featWeight.valueEl

        const defaultsBtn = document.createElement("button")
        defaultsBtn.textContent = "FlexiCubes defaults"
        defaultsBtn.addEventListener("click", () => {
            this.syncFromSettings({ ...DEFAULT_FLEXICUBES_TUNING })
            this.#persist()
        })
        root.appendChild(defaultsBtn)
    }

    syncFromSettings(tuning: FlexiCubesTuning): void {
        this.#tuningState = { ...tuning }
        this.#voxelSizeRange.value = String(tuning.voxelSizeMm)
        this.#voxelSizeValueEl.textContent = formatVoxelSize(tuning.voxelSizeMm)
        this.#isoValueRange.value = String(tuning.isoValue)
        this.#isoValueValueEl.textContent = tuning.isoValue.toFixed(3)
        this.#creaseRange.value = String(tuning.creaseAngleDeg)
        this.#creaseValueEl.textContent = `${Math.round(tuning.creaseAngleDeg)}°`
        this.#qefCutoffRange.value = String(tuning.qefRelCutoff)
        this.#qefCutoffValueEl.textContent = tuning.qefRelCutoff.toFixed(3)
        this.#featureConstrainedCheckbox.checked = tuning.featureConstrainedPlacement
        this.#featureWeightRange.value = String(tuning.featureWeight)
        this.#featureWeightValueEl.textContent = tuning.featureWeight.toFixed(1)
    }

    #persist(): void {
        const next = { ...this.#tuningState }
        this.#settings.updateGlobal({ app: { exporterTuning: { flexicubes: next } } })
        this.onFlexiCubesTuningChange?.(next)
    }

    disconnectedCallback(): void {
        for (const s of this.#subscriptions) s.unsubscribe()
        this.#subscriptions = []
    }
}

customElements.define("dev-tools-mdc-export-section", DevToolsMdcExportSection)
customElements.define("dev-tools-mesh-simplify-section", DevToolsMeshSimplifySection)
customElements.define("dev-tools-shrec-export-section", DevToolsShrecExportSection)
customElements.define("dev-tools-flexicubes-export-section", DevToolsFlexiCubesExportSection)

declare global {
    interface HTMLElementTagNameMap {
        "dev-tools-mdc-export-section": DevToolsMdcExportSection
        "dev-tools-mesh-simplify-section": DevToolsMeshSimplifySection
        "dev-tools-shrec-export-section": DevToolsShrecExportSection
        "dev-tools-flexicubes-export-section": DevToolsFlexiCubesExportSection
    }
}
