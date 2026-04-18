/** JSON-serializable values for dev tools section snapshots. */
export type JSONValue =
    | null
    | boolean
    | number
    | string
    | JSONValue[]
    | { [key: string]: JSONValue }

export const DEVTOOLS_STATE_CHANGE_EVENT = "devtools-state-change" as const

export type DevToolsStateChangeDetail = { sectionId: string }

/** Stable storage keys for `GlobalSettings.app.devToolsSections`. */
export const DEVTOOLS_SECTION_APP = "galacticad.app"
export const DEVTOOLS_SECTION_LOGS = "galacticad.logs"

/** Defaults when `devToolsSections[DEVTOOLS_SECTION_APP]` is missing or partial. */
export const DEFAULT_APP_DEVTOOLS_STATE: Record<string, JSONValue> = {
    showFps: true,
    meshViewerEnabled: false,
    meshSimplifyOnExport: true,
    lightingExpanded: false,
}

export interface DevToolsPersistable extends HTMLElement {
    readonly devToolsSectionId: string
    getDevToolsState(): Record<string, JSONValue>
    setDevToolsState(state: Record<string, JSONValue>): void
}

export function isDevToolsPersistable(el: unknown): el is DevToolsPersistable {
    if (!(el instanceof HTMLElement)) return false
    const p = el as Partial<DevToolsPersistable>
    return (
        typeof p.devToolsSectionId === "string" &&
        typeof p.getDevToolsState === "function" &&
        typeof p.setDevToolsState === "function"
    )
}

export function dispatchDevToolsStateChange(host: HTMLElement, sectionId: string): void {
    host.dispatchEvent(
        new CustomEvent<DevToolsStateChangeDetail>(DEVTOOLS_STATE_CHANGE_EVENT, {
            bubbles: true,
            composed: true,
            detail: { sectionId },
        })
    )
}
