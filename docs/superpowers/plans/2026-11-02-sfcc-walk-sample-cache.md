# SFCC Walk-Sample Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the octree build's decision time by caching the field values that the multi-sheet edge walk samples, with a byte-identical mesh.

**Architecture:** `sheet_decision` (refine_criteria.rs) walks all 12 edges of every candidate cell at the finest lattice spacing through `SampleView::sample_at`. That view is read-only, so every walk point not already cached is re-evaluated with `tree.f`. On the edited bowl at depth 8 that is 16.9M evaluations for 4.2M distinct points (19.7 s of the 20.9 s decide). The plan adds a second, value-only map `walked` to `Sampler`. `SampleView` fills it on a miss. `Sampler::sample_at` (used by apply-pass seeding, cell creation and contouring) reads it before evaluating. The presence map `samples`, which face contouring and hanging-node detection observe through `has_sample_key`, is written exactly as today, so contouring sees the same sample keys and the mesh cannot change.

**Tech Stack:** Rust (gcad-kernel crate), `cargo test`, wasm via `make build`.

**Spec:** this conversation's measurements (decide 20.9 s, of which `sheet_decision` is 19.7 s; walk samples 16.9M, unique 4.2M; apply 5.2 s), plus [docs/feat/sfcc/multi-sheet-cells.md](../../feat/sfcc/multi-sheet-cells.md) for the walk itself.

## Global Constraints

- The exported mesh must be byte-identical with and without the cache (same tris and verts).
- `has_sample_key` and the `samples` map must change only where they change today. A walk value never makes a key "present".
- No new dependencies. Unix line endings. No files at the repo root; scratch goes in `.agents/tmp/`.
- The serial path (`build_octree`, which backs the browser's default `export_sfcc`) is the target. `decide_partition` / `ResumableOctreeBuild` (only reached through the unused `sfcc_decide_partition` export and the `sfccPartitions` flag) stay as they are.

## Review Focus

- **Hanging-node presence:** a walk miss must not insert into `samples`. Task 1's test extends the existing `retained_value_tests` assertion to the walk path.
- **Value identity:** a value served from `walked` must be bit-identical to `tree.f` at that point (same `tree` reference in `Sampler` and `SampleView`). Task 1 asserts `to_bits()` equality.
- **Memory in wasm:** `walked` reaches about 4.2M entries on the bowl (~100 MB as `HashMap<i64, f64>`). It must be dropped when the build finishes, before contouring. Task 1 frees it in `finalize`, and Task 2 records the peak size in the measurement.
- **Retained values across re-refine rounds:** `Sampler::sample_at` must still prefer `samples`, then `retained`, then `walked`, and insert into `samples` in every case, exactly as today.
- **Parity fixtures:** with multi-sheet off, nothing misses the view, so `walked` stays empty and every parity test is unaffected. Task 2 runs the full suite to confirm.

---

### Task 1: Value-only walk cache in `Sampler` / `SampleView`

**Files:**
- Modify: `gcad-wasm/kernel/src/sfcc/octree.rs`:
  - `Sampler` struct and `Sampler::new` (~68–100)
  - `SampleView` (~107–126)
  - the decide-section view construction (~796)
  - `ResumableOctreeBuild`'s two `Sampler { .. }` literals (~916, ~944)
  - the test view literal (~1314)
  - `Builder::finalize` (~647)
- Test: the `retained_value_tests` module in `gcad-wasm/kernel/src/sfcc/octree.rs` (~1299)

**Interfaces:**
- Produces:
  - field `Sampler::walked: RefCell<HashMap<i64, f64>>`, empty at construction;
  - field `SampleView::walked: &'a RefCell<HashMap<i64, f64>>`;
  - `SampleView::sample_at` keeps its signature.

- [ ] **Step 0: Record the baseline before any edit** (Task 2 compares against it)

The bowl JSON is `.agents/tmp/user-bowl.json`. If it is missing, regenerate it with `node --import tsx .agents/tmp/dump-user-bowl.mts <capture source .gcad> .agents/tmp/user-bowl.json`.

```bash
BOWL_JSON=$PWD/.agents/tmp/user-bowl.json BOWL_MULTI=1 BOWL_DEPTH=8 BOWL_SAVE=walk-before \
  cargo test --manifest-path gcad-wasm/Cargo.toml --release -p gcad-kernel --features serde \
  --test bowl_exact bowl_exact_holes -- --ignored --nocapture | grep -E "exact bowl|phases|normals"
```

Expected: `tris=112202`, `decide≈20900`, `apply≈5200`. Keep the printed lines.

- [ ] **Step 1: Write the failing test** in `retained_value_tests`:

```rust
#[test]
fn walk_misses_are_cached_without_marking_presence() {
    let tree = crate::sdf::leaf_at(crate::sdf::Shape::Sphere { r: 2. }, [0.; 3]);
    let lat = crate::math::grid::make_lattice(4, -4., -4., -4., 8.);
    let key = pack_point(&lat, 5, 6, 7);
    let sampler = Sampler::new(&tree, &lat);
    let w = point_to_world(&lat, 5, 6, 7);
    let expected = tree.f([w[0], w[1], w[2]]);
    {
        let samples = sampler.samples.borrow();
        let view = SampleView { tree: &tree, lat: &lat, samples: &samples, walked: &sampler.walked };
        assert_eq!(view.sample_at(5, 6, 7).to_bits(), expected.to_bits());
        assert_eq!(view.sample_at(5, 6, 7).to_bits(), expected.to_bits());
    }
    assert_eq!(sampler.walked.borrow().get(&key).map(|v| v.to_bits()), Some(expected.to_bits()));
    assert!(!sampler.has_sample_key(key), "a walk miss must not mark a hanging node");
    assert_eq!(sampler.sample_at(5, 6, 7).to_bits(), expected.to_bits());
    assert!(sampler.has_sample_key(key), "seeding still inserts into the presence map");
}
```

Also add `walked: &next.walked` to the existing test's `SampleView` literal (~1314).

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cargo test --manifest-path gcad-wasm/Cargo.toml --release -p gcad-kernel --lib walk_misses_are_cached`
Expected: compile error, because `SampleView` has no field `walked`.

- [ ] **Step 3: Implement**
  - Add `walked` to `Sampler` and initialize it to `RefCell::new(HashMap::new())` at all three construction sites (`new`, ~916, ~944).
  - `Sampler::sample_at` lookup order becomes `samples` → `retained` → `walked` → `tree.f`. It still inserts into `samples` in every case.
  - `SampleView::sample_at` lookup order becomes `samples` → `walked` → `tree.f`. On the `tree.f` path it inserts into `walked` only.
  - Pass `walked: &b.sampler.walked` at the decide-section view (~796). The `samples` borrow and the `walked` borrow are separate `RefCell`s, so they don't conflict.
  - In `finalize`, set `*self.sampler.walked.get_mut() = HashMap::new();` before moving the sampler into `SfccOctree`. Assigning a fresh map, rather than calling `clear`, also releases the capacity.
  - Update the `SampleView` doc comment, which currently says it is "a pure read": misses now fill the value-only walk cache, and the presence map is never written.

- [ ] **Step 4: Run the octree tests and confirm they pass**

Run: `cargo test --manifest-path gcad-wasm/Cargo.toml --release -p gcad-kernel --lib sfcc::octree`
Expected: all pass, including `walk_misses_are_cached_without_marking_presence` and `old_values_do_not_create_current_round_hanging_nodes`.

- [ ] **Step 5: Commit**

```bash
git add gcad-wasm/kernel/src/sfcc/octree.rs
git commit -m "SFCC: cache multi-sheet walk samples in a value-only map"
```

### Task 2: Prove identity and the speed-up, then document

**Files:**
- Modify: `docs/feat/sfcc/multi-sheet-cells.md`: the last bullet of "Limits" ("Detection walks 12·stride samples … evaluated directly, not cached"), plus one line under "Measured".
- Modify: `docs/sfcc-performance-analysis.md`: one paragraph with the before/after decide and apply times.

**Interfaces:**
- Consumes: Task 1's `Sampler::walked`.

- [ ] **Step 1: Re-run Task 1 Step 0's command with Task 1 applied, using `BOWL_SAVE=walk-after`**

Expected:
- `tris=112202`;
- identical `normals` lines;
- `decide` at or below about 7000 ms (16.9M walk evaluations collapse to at most 4.2M);
- `apply` lower than the baseline, because seeding now reads `walked`.

- [ ] **Step 2: Check that the meshes are byte-identical**

Run: `cmp .agents/tmp/bowl-dwalk-before.verts.f32 .agents/tmp/bowl-dwalk-after.verts.f32 && cmp .agents/tmp/bowl-dwalk-before.tris.u32 .agents/tmp/bowl-dwalk-after.tris.u32 && echo identical`
Expected: `identical`. Any difference is a bug in Task 1, because the cache must not change values or presence. Stop and fix it before continuing.

- [ ] **Step 3: Run the full kernel suite**

Run: `cargo test --manifest-path gcad-wasm/Cargo.toml --release -p gcad-kernel --features serde --no-fail-fast 2>&1 | grep -E "FAILED|test result: FAILED"`
Expected: only the two pre-existing failures, `mesh_loft_matches_ts` and `mixed_opaque_controls_preserve_legacy_refinement_without_widening_blend_operands`. `thin_sheet` still passes, with the tapered-box count unchanged at 8,170.

- [ ] **Step 4: Run `make build`, then time the wasm path**

```bash
make build BROWSERS_DIR=/Users/matt/gcad/galacticad/.browsers
node --import tsx .agents/tmp/wasm-export.mts .agents/tmp/user-bowl.json /Users/matt/gcad/galacticad/.agents/tmp/user-capture2.yaml walk-wasm
```

Expected: build exit 0. The export prints `"tris":1692` and a lower `ms` than the 87,522 ms baseline.

- [ ] **Step 5: Update the two docs with the measured numbers from Steps 1 and 4, then commit**

```bash
git add docs/feat/sfcc/multi-sheet-cells.md docs/sfcc-performance-analysis.md
git commit -m "docs: walk-sample cache measurements"
```
