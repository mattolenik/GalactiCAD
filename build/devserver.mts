import { execFile } from "node:child_process"
import { writeSync } from "node:fs"
import fs from "fs/promises"
import http from "http"
import path from "path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { getInstalledBrowsers } from "@puppeteer/browsers"
import puppeteer, { type Browser } from "puppeteer"
import WebSocket, { WebSocketServer } from "ws"
import { BrowserBridge, type DevServerConsoleLogLevel } from "./devserver-bridge.mjs"
import {
    mergeAgentRenderRequest,
    normalizeAgentTestcaseFromBridge,
    parseAgentTestcaseYaml,
    serializeAgentTestcaseYaml,
    type AgentMeshOverlay,
    type AgentRenderMode,
    type AgentRenderRequest,
    type AgentTestcase,
} from "../src/agent-autotest/agent-testcase.mjs"

/**
 * True only in the agent devserver (headless Chrome, no watch auto-reload, agent log file).
 * Must be an exact `"true"` check: the Makefile starts the INTERACTIVE server with
 * `AGENT=false` in the env, and `!!"false"` is truthy — which would make the interactive
 * server skip browser reloads and spawn a phantom headless browser on its own port.
 */
export const AGENT_MODE = process.env.AGENT === "true"

/** Cache dir for `@puppeteer/browsers` install (see `setup` in Makefile). */
const PUPPETEER_BROWSERS_DIR = ".browsers"

export interface RunFileData {
    pid: number
    port: number
}

async function resolveChromiumExecutable(): Promise<string | null> {
    const installed = await getInstalledBrowsers({ cacheDir: path.resolve(process.cwd(), PUPPETEER_BROWSERS_DIR) })
    const chromium = installed.find(b => b.browser === "chromium")
    return chromium?.executablePath ?? null
}

type DevLogQuery = {
    n: number
    levels: DevServerConsoleLogLevel[]
    modules?: string[]
}

const ALL_LOG_LEVELS: DevServerConsoleLogLevel[] = ["error", "warn", "info", "debug"]

/** After `/_agent/render`, snapshot bridge buffer into this file (overwrite). */
function browserLogFilePath(): string {
    const name = AGENT_MODE ? ".devserver.agent.browser.log" : ".devserver.browser.log"
    return path.join(process.cwd(), name)
}

/** Fetch up to 10k lines (all levels) and replace the browser log file; ignores failures. */
async function overwriteBrowserLogAfterAgentRender(bridge: BrowserBridge, errLog: (msg: unknown) => void): Promise<void> {
    const lines = await bridge.requestConsoleLogs({ n: 10_000, levels: ALL_LOG_LEVELS }, 30_000)
    const body = lines != null && lines.length > 0 ? `${lines.join("\n")}\n` : ""
    try {
        await fs.writeFile(browserLogFilePath(), body, "utf8")
    } catch (e) {
        errLog(e)
    }
}

function clampLogCount(n: number): number {
    if (!Number.isFinite(n)) return 20
    return Math.min(10_000, Math.max(1, Math.floor(n)))
}

function parseModuleFilters(searchParams: URLSearchParams): string[] | undefined {
    if (!searchParams.has("module")) return undefined
    const modules: string[] = []
    for (const raw of searchParams.getAll("module")) {
        for (const piece of raw.split(",")) {
            const value = piece.trim()
            if (!value) continue
            modules.push(value)
        }
    }
    if (modules.length === 0) return undefined
    return [...new Set(modules)]
}

/** Map public query tokens (`warning`, etc.) to bridge levels (`warn`, …). */
function publicLevelTokenToInternal(raw: string): DevServerConsoleLogLevel | null {
    const t = raw.trim().toLowerCase()
    if (t === "error") return "error"
    if (t === "warning" || t === "warn") return "warn"
    if (t === "info") return "info"
    if (t === "debug") return "debug"
    return null
}

const INFO_THRESHOLD_LEVELS: DevServerConsoleLogLevel[] = ["error", "warn", "info"]

function levelsFromLevelThreshold(raw: string | null): DevServerConsoleLogLevel[] {
    const t = (raw ?? "").trim().toLowerCase()
    if (t === "" || t === "info") return INFO_THRESHOLD_LEVELS
    if (t === "error") return ["error"]
    if (t === "warning" || t === "warn") return ["error", "warn"]
    if (t === "debug") return [...ALL_LOG_LEVELS]
    return INFO_THRESHOLD_LEVELS
}

/** When `only` is present on the URL, parse comma-separated exact buckets (order-preserving, deduped). */
function parseOnlyLevelList(searchParams: URLSearchParams): DevServerConsoleLogLevel[] {
    const raw = searchParams.get("only") ?? ""
    const out: DevServerConsoleLogLevel[] = []
    const seen = new Set<DevServerConsoleLogLevel>()
    for (const piece of raw.split(",")) {
        const lvl = publicLevelTokenToInternal(piece)
        if (!lvl || seen.has(lvl)) continue
        seen.add(lvl)
        out.push(lvl)
    }
    return out
}

function parseLogQuery(url: URL): DevLogQuery {
    let levels: DevServerConsoleLogLevel[]
    if (url.searchParams.has("only")) {
        const only = parseOnlyLevelList(url.searchParams)
        levels = only.length > 0 ? only : INFO_THRESHOLD_LEVELS
    } else {
        levels = levelsFromLevelThreshold(url.searchParams.get("level"))
    }
    const n = clampLogCount(Number(url.searchParams.get("n") ?? "20"))
    const modules = parseModuleFilters(url.searchParams)
    return { n, levels, ...(modules ? { modules } : {}) }
}

/** Repo root for paths that must stay stable when `cwd` is wrong (e.g. imagelog under `.agents/`). Agents saving their own PNGs should use `.agents/testimages/` (documented in AGENTS.md / devserver skill), not `.agents/` root. */
const REPO_ROOT_FOR_HTTP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/** POST JSON body only. */
const AGENT_RENDER_ROOT = "/_agent/render"
/** POST inline testcase YAML (e.g. pipe `GET /_agent/capture-testcase` from the interactive devserver). */
const AGENT_RENDER_TESTCASE_BODY = "/_agent/render/testcase-body"
/** GET testcase file. Path after this prefix is resolved as: (1) relative to cwd, (2) relative to `./test/testcases/`, or absolute (leading `/` after the prefix → `//abs/path`). First existing match wins. */
const AGENT_RENDER_TESTCASE_PREFIX = "/_agent/render/testcase"

function isAgentRenderPathname(pathname: string): boolean {
    return (
        pathname === AGENT_RENDER_ROOT ||
        pathname === AGENT_RENDER_TESTCASE_BODY ||
        pathname === AGENT_RENDER_TESTCASE_PREFIX ||
        pathname.startsWith(`${AGENT_RENDER_TESTCASE_PREFIX}/`)
    )
}

/** Shared query params for GET file render and POST `testcase-body` (mode, viewport, mesh overlays). */
function agentRenderQueryOverrides(url: URL): {
    mode?: AgentRenderMode
    viewportWidth?: number
    viewportHeight?: number
    meshOverlay?: AgentMeshOverlay
} {
    const modeQ = url.searchParams.get("mode")
    const mode: AgentRenderMode | undefined = modeQ === "mesh" || modeQ === "sdf" ? modeQ : undefined
    const vw = url.searchParams.get("viewportWidth")
    const vh = url.searchParams.get("viewportHeight")
    const vwn = vw !== null && vw !== "" ? Number(vw) : undefined
    const vhn = vh !== null && vh !== "" ? Number(vh) : undefined
    const flag = (key: string): boolean => {
        const v = url.searchParams.get(key)
        if (v === null) return false
        const lower = v.trim().toLowerCase()
        return lower === "1" || lower === "true" || lower === "yes" || lower === "on"
    }
    const meshOverlay = (() => {
        const debugPoints = flag("debugPoints") || flag("mdcDebugPoints")
        const fgLine = flag("glyphLine") || flag("featureGlyphs.line")
        const fgCorner = flag("glyphCorner") || flag("featureGlyphs.corner")
        const fgSeam = flag("glyphSeam") || flag("featureGlyphs.seam")
        const fgRing = flag("glyphRing") || flag("featureGlyphs.ring")
        const cellVerts = flag("cellVertices") || flag("mdcCellVertices")
        const qefPlanes = flag("qefPlanes") || flag("mdcQefPlanes")
        const wireframe = flag("wireframe")
        const themeQ = url.searchParams.get("theme")?.trim().toLowerCase()
        const theme: "light" | "dark" | undefined = themeQ === "light" || themeQ === "dark" ? themeQ : undefined
        const any =
            debugPoints || fgLine || fgCorner || fgSeam || fgRing || cellVerts || qefPlanes || wireframe
        if (!any) return undefined
        return {
            mdcDebugPoints: debugPoints,
            featureGlyphs: { line: fgLine, corner: fgCorner, seam: fgSeam, ring: fgRing },
            mdcCellVertices: cellVerts,
            mdcQefPlanes: qefPlanes,
            wireframe,
            ...(theme !== undefined ? { theme } : {}),
        }
    })()
    return {
        ...(mode !== undefined ? { mode } : {}),
        ...(Number.isFinite(vwn) ? { viewportWidth: vwn } : {}),
        ...(Number.isFinite(vhn) ? { viewportHeight: vhn } : {}),
        ...(meshOverlay !== undefined ? { meshOverlay } : {}),
    }
}

/**
 * Returns the raw user-supplied testcase path (percent-decoded), or null if missing.
 * The path may be relative (resolved against cwd or `test/testcases/` by {@link resolveAgentTestcaseFile})
 * or absolute (leading `/` survives because the URL has a double slash after the prefix).
 */
function parseAgentRenderTestcasePathFromPathname(pathname: string): string | null {
    if (pathname === AGENT_RENDER_TESTCASE_PREFIX) return null
    if (!pathname.startsWith(`${AGENT_RENDER_TESTCASE_PREFIX}/`)) return null
    let rest = pathname.slice(AGENT_RENDER_TESTCASE_PREFIX.length + 1)
    if (!rest) return null
    try {
        rest = decodeURIComponent(rest)
    } catch {
        return null
    }
    if (!rest) return null
    return rest
}

/**
 * Resolve a testcase path. Precedence: (1) relative to cwd, (2) relative to `cwd/test/testcases/`.
 * Absolute paths are used as-is. If the input has no `.yaml` / `.yml` / `.json` suffix, `.yaml` is
 * appended. Returns the first existing file, or null.
 */
async function resolveAgentTestcaseFile(testcasePath: string): Promise<string | null> {
    const input = testcasePath.replace(/\\/g, "/").trim()
    if (!input) return null
    const withExt = /\.(ya?ml|json)$/i.test(input) ? input : `${input}.yaml`
    const candidates = path.isAbsolute(withExt)
        ? [withExt]
        : [path.resolve(process.cwd(), withExt), path.resolve(process.cwd(), "test", "testcases", withExt)]
    for (const c of candidates) {
        try {
            if ((await fs.stat(c)).isFile()) return c
        } catch {
            // try next candidate
        }
    }
    return null
}

/** Stem of the testcase filename (no `.yaml` / `.yml` / `.json`), or `render` if missing. */
function agentRenderDownloadBasename(testcasePath: string | undefined | null): string {
    const raw = (testcasePath ?? "").trim().replace(/\\/g, "/")
    if (!raw) return "render"
    const bn = path.basename(raw)
    if (!bn || bn === "." || bn === "..") return "render"
    const stem = path.parse(bn).name
    const safe = stem.replace(/[^\w.-]+/g, "_").slice(0, 120)
    return safe.length > 0 ? safe : "render"
}

function agentRenderPngContentDisposition(downloadBasename: string, mode: AgentRenderRequest["mode"]): string {
    const base = downloadBasename.replace(/[^\w.-]+/g, "_").slice(0, 120) || "render"
    const m = mode === "mesh" || mode === "sdf" ? mode : "sdf"
    const filename = `${base}-${m}.png`
    const esc = filename.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
    const star = encodeURIComponent(filename)
    return `attachment; filename="${esc}"; filename*=UTF-8''${star}`
}

async function writeAgentImagelogPng(repoRoot: string, labelSlug: string, role: string, pngBytes: Buffer): Promise<string> {
    // Server mirror only; ad-hoc agent saves belong under `.agents/testimages/` per AGENTS.md.
    const dir = path.join(repoRoot, ".agents", "imagelog")
    await fs.mkdir(dir, { recursive: true })
    const now = new Date()
    const hhmm = `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`
    const safe = labelSlug.replace(/[^\w.-]+/g, "_").slice(0, 56)
    const safeRole = role.replace(/[^\w.-]+/g, "_").slice(0, 32)
    const fn = `${safe}-${hhmm}-${safeRole}.png`
    const fp = path.join(dir, fn)
    await fs.writeFile(fp, pngBytes)
    return fp
}

function readHttpBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        req.on("data", chunk => chunks.push(chunk as Buffer))
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
        req.on("error", reject)
    })
}

/** Pipeline / request failures reported by the browser use 400; bridge unavailable */
function agentRenderErrorHttpStatus(out: { pngBase64?: string; error?: string } | null): number {
    if (out != null && typeof out.error === "string" && out.error.length > 0) {
        return 400
    }
    return 500
}

/** Wait until the HTTP response body is fully flushed (avoids curl/client write errors on short reads). */
function endHttpResponseWithBuffer(
    res: http.ServerResponse,
    status: number,
    headers: http.OutgoingHttpHeaders,
    body: Buffer,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const onError = (e: Error) => {
            res.off("error", onError)
            reject(e)
        }
        res.once("error", onError)
        res.writeHead(status, headers)
        res.end(body, () => {
            res.off("error", onError)
            resolve()
        })
    })
}
async function respondAgentRenderPng(
    bridge: BrowserBridge,
    repoRoot: string,
    payload: AgentRenderRequest,
    labelSlug: string,
    role: string,
    downloadBasename: string,
    res: http.ServerResponse,
    err: (msg: unknown) => void,
): Promise<void> {
    const out = await bridge.requestAgentRender(payload as unknown as Record<string, unknown>)
    try {
        if (!out?.pngBase64) {
            const errText = out?.error ?? "bridge failed (no browser, timeout, or GPU error)"
            const status = agentRenderErrorHttpStatus(out)
            res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" })
            res.end(errText)
            return
        }
        let buf: Buffer
        try {
            buf = Buffer.from(out.pngBase64, "base64")
        } catch {
            res.writeHead(400, { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" })
            res.end("invalid PNG base64 from bridge")
            return
        }
        if (buf.length === 0) {
            res.writeHead(400, { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" })
            res.end("empty PNG from bridge")
            return
        }
        try {
            await writeAgentImagelogPng(repoRoot, labelSlug, role, buf)
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            console.error(`writeAgentImagelogPng: ${msg}`)
        }
        await endHttpResponseWithBuffer(
            res,
            200,
            {
                "content-type": "image/png",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Expose-Headers": "Content-Disposition",
                "Content-Disposition": agentRenderPngContentDisposition(downloadBasename, payload.mode),
                "Content-Length": String(buf.length),
            },
            buf,
        )
    } finally {
        try {
            await overwriteBrowserLogAfterAgentRender(bridge, err)
        } catch (e) {
            err(e)
        }
    }
}

/** Ring buffer + bridge WebSocket; `__galacticadDevLogPush` is consumed by `connectMainThreadDevLogToBridge()` in app. */
const INJECTED_BRIDGE_SCRIPT = `
        <script type="module">
        (function () {
            const MAX = 5000;
            const buf = [];
            function normalizeEntry(raw) {
                if (raw != null && typeof raw === "object" && typeof raw.line === "string") {
                    var mod = raw.module;
                    return { line: raw.line, module: typeof mod === "string" && mod !== "" ? mod : undefined };
                }
                if (typeof raw === "string") return { line: raw };
                return null;
            }
            function push(raw) {
                var e = normalizeEntry(raw);
                if (!e) return;
                buf.push(e);
                if (buf.length > MAX) buf.splice(0, buf.length - MAX);
            }
            globalThis.__galacticadDevLogPush = push;
            var intentionalClose = false;
            var reconnectDelayMs = 300;
            var reconnectTimer = null;
            var hadOpenConnection = false;
            function trySend(socket, payload) {
                try {
                    if (socket && socket.readyState === 1) {
                        socket.send(payload);
                        return true;
                    }
                } catch (_e) {}
                return false;
            }
            function logLevelToken(line) {
                var m = typeof line === "string" ? line.match(/^\\[[^\\]]+\\] \\[([^\\]]+)\\]/) : null;
                return m ? m[1] : null;
            }
            function tokenToLevel(token) {
                if (token === "error") return "error";
                if (token === "warn") return "warn";
                if (token === "info" || token === "log") return "info";
                if (token === "debug") return "debug";
                return null;
            }
            function lineHasModuleTag(line, moduleName) {
                return typeof line === "string" && line.indexOf("[" + moduleName + "]") >= 0;
            }
            function lineMatchesModules(entry, modules) {
                if (!modules || modules.length === 0) return true;
                if (typeof entry.module === "string" && modules.indexOf(entry.module) >= 0) return true;
                for (var i = 0; i < modules.length; i++) {
                    if (lineHasModuleTag(entry.line, modules[i])) return true;
                }
                return false;
            }
            function normalizeLevelList(levels) {
                if (!Array.isArray(levels)) return [];
                var out = [];
                var seen = new Set();
                for (var i = 0; i < levels.length; i++) {
                    var level = String(levels[i]);
                    if (level !== "error" && level !== "warn" && level !== "info" && level !== "debug") continue;
                    if (seen.has(level)) continue;
                    seen.add(level);
                    out.push(level);
                }
                return out;
            }
            function normalizeModuleList(modules) {
                if (!Array.isArray(modules)) return undefined;
                var out = [];
                for (var i = 0; i < modules.length; i++) {
                    var name = String(modules[i]).trim();
                    if (name !== "") out.push(name);
                }
                if (out.length === 0) return undefined;
                return out;
            }
            function allBucketsFull(buckets, levels, n) {
                for (var i = 0; i < levels.length; i++) {
                    if (buckets[levels[i]].length < n) return false;
                }
                return true;
            }
            function collectConsoleLogs(n, levels, modules) {
                if (levels.length === 0) return [];
                var levelSet = new Set(levels);
                var bucketOrder = ["error", "warn", "info", "debug"];
                var buckets = { error: [], warn: [], info: [], debug: [] };
                var seenByBucket = {
                    error: new Set(),
                    warn: new Set(),
                    info: new Set(),
                    debug: new Set(),
                };
                for (var i = buf.length - 1; i >= 0; i--) {
                    var entry = buf[i];
                    if (!lineMatchesModules(entry, modules)) continue;
                    var level = tokenToLevel(logLevelToken(entry.line));
                    if (!level || !levelSet.has(level)) continue;
                    if (buckets[level].length >= n) continue;
                    var seen = seenByBucket[level];
                    if (seen.has(entry.line)) continue;
                    seen.add(entry.line);
                    buckets[level].push(entry.line);
                    if (allBucketsFull(buckets, levels, n)) break;
                }
                var out = [];
                for (var j = 0; j < bucketOrder.length; j++) {
                    var lvl = bucketOrder[j];
                    if (!levelSet.has(lvl)) continue;
                    if (buckets[lvl].length === 0) continue;
                    out = out.concat(buckets[lvl]);
                }
                return out;
            }
            function sendConsoleLogs(socket, id, lines) {
                var ok = JSON.stringify({ type: "consoleLogsResult", id: id, lines: lines });
                if (!trySend(socket, ok)) {
                    trySend(socket, JSON.stringify({ type: "consoleLogsError", id: id, message: "send failed" }));
                }
            }
            function sendActiveSceneSource(socket, id, source) {
                var ok = JSON.stringify({ type: "activeSceneSourceResult", id: id, source: source });
                if (!trySend(socket, ok)) {
                    trySend(socket, JSON.stringify({ type: "activeSceneSourceError", id: id, message: "send failed" }));
                }
            }
            function onGetConsoleLogs(msg, socket) {
                if (msg.type !== "getConsoleLogs") return false;
                if (typeof msg.id !== "string" || typeof msg.n !== "number") return false;
                var levels = normalizeLevelList(msg.levels);
                if (levels.length === 0) return false;
                var modules = normalizeModuleList(msg.modules);
                var n = Math.min(10000, Math.max(1, Math.floor(msg.n)));
                var lines = collectConsoleLogs(n, levels, modules);
                sendConsoleLogs(socket, msg.id, lines);
                return true;
            }
            function onGetActiveSceneSource(msg, socket) {
                if (msg.type !== "getActiveSceneSource") return false;
                if (typeof msg.id !== "string") return false;
                var fn = globalThis.__galacticadDevGetActiveSceneSource;
                if (typeof fn !== "function") {
                    sendActiveSceneSource(socket, msg.id, "");
                    return true;
                }
                try {
                    var s = fn();
                    sendActiveSceneSource(socket, msg.id, typeof s === "string" ? s : String(s));
                } catch (e) {
                    var em = e && e.message ? String(e.message) : String(e);
                    var err = JSON.stringify({ type: "activeSceneSourceError", id: msg.id, message: em });
                    if (!trySend(socket, err)) {
                        trySend(socket, JSON.stringify({ type: "activeSceneSourceError", id: msg.id, message: "send failed" }));
                    }
                }
                return true;
            }
            function onMessage(event) {
                var data = event.data;
                if (typeof data !== "string") return;
                var msg;
                try { msg = JSON.parse(data); } catch (_e) { return; }
                var socket = event.target;
                if (msg.type === "reload") {
                    intentionalClose = true;
                    if (reconnectTimer) {
                        clearTimeout(reconnectTimer);
                        reconnectTimer = null;
                    }
                    try { socket.close(); } catch (_c) {}
                    window.location.reload();
                    return;
                }
                if (msg.type === "exportAgentTestcase" && typeof msg.id === "string") {
                    try {
                        var cap = globalThis.__galacticadExportAgentTestcase;
                        if (typeof cap !== "function") {
                            trySend(socket, JSON.stringify({ type: "agentTestcaseError", id: msg.id, message: "no handler" }));
                            return;
                        }
                        var atc = cap();
                        var out = JSON.stringify({ type: "agentTestcaseResult", id: msg.id, data: atc });
                        if (!trySend(socket, out)) {
                            trySend(socket, JSON.stringify({ type: "agentTestcaseError", id: msg.id, message: "send failed" }));
                        }
                    } catch (e) {
                        var em = (e && e.message) ? e.message : String(e);
                        trySend(socket, JSON.stringify({ type: "agentTestcaseError", id: msg.id, message: em }));
                    }
                    return;
                }
                if (msg.type === "agentRender" && typeof msg.id === "string" && msg.payload != null && typeof msg.payload === "object") {
                    var run = globalThis.__galacticadAgentRender;
                    if (typeof run !== "function") {
                        trySend(socket, JSON.stringify({ type: "agentRenderResult", id: msg.id, error: "no handler" }));
                        return;
                    }
                    Promise.resolve(run(msg.payload))
                        .then(function (out) {
                            var o = out || {};
                            trySend(
                                socket,
                                JSON.stringify({
                                    type: "agentRenderResult",
                                    id: msg.id,
                                    pngBase64: o.pngBase64,
                                    error: o.error,
                                }),
                            );
                        })
                        .catch(function (e) {
                            var em = e && e.message ? e.message : String(e);
                            trySend(socket, JSON.stringify({ type: "agentRenderResult", id: msg.id, error: em }));
                        });
                    return;
                }
                if (msg.type === "captureScreenshot" && typeof msg.id === "string") {
                    var shot = globalThis.__galacticadCaptureScreenshot;
                    if (typeof shot !== "function") {
                        trySend(socket, JSON.stringify({ type: "screenshotResult", id: msg.id, error: "no handler" }));
                        return;
                    }
                    Promise.resolve(shot(msg.viewport))
                        .then(function (out) {
                            var o = out || {};
                            trySend(
                                socket,
                                JSON.stringify({
                                    type: "screenshotResult",
                                    id: msg.id,
                                    pngBase64: o.pngBase64,
                                    error: o.error,
                                }),
                            );
                        })
                        .catch(function (e) {
                            var em = e && e.message ? e.message : String(e);
                            trySend(socket, JSON.stringify({ type: "screenshotResult", id: msg.id, error: em }));
                        });
                    return;
                }
                void onGetConsoleLogs(msg, socket);
                void onGetActiveSceneSource(msg, socket);
            }
            function scheduleReconnect() {
                if (intentionalClose) return;
                if (reconnectTimer) clearTimeout(reconnectTimer);
                reconnectTimer = setTimeout(function () {
                    reconnectTimer = null;
                    connect();
                }, reconnectDelayMs);
                reconnectDelayMs = Math.min(Math.floor(reconnectDelayMs * 1.5), 1000);
            }
            // Poll until the app finishes registering the agent render handler,
            // then send a "agentBridgeReady" message. The server waits for this
            // signal in broadcastReloadAndAwaitReady so callers chaining
            // /_refresh -> /_agent/render don't race the post-reload handler
            // registration.
            function notifyWhenReady(socket) {
                var attempts = 0;
                function tick() {
                    if (socket.readyState !== 1) return;
                    var ready = typeof globalThis.__galacticadAgentRender === "function";
                    if (ready) {
                        trySend(socket, JSON.stringify({ type: "agentBridgeReady" }));
                        return;
                    }
                    attempts++;
                    if (attempts > 600) return; // ~60s — stop polling rather than spin forever
                    setTimeout(tick, 100);
                }
                tick();
            }
            function connect() {
                var socket = new WebSocket("ws://" + location.host);
                socket.addEventListener("message", onMessage);
                socket.addEventListener("open", function () {
                    reconnectDelayMs = 300;
                    if (hadOpenConnection) {
                        // We had a live connection that dropped and just reconnected — the
                        // devserver restarted (e.g. a build/** edit re-exec'd it), so the bundle
                        // this page is running may be stale. Reload to pick up the new code.
                        // Server-initiated reloads use the 'reload' message + intentionalClose
                        // path (page reloads directly), so this only fires for an unexpected
                        // drop+recover such as a restart.
                        window.location.reload();
                        return;
                    }
                    hadOpenConnection = true;
                    notifyWhenReady(socket);
                });
                socket.addEventListener("close", function () {
                    if (!intentionalClose) scheduleReconnect();
                });
                socket.addEventListener("error", function () {
                    try { socket.close(); } catch (_e) {}
                });
            }
            connect();
        })();
        </script>`

export class DevServer {
    httpServer!: http.Server
    wsServer!: WebSocketServer
    private readonly bridge: BrowserBridge
    /** Headless agent Chromium launched via puppeteer in AGENT mode; closed on shutdown. */
    #agentBrowser: Browser | null = null

    private constructor(
        public serveRoot: string,
        public port: number,
        public indexFileName: string,
        bridge: BrowserBridge,
    ) {
        this.bridge = bridge
    }

    static async create(
        serveRoot: string,
        port: number,
        indexFileName = "index.html",
        log = console.log,
        err = console.error,
        options?: { runFile: string; pid: number },
    ): Promise<DevServer> {
        const bridge = new BrowserBridge()

        const {
            server,
            port: actualPort,
            wss,
        } = await listen(serveRoot, port, INJECTED_BRIDGE_SCRIPT, indexFileName, bridge, log, err)
        const instance = new DevServer(serveRoot, actualPort, indexFileName, bridge)
        instance.httpServer = server
        instance.wsServer = wss

        // Write the run file as soon as the port is bound, BEFORE launching headless
        // Chromium: the Makefile's _start polls for this file with a timeout, and a slow
        // browser launch would otherwise leave a live server that _start believes failed —
        // bound to the port but with no run file, so every retry hits "port in use".
        if (options) {
            const payload: RunFileData = { pid: options.pid, port: actualPort }
            await fs.writeFile(options.runFile, JSON.stringify(payload, null, 2))
        }

        if (AGENT_MODE && options) {
            // Optional query string appended to the headless tab URL so page-load
            // flags (e.g. `?sfccThreads=1` for the M6d rayon export path) can be
            // exercised headlessly. Inert unless GCAD_AGENT_PAGE_QUERY is set.
            const pageQuery = process.env.GCAD_AGENT_PAGE_QUERY?.trim()
            const url = `http://127.0.0.1:${actualPort}/${pageQuery ? `?${pageQuery.replace(/^\?/, "")}` : ""}`
            try {
                const executablePath = await resolveChromiumExecutable()
                if (!executablePath) {
                    err(`agent mode: chromium not found in ${PUPPETEER_BROWSERS_DIR}/ (run 'make setup')`)
                } else {
                    const browser = await puppeteer.launch({
                        executablePath,
                        headless: true,
                        // Puppeteer would otherwise tear down the browser before our SIGTERM handler runs `shutdown()`.
                        handleSIGINT: false,
                        handleSIGTERM: false,
                        handleSIGHUP: false,
                        args: ["--enable-unsafe-webgpu", "--window-size=8192,8192"],
                    })
                    instance.#agentBrowser = browser
                    const page = await browser.newPage()
                    await page.goto(url)
                    log(`Agent headless Chromium → ${url}`)
                }
            } catch (e) {
                err(`agent headless Chromium launch failed: ${e}`)
            }
        }

        log(
            `Live reload + bridge WebSocket on http://localhost:${actualPort} (same port as HTTP); GET /_logs GET /_sceneSource GET|POST /_refresh; GET /_agent/capture-testcase; GET /_agent/screenshot?viewport=sdf|mesh (live viewport PNG); GET|POST /_agent/render (JSON); POST /_agent/render/testcase-body (YAML); GET testcase: /_agent/render/testcase/<path>?mode=… (path resolved: cwd → test/testcases/ → absolute)`,
        )
        return instance
    }

    public reload() {
        this.bridge.broadcastReload()
    }

    /**
     * Closes agent headless Chromium (puppeteer), then closes the WebSocket server and HTTP server.
     */
    async shutdown(): Promise<void> {
        const browser = this.#agentBrowser
        this.#agentBrowser = null
        if (browser != null) {
            const proc = browser.process()
            try {
                await Promise.race([
                    browser.close(),
                    new Promise<never>((_, reject) => {
                        setTimeout(() => reject(new Error("browser.close timeout")), 5000).unref()
                    }),
                ])
            } catch (e) {
                console.error(e)
                proc?.kill("SIGKILL")
            }
        }
        // Force-close WebSocket clients first. `wsServer.close()` stops listening but leaves
        // existing client connections open, and `httpServer.closeAllConnections()` doesn't
        // cover upgraded WS sockets — so the browser's persistent bridge socket would keep
        // `httpServer.close()` from ever completing. That made a build/** re-exec hang in
        // shutdown() until the user manually refreshed the tab to drop the socket.
        for (const client of this.wsServer.clients) {
            try {
                client.terminate()
            } catch {
                /* already gone */
            }
        }
        this.httpServer.closeAllConnections()
        await Promise.all([
            new Promise<void>(resolve => this.wsServer.close(() => resolve())),
            new Promise<void>(resolve => this.httpServer.close(() => resolve())),
        ])
    }

    public close() {
        this.httpServer.closeAllConnections()
        this.wsServer.close()
    }
}

function createHttpServer(
    dir: string,
    clientScript: string,
    indexFileName: string,
    bridge: BrowserBridge,
    log = console.log,
    err = console.error,
) {
    const contentType: Record<string, string> = {
        ".css": "text/css",
        ".gif": "image/gif",
        ".html": "text/html",
        ".jpeg": "image/jpeg",
        ".jpg": "image/jpeg",
        ".js": "text/javascript",
        ".json": "application/json",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".wasm": "application/wasm",
    }

    const defaultContentType = "application/octet-stream"

    const repoRoot = REPO_ROOT_FOR_HTTP

    function writeAccessLogLine(req: http.IncomingMessage, pathname: string, search: string): void {
        const stamp = new Date().toLocaleTimeString(undefined, { hour12: false })
        const line = `${stamp} HTTP ${req.method ?? "?"} ${pathname}${search}\n`
        try {
            // Sync write so lines show up immediately in nohup → .devserver.log (stdout can be block-buffered when not a TTY).
            writeSync(1, line)
        } catch {
            log(line.trimEnd())
        }
    }

    async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
        const url = new URL(req.url ?? "/", "http://localhost")
        const pathname = url.pathname
        writeAccessLogLine(req, pathname, url.search)

        if (pathname === "/_logs") {
            if (req.method !== "GET") {
                res.writeHead(405, { "content-type": "text/plain; charset=utf-8", Allow: "GET", "Access-Control-Allow-Origin": "*" })
                res.end("method not allowed")
                return
            }
            const query = parseLogQuery(url)
            const lines = await bridge.requestConsoleLogs(query)
            // `null` means the bridge had no tab to ask (no client connected) or
            // the RPC timed out — distinct from a connected tab returning an
            // empty buffer (`[]` → empty 200). Report it as 503 like `/_refresh`
            // so callers can tell "no browser" apart from "0 matching entries".
            if (lines === null) {
                res.writeHead(503, { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" })
                res.end("no browser tab connected to this devserver's bridge (or the log request timed out)\n")
                return
            }
            res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" })
            res.end(lines.join("\n"))
            return
        }

        if (pathname === "/_sceneSource") {
            if (req.method !== "GET") {
                res.writeHead(405, { "content-type": "text/plain; charset=utf-8", Allow: "GET", "Access-Control-Allow-Origin": "*" })
                res.end("method not allowed")
                return
            }
            const source = await bridge.requestActiveSceneSource()
            res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" })
            res.end(source ?? "")
            return
        }

        if (pathname === "/_refresh") {
            if (req.method !== "GET" && req.method !== "POST") {
                res.writeHead(405, {
                    "content-type": "text/plain; charset=utf-8",
                    Allow: "GET, POST",
                    "Access-Control-Allow-Origin": "*",
                })
                res.end("method not allowed")
                return
            }
            // Broadcast reload, then wait for a fresh WebSocket connection from
            // the reloaded page. This lets agent automation chain `_refresh`
            // → render without a manual sleep — the response only returns once
            // the bridge is ready to deliver RPCs to the new page. The 8s
            // timeout is empirically generous for headless Chromium startup.
            const result = await bridge.broadcastReloadAndAwaitReady(8000)
            if (result.status === "ok") {
                res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" })
                res.end("ok\n")
                return
            }
            if (result.status === "no-clients") {
                res.writeHead(503, { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" })
                res.end("no browser clients connected — nothing to reload\n")
                return
            }
            // timeout
            res.writeHead(504, { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" })
            res.end("timed out waiting for browser to reconnect after reload (8s)\n")
            return
        }

        if (pathname === "/_agent/capture-testcase") {
            if (req.method !== "GET") {
                res.writeHead(405, {
                    "content-type": "text/plain; charset=utf-8",
                    Allow: "GET",
                    "Access-Control-Allow-Origin": "*",
                })
                res.end("method not allowed")
                return
            }
            const data = await bridge.requestAgentTestcase()
            if (!data) {
                res.writeHead(503, {
                    "content-type": "text/plain; charset=utf-8",
                    "Access-Control-Allow-Origin": "*",
                })
                res.end("no testcase (browser disconnected, capture threw, or timed out — ensure the app is open with an active document)")
                return
            }
            let yamlBody: string
            try {
                const tc = normalizeAgentTestcaseFromBridge(data)
                yamlBody = serializeAgentTestcaseYaml(tc)
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e)
                res.writeHead(500, { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" })
                res.end(`agent testcase serialization failed: ${msg}`)
                return
            }
            res.writeHead(200, {
                "content-type": "application/x-yaml; charset=utf-8",
                "Access-Control-Allow-Origin": "*",
            })
            res.end(yamlBody)
            return
        }

        if (pathname === "/_agent/screenshot") {
            if (req.method !== "GET") {
                res.writeHead(405, { "content-type": "text/plain; charset=utf-8", Allow: "GET", "Access-Control-Allow-Origin": "*" })
                res.end("method not allowed")
                return
            }
            // Literal PNG of the on-screen viewable area of one viewport (visible region only — the editor
            // overlay is cropped out). Captured from the live frame in the connected browser; this does NOT
            // rebuild the scene from params (that's GET /_agent/render/testcase/...).
            const viewportRaw = (url.searchParams.get("viewport") ?? "sdf").toLowerCase()
            if (viewportRaw !== "sdf" && viewportRaw !== "mesh") {
                res.writeHead(400, { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" })
                res.end(`invalid viewport '${viewportRaw}': expected 'sdf' or 'mesh'`)
                return
            }
            const viewport = viewportRaw as "sdf" | "mesh"
            const out = await bridge.requestScreenshot(viewport)
            if (!out?.pngBase64) {
                // A browser-reported error (e.g. mesh viewer disabled) is the caller's problem → 400;
                // a null/empty result means no tab connected or the RPC timed out → 503 (like /_logs).
                const hasErr = out != null && typeof out.error === "string" && out.error.length > 0
                const errText = hasErr ? out!.error! : "no browser tab connected to this devserver's bridge (or the screenshot request timed out)"
                res.writeHead(hasErr ? 400 : 503, { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" })
                res.end(errText)
                return
            }
            let buf: Buffer
            try {
                buf = Buffer.from(out.pngBase64, "base64")
            } catch {
                res.writeHead(400, { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" })
                res.end("invalid PNG base64 from bridge")
                return
            }
            if (buf.length === 0) {
                res.writeHead(400, { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" })
                res.end("empty PNG from bridge")
                return
            }
            try {
                await writeAgentImagelogPng(repoRoot, "screenshot", viewport, buf)
            } catch (e) {
                console.error(`writeAgentImagelogPng: ${e instanceof Error ? e.message : String(e)}`)
            }
            await endHttpResponseWithBuffer(
                res,
                200,
                {
                    "content-type": "image/png",
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Expose-Headers": "Content-Disposition",
                    "Content-Disposition": `attachment; filename="screenshot-${viewport}.png"`,
                    "Content-Length": String(buf.length),
                },
                buf,
            )
            return
        }

        if (isAgentRenderPathname(pathname)) {
            if (pathname === AGENT_RENDER_TESTCASE_BODY) {
                if (req.method !== "POST") {
                    res.writeHead(405, {
                        "content-type": "text/plain; charset=utf-8",
                        Allow: "POST",
                        "Access-Control-Allow-Origin": "*",
                    })
                    res.end("POST only: send agent testcase YAML as the body (same schema as GET /_agent/capture-testcase)")
                    return
                }
                const rawYaml = await readHttpBody(req)
                if (rawYaml.trim() === "") {
                    res.writeHead(400, { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" })
                    res.end("empty body: expected agent testcase YAML")
                    return
                }
                let tc: AgentTestcase
                try {
                    tc = parseAgentTestcaseYaml(rawYaml)
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e)
                    res.writeHead(400, { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" })
                    res.end(`invalid testcase YAML: ${msg}`)
                    return
                }
                let payload: AgentRenderRequest
                try {
                    payload = mergeAgentRenderRequest(tc, agentRenderQueryOverrides(url))
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e)
                    res.writeHead(400, { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" })
                    res.end(msg)
                    return
                }
                const label = url.searchParams.get("label")?.trim() || "mirror-capture"
                const role = url.searchParams.get("role")?.trim() || payload.mode
                await respondAgentRenderPng(bridge, repoRoot, payload, label, role, "render", res, err)
                return
            }
            if (req.method === "POST") {
                if (pathname !== AGENT_RENDER_ROOT) {
                    res.writeHead(405, {
                        "content-type": "text/plain; charset=utf-8",
                        Allow: "GET",
                        "Access-Control-Allow-Origin": "*",
                    })
                    res.end("POST JSON only at /_agent/render; POST YAML at /_agent/render/testcase-body")
                    return
                }
                const raw = await readHttpBody(req)
                let parsed: Record<string, unknown>
                try {
                    parsed = JSON.parse(raw) as Record<string, unknown>
                } catch {
                    res.writeHead(400, { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" })
                    res.end("invalid JSON body")
                    return
                }
                const testcaseFromBody =
                    typeof parsed.testcase === "string" && parsed.testcase.trim() !== "" ? parsed.testcase.trim() : undefined
                delete parsed.testcase
                const testcaseForFilename = testcaseFromBody
                const label = typeof parsed.label === "string" && parsed.label.trim() !== "" ? parsed.label.trim() : "render"
                const role = typeof parsed.role === "string" && parsed.role.trim() !== "" ? parsed.role.trim() : "render"
                delete parsed.label
                delete parsed.role
                const payload = parsed as unknown as AgentRenderRequest
                const downloadBasename = agentRenderDownloadBasename(testcaseForFilename)
                await respondAgentRenderPng(bridge, repoRoot, payload, label, role, downloadBasename, res, err)
                return
            }
            if (req.method === "GET") {
                const testcase = parseAgentRenderTestcasePathFromPathname(pathname)
                if (testcase === null) {
                    if (pathname === AGENT_RENDER_ROOT) {
                        res.writeHead(400, {
                            "content-type": "text/plain; charset=utf-8",
                            "Access-Control-Allow-Origin": "*",
                        })
                        res.end(
                            "GET testcase render uses path /_agent/render/testcase/<path> where <path> is relative to cwd, relative to ./test/testcases/, or absolute (e.g. /_agent/render/testcase/meshing/foo.yaml?mode=sdf)",
                        )
                        return
                    }
                    if (pathname === AGENT_RENDER_TESTCASE_BODY) {
                        res.writeHead(400, {
                            "content-type": "text/plain; charset=utf-8",
                            "Access-Control-Allow-Origin": "*",
                        })
                        res.end("POST only: same URL with agent testcase YAML in the body (mirror capture from interactive devserver)")
                        return
                    }
                    res.writeHead(400, {
                        "content-type": "text/plain; charset=utf-8",
                        "Access-Control-Allow-Origin": "*",
                    })
                    res.end(
                        "invalid testcase path: expected /_agent/render/testcase/<path> (relative to cwd, relative to ./test/testcases/, or absolute)",
                    )
                    return
                }
                const safePath = await resolveAgentTestcaseFile(testcase)
                if (!safePath) {
                    log(`/_agent/render GET: testcase not found ${JSON.stringify(testcase)}`)
                    res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" })
                    res.end(
                        `testcase file not found: ${testcase} (tried relative to cwd, then ./test/testcases/; absolute paths used as-is)`,
                    )
                    return
                }
                let rawYaml: string
                try {
                    rawYaml = await fs.readFile(safePath, "utf8")
                } catch {
                    res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" })
                    res.end(`testcase file not readable: ${testcase} (${safePath})`)
                    return
                }
                let tc: AgentTestcase
                try {
                    tc = parseAgentTestcaseYaml(rawYaml)
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e)
                    res.writeHead(400, { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" })
                    res.end(`invalid testcase YAML: ${msg}`)
                    return
                }
                let payload: AgentRenderRequest
                try {
                    payload = mergeAgentRenderRequest(tc, agentRenderQueryOverrides(url))
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e)
                    res.writeHead(400, { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" })
                    res.end(msg)
                    return
                }
                const label = url.searchParams.get("label")?.trim() || path.parse(path.basename(testcase)).name || "render"
                const role = url.searchParams.get("role")?.trim() || payload.mode
                const downloadBasename = agentRenderDownloadBasename(testcase)
                await respondAgentRenderPng(bridge, repoRoot, payload, label, role, downloadBasename, res, err)
                return
            }
            res.writeHead(405, {
                "content-type": "text/plain; charset=utf-8",
                Allow: "GET, POST",
                "Access-Control-Allow-Origin": "*",
            })
            res.end("method not allowed")
            return
        }

        log(`${req.method} ${req.url}`)
        let file = path.normalize(path.join(dir, "." + pathname))
        try {
            const stats = await fs.stat(file)
            if (stats.isDirectory()) {
                file = path.join(dir, indexFileName)
            }
            let data = await fs.readFile(file)
            res.writeHead(200, {
                "content-type": contentType[path.extname(file)] || defaultContentType,
                // Cross-origin isolation → crossOriginIsolated === true →
                // SharedArrayBuffer + wasm atomics (rayon thread pool, M6b).
                "Cross-Origin-Opener-Policy": "same-origin",
                "Cross-Origin-Embedder-Policy": "require-corp",
                // Same-origin assets are exempt; this lets any cross-origin
                // sub-resource that opts in load under require-corp.
                "Cross-Origin-Resource-Policy": "cross-origin",
            })
            if (path.extname(file) === ".html") {
                let doc = data.toString()
                if (/<body[^>]*>/i.test(doc)) {
                    doc = doc.replace(/<body[^>]*>/i, m => m + clientScript)
                } else {
                    doc = doc.replace("</body>", clientScript + "</body>")
                }
                data = Buffer.from(doc)
            }
            res.write(data)
            res.end()
        } catch (e: unknown) {
            const code = e && typeof e === "object" && "code" in e ? (e as NodeJS.ErrnoException).code : undefined
            if (code === "ENOENT") {
                res.writeHead(404, {
                    "content-type": "text/plain",
                    "Cross-Origin-Opener-Policy": "same-origin",
                    "Cross-Origin-Embedder-Policy": "require-corp",
                    "Cross-Origin-Resource-Policy": "cross-origin",
                })
                res.end(`404 not found: ${pathname}`)
            } else {
                console.error(`Internal error: ${e}`)
                res.writeHead(500, {
                    "content-type": "text/plain",
                    "Cross-Origin-Opener-Policy": "same-origin",
                    "Cross-Origin-Embedder-Policy": "require-corp",
                    "Cross-Origin-Resource-Policy": "cross-origin",
                })
                res.end("500 unknown server error")
            }
        }
    }

    return http.createServer((req, res) => {
        void handleRequest(req, res).catch(e => {
            err(e)
            if (!res.headersSent) {
                res.writeHead(500, { "content-type": "text/plain" })
                res.end("500 unknown server error")
            }
        })
    })
}

const execFileAsync = promisify(execFile)

/**
 * Best-effort identification of the process(es) currently listening on `port`, so an
 * EADDRINUSE failure can tell the user exactly what is holding it. Uses `lsof` (present on
 * macOS/Linux) then `ps` for each PID. Returns indented `PID <pid>: <command line>` lines,
 * or a fallback note if the holder can't be determined.
 */
async function describePortHolders(port: number): Promise<string> {
    let pids: string[]
    try {
        const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"])
        pids = [...new Set(stdout.split("\n").map(s => s.trim()).filter(Boolean))]
    } catch {
        return "  (could not determine the holding process — is `lsof` installed?)"
    }
    if (pids.length === 0) {
        return "  (no listening process found — the port may be held in another network namespace)"
    }
    const lines: string[] = []
    for (const pid of pids) {
        let cmd = "(unknown command)"
        try {
            const { stdout } = await execFileAsync("ps", ["-p", pid, "-o", "command="])
            const c = stdout.trim()
            if (c) cmd = c
        } catch {
            /* process vanished, or `ps` unavailable */
        }
        lines.push(`  PID ${pid}: ${cmd}`)
    }
    return lines.join("\n")
}

/**
 * Bind the HTTP+WebSocket server on exactly `port`. Unlike the previous auto-incrementing
 * behavior, a port conflict is fatal: we report which process holds the port (PID + command
 * line) and reject, so worktree ports stay predictable. Override with the PORT env var.
 */
function listen(
    dir: string,
    port: number,
    clientScript: string,
    indexFileName: string,
    bridge: BrowserBridge,
    log = console.log,
    err = console.error,
): Promise<{ server: http.Server; port: number; wss: WebSocketServer }> {
    return new Promise((resolve, reject) => {
        const server = createHttpServer(dir, clientScript, indexFileName, bridge, log, err)
        const onError = (e: NodeJS.ErrnoException) => {
            if (e.code === "EADDRINUSE") {
                void describePortHolders(port).then(holders => {
                    err(
                        `Port ${port} is already in use:\n${holders}\n` +
                            "Stop that process, or set the PORT env var to run on a different port.",
                    )
                    server.close(() => reject(new Error(`port ${port} already in use`)))
                })
            } else {
                reject(e)
            }
        }
        server.once("error", onError)
        server.listen(port, () => {
            server.removeListener("error", onError)
            log(`Serving at http://localhost:${port}`)
            const wss = new WebSocketServer({ server }).on("connection", (ws: WebSocket) => {
                ws.on("error", (error: Error) => {
                    err("WebSocket error: ", error)
                })
                ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
                    bridge.handleClientMessage(data, ws)
                })
                ws.on("close", () => {
                    bridge.notifyClientClosed(ws)
                })
                bridge.notifyClientConnected()
            })
            bridge.setWsServer(wss)
            resolve({ server, port, wss })
        })
    })
}
