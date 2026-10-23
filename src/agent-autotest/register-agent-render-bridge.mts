import type { AgentRenderRequest } from "./agent-testcase.mjs"
import type { SDFRenderer } from "../sdf.mjs"
import { runAgentRenderPipeline } from "./agent-render-pipeline.mjs"
import { MeshAcceptanceCapture, type AcceptanceRequest } from "./mesh-acceptance-capture.mjs"

/**
 * Exposes `globalThis.__galacticadAgentRender(req)` for the devserver WebSocket bridge.
 * Concurrent `/ _agent/render` calls are serialized in `BrowserBridge.requestAgentRender` (devserver-bridge)
 * so `SDFRenderer` agent preview / mesh export does not supersede in-flight work.
 */
export function registerAgentRenderBridge(renderer: SDFRenderer, beforeRender?: () => void | Promise<void>): void {
    const acceptance = new MeshAcceptanceCapture(renderer)
    const g = globalThis as {
        __galacticadAgentRender?: (req: AgentRenderRequest) => Promise<{ pngBase64?: string; capture?: Record<string, unknown>; error?: string }>
    }
    g.__galacticadAgentRender = async (raw: unknown) => {
        const req = raw as AgentRenderRequest
        try {
            await beforeRender?.()
            if ((raw as AcceptanceRequest).kind === "meshAcceptance") return { capture: await acceptance.run(raw as AcceptanceRequest) }
            const pngBase64 = await runAgentRenderPipeline(renderer, req)
            return { pngBase64 }
        } catch (e) {
            const msg = e instanceof Error ? (e.stack ?? e.message) : String(e)
            return { error: msg }
        }
    }
}
