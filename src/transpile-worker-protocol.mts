/**
 * Message protocol for main thread <-> transpile worker communication.
 */

export type TranspileKind = "build" | "renderMesh" | "thumbnail"

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
    | { type: "transpileComplete"; body?: string; error?: string; requestId: number }
