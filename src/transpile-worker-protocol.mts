/**
 * Message protocol for main thread <-> transpile worker communication.
 */

export type TranspileKind = "build" | "renderMesh" | "thumbnail" | "agentPreview"

export type MainToTranspileMessage = {
    type: "transpile"
    src: string
    requestId: number
    kind: TranspileKind
    documentName?: string
    width?: number
    height?: number
}

export type TranspileToMainMessage =
    | { type: "devLogLine"; line: string; module?: string }
    | { type: "transpileComplete"; body?: string; error?: string; requestId: number; transpileMs?: number }
