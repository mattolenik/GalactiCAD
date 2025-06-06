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
    newDocument(content = sample, language = "javascript"): string | undefined {
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

const sample = `
return union(1,
   box('2 -4 4', '20 3 3'),
   box('0  5 4', '20 3 3'),
   subtract(0.5, box('0 0 0', '10 15 8'), sphere('0 0 -10', { r: 6 })),
)
`
