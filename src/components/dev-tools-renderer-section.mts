import { BehaviorSubject, skip } from "rxjs"
import type { Subscription } from "rxjs"
import { connectCheckbox } from "../binding/bind.mjs"
import {
    DEFAULT_RAY_MARCH_PARAMS,
    type RayMarchParams,
} from "../render-worker-protocol.mjs"
import { DEVTOOLS_COLLAPSE } from "./dev-tools-protocol.mjs"
import { devToolsBaseShadowCss } from "./dev-tools-styles.mjs"
import "./dev-tools-collapse.mjs"

/** Preview toggles and lighting sliders (persisted elsewhere; not `DevToolsPersistable`). */
export class DevToolsRendererSection extends HTMLElement {
    #cameraOptCheckbox: HTMLInputElement
    #cameraOptimization$: BehaviorSubject<boolean>
    #beamOptCheckbox: HTMLInputElement
    #beamOptimization$: BehaviorSubject<boolean>
    #bvhOptCheckbox: HTMLInputElement
    #bvhOptimization$: BehaviorSubject<boolean>
    #subscriptions: Subscription[] = []

    #rayMarchState: RayMarchParams = { ...DEFAULT_RAY_MARCH_PARAMS }

    onCameraOptimizationChange?: (enabled: boolean) => void
    onBeamOptimizationChange?: (enabled: boolean) => void
    onBvhOptimizationChange?: (enabled: boolean) => void
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

        const perfBox = document.createElement("dev-tools-collapse")
        perfBox.setAttribute("label", "Performance")
        perfBox.setAttribute("nested", "")
        perfBox.setAttribute("collapse-id", DEVTOOLS_COLLAPSE.rendererPerformance)
        shadow.appendChild(perfBox)

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
