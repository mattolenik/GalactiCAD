/**
 * Source Parser - Parse JavaScript code to extract shape function calls with their arguments
 * Uses Acorn parser to create AST, then matches calls to scene nodes by property values
 */

import { parse, type Node as AcornNode, type CallExpression, type FunctionDeclaration, type ReturnStatement, type BlockStatement } from "acorn"
import { vec3, Vec3f } from "../vecmat/vector.mjs"

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
    // Parsed argument values for matching
    pos?: Vec3f       // Position for sphere/box
    size?: Vec3f      // Size for box
    r?: number        // Radius for sphere
    d?: number        // Diameter for sphere (alternative to r)
}

/**
 * Mapping from scene node index to source location
 */
export type SourceLocationMap = Map<number, SourceLocation>

/**
 * Shape functions we care about for source location tracking
 */
const PRIMITIVE_FUNCTIONS = new Set(["sphere", "box"])
const COMPOSITE_FUNCTIONS = new Set(["union", "subtract", "group"])
const ALL_SHAPE_FUNCTIONS = new Set([...PRIMITIVE_FUNCTIONS, ...COMPOSITE_FUNCTIONS])

/**
 * Parser for extracting source locations from CAD code
 */
export class SourceParser {
    /**
     * Parse JavaScript code and extract all shape function calls with their arguments
     * @param src JavaScript source code
     * @returns Array of parsed shape calls
     */
    parseShapeCalls(src: string): ParsedShapeCall[] {
        const calls: ParsedShapeCall[] = []
        
        try {
            const ast = parse(src, {
                ecmaVersion: "latest",
                sourceType: "script",
                locations: true,
                ranges: true
            })
            
            // Walk the entire AST to find all shape function calls
            this.walkNode(ast, calls)
            
            console.debug(`[SourceParser] Found ${calls.length} shape call(s)`)
            
        } catch (err) {
            console.warn("[SourceParser] Failed to parse source code:", err)
        }
        
        return calls
    }
    
    /**
     * Walk AST node recursively to find all shape function calls
     */
    private walkNode(node: AcornNode, calls: ParsedShapeCall[]): void {
        if (!node || typeof node !== "object") return
        
        if (node.type === "CallExpression") {
            const callNode = node as CallExpression
            this.processCallExpression(callNode, calls)
        }
        
        // Recursively walk all properties
        for (const key of Object.keys(node)) {
            if (key === "type" || key === "loc" || key === "range" || key === "start" || key === "end") continue
            const value = (node as any)[key]
            if (Array.isArray(value)) {
                for (const item of value) {
                    if (item && typeof item === "object" && item.type) {
                        this.walkNode(item, calls)
                    }
                }
            } else if (value && typeof value === "object" && value.type) {
                this.walkNode(value, calls)
            }
        }
    }
    
    /**
     * Process a CallExpression to extract shape function info
     */
    private processCallExpression(callNode: CallExpression, calls: ParsedShapeCall[]): void {
        // Only handle direct identifier calls (e.g., sphere(...), not obj.sphere(...))
        if (callNode.callee.type !== "Identifier") return
        
        const funcName = callNode.callee.name
        if (!ALL_SHAPE_FUNCTIONS.has(funcName)) return
        
        const loc = callNode.callee.loc
        if (!loc) return
        
        const parsedCall: ParsedShapeCall = {
            functionName: funcName,
            location: {
                startLine: loc.start.line,
                startColumn: loc.start.column + 1, // Acorn is 0-based, Monaco is 1-based
                endLine: loc.end.line,
                endColumn: loc.end.column + 1,
                functionName: funcName
            }
        }
        
        // Extract arguments for primitives
        if (funcName === "sphere") {
            this.parseSphereArgs(callNode, parsedCall)
        } else if (funcName === "box") {
            this.parseBoxArgs(callNode, parsedCall)
        }
        
        calls.push(parsedCall)
    }
    
    /**
     * Parse sphere(pos, {r?, d?}) arguments
     */
    private parseSphereArgs(callNode: CallExpression, parsedCall: ParsedShapeCall): void {
        try {
            // First arg: position (string like "1 2 3" or array)
            if (callNode.arguments.length >= 1) {
                const posArg = callNode.arguments[0]
                const posValue = this.evaluateExpression(posArg)
                if (posValue !== undefined) {
                    parsedCall.pos = vec3(posValue)
                }
            }
            
            // Second arg: {r?, d?}
            if (callNode.arguments.length >= 2) {
                const optionsArg = callNode.arguments[1]
                if (optionsArg.type === "ObjectExpression") {
                    for (const prop of (optionsArg as any).properties) {
                        if (prop.type === "Property" && prop.key.type === "Identifier") {
                            const key = prop.key.name
                            const value = this.evaluateExpression(prop.value)
                            if (key === "r" && typeof value === "number") {
                                parsedCall.r = value
                            } else if (key === "d" && typeof value === "number") {
                                parsedCall.d = value
                            }
                        }
                    }
                }
            }
        } catch (err) {
            console.debug(`[SourceParser] Could not parse sphere args:`, err)
        }
    }
    
    /**
     * Parse box(pos, size) arguments
     */
    private parseBoxArgs(callNode: CallExpression, parsedCall: ParsedShapeCall): void {
        try {
            // First arg: position
            if (callNode.arguments.length >= 1) {
                const posArg = callNode.arguments[0]
                const posValue = this.evaluateExpression(posArg)
                if (posValue !== undefined) {
                    parsedCall.pos = vec3(posValue)
                }
            }
            
            // Second arg: size
            if (callNode.arguments.length >= 2) {
                const sizeArg = callNode.arguments[1]
                const sizeValue = this.evaluateExpression(sizeArg)
                if (sizeValue !== undefined) {
                    parsedCall.size = vec3(sizeValue)
                }
            }
        } catch (err) {
            console.debug(`[SourceParser] Could not parse box args:`, err)
        }
    }
    
    /**
     * Try to evaluate an AST expression to a value
     * Handles: string literals, number literals, arrays, unary minus
     */
    private evaluateExpression(node: AcornNode): any {
        if (!node) return undefined
        
        switch (node.type) {
            case "Literal":
                return (node as any).value
                
            case "ArrayExpression": {
                const elements = (node as any).elements
                const result: number[] = []
                for (const elem of elements) {
                    const val = this.evaluateExpression(elem)
                    if (typeof val !== "number") return undefined
                    result.push(val)
                }
                return result
            }
            
            case "UnaryExpression": {
                const unary = node as any
                if (unary.operator === "-") {
                    const arg = this.evaluateExpression(unary.argument)
                    if (typeof arg === "number") return -arg
                } else if (unary.operator === "+") {
                    return this.evaluateExpression(unary.argument)
                }
                return undefined
            }
            
            case "TemplateLiteral": {
                // Handle simple template literals like `1 2 3`
                const templ = node as any
                if (templ.expressions.length === 0 && templ.quasis.length === 1) {
                    return templ.quasis[0].value.cooked
                }
                return undefined
            }
            
            default:
                return undefined
        }
    }
}

/**
 * Singleton instance for global use
 */
export const sourceParser = new SourceParser()
