# Patch ownership and the first retained-outside witness

**The successful 205-cell reconstruction is preserved exactly, and the new
point/face metadata audit passes.** The first actual untouched outside consumer
also passes its local checks. The selected source passes **50 focused tests** and
a non-test library check; the full diagnostic finishes in **38.112 seconds**.

The ownership investigation corrects an earlier inference: the frozen fixture has
`qualityTriangulation=false`, which bypasses patch-label assignment even for a
supported cylinder carrier. We now have positive composed-source certificates for
small interior regions of the first fan and one tiny counterexample to its chosen
exact projection. Neither result establishes full-fan ownership or mesh invalidity.
**Publication, complete outside compatibility and general SFCC correctness remain open.**

[Fourth-agent review](decision.md) · [Previous component result](../sfcc-component-transaction/README.md) ·
[Implementation plan](../../plans/sfcc-graph-correctness-implementation.md).

## Preserved component and actual fan inventory

The new run retains identical candidate point payloads, triangles, sorted curve
intervals and generated query records compared with round33. It still reconstructs
205 cells / 1,031 required faces into 1,775 triangles, with 1,929 postvalidated
generated queries and 8,413 candidate ledger charges. Both the main and outside
observations preserve the live input digest. Options and limits are unchanged.

The observer records all 414 fan calls and their 1,775 output triangles without
extra field or curve queries. Its first fan's boundary, triangle IDs and position
bits match the frozen source-proof fixture exactly.

| Selected stratum hypothesis | Fan calls | Output triangles | Existing local-edit carrier support |
| --- | ---: | ---: | --- |
| 10 | 203 | 878 | No |
| 15, cylinder | 198 | 823 | Yes |
| 30 | 1 | 6 | No |
| 31 | 5 | 30 | No |
| 38 | 3 | 20 | No |
| 39 | 4 | 18 | No |

All calls have quality triangulation disabled. Thus 823 triangles use a carrier
supported by the older local-edit gate but never enter that path; the other 952
use carriers outside that gate. The first cylinder fan has six triangles, surface
tolerance 0.01 and chord tolerance 0.02. Its missing labels are an option-path
observation, not evidence that the cylinder cannot be parameterized or exposed.

This qualifies the previous report's fallback explanation. Enabling the option
would not by itself supply a continuum proof either: the existing disk path also
uses finite checks. No option was changed and no owner labels were assigned here.

## What the first source certificate actually proves

The chosen chart keeps Y and Z and lifts onto the negative-X hemisphere of the
actual cylinder:

`X(Y,Z) = centerX - sqrt(radius² - (Z-centerZ)²)`.

This is a coordinate graph lift, not radial projection. Positive interval bounds
on the radicand establish a regular graph. The source helper binds the actual
registered cylinder and twisted-side occurrences and the complete operator tree.
It checks finite native-profile and lathe branches, inactive height clamping,
cap restrictions and ancestor margins. Physical source conditions, not normals
or dense stratum IDs alone, determine the result.

Let C be the cylinder field, E the twisted-side field, L the other lathe field,
and I their inner-round union with radius 1.4. On the admitted graph, C=0,
L>1.4 and E<1.4 imply I=E. If E<=0 and the positive groove distance is at least
the 0.7 chamfer radius, the hard intersection and chamfer give zero. The checked
cap and outer-round margins leave that zero exposed in the full composed field.

The proof uses interval enclosures over supplied chart rectangles. It examines
42 exact dyadic barycentric YZ probes and six small open rectangles strictly
inside the six triangle charts:

| Outcome | Count | Meaning |
| --- | ---: | --- |
| Full composed field equals cylinder on the enclosed graph region | 35 | Includes all six open interior rectangles |
| Strictly positive composed-field lower bound | 1 | Counterexample to this exact lift's source ownership |
| Enclosure obtained but sign/exposure unresolved | 7 | No positive or negative ownership verdict |
| Source/region certificate unavailable | 5 | Unsupported or inconclusive restrictions |

These counts are **not a percentage of covered fan area**. The interior rectangles
are only about 2e-6 by 2e-6 in chart coordinates. The unexamined area, seam bands,
curved boundary transport and graph-to-triangle approximation remain unproved.

### The counterexample is tiny and has a narrow implication

At the midpoint of one edge of triangle 4, the chosen graph lift has native-field
bounds `[1.4041567908407152e-10, 1.405791039132965e-10]`. The composed field has a
strict positive lower bound of `1.4041567908407152e-10`; its groove margin is about
2.488e-5. Thus that exact lift is not everywhere on the zero set of the full source.

This is a **field value, not a proved geometric displacement**. It is tiny relative
to the numerical scales already allowed by this reconstruction. It does not prove
that the approximate triangle is invalid, nor exclude a nearby valid source patch
with a different boundary mapping. Requiring exact carrier ownership of rounded
boundary data would be the wrong acceptance condition. A useful next proof must
include boundary uncertainty and an explicit approximation bound.

Review corrected two proof details before the selected execution: the reported
absolute cylinder-X derivative lower bound now uses outward interval division,
and unclamped twist evaluation requires an explicit interval height guard. The
receipt's `cylinderGraphDerivativeLower` names that absolute carrier derivative;
it is not dX/dZ and is not a displacement bound. A focused control rejects
out-of-height and invalid-extent inputs. An incorrect expected sphere sign was
also corrected during static review before any successful proof execution.

## Supplied pregraph metadata now has a checked transport audit

The new checker verifies canonical position/normal/key bits, directed segments,
original pin identities/parameters, the authorized primary relabel, and supplied
protected-edge/oriented-interval preservation. It uses borrowed collections and
scalar iteration: the checker body adds no heap allocation or scene queries.

| Actual supplied data | Result |
| --- | --- |
| Original / canonical points | 851 / 647 |
| Merged point keys | 204, under the existing authorized equivalences |
| Required faces / original pins | 1,031 / 414 |
| Primary alias pins transported | 198 |
| Collapsed zero segments removed | 204 |
| Position, normal, canonical key, directed segment and pin audit | Pass |
| Pre-existing protected edges / curve memberships | 0 / 0 |
| Additional checker queries / dynamic allocations | 0 / 0 |

The last protection/interval result is vacuous in this actual pregraph state;
nonempty preservation and corruption are exercised by controls. The checker does
not establish realization of every future protected edge, transport of unsupplied
metadata or source-patch ownership. Other diagnostic JSON, topology maps and contact
indexes still lack complete allocator accounting. No total-RSS claim is made.

## One actual outside consumer passes; the full ring is still unvalidated

The audit inventories original outside leaves at the same pre-cell-meshing stage,
then chooses the lexicographically smallest outside cell incident to a nonempty
candidate frontier record. It reconstructs exact original face/point payloads,
uses the original source view and reconciles shared keys only when positions also
match bit-for-bit. It does not use later postprocessed geometry.

| Outside observation | Result |
| --- | --- |
| Original outside leaves examined for face incidence | 88,835 |
| Face-adjacent outside cells | 375 |
| Outside cells with nonempty shared frontier faces | 277 |
| Selected witness | [7,20,62,71] |
| Witness triangles / initial points | 1 / 3 |
| Internal failure/fallback / orientation failures | None |
| Original face consumption | Valid |
| Candidate-versus-witness contact, working and rounded broadphases | None detected |
| Partial joined indexed topology | Valid, 1,776 triangles |
| Generated curve queries | 0 |
| Separate observational ledger | 64 setup charges + 2,048 reserved slots = 2,112 |

The 2,112 ledger total is not a count of geometry queries. Every generated slot is
unused and remains reserved; the observer finishes without exhaustion or refund.
This ledger is separate from the candidate's unchanged 8,413 charges. The complete
outside acceptance flags remain false.

One triangle is a deliberately narrow compatibility witness. It does not validate
the other 276 nonempty adjacent consumers, remote outside geometry or complete
joined vertex links. The full ring exceeds the existing 256-cell cap; the cap was
not increased. Unmeshed cell boxes were not used to exclude contacts, because a
cell box alone is not a proof that its generated triangles stay inside it.

## Execution and reproducibility

A developed source-region/fan evidence, B the same-stage outside probe and C the
metadata audit. D independently reviewed the composition and saved executions.
Root ran all builds and geometry serially with pinned Rust 1.99.1, unchanged
compiler/library hashes, locked/offline Cargo, no LTO and 16 codegen units.

| Frozen packet | Executed result |
| --- | --- |
| C-check | Four metadata controls pass |
| B-check | JSON-macro compile failure preserved |
| B-fixed | Two outside identity/contact controls pass |
| A-check | Missing-parenthesis compile failure preserved |
| Combined | 34 focused tests pass |
| Reviewed | 49 focused tests pass after outward derivative-bound correction |
| Clamp, selected | 50 focused tests pass in 38.826 seconds; library check passes in 2.954 seconds |
| Selected complete diagnostic | 38.112 seconds, including component preparation and the outside witness |

Focused/build/component limits remain 60/120/120 seconds. Only the final selected
composition ran the new full component/outside diagnostic. Counts overlap and must
not be added as independent coverage. Compiler failures are not geometric evidence.

| Artifact | Purpose |
| --- | --- |
| [Consensus](decision.md) | Mathematical review and accepted scope |
| [Complete result](Clamp/component-attempt.json) | Fan inventory, metadata audit, preserved component and outside witness |
| [Source-region receipt](Clamp/ownership-A.json) | Positive regions, counterexample and inconclusive cases |
| [Summary](summary.json) | Exact parent/fixture comparisons and gate outcomes |
| [Source](source-handoff.md), [outside](outside-handoff.md), [metadata](metadata-handoff.md) handoffs | Independent arguments and limitations |
| [Restoration checks](preservation.json) / [receipt index](receipt-index.json) | Exact source inputs, binary and raw-output hashes |
| [Runner](run.py) | Bounded execution with separate outside-observer opt-in |

Restore and verify the 202-input [round33 selected source](../sfcc-component-transaction/README.md),
then apply [Clamp-packet/candidate.patch](Clamp-packet/candidate.patch).
The selected source has 207 inputs. All seven archived executed patches target
that same base and must not be stacked. Every patch was restored into a fresh
directory and all input hashes checked. Binaries, raw build logs and repeated large
receipts remain under `.testresults/sfcc-critical-repairs/e4-invalid-construction/round34-ownership/`;
the receipt index identifies retained versus archived files.

## Next mathematical and validation steps

1. **Certify the whole first fan against the composed field.** Seek a common
   direction in which every potentially active source branch has a derivative
   bounded away from zero over a bounded slab. Opposite field signs on the slab
   ends plus that monotonicity can establish a unique root graph, even where the
   active max facet changes. Then prove coverage, boundary transport and an
   approximation bound for the entire triangle domain. If those conditions fail,
   retain the refusal and subdivide within the existing budgets. Do not replace
   the 12 unresolved probes or unexamined area with sampling assumptions.
2. **Design a complete bounded outside audit.** Establish valid containment or
   another conservative exclusion argument for remote generated geometry, and
   cover every relevant retained consumer and joined interface. The 375-cell ring
   cannot simply be folded into the current private transaction. Any streaming
   design needs explicit total-work and storage accounting; chunking is not
   permission to evade the existing total caps.
3. **Close the remaining replacement contract.** Preserve metadata from the actual
   replacement stage, not just this pregraph fixture, and account for remaining
   checker/diagnostic allocations. Keep production blocked until these and the
   surface/outside gates pass, then run native/WASM/GPU and full-model preservation.

Use the same three independent agents and fourth review. Production code is
unchanged; no browser or visual QA was performed.
