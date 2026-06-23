/**
 * Source Parser - Parse JavaScript/TypeScript code to extract shape function calls with their arguments
 * Uses TypeScript compiler API to create AST, then matches calls to scene nodes by property values
 */

import * as ts from "typescript"
import { log } from "../logging/debug-log.mjs"
import { BOTTOM, LEFT, RIGHT, TOP } from "../scene/direction-indicator.mjs"
import { vec3, type Vec3, Vec3f } from "../vecmat/vector.mjs"

/**
 * Source location information for a shape in the code
 */
export interface SourceLocation {
    /** Starting line number (1-based) */
    startLine: number
    /** Starting column number (1-based) */
    startColumn: number
    /** Ending line number (1-based) */
    endLine: number
    /** Ending column number (1-based) */
    endColumn: number
    /** The name of the function (e.g., "sphere", "box") */
    functionName: string
    /**
     * When set, the editor omits the colored function-name pill, `cad-fluent-method` (teal) styling,
     * and selection outline (yellow) for this source span. Set for `.rotate(…)` on a chain; the global
     * `rotate(rot, node)` does not set this.
     */
    skipColorIndicator?: boolean
}

/**
 * Write-back target for the transform gizmo: the source spans needed to edit or
 * append a `.shift(...)` on the shape call at a given position.
 */
export interface GizmoTransformTarget {
    location: SourceLocation
    /** Start offset of the fluent chain (user coords) — for wrapping in `translate(...)`. */
    chainStart: number
    /** End offset of the chain (user coords) — where to append a new `.shift(...)`. */
    insertOffset: number
    /** Whether a `.shift(...)` exists anywhere in the chain (literal or not). */
    hasShift: boolean
    /** Whether the existing shift's args are numeric literals (editable in place). */
    shiftIsLiteral: boolean
    /** Source range of the last shift's position args, when literal. */
    shiftRange: { start: number; end: number } | null
    /** Parsed value of the last shift's literal args (absolute pos; last `.shift` wins), or null. */
    shiftValue: [number, number, number] | null
    /** Whether a `.rotate(...)` appears BEFORE any `.shift` (maps to the object's local rotation). */
    hasPreShiftRotate: boolean
    /** Count of pre-shift `.rotate(...)` calls in the chain. Incremental rot edits are only
     * sound when this is 1 (a single literal rotate == the absolute rot; multiple compose). */
    preShiftRotateCount: number
    /** Whether that pre-shift rotate's args are numeric literals (editable in place). */
    rotateIsLiteral: boolean
    /** Source range of the last pre-shift rotate's args, when literal. */
    rotateRange: { start: number; end: number } | null
    /** Parsed Euler of the last pre-shift literal rotate, for composition. */
    rotateBaseEuler: [number, number, number] | null
    /** Offset to insert a new pre-shift `.rotate(...)`: before the first `.shift`, else chain end. */
    rotateInsertOffset: number
}

/**
 * Parsed shape call with source location and extracted arguments
 */
export interface ParsedShapeCall {
    location: SourceLocation
    functionName: string
    /** Character offset of the start of the full call expression in user source (without wrapper). */
    callStart: number
    /** Character offset of the end of the full call expression in user source (without wrapper). */
    callEnd: number
    // Parsed argument values for matching
    pos?: Vec3f       // Position for sphere/box/cylinder/cone/etc.
    size?: Vec3f      // Size for box
    r?: number        // Radius for sphere/cylinder/cone/hexprism/disc
    h?: number        // Half-height for cylinder/hexprism, full height for cone
    sr?: number       // Small radius (tube) for torus
    lr?: number       // Large radius (ring) for torus
    pitch?: number    // Axial distance per 360° for threaded_rod
    depth?: number    // Radial amplitude override for threaded_rod (disables pitch+angle amp)
    threadAngle?: number // Meridional flank angle (deg) for threaded_rod; with pitch sets amp unless depth()
    threadProfile?: "fdm" | "iso" | "acme" // From .profile.fdm() / .iso() / .acme() chain
    /** From `hand(LEFT|RIGHT)`, or threaded_rod.left / .right chain. Default RIGHT. */
    handedness?: number
    c?: number        // Center half-height for capsule
    normal?: Vec3f    // Normal vector for plane
    planeOffset?: number  // Distance from origin for plane
    vertices?: [number, number][]  // Vertex array for polygon2d
    t?: number                     // Twist (degrees) for extrude
    /** Cylinder rim fillet radius (+y cap). */
    filletTop?: number
    /** Cylinder rim fillet radius (-y cap). */
    filletBottom?: number
    /** Cylinder rim chamfer amount (+y cap). */
    chamferTop?: number
    /** Cylinder rim chamfer amount (-y cap). */
    chamferBottom?: number
    /** ThreadedRod: female radial clearance play (0 = nominal). */
    femalePlay?: number
}

/**
 * Mapping from scene node index to source location
 */
export type SourceLocationMap = Map<number, SourceLocation>

/**
 * Information about a polygon2d() call for the polygon editor
 */
export interface Polygon2DCallInfo {
    callStartOffset: number
    callEndOffset: number
    arrayStartOffset: number
    arrayEndOffset: number
    vertices: [number, number][]
    /** User-space offset range [start, end) of each vertex [x,y] for surgical edits */
    vertexRanges: { start: number; end: number }[]
    location: SourceLocation
}

/**
 * Source location of a fluent method call (e.g. .radius, .shift) for decoration highlighting.
 */
export interface FluentMethodLocation {
    name: string
    startLine: number
    startColumn: number
    endLine: number
    endColumn: number
}

/**
 * Information about an extrude() or loft() call for cap push/pull source updates.
 * Tracks the source offsets of the `h:` value and position array so they can be
 * surgically replaced after a drag operation.
 */
export interface ExtrudeLoftCallInfo {
    functionName: "extrude" | "loft" | "threaded_rod"
    /** Offset in source of the `h:` value expression (start, end). */
    hValueStart: number
    hValueEnd: number
    /**
     * Source range of the `.shift(...)` position arguments, if present. Covers both
     * the array/string form (`.shift([x,y,z])`) and the literal form
     * (`.shift(x, y, z)`, spanning all three components). null when no pos arg.
     */
    posArgStart: number | null
    posArgEnd: number | null
    /** Offset in user source where `.shift([...])` is appended when there is no shift (end of the full fluent call). */
    insertPosOffset: number
    location: SourceLocation
}

/**
 * Wrapping prefix/suffix used to make bare function-body code parseable.
 * The editor source is just the function body (with return statements), so we
 * wrap it in a function declaration before parsing, then adjust locations back.
 */
export const WRAP_PREFIX = "function _() {\n"
export const WRAP_SUFFIX = "\n}"
export const WRAP_PREFIX_LINES = 1   // number of extra lines the prefix adds
export const WRAP_PREFIX_CHARS = WRAP_PREFIX.length

/**
 * Create a wrapped source string for parsing.
 */
function wrapSource(src: string): string {
    return WRAP_PREFIX + src + WRAP_SUFFIX
}

/**
 * Parse source and return the TypeScript SourceFile.
 * Uses createSourceFile only; the parser is resilient and produces a tree even for
 * invalid input. We avoid getPreEmitDiagnostics because a minimal compiler host
 * can emit unrelated diagnostics (e.g. missing lib.d.ts) that would incorrectly
 * reject valid CAD source.
 */
function parseSource(src: string): ts.SourceFile {
    const wrapped = wrapSource(src)
    return ts.createSourceFile(
        "cad.ts",
        wrapped,
        ts.ScriptTarget.Latest,
        true
    )
}

/**
 * Parse source and return the TypeScript SourceFile plus syntactic diagnostics.
 * Uses getSyntacticDiagnostics (not getPreEmitDiagnostics) so that semantic errors
 * from missing lib.d.ts types (Math, console, etc.) do not produce false positives
 * for valid CAD source.
 */
function parseSourceWithDiagnostics(src: string): { sourceFile: ts.SourceFile; diagnostics: readonly ts.Diagnostic[] } {
    const sourceFile = parseSource(src)
    const program = ts.createProgram(["cad.ts"], {}, {
        getSourceFile: () => sourceFile,
        getDefaultLibFileName: () => "lib.d.ts",
        writeFile: () => { },
        getCurrentDirectory: () => "",
        getDirectories: () => [],
        fileExists: () => true,
        readFile: () => "",
        getCanonicalFileName: (f) => f,
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => "\n",
    })
    const diagnostics = program.getSyntacticDiagnostics(sourceFile)
    return { sourceFile, diagnostics }
}

/**
 * Convert TypeScript position (0-based line, 0-based character) to user document position.
 * Subtracts WRAP_PREFIX_LINES from line, adds 1 to column for 1-based.
 */
function tsPosToUser(sourceFile: ts.SourceFile, pos: number): { line: number; column: number } {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(pos)
    return {
        line: line - WRAP_PREFIX_LINES + 1,
        column: character + 1
    }
}

/**
 * Try to parse source. If parse fails with syntax errors, return the error position
 * adjusted for the prefix (1-based line, 1-based column in user's document).
 */
export function getSyntaxErrorPosition(src: string): { line: number; column: number } | null {
    const { sourceFile, diagnostics } = parseSourceWithDiagnostics(src)
    if (diagnostics.length === 0) return null

    const diag = diagnostics[0]
    if (!diag || diag.start === undefined) return null

    const { line, column } = tsPosToUser(sourceFile, diag.start)

    // Reject if error was in the prefix line (line would be 0 or less)
    if (line < 1) return null

    // When parser reports column 1 at start of line, the real mistake is often at end of previous line
    const userLines = src.split("\n")
    if (column === 1 && line > 1) {
        const prevLine = line - 1
        const prevContent = userLines[prevLine - 1] ?? ""
        return { line: prevLine, column: prevContent.length + 1 }
    }

    return { line, column }
}

/**
 * Find the line number of the return statement in document source.
 * Returns 1-based line number, or null if no return statement or parse fails.
 */
export function findReturnStatementLine(src: string): number | null {
    const sourceFile = parseSource(src)
    let lastReturnLine: number | null = null

    function visit(node: ts.Node) {
        if (ts.isReturnStatement(node)) {
            const { line } = tsPosToUser(sourceFile, node.getStart())
            lastReturnLine = line
        }
        ts.forEachChild(node, visit)
    }
    visit(sourceFile)

    return lastReturnLine
}

/**
 * Shape functions we care about for source location tracking
 */
const PRIMITIVE_FUNCTIONS = new Set(["sphere", "box", "cylinder", "cone", "torus", "threaded_rod", "capsule", "plane", "hexprism", "disc", "blob", "polygon2d"])
const COMPOSITE_FUNCTIONS = new Set(["union", "subtract", "intersect", "pipe", "engrave", "groove", "tongue", "morph", "seam", "extrude", "loft", "lathe", "knurl"])
const MODIFIER_NAMES = new Set(["rotate", "translate", "scale", "shell", "offset", "elongate", "twist", "bend", "taper", "repeatPolar"])
const ALL_SHAPE_FUNCTIONS = new Set([...PRIMITIVE_FUNCTIONS, ...COMPOSITE_FUNCTIONS, ...MODIFIER_NAMES])

/**
 * CSG operators that act as pure pass-throughs: they have no independent visual representation
 * and should be "looked through" when resolving logical leaf calls.
 * Modifiers (rotate, shell, etc.) and rendering composites (extrude, loft, lathe) are NOT in this set.
 */
const CSG_PASSTHROUGH_FUNCTIONS = new Set(["union", "subtract", "intersect", "pipe", "engrave", "groove", "knurl", "tongue", "morph", "seam"])

/**
 * Parser for extracting source locations from CAD code
 */
export class SourceParser {
    /** Maps callStart (user-source offset) → ts.CallExpression node, populated by parseShapeCalls */
    #callNodeMap: Map<number, ts.CallExpression> = new Map()
    /** Maps callStart (user-source offset) → ParsedShapeCall, for O(1) lookup in resolveLogicalLeafCalls */
    #callMap: Map<number, ParsedShapeCall> = new Map()
    /** Maps variable name → ParsedShapeCall for its initializer, populated by parseShapeCalls */
    #varMap: Map<string, ParsedShapeCall> = new Map()
    /** Root positions already added for fluent chains (avoid duplicate ParsedShapeCalls) */
    #fluentChainRoots: Set<number> = new Set()
    /** `callStart:funcName` keys already emitted, to drop duplicate ParsedShapeCalls — see processCallExpression. */
    #seenCallKeys: Set<string> = new Set()
    /** Cached AST from last parseShapeCalls, used by findFluentMethods */
    #lastSourceFile: ts.SourceFile | null = null

    /**
     * Parse JavaScript/TypeScript code and extract all shape function calls with their arguments
     * @param src JavaScript/TypeScript source code
     * @returns Array of parsed shape calls
     */
    parseShapeCalls(src: string): ParsedShapeCall[] {
        const calls: ParsedShapeCall[] = []
        const sourceFile = parseSource(src)
        this.#lastSourceFile = sourceFile
        this.#callNodeMap.clear()
        this.#callMap.clear()
        this.#fluentChainRoots.clear()
        this.#seenCallKeys.clear()

        const visit = (node: ts.Node) => {
            if (ts.isCallExpression(node)) {
                this.processCallExpression(node, sourceFile, calls)
            }
            ts.forEachChild(node, visit)
        }
        visit(sourceFile)

        // Build variable map: name → ParsedShapeCall for its defining shape call
        this.#varMap.clear()
        const visitVars = (node: ts.Node) => {
            if (ts.isVariableDeclaration(node) &&
                ts.isIdentifier(node.name) &&
                node.initializer &&
                ts.isCallExpression(node.initializer)) {
                const callStart = node.initializer.getStart() - WRAP_PREFIX_CHARS
                const matchingCall = this.#callMap.get(callStart)
                if (matchingCall) {
                    this.#varMap.set(node.name.text, matchingCall)
                }
            }
            ts.forEachChild(node, visitVars)
        }
        visitVars(sourceFile)

        // Propagate locations for modifier chains through variables so all decorators
        // (primitive + modifiers) appear at the variable, not split between var and init.
        this.#propagateVariableChainLocations(sourceFile, calls)

        log("SourceParser").debug(`Found ${calls.length} shape call(s)`)

        return calls
    }

    /**
     * When a modifier chain goes through a variable (e.g. s.shell(3) where s = sphere.radius(5).taper(1, 2)),
     * update the locations of all calls in the initializer chain to the variable's position,
     * so all decorators stack at the variable.
     */
    #propagateVariableChainLocations(sourceFile: ts.SourceFile, calls: ParsedShapeCall[]): void {
        for (const call of calls) {
            if (!MODIFIER_NAMES.has(call.functionName)) continue

            const callNode = this.#callNodeMap.get(call.callStart)
            if (!callNode || !ts.isPropertyAccessExpression(callNode.expression)) continue

            const rootExpr = callNode.expression.expression
            if (!ts.isIdentifier(rootExpr)) continue

            const varName = rootExpr.text
            const initCall = this.#varMap.get(varName)
            if (!initCall) continue

            const varLoc = {
                startLine: tsPosToUser(sourceFile, rootExpr.getStart()).line,
                startColumn: tsPosToUser(sourceFile, rootExpr.getStart()).column,
                endLine: tsPosToUser(sourceFile, rootExpr.getEnd()).line,
                endColumn: tsPosToUser(sourceFile, rootExpr.getEnd()).column,
                functionName: call.functionName,
            }

            const chainCalls = this.#collectChainCalls(initCall)
            for (const c of chainCalls) {
                c.location = { ...varLoc, functionName: c.functionName }
            }
        }
    }

    /** Collect all ParsedShapeCalls in a modifier/fluent chain (primitive + modifiers). */
    #collectChainCalls(outerCall: ParsedShapeCall): ParsedShapeCall[] {
        const result: ParsedShapeCall[] = [outerCall]
        const callNode = this.#callNodeMap.get(outerCall.callStart)
        if (!callNode || !ts.isPropertyAccessExpression(callNode.expression)) return result

        let expr: ts.Node = callNode.expression.expression
        while (true) {
            if (ts.isCallExpression(expr)) {
                const innerStart = expr.getStart() - WRAP_PREFIX_CHARS
                const innerCall = this.#callMap.get(innerStart)
                if (innerCall && innerCall !== outerCall) {
                    result.push(innerCall)
                    expr = expr.expression
                } else {
                    break
                }
            } else if (ts.isPropertyAccessExpression(expr)) {
                expr = expr.expression
            } else {
                break
            }
        }
        return result
    }

    /**
     * Return the cached SourceFile from the last parseShapeCalls if it was parsed from the given src.
     * Use when calling findPolygon2DAtPosition or findExtrudeLoftAtPosition to avoid re-parsing.
     */
    getCachedSourceFile(src: string): ts.SourceFile | null {
        const sf = this.#lastSourceFile
        if (!sf || sf.getFullText() !== wrapSource(src)) return null
        return sf
    }

    /**
     * Find all fluent method calls (e.g. .radius, .shift) whose names are in the provided set.
     * Uses the cached AST from the last parseShapeCalls() call. Returns [] if parseShapeCalls
     * has not been called yet or if the cached AST is unavailable.
     */
    findFluentMethods(methodNames: Set<string>): FluentMethodLocation[] {
        const sourceFile = this.#lastSourceFile
        if (!sourceFile) return []

        const locations: FluentMethodLocation[] = []

        const visit = (node: ts.Node) => {
            if (ts.isCallExpression(node)) {
                if (ts.isPropertyAccessExpression(node.expression)) {
                    const prop = node.expression
                    const name = prop.name.text
                    // Only `rotate(rot, node)` is a first-class highlighted call; `.rotate(rot)` is not.
                    if (methodNames.has(name) && name !== "rotate") {
                        const nameNode = prop.name
                        const startLoc = tsPosToUser(sourceFile, nameNode.getStart())
                        const endLoc = tsPosToUser(sourceFile, nameNode.getEnd())
                        locations.push({
                            name,
                            startLine: startLoc.line,
                            startColumn: startLoc.column,
                            endLine: endLoc.line,
                            endColumn: endLoc.column,
                        })
                    }
                } else if (ts.isIdentifier(node.expression) && methodNames.has(node.expression.text)) {
                    const nameNode = node.expression
                    const startLoc = tsPosToUser(sourceFile, nameNode.getStart())
                    const endLoc = tsPosToUser(sourceFile, nameNode.getEnd())
                    locations.push({
                        name: nameNode.text,
                        startLine: startLoc.line,
                        startColumn: startLoc.column,
                        endLine: endLoc.line,
                        endColumn: endLoc.column,
                    })
                }
            }
            ts.forEachChild(node, visit)
        }
        visit(sourceFile)

        return locations
    }

    /**
     * Resolve a composite ParsedShapeCall to its logical leaf calls by tracing through
     * variable references in the TypeScript AST.
     *
     * For inline code: `union(sphere(...), box(...))` → [sphere_call, box_call]
     * For variable code: `const s=sphere(...); union(s, box(...))` → [sphere_call, box_call]
     *
     * Recurses through CSG_PASSTHROUGH_FUNCTIONS; stops at primitives and rendering composites
     * (extrude, loft, lathe, rotate, scale) which are treated as leaves.
     */
    resolveLogicalLeafCalls(compositeCall: ParsedShapeCall): ParsedShapeCall[] {
        const results: ParsedShapeCall[] = []
        const visited = new Set<number>()

        const resolve = (call: ParsedShapeCall) => {
            if (visited.has(call.callStart)) return
            visited.add(call.callStart)

            if (!CSG_PASSTHROUGH_FUNCTIONS.has(call.functionName)) {
                // Leaf: primitive or rendering composite (extrude, rotate, scale, etc.)
                results.push(call)
                return
            }

            // Pure CSG: look through its arguments. The mapped node may be the OUTER node of a
            // fluent chain (`union(a,b).shift(...)` → the `.shift` call, whose arguments are the
            // shift vector, not the operands), so descend to the operator call that actually holds
            // the CSG operands before reading them.
            const callNode = this.#callNodeMap.get(call.callStart)
            if (!callNode) return

            for (const arg of this.#operatorCallNode(callNode).arguments) {
                this.#resolveCallArg(arg, resolve)
            }
        }

        resolve(compositeCall)
        return results
    }

    /**
     * Descend a fluent chain to the call that names the operator directly, i.e. whose `.expression`
     * is the shape-function identifier. For a plain `union(a,b)` this is the node itself; for
     * `union(a,b).shift(v)` it walks past the trailing `.shift(v)` to the `union(a,b)` call.
     */
    #operatorCallNode(callNode: ts.CallExpression): ts.CallExpression {
        let cur: ts.CallExpression = callNode
        while (ts.isPropertyAccessExpression(cur.expression) && ts.isCallExpression(cur.expression.expression)) {
            cur = cur.expression.expression
        }
        return cur
    }

    /** Resolve a single call argument to a shape call and invoke resolve() on it */
    #resolveCallArg(arg: ts.Expression, resolve: (call: ParsedShapeCall) => void): void {
        if (ts.isCallExpression(arg)) {
            let callStart: number | undefined
            if (ts.isIdentifier(arg.expression)) {
                const funcName = arg.expression.text
                if (ALL_SHAPE_FUNCTIONS.has(funcName)) {
                    callStart = arg.getStart() - WRAP_PREFIX_CHARS
                }
            } else if (ts.isPropertyAccessExpression(arg.expression)) {
                const fluent = this.#getFluentChainInfo(arg)
                if (fluent && ALL_SHAPE_FUNCTIONS.has(fluent.operator)) {
                    callStart = fluent.callStart
                } else {
                    // Modifier chain on a variable operand (e.g. `union(a.scale(2), b)`):
                    // the chain root is a variable, not a shape-function name, so the fluent
                    // lookup bails and the operand would be dropped — leaving the CSG result
                    // only partially selected. The chain's own (modifier) call is keyed in
                    // #callMap at the arg's start; resolve it so the geometry is still selected.
                    callStart = arg.getStart() - WRAP_PREFIX_CHARS
                }
            }
            if (callStart !== undefined) {
                const call = this.#callMap.get(callStart)
                if (call) resolve(call)
            }
        } else if (ts.isIdentifier(arg)) {
            const call = this.#varMap.get(arg.text)
            if (call) resolve(call)
        } else if (ts.isSpreadElement(arg)) {
            this.#resolveCallArg(arg.expression, resolve)
        }
    }

    /**
     * Process a CallExpression to extract shape function info
     */
    private processCallExpression(callNode: ts.CallExpression, sourceFile: ts.SourceFile, calls: ParsedShapeCall[]): void {
        let funcName: string
        let rootExpr: ts.Node
        let callStart: number
        let callEnd: number
        let isFluent = false
        let skipColorIndicator: boolean = false

        if (ts.isIdentifier(callNode.expression)) {
            funcName = callNode.expression.text
            rootExpr = callNode.expression
            callStart = callNode.getStart() - WRAP_PREFIX_CHARS
            callEnd = callNode.getEnd() - WRAP_PREFIX_CHARS
        } else if (ts.isPropertyAccessExpression(callNode.expression)) {
            const propName = callNode.expression.name.getText()
            if (MODIFIER_NAMES.has(propName)) {
                funcName = propName
                if (propName === "rotate") {
                    skipColorIndicator = true
                }
                // Source location for indicators / selection: the method name only (e.g. `rotate` in
                // `.rotate`), not the full PropertyAccess — otherwise a chain like
                // `cylinder...height(2).rotate(...)` would span the entire expression and cover the line
                // with a single (wrong) pill, or overlap every inner call in the same range.
                rootExpr = callNode.expression.name
                callStart = callNode.getStart() - WRAP_PREFIX_CHARS
                callEnd = callNode.getEnd() - WRAP_PREFIX_CHARS
                // Ensure we create calls for all modifiers in the chain (visit order may miss some)
                this.#ensureChainCallsCreated(callNode, sourceFile, calls)
            } else {
                const fluent = this.#getFluentChainInfo(callNode)
                if (!fluent) return
                const rootPos = fluent.rootIdentifier.getStart()
                if (this.#fluentChainRoots.has(rootPos)) return
                this.#fluentChainRoots.add(rootPos)
                funcName = fluent.operator
                rootExpr = fluent.rootIdentifier
                callStart = fluent.callStart
                callEnd = fluent.callEnd
                isFluent = true
            }
        } else {
            return
        }

        if (!ALL_SHAPE_FUNCTIONS.has(funcName)) return

        // Dedup by (callStart, funcName). A call is reached twice in two ways:
        //  • #ensureChainCallsCreated pre-creates an inner chain call the AST visitor then revisits.
        //  • The fluent branch emits the operator call (`union(...).shift(...)`, `sphere().radius(5)`)
        //    while the inner identifier call emits the same operator at the same offset.
        // Both share (callStart, funcName), so they collapse to one — avoiding duplicate indicators
        // (two stacked icons once a composite expands to multiple scene nodes). funcName is part of
        // the key because every call in a chain shares getStart(): keying on callStart alone would
        // wrongly drop a chained modifier (`box(...).scale(2)` — box & scale differ only by funcName).
        const callKey = `${callStart}:${funcName}`
        if (this.#seenCallKeys.has(callKey)) return
        this.#seenCallKeys.add(callKey)

        const startPos = rootExpr.getStart()
        const endPos = rootExpr.getEnd()
        const startLoc = tsPosToUser(sourceFile, startPos)
        const endLoc = tsPosToUser(sourceFile, endPos)

        this.#callNodeMap.set(callStart, callNode)

        const parsedCall: ParsedShapeCall = {
            functionName: funcName,
            callStart,
            callEnd,
            location: {
                startLine: startLoc.line,
                startColumn: startLoc.column,
                endLine: endLoc.line,
                endColumn: endLoc.column,
                functionName: funcName,
                ...(skipColorIndicator ? { skipColorIndicator: true } : {}),
            }
        }

        if (funcName === "sphere" || funcName === "disc") {
            this.parseSphereFluentArgs(callNode, parsedCall)
        } else if (funcName === "box") {
            this.parseBoxFluentArgs(callNode, parsedCall)
        } else if (funcName === "cylinder") {
            this.parseCylinderFluentArgs(callNode, parsedCall)
        } else if (funcName === "cone" || funcName === "hexprism") {
            this.parsePosRadiusHeightFluentArgs(callNode, parsedCall)
        } else if (funcName === "torus") {
            this.parseTorusFluentArgs(callNode, parsedCall)
        } else if (funcName === "threaded_rod") {
            this.parseThreadedRodFluentArgs(callNode, parsedCall)
        } else if (funcName === "capsule") {
            this.parseCapsuleFluentArgs(callNode, parsedCall)
        } else if (funcName === "plane") {
            this.parsePlaneFluentArgs(callNode, parsedCall)
        } else if (funcName === "blob") {
            this.parseBlobFluentArgs(callNode, parsedCall)
        } else if (funcName === "polygon2d") {
            this.parsePolygon2DArgs(callNode, parsedCall)
        } else if ((funcName === "extrude" || funcName === "loft") && isFluent) {
            this.parseExtrudeLoftFluentArgs(callNode, parsedCall)
        } else if (funcName === "lathe" && isFluent) {
            this.parseLatheFluentArgs(callNode, parsedCall)
        } else if (funcName === "rotate") {
            this.parseRotateArgs(callNode, parsedCall)
        } else if (funcName === "translate") {
            this.parseTranslateArgs(callNode, parsedCall)
        } else if (funcName === "scale") {
            this.parseScaleArgs(callNode, parsedCall)
        } else if (funcName === "shell" || funcName === "offset") {
            this.parseShellOffsetArgs(callNode, parsedCall)
        } else if (funcName === "elongate") {
            this.parseElongateArgs(callNode, parsedCall)
        } else if (funcName === "twist" || funcName === "bend" || funcName === "repeatPolar") {
            this.parseTwistBendArgs(callNode, parsedCall)
        } else if (funcName === "taper") {
            this.parseTaperArgs(callNode, parsedCall)
        }
        // union, subtract, intersect, pipe, engrave, groove, tongue, morph, seam: match by type only

        calls.push(parsedCall)
        this.#callMap.set(callStart, parsedCall)
    }

    /**
     * When processing a modifier call, traverse the chain and ensure we create ParsedShapeCalls
     * for all modifiers and the root. ts.forEachChild visit order can miss inner calls in some
     * AST structures, so this guarantees multiple decorators for chains like a.taper(1,2).shell(3).
     */
    #ensureChainCallsCreated(outerCallNode: ts.CallExpression, sourceFile: ts.SourceFile, calls: ParsedShapeCall[]): void {
        let expr: ts.Node = outerCallNode.expression
        while (true) {
            if (ts.isPropertyAccessExpression(expr)) {
                expr = expr.expression
            } else if (ts.isCallExpression(expr)) {
                const innerStart = expr.getStart() - WRAP_PREFIX_CHARS
                if (!this.#callMap.has(innerStart)) {
                    this.processCallExpression(expr, sourceFile, calls)
                }
                expr = expr.expression
            } else {
                break
            }
        }
    }

    /**
     * If callNode is part of a fluent chain (e.g. extrude.profile(x).height(n).shift(v)),
     * return { operator, rootIdentifier, callStart, callEnd }. Otherwise null.
     */
    #getFluentChainInfo(callNode: ts.CallExpression): { operator: string; rootIdentifier: ts.Identifier; callStart: number; callEnd: number } | null {
        let expr: ts.Node = callNode.expression
        while (true) {
            if (ts.isPropertyAccessExpression(expr)) {
                expr = expr.expression
            } else if (ts.isCallExpression(expr)) {
                expr = expr.expression
            } else {
                break
            }
        }
        if (!ts.isIdentifier(expr)) return null
        const operator = expr.text
        if (!ALL_SHAPE_FUNCTIONS.has(operator)) return null
        return {
            operator,
            rootIdentifier: expr,
            callStart: callNode.getStart() - WRAP_PREFIX_CHARS,
            callEnd: callNode.getEnd() - WRAP_PREFIX_CHARS,
        }
    }

    /** Parse fluent chain args for extrude/loft: .profile(x).height(n).twist(t).shift(v) */
    private parseExtrudeLoftFluentArgs(callNode: ts.CallExpression, parsedCall: ParsedShapeCall): void {
        const chain = this.#collectFluentChain(callNode)
        for (const { method, args } of chain) {
            if (method === "height" && args.length >= 1) {
                const v = this.evaluateExpression(args[0])
                if (typeof v === "number") parsedCall.h = v
            } else if (method === "twist" && args.length >= 1) {
                const v = this.evaluateExpression(args[0])
                if (typeof v === "number") parsedCall.t = v
            } else if (method === "shift") {
                const v = this.extractVec3Args(args)
                if (v !== undefined) parsedCall.pos = vec3(v)
            }
        }
    }

    /** Walk the fluent chain and return [{ method, args }, ...] from left to right */
    #collectFluentChain(callNode: ts.CallExpression): Array<{ method: string; args: ts.Expression[] }> {
        const chain: Array<{ method: string; args: ts.Expression[] }> = []
        let expr: ts.Node = callNode
        while (true) {
            if (ts.isCallExpression(expr)) {
                const method = ts.isPropertyAccessExpression(expr.expression)
                    ? expr.expression.name.getText()
                    : null
                if (method) {
                    chain.unshift({ method, args: [...expr.arguments] })
                }
                expr = expr.expression
            } else if (ts.isPropertyAccessExpression(expr)) {
                expr = expr.expression
            } else {
                break
            }
        }
        return chain
    }


    private parseSphereFluentArgs(callNode: ts.CallExpression, parsedCall: ParsedShapeCall): void {
        try {
            const chain = this.#collectFluentChain(callNode)
            for (const { method, args } of chain) {
                if (method === "radius" && args.length >= 1) {
                    const v = this.evaluateExpression(args[0])
                    if (typeof v === "number") parsedCall.r = v
                } else if (method === "shift") {
                    const v = this.extractVec3Args(args)
                    if (v !== undefined) parsedCall.pos = vec3(v)
                }
            }
        } catch (err) {
            log("SourceParser").debug(`Could not parse sphere fluent args:`, err)
        }
    }

    private parseBoxFluentArgs(callNode: ts.CallExpression, parsedCall: ParsedShapeCall): void {
        try {
            const rootCall = this.#getRootCall(callNode, "box")
            if (rootCall) {
                const args = rootCall.arguments
                if (args.length >= 1 && this.isPositionArg(args[0])) {
                    const v = this.evaluateExpression(args[0])
                    if (v !== undefined) parsedCall.size = vec3(v as Vec3)
                } else if (args.length >= 3) {
                    const l = this.evaluateExpression(args[0])
                    const w = this.evaluateExpression(args[1])
                    const h = this.evaluateExpression(args[2])
                    if (typeof l === "number" && typeof w === "number" && typeof h === "number") {
                        parsedCall.size = vec3([l, w, h])
                    }
                }
            }
            const chain = this.#collectFluentChain(callNode)
            for (const { method, args } of chain) {
                if (method === "shift") {
                    const v = this.extractVec3Args(args)
                    if (v !== undefined) parsedCall.pos = vec3(v)
                }
            }
        } catch (err) {
            log("SourceParser").debug(`Could not parse box fluent args:`, err)
        }
    }

    /** Get the root call node for a fluent chain (e.g. box([1,2,3]) from box([1,2,3]).shift(v)) */
    #getRootCall(callNode: ts.CallExpression, rootName: string): ts.CallExpression | null {
        let expr: ts.Node = callNode
        while (true) {
            if (ts.isCallExpression(expr)) {
                if (ts.isIdentifier(expr.expression) && expr.expression.text === rootName) {
                    return expr
                }
                expr = expr.expression
            } else if (ts.isPropertyAccessExpression(expr)) {
                expr = expr.expression
            } else {
                return null
            }
        }
    }

    private parsePosRadiusHeightFluentArgs(callNode: ts.CallExpression, parsedCall: ParsedShapeCall): void {
        try {
            const chain = this.#collectFluentChain(callNode)
            for (const { method, args } of chain) {
                if (method === "radius" && args.length >= 1) {
                    const v = this.evaluateExpression(args[0])
                    if (typeof v === "number") parsedCall.r = v
                } else if (method === "height" && args.length >= 1) {
                    const v = this.evaluateExpression(args[0])
                    if (typeof v === "number") parsedCall.h = v
                } else if (method === "shift") {
                    const v = this.extractVec3Args(args)
                    if (v !== undefined) parsedCall.pos = vec3(v)
                }
            }
        } catch (err) {
            log("SourceParser").debug(`Could not parse ${parsedCall.functionName} fluent args:`, err)
        }
    }

    private parseCylinderFluentArgs(callNode: ts.CallExpression, parsedCall: ParsedShapeCall): void {
        try {
            const chain = this.#collectFluentChain(callNode)
            for (const { method, args } of chain) {
                if (method === "radius" && args.length >= 1) {
                    const v = this.evaluateExpression(args[0])
                    if (typeof v === "number") parsedCall.r = v
                } else if (method === "height" && args.length >= 1) {
                    const v = this.evaluateExpression(args[0])
                    if (typeof v === "number") parsedCall.h = v
                } else if (method === "chamfer" && args.length >= 2) {
                    const side = this.evaluateExpression(args[0])
                    const rad = this.evaluateExpression(args[1])
                    if (typeof side !== "number" || typeof rad !== "number" || !Number.isFinite(side)) continue
                    if (side & TOP) parsedCall.chamferTop = rad
                    if (side & BOTTOM) parsedCall.chamferBottom = rad
                    if (side & TOP) parsedCall.filletTop = 0
                    if (side & BOTTOM) parsedCall.filletBottom = 0
                } else if (method === "fillet" && args.length >= 1) {
                    const rad = this.evaluateExpression(args[0])
                    if (typeof rad !== "number") continue
                    let sideFlags = TOP | BOTTOM
                    if (args.length >= 2) {
                        const side = this.evaluateExpression(args[1])
                        if (typeof side !== "number" || !Number.isFinite(side)) continue
                        sideFlags = side
                    }
                    if (sideFlags & TOP) parsedCall.filletTop = rad
                    if (sideFlags & BOTTOM) parsedCall.filletBottom = rad
                    if (sideFlags & TOP) parsedCall.chamferTop = 0
                    if (sideFlags & BOTTOM) parsedCall.chamferBottom = 0
                } else if (method === "shift") {
                    const v = this.extractVec3Args(args)
                    if (v !== undefined) parsedCall.pos = vec3(v)
                }
            }
            if (typeof parsedCall.r === "number" && typeof parsedCall.h === "number") {
                const cap = Math.min(parsedCall.r * 0.49, parsedCall.h * 0.49)
                const clampE = (v: number | undefined) => {
                    if (v === undefined) return undefined
                    if (!(v > 0) || !Number.isFinite(v)) return 0
                    return Math.min(v, cap)
                }
                parsedCall.chamferTop = clampE(parsedCall.chamferTop)
                parsedCall.chamferBottom = clampE(parsedCall.chamferBottom)
                parsedCall.filletTop = clampE(parsedCall.filletTop)
                parsedCall.filletBottom = clampE(parsedCall.filletBottom)
            }
        } catch (err) {
            log("SourceParser").debug(`Could not parse cylinder fluent args:`, err)
        }
    }

    private parseTorusFluentArgs(callNode: ts.CallExpression, parsedCall: ParsedShapeCall): void {
        try {
            const chain = this.#collectFluentChain(callNode)
            for (const { method, args } of chain) {
                if (method === "smallRadius" && args.length >= 1) {
                    const v = this.evaluateExpression(args[0])
                    if (typeof v === "number") parsedCall.sr = v
                } else if (method === "largeRadius" && args.length >= 1) {
                    const v = this.evaluateExpression(args[0])
                    if (typeof v === "number") parsedCall.lr = v
                } else if (method === "shift") {
                    const v = this.extractVec3Args(args)
                    if (v !== undefined) parsedCall.pos = vec3(v)
                }
            }
        } catch (err) {
            log("SourceParser").debug(`Could not parse torus fluent args:`, err)
        }
    }

    /** Detect threaded_rod.left / .right in the property chain (.profile etc. are not calls). */
    #threadedRodHandFromExpression(expr: ts.Node): typeof LEFT | typeof RIGHT | undefined {
        let hand: typeof LEFT | typeof RIGHT | undefined
        const visit = (n: ts.Node): void => {
            if (ts.isPropertyAccessExpression(n)) {
                visit(n.expression)
                const t = n.name.getText()
                if (t === "left") hand = LEFT
                else if (t === "right") hand = RIGHT
            } else if (ts.isCallExpression(n)) {
                visit(n.expression)
            }
        }
        visit(expr)
        return hand
    }

    private parseThreadedRodFluentArgs(callNode: ts.CallExpression, parsedCall: ParsedShapeCall): void {
        try {
            const hand = this.#threadedRodHandFromExpression(callNode.expression)
            if (hand !== undefined) {
                parsedCall.handedness = hand
            }
            const chain = this.#collectFluentChain(callNode)
            for (const { method, args } of chain) {
                if (method === "iso" && args.length === 0) {
                    parsedCall.threadProfile = "iso"
                    break
                }
                if (method === "fdm" && args.length === 0) {
                    parsedCall.threadProfile = "fdm"
                    break
                }
                if (method === "acme" && args.length === 0) {
                    parsedCall.threadProfile = "acme"
                    break
                }
            }
            for (const { method, args } of chain) {
                if (method === "radius" && args.length >= 1) {
                    const v = this.evaluateExpression(args[0])
                    if (typeof v === "number") parsedCall.r = v
                } else if (method === "height" && args.length >= 1) {
                    const v = this.evaluateExpression(args[0])
                    if (typeof v === "number") parsedCall.h = v
                } else if (method === "pitch" && args.length >= 1) {
                    const v = this.evaluateExpression(args[0])
                    if (typeof v === "number") parsedCall.pitch = v
                } else if (method === "depth" && args.length >= 1) {
                    const v = this.evaluateExpression(args[0])
                    if (typeof v === "number") parsedCall.depth = v
                } else if (method === "threadAngle" && args.length >= 1) {
                    const v = this.evaluateExpression(args[0])
                    if (typeof v === "number") parsedCall.threadAngle = v
                } else if (method === "hand" && args.length >= 1) {
                    const v = this.evaluateExpression(args[0])
                    if (v === LEFT || v === RIGHT) parsedCall.handedness = v
                } else if (method === "female") {
                    if (args.length === 0) {
                        parsedCall.femalePlay = 0.01
                    } else {
                        const v = this.evaluateExpression(args[0])
                        if (typeof v === "number") parsedCall.femalePlay = v
                    }
                } else if (method === "chamfer" && args.length >= 2) {
                    const side = this.evaluateExpression(args[0])
                    const rad = this.evaluateExpression(args[1])
                    if (typeof side !== "number" || typeof rad !== "number" || !Number.isFinite(side)) continue
                    if (side & TOP) parsedCall.chamferTop = rad
                    if (side & BOTTOM) parsedCall.chamferBottom = rad
                    if (side & TOP) parsedCall.filletTop = 0
                    if (side & BOTTOM) parsedCall.filletBottom = 0
                } else if (method === "fillet" && args.length >= 1) {
                    const rad = this.evaluateExpression(args[0])
                    if (typeof rad !== "number") continue
                    let sideFlags = TOP | BOTTOM
                    if (args.length >= 2) {
                        const side = this.evaluateExpression(args[1])
                        if (typeof side !== "number" || !Number.isFinite(side)) continue
                        sideFlags = side
                    }
                    if (sideFlags & TOP) parsedCall.filletTop = rad
                    if (sideFlags & BOTTOM) parsedCall.filletBottom = rad
                    if (sideFlags & TOP) parsedCall.chamferTop = 0
                    if (sideFlags & BOTTOM) parsedCall.chamferBottom = 0
                } else if (method === "shift") {
                    const v = this.extractVec3Args(args)
                    if (v !== undefined) parsedCall.pos = vec3(v)
                }
            }
            if (typeof parsedCall.r === "number" && typeof parsedCall.h === "number") {
                const ampEst =
                    typeof parsedCall.depth === "number"
                        ? Math.abs(parsedCall.depth)
                        : (() => {
                              const pitch = parsedCall.pitch ?? 0.5
                              const angDeg = parsedCall.threadAngle ?? 60
                              const rad = (angDeg * Math.PI) / 180
                              return (Math.tan(rad) * pitch) / (2 * Math.PI)
                          })()
                const env = parsedCall.r + ampEst
                const cap = Math.min(env * 0.49, parsedCall.h * 0.49)
                const clampE = (v: number | undefined) => {
                    if (v === undefined) return undefined
                    if (!(v > 0) || !Number.isFinite(v)) return 0
                    return Math.min(v, cap)
                }
                parsedCall.chamferTop = clampE(parsedCall.chamferTop)
                parsedCall.chamferBottom = clampE(parsedCall.chamferBottom)
                parsedCall.filletTop = clampE(parsedCall.filletTop)
                parsedCall.filletBottom = clampE(parsedCall.filletBottom)
            }
            if (parsedCall.femalePlay !== undefined) {
                const v = parsedCall.femalePlay
                if (!Number.isFinite(v)) parsedCall.femalePlay = 0
                else parsedCall.femalePlay = Math.max(-0.99, Math.min(v, 3))
            }
        } catch (err) {
            log("SourceParser").debug("Could not parse threaded_rod fluent args:", err)
        }
    }

    private parseCapsuleFluentArgs(callNode: ts.CallExpression, parsedCall: ParsedShapeCall): void {
        try {
            const chain = this.#collectFluentChain(callNode)
            for (const { method, args } of chain) {
                if (method === "radius" && args.length >= 1) {
                    const v = this.evaluateExpression(args[0])
                    if (typeof v === "number") parsedCall.r = v
                } else if (method === "cylinderLength" && args.length >= 1) {
                    const v = this.evaluateExpression(args[0])
                    if (typeof v === "number") parsedCall.c = v
                } else if (method === "shift") {
                    const v = this.extractVec3Args(args)
                    if (v !== undefined) parsedCall.pos = vec3(v)
                }
            }
        } catch (err) {
            log("SourceParser").debug(`Could not parse capsule fluent args:`, err)
        }
    }

    private parsePlaneFluentArgs(callNode: ts.CallExpression, parsedCall: ParsedShapeCall): void {
        try {
            const chain = this.#collectFluentChain(callNode)
            for (const { method, args } of chain) {
                if (method === "normal") {
                    const v = this.extractVec3Args(args)
                    if (v !== undefined) parsedCall.normal = vec3(v)
                } else if (method === "dist" && args.length >= 1) {
                    const v = this.evaluateExpression(args[0])
                    if (typeof v === "number") parsedCall.planeOffset = v
                } else if (method === "shift") {
                    const v = this.extractVec3Args(args)
                    if (v !== undefined) parsedCall.pos = vec3(v)
                }
            }
        } catch (err) {
            log("SourceParser").debug(`Could not parse plane fluent args:`, err)
        }
    }

    private parseBlobFluentArgs(callNode: ts.CallExpression, parsedCall: ParsedShapeCall): void {
        try {
            const chain = this.#collectFluentChain(callNode)
            for (const { method, args } of chain) {
                if (method === "shift") {
                    const v = this.extractVec3Args(args)
                    if (v !== undefined) parsedCall.pos = vec3(v)
                }
            }
        } catch (err) {
            log("SourceParser").debug(`Could not parse blob fluent args:`, err)
        }
    }

    private parseRotateArgs(callNode: ts.CallExpression, _parsedCall: ParsedShapeCall): void {
        // Rotate matches by type only; no args needed for node matching
    }

    private parseTranslateArgs(_callNode: ts.CallExpression, _parsedCall: ParsedShapeCall): void {
        // Translate matches by type only
    }

    private parseScaleArgs(_callNode: ts.CallExpression, _parsedCall: ParsedShapeCall): void {
        // Scale matches by type only; no args needed for node matching
    }

    private parseShellOffsetArgs(callNode: ts.CallExpression, parsedCall: ParsedShapeCall): void {
        try {
            if (callNode.arguments.length >= 1) {
                const v = this.evaluateExpression(callNode.arguments[0])
                if (typeof v === "number") parsedCall.r = v
            }
        } catch (err) {
            log("SourceParser").debug(`Could not parse ${parsedCall.functionName} args:`, err)
        }
    }

    private parseElongateArgs(_callNode: ts.CallExpression, _parsedCall: ParsedShapeCall): void {
        // Elongate matches by type only
    }

    private parseTwistBendArgs(callNode: ts.CallExpression, parsedCall: ParsedShapeCall): void {
        try {
            if (callNode.arguments.length >= 1) {
                const v = this.evaluateExpression(callNode.arguments[0])
                if (typeof v === "number") parsedCall.r = v
            }
        } catch (err) {
            log("SourceParser").debug(`Could not parse ${parsedCall.functionName} args:`, err)
        }
    }

    private parseTaperArgs(callNode: ts.CallExpression, parsedCall: ParsedShapeCall): void {
        try {
            if (callNode.arguments.length >= 2) {
                const v0 = this.evaluateExpression(callNode.arguments[0])
                const v1 = this.evaluateExpression(callNode.arguments[1])
                if (typeof v0 === "number") parsedCall.r = v0
                if (typeof v1 === "number") parsedCall.h = v1
            }
        } catch (err) {
            log("SourceParser").debug(`Could not parse taper args:`, err)
        }
    }

    private parseLatheFluentArgs(callNode: ts.CallExpression, parsedCall: ParsedShapeCall): void {
        try {
            const chain = this.#collectFluentChain(callNode)
            for (const { method, args } of chain) {
                if (method === "shift") {
                    const v = this.extractVec3Args(args)
                    if (v !== undefined) parsedCall.pos = vec3(v)
                }
            }
        } catch (err) {
            log("SourceParser").debug(`Could not parse lathe fluent args:`, err)
        }
    }

    private parsePolygon2DArgs(callNode: ts.CallExpression, parsedCall: ParsedShapeCall): void {
        try {
            const vertices = this.evaluateVertexArgs(callNode.arguments)
            if (vertices) parsedCall.vertices = vertices
        } catch (err) {
            log("SourceParser").debug(`Could not parse polygon2d args:`, err)
        }
    }

    private getPropertyKey(prop: ts.PropertyAssignment): string | undefined {
        const name = prop.name
        if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text
        return undefined
    }

    private isPositionArg(node: ts.Node): boolean {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true
        if (ts.isArrayLiteralExpression(node)) {
            const elements = node.elements
            if (elements.length !== 3) return false
            return elements.every((e) =>
                e && (ts.isNumericLiteral(e) || ts.isPrefixUnaryExpression(e))
            )
        }
        return false
    }

    /**
     * Extract a 3D vector from `.shift(...)` / `plane.normal(...)`-style args,
     * accepting BOTH the array/string form (`[x, y, z]`, `"x y z"`) and the
     * literal component form (`x, y, z`). Returns undefined if neither matches.
     */
    private extractVec3Args(args: readonly ts.Expression[]): Vec3 | undefined {
        if (args.length >= 1 && this.isPositionArg(args[0])) {
            const v = this.evaluateExpression(args[0])
            return v === undefined ? undefined : (v as Vec3)
        }
        if (args.length >= 3) {
            const x = this.evaluateExpression(args[0])
            const y = this.evaluateExpression(args[1])
            const z = this.evaluateExpression(args[2])
            if (typeof x === "number" && typeof y === "number" && typeof z === "number") {
                return [x, y, z]
            }
        }
        return undefined
    }

    /**
     * Source range spanning the position arguments of a `.shift(...)` call, for
     * surgical writeback. Covers BOTH the array/string form (`.shift([x,y,z])`,
     * one arg) and the literal component form (`.shift(x, y, z)`, three args) —
     * the range runs from the first arg's start to the last arg's end. Returns
     * null when the args are not a recognizable position.
     */
    private shiftPosRange(args: readonly ts.Expression[]): { start: number; end: number } | null {
        if (this.extractVec3Args(args) === undefined) return null
        return {
            start: args[0].getStart() - WRAP_PREFIX_CHARS,
            end: args[args.length - 1].getEnd() - WRAP_PREFIX_CHARS,
        }
    }

    private evaluateExpression(node: ts.Node): unknown {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
            return node.text
        }
        if (ts.isNumericLiteral(node)) {
            return parseFloat(node.text)
        }
        if (ts.isArrayLiteralExpression(node)) {
            const result: number[] = []
            for (const elem of node.elements) {
                const val = this.evaluateExpression(elem)
                if (typeof val !== "number") return undefined
                result.push(val)
            }
            return result
        }
        if (ts.isPrefixUnaryExpression(node)) {
            if (node.operator === ts.SyntaxKind.MinusToken) {
                const arg = this.evaluateExpression(node.operand)
                if (typeof arg === "number") return -arg
            } else if (node.operator === ts.SyntaxKind.PlusToken) {
                return this.evaluateExpression(node.operand)
            }
        }
        if (ts.isParenthesizedExpression(node)) {
            return this.evaluateExpression(node.expression)
        }
        if (ts.isBinaryExpression(node)) {
            const lhs = this.evaluateExpression(node.left)
            const rhs = this.evaluateExpression(node.right)
            if (typeof lhs === "number" && typeof rhs === "number") {
                switch (node.operatorToken.kind) {
                    case ts.SyntaxKind.PlusToken: return lhs + rhs
                    case ts.SyntaxKind.MinusToken: return lhs - rhs
                    case ts.SyntaxKind.AsteriskToken: return lhs * rhs
                    case ts.SyntaxKind.SlashToken: return rhs !== 0 ? lhs / rhs : undefined
                    case ts.SyntaxKind.PercentToken: return rhs !== 0 ? lhs % rhs : undefined
                    case ts.SyntaxKind.AsteriskAsteriskToken: return lhs ** rhs
                }
            }
        }
        return undefined
    }

    /**
     * Evaluate a `polygon2d([x, y], [x, y], …)` var-arg list into vertex pairs.
     * Each argument must be a `[x, y]` numeric array literal.
     */
    private evaluateVertexArgs(args: readonly ts.Expression[]): [number, number][] | null {
        const vertices: [number, number][] = []
        for (const elem of args) {
            if (!elem || !ts.isArrayLiteralExpression(elem)) return null
            const inner = elem.elements
            if (inner.length !== 2) return null
            const x = this.evaluateExpression(inner[0])
            const y = this.evaluateExpression(inner[1])
            if (typeof x !== "number" || typeof y !== "number") return null
            vertices.push([x, y])
        }
        return vertices
    }

    findPolygon2DAtPosition(src: string, line: number, column: number, sourceFile?: ts.SourceFile): Polygon2DCallInfo | null {
        const offset = this.positionToOffset(src, line, column)
        const calls: Polygon2DCallInfo[] = []

        const sf = sourceFile && sourceFile.getFullText() === wrapSource(src) ? sourceFile : parseSource(src)

        const visit = (node: ts.Node) => {
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "polygon2d") {
                const info = this.extractPolygon2DInfo(node, sf)
                if (info) calls.push(info)
            }
            ts.forEachChild(node, visit)
        }
        visit(sf)

        for (const call of calls) {
            if (offset >= call.callStartOffset && offset <= call.callEndOffset) {
                return call
            }
        }
        return null
    }

    private positionToOffset(src: string, line: number, column: number): number {
        const lines = src.split("\n")
        if (line > lines.length) return src.length
        let offset = 0
        for (let i = 0; i < line - 1 && i < lines.length; i++) {
            offset += lines[i].length + 1
        }
        offset += column - 1
        return Math.max(0, Math.min(offset, src.length))
    }

    private extractPolygon2DInfo(callNode: ts.CallExpression, sourceFile: ts.SourceFile): Polygon2DCallInfo | null {
        const args = callNode.arguments
        if (args.length < 1) return null

        const vertices = this.evaluateVertexArgs(args)
        if (!vertices) return null

        const vertexRanges: { start: number; end: number }[] = []
        for (const elem of args) {
            if (elem && ts.isArrayLiteralExpression(elem)) {
                vertexRanges.push({
                    start: elem.getStart() - WRAP_PREFIX_CHARS,
                    end: elem.getEnd() - WRAP_PREFIX_CHARS,
                })
            }
        }

        const startPos = callNode.expression.getStart()
        const loc = tsPosToUser(sourceFile, startPos)
        const endLoc = tsPosToUser(sourceFile, callNode.expression.getEnd())

        return {
            callStartOffset: callNode.getStart() - WRAP_PREFIX_CHARS,
            callEndOffset: callNode.getEnd() - WRAP_PREFIX_CHARS,
            // Var-arg list: the replaceable vertex region spans the first arg start
            // to the last arg end (the content between the parens, minus surrounding
            // whitespace/newlines, which are preserved on count-changing edits).
            arrayStartOffset: args[0].getStart() - WRAP_PREFIX_CHARS,
            arrayEndOffset: args[args.length - 1].getEnd() - WRAP_PREFIX_CHARS,
            vertices,
            vertexRanges,
            location: {
                startLine: loc.line,
                startColumn: loc.column,
                endLine: endLoc.line,
                endColumn: endLoc.column,
                functionName: "polygon2d"
            }
        }
    }

    /**
     * Find the shape call at a position and report its `.shift(...)` write-back
     * target (range to edit in place, or chain spans to append/wrap). Used by the
     * transform gizmo to translate the selected object in source.
     */
    findTransformTargetAtPosition(src: string, line: number, column: number, sourceFile?: ts.SourceFile): GizmoTransformTarget | null {
        const sf = sourceFile && sourceFile.getFullText() === wrapSource(src) ? sourceFile : parseSource(src)
        const candidates: GizmoTransformTarget[] = []
        const visit = (node: ts.Node) => {
            if (ts.isCallExpression(node)) {
                const fluent = this.#getFluentChainInfo(node)
                if (fluent) {
                    const t = this.#extractTransformTarget(node, sf, fluent)
                    if (t) candidates.push(t)
                }
            }
            ts.forEachChild(node, visit)
        }
        visit(sf)

        // Prefer an exact start match; among ties (same chain root) take the
        // outermost call (largest end = full chain with all fluent methods).
        let best: GizmoTransformTarget | null = null
        for (const c of candidates) {
            if (c.location.startLine === line && c.location.startColumn === column) {
                if (!best || c.insertOffset > best.insertOffset) best = c
            }
        }
        if (best) return best
        // Fallback: innermost call whose range contains the position.
        const contains = (loc: SourceLocation) =>
            !(line < loc.startLine || line > loc.endLine || (line === loc.startLine && column < loc.startColumn) || (line === loc.endLine && column > loc.endColumn))
        for (const c of candidates) {
            if (!contains(c.location)) continue
            if (!best || c.insertOffset < best.insertOffset) best = c
        }
        return best
    }

    #extractTransformTarget(callNode: ts.CallExpression, sf: ts.SourceFile, fluent: { operator: string; rootIdentifier: ts.Identifier }): GizmoTransformTarget | null {
        // Walk the chain in order, tracking each method's call node so we can find
        // the insertion point just before the first `.shift`.
        const chain: Array<{ method: string; args: ts.Expression[]; call: ts.CallExpression }> = []
        let expr: ts.Node = callNode
        while (true) {
            if (ts.isCallExpression(expr)) {
                if (ts.isPropertyAccessExpression(expr.expression)) {
                    chain.unshift({ method: expr.expression.name.getText(), args: [...expr.arguments], call: expr })
                }
                expr = expr.expression
            } else if (ts.isPropertyAccessExpression(expr)) {
                expr = expr.expression
            } else break
        }

        let shiftArgs: ts.Expression[] | null = null
        let hasShift = false
        let firstShiftCall: ts.CallExpression | null = null
        let preShiftRotateArgs: ts.Expression[] | null = null
        let hasPreShiftRotate = false
        let preShiftRotateCount = 0
        let seenShift = false
        for (const { method, args, call } of chain) {
            if (method === "shift") {
                hasShift = true
                shiftArgs = args
                if (!firstShiftCall) firstShiftCall = call
                seenShift = true
            } else if (method === "rotate" && !seenShift) {
                hasPreShiftRotate = true
                preShiftRotateCount++
                preShiftRotateArgs = args // last pre-shift rotate wins
            }
        }

        const shiftRange = shiftArgs ? this.shiftPosRange(shiftArgs) : null
        const shiftValueRaw = shiftArgs ? this.extractVec3Args(shiftArgs) : undefined
        let shiftValue: [number, number, number] | null = null
        if (shiftValueRaw !== undefined) {
            const v = vec3(shiftValueRaw)
            shiftValue = [v.x, v.y, v.z]
        }
        const rotateRange = preShiftRotateArgs ? this.shiftPosRange(preShiftRotateArgs) : null
        const rotateBaseRaw = preShiftRotateArgs ? this.extractVec3Args(preShiftRotateArgs) : undefined
        let rotateBaseEuler: [number, number, number] | null = null
        if (rotateBaseRaw !== undefined) {
            const v = vec3(rotateBaseRaw)
            rotateBaseEuler = [v.x, v.y, v.z]
        }
        // Insert a new pre-shift rotate just before the first `.shift` (its
        // receiver's end), else at the chain end.
        const rotateInsertOffset =
            firstShiftCall && ts.isPropertyAccessExpression(firstShiftCall.expression)
                ? firstShiftCall.expression.expression.getEnd() - WRAP_PREFIX_CHARS
                : callNode.getEnd() - WRAP_PREFIX_CHARS

        const startPos = fluent.rootIdentifier.getStart()
        const loc = tsPosToUser(sf, startPos)
        const endLoc = tsPosToUser(sf, callNode.getEnd())
        return {
            location: { startLine: loc.line, startColumn: loc.column, endLine: endLoc.line, endColumn: endLoc.column, functionName: fluent.operator },
            chainStart: startPos - WRAP_PREFIX_CHARS,
            insertOffset: callNode.getEnd() - WRAP_PREFIX_CHARS,
            hasShift,
            shiftIsLiteral: shiftRange !== null,
            shiftRange,
            shiftValue,
            hasPreShiftRotate,
            preShiftRotateCount,
            rotateIsLiteral: rotateRange !== null,
            rotateRange,
            rotateBaseEuler,
            rotateInsertOffset,
        }
    }

    findExtrudeLoftAtPosition(src: string, line: number, column: number, sourceFile?: ts.SourceFile): ExtrudeLoftCallInfo | null {
        const calls: ExtrudeLoftCallInfo[] = []

        const sf = sourceFile && sourceFile.getFullText() === wrapSource(src) ? sourceFile : parseSource(src)

        const visit = (node: ts.Node) => {
            if (ts.isCallExpression(node)) {
                let name: string | null = null
                if (ts.isIdentifier(node.expression)) {
                    name = node.expression.text
                } else if (ts.isPropertyAccessExpression(node.expression)) {
                    const fluent = this.#getFluentChainInfo(node)
                    if (fluent && (fluent.operator === "extrude" || fluent.operator === "loft")) {
                        name = fluent.operator
                    }
                }
                if (name === "extrude" || name === "loft") {
                    const info = this.extractExtrudeLoftInfo(node, name as "extrude" | "loft", sf)
                    if (info) calls.push(info)
                }
            }
            ts.forEachChild(node, visit)
        }
        visit(sf)

        for (const call of calls) {
            if (call.location.startLine === line && call.location.startColumn === column) {
                return call
            }
        }
        if (calls.length === 1) return calls[0]
        const containmentMatch = this.#findInnermostExtrudeLoftAtPosition(calls, line, column)
        return containmentMatch
    }

    #findInnermostExtrudeLoftAtPosition(calls: ExtrudeLoftCallInfo[], line: number, column: number): ExtrudeLoftCallInfo | null {
        const RANGE_SIZE_FACTOR = 100_000
        const contains = (loc: { startLine: number; startColumn: number; endLine: number; endColumn: number }) => {
            if (line < loc.startLine || line > loc.endLine) return false
            if (line === loc.startLine && column < loc.startColumn) return false
            if (line === loc.endLine && column > loc.endColumn) return false
            return true
        }
        const rangeSize = (loc: { startLine: number; startColumn: number; endLine: number; endColumn: number }) =>
            (loc.endLine - loc.startLine) * RANGE_SIZE_FACTOR + (loc.endColumn - loc.startColumn)

        let best: ExtrudeLoftCallInfo | null = null
        for (const call of calls) {
            if (!contains(call.location)) continue
            const size = rangeSize(call.location)
            if (!best || size < rangeSize(best.location)) best = call
        }
        return best
    }

    findThreadedRodAtPosition(src: string, line: number, column: number, sourceFile?: ts.SourceFile): ExtrudeLoftCallInfo | null {
        const calls: ExtrudeLoftCallInfo[] = []
        const sf = sourceFile && sourceFile.getFullText() === wrapSource(src) ? sourceFile : parseSource(src)
        const visit = (node: ts.Node) => {
            if (ts.isCallExpression(node)) {
                let name: string | null = null
                if (ts.isIdentifier(node.expression)) {
                    name = node.expression.text
                } else if (ts.isPropertyAccessExpression(node.expression)) {
                    const fluent = this.#getFluentChainInfo(node)
                    if (fluent && fluent.operator === "threaded_rod") {
                        name = fluent.operator
                    }
                }
                if (name === "threaded_rod") {
                    const info = this.extractThreadedRodInfo(node, sf)
                    if (info) calls.push(info)
                }
            }
            ts.forEachChild(node, visit)
        }
        visit(sf)
        for (const call of calls) {
            if (call.location.startLine === line && call.location.startColumn === column) {
                return call
            }
        }
        if (calls.length === 1) return calls[0]
        return this.#findInnermostExtrudeLoftAtPosition(calls, line, column)
    }

    private extractThreadedRodInfo(callNode: ts.CallExpression, sourceFile: ts.SourceFile): ExtrudeLoftCallInfo | null {
        if (!ts.isPropertyAccessExpression(callNode.expression)) return null

        let hValueStart: number | null = null
        let hValueEnd: number | null = null
        let posArgStart: number | null = null
        let posArgEnd: number | null = null

        const chain = this.#collectFluentChain(callNode)
        for (const { method, args } of chain) {
            if (method === "height" && args.length >= 1) {
                hValueStart = args[0].getStart() - WRAP_PREFIX_CHARS
                hValueEnd = args[0].getEnd() - WRAP_PREFIX_CHARS
            } else if (method === "shift") {
                const range = this.shiftPosRange(args)
                if (range) { posArgStart = range.start; posArgEnd = range.end }
            }
        }
        if (hValueStart === null || hValueEnd === null) return null

        const fluent = this.#getFluentChainInfo(callNode)
        if (!fluent) return null

        const insertPosOffset = callNode.getEnd() - WRAP_PREFIX_CHARS
        const startPos = fluent.rootIdentifier.getStart()
        const endPos = callNode.getEnd()

        const loc = tsPosToUser(sourceFile, startPos)
        const endLoc = tsPosToUser(sourceFile, endPos)

        return {
            functionName: "threaded_rod",
            hValueStart,
            hValueEnd,
            posArgStart,
            posArgEnd,
            insertPosOffset,
            location: {
                startLine: loc.line,
                startColumn: loc.column,
                endLine: endLoc.line,
                endColumn: endLoc.column,
                functionName: "threaded_rod",
            },
        }
    }

    private extractExtrudeLoftInfo(
        callNode: ts.CallExpression,
        name: "extrude" | "loft",
        sourceFile: ts.SourceFile
    ): ExtrudeLoftCallInfo | null {
        if (!ts.isPropertyAccessExpression(callNode.expression)) return null

        let hValueStart: number | null = null
        let hValueEnd: number | null = null
        let posArgStart: number | null = null
        let posArgEnd: number | null = null

        const chain = this.#collectFluentChain(callNode)
        for (const { method, args } of chain) {
            if (method === "height" && args.length >= 1) {
                hValueStart = args[0].getStart() - WRAP_PREFIX_CHARS
                hValueEnd = args[0].getEnd() - WRAP_PREFIX_CHARS
            } else if (method === "shift") {
                const range = this.shiftPosRange(args)
                if (range) { posArgStart = range.start; posArgEnd = range.end }
            }
        }
        if (hValueStart === null || hValueEnd === null) return null

        const fluent = this.#getFluentChainInfo(callNode)
        if (!fluent) return null

        const insertPosOffset = callNode.getEnd() - WRAP_PREFIX_CHARS
        const startPos = fluent.rootIdentifier.getStart()
        const endPos = callNode.getEnd()

        const loc = tsPosToUser(sourceFile, startPos)
        const endLoc = tsPosToUser(sourceFile, endPos)

        return {
            functionName: name,
            hValueStart,
            hValueEnd,
            posArgStart,
            posArgEnd,
            insertPosOffset,
            location: {
                startLine: loc.line,
                startColumn: loc.column,
                endLine: endLoc.line,
                endColumn: endLoc.column,
                functionName: name,
            }
        }
    }
}

/**
 * Singleton instance for global use
 */
export const sourceParser = new SourceParser()
