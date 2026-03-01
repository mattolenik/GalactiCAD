/**
 * File System Access API helpers for opening/saving .gcad files and folders.
 * Requires secure context (HTTPS) and user activation.
 */

export interface GcadFileResult {
    handle: FileSystemFileHandle
    content: string
    name: string
}

export interface GcadFileEntry {
    name: string
    handle: FileSystemFileHandle
    content: string
}

/** Check if the File System Access API is available (secure context, feature support). */
export function isFileSystemAccessAvailable(): boolean {
    return typeof window !== "undefined" && "showOpenFilePicker" in window && "showSaveFilePicker" in window && "showDirectoryPicker" in window
}

/** Open a single .gcad file. Returns handle and content, or null if user cancels. */
export async function openSingleGcad(): Promise<GcadFileResult | null> {
    try {
        const [handle] = await window.showOpenFilePicker({
            types: [{ description: "GalactiCAD model", accept: { "text/plain": [".gcad"] } }],
            multiple: false,
        })
        const file = await handle.getFile()
        const content = await file.text()
        return { handle, content, name: file.name }
    } catch (e) {
        if (e instanceof Error && e.name === "AbortError") return null
        throw e
    }
}

/** Open a directory. Returns handle or null if user cancels. */
export async function openFolder(): Promise<FileSystemDirectoryHandle | null> {
    try {
        return await window.showDirectoryPicker()
    } catch (e) {
        if (e instanceof Error && e.name === "AbortError") return null
        throw e
    }
}

/** List .gcad file names in a directory (no content read). */
export async function listGcadFileNames(dirHandle: FileSystemDirectoryHandle): Promise<string[]> {
    const names: string[] = []
    for await (const entry of dirHandle.values()) {
        if (entry.kind === "file" && entry.name.endsWith(".gcad")) {
            names.push(entry.name)
        }
    }
    return names.sort()
}

/** Read all .gcad files from a directory. */
export async function readGcadFiles(dirHandle: FileSystemDirectoryHandle): Promise<GcadFileEntry[]> {
    const entries: GcadFileEntry[] = []
    for await (const entry of dirHandle.values()) {
        if (entry.kind === "file" && entry.name.endsWith(".gcad")) {
            const file = await entry.getFile()
            const content = await file.text()
            entries.push({ name: entry.name, handle: entry as FileSystemFileHandle, content })
        }
    }
    return entries
}

/** Read current content from a file handle. */
export async function readFileContent(handle: FileSystemFileHandle): Promise<string> {
    const file = await handle.getFile()
    return file.text()
}

/** Save content to a file handle. Overwrites existing content. */
export async function writeToFile(handle: FileSystemFileHandle, content: string): Promise<void> {
    const writable = await handle.createWritable()
    try {
        await writable.write(content)
    } finally {
        await writable.close()
    }
}

/** Save content to a new file. Returns handle or null if user cancels. */
export async function saveAsGcad(suggestedName: string): Promise<FileSystemFileHandle | null> {
    try {
        return await window.showSaveFilePicker({
            suggestedName: suggestedName.endsWith(".gcad") ? suggestedName : `${suggestedName}.gcad`,
            types: [{ description: "GalactiCAD model", accept: { "text/plain": [".gcad"] } }],
        })
    } catch (e) {
        if (e instanceof Error && e.name === "AbortError") return null
        throw e
    }
}
