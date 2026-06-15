//! Global point table for SFCC meshing. Port of `src/export/sfcc/point-table.mts`.
//!
//! Every mesh vertex (edge iso-crossing, cell interior vertex, and later feature
//! face-pins / corners / polyline points) is created exactly once, keyed by
//! integer provenance, and shared by id across all consuming faces and cells —
//! float positions are payload, never keys. This is what makes the CMS
//! face-sharing invariant and the S4 audits exact.
//!
//! Numeric provenance keys (exact integers):
//!   latticeKey·8 + axis(0|1|2)  — iso-crossing on the minimal edge whose min
//!                                  corner is `latticeKey`, running along `axis`
//!   latticeKey·8 + 3            — interior vertex of the leaf cell whose min
//!                                  corner is `latticeKey` (unique among leaves)
//! Rare composite provenances (feature points) use the string map.

use std::collections::HashMap;

pub const POINT_KEY_INTERIOR: i64 = 3;

/// Iso-crossing key on the minimal edge with min-corner `lattice_key` along `axis` (0|1|2).
pub fn crossing_key(lattice_key: i64, axis: usize) -> i64 {
    lattice_key * 8 + axis as i64
}

/// Interior-vertex key of the leaf cell whose min corner is `lattice_key`.
pub fn interior_key(lattice_key: i64) -> i64 {
    lattice_key * 8 + POINT_KEY_INTERIOR
}

/// Position + normal payload, keyed by integer (or rarely string) provenance.
/// Positions and normals are stored flat (xyz triples), indexed by point id.
#[derive(Default)]
pub struct PointTable {
    pos: Vec<f64>,
    normal: Vec<f64>,
    by_num_key: HashMap<i64, usize>,
    by_str_key: HashMap<String, usize>,
}

impl PointTable {
    pub fn new() -> Self {
        PointTable::default()
    }

    /// Number of points in the pool.
    pub fn count(&self) -> usize {
        self.pos.len() / 3
    }

    /// Create an unkeyed point (cell-owned, e.g. feature polyline samples).
    pub fn add(&mut self, x: f64, y: f64, z: f64, nx: f64, ny: f64, nz: f64) -> usize {
        let id = self.pos.len() / 3;
        self.pos.push(x);
        self.pos.push(y);
        self.pos.push(z);
        self.normal.push(nx);
        self.normal.push(ny);
        self.normal.push(nz);
        id
    }

    /// Get the id for a numeric provenance key, creating the point on first use.
    /// `create` fills `[x, y, z, nx, ny, nz]`.
    pub fn get_or_create<F: FnOnce() -> [f64; 6]>(&mut self, key: i64, create: F) -> usize {
        if let Some(&hit) = self.by_num_key.get(&key) {
            return hit;
        }
        let b = create();
        let id = self.add(b[0], b[1], b[2], b[3], b[4], b[5]);
        self.by_num_key.insert(key, id);
        id
    }

    /// Lookup a numeric key without creating.
    pub fn lookup(&self, key: i64) -> Option<usize> {
        self.by_num_key.get(&key).copied()
    }

    /// Get the id for a string provenance key, creating the point on first use.
    pub fn get_or_create_str<F: FnOnce() -> [f64; 6]>(&mut self, key: &str, create: F) -> usize {
        if let Some(&hit) = self.by_str_key.get(key) {
            return hit;
        }
        let b = create();
        let id = self.add(b[0], b[1], b[2], b[3], b[4], b[5]);
        self.by_str_key.insert(key.to_string(), id);
        id
    }

    /// Lookup a string key without creating.
    pub fn lookup_str(&self, key: &str) -> Option<usize> {
        self.by_str_key.get(key).copied()
    }

    pub fn x(&self, id: usize) -> f64 {
        self.pos[id * 3]
    }
    pub fn y(&self, id: usize) -> f64 {
        self.pos[id * 3 + 1]
    }
    pub fn z(&self, id: usize) -> f64 {
        self.pos[id * 3 + 2]
    }
    pub fn nx(&self, id: usize) -> f64 {
        self.normal[id * 3]
    }
    pub fn ny(&self, id: usize) -> f64 {
        self.normal[id * 3 + 1]
    }
    pub fn nz(&self, id: usize) -> f64 {
        self.normal[id * 3 + 2]
    }

    /// Overwrite a point's normal (when a better analytic normal becomes known).
    pub fn set_normal(&mut self, id: usize, nx: f64, ny: f64, nz: f64) {
        self.normal[id * 3] = nx;
        self.normal[id * 3 + 1] = ny;
        self.normal[id * 3 + 2] = nz;
    }

    /// Compact to the points referenced by `tris` and emit the MeshData vertex
    /// layout (8 floats: pos + pad + normal + pad). Returns `(verts, tris)` with
    /// the triangle index buffer remapped onto the compacted vertex order, in
    /// first-reference order (deterministic — matches the TS `Map` insertion order).
    pub fn build_mesh(&self, tris: &[usize]) -> (Vec<f32>, Vec<u32>) {
        let mut remap: HashMap<usize, usize> = HashMap::new();
        let mut order: Vec<usize> = Vec::new();
        for &id in tris {
            remap.entry(id).or_insert_with(|| {
                let slot = order.len();
                order.push(id);
                slot
            });
        }
        let mut verts = vec![0f32; order.len() * 8];
        for (slot, &id) in order.iter().enumerate() {
            let o = slot * 8;
            verts[o] = self.pos[id * 3] as f32;
            verts[o + 1] = self.pos[id * 3 + 1] as f32;
            verts[o + 2] = self.pos[id * 3 + 2] as f32;
            verts[o + 4] = self.normal[id * 3] as f32;
            verts[o + 5] = self.normal[id * 3 + 1] as f32;
            verts[o + 6] = self.normal[id * 3 + 2] as f32;
        }
        let out_tris: Vec<u32> = tris.iter().map(|&id| remap[&id] as u32).collect();
        (verts, out_tris)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provenance_keys_are_distinct() {
        // axis crossings and the interior tag never collide for one lattice key.
        let k = 12345i64;
        assert_eq!(crossing_key(k, 0), k * 8);
        assert_eq!(crossing_key(k, 1), k * 8 + 1);
        assert_eq!(crossing_key(k, 2), k * 8 + 2);
        assert_eq!(interior_key(k), k * 8 + 3);
        // Neighboring lattice keys stay in their own ×8 band.
        assert_ne!(crossing_key(k, 2), crossing_key(k + 1, 0));
    }

    #[test]
    fn get_or_create_is_keyed_and_idempotent() {
        let mut pt = PointTable::new();
        let id1 = pt.get_or_create(7, || [1.0, 2.0, 3.0, 0.0, 1.0, 0.0]);
        // The second create closure must never run for an existing key.
        let id2 = pt.get_or_create(7, || panic!("must not recreate an existing key"));
        assert_eq!(id1, id2);
        assert_eq!(pt.count(), 1);
        assert_eq!(pt.x(id1), 1.0);
        assert_eq!(pt.ny(id1), 1.0);
        assert_eq!(pt.lookup(7), Some(id1));
        assert_eq!(pt.lookup(8), None);
    }

    #[test]
    fn str_keys_are_independent_of_num_keys() {
        let mut pt = PointTable::new();
        let a = pt.get_or_create(0, || [0.0; 6]);
        let b = pt.get_or_create_str("corner-3-4", || [5.0, 6.0, 7.0, 0.0, 0.0, 1.0]);
        assert_ne!(a, b);
        assert_eq!(pt.lookup_str("corner-3-4"), Some(b));
        assert_eq!(pt.z(b), 7.0);
    }

    #[test]
    fn build_mesh_compacts_and_remaps() {
        let mut pt = PointTable::new();
        let v0 = pt.add(0.0, 0.0, 0.0, 0.0, 0.0, 1.0);
        let v1 = pt.add(1.0, 0.0, 0.0, 0.0, 0.0, 1.0);
        let v2 = pt.add(0.0, 1.0, 0.0, 0.0, 0.0, 1.0);
        let _unused = pt.add(9.0, 9.0, 9.0, 1.0, 0.0, 0.0);
        let tris = vec![v0, v1, v2];
        let (verts, out) = pt.build_mesh(&tris);
        // 3 referenced verts × 8 floats; the unused vert is dropped.
        assert_eq!(verts.len(), 3 * 8);
        assert_eq!(out, vec![0, 1, 2]);
        assert_eq!(verts[0], 0.0);
        assert_eq!(verts[8], 1.0); // second vert's x
        assert_eq!(verts[6], 1.0); // first vert's nz
    }
}
