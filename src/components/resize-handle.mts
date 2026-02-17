import { LayoutSettings, SettingsManager } from "../storage/settings.mjs"

const MIN_PERCENT = 15
const MAX_PERCENT = 70

export class ResizeHandle {
    #handle: HTMLElement
    #mainPanels: HTMLElement
    #workspace: HTMLElement
    #ac = new AbortController()
    #dragAc: AbortController | null = null
    #isDragging = false
    #startX = 0
    #startY = 0
    #startPercent = 0

    /** Whether the editor is on the left, computed from window aspect ratio */
    get #editorOnLeft(): boolean {
        return window.innerWidth > window.innerHeight
    }

    constructor(handle: HTMLElement, mainPanels: HTMLElement, workspace: HTMLElement) {
        this.#handle = handle
        this.#mainPanels = mainPanels
        this.#workspace = workspace
    }

    connect(): void {
        this.#ac = new AbortController()
        const { signal } = this.#ac
        this.#applyLayout()
        this.#handle.addEventListener("pointerdown", this.#onPointerDown, { signal })
        window.addEventListener("resize", this.#onWindowResize, { signal })
    }

    disconnect(): void {
        this.#dragAc?.abort()
        this.#ac.abort()
    }

    #onWindowResize = (): void => {
        this.#applyLayout()
    }

    #applyLayout(): void {
        const layout = SettingsManager.instance.getGlobal().layout
        const editorOnLeft = this.#editorOnLeft
        this.#workspace.classList.toggle("editor-left", editorOnLeft)
        this.#handle.setAttribute("aria-orientation", editorOnLeft ? "vertical" : "horizontal")
        if (editorOnLeft) {
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
        this.#startPercent = this.#editorOnLeft ? layout.editorWidthPercent : layout.editorHeightPercent
        this.#handle.setPointerCapture(e.pointerId)
        document.body.classList.add("resize-dragging")
        this.#dragAc = new AbortController()
        const { signal } = this.#dragAc
        document.addEventListener("pointermove", this.#onPointerMove, { signal })
        document.addEventListener("pointerup", this.#onPointerUp, { signal })
        document.addEventListener("pointercancel", this.#onPointerUp, { signal })
    }

    #onPointerMove = (e: PointerEvent): void => {
        if (!this.#isDragging) return
        e.preventDefault()
        const rect = this.#mainPanels.getBoundingClientRect()
        let newPercent: number
        if (this.#editorOnLeft) {
            const deltaX = e.clientX - this.#startX
            newPercent = this.#startPercent + (deltaX / rect.width) * 100
        } else {
            const deltaY = e.clientY - this.#startY
            newPercent = this.#startPercent + (deltaY / rect.height) * 100
        }
        newPercent = Math.max(MIN_PERCENT, Math.min(MAX_PERCENT, newPercent))
        if (this.#editorOnLeft) {
            this.#mainPanels.style.setProperty("--editor-width", `${newPercent}%`)
        } else {
            this.#mainPanels.style.setProperty("--editor-height", `${newPercent}%`)
        }
    }

    #onPointerUp = (e: PointerEvent): void => {
        if (!this.#isDragging) return
        this.#isDragging = false
        document.body.classList.remove("resize-dragging")
        this.#handle.releasePointerCapture(e.pointerId)
        this.#dragAc?.abort()
        this.#dragAc = null
        const patch: Partial<LayoutSettings> = {}
        if (this.#editorOnLeft) {
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
