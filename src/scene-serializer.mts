/**
 * Serialize scene nodes for transfer to main thread (worker -> main).
 * Used by render worker when build completes.
 */

import type { Node } from "./scene/base.mjs"
import type { SerializedNode } from "./render-worker-protocol.mjs"
import { BinaryOperator, UnaryOperator } from "./scene/base.mjs"
import { Box, Cone, Cylinder, Extrude, Lathe, Loft, PlaneNode, Polygon2D, VirtualCapNode } from "./scene/scene.mjs"

function getChildren(node: Node): Node[] {
    if (node instanceof BinaryOperator) {
        return [node.lh, node.rh]
    }
    if (node instanceof UnaryOperator) {
        return [node.arg]
    }
    if (node instanceof Extrude) {
        return [node.child, node.capTop, node.capBottom]
    }
    if (node instanceof Loft) {
        return [...node.profiles]
    }
    if (node instanceof Lathe) {
        return [node.child]
    }
    return []
}

function serializeNode(node: Node, parentId: number): SerializedNode {
    const children = getChildren(node)
    const s: SerializedNode = {
        id: node.id,
        shapeType: node.getShapeType(),
        indicatorSvg: node.getIndicatorSvg?.(),
        parentId,
        children: children.map(c => c.id),
    }

    const pos = (node as { pos?: { x: number; y: number; z: number } }).pos
    if (pos) {
        s.pos = [pos.x, pos.y, pos.z]
    }

    const size = (node as { size?: { x: number; y: number; z: number } }).size
    if (size) {
        s.size = [size.x, size.y, size.z]
    }

    const r = (node as { r?: number }).r
    if (r !== undefined) s.r = r

    const h = (node as { h?: number }).h
    if (h !== undefined) s.h = h

    const sr = (node as { sr?: number }).sr
    if (sr !== undefined) s.sr = sr

    const lr = (node as { lr?: number }).lr
    if (lr !== undefined) s.lr = lr

    const c = (node as { c?: number }).c
    if (c !== undefined) s.c = c

    if (node instanceof PlaneNode) {
        s.normal = [node.normal.x, node.normal.y, node.normal.z]
        s.planeOffset = node.dist
    }

    if (node instanceof Polygon2D) {
        s.vertices = node.vertices.map(v => [v[0], v[1]])
        s.bufferOffset = node.bufferOffset >= 0 ? node.bufferOffset : undefined
    }

    if (node instanceof Extrude) {
        s.twistDegrees = node.twistDegrees
    }

    if (node instanceof VirtualCapNode) {
        s.isVirtualCap = true
        s.capSide = node.isTop ? "top" : "bottom"
    }

    return s
}

export function serializeSceneNodes(scene: { root?: Node; getAllNodes(): Node[] }, allNodes?: Node[]): SerializedNode[] {
    const result: SerializedNode[] = []
    const visited = new Set<number>()

    function visit(node: Node, parentId: number) {
        if (visited.has(node.id)) return
        visited.add(node.id)
        result.push(serializeNode(node, parentId))
        for (const child of getChildren(node)) {
            visit(child, node.id)
        }
    }

    if (scene.root) {
        visit(scene.root, -1)
    } else {
        const nodes = allNodes ?? scene.getAllNodes()
        for (const node of nodes) {
            visit(node, -1)
        }
    }
    return result
}
