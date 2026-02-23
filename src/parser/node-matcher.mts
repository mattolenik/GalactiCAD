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

import { Node, Sphere, Box, Union, Subtract, Intersect, Pipe, Engrave, Groove, Tongue, Shell, Offset, Elongate, Twist, Bend, Taper, Morph, Seam, Group, Cylinder, Cone, Torus, Capsule, PlaneNode, HexPrism, Disc, Blob, Rotate, Polygon2D, Extrude, Loft, Lathe } from "../scene/scene.mjs"
import { vec3 } from "../vecmat/vector.mjs"
import type { ParsedShapeCall, SourceLocation } from "./source-parser.mjs"

/** Composite shape types that are matched by name only */
const COMPOSITE_TYPES = new Set(["union", "subtract", "intersect", "pipe", "engrave", "groove", "tongue", "shell", "offset", "elongate", "twist", "bend", "taper", "morph", "seam", "group", "rotate", "extrude", "loft", "lathe"])

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

    if (node instanceof Polygon2D) {
        // Match polygon2d by comparing vertex arrays
        if (!call.vertices) return false
        if (node.vertices.length !== call.vertices.length) return false
        for (let i = 0; i < node.vertices.length; i++) {
            if (!approxEqual(node.vertices[i][0], call.vertices[i][0])) return false
            if (!approxEqual(node.vertices[i][1], call.vertices[i][1])) return false
        }
        return true
    }

    if (node instanceof Extrude) {
        if (call.h === undefined) return false
        if (!approxEqual(node.h, call.h)) return false
        if (call.pos !== undefined && !vec3ApproxEqual(node.pos, call.pos)) return false
        const callTwist = call.t ?? 0
        if (!approxEqual(node.twist, callTwist)) return false
        return true
    }

    if (node instanceof Loft) {
        if (call.h === undefined) return false
        if (!approxEqual(node.h, call.h)) return false
        if (call.pos !== undefined && !vec3ApproxEqual(node.pos, call.pos)) return false
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
 * Alignment: The TypeScript parser processes parent call expressions BEFORE their
 * children (processCallExpression runs before ts.forEachChild), so calls come out
 * in the same top-down order as scene build (parent nodes before child nodes).
 * A simple first-unmatched scan therefore aligns both correctly for all node types.
 */
export function matchNodesToSource(
    nodes: Node[],
    calls: ParsedShapeCall[]
): Map<number, SourceLocation> {
    const result = new Map<number, SourceLocation>()
    const matchedCalls = new Set<ParsedShapeCall>()

    for (const node of nodes) {
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
