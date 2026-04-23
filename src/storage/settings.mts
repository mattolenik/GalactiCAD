import { Subject } from "rxjs"
import { debounceTime } from "rxjs/operators"
import type { DebugLogModulesState } from "../logging/debug-log.mjs"
import { log, mergeDebugLogModulesFromStorage } from "../logging/debug-log.mjs"
import { DEVTOOLS_SECTION_LOGS } from "../components/dev-tools-protocol.mjs"
import { db } from "./db.mjs"

/** Per-section JSON snapshots under `GlobalSettings.app.devToolsSections`. */
export type DevToolsSectionsMap = Record<string, Record<string, unknown>>

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CameraSettings {
    position: [number, number, number]
    translation: [number, number, number]
    zoom: number
    rotation: [number, number, number, number] // quaternion [w, x, y, z]
    /** Orbit / look-at pivot in scene space; omitted in older saves → origin. */
    pivot?: [number, number, number]
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
        devToolsEnabled: boolean
        diskSyncIntervalSeconds: number
        theme: ThemeMode
        editor: EditorSettings
        /** Dev tools panel sections: keyed by `devToolsSectionId`. */
        devToolsSections: DevToolsSectionsMap
    }
    layout: LayoutSettings
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function defaultCamera(): CameraSettings {
    return { position: [0, 0, 0], translation: [0, 0, 0], zoom: 20, rotation: [1, 0, 0, 0], pivot: [0, 0, 0] }
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

function defaultGlobalSettings(): GlobalSettings {
    return {
        preview: { movementScale: 0.5, selectionMode: "object", cameraRotationMethod: "rounded_arcball" },
        meshViewer: { translucentFaces: false, wireframe: false },
        app: {
            devToolsEnabled: false,
            diskSyncIntervalSeconds: 30,
            theme: "dark",
            editor: defaultEditorSettings(),
            devToolsSections: {},
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

    /** Replace one dev tools section snapshot and debounce-persist global settings. */
    mergeGlobalDevToolsSection(sectionId: string, snapshot: Record<string, unknown>): void {
        this.#globalSettings.app.devToolsSections = {
            ...this.#globalSettings.app.devToolsSections,
            [sectionId]: { ...snapshot },
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
                const diskRaw = rawApp.diskSyncIntervalSeconds
                const themeRaw = rawApp.theme
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
                let diskSyncIntervalSeconds = typeof diskRaw === "number" ? diskRaw : def.app.diskSyncIntervalSeconds
                if (typeof diskSyncIntervalSeconds !== "number") diskSyncIntervalSeconds = 30
                const app: GlobalSettings["app"] = {
                    devToolsEnabled: typeof rawApp.devToolsEnabled === "boolean" ? rawApp.devToolsEnabled : def.app.devToolsEnabled,
                    diskSyncIntervalSeconds,
                    theme:
                        themeRaw === "light" || themeRaw === "dark" || themeRaw === "auto"
                            ? themeRaw
                            : def.app.theme,
                    editor,
                    devToolsSections,
                }
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
