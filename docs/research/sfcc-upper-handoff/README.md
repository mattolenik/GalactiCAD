# SFCC upper handoff: continuation proved, ancestor evaluation corrected

The current upper cutoffs are not justified terminal points: a bounded source
certificate establishes a regular, ordered crease continuing through them.
An isolated correction also recovers an outgoing feature that the old intermediate
chamfer evaluation suppressed. **Complete handoff and source admission still fail**;
no component mesh or production change is accepted.

[Consensus decision](decision.md) · [Implementation plan](../../plans/sfcc-graph-correctness-implementation.md) ·
[Previous component refusal](../sfcc-stage4-component-validation/README.md).

Three independent agents supplied a continuous source theorem, an operator
correction with actual feature recovery, and an ownership counterexample. Root
executed their frozen packets serially; a fourth reviewed source, evidence and
hashes. B is retained as the next **isolated experimental base**. A and C supply
separately tested premises and controls; their files have not been combined into
an untested runtime handoff.

## What the composed surface requires

On the admitted source interval, let E be the actual extrusion field, C the
cylinder field, S the outer sphere field, r the round radius, R the cylinder
radius, Rs the sphere radius and ys its axial center. The active outer source is
`roundMax(max(E,C), S)`. Its crease changes from native zero fields `E=C=0` to
equal **nonzero** fields `E=C=a<0` through the rounded region.

The proof parameterizes that outgoing crease by an angle phi:

```
a = r (cos(phi) - 1)       S = r (sin(phi) - 1)
rho = R + a               q = Rs + S
y = ys + sqrt(q^2 - rho^2)
v = v0z + a/nz            u = sign * sqrt(rho^2 - v^2)
```

The actual extrusion twist rotates `(u,v)` into world coordinates. A checks the
whole interval, including the unique nearest finite profile edge, both finite
caps, inactive inner round competitor, groove/chamfer dominance and final cutter
dominance. Thus the *actual scalar operands*, not merely their zero sets, have
the values used by the round identity `(r+a)^2 + (r+S)^2 = r^2`.

Positive height derivative establishes ordered ideal continuation. A positive
angular/radial transverse minor establishes distinct exposed flanks meeting in a
regular crease. At activation the outgoing curve joins the incoming helix with
the same tangent direction; it does not terminate there.

| Certified quantity | Bound / result |
| --- | --- |
| Transition height | `[2.6957935656967407, 2.6957935656967558]` mm |
| Required angle interval | `[0,0.01]` radians, continuing past both current cutoffs |
| Height derivative lower bound on required interval | `1.1295695107473651` |
| Transverse minor lower bound | `0.6645258866612379` |
| Extended checked angle interval | `[0,0.5]` radians |
| Extended end height | `[3.327511405108021, 3.32751140510805]` mm, covering height 3 |

All six source margins are positive. The supported class remains narrow and
identity/coaxial; later finite-cap, nearest-edge and ancestor transitions are not
proved. No sphere-only nominal terminal is assumed to be the actual terminal.

At the current numerical cutoff heights, the ideal native-zero extension has
strictly positive full-source residuals of approximately `3.54372e-7` and
`3.45075e-8`. Continuing `E=C=0` is therefore not the exact outgoing source curve.
This does not itself prove an exported approximation exceeds its tolerance. It
identifies the source event and curve that the feature graph must represent.

## The confirmed implementation defect

At a nonempty override path, an intermediate chamfer always evaluated its
supporting diagonal. That omits child-dominant regions of the actual operator.
For example, a chamfer intersection is

`max(a, b, (a+b+r)/sqrt(2))`, not invariably its final term.

The original upper witness has an inactive groove chamfer. Forcing its diagonal
changes the hard operand carried into the outer round and suppresses the lifted
crease. B removes that special case and uses the existing `sample_blend` with
the overridden child and selected partner. An explicitly selected, path-empty
`FieldBranch::Chamfer` still denotes its supporting diagonal; its activity guards
and fixed-partner semantics remain intact.

At the actual source witness at height 3 mm:

| Observation | Legacy intermediate evaluation | Corrected evaluation |
| --- | --- | --- |
| Lifted field values | Both about `-0.6018733355` | About `2.55e-15` and `1.78e-15` |
| Lifted source domains | Both invalid | Both valid |
| Gradients at witness | Identical | Distinct |
| Nearest checked compiled representation of matching source pair | About `5.50304` mm away | About `5.84969e-9` mm away |

The corrected representation is lifted source pair `[38,39]`, curve 76 in that
run. These IDs are observations; source paths and descriptors identify it. Its
point was obtained from its own checked query, not accepted from an unchecked
projection proposal.

The full feature inventory changes from **76 to 101 curves**, **40 to 55 corners**
and **83 to 95 unresolved trims**. These broader changes are recorded, not all
validated. A recovered witness does not establish every changed feature's validity,
global smoothness of lifted carriers or completeness of branch enumeration.

## Why correcting the operator does not close the handoff

The independent C diagnostic separates correct field evaluation from discovery
ownership. `FieldRef::surface_live` rejects lifted fields when the target value's
magnitude is within `native_band`, here **3.796655370190979e-7**.

For the exact outgoing source, `a=r(cos(phi)-1)` approaches zero continuously.
A positive exclusion band therefore removes an initial interval of this regular
curve from lifted ownership. C's actual-source samples corroborate the distinction:

| Height above activation proposal, mm | Hard target magnitude | Corrected lifted domains |
| --- | ---: | --- |
| 0.0002 | `1.24e-8` | Excluded by band |
| 0.0005 | `7.73e-8` | Excluded by band |
| 0.001 | `3.09e-7` | Excluded by band |
| 0.002 | `1.24e-6` | Admitted |
| 0.01 | `3.08e-5` | Admitted |
| 0.1 | `2.93e-3` | Admitted |

These proposals have full-source residuals around machine precision and tested
normal gaps above 1.15. The continuous premise comes from A's theorem, not from
these finite samples. An exported geometric hole is not inferred: numerical native
geometry can approximate part of this region within its bands.

Near activation, `a = -r*phi^2/2 + O(phi^4)`: the operand leaves zero quadratically
even though the crease remains regular. Making a positive band smaller shrinks
its excluded interval; it does not establish the missing closure or connection.

Globally deleting the band is not a sufficient repair: it permits lifted ownership
over the incoming region already represented by native curves. A zero band also
permits numerical incoming overlap, while the exact predicate still rejects an
exact zero target at the transition. Discovery ownership and source-valid
one-sided closure need distinct treatment with positive connection evidence.

After B's correction the native/alias locator identifies charts `[20,39]`; both
upper corners remain `-1`. The unchanged complete-source gate still refuses
`endpoint_missing`. No endpoint was welded, invented or authorized by proximity.

## Validation and preserved failures

| Final packet | Passing tests | Required complete-source gate |
| --- | ---: | --- |
| A-controls: source theorem and retained lower controls | 14 | **FAIL: endpoint_missing** |
| B: operator/recovery and retained lower controls | 16 across the original campaign and same-binary checks | **FAIL: endpoint_missing** |
| C: ownership discriminator and retained lower controls | 14 | **FAIL: endpoint_missing** |

Counts overlap across candidates and are not reconstruction-success counts.
The lower repair's twelve controls pass under the corrected B runtime, including
query refusal and late-transaction rollback. The unchanged lower-membership and
upper-window gate also passes.

A's first packet failed compilation on an unnecessary `Debug` derive. The
build-only correction exposed a negative-test setup error: directly changing
`Leaf.shape` left its immutable cached strata stale, and source binding correctly
refused that incoherent input. The final control rebuilds modified shapes through
the actual scene bridge, verifies the zero-level transition still admits, then
requires the requested nonzero interval to refuse at a finite cap. Only tests
changed; no theorem or tolerance was weakened. Both earlier failures are preserved.

All builds used pinned Rust 1.99.0, offline/locked, no-LTO/codegen16, fresh task-owned
kernel caches and positive discovery. Build/focused limits remained 120/60 seconds.
B's additional lower controls reused the exact recorded binary with independent
receipt paths. Source/patch restoration and fourth-agent hash checks are archived.
No full component, mesh export, native/WASM, GPU or visual campaign ran.

## Next implementation contract

1. Keep B's corrected ancestor composition and the accepted lower repair. Rebind
   the source event and all incoming/outgoing charts through immutable source
   identities, not these dense IDs.
2. Delimit the incoming native-zero charts at the **proved activation event**,
   not either numerical cutoff. Establish ordered transport from their actual
   raw parameters and consumed queries to that event.
3. Connect a source-certified outgoing prefix to the recovered lifted trace.
   Bind its branch, interval, parameter order, numerical association and endpoint
   agreement. The ideal curve theorem does not automatically certify an arbitrary
   Newton parameterization or an entire recovered trace.
4. Add positive source-bound closure/membership authority where discovery ownership
   excludes the handoff. Do not waive failed domain checks globally, remove the
   band, duplicate an edge or copy a nearby endpoint. Preserve ambiguity, work,
   numerical and unsupported-source refusals and transaction rollback.
5. Validate native, alias and outgoing memberships and incident patch topology in
   one fresh compilation. Rerun complete admission, including all subsequent
   transport/domain/endpoint requirements. Only then resume component preparation.

## Artifacts

| Artifact | Purpose |
| --- | --- |
| [Consensus decision](decision.md) | Accepted partial results, limits and next contract |
| [Summary](summary.json) | Separate theorem, correction, admission and mesh verdicts |
| [B correction patch](B-packet/candidate.patch) and [handoff](B-packet/handoff.md) | Next isolated experimental base |
| [B actual-source receipt](B/upper-B.json) | Legacy/current fields, compiled recovery, raw frontiers and inventories |
| [B failed admission](B/source-preflight.json) | Current source identity and unchanged refusal |
| [B extra control provenance](B-lower-controls/binary-reuse.json) | Exact binary reuse, no hidden rebuild |
| [A theorem packet](A-controls-packet/handoff.md) and [receipt](A-controls/upper-A.json) | Full-scalar interval proof and finite-cap controls |
| [C discriminator](C-packet/handoff.md) and [receipt](C/upper-C.json) | Ownership versus closure observations and overlap control |
| [Restoration checks](preservation.json) | Every executed input reproduced from its flat patch |
| [Runner](run.py) | Toolchain, watchdogs, discovery, source verification and receipt paths |

Flat patches apply individually to the captured Stage 1 baseline. Each includes
the prior selected lower repair; do not apply competing flat patches on top of
one another or directly to production. The handoffs list exact filters. Test
binaries remain in local `.testresults`, not Git.

Production is unchanged. Complete handoff, Stage 4 geometry/interfaces, current-HEAD
integration, full-model acceptance and general multi-sheet reconstruction remain open.
