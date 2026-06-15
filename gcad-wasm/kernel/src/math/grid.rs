//! Integer-lattice addressing for the SFCC octree.
//! Port of `src/export/sfcc/lattice.mts`.
//!
//! All topological identity in SFCC is integer: octree corners, cells, faces and
//! edges are keyed by lattice coordinates at the finest level (`max_depth`).
//! Float positions are payload, never keys — this is what makes shared face data,
//! hanging-node handling, and the S4 closedness audit exact.
//!
//! A lattice point (gx, gy, gz) ∈ [0, res]³ packs into a single integer key;
//! with `SFCC_MAX_DEPTH = 14`, span = 16385 and span³ ≈ 4.4e12, well inside i64.

use crate::tuning::SFCC_MAX_DEPTH;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SfccLattice {
    /// Finest octree level; lattice resolution is 2^max_depth cells per axis.
    pub max_depth: u32,
    /// Cells per axis at max_depth: 1 << max_depth.
    pub res: i64,
    /// Lattice points per axis: res + 1.
    pub span: i64,
    /// World position (mm) of lattice point (0,0,0) — root cube min corner.
    pub origin_x: f64,
    pub origin_y: f64,
    pub origin_z: f64,
    /// Root cube edge length (mm).
    pub world_size: f64,
    /// World size (mm) of one lattice step (= max-depth cell edge).
    pub step: f64,
}

pub fn make_lattice(max_depth: u32, origin_x: f64, origin_y: f64, origin_z: f64, world_size: f64) -> SfccLattice {
    assert!(
        max_depth >= 1 && max_depth <= SFCC_MAX_DEPTH,
        "sfcc lattice: max_depth {max_depth} outside [1, {SFCC_MAX_DEPTH}]"
    );
    assert!(world_size > 0.0 && world_size.is_finite(), "sfcc lattice: invalid world_size {world_size}");
    let res: i64 = 1 << max_depth;
    SfccLattice {
        max_depth,
        res,
        span: res + 1,
        origin_x,
        origin_y,
        origin_z,
        world_size,
        step: world_size / res as f64,
    }
}

/// Pack a lattice point into its unique integer key.
pub fn pack_point(lat: &SfccLattice, gx: i64, gy: i64, gz: i64) -> i64 {
    (gx * lat.span + gy) * lat.span + gz
}

/// Inverse of [`pack_point`].
pub fn unpack_point(lat: &SfccLattice, key: i64) -> [i64; 3] {
    let s = lat.span;
    let gz = key % s;
    let rest = key / s;
    let gy = rest % s;
    let gx = rest / s;
    [gx, gy, gz]
}

/// World position (mm) of a lattice point.
pub fn point_to_world(lat: &SfccLattice, gx: i64, gy: i64, gz: i64) -> [f64; 3] {
    [
        lat.origin_x + gx as f64 * lat.step,
        lat.origin_y + gy as f64 * lat.step,
        lat.origin_z + gz as f64 * lat.step,
    ]
}

/// Lattice units spanned by one cell edge at `level`: 1 << (max_depth − level).
pub fn stride_at_level(lat: &SfccLattice, level: u32) -> i64 {
    1 << (lat.max_depth - level)
}

/// World edge length (mm) of a cell at `level`.
pub fn cell_size_at_level(lat: &SfccLattice, level: u32) -> f64 {
    lat.world_size / (1i64 << level) as f64
}

/// Key of a cell at (level, ix, iy, iz) — the packed lattice point of its min
/// corner. Unique per level.
pub fn cell_key(lat: &SfccLattice, level: u32, ix: i64, iy: i64, iz: i64) -> i64 {
    let s = stride_at_level(lat, level);
    pack_point(lat, ix * s, iy * s, iz * s)
}

/// Corner-order convention: corner index c has lattice offset
/// ((c>>0)&1, (c>>1)&1, (c>>2)&1) — bit 0 = x, bit 1 = y, bit 2 = z.
pub fn corner_offset(c: usize, axis: usize) -> i64 {
    ((c >> axis) & 1) as i64
}

/// The 12 cell edges as [cornerA, cornerB] pairs (A < B, one differing bit).
/// Grouped by axis: edges 0–3 along x, 4–7 along y, 8–11 along z.
pub const CELL_EDGES: [[usize; 2]; 12] = [
    [0, 1],
    [2, 3],
    [4, 5],
    [6, 7],
    [0, 2],
    [1, 3],
    [4, 6],
    [5, 7],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
];

/// Axis (0|1|2) of `CELL_EDGES[e]`.
pub fn cell_edge_axis(e: usize) -> usize {
    e >> 2
}

/// In-face axes (u, v) for a face with normal `axis`, in the cyclic order that
/// makes u × v = +axis (so a (u, v) boundary walk is CCW from the +axis side).
pub fn face_axes(axis: usize) -> [usize; 2] {
    match axis {
        0 => [1, 2],
        1 => [2, 0],
        _ => [0, 1],
    }
}

/// Collect existing interior lattice points on an axis-aligned edge, in order.
/// The edge runs from (gx,gy,gz) for `len` lattice units along `axis`;
/// `has_point` answers whether a corner sample exists at a lattice key.
/// Returns interior offsets (exclusive of 0 and `len`), sorted ascending.
pub fn collect_edge_interior_offsets<F: Fn(i64) -> bool>(
    has_point: F,
    lat: &SfccLattice,
    axis: usize,
    gx: i64,
    gy: i64,
    gz: i64,
    len: i64,
) -> Vec<i64> {
    let mut out = Vec::new();
    collect_interior(&has_point, lat, axis, gx, gy, gz, 0, len, &mut out);
    out
}

fn collect_interior<F: Fn(i64) -> bool>(
    has_point: &F,
    lat: &SfccLattice,
    axis: usize,
    gx: i64,
    gy: i64,
    gz: i64,
    lo: i64,
    hi: i64,
    out: &mut Vec<i64>,
) {
    let span = hi - lo;
    if span < 2 || span % 2 != 0 {
        return;
    }
    let mid = lo + span / 2;
    let (mx, my, mz) = match axis {
        0 => (gx + mid, gy, gz),
        1 => (gx, gy + mid, gz),
        _ => (gx, gy, gz + mid),
    };
    if !has_point(pack_point(lat, mx, my, mz)) {
        return;
    }
    collect_interior(has_point, lat, axis, gx, gy, gz, lo, mid, out);
    out.push(mid);
    collect_interior(has_point, lat, axis, gx, gy, gz, mid, hi, out);
}

/// World position of a cell's center, matching the TS `pointToWorld(lat,
/// (ix+0.5)*stride, …)` float order exactly (the dyadic products are exact in
/// f64 so this is bit-identical to the oracle). Shared by the octree's
/// certified-empty cull and the refine probe.
pub fn cell_center_world(lat: &SfccLattice, level: u32, ix: i64, iy: i64, iz: i64) -> [f64; 3] {
    let s = stride_at_level(lat, level) as f64;
    [
        lat.origin_x + (ix as f64 + 0.5) * s * lat.step,
        lat.origin_y + (iy as f64 + 0.5) * s * lat.step,
        lat.origin_z + (iz as f64 + 0.5) * s * lat.step,
    ]
}

/// World-space AABB of a cell: [minX, minY, minZ, maxX, maxY, maxZ].
pub fn cell_aabb(lat: &SfccLattice, level: u32, ix: i64, iy: i64, iz: i64) -> [f64; 6] {
    let size = cell_size_at_level(lat, level);
    let x = lat.origin_x + ix as f64 * size;
    let y = lat.origin_y + iy as f64 * size;
    let z = lat.origin_z + iz as f64 * size;
    [x, y, z, x + size, y + size, z + size]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn pack_unpack_roundtrip_at_max_depth() {
        let lat = make_lattice(14, -10., -20., -30., 100.);
        let probes: [[i64; 3]; 5] = [
            [0, 0, 0],
            [lat.res, lat.res, lat.res],
            [1, 0, lat.res],
            [16384, 1, 16383],
            [12345, 6789, 101],
        ];
        for p in probes {
            let key = pack_point(&lat, p[0], p[1], p[2]);
            assert!(key <= (1i64 << 53));
            assert_eq!(unpack_point(&lat, key), p);
        }
    }

    #[test]
    fn pack_is_injective_across_neighbors() {
        let lat = make_lattice(10, 0., 0., 0., 1.);
        let mut seen = HashSet::new();
        for dx in 0..=2 {
            for dy in 0..=2 {
                for dz in 0..=2 {
                    let key = pack_point(&lat, 511 + dx, 511 + dy, 511 + dz);
                    assert!(seen.insert(key));
                }
            }
        }
    }

    #[test]
    fn point_to_world_maps_extremes() {
        let lat = make_lattice(6, -5., 2., 7., 64.);
        assert_eq!(point_to_world(&lat, 0, 0, 0), [-5., 2., 7.]);
        assert_eq!(point_to_world(&lat, lat.res, lat.res, lat.res), [59., 66., 71.]);
        assert_eq!(lat.step, 1.);
        assert_eq!(cell_size_at_level(&lat, lat.max_depth), lat.step);
        assert_eq!(cell_size_at_level(&lat, 0), 64.);
    }

    #[test]
    fn cell_stride_and_key() {
        let lat = make_lattice(8, 0., 0., 0., 256.);
        assert_eq!(stride_at_level(&lat, 8), 1);
        assert_eq!(stride_at_level(&lat, 0), 256);
        let parent = cell_key(&lat, 4, 3, 0, 0);
        let child = cell_key(&lat, 5, 6, 0, 0);
        assert_eq!(parent, child);
        assert_ne!(parent, cell_key(&lat, 5, 7, 0, 0));
    }

    #[test]
    fn corner_order_convention() {
        assert_eq!(corner_offset(0, 0) + corner_offset(0, 1) + corner_offset(0, 2), 0);
        assert_eq!(corner_offset(1, 0), 1);
        assert_eq!(corner_offset(2, 1), 1);
        assert_eq!(corner_offset(4, 2), 1);
        assert_eq!(corner_offset(7, 0) + corner_offset(7, 1) + corner_offset(7, 2), 3);
    }

    #[test]
    fn cell_edges_one_differing_bit() {
        assert_eq!(CELL_EDGES.len(), 12);
        for (e, [a, b]) in CELL_EDGES.iter().enumerate() {
            let diff = a ^ b;
            assert!(diff == 1 || diff == 2 || diff == 4, "edge {e} differs in more than one bit");
            assert_eq!(1usize << cell_edge_axis(e), diff, "edge {e} axis grouping");
            assert!(a < b);
        }
    }

    #[test]
    fn face_axes_cross_product() {
        assert_eq!(face_axes(0), [1, 2]);
        assert_eq!(face_axes(1), [2, 0]);
        assert_eq!(face_axes(2), [0, 1]);
        for axis in 0..3 {
            let [u, v] = face_axes(axis);
            let mut uv = [0.0; 3];
            let mut vv = [0.0; 3];
            uv[u] = 1.0;
            vv[v] = 1.0;
            let cross = [
                uv[1] * vv[2] - uv[2] * vv[1],
                uv[2] * vv[0] - uv[0] * vv[2],
                uv[0] * vv[1] - uv[1] * vv[0],
            ];
            assert_eq!(cross[axis], 1.0, "axis {axis}");
        }
    }

    #[test]
    fn collect_interior_finds_hanging_midpoints() {
        let lat = make_lattice(4, 0., 0., 0., 16.);
        let present: HashSet<i64> = [
            pack_point(&lat, 8, 8, 0),
            pack_point(&lat, 6, 8, 0),
            pack_point(&lat, 9, 9, 0), // off-edge noise
        ]
        .into_iter()
        .collect();
        let got = collect_edge_interior_offsets(|k| present.contains(&k), &lat, 0, 4, 8, 0, 8);
        assert_eq!(got, vec![2, 4]);
    }

    #[test]
    fn collect_interior_empty_cases() {
        let lat = make_lattice(4, 0., 0., 0., 16.);
        assert_eq!(collect_edge_interior_offsets(|_| false, &lat, 1, 0, 0, 0, 8), Vec::<i64>::new());
        assert_eq!(collect_edge_interior_offsets(|_| true, &lat, 2, 0, 0, 3, 1), Vec::<i64>::new());
    }

    #[test]
    fn collect_interior_skips_quarter_without_midpoint() {
        let lat = make_lattice(4, 0., 0., 0., 16.);
        let present: HashSet<i64> = [pack_point(&lat, 2, 0, 0)].into_iter().collect();
        let got = collect_edge_interior_offsets(|k| present.contains(&k), &lat, 0, 0, 0, 0, 8);
        assert_eq!(got, Vec::<i64>::new());
    }

    #[test]
    fn cell_aabb_matches_sizing() {
        let lat = make_lattice(5, -16., -16., -16., 32.);
        assert_eq!(cell_aabb(&lat, 5, 0, 0, 0), [-16., -16., -16., -15., -15., -15.]);
        assert_eq!(cell_aabb(&lat, 1, 1, 0, 1), [0., -16., 0., 16., 0., 16.]);
    }
}
