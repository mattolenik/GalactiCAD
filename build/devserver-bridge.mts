import type { WebSocketServer } from "ws"

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

/** Browser → server: testcase payload (same shape as `AgentTestcaseJson` in `src/agent-autotest/`). */
export type DevServerAgentTestcaseResultMessage = {
    type: "agentTestcaseResult"
    id: string
    /** Full testcase object; large when scene source is big. */
    data: Record<string, unknown>
}

/** Browser → server: capture failed (no document, no handler, etc.). */
export type DevServerAgentTestcaseErrorMessage = { type: "agentTestcaseError"; id: string; message?: string }

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

export type DevServerToBrowserMessage =
    | DevServerReloadMessage
    | DevServerGetConsoleLogsMessage
    | DevServerGetActiveSceneSourceMessage
    | DevServerExportAgentTestcaseMessage
    | DevServerAgentRenderMessage
export type DevServerFromBrowserMessage =
    | DevServerConsoleLogsResultMessage
    | DevServerConsoleLogsErrorMessage
    | DevServerActiveSceneSourceResultMessage
    | DevServerActiveSceneSourceErrorMessage
    | DevServerAgentTestcaseResultMessage
    | DevServerAgentTestcaseErrorMessage
    | DevServerAgentRenderResultMessage

const DEFAULT_TIMEOUT_MS = 5000
const AGENT_TESTCASE_TIMEOUT_MS = 60_000
const AGENT_RENDER_TIMEOUT_MS = 120_000

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
    private seq = 0

    setWsServer(wsServer: WebSocketServer) {
        this.wsServer = wsServer
    }

    broadcastReload() {
        const msg: DevServerReloadMessage = { type: "reload" }
        const payload = JSON.stringify(msg)
        this.wsServer?.clients.forEach(client => {
            if (client.readyState === 1) client.send(payload)
        })
    }

    /**
     * Ask connected browser tab(s) for up to `n` lines per requested level (newest first, deduped by level).
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
            let sent = false
            wss.clients.forEach(client => {
                if (client.readyState === 1) {
                    client.send(payload)
                    sent = true
                }
            })
            if (!sent) {
                clearTimeout(timeout)
                this.pending.delete(id)
                resolve(null)
            }
        })
    }

    /**
     * Ask connected browser tab(s) for the active document's scene source (Monaco value).
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
            let sent = false
            wss.clients.forEach(client => {
                if (client.readyState === 1) {
                    client.send(payload)
                    sent = true
                }
            })
            if (!sent) {
                clearTimeout(timeout)
                this.pendingSceneSource.delete(id)
                resolve(null)
            }
        })
    }

    /**
     * Ask a connected browser tab to serialize the current scene + camera + mesh export settings
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
            let sent = false
            wss.clients.forEach(client => {
                if (client.readyState === 1) {
                    client.send(payload)
                    sent = true
                }
            })
            if (!sent) {
                clearTimeout(timeout)
                this.pendingAgentTestcase.delete(id)
                resolve(null)
            }
        })
    }

    /**
     * Ask the browser to run `runAgentRenderPipeline` (WebGPU). Payload matches `AgentRenderRequest`.
     */
    requestAgentRender(payload: Record<string, unknown>, timeoutMs = AGENT_RENDER_TIMEOUT_MS): Promise<{ pngBase64?: string; error?: string } | null> {
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
            let sent = false
            wss.clients.forEach(client => {
                if (client.readyState === 1) {
                    client.send(wire)
                    sent = true
                }
            })
            if (!sent) {
                clearTimeout(timeout)
                this.pendingAgentRender.delete(id)
                resolve(null)
            }
        })
    }

    handleClientMessage(raw: Buffer | ArrayBuffer | Buffer[]) {
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
        }
    }
}
