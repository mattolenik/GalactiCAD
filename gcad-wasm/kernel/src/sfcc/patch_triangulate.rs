//! Constrained triangulation of a validated planar domain. All input boundary
//! vertices survive. Holes are joined by visible temporary bridges, then ears
//! are clipped and unconstrained edges legalized with exact incircle signs.
//! A failed chart/ear/constraint check returns no partial result.
use super::{
    predicates::{incircle, orient2d},
    triangle_quality::Rejection,
};
use std::collections::{BTreeMap, BTreeSet};
type P2 = [f64; 2];
fn edge(a: usize, b: usize) -> (usize, usize) {
    (a.min(b), a.max(b))
}
fn on(a: P2, b: P2, p: P2) -> bool {
    orient2d(a, b, p) == 0 && (0..2).all(|k| p[k] >= a[k].min(b[k]) && p[k] <= a[k].max(b[k]))
}
fn intersects(a: P2, b: P2, c: P2, d: P2) -> bool {
    let s = [
        orient2d(a, b, c),
        orient2d(a, b, d),
        orient2d(c, d, a),
        orient2d(c, d, b),
    ];
    s[0] * s[1] < 0 && s[2] * s[3] < 0 || on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b)
}
fn inside(p: P2, ring: &[usize], xy: &[P2]) -> bool {
    let mut winding = 0_i32;
    for i in 0..ring.len() {
        let a = xy[ring[i]];
        let b = xy[ring[(i + 1) % ring.len()]];
        if on(a, b, p) {
            return false;
        }
        if a[1] <= p[1] && b[1] > p[1] && orient2d(a, b, p) > 0 {
            winding += 1;
        }
        if a[1] > p[1] && b[1] <= p[1] && orient2d(a, b, p) < 0 {
            winding -= 1;
        }
    }
    winding != 0
}
pub(crate) fn contains(p: P2, ring: &[usize], xy: &[P2]) -> bool {
    inside(p, ring, xy)
}
fn winding(ring: &[usize], xy: &[P2]) -> i8 {
    // The lexicographically lowest vertex is convex for a simple polygon.
    let k = (0..ring.len())
        .min_by(|&i, &j| {
            xy[ring[i]][0]
                .total_cmp(&xy[ring[j]][0])
                .then(xy[ring[i]][1].total_cmp(&xy[ring[j]][1]))
        })
        .unwrap();
    for d in 1..ring.len() - 1 {
        let sign = orient2d(
            xy[ring[(k + ring.len() - d) % ring.len()]],
            xy[ring[k]],
            xy[ring[(k + 1) % ring.len()]],
        );
        if sign != 0 {
            return sign;
        }
    }
    0
}
fn canonicalize(ring: &mut Vec<usize>, xy: &[P2], sign: i8) {
    if winding(ring, xy) != sign {
        ring.reverse();
    }
    let k = (0..ring.len())
        .min_by(|&i, &j| {
            xy[ring[i]][0]
                .total_cmp(&xy[ring[j]][0])
                .then(xy[ring[i]][1].total_cmp(&xy[ring[j]][1]))
        })
        .unwrap();
    ring.rotate_left(k);
}

/// Each ring is supplied in local vertex indices; outer first, then its holes.
/// Disconnected components must be submitted as separate domains.
pub(crate) fn triangulate(xy: &[P2], rings: &[Vec<usize>]) -> Result<Vec<[usize; 3]>, Rejection> {
    triangulate_with_budget(xy, rings, 1_000_000)
}
fn charge(work: &mut usize, count: usize) -> Result<(), Rejection> {
    *work = work.checked_sub(count).ok_or(Rejection::Budget)?;
    Ok(())
}
fn triangulate_with_budget(
    xy: &[P2],
    rings: &[Vec<usize>],
    mut work: usize,
) -> Result<Vec<[usize; 3]>, Rejection> {
    if xy.len() > 4096 {
        return Err(Rejection::Budget);
    }
    if rings.is_empty() || xy.iter().flatten().any(|v| !v.is_finite()) {
        return Err(Rejection::Chart);
    }
    let mut constraints = BTreeSet::new();
    let mut segments = Vec::new();
    let mut seen = BTreeSet::new();
    for ring in rings {
        if ring.len() < 3 || ring.iter().any(|&v| v >= xy.len() || !seen.insert(v)) {
            return Err(Rejection::Chart);
        }
        for k in 0..ring.len() {
            let (a, b) = (ring[k], ring[(k + 1) % ring.len()]);
            if xy[a] == xy[b] {
                return Err(Rejection::Chart);
            }
            constraints.insert(edge(a, b));
            segments.push((a, b));
        }
    }
    for i in 0..segments.len() {
        if i % 128 == 0 && super::cancel::is_cancelled() {
            return Err(Rejection::Budget);
        }
        let (a, b) = segments[i];
        for &(c, d) in &segments[..i] {
            charge(&mut work, 1)?;
            if a == c || a == d || b == c || b == d {
                // Adjacent collinear edges may touch at their common vertex,
                // but overlapping/backtracking edges invalidate the domain.
                let common = if a == c || a == d { a } else { b };
                let u = if a == common { b } else { a };
                let v = if c == common { d } else { c };
                if on(xy[common], xy[u], xy[v]) || on(xy[common], xy[v], xy[u]) {
                    return Err(Rejection::Chart);
                }
            } else if intersects(xy[a], xy[b], xy[c], xy[d]) {
                return Err(Rejection::Chart);
            }
        }
    }
    let mut rings = rings.to_vec();
    for (i, ring) in rings.iter_mut().enumerate() {
        canonicalize(ring, xy, if i == 0 { 1 } else { -1 });
    }
    for i in 1..rings.len() {
        if !inside(xy[rings[i][0]], &rings[0], xy) {
            return Err(Rejection::Chart);
        }
        for j in 1..rings.len() {
            if i != j && inside(xy[rings[i][0]], &rings[j], xy) {
                return Err(Rejection::Chart);
            }
        }
    }
    let in_domain =
        |p: P2| inside(p, &rings[0], xy) && rings[1..].iter().all(|h| !inside(p, h, xy));
    let mut polygon = rings[0].clone();
    let mut bridges = Vec::<(usize, usize)>::new();
    for hole in &rings[1..] {
        let mut candidates = Vec::new();
        for (i, &a) in polygon.iter().enumerate() {
            for (j, &b) in hole.iter().enumerate() {
                charge(&mut work, segments.len() + bridges.len())?;
                let clear = segments.iter().chain(bridges.iter()).all(|&(c, d)| {
                    if a == c || a == d || b == c || b == d {
                        let other = if c == a || c == b { d } else { c };
                        !on(xy[a], xy[b], xy[other])
                    } else {
                        !intersects(xy[a], xy[b], xy[c], xy[d])
                    }
                });
                if clear && in_domain([(xy[a][0] + xy[b][0]) * 0.5, (xy[a][1] + xy[b][1]) * 0.5]) {
                    let length = (xy[a][0] - xy[b][0]).hypot(xy[a][1] - xy[b][1]);
                    candidates.push((length, i, j));
                }
            }
        }
        candidates.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
        let &(_, i, j) = candidates.first().ok_or(Rejection::Chart)?;
        let mut merged = polygon[..=i].to_vec();
        for k in 0..=hole.len() {
            merged.push(hole[(j + k) % hole.len()]);
        }
        merged.extend_from_slice(&polygon[i..]);
        bridges.push((polygon[i], hole[j]));
        polygon = merged;
    }
    let mut tris = Vec::new();
    while polygon.len() > 3 {
        if super::cancel::is_cancelled() {
            return Err(Rejection::Budget);
        }
        let m = polygon.len();
        let mut best: Option<(f64, usize)> = None;
        for i in 0..m {
            charge(&mut work, m)?;
            let [a, b, c] = [polygon[(i + m - 1) % m], polygon[i], polygon[(i + 1) % m]];
            if orient2d(xy[a], xy[b], xy[c]) <= 0 {
                continue;
            }
            let blocked = polygon.iter().any(|&p| {
                p != a
                    && p != b
                    && p != c
                    && orient2d(xy[a], xy[b], xy[p]) >= 0
                    && orient2d(xy[b], xy[c], xy[p]) >= 0
                    && orient2d(xy[c], xy[a], xy[p]) >= 0
            });
            if blocked {
                continue;
            }
            let area = (xy[b][0] - xy[a][0]) * (xy[c][1] - xy[a][1])
                - (xy[b][1] - xy[a][1]) * (xy[c][0] - xy[a][0]);
            let longest = [(a, b), (b, c), (c, a)]
                .iter()
                .map(|&(u, v)| (xy[u][0] - xy[v][0]).hypot(xy[u][1] - xy[v][1]))
                .fold(0., f64::max);
            let q = area / longest / longest;
            if best.is_none_or(|(s, _)| q > s) {
                best = Some((q, i));
            }
        }
        let (_, i) = best.ok_or(Rejection::Chart)?;
        tris.push([polygon[(i + m - 1) % m], polygon[i], polygon[(i + 1) % m]]);
        polygon.remove(i);
    }
    if orient2d(xy[polygon[0]], xy[polygon[1]], xy[polygon[2]]) <= 0 {
        return Err(Rejection::Chart);
    }
    tris.push([polygon[0], polygon[1], polygon[2]]);
    // Lawson legalization. Constraints include the real rings, not temporary
    // bridges: bridge edges may be flipped after the initial domain is filled.
    for _ in 0..xy.len().saturating_mul(xy.len()).max(1) {
        charge(&mut work, tris.len() * 3)?;
        if super::cancel::is_cancelled() {
            return Err(Rejection::Budget);
        }
        let mut adjacency = BTreeMap::<(usize, usize), Vec<(usize, usize)>>::new();
        for (i, t) in tris.iter().enumerate() {
            for k in 0..3 {
                adjacency
                    .entry(edge(t[k], t[(k + 1) % 3]))
                    .or_default()
                    .push((i, t[(k + 2) % 3]));
            }
        }
        let mut changed = false;
        for (&(a, b), pair) in &adjacency {
            if constraints.contains(&(a, b)) || pair.len() != 2 {
                continue;
            }
            let (i, c) = pair[0];
            let (j, d) = pair[1];
            if adjacency.contains_key(&edge(c, d))
                || orient2d(xy[c], xy[d], xy[a]) * orient2d(xy[c], xy[d], xy[b]) >= 0
            {
                continue;
            }
            if incircle(xy[a], xy[b], xy[c], xy[d]) * orient2d(xy[a], xy[b], xy[c]) <= 0 {
                continue;
            }
            let mut x = [c, d, a];
            let mut y = [d, c, b];
            if orient2d(xy[x[0]], xy[x[1]], xy[x[2]]) < 0 {
                x.swap(0, 1);
                y.swap(0, 1);
            }
            tris[i] = x;
            tris[j] = y;
            changed = true;
            break;
        }
        if !changed {
            // Independent incidence verification also catches bad hole bridges.
            for (&e, pair) in &adjacency {
                if pair.len() != if constraints.contains(&e) { 1 } else { 2 } {
                    return Err(Rejection::Topology);
                }
            }
            if constraints.iter().any(|e| !adjacency.contains_key(e)) {
                return Err(Rejection::Topology);
            }
            return Ok(tris);
        }
    }
    Err(Rejection::Budget)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn work_budget_rejects_without_returning_a_partial_mesh() {
        let xy = [[0., 0.], [1., 0.], [1., 1.], [0., 1.]];
        assert_eq!(
            triangulate_with_budget(&xy, &[vec![0, 1, 2, 3]], 0),
            Err(Rejection::Budget)
        );
        assert_eq!(
            triangulate_with_budget(&xy, &[vec![0, 1, 2, 3]], 0),
            Err(Rejection::Budget)
        );
    }
    #[test]
    fn narrow_neck_keeps_its_domain_under_scale_and_translation() {
        let base = [
            [0., 0.],
            [2., 0.],
            [2., 0.9],
            [4., 0.9],
            [4., 0.],
            [6., 0.],
            [6., 2.],
            [4., 2.],
            [4., 1.1],
            [2., 1.1],
            [2., 2.],
            [0., 2.],
        ];
        for scale in [0.001, 1., 1000.] {
            let xy = base.map(|p| [(p[0] + 3.) * scale, (p[1] - 7.) * scale]);
            let tris = triangulate(&xy, &[(0..xy.len()).collect()]).unwrap();
            assert!((area(&xy, &tris) / scale / scale - 8.4).abs() < 1e-10);
            for t in tris {
                let x = t.iter().map(|&i| base[i][0]).sum::<f64>() / 3.;
                let y = t.iter().map(|&i| base[i][1]).sum::<f64>() / 3.;
                assert!(x <= 2. || x >= 4. || (y >= 0.9 && y <= 1.1));
            }
        }
    }
    fn area(xy: &[P2], tris: &[[usize; 3]]) -> f64 {
        tris.iter()
            .map(|t| {
                let [a, b, c] = t.map(|i| xy[i]);
                ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) * 0.5
            })
            .sum()
    }
    #[test]
    fn concavity_collinear_vertices_and_loop_permutations() {
        let xy = [
            [0., 0.],
            [2., 0.],
            [4., 0.],
            [4., 1.],
            [1., 1.],
            [1., 4.],
            [0., 4.],
        ];
        for reverse in [false, true] {
            for start in 0..xy.len() {
                let mut ring: Vec<_> = (0..xy.len()).collect();
                if reverse {
                    ring.reverse();
                }
                ring.rotate_left(start);
                let tris = triangulate(&xy, &[ring]).unwrap();
                assert_eq!(tris.len(), 5);
                assert_eq!(area(&xy, &tris), 7.);
                for t in tris {
                    let c = [
                        t.iter().map(|&i| xy[i][0]).sum::<f64>() / 3.,
                        t.iter().map(|&i| xy[i][1]).sum::<f64>() / 3.,
                    ];
                    assert!(c[0] < 1. || c[1] < 1.);
                }
            }
        }
    }
    #[test]
    fn annulus_keeps_hole_and_boundary_segments() {
        let xy = [
            [0., 0.],
            [4., 0.],
            [4., 4.],
            [0., 4.],
            [1., 1.],
            [3., 1.],
            [3., 3.],
            [1., 3.],
        ];
        let tris = triangulate(&xy, &[vec![0, 1, 2, 3], vec![4, 5, 6, 7]]).unwrap();
        assert_eq!(tris.len(), 8);
        assert_eq!(area(&xy, &tris), 12.);
        for t in tris {
            let c = [
                t.iter().map(|&i| xy[i][0]).sum::<f64>() / 3.,
                t.iter().map(|&i| xy[i][1]).sum::<f64>() / 3.,
            ];
            assert!(!inside(c, &[4, 5, 6, 7], &xy));
        }
    }
    #[test]
    fn rejects_crossings_and_touching_holes() {
        assert!(triangulate(
            &[[0., 0.], [1., 1.], [0., 1.], [1., 0.]],
            &[vec![0, 1, 2, 3]]
        )
        .is_err());
        assert!(triangulate(
            &[
                [0., 0.],
                [4., 0.],
                [4., 4.],
                [0., 4.],
                [0., 1.],
                [1., 1.],
                [1., 2.]
            ],
            &[vec![0, 1, 2, 3], vec![4, 5, 6]]
        )
        .is_err());
    }
}
