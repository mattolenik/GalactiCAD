//! TS↔Rust SDF parity: evaluate the Rust CSG tree at the same points the TS
//! oracle sampled and require the field to match. Fixtures from
//! `gcad-wasm/fixtures/dump-sdf.mts`; soft-skips if they haven't been generated.

use gcad_kernel::primitives::polygon2d::winding_sign;
use gcad_kernel::primitives::shapes;
use gcad_kernel::primitives::smin::SminMode;
use gcad_kernel::sdf::{self, Shape};
use std::fs;

fn load_sdf(path: &str) -> Option<(Vec<[f64; 3]>, Vec<f64>)> {
    let bytes = fs::read(path).ok()?;
    let rd_u32 = |o: usize| u32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]);
    let rd_f64 = |o: usize| {
        f64::from_le_bytes([
            bytes[o],
            bytes[o + 1],
            bytes[o + 2],
            bytes[o + 3],
            bytes[o + 4],
            bytes[o + 5],
            bytes[o + 6],
            bytes[o + 7],
        ])
    };
    let n = rd_u32(0) as usize;
    let mut off = 4;
    let mut pts = Vec::with_capacity(n);
    for _ in 0..n {
        pts.push([rd_f64(off), rd_f64(off + 8), rd_f64(off + 16)]);
        off += 24;
    }
    let mut fvals = Vec::with_capacity(n);
    for _ in 0..n {
        fvals.push(rd_f64(off));
        off += 8;
    }
    Some((pts, fvals))
}

fn check_fn(name: &str, f: impl Fn([f64; 3]) -> f64) {
    let full = format!("{}/../fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    let Some((pts, fvals)) = load_sdf(&full) else {
        eprintln!("sdf fixture missing: {full} (run `tsx gcad-wasm/fixtures/dump-sdf.mts`)");
        return;
    };
    assert!(!pts.is_empty(), "fixture has samples");
    let mut maxerr = 0.0f64;
    for (p, &fref) in pts.iter().zip(&fvals) {
        maxerr = maxerr.max((f(*p) - fref).abs());
    }
    // Tolerance covers libm hypot differences between V8 and Rust; the formulas
    // are otherwise identical f64 ports.
    assert!(maxerr < 1e-6, "{name}: max |Rust f − TS f| = {maxerr}");
}

fn check(name: &str, tree: &sdf::CsgNode) {
    check_fn(name, |p| tree.f(p));
}

// Shared geometry — MUST stay identical to the literals in dump-sdf.mts.
const EXTRUDE_POLY: [[f64; 2]; 5] = [[2., 0.], [0.6, 1.9], [-1.6, 1.2], [-1.6, -1.2], [0.6, -1.9]];
const LOFT_BIG: [[f64; 2]; 4] = [[2., 2.], [-2., 2.], [-2., -2.], [2., -2.]];
const LOFT_SMALL: [[f64; 2]; 4] = [[1.4, 0.], [0., 1.4], [-1.4, 0.], [0., -1.4]];
const LATHE_PROFILE: [[f64; 2]; 5] = [[0., -2.], [1.6, -2.], [0.9, 1.0], [1.2, 2.0], [0., 2.]];

fn flat(p: &[[f64; 2]]) -> Vec<f64> {
    p.iter().flat_map(|q| [q[0], q[1]]).collect()
}

#[test]
fn sphere_f_matches_ts() {
    check("sdf-sphere.bin", &sdf::leaf_at(Shape::Sphere { r: 8.0 }, [0.13, -0.21, 0.07]));
}

#[test]
fn box_minus_sphere_f_matches_ts() {
    let tree = sdf::subtract(
        sdf::leaf_at(Shape::Cuboid { half: [10.0, 10.0, 10.0] }, [0.0, 0.0, 0.0]),
        sdf::leaf_at(Shape::Sphere { r: 6.0 }, [5.0, 5.0, 5.0]),
    );
    check("sdf-box-minus-sphere.bin", &tree);
}

#[test]
fn smooth_union_round_matches_ts() {
    let tree = sdf::union_smooth(
        vec![
            sdf::leaf_at(Shape::Sphere { r: 2.0 }, [-1.5, 0.0, 0.0]),
            sdf::leaf_at(Shape::Sphere { r: 2.0 }, [1.5, 0.0, 0.0]),
        ],
        SminMode::Round,
        1.0,
        4.0,
    );
    check("sdf-smooth-union-round.bin", &tree);
}

#[test]
fn smooth_union_columns_matches_ts() {
    let tree = sdf::union_smooth(
        vec![
            sdf::leaf_at(Shape::Sphere { r: 2.0 }, [-1.5, 0.0, 0.0]),
            sdf::leaf_at(Shape::Sphere { r: 2.0 }, [1.5, 0.0, 0.0]),
        ],
        SminMode::Columns,
        1.0,
        3.0,
    );
    check("sdf-smooth-union-columns.bin", &tree);
}

#[test]
fn extrude_matches_ts() {
    let verts = flat(&EXTRUDE_POLY);
    let w = winding_sign(&EXTRUDE_POLY);
    check_fn("sdf-extrude.bin", |p| shapes::extrude_dist(&verts, w, 3.0, 0.0, p[0], p[1], p[2]));
}

#[test]
fn extrude_twist_matches_ts() {
    let verts = flat(&EXTRUDE_POLY);
    let w = winding_sign(&EXTRUDE_POLY);
    check_fn("sdf-extrude-twist.bin", |p| shapes::extrude_dist(&verts, w, 3.0, 0.7, p[0], p[1], p[2]));
}

#[test]
fn loft_matches_ts() {
    let profs = vec![flat(&LOFT_BIG), flat(&LOFT_SMALL)];
    let winds = vec![winding_sign(&LOFT_BIG), winding_sign(&LOFT_SMALL)];
    check_fn("sdf-loft.bin", |p| shapes::loft_dist(&profs, &winds, 3.0, p[0], p[1], p[2]));
}

#[test]
fn lathe_matches_ts() {
    let edges = shapes::lathe_profile_edges(&LATHE_PROFILE, winding_sign(&LATHE_PROFILE));
    check_fn("sdf-lathe.bin", |p| shapes::lathe_dist(&edges, p[0], p[1], p[2]));
}
