use gcad_kernel::sfcc::feature_curves::{make_circle_curve, make_traced_curve, TracedRefine};
use gcad_kernel::sfcc::spatial_index::SfccSpatialIndex;
use gcad_kernel::strata::{Stratum, StratumIdentity};

#[test]
fn circle_and_wrapped_arc_queries_include_between_knot_extrema() {
    let w = 1. / 3.0_f64.sqrt();
    for center in [[0.; 3], [1e6, -2e6, 3e6]] {
        for radius in [0.01, 3.] {
            for arc in [None, Some((5.7, 6.8)), Some((-2.3, 1.2))] {
                let curve = make_circle_curve(7, 0, [0, 1], center[0], center[1], center[2], w, w, w, radius, arc);
                let mut index = SfccSpatialIndex::new(radius / 100.);
                index.insert_curve(&curve);
                for i in 0..=1024 {
                    let t = curve.t_min + (curve.t_max - curve.t_min) * i as f64 / 1024.;
                    let p = curve.point_at(t);
                    assert!(index.curves_in_box(p, p).contains(&7), "missing {p:?}, t={t}");
                }
                let far = center.map(|v| v + 10. * radius);
                assert!(index.curves_in_box(far, far).is_empty());
            }
        }
    }
}

#[test]
fn traced_curve_queries_cover_newton_displacement_and_large_envelopes() {
    let identity = |id| StratumIdentity { id, owner_node_id: 0, leaf_index: 0, local_index: id, sign: 1. };
    let y = 0.91_f64.sqrt() + 0.02;
    for displacement in [0.1, 1e6] {
        let curve = make_traced_curve(
            3,
            [0, 1],
            vec![-0.3, y, 0., 0.3, y, 0.],
            false,
            Stratum::sphere(identity(0), 0., 0.02, 0., 1.),
            Stratum::plane(identity(1), 0., 0., 1., 0.),
            TracedRefine { curve_eps: 1e-12, min_cross: 1e-3, max_displacement: displacement },
            0,
        );
        let mut index = SfccSpatialIndex::new(1.);
        index.insert_curve(&curve);
        assert!(curve.point_at_checked(0.5).unwrap()[1] > 1. && y < 1.);
        for i in 0..=32 {
            let p = curve.point_at_checked(i as f64 / 32.).unwrap();
            assert!(index.curves_in_box(p, p).contains(&3), "missing projected point {p:?}");
        }
        // Wide searches and broad uncertainty envelopes must not allocate every
        // empty grid bin or omit candidates to stay within the indexing budget.
        index.insert_corner(9, 0., 0., 0.);
        assert_eq!(index.curves_in_box([-1e9; 3], [1e9; 3]), vec![3]);
        assert_eq!(index.corners_in_box([-1e9; 3], [1e9; 3]), vec![9]);
    }
}
