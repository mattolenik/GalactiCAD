import type { Vec3 } from "../vecmat/vector.mjs"
import { vec3 } from "../vecmat/vector.mjs"
import { BinaryOperator, Node, setNodeCloneImpl, UnaryOperator } from "./base.mjs"
import { Bend } from "./operators/bend.mjs"
import { Elongate } from "./operators/elongate.mjs"
import { Engrave } from "./operators/engrave.mjs"
import { Groove } from "./operators/groove.mjs"
import { KnurlSubtract } from "./operators/knurl.mjs"
import { Intersect } from "./operators/intersect.mjs"
import { Morph } from "./operators/morph.mjs"
import { Offset } from "./operators/offset.mjs"
import { Pipe } from "./operators/pipe.mjs"
import { RepeatPolar } from "./operators/repeat_polar.mjs"
import { Rotate } from "./operators/rotate.mjs"
import { Scale } from "./operators/scale.mjs"
import { Seam } from "./operators/seam.mjs"
import { Shell } from "./operators/shell.mjs"
import { Subtract } from "./operators/subtract.mjs"
import { Taper } from "./operators/taper.mjs"
import { Translate } from "./operators/translate.mjs"
import { Tongue } from "./operators/tongue.mjs"
import { Twist } from "./operators/twist.mjs"
import { Union } from "./operators/union.mjs"
import { Blob } from "./primitives/blob.mjs"
import { Box } from "./primitives/box.mjs"
import { Capsule } from "./primitives/capsule.mjs"
import { Cone } from "./primitives/cone.mjs"
import { Cylinder } from "./primitives/cylinder.mjs"
import { Disc } from "./primitives/disc.mjs"
import { Extrude } from "./primitives/extrude.mjs"
import { HexPrism } from "./primitives/hexprism.mjs"
import { Lathe } from "./primitives/lathe.mjs"
import { Loft } from "./primitives/loft.mjs"
import { PlaneNode } from "./primitives/plane.mjs"
import { Polygon2D } from "./primitives/polygon2d.mjs"
import { Path2DNode } from "./primitives/path2d.mjs"
import { Sphere } from "./primitives/sphere.mjs"
import { ThreadedRod } from "./primitives/threaded-rod.mjs"
import { Torus } from "./primitives/torus.mjs"
import { VirtualCapNode } from "./primitives/virtual-cap.mjs"

function pos3(n: { pos: { x: number; y: number; z: number } }): Vec3 {
    return [n.pos.x, n.pos.y, n.pos.z]
}

function isDefaultPosition(n: { pos: { x: number; y: number; z: number } }): boolean {
    return n.pos.x === 0 && n.pos.y === 0 && n.pos.z === 0
}

/** Reset scene-build state and point every node at `root` as the graph root. */
function finalizeDetachedClone(root: Node): void {
    function walk(n: Node): void {
        n.root = root
        n.paramOffset = 0
        n.paramCount = 0
        n.bvhBoundsOffset = -1
        n.previewBvhVec3Slot = -1
        n.previewF32Slot = -1
        n.previewVec2Slot = -1
        n.previewVec3Slot = -1
        n.previewMat3Slot = -1
        if (n instanceof Polygon2D) {
            n.bufferOffset = -1
        }
        if (n instanceof UnaryOperator) {
            walk(n.arg)
        } else if (n instanceof BinaryOperator) {
            walk(n.lh)
            walk(n.rh)
        } else if (n instanceof Union) {
            for (const c of n.children) walk(c)
        } else if (n instanceof Extrude) {
            walk(n.child)
            walk(n.capTop)
            walk(n.capBottom)
        } else if (n instanceof Loft) {
            for (const p of n.profiles) walk(p)
        } else if (n instanceof Lathe) {
            walk(n.child)
        } else if (n instanceof ThreadedRod) {
            walk(n.capTop)
            walk(n.capBottom)
        }
    }
    walk(root)
}

function cloneNodeTreeCore(node: Node): Node {
    if (node instanceof KnurlSubtract) {
        return new KnurlSubtract(cloneNodeTreeCore(node.lh), cloneNodeTreeCore(node.rh))
    }
    if (node instanceof Union) {
        return new Union(
            node.children.map(c => cloneNodeTreeCore(c)),
            node.radius,
            node.mode,
            node.n,
        )
    }
    if (node instanceof Extrude) {
        const child = cloneNodeTreeCore(node.child) as Polygon2D
        const e = new Extrude(child, { h: node.h, t: node.twistDegrees })
        e.pos = vec3(node.pos)
        return e
    }
    if (node instanceof Loft) {
        const profiles = node.profiles.map(p => cloneNodeTreeCore(p) as Polygon2D)
        return isDefaultPosition(node)
            ? new Loft(profiles, { h: node.h })
            : new Loft(pos3(node), profiles, { h: node.h })
    }
    if (node instanceof Lathe) {
        const child = cloneNodeTreeCore(node.child) as Polygon2D
        return isDefaultPosition(node) ? new Lathe(child) : new Lathe(pos3(node), child)
    }
    if (node instanceof ThreadedRod) {
        const u = new ThreadedRod(pos3(node), {
            r: node.r,
            h: node.h,
            pitch: node.turnPitch,
            threadProfile: node.threadProfile,
            handedness: node.handedness,
            threadAngle: node.threadFlankAngleDeg,
            ...(node.explicitDepth ? { depth: node.threadAmp } : {}),
        })
        u.filletTop = node.filletTop
        u.filletBottom = node.filletBottom
        u.chamferTop = node.chamferTop
        u.chamferBottom = node.chamferBottom
        u.femalePlay = node.femalePlay
        return u
    }
    if (node instanceof Subtract) {
        return new Subtract(
            cloneNodeTreeCore(node.lh),
            cloneNodeTreeCore(node.rh),
            node.radius,
            node.mode,
            node.n,
        )
    }
    if (node instanceof Intersect) {
        return new Intersect(
            cloneNodeTreeCore(node.lh),
            cloneNodeTreeCore(node.rh),
            node.radius,
            node.mode,
            node.n,
        )
    }
    if (node instanceof Pipe) {
        return new Pipe(cloneNodeTreeCore(node.lh), cloneNodeTreeCore(node.rh), node.pipeRadius)
    }
    if (node instanceof Morph) {
        return new Morph(node.morphT, cloneNodeTreeCore(node.lh), cloneNodeTreeCore(node.rh))
    }
    if (node instanceof Engrave) {
        return new Engrave(cloneNodeTreeCore(node.lh), cloneNodeTreeCore(node.rh), node.engraveRadius)
    }
    if (node instanceof Groove) {
        return new Groove(cloneNodeTreeCore(node.lh), cloneNodeTreeCore(node.rh), node.ra, node.rb)
    }
    if (node instanceof Tongue) {
        return new Tongue(cloneNodeTreeCore(node.lh), cloneNodeTreeCore(node.rh), node.ra, node.rb)
    }
    if (node instanceof Seam) {
        return new Seam(cloneNodeTreeCore(node.lh), cloneNodeTreeCore(node.rh), node.seamRadius)
    }
    if (node instanceof Rotate) {
        return new Rotate([node.rx, node.ry, node.rz], cloneNodeTreeCore(node.arg))
    }
    if (node instanceof Translate) {
        return new Translate([node.dx, node.dy, node.dz], cloneNodeTreeCore(node.arg))
    }
    if (node instanceof Scale) {
        return new Scale([node.sx, node.sy, node.sz], cloneNodeTreeCore(node.arg))
    }
    if (node instanceof Shell) {
        return new Shell(node.thickness, cloneNodeTreeCore(node.arg))
    }
    if (node instanceof Offset) {
        return new Offset(node.amount, cloneNodeTreeCore(node.arg))
    }
    if (node instanceof Elongate) {
        return new Elongate([node.hx, node.hy, node.hz], cloneNodeTreeCore(node.arg))
    }
    if (node instanceof Twist) {
        return new Twist(node.rate, cloneNodeTreeCore(node.arg))
    }
    if (node instanceof Bend) {
        return new Bend(node.amount, cloneNodeTreeCore(node.arg))
    }
    if (node instanceof Taper) {
        return new Taper(node.ratio, node.height, cloneNodeTreeCore(node.arg))
    }
    if (node instanceof RepeatPolar) {
        return new RepeatPolar(node.repetitions, cloneNodeTreeCore(node.arg))
    }
    if (node instanceof VirtualCapNode) {
        return new VirtualCapNode(node.isTop)
    }
    if (node instanceof Sphere) {
        return new Sphere(pos3(node), { r: node.r })
    }
    if (node instanceof Box) {
        const b = new Box(pos3(node), [node.size.x, node.size.y, node.size.z])
        b.rot = vec3([node.rot.x, node.rot.y, node.rot.z])
        return b
    }
    if (node instanceof Cylinder) {
        const c = new Cylinder(pos3(node), { r: node.r, h: node.h })
        c.filletTop = node.filletTop
        c.filletBottom = node.filletBottom
        c.chamferTop = node.chamferTop
        c.chamferBottom = node.chamferBottom
        return c
    }
    if (node instanceof Cone) {
        return new Cone(pos3(node), { r: node.r, h: node.h })
    }
    if (node instanceof Torus) {
        return new Torus(pos3(node), { sr: node.sr, lr: node.lr })
    }
    if (node instanceof Capsule) {
        return new Capsule(pos3(node), { r: node.r, c: node.c })
    }
    if (node instanceof PlaneNode) {
        return new PlaneNode(pos3(node), {
            n: [node.normal.x, node.normal.y, node.normal.z],
            dist: node.dist,
        })
    }
    if (node instanceof HexPrism) {
        return new HexPrism(pos3(node), { r: node.r, h: node.h })
    }
    if (node instanceof Disc) {
        return new Disc(pos3(node), { r: node.r })
    }
    if (node instanceof Blob) {
        return new Blob(pos3(node))
    }
    if (node instanceof Path2DNode) {
        // Must precede the Polygon2D branch (Path2DNode extends it); the constructor
        // deep-copies the authored elements.
        return new Path2DNode(node.elements)
    }
    if (node instanceof Polygon2D) {
        return new Polygon2D(node.vertices.map(v => [v[0], v[1]] as [number, number]))
    }

    throw new Error(`Node.clone(): unsupported node type ${node.constructor.name}`)
}

function cloneNodeTreeImpl(node: Node): Node {
    const root = cloneNodeTreeCore(node)
    finalizeDetachedClone(root)
    return root
}

setNodeCloneImpl(cloneNodeTreeImpl)
