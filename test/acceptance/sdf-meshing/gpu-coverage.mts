import { closestPoint } from "./diagnostics.mjs"

export type Point = [number, number, number]
export type Sample = { point: Point; normal: Point; field: number }
export type Sampler = (points: Point[]) => Promise<Sample[]>
export interface Region { id: string; center: Point; half: number; spacing: number; crease?: [Point, Point] }
export interface RefinementAttempt {
    iteration: number; before: [Sample, Sample]; midpoint: Sample; quarter?: Sample
    after: [Sample, Sample]; width: number; reason: string
}
export interface Root {
    point: Point; normal: Point; bracket: [Sample, Sample]; width: number; allowance: number
    refinement?: { attempts: RefinementAttempt[]; stopReason: string; center: Sample }
}
export interface Reference { region: Region; roots: Root[]; sampledPoints: number; sameSignEdges: number; zeroEndpoints: number; unrefinedBrackets: number }
const add = (a: Point, b: Point, t = 1): Point => a.map((x, i) => x + t * b[i]) as Point
const sub = (a: Point, b: Point): Point => add(a, b, -1)
const dot = (a: Point, b: Point) => a.reduce((s, x, i) => s + x * b[i], 0)
const norm = (a: Point) => Math.hypot(...a)
const unit = (a: Point): Point => { const n = norm(a); return n ? a.map(x => x / n) as Point : [0, 0, 0] }
const cross = (a: Point, b: Point): Point => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const distance = (a: Point, b: Point) => norm(sub(a, b))
const angle = (a: Point, b: Point) => Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b)))))
const mix = (a: Point, b: Point, t: number): Point => add(a, sub(b, a), t)
const rounded = (p: Point): Point => p.map(Math.fround) as Point
export const COVERAGE_TOLERANCE = 0.01
export const FEATURE_TOLERANCE = 0.02
// Position rounding allowance only. This is NOT a bound on arbitrary WGSL field error.
const allowance = (p: Point) => Math.max(1, ...p.map(Math.abs)) * 2 ** -21

export function regionsFor(id: string, hash: string): Region[] {
    if (id === "bracket") {
        if (hash !== "10f9049a0e3828edb19274b8137525ce1392916032078161adaafa4d58a99508") throw new Error("GPU bracket reference source changed")
        return [{ id: "dent-rib-junction", center: [-3.2974043758686875, 11.496906301499829, 2.2091193968483966], half: 0.12, spacing: 0.015 }]
    }
    if (id === "housing") {
        if (hash !== "54964141fea0ed055f5392837c5e524f4a358e1c610f0b11a90857b8b57ad4a5") throw new Error("GPU housing reference source changed")
        return [
            { id: "loft-chamfer-crease", center: [8.225, 4.75, 14.74], half: 0.25, spacing: 0.025, crease: [[8.3191, 4.5872, 14.8059], [8.1316, 4.9120, 14.6752]] },
            { id: "flange-rim", center: [10, 0, 19], half: 0.2, spacing: 0.025, crease: [[10, -0.12, 19], [10, 0.12, 19]] },
            { id: "internal-main-bore", center: [5.5, 0, 0], half: 0.3, spacing: 0.05 },
            { id: "internal-main-bore-shifted", center: [5.5, 0.0125, 0.0125], half: 0.3, spacing: 0.025 },
            { id: "internal-branch-bore", center: [4, 16, 0], half: 0.3, spacing: 0.05 },
        ]
    }
    return []
}

const oppositeSigns = (a: number, b: number) => a < 0 && b > 0 || a > 0 && b < 0
const sameSigns = (a: number, b: number) => a < 0 && b < 0 || a > 0 && b > 0
function finitePoint(value: unknown): value is Point {
    return Array.isArray(value) && value.length === 3 && [0, 1, 2].every(axis => Number.isFinite(value[axis]))
}
function requireSamples(samples: Sample[], count: number, requested?: Point[]): void {
    if (!Array.isArray(samples) || samples.length !== count) throw new Error("Invalid GPU sample batch length; no reference may be inferred")
    for (let i = 0; i < count; i++) {
        const s = samples[i]
        if (!s || !Number.isFinite(s.field) || !finitePoint(s.point) || !finitePoint(s.normal)) throw new Error("Invalid GPU sample batch shape/value; no reference may be inferred")
        // Numerical equality intentionally accepts +0/-0 across JSON transport.
        // This checks response association, not bitwise correctness of the GPU field.
        if (requested && s.point.some((value, axis) => value !== Math.fround(requested[i][axis]))) throw new Error("GPU sample position does not match the requested float32 point")
    }
}
async function checkedSample(points: Point[], sample: Sampler): Promise<Sample[]> {
    if (points.some(p => !finitePoint(p) || !finitePoint(rounded(p)))) throw new Error("Invalid GPU sample position request")
    // Do not alter coordinates here. The existing production sampler converts
    // requests to f32, and must return the coordinates actually submitted.
    const requested = points.map(rounded)
    const samples = await sample(points)
    requireSamples(samples, requested.length, requested)
    return samples
}

/** Only strict sampled sign brackets create references. No same-sign exclusion. */
export async function refineBrackets(brackets: [Sample, Sample][], sample: Sampler, retainAttempts = false): Promise<Root[]> {
    if (!brackets.length) return []
    requireSamples(brackets.flat(), 2 * brackets.length)
    if (brackets.some(([a, b]) => !oppositeSigns(a.field, b.field))) throw new Error("Root refinement requires strict opposite endpoint signs")
    const active = brackets.map(([a, b]) => [a, b] as [Sample, Sample])
    const attempts: RefinementAttempt[][] = brackets.map(() => [])
    for (let iteration = 0; iteration < 18 && active.length; iteration++) {
        const mids = await checkedSample(active.map(([a, b]) => rounded(mix(a.point, b.point, 0.5))), sample)
        const zeros = mids.flatMap((m, i) => m.field === 0 ? [i] : [])
        const quarters = zeros.length ? await checkedSample(zeros.map(i => rounded(mix(active[i][0].point, active[i][1].point, iteration % 2 ? 0.25 : 0.75))), sample) : []
        let zeroIndex = 0
        for (let i = 0; i < active.length; i++) {
            const before: [Sample, Sample] = [...active[i]], [a, b] = before
            const quarter = mids[i].field === 0 ? quarters[zeroIndex++] : undefined, m = quarter ?? mids[i]
            // Comparisons avoid underflow of a product of two tiny nonzero fields.
            if (sameSigns(m.field, a.field)) active[i][0] = m
            else if (sameSigns(m.field, b.field)) active[i][1] = m
            if (retainAttempts) attempts[i].push({ iteration, before, midpoint: mids[i], ...(quarter ? { quarter } : {}), after: [...active[i]], width: distance(active[i][0].point, active[i][1].point), reason: m.field === 0 ? "ROUNDED_ZERO_RETAINED_STRICT_ENDPOINTS" : distance(before[0].point, active[i][0].point) + distance(before[1].point, active[i][1].point) === 0 ? "FLOAT32_NO_PROGRESS" : "STRICT_BRACKET_SHRUNK" })
        }
        if (active.every(([a, b]) => distance(a.point, b.point) <= allowance(a.point))) break
    }
    const centers = await checkedSample(active.map(([a, b]) => rounded(mix(a.point, b.point, 0.5))), sample)
    return active.map((bracket, i) => {
        const width = distance(bracket[0].point, bracket[1].point), positionAllowance = allowance(centers[i].point)
        return { point: centers[i].point, normal: centers[i].normal, bracket, width, allowance: positionAllowance, ...(retainAttempts ? { refinement: { attempts: attempts[i], center: centers[i], stopReason: width <= positionAllowance ? "POSITION_ALLOWANCE_REACHED" : "REFINEMENT_BUDGET_EXHAUSTED" } } : {}) }
    })
}

export interface NormalSearchTarget { point: Point; normal: Point }
export interface NormalAssociation {
    eligible: boolean; reason: string; rootIndex?: number; normalDotDirection?: number
}
export interface NormalSearchReceipt {
    target: NormalSearchTarget; extent: number; direction: Point
    status: "ONE_OBSERVED_CROSSING" | "MULTIPLE_OBSERVED_CROSSINGS" | "NO_STRICT_BRACKET" | "INVALID_DIRECTION"
    reason: string; probes: Sample[]; roots: Root[]; association: NormalAssociation
    attempts: Array<{ level: number; extent: number; endpoints: [Sample, Sample]; width: number; reason: string }>
    intervals: Array<{ endpoints: [Sample, Sample]; width: number; skippedZeros: number; reason: string }>
    zeroSamples: number; unrefinedBrackets: number; collapsedProbePositions: number
}
export const NORMAL_SEARCH_BUDGET = Object.freeze({ radii: 7, samplesPerTarget: 15, refinementIterations: 18, maxRefinementSamplesPerBracket: 37, maxBracketsPerTarget: 14, maxSamplesPerTarget: 533 })

/** A finite nested search, not root isolation: thin or tangent sheets may remain unseen. */
export async function searchNormalBrackets(targets: NormalSearchTarget[], extent: number, sample: Sampler): Promise<NormalSearchReceipt[]> {
    if (!(extent > 0) || !Number.isFinite(extent)) throw new Error("Normal search needs a finite positive extent")
    const receipts: NormalSearchReceipt[] = targets.map(target => {
        if (!finitePoint(target.point) || !finitePoint(target.normal)) throw new Error("Invalid normal-search target shape/value")
        const direction = unit(target.normal), valid = norm(direction) > 0
        return { target, extent, direction, status: valid ? "NO_STRICT_BRACKET" : "INVALID_DIRECTION", reason: valid ? "FINITE_SEARCH_NO_STRICT_BRACKET" : "ZERO_NORMAL", association: { eligible: false, reason: valid ? "NO_OBSERVED_CROSSING" : "INVALID_SEARCH_DIRECTION" }, probes: [], roots: [], attempts: [], intervals: [], zeroSamples: 0, unrefinedBrackets: 0, collapsedProbePositions: 0 }
    })
    const points: Point[] = [], ids: number[] = []
    for (let i = 0; i < receipts.length; i++) {
        const r = receipts[i]
        if (r.status === "INVALID_DIRECTION") continue
        ids.push(i)
        points.push(rounded(r.target.point))
        for (let k = 0; k < NORMAL_SEARCH_BUDGET.radii; k++) for (const sign of [-1, 1]) points.push(rounded(add(r.target.point, r.direction, sign * extent / 2 ** k)))
    }
    const sampled = points.length ? await checkedSample(points, sample) : []
    const brackets: [Sample, Sample][] = [], owners: number[] = []
    for (let j = 0; j < ids.length; j++) {
        const r = receipts[ids[j]], probes = sampled.slice(j * NORMAL_SEARCH_BUDGET.samplesPerTarget, (j + 1) * NORMAL_SEARCH_BUDGET.samplesPerTarget)
        r.probes = probes; r.zeroSamples = probes.filter(p => p.field === 0).length
        r.collapsedProbePositions = probes.length - new Set(probes.map(p => p.point.join(":"))).size
        for (let k = 0; k < NORMAL_SEARCH_BUDGET.radii; k++) {
            const endpoints: [Sample, Sample] = [probes[1 + 2 * k], probes[2 + 2 * k]], [a, b] = endpoints, width = distance(a.point, b.point)
            r.attempts.push({ level: k, extent: extent / 2 ** k, endpoints, width, reason: width === 0 ? "FLOAT32_COLLAPSED_PROBES" : oppositeSigns(a.field, b.field) ? "STRICT_OUTER_PAIR" : a.field === 0 || b.field === 0 ? "ZERO_ENDPOINT_UNRESOLVED" : "SAME_SIGN_UNRESOLVED" })
        }
        const ordered = [...probes].sort((a, b) => dot(sub(a.point, b.point), r.direction))
        let previous: Sample | undefined, skippedZeros = 0
        for (const current of ordered) {
            if (current.field === 0) { skippedZeros++; continue }
            if (previous) {
                const pair: [Sample, Sample] = [previous, current], width = distance(previous.point, current.point), strict = width > 0 && oppositeSigns(previous.field, current.field)
                r.intervals.push({ endpoints: pair, width, skippedZeros, reason: strict ? "STRICT_SIGN_BRACKET" : width === 0 ? "FLOAT32_COLLAPSED_INTERVAL" : "SAME_SIGN_UNSEARCHED_INTERIOR" })
                if (strict) { brackets.push(pair); owners.push(ids[j]) }
            }
            previous = current; skippedZeros = 0
        }
    }
    const roots = await refineBrackets(brackets, sample, true)
    roots.forEach((r, i) => receipts[owners[i]].roots.push(r))
    for (const r of receipts) {
        r.unrefinedBrackets = r.roots.filter(root => root.width > 4 * root.allowance).length
        if (r.roots.length) {
            r.status = r.roots.length === 1 ? "ONE_OBSERVED_CROSSING" : "MULTIPLE_OBSERVED_CROSSINGS"
            r.reason = r.roots.length === 1 ? "ONE_STRICT_BRACKET_OBSERVED" : "MULTIPLE_STRICT_BRACKETS_OBSERVED"
        } else if (r.zeroSamples) r.reason = "ZERO_SAMPLES_WITHOUT_STRICT_BRACKET"
        if (r.roots.length > 1) r.association = { eligible: false, reason: "MULTIPLE_OBSERVED_CROSSINGS" }
        else if (r.roots.length === 1) {
            const root = r.roots[0], magnitude = norm(root.normal)
            if (r.unrefinedBrackets) r.association = { eligible: false, reason: "BRACKET_WIDTH_UNRESOLVED" }
            else if (!(magnitude > 0) || !Number.isFinite(magnitude)) r.association = { eligible: false, reason: "ZERO_OR_INVALID_ROOT_NORMAL" }
            else {
                const normalDotDirection = dot(unit(root.normal), r.direction)
                r.association = normalDotDirection > 0
                    ? { eligible: true, reason: "EMPIRICAL_FORWARD_NORMAL_ASSOCIATION", rootIndex: 0, normalDotDirection }
                    : { eligible: false, reason: "NON_FORWARD_ROOT_NORMAL", normalDotDirection }
            }
        }
    }
    return receipts
}

function countReasons(reasons: string[]): Record<string, number> {
    return reasons.reduce<Record<string, number>>((counts, reason) => { counts[reason] = (counts[reason] ?? 0) + 1; return counts }, {})
}
export function summarizeNormalSearches(searches: NormalSearchReceipt[]) {
    return {
        lines: searches.length, initialProbes: searches.reduce((n, s) => n + s.probes.length, 0),
        nestedAttempts: searches.reduce((n, s) => n + s.attempts.length, 0),
        strictBrackets: searches.reduce((n, s) => n + s.roots.length, 0),
        refinementAttempts: searches.reduce((n, s) => n + s.roots.reduce((m, r) => m + (r.refinement?.attempts.length ?? 0), 0), 0),
        unrefinedBrackets: searches.reduce((n, s) => n + s.unrefinedBrackets, 0),
        multipleCrossingLines: searches.filter(s => s.roots.length > 1).length,
        unresolvedAssociations: searches.filter(s => !s.association.eligible).length,
        associationReasons: countReasons(searches.map(s => s.association.reason)),
        zeroSamples: searches.reduce((n, s) => n + s.zeroSamples, 0),
        collapsedProbePositions: searches.reduce((n, s) => n + s.collapsedProbePositions, 0),
        reasons: countReasons(searches.map(s => s.reason)),
        refinementStopReasons: countReasons(searches.flatMap(s => s.roots.map(r => r.refinement?.stopReason ?? "NO_REFINEMENT_RECEIPT"))),
    }
}

export async function scanRegion(region: Region, sample: Sampler): Promise<Reference> {
    const n = Math.round(2 * region.half / region.spacing), points: Point[] = []
    for (let z = 0; z <= n; z++) for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) points.push(rounded([x, y, z].map((v, a) => region.center[a] - region.half + v * 2 * region.half / n) as Point))
    const samples = await checkedSample(points, sample), brackets: [Sample, Sample][] = []
    let sameSignEdges = 0, zeroEndpoints = 0
    const index = (x: number, y: number, z: number) => x + (n + 1) * (y + (n + 1) * z)
    for (let axis = 0; axis < 3; axis++) for (let u = 0; u <= n; u++) for (let v = 0; v <= n; v++) {
        let prior: Sample | undefined
        for (let k = 0; k <= n; k++) {
            const c = [0, 0, 0]; c[axis] = k; c[(axis + 1) % 3] = u; c[(axis + 2) % 3] = v
            const current = samples[index(c[0], c[1], c[2])]
            if (!current.field) { zeroEndpoints++; continue }
            if (prior) {
                if (prior.field * current.field < 0) brackets.push([prior, current])
                else sameSignEdges++
            }
            prior = current
        }
    }
    // Ensure the investigation seed itself is traversed, independent of lattice alignment.
    const seedPairs: Point[] = []
    for (let a = 0; a < 3; a++) for (const sign of [-1, 1]) { const p = [...region.center] as Point; p[a] += sign * region.spacing; seedPairs.push(rounded(p)) }
    const seedSamples = await checkedSample(seedPairs, sample)
    for (let i = 0; i < 6; i += 2) if (seedSamples[i].field * seedSamples[i + 1].field < 0) brackets.push([seedSamples[i], seedSamples[i + 1]])
    const roots = await refineBrackets(brackets, sample)
    return { region, roots, sampledPoints: points.length + 6, sameSignEdges, zeroEndpoints, unrefinedBrackets: roots.filter(r => r.width > 4 * r.allowance).length }
}

type Triangle = { id: number; ids: number[]; p: Point[]; normal: Point; min: Point; max: Point }
type Tree = { min: Point; max: Point; triangles?: Triangle[]; left?: Tree; right?: Tree }
function bounds(triangles: Triangle[]) {
    const min: Point = [Infinity, Infinity, Infinity], max: Point = [-Infinity, -Infinity, -Infinity]
    for (const t of triangles) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], t.min[a]); max[a] = Math.max(max[a], t.max[a]) }
    return { min, max }
}
function tree(triangles: Triangle[]): Tree {
    const b = bounds(triangles)
    if (triangles.length <= 24) return { ...b, triangles }
    const axis = [0, 1, 2].sort((a, c) => (b.max[c] - b.min[c]) - (b.max[a] - b.min[a]))[0]
    triangles.sort((a, b) => a.min[axis] + a.max[axis] - b.min[axis] - b.max[axis])
    const mid = Math.floor(triangles.length / 2)
    return { ...b, left: tree(triangles.slice(0, mid)), right: tree(triangles.slice(mid)) }
}
const boxDistance = (p: Point, b: { min: Point; max: Point }) => Math.hypot(...p.map((x, a) => Math.max(b.min[a] - x, 0, x - b.max[a])))
export class MeshQuery {
    readonly triangles: Triangle[] = []
    readonly positions: Point[] = []
    readonly edges = new Map<string, { ids: number[]; faces: Triangle[] }>()
    private readonly root: Tree
    constructor(readonly verts: Float32Array, readonly tris: Uint32Array) {
        for (let i = 0; i < verts.length; i += 8) this.positions.push([verts[i], verts[i + 1], verts[i + 2]])
        for (let i = 0; i < tris.length; i += 3) {
            const ids = Array.from(tris.subarray(i, i + 3)), p = ids.map(i => this.positions[i]), normal = unit(cross(sub(p[1], p[0]), sub(p[2], p[0])))
            if (!norm(normal)) continue
            const t = { id: i / 3, ids, p, normal, min: [0, 1, 2].map(a => Math.min(...p.map(p => p[a]))) as Point, max: [0, 1, 2].map(a => Math.max(...p.map(p => p[a]))) as Point }
            this.triangles.push(t)
            for (let j = 0; j < 3; j++) { const edge = [ids[j], ids[(j + 1) % 3]].sort((a, b) => a - b), key = edge.join(":"); if (!this.edges.has(key)) this.edges.set(key, { ids: edge, faces: [] }); this.edges.get(key)!.faces.push(t) }
        }
        this.root = tree([...this.triangles])
    }
    nearest(p: Point) {
        let best = { distance: Infinity, triangle: -1, point: [0, 0, 0] as Point }
        const visit = (node: Tree) => {
            if (boxDistance(p, node) > best.distance) return
            if (node.triangles) for (const t of node.triangles) { const q = closestPoint(p, ...t.p as [Point, Point, Point]) as Point, d = distance(p, q); if (d < best.distance) best = { distance: d, triangle: t.id, point: q } }
            else { const children = [node.left!, node.right!].sort((a, b) => boxDistance(p, a) - boxDistance(p, b)); children.forEach(visit) }
        }
        visit(this.root); return best
    }
    regionalSamples(region: Region, limit = 1200) {
        const ts = this.triangles.filter(t => t.min.every((x, a) => x <= region.center[a] + region.half) && t.max.every((x, a) => x >= region.center[a] - region.half))
        const stride = Math.max(1, Math.ceil(ts.length / limit)), points: { point: Point; kind: string; triangle: number }[] = []
        for (let i = 0; i < ts.length; i += stride) {
            const t = ts[i]
            for (let j = 0; j < 3; j++) { points.push({ point: t.p[j], kind: "vertex", triangle: t.id }); points.push({ point: mix(t.p[j], t.p[(j + 1) % 3], 0.5), kind: "edge-midpoint", triangle: t.id }) }
            points.push({ point: t.p[0].map((x, a) => (x + t.p[1][a] + t.p[2][a]) / 3) as Point, kind: "triangle-interior", triangle: t.id })
        }
        return { points, trianglesInRegion: ts.length, triangleStride: stride }
    }
}

export function measureReference(reference: Reference, mesh: MeshQuery) {
    const witnesses = reference.roots.map(r => ({ ...mesh.nearest(r.point), position: r.point, uncertainty: r.width / 2 + r.allowance }))
    const failures = witnesses.filter(w => w.distance - w.uncertainty > COVERAGE_TOLERANCE)
    const borderline = witnesses.filter(w => w.distance - w.uncertainty <= COVERAGE_TOLERANCE && w.distance + w.uncertainty > COVERAGE_TOLERANCE).length
    const worst = [...witnesses].sort((a, b) => b.distance - a.distance)[0] ?? null
    return { toleranceMm: COVERAGE_TOLERANCE, tested: witnesses.length, failures: failures.length, borderline, worst, failureExamples: failures.slice(0, 20), status: failures.length ? "FAIL" : !witnesses.length || reference.unrefinedBrackets || borderline ? "INCOMPLETE" : "SAMPLED_PASS" }
}

/** A section of two independently sampled surface sheets, not an SFCC curve label. */
export interface CreaseReference {
    station: number; seed: Point; status: "RESOLVED" | "AMBIGUOUS"; reason?: string
    point?: Point; tangent?: Point; normals?: [Point, Point]; contrast?: number; angularAllowance?: number; supports?: [Root, Root]
    verification?: { offsets: number[]; contrasts: number[]; roots: Root[]; candidateField: number; center?: Sample; failedTargets?: number[] }
    initialIntersection?: { supportCount: number; contrast: number; supports?: [Root, Root]; determinant?: number; proposedPoint?: Point }
    searchAttempts?: Array<{ stage: string; radius?: number; searches: NormalSearchReceipt[] }>
    refinementStops?: Array<{ radius: number; reason: string; determinant?: number; proposedPoint?: Point }>
}
export function creaseReferences(reference: Reference): CreaseReference[] {
    const path = reference.region.crease
    if (!path) return []
    const tangent = unit(sub(path[1], path[0]))
    return Array.from({ length: 9 }, (_, i) => {
        const seed = mix(path[0], path[1], (i + 1) / 10)
        const local = reference.roots.filter(r => distance(r.point, seed) < 0.075)
        let pair: [Root, Root] | undefined, contrast = 0
        for (let a = 0; a < local.length; a++) for (let b = a + 1; b < local.length; b++) { const c = angle(local[a].normal, local[b].normal); if (c > contrast) { contrast = c; pair = [local[a], local[b]] } }
        if (!pair || contrast < Math.PI / 180) return { station: i, seed, status: "AMBIGUOUS" as const, reason: "NO_DISTINCT_GPU_NORMAL_PAIR", initialIntersection: { supportCount: local.length, contrast, supports: pair } }
        const [a, b] = pair, n1 = unit(a.normal), n2 = unit(b.normal), det = dot(n1, cross(n2, tangent))
        if (Math.abs(det) < 1e-3) return { station: i, seed, status: "AMBIGUOUS" as const, reason: "ILL_CONDITIONED_INITIAL_PLANES", initialIntersection: { supportCount: local.length, contrast, supports: pair, determinant: det } }
        const delta = add(add(cross(n2, tangent).map(x => x * dot(n1, sub(a.point, seed)) / det) as Point, cross(tangent, n1).map(x => x * dot(n2, sub(b.point, seed)) / det) as Point), [0, 0, 0])
        const point = add(seed, delta)
        if (distance(point, seed) > 0.075) return { station: i, seed, status: "AMBIGUOUS" as const, reason: "INITIAL_INTERSECTION_OUTSIDE_SECTION", initialIntersection: { supportCount: local.length, contrast, supports: pair, determinant: det, proposedPoint: point } }
        return { station: i, seed, status: "RESOLVED" as const, point, tangent, normals: [n1, n2] as [Point, Point], contrast, angularAllowance: Math.min(2 * Math.PI / 180, contrast / 5), supports: pair, initialIntersection: { supportCount: local.length, contrast, supports: pair, determinant: det, proposedPoint: point } }
    })
}

/** Shrinking surface-side probes reject smooth curvature masquerading as a jump. */
export async function verifyCreaseReferences(references: CreaseReference[], sample: Sampler): Promise<CreaseReference[]> {
    const offsets = [0.02, 0.01, 0.005]
    for (const ref of references) {
        if (ref.status !== "RESOLVED") continue
        const sideTargets = (radius: number) => ref.normals!.map((n, side) => {
            let direction = unit(cross(ref.tangent!, n))
            if (dot(direction, sub(ref.supports![side].point, ref.point!)) < 0) direction = direction.map(x => -x) as Point
            return { point: add(ref.point!, direction, radius), normal: n }
        })
        ref.searchAttempts = []; ref.refinementStops = []
        const project = async (targets: NormalSearchTarget[], stage: string, radius?: number): Promise<Array<Root | null>> => {
            const searches = await searchNormalBrackets(targets, 0.03, sample)
            ref.searchAttempts!.push({ stage, ...(radius === undefined ? {} : { radius }), searches })
            // A nearby root can prove proximity but cannot choose an incident sheet.
            // Multiple observed crossings therefore remain a branch ambiguity here.
            return searches.map(search => search.association.eligible ? search.roots[search.association.rootIndex!] : null)
        }
        // Improve the seed using successively local GPU tangent planes in its
        // fixed transverse section. No SFCC carrier or feature chart is queried.
        for (const radius of [0.04, 0.02, 0.01, 0.005]) {
            const targets = ref.normals!.flatMap(n => [-1, 1].map(sign => ({ point: add(ref.point!, unit(cross(ref.tangent!, n)), sign * radius), normal: n })))
            const candidates = await project(targets, "TANGENT_PLANE_REFINEMENT", radius)
            const roots = ref.normals!.map((n, side) => candidates.slice(2 * side, 2 * side + 2).filter((r): r is Root => r !== null).sort((a, b) => angle(a.normal, n) - angle(b.normal, n))[0])
            if (roots.some(r => !r)) { ref.refinementStops.push({ radius, reason: "MISSING_UNAMBIGUOUS_SIDE_BRACKET" }); break }
            const [a, b] = roots, n1 = unit(a.normal), n2 = unit(b.normal), tangent = ref.tangent!, det = dot(n1, cross(n2, tangent))
            if (Math.abs(det) < 0.01) { ref.refinementStops.push({ radius, reason: "ILL_CONDITIONED_TANGENT_PLANES", determinant: det }); break }
            const delta = add(cross(n2, tangent).map(x => x * dot(n1, sub(a.point, ref.seed)) / det) as Point, cross(tangent, n1).map(x => x * dot(n2, sub(b.point, ref.seed)) / det) as Point)
            const point = add(ref.seed, delta)
            if (distance(point, ref.seed) > 0.075) { ref.refinementStops.push({ radius, reason: "REFINEMENT_OUTSIDE_SECTION", determinant: det, proposedPoint: point }); break }
            ref.refinementStops.push({ radius, reason: "TANGENT_PLANE_UPDATE_ACCEPTED", determinant: det, proposedPoint: point })
            ref.point = point; ref.normals = [n1, n2]; ref.supports = [a, b]
        }
        const [center] = await checkedSample([rounded(ref.point!)], sample)
        const projected = await project(offsets.flatMap(sideTargets), "SHRINKING_SIDE_VERIFICATION")
        const roots = projected.filter((r): r is Root => r !== null)
        const failedTargets = projected.flatMap((r, i) => r ? [] : [i])
        const contrasts = roots.length === 6 ? offsets.map((_, i) => angle(roots[2 * i].normal, roots[2 * i + 1].normal)) : []
        ref.verification = { offsets, contrasts, roots, candidateField: center.field, center, failedTargets }
        if (roots.length !== 6 || Math.abs(center.field) > 0.002) { ref.status = "AMBIGUOUS"; ref.reason = roots.length !== 6 && Math.abs(center.field) > 0.002 ? "SIDE_BRACKETS_AND_CANDIDATE_FIELD_UNRESOLVED" : roots.length !== 6 ? "SIDE_BRACKETS_UNRESOLVED" : "CANDIDATE_FIELD_AGREEMENT_FAILED"; continue }
        if (roots.some(r => r.width > 4 * r.allowance) || contrasts[2] < Math.PI / 180 || Math.max(...contrasts) - Math.min(...contrasts) > 0.2 * contrasts[2]) {
            ref.status = "AMBIGUOUS"; ref.reason = roots.some(r => r.width > 4 * r.allowance) ? "SIDE_ROOT_REFINEMENT_UNRESOLVED" : contrasts[2] < Math.PI / 180 ? "INSUFFICIENT_NORMAL_CONTRAST" : "NORMAL_CONTRAST_COLLAPSES_WITH_OFFSET"; continue
        }
        ref.normals = [unit(roots[4].normal), unit(roots[5].normal)]
        ref.contrast = contrasts[2]
        // Empirical normal budget, paired with a separate retained-jump test:
        // two faces with identical normals cannot pass even inside this angle.
        ref.angularAllowance = Math.max(2 * Math.PI / 180, ref.contrast / 2)
    }
    return references
}

export function measureCrease(reference: ReturnType<typeof creaseReferences>, mesh: MeshQuery, features: Float64Array, centroidNormals?: Map<number, Point>) {
    const memberships = new Set<string>()
    for (let i = 0; i < features.length; i += 5) memberships.add([features[i], features[i + 1]].sort((a, b) => a - b).join(":"))
    const stations = reference.map(r => {
        if (r.status !== "RESOLVED") return { station: r.station, status: "AMBIGUOUS", reason: r.reason, candidates: [] as string[] }
        const candidates: string[] = [], labeled: string[] = []
        let nearestSharpDistance = Infinity, bestNormalError = Infinity, centroidNormalError = Infinity, missingCentroidPairs = 0
        for (const [key, edge] of mesh.edges) {
            if (edge.faces.length !== 2) continue
            const [a, b] = edge.ids.map(i => mesh.positions[i]), ab = sub(b, a), q = add(a, ab, Math.max(0, Math.min(1, dot(sub(r.point!, a), ab) / dot(ab, ab)))), d = distance(q, r.point!)
            if (d > FEATURE_TOLERANCE) continue
            const normals = edge.faces.map(f => f.normal)
            const error = Math.min(Math.max(angle(normals[0], r.normals![0]), angle(normals[1], r.normals![1])), Math.max(angle(normals[1], r.normals![0]), angle(normals[0], r.normals![1])))
            bestNormalError = Math.min(bestNormalError, error)
            if (centroidNormals) {
                const refs = edge.faces.map(f => centroidNormals.get(f.id))
                if (refs.some(n => !n)) { missingCentroidPairs++; continue }
                const localError = Math.max(...normals.map((n, i) => angle(n, refs[i]!)))
                centroidNormalError = Math.min(centroidNormalError, localError)
                if (localError > r.angularAllowance!) continue
            }
            if (error > r.angularAllowance! || angle(normals[0], normals[1]) < 0.5 * r.contrast!) continue
            nearestSharpDistance = Math.min(nearestSharpDistance, d); candidates.push(key)
            if (memberships.has(key)) labeled.push(key)
        }
        return { station: r.station, status: candidates.length ? "SAMPLED_PASS" : missingCentroidPairs ? "AMBIGUOUS" : "FAIL", missingCentroidPairs, correspondingCentroidNormalErrorDegrees: Number.isFinite(centroidNormalError) ? centroidNormalError * 180 / Math.PI : null, position: r.point, referenceContrastDegrees: r.contrast! * 180 / Math.PI, minimumRetainedContrastFraction: 0.5, angularAllowanceDegrees: r.angularAllowance! * 180 / Math.PI, bestNormalErrorDegrees: Number.isFinite(bestNormalError) ? bestNormalError * 180 / Math.PI : null, nearestSharpDistance: Number.isFinite(nearestSharpDistance) ? nearestSharpDistance : null, candidates, labeled }
    })
    // Follow the ordered sections through the complete candidate-edge graph.
    // Several short edges may lie between two sections; direct adjacency is not
    // required. Direction is measured along this short reference section path.
    const first = reference.find(r => r.status === "RESOLVED"), last = [...reference].reverse().find(r => r.status === "RESOLVED")
    const direction = first && last ? unit(sub(last.point!, first.point!)) : [0, 0, 0] as Point
    const graph = new Map<number, number[]>()
    for (const key of new Set(stations.flatMap(s => s.candidates))) {
        let [a, b] = mesh.edges.get(key)!.ids
        if (dot(mesh.positions[a], direction) > dot(mesh.positions[b], direction)) [a, b] = [b, a]
        if (!graph.has(a)) graph.set(a, [])
        graph.get(a)!.push(b)
    }
    let reachable = new Set(stations[0]?.candidates ?? []), connected = !!reachable.size
    for (const station of stations.slice(1)) {
        const vertices = new Set([...reachable].flatMap(key => mesh.edges.get(key)!.ids)), queue = [...vertices]
        for (let i = 0; i < queue.length; i++) for (const next of graph.get(queue[i]) ?? []) if (!vertices.has(next)) { vertices.add(next); queue.push(next) }
        const next = new Set(station.candidates.filter(key => reachable.has(key) || mesh.edges.get(key)!.ids.some(v => vertices.has(v))))
        if (!next.size) connected = false
        reachable = next
    }
    return { toleranceMm: FEATURE_TOLERANCE, metadataStatus: stations.some(s => s.status === "SAMPLED_PASS" && !s.labeled?.length) ? "FAIL" : stations.some(s => s.status !== "SAMPLED_PASS") ? "INCOMPLETE" : "SAMPLED_PASS", status: stations.some(s => s.status === "FAIL") ? "FAIL" : !stations.length || stations.some(s => s.status === "AMBIGUOUS") ? "INCOMPLETE" : connected ? "SAMPLED_PASS" : "FAIL", connected, stations, missingLabelStations: stations.filter(s => s.status === "SAMPLED_PASS" && !s.labeled?.length).length }
}

export async function runCoverage(regions: Region[], mesh: MeshQuery, features: Float64Array, sample: Sampler) {
    const start = performance.now(), records = []
    for (const region of regions) {
        const reference = await scanRegion(region, sample), surfaceToMesh = measureReference(reference, mesh)
        const selected = mesh.regionalSamples(region), samples = await checkedSample(selected.points.map(s => s.point), sample)
        const residuals = samples.map((s, i) => ({ ...selected.points[i], sampledPoint: s.point, field: s.field, normal: s.normal }))
        const worstResidual = [...residuals].sort((a, b) => Math.abs(b.field) - Math.abs(a.field))[0] ?? null
        // A local bracket along the GPU normal supplies a sampled displacement
        // upper bound, never a geometric-distance lower bound or |f| shortcut.
        const projectionSearches = await searchNormalBrackets(samples, 0.04, sample)
        const displacements = projectionSearches.flatMap((search, i) => {
            const candidates = search.roots.map((r, rootIndex) => ({ root: r, rootIndex, displacementUpperBound: distance(samples[i].point, r.point) + r.width / 2 + r.allowance })).sort((a, b) => a.displacementUpperBound - b.displacementUpperBound)
            // Existential geometric proximity does not establish closest-root identity.
            return candidates.length ? [{ ...selected.points[i], ...candidates[0], searchIndex: i, observedCrossings: search.roots.length }] : []
        })
        const projectionReasons = countReasons(projectionSearches.map(s => s.reason))
        const centroidNormals = new Map<number, Point>()
        for (const d of displacements) if (projectionSearches[d.searchIndex].association.eligible && d.kind === "triangle-interior" && d.displacementUpperBound <= COVERAGE_TOLERANCE && d.root.width <= 4 * d.root.allowance) centroidNormals.set(d.triangle, d.root.normal)
        const creaseReference = await verifyCreaseReferences(creaseReferences(reference), sample), crease = region.crease ? measureCrease(creaseReference, mesh, features, centroidNormals) : null
        records.push({ region, reference, surfaceToMesh, referenceDiagnostics: { meshProjection: summarizeNormalSearches(projectionSearches), creaseProjection: summarizeNormalSearches(creaseReference.flatMap(r => r.searchAttempts?.flatMap(s => s.searches) ?? [])), creaseSectionReasons: countReasons(creaseReference.map(r => r.reason ?? "RESOLVED")), tangentPlaneReasons: countReasons(creaseReference.flatMap(r => r.refinementStops?.map(s => s.reason) ?? [])) }, meshToField: { samples: residuals.length, trianglesInRegion: selected.trianglesInRegion, triangleStride: selected.triangleStride, fieldResidualBudget: COVERAGE_TOLERANCE, residualFailures: residuals.filter(s => Math.abs(s.field) > COVERAGE_TOLERANCE).length, worstResidual, residuals, ambiguousProjections: samples.length - displacements.length, ambiguousSheetAssociations: projectionSearches.filter(s => !s.association.eligible).length, multipleCrossingLines: projectionSearches.filter(s => s.roots.length > 1).length, projectionReasons, projectionSearches, projectionBudgetMm: COVERAGE_TOLERANCE, unresolvedProjectionBudget: displacements.filter(d => d.displacementUpperBound > COVERAGE_TOLERANCE || d.root.width > 4 * d.root.allowance).length, displacements }, creaseReference, crease })
    }
    return { schemaVersion: 2, normalSearchBudget: NORMAL_SEARCH_BUDGET, evaluator: "GPU sceneSDF / IsoSampleBatch", toleranceMm: COVERAGE_TOLERANCE, coverageMs: performance.now() - start, status: records.some(r => r.surfaceToMesh.status === "FAIL" || r.meshToField.residualFailures || r.crease?.status === "FAIL" || r.crease?.metadataStatus === "FAIL") ? "FAIL" : records.some(r => r.surfaceToMesh.status === "INCOMPLETE" || r.meshToField.ambiguousProjections || r.meshToField.ambiguousSheetAssociations || r.meshToField.unresolvedProjectionBudget || r.crease?.status === "INCOMPLETE") ? "INCOMPLETE" : "SAMPLED_REGIONS_ONLY", regions: records, limitations: ["Finite regional sign-bracket samples, not global Hausdorff or multi-sheet coverage.", "Same-sign grid segments are unchanged and unsearched for hidden roots. Finite nested normal searches can still miss thin sheets and tangencies; no absence or uniqueness inference.", "Multiple observed normal-line crossings retain all brackets; a nearby bracket supports existential proximity but does not identify an incident sheet. Unresolved bracket width and zero or non-forward root normals also prevent centroid/crease normal association.", "Float32 position allowance does not certify WGSL field arithmetic or CPU/GPU model equivalence.", "Mesh-to-GPU field residual has field units; it is not Euclidean distance. Normal-bracket displacement is a sampled upper bound only.", "Crease references are local intersections of GPU tangent planes, with empirical curvature error; they are not analytic curve certificates."] }
}

/** Real captured geometry is deliberately damaged; references are held fixed. */
export async function corruptionChecks(coverage: Awaited<ReturnType<typeof runCoverage>>, mesh: MeshQuery, features: Float64Array, sample: Sampler) {
    const checks: Array<Record<string, unknown>> = []
    const junction = coverage.regions.find(r => r.region.id === "dent-rib-junction")
    if (junction) {
        const nearestJunction = mesh.nearest(junction.region.center).point
        const deleted = mesh.triangles.filter(t => distance(nearestJunction, closestPoint(junction.region.center, ...t.p as [Point, Point, Point]) as Point) < 0.065).map(t => t.id)
        const omit = new Set(deleted), indices: number[] = []
        for (let i = 0; i < mesh.tris.length; i += 3) if (!omit.has(i / 3)) indices.push(...mesh.tris.subarray(i, i + 3))
        const result = measureReference(junction.reference, new MeshQuery(mesh.verts, new Uint32Array(indices)))
        checks.push({ mutation: "delete-junction-patch", deletedTriangles: deleted, detected: result.status === "FAIL", evidence: result, oracle: "GPU roots to retained triangle geometry, no topology check" })
    }
    const crease = coverage.regions.find(r => r.region.id === "loft-chamfer-crease")
    if (crease) {
        const missing = measureCrease(crease.creaseReference, mesh, new Float64Array())
        checks.push({ mutation: "remove-feature-labels", detected: missing.missingLabelStations > (crease.crease?.missingLabelStations ?? 0), evidence: missing, oracle: "Metadata loss reported separately from geometric sharpness" })
        const resolved = crease.creaseReference.filter(r => r.status === "RESOLVED")
        if (resolved.length) {
            const middle = resolved[Math.floor(resolved.length / 2)], normal = unit(add(middle.normals![0], middle.normals![1])), center = middle.point!
            const verts = mesh.verts.slice(), moved: Array<{ vertex: number; from: Point; to: Point }> = []
            for (let i = 0; i < mesh.positions.length; i++) {
                const p = mesh.positions[i]
                if (!p.every((x, a) => Math.abs(x - crease.region.center[a]) <= crease.region.half + 0.05)) continue
                const q = rounded(add(p, normal, -dot(sub(p, center), normal)))
                verts.set(q, i * 8); moved.push({ vertex: i, from: p, to: q })
            }
            const result = measureCrease(crease.creaseReference, new MeshQuery(verts, mesh.tris), features)
            checks.push({ mutation: "flatten-crease-geometry", detected: result.stations.some((s, i) => s.status === "FAIL" && crease.crease?.stations[i]?.status === "SAMPLED_PASS"), moved, evidence: result, oracle: "Triangle positions changed; recomputed incident face normals, unchanged normal buffer/labels" })
        } else checks.push({ mutation: "flatten-crease-geometry", detected: false, reason: "GPU crease reference unresolved" })
        const targets: Point[] = [[-4, 16, 0], [4, 16, 0], [0, 16, 4]], bridge = targets.map(p => mesh.nearest(p).point)
        const probes = [mix(bridge[0], bridge[1], 0.5), mix(bridge[1], bridge[2], 0.5), mix(bridge[2], bridge[0], 0.5), bridge[0].map((x, a) => (x + bridge[1][a] + bridge[2][a]) / 3) as Point]
        const samples = await checkedSample(probes, sample)
        checks.push({ mutation: "bridge-internal-branch-passage", addedTriangle: bridge, detected: samples.some(s => Math.abs(s.field) > COVERAGE_TOLERANCE), samples, oracle: "GPU field disagreement at added face edges/interior, independent of topology" })
    }
    return { passed: checks.every(c => c.detected === true), checks }
}
