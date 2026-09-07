use gcad_kernel::primitives::{polygon2d::winding_sign, shapes::lathe_profile_edges, smin::SminMode};
use gcad_kernel::sdf::{leaf_at, BlendKind, CsgNode, Shape};
use gcad_kernel::sfcc::feature_set::compile_feature_set;
use gcad_kernel::{tolerances::resolve_tolerances, tuning::SfccTuning};

/// A cut through an offset surface visits positive primitive-field regions,
/// including edges/vertices which are not primitive zero-surface carriers.
#[test]
fn cuts_through_blends_cover_primitive_field_regions() {
    let square = vec![-2., -2., 2., -2., 2., 2., -2., 2.];
    let diamond = vec![0., -2.5, 2.5, 0., 0., 2.5, -2.5, 0.];
    let profile = [[0., -2.], [3., -2.], [3., 1.], [2., 1.], [2., 2.], [0., 2.]];
    let cases = [
        ("box", Shape::Cuboid { half: [2., 2., 2.] }, 0.37),
        ("cone rim", Shape::Cone { r: 3., h: 4. }, -0.12),
        ("cylinder rim", Shape::Cylinder { r: 3., h: 2. }, 2.12),
        ("extrude vertices", Shape::Extrude { verts: square.clone(), wind: -1., h: 2., twist_rad: 0. }, 0.37),
        ("twisted vertices", Shape::Extrude { verts: square.clone(), wind: -1., h: 2., twist_rad: 1.2 }, 0.37),
        (
            "concave extrude",
            Shape::Extrude {
                verts: vec![-2., -2., 2., -2., 2., 0., 0., 0., 0., 2., -2., 2.],
                wind: -1.,
                h: 2.,
                twist_rad: 0.,
            },
            0.37,
        ),
        (
            "concave twist",
            Shape::Extrude {
                verts: vec![-2., -2., 2., -2., 2., 0., 0., 0., 0., 2., -2., 2.],
                wind: -1.,
                h: 2.,
                twist_rad: -0.8,
            },
            0.37,
        ),
        ("loft regions", Shape::Loft { profs: vec![square, diamond], winds: vec![-1., -1.], h: 2. }, 0.37),
        ("lathe ring", Shape::Lathe { edges: lathe_profile_edges(&profile, winding_sign(&profile)) }, -2.12),
    ];
    let tol = resolve_tolerances(&SfccTuning::default(), 40.);
    for (name, shape, y) in cases {
        for mode in [SminMode::Chamfer, SminMode::Round, SminMode::Soft] {
            let leaf = leaf_at(shape.clone(), [0.; 3]);
            let body =
                CsgNode::Blend { kind: BlendKind::Smin, mode, r: 0.8, n: 3., children: vec![leaf.clone(), leaf] };
            let cut = leaf_at(Shape::Cuboid { half: [20., 20., 20.] }, [0., y - 20., 0.]);
            let tree = CsgNode::Max(vec![body.clone(), cut]);
            let (fs, _) = compile_feature_set(&tree, &tol);
            for i in 0..48 {
                let angle = (i as f64 + 0.17) * std::f64::consts::TAU / 48.;
                let point = |r: f64| [r * angle.cos(), y, r * angle.sin()];
                let (mut a, mut b) = (0., 8.);
                assert!(body.f(point(a)) < 0. && body.f(point(b)) > 0., "{name} {mode:?}: invalid bracket");
                for _ in 0..60 {
                    let m = (a + b) * 0.5;
                    if body.f(point(m)) < 0. {
                        a = m;
                    } else {
                        b = m;
                    }
                }
                let p = point((a + b) * 0.5);
                assert!(tree.f(p).abs() < 1e-9, "{name} {mode:?}: reference residual");
                let gap = fs.curves.iter().map(|c| c.project(p[0], p[1], p[2]).1).fold(f64::INFINITY, f64::min);
                assert!(gap <= tol.max_chord_error, "{name} {mode:?}, point {p:?}: seam gap {gap}");
            }
        }
    }
}
