# Stage 3 revision A: source junction location, unresolved arc attachment

**Partial implementation, not a selectable reconstruction repair.** No build or
geometry execution performed by author. Root must execute focused checks; the
actual compiled-source lower-incidence gate intentionally remains unchanged and
is expected to fail. This packet starts from prior A-measured, not production.

## Scope and changes

- `exposure_a.rs`: factor the existing support conditions so a separately proved
  groove offset boundary can replace strict groove inactivity. The existing
  positive exposure API still always requires strict groove inactivity.
- `junction_a.rs`: bounded source junction location theorem. No trimming caller
  uses it to grant endpoint authority. No runtime model IDs/coordinates are used.
- `trim.rs`, `segment_exposure.rs`: per-end `TrimFrontier` replaces the boolean.
  It stores last-positive and other bracket parameters in the original raw-curve
  parameter frame plus undecidable-classification/work-limit/stagnation reason.
  `curve_idx` on the run binds that frame to the immutable original source/branch;
  endpoint slot and the order alive→other encode orientation. Split/wrap paths
  carry original-end data; closed wrapping does not silently translate raw-frame
  frontier parameters. Internal cuts remain ordinary candidate cuts as before.
  Explicit 40-step exhaustion and midpoint stagnation remain unresolved, and are
  included in the unresolved-trim count. No conditional nearest snapping is added.
- Tests retain actual original-source upper/lower gates and prior negative controls;
  add exact-source junction receipt, altered-source/ancestor rejection, invalid
  meridian/vertical-offset refusal, and bounded frontier/work/stagnation controls.

## Location theorem

The actual-root structural equality and immutable occurrence checks are inherited
from A. The same native twisted-side / parent round-union / coaxial cylinder source
roles define a fixed-sign exact helix. The supporting certificate establishes the
selected convex extrusion side, cylinder interior, inactive inner-lathe round union
and nonzero transverse determinant.

For each actual groove meridian edge `d=(dr,dy)`, derive the outward normal from
represented endpoint differences and exact polygon orientation, never stored rounded
normal coefficients. Require a closed strictly convex profile with positive radii
and at most 64 nondegenerate edges. At fixed represented cylinder radius R, solve

`orientation * (dy*(R-r0) - dr*(y-y0)) = chamferRadius * sqrt(dr²+dy²)`.

Interval division rejects zero-containing axial coefficient; the solution is one
isolated axial root. The actual closest point lies strictly inside that edge.
Positive outward distance proves outside winding; distance to every other finite
segment is strictly larger than the chamfer radius. Thus the groove SDF at the
ideal root is exactly minus the chamfer radius in the represented real source
semantics. The strict separation gives a local unique closest edge. Bound the axial
derivative away from zero. Recheck all other original ancestor conditions over the
root enclosure, and enclose the exact helix image with the existing trig remainder
bounds. Report a bound from the supplied numerical old corner to that ideal image.

This establishes a genuine regular **source location**, not the trace branch
connection from an unresolved endpoint. Locally the inactive ancestors leave
`max(E,C,G,(max(E,C)+G+r)/sqrt(2))`; at the root E=C=0 and G=-r.
The compound generated carrier stores rounded weights and a rounded offset, so
its zero set is not asserted exactly identical to this ideal real-source equation.
No source31 membership or parameter-interval transport is claimed here.

## Why not attach yet

The unresolved incoming diagonal traces need a proof they reach this source
junction along the same branch within their retained frontier. An existing corner
coordinate, nonzero source rank and a numerical triple projection do not prove
that. The `[10,31]` versus `[30,31]` equivalence requires its own source-domain and
ordered-interval justification. This implementation does not fabricate that proof.
The location theorem therefore cannot restore lower memberships on its own.

Per-end data currently survives only within trimming/remaking; final FeatureCurve
continues to expose an unwired end rather than a public frontier object. Detailed
classification causes below `Result<bool,()>` remain opaque; the frontier does not
pretend to distinguish conditioning from a failed finite probe. No change to APIs,
GUI/native settings, worker serialization or production source is proposed.

## Root execution

Use the pinned Rust 1.99.0 no-LTO/codegen16 diagnostic build, offline/locked with
`serde,sfcc-profile`; build limit120s, focused campaign60s. Clean only the task-owned
kernel cache first, require positive libtest discovery, archive all hashes/results.

Suggested filters in order:

1. `exposure_a_junction_` — three new source-location/negative tests.
2. `exposure_a_frontier_` — one bounded provenance control.
3. `exposure_a_rejects_` — prior source restrictions.
4. `exposure_a_uncertain_` — prior no-snap control.
5. `exposure_a_original_` — actual compilation, expected lower preservation failure.

Set `SFCC_JUNCTION_A_RECEIPT` to a fresh receipt path, plus existing
`SFCC_EXPOSURE_A_RECEIPT` for the actual compilation receipt. The main regression
writes the separate upper and lower verdicts before asserting the lower gate.

No full component, native/WASM transfer, transformed-family, GPU or visual QA was
performed. Stage3 remains open. The new junction theorem and frontier mechanics
require root execution and independent review before their limited claims count.
