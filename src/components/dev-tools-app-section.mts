import { BehaviorSubject, skip } from "rxjs"
import type { Subscription } from "rxjs"
import { connectCheckbox } from "../binding/bind.mjs"
import { SettingsManager, type GlobalSettings } from "../storage/settings.mjs"
import { DEFAULT_RAY_MARCH_PARAMS, type RayMarchParams } from "../render-worker-protocol.mjs"
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

export const MESH_VIEWER_OVERLAY_CHANGE_EVENT = "galacticad-mesh-viewer-overlay-change" as const

export class DevToolsAppSection extends HTMLElement implements DevToolsPersistable {
    readonly devToolsSectionId = DEVTOOLS_SECTION_APP
    #applying = false
    #showFps$: BehaviorSubject<boolean>
    #meshViewer$: BehaviorSubject<boolean>
    #meshSimplify$: BehaviorSubject<boolean>
    #translucentFaces$: BehaviorSubject<boolean>
    #wireframe$: BehaviorSubject<boolean>
    #mdcDebugPoints$: BehaviorSubject<boolean>
    #fgLine$: BehaviorSubject<boolean>
    #fgCorner$: BehaviorSubject<boolean>
    #fgSeam$: BehaviorSubject<boolean>
    #fgRing$: BehaviorSubject<boolean>
    #mdcCellVertices$: BehaviorSubject<boolean>
    #mdcQefPlanes$: BehaviorSubject<boolean>
    #cameraOptimization$: BehaviorSubject<boolean>
    #beamOptimization$: BehaviorSubject<boolean>
    #bvhOptimization$: BehaviorSubject<boolean>
    #fgOverlay$: BehaviorSubject<boolean>
    #rayMarchState: RayMarchParams = { ...DEFAULT_RAY_MARCH_PARAMS }
    #subscriptions: Subscription[] = []

    onCameraOptimizationChange?: (enabled: boolean) => void
    onBeamOptimizationChange?: (enabled: boolean) => void
    onBvhOptimizationChange?: (enabled: boolean) => void
    onFeatureGraphOverlayChange?: (enabled: boolean) => void
    onRayMarchParamsChange?: (params: RayMarchParams) => void

    get showFps(): boolean {
        return this.#showFps$.value
    }

    set showFps(v: boolean) {
        this.#showFps$.next(v)
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

    get featureGraphOverlay(): boolean {
        return this.#fgOverlay$.value
    }

    set featureGraphOverlay(enabled: boolean) {
        this.#fgOverlay$.next(enabled)
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

        const mv = SettingsManager.instance.getGlobal().meshViewer
        this.#translucentFaces$ = new BehaviorSubject(!!mv.translucentFaces)
        this.#wireframe$ = new BehaviorSubject(!!mv.wireframe)
        this.#mdcDebugPoints$ = new BehaviorSubject(!!mv.mdcDebugPoints)
        this.#fgLine$ = new BehaviorSubject(!!mv.featureGlyphs?.line)
        this.#fgCorner$ = new BehaviorSubject(!!mv.featureGlyphs?.corner)
        this.#fgSeam$ = new BehaviorSubject(!!mv.featureGlyphs?.seam)
        this.#fgRing$ = new BehaviorSubject(!!mv.featureGlyphs?.ring)
        this.#mdcCellVertices$ = new BehaviorSubject(!!mv.mdcCellVertices)
        this.#mdcQefPlanes$ = new BehaviorSubject(!!mv.mdcQefPlanes)

        this.#cameraOptimization$ = new BehaviorSubject(true)
        this.#beamOptimization$ = new BehaviorSubject(false)
        this.#bvhOptimization$ = new BehaviorSubject(true)
        this.#fgOverlay$ = new BehaviorSubject(true)

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

        // --- Viewport: Show FPS, FeatureGraph overlay, Performance ---
        const showFpsCb = this.#addCheckbox(viewportBox, "Show FPS", this.#showFps$.value)
        this.#subscriptions.push(connectCheckbox(showFpsCb, this.#showFps$))
        this.#showFps$.pipe(skip(1)).subscribe(() => {
            persist()
            this.dispatchEvent(new CustomEvent("galacticad-show-fps-change", { bubbles: true, composed: true }))
        })

        const fgOverlayCb = this.#addCheckbox(viewportBox, "FeatureGraph overlay", this.#fgOverlay$.value)
        this.#subscriptions.push(connectCheckbox(fgOverlayCb, this.#fgOverlay$))
        this.#subscriptions.push(
            this.#fgOverlay$.pipe(skip(1)).subscribe(v => this.onFeatureGraphOverlayChange?.(v)),
        )

        const perfBox = document.createElement("dev-tools-collapse")
        perfBox.setAttribute("label", "Performance")
        perfBox.setAttribute("nested", "")
        perfBox.setAttribute("collapse-id", DEVTOOLS_COLLAPSE.rendererPerformance)
        viewportBox.appendChild(perfBox)

        const cameraOptCb = this.#addCheckbox(perfBox, "Camera halfres", this.#cameraOptimization$.value)
        this.#subscriptions.push(connectCheckbox(cameraOptCb, this.#cameraOptimization$))
        this.#subscriptions.push(
            this.#cameraOptimization$.pipe(skip(1)).subscribe(v => this.onCameraOptimizationChange?.(v)),
        )

        const beamOptCb = this.#addCheckbox(perfBox, "Beam render", this.#beamOptimization$.value)
        this.#subscriptions.push(connectCheckbox(beamOptCb, this.#beamOptimization$))
        this.#subscriptions.push(
            this.#beamOptimization$.pipe(skip(1)).subscribe(v => this.onBeamOptimizationChange?.(v)),
        )

        const bvhOptCb = this.#addCheckbox(perfBox, "BVH optimize", this.#bvhOptimization$.value)
        this.#subscriptions.push(connectCheckbox(bvhOptCb, this.#bvhOptimization$))
        this.#subscriptions.push(
            this.#bvhOptimization$.pipe(skip(1)).subscribe(v => this.onBvhOptimizationChange?.(v)),
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

        // --- Export: preview + simplify, then mesh-viewer overlay debug toggles ---
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

        const translucentCb = this.#addCheckbox(exportBox, "Translucent faces", this.#translucentFaces$.value)
        this.#subscriptions.push(connectCheckbox(translucentCb, this.#translucentFaces$))
        const wireframeCb = this.#addCheckbox(exportBox, "Wireframe", this.#wireframe$.value)
        this.#subscriptions.push(connectCheckbox(wireframeCb, this.#wireframe$))
        const debugPointsCb = this.#addCheckbox(exportBox, "Debug points", this.#mdcDebugPoints$.value)
        this.#subscriptions.push(connectCheckbox(debugPointsCb, this.#mdcDebugPoints$))

        const fgGroup = this.#addNestedGroup(exportBox, "Feature glyphs")
        const fgLineCb = this.#addCheckbox(fgGroup, "Line", this.#fgLine$.value)
        this.#subscriptions.push(connectCheckbox(fgLineCb, this.#fgLine$))
        const fgCornerCb = this.#addCheckbox(fgGroup, "Corner", this.#fgCorner$.value)
        this.#subscriptions.push(connectCheckbox(fgCornerCb, this.#fgCorner$))
        const fgSeamCb = this.#addCheckbox(fgGroup, "Seam", this.#fgSeam$.value)
        this.#subscriptions.push(connectCheckbox(fgSeamCb, this.#fgSeam$))
        const fgRingCb = this.#addCheckbox(fgGroup, "Ring", this.#fgRing$.value)
        this.#subscriptions.push(connectCheckbox(fgRingCb, this.#fgRing$))

        const qefGroup = this.#addNestedGroup(exportBox, "QEF debug")
        const cellVertsCb = this.#addCheckbox(qefGroup, "Cell vertices", this.#mdcCellVertices$.value)
        this.#subscriptions.push(connectCheckbox(cellVertsCb, this.#mdcCellVertices$))
        const qefPlanesCb = this.#addCheckbox(qefGroup, "QEF planes", this.#mdcQefPlanes$.value)
        this.#subscriptions.push(connectCheckbox(qefPlanesCb, this.#mdcQefPlanes$))

        const broadcastMeshViewerOverlay = () => {
            if (this.#applying) return
            const s = this.#currentMeshViewerSettings()
            SettingsManager.instance.updateGlobal({ meshViewer: s })
            this.dispatchEvent(
                new CustomEvent<GlobalSettings["meshViewer"]>(MESH_VIEWER_OVERLAY_CHANGE_EVENT, {
                    bubbles: true,
                    composed: true,
                    detail: s,
                }),
            )
        }
        for (const src$ of [
            this.#translucentFaces$,
            this.#wireframe$,
            this.#mdcDebugPoints$,
            this.#fgLine$,
            this.#fgCorner$,
            this.#fgSeam$,
            this.#fgRing$,
            this.#mdcCellVertices$,
            this.#mdcQefPlanes$,
        ]) {
            this.#subscriptions.push(src$.pipe(skip(1)).subscribe(broadcastMeshViewerOverlay))
        }
    }

    /** Current mesh viewer overlay/render settings as reflected by the Viewport checkboxes. */
    currentMeshViewerSettings(): GlobalSettings["meshViewer"] {
        return this.#currentMeshViewerSettings()
    }

    #currentMeshViewerSettings(): GlobalSettings["meshViewer"] {
        return {
            translucentFaces: this.#translucentFaces$.value,
            wireframe: this.#wireframe$.value,
            mdcDebugPoints: this.#mdcDebugPoints$.value,
            featureGlyphs: {
                line: this.#fgLine$.value,
                corner: this.#fgCorner$.value,
                seam: this.#fgSeam$.value,
                ring: this.#fgRing$.value,
            },
            mdcCellVertices: this.#mdcCellVertices$.value,
            mdcQefPlanes: this.#mdcQefPlanes$.value,
        }
    }

    #addNestedGroup(parent: ParentNode, label: string): HTMLDivElement {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-direction:column;gap:2px;margin:2px 0 2px 12px"
        const title = document.createElement("div")
        title.textContent = label
        title.style.cssText = "font-size:11px;opacity:0.78"
        wrap.append(title)
        parent.appendChild(wrap)
        return wrap
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
