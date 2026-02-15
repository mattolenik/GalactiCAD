/**
 * Node Matcher - Match scene nodes to source code by comparing property values
 * 
 * This provides a robust way to link scene objects to their source code by
 * comparing the actual property values (position, size, radius) rather than
 * relying on traversal order or stack traces.
 * 
 * For composite types (union, subtract, group), matching is done by type name
 * and source order since they don't have unique identifying properties.
 */

import { Node, Sphere, Box, Union, Subtract, Intersect, Pipe, Engrave, Groove, Tongue, Shell, Offset, Elongate, Twist, Bend, Taper, Morph, Seam, Group, Cylinder, Cone, Torus, Capsule, PlaneNode, HexPrism, Disc, Blob, Rotate } from "../scene/scene.mjs"
import { vec3 } from "../vecmat/vector.mjs"
import type { ParsedShapeCall, SourceLocation } from "./source-parser.mjs"

/** Composite shape types that are matched by name only */
const COMPOSITE_TYPES = new Set(["union", "subtract", "intersect", "pipe", "engrave", "groove", "tongue", "shell", "offset", "elongate", "twist", "bend", "taper", "morph", "seam", "group", "rotate"])

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

    if (node instanceof Cylinder) {
        if (!call.pos) return false
        if (!vec3ApproxEqual(node.pos, call.pos)) return false
        const expectedRadius = call.r ?? (call.d !== undefined ? call.d / 2 : undefined)
        if (expectedRadius === undefined) return false
        if (!approxEqual(node.r, expectedRadius)) return false
        if (call.h !== undefined && !approxEqual(node.h, call.h)) return false
        return true
    }

    if (node instanceof Cone) {
        if (!call.pos) return false
        if (!vec3ApproxEqual(node.pos, call.pos)) return false
        const expectedRadius = call.r ?? (call.d !== undefined ? call.d / 2 : undefined)
        if (expectedRadius === undefined) return false
        if (!approxEqual(node.r, expectedRadius)) return false
        if (call.h !== undefined && !approxEqual(node.h, call.h)) return false
        return true
    }

    if (node instanceof Torus) {
        if (!call.pos) return false
        if (!vec3ApproxEqual(node.pos, call.pos)) return false
        if (call.sr !== undefined && !approxEqual(node.sr, call.sr)) return false
        if (call.lr !== undefined && !approxEqual(node.lr, call.lr)) return false
        return true
    }

    if (node instanceof Capsule) {
        if (!call.pos) return false
        if (!vec3ApproxEqual(node.pos, call.pos)) return false
        const expectedRadius = call.r ?? (call.d !== undefined ? call.d / 2 : undefined)
        if (expectedRadius === undefined) return false
        if (!approxEqual(node.r, expectedRadius)) return false
        if (call.c !== undefined && !approxEqual(node.c, call.c)) return false
        return true
    }

    if (node instanceof PlaneNode) {
        if (!call.pos) return false
        if (!vec3ApproxEqual(node.pos, call.pos)) return false
        if (call.normal && !vec3ApproxEqual(node.normal, call.normal)) return false
        if (call.planeOffset !== undefined && !approxEqual(node.dist, call.planeOffset)) return false
        return true
    }

    if (node instanceof HexPrism) {
        if (!call.pos) return false
        if (!vec3ApproxEqual(node.pos, call.pos)) return false
        const expectedRadius = call.r ?? (call.d !== undefined ? call.d / 2 : undefined)
        if (expectedRadius === undefined) return false
        if (!approxEqual(node.r, expectedRadius)) return false
        if (call.h !== undefined && !approxEqual(node.h, call.h)) return false
        return true
    }

    if (node instanceof Disc) {
        if (!call.pos) return false
        if (!vec3ApproxEqual(node.pos, call.pos)) return false
        const expectedRadius = call.r ?? (call.d !== undefined ? call.d / 2 : undefined)
        if (expectedRadius === undefined) return false
        if (!approxEqual(node.r, expectedRadius)) return false
        return true
    }

    if (node instanceof Blob) {
        if (!call.pos) return false
        if (!vec3ApproxEqual(node.pos, call.pos)) return false
        return true
    }
    
    // For composite types (union, subtract, group), match by type name only.
    // Since they don't have unique identifying properties, we match them
    // in source order (first union node matches first union call, etc.)
    if (COMPOSITE_TYPES.has(shapeType)) {
        return true  // Type already matched above
    }
    
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
