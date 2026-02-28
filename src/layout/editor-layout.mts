/**
 * Editor layout utilities for computing preview rect and view center.
 * Shared between SDFRenderer (visible preview rect) and view center sync.
 */

export interface EditorLayout {
    editorOnLeft: boolean
    frac: number
    visiblePreviewRect(mainRect: DOMRect): DOMRect
    viewCenter(mainRect: DOMRect): { vcx: number; vcy: number; editorOffsetPx: number }
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
        visiblePreviewRect(mainRect: DOMRect): DOMRect {
            if (mainRect.width === 0 || mainRect.height === 0) return mainRect
            if (editorOnLeft) {
                return new DOMRect(
                    mainRect.left + mainRect.width * frac,
                    mainRect.top,
                    mainRect.width * (1 - frac),
                    mainRect.height
                )
            }
            return new DOMRect(
                mainRect.left,
                mainRect.top + mainRect.height * frac,
                mainRect.width,
                mainRect.height * (1 - frac)
            )
        },
        viewCenter(mainRect: DOMRect): { vcx: number; vcy: number; editorOffsetPx: number } {
            const vcx = editorOnLeft ? (frac + 1.0) / 2 : 0.5
            const vcy = editorOnLeft ? 0.5 : (1.0 - frac) / 2
            const editorOffsetPx = editorOnLeft ? mainRect.width * frac : 0
            return { vcx, vcy, editorOffsetPx }
        },
    }
}
