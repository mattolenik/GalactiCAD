/**
 * Render worker - owns WebGPU device and performs all GPU work.
 * Receives messages from main thread (SDFRendererProxy), executes render loop.
 */

import type { MainToWorkerMessage } from "./render-worker-protocol.mjs"
import { RenderWorkerCore } from "./render-worker-core.mjs"

let core: RenderWorkerCore | null = null

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
            if (core) core.render(msg)
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
            if (core) core.resize(msg.fullWidth, msg.fullHeight)
            break
        case "writeBuffers":
            if (core) core.writeBuffers(msg)
            break
        case "renderMesh":
            if (core) core.handleRenderMesh(msg.src)
            break
        case "benchmark":
            if (core) core.handleBenchmark(msg.durationSeconds, msg.waitForGPU)
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
        self.postMessage({ type: "buildComplete", sceneNodes: [], compiledPosY: {} })
    }
}
