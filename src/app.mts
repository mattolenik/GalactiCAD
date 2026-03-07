import "monaco-editor-env" // must run before monaco-editor so globalAPI is set for console access
import * as monaco from "monaco-editor"
import { CAD_TYPES_DECL } from "./scene/cad-types-decl.mjs"
import { debounceTime, fromEventPattern } from "rxjs"
import type { Subscription } from "rxjs"
import { DocumentTabs } from "./components/document-tabs.mjs"
import { MenuButton } from "./components/menu-button.mjs"
import { MeshViewer } from "./components/mesh-viewer.mjs"
import type { PreviewWindow } from "./components/preview-window.mjs"
import type { CameraState } from "./controls/camera-controller.mjs"
import { styleInfo } from "./scene/scene.mjs"
import { SDFRenderer, type NodeStub } from "./sdf.mjs"
import { __bg_color, __bg_color_dark, __fg_color, __preview_bg, __tone_1, __tone_2, __tone_3, __tone_accent, __toolbar_height } from "./style/style.mjs"
import { exportStlBinary } from "./export/stl.mjs"
import { SettingsManager } from "./storage/settings.mjs"
import { MonacoHighlighter, type HighlightRange, type ShapeIndicator } from "./highlighting/monaco-highlighter.mjs"
import { SourceParser, findReturnStatementLine, type SourceLocation, type Polygon2DCallInfo, type ParsedShapeCall } from "./parser/source-parser.mjs"
import { matchNodesToSource, PURE_CSG_TYPES } from "./parser/node-matcher.mjs"
import { DevToolsPanel } from "./components/dev-tools-panel.mjs"
import type { BenchmarkCase } from "./benchmark/benchmark.mjs"
import { ResizeHandle } from "./components/resize-handle.mjs"
import { Toolbar } from "./components/toolbar.mjs"
import objectIcon from "./assets/selection-object.svg"
import seamIcon from "./assets/selection-seam.svg"
import edgeIcon from "./assets/selection-edge.svg"
import faceIcon from "./assets/selection-face.svg"
import autoIcon from "./assets/selection-auto.svg"
import { PolygonEditor } from "./components/polygon-editor.mjs"
import { addContextSubmenu } from "./editor/context-menu-submenu.mjs"
import { initDprintFormatting } from "./editor/dprint-formatter.mjs"
import { findInnermostAtPosition } from "./editor/position-utils.mjs"
import { applyVertexUpdates } from "./editor/polygon-source-updates.mjs"
import { applyExtrudeLoftCapUpdates, type ExtrudeLikeNode } from "./editor/extrude-loft-source-updates.mjs"
import { getEditorLayout } from "./layout/editor-layout.mjs"
import { insertShapeDeclaration, SHAPE_INSERTIONS } from "./editor/insert-shape.mjs"
import { WelcomeScreen } from "./components/welcome-screen.mjs"
import { isFileSystemAccessAvailable, openFolder, openSingleGcad } from "./fs/file-picker.mjs"
import { clearRecentDocuments, getDoc, getRecentDocuments } from "./storage/db.mjs"
import { clearFolderHandle, getFolderHandle } from "./storage/project-storage.mjs"
import { VERSION } from "./version.mjs"

console.log(`GalactiCAD ${VERSION}`)

// Start loading dprint formatter (non-blocking); registers providers when ready
initDprintFormatting()

/** Extract the compiler error message for display. Monaco handles location highlighting. */
function formatSceneError(err: unknown, src: string): string {
    const msg = err instanceof Error ? err.message : String(err)
    const cleanMsg = msg.replace(/^Error:\s*/i, "").trim()
    const displayMsg = cleanMsg.length > 200 ? cleanMsg.slice(0, 197) + "…" : cleanMsg

    // Custom message for "undefined scene root" — document didn't return a valid scene node
    const isUndefinedSceneRoot =
        msg.includes("Cannot set properties of undefined") && msg.includes("'scene'")
    if (isUndefinedSceneRoot && src.trim().length > 0) {
        const returnLine = findReturnStatementLine(src)
        if (returnLine != null) {
            return "Document must return a scene node (e.g. sphere(), box(), union()). Your return evaluates to undefined."
        }
        return "Document must return a scene node (e.g. sphere(), box(), union()). Add a return statement at the end."
    }

    return displayMsg
}

const CONTENT_CHANGE_DEBOUNCE_MS = 200
const MESH_UPDATE_DEBOUNCE_MS = 600
const SELECTION_FEEDBACK_DELAY_MS = 50

class App {
    editor!: monaco.editor.IStandaloneCodeEditor
    renderer!: SDFRenderer
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
    #parsedCalls: ParsedShapeCall[] = []
    #parsedCallsWithRanges: [ParsedShapeCall, { startLine: number; startColumn: number; endLine: number; endColumn: number }][] = []
    #sceneNodeMap: Map<number, NodeStub> = new Map()  // nodeId -> NodeStub for symbol lookup
    #monacoHighlighter: MonacoHighlighter
    #isUpdatingFromPreview = false  // Prevent selection feedback loops
    #polygonEditor: PolygonEditor | null = null
    #editorContainer!: HTMLDivElement
    #welcomeScreen: WelcomeScreen | null = null
    #preview: PreviewWindow
    #getVisiblePreviewRect!: () => DOMRect
    #toolbarRefs!: {
        xrayCheckbox: import("./components/toolbar.mjs").ToolbarToggleButton
        selectionModeRadio: import("./components/toolbar.mjs").ToolbarRadioGroup<import("./sdf.mjs").SelectionMode>
        exportBtn: import("./components/toolbar.mjs").ToolbarButton
        devTools: DevToolsPanel
    }

    async build() {
        let src = ""
        try {
            const model = this.editor.getModel()
            if (!model) {
                // No active model - don't try to build
                return
            }
            src = this.editor.getValue()
            const documentName = this.#tabs.active ?? undefined

            // Parse first (error-tolerant); used for fluent method decorations and node matching.
            const parsedCalls = this.#sourceParser.parseShapeCalls(src)
            const fluentLocations = this.#sourceParser.findFluentMethods(styleInfo.FluentMethods)
            this.#monacoHighlighter.setFluentMethodDecorations(fluentLocations)

            // Build the scene (uses cache when switching back to a tab with unchanged content).
            // Await so camera loads only after scene is ready, avoiding flicker.
            await this.renderer.build(src, documentName)

            // Guard: user may have closed the tab or switched documents while build was in flight.
            // The renderer skips applying stale buildComplete, but we must not overwrite state here.
            if (documentName !== (this.#tabs.active ?? undefined)) return
            if (this.editor.getModel() !== model) return

            // Get all scene nodes and build a map for quick lookup
            const sceneNodes = this.renderer.getSceneNodes()
            this.#sceneNodeMap.clear()
            for (const node of sceneNodes) {
                this.#sceneNodeMap.set(node.id, node)
            }

            // Match scene nodes to source code by comparing property values
            this.#parsedCalls = parsedCalls
            this.#parsedCallsWithRanges = parsedCalls.map(c => [c, c.location] as [ParsedShapeCall, { startLine: number; startColumn: number; endLine: number; endColumn: number }])
            this.#sourceLocationMap = matchNodesToSource(sceneNodes, parsedCalls)

            // Update color indicators for all matched shapes
            this.#updateColorIndicators()

            this.renderer.startLoop()
            this.#scheduleMeshUpdate(src)
            this.log.innerText = ""
            this.log.classList.remove("has-error")

            // Update highlighting for current selection after build
            this.#updateEditorHighlighting()
        } catch (err) {
            const message = formatSceneError(err, src)
            this.log.innerText = `💢 ${message}`
            this.log.classList.add("has-error")
            console.error("[Scene compilation]", err)
            // Do NOT clear decorations on build error. Parsing and fluent method
            // decorations run before build (error-tolerant). Color indicators and
            // selection highlighting from the last successful build remain; Monaco
            // tracks their positions as the user edits.
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
            const svg = node?.getIndicatorSvg?.() ?? defaultSvg

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
     * Returns the innermost (smallest containing range) match so that clicking
     * on a nested call (e.g. inner union) selects that call, not an outer one.
     */
    #findNodeIdAtPosition(line: number, column: number): number | null {
        return findInnermostAtPosition(this.#sourceLocationMap.entries(), line, column)
    }

    /**
     * Find node ID for the current editor selection.
     * Prefers exact match of function name range; falls back to position at selection start
     * (e.g. when double-click selection boundaries differ slightly from our ranges).
     */
    #findNodeIdForSelection(selection: monaco.Selection): number | null {
        const startLine = selection.startLineNumber
        const startColumn = selection.startColumn
        const endLine = selection.endLineNumber
        const endColumn = selection.endColumn

        for (const [nodeId, location] of this.#sourceLocationMap.entries()) {
            if (startLine === location.startLine &&
                startColumn === location.startColumn &&
                endLine === location.endLine &&
                endColumn === location.endColumn) {
                return nodeId
            }
        }
        // Fallback: use position at selection start (double-click may not match exactly)
        return this.#findNodeIdAtPosition(startLine, startColumn)
    }

    /**
     * Find the ParsedShapeCall matching the editor selection.
     * Exact match first; falls back to the innermost (smallest) identifier range at the selection start.
     */
    #findParsedCallForSelection(selection: monaco.Selection): ParsedShapeCall | null {
        const startLine = selection.startLineNumber
        const startColumn = selection.startColumn
        const endLine = selection.endLineNumber
        const endColumn = selection.endColumn

        for (const call of this.#parsedCalls) {
            if (startLine === call.location.startLine &&
                startColumn === call.location.startColumn &&
                endLine === call.location.endLine &&
                endColumn === call.location.endColumn) {
                return call
            }
        }

        // Fallback: innermost identifier range containing (startLine, startColumn)
        return findInnermostAtPosition(this.#parsedCallsWithRanges, startLine, startColumn)
    }

    /** Find the innermost ParsedShapeCall at the given position (for mouse-down). */
    #findParsedCallAtPosition(line: number, column: number): ParsedShapeCall | null {
        return findInnermostAtPosition(this.#parsedCallsWithRanges, line, column)
    }

    /**
     * Map a list of ParsedShapeCall leaf calls to their matched scene node IDs.
     * Uses sourceLocationMap which is built from property-based primitive matching.
     */
    #getNodeIdsForCalls(calls: ParsedShapeCall[]): number[] {
        const result: number[] = []
        for (const call of calls) {
            const matchingIds: number[] = []
            for (const [nodeId, loc] of this.#sourceLocationMap.entries()) {
                if (loc.startLine === call.location.startLine &&
                    loc.startColumn === call.location.startColumn) {
                    matchingIds.push(nodeId)
                }
            }
            if (matchingIds.length > 0) {
                result.push(Math.max(...matchingIds))
            }
        }
        return result
    }

    /**
     * Try to open the polygon editor at the given source position.
     * Returns true if opened (polygon2d call found and editor opened).
     */
    #tryOpenPolygonEditor(line: number, column: number): boolean {
        const model = this.editor.getModel()
        if (!model) return false
        const src = model.getValue()
        const cached = this.#sourceParser.getCachedSourceFile(src)
        const info = this.#sourceParser.findPolygon2DAtPosition(src, line, column, cached ?? undefined)
        if (!info) return false
        this.#openPolygonEditor(info, model)
        return true
    }

    /**
     * Handle double-click on a node in the preview.
     * If the node is a polygon2d (cap face of extrude/loft), open the polygon editor.
     */
    #handlePreviewDoubleClick(nodeId: number) {
        const location = this.#sourceLocationMap.get(nodeId)
        if (location?.functionName === "polygon2d") {
            this.#tryOpenPolygonEditor(location.startLine, location.startColumn)
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
        const cached = this.#sourceParser.getCachedSourceFile(src)
        const info = this.#sourceParser.findPolygon2DAtPosition(src, location.startLine, location.startColumn, cached ?? undefined)
        if (!info) return

        applyVertexUpdates(model, info, vertices)
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
        this.#sourceParser.parseShapeCalls(src)
        const cached = this.#sourceParser.getCachedSourceFile(src)
        const info = this.#sourceParser.findExtrudeLoftAtPosition(src, location.startLine, location.startColumn, cached ?? undefined)
        if (!info) return

        // Update the in-memory scene node and apply source edits.
        // nodeParams buffer already has the correct h and posYDelta, so rendering is fine
        // without a full shader recompile.
        const node = this.#sceneNodeMap.get(nodeId) as ExtrudeLikeNode | undefined
        applyExtrudeLoftCapUpdates(model, info, newH, newPosY, node)

        // Re-parse source locations so subsequent drags find correct offsets.
        const updatedSrc = model.getValue()
        const parsedCalls = this.#sourceParser.parseShapeCalls(updatedSrc)
        this.#parsedCalls = parsedCalls
        this.#parsedCallsWithRanges = parsedCalls.map(c => [c, c.location] as [ParsedShapeCall, { startLine: number; startColumn: number; endLine: number; endColumn: number }])
        const prevMap = this.#sourceLocationMap
        this.#sourceLocationMap = matchNodesToSource(
            Array.from(this.#sceneNodeMap.values()),
            parsedCalls,
        )
        // Preserve polygon2d entries that failed to match due to stale sceneNodeMap
        // (e.g. polygon push/pull + cap pull in same debounce window).
        for (const [nodeId, location] of prevMap.entries()) {
            if (location.functionName === "polygon2d" && !this.#sourceLocationMap.has(nodeId)) {
                this.#sourceLocationMap.set(nodeId, location)
            }
        }
    }

    /**
     * Handle editor selection to sync with preview.
     * Selects the corresponding object if a function name is fully selected.
     * For pure CSG operators (union, subtract, etc.), selects contained child shapes
     * using AST containment rather than node matching (which is unreliable for composites).
     */
    #handleEditorSelection() {
        if (this.#isUpdatingFromPreview) return

        const selection = this.editor.getSelection()
        if (!selection || selection.isEmpty()) return

        const clickedCall = this.#findParsedCallForSelection(selection)
        if (!clickedCall) return

        if (PURE_CSG_TYPES.has(clickedCall.functionName)) {
            // Variable-tracing: resolve logical leaf calls through variable references
            const leafCalls = this.#sourceParser.resolveLogicalLeafCalls(clickedCall)
            const ids = this.#getNodeIdsForCalls(leafCalls)
            this.renderer.setSelection(ids)
            this.#updateEditorHighlighting()
            return
        }

        // For primitives and rendering composites (extrude, loft, etc.), use direct match
        const nodeId = this.#findNodeIdForSelection(selection)
        if (nodeId !== null) {
            // polygon2d is a 2D shape not present in the 3D scene — open the polygon editor
            const location = this.#sourceLocationMap.get(nodeId)
            if (location?.functionName === "polygon2d" && this.#tryOpenPolygonEditor(location.startLine, location.startColumn)) {
                return
            }

            const node = this.#sceneNodeMap.get(nodeId)
            this.renderer.setSelection(node ? (node.getAllDescendantIds?.() ?? [nodeId]) : [nodeId])
            this.#updateEditorHighlighting()
        }
    }

    /**
     * Handle mouse click on the editor to check for color indicator clicks.
     * For pure CSG operators, uses containment-based selection.
     */
    #handleEditorMouseDown(e: monaco.editor.IEditorMouseEvent) {
        if (this.#isUpdatingFromPreview) return

        if (e.target.type === monaco.editor.MouseTargetType.CONTENT_TEXT) {
            const position = e.target.position
            if (!position) return

            // Find the parsed call at the clicked position
            const clickedCall = this.#findParsedCallAtPosition(position.lineNumber, position.column)

            if (!clickedCall) return

            // Only act when clicking on or before the function name (where the color indicator is)
            if (position.column > clickedCall.location.startColumn) return

            if (PURE_CSG_TYPES.has(clickedCall.functionName)) {
                const leafCalls = this.#sourceParser.resolveLogicalLeafCalls(clickedCall)
                const ids = this.#getNodeIdsForCalls(leafCalls)
                this.renderer.setSelection(ids)
            } else {
                const nodeId = this.#findNodeIdAtPosition(position.lineNumber, position.column)
                if (nodeId !== null) {
                    const node = this.#sceneNodeMap.get(nodeId)
                    this.renderer.setSelection(node ? (node.getAllDescendantIds?.() ?? [nodeId]) : [nodeId])
                }
            }
            this.#updateEditorHighlighting()
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
        this.#preview = preview
        this.#viewports = document.getElementById("viewports")!
        this.#editorContainer = editorContainer

        this.#setupEditorPanel(editorContainer)
        this.#sourceParser = new SourceParser()
        this.#monacoHighlighter = new MonacoHighlighter()

        const existingMesh = document.getElementById("mesh")
        if (existingMesh) existingMesh.remove()

        this.#setupEditorActions()

        this.#tabs = new DocumentTabs(this.editor)
        tabs.replaceWith(this.#tabs)
        this.#tabs.id = tabs.id

        this.#injectStyles()
        requestAnimationFrame(() => {
            const el = document.querySelector(".monaco-editor")
            if (el) {
                const bg = getComputedStyle(el).getPropertyValue("--vscode-editor-background")
                this.#tabs.style.setProperty("--active-bg", bg)
            }
        })

        this.#toolbarRefs = this.#setupToolbar(menu)
        const { getVisiblePreviewRect } = this.#setupLayoutObservers(editorContainer)
        this.#getVisiblePreviewRect = getVisiblePreviewRect

        void this.#createRendererAndWire(preview, menu, true)
            .catch(err => {
                console.error(`UNEXPECTED ERROR: ${err}`)
                const msg = document.createElement("p")
                msg.textContent =
                    "WebGPU is not supported in this browser. Try Chromium browsers like Chrome, Edge, and Opera. Or Firefox Nightly."
                preview.replaceWith(msg)
            })
    }

    async #createRendererAndWire(preview: PreviewWindow, menu: HTMLElement, isInitial = false): Promise<void> {
        await this.#restoreOrShowWelcome()
        this.renderer?.dispose()
        this.renderer = new SDFRenderer(preview, this.#tabs, this.#getVisiblePreviewRect, () => this.#tabs.active)
        const { xrayCheckbox, selectionModeRadio, exportBtn, devTools } = this.#toolbarRefs
        try {
            await this.renderer
                .ready()
            this.#wirePreviewAndRenderer(preview, devTools, xrayCheckbox, selectionModeRadio)
            this.#updateViewCenter?.()
            if (isInitial) {
                this.#wireEditorAndTabs()
                this.#wireGlobalUndoRedo()
                this.#wireMenu(menu)
                this.#wireSaveShortcut()
                fromEventPattern<monaco.editor.IModelContentChangedEvent>(
                    h => this.editor.onDidChangeModelContent(h),
                    (_, disp) => disp.dispose()
                )
                    .pipe(debounceTime(CONTENT_CHANGE_DEBOUNCE_MS))
                    .subscribe(() => this.build())
            }
            this.#wireExportButton(exportBtn, devTools)
            this.#wireDevToolsVersionToggle(preview, devTools)
            this.build()
        } catch (err) {
            console.error(`UNEXPECTED ERROR: ${err}`)
            const msg = document.createElement("p")
            msg.textContent =
                "WebGPU is not supported in this browser. Try Chromium browsers like Chrome, Edge, and Opera. Or Firefox Nightly."
            preview.replaceWith(msg)
        }
    }

    #setupEditorPanel(editorContainer: HTMLDivElement) {
        const codeDiv = document.createElement("div")
        codeDiv.style.flex = "1"
        codeDiv.style.minHeight = "0"
        codeDiv.style.overflow = "hidden"
        editorContainer.insertBefore(codeDiv, this.log)
        editorContainer.appendChild(this.log)

        monaco.typescript.typescriptDefaults.setCompilerOptions({
            target: monaco.typescript.ScriptTarget.ESNext,
            strict: false,
            noImplicitAny: false,
            noUnusedLocals: false,
            noUnusedParameters: false,
            allowUnreachableCode: true,
            module: monaco.typescript.ModuleKind.None,
        })
        monaco.typescript.typescriptDefaults.setDiagnosticsOptions({
            noSemanticValidation: false,
            noSyntaxValidation: false,
            diagnosticCodesToIgnore: [1108],
        })
        monaco.typescript.typescriptDefaults.addExtraLib(CAD_TYPES_DECL, "file:///cad-api.d.ts")

        monaco.editor.defineTheme("galacticad-dark", {
            base: "vs-dark",
            inherit: true,
            rules: [{ token: "delimiter.parenthesis.ts", foreground: "#555555" }],
            colors: { "editor.lineHighlightBackground": "#3a3a3eCC" },
        })
        this.editor = monaco.editor.create(codeDiv, {
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
            fontFamily: "FiraCode",
            fontLigatures: true,
            fontSize: 16,
            fontVariations: true,
            formatOnPaste: true,
            formatOnType: false,
            language: "typescript",
            lineNumbers: "on",
            minimap: { enabled: false },
            model: null,
            scrollBeyondLastLine: false,
            showFoldingControls: "always",
            showUnused: true,
            stickyTabStops: true,
            tabSize: 2,
            theme: "galacticad-dark",
            useTabStops: true,
            wordWrap: "on",
            wrappingIndent: "indent",
            wrappingStrategy: "advanced",
        })
    }

    #setupEditorActions() {
        this.editor.addAction({
            id: "galacticad.editPolygon",
            label: "Edit polygon",
            contextMenuGroupId: "0_shapes",
            contextMenuOrder: 0,
            run: (ed) => {
                const pos = ed.getPosition()
                if (!pos) return
                this.#tryOpenPolygonEditor(pos.lineNumber, pos.column)
            },
        })

        addContextSubmenu(this.editor, {
            title: "Insert shape",
            group: "0_shapes",
            order: 1,
            actions: SHAPE_INSERTIONS.map(({ id, label, varBase, call }) => ({
                id,
                label,
                run: (ed: monaco.editor.IStandaloneCodeEditor) => insertShapeDeclaration(ed, varBase, call),
            })),
        })
    }

    async #restoreOrShowWelcome(): Promise<void> {
        await this.#settings.ready()
        const restored = await this.#tabs.restore()
        if (!restored) this.#showWelcome()
    }

    #showWelcome(): void {
        const menu = (document.querySelector("menu-button") ?? document.getElementById("menuButton")) as HTMLElement
        const welcome = new WelcomeScreen({
            onCreateNew: async () => {
                await this.#hideWelcome(menu)
                await this.#tabs.newDocument()
            },
            onOpenModel: async () => {
                const result = await openSingleGcad()
                if (result) {
                    await this.#hideWelcome(menu)
                    await this.#tabs.addDocumentFromFile(result.name, "", result.handle)
                }
            },
            onOpenFolder: async () => {
                const dirHandle = await openFolder()
                if (dirHandle) {
                    await this.#hideWelcome(menu)
                    await this.#tabs.loadFromFolderOrPrompt(dirHandle)
                }
            },
            onSamplePick: async (content, suggestedName) => {
                await this.#hideWelcome(menu)
                await this.#tabs.newDocument(content, "typescript", suggestedName)
            },
            getThumbnail: (src) => this.renderer.thumbnail(src, 128, 128),
            getRecentDocuments: () => getRecentDocuments(),
            getDocumentContent: async (name) => (await getDoc(name))?.content,
            onOpenRecent: async (name) => {
                const opened = await this.#tabs.openDocument(name)
                if (opened) await this.#hideWelcome(menu)
            },
            onClearRecent: async () => {
                await clearRecentDocuments()
                await this.#welcomeScreen?.refreshRecentDocuments()
            },
        })
        this.#welcomeScreen = welcome
        document.body.classList.add("welcome-visible")
        document.body.appendChild(welcome)
    }

    #showWelcomeAndDisposePreview(): void {
        this.renderer.setSelection([], true)
        this.renderer.stopLoop()
        this.#showWelcome()
    }

    async #hideWelcome(menu?: HTMLElement): Promise<void> {
        this.#welcomeScreen?.remove()
        this.#welcomeScreen = null
        document.body.classList.remove("welcome-visible")
        if (!this.#viewports.contains(this.#preview)) {
            this.#viewports.appendChild(this.#preview)
            const menuEl = menu ?? (document.querySelector("menu-button") ?? document.getElementById("menuButton")) as HTMLElement
            await this.#createRendererAndWire(this.#preview, menuEl, false)
        }
    }

    #injectStyles() {
        const style = document.createElement("style")
        style.textContent = `
            body.welcome-visible #workspace {
                display: none !important;
            }
            :root {
                ${__fg_color}: whitesmoke;
                ${__bg_color}: #333;
                ${__bg_color_dark}: #222;
                ${__preview_bg}: #1a1a1a;
                ${__tone_1}: #888;
                ${__tone_2}: #444;
                ${__tone_3}: #666;
                ${__tone_accent}: #007acc;
                ${__toolbar_height}: 36px;
            }
            .selected-shape-name {
                background-color: rgba(255, 255, 0, 0.3) !important;
                border: 1px solid rgba(255, 255, 0, 0.5) !important;
                border-radius: 2px !important;
                padding: 0 2px !important;
                box-shadow: 0 0 4px rgba(255, 255, 0, 0.3) !important;
            }
            .cad-fluent-method {
                color: #4ec9b0 !important;
                font-weight: 600;
            }
        `
        document.body.appendChild(style)
    }

    #setupToolbar(menu: HTMLElement) {
        const toolbar = new Toolbar()
        const xrayIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M 9 17 L 1 4 L 9 1 L 17 4 Z"/><circle cx="9" cy="8" r="3"/></svg>`
        const xrayCheckbox = toolbar.addToggleButton(xrayIcon, "Toggle X-ray")
        toolbar.addSeparator()
        const selectionModeRadio = toolbar.addRadioGroup(
            [
                { label: "Object", value: "object" as const, icon: objectIcon },
                { label: "Seam", value: "seam" as const, icon: seamIcon },
                { label: "Edge", value: "edge" as const, icon: edgeIcon },
                { label: "Face", value: "face" as const, icon: faceIcon },
                { label: "Auto", value: "auto" as const, icon: autoIcon },
            ],
            this.#settings.getGlobal().preview.selectionMode
        )
        toolbar.addSeparator()
        const exportBtn = toolbar.addButton("STL", "Export STL")
        const fullscreenBtn = toolbar.addButton("", "Toggle fullscreen")
        const iconEnterFullscreen = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`
        const iconExitFullscreen = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/></svg>`
        const updateFullscreenState = () => {
            fullscreenBtn.active = !!document.fullscreenElement
            fullscreenBtn.html = document.fullscreenElement ? iconExitFullscreen : iconEnterFullscreen
        }
        updateFullscreenState()
        document.addEventListener("fullscreenchange", updateFullscreenState)
        if (document.fullscreenEnabled) {
            fullscreenBtn.onClick = async () => {
                document.fullscreenElement ? await document.exitFullscreen() : await document.documentElement.requestFullscreen()
            }
        } else {
            fullscreenBtn.disabled = true
        }
        document.getElementById("toolbar")!.insertBefore(toolbar, menu)

        const devTools = new DevToolsPanel(this.#settings, this.#tabs)
        this.#viewports.appendChild(devTools)

        return { xrayCheckbox, selectionModeRadio, exportBtn, devTools }
    }

    #setupLayoutObservers(editorContainer: HTMLDivElement) {
        const mainPanels = document.getElementById("main-panels")!
        const workspace = document.getElementById("workspace")!
        const resizeHandleEl = document.getElementById("resize-handle")!
        new ResizeHandle(resizeHandleEl, mainPanels, workspace).connect()

        const getVisiblePreviewRect = (): DOMRect => {
            const mainRect = mainPanels.getBoundingClientRect()
            if (mainRect.width === 0 || mainRect.height === 0) return mainRect
            return getEditorLayout(mainPanels).visiblePreviewRect(mainRect)
        }

        const updateViewCenter = () => {
            if (!this.renderer) return
            const mainRect = mainPanels.getBoundingClientRect()
            if (mainRect.width === 0 || mainRect.height === 0) return
            const { vcx, vcy, editorOffsetPx } = getEditorLayout(mainPanels).viewCenter(mainRect)
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

        const narrowMedia = window.matchMedia("(max-width: 600px)")
        const updateLineNumbers = () => {
            this.editor.updateOptions({ lineNumbers: narrowMedia.matches ? "off" : "on" })
        }
        narrowMedia.addEventListener("change", updateLineNumbers)
        updateLineNumbers()

        return { getVisiblePreviewRect }
    }

    #wirePreviewAndRenderer(
        preview: PreviewWindow,
        devTools: DevToolsPanel,
        xrayCheckbox: import("./components/toolbar.mjs").ToolbarToggleButton,
        selectionModeRadio: import("./components/toolbar.mjs").ToolbarRadioGroup<import("./sdf.mjs").SelectionMode>
    ) {
        this.#monacoHighlighter.setEditor(this.editor)

        this.renderer.selectionChange$.subscribe(() => {
            this.#isUpdatingFromPreview = true
            this.#updateEditorHighlighting()
            setTimeout(() => { this.#isUpdatingFromPreview = false }, SELECTION_FEEDBACK_DELAY_MS)
        })

        this.renderer.objectDoubleClick$.subscribe(nodeId => this.#handlePreviewDoubleClick(nodeId))

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

        devTools.meshSimplifyOnExport = this.#settings.getGlobal().app.meshSimplifyOnExport

        devTools.onBenchmarkThisRequest = (): BenchmarkCase | null => {
            const active = this.#tabs.active
            if (!active) return null
            const model = this.#tabs.getByName(active)
            if (!model) return null
            const state = this.renderer.controls.state
            const pos = this.renderer.controls.cameraPosition
            return {
                name: active,
                source: model.getValue(),
                camera: {
                    position: [pos.x, pos.y, pos.z],
                    translation: [state.translation.x, state.translation.y, state.translation.z],
                    zoom: state.zoom,
                    rotation: state.rotation,
                },
                preview: {
                    xrayMode: this.renderer.xrayMode,
                    cameraOptimization: this.renderer.cameraOptimization,
                    beamOptimization: this.renderer.beamEnabled,
                },
            }
        }
        devTools.onGetViewportSize = () => this.renderer?.renderSize ?? null
    }

    #wireEditorAndTabs() {
        this.#tabs.addEventListener("tabClosed", async () => {
            if (this.#tabs.documentNames.length === 0) {
                void this.renderer.clearScene()
                const dirHandle = await getFolderHandle()
                if (!dirHandle) this.#showWelcomeAndDisposePreview()
            }
        })
        this.#tabs.addEventListener("activeTabChanged", (e: Event) => {
            const event = e as CustomEvent<string | undefined>
            this.#monacoHighlighter.clearHighlighting()
            if (event.detail !== undefined) {
                requestAnimationFrame(() => {
                    void this.build()
                })
            } else {
                this.log.innerText = ""
                this.log.classList.remove("has-error")
            }
        })
    }

    #wireGlobalUndoRedo() {
        document.addEventListener("keydown", (e: KeyboardEvent) => {
            const active = document.activeElement
            if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return
            if (this.#polygonEditor) return

            if (e.key === "Escape") {
                this.renderer.setSelection([], true)
                return
            }

            if (this.#editorContainer.contains(active)) return

            if (!(e.metaKey || e.ctrlKey) || e.altKey) return
            if (e.key.toLowerCase() !== "z") return

            e.preventDefault()
            this.editor.trigger("keyboard", e.shiftKey ? "redo" : "undo", null)
        })
    }

    #wireMenu(menu: HTMLElement) {
        const openModelItem = document.createElement("span")
        openModelItem.innerHTML = "Open Model"
        const openFolderItem = document.createElement("span")
        openFolderItem.innerHTML = "Open Folder"
        const newItem = document.createElement("span")
        newItem.innerHTML = "New Scene"
        const saveItem = document.createElement("span")
        saveItem.innerHTML = "Save"
        const saveAsItem = document.createElement("span")
        saveAsItem.innerHTML = "Save As"
        const revertItem = document.createElement("span")
        revertItem.innerHTML = "Revert"
        const renameItem = document.createElement("span")
        renameItem.innerHTML = "Rename"
        const duplicateItem = document.createElement("span")
        duplicateItem.innerHTML = "Duplicate"
        const deleteItem = document.createElement("span")
        deleteItem.innerHTML = "Delete"

        const menuItems: Array<{ element: HTMLElement; action: () => void }> = [
            { element: openModelItem, action: () => void this.#handleOpenModel() },
            { element: openFolderItem, action: () => void this.#handleOpenFolder() },
            { element: newItem, action: () => void this.#tabs.newDocument(undefined, "javascript") },
            { element: saveItem, action: () => void this.#handleSave() },
            { element: saveAsItem, action: () => void this.#handleSaveAs() },
            { element: revertItem, action: () => void (this.#tabs.active && this.#tabs.revertTab(this.#tabs.active)) },
            { element: renameItem, action: () => void this.#tabs.renameCurrentTab() },
            { element: duplicateItem, action: () => void this.#tabs.duplicateCurrentTab() },
            { element: deleteItem, action: () => this.#tabs.deleteCurrentTab() },
        ]
        const menuButton = new MenuButton(menuItems, {
            getClosedDocuments: () => this.#tabs.getClosedDocumentNames(),
            onOpen: name => void this.#tabs.openStoredDocument(name),
            getUnopenedFolderFiles: () => this.#tabs.getUnopenedFolderFiles(),
            onOpenFolderFile: name => void this.#tabs.openFolderFile(name),
            onOpenFolder: () => void this.#handleOpenFolder(),
            onCloseFolder: () => void this.#handleCloseFolder(),
        })
        menu.replaceWith(menuButton)
    }

    async #handleOpenModel(): Promise<void> {
        if (!isFileSystemAccessAvailable()) {
            alert("File System Access is not available. Use a modern browser (Chrome, Edge) with HTTPS.")
            return
        }
        const result = await openSingleGcad()
        if (result) await this.#tabs.addDocumentFromFile(result.name, "", result.handle)
    }

    async #handleOpenFolder(): Promise<void> {
        if (!isFileSystemAccessAvailable()) {
            alert("File System Access is not available. Use a modern browser (Chrome, Edge) with HTTPS.")
            return
        }
        const dirHandle = await openFolder()
        if (dirHandle) await this.#tabs.loadFromFolderOrPrompt(dirHandle)
    }

    async #handleCloseFolder(): Promise<void> {
        await clearFolderHandle()
        if (this.#tabs.documentNames.length === 0) {
            this.#showWelcomeAndDisposePreview()
        } else {
            await this.#tabs.closeAllTabsOrPrompt()
        }
    }

    async #handleSave(): Promise<void> {
        const name = this.#tabs.active
        if (!name) return
        if (this.#tabs.hasFileHandle(name)) {
            await this.#tabs.saveToDisk(name)
        }
        // Storage-backed docs are auto-saved; use Save As to save to disk
    }

    async #handleSaveAs(): Promise<void> {
        const name = this.#tabs.active
        if (!name) return
        await this.#tabs.saveAs(name)
    }

    #wireSaveShortcut(): void {
        document.addEventListener("keydown", (e: KeyboardEvent) => {
            if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "s") return
            const active = document.activeElement
            if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return
            e.preventDefault()
            void this.#handleSave()
        })
    }

    async #wireExportButton(exportBtn: import("./components/toolbar.mjs").ToolbarButton, devTools: DevToolsPanel) {
        exportBtn.onClick = async () => {
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
                const mesh = await this.renderer.renderMesh(this.editor.getValue(), documentName, {
                    simplifyOnExport: devTools.meshSimplifyOnExport,
                })
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
        }
    }

    #wireDevToolsVersionToggle(preview: PreviewWindow, devTools: DevToolsPanel) {
        const devToolsEnabled = this.#settings.getGlobal().app.devToolsEnabled
        devTools.visible = devToolsEnabled

        preview.onVersionDblClick = () => {
            const enabled = !devTools.visible
            devTools.visible = enabled
            if (!enabled) {
                preview.showFps = false
            } else {
                preview.showFps = devTools.showFps
            }
            this.#settings.updateGlobal({ app: { devToolsEnabled: enabled } })
        }
    }

    #openPolygonEditor(info: Polygon2DCallInfo, model: monaco.editor.ITextModel) {
        if (this.#polygonEditor) {
            this.#polygonEditor.remove()
            this.#polygonEditor = null
        }

        const polyEditor = new PolygonEditor(info.vertices)
        const arrayStart = info.arrayStartOffset

        polyEditor.onChange = (vertices) => {
            const src = model.getValue()
            const pos = model.getPositionAt(arrayStart)
            const cached = this.#sourceParser.getCachedSourceFile(src)
            const freshInfo = this.#sourceParser.findPolygon2DAtPosition(src, pos.lineNumber, pos.column, cached ?? undefined)
            if (!freshInfo) return
            applyVertexUpdates(model, freshInfo, vertices)
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
                const mesh = await this.renderer.renderMesh(src, this.#tabs.active, {
                    simplifyOnExport: this.#toolbarRefs.devTools.meshSimplifyOnExport,
                })
                if (token !== this.#meshUpdateToken) return
                if (this.#mesh) {
                    await this.#mesh.setMesh(mesh)
                }
            } catch (err) {
                // Mesh generation failing shouldn't break the live SDF preview.
                console.error(`Mesh update failed: ${err}`)
            }
        }, MESH_UPDATE_DEBOUNCE_MS)
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

export default App
