import * as monaco from "monaco-editor"
import { fromEventPattern, Subscription } from "rxjs"
import { bufferTime } from "rxjs/operators"
import { OrderedMap } from "./collections/orderedMap.mjs"

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

        const tabHeight = "40px"
        const closeButtonSize = "24px"
        const cornerRadius = "0.5rem"

        // inject styles
        const style = document.createElement("style")
        style.textContent = `
            button {
                color: whitesmoke;
            }
            .tabs-container {
                display: flex;
                align-items: center;
                gap: 4px;
                margin-top: -1px;
            }
            .tab-button {
                border: none;
                height: ${tabHeight};
                display: flex;
                align-items: center;
                padding: 0px 12px;
                border-bottom: 2px solid #888;
                border-right: 2px solid #888;
                background: none;
                opacity: 0.6;
                cursor: pointer;
                white-space: nowrap;
                color: #aaa;
                border-radius: 0 0 ${cornerRadius} ${cornerRadius};
                font-size: large;
            }
            .tab-button:hover {
                opacity: 1;
            }
            .tab-button.active {
                opacity: 1;
                box-sizing: border-box;
                background-color: var(--active-bg);
                border-width: 0 2px 4px 0;
                border-color: #007acc;
                padding-top: 1px;
                color: whitesmoke;
            }
            .close-btn {
                margin-left: 10px;
                font-size: ${closeButtonSize};
                cursor: pointer;
                color: #888;
                background: none;
                border: none;
                width: ${closeButtonSize};
                height: ${closeButtonSize};
                line-height: ${closeButtonSize};
                border-radius: 5px;
                transition: background 0.2s;
            }
            .close-btn:hover {
                background: #444;
                color: whitesmoke;
            }
            .add-button {
                padding: 4px 8px;
                margin-left: 6px;
                border: 1px solid #888;
                border-radius: 6px;
                background: none;
                cursor: pointer;
                color: #888;
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
            const btn = document.createElement("button")
            btn.classList.add("tab-button")
            if (name === this.#active) btn.classList.add("active")
            btn.addEventListener("click", () => this.#switchTo(name))
            // label
            const label = document.createElement("span")
            label.textContent = name
            btn.appendChild(label)
            // close icon
            const closeBtn = document.createElement("span")
            closeBtn.classList.add("close-btn")
            closeBtn.textContent = "×"
            closeBtn.addEventListener("click", e => {
                e.stopPropagation()
                this.#closeTab(name)
            })
            btn.appendChild(closeBtn)
            this.#tabContainer.appendChild(btn)
        }
        // add button
        const addBtn = document.createElement("button")
        addBtn.textContent = "+"
        addBtn.classList.add("add-button")
        addBtn.title = "New Document"
        addBtn.addEventListener("click", () => this.newDocument())
        this.#tabContainer.appendChild(addBtn)
    }
}

// register the custom element
customElements.define("document-tabs", DocumentTabs)

const sample = `
union(1,
    box( [2,-4,4], [20,3,3] ),
    box( [0,5,4], [20,3,3] ),
    subtract(0.5, box( [0,0,0], [10,15,8] ), sphere( [0,0,-10], {r:6} )),
)
`
