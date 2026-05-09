import type { AgentMeshOverlay } from "./agent-testcase.mjs"
import type { MeshData } from "../export/export.mjs"
import type { CameraSettings } from "../storage/settings.mjs"
import { computeAgentPreviewCameraParams } from "./agent-preview-camera.mjs"
import { MeshViewer } from "../components/mesh-viewer.mjs"
import { dollyFromOrthoHalf } from "../controls/camera-controller.mjs"
import { lookAt } from "../vecmat/matrix.mjs"
import { vec3 } from "../vecmat/vector.mjs"

const AGENT_MESH_MAX = 2048

/** Normalize the optional `AgentMeshOverlay` into the strict shape `MeshViewer.applyThumbnailGlyphOverlay` expects. */
function resolveOverlayOptions(overlay: AgentMeshOverlay | undefined): {
    mdcDebugPoints: boolean
    featureGlyphs: { line: boolean; corner: boolean; seam: boolean; ring: boolean }
    mdcCellVertices: boolean
    mdcQefPlanes: boolean
} {
    return {
        mdcDebugPoints: !!overlay?.mdcDebugPoints,
        featureGlyphs: {
            line: !!overlay?.featureGlyphs?.line,
            corner: !!overlay?.featureGlyphs?.corner,
            seam: !!overlay?.featureGlyphs?.seam,
            ring: !!overlay?.featureGlyphs?.ring,
        },
        mdcCellVertices: !!overlay?.mdcCellVertices,
        mdcQefPlanes: !!overlay?.mdcQefPlanes,
    }
}

/**
 * Renders mesh with the same normal→RGB shader as the interactive mesh viewer (opaque pass).
 * Caller is responsible for obtaining `MeshData` (e.g. `SDFRenderer.renderMesh`).
 *
 * `overlay` (optional) enables mesh-viewer debug glyphs / markers in the captured PNG —
 * raw per-edge sample squares, per-class feature glyphs (line/corner/seam/ring), per-cell
 * vertex markers, and/or per-(cell, component) QEF input plane normals. Overlays default
 * to off so existing testcases capture clean meshes.
 */
export async function captureAgentMeshImageData(
    mesh: MeshData,
    camera: CameraSettings,
    viewCenter: [number, number],
    width = 1000,
    height = 1000,
    overlay?: AgentMeshOverlay,
): Promise<ImageData> {
    const w = Math.max(1, Math.min(AGENT_MESH_MAX, Math.floor(width)))
    const h = Math.max(1, Math.min(AGENT_MESH_MAX, Math.floor(height)))
    const params = computeAgentPreviewCameraParams(camera, w, h, viewCenter)
    const wrap = document.createElement("div")
    wrap.style.cssText = `position:fixed;left:-9999px;top:0;width:${w}px;height:${h}px;pointer-events:none`
    const mv = new MeshViewer(null, undefined)
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
        if (overlay) {
            mv.applyThumbnailGlyphOverlay(resolveOverlayOptions(overlay))
        }
        await mv.setMesh(mesh)
        return await mv.captureFrameToImageData()
    } finally {
        wrap.remove()
        params.dispose()
    }
}

const THUMBNAIL_MESH_MAX = 512

/** Same eye / framing as `handleThumbnail` in `render-worker-core.mts` (SDF welcome thumbnails). */
export async function captureMeshThumbnailImageData(
    mesh: MeshData,
    width: number,
    height: number,
    overlay: {
        mdcDebugPoints: boolean
        featureGlyphs: { line: boolean; corner: boolean; seam: boolean; ring: boolean }
    },
): Promise<ImageData> {
    const w = Math.max(1, Math.min(THUMBNAIL_MESH_MAX, Math.floor(width)))
    const h = Math.max(1, Math.min(THUMBNAIL_MESH_MAX, Math.floor(height)))
    const wrap = document.createElement("div")
    wrap.style.cssText = `position:fixed;left:-9999px;top:0;width:${w}px;height:${h}px;pointer-events:none`
    const mv = new MeshViewer(null, undefined)
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
        mv.controls.applyState(
            {
                rotation: [1, 0, 0, 0],
                dollyDistance: dollyFromOrthoHalf(50),
                translation: vec3(0, 0, 0),
            },
            { emit: false },
        )
        const eye = vec3(30, 25, 30)
        const viewMatrix = lookAt(eye, vec3(0, 0, 0), vec3(0, 1, 0))
        mv.controls.cameraPosition.set([eye.x, eye.y, eye.z])
        mv.controls.viewTransform.copy(viewMatrix)
        mv.setViewCenter(0.5, 0.5)
        mv.applyThumbnailGlyphOverlay(overlay)
        await mv.setMesh(mesh)
        return await mv.captureFrameToImageData()
    } finally {
        wrap.remove()
    }
}
