import * as monaco from "monaco-editor"
import "monaco-editor-env" // used at runtime, do not remove
import { bufferTime, filter, fromEventPattern } from "rxjs"
import { PreviewWindow } from "./preview-window.mjs"
import { SDFRenderer } from "./sdf.mjs"
import { LocalStorage } from "./storage/storage.mjs"
import { DocumentTabs } from "./document-tabs.mjs"

class App {
    preview: PreviewWindow
    editor: monaco.editor.IStandaloneCodeEditor
    renderer: SDFRenderer
    log: HTMLDivElement
    #ls: LocalStorage
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
        this.#ls = LocalStorage.instance
        this.preview = document.getElementById(previewWindowID) as PreviewWindow
        this.log = document.getElementById(logID) as HTMLDivElement

        this.editor = monaco.editor.create(document.getElementById(editorContainerID) as HTMLDivElement, {
            language: "javascript",
            automaticLayout: true,
            theme: "vs-dark",
            minimap: { enabled: false },
            model: null,
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

const sample = `
union(1,
    box( [2,-4,4], [20,3,3] ),
    box( [0,5,4], [20,3,3] ),
    subtract(0.5, box( [0,0,0], [10,20,8] ), sphere( [0,0,-10], {r:6} )),
)
`
