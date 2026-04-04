import fs from "fs/promises"
import http from "http"
import path from "path"
import WebSocket, { WebSocketServer } from "ws"
import { BrowserBridge, type DevServerConsoleLogLevel } from "./devserver-bridge.mjs"

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
const LEVEL_RESPONSE_PREFIX: Record<DevServerConsoleLogLevel, string> = {
    error: "ERR ",
    warn: "WARN ",
    info: "INFO ",
    debug: "DEBUG ",
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

function parseLogQuery(url: URL): DevLogQuery {
    const selectedLevels: DevServerConsoleLogLevel[] = []
    if (url.searchParams.has("err")) selectedLevels.push("error")
    if (url.searchParams.has("warn")) selectedLevels.push("warn")
    if (url.searchParams.has("info")) selectedLevels.push("info")
    if (url.searchParams.has("debug")) selectedLevels.push("debug")
    const levels = selectedLevels.length > 0 ? selectedLevels : ALL_LOG_LEVELS
    const n = clampLogCount(Number(url.searchParams.get("n") ?? "20"))
    const modules = parseModuleFilters(url.searchParams)
    return { n, levels, ...(modules ? { modules } : {}) }
}

function parseLevelFromLine(line: string): DevServerConsoleLogLevel | null {
    const m = line.match(/^\[[^\]]+\] \[([^\]]+)\]/)
    const token = m?.[1]
    if (token === "error") return "error"
    if (token === "warn") return "warn"
    if (token === "info" || token === "log") return "info"
    if (token === "debug") return "debug"
    return null
}

function toPrefixedText(lines: string[]): string {
    const out: string[] = []
    for (const line of lines) {
        const level = parseLevelFromLine(line)
        if (!level) continue
        out.push(`${LEVEL_RESPONSE_PREFIX[level]}${line}`)
    }
    return out.join("\n")
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
                void onGetConsoleLogs(msg, socket);
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
        log(`Live reload + bridge WebSocket on http://localhost:${actualPort} (same port as HTTP); logs endpoint GET http://localhost:${actualPort}/_logs`)
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

    async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
        const url = new URL(req.url ?? "/", "http://localhost")
        const pathname = url.pathname

        if (pathname === "/_logs") {
            if (req.method !== "GET") {
                res.writeHead(405, { "content-type": "text/plain; charset=utf-8", Allow: "GET", "Access-Control-Allow-Origin": "*" })
                res.end("method not allowed")
                return
            }
            const query = parseLogQuery(url)
            const lines = await bridge.requestConsoleLogs(query)
            const text = lines ? toPrefixedText(lines) : ""
            res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" })
            res.end(text)
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
                res.end("404 not found")
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
