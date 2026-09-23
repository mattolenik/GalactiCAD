/**
 * Remote control ("visual proxy") for the devserver.
 *
 * A dedicated headless Chromium (own profile under `.browsers/remote-user-data-dir`) loads the
 * app from this devserver. Its tab is streamed to any number of viewer pages (`GET /_remote`)
 * as JPEG frames via the CDP `Page.startScreencast` API, and viewer pointer/keyboard input is
 * injected back with Puppeteer's `page.mouse` / `page.keyboard` (CDP `Input.*` underneath).
 *
 * The browser is launched lazily on the first viewer WebSocket and kept alive until the
 * devserver shuts down, so an idle devserver costs nothing and a viewer that reconnects
 * (phone tab backgrounded, VPN blip) lands back in the same session. Screencast runs only
 * while at least one viewer is connected; Chromium emits frames only when the compositor
 * produces one, so a static scene is free.
 *
 * Wire protocol (viewer ↔ server over `ws://host:port/_remote/ws`):
 *  - server → viewer, binary: one JPEG per message (raw bytes, no framing).
 *  - server → viewer, text JSON: `{ t: "state", status, message?, width, height, dpr }`.
 *  - viewer → server, text JSON (see `ViewerMessage`).
 */
import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "node:url"
import puppeteer, { type Browser, type CDPSession, type KeyInput, type Page } from "puppeteer"
import type WebSocket from "ws"
import type http from "http"

/** Viewer → server messages. Coordinates are CSS px of the proxied page (viewport == viewer size). */
type ViewerMessage =
    | { t: "hello"; w: number; h: number; dpr?: number }
    | { t: "resize"; w: number; h: number; dpr?: number }
    | { t: "mm"; x: number; y: number }
    | { t: "md"; x: number; y: number; b: number }
    | { t: "mu"; x: number; y: number; b: number }
    | { t: "wh"; x: number; y: number; dx: number; dy: number }
    | { t: "kd"; key: string }
    | { t: "ku"; key: string }
    | { t: "txt"; text: string }
    | { t: "reload" }

type RemoteStatus = "idle" | "launching" | "ready" | "error"

export type RemoteControlOptions = {
    /** URL the proxied tab loads (this devserver's index, loopback). */
    pageUrl: string
    /** Chromium profile dir; persists editor documents / settings across devserver restarts. */
    userDataDir: string
    resolveExecutable: () => Promise<string | null>
    /** Called with the launched Chromium PID so the run file can record it for cold-start reaping. */
    onBrowserPid?: (pid: number) => Promise<void>
    /** Optional shared secret (`GCAD_REMOTE_TOKEN`); when set, `/_remote` and its WS require it. */
    token?: string
    log?: (msg: unknown) => void
    err?: (msg: unknown) => void
}

const VIEWER_HTML_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "devserver-remote-viewer.html")
const DEFAULT_VIEWPORT = { width: 1280, height: 800, dpr: 1 }
const JPEG_QUALITY = 70
/** Drop frames for a viewer whose socket has this much unsent data (slow link) rather than queue forever. */
const VIEWER_MAX_BUFFERED_BYTES = 2 * 1024 * 1024
const MAX_VIEWPORT_DIM = 4096
const TOKEN_COOKIE = "gcad_remote"
const MOUSE_BUTTONS = ["left", "middle", "right"] as const

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
    const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback
    return Math.min(hi, Math.max(lo, n))
}

function parseCookies(header: string | undefined): Record<string, string> {
    const out: Record<string, string> = {}
    for (const part of (header ?? "").split(";")) {
        const i = part.indexOf("=")
        if (i <= 0) continue
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
    }
    return out
}

export class RemoteControl {
    readonly #opts: Required<Pick<RemoteControlOptions, "log" | "err">> & RemoteControlOptions
    #browser: Browser | null = null
    #page: Page | null = null
    #cdp: CDPSession | null = null
    #launch: Promise<void> | null = null
    #status: RemoteStatus = "idle"
    #statusMessage = ""
    #viewers = new Set<WebSocket>()
    #viewport = { ...DEFAULT_VIEWPORT }
    #screencastOn = false
    #closed = false
    /** Serializes all injected input so move/down/up ordering is preserved. */
    #inputChain: Promise<void> = Promise.resolve()
    /** Latest not-yet-dispatched mouse move; updated in place so a burst of moves collapses to one CDP call. */
    #pendingMove: { x: number; y: number } | null = null
    #frames = 0

    constructor(opts: RemoteControlOptions) {
        this.#opts = { log: console.log, err: console.error, ...opts }
    }

    // ── HTTP ────────────────────────────────────────────────────────────────────────────

    /** True if `pathname` belongs to this feature (`/_remote`, `/_remote/...`). */
    static owns(pathname: string): boolean {
        return pathname === "/_remote" || pathname.startsWith("/_remote/")
    }

    #authorized(req: http.IncomingMessage, url: URL): boolean {
        const token = this.#opts.token
        if (!token) return true
        if (url.searchParams.get("token") === token) return true
        return parseCookies(req.headers.cookie)[TOKEN_COOKIE] === token
    }

    async handleHttp(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
        const pathname = url.pathname
        if (!this.#authorized(req, url)) {
            res.writeHead(403, { "content-type": "text/plain; charset=utf-8" })
            res.end("forbidden: missing or wrong remote token (set ?token=… once; GCAD_REMOTE_TOKEN on the server)")
            return
        }
        if (pathname === "/_remote" || pathname === "/_remote/") {
            if (req.method !== "GET") {
                res.writeHead(405, { "content-type": "text/plain; charset=utf-8", Allow: "GET" })
                res.end("method not allowed")
                return
            }
            let html: string
            try {
                html = await fs.readFile(VIEWER_HTML_PATH, "utf8")
            } catch (e) {
                res.writeHead(500, { "content-type": "text/plain; charset=utf-8" })
                res.end(`viewer page missing: ${e instanceof Error ? e.message : String(e)}`)
                return
            }
            const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
            if (this.#opts.token && url.searchParams.get("token") === this.#opts.token) {
                headers["set-cookie"] = `${TOKEN_COOKIE}=${encodeURIComponent(this.#opts.token)}; Path=/_remote; SameSite=Strict; HttpOnly`
            }
            res.writeHead(200, headers)
            res.end(html)
            return
        }
        if (pathname === "/_remote/status") {
            res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
            res.end(JSON.stringify(this.status(), null, 2))
            return
        }
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
        res.end("not found")
    }

    status() {
        return {
            status: this.#status,
            message: this.#statusMessage || undefined,
            viewers: this.#viewers.size,
            screencast: this.#screencastOn,
            viewport: { ...this.#viewport },
            framesSent: this.#frames,
            browserPid: this.#browser?.process()?.pid ?? null,
        }
    }

    // ── Viewer WebSocket ───────────────────────────────────────────────────────────────

    /** True if this upgrade request is a viewer socket (`/_remote/ws`) rather than the app bridge. */
    static isViewerUpgrade(req: http.IncomingMessage): boolean {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname
        return pathname === "/_remote/ws"
    }

    handleViewerSocket(ws: WebSocket, req: http.IncomingMessage): void {
        const url = new URL(req.url ?? "/", "http://localhost")
        if (!this.#authorized(req, url)) {
            ws.close(4403, "forbidden")
            return
        }
        if (this.#closed) {
            ws.close(1012, "devserver shutting down")
            return
        }
        this.#viewers.add(ws)
        this.#opts.log(`remote: viewer connected (${this.#viewers.size} total) from ${req.socket.remoteAddress ?? "?"}`)
        ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
            if (isBinary) return
            let msg: ViewerMessage
            try {
                msg = JSON.parse(data.toString()) as ViewerMessage
            } catch {
                return
            }
            this.#onViewerMessage(msg)
        })
        ws.on("close", () => {
            this.#viewers.delete(ws)
            this.#opts.log(`remote: viewer disconnected (${this.#viewers.size} left)`)
            if (this.#viewers.size === 0) void this.#stopScreencast()
        })
        ws.on("error", e => this.#opts.err(`remote viewer socket: ${e}`))
        this.#sendState(ws)
        // First viewer launches the browser (which arms the screencast once the page loads);
        // a viewer joining an already-running session must (re)arm it explicitly, since the
        // screencast is stopped whenever the viewer count drops to zero.
        void this.#ensureBrowser().then(async () => {
            if (this.#viewers.size === 0 || this.#status !== "ready") return
            if (!this.#screencastOn) await this.#startScreencast()
            // Screencast only emits on compositor changes; a joiner must not stare at a black
            // canvas until something moves, so hand them the current frame explicitly.
            else await this.#kickFrame(ws)
        })
    }

    /**
     * Push a one-off screenshot as a frame. Needed because `Page.startScreencast` emits nothing
     * until the compositor produces a new frame — a static page (restored document, no hover)
     * would otherwise never show up for a viewer.
     */
    async #kickFrame(target?: WebSocket): Promise<void> {
        const cdp = this.#cdp
        if (!cdp) return
        try {
            const shot = (await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: JPEG_QUALITY })) as { data: string }
            this.#broadcastFrame(shot.data, target)
        } catch (e) {
            this.#opts.err(`remote: captureScreenshot failed: ${e}`)
        }
    }

    #sendState(target?: WebSocket): void {
        const payload = JSON.stringify({
            t: "state",
            status: this.#status,
            message: this.#statusMessage || undefined,
            width: this.#viewport.width,
            height: this.#viewport.height,
            dpr: this.#viewport.dpr,
        })
        for (const ws of target ? [target] : this.#viewers) {
            try {
                if (ws.readyState === ws.OPEN) ws.send(payload)
            } catch {
                /* ignore */
            }
        }
    }

    #setStatus(status: RemoteStatus, message = ""): void {
        this.#status = status
        this.#statusMessage = message
        this.#sendState()
    }

    #onViewerMessage(msg: ViewerMessage): void {
        switch (msg.t) {
            case "hello":
            case "resize":
                void this.#applyViewport(msg.w, msg.h, msg.dpr)
                return
            case "mm":
                this.#queueMove(msg.x, msg.y)
                return
            case "md":
            case "mu": {
                const button = MOUSE_BUTTONS[clampInt(msg.b, 0, 2, 0)]
                const { x, y } = msg
                const down = msg.t === "md"
                this.#queueInput(async page => {
                    await page.mouse.move(x, y)
                    if (down) await page.mouse.down({ button })
                    else await page.mouse.up({ button })
                })
                return
            }
            case "wh": {
                const { x, y, dx, dy } = msg
                this.#queueInput(async page => {
                    await page.mouse.move(x, y)
                    await page.mouse.wheel({ deltaX: dx, deltaY: dy })
                })
                return
            }
            case "kd":
            case "ku": {
                const key = msg.key
                const down = msg.t === "kd"
                if (typeof key !== "string" || key.length === 0) return
                this.#queueInput(async page => {
                    try {
                        if (down) await page.keyboard.down(key as KeyInput)
                        else await page.keyboard.up(key as KeyInput)
                    } catch (e) {
                        // Not in Puppeteer's US layout (dead keys, IME, exotic keys). A single
                        // printable char can still be inserted as text on keydown.
                        if (down && [...key].length === 1) await page.keyboard.sendCharacter(key)
                        else if (!/Unknown key/.test(String(e))) throw e
                    }
                })
                return
            }
            case "txt": {
                const text = msg.text
                if (typeof text !== "string" || text.length === 0) return
                this.#queueInput(page => page.keyboard.sendCharacter(text))
                return
            }
            case "reload":
                this.#queueInput(async page => {
                    await page.reload({ waitUntil: "domcontentloaded" })
                })
                return
        }
    }

    // ── Input queue ────────────────────────────────────────────────────────────────────

    #queueInput(fn: (page: Page) => Promise<void>): void {
        // Any non-move event seals the pending move so later moves don't reorder before it.
        this.#pendingMove = null
        this.#enqueue(fn)
    }

    #queueMove(x: number, y: number): void {
        if (this.#pendingMove) {
            this.#pendingMove.x = x
            this.#pendingMove.y = y
            return
        }
        const slot = { x, y }
        this.#pendingMove = slot
        this.#enqueue(async page => {
            if (this.#pendingMove === slot) this.#pendingMove = null
            await page.mouse.move(slot.x, slot.y)
        })
    }

    #enqueue(fn: (page: Page) => Promise<void>): void {
        this.#inputChain = this.#inputChain
            .then(async () => {
                const page = this.#page
                if (!page || page.isClosed()) return
                await fn(page)
            })
            .catch(e => this.#opts.err(`remote input: ${e instanceof Error ? e.message : String(e)}`))
    }

    // ── Browser lifecycle ──────────────────────────────────────────────────────────────

    #ensureBrowser(): Promise<void> {
        if (this.#launch) return this.#launch
        this.#launch = this.#launchBrowser().catch(e => {
            this.#launch = null
            this.#setStatus("error", e instanceof Error ? e.message : String(e))
            this.#opts.err(`remote: browser launch failed: ${e}`)
        })
        return this.#launch
    }

    async #launchBrowser(): Promise<void> {
        this.#setStatus("launching")
        const executablePath = await this.#opts.resolveExecutable()
        if (!executablePath) throw new Error("chromium not installed under .browsers/ (run 'make setup')")
        await fs.mkdir(this.#opts.userDataDir, { recursive: true })
        const browser = await puppeteer.launch({
            executablePath,
            headless: true,
            userDataDir: this.#opts.userDataDir,
            handleSIGINT: false,
            handleSIGTERM: false,
            handleSIGHUP: false,
            defaultViewport: { width: this.#viewport.width, height: this.#viewport.height, deviceScaleFactor: this.#viewport.dpr },
            args: ["--enable-unsafe-webgpu", `--window-size=${this.#viewport.width},${this.#viewport.height}`],
        })
        if (this.#closed) {
            await browser.close().catch(() => {})
            return
        }
        this.#browser = browser
        const pid = browser.process()?.pid
        if (pid != null && this.#opts.onBrowserPid) await this.#opts.onBrowserPid(pid)
        browser.on("disconnected", () => {
            if (this.#browser !== browser) return
            this.#browser = null
            this.#page = null
            this.#cdp = null
            this.#launch = null
            this.#screencastOn = false
            if (!this.#closed) {
                this.#setStatus("error", "browser exited; reconnect to relaunch")
                this.#opts.err("remote: headless Chromium disconnected")
            }
        })

        const pages = await browser.pages()
        const page = pages[0] ?? (await browser.newPage())
        this.#page = page
        const cdp = await page.createCDPSession()
        this.#cdp = cdp
        cdp.on("Page.screencastFrame", (ev: { data: string; sessionId: number }) => {
            void cdp.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {})
            this.#broadcastFrame(ev.data)
        })
        // Screencast does not reliably survive a navigation (livereload, `reload`), so re-arm it.
        page.on("load", () => {
            if (this.#viewers.size > 0) void this.#startScreencast()
        })
        await page.goto(this.#opts.pageUrl, { waitUntil: "domcontentloaded" })
        this.#opts.log(`remote: headless Chromium (pid ${pid ?? "?"}) → ${this.#opts.pageUrl}`)
        this.#setStatus("ready")
        if (this.#viewers.size > 0) await this.#startScreencast()
    }

    async #applyViewport(w: unknown, h: unknown, dpr: unknown): Promise<void> {
        const next = {
            width: clampInt(w, 200, MAX_VIEWPORT_DIM, DEFAULT_VIEWPORT.width),
            height: clampInt(h, 200, MAX_VIEWPORT_DIM, DEFAULT_VIEWPORT.height),
            dpr: clampInt(dpr, 1, 2, 1),
        }
        const changed = next.width !== this.#viewport.width || next.height !== this.#viewport.height || next.dpr !== this.#viewport.dpr
        this.#viewport = next
        const page = this.#page
        if (!changed || !page || page.isClosed()) {
            if (!page) this.#sendState()
            return
        }
        try {
            await page.setViewport({ width: next.width, height: next.height, deviceScaleFactor: next.dpr })
            this.#sendState()
            if (this.#viewers.size > 0) await this.#startScreencast()
        } catch (e) {
            this.#opts.err(`remote: setViewport failed: ${e}`)
        }
    }

    async #startScreencast(): Promise<void> {
        const cdp = this.#cdp
        if (!cdp) return
        try {
            await cdp.send("Page.startScreencast", {
                format: "jpeg",
                quality: JPEG_QUALITY,
                maxWidth: this.#viewport.width * this.#viewport.dpr,
                maxHeight: this.#viewport.height * this.#viewport.dpr,
                everyNthFrame: 1,
            })
            this.#screencastOn = true
        } catch (e) {
            this.#opts.err(`remote: startScreencast failed: ${e}`)
            return
        }
        await this.#kickFrame()
    }

    async #stopScreencast(): Promise<void> {
        const cdp = this.#cdp
        if (!cdp || !this.#screencastOn) return
        this.#screencastOn = false
        try {
            await cdp.send("Page.stopScreencast")
        } catch {
            /* session gone */
        }
    }

    #broadcastFrame(base64: string, target?: WebSocket): void {
        if (this.#viewers.size === 0) return
        const buf = Buffer.from(base64, "base64")
        this.#frames++
        for (const ws of target ? [target] : this.#viewers) {
            if (ws.readyState !== ws.OPEN) continue
            if (ws.bufferedAmount > VIEWER_MAX_BUFFERED_BYTES) continue
            try {
                ws.send(buf, { binary: true })
            } catch {
                /* ignore per-viewer failure */
            }
        }
    }

    /** Close viewers and the headless browser (devserver shutdown). */
    async close(): Promise<void> {
        this.#closed = true
        for (const ws of this.#viewers) {
            try {
                ws.close(1012, "devserver shutting down")
            } catch {
                /* ignore */
            }
        }
        this.#viewers.clear()
        const browser = this.#browser
        this.#browser = null
        this.#page = null
        this.#cdp = null
        if (browser == null) return
        const proc = browser.process()
        try {
            await Promise.race([
                browser.close(),
                new Promise<never>((_, reject) => {
                    setTimeout(() => reject(new Error("browser.close timeout")), 5000).unref()
                }),
            ])
        } catch (e) {
            this.#opts.err(`remote: ${e}`)
            proc?.kill("SIGKILL")
        }
    }
}
