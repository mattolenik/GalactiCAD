//! Uniform hash-grid over curve enclosures and corners. Queries return candidate
//! supersets; callers still check the curve geometry and its exposed domains.

use super::feature_curves::FeatureCurve;
use std::collections::{HashMap, HashSet};

pub struct SfccSpatialIndex {
    cell_size: f64,
    curve_cells: HashMap<[i64; 3], HashSet<usize>>,
    corner_cells: HashMap<[i64; 3], Vec<usize>>,
    broad_curves: HashSet<usize>,
}

impl SfccSpatialIndex {
    pub fn new(cell_size: f64) -> Self {
        SfccSpatialIndex {
            cell_size: cell_size.max(1e-9),
            curve_cells: HashMap::new(),
            corner_cells: HashMap::new(),
            broad_curves: HashSet::new(),
        }
    }

    fn cells_of_box(&self, min: [f64; 3], max: [f64; 3]) -> Option<Vec<[i64; 3]>> {
        if !(0..3).all(|k| min[k].is_finite() && max[k].is_finite() && min[k] <= max[k]) {
            return None;
        }
        let s = self.cell_size;
        let lo = [(min[0] / s).floor() as i64, (min[1] / s).floor() as i64, (min[2] / s).floor() as i64];
        let hi = [(max[0] / s).floor() as i64, (max[1] / s).floor() as i64, (max[2] / s).floor() as i64];
        let mut count = 1_u128;
        for k in 0..3 {
            count = count.saturating_mul((hi[k] as i128 - lo[k] as i128 + 1) as u128);
        }
        // ponytail: scan candidates for large uncertainty boxes; use a hierarchy
        // if these become common. Never omit a curve to cap index memory.
        if count > 4096 {
            return None;
        }
        let mut keys = Vec::new();
        for x in lo[0]..=hi[0] {
            for y in lo[1]..=hi[1] {
                for z in lo[2]..=hi[2] {
                    keys.push([x, y, z]);
                }
            }
        }
        Some(keys)
    }

    fn insert_curve_box(&mut self, curve_id: usize, min: [f64; 3], max: [f64; 3]) {
        if let Some(cells) = self.cells_of_box(min, max) {
            for key in cells {
                self.curve_cells.entry(key).or_default().insert(curve_id);
            }
        } else {
            self.broad_curves.insert(curve_id);
        }
    }

    pub fn insert_curve(&mut self, curve: &FeatureCurve) {
        for (min, max) in curve.index_bounds() {
            self.insert_curve_box(curve.id, min, max);
        }
    }

    /// Only for actual polylines. Analytic/reprojected curves use insert_curve.
    pub fn insert_curve_polyline(&mut self, curve_id: usize, polyline: &[f64]) {
        let n = (polyline.len() / 3).saturating_sub(1);
        for i in 0..n {
            let a = [polyline[i * 3], polyline[i * 3 + 1], polyline[i * 3 + 2]];
            let b = [polyline[i * 3 + 3], polyline[i * 3 + 4], polyline[i * 3 + 5]];
            let min = [a[0].min(b[0]), a[1].min(b[1]), a[2].min(b[2])];
            let max = [a[0].max(b[0]), a[1].max(b[1]), a[2].max(b[2])];
            self.insert_curve_box(curve_id, min, max);
        }
    }

    pub fn insert_corner(&mut self, corner_id: usize, x: f64, y: f64, z: f64) {
        let s = self.cell_size;
        let key = [(x / s).floor() as i64, (y / s).floor() as i64, (z / s).floor() as i64];
        self.corner_cells.entry(key).or_default().push(corner_id);
    }

    pub fn curves_in_box(&self, min: [f64; 3], max: [f64; 3]) -> Vec<usize> {
        let mut out = self.broad_curves.clone();
        if let Some(cells) = self.cells_of_box(min, max) {
            for key in cells {
                if let Some(set) = self.curve_cells.get(&key) {
                    out.extend(set.iter().copied());
                }
            }
        } else {
            out.extend(self.curve_cells.values().flat_map(|ids| ids.iter().copied()));
        }
        // Candidate order breaks ties in carrier recovery and face tagging.
        // Never let the hash seed choose which coincident branch owns a point.
        let mut ids: Vec<_> = out.into_iter().collect();
        ids.sort_unstable();
        ids
    }

    pub fn corners_in_box(&self, min: [f64; 3], max: [f64; 3]) -> Vec<usize> {
        let mut out = Vec::new();
        if let Some(cells) = self.cells_of_box(min, max) {
            for key in cells {
                if let Some(list) = self.corner_cells.get(&key) {
                    out.extend(list.iter().copied());
                }
            }
        } else {
            out.extend(self.corner_cells.values().flatten().copied());
        }
        out.sort_unstable();
        out.dedup();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_inserted_geometry_and_rejects_far_queries() {
        let mut idx = SfccSpatialIndex::new(1.0);
        idx.insert_curve_polyline(7, &[0., 0., 0., 5., 0., 0.]); // along x
        idx.insert_corner(3, 0.0, 0.0, 0.0);
        // A box hugging the segment finds it.
        let cs = idx.curves_in_box([1.0, -0.5, -0.5], [2.0, 0.5, 0.5]);
        assert!(cs.contains(&7));
        // A far box does not.
        assert!(idx.curves_in_box([100.0, 100.0, 100.0], [101.0, 101.0, 101.0]).is_empty());
        // Corner query.
        assert_eq!(idx.corners_in_box([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]), vec![3]);
        assert!(idx.corners_in_box([10.0, 10.0, 10.0], [11.0, 11.0, 11.0]).is_empty());
    }

    #[test]
    fn coincident_curve_candidates_have_stable_order() {
        for reverse in [false, true] {
            let mut idx = SfccSpatialIndex::new(1.0);
            for i in 0..16 {
                let id = if reverse { 15 - i } else { i };
                idx.insert_curve_polyline(id, &[0., 0., 0., 5., 0., 0.]);
            }
            assert_eq!(idx.curves_in_box([0.; 3], [5., 0., 0.]), (0..16).collect::<Vec<_>>());
        }
    }
}
