//! TS↔Rust SDF parity: evaluate the Rust CSG tree at the same points the TS
//! oracle sampled and require the field to match. Fixtures from
//! `gcad-wasm/fixtures/dump-sdf.mts`; soft-skips if they haven't been generated.

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

fn check(name: &str, tree: &sdf::CsgNode) {
    let full = format!("{}/../fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    let Some((pts, fvals)) = load_sdf(&full) else {
        eprintln!("sdf fixture missing: {full} (run `tsx gcad-wasm/fixtures/dump-sdf.mts`)");
        return;
    };
    assert!(!pts.is_empty(), "fixture has samples");
    let mut maxerr = 0.0f64;
    for (p, &fref) in pts.iter().zip(&fvals) {
        maxerr = maxerr.max((tree.f(*p) - fref).abs());
    }
    // Tolerance covers libm hypot differences between V8 and Rust; the formulas
    // are otherwise identical f64 ports.
    assert!(maxerr < 1e-6, "{name}: max |Rust f − TS f| = {maxerr}");
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
