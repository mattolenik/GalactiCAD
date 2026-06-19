//! Uniform hash-grid spatial index over feature-curve polyline segments and
//! corner points. Port of `src/export/sfcc/spatial-index.mts`. Conservative:
//! queries return candidate ids whose indexed geometry touches the inflated
//! query box — callers do exact filtering.

use std::collections::{HashMap, HashSet};

pub struct SfccSpatialIndex {
    cell_size: f64,
    curve_cells: HashMap<i64, HashSet<usize>>,
    corner_cells: HashMap<i64, Vec<usize>>,
}

impl SfccSpatialIndex {
    pub fn new(cell_size: f64) -> Self {
        SfccSpatialIndex {
            cell_size: cell_size.max(1e-9),
            curve_cells: HashMap::new(),
            corner_cells: HashMap::new(),
        }
    }

    fn key(ix: i64, iy: i64, iz: i64) -> i64 {
        // B = 2^17 keeps the packed key below 2^51 — exact in f64/i64.
        const B: i64 = 1 << 17;
        const HB: i64 = 1 << 16;
        ((ix + HB) * B + (iy + HB)) * B + (iz + HB)
    }

    fn cells_of_box(&self, min: [f64; 3], max: [f64; 3]) -> Vec<i64> {
        let s = self.cell_size;
        let lo = [(min[0] / s).floor() as i64, (min[1] / s).floor() as i64, (min[2] / s).floor() as i64];
        let hi = [(max[0] / s).floor() as i64, (max[1] / s).floor() as i64, (max[2] / s).floor() as i64];
        let mut keys = Vec::new();
        for x in lo[0]..=hi[0] {
            for y in lo[1]..=hi[1] {
                for z in lo[2]..=hi[2] {
                    keys.push(Self::key(x, y, z));
                }
            }
        }
        keys
    }

    pub fn insert_curve_polyline(&mut self, curve_id: usize, polyline: &[f64]) {
        let n = polyline.len() / 3 - 1;
        for i in 0..n {
            let a = [polyline[i * 3], polyline[i * 3 + 1], polyline[i * 3 + 2]];
            let b = [polyline[i * 3 + 3], polyline[i * 3 + 4], polyline[i * 3 + 5]];
            let min = [a[0].min(b[0]), a[1].min(b[1]), a[2].min(b[2])];
            let max = [a[0].max(b[0]), a[1].max(b[1]), a[2].max(b[2])];
            for key in self.cells_of_box(min, max) {
                self.curve_cells.entry(key).or_default().insert(curve_id);
            }
        }
    }

    pub fn insert_corner(&mut self, corner_id: usize, x: f64, y: f64, z: f64) {
        let s = self.cell_size;
        let key = Self::key((x / s).floor() as i64, (y / s).floor() as i64, (z / s).floor() as i64);
        self.corner_cells.entry(key).or_default().push(corner_id);
    }

    pub fn curves_in_box(&self, min: [f64; 3], max: [f64; 3]) -> Vec<usize> {
        let mut out = HashSet::new();
        for key in self.cells_of_box(min, max) {
            if let Some(set) = self.curve_cells.get(&key) {
                out.extend(set.iter().copied());
            }
        }
        out.into_iter().collect()
    }

    pub fn corners_in_box(&self, min: [f64; 3], max: [f64; 3]) -> Vec<usize> {
        let mut out = Vec::new();
        for key in self.cells_of_box(min, max) {
            if let Some(list) = self.corner_cells.get(&key) {
                out.extend(list.iter().copied());
            }
        }
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
}
