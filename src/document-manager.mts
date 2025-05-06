import * as monaco from "monaco-editor"
import { nanoid } from "nanoid"
import { validateFilename } from "./fs/fs.mjs"

export type DocumentCreatedCallback = (model: monaco.editor.ITextModel) => void
export type DocumentLoadedCallback = (model: monaco.editor.ITextModel) => void
export type DocumentRenamedCallback = (oldModel: monaco.editor.ITextModel, newModel: monaco.editor.ITextModel) => void

/**
 * Metadata for a stored document
 */
export interface DocumentMeta {
    /** Unique document name, used as key */
    name: string
    /** On-disk filename, if saved */
    disk_path?: string
}

/**
 * Stored file handle record
 */
export interface HandleRecord {
    name: string
    handle: FileSystemFileHandle
}

const DOCUMENTS = "documents"
const HANDLES = "handles"

/**
 * Allowed object store names
 */
type StoreName = "documents" | "handles"

export class DocumentManager {
    dbInit: Promise<IDBDatabase> | null
    #db: IDBDatabase | undefined

    #models = new Map<string, monaco.editor.ITextModel>()
    #handles = new Map<string, FileSystemFileHandle>()
    #createdListeners: DocumentCreatedCallback[] = []
    #loadedListeners: DocumentLoadedCallback[] = []
    #renamedListeners: DocumentRenamedCallback[] = []

    constructor(dbName: string) {
        this.dbInit = this.#openDB(dbName).then(db => {
            this.#db = db
            // rehydrate handles
            this.#getAll(HANDLES).then(records => {
                records.forEach(({ name, handle }) => this.#handles.set(name, handle))
            })
            return db
        })
    }

    async #ready(): Promise<void> {
        if (this.dbInit) {
            this.#db = await this.dbInit
            this.dbInit = null
        }
    }

    #openDB(name: string): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(name, 1)
            req.onupgradeneeded = () => {
                const db = req.result
                if (!db.objectStoreNames.contains(DOCUMENTS)) {
                    db.createObjectStore(DOCUMENTS, { keyPath: "name" })
                }
                if (!db.objectStoreNames.contains(HANDLES)) {
                    db.createObjectStore(HANDLES, { keyPath: "name" })
                }
            }
            req.onsuccess = () => resolve(req.result)
            req.onerror = () => reject(req.error)
        })
    }

    async #tx(store: StoreName, mode: IDBTransactionMode): Promise<IDBObjectStore> {
        await this.#ready()
        return this.#db!.transaction(store, mode).objectStore(store)
    }

    /**
     * Store a value in the given object store
     */
    async #put(store: StoreName, value: any): Promise<void> {
        const os = await this.#tx(store, "readwrite")
        const req = os.put(value)
        return new Promise((res, rej) => {
            req.onsuccess = () => res()
            req.onerror = () => rej(req.error)
        })
    }

    /**
     * Get a single record by key from the given store
     */
    async #get(store: StoreName, key: string): Promise<any | undefined> {
        const os = await this.#tx(store, "readonly")
        return new Promise(async (res, rej) => {
            const req = os.get(key)
            req.onsuccess = () => res(req.result)
            req.onerror = () => rej(req.error)
        })
    }

    /**
     * Get all records from the given store
     */
    async #getAll(store: StoreName): Promise<any[]> {
        const os = await this.#tx(store, "readonly")
        return new Promise((res, rej) => {
            const req = os.getAll()
            req.onsuccess = () => res(req.result)
            req.onerror = () => rej(req.error)
        })
    }

    /**
     * Delete a record by key from the given store
     */
    async #delete(store: StoreName, key: string): Promise<void> {
        const os = await this.#tx(store, "readwrite")
        return new Promise((res, rej) => {
            const req = os.delete(key)
            req.onsuccess = () => res()
            req.onerror = () => rej(req.error)
        })
    }

    onDocumentCreated(cb: DocumentCreatedCallback): void {
        this.#createdListeners.push(cb)
    }

    onDocumentLoaded(cb: DocumentLoadedCallback): void {
        this.#loadedListeners.push(cb)
    }

    onDocumentRenamed(cb: DocumentRenamedCallback): void {
        this.#renamedListeners.push(cb)
    }

    /**
     * Create a new blank document, persist metadata, and emit creation event
     */
    async new(content = "", language = "javascript"): Promise<monaco.editor.ITextModel> {
        const topIndex =
            Array.from(this.#models.keys())
                .map(s => parseInt(s.match(/^new sketch (\d+)$/)?.map((v, i, arr) => arr[i])[1] ?? "0"))
                .reduce((p, c) => Math.max(p, c), 0) + 1

        const name = `new sketch ${topIndex}`

        const uri = monaco.Uri.parse(`inmemory://model/${nanoid()}`)
        const model = monaco.editor.createModel(content, language, uri)
        this.#models.set(name, model)

        await this.#put(DOCUMENTS, { name })
        this.#createdListeners.forEach(cb => cb(model))
        return model
    }

    /**
     * Load document from disk, persist metadata & handle, and emit loaded event
     */
    async load(language = "javascript"): Promise<monaco.editor.ITextModel> {
        const [handle] = await (window as any).showOpenFilePicker({
            multiple: false,
            types: [{ description: "GalactiCAD Files", accept: { "text/plain": [".gcad"] } }],
        })
        const file = await handle.getFile()
        const content = await file.text()
        const name = file.name

        const uri = monaco.Uri.parse(`inmemory://model/${nanoid()}`)
        const model = monaco.editor.createModel(content, language, uri)
        this.#models.set(name, model)

        await this.#put(HANDLES, { name, handle })
        this.#handles.set(name, handle)
        await this.#put(DOCUMENTS, { name, disk_path: handle.name })

        this.#loadedListeners.forEach(cb => cb(model))
        return model
    }

    /**
     * Save document metadata and optionally persist to disk
     */
    async save(name: string, persist?: boolean): Promise<void> {
        validateFilename(name)
        const model = this.#models.get(name)
        if (!model) throw new Error(`No document named ${name}`)

        const entry = (await this.#get(DOCUMENTS, name)) ?? { name }
        persist ??= entry.disk_path !== undefined
        await this.#put(DOCUMENTS, entry)

        if (persist) {
            let handle = await this.#get(HANDLES, name)
            if (!handle) {
                handle = await (window as any).showSaveFilePicker({
                    suggestedName: name,
                    types: [{ description: "GalactiCAD Files", accept: { "text/plain": [".gcad"] } }],
                })
                this.#handles.set(name, handle)
                await this.#put(HANDLES, { name, handle })
            }

            const writable = await handle.createWritable()
            await writable.write(model.getValue())
            await writable.close()

            entry.disk_path = handle.name
            await this.#put(DOCUMENTS, entry)

            if (handle.name !== name) {
                await this.rename(name, handle.name)
            }
        }
    }

    /**
     * Rename a document, updating in-memory, metadata, and handle store
     */
    async rename(oldName: string, newName: string): Promise<void> {
        validateFilename(newName)
        const model = this.#models.get(oldName)
        if (!model) throw new Error(`No document named ${oldName}`)

        this.#models.delete(oldName)
        this.#models.set(newName, model)

        const handle = await this.#get(HANDLES, oldName)
        if (handle) {
            await this.#delete(HANDLES, oldName)
            this.#handles.delete(oldName)
            this.#handles.set(newName, handle)
            await this.#put(HANDLES, { name: newName, handle })
        }

        const entry = (await this.#get(DOCUMENTS, oldName))!
        await this.#delete(DOCUMENTS, oldName)
        entry.name = newName
        await this.#put(DOCUMENTS, entry)

        this.#renamedListeners.forEach(cb => cb(model, model))
    }

    /**
     * Retrieve all persisted documents
     */
    async allDocuments(): Promise<DocumentMeta[]> {
        return await this.#getAll(DOCUMENTS)
    }

    /**
     * Dispose all documents: save, dispose models, and clear state
     */
    async [Symbol.dispose](): Promise<void> {
        const tasks = Array.from(this.#models.entries()).map(([name, model]) =>
            (async () => {
                await this.save(name).catch(e => console.error(`failed saving document ${name}: ${e}`))
                model.dispose()
            })()
        )
        await Promise.allSettled(tasks)

        this.#models.clear()
        this.#handles.clear()
        this.#createdListeners.length = 0
        this.#loadedListeners.length = 0
        this.#renamedListeners.length = 0
    }
}
