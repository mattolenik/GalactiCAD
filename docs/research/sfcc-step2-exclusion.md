# SFCC Step 2: numerical exclusion consensus

Status: Step 2 accepted. The integration based on `5b9f190` passed focused and coordinator broad validation: application build, 341 native tests, 34 WASM fixtures, and 180 profiling library plus 11 diagnosis tests. Historical Step 1 ledgers are unchanged.

## Selection and rejected alternatives

The consensus selects B v4's homogeneous geometric primitive enclosures, represented-matrix radial sphere bound, complete cell-region construction and retention of supported hard query trees. C contributes its independent algebraic oracle and capture of actual parsed/baked input bits; B's separate high-exponent, signed and nonorthogonal-matrix rational oracle also remains. These test adapters call the existing kernel; they add no production evaluator. No C runtime arithmetic or coordinate rewrite is combined with B.

The selection is based on the operation and caller arguments, challenged by exact witnesses and ordinary controls. Both B and C retain baseline rotation counts, but B preserves existing sampling/feature coordinates and covers their union together with the nominal dyadic domain. C's canonical-coordinate rewrite is therefore unnecessary for this numerical-exclusion milestone. Its useful origin-1e15 face witness remains relevant to later interface work: the old start-plus-extent face reaches `.75` while canonical lattice endpoints stop at `.625`; B deliberately encloses both constructions instead of asserting they are equal. This does not certify that those face conventions are topologically compatible.

A's natural-operation intervals also enclose rounded evaluation and can support strict regional pruning. Its wrapper, containment fallbacks and bounded per-query numerical subdivision are substantially more machinery, and its rotated sphere still grows from 1,591/8 leaves/unresolved to 1,768/53. Exact replay identifies 18 full-query boxes as wholly inside/outside; the other 35 boxes contain zeros but do not prove crossings on their particular rejected edges or faces. Full retention avoids needing A's extra floating-dominance theorem. Its exact replay inputs/script and final counts remain in the evidence directory.

All three first local-AABB-only sphere proposals failed usefulness at 8,237 leaves / 5,703 unresolved versus 1,591/8. Separately, replacing legacy blend operands with wider checked cube bounds flooded an ordinary round-plus-box control: A/B reached 5,860/2,621 and C 7,739/4,500 versus 3,631/543. The final explicit legacy operand policy restores that baseline. The failed variants, output and source/package hashes remain labeled historical; they are not final validation. [Proposal provenance](sfcc-step2/proposals.json) identifies B's final v4 package `ab24975d…`, superseding `8585123b…`.

## Contract and argument

The full operation-level argument is in [the numerical proof](sfcc-step2/numerical-proof.md). The input map is:

1. Original JSON is parsed by the existing target bridge.
2. Existing transform baking produces actual binary64 `Leaf` coefficients.
3. Those coefficients denote exact dyadic real numbers. With `u=Rᵀ((p−t)/s)−pos`, the declared leaf field is `sign*s*D(u)`, and hard nodes compose real min/max in the original signed tree.

This is distinct from an ideal unrounded transform, a real-valued interpretation of the original JSON decimal text, GPU/WGSL evaluation, rounded `Leaf::f`, and existing analytic feature carriers. In particular, approximate rotations do not preserve exact spheres merely because they pass a sanity tolerance.

Finite positive sphere/box dimensions and scale, finite matrices/translations/positions, signs ±1, nonempty hard nodes, and finite ordered queries define the checked bound domain. Direct bounds do not require exact orthogonality or even nonsingularity; discovery retains its stricter existing carrier-eligibility screen and reports indeterminacy when it fails. A successful interval `[lo,hi]` encloses the declared real field on the entire real center/half box. Ball queries use their containing cube. Only `lo>0` or `hi<0` excludes zero. Contact survives; arithmetic/input failure yields uncertainty before hard min/max can hide it.

Positive homogeneity yields `q=Rᵀ(p−t)−s*pos`, with scaled dimensions. Every affine arithmetic operation widens outward before the next operation. Coordinatewise absolute values and monotone primitive formulas give an enclosing transformed-box range. A scaled norm uses only basic arithmetic and correctly rounded square root, avoiding avoidable squared overflow and any unspecified `hypot` accuracy premise. For spheres, actual represented `RRᵀ−I` row sums bound its quadratic form; outward center and residual terms plus triangle inequalities give a tight radial enclosure. Invalid radial arithmetic falls back to the affine enclosure. Hard-node monotonicity then gives the tree enclosure by induction.

The machine premise is binary64 nearest-even arithmetic, gradual underflow and no fast-math/reassociation. Each outward elementary result encloses its exact real result even at cancellation and subnormals. Rust's [square-root contract](https://doc.rust-lang.org/std/primitive.f64.html#method.sqrt) and the [WebAssembly numeric semantics](https://webassembly.github.io/spec/core/exec/numerics.html#floating-point-operations) were checked during consensus. Proof plus target tests supports the stated configurations; finite regression samples alone are not a universal enclosure proof.

These geometric bounds do not automatically enclose the existing rounded evaluator, whose operation order and unscaled norm can overflow differently. Supported hard `Pruned` views therefore keep every child and original order. Field, gradient, owner and interval paths are preserved structurally, at arbitrary query points. Interval-tuple parity is not inferred from pointwise scalar equality after deletion. Legacy mixed/opaque regional dominance remains outside this theorem.

## Claim/evidence ledger

| Claim | Status and evidence |
| --- | --- |
| Supported real-field interval inclusion | Operation induction, homogeneity, monotonicity and explicit matrix-defect argument; exact algebraic regression oracles challenge the implementation. |
| Original world-sphere shortcut is invalid | `a=1+2^-22`, represented `diag(a,1,1)`, exact rational root `x=1/a`; baseline excludes zero while the integrated initial/child culls retain it. |
| Scalar-centered ball bounds can exclude an exact zero | Integer Pythagorean witness `(16072908759584,218874968123250,0)`, radius `219464325271666`; old ball0 is `[-.03125,-.03125]`. Integer squares and independent oracle establish the zero. |
| NaNs cannot be rescued by checked hard min/max | Native invalid siblings, empty hard nodes, overflow and matching WASM checks. The legacy box transform guard catches the specific finite-input NaN-masking witness. |
| Actual whole-cell region is covered | `cell_enclosure` unions exact nominal dyadic addresses and all three existing rounded coordinate maps at every descendant depth; private factory region follows `RefineProbe`. |
| Subnormal requested domain cannot silently disappear | Ancestor queries at sizes 7 and 24,559 minimum-subnormal units, plus actual initial cull/discovery for the 23,001-unit interior sphere. No depth-14 volume flood is executed. |
| Supported borrowed-query parity | Full retention preserves original occurrences/order. Existing >12-leaf, signed, nested, duplicate, direct, serial/resumable and worker assertions remain. |
| Native/WASM enclosure parity | Each target is tested against its actual captured input bits. Endpoint bit identity is not required when parsing produced different queries. |
| Useful ordinary and legacy controls | Rotation and mixed export counts are frozen independent controls, not field/topology proofs. |
| Complete feature/Boolean-component coverage | Not established. Sampled strata, carriers, recovery seeds and local construction remain Step 3 obligations. |

## Caller coverage

| Boundary | Shared path / condition |
| --- | --- |
| Leaf, hard-tree and borrowed-view box/ball queries | One checked geometric primitive path and checked hard composition. Bounds are real-field enclosures. |
| Initial descent; every child and balance split | `Builder::certified_empty` uses `cell_enclosure` and strict zero exclusion. |
| Early coarse-region culling | `collect_coarse_prunes` uses the same complete cell region. |
| Original signed ancestor/owner traversal | Original occurrences and postorder ancestry retained; checked supported leaf ranges, intentional opaque discovery intervals handled separately. |
| Discovery points, equal-sign edges and homogeneous faces | Checked primitive query on actual represented endpoints, through an outward enclosing-box constructor. |
| Whole-cell discovery and same-sign smooth shortcut | Private `make_probe` region is authoritative; edited public sample coordinates must remain inside it. No narrow corner-hull substitution. |
| Coarse serial/direct/resumable/worker decision caches | Fully supported views retain the entire expression; arbitrary sampling/projection cannot escape a regional deletion premise. |
| Face-contour and quality cell-mesh query caches | Same retained-view behavior, including the independent quality-pruning path. |
| Optional contour recovery absence cull | Shared root interval over a region enclosing the real edge and rounded interpolation replaces the unproved per-carrier midpoint/gradient skip. Spatial feature availability and finite recovery remain uncertified. |

Existing maps are deliberately unchanged: `origin+g*step` samples, level-size feature boxes and face start-plus-extent rectangles. Exact dyadic nominal domains tile in real arithmetic even when rounded `step*res` does not equal `world_size`. For coherent `make_lattice` state and legal cell indices/depths, the checked union covers each descendant map by monotonicity and outward endpoint operations, through at most 15 depth iterations. Failure prevents exclusion. This does not make a collapsed or severely rounded grid a successful mesh; discovery retains explicit uncertainty.

## Opaque scope and remaining obligations

A blend enters a private legacy operand policy through its complete subtree, including hard descendants and nested blends. This preserves ordinary behavior without claiming a bound theorem for blends. Unsupported leaves and mixed ancestors that depend on legacy intervals remain outside the whole-tree guarantee. Discovery's intentional opaque `[-∞,+∞]` value is distinct from malformed metadata or accidental arithmetic failure. A supported hard sibling can still prove the limited strict ancestor sign allowed by that discovery traversal; it does not retroactively certify a prior mixed-tree cull.

The legacy leaf guard checks inverse/local coordinates, scalar value, advisory reach and endpoints. It catches the documented `MIN_POSITIVE` box transform whose NaN coordinates otherwise become scalar zero through min/max. It does not establish all internal arithmetic or continuity of unsupported formulas. No blend-certification claim follows from restored counts.

Step 3 must address field/carrier equality under represented matrices, spatial feature availability, Boolean-clipped pieces and loops, finite edge/face recovery, sampled active-stratum and normal heuristics, local filling capability and neighbor/worker interfaces. No universal meshing, successful termination, f32 embedding or Hausdorff claim is made. Step 4 owns caching and controlled performance measurements; tolerance, depth and operator semantics remain unchanged.

## Validation and work

Focused validation passed with no failures or skipped fixtures:

| Run | Result |
| --- | --- |
| Profile/serde native matrix | 180 library, 11 diagnosis, 6 discovery, 3 prune-parity, 13 numerical and 3 transform tests. |
| Final-source default native numerical suite | 11 tests, including actual initial/child culls, subnormal root retention, malformed inputs and direct-probe mutation. |
| Native direct-leaf rational oracle | 256 cases × eight corners and center = 2,304 exact comparisons; rational transformed-root containment separately proved. Rust's roundtrip decimal records identify the actual direct leaf/query floats. |
| Native and matching WASM captured-bit oracle | Each: 132 queries, 1,980 exact point/corner/axial-ball checks, 48 full axis-aligned box-extrema checks, 12 re-proved exact zeros; 131 finite box enclosures and one explicit MAX uncertainty. |
| Matching normal-release WASM | 18 focused fixtures: eight numerical, seven discovery/worker, three transforms; no skips/cancellations. |
| Same-input transport replay | 132 baked leaf bitsets match; native/JS raw queries differ on 24 rows and bounds on 13. Replaying all 132 native query bitsets through WASM produces zero endpoint-bit differences. |
| Structural profile | Same nine fast scenes in baseline order, `fast 1 0`; all leaves, triangles, components, unresolved/failed cells, decisions and discovery-query counts unchanged. |

The profile/serde matrix immediately precedes only the clarification of the `recovery_cull` doc comment. Default numerical tests, rebuilt native oracle/profile artifacts and the matching WASM use the final source including that comment. No runtime edit follows the matrix. The original scalar/gradient/operator implementations are unchanged. Existing Step 1 runtime assertions remain; the one changed discovery assertion now positively requires complete supported-tree retention, while keeping its witness and strengthening gradient/interval parity.

Fine hidden remains 4,199 leaves / 36 unresolved / two components / zero failed; tight lens remains 1,245 / 267 / two / zero. Their actual 1/2/4/8-partition forward and reversed raw worker merges still assert `serialRecovery=false`; separate recovery cases retain their explicit assertions. Ordinary raw/f32 Rz(.713) spheres stay at 1,591/8 and rotated boxes at 326/0. Identity box remains 152/0. Legacy round-plus-box stays 3,631/543 and cylinder-plus-sphere 2,279/8, each with two components. Unresolved controls are not described as complete successful meshes.

The final structural work changes are:

| Control | Leaves / unresolved | Winner scalar calls, baseline → integrated | Discovery interval calls |
| --- | --- | --- | --- |
| Box | 4,376 / 0 | 0 → 0 | 83,160 → 83,160 |
| Sphere | 2,763 / 0 | 0 → 0 | 53,615 → 53,615 |
| Buried 15 hard leaves | 4,376 / 0 | 312,525 → 401,505 (+28.47%) | 144,424 → 144,424 |
| Hidden 16 hard leaves | 3,974 / 4 | 2,297,930 → 2,389,632 (+3.99%) | 135,912 → 135,912 |

Removing the carrier midpoint test reduces scalar-composition counter 12 for box, ordinary seam, hidden, and small seam controls. Raw-composition counts remain unchanged. Full arrays and every changed counter are preserved in [work comparison](sfcc-step2/work-comparison.json) and the baseline/candidate JSONL files. Repeated correctness runs are not independent coverage. `diagnostic_ms` is not timing evidence; the baseline overlapped earlier correctness work, and Step 4 owns paired timings and the expensive 48-blob workload.

Primitive enclosures take constant arithmetic/storage; hard traversal takes O(nodes), recursion O(depth). Retained views keep O(nodes) borrowed structure and query work. Complete cell regions take O(max_depth−level+1), at most 15 passes. Counters omit this endpoint arithmetic, repeated parameter validation and legacy transform checks, so they do not measure total overhead. No speedup or performance-neutrality claim is made.

[Validation commands and log hashes](sfcc-step2/validation.json), [source/artifact manifest](sfcc-step2/manifest.json) and [focused WASM package identity](sfcc-step2/focused-package.json) identify the exact runs. The package SHA-256 is `5d7f45f536bd69a3123038c28d4972604ce850848406245482b57cb8aa09ddb4`; a preserved copy is `/tmp/sfcc-consensus-focused-pkg`. The coordinator's later package is separate evidence.

Reproduction from the repository root (offline, one build job) uses the commands in the validation artifact. The exact oracles are also directly replayable against the saved outputs:

```sh
python3 docs/research/sfcc-step2/exact_oracle.py --check docs/research/sfcc-step2/inputs.json docs/research/sfcc-step2/native-bounds.json
python3 docs/research/sfcc-step2/exact_oracle.py --check docs/research/sfcc-step2/inputs.json docs/research/sfcc-step2/wasm-bounds.json
python3 docs/research/sfcc-step2/numerical-exclusion-oracle.py docs/research/sfcc-step2/primitive-records.jsonl
/opt/homebrew/bin/node docs/research/sfcc-step2/replay_transport.mjs
```

The transport replay uses the current package, so its bit-identity assertion applies to the identified focused package or an identical implementation. The field-enclosure oracles remain the correctness contract if a later proved implementation changes conservative endpoints. C's historical 15 endpoint differences are retained separately; the integrated bound produces 13, with the same 24 query rows differing. No parser change was made to force identity.

## Coordinator acceptance gate

The final application build, **341 default native tests**, **34 WASM fixtures**, and **180 profiling library plus 11 diagnosis tests** all passed with zero failures. These overlapping suites are separate validation results. Existing native tests without their external TS binary oracle do not establish those missing comparisons. Commands and log hashes appear under `coordinator_validation` in the validation artifact.

The broad build stamps `0.0.0-5b9f190-dirty`; its artifact hashes are recorded separately from the focused package. The broad Cargo run replaced the usual native example output paths, so identical focused binaries were recovered by their recorded hashes and preserved under `/tmp/sfcc-consensus-focused-native`. The manifest retains their original locations as provenance. No runtime source changed during the broad gate; final proof wording and status edits are documentation only.

Step 2 is accepted as the numerical-exclusion milestone. All owned processes have ended. Step 3 proceeds from this validated contract; visual QA remains manual.
