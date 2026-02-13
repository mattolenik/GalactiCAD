import { MeshoptSimplifier } from "meshoptimizer"
import type { Flags } from "meshoptimizer/simplifier"
import type { MeshData } from "./export.mjs"

/** Floats per vertex in MeshData.verts: [px, py, pz, pad, nx, ny, nz, pad] */
const VERTEX_STRIDE = 8

/** Offset (in floats) to the normal components within a vertex record. */
const NORMAL_OFFSET = 4

/** Number of normal components (nx, ny, nz). */
const NORMAL_COMPONENTS = 3

/** Simplification flags exposed as friendly booleans. */
export interface SimplifyFlags {
    /** Lock boundary (open) edges so they are never collapsed. */
    lockBorder?: boolean
    /** Optimize for meshes with many shared vertex positions. */
    sparse?: boolean
    /** Treat targetError as absolute world-space distance instead of relative. */
    errorAbsolute?: boolean
    /** Remove degenerate (zero-area) triangles from output. */
    prune?: boolean
    /** Bias toward more uniform triangle shapes. */
    regularize?: boolean
    /**
     * Weight for normal-aware simplification.
     * When > 0, uses simplifyWithAttributes to penalize collapsing edges between
     * faces with different normals, protecting sharp CAD edges.
     * 0 or undefined = position-only simplification.
     */
    normalWeight?: number
}

/**
 * Simplify a mesh using meshoptimizer's QEM-based edge collapse.
 *
 * The algorithm reduces triangle count while preserving manifold topology
 * and overall mesh shape. Vertices are compacted afterward so the returned
 * MeshData contains no unreferenced vertices.
 *
 * When normalWeight > 0, uses simplifyWithAttributes so that normals influence
 * the error metric — edges between faces with very different normals (sharp
 * features) become expensive to collapse.
 *
 * @param mesh          Input mesh (interleaved verts, triangle indices).
 * @param targetRatio   Fraction of triangles to keep, 0–1 (e.g. 0.5 = 50%).
 * @param targetError   Maximum geometric error the simplifier may introduce,
 *                      expressed relative to mesh scale. 0 = lossless only.
 * @param flags         Optional meshoptimizer flags.
 */
export async function simplifyMesh(
    mesh: MeshData,
    targetRatio: number,
    targetError: number = 0.01,
    flags?: SimplifyFlags,
): Promise<MeshData> {
    await MeshoptSimplifier.ready

    const inputTriCount = mesh.tris.length / 3
    const targetIndexCount = Math.floor(inputTriCount * Math.max(0, Math.min(1, targetRatio))) * 3

    // Build meshoptimizer flags array from boolean options
    const flagsArray: Flags[] = []
    if (flags?.lockBorder) flagsArray.push("LockBorder")
    if (flags?.sparse) flagsArray.push("Sparse")
    if (flags?.errorAbsolute) flagsArray.push("ErrorAbsolute")
    if (flags?.prune) flagsArray.push("Prune")
    if (flags?.regularize) flagsArray.push("Regularize")
    const flagsArg = flagsArray.length > 0 ? flagsArray : undefined

    const normalWeight = flags?.normalWeight ?? 0

    let simplifiedTris: Uint32Array
    let error: number

    if (normalWeight > 0) {
        // Extract normals into a dense attribute buffer for simplifyWithAttributes
        const vertexCount = mesh.verts.length / VERTEX_STRIDE
        const normals = new Float32Array(vertexCount * NORMAL_COMPONENTS)
        for (let i = 0; i < vertexCount; i++) {
            const srcBase = i * VERTEX_STRIDE + NORMAL_OFFSET
            const dstBase = i * NORMAL_COMPONENTS
            normals[dstBase] = mesh.verts[srcBase]!
            normals[dstBase + 1] = mesh.verts[srcBase + 1]!
            normals[dstBase + 2] = mesh.verts[srcBase + 2]!
        }

        // One weight per attribute component (nx, ny, nz all get the same weight)
        const attributeWeights = [normalWeight, normalWeight, normalWeight]

        ;[simplifiedTris, error] = MeshoptSimplifier.simplifyWithAttributes(
            mesh.tris,
            mesh.verts,
            VERTEX_STRIDE,
            normals,
            NORMAL_COMPONENTS,
            attributeWeights,
            null, // vertex_lock — no locked vertices
            targetIndexCount,
            targetError,
            flagsArg,
        )
    } else {
        ;[simplifiedTris, error] = MeshoptSimplifier.simplify(
            mesh.tris,
            mesh.verts,
            VERTEX_STRIDE,
            targetIndexCount,
            targetError,
            flagsArg,
        )
    }

    const outputTriCount = simplifiedTris.length / 3
    console.log(
        `Mesh simplification: ${inputTriCount} → ${outputTriCount} triangles `
        + `(${((outputTriCount / inputTriCount) * 100).toFixed(1)}%, error=${error.toExponential(3)}`
        + `${normalWeight > 0 ? `, normalWeight=${normalWeight}` : ""})`,
    )

    // --- Compact: strip unreferenced vertices ---
    return compactMesh(mesh.verts, simplifiedTris)
}

/**
 * Remove unreferenced vertices from the mesh.
 * Builds a dense remap, copies only referenced vertex records, and rewrites
 * the index buffer in-place.
 */
function compactMesh(verts: Float32Array, tris: Uint32Array): MeshData {
    const vertexCount = verts.length / VERTEX_STRIDE

    // Determine which vertices are referenced
    const used = new Uint8Array(vertexCount)
    for (let i = 0; i < tris.length; i++) {
        used[tris[i]!] = 1
    }

    // Build old→new remap (dense, sequential)
    const remap = new Uint32Array(vertexCount)
    let newCount = 0
    for (let i = 0; i < vertexCount; i++) {
        if (used[i]) {
            remap[i] = newCount++
        }
    }

    // Copy referenced vertices into a compact buffer
    const newVerts = new Float32Array(newCount * VERTEX_STRIDE)
    for (let i = 0; i < vertexCount; i++) {
        if (used[i]) {
            const srcOff = i * VERTEX_STRIDE
            const dstOff = remap[i]! * VERTEX_STRIDE
            for (let j = 0; j < VERTEX_STRIDE; j++) {
                newVerts[dstOff + j] = verts[srcOff + j]!
            }
        }
    }

    // Rewrite indices with remapped vertex IDs
    const newTris = new Uint32Array(tris.length)
    for (let i = 0; i < tris.length; i++) {
        newTris[i] = remap[tris[i]!]!
    }

    return { verts: newVerts, tris: newTris }
}
