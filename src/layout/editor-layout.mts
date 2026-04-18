/**
 * Editor layout utilities for computing preview rect and view center.
 * The WebGPU canvas fills #viewports (behind the translucent editor); camera
 * interaction and raycasting must use the visible preview region — intersection
 * of the actual canvas rect with the area outside the editor overlay — not the
 * full main-panels rect (which breaks when DevTools / mesh viewer share space).
 */

export interface EditorLayout {
    editorOnLeft: boolean
    frac: number
}

/**
 * Intersects the preview canvas rect with the region not covered by the editor overlay
 * (same horizontal/vertical split as CSS --editor-width / --editor-height).
 */
export function visiblePreviewRegion(
    canvasRect: DOMRect,
    mainPanelsRect: DOMRect,
    editorOnLeft: boolean,
    frac: number,
): DOMRect {
    let left = canvasRect.left
    let right = canvasRect.right
    let top = canvasRect.top
    let bottom = canvasRect.bottom

    if (editorOnLeft) {
        const split = mainPanelsRect.left + mainPanelsRect.width * frac
        left = Math.max(left, split)
    } else {
        const split = mainPanelsRect.top + mainPanelsRect.height * frac
        top = Math.max(top, split)
    }

    const w = Math.max(0, right - left)
    const h = Math.max(0, bottom - top)
    return new DOMRect(left, top, w, h)
}

/**
 * Center of `visibleRegion` in shader/canvas UV (0–1). Matches `#screenToClickUV`:
 * u left→right, v = 1 at canvas top (same convention as preview fragment uv).
 */
export function viewCenterUv(canvasRect: DOMRect, visibleRegion: DOMRect): { u: number; v: number } {
    if (canvasRect.width <= 0 || canvasRect.height <= 0) {
        return { u: 0.5, v: 0.5 }
    }
    const cx = visibleRegion.left + visibleRegion.width / 2
    const cy = visibleRegion.top + visibleRegion.height / 2
    const u = (cx - canvasRect.left) / canvasRect.width
    const v = 1 - (cy - canvasRect.top) / canvasRect.height
    return { u, v }
}

/** Horizontal px offset for preview chrome so it clears the editor column (landscape only). */
export function editorSelectionInfoOffset(mainPanelsRect: DOMRect, editorOnLeft: boolean, frac: number): number {
    return editorOnLeft ? mainPanelsRect.width * frac : 0
}

/**
 * Get the current editor layout from mainPanels CSS.
 * editorOnLeft: true when window is wider than tall (landscape).
 */
export function getEditorLayout(mainPanels: HTMLElement): EditorLayout {
    const editorOnLeft = window.innerWidth > window.innerHeight
    const css = getComputedStyle(mainPanels)
    const frac = editorOnLeft
        ? parseFloat(css.getPropertyValue("--editor-width") || "35") / 100
        : parseFloat(css.getPropertyValue("--editor-height") || "22") / 100

    return {
        editorOnLeft,
        frac,
    }
}
