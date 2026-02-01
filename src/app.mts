import * as monaco from "monaco-editor"
import "monaco-editor-env" // used at runtime, do not remove
import { bufferTime, filter, fromEventPattern } from "rxjs"
import { DocumentTabs } from "./components/document-tabs.mjs"
import { MenuButton } from "./components/menu-button.mjs"
import { MeshViewer } from "./components/mesh-viewer.mjs"
import type { PreviewWindow } from "./components/preview-window.mjs"
import type { CameraState } from "./controls/camera-controller.mjs"
import { SDFRenderer } from "./sdf.mjs"
import { __bg_color, __bg_color_dark, __fg_color, __tone_1, __tone_2, __tone_3, __toolbar_height } from "./style/style.mjs"
import { exportStlBinary } from "./export/stl.mjs"
import { LocalStorage } from "./storage/storage.mjs"
import { MonacoHighlighter, type HighlightRange } from "./highlighting/monaco-highlighter.mjs"
import { SourceParser, type SourceLocation } from "./parser/source-parser.mjs"
import { matchNodesToSource } from "./parser/node-matcher.mjs"

class App {
    editor: monaco.editor.IStandaloneCodeEditor
    renderer: SDFRenderer
    #tabs: DocumentTabs
    #mesh: MeshViewer | null = null
    #meshUpdateToken = 0
    #meshUpdateTimer: number | null = null
    #viewports: HTMLElement
    #ls: LocalStorage
    #meshViewerEnabled = false
    #sourceParser: SourceParser
    #sourceLocationMap: Map<number, SourceLocation> = new Map()
    #monacoHighlighter: MonacoHighlighter

    build() {
        try {
            const src = this.editor.getValue()
            
            // Build the scene
            this.renderer.build(src)
            
            // Parse the source code to extract shape function calls with their arguments
            const parsedCalls = this.#sourceParser.parseShapeCalls(src)
            
            // Get all scene nodes
            const sceneNodes = this.renderer.getSceneNodes()
            
            // Match scene nodes to source code by comparing property values
            this.#sourceLocationMap = matchNodesToSource(sceneNodes, parsedCalls)
            
            console.debug("[App] Source location map:", Array.from(this.#sourceLocationMap.entries()))
            
            this.renderer.startLoop()
            this.#scheduleMeshUpdate(src)
            this.log.innerText = ""
            
            // Update highlighting for current selection after build
            this.#updateEditorHighlighting()
        } catch (err) {
            this.log.innerText = `💢 ${err}`
            // Clear highlighting on build error
            this.#monacoHighlighter.clearHighlighting()
        }
    }
    
    /**
     * Update Monaco editor highlighting based on selected object IDs
     */
    #updateEditorHighlighting() {
        const selectedIds = this.renderer.selectedObjectIds

        console.log("[App] Updating editor highlighting for selected IDs:", selectedIds)

        if (selectedIds.length === 0) {
            console.log("[App] No selected IDs, clearing highlighting")
            this.#monacoHighlighter.clearHighlighting()
            return
        }

        // Map selected IDs to their source ranges
        const highlightRanges: HighlightRange[] = []
        for (const id of selectedIds) {
            const location = this.#sourceLocationMap.get(id)
            if (location) {
                // The AST parser provides exact start/end positions for the function name
                highlightRanges.push({
                    startLine: location.startLine,
                    startColumn: location.startColumn,
                    endLine: location.endLine,
                    endColumn: location.endColumn
                })
                console.debug(`[App] ID ${id}: '${location.functionName}' at line ${location.startLine}:${location.startColumn}`)
            } else {
                console.debug(`[App] ID ${id}: No source location found`)
            }
        }

        console.log(`[App] Built ${highlightRanges.length} highlight range(s):`, highlightRanges)

        if (highlightRanges.length > 0) {
            this.#monacoHighlighter.highlightRanges(highlightRanges)
        } else {
            this.#monacoHighlighter.clearHighlighting()
        }
    }

    constructor(
        preview: PreviewWindow,
        tabs: HTMLDivElement,
        editorContainer: HTMLDivElement,
        private log: HTMLDivElement,
        menu: HTMLElement
    ) {
        this.#ls = LocalStorage.instance
        this.#viewports = document.getElementById("viewports")!
        
        // Initialize source parser and highlighter for selection sync
        this.#sourceParser = new SourceParser()
        this.#monacoHighlighter = new MonacoHighlighter()

        // Remove any existing mesh viewer from HTML (we create it dynamically when enabled)
        const existingMesh = document.getElementById("mesh")
        if (existingMesh) {
            existingMesh.remove()
        }

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

            /* Highlighted function name styling for selected shapes in Monaco editor */
            .selected-shape-name {
                background-color: rgba(255, 255, 0, 0.3) !important;
                border: 1px solid rgba(255, 255, 0, 0.5) !important;
                border-radius: 2px !important;
                padding: 0 2px !important;
                box-shadow: 0 0 4px rgba(255, 255, 0, 0.3) !important;
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
                // Set up Monaco highlighter with the editor instance
                this.#monacoHighlighter.setEditor(this.editor)
                
                // Listen for selection changes to update editor highlighting
                this.renderer.onSelectionChange = () => {
                    this.#updateEditorHighlighting()
                }
                
                this.#tabs.addEventListener("activeTabChanged", e => {
                    this.build()
                    // Clear highlighting when switching tabs
                    this.#monacoHighlighter.clearHighlighting()
                })
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

                // Mesh viewer toggle checkbox
                const meshViewerContainer = document.createElement("div")
                meshViewerContainer.style.display = "flex"
                meshViewerContainer.style.alignItems = "center"
                meshViewerContainer.style.gap = "8px"
                meshViewerContainer.style.cursor = "pointer"
                const meshViewerCheckbox = document.createElement("input")
                meshViewerCheckbox.type = "checkbox"
                // Prevent checkbox from toggling on its own click (action handles it)
                meshViewerCheckbox.style.pointerEvents = "none"
                // Default to disabled (not present)
                const meshViewerEnabled = this.#ls.getItem("app.meshViewerEnabled") === "true"
                meshViewerCheckbox.checked = meshViewerEnabled
                this.#setMeshViewerEnabled(meshViewerEnabled)
                const meshViewerText = document.createElement("span")
                meshViewerText.textContent = "Show Mesh Viewer"
                meshViewerContainer.append(meshViewerCheckbox, meshViewerText)

                const menuButton = new MenuButton([
                    { element: newItem, action: () => this.#tabs.newDocument() },
                    { element: renameItem, action: () => this.#tabs.renameCurrentTab() },
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
                        element: meshViewerContainer,
                        action: () => {
                            const enabled = !meshViewerCheckbox.checked
                            meshViewerCheckbox.checked = enabled
                            this.#setMeshViewerEnabled(enabled)
                            this.#ls.setItem("app.meshViewerEnabled", enabled ? "true" : "false")
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
        // Skip mesh updates if mesh viewer is not enabled
        if (!this.#meshViewerEnabled || !this.#mesh) {
            return
        }

        // Meshing is expensive; debounce so we don't re-mesh on every keystroke.
        if (this.#meshUpdateTimer !== null) {
            clearTimeout(this.#meshUpdateTimer)
            this.#meshUpdateTimer = null
        }

        const token = ++this.#meshUpdateToken
        this.#meshUpdateTimer = window.setTimeout(async () => {
            try {
                const mesh = await this.renderer.renderMesh(src)
                if (token !== this.#meshUpdateToken) return
                if (this.#mesh) {
                    await this.#mesh.setMesh(mesh)
                }
            } catch (err) {
                // Mesh generation failing shouldn't break the live SDF preview.
                console.error(`Mesh update failed: ${err}`)
            }
        }, 600)
    }

    #setMeshViewerEnabled(enabled: boolean) {
        // Guard against duplicate calls
        if (enabled === this.#meshViewerEnabled && (enabled ? this.#mesh : !this.#mesh)) {
            return
        }
        this.#meshViewerEnabled = enabled

        if (enabled) {
            // Remove any existing mesh viewer first
            if (this.#mesh) {
                this.#mesh.remove()
                this.#mesh = null
            }

            // Create mesh viewer element dynamically using the class constructor
            const meshViewer = new MeshViewer()
            meshViewer.id = "mesh"

            // Add element to viewports (flexbox will distribute space automatically)
            this.#viewports.appendChild(meshViewer)
            this.#mesh = meshViewer

            // Wait for layout to settle before setting up camera sync
            requestAnimationFrame(() => {
                if (!this.#mesh) return // Guard against race with disable

                // Set up camera sync between preview and mesh viewer
                const previewControls = this.renderer.controls
                const meshControls = meshViewer.controls
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
                // Sync initial camera state
                meshControls.applyState(previewControls.state, { emit: false })

                // Trigger a mesh update for the current source
                this.#scheduleMeshUpdate(this.editor.getValue())
            })
        } else {
            // Remove mesh viewer from DOM and release reference
            if (this.#mesh) {
                this.#mesh.remove()
                this.#mesh = null
            }

            // Clear any pending mesh update
            if (this.#meshUpdateTimer !== null) {
                clearTimeout(this.#meshUpdateTimer)
                this.#meshUpdateTimer = null
            }

            // Remove mesh viewer's camera change handler from preview controls
            this.renderer.controls.onChange = undefined
        }
    }
}
export default App
