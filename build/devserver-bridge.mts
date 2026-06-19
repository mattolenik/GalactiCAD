import type { WebSocket, WebSocketServer } from "ws"

/** Server → browser: reload the page. */
export type DevServerReloadMessage = { type: "reload" }

export type DevServerConsoleLogLevel = "error" | "warn" | "info" | "debug"

/** Server → browser: return up to `n` log lines (newest first, filtered + deduped in the injected script). */
export type DevServerGetConsoleLogsMessage = {
    type: "getConsoleLogs"
    id: string
    n: number
    levels: DevServerConsoleLogLevel[]
    /** Empty or omitted: all modules. Otherwise keep only entries whose `module` field matches one of these names. */
    modules?: string[]
}

/** Browser → server: log lines for a pending request. */
export type DevServerConsoleLogsResultMessage = { type: "consoleLogsResult"; id: string; lines: string[] }

/** Browser → server: could not produce lines for this request. */
export type DevServerConsoleLogsErrorMessage = { type: "consoleLogsError"; id: string; message?: string }

/** Server → browser: return scene source for the active editor tab (injected script asks `__galacticadDevGetActiveSceneSource`). */
export type DevServerGetActiveSceneSourceMessage = { type: "getActiveSceneSource"; id: string }

/** Browser → server: UTF-8 scene source (empty when no model / no provider). */
export type DevServerActiveSceneSourceResultMessage = { type: "activeSceneSourceResult"; id: string; source: string }

/** Browser → server: failed to read scene source. */
export type DevServerActiveSceneSourceErrorMessage = { type: "activeSceneSourceError"; id: string; message?: string }

/** Server → browser: build agent testcase JSON from the live app (camera + mesh export + base64 source). */
export type DevServerExportAgentTestcaseMessage = { type: "exportAgentTestcase"; id: string }

/** Browser → server: testcase payload (same shape as `AgentTestcase` in `src/agent-autotest/`). */
export type DevServerAgentTestcaseResultMessage = {
    type: "agentTestcaseResult"
    id: string
    /** Full testcase object; large when scene source is big. */
    data: Record<string, unknown>
}

/** Browser → server: capture failed (no document, no handler, etc.). */
export type DevServerAgentTestcaseErrorMessage = { type: "agentTestcaseError"; id: string; message?: string }

/**
 * Browser → server: the injected client has reconnected AND the app finished
 * registering `__galacticadAgentRender`. Used by `broadcastReloadAndAwaitReady`
 * to gate `/_refresh` on a fully-ready bridge, not just a re-opened socket.
 */
export type DevServerAgentBridgeReadyMessage = { type: "agentBridgeReady" }

/** Browser → server: PNG bytes as base64 from agent render pipeline. */
export type DevServerAgentRenderResultMessage = {
    type: "agentRenderResult"
    id: string
    pngBase64?: string
    error?: string
}

/** Server → browser: run agent render (SDF normal preview or mesh normal RGB). */
export type DevServerAgentRenderMessage = {
    type: "agentRender"
    id: string
    /** Same shape as `AgentRenderRequest` in `src/agent-autotest/agent-render-pipeline.mts`. */
    payload: Record<string, unknown>
}

/** Viewport to screenshot: the SDF preview or the mesh viewer. */
export type DevServerScreenshotViewport = "sdf" | "mesh"

/** Server → browser: capture a literal PNG of the on-screen viewable area of one viewport (injected script calls `__galacticadCaptureScreenshot`). */
export type DevServerCaptureScreenshotMessage = { type: "captureScreenshot"; id: string; viewport: DevServerScreenshotViewport }

/** Browser → server: PNG bytes as base64 from the live viewport (visible region only). */
export type DevServerScreenshotResultMessage = { type: "screenshotResult"; id: string; pngBase64?: string; error?: string }

export type DevServerToBrowserMessage =
    | DevServerReloadMessage
    | DevServerGetConsoleLogsMessage
    | DevServerGetActiveSceneSourceMessage
    | DevServerExportAgentTestcaseMessage
    | DevServerAgentRenderMessage
    | DevServerCaptureScreenshotMessage
export type DevServerFromBrowserMessage =
    | DevServerConsoleLogsResultMessage
    | DevServerConsoleLogsErrorMessage
    | DevServerActiveSceneSourceResultMessage
    | DevServerActiveSceneSourceErrorMessage
    | DevServerAgentTestcaseResultMessage
    | DevServerAgentTestcaseErrorMessage
    | DevServerAgentRenderResultMessage
    | DevServerScreenshotResultMessage
    | DevServerAgentBridgeReadyMessage

const DEFAULT_TIMEOUT_MS = 5000
const AGENT_TESTCASE_TIMEOUT_MS = 60_000
const AGENT_RENDER_TIMEOUT_MS = 120_000
const SCREENSHOT_TIMEOUT_MS = 30_000

/** `ws` WebSocket.OPEN — ready to send. */
const WS_OPEN = 1

/**
 * Request/response RPC must target a single tab. Broadcasting to every client races
 * multiple handlers and "first response wins" can be an error from the wrong tab.
 *
 * Prefer `preferred` — the socket of the tab whose app most recently sent
 * `agentBridgeReady`. After a browser-initiated reload the fresh socket is appended
 * AFTER any lingering/other connection in `wss.clients`, so blindly taking the first
 * open socket can keep targeting a stale or blank tab (a server `/_refresh` dodges this
 * only because it reloads every tab at once). Falls back to the first open client.
 */
function sendPayloadToFirstOpenClient(wss: WebSocketServer, payload: string, preferred: WebSocket | null): boolean {
    if (preferred && preferred.readyState === WS_OPEN) {
        try {
            preferred.send(payload)
            return true
        } catch {
            /* preferred went stale; fall through to scan */
        }
    }
    for (const client of wss.clients) {
        if (client === preferred) continue
        if (client.readyState !== WS_OPEN) continue
        try {
            client.send(payload)
            return true
        } catch {
            /* stale socket; try next */
        }
    }
    return false
}

/** Result of `broadcastReloadAndAwaitReady`. */
export type ReloadAwaitResult =
    | { status: "ok" }
    | { status: "no-clients" }
    | { status: "timeout" }

/**
 * Tracks browser WebSocket clients and supports live reload plus request/response
 * for fetching recent page-console lines and the active scene source from the injected bridge script.
 */
export class BrowserBridge {
    private wsServer: WebSocketServer | null = null
    private readonly pending = new Map<string, { resolve: (v: string[] | null) => void }>()
    private readonly pendingSceneSource = new Map<string, { resolve: (v: string | null) => void }>()
    private readonly pendingAgentTestcase = new Map<string, { resolve: (v: Record<string, unknown> | null) => void }>()
    private readonly pendingAgentRender = new Map<
        string,
        { resolve: (v: { pngBase64?: string; error?: string } | null) => void }
    >()
    private readonly pendingScreenshot = new Map<
        string,
        { resolve: (v: { pngBase64?: string; error?: string } | null) => void }
    >()
    /** Only one agent-render RPC at a time so the browser does not supersede `SDFRenderer` pipeline work. */
    private agentRenderChain = Promise.resolve()
    private seq = 0
    /** Monotonic counter incremented on every new WS connection — used by `broadcastReloadAndAwaitReady` to detect a fresh post-reload connection. */
    private connectionEpoch = 0
    /** Resolvers waiting for the next post-reload connection. Resolved by `notifyClientConnected`. */
    private readonly pendingReloadAwaits: Array<() => void> = []
    /** Socket of the tab that most recently sent `agentBridgeReady` (app fully initialized). Preferred RPC target so a browser reload re-points to the live tab instead of a stale connection. Cleared on its disconnect. */
    private lastReadyClient: WebSocket | null = null

    setWsServer(wsServer: WebSocketServer) {
        this.wsServer = wsServer
    }

    /** Called by the devserver's WS `connection` handler on every new client. */
    notifyClientConnected() {
        this.connectionEpoch++
        // Note: we deliberately do NOT resolve `pendingReloadAwaits` here —
        // that happens when the client sends `agentBridgeReady`, which lets us
        // know the app's render handler is actually registered.
    }

    private notifyAgentBridgeReady() {
        if (this.pendingReloadAwaits.length > 0) {
            const resolvers = this.pendingReloadAwaits.splice(0, this.pendingReloadAwaits.length)
            for (const r of resolvers) r()
        }
    }

    broadcastReload() {
        const msg: DevServerReloadMessage = { type: "reload" }
        const payload = JSON.stringify(msg)
        this.wsServer?.clients.forEach(client => {
            if (client.readyState === 1) client.send(payload)
        })
    }

    /**
     * Broadcast a reload and resolve only after the reloaded page sends
     * `agentBridgeReady` — i.e. the WS reconnected AND the app finished
     * registering `__galacticadAgentRender`. This lets agent automation
     * chain `/_refresh` → `/_agent/render` without a manual sleep.
     *
     * Times out with `{ status: "timeout" }` after `timeoutMs`. Returns
     * `{ status: "no-clients" }` if there were no clients to reload.
     */
    broadcastReloadAndAwaitReady(timeoutMs: number): Promise<ReloadAwaitResult> {
        const wss = this.wsServer
        if (!wss || wss.clients.size === 0) {
            return Promise.resolve({ status: "no-clients" })
        }
        return new Promise<ReloadAwaitResult>(resolve => {
            let settled = false
            const settle = (result: ReloadAwaitResult) => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                const idx = this.pendingReloadAwaits.indexOf(onConnect)
                if (idx >= 0) this.pendingReloadAwaits.splice(idx, 1)
                resolve(result)
            }
            const onConnect = () => settle({ status: "ok" })
            const timer = setTimeout(() => settle({ status: "timeout" }), timeoutMs)
            this.pendingReloadAwaits.push(onConnect)
            this.broadcastReload()
        })
    }

    /**
     * Ask one connected browser tab (first open WebSocket) for up to `n` lines per requested level.
     * First response wins. Returns `null` if no client is connected, times out, or the bridge reports failure.
     */
    requestConsoleLogs(
        query: { n: number; levels: DevServerConsoleLogLevel[]; modules?: string[] },
        timeoutMs = DEFAULT_TIMEOUT_MS,
    ): Promise<string[] | null> {
        const wss = this.wsServer
        if (!wss || wss.clients.size === 0) {
            return Promise.resolve(null)
        }
        const id = `clog-${Date.now()}-${++this.seq}`
        return new Promise(resolve => {
            const timeout = setTimeout(() => {
                this.pending.delete(id)
                resolve(null)
            }, timeoutMs)
            const finish = (v: string[] | null) => {
                clearTimeout(timeout)
                this.pending.delete(id)
                resolve(v)
            }
            this.pending.set(id, { resolve: finish })
            const msg: DevServerGetConsoleLogsMessage = {
                type: "getConsoleLogs",
                id,
                n: query.n,
                levels: query.levels,
                ...(query.modules != null && query.modules.length > 0 ? { modules: query.modules } : {}),
            }
            const payload = JSON.stringify(msg)
            if (!sendPayloadToFirstOpenClient(wss, payload, this.lastReadyClient)) {
                clearTimeout(timeout)
                this.pending.delete(id)
                resolve(null)
            }
        })
    }

    /**
     * Ask one connected browser tab for the active document's scene source (editor value).
     * First response wins. Returns `null` if no client, timeout, or bridge reports failure.
     */
    requestActiveSceneSource(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string | null> {
        const wss = this.wsServer
        if (!wss || wss.clients.size === 0) {
            return Promise.resolve(null)
        }
        const id = `ssrc-${Date.now()}-${++this.seq}`
        return new Promise(resolve => {
            const timeout = setTimeout(() => {
                this.pendingSceneSource.delete(id)
                resolve(null)
            }, timeoutMs)
            const finish = (v: string | null) => {
                clearTimeout(timeout)
                this.pendingSceneSource.delete(id)
                resolve(v)
            }
            this.pendingSceneSource.set(id, { resolve: finish })
            const msg: DevServerGetActiveSceneSourceMessage = { type: "getActiveSceneSource", id }
            const payload = JSON.stringify(msg)
            if (!sendPayloadToFirstOpenClient(wss, payload, this.lastReadyClient)) {
                clearTimeout(timeout)
                this.pendingSceneSource.delete(id)
                resolve(null)
            }
        })
    }

    /**
     * Ask one connected browser tab to serialize the current scene + camera + mesh export settings
     * into an agent testcase object (see `src/agent-autotest/`).
     * Requires `registerAgentTestcaseCapture` on the app main thread and `__galacticadExportAgentTestcase`.
     */
    requestAgentTestcase(timeoutMs = AGENT_TESTCASE_TIMEOUT_MS): Promise<Record<string, unknown> | null> {
        const wss = this.wsServer
        if (!wss || wss.clients.size === 0) {
            return Promise.resolve(null)
        }
        const id = `atc-${Date.now()}-${++this.seq}`
        return new Promise(resolve => {
            const timeout = setTimeout(() => {
                this.pendingAgentTestcase.delete(id)
                resolve(null)
            }, timeoutMs)
            const finish = (v: Record<string, unknown> | null) => {
                clearTimeout(timeout)
                this.pendingAgentTestcase.delete(id)
                resolve(v)
            }
            this.pendingAgentTestcase.set(id, { resolve: finish })
            const msg: DevServerExportAgentTestcaseMessage = { type: "exportAgentTestcase", id }
            const payload = JSON.stringify(msg)
            if (!sendPayloadToFirstOpenClient(wss, payload, this.lastReadyClient)) {
                clearTimeout(timeout)
                this.pendingAgentTestcase.delete(id)
                resolve(null)
            }
        })
    }

    /**
     * Ask one connected browser tab to run `runAgentRenderPipeline` (WebGPU). Payload matches `AgentRenderRequest`.
     * Serialized: the next HTTP caller waits until the previous render round-trip finishes (avoids "Superseded" races).
     */
    requestAgentRender(payload: Record<string, unknown>, timeoutMs = AGENT_RENDER_TIMEOUT_MS): Promise<{ pngBase64?: string; error?: string } | null> {
        const run = (): Promise<{ pngBase64?: string; error?: string } | null> => {
            const wss = this.wsServer
            if (!wss || wss.clients.size === 0) {
                return Promise.resolve(null)
            }
            const id = `ard-${Date.now()}-${++this.seq}`
            return new Promise(resolve => {
                const timeout = setTimeout(() => {
                    this.pendingAgentRender.delete(id)
                    resolve(null)
                }, timeoutMs)
                const finish = (v: { pngBase64?: string; error?: string } | null) => {
                    clearTimeout(timeout)
                    this.pendingAgentRender.delete(id)
                    resolve(v)
                }
                this.pendingAgentRender.set(id, { resolve: finish })
                const msg: DevServerAgentRenderMessage = { type: "agentRender", id, payload }
                const wire = JSON.stringify(msg)
                if (!sendPayloadToFirstOpenClient(wss, wire, this.lastReadyClient)) {
                    clearTimeout(timeout)
                    this.pendingAgentRender.delete(id)
                    resolve(null)
                }
            })
        }
        const out = this.agentRenderChain.then(run)
        this.agentRenderChain = out.then(
            () => undefined,
            () => undefined,
        )
        return out
    }

    /**
     * Ask one connected browser tab for a literal PNG of a viewport's on-screen viewable area
     * (visible region only, editor overlay excluded). Captured from the live frame — no scene rebuild.
     * Requires `__galacticadCaptureScreenshot` on the app main thread. Returns `null` if no client / timeout.
     */
    requestScreenshot(viewport: DevServerScreenshotViewport, timeoutMs = SCREENSHOT_TIMEOUT_MS): Promise<{ pngBase64?: string; error?: string } | null> {
        const wss = this.wsServer
        if (!wss || wss.clients.size === 0) {
            return Promise.resolve(null)
        }
        const id = `shot-${Date.now()}-${++this.seq}`
        return new Promise(resolve => {
            const timeout = setTimeout(() => {
                this.pendingScreenshot.delete(id)
                resolve(null)
            }, timeoutMs)
            const finish = (v: { pngBase64?: string; error?: string } | null) => {
                clearTimeout(timeout)
                this.pendingScreenshot.delete(id)
                resolve(v)
            }
            this.pendingScreenshot.set(id, { resolve: finish })
            const msg: DevServerCaptureScreenshotMessage = { type: "captureScreenshot", id, viewport }
            const payload = JSON.stringify(msg)
            if (!sendPayloadToFirstOpenClient(wss, payload, this.lastReadyClient)) {
                clearTimeout(timeout)
                this.pendingScreenshot.delete(id)
                resolve(null)
            }
        })
    }

    /** Called by the devserver's WS `close` handler. Forget a disconnected preferred client so the next RPC falls back cleanly. */
    notifyClientClosed(socket: WebSocket) {
        if (this.lastReadyClient === socket) this.lastReadyClient = null
    }

    handleClientMessage(raw: Buffer | ArrayBuffer | Buffer[], socket?: WebSocket) {
        let data: string
        if (typeof raw === "string") data = raw
        else if (Buffer.isBuffer(raw)) data = raw.toString("utf8")
        else if (Array.isArray(raw)) data = Buffer.concat(raw).toString("utf8")
        else data = Buffer.from(new Uint8Array(raw)).toString("utf8")
        if (!data.startsWith("{")) return
        let msg: DevServerFromBrowserMessage
        try {
            msg = JSON.parse(data) as DevServerFromBrowserMessage
        } catch {
            return
        }
        if (msg.type === "consoleLogsResult" && typeof msg.id === "string" && Array.isArray(msg.lines)) {
            const p = this.pending.get(msg.id)
            if (p) {
                p.resolve(msg.lines.map((x: unknown) => String(x)))
            }
            return
        }
        if (msg.type === "consoleLogsError" && typeof msg.id === "string") {
            const p = this.pending.get(msg.id)
            if (p) p.resolve(null)
            return
        }
        if (msg.type === "activeSceneSourceResult" && typeof msg.id === "string" && typeof msg.source === "string") {
            const p = this.pendingSceneSource.get(msg.id)
            if (p) {
                p.resolve(msg.source)
            }
            return
        }
        if (msg.type === "activeSceneSourceError" && typeof msg.id === "string") {
            const p = this.pendingSceneSource.get(msg.id)
            if (p) p.resolve(null)
            return
        }
        if (msg.type === "agentTestcaseResult" && typeof msg.id === "string" && msg.data !== undefined && typeof msg.data === "object") {
            const p = this.pendingAgentTestcase.get(msg.id)
            if (p) {
                p.resolve(msg.data as Record<string, unknown>)
            }
            return
        }
        if (msg.type === "agentTestcaseError" && typeof msg.id === "string") {
            const p = this.pendingAgentTestcase.get(msg.id)
            if (p) p.resolve(null)
            return
        }
        if (msg.type === "agentRenderResult" && typeof msg.id === "string") {
            const p = this.pendingAgentRender.get(msg.id)
            if (p) {
                p.resolve({ pngBase64: msg.pngBase64, error: msg.error })
            }
            return
        }
        if (msg.type === "screenshotResult" && typeof msg.id === "string") {
            const p = this.pendingScreenshot.get(msg.id)
            if (p) {
                p.resolve({ pngBase64: msg.pngBase64, error: msg.error })
            }
            return
        }
        if (msg.type === "agentBridgeReady") {
            // This tab's app just finished initializing — make it the preferred
            // RPC target so logs/scene/render hit the live tab, not a stale or
            // blank connection that happens to be earlier in wss.clients.
            if (socket) this.lastReadyClient = socket
            this.notifyAgentBridgeReady()
            return
        }
    }
}
