import ts from "typescript"
import { BijectiveMap } from "../collections/bijectiveMap.mjs"
import { WRAP_PREFIX, WRAP_SUFFIX } from "../parser/source-parser.mjs"
import type { Vec3 } from "../vecmat/vector.mjs"
import {
    Node,
    BinaryOperator,
    UnaryOperator,
    CompileResult,
    FLUENT_METHODS,
    fluent,
    type BlendMode,
    type IntersectionType,
} from "./base.mjs"
import { Box, box } from "./primitives/box.mjs"
import { Polygon2D, polygon2d } from "./primitives/polygon2d.mjs"
import { union } from "./operators/union.mjs"
import { subtract } from "./operators/subtract.mjs"
import { intersect } from "./operators/intersect.mjs"
import { pipe } from "./operators/pipe.mjs"
import { engrave } from "./operators/engrave.mjs"
import { groove } from "./operators/groove.mjs"
import { tongue } from "./operators/tongue.mjs"
import { morph } from "./operators/morph.mjs"
import { seam } from "./operators/seam.mjs"
import "./operators/rotate.mjs"
import "./operators/shell.mjs"
import "./operators/offset.mjs"
import "./operators/elongate.mjs"
import "./operators/twist.mjs"
import "./operators/bend.mjs"
import "./operators/taper.mjs"
import { Sphere, sphere } from "./primitives/sphere.mjs"
import { Cylinder, cylinder } from "./primitives/cylinder.mjs"
import { Cone, cone } from "./primitives/cone.mjs"
import { Torus, torus } from "./primitives/torus.mjs"
import { Capsule, capsule } from "./primitives/capsule.mjs"
import { PlaneNode, plane } from "./primitives/plane.mjs"
import { HexPrism, hexprism } from "./primitives/hexprism.mjs"
import { Disc, disc } from "./primitives/disc.mjs"
import { Blob, blob } from "./primitives/blob.mjs"
import { Extrude, extrude } from "./primitives/extrude.mjs"
import { Lathe, lathe } from "./primitives/lathe.mjs"
import { Loft, loft } from "./primitives/loft.mjs"
import { Union } from "./operators/union.mjs"
import { Subtract } from "./operators/subtract.mjs"
import { Intersect } from "./operators/intersect.mjs"
import { Pipe } from "./operators/pipe.mjs"
import { Engrave } from "./operators/engrave.mjs"
import { Groove } from "./operators/groove.mjs"
import { Tongue } from "./operators/tongue.mjs"
import { Morph } from "./operators/morph.mjs"
import { Seam } from "./operators/seam.mjs"
import { Rotate } from "./operators/rotate.mjs"
import { Shell } from "./operators/shell.mjs"
import { Offset } from "./operators/offset.mjs"
import { Elongate } from "./operators/elongate.mjs"
import { Twist } from "./operators/twist.mjs"
import { Bend } from "./operators/bend.mjs"
import { Taper } from "./operators/taper.mjs"

export type { CompileResult }
export { FLUENT_METHODS, fluent }
export type { BlendMode, IntersectionType }
export type { UnionType } from "./base.mjs"
export { Node, UnaryOperator, BinaryOperator }
export { Union, Subtract, Intersect, Pipe, Engrave, Groove, Tongue, Morph, Seam }
export { Shell, Offset, Elongate, Twist, Bend, Taper, Rotate }
export { Box, Sphere, Cylinder, Cone, Torus, Capsule, PlaneNode, HexPrism, Disc, Blob }
export { Polygon2D, Extrude, Lathe, Loft }
export { box, sphere, cylinder, cone, torus, capsule, plane, hexprism, disc, blob }
export { polygon2d, extrude, loft, lathe }
export { union, subtract, intersect, pipe, engrave, groove, tongue, morph, seam }

/** Minimum primitives in a subtree for it to receive an AABB guard. */
const AABB_GUARD_THRESHOLD = 4

export class SceneInfo {
    readonly root: Node
    numArgs = 0
    #nodes = new BijectiveMap<number, Node>()
    numAABBSlots = 0
    totalPolygonVertices = 0

    nextArgIndex(): number {
        return this.numArgs++
    }

    nextAABBIndex(): number {
        return this.numAABBSlots++
    }

    allocPolygonVertices(count: number): number {
        const base = this.totalPolygonVertices
        this.totalPolygonVertices += count
        return base
    }

    add(node: Node) {
        if (this.#nodes.hasValue(node)) return
        node.id = this.#nodes.size
        this.#nodes.set(node.id, node)
    }

    get<T extends Node>(id: number): T {
        return this.#nodes.get(id) as T
    }

    getAllNodes(): Node[] {
        return Array.from(this.#nodes.values())
    }

    getPolygonVertexData(): Float32Array {
        const data = new Float32Array(this.totalPolygonVertices * 2)
        for (const node of this.#nodes.values()) {
            if (node instanceof Polygon2D && node.bufferOffset >= 0) {
                for (let i = 0; i < node.vertices.length; i++) {
                    const base = (node.bufferOffset + i) * 2
                    data[base] = node.vertices[i][0]
                    data[base + 1] = node.vertices[i][1]
                }
            }
        }
        return data
    }

    constructor(src: string) {
        const wrapped = WRAP_PREFIX + src + WRAP_SUFFIX
        const result = ts.transpileModule(wrapped, {
            compilerOptions: {
                module: ts.ModuleKind.None,
                target: ts.ScriptTarget.ESNext,
            },
        })
        if (result.diagnostics && result.diagnostics.length > 0) {
            const first = result.diagnostics[0]
            const msg = typeof first.messageText === "string"
                ? first.messageText
                : first.messageText.messageText
            throw new Error(msg)
        }
        const body = result.outputText + "\nreturn _();"
        this.root = new Function("box", "sphere", "subtract", "union", "cylinder", "cone", "torus", "capsule", "plane", "hexprism", "disc", "blob", "intersect", "pipe", "engrave", "groove", "tongue", "polygon2d", "extrude", "loft", "lathe", "morph", "seam", body)(
            box, sphere, subtract, union, cylinder, cone, torus, capsule, plane, hexprism, disc, blob,
            intersect, pipe, engrave, groove, tongue, polygon2d, extrude, loft, lathe, morph, seam)
        this.root.scene = this
        this.root.build()
        this.#assignAABBIndices(this.root)
    }

    #assignAABBIndices(node: Node) {
        if (node instanceof BinaryOperator) {
            this.#assignAABBIndices(node.lh)
            this.#assignAABBIndices(node.rh)
            if (node.rh.primitiveCount() >= AABB_GUARD_THRESHOLD) {
                node.rh.aabbIndex = this.nextAABBIndex()
            }
        } else if (node instanceof UnaryOperator) {
            this.#assignAABBIndices(node.arg)
        }
    }

    compile(): string {
        const compiledResult = this.root.compile(1)
        return `\nreturn ${compiledResult.text};\n`
    }

    compileFast(): string {
        const compiledResult = this.root.compileFast(1)
        return `\nreturn ${compiledResult.text};\n`
    }

    compileEdgeHelpers(): string {
        const boxes = Array.from(this.#nodes.values())
            .filter((node): node is Box => node instanceof Box)
        let code = ""
        for (const b of boxes) {
            code += `case ${b.id}u: { (*posOut) = ${b.pos.wgsl}; (*halfOut) = ${b.size.wgsl}; return true; }\n`
        }
        return code
    }

    compileAux(): string {
        let code = ""
        for (const node of this.#nodes.values()) {
            code += node.compileAux()
        }
        return code
    }

    compileAuxFast(): string {
        let code = ""
        for (const node of this.#nodes.values()) {
            code += node.compileAuxFast()
        }
        return code
    }

    getGuardedSubtrees(): { aabbIndex: number; node: Node; fastAux: string; fastSDF: string }[] {
        const result: { aabbIndex: number; node: Node; fastAux: string; fastSDF: string }[] = []
        for (const node of this.#nodes.values()) {
            if (node.aabbIndex >= 0) {
                const fastAux = this.#collectSubtreeAuxFast(node)
                const fastSDF = node.compileFast().text!
                result.push({ aabbIndex: node.aabbIndex, node, fastAux, fastSDF })
            }
        }
        return result
    }

    #collectSubtreeAuxFast(node: Node): string {
        let code = node.compileAuxFast()
        if (node instanceof BinaryOperator) {
            code = this.#collectSubtreeAuxFast(node.lh) + this.#collectSubtreeAuxFast(node.rh) + code
        } else if (node instanceof UnaryOperator) {
            code = this.#collectSubtreeAuxFast(node.arg) + code
        }
        return code
    }
}

// Other methods we want to show as "fluent methods" (rotate, shell, etc. are added by their operator modules)
for (const name of ["pattern", "profile", "sections"]) FLUENT_METHODS.add(name)
