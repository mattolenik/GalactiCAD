import { BehaviorSubject, skip } from "rxjs"
import type { Subscription } from "rxjs"
import { connectCheckbox } from "../binding/bind.mjs"
import { SettingsManager } from "../storage/settings.mjs"
import {
    DEFAULT_MDC_EXPORT_LEVERS,
    DEFAULT_SHREC_TUNING,
    DEFAULT_SIMPLIFY_TUNING,
    type MdcExportLevers,
    type ShrecTuning,
    type SimplifyTuning,
} from "../render-worker-protocol.mjs"
import { DEVTOOLS_COLLAPSE } from "./dev-tools-protocol.mjs"
import { devToolsBaseShadowCss } from "./dev-tools-styles.mjs"
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
    #subscriptions: Subscription[] = []

    onVoxelSizeMmChange?: (mm: number) => void
    onMdcExportLeversChange?: () => void
    /** Fired when renormalize toggle changes (full `SimplifyTuning` after merge). */
    onSimplifyTuningChange?: (tuning: SimplifyTuning) => void

    get voxelSizeMm(): number {
        return this.#voxelSizeMm$.value
    }

    set voxelSizeMm(mm: number) {
        this.#voxelSizeMm$.next(mm)
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

/** SHREC exporter toggle and tuning (persisted on `GlobalSettings.app`). */
export class DevToolsShrecExportSection extends HTMLElement {
    #settings = SettingsManager.instance
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
    #subscriptions: Subscription[] = []

    onUseShrecExporterChange?: (enabled: boolean) => void
    onShrecTuningChange?: (tuning: ShrecTuning) => void

    get useShrecExporter(): boolean {
        return this.#useShrec$.value
    }

    set useShrecExporter(enabled: boolean) {
        this.#useShrec$.next(enabled)
    }

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
        this.#useShrec$ = new BehaviorSubject(g.useShrecExporter)

        this.#useShrecCheckbox = addCheckbox(shadow, "SHREC exporter", this.#useShrec$.value)
        this.#subscriptions.push(connectCheckbox(this.#useShrecCheckbox, this.#useShrec$))
        this.#subscriptions.push(
            this.#useShrec$.pipe(skip(1)).subscribe(v => {
                this.#settings.updateGlobal({ app: { useShrecExporter: v } })
                this.onUseShrecExporterChange?.(v)
            })
        )

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
