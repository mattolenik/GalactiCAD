/**
 * Serialize an SFCC-subset scene to the `BridgeNode` JSON shape the Rust
 * `scene_bridge` (gcad-wasm/kernel) ingests at the WASM boundary.
 *
 * Mirrors the dispatch of `compileCpuSdf`'s `walk` exactly (same v1 subset, same
 * field extraction): 7 primitives + Translate/Rotate/uniform-Scale +
 * Union/Subtract/Intersect (hard + smooth). The GPU-render `SerializedNode[]` is
 * insufficient for SFCC — it lacks Rotate's `getWgslMatrices().fwd`, profile
 * vertices, and operator blend modes — so this is a dedicated SFCC serializer.
 *
 * Throws on anything outside the subset (so we never emit a scene the bridge
 * would mishandle; the Rust side ALSO rejects it, but failing fast in TS gives a
 * clearer node-typed error).
 */

import type { Node } from "../../scene/base.mjs"
import { Box } from "../../scene/primitives/box.mjs"
import { Sphere } from "../../scene/primitives/sphere.mjs"
import { Cylinder } from "../../scene/primitives/cylinder.mjs"
import { Cone } from "../../scene/primitives/cone.mjs"
import { Extrude } from "../../scene/primitives/extrude.mjs"
import { Loft } from "../../scene/primitives/loft.mjs"
import { Lathe } from "../../scene/primitives/lathe.mjs"
import { Union } from "../../scene/operators/union.mjs"
import { Subtract } from "../../scene/operators/subtract.mjs"
import { Intersect } from "../../scene/operators/intersect.mjs"
import { Translate } from "../../scene/operators/translate.mjs"
import { Rotate } from "../../scene/operators/rotate.mjs"
import { Scale } from "../../scene/operators/scale.mjs"

const nid = (n: Node): number => (typeof (n as { id?: number }).id === "number" ? (n as { id: number }).id : -1)
const pos3 = (n: { pos: { x: number; y: number; z: number } }): [number, number, number] => [n.pos.x, n.pos.y, n.pos.z]

/** Recursive `BridgeNode` (matches the Rust `scene_bridge::BridgeNode` enum). */
export function serializeBridgeNode(n: Node): unknown {
    if (n instanceof Box) return { kind: "box", node_id: nid(n), pos: pos3(n), half: [n.size.x, n.size.y, n.size.z] }
    if (n instanceof Sphere) return { kind: "sphere", node_id: nid(n), pos: pos3(n), r: n.r }
    if (n instanceof Cylinder)
        return {
            kind: "cylinder",
            node_id: nid(n),
            pos: pos3(n),
            r: n.r,
            h: n.h,
            fillet_top: n.filletTop,
            fillet_bottom: n.filletBottom,
            chamfer_top: n.chamferTop,
            chamfer_bottom: n.chamferBottom,
        }
    if (n instanceof Cone) return { kind: "cone", node_id: nid(n), pos: pos3(n), r: n.r, h: n.h }
    if (n instanceof Extrude)
        return {
            kind: "extrude",
            node_id: nid(n),
            pos: pos3(n),
            verts: n.child.vertices.map(v => [v[0], v[1]]),
            h: n.h,
            twist_degrees: n.twistDegrees,
        }
    if (n instanceof Loft)
        return {
            kind: "loft",
            node_id: nid(n),
            pos: pos3(n),
            profiles: n.profiles.map(p => p.vertices.map(v => [v[0], v[1]])),
            h: n.h,
        }
    if (n instanceof Lathe)
        return { kind: "lathe", node_id: nid(n), pos: pos3(n), verts: n.child.vertices.map(v => [v[0], v[1]]) }
    if (n instanceof Translate)
        return { kind: "translate", node_id: nid(n), d: [n.dx, n.dy, n.dz], arg: serializeBridgeNode(n.arg) }
    if (n instanceof Rotate)
        return { kind: "rotate", node_id: nid(n), fwd: n.getWgslMatrices().fwd, arg: serializeBridgeNode(n.arg) }
    if (n instanceof Scale)
        return { kind: "scale", node_id: nid(n), sx: n.sx, sy: n.sy, sz: n.sz, arg: serializeBridgeNode(n.arg) }
    if (n instanceof Union)
        return {
            kind: "union",
            node_id: nid(n),
            children: n.children.map(serializeBridgeNode),
            radius: n.radius ?? 0,
            mode: n.mode ?? null,
            n: n.n ?? null,
        }
    if (n instanceof Subtract)
        return {
            kind: "subtract",
            node_id: nid(n),
            lh: serializeBridgeNode(n.lh),
            rh: serializeBridgeNode(n.rh),
            radius: n.radius ?? 0,
            mode: n.mode ?? null,
            n: n.n ?? null,
        }
    if (n instanceof Intersect)
        return {
            kind: "intersect",
            node_id: nid(n),
            lh: serializeBridgeNode(n.lh),
            rh: serializeBridgeNode(n.rh),
            radius: n.radius ?? 0,
            mode: n.mode ?? null,
            n: n.n ?? null,
        }
    throw new Error(`sfcc-rs: unsupported node "${n.getShapeType()}" (#${nid(n)}) — not in the SFCC v1 subset`)
}

/** Serialize the whole scene to the boundary JSON string. */
export function serializeSceneToBridgeJson(root: Node): string {
    return JSON.stringify(serializeBridgeNode(root))
}
