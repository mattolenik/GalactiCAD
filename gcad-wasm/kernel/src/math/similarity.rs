//! Similarity-transform baking for the SFCC CPU evaluator.
//! Port of `src/export/sfcc/transform-bake.mts`.
//!
//! The v1 transform subset (Translate / Rotate / uniform positive Scale)
//! composes into a similarity `world = s·(R·local) + t`, which keeps analytic
//! carriers exact: planes stay planes, cylinders stay circular cylinders, cone
//! half-angles are preserved. This is why SFCC v1 rejects non-uniform scale.
//!
//! Rotation convention (the repo's historical transpose-bug hotspot): the WGSL
//! side packs flat arrays as *columns*, so `Rotate.getWgslMatrices().fwd` read
//! row-major is the world-to-local map, and world-from-local is its transpose.
//! [`Similarity::from_rotation_wgsl_fwd`] bakes that transpose.

/// A similarity transform `world = s·(R·local) + t`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Similarity {
    /// 3×3 world-from-local rotation, row-major, proper (det +1).
    pub r: [f64; 9],
    /// World-space translation.
    pub t: [f64; 3],
    /// Uniform scale factor, > 0.
    pub s: f64,
}

const IDENTITY_R: [f64; 9] = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];

impl Similarity {
    pub fn identity() -> Self {
        Similarity { r: IDENTITY_R, t: [0.0; 3], s: 1.0 }
    }

    pub fn from_translation(dx: f64, dy: f64, dz: f64) -> Self {
        Similarity { r: IDENTITY_R, t: [dx, dy, dz], s: 1.0 }
    }

    /// From `Rotate.getWgslMatrices().fwd` (flat, row-major = world-to-local):
    /// the world-from-local rotation is its transpose.
    pub fn from_rotation_wgsl_fwd(fwd: &[f64; 9]) -> Self {
        let f = fwd;
        Similarity {
            r: [f[0], f[3], f[6], f[1], f[4], f[7], f[2], f[5], f[8]],
            t: [0.0; 3],
            s: 1.0,
        }
    }

    pub fn from_uniform_scale(s: f64) -> Self {
        assert!(s > 0.0, "sfcc: uniform scale must be > 0, got {s}");
        Similarity { r: IDENTITY_R, t: [0.0; 3], s }
    }

    /// Compose: `out(x) = parent(local(x))` — `local` is applied first (it sits
    /// below `parent` in the scene tree).
    pub fn compose(parent: &Similarity, local: &Similarity) -> Self {
        let pr = &parent.r;
        let lr = &local.r;
        let mut r = [0.0f64; 9];
        for i in 0..3 {
            for j in 0..3 {
                r[i * 3 + j] = pr[i * 3] * lr[j] + pr[i * 3 + 1] * lr[3 + j] + pr[i * 3 + 2] * lr[6 + j];
            }
        }
        // t = s_p·R_p·t_l + t_p
        let mut t = [0.0f64; 3];
        for i in 0..3 {
            t[i] = parent.s
                * (pr[i * 3] * local.t[0] + pr[i * 3 + 1] * local.t[1] + pr[i * 3 + 2] * local.t[2])
                + parent.t[i];
        }
        Similarity { r, t, s: parent.s * local.s }
    }

    /// world = s·R·local + t.
    pub fn apply_point(&self, x: f64, y: f64, z: f64) -> [f64; 3] {
        let r = &self.r;
        [
            self.s * (r[0] * x + r[1] * y + r[2] * z) + self.t[0],
            self.s * (r[3] * x + r[4] * y + r[5] * z) + self.t[1],
            self.s * (r[6] * x + r[7] * y + r[8] * z) + self.t[2],
        ]
    }

    /// local = Rᵀ·(world − t)/s.
    pub fn inv_apply_point(&self, x: f64, y: f64, z: f64) -> [f64; 3] {
        let r = &self.r;
        let dx = (x - self.t[0]) / self.s;
        let dy = (y - self.t[1]) / self.s;
        let dz = (z - self.t[2]) / self.s;
        [
            r[0] * dx + r[3] * dy + r[6] * dz,
            r[1] * dx + r[4] * dy + r[7] * dz,
            r[2] * dx + r[5] * dy + r[8] * dz,
        ]
    }

    /// Rotate a local-space direction into world space (no translation/scale —
    /// correct for unit normals and tangents under a similarity).
    pub fn rotate_vector(&self, x: f64, y: f64, z: f64) -> [f64; 3] {
        let r = &self.r;
        [
            r[0] * x + r[1] * y + r[2] * z,
            r[3] * x + r[4] * y + r[5] * z,
            r[6] * x + r[7] * y + r[8] * z,
        ]
    }

    /// Rotate a world-space direction into local space (Rᵀ).
    pub fn inv_rotate_vector(&self, x: f64, y: f64, z: f64) -> [f64; 3] {
        let r = &self.r;
        [
            r[0] * x + r[3] * y + r[6] * z,
            r[1] * x + r[4] * y + r[7] * z,
            r[2] * x + r[5] * y + r[8] * z,
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rot_z(th: f64) -> Similarity {
        let (s, c) = (th.sin(), th.cos());
        Similarity { r: [c, -s, 0.0, s, c, 0.0, 0.0, 0.0, 1.0], t: [0.0; 3], s: 1.0 }
    }
    fn rot_y(th: f64) -> Similarity {
        let (s, c) = (th.sin(), th.cos());
        Similarity { r: [c, 0.0, s, 0.0, 1.0, 0.0, -s, 0.0, c], t: [0.0; 3], s: 1.0 }
    }

    #[test]
    fn from_rotation_wgsl_fwd_transposes() {
        let fwd = [1., 2., 3., 4., 5., 6., 7., 8., 9.];
        let sim = Similarity::from_rotation_wgsl_fwd(&fwd);
        assert_eq!(sim.r, [1., 4., 7., 2., 5., 8., 3., 6., 9.]);
        assert_eq!(sim.t, [0.0; 3]);
        assert_eq!(sim.s, 1.0);
    }

    #[test]
    fn apply_inv_apply_roundtrip() {
        let sim = Similarity::compose(
            &Similarity::compose(&Similarity::from_translation(3., -2., 5.), &rot_z(0.7)),
            &Similarity::from_uniform_scale(2.5),
        );
        for &(x, y, z) in &[(0., 0., 0.), (1., 2., 3.), (-7.5, 0.25, 11.)] {
            let p = sim.apply_point(x, y, z);
            let q = sim.inv_apply_point(p[0], p[1], p[2]);
            assert!((q[0] - x).abs() < 1e-12 && (q[1] - y).abs() < 1e-12 && (q[2] - z).abs() < 1e-12);
        }
    }

    #[test]
    fn rotation_preserves_length_and_inverts() {
        let sim = Similarity::compose(&rot_z(0.23), &rot_y(-1.34));
        let v = sim.rotate_vector(1., 2., 3.);
        let len = v[0].hypot(v[1]).hypot(v[2]);
        assert!((len - 1.0f64.hypot(2.0).hypot(3.0)).abs() < 1e-12);
        let back = sim.inv_rotate_vector(v[0], v[1], v[2]);
        assert!((back[0] - 1.).abs() < 1e-12 && (back[1] - 2.).abs() < 1e-12 && (back[2] - 3.).abs() < 1e-12);
    }

    #[test]
    fn composition_child_first() {
        // translate(1,0,0) ∘ scale(2): local x=1 → scaled 2 → translated 3.
        let sim = Similarity::compose(&Similarity::from_translation(1., 0., 0.), &Similarity::from_uniform_scale(2.));
        assert_eq!(sim.apply_point(1., 0., 0.), [3., 0., 0.]);
    }
}
