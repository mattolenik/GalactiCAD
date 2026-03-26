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
        const body = transpileCadSource(src)
        self.postMessage({ type: "transpileComplete", body, requestId })
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        self.postMessage({ type: "transpileComplete", error, requestId })
    }
}
