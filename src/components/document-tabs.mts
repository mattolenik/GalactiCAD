import { Subject, Subscription } from "rxjs"
import { debounceTime, filter } from "rxjs/operators"
import type { EditorState } from "@codemirror/state"
import type { CodeEditor } from "../editor/codemirror-editor.mjs"
import { OrderedMap } from "../collections/orderedMap.mjs"
import { SettingsManager } from "../storage/settings.mjs"
import { addRecentDocument, db, setDocFileBacked } from "../storage/db.mjs"
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
    #docs = new OrderedMap<string, EditorState>()
    #fileHandles = new Map<string, FileSystemFileHandle>()
    #editor: CodeEditor
    /** Per-doc change events fan in here (keyed by name) to drive debounced persistence. */
    #change$ = new Subject<string>()
    #persistSubs: Subscription[] = []
    #editorUnsubscribe: (() => void) | null = null
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

    constructor(editor: CodeEditor) {
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
        this.#tabContainer.addEventListener("wheel", this.#onWheel, { passive: false })
        this.shadowRoot!.appendChild(this.#tabContainer)

        this.#renderTabs()

        // A single update listener drives persistence and cursor-save. Content changes
        // keep the active doc's stored state in sync and fan into debounced persistence;
        // selection changes persist the cursor/selection to SettingsManager.
        this.#editorUnsubscribe = editor.onUpdate(u => {
            if (!this.#active) return
            if (u.docChanged) {
                this.#docs.set(this.#active, u.state)
                this.#change$.next(this.#active)
            }
            if (u.selectionSet) {
                const cur = editor.getSelectionLineCol()
                if (cur) SettingsManager.instance.setCursorAndSelection(cur.pos, cur.sel)
            }
        })

        // File-backed docs persist to IndexedDB; storage-backed docs save to Dexie.
        // Branch on the current file-backed status at emit time (it can change via saveAs).
        this.#persistSubs.push(
            this.#change$
                .pipe(filter(name => this.#fileHandles.has(name)), debounceTime(DEBOUNCE_FILE_BACKED_MS))
                .subscribe(name => this.#persistFileBacked(name)),
            this.#change$
                .pipe(filter(name => !this.#fileHandles.has(name)), debounceTime(DEBOUNCE_SAVE_MS))
                .subscribe(name => this.#persistStorage(name)),
        )
    }

    disconnectedCallback() {
        this.#preDragAc?.abort()
        this.#dragAc?.abort()
        this.#editorUnsubscribe?.()
        this.#editorUnsubscribe = null
        for (const sub of this.#persistSubs) sub.unsubscribe()
        this.#persistSubs = []
    }

    /** Current active document name (if any) */
    get active(): string | undefined {
        return this.#active
    }

    /** Retrieve a document's editor state by filename */
    getByName(name: string): EditorState | undefined {
        return this.#docs.get(name)
    }

    /** All document states in insertion order */
    get allDocuments(): Iterable<EditorState> {
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
        const state = this.#docs.get(name)
        const lastWritten = this.#lastWrittenContent.get(name)
        return state !== undefined && lastWritten !== undefined && state.doc.toString() !== lastWritten
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
        this.#docs.set(name, this.#editor.createState(resolvedContent))
        if (handle) {
            this.#fileHandles.set(name, handle)
            this.#lastWrittenContent.set(name, lastWritten)
            void db.docFiles.put({ name, handle })
            await setDocFileBacked(name, resolvedContent, lastWritten, undefined, lastSyncWithDisk)
        }
        this.#registerDoc(name)
        void this.switchTo(name)
        void this.#updateStoredOrder()
    }

    /** Open a document by name (storage-backed or file-backed). Returns true if opened. */
    async openDocument(name: string): Promise<boolean> {
        if (this.#docs.has(name)) {
            await this.switchTo(name)
            return true
        }
        const docFileRow = await db.docFiles.get(name)
        if (docFileRow?.handle) {
            try {
                await this.addDocumentFromFile(name, "", docFileRow.handle)
                return true
            } catch {
                // Handle may be stale (file moved/deleted, permission revoked)
                return false
            }
        }
        const docRow = await db.documents.get(name)
        if (docRow) {
            await this.openStoredDocument(name)
            return true
        }
        return false
    }

    /** Open a stored document that is not currently a tab */
    async openStoredDocument(name: string): Promise<void> {
        if (this.#docs.has(name)) {
            await this.switchTo(name)
            return
        }
        const row = await db.documents.get(name)
        if (!row) return
        this.#docs.set(name, this.#editor.createState(row.content))
        this.#registerDoc(name)
        await this.switchTo(name)
        await this.#updateStoredOrder()
    }

    /** Creates a new document, prompting the user for a name. Returns the name, or undefined if user aborts.
     *  When suggestedName is provided and docs.size is 0, uses it without prompting.
     *  Pass { prompt: false } to skip the prompt entirely and use suggestedName (deduped on collision). */
    async newDocument(
        content = defaultContent,
        language = "typescript",
        suggestedName?: string,
        options?: { prompt?: boolean },
    ): Promise<string | undefined> {
        this.#topUntitledIndex =
            Array.from(this.#docs.keys())
                .map(s => parseInt(s.match(/^new scene (\d+)$/)?.map((v, i, arr) => arr[i])[1]!) || 0)
                .reduce((p, c) => Math.max(p, c), 0) + 1

        const defaultName = suggestedName ?? `new scene ${this.#topUntitledIndex}`
        const name = options?.prompt === false
            ? this.#uniqueDocName(defaultName)
            : this.#docs.size > 0
            ? window.prompt("Give the new scene a name", defaultName)?.trim()
            : defaultName
        if (!name) return undefined

        this.#docs.set(name, this.#editor.createState(content))
        this.#registerDoc(name)
        await this.switchTo(name)
        await this.#updateStoredOrder()
        return name
    }

    /** Return name if free, else append " 2", " 3", … until unique among open documents. */
    #uniqueDocName(base: string): string {
        if (!this.#docs.has(base)) return base
        for (let i = 2;; i++) {
            const candidate = `${base} ${i}`
            if (!this.#docs.has(candidate)) return candidate
        }
    }

    /** Load all .gcad files from a directory. Clears current docs. Persists the folder handle for restore on reload. */
    async loadFromFolder(dirHandle: FileSystemDirectoryHandle): Promise<void> {
        for (const name of Array.from(this.#docs.keys())) {
            this.#fileHandles.delete(name)
            this.#lastWrittenContent.delete(name)
            this.#docs.delete(name)
        }
        this.#active = undefined
        this.#editor.clear()

        const entries = await listGcadFileHandles(dirHandle)
        for (const { name, handle } of entries) {
            const resolved = await this.#resolveFileContent(name, handle)
            this.#docs.set(name, this.#editor.createState(resolved.content))
            this.#fileHandles.set(name, handle)
            this.#lastWrittenContent.set(name, resolved.lastWritten)
            await db.docFiles.put({ name, handle })
            await setDocFileBacked(name, resolved.content, resolved.lastWritten, undefined, resolved.lastSyncWithDisk)
            this.#registerDoc(name)
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
        const state = this.#docs.get(name)
        if (!handle || !state) return false
        const editorContent = state.doc.toString()
        try {
            const file = await handle.getFile()
            const diskContent = await file.text()
            const lastWritten = this.#lastWrittenContent.get(name)
            // Only show conflict when disk was modified externally (differs from our last write or load).
            // If disk === lastWritten, user just has unsaved edits—we write normally.
            if (lastWritten !== undefined && diskContent !== lastWritten) {
                const choice = await new FileConflictDialog(name).show()
                if (choice === "cancel") return false
                if (choice === "revert") {
                    this.#setDocText(name, diskContent)
                    this.#lastWrittenContent.set(name, diskContent)
                    await setDocFileBacked(name, diskContent, diskContent, undefined, file.lastModified)
                    this.#renderTabs()
                    return true
                }
                // overwrite: fall through to write
            } else if (editorContent === diskContent) {
                this.#lastWrittenContent.set(name, editorContent)
                this.#renderTabs()
                return true // nothing to save
            }
            // else: disk === lastWritten, user has edits—fall through to write
        } catch {
            // File may not exist or permission error; proceed with overwrite
        }
        await writeToFile(handle, editorContent)
        this.#lastWrittenContent.set(name, editorContent)
        await setDocFileBacked(name, editorContent, editorContent, Date.now(), Date.now())
        this.#renderTabs()
        return true
    }

    /** Discard unsaved changes and reload from disk (file-backed) or IndexedDB (storage-backed). Returns true if reverted. */
    async revertTab(name: string): Promise<boolean> {
        const state = this.#docs.get(name)
        if (!state) return false
        let hasChanges = false
        if (this.#fileHandles.has(name)) {
            const lastWritten = this.#lastWrittenContent.get(name)
            hasChanges = lastWritten !== undefined && state.doc.toString() !== lastWritten
        } else {
            const row = await db.documents.get(name)
            hasChanges = row != null && state.doc.toString() !== row.content
        }
        if (!hasChanges) return false
        const confirmed = await new YesNoDialog(`Discard unsaved changes to ${name}?`).show()
        if (!confirmed) return false
        if (this.#fileHandles.has(name)) {
            const handle = this.#fileHandles.get(name)!
            const file = await handle.getFile()
            const diskContent = await file.text()
            this.#setDocText(name, diskContent)
            this.#lastWrittenContent.set(name, diskContent)
            await setDocFileBacked(name, diskContent, diskContent, undefined, file.lastModified)
        } else {
            const row = await db.documents.get(name)
            if (row) this.#setDocText(name, row.content)
        }
        this.#renderTabs()
        return true
    }

    /** Save current doc to a new file. Associates handle and converts to file-backed. Returns true if saved, false if user cancels. */
    async saveAs(name: string): Promise<boolean> {
        const state = this.#docs.get(name)
        if (!state) return false
        const content = state.doc.toString()
        const handle = await saveAsGcad(name)
        if (!handle) return false
        await writeToFile(handle, content)

        const file = await handle.getFile()
        const newName = file.name

        const oldIndex = Array.from(this.#docs.keys()).indexOf(name)
        const wasActive = this.#active === name

        this.#fileHandles.delete(name)
        this.#lastWrittenContent.delete(name)
        this.#docs.delete(name)
        await db.documents.delete(name)
        await db.docFiles.delete(name)

        await SettingsManager.instance.renameDocument(name, newName)

        const newState = this.#editor.createState(content)
        this.#docs.set(newName, newState)
        this.#fileHandles.set(newName, handle)
        this.#lastWrittenContent.set(newName, content)
        await db.docFiles.put({ name: newName, handle })
        await setDocFileBacked(newName, content, content, Date.now(), Date.now())
        this.#registerDoc(newName)

        if (oldIndex >= 0) {
            const newIndex = Array.from(this.#docs.keys()).indexOf(newName)
            this.#docs.moveToIndex(newIndex, oldIndex)
        }

        if (wasActive) {
            this.#active = newName
            await db.preferences.put({ key: "activeDocument", value: newName })
            this.#editor.setState(newState)
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
            this.#fileHandles.delete(name)
            this.#lastWrittenContent.delete(name)
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
                try {
                    permission = await dirHandle.requestPermission({ mode: "readwrite" })
                } catch {
                    permission = "denied"
                }
            }
            if (permission !== "granted") return false
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
                        this.#docs.set(name, this.#editor.createState(resolved.content))
                        this.#fileHandles.set(name, fileHandle)
                        this.#lastWrittenContent.set(name, resolved.lastWritten)
                        await db.docFiles.put({ name, handle: fileHandle })
                        await setDocFileBacked(name, resolved.content, resolved.lastWritten, docRow?.lastWriteToDisk, resolved.lastSyncWithDisk)
                        this.#registerDoc(name)
                    } else {
                        const docRow = await db.documents.get(name)
                        if (docRow) {
                            this.#docs.set(name, this.#editor.createState(docRow.content))
                            this.#registerDoc(name)
                        }
                    }
                } catch {
                    const docRow = await db.documents.get(name)
                    if (docRow) {
                        this.#docs.set(name, this.#editor.createState(docRow.content))
                        this.#registerDoc(name)
                    }
                }
            }
            const first = this.#docs.keys().next().value
            if (first) await this.switchTo(first)
            await this.#updateStoredOrder()
            if (lastTab && this.#docs.has(lastTab)) await this.switchTo(lastTab)
            return this.#docs.size > 0
        }

        // fall back to stored documents and doc file handles
        for (const name of storedOrder) {
            const docRow = await db.documents.get(name)
            if (docRow) {
                this.#docs.set(name, this.#editor.createState(docRow.content))
                this.#registerDoc(name)
            } else {
                const docFileRow = await db.docFiles.get(name)
                if (docFileRow?.handle) {
                    try {
                        const docRow = await db.documents.get(name)
                        const resolved = await this.#resolveFileContent(name, docFileRow.handle, docRow)
                        this.#docs.set(name, this.#editor.createState(resolved.content))
                        this.#fileHandles.set(name, docFileRow.handle)
                        this.#lastWrittenContent.set(name, resolved.lastWritten)
                        await setDocFileBacked(name, resolved.content, resolved.lastWritten, docRow?.lastWriteToDisk, resolved.lastSyncWithDisk)
                        this.#registerDoc(name)
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
    /** Persist a freshly-added/opened doc immediately so it lands in storage even without edits. */
    #registerDoc(name: string): void {
        if (this.#fileHandles.has(name)) this.#persistFileBacked(name)
        else this.#persistStorage(name)
    }

    /** Replace a document's full text (revert / external reload), whether active or not. */
    #setDocText(name: string, text: string): void {
        if (name === this.#active) {
            this.#editor.setValue(text)
            this.#docs.set(name, this.#editor.view.state)
        } else {
            this.#docs.set(name, this.#editor.createState(text))
        }
    }

    #persistFileBacked(name: string): void {
        const content = this.#docs.get(name)?.doc.toString()
        if (content === undefined) return
        const lastWritten = this.#lastWrittenContent.get(name)
        void db.documents.update(name, { content, lastWrittenContent: lastWritten })
        this.#renderTabs()
    }

    #persistStorage(name: string): void {
        const content = this.#docs.get(name)?.doc.toString()
        if (content === undefined) return
        void db.documents.put({ name, content })
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
        this.#fileHandles.delete(name)
        this.#lastWrittenContent.delete(name)
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
                this.#editor.clear()
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
        const state = this.#docs.get(this.#active)
        if (!state) return undefined

        const content = state.doc.toString()
        const settings = await SettingsManager.instance.getDocumentSettings(this.#active)

        const newName = window.prompt("Name for duplicated scene", this.#active)?.trim()
        if (!newName || newName === this.#active) return undefined

        if (this.#docs.has(newName)) {
            alert(`A scene named "${newName}" already exists.`)
            return undefined
        }

        this.#docs.set(newName, this.#editor.createState(content))
        this.#registerDoc(newName)
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
        const state = this.#docs.get(oldName)
        if (!state) return false

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

        // Move file handle and dirty-tracking to the new name.
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
        const state = this.#docs.get(name)
        if (!state) return

        // Save the outgoing doc's cursor/selection before switching (in-memory; switchDocument flushes).
        if (this.#active && this.#active !== name) {
            const cur = this.#editor.getSelectionLineCol()
            if (cur) SettingsManager.instance.setCursorAndSelection(cur.pos, cur.sel)
        }

        this.#active = name
        await SettingsManager.instance.switchDocument(name)
        this.#editor.setState(state)

        // Restore selection for the new doc (CodeEditor clamps to the valid range).
        const s = SettingsManager.instance.getSelection()
        this.#editor.setSelectionLineCol(s)
        this.#editor.revealLineCenterIfOutside(s.endLine)

        this.#renderTabs()
        if (save) {
            await db.preferences.put({ key: "activeDocument", value: this.#active })
        }
        void addRecentDocument(name)
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
            tab.addEventListener("auxclick", (e) => {
                if (e.button === 1) {
                    e.preventDefault()
                    e.stopPropagation()
                    void this.closeTab(name)
                }
            })

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

    #onWheel = (e: WheelEvent): void => {
        const el = this.#tabContainer
        const canScrollLeft = el.scrollLeft > 0
        const canScrollRight = el.scrollLeft < el.scrollWidth - el.clientWidth
        if (!canScrollLeft && !canScrollRight) return
        const dy = e.deltaY
        if (dy === 0) return
        el.scrollLeft += dy
        e.preventDefault()
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
