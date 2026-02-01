/**
 * Source Parser - Parse JavaScript code to extract source locations of CAD shapes
 * Uses Acorn parser to create AST with source locations
 */

import { parse, type Node as AcornNode, type CallExpression, type FunctionDeclaration, type ReturnStatement, type BlockStatement, type ExpressionStatement } from "acorn"

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
 * Mapping from scene node index to source location
 * Index corresponds to the order shapes are created (same as node IDs)
 */
export type SourceLocationMap = Map<number, SourceLocation>

/**
 * Shape functions we care about for source location tracking
 */
const SHAPE_FUNCTIONS = new Set([
    "sphere",
    "box",
    "union",
    "subtract",
    "group"
])

/**
 * Check if a CallExpression is a shape function call
 */
function isShapeFunctionCall(node: CallExpression): boolean {
    // Handle: sphere(...), box(...), union(...), subtract(...), group(...)
    if (node.callee.type === "Identifier") {
        return SHAPE_FUNCTIONS.has(node.callee.name)
    }
    
    // Handle method calls like something.union(...) - not a top-level shape
    // We only want the actual shape constructor calls
    return false
}

/**
 * Parser for extracting source locations from CAD code
 */
export class SourceParser {
    /**
     * Parse JavaScript code and extract source locations of shape function calls
     * Walks the AST in scene graph build order: depth-first, parent before children
     * @param src JavaScript source code
     * @returns Map from node index (0, 1, 2...) to source location
     */
    parse(src: string): SourceLocationMap {
        const locations: SourceLocationMap = new Map()
        
        try {
            const ast = parse(src, {
                ecmaVersion: "latest",
                sourceType: "script",
                locations: true,
                ranges: true
            })
            
            // Step 1: Find the scene() function declaration
            const sceneFunction = this.findSceneFunction(ast)
            if (!sceneFunction) {
                console.debug("[SourceParser] No scene() function found")
                return locations
            }
            
            // Step 2: Find the return statement within scene()
            const returnStmt = this.findReturnStatement(sceneFunction)
            if (!returnStmt) {
                console.debug("[SourceParser] No return statement found in scene()")
                return locations
            }
            
            // Step 3: Walk the return expression depth-first and collect CallExpressions
            let nodeIndex = 0
            if (returnStmt.argument) {
                this.walkExpressionDepthFirst(returnStmt.argument, locations, () => {
                    const current = nodeIndex
                    nodeIndex++
                    return current
                })
            }
            
            // Log debug message with count of found locations
            if (locations.size > 0) {
                console.debug(`[SourceParser] Found ${locations.size} shape function location(s)`)
            }
            
        } catch (err) {
            // If parsing fails (syntax error), return empty map
            // The build will fail anyway and user will fix the syntax
            console.warn("Failed to parse source code for location tracking:", err)
        }
        
        return locations
    }
    
    /**
     * Find the scene() function declaration in the AST
     */
    private findSceneFunction(ast: AcornNode): FunctionDeclaration | null {
        // The top-level is usually a Program node with body array
        const body = (ast as any).body
        if (!Array.isArray(body)) {
            return null
        }
        
        for (const node of body) {
            if (node.type === "FunctionDeclaration" && node.id?.name === "scene") {
                return node as FunctionDeclaration
            }
        }
        
        return null
    }
    
    /**
     * Find the return statement within a function
     */
    private findReturnStatement(func: FunctionDeclaration): ReturnStatement | null {
        const body = func.body
        if (body.type !== "BlockStatement") {
            return null
        }
        
        // Look for return statement in the function body
        for (const stmt of body.body) {
            if (stmt.type === "ReturnStatement") {
                return stmt as ReturnStatement
            }
        }
        
        return null
    }
    
    /**
     * Walk an expression depth-first, matching JavaScript evaluation order
     * For CallExpression: visit arguments left-to-right first, then callee
     * This matches how JS evaluates args before the function call
     */
    private walkExpressionDepthFirst(
        node: AcornNode,
        locations: SourceLocationMap,
        incrementIndex: () => number
    ): void {
        switch (node.type) {
            case "CallExpression": {
                const callNode = node as CallExpression
                
                // Visit arguments first (left-to-right, as JavaScript evaluates args before the call)
                for (const arg of callNode.arguments) {
                    this.walkExpressionDepthFirst(arg, locations, incrementIndex)
                }
                
                // Then record the callee (parent)
                if (isShapeFunctionCall(callNode) && callNode.callee.type === "Identifier") {
                    const loc = callNode.callee.loc
                    if (loc) {
                        const index = incrementIndex()
                        locations.set(index, {
                            startLine: loc.start.line,
                            startColumn: loc.start.column + 1, // Acorn is 0-based, Monaco is 1-based
                            endLine: loc.end.line,
                            endColumn: loc.end.column + 1,
                            functionName: callNode.callee.name
                        })

                    }
                }
                break
            }
            
            case "Identifier":
                // Variable references - don't record, but might be used as args
                break
                
            case "Literal":
                // Literals - no shapes here
                break
                
            case "ArrayExpression":
                // Arrays might contain shapes
                for (const elem of (node as any).elements || []) {
                    if (elem) {
                        this.walkExpressionDepthFirst(elem, locations, incrementIndex)
                    }
                }
                break
                
            case "ObjectExpression":
                // Objects might contain shapes in properties
                for (const prop of (node as any).properties || []) {
                    if (prop.value) {
                        this.walkExpressionDepthFirst(prop.value, locations, incrementIndex)
                    }
                }
                break
                
            case "MemberExpression":
                // member.expression.something - walk the object part
                if ((node as any).object) {
                    this.walkExpressionDepthFirst((node as any).object, locations, incrementIndex)
                }
                break
                
            case "ConditionalExpression":
                // condition ? consequent : alternate
                if ((node as any).test) {
                    this.walkExpressionDepthFirst((node as any).test, locations, incrementIndex)
                }
                if ((node as any).consequent) {
                    this.walkExpressionDepthFirst((node as any).consequent, locations, incrementIndex)
                }
                if ((node as any).alternate) {
                    this.walkExpressionDepthFirst((node as any).alternate, locations, incrementIndex)
                }
                break
                
            case "BinaryExpression":
            case "LogicalExpression":
                // left op right
                if ((node as any).left) {
                    this.walkExpressionDepthFirst((node as any).left, locations, incrementIndex)
                }
                if ((node as any).right) {
                    this.walkExpressionDepthFirst((node as any).right, locations, incrementIndex)
                }
                break
                
            case "UnaryExpression":
            case "UpdateExpression":
                // op argument
                if ((node as any).argument) {
                    this.walkExpressionDepthFirst((node as any).argument, locations, incrementIndex)
                }
                break
                
            case "SequenceExpression":
                // (a, b, c)
                for (const expr of (node as any).expressions || []) {
                    this.walkExpressionDepthFirst(expr, locations, incrementIndex)
                }
                break
                
            case "ArrowFunctionExpression":
            case "FunctionExpression":
                // Inline functions - walk the body
                if ((node as any).body) {
                    this.walkExpressionDepthFirst((node as any).body, locations, incrementIndex)
                }
                break
                
            case "BlockStatement": {
                // Block statement - look for return
                const blockBody = (node as BlockStatement).body
                for (const stmt of blockBody) {
                    if (stmt.type === "ReturnStatement" && stmt.argument) {
                        this.walkExpressionDepthFirst(stmt.argument, locations, incrementIndex)
                    } else if (stmt.type === "ExpressionStatement") {
                        this.walkExpressionDepthFirst((stmt as ExpressionStatement).expression, locations, incrementIndex)
                    }
                }
                break
            }
                
            case "SpreadElement":
                // ...expr
                if ((node as any).argument) {
                    this.walkExpressionDepthFirst((node as any).argument, locations, incrementIndex)
                }
                break
                
            default:
                // Unknown node type - try to walk common properties
                if ((node as any).expression) {
                    this.walkExpressionDepthFirst((node as any).expression, locations, incrementIndex)
                }
                break
        }
    }
}

/**
 * Singleton instance for global use
 */
export const sourceParser = new SourceParser()
