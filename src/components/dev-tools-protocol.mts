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

/** Keys for `GlobalSettings.app.devToolsCollapseOpen` — expanded state of dev-tools collapsibles. */
export const DEVTOOLS_COLLAPSE = {
    panelApp: "galacticad.collapse.panelApp",
    panelMeshExport: "galacticad.collapse.panelMeshExport",
    /** Nested under panelMeshExport. */
    panelMeshExportMdc: "galacticad.collapse.appMeshExportMdc",
    /** Nested under panelMeshExport. */
    panelMeshExportShrec: "galacticad.collapse.panelShrecExport",
    /** Nested under panelMeshExport. */
    panelMeshExportIso: "galacticad.collapse.panelMeshExportIso",
    /** Nested under panelMeshExport. */
    panelMeshExportSfcc: "galacticad.collapse.panelSfccExport",
    /** Nested under panelMeshExport. */
    panelMeshExportSimplify: "galacticad.collapse.panelMeshSimplify",
    panelLogs: "galacticad.collapse.panelLogs",
    panelBenchmark: "galacticad.collapse.panelBenchmark",
    panelReset: "galacticad.collapse.panelReset",
    appViewport: "galacticad.collapse.appViewport",
    appExport: "galacticad.collapse.appExport",
    rendererPerformance: "galacticad.collapse.rendererPerformance",
} as const

export type DevToolsCollapseId = (typeof DEVTOOLS_COLLAPSE)[keyof typeof DEVTOOLS_COLLAPSE]

/** When a key is absent from storage, use this default (`true` = expanded). Only list exceptions. */
export const DEFAULT_DEVTOOLS_COLLAPSE_OPEN: Partial<Record<DevToolsCollapseId, boolean>> = {
    [DEVTOOLS_COLLAPSE.panelReset]: false,
    [DEVTOOLS_COLLAPSE.panelMeshExportMdc]: false,
    [DEVTOOLS_COLLAPSE.panelMeshExportShrec]: false,
    [DEVTOOLS_COLLAPSE.panelMeshExportIso]: false,
    [DEVTOOLS_COLLAPSE.panelMeshExportSfcc]: false,
    [DEVTOOLS_COLLAPSE.panelMeshExportSimplify]: false,
}

/** Defaults when `devToolsSections[DEVTOOLS_SECTION_APP]` is missing or partial. */
export const DEFAULT_APP_DEVTOOLS_STATE: Record<string, JSONValue> = {
    // Devserver live-reload master switch (consumed by the injected bridge script).
    autoReload: true,
    showFps: true,
    meshViewerEnabled: false,
    meshSimplifyOnExport: false,
    // FSR1 spatial upscale (see DEFAULT_UPSCALE_PARAMS in render-worker-protocol).
    upscaleParams: { renderScale: 0.5, mode: "easu" },
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
