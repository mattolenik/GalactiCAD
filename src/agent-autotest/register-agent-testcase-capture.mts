import type { AgentTestcase } from "./agent-testcase.mjs"

type CaptureFn = () => AgentTestcase

let capture: CaptureFn | null = null

/** App calls once at startup; devserver WS uses `globalThis.__galacticadExportAgentTestcase`. */
export function registerAgentTestcaseCapture(fn: CaptureFn): void {
    capture = fn
    const g = globalThis as { __galacticadExportAgentTestcase?: () => AgentTestcase }
    g.__galacticadExportAgentTestcase = () => {
        if (!capture) {
            throw new Error("Agent testcase capture is not registered")
        }
        return capture()
    }
}

/** Same payload as the devserver bridge; for unit tests or callers that avoid globals. */
export function captureAgentTestcaseOrThrow(): AgentTestcase {
    if (!capture) {
        throw new Error("Agent testcase capture is not registered")
    }
    return capture()
}
