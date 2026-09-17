//! Local surface charts. A supplied carrier owns the patch; agreement of normals
//! is only a chart check and never used to merge carrier identities.
use super::{
    patch_triangulate,
    point_table::PointTable,
    triangle_quality::{self as q, Rejection, P3},
};
use crate::{sdf::SdfQuery, strata::Stratum};

#[derive(Clone, Copy)]
pub(crate) struct Chart {
    pub axes: [usize; 2],
    pub orientation: i8,
    pub normal: P3,
}
impl Chart {
    pub fn from_boundary(points: &PointTable, boundary: &[usize]) -> Result<Self, Rejection> {
        if boundary.len() < 3 {
            return Err(Rejection::Chart);
        }
        let anchor = q::pos(points, boundary[0]);
        let mut normal = [0.; 3];
        for i in 1..boundary.len() - 1 {
            let n = q::cross(
                q::sub(q::pos(points, boundary[i]), anchor),
                q::sub(q::pos(points, boundary[i + 1]), anchor),
            );
            for k in 0..3 {
                normal[k] += n[k];
            }
        }
        if !normal.iter().all(|v| v.is_finite()) || q::norm(normal) == 0. {
            return Err(Rejection::Chart);
        }
        let axis = (0..3)
            .max_by(|&a, &b| normal[a].abs().total_cmp(&normal[b].abs()))
            .unwrap();
        Ok(Self {
            axes: [(axis + 1) % 3, (axis + 2) % 3],
            orientation: if normal[axis] > 0. { 1 } else { -1 },
            normal,
        })
    }
    pub fn map(&self, p: P3) -> [f64; 2] {
        [p[self.axes[0]], p[self.axes[1]] * self.orientation as f64]
    }
}

/// Triangulate one known disk with immutable boundary. A successful return has
/// no side effects until the caller appends the complete candidate. Unsupported
/// charts stay on the existing route during the staged rollout.
#[cfg(any(test, feature = "sfcc-profile"))]
pub(crate) fn disk<T: SdfQuery + ?Sized>(
    points: &PointTable,
    boundary: &[usize],
    tree: &T,
    carrier: Option<&Stratum>,
    tolerance: f64,
) -> Result<Vec<usize>, Rejection> {
    let chart = Chart::from_boundary(points, boundary)?;
    disk_prepared(points,boundary,tree,carrier,tolerance,chart,&mut Prepared::default())
}

type PreparedGeometry = Result<(Vec<[f64; 2]>, Vec<Vec<[usize; 3]>>), Rejection>;
#[derive(Default)]
struct Prepared {
    geometry: Option<PreparedGeometry>,
    // Most patches have <= 8 boundary points. Larger boundaries simply bypass
    // this bounded projection memo for their remaining points.
    projected: [Option<P3>; 8],
}

/// Keep tolerance-dependent acceptance and projections separate from the chart.
pub(crate) fn disk_strict_or_coarse<T: SdfQuery + ?Sized>(
    points: &PointTable,
    boundary: &[usize],
    tree: &T,
    carrier: Option<&Stratum>,
    tolerance: f64,
) -> Result<Vec<usize>, Rejection> {
    #[cfg(feature = "sfcc-profile")]
    if super::perf::disabled(8) {
        return disk(points, boundary, tree, carrier, tolerance)
            .or_else(|_| { super::perf::add(9, 1); disk(points, boundary, tree, carrier, tolerance * 8.) });
    }
    let chart = Chart::from_boundary(points, boundary)?;
    let mut prepared = Prepared::default();
    disk_prepared(
        points,
        boundary,
        tree,
        carrier,
        tolerance,
        chart,
        &mut prepared,
    )
    .or_else(|_| {
        super::perf::add(9, 1);
        disk_prepared(
            points,
            boundary,
            tree,
            carrier,
            tolerance * 8.,
            chart,
            &mut prepared,
        )
    })
}

fn disk_prepared<T: SdfQuery + ?Sized>(
    points: &PointTable,
    boundary: &[usize],
    tree: &T,
    carrier: Option<&Stratum>,
    tolerance: f64,
    chart: Chart,
    prepared: &mut Prepared,
) -> Result<Vec<usize>, Rejection> {
    if let Some(carrier) = carrier {
        for (index, &id) in boundary.iter().enumerate() {
            let p = q::pos(points, id);
            let y = if let Some(y) = prepared.projected.get(index).copied().flatten() {
                super::perf::add(15, 1);
                y
            } else {
                let y = carrier.project(p[0], p[1], p[2]);
                if y.iter().all(|v| v.is_finite()) {
                    if let Some(slot) = prepared.projected.get_mut(index) { *slot = Some(y); }
                }
                y
            };
            if !y.iter().all(|v| v.is_finite())
                || q::norm(q::sub(y, p)) > tolerance * 0.1
                || !carrier.domain_contains(y, tolerance * 0.01)
            {
                return Err(Rejection::Ownership);
            }
        }
    }
    if super::cancel::is_cancelled() { return Err(Rejection::Budget); }
    let (xy, candidates) = prepared.geometry
        .get_or_insert_with(|| {
            super::perf::add(8, 1);
            let xy: Vec<_> = boundary
                .iter()
                .map(|&i| chart.map(q::pos(points, i)))
                .collect();
            let local = patch_triangulate::triangulate(&xy, &[(0..boundary.len()).collect()])?;
            let candidates = if boundary.len() == 4 {
                vec![vec![[0, 1, 2], [0, 2, 3]], vec![[1, 2, 3], [1, 3, 0]]]
            } else {
                vec![local]
            };
            Ok((xy, candidates))
        })
        .as_ref()
        .map_err(|e| *e)?;
    let mut best: Option<(f64, f64, Vec<usize>)> = None;
    for local in candidates {
        let attempt = (|| -> Result<(f64, f64, Vec<usize>), Rejection> {
            let mut out = Vec::with_capacity(local.len() * 3);
            let mut shape = f64::INFINITY;
            let mut error = 0_f64;
            for t in local {
                if super::predicates::orient2d(xy[t[0]], xy[t[1]], xy[t[2]]) <= 0 {
                    return Err(Rejection::Chart);
                }
                let ids = t.map(|i| boundary[i]);
                let p = ids.map(|i| q::pos(points, i));
                if !q::valid_orientation(p, chart.normal) {
                    return Err(Rejection::Orientation);
                }
                shape = shape.min(q::quality(p));
                for w in q::SAMPLES {
                    let x = q::bary(p, w);
                    let y = if let Some(s) = carrier {
                        let y = s.project(x[0], x[1], x[2]);
                        if !s.domain_contains(y, tolerance * 0.01) {
                            return Err(Rejection::Ownership);
                        }
                        y
                    } else {
                        q::project(tree, x, tolerance, tolerance * 0.001)?
                    };
                    let displacement = q::norm(q::sub(x, y));
                    error = error.max(displacement);
                    if !y.iter().all(|v| v.is_finite()) || displacement > tolerance {
                        return Err(Rejection::Displacement);
                    }
                    let f = tree.field_sample(y);
                    let len = q::norm(f.gradient);
                    if len == 0.
                        || !len.is_finite()
                        || !f.value.is_finite()
                        || f.value.abs() / len > tolerance * 0.01
                    {
                        return Err(Rejection::Ownership);
                    }
                    let patch_gradient = carrier.map_or(f.gradient, |s| s.normal(y[0], y[1], y[2]));
                    if q::dot(patch_gradient, chart.normal)
                        <= 0.5 * q::norm(patch_gradient) * q::norm(chart.normal)
                    {
                        return Err(Rejection::Chart);
                    }
                }
                q::deviation(tree, p.map(q::rounded), tolerance)?;
                out.extend_from_slice(&ids);
            }
            Ok((shape, error, out))
        })();
        if let Ok((shape, error, out)) = attempt {
            if best
                .as_ref()
                .is_none_or(|(s, e, _)| shape > *s || shape == *s && error < *e)
            {
                best = Some((shape, error, out));
            }
        }
    }
    best.map(|(_, _, out)| out).ok_or(Rejection::Chart)
}

/// Multiple coplanar rings on a single analytical carrier. Oppositely wound
/// contained loops are holes; disjoint positive loops are separate components.
/// Intersecting/touching/nested-hole ambiguity is rejected by the triangulator.
pub(crate) fn planar_domains<T: SdfQuery + ?Sized>(
    points: &PointTable,
    loops: &[Vec<usize>],
    tree: &T,
    carrier: &Stratum,
    tol: f64,
) -> Result<Vec<usize>, Rejection> {
    if carrier.planar_coefficients().is_none() || loops.is_empty() {
        return Err(Rejection::Chart);
    }
    let chart = Chart::from_boundary(points, &loops[0])?;
    let ids: Vec<_> = loops.iter().flatten().copied().collect();
    let xy: Vec<_> = ids.iter().map(|&i| chart.map(q::pos(points, i))).collect();
    for &id in &ids {
        let p = q::pos(points, id);
        let y = carrier.project(p[0], p[1], p[2]);
        if q::norm(q::sub(y, p)) > tol * 0.001 || !carrier.domain_contains(y, tol * 0.001) {
            return Err(Rejection::Ownership);
        }
    }
    let mut start = 0;
    let rings: Vec<Vec<usize>> = loops
        .iter()
        .map(|l| {
            let r = (start..start + l.len()).collect();
            start += l.len();
            r
        })
        .collect();
    let mut parent: Vec<Option<usize>> = vec![None; rings.len()];
    for i in 0..rings.len() {
        for j in 0..rings.len() {
            if i != j && super::patch_triangulate::contains(xy[rings[i][0]], &rings[j], &xy) {
                if let Some(k) = parent[i] {
                    if !super::patch_triangulate::contains(xy[rings[j][0]], &rings[k], &xy) {
                        continue;
                    }
                }
                parent[i] = Some(j);
            }
        }
    }
    let mut out = Vec::new();
    for i in 0..rings.len() {
        if parent[i].is_some() {
            continue;
        }
        let mut group = vec![rings[i].clone()];
        for j in 0..rings.len() {
            if parent[j] == Some(i) {
                if parent.iter().any(|&p| p == Some(j)) {
                    return Err(Rejection::Chart);
                }
                group.push(rings[j].clone());
            }
        }
        let local = super::patch_triangulate::triangulate(&xy, &group)?;
        let orientation = Chart::from_boundary(points, &loops[i])?.normal;
        for t in local {
            let mut t = t.map(|k| ids[k]);
            let p = t.map(|v| q::pos(points, v));
            if q::dot(q::normal(p), orientation) < 0. {
                t.swap(0, 1);
            }
            let p = t.map(|v| q::pos(points, v));
            super::quality_remesh::validate(tree, carrier, p, orientation, tol)?;
            out.extend(t);
        }
    }
    // Preserve the exact directed input segments. Reversed hole orientation
    // cannot silently turn a separate inward-facing patch into a hole.
    let mut incidence = std::collections::BTreeMap::<(usize, usize), usize>::new();
    for t in out.chunks_exact(3) {
        for k in 0..3 {
            *incidence.entry((t[k], t[(k + 1) % 3])).or_default() += 1;
        }
    }
    for l in loops {
        for k in 0..l.len() {
            if incidence.get(&(l[k], l[(k + 1) % l.len()])) != Some(&1)
                || incidence.contains_key(&(l[(k + 1) % l.len()], l[k]))
            {
                return Err(Rejection::Topology);
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::super::feature_set::compile_native_features;
    use super::*;
    use crate::sdf::{leaf_at, subtract, Shape};
    #[test]
    fn planar_annulus_lifts_to_the_exposed_cut_surface() {
        let tree = subtract(
            leaf_at(Shape::Cuboid { half: [2., 2., 1.] }, [0.; 3]),
            leaf_at(Shape::Cuboid { half: [1., 1., 2.] }, [0.; 3]),
        );
        let features = compile_native_features(&tree);
        let carrier = features
            .strata
            .iter()
            .find(|s| s.f(1.5, 1.5, 1.).abs() < 1e-12 && s.normal(1.5, 1.5, 1.)[2] > 0.9)
            .unwrap();
        let mut p = PointTable::new();
        for [x, y] in [
            [-2., -2.],
            [2., -2.],
            [2., 2.],
            [-2., 2.],
            [-1., -1.],
            [-1., 1.],
            [1., 1.],
            [1., -1.],
        ] {
            p.add(x, y, 1., 0., 0., 1.);
        }
        let out = planar_domains(
            &p,
            &[vec![0, 1, 2, 3], vec![4, 5, 6, 7]],
            &tree,
            carrier,
            1e-6,
        )
        .unwrap();
        assert_eq!(out.len(), 24);
        let area: f64 = out
            .chunks_exact(3)
            .map(|t| {
                q::norm(q::normal([
                    q::pos(&p, t[0]),
                    q::pos(&p, t[1]),
                    q::pos(&p, t[2]),
                ])) * 0.5
            })
            .sum();
        assert_eq!(area, 12.);
        // Reversing only the inner loop must be rejected, not silently repaired.
        assert!(planar_domains(
            &p,
            &[vec![0, 1, 2, 3], vec![7, 6, 5, 4]],
            &tree,
            carrier,
            1e-6
        )
        .is_err());
    }
    #[test]
    fn concave_quad_uses_the_only_interior_diagonal() {
        let tree = leaf_at(
            Shape::Cuboid {
                half: [10., 10., 1.],
            },
            [0.; 3],
        );
        let features = compile_native_features(&tree);
        let carrier = features
            .strata
            .iter()
            .find(|s| s.f(0., 0., 1.).abs() < 1e-12 && s.normal(0., 0., 1.)[2] > 0.9)
            .unwrap();
        let mut p = PointTable::new();
        for [x, y] in [[0., 0.], [4., 0.], [0.5, 0.5], [0., 4.]] {
            p.add(x, y, 1., 0., 0., 1.);
        }
        let out = disk(&p, &[0, 1, 2, 3], &tree, Some(carrier), 1e-6).unwrap();
        for t in out.chunks_exact(3) {
            assert!(t.contains(&0) && t.contains(&2));
        }
    }
    #[test]
    fn cylindrical_quad_rejects_the_shorter_but_inaccurate_diagonal() {
        let tree = leaf_at(Shape::Cylinder { r: 1., h: 20. }, [0.; 3]);
        let features = compile_native_features(&tree);
        let carrier = features
            .strata
            .iter()
            .find(|s| s.kind == crate::strata::CarrierKind::Cylinder)
            .unwrap();
        let a = 0.1_f64;
        let mut p = PointTable::new();
        for x in [
            [1., -10., 0.],
            [a.cos(), 0., -a.sin()],
            [1., 10., 0.],
            [a.cos(), 0., a.sin()],
        ] {
            p.add(x[0], x[1], x[2], x[0], 0., x[2]);
        }
        for start in 0..4 {
            let mut boundary = vec![0, 1, 2, 3];
            boundary.rotate_left(start);
            let out = disk(&p, &boundary, &tree, Some(carrier), 0.003).unwrap();
            assert_eq!(out.len(), 6);
            for t in out.chunks_exact(3) {
                assert!(t.contains(&0) && t.contains(&2));
            }
        }
    }
}

/// These carriers have a single regular local sheet under the chart's normal
/// spread check. General implicit fields, twisted/lofted carriers and curved
/// compound equations need branch continuation before relocating their points.
pub(crate) fn supports_local_edits(carrier: &Stratum) -> bool {
    matches!(
        carrier.kind,
        crate::strata::CarrierKind::Plane
            | crate::strata::CarrierKind::Sphere
            | crate::strata::CarrierKind::Cylinder
            | crate::strata::CarrierKind::Cone
    ) || carrier.planar_coefficients().is_some()
}

#[cfg(test)]
mod preparation_tests {
    use super::*;
    #[test]
    fn coarse_retry_matches_separate_attempts() {
        use crate::sdf::{leaf_at, Shape};
        let tree = leaf_at(Shape::Cuboid { half: [2., 2., 1.] }, [0.; 3]);
        let features = super::super::feature_set::compile_native_features(&tree);
        let carrier = features
            .strata
            .iter()
            .find(|s| s.f(0., 0., 1.).abs() < 1e-12 && s.normal(0., 0., 1.)[2] > 0.9)
            .unwrap();
        for offset in [0., 0.0002, 0.2] {
            let mut points = PointTable::new();
            for [x, y] in [[-1., -1.], [1., -1.], [1., 1.], [-1., 1.]] {
                points.add(x, y, 1. + offset, 0., 0., 1.);
            }
            let boundary = [0, 1, 2, 3];
            let old = disk(&points, &boundary, &tree, Some(carrier), 0.001)
                .or_else(|_| disk(&points, &boundary, &tree, Some(carrier), 0.008));
            assert_eq!(
                disk_strict_or_coarse(&points, &boundary, &tree, Some(carrier), 0.001),
                old
            );
        }
    }
}
