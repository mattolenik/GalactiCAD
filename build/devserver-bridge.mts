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

export type DevServerToBrowserMessage = DevServerReloadMessage | DevServerGetConsoleLogsMessage
export type DevServerFromBrowserMessage = DevServerConsoleLogsResultMessage | DevServerConsoleLogsErrorMessage

const DEFAULT_TIMEOUT_MS = 5000

/**
 * Tracks browser WebSocket clients and supports live reload plus request/response
 * for fetching recent page-console lines from the injected bridge script.
 */
export class BrowserBridge {
    private wsServer: WebSocketServer | null = null
    private readonly pending = new Map<string, { resolve: (v: string[] | null) => void }>()
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
                p.resolve(msg.lines.map(x => String(x)))
            }
            return
        }
        if (msg.type === "consoleLogsError" && typeof msg.id === "string") {
            const p = this.pending.get(msg.id)
            if (p) p.resolve(null)
        }
    }
}
