/**
 * Serialize scene nodes for transfer to main thread (worker -> main).
 * Used by render worker when build completes.
 */

import type { Node } from "./scene/base.mjs"
import type { SerializedNode } from "./render-worker-protocol.mjs"
import { Box, childNodes, Cone, Cylinder, Extrude, Loft, PlaneNode, Polygon2D, ThreadedRod, VirtualCapNode } from "./scene/scene.mjs"

function serializeNode(node: Node, parentId: number): SerializedNode {
    const children = childNodes(node)
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
        if (node.vertexIsAnchor) s.vertexIsAnchor = node.vertexIsAnchor.slice()
    }

    if (node instanceof Extrude) {
        s.twistDegrees = node.twistDegrees
        s.sceneCapParamsByteOffset = node.previewF32Slot * 4
    }

    if (node instanceof Loft) {
        s.sceneCapParamsByteOffset = node.previewF32Slot * 4
    }

    if (node instanceof ThreadedRod) {
        s.turnPitch = node.turnPitch
        s.threadAmp = node.threadAmp
        s.threadFlankAngleDeg = node.threadFlankAngleDeg
        s.threadProfile = node.threadProfile
        s.handedness = node.handedness
        s.sceneCapParamsByteOffset = (node.previewF32Slot + 3) * 4
        s.filletTop = node.filletTop
        s.filletBottom = node.filletBottom
        s.chamferTop = node.chamferTop
        s.chamferBottom = node.chamferBottom
        s.femalePlay = node.femalePlay
    }

    if (node instanceof VirtualCapNode) {
        s.isVirtualCap = true
        s.capSide = node.isTop ? "top" : "bottom"
    }

    if (node instanceof Cylinder) {
        s.filletTop = node.filletTop
        s.filletBottom = node.filletBottom
        s.chamferTop = node.chamferTop
        s.chamferBottom = node.chamferBottom
    }

    if (node.paramCount > 0) {
        s.paramOffset = node.paramOffset
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
        for (const child of childNodes(node)) {
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
