//! Narrow certificate for a cylinder/chamfer cut of a convex-profile loft.
//! Bounds concern the real equations of represented coefficients. They neither
//! certify feature compilation nor reinterpret normalized_equation as a gradient.
use super::feature_set::SfccFeatureSet;
use crate::{
    math::similarity::Similarity,
    primitives::smin::SminMode,
    sdf::{enclosure::Interval as I, BlendKind, CsgNode, Leaf, Shape},
    strata::LoftSideParams,
};
fn interval(lo: f64, hi: f64) -> Option<I> {
    (lo.is_finite() && hi.is_finite() && lo <= hi).then_some(I { lo, hi })
}
fn mul(a: I, b: I) -> Option<I> {
    let p = [a.lo * b.lo, a.lo * b.hi, a.hi * b.lo, a.hi * b.hi];
    interval(
        p.into_iter().fold(f64::INFINITY, f64::min).next_down(),
        p.into_iter().fold(f64::NEG_INFINITY, f64::max).next_up(),
    )
}
fn div(a: I, x: f64) -> Option<I> {
    if !x.is_finite() || x <= 0. {
        return None;
    }
    interval((a.lo / x).next_down(), (a.hi / x).next_up())
}
fn reciprocal(a: I) -> Option<I> {
    if a.lo <= 0. {
        return None;
    }
    interval((1. / a.hi).next_down(), (1. / a.lo).next_up())
}
fn square(a: I) -> Option<I> {
    let lower = if a.lo <= 0. && a.hi >= 0. {
        0.
    } else {
        a.lo.abs().min(a.hi.abs())
    };
    let upper = a.lo.abs().max(a.hi.abs());
    interval(
        (lower * lower).next_down().max(0.),
        (upper * upper).next_up(),
    )
}
fn norm2(a: I, b: I) -> Option<I> {
    let s = square(a)?.add(square(b)?)?;
    interval(
        s.lo.max(0.).sqrt().next_down().max(0.),
        s.hi.sqrt().next_up(),
    )
}
fn abs_max(a: I) -> f64 {
    a.lo.abs().max(a.hi.abs())
}
fn local(sim: &Similarity, pos: [f64; 3], lo: [f64; 3], hi: [f64; 3]) -> Option<[I; 3]> {
    let mut out = [I::point(0.); 3];
    for j in 0..3 {
        for k in 0..3 {
            out[j] = out[j].add(
                div(interval(lo[k], hi[k])?.sub(I::point(sim.t[k]))?, sim.s)?
                    .mul(sim.r[k * 3 + j])?,
            )?;
        }
        out[j] = out[j].sub(I::point(pos[j]))?;
    }
    Some(out)
}
fn dot(a: [I; 3], b: [I; 3]) -> Option<I> {
    let mut s = I::point(0.);
    for k in 0..3 {
        s = s.add(mul(a[k], b[k])?)?;
    }
    Some(s)
}
fn cross(a: [I; 3], b: [I; 3]) -> Option<[I; 3]> {
    Some([
        mul(a[1], b[2])?.sub(mul(a[2], b[1])?)?,
        mul(a[2], b[0])?.sub(mul(a[0], b[2])?)?,
        mul(a[0], b[1])?.sub(mul(a[1], b[0])?)?,
    ])
}
fn gradient(sim: &Similarity, g: [I; 3]) -> Option<[I; 3]> {
    let mut out = [I::point(0.); 3];
    for k in 0..3 {
        for j in 0..3 {
            out[k] = out[k].add(g[j].mul(sim.r[k * 3 + j])?)?;
        }
        out[k] = div(out[k], sim.s)?;
    }
    Some(out)
}
fn min(a: I, b: I) -> I {
    I {
        lo: a.lo.min(b.lo),
        hi: a.hi.min(b.hi),
    }
}
fn max(a: I, b: I) -> I {
    I {
        lo: a.lo.max(b.lo),
        hi: a.hi.max(b.hi),
    }
}
fn abs(a: I) -> I {
    I {
        lo: if a.lo <= 0. && a.hi >= 0. {
            0.
        } else {
            a.lo.abs().min(a.hi.abs())
        },
        hi: abs_max(a),
    }
}
/// Checked local enclosure only for the supported operand family. Legacy
/// interval_over_box fallbacks are deliberately not certificate premises.
fn bounds(node: &CsgNode, lo: [f64; 3], hi: [f64; 3]) -> Option<I> {
    match node {
        CsgNode::Leaf(leaf) => {
            let Shape::Cylinder { r, h } = leaf.shape else {
                return None;
            };
            if !r.is_finite() || r <= 0. || !h.is_finite() || h <= 0. {
                return None;
            }
            let q = local(&leaf.sim, leaf.pos, lo, hi)?;
            let radial = norm2(q[0], q[2])?.sub(I::point(r))?;
            let axial = abs(q[1]).sub(I::point(h))?;
            let outer = norm2(max(radial, I::point(0.)), max(axial, I::point(0.)))?;
            outer
                .add(min(max(radial, axial), I::point(0.)))?
                .mul(leaf.sim.s)?
                .mul(leaf.sign)
        }
        CsgNode::Min(children) | CsgNode::Max(children) => {
            let mut ranges = children.iter().map(|c| bounds(c, lo, hi));
            let mut result = ranges.next()??;
            for range in ranges {
                result = if matches!(node, CsgNode::Min(_)) {
                    min(result, range?)
                } else {
                    max(result, range?)
                };
            }
            Some(result)
        }
        CsgNode::Blend {
            kind: BlendKind::Smin,
            mode,
            r,
            children,
            ..
        } if children.len() == 2 && r.is_finite() && *r > 0. => {
            let a = bounds(&children[0], lo, hi)?;
            let b = bounds(&children[1], lo, hi)?;
            match mode {
                SminMode::Chamfer => Some(min(
                    min(a, b),
                    a.add(b)?
                        .sub(I::point(*r))?
                        .mul(std::f64::consts::FRAC_1_SQRT_2)?,
                )),
                SminMode::Round => max(I::point(*r), min(a, b)).sub(norm2(
                    max(I::point(*r).sub(a)?, I::point(0.)),
                    max(I::point(*r).sub(b)?, I::point(0.)),
                )?),
                _ => None,
            }
        }
        _ => None,
    }
}
fn active_cylinder<'a>(node: &'a CsgNode, lo: [f64; 3], hi: [f64; 3]) -> Option<&'a Leaf> {
    if let CsgNode::Leaf(leaf) = node {
        return matches!(leaf.shape, Shape::Cylinder { .. }).then_some(leaf);
    }
    match node {
        CsgNode::Min(children) | CsgNode::Max(children) => {
            let ranges: Option<Vec<_>> = children.iter().map(|node| bounds(node, lo, hi)).collect();
            let ranges = ranges?;
            for i in 0..children.len() {
                if (0..children.len()).all(|j| {
                    i == j
                        || if matches!(node, CsgNode::Min(_)) {
                            ranges[i].hi < ranges[j].lo
                        } else {
                            ranges[i].lo > ranges[j].hi
                        }
                }) {
                    return active_cylinder(&children[i], lo, hi);
                }
            }
            None
        }
        CsgNode::Blend {
            kind: BlendKind::Smin,
            mode,
            r,
            children,
            ..
        } if children.len() == 2 => {
            let a = bounds(&children[0], lo, hi)?;
            let b = bounds(&children[1], lo, hi)?;
            let choose = match mode {
                SminMode::Chamfer => {
                    let c = a
                        .add(b)?
                        .sub(I::point(*r))?
                        .mul(std::f64::consts::FRAC_1_SQRT_2)?;
                    if a.hi < b.lo && a.hi < c.lo {
                        Some(0)
                    } else if b.hi < a.lo && b.hi < c.lo {
                        Some(1)
                    } else {
                        None
                    }
                }
                SminMode::Round => {
                    if a.hi < b.lo && b.lo > *r {
                        Some(0)
                    } else if b.hi < a.lo && a.lo > *r {
                        Some(1)
                    } else {
                        None
                    }
                }
                _ => None,
            }?;
            active_cylinder(&children[choose], lo, hi)
        }
        _ => None,
    }
}
fn convex(poly: &[f64]) -> bool {
    let n = poly.len() / 2;
    if n < 3 || poly.len() % 2 != 0 || poly.iter().any(|x| !x.is_finite()) {
        return false;
    }
    let p = |i: usize| [poly[2 * (i % n)], poly[2 * (i % n) + 1]];
    let winding = super::predicates::orient2d(p(0), p(1), p(2));
    winding != 0
        && (0..n).all(|i| {
            (0..n).all(|j| {
                j == i
                    || j == (i + 1) % n
                    || super::predicates::orient2d(p(i), p(i + 1), p(j)) == winding
            })
        })
}
/// Actual lower rectangle edge and upper convex polygon endpoint branch.
fn loft_gradient(
    p: LoftSideParams,
    leaf: &Leaf,
    lo: [f64; 3],
    hi: [f64; 3],
) -> Option<([I; 3], I)> {
    let Shape::Loft { profs, h, .. } = &leaf.shape else {
        return None;
    };
    if profs.len() != 2
        || !convex(&profs[0])
        || !convex(&profs[1])
        || profs[0].len() != 8
        || !h.is_finite()
        || *h <= 0.
    {
        return None;
    }
    let q = local(&p.sim, [p.pos_x, p.pos_y, p.pos_z], lo, hi)?;
    let mut lower = [f64::INFINITY; 2];
    let mut upper = [f64::NEG_INFINITY; 2];
    for v in profs[0].chunks_exact(2) {
        for k in 0..2 {
            lower[k] = lower[k].min(v[k]);
            upper[k] = upper[k].max(v[k]);
        }
    }
    if !profs[0]
        .chunks_exact(2)
        .all(|v| (0..2).all(|k| v[k] == lower[k] || v[k] == upper[k]))
    {
        return None;
    }
    let (axis, normal, offset) = if p.a_x == p.a_x1 && p.a_nz == 0. && p.a_nx.abs() == 1. {
        (0, p.a_nx, p.a_x)
    } else if p.a_z == p.a_z1 && p.a_nx == 0. && p.a_nz.abs() == 1. {
        (1, p.a_nz, p.a_z)
    } else {
        return None;
    };
    if (normal < 0. && offset != lower[axis]) || (normal > 0. && offset != upper[axis]) {
        return None;
    }
    let ends = if axis == 0 {
        [p.a_z, p.a_z1]
    } else {
        [p.a_x, p.a_x1]
    };
    if ends[0].min(ends[1]) != lower[1 - axis] || ends[0].max(ends[1]) != upper[1 - axis] {
        return None;
    }
    let xz = [q[0], q[2]];
    let a = xz[axis].sub(I::point(offset))?.mul(normal)?;
    if a.hi >= 0. {
        return None;
    }
    for k in 0..2 {
        if xz[k].lo <= lower[k] || xz[k].hi >= upper[k] {
            return None;
        }
        for (edge, sign) in [(lower[k], -1.), (upper[k], 1.)] {
            if k == axis && edge == offset {
                continue;
            }
            let other = xz[k].sub(I::point(edge))?.mul(sign)?;
            if other.hi >= a.lo {
                return None;
            }
        }
    }
    let mut vertex = None;
    for v in [[p.b_x, p.b_z], [p.b_x1, p.b_z1]] {
        if !profs[1].chunks_exact(2).any(|p| p == v) {
            continue;
        }
        let d = [xz[0].sub(I::point(v[0]))?, xz[1].sub(I::point(v[1]))?];
        if profs[1].chunks_exact(2).all(|other| {
            if other == v {
                return true;
            }
            I::point(other[0])
                .sub(I::point(v[0]))
                .and_then(|direction| mul(d[0], direction))
                .and_then(|x| x.add(mul(d[1], I::point(other[1]).sub(I::point(v[1]))?)?))
                .is_some_and(|x| x.hi < 0.)
        }) {
            vertex = Some(d);
            break;
        }
    }
    // The raw side must use this actual upper profile edge. Otherwise its
    // endpoint/line branch could differ from the convex polygon distance.
    let upper_count = profs[1].len() / 2;
    if !(0..upper_count).any(|i| {
        let j = (i + 1) % upper_count;
        let ends = [
            [profs[1][i * 2], profs[1][i * 2 + 1]],
            [profs[1][j * 2], profs[1][j * 2 + 1]],
        ];
        ends == [[p.b_x, p.b_z], [p.b_x1, p.b_z1]] || ends == [[p.b_x1, p.b_z1], [p.b_x, p.b_z]]
    }) {
        return None;
    }
    let dx = p.b_x1 - p.b_x;
    let dz = p.b_z1 - p.b_z;
    let length = dx * dx + dz * dz;
    if !length.is_finite() || length < 1e-18 {
        return None;
    }
    let d = vertex?;
    let b = norm2(d[0], d[1])?;
    if b.lo <= 1e-12 {
        return None;
    }
    let line = xz[0]
        .sub(I::point(p.b_x))?
        .mul(p.b_nx)?
        .add(xz[1].sub(I::point(p.b_z))?.mul(p.b_nz)?)?;
    if line.lo <= 0. {
        return None;
    }
    let t = div(q[1].sub(I::point(p.seg_y0))?, p.seg_h)?;
    if t.lo <= 0. || t.hi >= 1. {
        return None;
    }
    let one_minus = I::point(1.).sub(t)?;
    let value = mul(one_minus, a)?.add(mul(t, b)?)?;
    let cap = abs(q[1]).sub(I::point(*h))?;
    if value.lo <= cap.hi {
        return None;
    }
    let inv = reciprocal(b)?;
    let mut g = [I::point(0.); 3];
    for k in 0..2 {
        g[k * 2] = mul(one_minus, I::point(if k == axis { normal } else { 0. }))?
            .add(mul(t, mul(d[k], inv)?)?)?;
    }
    g[1] = div(b.sub(a)?, p.seg_h)?;
    Some((gradient(&p.sim, g)?, value))
}

pub(crate) struct Certificate<'a> {
    pub cylinder: &'a Leaf,
    loft: [I; 3],
    radial: [I; 3],
    prm: LoftSideParams,
    loft_leaf: &'a Leaf,
    radius: I,
    lo: [f64; 3],
    hi: [f64; 3],
}
impl Certificate<'_> {
    fn value(&self, p: [f64; 3]) -> Option<[I; 2]> {
        let q = local(&self.cylinder.sim, self.cylinder.pos, p, p)?;
        let radial = square(q[0])?
            .add(square(q[2])?)?
            .sub(square(self.radius)?)?;
        Some([radial, loft_gradient(self.prm, self.loft_leaf, p, p)?.1])
    }
    /// Krawczyk inclusion supplies existence, in addition to injectivity.
    fn contains_face_root(&self, axis: usize) -> bool {
        if self.lo[axis] != self.hi[axis] || !self.unique_face(axis) {
            return false;
        }
        let axes = [(axis + 1) % 3, (axis + 2) % 3];
        let center = std::array::from_fn(|k| self.lo[k] * 0.5 + self.hi[k] * 0.5);
        let Some(value) = self.value(center) else {
            return false;
        };
        let j = [
            [self.radial[axes[0]], self.radial[axes[1]]],
            [self.loft[axes[0]], self.loft[axes[1]]],
        ];
        let m = j.map(|r| r.map(|x| x.lo * 0.5 + x.hi * 0.5));
        let det = m[0][0] * m[1][1] - m[0][1] * m[1][0];
        if !det.is_finite() || det == 0. {
            return false;
        }
        let c = [
            [m[1][1] / det, -m[0][1] / det],
            [-m[1][0] / det, m[0][0] / det],
        ];
        (0..2).all(|row| {
            let result = (|| {
                let mut k = I::point(center[axes[row]])
                    .sub(value[0].mul(c[row][0])?)?
                    .sub(value[1].mul(c[row][1])?)?;
                for col in 0..2 {
                    let h = I::point(if row == col { 1. } else { 0. })
                        .sub(j[0][col].mul(c[row][0])?.add(j[1][col].mul(c[row][1])?)?)?;
                    let domain = I {
                        lo: self.lo[axes[col]],
                        hi: self.hi[axes[col]],
                    }
                    .sub(I::point(center[axes[col]]))?;
                    k = k.add(mul(h, domain)?)?;
                }
                Some(k)
            })();
            result.is_some_and(|k| k.lo > self.lo[axes[row]] && k.hi < self.hi[axes[row]])
        })
    }
    /// At most one root of the two raw, equivalent equations on this face box.
    /// ||I-CJ||_infinity < 1 implies injectivity on the convex box; C is constant.
    pub(crate) fn unique_face(&self, axis: usize) -> bool {
        if axis >= 3 {
            return false;
        }
        let axes = [(axis + 1) % 3, (axis + 2) % 3];
        let j = [
            [self.radial[axes[0]], self.radial[axes[1]]],
            [self.loft[axes[0]], self.loft[axes[1]]],
        ];
        let m = j.map(|row| row.map(|i| i.lo * 0.5 + i.hi * 0.5));
        let determinant = m[0][0] * m[1][1] - m[0][1] * m[1][0];
        if !determinant.is_finite() || determinant == 0. {
            return false;
        }
        let c = [
            [m[1][1] / determinant, -m[0][1] / determinant],
            [-m[1][0] / determinant, m[0][0] / determinant],
        ];
        (0..2).all(|row| {
            let mut bound = I::point(0.);
            for col in 0..2 {
                let entry = j[0][col]
                    .mul(c[row][0])
                    .and_then(|x| x.add(j[1][col].mul(c[row][1])?))
                    .and_then(|x| I::point(if row == col { 1. } else { 0. }).sub(x));
                let Some(entry) = entry else {
                    return false;
                };
                let Some(next) = bound.add(I::point(abs_max(entry))) else {
                    return false;
                };
                bound = next;
            }
            bound.hi < 1.
        })
    }
}
pub(crate) fn certify<'a>(
    features: &'a SfccFeatureSet,
    a: usize,
    b: usize,
    lo: [f64; 3],
    hi: [f64; 3],
) -> Option<Certificate<'a>> {
    let ca = features.curves.get(a)?;
    let cb = features.curves.get(b)?;
    let common = *ca
        .adjacent_strata
        .iter()
        .find(|id| cb.adjacent_strata.contains(id))?;
    let sa = *ca.adjacent_strata.iter().find(|&&id| id != common)?;
    let sb = *cb.adjacent_strata.iter().find(|&&id| id != common)?;
    if !features.strata[sa].same_exposed_domain(&features.strata[sb])
        || !features.strata[sa].same_loft_field_on_box(&features.strata[sb], lo, hi)
    {
        return None;
    }
    let (prm, node, loft_leaf, level) =
        features.strata[sa].loft_cut_operands(&features.strata[common])?;
    let cylinder = active_cylinder(node, lo, hi)?;
    let Shape::Cylinder { r, h } = cylinder.shape else {
        return None;
    };
    if cylinder.sign != 1. || !r.is_finite() || r <= 0. || !h.is_finite() || h <= 0. {
        return None;
    }
    let radius = I::point(r).add(div(level, cylinder.sim.s)?)?;
    if radius.lo <= 0. {
        return None;
    }
    let q = local(&cylinder.sim, cylinder.pos, lo, hi)?;
    let rho = norm2(q[0], q[2])?;
    let cap = abs(q[1]).sub(I::point(h))?;
    if cap.hi >= 0. || rho.lo <= 0. || rho.sub(I::point(r))?.lo <= cap.hi {
        return None;
    }
    let loft = loft_gradient(prm, loft_leaf, lo, hi)?.0;
    let radial = gradient(&cylinder.sim, [q[0].mul(2.)?, I::point(0.), q[2].mul(2.)?])?;
    let x = std::array::from_fn(|k| I::point(cylinder.sim.r[k * 3]));
    let z = std::array::from_fn(|k| I::point(cylinder.sim.r[k * 3 + 2]));
    let generator = cross(x, z)?;
    let along = dot(loft, generator)?;
    if along.lo <= 0. && along.hi >= 0. {
        return None;
    }
    // One angular chart; the supported local arc cannot wrap the cylinder.
    if q[0].lo <= 0. && q[0].hi >= 0. && q[2].lo <= 0. && q[2].hi >= 0. {
        return None;
    }
    Some(Certificate {
        cylinder,
        loft,
        radial,
        prm,
        loft_leaf,
        radius,
        lo,
        hi,
    })
}

/// A certified root lies strictly inside the same float32 rounding bin as both
/// input pins. The canonical face coordinate is included exactly in the box.
pub(crate) fn quantized_face_root(
    features: &SfccFeatureSet,
    a: usize,
    b: usize,
    axis: usize,
    coord: f64,
    p: [f64; 3],
) -> bool {
    if axis >= 3
        || !coord.is_finite()
        || p.iter().any(|x| !x.is_finite())
        || p[axis] as f32 != coord as f32
    {
        return false;
    }
    let mut lo = [0.; 3];
    let mut hi = [0.; 3];
    for k in 0..3 {
        let x = p[k] as f32;
        if !x.is_finite() || !x.next_down().is_finite() || !x.next_up().is_finite() {
            return false;
        }
        lo[k] = (x.next_down() as f64 + x as f64) * 0.5;
        hi[k] = (x.next_up() as f64 + x as f64) * 0.5;
    }
    lo[axis] = coord;
    hi[axis] = coord;
    certify(features, a, b, lo, hi).is_some_and(|proof| proof.contains_face_root(axis))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        sfcc::{
            feature_curves::{make_traced_curve, TracedRefine},
            field_branches::FieldRef,
            spatial_index::SfccSpatialIndex,
        },
        strata::{Stratum, StratumIdentity},
    };
    fn fixture(translation: f64) -> SfccFeatureSet {
        let cylinder_sim = Similarity {
            r: [1., 0., 0., 0., 0., -1., 0., 1., 0.],
            t: [0., translation, 0.],
            s: 1.,
        };
        let loft_sim = Similarity {
            r: [1., 0., 0., 0., 0., 1., 0., -1., 0.],
            t: [0., translation, 16.],
            s: 1.,
        };
        let lower = vec![-10., -10., 10., -10., 10., 10., -10., 10.];
        let upper = vec![8.8, 0., 0., 8.8, -8.8, 0., 0., -8.8];
        let wind = |v: &[f64]| {
            crate::primitives::polygon2d::winding_sign(
                &v.chunks_exact(2).map(|v| [v[0], v[1]]).collect::<Vec<_>>(),
            )
        };
        let cylinder = Leaf {
            sign: 1.,
            sim: cylinder_sim,
            pos: [0.; 3],
            shape: Shape::Cylinder { r: 8., h: 19. },
            index: 0,
            strata: vec![],
        };
        let loft = Leaf {
            sign: 1.,
            sim: loft_sim,
            pos: [0.; 3],
            shape: Shape::Loft {
                winds: vec![wind(&lower), wind(&upper)],
                profs: vec![lower, upper],
                h: 3.,
            },
            index: 2,
            strata: vec![],
        };
        let root = std::sync::Arc::new(CsgNode::Blend {
            kind: BlendKind::Smin,
            mode: SminMode::Chamfer,
            r: 1.5,
            n: 4.,
            children: vec![CsgNode::Leaf(cylinder), CsgNode::Leaf(loft)],
        });
        let identity = |id| StratumIdentity {
            id,
            owner_node_id: 0,
            leaf_index: 2,
            local_index: id,
            sign: 1.,
        };
        let p = LoftSideParams {
            sim: loft_sim,
            pos_x: 0.,
            pos_y: 0.,
            pos_z: 0.,
            seg_y0: -3.,
            seg_h: 6.,
            a_x: -10.,
            a_z: 10.,
            a_x1: -10.,
            a_z1: -10.,
            a_nx: -1.,
            a_nz: 0.,
            b_x: 0.,
            b_z: 8.8,
            b_x1: -8.8,
            b_z1: 0.,
            b_nx: -std::f64::consts::FRAC_1_SQRT_2,
            b_nz: std::f64::consts::FRAC_1_SQRT_2,
        };
        let other = LoftSideParams {
            b_x: -8.8,
            b_z: 0.,
            b_x1: 0.,
            b_z1: -8.8,
            b_nz: -p.b_nz,
            ..p
        };
        let domain = FieldRef::new(root.clone(), vec![1]);
        let a = Stratum::loft_side(identity(0), p).with_domain(domain.clone());
        let b = Stratum::loft_side(identity(1), other).with_domain(domain);
        let fa = Stratum::field(identity(3), FieldRef::new(root.clone(), vec![0]));
        let fb = Stratum::field(identity(4), FieldRef::new(root, vec![1]));
        let common = Stratum::combination(
            identity(2),
            &fa,
            &fb,
            -1.5 * std::f64::consts::FRAC_1_SQRT_2,
        );
        let strata = vec![a, b, common];
        let curves = (0..2)
            .map(|id| {
                let mut curve = make_traced_curve(
                    id,
                    [2, id],
                    vec![-9.5, translation - 0.1, 16.5, -9.5, translation + 0.1, 16.5],
                    false,
                    strata[2].clone(),
                    strata[id].clone(),
                    TracedRefine {
                        curve_eps: 1e-7,
                        min_cross: 1e-6,
                        max_displacement: 0.1,
                    },
                    0,
                );
                curve.corner_start = 0;
                curve.corner_end = 1;
                curve
            })
            .collect();
        SfccFeatureSet {
            strata,
            curves,
            corners: vec![],
            index: SfccSpatialIndex::new(1.),
            run_id: 0,
            unresolved_branch_paths: vec![],
            trace_diagnostics: Default::default(),
        }
    }
    #[test]
    fn checked_cylinder_loft_root_is_unique_on_transverse_face() {
        let fs = fixture(0.);
        let proof = certify(
            &fs,
            0,
            1,
            [-9.500001, -1e-6, 16.499999],
            [-9.499999, 1e-6, 16.500001],
        )
        .unwrap();
        assert!(proof.unique_face(1));
        assert!(!proof.unique_face(0));
    }
    #[test]
    fn translated_two_root_tangency_is_not_a_shared_face_root() {
        let translation = 1_000_000.;
        let fs = fixture(translation);
        let y = 0.001;
        let x = -(9.5_f64 * 9.5 - y * y).sqrt();
        let a = -x - 10.;
        let b = ((x + 8.8).powi(2) + y * y).sqrt();
        let z = 19. + 6. * a / (b - a);
        let roots = [[x, translation - y, z], [x, translation + y, z]];
        assert_eq!(roots[0].map(|x| x as f32), roots[1].map(|x| x as f32));
        for root in roots {
            let lo = root.map(|x| x - 1e-7);
            let hi = root.map(|x| x + 1e-7);
            assert!(certify(&fs, 0, 1, lo, hi).unwrap().unique_face(0));
        }
        let lo = [x - 1e-7, translation - y - 1e-7, z - 1e-7];
        let hi = [x + 1e-7, translation + y + 1e-7, z + 1e-7];
        assert!(!certify(&fs, 0, 1, lo, hi).unwrap().unique_face(0));
    }
    #[test]
    fn krawczyk_requires_a_root_inside_the_export_rounding_bin() {
        let fs = fixture(0.);
        assert!(quantized_face_root(&fs, 0, 1, 1, 0., [-9.5, 0., 16.5]));
        assert!(!quantized_face_root(
            &fs,
            0,
            1,
            1,
            0.,
            [(-9.5_f32).next_up() as f64, 0., 16.5]
        ));
        let fs = fixture(1_000_000.);
        let y = 0.001;
        let x = -(9.5_f64 * 9.5 - y * y).sqrt();
        let a = -x - 10.;
        let b = ((x + 8.8).powi(2) + y * y).sqrt();
        let z = 19. + 6. * a / (b - a);
        assert!(!quantized_face_root(
            &fs,
            0,
            1,
            0,
            x,
            [x, 1_000_000. + y, z]
        ));
        assert!(quantized_face_root(
            &fs,
            0,
            1,
            1,
            1_000_000.,
            [-9.5, 1_000_000., 16.5]
        ));
    }

    #[test]
    fn unsupported_domains_profiles_and_operand_nodes_reject() {
        let mut fs = fixture(0.);
        let lo = [-9.500001, -1e-6, 16.499999];
        let hi = [-9.499999, 1e-6, 16.500001];
        let different = std::sync::Arc::new(crate::sdf::leaf_at(Shape::Sphere { r: 1. }, [0.; 3]));
        fs.strata[1] = fs.strata[1]
            .clone()
            .with_domain(FieldRef::new(different, vec![]));
        assert!(certify(&fs, 0, 1, lo, hi).is_none());
        assert!(!convex(&[0., 0., 2., 0., 1., 0.5, 2., 2., 0., 2.]));
        assert!(bounds(
            &crate::sdf::leaf_at(Shape::Sphere { r: 1. }, [0.; 3]),
            lo,
            hi
        )
        .is_none());
    }
}
