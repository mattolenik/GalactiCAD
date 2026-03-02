/**
 * Render worker - owns WebGPU device and performs all GPU work.
 * Receives messages from main thread (SDFRendererProxy), executes render loop.
 */

import type { MainToWorkerMessage } from "./render-worker-protocol.mjs"
import { RenderWorkerCore } from "./render-worker-core.mjs"

let core: RenderWorkerCore | null = null

/** Pending resize to apply when init completes (avoids race where resize arrives before core exists). */
let pendingResize: { fullWidth: number; fullHeight: number } | null = null

/** Pending render message for coalescing; overwritten when multiple renders arrive before the scheduled task runs. */
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

self.onmessage = (e: MessageEvent<MainToWorkerMessage>) => {
    const msg = e.data
    switch (msg.type) {
        case "init":
            handleInit(msg.canvas)
            break
        case "build":
            if (core) handleBuild(msg.src, msg.documentName)
            break
        case "render":
            pendingRender = msg
            if (core) scheduleRender()
            break
        case "click":
            if (core) core.handleClick(msg.clickUV, msg.shiftKey, msg.altKey)
            break
        case "doubleClick":
            if (core) core.handleDoubleClick(msg.clickUV)
            break
        case "hover":
            if (core) core.handleHover(msg.clickUV, msg.altKey)
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
            if (core) core.handleRenderMesh(msg.src)
            break
        case "benchmark":
            if (core) {
                // Flush pending render so #lastRenderMsg is set before benchmark runs
                if (pendingRender) {
                    core.render(pendingRender)
                    pendingRender = null
                    if (renderScheduled) {
                        renderScheduled = false
                    }
                }
                core.handleBenchmark(msg.durationSeconds, msg.waitForGPU)
            }
            break
        case "thumbnail":
            if (core) core.handleThumbnail(msg.src, msg.width, msg.height)
            break
        default:
            console.log("[RenderWorker] unknown message", (msg as { type: string }).type)
    }
}

async function handleInit(canvas: OffscreenCanvas): Promise<void> {
    try {
        core = new RenderWorkerCore()
        await core.init(canvas)
        if (pendingResize) {
            core.resize(pendingResize.fullWidth, pendingResize.fullHeight)
            pendingResize = null
        }
        self.postMessage({ type: "ready" })
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error("[RenderWorker] init failed:", err)
        self.postMessage({ type: "initError", error: msg })
    }
}

async function handleBuild(src: string, documentName?: string | null): Promise<void> {
    if (!core) return
    try {
        const { sceneNodes, compiledPosY } = await core.build(src, documentName)
        self.postMessage({ type: "buildComplete", sceneNodes, compiledPosY })
    } catch (err) {
        console.error("[RenderWorker] build failed:", err)
        self.postMessage({ type: "buildComplete", sceneNodes: [], compiledPosY: [] })
    }
}
