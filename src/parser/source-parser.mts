/**
 * Source Parser - Parse JavaScript/TypeScript code to extract shape function calls with their arguments
 * Uses TypeScript compiler API to create AST, then matches calls to scene nodes by property values
 */

import * as ts from "typescript"
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
    d?: number        // Diameter (alternative to r)
    h?: number        // Half-height for cylinder/hexprism, full height for cone
    sr?: number       // Small radius (tube) for torus
    lr?: number       // Large radius (ring) for torus
    c?: number        // Center half-height for capsule
    normal?: Vec3f    // Normal vector for plane
    planeOffset?: number  // Distance from origin for plane
    vertices?: [number, number][]  // Vertex array for polygon2d
    t?: number                     // Twist (degrees) for extrude
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
    location: SourceLocation
}

/**
 * Information about an extrude() or loft() call for cap push/pull source updates.
 * Tracks the source offsets of the `h:` value and position array so they can be
 * surgically replaced after a drag operation.
 */
export interface ExtrudeLoftCallInfo {
    functionName: "extrude" | "loft"
    /** Offset in source of the `h:` value expression (start, end). */
    hValueStart: number
    hValueEnd: number
    /** Offset in source of the position array argument, if present. null when no pos arg. */
    posArgStart: number | null
    posArgEnd: number | null
    /** Offset in source where a position argument would be inserted (after the opening paren). */
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
        writeFile: () => {},
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
const PRIMITIVE_FUNCTIONS = new Set(["sphere", "box", "cylinder", "cone", "torus", "capsule", "plane", "hexprism", "disc", "blob", "polygon2d"])
const COMPOSITE_FUNCTIONS = new Set(["union", "subtract", "intersect", "pipe", "engrave", "groove", "tongue", "shell", "offset", "elongate", "twist", "bend", "taper", "morph", "seam", "group", "rotate", "extrude", "loft", "lathe"])
const ALL_SHAPE_FUNCTIONS = new Set([...PRIMITIVE_FUNCTIONS, ...COMPOSITE_FUNCTIONS])

/**
 * CSG operators that act as pure pass-throughs: they have no independent visual representation
 * and should be "looked through" when resolving logical leaf calls.
 * Rendering composites (extrude, loft, lathe, rotate) are NOT in this set.
 */
const CSG_PASSTHROUGH_FUNCTIONS = new Set(["union", "subtract", "intersect", "pipe", "engrave", "groove", "tongue", "shell", "offset", "elongate", "twist", "bend", "taper", "morph", "seam", "group"])

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

    /**
     * Parse JavaScript/TypeScript code and extract all shape function calls with their arguments
     * @param src JavaScript/TypeScript source code
     * @returns Array of parsed shape calls
     */
    parseShapeCalls(src: string): ParsedShapeCall[] {
        const calls: ParsedShapeCall[] = []
        const sourceFile = parseSource(src)
        this.#callNodeMap.clear()
        this.#callMap.clear()

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

        console.debug(`[SourceParser] Found ${calls.length} shape call(s)`)

        return calls
    }

    /**
     * Resolve a composite ParsedShapeCall to its logical leaf calls by tracing through
     * variable references in the TypeScript AST.
     *
     * For inline code: `union(sphere(...), box(...))` → [sphere_call, box_call]
     * For variable code: `const s=sphere(...); union(s, box(...))` → [sphere_call, box_call]
     *
     * Recurses through CSG_PASSTHROUGH_FUNCTIONS; stops at primitives and rendering composites
     * (extrude, loft, lathe, rotate) which are treated as leaves.
     */
    resolveLogicalLeafCalls(compositeCall: ParsedShapeCall): ParsedShapeCall[] {
        const results: ParsedShapeCall[] = []
        const visited = new Set<number>()

        const resolve = (call: ParsedShapeCall) => {
            if (visited.has(call.callStart)) return
            visited.add(call.callStart)

            if (!CSG_PASSTHROUGH_FUNCTIONS.has(call.functionName)) {
                // Leaf: primitive or rendering composite (extrude, rotate, etc.)
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
        if (ts.isCallExpression(arg) && ts.isIdentifier(arg.expression)) {
            const funcName = arg.expression.text
            if (ALL_SHAPE_FUNCTIONS.has(funcName)) {
                const callStart = arg.getStart() - WRAP_PREFIX_CHARS
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
        if (!ts.isIdentifier(callNode.expression)) return

        const funcName = callNode.expression.text
        if (!ALL_SHAPE_FUNCTIONS.has(funcName)) return

        const startPos = callNode.expression.getStart()
        const endPos = callNode.expression.getEnd()
        const startLoc = tsPosToUser(sourceFile, startPos)
        const endLoc = tsPosToUser(sourceFile, endPos)

        const callStart = callNode.getStart() - WRAP_PREFIX_CHARS
        this.#callNodeMap.set(callStart, callNode)

        const parsedCall: ParsedShapeCall = {
            functionName: funcName,
            callStart,
            callEnd: callNode.getEnd() - WRAP_PREFIX_CHARS,
            location: {
                startLine: startLoc.line,
                startColumn: startLoc.column,
                endLine: endLoc.line,
                endColumn: endLoc.column,
                functionName: funcName
            }
        }

        if (funcName === "sphere" || funcName === "disc") {
            this.parseSphereArgs(callNode, parsedCall)
        } else if (funcName === "box") {
            this.parseBoxArgs(callNode, parsedCall)
        } else if (funcName === "cylinder" || funcName === "cone" || funcName === "hexprism") {
            this.parsePosRadiusHeightArgs(callNode, parsedCall)
        } else if (funcName === "torus") {
            this.parseTorusArgs(callNode, parsedCall)
        } else if (funcName === "capsule") {
            this.parseCapsuleArgs(callNode, parsedCall)
        } else if (funcName === "plane") {
            this.parsePlaneArgs(callNode, parsedCall)
        } else if (funcName === "blob") {
            this.parseBlobArgs(callNode, parsedCall)
        } else if (funcName === "polygon2d") {
            this.parsePolygon2DArgs(callNode, parsedCall)
        } else if (funcName === "extrude" || funcName === "loft") {
            this.parseExtrudeLoftArgs(callNode, parsedCall)
        }

        calls.push(parsedCall)
        this.#callMap.set(callStart, parsedCall)
    }

    private parseSphereArgs(callNode: ts.CallExpression, parsedCall: ParsedShapeCall): void {
        try {
            const args = callNode.arguments
            if (args.length >= 1) {
                const posValue = this.evaluateExpression(args[0])
                if (posValue !== undefined) parsedCall.pos = vec3(posValue as Vec3)
            }
            if (args.length >= 2 && ts.isObjectLiteralExpression(args[1])) {
                for (const prop of args[1].properties) {
                    if (ts.isPropertyAssignment(prop)) {
                        const key = this.getPropertyKey(prop)
                        const value = this.evaluateExpression(prop.initializer)
                        if (key === "r" && typeof value === "number") parsedCall.r = value
                        else if (key === "d" && typeof value === "number") parsedCall.d = value
                    }
                }
            }
        } catch (err) {
            console.debug(`[SourceParser] Could not parse sphere args:`, err)
        }
    }

    private parseBoxArgs(callNode: ts.CallExpression, parsedCall: ParsedShapeCall): void {
        try {
            const args = callNode.arguments
            if (args.length >= 1) {
                const posValue = this.evaluateExpression(args[0])
                if (posValue !== undefined) parsedCall.pos = vec3(posValue as Vec3)
            }
            if (args.length >= 2) {
                const sizeValue = this.evaluateExpression(args[1])
                if (sizeValue !== undefined) parsedCall.size = vec3(sizeValue as Vec3)
            }
        } catch (err) {
            console.debug(`[SourceParser] Could not parse box args:`, err)
        }
    }

    private parsePosRadiusHeightArgs(callNode: ts.CallExpression, parsedCall: ParsedShapeCall): void {
        try {
            const args = callNode.arguments
            if (args.length >= 1) {
                const posValue = this.evaluateExpression(args[0])
                if (posValue !== undefined) parsedCall.pos = vec3(posValue as Vec3)
            }
            if (args.length >= 2 && ts.isObjectLiteralExpression(args[1])) {
                for (const prop of args[1].properties) {
                    if (ts.isPropertyAssignment(prop)) {
                        const key = this.getPropertyKey(prop)
                        const value = this.evaluateExpression(prop.initializer)
                        if (key === "r" && typeof value === "number") parsedCall.r = value
                        else if (key === "d" && typeof value === "number") parsedCall.d = value
                        else if (key === "h" && typeof value === "number") parsedCall.h = value
                    }
                }
            }
        } catch (err) {
            console.debug(`[SourceParser] Could not parse ${parsedCall.functionName} args:`, err)
        }
    }

    private parseTorusArgs(callNode: ts.CallExpression, parsedCall: ParsedShapeCall): void {
        try {
            const args = callNode.arguments
            if (args.length >= 1) {
                const posValue = this.evaluateExpression(args[0])
                if (posValue !== undefined) parsedCall.pos = vec3(posValue as Vec3)
            }
            if (args.length >= 2 && ts.isObjectLiteralExpression(args[1])) {
                for (const prop of args[1].properties) {
                    if (ts.isPropertyAssignment(prop)) {
                        const key = this.getPropertyKey(prop)
                        const value = this.evaluateExpression(prop.initializer)
                        if (key === "sr" && typeof value === "number") parsedCall.sr = value
                        else if (key === "lr" && typeof value === "number") parsedCall.lr = value
                    }
                }
            }
        } catch (err) {
            console.debug(`[SourceParser] Could not parse torus args:`, err)
        }
    }

    private parseCapsuleArgs(callNode: ts.CallExpression, parsedCall: ParsedShapeCall): void {
        try {
            const args = callNode.arguments
            if (args.length >= 1) {
                const posValue = this.evaluateExpression(args[0])
                if (posValue !== undefined) parsedCall.pos = vec3(posValue as Vec3)
            }
            if (args.length >= 2 && ts.isObjectLiteralExpression(args[1])) {
                for (const prop of args[1].properties) {
                    if (ts.isPropertyAssignment(prop)) {
                        const key = this.getPropertyKey(prop)
                        const value = this.evaluateExpression(prop.initializer)
                        if (key === "r" && typeof value === "number") parsedCall.r = value
                        else if (key === "d" && typeof value === "number") parsedCall.d = value
                        else if (key === "c" && typeof value === "number") parsedCall.c = value
                    }
                }
            }
        } catch (err) {
            console.debug(`[SourceParser] Could not parse capsule args:`, err)
        }
    }

    private parsePlaneArgs(callNode: ts.CallExpression, parsedCall: ParsedShapeCall): void {
        try {
            const args = callNode.arguments
            if (args.length >= 1) {
                const posValue = this.evaluateExpression(args[0])
                if (posValue !== undefined) parsedCall.pos = vec3(posValue as Vec3)
            }
            if (args.length >= 2 && ts.isObjectLiteralExpression(args[1])) {
                for (const prop of args[1].properties) {
                    if (ts.isPropertyAssignment(prop)) {
                        const key = this.getPropertyKey(prop)
                        if (key === "n") {
                            const value = this.evaluateExpression(prop.initializer)
                            if (value !== undefined) parsedCall.normal = vec3(value as Vec3)
                        } else if (key === "dist") {
                            const value = this.evaluateExpression(prop.initializer)
                            if (typeof value === "number") parsedCall.planeOffset = value
                        }
                    }
                }
            }
        } catch (err) {
            console.debug(`[SourceParser] Could not parse plane args:`, err)
        }
    }

    private parseBlobArgs(callNode: ts.CallExpression, parsedCall: ParsedShapeCall): void {
        try {
            if (callNode.arguments.length >= 1) {
                const posValue = this.evaluateExpression(callNode.arguments[0])
                if (posValue !== undefined) parsedCall.pos = vec3(posValue as Vec3)
            }
        } catch (err) {
            console.debug(`[SourceParser] Could not parse blob args:`, err)
        }
    }

    private parseExtrudeLoftArgs(callNode: ts.CallExpression, parsedCall: ParsedShapeCall): void {
        try {
            const args = callNode.arguments
            if (args.length < 2) return

            const firstArg = args[0]
            if (this.isPositionArg(firstArg)) {
                const posValue = this.evaluateExpression(firstArg)
                if (posValue !== undefined) parsedCall.pos = vec3(posValue as Vec3)
            }

            const optsArg = args[args.length - 1]
            if (ts.isObjectLiteralExpression(optsArg)) {
                for (const prop of optsArg.properties) {
                    if (ts.isPropertyAssignment(prop)) {
                        const key = this.getPropertyKey(prop)
                        const value = this.evaluateExpression(prop.initializer)
                        if (key === "h" && typeof value === "number") parsedCall.h = value
                        else if (key === "t" && typeof value === "number") parsedCall.t = value
                    }
                }
            }
        } catch (err) {
            console.debug(`[SourceParser] Could not parse extrude/loft args:`, err)
        }
    }

    private parsePolygon2DArgs(callNode: ts.CallExpression, parsedCall: ParsedShapeCall): void {
        try {
            if (callNode.arguments.length >= 1 && ts.isArrayLiteralExpression(callNode.arguments[0])) {
                const vertices = this.evaluateVertexArray(callNode.arguments[0])
                if (vertices) parsedCall.vertices = vertices
            }
        } catch (err) {
            console.debug(`[SourceParser] Could not parse polygon2d args:`, err)
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

    findPolygon2DAtPosition(src: string, line: number, column: number): Polygon2DCallInfo | null {
        const offset = this.positionToOffset(src, line, column)
        const calls: Polygon2DCallInfo[] = []

        const sourceFile = parseSource(src)

        const visit = (node: ts.Node) => {
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "polygon2d") {
                const info = this.extractPolygon2DInfo(node, sourceFile)
                if (info) calls.push(info)
            }
            ts.forEachChild(node, visit)
        }
        visit(sourceFile)

        for (const call of calls) {
            if (offset >= call.callStartOffset && offset <= call.callEndOffset) {
                return call
            }
        }
        return null
    }

    private positionToOffset(src: string, line: number, column: number): number {
        const lines = src.split("\n")
        let offset = 0
        for (let i = 0; i < line - 1 && i < lines.length; i++) {
            offset += lines[i].length + 1
        }
        offset += column - 1
        return offset
    }

    private extractPolygon2DInfo(callNode: ts.CallExpression, sourceFile: ts.SourceFile): Polygon2DCallInfo | null {
        if (callNode.arguments.length < 1) return null

        const arrayArg = callNode.arguments[0]
        if (!ts.isArrayLiteralExpression(arrayArg)) return null

        const vertices = this.evaluateVertexArray(arrayArg)
        if (!vertices) return null

        const startPos = callNode.expression.getStart()
        const loc = tsPosToUser(sourceFile, startPos)
        const endLoc = tsPosToUser(sourceFile, callNode.expression.getEnd())

        return {
            callStartOffset: callNode.getStart() - WRAP_PREFIX_CHARS,
            callEndOffset: callNode.getEnd() - WRAP_PREFIX_CHARS,
            arrayStartOffset: arrayArg.getStart() - WRAP_PREFIX_CHARS,
            arrayEndOffset: arrayArg.getEnd() - WRAP_PREFIX_CHARS,
            vertices,
            location: {
                startLine: loc.line,
                startColumn: loc.column,
                endLine: endLoc.line,
                endColumn: endLoc.column,
                functionName: "polygon2d"
            }
        }
    }

    findExtrudeLoftAtPosition(src: string, line: number, column: number): ExtrudeLoftCallInfo | null {
        const calls: ExtrudeLoftCallInfo[] = []

        const sourceFile = parseSource(src)

        const visit = (node: ts.Node) => {
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
                const name = node.expression.text
                if (name === "extrude" || name === "loft") {
                    const info = this.extractExtrudeLoftInfo(node, name as "extrude" | "loft", sourceFile)
                    if (info) calls.push(info)
                }
            }
            ts.forEachChild(node, visit)
        }
        visit(sourceFile)

        for (const call of calls) {
            if (call.location.startLine === line && call.location.startColumn === column) {
                return call
            }
        }
        return calls.length === 1 ? calls[0] : null
    }

    private extractExtrudeLoftInfo(
        callNode: ts.CallExpression,
        name: "extrude" | "loft",
        sourceFile: ts.SourceFile
    ): ExtrudeLoftCallInfo | null {
        const args = callNode.arguments
        if (args.length < 2) return null

        const optsArg = args[args.length - 1]
        if (!ts.isObjectLiteralExpression(optsArg)) return null

        let hValueStart: number | null = null
        let hValueEnd: number | null = null

        for (const prop of optsArg.properties) {
            if (ts.isPropertyAssignment(prop) && this.getPropertyKey(prop) === "h") {
                hValueStart = prop.initializer.getStart() - WRAP_PREFIX_CHARS
                hValueEnd = prop.initializer.getEnd() - WRAP_PREFIX_CHARS
                break
            }
        }

        if (hValueStart === null || hValueEnd === null) return null

        let posArgStart: number | null = null
        let posArgEnd: number | null = null
        const firstArg = args[0]
        if (this.isPositionArg(firstArg)) {
            posArgStart = firstArg.getStart() - WRAP_PREFIX_CHARS
            posArgEnd = firstArg.getEnd() - WRAP_PREFIX_CHARS
        }

        const insertPosOffset = args[0].getStart() - WRAP_PREFIX_CHARS

        const startPos = callNode.expression.getStart()
        const loc = tsPosToUser(sourceFile, startPos)
        const endLoc = tsPosToUser(sourceFile, callNode.expression.getEnd())

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
