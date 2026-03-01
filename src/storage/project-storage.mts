/**
 * Persists the current project folder handle in Dexie.
 * FileSystemHandle cannot be stored in localStorage (not JSON-serializable).
 */

import { db } from "./db.mjs"

const FOLDER_HANDLE_KEY = "folderHandle"

export async function saveFolderHandle(handle: FileSystemDirectoryHandle): Promise<void> {
    await db.project.put({ key: FOLDER_HANDLE_KEY, value: handle })
}

export async function getFolderHandle(): Promise<FileSystemDirectoryHandle | null> {
    const row = await db.project.get(FOLDER_HANDLE_KEY)
    const handle = row?.value as FileSystemDirectoryHandle | undefined
    return handle ?? null
}

export async function clearFolderHandle(): Promise<void> {
    await db.project.delete(FOLDER_HANDLE_KEY)
}
