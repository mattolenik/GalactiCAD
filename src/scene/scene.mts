import { BijectiveMap } from "../collections/bijectiveMap.mjs"
import type { AABB } from "./aabb.mjs"
import { BinaryOperator, BVH_MIN_COST, CompileResult, Node, UnaryOperator, fluent, styleInfo, type BlendMode, type IntersectionType, type StyleInfo, type UnionType } from "./base.mjs"
import {
    PREVIEW_MAT3_PACK_FLOATS,
    PREVIEW_UNIFORM_F32_COUNT,
    PREVIEW_UNIFORM_MAT3_COUNT,
    PREVIEW_UNIFORM_VEC2_COUNT,
    PREVIEW_UNIFORM_VEC3_COUNT,
    SCENE_PARAM_BOUNDS_F32_COUNT,
    SCENE_PARAMS_F32_CAPACITY,
    setCompileParamMode,
    vec3Wgsl,
} from "./scene-params.mjs"
import { Bend, bend } from "./operators/bend.mjs"
import { Elongate, elongate } from "./operators/elongate.mjs"
import { Engrave, engrave } from "./operators/engrave.mjs"
import { Groove, groove } from "./operators/groove.mjs"
import { knurl, KnurlBuilder, KnurlSubtract } from "./operators/knurl.mjs"
import { Intersect, intersect } from "./operators/intersect.mjs"
import { Morph, morph } from "./operators/morph.mjs"
import { Offset, offset } from "./operators/offset.mjs"
import { Pipe, pipe } from "./operators/pipe.mjs"
import { Rotate, rotate } from "./operators/rotate.mjs"
import { Scale, scale } from "./operators/scale.mjs"
import { Seam, seam } from "./operators/seam.mjs"
import { Shell, shell } from "./operators/shell.mjs"
import { Subtract, subtract } from "./operators/subtract.mjs"
import { Taper, taper } from "./operators/taper.mjs"
import { Translate, translate } from "./operators/translate.mjs"
import { Tongue, tongue } from "./operators/tongue.mjs"
import { RepeatPolar, repeatPolar } from "./operators/repeat_polar.mjs"
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
import { Lathe, compileLathePrimitiveEdgeHitCase, compileLathePrimitiveRingDistanceCase, lathe } from "./primitives/lathe.mjs"
import { Loft, loft } from "./primitives/loft.mjs"
import { PlaneNode, plane } from "./primitives/plane.mjs"
import { Polygon2D, polygon2d } from "./primitives/polygon2d.mjs"
import { Sphere, sphere } from "./primitives/sphere.mjs"
import { VirtualCapNode } from "./primitives/virtual-cap.mjs"
import { ThreadedRod, threaded_rod } from "./primitives/threaded-rod.mjs"
import { Torus, torus } from "./primitives/torus.mjs"
import { BACK, BOTTOM, FRONT, LEFT, RIGHT, TOP } from "./direction-indicator.mjs"
import "./node-clone.mjs"

export { Bend, BinaryOperator, Blob, Box, Capsule, Cone, Cylinder, Disc, Elongate, Engrave, Extrude, Groove, HexPrism, Intersect, knurl, KnurlBuilder, KnurlSubtract, Lathe, Loft, Morph, Node, Offset, Pipe, PlaneNode, Polygon2D, RepeatPolar, Rotate, Scale, Seam, Shell, Sphere, Subtract, Taper, ThreadedRod, Tongue, Torus, Translate, Twist, UnaryOperator, Union, VirtualCapNode, bend, blob, box, capsule, cone, cylinder, disc, elongate, engrave, extrude, fluent, groove, hexprism, intersect, lathe, loft, morph, offset, pipe, plane, polygon2d, repeatPolar, rotate, scale, seam, shell, sphere, subtract, styleInfo, taper, threaded_rod, tongue, torus, translate, twist, union }
export type { BlendMode, CompileResult, IntersectionType, StyleInfo, UnionType }
export { BACK, BOTTOM, FRONT, LEFT, RIGHT, TOP } from "./direction-indicator.mjs"
export type { DirectionFlag, DirectionIndicator } from "./direction-indicator.mjs"

/**
 * Direct child nodes of `node`, following its child-holding fields. The single
 * source of truth for the scene tree's parent→child links — used both for
 * serialization and for walking up to the nearest isolatable ancestor.
 */
export function childNodes(node: Node): Node[] {
    if (node instanceof Union) return [...node.children]
    if (node instanceof BinaryOperator) return [node.lh, node.rh]
    if (node instanceof UnaryOperator) return [node.arg]
    if (node instanceof Extrude) return [node.child, node.capTop, node.capBottom]
    if (node instanceof Loft) return [...node.profiles]
    if (node instanceof ThreadedRod) return [node.capTop, node.capBottom]
    if (node instanceof Lathe) return [node.child]
    return []
}

/** IDs 1022–1023 reserved for face highlight (cap selection). Scene nodes use 0–1021. */
const MAX_SCENE_NODE_ID = 1021

export class SceneInfo {
    readonly root: Node
    #nodes = new BijectiveMap<number, Node>()
    /** Stable registration order; same as repeated `getAllNodes()` before caching. */
    #allNodesSnapshot: Node[] = []
    /** One `computeBounds()` result per node id for this scene build. */
    #boundsCache = new Map<number, AABB | null>()
    /** Lazily-built child-id → parent map for walking up to isolatable ancestors. */
    #parentByChildId: Map<number, Node> | null = null
    #sceneParamFloatUsed = 0
    #previewF32Used = 0
    #previewVec2Used = 0
    #previewVec3Used = 0
    #previewMat3Used = 0
    totalPolygonVertices = 0
    /** Whether to emit BVH bounding checks during code generation. Default: true. */
    bvhEnabled = true

    allocSceneParamFloats(count: number): number {
        if (count <= 0) return 0
        const start = this.#sceneParamFloatUsed
        const next = start + count
        if (next > SCENE_PARAMS_F32_CAPACITY) {
            throw new Error(
                `Scene parameter buffer overflow (need ${next} f32 slots, max ${SCENE_PARAMS_F32_CAPACITY})`,
            )
        }
        this.#sceneParamFloatUsed = next
        return start
    }

    allocPreviewF32(count: number): number {
        if (count <= 0) return 0
        const start = this.#previewF32Used
        const next = start + count
        if (next > PREVIEW_UNIFORM_F32_COUNT) {
            throw new Error(
                `Preview f32 uniform bank overflow (need ${next} slots, max ${PREVIEW_UNIFORM_F32_COUNT})`,
            )
        }
        this.#previewF32Used = next
        return start
    }

    allocPreviewVec2(count: number): number {
        if (count <= 0) return 0
        const start = this.#previewVec2Used
        const next = start + count
        if (next > PREVIEW_UNIFORM_VEC2_COUNT) {
            throw new Error(
                `Preview vec2 uniform bank overflow (need ${next} slots, max ${PREVIEW_UNIFORM_VEC2_COUNT})`,
            )
        }
        this.#previewVec2Used = next
        return start
    }

    allocPreviewVec3(count: number): number {
        if (count <= 0) return 0
        const start = this.#previewVec3Used
        const next = start + count
        if (next > PREVIEW_UNIFORM_VEC3_COUNT) {
            throw new Error(
                `Preview vec3 uniform bank overflow (need ${next} slots, max ${PREVIEW_UNIFORM_VEC3_COUNT})`,
            )
        }
        this.#previewVec3Used = next
        return start
    }

    allocPreviewMat3(count: number): number {
        if (count <= 0) return 0
        const start = this.#previewMat3Used
        const next = start + count
        if (next > PREVIEW_UNIFORM_MAT3_COUNT) {
            throw new Error(
                `Preview mat3 uniform bank overflow (need ${next} slots, max ${PREVIEW_UNIFORM_MAT3_COUNT})`,
            )
        }
        this.#previewMat3Used = next
        return start
    }

    get sceneParamFloatCount(): number {
        return this.#sceneParamFloatUsed
    }

    get previewParamFingerprint(): string {
        return `${this.#previewF32Used}:${this.#previewVec2Used}:${this.#previewVec3Used}:${this.#previewMat3Used}`
    }

    /** Memoize `computeBounds()` once per node for this scene (see `Node.computeBounds`). */
    getOrComputeBoundsForNode(node: Node, compute: () => AABB | null): AABB | null {
        if (this.#boundsCache.has(node.id)) {
            return this.#boundsCache.get(node.id)!
        }
        const b = compute()
        this.#boundsCache.set(node.id, b)
        return b
    }

    /**
     * Pack scene params into a caller-supplied buffer (must be sized for at
     * least `sceneParamFloatCount`). Returns the used prefix length so the
     * caller can `.subarray(0, n)` for the GPU upload. Avoids the per-build
     * `new Float32Array(used)` allocation in `packSceneParams()`.
     */
    packSceneParamsInto(out: Float32Array): number {
        // Zero the used prefix so leftover bytes from a previous, larger
        // build can't leak into slots a node doesn't write this round.
        out.fill(0, 0, this.#sceneParamFloatUsed)
        for (const node of this.#allNodesSnapshot) {
            if (node.paramCount > 0) {
                node.writeSceneParams(out.subarray(node.paramOffset, node.paramOffset + node.paramCount))
            }
            if (node.bvhBoundsOffset >= 0) {
                const b = node.computeBounds()
                if (b) {
                    const v = out.subarray(node.bvhBoundsOffset, node.bvhBoundsOffset + SCENE_PARAM_BOUNDS_F32_COUNT)
                    v[0] = b.cx
                    v[1] = b.cy
                    v[2] = b.cz
                    v[3] = b.hx
                    v[4] = b.hy
                    v[5] = b.hz
                }
            }
        }
        return this.#sceneParamFloatUsed
    }

    /** Allocating wrapper for callers that don't have a scratch buffer (tests, one-shot export paths). */
    packSceneParams(): Float32Array {
        const out = new Float32Array(this.#sceneParamFloatUsed)
        this.packSceneParamsInto(out)
        return out
    }

    /**
     * Pack preview uniform banks into caller-supplied target buffers (each
     * must be sized for the worst-case capacity — see
     * `PREVIEW_UNIFORM_*_COUNT`). Returns the used prefix length per bank.
     * Lets the worker pack straight into its persistent shadow arrays,
     * eliminating both the per-build allocations and the follow-up
     * `shadow.set(p.f32)` copy.
     */
    packPreviewParamsInto(out: import("./scene-params.mjs").PreviewParamsOut): {
        f32: number
        vec2: number
        vec3: number
        mat3: number
    } {
        const f32Used = this.#previewF32Used
        const vec2Used = this.#previewVec2Used * 2
        const vec3Used = this.#previewVec3Used * 4
        const mat3Used = this.#previewMat3Used * PREVIEW_MAT3_PACK_FLOATS
        // Zero only the prefixes we're about to write; capacity tails stay
        // whatever they were (the GPU side only reads the prefix).
        out.f32.fill(0, 0, f32Used)
        out.vec2.fill(0, 0, vec2Used)
        out.vec3.fill(0, 0, vec3Used)
        out.mat3.fill(0, 0, mat3Used)
        for (const node of this.#allNodesSnapshot) {
            node.writePreviewParams(out)
        }
        for (const node of this.#allNodesSnapshot) {
            if (node.previewBvhVec3Slot >= 0) {
                const b = node.computeBounds()
                if (b) {
                    const v = out.vec3
                    const base = node.previewBvhVec3Slot * 4
                    v[base] = b.cx
                    v[base + 1] = b.cy
                    v[base + 2] = b.cz
                    v[base + 3] = 0
                    v[base + 4] = b.hx
                    v[base + 5] = b.hy
                    v[base + 6] = b.hz
                    v[base + 7] = 0
                }
            }
        }
        return { f32: f32Used, vec2: vec2Used, vec3: vec3Used, mat3: mat3Used }
    }

    /** Allocating wrapper, used by tests and any caller that doesn't manage scratch buffers. */
    packPreviewParams(): import("./scene-params.mjs").PreviewParamsOut {
        const out = {
            f32: new Float32Array(this.#previewF32Used),
            vec2: new Float32Array(this.#previewVec2Used * 2),
            vec3: new Float32Array(this.#previewVec3Used * 4),
            mat3: new Float32Array(this.#previewMat3Used * PREVIEW_MAT3_PACK_FLOATS),
        }
        this.packPreviewParamsInto(out)
        return out
    }

    /**
     * Reserve a contiguous tail region of the `packSceneParams()` layout for BVH AABBs (6 f32 per qualifying node).
     * Runs after `root.build()` so all `paramOffset` regions are allocated first; bounds slots are packed
     * together for cache locality when union guards walk children.
     */
    #assignBvhBoundsSlots(): void {
        if (!this.bvhEnabled) {
            for (const node of this.#allNodesSnapshot) {
                node.bvhBoundsOffset = -1
                node.previewBvhVec3Slot = -1
            }
            return
        }
        for (const node of this.#allNodesSnapshot) {
            if (node.codegenCost() >= BVH_MIN_COST && node.computeBounds() !== null) {
                node.bvhBoundsOffset = this.allocSceneParamFloats(SCENE_PARAM_BOUNDS_F32_COUNT)
                node.previewBvhVec3Slot = this.allocPreviewVec3(2)
            } else {
                node.bvhBoundsOffset = -1
                node.previewBvhVec3Slot = -1
            }
        }
    }

    allocPolygonVertices(count: number): number {
        const base = this.totalPolygonVertices
        this.totalPolygonVertices += count
        return base
    }

    add(node: Node) {
        if (this.#nodes.hasValue(node)) return
        // 1-indexed: ID 0 is reserved as the "no owner" / "no selection" sentinel
        // throughout the SDF pipeline (e.g. `featureIdA == 0` means "unset" in
        // `sdfMidSetOwner` and the MDC `explicitIdsValid` gate; preview's
        // `faceSelection.nodeId == 0` means "no face selection"). Assigning the
        // first scene node `id == 0` previously caused its owner-stamped LINE
        // feature payloads to be rejected as malformed, defeating MDC's curve
        // projection on scenes whose root is a single primitive.
        const id = this.#nodes.size + 1
        if (id > MAX_SCENE_NODE_ID) {
            throw new Error(`Scene has too many nodes (max ${MAX_SCENE_NODE_ID})`)
        }
        node.id = id
        this.#nodes.set(node.id, node)
    }

    get<T extends Node>(id: number): T {
        return this.#nodes.get(id) as T
    }

    getAllNodes(): Node[] {
        return this.#allNodesSnapshot
    }

    /** Child-id → parent map over the whole tree, built once per scene build. */
    #getParentMap(): Map<number, Node> {
        if (this.#parentByChildId) return this.#parentByChildId
        const m = new Map<number, Node>()
        for (const node of this.#allNodesSnapshot) {
            for (const child of childNodes(node)) m.set(child.id, node)
        }
        this.#parentByChildId = m
        return m
    }

    /**
     * Walk up from `node` (inclusive) to the nearest ancestor that is isolatable.
     * Virtual / 2D nodes (polygon2d, caps) aren't isolatable on their own, so this
     * resolves them to the real-geometry node that uses them (extrude/loft/etc.).
     * Returns null only if no ancestor is isolatable (a free-floating virtual node).
     */
    #nearestIsolatable(node: Node): Node | null {
        const parents = this.#getParentMap()
        let cur: Node | undefined = node
        while (cur && !cur.isIsolatable) cur = parents.get(cur.id)
        return cur ?? null
    }

    /**
     * The root to compile the preview SDF from for "View Isolated". Empty ids →
     * the full scene root. Each id is first remapped to its nearest isolatable
     * ancestor (so isolating a polygon2d isolates the extrude/loft using it), then
     * deduped. A single resolved node → that node directly. Multiple → a temporary
     * sharp Union wrapping the chosen subtrees, given this scene and a reserved
     * non-colliding id. The temp union is NOT built — the wrapped nodes are already
     * built, so their ids / param offsets / BVH slots are reused as-is (no param
     * re-upload needed). Unknown / unresolvable ids are dropped; if none resolve,
     * the full scene is returned. Isolating a node renders it in its LOCAL frame —
     * ancestor warps are stripped because they are not part of the compile root.
     */
    isolationRoot(ids: readonly number[]): Node {
        if (ids.length === 0) return this.root
        const nodes: Node[] = []
        const seen = new Set<number>()
        for (const id of ids) {
            const n = this.#nodes.get(id)
            if (!n) continue
            const target = this.#nearestIsolatable(n)
            if (target && !seen.has(target.id)) {
                seen.add(target.id)
                nodes.push(target)
            }
        }
        if (nodes.length === 0) return this.root
        if (nodes.length === 1) return nodes[0]!
        const u = new Union(nodes)
        u.scene = this
        // Real ids are 1..N (pre-order), so N+1 can't collide with any `_u${id}` var.
        u.id = this.#allNodesSnapshot.length + 1
        return u
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

    /**
     * Structural identity for choosing param-only GPU updates vs full WGSL recompilation.
     * Ignores runtime scalar geometry parameters; includes topology, polygon counts, winding,
     * discretized code-path selectors (twist, CSG blend family), BVH eligibility per node, and `bvhEnabled`.
     */
    structuralFingerprint(): string {
        const parts: string[] = [
            `meta:bvhEnabled:${this.bvhEnabled ? "1" : "0"}`,
            `meta:preview:${this.previewParamFingerprint}`,
        ]
        this.root.appendStructuralFingerprint(parts)
        return parts.join("|")
    }

    constructor(transpiledBody: string, options?: { bvhEnabled?: boolean }) {
        if (options?.bvhEnabled !== undefined) {
            this.bvhEnabled = options.bvhEnabled
        }
        this.root = new Function(
            "box",
            "sphere",
            "subtract",
            "union",
            "cylinder",
            "cone",
            "torus",
            "threaded_rod",
            "capsule",
            "plane",
            "hexprism",
            "disc",
            "blob",
            "intersect",
            "pipe",
            "engrave",
            "groove",
            "tongue",
            "polygon2d",
            "extrude",
            "loft",
            "lathe",
            "morph",
            "seam",
            "rotate",
            "translate",
            "scale",
            "shell",
            "offset",
            "elongate",
            "twist",
            "bend",
            "taper",
            "repeatPolar",
            "knurl",
            "TOP",
            "BOTTOM",
            "LEFT",
            "RIGHT",
            "FRONT",
            "BACK",
            transpiledBody,
        )(
            box,
            sphere,
            subtract,
            union,
            cylinder,
            cone,
            torus,
            threaded_rod,
            capsule,
            plane,
            hexprism,
            disc,
            blob,
            intersect,
            pipe,
            engrave,
            groove,
            tongue,
            polygon2d,
            extrude,
            loft,
            lathe,
            morph,
            seam,
            rotate,
            translate,
            scale,
            shell,
            offset,
            elongate,
            twist,
            bend,
            taper,
            repeatPolar,
            knurl,
            TOP,
            BOTTOM,
            LEFT,
            RIGHT,
            FRONT,
            BACK,
        )
        this.root.scene = this
        this.root.build()
        this.#allNodesSnapshot = Array.from(this.#nodes.values())
        this.#assignBvhBoundsSlots()
    }

    compile(): string {
        setCompileParamMode("storage")
        const compiledResult = this.root.compile(1)
        if (compiledResult.prelude) {
            return `\n${compiledResult.prelude}return ${compiledResult.varName};\n`
        }
        return `\nreturn ${compiledResult.text};\n`
    }

    /** `root` defaults to the full scene root; pass an isolation root (see
     * {@link isolationRoot}) to compile only that subtree for "View Isolated". */
    compileForPreview(root: Node = this.root): string {
        setCompileParamMode("preview")
        const compiledResult = root.compile(1)
        if (compiledResult.prelude) {
            return `\n${compiledResult.prelude}return ${compiledResult.varName};\n`
        }
        return `\nreturn ${compiledResult.text};\n`
    }

    compileFast(): string {
        setCompileParamMode("storage")
        const compiledResult = this.root.compileFast(1)
        if (compiledResult.prelude) {
            return `\n${compiledResult.prelude}return ${compiledResult.varName};\n`
        }
        return `\nreturn ${compiledResult.text};\n`
    }

    compileFastForPreview(root: Node = this.root): string {
        setCompileParamMode("preview")
        const compiledResult = root.compileFast(1)
        if (compiledResult.prelude) {
            return `\n${compiledResult.prelude}return ${compiledResult.varName};\n`
        }
        return `\nreturn ${compiledResult.text};\n`
    }

    /** Every cutter (`rh`) of every `subtract` in the tree — the nodes a subtract hides. */
    subtractedCutters(): Node[] {
        return this.getAllNodes().filter(n => n instanceof Subtract).map(n => (n as Subtract).rh)
    }

    /**
     * Body for the preview shader's `ghostSDF_fast(p)` — the union of every
     * subtracted cutter compiled as its FULL solid (the `subtract` that normally
     * hides it is bypassed here). Each cutter is already a built scene node, so its
     * fast SDF, aux functions and packed params are all valid in the preview
     * shader; we just OR them into a second field the ghost pass marches.
     *
     * Always emitted (cheap empty body when nothing is subtracted); whether it is
     * actually composited is a runtime toggle (`viewSettings.ghostEnabled`), so
     * flipping the toolbar button is a uniform update + repaint, not a rebuild.
     */
    compileGhostFastForPreview(): string {
        const cutters = this.subtractedCutters()
        if (cutters.length === 0) {
            return "return sdfFast(1e9, 1.0, 1.0);"
        }
        setCompileParamMode("preview")
        let blocks = ""
        for (let i = 0; i < cutters.length; i++) {
            const r = cutters[i].compileFast(1)
            const expr = r.prelude ? (r.varName ?? r.text!) : r.text!
            const prelude = r.prelude ?? ""
            // Each cutter gets its own `{ ... }` scope so per-cutter prelude var
            // names (BVH accumulators) can never collide across ghosts.
            blocks += `{\n${prelude}let gc_${i} = ${expr};\nghostAcc = opUnionFast(ghostAcc, gc_${i});\n}\n`
        }
        return `\nvar ghostAcc = sdfFast(1e9, 1.0, 1.0);\n${blocks}return ghostAcc;\n`
    }

    compileMid(): string {
        setCompileParamMode("storage")
        const compiledResult = this.root.compileMid(1)
        if (compiledResult.prelude) {
            return `\n${compiledResult.prelude}return ${compiledResult.varName};\n`
        }
        return `\nreturn ${compiledResult.text};\n`
    }

    compileMidForPreview(): string {
        setCompileParamMode("preview")
        const compiledResult = this.root.compileMid(1)
        if (compiledResult.prelude) {
            return `\n${compiledResult.prelude}return ${compiledResult.varName};\n`
        }
        return `\nreturn ${compiledResult.text};\n`
    }

    compileEdgeHelpers(): string {
        setCompileParamMode("preview")
        let code = ""
        for (const node of this.#nodes.values()) {
            if (node instanceof Box) {
                const o = node.paramOffset
                const pv = node.previewVec3Slot
                code += `case ${node.id}u: { (*posOut) = ${vec3Wgsl(o, pv)}; (*halfOut) = ${vec3Wgsl(o + 3, pv + 1)}; return true; }\n`
            }
        }
        return code
    }

    /** Preview WGSL `switch` cases for lathe primitive ring/pole edge hits (see `tryLathePrimitiveEdgeHit`). */
    compileLathePrimitiveEdgeHitCases(): string {
        let code = ""
        for (const node of this.#nodes.values()) {
            if (node instanceof Lathe) {
                code += compileLathePrimitiveEdgeHitCase(node)
            }
        }
        return code
    }

    /** Preview WGSL `switch` cases for distance from `hitWorld` to a lathe ring/pole at `profileVtx`. */
    compileLathePrimitiveRingDistanceCases(): string {
        let code = ""
        for (const node of this.#nodes.values()) {
            if (node instanceof Lathe) {
                code += compileLathePrimitiveRingDistanceCase(node)
            }
        }
        return code
    }

    compileAux(): string {
        setCompileParamMode("storage")
        let code = ""
        for (const node of this.#nodes.values()) {
            code += node.compileAux()
        }
        return code
    }

    compileAuxPreview(): string {
        setCompileParamMode("preview")
        let code = ""
        for (const node of this.#nodes.values()) {
            code += node.compileAux()
        }
        return code
    }

    compileAuxFast(): string {
        setCompileParamMode("storage")
        let code = ""
        for (const node of this.#nodes.values()) {
            code += node.compileAuxFast()
        }
        return code
    }

    compileAuxFastPreview(): string {
        setCompileParamMode("preview")
        let code = ""
        for (const node of this.#nodes.values()) {
            code += node.compileAuxFast()
        }
        return code
    }

    compileAuxMid(): string {
        setCompileParamMode("storage")
        let code = ""
        for (const node of this.#nodes.values()) {
            code += node.compileAuxMid()
        }
        return code
    }

    compileAuxMidPreview(): string {
        setCompileParamMode("preview")
        let code = ""
        for (const node of this.#nodes.values()) {
            code += node.compileAuxMid()
        }
        return code
    }
}

// Other methods we want to show as "fluent methods" (rotate, shell, etc. are added by their operator modules)
for (const name of ["pattern", "profile", "sections"]) styleInfo.FluentMethods.add(name)
