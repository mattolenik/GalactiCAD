//! Order-insensitive mesh comparison — the cross-language parity backbone.
//! Rust port of `src/export/sfcc/mesh-canonical.mts`.
//!
//! SFCC output is deterministic in geometry and topology but a parallel meshing
//! pass may emit verts/tris in any array order. Canonical form = sorted unique
//! vertex identity tuples + triangles remapped onto that order, each min-rotated
//! (winding preserved) then sorted. Two meshes are equivalent iff canonical forms
//! match.
//!
//!  - `pos_eps = 0` → exact (the same-impl determinism guard).
//!  - small `pos_eps` → cross-impl (Rust output vs the TS reference fixtures),
//!    absorbs ULP drift while catching topology/winding/>eps moves.

use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Clone, Copy, Debug)]
pub struct CanonicalizeOptions {
    /// Floats per vertex. SFCC/MeshData layout is 8 (pos, pad, normal, pad).
    pub stride: usize,
    pub pos_offset: usize,
    pub normal_offset: usize,
    /// Fold the normal into vertex identity (a normal flip becomes a difference).
    pub compare_normals: bool,
    /// Position quantization grid. 0 = exact bit-compare.
    pub pos_eps: f64,
    pub normal_eps: f64,
}

impl Default for CanonicalizeOptions {
    fn default() -> Self {
        CanonicalizeOptions {
            stride: 8,
            pos_offset: 0,
            normal_offset: 4,
            compare_normals: false,
            pos_eps: 0.0,
            normal_eps: 1e-4,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct CanonicalMesh {
    pub verts: Vec<String>,
    pub tris: Vec<[usize; 3]>,
}

fn quant(v: f64, eps: f64) -> String {
    let v = if v == 0.0 { 0.0 } else { v }; // collapse -0.0 like JS String(-0)
    if eps <= 0.0 {
        format!("{v}")
    } else {
        format!("{}", (v / eps).round() as i64)
    }
}

/// Rotate a triangle so its smallest index is first, preserving cyclic winding.
fn rotate_min(a: usize, b: usize, c: usize) -> [usize; 3] {
    if a <= b && a <= c {
        [a, b, c]
    } else if b <= a && b <= c {
        [b, c, a]
    } else {
        [c, a, b]
    }
}

pub fn canonicalize_mesh(verts: &[f64], tris: &[u32], opts: &CanonicalizeOptions) -> CanonicalMesh {
    let identity = |vi: usize| -> String {
        let o = vi * opts.stride;
        let mut s = format!(
            "{}|{}|{}",
            quant(verts[o + opts.pos_offset], opts.pos_eps),
            quant(verts[o + opts.pos_offset + 1], opts.pos_eps),
            quant(verts[o + opts.pos_offset + 2], opts.pos_eps),
        );
        if opts.compare_normals {
            s.push_str(&format!(
                "|n|{}|{}|{}",
                quant(verts[o + opts.normal_offset], opts.normal_eps),
                quant(verts[o + opts.normal_offset + 1], opts.normal_eps),
                quant(verts[o + opts.normal_offset + 2], opts.normal_eps),
            ));
        }
        s
    };

    // Identity of every triangle-referenced vertex (ignores unreferenced verts).
    let mut ref_identity: HashMap<u32, String> = HashMap::new();
    for &vi in tris {
        ref_identity.entry(vi).or_insert_with(|| identity(vi as usize));
    }

    let mut unique: Vec<String> = ref_identity.values().cloned().collect::<HashSet<_>>().into_iter().collect();
    unique.sort();
    let id_to_canon: HashMap<String, usize> = unique.iter().cloned().enumerate().map(|(i, s)| (s, i)).collect();

    let mut out_tris: Vec<[usize; 3]> = Vec::new();
    for t in tris.chunks_exact(3) {
        let a = id_to_canon[&ref_identity[&t[0]]];
        let b = id_to_canon[&ref_identity[&t[1]]];
        let c = id_to_canon[&ref_identity[&t[2]]];
        out_tris.push(rotate_min(a, b, c));
    }
    out_tris.sort();

    CanonicalMesh { verts: unique, tris: out_tris }
}

/// Compare two meshes for order-insensitive geometric + topological equivalence.
/// `Ok(())` = equivalent; `Err(reason)` = not.
pub fn meshes_equivalent(
    a_verts: &[f64],
    a_tris: &[u32],
    b_verts: &[f64],
    b_tris: &[u32],
    opts: &CanonicalizeOptions,
) -> Result<(), String> {
    let ca = canonicalize_mesh(a_verts, a_tris, opts);
    let cb = canonicalize_mesh(b_verts, b_tris, opts);
    if ca.verts.len() != cb.verts.len() {
        return Err(format!("vertex count: {} vs {}", ca.verts.len(), cb.verts.len()));
    }
    if ca.tris.len() != cb.tris.len() {
        return Err(format!("triangle count: {} vs {}", ca.tris.len(), cb.tris.len()));
    }
    for i in 0..ca.verts.len() {
        if ca.verts[i] != cb.verts[i] {
            return Err(format!("vertex[{i}] differs: {} vs {}", ca.verts[i], cb.verts[i]));
        }
    }
    for i in 0..ca.tris.len() {
        if ca.tris[i] != cb.tris[i] {
            return Err(format!("triangle[{i}] differs: {:?} vs {:?}", ca.tris[i], cb.tris[i]));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Geometric (grid-straddle-robust) cross-impl comparison.
// ---------------------------------------------------------------------------

/// Referenced unique vertex positions (stride-8, pos at offset 0), keyed by buffer index.
fn referenced_positions(verts: &[f64], tris: &[u32]) -> BTreeMap<u32, [f64; 3]> {
    let mut m = BTreeMap::new();
    for &vi in tris {
        m.entry(vi).or_insert_with(|| {
            let o = vi as usize * 8;
            [verts[o], verts[o + 1], verts[o + 2]]
        });
    }
    m
}

/// Bijective vertex correspondence a→b by CLOSEST-FIRST assignment within `eps`: collect
/// every within-eps candidate pair, then greedily claim the globally-nearest unclaimed
/// pair. With sub-eps drift ≪ the vertex separation, each vertex's true counterpart IS
/// its nearest, so this recovers the bijection even where `eps` spans more than one
/// neighbor (a plain per-vertex nearest would mis-collide there). Robust to grid-boundary
/// drift the quantize-and-sort identity discretizes wrongly. `Err` if some `a` vertex has
/// no counterpart within `eps`.
fn nearest_bijection(
    a: &BTreeMap<u32, [f64; 3]>,
    b: &BTreeMap<u32, [f64; 3]>,
    eps: f64,
) -> Result<HashMap<u32, u32>, String> {
    let e2 = eps * eps;
    let mut pairs: Vec<(f64, u32, u32)> = Vec::new();
    for (&ai, ap) in a {
        for (&bi, bp) in b {
            let d2 = (ap[0] - bp[0]).powi(2) + (ap[1] - bp[1]).powi(2) + (ap[2] - bp[2]).powi(2);
            if d2 <= e2 {
                pairs.push((d2, ai, bi));
            }
        }
    }
    pairs.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap());
    let mut map: HashMap<u32, u32> = HashMap::new();
    let mut used: HashSet<u32> = HashSet::new();
    for (_, ai, bi) in pairs {
        if map.contains_key(&ai) || used.contains(&bi) {
            continue;
        }
        map.insert(ai, bi);
        used.insert(bi);
    }
    if map.len() != a.len() {
        let missing = a.iter().find(|(ai, _)| !map.contains_key(ai)).map(|(_, p)| *p).unwrap();
        return Err(format!("vertex {missing:?} has no counterpart within {eps}"));
    }
    Ok(map)
}

/// Triangles remapped through `remap`, each min-rotated (winding preserved) then sorted.
fn remap_sorted_tris(tris: &[u32], remap: impl Fn(u32) -> u32) -> Vec<[u32; 3]> {
    let mut out: Vec<[u32; 3]> = tris
        .chunks_exact(3)
        .map(|t| {
            let (a, b, c) = (remap(t[0]), remap(t[1]), remap(t[2]));
            rotate_min(a as usize, b as usize, c as usize).map(|x| x as u32)
        })
        .collect();
    out.sort();
    out
}

/// Count of triangles present in exactly one of the two (unique) lists.
fn triangle_symdiff(a: &[[u32; 3]], b: &[[u32; 3]]) -> usize {
    let sa: HashSet<[u32; 3]> = a.iter().copied().collect();
    let sb: HashSet<[u32; 3]> = b.iter().copied().collect();
    a.iter().filter(|t| !sb.contains(*t)).count() + b.iter().filter(|t| !sa.contains(*t)).count()
}

/// Geometric, grid-straddle-robust cross-impl mesh equivalence — the TOLERANT companion
/// to [`meshes_equivalent`] for fixtures whose vertices may differ SUB-tolerance (a
/// different-but-valid root-finder, cross-engine libm drift). Where the quantize-and-sort
/// canonical form flips a vertex's identity when it straddles a `pos_eps` grid line, this
/// matches vertices GEOMETRICALLY. Requires:
///   * equal referenced-vertex and triangle counts,
///   * a bijective nearest-vertex correspondence within `vert_eps` (≫ the sub-tolerance
///     drift, ≪ the cell-scale vertex separation, so the match is unambiguous),
///   * connectivity under that bijection differing in ≤ `tri_tol_frac` of the triangles
///     (absorbs alternate diagonals on near-coplanar quads; a real topology regression
///     differs in far more AND moves vertices, caught by the bijection).
/// `Ok(diff)` = equivalent (returns the realized triangle difference); `Err(reason)` = not.
/// Stride-8 / pos-offset-0 (the SFCC/MeshData layout). Geometry quality is still pinned
/// elsewhere (manifold/χ/on-surface invariants); this only certifies sameness-of-surface.
pub fn meshes_geometric_match(
    a_verts: &[f64],
    a_tris: &[u32],
    b_verts: &[f64],
    b_tris: &[u32],
    vert_eps: f64,
    tri_tol_frac: f64,
) -> Result<usize, String> {
    if a_tris.len() != b_tris.len() {
        return Err(format!("triangle count: {} vs {}", a_tris.len() / 3, b_tris.len() / 3));
    }
    let pa = referenced_positions(a_verts, a_tris);
    let pb = referenced_positions(b_verts, b_tris);
    if pa.len() != pb.len() {
        return Err(format!("referenced vertex count: {} vs {}", pa.len(), pb.len()));
    }
    let map = nearest_bijection(&pa, &pb, vert_eps)?;
    let ca = remap_sorted_tris(a_tris, |i| map[&i]);
    let cb = remap_sorted_tris(b_tris, |i| i);
    let diff = triangle_symdiff(&ca, &cb);
    let allowed = ((a_tris.len() / 3) as f64 * tri_tol_frac) as usize;
    if diff > allowed {
        return Err(format!("connectivity differs in {diff}/{} triangles (allowed {allowed})", a_tris.len() / 3));
    }
    Ok(diff)
}

/// Load a binary mesh fixture written by `gcad-wasm/fixtures/dump.mts`:
/// `[u32 vert_float_count][u32 tri_index_count][f32 × verts][u32 × tris]`,
/// little-endian. Returns (verts as f64, tris). Native-only (TS-oracle parity).
pub fn load_fixture(path: &str) -> std::io::Result<(Vec<f64>, Vec<u32>)> {
    let bytes = std::fs::read(path)?;
    let rd_u32 = |o: usize| u32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]);
    let vfc = rd_u32(0) as usize;
    let tic = rd_u32(4) as usize;
    let mut off = 8;
    let mut verts = Vec::with_capacity(vfc);
    for _ in 0..vfc {
        let f = f32::from_le_bytes([bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]]);
        verts.push(f as f64);
        off += 4;
    }
    let mut tris = Vec::with_capacity(tic);
    for _ in 0..tic {
        tris.push(u32::from_le_bytes([bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]]));
        off += 4;
    }
    Ok((verts, tris))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stride-8 vertex buffer with a fixed +z normal.
    fn vbuf(positions: &[[f64; 3]]) -> Vec<f64> {
        let mut v = Vec::new();
        for p in positions {
            v.extend_from_slice(&[p[0], p[1], p[2], 0.0, 0.0, 0.0, 1.0, 0.0]);
        }
        v
    }

    #[test]
    fn order_insensitive_under_vertex_and_triangle_permutation() {
        let a_v = vbuf(&[[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]]);
        let a_t = [0u32, 1, 2];
        // Same triangle, vertices stored as (v2, v0, v1), tris remapped.
        let b_v = vbuf(&[[0., 1., 0.], [0., 0., 0.], [1., 0., 0.]]);
        let b_t = [1u32, 2, 0];
        let opts = CanonicalizeOptions::default();
        assert!(meshes_equivalent(&a_v, &a_t, &b_v, &b_t, &opts).is_ok());
    }

    #[test]
    fn winding_sensitive() {
        let v = vbuf(&[[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]]);
        let fwd = [0u32, 1, 2];
        let flipped = [0u32, 2, 1];
        let opts = CanonicalizeOptions::default();
        assert!(meshes_equivalent(&v, &fwd, &v, &flipped, &opts).is_err());
    }

    #[test]
    fn count_mismatch_reported() {
        let v = vbuf(&[[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]]);
        let opts = CanonicalizeOptions::default();
        let err = meshes_equivalent(&v, &[0, 1, 2], &v, &[0, 1, 2, 0, 1, 2], &opts).unwrap_err();
        assert!(err.contains("triangle count"));
    }

    #[test]
    fn geometric_match_absorbs_subtolerance_drift() {
        // Two triangles sharing the 1–2 edge of a unit quad.
        let a = vbuf(&[[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [1., 1., 0.]]);
        let t = [0u32, 1, 2, 1, 3, 2];
        // Nudge vertex 0 by ≪ vert_eps (the grid-straddle case the quantize-and-sort
        // form would split) → still equivalent, zero connectivity difference.
        let mut b = a.clone();
        b[0] += 1e-7;
        assert_eq!(meshes_geometric_match(&a, &t, &b, &t, 1e-3, 0.0).unwrap(), 0);
        // A real > vert_eps move has no counterpart → not equivalent.
        let mut c = a.clone();
        c[0] += 0.5;
        assert!(meshes_geometric_match(&a, &t, &c, &t, 1e-3, 0.0).is_err());
        // The alternate diagonal (0–3 split) is a connectivity difference: symdiff = 4
        // (2 triangles removed + 2 added). Rejected at zero tolerance; admitted once the
        // budget (frac · n_tris) covers it.
        let t2 = [0u32, 1, 3, 0, 3, 2];
        assert!(meshes_geometric_match(&a, &t, &a, &t2, 1e-3, 0.0).is_err());
        assert!(meshes_geometric_match(&a, &t, &a, &t2, 1e-3, 2.0).is_ok());
    }

    #[test]
    fn loads_ts_fixture_and_compares() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/sphere.bin");
        let (verts, tris) = match load_fixture(path) {
            Ok(v) => v,
            // Soft-skip if fixtures haven't been generated (run fixtures/dump.mts).
            Err(_) => {
                eprintln!("parity fixture missing: {path} (run `tsx gcad-wasm/fixtures/dump.mts`)");
                return;
            }
        };
        assert!(!tris.is_empty(), "fixture has triangles");
        let opts = CanonicalizeOptions::default();
        // Self-compare is equal.
        assert!(meshes_equivalent(&verts, &tris, &verts, &tris, &opts).is_ok());
        // Reordering the triangle list stays equal.
        let mut shuffled = tris.clone();
        shuffled.rotate_left(3);
        assert!(meshes_equivalent(&verts, &tris, &verts, &shuffled, &opts).is_ok());
        // Moving a referenced vertex makes it unequal.
        let mut moved = verts.clone();
        moved[tris[0] as usize * 8] += 1.0;
        assert!(meshes_equivalent(&verts, &tris, &moved, &tris, &opts).is_err());
    }
}
