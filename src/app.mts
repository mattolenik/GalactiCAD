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
import { MeshExportCancelledError } from "./export/mesh-exporter.mjs"
import { SDFRenderer, type NodeStub } from "./sdf.mjs"
import { __active_bg, __bg_color, __bg_color_dark, __fg_color, __preview_bg, __tone_1, __tone_2, __tone_3, __tone_accent, __toolbar_height } from "./style/style.mjs"
import {
    resolveEffectiveTheme,
    subscribeToThemeChanges,
    THEME_PALETTES,
    type EffectiveTheme,
} from "./style/theme.mjs"
import { getShapePalette } from "./colorPalette.mjs"
import { getSelectionStylesForTheme } from "./selectionStyles.mjs"
import { GALACTICAD_DARK_THEME, GALACTICAD_LIGHT_THEME } from "./themes.mjs"
import type { CameraSettings, EditorSettings, ThemeMode } from "./storage/settings.mjs"
import type { MeshData } from "./export/export.mjs"
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
import cameraViewFrontIcon from "./assets/camera-view-front.svg"
import cameraViewBackIcon from "./assets/camera-view-back.svg"
import cameraViewRightIcon from "./assets/camera-view-right.svg"
import cameraViewLeftIcon from "./assets/camera-view-left.svg"
import cameraViewTopIcon from "./assets/camera-view-top.svg"
import cameraViewBottomIcon from "./assets/camera-view-bottom.svg"
import toolbarCameraViewsIcon from "./assets/toolbar-camera-views.svg"
import toolbarXrayIcon from "./assets/toolbar-xray.svg"
import toolbarPreviewNormalIcon from "./assets/toolbar-preview-normal.svg"
import toolbarFullscreenEnterIcon from "./assets/toolbar-fullscreen-enter.svg"
import toolbarFullscreenExitIcon from "./assets/toolbar-fullscreen-exit.svg"
import { PolygonEditor } from "./components/polygon-editor.mjs"
import { ContextMenu } from "./components/context-menu.mjs"
import { addContextSubmenu } from "./editor/context-menu-submenu.mjs"
import { initDprintFormatting } from "./editor/dprint-formatter.mjs"
import { findInnermostAtPosition } from "./editor/position-utils.mjs"
import { applyVertexUpdates } from "./editor/polygon-source-updates.mjs"
import { applyExtrudeLoftCapUpdates, type ExtrudeLikeNode } from "./editor/extrude-loft-source-updates.mjs"
import {
    canvasPreviewUvRect,
    editorSelectionInfoOffset,
    getEditorLayout,
    viewCenterUv,
    visiblePreviewRegion,
    visibleRegionForCanvas,
} from "./layout/editor-layout.mjs"
import { initCadDocumentHighlights } from "./editor/cad-document-highlights.mjs"
import { insertShapeDeclaration, SHAPE_INSERTIONS } from "./editor/insert-shape.mjs"
import { WelcomeScreen } from "./components/welcome-screen.mjs"
import { isFileSystemAccessAvailable, openFolder, openSingleGcad } from "./fs/file-picker.mjs"
import { clearRecentDocuments, db, getDoc, getRecentDocuments } from "./storage/db.mjs"
import { clearFolderHandle, getFolderHandle } from "./storage/project-storage.mjs"
import {
    applyDebugLogModules,
    connectMainThreadDevLogToBridge,
    installDevActiveSceneSourceGetter,
    log as debugLog,
} from "./logging/debug-log.mjs"
import { VERSION } from "./version.mjs"
import {
    agentMeshOverlayFromSettingsMeshViewer,
    buildAgentTestcase,
    type AgentTestcase,
} from "./agent-autotest/agent-testcase.mjs"
import { registerAgentTestcaseCapture } from "./agent-autotest/register-agent-testcase-capture.mjs"
import { registerAgentRenderBridge } from "./agent-autotest/register-agent-render-bridge.mjs"
import { registerScreenshotBridge } from "./agent-autotest/register-screenshot-bridge.mjs"

connectMainThreadDevLogToBridge()
debugLog("App").info(`GalactiCAD ${VERSION}`)

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
const MESH_UPDATE_DEBOUNCE_MS = 250
const SELECTION_FEEDBACK_DELAY_MS = 50

class App {
    editor!: monaco.editor.IStandaloneCodeEditor
    renderer!: SDFRenderer
    #tabs: DocumentTabs
    #mesh: MeshViewer | null = null
    #meshUpdateToken = 0
    #meshUpdateTimer: number | null = null
    /** True once Cancel was clicked for the in-flight export (label shows "Cancelling…"). */
    #exportCancelling = false
    #viewports: HTMLElement
    #settings: SettingsManager
    #meshViewerEnabled = false
    /** Reused for STL when it matches the current source + export settings (set by export preview). */
    #cachedMeshForExport: MeshData | null = null
    #cachedMeshForExportKey: string | null = null
    #meshViewerCameraSubs: Subscription[] = []
    #updateViewCenter: (() => void) | undefined
    #sourceParser: SourceParser
    #sourceLocationMap: Map<number, SourceLocation> = new Map()
    #parsedCalls: ParsedShapeCall[] = []
    #parsedCallsWithRanges: [ParsedShapeCall, { startLine: number; startColumn: number; endLine: number; endColumn: number }][] = []
    #sceneNodeMap: Map<number, NodeStub> = new Map()  // nodeId -> NodeStub for symbol lookup
    #monacoHighlighter: MonacoHighlighter
    #isUpdatingFromPreview = false  // Prevent selection feedback loops
    #pushPullBuildPending = false
    #pushPullUndoOpen = false
    #polygonEditor: PolygonEditor | null = null
    #contextMenu: ContextMenu | null = null
    #contextMenuHoverSub: Subscription | null = null
    #contextMenuShowTimer: number | null = null
    #contextMenuLastKey: string | null = null
    #contextMenuEditorMoveDispose: monaco.IDisposable | null = null
    #contextMenuSafeZoneCleanup: (() => void) | null = null
    #editorContainer!: HTMLDivElement
    #welcomeScreen: WelcomeScreen | null = null
    #preview: PreviewWindow
    #isHandlingPopstate = false
    #effectiveTheme: EffectiveTheme = "dark"
    #themeUnsubscribe: (() => void) | null = null
    #getVisiblePreviewRect!: () => DOMRect
    #toolbarRefs!: {
        xrayCheckbox: import("./components/toolbar.mjs").ToolbarToggleButton
        previewNormalShadingToggle: import("./components/toolbar.mjs").ToolbarToggleButton
        selectionModeRadio: import("./components/toolbar.mjs").ToolbarRadioGroup<import("./sdf.mjs").SelectionMode>
        exportBtn: import("./components/toolbar.mjs").ToolbarButton
        devTools: DevToolsPanel
    }

    async build() {
        let src = ""
        const wallStart = performance.now()
        try {
            const model = this.editor.getModel()
            if (!model) {
                // No active model - don't try to build
                return
            }
            src = this.editor.getValue()
            const documentName = this.#tabs.active ?? undefined

            // Parse first (error-tolerant); used for fluent method decorations and node matching.
            const tParse0 = performance.now()
            const parsedCalls = this.#sourceParser.parseShapeCalls(src)
            const fluentLocations = this.#sourceParser.findFluentMethods(styleInfo.FluentMethods)
            this.#monacoHighlighter.setFluentMethodDecorations(fluentLocations)
            const parseAndDecorateMs = Math.round((performance.now() - tParse0) * 100) / 100

            // Build the scene (uses cache when switching back to a tab with unchanged content).
            // Await so camera loads only after scene is ready, avoiding flicker.
            const applied = await this.renderer.build(src, documentName)
            if (!applied) return

            // Guard: user may have closed the tab or switched documents while build was in flight.
            // The renderer skips applying stale buildComplete, but we must not overwrite state here.
            if (documentName !== (this.#tabs.active ?? undefined)) return
            if (this.editor.getModel() !== model) return

            const tPost0 = performance.now()
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
            // Mesh export no longer auto-runs on scene build; use the dev-tools
            // "Re-export mesh" button to refresh the mesh viewer.
            this.log.innerText = ""
            this.log.classList.remove("has-error")

            // Update highlighting for current selection after build
            this.#updateEditorHighlighting()
            const postProcessMs = Math.round((performance.now() - tPost0) * 100) / 100
            const totalWallMs = Math.round((performance.now() - wallStart) * 100) / 100
            const pipeline = this.renderer.getLastSceneBuildPipelineMs()
            debugLog("App").info("[Scene build perf]", {
                totalWallMs,
                mainThread: { parseAndDecorateMs, postProcessMs },
                pipeline,
            })
        } catch (err) {
            const message = formatSceneError(err, src)
            this.log.innerText = `💢 ${message}`
            this.log.classList.add("has-error")
            debugLog("App").error("[Scene compilation]", err)
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
            if (location.skipColorIndicator) continue

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

        this.#monacoHighlighter.setColorIndicators(indicators, getShapePalette(this.#effectiveTheme))
    }

    /**
     * Update Monaco editor highlighting based on selected object IDs.
     * Primary selection (no selected ancestor) gets solid border; children get dashed.
     */
    #updateEditorHighlighting() {
        const { primary, children } = this.renderer.getSelectionPrimaryAndChildIds()

        if (primary.length === 0 && children.length === 0) {
            this.#monacoHighlighter.clearHighlighting()
            return
        }

        const toRange = (id: number): HighlightRange | null => {
            const location = this.#sourceLocationMap.get(id)
            if (!location) return null
            if (location.skipColorIndicator) return null
            return {
                startLine: location.startLine,
                startColumn: location.startColumn,
                endLine: location.endLine,
                endColumn: location.endColumn,
            }
        }

        const primaryRanges = primary.map(toRange).filter((r): r is HighlightRange => r !== null)
        const childRanges = children.map(toRange).filter((r): r is HighlightRange => r !== null)

        if (primaryRanges.length > 0 || childRanges.length > 0) {
            const overviewRulerColor = this.#effectiveTheme === "dark" ? "#ffff00" : "#8b6914"
            this.#monacoHighlighter.highlightRanges(primaryRanges, childRanges, overviewRulerColor)
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
     * Syncs selection (including polygon2d) between preview and editor.
     */
    #handlePreviewDoubleClick(nodeId: number) {
        const node = this.#sceneNodeMap.get(nodeId)
        this.renderer.setSelection(node ? (node.getAllDescendantIds?.() ?? [nodeId]) : [nodeId])
        this.#updateEditorHighlighting()
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

        if (!this.#pushPullUndoOpen) {
            model.pushStackElement()
            this.#pushPullUndoOpen = true
        }
        applyVertexUpdates(model, info, vertices, true)
    }

    /**
     * Handle cap push/pull completion: update the extrude/loft h value and position in source code.
     * nodeId is the Extrude or Loft node ID.
     */
    #handleCapPullComplete(nodeId: number, newH: number, newPosY: number) {
        const location = this.#sourceLocationMap.get(nodeId)
        if (!location || (location.functionName !== "extrude" && location.functionName !== "loft" && location.functionName !== "threaded_rod")) return

        const model = this.editor.getModel()
        if (!model) return

        const src = model.getValue()
        this.#sourceParser.parseShapeCalls(src)
        const cached = this.#sourceParser.getCachedSourceFile(src)
        const info =
            location.functionName === "threaded_rod"
                ? this.#sourceParser.findThreadedRodAtPosition(src, location.startLine, location.startColumn, cached ?? undefined)
                : this.#sourceParser.findExtrudeLoftAtPosition(src, location.startLine, location.startColumn, cached ?? undefined)
        if (!info) return

        if (!this.#pushPullUndoOpen) {
            model.pushStackElement()
            this.#pushPullUndoOpen = true
        }
        const node = this.#sceneNodeMap.get(nodeId) as ExtrudeLikeNode | undefined
        applyExtrudeLoftCapUpdates(model, info, newH, newPosY, node, true)

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
            const leafIds = this.#getNodeIdsForCalls(leafCalls)
            const idsWithRoot = this.renderer.getSelectionIdsWithRoot(leafIds)
            this.renderer.setSelection(idsWithRoot)
            this.#updateEditorHighlighting()
            return
        }

        // For primitives and rendering composites (extrude, loft, etc.), use direct match
        const nodeId = this.#findNodeIdForSelection(selection)
        if (nodeId !== null) {
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
                const leafIds = this.#getNodeIdsForCalls(leafCalls)
                const idsWithRoot = this.renderer.getSelectionIdsWithRoot(leafIds)
                this.renderer.setSelection(idsWithRoot)
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
        installDevActiveSceneSourceGetter(() => {
            const model = this.editor.getModel()
            return model ? model.getValue() : ""
        })

        this.#injectStyles()
        const initialTheme = resolveEffectiveTheme(this.#settings.getGlobal().app.theme)
        this.#applyTheme(initialTheme)
        this.#themeUnsubscribe = subscribeToThemeChanges(this.#settings.getGlobal().app.theme, effective => {
            this.#applyTheme(effective)
        })

        this.#toolbarRefs = this.#setupToolbar(menu)
            ; (window as unknown as { factoryReset: () => Promise<void> }).factoryReset = () =>
                this.#toolbarRefs.devTools.factoryReset()
        const { getVisiblePreviewRect } = this.#setupLayoutObservers(editorContainer)
        this.#getVisiblePreviewRect = getVisiblePreviewRect

        void this.#createRendererAndWire(preview, menu, true)
            .catch(err => {
                debugLog("App").error("UNEXPECTED ERROR:", err)
                const msg = document.createElement("p")
                msg.textContent =
                    "WebGPU is not supported in this browser. Try Chromium browsers like Chrome, Edge, and Opera. Or Firefox Nightly."
                preview.replaceWith(msg)
            })
    }

    async #createRendererAndWire(preview: PreviewWindow, menu: HTMLElement, isInitial = false): Promise<void> {
        const sceneLoadT0 = isInitial ? performance.now() : 0
        await this.#restoreOrShowWelcome()
        this.renderer?.dispose()
        this.renderer = new SDFRenderer(preview, this.#tabs, this.#getVisiblePreviewRect, () => this.#tabs.active)
        const { xrayCheckbox, previewNormalShadingToggle, selectionModeRadio, exportBtn, devTools } = this.#toolbarRefs
        try {
            await this.renderer
                .ready()
            this.renderer.setSelectionStyles(getSelectionStylesForTheme(this.#effectiveTheme))
            this.renderer.setShapePalette(getShapePalette(this.#effectiveTheme))
            this.#wirePreviewAndRenderer(preview, devTools, xrayCheckbox, previewNormalShadingToggle, selectionModeRadio)
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
                    .subscribe(() => {
                        if (this.renderer.isPushPullActive) {
                            this.#pushPullBuildPending = true
                            return
                        }
                        this.build()
                    })
            }
            this.#wireExportButton(exportBtn, devTools)
            this.#wireDevToolsFromSettings(devTools)
            if (isInitial) {
                await this.build()
                const totalWallMs = Math.round((performance.now() - sceneLoadT0) * 100) / 100
                debugLog("App").info("[Scene initial load]", {
                    totalWallMs,
                    note: "Includes settings/restore, WebGPU init (ready), wiring, and first build; see [Scene build perf] for build breakdown.",
                })
            } else {
                void this.build()
            }
        } catch (err) {
            debugLog("App").error("UNEXPECTED ERROR:", err)
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

        const cadCompilerOptions: monaco.typescript.CompilerOptions = {
            target: monaco.typescript.ScriptTarget.ESNext,
            strict: false,
            noImplicitAny: false,
            noUnusedLocals: false,
            noUnusedParameters: false,
            allowUnreachableCode: true,
            module: monaco.typescript.ModuleKind.None,
            // Omit default "dom" lib so tab completion isn't flooded with DOM junk
            lib: ["esnext"],
        }
        monaco.typescript.typescriptDefaults.setCompilerOptions(cadCompilerOptions)
        monaco.typescript.javascriptDefaults.setCompilerOptions(cadCompilerOptions)
        monaco.typescript.typescriptDefaults.setDiagnosticsOptions({
            noSemanticValidation: false,
            noSyntaxValidation: false,
            diagnosticCodesToIgnore: [1108],
        })
        monaco.typescript.typescriptDefaults.addExtraLib(CAD_TYPES_DECL, "file:///cad-api.d.ts")
        initCadDocumentHighlights()

        monaco.editor.defineTheme("galacticad-dark", GALACTICAD_DARK_THEME)
        monaco.editor.defineTheme("galacticad-light", GALACTICAD_LIGHT_THEME)
        const editorOpts = this.#settings.getGlobal().app.editor
        this.editor = monaco.editor.create(codeDiv, {
            "semanticHighlighting.enabled": true,
            occurrencesHighlight: "off",
            selectionHighlight: false,
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
            folding: editorOpts.folding,
            fontFamily: "FiraCode",
            fontLigatures: true,
            fontSize: editorOpts.fontSize,
            fontVariations: true,
            formatOnPaste: true,
            formatOnType: false,
            language: "typescript",
            lineNumbers: editorOpts.lineNumbers,
            minimap: { enabled: editorOpts.minimap },
            model: null,
            renderWhitespace: editorOpts.renderWhitespace,
            scrollBeyondLastLine: false,
            showFoldingControls: "always",
            showUnused: true,
            stickyTabStops: true,
            tabSize: editorOpts.tabSize,
            useTabStops: true,
            wordWrap: editorOpts.wordWrap,
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

    #resolveAnchor(): string | null {
        const hash = window.location.hash
        if (!hash || hash.length < 2) return null
        try {
            const decoded = decodeURIComponent(hash.slice(1))
            return decoded.trim() || null
        } catch {
            return null
        }
    }

    async #restoreOrShowWelcome(): Promise<void> {
        await this.#settings.ready()
        applyDebugLogModules(this.#settings.getDebugLogModules())
        const anchor = this.#resolveAnchor()
        if (anchor) {
            const docRow = await db.documents.get(anchor)
            const docFileRow = await db.docFiles.get(anchor)
            const docExists = !!docRow || !!docFileRow?.handle
            if (docExists) {
                await this.#tabs.restore()
                const opened = await this.#tabs.openDocument(anchor)
                if (opened) return
                debugLog("App").warn(`Anchor document "${anchor}" could not be opened (e.g. stale file handle) — ignoring`)
            } else {
                debugLog("App").warn(`Anchor document "${anchor}" not found — ignoring`)
            }
            history.replaceState(null, "", location.pathname + location.search)
        }
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
            .cad-fluent-method {
                color: #4ec9b0 !important;
                font-weight: 600;
            }
        `
        document.body.appendChild(style)
    }

    #applyTheme(effective: EffectiveTheme) {
        this.#effectiveTheme = effective
        const palette = THEME_PALETTES[effective]
        const root = document.documentElement
        root.dataset.theme = effective
        root.style.colorScheme = effective
        for (const [key, value] of Object.entries(palette)) {
            root.style.setProperty(key, value)
        }
        monaco.editor.setTheme(effective === "dark" ? "galacticad-dark" : "galacticad-light")
        this.#tabs.style.setProperty("--active-bg", palette[__active_bg])
        this.renderer?.setShapePalette(getShapePalette(effective))
        this.renderer?.setSelectionStyles(getSelectionStylesForTheme(effective))
        this.#updateColorIndicators()
        if (this.renderer) this.#updateEditorHighlighting()
        this.#preview?.setThemeMode(this.#settings.getGlobal().app.theme)
        this.#mesh?.setEffectiveTheme(effective)
    }

    #cycleTheme(): void {
        const cycle: ThemeMode[] = ["light", "dark", "auto"]
        const current = this.#settings.getGlobal().app.theme
        const idx = cycle.indexOf(current)
        const next = cycle[(idx + 1) % cycle.length]
        this.#settings.updateGlobal({ app: { theme: next } })
        this.#themeUnsubscribe?.()
        this.#applyTheme(resolveEffectiveTheme(next))
        this.#themeUnsubscribe = subscribeToThemeChanges(next, effective => this.#applyTheme(effective))
    }

    #setupToolbar(menu: HTMLElement) {
        const toolbar = new Toolbar()

        toolbar.addDropdownButton(toolbarCameraViewsIcon, "Camera views", [
            { label: "Front", shortcut: "1", icon: cameraViewFrontIcon, action: () => this.renderer.setViewFront() },
            { label: "Back", shortcut: "2", icon: cameraViewBackIcon, action: () => this.renderer.setViewBack() },
            { label: "Right", shortcut: "3", icon: cameraViewRightIcon, action: () => this.renderer.setViewRight() },
            { label: "Left", shortcut: "4", icon: cameraViewLeftIcon, action: () => this.renderer.setViewLeft() },
            { label: "Top", shortcut: "5", icon: cameraViewTopIcon, action: () => this.renderer.setViewTop() },
            { label: "Bottom", shortcut: "6", icon: cameraViewBottomIcon, action: () => this.renderer.setViewBottom() },
            { type: "separator" },
            { label: "Reset camera", icon: toolbarCameraViewsIcon, action: () => this.renderer.resetCamera() },
        ])

        toolbar.addSpacer()

        const xrayCheckbox = toolbar.addToggleButton(toolbarXrayIcon, "Toggle X-ray")
        const previewNormalShadingToggle = toolbar.addToggleButton(
            toolbarPreviewNormalIcon,
            "Toggle normal shading",
            false
        )
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
        const updateFullscreenState = () => {
            fullscreenBtn.active = !!document.fullscreenElement
            fullscreenBtn.html = document.fullscreenElement ? toolbarFullscreenExitIcon : toolbarFullscreenEnterIcon
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

        return { xrayCheckbox, previewNormalShadingToggle, selectionModeRadio, exportBtn, devTools }
    }

    #setupLayoutObservers(editorContainer: HTMLDivElement) {
        const mainPanels = document.getElementById("main-panels")!
        const workspace = document.getElementById("workspace")!
        const resizeHandleEl = document.getElementById("resize-handle")!
        new ResizeHandle(resizeHandleEl, mainPanels, workspace).connect()

        const getVisiblePreviewRect = (): DOMRect => visibleRegionForCanvas(this.#preview.canvas, mainPanels)

        const updateViewCenter = () => {
            if (!this.renderer) return
            const mainRect = mainPanels.getBoundingClientRect()
            const previewCanvasRect = this.#preview.canvas.getBoundingClientRect()
            if (mainRect.width === 0 || previewCanvasRect.width === 0) return
            const layout = getEditorLayout(mainPanels)
            const regionPreview = visiblePreviewRegion(
                previewCanvasRect,
                mainRect,
                layout.editorOnLeft,
                layout.frac,
            )
            const { u, v } = viewCenterUv(previewCanvasRect, regionPreview)
            const editorOffsetPx = editorSelectionInfoOffset(mainRect, layout.editorOnLeft, layout.frac)
            this.renderer.setViewCenter(u, v, editorOffsetPx)
            const mesh = this.#mesh
            if (mesh) {
                const meshCanvasRect = mesh.canvas.getBoundingClientRect()
                const regionMesh = visiblePreviewRegion(
                    meshCanvasRect,
                    mainRect,
                    layout.editorOnLeft,
                    layout.frac,
                )
                const uvMesh = viewCenterUv(meshCanvasRect, regionMesh)
                mesh.setViewCenter(uvMesh.u, uvMesh.v)
            }
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
            const preferred = this.#settings.getGlobal().app.editor.lineNumbers
            this.editor.updateOptions({
                lineNumbers: narrowMedia.matches ? "off" : preferred,
            })
        }
        narrowMedia.addEventListener("change", updateLineNumbers)
        updateLineNumbers()

        return { getVisiblePreviewRect }
    }

    #wirePreviewAndRenderer(
        preview: PreviewWindow,
        devTools: DevToolsPanel,
        xrayCheckbox: import("./components/toolbar.mjs").ToolbarToggleButton,
        previewNormalShadingToggle: import("./components/toolbar.mjs").ToolbarToggleButton,
        selectionModeRadio: import("./components/toolbar.mjs").ToolbarRadioGroup<import("./sdf.mjs").SelectionMode>
    ) {
        preview.setThemeMode(this.#settings.getGlobal().app.theme)
        preview.onThemeCycle = () => this.#cycleTheme()

        this.#monacoHighlighter.setEditor(this.editor)

        this.renderer.selectionChange$.subscribe(() => {
            this.#isUpdatingFromPreview = true
            this.#updateEditorHighlighting()
            setTimeout(() => { this.#isUpdatingFromPreview = false }, SELECTION_FEEDBACK_DELAY_MS)
        })

        this.renderer.objectDoubleClick$.subscribe(nodeId => this.#handlePreviewDoubleClick(nodeId))

        this.#contextMenuHoverSub?.unsubscribe()
        this.#contextMenuHoverSub = null
        if (this.#contextMenuShowTimer) {
            clearTimeout(this.#contextMenuShowTimer)
            this.#contextMenuShowTimer = null
        }
        this.#contextMenuLastKey = null
        this.#contextMenuSafeZoneCleanup?.()
        this.#contextMenuSafeZoneCleanup = null
        this.#contextMenuEditorMoveDispose?.dispose()
        this.#contextMenuEditorMoveDispose = null
        if (!this.#contextMenu) {
            this.#contextMenu = new ContextMenu()
            document.body.appendChild(this.#contextMenu)
        }
        const TRIGGER_PADDING = 24
        const SAFE_ZONE_PADDING = 8
        const showPolygonMenu = (loc: SourceLocation, clientX: number, clientY: number) => {
            if (!this.#contextMenu) return
            this.#contextMenuSafeZoneCleanup?.()
            this.#contextMenuSafeZoneCleanup = null
            this.#contextMenu.setItems([
                { label: "Edit Polygon", action: () => this.#tryOpenPolygonEditor(loc.startLine, loc.startColumn) },
            ])
            this.#contextMenu.showAt(clientX, clientY, () => {
                if (!this.#contextMenu) return
                const menuRect = this.#contextMenu.getMenuRect()
                const triggerLeft = clientX - TRIGGER_PADDING
                const triggerTop = clientY - TRIGGER_PADDING
                const triggerRight = clientX + TRIGGER_PADDING
                const triggerBottom = clientY + TRIGGER_PADDING
                const safeLeft = Math.min(triggerLeft, menuRect.left) - SAFE_ZONE_PADDING
                const safeTop = Math.min(triggerTop, menuRect.top) - SAFE_ZONE_PADDING
                const safeRight = Math.max(triggerRight, menuRect.right) + SAFE_ZONE_PADDING
                const safeBottom = Math.max(triggerBottom, menuRect.bottom) + SAFE_ZONE_PADDING
                const inSafeZone = (x: number, y: number) =>
                    x >= safeLeft && x <= safeRight && y >= safeTop && y <= safeBottom
                const onMouseMove = (e: MouseEvent) => {
                    if (inSafeZone(e.clientX, e.clientY)) return
                    this.#contextMenu?.hide()
                }
                document.addEventListener("mousemove", onMouseMove, { capture: true })
                const cleanup = () => {
                    document.removeEventListener("mousemove", onMouseMove, { capture: true })
                    this.#contextMenuSafeZoneCleanup = null
                    this.#contextMenuLastKey = null
                }
                this.#contextMenuSafeZoneCleanup = cleanup
                this.#contextMenu.onHide = cleanup
            })
        }
        this.#contextMenuHoverSub = this.renderer.contextMenu$.subscribe(({ objectId, clientX, clientY }) => {
            const polyId = objectId > 0 ? this.renderer.resolvePolygon2dForHover(objectId) : null
            const loc = polyId != null ? this.#sourceLocationMap.get(polyId) : null
            const relatedIds = this.renderer.getPolygonContextMenuSelectionIds(objectId)
            const isSelected = relatedIds.some(id => this.renderer.selectedObjectIds.includes(id))
            if (loc?.functionName === "polygon2d" && isSelected) {
                showPolygonMenu(loc, clientX, clientY)
            }
        })
        const CONTEXT_MENU_DELAY_MS = 350
        const scheduleOrShowMonaco = (key: string, loc: SourceLocation, clientX: number, clientY: number) => {
            if (key !== this.#contextMenuLastKey) {
                if (this.#contextMenuShowTimer) clearTimeout(this.#contextMenuShowTimer)
                this.#contextMenuLastKey = key
                this.#contextMenuShowTimer = window.setTimeout(() => {
                    this.#contextMenuShowTimer = null
                    showPolygonMenu(loc, clientX, clientY)
                }, CONTEXT_MENU_DELAY_MS)
            }
        }
        const cancelMonacoHover = () => {
            if (this.#contextMenuShowTimer) {
                clearTimeout(this.#contextMenuShowTimer)
                this.#contextMenuShowTimer = null
            }
            this.#contextMenuLastKey = null
            if (this.#contextMenu?.visible) return
            this.#contextMenu?.hide()
        }
        const cancelMonacoHoverForRightClick = () => {
            if (this.#contextMenuShowTimer) {
                clearTimeout(this.#contextMenuShowTimer)
                this.#contextMenuShowTimer = null
            }
            this.#contextMenuLastKey = null
            this.#contextMenu?.hide()
        }
        const editorDom = this.editor.getDomNode()
        const onEditorContextMenu = () => cancelMonacoHoverForRightClick()
        editorDom?.addEventListener("contextmenu", onEditorContextMenu)
        const moveDispose = this.editor.onMouseMove(e => {
            if (e.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT) {
                cancelMonacoHover()
                return
            }
            const pos = e.target.position
            if (!pos) {
                cancelMonacoHover()
                return
            }
            const call = this.#findParsedCallAtPosition(pos.lineNumber, pos.column)
            if (call?.functionName === "polygon2d" && call.location) {
                const be = e.event.browserEvent
                scheduleOrShowMonaco(`monaco-${call.location.startLine}-${call.location.startColumn}`, call.location, be.clientX, be.clientY)
            } else {
                cancelMonacoHover()
            }
        })
        this.#contextMenuEditorMoveDispose = {
            dispose: () => {
                moveDispose.dispose()
                editorDom?.removeEventListener("contextmenu", onEditorContextMenu)
            },
        }

        this.renderer.pushPullComplete$.subscribe(({ nodeId, vertices }) => {
            this.#handlePushPullComplete(nodeId, vertices)
        })

        this.renderer.capPullComplete$.subscribe(({ nodeId, newH, newPosY }) => {
            this.#handleCapPullComplete(nodeId, newH, newPosY)
        })

        this.renderer.pushPullExit$.subscribe(() => {
            if (this.#pushPullUndoOpen) {
                this.editor.getModel()?.pushStackElement()
                this.#pushPullUndoOpen = false
            }
            if (this.#pushPullBuildPending) {
                this.#pushPullBuildPending = false
                this.build()
            }
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

        previewNormalShadingToggle.checked = this.renderer.previewNormalShading
        previewNormalShadingToggle.onChange = (enabled) => {
            this.renderer.previewNormalShading = enabled
        }

        selectionModeRadio.value = this.renderer.selectionMode
        selectionModeRadio.onChange = (value) => {
            this.renderer.setSelectionMode(value)
        }

        devTools.cameraOptimization = this.renderer.cameraOptimization
        devTools.beamOptimization = this.renderer.beamEnabled
        devTools.bvhOptimization = this.renderer.bvhEnabled
        devTools.featureGraphOverlay = this.renderer.featureGraphOverlayEnabled
        devTools.stepHeatmap = this.renderer.stepHeatmapEnabled
        devTools.onCameraOptimizationChange = (enabled) => {
            this.renderer.cameraOptimization = enabled
        }
        devTools.onBeamOptimizationChange = (enabled) => {
            this.renderer.beamEnabled = enabled
        }
        devTools.onBvhOptimizationChange = (enabled) => {
            this.renderer.bvhEnabled = enabled
            void this.build()
        }
        devTools.onFeatureGraphOverlayChange = (enabled) => {
            this.renderer.featureGraphOverlayEnabled = enabled
        }
        devTools.onStepHeatmapChange = (enabled) => {
            this.renderer.stepHeatmapEnabled = enabled
        }
        devTools.onRayMarchParamsChange = (params) => {
            this.renderer.setRayMarchParams(params)
        }
        // Push ray-march params restored from persisted dev-tools state into the
        // renderer once, since #restoreRayMarchParams updates the inputs but does
        // not fire onRayMarchParamsChange.
        this.renderer.setRayMarchParams(devTools.rayMarchParams)
        devTools.onUpscaleParamsChange = (params) => {
            this.renderer.setUpscaleParams(params)
        }
        // Same one-shot push for the FSR1 upscale params (restored, not emitted).
        this.renderer.setUpscaleParams(devTools.upscaleParams)
        this.renderer.previewSettingsLoaded$.subscribe(() => {
            xrayCheckbox.checked = this.renderer.xrayMode
            previewNormalShadingToggle.checked = this.renderer.previewNormalShading
            selectionModeRadio.value = this.renderer.selectionMode
            devTools.cameraOptimization = this.renderer.cameraOptimization
            devTools.beamOptimization = this.renderer.beamEnabled
            devTools.bvhOptimization = this.renderer.bvhEnabled
            devTools.featureGraphOverlay = this.renderer.featureGraphOverlayEnabled
        })

        const showFps = devTools.showFps
        preview.showFps = showFps
        devTools.onShowFpsChange = (enabled) => {
            preview.showFps = enabled
        }

        const meshViewerEnabled = devTools.meshViewer
        this.#setMeshViewerEnabled(meshViewerEnabled)
        devTools.onMeshViewerChange = (enabled) => {
            this.#setMeshViewerEnabled(enabled)
        }
        devTools.onMeshViewerOverlayChange = (settings) => {
            this.#mesh?.applyMeshViewerSettings(settings)
        }

        devTools.syncMeshExporterFromSettings(this.#settings.getGlobal().app.meshExporter)
        devTools.syncIsoSimplicialTuningFromSettings(this.#settings.getIsoSimplicialTuning())
        devTools.syncShrecTuningFromSettings(this.#settings.getShrecTuning())
        devTools.syncFlexiCubesTuningFromSettings(this.#settings.getFlexicubesTuning())
        devTools.syncSfccTuningFromSettings(this.#settings.getSfccTuning())
        devTools.syncSimplifyTuningFromSettings(this.#settings.getGlobal().app.simplifyTuning)
        devTools.syncMdcLeversFromSettings(this.#settings.getMdcExportLevers())
        // Mesh export is MANUAL: the dev-tools "Re-export mesh" button re-runs the
        // export with the current scene + tuning. It no longer auto-runs on scene
        // edits or per-knob tuning changes (meshing — especially SFCC — is expensive).
        devTools.onReExportRequest = () => {
            if (!this.#meshViewerEnabled || !this.#mesh) return
            const m = this.#tabs.active ? this.#tabs.getByName(this.#tabs.active) : null
            if (!m) return
            this.#scheduleMeshUpdate(m.getValue())
        }

        devTools.syncDebugLogModulesFromSettings(this.#settings.getDebugLogModules())
        devTools.onDebugLogModulesChange = () => {
            applyDebugLogModules(this.#settings.getDebugLogModules())
            this.renderer.syncDebugLogModulesToWorker()
        }

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
                    dollyDistance: state.dollyDistance,
                    rotation: state.rotation,
                },
                preview: {
                    xrayMode: this.renderer.xrayMode,
                    previewNormalShading: this.renderer.previewNormalShading,
                    cameraOptimization: this.renderer.cameraOptimization,
                    beamOptimization: this.renderer.beamEnabled,
                    bvhOptimization: this.renderer.bvhEnabled,
                    featureGraphOverlay: this.renderer.featureGraphOverlayEnabled,
                },
            }
        }
        devTools.onGetViewportSize = () => this.renderer?.renderSize ?? null

        devTools.onAgentTestcaseExportRequest = (): AgentTestcase | null => {
            try {
                return this.#captureAgentTestcase()
            } catch {
                return null
            }
        }

        registerAgentTestcaseCapture(() => this.#captureAgentTestcase())
        registerAgentRenderBridge(this.renderer)

        // Literal-screenshot bridge: PNG of the on-screen viewable area (excludes the editor overlay),
        // captured from the live frame — distinct from the testcase render path which rebuilds the scene.
        const mainPanels = document.getElementById("main-panels")!
        registerScreenshotBridge({
            sdf: {
                capture: () => this.renderer.capturePreviewImageData(),
                canvasRect: () => this.#preview.canvas.getBoundingClientRect(),
                visibleRegion: () => this.#getVisiblePreviewRect(),
            },
            mesh: {
                capture: () => (this.#meshViewerEnabled && this.#mesh ? this.#mesh.captureFrameToImageData() : null),
                canvasRect: () => this.#mesh?.canvas.getBoundingClientRect() ?? null,
                visibleRegion: () => (this.#mesh ? visibleRegionForCanvas(this.#mesh.canvas, mainPanels) : null),
            },
        })
    }

    #wireEditorAndTabs() {
        this.#tabs.addEventListener("tabClosed", async () => {
            if (this.#tabs.documentNames.length === 0) {
                history.replaceState(null, "", location.pathname + location.search)
                void this.renderer.clearScene()
                const dirHandle = await getFolderHandle()
                if (!dirHandle) this.#showWelcomeAndDisposePreview()
            }
        })
        this.#tabs.addEventListener("activeTabChanged", (e: Event) => {
            const event = e as CustomEvent<string | undefined>
            const name = event.detail
            if (name !== undefined && !this.#isHandlingPopstate) {
                const url = `${location.pathname}${location.search}#${encodeURIComponent(name)}`
                if (location.hash === "#" + encodeURIComponent(name)) {
                    history.replaceState(null, "", url)
                } else {
                    history.pushState(null, "", url)
                }
            }
            this.#monacoHighlighter.clearHighlighting()
            if (name !== undefined) {
                requestAnimationFrame(() => {
                    void this.build()
                })
            } else {
                this.log.innerText = ""
                this.log.classList.remove("has-error")
            }
        })
        window.addEventListener("popstate", () => {
            const anchor = this.#resolveAnchor()
            if (anchor) {
                this.#isHandlingPopstate = true
                void this.#tabs.openDocument(anchor).then(opened => {
                    if (!opened) {
                        debugLog("App").warn(`Anchor document "${anchor}" not found — ignoring`)
                        history.replaceState(null, "", location.pathname + location.search)
                    }
                }).finally(() => {
                    this.#isHandlingPopstate = false
                })
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
        openModelItem.innerHTML = "Open File"
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
        const settingsItem = document.createElement("span")
        settingsItem.innerHTML = "Settings"

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
            { element: settingsItem, action: () => void this.#showSettingsModal() },
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

    async #showSettingsModal(): Promise<void> {
        const { SettingsModal } = await import("./components/settings-modal.mjs")
        const g = this.#settings.getGlobal()
        const initialMode = g.preview.cameraRotationMethod ?? "rounded_arcball"
        const initialTheme = g.app.theme ?? "dark"
        const initialDevToolsEnabled = g.app.devToolsEnabled ?? false
        const initialEditorSettings = g.app.editor
        const modal = new SettingsModal(
            initialMode,
            initialTheme,
            initialDevToolsEnabled,
            initialEditorSettings,
            method => {
                this.#settings.updateGlobal({ preview: { cameraRotationMethod: method } })
                this.renderer?.controls.setRotationMethod(method)
            },
            theme => {
                this.#settings.updateGlobal({ app: { theme } })
                this.#themeUnsubscribe?.()
                this.#applyTheme(resolveEffectiveTheme(theme))
                this.#themeUnsubscribe = subscribeToThemeChanges(theme, effective => this.#applyTheme(effective))
            },
            enabled => {
                this.#settings.updateGlobal({ app: { devToolsEnabled: enabled } })
                this.#toolbarRefs.devTools.visible = enabled
                if (!enabled) {
                    this.#preview.showFps = false
                } else {
                    this.#preview.showFps = this.#toolbarRefs.devTools.showFps
                }
            },
            settings => {
                this.#settings.updateGlobal({ app: { editor: settings } })
                const narrow = window.matchMedia("(max-width: 600px)").matches
                this.editor.updateOptions({
                    lineNumbers: narrow ? "off" : settings.lineNumbers,
                    wordWrap: settings.wordWrap,
                    minimap: { enabled: settings.minimap },
                    fontSize: settings.fontSize,
                    renderWhitespace: settings.renderWhitespace,
                    folding: settings.folding,
                    tabSize: settings.tabSize,
                })
            }
        )
        await modal.show()
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
                const src = this.editor.getValue()
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
                const wantKey = this.#meshCacheKey(src, documentName, devTools)
                const mesh =
                    this.#meshViewerEnabled
                    && this.#cachedMeshForExport
                    && this.#cachedMeshForExportKey === wantKey
                        ? this.#cachedMeshForExport
                        : await this.renderer.renderMesh(src, documentName, this.#meshRenderOptionsForExport(devTools))
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

    #wireDevToolsFromSettings(devTools: DevToolsPanel) {
        const devToolsEnabled = this.#settings.getGlobal().app.devToolsEnabled
        devTools.visible = devToolsEnabled
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

    #meshRenderOptionsForExport(devTools: DevToolsPanel) {
        return {
            simplifyOnExport: devTools.meshSimplifyOnExport,
            exporter: devTools.meshExporter,
            exporterTuning: devTools.getAllExporterTuning(),
            simplifyTuning: devTools.simplifyTuning,
        }
    }

    /** Camera, viewport, mesh export levers, and scene source — for agent testcase YAML / WS bridge. */
    #captureAgentTestcase(): AgentTestcase {
        const active = this.#tabs.active
        if (!active) {
            throw new Error("No active document")
        }
        const model = this.#tabs.getByName(active)
        if (!model) {
            throw new Error("No active document")
        }
        const state = this.renderer.controls.state
        const pos = this.renderer.controls.cameraPosition
        const vc = this.renderer.viewCenter
        const canvasRect = this.#preview.canvas.getBoundingClientRect()
        const visibleRegion = this.#getVisiblePreviewRect()
        const previewUvRect = canvasPreviewUvRect(canvasRect, visibleRegion)
        // Full preview-canvas pixel size (CSS px). The shader frames the scene against the
        // whole-canvas aspect (res.x/res.y) and shifts by viewCenter; the agent render
        // reproduces this aspect and then crops to previewUvRect, so the agent's framing
        // matches the visible (non-editor) region the user actually sees. When the mesh
        // viewer is open #viewports stacks preview + mesh as equal flex cells, so this rect
        // is already the top cell's (half-height) size — i.e. the squished aspect on screen.
        // Capturing the full canvas (not the visible region) is required because previewUvRect
        // is expressed relative to this canvas; the crop subtracts the editor afterward.
        const viewportWidth = canvasRect.width > 0 ? Math.round(canvasRect.width) : undefined
        const viewportHeight = canvasRect.height > 0 ? Math.round(canvasRect.height) : undefined
        return buildAgentTestcase({
            sourceUtf8: model.getValue(),
            camera: {
                position: [pos.x, pos.y, pos.z],
                translation: [state.translation.x, state.translation.y, state.translation.z],
                dollyDistance: state.dollyDistance,
                rotation: [...state.rotation] as CameraSettings["rotation"],
                ...(state.pivot !== undefined
                    ? { pivot: [state.pivot.x, state.pivot.y, state.pivot.z] as [number, number, number] }
                    : {}),
            },
            viewCenter: [vc.x, vc.y],
            viewportWidth,
            viewportHeight,
            previewUvRect,
            meshExport: this.#meshRenderOptionsForExport(this.#toolbarRefs.devTools),
            meshOverlay: agentMeshOverlayFromSettingsMeshViewer(this.#settings.getGlobal().meshViewer),
            documentName: active,
        })
    }

    /** Fingerprint of `renderMesh` inputs; must match what `#scheduleMeshUpdate` and export use. */
    #meshCacheKey(src: string, documentName: string | undefined, devTools: DevToolsPanel): string {
        return JSON.stringify({
            documentName: documentName ?? "",
            options: this.#meshRenderOptionsForExport(devTools),
            src,
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
            const exportStart = performance.now()
            // Latest phase the exporter reported (sfcc-rs emits phase boundaries; other
            // exporters leave it empty → the line shows just a live elapsed clock).
            let phase = ""
            this.#exportCancelling = false
            this.#mesh?.showExportProgress({
                cancellable: this.renderer.meshExportCancellable,
                onCancel: () => {
                    this.#exportCancelling = true
                    this.renderer.cancelMeshExport()
                },
            })
            // Tick the elapsed clock (whole seconds) between the sparse phase messages.
            // Display only — no QoS keepalive (the earlier "slow when idle" was an artifact).
            const renderTick = () => {
                const secs = Math.round((performance.now() - exportStart) / 1000)
                const label = this.#exportCancelling ? "Cancelling…" : phase || "Exporting"
                this.#mesh?.setExportStatus(`${label} • ${secs}s`)
            }
            renderTick()
            const elapsedTimer = window.setInterval(renderTick, 250)
            try {
                const documentName = this.#tabs.active
                const options = this.#meshRenderOptionsForExport(this.#toolbarRefs.devTools)
                const mesh = await this.renderer.renderMesh(src, documentName, {
                    ...options,
                    onProgress: (p) => {
                        phase = p.phase
                        renderTick()
                    },
                })
                if (token !== this.#meshUpdateToken) return
                if (this.#mesh) {
                    await this.#mesh.setMesh(mesh)
                    this.#cachedMeshForExport = mesh
                    this.#cachedMeshForExportKey = this.#meshCacheKey(src, documentName, this.#toolbarRefs.devTools)
                }
            } catch (err) {
                // A user-cancelled export keeps the previous mesh and is not an error; only
                // a real failure is logged (and never breaks the live SDF preview).
                if (!(err instanceof MeshExportCancelledError)) {
                    debugLog("App").error("Mesh update failed:", err)
                }
            } finally {
                window.clearInterval(elapsedTimer)
                // Only the latest request owns the indicator/spinner; a superseded export
                // must not hide one a newer in-flight export still needs.
                if (token === this.#meshUpdateToken) {
                    this.#mesh?.hideExportProgress()
                }
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

            // Logical viewport = mesh canvas minus editor overlay (same as SDF preview).
            const mainPanels = document.getElementById("main-panels")!
            const meshSlot: { viewer: MeshViewer | null } = { viewer: null }
            const meshViewer = new MeshViewer(this.#tabs, () => {
                const v = meshSlot.viewer
                return v ? visibleRegionForCanvas(v.canvas, mainPanels) : mainPanels.getBoundingClientRect()
            })
            meshSlot.viewer = meshViewer
            meshViewer.id = "mesh"

            // Add element to viewports (flexbox will distribute space automatically)
            this.#viewports.appendChild(meshViewer)
            this.#mesh = meshViewer
            meshViewer.setEffectiveTheme(this.#effectiveTheme)

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
                    previewControls.change$.subscribe((state: CameraState) => push("preview", state)),
                    meshControls.change$.subscribe((state: CameraState) => push("mesh", state))
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
            this.#cachedMeshForExport = null
            this.#cachedMeshForExportKey = null

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
