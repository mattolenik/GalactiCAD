import { BehaviorSubject, skip } from "rxjs"
import type { Subscription } from "rxjs"
import { connectCheckbox } from "../binding/bind.mjs"
import {
    DEFAULT_APP_DEVTOOLS_STATE,
    DEVTOOLS_SECTION_APP,
    dispatchDevToolsStateChange,
    type DevToolsPersistable,
    type JSONValue,
} from "./dev-tools-protocol.mjs"
import { devToolsBaseShadowCss } from "./dev-tools-styles.mjs"

function asBool(v: unknown, fallback: boolean): boolean {
    return typeof v === "boolean" ? v : fallback
}

export class DevToolsAppSection extends HTMLElement implements DevToolsPersistable {
    readonly devToolsSectionId = DEVTOOLS_SECTION_APP
    #applying = false
    #showFps$: BehaviorSubject<boolean>
    #meshViewer$: BehaviorSubject<boolean>
    #meshSimplify$: BehaviorSubject<boolean>
    #lightingExpanded$: BehaviorSubject<boolean>
    #subscriptions: Subscription[] = []

    /** Panel wires this so the renderer section can show/hide lighting sliders. */
    onLightingExpandedChange?: (expanded: boolean) => void

    get lightingExpanded(): boolean {
        return this.#lightingExpanded$.value
    }

    get showFps(): boolean {
        return this.#showFps$.value
    }

    set showFps(v: boolean) {
        this.#showFps$.next(v)
    }

    get meshViewer(): boolean {
        return this.#meshViewer$.value
    }

    set meshViewer(v: boolean) {
        this.#meshViewer$.next(v)
    }

    get meshSimplifyOnExport(): boolean {
        return this.#meshSimplify$.value
    }

    set meshSimplifyOnExport(v: boolean) {
        this.#meshSimplify$.next(v)
    }

    constructor() {
        super()
        const shadow = this.attachShadow({ mode: "open" })
        const style = document.createElement("style")
        style.textContent = devToolsBaseShadowCss()
        shadow.appendChild(style)

        const d = DEFAULT_APP_DEVTOOLS_STATE
        this.#showFps$ = new BehaviorSubject(asBool(d.showFps, true))
        this.#meshViewer$ = new BehaviorSubject(asBool(d.meshViewerEnabled, false))
        this.#meshSimplify$ = new BehaviorSubject(asBool(d.meshSimplifyOnExport, true))
        this.#lightingExpanded$ = new BehaviorSubject(asBool(d.lightingExpanded, false))

        const persist = () => {
            if (this.#applying) return
            dispatchDevToolsStateChange(this, this.devToolsSectionId)
        }

        const showFpsCb = this.#addCheckbox(shadow, "Show FPS", this.#showFps$.value)
        this.#subscriptions.push(connectCheckbox(showFpsCb, this.#showFps$))
        this.#showFps$.pipe(skip(1)).subscribe(() => {
            persist()
            this.dispatchEvent(new CustomEvent("galacticad-show-fps-change", { bubbles: true, composed: true }))
        })

        const meshCb = this.#addCheckbox(shadow, "Export preview", this.#meshViewer$.value)
        this.#subscriptions.push(connectCheckbox(meshCb, this.#meshViewer$))
        this.#meshViewer$.pipe(skip(1)).subscribe(() => {
            persist()
            this.dispatchEvent(new CustomEvent("galacticad-mesh-viewer-change", { bubbles: true, composed: true }))
        })

        const meshSimpCb = this.#addCheckbox(shadow, "Mesh simplify", this.#meshSimplify$.value)
        this.#subscriptions.push(connectCheckbox(meshSimpCb, this.#meshSimplify$))
        this.#meshSimplify$.pipe(skip(1)).subscribe(() => {
            persist()
            this.dispatchEvent(new CustomEvent("galacticad-mesh-simplify-change", { bubbles: true, composed: true }))
        })

        const lightingCb = this.#addCheckbox(shadow, "Show lighting", this.#lightingExpanded$.value)
        this.#subscriptions.push(connectCheckbox(lightingCb, this.#lightingExpanded$))
        this.#lightingExpanded$.pipe(skip(1)).subscribe(v => {
            persist()
            this.onLightingExpandedChange?.(v)
        })
    }

    getDevToolsState(): Record<string, JSONValue> {
        return {
            showFps: this.#showFps$.value,
            meshViewerEnabled: this.#meshViewer$.value,
            meshSimplifyOnExport: this.#meshSimplify$.value,
            lightingExpanded: this.#lightingExpanded$.value,
        }
    }

    setDevToolsState(state: Record<string, JSONValue>): void {
        this.#applying = true
        try {
            const d = DEFAULT_APP_DEVTOOLS_STATE
            this.#showFps$.next(asBool(state.showFps, asBool(d.showFps, true)))
            this.#meshViewer$.next(asBool(state.meshViewerEnabled, asBool(d.meshViewerEnabled, false)))
            this.#meshSimplify$.next(asBool(state.meshSimplifyOnExport, asBool(d.meshSimplifyOnExport, true)))
            this.#lightingExpanded$.next(asBool(state.lightingExpanded, asBool(d.lightingExpanded, false)))
            this.onLightingExpandedChange?.(this.#lightingExpanded$.value)
        } finally {
            this.#applying = false
        }
    }

    disconnectedCallback(): void {
        for (const s of this.#subscriptions) s.unsubscribe()
        this.#subscriptions = []
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
}

customElements.define("dev-tools-app-section", DevToolsAppSection)

declare global {
    interface HTMLElementTagNameMap {
        "dev-tools-app-section": DevToolsAppSection
    }
}
