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

        // setup shadow DOM
        this.attachShadow({ mode: "open" })
        this.#tabContainer = document.createElement("div")
        Object.assign(this.#tabContainer.style, {
            display: "flex",
            alignItems: "center",
            gap: "4px",
            marginBottom: "8px",
        })
        this.shadowRoot!.appendChild(this.#tabContainer)

        this.#renderTabs()
    }

    /**
     * Current active document name (if any)
     */
    get active(): string | undefined {
        return this.#active
    }

    /**
     * Retrieve a model by filename
     */
    getByName(name: string): monaco.editor.ITextModel | undefined {
        return this.#docs.get(name)
    }

    /**
     * All documents in insertion order
     */
    get allDocuments(): Iterable<monaco.editor.ITextModel> {
        return this.#docs.values()
    }

    /**
     * Create a new untitled document, start watching its changes, switch to it,
     * and update stored order.
     */
    newDocument(content = "group(sphere('0 0 0', {r:5}))", language = "javascript"): string {
        const name = `untitled-${untitledCount++}`
        const uri = monaco.Uri.parse(`inmemory://model/${name}`)
        const model = monaco.editor.createModel(content, language, uri)
        this.#docs.set(name, model)
        this.#watchModel(name, model)
        this.#switchTo(name)
        this.#updateStoredOrder()
        return name
    }

    /**
     * Restore tabs from saved order or from localStorage keys.
     * Clears existing tabs, loads models in correct order,
     * or creates a default if none found.
     */
    restore(): void {
        // clear existing docs and subscriptions
        for (const name of Array.from(this.#docs.keys())) {
            const sub = this.#subscriptions.get(name)
            if (sub) sub.unsubscribe()
            this.#subscriptions.delete(name)
            this.#docs.delete(name)
        }

        // determine restore order
        const prefix = "document:"
        const storedOrder = JSON.parse(localStorage.getItem("documents") || "[]") as string[]
        const loaded = new Set<string>()

        // load in stored order
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

        // fallback: any keys not in storedOrder
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

        // if none, create default
        if (this.#docs.keys().next().done) {
            this.newDocument()
            return
        }

        // activate first restored document
        const first = this.#docs.keys().next().value
        if (first) {
            this.#switchTo(first)
        }

        this.#updateStoredOrder()
    }

    /**
     * Observe model changes and save content debounced
     */
    #watchModel(name: string, model: monaco.editor.ITextModel) {
        const existing = this.#subscriptions.get(name)
        if (existing) {
            existing.unsubscribe()
        }

        const change$ = fromEventPattern<monaco.editor.IModelContentChangedEvent>(
            handler => model.onDidChangeContent(handler),
            (_handler, subscription) => (subscription as monaco.IDisposable).dispose()
        ).pipe(bufferTime(1000))

        const sub = change$.subscribe(() => {
            localStorage.setItem(`document:${name}`, model.getValue())
        })
        this.#subscriptions.set(name, sub)

        // initial save
        localStorage.setItem(`document:${name}`, model.getValue())
    }

    /**
     * Close a tab, switch, rerender, and update order
     * Does NOT remove from localStorage
     */
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
            if (next) {
                this.#switchTo(next)
            } else {
                this.#active = undefined
                this.#editor.setModel(null!)
                // notify subscribers of activeTabChanged to undefined
                this.dispatchEvent(new CustomEvent("activeTabChanged", { detail: undefined }))
                this.#renderTabs()
            }
        }
    }

    #switchTo(name: string) {
        const model = this.#docs.get(name)
        if (!model) return
        this.#active = name
        this.#editor.setModel(model)
        // fire event when active tab changes
        this.dispatchEvent(new CustomEvent("activeTabChanged", { detail: name }))
        this.#renderTabs()
    }

    /**
     * Update the serialized documents order in localStorage
     */
    #updateStoredOrder() {
        const order = Array.from(this.#docs.keys())
        localStorage.setItem("documents", JSON.stringify(order))
    }

    #renderTabs() {
        this.#tabContainer.innerHTML = ""
        for (const oldName of this.#docs.keys()) {
            const btn = document.createElement("button")
            btn.textContent = oldName
            Object.assign(btn.style, {
                padding: "4px 8px",
                border: oldName === this.#active ? "2px solid #007acc" : "1px solid #ccc",
            })
            btn.addEventListener("click", () => this.#switchTo(oldName))

            // middle click to close
            btn.addEventListener("auxclick", e => {
                if (e.button !== 1) return
                e.preventDefault()
                const model = this.#docs.get(oldName)
                if (!model) return
                const isEmpty = model.getValue() === "" && model.getAlternativeVersionId() === 1
                if (isEmpty) {
                    this.#closeTab(oldName)
                } else if (window.confirm(`Close "${oldName}"? Unsaved changes will be lost.`)) {
                    this.#closeTab(oldName)
                }
            })

            // double-click to rename
            btn.addEventListener("dblclick", () => {
                const oldKey = oldName
                const newName = window.prompt(`Rename "${oldKey}" to:`, oldKey)?.trim()
                if (newName && newName !== oldKey) {
                    const model = this.#docs.get(oldKey)
                    if (!model) return
                    const sub = this.#subscriptions.get(oldKey)
                    if (sub) sub.unsubscribe()
                    this.#subscriptions.delete(oldKey)

                    this.#docs.delete(oldKey)
                    this.#docs.set(newName, model)

                    const oldKeyStorage = `document:${oldKey}`
                    const newKeyStorage = `document:${newName}`
                    const content = localStorage.getItem(oldKeyStorage)
                    if (content !== null) {
                        localStorage.setItem(newKeyStorage, content)
                        localStorage.removeItem(oldKeyStorage)
                    }

                    this.#watchModel(newName, model)
                    if (this.#active === oldKey) this.#active = newName
                    this.#renderTabs()
                    this.#updateStoredOrder()
                }
            })

            this.#tabContainer.appendChild(btn)
        }

        // new-document button
        const addBtn = document.createElement("button")
        addBtn.textContent = "+"
        addBtn.title = "New Document"
        Object.assign(addBtn.style, {
            padding: "4px 8px",
            border: "1px solid #ccc",
            cursor: "pointer",
        })
        addBtn.addEventListener("click", () => this.newDocument())
        this.#tabContainer.appendChild(addBtn)
    }
}

// register the custom element
customElements.define("document-tabs", DocumentTabs)
