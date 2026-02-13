import * as monaco from "monaco-editor"
import { fromEventPattern, Subscription } from "rxjs"
import { bufferTime } from "rxjs/operators"
import { OrderedMap } from "../collections/orderedMap.mjs"
import { SettingsManager } from "../storage/settings.mjs"
import { __active_bg, __bg_color, __fg_color, __tone_0, __tone_1, __tone_2, __tone_3, __tone_accent } from "../style/style.mjs"
import { YesNoDialog } from "./yesno-dialog.mjs"

const LONG_PRESS_MS = 500
const MOVE_THRESHOLD_PX = 5

export class DocumentTabs extends HTMLElement {
    #active?: string
    #docs = new OrderedMap<string, monaco.editor.ITextModel>()
    #editor: monaco.editor.IStandaloneCodeEditor
    #subscriptions = new Map<string, Subscription>()
    #tabContainer: HTMLElement
    #topUntitledIndex: number = 0

    #draggingName: string | null = null
    #longPressTimer: ReturnType<typeof setTimeout> | null = null
    #pendingTabName: string | null = null
    #startX = 0
    #startY = 0
    #dropIndex = 0
    #hasDragged = false
    #dropIndicator: HTMLElement
    #dragPlaceholder: HTMLElement | null = null
    #dragOffsetX = 0
    #dragOffsetY = 0
    #dragTabWidth = 0
    #dragTabHeight = 0

    constructor(editor: monaco.editor.IStandaloneCodeEditor) {
        super()
        this.#editor = editor

        this.attachShadow({ mode: "open" })

        const tabHeight = "34px"
        const closeButtonSize = "20px"
        const transitionSpeed = "0.3s"

        const style = document.createElement("style")
        style.textContent = `
            :host {
                display: block;
                ${__fg_color}: whitesmoke;
                ${__tone_0}: #EEE;
                ${__tone_1}: #888;
                ${__tone_2}: #444;
                ${__tone_3}: #666;
                ${__tone_accent}: #007acc;
            }
            button {
                color: var(${__fg_color});
            }
            .tabs-container {
                display: flex;
                flex-wrap: wrap;
            }
            .tab {
                flex: 1 1 auto;
                align-items: center;
                background-color: var(${__bg_color});
                border: none;
                color: var(${__tone_0});
                cursor: pointer;
                display: flex;
                font-size: medium;
                height: ${tabHeight};
                opacity: 0.8;
                padding: 0 1rem 0 1rem;
                position: relative;
                transition: all ${transitionSpeed};
            }

            .tab:hover {
                background-color: rgb(from var(${__active_bg}) r g b / 0.5);
                opacity: 1;
                transition: opacity ${transitionSpeed};
                color: var(${__fg_color});
            }
            .tab.active {
                background-color: var(${__active_bg});
                color: var(${__fg_color});
                opacity: 1;
            }
            .tab.active::before {
                background: var(${__tone_accent});
                content: "";
                height: 4px;
                left: 0;
                position: absolute;
                right: 0;
                top: 0;
            }
            .tab:not(.active, :hover)+.tab:not(.active, :hover)::after {
                background: var(${__tone_3});
                bottom: 27%;
                content: "";
                left: 0;
                position: absolute;
                top: 27%;
                width: 1px;
            }
            .close {
                background: none;
                border-radius: 6px;
                border: none;
                color: var(${__tone_1});
                font-size: ${closeButtonSize};
                height: ${closeButtonSize};
                line-height: ${closeButtonSize};
                margin: 0;
                opacity: 0;
                padding: 0;
                position: absolute;
                right: 0.5rem;
                text-align: center;
                transition: all ${transitionSpeed};
                width: ${closeButtonSize};
            }
            .tab:hover > .close {
                opacity: 1;
            }
            .close:hover {
                background: var(${__tone_2});
                color: var(${__fg_color});
            }
            .tab.dragging {
                opacity: 0.9;
                transition: none;
                z-index: 10000;
                pointer-events: none;
                box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            }
            .tab.dragging .close {
                pointer-events: none;
            }
            .drop-indicator {
                align-self: stretch;
                background: var(${__tone_accent});
                flex: 0 0 3px;
                margin: 4px 0;
            }
            .tab-placeholder {
                flex: 0 0 auto;
                pointer-events: none;
            }
        `
        this.shadowRoot!.appendChild(style)

        this.#dropIndicator = document.createElement("div")
        this.#dropIndicator.classList.add("drop-indicator")

        this.#tabContainer = document.createElement("div")
        this.#tabContainer.classList.add("tabs-container")
        this.shadowRoot!.appendChild(this.#tabContainer)

        this.#renderTabs()
    }

    disconnectedCallback() {
        for (const sub of this.#subscriptions.values()) {
            sub.unsubscribe()
        }
        this.#subscriptions.clear()
    }

    /** Current active document name (if any) */
    get active(): string | undefined {
        return this.#active
    }

    /** Retrieve a model by filename */
    getByName(name: string): monaco.editor.ITextModel | undefined {
        return this.#docs.get(name)
    }

    /** All documents in insertion order */
    get allDocuments(): Iterable<monaco.editor.ITextModel> {
        return this.#docs.values()
    }

    /** All document names in insertion order */
    get documentNames(): string[] {
        return Array.from(this.#docs.keys())
    }

    /** Creates a new document, prompting the user for a name. Returns the name, or undefined if user aborts */
    newDocument(content = defaultContent, language = "javascript"): string | undefined {
        this.#topUntitledIndex =
            Array.from(this.#docs.keys())
                .map(s => parseInt(s.match(/^new sketch (\d+)$/)?.map((v, i, arr) => arr[i])[1]!) || 0)
                .reduce((p, c) => Math.max(p, c), 0) + 1

        const defaultName = `new sketch ${this.#topUntitledIndex}`
        const name = this.#docs.size > 0 ? window.prompt("Give the new sketch a name", defaultName)?.trim() : defaultName
        if (!name) return

        const uri = monaco.Uri.parse(`inmemory://model/${name}`)
        const model = monaco.editor.createModel(content, language, uri)
        this.#docs.set(name, model)
        this.#watchModel(name, model)
        this.switchTo(name)
        this.#updateStoredOrder()
        return name
    }

    /** Restore tabs from saved order or localStorage, or default */
    restore(): void {
        // clear existing
        for (const name of Array.from(this.#docs.keys())) {
            const sub = this.#subscriptions.get(name)
            if (sub) sub.unsubscribe()
            this.#subscriptions.delete(name)
            this.#docs.delete(name)
        }
        const prefix = "document:"
        const storedOrder = JSON.parse(localStorage.getItem("documents") || "[]") as string[]
        const loaded = new Set<string>()
        // load in order
        for (const name of storedOrder) {
            const key = `${prefix}${name}`
            const content = localStorage.getItem(key)
            if (content !== null) {
                const uri = monaco.Uri.parse(`inmemory://model/${name}`)
                const model = monaco.editor.createModel(content, "javascript", uri)
                this.#docs.set(name, model)
                this.#watchModel(name, model)
                loaded.add(name)
            }
        }
        // load leftovers
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i)
            if (key?.startsWith(prefix)) {
                const name = key.substring(prefix.length)
                if (!loaded.has(name)) {
                    const content = localStorage.getItem(key) || ""
                    const uri = monaco.Uri.parse(`inmemory://model/${name}`)
                    const model = monaco.editor.createModel(content, "javascript", uri)
                    this.#docs.set(name, model)
                    this.#watchModel(name, model)
                }
            }
        }
        // default if empty
        if (this.#docs.keys().next().done) {
            this.newDocument()
            return
        }
        // activate first
        const first = this.#docs.keys().next().value
        if (first) this.switchTo(first)
        this.#updateStoredOrder()
        const lastTab = localStorage.getItem("activeDocument") as string
        if (lastTab) {
            this.switchTo(lastTab)
        }
    }

    /** Observe model changes and save debounced */
    #watchModel(name: string, model: monaco.editor.ITextModel) {
        this.#subscriptions.get(name)?.unsubscribe()
        const change$ = fromEventPattern<monaco.editor.IModelContentChangedEvent>(
            handler => model.onDidChangeContent(handler),
            (_handler, subscription) => (subscription as monaco.IDisposable).dispose()
        ).pipe(bufferTime(1000))
        const sub = change$.subscribe(() => localStorage.setItem(`document:${name}`, model.getValue()))
        this.#subscriptions.set(name, sub)
        localStorage.setItem(`document:${name}`, model.getValue())
    }

    closeCurrentTab() {
        this.closeTab(this.#active!)
    }

    closeTab(name: string) {
        const wasActive = name === this.#active
        const sub = this.#subscriptions.get(name)
        if (sub) sub.unsubscribe()
        this.#subscriptions.delete(name)
        this.#docs.get(name)?.dispose()
        this.#docs.delete(name)
        this.#renderTabs()
        this.#updateStoredOrder()
        if (wasActive) {
            const next = this.#docs.keys().next().value
            if (next) this.switchTo(next)
            else {
                this.#active = undefined
                this.dispatchEvent(new CustomEvent("activeTabChanged", { detail: undefined }))
                this.#editor.setModel(null!)
                this.#renderTabs()
            }
        }
    }

    async deleteCurrentTab() {
        this.deleteTab(this.active!)
    }

    async deleteTab(name: string) {
        const cntinue = await new YesNoDialog(`Are you sure you want to delete ${name}?`).show()
        if (cntinue) {
            localStorage.removeItem(`document:${name}`)
            SettingsManager.instance.deleteDocument(name)
            this.closeTab(name)
        }
    }

    /** Rename the current tab, prompting the user for a new name */
    renameCurrentTab(): boolean {
        if (!this.#active) return false
        return this.renameTab(this.#active)
    }

    /** Duplicate the current tab into a new one, cloning content and settings. Returns the new tab name, or undefined if user cancels. */
    duplicateCurrentTab(): string | undefined {
        if (!this.#active) return undefined

        SettingsManager.instance.flushDocNow()
        const model = this.#docs.get(this.#active)
        if (!model) return undefined

        const content = model.getValue()
        const settings = SettingsManager.instance.getDocumentSettings(this.#active)

        const newName = window.prompt("Name for duplicated sketch", this.#active)?.trim()
        if (!newName || newName === this.#active) return undefined

        if (this.#docs.has(newName)) {
            alert(`A sketch named "${newName}" already exists.`)
            return undefined
        }

        const uri = monaco.Uri.parse(`inmemory://model/${newName}`)
        const newModel = monaco.editor.createModel(content, "javascript", uri)
        this.#docs.set(newName, newModel)
        this.#watchModel(newName, newModel)
        localStorage.setItem(`settings:${newName}`, JSON.stringify(settings))
        this.#updateStoredOrder()
        this.switchTo(newName)
        return newName
    }

    /** Rename a tab, prompting the user for a new name */
    renameTab(oldName: string): boolean {
        const model = this.#docs.get(oldName)
        if (!model) return false

        const newName = window.prompt("Enter new name for the sketch", oldName)?.trim()
        if (!newName || newName === oldName) return false

        // Check for duplicate names
        if (this.#docs.has(newName)) {
            alert(`A sketch named "${newName}" already exists.`)
            return false
        }

        // Update localStorage: remove old document content key, add new one
        const content = localStorage.getItem(`document:${oldName}`)
        if (content !== null) {
            localStorage.removeItem(`document:${oldName}`)
            localStorage.setItem(`document:${newName}`, content)
        }

        // Rename per-document settings (camera, preview) in the consolidated settings store
        SettingsManager.instance.renameDocument(oldName, newName)

        // Update the ordered map: need to preserve order
        // Get all entries, update the name, rebuild
        const entries = Array.from(this.#docs.entries())
        this.#docs.clear()
        for (const [name, m] of entries) {
            if (name === oldName) {
                this.#docs.set(newName, m)
            } else {
                this.#docs.set(name, m)
            }
        }

        // Update subscription key
        const sub = this.#subscriptions.get(oldName)
        if (sub) {
            this.#subscriptions.delete(oldName)
            this.#subscriptions.set(newName, sub)
        }

        // Re-watch model with new name for future saves
        this.#watchModel(newName, model)

        // Update active tab if it was the renamed one
        if (this.#active === oldName) {
            this.#active = newName
            localStorage.setItem("activeDocument", newName)
        }

        this.#updateStoredOrder()
        this.#renderTabs()
        this.dispatchEvent(new CustomEvent("activeTabChanged", { detail: this.#active }))
        return true
    }

    switchTo(name: string, save = false) {
        const model = this.#docs.get(name)
        if (!model) return
        this.#active = name
        // Flush the outgoing document's settings and load the incoming document's settings
        SettingsManager.instance.switchDocument(name)
        this.#editor.setModel(model)
        this.dispatchEvent(new CustomEvent("activeTabChanged", { detail: name }))
        this.#renderTabs()
        if (save) {
            localStorage.setItem("activeDocument", this.#active)
        }
    }

    /** Update serialized order */
    #updateStoredOrder() {
        localStorage.setItem("documents", JSON.stringify(Array.from(this.#docs.keys())))
    }

    #renderTabs() {
        this.#tabContainer.innerHTML = ""
        const names = Array.from(this.#docs.keys())
        for (let i = 0; i < names.length; i++) {
            const name = names[i]
            const tab = document.createElement("button")
            tab.setAttribute("data-tab-name", name)
            tab.addEventListener("contextmenu", ev => ev.preventDefault())
            tab.classList.add("tab")
            if (name === this.#active) tab.classList.add("active")
            tab.addEventListener("pointerdown", (e) => this.#onTabPointerDown(e, name))

            const label = document.createElement("span")
            label.textContent = name
            tab.appendChild(label)

            const close = document.createElement("button")
            close.classList.add("close")
            close.textContent = "×"
            close.addEventListener("click", e => {
                e.stopPropagation()
                this.closeTab(name)
            })
            tab.appendChild(close)
            this.#tabContainer.appendChild(tab)
        }
    }

    #onTabPointerDown = (e: PointerEvent, name: string): void => {
        if ((e.target as HTMLElement).closest(".close")) return
        if (this.#draggingName) return
        if (this.#docs.size <= 1) return

        const tab = (e.target as HTMLElement).closest(".tab") as HTMLElement
        this.#startX = e.clientX
        this.#startY = e.clientY
        this.#hasDragged = false
        this.#dropIndex = Array.from(this.#docs.keys()).indexOf(name)
        this.#pendingTabName = name

        if (e.pointerType === "mouse") {
            tab.setPointerCapture(e.pointerId)
            this.#startDrag(tab, name, e.pointerId)
        } else {
            this.#longPressTimer = setTimeout(() => {
                this.#longPressTimer = null
                tab.setPointerCapture(e.pointerId)
                this.#startDrag(tab, name, e.pointerId)
            }, LONG_PRESS_MS)
            document.addEventListener("pointermove", this.#onPreDragPointerMove)
            document.addEventListener("pointerup", this.#onPreDragPointerUp)
            document.addEventListener("pointercancel", this.#onPreDragPointerUp)
        }
    }

    #onPreDragPointerMove = (e: PointerEvent): void => {
        if (this.#longPressTimer === null) return
        const dx = e.clientX - this.#startX
        const dy = e.clientY - this.#startY
        if (Math.hypot(dx, dy) > MOVE_THRESHOLD_PX) {
            clearTimeout(this.#longPressTimer)
            this.#longPressTimer = null
            document.removeEventListener("pointermove", this.#onPreDragPointerMove)
            document.removeEventListener("pointerup", this.#onPreDragPointerUp)
            document.removeEventListener("pointercancel", this.#onPreDragPointerUp)
        }
    }

    #onPreDragPointerUp = (): void => {
        if (this.#longPressTimer === null) return
        clearTimeout(this.#longPressTimer)
        this.#longPressTimer = null
        document.removeEventListener("pointermove", this.#onPreDragPointerMove)
        document.removeEventListener("pointerup", this.#onPreDragPointerUp)
        document.removeEventListener("pointercancel", this.#onPreDragPointerUp)
        const name = this.#pendingTabName
        this.#pendingTabName = null
        if (name) this.switchTo(name, true)
    }

    #startDrag(tab: HTMLElement, name: string, pointerId: number): void {
        this.#draggingName = name
        tab.classList.add("dragging")
        const rect = tab.getBoundingClientRect()
        this.#dragOffsetX = this.#startX - rect.left
        this.#dragOffsetY = this.#startY - rect.top
        this.#dragTabWidth = rect.width
        this.#dragTabHeight = rect.height
        this.#dragPlaceholder = document.createElement("div")
        this.#dragPlaceholder.classList.add("tab-placeholder")
        this.#dragPlaceholder.style.width = `${rect.width}px`
        this.#dragPlaceholder.style.height = `${rect.height}px`
        this.#tabContainer.insertBefore(this.#dragPlaceholder, tab)
        this.#updateDragPosition(this.#startX, this.#startY)
        document.addEventListener("pointermove", this.#onDragPointerMove)
        document.addEventListener("pointerup", this.#onDragPointerUp)
        document.addEventListener("pointercancel", this.#onDragPointerUp)
        this.#updateDropIndicator()
    }

    #updateDragPosition(clientX: number, clientY: number): void {
        const tab = this.#tabContainer.querySelector<HTMLElement>(`[data-tab-name="${this.#draggingName!}"]`)
        if (!tab) return
        tab.style.position = "fixed"
        tab.style.left = `${clientX - this.#dragOffsetX}px`
        tab.style.top = `${clientY - this.#dragOffsetY}px`
        tab.style.width = `${this.#dragTabWidth}px`
        tab.style.minWidth = `${this.#dragTabWidth}px`
        tab.style.height = `${this.#dragTabHeight}px`
    }

    #clearDragPosition(): void {
        const tab = this.#tabContainer.querySelector<HTMLElement>(`[data-tab-name="${this.#draggingName!}"]`)
        if (tab) {
            tab.style.position = ""
            tab.style.left = ""
            tab.style.top = ""
            tab.style.width = ""
            tab.style.minWidth = ""
            tab.style.height = ""
        }
    }

    #onDragPointerMove = (e: PointerEvent): void => {
        if (!this.#draggingName) return
        this.#hasDragged = this.#hasDragged || Math.hypot(e.clientX - this.#startX, e.clientY - this.#startY) > MOVE_THRESHOLD_PX
        this.#updateDragPosition(e.clientX, e.clientY)
        this.#dropIndex = this.#computeDropIndex(e.clientX, e.clientY)
        this.#updateDropIndicator()
    }

    #computeDropIndex(clientX: number, clientY: number): number {
        const rect = this.#tabContainer.getBoundingClientRect()
        if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
            return -1
        }
        const tabs = Array.from(this.#tabContainer.querySelectorAll<HTMLElement>(".tab"))
        const draggingName = this.#draggingName
        for (let i = 0; i < tabs.length; i++) {
            const tab = tabs[i]
            if (draggingName && tab.getAttribute("data-tab-name") === draggingName) continue
            const tabRect = tab.getBoundingClientRect()
            if (clientY < tabRect.top || clientY > tabRect.bottom) continue
            if (clientX < tabRect.left || clientX > tabRect.right) continue
            const midX = tabRect.left + tabRect.width / 2
            return clientX < midX ? i : i + 1
        }
        return -1
    }

    #updateDropIndicator(): void {
        if (!this.#hasDragged || this.#dropIndex < 0) {
            this.#dropIndicator.remove()
            return
        }
        const fromIndex = this.#draggingName ? Array.from(this.#docs.keys()).indexOf(this.#draggingName) : -1
        if (fromIndex >= 0 && (this.#dropIndex === fromIndex || this.#dropIndex === fromIndex + 1)) {
            this.#dropIndicator.remove()
            return
        }
        const tabs = Array.from(this.#tabContainer.querySelectorAll(".tab"))
        const insertAt = Math.min(this.#dropIndex, tabs.length)
        const target = tabs[insertAt]
        if (target) {
            this.#tabContainer.insertBefore(this.#dropIndicator, target)
        } else {
            this.#tabContainer.appendChild(this.#dropIndicator)
        }
    }

    #onDragPointerUp = (e: PointerEvent): void => {
        if (!this.#draggingName) return
        const name = this.#draggingName
        const tab = this.#tabContainer.querySelector(`[data-tab-name="${name}"]`)
        const releaseDropIndex = this.#computeDropIndex(e.clientX, e.clientY)
        document.removeEventListener("pointermove", this.#onDragPointerMove)
        document.removeEventListener("pointerup", this.#onDragPointerUp)
        document.removeEventListener("pointercancel", this.#onDragPointerUp)
        this.#dropIndicator.remove()
        this.#dragPlaceholder?.remove()
        this.#dragPlaceholder = null
        this.#clearDragPosition()
        tab?.classList.remove("dragging")
        this.#draggingName = null

        if (this.#hasDragged) {
            if (releaseDropIndex >= 0) {
                const fromIndex = Array.from(this.#docs.keys()).indexOf(name)
                const toIndex = Math.min(releaseDropIndex, this.#docs.size)
                if (fromIndex !== -1 && fromIndex !== toIndex) {
                    this.#docs.moveToIndex(fromIndex, toIndex)
                    this.#updateStoredOrder()
                }
            }
        } else {
            this.switchTo(name, true)
        }
        this.#renderTabs()
    }
}

customElements.define("document-tabs", DocumentTabs)

declare global {
    interface HTMLElementTagNameMap {
        "document-tabs": DocumentTabs
    }
}

const defaultContent = `
// Passenger Car Model
// A simple sedan built from SDF primitives

function scene() {
   // === CAR BODY ===
   // Main body - lower chassis/body
   const body = box([0, 0, 3], [40, 16, 6])

   // Cabin/roof - upper portion with windows
   const cabin = box([2, 0, 8], [24, 14, 5])

   // Hood slopes down slightly at front - add a box that gets subtracted
   const hoodCut = box([18, 0, 8], [10, 18, 6])

   // Trunk slopes down at rear
   const trunkCut = box([-16, 0, 8], [8, 18, 6])

   // Combine body and cabin with smooth blend
   const bodyWithCabin = union(2, body, cabin)

   // Cut the hood and trunk angles
   const sculptedBody = subtract(1, bodyWithCabin, hoodCut, trunkCut)

   // === WHEEL WELLS ===
   // Carve out wheel wells to give wheels depth
   const wheelWellFR = sphere([12, 9, 2], { r: 5 })   // front-right
   const wheelWellFL = sphere([12, -9, 2], { r: 5 })  // front-left
   const wheelWellRR = sphere([-12, 9, 2], { r: 5 })  // rear-right
   const wheelWellRL = sphere([-12, -9, 2], { r: 5 }) // rear-left

   const bodyWithWells = subtract(0.5,
      sculptedBody,
      wheelWellFR, wheelWellFL, wheelWellRR, wheelWellRL
   )

   // === WINDOWS ===
   // Side windows - carved into the cabin
   const windowRight = box([2, 8, 8], [20, 2, 3])
   const windowLeft = box([2, -8, 8], [20, 2, 3])

   // Windshield (front) and rear window
   const windshield = box([14, 0, 8], [2, 12, 3])
   const rearWindow = box([-10, 0, 8], [2, 12, 3])

   // Carve windows into body
   const bodyWithWindows = subtract(0.3,
      bodyWithWells,
      windowRight, windowLeft, windshield, rearWindow
   )

   // === WHEELS ===
   // Four wheels positioned at corners
   const wheelFR = sphere([12, 10, 0], { r: 4 })   // front-right
   const wheelFL = sphere([12, -10, 0], { r: 4 })  // front-left
   const wheelRR = sphere([-12, 10, 0], { r: 4 })  // rear-right
   const wheelRL = sphere([-12, -10, 0], { r: 4 }) // rear-left

   // Combine wheels
   const wheels = union(wheelFR, wheelFL, wheelRR, wheelRL)

   // === HEADLIGHTS & TAILLIGHTS ===
   // Headlights (front spheres)
   const headlightR = sphere([20, 5, 4], { r: 1.5 })
   const headlightL = sphere([20, -5, 4], { r: 1.5 })

   // Taillights (rear spheres)
   const taillightR = sphere([-20, 5, 4], { r: 1.2 })
   const taillightL = sphere([-20, -5, 4], { r: 1.2 })

   const lights = union(headlightR, headlightL, taillightR, taillightL)

   // === FINAL ASSEMBLY ===
   // Union the body, wheels, and lights together
   return union(0.5, bodyWithWindows, wheels, lights)
}

`
