import { SettingsManager } from "../storage/settings.mjs"

const MIN_EDITOR_PERCENT = 15
const MAX_EDITOR_PERCENT = 70

export class ResizeHandle {
    #handle: HTMLElement
    #workspace: HTMLElement
    #tabs: HTMLElement
    #isDragging = false
    #startY = 0
    #startPercent = 0

    constructor(handle: HTMLElement, workspace: HTMLElement, tabs: HTMLElement) {
        this.#handle = handle
        this.#workspace = workspace
        this.#tabs = tabs
    }

    connect(): void {
        this.#applyLayout()
        this.#handle.addEventListener("pointerdown", this.#onPointerDown)
        this.#tabs.addEventListener("activeTabChanged", this.#onTabChanged)
    }

    disconnect(): void {
        this.#handle.removeEventListener("pointerdown", this.#onPointerDown)
        this.#tabs.removeEventListener("activeTabChanged", this.#onTabChanged)
        document.removeEventListener("pointermove", this.#onPointerMove)
        document.removeEventListener("pointerup", this.#onPointerUp)
        document.removeEventListener("pointercancel", this.#onPointerUp)
    }

    #applyLayout(): void {
        const { editorHeightPercent } = SettingsManager.instance.getLayout()
        this.#workspace.style.setProperty("--editor-height", `${editorHeightPercent}%`)
    }

    #onTabChanged = (): void => {
        this.#applyLayout()
    }

    #onPointerDown = (e: PointerEvent): void => {
        if (this.#isDragging) return
        e.preventDefault()
        this.#isDragging = true
        this.#startY = e.clientY
        this.#startPercent = SettingsManager.instance.getLayout().editorHeightPercent
        this.#handle.setPointerCapture(e.pointerId)
        document.addEventListener("pointermove", this.#onPointerMove)
        document.addEventListener("pointerup", this.#onPointerUp)
        document.addEventListener("pointercancel", this.#onPointerUp)
    }

    #onPointerMove = (e: PointerEvent): void => {
        if (!this.#isDragging) return
        const workspaceRect = this.#workspace.getBoundingClientRect()
        const deltaY = e.clientY - this.#startY
        const deltaPercent = (deltaY / workspaceRect.height) * 100
        let newPercent = this.#startPercent + deltaPercent
        newPercent = Math.max(MIN_EDITOR_PERCENT, Math.min(MAX_EDITOR_PERCENT, newPercent))
        this.#workspace.style.setProperty("--editor-height", `${newPercent}%`)
    }

    #onPointerUp = (e: PointerEvent): void => {
        if (!this.#isDragging) return
        this.#isDragging = false
        this.#handle.releasePointerCapture(e.pointerId)
        document.removeEventListener("pointermove", this.#onPointerMove)
        document.removeEventListener("pointerup", this.#onPointerUp)
        document.removeEventListener("pointercancel", this.#onPointerUp)
        const current = this.#workspace.style.getPropertyValue("--editor-height")
        const percent = parseFloat(current)
        if (!isNaN(percent) && SettingsManager.instance.currentDocumentName) {
            SettingsManager.instance.updateLayout({ editorHeightPercent: percent })
        }
    }
}
