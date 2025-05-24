import * as monaco from "monaco-editor"
import "monaco-editor-env" // used at runtime, do not remove
import { bufferTime, filter, fromEventPattern } from "rxjs"
import { DocumentTabs } from "./components/document-tabs.mjs"
import { MenuButton } from "./components/menu-button.mjs"
import { PreviewWindow } from "./components/preview-window.mjs"
import { SDFRenderer } from "./sdf.mjs"
import { __bg_color, __bg_color_dark, __fg_color, __tone_1, __tone_2, __tone_3, __toolbar_height } from "./style/style.mjs"
import { saveSTLBufferToDisk } from "./fs/fs.mjs"

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
            "semanticHighlighting.enabled": true,
            autoClosingBrackets: "beforeWhitespace",
            autoClosingDelete: "always",
            autoClosingOvertype: "always",
            autoClosingQuotes: "beforeWhitespace",
            autoIndent: "advanced",
            automaticLayout: true,
            copyWithSyntaxHighlighting: false,
            detectIndentation: false,
            folding: false,
            fontLigatures: true,
            fontSize: 16,
            fontVariations: true,
            formatOnPaste: true,
            formatOnType: true,
            language: "javascript",
            lineNumbers: "on",
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

        requestAnimationFrame(() => {
            const bg = getComputedStyle(document.querySelector(".monaco-editor")!).getPropertyValue("--vscode-editor-background")
            this.#tabs.style.setProperty("--active-bg", bg)
        })

        this.renderer = new SDFRenderer(preview)
        this.renderer
            .ready()
            .then(() => {
                this.#tabs.addEventListener("activeTabChanged", e => this.build())
                this.build()

                fromEventPattern<monaco.editor.IModelContentChangedEvent>(
                    h => this.editor.onDidChangeModelContent(h),
                    (_, disp) => disp.dispose()
                )
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
                const exportItem = document.createElement("span")
                exportItem.innerHTML = "Export to STL"
                const menuButton = new MenuButton([
                    { element: newItem, action: () => this.#tabs.newDocument() },
                    { element: renameItem, action: () => console.log("TODO: rename") },
                    { element: deleteItem, action: () => this.#tabs.deleteCurrentTab() },
                    {
                        element: exportItem,
                        action: async () => {
                            const stl = await this.renderer.exportSTL(this.editor.getValue())
                            await saveSTLBufferToDisk(stl, `${this.#tabs.active}.stl`)
                        },
                    },
                ])
                menu.replaceWith(menuButton)
            })
            .catch(err => {
                console.error(`UNEXPECTED ERROR: ${err}`)
                const msg = document.createElement("p")
                msg.textContent =
                    err.name === "NotSupportedError"
                        ? "WebGPU is not supported in this browser. Try Chromium browsers like Chrome, Edge, and Opera. Or Firefox Nightly."
                        : err.message
                preview.replaceWith(msg)
            })
    }
}
export default App
