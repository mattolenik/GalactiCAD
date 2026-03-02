import ts from "typescript"
import { BijectiveMap } from "../collections/bijectiveMap.mjs"
import { WRAP_PREFIX, WRAP_SUFFIX } from "../parser/source-parser.mjs"
import { BinaryOperator, CompileResult, Node, UnaryOperator, fluent, styleInfo, type BlendMode, type IntersectionType, type StyleInfo, type UnionType } from "./base.mjs"
import { Bend, bend } from "./operators/bend.mjs"
import { Elongate, elongate } from "./operators/elongate.mjs"
import { Engrave, engrave } from "./operators/engrave.mjs"
import { Groove, groove } from "./operators/groove.mjs"
import { Intersect, intersect } from "./operators/intersect.mjs"
import { Morph, morph } from "./operators/morph.mjs"
import { Offset, offset } from "./operators/offset.mjs"
import { Pipe, pipe } from "./operators/pipe.mjs"
import { Rotate, rotate } from "./operators/rotate.mjs"
import { Seam, seam } from "./operators/seam.mjs"
import { Shell, shell } from "./operators/shell.mjs"
import { Subtract, subtract } from "./operators/subtract.mjs"
import { Taper, taper } from "./operators/taper.mjs"
import { Tongue, tongue } from "./operators/tongue.mjs"
import { Twist, twist } from "./operators/twist.mjs"
import { Union, union } from "./operators/union.mjs"
import { Blob, blob } from "./primitives/blob.mjs"
import { Box, box } from "./primitives/box.mjs"
import { Capsule, capsule } from "./primitives/capsule.mjs"
import { Cone, cone } from "./primitives/cone.mjs"
import { Cylinder, cylinder } from "./primitives/cylinder.mjs"
import { Disc, disc } from "./primitives/disc.mjs"
import { Extrude, extrude } from "./primitives/extrude.mjs"
import { HexPrism, hexprism } from "./primitives/hexprism.mjs"
import { Lathe, lathe } from "./primitives/lathe.mjs"
import { Loft, loft } from "./primitives/loft.mjs"
import { PlaneNode, plane } from "./primitives/plane.mjs"
import { Polygon2D, polygon2d } from "./primitives/polygon2d.mjs"
import { Sphere, sphere } from "./primitives/sphere.mjs"
import { Torus, torus } from "./primitives/torus.mjs"

export { Bend, BinaryOperator, Blob, Box, Capsule, Cone, Cylinder, Disc, Elongate, Engrave, Extrude, Groove, HexPrism, Intersect, Lathe, Loft, Morph, Node, Offset, Pipe, PlaneNode, Polygon2D, Rotate, Seam, Shell, Sphere, Subtract, Taper, Tongue, Torus, Twist, UnaryOperator, Union, bend, blob, box, capsule, cone, cylinder, disc, elongate, engrave, extrude, fluent, groove, hexprism, intersect, lathe, loft, morph, offset, pipe, plane, polygon2d, rotate, seam, shell, sphere, subtract, styleInfo, taper, tongue, torus, twist, union }
export type { BlendMode, CompileResult, IntersectionType, StyleInfo, UnionType }

/** IDs 1022–1023 reserved for face highlight (cap selection). Scene nodes use 0–1021. */
const MAX_SCENE_NODE_ID = 1021

export class SceneInfo {
    readonly root: Node
    numArgs = 0
    #nodes = new BijectiveMap<number, Node>()
    totalPolygonVertices = 0

    nextArgIndex(): number {
        return this.numArgs++
    }

    allocPolygonVertices(count: number): number {
        const base = this.totalPolygonVertices
        this.totalPolygonVertices += count
        return base
    }

    add(node: Node) {
        if (this.#nodes.hasValue(node)) return
        const id = this.#nodes.size
        if (id > MAX_SCENE_NODE_ID) {
            throw new Error(`Scene has too many nodes (max ${MAX_SCENE_NODE_ID + 1})`)
        }
        node.id = id
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
        this.root = new Function("box", "sphere", "subtract", "union", "cylinder", "cone", "torus", "capsule", "plane", "hexprism", "disc", "blob", "intersect", "pipe", "engrave", "groove", "tongue", "polygon2d", "extrude", "loft", "lathe", "morph", "seam", "rotate", "shell", "offset", "elongate", "twist", "bend", "taper", body)(
            box, sphere, subtract, union, cylinder, cone, torus, capsule, plane, hexprism, disc, blob,
            intersect, pipe, engrave, groove, tongue, polygon2d, extrude, loft, lathe, morph, seam,
            rotate, shell, offset, elongate, twist, bend, taper)
        this.root.scene = this
        this.root.build()
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
        let code = ""
        for (const node of this.#nodes.values()) {
            if (node instanceof Box) {
                code += `case ${node.id}u: { (*posOut) = ${node.pos.wgsl}; (*halfOut) = ${node.size.wgsl}; return true; }\n`
            }
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
}

// Other methods we want to show as "fluent methods" (rotate, shell, etc. are added by their operator modules)
for (const name of ["pattern", "profile", "sections"]) styleInfo.FluentMethods.add(name)
