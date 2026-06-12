/**
 * S1b — boolean seam curve tracing.
 *
 * Seams are traced on analytic CARRIER PAIRS {fA = fB = 0} (never on the
 * primitive SDFs, whose kinks at patch boundaries break Newton): one generic
 * predictor–corrector for every pair kind in v1, with closed forms deferred.
 * Over-tracing onto carrier extensions beyond the actual faces is intentional
 * — CSG trimming (trim.mts) removes it with the same predicate that removes
 * material cut away by booleans.
 *
 * Candidate pairs: any two leaves with overlapping (inflated) world AABBs —
 * in the min/max-folded CSG tree every leaf pair meets at some combiner —
 * except pairs whose lowest common combiner is a smooth blend with
 * r > 4·surfaceTol (the fillet pulls the would-be seam off the surface;
 * trim would kill every sample, so the skip is exactly equivalent).
 * Seeding: deterministic grid over the overlap box + min-norm Newton.
 * Guards: tangency bail (‖∇A×∇B‖ < sin θmin → diagnostic, never loops),
 * corrector-displacement cap, tangent-angle step control, closed-loop
 * detection, step cap.
 */

import type { CpuSdfTree } from "./cpu-sdf.mjs"
import type { SfccStratum } from "./strata.mjs"
import type { ResolvedTolerances } from "./tolerances.mjs"
import { makeTracedCurve, type SfccFeatureCurve } from "./feature-curves.mjs"
import { carrierPairTangent, projectToCarrierPair } from "./newton.mjs"

export interface SeamTraceDiagnostics {
    pairsConsidered: number
    seedsFound: number
    curvesTraced: number
    tangencyBails: number
    stepCapHits: number
}

interface TraceResult {
    samples: number[]
    closed: boolean
    hitCap: boolean
}

/** Trace from a seed in one direction until exit/loop/cap. */
function traceDirection(
    sA: SfccStratum,
    sB: SfccStratum,
    seedX: number,
    seedY: number,
    seedZ: number,
    dir: 1 | -1,
    bounds: Float64Array, // overlap box, inflated
    tol: ResolvedTolerances,
    hInit: number,
): TraceResult {
    const samples: number[] = []
    const t = new Float64Array(3)
    const q = new Float64Array(3)
    let x = seedX
    let y = seedY
    let z = seedZ
    let h = hInit
    const hMin = Math.max(tol.curveEps * 100, hInit / 256)
    const hMax = hInit * 4
    let px = 0
    let py = 0
    let pz = 0
    let havePrevTangent = false
    let closed = false
    let hitCap = true
    for (let step = 0; step < tol.maxTraceSteps; step++) {
        const mag = carrierPairTangent(sA, sB, x, y, z, t)
        if (mag < tol.minTangencySin) {
            hitCap = false
            break // tangency bail — diagnostic, never loops
        }
        if (havePrevTangent && t[0]! * px + t[1]! * py + t[2]! * pz < 0) {
            // Tangent flipped — passed a singular point; stop.
            hitCap = false
            break
        }
        px = t[0]!
        py = t[1]!
        pz = t[2]!
        havePrevTangent = true

        // Predictor + corrector with step control.
        let accepted = false
        for (let attempt = 0; attempt < 10 && !accepted; attempt++) {
            const cx = x + dir * h * t[0]!
            const cy = y + dir * h * t[1]!
            const cz = z + dir * h * t[2]!
            if (!projectToCarrierPair(sA, sB, cx, cy, cz, tol.curveEps, tol.minTangencySin, h, q)) {
                h = Math.max(hMin, h / 2)
                continue
            }
            const corr = Math.hypot(q[0]! - cx, q[1]! - cy, q[2]! - cz)
            if (corr > h / 2) {
                // Branch-jump guard.
                h = Math.max(hMin, h / 2)
                continue
            }
            const magN = carrierPairTangent(sA, sB, q[0]!, q[1]!, q[2]!, t)
            if (magN < tol.minTangencySin) {
                accepted = true // accept the point; the next iteration bails
                x = q[0]!
                y = q[1]!
                z = q[2]!
                break
            }
            const cosTurn = dir * (t[0]! * px + t[1]! * py + t[2]! * pz) * dir
            if (cosTurn < Math.cos(0.35)) {
                h = Math.max(hMin, h / 2)
                continue
            }
            // Chord-error step adaptation: err ≈ h·θ/8.
            const theta = Math.acos(Math.max(-1, Math.min(1, cosTurn)))
            const err = (h * theta) / 8
            accepted = true
            x = q[0]!
            y = q[1]!
            z = q[2]!
            if (err > tol.maxChordError) h = Math.max(hMin, h * 0.6)
            else if (err < tol.maxChordError / 4) h = Math.min(hMax, h * 1.4)
        }
        if (!accepted) {
            hitCap = false
            break
        }
        samples.push(x, y, z)

        // Exit / closed-loop checks.
        if (
            x < bounds[0]! ||
            y < bounds[1]! ||
            z < bounds[2]! ||
            x > bounds[3]! ||
            y > bounds[4]! ||
            z > bounds[5]!
        ) {
            hitCap = false
            break
        }
        if (samples.length / 3 > 3) {
            const d0 = Math.hypot(x - seedX, y - seedY, z - seedZ)
            if (d0 < h * 0.9) {
                closed = true
                hitCap = false
                break
            }
        }
    }
    return { samples, closed, hitCap }
}

/**
 * Trace all seam curves between two strata carriers within an overlap box.
 * Returns polylines (each sample exactly on the pair locus).
 */
export function traceCarrierPair(
    sA: SfccStratum,
    sB: SfccStratum,
    overlap: Float64Array, // [minX..maxZ]
    tol: ResolvedTolerances,
    diag: SeamTraceDiagnostics,
): Array<{ samples: Float64Array; closed: boolean }> {
    const sizeX = overlap[3]! - overlap[0]!
    const sizeY = overlap[4]! - overlap[1]!
    const sizeZ = overlap[5]! - overlap[2]!
    const maxSize = Math.max(sizeX, sizeY, sizeZ)
    if (maxSize <= 0) return []
    const overlapDiag = Math.hypot(sizeX, sizeY, sizeZ)
    const seedCell = tol.seedCellSize > 0 ? tol.seedCellSize : overlapDiag / 8
    const inflate = seedCell
    const bounds = new Float64Array([
        overlap[0]! - inflate,
        overlap[1]! - inflate,
        overlap[2]! - inflate,
        overlap[3]! + inflate,
        overlap[4]! + inflate,
        overlap[5]! + inflate,
    ])

    // --- deterministic grid seeding -----------------------------------------
    const q = new Float64Array(3)
    const seeds: number[] = []
    const nx = Math.max(2, Math.ceil(sizeX / seedCell))
    const ny = Math.max(2, Math.ceil(sizeY / seedCell))
    const nz = Math.max(2, Math.ceil(sizeZ / seedCell))
    const seedDedup = seedCell / 2
    for (let i = 0; i <= nx; i++) {
        for (let j = 0; j <= ny; j++) {
            for (let k = 0; k <= nz; k++) {
                const x = overlap[0]! + (i / nx) * sizeX
                const y = overlap[1]! + (j / ny) * sizeY
                const z = overlap[2]! + (k / nz) * sizeZ
                // Cheap reject: both carriers within a cell of zero.
                if (Math.abs(sA.f(x, y, z)) > seedCell || Math.abs(sB.f(x, y, z)) > seedCell) continue
                if (!projectToCarrierPair(sA, sB, x, y, z, tol.curveEps, tol.minTangencySin, seedCell * 2, q)) continue
                if (
                    q[0]! < bounds[0]! ||
                    q[1]! < bounds[1]! ||
                    q[2]! < bounds[2]! ||
                    q[0]! > bounds[3]! ||
                    q[1]! > bounds[4]! ||
                    q[2]! > bounds[5]!
                ) {
                    continue
                }
                let dup = false
                for (let s = 0; s < seeds.length && !dup; s += 3) {
                    if (Math.hypot(q[0]! - seeds[s]!, q[1]! - seeds[s + 1]!, q[2]! - seeds[s + 2]!) < seedDedup) dup = true
                }
                if (!dup) seeds.push(q[0]!, q[1]!, q[2]!)
            }
        }
    }
    diag.seedsFound += seeds.length / 3
    if (seeds.length === 0) return []

    // --- trace from seeds, consuming nearby seeds --------------------------
    const out: Array<{ samples: Float64Array; closed: boolean }> = []
    const consumed = new Uint8Array(seeds.length / 3)
    const hInit = Math.min(overlapDiag / 64, Math.max(8 * tol.maxChordError, overlapDiag / 512))
    for (let s = 0; s < seeds.length / 3; s++) {
        if (consumed[s]) continue
        consumed[s] = 1
        const sx = seeds[s * 3]!
        const sy = seeds[s * 3 + 1]!
        const sz = seeds[s * 3 + 2]!
        const fwd = traceDirection(sA, sB, sx, sy, sz, 1, bounds, tol, hInit)
        if (fwd.hitCap) diag.stepCapHits++
        let pts: number[]
        let closed = fwd.closed
        if (closed) {
            pts = [sx, sy, sz, ...fwd.samples]
            // Close the loop exactly: last sample ≅ first.
            pts.push(sx, sy, sz)
        } else {
            const back = traceDirection(sA, sB, sx, sy, sz, -1, bounds, tol, hInit)
            if (back.hitCap) diag.stepCapHits++
            const rev: number[] = []
            for (let i = back.samples.length / 3 - 1; i >= 0; i--) {
                rev.push(back.samples[i * 3]!, back.samples[i * 3 + 1]!, back.samples[i * 3 + 2]!)
            }
            pts = [...rev, sx, sy, sz, ...fwd.samples]
        }
        if (pts.length / 3 < 2) continue
        const samples = new Float64Array(pts)
        // Consume seeds near this curve. The adaptive step can reach 4·hInit,
        // so the consumption radius must exceed half the max sample spacing —
        // otherwise the same loop gets re-traced from a missed seed.
        const consumeRadius = hInit * 4
        for (let o = s + 1; o < seeds.length / 3; o++) {
            if (consumed[o]) continue
            const ox = seeds[o * 3]!
            const oy = seeds[o * 3 + 1]!
            const oz = seeds[o * 3 + 2]!
            for (let i = 0; i < samples.length; i += 3) {
                if (Math.hypot(ox - samples[i]!, oy - samples[i + 1]!, oz - samples[i + 2]!) < consumeRadius) {
                    consumed[o] = 1
                    break
                }
            }
        }
        // Duplicate guard: if this piece's midpoint lies on an already-traced
        // piece of the same pair, it's the same locus re-traced — drop it.
        const mi = 3 * Math.floor(samples.length / 6)
        let dup = false
        for (const prev of out) {
            for (let i = 0; i < prev.samples.length && !dup; i += 3) {
                if (
                    Math.hypot(
                        samples[mi]! - prev.samples[i]!,
                        samples[mi + 1]! - prev.samples[i + 1]!,
                        samples[mi + 2]! - prev.samples[i + 2]!,
                    ) < consumeRadius
                ) {
                    dup = true
                }
            }
            if (dup) break
        }
        if (dup) continue
        out.push({ samples, closed })
        diag.curvesTraced++
    }
    return out
}

/**
 * Enumerate AABB-overlapping leaf pairs and trace every stratum-carrier pair.
 * Returns raw (untrimmed) traced curves; ids are assigned by the caller.
 */
export function traceAllSeams(
    tree: CpuSdfTree,
    tol: ResolvedTolerances,
    makeId: () => number,
): { curves: SfccFeatureCurve[]; diagnostics: SeamTraceDiagnostics } {
    const diagnostics: SeamTraceDiagnostics = {
        pairsConsidered: 0,
        seedsFound: 0,
        curvesTraced: 0,
        tangencyBails: 0,
        stepCapHits: 0,
    }
    const curves: SfccFeatureCurve[] = []
    const leaves = tree.leaves
    const overlap = new Float64Array(6)
    for (let i = 0; i < leaves.length; i++) {
        for (let j = i + 1; j < leaves.length; j++) {
            const A = leaves[i]!
            const B = leaves[j]!
            // Pairs meeting at a smooth combiner have their crease replaced by
            // a fillet: on the carrier-pair locus the final surface sits
            // ≥ r/4 away (see blendRadiusBetween), so for r > 4·surfaceTol
            // trim would kill every sample — skipping is exactly equivalent
            // and avoids tracing curves that only exist to be trimmed.
            // Near-hard blends (r ≤ 4·surfaceTol) keep their seams: the sharp
            // curve is the better description within tolerance.
            if (tree.blendRadiusBetween(i, j) > tol.surfaceTol * 4) continue
            const margin = tol.probeDelta * 2
            let empty = false
            for (let a = 0; a < 3; a++) {
                const lo = Math.max(A.aabb[a]! - margin, B.aabb[a]! - margin)
                const hi = Math.min(A.aabb[a + 3]! + margin, B.aabb[a + 3]! + margin)
                if (hi <= lo) {
                    empty = true
                    break
                }
                overlap[a] = lo
                overlap[a + 3] = hi
            }
            if (empty) continue
            diagnostics.pairsConsidered++
            for (const sA of A.strata) {
                for (const sB of B.strata) {
                    for (const piece of traceCarrierPair(sA, sB, overlap, tol, diagnostics)) {
                        const refine = (x: number, y: number, z: number, out: Float64Array, off = 0): boolean =>
                            projectToCarrierPair(sA, sB, x, y, z, tol.curveEps, tol.minTangencySin, tol.maxChordError * 4, out, off)
                        const tangent = (x: number, y: number, z: number, out: Float64Array, off = 0): void => {
                            carrierPairTangent(sA, sB, x, y, z, out, off)
                        }
                        curves.push(makeTracedCurve(makeId(), [sA.id, sB.id], piece.samples, piece.closed, refine, tangent))
                    }
                }
            }
        }
    }
    return { curves, diagnostics }
}
