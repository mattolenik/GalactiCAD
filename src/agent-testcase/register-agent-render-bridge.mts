import type { AgentRenderRequest } from "./agent-testcase.mjs"
import type { SDFRenderer } from "../sdf.mjs"
import { runAgentRenderPipeline } from "./agent-render-pipeline.mjs"

/**
 * Exposes `globalThis.__galacticadAgentRender(req)` for the devserver WebSocket bridge.
 */
export function registerAgentRenderBridge(renderer: SDFRenderer): void {
    const g = globalThis as {
        __galacticadAgentRender?: (req: AgentRenderRequest) => Promise<{ pngBase64?: string; error?: string }>
    }
    g.__galacticadAgentRender = async (raw: unknown) => {
        const req = raw as AgentRenderRequest
        try {
            const pngBase64 = await runAgentRenderPipeline(renderer, req)
            return { pngBase64 }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            return { error: msg }
        }
    }
}
