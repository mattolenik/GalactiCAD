import type { MeshData } from "../export/export.mjs"
import type { CameraSettings } from "../storage/settings.mjs"
import { computeAgentPreviewCameraParams } from "./agent-preview-camera.mjs"
import type { MeshViewer } from "../components/mesh-viewer.mjs"

const AGENT_MESH_MAX = 2048

/**
 * Renders mesh with the same normal→RGB shader as the interactive mesh viewer (opaque pass).
 * Caller is responsible for obtaining `MeshData` (e.g. `SDFRenderer.renderMesh`).
 */
export async function captureAgentMeshImageData(
    mesh: MeshData,
    camera: CameraSettings,
    viewCenter: [number, number],
    resolutionScale: number,
    width = 1000,
    height = 1000,
): Promise<ImageData> {
    const w = Math.max(1, Math.min(AGENT_MESH_MAX, Math.floor(width)))
    const h = Math.max(1, Math.min(AGENT_MESH_MAX, Math.floor(height)))
    const params = computeAgentPreviewCameraParams(camera, w, h, viewCenter, resolutionScale)
    const wrap = document.createElement("div")
    wrap.style.cssText = `position:fixed;left:-9999px;top:0;width:${w}px;height:${h}px;pointer-events:none`
    const mv = document.createElement("mesh-viewer") as MeshViewer
    mv.setAttribute("data-skip-autostart", "")
    mv.setAttribute("wireframe", "false")
    mv.setAttribute("translucentFaces", "false")
    wrap.appendChild(mv)
    document.body.appendChild(wrap)
    try {
        await mv.ready()
        mv.canvas.width = w
        mv.canvas.height = h
        mv.syncCameraResolutionFromCanvas()
        mv.controls.applyState(params.cameraState, { emit: false })
        mv.setViewCenter(params.viewCenter[0], params.viewCenter[1])
        await mv.setMesh(mesh)
        return await mv.captureFrameToImageData()
    } finally {
        wrap.remove()
        params.dispose()
    }
}
