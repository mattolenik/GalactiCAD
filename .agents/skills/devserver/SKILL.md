---
name: devserver
description: "Use when reading runtime logs, dumping the active scene source, capturing an agent testcase from the live editor, or rendering SDF/mesh PNGs headlessly. Two devservers run side-by-side: interactive (`make start`, `.devserver.run`) for the human's tab, and agent (`make start AGENT=true`, `.devserver.agent.run`) for headless Chromium. **Prefer `scripts/agentcli`** over raw curl for everything except niche cases — it wraps every endpoint with structured errors, auto-cleanup, and shared helpers (`render --yaml`, `capture`, `mirror`, `iterate`, `ab`, `compare`, `triangle`, `regress`, `logs`, `server`). Drop to curl only when agentcli has no subcommand (rare). Endpoints: `/_logs`, `/_sceneSource`, `/_refresh`, `/_agent/capture-testcase`, `/_agent/render` (POST JSON), `/_agent/render/testcase-body` (POST YAML), `/_agent/render/testcase/<path>` (GET saved testcase)."
---

# Devserver HTTP / WebSocket bridge

Runtime log signal, a plain-text dump of the active CAD document, and agent automation that talks to a connected browser tab (Chromium with WebGPU) over HTTP + WebSocket on the same port.

## Use `scripts/agentcli` first

`scripts/agentcli` wraps every devserver endpoint with structured errors, auto-cleanup, the `--set` YAML override syntax, and shared workflow helpers. **Default to it for every devserver interaction.** Drop to raw curl only when no subcommand fits (see "When to skip the wrapper" below).

| Operation | agentcli command | Underlying HTTP |
|---|---|---|
| Render a saved testcase | `agentcli render <testcase>` | `GET /_agent/render/testcase/<path>` |
| Render inline YAML (file or stdin) | `agentcli render --yaml PATH\|-` | `POST /_agent/render/testcase-body` |
| Render with knob overrides | `agentcli render … --set k.path=v` (repeatable) | POST (mutated YAML) |
| Render multiple testcases (batch) | `agentcli sweep <tc>... --tag NAME` | N × `GET /_agent/render/testcase/...` |
| Snapshot the live editor session | `agentcli capture [--output PATH] [--port interactive\|agent]` | `GET /_agent/capture-testcase` |
| Mirror human's scene to agent | `agentcli mirror [--set ...]` | capture + POST (one command) |
| Inner loop after a code edit | `agentcli iterate <tc> [--against baseline.png] [--fail-below 99]` | refresh + render + compare |
| A/B variant comparison | `agentcli ab <tc> --a-set ... --b-set ...` | two renders + compare |
| SDF vs mesh round-trip | `agentcli triangle <tc> [--yaml] [--set]` | two renders + SSIM |
| Single-pair compare | `agentcli compare a.png b.png [--json] [--open]` | local SSIM/pixel-diff |
| Batch compare | `agentcli regress … --baseline-tag B --post-tag P` | pre-rendered SSIM/pixel-diff |
| Read logs | `agentcli logs [--agent\|--browser] [--module M] [--level L] [--n N]` | `GET /_logs` |
| Server lifecycle | `agentcli server start\|stop\|restart\|refresh\|status` | `POST /_refresh` + make |

**Cross-cutting flags** supported by render / iterate / ab / mirror / triangle:

- `--yaml PATH|-` — ephemeral YAML body instead of a saved testcase (`-` reads stdin).
- `--set key.path=value` — mutate the YAML before rendering. Repeatable. Dotted full path (e.g. `meshExport.mdcExportLevers.adaptiveEnabled=false`). Coerces `true`/`false`/numbers/`null`; everything else is a string.
- `--overlay name=val,…` — mesh overlay flags as comma-separated `k=v` pairs.
- `--mode mesh|sdf` — defaults to mesh for the render-flavored commands.

Exit codes: 0 success • 1 verdict failure (compare below threshold, regression) • 2 usage error • 3 devserver unreachable • 4 diff tool failure. The script auto-starts the agent devserver if needed (but never the interactive one — that's the human's session).

### When to skip the wrapper

Use raw curl only for things agentcli doesn't expose:

- `GET /_sceneSource` — there's no `agentcli sceneSource`; one-off, low value to wrap.
- `POST /_agent/render` with hand-built JSON — agentcli's render flows route through `testcase-body` (YAML); JSON POST is rarely needed because YAML achieves the same with less ceremony.
- Highly custom query params that aren't `--mode/--width/--height/--overlay/--label/--role`.

Everything else: use agentcli. The wrapper's value isn't just terseness — it's auto-cleanup, error-body surfacing on failures, `--set` mutation, and shared workflow chains that would be 3-5 lines of bash each time.

## Two devservers

| | Interactive (human) | Agent (headless) |
|---|---|---|
| Start | `make start` | `make start AGENT=true` |
| Run file | `.devserver.run` | `.devserver.agent.run` |
| Logs | `make logs` | `make logs AGENT=true` |
| Stop | `make stop` | `make stop AGENT=true` |
| Browser | User's Chromium tab | Headless Chromium (auto-started) |

**Agents default to `AGENT=true`.** Read `port` from the matching run file: `port=$(jq -r .port .devserver.agent.run)`. If the file is missing or `jq` fails, the server is not running — **do not guess a port**; start it (agents only) and retry once, otherwise stop.

**Do not launch Chromium / Chrome yourself.** `AGENT=true` starts headless Chromium for the bridge.

### Disk paths — **NEVER write to the repo root**

**Hard rule:** never create files at the top level of the repo. No `mktemp` defaults, no `curl -o output.png`, no `cat > /Users/matt/galacticad/scene.yaml` — **nothing** lands at the repo root. If the natural default for a tool would put a file there, change the path.

This is non-negotiable. Even "I'll delete it in a second" tmpfiles must use one of the locations below.

| Purpose | Where to save | Notes |
|---|---|---|
| **Scratch** — intermediate YAML, debug dumps, generated payloads | `.agents/tmp/` | **Default for ad-hoc work.** Create with `mkdir -p .agents/tmp` if missing; wipe-safe. |
| **Ad-hoc renders** — composites, manual `curl -o`, screenshots being analyzed | `.agents/testimages/` | `agentcli render` / `triangle` / `sweep` save here by default. |
| **Formal test outputs / baseline PNGs** consumed by path | `.testresults/` | Long-lived references other commands compare against. |
| **True ephemera** that doesn't need to live in the repo | `/tmp/…` | OS-managed; outside the repo entirely. |

**Hands off:**
- `.agents/imagelog/` — devserver-owned; the server writes here on successful renders. Read it, don't write to it.
- `.agents/` itself (the directory, not its subdirectories) — holds skills and infrastructure. Always nest into one of the subdirectories above; never drop a loose file directly under `.agents/`.

## When to use

- **Logs (`/_logs`):** validate runtime, check WebGPU / app errors, read dev log buffer without DevTools.
- **Scene source (`/_sceneSource`):** dump the active editor tab's full Monaco buffer (unsaved edits included).
- **Agent automation:** fetch a testcase YAML from the live editor, or render a PNG from a saved testcase file (GET), inline YAML (POST testcase-body), or inline JSON (POST). Each success also mirrors into `.agents/imagelog/`.

Use the **interactive** port to read what the human sees (`/_sceneSource`, `/_agent/capture-testcase`, and `/_logs` via `agentcli logs --browser`). Use the **agent** port for `/_agent/render*` and for `/_logs` after those headless renders (`agentcli logs --agent`, the default) — the interactive tab does not execute agent render RPCs.

## Bridge behavior (single tab)

All RPCs are routed over WebSocket to the **first connected OPEN client**, not broadcast. With multiple tabs on one devserver, only one receives each request — avoid parallel conflicting automation.

After local code changes, the interactive browser may livereload; the **agent** headless tab does **not**. Hit `GET` or `POST /_refresh` on the agent port before re-rendering.

---

## `GET /_sceneSource`

- `GET` only; other methods → **405** with `Allow: GET`. No query params.
- Response: `text/plain; charset=utf-8` — full Monaco model value for the active tab, unsaved edits included.
- Backed by `globalThis.__galacticadDevGetActiveSceneSource()` via WebSocket.
- **200 + empty body** when: no connected tab, bridge timeout (~5s), getter throws, no editor model, or app wasn't loaded through this devserver's injected bridge.
- CORS: `Access-Control-Allow-Origin: *` on success and 405.

```bash
curl -sS "http://localhost:${port}/_sceneSource"
curl -sS "http://localhost:${port}/_sceneSource" -o scene-dump.js
```

---

## `GET /_logs`

- Response: plain text, one buffer line per line — full lines as stored (`[timestamp] [level] [Module] [thread] message`), unmodified.
- **Module toggles vs errors:** `log("Module").error` always goes to console + ring buffer regardless of Dev Tools checkboxes. `debug` / `info` / `warn` from `log("Module")` only appear when that module is enabled. `?module=…` still filters by entry's `module` field — errors from other modules are omitted when a non-empty `module` list is used.
- **200 + empty body** when a connected tab returns an empty buffer (no matches / module or level filter matched nothing). **503** on no connected browser or bridge timeout (so callers can tell "no tab" apart from "0 entries").
- Query params (`level`, `only`, `module`, `n`) documented in **AGENTS.md**. Raw curl with no params uses the info threshold (drops `debug`, no spam). Prefer **`scripts/agentcli logs`**: it selects the devserver with **`--agent`** (default, `.devserver.agent.run`) or **`--browser`** (`.devserver.run`), and defaults to **all levels (debug+)** so enabled modules aren't dropped.

```bash
curl -sS "http://localhost:${port}/_logs"          # raw: info threshold
scripts/agentcli logs --browser                     # human tab, all levels
```

---

## `GET /_agent/capture-testcase`

Serializes current scene + camera + mesh export settings into YAML (same schema as Dev Tools **Export agent testcase**), via `exportAgentTestcase` → `__galacticadExportAgentTestcase`. Requires a connected browser tab with an active document.

- **200** + `application/x-yaml`, or **503** on no browser / timeout / capture failure.

```bash
curl -sS "http://localhost:${port}/_agent/capture-testcase" -o testcase.yaml
```

**Testcase format (disk / capture):** root mapping with `schemaVersion: 1`, multiline `source` (scene body UTF-8, e.g. `.gcad`), `camera`, `viewCenter`, `resolutionScale`, `viewportWidth`, `viewportHeight`, optional `previewUvRect`, `meshExport`, optional `meshOverlay` (mesh-viewer debug toggles), optional `documentName` (provenance only). Impl: `src/agent-autotest/agent-testcase.mts` (`parseAgentTestcaseYaml`, `serializeAgentTestcaseYaml`, `AgentRenderRequest`).

---

## Agent render: `/_agent/render*`

Runs the agent render pipeline in the browser (normal-vector **SDF** preview **or** **mesh** export + opaque normal RGB). WebSocket `agentRender` → `globalThis.__galacticadAgentRender`. Success: `image/png`. Requires connected Chromium tab with WebGPU.

**Errors (plain text body):** **400** on pipeline / scene / validation error or invalid JSON / YAML. **503** on no tab / timeout / delivery failure. **404** on GET testcase when file missing (body includes relative + resolved path).

**Success headers:** `Content-Type: image/png`, `Content-Length`, `Access-Control-Allow-Origin: *`, `Access-Control-Expose-Headers: Content-Disposition`, `Content-Disposition: attachment; filename="<basename>-<mode>.png"` (basename = testcase stem for GET, derived from POST `testcase` path, or `render` for bare POST; `<mode>` = `sdf` or `mesh`). `curl -OJ` picks this up.

**Imagelog:** server writes `repo/.agents/imagelog/<label>-<HHMM>-<role>.png` on success (`label`/`role` from query or POST extras).

### `POST /_agent/render` (exact path)

JSON body matching `AgentRenderRequest`: `mode` (`"sdf"`|`"mesh"`), `sourceBase64`, `camera`, `viewCenter`, `resolutionScale`, `viewportWidth`, `viewportHeight`, `meshExport`, optional `previewUvRect`, optional `documentName`, optional `meshOverlay` (mesh-only debug glyphs/markers; see `AgentMeshOverlay`).

**POST-only extras** (stripped before dispatch): `label`, `role`, optional `testcase` (relative path under `test/testcases/`, used only for `Content-Disposition` basename).

```bash
curl -sS -X POST "http://localhost:${port}/_agent/render" \
  -H 'Content-Type: application/json' -d @payload.json -OJ
```

### `GET /_agent/render/testcase/<relative>`

`<relative>` is under `./test/testcases/` (from devserver cwd, usually repo root). Segments may be percent-encoded. `..`, empty segments, absolute paths → **400**. Read as UTF-8 YAML; parsed with `parseAgentTestcaseYaml` (prefer `.yaml`).

**Query:**
- `mode=sdf|mesh` (default `sdf`).
- `viewportWidth`, `viewportHeight` — **override** the testcase YAML; **omit** for faithful replay unless the user asks for a different size.
- `label`, `role` for imagelog (defaults from filename / mode).
- **Mesh-overlay flags** (`mode=mesh` only; accept `1`/`true`/`yes`/`on`, otherwise off): `debugPoints` (raw per-edge sample squares), `glyphLine` / `glyphCorner` / `glyphSeam` / `glyphRing` (per-class feature glyphs), `cellVertices` (per-cell-component vertex markers, MDC QEF debug), `qefPlanes` (per-(cell,component) QEF input plane normals as short blue sticks). Each also accepts the dotted API alias (`mdcDebugPoints`, `featureGlyphs.line`…, `mdcCellVertices`, `mdcQefPlanes`). Overlays default off; any overlay query flag replaces the whole overlay from testcase YAML.

Merged via `parseAgentTestcaseYaml` + `mergeAgentRenderRequest` (base64 from `source`; does not inject testcase `documentName` into wire payload).

```bash
# clean mesh
curl -sS -OJ "http://localhost:${port}/_agent/render/testcase/meshing/polygon-twisted.yaml?mode=mesh"

# per-cell vertex markers + QEF plane normals (diagnoses single-cell chips after crease-split)
curl -sS -OJ "http://localhost:${port}/_agent/render/testcase/meshing/polygon-twisted.yaml?mode=mesh&cellVertices=1&qefPlanes=1"
```

`GET /_agent/render` with no testcase path → **400** with hint to use `/_agent/render/testcase/...`.

### `POST /_agent/render/testcase-body`

Inline testcase YAML (same schema as `/_agent/capture-testcase`) without writing to `test/testcases/` and without building JSON `sourceBase64`. Used to pipe an interactive capture into the agent stack. Raw UTF-8 YAML body (any `Content-Type`). Same query params (mode / viewport / label / role / overlay flags) and same 200 / 400 / 503 behavior as the other render routes.

---

## Workflows

All workflows are stated in terms of `agentcli` first. The underlying HTTP is documented in the sections above for reference; you almost never have to call it directly.

### A — Render a saved testcase

```bash
scripts/agentcli render meshing/mdc/twisted-l-500 --tag baseline --mode mesh
# meshing/mdc/twisted-l-500  mesh  HTTP=200  bytes=…  saved=.agents/testimages/twisted-l-500-baseline-mesh.png
```

- The agent devserver auto-starts if not running.
- Output lands under `.agents/testimages/` with a derived filename. Use `--out PATH` to override.
- Add `--overlay glyphLine=1,cellVertices=1` for mesh overlays (mesh mode only).
- Add `--set meshExport.mdcExportLevers.adaptiveEnabled=false` (repeatable) to flip knobs without editing the testcase YAML.

### B — Mirror the human's session to agent

When the human is iterating in their browser and you want to replay their exact scene + camera + meshExport + overlay flags headlessly:

```bash
scripts/agentcli mirror --tag mirrored --mode mesh
# captures from interactive devserver, refreshes agent, renders on agent
```

- Auto-captures `/_agent/capture-testcase` from the interactive port, refreshes the agent tab, then POSTs to `/_agent/render/testcase-body` on the agent port.
- Pass `--set k.path=value` to override captured fields before rendering (e.g. `--set meshExport.mdcExportLevers.adaptiveEnabled=false`).
- Pass `--keep-yaml /tmp/x.yaml` to save the captured (post-`--set`) YAML for later re-runs without re-capturing.
- Fails with HTTP 503 if the human's browser tab is disconnected — open the app in the human's browser first.

If you only need the captured YAML (no render): `agentcli capture --output /tmp/snap.yaml`.

### C — Inner loop: edit code → re-render → check against baseline

After every shader/host edit, the agent tab needs `/_refresh` before the next render uses the new code. `iterate` does that for you:

```bash
scripts/agentcli iterate meshing/mdc/twisted-l-500 \
    --against .agents/testimages/twisted-l-500-baseline-mesh.png \
    --fail-below 99 --tag head
```

- Refreshes agent tab → renders → SSIM-compares to the baseline → exits 1 if below threshold, 0 otherwise.
- Drop `--against` for a refresh+render alone (no compare).
- Works with `--yaml`/`--set`/`--overlay` like every other render-flavored command.

### D — A/B knob comparison

Render the same scene twice with different overrides and compare automatically:

```bash
scripts/agentcli ab meshing/mdc/twisted-l-500 \
    --a-set meshExport.mdcExportLevers.adaptiveEnabled=true  --a-tag adapt-on \
    --b-set meshExport.mdcExportLevers.adaptiveEnabled=false --b-tag adapt-off
# saves both PNGs (tagged), prints SSIM + diff PNG path
```

- Both variants share the same `--width/--height/--overlay/--mode`; only the `--a-set` / `--b-set` overrides differ.
- For stdin: `cat scene.yaml | agentcli ab --yaml - --a-set ... --b-set ...` (caches stdin once so both renders use the same source).

### E — Inline YAML render (one-off scenes)

For scenes that don't live in `test/testcases/` (regression repros, generated YAML, stdin pipes):

```bash
scripts/agentcli render --yaml /tmp/repro.yaml --tag repro
cat scene.yaml | scripts/agentcli render --yaml - --tag from-stdin
```

POSTs to `/_agent/render/testcase-body`. The summary line uses `inline` as the stem when reading stdin.

### F — Read logs + scene source

```bash
scripts/agentcli logs                      # default: ALL levels (debug+) from the agent tab
scripts/agentcli logs --browser            # read from the interactive (human) devserver instead
scripts/agentcli logs --module MdcExport   # filter (must be enabled in DevTools for that tab)
scripts/agentcli logs --level warn --n 200 # narrow to warnings+errors
```

- `--agent` (default) reads from the agent devserver (`.devserver.agent.run`), auto-starting it if needed. `--browser` reads from the interactive/human devserver (`.devserver.run`); that server is never auto-started, so `logs --browser` errors if `make start` isn't running.
- **`agentcli logs` defaults to all levels (debug+)**, unlike a raw `curl …/_logs` which uses the server's info threshold and silently drops `debug`. Module output (`log("X").debug(...)`) is mostly debug, so the info threshold makes an enabled module look empty. Pass `--level warn` etc. to narrow.
- Empty output is **ambiguous**: it can mean no entries, the requested module/level isn't enabled in that tab's DevTools, OR **no browser tab is connected to that devserver** (same as a timeout). If `/_sceneSource` is also empty for that port, no tab is connected — open/refresh a tab before concluding "no signal".
- Dev Tools log-module checkboxes are per browser profile. `/_logs` reflects what's enabled in **that** tab — use `agentcli logs --browser` for the human's mix, `agentcli logs --agent` (the default) for the headless render itself.

For raw scene text (no camera / export / overlays), no agentcli wrapper exists — drop to curl:
```bash
user_port=$(jq -r .port .devserver.run)
curl -sS "http://localhost:${user_port}/_sceneSource"
```

---

## Guidelines

1. **Reach for `scripts/agentcli` first.** It wraps every endpoint with structured error handling, tmpfile cleanup, the `--set` mutation syntax, and chained workflows. If you find yourself writing `curl ... /_agent/...`, check `agentcli --help` first — the wrapper almost certainly already does what you want with one line instead of three.

2. **Don't chain raw curl calls when a single wrapper command exists.** Don't write `curl /_refresh && curl /_agent/render/... && agentcli compare` when `agentcli iterate --against` does the same thing with proper exit codes and error propagation.

3. **Use `--set` instead of `sed`/`cp` for YAML mutation.** The `--set meshExport.mdcExportLevers.adaptiveEnabled=false` flow handles type coercion (`true`/`false`/numbers/`null`), creates missing intermediate keys, and lives at the right nesting level. Sed-based YAML editing on top-level keys is a footgun (creates duplicate keys instead of mutating the nested one).

4. **Use the agent port for renders / logs after your own edits.** The interactive devserver runs the human's session — `agentcli mirror` reads from it but writes nowhere. Render workflows live entirely on the agent port (which auto-starts), and `agentcli logs` defaults to it. Reach for `agentcli logs --browser` only when you specifically need what the human's tab is emitting.

5. **Pair SSIM with pixel diff and the diff PNG.** `agentcli compare` reports all three; never quote a single number when judging visual change. See the `sdf-mesh-diff` skill.

6. **Don't auto-start the interactive devserver.** It belongs to the human. If `agentcli capture` reports the interactive devserver isn't running, ask the human to `make start` (or capture from the agent if you really need the headless tab's state).

7. **Never write to the repo root.** Not even tmpfiles. Use `.agents/tmp/` for scratch (default), `.agents/testimages/` for renders, `.testresults/` for baselines, or `/tmp/` for true ephemera. See the disk-paths table at the top of this skill.

8. **`make build` / `make test` follow project rules; do not use `npm` / `npx` / `node` directly for builds.**

## Notes

- Cross-reference: **AGENTS.md** (devserver overview, log query parameters, agent automation summary).
- agentcli source: [scripts/agentcli](scripts/agentcli). All subcommands have `--help` with full option lists.
