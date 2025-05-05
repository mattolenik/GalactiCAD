import * as monaco from "monaco-editor"
import { fromEventPattern, Subscription } from "rxjs"
import { bufferTime } from "rxjs/operators"
import { OrderedMap } from "./collections/orderedMap.mjs"
import { nanoid } from "nanoid"

// global counter for untitled docs
let untitledCount = 1

export class DocumentTabs extends HTMLElement {
    #editor: monaco.editor.IStandaloneCodeEditor
    #docs = new OrderedMap<string, monaco.editor.ITextModel>()
    #subscriptions = new Map<string, Subscription>()
    #active?: string
    #tabContainer: HTMLElement

    constructor(editor: monaco.editor.IStandaloneCodeEditor) {
        super()
        this.#editor = editor

        this.attachShadow({ mode: "open" })

        const tabHeight = "34px"
        const closeButtonSize = "22px"
        const newButtonSize = "20px"
        const cornerRadius = "0"
        const transitionSpeed = "0.3s"

        // inject styles
        const style = document.createElement("style")
        style.textContent = `
            button {
                color: whitesmoke;
            }
            .tabs-container {
                display: flex;
                align-items: center;
                gap: 0;
            }
            .tab-button {
                border: none;
                height: ${tabHeight};
                display: flex;
                align-items: center;
                padding: 0 0 0 1rem;
                border-bottom: 2px solid #888;
                background: none;
                opacity: 0.6;
                cursor: pointer;
                white-space: nowrap;
                color: #aaa;
                border-radius: 0 0 ${cornerRadius} ${cornerRadius};
                font-size: medium;
                padding-bottom: 0.2rem;
                position: relative;
                transition: opacity ${transitionSpeed};
            }
            .tab-button:hover {
                opacity: 1;
                background-color: rgb(from var(--active-bg) r g b / 0.3);
                transition: opacity ${transitionSpeed};
            }
            .tab-button.active {
                opacity: 1;
                box-sizing: border-box;
                background-color: var(--active-bg);
                border-width: 0 0px 4px 0;
                border-color: #007acc;
                padding-top: 1px;
                color: whitesmoke;
            }
            .tab-button:not(.active, :hover)+.tab-button:not(.active, :hover)::after {
                content: "";
                background: #666;
                position: absolute;
                top: 27%;
                bottom: 27%;
                left: 0;
                width: 1px;
            }
            .close-btn {
                margin: 0 0.5rem 0 0.5rem;
                padding: 0;
                font-size: ${closeButtonSize};
                color: #888;
                background: none;
                border: none;
                text-align: center;
                width: ${closeButtonSize};
                height: ${closeButtonSize};
                line-height: ${closeButtonSize};
                border-radius: 6px;
                transition: background ${transitionSpeed};
            }
            .close-btn:hover {
                background: #444;
                color: whitesmoke;
            }
            .add-button {
                padding: 0;
                float: right;
                margin-top: -0.2rem;
                margin-left: 0.3rem;
                border: none;
                border-radius: 6px;
                background: #444;
                cursor: pointer;
                color: #888;
                width: ${newButtonSize};
                height: ${newButtonSize};
                line-height: ${newButtonSize};
                font-size: calc(${newButtonSize} + 1px);
                transition: background ${transitionSpeed};
            }
            .add-button:hover {
                background: rgba(0, 0, 0, 0.5);
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

    /** Create a new untitled document, start watching, switch, update order */
    newDocument(content = sample, language = "javascript"): string {
        const name = `untitled-${untitledCount++}`
        const uri = monaco.Uri.parse(`inmemory://model/${name}`)
        const model = monaco.editor.createModel(content, language, uri)
        this.#docs.set(name, model)
        this.#watchModel(name, model)
        this.#switchTo(name)
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
                const uri = monaco.Uri.parse(`inmemory://model/${nanoid()}`)
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
                    const uri = monaco.Uri.parse(`inmemory://model/${nanoid()}`)
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
        if (first) this.#switchTo(first)
        this.#updateStoredOrder()
    }

    /** Observe model changes and save debounced */
    #watchModel(name: string, model: monaco.editor.ITextModel) {
        const existing = this.#subscriptions.get(name)
        if (existing) existing.unsubscribe()
        const change$ = fromEventPattern<monaco.editor.IModelContentChangedEvent>(
            handler => model.onDidChangeContent(handler),
            (_handler, subscription) => (subscription as monaco.IDisposable).dispose()
        ).pipe(bufferTime(1000))
        const sub = change$.subscribe(() => localStorage.setItem(`document:${name}`, model.getValue()))
        this.#subscriptions.set(name, sub)
        // initial
        localStorage.setItem(`document:${name}`, model.getValue())
    }

    /** Close a tab and update */
    #closeTab(name: string) {
        const wasActive = name === this.#active
        const sub = this.#subscriptions.get(name)
        if (sub) sub.unsubscribe()
        this.#subscriptions.delete(name)
        this.#docs.delete(name)
        this.#renderTabs()
        this.#updateStoredOrder()
        if (wasActive) {
            const next = this.#docs.keys().next().value
            if (next) this.#switchTo(next)
            else {
                this.#active = undefined
                this.dispatchEvent(new CustomEvent("activeTabChanged", { detail: undefined }))
                this.#editor.setModel(null!)
                this.#renderTabs()
            }
        }
    }

    #switchTo(name: string) {
        const model = this.#docs.get(name)
        if (!model) return
        this.#active = name
        this.#editor.setModel(model)
        this.dispatchEvent(new CustomEvent("activeTabChanged", { detail: name }))
        this.#renderTabs()
    }

    /** Update serialized order */
    #updateStoredOrder() {
        localStorage.setItem("documents", JSON.stringify(Array.from(this.#docs.keys())))
    }

    #renderTabs() {
        this.#tabContainer.innerHTML = ""
        for (const name of this.#docs.keys()) {
            const tab = document.createElement("button")
            tab.classList.add("tab-button")
            if (name === this.#active) tab.classList.add("active")
            tab.addEventListener("click", () => this.#switchTo(name))

            const label = document.createElement("span")
            label.textContent = name
            tab.appendChild(label)

            const close = document.createElement("button")
            close.classList.add("close-btn")
            close.textContent = "×"
            close.addEventListener("click", e => {
                e.stopPropagation()
                this.#closeTab(name)
            })
            tab.appendChild(close)
            this.#tabContainer.appendChild(tab)
        }
        const addBtn = document.createElement("button")
        addBtn.textContent = "+"
        addBtn.classList.add("add-button")
        addBtn.title = "New Document"
        addBtn.addEventListener("click", () => this.newDocument())
        this.#tabContainer.appendChild(addBtn)
    }
}

customElements.define("document-tabs", DocumentTabs)

const sample = `
return union(1,
    box( [2,-4,4], [20,3,3] ),
    box( [0,5,4], [20,3,3] ),
    subtract(0.5, box( [0,0,0], [10,15,8] ), sphere( [0,0,-10], {r:6} )),
)
`
