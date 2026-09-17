//! Candidate embedding checks, including nonincident nearby sheets. Triangle
//! intersection uses exact signs; the AABB tree is only a broad phase.
use super::{
    predicates::{orient2d, orient3d},
    triangle_quality::{self as q, P3},
};

fn bounds(p: [P3; 3]) -> [f64; 6] {
    std::array::from_fn(|k| {
        if k < 3 {
            p.iter().map(|p| p[k]).fold(f64::INFINITY, f64::min)
        } else {
            p.iter().map(|p| p[k - 3]).fold(f64::NEG_INFINITY, f64::max)
        }
    })
}
fn overlap(a: [f64; 6], b: [f64; 6]) -> bool {
    (0..3).all(|k| a[k] <= b[k + 3] && b[k] <= a[k + 3])
}
fn merge(a: [f64; 6], b: [f64; 6]) -> [f64; 6] {
    std::array::from_fn(|k| {
        if k < 3 {
            a[k].min(b[k])
        } else {
            a[k].max(b[k])
        }
    })
}
fn broad_bounds(p: [P3; 3]) -> [f64; 6] {
    merge(bounds(p), bounds(p.map(q::rounded)))
}
struct Node {
    bounds: [f64; 6],
    children: Option<[usize; 2]>,
    triangle: usize,
    parent: usize,
}
pub(crate) struct TriangleIndex {
    nodes: Vec<Node>,
    leaves: Vec<usize>,
}
impl TriangleIndex {
    pub fn new(triangles: &[[P3; 3]]) -> Self {
        let mut out = Self {
            nodes: Vec::new(),
            leaves: vec![0; triangles.len()],
        };
        let mut ids: Vec<_> = (0..triangles.len()).collect();
        if !ids.is_empty() {
            out.build(&mut ids, triangles, usize::MAX);
        }
        out
    }
    fn build(&mut self, ids: &mut [usize], tris: &[[P3; 3]], parent: usize) -> usize {
        let bb = ids
            .iter()
            .map(|&i| broad_bounds(tris[i]))
            .reduce(merge)
            .unwrap();
        let node = self.nodes.len();
        self.nodes.push(Node {
            bounds: bb,
            children: None,
            triangle: ids[0],
            parent,
        });
        if ids.len() == 1 {
            self.leaves[ids[0]] = node;
        } else {
            let axis = (0..3)
                .max_by(|&a, &b| (bb[a + 3] - bb[a]).total_cmp(&(bb[b + 3] - bb[b])))
                .unwrap();
            ids.sort_by(|&a, &b| {
                q::bary(tris[a], [1. / 3.; 3])[axis]
                    .total_cmp(&q::bary(tris[b], [1. / 3.; 3])[axis])
                    .then(a.cmp(&b))
            });
            let (a, b) = ids.split_at_mut(ids.len() / 2);
            let a = self.build(a, tris, node);
            let b = self.build(b, tris, node);
            self.nodes[node].children = Some([a, b]);
        }
        node
    }
    pub fn update(&mut self, id: usize, p: [P3; 3]) {
        let mut n = self.leaves[id];
        self.nodes[n].bounds = broad_bounds(p);
        while self.nodes[n].parent != usize::MAX {
            n = self.nodes[n].parent;
            let [a, b] = self.nodes[n].children.unwrap();
            self.nodes[n].bounds = merge(self.nodes[a].bounds, self.nodes[b].bounds);
        }
    }
    pub fn query(&self, p: [P3; 3]) -> Vec<usize> {
        let mut out = Vec::new();
        if self.nodes.is_empty() {
            return out;
        }
        let bb = broad_bounds(p);
        let mut stack = vec![0];
        while let Some(n) = stack.pop() {
            let n = &self.nodes[n];
            if !overlap(bb, n.bounds) {
                continue;
            }
            if let Some([a, b]) = n.children {
                stack.push(b);
                stack.push(a);
            } else {
                out.push(n.triangle);
            }
        }
        out
    }
}
fn between(a: [f64; 2], b: [f64; 2], p: [f64; 2]) -> bool {
    orient2d(a, b, p) == 0 && (0..2).all(|k| p[k] >= a[k].min(b[k]) && p[k] <= a[k].max(b[k]))
}
fn coplanar(a: [P3; 3], b: [P3; 3], ia: [usize; 3], ib: [usize; 3]) -> bool {
    let n = q::normal(a);
    let axis = (0..3)
        .max_by(|&i, &j| n[i].abs().total_cmp(&n[j].abs()))
        .unwrap();
    let flat = |p: P3| [p[(axis + 1) % 3], p[(axis + 2) % 3]];
    let a = a.map(flat);
    let b = b.map(flat);
    for k in 0..3 {
        for l in 0..3 {
            let (i, j) = (k, (k + 1) % 3);
            let (u, v) = (l, (l + 1) % 3);
            let s = [
                orient2d(a[i], a[j], b[u]),
                orient2d(a[i], a[j], b[v]),
                orient2d(b[u], b[v], a[i]),
                orient2d(b[u], b[v], a[j]),
            ];
            if s[0] * s[1] < 0 && s[2] * s[3] < 0 {
                return true;
            }
            // A contact is legal only at the same topological vertex. This catches
            // T-junctions and coincident but separately indexed sheets too.
            for (p, id) in [(b[u], ib[u]), (b[v], ib[v])] {
                if between(a[i], a[j], p) && id != ia[i] && id != ia[j] {
                    return true;
                }
            }
            for (p, id) in [(a[i], ia[i]), (a[j], ia[j])] {
                if between(b[u], b[v], p) && id != ib[u] && id != ib[v] {
                    return true;
                }
            }
        }
    }
    for (x, y) in [(a, b), (b, a)] {
        for p in x {
            let s = [
                orient2d(y[0], y[1], p),
                orient2d(y[1], y[2], p),
                orient2d(y[2], y[0], p),
            ];
            if s.iter().all(|&s| s > 0) || s.iter().all(|&s| s < 0) {
                return true;
            }
        }
    }
    // Identical triangles have no strictly interior vertex or crossing edge.
    ia.iter().all(|v| ib.contains(v))
}
fn edge_hits(a: P3, b: P3, t: [P3; 3], sa: i8, sb: i8) -> bool {
    if sa != 0 && sa == sb {
        return false;
    }
    let s = [
        orient3d(a, b, t[0], t[1]),
        orient3d(a, b, t[1], t[2]),
        orient3d(a, b, t[2], t[0]),
    ];
    s.iter().all(|&v| v >= 0) || s.iter().all(|&v| v <= 0)
}
pub(crate) fn intersects(a: [P3; 3], b: [P3; 3], ia: [usize; 3], ib: [usize; 3]) -> bool {
    #[cfg(feature = "sfcc-profile")]
    if super::perf::disabled(2) { return reference_intersects(a,b,ia,ib); }
    if !a.iter().chain(b.iter()).flatten().all(|v| v.is_finite()) {
        return true;
    }
    if !overlap(bounds(a), bounds(b)) {
        return false;
    }
    let sa = b.map(|p| orient3d(a[0], a[1], a[2], p));
    if sa.iter().all(|&v| v > 0) || sa.iter().all(|&v| v < 0) {
        return false;
    }
    if sa == [0; 3] {
        return coplanar(a, b, ia, ib);
    }
    for (direction, (x, y, ix, iy)) in [(a, b, ia, ib), (b, a, ib, ia)].into_iter().enumerate() {
        let sides = if direction == 1 { sa } else { a.map(|p| orient3d(b[0],b[1],b[2],p)) };
        for k in 0..3 {
            let j = (k + 1) % 3;
            let shared_a = iy.contains(&ix[k]);
            let shared_b = iy.contains(&ix[j]);
            if shared_a && shared_b {
                continue;
            }
            if shared_a || shared_b {
                // Non-coplanar segment with one shared endpoint meets this plane
                // only there. A segment lying in the plane needs the 2D test.
                if sides[if shared_a { j } else { k }] != 0 {
                    continue;
                }
                if coplanar(y, [x[k], x[j], x[k]], iy, [ix[k], ix[j], ix[k]]) {
                    return true;
                }
            } else {
                let a = sides[k];
                let b = sides[j];
                if a == 0 && b == 0 {
                    if coplanar(y, [x[k], x[j], x[k]], iy, [ix[k], ix[j], ix[k]]) {
                        return true;
                    }
                } else if edge_hits(x[k], x[j], y, a, b) {
                    return true;
                }
            }
        }
    }
    false
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn contacts_overlap_and_adjacent_sheets() {
        let a = [[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]];
        assert!(!intersects(
            a,
            [[1., 0., 0.], [0., 0., 0.], [0., -1., 0.]],
            [0, 1, 2],
            [1, 0, 3]
        ));
        assert!(intersects(
            a,
            [[0., 0., 0.], [1., 0., 0.], [0.25, 0.25, 0.]],
            [0, 1, 2],
            [0, 1, 3]
        ));
        assert!(!intersects(
            a,
            a.map(|p| [p[0], p[1], 1e-12]),
            [0, 1, 2],
            [3, 4, 5]
        ));
        assert!(intersects(
            a,
            [[0.25, 0.25, -1.], [0.25, 0.25, 1.], [0.75, 0.25, 0.]],
            [0, 1, 2],
            [3, 4, 5]
        ));
        assert!(intersects(a, a, [0, 1, 2], [0, 1, 2]));
    }
    #[test]
    fn disjoint_segments_in_the_other_face_plane_do_not_intersect() {
        let a = [[-10., -10., -9.], [-10., -10., -6.], [-10., -9.5, -7.5]];
        let b = [[-10., -10., -10.], [-9., -10., -10.], [-9., -10., -9.]];
        assert!(!intersects(a, b, [0, 1, 2], [3, 4, 5]));
        assert!(!intersects(b, a, [3, 4, 5], [0, 1, 2]));
    }
}

/// Broad phase for transactionally appended triangles. Rebuild in bounded
/// batches; only the short unindexed tail is scanned. Avoid an O(edits²) scan
/// when many refinement or collapse proposals succeed in one sweep.
pub(crate) struct GrowingIndex {
    items: Vec<([usize; 3], [P3; 3])>,
    index: TriangleIndex,
    indexed: usize,
}
impl GrowingIndex {
    pub fn new() -> Self {
        Self {
            items: Vec::new(),
            index: TriangleIndex::new(&[]),
            indexed: 0,
        }
    }
    pub fn conflicts(&self, ids: [usize; 3], p: [P3; 3]) -> bool {
        let hit = |&(other, q): &([usize; 3], [P3; 3])| {
            intersects(p, q, ids, other)
                || intersects(p.map(q::rounded), q.map(q::rounded), ids, other)
        };
        self.index.query(p).into_iter().any(|i| hit(&self.items[i]))
            || self.items[self.indexed..].iter().any(hit)
    }
    pub fn extend(&mut self, items: impl IntoIterator<Item = ([usize; 3], [P3; 3])>) {
        self.items.extend(items);
        if self.items.len() - self.indexed >= 256 {
            self.index =
                TriangleIndex::new(&self.items.iter().map(|&(_, p)| p).collect::<Vec<_>>());
            self.indexed = self.items.len();
        }
    }
}

#[cfg(any(test, feature = "sfcc-profile"))]
fn reference_edge_hits(a: P3, b: P3, t: [P3; 3]) -> bool {
    let sa = orient3d(t[0], t[1], t[2], a);
    let sb = orient3d(t[0], t[1], t[2], b);
    if sa != 0 && sa == sb {
        return false;
    }
    let s = [
        orient3d(a, b, t[0], t[1]),
        orient3d(a, b, t[1], t[2]),
        orient3d(a, b, t[2], t[0]),
    ];
    s.iter().all(|&v| v >= 0) || s.iter().all(|&v| v <= 0)
}
#[cfg(any(test, feature = "sfcc-profile"))]
fn reference_intersects(a: [P3; 3], b: [P3; 3], ia: [usize; 3], ib: [usize; 3]) -> bool {
    if !a.iter().chain(b.iter()).flatten().all(|v| v.is_finite()) {
        return true;
    }
    if !overlap(bounds(a), bounds(b)) {
        return false;
    }
    let sa = b.map(|p| orient3d(a[0], a[1], a[2], p));
    if sa.iter().all(|&v| v > 0) || sa.iter().all(|&v| v < 0) {
        return false;
    }
    if sa == [0; 3] {
        return coplanar(a, b, ia, ib);
    }
    for (x, y, ix, iy) in [(a, b, ia, ib), (b, a, ib, ia)] {
        for k in 0..3 {
            let j = (k + 1) % 3;
            let shared_a = iy.contains(&ix[k]);
            let shared_b = iy.contains(&ix[j]);
            if shared_a && shared_b {
                continue;
            }
            if shared_a || shared_b {
                // Non-coplanar segment with one shared endpoint meets this plane
                // only there. A segment lying in the plane needs the 2D test.
                let end = if shared_a { x[j] } else { x[k] };
                if orient3d(y[0], y[1], y[2], end) != 0 {
                    continue;
                }
                if coplanar(y, [x[k], x[j], x[k]], iy, [ix[k], ix[j], ix[k]]) {
                    return true;
                }
            } else {
                let a = orient3d(y[0], y[1], y[2], x[k]);
                let b = orient3d(y[0], y[1], y[2], x[j]);
                if a == 0 && b == 0 {
                    if coplanar(y, [x[k], x[j], x[k]], iy, [ix[k], ix[j], ix[k]]) {
                        return true;
                    }
                } else if reference_edge_hits(x[k], x[j], y) {
                    return true;
                }
            }
        }
    }
    false
}

/// Both representations, avoiding a duplicate test only for bit-identical input.
pub(crate) fn intersects_both(a: [P3;3], b: [P3;3], ia: [usize;3], ib: [usize;3]) -> bool {
    if intersects(a,b,ia,ib) { return true; }
    if super::perf::disabled(2) {return intersects(a.map(q::rounded),b.map(q::rounded),ia,ib);}
    let ra = a.map(q::rounded); let rb = b.map(q::rounded);
    let same = |a: [P3;3], b: [P3;3]| a.map(|p|p.map(f64::to_bits)) == b.map(|p|p.map(f64::to_bits));
    (!same(a,ra) || !same(b,rb)) && intersects(ra,rb,ia,ib)
}
#[cfg(test)]
mod predicate_reuse_tests {
    use super::*;
    #[test]
    fn pair_results_match_original_with_shared_vertices_and_rounding() {
        let a = [[0.,0.,0.],[1.,0.,0.],[0.,1.,0.]];
        for i in -20..21 {
            for z in [-1e-46,0.,1e-46,0.5] {
                let x = i as f64 / 20.;
                let b = [[x,0.,z],[x+1.,0.,z],[x,1.,z]];
                for ids in [[0,1,2],[0,3,4],[3,4,5]] {
                    assert_eq!(intersects(a,b,[0,1,2],ids),reference_intersects(a,b,[0,1,2],ids));
                    assert_eq!(intersects_both(a,b,[0,1,2],ids),reference_intersects(a,b,[0,1,2],ids) || reference_intersects(a.map(q::rounded),b.map(q::rounded),[0,1,2],ids));
                }
            }
        }
    }
}
