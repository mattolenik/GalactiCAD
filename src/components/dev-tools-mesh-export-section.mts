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

/** Boolean fields on `SimplifyTuning` (meshoptimizer flags + post-pass toggles). */
type SimplifyBoolKey =
    | "lockBorder"
    | "sparse"
    | "errorAbsolute"
    | "prune"
    | "regularize"
    | "renormalizeTriangles"

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

/**
 * Voxel size, MDC levers, mesh simplification, and SHREC tuning (persisted on `GlobalSettings.app`).
 */
export class DevToolsMeshExportSection extends HTMLElement {
    #settings = SettingsManager.instance
    #voxelSizeMm$: BehaviorSubject<number>
    #voxelSizeRange: HTMLInputElement
    #voxelSizeValueEl: HTMLSpanElement
    #mdcRows = new Map<
        (typeof MDC_RANGE_KNOBS)[number]["key"],
        { range: HTMLInputElement; valueEl: HTMLSpanElement }
    >()
    #mdcFeatureConstrainedPlacementCheckbox: HTMLInputElement
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
    #subscriptions: Subscription[] = []

    onVoxelSizeMmChange?: (mm: number) => void
    onUseShrecExporterChange?: (enabled: boolean) => void
    onShrecTuningChange?: (tuning: ShrecTuning) => void
    onSimplifyTuningChange?: (tuning: SimplifyTuning) => void
    onMdcExportLeversChange?: () => void

    get voxelSizeMm(): number {
        return this.#voxelSizeMm$.value
    }

    set voxelSizeMm(mm: number) {
        this.#voxelSizeMm$.next(mm)
    }

    get useShrecExporter(): boolean {
        return this.#useShrec$.value
    }

    set useShrecExporter(enabled: boolean) {
        this.#useShrec$.next(enabled)
    }

    get shrecTuning(): ShrecTuning {
        return { ...this.#shrecTuningState }
    }

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
        this.#voxelSizeMm$ = new BehaviorSubject(g.meshExportVoxelSizeMm)
        this.#useShrec$ = new BehaviorSubject(g.useShrecExporter)

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
            valueEl.textContent = DevToolsMeshExportSection.#formatVoxelSize(this.#voxelSizeMm$.value)
            range.addEventListener("input", () => {
                const v = parseFloat(range.value)
                this.#voxelSizeMm$.next(v)
                valueEl.textContent = DevToolsMeshExportSection.#formatVoxelSize(v)
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
        this.#mdcFeatureConstrainedPlacementCheckbox = this.#addCheckbox(
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
            valueEl.textContent = DevToolsMeshExportSection.#formatMdcValue(k.key, mdcLevers[k.key])
            range.addEventListener("input", () => {
                let v = parseFloat(range.value)
                if (!Number.isFinite(v)) v = k.min
                v = Math.max(k.min, Math.min(k.max, v))
                this.#settings.updateGlobal({
                    app: { mdcExportLevers: { [k.key]: v } },
                })
                valueEl.textContent = DevToolsMeshExportSection.#formatMdcValue(k.key, v)
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
                row.valueEl.textContent = DevToolsMeshExportSection.#formatMdcValue(knob.key, next[knob.key])
            }
            this.onMdcExportLeversChange?.()
        })
        mdcCollapse.appendChild(mdcDefaults)

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
            valueEl.textContent = DevToolsMeshExportSection.#formatSimplifyValue("targetRatio", this.#simplifyTuningState.targetRatio)
            range.addEventListener("input", () => {
                const v = parseFloat(range.value)
                this.#simplifyTuningState = { ...this.#simplifyTuningState, targetRatio: v }
                valueEl.textContent = DevToolsMeshExportSection.#formatSimplifyValue("targetRatio", v)
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
            valueEl.textContent = DevToolsMeshExportSection.#formatSimplifyValue("targetError", this.#simplifyTuningState.targetError)
            range.addEventListener("input", () => {
                const v = parseFloat(range.value)
                this.#simplifyTuningState = { ...this.#simplifyTuningState, targetError: v }
                valueEl.textContent = DevToolsMeshExportSection.#formatSimplifyValue("targetError", v)
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
            valueEl.textContent = DevToolsMeshExportSection.#formatSimplifyValue("normalWeight", this.#simplifyTuningState.normalWeight)
            range.addEventListener("input", () => {
                const v = parseFloat(range.value)
                this.#simplifyTuningState = { ...this.#simplifyTuningState, normalWeight: v }
                valueEl.textContent = DevToolsMeshExportSection.#formatSimplifyValue("normalWeight", v)
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
            { key: "renormalizeTriangles", label: "Renormalize triangles" },
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
        this.#subscriptions.push(
            this.#useShrec$.pipe(skip(1)).subscribe(v => {
                this.#settings.updateGlobal({ app: { useShrecExporter: v } })
                this.onUseShrecExporterChange?.(v)
            })
        )

        this.#shrecTuningState = { ...DEFAULT_SHREC_TUNING, ...g.shrecTuning }
        this.#shrecSection = document.createElement("div")
        this.#shrecSection.className = "lighting-section"
        shadow.appendChild(this.#shrecSection)

        const shrecHead = document.createElement("div")
        shrecHead.className = "shade-head"
        shrecHead.textContent = "SHREC tuning"
        this.#shrecSection.appendChild(shrecHead)

        this.#shrecMergeSharpCheckbox = this.#addCheckbox(this.#shrecSection, "MergeSharp", this.#shrecTuningState.mergeSharpEnabled)
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
            valueEl.textContent = DevToolsMeshExportSection.#formatShrecValue("mergeRelCutoff", this.#shrecTuningState.mergeRelCutoff)
            range.addEventListener("input", () => {
                const v = parseFloat(range.value)
                this.#shrecTuningState = { ...this.#shrecTuningState, mergeRelCutoff: v }
                valueEl.textContent = DevToolsMeshExportSection.#formatShrecValue("mergeRelCutoff", v)
                this.#persistShrecTuning()
            })
            row.append(lab, range, valueEl)
            this.#shrecSection.appendChild(row)
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
            valueEl.textContent = DevToolsMeshExportSection.#formatShrecValue("mergeMaxDisplacement", this.#shrecTuningState.mergeMaxDisplacement)
            range.addEventListener("input", () => {
                const v = parseFloat(range.value)
                this.#shrecTuningState = { ...this.#shrecTuningState, mergeMaxDisplacement: v }
                valueEl.textContent = DevToolsMeshExportSection.#formatShrecValue("mergeMaxDisplacement", v)
                this.#persistShrecTuning()
            })
            row.append(lab, range, valueEl)
            this.#shrecSection.appendChild(row)
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
            valueEl.textContent = DevToolsMeshExportSection.#formatShrecValue("creaseAngleDeg", this.#shrecTuningState.creaseAngleDeg)
            range.addEventListener("input", () => {
                const v = parseFloat(range.value)
                this.#shrecTuningState = { ...this.#shrecTuningState, creaseAngleDeg: v }
                valueEl.textContent = DevToolsMeshExportSection.#formatShrecValue("creaseAngleDeg", v)
                this.#persistShrecTuning()
            })
            row.append(lab, range, valueEl)
            this.#shrecSection.appendChild(row)
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
            valueEl.textContent = DevToolsMeshExportSection.#formatShrecValue("mergeGradientWeightPower", this.#shrecTuningState.mergeGradientWeightPower)
            range.addEventListener("input", () => {
                const v = parseFloat(range.value)
                this.#shrecTuningState = { ...this.#shrecTuningState, mergeGradientWeightPower: v }
                valueEl.textContent = DevToolsMeshExportSection.#formatShrecValue("mergeGradientWeightPower", v)
                this.#persistShrecTuning()
            })
            row.append(lab, range, valueEl)
            this.#shrecSection.appendChild(row)
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
            valueEl.textContent = DevToolsMeshExportSection.#formatShrecValue("dedupRadiusVoxels", this.#shrecTuningState.dedupRadiusVoxels)
            range.addEventListener("input", () => {
                const v = parseFloat(range.value)
                this.#shrecTuningState = { ...this.#shrecTuningState, dedupRadiusVoxels: v }
                valueEl.textContent = DevToolsMeshExportSection.#formatShrecValue("dedupRadiusVoxels", v)
                this.#persistShrecTuning()
            })
            row.append(lab, range, valueEl)
            this.#shrecSection.appendChild(row)
            this.#shrecDedupRange = range
            this.#shrecDedupValueEl = valueEl
        }

        this.#shrecSeamAwareCheckbox = this.#addCheckbox(this.#shrecSection, "Seam-aware QEF", this.#shrecTuningState.seamAwareEnabled)
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
            valueEl.textContent = DevToolsMeshExportSection.#formatShrecValue("seamAgreementCosThreshold", this.#shrecTuningState.seamAgreementCosThreshold)
            range.addEventListener("input", () => {
                const v = parseFloat(range.value)
                this.#shrecTuningState = { ...this.#shrecTuningState, seamAgreementCosThreshold: v }
                valueEl.textContent = DevToolsMeshExportSection.#formatShrecValue("seamAgreementCosThreshold", v)
                this.#persistShrecTuning()
            })
            row.append(lab, range, valueEl)
            this.#shrecSection.appendChild(row)
            this.#shrecSeamAgreementRange = range
            this.#shrecSeamAgreementValueEl = valueEl
        }

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
    }

    syncVoxelSizeMmFromSettings(mm: number): void {
        this.#voxelSizeMm$.next(mm)
        this.#voxelSizeRange.value = String(mm)
        this.#voxelSizeValueEl.textContent = DevToolsMeshExportSection.#formatVoxelSize(mm)
    }

    syncSimplifyTuningFromSettings(tuning: SimplifyTuning): void {
        this.#simplifyTuningState = { ...tuning }
        this.#simplifyTargetRatioRange.value = String(tuning.targetRatio)
        this.#simplifyTargetRatioValueEl.textContent = DevToolsMeshExportSection.#formatSimplifyValue("targetRatio", tuning.targetRatio)
        this.#simplifyTargetErrorRange.value = String(tuning.targetError)
        this.#simplifyTargetErrorValueEl.textContent = DevToolsMeshExportSection.#formatSimplifyValue("targetError", tuning.targetError)
        this.#simplifyNormalWeightRange.value = String(tuning.normalWeight)
        this.#simplifyNormalWeightValueEl.textContent = DevToolsMeshExportSection.#formatSimplifyValue("normalWeight", tuning.normalWeight)
        for (const key of this.#simplifyBoolCheckboxes.keys()) {
            const cb = this.#simplifyBoolCheckboxes.get(key)!
            cb.checked = tuning[key]
        }
    }

    syncMdcLeversFromSettings(levers: MdcExportLevers): void {
        this.#mdcFeatureConstrainedPlacementCheckbox.checked = levers.featureConstrainedPlacement
        for (const k of MDC_RANGE_KNOBS) {
            const row = this.#mdcRows.get(k.key)
            if (!row) continue
            row.range.value = String(levers[k.key])
            row.valueEl.textContent = DevToolsMeshExportSection.#formatMdcValue(k.key, levers[k.key])
        }
    }

    syncShrecTuningFromSettings(tuning: ShrecTuning): void {
        this.#shrecTuningState = { ...tuning }
        this.#shrecMergeSharpCheckbox.checked = tuning.mergeSharpEnabled
        this.#shrecRelCutoffRange.value = String(tuning.mergeRelCutoff)
        this.#shrecRelCutoffValueEl.textContent = DevToolsMeshExportSection.#formatShrecValue("mergeRelCutoff", tuning.mergeRelCutoff)
        this.#shrecMaxDispRange.value = String(tuning.mergeMaxDisplacement)
        this.#shrecMaxDispValueEl.textContent = DevToolsMeshExportSection.#formatShrecValue("mergeMaxDisplacement", tuning.mergeMaxDisplacement)
        this.#shrecCreaseRange.value = String(tuning.creaseAngleDeg)
        this.#shrecCreaseValueEl.textContent = DevToolsMeshExportSection.#formatShrecValue("creaseAngleDeg", tuning.creaseAngleDeg)
        this.#shrecGradWeightRange.value = String(tuning.mergeGradientWeightPower)
        this.#shrecGradWeightValueEl.textContent = DevToolsMeshExportSection.#formatShrecValue("mergeGradientWeightPower", tuning.mergeGradientWeightPower)
        this.#shrecDedupRange.value = String(tuning.dedupRadiusVoxels)
        this.#shrecDedupValueEl.textContent = DevToolsMeshExportSection.#formatShrecValue("dedupRadiusVoxels", tuning.dedupRadiusVoxels)
        this.#shrecSeamAwareCheckbox.checked = tuning.seamAwareEnabled
        this.#shrecSeamAgreementRange.value = String(tuning.seamAgreementCosThreshold)
        this.#shrecSeamAgreementValueEl.textContent = DevToolsMeshExportSection.#formatShrecValue("seamAgreementCosThreshold", tuning.seamAgreementCosThreshold)
        this.#shrecEdgeFitCheckbox.checked = tuning.edgeFitEnabled
    }

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

    static #formatVoxelSize(mm: number): string {
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
            const deg = Math.acos(Math.max(-1, Math.min(1, v))) * 180 / Math.PI
            return `${deg.toFixed(0)}°`
        }
        return v.toFixed(2)
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

    disconnectedCallback(): void {
        for (const s of this.#subscriptions) s.unsubscribe()
        this.#subscriptions = []
    }
}

customElements.define("dev-tools-mesh-export-section", DevToolsMeshExportSection)

declare global {
    interface HTMLElementTagNameMap {
        "dev-tools-mesh-export-section": DevToolsMeshExportSection
    }
}
