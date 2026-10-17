//! Bounded cell-relative certificates. This module never samples scene distance.
//! Sphere equations and aligned-box sign algebra only establish obligations;
//! indexed disk and boundary checks establish the actual filling separately.
use super::face_contour::FaceRecord;
use super::feature_set::SfccFeatureSet;
use super::octree::{SfccCell, SfccOctree};
use super::point_table::{PointKey, PointTable};
use super::predicates::{exact_affine_eq, exact_sum_sign, sphere_sign};
use crate::math::grid::{
    cell_aabb, collect_edge_interior_offsets, face_axes, pack_point, point_to_world,
    stride_at_level, SfccLattice, CELL_EDGES,
};
use crate::sdf::{CsgNode, Leaf, Shape};
use std::collections::{BTreeMap, BTreeSet, HashMap};

pub type CellId = (u32, i64, i64, i64);
fn id(c: &SfccCell) -> CellId {
    (c.level, c.ix, c.iy, c.iz)
}
fn unresolved(reason: &str) -> bool {
    !reason.starts_with("outside")
        && !reason.starts_with("grid")
        && !reason.starts_with("cell_map")
        && !reason.starts_with("cell_extent")
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CoverageReport {
    pub scope: String,
    pub certified_cells: usize,
    pub transported_cells: usize,
    pub excluded_cells: usize,
    pub outside_cells: usize,
    pub unresolved: Vec<(CellId, String)>,
}
impl Default for CoverageReport {
    fn default() -> Self {
        Self {
            scope: "outsideScope".into(),
            certified_cells: 0,
            transported_cells: 0,
            excluded_cells: 0,
            outside_cells: 0,
            unresolved: Vec::new(),
        }
    }
}
impl CoverageReport {
    pub fn to_json(&self) -> String {
        let failures = self
            .unresolved
            .iter()
            .map(|((l, x, y, z), r)| format!("{{\"cell\":[{l},{x},{y},{z}],\"reason\":{r:?}}}"))
            .collect::<Vec<_>>()
            .join(",");
        format!("{{\"scope\":{:?},\"certifiedCells\":{},\"transportedCells\":{},\"excludedCells\":{},\"outsideCells\":{},\"unresolved\":[{}],\"claim\":\"representedCellsOnly\"}}",self.scope,self.certified_cells,self.transported_cells,self.excluded_cells,self.outside_cells,failures)
    }
}
pub(crate) fn report(root: &CsgNode, pt: &PointTable) -> CoverageReport {
    let mut report = CoverageReport {
        scope: match Scope::new(root) {
            Scope::Sphere { .. } => "sphere",
            Scope::Cuboid { .. } => "positiveBoxIntersection",
            Scope::Outside => "outsideScope",
        }
        .into(),
        ..Default::default()
    };
    for w in &pt.coverage {
        if w.reason.is_none() && w.transported {
            report.transported_cells += 1;
        }
        match &w.reason {
            None if w.triangles.is_empty() => report.excluded_cells += 1,
            None => report.certified_cells += 1,
            Some(r) if unresolved(r) => report.unresolved.push((id(&w.cell), r.clone())),
            _ => report.outside_cells += 1,
        }
    }
    for failure in &pt.coverage_edge_failures {
        if !report
            .unresolved
            .iter()
            .any(|(cell, _)| *cell == id(&failure.cell))
        {
            report
                .unresolved
                .push((id(&failure.cell), failure.kind.reason().into()));
        }
    }
    report.unresolved.sort();
    report
}
pub(crate) fn failed_cells(pt: &PointTable) -> Vec<SfccCell> {
    let mut failures = pt
        .coverage
        .iter()
        .filter(|w| w.reason.as_deref().is_some_and(unresolved))
        .map(|w| w.cell)
        .map(|c| (id(&c), c))
        .collect::<BTreeMap<_, _>>();
    for f in &pt.coverage_edge_failures {
        if !f.cell.degenerate {
            failures.insert(id(&f.cell), f.cell);
        }
    }
    failures.into_values().collect()
}
pub(crate) fn signature(root: &CsgNode) -> Vec<u64> {
    if matches!(Scope::new(root), Scope::Outside) {
        return Vec::new();
    }
    fn walk(n: &CsgNode, out: &mut Vec<u64>) {
        match n {
            CsgNode::Leaf(l) => {
                out.extend([0, l.sign.to_bits()]);
                out.extend(l.pos.map(f64::to_bits));
                match l.shape {
                    Shape::Sphere { r } => out.extend([1, r.to_bits()]),
                    Shape::Cuboid { half } => {
                        out.push(2);
                        out.extend(half.map(f64::to_bits));
                    }
                    _ => unreachable!(),
                }
            }
            CsgNode::Max(ch) => {
                out.extend([3, ch.len() as u64]);
                for c in ch {
                    walk(c, out);
                }
            }
            _ => unreachable!(),
        }
    }
    let mut out = Vec::new();
    walk(root, &mut out);
    out
}
type P = [f64; 3];
type Bounds = [f64; 6];
#[derive(Clone, Debug)]
pub(crate) struct Witness {
    pub transported: bool,
    pub cell: SfccCell,
    pub reason: Option<String>,
    pub triangles: Vec<[usize; 3]>,
    pub vertices: Vec<(usize, PointKey, [u64; 6])>,
    pub faces: Vec<FaceProof>,
    pub curves: Vec<(usize, usize, super::point_table::CurveInterval)>,
}
pub(crate) fn payload(pt: &PointTable, i: usize) -> [u64; 6] {
    [pt.x(i), pt.y(i), pt.z(i), pt.nx(i), pt.ny(i), pt.nz(i)].map(f64::to_bits)
}
fn canonical_triangle(t: [usize; 3]) -> [usize; 3] {
    let k = (0..3).min_by_key(|&k| t[k]).unwrap();
    [t[k], t[(k + 1) % 3], t[(k + 2) % 3]]
}
fn triangle_edges(triangles: &[[usize; 3]]) -> BTreeSet<(usize, usize)> {
    triangles
        .iter()
        .flat_map(|t| {
            (0..3).map(move |i| {
                let a = t[i];
                let b = t[(i + 1) % 3];
                (a.min(b), a.max(b))
            })
        })
        .collect()
}
fn snapshot(scope: &Scope, pt: &PointTable, w: &mut Witness) -> Result<(), &'static str> {
    let mut used: BTreeSet<_> = w.triangles.iter().flatten().copied().collect();
    for f in &w.faces {
        used.extend(f.chain.iter().copied());
    }
    w.vertices = used.iter().map(|&i| (i, pt.key_at(i).clone(), payload(pt, i))).collect();
    if w.vertices.iter().any(|(_, _, p)| p.iter().any(|b| !f64::from_bits(*b).is_finite())) {
        return Err("nonfinite_point_payload");
    }
    let edges = triangle_edges(&w.triangles);
    w.curves = pt.identified_edges().filter(|(edge, _)| edges.contains(edge))
        .flat_map(|((a, b), intervals)| intervals.iter().map(move |v| (a, b, *v))).collect();
    if matches!(scope, Scope::Sphere { .. }) && !w.curves.is_empty() {
        return Err("sphere_spurious_curve_membership");
    }
    Ok(())
}
pub(crate) fn record(
    scope: &Scope,
    oct: &SfccOctree,
    c: &SfccCell,
    faces: &[HashMap<i64, FaceRecord>; 3],
    pt: &mut PointTable,
    tris: &[usize],
    features: Option<&SfccFeatureSet>,
) -> bool {
    if matches!(scope, Scope::Outside) {
        return false;
    }
    assert!(
        pt.coverage_cells.insert(id(c)),
        "duplicate local cell ownership"
    );
    let result = verify(scope, oct, c, faces, pt, tris, features);
    let reason = result.as_ref().err().map(|s| (*s).to_owned()).or_else(|| {
        pt.coverage_edge_failures
            .iter()
            .find(|f| id(&f.cell) == id(c))
            .map(|f| f.kind.reason().into())
    });
    let mut failed = reason.as_deref().is_some_and(unresolved);
    let mut w = Witness {
        transported: false,
        cell: *c,
        reason,
        triangles: Vec::new(),
        vertices: Vec::new(),
        faces: result.unwrap_or_default(),
        curves: Vec::new(),
    };
    w.triangles = tris
        .chunks_exact(3)
        .map(|t| canonical_triangle([t[0], t[1], t[2]]))
        .collect();
    w.triangles.sort();
    if w.reason.is_none() {
        if let Err(reason) = snapshot(scope, pt, &mut w) {
            w.reason = Some(reason.into());
            failed = true;
        }
    }
    if w.reason.is_none() {
        for (j, f) in w.faces.iter().enumerate() {
            if let Some(&(i, k)) = pt.coverage_faces.get(&(f.axis, f.key, f.len)) {
                if pt.coverage[i].faces[k] != *f {
                    pt.coverage[i].reason = Some("conflicting_shared_face_map".into());
                    w.reason = Some("conflicting_shared_face_map".into());
                    failed = true;
                }
            } else {
                pt.coverage_faces
                    .insert((f.axis, f.key, f.len), (pt.coverage.len(), j));
            }
        }
    }
    pt.coverage.push(w);
    failed
}
fn triangle_bag(tris: &[usize]) -> BTreeMap<[usize; 3], usize> {
    let mut bag = BTreeMap::new();
    for t in tris.chunks_exact(3) {
        *bag.entry(canonical_triangle([t[0], t[1], t[2]]))
            .or_default() += 1;
    }
    bag
}
fn curve_stamp(pt: &PointTable) -> Vec<(usize, usize, usize, u64, u64)> {
    let mut out = pt
        .identified_edges()
        .flat_map(|((a, b), v)| {
            v.iter()
                .map(move |c| (a, b, c.curve_id, c.start.to_bits(), c.end.to_bits()))
        })
        .collect::<Vec<_>>();
    out.sort();
    out
}
/// Constructed only while executing the checked planar flip operator. Each
/// recorded quadrilateral induces a common refinement by its diagonal crossing.
/// Original cell pieces/interfaces are retained as virtual subcomplexes.
pub(crate) struct FlipTransport {
    before: BTreeMap<[usize; 3], usize>,
    after: BTreeMap<[usize; 3], usize>,
    points: Vec<(usize, PointKey, [u64; 6])>,
    curves: Vec<(usize, usize, usize, u64, u64)>,
    protected: BTreeSet<(usize, usize)>,
    steps: Vec<[usize; 4]>,
}
pub(crate) fn flip_with_transport(
    pt: &PointTable,
    tris: &[usize],
    sweeps: usize,
) -> (Vec<usize>, usize, Option<FlipTransport>) {
    if !pt.coverage.iter().any(|w| w.reason.is_none()) {
        let (out, n) = super::sliver_flip::flip_sliver_triangles(pt, tris, sweeps);
        return (out, n, None);
    }
    let used = tris.iter().copied().collect::<BTreeSet<_>>();
    let points = used
        .into_iter()
        .map(|i| (i, pt.key_at(i).clone(), payload(pt, i)))
        .collect();
    let curves = curve_stamp(pt);
    let protected = pt.protected_edges().collect();
    let before = triangle_bag(tris);
    let mut steps = Vec::new();
    let (out, n) = super::sliver_flip::flip_sliver_triangles_recorded(pt, tris, sweeps, &mut steps);
    assert_eq!(n, steps.len(), "checked flip journal lost an operation");
    let transport = FlipTransport {
        before,
        after: triangle_bag(&out),
        points,
        curves,
        protected,
        steps,
    };
    (out, n, Some(transport))
}
#[cfg(all(test, feature = "serde"))]
pub(crate) fn finish(pt: &mut PointTable, before: &[usize], tris: &[usize]) {
    finish_with_transport(pt, before, tris, None);
}
pub(crate) fn finish_with_transport(
    pt: &mut PointTable,
    before: &[usize],
    tris: &[usize],
    transport: Option<&FlipTransport>,
) {
    let mut actual: BTreeMap<[usize; 3], usize> = BTreeMap::new();
    for t in tris.chunks_exact(3) {
        *actual
            .entry(canonical_triangle([t[0], t[1], t[2]]))
            .or_default() += 1;
    }
    let transport = transport.filter(|t| {
        t.after == actual
            && t.points
                .iter()
                .all(|(i, k, p)| *i < pt.count() && pt.key_at(*i) == k && payload(pt, *i) == *p)
            && t.curves == curve_stamp(pt)
            && t.protected == pt.protected_edges().collect()
    });
    let original: BTreeSet<_> = before
        .chunks_exact(3)
        .map(|t| canonical_triangle([t[0], t[1], t[2]]))
        .collect();
    let added: Vec<_> = actual.keys().filter(|t| !original.contains(*t)).collect();
    let all_owned: BTreeSet<_> = pt
        .coverage
        .iter()
        .flat_map(|w| w.triangles.iter().flatten().copied())
        .collect();
    let unowned_addition = added
        .iter()
        .any(|t| t.iter().all(|v| !all_owned.contains(v)));
    let mut witnesses = std::mem::take(&mut pt.coverage);
    for w in &mut witnesses {
        if w.reason.is_some() {
            continue;
        }
        let metadata_unchanged = w
            .vertices
            .iter()
            .all(|(i, k, p)| *i < pt.count() && pt.key_at(*i) == k && payload(pt, *i) == *p)
            && triangle_edges(&w.triangles).iter().all(|&(a, b)| {
                let mut expected = w
                    .curves
                    .iter()
                    .filter(|(x, y, _)| *x == a && *y == b)
                    .map(|(_, _, c)| (c.curve_id, c.start.to_bits(), c.end.to_bits()))
                    .collect::<Vec<_>>();
                let mut current = pt
                    .curve_intervals(a, b)
                    .into_iter()
                    .map(|c| (c.curve_id, c.start.to_bits(), c.end.to_bits()))
                    .collect::<Vec<_>>();
                expected.sort();
                current.sort();
                expected == current
            });
        let unchanged = w.triangles.iter().all(|t| actual.get(t) == Some(&1)) && metadata_unchanged;
        // New triangles using any owned vertex invalidate the witness,
        // even if all its old triangles survived.
        let owned: BTreeSet<_> = w.triangles.iter().flatten().copied().collect();
        let extra = added.iter().any(|t| t.iter().any(|v| owned.contains(v)));
        if !unchanged || extra || unowned_addition {
            if metadata_unchanged
                && transport.is_some_and(|t| {
                    !t.steps.is_empty()
                        && w.triangles.iter().all(|tri| t.before.get(tri) == Some(&1))
                })
            {
                w.transported = true;
            } else {
                w.reason = Some("cleanup_changed_owned_complex".into());
            }
        }
    }
    pt.coverage = witnesses;
}
pub(crate) fn import_witnesses(
    pt: &mut PointTable,
    mut incoming: Vec<Witness>,
    remap: &[usize],
    lat: &SfccLattice,
    root: &CsgNode,
) {
    assert!(
        !matches!(Scope::new(root), Scope::Outside) || incoming.is_empty(),
        "outside-scope worker certificate"
    );
    for w in &mut incoming {
        assert!(
            cell_box(lat, &w.cell).is_ok() || w.reason.as_deref().is_some_and(|r| !unresolved(r)),
            "worker certificate cell/grid mismatch"
        );
        assert!(
            pt.coverage_cells.insert(id(&w.cell)),
            "duplicate certified cell ownership"
        );
        let map = |i: usize| *remap.get(i).expect("worker certificate point out of range");
        for t in &mut w.triangles {
            *t = canonical_triangle(t.map(map));
        }
        w.triangles.sort();
        for (i, key, p) in &mut w.vertices {
            *i = map(*i);
            assert_eq!(pt.key_at(*i), key, "worker certificate key mismatch");
            assert_eq!(payload(pt, *i), *p, "worker certificate payload mismatch");
        }
        for f in &mut w.faces {
            for i in &mut f.chain {
                *i = map(*i);
            }
            for root in &mut f.roots {
                root.point = map(root.point);
            }
            for (i, _, _) in &mut f.pins {
                *i = map(*i);
            }
            f.pins.sort();
        }
        for (a, b, interval) in &mut w.curves {
            *a = map(*a);
            *b = map(*b);
            if *a > *b {
                std::mem::swap(a, b);
                *interval = interval.reversed();
            }
        }
        for (j, f) in w.faces.iter().enumerate() {
            if let Some(&(i, k)) = pt.coverage_faces.get(&(f.axis, f.key, f.len)) {
                assert_eq!(
                    &pt.coverage[i].faces[k], f,
                    "conflicting shared face certificate"
                );
            } else {
                pt.coverage_faces
                    .insert((f.axis, f.key, f.len), (pt.coverage.len(), j));
            }
        }
        pt.coverage.push(w.clone());
    }
}
/// Reconstruct independent obligations from actual represented cells and face
/// records after transport. A serialized success flag is never a premise.
pub(crate) fn reverify_transport(
    pt: &mut PointTable,
    root: &CsgNode,
    features: &SfccFeatureSet,
    lat: &SfccLattice,
    tris: &[usize],
    face_uses: &HashMap<(u64, i64, i64, usize, usize), (u64, u64)>,
) {
    let scope = Scope::new(root);
    if matches!(scope, Scope::Outside) {
        assert!(pt.coverage.is_empty());
        return;
    }
    let cells = pt.coverage.iter().map(|w| w.cell).collect::<Vec<_>>();
    let oct = super::octree::rebuild_octree_from_leaves(root, lat, cells);
    let mut records: [HashMap<i64, FaceRecord>; 3] = std::array::from_fn(|_| HashMap::new());
    for (&(axis, key, len, a, b), &(fwd, rev)) in face_uses {
        assert!(
            axis < 3 && fwd <= u32::MAX as u64 && rev <= u32::MAX as u64,
            "worker face payload"
        );
        let record = records[axis as usize]
            .entry(key)
            .or_insert_with(|| FaceRecord {
                axis: axis as usize,
                key,
                len,
                segments: Vec::new(),
                pins: Vec::new(),
                consumed_fwd: Vec::new(),
                consumed_rev: Vec::new(),
            });
        assert_eq!(record.len, len, "worker conflicting atomic face lengths");
        record
            .segments
            .push(super::face_contour::FaceSegment { a, b });
        record.consumed_fwd.push(fwd as u32);
        record.consumed_rev.push(rev as u32);
    }
    for w in &pt.coverage {
        for f in &w.faces {
            let record = records[f.axis].entry(f.key).or_insert_with(|| FaceRecord {
                axis: f.axis,
                key: f.key,
                len: f.len,
                segments: Vec::new(),
                pins: Vec::new(),
                consumed_fwd: Vec::new(),
                consumed_rev: Vec::new(),
            });
            assert_eq!(
                record.len, f.len,
                "worker conflicting certificate face lengths"
            );
            for &(point_id, curve_id, t) in &f.pins {
                if let Some(old) = record
                    .pins
                    .iter()
                    .find(|p| p.point_id == point_id && p.curve_id == curve_id)
                {
                    assert_eq!(
                        old.t.to_bits(),
                        t,
                        "worker conflicting canonical pin parameter"
                    );
                } else {
                    record.pins.push(super::face_contour::FacePin {
                        point_id,
                        curve_id,
                        t: f64::from_bits(t),
                    });
                }
            }
        }
    }
    let mut actual = tris
        .chunks_exact(3)
        .map(|t| canonical_triangle([t[0], t[1], t[2]]))
        .collect::<Vec<_>>();
    actual.sort();
    let mut owned = pt
        .coverage
        .iter()
        .flat_map(|w| w.triangles.iter().copied())
        .collect::<Vec<_>>();
    owned.sort();
    assert_eq!(
        actual, owned,
        "worker local triangle ownership is incomplete or duplicated"
    );
    let mut witnesses = std::mem::take(&mut pt.coverage);
    for w in &mut witnesses {
        let result = verify(
            &scope,
            &oct,
            &w.cell,
            &records,
            pt,
            &w.triangles.iter().flatten().copied().collect::<Vec<_>>(),
            Some(features),
        );
        match result {
            Ok(faces) if w.reason.is_none() => {
                if faces != w.faces {
                    w.reason = Some("transport_certificate_correspondence".into());
                } else if let Err(reason) = snapshot(&scope, pt, w) {
                    // Fresh verification owns a fresh complete lifecycle snapshot;
                    // omitted wire entries must not hide a subsequent edit.
                    w.reason = Some(reason.into());
                }
            }
            // A failed recheck never inherits a claimed success from the wire,
            // including coherent grids outside this certificate's exact domain.
            Err(reason) => w.reason = Some(reason.into()),
            _ => {}
        }
    }
    pt.coverage = witnesses;
}
#[derive(Clone, Debug)]
pub(crate) enum Scope {
    Outside,
    Sphere {
        center: P,
        r: f64,
    },
    Cuboid {
        bounds: Bounds,
        owners: [Vec<Vec<usize>>; 6],
        indices: [Vec<usize>; 6],
    },
}
fn identity(l: &Leaf) -> bool {
    l.sim.r == [1., 0., 0., 0., 1., 0., 0., 0., 1.]
        && l.sim.s == 1.
        && l.sim.t == [0.; 3]
        && l.pos.iter().all(|x| x.is_finite())
        && (l.sign == 1. || l.sign == -1.)
}
fn box_bounds(l: &Leaf) -> Option<Bounds> {
    if !identity(l) {
        return None;
    }
    let Shape::Cuboid { half } = l.shape else {
        return None;
    };
    if half.iter().any(|h| !h.is_finite() || *h <= 0.) {
        return None;
    }
    let mut b = [0.; 6];
    for a in 0..3 {
        b[a] = l.pos[a] - half[a];
        b[a + 3] = l.pos[a] + half[a];
        if !exact_affine_eq(l.pos[a], -half[a], 1., b[a])
            || !exact_affine_eq(l.pos[a], half[a], 1., b[a + 3])
        {
            return None;
        }
    }
    Some(b)
}
impl Scope {
    pub(crate) fn new(root: &CsgNode) -> Self {
        if let CsgNode::Leaf(l) = root {
            if let Shape::Sphere { r } = l.shape {
                if identity(l) && l.sign == 1. && r.is_finite() && r > 0. {
                    return Self::Sphere { center: l.pos, r };
                }
            }
        }
        fn collect(
            n: &CsgNode,
            path: &mut Vec<usize>,
            out: &mut Vec<(Bounds, Vec<usize>)>,
        ) -> Option<()> {
            match n {
                CsgNode::Leaf(l) if l.sign == 1. => out.push((box_bounds(l)?, path.clone())),
                CsgNode::Max(ch) if !ch.is_empty() => {
                    for (i, c) in ch.iter().enumerate() {
                        path.push(i);
                        collect(c, path, out)?;
                        path.pop();
                    }
                }
                _ => return None,
            }
            Some(())
        }
        let mut leaves = Vec::new();
        if collect(root, &mut Vec::new(), &mut leaves).is_none() {
            return Self::Outside;
        }
        let mut b = [f64::NEG_INFINITY; 6];
        b[3..].fill(f64::INFINITY);
        for (a, _) in &leaves {
            for k in 0..3 {
                b[k] = b[k].max(a[k]);
                b[k + 3] = b[k + 3].min(a[k + 3]);
            }
        }
        if (0..3).any(|k| b[k] >= b[k + 3]) {
            return Self::Outside;
        }
        let owners = std::array::from_fn(|k| {
            leaves
                .iter()
                .filter(|(a, _)| a[k] == b[k])
                .map(|(_, p)| p.clone())
                .collect()
        });
        let indices = std::array::from_fn(|k| {
            leaves
                .iter()
                .enumerate()
                .filter(|(_, (a, _))| a[k] == b[k])
                .map(|(i, _)| i)
                .collect()
        });
        Self::Cuboid {
            bounds: b,
            owners,
            indices,
        }
    }
}

/// Finite original-tree sign algebra, preserving ties and zero intervals.
enum Boxes {
    Leaf(Bounds, i8),
    Min(Vec<Boxes>),
    Max(Vec<Boxes>),
}
impl Boxes {
    fn new(n: &CsgNode) -> Option<Self> {
        match n {
            CsgNode::Leaf(l) => Some(Self::Leaf(box_bounds(l)?, l.sign as i8)),
            CsgNode::Min(ch) | CsgNode::Max(ch) if !ch.is_empty() => {
                let ch = ch
                    .iter()
                    .map(|c| Self::new(c))
                    .collect::<Option<Vec<_>>>()?;
                Some(if matches!(n, CsgNode::Min(_)) {
                    Self::Min(ch)
                } else {
                    Self::Max(ch)
                })
            }
            _ => None,
        }
    }
    // Bound storage during collection, after filtering and exact deduplication.
    // This does not deduplicate tree occurrences: sign() still folds every path.
    fn planes(
        &self,
        a: usize,
        lo: f64,
        hi: f64,
        out: &mut Vec<f64>,
    ) -> Result<(), EdgeFailureKind> {
        const EVENT_BUDGET: usize = 128;
        match self {
            Self::Leaf(b, _) => {
                for x in [b[a], b[a + 3]] {
                    if x >= lo && x <= hi && !out.contains(&x) {
                        if out.len() == EVENT_BUDGET {
                            return Err(EdgeFailureKind::Budget);
                        }
                        out.push(x);
                    }
                }
            }
            Self::Min(ch) | Self::Max(ch) => {
                for c in ch {
                    c.planes(a, lo, hi, out)?;
                }
            }
        }
        Ok(())
    }
    // Each coordinate is either an exact represented event or an OPEN interval.
    // Comparing both endpoints avoids rounding a midpoint into an event.
    fn sign(&self, lo: P, hi: P) -> i8 {
        match self {
            Self::Leaf(b, s) => {
                let mut zero = false;
                for a in 0..3 {
                    if hi[a] < b[a]
                        || lo[a] > b[a + 3]
                        || (hi[a] == b[a] && lo[a] < hi[a])
                        || (lo[a] == b[a + 3] && lo[a] < hi[a])
                    {
                        return *s;
                    }
                    zero |= lo[a] == hi[a] && (lo[a] == b[a] || lo[a] == b[a + 3]);
                }
                if zero {
                    0
                } else {
                    -*s
                }
            }
            Self::Min(ch) => ch.iter().map(|c| c.sign(lo, hi)).min().unwrap_or(0),
            Self::Max(ch) => ch.iter().map(|c| c.sign(lo, hi)).max().unwrap_or(0),
        }
    }
    fn edge_failure(&self, p: P, q: P) -> Option<EdgeFailureKind> {
        if p.iter().chain(&q).any(|x| !x.is_finite()) {
            return Some(EdgeFailureKind::Arithmetic);
        }
        let Some(a) = (0..3).find(|&a| p[a] != q[a]) else {
            return Some(EdgeFailureKind::Arithmetic);
        };
        if (0..3).any(|k| k != a && p[k] != q[k]) {
            return Some(EdgeFailureKind::Arithmetic);
        }
        let (p, q) = if p[a] < q[a] { (p, q) } else { (q, p) };
        let mut cuts = vec![p[a], q[a]];
        if let Err(kind) = self.planes(a, p[a], q[a], &mut cuts) {
            return Some(kind);
        }
        cuts.sort_by(f64::total_cmp);
        cuts.dedup();
        let mut roots = 0;
        for x in &cuts {
            let mut point = p;
            point[a] = *x;
            roots += usize::from(self.sign(point, point) == 0);
        }
        if roots > 1 {
            return Some(EdgeFailureKind::NotSingle);
        }
        let signs: Vec<_> = cuts
            .windows(2)
            .map(|w| {
                let mut l = p;
                let mut h = p;
                l[a] = w[0];
                h[a] = w[1];
                self.sign(l, h)
            })
            .collect();
        if signs.contains(&0) {
            return Some(EdgeFailureKind::NotSingle);
        }
        for (i, x) in cuts
            .iter()
            .enumerate()
            .skip(1)
            .take(cuts.len().saturating_sub(2))
        {
            let mut point = p;
            point[a] = *x;
            if self.sign(point, point) == 0 && signs[i - 1] == signs[i] {
                return Some(EdgeFailureKind::NotSingle);
            }
        }
        None
    }
}
pub(crate) enum BoxEdgeCheck {
    OutsideScope,
    Resolved,
    NeedsSplit,
    Indeterminate,
}
#[derive(Clone, Copy, Debug)]
#[repr(u8)]
pub(crate) enum EdgeFailureKind {
    Arithmetic = 1,
    Budget = 2,
    NotSingle = 3,
}
impl EdgeFailureKind {
    pub(crate) fn reason(self) -> &'static str {
        match self {
            Self::Arithmetic => "box_subedge_arithmetic",
            Self::Budget => "box_subedge_budget",
            Self::NotSingle => "box_subedge_zero_set_not_single",
        }
    }
}
#[derive(Clone, Debug)]
pub(crate) struct EdgeFailure {
    pub cell: SfccCell,
    pub kind: EdgeFailureKind,
}
pub(crate) struct AtomicBoxGuard(Boxes);
impl AtomicBoxGuard {
    pub(crate) fn new(root: &CsgNode) -> Option<Self> {
        Boxes::new(root).map(Self)
    }
    pub(crate) fn inspect(&self, oct: &SfccOctree, c: &SfccCell) -> Option<EdgeFailureKind> {
        let lat = &oct.lat;
        if !(1..=14).contains(&lat.max_depth)
            || c.level > lat.max_depth
            || lat.res != 1_i64 << lat.max_depth
            || lat.span != lat.res + 1
            || !lat.step.is_finite()
            || lat.step <= 0.
            || !lat.world_size.is_finite()
            || lat.world_size <= 0.
            || [lat.origin_x, lat.origin_y, lat.origin_z]
                .iter()
                .any(|x| !x.is_finite())
            || [c.ix, c.iy, c.iz]
                .iter()
                .any(|v| *v < 0 || *v >= 1_i64 << c.level)
        {
            return Some(EdgeFailureKind::Arithmetic);
        }
        let stride = stride_at_level(lat, c.level);
        let base = [c.ix * stride, c.iy * stride, c.iz * stride];
        let mut seen = BTreeSet::new();
        for axis in 0..3 {
            let [u, v] = face_axes(axis);
            for side in 0..2 {
                let mut neighbor = [c.ix, c.iy, c.iz];
                neighbor[axis] += if side == 0 { -1 } else { 1 };
                let finer = oct.is_internal(c.level as i64, neighbor[0], neighbor[1], neighbor[2]);
                let len = if finer { stride / 2 } else { stride };
                if len < 1 {
                    return Some(EdgeFailureKind::Arithmetic);
                }
                for i in 0..if finer { 2 } else { 1 } {
                    for j in 0..if finer { 2 } else { 1 } {
                        let mut g = base;
                        g[axis] += side * stride;
                        g[u] += i * len;
                        g[v] += j * len;
                        for (moving, fixed, at) in [(u, v, 0), (v, u, 1), (u, v, 1), (v, u, 0)] {
                            let mut start = g;
                            start[fixed] += at * len;
                            let mut cuts = vec![0];
                            cuts.extend(collect_edge_interior_offsets(
                                |k| oct.has_sample_key(k),
                                lat,
                                moving,
                                start[0],
                                start[1],
                                start[2],
                                len,
                            ));
                            cuts.push(len);
                            for w in cuts.windows(2) {
                                let mut a = start;
                                let mut b = start;
                                a[moving] += w[0];
                                b[moving] += w[1];
                                if !seen.insert((moving, a, w[1] - w[0])) {
                                    continue;
                                }
                                if seen.len() > 4096 {
                                    return Some(EdgeFailureKind::Budget);
                                }
                                let p = point_to_world(lat, a[0], a[1], a[2]);
                                let q = point_to_world(lat, b[0], b[1], b[2]);
                                if p.iter().chain(&q).any(|x| !x.is_finite()) {
                                    return Some(EdgeFailureKind::Arithmetic);
                                }
                                if let Some(kind) = self.0.edge_failure(p, q) {
                                    return Some(kind);
                                }
                            }
                        }
                    }
                }
            }
        }
        None
    }
}
pub(crate) fn import_edge_failures(
    pt: &mut PointTable,
    failures: Vec<EdgeFailure>,
    lat: &SfccLattice,
    root: &CsgNode,
) {
    if failures.is_empty() {
        return;
    }
    assert!(
        AtomicBoxGuard::new(root).is_some(),
        "outside-scope signed-box failure"
    );
    for f in failures {
        assert!(
            f.cell.level <= lat.max_depth
                && [f.cell.ix, f.cell.iy, f.cell.iz]
                    .iter()
                    .all(|v| *v >= 0 && *v < (1_i64 << f.cell.level)),
            "invalid signed-box failure cell"
        );
        assert!(
            !pt.coverage_edge_failures
                .iter()
                .any(|old| id(&old.cell) == id(&f.cell)),
            "duplicate signed-box failure ownership"
        );
        pt.coverage_edge_failures.push(f);
    }
}
pub(crate) fn box_edges(root: &CsgNode, pts: &[f64; 27]) -> BoxEdgeCheck {
    let Some(boxes) = Boxes::new(root) else {
        return BoxEdgeCheck::OutsideScope;
    };
    if pts.iter().any(|x| !x.is_finite()) {
        return BoxEdgeCheck::Indeterminate;
    }
    for &[a, b] in &CELL_EDGES {
        match boxes.edge_failure(
            std::array::from_fn(|k| pts[a * 3 + k]),
            std::array::from_fn(|k| pts[b * 3 + k]),
        ) {
            Some(EdgeFailureKind::NotSingle) => return BoxEdgeCheck::NeedsSplit,
            Some(_) => return BoxEdgeCheck::Indeterminate,
            None => {}
        }
    }
    BoxEdgeCheck::Resolved
}

fn grid_point(lat: &SfccLattice, g: [i64; 3]) -> Result<P, &'static str> {
    if lat.max_depth < 1
        || lat.max_depth > 14
        || lat.res != 1_i64 << lat.max_depth
        || lat.span != lat.res + 1
        || !lat.step.is_finite()
        || lat.step <= 0.
        || !exact_affine_eq(0., lat.world_size, 1. / lat.res as f64, lat.step)
        || !lat.world_size.is_finite()
        || lat.world_size <= 0.
        || g.iter().any(|v| *v < 0 || *v > lat.res)
    {
        return Err("grid_scope");
    }
    let p = point_to_world(lat, g[0], g[1], g[2]);
    for a in 0..3 {
        let origin = [lat.origin_x, lat.origin_y, lat.origin_z][a];
        if !exact_affine_eq(origin, lat.world_size, g[a] as f64 / lat.res as f64, p[a]) {
            return Err("grid_not_exact");
        }
    }
    Ok(p)
}
fn cell_box(lat: &SfccLattice, c: &SfccCell) -> Result<Bounds, &'static str> {
    grid_point(lat, [0; 3])?;
    if c.level > lat.max_depth
        || [c.ix, c.iy, c.iz]
            .iter()
            .any(|v| *v < 0 || *v >= 1_i64 << c.level)
    {
        return Err("cell_scope");
    }
    if c.key != crate::math::grid::cell_key(lat, c.level, c.ix, c.iy, c.iz) {
        return Err("cell_identity");
    }
    let s = stride_at_level(lat, c.level);
    let p = grid_point(lat, [c.ix * s, c.iy * s, c.iz * s])?;
    let q = grid_point(lat, [(c.ix + 1) * s, (c.iy + 1) * s, (c.iz + 1) * s])?;
    let b = cell_aabb(lat, c.level, c.ix, c.iy, c.iz);
    if b != [p[0], p[1], p[2], q[0], q[1], q[2]] {
        return Err("cell_map_mismatch");
    }
    for a in 0..3 {
        if !exact_affine_eq(p[a], lat.world_size, 1. / (1_u64 << c.level) as f64, q[a]) {
            return Err("cell_extent");
        }
    }
    Ok(b)
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RootProof {
    pub point: usize,
    pub axis: usize,
    pub start: [i64; 3],
    pub len: i64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FaceProof {
    pub axis: usize,
    pub key: i64,
    pub len: i64,
    pub chain: Vec<usize>,
    pub mapped: Vec<[u64; 3]>,
    pub pins: Vec<(usize, usize, u64)>,
    pub roots: Vec<RootProof>,
}
fn chain(segments: &[(usize, usize)]) -> Result<Vec<usize>, &'static str> {
    if segments.is_empty() {
        return Ok(Vec::new());
    }
    let mut next = BTreeMap::new();
    let mut incoming = BTreeSet::new();
    for &(a, b) in segments {
        if a == b || next.insert(a, b).is_some() || !incoming.insert(b) {
            return Err("face_chain_branch");
        }
    }
    let starts: Vec<_> = next
        .keys()
        .filter(|v| !incoming.contains(v))
        .copied()
        .collect();
    if starts.len() != 1 {
        return Err("face_chain_closed_or_multiple");
    }
    let mut out = vec![starts[0]];
    let mut seen = BTreeSet::new();
    while let Some(&b) = next.get(out.last().unwrap()) {
        if !seen.insert(*out.last().unwrap()) {
            return Err("face_chain_cycle");
        }
        out.push(b);
    }
    if seen.len() != segments.len() {
        return Err("face_chain_disconnected");
    }
    Ok(out)
}
fn check_face_identity(
    rec: Option<&FaceRecord>,
    axis: usize,
    key: i64,
    len: i64,
) -> Result<(), &'static str> {
    if rec.is_some_and(|r| r.axis != axis || r.key != key || r.len != len) {
        return Err("face_identity");
    }
    Ok(())
}
fn sphere_face(
    scope: &Scope,
    oct: &SfccOctree,
    axis: usize,
    g: [i64; 3],
    len: i64,
    rec: Option<&FaceRecord>,
    pt: &PointTable,
) -> Result<FaceProof, &'static str> {
    let Scope::Sphere { center, r } = scope else {
        return Err("sphere_scope");
    };
    let lat = &oct.lat;
    let [u, v] = face_axes(axis);
    let lo = grid_point(lat, g)?;
    check_face_identity(rec, axis, pack_point(lat, g[0], g[1], g[2]), len)?;
    let mut end = g;
    end[u] += len;
    end[v] += len;
    let hi = grid_point(lat, end)?;
    for a in [u, v] {
        if !exact_affine_eq(lo[a], lat.step, len as f64, hi[a]) {
            return Err("face_extent");
        }
    }
    let mut roots = Vec::new();
    for (walk, (moving, fixed, side)) in [(u, v, 0), (v, u, 1), (u, v, 1), (v, u, 0)]
        .into_iter()
        .enumerate()
    {
        let mut start = g;
        start[fixed] += side * len;
        let mut cuts = vec![0];
        cuts.extend(collect_edge_interior_offsets(
            |k| oct.has_sample_key(k),
            lat,
            moving,
            start[0],
            start[1],
            start[2],
            len,
        ));
        cuts.push(len);
        for w in cuts.windows(2) {
            let mut a = start;
            let mut b = start;
            a[moving] += w[0];
            b[moving] += w[1];
            let p = grid_point(lat, a)?;
            let q = grid_point(lat, b)?;
            let sp = sphere_sign(p, *center, *r).ok_or("sphere_arithmetic")?;
            let sq = sphere_sign(q, *center, *r).ok_or("sphere_arithmetic")?;
            if sp == 0 || sq == 0 {
                return Err("sphere_edge_contact");
            }
            if sp != sq {
                roots.push((
                    super::point_table::crossing_key(pack_point(lat, a[0], a[1], a[2]), moving),
                    p,
                    q,
                    moving,
                    if walk < 2 { sp < 0 } else { sq < 0 },
                    a,
                    w[1] - w[0],
                ));
            } else if sp > 0 {
                let mut near = p;
                near[moving] = center[moving].clamp(p[moving], q[moving]);
                if sphere_sign(near, *center, *r) != Some(1) {
                    return Err("sphere_edge_multiple");
                }
            }
        }
    }
    if roots.is_empty() {
        let near = std::array::from_fn(|a| center[a].clamp(lo[a], hi[a]));
        let all_inside = (0..4).all(|i| {
            let mut p = lo;
            p[u] = if i & 1 == 0 { lo[u] } else { hi[u] };
            p[v] = if i & 2 == 0 { lo[v] } else { hi[v] };
            sphere_sign(p, *center, *r) == Some(-1)
        });
        if sphere_sign(near, *center, *r) != Some(1) && !all_inside {
            return Err("sphere_face_hidden_loop");
        }
        if rec.is_some_and(|r| !r.segments.is_empty() || !r.pins.is_empty()) {
            return Err("sphere_face_spurious");
        }
        return Ok(FaceProof {
            axis,
            key: pack_point(lat, g[0], g[1], g[2]),
            len,
            chain: Vec::new(),
            mapped: Vec::new(),
            pins: Vec::new(),
            roots: Vec::new(),
        });
    }
    if roots.len() != 2 {
        return Err("sphere_face_root_count");
    }
    let rec = rec.ok_or("face_missing")?;
    if !rec.pins.is_empty() {
        return Err("sphere_spurious_feature_pin");
    }
    let ch = chain(&rec.segments.iter().map(|s| (s.a, s.b)).collect::<Vec<_>>())?;
    if ch.len() < 2 {
        return Err("sphere_face_missing_arc");
    }
    let mut matched = BTreeSet::new();
    let mut root_proofs = Vec::new();
    for &i in [ch[0], *ch.last().unwrap()].iter() {
        let PointKey::Num(key) = pt.key_at(i) else {
            return Err("sphere_root_key");
        };
        let Some((j, (_, p, q, a, start, g, n))) =
            roots.iter().enumerate().find(|(_, r)| r.0 == *key)
        else {
            return Err("sphere_unexpected_root");
        };
        if (i == ch[0]) != *start {
            return Err("sphere_arc_orientation");
        }
        let x = [pt.x(i), pt.y(i), pt.z(i)];
        if !(p[*a] < x[*a] && x[*a] < q[*a]) || (0..3).any(|k| k != *a && x[k] != p[k]) {
            return Err("sphere_root_payload");
        }
        matched.insert(j);
        root_proofs.push(RootProof {
            point: i,
            axis: *a,
            start: *g,
            len: *n,
        });
    }
    if matched.len() != 2 {
        return Err("sphere_root_duplicate");
    }
    for &i in &ch {
        let p = [pt.x(i), pt.y(i), pt.z(i)];
        if p[axis] != lo[axis]
            || p.iter().any(|x| !x.is_finite())
            || (0..3).any(|a| p[a] < lo[a] || p[a] > hi[a])
        {
            return Err("sphere_face_payload");
        }
    }
    for w in ch.windows(2) {
        if [pt.x(w[0]), pt.y(w[0]), pt.z(w[0])] == [pt.x(w[1]), pt.y(w[1]), pt.z(w[1])] {
            return Err("sphere_face_collapsed_subdivision");
        }
    }
    Ok(FaceProof {
        axis,
        key: rec.key,
        len,
        chain: ch,
        mapped: Vec::new(),
        pins: Vec::new(),
        roots: root_proofs,
    })
}

/// Verify the actual indexed filling, independently of geometric normal samples.
pub(crate) fn disk(tris: &[usize]) -> Result<Vec<(usize, usize)>, &'static str> {
    if tris.is_empty() || tris.len() % 3 != 0 {
        return Err("disk_empty");
    }
    let mut edges: BTreeMap<(usize, usize), Vec<(usize, usize)>> = BTreeMap::new();
    let mut links: BTreeMap<usize, Vec<(usize, usize)>> = BTreeMap::new();
    let mut verts = BTreeSet::new();
    for t in tris.chunks_exact(3) {
        if t[0] == t[1] || t[1] == t[2] || t[2] == t[0] {
            return Err("disk_triangle");
        }
        for k in 0..3 {
            let a = t[k];
            let b = t[(k + 1) % 3];
            edges.entry((a.min(b), a.max(b))).or_default().push((a, b));
            links.entry(a).or_default().push((b, t[(k + 2) % 3]));
            verts.insert(a);
        }
    }
    let mut boundary = Vec::new();
    for uses in edges.values() {
        match uses.as_slice() {
            [e] => boundary.push(*e),
            [a, b] if a.0 == b.1 && a.1 == b.0 => {}
            _ => return Err("disk_edge_incidence"),
        }
    }
    if verts.len() as isize - edges.len() as isize + (tris.len() / 3) as isize != 1 {
        return Err("disk_euler");
    }
    let mut adjacency: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for &(a, b) in edges.keys() {
        adjacency.entry(a).or_default().push(b);
        adjacency.entry(b).or_default().push(a);
    }
    let mut visited = BTreeSet::new();
    let mut todo = vec![*verts.first().unwrap()];
    while let Some(v) = todo.pop() {
        if visited.insert(v) {
            todo.extend(&adjacency[&v]);
        }
    }
    if visited.len() != verts.len() {
        return Err("disk_disconnected");
    }
    let mut loop_next = BTreeMap::new();
    for &(a, b) in &boundary {
        if loop_next.insert(a, b).is_some() {
            return Err("disk_boundary_branch");
        }
    }
    if boundary.is_empty() {
        return Err("disk_no_boundary");
    }
    let start = boundary[0].0;
    let mut seen = BTreeSet::new();
    let mut a = start;
    while seen.insert(a) {
        a = *loop_next.get(&a).ok_or("disk_boundary_open")?;
    }
    if a != start || seen.len() != boundary.len() {
        return Err("disk_boundary_multiple");
    }
    for (&v, link) in &links {
        let mut adjacency: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
        for &(a, b) in link {
            adjacency.entry(a).or_default().push(b);
            adjacency.entry(b).or_default().push(a);
        }
        let ends = adjacency.values().filter(|a| a.len() == 1).count();
        if adjacency.values().any(|a| a.is_empty() || a.len() > 2)
            || ends != if loop_next.contains_key(&v) { 2 } else { 0 }
        {
            return Err("disk_link_degree");
        }
        let mut seen = BTreeSet::new();
        let mut todo = vec![*adjacency.keys().next().unwrap()];
        while let Some(v) = todo.pop() {
            if seen.insert(v) {
                todo.extend(&adjacency[&v]);
            }
        }
        if seen.len() != adjacency.len() {
            return Err("disk_link_disconnected");
        }
    }
    Ok(boundary)
}

pub(crate) fn verify(
    scope: &Scope,
    oct: &SfccOctree,
    c: &SfccCell,
    faces: &[HashMap<i64, FaceRecord>; 3],
    pt: &PointTable,
    tris: &[usize],
    features: Option<&SfccFeatureSet>,
) -> Result<Vec<FaceProof>, &'static str> {
    if matches!(scope, Scope::Outside) {
        return Err("outside_scope");
    }
    let cb = cell_box(&oct.lat, c)?;
    if let Scope::Cuboid { .. } = scope {
        return verify_box(scope, oct, c, faces, pt, tris, features);
    }
    let Scope::Sphere { center, r } = scope else {
        unreachable!()
    };
    let contains = (0..3).all(|a| {
        exact_sum_sign(center[a], -*r, cb[a]).is_some_and(|s| s >= 0)
            && exact_sum_sign(center[a], *r, cb[a + 3]).is_some_and(|s| s <= 0)
    });
    if contains {
        return Err("sphere_internal_component");
    }
    let stride = stride_at_level(&oct.lat, c.level);
    let base = [c.ix * stride, c.iy * stride, c.iz * stride];
    let mut proofs = Vec::new();
    let mut expected = Vec::new();
    for axis in 0..3 {
        let [u, v] = face_axes(axis);
        for side in 0..2 {
            let mut n = [c.ix, c.iy, c.iz];
            n[axis] += if side == 1 { 1 } else { -1 };
            let finer = oct.is_internal(c.level as i64, n[0], n[1], n[2]);
            let len = if finer { stride / 2 } else { stride };
            if len < 1 {
                return Err("face_balance");
            }
            for i in 0..if finer { 2 } else { 1 } {
                for j in 0..if finer { 2 } else { 1 } {
                    let mut g = base;
                    g[axis] += side * stride;
                    g[u] += i * len;
                    g[v] += j * len;
                    let key = pack_point(&oct.lat, g[0], g[1], g[2]);
                    let rec = faces[axis].get(&key);
                    let proof = sphere_face(scope, oct, axis, g, len, rec, pt)?;
                    for w in proof.chain.windows(2) {
                        expected.push(if side == 1 {
                            (w[1], w[0])
                        } else {
                            (w[0], w[1])
                        });
                    }
                    proofs.push(proof);
                }
            }
        }
    }
    if expected.is_empty() {
        let near = std::array::from_fn(|a| center[a].clamp(cb[a], cb[a + 3]));
        let inside = (0..8).all(|i| {
            sphere_sign(
                std::array::from_fn(|a| cb[a + if i & (1 << a) == 0 { 0 } else { 3 }]),
                *center,
                *r,
            ) == Some(-1)
        });
        if (sphere_sign(near, *center, *r) == Some(1) || inside) && tris.is_empty() {
            return Ok(proofs);
        }
        return Err("sphere_missing_boundary");
    }
    let mut actual = disk(tris)?;
    expected.sort();
    actual.sort();
    if actual != expected {
        return Err("cell_boundary_correspondence");
    }
    Ok(proofs)
}

fn pos(pt: &PointTable, i: usize) -> P {
    [pt.x(i), pt.y(i), pt.z(i)]
}
fn bits(p: P) -> [u64; 3] {
    p.map(|x| if x == 0. { 0 } else { x.to_bits() })
}
fn map_box_point(p: P, b: &Bounds, cb: &Bounds) -> Result<P, &'static str> {
    if p.iter().any(|x| !x.is_finite()) {
        return Err("box_nonfinite_vertex");
    }
    let mut q = p;
    for a in 0..3 {
        let scale = 1_f64.max(p[a].abs()).max(b[a].abs()).max(b[a + 3].abs());
        // Candidate assignment only: subsequent exact chain/area predicates prove the map.
        let mut candidates = vec![b[a], b[a + 3], cb[a], cb[a + 3]];
        candidates.sort_by(f64::total_cmp);
        candidates.dedup();
        let near: Vec<_> = candidates
            .into_iter()
            .filter(|x| (*x - p[a]).abs() <= 128. * f64::EPSILON * scale)
            .collect();
        if near.len() > 1 {
            return Err("box_ambiguous_vertex_map");
        }
        if let Some(&x) = near.first() {
            q[a] = x;
        }
        if q[a] < cb[a] || q[a] > cb[a + 3] || q[a] < b[a] || q[a] > b[a + 3] {
            return Err("box_vertex_outside_target");
        }
    }
    Ok(q)
}
fn patch_bounds(b: &Bounds, cb: &Bounds, facet: usize) -> Option<Bounds> {
    let axis = facet % 3;
    let value = b[facet];
    if value <= cb[axis] || value >= cb[axis + 3] {
        return None;
    }
    let mut out = [0.; 6];
    for a in 0..3 {
        out[a] = b[a].max(cb[a]);
        out[a + 3] = b[a + 3].min(cb[a + 3]);
        if a != axis && out[a] >= out[a + 3] {
            return None;
        }
    }
    out[axis] = value;
    out[axis + 3] = value;
    Some(out)
}
fn rectangle_chain(
    boundary: &[(usize, usize)],
    mapped: &BTreeMap<usize, P>,
    rect: &Bounds,
    axis: usize,
) -> Result<(), &'static str> {
    let [u, v] = face_axes(axis);
    let mut sides: BTreeMap<(usize, usize), Vec<(f64, f64)>> = BTreeMap::new();
    for &(a, b) in boundary {
        let p = mapped[&a];
        let q = mapped[&b];
        let candidates: Vec<_> = [u, v]
            .into_iter()
            .flat_map(|k| [0, 3].map(move |side| (k, side)))
            .filter(|&(k, s)| p[k] == rect[k + s] && q[k] == rect[k + s])
            .collect();
        if candidates.len() != 1 {
            return Err("box_patch_boundary");
        }
        let (k, s) = candidates[0];
        let free = if k == u { v } else { u };
        if p[free] == q[free] {
            return Err("box_patch_collapsed_edge");
        }
        sides
            .entry((k, s))
            .or_default()
            .push((p[free].min(q[free]), p[free].max(q[free])));
    }
    if sides.len() != 4 {
        return Err("box_patch_missing_side");
    }
    for ((k, _), mut intervals) in sides {
        let free = if k == u { v } else { u };
        intervals.sort_by(|a, b| a.0.total_cmp(&b.0));
        if intervals[0].0 != rect[free]
            || intervals.last().unwrap().1 != rect[free + 3]
            || intervals.windows(2).any(|w| w[0].1 != w[1].0)
        {
            return Err("box_patch_side_coverage");
        }
    }
    Ok(())
}
fn curve_owners(
    scope: &Scope,
    features: &SfccFeatureSet,
    curve: usize,
    pair: [usize; 2],
) -> Result<(), &'static str> {
    let Scope::Cuboid {
        bounds,
        owners,
        indices,
    } = scope
    else {
        return Err("box_scope");
    };
    let curve = features.curves.get(curve).ok_or("box_curve_id")?;
    let mut matched = BTreeSet::new();
    for &sid in &curve.adjacent_strata {
        let st = features.strata.get(sid).ok_or("box_stratum_id")?;
        let (normal, offset) = st.certificate_plane().ok_or("box_curve_not_planes")?;
        let found = pair
            .iter()
            .find(|&&facet| {
                let axis = facet % 3;
                let sign = if facet < 3 { -1. } else { 1. };
                !owners[facet].is_empty()
                    && indices[facet].contains(&st.leaf_index)
                    && st.sign == 1.
                    && normal == std::array::from_fn(|a| if a == axis { sign } else { 0. })
                    && offset == -sign * bounds[facet]
            })
            .ok_or("box_curve_occurrence_owner")?;
        matched.insert(*found);
    }
    if matched.len() != 2 {
        return Err("box_curve_owner_pair");
    }
    Ok(())
}
fn canonical_parameter(
    pt: &PointTable,
    features: &SfccFeatureSet,
    faces: &[HashMap<i64, FaceRecord>; 3],
    point: usize,
    curve_id: usize,
) -> Result<Option<f64>, &'static str> {
    let mut found = None;
    for pin in faces
        .iter()
        .flat_map(|f| f.values())
        .flat_map(|f| &f.pins)
        .filter(|p| p.point_id == point && p.curve_id == curve_id)
    {
        if found.is_some_and(|t: f64| t.to_bits() != pin.t.to_bits()) {
            return Err("box_conflicting_pin_parameter");
        }
        found = Some(pin.t);
    }
    if let PointKey::Str(key) = pt.key_at(point) {
        if let Some(id) = key.strip_prefix("corner:") {
            let corner = features
                .corners
                .get(id.parse::<usize>().map_err(|_| "box_corner_key")?)
                .ok_or("box_corner_key")?;
            let end = corner
                .curve_ends
                .iter()
                .find(|(c, _)| *c == curve_id)
                .ok_or("box_corner_curve_incidence")?
                .1;
            let curve = &features.curves[curve_id];
            let t = if end == 0 { curve.t_min } else { curve.t_max };
            if found.is_some_and(|x: f64| x.to_bits() != t.to_bits()) {
                return Err("box_corner_pin_parameter");
            }
            found = Some(t);
        }
    }
    Ok(found)
}
fn root_key(
    oct: &SfccOctree,
    axis: usize,
    g: [i64; 3],
    len: i64,
    target: P,
    point: usize,
) -> Result<(i64, RootProof), &'static str> {
    let [u, v] = face_axes(axis);
    for (moving, fixed, side) in [(u, v, 0), (v, u, 1), (u, v, 1), (v, u, 0)] {
        let mut start = g;
        start[fixed] += side * len;
        let mut cuts = vec![0];
        cuts.extend(collect_edge_interior_offsets(
            |k| oct.has_sample_key(k),
            &oct.lat,
            moving,
            start[0],
            start[1],
            start[2],
            len,
        ));
        cuts.push(len);
        for w in cuts.windows(2) {
            let mut a = start;
            let mut b = start;
            a[moving] += w[0];
            b[moving] += w[1];
            let p = grid_point(&oct.lat, a)?;
            let q = grid_point(&oct.lat, b)?;
            if (0..3).all(|k| k == moving || p[k] == target[k])
                && p[moving] < target[moving]
                && target[moving] < q[moving]
            {
                return Ok((
                    super::point_table::crossing_key(
                        pack_point(&oct.lat, a[0], a[1], a[2]),
                        moving,
                    ),
                    RootProof {
                        point,
                        axis: moving,
                        start: a,
                        len: w[1] - w[0],
                    },
                ));
            }
        }
    }
    Err("box_face_endpoint_contact")
}
fn box_face(
    scope: &Scope,
    oct: &SfccOctree,
    cb: &Bounds,
    axis: usize,
    g: [i64; 3],
    len: i64,
    rec: Option<&FaceRecord>,
    pt: &PointTable,
    features: &SfccFeatureSet,
) -> Result<FaceProof, &'static str> {
    let Scope::Cuboid { bounds: b, .. } = scope else {
        return Err("box_scope");
    };
    let [u, v] = face_axes(axis);
    let lo = grid_point(&oct.lat, g)?;
    check_face_identity(rec, axis, pack_point(&oct.lat, g[0], g[1], g[2]), len)?;
    let mut end = g;
    end[u] += len;
    end[v] += len;
    let hi = grid_point(&oct.lat, end)?;
    for a in [u, v] {
        if !exact_affine_eq(lo[a], oct.lat.step, len as f64, hi[a]) {
            return Err("face_extent");
        }
    }
    if lo[axis] == b[axis] || lo[axis] == b[axis + 3] {
        return Err("box_face_coincidence");
    }
    let mut expected: Vec<(P, P, usize)> = Vec::new();
    if b[axis] < lo[axis] && lo[axis] < b[axis + 3] {
        for facet in [u, u + 3, v, v + 3] {
            let fixed = facet % 3;
            let free = if fixed == u { v } else { u };
            if b[facet] == lo[fixed] || b[facet] == hi[fixed] {
                return Err("box_face_edge_contact");
            }
            if !(lo[fixed] < b[facet] && b[facet] < hi[fixed]) {
                continue;
            }
            let l = lo[free].max(b[free]);
            let h = hi[free].min(b[free + 3]);
            if l == h {
                return Err("box_face_point_contact");
            }
            if l > h {
                continue;
            }
            let mut p = lo;
            let mut q = lo;
            p[fixed] = b[facet];
            q[fixed] = b[facet];
            p[free] = l;
            q[free] = h;
            let positive = (fixed == u) == (facet >= 3);
            expected.push(if positive {
                (p, q, facet)
            } else {
                (q, p, facet)
            });
        }
    }
    let key = pack_point(&oct.lat, g[0], g[1], g[2]);
    if expected.is_empty() {
        if rec.is_some_and(|r| !r.segments.is_empty() || !r.pins.is_empty()) {
            return Err("box_face_spurious");
        }
        return Ok(FaceProof {
            axis,
            key,
            len,
            chain: Vec::new(),
            mapped: Vec::new(),
            pins: Vec::new(),
            roots: Vec::new(),
        });
    }
    let mut target_nodes = BTreeMap::new();
    for (p, q, _) in &expected {
        for p in [*p, *q] {
            let next = target_nodes.len();
            target_nodes.entry(bits(p)).or_insert(next);
        }
    }
    let target = chain(
        &expected
            .iter()
            .map(|(p, q, _)| (target_nodes[&bits(*p)], target_nodes[&bits(*q)]))
            .collect::<Vec<_>>(),
    )?;
    let target_point = |i| {
        target_nodes
            .iter()
            .find(|(_, v)| **v == i)
            .unwrap()
            .0
            .map(f64::from_bits)
    };
    let rec = rec.ok_or("box_face_missing")?;
    let actual = chain(&rec.segments.iter().map(|s| (s.a, s.b)).collect::<Vec<_>>())?;
    if actual.len() < 2 {
        return Err("box_face_missing_arc");
    }
    let mapped: Vec<_> = actual
        .iter()
        .map(|&i| map_box_point(pos(pt, i), b, cb))
        .collect::<Result<_, _>>()?;
    if mapped[0] != target_point(target[0])
        || *mapped.last().unwrap() != target_point(*target.last().unwrap())
    {
        return Err("box_face_orientation_or_endpoints");
    }
    let mut roots = Vec::new();
    for &(i, p) in [
        (actual[0], mapped[0]),
        (*actual.last().unwrap(), *mapped.last().unwrap()),
    ]
    .iter()
    {
        let (key, root) = root_key(oct, axis, g, len, p, i)?;
        if pt.key_at(i) != &PointKey::Num(key) {
            return Err("box_face_root_identity");
        }
        roots.push(root);
    }
    let mut intervals: Vec<Vec<(f64, f64)>> = vec![Vec::new(); expected.len()];
    for pair in mapped.windows(2) {
        let mut found = None;
        for (j, (p, q, facet)) in expected.iter().enumerate() {
            let free = if facet % 3 == u { v } else { u };
            if (0..3).all(|a| a == free || (pair[0][a] == p[a] && pair[1][a] == p[a]))
                && pair
                    .iter()
                    .all(|x| x[free] >= p[free].min(q[free]) && x[free] <= p[free].max(q[free]))
                && (pair[1][free] - pair[0][free]) * (q[free] - p[free]) > 0.
            {
                if found.is_some() {
                    return Err("box_face_ambiguous_piece");
                }
                found = Some((j, free));
            }
        }
        let (j, free) = found.ok_or("box_face_piece_order")?;
        intervals[j].push((
            pair[0][free].min(pair[1][free]),
            pair[0][free].max(pair[1][free]),
        ));
    }
    for (j, list) in intervals.iter_mut().enumerate() {
        let (p, q, facet) = expected[j];
        let free = if facet % 3 == u { v } else { u };
        list.sort_by(|a, b| a.0.total_cmp(&b.0));
        if list.is_empty()
            || list[0].0 != p[free].min(q[free])
            || list.last().unwrap().1 != p[free].max(q[free])
            || list.windows(2).any(|w| w[0].1 != w[1].0)
        {
            return Err("box_face_incomplete_piece");
        }
    }
    for &node in target.iter().skip(1).take(target.len().saturating_sub(2)) {
        let p = target_point(node);
        let idx = mapped
            .iter()
            .position(|v| *v == p)
            .ok_or("box_face_missing_crease")?;
        let incident: Vec<_> = expected
            .iter()
            .filter(|(a, b, _)| *a == p || *b == p)
            .map(|x| x.2)
            .collect();
        if incident.len() != 2 {
            return Err("box_face_crease_incidence");
        }
        let pin = rec
            .pins
            .iter()
            .find(|pin| pin.point_id == actual[idx])
            .ok_or("box_face_unpinned_crease")?;
        curve_owners(scope, features, pin.curve_id, [incident[0], incident[1]])?;
        let evaluated = features.curves[pin.curve_id]
            .point_at_checked(pin.t)
            .ok_or("box_pin_parameter")?;
        if bits(evaluated) != bits(pos(pt, pin.point_id)) {
            return Err("box_pin_parameter_payload");
        }
    }
    if rec.pins.len() != target.len().saturating_sub(2) {
        return Err("box_face_spurious_pin");
    }
    let mut pins = rec
        .pins
        .iter()
        .map(|p| (p.point_id, p.curve_id, p.t.to_bits()))
        .collect::<Vec<_>>();
    pins.sort();
    Ok(FaceProof {
        axis,
        key,
        len,
        chain: actual,
        mapped: mapped.into_iter().map(bits).collect(),
        pins,
        roots,
    })
}
fn verify_box(
    scope: &Scope,
    oct: &SfccOctree,
    c: &SfccCell,
    faces: &[HashMap<i64, FaceRecord>; 3],
    pt: &PointTable,
    tris: &[usize],
    features: Option<&SfccFeatureSet>,
) -> Result<Vec<FaceProof>, &'static str> {
    let Scope::Cuboid { bounds: b, .. } = scope else {
        return Err("box_scope");
    };
    let features = features.ok_or("box_features_absent")?;
    let cb = cell_box(&oct.lat, c)?;
    if (0..3).any(|a| {
        [cb[a], cb[a + 3]]
            .iter()
            .any(|x| *x == b[a] || *x == b[a + 3])
    }) {
        return Err("box_cell_contact");
    }
    let patches: Vec<_> = (0..6)
        .filter_map(|f| patch_bounds(b, &cb, f).map(|r| (f, r)))
        .collect();
    let mut target_points: BTreeMap<[u64; 3], usize> = BTreeMap::new();
    let mut target_tris = Vec::new();
    for &(facet, rect) in &patches {
        let [u, v] = face_axes(facet % 3);
        let mut corners = Vec::new();
        for (su, sv) in [(0, 0), (3, 0), (3, 3), (0, 3)] {
            let mut p = [rect[0], rect[1], rect[2]];
            p[u] = rect[u + su];
            p[v] = rect[v + sv];
            let next = target_points.len();
            corners.push(*target_points.entry(bits(p)).or_insert(next));
        }
        for mut t in [
            [corners[0], corners[1], corners[2]],
            [corners[0], corners[2], corners[3]],
        ] {
            if facet < 3 {
                t.swap(1, 2);
            }
            target_tris.extend(t);
        }
    }
    if patches.is_empty() {
        if tris.is_empty() {
            return Ok(Vec::new());
        }
        return Err("box_spurious_fill");
    }
    disk(&target_tris).map_err(|_| "box_target_not_disk")?;
    let actual_boundary = disk(tris)?;
    let mapped: BTreeMap<_, _> = tris
        .iter()
        .map(|&i| Ok((i, map_box_point(pos(pt, i), b, &cb)?)))
        .collect::<Result<_, &'static str>>()?;
    let mut patch_tris: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for t in tris.chunks_exact(3) {
        let candidates: Vec<_> = patches
            .iter()
            .filter(|(f, _)| t.iter().all(|i| mapped[i][f % 3] == b[*f]))
            .collect();
        if candidates.len() != 1 {
            return Err("box_triangle_patch_owner");
        }
        let (f, _) = *candidates[0];
        let [u, v] = face_axes(f % 3);
        let sign = super::predicates::orient2d(
            [mapped[&t[0]][u], mapped[&t[0]][v]],
            [mapped[&t[1]][u], mapped[&t[1]][v]],
            [mapped[&t[2]][u], mapped[&t[2]][v]],
        );
        if sign != if f < 3 { -1 } else { 1 } {
            return Err("box_patch_orientation");
        }
        patch_tris.entry(f).or_default().extend(t);
    }
    let owned_edges = triangle_edges(
        &tris
            .chunks_exact(3)
            .map(|t| [t[0], t[1], t[2]])
            .collect::<Vec<_>>(),
    );
    for ((a, bid), memberships) in pt
        .identified_edges()
        .filter(|(e, _)| owned_edges.contains(e))
    {
        let p = mapped[&a];
        let q = mapped[&bid];
        let facets = (0..6)
            .filter(|&f| p[f % 3] == b[f] && q[f % 3] == b[f])
            .collect::<Vec<_>>();
        if facets.len() != 2 {
            return Err("box_spurious_crease_membership");
        }
        let mut curves = BTreeSet::new();
        for m in memberships {
            if !curves.insert(m.curve_id) {
                return Err("box_duplicate_crease_membership");
            }
            curve_owners(scope, features, m.curve_id, [facets[0], facets[1]])?;
        }
    }
    let mut creases: BTreeMap<(usize, usize), Vec<(f64, f64, usize, f64, f64)>> = BTreeMap::new();
    for &(facet, rect) in &patches {
        let boundary = disk(patch_tris.get(&facet).ok_or("box_patch_missing")?)?;
        rectangle_chain(&boundary, &mapped, &rect, facet % 3)?;
        for &(a, bid) in &boundary {
            let p = mapped[&a];
            let q = mapped[&bid];
            let other =
                (0..6).find(|&f| f % 3 != facet % 3 && p[f % 3] == b[f] && q[f % 3] == b[f]);
            if let Some(other) = other {
                let pair = [facet.min(other), facet.max(other)];
                if facet != pair[0] {
                    continue;
                }
                let free = (0..3).find(|a| *a != facet % 3 && *a != other % 3).unwrap();
                let options = pt.curve_intervals(a, bid);
                let mut matched = None;
                for interval in options {
                    if curve_owners(scope, features, interval.curve_id, pair).is_err() {
                        continue;
                    }
                    let planes = pair.map(|f| {
                        let sign = if f < 3 { -1. } else { 1. };
                        (
                            std::array::from_fn(|a| if a == f % 3 { sign } else { 0. }),
                            -sign * b[f],
                        )
                    });
                    let direction = features.curves[interval.curve_id]
                        .straight_parameter_direction(free, planes)
                        .ok_or("box_crease_not_monotone")?;
                    let curve = &features.curves[interval.curve_id];
                    for (point, t, mapped) in [(a, interval.start, p), (bid, interval.end, q)] {
                        let event =
                            canonical_parameter(pt, features, faces, point, interval.curve_id)?;
                        if event.is_some_and(|expected| expected.to_bits() != t.to_bits()) {
                            return Err("box_noncanonical_crease_endpoint");
                        }
                        let boundary = (0..3).any(|k| mapped[k] == cb[k] || mapped[k] == cb[k + 3]);
                        let corner = (0..3).all(|k| mapped[k] == b[k] || mapped[k] == b[k + 3]);
                        if (boundary || corner) && event.is_none() {
                            return Err("box_crease_event_missing");
                        }
                    }
                    if interval.start.min(interval.end) < curve.t_min
                        || interval.start.max(interval.end) > curve.t_max
                    {
                        return Err("box_interval_domain");
                    }
                    let from = map_box_point(
                        curve
                            .point_at_checked(interval.start)
                            .ok_or("box_interval_start")?,
                        b,
                        &cb,
                    )?;
                    let to = map_box_point(
                        curve
                            .point_at_checked(interval.end)
                            .ok_or("box_interval_end")?,
                        b,
                        &cb,
                    )?;
                    if from != p || to != q {
                        return Err("box_crease_parameter_payload");
                    }
                    if interval.start == interval.end
                        || ((interval.end > interval.start) == (direction > 0))
                            != (q[free] > p[free])
                    {
                        return Err("box_crease_parameter_orientation");
                    }
                    // Every recorded membership must preserve the map, even
                    // when an earlier interval already supplied this chain.
                    matched.get_or_insert(interval);
                }
                let interval = matched.ok_or("box_crease_missing_membership")?;
                let (l, h, s, e) = if p[free] < q[free] {
                    (p[free], q[free], interval.start, interval.end)
                } else {
                    (q[free], p[free], interval.end, interval.start)
                };
                creases.entry((pair[0], pair[1])).or_default().push((
                    l,
                    h,
                    interval.curve_id,
                    s,
                    e,
                ));
            }
        }
    }
    for ((a, b), mut edges) in creases {
        let free = (0..3).find(|i| *i != a % 3 && *i != b % 3).unwrap();
        edges.sort_by(|a, b| a.0.total_cmp(&b.0));
        if edges[0].0 != cb[free].max(bnd(scope, free))
            || edges.last().unwrap().1 != cb[free + 3].min(bnd(scope, free + 3))
            || edges
                .windows(2)
                .any(|w| w[0].1 != w[1].0 || w[0].2 != w[1].2 || w[0].4 != w[1].3)
        {
            return Err("box_crease_interval_coverage");
        }
    }
    let stride = stride_at_level(&oct.lat, c.level);
    let base = [c.ix * stride, c.iy * stride, c.iz * stride];
    let mut proofs = Vec::new();
    let mut expected_boundary = Vec::new();
    for axis in 0..3 {
        let [u, v] = face_axes(axis);
        for side in 0..2 {
            let mut n = [c.ix, c.iy, c.iz];
            n[axis] += if side == 1 { 1 } else { -1 };
            let finer = oct.is_internal(c.level as i64, n[0], n[1], n[2]);
            let len = if finer { stride / 2 } else { stride };
            if len < 1 {
                return Err("face_balance");
            }
            for i in 0..if finer { 2 } else { 1 } {
                for j in 0..if finer { 2 } else { 1 } {
                    let mut g = base;
                    g[axis] += side * stride;
                    g[u] += i * len;
                    g[v] += j * len;
                    let key = pack_point(&oct.lat, g[0], g[1], g[2]);
                    let rec = faces[axis].get(&key);
                    let proof = box_face(scope, oct, &cb, axis, g, len, rec, pt, features)?;
                    for w in proof.chain.windows(2) {
                        expected_boundary.push(if side == 1 {
                            (w[1], w[0])
                        } else {
                            (w[0], w[1])
                        });
                    }
                    proofs.push(proof);
                }
            }
        }
    }
    let mut actual = actual_boundary;
    actual.sort();
    expected_boundary.sort();
    if actual != expected_boundary {
        return Err("box_boundary_correspondence");
    }
    Ok(proofs)
}
fn bnd(scope: &Scope, a: usize) -> f64 {
    match scope {
        Scope::Cuboid { bounds, .. } => bounds[a],
        _ => unreachable!(),
    }
}

#[cfg(all(test, feature = "serde"))]
mod tests {
    use super::*;
    fn root_cell() -> SfccCell {
        SfccCell {
            level: 0,
            ix: 0,
            iy: 0,
            iz: 0,
            key: 0,
            degenerate: false,
            feature_curve: -1,
            feature_corner: -1,
        }
    }
    #[test]
    fn exact_arithmetic_and_grid_do_not_equate_rounded_formulas() {
        assert!(!exact_affine_eq(1., 2_f64.powi(-54), 1., 1.));
        let mut lat = crate::math::grid::make_lattice(2, 0., 0., 0., 1.);
        lat.span += 1;
        assert_eq!(grid_point(&lat, [0; 3]), Err("grid_scope"));
    }
    #[test]
    fn worker_recheck_cannot_promote_an_inexact_grid_to_excluded() {
        let tree = crate::sdf::leaf_at(Shape::Sphere { r: 1. }, [0.; 3]);
        let lat = crate::math::grid::make_lattice(2, 1., 1., 1., 2_f64.powi(-54));
        let tol = crate::tolerances::resolve_tolerances(&crate::tuning::SfccTuning::default(), 2.);
        let (features, _) = super::super::feature_set::compile_feature_set(&tree, &tol);
        let mut points = PointTable::new();
        // Model an incoming success claim whose actual coordinates fail recheck.
        points.coverage.push(Witness {
            transported: false,
            cell: root_cell(),
            reason: None,
            triangles: Vec::new(),
            vertices: Vec::new(),
            faces: Vec::new(),
            curves: Vec::new(),
        });
        reverify_transport(&mut points, &tree, &features, &lat, &[], &HashMap::new());
        assert_eq!(points.coverage[0].reason.as_deref(), Some("grid_not_exact"));
        let result = report(&tree, &points);
        assert_eq!((result.certified_cells, result.excluded_cells, result.outside_cells), (0, 0, 1));
        assert!(failed_cells(&points).is_empty(), "outside grid is not a mesher failure");
    }
    #[test]
    fn direct_cell_and_even_zero_free_face_records_require_canonical_identity() {
        let tree = crate::sdf::leaf_at(Shape::Sphere { r: 1. }, [0.; 3]);
        let lat = crate::math::grid::make_lattice(2, 2., 2., 2., 1.);
        let mut wrong_cell = root_cell();
        wrong_cell.key = 1;
        assert_eq!(cell_box(&lat, &wrong_cell), Err("cell_identity"));
        let oct = super::super::octree::rebuild_octree_from_leaves(&tree, &lat, vec![root_cell()]);
        let mut rec = FaceRecord {
            axis: 0, key: 0, len: lat.res, segments: Vec::new(), pins: Vec::new(),
            consumed_fwd: Vec::new(), consumed_rev: Vec::new(),
        };
        let points = PointTable::new();
        assert!(sphere_face(&Scope::new(&tree), &oct, 0, [0; 3], lat.res, Some(&rec), &points).is_ok());
        for (axis, key, len) in [(1, 0, lat.res), (0, 1, lat.res), (0, 0, lat.res / 2)] {
            rec.axis = axis;
            rec.key = key;
            rec.len = len;
            assert_eq!(sphere_face(&Scope::new(&tree), &oct, 0, [0; 3], lat.res, Some(&rec), &points).unwrap_err(), "face_identity");
        }
    }
    #[test]
    fn sphere_hidden_face_loop_double_root_contact_and_internal_component_are_unresolved() {
        let lat = crate::math::grid::make_lattice(2, 0., 0., 0., 1.);
        for (center, r, axis, reason) in [
            ([0., 0.5, 0.5], 0.125, 0, "sphere_face_hidden_loop"),
            ([0.5, 0., 0.], 0.125, 2, "sphere_edge_multiple"),
            ([0., 0., 0.], 1., 2, "sphere_edge_contact"),
        ] {
            let tree = crate::sdf::leaf_at(Shape::Sphere { r }, center);
            let oct =
                super::super::octree::rebuild_octree_from_leaves(&tree, &lat, vec![root_cell()]);
            assert_eq!(
                sphere_face(
                    &Scope::new(&tree),
                    &oct,
                    axis,
                    [0; 3],
                    lat.res,
                    None,
                    &PointTable::new()
                )
                .unwrap_err(),
                reason
            );
        }
        let tree = crate::sdf::leaf_at(Shape::Sphere { r: 0.125 }, [0.5; 3]);
        let oct = super::super::octree::rebuild_octree_from_leaves(&tree, &lat, vec![root_cell()]);
        assert_eq!(
            verify(
                &Scope::new(&tree),
                &oct,
                &root_cell(),
                &std::array::from_fn(|_| HashMap::new()),
                &PointTable::new(),
                &[],
                None
            )
            .unwrap_err(),
            "sphere_internal_component"
        );
    }
    #[test]
    fn cuboid_belt_cannot_use_a_disk_certificate() {
        let tree = crate::sdf::leaf_at(
            Shape::Cuboid {
                half: [1., 1., 10.],
            },
            [0.; 3],
        );
        let lat = crate::math::grid::make_lattice(2, -2., -2., -2., 4.);
        let oct = super::super::octree::rebuild_octree_from_leaves(&tree, &lat, vec![root_cell()]);
        let tol = crate::tolerances::resolve_tolerances(&crate::tuning::SfccTuning::default(), 20.);
        let (features, _) = super::super::feature_set::compile_feature_set(&tree, &tol);
        assert_eq!(
            verify(
                &Scope::new(&tree),
                &oct,
                &root_cell(),
                &std::array::from_fn(|_| HashMap::new()),
                &PointTable::new(),
                &[],
                Some(&features)
            )
            .unwrap_err(),
            "box_target_not_disk"
        );
    }
    #[test]
    fn disk_plus_disconnected_torus_is_rejected() {
        let mut tris = vec![0, 1, 2];
        let at = |x: usize, y: usize| 3 + (y % 3) * 3 + x % 3;
        for y in 0..3 {
            for x in 0..3 {
                tris.extend([
                    at(x, y),
                    at(x + 1, y),
                    at(x + 1, y + 1),
                    at(x, y),
                    at(x + 1, y + 1),
                    at(x, y + 1),
                ]);
            }
        }
        assert_eq!(disk(&tris), Err("disk_disconnected"));
    }
    #[test]
    fn original_signed_zero_sheets_and_duplicate_events_are_preserved() {
        let a = crate::sdf::leaf_at(Shape::Cuboid { half: [1.; 3] }, [0.; 3]);
        let lat = crate::math::grid::make_lattice(2, 0.5, 0.2, 0.2, 1.);
        let probe = super::super::refine_criteria::make_probe(
            &lat,
            &a,
            |x, y, z| a.f(point_to_world(&lat, x, y, z)),
            0,
            0,
            0,
            0,
        );
        let same = crate::sdf::union(vec![a.clone(), a.clone()]);
        assert!(matches!(
            box_edges(&same, &probe.pts),
            BoxEdgeCheck::Resolved
        ));
        let zero = crate::sdf::subtract(a.clone(), a);
        assert!(matches!(
            box_edges(&zero, &probe.pts),
            BoxEdgeCheck::NeedsSplit
        ));
        let contact_lat = crate::math::grid::make_lattice(2, 1., 0.2, 0.2, 0.5);
        let contact = super::super::refine_criteria::make_probe(
            &contact_lat,
            &zero,
            |x, y, z| zero.f(point_to_world(&contact_lat, x, y, z)),
            0,
            0,
            0,
            0,
        );
        assert!(matches!(
            box_edges(&zero, &contact.pts),
            BoxEdgeCheck::NeedsSplit
        ));
    }
    #[test]
    fn event_budget_counts_unique_filtered_events_not_occurrences() {
        let a = crate::sdf::leaf_at(Shape::Cuboid { half: [1.; 3] }, [0.; 3]);
        let same = crate::sdf::union(vec![a; 1024]);
        let boxes = Boxes::new(&same).unwrap();
        assert!(boxes
            .edge_failure([0.5, 0.2, 0.2], [1.5, 0.2, 0.2])
            .is_none());
        let many = crate::sdf::union(
            (0..128)
                .map(|i| {
                    crate::sdf::leaf_at(
                        Shape::Cuboid {
                            half: [1. / 1024., 1., 1.],
                        },
                        [i as f64 / 128., 0., 0.],
                    )
                })
                .collect(),
        );
        assert!(matches!(
            Boxes::new(&many)
                .unwrap()
                .edge_failure([-0.1, 0., 0.], [1.1, 0., 0.]),
            Some(EdgeFailureKind::Budget)
        ));
    }
    #[test]
    fn more_than_twelve_original_box_occurrences_keep_multiple_edge_events() {
        let three=crate::scene_bridge::build_csg_tree_from_json(r#"{"kind":"union","children":[{"kind":"box","pos":[-1.875,0,0],"half":[2.125,4,4]},{"kind":"intersect","lh":{"kind":"box","pos":[2.25,0,0],"half":[1.75,4,4]},"rh":{"kind":"box","pos":[-1.625,0,0],"half":[2.375,4,4]}}]}"#).unwrap();
        let mut children = vec![three];
        children.extend(
            (0..13).map(|_| crate::sdf::leaf_at(Shape::Cuboid { half: [0.125; 3] }, [-2., 0., 0.])),
        );
        let tree = crate::sdf::union(children);
        assert_eq!(tree.leaf_count(), 16);
        let lat = crate::math::grid::make_lattice(2, 0., 0., 0., 1.);
        let view = tree.prune_to_box([0.5; 3], [0.5; 3]);
        let probe = super::super::refine_criteria::make_probe(
            &lat,
            &view,
            |x, y, z| view.f(point_to_world(&lat, x, y, z)),
            0,
            0,
            0,
            0,
        );
        assert_eq!(
            super::super::refine_criteria::discovery_guard(&tree, &probe),
            super::super::refine_criteria::DiscoveryCheck::NeedsSplit
        );
    }
    #[test]
    fn atomic_face_interior_edges_are_checked_when_outer_cell_edges_are_empty() {
        let tree = crate::sdf::union(vec![
            crate::sdf::leaf_at(
                Shape::Cuboid {
                    half: [0.0625, 0.125, 1.5],
                },
                [0.1875, 0.5, 0.],
            ),
            crate::sdf::leaf_at(
                Shape::Cuboid {
                    half: [0.125, 0.125, 1.5],
                },
                [0.625, 0.5, 0.],
            ),
        ]);
        let lat = crate::math::grid::make_lattice(3, -2., -2., -2., 4.);
        let cell = |level, ix, iy, iz| SfccCell {
            level,
            ix,
            iy,
            iz,
            key: crate::math::grid::cell_key(&lat, level, ix, iy, iz),
            degenerate: false,
            feature_curve: -1,
            feature_corner: -1,
        };
        let coarse = cell(2, 2, 2, 2);
        let mut leaves = vec![coarse];
        for x in 4..6 {
            for y in 4..6 {
                leaves.push(cell(3, x, y, 6));
            }
        }
        let oct = super::super::octree::rebuild_octree_from_leaves(&tree, &lat, leaves);
        let probe = super::super::refine_criteria::make_probe(
            &lat,
            &tree,
            |x, y, z| tree.f(point_to_world(&lat, x, y, z)),
            2,
            2,
            2,
            2,
        );
        assert!(matches!(
            box_edges(&tree, &probe.pts),
            BoxEdgeCheck::Resolved
        ));
        assert!(matches!(
            AtomicBoxGuard::new(&tree).unwrap().inspect(&oct, &coarse),
            Some(EdgeFailureKind::NotSingle)
        ));
    }
    #[test]
    fn cleanup_addition_using_only_boundary_vertices_withdraws_certificate() {
        let mut pt = PointTable::new();
        let tris = vec![
            pt.add(0., 0., 0., 0., 0., 1.),
            pt.add(1., 0., 0., 0., 0., 1.),
            pt.add(0., 1., 0., 0., 0., 1.),
        ];
        let vertices = tris
            .iter()
            .map(|&i| (i, pt.key_at(i).clone(), payload(&pt, i)))
            .collect();
        pt.coverage.push(Witness {
            transported: false,
            cell: root_cell(),
            reason: None,
            triangles: vec![[0, 1, 2]],
            vertices,
            faces: vec![FaceProof {
                axis: 0,
                key: 0,
                len: 1,
                chain: tris.clone(),
                mapped: Vec::new(),
                pins: Vec::new(),
                roots: Vec::new(),
            }],
            curves: Vec::new(),
        });
        finish(&mut pt, &tris, &[0, 1, 2, 0, 2, 1]);
        assert_eq!(
            pt.coverage[0].reason.as_deref(),
            Some("cleanup_changed_owned_complex")
        );
        pt.coverage[0].reason = None;
        pt.protect_curve_edge(
            0,
            1,
            super::super::point_table::CurveInterval {
                curve_id: 0,
                start: 0.,
                end: 1.,
            },
        );
        finish(&mut pt, &tris, &tris);
        assert_eq!(
            pt.coverage[0].reason.as_deref(),
            Some("cleanup_changed_owned_complex")
        );
    }
    #[test]
    fn traced_parameter_chart_rejects_declared_clamped_tails() {
        let ident = |id| crate::strata::StratumIdentity {
            id,
            owner_node_id: -1,
            leaf_index: 0,
            local_index: id,
            sign: 1.,
        };
        let a = crate::strata::Stratum::plane(ident(0), 0., 1., 0., 0.);
        let b = crate::strata::Stratum::plane(ident(1), 0., 0., 1., 0.);
        let mut curve = super::super::feature_curves::make_traced_curve(
            0,
            [0, 1],
            vec![0., 0., 0., 1., 0., 0.],
            false,
            a,
            b,
            super::super::feature_curves::TracedRefine {
                curve_eps: 1e-12,
                min_cross: 1e-3,
                max_displacement: 1.,
            },
            -1,
        );
        let planes = [([0., 1., 0.], 0.), ([0., 0., 1.], 0.)];
        assert_eq!(curve.straight_parameter_direction(0, planes), Some(1));
        curve.t_max = 2.;
        assert_eq!(curve.straight_parameter_direction(0, planes), None);
        let off_plane = super::super::feature_curves::make_traced_curve(
            0,
            [0, 1],
            vec![0., 1e-15, 0., 1., 0., 0.],
            false,
            crate::strata::Stratum::plane(ident(0), 0., 1., 0., 0.),
            crate::strata::Stratum::plane(ident(1), 0., 0., 1., 0.),
            super::super::feature_curves::TracedRefine {
                curve_eps: 1e-12,
                min_cross: 1e-3,
                max_displacement: 1.,
            },
            -1,
        );
        assert_eq!(off_plane.straight_parameter_direction(0, planes), None);
    }
    #[test]
    #[should_panic(expected = "duplicate certified cell ownership")]
    fn duplicate_worker_ownership_is_rejected() {
        let tree = crate::scene_bridge::build_csg_tree_from_json(
            r#"{"kind":"box","pos":[0,0,0],"half":[1,1,1]}"#,
        )
        .unwrap();
        let cube = super::super::pipeline::SfccWorldCube {
            min_x: -4.,
            min_y: -4.,
            min_z: -4.,
            size: 8.,
        };
        let tuning = super::super::pipeline::PipelineTuning::default();
        let bytes = super::super::worker::prepare(&tree, &cube, &tuning);
        let part = super::super::worker::mesh_partition(&tree, &cube, &tuning, &bytes, 0, 1);
        super::super::worker::merge(&tree, &cube, &tuning, &[part.clone(), part]);
    }
    fn actual(scene: &str, origin: f64, size: f64, n: usize) {
        let tree = crate::scene_bridge::build_csg_tree_from_json(scene).unwrap();
        let tuning = super::super::pipeline::PipelineTuning::default();
        let cube = super::super::pipeline::SfccWorldCube {
            min_x: origin,
            min_y: origin,
            min_z: origin,
            size,
        };
        let ctx = super::super::pipeline::build_pipeline_context(&tree, &cube, &tuning);
        let oct = ctx.build_tagged_octree(&tuning);
        let mut pt = PointTable::new();
        let mut faces = super::super::face_contour::contour_all_faces(
            &oct,
            &tree,
            &mut pt,
            &super::super::face_contour::FaceContourOptions {
                root_tol: 0.001 * oct.lat.step,
                features: Some(&ctx.features),
                recovery_cull: true,
            },
        );
        let opts = super::super::cell_mesh::CellMeshOptions {
            surface_tol: 0.01,
            interior_vertex_mode: super::super::cell_mesh::InteriorVertexMode::Project,
            quality_triangulation: false,
            project_max_iters: 8,
            curve_chord_tol: 0.02,
            max_polyline_points_per_cell: 16,
            features: Some(&ctx.features),
        };
        let cm =
            super::super::cell_mesh::mesh_all_cells(&oct, &mut faces.faces, &tree, &mut pt, &opts);
        let mut reasons = BTreeMap::new();
        for w in &pt.coverage {
            if let Some(r) = &w.reason {
                *reasons.entry(r).or_insert(0) += 1;
            }
        }
        eprintln!("certificate reasons {reasons:?}");
        assert_eq!(pt.coverage.len(), n);
        assert!(reasons.is_empty());
        assert!(cm.failed_cells.is_empty());
        let (out, _, _) = super::super::assembly::finish(
            &tree,
            &ctx.features,
            &mut pt,
            &cm.tris,
            oct.lat.step,
            &tuning,
            None,
        );
        assert_eq!(out.len(), cm.tris.len());
        assert!(
            pt.coverage.iter().all(|w| w.reason.is_none()),
            "{:?}",
            report(&tree, &pt)
        );
        let prepared = super::super::worker::prepare(&tree, &cube, &tuning);
        for count in [1, 2] {
            let parts = (0..count)
                .map(|i| {
                    super::super::worker::mesh_partition(&tree, &cube, &tuning, &prepared, i, count)
                })
                .collect::<Vec<_>>();
            for parts in [parts.clone(), parts.into_iter().rev().collect()] {
                let result = super::super::worker::merge_partials(
                    &tree,
                    &ctx.features,
                    &oct.lat,
                    &tuning,
                    &parts,
                );
                assert!(!result.serial_recovery);
                assert_eq!(result.validation.local_coverage.certified_cells, n);
                assert!(
                    result.validation.local_coverage.unresolved.is_empty(),
                    "{:?}",
                    result.validation.local_coverage
                );
                assert!(result.ok, "{:?}", result.validation);
            }
        }
        // The wire may omit a snapshot; the master must reconstruct all premises
        // before cleanup, including memberships on the genuine box creases.
        let expected_snapshots: Vec<_> = pt.coverage.iter()
            .map(|w| (w.vertices.clone(), w.curves.clone())).collect();
        for w in &mut pt.coverage {
            w.vertices.clear();
            w.curves.clear();
        }
        let mut face_uses = HashMap::new();
        for rec in faces.faces.iter().flat_map(|m| m.values()) {
            for (i, edge) in rec.segments.iter().enumerate() {
                face_uses.insert((rec.axis as u64, rec.key, rec.len, edge.a, edge.b),
                    (rec.consumed_fwd[i] as u64, rec.consumed_rev[i] as u64));
            }
        }
        reverify_transport(&mut pt, &tree, &ctx.features, &oct.lat, &cm.tris, &face_uses);
        assert!(pt.coverage.iter().all(|w| w.reason.is_none()));
        for (w, (vertices, curves)) in pt.coverage.iter().zip(expected_snapshots) {
            assert_eq!(w.vertices, vertices);
            let canonical = |memberships: &[(usize, usize, super::super::point_table::CurveInterval)]| {
                let mut rows = memberships.iter().map(|(a, b, c)|
                    (*a, *b, c.curve_id, c.start.to_bits(), c.end.to_bits())).collect::<Vec<_>>();
                rows.sort();
                rows
            };
            assert_eq!(canonical(&w.curves), canonical(&curves));
        }
        let changed = pt.coverage[0].vertices[0].0;
        pt.set_normal(changed, pt.nx(changed) + 1., pt.ny(changed), pt.nz(changed));
        finish(&mut pt, &cm.tris, &cm.tris);
        assert_eq!(pt.coverage[0].reason.as_deref(), Some("cleanup_changed_owned_complex"));
        if matches!(Scope::new(&tree), Scope::Cuboid { .. }) {
            let owner = pt.coverage.iter().find(|w| !w.curves.is_empty()).unwrap();
            let cell = owner.cell;
            let triangles: Vec<_> = owner.triangles.iter().flatten().copied().collect();
            let (a, b, mut extra) = owner.curves[0];
            extra.end = extra.end.next_up();
            pt.protect_curve_edge(a, b, extra);
            assert_eq!(verify(&Scope::new(&tree), &oct, &cell, &faces.faces, &pt, &triangles,
                Some(&ctx.features)).unwrap_err(), "box_duplicate_crease_membership");
        }
    }
    #[test]
    fn default_box_cleanup_preserves_cells_through_checked_flips() {
        let tree = crate::scene_bridge::build_csg_tree_from_json(
            r#"{"kind":"box","pos":[0,0,0],"half":[3,3,3]}"#,
        )
        .unwrap();
        let tuning = super::super::pipeline::PipelineTuning::default();
        let cube = super::super::pipeline::SfccWorldCube {
            min_x: -10.,
            min_y: -10.,
            min_z: -10.,
            size: 20.,
        };
        let ctx = super::super::pipeline::build_pipeline_context(&tree, &cube, &tuning);
        let oct = ctx.build_tagged_octree(&tuning);
        let mut pt = PointTable::new();
        let mut faces = super::super::face_contour::contour_all_faces(
            &oct,
            &tree,
            &mut pt,
            &super::super::face_contour::FaceContourOptions {
                root_tol: 0.001 * oct.lat.step,
                features: Some(&ctx.features),
                recovery_cull: true,
            },
        );
        let opts = super::super::cell_mesh::CellMeshOptions {
            surface_tol: 0.01,
            interior_vertex_mode: super::super::cell_mesh::InteriorVertexMode::Project,
            quality_triangulation: false,
            project_max_iters: 8,
            curve_chord_tol: 0.02,
            max_polyline_points_per_cell: 16,
            features: Some(&ctx.features),
        };
        let cm =
            super::super::cell_mesh::mesh_all_cells(&oct, &mut faces.faces, &tree, &mut pt, &opts);
        assert_eq!(pt.coverage.len(), 386);
        assert!(pt.coverage.iter().all(|w| w.reason.is_none()));
        let mut owners: BTreeMap<usize, BTreeSet<usize>> = BTreeMap::new();
        for (i, w) in pt.coverage.iter().enumerate() {
            for &v in w.triangles.iter().flatten() {
                owners.entry(v).or_default().insert(i);
            }
        }
        let before = cm
            .tris
            .chunks_exact(3)
            .map(|t| canonical_triangle([t[0], t[1], t[2]]))
            .collect::<BTreeSet<_>>();
        let ordered = pt.ordered_triangles(&cm.tris);
        let (_, _, transport) = flip_with_transport(&pt, &ordered, 4);
        let quad = transport.as_ref().unwrap().steps[0];
        let owner = |triangle: [usize; 3]| {
            owners[&triangle[0]]
                .iter()
                .find(|i| owners[&triangle[1]].contains(i) && owners[&triangle[2]].contains(i))
                .copied()
                .unwrap()
        };
        let a = owner([quad[0], quad[1], quad[2]]);
        let b = owner([quad[1], quad[0], quad[3]]);
        assert_ne!(a, b);
        let interface = pt.coverage[a]
            .faces
            .iter()
            .find(|f| {
                f.chain
                    .windows(2)
                    .any(|w| w == [quad[0], quad[1]] || w == [quad[1], quad[0]])
            })
            .unwrap();
        let patch = quad.map(|i| pos(&pt, i));
        eprintln!(
            "reduced flip: cells={:?}/{:?} face=({},{},{}) points={patch:?}",
            id(&pt.coverage[a].cell),
            id(&pt.coverage[b].cell),
            interface.axis,
            interface.key,
            interface.len
        );
        if let Ok(dir) = std::env::var("SFCC_COVERAGE_B_DIR") {
            std::fs::create_dir_all(&dir).unwrap();
            let data = serde_json::json!({"cells":[id(&pt.coverage[a].cell),id(&pt.coverage[b].cell)],
                "face":[interface.axis as i64,interface.key,interface.len],"pointIds":quad,"points":patch,
                "pointBits":patch.map(|p|p.map(|v|format!("{:016x}",v.to_bits()))),
                "old":[[0,1,2],[1,0,3]],"new":[[2,0,3],[3,1,2]]});
            std::fs::write(
                format!("{dir}/default-box-flip-witness.json"),
                serde_json::to_string_pretty(&data).unwrap() + "\n",
            )
            .unwrap();
        }
        let (out, _, _) = super::super::assembly::finish(
            &tree,
            &ctx.features,
            &mut pt,
            &cm.tris,
            oct.lat.step,
            &tuning,
            None,
        );
        let mut added = 0;
        let mut crossed = 0;
        for t in out.chunks_exact(3) {
            if before.contains(&canonical_triangle([t[0], t[1], t[2]])) {
                continue;
            }
            added += 1;
            if !owners[&t[0]]
                .iter()
                .any(|i| owners[&t[1]].contains(i) && owners[&t[2]].contains(i))
            {
                crossed += 1;
            }
        }
        let result = report(&tree, &pt);
        eprintln!(
            "default box cleanup: added={added}, cross-cell={crossed}, certified={}, withdrawn={}",
            result.certified_cells,
            result.unresolved.len()
        );
        assert!(crossed > 0);
        assert_eq!(result.unresolved.len(), 0);
        assert_eq!(result.certified_cells, 386);
        assert_eq!(result.transported_cells, 220);
        // A later unproved deletion does not acquire proof from the valid flip journal.
        let mut deleted = out.clone();
        deleted.truncate(deleted.len() - 3);
        finish_with_transport(&mut pt, &cm.tris, &deleted, transport.as_ref());
        assert!(!report(&tree, &pt).unresolved.is_empty());
    }
    #[test]
    fn mandatory_sphere_actual_atomic_faces_and_fillings() {
        actual(r#"{"kind":"sphere","pos":[0,0,0],"r":9}"#, -10., 20., 2763);
    }
    #[test]
    fn mandatory_clipped_box_actual_atomic_faces_patches_and_creases() {
        actual(
            r#"{"kind":"intersect","lh":{"kind":"box","pos":[0,0,0],"half":[1,1,1]},"rh":{"kind":"box","pos":[-1.75,0,0],"half":[2.25,4,4]}}"#,
            -4.,
            8.,
            132,
        );
    }
}
