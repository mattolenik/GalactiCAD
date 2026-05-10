import { BehaviorSubject, skip } from "rxjs"
import type { Subscription } from "rxjs"
import { connectCheckbox } from "../binding/bind.mjs"
import {
    DEFAULT_APP_DEVTOOLS_STATE,
    DEVTOOLS_COLLAPSE,
    DEVTOOLS_SECTION_APP,
    dispatchDevToolsStateChange,
    type DevToolsPersistable,
    type JSONValue,
} from "./dev-tools-protocol.mjs"
import { devToolsBaseShadowCss } from "./dev-tools-styles.mjs"
import "./dev-tools-collapse.mjs"

function asBool(v: unknown, fallback: boolean): boolean {
    return typeof v === "boolean" ? v : fallback
}

export class DevToolsAppSection extends HTMLElement implements DevToolsPersistable {
    readonly devToolsSectionId = DEVTOOLS_SECTION_APP
    #applying = false
    #showFps$: BehaviorSubject<boolean>
    #meshViewer$: BehaviorSubject<boolean>
    #meshSimplify$: BehaviorSubject<boolean>
    #subscriptions: Subscription[] = []

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
        this.#meshSimplify$ = new BehaviorSubject(asBool(d.meshSimplifyOnExport, false))

        const persist = () => {
            if (this.#applying) return
            dispatchDevToolsStateChange(this, this.devToolsSectionId)
        }

        const viewportBox = document.createElement("dev-tools-collapse")
        viewportBox.setAttribute("label", "Viewport")
        viewportBox.setAttribute("nested", "")
        viewportBox.setAttribute("collapse-id", DEVTOOLS_COLLAPSE.appViewport)
        shadow.appendChild(viewportBox)

        const exportBox = document.createElement("dev-tools-collapse")
        exportBox.setAttribute("label", "Export")
        exportBox.setAttribute("nested", "")
        exportBox.setAttribute("collapse-id", DEVTOOLS_COLLAPSE.appExport)
        shadow.appendChild(exportBox)

        const showFpsCb = this.#addCheckbox(viewportBox, "Show FPS", this.#showFps$.value)
        this.#subscriptions.push(connectCheckbox(showFpsCb, this.#showFps$))
        this.#showFps$.pipe(skip(1)).subscribe(() => {
            persist()
            this.dispatchEvent(new CustomEvent("galacticad-show-fps-change", { bubbles: true, composed: true }))
        })

        const meshCb = this.#addCheckbox(exportBox, "Export preview", this.#meshViewer$.value)
        this.#subscriptions.push(connectCheckbox(meshCb, this.#meshViewer$))
        this.#meshViewer$.pipe(skip(1)).subscribe(() => {
            persist()
            this.dispatchEvent(new CustomEvent("galacticad-mesh-viewer-change", { bubbles: true, composed: true }))
        })

        const meshSimpCb = this.#addCheckbox(exportBox, "Mesh simplify", this.#meshSimplify$.value)
        this.#subscriptions.push(connectCheckbox(meshSimpCb, this.#meshSimplify$))
        this.#meshSimplify$.pipe(skip(1)).subscribe(() => {
            persist()
            this.dispatchEvent(new CustomEvent("galacticad-mesh-simplify-change", { bubbles: true, composed: true }))
        })

    }

    getDevToolsState(): Record<string, JSONValue> {
        return {
            showFps: this.#showFps$.value,
            meshViewerEnabled: this.#meshViewer$.value,
            meshSimplifyOnExport: this.#meshSimplify$.value,
        }
    }

    setDevToolsState(state: Record<string, JSONValue>): void {
        this.#applying = true
        try {
            const d = DEFAULT_APP_DEVTOOLS_STATE
            this.#showFps$.next(asBool(state.showFps, asBool(d.showFps, true)))
            this.#meshViewer$.next(asBool(state.meshViewerEnabled, asBool(d.meshViewerEnabled, false)))
            this.#meshSimplify$.next(asBool(state.meshSimplifyOnExport, asBool(d.meshSimplifyOnExport, false)))
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
