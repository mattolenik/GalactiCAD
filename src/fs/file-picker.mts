/**
 * File System Access API helpers for opening/saving .gcad files and folders.
 * Requires secure context (HTTPS) and user activation.
 */

export interface GcadFileResult {
    handle: FileSystemFileHandle
    content: string
    name: string
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

/** List .gcad file handles in a directory (no content read). */
export async function listGcadFileHandles(
    dirHandle: FileSystemDirectoryHandle
): Promise<{ name: string; handle: FileSystemFileHandle }[]> {
    const entries: { name: string; handle: FileSystemFileHandle }[] = []
    for await (const entry of dirHandle.values()) {
        if (entry.kind === "file" && entry.name.endsWith(".gcad")) {
            entries.push({ name: entry.name, handle: entry as FileSystemFileHandle })
        }
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name))
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
