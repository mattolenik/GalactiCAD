//! Complete bounded rectilinear surface arrangements, clipped to actual leaves.
//! See docs/research/sfcc-aligned-box-reconstruction.md for the checked premises.
use super::{
    feature_curves::make_segment_curve,
    feature_set::{SfccCorner, SfccFeatureSet},
    local_coverage::{CellId, Witness},
    octree::SfccCell,
    point_table::{CurveInterval, PointTable},
    predicates::exact_affine_eq,
    spatial_index::SfccSpatialIndex,
};
use crate::{
    math::grid::{cell_aabb, cell_key, point_to_world, stride_at_level, SfccLattice},
    sdf::{CsgNode, Shape},
};
use std::collections::{BTreeMap, BTreeSet};

const MAX_OCCURRENCES: usize = 4096;
const MAX_AXIS: usize = 128;
const MAX_STRATA: usize = 262144;
const MAX_SIGN_WORK: usize = 16_777_216;
const MAX_CUTS: usize = 1024;
const MAX_RECTANGLES: usize = 262144;
const MAX_LEAVES: usize = 32768;
#[derive(Clone, Debug)]
struct BoxOccurrence {
    bounds: [f64; 6],
    ranks: [usize; 6],
    sign: i8,
    path: Vec<usize>,
}
#[derive(Clone, Debug)]
enum Expr {
    Leaf(usize),
    Min(Vec<Expr>),
    Max(Vec<Expr>),
}
impl Expr {
    fn sign(&self, p: [usize; 3], boxes: &[BoxOccurrence]) -> i8 {
        match self {
            Self::Leaf(i) => {
                let b = &boxes[*i];
                let mut s = -1;
                for a in 0..3 {
                    if p[a] < 2 * b.ranks[a] + 1 || p[a] > 2 * b.ranks[a + 3] + 1 {
                        s = 1;
                        break;
                    }
                    if p[a] == 2 * b.ranks[a] + 1 || p[a] == 2 * b.ranks[a + 3] + 1 {
                        s = 0;
                    }
                }
                s * b.sign
            }
            Self::Min(c) => c.iter().map(|c| c.sign(p, boxes)).min().unwrap_or(1),
            Self::Max(c) => c.iter().map(|c| c.sign(p, boxes)).max().unwrap_or(-1),
        }
    }
    fn owned_sign(&self, p: [usize; 3], boxes: &[BoxOccurrence]) -> (i8, Vec<usize>) {
        match self {
            Self::Leaf(i) => {
                let sign = self.sign(p, boxes);
                (sign, if sign == 0 { vec![*i] } else { Vec::new() })
            }
            Self::Min(children) | Self::Max(children) => {
                let minimum = matches!(self, Self::Min(_));
                let mut best = if minimum { 1 } else { -1 };
                let mut owners = Vec::new();
                for child in children {
                    let (sign, mut child_owners) = child.owned_sign(p, boxes);
                    if if minimum { sign < best } else { sign > best } {
                        best = sign;
                        owners.clear();
                    }
                    if best == 0 && sign == 0 {
                        owners.append(&mut child_owners);
                    }
                }
                (best, owners)
            }
        }
    }
}
#[derive(Clone, Debug)]
pub(crate) struct Facet {
    pub axis: usize,
    pub sign: i8,
    pub bounds: [f64; 6],
    pub owners: Vec<usize>,
}
#[derive(Clone, Debug)]
pub(crate) struct Piece {
    pub cell: usize,
    pub facet: usize,
    pub corners: [[usize; 3]; 4],
}
pub(crate) struct Plan {
    pub leaves: Vec<SfccCell>,
    pub cuts: [Vec<f64>; 3],
    pub facets: Vec<Facet>,
    pub pieces: Vec<Piece>,
    pub signature: Vec<u64>,
    pub needed: bool,
    occurrences: Vec<BoxOccurrence>,
}
pub(crate) enum Attempt {
    Outside,
    Reject(&'static str),
    Ready(Plan),
}

/// Preserve provenance even when checked flips retain old cell cuts virtually.
/// New triangles after those flips need not have a single original patch owner.
pub(crate) struct MetadataSnapshot {
    patches: BTreeMap<[usize; 3], Option<usize>>,
    protected: BTreeSet<(usize, usize)>,
    curves: Vec<(usize, usize, usize, u64, u64)>,
}
impl MetadataSnapshot {
    fn curves(pt: &PointTable) -> Vec<(usize, usize, usize, u64, u64)> {
        let mut curves = pt
            .identified_edges()
            .flat_map(|((a, b), intervals)| {
                intervals
                    .iter()
                    .map(move |c| (a, b, c.curve_id, c.start.to_bits(), c.end.to_bits()))
            })
            .collect::<Vec<_>>();
        curves.sort();
        curves
    }
    pub(crate) fn capture(pt: &PointTable, tris: &[usize]) -> Option<Self> {
        pt.arrangement.then(|| Self {
            patches: tris
                .chunks_exact(3)
                .map(|t| {
                    let mut t = [t[0], t[1], t[2]];
                    t.sort_unstable();
                    (t, pt.patch(t))
                })
                .collect(),
            protected: pt.protected_edges().collect(),
            curves: Self::curves(pt),
        })
    }
    pub(crate) fn verify(self, pt: &mut PointTable, tris: &[usize]) {
        if self.patches.iter().any(|(&t, &owner)| pt.patch(t) != owner)
            || tris.chunks_exact(3).any(|t| {
                let mut t = [t[0], t[1], t[2]];
                t.sort_unstable();
                !self.patches.contains_key(&t) && pt.patch(t).is_some()
            })
            || self.protected != pt.protected_edges().collect()
            || self.curves != Self::curves(pt)
        {
            for witness in &mut pt.coverage {
                if witness.reason.is_none() {
                    witness.reason = Some("arrangement_cleanup_metadata".into());
                }
            }
        }
    }
}
fn identity(c: &CsgNode, depth: usize) -> bool {
    if depth > 128 {
        return false;
    }
    match c {
        CsgNode::Leaf(l) => {
            matches!(l.shape, Shape::Cuboid { .. })
                && l.sim.r == [1., 0., 0., 0., 1., 0., 0., 0., 1.]
                && l.sim.s == 1.
                && l.sim.t == [0.; 3]
        }
        CsgNode::Min(c) | CsgNode::Max(c) => {
            !c.is_empty() && c.iter().all(|c| identity(c, depth + 1))
        }
        _ => false,
    }
}
fn compile(
    c: &CsgNode,
    path: &mut Vec<usize>,
    boxes: &mut Vec<BoxOccurrence>,
    words: &mut Vec<u64>,
) -> Result<Expr, &'static str> {
    if path.len() > 128 || boxes.len() >= MAX_OCCURRENCES {
        return Err("arrangement_occurrence_budget");
    }
    match c {
        CsgNode::Leaf(l) => {
            let Shape::Cuboid { half } = l.shape else {
                return Err("arrangement_scope");
            };
            if ![1., -1.].contains(&l.sign)
                || half.iter().any(|h| !h.is_finite() || *h <= 0.)
                || l.pos.iter().any(|x| !x.is_finite())
            {
                return Err("arrangement_invalid_box");
            }
            let mut b = [0.; 6];
            for a in 0..3 {
                b[a] = l.pos[a] - half[a];
                b[a + 3] = l.pos[a] + half[a];
                if !exact_affine_eq(l.pos[a], half[a], -1., b[a])
                    || !exact_affine_eq(l.pos[a], half[a], 1., b[a + 3])
                    || b[a] >= b[a + 3]
                {
                    return Err("arrangement_unrepresented_endpoint");
                }
            }
            words.extend([0, l.sign.to_bits()]);
            words.extend(l.pos.map(f64::to_bits));
            words.extend(half.map(f64::to_bits));
            words.push(path.len() as u64);
            words.extend(path.iter().map(|&v| v as u64));
            let i = boxes.len();
            boxes.push(BoxOccurrence {
                bounds: b,
                ranks: [0; 6],
                sign: l.sign as i8,
                path: path.clone(),
            });
            Ok(Expr::Leaf(i))
        }
        CsgNode::Min(ch) | CsgNode::Max(ch) => {
            words.extend([
                if matches!(c, CsgNode::Min(_)) { 1 } else { 2 },
                ch.len() as u64,
            ]);
            let mut out = Vec::new();
            for (i, c) in ch.iter().enumerate() {
                path.push(i);
                out.push(compile(c, path, boxes, words)?);
                path.pop();
            }
            Ok(if matches!(c, CsgNode::Min(_)) {
                Expr::Min(out)
            } else {
                Expr::Max(out)
            })
        }
        _ => Err("arrangement_scope"),
    }
}
fn unique(v: &mut Vec<f64>) {
    for x in v.iter_mut() {
        if *x == 0. {
            *x = 0.;
        }
    }
    v.sort_by(f64::total_cmp);
    v.dedup_by(|a, b| *a == *b);
}
fn rank(v: &[f64], x: f64) -> usize {
    v.binary_search_by(|q| q.total_cmp(&if x == 0. { 0. } else { x }))
        .expect("arrangement coordinate from canonical set")
}
fn adjacent_open(s: usize, n: usize) -> Vec<usize> {
    if s % 2 == 0 {
        vec![s]
    } else {
        [s - 1, s + 1].into_iter().filter(|&x| x <= 2 * n).collect()
    }
}
fn cell_id(c: &SfccCell) -> CellId {
    (c.level, c.ix, c.iy, c.iz)
}
fn axes(a: usize) -> [usize; 2] {
    [(a + 1) % 3, (a + 2) % 3]
}
fn target(
    tree: &CsgNode,
) -> Result<(Vec<BoxOccurrence>, Vec<Facet>, [Vec<f64>; 3], Vec<u64>), &'static str> {
    let mut boxes = Vec::new();
    let mut signature = Vec::new();
    let expr = compile(tree, &mut Vec::new(), &mut boxes, &mut signature)?;
    let mut coords: [Vec<f64>; 3] = std::array::from_fn(|a| {
        boxes
            .iter()
            .flat_map(|b| [b.bounds[a], b.bounds[a + 3]])
            .collect()
    });
    for v in &mut coords {
        unique(v);
        if v.len() > MAX_AXIS {
            return Err("arrangement_plane_budget");
        }
    }
    for b in &mut boxes {
        for a in 0..3 {
            b.ranks[a] = rank(&coords[a], b.bounds[a]);
            b.ranks[a + 3] = rank(&coords[a], b.bounds[a + 3]);
        }
    }
    let dims = coords.each_ref().map(|c| 2 * c.len() + 1);
    let count = dims
        .into_iter()
        .try_fold(1usize, |p, n| p.checked_mul(n))
        .ok_or("arrangement_strata_budget")?;
    if count > MAX_STRATA || count.saturating_mul(signature.len()) > MAX_SIGN_WORK {
        return Err("arrangement_strata_budget");
    }
    let idx = |p: [usize; 3]| (p[0] * dims[1] + p[1]) * dims[2] + p[2];
    let mut signs = vec![0i8; count];
    for x in 0..dims[0] {
        if super::cancel::is_cancelled() {
            return Err("arrangement_cancelled");
        }
        for y in 0..dims[1] {
            for z in 0..dims[2] {
                let p = [x, y, z];
                signs[idx(p)] = expr.sign(p, &boxes);
            }
        }
    }
    let mut facets = Vec::new();
    let mut face_keys = BTreeSet::new();
    for a in 0..3 {
        let [u, v] = axes(a);
        for plane in 0..coords[a].len() {
            for iu in 1..coords[u].len() {
                for iv in 1..coords[v].len() {
                    let mut p = [0; 3];
                    p[a] = 2 * plane + 1;
                    p[u] = 2 * iu;
                    p[v] = 2 * iv;
                    if signs[idx(p)] != 0 {
                        continue;
                    }
                    let mut l = p;
                    let mut r = p;
                    l[a] -= 1;
                    r[a] += 1;
                    let sl = signs[idx(l)];
                    let sr = signs[idx(r)];
                    if sl == sr {
                        return Err("arrangement_zero_only_face");
                    }
                    let sign = if sl < sr { 1 } else { -1 };
                    let mut b = [0.; 6];
                    b[a] = coords[a][plane];
                    b[a + 3] = b[a];
                    b[u] = coords[u][iu - 1];
                    b[u + 3] = coords[u][iu];
                    b[v] = coords[v][iv - 1];
                    b[v + 3] = coords[v][iv];
                    let (_, owners) = expr.owned_sign(p, &boxes);
                    if owners.is_empty() {
                        return Err("arrangement_owner_missing");
                    }
                    face_keys.insert(p);
                    facets.push(Facet {
                        axis: a,
                        sign,
                        bounds: b,
                        owners,
                    });
                }
            }
        }
    }
    // Lower-dimensional zero strata are legitimate only as closures of exposed faces.
    for x in 0..dims[0] {
        for y in 0..dims[1] {
            for z in 0..dims[2] {
                let p = [x, y, z];
                if signs[idx(p)] != 0 || p.iter().filter(|&&s| s % 2 == 1).count() < 2 {
                    continue;
                }
                let mut covered = false;
                for a in 0..3 {
                    if p[a] % 2 == 0 {
                        continue;
                    }
                    let [u, v] = axes(a);
                    for iu in adjacent_open(p[u], coords[u].len()) {
                        for iv in adjacent_open(p[v], coords[v].len()) {
                            let mut q = p;
                            q[u] = iu;
                            q[v] = iv;
                            covered |= face_keys.contains(&q);
                        }
                    }
                }
                if !covered {
                    return Err("arrangement_zero_only_edge_or_point");
                }
            }
        }
    }
    Ok((boxes, facets, coords, signature))
}
impl Plan {
    /// Bounded production fallback: retain every nondegenerate legacy fast path.
    pub(crate) fn for_export(tree: &CsgNode, lat: &SfccLattice, leaves: &[SfccCell]) -> Attempt {
        if !leaves.iter().any(|c| c.degenerate) {
            return Attempt::Outside;
        }
        Self::new(tree, lat, leaves)
    }
    pub fn new(tree: &CsgNode, lat: &SfccLattice, leaves: &[SfccCell]) -> Attempt {
        if !identity(tree, 0) {
            return Attempt::Outside;
        }
        match Self::checked(tree, lat, leaves) {
            Ok(p) => Attempt::Ready(p),
            Err(e) => {
                let optional_scope = matches!(
                    e,
                    "arrangement_occurrence_budget"
                        | "arrangement_plane_budget"
                        | "arrangement_strata_budget"
                        | "arrangement_unrepresented_endpoint"
                        | "arrangement_grid"
                        | "arrangement_cell_map"
                        | "arrangement_grid_contact"
                        | "arrangement_leaf_budget"
                );
                if optional_scope && !leaves.iter().any(|c| c.degenerate) {
                    Attempt::Outside
                } else {
                    Attempt::Reject(e)
                }
            }
        }
    }
    fn checked(
        tree: &CsgNode,
        lat: &SfccLattice,
        leaves: &[SfccCell],
    ) -> Result<Self, &'static str> {
        let (occurrences, facets, mut cuts, signature) = target(tree)?;
        if leaves.len() > MAX_LEAVES {
            return Err("arrangement_leaf_budget");
        }
        if lat.max_depth < 1
            || lat.max_depth > 14
            || lat.res != 1 << lat.max_depth
            || lat.span != lat.res + 1
            || !lat.world_size.is_finite()
            || lat.world_size <= 0.
            || !lat.step.is_finite()
            || lat.step <= 0.
            || [lat.origin_x, lat.origin_y, lat.origin_z]
                .iter()
                .any(|x| !x.is_finite())
            || !exact_affine_eq(0., lat.step, lat.res as f64, lat.world_size)
        {
            return Err("arrangement_grid");
        }
        let primitive_planes = cuts.clone();
        let mut bounds = Vec::new();
        let mut seen = BTreeSet::new();
        let origin = [lat.origin_x, lat.origin_y, lat.origin_z];
        for c in leaves {
            if c.level > lat.max_depth || !seen.insert(cell_id(c)) {
                return Err("arrangement_leaf_identity");
            }
            let res = 1i64 << c.level;
            if [c.ix, c.iy, c.iz].iter().any(|&i| i < 0 || i >= res) {
                return Err("arrangement_leaf_identity");
            }
            if c.key != cell_key(lat, c.level, c.ix, c.iy, c.iz) {
                return Err("arrangement_leaf_identity");
            }
            let s = stride_at_level(lat, c.level);
            let g = [c.ix * s, c.iy * s, c.iz * s];
            let lo = point_to_world(lat, g[0], g[1], g[2]);
            let hi = point_to_world(lat, g[0] + s, g[1] + s, g[2] + s);
            let b = cell_aabb(lat, c.level, c.ix, c.iy, c.iz);
            for a in 0..3 {
                if b[a] != lo[a]
                    || b[a + 3] != hi[a]
                    || !exact_affine_eq(origin[a], lat.step, g[a] as f64, lo[a])
                    || !exact_affine_eq(origin[a], lat.step, (g[a] + s) as f64, hi[a])
                {
                    return Err("arrangement_cell_map");
                }
                if primitive_planes[a].contains(&lo[a]) || primitive_planes[a].contains(&hi[a]) {
                    return Err("arrangement_grid_contact");
                }
                cuts[a].extend([lo[a], hi[a]]);
            }
            bounds.push(b);
        }
        // The fallback trigger uses a complete target in each actual cell; it does
        // not depend on whether the old mesher happened to emit triangles.
        let needed = leaves.iter().any(|c| c.degenerate)
            || leaves.is_empty() && !facets.is_empty()
            || bounds.iter().any(|b| !target_is_disk_or_empty(&facets, b));
        if !needed {
            return Ok(Self {
                leaves: leaves.to_vec(),
                cuts: primitive_planes,
                facets,
                pieces: Vec::new(),
                signature,
                needed: false,
                occurrences,
            });
        }
        for v in &mut cuts {
            unique(v);
            if v.len() > MAX_CUTS {
                return Err("arrangement_cut_budget");
            }
            if v.windows(2).any(|w| {
                !(w[0] as f32).is_finite()
                    || !(w[1] as f32).is_finite()
                    || w[0] as f32 >= w[1] as f32
            }) {
                return Err("arrangement_f32_collapse");
            }
        }
        // Strict coordinate order gives an ambient piecewise-linear map to f32.
        // Supporting planes may move: this proves topology, not exact f32 loci.
        let mut estimate = 0usize;
        for f in &facets {
            let [u, v] = axes(f.axis);
            estimate = estimate
                .checked_add(
                    (rank(&cuts[u], f.bounds[u + 3]) - rank(&cuts[u], f.bounds[u]))
                        * (rank(&cuts[v], f.bounds[v + 3]) - rank(&cuts[v], f.bounds[v])),
                )
                .ok_or("arrangement_rectangle_budget")?;
            if estimate > MAX_RECTANGLES {
                return Err("arrangement_rectangle_budget");
            }
        }
        if estimate.saturating_mul(leaves.len()) > 32_000_000 {
            return Err("arrangement_owner_budget");
        }
        let mut pieces = Vec::with_capacity(estimate);
        for (fi, f) in facets.iter().enumerate() {
            let [u, v] = axes(f.axis);
            let k = rank(&cuts[f.axis], f.bounds[f.axis]);
            for i in rank(&cuts[u], f.bounds[u])..rank(&cuts[u], f.bounds[u + 3]) {
                for j in rank(&cuts[v], f.bounds[v])..rank(&cuts[v], f.bounds[v + 3]) {
                    let owners: Vec<_> = bounds
                        .iter()
                        .enumerate()
                        .filter(|(_, b)| {
                            b[f.axis] < f.bounds[f.axis]
                                && f.bounds[f.axis] < b[f.axis + 3]
                                && b[u] <= cuts[u][i]
                                && cuts[u][i + 1] <= b[u + 3]
                                && b[v] <= cuts[v][j]
                                && cuts[v][j + 1] <= b[v + 3]
                        })
                        .map(|(i, _)| i)
                        .collect();
                    if owners.len() != 1 {
                        return Err("arrangement_missing_or_overlapping_leaf");
                    }
                    let mut corners = [[0; 3]; 4];
                    for (n, (du, dv)) in [(0, 0), (1, 0), (1, 1), (0, 1)].into_iter().enumerate() {
                        corners[n][f.axis] = k;
                        corners[n][u] = i + du;
                        corners[n][v] = j + dv;
                    }
                    if f.sign < 0 {
                        corners.swap(1, 3);
                    }
                    pieces.push(Piece {
                        cell: owners[0],
                        facet: fi,
                        corners,
                    });
                }
            }
        }
        let out = Self {
            leaves: leaves.to_vec(),
            cuts,
            facets,
            pieces,
            signature,
            needed,
            occurrences,
        };
        let (pt, tris, _features) = out.mesh(None)?;
        let (_, indices) = pt.build_mesh(&tris);
        if !super::manifold_check::check_manifold(&indices, true).ok {
            return Err("arrangement_nonmanifold_contact");
        }
        Ok(out)
    }
    fn position(&self, key: [usize; 3]) -> [f64; 3] {
        std::array::from_fn(|a| self.cuts[a][key[a]])
    }
    pub(crate) fn mesh(
        &self,
        owned: Option<&BTreeSet<CellId>>,
    ) -> Result<(PointTable, Vec<usize>, SfccFeatureSet), &'static str> {
        let mut point_faces: BTreeMap<[usize; 3], BTreeSet<(usize, i8)>> = BTreeMap::new();
        let mut edges: BTreeMap<([usize; 3], [usize; 3]), BTreeSet<usize>> = BTreeMap::new();
        for p in &self.pieces {
            let f = &self.facets[p.facet];
            for i in 0..4 {
                point_faces
                    .entry(p.corners[i])
                    .or_default()
                    .insert((f.axis, f.sign));
                let a = p.corners[i];
                let b = p.corners[(i + 1) % 4];
                edges
                    .entry((a.min(b), a.max(b)))
                    .or_default()
                    .insert(p.facet);
            }
        }
        let mut strata = Vec::new();
        for (i, o) in self.occurrences.iter().enumerate() {
            debug_assert!(o.path.len() <= 128);
            for axis in 0..3 {
                for side in [1usize, 0] {
                    let n = if side == 1 { 1. } else { -1. };
                    let id = strata.len();
                    let ident = crate::strata::StratumIdentity {
                        id,
                        owner_node_id: -1,
                        leaf_index: i,
                        local_index: axis * 2 + 1 - side,
                        sign: o.sign as f64,
                    };
                    let v: [f64; 3] = std::array::from_fn(|a| if a == axis { n } else { 0. });
                    strata.push(crate::strata::Stratum::plane(
                        ident,
                        v[0],
                        v[1],
                        v[2],
                        -n * o.bounds[axis + 3 * side],
                    ));
                }
            }
        }
        let mut curves = Vec::new();
        let mut edge_curves = BTreeMap::new();
        let mut index = SfccSpatialIndex::new(1.);
        let mut corner_curves: BTreeMap<[usize; 3], Vec<(usize, u8)>> = BTreeMap::new();
        for (&(a, b), fs) in &edges {
            let planes: BTreeSet<_> = fs
                .iter()
                .map(|&fi| (self.facets[fi].axis, self.facets[fi].sign))
                .collect();
            if planes.len() == 1 {
                continue;
            }
            if fs.len() != 2 || planes.len() != 2 {
                return Err("arrangement_crease_incidence");
            }
            let adjacent: Vec<_> = fs.iter().map(|&fi| self.patch_owner(fi)).collect();
            let pa = self.position(a);
            let pb = self.position(b);
            if (0..3).any(|i| !exact_affine_eq(pa[i], pb[i] - pa[i], 1., pb[i])) {
                return Err("arrangement_crease_parameter");
            }
            let id = curves.len();
            let curve = make_segment_curve(
                id,
                -1,
                [adjacent[0], adjacent[1]],
                pa[0],
                pa[1],
                pa[2],
                pb[0],
                pb[1],
                pb[2],
            );
            index.insert_curve(&curve);
            curves.push(curve);
            edge_curves.insert((a, b), id);
            corner_curves.entry(a).or_default().push((id, 0));
            corner_curves.entry(b).or_default().push((id, 1));
        }
        let mut corners = Vec::new();
        for (k, ends) in corner_curves {
            let p = self.position(k);
            let id = corners.len();
            let strata: Vec<_> = ends
                .iter()
                .flat_map(|(i, _)| curves[*i].adjacent_strata)
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            for &(i, e) in &ends {
                if e == 0 {
                    curves[i].corner_start = id as i64;
                } else {
                    curves[i].corner_end = id as i64;
                }
            }
            index.insert_corner(id, p[0], p[1], p[2]);
            corners.push(SfccCorner {
                id,
                x: p[0],
                y: p[1],
                z: p[2],
                strata,
                curve_ends: ends,
            });
        }
        let features = SfccFeatureSet {
            unresolved_branch_paths: Vec::new(),
            trace_diagnostics: Default::default(),
            curves,
            corners,
            index,
            strata,
            run_id: super::feature_set::next_feature_set_run_id(),
        };
        let mut pt = PointTable::new();
        pt.arrangement = true;
        let mut ids = BTreeMap::new();
        let mut tris = Vec::new();
        let mut cell_tris: Vec<Vec<usize>> = vec![Vec::new(); self.leaves.len()];
        for p in &self.pieces {
            if owned.is_some_and(|o| !o.contains(&cell_id(&self.leaves[p.cell]))) {
                continue;
            }
            let mut ci = [0; 4];
            for i in 0..4 {
                let k = p.corners[i];
                ci[i] = *ids.entry(k).or_insert_with(|| {
                    let pos = self.position(k);
                    let mut n = [0.; 3];
                    for &(a, s) in &point_faces[&k] {
                        n[a] += s as f64;
                    }
                    let len = n[0].hypot(n[1]).hypot(n[2]);
                    let n = if len > 0. {
                        n.map(|v| v / len)
                    } else {
                        let &(a, s) = point_faces[&k].first().expect("incident facet");
                        std::array::from_fn(|i| if i == a { s as f64 } else { 0. })
                    };
                    pt.get_or_create_str(&format!("arr:{},{},{}", k[0], k[1], k[2]), || {
                        [pos[0], pos[1], pos[2], n[0], n[1], n[2]]
                    })
                });
            }
            for t in [[ci[0], ci[1], ci[2]], [ci[0], ci[2], ci[3]]] {
                pt.set_patch(t, self.patch_owner(p.facet));
                tris.extend(t);
                cell_tris[p.cell].extend(t);
            }
            for i in 0..4 {
                let a = p.corners[i];
                let b = p.corners[(i + 1) % 4];
                if let Some(&curve_id) = edge_curves.get(&(a.min(b), a.max(b))) {
                    let (start, end) = if a < b { (0., 1.) } else { (1., 0.) };
                    pt.protect_curve_edge(
                        ci[i],
                        ci[(i + 1) % 4],
                        CurveInterval {
                            curve_id,
                            start,
                            end,
                        },
                    );
                }
            }
        }
        for (i, c) in self.leaves.iter().enumerate() {
            if owned.is_some_and(|o| !o.contains(&cell_id(c))) {
                continue;
            }
            let triangles: Vec<_> = cell_tris[i]
                .chunks_exact(3)
                .map(|t| {
                    let t = [t[0], t[1], t[2]];
                    let j = (0..3).min_by_key(|&j| t[j]).unwrap();
                    [t[j], t[(j + 1) % 3], t[(j + 2) % 3]]
                })
                .collect();
            let vertices = cell_tris[i]
                .iter()
                .copied()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .map(|j| {
                    (
                        j,
                        pt.key_at(j).clone(),
                        super::local_coverage::payload(&pt, j),
                    )
                })
                .collect();
            let es: BTreeSet<_> = cell_tris[i]
                .chunks_exact(3)
                .flat_map(|t| {
                    (0..3).map(move |j| (t[j].min(t[(j + 1) % 3]), t[j].max(t[(j + 1) % 3])))
                })
                .collect();
            let curves = es
                .into_iter()
                .flat_map(|(a, b)| pt.curve_intervals(a, b).into_iter().map(move |c| (a, b, c)))
                .collect();
            pt.coverage.push(Witness {
                transported: false,
                cell: SfccCell {
                    degenerate: false,
                    ..*c
                },
                reason: None,
                triangles,
                vertices,
                faces: Vec::new(),
                curves,
            });
        }
        Ok((pt, tris, features))
    }
    fn patch_owner(&self, facet: usize) -> usize {
        let f = &self.facets[facet];
        let i = *f
            .owners
            .iter()
            .find(|&&i| {
                let o = &self.occurrences[i];
                let side = if o.bounds[f.axis + 3] == f.bounds[f.axis] {
                    1
                } else {
                    -1
                };
                side * o.sign == f.sign
            })
            .expect("a crossing min/max expression has an aligned active occurrence");
        let side = usize::from(self.occurrences[i].bounds[f.axis + 3] == f.bounds[f.axis]);
        i * 6 + f.axis * 2 + 1 - side
    }
    #[cfg(all(test, feature = "serde"))]
    pub(crate) fn provenance(&self) -> Vec<(Vec<usize>, [f64; 6], i8)> {
        self.occurrences
            .iter()
            .map(|o| (o.path.clone(), o.bounds, o.sign))
            .collect()
    }
}
fn target_is_disk_or_empty(facets: &[Facet], cell: &[f64; 6]) -> bool {
    let mut points: BTreeMap<[u64; 3], usize> = BTreeMap::new();
    let mut tris = Vec::new();
    for f in facets {
        let a = f.axis;
        let [u, v] = axes(a);
        if !(cell[a] < f.bounds[a] && f.bounds[a] < cell[a + 3]) {
            continue;
        }
        let lo = [f.bounds[u].max(cell[u]), f.bounds[v].max(cell[v])];
        let hi = [
            f.bounds[u + 3].min(cell[u + 3]),
            f.bounds[v + 3].min(cell[v + 3]),
        ];
        if lo[0] >= hi[0] || lo[1] >= hi[1] {
            continue;
        }
        let mut ids = [0; 4];
        for (i, (su, sv)) in [(0, 0), (1, 0), (1, 1), (0, 1)].into_iter().enumerate() {
            let mut p = [0.; 3];
            p[a] = f.bounds[a];
            p[u] = if su == 0 { lo[0] } else { hi[0] };
            p[v] = if sv == 0 { lo[1] } else { hi[1] };
            let next = points.len();
            ids[i] = *points.entry(p.map(f64::to_bits)).or_insert(next);
        }
        if f.sign < 0 {
            ids.swap(1, 3);
        }
        tris.extend([ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]]);
    }
    tris.is_empty() || is_disk(&tris)
}
fn is_disk(tris: &[usize]) -> bool {
    super::local_coverage::disk(tris).is_ok()
}

#[cfg(all(test, feature = "serde"))]
mod tests {
    use super::super::pipeline::{build_pipeline_context, PipelineTuning, SfccWorldCube};
    use super::*;
    use crate::scene_bridge::build_csg_tree_from_json;
    const SHEETS: &str = r#"{"kind":"union","children":[{"kind":"box","pos":[-1.875,0,0],"half":[2.125,4,4]},{"kind":"intersect","lh":{"kind":"box","pos":[2.25,0,0],"half":[1.75,4,4]},"rh":{"kind":"box","pos":[-1.625,0,0],"half":[2.375,4,4]}}]}"#;
    #[test]
    fn coarse_plan_constructs_two_cuboids() {
        let tree = build_csg_tree_from_json(SHEETS).unwrap();
        let tuning = PipelineTuning::default();
        let cube = SfccWorldCube {
            min_x: -128.,
            min_y: -128.,
            min_z: -128.,
            size: 256.,
        };
        let ctx = build_pipeline_context(&tree, &cube, &tuning);
        let oct = ctx.build_tagged_octree(&tuning);
        let plan = match Plan::new(&tree, &oct.lat, &oct.leaves) {
            Attempt::Ready(p) => p,
            Attempt::Reject(e) => panic!("{e}"),
            Attempt::Outside => panic!("outside"),
        };
        assert!(plan.needed);
        let mut shared: BTreeMap<([usize; 3], [usize; 3]), BTreeSet<u32>> = BTreeMap::new();
        for p in &plan.pieces {
            for i in 0..4 {
                let a = p.corners[i];
                let b = p.corners[(i + 1) % 4];
                shared
                    .entry((a.min(b), a.max(b)))
                    .or_default()
                    .insert(plan.leaves[p.cell].level);
            }
        }
        assert!(
            shared
                .values()
                .any(|levels| levels.len() == 2
                    && levels.last().unwrap() - levels.first().unwrap() == 1),
            "actual 2:1 interface required"
        );
        let (mut pt, tris, features) = plan.mesh(None).unwrap();
        let (before_v, before_t) = pt.build_mesh(&tris);
        assert_eq!(
            super::super::manifold_check::check_manifold(&before_t, true).components,
            2
        );
        let (out, unresolved, q) = super::super::assembly::finish(
            &tree,
            &features,
            &mut pt,
            &tris,
            oct.lat.step,
            &tuning,
            None,
        );
        let (v, t) = pt.build_mesh(&out);
        let m = super::super::manifold_check::check_manifold(&t, true);
        assert!(m.ok);
        assert_eq!(m.components, 2);
        assert_eq!(unresolved, 0);
        assert!(q.is_none());
        let report = super::super::local_coverage::report(&tree, &pt);
        assert!(report.unresolved.is_empty(), "{report:?}");
        let fc = super::super::feature_chain::audit_feature_chains(
            &pt,
            &out,
            &features,
            tuning.surface_tol_mm,
        );
        assert!(fc.passed(), "{fc:?}");
        std::fs::write("/tmp/sfcc-arrangement-b-coarse.json",serde_json::to_string(&serde_json::json!({"verts":v,"tris":t,"initialVertices":before_v,"initialTriangles":before_t,"leaves":plan.leaves.iter().map(|c|[c.level as i64,c.ix,c.iy,c.iz]).collect::<Vec<_>>(),"primitiveProvenance":plan.provenance(),"coverage":report.to_json()})).unwrap()).unwrap();
        println!(
            "leaves={} rectangles={} triangles={} curves={} report={report:?}",
            oct.leaves.len(),
            plan.pieces.len(),
            t.len() / 3,
            features.curves.len()
        );
    }
}

pub(crate) fn mark_unresolved(
    validation: &mut super::validation::SfccValidation,
    reason: &str,
    leaves: &[SfccCell],
) {
    let cell = leaves.first().map(cell_id).unwrap_or((0, 0, 0, 0));
    if !validation
        .local_coverage
        .unresolved
        .iter()
        .any(|(c, _)| *c == cell)
    {
        validation.unresolved_cells += 1;
    }
    validation
        .local_coverage
        .unresolved
        .push((cell, reason.into()));
    validation.local_coverage.unresolved.sort();
}

#[cfg(feature = "sfcc-profile")]
pub(crate) fn diagnose(
    plan: &Plan,
    lat: SfccLattice,
    validation: &super::validation::SfccValidation,
) {
    if !super::diagnosis::payload_available() {
        return;
    }
    let (pt, _, _) = plan.mesh(None).expect("checked arrangement diagnostic");
    for w in &pt.coverage {
        let tris: Vec<_> = w.triangles.iter().flatten().copied().collect();
        super::diagnosis::mesh(&w.cell, &pt, &tris, "box_arrangement", false);
    }
    let leaves: Vec<_> = plan
        .leaves
        .iter()
        .map(|c| SfccCell {
            degenerate: false,
            ..*c
        })
        .collect();
    let failed: Vec<_> = leaves
        .iter()
        .filter(|c| {
            validation
                .local_coverage
                .unresolved
                .iter()
                .any(|(i, _)| *i == cell_id(c))
        })
        .copied()
        .collect();
    super::diagnosis::snapshot(lat, &leaves, &failed, 0, true);
}

#[cfg(all(test, feature = "serde"))]
mod adversaries {
    use super::*;
    use serde_json::{json, Value};
    fn bx(p: [f64; 3], h: [f64; 3]) -> Value {
        json!({"kind":"box","nodeId":7,"pos":p,"half":h})
    }
    fn one_cell(scene: Value) -> Attempt {
        let tree = crate::scene_bridge::build_csg_tree_from_json(&scene.to_string()).unwrap();
        let lat = crate::math::grid::make_lattice(8, -8.125, -8.25, -8.5, 16.);
        let cell = SfccCell {
            level: 0,
            ix: 0,
            iy: 0,
            iz: 0,
            key: 0,
            degenerate: false,
            feature_curve: -1,
            feature_corner: -1,
        };
        Plan::new(&tree, &lat, &[cell])
    }
    #[test]
    fn closed_internal_box_and_duplicate_occurrences_are_complete() {
        let b = bx([0.; 3], [1.; 3]);
        for scene in [b.clone(), json!({"kind":"union","children":[b.clone(),b]})] {
            let Attempt::Ready(plan) = one_cell(scene) else {
                panic!("closed arrangement rejected")
            };
            assert!(plan.needed);
            let (p, t, f) = plan.mesh(None).unwrap();
            let (_, t) = p.build_mesh(&t);
            let m = super::super::manifold_check::check_manifold(&t, true);
            assert!(m.ok);
            assert_eq!(m.components, 1);
            assert_eq!(t.len(), 36);
            assert_eq!(f.curves.len(), 12);
            if plan.occurrences.len() == 2 {
                assert!(plan.facets.iter().all(|f| f.owners == [0, 1]));
                assert_ne!(plan.occurrences[0].path, plan.occurrences[1].path);
            }
        }
    }
    #[test]
    fn cleanup_cannot_change_original_carriers_or_protected_memberships() {
        let Attempt::Ready(plan) = one_cell(bx([0.; 3], [1.; 3])) else {
            panic!("closed arrangement rejected")
        };
        for mutation in 0..4 {
            let (mut points, tris, _) = plan.mesh(None).unwrap();
            let snapshot = MetadataSnapshot::capture(&points, &tris).unwrap();
            let t = [tris[0], tris[1], tris[2]];
            let mut final_tris = tris.clone();
            match mutation {
                0 => points.set_patch(t, usize::MAX),
                1 => points.protect_edge(t[0], t[2]),
                2 => points.protect_curve_edge(
                    t[0],
                    t[2],
                    CurveInterval {
                        curve_id: 0,
                        start: 0.,
                        end: 1.,
                    },
                ),
                _ => {
                    let other = (0..points.count())
                        .find(|&i| !t.contains(&i) && points.patch([t[0], t[1], i]).is_none())
                        .unwrap();
                    let added = [t[0], t[1], other];
                    points.set_patch(added, 0);
                    final_tris.extend(added);
                }
            }
            snapshot.verify(&mut points, &final_tris);
            assert!(points
                .coverage
                .iter()
                .all(|w| w.reason.as_deref() == Some("arrangement_cleanup_metadata")));
        }
        let (mut points, tris, _) = plan.mesh(None).unwrap();
        MetadataSnapshot::capture(&points, &tris)
            .unwrap()
            .verify(&mut points, &tris);
        assert!(points.coverage.iter().all(|w| w.reason.is_none()));
    }
    #[test]
    fn zero_only_faces_edges_and_points_are_not_regularized() {
        let b = bx([0.; 3], [1.; 3]);
        let scenes = [
            json!({"kind":"subtract","lh":b.clone(),"rh":b}),
            json!({"kind":"intersect","lh":bx([-1.,-1.,0.],[1.;3]),"rh":bx([1.,1.,0.],[1.;3])}),
            json!({"kind":"intersect","lh":bx([-1.;3],[1.;3]),"rh":bx([1.;3],[1.;3])}),
        ];
        for scene in scenes {
            assert!(matches!(
                one_cell(scene),
                Attempt::Reject(
                    "arrangement_zero_only_face" | "arrangement_zero_only_edge_or_point"
                )
            ));
        }
    }
    #[test]
    fn nonmanifold_edge_and_point_contacts_are_rejected() {
        for p in [[1., 1., -1.], [1., 1., 1.]] {
            let s = json!({"kind":"union","children":[bx([-1.;3],[1.;3]),bx(p,[1.;3])]});
            assert!(matches!(
                one_cell(s),
                Attempt::Reject("arrangement_nonmanifold_contact" | "arrangement_crease_incidence")
            ));
        }
    }
    #[test]
    fn f32_sheet_collapse_rejects_but_separated_inexact_planes_remain_embedded() {
        let s = bx([1., 0., 0.], [2_f64.powi(-27), 1., 1.]);
        assert!(matches!(
            one_cell(s),
            Attempt::Reject("arrangement_f32_collapse")
        ));
        let s = bx([0.; 3], [1. + 2_f64.powi(-30), 1., 1.]);
        let Attempt::Ready(plan) = one_cell(s) else {
            panic!("separated inexact planes need only an ordered f32 map")
        };
        let (points, triangles, _) = plan.mesh(None).unwrap();
        let (vertices, triangles) = points.build_mesh(&triangles);
        let topology = super::super::manifold_check::check_manifold(&triangles, true);
        assert!(topology.ok);
        assert_eq!(topology.components, 1);
        assert_eq!(triangles.len(), 36);
        assert!(vertices.chunks_exact(8).all(|p| p[0].abs() == 1.));
        let maximum_rounding = plan
            .cuts
            .iter()
            .flatten()
            .map(|&x| (x - x as f32 as f64).abs())
            .fold(0., f64::max);
        assert_eq!(maximum_rounding, 2_f64.powi(-30));
    }
    #[test]
    fn rank_signs_cover_gaps_without_represented_midpoints() {
        let s = json!({"kind":"union","children":[bx([0.;3],[1.;3]),bx([1.5,0.,0.],[0.5-2_f64.powi(-52),1.,1.])]});
        let tree = crate::scene_bridge::build_csg_tree_from_json(&s.to_string()).unwrap();
        let (_, faces, coords, _) = target(&tree).unwrap();
        assert!(coords[0]
            .windows(2)
            .any(|w| w[0] == 1. && w[1] == 1f64.next_up()));
        assert!(faces.iter().any(|f| f.axis == 0 && f.bounds[0] == 1.));
        assert!(faces
            .iter()
            .any(|f| f.axis == 0 && f.bounds[0] == 1f64.next_up()));
    }
    #[test]
    fn optional_decimal_scope_preserves_fast_path() {
        let tree =
            crate::scene_bridge::build_csg_tree_from_json(&bx([0.3; 3], [0.1; 3]).to_string())
                .unwrap();
        let lat = crate::math::grid::make_lattice(8, -8.125, -8.25, -8.5, 16.);
        let c = SfccCell {
            level: 0,
            ix: 0,
            iy: 0,
            iz: 0,
            key: 0,
            degenerate: false,
            feature_curve: -1,
            feature_corner: -1,
        };
        assert!(matches!(Plan::new(&tree, &lat, &[c]), Attempt::Outside));
        assert!(matches!(
            Plan::new(
                &tree,
                &lat,
                &[SfccCell {
                    degenerate: true,
                    ..c
                }]
            ),
            Attempt::Reject("arrangement_unrepresented_endpoint")
        ));
    }
    #[test]
    fn scope_depth_budget_precedes_recursive_walk() {
        let mut tree =
            crate::scene_bridge::build_csg_tree_from_json(&bx([0.; 3], [1.; 3]).to_string())
                .unwrap();
        for _ in 0..130 {
            tree = CsgNode::Min(vec![tree]);
        }
        let lat = crate::math::grid::make_lattice(8, -8.125, -8.25, -8.5, 16.);
        assert!(matches!(Plan::new(&tree, &lat, &[]), Attempt::Outside));
    }
    #[test]
    fn plane_budget_and_bad_lattice_never_certify() {
        let scene = json!({"kind":"union","children":(0..65).map(|i|bx([i as f64*0.125,0.,0.],[0.03125,1.,1.])).collect::<Vec<_>>()});
        let tree = crate::scene_bridge::build_csg_tree_from_json(&scene.to_string()).unwrap();
        let mut lat = crate::math::grid::make_lattice(8, -8.125, -8.25, -8.5, 32.);
        let c = SfccCell {
            level: 0,
            ix: 0,
            iy: 0,
            iz: 0,
            key: 0,
            degenerate: true,
            feature_curve: -1,
            feature_corner: -1,
        };
        assert!(matches!(
            Plan::new(&tree, &lat, &[c]),
            Attempt::Reject("arrangement_plane_budget")
        ));
        let tree = crate::scene_bridge::build_csg_tree_from_json(&bx([0.; 3], [1.; 3]).to_string())
            .unwrap();
        lat.span += 1;
        assert!(matches!(
            Plan::new(&tree, &lat, &[c]),
            Attempt::Reject("arrangement_grid")
        ));
    }
}
