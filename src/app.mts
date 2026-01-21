import * as monaco from "monaco-editor"
import "monaco-editor-env" // used at runtime, do not remove
import { bufferTime, filter, fromEventPattern } from "rxjs"
import { DocumentTabs } from "./components/document-tabs.mjs"
import { MenuButton } from "./components/menu-button.mjs"
import type { MeshViewer } from "./components/mesh-viewer.mjs"
import type { PreviewWindow } from "./components/preview-window.mjs"
import type { CameraState } from "./controls/camera-controller.mjs"
import { SDFRenderer } from "./sdf.mjs"
import { __bg_color, __bg_color_dark, __fg_color, __tone_1, __tone_2, __tone_3, __toolbar_height } from "./style/style.mjs"
import { exportStlBinary } from "./export/stl.mjs"

class App {
    editor: monaco.editor.IStandaloneCodeEditor
    renderer: SDFRenderer
    #tabs: DocumentTabs
    #mesh: MeshViewer
    #meshUpdateToken = 0
    #meshUpdateTimer: number | null = null

    build() {
        try {
            const src = this.editor.getValue()
            this.renderer.build(src)
            this.renderer.startLoop()
            this.#scheduleMeshUpdate(src)
            this.log.innerText = ""
        } catch (err) {
            this.log.innerText = `💢 ${err}`
        }
    }

    constructor(
        preview: PreviewWindow,
        mesh: MeshViewer,
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
            colorDecorators: true,
            colorDecoratorsActivatedOn: "click",
            copyWithSyntaxHighlighting: false,
            detectIndentation: true,
            folding: true,
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
            showUnused: true,
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
        this.#mesh = mesh

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

        // Keep mesh + preview cameras in sync (two-way).
        // Guard against infinite loops by suppressing re-emits during propagation.
        {
            const previewControls = this.renderer.controls
            const meshControls = this.#mesh.controls
            let syncing = false

            const push = (from: "preview" | "mesh", state: CameraState) => {
                if (syncing) return
                syncing = true
                if (from === "preview") {
                    meshControls.applyState(state, { emit: false })
                } else {
                    previewControls.applyState(state, { emit: false })
                }
                syncing = false
            }

            previewControls.onChange = state => push("preview", state)
            meshControls.onChange = state => push("mesh", state)
            // Ensure identical initial state even if load order differs.
            meshControls.applyState(previewControls.state, { emit: false })
        }

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
                const exportZSliceItem = document.createElement("span")
                exportZSliceItem.innerHTML = "Export to STL (Z-slice)"
                const menuButton = new MenuButton([
                    { element: newItem, action: () => this.#tabs.newDocument() },
                    { element: renameItem, action: () => console.log("TODO: rename") },
                    { element: deleteItem, action: () => this.#tabs.deleteCurrentTab() },
                    {
                        element: exportItem,
                        action: async () => {
                            try {
                                const documentName = this.#tabs.active!
                                const handle = await window.showSaveFilePicker({
                                    suggestedName: documentName,
                                    startIn: "desktop",
                                    types: [
                                        {
                                            description: "STL file",
                                            accept: { "model/stl": [".stl"] },
                                        },
                                    ],
                                    excludeAcceptAllOption: false,
                                })
                                const mesh = await this.renderer.renderMesh(this.editor.getValue())
                                await exportStlBinary(documentName, handle, mesh.verts, mesh.tris)
                            } catch (err) {
                                if (`${err}`.includes("AbortError")) {
                                    return
                                }
                                throw err
                            }
                        },
                    },
                    {
                        element: exportZSliceItem,
                        action: async () => {
                            try {
                                const documentName = this.#tabs.active!
                                const handle = await window.showSaveFilePicker({
                                    suggestedName: `${documentName}-zslice`,
                                    startIn: "desktop",
                                    types: [
                                        {
                                            description: "STL file",
                                            accept: { "model/stl": [".stl"] },
                                        },
                                    ],
                                    excludeAcceptAllOption: false,
                                })
                                const mesh = await this.renderer.renderMeshZSlice(this.editor.getValue())
                                await exportStlBinary(documentName, handle, mesh.verts, mesh.tris)
                            } catch (err) {
                                if (`${err}`.includes("AbortError")) {
                                    return
                                }
                                throw err
                            }
                        },
                    },
                ])
                menu.replaceWith(menuButton)
            })
            .catch(err => {
                console.error(`UNEXPECTED ERROR: ${err}`)
                const msg = document.createElement("p")
                msg.textContent =
                    "WebGPU is not supported in this browser. Try Chromium browsers like Chrome, Edge, and Opera. Or Firefox Nightly."
                preview.replaceWith(msg)
            })
    }

    #scheduleMeshUpdate(src: string) {
        // Meshing is expensive; debounce so we don't re-mesh on every keystroke.
        if (this.#meshUpdateTimer !== null) {
            clearTimeout(this.#meshUpdateTimer)
            this.#meshUpdateTimer = null
        }

        const token = ++this.#meshUpdateToken
        this.#meshUpdateTimer = window.setTimeout(async () => {
            try {
                const mesh = await this.renderer.renderMeshZSlice(src)
                if (token !== this.#meshUpdateToken) return
                await this.#mesh.setMesh(mesh)
            } catch (err) {
                // Mesh generation failing shouldn't break the live SDF preview.
                console.error(`Mesh update failed: ${err}`)
            }
        }, 600)
    }
}
export default App
