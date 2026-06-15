/**
 * M4b boolean-seam parity fixture. Runs the TS `compileFeatureSet` on
 * `Subtract(Box([0,0,0],[10,10,10]), Sphere([5,5,5],{r:6}))` (params sourced
 * from the scene nodes, NOT hardcoded f64, so f32-rounding matches the Rust
 * rebuild) and dumps:
 *   - the resolved tolerances (so the Rust side uses BYTE-IDENTICAL knobs and
 *     need not re-derive the world cube / scene diagonal);
 *   - each compiled feature curve: kind, adjacent strata, closed flag,
 *     corner-end ids, and sampled world positions at fixed parameters;
 *   - the surviving corners: position + incident strata.
 *
 * New file (does not touch sibling-owned dumpers/Makefile). `seams.txt`
 * gitignored; regenerate with `tsx gcad-wasm/fixtures/dump-seams.mts`. The Rust
 * test `kernel/tests/seams_parity.rs` reconstructs the same scene + tolerances
 * and asserts curve count + kinds, traced-seam sample positions (canonicalized
 * to a small tolerance — Newton/libm ULP drift expected), and surviving corners.
 *
 * Text format (whitespace-separated; the Rust loader needs no deps):
 *   TOL surfaceTol maxChordError curveEps probeDelta minDihedralCos
 *       nativeCreaseCos minTangencySin cornerMergeTol seedCellSize maxTraceSteps
 *   NCURVES n
 *   C <kind> <s0> <s1> <closed:0|1> <cornerStart> <cornerEnd> <nsamp> [t x y z]*nsamp
 *   NCORNERS m
 *   K x y z <nstrata> s0..s(n-1)
 */
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { Box } from "../../src/scene/primitives/box.mjs"
import { Sphere } from "../../src/scene/primitives/sphere.mjs"
import { Subtract } from "../../src/scene/operators/subtract.mjs"
import { compileCpuSdf } from "../../src/export/sfcc/cpu-sdf.mjs"
import { compileFeatureSet } from "../../src/export/sfcc/feature-set.mjs"
import { resolveTolerances } from "../../src/export/sfcc/tolerances.mjs"
import { DEFAULT_SFCC_TUNING } from "../../src/export/sfcc/sfcc-tuning.mjs"

const here = dirname(fileURLToPath(import.meta.url))

// Scene params sourced from the nodes (f32-rounded), matching the sdf parity scene.
const box = new Box([0, 0, 0], [10, 10, 10])
const sphere = new Sphere([5, 5, 5], { r: 6 })
const tree = compileCpuSdf(new Subtract(box, sphere))

// World cube from the leaves' AABBs (a tight bounding cube), then the scene
// diagonal the resolved tolerances derive from. Mirrors the exporter's
// cube → sceneDiag = hypot(size,size,size) (assemble.mts) closely enough that
// the EXACT values are then dumped and reused by the Rust side regardless.
let lo = [Infinity, Infinity, Infinity]
let hi = [-Infinity, -Infinity, -Infinity]
for (const leaf of tree.leaves) {
    for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a]!, leaf.aabb[a]!)
        hi[a] = Math.max(hi[a]!, leaf.aabb[a + 3]!)
    }
}
const size = Math.max(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!)
const sceneDiag = Math.hypot(size, size, size)
const tol = resolveTolerances(DEFAULT_SFCC_TUNING, sceneDiag)

const fs = compileFeatureSet(tree, tol)

const lines: string[] = []
lines.push(
    `TOL ${tol.surfaceTol} ${tol.maxChordError} ${tol.curveEps} ${tol.probeDelta} ${tol.minDihedralCos} ` +
        `${tol.nativeCreaseCos} ${tol.minTangencySin} ${tol.cornerMergeTol} ${tol.seedCellSize} ${tol.maxTraceSteps}`,
)

const p = new Float64Array(3)
const SAMPLE_TS = [0, 0.2, 0.4, 0.5, 0.6, 0.8, 1.0]
lines.push(`NCURVES ${fs.curves.length}`)
for (const c of fs.curves) {
    const span = c.tMax - c.tMin
    const parts: string[] = []
    for (const u of SAMPLE_TS) {
        const t = c.tMin + span * u
        c.pointAt(t, p)
        parts.push(`${t} ${p[0]} ${p[1]} ${p[2]}`)
    }
    lines.push(
        `C ${c.kind} ${c.adjacentStrata[0]} ${c.adjacentStrata[1]} ${c.closed ? 1 : 0} ` +
            `${c.cornerStart} ${c.cornerEnd} ${SAMPLE_TS.length} ${parts.join(" ")}`,
    )
}
lines.push(`NCORNERS ${fs.corners.length}`)
for (const k of fs.corners) {
    lines.push(`K ${k.x} ${k.y} ${k.z} ${k.strata.length} ${k.strata.join(" ")}`)
}

writeFileSync(join(here, "seams.txt"), lines.join("\n") + "\n")
console.log(
    `wrote seams.txt: ${fs.curves.length} curves, ${fs.corners.length} corners ` +
        `(seeds=${fs.seamDiagnostics.seedsFound}, traced=${fs.seamDiagnostics.curvesTraced})`,
)
