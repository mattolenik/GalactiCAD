import type { SDFRenderer } from "../sdf.mjs"
import { base64ToUtf8, type AgentRenderRequest } from "./agent-testcase.mjs"

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
    const w = req.viewportWidth
    const h = req.viewportHeight
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
    const img =
        req.mode === "sdf"
            ? await renderer.agentPreviewPixels(src, cam, vc, rs, w, h, doc)
            : await renderer.agentMeshPreviewPixels(src, cam, vc, rs, meshOpts, w, h, doc)
    return imageDataToPngBase64(img)
}
