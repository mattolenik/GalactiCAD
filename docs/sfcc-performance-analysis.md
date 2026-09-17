# SFCC performance analysis

September 9, 2026. Kernel revision `e090f2bed4a8cfd8d5cf965123120e6fdd89ace2`; only the native benchmark's reporting was changed for this investigation. All experimental quality options remain off by default.

The default exporter and the experimental quality path have different bottlenecks. Default housing export spends most of its time deciding octree refinement, compiling features, and contouring. The experimental path adds expensive carrier discovery, repeated surface validation, and exact intersection checks. Optimizing polygon triangulation alone would miss much of this cost.

## Scope and measurement method

This report combines fresh native release measurements, stack sampling, and a source audit of the Rust kernel and its browser worker orchestration. It does not measure preview rendering, GPU frame time, browser responsiveness, or worker scaling. The native runner invokes the existing SFCC kernel; no additional scene evaluator was introduced.

- Host: Apple M1 Max, 64 GiB RAM, ARM64, macOS 26.5.1 (25F80).
- Compiler: rustc 1.96.0 (`ac68faa20`, May 25, 2026). Workspace release settings: optimization level 3, LTO, one codegen unit.
- Scenes: the current `docs/manim/scenes/torture_housing.yaml` and `torture_bracket.yaml`. Serialized inputs were checked byte-for-byte against fresh serialization of these sources.
- Each scene/configuration runs in a separate process: one excluded warmup, then three measured exports. Configurations run sequentially; no concurrent benchmark or build was launched during the measurements. Background system activity and thermal state were not controlled.
- Modes: **baseline** (default algorithm); **audit** (default algorithm plus final quality audit); **all** (quality triangulation, refinement, remeshing, and their mandatory final audit).
- All modes use identical default kernel tolerances: depth 5–8, 2 mm bounds padding, 0.01 mm surface tolerance, 0.02 mm curve chord tolerance, and at most two recovery rounds. The quality edit budget is 10,000 proposals.
- Timing encloses the native pipeline call and its small reporting overhead. It excludes source execution, bridge JSON parsing/tree construction, process startup, compilation, and browser/WASM transfer and display costs. Final mesh buffers, validation, feature-edge extraction, and kernel cleanup are included. It is therefore a kernel export measurement, not click-to-displayed-mesh latency.
- Phase buckets accumulate over recovery rounds. Their independently computed medians need not sum exactly to the median total. Progress intervals give additional assembly detail, with the boundaries described below.

The [measurement data](sfcc-performance-measurements.json) retain every warmup and measured result, phase timestamps, geometry/validation counters, input hashes, and condensed sampling evidence. Three repeats support bottleneck diagnosis, not confidence intervals or a complete performance acceptance matrix.

## Measured results

| Scene / mode | Median total | Measured range | Triangles | Vertex + triangle buffers |
|---|---:|---:|---:|---:|
| housing / baseline | 23.550 s | 23.544–23.559 s | 128946 | 3610232 B |
| housing / audit | 54.856 s | 54.798–55.277 s | 128946 | 3610232 B |
| housing / all | 104.862 s | 104.591–105.582 s | 115502 | 3233800 B |
| bracket / baseline | 16.864 s | 16.553–17.020 s | 91764 | 2569072 B |
| bracket / audit | 37.967 s | 37.038–38.722 s | 91764 | 2569072 B |
| bracket / all | 68.073 s | 64.476–68.200 s | 81262 | 2275016 B |

| Scene / mode | Features | Octree | Contour | Cell mesh | Assembly |
|---|---:|---:|---:|---:|---:|
| housing / baseline | 5.351 s | 10.607 s | 4.508 s | 1.253 s | 1.791 s |
| housing / audit | 5.516 s | 11.156 s | 4.734 s | 1.287 s | 32.211 s |
| housing / all | 5.468 s | 10.609 s | 4.645 s | 31.980 s | 52.817 s |
| bracket / baseline | 1.415 s | 9.357 s | 4.111 s | 1.046 s | 0.887 s |
| bracket / audit | 1.384 s | 9.909 s | 4.353 s | 1.108 s | 20.990 s |
| bracket / all | 1.359 s | 9.565 s | 4.222 s | 17.054 s | 35.398 s |

| Scene / mode | Octree decide | Octree apply | Recovery rounds | Repeated recovery work |
|---|---:|---:|---:|---:|
| housing / baseline | 10.223 s | 0.362 s | 1 | 8.172 s |
| housing / audit | 10.737 s | 0.385 s | 1 | 8.497 s |
| housing / all | 10.218 s | 0.368 s | 1 | 23.611 s |
| bracket / baseline | 9.075 s | 0.260 s | 1 | 7.227 s |
| bracket / audit | 9.603 s | 0.275 s | 1 | 7.642 s |
| bracket / all | 9.274 s | 0.268 s | 1 | 15.522 s |

| All-stages assembly interval | Housing | Bracket |
|---|---:|---:|
| Assembling mesh → next label | 0.124 s | 0.102 s |
| Optimizing patch diagonals → next label | 1.973 s | 1.106 s |
| Refining analytical patches → next label | 2.830 s | 1.032 s |
| Remeshing analytical patches → next label | 23.857 s | 19.188 s |
| Auditing final triangle geometry → next label | 23.313 s | 13.887 s |

The historical **4.49×** figure compares complete native kernel exports (24.042 s versus 107.949 s), with the additional audit enabled only in the experimental configuration. It is not a measurement of the triangulator alone. The fresh housing medians are 23.550 s baseline, 54.856 s audit-only, and 104.862 s all-stages: **4.45× overall**. Audit-only adds about 31.3 s to the default workload. The new configuration separates much of that additional checking cost from editing, although editing changes both the triangle count and the audit workload. Subtracting two whole-export medians is an incremental workload estimate, not an isolated function timer.

For default housing, octree work accounts for about 45% of the export, feature compilation 23%, contouring 19%, cell meshing 5%, and assembly 8%. The repeated recovery work is about 8.2 s, or 35% of the export. In all-stages mode, cell meshing rises to 31.980 s (about 25.5× its default bucket), while assembly rises to 52.817 s. Feature compilation, octree, and contour totals remain broadly comparable.

Default bracket export takes 16.864 s: about 56% octree work, 24% contouring, 8% feature compilation, 6% cell meshing, and 5% assembly. Its repeated recovery work is 7.227 s, about 43% of the export. Both scenes perform one recovery round. Octree decision work accounts for roughly 96–97% of their octree buckets; split application is only a few tenths of a second. Their final leaf counts are nearly identical (47,032 housing; 46,913 bracket), despite substantially different feature-compilation costs.

Bracket's all-stages median is 68.073 s, **4.04×** its default export. Audit-only adds about 21.1 s. Its cell-meshing and assembly medians rise to 17.054 s and 35.398 s, respectively. The all-stages measured range is wider than housing's (64.476–68.200 s); all samples are retained. All 24 exports completed, including the six excluded warmups, with identical triangle/buffer counts and complete validation JSON within each configuration. This consistency check does not claim byte-for-byte mesh-buffer comparison.

Housing's 10.4% triangle reduction does not translate to a broad shape-quality improvement: baseline geometry measured by audit-only has 2,468 slivers and a 3.933° p5 minimum angle; all-stages has 2,430 slivers and a 3.932° p5 angle. The latter run performs 1,253 collapses, 5,795 relocations, and 133 insertions and exhausts the optional work budget. Sampled geometry failures remain 584 versus 582, and contact reports remain 15,609 versus 15,538. These counters include projection/f32 failures and nonincident contacts, respectively; they are not certified geometric error bounds or independently confirmed penetration counts. A smaller total does not establish that no new local failures were introduced.

Bracket quality is mixed as well: triangles decrease from 91,764 to 81,262 (11.4%), and the p5 minimum angle improves from 4.289° to 4.643°, but extreme slivers increase from 949 to 1,052. Both modes report 52 sampled geometry failures; contact reports decrease from 1,387 to 732. The experimental remesher exhausts its optional work budget. Here a sliver means `2 × area / longestEdge² < 0.02`, and p5 is the fifth percentile of each triangle's minimum angle. Both scenes remain validation-incomplete.

### What the assembly intervals contain

The benchmark now records the existing progress callback, plus octree decide/apply totals and recovery counts. It does not insert timers into hot inner loops.

| Progress interval | Included work |
|---|---|
| Assembling mesh → Optimizing patch diagonals | Canonical ordering, debris and coincident-pair cleanup, initial quality statistics |
| Optimizing patch diagonals → Refining analytical patches | Global quality flips **and existing blend-surface refinement** |
| Refining analytical patches → Remeshing analytical patches | Analytical adaptive refinement |
| Remeshing analytical patches → Auditing final triangle geometry | Collapse, flip, and relocation sweeps |
| Auditing final triangle geometry → Done | Quality statistics, spatial index construction, sampled geometry and contact checks, mesh packing, manifold/feature-chain/vertex validation |

The last interval is an **audit and validation tail**, not a pure intersection timer. Feature-edge extraction and some cleanup occur after `Done`, before the measured pipeline call returns. In audit-only mode there are no editing-stage labels; legacy refinement precedes the final-audit label.

## Bottlenecks and causes

### 1. Recovery repeats substantial default work

In [`pipeline.rs`](../gcad-wasm/kernel/src/sfcc/pipeline.rs), failed cells and first-round fallback cells create forced refinement markers. Each recovery iteration calls `build_octree` again, creates a new point table, contours all faces, and meshes all cells. Feature compilation and some feature/coarse-query caches survive, but the octree's lattice-sample cache and face/point tables are rebuilt.

This is a correctness-preserving recovery design with a substantial repeated-work cost. Incremental repair could retain unaffected cells, samples, and faces and expand the dirty region through balance and shared-face dependencies. The measured second-round duration is an upper bound on the available saving: necessary local repair and balance propagation still have to run. Removing recovery or lowering its budget would change geometry and is not a performance fix.

### 2. Octree time is predominantly the decision work

[`PipelineContext::decide_cell`](../gcad-wasm/kernel/src/sfcc/pipeline.rs) performs feature classification, forced-marker tests, coarse-region pruning, and smooth-surface criteria. [`refine_criteria.rs`](../gcad-wasm/kernel/src/sfcc/refine_criteria.rs) queries nearby curves, checks six face planes per candidate, projects contained-curve candidates, gathers active strata at up to nine probes, and tests normals/crossings. Split application and balancing are measured separately.

There are already useful optimizations: lattice corner samples, successful curve/plane crossings, and coarse pruned scene queries are cached. Failed curve queries deliberately bypass the cache because suppressing their diagnostic side effects would change validation. Any additional cache must retain/replay those effects or make query diagnostics explicit.

Remaining source-level opportunities include sharing active-owner/probe results between criteria and retaining decisions for unchanged cells across recovery. Feature-grid queries allocate a box-key vector and a candidate set, then sort results; `classify_cell_features` sorts the already sorted curve IDs again. Removing that duplicate sort is straightforward, but it is not established as a major time consumer. Measure query counts, candidate counts, crossing-cache hit rates, and time per criterion before restructuring the entire index.

### 3. Analytical validation repeatedly traverses the scene

This affects feature compilation and experimental triangulation/editing. The relevant chain is [`quality_remesh::validate`](../gcad-wasm/kernel/src/sfcc/quality_remesh.rs) → [`Stratum::domain_contains`](../gcad-wasm/kernel/src/strata.rs) → [`FieldRef::surface_live`](../gcad-wasm/kernel/src/sfcc/field_branches.rs).

`surface_live` checks the field at every ancestor along the owning path. Each ancestor check independently evaluates its subtree. The caller then often evaluates the final tree again at the same point. This preserves the essential rule that a later subtraction must not expose a carrier hidden by an earlier union, but it repeats overlapping computations.

There is another specific inefficiency in both `sample_tree` and `sample_pruned`: hard min/max selection calls `a.f(p)` and `b.f(p)` inside the comparison function. Selecting among `k` children makes `k−1` comparisons and can evaluate the incumbent subtree repeatedly. After selection, the winning path is evaluated again for its raw derivative. Deeply nested operations magnify the repeated subtree work.

A separate five-second bracket default warmup sample spans octree and contour work. Among 866 main-thread samples, the exclusive summary contains 147 in `polygon_dist_2d`, 129 in `Leaf::f`, and 90 in `hypot`, with carrier-pair projection and field/normal evaluation also visible. This supports reducing repeated geometric queries in the default path too; it does not isolate the exact saving from any proposed cache.

Recommended direction: a per-query evaluation context containing scalar values, selected children, raw derivatives, and ancestor-survival results, with lazy derivative evaluation where appropriate. Start with caching the selected scalar value during min/max selection. Preserve `total_cmp` ordering, ties, signed zero, operand order, nested smooth-operation semantics, and raw gradient magnitudes. Cache by exact query coordinates and scene revision; spatial quantization is not safe at these seams. Ownership checks must remain in place.

### 4. Experimental cell meshing searches carriers and validates candidates repeatedly

[`triangulate_loop`](../gcad-wasm/kernel/src/sfcc/cell_mesh.rs) scans eligible entries in the full `features.strata` array to discover an owner. It screens boundary points, projects them, and checks their domains. [`surface_patch::disk`](../gcad-wasm/kernel/src/sfcc/surface_patch.rs) then checks the boundary again, constructs a chart/triangulation, and checks 13 samples per triangle plus projected f32 geometry. Quads evaluate both diagonals. A failed strict attempt can repeat the operation with an eight-times-larger coarse-candidate tolerance before mandatory refinement.

Per-cell scene pruning is already enabled for sufficiently large trees in this path. It reduces scene queries passed through `SdfQuery`, but does not automatically prune a carrier's independent ancestry/domain checks. More blanket pruning is therefore not a complete solution.

The experimental bracket warmup sample confirms this distinction. A ten-second window started during cell meshing captured 1,731 main-thread samples. One prominent call-graph branch contains 640 samples under `surface_patch::disk`, of which 633 descend into `FieldRef::surface_live`. The exclusive summary is led by `Leaf::f` (447), polygon distance (286), `CsgNode::f` (217), and `hypot` (214). These are window-specific counts, with some octree work also captured; the 640/633 figures describe one call site, not totals over every invocation. They directly support optimizing exposure evaluation rather than assuming ear clipping is the dominant cell cost.

Propagate candidate carrier identities from face/feature construction, or build a conservative carrier candidate index with the existing search as fallback. Reuse chart construction, boundary projection, and sample results across strict/coarse attempts without reusing a tolerance-dependent acceptance verdict. Known planar patches may admit cheaper exact geometric checks, but exposure within the enclosing CSG tree still needs verification.

### 5. Exact contact checks have an allocation-heavy fallback

The final audit in [`assembly.rs`](../gcad-wasm/kernel/src/sfcc/assembly.rs) checks every triangle's sampled geometry and queries nearby triangles for f64/f32 contact. The spatial broad phase already exists; this is not a naive all-pairs loop.

A 10-second, 5 ms-interval stack sample during the excluded housing audit warmup captured 1,743 main-thread samples. The call graph places exact predicate arithmetic and allocator activity beneath `assembly::finish` → `mesh_edit::intersects`/`coplanar`. The exclusive top-of-stack summary includes 340 samples in `_xzm_free`, 181 in `_xzm_xzone_malloc`, 177 in `Dyadic::add`, and 122 in `_free`. These are samples within one audit window, not percentages of an entire export or allocation counts.

[`predicates.rs`](../gcad-wasm/kernel/src/sfcc/predicates.rs) stores every exact dyadic integer in a `Vec<u64>`. Conversion, shifts, subtraction/cloning, addition, and multiplication allocate temporary vectors. Coplanar faces and shared vertices produce exact-zero determinants, which correctly fall through the floating-point filter to this expensive path.

Highest-confidence improvements here:

- Add proven exact-zero shortcuts for repeated input points and structurally axis-aligned coplanarity. A rounded floating-point determinant of zero alone is not a proof.
- Use inline storage or reusable scratch for the common small exact integers, retaining an exact overflow/extreme-exponent fallback. Measure fallback frequency and limb-size distribution first.
- Reuse repeated orientation results within a triangle-pair test and avoid duplicate f32 work only when the corresponding representations are identical.
- Preserve checks for coplanar overlap, T-junctions, and shared-edge foldovers; simply skipping adjacent triangles would be incorrect.

Field evaluation also appears in this sample, including polygon distance evaluation. Exact arithmetic is a demonstrated hotspot, not the sole audit cost.

### 6. Global edits rebuild bookkeeping and revalidate unchanged neighborhoods

[`adaptive_refine.rs`](../gcad-wasm/kernel/src/sfcc/adaptive_refine.rs) rebuilds geometry, adjacency, a triangle spatial index, and an error queue in up to eight rounds. [`quality_remesh.rs`](../gcad-wasm/kernel/src/sfcc/quality_remesh.rs) rebuilds edge/star/neighbor maps and indexes across its three sweeps and embedded flip passes. Proposals validate whole affected stars at both f64 and f32 precision, with 13 samples per triangle per representation.

The code already batches appended triangles into `GrowingIndex`, updates moved triangle bounds, and avoids cloning the complete removed-triangle set per collapse. Further improvements should maintain adjacency and error/acceptance caches with explicit vertex/triangle versions, and process dirty neighborhoods. Preserve deterministic candidate order: previous worker parity work established that even neighbor summation order matters.

The edit budget bounds some proposal work, not total runtime. Full scans, initial/global flips, refinement, index construction, and mandatory final validation still run. Reaching the budget therefore does not imply a fixed-time export.

### 7. Feature compilation is no longer safely described as cheap

[`compile_feature_set`](../gcad-wasm/kernel/src/sfcc/feature_set.rs) compiles native features, traces ordinary/chamfer/branch carrier pairs, trims and wires the results, and constructs the feature index. [`trace_all_seams`](../gcad-wasm/kernel/src/sfcc/seam_trace.rs) enumerates leaf pairs before overlap rejection; carrier-pair tracing uses a three-dimensional seed grid and linear seed deduplication. These can scale poorly with overlapping operands and complex generated carriers.

Potential improvements are conservative pair broad phases, spatial seed deduplication, and reusable compiled features for unchanged scene/tolerance inputs. Do not replace feature discovery with a performance heuristic that can silently miss branches. Instrument pair counts, rejected pairs, seed projections, trim cost, and per-operator compilation cost to distinguish enumeration overhead from actual tracing.

## Parallelism and memory

The browser path in [`sfcc-rs-exporter.mts`](../src/export/sfcc-rs/sfcc-rs-exporter.mts) defaults to one WASM instance. With `sfccPartitions=N`, it calls serial `sfcc_worker_prepare`, meshes partitions in a warm worker pool, and merges serially. The kernel exposes a resumable/partitioned octree-decision API, but this exporter does not wire it into that path. Merely increasing the partition count does not parallelize the largest default octree bucket.

For scale, contour plus cell meshing is only about 24.5% of the default native housing total. Under an idealized model that parallelizes only that work with zero overhead, infinite workers would yield at most about **1.32×** speedup (`1 / (1 − 0.245)`). This is a phase-budget illustration, not a browser speedup prediction; actual worker compilation, copies, load imbalance, and recovery make the situation less favorable.

[`worker::mesh_partition`](../gcad-wasm/kernel/src/sfcc/worker.rs) recompiles the feature graph in every worker, reconstructs the entire tagged octree/sample lookup, and computes Morton groups before selecting its own group. Merge recompiles features again. With `N` workers, there are `N+2` feature compilations before any recovery, although the worker compilations overlap in wall time. Comments describing this as a “cheap ~6%” cost are stale for housing.

Merge can then invoke a complete serial export when failed/fallback cells, numerical failures, or face-consumption failures remain. Both correctness and performance reports must record `serialRecovery`; worker-count geometry parity is not evidence of useful speedup. The existing serial fixtures exhibit counters relevant to these triggers, but this report does not claim to have measured a distributed housing/bracket recovery rate.

The pool copies the prepared leaf buffer to each worker; partial output buffers are transferred. Warm workers retain their WASM instances, but do not currently retain the compiled per-export feature context. Serialization/transferable feature data or cached worker contexts need scene/tolerance fingerprints, explicit invalidation, bounded memory, and preserved feature IDs/diagnostics.

Memory also deserves separate measurement:

- Output bytes count only vertex and triangle buffers, excluding feature-edge output and all intermediate structures.
- Point tables, feature graphs, curve-plane caches, face maps, triangle ownership, edit geometry, tree nodes, and adjacency maps coexist. Remeshing does not immediately remove historical point/ownership entries.
- `TriangleIndex::build` sorts at each recursive level: approximately `O(T log² T)` comparison work for balanced construction. Queries allocate result/stack vectors. Broad-phase overlap can still make contact work approach quadratic in pathological geometry.
- Worker memory includes repeated trees, features, full leaf reconstruction, and independent WASM linear memories. It cannot be estimated by dividing serial memory by worker count.
- The sampled audit process reported a 210.7 MB physical footprint at that point. This is not a comparable per-export peak-RSS measurement. The sandbox denied the `time -l` resource query; no native peak-RSS regression claim is made. WASM linear-memory high water, live heap use, native RSS, and GPU memory are distinct metrics.

## Recommended order of work

| Priority | Change | Expected benefit and required gate |
|---|---|---|
| 1 for experimental quality | Reduce exact-predicate allocations and repeated per-query scene/domain evaluation | Targets observed audit stacks and expensive cell/validation stages. Preserve exact signs, nested ownership, f32 contacts, and numerical failure reporting; benchmark each change separately. |
| 1 for default export | Retain unaffected octree decisions/samples and contour work through recovery | Targets measured repeated work. Start with reusable pure results before full local topology repair; require identical geometry and diagnostic behavior. |
| 2 | Propagate/index candidate carriers and reuse strict/coarse candidate computations | Targets the experimental cell-meshing increase. Require unchanged candidate acceptance and protected feature geometry. |
| 3 | Retain compiled feature contexts and implement useful worker scheduling | Avoid repeated feature compilation; wire octree decisions only with measured communication costs. Record prepare/compile/decide/mesh/merge/serial-recovery time and total memory. |
| 4 | Incremental edit adjacency/index/error caches; feature-tracing broad phases | Addresses scalability and allocation churn after the dominant repeated queries are reduced. Preserve ordering, candidate completeness, and invalidation. |

These are priorities supported by measured stage budgets and source evidence, not promised speedup factors. Keep quality stages opt-in until both fidelity and runtime gates pass. Lower triangle counts alone are not a quality result, and remaining contact, interior, and compiled-feature failures prevent calling these exports certified.

For each optimization, compare unchanged tolerances and the same scene/backend/configuration; retain raw timings and validation counters. Add counters for field/subtree evaluations, domain-path checks, carrier attempts, strict-to-coarse retries, exact fallback counts/limb sizes, broad-phase candidates, edit rejection reasons, and allocations. Collect them in separate diagnostic runs so instrumentation does not distort timing acceptance. Then run the broader native/WASM, worker-count, depth, and scene-complexity matrix; this investigation does not substitute for it.

## Reproduction and validation

The enhanced [`sfcc_quality_bench.rs`](../gcad-wasm/kernel/examples/sfcc_quality_bench.rs) emits JSONL progress, stats, per-export phase totals/validation, and the measured median. Generate the inputs from the repository root using the same bridge as the existing [WASM benchmark](../gcad-wasm/fixtures/sfcc-quality-benchmark.mts):

```sh
node --import tsx --input-type=module <<'JS'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { SceneInfo } from './src/scene/scene.mts';
import { serializeSceneToBridgeJson } from './src/export/sfcc-rs/scene-bridge.mts';
mkdirSync('/tmp/sfcc-performance-inputs', { recursive: true });
for (const name of ['housing', 'bracket']) {
  const { source } = load(readFileSync(`docs/manim/scenes/torture_${name}.yaml`, 'utf8'));
  writeFileSync(`/tmp/sfcc-performance-inputs/${name}.json`,
    serializeSceneToBridgeJson(new SceneInfo(source).root));
}
JS
```

```sh
cargo build --offline --release --manifest-path gcad-wasm/Cargo.toml \
  -p gcad-kernel --features serde --example sfcc_quality_bench

# Repeat with baseline, audit, and all. Final argument: measured exports after one warmup.
gcad-wasm/target/release/examples/sfcc_quality_bench \
  /tmp/sfcc-performance-inputs/housing.json \
  -23.5 -13.199999809265137 -23.5 47 baseline 3

gcad-wasm/target/release/examples/sfcc_quality_bench \
  /tmp/sfcc-performance-inputs/bracket.json \
  -26.4 -21.1 -26.4 52.8 baseline 3
```

Validation for this report is the release benchmark build, completed scene/configuration runs, consistency checks on their geometry/diagnostic counters, and documentation/data checks. No production algorithm, tolerance, default, PNG, or shader was changed; the full application suite and manual visual QA were not rerun for this reporting change.

## Implementation follow-up — September 10, 2026

The [performance implementation results](plans/sfcc-performance-improvements-results.md) record exact-output-preserving changes to winner selection, exact predicates, query reuse, patch preparation and recovery caches. In the isolated native comparison, default housing/bracket exports improve by 26.9%/28.0%; all-quality exports are 2.87×/2.77× faster. WASM output equivalence passes and the matched sequence's maximum linear memory falls 3.3%. Some native process peak-memory measurements exceed the proposed budget; the results retain those exceptions and the allocator investigation. The historical measurements above remain unchanged.
