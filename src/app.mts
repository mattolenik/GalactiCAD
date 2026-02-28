import "monaco-editor-env" // must run before monaco-editor so globalAPI is set for console access
import * as monaco from "monaco-editor"
import { CAD_TYPES_DECL } from "./scene/cad-types-decl.mjs"
import { debounceTime, filter, fromEventPattern } from "rxjs"
import type { Subscription } from "rxjs"
import { DocumentTabs } from "./components/document-tabs.mjs"
import { MenuButton } from "./components/menu-button.mjs"
import { MeshViewer } from "./components/mesh-viewer.mjs"
import type { PreviewWindow } from "./components/preview-window.mjs"
import type { CameraState } from "./controls/camera-controller.mjs"
import { styleInfo } from "./scene/scene.mjs"
import { SDFRenderer } from "./sdf.mjs"
import { __bg_color, __bg_color_dark, __fg_color, __tone_1, __tone_2, __tone_3, __tone_accent, __toolbar_height } from "./style/style.mjs"
import { exportStlBinary } from "./export/stl.mjs"
import { SettingsManager } from "./storage/settings.mjs"
import { MonacoHighlighter, type HighlightRange, type ShapeIndicator } from "./highlighting/monaco-highlighter.mjs"
import { SourceParser, findReturnStatementLine, type SourceLocation, type Polygon2DCallInfo, type ParsedShapeCall } from "./parser/source-parser.mjs"
import { matchNodesToSource } from "./parser/node-matcher.mjs"
import { DevToolsPanel } from "./components/dev-tools-panel.mjs"
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

/** CSG operators that don't render as visible objects — when selected from editor, select only their child shapes. */
const PURE_CSG_TYPES = new Set(["union", "subtract", "intersect", "pipe", "engrave", "groove", "tongue", "shell", "offset", "elongate", "twist", "bend", "taper", "morph", "seam"])

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
    #parsedCalls: ParsedShapeCall[] = []
    #sceneNodeMap: Map<number, import("./scene/scene.mjs").Node> = new Map()  // nodeId -> Node for symbol lookup
    #monacoHighlighter: MonacoHighlighter
    #isUpdatingFromPreview = false  // Prevent selection feedback loops
    #skipNextBuild = false  // When true, skip the next build entirely (nodeParams already correct)
    #polygonEditor: PolygonEditor | null = null
    #editorContainer!: HTMLDivElement

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

            // Get all scene nodes and build a map for quick lookup
            const sceneNodes = this.renderer.getSceneNodes()
            this.#sceneNodeMap.clear()
            for (const node of sceneNodes) {
                this.#sceneNodeMap.set(node.id, node)
            }

            // Match scene nodes to source code by comparing property values
            this.#parsedCalls = parsedCalls
            this.#sourceLocationMap = matchNodesToSource(sceneNodes, parsedCalls)

            console.debug("[App] Source location map:", Array.from(this.#sourceLocationMap.entries()))

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
     * Insert generated code at the current cursor or replace selection.
     */
    #insertGeneratedCode(code: string) {
        const model = this.editor.getModel()
        if (!model) return
        const selection = this.editor.getSelection()
        if (!selection) return
        const range = new monaco.Range(
            selection.startLineNumber,
            selection.startColumn,
            selection.endLineNumber,
            selection.endColumn
        )
        this.#skipNextBuild = true
        model.pushEditOperations([], [{ range, text: code }], () => null)
    }

    /**
     * Find node ID at a given editor position (line, column).
     * Returns the innermost (smallest containing range) match so that clicking
     * on a nested call (e.g. inner union) selects that call, not an outer one.
     */
    #findNodeIdAtPosition(line: number, column: number): number | null {
        let best: { nodeId: number; size: number } | null = null
        for (const [nodeId, location] of this.#sourceLocationMap.entries()) {
            if (line >= location.startLine && line <= location.endLine) {
                if (line === location.startLine && column < location.startColumn) continue
                if (line === location.endLine && column > location.endColumn) continue
                const size = (location.endLine - location.startLine) * 100000 + (location.endColumn - location.startColumn)
                if (!best || size < best.size) best = { nodeId, size }
            }
        }
        return best?.nodeId ?? null
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
        let best: { call: ParsedShapeCall; size: number } | null = null
        for (const call of this.#parsedCalls) {
            const loc = call.location
            if (startLine < loc.startLine || startLine > loc.endLine) continue
            if (startLine === loc.startLine && startColumn < loc.startColumn) continue
            if (startLine === loc.endLine && startColumn > loc.endColumn) continue
            const size = (loc.endLine - loc.startLine) * 100000 + (loc.endColumn - loc.startColumn)
            if (!best || size < best.size) best = { call, size }
        }
        return best?.call ?? null
    }

    /**
     * Map a list of ParsedShapeCall leaf calls to their matched scene node IDs.
     * Uses sourceLocationMap which is built from property-based primitive matching.
     */
    #getNodeIdsForCalls(calls: ParsedShapeCall[]): number[] {
        const result: number[] = []
        for (const call of calls) {
            for (const [nodeId, loc] of this.#sourceLocationMap.entries()) {
                if (loc.startLine === call.location.startLine &&
                    loc.startColumn === call.location.startColumn) {
                    result.push(nodeId)
                    break
                }
            }
        }
        return result
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
            // No position argument exists, insert one (new object format: pos: [0, y, 0])
            const insertPos = model.getPositionAt(info.insertPosOffset)
            edits.push({
                range: new monaco.Range(insertPos.lineNumber, insertPos.column, insertPos.lineNumber, insertPos.column),
                text: `pos: [0, ${formatNumber(newPosY)}, 0], `,
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
        this.#parsedCalls = parsedCalls
        this.#sourceLocationMap = matchNodesToSource(
            Array.from(this.#sceneNodeMap.values()),
            parsedCalls,
        )
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

            const node = this.#sceneNodeMap.get(nodeId)
            this.renderer.setSelection(node ? node.getAllDescendantIds() : [nodeId])
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
            const clickedCall = this.#parsedCalls.reduce<{ call: ParsedShapeCall; size: number } | null>((best, call) => {
                const loc = call.location
                if (position.lineNumber < loc.startLine || position.lineNumber > loc.endLine) return best
                if (position.lineNumber === loc.startLine && position.column < loc.startColumn) return best
                if (position.lineNumber === loc.endLine && position.column > loc.endColumn) return best
                const size = (loc.endLine - loc.startLine) * 100000 + (loc.endColumn - loc.startColumn)
                return (!best || size < best.size) ? { call, size } : best
            }, null)?.call ?? null

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
                    this.renderer.setSelection(node ? node.getAllDescendantIds() : [nodeId])
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
        this.#viewports = document.getElementById("viewports")!
        this.#editorContainer = editorContainer

        // Editor panel: code area (flex) + LLM prompt bar (fixed) + error log (hidden until error)
        const codeDiv = document.createElement("div")
        codeDiv.style.flex = "1"
        codeDiv.style.minHeight = "0"
        codeDiv.style.overflow = "hidden"
        editorContainer.insertBefore(codeDiv, this.log)
        editorContainer.appendChild(this.log)

        // Initialize source parser and highlighter for selection sync
        this.#sourceParser = new SourceParser()
        this.#monacoHighlighter = new MonacoHighlighter()

        // Remove any existing mesh viewer from HTML (we create it dynamically when enabled)
        const existingMesh = document.getElementById("mesh")
        if (existingMesh) {
            existingMesh.remove()
        }

        // Configure the TypeScript language service so user CAD code gets completions
        // and type-checking for the built-in factory functions (sphere, box, union, …).
        // (monaco.typescript is the correct top-level API in monaco-editor ≥0.52)
        monaco.typescript.typescriptDefaults.setCompilerOptions({
            target: monaco.typescript.ScriptTarget.ESNext,
            // Non-strict so casual user code doesn't get flooded with errors.
            strict: false,
            noImplicitAny: false,
            noUnusedLocals: false,
            noUnusedParameters: false,
            allowUnreachableCode: true,
            // No module system — user code is a standalone function body.
            module: monaco.typescript.ModuleKind.None,
        })
        // Only show syntax errors and semantic errors the user can actually act on.
        monaco.typescript.typescriptDefaults.setDiagnosticsOptions({
            noSemanticValidation: false,
            noSyntaxValidation: false,
            // 1108: "A 'return' statement can only be used within a function body."
            // User code is a function body executed via new Function(), so top-level
            // return statements are valid at runtime but look illegal to the TS checker.
            diagnosticCodesToIgnore: [1108],
        })
        // Inject the CAD API declarations as an ambient global library.
        monaco.typescript.typescriptDefaults.addExtraLib(
            CAD_TYPES_DECL,
            "file:///cad-api.d.ts",
        )

        monaco.editor.defineTheme("galacticad-dark", {
            base: "vs-dark",
            inherit: true,
            rules: [
                { token: "delimiter.parenthesis.ts", foreground: "#555555" },
            ],
            colors: {
                "editor.lineHighlightBackground": "#3a3a3eCC",
            },
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

        this.editor.addAction({
            id: "galacticad.editPolygon",
            label: "Edit polygon",
            contextMenuGroupId: "0_shapes",
            contextMenuOrder: 0,
            run: (ed) => {
                const model = ed.getModel()
                if (!model) return
                const pos = ed.getPosition()
                if (!pos) return
                const src = model.getValue()
                const info = this.#sourceParser.findPolygon2DAtPosition(src, pos.lineNumber, pos.column)
                if (!info) return
                this.#openPolygonEditor(info, model)
            },
        })

        const insertShapeDeclaration = (
            ed: monaco.editor.IStandaloneCodeEditor,
            varNameBase: string,
            callText: string
        ) => {
            const model = ed.getModel()
            if (!model) return
            const src = model.getValue()
            const lineCount = model.getLineCount()

            // Collect existing variable names for uniqueness
            const existing = new Set<string>()
            for (const m of src.matchAll(/(?:let|const|var)\s+(\w+)/g)) existing.add(m[1])
            let varName = varNameBase
            for (let i = 2; existing.has(varName); i++) varName = varNameBase + i

            const declaration = `let ${varName} = ${callText}\n`
            const varNameStartCol = 1 + "let ".length
            const varNameEndCol = varNameStartCol + varName.length

            // Insert at the first line above the cursor (cursor on line 5 → insert at line 4)
            const pos = ed.getPosition()
            const cursorLine = pos?.lineNumber ?? 1
            const insertLine = cursorLine > 1 ? cursorLine - 1 : 1
            const insertCol = 1
            const textToInsert = declaration

            const range = new monaco.Range(insertLine, insertCol, insertLine, insertCol)
            const nameSelection = new monaco.Selection(insertLine, varNameStartCol, insertLine, varNameEndCol)

            // executeEdits on the editor (not the model) lets us supply the end cursor state
            // atomically, so there are no intermediate phantom cursors.
            ed.executeEdits("insert-shape", [{ range, text: textToInsert }], [nameSelection])
            ed.focus()
        }

        const shapeInsertions: Array<{ id: string; label: string; varBase: string; call: string }> = [
            { id: "insertSphere", label: "Sphere", varBase: "newSphere", call: "sphere({ r: 1 })" },
            { id: "insertBox", label: "Box", varBase: "newBox", call: "box([2, 2, 2])" },
            { id: "insertCylinder", label: "Cylinder", varBase: "newCylinder", call: "cylinder({ r: 1, h: 3 })" },
            { id: "insertCone", label: "Cone", varBase: "newCone", call: "cone({ r: 1, h: 2 })" },
            { id: "insertTorus", label: "Torus", varBase: "newTorus", call: "torus({ sr: 0.25, lr: 1 })" },
            { id: "insertCapsule", label: "Capsule", varBase: "newCapsule", call: "capsule({ r: 0.5, c: 2 })" },
            { id: "insertPlane", label: "Plane", varBase: "newPlane", call: "plane({ n: [0, 1, 0] })" },
            { id: "insertHexPrism", label: "Hex prism", varBase: "newHexPrism", call: "hexprism({ r: 1, h: 2 })" },
            { id: "insertDisc", label: "Disc", varBase: "newDisc", call: "disc({ r: 1.5 })" },
            { id: "insertBlob", label: "Blob", varBase: "newBlob", call: "blob()" },
        ]

        addContextSubmenu(this.editor, {
            title: "Insert shape",
            group: "0_shapes",
            order: 1,
            actions: shapeInsertions.map(({ id, label, varBase, call }) => ({
                id,
                label,
                run: (ed) => insertShapeDeclaration(ed, varBase, call),
            })),
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

            /* Fluent CAD method names (.radius, .shift, .round, etc.) */
            .cad-fluent-method {
                color: #4ec9b0 !important;
                font-weight: 600;
            }
        `
        document.body.appendChild(style)

        requestAnimationFrame(() => {
            const bg = getComputedStyle(document.querySelector(".monaco-editor")!).getPropertyValue("--vscode-editor-background")
            this.#tabs.style.setProperty("--active-bg", bg)
        })

        // Viewport toolbar — floating over the preview area
        const toolbar = new Toolbar()
        const xrayIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
  <g stroke="currentColor" stroke-opacity="0.35" stroke-width="1" fill="none" stroke-dasharray="1.5,1.5" stroke-linecap="round">
    <line x1="9" y1="10" x2="15" y2="14"/>
    <line x1="9" y1="10" x2="3" y2="14"/>
    <line x1="9" y1="10" x2="9" y2="3"/>
  </g>
  <polygon points="9,3 15,7 9,10 3,7" fill="rgba(100,160,255,0.15)" stroke="none"/>
  <polygon points="15,7 15,14 9,17 9,10" fill="rgba(80,140,255,0.10)" stroke="none"/>
  <polygon points="3,7 9,10 9,17 3,14" fill="rgba(60,120,255,0.08)" stroke="none"/>
  <g stroke="currentColor" stroke-opacity="0.9" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <polygon points="9,3 15,7 9,10 3,7"/>
    <line x1="15" y1="7" x2="15" y2="14"/>
    <line x1="15" y1="14" x2="9" y2="17"/>
    <line x1="9" y1="17" x2="9" y2="10"/>
    <line x1="3" y1="7" x2="3" y2="14"/>
    <line x1="3" y1="14" x2="9" y2="17"/>
  </g>
</svg>`
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
        const iconEnterFullscreen = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`
        const iconExitFullscreen = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/></svg>`
        const updateFullscreenState = () => {
            const isFullscreen = !!document.fullscreenElement
            fullscreenBtn.active = isFullscreen
            fullscreenBtn.html = isFullscreen ? iconExitFullscreen : iconEnterFullscreen
        }
        updateFullscreenState()
        document.addEventListener("fullscreenchange", updateFullscreenState)
        if (document.fullscreenEnabled) {
            fullscreenBtn.onClick = async () => {
                if (document.fullscreenElement) {
                    await document.exitFullscreen()
                } else {
                    await document.documentElement.requestFullscreen()
                }
            }
        } else {
            fullscreenBtn.disabled = true
        }
        document.getElementById("toolbar")!.insertBefore(toolbar, menu)

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
                this.#wireMenu(menu)
                this.#wireExportButton(exportBtn)
                this.#wireDevToolsVersionToggle(preview, devTools)
                this.build()

                fromEventPattern<monaco.editor.IModelContentChangedEvent>(
                    h => this.editor.onDidChangeModelContent(h),
                    (_, disp) => disp.dispose()
                )
                    .pipe(debounceTime(200))
                    .subscribe(() => {
                        if (this.#skipNextBuild) {
                            this.#skipNextBuild = false
                            return
                        }
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
        xrayCheckbox: import("./components/toolbar.mjs").ToolbarToggleButton,
        selectionModeRadio: import("./components/toolbar.mjs").ToolbarRadioGroup<import("./sdf.mjs").SelectionMode>
    ) {
        this.#monacoHighlighter.setEditor(this.editor)

        this.renderer.selectionChange$.subscribe(() => {
            this.#isUpdatingFromPreview = true
            this.#updateEditorHighlighting()
            setTimeout(() => { this.#isUpdatingFromPreview = false }, 50)
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
        const newItem = document.createElement("span")
        newItem.innerHTML = "New Scene"
        const renameItem = document.createElement("span")
        renameItem.innerHTML = "Rename"
        const duplicateItem = document.createElement("span")
        duplicateItem.innerHTML = "Duplicate"
        const deleteItem = document.createElement("span")
        deleteItem.innerHTML = "Delete"

        const menuItems: Array<{ element: HTMLElement; action: () => void }> = [
            { element: newItem, action: () => this.#tabs.newDocument(undefined, "javascript") },
            { element: renameItem, action: () => this.#tabs.renameCurrentTab() },
            { element: duplicateItem, action: () => this.#tabs.duplicateCurrentTab() },
            { element: deleteItem, action: () => this.#tabs.deleteCurrentTab() },
        ]
        const menuButton = new MenuButton(menuItems, {
            getClosedDocuments: () => this.#tabs.closedDocumentNames,
            onOpen: name => this.#tabs.openStoredDocument(name),
        })
        menu.replaceWith(menuButton)
    }

    async #wireExportButton(exportBtn: import("./components/toolbar.mjs").ToolbarButton) {
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
            const freshInfo = this.#sourceParser.findPolygon2DAtPosition(src, pos.lineNumber, pos.column)
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

interface ArrayFormat {
    indent: string
    newlinePerVertex: boolean
}

function analyzeArrayFormatting(text: string): ArrayFormat {
    if (!text.includes("\n")) {
        return { indent: "", newlinePerVertex: false }
    }
    // Find indent: between first "[" (outer) and second "[" (first vertex)
    const firstBracket = text.indexOf("[")
    const between = text.slice(firstBracket + 1, text.indexOf("[", firstBracket + 1))
    const match = between.match(/\n([ \t]*)$/)
    const indent = match ? match[1] : "   "  // fallback: 3 spaces (matches tabSize)
    return { indent, newlinePerVertex: true }
}

function formatVertex([x, y]: [number, number]): string {
    const xs = String(Math.round(x * 100) / 100)
    const ys = String(Math.round(y * 100) / 100)
    return `[${xs}, ${ys}]`
}

function formatVertices(vertices: [number, number][], format?: ArrayFormat): string {
    const pairs = vertices.map(formatVertex)
    if (format?.newlinePerVertex && pairs.length > 0) {
        const indent = format.indent
        const lines = pairs.map((p, i) => indent + p + (i < pairs.length - 1 ? "," : ""))
        return "[\n" + lines.join("\n") + "\n]"
    }
    return `[${pairs.join(", ")}]`
}

/**
 * Apply vertex updates to the model. When vertex count matches, does surgical
 * in-place edits (no reformatting). Otherwise falls back to full replace with format preservation.
 */
function applyVertexUpdates(
    model: monaco.editor.ITextModel,
    info: Polygon2DCallInfo,
    vertices: [number, number][]
): void {
    if (vertices.length === info.vertexRanges.length) {
        // Surgical edits: replace each vertex in place, apply in reverse order
        const edits = vertices
            .map((v, i) => {
                const start = model.getPositionAt(info.vertexRanges[i].start)
                const end = model.getPositionAt(info.vertexRanges[i].end)
                return {
                    range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
                    text: formatVertex(v),
                }
            })
            .sort((a, b) => {
                const ap = a.range.getStartPosition()
                const bp = b.range.getStartPosition()
                return bp.lineNumber - ap.lineNumber || bp.column - ap.column
            })
        model.pushStackElement()
        model.pushEditOperations([], edits, () => null)
        model.pushStackElement()
    } else {
        const originalText = model.getValue().slice(info.arrayStartOffset, info.arrayEndOffset)
        const format = analyzeArrayFormatting(originalText)
        const newText = formatVertices(vertices, format)
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
