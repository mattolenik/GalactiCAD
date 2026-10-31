//! Taper warp core (SFCC v1.1): the CPU f64 port of the WGSL `taperPoint` /
//! `sdfTaper*` family (`src/shaders/hg_sdf.wgsl`).
//!
//! The operator scales the XZ cross-section linearly with y — scale `1` at
//! `y = 0`, `ratio` at `y = height`, clamped outside `[0, height]` — acting in
//! the taper node's own frame (the similarity accumulated at that point in the
//! scene tree). Evaluation warps the query point into the child's frame:
//!
//! ```text
//! local     = sim⁻¹(p)                    (world → taper-local)
//! s         = 1 + (ratio − 1)·clamp(local.y / height, 0, 1)
//! q         = sim(local.x/s, local.y, local.z/s)   (taper-local → world)
//! F(p)      = child(q) · min(s, 1)
//! ```
//!
//! The `min(s, 1)` correction mirrors `sdfTaperFast`: a narrowing taper
//! (`s < 1`) overestimates distance (gradient ~1/s), so the value is clamped
//! back into a conservative bound; a widening taper needs no correction.
//! Because the correction is positive and independent of the child, the warp
//! commutes exactly with hard min/max and with sign negation, and blends
//! compose through it (matching the WGSL, which applies the warp around the
//! whole child subtree).
//!
//! Interval certification is conservative: the query box is mapped through the
//! warp into its child-space box hull (s is monotone piecewise-linear in y, so
//! the endpoint scales bound it; x and s vary independently within the box, so
//! the four x/s corner candidates bound each axis), and the child interval is
//! scaled by the correction range `[min(s_lo,1), min(s_hi,1)]` with sign-aware
//! endpoint pairing.

use crate::math::similarity::Similarity;

/// Scale applied to XZ at local `y`. Mirrors `taperScaleAtY`. Requires
/// `ratio > 0` and `height > 0` (validated at the bridge).
#[inline]
pub(crate) fn scale_at(y: f64, ratio: f64, height: f64) -> f64 {
    let t = (y / height).clamp(0.0, 1.0);
    1.0 + (ratio - 1.0) * t
}

/// `d(scale)/dy` — zero outside the active band `0 < y < height`, where the
/// clamp makes s constant. Mirrors the `inActive` select in `sdfTaperNormal`.
#[inline]
pub(crate) fn dsdy_at(y: f64, ratio: f64, height: f64) -> f64 {
    let t = y / height;
    if t > 0.0 && t < 1.0 {
        (ratio - 1.0) / height
    } else {
        0.0
    }
}

/// A world point warped into the child's frame: `(q, s)` where `q` is the
/// child-space (world-coordinate) sample point and `s` the local XZ scale.
#[inline]
pub(crate) fn warp_point(
    sim: &Similarity,
    ratio: f64,
    height: f64,
    p: [f64; 3],
) -> ([f64; 3], f64) {
    let local = sim.inv_apply_point(p[0], p[1], p[2]);
    let s = scale_at(local[1], ratio, height);
    let warped = [local[0] / s, local[1], local[2] / s];
    let q = sim.apply_point(warped[0], warped[1], warped[2]);
    (q, s)
}

/// Conservative child-space mapping of a world query box: the box hull of
/// `{ q(p) : p ∈ box }` plus the range of the `min(s,1)` correction over it.
pub(crate) struct TaperQuery {
    pub c: [f64; 3],
    pub half: [f64; 3],
    pub corr_lo: f64,
    pub corr_hi: f64,
}

/// Map a world box through the warp. `None` on non-finite input or a
/// degenerate scale (the caller treats that as an invalid interval).
pub(crate) fn map_box(
    sim: &Similarity,
    ratio: f64,
    height: f64,
    c: [f64; 3],
    half: [f64; 3],
) -> Option<TaperQuery> {
    if c.iter().any(|v| !v.is_finite()) || half.iter().any(|v| !v.is_finite() || *v < 0.0) {
        return None;
    }
    // World box → taper-local box hull (rotation-aware, like Leaf's cylinder
    // interval: |R| column sums over the world half-extents, unscaled by s).
    let local = sim.inv_apply_point(c[0], c[1], c[2]);
    if local.iter().any(|v| !v.is_finite()) {
        return None;
    }
    let mut lh = [0.0f64; 3];
    for a in 0..3 {
        lh[a] = (0..3).map(|b| sim.r[b * 3 + a].abs() * half[b]).sum::<f64>() / sim.s;
        if !lh[a].is_finite() || lh[a] < 0.0 {
            return None;
        }
    }
    // s range over the y-extent: s is monotone piecewise-linear in y, so the
    // clamped endpoint scales bound it over the whole extent.
    let y0 = local[1] - lh[1];
    let y1 = local[1] + lh[1];
    let s0 = scale_at(y0, ratio, height);
    let s1 = scale_at(y1, ratio, height);
    let s_lo = s0.min(s1);
    let s_hi = s0.max(s1);
    // `!(s > 0)` (not `s <= 0`) so NaN is rejected too — same guard idiom as
    // the TS scale/negation checks.
    #[allow(clippy::neg_cmp_op_on_partial_ord)]
    if !s_lo.is_finite() || !s_hi.is_finite() || !(s_lo > 0.0) {
        return None;
    }
    // Image of [v0, v1] under v ↦ v/s with s ∈ [s_lo, s_hi] (x/z and y vary
    // independently inside the box, so any pairing is attainable).
    let img_axis = |v0: f64, v1: f64| -> Option<(f64, f64)> {
        let mut lo = f64::INFINITY;
        let mut hi = f64::NEG_INFINITY;
        for &v in &[v0 / s_lo, v0 / s_hi, v1 / s_lo, v1 / s_hi] {
            if !v.is_finite() {
                return None;
            }
            lo = lo.min(v);
            hi = hi.max(v);
        }
        Some((lo, hi))
    };
    let (ix_lo, ix_hi) = img_axis(local[0] - lh[0], local[0] + lh[0])?;
    let (iz_lo, iz_hi) = img_axis(local[2] - lh[2], local[2] + lh[2])?;
    // Taper-local image box → world box hull (|R| row sums scaled by s).
    let img_center = [(ix_lo + ix_hi) * 0.5, local[1], (iz_lo + iz_hi) * 0.5];
    let img_half = [(ix_hi - ix_lo) * 0.5, lh[1], (iz_hi - iz_lo) * 0.5];
    let wc = sim.apply_point(img_center[0], img_center[1], img_center[2]);
    let mut wh = [0.0f64; 3];
    for b in 0..3 {
        wh[b] = sim.s * (0..3).map(|a| sim.r[b * 3 + a].abs() * img_half[a]).sum::<f64>();
        if !wc[b].is_finite() || !wh[b].is_finite() || wh[b] < 0.0 {
            return None;
        }
    }
    let corr_lo = s_lo.min(1.0);
    let corr_hi = s_hi.min(1.0);
    #[allow(clippy::neg_cmp_op_on_partial_ord)]
    if !(corr_lo > 0.0) || corr_lo > corr_hi {
        return None;
    }
    Some(TaperQuery { c: wc, half: wh, corr_lo, corr_hi })
}

/// Scale an interval by `c ∈ [corr_lo, corr_hi]` (both > 0, `corr_lo ≤
/// corr_hi`), pairing endpoints by sign so the result encloses
/// `{ v·c : v ∈ [lo,hi], c ∈ [corr_lo,corr_hi] }`.
#[inline]
pub(crate) fn scale_interval(iv: (f64, f64), corr_lo: f64, corr_hi: f64) -> (f64, f64) {
    let (lo, hi) = iv;
    let new_lo = if lo >= 0.0 { lo * corr_lo } else { lo * corr_hi };
    let new_hi = if hi >= 0.0 { hi * corr_hi } else { hi * corr_lo };
    (new_lo, new_hi)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sim() -> Similarity {
        Similarity::identity()
    }

    #[test]
    fn scale_clamps_outside_the_band() {
        assert_eq!(scale_at(-5.0, 0.5, 10.0), 1.0);
        assert_eq!(scale_at(0.0, 0.5, 10.0), 1.0);
        assert!((scale_at(5.0, 0.5, 10.0) - 0.75).abs() < 1e-15);
        assert_eq!(scale_at(10.0, 0.5, 10.0), 0.5);
        assert_eq!(scale_at(50.0, 0.5, 10.0), 0.5);
    }

    #[test]
    fn dsdy_is_zero_outside_the_active_band() {
        assert_eq!(dsdy_at(-1.0, 2.0, 4.0), 0.0);
        assert_eq!(dsdy_at(0.0, 2.0, 4.0), 0.0);
        assert!((dsdy_at(2.0, 2.0, 4.0) - 0.25).abs() < 1e-15);
        assert_eq!(dsdy_at(4.0, 2.0, 4.0), 0.0);
        assert_eq!(dsdy_at(9.0, 2.0, 4.0), 0.0);
    }

    #[test]
    fn warp_point_scales_xz_only() {
        let (q, s) = warp_point(&sim(), 0.5, 10.0, [2.0, 5.0, -4.0]);
        assert!((s - 0.75).abs() < 1e-15);
        assert!((q[0] - 2.0 / 0.75).abs() < 1e-12);
        assert_eq!(q[1], 5.0);
        assert!((q[2] - -4.0 / 0.75).abs() < 1e-12);
        // Below the band the warp is the identity.
        let (q, s) = warp_point(&sim(), 0.5, 10.0, [2.0, -3.0, -4.0]);
        assert_eq!(s, 1.0);
        assert_eq!(q, [2.0, -3.0, -4.0]);
    }

    #[test]
    fn mapped_box_contains_the_image_of_every_point() {
        let sim = Similarity::compose(
            &Similarity::compose(
                &Similarity::from_translation(3.0, -2.0, 5.0),
                &Similarity::from_rotation_wgsl_fwd(&[0.0, 1.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, 1.0]),
            ),
            &Similarity::from_uniform_scale(2.5),
        );
        for &(ratio, height) in &[(0.4, 7.0), (2.2, 7.0), (1.0, 7.0)] {
            for (cx, cy, cz, h) in
                [(1.2, 0.7, -0.4, 0.9), (-5.0, 12.0, 3.0, 2.5), (0.0, 0.0, 0.0, 4.0)]
            {
                let map = map_box(&sim, ratio, height, [cx, cy, cz], [h; 3]).unwrap();
                for i in 0..5 {
                    for j in 0..5 {
                        for k in 0..5 {
                            let t = |v: usize| v as f64 / 4.0 * 2.0 - 1.0;
                            let p = [cx + t(i) * h, cy + t(j) * h, cz + t(k) * h];
                            let (q, s) = warp_point(&sim, ratio, height, p);
                            for a in 0..3 {
                                assert!(
                                    q[a] >= map.c[a] - map.half[a] - 1e-9
                                        && q[a] <= map.c[a] + map.half[a] + 1e-9,
                                    "image point outside hull: {q:?} vs {:?}±{:?}",
                                    map.c,
                                    map.half
                                );
                            }
                            let c = s.min(1.0);
                            assert!(c >= map.corr_lo - 1e-12 && c <= map.corr_hi + 1e-12);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn scale_interval_encloses_both_sign_cases() {
        // Positive interval: shrinks toward corr_lo.
        assert_eq!(scale_interval((2.0, 4.0), 0.5, 1.0), (1.0, 4.0));
        // Negative interval: most-negative at corr_hi.
        assert_eq!(scale_interval((-4.0, -2.0), 0.5, 1.0), (-4.0, -1.0));
        // Straddling zero.
        assert_eq!(scale_interval((-2.0, 3.0), 0.5, 1.0), (-2.0, 3.0));
        // Unit correction range is the identity.
        assert_eq!(scale_interval((-2.0, 3.0), 1.0, 1.0), (-2.0, 3.0));
    }
}
