//! S1c — CSG trimming and corner wiring. Port of `src/export/sfcc/trim.mts`.
//!
//! A curve sample p is ALIVE (a real crease of the final solid) iff:
//!   1. |f_tree(p)| ≤ surface_tol — p is on the final surface;
//!   2. the adjacent strata disagree by more than the minimum dihedral
//!      (sign-adjusted normals: dot ≤ crease gate);
//!   3. BOTH strata have a surviving flank: probing `probe_delta` off the curve
//!      within each stratum's surface, the full tree SDF still vanishes and its
//!      normal agrees with the stratum's.
//!
//! Alive/dead transitions are bisected on the curve parameter and become CORNER
//! candidates. Candidates merge by distance, curves split at on-curve corners,
//! and corner records are wired with incident curve ends.

use crate::sfcc::feature_curves::{make_circle_curve, make_segment_curve, make_traced_curve, CurveKind, FeatureCurve};
use crate::sfcc::feature_set::SfccCorner;
use crate::sfcc::newton::project_to_triple;
use crate::sfcc::tree::SfccTree;
use crate::strata::Stratum;
use crate::tolerances::ResolvedTolerances;
use std::f64::consts::PI;

const TAU: f64 = 2.0 * PI;

/// One-sided flank survival: does the final surface ε off the curve consist of
/// this stratum? Port of `flankSurvives`.
#[allow(clippy::too_many_arguments)]
fn flank_survives(
    tree: &SfccTree<'_>,
    stratum: &Stratum,
    x: f64,
    y: f64,
    z: f64,
    dx: f64,
    dy: f64,
    dz: f64,
    tol: &ResolvedTolerances,
) -> bool {
    for sign in [1.0f64, -1.0] {
        let px = x + sign * tol.probe_delta * dx;
        let py = y + sign * tol.probe_delta * dy;
        let pz = z + sign * tol.probe_delta * dz;
        let proj = stratum.project(px, py, pz);
        if tree.f(proj[0], proj[1], proj[2]).abs() > tol.probe_delta * 0.2 {
            continue;
        }
        let flank_grad = tree.grad(proj[0], proj[1], proj[2]);
        let flank_normal = stratum.normal(proj[0], proj[1], proj[2]);
        let dot = flank_grad[0] * flank_normal[0] + flank_grad[1] * flank_normal[1] + flank_grad[2] * flank_normal[2];
        if dot >= 0.9 {
            return true;
        }
    }
    false
}

/// Aliveness of a single on-curve point. Port of `curvePointAlive`.
pub fn curve_point_alive(tree: &SfccTree<'_>, curve: &FeatureCurve, t: f64, tol: &ResolvedTolerances) -> bool {
    let p = curve.point_at(t);
    let (x, y, z) = (p[0], p[1], p[2]);
    if tree.f(x, y, z).abs() > tol.surface_tol {
        return false;
    }
    let sa = &tree.strata[curve.adjacent_strata[0]];
    let sb = &tree.strata[curve.adjacent_strata[1]];
    let na = sa.normal(x, y, z);
    let nb = sb.normal(x, y, z);
    // Crease gate: native modeled curves survive at any angle (only die when
    // essentially tangent, nativeCreaseCos); boolean seams use minDihedralCos.
    let crease_gate = if curve.native { tol.native_crease_cos } else { tol.min_dihedral_cos };
    if na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2] > crease_gate {
        return false;
    }
    let tg = curve.tangent_at(t);
    // In-surface, ⊥-curve probe directions: w = n × tangent.
    let wax = na[1] * tg[2] - na[2] * tg[1];
    let way = na[2] * tg[0] - na[0] * tg[2];
    let waz = na[0] * tg[1] - na[1] * tg[0];
    if !flank_survives(tree, sa, x, y, z, wax, way, waz, tol) {
        return false;
    }
    let wbx = nb[1] * tg[2] - nb[2] * tg[1];
    let wby = nb[2] * tg[0] - nb[0] * tg[2];
    let wbz = nb[0] * tg[1] - nb[1] * tg[0];
    flank_survives(tree, sb, x, y, z, wbx, wby, wbz, tol)
}

#[derive(Clone, Copy, Debug)]
pub struct TrimmedRun {
    pub curve_idx: usize,
    pub t0: f64,
    pub t1: f64,
    pub full_closed: bool,
}

/// Sample params for aliveness classification, spacing ≈ probeDelta. OPEN curves
/// are inset by ~2·probeDelta. Port of `classificationParams`.
fn classification_params(curve: &FeatureCurve, tol: &ResolvedTolerances) -> Vec<f64> {
    let span = curve.t_max - curve.t_min;
    let arc_len = (curve.param_distance(curve.t_min, curve.t_min + span / 2.0) * 2.0).max(1e-9);
    let n = (8usize).max((2048usize).min((arc_len / tol.probe_delta.max(1e-6)).ceil() as usize));
    let mut lo = curve.t_min;
    let mut hi = curve.t_max;
    if !curve.closed {
        let inset = (span / 4.0).min(span * ((2.0 * tol.probe_delta) / arc_len));
        lo += inset;
        hi -= inset;
    }
    let mut out = Vec::with_capacity(n + 1);
    for i in 0..=n {
        out.push(lo + ((hi - lo) * i as f64) / n as f64);
    }
    out
}

/// Bisect an alive/dead transition. Port of `bisectTransition`.
fn bisect_transition(
    tree: &SfccTree<'_>,
    curve: &FeatureCurve,
    t_alive: f64,
    t_dead: f64,
    tol: &ResolvedTolerances,
) -> f64 {
    let mut a = t_alive;
    let mut d = t_dead;
    for _ in 0..40 {
        let m = (a + d) / 2.0;
        if curve.param_distance(a, d) < tol.corner_merge_tol / 4.0 {
            break;
        }
        if curve_point_alive(tree, curve, m, tol) {
            a = m;
        } else {
            d = m;
        }
    }
    (a + d) / 2.0
}

/// Classify a curve into alive parameter runs (with transitions bisected). Port
/// of `trimCurve`. `curve_idx` indexes into the caller's raw-curve list.
pub fn trim_curve(
    tree: &SfccTree<'_>,
    curve: &FeatureCurve,
    curve_idx: usize,
    tol: &ResolvedTolerances,
) -> Vec<TrimmedRun> {
    let params = classification_params(curve, tol);
    let alive: Vec<bool> = params.iter().map(|&t| curve_point_alive(tree, curve, t, tol)).collect();
    if alive.iter().all(|&a| a) {
        return vec![TrimmedRun { curve_idx, t0: curve.t_min, t1: curve.t_max, full_closed: curve.closed }];
    }
    if alive.iter().all(|&a| !a) {
        return Vec::new();
    }

    let mut runs: Vec<TrimmedRun> = Vec::new();
    let mut run_start: Option<f64> = if alive[0] { Some(curve.t_min) } else { None };
    for i in 1..params.len() {
        if alive[i] && run_start.is_none() {
            run_start = Some(bisect_transition(tree, curve, params[i], params[i - 1], tol));
        } else if !alive[i] && run_start.is_some() {
            let end = bisect_transition(tree, curve, params[i - 1], params[i], tol);
            let start = run_start.unwrap();
            if curve.param_distance(start, end) > tol.corner_merge_tol {
                runs.push(TrimmedRun { curve_idx, t0: start, t1: end, full_closed: false });
            }
            run_start = None;
        }
    }
    if let Some(start) = run_start {
        runs.push(TrimmedRun { curve_idx, t0: start, t1: curve.t_max, full_closed: false });
    }
    // Closed curve whose first AND last samples are alive: merge the wrap-pair.
    if curve.closed && runs.len() >= 2 && alive[0] && alive[alive.len() - 1] {
        let first = runs[0];
        let last = runs[runs.len() - 1];
        if first.t0 == params[0] && last.t1 == params[params.len() - 1] {
            runs.pop();
            runs.remove(0);
            let wrap = curve.param_wrap.unwrap_or(0.0);
            runs.push(TrimmedRun { curve_idx, t0: last.t0 - wrap, t1: first.t1, full_closed: false });
        }
    }
    runs
}

pub struct TrimResult {
    pub curves: Vec<FeatureCurve>,
    pub corners: Vec<SfccCorner>,
}

#[derive(Clone, Copy)]
struct Candidate {
    x: f64,
    y: f64,
    z: f64,
}

fn nearest_candidate(candidates: &[Candidate], p: [f64; 3], tol: f64) -> i64 {
    let mut best = -1i64;
    let mut best_d = tol;
    for (i, c) in candidates.iter().enumerate() {
        let d = ((c.x - p[0]).powi(2) + (c.y - p[1]).powi(2) + (c.z - p[2]).powi(2)).sqrt();
        if d < best_d {
            best_d = d;
            best = i as i64;
        }
    }
    best
}

fn near_alive_surface(tree: &SfccTree<'_>, c: &SfccCorner, tol: &ResolvedTolerances) -> bool {
    // Valence-0 corners (cone apex) keep their record if still on the surface.
    c.curve_ends.is_empty() && c.strata.is_empty() && tree.f(c.x, c.y, c.z).abs() <= tol.surface_tol
}

/// Re-emit a parameter sub-range of a curve as a standalone curve. Port of
/// `remakeCurve`.
fn remake_curve(src: &FeatureCurve, id: usize, t0: f64, t1: f64, full_closed: bool) -> FeatureCurve {
    if full_closed {
        let mut c = src.clone();
        c.id = id;
        c.corner_start = -1;
        c.corner_end = -1;
        return c;
    }
    match src.kind() {
        CurveKind::Segment => {
            let a = src.point_at(t0);
            let b = src.point_at(t1);
            make_segment_curve(id, src.owner_node_id, src.adjacent_strata, a[0], a[1], a[2], b[0], b[1], b[2])
        }
        CurveKind::Circle => circle_from_source(src, id, t0, t1),
        CurveKind::Traced => {
            // Re-sample the sub-range from the source polyline density.
            let span = t1 - t0;
            let n = (2usize).max(span.abs().ceil() as usize + 1);
            let mut samples = vec![0.0f64; n * 3];
            for i in 0..n {
                let p = src.point_at(t0 + (span * i as f64) / (n - 1) as f64);
                samples[i * 3] = p[0];
                samples[i * 3 + 1] = p[1];
                samples[i * 3 + 2] = p[2];
            }
            let (sa, sb, refine) = src.traced_carriers().expect("traced curve carries its carriers");
            make_traced_curve(id, src.adjacent_strata, samples, false, sa, sb, refine, src.owner_node_id)
        }
    }
}

/// Recover an arc curve from a source circle's geometry. Port of `circleFromSource`.
fn circle_from_source(src: &FeatureCurve, id: usize, t0: f64, t1: f64) -> FeatureCurve {
    let a = src.point_at(0.0);
    let b = src.point_at(TAU / 3.0);
    let c = src.point_at(2.0 * TAU / 3.0);
    let abx = b[0] - a[0];
    let aby = b[1] - a[1];
    let abz = b[2] - a[2];
    let acx = c[0] - a[0];
    let acy = c[1] - a[1];
    let acz = c[2] - a[2];
    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    let n2 = nx * nx + ny * ny + nz * nz;
    let ab2 = abx * abx + aby * aby + abz * abz;
    let ac2 = acx * acx + acy * acy + acz * acz;
    let t1x = (ny * abz - nz * aby) * ac2;
    let t1y = (nz * abx - nx * abz) * ac2;
    let t1z = (nx * aby - ny * abx) * ac2;
    let t2x = (acy * nz - acz * ny) * ab2;
    let t2y = (acz * nx - acx * nz) * ab2;
    let t2z = (acx * ny - acy * nx) * ab2;
    let cx = a[0] + (t1x + t2x) / (2.0 * n2);
    let cy = a[1] + (t1y + t2y) / (2.0 * n2);
    let cz = a[2] + (t1z + t2z) / (2.0 * n2);
    let r = ((a[0] - cx).powi(2) + (a[1] - cy).powi(2) + (a[2] - cz).powi(2)).sqrt();
    let nl = n2.sqrt();
    let arc_curve =
        make_circle_curve(id, src.owner_node_id, src.adjacent_strata, cx, cy, cz, nx / nl, ny / nl, nz / nl, r, None);
    let p0 = src.point_at(t0);
    let p1 = src.point_at(t1);
    let mut a0 = arc_curve.project(p0[0], p0[1], p0[2]).0;
    let mut a1 = arc_curve.project(p1[0], p1[1], p1[2]).0;
    let mid = src.point_at((t0 + t1) / 2.0);
    let am = arc_curve.project(mid[0], mid[1], mid[2]).0;
    let mut sweep = (a1 - a0) % TAU;
    if sweep <= 0.0 {
        sweep += TAU;
    }
    let in_arc = (am - a0 + TAU) % TAU <= sweep;
    if !in_arc {
        std::mem::swap(&mut a0, &mut a1);
        sweep = TAU - sweep;
    }
    make_circle_curve(
        id,
        src.owner_node_id,
        src.adjacent_strata,
        cx,
        cy,
        cz,
        nx / nl,
        ny / nl,
        nz / nl,
        r,
        Some((a0, a0 + sweep)),
    )
}

/// Trim all raw curves, derive corners, merge them, split curves at on-curve
/// corners, and wire curveEnds. Port of `trimAndWire`.
pub fn trim_and_wire(
    tree: &SfccTree<'_>,
    raw_curves: &[FeatureCurve],
    native_corners: &[SfccCorner],
    tol: &ResolvedTolerances,
) -> TrimResult {
    let mut candidates: Vec<Candidate> = Vec::new();
    let add_candidate = |candidates: &mut Vec<Candidate>, x: f64, y: f64, z: f64| -> usize {
        for (i, c) in candidates.iter().enumerate() {
            if ((c.x - x).powi(2) + (c.y - y).powi(2) + (c.z - z).powi(2)).sqrt() <= tol.corner_merge_tol {
                return i;
            }
        }
        candidates.push(Candidate { x, y, z });
        candidates.len() - 1
    };

    // Newton-refine an interior trim transition to the triple point.
    let refine_transition = |tree: &SfccTree<'_>, curve: &FeatureCurve, t: f64| -> [f64; 3] {
        let mut out = curve.point_at(t);
        let sa = tree.strata[curve.adjacent_strata[0]];
        let sb = tree.strata[curve.adjacent_strata[1]];
        let mut best: Option<Stratum> = None;
        let mut best_abs = tol.probe_delta * 2.0;
        for owner in tree.active_owners_at(out[0], out[1], out[2], tol.probe_delta * 2.0) {
            for st in &owner.leaf.strata {
                if st.id == sa.id || st.id == sb.id {
                    continue;
                }
                let a = st.f(out[0], out[1], out[2]).abs();
                if a < best_abs {
                    best_abs = a;
                    best = Some(*st);
                }
            }
        }
        if let Some(sc) = best {
            if let Some(refined) =
                project_to_triple(&sa, &sb, &sc, out[0], out[1], out[2], tol.curve_eps, tol.probe_delta * 4.0)
            {
                out = refined;
            }
        }
        out
    };

    // 1. Trim every curve; collect run endpoints as corner candidates.
    let mut all_runs: Vec<TrimmedRun> = Vec::new();
    let is_curve_end = |curve: &FeatureCurve, t: f64| -> bool {
        !curve.closed && ((t - curve.t_min).abs() < 1e-9 || (t - curve.t_max).abs() < 1e-9)
    };
    for (ci, curve) in raw_curves.iter().enumerate() {
        for run in trim_curve(tree, curve, ci, tol) {
            all_runs.push(run);
            if !run.full_closed {
                for t in [run.t0, run.t1] {
                    let end_p = if is_curve_end(curve, t) {
                        curve.point_at(t)
                    } else {
                        refine_transition(tree, curve, t)
                    };
                    add_candidate(&mut candidates, end_p[0], end_p[1], end_p[2]);
                }
            }
        }
    }
    // 2. Surviving native corners join the candidate set.
    for nc in native_corners {
        if tree.f(nc.x, nc.y, nc.z).abs() <= tol.surface_tol {
            add_candidate(&mut candidates, nc.x, nc.y, nc.z);
        }
    }

    // 3. Split runs at interior on-curve candidates.
    let mut split_runs: Vec<TrimmedRun> = Vec::new();
    for run in &all_runs {
        let curve = &raw_curves[run.curve_idx];
        let mut cuts: Vec<f64> = Vec::new();
        for c in &candidates {
            let pr = curve.project(c.x, c.y, c.z);
            if pr.1 > tol.corner_merge_tol * 2.0 {
                continue;
            }
            let mut t = pr.0;
            if let Some(wrap) = curve.param_wrap {
                if t > run.t1 {
                    t -= wrap;
                }
            }
            // Interior cut — but only if meaningfully inside.
            if t > run.t0 + 1e-12
                && t < run.t1 - 1e-12
                && curve.param_distance(run.t0, t) > tol.corner_merge_tol
                && curve.param_distance(t, run.t1) > tol.corner_merge_tol
            {
                cuts.push(t);
            }
        }
        if run.full_closed && !cuts.is_empty() {
            cuts.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let wrap = curve.param_wrap.unwrap_or(0.0);
            for i in 0..cuts.len() {
                let t0 = cuts[i];
                let t1 = if i + 1 < cuts.len() { cuts[i + 1] } else { cuts[0] + wrap };
                split_runs.push(TrimmedRun { curve_idx: run.curve_idx, t0, t1, full_closed: false });
            }
        } else if !cuts.is_empty() {
            cuts.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let mut prev = run.t0;
            for &t in &cuts {
                split_runs.push(TrimmedRun { curve_idx: run.curve_idx, t0: prev, t1: t, full_closed: false });
                prev = t;
            }
            split_runs.push(TrimmedRun { curve_idx: run.curve_idx, t0: prev, t1: run.t1, full_closed: false });
        } else {
            split_runs.push(*run);
        }
    }

    // 4. Emit final curves, snapping endpoints to candidates and wiring corners.
    let mut corners: Vec<SfccCorner> = candidates
        .iter()
        .enumerate()
        .map(|(i, c)| SfccCorner { id: i, x: c.x, y: c.y, z: c.z, strata: Vec::new(), curve_ends: Vec::new() })
        .collect();
    let mut out: Vec<FeatureCurve> = Vec::new();
    let snap_radius = (tol.corner_merge_tol * 2.0).max(tol.probe_delta * 2.5);
    for run in &split_runs {
        let src = &raw_curves[run.curve_idx];
        let id = out.len();
        let next: FeatureCurve;
        if run.full_closed {
            next = remake_curve(src, id, run.t0, run.t1, true);
        } else {
            let q0 = src.point_at(run.t0);
            let q1 = src.point_at(run.t1);
            let c0 = nearest_candidate(&candidates, q0, snap_radius);
            let c1 = nearest_candidate(&candidates, q1, snap_radius);
            let mut t0 = run.t0;
            let mut t1 = run.t1;
            if c0 >= 0 {
                let cand = candidates[c0 as usize];
                let pr = src.project(cand.x, cand.y, cand.z);
                let mut tc = pr.0;
                if let Some(wrap) = src.param_wrap {
                    if tc > t1 {
                        tc -= wrap;
                    }
                }
                if tc < t1 {
                    t0 = tc;
                }
            }
            if c1 >= 0 {
                let cand = candidates[c1 as usize];
                let pr = src.project(cand.x, cand.y, cand.z);
                let mut tc = pr.0;
                if let Some(wrap) = src.param_wrap {
                    if tc < t0 {
                        tc += wrap;
                    }
                }
                if tc > t0 {
                    t1 = tc;
                }
            }
            // Over-trace stubs: drop runs that loop back to one corner or fall
            // below the trim resolution.
            if c0 >= 0 && c0 == c1 {
                continue;
            }
            if src.param_distance(t0, t1) < snap_radius {
                continue;
            }
            let mut nc = remake_curve(src, id, t0, t1, false);
            if c0 >= 0 {
                let c0u = c0 as usize;
                nc.corner_start = c0;
                corners[c0u].curve_ends.push((id, 0));
                for &s in &src.adjacent_strata {
                    if !corners[c0u].strata.contains(&s) {
                        corners[c0u].strata.push(s);
                    }
                }
            }
            if c1 >= 0 {
                let c1u = c1 as usize;
                nc.corner_end = c1;
                corners[c1u].curve_ends.push((id, 1));
                for &s in &src.adjacent_strata {
                    if !corners[c1u].strata.contains(&s) {
                        corners[c1u].strata.push(s);
                    }
                }
            }
            next = nc;
        }
        out.push(next);
    }

    // Keep only wired corners (or valence-0 on-surface), compacting ids.
    let keep: Vec<SfccCorner> =
        corners.into_iter().filter(|c| !c.curve_ends.is_empty() || near_alive_surface(tree, c, tol)).collect();
    let mut remap: std::collections::HashMap<usize, usize> = std::collections::HashMap::new();
    for (i, c) in keep.iter().enumerate() {
        remap.insert(c.id, i);
    }
    for curve in &mut out {
        curve.corner_start = if curve.corner_start >= 0 {
            remap.get(&(curve.corner_start as usize)).map(|&v| v as i64).unwrap_or(-1)
        } else {
            -1
        };
        curve.corner_end = if curve.corner_end >= 0 {
            remap.get(&(curve.corner_end as usize)).map(|&v| v as i64).unwrap_or(-1)
        } else {
            -1
        };
    }
    let final_corners: Vec<SfccCorner> =
        keep.into_iter().enumerate().map(|(i, c)| SfccCorner { id: i, ..c }).collect();
    TrimResult { curves: out, corners: final_corners }
}
