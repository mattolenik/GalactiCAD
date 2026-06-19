/**
 * Diagnostic logging per module. Dev Tools **Logs** toggles gate `debug` / `info` / `warn`;
 * `log("Module").error` always goes to the console and dev log bridge.
 * Usage: log("NodeMatcher").debug("msg", extra)
 *
 * When the devserver injects `__galacticadDevLogPush`, main thread calls
 * `connectMainThreadDevLogToBridge()` so `log()` output and mirrored `console.*`
 * lines go to the dev log ring buffer. Workers call `installWorkerDevLogBridge()` to
 * forward the same pipeline to the main thread.
 *
 * Dev log entries carry `module` separately from `line` for filtering; `line` also includes
 * a `[Module]` bracket after `[level]` so buffered text matches the console prefix order.
 */

/** One line pushed to the in-browser dev log buffer (see devserver injected script). */
export type DevLogEntry = {
    /** Formatted text: `[iso] [level] [Module]` and optional `[thread]`, then message (see `emitToDevLog`). */
    line: string
    /** Set for `log("ModuleName")` output; omitted for mirrored console and untagged errors. */
    module?: string
}

export const DEBUG_LOG_MODULES = [
    "App",
    "NodeMatcher",
    "SourceParser",
    "RenderWorker",
    "CadHighlighter",
    "WelcomeScreen",
    "MeshExport",
    "MdcExport",
    "IsoSimplicialExport",
    "ShrecExport",
    "FlexiCubesExport",
    "Simplify",
    "Settings",
    "Sdf",
    "FeatureGraph",
    /** Reserved for optional verbose WGSL debug; `logWgsl()` is always-on for compile/pipeline errors. */
    "Wgsl",
] as const

export type LogModule = (typeof DEBUG_LOG_MODULES)[number]

export type DebugLogModulesState = Partial<Record<LogModule, boolean>>

const enabled = Object.fromEntries(DEBUG_LOG_MODULES.map(m => [m, true])) as Record<LogModule, boolean>

/** Preserve real console before optional dev mirror (avoids double-recording from log()). */
const origConsole: Pick<typeof console, "debug" | "info" | "warn" | "error" | "log"> = {
    debug: console.debug.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    log: console.log.bind(console),
}

/** Optional sink for devserver / unified log buffer (main or worker). */
let devLogPush: ((entry: DevLogEntry) => void) | undefined
let devLogThreadLabel: string | undefined
let devConsoleMirrorInstalled = false

/** Apply persisted or in-memory flags (missing → on, explicit false → off). */
export function applyDebugLogModules(state: Partial<Record<string, boolean>> | undefined): void {
    for (const m of DEBUG_LOG_MODULES) {
        enabled[m] = state?.[m] !== false
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

/** One argument as a single line for the dev log buffer (console.* formats Errors natively; JSON.stringify(Error) is `{}`). */
function formatArgForDevLog(p: unknown): string {
    if (typeof p === "string") return p
    if (p instanceof Error) {
        if (typeof p.stack === "string" && p.stack.trim() !== "") return p.stack
        const name = typeof p.name === "string" && p.name !== "" ? p.name : "Error"
        const msg = typeof p.message === "string" ? p.message : String(p)
        return `${name}: ${msg}`
    }
    if (p === undefined) return "undefined"
    if (typeof p === "bigint") return `${p}n`
    if (typeof p === "function") {
        const fn = p as { name?: string }
        return typeof fn.name === "string" && fn.name !== "" ? `[Function: ${fn.name}]` : "[Function]"
    }
    if (typeof p === "symbol") return String(p)
    try {
        const json = JSON.stringify(p)
        if (json !== undefined) return json
    } catch {
        /* fall through */
    }
    try {
        return String(p)
    } catch {
        return "[object]"
    }
}

function formatArgs(args: unknown[]): string {
    return args.map(formatArgForDevLog).join(" ")
}

function emitToDevLog(module: LogModule, level: string, args: unknown[]): void {
    if (!devLogPush) return
    const ts = new Date().toISOString()
    const text = formatArgs(args)
    const parts: string[] = [`[${ts}]`, `[${level}]`, `[${module}]`]
    if (devLogThreadLabel) parts.push(`[${devLogThreadLabel}]`)
    parts.push(text)
    devLogPush({ module, line: parts.join(" ") })
}

const WGSL_DEV_MODULE = "Wgsl"

/**
 * Always-on WebGPU/WGSL diagnostics: real console + dev log bridge with `module: "Wgsl"` for `/_logs?module=Wgsl`.
 * Does not depend on Dev Tools log toggles (unlike `log("Module").debug` / `.info` / `.warn`; `log("Module").error` is always emitted).
 */
export function logWgsl(level: "error" | "warn" | "info", ...args: unknown[]): void {
    const ts = new Date().toISOString()
    const text = formatArgs(args)
    const parts: string[] = [`[${ts}]`, `[${level}]`, `[${WGSL_DEV_MODULE}]`]
    if (devLogThreadLabel) parts.push(`[${devLogThreadLabel}]`)
    parts.push(text)
    const line = parts.join(" ")
    if (devLogPush) {
        devLogPush({ module: WGSL_DEV_MODULE, line })
    }
    const prefix = `[${WGSL_DEV_MODULE}]`
    if (level === "error") origConsole.error(prefix, ...args)
    else if (level === "warn") origConsole.warn(prefix, ...args)
    else origConsole.info(prefix, ...args)
}

function formatGpuError(err: GPUError): string {
    const o = err as GPUError & { name?: string }
    const name = typeof o.name === "string" && o.name.length > 0 ? o.name : "GPUError"
    const msg = typeof err.message === "string" ? err.message : String(err)
    return `${name}: ${msg}`
}

/**
 * Route WebGPU runtime validation / OOM errors (and device loss) through `logWgsl` so they hit the dev log
 * bridge and `/_logs?module=Wgsl` like shader compilation output. Call once per `GPUDevice` after creation.
 */
export function installWebGpuDeviceLogging(device: GPUDevice): void {
    device.addEventListener("uncapturederror", (ev: Event) => {
        const u = ev as GPUUncapturedErrorEvent
        const err = u.error
        logWgsl("error", "WebGPU uncaptured", formatGpuError(err))
    })
    void device.lost.then(info => {
        logWgsl("error", `WebGPU device lost (${info.reason}): ${info.message}`)
    })
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
            origConsole.error(prefix, ...args)
            emitToDevLog(module, "error", args)
        },
    }
}

/** Serializable snapshot for the render worker. */
export function snapshotDebugLogModules(state: DebugLogModulesState | undefined): Record<LogModule, boolean> {
    const out = {} as Record<LogModule, boolean>
    for (const m of DEBUG_LOG_MODULES) {
        out[m] = state?.[m] !== false
    }
    return out
}

export function setDevLogThreadLabel(label: string | undefined): void {
    devLogThreadLabel = label
}

export function setDevLogPush(fn: ((entry: DevLogEntry) => void) | undefined): void {
    devLogPush = fn
}

/** Append a dev log entry (e.g. forwarded from a worker). Main thread only. */
export function appendDevLogLine(line: string, module?: string): void {
    if (module != null && module !== "") {
        devLogPush?.({ line, module })
    } else {
        devLogPush?.({ line })
    }
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
            ; (console as unknown as Record<string, (...a: unknown[]) => void>)[m] = (...args: unknown[]) => {
                if (devLogPush) {
                    const ts = new Date().toISOString()
                    const text = formatArgs(args)
                    const tp = devLogThreadLabel ? `[${devLogThreadLabel}]` : ""
                    devLogPush({ line: `[${ts}] [${m}] ${tp}${text}` })
                }
                return orig.apply(console, args as never[])
            }
    }
}

type GalacticadDevBridgeGlobals = {
    __galacticadDevLogPush?: (entry: DevLogEntry) => void
    __galacticadDevGetActiveSceneSource?: () => string
}

/**
 * When the devserver injected the log bridge, register a getter for `GET /_sceneSource` (active Monaco document).
 * No-op without devserver.
 */
export function installDevActiveSceneSourceGetter(getSource: () => string): void {
    if (typeof window === "undefined") return
    const g = globalThis as GalacticadDevBridgeGlobals
    if (typeof g.__galacticadDevLogPush !== "function") return
    g.__galacticadDevGetActiveSceneSource = getSource
}

/** Main thread: connect to devserver-injected `__galacticadDevLogPush` and capture globals. No-op when not using devserver. */
export function connectMainThreadDevLogToBridge(): void {
    if (typeof window === "undefined") return
    const g = globalThis as GalacticadDevBridgeGlobals
    if (typeof g.__galacticadDevLogPush !== "function") return
    setDevLogThreadLabel("main")
    setDevLogPush(entry => {
        g.__galacticadDevLogPush?.(entry)
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
 * Dedicated worker: send each entry to main via `postMessage({ type: 'devLogLine', line, module? })`.
 * Call once at worker entry before other code runs.
 */
export function installWorkerDevLogBridge(workerLabel: string): void {
    setDevLogThreadLabel(workerLabel)
    setDevLogPush(entry => {
        self.postMessage({
            type: "devLogLine",
            line: entry.line,
            ...(entry.module !== undefined ? { module: entry.module } : {}),
        })
    })
    installDevConsoleMirror()
}
