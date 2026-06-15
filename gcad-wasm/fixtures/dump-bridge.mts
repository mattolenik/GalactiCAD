/**
 * M5 SCENE-BRIDGE native-gate dumper. For each of the five acceptance scenes
 * (box / box−sphere / lathe / extrude-twist / loft) this writes TWO fixtures:
 *
 *   - `bridge-<name>.json`  — the SERIALIZED scene in the boundary format the
 *     Rust `scene_bridge` ingests (a `BridgeNode` tagged tree: `kind` discriminant,
 *     pos widened f32→f64, Rotate's `getWgslMatrices().fwd`, operator radius/mode/n).
 *   - `bridge-<name>.bin`   — the TS SFCC reference mesh (the SAME binary layout
 *     `parity::load_fixture` reads): `[u32 vfc][u32 tic][f32 verts][u32 tris]`.
 *
 * The Rust native gate (`kernel/tests/scene_bridge_parity.rs`) parses the JSON
 * through `scene_bridge::build_csg_tree_from_json` → `run_sfcc_pipeline` and asserts
 * the mesh matches `bridge-<name>.bin` via `parity::meshes_equivalent` (small
 * `pos_eps` for V8↔Rust libm ULP drift). This proves the boundary INPUT path
 * end-to-end WITHOUT the app.
 *
 *   tsx gcad-wasm/fixtures/dump-bridge.mts
 *
 * The serializer here is a DEDICATED SFCC scene serializer: it walks the live
 * Node tree the same way `compileCpuSdf` does, emitting exactly the geometry the
 * bridge needs (the GPU-render `SerializedNode[]` lacks Rotate matrices, profile
 * vertices, and operator blend modes, so it is insufficient for SFCC).
 *
 * NOTE: a NEW file — it does not touch the sibling-owned dump*.mts / Makefile.
 * `bridge-*.json` / `bridge-*.bin` are gitignored.
 */
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { Box } from "../../src/scene/primitives/box.mjs"
import { Sphere } from "../../src/scene/primitives/sphere.mjs"
import { Cylinder } from "../../src/scene/primitives/cylinder.mjs"
import { Cone } from "../../src/scene/primitives/cone.mjs"
import { Extrude } from "../../src/scene/primitives/extrude.mjs"
import { Loft } from "../../src/scene/primitives/loft.mjs"
import { Lathe } from "../../src/scene/primitives/lathe.mjs"
import { Polygon2D } from "../../src/scene/primitives/polygon2d.mjs"
import { Union } from "../../src/scene/operators/union.mjs"
import { Subtract } from "../../src/scene/operators/subtract.mjs"
import { Intersect } from "../../src/scene/operators/intersect.mjs"
import { Translate } from "../../src/scene/operators/translate.mjs"
import { Rotate } from "../../src/scene/operators/rotate.mjs"
import { Scale } from "../../src/scene/operators/scale.mjs"
import type { Node } from "../../src/scene/base.mjs"
import { compileCpuSdf } from "../../src/export/sfcc/cpu-sdf.mjs"
import { runSfccPipeline } from "../../src/export/sfcc/assemble.mjs"
import { DEFAULT_SFCC_TUNING } from "../../src/export/sfcc/sfcc-tuning.mjs"

const here = dirname(fileURLToPath(import.meta.url))

const nid = (n: Node): number => (typeof (n as { id?: number }).id === "number" ? (n as { id: number }).id : -1)
const pos3 = (n: { pos: { x: number; y: number; z: number } }): [number, number, number] => [n.pos.x, n.pos.y, n.pos.z]

/**
 * Serialize a live SFCC-subset scene to the `BridgeNode` JSON shape. Mirrors the
 * dispatch of `compileCpuSdf`'s `walk` exactly (same supported subset, same field
 * extraction). Throws on anything outside the subset (so the dumper never emits a
 * scene the bridge would silently mishandle).
 */
function serialize(n: Node): unknown {
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
        return { kind: "translate", node_id: nid(n), d: [n.dx, n.dy, n.dz], arg: serialize(n.arg) }
    if (n instanceof Rotate)
        return { kind: "rotate", node_id: nid(n), fwd: n.getWgslMatrices().fwd, arg: serialize(n.arg) }
    if (n instanceof Scale)
        return { kind: "scale", node_id: nid(n), sx: n.sx, sy: n.sy, sz: n.sz, arg: serialize(n.arg) }
    if (n instanceof Union)
        return {
            kind: "union",
            node_id: nid(n),
            children: n.children.map(serialize),
            radius: n.radius ?? 0,
            mode: n.mode ?? null,
            n: n.n ?? null,
        }
    if (n instanceof Subtract)
        return {
            kind: "subtract",
            node_id: nid(n),
            lh: serialize(n.lh),
            rh: serialize(n.rh),
            radius: n.radius ?? 0,
            mode: n.mode ?? null,
            n: n.n ?? null,
        }
    if (n instanceof Intersect)
        return {
            kind: "intersect",
            node_id: nid(n),
            lh: serialize(n.lh),
            rh: serialize(n.rh),
            radius: n.radius ?? 0,
            mode: n.mode ?? null,
            n: n.n ?? null,
        }
    throw new Error(`dump-bridge: unsupported node ${n.getShapeType()} (not in the SFCC v1 subset)`)
}

interface Cube {
    minX: number
    minY: number
    minZ: number
    size: number
}

function dump(name: string, scene: Node, cube: Cube, tuningOverride: Partial<typeof DEFAULT_SFCC_TUNING>): void {
    const tuning = { ...DEFAULT_SFCC_TUNING, ...tuningOverride }
    // (a) the serialized boundary input.
    writeFileSync(join(here, `bridge-${name}.json`), JSON.stringify(serialize(scene)))
    // (b) the TS SFCC reference mesh.
    const tree = compileCpuSdf(scene)
    const r = runSfccPipeline(tree, cube, tuning)
    const verts = Float32Array.from(r.verts)
    const tris = Uint32Array.from(r.tris)
    const header = new Uint32Array([verts.length, tris.length])
    const buf = Buffer.concat([Buffer.from(header.buffer), Buffer.from(verts.buffer), Buffer.from(tris.buffer)])
    writeFileSync(join(here, `bridge-${name}.bin`), buf)
    console.log(
        `wrote bridge-${name}.{json,bin}: ${verts.length / 8} verts, ${tris.length / 3} tris` +
            ` (manifold ok=${r.manifold.ok} χ=[${r.manifold.eulerPerComponent.join(",")}]` +
            ` curves=${r.stats.featureCurves} failed=${r.stats.failedCells})`,
    )
}

// The five M5 acceptance scenes (matching the existing mesh-feat/lathe/extrude/loft
// dumpers' literals + cubes + tuning so the geometry path is the SAME oracle).
const D47 = { depthMin: 4, depthMax: 7 }

// (1) box — sharp edges + corners, no boolean seam.
dump("box", new Box([0, 0, 0], [10, 10, 10]), { minX: -10, minY: -10, minZ: -10, size: 20 }, D47)

// (2) box − sphere — surviving edges + corners + 3 traced seam circles.
dump(
    "box-minus-sphere",
    new Subtract(new Box([0, 0, 0], [10, 10, 10]), new Sphere([5, 5, 5], { r: 6 })),
    { minX: -10, minY: -10, minZ: -10, size: 20 },
    D47,
)

// (3) lathe — stepped goblet (rings + plane/cylinder/cone revolved edges).
dump(
    "lathe",
    new Lathe([0, 0, 0], new Polygon2D([[0, -2], [1.6, -2], [0.9, 1.0], [1.2, 2.0], [0, 2]])),
    { minX: -3, minY: -3, minZ: -3, size: 6 },
    D47,
)

// (4) extrude (twist) — twistedSide ruled carriers + helical edges + rotated rims.
dump(
    "extrude-twist",
    new Extrude([0, 0, 0], new Polygon2D([[1.5, 1.5], [-1.5, 1.5], [-1.5, -1.5], [1.5, -1.5]]), { h: 2.5, t: 60 }),
    { minX: -3.5, minY: -3.5, minZ: -3.5, size: 7 },
    D47,
)

// (5) loft — square → smaller rotated square (curved morph, loftSide carriers).
dump(
    "loft",
    new Loft([0, 0, 0], [new Polygon2D([[2, 2], [-2, 2], [-2, -2], [2, -2]]), new Polygon2D([[1.4, 0], [0, 1.4], [-1.4, 0], [0, -1.4]])], {
        h: 2,
    }),
    { minX: -3.5, minY: -3.5, minZ: -3.5, size: 7 },
    D47,
)
