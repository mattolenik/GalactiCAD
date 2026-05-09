import { CameraController, DOLLY_REF, dollyFromOrthoHalf, type CameraState } from "../controls/camera-controller.mjs"
import type { CameraSettings } from "../storage/settings.mjs"
import { vec3 } from "../vecmat/vector.mjs"

function initialDollyFromCameraSettings(cam: CameraSettings): number {
    let dolly = cam.dollyDistance
    if (dolly === undefined || !Number.isFinite(dolly)) {
        const legacyZoom = cam.zoom
        dolly =
            legacyZoom !== undefined && Number.isFinite(legacyZoom) ? dollyFromOrthoHalf(legacyZoom) : DOLLY_REF
    }
    return dolly
}

/** Minimal host for deriving view matrices without touching the live preview camera. */
function createOffscreenCameraHost(width: number, height: number): import("../controls/camera-controller.mjs").CameraHost {
    const host = document.createElement("div") as unknown as HTMLElement & { canvas: HTMLCanvasElement }
    host.style.cssText = `position:fixed;left:-9999px;top:0;width:${width}px;height:${height}px;pointer-events:none`
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(1, Math.floor(width))
    canvas.height = Math.max(1, Math.floor(height))
    host.appendChild(canvas)
    host.canvas = canvas
    document.body.appendChild(host)
    return host as import("../controls/camera-controller.mjs").CameraHost
}

function cameraStateFromSettings(cam: CameraSettings): CameraState {
    const base: CameraState = {
        rotation: [...cam.rotation] as CameraState["rotation"],
        dollyDistance: initialDollyFromCameraSettings(cam),
        translation: vec3(cam.translation[0], cam.translation[1], cam.translation[2]),
    }
    if (cam.pivot !== undefined) {
        base.pivot = vec3(cam.pivot[0], cam.pivot[1], cam.pivot[2])
    }
    return base
}

/**
 * Match interactive preview camera math for a testcase snapshot (`CameraSettings` + viewCenter).
 * Caller should remove the offscreen host when done (not kept to avoid leaking DOM nodes during automation bursts).
 */
export function computeAgentPreviewCameraParams(
    cam: CameraSettings,
    width: number,
    height: number,
    viewCenter: [number, number],
): {
    cameraState: CameraState
    viewTransform: Float32Array
    cameraPosition: [number, number, number]
    cameraRes: [number, number]
    viewCenter: [number, number]
    dispose: () => void
} {
    const w = Math.max(1, Math.floor(width))
    const h = Math.max(1, Math.floor(height))
    const host = createOffscreenCameraHost(w, h)
    const controls = new CameraController(host, vec3(0, 0, 0), initialDollyFromCameraSettings(cam), 0, Math.PI / 2, null, undefined)
    controls.applyState(cameraStateFromSettings(cam), { emit: false })
    controls.setViewCenter(viewCenter[0], viewCenter[1])
    const eye = controls.cameraPosition
    const dispose = (): void => {
        host.remove()
    }
    return {
        cameraState: controls.state,
        viewTransform: new Float32Array(controls.viewTransform.data),
        cameraPosition: [eye.x, eye.y, eye.z],
        cameraRes: [w, h],
        viewCenter: [viewCenter[0], viewCenter[1]],
        dispose,
    }
}
