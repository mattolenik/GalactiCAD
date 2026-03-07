import { Subject } from "rxjs"
import { debounceTime } from "rxjs/operators"
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

export interface DocumentSettings {
    camera: CameraSettings
    preview: PreviewSettings
}

export type SelectionMode = "object" | "seam" | "edge" | "face" | "auto"

export type CameraRotationMethod = "rounded_arcball" | "azel"

export interface GlobalSettings {
    preview: { movementScale: number; selectionMode: SelectionMode; cameraRotationMethod: CameraRotationMethod }
    meshViewer: { translucentFaces: boolean; wireframe: boolean }
    app: { meshViewerEnabled: boolean; devToolsEnabled: boolean; showFps: boolean; meshSimplifyOnExport: boolean; diskSyncIntervalSeconds: number }
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

function defaultDocSettings(): DocumentSettings {
    return { camera: defaultCamera(), preview: defaultPreview() }
}

function defaultGlobalSettings(): GlobalSettings {
    return {
        preview: { movementScale: 0.5, selectionMode: "object", cameraRotationMethod: "rounded_arcball" },
        meshViewer: { translucentFaces: false, wireframe: false },
        app: { meshViewerEnabled: false, devToolsEnabled: false, showFps: true, meshSimplifyOnExport: true, diskSyncIntervalSeconds: 30 },
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
    #globalSave$ = new Subject<void>()

    #initPromise: Promise<void>

    constructor() {
        this.#initPromise = this.#loadGlobal()

        // Camera saves debounce at 300ms -- only persists after movement stops
        this.#cameraSave$.pipe(debounceTime(300)).subscribe(() => void this.#flushDoc())

        // Other per-doc settings debounce at 100ms
        this.#docSave$.pipe(debounceTime(100)).subscribe(() => void this.#flushDoc())

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
            return {
                camera: { ...def.camera, ...parsed.camera },
                preview: { ...def.preview, ...parsed.preview },
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
            this.#docSettings = {
                camera: { ...def.camera, ...parsed.camera },
                preview: { ...def.preview, ...parsed.preview },
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
                this.#globalSettings = {
                    preview,
                    meshViewer: { ...def.meshViewer, ...parsed.meshViewer },
                    app,
                    layout: { ...def.layout, ...parsed.layout },
                }
                return
            } catch {
                console.error("Failed to load global settings from storage, using defaults")
            }
        }
        this.#globalSettings = defaultGlobalSettings()
    }
}
