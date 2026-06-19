import type { SDFRenderer } from "../sdf.mjs"
import { base64ToUtf8, type AgentRenderRequest } from "./agent-testcase.mjs"
import { cropImageDataToCanvasPreviewUvRect, isFullCanvasPreviewUvRect } from "./crop-agent-preview-image.mjs"
import { imageDataToPngBase64 } from "./image-to-png.mjs"

export const AGENT_RENDER_DEFAULT_DIM = 4096
export const AGENT_RENDER_MAX_DIM = 8192

function resolveDim(value: number | undefined): number {
    if (value === undefined || !Number.isFinite(value) || value <= 0) return AGENT_RENDER_DEFAULT_DIM
    return Math.max(1, Math.min(AGENT_RENDER_MAX_DIM, Math.round(value)))
}

/** Run SDF normal-vector preview or mesh normal RGB capture; returns PNG as base64. */
export async function runAgentRenderPipeline(renderer: SDFRenderer, req: AgentRenderRequest): Promise<string> {
    const src = base64ToUtf8(req.sourceBase64).trim()
    const w = resolveDim(req.viewportWidth) * 2
    const h = resolveDim(req.viewportHeight) * 2
    const cam = req.camera
    const vc = req.viewCenter
    const doc = req.documentName
    const meshOpts = {
        simplifyOnExport: req.meshExport.simplifyOnExport,
        exporter: req.meshExport.exporter,
        exporterTuning: req.meshExport.exporterTuning,
        simplifyTuning: req.meshExport.simplifyTuning,
    }
    let img =
        req.mode === "sdf" ?
            await renderer.agentPreviewPixels(src, cam, vc, w, h, doc, req.isolatedIds ?? [], req.selectedObjectIds ?? [], req.deferredShading)
        :   await renderer.agentMeshPreviewPixels(src, cam, vc, meshOpts, w, h, doc, req.meshOverlay)
    const rect = req.previewUvRect
    if (rect !== undefined && !isFullCanvasPreviewUvRect(rect)) {
        img = cropImageDataToCanvasPreviewUvRect(img, rect)
    }
    return imageDataToPngBase64(img)
}
