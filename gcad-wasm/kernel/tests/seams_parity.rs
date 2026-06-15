//! M4b TS↔Rust boolean-seam parity: build the same `box − sphere` scene the TS
//! oracle dumped, run `compile_feature_set` with the SAME resolved tolerances,
//! and assert identical curve count + kinds, traced-seam sample positions
//! (canonicalized to a small tolerance — Newton/libm ULP drift expected;
//! topology/count exact), closed flags, and surviving corners.
//!
//! Fixture from `gcad-wasm/fixtures/dump-seams.mts` (gitignored `seams.txt`);
//! soft-skips if absent. Regenerate: `tsx gcad-wasm/fixtures/dump-seams.mts`.

use gcad_kernel::sdf::{self, Shape};
use gcad_kernel::sfcc::feature_curves::CurveKind;
use gcad_kernel::sfcc::feature_set::compile_feature_set;
use gcad_kernel::tolerances::ResolvedTolerances;
use std::fs;

#[derive(Debug)]
struct ExpCurve {
    kind: String,
    strata: [usize; 2],
    closed: bool,
    samples: Vec<[f64; 3]>, // world positions at the dumped fixed parameters
}

#[derive(Debug)]
struct ExpCorner {
    pos: [f64; 3],
    strata: Vec<usize>,
}

fn kind_str(k: CurveKind) -> &'static str {
    match k {
        CurveKind::Segment => "segment",
        CurveKind::Circle => "circle",
        CurveKind::Traced => "traced",
    }
}

#[test]
fn box_minus_sphere_seams_match_ts() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/seams.txt");
    let Ok(text) = fs::read_to_string(path) else {
        eprintln!("seams fixture missing: {path} (run `tsx gcad-wasm/fixtures/dump-seams.mts`)");
        return;
    };

    let mut tol: Option<ResolvedTolerances> = None;
    let mut exp_curves: Vec<ExpCurve> = Vec::new();
    let mut exp_corners: Vec<ExpCorner> = Vec::new();

    for line in text.lines() {
        let t: Vec<&str> = line.split_whitespace().collect();
        if t.is_empty() {
            continue;
        }
        let f = |i: usize| t[i].parse::<f64>().unwrap();
        let u = |i: usize| t[i].parse::<usize>().unwrap();
        match t[0] {
            "TOL" => {
                tol = Some(ResolvedTolerances {
                    surface_tol: f(1),
                    max_chord_error: f(2),
                    curve_eps: f(3),
                    probe_delta: f(4),
                    min_dihedral_cos: f(5),
                    native_crease_cos: f(6),
                    min_tangency_sin: f(7),
                    corner_merge_tol: f(8),
                    seed_cell_size: f(9),
                    max_trace_steps: u(10) as u32,
                });
            }
            "C" => {
                let kind = t[1].to_string();
                let strata = [u(2), u(3)];
                let closed = u(4) == 1;
                // t[5]=cornerStart, t[6]=cornerEnd, t[7]=nsamp.
                let nsamp = u(7);
                let mut samples = Vec::with_capacity(nsamp);
                let mut idx = 8;
                for _ in 0..nsamp {
                    // each block is [t x y z]; we keep xyz only.
                    samples.push([f(idx + 1), f(idx + 2), f(idx + 3)]);
                    idx += 4;
                }
                exp_curves.push(ExpCurve { kind, strata, closed, samples });
            }
            "K" => {
                let pos = [f(1), f(2), f(3)];
                let n = u(4);
                let strata = (0..n).map(|i| u(5 + i)).collect();
                exp_corners.push(ExpCorner { pos, strata });
            }
            _ => {}
        }
    }
    let tol = tol.expect("seams.txt missing TOL line");

    // Rebuild the exact scene: Subtract(Box([0,0,0],[10,10,10]), Sphere([5,5,5],6)).
    let tree = sdf::subtract(
        sdf::leaf_at(Shape::Cuboid { half: [10.0, 10.0, 10.0] }, [0.0, 0.0, 0.0]),
        sdf::leaf_at(Shape::Sphere { r: 6.0 }, [5.0, 5.0, 5.0]),
    );
    let (fs, _diag) = compile_feature_set(&tree, &tol);

    // --- counts + kind histogram ---------------------------------------------
    assert_eq!(fs.curves.len(), exp_curves.len(), "curve count");
    assert_eq!(fs.corners.len(), exp_corners.len(), "corner count");

    let kind_hist = |kinds: &[String]| {
        let mut seg = 0;
        let mut circ = 0;
        let mut trac = 0;
        for k in kinds {
            match k.as_str() {
                "segment" => seg += 1,
                "circle" => circ += 1,
                "traced" => trac += 1,
                _ => panic!("bad kind {k}"),
            }
        }
        (seg, circ, trac)
    };
    let exp_kinds: Vec<String> = exp_curves.iter().map(|c| c.kind.clone()).collect();
    let got_kinds: Vec<String> = fs.curves.iter().map(|c| kind_str(c.kind()).to_string()).collect();
    assert_eq!(kind_hist(&got_kinds), kind_hist(&exp_kinds), "curve kind histogram");

    // --- match each expected curve to a Rust curve by (kind, adjacent strata,
    //     closed), then compare sample positions canonically. Matching is exact
    //     on topology; positions canonicalize to absorb Newton/libm ULP drift. -
    let mut used = vec![false; fs.curves.len()];
    let pos_tol = 1e-6_f64.max(tol.max_chord_error); // chord-tolerant sample compare
    for (ei, ec) in exp_curves.iter().enumerate() {
        let mut best: Option<usize> = None;
        let mut best_err = f64::INFINITY;
        for (gi, gc) in fs.curves.iter().enumerate() {
            if used[gi] {
                continue;
            }
            if kind_str(gc.kind()) != ec.kind {
                continue;
            }
            if gc.closed != ec.closed {
                continue;
            }
            // adjacent strata as an unordered pair
            let gp = {
                let mut p = gc.adjacent_strata;
                p.sort_unstable();
                p
            };
            let ep = {
                let mut p = ec.strata;
                p.sort_unstable();
                p
            };
            if gp != ep {
                continue;
            }
            // Compare sampled positions: for closed traced loops the param
            // origin/direction may differ, so score by the best alignment of
            // each TS sample to ANY point on the Rust curve (via project).
            let mut err = 0.0_f64;
            for s in &ec.samples {
                let (_, d) = gc.project(s[0], s[1], s[2]);
                err = err.max(d);
            }
            if err < best_err {
                best_err = err;
                best = Some(gi);
            }
        }
        let gi = best.unwrap_or_else(|| panic!("no Rust curve matches expected curve {ei} ({:?})", ec.kind));
        assert!(
            best_err < pos_tol,
            "curve {ei} ({}) sample drift {best_err} exceeds {pos_tol}",
            ec.kind
        );
        used[gi] = true;
    }
    assert!(used.iter().all(|&u| u), "every Rust curve matched");

    // --- corners: match by position (set compare) ----------------------------
    let mut cused = vec![false; fs.corners.len()];
    for ec in &exp_corners {
        let mut found = false;
        for (gi, gc) in fs.corners.iter().enumerate() {
            if cused[gi] {
                continue;
            }
            let d = ((gc.x - ec.pos[0]).powi(2) + (gc.y - ec.pos[1]).powi(2) + (gc.z - ec.pos[2]).powi(2)).sqrt();
            if d < tol.corner_merge_tol.max(1e-6) {
                // incident strata as a set
                let mut gs = gc.strata.clone();
                gs.sort_unstable();
                let mut es = ec.strata.clone();
                es.sort_unstable();
                assert_eq!(gs, es, "corner at {:?} incident strata", ec.pos);
                cused[gi] = true;
                found = true;
                break;
            }
        }
        assert!(found, "no Rust corner matches expected corner at {:?}", ec.pos);
    }
    assert!(cused.iter().all(|&u| u), "every Rust corner matched");
}
