//! Edge-collapse decimation of the assembled mesh, validated against the field.
//!
//! Contouring emits about two triangles per surface cell, so a thin wall that
//! forced sub-millimetre cells leaves a million triangles on surfaces that are
//! planes. A quadric-ranked half-edge collapse (the removed vertex snaps onto a
//! kept neighbour; positions and normals never move) takes them back out.
//!
//! Quadrics only *rank* collapses here. An area-averaged quadric is not a safe
//! acceptance test on these meshes: it under-reports a 0.6 mm wall crossing when
//! the wall's own triangles are slivers (meshoptimizer pinches the bowl sample
//! below 10%). Acceptance is geometric instead:
//!  * the link condition (no non-manifold edge, no pinched vertex);
//!  * no surviving triangle turns by more than 60°;
//!  * each surviving triangle either stays in its own plane (fast path, no
//!    field evaluation) or has its new centroid within `tol` of the surface
//!    (never worse than the deviation it already had, capped) with the field
//!    gradient agreeing with its winding. A triangle that jumped to the far side
//!    of a thin wall fails both of those.
use crate::sdf::SdfQuery;
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashSet};

/// Result of [`decimate`]: counters plus the old→new vertex map (`u32::MAX`
/// for a vertex no surviving triangle references).
pub struct DecimateReport {
    pub collapses: usize,
    pub field_evals: usize,
    pub remap: Vec<u32>,
}

#[derive(Clone, Copy)]
struct Cand {
    cost: f64,
    v: u32,
    u: u32,
    sv: u32,
    su: u32,
}
impl PartialEq for Cand {
    fn eq(&self, o: &Self) -> bool {
        self.cost == o.cost
    }
}
impl Eq for Cand {}
impl PartialOrd for Cand {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for Cand {
    // Min-heap on cost (BinaryHeap is a max-heap).
    fn cmp(&self, o: &Self) -> Ordering {
        o.cost.partial_cmp(&self.cost).unwrap_or(Ordering::Equal)
    }
}

type Q = [f64; 10]; // symmetric A (6), b (3), c (1)

fn q_add(a: &mut Q, b: &Q) {
    for i in 0..10 {
        a[i] += b[i];
    }
}
fn q_eval(q: &Q, p: [f64; 3]) -> f64 {
    let [x, y, z] = p;
    q[0] * x * x + 2.0 * q[1] * x * y + 2.0 * q[2] * x * z + q[3] * y * y + 2.0 * q[4] * y * z + q[5] * z * z
        + 2.0 * (q[6] * x + q[7] * y + q[8] * z)
        + q[9]
}
fn q_plane(n: [f64; 3], p: [f64; 3]) -> Q {
    let d = -(n[0] * p[0] + n[1] * p[1] + n[2] * p[2]);
    [n[0] * n[0], n[0] * n[1], n[0] * n[2], n[1] * n[1], n[1] * n[2], n[2] * n[2], d * n[0], d * n[1], d * n[2], d * d]
}
fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn unit(a: [f64; 3]) -> Option<[f64; 3]> {
    let l = dot(a, a).sqrt();
    (l > 0.0 && l.is_finite()).then(|| [a[0] / l, a[1] / l, a[2] / l])
}
fn tri_normal(p: &[[f64; 3]], t: [u32; 3]) -> Option<[f64; 3]> {
    let a = p[t[0] as usize];
    unit(cross(sub(p[t[1] as usize], a), sub(p[t[2] as usize], a)))
}
fn centroid(p: &[[f64; 3]], t: [u32; 3]) -> [f64; 3] {
    let (a, b, c) = (p[t[0] as usize], p[t[1] as usize], p[t[2] as usize]);
    [(a[0] + b[0] + c[0]) / 3.0, (a[1] + b[1] + c[1]) / 3.0, (a[2] + b[2] + c[2]) / 3.0]
}

const COS_TURN_MAX: f64 = 0.5; // 60°: a surviving triangle may not turn further
const COS_PLANAR: f64 = 0.999_96; // 0.5°: below this the fast path does not apply
const COS_GRAD_MIN: f64 = 0.5; // winding vs field gradient
const COS_NORMAL_MIN: f64 = 0.999_4; // 2°: face normal vs field gradient (crease fidelity)
const DEV_CAP_FACTOR: f64 = 3.0; // inherited deviation allowance, in tolerances
const PREFILTER_FACTOR: f64 = 2.0; // quadric RMS gate, in tolerances
const CANCEL_CHECK_EVERY: usize = 1 << 14;

/// Decimate `verts` (stride 8: position, pad, normal, pad) / `tris` in place.
/// `tol` is the allowed surface deviation in mm; `tol <= 0` is a no-op.
pub fn decimate<T: SdfQuery + ?Sized>(tree: &T, verts: &mut Vec<f32>, tris: &mut Vec<u32>, tol: f64) -> DecimateReport {
    let nv = verts.len() / 8;
    let identity = || DecimateReport { collapses: 0, field_evals: 0, remap: (0..nv as u32).collect() };
    if !(tol > 0.0) || nv == 0 || tris.len() < 3 {
        return identity();
    }
    let pos: Vec<[f64; 3]> = (0..nv).map(|i| [verts[i * 8] as f64, verts[i * 8 + 1] as f64, verts[i * 8 + 2] as f64]).collect();
    let mut tri: Vec<[u32; 3]> = tris.chunks_exact(3).map(|t| [t[0], t[1], t[2]]).collect();
    let nt = tri.len();
    let mut alive_t = vec![true; nt];
    let mut adj: Vec<Vec<u32>> = vec![Vec::new(); nv];
    let mut q: Vec<Q> = vec![[0.0; 10]; nv];
    let mut w = vec![0.0f64; nv];
    for (i, t) in tri.iter().enumerate() {
        if t[0] == t[1] || t[1] == t[2] || t[0] == t[2] || t.iter().any(|&k| k as usize >= nv) {
            alive_t[i] = false;
            continue;
        }
        for &k in t {
            adj[k as usize].push(i as u32);
        }
        if let Some(n) = tri_normal(&pos, *t) {
            let qp = q_plane(n, pos[t[0] as usize]);
            for &k in t {
                q_add(&mut q[k as usize], &qp);
                w[k as usize] += 1.0;
            }
        }
    }
    let mut alive_v: Vec<bool> = adj.iter().map(|a| !a.is_empty()).collect();
    let mut stamp = vec![0u32; nv];
    let mut parent: Vec<u32> = (0..nv as u32).collect();
    let mut dev0 = vec![[f32::NAN; 2]; nt]; // [deviation, normal agreement] before any collapse
    let mut heap: BinaryHeap<Cand> = BinaryHeap::new();
    let cost = |q: &[Q], v: usize, u: usize| q_eval(&q[v], pos[u]) + q_eval(&q[u], pos[u]);
    {
        let mut seen: HashSet<u64> = HashSet::with_capacity(nt * 3 / 2);
        for (i, t) in tri.iter().enumerate() {
            if !alive_t[i] {
                continue;
            }
            for k in 0..3 {
                let (a, b) = (t[k], t[(k + 1) % 3]);
                let key = ((a.min(b) as u64) << 32) | a.max(b) as u64;
                if seen.insert(key) {
                    heap.push(Cand { cost: cost(&q, a as usize, b as usize), v: a, u: b, sv: 0, su: 0 });
                    heap.push(Cand { cost: cost(&q, b as usize, a as usize), v: b, u: a, sv: 0, su: 0 });
                }
            }
        }
    }

    let prefilter = (PREFILTER_FACTOR * tol) * (PREFILTER_FACTOR * tol);
    let mut collapses = 0usize;
    let mut evals = 0usize;
    let mut scratch_nv: Vec<u32> = Vec::new();
    let mut scratch_nu: Vec<u32> = Vec::new();
    let mut shared: Vec<u32> = Vec::new();
    let mut opposite: Vec<u32> = Vec::new();
    let mut tried = 0usize;
    while let Some(c) = heap.pop() {
        let (v, u) = (c.v as usize, c.u as usize);
        if !alive_v[v] || !alive_v[u] || stamp[v] != c.sv || stamp[u] != c.su {
            continue;
        }
        tried += 1;
        if tried % CANCEL_CHECK_EVERY == 0 && super::cancel::is_cancelled() {
            break;
        }
        // Quadric RMS gate: if the kept position already sits further than
        // 2·tol (rms) from the planes merged into v, the exact test cannot pass.
        if c.cost / (w[v] + w[u]).max(1.0) > prefilter {
            continue;
        }
        // Triangles around v: the ones also holding u disappear, the rest survive.
        shared.clear();
        opposite.clear();
        for &ti in &adj[v] {
            let t = tri[ti as usize];
            if t.contains(&(u as u32)) {
                shared.push(ti);
                opposite.push(*t.iter().find(|&&k| k != v as u32 && k != u as u32).unwrap());
            }
        }
        if shared.is_empty() || shared.len() > 2 || (shared.len() == 2 && opposite[0] == opposite[1]) {
            continue;
        }
        // Link condition: common neighbours of v and u are exactly the opposite vertices.
        scratch_nv.clear();
        for &ti in &adj[v] {
            scratch_nv.extend(tri[ti as usize].iter().copied().filter(|&k| k != v as u32));
        }
        scratch_nv.sort_unstable();
        scratch_nv.dedup();
        scratch_nu.clear();
        for &ti in &adj[u] {
            scratch_nu.extend(tri[ti as usize].iter().copied().filter(|&k| k != u as u32));
        }
        scratch_nu.sort_unstable();
        scratch_nu.dedup();
        let mut common = 0usize;
        let mut link_ok = true;
        for &x in &scratch_nv {
            if scratch_nu.binary_search(&x).is_ok() {
                common += 1;
                if !opposite.contains(&x) {
                    link_ok = false;
                    break;
                }
            }
        }
        if !link_ok || common != shared.len() {
            continue;
        }
        // Geometry of every surviving triangle with v replaced by u.
        let mut ok = true;
        for &ti in &adj[v] {
            if shared.contains(&ti) {
                continue;
            }
            let old = tri[ti as usize];
            let new = old.map(|k| if k == v as u32 { u as u32 } else { k });
            let (Some(n_old), Some(n_new)) = (tri_normal(&pos, old), tri_normal(&pos, new)) else {
                ok = false;
                break;
            };
            let turn = dot(n_old, n_new);
            if turn < COS_TURN_MAX {
                ok = false;
                break;
            }
            let plane_dist = dot(n_old, sub(pos[u], pos[old[0] as usize])).abs();
            if turn > COS_PLANAR && plane_dist <= 0.25 * tol {
                continue; // stays in its own plane: no field query needed
            }
            let (f_new, g) = tree.grad(centroid(&pos, new));
            evals += 1;
            let Some(gn) = unit(g) else {
                ok = false;
                break;
            };
            let agree = dot(gn, n_new);
            if agree < COS_GRAD_MIN {
                ok = false;
                break;
            }
            // First-measured deviation: a triangle the contouring already left
            // off the surface (a cell-size crease chamfer) may keep that much,
            // capped, so chamfer bands can still collapse along their length.
            if dev0[ti as usize][0].is_nan() {
                let (f0, g0) = tree.grad(centroid(&pos, old));
                dev0[ti as usize] = [f0.abs() as f32, unit(g0).map_or(-1.0, |g| dot(g, n_old)) as f32];
                evals += 1;
            }
            let [d0, c0] = dev0[ti as usize].map(f64::from);
            // The normal may not drift off the field's: a collapse across a
            // shallow crease keeps the centroid within `tol` but bends the facet.
            if agree < COS_NORMAL_MIN && agree < c0 {
                ok = false;
                break;
            }
            let allowance = tol.max(d0.min(DEV_CAP_FACTOR * tol));
            if !(f_new.abs() <= allowance) {
                ok = false;
                break;
            }
        }
        if !ok {
            continue;
        }
        // Commit.
        let tv = std::mem::take(&mut adj[v]);
        for &ti in &shared {
            alive_t[ti as usize] = false;
            for k in tri[ti as usize] {
                if k != v as u32 {
                    adj[k as usize].retain(|&x| x != ti);
                }
            }
        }
        for &ti in &tv {
            if shared.contains(&ti) {
                continue;
            }
            for k in tri[ti as usize].iter_mut() {
                if *k == v as u32 {
                    *k = u as u32;
                }
            }
            adj[u].push(ti);
        }
        alive_v[v] = false;
        parent[v] = u as u32;
        let qv = q[v];
        q_add(&mut q[u], &qv);
        w[u] += w[v];
        stamp[u] += 1;
        collapses += 1;
        scratch_nu.clear();
        for &ti in &adj[u] {
            scratch_nu.extend(tri[ti as usize].iter().copied().filter(|&k| k != u as u32));
        }
        scratch_nu.sort_unstable();
        scratch_nu.dedup();
        for &x in &scratch_nu {
            let x = x as usize;
            heap.push(Cand { cost: cost(&q, x, u), v: x as u32, u: u as u32, sv: stamp[x], su: stamp[u] });
            heap.push(Cand { cost: cost(&q, u, x), v: u as u32, u: x as u32, sv: stamp[u], su: stamp[x] });
        }
    }

    // Compact: surviving triangles, first-reference vertex order.
    let mut new_index = vec![u32::MAX; nv];
    let mut out_verts: Vec<f32> = Vec::new();
    let mut out_tris: Vec<u32> = Vec::with_capacity((nt - collapses * 2) * 3);
    for (i, t) in tri.iter().enumerate() {
        if !alive_t[i] {
            continue;
        }
        for &k in t {
            let k = k as usize;
            if new_index[k] == u32::MAX {
                new_index[k] = (out_verts.len() / 8) as u32;
                out_verts.extend_from_slice(&verts[k * 8..k * 8 + 8]);
            }
            out_tris.push(new_index[k]);
        }
    }
    let mut remap = vec![u32::MAX; nv];
    for v in 0..nv {
        let mut r = v;
        while parent[r] as usize != r {
            r = parent[r] as usize;
        }
        remap[v] = new_index[r];
    }
    *verts = out_verts;
    *tris = out_tris;
    DecimateReport { collapses, field_evals: evals, remap }
}

/// Carry curve edges across a decimation: endpoints follow their survivors,
/// edges whose endpoints merged (or vanished) are dropped.
pub fn remap_curve_edges(edges: Vec<super::point_table::MeshCurveEdge>, remap: &[u32]) -> Vec<super::point_table::MeshCurveEdge> {
    edges
        .into_iter()
        .filter_map(|mut e| {
            let a = *remap.get(e.vertices[0] as usize)?;
            let b = *remap.get(e.vertices[1] as usize)?;
            (a != u32::MAX && b != u32::MAX && a != b).then(|| {
                e.vertices = [a, b];
                e
            })
        })
        .collect()
}
