import { Subject } from "rxjs"
import { debounceTime } from "rxjs/operators"
import type { DebugLogModulesState } from "../logging/debug-log.mjs"
import { log, mergeDebugLogModulesFromStorage } from "../logging/debug-log.mjs"
import {
    DEFAULT_APP_DEVTOOLS_STATE,
    DEVTOOLS_COLLAPSE,
    DEVTOOLS_SECTION_APP,
    DEVTOOLS_SECTION_LOGS,
} from "../components/dev-tools-protocol.mjs"
import { DEFAULT_SIMPLIFY_TUNING, type SimplifyTuning, type FeatureGraphOcclusionMode } from "../render-worker-protocol.mjs"
import { EXPORTER_KINDS, isValidExporter, type ExporterKind } from "../export/mesh-exporter.mjs"
import { DEFAULT_MDC_TUNING, normalizeMdcTuning, type MdcTuning } from "../export/mdc-tuning.mjs"
import { DEFAULT_SHREC_TUNING, normalizeShrecTuning, type ShrecTuning } from "../export/shrec/shrec-tuning.mjs"
import { DEFAULT_FLEXICUBES_TUNING, normalizeFlexiCubesTuning, type FlexiCubesTuning } from "../export/flexicubes/flexicubes-tuning.mjs"
import { DEFAULT_ISO_SIMPLICIAL_TUNING, normalizeIsoSimplicialTuning, type IsoSimplicialTuning } from "../export/iso-simplicial/iso-tuning.mjs"
import { DEFAULT_SFCC_TUNING, normalizeSfccTuning, type SfccTuning } from "../export/sfcc/sfcc-tuning.mjs"
import { db } from "./db.mjs"

/** Per-exporter tuning normalizers, keyed by kind. */
const EXPORTER_NORMALIZERS: Record<ExporterKind, (raw: unknown) => unknown> = {
    mdc: normalizeMdcTuning,
    shrec: normalizeShrecTuning,
    isoSimplicial: normalizeIsoSimplicialTuning,
    flexicubes: normalizeFlexiCubesTuning,
    sfcc: normalizeSfccTuning,
}

/** Fresh default tuning for every exporter (each a copy). */
function defaultExporterTuning(): Record<ExporterKind, unknown> {
    return {
        mdc: { ...DEFAULT_MDC_TUNING },
        shrec: { ...DEFAULT_SHREC_TUNING },
        isoSimplicial: { ...DEFAULT_ISO_SIMPLICIAL_TUNING },
        flexicubes: { ...DEFAULT_FLEXICUBES_TUNING },
        sfcc: { ...DEFAULT_SFCC_TUNING },
    }
}

/** Per-section JSON snapshots under `GlobalSettings.app.devToolsSections`. */
export type DevToolsSectionsMap = Record<string, Record<string, unknown>>

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CameraSettings {
    position: [number, number, number]
    translation: [number, number, number]
    /** Dolly stand-off; WGSL ortho half-height is derived (see `orthoHalfFromDolly`). */
    dollyDistance?: number
    /**
     * Legacy persisted orthographic half-height from builds before dolly zoom.
     * Migrated to `dollyDistance` on load when `dollyDistance` is absent.
     */
    zoom?: number
    rotation: [number, number, number, number] // quaternion [w, x, y, z]
    /** Orbit / look-at pivot in scene space; omitted in older saves → origin. */
    pivot?: [number, number, number]
}

export interface PreviewSettings {
    xrayMode: boolean
    /** When true, preview uses analytical normals for shading ("normal mode"). */
    previewNormalShading: boolean
    cameraOptimization: boolean
    beamOptimization: boolean
    bvhOptimization: boolean
    /**
     * Occlusion mode for the always-on FeatureGraph overlay (toolbar toggle):
     * "hard" hides features behind the SDF surface (default), "dim" fades them.
     * ("off" remains a valid value but is no longer reachable from the UI.)
     */
    featureGraphOcclusion: FeatureGraphOcclusionMode
    /** Edge line width (framebuffer px) for the FeatureGraph overlay. */
    featureGraphLineWidth: number
    /**
     * Color original (emitted) crease edges green vs subdivided edges cyan in
     * the overlay. Default false ⇒ all edges cyan.
     */
    featureGraphDifferentiateSegments: boolean
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

export type SelectionMode = "object" | "seam" | "edge" | "corner" | "face" | "auto"

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

/** MDC mesh viewer overlay: feature-class glyphs (debug samples must come from mesh export). */
export interface MeshViewerFeatureGlyphsSettings {
    line: boolean
    corner: boolean
    seam: boolean
    ring: boolean
}

export interface GlobalSettings {
    preview: { movementScale: number; selectionMode: SelectionMode; cameraRotationMethod: CameraRotationMethod }
    meshViewer: {
        translucentFaces: boolean
        wireframe: boolean
        /** Raw per-sample squares (MDC debug overlay). */
        mdcDebugPoints: boolean
        featureGlyphs: MeshViewerFeatureGlyphsSettings
        /** Per-cell-component vertex position markers (MDC QEF debug). */
        mdcCellVertices: boolean
        /** Per-(cell, component) QEF input plane normals (MDC QEF debug). */
        mdcQefPlanes: boolean
    }
    app: {
        devToolsEnabled: boolean
        /** Which mesh extraction pipeline Dev Tools / mesh viewer use. */
        meshExporter: ExporterKind
        /**
         * Per-exporter tuning, keyed by exporter kind. Each entry is normalized
         * on load by that exporter's `normalizeTuning`. Voxel size lives here
         * (per-exporter), not as a global. See `src/export/*-tuning.mts`.
         */
        exporterTuning: Record<ExporterKind, unknown>
        /** Post-export mesh simplification (meshoptimizer); used when mesh simplify on export is enabled. */
        simplifyTuning: SimplifyTuning
        diskSyncIntervalSeconds: number
        theme: ThemeMode
        editor: EditorSettings
        /** Dev tools panel sections: keyed by `devToolsSectionId`. */
        devToolsSections: DevToolsSectionsMap
        /** Dev tools `<details>` groups: keyed by `DEVTOOLS_COLLAPSE` id; `true` = expanded. */
        devToolsCollapseOpen: Record<string, boolean>
    }
    layout: LayoutSettings
}

/** Partial global update; `exporterTuning` may patch a subset of exporters, each a partial tuning. */
export type AppSettingsPatch = Omit<Partial<GlobalSettings["app"]>, "exporterTuning"> & {
    exporterTuning?: Partial<Record<ExporterKind, unknown>>
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
    // ~same framing as legacy default ortho half-height 20 (zoom field): dolly = 50 * 20/40 = 25
    return {
        position: [0, 0, 0],
        translation: [0, 0, 0],
        dollyDistance: 25,
        rotation: [1, 0, 0, 0],
        pivot: [0, 0, 0],
    }
}

function defaultPreview(): PreviewSettings {
    return {
        xrayMode: false,
        previewNormalShading: false,
        cameraOptimization: true,
        beamOptimization: true,
        bvhOptimization: true,
        featureGraphOcclusion: "hard",
        featureGraphLineWidth: 2,
        featureGraphDifferentiateSegments: false,
    }
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

function defaultGlobalSettings(): GlobalSettings {
    return {
        preview: { movementScale: 0.5, selectionMode: "object", cameraRotationMethod: "rounded_arcball" },
        meshViewer: {
            translucentFaces: false,
            wireframe: false,
            mdcDebugPoints: false,
            featureGlyphs: { line: false, corner: false, seam: false, ring: false },
            mdcCellVertices: false,
            mdcQefPlanes: false,
        },
        app: {
            devToolsEnabled: false,
            meshExporter: "mdc",
            exporterTuning: defaultExporterTuning(),
            simplifyTuning: { ...DEFAULT_SIMPLIFY_TUNING },
            diskSyncIntervalSeconds: 30,
            theme: "dark",
            editor: defaultEditorSettings(),
            devToolsSections: {},
            devToolsCollapseOpen: {},
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

    /** Update global settings with a partial patch (`exporterTuning` deep-merged per kind). */
    updateGlobal(patch: GlobalSettingsPatch): void {
        if (patch.preview) Object.assign(this.#globalSettings.preview, patch.preview)
        if (patch.meshViewer) {
            const { featureGlyphs, ...mvRest } = patch.meshViewer
            Object.assign(this.#globalSettings.meshViewer, mvRest)
            if (featureGlyphs) {
                Object.assign(this.#globalSettings.meshViewer.featureGlyphs, featureGlyphs)
            }
        }
        if (patch.app) {
            const appPatch = patch.app
            const mergedApp: AppSettingsPatch = { ...appPatch }
            if (appPatch.exporterTuning !== undefined) {
                const incomingAll = appPatch.exporterTuning
                const merged: Record<ExporterKind, unknown> = { ...this.#globalSettings.app.exporterTuning }
                for (const kind of EXPORTER_KINDS) {
                    const incoming = incomingAll[kind]
                    if (incoming === undefined) continue
                    const normalize = EXPORTER_NORMALIZERS[kind]
                    // An empty object (e.g. Dev Tools “Iso defaults”) replaces stored
                    // overrides rather than merging — `{ ...cur, ...{} } === cur` would keep stale keys.
                    const isEmpty =
                        incoming !== null && typeof incoming === "object" && Object.keys(incoming).length === 0
                    merged[kind] = isEmpty
                        ? normalize({})
                        : normalize({ ...(merged[kind] as object), ...(incoming as object) })
                }
                mergedApp.exporterTuning = merged
            }
            Object.assign(this.#globalSettings.app, mergedApp)
        }
        if (patch.layout) Object.assign(this.#globalSettings.layout, patch.layout)
        this.#globalSave$.next()
    }

    /** Normalized tuning for one exporter (Dev Tools / mesh pipeline). */
    getExporterTuning(kind: ExporterKind): unknown {
        return EXPORTER_NORMALIZERS[kind](this.#globalSettings.app.exporterTuning[kind])
    }

    /** Normalized SHREC tuning. */
    getShrecTuning(): ShrecTuning {
        return normalizeShrecTuning(this.#globalSettings.app.exporterTuning.shrec)
    }

    /** Normalized FlexiCubes tuning. */
    getFlexicubesTuning(): FlexiCubesTuning {
        return normalizeFlexiCubesTuning(this.#globalSettings.app.exporterTuning.flexicubes)
    }

    /** Normalized iso-simplicial tuning. */
    getIsoSimplicialTuning(): IsoSimplicialTuning {
        return normalizeIsoSimplicialTuning(this.#globalSettings.app.exporterTuning.isoSimplicial)
    }

    /** Normalized SFCC tuning. */
    getSfccTuning(): SfccTuning {
        return normalizeSfccTuning(this.#globalSettings.app.exporterTuning.sfcc)
    }

    /** Clamped MDC export tuning for mesh pipeline (Dev Tools). */
    getMdcExportLevers(): MdcTuning {
        return normalizeMdcTuning(this.#globalSettings.app.exporterTuning.mdc)
    }

    /** Replace one dev tools section snapshot and debounce-persist global settings. */
    mergeGlobalDevToolsSection(sectionId: string, snapshot: Record<string, unknown>): void {
        this.#globalSettings.app.devToolsSections = {
            ...this.#globalSettings.app.devToolsSections,
            [sectionId]: { ...snapshot },
        }
        this.#globalSave$.next()
    }

    /** Persist one dev tools collapsible expanded state (`true` = open). */
    mergeGlobalDevToolsCollapse(id: string, open: boolean): void {
        this.#globalSettings.app.devToolsCollapseOpen = {
            ...this.#globalSettings.app.devToolsCollapseOpen,
            [id]: open,
        }
        this.#globalSave$.next()
    }

    /** Per-module debug flags from persisted dev tools logs section. */
    getDebugLogModules(): DebugLogModulesState {
        const blob = this.#globalSettings.app.devToolsSections[DEVTOOLS_SECTION_LOGS]
        return mergeDebugLogModulesFromStorage(blob)
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
                const rawApp = (parsed.app ?? {}) as Record<string, unknown>
                const devToolsSectionsRaw = rawApp.devToolsSections
                const devToolsSections: DevToolsSectionsMap = {}
                if (devToolsSectionsRaw && typeof devToolsSectionsRaw === "object" && !Array.isArray(devToolsSectionsRaw)) {
                    for (const [k, v] of Object.entries(devToolsSectionsRaw as Record<string, unknown>)) {
                        if (v && typeof v === "object" && !Array.isArray(v)) devToolsSections[k] = { ...(v as Record<string, unknown>) }
                    }
                }
                const collapseRaw = rawApp.devToolsCollapseOpen
                const devToolsCollapseOpen: Record<string, boolean> = {}
                if (collapseRaw && typeof collapseRaw === "object" && !Array.isArray(collapseRaw)) {
                    for (const [k, v] of Object.entries(collapseRaw as Record<string, unknown>)) {
                        if (typeof v === "boolean") devToolsCollapseOpen[k] = v
                    }
                }

                if (
                    typeof rawApp.showFps === "boolean" ||
                    typeof rawApp.meshViewerEnabled === "boolean" ||
                    typeof rawApp.meshSimplifyOnExport === "boolean"
                ) {
                    const base: Record<string, unknown> = {
                        ...DEFAULT_APP_DEVTOOLS_STATE,
                        ...(devToolsSections[DEVTOOLS_SECTION_APP] ?? {}),
                    }
                    if (typeof rawApp.showFps === "boolean") base.showFps = rawApp.showFps
                    if (typeof rawApp.meshViewerEnabled === "boolean") base.meshViewerEnabled = rawApp.meshViewerEnabled
                    if (typeof rawApp.meshSimplifyOnExport === "boolean") base.meshSimplifyOnExport = rawApp.meshSimplifyOnExport
                    devToolsSections[DEVTOOLS_SECTION_APP] = base
                }
                const legacyLogs = rawApp.debugLogModules
                if (legacyLogs && typeof legacyLogs === "object" && !Array.isArray(legacyLogs)) {
                    const logSec: Record<string, unknown> = { ...(devToolsSections[DEVTOOLS_SECTION_LOGS] ?? {}) }
                    for (const [k, v] of Object.entries(legacyLogs as Record<string, unknown>)) {
                        if (typeof v === "boolean") logSec[k] = v
                    }
                    devToolsSections[DEVTOOLS_SECTION_LOGS] = logSec
                }
                if (typeof rawApp.devToolsMdcExportExpanded === "boolean") {
                    devToolsCollapseOpen[DEVTOOLS_COLLAPSE.panelMeshExportMdc] = rawApp.devToolsMdcExportExpanded
                }

                const diskRaw = rawApp.diskSyncIntervalSeconds
                const themeRaw = rawApp.theme

                // Voxel size used to be one global value (`app.meshExportVoxelSizeMm`)
                // that overrode every per-exporter voxel. Migrate it into the grid
                // exporters' own voxel so old saves keep their effective density.
                const legacyVoxelSizeMm =
                    typeof rawApp.meshExportVoxelSizeMm === "number" &&
                    isFinite(rawApp.meshExportVoxelSizeMm) &&
                    rawApp.meshExportVoxelSizeMm > 0
                        ? rawApp.meshExportVoxelSizeMm
                        : undefined

                const useShrecLegacy = typeof rawApp.useShrecExporter === "boolean" ? rawApp.useShrecExporter : false
                const meshExporter: ExporterKind =
                    isValidExporter(rawApp.meshExporter)
                        ? rawApp.meshExporter
                        : isValidExporter(rawApp.exporterKind)
                          ? rawApp.exporterKind
                          : useShrecLegacy
                            ? "shrec"
                            : "mdc"

                // Per-exporter tuning blob. Falls back to the old per-field names
                // (`shrecTuning`, `mdcExportLevers`, …) for one-time migration, and
                // seeds the grid exporters' voxel from the legacy global voxel.
                const rawTuning =
                    rawApp.exporterTuning && typeof rawApp.exporterTuning === "object"
                        ? (rawApp.exporterTuning as Record<string, unknown>)
                        : {}
                const legacyRaw: Record<ExporterKind, unknown> = {
                    mdc: rawApp.mdcExportLevers,
                    shrec: rawApp.shrecTuning,
                    isoSimplicial: rawApp.isoSimplicialTuning,
                    flexicubes: rawApp.flexicubesTuning,
                    sfcc: undefined, // no legacy per-field name — SFCC postdates the tuning blob
                }
                const exporterTuning = {} as Record<ExporterKind, unknown>
                for (const kind of EXPORTER_KINDS) {
                    let raw = rawTuning[kind] ?? legacyRaw[kind]
                    if (legacyVoxelSizeMm !== undefined && kind !== "isoSimplicial") {
                        const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
                        const v = r.voxelSizeMm
                        if (typeof v !== "number" || !isFinite(v) || v <= 0) {
                            raw = { ...r, voxelSizeMm: legacyVoxelSizeMm }
                        }
                    }
                    exporterTuning[kind] = EXPORTER_NORMALIZERS[kind](raw)
                }

                const simplifyTuning: SimplifyTuning = (() => {
                    const st = rawApp.simplifyTuning as Partial<SimplifyTuning> | undefined
                    const s = { ...DEFAULT_SIMPLIFY_TUNING, ...(st ?? {}) }
                    const clamp01 = (x: number, d: number) =>
                        typeof x === "number" && isFinite(x) ? Math.min(1, Math.max(0.01, x)) : d
                    const clampErr = (x: number, d: number) => (typeof x === "number" && isFinite(x) && x >= 0 ? x : d)
                    const clampNw = (x: number, d: number) => (typeof x === "number" && isFinite(x) && x >= 0 ? Math.min(8, x) : d)
                    s.targetRatio = clamp01(s.targetRatio, DEFAULT_SIMPLIFY_TUNING.targetRatio)
                    s.targetError = clampErr(s.targetError, DEFAULT_SIMPLIFY_TUNING.targetError)
                    if (typeof s.lockBorder !== "boolean") s.lockBorder = DEFAULT_SIMPLIFY_TUNING.lockBorder
                    if (typeof s.sparse !== "boolean") s.sparse = DEFAULT_SIMPLIFY_TUNING.sparse
                    if (typeof s.errorAbsolute !== "boolean") s.errorAbsolute = DEFAULT_SIMPLIFY_TUNING.errorAbsolute
                    if (typeof s.prune !== "boolean") s.prune = DEFAULT_SIMPLIFY_TUNING.prune
                    if (typeof s.regularize !== "boolean") s.regularize = DEFAULT_SIMPLIFY_TUNING.regularize
                    if (typeof s.renormalizeTriangles !== "boolean") s.renormalizeTriangles = DEFAULT_SIMPLIFY_TUNING.renormalizeTriangles
                    s.normalWeight = clampNw(s.normalWeight, DEFAULT_SIMPLIFY_TUNING.normalWeight)
                    return s
                })()

                const editorDef = defaultEditorSettings()
                const editor = { ...editorDef, ...(rawApp.editor as Partial<EditorSettings> | undefined) }
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
                let diskSyncIntervalSeconds = typeof diskRaw === "number" ? diskRaw : def.app.diskSyncIntervalSeconds
                if (typeof diskSyncIntervalSeconds !== "number") diskSyncIntervalSeconds = 30
                const app: GlobalSettings["app"] = {
                    devToolsEnabled: typeof rawApp.devToolsEnabled === "boolean" ? rawApp.devToolsEnabled : def.app.devToolsEnabled,
                    meshExporter,
                    exporterTuning,
                    simplifyTuning,
                    diskSyncIntervalSeconds,
                    theme:
                        themeRaw === "light" || themeRaw === "dark" || themeRaw === "auto"
                            ? themeRaw
                            : def.app.theme,
                    editor,
                    devToolsSections,
                    devToolsCollapseOpen,
                }
                const mvDef = def.meshViewer
                const mvParsed = (parsed.meshViewer ?? {}) as Partial<GlobalSettings["meshViewer"]>
                const meshViewer = {
                    ...mvDef,
                    ...mvParsed,
                    featureGlyphs: {
                        ...mvDef.featureGlyphs,
                        ...(mvParsed.featureGlyphs ?? {}),
                    },
                }
                if (typeof meshViewer.mdcDebugPoints !== "boolean") meshViewer.mdcDebugPoints = mvDef.mdcDebugPoints
                if (typeof meshViewer.mdcCellVertices !== "boolean") meshViewer.mdcCellVertices = mvDef.mdcCellVertices
                if (typeof meshViewer.mdcQefPlanes !== "boolean") meshViewer.mdcQefPlanes = mvDef.mdcQefPlanes
                this.#globalSettings = {
                    preview,
                    meshViewer,
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
