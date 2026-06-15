//! Smooth strata: one smooth surface patch of a primitive (box face, cylinder
//! side/cap, cone mantle/base, sphere), represented by its unbounded analytic
//! *carrier* in world space. Port of the exact-analytic carriers from
//! `src/export/sfcc/strata.mts` (plane / sphere / cylinder / cone).
//!
//! M3a scope: the four exact, unit-gradient carriers consumed by the
//! smooth-surface refinement certificates (`stratum_normal_variation_ok`,
//! `stratum_edge_crossings_ok`). The non-unit-gradient ruled carriers
//! (twistedSide / loftSide) and the full feature compilation (`feature-set`,
//! seam tracing, corners) are deferred to M4.
//!
//! `sign` bakes CSG orientation: −1 iff the owning primitive sits under an odd
//! number of Subtract right-hand ancestors, so `f`/`normal` always describe the
//! FINAL solid (outward normal, negative inside).

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CarrierKind {
    Plane,
    Sphere,
    Cylinder,
    Cone,
}

/// A smooth analytic carrier patch. Identity fields mirror `SfccStratum`'s
/// (`id`, `owner_node_id`, `leaf_index`, `local_index`, `sign`).
#[derive(Clone, Copy, Debug)]
pub struct Stratum {
    /// Dense global stratum id (index into the tree's stratum list).
    pub id: usize,
    /// Scene node id of the owning primitive (−1 when unbuilt, e.g. unit tests).
    pub owner_node_id: i64,
    /// Index of the owning leaf in the tree's leaf list.
    pub leaf_index: usize,
    /// Patch index within the primitive.
    pub local_index: usize,
    /// CSG orientation baked into f/normal (+1 or −1).
    pub sign: f64,
    pub kind: CarrierKind,
    carrier: Carrier,
}

/// Carrier geometry (world space). The owning [`Stratum`] applies `sign`.
#[derive(Clone, Copy, Debug)]
enum Carrier {
    /// f = n·p + offset, ‖n‖ = 1.
    Plane { n: [f64; 3], offset: f64 },
    /// f = ‖p − c‖ − r.
    Sphere { c: [f64; 3], r: f64 },
    /// f = dist(p, axis) − r; axis through `a` with unit dir `u`.
    Cylinder { a: [f64; 3], u: [f64; 3], r: f64 },
    /// Mantle: apex `a`, unit axis `u` (apex→base), half-angle (sin_a, cos_a).
    Cone { a: [f64; 3], u: [f64; 3], sin_a: f64, cos_a: f64 },
}

/// Shared identity for stratum construction (the TS `StratumIdentity`).
#[derive(Clone, Copy, Debug)]
pub struct StratumIdentity {
    pub id: usize,
    pub owner_node_id: i64,
    pub leaf_index: usize,
    pub local_index: usize,
    pub sign: f64,
}

impl Stratum {
    pub fn plane(ident: StratumIdentity, nx: f64, ny: f64, nz: f64, offset: f64) -> Stratum {
        Stratum::wrap(ident, CarrierKind::Plane, Carrier::Plane { n: [nx, ny, nz], offset })
    }

    pub fn sphere(ident: StratumIdentity, cx: f64, cy: f64, cz: f64, r: f64) -> Stratum {
        Stratum::wrap(ident, CarrierKind::Sphere, Carrier::Sphere { c: [cx, cy, cz], r })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn cylinder(ident: StratumIdentity, ax: f64, ay: f64, az: f64, ux: f64, uy: f64, uz: f64, r: f64) -> Stratum {
        Stratum::wrap(ident, CarrierKind::Cylinder, Carrier::Cylinder { a: [ax, ay, az], u: [ux, uy, uz], r })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn cone(
        ident: StratumIdentity,
        ax: f64,
        ay: f64,
        az: f64,
        ux: f64,
        uy: f64,
        uz: f64,
        sin_a: f64,
        cos_a: f64,
    ) -> Stratum {
        Stratum::wrap(
            ident,
            CarrierKind::Cone,
            Carrier::Cone { a: [ax, ay, az], u: [ux, uy, uz], sin_a, cos_a },
        )
    }

    fn wrap(ident: StratumIdentity, kind: CarrierKind, carrier: Carrier) -> Stratum {
        Stratum {
            id: ident.id,
            owner_node_id: ident.owner_node_id,
            leaf_index: ident.leaf_index,
            local_index: ident.local_index,
            sign: ident.sign,
            kind,
            carrier,
        }
    }

    /// Signed distance to the carrier, sign-adjusted (negative on the final
    /// solid's inside of this patch).
    pub fn f(&self, px: f64, py: f64, pz: f64) -> f64 {
        let s = self.sign;
        match self.carrier {
            Carrier::Plane { n, offset } => s * (n[0] * px + n[1] * py + n[2] * pz + offset),
            Carrier::Sphere { c, r } => s * (hypot3(px - c[0], py - c[1], pz - c[2]) - r),
            Carrier::Cylinder { a, u, r } => {
                let (rx, ry, rz, _t) = cyl_radial(a, u, px, py, pz);
                s * (hypot3(rx, ry, rz) - r)
            }
            Carrier::Cone { a, u, sin_a, cos_a } => {
                let (_rx, _ry, _rz, t, rho) = cone_decompose(a, u, px, py, pz);
                let proj = rho * sin_a + t * cos_a;
                if proj < 0.0 {
                    // Behind the apex: closest carrier point is the apex.
                    s * rho.hypot(t)
                } else {
                    s * (rho * cos_a - t * sin_a)
                }
            }
        }
    }

    /// Closest point on the carrier surface (sign-independent geometric
    /// projection). Port of `SfccStratum.project`.
    pub fn project(&self, px: f64, py: f64, pz: f64) -> [f64; 3] {
        match self.carrier {
            Carrier::Plane { n, offset } => {
                let d = n[0] * px + n[1] * py + n[2] * pz + offset;
                [px - d * n[0], py - d * n[1], pz - d * n[2]]
            }
            Carrier::Sphere { c, r } => {
                let dx = px - c[0];
                let dy = py - c[1];
                let dz = pz - c[2];
                let len = hypot3(dx, dy, dz);
                if len > 1e-30 {
                    let k = r / len;
                    [c[0] + dx * k, c[1] + dy * k, c[2] + dz * k]
                } else {
                    [c[0], c[1] + r, c[2]]
                }
            }
            Carrier::Cylinder { a, u, r } => {
                let (rx, ry, rz, t) = cyl_radial(a, u, px, py, pz);
                let len = hypot3(rx, ry, rz);
                if len > 1e-30 {
                    let k = r / len;
                    [a[0] + t * u[0] + rx * k, a[1] + t * u[1] + ry * k, a[2] + t * u[2] + rz * k]
                } else {
                    [a[0] + t * u[0] + r, a[1] + t * u[1], a[2] + t * u[2]]
                }
            }
            Carrier::Cone { a, u, sin_a, cos_a } => {
                let (rx, ry, rz, t, rho) = cone_decompose(a, u, px, py, pz);
                let proj = rho * sin_a + t * cos_a;
                if proj <= 0.0 || rho <= 1e-30 {
                    // Apex (also stable exactly on the axis).
                    [a[0], a[1], a[2]]
                } else {
                    let rho_star = proj * sin_a;
                    let t_star = proj * cos_a;
                    let inv = rho_star / rho;
                    [a[0] + t_star * u[0] + rx * inv, a[1] + t_star * u[1] + ry * inv, a[2] + t_star * u[2] + rz * inv]
                }
            }
        }
    }

    /// Exact unit outward normal of the final solid on this patch.
    pub fn normal(&self, px: f64, py: f64, pz: f64) -> [f64; 3] {
        let s = self.sign;
        match self.carrier {
            Carrier::Plane { n, .. } => [s * n[0], s * n[1], s * n[2]],
            Carrier::Sphere { c, .. } => {
                let dx = px - c[0];
                let dy = py - c[1];
                let dz = pz - c[2];
                let len = hypot3(dx, dy, dz);
                if len > 1e-30 {
                    [s * dx / len, s * dy / len, s * dz / len]
                } else {
                    [0.0, s, 0.0]
                }
            }
            Carrier::Cylinder { a, u, .. } => {
                let (rx, ry, rz, _t) = cyl_radial(a, u, px, py, pz);
                let len = hypot3(rx, ry, rz);
                if len > 1e-30 {
                    [s * rx / len, s * ry / len, s * rz / len]
                } else {
                    // On the axis: any perpendicular; pick a stable one.
                    let p2x = if u[0].abs() < 0.9 { 1.0 } else { 0.0 };
                    let p2y = if u[0].abs() < 0.9 { 0.0 } else { 1.0 };
                    let cxv = u[1] * 0.0 - u[2] * p2y;
                    let cyv = u[2] * p2x - u[0] * 0.0;
                    let czv = u[0] * p2y - u[1] * p2x;
                    let cl = hypot3(cxv, cyv, czv);
                    [s * cxv / cl, s * cyv / cl, s * czv / cl]
                }
            }
            Carrier::Cone { a, u, sin_a, cos_a } => {
                let (rx, ry, rz, t, rho) = cone_decompose(a, u, px, py, pz);
                let proj = rho * sin_a + t * cos_a;
                if proj < 0.0 && (rho > 1e-30 || t.abs() > 1e-30) {
                    let len = rho.hypot(t);
                    let k = s / len;
                    [(rx + t * u[0]) * k, (ry + t * u[1]) * k, (rz + t * u[2]) * k]
                } else if rho > 1e-30 {
                    let inv = 1.0 / rho;
                    [
                        s * (cos_a * rx * inv - sin_a * u[0]),
                        s * (cos_a * ry * inv - sin_a * u[1]),
                        s * (cos_a * rz * inv - sin_a * u[2]),
                    ]
                } else {
                    [-s * u[0], -s * u[1], -s * u[2]]
                }
            }
        }
    }
}

fn hypot3(x: f64, y: f64, z: f64) -> f64 {
    (x * x + y * y + z * z).sqrt()
}

/// Cylinder radial decomposition: returns (rx, ry, rz, t) where r = v − t·u.
fn cyl_radial(a: [f64; 3], u: [f64; 3], px: f64, py: f64, pz: f64) -> (f64, f64, f64, f64) {
    let vx = px - a[0];
    let vy = py - a[1];
    let vz = pz - a[2];
    let t = vx * u[0] + vy * u[1] + vz * u[2];
    (vx - t * u[0], vy - t * u[1], vz - t * u[2], t)
}

/// Cone decomposition: returns (rx, ry, rz, t, rho).
fn cone_decompose(a: [f64; 3], u: [f64; 3], px: f64, py: f64, pz: f64) -> (f64, f64, f64, f64, f64) {
    let vx = px - a[0];
    let vy = py - a[1];
    let vz = pz - a[2];
    let t = vx * u[0] + vy * u[1] + vz * u[2];
    let rx = vx - t * u[0];
    let ry = vy - t * u[1];
    let rz = vz - t * u[2];
    let rho = hypot3(rx, ry, rz);
    (rx, ry, rz, t, rho)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ident() -> StratumIdentity {
        StratumIdentity { id: 0, owner_node_id: -1, leaf_index: 0, local_index: 0, sign: 1.0 }
    }

    #[test]
    fn plane_carrier_signed_distance() {
        // +x face at x = 3: f = x − 3, outward normal +x.
        let st = Stratum::plane(ident(), 1.0, 0.0, 0.0, -3.0);
        assert!((st.f(5.0, 1.0, -2.0) - 2.0).abs() < 1e-12);
        assert!((st.f(0.0, 0.0, 0.0) + 3.0).abs() < 1e-12);
        assert_eq!(st.normal(0.0, 0.0, 0.0), [1.0, 0.0, 0.0]);
    }

    #[test]
    fn sphere_carrier_signed_distance() {
        let st = Stratum::sphere(ident(), 1.0, 0.0, 0.0, 2.0);
        assert!((st.f(4.0, 0.0, 0.0) - 1.0).abs() < 1e-12); // dist 3 − r 2
        assert!((st.f(1.0, 0.0, 0.0) + 2.0).abs() < 1e-12); // center
        let n = st.normal(4.0, 0.0, 0.0);
        assert!((n[0] - 1.0).abs() < 1e-12 && n[1].abs() < 1e-12 && n[2].abs() < 1e-12);
    }

    #[test]
    fn cylinder_carrier_radial() {
        // Axis = local Y through origin, r = 1.
        let st = Stratum::cylinder(ident(), 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0);
        assert!((st.f(3.0, 10.0, 0.0) - 2.0).abs() < 1e-12); // radial 3 − r 1, y-invariant
        let n = st.normal(3.0, 10.0, 0.0);
        assert!((n[0] - 1.0).abs() < 1e-12 && n[1].abs() < 1e-12 && n[2].abs() < 1e-12);
    }

    #[test]
    fn negated_stratum_flips_sign() {
        let mut id = ident();
        id.sign = -1.0;
        let st = Stratum::plane(id, 1.0, 0.0, 0.0, 0.0);
        assert!((st.f(2.0, 0.0, 0.0) + 2.0).abs() < 1e-12);
        assert_eq!(st.normal(0.0, 0.0, 0.0), [-1.0, 0.0, 0.0]);
    }
}
