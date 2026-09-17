//! Filtered predicates with exact dyadic-integer fallback for finite binary64
//! inputs. The filtering strategy follows Shewchuk (1997),
//! https://www.cs.cmu.edu/~quake/robust.html. The fallback below is an independent
//! signed-magnitude implementation, not a port of Triangle or its licensing.
//! No epsilon is used to turn a small nonzero determinant into collinearity.

// Most finite-coordinate determinants need only a handful of limbs. Spill
// without a size limit for extreme exponent spreads; all arithmetic stays exact.
#[derive(Clone)]
struct Limbs {
    inline: [u64; 8],
    len: usize,
    heap: Option<Vec<u64>>,
}
impl Limbs {
    fn zeros(len: usize) -> Self {
        super::perf::maximum(7, len);
        if len > 8 {
            super::perf::add(6, 1);
        }
        Self {
            inline: [0; 8],
            len,
            heap: (len > 8).then(|| vec![0; len]),
        }
    }
    fn single(v: u64) -> Self {
        let mut out = Self::zeros(usize::from(v != 0));
        if v != 0 {
            out[0] = v;
        }
        out
    }
    fn resize(&mut self, len: usize, value: u64) {
        super::perf::maximum(7, len);
        if let Some(heap) = &mut self.heap {
            heap.resize(len, value);
        } else if len > 8 {
            super::perf::add(6, 1);
            let mut heap = self.inline[..self.len].to_vec();
            heap.resize(len, value);
            self.heap = Some(heap);
        } else if len > self.len {
            self.inline[self.len..len].fill(value);
        }
        self.len = len;
    }
    fn pop(&mut self) {
        if self.len > 0 {
            if let Some(heap) = &mut self.heap {
                heap.pop();
            }
            self.len -= 1;
        }
    }
}
impl std::ops::Deref for Limbs {
    type Target = [u64];
    fn deref(&self) -> &[u64] {
        self.heap
            .as_deref()
            .unwrap_or(&self.inline[..self.len.min(8)])
    }
}
impl std::ops::DerefMut for Limbs {
    fn deref_mut(&mut self) -> &mut [u64] {
        if let Some(heap) = &mut self.heap {
            heap
        } else {
            &mut self.inline[..self.len]
        }
    }
}

#[derive(Clone)]
struct Dyadic {
    negative: bool,
    exponent: i32,
    limbs: Limbs,
}
impl Dyadic {
    fn from(x: f64) -> Self {
        assert!(x.is_finite());
        let bits = x.to_bits();
        let e = ((bits >> 52) & 2047) as i32;
        let m = (bits & ((1_u64 << 52) - 1)) | if e == 0 { 0 } else { 1_u64 << 52 };
        Self {
            negative: bits >> 63 != 0,
            exponent: if e == 0 { -1074 } else { e - 1075 },
            limbs: Limbs::single(m),
        }
    }
    fn sign(&self) -> i8 {
        if self.limbs.is_empty() {
            0
        } else if self.negative {
            -1
        } else {
            1
        }
    }
    fn shifted(&self, exponent: i32) -> Limbs {
        if self.limbs.is_empty() {
            return Limbs::zeros(0);
        }
        let shift = (self.exponent - exponent) as usize;
        let mut out = Limbs::zeros(self.limbs.len() + shift / 64 + 1);
        for (i, &v) in self.limbs.iter().enumerate() {
            out[i + shift / 64] |= v << (shift % 64);
            if shift % 64 != 0 {
                out[i + shift / 64 + 1] |= v >> (64 - shift % 64);
            }
        }
        trim(&mut out);
        out
    }
    fn add(&self, b: &Self) -> Self {
        self.add_signed(b, b.negative)
    }
    fn add_signed(&self, b: &Self, b_negative: bool) -> Self {
        let exponent = self.exponent.min(b.exponent);
        let mut a = self.shifted(exponent);
        let mut b_limbs = b.shifted(exponent);
        let mut negative = self.negative;
        if self.negative == b_negative {
            a.resize(a.len().max(b_limbs.len()) + 1, 0);
            let mut carry = 0_u128;
            for (i, x) in a.iter_mut().enumerate() {
                let sum = *x as u128 + b_limbs.get(i).copied().unwrap_or(0) as u128 + carry;
                *x = sum as u64;
                carry = sum >> 64;
            }
        } else {
            if a.len()
                .cmp(&b_limbs.len())
                .then_with(|| a.iter().rev().cmp(b_limbs.iter().rev()))
                .is_lt()
            {
                std::mem::swap(&mut a, &mut b_limbs);
                negative = b_negative;
            }
            let mut borrow = false;
            for (i, x) in a.iter_mut().enumerate() {
                let (v, b1) = x.overflowing_sub(b_limbs.get(i).copied().unwrap_or(0));
                let (v, b2) = v.overflowing_sub(borrow as u64);
                *x = v;
                borrow = b1 || b2;
            }
            debug_assert!(!borrow);
        }
        trim(&mut a);
        Self {
            negative,
            exponent,
            limbs: a,
        }
    }
    fn sub(&self, b: &Self) -> Self {
        self.add_signed(b, !b.negative)
    }
    fn mul(&self, b: &Self) -> Self {
        let mut limbs = Limbs::zeros(self.limbs.len() + b.limbs.len());
        for (i, &x) in self.limbs.iter().enumerate() {
            let mut carry = 0_u128;
            for (j, &y) in b.limbs.iter().enumerate() {
                let sum = x as u128 * y as u128 + limbs[i + j] as u128 + carry;
                limbs[i + j] = sum as u64;
                carry = sum >> 64;
            }
            if !b.limbs.is_empty() {
                limbs[i + b.limbs.len()] = carry as u64;
            }
        }
        trim(&mut limbs);
        Self {
            negative: self.negative != b.negative,
            exponent: self.exponent + b.exponent,
            limbs,
        }
    }
}
fn trim(x: &mut Limbs) {
    while x.last() == Some(&0) {
        x.pop();
    }
}
fn difference(a: f64, b: f64) -> Dyadic {
    Dyadic::from(a).sub(&Dyadic::from(b))
}
fn cross(a: &[Dyadic; 2], b: &[Dyadic; 2]) -> Dyadic {
    a[0].mul(&b[1]).sub(&a[1].mul(&b[0]))
}
fn square_sum(a: &[Dyadic; 2]) -> Dyadic {
    a[0].mul(&a[0]).add(&a[1].mul(&a[1]))
}

pub(crate) fn orient2d(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> i8 {
    #[cfg(feature = "sfcc-profile")]
    if super::perf::disabled(2) {
        return reference::orient2d(a, b, c);
    }

    if (a == b || b == c || a == c || (0..2).any(|k| a[k] == b[k] && b[k] == c[k]))
        && [a, b, c].iter().flatten().all(|x| x.is_finite())
    {
        super::perf::add(5, 1);
        return 0;
    }

    let l = (a[0] - c[0]) * (b[1] - c[1]);
    let r = (a[1] - c[1]) * (b[0] - c[0]);
    let det = l - r;
    let bound = (l.abs() + r.abs()) * (8. * f64::EPSILON);
    if det.is_finite() && bound.is_normal() && det.abs() > bound {
        return if det > 0. { 1 } else { -1 };
    }
    super::perf::add(4, 1);
    cross(
        &std::array::from_fn(|k| difference(a[k], c[k])),
        &std::array::from_fn(|k| difference(b[k], c[k])),
    )
    .sign()
}

/// Positive when d is inside the circumcircle of counterclockwise abc.
pub(crate) fn incircle(a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]) -> i8 {
    #[cfg(feature = "sfcc-profile")]
    if super::perf::disabled(2) {
        return reference::incircle(a, b, c, d);
    }

    let x = a[0] - d[0];
    let y = a[1] - d[1];
    let u = b[0] - d[0];
    let v = b[1] - d[1];
    let s = c[0] - d[0];
    let t = c[1] - d[1];
    let aa = x * x + y * y;
    let bb = u * u + v * v;
    let cc = s * s + t * t;
    let det = aa * (u * t - v * s) + bb * (s * y - t * x) + cc * (x * v - y * u);
    let permanent = aa * (u * t).abs()
        + aa * (v * s).abs()
        + bb * (s * y).abs()
        + bb * (t * x).abs()
        + cc * (x * v).abs()
        + cc * (y * u).abs();
    let bound = permanent * (32. * f64::EPSILON);
    if det.is_finite() && bound.is_normal() && det.abs() > bound {
        return if det > 0. { 1 } else { -1 };
    }
    super::perf::add(4, 1);
    let a = std::array::from_fn(|k| difference(a[k], d[k]));
    let b = std::array::from_fn(|k| difference(b[k], d[k]));
    let c = std::array::from_fn(|k| difference(c[k], d[k]));
    square_sum(&a)
        .mul(&cross(&b, &c))
        .add(&square_sum(&b).mul(&cross(&c, &a)))
        .add(&square_sum(&c).mul(&cross(&a, &b)))
        .sign()
}

pub(crate) fn orient3d(a: [f64; 3], b: [f64; 3], c: [f64; 3], d: [f64; 3]) -> i8 {
    #[cfg(feature = "sfcc-profile")]
    if super::perf::disabled(2) {
        return reference::orient3d(a, b, c, d);
    }

    if (a == b
        || a == c
        || a == d
        || b == c
        || b == d
        || c == d
        || (0..3).any(|k| a[k] == b[k] && b[k] == c[k] && c[k] == d[k]))
        && [a, b, c, d].iter().flatten().all(|x| x.is_finite())
    {
        super::perf::add(5, 1);
        return 0;
    }

    let x: [f64; 3] = std::array::from_fn(|k| a[k] - d[k]);
    let y: [f64; 3] = std::array::from_fn(|k| b[k] - d[k]);
    let z: [f64; 3] = std::array::from_fn(|k| c[k] - d[k]);
    let terms = [
        x[0] * y[1] * z[2],
        x[0] * y[2] * z[1],
        x[1] * y[2] * z[0],
        x[1] * y[0] * z[2],
        x[2] * y[0] * z[1],
        x[2] * y[1] * z[0],
    ];
    let det = terms[0] - terms[1] + terms[2] - terms[3] + terms[4] - terms[5];
    let bound = terms.iter().map(|x| x.abs()).sum::<f64>() * (64. * f64::EPSILON);
    if det.is_finite() && bound.is_normal() && det.abs() > bound {
        return if det > 0. { 1 } else { -1 };
    }
    super::perf::add(4, 1);
    // Exact fallback is also used for near-coplanar contacts.
    let a: [_; 3] = std::array::from_fn(|k| difference(a[k], d[k]));
    let b: [_; 3] = std::array::from_fn(|k| difference(b[k], d[k]));
    let c: [_; 3] = std::array::from_fn(|k| difference(c[k], d[k]));
    a[0].mul(&b[1].mul(&c[2]).sub(&b[2].mul(&c[1])))
        .add(&a[1].mul(&b[2].mul(&c[0]).sub(&b[0].mul(&c[2]))))
        .add(&a[2].mul(&b[0].mul(&c[1]).sub(&b[1].mul(&c[0]))))
        .sign()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_and_exact_zero() {
        let n = (1_u64 << 52) as f64;
        // Integer determinant n² - (n-1)(n+1) is exactly +1.
        assert_eq!(orient2d([n, n - 1.], [n + 1., n], [0., 0.]), 1);
        assert_eq!(orient2d([n, n - 1.], [0., 0.], [n + 1., n]), -1);
        assert_eq!(orient2d([0., 0.], [n, n], [1., 1.]), 0);
        assert_eq!(incircle([1., 0.], [0., 1.], [-1., 0.], [0., -1.]), 0);
        assert_eq!(
            incircle([1., 0.], [0., 1.], [-1., 0.], [0., -1. + f64::EPSILON]),
            1
        );
        assert_eq!(
            incircle([1., 0.], [0., 1.], [-1., 0.], [0., -1. - f64::EPSILON]),
            -1
        );
    }
    #[test]
    fn exponent_extremes_and_subnormal() {
        for s in [f64::from_bits(1), 1e-200, 1., 1e200, f64::MAX / 4.] {
            assert_eq!(orient2d([0., 0.], [s, 0.], [0., s]), 1);
            assert_eq!(incircle([s, 0.], [0., s], [-s, 0.], [0., 0.]), 1);
            assert_eq!(orient3d([s, 0., 0.], [0., s, 0.], [0., 0., s], [0.; 3]), 1);
        }
    }
}

#[cfg(any(test, feature = "sfcc-profile"))]
#[path = "predicates_reference.rs"]
mod reference;
#[cfg(test)]
mod equivalence {
    use super::*;
    #[test]
    fn finite_bit_patterns_and_degeneracies_match_exact_reference() {
        let mut seed = 0x12563322_u64;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            f64::from_bits(seed & !(0x7ff_u64 << 52) | ((seed >> 40) % 2047) << 52)
        };
        for i in 0..1500 {
            let a = [next(), next(), next()];
            let b = [next(), next(), next()];
            let c = if i % 3 == 0 {
                a
            } else {
                [next(), next(), next()]
            };
            let d = if i % 5 == 0 {
                b
            } else {
                [next(), next(), next()]
            };
            let flat = |p: [f64; 3]| [p[0], p[1]];
            assert_eq!(
                orient2d(flat(a), flat(b), flat(c)),
                reference::orient2d(flat(a), flat(b), flat(c))
            );
            assert_eq!(orient3d(a, b, c, d), reference::orient3d(a, b, c, d));
            assert_eq!(
                incircle(flat(a), flat(b), flat(c), flat(d)),
                reference::incircle(flat(a), flat(b), flat(c), flat(d))
            );
        }
    }
    #[test]
    fn inline_spill_and_resize_preserve_limbs() {
        let mut n = Limbs::single(7);
        n.resize(8, 3);
        assert!(n.heap.is_none());
        n.resize(40, 5);
        assert_eq!(n[0], 7);
        assert_eq!(n[7], 3);
        assert_eq!(n[39], 5);
        n.resize(1, 0);
        n.resize(4, 9);
        assert_eq!(&*n, &[7, 9, 9, 9]);
    }
}
