import type { CanvasPreviewUvRect } from "../layout/editor-layout.mjs"

/** Treat nearly full-frame rects as uncropped (avoids off-by-one strips). */
export function isFullCanvasPreviewUvRect(rect: CanvasPreviewUvRect): boolean {
    return rect.u0 <= 1e-5 && rect.v0 <= 1e-5 && rect.u1 >= 1 - 1e-5 && rect.v1 >= 1 - 1e-5
}

/**
 * Extract the visible preview subrectangle from a full-canvas agent render.
 * `rect` uses shader UV (v = 0 bottom, v = 1 top); ImageData row 0 is top.
 */
export function cropImageDataToCanvasPreviewUvRect(src: ImageData, rect: CanvasPreviewUvRect): ImageData {
    const w = src.width
    const h = src.height
    const x0 = Math.max(0, Math.min(w, Math.floor(rect.u0 * w)))
    const x1 = Math.max(0, Math.min(w, Math.ceil(rect.u1 * w)))
    const yTop = Math.max(0, Math.min(h, Math.floor((1 - rect.v1) * h)))
    const yBot = Math.max(0, Math.min(h, Math.ceil((1 - rect.v0) * h)))
    const cw = x1 - x0
    const ch = yBot - yTop
    if (cw <= 0 || ch <= 0 || (cw === w && ch === h && x0 === 0 && yTop === 0)) {
        return src
    }
    const out = new ImageData(cw, ch)
    const srcData = src.data
    const dstData = out.data
    for (let row = 0; row < ch; row++) {
        const sy = yTop + row
        const srcRow = (sy * w + x0) * 4
        const dstRow = row * cw * 4
        dstData.set(srcData.subarray(srcRow, srcRow + cw * 4), dstRow)
    }
    return out
}
