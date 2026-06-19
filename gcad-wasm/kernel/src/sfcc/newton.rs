//! Min-norm Newton projections for SFCC seam work. Port of
//! `src/export/sfcc/newton.mts` (f64 scalars; analytic carrier gradients —
//! never finite differences).
//!
//! The 2-constraint minimum-norm step `dp = −Jᵀ(JJᵀ)⁻¹r` projects onto the
//! carrier-pair locus {fA = fB = 0}; the 3×3 Cramer solve refines a triple
//! point {fA = fB = fC = 0}. Carrier fields are unit-gradient, so the J rows
//! are the unit normals and JJᵀ = [[1,c],[c,1]] with c = ∇A·∇B.

use crate::strata::Stratum;

/// Project `(px,py,pz)` onto the carrier-pair locus {fA = fB = 0} via min-norm
/// Newton. Returns `Some([x,y,z])` on convergence, or `None` when the carriers
/// are near-parallel (‖∇A×∇B‖ < `min_cross`) or the iteration diverges past
/// `max_displacement`.
#[allow(clippy::too_many_arguments)]
pub fn project_to_carrier_pair(
    sa: &Stratum,
    sb: &Stratum,
    px: f64,
    py: f64,
    pz: f64,
    eps: f64,
    min_cross: f64,
    max_displacement: f64,
) -> Option<[f64; 3]> {
    let mut x = px;
    let mut y = py;
    let mut z = pz;
    for _ in 0..24 {
        let fa = sa.f(x, y, z);
        let fb = sb.f(x, y, z);
        if fa.abs() <= eps && fb.abs() <= eps {
            return Some([x, y, z]);
        }
        let ga = sa.normal(x, y, z);
        let gb = sb.normal(x, y, z);
        // Carrier fields are unit-gradient: J rows are the unit normals.
        let c = ga[0] * gb[0] + ga[1] * gb[1] + ga[2] * gb[2];
        let det = 1.0 - c * c; // = ‖∇A×∇B‖²
        if det < min_cross * min_cross {
            return None;
        }
        // Solve [[1, c], [c, 1]] [a, b]ᵀ = [fa, fb]ᵀ.
        let a = (fa - c * fb) / det;
        let b = (fb - c * fa) / det;
        x -= a * ga[0] + b * gb[0];
        y -= a * ga[1] + b * gb[1];
        z -= a * ga[2] + b * gb[2];
        if ((x - px).powi(2) + (y - py).powi(2) + (z - pz).powi(2)).sqrt() > max_displacement {
            return None;
        }
    }
    None
}

/// Refine a triple point {fA = fB = fC = 0} by 3×3 Newton with analytic carrier
/// gradients. Returns `Some([x,y,z])` on convergence, `None` on a singular
/// Jacobian (three dependent normals) or divergence — callers keep their seed.
#[allow(clippy::too_many_arguments)]
pub fn project_to_triple(
    sa: &Stratum,
    sb: &Stratum,
    sc: &Stratum,
    px: f64,
    py: f64,
    pz: f64,
    eps: f64,
    max_displacement: f64,
) -> Option<[f64; 3]> {
    let mut x = px;
    let mut y = py;
    let mut z = pz;
    for _ in 0..16 {
        let fa = sa.f(x, y, z);
        let fb = sb.f(x, y, z);
        let fc = sc.f(x, y, z);
        if fa.abs() <= eps && fb.abs() <= eps && fc.abs() <= eps {
            return Some([x, y, z]);
        }
        let ga = sa.normal(x, y, z);
        let gb = sb.normal(x, y, z);
        let gc = sc.normal(x, y, z);
        // Solve J·dp = r by Cramer (J rows = unit normals).
        let det = ga[0] * (gb[1] * gc[2] - gb[2] * gc[1]) - ga[1] * (gb[0] * gc[2] - gb[2] * gc[0])
            + ga[2] * (gb[0] * gc[1] - gb[1] * gc[0]);
        if det.abs() < 1e-6 {
            return None;
        }
        let dx = (fa * (gb[1] * gc[2] - gb[2] * gc[1]) - ga[1] * (fb * gc[2] - gb[2] * fc)
            + ga[2] * (fb * gc[1] - gb[1] * fc))
            / det;
        let dy = (ga[0] * (fb * gc[2] - gb[2] * fc) - fa * (gb[0] * gc[2] - gb[2] * gc[0])
            + ga[2] * (gb[0] * fc - fb * gc[0]))
            / det;
        let dz = (ga[0] * (gb[1] * fc - fb * gc[1]) - ga[1] * (gb[0] * fc - fb * gc[0])
            + fa * (gb[0] * gc[1] - gb[1] * gc[0]))
            / det;
        x -= dx;
        y -= dy;
        z -= dz;
        if ((x - px).powi(2) + (y - py).powi(2) + (z - pz).powi(2)).sqrt() > max_displacement {
            return None;
        }
    }
    None
}

/// Unit tangent of the {fA = fB = 0} locus: normalize(∇A × ∇B). Writes the unit
/// tangent into `out` and returns its magnitude (pre-normalization). When the
/// cross product is ~zero (carriers parallel) `out` is set to `[1,0,0]`.
pub fn carrier_pair_tangent(sa: &Stratum, sb: &Stratum, x: f64, y: f64, z: f64, out: &mut [f64; 3]) -> f64 {
    let ga = sa.normal(x, y, z);
    let gb = sb.normal(x, y, z);
    let tx = ga[1] * gb[2] - ga[2] * gb[1];
    let ty = ga[2] * gb[0] - ga[0] * gb[2];
    let tz = ga[0] * gb[1] - ga[1] * gb[0];
    let len = (tx * tx + ty * ty + tz * tz).sqrt();
    if len > 1e-30 {
        out[0] = tx / len;
        out[1] = ty / len;
        out[2] = tz / len;
    } else {
        out[0] = 1.0;
        out[1] = 0.0;
        out[2] = 0.0;
    }
    len
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::strata::{Stratum, StratumIdentity};

    fn ident(id: usize) -> StratumIdentity {
        StratumIdentity { id, owner_node_id: -1, leaf_index: 0, local_index: 0, sign: 1.0 }
    }

    #[test]
    fn projects_onto_two_planes() {
        // Plane x=0 (n=+x, off=0) and plane y=0 (n=+y, off=0): locus is the z axis.
        let a = Stratum::plane(ident(0), 1.0, 0.0, 0.0, 0.0);
        let b = Stratum::plane(ident(1), 0.0, 1.0, 0.0, 0.0);
        let p = project_to_carrier_pair(&a, &b, 0.7, -0.4, 3.0, 1e-12, 1e-3, 10.0).unwrap();
        assert!(p[0].abs() < 1e-10 && p[1].abs() < 1e-10);
        assert!((p[2] - 3.0).abs() < 1e-10);
    }

    #[test]
    fn parallel_planes_fail() {
        let a = Stratum::plane(ident(0), 1.0, 0.0, 0.0, 0.0);
        let b = Stratum::plane(ident(1), 1.0, 0.0, 0.0, -1.0);
        assert!(project_to_carrier_pair(&a, &b, 0.5, 0.0, 0.0, 1e-12, 1e-3, 10.0).is_none());
    }

    #[test]
    fn tangent_of_axis_planes_is_axis() {
        let a = Stratum::plane(ident(0), 1.0, 0.0, 0.0, 0.0);
        let b = Stratum::plane(ident(1), 0.0, 1.0, 0.0, 0.0);
        let mut t = [0.0; 3];
        let mag = carrier_pair_tangent(&a, &b, 0.0, 0.0, 0.0, &mut t);
        assert!((mag - 1.0).abs() < 1e-12);
        assert!(t[0].abs() < 1e-12 && t[1].abs() < 1e-12 && t[2].abs() - 1.0 < 1e-12);
    }

    #[test]
    fn triple_point_of_three_planes() {
        let a = Stratum::plane(ident(0), 1.0, 0.0, 0.0, -1.0); // x=1
        let b = Stratum::plane(ident(1), 0.0, 1.0, 0.0, -2.0); // y=2
        let c = Stratum::plane(ident(2), 0.0, 0.0, 1.0, -3.0); // z=3
        let p = project_to_triple(&a, &b, &c, 0.0, 0.0, 0.0, 1e-12, 100.0).unwrap();
        assert!((p[0] - 1.0).abs() < 1e-10 && (p[1] - 2.0).abs() < 1e-10 && (p[2] - 3.0).abs() < 1e-10);
    }
}
