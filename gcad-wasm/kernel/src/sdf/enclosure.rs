//! Enclosures of the real field defined by the represented affine coefficients.
//! No matrix orthogonality or library hypot accuracy is assumed. See the proof.
use super::{Leaf, Shape};

pub(super) fn invalid_interval() -> (f64, f64) {
    (f64::NAN, f64::NAN)
}
pub(super) fn valid_interval((lo, hi): (f64, f64)) -> bool {
    lo.is_finite() && hi.is_finite() && lo <= hi
}

#[derive(Clone, Copy)]
pub(crate) struct Interval {
    pub lo: f64,
    pub hi: f64,
}
impl Interval {
    pub(crate) fn point(x: f64) -> Self {
        Self { lo: x, hi: x }
    }
    fn checked(lo: f64, hi: f64) -> Option<Self> {
        if valid_interval((lo, hi)) {
            Some(Self { lo, hi })
        } else {
            None
        }
    }
    pub(crate) fn add(self, b: Self) -> Option<Self> {
        Self::checked((self.lo + b.lo).next_down(), (self.hi + b.hi).next_up())
    }
    pub(crate) fn sub(self, b: Self) -> Option<Self> {
        Self::checked((self.lo - b.hi).next_down(), (self.hi - b.lo).next_up())
    }
    pub(crate) fn mul(self, x: f64) -> Option<Self> {
        if x == 0. {
            return Some(Self::point(0.));
        }
        let (a, b) = if x > 0. {
            (self.lo * x, self.hi * x)
        } else {
            (self.hi * x, self.lo * x)
        };
        Self::checked(a.next_down(), b.next_up())
    }
    fn abs(self) -> Self {
        if self.lo >= 0. {
            self
        } else if self.hi <= 0. {
            Self {
                lo: -self.hi,
                hi: -self.lo,
            }
        } else {
            Self {
                lo: 0.,
                hi: (-self.lo).max(self.hi),
            }
        }
    }
}

// Scaled Euclidean norm: each operation is rounded outward. Unlike hypot, sqrt
// has a correct-rounding contract. Scaling prevents avoidable squared overflow.
fn norm(v: [f64; 3], upper: bool) -> Option<f64> {
    let m = v.into_iter().fold(0., f64::max);
    if m == 0. {
        return Some(0.);
    }
    let round = |x: f64| {
        if upper {
            x.next_up()
        } else {
            x.next_down().max(0.)
        }
    };
    let mut sum = 0.;
    for x in v {
        let q = round(x / m);
        sum = round(sum + round(q * q));
    }
    let n = round(round(sum.sqrt()) * m);
    n.is_finite().then_some(n)
}

// Keep a sphere's radial geometry rather than replacing a rotated query by a
// loose local AABB. The defect bound uses the *represented* matrix, not a claim
// that its columns are orthonormal. Failure falls back to the affine enclosure.
fn sphere_metric(leaf: &Leaf, radius: f64, c: [f64; 3], half: [f64; 3]) -> Option<Interval> {
    let r = &leaf.sim.r;
    let mut defect = 0.0f64;
    for i in 0..3 {
        let mut row_bound = Interval::point(0.);
        for j in 0..3 {
            let mut dot = Interval::point(0.);
            for k in 0..3 {
                dot = dot.add(Interval::point(r[i * 3 + k]).mul(r[j * 3 + k])?)?;
            }
            let error = dot
                .sub(Interval::point(if i == j { 1. } else { 0. }))?
                .abs()
                .hi;
            row_bound = row_bound.add(Interval::point(error))?;
        }
        defect = defect.max(row_bound.hi);
    }
    // A large defect makes the radial bound unhelpful, not invalid geometry.
    if defect >= 1. {
        return None;
    }
    let lower_factor = (1. - defect).next_down().max(0.).sqrt().next_down().max(0.);
    let upper_factor = (1. + defect).next_up().sqrt().next_up();
    let mut rotated_pos = [Interval::point(0.); 3];
    for i in 0..3 {
        for k in 0..3 {
            rotated_pos[i] = rotated_pos[i].add(Interval::point(leaf.pos[k]).mul(r[i * 3 + k])?)?;
        }
    }
    let mut world = [Interval::point(0.); 3];
    let mut residual = [0.; 3];
    for a in 0..3 {
        let center = rotated_pos[a]
            .mul(leaf.sim.s)?
            .add(Interval::point(leaf.sim.t[a]))?;
        world[a] = Interval::point(c[a])
            .add(Interval {
                lo: -half[a],
                hi: half[a],
            })?
            .sub(center)?
            .abs();
        let mut q = Interval::point(0.);
        for b in 0..3 {
            q = q.add(rotated_pos[b].mul(r[b * 3 + a])?)?;
        }
        residual[a] = q
            .sub(Interval::point(leaf.pos[a]))?
            .mul(leaf.sim.s)?
            .abs()
            .hi;
    }
    let residual = norm(residual, true)?;
    let near = norm(world.map(|v| v.lo), false)?;
    let far = norm(world.map(|v| v.hi), true)?;
    let lo = ((near * lower_factor).next_down().max(0.) - residual)
        .next_down()
        .max(0.);
    let hi = ((far * upper_factor).next_up() + residual).next_up();
    Interval::checked(lo, hi)?.sub(Interval::point(radius).mul(leaf.sim.s)?)
}

fn signed_permutation(r: &[f64; 9]) -> bool {
    (0..3).all(|a| {
        (0..3).filter(|&b| r[a * 3 + b].abs() == 1.).count() == 1
            && (0..3).filter(|&b| r[b * 3 + a].abs() == 1.).count() == 1
    }) && r.iter().all(|x| *x == 0. || x.abs() == 1.)
}

pub(super) fn primitive(leaf: &Leaf, c: [f64; 3], half: [f64; 3]) -> Option<(f64, f64)> {
    if !leaf.valid_parameters()
        || c.iter().any(|x| !x.is_finite())
        || half.iter().any(|x| !x.is_finite() || *x < 0.)
    {
        return None;
    }
    if let Shape::Sphere { r } = leaf.shape {
        if !signed_permutation(&leaf.sim.r) {
            if let Some(result) = sphere_metric(leaf, r, c, half) {
                return Some(if leaf.sign < 0. {
                    (-result.hi, -result.lo)
                } else {
                    (result.lo, result.hi)
                });
            }
        }
    }
    // Homogeneity removes division by scale without changing the real field:
    // s*phi(R^T(p-t)/s-pos) = phi_scaled(R^T(p-t)-s*pos).
    let mut delta = [Interval::point(0.); 3];
    for a in 0..3 {
        delta[a] = Interval::point(c[a])
            .add(Interval {
                lo: -half[a],
                hi: half[a],
            })?
            .sub(Interval::point(leaf.sim.t[a]))?;
    }
    let mut q = [Interval::point(0.); 3];
    for a in 0..3 {
        let mut row = Interval::point(0.);
        for b in 0..3 {
            row = row.add(delta[b].mul(leaf.sim.r[b * 3 + a])?)?;
        }
        q[a] = row
            .sub(Interval::point(leaf.pos[a]).mul(leaf.sim.s)?)?
            .abs();
    }
    let result = match leaf.shape {
        Shape::Sphere { r } => {
            let d = Interval {
                lo: norm(q.map(|v| v.lo), false)?,
                hi: norm(q.map(|v| v.hi), true)?,
            };
            d.sub(Interval::point(r).mul(leaf.sim.s)?)?
        }
        Shape::Cuboid { half: h } => {
            for a in 0..3 {
                q[a] = q[a].sub(Interval::point(h[a]).mul(leaf.sim.s)?)?;
            }
            let outside = Interval {
                lo: norm(q.map(|v| v.lo.max(0.)), false)?,
                hi: norm(q.map(|v| v.hi.max(0.)), true)?,
            };
            let inside = Interval {
                lo: q
                    .iter()
                    .map(|v| v.lo)
                    .fold(f64::NEG_INFINITY, f64::max)
                    .min(0.),
                hi: q
                    .iter()
                    .map(|v| v.hi)
                    .fold(f64::NEG_INFINITY, f64::max)
                    .min(0.),
            };
            outside.add(inside)?
        }
        _ => return None,
    };
    Some(if leaf.sign < 0. {
        (-result.hi, -result.lo)
    } else {
        (result.lo, result.hi)
    })
}

/// A real center/half box containing both represented endpoints, including the
/// rounded midpoint and subtraction. No endpoint comparison is used as a proof.
pub(crate) fn enclosing_box(lo: [f64; 3], hi: [f64; 3]) -> Option<([f64; 3], [f64; 3])> {
    let mut c = [0.; 3];
    let mut half = [0.; 3];
    for a in 0..3 {
        if !lo[a].is_finite() || !hi[a].is_finite() || lo[a] > hi[a] {
            return None;
        }
        if lo[a] == hi[a] {
            c[a] = lo[a];
            continue;
        }
        c[a] = lo[a] * 0.5 + hi[a] * 0.5;
        half[a] = Interval::point(c[a])
            .sub(Interval::point(lo[a]))?
            .hi
            .max(Interval::point(hi[a]).sub(Interval::point(c[a]))?.hi);
    }
    Some((c, half))
}
