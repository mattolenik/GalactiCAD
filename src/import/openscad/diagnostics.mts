/**
 * Diagnostics surfaced from an OpenSCAD import: parse errors plus every construct the
 * importer could not map. Line/col are 1-based for display (openscad-parser is 0-based).
 * See docs/research/openscad-importer-implementation-plan.md §6.
 */

export interface Diagnostic {
    severity: "warn" | "error"
    message: string
    /** 1-based line; 0 when no source location is available. */
    line: number
    /** 1-based column; 0 when no source location is available. */
    col: number
}

export class Diagnostics {
    readonly list: Diagnostic[] = []

    warn(message: string, line = 0, col = 0): void {
        this.list.push({ severity: "warn", message, line, col })
    }

    error(message: string, line = 0, col = 0): void {
        this.list.push({ severity: "error", message, line, col })
    }
}
