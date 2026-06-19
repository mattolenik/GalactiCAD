import { BehaviorSubject, skip } from "rxjs"
import type { Subscription } from "rxjs"
import { connectCheckbox } from "../binding/bind.mjs"
import { SettingsManager, type GlobalSettings } from "../storage/settings.mjs"
import {
    DEFAULT_RAY_MARCH_PARAMS,
    DEFAULT_UPSCALE_PARAMS,
    type FeatureGraphOcclusionMode,
    type RayMarchParams,
    type UpscaleMode,
    type UpscaleParams,
} from "../render-worker-protocol.mjs"
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
/** Fired when the shared "render normals" lighting mode is toggled from the dev-tools panel. */
export const RENDER_NORMALS_CHANGE_EVENT = "galacticad-render-normals-change" as const

export class DevToolsAppSection extends HTMLElement implements DevToolsPersistable {
    readonly devToolsSectionId = DEVTOOLS_SECTION_APP
    #applying = false
    #showFps$: BehaviorSubject<boolean>
    #meshViewer$: BehaviorSubject<boolean>
    #meshSimplify$: BehaviorSubject<boolean>
    #translucentFaces$: BehaviorSubject<boolean>
    #wireframe$: BehaviorSubject<boolean>
    /**
     * Shared "render normals" lighting mode. Mirrors `preview.previewNormalShading`
     * (the single source of truth, also driven by the toolbar normal icon) rather
     * than living in the mesh-viewer overlay settings group — so it stays in sync
     * with the SDF preview.
     */
    #renderNormals$: BehaviorSubject<boolean>
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
    #fgOcclusion$: BehaviorSubject<FeatureGraphOcclusionMode>
    #fgOcclusionSelect?: HTMLSelectElement
    #fgLineWidth$: BehaviorSubject<number>
    #fgLineWidthInput?: HTMLInputElement
    #fgDifferentiate$: BehaviorSubject<boolean>
    #stepHeatmap$: BehaviorSubject<boolean>
    #deferredShading$: BehaviorSubject<boolean>
    #rayMarchState: RayMarchParams = { ...DEFAULT_RAY_MARCH_PARAMS }
    #rayMarchInputs = new Map<keyof RayMarchParams, HTMLInputElement>()
    #upscaleState: UpscaleParams = { ...DEFAULT_UPSCALE_PARAMS }
    #upscaleScaleSelect?: HTMLSelectElement
    #upscaleModeSelect?: HTMLSelectElement
    #subscriptions: Subscription[] = []

    onCameraOptimizationChange?: (enabled: boolean) => void
    onBeamOptimizationChange?: (enabled: boolean) => void
    onBvhOptimizationChange?: (enabled: boolean) => void
    onFeatureGraphOverlayChange?: (enabled: boolean) => void
    onFeatureGraphOcclusionChange?: (mode: FeatureGraphOcclusionMode) => void
    onFeatureGraphLineWidthChange?: (px: number) => void
    onFeatureGraphDifferentiateSegmentsChange?: (on: boolean) => void
    onStepHeatmapChange?: (enabled: boolean) => void
    onDeferredShadingChange?: (enabled: boolean) => void
    onRayMarchParamsChange?: (params: RayMarchParams) => void
    onUpscaleParamsChange?: (params: UpscaleParams) => void

    get renderNormals(): boolean {
        return this.#renderNormals$.value
    }

    /** Sync the checkbox from the shared mode (toolbar / settings load) without re-dispatching. */
    set renderNormals(enabled: boolean) {
        this.#applying = true
        try {
            this.#renderNormals$.next(!!enabled)
        } finally {
            this.#applying = false
        }
    }

    get showFps(): boolean {
        return this.#showFps$.value
    }

    set showFps(v: boolean) {
        this.#showFps$.next(v)
    }

    get rayMarchParams(): RayMarchParams {
        return { ...this.#rayMarchState }
    }

    get upscaleParams(): UpscaleParams {
        return { ...this.#upscaleState }
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

    get featureGraphOcclusion(): FeatureGraphOcclusionMode {
        return this.#fgOcclusion$.value
    }

    /** Sync the select from the renderer/settings without re-dispatching. */
    set featureGraphOcclusion(mode: FeatureGraphOcclusionMode) {
        this.#applying = true
        try {
            this.#fgOcclusion$.next(mode)
            if (this.#fgOcclusionSelect) this.#fgOcclusionSelect.value = mode
        } finally {
            this.#applying = false
        }
    }

    get featureGraphLineWidth(): number {
        return this.#fgLineWidth$.value
    }

    /** Sync the input from the renderer/settings without re-dispatching. */
    set featureGraphLineWidth(px: number) {
        this.#applying = true
        try {
            this.#fgLineWidth$.next(px)
            if (this.#fgLineWidthInput) this.#fgLineWidthInput.value = String(px)
        } finally {
            this.#applying = false
        }
    }

    get featureGraphDifferentiateSegments(): boolean {
        return this.#fgDifferentiate$.value
    }

    /** Sync the checkbox from the renderer/settings without re-dispatching. */
    set featureGraphDifferentiateSegments(on: boolean) {
        this.#applying = true
        try {
            this.#fgDifferentiate$.next(on)
        } finally {
            this.#applying = false
        }
    }

    get stepHeatmap(): boolean {
        return this.#stepHeatmap$.value
    }

    set stepHeatmap(enabled: boolean) {
        this.#stepHeatmap$.next(enabled)
    }

    get deferredShading(): boolean {
        return this.#deferredShading$.value
    }

    set deferredShading(enabled: boolean) {
        this.#deferredShading$.next(enabled)
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
        this.#renderNormals$ = new BehaviorSubject(
            !!SettingsManager.instance.getPreview().previewNormalShading,
        )
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
        this.#fgOcclusion$ = new BehaviorSubject<FeatureGraphOcclusionMode>("off")
        this.#fgLineWidth$ = new BehaviorSubject(2)
        this.#fgDifferentiate$ = new BehaviorSubject(false)
        // Debug-only; not persisted across sessions. Defaults off so the user
        // gets normal shading on startup.
        this.#stepHeatmap$ = new BehaviorSubject(false)
        // Deferred selection shading: off by default (single-pass fragmentMain).
        // When on, selection/hover repaints skip the SDF march — big win on deep
        // scenes; ~+200MB G-buffer VRAM and a tiny extra pass on full frames.
        this.#deferredShading$ = new BehaviorSubject(false)

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

        // Depth-sort the overlay against the SDF surface: off (draw on top),
        // hide-behind (hard occlude), or dim-behind (fade occluded edges).
        this.#fgOcclusionSelect = this.#addSelect(
            viewportBox,
            "Overlay occlusion",
            [
                { value: "off", label: "Off (on top)" },
                { value: "hard", label: "Hide behind" },
                { value: "dim", label: "Dim behind" },
            ],
            this.#fgOcclusion$.value,
        )
        this.#fgOcclusionSelect.addEventListener("change", () => {
            this.#fgOcclusion$.next(this.#fgOcclusionSelect!.value as FeatureGraphOcclusionMode)
        })
        this.#subscriptions.push(
            this.#fgOcclusion$.pipe(skip(1)).subscribe(v => {
                if (!this.#applying) this.onFeatureGraphOcclusionChange?.(v)
            }),
        )

        // Overlay edge line width (framebuffer px). Sibling of the two controls
        // above, in the same viewport box.
        {
            const row = document.createElement("div")
            row.className = "shade-row"
            const lab = document.createElement("label")
            lab.className = "knob-label"
            lab.textContent = "Overlay line width"
            const input = document.createElement("input")
            input.type = "number"
            input.min = "0.5"
            input.max = "8"
            input.step = "0.5"
            input.value = String(this.#fgLineWidth$.value)
            input.style.cssText = "width:60px;font-size:11px;"
            input.addEventListener("change", () => {
                const v = parseFloat(input.value)
                if (!Number.isFinite(v)) return
                this.#fgLineWidth$.next(v)
            })
            this.#fgLineWidthInput = input
            row.append(lab, input)
            viewportBox.appendChild(row)
            this.#subscriptions.push(
                this.#fgLineWidth$.pipe(skip(1)).subscribe(v => {
                    if (!this.#applying) this.onFeatureGraphLineWidthChange?.(v)
                }),
            )
        }

        // Color original (emitted) creases green vs subdivided cyan. Off by
        // default ⇒ all overlay edges are cyan.
        const fgDiffCb = this.#addCheckbox(viewportBox, "Differentiate segments", this.#fgDifferentiate$.value)
        this.#subscriptions.push(connectCheckbox(fgDiffCb, this.#fgDifferentiate$))
        this.#subscriptions.push(
            this.#fgDifferentiate$.pipe(skip(1)).subscribe(v => {
                if (!this.#applying) this.onFeatureGraphDifferentiateSegmentsChange?.(v)
            }),
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

        // --- FSR1 spatial upscale (applies to the reduced-res motion frames
        // gated by "Camera halfres"; a still camera always renders full-res). ---
        const emitUpscale = () => {
            this.onUpscaleParamsChange?.({ ...this.#upscaleState })
            persist()
        }
        this.#upscaleScaleSelect = this.#addSelect(
            perfBox,
            "Render scale",
            [
                { value: "0.5", label: "50%" },
                { value: "0.67", label: "67%" },
                { value: "0.75", label: "75%" },
                { value: "1", label: "100%" },
            ],
            String(this.#upscaleState.renderScale),
        )
        this.#upscaleScaleSelect.addEventListener("change", () => {
            const v = parseFloat(this.#upscaleScaleSelect!.value)
            if (Number.isFinite(v)) this.#upscaleState.renderScale = v
            emitUpscale()
        })
        this.#upscaleModeSelect = this.#addSelect(
            perfBox,
            "Upscaler",
            [
                { value: "off", label: "Bilinear" },
                { value: "easu", label: "EASU" },
                { value: "easu-fxaa", label: "EASU+FXAA" },
            ],
            this.#upscaleState.mode,
        )
        this.#upscaleModeSelect.addEventListener("change", () => {
            this.#upscaleState.mode = this.#upscaleModeSelect!.value as UpscaleMode
            emitUpscale()
        })

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

        const stepHeatmapCb = this.#addCheckbox(perfBox, "Step heatmap", this.#stepHeatmap$.value)
        this.#subscriptions.push(connectCheckbox(stepHeatmapCb, this.#stepHeatmap$))
        this.#subscriptions.push(
            this.#stepHeatmap$.pipe(skip(1)).subscribe(v => this.onStepHeatmapChange?.(v)),
        )

        const deferredShadingCb = this.#addCheckbox(perfBox, "Deferred selection shading", this.#deferredShading$.value)
        this.#subscriptions.push(connectCheckbox(deferredShadingCb, this.#deferredShading$))
        this.#subscriptions.push(
            this.#deferredShading$.pipe(skip(1)).subscribe(v => this.onDeferredShadingChange?.(v)),
        )

        const rayMarchKnobs: { key: keyof RayMarchParams; label: string; min: number; max: number; step: number }[] = [
            { key: "maxSteps", label: "Max steps", min: 50, max: 2000, step: 50 },
            // *Moving variants — substituted for their stationary
            // counterparts during active camera motion. Lower bounds + finer
            // steps since the motion budget is tighter and the visual
            // tolerance is higher (halfres / motion blur masks artefacts).
            { key: "maxStepsMoving", label: "Max steps (moving)", min: 20, max: 2000, step: 20 },
            { key: "maxDist", label: "Max dist", min: 50, max: 2000, step: 50 },
            { key: "maxBeamSteps", label: "Beam steps", min: 20, max: 1000, step: 20 },
            { key: "maxBeamStepsMoving", label: "Beam steps (moving)", min: 10, max: 1000, step: 10 },
            { key: "hitRefineSteps", label: "Hit refine", min: 1, max: 64, step: 1 },
            { key: "hitRefineStepsMoving", label: "Hit refine (moving)", min: 0, max: 64, step: 1 },
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
                persist()
            })
            this.#rayMarchInputs.set(k.key, input)
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

        // Shared lighting mode: regular lighting (default) vs render normals. Kept
        // in sync with the SDF preview / toolbar normal icon via the app, so this
        // checkbox dispatches its own event rather than joining the mesh-viewer
        // overlay broadcast below.
        const renderNormalsCb = this.#addCheckbox(exportBox, "Render normals", this.#renderNormals$.value)
        this.#subscriptions.push(connectCheckbox(renderNormalsCb, this.#renderNormals$))
        this.#subscriptions.push(
            this.#renderNormals$.pipe(skip(1)).subscribe(() => {
                if (this.#applying) return
                this.dispatchEvent(
                    new CustomEvent<boolean>(RENDER_NORMALS_CHANGE_EVENT, {
                        bubbles: true,
                        composed: true,
                        detail: this.#renderNormals$.value,
                    }),
                )
            }),
        )

        const translucentCb = this.#addCheckbox(exportBox, "Translucent faces", this.#translucentFaces$.value)
        this.#subscriptions.push(connectCheckbox(translucentCb, this.#translucentFaces$))
        const wireframeCb = this.#addCheckbox(exportBox, "Wireframe overlay", this.#wireframe$.value)
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
            rayMarchParams: { ...this.#rayMarchState },
            upscaleParams: { ...this.#upscaleState },
        }
    }

    setDevToolsState(state: Record<string, JSONValue>): void {
        this.#applying = true
        try {
            const d = DEFAULT_APP_DEVTOOLS_STATE
            this.#showFps$.next(asBool(state.showFps, asBool(d.showFps, true)))
            this.#meshViewer$.next(asBool(state.meshViewerEnabled, asBool(d.meshViewerEnabled, false)))
            this.#meshSimplify$.next(asBool(state.meshSimplifyOnExport, asBool(d.meshSimplifyOnExport, false)))
            this.#restoreRayMarchParams(state.rayMarchParams)
            this.#restoreUpscaleParams(state.upscaleParams)
        } finally {
            this.#applying = false
        }
    }

    /**
     * Merge a persisted `rayMarchParams` snapshot into `#rayMarchState`, clamping
     * each field to a finite number and falling back to the default when missing
     * or invalid. Updates the visible inputs but does not fire
     * `onRayMarchParamsChange` — the caller (app.mts) reads `rayMarchParams` after
     * wiring and pushes it to the renderer once.
     */
    #restoreRayMarchParams(raw: JSONValue | undefined): void {
        const incoming = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, JSONValue>) : {}
        const next: RayMarchParams = { ...DEFAULT_RAY_MARCH_PARAMS }
        for (const key of Object.keys(next) as (keyof RayMarchParams)[]) {
            const v = incoming[key]
            if (typeof v === "number" && Number.isFinite(v)) next[key] = v
        }
        this.#rayMarchState = next
        for (const [key, input] of this.#rayMarchInputs) {
            input.value = String(next[key])
        }
    }

    /**
     * Merge a persisted `upscaleParams` snapshot into `#upscaleState`, clamping
     * to valid values and falling back to defaults. Updates the visible controls
     * but does not fire `onUpscaleParamsChange` — app.mts reads `upscaleParams`
     * after wiring and pushes it to the renderer once.
     */
    #restoreUpscaleParams(raw: JSONValue | undefined): void {
        const incoming = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, JSONValue>) : {}
        const next: UpscaleParams = { ...DEFAULT_UPSCALE_PARAMS }
        if (typeof incoming.renderScale === "number" && Number.isFinite(incoming.renderScale)) next.renderScale = incoming.renderScale
        if (incoming.mode === "off" || incoming.mode === "easu" || incoming.mode === "easu-fxaa") next.mode = incoming.mode
        this.#upscaleState = next
        if (this.#upscaleScaleSelect) this.#upscaleScaleSelect.value = String(next.renderScale)
        if (this.#upscaleModeSelect) this.#upscaleModeSelect.value = next.mode
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

    #addSelect(
        parent: ParentNode,
        label: string,
        options: { value: string; label: string }[],
        value: string,
    ): HTMLSelectElement {
        const row = document.createElement("div")
        row.className = "shade-row"
        const lab = document.createElement("label")
        lab.className = "knob-label"
        lab.textContent = label
        const sel = document.createElement("select")
        sel.style.cssText = "width:84px;font-size:11px;"
        for (const o of options) {
            const opt = document.createElement("option")
            opt.value = o.value
            opt.textContent = o.label
            sel.appendChild(opt)
        }
        sel.value = value
        row.append(lab, sel)
        parent.appendChild(row)
        return sel
    }

}

customElements.define("dev-tools-app-section", DevToolsAppSection)

declare global {
    interface HTMLElementTagNameMap {
        "dev-tools-app-section": DevToolsAppSection
    }
}
