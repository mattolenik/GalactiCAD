//! Shape-improving edge flips for long-thin sliver triangles. Port of
//! `src/export/sfcc/sliver-flip.mts`.
//!
//! Cell-loop triangulation occasionally emits "cap" slivers (a boundary vertex
//! micrometres from the opposite edge of a long triangle): geometrically
//! negligible but they streak under flat shading and no vertex weld can reach
//! them (the small dimension is vertex-to-edge, not a vertex pair). The repair:
//! flip the sliver's longest edge into the neighbor quad when that strictly
//! improves the worse aspect ratio of the pair. Flips preserve closure, winding
//! consistency and the outer edges; the change is bounded by the sliver height.

use crate::sfcc::point_table::PointTable;
use std::collections::{HashMap, HashSet};

const SLIVER_ASPECT: f64 = 0.02; // height/longest-edge below this is a flip candidate
const PACK: usize = 0x200000;

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

/// Flip sliver triangles' longest edges where it strictly improves the pair's
/// worst aspect ratio. Returns `(tris, flips)`. Port of `flipSliverTriangles`.
pub fn flip_sliver_triangles(points: &PointTable, tris: &[usize], max_sweeps: usize) -> (Vec<usize>, usize) {
    let mut cur = tris.to_vec();
    let tri_count = cur.len() / 3;
    let mut total_flips = 0usize;

    for _ in 0..max_sweeps {
        let mut dir: HashMap<usize, usize> = HashMap::new();
        for t in 0..tri_count {
            for e in 0..3 {
                dir.insert(cur[t * 3 + e] * PACK + cur[t * 3 + (e + 1) % 3], t);
            }
        }
        let mut touched = vec![false; tri_count];
        let mut new_edges: HashSet<usize> = HashSet::new();
        let mut flips = 0usize;
        for t in 0..tri_count {
            if touched[t] {
                continue;
            }
            let (q0, long_edge) = shape(points, cur[t * 3], cur[t * 3 + 1], cur[t * 3 + 2]);
            if q0 >= SLIVER_ASPECT || q0 <= 0.0 {
                continue;
            }
            // Flip across the LONGEST edge (p→q), r opposite.
            let e = long_edge;
            let p = cur[t * 3 + e];
            let q = cur[t * 3 + (e + 1) % 3];
            let r = cur[t * 3 + (e + 2) % 3];
            let o = match dir.get(&(q * PACK + p)) {
                Some(&o) if o != t && !touched[o] => o,
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
            if dir.contains_key(&(r * PACK + d))
                || dir.contains_key(&(d * PACK + r))
                || new_edges.contains(&(r * PACK + d))
                || new_edges.contains(&(d * PACK + r))
            {
                continue;
            }
            let q_o = shape(points, cur[o * 3], cur[o * 3 + 1], cur[o * 3 + 2]).0;
            let before = q0.min(q_o);
            // (p,q,r)+(q,p,d) ⇒ (r,p,d)+(d,q,r)
            let after = shape(points, r, p, d).0.min(shape(points, d, q, r).0);
            if after <= before * 2.0 || after <= 1e-6 {
                continue;
            }
            new_edges.insert(r * PACK + d);
            new_edges.insert(d * PACK + r);
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
