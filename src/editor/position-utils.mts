/**
 * Utilities for finding source locations at editor positions.
 * Used for selection sync (clicking on code to select corresponding shapes).
 */

/** Size metric for comparing ranges (smaller = innermost). */
const RANGE_SIZE_FACTOR = 100_000

export interface SourceRange {
    startLine: number
    startColumn: number
    endLine: number
    endColumn: number
}

function rangeSize(loc: SourceRange): number {
    return (loc.endLine - loc.startLine) * RANGE_SIZE_FACTOR + (loc.endColumn - loc.startColumn)
}

function contains(loc: SourceRange, line: number, column: number): boolean {
    if (line < loc.startLine || line > loc.endLine) return false
    if (line === loc.startLine && column < loc.startColumn) return false
    if (line === loc.endLine && column > loc.endColumn) return false
    return true
}

/**
 * Find the innermost (smallest containing) entry at the given position.
 * Returns the associated value, or null if no entry contains the position.
 */
export function findInnermostAtPosition<T>(
    entries: Iterable<[T, SourceRange]>,
    line: number,
    column: number
): T | null {
    let best: { value: T; size: number } | null = null
    for (const [value, loc] of entries) {
        if (!contains(loc, line, column)) continue
        const size = rangeSize(loc)
        if (!best || size < best.size) best = { value, size }
    }
    return best?.value ?? null
}
