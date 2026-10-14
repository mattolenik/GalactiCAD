//! Shape-improving edge flips for long-thin sliver triangles.
//!
//! Only convex, exactly coplanar pairs may flip, in both working f64 and emitted
//! f32 coordinates. Both diagonals then cover the same oriented patch: the flip
//! cannot introduce a surface displacement or intersection. This preserves an
//! existing embedding; it does not repair invalid input geometry.

use super::{
    point_table::PointTable,
    predicates::{orient2d, orient3d},
    triangle_quality as q,
};
use std::collections::{HashMap, HashSet};

const SLIVER_ASPECT: f64 = 0.02; // height/longest-edge below this is a flip candidate

/// height / longest edge (0 for zero-area); plus the longest edge's corner index.
fn shape(points: &PointTable, a: usize, b: usize, c: usize) -> (f64, usize) {
    let ax = points.x(a);
    let ay = points.y(a);
    let az = points.z(a);
    let bx = points.x(b);
    let by = points.y(b);
    let bz = points.z(b);
    let cx = points.x(c);
    let cy = points.y(c);
    let cz = points.z(c);
    let e0 = hypot3(bx - ax, by - ay, bz - az); // a→b
    let e1 = hypot3(cx - bx, cy - by, cz - bz); // b→c
    let e2 = hypot3(ax - cx, ay - cy, az - cz); // c→a
    let ux = bx - ax;
    let uy = by - ay;
    let uz = bz - az;
    let vx = cx - ax;
    let vy = cy - ay;
    let vz = cz - az;
    let area2 = hypot3(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    let lmax = e0.max(e1).max(e2);
    if lmax < 1e-20 {
        return (0.0, 0);
    }
    let long_edge = if e0 >= e1 && e0 >= e2 {
        0
    } else if e1 >= e2 {
        1
    } else {
        2
    };
    (area2 / (lmax * lmax), long_edge)
}

fn preserves_patch(points: [q::P3; 4]) -> bool {
    // ponytail: reject nonplanar pairs; changing their surface requires a separate
    // fidelity/intersection check, as in the optional quality-remeshing path.
    [points, points.map(q::rounded)].into_iter().all(|points| {
        let [p, q, r, d] = points;
        if !points.iter().flatten().all(|x| x.is_finite()) || orient3d(p, q, r, d) != 0 {
            return false;
        }
        (0..3).any(|axis| {
            let [p, q, r, d] = points.map(|p| [p[(axis + 1) % 3], p[(axis + 2) % 3]]);
            let sign = orient2d(p, q, r);
            sign != 0
                && orient2d(q, p, d) == sign
                && orient2d(r, p, d) == sign
                && orient2d(d, q, r) == sign
        })
    })
}

/// Flip sliver triangles' longest edges when the oriented patch is unchanged and
/// its worst aspect ratio improves. Returns `(tris, flips)`.
pub fn flip_sliver_triangles(points: &PointTable, tris: &[usize], max_sweeps: usize) -> (Vec<usize>, usize) {
    let mut cur = tris.to_vec();
    let tri_count = cur.len() / 3;
    let mut total_flips = 0usize;

    for _ in 0..max_sweeps {
        let mut dir: HashMap<(usize, usize), usize> = HashMap::new();
        for t in 0..tri_count {
            for e in 0..3 {
                // A duplicate directed edge is ambiguous, not a usable neighbor.
                dir.entry((cur[t * 3 + e], cur[t * 3 + (e + 1) % 3]))
                    .and_modify(|owner| *owner = usize::MAX)
                    .or_insert(t);
            }
        }
        let mut touched = vec![false; tri_count];
        let mut new_edges: HashSet<(usize, usize)> = HashSet::new();
        let mut flips = 0usize;
        for t in 0..tri_count {
            if touched[t] {
                continue;
            }
            let (q0, long_edge) = shape(points, cur[t * 3], cur[t * 3 + 1], cur[t * 3 + 2]);
            if !q0.is_finite() || q0 >= SLIVER_ASPECT || q0 <= 0.0 {
                continue;
            }
            // Flip across the LONGEST edge (p→q), r opposite.
            let e = long_edge;
            let p = cur[t * 3 + e];
            let q = cur[t * 3 + (e + 1) % 3];
            let r = cur[t * 3 + (e + 2) % 3];
            if points.edge_is_protected(p, q) || dir.get(&(p, q)) != Some(&t) {
                continue;
            }
            let o = match dir.get(&(q, p)) {
                Some(&o) if o < tri_count && o != t && !touched[o] => o,
                _ => continue,
            };
            let mut d = usize::MAX;
            for k in 0..3 {
                let v = cur[o * 3 + k];
                if v != p && v != q {
                    d = v;
                }
            }
            if d == usize::MAX || d == r {
                continue;
            }
            if dir.contains_key(&(r, d))
                || dir.contains_key(&(d, r))
                || new_edges.contains(&(r, d))
                || new_edges.contains(&(d, r))
            {
                continue;
            }
            let q_o = shape(points, cur[o * 3], cur[o * 3 + 1], cur[o * 3 + 2]).0;
            let before = q0.min(q_o);
            // (p,q,r)+(q,p,d) ⇒ (r,p,d)+(d,q,r)
            let after = shape(points, r, p, d).0.min(shape(points, d, q, r).0);
            if !after.is_finite() || after <= before * 2.0 || after <= 1e-6 {
                continue;
            }
            if !preserves_patch([p, q, r, d].map(|i| q::pos(points, i))) {
                continue;
            }
            new_edges.insert((r, d));
            new_edges.insert((d, r));
            cur[t * 3] = r;
            cur[t * 3 + 1] = p;
            cur[t * 3 + 2] = d;
            cur[o * 3] = d;
            cur[o * 3 + 1] = q;
            cur[o * 3 + 2] = r;
            touched[t] = true;
            touched[o] = true;
            flips += 1;
            total_flips += 1;
        }
        if flips == 0 {
            break;
        }
    }
    (cur, total_flips)
}

fn hypot3(x: f64, y: f64, z: f64) -> f64 {
    (x * x + y * y + z * z).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table(positions: [q::P3; 4]) -> PointTable {
        let mut points = PointTable::new();
        for [x, y, z] in positions {
            points.add(x, y, z, 0., 0., 1.);
        }
        points
    }

    const PATCH: [q::P3; 4] = [[-1., 0., 0.], [1., 0., 0.], [0., 1. / 1024., 0.], [0., -1., 0.]];
    const TRIS: [usize; 6] = [0, 1, 2, 1, 0, 3];

    #[test]
    fn slanted_plane_flip_accepts_both_orientations() {
        for axis in 0..3 {
            // A slanted plane with exactly representable coordinates also flips.
            let points = table(PATCH.map(|[x, y, _]| {
                let p = [x, y, x + y];
                [p[axis], p[(axis + 1) % 3], p[(axis + 2) % 3]]
            }));
            for tris in [TRIS, [1, 0, 2, 0, 1, 3]] {
                let (out, flips) = flip_sliver_triangles(&points, &tris, 4);
                assert_eq!(flips, 1);
                assert!(out.chunks_exact(3).all(|t| t.contains(&2) && t.contains(&3)));
            }
        }
    }

    #[test]
    fn nonplanar_and_nonfinite_patches_are_unchanged() {
        for z in [1e-12, 0.1, f64::NAN, f64::INFINITY] {
            let mut positions = PATCH;
            positions[2][2] = z;
            let (out, flips) = flip_sliver_triangles(&table(positions), &TRIS, 4);
            assert_eq!((out, flips), (TRIS.to_vec(), 0), "z={z}");
        }
    }

    #[test]
    fn rounding_must_preserve_the_retriangulated_patch() {
        // Exactly coplanar in f64; rounding only z breaks coplanarity in f32.
        let positions = PATCH.map(|[x, y, _]| [x, y, 1048576. + x + y]);
        let [p, q, r, d] = positions;
        assert_eq!(orient3d(p, q, r, d), 0);
        assert_ne!(orient3d(q::rounded(p), q::rounded(q), q::rounded(r), q::rounded(d)), 0);
        let (out, flips) = flip_sliver_triangles(&table(positions), &TRIS, 4);
        assert_eq!((out, flips), (TRIS.to_vec(), 0));

        // Both old f32 triangles are valid, but the new r-p-d triangle collapses.
        let c = 131072.;
        let positions = [
            [c - 3. / 1024., 0., 0.],
            [c + 1., 0., 0.],
            [c, 1. / 1024., 0.],
            [c, -1., 0.],
        ];
        let [p, q, r, d] = positions.map(q::rounded).map(|p| [p[0], p[1]]);
        assert_eq!(orient2d(p, q, r), 1);
        assert_eq!(orient2d(q, p, d), 1);
        assert_eq!(orient2d(r, p, d), 0);
        let points = table(positions);
        let (out, flips) = flip_sliver_triangles(&points, &TRIS, 4);
        assert_eq!((out, flips), (TRIS.to_vec(), 0));
    }

    #[test]
    fn ambiguous_edge_incidence_is_not_a_flip_neighbor() {
        let points = table(PATCH);
        for duplicate in [[0, 1, 2], [1, 0, 3]] {
            let mut tris = TRIS.to_vec();
            tris.extend(duplicate);
            let (out, flips) = flip_sliver_triangles(&points, &tris, 4);
            assert_eq!((out, flips), (tris, 0));
        }
    }

    #[test]
    fn crease_lock_prevents_an_otherwise_beneficial_flip() {
        let mut p = PointTable::new();
        let a = p.add(-1.,0.,0.,0.,0.,1.);
        let b = p.add(1.,0.,0.,0.,0.,1.);
        let c = p.add(0.,0.001,0.,0.,0.,1.);
        let d = p.add(0.,-1.,0.,0.,0.,1.);
        let tris = [a,b,c,b,a,d];
        assert_eq!(flip_sliver_triangles(&p, &tris, 4).1, 1);
        p.protect_edge(b,a);
        let (out, flips) = flip_sliver_triangles(&p, &tris, 4);
        assert_eq!(flips, 0);
        assert_eq!(out, tris);
    }
}
