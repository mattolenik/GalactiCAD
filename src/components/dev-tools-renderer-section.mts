import { BehaviorSubject, skip } from "rxjs"
import type { Subscription } from "rxjs"
import { connectCheckbox } from "../binding/bind.mjs"
import {
    DEFAULT_PREVIEW_SHADING,
    DEFAULT_RAY_MARCH_PARAMS,
    type PreviewShadingParams,
    type RayMarchParams,
} from "../render-worker-protocol.mjs"
import { DEVTOOLS_COLLAPSE } from "./dev-tools-protocol.mjs"
import { devToolsBaseShadowCss } from "./dev-tools-styles.mjs"
import "./dev-tools-collapse.mjs"

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

/** Preview toggles and lighting sliders (persisted elsewhere; not `DevToolsPersistable`). */
export class DevToolsRendererSection extends HTMLElement {
    #cameraOptCheckbox: HTMLInputElement
    #cameraOptimization$: BehaviorSubject<boolean>
    #beamOptCheckbox: HTMLInputElement
    #beamOptimization$: BehaviorSubject<boolean>
    #bvhOptCheckbox: HTMLInputElement
    #bvhOptimization$: BehaviorSubject<boolean>
    #normalPreviewCheckbox: HTMLInputElement
    #shadingState: PreviewShadingParams = { ...DEFAULT_PREVIEW_SHADING }
    #shadingRows = new Map<keyof PreviewShadingParams, { range: HTMLInputElement; valueEl: HTMLSpanElement }>()
    #lightingSection: HTMLDivElement
    #subscriptions: Subscription[] = []

    #rayMarchState: RayMarchParams = { ...DEFAULT_RAY_MARCH_PARAMS }

    onCameraOptimizationChange?: (enabled: boolean) => void
    onBeamOptimizationChange?: (enabled: boolean) => void
    onBvhOptimizationChange?: (enabled: boolean) => void
    onPreviewShadingChange?: (params: PreviewShadingParams) => void
    onPreviewNormalShadingChange?: (enabled: boolean) => void
    onRayMarchParamsChange?: (params: RayMarchParams) => void

    constructor() {
        super()
        const shadow = this.attachShadow({ mode: "open" })
        const style = document.createElement("style")
        style.textContent = devToolsBaseShadowCss()
        shadow.appendChild(style)

        this.#cameraOptimization$ = new BehaviorSubject(true)
        this.#beamOptimization$ = new BehaviorSubject(false)
        this.#bvhOptimization$ = new BehaviorSubject(true)

        this.#lightingSection = document.createElement("div")
        this.#lightingSection.className = "lighting-section"
        this.#lightingSection.hidden = true

        const perfBox = document.createElement("dev-tools-collapse")
        perfBox.setAttribute("label", "Performance")
        perfBox.setAttribute("nested", "")
        perfBox.setAttribute("collapse-id", DEVTOOLS_COLLAPSE.rendererPerformance)
        shadow.appendChild(perfBox)

        const previewBox = document.createElement("dev-tools-collapse")
        previewBox.setAttribute("label", "Preview shading")
        previewBox.setAttribute("nested", "")
        previewBox.setAttribute("collapse-id", DEVTOOLS_COLLAPSE.rendererPreviewShading)
        shadow.appendChild(previewBox)

        this.#cameraOptCheckbox = this.#addCheckbox(perfBox, "Camera halfres", this.#cameraOptimization$.value)
        this.#subscriptions.push(connectCheckbox(this.#cameraOptCheckbox, this.#cameraOptimization$))
        this.#subscriptions.push(
            this.#cameraOptimization$.pipe(skip(1)).subscribe(v => {
                this.onCameraOptimizationChange?.(v)
            })
        )

        this.#beamOptCheckbox = this.#addCheckbox(perfBox, "Beam render", this.#beamOptimization$.value)
        this.#subscriptions.push(connectCheckbox(this.#beamOptCheckbox, this.#beamOptimization$))
        this.#subscriptions.push(
            this.#beamOptimization$.pipe(skip(1)).subscribe(v => {
                this.onBeamOptimizationChange?.(v)
            })
        )

        this.#bvhOptCheckbox = this.#addCheckbox(perfBox, "BVH optimize", this.#bvhOptimization$.value)
        this.#subscriptions.push(connectCheckbox(this.#bvhOptCheckbox, this.#bvhOptimization$))
        this.#subscriptions.push(
            this.#bvhOptimization$.pipe(skip(1)).subscribe(v => {
                this.onBvhOptimizationChange?.(v)
            })
        )

        const rayMarchKnobs: { key: keyof RayMarchParams; label: string; min: number; max: number; step: number }[] = [
            { key: "maxSteps", label: "Max steps", min: 50, max: 2000, step: 50 },
            { key: "maxDist", label: "Max dist", min: 50, max: 2000, step: 50 },
            { key: "maxBeamSteps", label: "Beam steps", min: 20, max: 1000, step: 20 },
            { key: "hitRefineSteps", label: "Hit refine", min: 1, max: 64, step: 1 },
            { key: "rayOriginDepth", label: "Ray origin Z", min: 50, max: 1000, step: 10 },
        ]
        for (const k of rayMarchKnobs) {
            const row = document.createElement("div")
            row.className = "shade-row"
            const lab = document.createElement("label")
            lab.className = "knob-label"
            lab.textContent = k.label
            const input = document.createElement("input")
            input.type = "number"
            input.min = String(k.min)
            input.max = String(k.max)
            input.step = String(k.step)
            input.value = String(this.#rayMarchState[k.key])
            input.style.cssText = "width:60px;font-size:11px;"
            input.addEventListener("change", () => {
                const v = parseFloat(input.value)
                if (!Number.isFinite(v)) return
                ;(this.#rayMarchState[k.key] as number) = v
                this.onRayMarchParamsChange?.({ ...this.#rayMarchState })
            })
            row.append(lab, input)
            perfBox.appendChild(row)
        }

        this.#normalPreviewCheckbox = this.#addCheckbox(previewBox, "Normal mode", false)
        this.#normalPreviewCheckbox.addEventListener("change", () => {
            this.onPreviewNormalShadingChange?.(this.#normalPreviewCheckbox.checked)
        })

        previewBox.appendChild(this.#lightingSection)

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
            valueEl.textContent = DevToolsRendererSection.#formatShadeValue(k.key, v0)
            range.addEventListener("input", () => {
                const v = parseFloat(range.value)
                this.#shadingState[k.key] = v
                valueEl.textContent = DevToolsRendererSection.#formatShadeValue(k.key, v)
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
                row.valueEl.textContent = DevToolsRendererSection.#formatShadeValue(knob.key, v)
            }
            this.onPreviewShadingChange?.({ ...this.#shadingState })
        })
        this.#lightingSection.appendChild(shadeDefaults)
    }

    setLightingSectionVisible(expanded: boolean): void {
        this.#lightingSection.hidden = !expanded
    }

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

    syncPreviewShadingFromRenderer(params: PreviewShadingParams): void {
        this.#shadingState = { ...params }
        for (const knob of PREVIEW_SHADING_KNOBS) {
            const row = this.#shadingRows.get(knob.key)
            if (!row) continue
            const v = params[knob.key]
            row.range.value = String(v)
            row.valueEl.textContent = DevToolsRendererSection.#formatShadeValue(knob.key, v)
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

    disconnectedCallback(): void {
        for (const s of this.#subscriptions) s.unsubscribe()
        this.#subscriptions = []
    }
}

customElements.define("dev-tools-renderer-section", DevToolsRendererSection)

declare global {
    interface HTMLElementTagNameMap {
        "dev-tools-renderer-section": DevToolsRendererSection
    }
}
