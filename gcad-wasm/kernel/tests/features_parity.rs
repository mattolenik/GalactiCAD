//! M4a TS↔Rust native-feature parity: build the same rotated+translated box leaf
//! the TS oracle dumped, run `compile_native_features`, and require identical
//! curves + corners. Fixture from `gcad-wasm/fixtures/dump-features.mts`
//! (soft-skips if absent).

use gcad_kernel::math::similarity::Similarity;
use gcad_kernel::sdf::{leaf, Shape};
use gcad_kernel::sfcc::feature_curves::CurveKind;
use gcad_kernel::sfcc::feature_set::compile_native_features;
use std::fs;

#[test]
fn box_native_features_match_ts() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/features-box.txt");
    let Ok(text) = fs::read_to_string(path) else {
        eprintln!("features fixture missing: {path} (run `tsx gcad-wasm/fixtures/dump-features.mts`)");
        return;
    };

    let mut sim = Similarity::identity();
    let mut pos = [0.0; 3];
    let mut half = [0.0; 3];
    // Expected curves: (s0, s1, p0[3], p1[3]); corners: (x,y,z, strata).
    let mut exp_curves: Vec<([usize; 2], [f64; 3], [f64; 3])> = Vec::new();
    let mut exp_corners: Vec<([f64; 3], Vec<usize>)> = Vec::new();

    for line in text.lines() {
        let t: Vec<&str> = line.split_whitespace().collect();
        if t.is_empty() {
            continue;
        }
        let f = |i: usize| t[i].parse::<f64>().unwrap();
        let u = |i: usize| t[i].parse::<usize>().unwrap();
        match t[0] {
            "SIM" => {
                let mut r = [0.0; 9];
                for (i, slot) in r.iter_mut().enumerate() {
                    *slot = f(1 + i);
                }
                sim = Similarity { r, t: [f(10), f(11), f(12)], s: f(13) };
            }
            "POS" => pos = [f(1), f(2), f(3)],
            "HALF" => half = [f(1), f(2), f(3)],
            "C" => exp_curves.push(([u(2), u(3)], [f(4), f(5), f(6)], [f(7), f(8), f(9)])),
            "K" => {
                let n = u(5);
                exp_corners.push(([f(2), f(3), f(4)], (0..n).map(|i| u(6 + i)).collect()));
            }
            _ => {}
        }
    }

    let tree = leaf(Shape::Cuboid { half }, sim, pos);
    let fs = compile_native_features(&tree);

    assert_eq!(fs.curves.len(), exp_curves.len(), "curve count");
    assert_eq!(fs.corners.len(), exp_corners.len(), "corner count");
    assert_eq!(fs.curves.len(), 12);
    assert_eq!(fs.corners.len(), 8);

    let close = |a: [f64; 3], b: [f64; 3]| {
        (a[0] - b[0]).abs() < 1e-9 && (a[1] - b[1]).abs() < 1e-9 && (a[2] - b[2]).abs() < 1e-9
    };

    for (i, c) in fs.curves.iter().enumerate() {
        let (es, ep0, ep1) = &exp_curves[i];
        assert_eq!(c.kind(), CurveKind::Segment, "curve {i} kind");
        assert_eq!(c.adjacent_strata, *es, "curve {i} adjacent strata");
        assert!(close(c.point_at(0.0), *ep0), "curve {i} p0: {:?} vs {:?}", c.point_at(0.0), ep0);
        assert!(close(c.point_at(1.0), *ep1), "curve {i} p1");
    }
    for (i, k) in fs.corners.iter().enumerate() {
        let (ep, es) = &exp_corners[i];
        assert!(close([k.x, k.y, k.z], *ep), "corner {i} pos");
        assert_eq!(&k.strata, es, "corner {i} strata");
    }
}
