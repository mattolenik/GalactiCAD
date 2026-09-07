//! Conforming refinement of triangle interiors after partition assembly. The
//! octree depth ceiling is a sampling budget, not a triangle-fidelity guarantee.
use super::{feature_set::SfccFeatureSet, point_table::PointTable};
use crate::sdf::CsgNode;
use std::collections::BTreeMap;

fn project(tree: &CsgNode, p: [f64; 3], budget: f64, eps: f64) -> Option<[f64; 3]> {
    let mut q = p;
    for _ in 0..24 {
        let f = super::field_branches::sample_tree(tree, q);
        if f.value.abs() <= eps {
            return Some(q);
        }
        let g2 = f.gradient.iter().map(|x| x * x).sum::<f64>();
        if !g2.is_finite() || g2 < 1e-20 {
            return None;
        }
        let mut alpha = f.value / g2;
        let mut next = None;
        for _ in 0..8 {
            let n = std::array::from_fn(|k| q[k] - alpha * f.gradient[k]);
            if (n[0] - p[0]).hypot(n[1] - p[1]).hypot(n[2] - p[2]) <= budget
                && tree.f(n).abs() < f.value.abs()
            {
                next = Some(n);
                break;
            }
            alpha *= 0.5;
        }
        q = next?;
    }
    None
}
fn pos(points: &PointTable, id: usize) -> [f64; 3] {
    [points.x(id), points.y(id), points.z(id)]
}
fn edge(a: usize, b: usize) -> (usize, usize) {
    if a < b {
        (a, b)
    } else {
        (b, a)
    }
}

pub(crate) fn refine_surface(
    tree: &CsgNode,
    features: &SfccFeatureSet,
    points: &mut PointTable,
    tris: &[usize],
    tolerance: f64,
) -> (Vec<usize>, usize) {
    // Primitive and hard-CSG paths retain their established feature tessellation.
    // Displaced blends can have very small local radii even with a large blend r.
    if !tree.has_blend() {
        return (tris.to_vec(), 0);
    }
    // Bound both iterations and added geometry. A very tight requested
    // tolerance must produce an explicit unresolved result, not exhaust WASM
    // memory while recursively refining an ill-conditioned region.
    let index_budget = tris.len().saturating_add(3 * (tris.len() / 3).clamp(10_000, 500_000));
    let mut tris = tris.to_vec();
    let limit = tolerance * 0.75;
    'rounds: for _ in 0..8 {
        let mut split = BTreeMap::<(usize, usize), Option<usize>>::new();
        for t in tris.chunks_exact(3) {
            let p = [pos(points, t[0]), pos(points, t[1]), pos(points, t[2])];
            let c = std::array::from_fn(|k| (p[0][k] + p[1][k] + p[2][k]) / 3.);
            let bad = tree.f(c).abs() > limit
                || (0..3).any(|k| {
                    let m = std::array::from_fn(|j| (p[k][j] + p[(k + 1) % 3][j]) * 0.5);
                    tree.f(m).abs() > limit
                });
            if !bad {
                continue;
            }
            // Refine a failing triangle on all sides. Splitting only its bad
            // edge can keep reconnecting a distant opposite vertex, producing
            // new long diagonals instead of shrinking the inaccurate patch.
            for k in 0..3 {
                split.insert(edge(t[k], t[(k + 1) % 3]), None);
                // Each split edge adds at most two triangles across its
                // two incident faces; stop before allocating new points.
                if tris.len().saturating_add(split.len() * 6) > index_budget {
                    break 'rounds;
                }
            }
        }
        if split.is_empty() {
            return (tris, 0);
        }
        for (&(a, b), id) in &mut split {
            let pa = pos(points, a);
            let pb = pos(points, b);
            let mid = std::array::from_fn(|k| (pa[k] + pb[k]) * 0.5);
            let length = (pa[0] - pb[0]).hypot(pa[1] - pb[1]).hypot(pa[2] - pb[2]);
            let p = if points.edge_is_protected(a, b) {
                // Follow the original modeled curve instead of rounding a
                // protected edge by unconstrained projection onto either face.
                let mut best = None;
                let mut distance = f64::INFINITY;
                let lo = std::array::from_fn(|k| pa[k].min(pb[k]) - tolerance);
                let hi = std::array::from_fn(|k| pa[k].max(pb[k]) + tolerance);
                let mut ids = features.index.curves_in_box(lo, hi);
                ids.sort_unstable();
                for i in ids {
                    let c = &features.curves[i];
                    if c.project(pa[0], pa[1], pa[2]).1 > tolerance * 0.1
                        || c.project(pb[0], pb[1], pb[2]).1 > tolerance * 0.1
                    {
                        continue;
                    }
                    let (t, d) = c.project(mid[0], mid[1], mid[2]);
                    if d < distance {
                        if let Some(p) = c.point_at_checked(t) {
                            if tree.f(p).abs() <= tolerance * 0.1 {
                                best = Some(p);
                                distance = d;
                            }
                        }
                    }
                }
                best.filter(|_| distance <= length)
            } else {
                project(tree, mid, length, tolerance * 0.01)
            };
            if let Some(p) = p {
                let (_, n) = tree.grad(p);
                let i = points.add(p[0], p[1], p[2], n[0], n[1], n[2]);
                *id = Some(i);
                if points.edge_is_protected(a, b) {
                    points.protect_edge(a, i);
                    points.protect_edge(i, b);
                }
            }
        }
        let mut next = Vec::with_capacity(tris.len() * 2);
        let mut changed = false;
        for t in tris.chunks_exact(3) {
            let m: [Option<usize>; 3] =
                std::array::from_fn(|k| split.get(&edge(t[k], t[(k + 1) % 3])).copied().flatten());
            match m.iter().filter(|m| m.is_some()).count() {
                0 => next.extend_from_slice(t),
                1 => {
                    let k = m.iter().position(Option::is_some).unwrap();
                    let (a, b, c) = (t[k], t[(k + 1) % 3], t[(k + 2) % 3]);
                    let ab = m[k].unwrap();
                    next.extend_from_slice(&[a, ab, c, ab, b, c]);
                    changed = true;
                }
                2 => {
                    let k = m.iter().position(Option::is_none).unwrap();
                    let (a, b, c) = (t[(k + 1) % 3], t[(k + 2) % 3], t[k]);
                    let ab = m[(k + 1) % 3].unwrap();
                    let bc = m[(k + 2) % 3].unwrap();
                    next.extend_from_slice(&[b, bc, ab]);
                    // A fixed diagonal can repeatedly recreate a long edge
                    // after neighboring splits. Choose the shorter diagonal
                    // of the remaining quadrilateral to make local progress.
                    let length2 = |x, y| {
                        let px = pos(points, x);
                        let py = pos(points, y);
                        (0..3).map(|k| (px[k] - py[k]).powi(2)).sum::<f64>()
                    };
                    if length2(a, bc) < length2(ab, c) {
                        next.extend_from_slice(&[a, ab, bc, a, bc, c]);
                    } else {
                        next.extend_from_slice(&[a, ab, c, ab, bc, c]);
                    }
                    changed = true;
                }
                _ => {
                    let (a, b, c) = (t[0], t[1], t[2]);
                    let (ab, bc, ca) = (m[0].unwrap(), m[1].unwrap(), m[2].unwrap());
                    next.extend_from_slice(&[a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca]);
                    changed = true;
                }
            }
        }
        tris = next;
        if !changed {
            break;
        }
    }
    let mut unresolved = 0;
    for t in tris.chunks_exact(3) {
        let p = [pos(points, t[0]), pos(points, t[1]), pos(points, t[2])];
        let mut bad = false;
        for w in [[1. / 3.; 3], [0.5, 0.5, 0.], [0., 0.5, 0.5], [0.5, 0., 0.5]] {
            let q = std::array::from_fn(|k| (0..3).map(|i| p[i][k] * w[i]).sum());
            bad |= tree.f(q).abs() > tolerance;
        }
        if bad {
            unresolved += 1;
        }
    }
    (tris, unresolved)
}
