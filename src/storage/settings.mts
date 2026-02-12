import { Subject } from "rxjs"
import { debounceTime } from "rxjs/operators"

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
}

export interface DocumentSettings {
    camera: CameraSettings
    preview: PreviewSettings
}

export interface GlobalSettings {
    preview: { movementScale: number }
    meshViewer: { translucentFaces: boolean; wireframe: boolean }
    app: { meshViewerEnabled: boolean }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function defaultCamera(): CameraSettings {
    return { position: [0, 0, 0], translation: [0, 0, 0], zoom: 20, rotation: [1, 0, 0, 0] }
}

function defaultPreview(): PreviewSettings {
    return { xrayMode: false, cameraOptimization: true, beamOptimization: false }
}

function defaultDocSettings(): DocumentSettings {
    return { camera: defaultCamera(), preview: defaultPreview() }
}

function defaultGlobalSettings(): GlobalSettings {
    return {
        preview: { movementScale: 0.5 },
        meshViewer: { translucentFaces: false, wireframe: false },
        app: { meshViewerEnabled: false },
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

    constructor() {
        // Load global settings on construction
        this.#loadGlobal()

        // Camera saves debounce at 300ms -- only persists after movement stops
        this.#cameraSave$.pipe(debounceTime(300)).subscribe(() => this.#flushDoc())

        // Other per-doc settings debounce at 100ms
        this.#docSave$.pipe(debounceTime(100)).subscribe(() => this.#flushDoc())

        // Global settings debounce at 100ms
        this.#globalSave$.pipe(debounceTime(100)).subscribe(() => this.#flushGlobal())
    }

    // -----------------------------------------------------------------------
    // Document lifecycle
    // -----------------------------------------------------------------------

    /** Switch to a different document. Flushes current doc immediately, loads the new one. */
    switchDocument(name: string | null): void {
        // Flush current doc synchronously so nothing is lost
        this.#flushDoc()
        this.#currentDocName = name
        if (name) {
            this.#loadDoc(name)
        } else {
            this.#docSettings = defaultDocSettings()
        }
    }

    /** Delete a document's settings from localStorage. */
    deleteDocument(name: string): void {
        localStorage.removeItem(`settings:${name}`)
    }

    /** Rename a document's settings entry. */
    renameDocument(oldName: string, newName: string): void {
        const raw = localStorage.getItem(`settings:${oldName}`)
        if (raw !== null) {
            localStorage.setItem(`settings:${newName}`, raw)
            localStorage.removeItem(`settings:${oldName}`)
        }
        // If the currently active doc is being renamed, update our tracking
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
    // Flush (synchronous write to localStorage)
    // -----------------------------------------------------------------------

    /** Force-flush the current document settings to localStorage right now. */
    flushDocNow(): void {
        this.#flushDoc()
    }

    /** Force-flush global settings to localStorage right now. */
    flushGlobalNow(): void {
        this.#flushGlobal()
    }

    // -----------------------------------------------------------------------
    // Private: persistence
    // -----------------------------------------------------------------------

    #flushDoc(): void {
        if (!this.#currentDocName) return
        localStorage.setItem(`settings:${this.#currentDocName}`, JSON.stringify(this.#docSettings))
    }

    #flushGlobal(): void {
        localStorage.setItem("settings", JSON.stringify(this.#globalSettings))
    }

    #loadDoc(name: string): void {
        const raw = localStorage.getItem(`settings:${name}`)
        if (raw) {
            try {
                const parsed = JSON.parse(raw)
                const def = defaultDocSettings()
                this.#docSettings = {
                    camera: { ...def.camera, ...parsed.camera },
                    preview: { ...def.preview, ...parsed.preview },
                }
                return
            } catch {
                // Corrupted JSON -- use defaults
            }
        }
        this.#docSettings = defaultDocSettings()
    }

    #loadGlobal(): void {
        const raw = localStorage.getItem("settings")
        if (raw) {
            try {
                const parsed = JSON.parse(raw)
                const def = defaultGlobalSettings()
                this.#globalSettings = {
                    preview: { ...def.preview, ...parsed.preview },
                    meshViewer: { ...def.meshViewer, ...parsed.meshViewer },
                    app: { ...def.app, ...parsed.app },
                }
                return
            } catch {
                // Corrupted JSON -- use defaults
            }
        }
        this.#globalSettings = defaultGlobalSettings()
    }
}
