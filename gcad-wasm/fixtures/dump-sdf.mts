/**
 * SDF-sample parity dumper: evaluates the TS CPU SDF oracle at a deterministic
 * point set and writes (points, f) the Rust kernel checks in
 * `gcad-wasm/kernel/tests/sdf_parity.rs`. Companion to dump.mts (mesh fixtures).
 *
 *   tsx gcad-wasm/fixtures/dump-sdf.mts
 *
 * Format (little-endian): [u32 count][f64 × 3·count points][f64 × count f].
 *
 * Two flavours:
 *  - tree fixtures (compileCpuSdf().f) — exercise the CSG tree (hard + smooth);
 *  - direct-fn fixtures — exercise the extrude/loft/lathe primitive evaluators
 *    in isolation. The Rust test reconstructs the SAME geometry (shared literal
 *    polygons below, winding computed the same way) and compares.
 */
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { Sphere } from "../../src/scene/primitives/sphere.mjs"
import { Box } from "../../src/scene/primitives/box.mjs"
import { Subtract } from "../../src/scene/operators/subtract.mjs"
import { Union } from "../../src/scene/operators/union.mjs"
import type { Node } from "../../src/scene/base.mjs"
import { compileCpuSdf } from "../../src/export/sfcc/cpu-sdf.mjs"
import { extrudeDist, loftDist, latheDist, latheProfileEdges } from "../../src/export/sfcc/cpu-sdf-primitives.mjs"
import { polygon2dWindingSign } from "../../src/scene/primitives/polygon2d.mjs"

const here = dirname(fileURLToPath(import.meta.url))

/** Deterministic LCG (Math.random is unavailable in this environment). */
function lcg(seed: number): () => number {
    let s = seed >>> 0
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0
        return s / 0x100000000
    }
}

function dumpEval(name: string, f: (x: number, y: number, z: number) => number, half: number, count: number): void {
    const rnd = lcg(0x5eed)
    const pts = new Float64Array(count * 3)
    const fs = new Float64Array(count)
    for (let i = 0; i < count; i++) {
        const x = (rnd() * 2 - 1) * half
        const y = (rnd() * 2 - 1) * half
        const z = (rnd() * 2 - 1) * half
        pts[i * 3] = x
        pts[i * 3 + 1] = y
        pts[i * 3 + 2] = z
        fs[i] = f(x, y, z)
    }
    const header = new Uint32Array([count])
    const buf = Buffer.concat([Buffer.from(header.buffer), Buffer.from(pts.buffer), Buffer.from(fs.buffer)])
    writeFileSync(join(here, `${name}.bin`), buf)
    console.log(`wrote ${name}.bin: ${count} samples`)
}

function dumpScene(name: string, scene: Node, half: number, count: number): void {
    const tree = compileCpuSdf(scene)
    dumpEval(name, (x, y, z) => tree.f(x, y, z), half, count)
}

// --- Shared geometry (MUST stay identical to sdf_parity.rs literals) ---------
const EXTRUDE_POLY: [number, number][] = [[2, 0], [0.6, 1.9], [-1.6, 1.2], [-1.6, -1.2], [0.6, -1.9]]
const EXTRUDE_H = 3
const LOFT_BIG: [number, number][] = [[2, 2], [-2, 2], [-2, -2], [2, -2]]
const LOFT_SMALL: [number, number][] = [[1.4, 0], [0, 1.4], [-1.4, 0], [0, -1.4]]
const LOFT_H = 3
const LATHE_PROFILE: [number, number][] = [[0, -2], [1.6, -2], [0.9, 1.0], [1.2, 2.0], [0, 2]]

// Tree fixtures (hard + smooth CSG); untransformed so the Rust tree is trivial.
dumpScene("sdf-sphere", new Sphere([0.13, -0.21, 0.07], { r: 8 }), 12, 500)
dumpScene("sdf-box-minus-sphere", new Subtract(new Box([0, 0, 0], [10, 10, 10]), new Sphere([5, 5, 5], { r: 6 })), 14, 500)
dumpScene(
    "sdf-smooth-union-round",
    new Union([new Sphere([-1.5, 0, 0], { r: 2 }), new Sphere([1.5, 0, 0], { r: 2 })], 1, "round", 4),
    5,
    500,
)
dumpScene(
    "sdf-smooth-union-columns",
    new Union([new Sphere([-1.5, 0, 0], { r: 2 }), new Sphere([1.5, 0, 0], { r: 2 })], 1, "columns", 3),
    5,
    500,
)

// Direct-fn fixtures (extrude / loft / lathe primitive evaluators).
const eFlat = EXTRUDE_POLY.flat()
const eWind = polygon2dWindingSign(EXTRUDE_POLY)
dumpEval("sdf-extrude", (x, y, z) => extrudeDist(eFlat, eWind, EXTRUDE_H, 0, x, y, z), 4, 500)
dumpEval("sdf-extrude-twist", (x, y, z) => extrudeDist(eFlat, eWind, EXTRUDE_H, 0.7, x, y, z), 4, 500)

const lProfs = [LOFT_BIG.flat(), LOFT_SMALL.flat()]
const lWinds = [polygon2dWindingSign(LOFT_BIG), polygon2dWindingSign(LOFT_SMALL)]
dumpEval("sdf-loft", (x, y, z) => loftDist(lProfs, lWinds, LOFT_H, x, y, z), 4, 500)

const laEdges = latheProfileEdges(LATHE_PROFILE, polygon2dWindingSign(LATHE_PROFILE))
dumpEval("sdf-lathe", (x, y, z) => latheDist(laEdges, x, y, z), 3, 500)
