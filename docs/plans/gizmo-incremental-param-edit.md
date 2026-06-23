# Incremental param edits (skip the full rebuild for structure-preserving literal edits)

## Problem

Every gizmo release (and every keystroke) routes its change through the source → `build()`
pipeline. Even when the structural fingerprint is unchanged ("param-only" build), the worker
still does O(N) work per edit: `new SceneInfo(body)` re-evaluates the entire DSL, then
`packSceneParamsInto` / `packPreviewParamsInto` re-pack **all** nodes, `serializeSceneNodes`
re-serializes **all** nodes, and the main thread re-parses + re-matches. On a deep scene
(submersible ≈ 146 calls) that's the move/rotate latency the user feels. It is **not** a shader
recompile (post rot-field rollout, gizmo move/rotate keep the fingerprint stable — verified).

## Key invariant (why this is safe)

Param/preview slots are assigned by a **monotonic bump allocator** (`allocSceneParamFloats`,
`allocPreviewVec3/F32/Mat3`) advanced in `build()` traversal order. So a node's offset/slot is a
**pure function of scene structure** — independent of param *values*. For a structure-preserving
edit (the fingerprint is types + topology + preview layout, never values), every node lands on the
**same** slot it had last build.

Therefore: if an edit only changes a numeric literal inside an existing transform arg, we can write
the new value straight to that node's (stable, already-known) slot and the result is **bit-identical**
to what a full rebuild would produce. No re-eval, no full re-pack, no diff. The live drag preview
(`gizmoPreview` → `#patchPreviewVec3`/`#patchPreviewMat3`) already relies on exactly this; this plan
generalizes it to the *commit* path and to manual/undo edits.

Undo/redo need no special handling: undoing a param edit is itself a param edit (revert the literal),
so it flows through the same fast path. The incremental state never drifts — at every step it equals
a from-source rebuild — so there is no "must re-sync by point X".

## Trigger: classify the change, not its origin

CM6 undo/redo are fresh transactions that do **not** carry a gizmo tag, so we key off the change
content (this also covers a human typing a number into a `.shift(...)`).

`classifyParamEdit(changeSet, src, parse): { nodeId, kind: "translate"|"rotate", value: Vec3 } | null`

Eligible **only if** (conservative — when unsure, return null → full rebuild):
1. The change is a single contiguous edit (`changeSet` touches one range).
2. The replaced + inserted text is **numeric-literal-only** (digits, `.`, `-`, `+`, `e`, `,`,
   whitespace) — no identifiers, method names, brackets/parens added or removed, no arity change.
   This guarantees the structural fingerprint cannot change (sound without re-eval).
3. The edited range lies entirely within one transform's literal arg span, resolved via
   `SourceParser.findTransformTargetAtPosition(src, line, col)` — the same call the gizmo uses.
   The span must be the `shiftRange` (→ `translate`) or pre-shift `rotateRange` (→ `rotate`), and
   `shiftIsLiteral` / `rotateIsLiteral` must hold.
4. The transform target maps to **exactly one** scene node (via the existing
   `#sourceLocationMap` / `#findNodeIdAtPosition`). Ambiguous → null.

`value` = the parsed new literal (for rotate, the composed Euler the source will evaluate to). Use
the value the **source literal** evaluates to (post-`fmt` rounding), not a separate float, so
incremental ≡ rebuild exactly.

## Worker: a `paramPatch` message (reuse the gizmoPreview primitives)

Add to `MainToWorkerMessage` (render-worker-protocol.mts, next to `gizmoPreview`):

```ts
| { type: "paramPatch"; nodeId: number; kind: "translate" | "rotate"; value: [number, number, number] }
```

Handler in render-worker-core.mts (mirrors `gizmoPreview`, addressed by nodeId, no drag state):

```ts
paramPatch(msg): void {
  const node = this.#scene?.get(msg.nodeId)
  if (!node) return                      // structure moved under us → caller should full-rebuild
  if (msg.kind === "translate") {
    setNodeTranslation(node, msg.value)
    if (node.previewVec3Slot >= 0) this.#patchPreviewVec3(node.previewVec3Slot, msg.value)
    else this.#repackAndUploadParams()   // fallback (should not happen post-rollout)
  } else {
    setNodeRotation(node, msg.value)
    if (node.rotPreviewMat3Slot >= 0)
      this.#patchPreviewMat3(node.rotPreviewMat3Slot, eulerMatrices(...node.rot).inv)
    else if (node instanceof Rotate && node.previewMat3Slot >= 0) { /* fwd+inv */ }
    else this.#repackAndUploadParams()
  }
  this.#forceNextRender = true
}
```

The interactive viewport's preview SDF is compiled in preview mode (`pp_*` accessors), so patching
the preview banks is what the live render reads — exactly as `gizmoPreview` already does. The scene
storage banks are not touched; that is fine because mesh export re-transpiles from source (its own
full build), so it always reads the current literal.

## Main-thread reconcile (cheap, O(1) in scene size)

On an eligible change, instead of `build()`:
1. Post `paramPatch`. (For a gizmo release the preview patch is already applied from the drag, so
   this is idempotent; for a manual/undo edit it applies it fresh.)
2. Update the moved node's cached transform in `#sceneNodeMap` (NodeStub `pos`/`rot`) so the gizmo's
   `getNodeTranslation` and re-anchor read fresh values.
3. Remap `#sourceLocationMap` offsets through the changeset (`change.changes.mapPos`) — the literal's
   length may have changed. Node ids/structure are unchanged, so the rest of the map stays valid. CM6
   maps decoration (color-indicator) positions automatically.
4. Re-anchor the gizmo: `#updateGizmoForSelection()` (a cheap `getNodeBounds` round-trip) — needed
   because a rotate can shift the bbox center for an off-pivot primitive.
5. `requestRender()`.

This replaces the gizmo's current `#pendingGizmoReselect` + debounced rebuild for the param-only case.

## Fallback gate

`classifyParamEdit` returns null → existing `build()` path (full or fingerprint-param-only). This
covers: structural edits (node add/remove, `translate(...)` wrap, rotating a non-rot-field node),
variable/expression args, multi-node or ambiguous edits, and the initial load. The incremental path
requires a prior successful full build (worker has `#scene` + slots); the first build and any
structural edit re-establish that baseline. Drift-free because the fallback always rebuilds from
source.

## Risks

- **Classifier soundness is critical.** A false-positive (structural edit treated as incremental)
  corrupts state. Mitigation: the numeric-literal-only check (rule 2) makes structure-change
  impossible by construction; keep the classifier conservative and bias to full rebuild.
- **Node-mapping ambiguity** → full rebuild (rule 4).
- **Precision drift** → patch with the rounded source-literal value (above).
- **Feature-graph overlay** is refreshed on full builds only; incremental edits leave it stale until
  the next full build. Acceptable for a debug overlay; document it. (Optional later: incremental FG.)
- **`#scene.get(nodeId)` miss** in the worker (structure changed unexpectedly) → the handler no-ops;
  the main thread should treat a missing node as "fall back to full build next time".

## Phased plan + verification

1. **Worker `paramPatch`** — message + handler reusing the patch primitives. Verify: a paramPatch
   updates the render with no rebuild (log shows no `scene build`), geometry matches the equivalent
   source value.
2. **Classifier** (`classifyParamEdit`) — pure function over the CM6 ChangeSet + parse. Unit-test:
   gizmo shift edit, gizmo rotate edit, undo, redo, manual number edit (eligible); variable-arg edit,
   add/remove a `.method`, the `translate(...)` wrap, multi-range edit (→ null).
3. **Wire into `docChange$`** — eligible → incremental reconcile (skip `build()`); else `build()`.
   Fold the gizmo's reselect into the reconcile.
4. **Verification:**
   - **Drift-free test:** apply N incremental edits, then force a full build, assert the packed
     scene + preview param buffers are bit-identical.
   - **Latency:** move/rotate release on submersible drops from the O(N) param-only rebuild
     (`scene build param-only (ms)` log) to a constant-time patch.
   - **Correctness:** undo/redo round-trips; structural edits still full-rebuild; mesh export
     unaffected.

## Out of scope

General incremental for arbitrary edits (typing that adds/removes nodes) — that needs a re-eval +
tree diff (saves pack/serialize, not re-eval) and is a much larger, riskier change. This plan is the
structure-preserving-literal fast path only.
