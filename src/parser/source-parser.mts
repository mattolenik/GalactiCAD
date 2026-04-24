/**
 * Source Parser - Parse JavaScript/TypeScript code to extract shape function calls with their arguments
 * Uses TypeScript compiler API to create AST, then matches calls to scene nodes by property values
 */

import * as ts from "typescript"
import { log } from "../logging/debug-log.mjs"
import { vec3, type Vec3, Vec3f } from "../vecmat/vector.mjs"

/**
 * Source location information for a shape in the code
 */
export interface SourceLocation {
    /** Starting line number (1-based, Monaco convention) */
    startLine: number
    /** Starting column number (1-based, Monaco convention) */
    startColumn: number
    /** Ending line number (1-based) */
    endLine: number
    /** Ending column number (1-based) */
    endColumn: number
    /** The name of the function (e.g., "sphere", "box") */
    functionName: string
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
    threadHandedness?: "left" | "right" // From .left / .right property chain (default right)
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
    /** Offset in source of the position array argument, if present. null when no pos arg. */
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
const COMPOSITE_FUNCTIONS = new Set(["union", "subtract", "intersect", "pipe", "engrave", "groove", "tongue", "morph", "seam", "extrude", "loft", "lathe"])
const MODIFIER_NAMES = new Set(["rotate", "scale", "shell", "offset", "elongate", "twist", "bend", "taper"])
const ALL_SHAPE_FUNCTIONS = new Set([...PRIMITIVE_FUNCTIONS, ...COMPOSITE_FUNCTIONS, ...MODIFIER_NAMES])

/**
 * CSG operators that act as pure pass-throughs: they have no independent visual representation
 * and should be "looked through" when resolving logical leaf calls.
 * Modifiers (rotate, shell, etc.) and rendering composites (extrude, loft, lathe) are NOT in this set.
 */
const CSG_PASSTHROUGH_FUNCTIONS = new Set(["union", "subtract", "intersect", "pipe", "engrave", "groove", "tongue", "morph", "seam"])

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
                    if (methodNames.has(name)) {
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

            // Pure CSG: look through its arguments
            const callNode = this.#callNodeMap.get(call.callStart)
            if (!callNode) return

            for (const arg of callNode.arguments) {
                this.#resolveCallArg(arg, resolve)
            }
        }

        resolve(compositeCall)
        return results
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

        if (ts.isIdentifier(callNode.expression)) {
            funcName = callNode.expression.text
            rootExpr = callNode.expression
            callStart = callNode.getStart() - WRAP_PREFIX_CHARS
            callEnd = callNode.getEnd() - WRAP_PREFIX_CHARS
        } else if (ts.isPropertyAccessExpression(callNode.expression)) {
            const propName = callNode.expression.name.getText()
            if (MODIFIER_NAMES.has(propName)) {
                funcName = propName
                rootExpr = callNode.expression
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
                functionName: funcName
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
        } else if (funcName === "scale") {
            this.parseScaleArgs(callNode, parsedCall)
        } else if (funcName === "shell" || funcName === "offset") {
            this.parseShellOffsetArgs(callNode, parsedCall)
        } else if (funcName === "elongate") {
            this.parseElongateArgs(callNode, parsedCall)
        } else if (funcName === "twist" || funcName === "bend") {
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
            } else if (method === "shift" && args.length >= 1 && this.isPositionArg(args[0])) {
                const v = this.evaluateExpression(args[0])
                if (v !== undefined) parsedCall.pos = vec3(v as Vec3)
            }
        }
    }

    /** Walk the fluent chain and return [{ method, args }, ...] from left to right */
    #collectFluentChain(callNode: ts.CallExpression): Array<{ method: string; args: ts.Node[] }> {
        const chain: Array<{ method: string; args: ts.Node[] }> = []
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
                } else if (method === "shift" && args.length >= 1 && this.isPositionArg(args[0])) {
                    const v = this.evaluateExpression(args[0])
                    if (v !== undefined) parsedCall.pos = vec3(v as Vec3)
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
                if (method === "shift" && args.length >= 1 && this.isPositionArg(args[0])) {
                    const v = this.evaluateExpression(args[0])
                    if (v !== undefined) parsedCall.pos = vec3(v as Vec3)
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
                } else if (method === "shift" && args.length >= 1 && this.isPositionArg(args[0])) {
                    const v = this.evaluateExpression(args[0])
                    if (v !== undefined) parsedCall.pos = vec3(v as Vec3)
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
                } else if ((method === "chamfer" || method === "fillet") && args.length >= 2) {
                    const side = this.evaluateExpression(args[0])
                    const rad = this.evaluateExpression(args[1])
                    if (typeof side !== "string" || typeof rad !== "number") continue
                    const s = side.toUpperCase()
                    if (s !== "TOP" && s !== "BOTTOM" && s !== "BOTH") continue
                    if (method === "chamfer") {
                        if (s === "TOP" || s === "BOTH") parsedCall.chamferTop = rad
                        if (s === "BOTTOM" || s === "BOTH") parsedCall.chamferBottom = rad
                        if (s === "TOP" || s === "BOTH") parsedCall.filletTop = 0
                        if (s === "BOTTOM" || s === "BOTH") parsedCall.filletBottom = 0
                    } else {
                        if (s === "TOP" || s === "BOTH") parsedCall.filletTop = rad
                        if (s === "BOTTOM" || s === "BOTH") parsedCall.filletBottom = rad
                        if (s === "TOP" || s === "BOTH") parsedCall.chamferTop = 0
                        if (s === "BOTTOM" || s === "BOTH") parsedCall.chamferBottom = 0
                    }
                } else if (method === "shift" && args.length >= 1 && this.isPositionArg(args[0])) {
                    const v = this.evaluateExpression(args[0])
                    if (v !== undefined) parsedCall.pos = vec3(v as Vec3)
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
                } else if (method === "shift" && args.length >= 1 && this.isPositionArg(args[0])) {
                    const v = this.evaluateExpression(args[0])
                    if (v !== undefined) parsedCall.pos = vec3(v as Vec3)
                }
            }
        } catch (err) {
            log("SourceParser").debug(`Could not parse torus fluent args:`, err)
        }
    }

    /** Detect threaded_rod.left / .right in the property chain (.profile etc. are not calls). */
    #threadedRodHandFromExpression(expr: ts.Node): "left" | "right" | undefined {
        let hand: "left" | "right" | undefined
        const visit = (n: ts.Node): void => {
            if (ts.isPropertyAccessExpression(n)) {
                visit(n.expression)
                const t = n.name.getText()
                if (t === "left" || t === "right") {
                    hand = t
                }
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
                parsedCall.threadHandedness = hand
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
                } else if (method === "female") {
                    if (args.length === 0) {
                        parsedCall.femalePlay = 0.01
                    } else {
                        const v = this.evaluateExpression(args[0])
                        if (typeof v === "number") parsedCall.femalePlay = v
                    }
                } else if ((method === "chamfer" || method === "fillet") && args.length >= 2) {
                    const side = this.evaluateExpression(args[0])
                    const rad = this.evaluateExpression(args[1])
                    if (typeof side !== "string" || typeof rad !== "number") continue
                    const s = side.toUpperCase()
                    if (s !== "TOP" && s !== "BOTTOM" && s !== "BOTH") continue
                    if (method === "chamfer") {
                        if (s === "TOP" || s === "BOTH") parsedCall.chamferTop = rad
                        if (s === "BOTTOM" || s === "BOTH") parsedCall.chamferBottom = rad
                        if (s === "TOP" || s === "BOTH") parsedCall.filletTop = 0
                        if (s === "BOTTOM" || s === "BOTH") parsedCall.filletBottom = 0
                    } else {
                        if (s === "TOP" || s === "BOTH") parsedCall.filletTop = rad
                        if (s === "BOTTOM" || s === "BOTH") parsedCall.filletBottom = rad
                        if (s === "TOP" || s === "BOTH") parsedCall.chamferTop = 0
                        if (s === "BOTTOM" || s === "BOTH") parsedCall.chamferBottom = 0
                    }
                } else if (method === "shift" && args.length >= 1 && this.isPositionArg(args[0])) {
                    const v = this.evaluateExpression(args[0])
                    if (v !== undefined) parsedCall.pos = vec3(v as Vec3)
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
                } else if (method === "shift" && args.length >= 1 && this.isPositionArg(args[0])) {
                    const v = this.evaluateExpression(args[0])
                    if (v !== undefined) parsedCall.pos = vec3(v as Vec3)
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
                if (method === "normal" && args.length >= 1) {
                    const v = this.evaluateExpression(args[0])
                    if (v !== undefined) parsedCall.normal = vec3(v as Vec3)
                } else if (method === "dist" && args.length >= 1) {
                    const v = this.evaluateExpression(args[0])
                    if (typeof v === "number") parsedCall.planeOffset = v
                } else if (method === "shift" && args.length >= 1 && this.isPositionArg(args[0])) {
                    const v = this.evaluateExpression(args[0])
                    if (v !== undefined) parsedCall.pos = vec3(v as Vec3)
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
                if (method === "shift" && args.length >= 1 && this.isPositionArg(args[0])) {
                    const v = this.evaluateExpression(args[0])
                    if (v !== undefined) parsedCall.pos = vec3(v as Vec3)
                }
            }
        } catch (err) {
            log("SourceParser").debug(`Could not parse blob fluent args:`, err)
        }
    }

    private parseRotateArgs(callNode: ts.CallExpression, _parsedCall: ParsedShapeCall): void {
        // Rotate matches by type only; no args needed for node matching
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
                if (method === "shift" && args.length >= 1 && this.isPositionArg(args[0])) {
                    const v = this.evaluateExpression(args[0])
                    if (v !== undefined) parsedCall.pos = vec3(v as Vec3)
                }
            }
        } catch (err) {
            log("SourceParser").debug(`Could not parse lathe fluent args:`, err)
        }
    }

    private parsePolygon2DArgs(callNode: ts.CallExpression, parsedCall: ParsedShapeCall): void {
        try {
            if (callNode.arguments.length >= 1 && ts.isArrayLiteralExpression(callNode.arguments[0])) {
                const vertices = this.evaluateVertexArray(callNode.arguments[0])
                if (vertices) parsedCall.vertices = vertices
            }
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

    private evaluateVertexArray(node: ts.ArrayLiteralExpression): [number, number][] | null {
        const vertices: [number, number][] = []
        for (const elem of node.elements) {
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
        if (callNode.arguments.length < 1) return null

        const arrayArg = callNode.arguments[0]
        if (!ts.isArrayLiteralExpression(arrayArg)) return null

        const vertices = this.evaluateVertexArray(arrayArg)
        if (!vertices) return null

        const vertexRanges: { start: number; end: number }[] = []
        for (const elem of arrayArg.elements) {
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
            arrayStartOffset: arrayArg.getStart() - WRAP_PREFIX_CHARS,
            arrayEndOffset: arrayArg.getEnd() - WRAP_PREFIX_CHARS,
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
            } else if (method === "shift" && args.length >= 1 && this.isPositionArg(args[0])) {
                posArgStart = args[0].getStart() - WRAP_PREFIX_CHARS
                posArgEnd = args[0].getEnd() - WRAP_PREFIX_CHARS
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
            } else if (method === "shift" && args.length >= 1 && this.isPositionArg(args[0])) {
                posArgStart = args[0].getStart() - WRAP_PREFIX_CHARS
                posArgEnd = args[0].getEnd() - WRAP_PREFIX_CHARS
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
