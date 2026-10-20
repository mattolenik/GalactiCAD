//! Bounded, opt-in observations for diagnostic builds. Never evaluates geometry.
//! The limit counts events, not bytes; mesh payload follows the existing cell budget.
//! Any dropped event makes attribution incomplete. Exact audits belong after capture.
use super::octree::SfccCell;
use crate::math::grid::SfccLattice;
use std::cell::RefCell;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CellId(pub u32, pub i64, pub i64, pub i64);
impl From<&SfccCell> for CellId {
    fn from(c: &SfccCell) -> Self {
        Self(c.level, c.ix, c.iy, c.iz)
    }
}
impl CellId {
    pub fn parent(self) -> Option<Self> {
        (self.0 > 0).then(|| Self(self.0 - 1, self.1 >> 1, self.2 >> 1, self.3 >> 1))
    }
}

#[derive(Clone, Debug)]
pub enum Event {
    Export {
        parent: usize,
    },
    Features {
        stage: &'static str,
        strata: usize,
        adjacent_strata: Vec<[usize; 2]>,
    },
    Octree {
        cell: CellId,
        kind: &'static str,
    },
    /// First executed top-level decision; predicate replay is separate evidence.
    Decision {
        cell: CellId,
        reason: &'static str,
        owner: Option<usize>,
        split: bool,
        curve: i64,
        corner: i64,
    },
    /// Actual subdivision, including balance ripple; not a decision attempt.
    Split {
        cell: CellId,
        balance: bool,
    },
    Mesh {
        cell: SfccCell,
        kind: &'static str,
        fallback: bool,
        triangles: Vec<[[f64; 3]; 3]>,
    },
    Round {
        lattice: SfccLattice,
        leaves: usize,
        degenerate: usize,
        failed: usize,
        failed_degenerate: usize,
        fallbacks: usize,
        final_round: bool,
    },
    /// Union of degenerate and failed cells, with membership flags; one per cell.
    Unresolved {
        cell: SfccCell,
        failed: bool,
    },
}
#[derive(Clone, Debug)]
pub struct Record {
    pub export: usize,
    pub round: u32,
    pub event: Event,
}
#[derive(Clone, Debug)]
pub struct Trace {
    pub label: String,
    pub records: Vec<Record>,
    pub dropped: usize,
}
struct State {
    trace: Trace,
    budget: usize,
    next_export: usize,
    export: usize,
    round: u32,
    reason: Option<(&'static str, Option<usize>)>,
}
thread_local! { static STATE: RefCell<Option<State>> = const { RefCell::new(None) }; }
struct Restore(Option<State>);
impl Drop for Restore {
    fn drop(&mut self) {
        STATE.with(|s| *s.borrow_mut() = self.0.take());
    }
}
/// Isolates nested captures and restores state even when the closure panics.
pub fn capture<T>(label: &str, budget: usize, f: impl FnOnce() -> T) -> (T, Trace) {
    let prior = STATE.with(|s| {
        s.replace(Some(State {
            trace: Trace {
                label: label.to_owned(),
                records: Vec::new(),
                dropped: 0,
            },
            budget,
            next_export: 0,
            export: 0,
            round: 0,
            reason: None,
        }))
    });
    let _restore = Restore(prior);
    let result = f();
    let trace = STATE.with(|s| {
        s.borrow_mut()
            .take()
            .expect("active diagnostic capture")
            .trace
    });
    (result, trace)
}
pub(crate) struct ExportScope(Option<(usize, u32)>);
impl ExportScope {
    pub(crate) fn begin() -> Self {
        let scope = Self(STATE.with(|s| {
            s.borrow_mut().as_mut().map(|s| {
                let previous = (s.export, s.round);
                s.next_export += 1;
                s.export = s.next_export;
                s.round = 0;
                previous
            })
        }));
        if let Some((parent, _)) = scope.0 {
            push(Event::Export { parent });
        }
        scope
    }
}
impl Drop for ExportScope {
    fn drop(&mut self) {
        if let Some((export, round)) = self.0 {
            STATE.with(|s| {
                if let Some(s) = s.borrow_mut().as_mut() {
                    s.export = export;
                    s.round = round;
                }
            });
        }
    }
}
pub(crate) fn round(round: u32) {
    STATE.with(|s| {
        if let Some(s) = s.borrow_mut().as_mut() {
            s.round = round;
        }
    });
}
pub(crate) fn push(event: Event) {
    STATE.with(|s| {
        if let Some(s) = s.borrow_mut().as_mut() {
            if s.trace.records.len() < s.budget {
                s.trace.records.push(Record {
                    export: s.export,
                    round: s.round,
                    event,
                });
            } else {
                s.trace.dropped += 1;
            }
        }
    });
}
pub(crate) fn start_decision() {
    STATE.with(|s| {
        if let Some(s) = s.borrow_mut().as_mut() {
            s.reason = None;
        }
    });
}
pub(crate) fn reason(reason: &'static str, owner: Option<usize>) {
    STATE.with(|s| {
        if let Some(s) = s.borrow_mut().as_mut() {
            if s.reason.is_none() {
                s.reason = Some((reason, owner));
            }
        }
    });
}
pub(crate) fn decision(
    cell: &SfccCell,
    reason: &'static str,
    split: bool,
    curve: i64,
    corner: i64,
) {
    let (reason, owner) = STATE
        .with(|s| s.borrow().as_ref().and_then(|s| s.reason))
        .unwrap_or((reason, None));
    push(Event::Decision {
        cell: cell.into(),
        reason,
        owner,
        split,
        curve,
        corner,
    });
}
pub(crate) fn snapshot(
    lat: SfccLattice,
    leaves: &[SfccCell],
    failed: &[SfccCell],
    fallbacks: usize,
    final_round: bool,
) {
    let active = STATE.with(|s| s.borrow().is_some());
    if !active {
        return;
    }
    let failed_ids: std::collections::HashSet<_> = failed.iter().map(CellId::from).collect();
    push(Event::Round {
        lattice: lat,
        leaves: leaves.len(),
        degenerate: leaves.iter().filter(|c| c.degenerate).count(),
        failed: failed.len(),
        failed_degenerate: failed.iter().filter(|c| c.degenerate).count(),
        fallbacks,
        final_round,
    });
    for c in leaves {
        let failed = failed_ids.contains(&CellId::from(c));
        if c.degenerate || failed {
            push(Event::Unresolved { cell: *c, failed });
        }
    }
}

/// Pre-assembly geometry preserves a cell origin even after output compaction.
pub(crate) fn mesh(
    cell: &SfccCell,
    points: &super::point_table::PointTable,
    tris: &[usize],
    kind: &'static str,
    fallback: bool,
) {
    if !payload_available() {
        return;
    }
    let triangles = tris
        .chunks_exact(3)
        .map(|t| std::array::from_fn(|i| [points.x(t[i]), points.y(t[i]), points.z(t[i])]))
        .collect();
    push(Event::Mesh {
        cell: *cell,
        kind,
        fallback,
        triangles,
    });
}

pub(crate) fn payload_available() -> bool {
    STATE.with(|s| match s.borrow_mut().as_mut() {
        Some(s) if s.trace.records.len() < s.budget => true,
        Some(s) => {
            s.trace.dropped += 1;
            false
        }
        None => false,
    })
}
pub(crate) fn features(
    stage: &'static str,
    strata: usize,
    curves: &[super::feature_curves::FeatureCurve],
) {
    if !payload_available() {
        return;
    }
    push(Event::Features {
        stage,
        strata,
        adjacent_strata: curves.iter().map(|c| c.adjacent_strata).collect(),
    });
}

/// Post-capture audit of represented coordinates using exact projected predicates.
/// This increments predicate counters: call after export/counter comparisons,
/// never from runtime observation hooks. Audit f64 and f32-rounded points separately.
pub fn triangle_exactly_degenerate(p: [[f64; 3]; 3]) -> bool {
    p.iter().flatten().all(|v| v.is_finite())
        && [(0, 1), (1, 2), (2, 0)].iter().all(|&(x, y)| {
            let [a, b, c] = p.map(|v| [v[x], v[y]]);
            super::predicates::orient2d(a, b, c) == 0
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_degenerate_cells_count_once_and_attempts_stay_separate() {
        let lat = crate::math::grid::make_lattice(1, 0., 0., 0., 1.);
        let a = SfccCell {
            level: 1,
            ix: 0,
            iy: 0,
            iz: 0,
            key: 0,
            degenerate: true,
            feature_curve: -1,
            feature_corner: -1,
        };
        let b = SfccCell {
            ix: 1,
            key: 1,
            degenerate: false,
            ..a
        };
        let (_, trace) = capture("overlap", 10, || {
            let _scope = ExportScope::begin();
            decision(&a, "attempt", true, -1, -1);
            decision(&a, "attempt", true, -1, -1);
            snapshot(lat, &[a, b], &[a, b], 0, true);
        });
        assert_eq!(trace.dropped, 0);
        assert_eq!(
            trace
                .records
                .iter()
                .filter(|r| matches!(r.event, Event::Decision { .. }))
                .count(),
            2
        );
        assert_eq!(
            trace
                .records
                .iter()
                .filter(|r| matches!(r.event, Event::Unresolved { failed: true, .. }))
                .count(),
            2
        );
        assert!(trace.records.iter().any(|r| matches!(
            r.event,
            Event::Round {
                degenerate: 1,
                failed: 2,
                failed_degenerate: 1,
                ..
            }
        )));
    }
}
