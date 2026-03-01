import * as monaco from "monaco-editor"
import { fromEventPattern, Subscription } from "rxjs"
import { bufferTime, debounceTime } from "rxjs/operators"
import { OrderedMap } from "../collections/orderedMap.mjs"
import { SettingsManager } from "../storage/settings.mjs"
import { db, setDocFileBacked } from "../storage/db.mjs"
import type { DocumentRow } from "../storage/db.mjs"
import { __active_bg, __bg_color, __fg_color, __tone_0, __tone_1, __tone_2, __tone_3, __tone_accent } from "../style/style.mjs"
import { DiskConflictDialog } from "./disk-conflict-dialog.mjs"
import { FileConflictDialog } from "./file-conflict-dialog.mjs"
import { UnsavedCloseDialog } from "./unsaved-close-dialog.mjs"
import { YesNoDialog } from "./yesno-dialog.mjs"
import { listGcadFileNames, listGcadFileHandles, readFileContent, saveAsGcad, writeToFile } from "../fs/file-picker.mjs"
import { clearFolderHandle, getFolderHandle, saveFolderHandle } from "../storage/project-storage.mjs"

const LONG_PRESS_MS = 500
const MOVE_THRESHOLD_PX = 5
const DEBOUNCE_SAVE_MS = 1000
const DEBOUNCE_FILE_BACKED_MS = 500

export class DocumentTabs extends HTMLElement {
    #active?: string
    #docs = new OrderedMap<string, monaco.editor.ITextModel>()
    #fileHandles = new Map<string, FileSystemFileHandle>()
    #editor: monaco.editor.IStandaloneCodeEditor
    #subscriptions = new Map<string, Subscription>()
    #tabContainer: HTMLElement
    #topUntitledIndex: number = 0
    #lastWrittenContent = new Map<string, string>()

    #draggingName: string | null = null
    #longPressTimer: ReturnType<typeof setTimeout> | null = null
    #preDragAc: AbortController | null = null
    #dragAc: AbortController | null = null
    #pendingTabName: string | null = null
    #startX = 0
    #startY = 0
    #dropIndex = 0
    #hasDragged = false
    #dropIndicator: HTMLElement
    #dragPlaceholder: HTMLElement | null = null
    #dragOffsetX = 0
    #dragOffsetY = 0
    #dragTabWidth = 0
    #dragTabHeight = 0

    constructor(editor: monaco.editor.IStandaloneCodeEditor) {
        super()
        this.#editor = editor

        this.attachShadow({ mode: "open" })

        const tabHeight = "40px"
        const closeButtonSize = "20px"
        const transitionSpeed = "0.3s"

        const style = document.createElement("style")
        style.textContent = `
            :host {
                display: block;
                ${__fg_color}: whitesmoke;
                ${__tone_0}: #EEE;
                ${__tone_1}: #888;
                ${__tone_2}: #444;
                ${__tone_3}: #666;
                ${__tone_accent}: #007acc;
            }
            button {
                color: var(${__fg_color});
            }
            .tabs-container {
                display: flex;
                flex-wrap: nowrap;
                overflow-x: auto;
                scrollbar-width: none;
                -ms-overflow-style: none;
            }
            .tabs-container::-webkit-scrollbar {
                display: none;
            }
            .tab {
                flex: 0 0 auto;
                align-items: center;
                background-color: var(${__bg_color});
                border: none;
                color: var(${__tone_0});
                cursor: pointer;
                display: flex;
                font-size: medium;
                height: ${tabHeight};
                min-width: calc(1rem + 1rem + ${closeButtonSize} + 0.5rem);
                opacity: 0.8;
                padding: 0 1rem 0 1rem;
                padding-inline-end: calc(0.5rem + ${closeButtonSize} + 0.5rem);
                position: relative;
                transition: all ${transitionSpeed};
                -webkit-touch-callout: none;
                -webkit-user-select: none;
                user-select: none;
            }

            .tab:hover {
                background-color: rgb(from var(${__active_bg}) r g b / 0.5);
                opacity: 1;
                transition: opacity ${transitionSpeed};
                color: var(${__fg_color});
            }
            .tab.active {
                background-color: var(${__active_bg});
                color: var(${__fg_color});
                opacity: 1;
            }
            .tab.active::before {
                background: var(${__tone_accent});
                content: "";
                height: 4px;
                left: 0;
                position: absolute;
                right: 0;
                top: 0;
            }
            .tab:not(.active, :hover)+.tab:not(.active, :hover)::after {
                background: var(${__tone_3});
                bottom: 27%;
                content: "";
                left: 0;
                position: absolute;
                top: 27%;
                width: 1px;
            }
            .close {
                background: none;
                border-radius: 6px;
                border: none;
                color: var(${__tone_1});
                font-size: ${closeButtonSize};
                height: ${closeButtonSize};
                line-height: ${closeButtonSize};
                margin: 0;
                opacity: 1;
                padding: 0;
                position: absolute;
                right: 0.5rem;
                text-align: center;
                transition: all ${transitionSpeed};
                width: ${closeButtonSize};
            }
            .close:hover {
                background: var(${__tone_2});
                color: var(${__fg_color});
            }
            .tab.dragging {
                opacity: 0.9;
                transition: none;
                z-index: 10000;
                pointer-events: none;
                box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            }
            .tab.dragging .close {
                pointer-events: none;
            }
            .drop-indicator {
                align-self: stretch;
                background: var(${__tone_accent});
                flex: 0 0 3px;
                margin: 4px 0;
            }
            .tab-placeholder {
                flex: 0 0 auto;
                pointer-events: none;
            }
            .tab-label.unsaved::after {
                background: #e74c3c;
                border-radius: 50%;
                content: "";
                display: inline-block;
                height: 6px;
                margin-inline-start: 0.25rem;
                vertical-align: middle;
                width: 6px;
            }
        `
        this.shadowRoot!.appendChild(style)

        this.#dropIndicator = document.createElement("div")
        this.#dropIndicator.classList.add("drop-indicator")

        this.#tabContainer = document.createElement("div")
        this.#tabContainer.classList.add("tabs-container")
        this.shadowRoot!.appendChild(this.#tabContainer)

        this.#renderTabs()
    }

    disconnectedCallback() {
        this.#preDragAc?.abort()
        this.#dragAc?.abort()
        for (const sub of this.#subscriptions.values()) {
            sub.unsubscribe()
        }
        this.#subscriptions.clear()
    }

    /** Current active document name (if any) */
    get active(): string | undefined {
        return this.#active
    }

    /** Retrieve a model by filename */
    getByName(name: string): monaco.editor.ITextModel | undefined {
        return this.#docs.get(name)
    }

    /** All documents in insertion order */
    get allDocuments(): Iterable<monaco.editor.ITextModel> {
        return this.#docs.values()
    }

    /** All document names in insertion order */
    get documentNames(): string[] {
        return Array.from(this.#docs.keys())
    }

    /** Whether the given document has a file handle (is backed by disk). */
    hasFileHandle(name: string): boolean {
        return this.#fileHandles.has(name)
    }

    /** Whether the given file-backed document has unsaved changes (content differs from last disk write). */
    isDirty(name: string): boolean {
        if (!this.#fileHandles.has(name)) return false
        const model = this.#docs.get(name)
        const lastWritten = this.#lastWrittenContent.get(name)
        return model !== undefined && lastWritten !== undefined && model.getValue() !== lastWritten
    }

    /** Names of file-backed documents that have unsaved changes. */
    getUnsavedFileBackedNames(): string[] {
        return this.documentNames.filter(n => this.isDirty(n))
    }

    /** Unopened .gcad files in the current folder. Returns null if no folder is tracked. */
    async getUnopenedFolderFiles(): Promise<string[] | null> {
        const dirHandle = await getFolderHandle()
        if (!dirHandle) return null
        const permission = await dirHandle.queryPermission({ mode: "read" })
        if (permission !== "granted") return null
        const allNames = await listGcadFileNames(dirHandle)
        const open = new Set(this.#docs.keys())
        return allNames.filter(name => !open.has(name))
    }

    /** Open a .gcad file from the current folder by name. */
    async openFolderFile(name: string): Promise<void> {
        const dirHandle = await getFolderHandle()
        if (!dirHandle) return
        const fileHandle = await dirHandle.getFileHandle(name)
        await this.addDocumentFromFile(name, "", fileHandle)
    }

    /** Names of all storage-backed documents (not file-backed) that are not currently open as tabs */
    async getClosedDocumentNames(): Promise<string[]> {
        const open = new Set(this.#docs.keys())
        const fileBacked = new Set((await db.docFiles.toArray()).map(r => r.name))
        const all = await db.documents.toArray()
        return all.map(d => d.name).filter(n => !open.has(n) && !fileBacked.has(n))
    }

    /** Resolve file content from disk, merging with IndexedDB when doc is dirty and disk is not newer. */
    async #resolveFileContent(
        name: string,
        handle: FileSystemFileHandle,
        docRow?: DocumentRow
    ): Promise<{ content: string; lastWritten: string; lastSyncWithDisk: number }> {
        const file = await handle.getFile()
        const diskContent = await file.text()
        const diskLastModified = file.lastModified
        const row = docRow ?? (await db.documents.get(name))
        if (!row) {
            return {
                content: diskContent,
                lastWritten: diskContent,
                lastSyncWithDisk: diskLastModified,
            }
        }
        const dirty = row.content !== (row.lastWrittenContent ?? row.content)
        const lastSync = row.lastSyncWithDisk ?? row.lastWriteToDisk
        const diskNewer =
            lastSync != null && lastSync > 0 ? diskLastModified > lastSync : false
        if (!dirty) {
            return {
                content: diskContent,
                lastWritten: diskContent,
                lastSyncWithDisk: diskLastModified,
            }
        }
        if (!diskNewer) {
            return {
                content: row.content,
                lastWritten: row.lastWrittenContent ?? row.content,
                lastSyncWithDisk: row.lastSyncWithDisk ?? diskLastModified,
            }
        }
        const choice = await new DiskConflictDialog(name).show()
        if (choice === "keepEdits") {
            return {
                content: row.content,
                lastWritten: row.lastWrittenContent ?? row.content,
                lastSyncWithDisk: row.lastSyncWithDisk ?? diskLastModified,
            }
        }
        return {
            content: diskContent,
            lastWritten: diskContent,
            lastSyncWithDisk: diskLastModified,
        }
    }

    /** Add a document from file content, optionally with a file handle for disk sync. When handle is provided, resolves content via IndexedDB merge. */
    async addDocumentFromFile(name: string, content: string, handle?: FileSystemFileHandle): Promise<void> {
        if (this.#docs.has(name)) {
            void this.switchTo(name)
            return
        }
        let resolvedContent = content
        let lastWritten = content
        let lastSyncWithDisk: number | undefined
        if (handle) {
            const resolved = await this.#resolveFileContent(name, handle)
            resolvedContent = resolved.content
            lastWritten = resolved.lastWritten
            lastSyncWithDisk = resolved.lastSyncWithDisk
        }
        const uri = monaco.Uri.parse(`inmemory://model/${name}.ts`)
        const model = monaco.editor.createModel(resolvedContent, "typescript", uri)
        this.#docs.set(name, model)
        if (handle) {
            this.#fileHandles.set(name, handle)
            this.#lastWrittenContent.set(name, lastWritten)
            void db.docFiles.put({ name, handle })
            await setDocFileBacked(name, resolvedContent, lastWritten, undefined, lastSyncWithDisk)
        }
        this.#watchModel(name, model)
        void this.switchTo(name)
        void this.#updateStoredOrder()
    }

    /** Open a stored document that is not currently a tab */
    async openStoredDocument(name: string): Promise<void> {
        if (this.#docs.has(name)) {
            await this.switchTo(name)
            return
        }
        const row = await db.documents.get(name)
        if (!row) return
        const uri = monaco.Uri.parse(`inmemory://model/${name}.ts`)
        const model = monaco.editor.createModel(row.content, "typescript", uri)
        this.#docs.set(name, model)
        this.#watchModel(name, model)
        await this.switchTo(name)
        await this.#updateStoredOrder()
    }

    /** Creates a new document, prompting the user for a name. Returns the name, or undefined if user aborts.
     *  When suggestedName is provided and docs.size is 0, uses it without prompting. */
    async newDocument(content = defaultContent, language = "typescript", suggestedName?: string): Promise<string | undefined> {
        this.#topUntitledIndex =
            Array.from(this.#docs.keys())
                .map(s => parseInt(s.match(/^new scene (\d+)$/)?.map((v, i, arr) => arr[i])[1]!) || 0)
                .reduce((p, c) => Math.max(p, c), 0) + 1

        const defaultName = suggestedName ?? `new scene ${this.#topUntitledIndex}`
        const name = this.#docs.size > 0 ? window.prompt("Give the new scene a name", defaultName)?.trim() : defaultName
        if (!name) return undefined

        const uri = monaco.Uri.parse(`inmemory://model/${name}.ts`)
        const model = monaco.editor.createModel(content, "typescript", uri)
        this.#docs.set(name, model)
        this.#watchModel(name, model)
        await this.switchTo(name)
        await this.#updateStoredOrder()
        return name
    }

    /** Load all .gcad files from a directory. Clears current docs. Persists the folder handle for restore on reload. */
    async loadFromFolder(dirHandle: FileSystemDirectoryHandle): Promise<void> {
        for (const name of Array.from(this.#docs.keys())) {
            this.#subscriptions.get(name)?.unsubscribe()
            this.#subscriptions.delete(name)
            this.#fileHandles.delete(name)
            this.#lastWrittenContent.delete(name)
            this.#docs.get(name)?.dispose()
            this.#docs.delete(name)
        }
        this.#active = undefined
        this.#editor.setModel(null!)

        const entries = await listGcadFileHandles(dirHandle)
        for (const { name, handle } of entries) {
            const resolved = await this.#resolveFileContent(name, handle)
            const uri = monaco.Uri.parse(`inmemory://model/${name}.ts`)
            const model = monaco.editor.createModel(resolved.content, "typescript", uri)
            this.#docs.set(name, model)
            this.#fileHandles.set(name, handle)
            this.#lastWrittenContent.set(name, resolved.lastWritten)
            await db.docFiles.put({ name, handle })
            await setDocFileBacked(name, resolved.content, resolved.lastWritten, undefined, resolved.lastSyncWithDisk)
            this.#watchModel(name, model)
        }
        const first = this.#docs.keys().next().value
        if (first) await this.switchTo(first)
        await this.#updateStoredOrder()
        await saveFolderHandle(dirHandle)
    }

    /** Load a single file. Adds to tabs with handle. */
    async loadFromSingleFile(fileHandle: FileSystemFileHandle): Promise<void> {
        const name = fileHandle.name
        await this.addDocumentFromFile(name, "", fileHandle)
    }

    /** Write current content of a file-backed doc to disk. Handles external changes with overwrite/revert/cancel dialog. */
    async saveToDisk(name: string): Promise<boolean> {
        const handle = this.#fileHandles.get(name)
        const model = this.#docs.get(name)
        if (!handle || !model) return false
        const editorContent = model.getValue()
        try {
            const file = await handle.getFile()
            const diskContent = await file.text()
            if (diskContent !== editorContent) {
                const choice = await new FileConflictDialog(name).show()
                if (choice === "cancel") return false
                if (choice === "revert") {
                    model.setValue(diskContent)
                    this.#lastWrittenContent.set(name, diskContent)
                    await setDocFileBacked(name, diskContent, diskContent, undefined, file.lastModified)
                    return true
                }
                // overwrite: fall through to write
            } else {
                return true
            }
        } catch {
            // File may not exist or permission error; proceed with overwrite
        }
        await writeToFile(handle, editorContent)
        this.#lastWrittenContent.set(name, editorContent)
        await setDocFileBacked(name, editorContent, editorContent, Date.now(), Date.now())
        return true
    }

    /** Discard unsaved changes and reload from disk (file-backed) or IndexedDB (storage-backed). Returns true if reverted. */
    async revertTab(name: string): Promise<boolean> {
        const model = this.#docs.get(name)
        if (!model) return false
        let hasChanges = false
        if (this.#fileHandles.has(name)) {
            const lastWritten = this.#lastWrittenContent.get(name)
            hasChanges = lastWritten !== undefined && model.getValue() !== lastWritten
        } else {
            const row = await db.documents.get(name)
            hasChanges = row != null && model.getValue() !== row.content
        }
        if (!hasChanges) return false
        const confirmed = await new YesNoDialog(`Discard unsaved changes to ${name}?`).show()
        if (!confirmed) return false
        if (this.#fileHandles.has(name)) {
            const handle = this.#fileHandles.get(name)!
            const file = await handle.getFile()
            const diskContent = await file.text()
            model.setValue(diskContent)
            this.#lastWrittenContent.set(name, diskContent)
            await setDocFileBacked(name, diskContent, diskContent, undefined, file.lastModified)
        } else {
            const row = await db.documents.get(name)
            if (row) model.setValue(row.content)
        }
        this.#renderTabs()
        return true
    }

    /** Save current doc to a new file. Associates handle and converts to file-backed. Returns true if saved, false if user cancels. */
    async saveAs(name: string): Promise<boolean> {
        const model = this.#docs.get(name)
        if (!model) return false
        const content = model.getValue()
        const handle = await saveAsGcad(name)
        if (!handle) return false
        await writeToFile(handle, content)

        const file = await handle.getFile()
        const newName = file.name

        const oldIndex = Array.from(this.#docs.keys()).indexOf(name)
        const wasActive = this.#active === name

        this.#subscriptions.get(name)?.unsubscribe()
        this.#subscriptions.delete(name)
        this.#fileHandles.delete(name)
        this.#lastWrittenContent.delete(name)
        this.#docs.get(name)?.dispose()
        this.#docs.delete(name)
        await db.documents.delete(name)
        await db.docFiles.delete(name)

        await SettingsManager.instance.renameDocument(name, newName)

        const uri = monaco.Uri.parse(`inmemory://model/${newName}.ts`)
        const newModel = monaco.editor.createModel(content, "typescript", uri)
        this.#docs.set(newName, newModel)
        this.#fileHandles.set(newName, handle)
        this.#lastWrittenContent.set(newName, content)
        await db.docFiles.put({ name: newName, handle })
        await setDocFileBacked(newName, content, content, Date.now(), Date.now())
        this.#watchModel(newName, newModel)

        if (oldIndex >= 0) {
            const newIndex = Array.from(this.#docs.keys()).indexOf(newName)
            this.#docs.moveToIndex(newIndex, oldIndex)
        }

        if (wasActive) {
            this.#active = newName
            await db.preferences.put({ key: "activeDocument", value: newName })
            this.#editor.setModel(newModel)
        }

        await this.#updateStoredOrder()
        this.#renderTabs()
        this.dispatchEvent(new CustomEvent("tabRenamed", { detail: { oldName: name, newName } }))
        this.dispatchEvent(new CustomEvent("activeTabChanged", { detail: this.#active }))
        return true
    }

    /** Restore tabs from persisted folder handle (if any) or storage. Returns true if any docs were loaded. */
    async restore(): Promise<boolean> {
        // clear existing
        for (const name of Array.from(this.#docs.keys())) {
            const sub = this.#subscriptions.get(name)
            if (sub) sub.unsubscribe()
            this.#subscriptions.delete(name)
            this.#fileHandles.delete(name)
            this.#lastWrittenContent.delete(name)
            this.#docs.get(name)?.dispose()
            this.#docs.delete(name)
        }

        const docOrderRow = await db.preferences.get("documentOrder")
        const storedOrder = (docOrderRow?.value as string[] | undefined) ?? []
        const activeRow = await db.preferences.get("activeDocument")
        const lastTab = activeRow?.value as string | undefined

        // try persisted folder handle first
        const dirHandle = await getFolderHandle()
        if (dirHandle) {
            let permission = await dirHandle.queryPermission({ mode: "readwrite" })
            if (permission === "prompt") {
                permission = await dirHandle.requestPermission({ mode: "readwrite" })
            }
            if (permission === "granted") {
                const namesToLoad =
                    storedOrder.length > 0 ? storedOrder : (await listGcadFileNames(dirHandle))
                for (const name of namesToLoad) {
                    try {
                        let fileHandle: FileSystemFileHandle | undefined
                        try {
                            fileHandle = await dirHandle.getFileHandle(name)
                        } catch {
                            const docFileRow = await db.docFiles.get(name)
                            fileHandle = docFileRow?.handle
                        }
                        if (fileHandle) {
                            const docRow = await db.documents.get(name)
                            const resolved = await this.#resolveFileContent(name, fileHandle, docRow)
                            const uri = monaco.Uri.parse(`inmemory://model/${name}.ts`)
                            const model = monaco.editor.createModel(resolved.content, "typescript", uri)
                            this.#docs.set(name, model)
                            this.#fileHandles.set(name, fileHandle)
                            this.#lastWrittenContent.set(name, resolved.lastWritten)
                            await db.docFiles.put({ name, handle: fileHandle })
                            await setDocFileBacked(name, resolved.content, resolved.lastWritten, docRow?.lastWriteToDisk, resolved.lastSyncWithDisk)
                            this.#watchModel(name, model)
                        } else {
                            const docRow = await db.documents.get(name)
                            if (docRow) {
                                const uri = monaco.Uri.parse(`inmemory://model/${name}.ts`)
                                const model = monaco.editor.createModel(docRow.content, "typescript", uri)
                                this.#docs.set(name, model)
                                this.#watchModel(name, model)
                            }
                        }
                    } catch {
                        const docRow = await db.documents.get(name)
                        if (docRow) {
                            const uri = monaco.Uri.parse(`inmemory://model/${name}.ts`)
                            const model = monaco.editor.createModel(docRow.content, "typescript", uri)
                            this.#docs.set(name, model)
                            this.#watchModel(name, model)
                        }
                    }
                }
                const first = this.#docs.keys().next().value
                if (first) await this.switchTo(first)
                await this.#updateStoredOrder()
                if (lastTab && this.#docs.has(lastTab)) await this.switchTo(lastTab)
                return this.#docs.size > 0
            }
            await clearFolderHandle()
        }

        // fall back to stored documents and doc file handles
        for (const name of storedOrder) {
            const docRow = await db.documents.get(name)
            if (docRow) {
                const uri = monaco.Uri.parse(`inmemory://model/${name}.ts`)
                const model = monaco.editor.createModel(docRow.content, "typescript", uri)
                this.#docs.set(name, model)
                this.#watchModel(name, model)
            } else {
                const docFileRow = await db.docFiles.get(name)
                if (docFileRow?.handle) {
                    try {
                        const docRow = await db.documents.get(name)
                        const resolved = await this.#resolveFileContent(name, docFileRow.handle, docRow)
                        const uri = monaco.Uri.parse(`inmemory://model/${name}.ts`)
                        const model = monaco.editor.createModel(resolved.content, "typescript", uri)
                        this.#docs.set(name, model)
                        this.#fileHandles.set(name, docFileRow.handle)
                        this.#lastWrittenContent.set(name, resolved.lastWritten)
                        await setDocFileBacked(name, resolved.content, resolved.lastWritten, docRow?.lastWriteToDisk, resolved.lastSyncWithDisk)
                        this.#watchModel(name, model)
                    } catch {
                        // Handle may be stale (file moved/deleted)
                    }
                }
            }
        }
        if (this.#docs.size > 0) {
            const first = this.#docs.keys().next().value
            if (first) await this.switchTo(first)
            await this.#updateStoredOrder()
            if (lastTab && this.#docs.has(lastTab)) await this.switchTo(lastTab)
            return true
        }
        return false
    }

    /** Observe model changes and save debounced. File-backed docs sync content to IndexedDB; storage-backed docs save to Dexie. */
    #watchModel(name: string, model: monaco.editor.ITextModel) {
        this.#subscriptions.get(name)?.unsubscribe()
        const isFileBacked = this.#fileHandles.has(name)
        const change$ = fromEventPattern<monaco.editor.IModelContentChangedEvent>(
            handler => model.onDidChangeContent(handler),
            (_handler, subscription) => (subscription as monaco.IDisposable).dispose()
        )
        const sub = isFileBacked
            ? change$.pipe(debounceTime(DEBOUNCE_FILE_BACKED_MS)).subscribe(() => {
                  const content = model.getValue()
                  const lastWritten = this.#lastWrittenContent.get(name)
                  void db.documents.update(name, { content, lastWrittenContent: lastWritten })
                  this.#renderTabs()
              })
            : change$.pipe(bufferTime(DEBOUNCE_SAVE_MS)).subscribe(() => {
                  void db.documents.put({ name, content: model.getValue() })
              })
        this.#subscriptions.set(name, sub)
        if (isFileBacked) {
            const content = model.getValue()
            const lastWritten = this.#lastWrittenContent.get(name)
            void db.documents.update(name, { content, lastWrittenContent: lastWritten })
        } else {
            void db.documents.put({ name, content: model.getValue() })
        }
    }

    closeCurrentTab(): Promise<boolean> {
        return this.closeTab(this.#active!)
    }

    /** Close all tabs. Dispatches tabClosed for each. */
    closeAllTabs(): void {
        for (const name of Array.from(this.#docs.keys())) {
            this.#doCloseTab(name)
        }
    }

    /** Close all tabs, or prompt for unsaved file-backed docs. Returns false if user cancels. */
    async closeAllTabsOrPrompt(): Promise<boolean> {
        const unsaved = this.getUnsavedFileBackedNames()
        if (unsaved.length === 0) {
            this.closeAllTabs()
            return true
        }
        const choice = await new UnsavedCloseDialog("batch", undefined, unsaved.length).show()
        if (choice === "cancel") return false
        if (choice === "save") {
            for (const name of unsaved) {
                const saved = await this.saveToDisk(name)
                if (!saved) return false
            }
        }
        this.closeAllTabs()
        return true
    }

    /** Load from folder, or prompt for unsaved file-backed docs first. Returns false if user cancels. */
    async loadFromFolderOrPrompt(dirHandle: FileSystemDirectoryHandle): Promise<boolean> {
        const unsaved = this.getUnsavedFileBackedNames()
        if (unsaved.length === 0) {
            await this.loadFromFolder(dirHandle)
            return true
        }
        const closed = await this.closeAllTabsOrPrompt()
        if (!closed) return false
        await this.loadFromFolder(dirHandle)
        return true
    }

    async closeTab(name: string): Promise<boolean> {
        if (this.#fileHandles.has(name) && this.isDirty(name)) {
            const choice = await new UnsavedCloseDialog("single", name).show()
            if (choice === "cancel") return false
            if (choice === "save") {
                const saved = await this.saveToDisk(name)
                if (!saved) return false
            }
        }
        this.#doCloseTab(name)
        return true
    }

    #doCloseTab(name: string): void {
        const wasActive = name === this.#active
        const sub = this.#subscriptions.get(name)
        if (sub) sub.unsubscribe()
        this.#subscriptions.delete(name)
        this.#fileHandles.delete(name)
        this.#lastWrittenContent.delete(name)
        this.#docs.get(name)?.dispose()
        this.#docs.delete(name)
        this.#renderTabs()
        void this.#updateStoredOrder()
        this.dispatchEvent(new CustomEvent("tabClosed", { detail: name }))
        if (wasActive) {
            const next = this.#docs.keys().next().value
            if (next) void this.switchTo(next)
            else {
                this.#active = undefined
                this.dispatchEvent(new CustomEvent("activeTabChanged", { detail: undefined }))
                this.#editor.setModel(null!)
                this.#renderTabs()
            }
        }
    }

    async deleteCurrentTab(): Promise<void> {
        await this.deleteTab(this.active!)
    }

    async deleteTab(name: string): Promise<void> {
        const cntinue = await new YesNoDialog(`Are you sure you want to delete ${name}?`).show()
        if (cntinue) {
            await db.documents.delete(name)
            await db.docFiles.delete(name)
            await SettingsManager.instance.deleteDocument(name)
            await this.closeTab(name)
        }
    }

    /** Rename the current tab, prompting the user for a new name */
    async renameCurrentTab(): Promise<boolean> {
        if (!this.#active) return false
        return this.renameTab(this.#active)
    }

    /** Duplicate the current tab into a new one, cloning content and settings. Returns the new tab name, or undefined if user cancels. */
    async duplicateCurrentTab(): Promise<string | undefined> {
        if (!this.#active) return undefined

        await SettingsManager.instance.flushDocNow()
        const model = this.#docs.get(this.#active)
        if (!model) return undefined

        const content = model.getValue()
        const settings = await SettingsManager.instance.getDocumentSettings(this.#active)

        const newName = window.prompt("Name for duplicated scene", this.#active)?.trim()
        if (!newName || newName === this.#active) return undefined

        if (this.#docs.has(newName)) {
            alert(`A scene named "${newName}" already exists.`)
            return undefined
        }

        const uri = monaco.Uri.parse(`inmemory://model/${newName}.ts`)
        const newModel = monaco.editor.createModel(content, "typescript", uri)
        this.#docs.set(newName, newModel)
        this.#watchModel(newName, newModel)
        await db.docSettings.put({
            name: newName,
            settings: settings as unknown as Record<string, unknown>,
        })
        await this.#updateStoredOrder()
        await this.switchTo(newName)
        return newName
    }

    /** Rename a tab, prompting the user for a new name */
    async renameTab(oldName: string): Promise<boolean> {
        const model = this.#docs.get(oldName)
        if (!model) return false

        const newName = window.prompt("Enter new name for the scene", oldName)?.trim()
        if (!newName || newName === oldName) return false

        // Check for duplicate names
        if (this.#docs.has(newName)) {
            alert(`A scene named "${newName}" already exists.`)
            return false
        }

        // Update storage: move document content
        const docRow = await db.documents.get(oldName)
        if (docRow) {
            await db.documents.delete(oldName)
            await db.documents.put({
                name: newName,
                content: docRow.content,
                ...(docRow.lastWrittenContent !== undefined && { lastWrittenContent: docRow.lastWrittenContent }),
                ...(docRow.lastWriteToDisk !== undefined && { lastWriteToDisk: docRow.lastWriteToDisk }),
                ...(docRow.lastSyncWithDisk !== undefined && { lastSyncWithDisk: docRow.lastSyncWithDisk }),
            })
        }

        // Move doc file handle if present
        const docFileRow = await db.docFiles.get(oldName)
        if (docFileRow) {
            await db.docFiles.delete(oldName)
            await db.docFiles.put({ name: newName, handle: docFileRow.handle })
        }

        await SettingsManager.instance.renameDocument(oldName, newName)

        // Update the ordered map: need to preserve order
        const entries = Array.from(this.#docs.entries())
        this.#docs.clear()
        for (const [name, m] of entries) {
            if (name === oldName) {
                this.#docs.set(newName, m)
            } else {
                this.#docs.set(name, m)
            }
        }

        // Update subscription key and file handle
        const sub = this.#subscriptions.get(oldName)
        if (sub) {
            this.#subscriptions.delete(oldName)
            this.#subscriptions.set(newName, sub)
        }
        const handle = this.#fileHandles.get(oldName)
        if (handle) {
            this.#fileHandles.delete(oldName)
            this.#fileHandles.set(newName, handle)
        }
        const lastWritten = this.#lastWrittenContent.get(oldName)
        if (lastWritten !== undefined) {
            this.#lastWrittenContent.delete(oldName)
            this.#lastWrittenContent.set(newName, lastWritten)
        }

        // Re-watch model with new name for future saves
        this.#watchModel(newName, model)

        // Update active tab if it was the renamed one
        if (this.#active === oldName) {
            this.#active = newName
            await db.preferences.put({ key: "activeDocument", value: newName })
        }

        await this.#updateStoredOrder()
        this.#renderTabs()
        this.dispatchEvent(new CustomEvent("tabRenamed", { detail: { oldName, newName } }))
        this.dispatchEvent(new CustomEvent("activeTabChanged", { detail: this.#active }))
        return true
    }

    async switchTo(name: string, save = false): Promise<void> {
        const model = this.#docs.get(name)
        if (!model) return
        this.#active = name
        await SettingsManager.instance.switchDocument(name)
        this.#editor.setModel(model)
        this.#renderTabs()
        if (save) {
            await db.preferences.put({ key: "activeDocument", value: this.#active })
        }
        requestAnimationFrame(() => {
            if (this.#active === name) {
                this.dispatchEvent(new CustomEvent("activeTabChanged", { detail: name }))
            }
        })
    }

    /** Update serialized order */
    async #updateStoredOrder(): Promise<void> {
        await db.preferences.put({ key: "documentOrder", value: Array.from(this.#docs.keys()) })
    }

    #renderTabs() {
        this.#tabContainer.innerHTML = ""
        const names = Array.from(this.#docs.keys())
        for (let i = 0; i < names.length; i++) {
            const name = names[i]
            const tab = document.createElement("button")
            tab.setAttribute("data-tab-name", name)
            tab.addEventListener("contextmenu", ev => ev.preventDefault())
            tab.classList.add("tab")
            if (name === this.#active) tab.classList.add("active")
            tab.addEventListener("pointerdown", (e) => this.#onTabPointerDown(e, name))

            const label = document.createElement("span")
            label.classList.add("tab-label")
            label.textContent = name
            if (this.hasFileHandle(name) && this.isDirty(name)) label.classList.add("unsaved")
            tab.appendChild(label)

            const close = document.createElement("button")
            close.classList.add("close")
            close.textContent = "×"
            close.addEventListener("click", async e => {
                e.stopPropagation()
                await this.closeTab(name)
            })
            tab.appendChild(close)
            this.#tabContainer.appendChild(tab)
        }
    }

    #onTabPointerDown = (e: PointerEvent, name: string): void => {
        if ((e.target as HTMLElement).closest(".close")) return
        if (this.#draggingName) return
        if (this.#docs.size <= 1) return

        const tab = (e.target as HTMLElement).closest(".tab") as HTMLElement
        this.#startX = e.clientX
        this.#startY = e.clientY
        this.#hasDragged = false
        this.#dropIndex = Array.from(this.#docs.keys()).indexOf(name)
        this.#pendingTabName = name

        if (e.pointerType === "mouse") {
            tab.setPointerCapture(e.pointerId)
            this.#startDrag(tab, name, e.pointerId)
        } else {
            this.#preDragAc = new AbortController()
            const { signal } = this.#preDragAc
            this.#longPressTimer = setTimeout(() => {
                this.#longPressTimer = null
                tab.setPointerCapture(e.pointerId)
                this.#startDrag(tab, name, e.pointerId)
            }, LONG_PRESS_MS)
            document.addEventListener("pointermove", this.#onPreDragPointerMove, { signal })
            document.addEventListener("pointerup", this.#onPreDragPointerUp, { signal })
            document.addEventListener("pointercancel", this.#onPreDragPointerUp, { signal })
        }
    }

    #clearPreDragTimers = (): void => {
        if (this.#longPressTimer !== null) {
            clearTimeout(this.#longPressTimer)
            this.#longPressTimer = null
        }
        this.#preDragAc?.abort()
        this.#preDragAc = null
    }

    #onPreDragPointerMove = (e: PointerEvent): void => {
        if (this.#longPressTimer === null) return
        const dx = e.clientX - this.#startX
        const dy = e.clientY - this.#startY
        if (Math.hypot(dx, dy) > MOVE_THRESHOLD_PX) {
            this.#clearPreDragTimers()
        }
    }

    #onPreDragPointerUp = (): void => {
        if (this.#longPressTimer === null) return
        this.#clearPreDragTimers()
        const name = this.#pendingTabName
        this.#pendingTabName = null
        if (name) this.switchTo(name, true)
    }

    #startDrag(tab: HTMLElement, name: string, pointerId: number): void {
        this.#clearPreDragTimers()
        this.#dragAc?.abort()
        this.#dragAc = new AbortController()
        const { signal } = this.#dragAc
        this.#draggingName = name
        navigator.vibrate?.(10)
        tab.classList.add("dragging")
        const rect = tab.getBoundingClientRect()
        this.#dragOffsetX = this.#startX - rect.left
        this.#dragOffsetY = this.#startY - rect.top
        this.#dragTabWidth = rect.width
        this.#dragTabHeight = rect.height
        this.#dragPlaceholder = document.createElement("div")
        this.#dragPlaceholder.classList.add("tab-placeholder")
        this.#dragPlaceholder.style.width = `${rect.width}px`
        this.#dragPlaceholder.style.height = `${rect.height}px`
        this.#tabContainer.insertBefore(this.#dragPlaceholder, tab)
        this.#updateDragPosition(this.#startX, this.#startY)
        document.addEventListener("pointermove", this.#onDragPointerMove, { signal })
        document.addEventListener("pointerup", this.#onDragPointerUp, { signal })
        document.addEventListener("pointercancel", this.#onDragPointerUp, { signal })
        this.#updateDropIndicator()
    }

    #updateDragPosition(clientX: number, clientY: number): void {
        const tab = this.#tabContainer.querySelector<HTMLElement>(`[data-tab-name="${this.#draggingName!}"]`)
        if (!tab) return
        tab.style.position = "fixed"
        tab.style.left = `${clientX - this.#dragOffsetX}px`
        tab.style.top = `${clientY - this.#dragOffsetY}px`
        tab.style.width = `${this.#dragTabWidth}px`
        tab.style.minWidth = `${this.#dragTabWidth}px`
        tab.style.height = `${this.#dragTabHeight}px`
    }

    #clearDragPosition(): void {
        const tab = this.#tabContainer.querySelector<HTMLElement>(`[data-tab-name="${this.#draggingName!}"]`)
        if (tab) {
            tab.style.position = ""
            tab.style.left = ""
            tab.style.top = ""
            tab.style.width = ""
            tab.style.minWidth = ""
            tab.style.height = ""
        }
    }

    #onDragPointerMove = (e: PointerEvent): void => {
        if (!this.#draggingName) return
        this.#hasDragged = this.#hasDragged || Math.hypot(e.clientX - this.#startX, e.clientY - this.#startY) > MOVE_THRESHOLD_PX
        this.#updateDragPosition(e.clientX, e.clientY)
        this.#dropIndex = this.#computeDropIndex(e.clientX, e.clientY)
        this.#updateDropIndicator()
    }

    #computeDropIndex(clientX: number, clientY: number): number {
        const rect = this.#tabContainer.getBoundingClientRect()
        if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
            return -1
        }
        const tabs = Array.from(this.#tabContainer.querySelectorAll<HTMLElement>(".tab"))
        const draggingName = this.#draggingName
        for (let i = 0; i < tabs.length; i++) {
            const tab = tabs[i]
            if (draggingName && tab.getAttribute("data-tab-name") === draggingName) continue
            const tabRect = tab.getBoundingClientRect()
            if (clientY < tabRect.top || clientY > tabRect.bottom) continue
            if (clientX < tabRect.left || clientX > tabRect.right) continue
            const midX = tabRect.left + tabRect.width / 2
            return clientX < midX ? i : i + 1
        }
        return -1
    }

    #updateDropIndicator(): void {
        if (!this.#hasDragged || this.#dropIndex < 0) {
            this.#dropIndicator.remove()
            return
        }
        const fromIndex = this.#draggingName ? Array.from(this.#docs.keys()).indexOf(this.#draggingName) : -1
        if (fromIndex >= 0 && (this.#dropIndex === fromIndex || this.#dropIndex === fromIndex + 1)) {
            this.#dropIndicator.remove()
            return
        }
        const tabs = Array.from(this.#tabContainer.querySelectorAll(".tab"))
        const insertAt = Math.min(this.#dropIndex, tabs.length)
        const target = tabs[insertAt]
        if (target) {
            this.#tabContainer.insertBefore(this.#dropIndicator, target)
        } else {
            this.#tabContainer.appendChild(this.#dropIndicator)
        }
    }

    #onDragPointerUp = (e: PointerEvent): void => {
        if (!this.#draggingName) return
        const name = this.#draggingName
        const tab = this.#tabContainer.querySelector(`[data-tab-name="${name}"]`)
        const releaseDropIndex = this.#computeDropIndex(e.clientX, e.clientY)
        this.#dragAc?.abort()
        this.#dragAc = null
        this.#dropIndicator.remove()
        this.#dragPlaceholder?.remove()
        this.#dragPlaceholder = null
        this.#clearDragPosition()
        tab?.classList.remove("dragging")
        this.#draggingName = null

        if (this.#hasDragged) {
            if (releaseDropIndex >= 0) {
                const fromIndex = Array.from(this.#docs.keys()).indexOf(name)
                const toIndex = Math.min(releaseDropIndex, this.#docs.size)
                if (fromIndex !== -1 && fromIndex !== toIndex) {
                    this.#docs.moveToIndex(fromIndex, toIndex)
                    void this.#updateStoredOrder()
                }
            }
        } else {
            void this.switchTo(name, true)
        }
        this.#renderTabs()
    }

}

customElements.define("document-tabs", DocumentTabs)

declare global {
    interface HTMLElementTagNameMap {
        "document-tabs": DocumentTabs
    }
}

const defaultContent = `// Stealth Fighter
// A twin-engine strike aircraft with canted tails

// ═══ FUSELAGE ═══
// Three overlapping boxes blended into a smooth organic hull
const body = box([3, 15, 2])
const nose = box([2, 8, 1.5]).shift([0, 12, 0.3])
const aft  = box([4.5, 8, 2.2]).shift([0, -8, -0.2])
const fuselage = union(body, nose, aft).round(4)

// Chisel the belly flat for a stealth cross-section
const bellySlice = plane.normal([0, 0, 1]).shift([0, 0, -1])
const hull = subtract(fuselage, bellySlice).round(0.3)

// ═══ COCKPIT ═══
// Canopy dome clipped to sit flush on the spine
const canopyBubble = sphere.radius(2.5).shift([0, 6, 2.5])
const canopyFloor  = plane.normal([0, 0, 1]).shift([0, 0, 1.8])
const cockpit = subtract(canopyBubble, canopyFloor)

// ═══ WINGS ═══
// Swept delta wings with slight anhedral
const wingR = rotate([0, 0, -2], box([8, 6, 0.35]).shift([10, -2, -0.3]))
const wingL = rotate([0, 0, 2], box([8, 6, 0.35]).shift([-10, -2, -0.3]))

// ═══ TAIL ═══
// Canted twin vertical stabilisers
const vStabR = rotate([0, 22, 0], box([0.2, 3.5, 2.5]).shift([2, -15, 3]))
const vStabL = rotate([0, -22, 0], box([0.2, 3.5, 2.5]).shift([-2, -15, 3]))

// All-moving horizontal stabilisers
const hStabR = rotate([3, 0, -2], box([3.5, 2.5, 0.2]).shift([5, -14, -0.2]))
const hStabL = rotate([-3, 0, 2], box([3.5, 2.5, 0.2]).shift([-5, -14, -0.2]))

// ═══ ENGINES ═══
// Twin exhaust nozzles recessed in the aft body
const nozzleR = cylinder.radius(1.2).height(2).shift([2, -17, 0])
const nozzleL = cylinder.radius(1.2).height(2).shift([-2, -17, 0])

// ═══ INTAKES ═══
// Subtractive intake ducts on the lower fuselage sides
const intakeR = box([1, 3, 1.2]).shift([3.5, 3, -0.5])
const intakeL = box([1, 3, 1.2]).shift([-3.5, 3, -0.5])

// ═══ ASSEMBLY ═══
// Generous blend radii make the wings flow into the body
const airframe = union(hull, cockpit, wingR, wingL).round(2.5)
const tail = union(vStabR, vStabL, hStabR, hStabL).round(1)
const engines = union(nozzleR, nozzleL).round(0.8)

const aircraft = union(airframe, tail, engines).round(1.5)
return subtract(aircraft, intakeR, intakeL).round(0.5)
`
