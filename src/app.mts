import * as monaco from "monaco-editor"
import "monaco-editor-env" // used at runtime, do not remove
import { bufferTime, filter, fromEventPattern } from "rxjs"
import { DocumentTabs } from "./document-tabs.mjs"
import { PreviewWindow } from "./preview-window.mjs"
import { SDFRenderer } from "./sdf.mjs"
import { LocalStorage } from "./storage/storage.mjs"
import { hexToRgb } from "./color.mjs"

class App {
    preview: PreviewWindow
    editor: monaco.editor.IStandaloneCodeEditor
    renderer: SDFRenderer
    log: HTMLDivElement
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

    constructor({
        previewWindowID,
        tabsID,
        editorContainerID,
        logID,
    }: {
        previewWindowID: string
        tabsID: string
        editorContainerID: string
        logID: string
    }) {
        this.preview = document.getElementById(previewWindowID) as PreviewWindow
        this.log = document.getElementById(logID) as HTMLDivElement

        this.editor = monaco.editor.create(document.getElementById(editorContainerID) as HTMLDivElement, {
            automaticLayout: true,
            detectIndentation: false,
            folding: false,
            fontFamily: "monospace",
            fontSize: 14,
            formatOnPaste: true,
            formatOnType: true,
            language: "javascript",
            lineNumbers: "off",
            minimap: { enabled: false },
            model: null,
            scrollBeyondLastLine: false,
            showFoldingControls: "always",
            wordWrap: "on",
            wrappingIndent: "indent",
            wrappingStrategy: "advanced",
            theme: "vs-dark",
        })

        this.#tabs = new DocumentTabs(this.editor)
        this.#tabs.addEventListener("activeTabChanged", e => this.build())
        document.getElementById(tabsID)?.replaceWith(this.#tabs)
        this.#tabs.restore()

        setTimeout(() => {
            const bg = getComputedStyle(document.querySelector(".monaco-editor")!).getPropertyValue("--vscode-editor-background")
            this.#tabs.style.setProperty("--active-bg", bg)
        }, 1)

        this.renderer = new SDFRenderer(this.preview)
        this.renderer.bgColor = hexToRgb("#333").rgba
        this.renderer
            .ready()
            .then(renderer => {
                this.build()
            })
            .catch((err: Error) => {
                console.error(`UNEXPECTED ERROR: ${err}`)
                const msg = document.createElement("p")
                msg.textContent =
                    err.name === "NotSupportedError"
                        ? "WebGPU is not supported in this browser. Try Chromium browsers like Chrome, Edge, and Opera, or Firefox Nightly."
                        : err.message
                this.preview.replaceWith(msg)
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
    }
}

export default App
