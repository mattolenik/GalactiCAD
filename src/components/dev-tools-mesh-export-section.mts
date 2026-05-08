import { BehaviorSubject, skip } from "rxjs"
import type { Subscription } from "rxjs"
import { SettingsManager } from "../storage/settings.mjs"
import {
    DEFAULT_ISO_SIMPLICIAL_BOUNDS_PADDING_MM,
    DEFAULT_ISO_SIMPLICIAL_TUNING,
    DEFAULT_MDC_EXPORT_LEVERS,
    DEFAULT_SHREC_TUNING,
    DEFAULT_SIMPLIFY_TUNING,
    type ExporterKind,
    type IsoSimplicialTuning,
    type MdcExportLevers,
    type ShrecTuning,
    type SimplifyTuning,
} from "../render-worker-protocol.mjs"
import { DEVTOOLS_COLLAPSE } from "./dev-tools-protocol.mjs"
import { devToolsBaseShadowCss } from "./dev-tools-styles.mjs"
import { IsoSimplicialConstants } from "../export/iso-simplicial/constants.mjs"
import "./dev-tools-collapse.mjs"

/** Boolean fields on `SimplifyTuning` for the meshoptimizer simplify panel (excludes renormalize). */
type SimplifyBoolKey = "lockBorder" | "sparse" | "errorAbsolute" | "prune" | "regularize"

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

/**
 * Voxel size, MDC mesh export levers, and standalone renormalize-triangles toggle
 * (`SimplifyTuning.renormalizeTriangles`, persisted on `GlobalSettings.app`).
 */
export class DevToolsMeshExportCoreSection extends HTMLElement {
    #settings = SettingsManager.instance
    #voxelSizeMm$: BehaviorSubject<number>
    #voxelSizeRange: HTMLInputElement
    #voxelSizeValueEl: HTMLSpanElement
    #mdcRows = new Map<
        (typeof MDC_RANGE_KNOBS)[number]["key"],
        { range: HTMLInputElement; valueEl: HTMLSpanElement }
    >()
    #mdcFeatureConstrainedPlacementCheckbox: HTMLInputElement
    #renormalizeTrianglesCheckbox: HTMLInputElement
    #meshExporter$: BehaviorSubject<ExporterKind>
    #exporterRadios: Record<ExporterKind, HTMLInputElement> = {} as Record<ExporterKind, HTMLInputElement>
    #isoCollapse: HTMLElement
    #isoPhase5Checkbox: HTMLInputElement
    #isoBoundsPadRange: HTMLInputElement
    #isoBoundsPadValueEl: HTMLSpanElement
    #isoDepthMinRange: HTMLInputElement
    #isoDepthMinValueEl: HTMLSpanElement
    #isoDepthMaxRange: HTMLInputElement
    #isoDepthMaxValueEl: HTMLSpanElement
    #subscriptions: Subscription[] = []

    onVoxelSizeMmChange?: (mm: number) => void
    onMdcExportLeversChange?: () => void
    /** Fired when renormalize toggle changes (full `SimplifyTuning` after merge). */
    onSimplifyTuningChange?: (tuning: SimplifyTuning) => void
    onMeshExporterChange?: (exporter: ExporterKind) => void
    onIsoSimplicialTuningChange?: (tuning: IsoSimplicialTuning) => void

    get voxelSizeMm(): number {
        return this.#voxelSizeMm$.value
    }

    set voxelSizeMm(mm: number) {
        this.#voxelSizeMm$.next(mm)
    }

    get meshExporter(): ExporterKind {
        return this.#meshExporter$.value
    }

    set meshExporter(v: ExporterKind) {
        this.#meshExporter$.next(v)
    }

    get isoSimplicialTuning(): IsoSimplicialTuning {
        return { ...this.#settings.getGlobal().app.isoSimplicialTuning }
    }

    constructor() {
        super()
        const shadow = this.attachShadow({ mode: "open" })
        const style = document.createElement("style")
        style.textContent = devToolsBaseShadowCss()
        shadow.appendChild(style)

        const g = this.#settings.getGlobal().app
        this.#voxelSizeMm$ = new BehaviorSubject(g.meshExportVoxelSizeMm)

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
            valueEl.textContent = formatVoxelSize(this.#voxelSizeMm$.value)
            range.addEventListener("input", () => {
                const v = parseFloat(range.value)
                this.#voxelSizeMm$.next(v)
                valueEl.textContent = formatVoxelSize(v)
            })
            row.append(lab, range, valueEl)
            shadow.appendChild(row)
            this.#voxelSizeRange = range
            this.#voxelSizeValueEl = valueEl
        }
        this.#subscriptions.push(
            this.#voxelSizeMm$.pipe(skip(1)).subscribe(v => {
                this.#settings.updateGlobal({ app: { meshExportVoxelSizeMm: v } })
                this.onVoxelSizeMmChange?.(v)
            })
        )

        this.#meshExporter$ = new BehaviorSubject<ExporterKind>(g.meshExporter)
        {
            const row = document.createElement("div")
            row.className = "shade-row"
            const lab = document.createElement("span")
            lab.className = "knob-label"
            lab.textContent = "Exporter"
            const box = document.createElement("div")
            box.style.display = "flex"
            box.style.flexDirection = "column"
            box.style.alignItems = "flex-start"
            box.style.gap = "2px"
            const addExp = (value: ExporterKind, label: string) => {
                const w = document.createElement("label")
                const r = document.createElement("input")
                r.type = "radio"
                r.name = "galacticad-mesh-exporter"
                r.value = value
                r.checked = this.#meshExporter$.value === value
                r.addEventListener("change", () => {
                    if (r.checked) this.#meshExporter$.next(value)
                })
                w.append(r, document.createTextNode(` ${label}`))
                box.appendChild(w)
                this.#exporterRadios[value] = r
            }
            addExp("mdc", "MDC (GPU dual contouring)")
            addExp("shrec", "SHREC (MergeSharp)")
            addExp("isoSimplicial", "Iso-simplicial (GPU samples + CPU octree/MT)")
            row.append(lab, box)
            shadow.appendChild(row)
        }
        this.#subscriptions.push(
            this.#meshExporter$.subscribe(v => {
                for (const k of ["mdc", "shrec", "isoSimplicial"] as const) {
                    this.#exporterRadios[k]!.checked = k === v
                }
                if (v !== this.#settings.getGlobal().app.meshExporter) {
                    this.#settings.updateGlobal({ app: { meshExporter: v, useShrecExporter: v === "shrec" } })
                    this.onMeshExporterChange?.(v)
                }
            })
        )

        const isoT = g.isoSimplicialTuning
        const depthMinDisp = isoT.depthMin ?? IsoSimplicialConstants.depthMin
        const depthMaxDisp = isoT.depthMax ?? IsoSimplicialConstants.depthMax
        const isoPadDisp = isoT.boundingBoxPaddingMm ?? DEFAULT_ISO_SIMPLICIAL_BOUNDS_PADDING_MM
        this.#isoCollapse = document.createElement("dev-tools-collapse")
        this.#isoCollapse.setAttribute("label", "Iso-simplicial")
        this.#isoCollapse.setAttribute("nested", "")
        shadow.appendChild(this.#isoCollapse)

        this.#isoPhase5Checkbox = addCheckbox(this.#isoCollapse, "Phase 5 GPU edge snap", isoT.phase5Snap ?? false)
        this.#isoPhase5Checkbox.addEventListener("change", () => {
            this.#persistIsoTuning({ phase5Snap: this.#isoPhase5Checkbox.checked })
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
            this.#isoCollapse.appendChild(row)
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
            this.#isoCollapse.appendChild(row)
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
            this.#isoCollapse.appendChild(row)
            this.#isoDepthMaxRange = range
            this.#isoDepthMaxValueEl = valueEl
        }
        const isoDefaults = document.createElement("button")
        isoDefaults.textContent = "Iso defaults"
        isoDefaults.addEventListener("click", () => {
            this.#settings.updateGlobal({ app: { isoSimplicialTuning: { ...DEFAULT_ISO_SIMPLICIAL_TUNING } } })
            this.syncIsoSimplicialTuningFromSettings(this.#settings.getGlobal().app.isoSimplicialTuning)
            this.onIsoSimplicialTuningChange?.(this.#settings.getGlobal().app.isoSimplicialTuning)
        })
        this.#isoCollapse.appendChild(isoDefaults)

        const mdcCollapse = document.createElement("dev-tools-collapse")
        mdcCollapse.setAttribute("label", "MDC mesh export")
        mdcCollapse.setAttribute("nested", "")
        mdcCollapse.setAttribute("collapse-id", DEVTOOLS_COLLAPSE.appMeshExportMdc)
        shadow.appendChild(mdcCollapse)

        const mdcLevers = this.#settings.getMdcExportLevers()
        this.#mdcFeatureConstrainedPlacementCheckbox = addCheckbox(
            mdcCollapse,
            "Feature-constrained vertices",
            mdcLevers.featureConstrainedPlacement
        )
        this.#mdcFeatureConstrainedPlacementCheckbox.addEventListener("change", () => {
            this.#settings.updateGlobal({
                app: {
                    mdcExportLevers: {
                        featureConstrainedPlacement: this.#mdcFeatureConstrainedPlacementCheckbox.checked,
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
                    app: { mdcExportLevers: { [k.key]: v } },
                })
                valueEl.textContent = formatMdcValue(k.key, v)
                this.onMdcExportLeversChange?.()
            })
            row.append(lab, range, valueEl)
            mdcCollapse.appendChild(row)
            this.#mdcRows.set(k.key, { range, valueEl })
        }

        const mdcDefaults = document.createElement("button")
        mdcDefaults.textContent = "MDC defaults"
        mdcDefaults.addEventListener("click", () => {
            this.#settings.updateGlobal({
                app: {
                    mdcExportLevers: {
                        isoValue: DEFAULT_MDC_EXPORT_LEVERS.isoValue,
                        creaseAngleDeg: DEFAULT_MDC_EXPORT_LEVERS.creaseAngleDeg,
                        featureConstrainedPlacement: DEFAULT_MDC_EXPORT_LEVERS.featureConstrainedPlacement,
                    },
                },
            })
            const next = this.#settings.getGlobal().app.mdcExportLevers
            this.#mdcFeatureConstrainedPlacementCheckbox.checked = next.featureConstrainedPlacement
            for (const knob of MDC_RANGE_KNOBS) {
                const row = this.#mdcRows.get(knob.key)
                if (!row) continue
                row.range.value = String(next[knob.key])
                row.valueEl.textContent = formatMdcValue(knob.key, next[knob.key])
            }
            this.onMdcExportLeversChange?.()
        })
        mdcCollapse.appendChild(mdcDefaults)

        const st = g.simplifyTuning
        this.#renormalizeTrianglesCheckbox = addCheckbox(
            shadow,
            "Renormalize triangles",
            st.renormalizeTriangles
        )
        this.#renormalizeTrianglesCheckbox.addEventListener("change", () => {
            const cur = this.#settings.getGlobal().app.simplifyTuning
            const next: SimplifyTuning = { ...cur, renormalizeTriangles: this.#renormalizeTrianglesCheckbox.checked }
            this.#settings.updateGlobal({ app: { simplifyTuning: next } })
            this.onSimplifyTuningChange?.(next)
        })
    }

    syncVoxelSizeMmFromSettings(mm: number): void {
        this.#voxelSizeMm$.next(mm)
        this.#voxelSizeRange.value = String(mm)
        this.#voxelSizeValueEl.textContent = formatVoxelSize(mm)
    }

    syncRenormalizeFromSimplifyTuning(tuning: SimplifyTuning): void {
        this.#renormalizeTrianglesCheckbox.checked = tuning.renormalizeTriangles
    }

    syncMdcLeversFromSettings(levers: MdcExportLevers): void {
        this.#mdcFeatureConstrainedPlacementCheckbox.checked = levers.featureConstrainedPlacement
        for (const k of MDC_RANGE_KNOBS) {
            const row = this.#mdcRows.get(k.key)
            if (!row) continue
            row.range.value = String(levers[k.key])
            row.valueEl.textContent = formatMdcValue(k.key, levers[k.key])
        }
    }

    syncMeshExporterFromSettings(exporter: ExporterKind): void {
        this.#meshExporter$.next(exporter)
    }

    syncIsoSimplicialTuningFromSettings(tuning: IsoSimplicialTuning): void {
        this.#isoPhase5Checkbox.checked = tuning.phase5Snap ?? false
        const pad = tuning.boundingBoxPaddingMm ?? DEFAULT_ISO_SIMPLICIAL_BOUNDS_PADDING_MM
        this.#isoBoundsPadRange.value = String(pad)
        this.#isoBoundsPadValueEl.textContent = pad.toFixed(1)
        const dmin = tuning.depthMin ?? IsoSimplicialConstants.depthMin
        const dmax = tuning.depthMax ?? IsoSimplicialConstants.depthMax
        this.#isoDepthMinRange.value = String(dmin)
        this.#isoDepthMinValueEl.textContent = String(dmin)
        this.#isoDepthMaxRange.value = String(dmax)
        this.#isoDepthMaxValueEl.textContent = String(dmax)
    }

    #persistIsoTuning(patch: Partial<IsoSimplicialTuning>): void {
        const cur = this.#settings.getGlobal().app.isoSimplicialTuning
        const next: IsoSimplicialTuning = { ...cur, ...patch }
        this.#settings.updateGlobal({ app: { isoSimplicialTuning: next } })
        this.onIsoSimplicialTuningChange?.(next)
    }

    disconnectedCallback(): void {
        for (const s of this.#subscriptions) s.unsubscribe()
        this.#subscriptions = []
    }
}

/**
 * Meshoptimizer / QEM simplification tuning (persisted in `SimplifyTuning`; renormalize lives on
 * {@link DevToolsMeshExportCoreSection}).
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

    onSimplifyTuningChange?: (tuning: SimplifyTuning) => void

    get simplifyTuning(): SimplifyTuning {
        const r = this.#settings.getGlobal().app.simplifyTuning.renormalizeTriangles
        return { ...this.#simplifyTuningState, renormalizeTriangles: r }
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

        const simplifyDefaults = document.createElement("button")
        simplifyDefaults.textContent = "Simplify defaults"
        simplifyDefaults.addEventListener("click", () => {
            const keepRenorm = this.#settings.getGlobal().app.simplifyTuning.renormalizeTriangles
            this.syncSimplifyTuningFromSettings({ ...DEFAULT_SIMPLIFY_TUNING, renormalizeTriangles: keepRenorm })
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
    }

    #persistSimplifyTuning(): void {
        const r = this.#settings.getGlobal().app.simplifyTuning.renormalizeTriangles
        const next = { ...this.#simplifyTuningState, renormalizeTriangles: r }
        this.#settings.updateGlobal({ app: { simplifyTuning: next } })
        this.onSimplifyTuningChange?.(next)
    }
}

/** SHREC MergeSharp tuning (select **SHREC** under Mesh export → Exporter). */
export class DevToolsShrecExportSection extends HTMLElement {
    #settings = SettingsManager.instance
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

        const g = this.#settings.getGlobal().app

        this.#shrecTuningState = { ...DEFAULT_SHREC_TUNING, ...g.shrecTuning }
        const root = document.createElement("div")
        root.className = "lighting-section"
        shadow.appendChild(root)

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
    }

    #persistShrecTuning(): void {
        const next = { ...this.#shrecTuningState }
        this.#settings.updateGlobal({ app: { shrecTuning: next } })
        this.onShrecTuningChange?.(next)
    }

    disconnectedCallback(): void {
        for (const s of this.#subscriptions) s.unsubscribe()
        this.#subscriptions = []
    }
}

customElements.define("dev-tools-mesh-export-core-section", DevToolsMeshExportCoreSection)
customElements.define("dev-tools-mesh-simplify-section", DevToolsMeshSimplifySection)
customElements.define("dev-tools-shrec-export-section", DevToolsShrecExportSection)

declare global {
    interface HTMLElementTagNameMap {
        "dev-tools-mesh-export-core-section": DevToolsMeshExportCoreSection
        "dev-tools-mesh-simplify-section": DevToolsMeshSimplifySection
        "dev-tools-shrec-export-section": DevToolsShrecExportSection
    }
}
