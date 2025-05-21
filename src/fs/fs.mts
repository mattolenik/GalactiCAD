const invalidChars = /[\\\/:*?"<>|]/g

export function isValidFilename(name: string): boolean {
    return findInvalidFilenameChars(name).length == 0
}
export function findInvalidFilenameChars(name: string): string[] {
    const matches = Array.from(name.matchAll(invalidChars)).map(v => v[0])
    return matches.length === 0 ? [] : matches
}
export function validateFilename(name: string) {
    const invalid = findInvalidFilenameChars(name)
    if (invalid) {
        throw new Error(`filename ${name} is invalid because it contains these characters: ${invalid.join(" ")}`)
    }
}

export async function saveArrayBufferToDisk(buffer: ArrayBuffer, suggestedName?: string, startIn = "desktop"): Promise<void> {
    let handle: FileSystemFileHandle
    try {
        handle = await window.showSaveFilePicker({
            suggestedName,
            types: [
                {
                    description: "GalactiCAD file",
                    accept: { "text/plain": [".gcad"] },
                },
            ],
            excludeAcceptAllOption: false,
        })
    } catch (err) {
        if (`${err}`.includes("AbortError")) {
            return
        }
        throw err
    }

    const writable = await handle!.createWritable()
    await writable.write(buffer)
    await writable.close()
}
