import fs from "fs/promises"
import { writeSync } from "node:fs"
import http from "http"
import path from "path"
import { fileURLToPath } from "node:url"
import WebSocket, { WebSocketServer } from "ws"
import { BrowserBridge, type DevServerConsoleLogLevel } from "./devserver-bridge.mjs"
import {
    mergeAgentRenderRequest,
    normalizeAgentTestcaseFromBridge,
    parseAgentTestcaseYaml,
    serializeAgentTestcaseYaml,
    type AgentRenderRequest,
    type AgentTestcase,
} from "../src/agent-autotest/agent-testcase.mjs"

export interface RunFileData {
    pid: number
    port: number
}

type DevLogQuery = {
    n: number
    levels: DevServerConsoleLogLevel[]
    modules?: string[]
}

const ALL_LOG_LEVELS: DevServerConsoleLogLevel[] = ["error", "warn", "info", "debug"]

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

/** Repo root for paths that must stay stable when `cwd` is wrong (e.g. imagelog under `.agents/`). */
const REPO_ROOT_FOR_HTTP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/** POST JSON body only. */
const AGENT_RENDER_ROOT = "/_agent/render"
/** GET testcase file: path after this prefix is relative to `./test/testcases/` (e.g. `meshing/foo.json`). */
const AGENT_RENDER_TESTCASE_PREFIX = "/_agent/render/testcase"

function isAgentRenderPathname(pathname: string): boolean {
    return pathname === AGENT_RENDER_ROOT || pathname === AGENT_RENDER_TESTCASE_PREFIX || pathname.startsWith(`${AGENT_RENDER_TESTCASE_PREFIX}/`)
}

/**
 * Returns relative path under `test/testcases/` or null if missing/unsafe.
 * Pathname is already percent-decoded by `URL` (e.g. spaces); rejects `..` before/after decode.
 */
function parseAgentRenderTestcaseRelativeFromPathname(pathname: string): string | null {
    if (pathname === AGENT_RENDER_TESTCASE_PREFIX) return null
    if (!pathname.startsWith(`${AGENT_RENDER_TESTCASE_PREFIX}/`)) return null
    let rest = pathname.slice(AGENT_RENDER_TESTCASE_PREFIX.length + 1)
    if (!rest || rest.includes("..")) return null
    try {
        rest = decodeURIComponent(rest)
    } catch {
        return null
    }
    if (!rest || rest.includes("..") || rest.startsWith("/")) return null
    return rest
}

/** `$PWD/test/testcases/<relative>` — rejects empty path and obvious `..` traversal only. */
function resolveAgentTestcaseFile(testcaseRelative: string): string | null {
    const rel = testcaseRelative.replace(/\\/g, "/").trim().replace(/^\/+/, "")
    if (!rel || rel.includes("..")) return null
    return path.join(process.cwd(), "test", "testcases", rel)
}

/** Stem of the testcase filename (no `.yaml` / `.yml` / `.json`), or `render` if missing / not under testcases. */
function agentRenderDownloadBasename(testcaseRelative: string | undefined | null): string {
    const rel = (testcaseRelative ?? "").trim()
    if (!rel) return "render"
    const abs = resolveAgentTestcaseFile(rel)
    if (!abs) return "render"
    const bn = path.basename(abs)
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

/** Pipeline / request failures reported by the browser use 400; bridge unavailable / timeout uses 503. */
function agentRenderErrorHttpStatus(out: { pngBase64?: string; error?: string } | null): number {
    if (out != null && typeof out.error === "string" && out.error.length > 0) {
        return 400
    }
    return 503
}

async function respondAgentRenderPng(
    bridge: BrowserBridge,
    repoRoot: string,
    payload: AgentRenderRequest,
    labelSlug: string,
    role: string,
    downloadBasename: string,
    res: http.ServerResponse,
): Promise<void> {
    const out = await bridge.requestAgentRender(payload as unknown as Record<string, unknown>)
    if (!out?.pngBase64) {
        const errText = out?.error ?? "bridge failed (no browser, timeout, or GPU error)"
        const status = agentRenderErrorHttpStatus(out)
        res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" })
        res.end(errText)
        return
    }
    const buf = Buffer.from(out.pngBase64, "base64")
    await writeAgentImagelogPng(repoRoot, labelSlug, role, buf)
    res.writeHead(200, {
        "content-type": "image/png",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Content-Disposition",
        "Content-Disposition": agentRenderPngContentDisposition(downloadBasename, payload.mode),
    })
    res.end(buf)
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
                reconnectDelayMs = Math.min(Math.floor(reconnectDelayMs * 1.5), 8000);
            }
            function connect() {
                var socket = new WebSocket("ws://" + location.host);
                socket.addEventListener("message", onMessage);
                socket.addEventListener("open", function () {
                    reconnectDelayMs = 300;
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
        options?: { runFile: string; pid: number }
    ): Promise<DevServer> {
        const bridge = new BrowserBridge()

        const { server, port: actualPort, wss } = await listenWithPortRetry(
            serveRoot,
            port,
            INJECTED_BRIDGE_SCRIPT,
            indexFileName,
            bridge,
            log,
            err,
        )
        const instance = new DevServer(serveRoot, actualPort, indexFileName, bridge)
        instance.httpServer = server
        instance.wsServer = wss
        if (options) {
            await fs.writeFile(options.runFile, JSON.stringify({ pid: options.pid, port: actualPort } satisfies RunFileData, null, 2))
        }
        log(
            `Live reload + bridge WebSocket on http://localhost:${actualPort} (same port as HTTP); GET /_logs GET /_sceneSource; GET /_agent/capture-testcase; GET|POST /_agent/render (GET testcase: /_agent/render/testcase/<path-under-test-testcases>?mode=…)`,
        )
        return instance
    }

    public reload() {
        this.bridge.broadcastReload()
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
            const text = lines ? lines.join("\n") : ""
            res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" })
            res.end(text)
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
                res.end(
                    "no testcase (browser disconnected, capture threw, or timed out — ensure the app is open with an active document)",
                )
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

        if (isAgentRenderPathname(pathname)) {
            if (req.method === "POST") {
                if (pathname !== AGENT_RENDER_ROOT) {
                    res.writeHead(405, {
                        "content-type": "text/plain; charset=utf-8",
                        Allow: "GET",
                        "Access-Control-Allow-Origin": "*",
                    })
                    res.end("POST is only accepted at /_agent/render")
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
                const label =
                    typeof parsed.label === "string" && parsed.label.trim() !== "" ? parsed.label.trim() : "render"
                const role = typeof parsed.role === "string" && parsed.role.trim() !== "" ? parsed.role.trim() : "render"
                delete parsed.label
                delete parsed.role
                const payload = parsed as unknown as AgentRenderRequest
                const downloadBasename = agentRenderDownloadBasename(testcaseForFilename)
                await respondAgentRenderPng(bridge, repoRoot, payload, label, role, downloadBasename, res)
                return
            }
            if (req.method === "GET") {
                const testcase = parseAgentRenderTestcaseRelativeFromPathname(pathname)
                if (testcase === null) {
                    if (pathname === AGENT_RENDER_ROOT) {
                        res.writeHead(400, {
                            "content-type": "text/plain; charset=utf-8",
                            "Access-Control-Allow-Origin": "*",
                        })
                        res.end(
                            "GET testcase render uses path /_agent/render/testcase/<relative> where <relative> is under ./test/testcases/ (e.g. /_agent/render/testcase/meshing/foo.yaml?mode=sdf)",
                        )
                        return
                    }
                    res.writeHead(400, {
                        "content-type": "text/plain; charset=utf-8",
                        "Access-Control-Allow-Origin": "*",
                    })
                    res.end(
                        "invalid testcase path: expected /_agent/render/testcase/<path> relative to ./test/testcases/; no .. or empty path",
                    )
                    return
                }
                const safePath = resolveAgentTestcaseFile(testcase)
                if (!safePath) {
                    log(`/_agent/render GET: rejected testcase path ${JSON.stringify(testcase)}`)
                    res.writeHead(400, { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" })
                    res.end(
                        "invalid testcase path: relative path under cwd ./test/testcases/ (e.g. meshing/foo.yaml); no ..",
                    )
                    return
                }
                let rawYaml: string
                try {
                    rawYaml = await fs.readFile(safePath, "utf8")
                } catch {
                    res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" })
                    res.end(`testcase file not found: ${testcase} (${safePath})`)
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
                const modeQ = url.searchParams.get("mode")
                const mode = modeQ === "mesh" || modeQ === "sdf" ? modeQ : undefined
                const vw = url.searchParams.get("viewportWidth")
                const vh = url.searchParams.get("viewportHeight")
                const vwn = vw !== null && vw !== "" ? Number(vw) : undefined
                const vhn = vh !== null && vh !== "" ? Number(vh) : undefined
                let payload: AgentRenderRequest
                try {
                    payload = mergeAgentRenderRequest(tc, {
                        mode,
                        ...(Number.isFinite(vwn) ? { viewportWidth: vwn } : {}),
                        ...(Number.isFinite(vhn) ? { viewportHeight: vhn } : {}),
                    })
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e)
                    res.writeHead(400, { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" })
                    res.end(msg)
                    return
                }
                const label = url.searchParams.get("label")?.trim() || path.parse(path.basename(testcase)).name || "render"
                const role = url.searchParams.get("role")?.trim() || payload.mode
                const downloadBasename = agentRenderDownloadBasename(testcase)
                await respondAgentRenderPng(bridge, repoRoot, payload, label, role, downloadBasename, res)
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
                "Cross-Origin-Opener-Policy": "same-origin",
                "Cross-Origin-Embedder-Policy": "credentialless",
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
                    "Cross-Origin-Embedder-Policy": "credentialless",
                })
                res.end(`404 not found: ${pathname}`)
            } else {
                console.error(`Internal error: ${e}`)
                res.writeHead(500, {
                    "content-type": "text/plain",
                    "Cross-Origin-Opener-Policy": "same-origin",
                    "Cross-Origin-Embedder-Policy": "credentialless",
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

function listenWithPortRetry(
    dir: string,
    port: number,
    clientScript: string,
    indexFileName: string,
    bridge: BrowserBridge,
    log = console.log,
    err = console.error,
): Promise<{ server: http.Server; port: number; wss: WebSocketServer }> {
    return new Promise((resolve, reject) => {
        function tryPort(p: number) {
            const server = createHttpServer(dir, clientScript, indexFileName, bridge, log, err)
            const onError = (e: NodeJS.ErrnoException) => {
                if (e.code === "EADDRINUSE") {
                    log(`Port ${p} in use, trying ${p + 1}...`)
                    server.close(() => tryPort(p + 1))
                } else {
                    reject(e)
                }
            }
            server.once("error", onError)
            server.listen(p, () => {
                server.removeListener("error", onError)
                log(`Serving at http://localhost:${p}`)
                const wss = new WebSocketServer({ server }).on("connection", (ws: WebSocket) => {
                    ws.on("error", (error: Error) => {
                        err("WebSocket error: ", error)
                    })
                    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
                        bridge.handleClientMessage(data)
                    })
                })
                bridge.setWsServer(wss)
                resolve({ server, port: p, wss })
            })
        }
        tryPort(port)
    })
}
