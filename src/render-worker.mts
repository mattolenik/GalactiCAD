/**
 * Render worker - owns WebGPU device and performs all GPU work.
 * Uses SharedArrayBuffer for per-frame render data when available; otherwise message-driven.
 */

import type { MainToWorkerMessage } from "./render-worker-protocol.mjs"
import { applyDebugLogModules, installWorkerDevLogBridge, log } from "./logging/debug-log.mjs"
import { RenderWorkerCore } from "./render-worker-core.mjs"

installWorkerDevLogBridge("render-worker")

let core: RenderWorkerCore | null = null
let sharedBuffer: SharedArrayBuffer | null = null
let lastRenderedVersion = 0
let renderKickScheduled = false

/** Pending resize to apply when init completes (avoids race where resize arrives before core exists). */
let pendingResize: { fullWidth: number; fullHeight: number } | null = null

/** Build serialization: only one build at a time; latest request wins. */
let buildInProgress = false
let pendingBuild: { body: string; documentName?: string | null; requestId?: number } | null = null

/** Pending render message for coalescing; used for benchmark/thumbnail which still send render via postMessage. */
let pendingRender: Extract<MainToWorkerMessage, { type: "render" }> | null = null
let renderScheduled = false
let renderTimeoutId: ReturnType<typeof setTimeout> | null = null

function scheduleRender(): void {
    if (renderScheduled || !core) return
    renderScheduled = true
    renderTimeoutId = setTimeout(() => {
        renderTimeoutId = null
        renderScheduled = false
        const msg = pendingRender
        pendingRender = null
        if (core && msg) core.render(msg)
    }, 0)
}

/**
 * Normal renders are deferred with `setTimeout(0)`. Pick/click/hover can arrive in the same turn
 * right after a sync render (`#syncCameraToWorkerForPick`); without flushing, `handlePickPos` would
 * still use stale `#lastRenderMsg` and return misses after the camera has moved.
 */
function flushPendingRender(): void {
    if (renderTimeoutId !== null) {
        clearTimeout(renderTimeoutId)
        renderTimeoutId = null
    }
    if (!core) return
    const msg = pendingRender
    pendingRender = null
    renderScheduled = false
    if (msg) core.render(msg)
}

function runRenderFromSharedBuffer(): void {
    renderKickScheduled = false
    if (!core || !sharedBuffer) return
    const u32 = new Uint32Array(sharedBuffer)
    const version = Atomics.load(u32, 0)
    if (version !== lastRenderedVersion) {
        lastRenderedVersion = version
        core.renderFromSharedBuffer(sharedBuffer)
    }
}

function scheduleRenderFromKick(): void {
    if (renderKickScheduled || !core || !sharedBuffer) return
    renderKickScheduled = true
    setTimeout(runRenderFromSharedBuffer, 0)
}

function markSABVersionConsumed(): void {
    if (sharedBuffer) {
        lastRenderedVersion = Atomics.load(new Uint32Array(sharedBuffer), 0)
    }
}

self.onmessage = async (e: MessageEvent<MainToWorkerMessage>) => {
    const msg = e.data
    switch (msg.type) {
        case "init":
            handleInit(msg.canvas, msg.sharedBuffer)
            break
        case "renderKick":
            scheduleRenderFromKick()
            break
        case "build":
            if (core) enqueueBuild(msg.body, msg.documentName, msg.requestId)
            break
        case "cancelBuilds":
            cancelBuilds()
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
            if (core) {
                flushPendingRender()
                await core.handleClick(msg.clickUV, msg.shiftKey, msg.altKey, msg.documentName, sharedBuffer ?? undefined)
                markSABVersionConsumed()
            }
            break
        case "doubleClick":
            if (core) {
                flushPendingRender()
                await core.handleDoubleClick(msg.clickUV, msg.documentName, sharedBuffer ?? undefined)
                markSABVersionConsumed()
            }
            break
        case "hover":
            if (core) {
                flushPendingRender()
                await core.handleHover(msg.clickUV, msg.altKey, msg.documentName, msg.hoverRequestId, sharedBuffer ?? undefined)
                markSABVersionConsumed()
            }
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
            if (core) {
                core.handleRenderMesh(
                    msg.body,
                    msg.requestId,
                    msg.documentName,
                    msg.simplifyOnExport,
                    msg.exporter,
                    msg.shrecTuning,
                    msg.simplifyTuning,
                    msg.voxelSizeMm,
                    msg.mdcExportLevers,
                )
            }
            break
        case "benchmark":
            if (core) {
                flushPendingRender()
                core.handleBenchmark(msg.frameCount, msg.waitForGPU, msg.requestId)
            }
            break
        case "thumbnail":
            if (core) {
                core.handleThumbnail(msg.body, msg.width, msg.height, msg.requestId, msg.documentName)
            } else {
                self.postMessage({ type: "thumbnailResult", error: "WebGPU not ready", requestId: msg.requestId })
            }
            break
        case "agentPreview":
            if (core) {
                void core.handleAgentPreview(msg)
            } else {
                self.postMessage({ type: "thumbnailResult", error: "WebGPU not ready", requestId: msg.requestId })
            }
            break
        case "pickPos":
            if (core) {
                flushPendingRender()
                await core.handlePickPos(msg.clickUV, msg.requestId, sharedBuffer ?? undefined)
                markSABVersionConsumed()
            } else {
                self.postMessage({ type: "pickPosResult", hitPos: null, requestId: msg.requestId })
            }
            break
        case "pickObject":
            if (core) {
                flushPendingRender()
                await core.handlePickObject(msg.clickUV, msg.requestId, sharedBuffer ?? undefined)
                markSABVersionConsumed()
            } else {
                self.postMessage({ type: "pickObjectResult", objectId: 0, requestId: msg.requestId })
            }
            break
        case "setBvhEnabled":
            if (core) core.setBvhEnabled(msg.enabled)
            break
        case "setDebugLogModules":
            applyDebugLogModules(msg.modules)
            break
        default:
            log("RenderWorker").info("unknown message", (msg as { type: string }).type)
    }
}

async function handleInit(canvas: OffscreenCanvas, buf?: SharedArrayBuffer): Promise<void> {
    try {
        core = new RenderWorkerCore()
        await core.init(canvas)
        if (buf) {
            sharedBuffer = buf
        }
        if (pendingResize) {
            core.resize(pendingResize.fullWidth, pendingResize.fullHeight)
            pendingResize = null
        }
        self.postMessage({ type: "ready" })
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log("RenderWorker").error("init failed:", err)
        sharedBuffer = null
        self.postMessage({ type: "initError", error: msg })
    }
}

function enqueueBuild(body: string, documentName?: string | null, requestId?: number): void {
    if (pendingBuild?.requestId != null) {
        self.postMessage({ type: "buildComplete", sceneNodes: [], compiledPosY: [], requestId: pendingBuild.requestId, documentName: pendingBuild.documentName ?? undefined, superseded: true })
    }
    pendingBuild = { body, documentName, requestId }
    if (!buildInProgress) runNextBuild()
}

function cancelBuilds(): void {
    core?.cancelBuilds()
    if (pendingBuild?.requestId != null) {
        self.postMessage({ type: "buildComplete", sceneNodes: [], compiledPosY: [], requestId: pendingBuild.requestId, documentName: pendingBuild.documentName ?? undefined, superseded: true })
    }
    pendingBuild = null
}

async function runNextBuild(): Promise<void> {
    const req = pendingBuild
    pendingBuild = null
    if (!req || !core) return
    buildInProgress = true
    try {
        const result = await core.build(req.body, req.documentName)
        if ("superseded" in result) {
            self.postMessage({ type: "buildComplete", sceneNodes: [], compiledPosY: [], requestId: req.requestId, documentName: req.documentName ?? undefined, superseded: true })
            return
        }
        self.postMessage({
            type: "buildComplete",
            sceneNodes: result.sceneNodes,
            compiledPosY: result.compiledPosY,
            requestId: req.requestId,
            documentName: req.documentName ?? undefined,
            timingMs: result.timingMs,
        })
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log("RenderWorker").error("build failed:", err)
        self.postMessage({ type: "buildComplete", sceneNodes: [], compiledPosY: [], error: msg, requestId: req.requestId, documentName: req.documentName ?? undefined })
    } finally {
        buildInProgress = false
        if (pendingBuild) runNextBuild()
    }
}
