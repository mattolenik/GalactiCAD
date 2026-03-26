/**
 * Toggleable debug logging per module. Enable modules from Dev Tools checkboxes.
 * Usage: log("NodeMatcher").debug("msg", extra)
 *
 * When the devserver injects `__galacticadDevLogPush`, main thread calls
 * `connectMainThreadDevLogToBridge()` so `log()` output and mirrored `console.*`
 * lines go to the MCP ring buffer. Workers call `installWorkerDevLogBridge()` to
 * forward the same pipeline to the main thread.
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

/** Preserve real console before optional dev mirror (avoids double-recording from log()). */
const origConsole: Pick<typeof console, "debug" | "info" | "warn" | "error" | "log"> = {
    debug: console.debug.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    log: console.log.bind(console),
}

/** Optional sink for devserver MCP / unified log buffer (main or worker). */
let devLogPush: ((line: string) => void) | undefined
let devLogThreadLabel: string | undefined
let devConsoleMirrorInstalled = false

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

function formatArgs(args: unknown[]): string {
    return args
        .map(p => {
            if (typeof p === "string") return p
            try {
                return JSON.stringify(p)
            } catch {
                return String(p)
            }
        })
        .join(" ")
}

function emitToDevLog(module: LogModule, level: string, args: unknown[]): void {
    if (!devLogPush) return
    const ts = new Date().toISOString()
    const text = formatArgs(args)
    const tp = devLogThreadLabel ? `[${devLogThreadLabel}]` : ""
    devLogPush(`[${ts}] [${level}] ${tp}[${module}] ${text}`)
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
            origConsole.debug(prefix, ...args)
            emitToDevLog(module, "debug", args)
        },
        info: (...args: unknown[]) => {
            if (!enabled[module]) return
            origConsole.info(prefix, ...args)
            emitToDevLog(module, "info", args)
        },
        warn: (...args: unknown[]) => {
            if (!enabled[module]) return
            origConsole.warn(prefix, ...args)
            emitToDevLog(module, "warn", args)
        },
        error: (...args: unknown[]) => {
            if (!enabled[module]) return
            origConsole.error(prefix, ...args)
            emitToDevLog(module, "error", args)
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

// --- Devserver MCP: ring buffer integration (any thread → main buffer via workers) ---

export function setDevLogThreadLabel(label: string | undefined): void {
    devLogThreadLabel = label
}

export function setDevLogPush(fn: ((line: string) => void) | undefined): void {
    devLogPush = fn
}

/** Append a line already formatted (e.g. forwarded from a worker). Main thread only. */
export function appendDevLogLine(line: string): void {
    devLogPush?.(line)
}

/**
 * Mirror raw `console` calls into the dev log buffer (captures `console.error` etc. outside `log()`).
 * Safe to call once per realm (main / each worker).
 */
export function installDevConsoleMirror(): void {
    if (devConsoleMirrorInstalled) return
    devConsoleMirrorInstalled = true
    const methods = ["log", "info", "warn", "error", "debug"] as const
    for (const m of methods) {
        const orig = origConsole[m]
        ;(console as unknown as Record<string, (...a: unknown[]) => void>)[m] = (...args: unknown[]) => {
            if (devLogPush) {
                const ts = new Date().toISOString()
                const text = formatArgs(args)
                const tp = devLogThreadLabel ? `[${devLogThreadLabel}]` : ""
                devLogPush(`[${ts}] [${m}] ${tp}${text}`)
            }
            return orig.apply(console, args as never[])
        }
    }
}

/** Main thread: connect to devserver-injected `__galacticadDevLogPush` and capture globals. No-op when not using devserver. */
export function connectMainThreadDevLogToBridge(): void {
    if (typeof window === "undefined") return
    const g = globalThis as { __galacticadDevLogPush?: (line: string) => void }
    if (typeof g.__galacticadDevLogPush !== "function") return
    setDevLogThreadLabel("main")
    setDevLogPush(line => {
        g.__galacticadDevLogPush?.(line)
    })
    installDevConsoleMirror()
    window.addEventListener("error", ev => {
        const msg = `[window.error] ${ev.message} at ${ev.filename}:${ev.lineno}:${ev.colno}`
        appendDevLogLine(`[${new Date().toISOString()}] [error] [main] ${msg}`)
    })
    window.addEventListener("unhandledrejection", ev => {
        const r = ev.reason
        const text = r instanceof Error ? r.stack ?? r.message : String(r)
        appendDevLogLine(`[${new Date().toISOString()}] [error] [main] [unhandledrejection] ${text}`)
    })
}

/**
 * Dedicated worker: send each line to main via `postMessage({ type: 'devLogLine', line })`.
 * Call once at worker entry before other code runs.
 */
export function installWorkerDevLogBridge(workerLabel: string): void {
    setDevLogThreadLabel(workerLabel)
    setDevLogPush(line => {
        self.postMessage({ type: "devLogLine", line })
    })
    installDevConsoleMirror()
}
