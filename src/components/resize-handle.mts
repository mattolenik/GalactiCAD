import { SettingsManager } from "../storage/settings.mjs"

const MIN_PERCENT = 15
const MAX_PERCENT = 70

export class ResizeHandle {
    #handle: HTMLElement
    #mainPanels: HTMLElement
    #workspace: HTMLElement
    #isDragging = false
    #startX = 0
    #startY = 0
    #startPercent = 0

    constructor(handle: HTMLElement, mainPanels: HTMLElement, workspace: HTMLElement) {
        this.#handle = handle
        this.#mainPanels = mainPanels
        this.#workspace = workspace
    }

    connect(): void {
        this.#applyLayout()
        this.#handle.addEventListener("pointerdown", this.#onPointerDown)
    }

    disconnect(): void {
        this.#handle.removeEventListener("pointerdown", this.#onPointerDown)
        document.removeEventListener("pointermove", this.#onPointerMove)
        document.removeEventListener("pointerup", this.#onPointerUp)
        document.removeEventListener("pointercancel", this.#onPointerUp)
    }

    /** Call when layout mode (editorOnLeft) changes from outside, e.g. menu toggle */
    applyLayout(): void {
        this.#applyLayout()
    }

    #applyLayout(): void {
        const layout = SettingsManager.instance.getGlobal().layout
        this.#workspace.classList.toggle("editor-left", layout.editorOnLeft)
        this.#handle.setAttribute("aria-orientation", layout.editorOnLeft ? "vertical" : "horizontal")
        if (layout.editorOnLeft) {
            this.#mainPanels.style.setProperty("--editor-width", `${layout.editorWidthPercent}%`)
        } else {
            this.#mainPanels.style.setProperty("--editor-height", `${layout.editorHeightPercent}%`)
        }
    }

    #onPointerDown = (e: PointerEvent): void => {
        if (this.#isDragging) return
        e.preventDefault()
        this.#isDragging = true
        this.#startX = e.clientX
        this.#startY = e.clientY
        const layout = SettingsManager.instance.getGlobal().layout
        this.#startPercent = layout.editorOnLeft ? layout.editorWidthPercent : layout.editorHeightPercent
        this.#handle.setPointerCapture(e.pointerId)
        document.addEventListener("pointermove", this.#onPointerMove)
        document.addEventListener("pointerup", this.#onPointerUp)
        document.addEventListener("pointercancel", this.#onPointerUp)
    }

    #onPointerMove = (e: PointerEvent): void => {
        if (!this.#isDragging) return
        const layout = SettingsManager.instance.getGlobal().layout
        const rect = this.#mainPanels.getBoundingClientRect()
        let newPercent: number
        if (layout.editorOnLeft) {
            const deltaX = e.clientX - this.#startX
            newPercent = this.#startPercent + (deltaX / rect.width) * 100
        } else {
            const deltaY = e.clientY - this.#startY
            newPercent = this.#startPercent + (deltaY / rect.height) * 100
        }
        newPercent = Math.max(MIN_PERCENT, Math.min(MAX_PERCENT, newPercent))
        if (layout.editorOnLeft) {
            this.#mainPanels.style.setProperty("--editor-width", `${newPercent}%`)
        } else {
            this.#mainPanels.style.setProperty("--editor-height", `${newPercent}%`)
        }
    }

    #onPointerUp = (e: PointerEvent): void => {
        if (!this.#isDragging) return
        this.#isDragging = false
        this.#handle.releasePointerCapture(e.pointerId)
        document.removeEventListener("pointermove", this.#onPointerMove)
        document.removeEventListener("pointerup", this.#onPointerUp)
        document.removeEventListener("pointercancel", this.#onPointerUp)
        const layout = SettingsManager.instance.getGlobal().layout
        const patch: Partial<typeof layout> = {}
        if (layout.editorOnLeft) {
            const current = this.#mainPanels.style.getPropertyValue("--editor-width")
            const percent = parseFloat(current)
            if (!isNaN(percent)) patch.editorWidthPercent = percent
        } else {
            const current = this.#mainPanels.style.getPropertyValue("--editor-height")
            const percent = parseFloat(current)
            if (!isNaN(percent)) patch.editorHeightPercent = percent
        }
        if (Object.keys(patch).length > 0) {
            SettingsManager.instance.updateGlobal({ layout: patch })
        }
    }
}
