import { Subject } from "rxjs"
import { debounceTime } from "rxjs/operators"
import type { DebugLogModulesState } from "../logging/debug-log.mjs"
import { log, mergeDebugLogModulesFromStorage } from "../logging/debug-log.mjs"
import type { MeshExporter } from "../render-worker-protocol.mjs"
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
        showFps: boolean
        meshSimplifyOnExport: boolean
        /** GPU mesh pipeline for STL export and live mesh viewer. */
        meshExporter: MeshExporter
        /** Per-exporter tuning; ISO Phase 1 uses dense uniform grids (see `chooseIsoVoxelForGpuLimits`). */
        isoExport: IsoExportSettings
        diskSyncIntervalSeconds: number
        theme: ThemeMode
        editor: EditorSettings
        /** Per-module debug logging; Dev Tools checkboxes. */
        debugLogModules: DebugLogModulesState
    }
    layout: LayoutSettings
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

/**
 * ISO Phase-1 export tuning knobs (see `chooseIsoVoxelForGpuLimits` in `src/export/iso.mts`).
 * Persisted under `app.isoExport`; the worker may coarsen `voxelSizeMm` to fit GPU buffer limits.
 */
export interface IsoExportSettings {
    /** Base voxel size in mm (worker may coarsen if dense buffers exceed `maxBufferSize`). */
    voxelSizeMm: number
    /** Bounding-box padding in mm added on every side of the SDF bounds. */
    padMm: number
    /** Face-normal angle threshold for crease vertex splitting (degrees, 180 = disable splitting). */
    creaseAngleDeg: number
}

export function defaultIsoExportSettings(): IsoExportSettings {
    // creaseAngleDeg=60° pairs with Phase 4's 4D-QEF sharp-feature placement: smooths
    // piecewise-polygon SDF noise (~10° normal jumps for typical 32-segment circles) while
    // preserving real CSG/box edges (~90° jumps). 180° = uniform Phong smoothing.
    return { voxelSizeMm: 0.1, padMm: 3.2, creaseAngleDeg: 60 }
}

function defaultGlobalSettings(): GlobalSettings {
    return {
        preview: { movementScale: 0.5, selectionMode: "object", cameraRotationMethod: "rounded_arcball" },
        meshViewer: { translucentFaces: false, wireframe: false },
        app: {
            meshViewerEnabled: false,
            devToolsEnabled: false,
            devToolsLightingExpanded: false,
            showFps: true,
            meshSimplifyOnExport: true,
            meshExporter: "mdc",
            isoExport: defaultIsoExportSettings(),
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

    /** Update global settings with a partial patch (deep-merged one level). */
    updateGlobal(patch: Partial<{ [K in keyof GlobalSettings]: Partial<GlobalSettings[K]> }>): void {
        for (const section of Object.keys(patch) as (keyof GlobalSettings)[]) {
            Object.assign(this.#globalSettings[section], patch[section])
        }
        this.#globalSave$.next()
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
                if (app.meshExporter !== "mdc" && app.meshExporter !== "iso") app.meshExporter = "mdc"
                const isoDef = defaultIsoExportSettings()
                const iso = { ...isoDef, ...(app as { isoExport?: Partial<IsoExportSettings> }).isoExport }
                if (typeof iso.voxelSizeMm !== "number" || !(iso.voxelSizeMm > 0) || iso.voxelSizeMm > 1024)
                    iso.voxelSizeMm = isoDef.voxelSizeMm
                if (typeof iso.padMm !== "number" || iso.padMm < 0 || iso.padMm > 1024)
                    iso.padMm = isoDef.padMm
                if (typeof iso.creaseAngleDeg !== "number" || iso.creaseAngleDeg < 0 || iso.creaseAngleDeg > 180)
                    iso.creaseAngleDeg = isoDef.creaseAngleDeg
                app.isoExport = iso
                if (typeof app.devToolsEnabled !== "boolean") app.devToolsEnabled = false
                if (typeof app.devToolsLightingExpanded !== "boolean") app.devToolsLightingExpanded = false
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
