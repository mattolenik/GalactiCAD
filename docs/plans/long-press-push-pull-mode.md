# Long-press push/pull mode (touch + remote viewer)

Status: IN PROGRESS (2026-10-03). Decisions taken, see bottom. Baseline: `b11445a` (first long-press cut, to be reworked), probe hook uncommitted in the working tree (`__galacticadDevGetPushPullState`).

## Target UX

1. **Tap** a surface → it is selected (cross-hatch). Unchanged.
2. **Long-press** (400 ms, ≤ 8 px travel) on the *selected, push/pull-eligible* surface → the app **enters push/pull mode** (dot dither). Nothing moves during the hold; releasing the finger does nothing.
3. While in mode, **any drag** on the canvas performs the push/pull of that surface. The mode **persists** after each drag, so the surface can be pushed repeatedly.
4. **Double-tap off the surface** (or Escape, or selecting something else) **exits** the mode. The deferred rebuild runs on exit (today's behaviour for face selections).
5. Identical behaviour natively on the phone, on desktop with a held mouse button, and through `/_remote` (CDP-injected touch).

## Findings from the headless probes (agent devserver, CDP touch = the remote path)

| Surface (tap → long-press) | Result today | Why |
|---|---|---|
| Extrude **side** | selects + activates | works headlessly; see "sides on device" below |
| Extrude **cap** (virtualCap) | selects + activates | — |
| Loft **cap** (polygon2d → loft parent) | selects + activates | — |
| Loft **side** | no face selection, nothing | `PushPullController` has **no side push/pull for lofts** at all (`selectFace` / `highlightSideFace` are `Extrude`-only); shift-hold fails identically |
| Lathe, box/cylinder/cone faces | nothing | not push/pull hosts (primitive faces are highlight-only) |
| Edge / corner / ring / polyline feature hits | nothing | the tap selected a **feature**, not a face (`lastClickedId = 0`) |

**Sides on device, leading hypothesis:** in *auto* mode a fingertip tap near a side's edge lands on an edge/corner feature (worker FeatureGraph hit-test has priority over the face), so no face gets selected and the long-press has nothing to promote. Caps are wide, sides are narrow → caps "work", sides "don't". On the phone the selection readout will show `corner [n]` / `edge [n]` after such a tap. Needs on-device confirmation (Phase 0).

**Camera moves while dragging (bug, confirmed by reading):** `#completeLongPress` sets `controls.isDragging = false` and then calls `pp.handlePointerDown`, which sets `controls.isDragging = true` again — while the camera's `#dragMode = "rotate"` and `#primaryPointerId` (armed by the same pointerdown) are still live. The camera therefore orbits with the push/pull drag. The shift path never has this problem because the camera never owns that pointer. In the new UX the hold never starts a drag, and the subsequent drag's pointerdown is consumed by the existing active-mode capture handler before the camera arms — so the bug disappears structurally; the hold itself must still hand the pointer back cleanly (Phase 2).

**Commit model (good news):** `App` defers rebuilds while `renderer.isPushPullActive` (any face selection, highlight-only included) and rebuilds on `pushPullExit$` (= controller `deselect`). So a persistent mode needs **no** rebuild between drags: each `handlePointerUp` commits to source, live buffers already show the result, and the mode is simply re-promoted. The rebuild happens once, on exit.

## Design

### A. One gesture recogniser for the preview canvas (`src/interaction/canvas-gestures.mts`)

Pointer-event based (pointerType-agnostic), capture-phase on the canvas, no reliance on browser gestures (CDP-injected touches get none; iOS does not fire `dblclick` for touch):

- `tap` — down/up ≤ 300 ms, ≤ 8 px, single pointer.
- `doubleTap` — two taps ≤ 350 ms apart, ≤ 25 px apart.
- `longPress` — single pointer held ≥ 400 ms, ≤ 8 px travel, no modifiers; cancelled by movement, a second pointer, pointerup/cancel/lostpointercapture.

Emits `{ kind, clientX, clientY, pointerId, pointerType }`. Replaces the ad-hoc `#armLongPress/#cancelLongPress` timers added in `b11445a` and gives double-tap its own, device-independent source (the `dblclick` path stays for mouse users but is ignored while in push/pull mode to avoid double-firing through the remote viewer's `clickCount: 2` synthesis).

### B. One eligibility resolver (`SDFRenderer.#resolvePushPullTarget`)

Today the same `extrude | virtualCap | polygon2d → cap parent` branching is duplicated in `#highlightFaceAt` and `#handleObjectDoubleClick`. Fold both into:

```
#resolvePushPullTarget(nodeId, hitPos) →
  | { kind: "side", node: Extrude, hit }                   // extrude side (twist handled by controller)
  | { kind: "cap",  node: Extrude|Loft|ThreadedRod, isTop } // via virtualCap / polygon2d cap parent
  | null                                                    // not eligible (loft side, lathe, primitive, feature)
```

Used by: tap highlight (`highlightSideFace` / `highlightCapFace`), activation (`selectFace` / `selectCapFace` / `promoteToActive`), and the long-press verification ("is the press on the selected eligible surface?"). Adding a new eligible type (loft sides, Phase 5) then touches exactly one place plus the controller.

### C. Mode state in `SDFRenderer`

- `#pushPullMode: "off" | "armed"` (armed = entered via long-press; sticky). Shift-hold keeps today's transient semantics (drops to highlight on release) — the two coexist; a sticky mode is simply not dropped.
- Enter (long-press verified on selection): `promoteToActive()` or `#tryActivatePushPullFromSelection()` → `#cancelBuildsForPushPull()` → `#pushSelectionInfo()`; **no** `handlePointerDown`. Camera handoff: `controls.isDragging = false` *and* ask the camera to abandon the armed pointer (new `CameraController.cancelDrag(pointerId)` that clears `#dragMode/#primaryPointerId/#hasDragged`), then `navigator.vibrate?.(15)`.
- Drag: existing active-mode capture handlers (`pointerdown → handlePointerDown`, `pointermove`, `pointerup → handlePointerUp` → commit). After `handlePointerUp`'s `dropToHighlight()`, if `#pushPullMode === "armed"`: `promoteToActive()` again (the face/cap is re-resolved from the controller's own highlight state; no rebuild has happened, so node objects are still valid).
- Exit → `#exitPushPullMode()`: `#pushPullMode = "off"`, `pp.deselect()` (fires `onDeselect` → `pushPullExit$` → deferred rebuild). Triggers: `doubleTap` whose pick does **not** resolve (through the face-highlight sentinel) to the active node; Escape (already routed to `handleKeyDown`); any selection change / click that deselects (`#handleClickResult` with `clickedId === 0` already calls `deselect`); selection-mode switch away from face/auto; new build from an external source edit.
- A double-tap **on** the active surface is a no-op. A plain tap off the surface while in mode currently deselects via `#handleClickResult` → that would exit the mode on a stray tap; gate: while `armed`, taps that land off the surface are swallowed (keep the mode), only double-tap exits. (Decision point, see Open questions.)

### D. Status / affordance

- `#pushSelectionInfo()` after entering and after each re-promotion so the readout shows the active mode (today it is pushed *before* `handlePointerDown`, so it reads "slide" during a drag).
- Readout tag `push/pull mode` while armed; the remote HUD needs nothing new.

### E. Remote viewer

No protocol changes. Long-press, drag and double-tap all arrive as raw touch and are recognised in the app. Keep the server's tap→click synthesis (selection) and its `clickCount: 2`; the app ignores `dblclick` while in mode (A), so the double-tap exit fires exactly once from the pointer recogniser.

## Phases

**Phase 0 — instrument + confirm on device (no behaviour change).** Commit the devserver-only `__galacticadDevGetPushPullState` hook (already in the tree) and keep the headless probe (`eligibility-probe.mjs`, to move under `scripts/`). On the phone: tap a side, read the selection readout. If it says `corner`/`edge`, the sides issue is the auto-mode feature snap (→ Phase 4), not the long-press.

**Phase 1 — gesture recogniser (A).** New module + unit-style headless test via CDP touch (tap / double-tap / long-press / cancel-by-move / cancel-by-second-finger). Replace `#armLongPress` timers with it; keep behaviour otherwise.

**Phase 2 — mode semantics (C) + camera handoff.** Enter-on-hold without drag, sticky re-promotion after each commit, exit on double-tap-off / Escape / selection change, `CameraController.cancelDrag`. Verify headlessly: hold → `active && !dragging`; release → still active; drag → source rewritten; second drag → rewritten again, still active; double-tap off → inactive and rebuild fires once; camera matrix unchanged across the whole sequence (compare `controls.viewTransform` before/after).

**Phase 3 — eligibility resolver (B).** Pure refactor of `#highlightFaceAt` / `#handleObjectDoubleClick` onto `#resolvePushPullTarget`; probe table must be byte-identical.

**Phase 4 — touch-friendly selection (sides on device).** If Phase 0 confirms feature snap steals the tap: for `pointerType === "touch"` taps in auto mode, prefer the face when the hit is within the snap radius of an edge *and* the object under the finger is push/pull-eligible; or reduce the snap radius for touch. Decision needed (see below). Mouse behaviour unchanged.

**Phase 5 (optional, separate decision) — loft side push/pull.** Not a long-press issue: the controller has no loft side faces. A side of a loft is a ruled strip between the matching edge of each section, so "pushing" it means offsetting that edge in *every* section. Only well-defined when all sections have the same vertex count (`loft.sections(square, triangle)` in the sample does not). Proposal: eligible iff equal counts; `selectLoftSide(loft, hit)` picks the edge by un-projecting the hit into the nearest section's profile; drag writes all section polygon buffers (same path as extrude slide, N times) and commits N polygon rewrites. Everything else stays ineligible and the long-press simply does nothing, as today.

## Decisions (Matt, 2026-10-03)

1. **Stray single taps off the surface are allowed** and keep the mode; **only double-tap (or Escape / explicit deselect) exits.**
2. **Long-press is touch-only** (pointerType `touch` / `pen`). A held mouse button does nothing special; **mouse keeps shift-hold.**
3. Phase 4 approach: open until Phase 0 is confirmed on device. Context: the worker's auto-mode feature pick wins within `lineWidth + 10 px` of a corner and `lineWidth/2 + 3 px` of an edge chain (`#fgPickThresholdPx` / `#fgEdgePickThresholdPx` in `render-worker-core.mts`); "shrink for touch" = smaller bands when the pointer is a finger, "face-first" = keep the bands but let the surface win when the object under the finger is push/pull-eligible.
4. **Phase 5 (loft sides) deferred.**
