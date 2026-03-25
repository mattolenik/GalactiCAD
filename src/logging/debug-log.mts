/**
 * Toggleable debug logging per module. Enable modules from Dev Tools checkboxes.
 * Usage: log("NodeMatcher").debug("msg", extra)
 */

export const DEBUG_LOG_MODULES = [
    "NodeMatcher",
    "SourceParser",
    "RenderWorker",
    "MonacoHighlighter",
    "WelcomeScreen",
    "MdcExport",
    "GalactiCAD",
    "Sdf",
] as const

export type LogModule = (typeof DEBUG_LOG_MODULES)[number]

export type DebugLogModulesState = Partial<Record<LogModule, boolean>>

const enabled = Object.fromEntries(DEBUG_LOG_MODULES.map(m => [m, false])) as Record<LogModule, boolean>

/** Apply persisted or in-memory flags (missing / not true → off). */
export function applyDebugLogModules(state: Partial<Record<string, boolean>> | undefined): void {
    for (const m of DEBUG_LOG_MODULES) {
        enabled[m] = state?.[m] === true
    }
}

/** Normalize stored preferences: only known modules, boolean values. */
export function mergeDebugLogModulesFromStorage(raw: unknown): DebugLogModulesState {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
    const o = raw as Record<string, unknown>
    const out: DebugLogModulesState = {}
    for (const m of DEBUG_LOG_MODULES) {
        if (o[m] === true) out[m] = true
        else if (o[m] === false) out[m] = false
    }
    return out
}

export function log(module: LogModule): {
    debug: (...args: unknown[]) => void
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
} {
    const prefix = `[${module}]`
    return {
        debug: (...args: unknown[]) => {
            if (!enabled[module]) return
            console.debug(prefix, ...args)
        },
        info: (...args: unknown[]) => {
            if (!enabled[module]) return
            console.info(prefix, ...args)
        },
        warn: (...args: unknown[]) => {
            if (!enabled[module]) return
            console.warn(prefix, ...args)
        },
        error: (...args: unknown[]) => {
            if (!enabled[module]) return
            console.error(prefix, ...args)
        },
    }
}

/** Serializable snapshot for the render worker. */
export function snapshotDebugLogModules(state: DebugLogModulesState | undefined): Record<LogModule, boolean> {
    const out = {} as Record<LogModule, boolean>
    for (const m of DEBUG_LOG_MODULES) {
        out[m] = state?.[m] === true
    }
    return out
}
