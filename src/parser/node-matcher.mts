/**
 * Node Matcher - Match scene nodes to source code by comparing property values
 * 
 * This provides a robust way to link scene objects to their source code by
 * comparing the actual property values (position, size, radius) rather than
 * relying on traversal order or stack traces.
 * 
 * For composite types (union, subtract, intersect, etc), matching is done by type name
 * and source order since they don't have unique identifying properties.
 */

import { log } from "../logging/debug-log.mjs"
import { Node, Sphere, Box, Union, Subtract, Intersect, Pipe, Engrave, Groove, Tongue, Shell, Offset, Elongate, Twist, Bend, Taper, Morph, Seam, Cylinder, Cone, Torus, Capsule, PlaneNode, HexPrism, Disc, Blob, Rotate, Polygon2D, Extrude, Loft, Lathe } from "../scene/scene.mjs"
import { vec3 } from "../vecmat/vector.mjs"
import type { ParsedShapeCall, SourceLocation } from "./source-parser.mjs"

/** Composite shape types that are matched by name only */
const COMPOSITE_TYPES = new Set(["union", "subtract", "intersect", "pipe", "engrave", "groove", "tongue", "shell", "offset", "elongate", "twist", "bend", "taper", "morph", "seam", "rotate", "scale", "extrude", "loft", "lathe"])

/**
 * CSG operators that don't render as visible objects — when selected from editor, select only their child shapes.
 * Excludes rotate, extrude, loft, lathe which render as visible composites.
 */
export const PURE_CSG_TYPES = new Set(["union", "subtract", "intersect", "pipe", "engrave", "groove", "tongue", "shell", "offset", "elongate", "twist", "bend", "taper", "morph", "seam"])

/**
 * Tolerance for floating-point comparisons
 */
const EPSILON = 1e-6

/** Default position when .shift() is omitted from fluent primitives */
const DEFAULT_POS = vec3([0, 0, 0])

/**
 * Check if two numbers are approximately equal
 */
function approxEqual(a: number, b: number): boolean {
    return Math.abs(a - b) < EPSILON
}

/**
 * Check if two Vec3f values are approximately equal.
 * Returns false if a is undefined.
 */
function vec3ApproxEqual(a: { x: number; y: number; z: number } | undefined, b: { x: number; y: number; z: number }): boolean {
    if (!a) return false
    return approxEqual(a.x, b.x) && approxEqual(a.y, b.y) && approxEqual(a.z, b.z)
}

/**
 * Check if two numbers are approximately equal.
 * Returns false if a is undefined.
 */
function approxEqualOrUndefined(a: number | undefined, b: number): boolean {
    if (a === undefined) return false
    return approxEqual(a, b)
}

/** Node-like interface for matching (supports both Node and NodeStub from worker proxy). */
interface NodeLikeMatch {
    id: number
    getShapeType(): string
    pos?: { x: number; y: number; z: number }
    size?: { x: number; y: number; z: number }
    r?: number
    h?: number
    sr?: number
    lr?: number
    turnPitch?: number
    threadAmp?: number
    threadFlankAngleDeg?: number
    threadProfile?: "fdm" | "iso" | "acme"
    threadHandedness?: "left" | "right"
    c?: number
    normal?: { x: number; y: number; z: number }
    dist?: number
    planeOffset?: number
    vertices?: [number, number][]
    twistDegrees?: number
}

/**
 * Try to match a scene node to a parsed shape call
 * Returns true if the node's properties match the parsed call's arguments
 */
function matchNodeToCall(node: NodeLikeMatch, call: ParsedShapeCall): boolean {
    const shapeType = node.getShapeType()

    if (shapeType !== call.functionName) {
        return false
    }

    if (shapeType === "sphere") {
        // Match sphere: position and radius must match
        const callPos = call.pos ?? DEFAULT_POS
        if (!vec3ApproxEqual(node.pos, callPos)) {
            return false
        }

        const expectedRadius = call.r
        if (expectedRadius === undefined) return false

        if (!approxEqualOrUndefined(node.r, expectedRadius)) {
            return false
        }

        return true
    }

    if (shapeType === "box") {
        // Match box: position and size must match
        if (!call.size) return false
        const callPos = call.pos ?? DEFAULT_POS
        if (!vec3ApproxEqual(node.pos, callPos)) {
            return false
        }

        // Check size
        if (!vec3ApproxEqual(node.size, call.size)) {
            return false
        }

        return true
    }

    if (shapeType === "cylinder") {
        const callPos = call.pos ?? DEFAULT_POS
        if (!vec3ApproxEqual(node.pos, callPos)) return false
        if (call.r === undefined || !approxEqualOrUndefined(node.r, call.r)) return false
        if (call.h !== undefined && !approxEqualOrUndefined(node.h, call.h)) return false
        return true
    }

    if (shapeType === "cone") {
        const callPos = call.pos ?? DEFAULT_POS
        if (!vec3ApproxEqual(node.pos, callPos)) return false
        if (call.r === undefined || !approxEqualOrUndefined(node.r, call.r)) return false
        if (call.h !== undefined && !approxEqualOrUndefined(node.h, call.h)) return false
        return true
    }

    if (shapeType === "torus") {
        const callPos = call.pos ?? DEFAULT_POS
        if (!vec3ApproxEqual(node.pos, callPos)) return false
        if (call.sr !== undefined && !approxEqualOrUndefined(node.sr, call.sr)) return false
        if (call.lr !== undefined && !approxEqualOrUndefined(node.lr, call.lr)) return false
        return true
    }

    if (shapeType === "threaded_rod") {
        const callPos = call.pos ?? DEFAULT_POS
        if (!vec3ApproxEqual(node.pos, callPos)) return false
        if (call.r === undefined || !approxEqualOrUndefined(node.r, call.r)) return false
        if (call.h !== undefined && !approxEqualOrUndefined(node.h, call.h)) return false
        if (call.pitch !== undefined && !approxEqualOrUndefined(node.turnPitch, call.pitch)) return false
        if (call.threadAngle !== undefined && !approxEqualOrUndefined(node.threadFlankAngleDeg, call.threadAngle)) return false
        if (call.depth !== undefined && !approxEqualOrUndefined(node.threadAmp, call.depth)) return false
        const callProfile = call.threadProfile ?? "fdm"
        const nodeProfile = node.threadProfile ?? "fdm"
        if (callProfile !== nodeProfile) return false
        const callHand = call.threadHandedness ?? "right"
        const nodeHand = node.threadHandedness ?? "right"
        if (callHand !== nodeHand) return false
        return true
    }

    if (shapeType === "capsule") {
        const callPos = call.pos ?? DEFAULT_POS
        if (!vec3ApproxEqual(node.pos, callPos)) return false
        if (call.r === undefined || !approxEqualOrUndefined(node.r, call.r)) return false
        if (call.c !== undefined && !approxEqualOrUndefined(node.c, call.c)) return false
        return true
    }

    if (shapeType === "plane") {
        const callPos = call.pos ?? DEFAULT_POS
        if (!vec3ApproxEqual(node.pos, callPos)) return false
        if (call.normal && !vec3ApproxEqual(node.normal, call.normal)) return false
        if (call.planeOffset !== undefined && !approxEqual(node.dist ?? node.planeOffset ?? 0, call.planeOffset)) return false
        return true
    }

    if (shapeType === "hexprism") {
        const callPos = call.pos ?? DEFAULT_POS
        if (!vec3ApproxEqual(node.pos, callPos)) return false
        if (call.r === undefined || !approxEqualOrUndefined(node.r, call.r)) return false
        if (call.h !== undefined && !approxEqualOrUndefined(node.h, call.h)) return false
        return true
    }

    if (shapeType === "disc") {
        const callPos = call.pos ?? DEFAULT_POS
        if (!vec3ApproxEqual(node.pos, callPos)) return false
        if (call.r === undefined || !approxEqualOrUndefined(node.r, call.r)) return false
        return true
    }

    if (shapeType === "blob") {
        const callPos = call.pos ?? DEFAULT_POS
        if (!vec3ApproxEqual(node.pos, callPos)) return false
        return true
    }

    if (shapeType === "polygon2d") {
        // Match polygon2d by comparing vertex arrays
        const verts = node.vertices
        if (!call.vertices || !verts) return false
        if (verts.length !== call.vertices.length) return false
        for (let i = 0; i < verts.length; i++) {
            if (!approxEqual(verts[i][0], call.vertices[i][0])) return false
            if (!approxEqual(verts[i][1], call.vertices[i][1])) return false
        }
        return true
    }

    if (shapeType === "extrude") {
        if (call.h === undefined) return false
        if (!approxEqualOrUndefined(node.h, call.h)) return false
        if (call.pos !== undefined && !vec3ApproxEqual(node.pos, call.pos)) return false
        const callTwist = call.t ?? 0
        if (!approxEqualOrUndefined(node.twistDegrees, callTwist)) return false
        return true
    }

    if (shapeType === "loft") {
        if (call.h === undefined) return false
        if (!approxEqualOrUndefined(node.h, call.h)) return false
        if (call.pos !== undefined && !vec3ApproxEqual(node.pos, call.pos)) return false
        return true
    }

    if (shapeType === "lathe") {
        if (call.pos !== undefined && !vec3ApproxEqual(node.pos, call.pos)) return false
        return true
    }

    // For composite types (union, subtract, etc.), match by type name only.
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
    nodes: NodeLikeMatch[],
    calls: ParsedShapeCall[]
): Map<number, SourceLocation> {
    const result = new Map<number, SourceLocation>()
    const matchedCalls = new Set<ParsedShapeCall>()

    const callsByType = new Map<string, ParsedShapeCall[]>()
    for (const call of calls) {
        const list = callsByType.get(call.functionName) ?? []
        list.push(call)
        callsByType.set(call.functionName, list)
    }

    for (const node of nodes) {
        const typeCalls = callsByType.get(node.getShapeType())
        if (!typeCalls) continue
        for (const call of typeCalls) {
            if (matchedCalls.has(call)) continue
            if (matchNodeToCall(node, call)) {
                result.set(node.id, call.location)
                matchedCalls.add(call)
                log("NodeMatcher").debug(
                    `Matched node ${node.id} (${node.getShapeType()}) to ${call.functionName} at line ${call.location.startLine}`
                )
                break
            }
        }
    }

    log("NodeMatcher").debug(`Matched ${result.size}/${nodes.length} nodes`)

    return result
}
