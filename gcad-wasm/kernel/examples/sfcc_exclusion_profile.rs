//! Read-only attribution of saved final same-sign decisions to production bounds.
#[cfg(feature = "serde")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use gcad_kernel::sdf::CsgNode;
    use serde_json::{json, Value};
    use std::collections::BTreeMap;
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 { return Err("expected CONFIG_JSON NATIVE_CELLS_JSON".into()); }
    let config: Value = serde_json::from_slice(&std::fs::read(&args[1])?)?;
    let cells: Value = serde_json::from_slice(&std::fs::read(&args[2])?)?;
    let tree = gcad_kernel::scene_bridge::build_csg_tree_from_json(
        config["sceneJson"].as_str().ok_or("sceneJson")?,
    )?;
    fn visit(
        node: &CsgNode,
        path: String,
        c: [f64; 3],
        h: [f64; 3],
        groups: &mut BTreeMap<String, [usize; 6]>,
    ) {
        let (label, children) = match node {
            CsgNode::Leaf(l) => (format!("{:?}", l.shape), None),
            CsgNode::Min(ch) => ("Min".into(), Some(ch)),
            CsgNode::Max(ch) => ("Max".into(), Some(ch)),
            CsgNode::Blend {
                kind,
                mode,
                children,
                ..
            } => (format!("{kind:?}/{mode:?}"), Some(children)),
        };
        let iv = node.interval_over_box(c, h);
        let ball = node.interval_over_ball(c, h[0].hypot(h[1]).hypot(h[2]));
        let entry = groups.entry(format!("{path} {label}")).or_default();
        entry[0] += 1;
        entry[1] += usize::from(iv.0 <= 0. && iv.1 >= 0.);
        entry[2] += usize::from(ball.0 <= 0. && ball.1 >= 0. && (iv.0 > 0. || iv.1 < 0.));
        entry[3] += usize::from(iv.0 > 0.);
        entry[4] += usize::from(iv.1 < 0.);
        entry[5] += usize::from(!iv.0.is_finite() || !iv.1.is_finite());
        if let Some(ch) = children {
            for (i, x) in ch.iter().enumerate() {
                visit(x, format!("{path}/{i}"), c, h, groups);
            }
        }
    }
    let lat = &cells["lattice"];
    let mut groups = BTreeMap::new();
    let mut selected = 0;
    let mut checked = [0usize; 4];
    for cell in cells["cells"].as_array().ok_or("cells")? {
        if cell["firstReason"] != "same_sign_root_interval" {
            continue;
        }
        selected += 1;
        let id = cell["cell"].as_array().ok_or("cell id")?;
        let size = lat["worldSize"].as_f64().ok_or("size")?
            / 2_f64.powi(id[0].as_i64().ok_or("level")? as i32);
        let c = std::array::from_fn(|a| {
            lat["origin"][a].as_f64().unwrap() + (id[a + 1].as_i64().unwrap() as f64 + 0.5) * size
        });
        visit(&tree, "root".into(), c, [size / 2.; 3], &mut groups);
        match tree.checked_partial_interval_over_box(c, [size / 2.; 3]) {
            Some((a, _)) if a > 0. => checked[0] += 1,
            Some((_, b)) if b < 0. => checked[1] += 1,
            Some(_) => checked[2] += 1,
            None => checked[3] += 1,
        };
    }
    println!(
        "{}",
        serde_json::to_string_pretty(
            &json!({"selectedSameSignCells":selected,"checkedRootCounterfactualPositiveNegativeUnknownInvalid":checked,"columns":["visits","boxContainsZero","ballContainsZeroButBoxExcludes","positive","negative","invalid"],"subtrees":groups})
        )?
    );
    Ok(())
}
#[cfg(not(feature = "serde"))]
fn main() {
    eprintln!("requires serde");
}
