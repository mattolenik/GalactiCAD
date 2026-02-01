/**
 * Node Matcher - Match scene nodes to source code by comparing property values
 * 
 * This provides a robust way to link scene objects to their source code by
 * comparing the actual property values (position, size, radius) rather than
 * relying on traversal order or stack traces.
 */

import { Node, Sphere, Box } from "../scene/scene.mjs"
import { vec3 } from "../vecmat/vector.mjs"
import type { ParsedShapeCall, SourceLocation } from "./source-parser.mjs"

/**
 * Tolerance for floating-point comparisons
 */
const EPSILON = 1e-6

/**
 * Check if two numbers are approximately equal
 */
function approxEqual(a: number, b: number): boolean {
    return Math.abs(a - b) < EPSILON
}

/**
 * Check if two Vec3f values are approximately equal
 */
function vec3ApproxEqual(a: { x: number, y: number, z: number }, b: { x: number, y: number, z: number }): boolean {
    return approxEqual(a.x, b.x) && approxEqual(a.y, b.y) && approxEqual(a.z, b.z)
}

/**
 * Try to match a scene node to a parsed shape call
 * Returns true if the node's properties match the parsed call's arguments
 */
function matchNodeToCall(node: Node, call: ParsedShapeCall): boolean {
    const shapeType = node.getShapeType()
    
    if (shapeType !== call.functionName) {
        return false
    }
    
    if (node instanceof Sphere) {
        // Match sphere: position and radius must match
        if (!call.pos) return false
        
        // Check position
        if (!vec3ApproxEqual(node.pos, call.pos)) {
            return false
        }
        
        // Check radius (can be specified as r or d)
        const expectedRadius = call.r ?? (call.d !== undefined ? call.d / 2 : undefined)
        if (expectedRadius === undefined) return false
        
        if (!approxEqual(node.r, expectedRadius)) {
            return false
        }
        
        return true
    }
    
    if (node instanceof Box) {
        // Match box: position and size must match
        if (!call.pos || !call.size) return false
        
        // Check position
        if (!vec3ApproxEqual(node.pos, call.pos)) {
            return false
        }
        
        // Check size
        if (!vec3ApproxEqual(node.size, call.size)) {
            return false
        }
        
        return true
    }
    
    // For composite types (union, subtract, group), we can't match by properties
    // since they don't have unique identifying values
    // These would need a different approach (e.g., matching by structure)
    return false
}

/**
 * Match scene nodes to parsed shape calls and create a source location map.
 * 
 * This function takes all nodes from the scene and all parsed shape calls,
 * and tries to match them by comparing property values.
 * 
 * @param nodes All nodes from the scene
 * @param calls All parsed shape calls from the source code
 * @returns Map from node ID to source location
 */
export function matchNodesToSource(
    nodes: Node[],
    calls: ParsedShapeCall[]
): Map<number, SourceLocation> {
    const result = new Map<number, SourceLocation>()
    
    // Track which calls have been matched to avoid duplicate matches
    const matchedCalls = new Set<ParsedShapeCall>()
    
    for (const node of nodes) {
        // Find a matching call for this node
        for (const call of calls) {
            if (matchedCalls.has(call)) continue
            
            if (matchNodeToCall(node, call)) {
                result.set(node.id, call.location)
                matchedCalls.add(call)
                console.debug(`[NodeMatcher] Matched node ${node.id} (${node.getShapeType()}) to ${call.functionName} at line ${call.location.startLine}`)
                break
            }
        }
    }
    
    console.debug(`[NodeMatcher] Matched ${result.size}/${nodes.length} nodes`)
    
    return result
}
