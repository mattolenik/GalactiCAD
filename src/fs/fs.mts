const invalidChars = /[\\\/:*?"<>|]/g

export function isValidFilename(name: string): string[] | null {
    const matches = Array.from(name.matchAll(invalidChars)).map(v => v[0])
    return matches.length === 0 ? null : matches
}
