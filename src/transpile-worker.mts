/**
 * Transpile worker - transpiles CAD source (TypeScript/JavaScript) to executable JavaScript.
 * Runs in parallel with the render worker so transpilation of the next edit can overlap
 * with scene build and rendering of the previous edit.
 */

import type { MainToTranspileMessage } from "./transpile-worker-protocol.mjs"
import { installWorkerDevLogBridge } from "./logging/debug-log.mjs"
import { transpileCadSource } from "./cad-transpile.mjs"

installWorkerDevLogBridge("transpile-worker")

self.onmessage = (e: MessageEvent<MainToTranspileMessage>) => {
    const msg = e.data
    if (msg.type !== "transpile") return
    const { src, requestId } = msg
    try {
        const t0 = performance.now()
        const body = transpileCadSource(src)
        const transpileMs = Math.round((performance.now() - t0) * 100) / 100
        self.postMessage({ type: "transpileComplete", body, requestId, transpileMs })
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        self.postMessage({ type: "transpileComplete", error, requestId })
    }
}
