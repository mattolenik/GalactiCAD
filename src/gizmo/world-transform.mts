/**
 * World-space placement + transform helpers for the gizmo.
 *
 * `Node.computeBounds()` returns a node's bounds in its OWN local space (the
 * space its subtree is evaluated in, after ancestor transforms inverse-transform
 * the sample point). To anchor the gizmo at a selected node's on-screen center,
 * and to convert a world-space drag into the node's local frame, we walk
 * root→target composing each Translate / Rotate / Scale exactly as
 * `FeatureGraphBuilder` does (`accumulated = parent · local`, world =
 * accumulated · localPoint).
 *
 * Non-affine ancestors (warps: twist/bend/taper/…) contribute identity here —
 * their center/frame is ill-defined and the affine gizmo can't represent them.
 * Operators (union/subtract/…) and modifiers contribute identity (no space move).
 */

import { type Node, UnaryOperator, BinaryOperator } from "../scene/base.mjs"
import { Translate } from "../scene/operators/translate.mjs"
import { Rotate } from "../scene/operators/rotate.mjs"
import { Scale } from "../scene/operators/scale.mjs"
import { mat4FromTranslation, mat4FromRotationFwd, mat4FromScale } from "../scene/feature-graph-buffer.mjs"
import { eulerMatrices, matMul3 } from "../scene/transform-math.mjs"
import { Mat4x4f } from "../vecmat/matrix.mjs"
import { type Vec3f, vec3 } from "../vecmat/vector.mjs"

function identity(): Float32Array {
    const m = new Float32Array(16)
    m[0] = m[5] = m[10] = m[15] = 1
    return m
}

/** Column-major 4×4 product a·b (matches `feature-graph-buffer`'s `mulMat4`). */
function mul(a: Float32Array, b: Float32Array): Float32Array {
    const r = new Float32Array(16)
    for (let c = 0; c < 4; c++) {
        for (let row = 0; row < 4; row++) {
            let s = 0
            for (let k = 0; k < 4; k++) s += a[k * 4 + row]! * b[c * 4 + k]!
            r[c * 4 + row] = s
        }
    }
    return r
}

/** The forward (object→world) affine of a transform node, or null if it does not move space. */
function localMatrix(node: Node): Float32Array | null {
    if (node instanceof Translate) return mat4FromTranslation(node.dx, node.dy, node.dz)
    if (node instanceof Rotate) return mat4FromRotationFwd(node.getWgslMatrices().fwd)
    if (node instanceof Scale) return mat4FromScale(node.sx, node.sy, node.sz)
    return null
}

function children(node: Node): Node[] {
    if (node instanceof UnaryOperator) return [node.arg]
    if (node instanceof BinaryOperator) return [node.lh, node.rh]
    return []
}

function contains(node: Node, id: number): boolean {
    if (node.id === id) return true
    for (const c of children(node)) {
        if (contains(c, id)) return true
    }
    return false
}

/**
 * Walk root→target, accumulating the object→world affine (4×4 column-major) of
 * the ancestor transforms. Returns the target node + its accumulated frame, or
 * null if the node is not found.
 */
function nodeAccumulated(root: Node, targetId: number): { node: Node; acc: Float32Array; path: Node[] } | null {
    let node = root
    let acc = identity()
    let guard = 0
    const path: Node[] = [root]
    while (node.id !== targetId) {
        const m = localMatrix(node)
        if (m) acc = mul(acc, m)
        const next = children(node).find(c => contains(c, targetId))
        if (!next || ++guard > 4096) return null
        node = next
        path.push(node)
    }
    return { node, acc, path }
}

/**
 * Nearest pre-shift `Rotate` ancestor of the target: scanning outward from the
 * target, the first `Rotate` reached before any `Translate`. This is the node
 * the gizmo's local rotation maps to (a `.rotate` before any `.shift`). Returns
 * null when a `Translate` is hit first or no rotate exists.
 */
function preShiftRotate(path: Node[]): Rotate | null {
    for (let i = path.length - 2; i >= 0; i--) {
        const n = path[i]!
        if (n instanceof Rotate) return n
        if (n instanceof Translate) return null
    }
    return null
}

/**
 * World-space center of `targetId`'s bounding box within the scene rooted at
 * `root`. Returns null when the node is unbounded or not found.
 */
export function worldCenterForNode(root: Node, targetId: number): [number, number, number] | null {
    const found = nodeAccumulated(root, targetId)
    if (!found) return null
    const b = found.node.computeBounds()
    if (!b) return null
    const w = new Mat4x4f(found.acc).transformPoint(vec3(b.cx, b.cy, b.cz))
    return [w.x, w.y, w.z]
}

/**
 * Gizmo placement for a node: its world-space center plus the row-major 3×3
 * that maps a WORLD-space delta into the node's LOCAL frame (the inverse of the
 * accumulated ancestor linear part). For a node with no transform ancestors
 * this is the identity, so a world drag equals a local delta.
 */
export function nodePlacement(
    root: Node,
    targetId: number,
): {
    center: [number, number, number]
    invLinear: number[]
    orient: number[]
    /** Node id of the pre-shift Rotate to live-mutate, or 0 if none. */
    rotateNodeId: number
    /** That rotate's current Euler (deg), for composition. */
    rotateEuler: [number, number, number]
} | null {
    const found = nodeAccumulated(root, targetId)
    if (!found) return null
    const b = found.node.computeBounds()
    if (!b) return null
    const center = new Mat4x4f(found.acc).transformPoint(vec3(b.cx, b.cy, b.cz))
    // Upper-left 3×3 of the column-major acc, read row-major.
    const a = found.acc
    const linear = [a[0]!, a[4]!, a[8]!, a[1]!, a[5]!, a[9]!, a[2]!, a[6]!, a[10]!]
    // Object's world orientation (column-major 3×3) for local-aligned rings:
    // ancestor linear, then the primitive's own `rot` if it supports the field.
    let orient = [a[0]!, a[1]!, a[2]!, a[4]!, a[5]!, a[6]!, a[8]!, a[9]!, a[10]!]
    let rotateNodeId = 0
    let rotateEuler: [number, number, number] = [0, 0, 0]
    const target = found.node
    if (target.rotPreviewMat3Slot >= 0) {
        // Primitive `rot` field: the gizmo edits it directly (param-only/live).
        const { fwd } = eulerMatrices(target.rot.x, target.rot.y, target.rot.z)
        orient = matMul3(orient, fwd)
        rotateNodeId = targetId
        rotateEuler = [target.rot.x, target.rot.y, target.rot.z]
    } else {
        // Operator fallback: nearest pre-shift Rotate node.
        const rot = preShiftRotate(found.path)
        if (rot) {
            rotateNodeId = rot.id
            rotateEuler = [rot.rx, rot.ry, rot.rz]
        }
    }
    return { center: [center.x, center.y, center.z], invLinear: invert3x3(linear) ?? IDENTITY_3X3, orient, rotateNodeId, rotateEuler }
}

const IDENTITY_3X3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]

/** Invert a row-major 3×3; returns null if singular. */
function invert3x3(m: number[]): number[] | null {
    const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number]
    const A = e * i - f * h
    const B = -(d * i - f * g)
    const C = d * h - e * g
    const det = a * A + b * B + c * C
    if (Math.abs(det) < 1e-12) return null
    const inv = 1 / det
    return [
        A * inv,
        (c * h - b * i) * inv,
        (b * f - c * e) * inv,
        B * inv,
        (a * i - c * g) * inv,
        (c * d - a * f) * inv,
        C * inv,
        (b * g - a * h) * inv,
        (a * e - b * d) * inv,
    ]
}

/** Apply a row-major 3×3 to a vector. */
export function applyMat3(m: number[], v: readonly [number, number, number]): [number, number, number] {
    return [
        m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2],
        m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2],
        m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2],
    ]
}

interface PosBearing {
    pos?: Vec3f
}

/** Read a node's translation value (`Translate` delta, or a primitive's `pos`), or null. */
export function getNodeTranslation(node: Node): [number, number, number] | null {
    if (node instanceof Translate) return [node.dx, node.dy, node.dz]
    const pos = (node as PosBearing).pos
    if (pos && typeof pos.x === "number") return [pos.x, pos.y, pos.z]
    return null
}

/** Set a node's rotation (deg) in place: a primitive's `rot` field if it supports
 * one, else a `Rotate` operator's Euler. Returns false if neither applies. */
export function setNodeRotation(node: Node, euler: readonly [number, number, number]): boolean {
    if (node instanceof Rotate) {
        node.rx = euler[0]
        node.ry = euler[1]
        node.rz = euler[2]
        return true
    }
    if (node.rotPreviewMat3Slot >= 0) {
        node.rot = vec3(euler[0], euler[1], euler[2])
        return true
    }
    return false
}

/** Set a node's translation value in place. Returns false if the node can't carry one. */
export function setNodeTranslation(node: Node, v: readonly [number, number, number]): boolean {
    if (node instanceof Translate) {
        node.dx = v[0]
        node.dy = v[1]
        node.dz = v[2]
        return true
    }
    const bearer = node as PosBearing
    if (bearer.pos && typeof bearer.pos.x === "number") {
        bearer.pos = vec3(v[0], v[1], v[2])
        return true
    }
    return false
}
