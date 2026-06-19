//! Smooth-boolean (smin) family, ported verbatim from
//! `src/export/sfcc/cpu-sdf-primitives.mts`. The WGSL zero-set is ground truth;
//! these match it deviation-for-deviation (raw modF wrap on columns, etc.).

use std::f64::consts::{FRAC_1_SQRT_2, SQRT_2};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SminMode {
    Round,
    Soft,
    Chamfer,
    Stairs,
    Columns,
    ColumnsI,
}

/// Column bump radius (hg_sdf): r·√2 / ((n−1)·2 + √2).
fn column_radius(r: f64, n: f64) -> f64 {
    (r * SQRT_2) / ((n - 1.0) * 2.0 + SQRT_2)
}

/// GLSL-style mod (result has the sign of `y`), matching the shader's modF.
fn glsl_mod(x: f64, y: f64) -> f64 {
    x - y * (x / y).floor()
}

/// Smooth minimum of two SDF values; `n` is the step count (stairs/columns).
pub fn smin(mode: SminMode, a: f64, b: f64, r: f64, n: f64) -> f64 {
    match mode {
        SminMode::Round => {
            let ux = (r - a).max(0.0);
            let uy = (r - b).max(0.0);
            r.max(a.min(b)) - ux.hypot(uy)
        }
        SminMode::Soft => {
            let e = (r - (a - b).abs()).max(0.0);
            a.min(b) - (e * e * 0.25) / r
        }
        SminMode::Chamfer => a.min(b).min((a - r + b) * FRAC_1_SQRT_2),
        SminMode::Stairs => {
            let s = r / n;
            let u = b - r;
            a.min(b).min(0.5 * (u + a + (glsl_mod(u - a + s, 2.0 * s) - s).abs()))
        }
        SminMode::Columns => {
            if a < r && b < r {
                let cr = column_radius(r, n);
                let px = (a + b) * FRAC_1_SQRT_2 - FRAC_1_SQRT_2 * r + cr * SQRT_2;
                let mut py = (b - a) * FRAC_1_SQRT_2;
                if glsl_mod(n, 2.0) != 0.0 {
                    py += cr;
                }
                let pyw = glsl_mod(py, cr * 2.0);
                let dist = px.hypot(pyw) - cr;
                dist.min(px).min(a.min(b))
            } else {
                a.min(b)
            }
        }
        SminMode::ColumnsI => {
            if a < r && b < r {
                let cr = column_radius(r, n);
                let px = (a + b) * FRAC_1_SQRT_2 - FRAC_1_SQRT_2 * r - cr * SQRT_2 * 0.5;
                let mut py = (b - a) * FRAC_1_SQRT_2 + cr;
                if glsl_mod(n, 2.0) != 0.0 {
                    py += cr;
                }
                let pyw = glsl_mod(py, cr * 2.0);
                let g = (cr - px.hypot(pyw)).max(px);
                g.min(a).min(b)
            } else {
                a.min(b)
            }
        }
    }
}

/// Direction weights (wa, wb) with ∇smin ∥ wa·∇a + wb·∇b almost everywhere.
/// Callers normalize the combined vector, so only the ratio matters.
pub fn smin_grad_weights(mode: SminMode, a: f64, b: f64, r: f64, n: f64) -> [f64; 2] {
    match mode {
        SminMode::Round => {
            if a < r && b < r {
                [r - a, r - b]
            } else if a <= b {
                [1.0, 0.0]
            } else {
                [0.0, 1.0]
            }
        }
        SminMode::Soft => {
            let h = (0.5 + (0.5 * (b - a)) / r).clamp(0.0, 1.0);
            [h, 1.0 - h]
        }
        SminMode::Chamfer => {
            if (a - r + b) * FRAC_1_SQRT_2 < a.min(b) {
                [1.0, 1.0]
            } else if a <= b {
                [1.0, 0.0]
            } else {
                [0.0, 1.0]
            }
        }
        SminMode::Stairs => {
            let s = r / n;
            let u = b - r;
            let w = glsl_mod(u - a + s, 2.0 * s) - s;
            if a.min(b) <= 0.5 * (u + a + w.abs()) {
                if a <= b {
                    [1.0, 0.0]
                } else {
                    [0.0, 1.0]
                }
            } else if w >= 0.0 {
                [0.0, 1.0]
            } else {
                [1.0, 0.0]
            }
        }
        SminMode::Columns => {
            if a < r && b < r {
                let cr = column_radius(r, n);
                let px = (a + b) * FRAC_1_SQRT_2 - FRAC_1_SQRT_2 * r + cr * SQRT_2;
                let mut py = (b - a) * FRAC_1_SQRT_2;
                if glsl_mod(n, 2.0) != 0.0 {
                    py += cr;
                }
                let pyw = glsl_mod(py, cr * 2.0);
                let dist = px.hypot(pyw) - cr;
                let m = dist.min(px).min(a.min(b));
                if m == a {
                    [1.0, 0.0]
                } else if m == b {
                    [0.0, 1.0]
                } else if m == px {
                    [1.0, 1.0]
                } else {
                    [px - pyw, px + pyw]
                }
            } else if a <= b {
                [1.0, 0.0]
            } else {
                [0.0, 1.0]
            }
        }
        SminMode::ColumnsI => {
            if a < r && b < r {
                let cr = column_radius(r, n);
                let px = (a + b) * FRAC_1_SQRT_2 - FRAC_1_SQRT_2 * r - cr * SQRT_2 * 0.5;
                let mut py = (b - a) * FRAC_1_SQRT_2 + cr;
                if glsl_mod(n, 2.0) != 0.0 {
                    py += cr;
                }
                let pyw = glsl_mod(py, cr * 2.0);
                let g = (cr - px.hypot(pyw)).max(px);
                let m = g.min(a).min(b);
                if m == a {
                    [1.0, 0.0]
                } else if m == b {
                    [0.0, 1.0]
                } else if px >= cr - px.hypot(pyw) {
                    [1.0, 1.0]
                } else {
                    [pyw - px, -(px + pyw)]
                }
            } else if a <= b {
                [1.0, 0.0]
            } else {
                [0.0, 1.0]
            }
        }
    }
}

/// Certified enclosure of the columns variants over an operand box
/// [a_lo,a_hi] × [b_lo,b_hi] — they are NOT monotone, so per-branch interval
/// arithmetic is required. `mode` must be `Columns` or `ColumnsI`.
pub fn smin_columns_interval(
    mode: SminMode,
    a_lo: f64,
    a_hi: f64,
    b_lo: f64,
    b_hi: f64,
    r: f64,
    n: f64,
) -> [f64; 2] {
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    if a_hi >= r || b_hi >= r {
        lo = a_lo.min(b_lo);
        hi = a_hi.min(b_hi);
    }
    if a_lo < r && b_lo < r {
        let a_h = a_hi.min(r);
        let b_h = b_hi.min(r);
        let cr = column_radius(r, n);
        let px_off = if mode == SminMode::Columns { cr * SQRT_2 } else { -cr * SQRT_2 * 0.5 };
        let px_lo = (a_lo + b_lo) * FRAC_1_SQRT_2 - FRAC_1_SQRT_2 * r + px_off;
        let px_hi = (a_h + b_h) * FRAC_1_SQRT_2 - FRAC_1_SQRT_2 * r + px_off;
        let len_lo = if px_lo <= 0.0 && px_hi >= 0.0 {
            0.0
        } else {
            px_lo.abs().min(px_hi.abs())
        };
        let len_hi = (px_lo.abs().max(px_hi.abs())).hypot(2.0 * cr);
        let (c_lo, c_hi);
        if mode == SminMode::Columns {
            c_lo = (len_lo - cr).min(px_lo).min(a_lo).min(b_lo);
            c_hi = (len_hi - cr).min(px_hi).min(a_h).min(b_h);
        } else {
            c_lo = (cr - len_hi).max(px_lo).min(a_lo).min(b_lo);
            c_hi = (cr - len_lo).max(px_hi).min(a_h).min(b_h);
        }
        lo = lo.min(c_lo);
        hi = hi.max(c_hi);
    }
    [lo, hi]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glsl_mod_takes_sign_of_y() {
        assert_eq!(glsl_mod(-1.0, 3.0), 2.0);
        assert_eq!(glsl_mod(7.0, 3.0), 1.0);
    }

    #[test]
    fn round_seam_displacement() {
        // |smin(round, 0, 0, r)| = (√2 − 1)·r.
        assert!((smin(SminMode::Round, 0.0, 0.0, 1.0, 2.0) - (1.0 - SQRT_2)).abs() < 1e-12);
    }

    #[test]
    fn soft_seam_displacement() {
        // |smin(soft, 0, 0, r)| = r/4.
        assert!((smin(SminMode::Soft, 0.0, 0.0, 1.0, 2.0) - -0.25).abs() < 1e-12);
    }

    #[test]
    fn columns_n1_zero_displacement() {
        assert!(smin(SminMode::Columns, 0.0, 0.0, 1.0, 1.0).abs() < 1e-12);
    }

    #[test]
    fn smin_is_below_hard_min() {
        let modes = [
            SminMode::Round,
            SminMode::Soft,
            SminMode::Chamfer,
            SminMode::Stairs,
            SminMode::Columns,
            SminMode::ColumnsI,
        ];
        for &(a, b) in &[(0.3, 0.7), (-0.2, 0.4), (0.1, 0.1), (0.45, 0.05)] {
            for &m in &modes {
                let v = smin(m, a, b, 0.5, 2.0);
                assert!(v <= a.min(b) + 1e-9, "{m:?}: smin({a},{b}) = {v} > min");
            }
        }
    }

    #[test]
    fn round_grad_weights() {
        assert_eq!(smin_grad_weights(SminMode::Round, 0.2, 0.5, 1.0, 2.0), [0.8, 0.5]);
        // Outside the band: hard winner.
        assert_eq!(smin_grad_weights(SminMode::Round, 2.0, 3.0, 1.0, 2.0), [1.0, 0.0]);
    }

    #[test]
    fn columns_interval_encloses_samples() {
        let r = 1.0;
        let n = 2.0;
        for mode in [SminMode::Columns, SminMode::ColumnsI] {
            let (a_lo, a_hi, b_lo, b_hi) = (-0.4, 0.6, -0.3, 0.5);
            let [lo, hi] = smin_columns_interval(mode, a_lo, a_hi, b_lo, b_hi, r, n);
            // Sample the box; every sample must lie within the enclosure.
            for i in 0..=8 {
                for j in 0..=8 {
                    let a = a_lo + (a_hi - a_lo) * i as f64 / 8.0;
                    let b = b_lo + (b_hi - b_lo) * j as f64 / 8.0;
                    let v = smin(mode, a, b, r, n);
                    assert!(v >= lo - 1e-9 && v <= hi + 1e-9, "{mode:?}: {v} outside [{lo},{hi}]");
                }
            }
        }
    }
}
