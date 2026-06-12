import { canvasPreviewUvRect } from "../layout/editor-layout.mjs"
import { cropImageDataToCanvasPreviewUvRect, isFullCanvasPreviewUvRect } from "./crop-agent-preview-image.mjs"
import { imageDataToPngBase64 } from "./image-to-png.mjs"

export type ScreenshotViewport = "sdf" | "mesh"

export interface ScreenshotResult {
    pngBase64?: string
    error?: string
}

/**
 * One viewport's capture wiring. `capture()` returns the FULL canvas pixels (backing store); the rects
 * (CSS px) are read at capture time so the visible region — canvas minus the editor overlay — can be
 * cropped out. Return `null` from `capture` when the viewport isn't present (e.g. mesh viewer disabled).
 */
export interface ScreenshotViewportSource {
    capture: () => Promise<ImageData> | null
    canvasRect: () => DOMRect | null
    visibleRegion: () => DOMRect | null
}

export interface ScreenshotBridgeDeps {
    sdf: ScreenshotViewportSource
    mesh: ScreenshotViewportSource
}

/**
 * Exposes `globalThis.__galacticadCaptureScreenshot(viewport)` for the devserver WebSocket bridge.
 * Returns a literal PNG of the on-screen viewable area of the SDF preview or mesh viewer — the visible
 * region only (the part not covered by the Monaco editor overlay), captured from the live frame rather
 * than re-rendered from re-supplied scene params.
 */
export function registerScreenshotBridge(deps: ScreenshotBridgeDeps): void {
    const g = globalThis as {
        __galacticadCaptureScreenshot?: (viewport: ScreenshotViewport) => Promise<ScreenshotResult>
    }
    g.__galacticadCaptureScreenshot = async (viewport: ScreenshotViewport): Promise<ScreenshotResult> => {
        try {
            const src = viewport === "sdf" ? deps.sdf : viewport === "mesh" ? deps.mesh : null
            if (!src) {
                return { error: `unknown viewport: ${String(viewport)} (expected "sdf" or "mesh")` }
            }
            const pending = src.capture()
            if (!pending) {
                return { error: `${viewport} viewport is not available (not enabled / no canvas)` }
            }
            const full = await pending
            const cropped = cropToVisibleRegion(full, src.canvasRect(), src.visibleRegion())
            return { pngBase64: await imageDataToPngBase64(cropped) }
        } catch (e) {
            const msg = e instanceof Error ? (e.stack ?? e.message) : String(e)
            return { error: msg }
        }
    }
}

/** Crop a full-canvas ImageData down to the visible (non-editor) region. Returns the input unchanged when rects are missing or already full-frame. */
function cropToVisibleRegion(full: ImageData, canvasRect: DOMRect | null, visibleRegion: DOMRect | null): ImageData {
    if (!canvasRect || !visibleRegion) return full
    const rect = canvasPreviewUvRect(canvasRect, visibleRegion)
    if (isFullCanvasPreviewUvRect(rect)) return full
    return cropImageDataToCanvasPreviewUvRect(full, rect)
}
