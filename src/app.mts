import * as monaco from "monaco-editor"
import "monaco-editor-env" // used at runtime, do not remove
import { bufferTime, filter, fromEventPattern } from "rxjs"
import { DocumentTabs } from "./components/document-tabs.mjs"
import { MenuButton } from "./components/menu-button.mjs"
import { MeshViewer } from "./components/mesh-viewer.mjs"
import type { PreviewWindow } from "./components/preview-window.mjs"
import type { CameraState } from "./controls/camera-controller.mjs"
import { SDFRenderer } from "./sdf.mjs"
import { __bg_color, __bg_color_dark, __fg_color, __tone_1, __tone_2, __tone_3, __tone_accent, __toolbar_height } from "./style/style.mjs"
import { exportStlBinary } from "./export/stl.mjs"
import { SettingsManager } from "./storage/settings.mjs"
import { MonacoHighlighter, type HighlightRange, type ShapeIndicator } from "./highlighting/monaco-highlighter.mjs"
import { SourceParser, type SourceLocation } from "./parser/source-parser.mjs"
import { matchNodesToSource } from "./parser/node-matcher.mjs"
import { DevToolsPanel } from "./components/dev-tools-panel.mjs"
import { ResizeHandle } from "./components/resize-handle.mjs"

class App {
    editor: monaco.editor.IStandaloneCodeEditor
    renderer: SDFRenderer
    #tabs: DocumentTabs
    #mesh: MeshViewer | null = null
    #meshUpdateToken = 0
    #meshUpdateTimer: number | null = null
    #viewports: HTMLElement
    #settings: SettingsManager
    #meshViewerEnabled = false
    #originalPreviewOnChange: ((state: CameraState) => void) | undefined
    #sourceParser: SourceParser
    #sourceLocationMap: Map<number, SourceLocation> = new Map()
    #sceneNodeMap: Map<number, import("./scene/scene.mjs").Node> = new Map()  // nodeId -> Node for symbol lookup
    #monacoHighlighter: MonacoHighlighter
    #isUpdatingFromPreview = false  // Prevent selection feedback loops

    build() {
        try {
            const model = this.editor.getModel()
            if (!model) {
                // No active model - don't try to build
                return
            }
            const src = this.editor.getValue()

            // Build the scene
            this.renderer.build(src)

            // Parse the source code to extract shape function calls with their arguments
            const parsedCalls = this.#sourceParser.parseShapeCalls(src)

            // Get all scene nodes and build a map for quick lookup
            const sceneNodes = this.renderer.getSceneNodes()
            this.#sceneNodeMap.clear()
            for (const node of sceneNodes) {
                this.#sceneNodeMap.set(node.id, node)
            }

            // Match scene nodes to source code by comparing property values
            this.#sourceLocationMap = matchNodesToSource(sceneNodes, parsedCalls)

            console.debug("[App] Source location map:", Array.from(this.#sourceLocationMap.entries()))

            // Update color indicators for all matched shapes
            this.#updateColorIndicators()

            this.renderer.startLoop()
            this.#scheduleMeshUpdate(src)
            this.log.innerText = ""

            // Update highlighting for current selection after build
            this.#updateEditorHighlighting()
        } catch (err) {
            this.log.innerText = `💢 ${err}`
            // Clear selection highlighting on build error, but KEEP color indicators
            // This preserves visual feedback during transient errors while editing
            this.#monacoHighlighter.clearHighlighting()
            // Don't clear color indicators - they'll update when build succeeds
        }
    }

    /**
     * Update color indicator decorations for all matched shapes.
     * Uses node IDs from the source location map for color assignment.
     * Gets the indicator SVG from the scene node.
     */
    #updateColorIndicators() {
        const indicators: ShapeIndicator[] = []

        // Default SVG for nodes that don't have a specific one
        const defaultSvg = `<rect x="1" y="1" width="10" height="10" rx="3" fill="currentColor"/>`

        for (const [nodeId, location] of this.#sourceLocationMap.entries()) {
            const node = this.#sceneNodeMap.get(nodeId)
            const svg = node?.getIndicatorSvg() ?? defaultSvg

            indicators.push({
                startLine: location.startLine,
                startColumn: location.startColumn,
                endLine: location.endLine,
                endColumn: location.endColumn,
                nodeId: nodeId,
                functionName: location.functionName,
                svg: svg
            })
        }

        this.#monacoHighlighter.setColorIndicators(indicators)
    }

    /**
     * Update Monaco editor highlighting based on selected object IDs
     */
    #updateEditorHighlighting() {
        const selectedIds = this.renderer.selectedObjectIds

        if (selectedIds.length === 0) {
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
            }
        }

        if (highlightRanges.length > 0) {
            this.#monacoHighlighter.highlightRanges(highlightRanges)
        } else {
            this.#monacoHighlighter.clearHighlighting()
        }
    }

    /**
     * Find node ID at a given editor position (line, column).
     * Used for editor-to-preview selection sync.
     */
    #findNodeIdAtPosition(line: number, column: number): number | null {
        for (const [nodeId, location] of this.#sourceLocationMap.entries()) {
            // Check if position is within the function name range
            if (line >= location.startLine && line <= location.endLine) {
                if (line === location.startLine && column < location.startColumn) continue
                if (line === location.endLine && column > location.endColumn) continue
                return nodeId
            }
        }
        return null
    }

    /**
     * Check if the current editor selection exactly matches a function name.
     * Returns the node ID if matched, null otherwise.
     */
    #findNodeIdForSelection(selection: monaco.Selection): number | null {
        const startLine = selection.startLineNumber
        const startColumn = selection.startColumn
        const endLine = selection.endLineNumber
        const endColumn = selection.endColumn

        for (const [nodeId, location] of this.#sourceLocationMap.entries()) {
            // Check if selection exactly matches the function name range
            if (startLine === location.startLine &&
                startColumn === location.startColumn &&
                endLine === location.endLine &&
                endColumn === location.endColumn) {
                return nodeId
            }
        }
        return null
    }

    /**
     * Handle editor selection to sync with preview.
     * Selects the corresponding object if a function name is fully selected.
     * For CSG operators (union, subtract, group), selects all descendants too.
     */
    #handleEditorSelection() {
        if (this.#isUpdatingFromPreview) return

        const selection = this.editor.getSelection()
        if (!selection || selection.isEmpty()) return

        const nodeId = this.#findNodeIdForSelection(selection)
        if (nodeId !== null) {
            // Get the node and check if it's a composite (CSG/group)
            const node = this.#sceneNodeMap.get(nodeId)
            if (node) {
                // Use getAllDescendantIds to select this node and all children
                const allIds = node.getAllDescendantIds()
                this.renderer.setSelection(allIds)
            } else {
                this.renderer.setSelection([nodeId])
            }
            // Also update editor highlighting to show the selection highlight
            this.#updateEditorHighlighting()
        }
    }

    /**
     * Handle mouse click on the editor to check for color indicator clicks.
     * For CSG operators (union, subtract, group), selects all descendants too.
     */
    #handleEditorMouseDown(e: monaco.editor.IEditorMouseEvent) {
        if (this.#isUpdatingFromPreview) return

        // Check if clicking on a decoration (the color indicator)
        if (e.target.type === monaco.editor.MouseTargetType.CONTENT_TEXT) {
            const position = e.target.position
            if (position) {
                // Check if there's a color indicator decoration at this position
                // by looking for a shape at column 1 of this line or at the clicked position
                const nodeId = this.#findNodeIdAtPosition(position.lineNumber, position.column)
                if (nodeId !== null) {
                    // Check if clicking on or near the start of a shape function
                    const location = this.#sourceLocationMap.get(nodeId)
                    if (location && position.column <= location.startColumn) {
                        // Clicked on or before the function name (where the indicator is)
                        const node = this.#sceneNodeMap.get(nodeId)
                        if (node) {
                            // Use getAllDescendantIds to select this node and all children
                            const allIds = node.getAllDescendantIds()
                            this.renderer.setSelection(allIds)
                        } else {
                            this.renderer.setSelection([nodeId])
                        }
                        // Also update editor highlighting to show the selection highlight
                        this.#updateEditorHighlighting()
                        return
                    }
                }
            }
        }
    }

    constructor(
        preview: PreviewWindow,
        tabs: HTMLDivElement,
        editorContainer: HTMLDivElement,
        private log: HTMLDivElement,
        menu: HTMLElement
    ) {
        this.#settings = SettingsManager.instance
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
                ${__tone_accent}: #007acc;
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

        // Developer tools panel — positioned over the viewports area
        const devTools = new DevToolsPanel(this.#settings, this.#tabs)
        this.#viewports.appendChild(devTools)

        // Resize handle between editor and preview
        const workspace = document.getElementById("workspace")!
        const mainPanels = document.getElementById("main-panels")!
        const resizeHandleEl = document.getElementById("resize-handle")!
        const resizeHandle = new ResizeHandle(resizeHandleEl, mainPanels, workspace)
        resizeHandle.connect()

        // ResizeObserver so Monaco layout updates when editor container resizes
        const resizeObserver = new ResizeObserver(() => this.editor.layout())
        resizeObserver.observe(editorContainer)

        this.renderer = new SDFRenderer(preview, this.#tabs)

        this.renderer
            .ready()
            .then(() => {
                // Set up Monaco highlighter with the editor instance
                this.#monacoHighlighter.setEditor(this.editor)

                // Listen for selection changes from preview to update editor highlighting
                this.renderer.onSelectionChange = () => {
                    this.#isUpdatingFromPreview = true
                    this.#updateEditorHighlighting()
                    // Reset flag after a short delay to allow editor updates to complete
                    setTimeout(() => { this.#isUpdatingFromPreview = false }, 50)
                }

                // Listen for editor selection changes (for function name selection)
                this.editor.onDidChangeCursorSelection(() => {
                    this.#handleEditorSelection()
                })

                // Listen for mouse clicks (for color indicator clicks)
                this.editor.onMouseDown((e) => {
                    this.#handleEditorMouseDown(e)
                })

                // Wire dev tools panel ↔ renderer
                devTools.cameraOptimization = this.renderer.cameraOptimization
                devTools.beamOptimization = this.renderer.beamEnabled
                devTools.onCameraOptimizationChange = (enabled) => {
                    this.renderer.cameraOptimization = enabled
                }
                devTools.onBeamOptimizationChange = (enabled) => {
                    this.renderer.beamEnabled = enabled
                }
                this.renderer.onPreviewSettingsLoaded = () => {
                    devTools.cameraOptimization = this.renderer.cameraOptimization
                    devTools.beamOptimization = this.renderer.beamEnabled
                }

                // Wire dev tools FPS toggle ↔ preview window
                const showFps = this.#settings.getGlobal().app.showFps
                devTools.showFps = showFps
                preview.showFps = showFps
                devTools.onShowFpsChange = (enabled) => {
                    preview.showFps = enabled
                }

                const meshViewerEnabled = this.#settings.getGlobal().app.meshViewerEnabled
                devTools.meshViewer = meshViewerEnabled
                this.#setMeshViewerEnabled(meshViewerEnabled)
                devTools.onMeshViewerChange = (enabled) => {
                    this.#setMeshViewerEnabled(enabled)
                }

                this.#tabs.addEventListener("activeTabChanged", (e: Event) => {
                    const event = e as CustomEvent<string | undefined>
                    // Clear highlighting when switching tabs
                    this.#monacoHighlighter.clearHighlighting()

                    // Only build if there's an active document
                    if (event.detail !== undefined) {
                        this.build()
                    } else {
                        // No active document - clear log
                        this.log.innerText = ""
                    }
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
                const duplicateItem = document.createElement("span")
                duplicateItem.innerHTML = "Duplicate"
                const deleteItem = document.createElement("span")
                deleteItem.innerHTML = "Delete"
                const exportItem = document.createElement("span")
                exportItem.innerHTML = "Export to STL"

                // Developer Tools toggle checkbox
                const devToolsContainer = document.createElement("div")
                devToolsContainer.style.display = "flex"
                devToolsContainer.style.alignItems = "center"
                devToolsContainer.style.gap = "8px"
                devToolsContainer.style.cursor = "pointer"
                const devToolsCheckbox = document.createElement("input")
                devToolsCheckbox.type = "checkbox"
                devToolsCheckbox.style.pointerEvents = "none"
                const devToolsEnabled = this.#settings.getGlobal().app.devToolsEnabled
                devToolsCheckbox.checked = devToolsEnabled
                devTools.visible = devToolsEnabled
                const devToolsText = document.createElement("span")
                devToolsText.textContent = "Developer Tools"
                devToolsContainer.append(devToolsCheckbox, devToolsText)

                const fullscreenItem = document.createElement("span")
                const updateFullscreenText = () => {
                    fullscreenItem.textContent = document.fullscreenElement ? "Exit Fullscreen" : "Enter Fullscreen"
                }
                updateFullscreenText()
                document.addEventListener("fullscreenchange", updateFullscreenText)

                const menuItems: Array<{ element: HTMLElement; action: () => void }> = [
                    { element: newItem, action: () => this.#tabs.newDocument(undefined, "javascript") },
                    { element: renameItem, action: () => this.#tabs.renameCurrentTab() },
                    { element: duplicateItem, action: () => this.#tabs.duplicateCurrentTab() },
                    { element: deleteItem, action: () => this.#tabs.deleteCurrentTab() },
                    {
                        element: exportItem,
                        action: async () => {
                            const { StatusDialog } = await import("./components/status-dialog.mjs")
                            let statusDialog: import("./components/status-dialog.mjs").StatusDialog | null = null

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

                                // Show success dialog
                                statusDialog = new StatusDialog("Export successful")
                                await statusDialog.show()
                            } catch (err) {
                                if (`${err}`.includes("AbortError")) {
                                    return
                                }
                                if (`${err}`.includes("cancelled")) {
                                    statusDialog = new StatusDialog("Export cancelled")
                                    await statusDialog.show()
                                    return
                                }

                                // Show error dialog
                                const errorMsg = err instanceof Error ? err.message : String(err)
                                statusDialog = new StatusDialog(`Export failed: ${errorMsg}`)
                                await statusDialog.show()
                            }
                        },
                    },
                ]
                if (document.fullscreenEnabled) {
                    menuItems.push({
                        element: fullscreenItem,
                        action: async () => {
                            if (document.fullscreenElement) {
                                await document.exitFullscreen()
                            } else {
                                await document.documentElement.requestFullscreen()
                            }
                        },
                    })
                }
                menuItems.push({
                    element: devToolsContainer,
                    action: () => {
                            const enabled = !devToolsCheckbox.checked
                            devToolsCheckbox.checked = enabled
                            devTools.visible = enabled
                            if (!enabled) {
                                preview.showFps = false
                            } else {
                                preview.showFps = devTools.showFps
                            }
                            this.#settings.updateGlobal({ app: { devToolsEnabled: enabled } })
                        },
                })
                const menuButton = new MenuButton(menuItems)
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
            const meshViewer = new MeshViewer(this.#tabs)
            meshViewer.id = "mesh"

            // Add element to viewports (flexbox will distribute space automatically)
            this.#viewports.appendChild(meshViewer)
            this.#mesh = meshViewer

            // Wait for layout to settle before setting up camera sync
            requestAnimationFrame(() => {
                if (!this.#mesh) return // Guard against race with disable

                // Set up camera sync between preview and mesh viewer.
                // Preserve the renderer's onChange so the preview still gets #needsRender and #onCameraMovement.
                const previewControls = this.renderer.controls
                const meshControls = meshViewer.controls
                this.#originalPreviewOnChange = previewControls.onChange
                let syncing = false

                const push = (from: "preview" | "mesh", state: CameraState) => {
                    if (syncing) return
                    syncing = true
                    if (from === "preview") {
                        meshControls.applyState(state, { emit: false })
                    } else {
                        previewControls.applyState(state, { emit: false })
                        // Trigger preview render when mesh camera changes
                        this.#originalPreviewOnChange?.(state)
                    }
                    syncing = false
                }

                previewControls.onChange = state => {
                    push("preview", state)
                    this.#originalPreviewOnChange?.(state)
                }
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

            // Restore the renderer's original onChange handler
            this.renderer.controls.onChange = this.#originalPreviewOnChange
            this.#originalPreviewOnChange = undefined
        }
    }
}
export default App
