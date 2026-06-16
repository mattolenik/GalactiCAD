/**
 * Browser-side `use`/`include` resolution for OpenSCAD import (approach A: resolve within a
 * folder, prompt for the containing folder on a miss). A single file pick gives no directory
 * access, so the first unresolved reference prompts for a folder; further misses prompt again
 * (e.g. a library that lives elsewhere). Resolved folders are cached for the rest of the import.
 *
 * This is the only browser-specific part of import; the gather + evaluate layers are pure.
 */

import type { IncludeResolver } from "../import/openscad/include-gather.mjs"
import { openFolder } from "./file-picker.mjs"

/** Read `path` from a directory: try the literal relative path, then a bounded basename search. */
async function readFileFromDir(dir: FileSystemDirectoryHandle, path: string): Promise<string | null> {
    const parts = path.split("/").filter(p => p.length > 0 && p !== ".")
    if (parts.length === 0) return null
    const base = parts[parts.length - 1]!
    try {
        let d = dir
        for (let i = 0; i < parts.length - 1; i++) d = await d.getDirectoryHandle(parts[i]!)
        const fh = await d.getFileHandle(base)
        return await (await fh.getFile()).text()
    } catch {
        // Relative path didn't resolve (e.g. "../lib/foo.scad") — fall back to a basename search.
    }
    return searchByBasename(dir, base, 0)
}

async function searchByBasename(dir: FileSystemDirectoryHandle, base: string, depth: number): Promise<string | null> {
    if (depth > 6) return null // bound the walk
    const subdirs: FileSystemDirectoryHandle[] = []
    for await (const entry of dir.values()) {
        if (entry.kind === "file") {
            if (entry.name === base) return await (await (entry as FileSystemFileHandle).getFile()).text()
        } else {
            subdirs.push(entry as FileSystemDirectoryHandle)
        }
    }
    for (const sub of subdirs) {
        const found = await searchByBasename(sub, base, depth + 1)
        if (found != null) return found
    }
    return null
}

/** An IncludeResolver that searches user-granted folders, prompting for one when a path is missing. */
export function createFolderIncludeResolver(): IncludeResolver {
    const dirs: FileSystemDirectoryHandle[] = []
    let prompted = false
    return async path => {
        for (const dir of dirs) {
            const text = await readFileFromDir(dir, path)
            if (text != null) return text
        }
        alert(
            prompted
                ? `Couldn't find "${path}". Choose the folder that contains it (or Cancel to skip).`
                : `This OpenSCAD model uses include/use. Choose the folder containing it and its libraries.`,
        )
        prompted = true
        const dir = await openFolder()
        if (!dir) return null
        dirs.push(dir)
        return readFileFromDir(dir, path)
    }
}
