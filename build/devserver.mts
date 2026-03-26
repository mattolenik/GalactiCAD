import fs from "fs/promises"
import http, { type IncomingMessage, type ServerResponse } from "http"
import path from "path"
import WebSocket, { WebSocketServer } from "ws"
import { BrowserBridge } from "./devserver-bridge.mjs"
import { createMcpPostHandler, handleMcpOptions, mcpMethodNotAllowed } from "./devserver-mcp.mjs"

export interface RunFileData {
    pid: number
    port: number
}

/** Ring buffer + MCP WebSocket; `__galacticadDevLogPush` is consumed by `connectMainThreadDevLogToBridge()` in app (see debug-log.mts). Reconnects after devserver restart. */
const INJECTED_BRIDGE_SCRIPT = `
        <script type="module">
        (function () {
            const MAX = 5000;
            const buf = [];
            function push(line) {
                buf.push(line);
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
                if (msg.type === "getConsoleLogs" && msg.id && typeof msg.n === "number") {
                    var n = Math.min(10000, Math.max(1, Math.floor(msg.n)));
                    var lines = buf.slice(-n);
                    var ok = JSON.stringify({ type: "consoleLogsResult", id: msg.id, lines: lines });
                    if (!trySend(socket, ok)) {
                        trySend(socket, JSON.stringify({ type: "consoleLogsError", id: msg.id, message: "send failed" }));
                    }
                }
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
        const mcpPost = createMcpPostHandler(n => bridge.requestConsoleLogs(n))

        const { server, port: actualPort, wss } = await listenWithPortRetry(
            serveRoot,
            port,
            INJECTED_BRIDGE_SCRIPT,
            indexFileName,
            bridge,
            mcpPost,
            log,
            err,
        )
        const instance = new DevServer(serveRoot, actualPort, indexFileName, bridge)
        instance.httpServer = server
        instance.wsServer = wss
        if (options) {
            await fs.writeFile(options.runFile, JSON.stringify({ pid: options.pid, port: actualPort } satisfies RunFileData, null, 2))
        }
        log(`Live reload + MCP WebSocket on http://localhost:${actualPort} (same port as HTTP); MCP POST http://localhost:${actualPort}/mcp`)
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

/** Read raw body (for JSON MCP POST). */
async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
        chunks.push(chunk as Buffer)
    }
    return Buffer.concat(chunks)
}

function createHttpServer(
    dir: string,
    clientScript: string,
    indexFileName: string,
    bridge: BrowserBridge,
    mcpPostHandler: (req: IncomingMessage, res: ServerResponse, parsedBody: unknown) => Promise<void>,
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

    async function handleRequest(req: IncomingMessage, res: ServerResponse) {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname

        if (pathname === "/mcp") {
            if (req.method === "OPTIONS") {
                handleMcpOptions(res)
                return
            }
            if (req.method === "GET" || req.method === "DELETE") {
                mcpMethodNotAllowed(res, req.method)
                return
            }
            if (req.method === "POST") {
                let body: unknown
                try {
                    const raw = await readRequestBody(req)
                    body = raw.length > 0 ? JSON.parse(raw.toString("utf8")) : undefined
                } catch {
                    res.writeHead(400, { "content-type": "application/json", "Access-Control-Allow-Origin": "*" })
                    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32_700, message: "Parse error" }, id: null }))
                    return
                }
                await mcpPostHandler(req, res, body)
                return
            }
            mcpMethodNotAllowed(res, req.method ?? "UNKNOWN")
            return
        }

        log(`${req.method} ${req.url}`)
        let file = path.normalize(path.join(dir, "." + req.url))
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
    mcpPostHandler: (req: IncomingMessage, res: ServerResponse, parsedBody: unknown) => Promise<void>,
    log = console.log,
    err = console.error,
): Promise<{ server: http.Server; port: number; wss: WebSocketServer }> {
    return new Promise((resolve, reject) => {
        function tryPort(p: number) {
            const server = createHttpServer(dir, clientScript, indexFileName, bridge, mcpPostHandler, log, err)
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
