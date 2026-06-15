//! S1 native feature compilation. Port of `compileNativeFeatures`
//! (`src/export/sfcc/feature-set.mts`), recomputed analytically from the baked
//! similarities.
//!
//! M4a: **box / cylinder / cone / sphere** native features + per-shape strata
//! builders. Box = 12 segment edges + 8 valence-3 corners; cylinder = 2 rim
//! circles; cone = base circle + apex corner; sphere = no curves, one carrier.
//! Each leaf contributes its strata to the global `strata` list (matching the TS
//! evaluator's per-leaf `buildStrata` order), so curve `adjacent_strata` indices
//! line up with the TS tree. Strata CARRIER geometry (f/normal) is now
//! parity-verified against TS (`tests/strata_parity.rs`), closing the earlier gap.
//!
//! DEFERRED to later M4 slices: lathe rings + extrude/loft (traced curves, newton,
//! twistedSide/loftSide ruled carriers), boolean seams (seam-trace + trim), and
//! the feature-aware refine/contour/cell-mesh honoring paths.

use crate::math::similarity::Similarity;
use crate::sdf::{CsgNode, Leaf, Shape};
use crate::sfcc::feature_curves::{make_circle_curve, make_segment_curve, FeatureCurve};
use crate::sfcc::spatial_index::SfccSpatialIndex;
use crate::strata::{Stratum, StratumIdentity};

#[derive(Clone, Debug)]
pub struct SfccCorner {
    pub id: usize,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    /// Incident stratum ids.
    pub strata: Vec<usize>,
    /// (curve_id, end) where end ∈ {0,1}.
    pub curve_ends: Vec<(usize, u8)>,
}

pub struct SfccFeatureSet {
    pub curves: Vec<FeatureCurve>,
    pub corners: Vec<SfccCorner>,
    pub index: SfccSpatialIndex,
    /// All strata of the compiled tree (curve.adjacent_strata index into this).
    pub strata: Vec<Stratum>,
}

fn collect_leaves<'a>(node: &'a CsgNode, out: &mut Vec<&'a Leaf>) {
    match node {
        CsgNode::Leaf(l) => out.push(l),
        CsgNode::Min(ch) | CsgNode::Max(ch) => {
            for c in ch {
                collect_leaves(c, out);
            }
        }
        CsgNode::Blend { children, .. } => {
            for c in children {
                collect_leaves(c, out);
            }
        }
    }
}

/// Similarity transform of a local plane `n·local + off = 0` into world space:
/// `(R·n)·world + (s·off − (R·n)·t) = 0` (R·n stays unit).
fn world_plane(ident: StratumIdentity, sim: &Similarity, nx: f64, ny: f64, nz: f64, off: f64) -> Stratum {
    let wn = sim.rotate_vector(nx, ny, nz);
    let woff = -(wn[0] * sim.t[0] + wn[1] * sim.t[1] + wn[2] * sim.t[2]) + sim.s * off;
    Stratum::plane(ident, wn[0], wn[1], wn[2], woff)
}

/// The 6 box face planes, order +x,−x,+y,−y,+z,−z (local_index 0..5).
fn build_box_strata(leaf: &Leaf, leaf_index: usize, first_id: usize, half: [f64; 3]) -> Vec<Stratum> {
    let [px, py, pz] = leaf.pos;
    let [hx, hy, hz] = half;
    let mk = |i: usize, nx: f64, ny: f64, nz: f64, off: f64| {
        world_plane(
            StratumIdentity { id: first_id + i, owner_node_id: -1, leaf_index, local_index: i, sign: leaf.sign },
            &leaf.sim,
            nx,
            ny,
            nz,
            off,
        )
    };
    vec![
        mk(0, 1.0, 0.0, 0.0, -(px + hx)),
        mk(1, -1.0, 0.0, 0.0, px - hx),
        mk(2, 0.0, 1.0, 0.0, -(py + hy)),
        mk(3, 0.0, -1.0, 0.0, py - hy),
        mk(4, 0.0, 0.0, 1.0, -(pz + hz)),
        mk(5, 0.0, 0.0, -1.0, pz - hz),
    ]
}

fn sid(id: usize, leaf_index: usize, local_index: usize, sign: f64) -> StratumIdentity {
    StratumIdentity { id, owner_node_id: -1, leaf_index, local_index, sign }
}

/// Cylinder strata: [mantle, cap +y, cap −y] (local_index 0,1,2), matching the
/// evaluator's `buildStrata` order in cpu-sdf.mts.
fn build_cylinder_strata(leaf: &Leaf, leaf_index: usize, first_id: usize, r: f64, h: f64) -> Vec<Stratum> {
    let [px, py, pz] = leaf.pos;
    let a = leaf.sim.apply_point(px, py, pz);
    let u = leaf.sim.rotate_vector(0.0, 1.0, 0.0);
    vec![
        Stratum::cylinder(sid(first_id, leaf_index, 0, leaf.sign), a[0], a[1], a[2], u[0], u[1], u[2], leaf.sim.s * r),
        world_plane(sid(first_id + 1, leaf_index, 1, leaf.sign), &leaf.sim, 0.0, 1.0, 0.0, -(py + h)),
        world_plane(sid(first_id + 2, leaf_index, 2, leaf.sign), &leaf.sim, 0.0, -1.0, 0.0, py - h),
    ]
}

/// Cone strata: [mantle, base plane] (local_index 0,1). Half-angle from L=hypot(h,r):
/// sin = r/L, cos = h/L; apex at +h, axis `u` points apex→base (local −y).
fn build_cone_strata(leaf: &Leaf, leaf_index: usize, first_id: usize, r: f64, h: f64) -> Vec<Stratum> {
    let [px, py, pz] = leaf.pos;
    let apex = leaf.sim.apply_point(px, py + h, pz);
    let u = leaf.sim.rotate_vector(0.0, -1.0, 0.0);
    let l = h.hypot(r);
    vec![
        Stratum::cone(sid(first_id, leaf_index, 0, leaf.sign), apex[0], apex[1], apex[2], u[0], u[1], u[2], r / l, h / l),
        world_plane(sid(first_id + 1, leaf_index, 1, leaf.sign), &leaf.sim, 0.0, -1.0, 0.0, py),
    ]
}

/// Sphere stratum: a single sphere carrier (sphere has no native curves/corners).
fn build_sphere_strata(leaf: &Leaf, leaf_index: usize, first_id: usize, r: f64) -> Vec<Stratum> {
    let [px, py, pz] = leaf.pos;
    let c = leaf.sim.apply_point(px, py, pz);
    vec![Stratum::sphere(sid(first_id, leaf_index, 0, leaf.sign), c[0], c[1], c[2], leaf.sim.s * r)]
}

pub fn compile_native_features(root: &CsgNode) -> SfccFeatureSet {
    let mut leaves: Vec<&Leaf> = Vec::new();
    collect_leaves(root, &mut leaves);

    let mut curves: Vec<FeatureCurve> = Vec::new();
    let mut corners: Vec<SfccCorner> = Vec::new();
    let mut all_strata: Vec<Stratum> = Vec::new();
    let mut diag: f64 = 1.0;

    for (leaf_index, leaf) in leaves.iter().enumerate() {
        let first_id = all_strata.len();
        match leaf.shape {
            Shape::Cuboid { half } => {
                let strata = build_box_strata(leaf, leaf_index, first_id, half);
                let [cx, cy, cz] = leaf.pos;
                let [hx, hy, hz] = half;
                // World corners; bit0=x, bit1=y, bit2=z.
                let mut corner_pos = [[0.0f64; 3]; 8];
                for (i, cp) in corner_pos.iter_mut().enumerate() {
                    *cp = leaf.sim.apply_point(
                        cx + if i & 1 != 0 { hx } else { -hx },
                        cy + if i & 2 != 0 { hy } else { -hy },
                        cz + if i & 4 != 0 { hz } else { -hz },
                    );
                }
                // Track scene diagonal from world corners.
                for a in 0..8 {
                    for b in (a + 1)..8 {
                        let d = (corner_pos[a][0] - corner_pos[b][0])
                            .hypot(corner_pos[a][1] - corner_pos[b][1])
                            .hypot(corner_pos[a][2] - corner_pos[b][2]);
                        if d > diag {
                            diag = d;
                        }
                    }
                }
                let stratum_of = |axis: usize, positive: bool| first_id + axis * 2 + if positive { 0 } else { 1 };
                // 8 corners.
                let corner_ids: Vec<usize> = (0..8)
                    .map(|i| {
                        let id = corners.len();
                        corners.push(SfccCorner {
                            id,
                            x: corner_pos[i][0],
                            y: corner_pos[i][1],
                            z: corner_pos[i][2],
                            strata: vec![
                                stratum_of(0, i & 1 != 0),
                                stratum_of(1, i & 2 != 0),
                                stratum_of(2, i & 4 != 0),
                            ],
                            curve_ends: Vec::new(),
                        });
                        id
                    })
                    .collect();
                // 12 edges: corner pairs differing in one bit.
                for a in 0..8usize {
                    for &bit in &[1usize, 2, 4] {
                        if a & bit != 0 {
                            continue;
                        }
                        let b = a | bit;
                        let axis = if bit == 1 { 0 } else if bit == 2 { 1 } else { 2 };
                        let others: Vec<usize> = (0..3).filter(|&x| x != axis).collect();
                        let strata_pair = [
                            stratum_of(others[0], a & (1 << others[0]) != 0),
                            stratum_of(others[1], a & (1 << others[1]) != 0),
                        ];
                        let curve_id = curves.len();
                        let mut curve = make_segment_curve(
                            curve_id,
                            -1,
                            strata_pair,
                            corner_pos[a][0],
                            corner_pos[a][1],
                            corner_pos[a][2],
                            corner_pos[b][0],
                            corner_pos[b][1],
                            corner_pos[b][2],
                        );
                        curve.native = true;
                        curve.corner_start = corner_ids[a] as i64;
                        curve.corner_end = corner_ids[b] as i64;
                        corners[corner_ids[a]].curve_ends.push((curve_id, 0));
                        corners[corner_ids[b]].curve_ends.push((curve_id, 1));
                        curves.push(curve);
                    }
                }
                all_strata.extend(strata);
            }
            Shape::Sphere { r } => {
                // No native curves/corners; one sphere carrier for the stratum list.
                all_strata.extend(build_sphere_strata(leaf, leaf_index, first_id, r));
            }
            Shape::Cylinder { r, h } => {
                all_strata.extend(build_cylinder_strata(leaf, leaf_index, first_id, r, h));
                let rr = r * leaf.sim.s;
                let w = leaf.sim.rotate_vector(0.0, 1.0, 0.0);
                let [px, py, pz] = leaf.pos;
                // Two rim circles: top (cap +y) then bottom (cap −y), each adjacent
                // to [mantle, that cap]. Order matches the TS extraction.
                for (side, local_y) in [(1usize, py + h), (2usize, py - h)] {
                    let c = leaf.sim.apply_point(px, local_y, pz);
                    let cid = curves.len();
                    let mut curve =
                        make_circle_curve(cid, -1, [first_id, first_id + side], c[0], c[1], c[2], w[0], w[1], w[2], rr, None);
                    curve.native = true;
                    curves.push(curve);
                }
            }
            Shape::Cone { r, h } => {
                all_strata.extend(build_cone_strata(leaf, leaf_index, first_id, r, h));
                let rr = r * leaf.sim.s;
                let w = leaf.sim.rotate_vector(0.0, 1.0, 0.0);
                let [px, py, pz] = leaf.pos;
                // Base rim circle adjacent to [mantle, base].
                let base = leaf.sim.apply_point(px, py, pz);
                let cid = curves.len();
                let mut curve =
                    make_circle_curve(cid, -1, [first_id, first_id + 1], base[0], base[1], base[2], w[0], w[1], w[2], rr, None);
                curve.native = true;
                curves.push(curve);
                // Apex: a 0D corner with only the mantle stratum incident.
                let apex = leaf.sim.apply_point(px, py + h, pz);
                let kid = corners.len();
                corners.push(SfccCorner { id: kid, x: apex[0], y: apex[1], z: apex[2], strata: vec![first_id], curve_ends: Vec::new() });
            }
            // Lathe / Extrude / Loft: M4-remaining (traced curves / ruled carriers /
            // newton). No strata built here yet — scenes with them are not handled.
            _ => {}
        }
    }

    let mut index = SfccSpatialIndex::new(diag / 32.0);
    for c in &curves {
        index.insert_curve_polyline(c.id, &c.index_polyline);
    }
    for c in &corners {
        index.insert_corner(c.id, c.x, c.y, c.z);
    }
    SfccFeatureSet { curves, corners, index, strata: all_strata }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sdf::leaf_at;

    #[test]
    fn unit_box_has_12_segments_8_corners() {
        let tree = leaf_at(Shape::Cuboid { half: [1.0, 1.0, 1.0] }, [0.0, 0.0, 0.0]);
        let fs = compile_native_features(&tree);
        assert_eq!(fs.curves.len(), 12);
        assert_eq!(fs.corners.len(), 8);
        assert_eq!(fs.strata.len(), 6);
        // Every edge is a unit-length segment between two ±1 corners.
        for c in &fs.curves {
            assert_eq!(c.kind(), crate::sfcc::feature_curves::CurveKind::Segment);
            assert!((c.param_distance(0.0, 1.0) - 2.0).abs() < 1e-12); // edge length 2 (half=1)
            assert!(c.adjacent_strata.iter().all(|&s| s < 6));
        }
        // Each corner has 3 incident strata and (valence-3) 3 curve ends.
        for k in &fs.corners {
            assert_eq!(k.strata.len(), 3);
            assert_eq!(k.curve_ends.len(), 3);
            assert!((k.x.abs() - 1.0).abs() < 1e-12);
        }
    }

    #[test]
    fn cylinder_has_2_rim_circles_3_strata() {
        let tree = leaf_at(Shape::Cylinder { r: 4.0, h: 7.0 }, [0.0, 0.0, 0.0]);
        let fs = compile_native_features(&tree);
        assert_eq!(fs.curves.len(), 2);
        assert_eq!(fs.corners.len(), 0);
        assert_eq!(fs.strata.len(), 3);
        for c in &fs.curves {
            assert_eq!(c.kind(), crate::sfcc::feature_curves::CurveKind::Circle);
            // Adjacent to the mantle (0) and one cap (1 or 2).
            assert_eq!(c.adjacent_strata[0], 0);
            assert!(c.adjacent_strata[1] == 1 || c.adjacent_strata[1] == 2);
            // Closed circle of radius 4: a quarter turn moves √2·r.
            let p0 = c.point_at(0.0);
            assert!((p0[0].hypot(p0[2]) - 4.0).abs() < 1e-9);
        }
    }

    #[test]
    fn cone_has_base_circle_and_apex_corner() {
        let tree = leaf_at(Shape::Cone { r: 3.0, h: 5.0 }, [0.0, 0.0, 0.0]);
        let fs = compile_native_features(&tree);
        assert_eq!(fs.curves.len(), 1);
        assert_eq!(fs.corners.len(), 1);
        assert_eq!(fs.strata.len(), 2);
        assert_eq!(fs.curves[0].kind(), crate::sfcc::feature_curves::CurveKind::Circle);
        assert_eq!(fs.curves[0].adjacent_strata, [0, 1]);
        // Apex sits at +h, incident to the mantle only.
        let apex = &fs.corners[0];
        assert!((apex.y - 5.0).abs() < 1e-9);
        assert_eq!(apex.strata, vec![0]);
    }

    #[test]
    fn sphere_has_no_features_one_stratum() {
        let tree = leaf_at(Shape::Sphere { r: 2.0 }, [0.0, 0.0, 0.0]);
        let fs = compile_native_features(&tree);
        assert_eq!(fs.curves.len(), 0);
        assert_eq!(fs.corners.len(), 0);
        assert_eq!(fs.strata.len(), 1);
    }
}
