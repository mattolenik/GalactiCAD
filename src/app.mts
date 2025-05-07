import * as monaco from "monaco-editor"
import "monaco-editor-env" // used at runtime, do not remove
import { bufferTime, filter, fromEventPattern } from "rxjs"
import { DocumentTabs } from "./document-tabs.mjs"
import { PreviewWindow } from "./preview-window.mjs"
import { SDFRenderer } from "./sdf.mjs"
import { __bg_color, __bg_color_dark, __fg_color, __tone_1, __tone_2, __tone_3, __toolbar_height } from "./style/style.mjs"
import { MenuButton } from "./components/menu-button.mjs"

class App {
    editor: monaco.editor.IStandaloneCodeEditor
    renderer: SDFRenderer
    #tabs: DocumentTabs

    build() {
        try {
            this.renderer.build(this.editor.getValue())
            this.renderer.startLoop()
            this.log.innerText = ""
        } catch (err) {
            this.log.innerText = `💢 ${err}`
        }
    }

    constructor(
        preview: PreviewWindow,
        tabs: HTMLDivElement,
        editorContainer: HTMLDivElement,
        private log: HTMLDivElement,
        menu: HTMLElement
    ) {
        this.editor = monaco.editor.create(editorContainer, {
            autoClosingBrackets: "beforeWhitespace",
            autoClosingDelete: "always",
            autoClosingOvertype: "always",
            autoClosingQuotes: "beforeWhitespace",
            autoIndent: "advanced",
            automaticLayout: true,
            copyWithSyntaxHighlighting: false,
            detectIndentation: false,
            folding: false,
            fontSize: 16,
            formatOnPaste: true,
            formatOnType: true,
            language: "javascript",
            lineNumbers: "off",
            minimap: { enabled: false },
            model: null,
            scrollBeyondLastLine: false,
            showFoldingControls: "always",
            stickyTabStops: true,
            tabSize: 3,
            theme: "vs-dark",
            useTabStops: true,
            wordWrap: "on",
            wrappingIndent: "indent",
            wrappingStrategy: "advanced",
        })

        this.#tabs = new DocumentTabs(this.editor)
        this.#tabs.addEventListener("activeTabChanged", e => this.build())
        tabs.replaceWith(this.#tabs)
        this.#tabs.id = tabs.id
        this.#tabs.restore()

        const style = document.createElement("style")
        style.textContent = `
            :root {
                ${__fg_color}: whitesmoke;
                ${__bg_color}: #333;
                ${__bg_color_dark}: #222;
                ${__tone_1}: #888;
                ${__tone_2}: #444;
                ${__tone_3}: #666;
                ${__toolbar_height}: 30px;
            }
        `
        document.body.appendChild(style)
        // const addButton = document.getElementById("newDoc") as HTMLButtonElement
        // addButton.onclick = () => this.#tabs.newDocument()

        requestAnimationFrame(() => {
            const bg = getComputedStyle(document.querySelector(".monaco-editor")!).getPropertyValue("--vscode-editor-background")
            this.#tabs.style.setProperty("--active-bg", bg)
        })

        this.renderer = new SDFRenderer(preview)
        this.renderer
            .ready()
            .then(renderer => this.build())
            .catch((err: Error) => {
                console.error(`UNEXPECTED ERROR: ${err}`)
                const msg = document.createElement("p")
                msg.textContent =
                    err.name === "NotSupportedError"
                        ? "WebGPU is not supported in this browser. Try Chromium browsers like Chrome, Edge, and Opera, or Firefox Nightly."
                        : err.message
                preview.replaceWith(msg)
            })

        const change$ = fromEventPattern<monaco.editor.IModelContentChangedEvent>(
            h => this.editor.onDidChangeModelContent(h),
            (_, disp) => disp.dispose()
        )

        change$
            .pipe(
                bufferTime(100),
                filter(arr => arr.length > 0)
            )
            .subscribe(events => {
                this.build()
            })

        const newItem = document.createElement("span")
        newItem.innerHTML = "New Sketch"
        const renameItem = document.createElement("span")
        renameItem.innerHTML = "Rename"
        const deleteItem = document.createElement("span")
        deleteItem.innerHTML = "Delete"
        const menuButton = new MenuButton([
            { element: newItem, action: () => this.#tabs.newDocument() },
            { element: renameItem, action: () => console.log("item2") },
            { element: deleteItem, action: () => console.log("item2") },
        ])
        menu.replaceWith(menuButton)
    }
}

export default App
