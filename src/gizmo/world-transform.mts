/**
 * World-space placement for the transform gizmo.
 *
 * `Node.computeBounds()` returns a node's bounds in its OWN local space (the
 * space its subtree is evaluated in, after ancestor transforms inverse-transform
 * the sample point). To anchor the gizmo at a selected node's on-screen center
 * we must push that local center back out through the accumulated ancestor
 * transforms. This walks root→target composing each Translate / Rotate / Scale
 * exactly as `FeatureGraphBuilder` does (`accumulated = parent · local`,
 * world = accumulated · localPoint), so the anchor lines up with the rendered
 * surface on transformed / CSG scenes.
 *
 * Non-affine ancestors (warps: twist/bend/taper/…) contribute identity here —
 * their center is ill-defined and the affine gizmo can't represent them anyway,
 * so the anchor is approximate under a warp. Operators (union/subtract/…) and
 * modifiers contribute identity (they don't move space).
 */

import { type Node, UnaryOperator, BinaryOperator } from "../scene/base.mjs"
import { Translate } from "../scene/operators/translate.mjs"
import { Rotate } from "../scene/operators/rotate.mjs"
import { Scale } from "../scene/operators/scale.mjs"
import { mat4FromTranslation, mat4FromRotationFwd, mat4FromScale } from "../scene/feature-graph-buffer.mjs"
import { Mat4x4f } from "../vecmat/matrix.mjs"
import { vec3 } from "../vecmat/vector.mjs"

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
 * World-space center of `targetId`'s bounding box within the scene rooted at
 * `root`. Returns null when the node is unbounded or not found.
 */
export function worldCenterForNode(root: Node, targetId: number): [number, number, number] | null {
    let node = root
    let acc = identity()
    let guard = 0
    while (node.id !== targetId) {
        const m = localMatrix(node)
        if (m) acc = mul(acc, m)
        const next = children(node).find(c => contains(c, targetId))
        if (!next || ++guard > 4096) return null
        node = next
    }
    const b = node.computeBounds()
    if (!b) return null
    const w = new Mat4x4f(acc).transformPoint(vec3(b.cx, b.cy, b.cz))
    return [w.x, w.y, w.z]
}
