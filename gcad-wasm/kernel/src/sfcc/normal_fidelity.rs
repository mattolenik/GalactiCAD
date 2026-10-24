//! Bounded sampled normal repair. Fixed vertices and feature charts are not a
//! carrier-ownership certificate; failed transactions publish no partial edits.
use super::{
    feature_set::SfccFeatureSet,
    mesh_edit::{intersects_both, TriangleIndex},
    point_table::PointTable,
    triangle_quality::{self as q, P3},
};
use crate::sdf::{CsgNode, SdfQuery};
use std::collections::{BTreeMap, BTreeSet};

type Tri = [usize; 3];
type Edge = (usize, usize);
type Adjacency = BTreeMap<Edge, Vec<usize>>;
const MAX_FACES: usize = 8;
const MAX_VERTICES: usize = 10;
const MAX_SCORES: usize = 192;
const MAX_FLIPS: usize = 3;
const NORMAL_SITES: [[f64; 3]; 4] = [
    [1. / 3.; 3],
    [0.6, 0.2, 0.2],
    [0.2, 0.6, 0.2],
    [0.2, 0.2, 0.6],
];

#[derive(Clone, Debug, Default, PartialEq)]
pub struct NormalRepairReport {
    pub checked: bool,
    pub seeds: usize,
    pub visited: usize,
    pub passing: usize,
    pub unsupported: usize,
    pub rejected: usize,
    pub exhausted: usize,
    pub accepted: usize,
    pub flips: usize,
    pub staged_flips: usize,
    pub trigger_scores: usize,
    pub chart_observations: usize,
    pub support_observations: usize,
    pub normal_sites: usize,
    pub position_sites: usize,
    pub scores: usize,
    pub trials: usize,
    pub cancelled: bool,
}
impl NormalRepairReport {
    pub fn incomplete(&self) -> bool {
        self.checked
            && (self.cancelled
                || self.unsupported > 0
                || self.rejected > 0
                || self.exhausted > 0
                || self.visited < self.seeds
                || self.seeds > self.passing + self.accepted)
    }
    pub fn to_json(&self) -> String {
        format!(concat!("{{\"scope\":\"sampledNormalTransactions\",\"status\":\"{}\",\"unresolvedPairs\":{},\"seeds\":{},\"visited\":{},",
            "\"passing\":{},\"unsupported\":{},\"rejected\":{},\"exhausted\":{},",
            "\"accepted\":{},\"flips\":{},\"scores\":{},\"trials\":{},\"cancelled\":{},",
            "\"remaining\":{},\"stagedFlips\":{},\"triggerScores\":{},\"maxScoresPerSide\":192,\"maxFlipsPerSide\":3,\"maxPairScores\":384,\"maxPairFlips\":6,\"chartObservations\":{},\"supportObservations\":{},\"normalSites\":{},\"positionSites\":{}}}"),
            if !self.checked { "notChecked" } else if self.incomplete() { "incomplete" } else if self.seeds == 0 { "notApplicable" } else { "sampledPass" },
            self.seeds.saturating_sub(self.passing + self.accepted),
            self.seeds, self.visited, self.passing, self.unsupported, self.rejected,
            self.exhausted, self.accepted, self.flips, self.scores, self.trials, self.cancelled,
            self.seeds.saturating_sub(self.visited),self.staged_flips,self.trigger_scores,self.chart_observations,self.support_observations,self.normal_sites,self.position_sites)
    }
}
#[derive(Clone, Copy, Debug, PartialEq)]
enum Stop {
    Unsupported,
    Rejected,
    Exhausted,
    Cancelled,
}
fn edge(a: usize, b: usize) -> Edge {
    (a.min(b), a.max(b))
}
fn edges(tris: &[Tri]) -> Adjacency {
    let mut out = Adjacency::new();
    for (i, t) in tris.iter().enumerate() {
        for k in 0..3 {
            out.entry(edge(t[k], t[(k + 1) % 3])).or_default().push(i);
        }
    }
    out
}
fn canonical(mut t: Tri) -> Tri {
    let k = if t[0] <= t[1] && t[0] <= t[2] {
        0
    } else if t[1] <= t[2] {
        1
    } else {
        2
    };
    t.rotate_left(k);
    t
}
fn geometry(points: &PointTable, t: Tri) -> [P3; 3] {
    t.map(|i| q::pos(points, i))
}
fn finite_direction(n: P3) -> bool {
    let l = q::norm(n);
    l.is_finite() && l > f64::MIN_POSITIVE
}
fn angle(a: P3, b: P3) -> Option<f64> {
    if !finite_direction(a) || !finite_direction(b) {
        return None;
    }
    let v = (q::dot(a, b) / (q::norm(a) * q::norm(b)))
        .clamp(-1., 1.)
        .acos()
        .to_degrees();
    v.is_finite().then_some(v)
}
fn exposed(tree: &CsgNode, p: P3, eps: f64) -> bool {
    let s = tree.field_sample(p);
    p.iter().all(|v| v.is_finite())
        && s.value.is_finite()
        && finite_direction(s.gradient)
        && s.value.abs() / q::norm(s.gradient) <= eps
}
fn carrier_contains(features: &SfccFeatureSet, id: usize, p: P3, eps: f64) -> bool {
    features.strata.get(id).is_some_and(|s| {
        let f = s.f(p[0], p[1], p[2]);
        f.is_finite()
            && f.abs() <= eps
            && s.domain_contains(p, eps)
            && finite_direction(s.normal(p[0], p[1], p[2]))
    })
}

#[derive(Clone)]
struct Obligation {
    pair: [usize; 2],
    gate: f64,
    minimum_jump: f64,
}
/// Numeric chart order is independent of table-local endpoint IDs. Endpoints
/// retain their exact stored bits and their original physical association.
fn chart_samples(start: f64, end: f64) -> [(f64, Option<usize>); 5] {
    let ((lo, a), (hi, b)) = if start < end {
        ((start, 0), (end, 1))
    } else {
        ((end, 1), (start, 0))
    };
    [
        (lo, Some(a)),
        (lo + 0.25 * (hi - lo), None),
        (lo + 0.5 * (hi - lo), None),
        (lo + 0.75 * (hi - lo), None),
        (hi, Some(b)),
    ]
}
/// Every alias is checked in its own chart, including both endpoints. Sampling
/// three parameters establishes a construction target, not an interval bound.
fn obligations(
    tree: &CsgNode,
    features: &SfccFeatureSet,
    points: &PointTable,
    e: Edge,
    tolerance: f64,
    report: &mut NormalRepairReport,
) -> Result<Vec<Obligation>, Stop> {
    let eps = tolerance * 0.001;
    let mut intervals = points.curve_intervals(e.0, e.1);
    if intervals.is_empty()
        || !eps.is_finite()
        || eps <= 0.
        || intervals
            .iter()
            .any(|i| !i.start.is_finite() || !i.end.is_finite() || i.start == i.end)
    {
        return Err(Stop::Unsupported);
    }
    // Same-curve aliases must not change their early-exit order when worker
    // compaction reverses endpoint IDs. The final tie compares physical points.
    intervals.sort_by(|a, b| {
        a.curve_id
            .cmp(&b.curve_id)
            .then(a.start.min(a.end).total_cmp(&b.start.min(b.end)))
            .then(a.start.max(a.end).total_cmp(&b.start.max(b.end)))
            .then_with(|| {
                let pa = q::pos(points, if a.start < a.end { e.0 } else { e.1 });
                let pb = q::pos(points, if b.start < b.end { e.0 } else { e.1 });
                pa.iter()
                    .zip(pb)
                    .map(|(a, b)| a.total_cmp(&b))
                    .find(|c| !c.is_eq())
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
    let mut out = Vec::new();
    for interval in intervals {
        let curve = features
            .curves
            .get(interval.curve_id)
            .ok_or(Stop::Unsupported)?;
        if curve.adjacent_strata[0] == curve.adjacent_strata[1] {
            return Err(Stop::Unsupported);
        }
        let mut minimum = f64::INFINITY;
        for (parameter, endpoint) in chart_samples(interval.start, interval.end) {
            report.chart_observations += 1;
            let p = curve.point_at_checked(parameter).ok_or(Stop::Unsupported)?;
            if !exposed(tree, p, tolerance * 0.01)
                || !curve
                    .adjacent_strata
                    .iter()
                    .all(|&id| carrier_contains(features, id, p, eps))
            {
                return Err(Stop::Unsupported);
            }
            if let Some(endpoint) = endpoint {
                let retained = q::pos(points, [e.0, e.1][endpoint]);
                if [retained, q::rounded(retained)]
                    .iter()
                    .any(|&q| q::norm(q::sub(q, p)) > eps)
                {
                    return Err(Stop::Unsupported);
                }
            } else {
                let n = curve
                    .adjacent_strata
                    .map(|id| features.strata[id].normal(p[0], p[1], p[2]));
                minimum = minimum.min(angle(n[0], n[1]).ok_or(Stop::Unsupported)?);
            }
        }
        if !minimum.is_finite() {
            return Err(Stop::Unsupported);
        }
        out.push(Obligation {
            pair: curve.adjacent_strata,
            gate: (minimum / 2.).max(2.),
            minimum_jump: minimum,
        });
    }
    Ok(out)
}

/// Full-field proximity cannot choose a side: precisely one adjacent source
/// carrier must contain each normal reference, and it must be the frozen side.
fn source_side(
    tree: &CsgNode,
    features: &SfccFeatureSet,
    pair: [usize; 2],
    p: P3,
    tolerance: f64,
    report: &mut NormalRepairReport,
) -> Result<usize, Stop> {
    report.support_observations += 1;
    if !exposed(tree, p, tolerance * 0.01) {
        return Err(Stop::Unsupported);
    }
    let matches = pair.map(|id| carrier_contains(features, id, p, tolerance * 0.001));
    let side = match matches {
        [true, false] => 0,
        [false, true] => 1,
        _ => return Err(Stop::Unsupported),
    };
    let n = features.strata[pair[side]].normal(p[0], p[1], p[2]);
    if q::dot(n, tree.field_sample(p).gradient) <= 0. {
        return Err(Stop::Unsupported);
    }
    Ok(side)
}
#[derive(Clone)]
struct Contract {
    gate: f64,
    supports: Vec<([usize; 2], usize)>,
}
fn contract(
    tree: &CsgNode,
    features: &SfccFeatureSet,
    points: &PointTable,
    tris: &[Tri],
    tolerance: f64,
    report: &mut NormalRepairReport,
) -> Result<Contract, Stop> {
    let adjacent = edges(tris);
    let mut out = Contract {
        gate: f64::INFINITY,
        supports: Vec::new(),
    };
    for (&e, incident) in &adjacent {
        if !points.edge_is_protected(e.0, e.1) {
            continue;
        }
        for obligation in obligations(tree, features, points, e, tolerance, report)? {
            out.gate = out.gate.min(obligation.gate);
            let mut selected = None;
            for &face in incident {
                for p in [
                    geometry(points, tris[face]),
                    geometry(points, tris[face]).map(q::rounded),
                ] {
                    for weights in NORMAL_SITES {
                        report.normal_sites += 1;
                        let root =
                            q::project(tree, q::bary(p, weights), tolerance, tolerance * 0.0001)
                                .map_err(|_| Stop::Unsupported)?;
                        let side =
                            source_side(tree, features, obligation.pair, root, tolerance, report)?;
                        if selected.is_some_and(|old| old != side) {
                            return Err(Stop::Unsupported);
                        }
                        selected = Some(side);
                    }
                }
            }
            out.supports
                .push((obligation.pair, selected.ok_or(Stop::Unsupported)?));
        }
    }
    if !out.gate.is_finite() || out.supports.is_empty() {
        return Err(Stop::Unsupported);
    }
    out.supports.sort_unstable();
    out.supports.dedup();
    // Interval aliases are mandatory at their own physical edges. Extending
    // every alias carrier to unrelated facet interiors is not justified.
    // Freeze ALL source supports covering the ORIGINAL core observations.
    for &t in tris {
        let p = geometry(points, t);
        for p in [p, p.map(q::rounded)] {
            for w in NORMAL_SITES {
                report.normal_sites += 1;
                let root = q::project(tree, q::bary(p, w), tolerance, tolerance * 0.0001)
                    .map_err(|_| Stop::Unsupported)?;
                out.supports.retain(|&(pair, side)| {
                    source_side(tree, features, pair, root, tolerance, report)
                        .is_ok_and(|s| s == side)
                });
            }
        }
    }
    if out.supports.is_empty() {
        return Err(Stop::Unsupported);
    }
    Ok(out)
}
fn score(
    tree: &CsgNode,
    features: &SfccFeatureSet,
    points: &PointTable,
    t: Tri,
    tolerance: f64,
    contract: &Contract,
    report: &mut NormalRepairReport,
) -> Result<f64, Stop> {
    let original = geometry(points, t);
    if !q::valid_orientation(original, q::normal(original)) {
        return Err(Stop::Unsupported);
    }
    let mut worst = 0_f64;
    for p in [original, original.map(q::rounded)] {
        for w in q::SAMPLES {
            report.position_sites += 1;
            q::project(tree, q::bary(p, w), tolerance, tolerance * 0.001)
                .map_err(|_| Stop::Unsupported)?;
        }
        let normal = q::normal(p);
        for weights in NORMAL_SITES {
            report.normal_sites += 1;
            let root = q::project(tree, q::bary(p, weights), tolerance, tolerance * 0.0001)
                .map_err(|_| Stop::Unsupported)?;
            for &(pair, side) in &contract.supports {
                if source_side(tree, features, pair, root, tolerance, report)? != side {
                    return Err(Stop::Unsupported);
                }
                let n = features.strata[pair[side]].normal(root[0], root[1], root[2]);
                worst = worst.max(angle(normal, n).ok_or(Stop::Unsupported)?);
            }
            worst = worst
                .max(angle(normal, tree.field_sample(root).gradient).ok_or(Stop::Unsupported)?);
        }
    }
    Ok(worst)
}
fn window(
    points: &PointTable,
    tris: &[Tri],
    adjacent: &Adjacency,
    seed: usize,
) -> Result<Vec<usize>, Stop> {
    let mut selected = BTreeSet::from([seed]);
    let mut frontier = vec![seed];
    for _ in 0..2 {
        let mut next = Vec::new();
        for i in frontier {
            let t = tris[i];
            for k in 0..3 {
                let e = edge(t[k], t[(k + 1) % 3]);
                let faces = &adjacent[&e];
                if faces.len() > 2 {
                    return Err(Stop::Unsupported);
                }
                if points.edge_is_protected(e.0, e.1) {
                    continue;
                }
                for &j in faces {
                    if selected.insert(j) {
                        next.push(j);
                    }
                }
            }
        }
        frontier = next;
    }
    let vertices: BTreeSet<_> = selected.iter().flat_map(|&i| tris[i]).collect();
    if selected.len() > MAX_FACES || vertices.len() > MAX_VERTICES {
        return Err(Stop::Exhausted);
    }
    Ok(selected.into_iter().collect())
}
/// An oriented manifold patch may have boundary; each vertex link must be one
/// path or cycle, so disconnected fans and pinches cannot authorize a flip.
fn manifold(tris: &[Tri]) -> bool {
    let mut unique = BTreeSet::new();
    let adjacent = edges(tris);
    for t in tris {
        let mut key = *t;
        key.sort_unstable();
        if key[0] == key[1] || key[1] == key[2] || !unique.insert(key) {
            return false;
        }
    }
    for (&(a, b), incident) in &adjacent {
        if incident.len() > 2 {
            return false;
        }
        if incident.len() == 2 {
            let forward = |t: Tri| (0..3).any(|k| t[k] == a && t[(k + 1) % 3] == b);
            if forward(tris[incident[0]]) == forward(tris[incident[1]]) {
                return false;
            }
        }
    }
    let vertices: BTreeSet<_> = tris.iter().flatten().copied().collect();
    for v in vertices {
        let mut link = BTreeMap::<usize, Vec<usize>>::new();
        for t in tris {
            if let Some(k) = t.iter().position(|&x| x == v) {
                let (a, b) = (t[(k + 1) % 3], t[(k + 2) % 3]);
                link.entry(a).or_default().push(b);
                link.entry(b).or_default().push(a);
            }
        }
        if link.values().any(|n| n.len() > 2) {
            return false;
        }
        let ends = link.values().filter(|n| n.len() == 1).count();
        if ends != 0 && ends != 2 {
            return false;
        }
        let Some(&first) = link.keys().next() else {
            return false;
        };
        let mut seen = BTreeSet::new();
        let mut todo = vec![first];
        while let Some(i) = todo.pop() {
            if seen.insert(i) {
                todo.extend(&link[&i]);
            }
        }
        if seen.len() != link.len() {
            return false;
        }
    }
    true
}
fn locally_embedded(points: &PointTable, tris: &[Tri]) -> bool {
    for (i, &t) in tris.iter().enumerate() {
        let p = geometry(points, t);
        if !q::valid_orientation(p, q::normal(p)) {
            return false;
        }
        for &other in &tris[..i] {
            if intersects_both(p, geometry(points, other), t, other) {
                return false;
            }
        }
    }
    true
}
fn whole_score(
    tree: &CsgNode,
    features: &SfccFeatureSet,
    points: &PointTable,
    tris: &[Tri],
    tolerance: f64,
    contract: &Contract,
    cache: &mut BTreeMap<Tri, Result<f64, Stop>>,
    report: &mut NormalRepairReport,
    max_scores: usize,
) -> Result<f64, Stop> {
    let mut worst = 0_f64;
    for &t in tris {
        if super::cancel::is_cancelled() {
            return Err(Stop::Cancelled);
        }
        let key = canonical(t);
        if !cache.contains_key(&key) {
            if cache.len() >= max_scores {
                return Err(Stop::Exhausted);
            }
            cache.insert(
                key,
                score(tree, features, points, t, tolerance, contract, report),
            );
            report.scores += 1;
        }
        worst = worst.max(cache[&key]?);
    }
    Ok(worst)
}

/// Actual deterministic descent; no fixture search, no public intermediate mesh.
fn descend(
    tree: &CsgNode,
    features: &SfccFeatureSet,
    points: &PointTable,
    initial: &[Tri],
    outside: &BTreeSet<Edge>,
    tolerance: f64,
    contract: &Contract,
    report: &mut NormalRepairReport,
    max_flips: usize,
    max_scores: usize,
    ranks: &[usize],
) -> Result<(Vec<Tri>, usize), Stop> {
    if !manifold(initial) || !locally_embedded(points, initial) {
        return Err(Stop::Unsupported);
    }
    let locked: BTreeSet<_> = edges(initial)
        .into_iter()
        .filter_map(|(e, faces)| {
            (faces.len() == 1 || points.edge_is_protected(e.0, e.1)).then_some(e)
        })
        .collect();
    let mut current = initial.to_vec();
    let mut cache = BTreeMap::new();
    let mut worst = whole_score(
        tree, features, points, &current, tolerance, contract, &mut cache, report, max_scores,
    )?;
    for step in 0..=max_flips {
        if worst <= contract.gate {
            return Ok((current, step));
        }
        if step == max_flips {
            return Err(Stop::Exhausted);
        }
        let adjacent = edges(&current);
        let mut best: Option<(f64, Vec<Tri>)> = None;
        let mut candidates: Vec<_> = adjacent.iter().collect();
        candidates.sort_by_key(|&(e, _)| edge(ranks[e.0], ranks[e.1]));
        for (&e, faces) in candidates {
            if super::cancel::is_cancelled() {
                return Err(Stop::Cancelled);
            }
            if faces.len() != 2 || locked.contains(&e) {
                continue;
            }
            report.trials += 1;
            let (i, j) = (faces[0], faces[1]);
            let a = current[i];
            let b = current[j];
            let Some(k) = (0..3).find(|&k| edge(a[k], a[(k + 1) % 3]) == e) else {
                continue;
            };
            let [u, v, c] = [a[k], a[(k + 1) % 3], a[(k + 2) % 3]];
            let Some(l) = (0..3).find(|&l| b[l] == v && b[(l + 1) % 3] == u) else {
                continue;
            };
            let d = b[(l + 2) % 3];
            if c == d
                || points.edge_is_protected(c, d)
                || adjacent.contains_key(&edge(c, d))
                || outside.contains(&edge(c, d))
            {
                continue;
            }
            let children = [[c, u, d], [d, v, c]];
            let n = q::normal(geometry(points, a));
            let m = q::normal(geometry(points, b));
            if q::dot(n, m) <= 0.
                || children.iter().any(|&t| {
                    let p = geometry(points, t);
                    !q::valid_orientation(p, n) || !q::valid_orientation(p, m)
                })
            {
                continue;
            }
            let mut proposal = current.clone();
            proposal[i] = children[0];
            proposal[j] = children[1];
            if !manifold(&proposal) || !locally_embedded(points, &proposal) {
                continue;
            }
            let value = match whole_score(
                tree, features, points, &proposal, tolerance, contract, &mut cache, report,
                max_scores,
            ) {
                Ok(v) => v,
                Err(Stop::Unsupported | Stop::Rejected) => continue,
                Err(e) => return Err(e),
            };
            if value < worst && best.as_ref().is_none_or(|(old, _)| value < *old) {
                best = Some((value, proposal));
            }
        }
        let Some((value, next)) = best else {
            return Err(Stop::Rejected);
        };
        report.staged_flips += 1;
        worst = value;
        current = next;
    }
    Err(Stop::Rejected)
}

fn final_embedding(
    points: &PointTable,
    proposal: &[Tri],
    selected: &[usize],
    live: &[Tri],
    positions: &[[P3; 3]],
    index: &TriangleIndex,
) -> bool {
    let changed: BTreeSet<_> = selected
        .iter()
        .copied()
        .zip(proposal)
        .filter_map(|(i, &t)| (t != live[i]).then_some(i))
        .collect();
    for (&i, &t) in selected.iter().zip(proposal) {
        if !changed.contains(&i) {
            continue;
        }
        let p = geometry(points, t);
        for j in index.query(p) {
            if changed.contains(&j) {
                continue;
            }
            let g = positions[j];
            if !q::valid_orientation(g, q::normal(g)) || intersects_both(p, g, t, live[j]) {
                return false;
            }
        }
    }
    locally_embedded(points, proposal)
}

fn retained_contrast(a: P3, b: P3, source_jump: f64) -> bool {
    source_jump.is_finite() && angle(a, b).is_some_and(|jump| jump >= source_jump * 0.5)
}
fn face_side(
    tree: &CsgNode,
    features: &SfccFeatureSet,
    pair: [usize; 2],
    p: [P3; 3],
    tolerance: f64,
    gate: f64,
    report: &mut NormalRepairReport,
) -> Option<usize> {
    let mut result = None;
    for w in NORMAL_SITES {
        report.normal_sites += 1;
        let root = q::project(tree, q::bary(p, w), tolerance, tolerance * 0.0001).ok()?;
        let side = source_side(tree, features, pair, root, tolerance, report).ok()?;
        let source_normal = features.strata[pair[side]].normal(root[0], root[1], root[2]);
        if angle(q::normal(p), source_normal)? > gate
            || angle(q::normal(p), tree.field_sample(root).gradient)? > gate
        {
            return None;
        }
        if result.is_some_and(|old| old != side) {
            return None;
        }
        result = Some(side);
    }
    result
}
/// Boundary chords remain fixed, but a changed face can still flatten their
/// dihedral. Include the unchanged face across the boundary in this final gate.
fn protected_pairs(
    tree: &CsgNode,
    features: &SfccFeatureSet,
    points: &PointTable,
    live: &LiveMesh,
    selected: &[usize],
    proposal: &[Tri],
    required: &[(Edge, Vec<Obligation>)],
    tolerance: f64,
    gate: f64,
    report: &mut NormalRepairReport,
) -> bool {
    for (e, required) in required {
        let e = *e;
        let Some(incident) = live.adjacent.get(&e) else {
            return false;
        };
        if incident.len() != 2 {
            return false;
        }
        let mut pair = Vec::new();
        // The incident row itself may change after a flip. Select by the physical
        // edge in the final transaction, not by its old triangle row number.
        for &t in proposal {
            if t.contains(&e.0) && t.contains(&e.1) {
                pair.push(t);
            }
        }
        for &i in incident {
            if !selected.contains(&i) {
                pair.push(live.tris[i]);
            }
        }
        if pair.len() != 2 {
            return false;
        }
        for obligation in required {
            let p = [geometry(points, pair[0]), geometry(points, pair[1])];
            for p in [p, p.map(|t| t.map(q::rounded))] {
                let a = face_side(
                    tree,
                    features,
                    obligation.pair,
                    p[0],
                    tolerance,
                    gate,
                    report,
                );
                let b = face_side(
                    tree,
                    features,
                    obligation.pair,
                    p[1],
                    tolerance,
                    gate,
                    report,
                );
                if !matches!((a, b), (Some(0), Some(1)) | (Some(1), Some(0)))
                    || !retained_contrast(q::normal(p[0]), q::normal(p[1]), obligation.minimum_jump)
                {
                    return false;
                }
            }
        }
    }
    true
}

struct LiveMesh {
    tris: Vec<Tri>,
    positions: Vec<[P3; 3]>,
    index: TriangleIndex,
    adjacent: Adjacency,
    vertex_faces: BTreeMap<usize, BTreeSet<usize>>,
}
impl LiveMesh {
    fn new(points: &PointTable, input: &[usize]) -> Self {
        let tris: Vec<Tri> = input.chunks_exact(3).map(|t| [t[0], t[1], t[2]]).collect();
        let positions: Vec<_> = tris.iter().map(|&t| geometry(points, t)).collect();
        let mut vertex_faces = BTreeMap::<_, BTreeSet<_>>::new();
        for (i, t) in tris.iter().enumerate() {
            for &v in t {
                vertex_faces.entry(v).or_default().insert(i);
            }
        }
        Self {
            adjacent: edges(&tris),
            index: TriangleIndex::new(&positions),
            tris,
            positions,
            vertex_faces,
        }
    }
    fn stars(&self, selected: &[usize], replacement: &[Tri]) -> Vec<Tri> {
        let vertices: BTreeSet<_> = selected.iter().flat_map(|&i| self.tris[i]).collect();
        let faces: BTreeSet<_> = vertices
            .iter()
            .flat_map(|v| self.vertex_faces[v].iter().copied())
            .collect();
        faces
            .into_iter()
            .map(|i| {
                selected
                    .iter()
                    .position(|&j| j == i)
                    .map_or(self.tris[i], |j| replacement[j])
            })
            .collect()
    }
    fn commit(&mut self, points: &mut PointTable, selected: &[usize], replacement: &[Tri]) {
        let key = |mut t: Tri| {
            t.sort_unstable();
            t
        };
        let old_keys: BTreeSet<_> = selected.iter().map(|&i| key(self.tris[i])).collect();
        let new_keys: BTreeSet<_> = replacement.iter().copied().map(key).collect();
        // Preserve companions that merely move rows or rotate cyclically.
        for &t in old_keys.symmetric_difference(&new_keys) {
            points.clear_patch(t);
        }
        for (&i, &t) in selected.iter().zip(replacement) {
            let old = self.tris[i];
            if t == old {
                continue;
            }
            for v in old {
                if let Some(faces) = self.vertex_faces.get_mut(&v) {
                    faces.remove(&i);
                }
            }
            for k in 0..3 {
                let e = edge(old[k], old[(k + 1) % 3]);
                if let Some(faces) = self.adjacent.get_mut(&e) {
                    faces.retain(|&j| j != i);
                }
            }
            self.tris[i] = t;
            self.positions[i] = geometry(points, t);
            self.index.update(i, self.positions[i]);
            for v in t {
                self.vertex_faces.entry(v).or_default().insert(i);
            }
            for k in 0..3 {
                self.adjacent
                    .entry(edge(t[k], t[(k + 1) % 3]))
                    .or_default()
                    .push(i);
            }
        }
        // Empty old diagonals must not block subsequent transactions.
        self.adjacent.retain(|_, faces| !faces.is_empty());
    }
}

#[derive(Clone, Copy)]
struct Limits {
    flips: [usize; 2],
    scores: [usize; 2],
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            flips: [MAX_FLIPS; 2],
            scores: [MAX_SCORES; 2],
        }
    }
}
fn protected(points: &PointTable, tris: &[Tri]) -> BTreeSet<Edge> {
    edges(tris)
        .into_keys()
        .filter(|&(a, b)| points.edge_is_protected(a, b))
        .collect()
}
fn paired_windows(
    points: &PointTable,
    live: &LiveMesh,
    faces: &[usize],
) -> Result<[Vec<usize>; 2], Stop> {
    if faces.len() != 2 {
        return Err(Stop::Unsupported);
    }
    let windows = [
        window(points, &live.tris, &live.adjacent, faces[0])?,
        window(points, &live.tris, &live.adjacent, faces[1])?,
    ];
    if windows[0].iter().any(|i| windows[1].contains(i)) {
        return Err(Stop::Unsupported);
    }
    let vertices: BTreeSet<_> = windows
        .iter()
        .flatten()
        .flat_map(|&i| live.tris[i])
        .collect();
    if windows.iter().map(Vec::len).sum::<usize>() > 2 * MAX_FACES
        || vertices.len() > 2 * MAX_VERTICES - 2
    {
        return Err(Stop::Exhausted);
    }
    Ok(windows)
}
fn outside_edges(live: &LiveMesh, selected: &[usize], old: &[Tri]) -> BTreeSet<Edge> {
    let vertices: BTreeSet<_> = old.iter().flatten().copied().collect();
    let mut outside = BTreeSet::new();
    for &a in &vertices {
        for &b in vertices.range((a + 1)..) {
            let key = edge(a, b);
            if live
                .adjacent
                .get(&key)
                .is_some_and(|f| f.iter().any(|i| !selected.contains(i)))
            {
                outside.insert(key);
            }
        }
    }
    outside
}

pub(crate) fn repair(
    tree: &CsgNode,
    features: &SfccFeatureSet,
    points: &mut PointTable,
    input: &[usize],
    tolerance: f64,
) -> (Vec<usize>, NormalRepairReport) {
    repair_with_limits(tree, features, points, input, tolerance, Limits::default())
}
fn repair_with_limits(
    tree: &CsgNode,
    features: &SfccFeatureSet,
    points: &mut PointTable,
    input: &[usize],
    tolerance: f64,
    limits: Limits,
) -> (Vec<usize>, NormalRepairReport) {
    let mut report = NormalRepairReport {
        checked: true,
        ..Default::default()
    };
    let mut seeds: Vec<_> = points.protected_edges().collect();
    // A finite seed list is visited once; each seed has two independent bounded
    // searches and exactly one atomic publication opportunity.
    report.seeds = seeds.len();
    if seeds.is_empty() {
        return (input.to_vec(), report);
    }
    if seeds
        .iter()
        .any(|&(a, b)| a >= points.count() || b >= points.count())
        || !tolerance.is_finite()
        || tolerance <= 0.
        || input.len() % 3 != 0
        || input.iter().any(|&i| i >= points.count())
        || input
            .iter()
            .any(|&i| !q::pos(points, i).iter().all(|v| v.is_finite()))
    {
        report.unsupported = report.seeds;
        report.visited = report.seeds;
        return (input.to_vec(), report);
    }
    // Metadata can be malformed too; never index ranks before checking the
    // physical endpoints of every protected record.
    let ranks = points.geometric_ranks();
    seeds.sort_by_key(|&(a, b)| edge(ranks[a], ranks[b]));
    let mut live = LiveMesh::new(points, input);
    for e in seeds {
        if super::cancel::is_cancelled() {
            report.cancelled = true;
            break;
        }
        report.visited += 1;
        let attempt = (|| {
            let mut faces = live.adjacent.get(&e).cloned().ok_or(Stop::Unsupported)?;
            if faces.len() != 2 {
                return Err(Stop::Unsupported);
            }
            faces.sort_by_key(|&i| canonical(live.tris[i].map(|v| ranks[v])));
            let seed_old: Vec<_> = faces.iter().map(|&i| live.tris[i]).collect();
            let mut seed_passes = true;
            let mut seed_gate = f64::INFINITY;
            let seed_obligations = vec![(
                e,
                obligations(tree, features, points, e, tolerance, &mut report)?,
            )];
            for &t in &seed_old {
                let c = contract(tree, features, points, &[t], tolerance, &mut report)?;
                report.trigger_scores += 1;
                seed_gate = seed_gate.min(c.gate);
                seed_passes &=
                    score(tree, features, points, t, tolerance, &c, &mut report)? <= c.gate;
            }
            if seed_passes
                && protected_pairs(
                    tree,
                    features,
                    points,
                    &live,
                    &faces,
                    &seed_old,
                    &seed_obligations,
                    tolerance,
                    seed_gate,
                    &mut report,
                )
            {
                return Ok(None);
            }
            let windows = paired_windows(points, &live, &faces)?;
            let selected: Vec<_> = windows.iter().flatten().copied().collect();
            let old: Vec<_> = selected.iter().map(|&i| live.tris[i]).collect();
            if !manifold(&live.stars(&selected, &old)) {
                return Err(Stop::Unsupported);
            }
            let side_old = windows
                .each_ref()
                .map(|ids| ids.iter().map(|&i| live.tris[i]).collect::<Vec<_>>());
            // Both source contracts and the complete protected obligation set are
            // frozen against the SAME live input before either side stages.
            let contracts = [
                contract(tree, features, points, &side_old[0], tolerance, &mut report)?,
                contract(tree, features, points, &side_old[1], tolerance, &mut report)?,
            ];
            let required = protected(points, &old);
            let required_observations: Vec<_> = required
                .iter()
                .map(|&e| {
                    obligations(tree, features, points, e, tolerance, &mut report).map(|o| (e, o))
                })
                .collect::<Result<_, _>>()?;
            let pair_gate = contracts[0].gate.min(contracts[1].gate);
            let mut proposal = Vec::new();
            let mut flips = 0;
            for side in 0..2 {
                let outside = outside_edges(&live, &windows[side], &side_old[side]);
                let (draft, n) = descend(
                    tree,
                    features,
                    points,
                    &side_old[side],
                    &outside,
                    tolerance,
                    &contracts[side],
                    &mut report,
                    limits.flips[side],
                    limits.scores[side],
                    &ranks,
                )?;
                flips += n;
                proposal.extend(draft);
                if super::cancel::is_cancelled() {
                    return Err(Stop::Cancelled);
                }
            }
            if protected(points, &proposal) != required
                || !manifold(&live.stars(&selected, &proposal))
                || !final_embedding(
                    points,
                    &proposal,
                    &selected,
                    &live.tris,
                    &live.positions,
                    &live.index,
                )
                || !protected_pairs(
                    tree,
                    features,
                    points,
                    &live,
                    &selected,
                    &proposal,
                    &required_observations,
                    tolerance,
                    pair_gate,
                    &mut report,
                )
            {
                return Err(Stop::Rejected);
            }
            if super::cancel::is_cancelled() {
                return Err(Stop::Cancelled);
            }
            Ok(Some((selected, proposal, flips)))
        })();
        match attempt {
            Ok(None) => report.passing += 1,
            Ok(Some((selected, proposal, flips))) => {
                live.commit(points, &selected, &proposal);
                report.accepted += 1;
                report.flips += flips;
            }
            Err(Stop::Unsupported) => report.unsupported += 1,
            Err(Stop::Rejected) => report.rejected += 1,
            Err(Stop::Exhausted) => report.exhausted += 1,
            Err(Stop::Cancelled) => {
                report.cancelled = true;
                break;
            }
        }
        if report.cancelled {
            break;
        }
    }
    (live.tris.into_iter().flatten().collect(), report)
}

#[cfg(all(test, feature = "serde"))]
#[path = "normal_fidelity_tests.rs"]
mod tests;
