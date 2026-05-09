import type { SDFRenderer } from "../sdf.mjs"
import { base64ToUtf8, type AgentRenderRequest } from "./agent-testcase.mjs"
import { cropImageDataToCanvasPreviewUvRect, isFullCanvasPreviewUvRect } from "./crop-agent-preview-image.mjs"

/** Native render size for `/_agent/render` vs testcase `viewportWidth`/`Height` (not post-resize). */
const AGENT_RENDER_VIEWPORT_SCALE = 0.5

async function imageDataToPngBase64(img: ImageData): Promise<string> {
    const canvas = new OffscreenCanvas(img.width, img.height)
    const ctx = canvas.getContext("2d")
    if (!ctx) {
        throw new Error("2D OffscreenCanvas unavailable")
    }
    ctx.putImageData(img, 0, 0)
    const blob = await canvas.convertToBlob({ type: "image/png" })
    const buf = new Uint8Array(await blob.arrayBuffer())
    let binary = ""
    const chunk = 8192
    for (let i = 0; i < buf.length; i += chunk) {
        binary += String.fromCharCode(...buf.subarray(i, Math.min(i + chunk, buf.length)))
    }
    return btoa(binary)
}

/** Run SDF normal-vector preview or mesh normal RGB capture; returns PNG as base64. */
export async function runAgentRenderPipeline(renderer: SDFRenderer, req: AgentRenderRequest): Promise<string> {
    const src = base64ToUtf8(req.sourceBase64).trim()
    const w = Math.max(1, Math.round(req.viewportWidth * AGENT_RENDER_VIEWPORT_SCALE))
    const h = Math.max(1, Math.round(req.viewportHeight * AGENT_RENDER_VIEWPORT_SCALE))
    const cam = req.camera
    const vc = req.viewCenter
    const rs = req.resolutionScale
    const doc = req.documentName
    const meshOpts = {
        simplifyOnExport: req.meshExport.simplifyOnExport,
        exporter: req.meshExport.exporter,
        shrecTuning: req.meshExport.shrecTuning,
        simplifyTuning: req.meshExport.simplifyTuning,
        voxelSizeMm: req.meshExport.voxelSizeMm,
        mdcExportLevers: req.meshExport.mdcExportLevers,
    }
    let img =
        req.mode === "sdf"
            ? await renderer.agentPreviewPixels(src, cam, vc, rs, w, h, doc)
            : await renderer.agentMeshPreviewPixels(src, cam, vc, rs, meshOpts, w, h, doc, req.meshOverlay)
    const rect = req.previewUvRect
    if (rect !== undefined && !isFullCanvasPreviewUvRect(rect)) {
        img = cropImageDataToCanvasPreviewUvRect(img, rect)
    }
    return imageDataToPngBase64(img)
}
