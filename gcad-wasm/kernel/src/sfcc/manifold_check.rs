//! Standalone closed-2-manifold checker for indexed triangle meshes. Port of
//! `src/export/sfcc/manifold-check.mts`.
//!
//! A mesh is a closed oriented 2-manifold iff every undirected edge is used by
//! exactly two triangles, once in each direction (and, strictly, every vertex
//! link is a single cycle — the optional vertex-link check catches bowtie
//! vertices the edge test admits). Drives the S4 mesh audit.

use std::collections::HashMap;

const EDGE_BASE: i64 = 0x8000000; // 2^27 — supports up to 134M vertex ids in an exact i64 key

fn undirected_key(a: usize, b: usize) -> i64 {
    let (a, b) = (a as i64, b as i64);
    if a < b {
        a * EDGE_BASE + b
    } else {
        b * EDGE_BASE + a
    }
}

/// Closed-2-manifold audit report. Port of `ManifoldReport`.
pub struct ManifoldReport {
    pub ok: bool,
    /// Undirected edges referenced by exactly one triangle (holes).
    pub open_edges: usize,
    /// Undirected edges referenced by 3+ triangles.
    pub non_manifold_edges: usize,
    /// Undirected edges referenced exactly twice but in the same direction.
    pub misoriented_edges: usize,
    /// Vertices whose triangle fan is not a single closed cycle (only when checked).
    pub non_manifold_vertices: usize,
    pub components: usize,
    /// Euler characteristic per connected component (sphere topology = 2).
    pub euler_per_component: Vec<i64>,
}

struct EdgeRec {
    count: i64,
    balance: i64,
    /// The smaller endpoint id — the representative the TS uses for `compOf`.
    a: usize,
    /// Insertion order, so per-component tallies follow the TS Map iteration.
    order: usize,
}

/// Union-find with path compression over an integer-keyed map (mirrors the TS
/// `Map`-backed `find`/`union`).
struct UnionFind {
    parent: HashMap<usize, usize>,
}

impl UnionFind {
    fn new() -> Self {
        UnionFind { parent: HashMap::new() }
    }
    fn find(&mut self, v: usize) -> usize {
        let mut r = *self.parent.get(&v).unwrap_or(&v);
        if r != v {
            r = self.find(r);
            self.parent.insert(v, r);
        }
        r
    }
    fn union(&mut self, a: usize, b: usize) {
        let ra = self.find(a);
        let rb = self.find(b);
        if ra != rb {
            self.parent.insert(ra, rb);
        }
    }
}

/// Check a triangle index buffer for closed-2-manifoldness. Port of `checkManifold`.
pub fn check_manifold(tris: &[u32], check_vertex_links: bool) -> ManifoldReport {
    let tri_count = tris.len() / 3;

    // count: total uses; balance: +1 for a<b direction, −1 for b<a.
    let mut edges: HashMap<i64, EdgeRec> = HashMap::new();
    let mut edge_order = 0usize;
    for t in 0..tri_count {
        for e in 0..3 {
            let a = tris[t * 3 + e] as usize;
            let b = tris[t * 3 + (e + 1) % 3] as usize;
            let key = undirected_key(a, b);
            let rec = edges.entry(key).or_insert_with(|| {
                let o = edge_order;
                edge_order += 1;
                EdgeRec { count: 0, balance: 0, a: a.min(b), order: o }
            });
            rec.count += 1;
            rec.balance += if a < b { 1 } else { -1 };
        }
    }

    let mut open_edges = 0usize;
    let mut non_manifold_edges = 0usize;
    let mut misoriented_edges = 0usize;
    for rec in edges.values() {
        if rec.count == 1 {
            open_edges += 1;
        } else if rec.count > 2 {
            non_manifold_edges += 1;
        } else if rec.balance != 0 {
            misoriented_edges += 1;
        }
    }

    // Connected components over vertices via union-find on triangle edges.
    let mut uf = UnionFind::new();
    // Insertion-ordered vertex set (mirrors the TS `Set` iteration order).
    let mut verts: Vec<usize> = Vec::new();
    let mut seen_vert: HashMap<usize, ()> = HashMap::new();
    for t in 0..tri_count {
        let a = tris[t * 3] as usize;
        let b = tris[t * 3 + 1] as usize;
        let c = tris[t * 3 + 2] as usize;
        for &v in &[a, b, c] {
            if seen_vert.insert(v, ()).is_none() {
                verts.push(v);
            }
        }
        uf.union(a, b);
        uf.union(b, c);
    }

    // Assign component indices in first-encounter order, matching the TS
    // `compOf` (which mints an index on the first root it sees).
    let mut comp_index: HashMap<usize, usize> = HashMap::new();
    let mut v_per: Vec<i64> = Vec::new();
    let mut e_per: Vec<i64> = Vec::new();
    let mut f_per: Vec<i64> = Vec::new();
    let comp_of = |uf: &mut UnionFind,
                       v: usize,
                       comp_index: &mut HashMap<usize, usize>,
                       v_per: &mut Vec<i64>,
                       e_per: &mut Vec<i64>,
                       f_per: &mut Vec<i64>|
     -> usize {
        let root = uf.find(v);
        if let Some(&ci) = comp_index.get(&root) {
            ci
        } else {
            let ci = comp_index.len();
            comp_index.insert(root, ci);
            v_per.push(0);
            e_per.push(0);
            f_per.push(0);
            ci
        }
    };

    for &v in &verts {
        let ci = comp_of(&mut uf, v, &mut comp_index, &mut v_per, &mut e_per, &mut f_per);
        v_per[ci] += 1;
    }
    // Edges, in insertion order.
    let mut edge_list: Vec<&EdgeRec> = edges.values().collect();
    edge_list.sort_by_key(|r| r.order);
    for rec in &edge_list {
        let ci = comp_of(&mut uf, rec.a, &mut comp_index, &mut v_per, &mut e_per, &mut f_per);
        e_per[ci] += 1;
    }
    for t in 0..tri_count {
        let ci = comp_of(&mut uf, tris[t * 3] as usize, &mut comp_index, &mut v_per, &mut e_per, &mut f_per);
        f_per[ci] += 1;
    }

    let euler_per_component: Vec<i64> = (0..v_per.len()).map(|i| v_per[i] - e_per[i] + f_per[i]).collect();

    // Optional vertex-link check.
    let mut non_manifold_vertices = 0usize;
    if check_vertex_links {
        let mut fans: HashMap<usize, Vec<(usize, usize)>> = HashMap::new();
        let mut fan_order: Vec<usize> = Vec::new();
        for t in 0..tri_count {
            let a = tris[t * 3] as usize;
            let b = tris[t * 3 + 1] as usize;
            let c = tris[t * 3 + 2] as usize;
            for &(v, p, q) in &[(a, b, c), (b, c, a), (c, a, b)] {
                let entry = fans.entry(v).or_insert_with(|| {
                    fan_order.push(v);
                    Vec::new()
                });
                entry.push((p, q));
            }
        }
        for v in &fan_order {
            let fan = &fans[v];
            let mut next: HashMap<usize, usize> = HashMap::new();
            let mut dup = false;
            for &(p, q) in fan {
                if next.contains_key(&p) {
                    dup = true;
                }
                next.insert(p, q);
            }
            if dup || next.len() != fan.len() {
                non_manifold_vertices += 1;
                continue;
            }
            let start = fan[0].0;
            let mut cur = start;
            let mut steps = 0usize;
            while let Some(&n) = next.get(&cur) {
                cur = n;
                steps += 1;
                if cur == start || steps > fan.len() {
                    break;
                }
            }
            if cur != start || steps != fan.len() {
                non_manifold_vertices += 1;
            }
        }
    }

    ManifoldReport {
        ok: open_edges == 0 && non_manifold_edges == 0 && misoriented_edges == 0 && non_manifold_vertices == 0,
        open_edges,
        non_manifold_edges,
        misoriented_edges,
        non_manifold_vertices,
        components: comp_index.len(),
        euler_per_component,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A single triangle: 3 open edges, χ = 3 − 3 + 1 = 1, not closed.
    #[test]
    fn single_triangle_is_open() {
        let tris = [0u32, 1, 2];
        let r = check_manifold(&tris, false);
        assert!(!r.ok);
        assert_eq!(r.open_edges, 3);
        assert_eq!(r.components, 1);
        assert_eq!(r.euler_per_component, vec![1]);
    }

    /// A closed tetrahedron: closed 2-manifold, χ = 2.
    #[test]
    fn tetrahedron_is_closed_chi_2() {
        // 4 outward-wound faces of a tetra (0,1,2,3).
        let tris = [0u32, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3];
        let r = check_manifold(&tris, true);
        assert!(r.ok, "open={} nm={} mis={}", r.open_edges, r.non_manifold_edges, r.misoriented_edges);
        assert_eq!(r.components, 1);
        assert_eq!(r.euler_per_component, vec![2]);
        assert_eq!(r.non_manifold_vertices, 0);
    }
}
