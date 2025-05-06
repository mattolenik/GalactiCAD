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
