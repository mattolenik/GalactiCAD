/**
 * Persists the current project folder handle in IndexedDB.
 * FileSystemHandle cannot be stored in localStorage (not JSON-serializable).
 */

const DB_NAME = "galacticad"
const DB_VERSION = 1
const STORE_NAME = "project"
const FOLDER_HANDLE_KEY = "folderHandle"

function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION)
        req.onerror = () => reject(req.error)
        req.onsuccess = () => resolve(req.result)
        req.onupgradeneeded = (e) => {
            const db = (e.target as IDBOpenDBRequest).result
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME)
            }
        }
    })
}

export async function saveFolderHandle(handle: FileSystemDirectoryHandle): Promise<void> {
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite")
        const store = tx.objectStore(STORE_NAME)
        const req = store.put(handle, FOLDER_HANDLE_KEY)
        req.onerror = () => reject(req.error)
        req.onsuccess = () => resolve()
        tx.oncomplete = () => db.close()
    })
}

export async function getFolderHandle(): Promise<FileSystemDirectoryHandle | null> {
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly")
        const store = tx.objectStore(STORE_NAME)
        const req = store.get(FOLDER_HANDLE_KEY)
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
            const handle = req.result as FileSystemDirectoryHandle | undefined
            resolve(handle ?? null)
        }
        tx.oncomplete = () => db.close()
    })
}

export async function clearFolderHandle(): Promise<void> {
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite")
        const store = tx.objectStore(STORE_NAME)
        const req = store.delete(FOLDER_HANDLE_KEY)
        req.onerror = () => reject(req.error)
        req.onsuccess = () => resolve()
        tx.oncomplete = () => db.close()
    })
}
