/**
 * Render worker - owns WebGPU device and performs all GPU work.
 * Uses SharedArrayBuffer for per-frame render data when available; otherwise message-driven.
 */

import type { MainToWorkerMessage } from "./render-worker-protocol.mjs"
import { RenderWorkerCore } from "./render-worker-core.mjs"
import { readRenderPayload } from "./shared-render-buffer.mjs"

let core: RenderWorkerCore | null = null
let sharedBuffer: SharedArrayBuffer | null = null
let lastRenderedVersion = 0
let pollHandle: ReturnType<typeof setTimeout> | null = null

/** Pending resize to apply when init completes (avoids race where resize arrives before core exists). */
let pendingResize: { fullWidth: number; fullHeight: number } | null = null

/** Build serialization: only one build at a time; latest request wins. */
let buildInProgress = false
let pendingBuild: { src: string; documentName?: string | null; requestId?: number } | null = null

/** Pending render message for coalescing; used for benchmark/thumbnail which still send render via postMessage. */
let pendingRender: Extract<MainToWorkerMessage, { type: "render" }> | null = null
let renderScheduled = false

function scheduleRender(): void {
    if (renderScheduled || !core) return
    renderScheduled = true
    setTimeout(() => {
        renderScheduled = false
        const msg = pendingRender
        pendingRender = null
        if (core && msg) core.render(msg)
    }, 0)
}

/** When no new frame for this many polls, throttle to reduce idle CPU. */
const IDLE_THROTTLE_MS = 4

function pollLoop(idleCount = 0): void {
    if (!core || !sharedBuffer) return
    const u32 = new Uint32Array(sharedBuffer)
    const version = Atomics.load(u32, 0)
    if (version !== lastRenderedVersion) {
        lastRenderedVersion = version
        const payload = readRenderPayload(sharedBuffer)
        core.renderFromSharedBuffer(sharedBuffer, payload)
        pollHandle = setTimeout(() => pollLoop(0), 0)
    } else {
        const delay = idleCount > 3 ? IDLE_THROTTLE_MS : 0
        pollHandle = setTimeout(() => pollLoop(idleCount + 1), delay)
    }
}

function startPollLoop(): void {
    if (pollHandle != null) return
    pollLoop()
}

function stopPollLoop(): void {
    if (pollHandle != null) {
        clearTimeout(pollHandle)
        pollHandle = null
    }
}

self.onmessage = (e: MessageEvent<MainToWorkerMessage>) => {
    const msg = e.data
    switch (msg.type) {
        case "init":
            handleInit(msg.canvas, msg.sharedBuffer)
            break
        case "build":
            if (core) enqueueBuild(msg.src, msg.documentName, msg.requestId)
            break
        case "render":
            pendingRender = msg
            if (core) {
                if (sharedBuffer) {
                    scheduleRender()
                } else {
                    scheduleRender()
                }
            }
            break
        case "click":
            if (core) core.handleClick(msg.clickUV, msg.shiftKey, msg.altKey, msg.documentName)
            break
        case "doubleClick":
            if (core) core.handleDoubleClick(msg.clickUV, msg.documentName)
            break
        case "hover":
            if (core) core.handleHover(msg.clickUV, msg.altKey, msg.documentName)
            break
        case "resize":
            if (core) {
                core.resize(msg.fullWidth, msg.fullHeight)
            } else {
                pendingResize = { fullWidth: msg.fullWidth, fullHeight: msg.fullHeight }
            }
            break
        case "writeBuffers":
            if (core) core.writeBuffers(msg)
            break
        case "renderMesh":
            if (core) core.handleRenderMesh(msg.src, msg.requestId, msg.documentName)
            break
        case "benchmark":
            if (core) {
                if (pendingRender) {
                    core.render(pendingRender)
                    pendingRender = null
                    if (renderScheduled) {
                        renderScheduled = false
                    }
                }
                core.handleBenchmark(msg.durationSeconds, msg.waitForGPU, msg.requestId)
            }
            break
        case "thumbnail":
            if (core) {
                core.handleThumbnail(msg.src, msg.width, msg.height, msg.requestId, msg.documentName)
            } else {
                self.postMessage({ type: "thumbnailResult", error: "WebGPU not ready", requestId: msg.requestId })
            }
            break
        default:
            console.log("[RenderWorker] unknown message", (msg as { type: string }).type)
    }
}

async function handleInit(canvas: OffscreenCanvas, buf?: SharedArrayBuffer): Promise<void> {
    try {
        core = new RenderWorkerCore()
        await core.init(canvas)
        if (buf) {
            sharedBuffer = buf
            startPollLoop()
        }
        if (pendingResize) {
            core.resize(pendingResize.fullWidth, pendingResize.fullHeight)
            pendingResize = null
        }
        self.postMessage({ type: "ready" })
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error("[RenderWorker] init failed:", err)
        stopPollLoop()
        sharedBuffer = null
        self.postMessage({ type: "initError", error: msg })
    }
}

function enqueueBuild(src: string, documentName?: string | null, requestId?: number): void {
    if (pendingBuild?.requestId != null) {
        self.postMessage({ type: "buildComplete", sceneNodes: [], compiledPosY: [], requestId: pendingBuild.requestId, documentName: pendingBuild.documentName ?? undefined, superseded: true })
    }
    pendingBuild = { src, documentName, requestId }
    if (!buildInProgress) runNextBuild()
}

async function runNextBuild(): Promise<void> {
    const req = pendingBuild
    pendingBuild = null
    if (!req || !core) return
    buildInProgress = true
    try {
        const result = await core.build(req.src, req.documentName)
        if ("superseded" in result) {
            self.postMessage({ type: "buildComplete", sceneNodes: [], compiledPosY: [], requestId: req.requestId, documentName: req.documentName ?? undefined, superseded: true })
            return
        }
        self.postMessage({ type: "buildComplete", sceneNodes: result.sceneNodes, compiledPosY: result.compiledPosY, requestId: req.requestId, documentName: req.documentName ?? undefined })
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error("[RenderWorker] build failed:", err)
        self.postMessage({ type: "buildComplete", sceneNodes: [], compiledPosY: [], error: msg, requestId: req.requestId, documentName: req.documentName ?? undefined })
    } finally {
        buildInProgress = false
        if (pendingBuild) runNextBuild()
    }
}
