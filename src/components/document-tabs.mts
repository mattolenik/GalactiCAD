import * as monaco from "monaco-editor"
import { fromEventPattern, Subscription } from "rxjs"
import { bufferTime } from "rxjs/operators"
import { OrderedMap } from "../collections/orderedMap.mjs"
import { __active_bg, __bg_color, __fg_color, __tone_1, __tone_2, __tone_3, __tone_accent } from "../style/style.mjs"
import { YesNoDialog } from "./yesno-dialog.mjs"

export class DocumentTabs extends HTMLElement {
    #active?: string
    #docs = new OrderedMap<string, monaco.editor.ITextModel>()
    #editor: monaco.editor.IStandaloneCodeEditor
    #subscriptions = new Map<string, Subscription>()
    #tabContainer: HTMLElement
    topUntitledIndex: number = 0

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
                ${__fg_color}: whitesmoke;
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
                border-bottom: 2px solid var(${__tone_1});
                color: var(${__tone_1});
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
                border-color: var(${__tone_accent});
                border-width: 0 0px 4px 0;
                box-sizing: border-box;
                color: var(${__fg_color});
                opacity: 1;
                padding-top: 1px;
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
        `
        this.shadowRoot!.appendChild(style)

        this.#tabContainer = document.createElement("div")
        this.#tabContainer.classList.add("tabs-container")
        this.shadowRoot!.appendChild(this.#tabContainer)

        this.#renderTabs()
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

    /** Creates a new document, prompting the user for a name. Returns the name, or undefined if user aborts */
    newDocument(content = defaultContent, language = "javascript"): string | undefined {
        this.topUntitledIndex =
            Array.from(this.#docs.keys())
                .map(s => parseInt(s.match(/^new sketch (\d+)$/)?.map((v, i, arr) => arr[i])[1]!) || 0)
                .reduce((p, c) => Math.max(p, c), 0) + 1

        const defaultName = `new sketch ${this.topUntitledIndex}`
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
            this.closeTab(name)
        }
    }

    /** Rename the current tab, prompting the user for a new name */
    renameCurrentTab(): boolean {
        if (!this.#active) return false
        return this.renameTab(this.#active)
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

        // Update localStorage: remove old key, add new key
        const content = localStorage.getItem(`document:${oldName}`)
        if (content !== null) {
            localStorage.removeItem(`document:${oldName}`)
            localStorage.setItem(`document:${newName}`, content)
        }

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
        for (const name of this.#docs.keys()) {
            const tab = document.createElement("button")
            tab.addEventListener("contextmenu", ev => ev.preventDefault())
            tab.classList.add("tab")
            if (name === this.#active) tab.classList.add("active")
            tab.addEventListener("click", () => this.switchTo(name, true))

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
}

customElements.define("document-tabs", DocumentTabs)

const defaultContent = `
// Dieselpunk Battle Mech
// A hulking war machine bristling with weapons and pipes

function scene() {
   // === TORSO - THE CORE ===
   // Main chest housing
   const chestCore = box([0, 0, 40], [24, 30, 22])
   const chestBulge = sphere([0, 0, 44], { r: 18 })
   const chest = union(6, chestCore, chestBulge)

   // Armored collar
   const collarR = sphere([0, 16, 52], { r: 8 })
   const collarL = sphere([0, -16, 52], { r: 8 })
   const collarFront = sphere([10, 0, 52], { r: 7 })
   const collar = union(4, collarR, collarL, collarFront)

   // Reactor exhaust vents on back
   const ventR = sphere([-14, 10, 48], { r: 5 })
   const ventL = sphere([-14, -10, 48], { r: 5 })
   const ventTop = sphere([-14, 0, 52], { r: 6 })
   const vents = union(2, ventR, ventL, ventTop)

   // === HEAD - COCKPIT POD ===
   const headCore = sphere([4, 0, 62], { r: 10 })
   const visor = box([10, 0, 60], [6, 14, 4])
   const headCrest = sphere([0, 0, 72], { r: 5 })
   const antenna1 = sphere([-4, 6, 70], { r: 2 })
   const antenna2 = sphere([-4, -6, 70], { r: 2 })
   const head = union(3, headCore, visor, headCrest, antenna1, antenna2)

   // === SHOULDERS - WEAPON MOUNTS ===
   // Right shoulder pod
   const shoulderR = sphere([0, 26, 50], { r: 12 })
   const shoulderPadR = box([0, 30, 52], [10, 8, 10])
   const rocketPodR = box([0, 36, 54], [8, 6, 14])
   const rightShoulder = union(4, shoulderR, shoulderPadR, rocketPodR)

   // Left shoulder pod
   const shoulderL = sphere([0, -26, 50], { r: 12 })
   const shoulderPadL = box([0, -30, 52], [10, 8, 10])
   const rocketPodL = box([0, -36, 54], [8, 6, 14])
   const leftShoulder = union(4, shoulderL, shoulderPadL, rocketPodL)

   // === RIGHT ARM - GATLING GUN ===
   const upperArmR = box([0, 32, 38], [8, 8, 16])
   const elbowR = sphere([0, 34, 28], { r: 6 })
   const forearmR = box([4, 34, 18], [6, 6, 14])
   const gatlingHousing = sphere([8, 34, 8], { r: 7 })
   const gatlingBarrel = box([18, 34, 8], [16, 4, 4])
   const rightArm = union(3, upperArmR, elbowR, forearmR, gatlingHousing, gatlingBarrel)

   // === LEFT ARM - CLAW ===
   const upperArmL = box([0, -32, 38], [8, 8, 16])
   const elbowL = sphere([0, -34, 28], { r: 6 })
   const forearmL = box([4, -34, 18], [6, 6, 14])
   const clawBase = sphere([8, -34, 8], { r: 6 })
   const clawTop = sphere([16, -30, 6], { r: 4 })
   const clawBot = sphere([16, -38, 6], { r: 4 })
   const leftArm = union(3, upperArmL, elbowL, forearmL, clawBase, clawTop, clawBot)

   // === HIP ASSEMBLY ===
   const hipCore = box([0, 0, 24], [18, 26, 10])
   const hipBulge = sphere([0, 0, 24], { r: 14 })
   const hips = union(5, hipCore, hipBulge)

   // Hip armor plates
   const hipPlateR = sphere([6, 18, 24], { r: 7 })
   const hipPlateL = sphere([6, -18, 24], { r: 7 })

   // === LEGS - DIGITIGRADE STYLE ===
   // Right leg
   const thighR = box([0, 14, 14], [8, 8, 14])
   const kneeR = sphere([4, 14, 6], { r: 6 })
   const shinR = box([8, 14, -4], [6, 6, 16])
   const ankleR = sphere([6, 14, -14], { r: 5 })
   const footR = box([10, 14, -18], [12, 8, 4])
   const toeR = sphere([18, 14, -18], { r: 4 })
   const rightLeg = union(3, thighR, kneeR, shinR, ankleR, footR, toeR)

   // Left leg
   const thighL = box([0, -14, 14], [8, 8, 14])
   const kneeL = sphere([4, -14, 6], { r: 6 })
   const shinL = box([8, -14, -4], [6, 6, 16])
   const ankleL = sphere([6, -14, -14], { r: 5 })
   const footL = box([10, -14, -18], [12, 8, 4])
   const toeL = sphere([18, -14, -18], { r: 4 })
   const leftLeg = union(3, thighL, kneeL, shinL, ankleL, footL, toeL)

   // === BACK MOUNTED SYSTEMS ===
   // Reactor core
   const reactor = sphere([-16, 0, 42], { r: 10 })
   const reactorCasing = box([-18, 0, 42], [8, 14, 14])
   const reactorUnit = union(4, reactor, reactorCasing)

   // Smoke stacks
   const stack1 = box([-20, 8, 56], [4, 4, 16])
   const stackTop1 = sphere([-20, 8, 66], { r: 4 })
   const stack2 = box([-20, -8, 56], [4, 4, 16])
   const stackTop2 = sphere([-20, -8, 66], { r: 4 })
   const stacks = union(2, stack1, stackTop1, stack2, stackTop2)

   // Fuel tanks
   const tankR = sphere([-12, 20, 38], { r: 6 })
   const tankL = sphere([-12, -20, 38], { r: 6 })
   const tanks = union(tankR, tankL)

   // === DECORATIVE RIVETS & DETAILS ===
   const rivet1 = sphere([14, 12, 44], { r: 2 })
   const rivet2 = sphere([14, -12, 44], { r: 2 })
   const rivet3 = sphere([14, 0, 50], { r: 2 })
   const rivet4 = sphere([12, 8, 36], { r: 1.5 })
   const rivet5 = sphere([12, -8, 36], { r: 1.5 })
   const rivets = union(rivet1, rivet2, rivet3, rivet4, rivet5)

   // Chest searchlight
   const searchlight = sphere([16, 0, 42], { r: 4 })

   // === ASSEMBLY ===
   // Upper body
   const torso = union(4, chest, collar, vents, head)
   const arms = union(2, rightShoulder, leftShoulder, rightArm, leftArm)
   const upperBody = union(3, torso, arms)

   // Lower body
   const lowerBody = union(3, hips, hipPlateR, hipPlateL, rightLeg, leftLeg)

   // Back systems
   const backpack = union(3, reactorUnit, stacks, tanks)

   // Details
   const details = union(1, rivets, searchlight)

   // Final mech
   return union(4, upperBody, lowerBody, backpack, details)
}

`
