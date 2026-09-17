//! Audit preservation of the compiled feature graph. This cannot detect a
//! feature omitted by compilation; independent expected-arc tests remain needed.
use super::{feature_set::SfccFeatureSet, point_table::PointTable};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, PartialEq)]
pub struct FeatureChainIssue {
    pub curve_id: usize,
    pub kind: &'static str,
    pub range: [f64; 2],
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct FeatureChainReport {
    pub issues: Vec<FeatureChainIssue>,
    pub missing_edges: usize,
    pub missing_curves: usize,
    pub disconnected_curves: usize,
    pub interval_gaps: usize,
    pub off_curve_edges: usize,
    pub invalid_memberships: usize,
    pub unidentified_edges: usize,
}
impl FeatureChainReport {
    pub fn to_json(&self) -> String {
        let issues = self
            .issues
            .iter()
            .map(|issue| {
                format!(
                    "{{\"curveId\":{},\"kind\":\"{}\",\"range\":{:?}}}",
                    issue.curve_id, issue.kind, issue.range
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        format!(
            concat!("{{\"issues\":[{}],\"status\":\"{}\",\"scope\":\"compiledCurves\",",
            "\"missingEdges\":{},\"missingCurves\":{},\"disconnectedCurves\":{},",
            "\"intervalGaps\":{},\"offCurveEdges\":{},\"invalidMemberships\":{},\"unidentifiedEdges\":{}}}"),
            issues,
            if self.passed() { "passed" } else { "failed" },
            self.missing_edges,
            self.missing_curves,
            self.disconnected_curves,
            self.interval_gaps,
            self.off_curve_edges,
            self.invalid_memberships,
            self.unidentified_edges
        )
    }
    pub fn passed(&self) -> bool {
        self.missing_edges
            + self.missing_curves
            + self.disconnected_curves
            + self.interval_gaps
            + self.off_curve_edges
            + self.invalid_memberships
            + self.unidentified_edges
            == 0
    }
}

/// Check actual triangle edges and the f32 coordinates shipped by compaction.
/// Retired subdivision parents are absent from the point table's memberships;
/// edges removed by cleanup are retained there and reported as missing here.
pub fn audit_feature_chains(
    points: &PointTable,
    tris: &[usize],
    features: &SfccFeatureSet,
    tolerance: f64,
) -> FeatureChainReport {
    let mut report = FeatureChainReport::default();
    let key = |a: usize, b: usize| (a.min(b), a.max(b));
    let edges: BTreeSet<_> =
        tris.chunks_exact(3).flat_map(|t| (0..3).map(move |k| key(t[k], t[(k + 1) % 3]))).collect();
    let position = |id| [points.x(id) as f32 as f64, points.y(id) as f32 as f64, points.z(id) as f32 as f64];
    let distance = |p: [f64; 3], q: [f64; 3]| (0..3).map(|k| (p[k] - q[k]).powi(2)).sum::<f64>().sqrt();
    let mut by_curve = BTreeMap::<usize, Vec<(usize, usize, f64, f64)>>::new();
    for (a, b) in points.protected_edges() {
        if edges.contains(&(a, b)) && points.curve_intervals(a, b).is_empty() {
            report.unidentified_edges += 1;
        }
    }
    for ((a, b), memberships) in points.identified_edges() {
        if !edges.contains(&(a, b)) {
            report.missing_edges += 1;
            for i in memberships {
                report.issues.push(FeatureChainIssue {
                    curve_id: i.curve_id,
                    kind: "removedEdge",
                    range: [i.start.min(i.end), i.start.max(i.end)],
                });
            }
            continue;
        }
        let pa = position(a);
        let pb = position(b);
        for interval in memberships {
            let Some(curve) = features.curves.get(interval.curve_id) else {
                report.invalid_memberships += 1;
                continue;
            };
            let (lo, hi) = (interval.start.min(interval.end), interval.start.max(interval.end));
            if !lo.is_finite()
                || !hi.is_finite()
                || lo == hi
                || if let Some(wrap) = curve.param_wrap {
                    hi - lo > wrap + 1e-10
                } else {
                    lo < curve.t_min - 1e-10 || hi > curve.t_max + 1e-10
                }
            {
                report.invalid_memberships += 1;
                continue;
            }
            let on_curve = [0., 0.25, 0.5, 0.75, 1.].into_iter().all(|u| {
                let t = interval.start + (interval.end - interval.start) * u;
                curve.point_at_checked(t).is_some_and(|p| {
                    let d: [f64; 3] = std::array::from_fn(|k| pb[k] - pa[k]);
                    let length2 = d.iter().map(|v| v * v).sum::<f64>();
                    let v = if length2 > 0. {
                        ((0..3).map(|k| (p[k] - pa[k]) * d[k]).sum::<f64>() / length2).clamp(0., 1.)
                    } else {
                        0.
                    };
                    let closest = std::array::from_fn(|k| pa[k] + v * d[k]);
                    let chord = std::array::from_fn(|k| pa[k] * (1. - u) + pb[k] * u);
                    distance(p, closest) <= tolerance
                        && curve
                            .project_interval(chord, interval.start, interval.end)
                            .is_some_and(|(_, q)| distance(q, chord) <= tolerance)
                })
            });
            if !on_curve {
                report.off_curve_edges += 1;
                report.issues.push(FeatureChainIssue {
                    curve_id: curve.id,
                    kind: "offCurve",
                    range: [lo, hi],
                });
            }
            by_curve.entry(interval.curve_id).or_default().push((a, b, lo, hi));
        }
    }
    for curve in &features.curves {
        let Some(chain) = by_curve.get(&curve.id) else {
            report.missing_curves += 1;
            report.issues.push(FeatureChainIssue {
                curve_id: curve.id,
                kind: "missingCurve",
                range: [curve.t_min, curve.t_max],
            });
            continue;
        };
        let mut adjacency = BTreeMap::<usize, BTreeSet<usize>>::new();
        let mut spans = Vec::new();
        for &(a, b, lo, hi) in chain {
            adjacency.entry(a).or_default().insert(b);
            adjacency.entry(b).or_default().insert(a);
            if let Some(wrap) = curve.param_wrap {
                let start = curve.t_min + (lo - curve.t_min).rem_euclid(wrap);
                let end = start + hi - lo;
                spans.push((start, end.min(curve.t_min + wrap)));
                if end > curve.t_min + wrap {
                    spans.push((curve.t_min, end - wrap));
                }
            } else {
                spans.push((lo, hi));
            }
        }
        let mut seen = BTreeSet::new();
        let mut stack = vec![chain[0].0];
        while let Some(id) = stack.pop() {
            if seen.insert(id) {
                stack.extend(&adjacency[&id]);
            }
        }
        let endpoints = adjacency.values().filter(|v| v.len() == 1).count();
        if seen.len() != adjacency.len()
            || adjacency.values().any(|v| v.len() > 2)
            || if curve.closed { endpoints != 0 } else { endpoints != 2 }
        {
            report.disconnected_curves += 1;
            report.issues.push(FeatureChainIssue {
                curve_id: curve.id,
                kind: "disconnected",
                range: [curve.t_min, curve.t_max],
            });
        }
        spans.sort_by(|a, b| a.0.total_cmp(&b.0));
        let eps = (curve.t_max - curve.t_min).abs().max(1.) * 1e-9;
        let mut end = curve.t_min;
        for (a, b) in spans {
            if a > end + eps {
                report.interval_gaps += 1;
                report.issues.push(FeatureChainIssue {
                    curve_id: curve.id,
                    kind: "parameterGap",
                    range: [end, a],
                });
            }
            end = end.max(b);
        }
        let target = curve.param_wrap.map_or(curve.t_max, |w| curve.t_min + w);
        if end < target - eps {
            report.interval_gaps += 1;
            report.issues.push(FeatureChainIssue {
                curve_id: curve.id,
                kind: "parameterGap",
                range: [end, target],
            });
        }
    }
    report.issues.sort_by(|a, b| {
        a.curve_id
            .cmp(&b.curve_id)
            .then(a.kind.cmp(b.kind))
            .then(a.range[0].total_cmp(&b.range[0]))
            .then(a.range[1].total_cmp(&b.range[1]))
    });
    report
}
