//! M4a carrier + curved-feature parity. Rebuilds each TS scene from the dumped
//! similarity, runs `compile_native_features`, and checks (a) every stratum's
//! carrier f/normal against the TS oracle at a shared point cloud — closing the
//! M4a-foundation "carrier geometry unverified" gap — and (b) cylinder/cone
//! native curves/corners. Fixture: `gcad-wasm/fixtures/dump-strata.mts`
//! (gitignored `strata.txt`); soft-skips if absent.

use gcad_kernel::math::similarity::Similarity;
use gcad_kernel::sdf::{leaf, Shape};
use gcad_kernel::sfcc::feature_curves::CurveKind;
use gcad_kernel::sfcc::feature_set::compile_native_features;
use std::fs;

fn nums(line: &str, skip: usize) -> Vec<f64> {
    line.split_whitespace().skip(skip).map(|t| t.parse::<f64>().unwrap()).collect()
}

#[test]
fn carrier_and_curved_feature_parity() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/strata.txt");
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(_) => {
            eprintln!("strata fixture missing: {path} (run `tsx gcad-wasm/fixtures/dump-strata.mts`)");
            return;
        }
    };
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let mut i = 0usize;
    let mut scenes = 0usize;

    while i < lines.len() {
        let mut head = lines[i].split_whitespace();
        assert_eq!(head.next(), Some("SCENE"));
        let name = head.next().unwrap().to_string();
        i += 1;

        let sim_v = nums(lines[i], 1);
        i += 1;
        assert_eq!(sim_v.len(), 13, "{name}: SIM");
        let mut r = [0.0f64; 9];
        r.copy_from_slice(&sim_v[0..9]);
        let sim = Similarity { r, t: [sim_v[9], sim_v[10], sim_v[11]], s: sim_v[12] };

        let shape_toks: Vec<&str> = lines[i].split_whitespace().collect();
        i += 1;
        let pf = |s: &str| s.parse::<f64>().unwrap();
        let shape = match shape_toks[1] {
            "box" => Shape::Cuboid { half: [pf(shape_toks[2]), pf(shape_toks[3]), pf(shape_toks[4])] },
            "cylinder" => Shape::Cylinder { r: pf(shape_toks[2]), h: pf(shape_toks[3]) },
            "cone" => Shape::Cone { r: pf(shape_toks[2]), h: pf(shape_toks[3]) },
            "sphere" => Shape::Sphere { r: pf(shape_toks[2]) },
            other => panic!("{name}: unknown shape {other}"),
        };

        let pos_v = nums(lines[i], 1);
        i += 1;
        let pos = [pos_v[0], pos_v[1], pos_v[2]];

        let k = nums(lines[i], 1)[0] as usize;
        i += 1;
        let mut pts = Vec::with_capacity(k);
        for _ in 0..k {
            let v = nums(lines[i], 0);
            i += 1;
            pts.push([v[0], v[1], v[2]]);
        }

        let tree = leaf(shape, sim, pos);
        let fs = compile_native_features(&tree);

        // --- strata carrier f / normal ---
        let m = nums(lines[i], 1)[0] as usize;
        i += 1;
        assert_eq!(fs.strata.len(), m, "{name}: stratum count");
        for si in 0..m {
            let kind = lines[i].split_whitespace().nth(1).unwrap().to_string();
            i += 1;
            for (pj, q) in pts.iter().enumerate() {
                let v = nums(lines[i], 0);
                i += 1;
                let rf = fs.strata[si].f(q[0], q[1], q[2]);
                assert!((rf - v[0]).abs() < 1e-9, "{name} stratum {si}({kind}) pt {pj}: f {rf} vs {}", v[0]);
                let rn = fs.strata[si].normal(q[0], q[1], q[2]);
                assert!(
                    (rn[0] - v[1]).abs() < 1e-9 && (rn[1] - v[2]).abs() < 1e-9 && (rn[2] - v[3]).abs() < 1e-9,
                    "{name} stratum {si}({kind}) pt {pj}: normal [{},{},{}] vs [{},{},{}]",
                    rn[0], rn[1], rn[2], v[1], v[2], v[3]
                );
            }
        }

        // --- native curves (cylinder/cone scenes only; 0 = skip) ---
        let nc = nums(lines[i], 1)[0] as usize;
        i += 1;
        if nc > 0 {
            assert_eq!(fs.curves.len(), nc, "{name}: curve count");
        }
        for ci in 0..nc {
            let toks: Vec<&str> = lines[i].split_whitespace().collect();
            i += 1;
            let kind = toks[1];
            let (s0, s1): (usize, usize) = (toks[2].parse().unwrap(), toks[3].parse().unwrap());
            let c = &fs.curves[ci];
            let kind_ok = (kind == "circle" && c.kind() == CurveKind::Circle)
                || (kind == "segment" && c.kind() == CurveKind::Segment);
            assert!(kind_ok, "{name} curve {ci}: kind {kind} vs {:?}", c.kind());
            assert_eq!([c.adjacent_strata[0], c.adjacent_strata[1]], [s0, s1], "{name} curve {ci}: adjacent strata");
            for (ti, &t) in [0.0, 0.25, 0.5, 0.75].iter().enumerate() {
                let b = 4 + ti * 3;
                let (ex, ey, ez) = (pf(toks[b]), pf(toks[b + 1]), pf(toks[b + 2]));
                let rp = c.point_at(t);
                assert!(
                    (rp[0] - ex).abs() < 1e-7 && (rp[1] - ey).abs() < 1e-7 && (rp[2] - ez).abs() < 1e-7,
                    "{name} curve {ci} t {t}: [{},{},{}] vs [{ex},{ey},{ez}]",
                    rp[0], rp[1], rp[2]
                );
            }
        }

        // --- native corners ---
        let nk = nums(lines[i], 1)[0] as usize;
        i += 1;
        if nk > 0 {
            assert_eq!(fs.corners.len(), nk, "{name}: corner count");
        }
        for ki in 0..nk {
            let toks: Vec<&str> = lines[i].split_whitespace().collect();
            i += 1;
            let (ex, ey, ez) = (pf(toks[1]), pf(toks[2]), pf(toks[3]));
            let kstrata: Vec<usize> = toks[4..].iter().map(|t| t.parse().unwrap()).collect();
            let corner = &fs.corners[ki];
            assert!(
                (corner.x - ex).abs() < 1e-7 && (corner.y - ey).abs() < 1e-7 && (corner.z - ez).abs() < 1e-7,
                "{name} corner {ki}: pos"
            );
            assert_eq!(corner.strata, kstrata, "{name} corner {ki}: strata");
        }

        scenes += 1;
    }
    assert!(scenes >= 4, "expected >=4 scenes, got {scenes}");
}
