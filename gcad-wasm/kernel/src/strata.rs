//! Smooth strata: one smooth surface patch of a primitive (box face, cylinder
//! side/cap, cone mantle/base, sphere), represented by its unbounded analytic
//! *carrier* in world space. Port of the exact-analytic carriers from
//! `src/export/sfcc/strata.mts` (plane / sphere / cylinder / cone).
//!
//! M3a scope: the four exact, unit-gradient carriers consumed by the
//! smooth-surface refinement certificates (`stratum_normal_variation_ok`,
//! `stratum_edge_crossings_ok`). The non-unit-gradient ruled carriers
//! (twistedSide / loftSide) land in M4 (extrude/loft native features); they
//! return the NORMALIZED field g/|∇g| (first-order distance-like, same zero
//! set) so the Newton machinery stays well-scaled.
//!
//! `sign` bakes CSG orientation: −1 iff the owning primitive sits under an odd
//! number of Subtract right-hand ancestors, so `f`/`normal` always describe the
//! FINAL solid (outward normal, negative inside).

use crate::math::similarity::Similarity;
use crate::sfcc::field_branches::{FieldRef, FieldSample};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CarrierKind {
    Plane,
    Sphere,
    Cylinder,
    CylinderRim,
    Cone,
    TwistedSide,
    LoftSide,
    Compound,
    Field,
}

/// A smooth analytic carrier patch. Identity fields mirror `SfccStratum`'s
/// (`id`, `owner_node_id`, `leaf_index`, `local_index`, `sign`).
#[derive(Clone, Debug)]
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
    compound: Option<std::sync::Arc<CompoundCarrier>>,
    field: Option<FieldRef>,
    domain: Option<Vec<FieldRef>>,
}

/// Carrier geometry (world space). The owning [`Stratum`] applies `sign`.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Carrier {
    /// f = n·p + offset, ‖n‖ = 1.
    Plane { n: [f64; 3], offset: f64 },
    /// f = ‖p − c‖ − r.
    Sphere { c: [f64; 3], r: f64 },
    /// f = dist(p, axis) − r; axis through `a` with unit dir `u`.
    Cylinder { a: [f64; 3], u: [f64; 3], r: f64 },
    /// Distance to a cylinder rim; the exterior cap/mantle corner field.
    CylinderRim { c: [f64; 3], u: [f64; 3], r: f64 },
    /// Mantle: apex `a`, unit axis `u` (apex→base), half-angle (sin_a, cos_a).
    Cone { a: [f64; 3], u: [f64; 3], sin_a: f64, cos_a: f64 },
    /// Twisted-extrude side: ruled helicoidal sheet swept by one polygon edge's
    /// supporting line under the height-proportional twist (params from the leaf).
    TwistedSide(TwistedSideParams),
    /// Loft side: ruled sheet swept by linearly interpolating one polygon edge's
    /// supporting line between two profiles.
    LoftSide(LoftSideParams),
}

/// Parameters of a twisted-extrude side carrier. Mirrors `TwistedSideParams`
/// (`strata.mts`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TwistedSideParams {
    pub sim: Similarity,
    pub pos_x: f64,
    pub pos_y: f64,
    pub pos_z: f64,
    pub h: f64,
    pub twist_rad: f64,
    pub v0x: f64,
    pub v0z: f64,
    pub nx2: f64,
    pub nz2: f64,
}

/// Parameters of a loft side carrier. Mirrors `LoftSideParams` (`strata.mts`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LoftSideParams {
    pub sim: Similarity,
    pub pos_x: f64,
    pub pos_y: f64,
    pub pos_z: f64,
    pub seg_y0: f64,
    pub seg_h: f64,
    /// Edge A as a SEGMENT: start `(a_x,a_z)` → end `(a_x1,a_z1)`, outward unit
    /// normal `(a_nx,a_nz)`. The field blends the per-edge *segment* signed
    /// distances (not the infinite supporting lines) so it tracks the true
    /// blended-polygon SDF through profile-vertex regions instead of bowing off
    /// along the line.
    pub a_x: f64,
    pub a_z: f64,
    pub a_x1: f64,
    pub a_z1: f64,
    pub a_nx: f64,
    pub a_nz: f64,
    pub b_x: f64,
    pub b_z: f64,
    pub b_x1: f64,
    pub b_z1: f64,
    pub b_nx: f64,
    pub b_nz: f64,
}

/// Evaluate the twisted-side raw field g and its LOCAL gradient at a leaf-local
/// point. Returns `(g, grad_local)`. Port of `evalLocal` in
/// `makeTwistedSideStratum`.
fn twisted_eval_local(prm: &TwistedSideParams, lx: f64, ly: f64, lz: f64) -> (f64, [f64; 3]) {
    let qx = lx - prm.pos_x;
    let qy = ly - prm.pos_y;
    let qz = lz - prm.pos_z;
    let t_raw = (qy + prm.h) / (2.0 * prm.h);
    let t = t_raw.clamp(0.0, 1.0);
    let angle = prm.twist_rad * t;
    let ca = angle.cos();
    let sa = angle.sin();
    let tw1 = ca * qx + sa * qz;
    let tw2 = -sa * qx + ca * qz;
    let g = (tw1 - prm.v0x) * prm.nx2 + (tw2 - prm.v0z) * prm.nz2;
    let mut grad = [0.0f64; 3];
    grad[0] = prm.nx2 * ca - prm.nz2 * sa;
    grad[2] = prm.nx2 * sa + prm.nz2 * ca;
    let k = if t_raw > 0.0 && t_raw < 1.0 && prm.h.abs() > 1e-9 { prm.twist_rad / (2.0 * prm.h) } else { 0.0 };
    grad[1] = k * (prm.nx2 * tw2 - prm.nz2 * tw1);
    (g, grad)
}

/// Signed distance (+ xz-gradient) of `(qx,qz)` to a 2D edge SEGMENT
/// `(x0,z0)→(x1,z1)` with outward unit normal `(nx,nz)`. Equals the signed
/// supporting-line distance when the foot lies on the segment interior, and the
/// signed distance to the nearer endpoint past an end — i.e. the per-edge term of
/// the true polygon SDF inside this edge's Voronoi region. Sign = side of the
/// supporting line (outward positive), correct through a convex corner.
#[inline]
fn seg_signed_dist(qx: f64, qz: f64, x0: f64, z0: f64, x1: f64, z1: f64, nx: f64, nz: f64) -> (f64, f64, f64) {
    let line = (qx - x0) * nx + (qz - z0) * nz; // signed line distance (n is unit outward)
    let ex = x1 - x0;
    let ez = z1 - z0;
    let len2 = ex * ex + ez * ez;
    if len2 < 1e-18 {
        return (line, nx, nz); // degenerate edge → fall back to the line
    }
    let tt = ((qx - x0) * ex + (qz - z0) * ez) / len2;
    if tt > 0.0 && tt < 1.0 {
        return (line, nx, nz); // foot on the segment interior → exact line distance
    }
    // Past an endpoint: distance to that vertex, signed by the supporting-line side.
    let (vx, vz) = if tt <= 0.0 { (x0, z0) } else { (x1, z1) };
    let dx = qx - vx;
    let dz = qz - vz;
    let d = (dx * dx + dz * dz).sqrt();
    if d < 1e-12 {
        return (0.0, nx, nz); // exactly at the vertex
    }
    let sgn = if line >= 0.0 { 1.0 } else { -1.0 };
    (sgn * d, sgn * dx / d, sgn * dz / d)
}

/// Evaluate the loft-side raw field g and its LOCAL gradient. Returns
/// `(g, grad_local)`. The field blends the two adjacent edges' SEGMENT signed
/// distances (vertex-aware), so it equals the true blended-polygon SDF surface
/// within the carrier's patch + adjacent vertex regions, instead of the bowing
/// edge-LINE blend of the original port.
fn loft_eval_local(prm: &LoftSideParams, lx: f64, ly: f64, lz: f64) -> (f64, [f64; 3]) {
    let qx = lx - prm.pos_x;
    let qy = ly - prm.pos_y;
    let qz = lz - prm.pos_z;
    let t = (qy - prm.seg_y0) / prm.seg_h;
    let (d_a, dax, daz) = seg_signed_dist(qx, qz, prm.a_x, prm.a_z, prm.a_x1, prm.a_z1, prm.a_nx, prm.a_nz);
    let (d_b, dbx, dbz) = seg_signed_dist(qx, qz, prm.b_x, prm.b_z, prm.b_x1, prm.b_z1, prm.b_nx, prm.b_nz);
    let grad = [(1.0 - t) * dax + t * dbx, (d_b - d_a) / prm.seg_h, (1.0 - t) * daz + t * dbz];
    ((1.0 - t) * d_a + t * d_b, grad)
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

#[derive(Clone, Debug)]
struct CompoundCarrier {
    terms: Vec<(Stratum, f64)>,
    offset: f64,
}

impl Stratum {
    pub fn same_primitive_field(&self, other: &Self) -> bool {
        self.compound.is_none()
            && other.compound.is_none()
            && self.field.is_none()
            && other.field.is_none()
            && self.sign == other.sign
            && self.carrier == other.carrier
    }
    pub fn with_domain(mut self, domain: FieldRef) -> Self {
        self.domain = Some(vec![domain]);
        self
    }

    pub(crate) fn with_domain_of(mut self, other: &Self) -> Self {
        self.domain = other.domain.clone();
        self
    }

    pub(crate) fn merge_domains(&mut self, other: &Self) {
        match (&mut self.domain, &other.domain) {
            (Some(a), Some(b)) => a.extend(b.iter().cloned()),
            _ => self.domain = None,
        }
    }

    /// Supporting extensions are not automatically exposed operand patches.
    /// In particular a cutter's zero set must not mask a blend branch that is
    /// strictly inside its own operand. Test the owner's surface independently.
    pub fn domain_contains(&self, p: [f64; 3], tolerance: f64) -> bool {
        self.domain.as_ref().is_none_or(|domains| domains.iter().any(|domain| domain.surface_live(p, tolerance)))
    }
    /// Exact operand field, shared by generated feature expressions.
    pub fn field(ident: StratumIdentity, node: FieldRef) -> Self {
        let mut st = Self::plane(ident, 0., 1., 0., 0.);
        st.kind = CarrierKind::Field;
        st.field = Some(node);
        st
    }

    /// Affine combination of analytic fields. Preserve raw coefficients through
    /// nesting; the normalized residual is used only by projection/tracing.
    pub fn combination(ident: StratumIdentity, a: &Stratum, b: &Stratum, offset: f64) -> Self {
        let mut terms = Vec::new();
        let mut total_offset = offset;
        for st in [a, b] {
            if let Some(c) = &st.compound {
                total_offset += c.offset * st.sign * std::f64::consts::FRAC_1_SQRT_2;
                terms.extend(c.terms.iter().map(|(s, w)| (s.clone(), w * st.sign * std::f64::consts::FRAC_1_SQRT_2)));
            } else {
                terms.push((st.clone(), std::f64::consts::FRAC_1_SQRT_2));
            }
        }
        let mut st = Self::plane(ident, 0., 1., 0., 0.);
        st.kind = CarrierKind::Compound;
        st.compound = Some(std::sync::Arc::new(CompoundCarrier { terms, offset: total_offset }));
        st
    }

    /// Raw affine coefficients when this expression contains only planes.
    pub fn planar_coefficients(&self) -> Option<[f64; 4]> {
        if self.field.is_some() {
            return None;
        }
        if let Some(c) = &self.compound {
            let mut out = [0., 0., 0., c.offset];
            for (st, w) in &c.terms {
                let f = st.planar_coefficients()?;
                for k in 0..4 {
                    out[k] += w * f[k];
                }
            }
            Some(out.map(|v| self.sign * v))
        } else if let Carrier::Plane { n, offset } = self.carrier {
            Some([self.sign * n[0], self.sign * n[1], self.sign * n[2], self.sign * offset])
        } else {
            None
        }
    }

    fn compound_field(&self, x: f64, y: f64, z: f64) -> (f64, [f64; 3]) {
        let c = self.compound.as_ref().expect("compound carrier");
        let mut value = c.offset;
        let mut grad = [0.; 3];
        for (st, weight) in &c.terms {
            let sample = st.raw_field(x, y, z);
            value += weight * sample.value;
            for k in 0..3 {
                grad[k] += weight * sample.gradient[k];
            }
        }
        (self.sign * value, grad.map(|v| self.sign * v))
    }

    /// Unnormalized field and its actual derivative. Unlike `f`, this is safe
    /// to compose with another field, including ruled and nested blend fields.
    pub fn raw_field(&self, x: f64, y: f64, z: f64) -> FieldSample {
        if let Some(node) = &self.field {
            let v = crate::sfcc::field_branches::sample_tree(node.node(), [x, y, z]);
            return FieldSample { value: self.sign * v.value, gradient: v.gradient.map(|g| self.sign * g) };
        }
        if self.compound.is_some() {
            let (value, gradient) = self.compound_field(x, y, z);
            return FieldSample { value, gradient };
        }
        let (sim, value, grad) = match self.carrier {
            Carrier::TwistedSide(prm) => {
                let p = prm.sim.inv_apply_point(x, y, z);
                let (f, g) = twisted_eval_local(&prm, p[0], p[1], p[2]);
                (prm.sim, f, g)
            }
            Carrier::LoftSide(prm) => {
                let p = prm.sim.inv_apply_point(x, y, z);
                let (f, g) = loft_eval_local(&prm, p[0], p[1], p[2]);
                (prm.sim, f, g)
            }
            _ => return FieldSample { value: self.f(x, y, z), gradient: self.normal(x, y, z) },
        };
        FieldSample {
            value: self.sign * sim.s * value,
            gradient: sim.rotate_vector(grad[0], grad[1], grad[2]).map(|v| self.sign * v),
        }
    }
    pub fn plane(ident: StratumIdentity, nx: f64, ny: f64, nz: f64, offset: f64) -> Stratum {
        Stratum::wrap(ident, CarrierKind::Plane, Carrier::Plane { n: [nx, ny, nz], offset })
    }

    pub fn cylinder_rim(ident: StratumIdentity, c: [f64; 3], u: [f64; 3], r: f64) -> Stratum {
        Stratum::wrap(ident, CarrierKind::CylinderRim, Carrier::CylinderRim { c, u, r })
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
        Stratum::wrap(ident, CarrierKind::Cone, Carrier::Cone { a: [ax, ay, az], u: [ux, uy, uz], sin_a, cos_a })
    }

    pub fn twisted_side(ident: StratumIdentity, prm: TwistedSideParams) -> Stratum {
        Stratum::wrap(ident, CarrierKind::TwistedSide, Carrier::TwistedSide(prm))
    }

    pub fn loft_side(ident: StratumIdentity, prm: LoftSideParams) -> Stratum {
        Stratum::wrap(ident, CarrierKind::LoftSide, Carrier::LoftSide(prm))
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
            compound: None,
            field: None,
            domain: None,
        }
    }

    /// Sound upper bound on this carrier's max surface-normal curvature (1/length)
    /// over a cell with the 9 probe points `pts` (8 corners + center, xyz each) and
    /// edge length `cell_size`. `Some(κ)` for analytic carriers (the per-cell normal
    /// variation is then ≤ κ·cell_size); `None` for the ruled twisted/loft sides (no
    /// closed-form bound → caller falls back to the sampled ∇f cone). Lever 2: the
    /// per-stratum smoothCrit (iii-b) cert can then split iff `κ·cell_size > θ`,
    /// replacing the O(k²) sampled normal cone with one closed-form comparison.
    pub fn curvature_bound(&self, pts: &[f64; 27], cell_size: f64) -> Option<f64> {
        if self.compound.is_some() || self.field.is_some() {
            return None;
        }
        match self.carrier {
            Carrier::Plane { .. } => Some(0.0),
            Carrier::Sphere { r, .. } => Some(1.0 / r.abs().max(1e-12)),
            // Cylinder: the analytic κ=1/r bound is exact+cheap, but in the refine
            // loop it measured ~3.6× SLOWER than the sampled cone at the SAME leaf
            // count (no cell saving, net regression) — so fall back to the proven
            // sampled ∇f cone here. Sphere (exact 1/R, ~4× fewer cells) and cone
            // (neutral) keep the analytic path. Revisit if a net-positive cylinder
            // formulation is found.
            Carrier::Cylinder { .. } | Carrier::CylinderRim { .. } => None,
            // Cone: circumferential normal curvature is cos(α)/ρ (meridian = 0), so
            // κ_max = cos(α)/ρ_min over the cell. ρ_min(box) ≥ (min ρ over probes) −
            // ½·√3·cell_size (the box can reach ½·diagonal closer to the axis than any
            // probe); clamp the denominator so a cell at/near the apex gets a huge κ →
            // always split (correct — the apex is a feature point).
            Carrier::Cone { a, u, cos_a, .. } => {
                let mut rho_min = f64::INFINITY;
                for i in 0..9 {
                    let dx = pts[i * 3] - a[0];
                    let dy = pts[i * 3 + 1] - a[1];
                    let dz = pts[i * 3 + 2] - a[2];
                    let t = dx * u[0] + dy * u[1] + dz * u[2];
                    let (qx, qy, qz) = (dx - t * u[0], dy - t * u[1], dz - t * u[2]);
                    let rho = (qx * qx + qy * qy + qz * qz).sqrt();
                    if rho < rho_min {
                        rho_min = rho;
                    }
                }
                let slack = 0.5 * 3.0f64.sqrt() * cell_size;
                Some(cos_a / (rho_min - slack).max(1e-9))
            }
            Carrier::TwistedSide(_) | Carrier::LoftSide(_) => None,
        }
    }

    /// Signed distance to the carrier, sign-adjusted (negative on the final
    /// solid's inside of this patch).
    pub fn f(&self, px: f64, py: f64, pz: f64) -> f64 {
        if self.compound.is_some() || self.field.is_some() {
            return self.raw_field(px, py, pz).normalized_equation().map_or(f64::NAN, |v| v.value);
        }
        let s = self.sign;
        match self.carrier {
            Carrier::Plane { n, offset } => s * (n[0] * px + n[1] * py + n[2] * pz + offset),
            Carrier::Sphere { c, r } => s * (hypot3(px - c[0], py - c[1], pz - c[2]) - r),
            Carrier::Cylinder { a, u, r } => {
                let (rx, ry, rz, _t) = cyl_radial(a, u, px, py, pz);
                s * (hypot3(rx, ry, rz) - r)
            }
            Carrier::CylinderRim { c, u, r } => {
                let (rx, ry, rz, t) = cyl_radial(c, u, px, py, pz);
                s * (hypot3(rx, ry, rz) - r).hypot(t)
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
            Carrier::TwistedSide(prm) => {
                let l = prm.sim.inv_apply_point(px, py, pz);
                let (g, grad) = twisted_eval_local(&prm, l[0], l[1], l[2]);
                let m = hypot3(grad[0], grad[1], grad[2]);
                s * prm.sim.s * g / m.max(1e-12)
            }
            Carrier::LoftSide(prm) => {
                let l = prm.sim.inv_apply_point(px, py, pz);
                let (g, grad) = loft_eval_local(&prm, l[0], l[1], l[2]);
                let m = hypot3(grad[0], grad[1], grad[2]);
                s * prm.sim.s * g / m.max(1e-12)
            }
        }
    }

    /// Closest point on the carrier surface (sign-independent geometric
    /// projection). Port of `SfccStratum.project`.
    pub fn project(&self, px: f64, py: f64, pz: f64) -> [f64; 3] {
        if self.compound.is_some() || self.field.is_some() {
            let mut p = [px, py, pz];
            for _ in 0..32 {
                let FieldSample { value: f, gradient: g } = self.raw_field(p[0], p[1], p[2]);
                let gg = g.iter().map(|v| v * v).sum::<f64>();
                if f.abs() < 1e-10 {
                    return p;
                }
                if !f.is_finite() || gg < 1e-24 {
                    break;
                }
                let mut step = 1.;
                let mut accepted = false;
                for _ in 0..12 {
                    let q = std::array::from_fn(|k| p[k] - step * f * g[k] / gg);
                    let fq = self.raw_field(q[0], q[1], q[2]).value;
                    if fq.abs() < f.abs() {
                        p = q;
                        accepted = true;
                        break;
                    }
                    step *= 0.5;
                }
                if !accepted {
                    break;
                }
            }
            return [f64::NAN; 3];
        }
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
            Carrier::CylinderRim { c, u, r } => {
                let (rx, ry, rz, _) = cyl_radial(c, u, px, py, pz);
                let len = hypot3(rx, ry, rz);
                if len < 1e-30 {
                    return [f64::NAN; 3];
                }
                [c[0] + r * rx / len, c[1] + r * ry / len, c[2] + r * rz / len]
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
            Carrier::TwistedSide(prm) => {
                let l = prm.sim.inv_apply_point(px, py, pz);
                let (lx, ly, lz) = ruled_project_local(&l, |x, y, z| twisted_eval_local(&prm, x, y, z));
                prm.sim.apply_point(lx, ly, lz)
            }
            Carrier::LoftSide(prm) => {
                let l = prm.sim.inv_apply_point(px, py, pz);
                let (lx, ly, lz) = ruled_project_local(&l, |x, y, z| loft_eval_local(&prm, x, y, z));
                prm.sim.apply_point(lx, ly, lz)
            }
        }
    }

    /// Exact unit outward normal of the final solid on this patch.
    pub fn normal(&self, px: f64, py: f64, pz: f64) -> [f64; 3] {
        if self.compound.is_some() || self.field.is_some() {
            return self.raw_field(px, py, pz).normalized_equation().map_or([f64::NAN; 3], |v| v.gradient);
        }
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
            Carrier::CylinderRim { c, u, r } => {
                let (rx, ry, rz, t) = cyl_radial(c, u, px, py, pz);
                let rho = hypot3(rx, ry, rz);
                let d = (rho - r).hypot(t);
                if rho < 1e-30 || d < 1e-30 {
                    return [s, 0., 0.];
                }
                let radial = (rho - r) / rho;
                [s * (radial * rx + t * u[0]) / d, s * (radial * ry + t * u[1]) / d, s * (radial * rz + t * u[2]) / d]
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
            Carrier::TwistedSide(prm) => {
                let l = prm.sim.inv_apply_point(px, py, pz);
                let (_, grad) = twisted_eval_local(&prm, l[0], l[1], l[2]);
                ruled_world_normal(&prm.sim, grad, s)
            }
            Carrier::LoftSide(prm) => {
                let l = prm.sim.inv_apply_point(px, py, pz);
                let (_, grad) = loft_eval_local(&prm, l[0], l[1], l[2]);
                ruled_world_normal(&prm.sim, grad, s)
            }
        }
    }
}

/// Gradient-descent projection of a ruled carrier's NORMALIZED field onto its
/// zero set, in leaf-local space (8 iterations, matching the TS `project`
/// closures of `makeTwistedSideStratum`/`makeLoftSideStratum`).
fn ruled_project_local(l: &[f64; 3], eval: impl Fn(f64, f64, f64) -> (f64, [f64; 3])) -> (f64, f64, f64) {
    let (mut lx, mut ly, mut lz) = (l[0], l[1], l[2]);
    for _ in 0..8 {
        let (g, grad) = eval(lx, ly, lz);
        let m2 = grad[0] * grad[0] + grad[1] * grad[1] + grad[2] * grad[2];
        if m2 < 1e-18 {
            break;
        }
        let k = g / m2;
        lx -= k * grad[0];
        ly -= k * grad[1];
        lz -= k * grad[2];
        if g.abs() < 1e-12 {
            break;
        }
    }
    (lx, ly, lz)
}

/// Rotate a ruled carrier's LOCAL gradient to world, normalize, apply `sign`;
/// degenerate gradient falls back to (s,0,0). Matches the TS ruled `normal`.
fn ruled_world_normal(sim: &Similarity, grad_local: [f64; 3], s: f64) -> [f64; 3] {
    let w = sim.rotate_vector(grad_local[0], grad_local[1], grad_local[2]);
    let len = hypot3(w[0], w[1], w[2]);
    if len > 1e-12 {
        [s * w[0] / len, s * w[1] / len, s * w[2] / len]
    } else {
        [s, 0.0, 0.0]
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
    fn ruled_chamfer_retains_raw_derivative_under_transform_and_nesting() {
        let mut sim = Similarity::identity();
        sim.s = 2.5;
        sim.r = [0., -1., 0., 1., 0., 0., 0., 0., 1.];
        sim.t = [4., -3., 2.];
        let ruled = Stratum::twisted_side(
            StratumIdentity { sign: -1., ..ident() },
            TwistedSideParams {
                sim,
                pos_x: 0.,
                pos_y: 0.,
                pos_z: 0.,
                h: 2.,
                twist_rad: 1.2,
                v0x: 1.,
                v0z: 0.,
                nx2: 1.,
                nz2: 0.,
            },
        );
        let plane = Stratum::plane(ident(), 0., 0., 1., -2.);
        let c = Stratum::combination(ident(), &ruled, &plane, -0.7);
        let nested = Stratum::combination(ident(), &c, &ruled, -0.3);
        for local in [[1.4, 0.3, 0.7], [1.4, -3., 0.7], [1.4, 3., 0.7]] {
            let p = sim.apply_point(local[0], local[1], local[2]);
            let angle = 1.2 * ((local[1] + 2.) / 4.).clamp(0., 1.);
            let raw = -2.5 * (angle.cos() * local[0] + angle.sin() * local[2] - 1.);
            assert!((ruled.raw_field(p[0], p[1], p[2]).value - raw).abs() < 1e-12);
            let expected = (((raw + plane.f(p[0], p[1], p[2])) / 2f64.sqrt() - 0.7) + raw) / 2f64.sqrt() - 0.3;
            assert!((nested.raw_field(p[0], p[1], p[2]).value - expected).abs() < 1e-12);
            for st in [&ruled, &nested] {
                let actual = st.raw_field(p[0], p[1], p[2]);
                for k in 0..3 {
                    let (mut a, mut b) = (p, p);
                    a[k] -= 1e-5;
                    b[k] += 1e-5;
                    let numerical =
                        (st.raw_field(b[0], b[1], b[2]).value - st.raw_field(a[0], a[1], a[2]).value) / 2e-5;
                    assert!((actual.gradient[k] - numerical).abs() < 1e-8);
                }
            }
        }
    }

    #[test]
    fn curved_chamfer_carrier_has_analytic_normal_and_projection() {
        let a = Stratum::cylinder(ident(), 0., 0., 0., 0., 1., 0., 8.);
        let b = Stratum::cylinder(ident(), 0., 0., 0., 0., 0., 1., 6.5);
        let c = Stratum::combination(ident(), &a, &b, -1.5 * std::f64::consts::FRAC_1_SQRT_2);
        assert!(c.f(0., 8., 8.).abs() < 1e-12);
        let n = c.normal(0., 8., 8.);
        assert!(n[0].abs() < 1e-12);
        assert!((n[1] - std::f64::consts::FRAC_1_SQRT_2).abs() < 1e-12);
        assert!((n[2] - std::f64::consts::FRAC_1_SQRT_2).abs() < 1e-12);
        let p = c.project(0., 8.2, 8.2);
        assert!((p[1] - 8.).abs() < 1e-9 && (p[2] - 8.).abs() < 1e-9);
        assert!(c.planar_coefficients().is_none());
        // Nested combinations must retain the raw field gradient magnitude.
        let d = Stratum::combination(ident(), &c, &b, -1.5 * std::f64::consts::FRAC_1_SQRT_2);
        let q = d.project(2., 8., 8.);
        let f = ((a.f(q[0], q[1], q[2]) + b.f(q[0], q[1], q[2]) - 1.5) * std::f64::consts::FRAC_1_SQRT_2
            + b.f(q[0], q[1], q[2])
            - 1.5)
            * std::f64::consts::FRAC_1_SQRT_2;
        assert!(f.abs() < 1e-9, "raw nested chamfer residual {f}");
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
