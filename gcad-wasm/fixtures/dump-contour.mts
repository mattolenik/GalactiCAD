/**
 * Face-contour parity dumper: builds the TS SFCC octree (exactly as
 * dump-octree.mts does — same scene/lattice/refine tuning, smooth-only) then runs
 * `contourAllFaces` on a sphere and a box and dumps, per canonical face, its
 * contour segment list as endpoint WORLD POSITIONS.
 *
 *   tsx gcad-wasm/fixtures/dump-contour.mts
 *
 * The Rust integration test (gcad-wasm/kernel/tests/contour_parity.rs) rebuilds
 * the same octree in Rust, contours it, and asserts: the same set of face keys
 * (axis + face lattice key + len), and per face the same segment SET (endpoint
 * positions matched to a small tolerance — ULP / libm-hypot drift between V8 and
 * Rust is expected; topology + counts must match exactly). Soft-skips if absent.
 *
 * Format (little-endian) — one file per scene:
 *   u32  maxDepth, depthMin, depthMax, enforceEdgeBalance (0/1)
 *   f64  originX, originY, originZ, worldSize
 *   f64  normalVariationCos, blendNormalVariationCos
 *   f64  rootTol
 *   u32  faceCount
 *   faceCount × {
 *       u32 axis
 *       f64 key                 (lattice key — exceeds i32, kept exact in f64)
 *       i32 len                 (face edge length in lattice units)
 *       u32 segCount
 *       segCount × 6×f64 (ax, ay, az, bx, by, bz)  endpoint world positions
 *   }
 *   trailer u32: multiRunFaces, boundaryViolations, keyCollisions, pointCount
 *
 * NOTE: a NEW file — it does not touch dump.mts / dump-sdf.mts / dump-octree.mts.
 */
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { Sphere } from "../../src/scene/primitives/sphere.mjs"
import { Box } from "../../src/scene/primitives/box.mjs"
import type { Node } from "../../src/scene/base.mjs"
import { compileCpuSdf } from "../../src/export/sfcc/cpu-sdf.mjs"
import { makeLattice } from "../../src/export/sfcc/lattice.mjs"
import { buildOctree, type SfccCell } from "../../src/export/sfcc/octree.mjs"
import { makeProbe, needsSplitSmooth } from "../../src/export/sfcc/refine-criteria.mjs"
import { PointTable } from "../../src/export/sfcc/point-table.mjs"
import { contourAllFaces } from "../../src/export/sfcc/face-contour.mjs"

const here = dirname(fileURLToPath(import.meta.url))

// Octree/refine knobs identical to dump-octree.mts so the LEAF set is the
// bit-identical one the Rust side already matches — faces then align by key.
const DEPTH_MIN = 4
const DEPTH_MAX = 7
const ENFORCE_EDGE_BALANCE = true
const NORMAL_VARIATION_DEG = 8
const BLEND_CURVATURE_DEG = 8
const BLEND_CURVATURE_REFINE = true

interface Cube {
    minX: number
    minY: number
    minZ: number
    size: number
}

function dumpContour(name: string, scene: Node, cube: Cube): void {
    const tree = compileCpuSdf(scene)

    const pad = 2.0
    const step = (cube.size + 2 * pad) / (1 << DEPTH_MAX)
    const jx = (Math.SQRT2 - 1) * 0.25 * step
    const jy = (Math.sqrt(3) - 1) * 0.25 * step
    const jz = (Math.sqrt(5) - 2) * 0.25 * step
    const lat = makeLattice(
        DEPTH_MAX,
        cube.minX - pad - jx,
        cube.minY - pad - jy,
        cube.minZ - pad - jz,
        cube.size + 2 * pad,
    )

    const smoothCriteriaOpts = {
        normalVariationCos: Math.cos((NORMAL_VARIATION_DEG * Math.PI) / 180),
        blendNormalVariationCos: BLEND_CURVATURE_REFINE ? Math.cos((BLEND_CURVATURE_DEG * Math.PI) / 180) : 1,
    }

    const oct = buildOctree(tree, lat, {
        depthMin: DEPTH_MIN,
        depthMax: DEPTH_MAX,
        enforceEdgeBalance: ENFORCE_EDGE_BALANCE,
        needsSplit: (cell: SfccCell, sampleAt) => {
            const probe = makeProbe(lat, tree, sampleAt, cell.level, cell.ix, cell.iy, cell.iz)
            return needsSplitSmooth(tree, probe, smoothCriteriaOpts)
        },
    })

    // rootTol exactly as the assemble pipeline computes it (tuning defaults).
    const edgeRootTolFraction = 1e-3
    const surfaceTolMm = 0.01
    const rootTol = Math.min(edgeRootTolFraction * lat.step, surfaceTolMm * 0.1)

    const points = new PointTable()
    // No `features` → the smooth path is fully exercised; recovery/tag/pin inert.
    const result = contourAllFaces(oct, tree, points, { rootTol })

    // --- serialize -----------------------------------------------------------
    const headerU32 = new Uint32Array([DEPTH_MAX, DEPTH_MIN, DEPTH_MAX, ENFORCE_EDGE_BALANCE ? 1 : 0])
    const headerF64 = new Float64Array([
        lat.originX,
        lat.originY,
        lat.originZ,
        lat.worldSize,
        smoothCriteriaOpts.normalVariationCos,
        smoothCriteriaOpts.blendNormalVariationCos,
        rootTol,
    ])

    // Flatten all faces across the 3 axes into one record stream.
    const chunks: Buffer[] = []
    let faceCount = 0
    for (let axis = 0; axis < 3; axis++) {
        for (const [key, rec] of result.faces[axis]!) {
            faceCount++
            const head = new Uint32Array([axis])
            const keyF64 = new Float64Array([key])
            const lenI32 = new Int32Array([rec.len])
            const segCount = new Uint32Array([rec.segments.length])
            const segs = new Float64Array(rec.segments.length * 6)
            for (let i = 0; i < rec.segments.length; i++) {
                const s = rec.segments[i]!
                segs[i * 6 + 0] = points.x(s.a)
                segs[i * 6 + 1] = points.y(s.a)
                segs[i * 6 + 2] = points.z(s.a)
                segs[i * 6 + 3] = points.x(s.b)
                segs[i * 6 + 4] = points.y(s.b)
                segs[i * 6 + 5] = points.z(s.b)
            }
            chunks.push(
                Buffer.from(head.buffer),
                Buffer.from(keyF64.buffer),
                Buffer.from(lenI32.buffer),
                Buffer.from(segCount.buffer),
                Buffer.from(segs.buffer),
            )
        }
    }

    const countU32 = new Uint32Array([faceCount])
    const trailer = new Uint32Array([
        result.multiRunFaces,
        result.boundaryViolations,
        result.keyCollisions,
        points.count,
    ])

    const buf = Buffer.concat([
        Buffer.from(headerU32.buffer),
        Buffer.from(headerF64.buffer),
        Buffer.from(countU32.buffer),
        ...chunks,
        Buffer.from(trailer.buffer),
    ])
    writeFileSync(join(here, `${name}.bin`), buf)

    let segTotal = 0
    for (let axis = 0; axis < 3; axis++) for (const rec of result.faces[axis]!.values()) segTotal += rec.segments.length
    console.log(
        `wrote ${name}.bin: ${faceCount} faces, ${segTotal} segments, ${points.count} points` +
            ` (multiRun=${result.multiRunFaces} boundaryViol=${result.boundaryViolations} keyColl=${result.keyCollisions})`,
    )
}

// Same two parity scenes as dump-octree.mts (smooth — no features).
dumpContour("contour-sphere", new Sphere([0, 0, 0], { r: 8 }), { minX: -8, minY: -8, minZ: -8, size: 16 })
dumpContour("contour-box", new Box([0, 0, 0], [6, 6, 6]), { minX: -6, minY: -6, minZ: -6, size: 12 })
