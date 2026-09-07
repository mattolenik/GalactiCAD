//! S1b — boolean seam curve tracing. Port of `src/export/sfcc/seam-trace.mts`.
//!
//! Seams are traced on analytic CARRIER PAIRS {fA = fB = 0} (never on the
//! primitive SDFs): one generic predictor–corrector for every pair kind. Over-
//! tracing onto carrier extensions beyond the actual faces is intentional —
//! CSG trimming ([`crate::sfcc::trim`]) removes it.
//!
//! Candidate pairs: any two leaves with overlapping (inflated) world AABBs,
//! except pairs whose lowest common combiner is a smooth blend whose on-locus
//! displacement exceeds `surface_tol`. Seeding: deterministic grid + min-norm
//! Newton. Guards: tangency bail, corrector-displacement cap, tangent-angle
//! step control, closed-loop detection, step cap.

use crate::sfcc::feature_curves::{make_traced_curve, FeatureCurve, TracedRefine};
use crate::sfcc::newton::{carrier_pair_tangent, project_to_carrier_pair};
use crate::sfcc::tree::SfccTree;
use crate::strata::Stratum;
use crate::tolerances::ResolvedTolerances;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SeamTraceDiagnostics {
    pub pairs_considered: usize,
    pub seeds_found: usize,
    pub curves_traced: usize,
    pub tangency_bails: usize,
    pub step_cap_hits: usize,
    pub correction_bails: usize,
    pub tangent_reversals: usize,
}

#[derive(Clone, Copy, Debug)]
enum TraceEnd {
    Bounds,
    Closed,
    Tangency,
    Reversal,
    Correction,
    Budget,
}

struct TraceResult {
    samples: Vec<f64>,
    closed: bool,
    hit_cap: bool,
    end: TraceEnd,
}

/// A raw traced seam piece: its samples, closed flag, and adjacent carriers.
pub struct SeamPiece {
    pub samples: Vec<f64>,
    pub closed: bool,
    pub sa: Stratum,
    pub sb: Stratum,
}

/// Trace from a seed in one direction until exit/loop/cap. Port of `traceDirection`.
#[allow(clippy::too_many_arguments)]
fn trace_direction(
    sa: &Stratum,
    sb: &Stratum,
    seed: [f64; 3],
    dir: f64,
    bounds: &[f64; 6],
    tol: &ResolvedTolerances,
    h_init: f64,
) -> TraceResult {
    let mut samples: Vec<f64> = Vec::new();
    let mut t = [0.0; 3];
    let [mut x, mut y, mut z] = seed;
    let mut h = h_init;
    let h_min = (tol.curve_eps * 100.0).max(h_init / 256.0);
    let h_max = h_init * 4.0;
    let mut px = 0.0;
    let mut py = 0.0;
    let mut pz = 0.0;
    let mut have_prev_tangent = false;
    let mut closed = false;
    let mut hit_cap = true;
    let mut end = TraceEnd::Budget;
    for _ in 0..tol.max_trace_steps {
        let mag = carrier_pair_tangent(sa, sb, x, y, z, &mut t);
        if mag < tol.min_tangency_sin {
            hit_cap = false;
            end = TraceEnd::Tangency;
            break; // tangency bail — diagnostic, never loops
        }
        if have_prev_tangent && t[0] * px + t[1] * py + t[2] * pz < 0.0 {
            // Tangent flipped — passed a singular point; stop.
            hit_cap = false;
            end = TraceEnd::Reversal;
            break;
        }
        px = t[0];
        py = t[1];
        pz = t[2];
        have_prev_tangent = true;

        // Predictor + corrector with step control.
        let mut accepted = false;
        for _ in 0..10 {
            // Retry from the original tangent. `t` is overwritten below by
            // the rejected candidate's tangent and must not steer the retry.
            let cx = x + dir * h * px;
            let cy = y + dir * h * py;
            let cz = z + dir * h * pz;
            let q = match project_to_carrier_pair(sa, sb, cx, cy, cz, tol.curve_eps, tol.min_tangency_sin, h)
            {
                Some(q) => q,
                None => {
                    h = h_min.max(h / 2.0);
                    continue;
                }
            };
            // A corrector can return to the current point at a branch cusp.
            // Require forward progress; otherwise tiny retries can bounce at
            // the same junction until the trace budget is exhausted.
            let advance = dir * ((q[0] - x) * px + (q[1] - y) * py + (q[2] - z) * pz);
            if advance < h * 0.05 {
                h = h_min.max(h / 2.0);
                continue;
            }
            let corr = ((q[0] - cx).powi(2) + (q[1] - cy).powi(2) + (q[2] - cz).powi(2)).sqrt();
            if corr > h / 2.0
                && (h > tol.max_chord_error * 0.1
                    || !sa.domain_contains(q, tol.curve_eps * 8.)
                    || !sb.domain_contains(q, tol.curve_eps * 8.))
            {
                // Branch-jump guard.
                h = h_min.max(h / 2.0);
                continue;
            }
            let mag_n = carrier_pair_tangent(sa, sb, q[0], q[1], q[2], &mut t);
            if mag_n < tol.min_tangency_sin {
                accepted = true; // accept the point; the next iteration bails
                x = q[0];
                y = q[1];
                z = q[2];
                break;
            }
            let cos_turn = dir * (t[0] * px + t[1] * py + t[2] * pz) * dir;
            if cos_turn < 0.35f64.cos() {
                // A piecewise operand can have a finite tangent jump. First
                // bound the entire crossing step, then locate the junction;
                // shrinking forever cannot turn a corner into a smooth arc.
                if cos_turn <= 0.
                    || h > tol.max_chord_error * 0.1
                    || !sa.domain_contains(q, tol.curve_eps * 8.)
                    || !sb.domain_contains(q, tol.curve_eps * 8.)
                {
                    h = h_min.max(h / 2.0);
                    continue;
                }
                let start = [x, y, z];
                let mut lo = 0.;
                let mut hi = 1.;
                let mut junction = start;
                let mut valid = true;
                for _ in 0..24 {
                    let u = (lo + hi) * 0.5;
                    let seed: [f64; 3] = std::array::from_fn(|k| start[k] * (1. - u) + q[k] * u);
                    let Some(p) = project_to_carrier_pair(
                        sa,
                        sb,
                        seed[0],
                        seed[1],
                        seed[2],
                        tol.curve_eps,
                        tol.min_tangency_sin,
                        h,
                    ) else {
                        valid = false;
                        break;
                    };
                    // Do not use this route to jump to a distant component.
                    if (p[0] - seed[0]).hypot(p[1] - seed[1]).hypot(p[2] - seed[2])
                        > tol.max_chord_error * 0.1
                    {
                        valid = false;
                        break;
                    }
                    let mut tangent = [0.; 3];
                    carrier_pair_tangent(sa, sb, p[0], p[1], p[2], &mut tangent);
                    if tangent[0] * px + tangent[1] * py + tangent[2] * pz >= 0.35f64.cos() {
                        lo = u;
                        junction = p;
                    } else {
                        hi = u;
                    }
                }
                if !valid {
                    h = h_min.max(h / 2.);
                    continue;
                }
                samples.extend_from_slice(&junction);
                samples.extend_from_slice(&junction); // explicit junction marker
            }
            // Chord-error step adaptation: err ≈ h·θ/8.
            let theta = cos_turn.clamp(-1.0, 1.0).acos();
            let err = (h * theta) / 8.0;
            if err > tol.max_chord_error {
                h = h_min.max(h * 0.5);
                continue;
            }
            accepted = true;
            x = q[0];
            y = q[1];
            z = q[2];
            if err < tol.max_chord_error / 4.0 {
                h = h_max.min(h * 1.4);
            }
            break;
        }
        if !accepted {
            hit_cap = false;
            end = TraceEnd::Correction;
            break;
        }
        samples.push(x);
        samples.push(y);
        samples.push(z);

        // Exit / closed-loop checks.
        if x < bounds[0] || y < bounds[1] || z < bounds[2] || x > bounds[3] || y > bounds[4] || z > bounds[5]
        {
            hit_cap = false;
            end = TraceEnd::Bounds;
            break;
        }
        if samples.len() / 3 > 3 {
            let d0 = ((x - seed[0]).powi(2) + (y - seed[1]).powi(2) + (z - seed[2]).powi(2)).sqrt();
            // The final seed-to-end chord must obey the same geometric budget
            // as the traced segments. A full-size closing step can cut off an
            // entire rounded corner after a long flat run increased `h`.
            if d0 < (h * 0.9).min(tol.max_chord_error * 2.) {
                closed = true;
                hit_cap = false;
                end = TraceEnd::Closed;
                break;
            }
            if d0 < h * 2. {
                h = h_min.max(h.min(d0 * 0.5));
            }
        }
    }
    TraceResult { samples, closed, hit_cap, end }
}

fn record_end(diag: &mut SeamTraceDiagnostics, end: TraceEnd) {
    match end {
        TraceEnd::Tangency => diag.tangency_bails += 1,
        TraceEnd::Reversal => diag.tangent_reversals += 1,
        TraceEnd::Correction => diag.correction_bails += 1,
        _ => {}
    }
}

/// Trace all seam pieces between two strata carriers within an overlap box.
/// Port of `traceCarrierPair`.
pub fn trace_carrier_pair(
    sa: &Stratum,
    sb: &Stratum,
    overlap: &[f64; 6],
    tol: &ResolvedTolerances,
    diag: &mut SeamTraceDiagnostics,
) -> Vec<(Vec<f64>, bool)> {
    let size_x = overlap[3] - overlap[0];
    let size_y = overlap[4] - overlap[1];
    let size_z = overlap[5] - overlap[2];
    let max_size = size_x.max(size_y).max(size_z);
    if max_size <= 0.0 {
        return Vec::new();
    }
    let overlap_diag = (size_x * size_x + size_y * size_y + size_z * size_z).sqrt();
    let seed_cell = if tol.seed_cell_size > 0.0 { tol.seed_cell_size } else { overlap_diag / 8.0 };
    let inflate = seed_cell;
    let bounds = [
        overlap[0] - inflate,
        overlap[1] - inflate,
        overlap[2] - inflate,
        overlap[3] + inflate,
        overlap[4] + inflate,
        overlap[5] + inflate,
    ];

    // --- deterministic grid seeding ---
    let mut seeds: Vec<f64> = Vec::new();
    let nx = (2usize).max((size_x / seed_cell).ceil() as usize);
    let ny = (2usize).max((size_y / seed_cell).ceil() as usize);
    let nz = (2usize).max((size_z / seed_cell).ceil() as usize);
    let seed_dedup = tol.curve_eps * 8.0;
    for i in 0..=nx {
        for j in 0..=ny {
            for k in 0..=nz {
                let x = overlap[0] + (i as f64 / nx as f64) * size_x;
                let y = overlap[1] + (j as f64 / ny as f64) * size_y;
                let z = overlap[2] + (k as f64 / nz as f64) * size_z;
                // Cheap reject: both carriers within a cell of zero.
                if sa.f(x, y, z).abs() > seed_cell || sb.f(x, y, z).abs() > seed_cell {
                    continue;
                }
                let q = match project_to_carrier_pair(
                    sa,
                    sb,
                    x,
                    y,
                    z,
                    tol.curve_eps,
                    tol.min_tangency_sin,
                    seed_cell * 2.0,
                ) {
                    Some(q) => q,
                    None => continue,
                };
                if q[0] < bounds[0]
                    || q[1] < bounds[1]
                    || q[2] < bounds[2]
                    || q[0] > bounds[3]
                    || q[1] > bounds[4]
                    || q[2] > bounds[5]
                {
                    continue;
                }
                let mut dup = false;
                let mut s = 0;
                while s < seeds.len() && !dup {
                    if ((q[0] - seeds[s]).powi(2)
                        + (q[1] - seeds[s + 1]).powi(2)
                        + (q[2] - seeds[s + 2]).powi(2))
                    .sqrt()
                        < seed_dedup
                    {
                        dup = true;
                    }
                    s += 3;
                }
                if !dup {
                    seeds.push(q[0]);
                    seeds.push(q[1]);
                    seeds.push(q[2]);
                }
            }
        }
    }
    diag.seeds_found += seeds.len() / 3;
    if seeds.is_empty() {
        return Vec::new();
    }

    // --- trace from seeds, consuming nearby seeds ---
    let mut out: Vec<(Vec<f64>, bool)> = Vec::new();
    let n_seeds = seeds.len() / 3;
    let mut consumed = vec![false; n_seeds];
    let h_init = (overlap_diag / 64.0).min((8.0 * tol.max_chord_error).max(overlap_diag / 512.0));
    for s in 0..n_seeds {
        if consumed[s] {
            continue;
        }
        consumed[s] = true;
        let seed = [seeds[s * 3], seeds[s * 3 + 1], seeds[s * 3 + 2]];
        let fwd = trace_direction(sa, sb, seed, 1.0, &bounds, tol, h_init);
        record_end(diag, fwd.end);
        if fwd.hit_cap {
            diag.step_cap_hits += 1;
        }
        let closed = fwd.closed;
        let pts: Vec<f64> = if closed {
            let mut p = vec![seed[0], seed[1], seed[2]];
            p.extend_from_slice(&fwd.samples);
            // Close the loop exactly: last sample ≅ first.
            p.push(seed[0]);
            p.push(seed[1]);
            p.push(seed[2]);
            p
        } else {
            let back = trace_direction(sa, sb, seed, -1.0, &bounds, tol, h_init);
            record_end(diag, back.end);
            if back.hit_cap {
                diag.step_cap_hits += 1;
            }
            let mut rev: Vec<f64> = Vec::new();
            let bn = back.samples.len() / 3;
            for i in (0..bn).rev() {
                rev.push(back.samples[i * 3]);
                rev.push(back.samples[i * 3 + 1]);
                rev.push(back.samples[i * 3 + 2]);
            }
            let mut p = rev;
            p.push(seed[0]);
            p.push(seed[1]);
            p.push(seed[2]);
            p.extend_from_slice(&fwd.samples);
            p
        };
        if pts.len() / 3 < 2 {
            continue;
        }
        let samples = pts;
        // Consume only seeds covered by actual segments. A scene-scale ball
        // around a sample can erase a distinct nearby component or a continuation
        // beyond an endpoint. The radius here is the tracing accuracy budget.
        let consume_radius = tol.max_chord_error;
        for o in (s + 1)..n_seeds {
            if !consumed[o]
                && polyline_covers(sa, sb, &samples, &seeds[o * 3..o * 3 + 3], consume_radius, tol.curve_eps)
            {
                consumed[o] = true;
            }
        }
        // A midpoint overlap does not establish that the whole arc was traced.
        // Keep any piece with an uncovered sample, especially either endpoint.
        if samples.chunks_exact(3).all(|p| {
            out.iter().any(|prev| polyline_covers(sa, sb, &prev.0, p, consume_radius, tol.curve_eps))
        }) {
            continue;
        }
        // Predictor-corrector junction markers split a nonsmooth carrier
        // intersection into arcs sharing an explicit endpoint. No tangent
        // inference from coarse polylines is needed downstream.
        let mut pieces = Vec::new();
        let mut start = 0;
        for i in 1..samples.len() / 3 {
            if samples[(i - 1) * 3..i * 3] == samples[i * 3..(i + 1) * 3] {
                if i * 3 - start >= 6 {
                    pieces.push(samples[start..i * 3].to_vec());
                }
                start = i * 3;
            }
        }
        if start == 0 {
            out.push((samples, closed));
            diag.curves_traced += 1;
        } else {
            if samples.len() - start >= 6 {
                pieces.push(samples[start..].to_vec());
            }
            if closed && pieces.len() > 1 {
                let mut last = pieces.pop().unwrap();
                last.extend_from_slice(&pieces.remove(0)[3..]);
                pieces.insert(0, last);
            }
            diag.curves_traced += pieces.len();
            out.extend(pieces.into_iter().map(|p| (p, false)));
        }
    }
    out
}

/// Distance to finite segments, including endpoint bounds.
fn polyline_covers(sa: &Stratum, sb: &Stratum, samples: &[f64], p: &[f64], radius: f64, eps: f64) -> bool {
    samples.windows(6).step_by(3).any(|edge| {
        let d: [f64; 3] = std::array::from_fn(|k| edge[k + 3] - edge[k]);
        let l2 = d.iter().map(|v| v * v).sum::<f64>();
        let t = if l2 > 0. {
            ((0..3).map(|k| (p[k] - edge[k]) * d[k]).sum::<f64>() / l2).clamp(0., 1.)
        } else {
            0.
        };
        if (0..3).map(|k| (p[k] - edge[k] - t * d[k]).powi(2)).sum::<f64>() > radius * radius {
            return false;
        }
        let distance = |q: &[f64]| (0..3).map(|k| (p[k] - q[k]).powi(2)).sum::<f64>().sqrt();
        if distance(&edge[..3]) <= eps * 8. || distance(&edge[3..]) <= eps * 8. {
            return true;
        }
        if t <= 0. || t >= 1. {
            return false;
        } // never consume beyond an endpoint
          // Nearness is only a broad phase. Establish the same local carrier
          // branch and intersect it with the normal plane through the seed.
          // This distinguishes components even when separated by less than the
          // chord budget (e.g. the two rims of a thin spherical shell).
        for carrier in [sa, sb] {
            let a = carrier.normal(edge[0], edge[1], edge[2]);
            let b = carrier.normal(p[0], p[1], p[2]);
            if (0..3).map(|k| a[k] * b[k]).sum::<f64>() < 0.35f64.cos() {
                return false;
            }
        }
        let mut tangent = [0.; 3];
        carrier_pair_tangent(sa, sb, p[0], p[1], p[2], &mut tangent);
        let plane = Stratum::plane(
            crate::strata::StratumIdentity {
                id: usize::MAX,
                owner_node_id: -1,
                leaf_index: usize::MAX,
                local_index: 0,
                sign: 1.,
            },
            tangent[0],
            tangent[1],
            tangent[2],
            -(0..3).map(|k| tangent[k] * p[k]).sum::<f64>(),
        );
        let q = super::newton::project_to_triple(
            sa,
            sb,
            &plane,
            edge[0],
            edge[1],
            edge[2],
            eps,
            l2.sqrt() + radius,
        );
        q.is_some_and(|q| distance(&q) <= eps * 8.)
    })
}

/// Enumerate AABB-overlapping leaf pairs and trace every stratum-carrier pair.
/// Returns raw (untrimmed) traced curves; ids assigned via `make_id`. Port of
/// `traceAllSeams`.
pub fn trace_all_seams(
    tree: &SfccTree<'_>,
    tol: &ResolvedTolerances,
    make_id: &mut dyn FnMut() -> usize,
) -> (Vec<FeatureCurve>, SeamTraceDiagnostics) {
    let mut diagnostics = SeamTraceDiagnostics::default();
    let mut curves: Vec<FeatureCurve> = Vec::new();
    let leaves = &tree.leaves;
    let refine = TracedRefine {
        curve_eps: tol.curve_eps,
        min_cross: tol.min_tangency_sin,
        max_displacement: tol.max_chord_error * 4.0,
    };
    for i in 0..leaves.len() {
        for j in (i + 1)..leaves.len() {
            let a = &leaves[i];
            let b = &leaves[j];
            // Skip pairs whose blend fillet pushes the seam off the surface
            // by more than surfaceTol (trim would kill every sample).
            if tree.blend_seam_displacement(i, j) > tol.surface_tol {
                continue;
            }
            let margin = tol.probe_delta * 2.0;
            let mut overlap = [0.0f64; 6];
            let mut empty = false;
            for d in 0..3 {
                let lo = (a.aabb[d] - margin).max(b.aabb[d] - margin);
                let hi = (a.aabb[d + 3] + margin).min(b.aabb[d + 3] + margin);
                if hi <= lo {
                    empty = true;
                    break;
                }
                overlap[d] = lo;
                overlap[d + 3] = hi;
            }
            if empty {
                continue;
            }
            diagnostics.pairs_considered += 1;
            let strata_a = tree.leaf_strata(i).to_vec();
            let strata_b = tree.leaf_strata(j).to_vec();
            for sa in &strata_a {
                for sb in &strata_b {
                    for (samples, closed) in trace_carrier_pair(sa, sb, &overlap, tol, &mut diagnostics) {
                        let id = make_id();
                        curves.push(make_traced_curve(
                            id,
                            [sa.id, sb.id],
                            samples,
                            closed,
                            sa.clone(),
                            sb.clone(),
                            refine,
                            -1,
                        ));
                    }
                }
            }
        }
    }
    (curves, diagnostics)
}

/// Trace generated chamfer patches against primitive and earlier blend
/// carriers. Full-tree residual and both flank tests in trim_and_wire decide
/// which portions are exposed; supporting carriers alone do not define a patch.
pub fn trace_chamfer_seams(
    tree: &SfccTree<'_>,
    patches: &[(usize, [f64; 6])],
    tol: &ResolvedTolerances,
    diag: &mut SeamTraceDiagnostics,
    make_id: &mut dyn FnMut() -> usize,
) -> Vec<FeatureCurve> {
    let mut carriers = Vec::new();
    for leaf in &tree.leaves {
        for id in leaf.strata_start..leaf.strata_end {
            carriers.push((id, leaf.aabb));
        }
    }
    let mut curves = Vec::new();
    let refine = TracedRefine {
        curve_eps: tol.curve_eps,
        min_cross: tol.min_tangency_sin,
        max_displacement: tol.max_chord_error * 4.0,
    };
    for &(id, bounds) in patches {
        let sa = &tree.strata[id];
        for &(other, ob) in &carriers {
            let sb = &tree.strata[other];
            if sa.kind == crate::strata::CarrierKind::Plane && sb.kind == crate::strata::CarrierKind::Plane {
                let a = sa.normal(0., 0., 0.);
                let b = sb.normal(0., 0., 0.);
                if (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]).abs() > 1. - 1e-10 {
                    continue;
                }
            }
            let mut overlap = [0.; 6];
            for k in 0..3 {
                overlap[k] = bounds[k].max(ob[k]) - tol.probe_delta * 2.;
                overlap[k + 3] = bounds[k + 3].min(ob[k + 3]) + tol.probe_delta * 2.;
            }
            if (0..3).any(|k| overlap[k] >= overlap[k + 3]) {
                continue;
            }
            diag.pairs_considered += 1;
            for (samples, closed) in trace_carrier_pair(&sa, &sb, &overlap, tol, diag) {
                curves.push(make_traced_curve(
                    make_id(),
                    [id, other],
                    samples,
                    closed,
                    sa.clone(),
                    sb.clone(),
                    refine,
                    -1,
                ));
            }
        }
        carriers.push((id, bounds));
    }
    curves
}
