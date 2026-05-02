import { Subject } from "rxjs"
import { debounceTime } from "rxjs/operators"
import type { DebugLogModulesState } from "../logging/debug-log.mjs"
import { log, mergeDebugLogModulesFromStorage } from "../logging/debug-log.mjs"
import {
    DEFAULT_MESH_EXPORT_VOXEL_SIZE_MM,
    DEFAULT_MDC_EXPORT_LEVERS,
    DEFAULT_SHREC_TUNING,
    DEFAULT_SIMPLIFY_TUNING,
    type MdcExportLevers,
    type ShrecTuning,
    type SimplifyTuning,
} from "../render-worker-protocol.mjs"
import { db } from "./db.mjs"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CameraSettings {
    position: [number, number, number]
    translation: [number, number, number]
    zoom: number
    rotation: [number, number, number, number] // quaternion [w, x, y, z]
}

export interface PreviewSettings {
    xrayMode: boolean
    cameraOptimization: boolean
    beamOptimization: boolean
    bvhOptimization: boolean
}

export interface LayoutSettings {
    editorHeightPercent: number
    editorWidthPercent: number
}

export interface EditorSelection {
    startLine: number
    startColumn: number
    endLine: number
    endColumn: number
}

export interface DocumentSettings {
    camera: CameraSettings
    preview: PreviewSettings
    cursorPosition: { line: number; column: number }
    selection: EditorSelection
}

export type SelectionMode = "object" | "seam" | "edge" | "face" | "auto"

export type CameraRotationMethod = "rounded_arcball" | "azel"

export type ThemeMode = "light" | "dark" | "auto"

export type LineNumbersMode = "on" | "off" | "relative"
export type RenderWhitespaceMode = "none" | "boundary" | "selection" | "all"

export interface EditorSettings {
    lineNumbers: LineNumbersMode
    wordWrap: "on" | "off"
    minimap: boolean
    fontSize: number
    renderWhitespace: RenderWhitespaceMode
    folding: boolean
    tabSize: number
}

export interface GlobalSettings {
    preview: { movementScale: number; selectionMode: SelectionMode; cameraRotationMethod: CameraRotationMethod }
    meshViewer: { translucentFaces: boolean; wireframe: boolean }
    app: {
        meshViewerEnabled: boolean
        devToolsEnabled: boolean
        /** When true, dev tools shows the preview lighting sliders. */
        devToolsLightingExpanded: boolean
        /** When true, dev tools shows MDC mesh export levers. */
        devToolsMdcExportExpanded: boolean
        showFps: boolean
        meshSimplifyOnExport: boolean
        /** Voxel edge length (mm) for the mesh-export grid; applies to both MDC and SHREC. */
        meshExportVoxelSizeMm: number
        /** When true, mesh export uses the SHREC/MergeSharp pipeline; otherwise MDC. */
        useShrecExporter: boolean
        /** Tuning knobs for the SHREC/MergeSharp pipeline. */
        shrecTuning: ShrecTuning
        /** Post-export mesh simplification (meshoptimizer); used when mesh simplify on export is enabled. */
        simplifyTuning: SimplifyTuning
        /** Mesh export (MDC) tuning; merged with defaults and clamped on load. */
        mdcExportLevers: MdcExportLevers
        diskSyncIntervalSeconds: number
        theme: ThemeMode
        editor: EditorSettings
        /** Per-module debug logging; Dev Tools checkboxes. */
        debugLogModules: DebugLogModulesState
    }
    layout: LayoutSettings
}

/** Partial global update; `app.mdcExportLevers` may be a partial merge. */
export type AppSettingsPatch = Omit<Partial<GlobalSettings["app"]>, "mdcExportLevers"> & {
    mdcExportLevers?: Partial<MdcExportLevers>
}

export type GlobalSettingsPatch = {
    preview?: Partial<GlobalSettings["preview"]>
    meshViewer?: Partial<GlobalSettings["meshViewer"]>
    app?: AppSettingsPatch
    layout?: Partial<GlobalSettings["layout"]>
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function defaultCamera(): CameraSettings {
    return { position: [0, 0, 0], translation: [0, 0, 0], zoom: 20, rotation: [1, 0, 0, 0] }
}

function defaultPreview(): PreviewSettings {
    return { xrayMode: false, cameraOptimization: true, beamOptimization: true, bvhOptimization: true }
}

function defaultLayout(): LayoutSettings {
    return { editorHeightPercent: 22, editorWidthPercent: 35 }
}

function defaultCursorPosition(): { line: number; column: number } {
    return { line: 1, column: 1 }
}

function defaultSelection(): EditorSelection {
    return { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }
}

function defaultEditorSettings(): EditorSettings {
    return {
        lineNumbers: "on",
        wordWrap: "on",
        minimap: false,
        fontSize: 16,
        renderWhitespace: "none",
        folding: true,
        tabSize: 2,
    }
}

function defaultDocSettings(): DocumentSettings {
    return { camera: defaultCamera(), preview: defaultPreview(), cursorPosition: defaultCursorPosition(), selection: defaultSelection() }
}

function clampMdcNumber(v: unknown, lo: number, hi: number, fallback: number): number {
    if (typeof v !== "number" || !Number.isFinite(v)) return fallback
    return Math.min(hi, Math.max(lo, v))
}

/** Normalize persisted MDC export levers (Dev Tools / mesh pipeline). */
export function normalizeMdcExportLevers(raw: unknown): MdcExportLevers {
    const d = DEFAULT_MDC_EXPORT_LEVERS
    const o = raw && typeof raw === "object" ? (raw as Partial<MdcExportLevers>) : {}
    return {
        voxelSizeMm: clampMdcNumber(o.voxelSizeMm, 0.02, 1.0, d.voxelSizeMm),
        isoValue: clampMdcNumber(o.isoValue, -0.5, 0.5, d.isoValue),
        creaseAngleDeg: clampMdcNumber(o.creaseAngleDeg, -1, 180, d.creaseAngleDeg),
        featureConstrainedPlacement: typeof o.featureConstrainedPlacement === "boolean"
            ? o.featureConstrainedPlacement
            : typeof (o as { hermiteEdgeRefine?: unknown }).hermiteEdgeRefine === "boolean"
            ? (o as { hermiteEdgeRefine: boolean }).hermiteEdgeRefine
            : d.featureConstrainedPlacement,
        simplifyTargetRatio: clampMdcNumber(o.simplifyTargetRatio, 0.01, 1, d.simplifyTargetRatio),
        simplifyTargetError: clampMdcNumber(o.simplifyTargetError, 0, 0.1, d.simplifyTargetError),
        simplifyNormalWeight: clampMdcNumber(o.simplifyNormalWeight, 0, 8, d.simplifyNormalWeight),
        simplifyRegularize: typeof o.simplifyRegularize === "boolean" ? o.simplifyRegularize : d.simplifyRegularize,
    }
}

function defaultGlobalSettings(): GlobalSettings {
    return {
        preview: { movementScale: 0.5, selectionMode: "object", cameraRotationMethod: "rounded_arcball" },
        meshViewer: { translucentFaces: false, wireframe: false },
        app: {
            meshViewerEnabled: false,
            devToolsEnabled: false,
            devToolsLightingExpanded: false,
            devToolsMdcExportExpanded: false,
            showFps: true,
            meshSimplifyOnExport: true,
            meshExportVoxelSizeMm: DEFAULT_MESH_EXPORT_VOXEL_SIZE_MM,
            useShrecExporter: false,
            shrecTuning: { ...DEFAULT_SHREC_TUNING },
            simplifyTuning: { ...DEFAULT_SIMPLIFY_TUNING },
            mdcExportLevers: { ...DEFAULT_MDC_EXPORT_LEVERS },
            diskSyncIntervalSeconds: 30,
            theme: "dark",
            editor: defaultEditorSettings(),
            debugLogModules: {},
        },
        layout: defaultLayout(),
    }
}

// ---------------------------------------------------------------------------
// SettingsManager
// ---------------------------------------------------------------------------

export class SettingsManager {
    static instance: SettingsManager = new SettingsManager()

    // In-memory state
    #currentDocName: string | null = null
    #docSettings: DocumentSettings = defaultDocSettings()
    #globalSettings: GlobalSettings = defaultGlobalSettings()

    // RxJS subjects for debounced persistence
    #cameraSave$ = new Subject<void>()
    #docSave$ = new Subject<void>()
    #cursorSave$ = new Subject<void>()
    #globalSave$ = new Subject<void>()

    #initPromise: Promise<void>

    constructor() {
        this.#initPromise = this.#loadGlobal()

        // Camera saves debounce at 300ms -- only persists after movement stops
        this.#cameraSave$.pipe(debounceTime(300)).subscribe(() => void this.#flushDoc())

        // Other per-doc settings debounce at 100ms
        this.#docSave$.pipe(debounceTime(100)).subscribe(() => void this.#flushDoc())

        // Cursor position debounce at 500ms
        this.#cursorSave$.pipe(debounceTime(500)).subscribe(() => void this.#flushDoc())

        // Global settings debounce at 100ms
        this.#globalSave$.pipe(debounceTime(100)).subscribe(() => void this.#flushGlobal())
    }

    /** Resolves when settings are loaded from storage. Call before restore. */
    async ready(): Promise<void> {
        await this.#initPromise
    }

    // -----------------------------------------------------------------------
    // Document lifecycle
    // -----------------------------------------------------------------------

    /** Switch to a different document. Flushes current doc immediately, loads the new one. */
    async switchDocument(name: string | null): Promise<void> {
        await this.#flushDoc()
        this.#currentDocName = name
        if (name) {
            await this.#loadDoc(name)
        } else {
            this.#docSettings = defaultDocSettings()
        }
    }

    /** Delete a document's settings from storage. */
    async deleteDocument(name: string): Promise<void> {
        await db.docSettings.delete(name)
    }

    /** Load document settings for a given document name (without switching). Used for benchmark suite. */
    async getDocumentSettings(name: string): Promise<DocumentSettings> {
        const row = await db.docSettings.get(name)
        const def = defaultDocSettings()
        if (row?.settings && typeof row.settings === "object") {
            const parsed = row.settings as Partial<DocumentSettings>
            const cursor = { ...def.cursorPosition, ...parsed.cursorPosition }
            let selection = { ...def.selection, ...parsed.selection }
            if (!parsed.selection && parsed.cursorPosition) {
                selection = { startLine: cursor.line, startColumn: cursor.column, endLine: cursor.line, endColumn: cursor.column }
            }
            return {
                camera: { ...def.camera, ...parsed.camera },
                preview: { ...def.preview, ...parsed.preview },
                cursorPosition: cursor,
                selection,
            }
        }
        return def
    }

    /** Rename a document's settings entry. */
    async renameDocument(oldName: string, newName: string): Promise<void> {
        const row = await db.docSettings.get(oldName)
        if (row) {
            await db.docSettings.put({ name: newName, settings: row.settings })
            await db.docSettings.delete(oldName)
        }
        if (this.#currentDocName === oldName) {
            this.#currentDocName = newName
        }
    }

    get currentDocumentName(): string | null {
        return this.#currentDocName
    }

    // -----------------------------------------------------------------------
    // Camera settings (per-document)
    // -----------------------------------------------------------------------

    getCamera(): CameraSettings {
        return this.#docSettings.camera
    }

    setCamera(cam: CameraSettings): void {
        this.#docSettings.camera = cam
        this.#cameraSave$.next()
    }

    // -----------------------------------------------------------------------
    // Preview settings (per-document)
    // -----------------------------------------------------------------------

    getPreview(): PreviewSettings {
        return this.#docSettings.preview
    }

    setPreview(preview: PreviewSettings): void {
        this.#docSettings.preview = preview
        this.#docSave$.next()
    }

    /** Update a single preview field. */
    updatePreview<K extends keyof PreviewSettings>(key: K, value: PreviewSettings[K]): void {
        this.#docSettings.preview[key] = value
        this.#docSave$.next()
    }

    // -----------------------------------------------------------------------
    // Cursor and selection (per-document)
    // -----------------------------------------------------------------------

    getCursorPosition(): { line: number; column: number } {
        return this.#docSettings.cursorPosition
    }

    getSelection(): EditorSelection {
        return this.#docSettings.selection
    }

    setCursorAndSelection(pos: { line: number; column: number }, selection: EditorSelection): void {
        this.#docSettings.cursorPosition = pos
        this.#docSettings.selection = selection
        this.#cursorSave$.next()
    }

    // -----------------------------------------------------------------------
    // Global settings
    // -----------------------------------------------------------------------

    getGlobal(): GlobalSettings {
        return this.#globalSettings
    }

    /** Update global settings with a partial patch (MDC levers deep-merged). */
    updateGlobal(patch: GlobalSettingsPatch): void {
        if (patch.preview) Object.assign(this.#globalSettings.preview, patch.preview)
        if (patch.meshViewer) Object.assign(this.#globalSettings.meshViewer, patch.meshViewer)
        if (patch.app) {
            const appPatch = patch.app
            const mergedApp: AppSettingsPatch = { ...appPatch }
            if (appPatch.mdcExportLevers !== undefined) {
                mergedApp.mdcExportLevers = normalizeMdcExportLevers({
                    ...this.#globalSettings.app.mdcExportLevers,
                    ...appPatch.mdcExportLevers,
                })
            }
            Object.assign(this.#globalSettings.app, mergedApp)
        }
        if (patch.layout) Object.assign(this.#globalSettings.layout, patch.layout)
        this.#globalSave$.next()
    }

    /** Clamped MDC export levers for mesh pipeline (Dev Tools). Voxel size follows `meshExportVoxelSizeMm`. */
    getMdcExportLevers(): MdcExportLevers {
        const g = this.#globalSettings.app
        return normalizeMdcExportLevers({
            ...g.mdcExportLevers,
            voxelSizeMm: g.meshExportVoxelSizeMm,
        })
    }

    // -----------------------------------------------------------------------
    // Flush
    // -----------------------------------------------------------------------

    /** Force-flush the current document settings to storage right now. */
    async flushDocNow(): Promise<void> {
        await this.#flushDoc()
    }

    /** Force-flush global settings to storage right now. */
    async flushGlobalNow(): Promise<void> {
        await this.#flushGlobal()
    }

    // -----------------------------------------------------------------------
    // Private: persistence
    // -----------------------------------------------------------------------

    async #flushDoc(): Promise<void> {
        if (!this.#currentDocName) return
        await db.docSettings.put({
            name: this.#currentDocName,
            settings: this.#docSettings as unknown as Record<string, unknown>,
        })
    }

    async #flushGlobal(): Promise<void> {
        await db.preferences.put({ key: "global", value: this.#globalSettings })
    }

    async #loadDoc(name: string): Promise<void> {
        const row = await db.docSettings.get(name)
        const def = defaultDocSettings()
        if (row?.settings && typeof row.settings === "object") {
            const parsed = row.settings as Partial<DocumentSettings>
            const cursor = { ...def.cursorPosition, ...parsed.cursorPosition }
            let selection = { ...def.selection, ...parsed.selection }
            if (!parsed.selection && parsed.cursorPosition) {
                selection = { startLine: cursor.line, startColumn: cursor.column, endLine: cursor.line, endColumn: cursor.column }
            }
            this.#docSettings = {
                camera: { ...def.camera, ...parsed.camera },
                preview: { ...def.preview, ...parsed.preview },
                cursorPosition: cursor,
                selection,
            }
            return
        }
        this.#docSettings = defaultDocSettings()
    }

    async #loadGlobal(): Promise<void> {
        const row = await db.preferences.get("global")
        const def = defaultGlobalSettings()
        if (row?.value && typeof row.value === "object") {
            try {
                const parsed = row.value as Partial<GlobalSettings>
                const preview = { ...def.preview, ...parsed.preview }
                const app = { ...def.app, ...parsed.app }
                if (typeof app.diskSyncIntervalSeconds !== "number") app.diskSyncIntervalSeconds = 30
                if (typeof app.meshSimplifyOnExport !== "boolean") app.meshSimplifyOnExport = true
                if (typeof app.meshExportVoxelSizeMm !== "number" || !isFinite(app.meshExportVoxelSizeMm) || app.meshExportVoxelSizeMm <= 0) app.meshExportVoxelSizeMm = DEFAULT_MESH_EXPORT_VOXEL_SIZE_MM
                if (typeof app.useShrecExporter !== "boolean") app.useShrecExporter = false
                {
                    const t = (app as { shrecTuning?: Partial<ShrecTuning> }).shrecTuning
                    const cur = { ...DEFAULT_SHREC_TUNING, ...(t ?? {}) }
                    if (typeof cur.mergeSharpEnabled !== "boolean") cur.mergeSharpEnabled = DEFAULT_SHREC_TUNING.mergeSharpEnabled
                    if (typeof cur.mergeRelCutoff !== "number" || !isFinite(cur.mergeRelCutoff)) cur.mergeRelCutoff = DEFAULT_SHREC_TUNING.mergeRelCutoff
                    if (typeof cur.mergeMaxDisplacement !== "number" || !isFinite(cur.mergeMaxDisplacement) || cur.mergeMaxDisplacement < 0) cur.mergeMaxDisplacement = DEFAULT_SHREC_TUNING.mergeMaxDisplacement
                    if (typeof cur.creaseAngleDeg !== "number" || !isFinite(cur.creaseAngleDeg) || cur.creaseAngleDeg < -1 || cur.creaseAngleDeg > 180) cur.creaseAngleDeg = DEFAULT_SHREC_TUNING.creaseAngleDeg
                    if (typeof cur.mergeGradientWeightPower !== "number" || !isFinite(cur.mergeGradientWeightPower) || cur.mergeGradientWeightPower < 0) cur.mergeGradientWeightPower = DEFAULT_SHREC_TUNING.mergeGradientWeightPower
                    if (typeof cur.dedupRadiusVoxels !== "number" || !isFinite(cur.dedupRadiusVoxels) || cur.dedupRadiusVoxels < 0) cur.dedupRadiusVoxels = DEFAULT_SHREC_TUNING.dedupRadiusVoxels
                    if (typeof cur.seamAwareEnabled !== "boolean") cur.seamAwareEnabled = DEFAULT_SHREC_TUNING.seamAwareEnabled
                    if (typeof cur.seamAgreementCosThreshold !== "number" || !isFinite(cur.seamAgreementCosThreshold) || cur.seamAgreementCosThreshold < 0 || cur.seamAgreementCosThreshold > 1) cur.seamAgreementCosThreshold = DEFAULT_SHREC_TUNING.seamAgreementCosThreshold
                    if (typeof cur.edgeFitEnabled !== "boolean") cur.edgeFitEnabled = DEFAULT_SHREC_TUNING.edgeFitEnabled
                    if (typeof cur.featureConstrainedPlacement !== "boolean") {
                        cur.featureConstrainedPlacement = DEFAULT_SHREC_TUNING.featureConstrainedPlacement
                    }
                    app.shrecTuning = cur
                }
                {
                    const st = (app as { simplifyTuning?: Partial<SimplifyTuning> }).simplifyTuning
                    const s = { ...DEFAULT_SIMPLIFY_TUNING, ...(st ?? {}) }
                    const clamp01 = (x: number, d: number) =>
                        typeof x === "number" && isFinite(x) ? Math.min(1, Math.max(0.01, x)) : d
                    const clampErr = (x: number, d: number) =>
                        typeof x === "number" && isFinite(x) && x >= 0 ? x : d
                    const clampNw = (x: number, d: number) =>
                        typeof x === "number" && isFinite(x) && x >= 0 ? Math.min(8, x) : d
                    s.targetRatio = clamp01(s.targetRatio, DEFAULT_SIMPLIFY_TUNING.targetRatio)
                    s.targetError = clampErr(s.targetError, DEFAULT_SIMPLIFY_TUNING.targetError)
                    if (typeof s.lockBorder !== "boolean") s.lockBorder = DEFAULT_SIMPLIFY_TUNING.lockBorder
                    if (typeof s.sparse !== "boolean") s.sparse = DEFAULT_SIMPLIFY_TUNING.sparse
                    if (typeof s.errorAbsolute !== "boolean") s.errorAbsolute = DEFAULT_SIMPLIFY_TUNING.errorAbsolute
                    if (typeof s.prune !== "boolean") s.prune = DEFAULT_SIMPLIFY_TUNING.prune
                    if (typeof s.regularize !== "boolean") s.regularize = DEFAULT_SIMPLIFY_TUNING.regularize
                    if (typeof s.renormalizeTriangles !== "boolean") {
                        s.renormalizeTriangles = DEFAULT_SIMPLIFY_TUNING.renormalizeTriangles
                    }
                    s.normalWeight = clampNw(s.normalWeight, DEFAULT_SIMPLIFY_TUNING.normalWeight)
                    app.simplifyTuning = s
                }
                if (typeof app.devToolsEnabled !== "boolean") app.devToolsEnabled = false
                if (typeof app.devToolsLightingExpanded !== "boolean") app.devToolsLightingExpanded = false
                if (typeof app.devToolsMdcExportExpanded !== "boolean") app.devToolsMdcExportExpanded = false
                app.mdcExportLevers = normalizeMdcExportLevers(app.mdcExportLevers)
                if (app.theme !== "light" && app.theme !== "dark" && app.theme !== "auto") app.theme = "dark"
                const editorDef = defaultEditorSettings()
                const editor = { ...editorDef, ...(parsed.app as { editor?: Partial<EditorSettings> })?.editor }
                if (editor.lineNumbers !== "on" && editor.lineNumbers !== "off" && editor.lineNumbers !== "relative")
                    editor.lineNumbers = editorDef.lineNumbers
                if (editor.wordWrap !== "on" && editor.wordWrap !== "off") editor.wordWrap = editorDef.wordWrap
                if (typeof editor.minimap !== "boolean") editor.minimap = editorDef.minimap
                if (typeof editor.fontSize !== "number" || editor.fontSize < 12 || editor.fontSize > 24)
                    editor.fontSize = editorDef.fontSize
                if (
                    editor.renderWhitespace !== "none" &&
                    editor.renderWhitespace !== "boundary" &&
                    editor.renderWhitespace !== "selection" &&
                    editor.renderWhitespace !== "all"
                )
                    editor.renderWhitespace = editorDef.renderWhitespace
                if (typeof editor.folding !== "boolean") editor.folding = editorDef.folding
                if (typeof editor.tabSize !== "number" || editor.tabSize < 2 || editor.tabSize > 8)
                    editor.tabSize = editorDef.tabSize
                app.editor = editor
                app.debugLogModules = mergeDebugLogModulesFromStorage(app.debugLogModules)
                this.#globalSettings = {
                    preview,
                    meshViewer: { ...def.meshViewer, ...parsed.meshViewer },
                    app,
                    layout: { ...def.layout, ...parsed.layout },
                }
                return
            } catch {
                log("Settings").error("Failed to load global settings from storage, using defaults")
            }
        }
        this.#globalSettings = defaultGlobalSettings()
    }
}
