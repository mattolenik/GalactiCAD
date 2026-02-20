import * as monaco from "monaco-editor"
import "monaco-editor-env" // used at runtime, do not remove
import { bufferTime, filter, fromEventPattern } from "rxjs"
import type { Subscription } from "rxjs"
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
import { SourceParser, type SourceLocation, type Polygon2DCallInfo } from "./parser/source-parser.mjs"
import { matchNodesToSource } from "./parser/node-matcher.mjs"
import { DevToolsPanel } from "./components/dev-tools-panel.mjs"
import { ResizeHandle } from "./components/resize-handle.mjs"
import { Toolbar } from "./components/toolbar.mjs"
import { PolygonEditor } from "./components/polygon-editor.mjs"

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
    #meshViewerCameraSubs: Subscription[] = []
    #updateViewCenter: (() => void) | undefined
    #sourceParser: SourceParser
    #sourceLocationMap: Map<number, SourceLocation> = new Map()
    #sceneNodeMap: Map<number, import("./scene/scene.mjs").Node> = new Map()  // nodeId -> Node for symbol lookup
    #monacoHighlighter: MonacoHighlighter
    #isUpdatingFromPreview = false  // Prevent selection feedback loops
    #skipNextBuild = false  // When true, skip the next build entirely (nodeParams already correct)
    #polygonEditor: PolygonEditor | null = null
    #editorContainer!: HTMLDivElement

    async build() {
        try {
            const model = this.editor.getModel()
            if (!model) {
                // No active model - don't try to build
                return
            }
            const src = this.editor.getValue()
            const documentName = this.#tabs.active ?? undefined

            // Build the scene (uses cache when switching back to a tab with unchanged content).
            // Await so camera loads only after scene is ready, avoiding flicker.
            await this.renderer.build(src, documentName)

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
            // Clear all editor decorations on build error so stale indicators
            // don't appear at outdated line positions after code changes.
            this.#monacoHighlighter.clearHighlighting()
            this.#monacoHighlighter.setColorIndicators([])
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
     * Handle double-click on a node in the preview.
     * If the node is a polygon2d (cap face of extrude/loft), open the polygon editor.
     */
    #handlePreviewDoubleClick(nodeId: number) {
        const location = this.#sourceLocationMap.get(nodeId)
        if (location?.functionName === "polygon2d") {
            const model = this.editor.getModel()
            if (model) {
                const src = model.getValue()
                const info = this.#sourceParser.findPolygon2DAtPosition(src, location.startLine, location.startColumn)
                if (info) {
                    this.#openPolygonEditor(info, model)
                }
            }
        }
    }

    /**
     * Handle push/pull completion: update the polygon2d vertex array in the source code.
     * The nodeId is the Polygon2D child node ID — look up its source location and replace the vertex array.
     */
    #handlePushPullComplete(nodeId: number, vertices: [number, number][]) {
        const location = this.#sourceLocationMap.get(nodeId)
        if (!location || location.functionName !== "polygon2d") return

        const model = this.editor.getModel()
        if (!model) return

        const src = model.getValue()
        const info = this.#sourceParser.findPolygon2DAtPosition(src, location.startLine, location.startColumn)
        if (!info) return

        const newText = formatVertices(vertices)
        const startPos = model.getPositionAt(info.arrayStartOffset)
        const endPos = model.getPositionAt(info.arrayEndOffset)
        const range = new monaco.Range(
            startPos.lineNumber, startPos.column,
            endPos.lineNumber, endPos.column
        )
        model.pushStackElement()
        model.pushEditOperations([], [{ range, text: newText }], () => null)
        model.pushStackElement()
    }

    /**
     * Handle cap push/pull completion: update the extrude/loft h value and position in source code.
     * nodeId is the Extrude or Loft node ID.
     */
    #handleCapPullComplete(nodeId: number, newH: number, newPosY: number) {
        const location = this.#sourceLocationMap.get(nodeId)
        if (!location || (location.functionName !== "extrude" && location.functionName !== "loft")) return

        const model = this.editor.getModel()
        if (!model) return

        const src = model.getValue()
        const info = this.#sourceParser.findExtrudeLoftAtPosition(src, location.startLine, location.startColumn)
        if (!info) return

        // Update the in-memory scene node so the next drag starts from correct values.
        // nodeParams buffer already has the correct h and posYDelta, so rendering is fine
        // without a full shader recompile.
        const node = this.#sceneNodeMap.get(nodeId) as { h: number; pos: { y: number } } | undefined
        if (node && "h" in node) {
            node.h = newH
            node.pos.y = newPosY
        }

        this.#skipNextBuild = true
        model.pushStackElement()

        const edits: { range: import("monaco-editor").IRange; text: string }[] = []

        // Update h value
        const hStart = model.getPositionAt(info.hValueStart)
        const hEnd = model.getPositionAt(info.hValueEnd)
        edits.push({
            range: new monaco.Range(hStart.lineNumber, hStart.column, hEnd.lineNumber, hEnd.column),
            text: formatNumber(newH),
        })

        // Update position if it exists, or insert one if the Y component changed
        if (info.posArgStart !== null && info.posArgEnd !== null) {
            const posText = src.substring(info.posArgStart, info.posArgEnd)
            const updatedPosText = updatePosY(posText, newPosY)
            if (updatedPosText !== null) {
                const posStart = model.getPositionAt(info.posArgStart)
                const posEnd = model.getPositionAt(info.posArgEnd)
                edits.push({
                    range: new monaco.Range(posStart.lineNumber, posStart.column, posEnd.lineNumber, posEnd.column),
                    text: updatedPosText,
                })
            }
        } else if (Math.abs(newPosY) > 0.0005) {
            // No position argument exists, insert one
            const insertPos = model.getPositionAt(info.insertPosOffset)
            edits.push({
                range: new monaco.Range(insertPos.lineNumber, insertPos.column, insertPos.lineNumber, insertPos.column),
                text: `"0 ${formatNumber(newPosY)} 0", `,
            })
        }

        // Apply edits in reverse offset order so earlier edits don't shift later ones
        edits.sort((a, b) => {
            if (a.range.startLineNumber !== b.range.startLineNumber)
                return b.range.startLineNumber - a.range.startLineNumber
            return b.range.startColumn - a.range.startColumn
        })
        model.pushEditOperations([], edits, () => null)
        model.pushStackElement()

        // Re-parse source locations so subsequent drags find correct offsets
        // (lightweight — no shader recompilation)
        const updatedSrc = model.getValue()
        const parsedCalls = this.#sourceParser.parseShapeCalls(updatedSrc)
        this.#sourceLocationMap = matchNodesToSource(
            Array.from(this.#sceneNodeMap.values()),
            parsedCalls,
        )
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
            // polygon2d is a 2D shape not present in the 3D scene — open the polygon editor
            const location = this.#sourceLocationMap.get(nodeId)
            if (location?.functionName === "polygon2d") {
                const model = this.editor.getModel()
                if (model) {
                    const src = model.getValue()
                    const info = this.#sourceParser.findPolygon2DAtPosition(src, location.startLine, location.startColumn)
                    if (info) {
                        this.#openPolygonEditor(info, model)
                        return
                    }
                }
            }

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
        this.#editorContainer = editorContainer

        // Initialize source parser and highlighter for selection sync
        this.#sourceParser = new SourceParser()
        this.#monacoHighlighter = new MonacoHighlighter()

        // Remove any existing mesh viewer from HTML (we create it dynamically when enabled)
        const existingMesh = document.getElementById("mesh")
        if (existingMesh) {
            existingMesh.remove()
        }

        monaco.editor.defineTheme("galacticad-dark", {
            base: "vs-dark",
            inherit: true,
            rules: [],
            colors: {
                "editor.lineHighlightBackground": "#3a3a3eCC",
            },
        })
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
            theme: "galacticad-dark",
            useTabStops: true,
            wordWrap: "on",
            wrappingIndent: "indent",
            wrappingStrategy: "advanced",
        })

        this.editor.addAction({
            id: "galacticad.editPolygon",
            label: "Edit polygon",
            contextMenuGroupId: "navigation",
            contextMenuOrder: 1.5,
            run: (ed) => {
                const model = ed.getModel()
                if (!model) return
                const pos = ed.getPosition()
                if (!pos) return
                const src = model.getValue()
                const info = this.#sourceParser.findPolygon2DAtPosition(src, pos.lineNumber, pos.column)
                if (!info) return
                this.#openPolygonEditor(info, model)
            }
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
                ${__toolbar_height}: 36px;
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

        // Viewport toolbar — floating over the preview area
        const toolbar = new Toolbar()
        const xrayCheckbox = toolbar.addCheckbox("X-ray")
        toolbar.addSeparator()
        const selectionModeRadio = toolbar.addRadioGroup(
            [
                { label: "Object", value: "object" as const },
                { label: "Seam", value: "seam" as const },
                { label: "Edge", value: "edge" as const },
                { label: "Face", value: "face" as const },
            ],
            this.#settings.getGlobal().preview.selectionMode
        )
        toolbar.addSeparator()
        const pushPullModeRadio = toolbar.addRadioGroup([
            { label: "Slide", value: "slide" as const },
            { label: "Extrude", value: "extrude" as const },
        ], "slide")
        pushPullModeRadio.onChange = (value) => {
            this.renderer.setPushPullMode(value)
        }
        this.#viewports.appendChild(toolbar)

        // Developer tools panel — positioned over the viewports area
        const devTools = new DevToolsPanel(this.#settings, this.#tabs)
        this.#viewports.appendChild(devTools)

        // Resize handle between editor and preview
        const workspace = document.getElementById("workspace")!
        const mainPanels = document.getElementById("main-panels")!
        const resizeHandleEl = document.getElementById("resize-handle")!
        const resizeHandle = new ResizeHandle(resizeHandleEl, mainPanels, workspace)
        resizeHandle.connect()

        /** Returns the rect of the preview area NOT behind the editor overlay. */
        const getVisiblePreviewRect = (): DOMRect => {
            const mainRect = mainPanels.getBoundingClientRect()
            if (mainRect.width === 0 || mainRect.height === 0) return mainRect
            const editorOnLeft = window.innerWidth > window.innerHeight
            const css = getComputedStyle(mainPanels)
            const frac = editorOnLeft
                ? parseFloat(css.getPropertyValue("--editor-width") || "35") / 100
                : parseFloat(css.getPropertyValue("--editor-height") || "22") / 100
            if (editorOnLeft) {
                return new DOMRect(
                    mainRect.left + mainRect.width * frac,
                    mainRect.top,
                    mainRect.width * (1 - frac),
                    mainRect.height
                )
            }
            return new DOMRect(
                mainRect.left,
                mainRect.top + mainRect.height * frac,
                mainRect.width,
                mainRect.height * (1 - frac)
            )
        }

        // ResizeObserver so Monaco layout updates and viewCenter stays in sync.
        // Use CSS layout vars (not editor rect) so view center is correct when the
        // polygon editor replaces the code editor (editor has display:none → 0 rect).
        const updateViewCenter = () => {
            const mainRect = mainPanels.getBoundingClientRect()
            if (mainRect.width === 0 || mainRect.height === 0) return
            const editorOnLeft = window.innerWidth > window.innerHeight
            const css = getComputedStyle(mainPanels)
            const frac = editorOnLeft
                ? parseFloat(css.getPropertyValue("--editor-width") || "35") / 100
                : parseFloat(css.getPropertyValue("--editor-height") || "22") / 100
            const vcx = editorOnLeft ? (frac + 1.0) / 2 : 0.5
            const vcy = editorOnLeft ? 0.5 : (1.0 - frac) / 2
            const editorOffsetPx = editorOnLeft ? mainRect.width * frac : 0
            this.renderer.setViewCenter(vcx, vcy, editorOffsetPx)
            this.#mesh?.setViewCenter(vcx, vcy)
        }
        this.#updateViewCenter = updateViewCenter
        const resizeObserver = new ResizeObserver(() => {
            this.editor.layout()
            updateViewCenter()
        })
        resizeObserver.observe(editorContainer)
        resizeObserver.observe(mainPanels)

        // Hide line numbers on narrow screens to maximize code space
        const narrowMedia = window.matchMedia("(max-width: 600px)")
        const updateLineNumbers = () => {
            this.editor.updateOptions({ lineNumbers: narrowMedia.matches ? "off" : "on" })
        }
        narrowMedia.addEventListener("change", updateLineNumbers)
        updateLineNumbers()

        this.renderer = new SDFRenderer(preview, this.#tabs, getVisiblePreviewRect)

        this.renderer
            .ready()
            .then(() => {
                this.#wirePreviewAndRenderer(preview, devTools, xrayCheckbox, selectionModeRadio)
                this.#wireEditorAndTabs()
                this.#wireGlobalUndoRedo()
                this.#wireMenu(menu, preview, devTools)
                this.build()

                fromEventPattern<monaco.editor.IModelContentChangedEvent>(
                    h => this.editor.onDidChangeModelContent(h),
                    (_, disp) => disp.dispose()
                )
                    .pipe(
                        bufferTime(100),
                        filter(arr => arr.length > 0)
                    )
                    .subscribe((changes) => {
                        // Only skip when we have exactly one change (our programmatic edit).
                        // Multiple changes (e.g. our edit + user undo/redo) require a build.
                        if (this.#skipNextBuild && changes.length === 1) {
                            this.#skipNextBuild = false
                            return
                        }
                        this.#skipNextBuild = false
                        this.build()
                    })
            })
            .catch(err => {
                console.error(`UNEXPECTED ERROR: ${err}`)
                const msg = document.createElement("p")
                msg.textContent =
                    "WebGPU is not supported in this browser. Try Chromium browsers like Chrome, Edge, and Opera. Or Firefox Nightly."
                preview.replaceWith(msg)
            })
    }

    #wirePreviewAndRenderer(
        preview: PreviewWindow,
        devTools: DevToolsPanel,
        xrayCheckbox: import("./components/toolbar.mjs").ToolbarCheckbox,
        selectionModeRadio: import("./components/toolbar.mjs").ToolbarRadioGroup<import("./sdf.mjs").SelectionMode>
    ) {
        this.#monacoHighlighter.setEditor(this.editor)

        this.renderer.selectionChange$.subscribe(() => {
            this.#isUpdatingFromPreview = true
            this.#updateEditorHighlighting()
            setTimeout(() => { this.#isUpdatingFromPreview = false }, 50)
        })

        this.renderer.objectDoubleClick$.subscribe(nodeId => this.#handlePreviewDoubleClick(nodeId))

        devTools.onClearUndoStack = () => this.#clearEditorUndoStack()

        this.renderer.pushPullComplete$.subscribe(({ nodeId, vertices }) => {
            this.#handlePushPullComplete(nodeId, vertices)
        })

        this.renderer.capPullComplete$.subscribe(({ nodeId, newH, newPosY }) => {
            this.#handleCapPullComplete(nodeId, newH, newPosY)
        })

        this.editor.onDidChangeCursorSelection(() => {
            this.#handleEditorSelection()
        })

        this.editor.onMouseDown((e) => {
            this.#handleEditorMouseDown(e)
        })

        xrayCheckbox.checked = this.renderer.xrayMode
        xrayCheckbox.onChange = (enabled) => {
            this.renderer.xrayMode = enabled
        }

        selectionModeRadio.value = this.renderer.selectionMode
        selectionModeRadio.onChange = (value) => {
            this.renderer.setSelectionMode(value)
        }

        devTools.cameraOptimization = this.renderer.cameraOptimization
        devTools.beamOptimization = this.renderer.beamEnabled
        devTools.onCameraOptimizationChange = (enabled) => {
            this.renderer.cameraOptimization = enabled
        }
        devTools.onBeamOptimizationChange = (enabled) => {
            this.renderer.beamEnabled = enabled
        }
        this.renderer.previewSettingsLoaded$.subscribe(() => {
            xrayCheckbox.checked = this.renderer.xrayMode
            selectionModeRadio.value = this.renderer.selectionMode
            devTools.cameraOptimization = this.renderer.cameraOptimization
            devTools.beamOptimization = this.renderer.beamEnabled
        })

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
    }

    #wireEditorAndTabs() {
        this.#tabs.addEventListener("activeTabChanged", (e: Event) => {
            const event = e as CustomEvent<string | undefined>
            this.#monacoHighlighter.clearHighlighting()
            if (event.detail !== undefined) {
                requestAnimationFrame(() => {
                    void this.build()
                })
            } else {
                this.log.innerText = ""
            }
        })
    }

    #wireGlobalUndoRedo() {
        document.addEventListener("keydown", (e: KeyboardEvent) => {
            if (!(e.metaKey || e.ctrlKey) || e.altKey) return
            if (e.key.toLowerCase() !== "z") return

            const active = document.activeElement
            if (this.#editorContainer.contains(active)) return
            if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return
            if (this.#polygonEditor) return

            e.preventDefault()
            this.editor.trigger("keyboard", e.shiftKey ? "redo" : "undo", null)
        })
    }

    /** Clear undo/redo stack for all open documents. Uses Monaco internal API. */
    #clearEditorUndoStack() {
        for (const name of this.#tabs.documentNames) {
            const model = this.#tabs.getByName(name)
            if (model && (model as { _commandManager?: { clear: () => void } })._commandManager) {
                ;(model as { _commandManager: { clear: () => void } })._commandManager.clear()
            }
        }
    }

    #wireMenu(
        menu: HTMLElement,
        preview: PreviewWindow,
        devTools: DevToolsPanel
    ) {
        const newItem = document.createElement("span")
        newItem.innerHTML = "New Scene"
        const renameItem = document.createElement("span")
        renameItem.innerHTML = "Rename"
        const duplicateItem = document.createElement("span")
        duplicateItem.innerHTML = "Duplicate"
        const deleteItem = document.createElement("span")
        deleteItem.innerHTML = "Delete"
        const exportItem = document.createElement("span")
        exportItem.innerHTML = "Export to STL"

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
    }

    #openPolygonEditor(info: Polygon2DCallInfo, model: monaco.editor.ITextModel) {
        if (this.#polygonEditor) {
            this.#polygonEditor.remove()
            this.#polygonEditor = null
        }

        const polyEditor = new PolygonEditor(info.vertices)
        let arrayStart = info.arrayStartOffset
        let arrayEnd = info.arrayEndOffset

        polyEditor.onChange = (vertices) => {
            const newText = formatVertices(vertices)
            const startPos = model.getPositionAt(arrayStart)
            const endPos = model.getPositionAt(arrayEnd)
            const range = new monaco.Range(
                startPos.lineNumber, startPos.column,
                endPos.lineNumber, endPos.column
            )
            model.pushStackElement()
            model.pushEditOperations([], [{ range, text: newText }], () => null)
            model.pushStackElement()
            arrayEnd = arrayStart + newText.length
        }

        // Hide Monaco and insert polygon editor in its place
        this.#editorContainer.style.display = "none"
        this.#editorContainer.parentElement!.insertBefore(polyEditor, this.#editorContainer)

        polyEditor.onClose = () => {
            this.#editorContainer.style.display = ""
            this.editor.layout()
            this.#polygonEditor = null
        }

        this.#polygonEditor = polyEditor
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
                // SDFRenderer already subscribes to preview change$ for needsRender; we add sync logic.
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
                        this.renderer.requestRender()
                    }
                    syncing = false
                }

                this.#meshViewerCameraSubs.push(
                    previewControls.change$.subscribe(state => push("preview", state)),
                    meshControls.change$.subscribe(state => push("mesh", state))
                )
                // Sync initial camera state
                meshControls.applyState(previewControls.state, { emit: false })
                // Sync viewCenter so mesh viewer matches SDF preview offset
                this.#updateViewCenter?.()

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

            for (const sub of this.#meshViewerCameraSubs) sub.unsubscribe()
            this.#meshViewerCameraSubs.length = 0
        }
    }
}

function formatVertices(vertices: [number, number][]): string {
    const pairs = vertices.map(([x, y]) => {
        const xs = String(Math.round(x * 100) / 100)
        const ys = String(Math.round(y * 100) / 100)
        return `[${xs}, ${ys}]`
    })
    return `[${pairs.join(", ")}]`
}

function formatNumber(n: number): string {
    const rounded = Math.round(n * 1000) / 1000
    return String(rounded)
}

/**
 * Update the Y component of a position argument in source.
 * Handles string-form "x y z" and array-form [x, y, z].
 */
function updatePosY(posText: string, newY: number): string | null {
    const trimmed = posText.trim()

    // String form: "x y z"
    if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
        const quote = trimmed[0]
        const inner = trimmed.slice(1, -1).trim()
        const parts = inner.split(/\s+/)
        if (parts.length === 3) {
            parts[1] = formatNumber(newY)
            return `${quote}${parts.join(" ")}${quote}`
        }
        return null
    }

    // Array form: [x, y, z]
    if (trimmed.startsWith("[")) {
        const inner = trimmed.slice(1, -1)
        const parts = inner.split(",").map(s => s.trim())
        if (parts.length === 3) {
            parts[1] = formatNumber(newY)
            return `[${parts.join(", ")}]`
        }
        return null
    }

    return null
}

export default App
