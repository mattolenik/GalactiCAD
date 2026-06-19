/**
 * Dexie database for GalactiCAD storage.
 * Replaces localStorage and raw IndexedDB with a unified schema.
 */

import Dexie, { type EntityTable } from "dexie"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DocumentRow {
    name: string
    content: string
    /** Last content written to disk (file-backed only) */
    lastWrittenContent?: string
    /** Timestamp of last disk write (file-backed only) */
    lastWriteToDisk?: number
    /** Last known time disk and DB copy were the same (file-backed only) */
    lastSyncWithDisk?: number
    /**
     * Serialized CodeMirror EditorState (text + selection + undo/redo history),
     * so the per-tab undo stack survives a page reload. Restored only when its
     * `doc` still matches `content` (else discarded — see DocumentTabs).
     * Non-indexed, so adding it needs no Dexie version bump.
     */
    editorState?: unknown
}

export interface DocSettingsRow {
    name: string
    settings: Record<string, unknown>
}

export interface DocFileRow {
    name: string
    handle: FileSystemFileHandle
}

export interface PreferenceRow {
    key: string
    value: unknown
}

export interface ProjectRow {
    key: string
    value: unknown
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

class GalactiCADDB extends Dexie {
    documents!: EntityTable<DocumentRow, "name">
    docSettings!: EntityTable<DocSettingsRow, "name">
    docFiles!: EntityTable<DocFileRow, "name">
    preferences!: EntityTable<PreferenceRow, "key">
    project!: EntityTable<ProjectRow, "key">

    constructor() {
        super("galacticad")
        this.version(1).stores({
            documents: "name",
            docSettings: "name",
            docFiles: "name",
            preferences: "key",
            project: "key",
        })
    }
}

export const db = new GalactiCADDB()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export async function getPref<K extends string>(key: K): Promise<PreferenceRow["value"]> {
    const row = await db.preferences.get(key)
    return row?.value
}

export async function setPref(key: string, value: unknown): Promise<void> {
    await db.preferences.put({ key, value })
}

export async function getDoc(name: string): Promise<DocumentRow | undefined> {
    return db.documents.get(name)
}

export async function setDoc(name: string, content: string): Promise<void> {
    await db.documents.put({ name, content })
}

export async function deleteDoc(name: string): Promise<void> {
    await db.documents.delete(name)
}

export async function setDocFileBacked(
    name: string,
    content: string,
    lastWrittenContent: string,
    lastWriteToDisk?: number,
    lastSyncWithDisk?: number
): Promise<void> {
    // Preserve any persisted editorState (undo history) across this full-row put —
    // the debounced persister is its only writer, and this put would otherwise drop it.
    const existing = await db.documents.get(name)
    await db.documents.put({
        name,
        content,
        lastWrittenContent,
        lastWriteToDisk,
        lastSyncWithDisk,
        ...(existing?.editorState !== undefined ? { editorState: existing.editorState } : {}),
    })
}

export async function getDocFileBacked(name: string): Promise<DocumentRow | undefined> {
    return db.documents.get(name)
}

export async function getDocSettings(name: string): Promise<DocSettingsRow | undefined> {
    return db.docSettings.get(name)
}

export async function setDocSettings(name: string, settings: Record<string, unknown>): Promise<void> {
    await db.docSettings.put({ name, settings })
}

export async function deleteDocSettings(name: string): Promise<void> {
    await db.docSettings.delete(name)
}

export async function getDocFile(name: string): Promise<DocFileRow | undefined> {
    return db.docFiles.get(name)
}

export async function setDocFile(name: string, handle: FileSystemFileHandle): Promise<void> {
    await db.docFiles.put({ name, handle })
}

export async function deleteDocFile(name: string): Promise<void> {
    await db.docFiles.delete(name)
}

export async function getProjectValue(key: string): Promise<unknown> {
    const row = await db.project.get(key)
    return row?.value
}

export async function setProjectValue(key: string, value: unknown): Promise<void> {
    await db.project.put({ key, value })
}

export async function deleteProjectValue(key: string): Promise<void> {
    await db.project.delete(key)
}

// ---------------------------------------------------------------------------
// Recent documents (max 10)
// ---------------------------------------------------------------------------

const RECENT_DOCS_KEY = "recentDocuments"
const RECENT_DOCS_MAX = 10

export async function getRecentDocuments(): Promise<string[]> {
    const row = await db.preferences.get(RECENT_DOCS_KEY)
    const arr = row?.value
    return Array.isArray(arr) ? arr.filter((v): v is string => typeof v === "string") : []
}

export async function addRecentDocument(name: string): Promise<void> {
    const current = await getRecentDocuments()
    const filtered = current.filter((n) => n !== name)
    const next = [name, ...filtered].slice(0, RECENT_DOCS_MAX)
    await db.preferences.put({ key: RECENT_DOCS_KEY, value: next })
}

export async function clearRecentDocuments(): Promise<void> {
    await db.preferences.put({ key: RECENT_DOCS_KEY, value: [] })
}
