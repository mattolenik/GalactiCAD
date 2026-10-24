//! Compare saved mesh geometry and check the complete affected neighborhood.
//! cargo run --release --features serde,sfcc-profile --example sfcc_mesh_geometry_audit -- CONFIG_JSON
#[cfg(all(feature = "serde", feature = "sfcc-profile"))]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use gcad_kernel::sfcc::{
        diagnosis::{mesh_intersections, triangle_exactly_degenerate},
        manifold_check::check_manifold,
    };
    use serde_json::{json, Value};
    use std::collections::{BTreeMap, BTreeSet};
    type Error = Box<dyn std::error::Error>;
    fn vertices(spec: &Value) -> Result<Vec<[f64; 3]>, Error> {
        let bytes = std::fs::read(spec["vertices"].as_str().ok_or("vertices path")?)?;
        let stride = spec["stride"].as_u64().ok_or("vertex stride")? as usize;
        if stride < 3 {
            return Err("stride below3".into());
        }
        let values: Vec<f64> = match spec["scalar"].as_str() {
            Some("f32") if bytes.len() % 4 == 0 => bytes
                .chunks_exact(4)
                .map(|b| f32::from_le_bytes(b.try_into().unwrap()) as f64)
                .collect(),
            Some("f64") if bytes.len() % 8 == 0 => bytes
                .chunks_exact(8)
                .map(|b| f64::from_le_bytes(b.try_into().unwrap()))
                .collect(),
            _ => return Err("invalid scalar buffer".into()),
        };
        if values.len() % stride != 0 {
            return Err("vertex payload not divisible by stride".into());
        }
        Ok(values
            .chunks_exact(stride)
            .map(|v| [v[0], v[1], v[2]])
            .collect())
    }
    fn mesh(spec: &Value) -> Result<(Vec<[f64; 3]>, Vec<[usize; 3]>), Error> {
        let p = vertices(spec)?;
        let bytes = std::fs::read(spec["triangles"].as_str().ok_or("triangles path")?)?;
        if bytes.len() % 12 != 0 {
            return Err("triangle payload not divisible by12".into());
        }
        let t: Vec<[usize; 3]> = bytes
            .chunks_exact(12)
            .map(|b| {
                std::array::from_fn(|i| {
                    u32::from_le_bytes(b[i * 4..i * 4 + 4].try_into().unwrap()) as usize
                })
            })
            .collect();
        if t.iter()
            .flatten()
            .any(|&i| i >= p.len() || p[i].iter().any(|x| !x.is_finite()))
        {
            return Err("invalid referenced position".into());
        }
        Ok((p, t))
    }
    fn point(p: [f64; 3]) -> [u32; 3] {
        p.map(|x| if x == 0. { 0 } else { (x as f32).to_bits() })
    }
    fn triangle(t: [usize; 3], p: &[[f64; 3]]) -> [[u32; 3]; 3] {
        let v = t.map(|i| point(p[i]));
        let k = (0..3)
            .min_by_key(|&i| [v[i], v[(i + 1) % 3], v[(i + 2) % 3]])
            .unwrap();
        [v[k], v[(k + 1) % 3], v[(k + 2) % 3]]
    }
    let path = std::env::args().nth(1).ok_or("expected CONFIG_JSON")?;
    let config: Value = serde_json::from_slice(&std::fs::read(path)?)?;
    let (before_p, before_t) = mesh(&config["baseline"])?;
    let (p, t) = mesh(&config["candidate"])?;
    let baseline: BTreeSet<_> = before_t.iter().map(|&t| triangle(t, &before_p)).collect();
    let mut seed = BTreeSet::new();
    let mut old_bad = 0;
    for &t in &before_t {
        let v = t.map(|i| before_p[i].map(|x| x as f32 as f64));
        if triangle_exactly_degenerate(v) {
            old_bad += 1;
            seed.extend(v.map(point));
        }
    }
    let mut changed = 0;
    for &ids in &t {
        if !baseline.contains(&triangle(ids, &p)) {
            changed += 1;
            seed.extend(ids.map(|i| point(p[i])));
        }
    }
    let current: BTreeSet<_> = t.iter().map(|&t| triangle(t, &p)).collect();
    let mut removed = 0;
    for &ids in &before_t {
        if !current.contains(&triangle(ids, &before_p)) {
            removed += 1;
            seed.extend(ids.map(|i| point(before_p[i])));
        }
    }
    if let Some(spec) = config.get("features") {
        let positions = vertices(&spec["mesh"])?;
        let bytes = std::fs::read(spec["edges"].as_str().ok_or("feature edge path")?)?;
        if bytes.len() % 40 != 0 {
            return Err("feature payload not divisible by40".into());
        }
        let mut edges = BTreeMap::<(usize, usize), BTreeSet<usize>>::new();
        for row in bytes.chunks_exact(40) {
            let v: [f64; 5] = std::array::from_fn(|i| {
                f64::from_le_bytes(row[i * 8..i * 8 + 8].try_into().unwrap())
            });
            let (a, b) = (v[0] as usize, v[1] as usize);
            if a >= positions.len() || b >= positions.len() {
                return Err("feature index".into());
            }
            edges
                .entry((a.min(b), a.max(b)))
                .or_default()
                .insert(v[2] as usize);
        }
        for ((a, b), memberships) in edges {
            if memberships.len() > 1 {
                seed.insert(point(positions[a]));
                seed.insert(point(positions[b]));
            }
        }
    }
    let selected: Vec<_> = t
        .iter()
        .map(|t| t.iter().any(|&i| seed.contains(&point(p[i]))))
        .collect();
    // Degenerate faces fail the separate validity gate; a triangle-intersection
    // predicate requires genuine two-dimensional faces. Keep original IDs/data.
    let valid: Vec<_> = t
        .iter()
        .enumerate()
        .filter_map(|(i, t)| {
            let v = t.map(|id| p[id]);
            (!triangle_exactly_degenerate(v)
                && !triangle_exactly_degenerate(v.map(|p| p.map(|x| x as f32 as f64))))
            .then_some(i)
        })
        .collect();
    let pairs: Vec<_> = mesh_intersections(
        &p,
        &valid.iter().map(|&i| t[i]).collect::<Vec<_>>(),
        &valid.iter().map(|&i| selected[i]).collect::<Vec<_>>(),
    )
    .into_iter()
    .map(|(a, b, x, y)| (valid[a], valid[b], x, y))
    .collect();
    let manifold = check_manifold(
        &t.iter()
            .flatten()
            .map(|&i| u32::try_from(i).expect("u32 index"))
            .collect::<Vec<_>>(),
        true,
    );
    let raw_bad = t
        .iter()
        .filter(|t| triangle_exactly_degenerate(t.map(|i| p[i])))
        .count();
    let rounded_bad = t
        .iter()
        .filter(|t| triangle_exactly_degenerate(t.map(|i| p[i].map(|x| x as f32 as f64))))
        .count();
    println!(
        "{}",
        serde_json::to_string_pretty(
            &json!({"scope":"new and removed oriented f32 triangle geometry, baseline-degenerate vertices and every multiply-labeled feature edge; all surviving incident triangles tested against the whole final mesh",
                "input":config,"triangles":t.len(),"newGeometricTriangles":changed,"removedGeometricTriangles":removed,"selectedTriangles":selected.iter().filter(|&&x|x).count(),"baselineInvalidF32":old_bad,"invalidFacesExcludedFromIntersectionPredicates":t.len()-valid.len(),
                "invalidWorking":raw_bad,"invalidF32":rounded_bad,"components":manifold.components,"euler":manifold.euler_per_component,
                "topology":{"openEdges":manifold.open_edges,"nonManifoldEdges":manifold.non_manifold_edges,"misorientedEdges":manifold.misoriented_edges,"nonManifoldVertices":manifold.non_manifold_vertices},
                "intersectionsWorking":pairs.iter().filter(|p|p.2).count(),"intersectionsF32":pairs.iter().filter(|p|p.3).count(),"intersectionPairs":pairs,
                "examples":pairs.iter().take(20).map(|&(a,b,raw,rounded)|json!({"triangles":[a,b],"indices":[t[a],t[b]],"positions":[t[a].map(|i|p[i]),t[b].map(|i|p[i])],"working":raw,"f32":rounded})).collect::<Vec<_>>()
            })
        )?
    );
    Ok(())
}
#[cfg(not(all(feature = "serde", feature = "sfcc-profile")))]
fn main() {
    panic!("requires serde,sfcc-profile");
}
