---
name: devserver
description: "Use when reading runtime logs, dumping the active scene source, capturing an agent testcase from the live editor, or rendering SDF/mesh PNGs headlessly. Two devservers run side-by-side: interactive (`make start`, `.devserver.run`) for the human's tab, and agent (`make start AGENT=true`, `.devserver.agent.run`) for headless Chromium — agents default to the agent port, read it from the run file, and never launch Chromium themselves. Endpoints: `/_logs`, `/_sceneSource`, `/_refresh`, `/_agent/capture-testcase`, `/_agent/render` (POST JSON), `/_agent/render/testcase-body` (POST YAML), `/_agent/render/testcase/<path>` (GET saved testcase). Mirror the human's session by piping `/_agent/capture-testcase` from the interactive port into `/_agent/render/testcase-body` on the agent port."
---

# Devserver HTTP / WebSocket bridge

Runtime log signal, a plain-text dump of the active CAD document, and agent automation that talks to a connected browser tab (Chromium with WebGPU) over HTTP + WebSocket on the same port.

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

**Disk paths for saved images:** server-owned imagelog lives at `.agents/imagelog/`. When you save PNGs yourself (`curl -o`, composites, copies), write under `.agents/testimages/` — never loose under `.agents/` root.

## When to use

- **Logs (`/_logs`):** validate runtime, check WebGPU / app errors, read dev log buffer without DevTools.
- **Scene source (`/_sceneSource`):** dump the active editor tab's full Monaco buffer (unsaved edits included).
- **Agent automation:** fetch a testcase YAML from the live editor, or render a PNG from a saved testcase file (GET), inline YAML (POST testcase-body), or inline JSON (POST). Each success also mirrors into `.agents/imagelog/`.

Use the **interactive** port to read what the human sees (`/_sceneSource`, `/_agent/capture-testcase`). Use the **agent** port for `/_agent/render*` and for `/_logs` after those headless renders — the interactive tab does not execute agent render RPCs.

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
- **200 + empty body** when no matches, no connected browser, or bridge timeout.
- Query params (`level`, `only`, `module`, `n`) documented in **AGENTS.md**. Default check uses no params (info threshold; no debug spam):

```bash
curl -sS "http://localhost:${port}/_logs"
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

### A — Single (headless only)

1. `make start AGENT=true` if `.devserver.agent.run` missing; read `port`.
2. Optional: `GET /_agent/capture-testcase` to snapshot the headless session.
3. Render via `GET /_agent/render/testcase/…`, `POST /_agent/render/testcase-body`, or `POST /_agent/render`. Save with `curl -OJ` (uses `Content-Disposition`) or read `.agents/imagelog/`. Custom save paths → `.agents/testimages/`. Omit viewport overrides for faithful replay.
4. Optional: `GET /_logs` on the same port.

### B — Mirror interactive → agent

When the human runs `make start` and you want the same scene + camera + viewport + `meshExport` + overlay flags rendered headlessly:

1. `user_port=$(jq -r .port .devserver.run)` — if missing, you can't capture their session.
2. Capture: `GET http://localhost:${user_port}/_agent/capture-testcase` (full snapshot). Use `/_sceneSource` only if you need text-only (no camera / export / overlays).
3. `make start AGENT=true` if `.devserver.agent.run` absent; `agent_port=$(jq -r .port .devserver.agent.run)`.
4. Render: pipe YAML to `POST .../_agent/render/testcase-body?mode=sdf|mesh`. For stats / diagnostics first, hit `/_logs` on `agent_port` and only open the PNG when the task needs pixels.
5. Iterate: `/_refresh` on `agent_port` after code changes, then re-capture (if user changed the doc) or re-POST.

```bash
user_port=$(jq -r .port .devserver.run)
agent_port=$(jq -r .port .devserver.agent.run)
curl -sS "http://localhost:${user_port}/_agent/capture-testcase" \
  | curl -sS -X POST "http://localhost:${agent_port}/_agent/render/testcase-body?mode=mesh" \
    -H "Content-Type: application/x-yaml" --data-binary @- -OJ

curl -sS "http://localhost:${agent_port}/_logs?module=MdcExport&level=debug"
```

**Each HTTP server has its own WebSocket client.** Dev Tools log-module checkboxes are per browser profile — `/_logs` `debug`/`info`/`warn` follows what's enabled in **that** tab (use `user_port` for the human's toggle mix, `agent_port` for the headless render itself).

### Standard check (`/_logs` and optional `/_sceneSource`)

1. Read `port` from `.devserver.agent.run` (agents) or `.devserver.run` (interactive). If missing for agents, start once and retry; otherwise stop.
2. `curl http://localhost:${port}/_logs` with no `level`/`only` (default info threshold — errors, warnings, info; no debug spam).
3. Optional: `curl -sS "http://localhost:${port}/_sceneSource"`. Empty body → confirm a tab is open on this devserver and a document tab is active.
4. Add `/_logs` query params only when you have a reason; if results are empty/narrow, **broaden** before concluding no signal.
5. Report relevant lines; note empty body explicitly.

---

## Notes

- `make build` / `make test` follow project rules; do not use `npm` / `npx` / `node` directly for builds.
- Cross-reference: **AGENTS.md** (devserver overview, log query parameters, agent automation summary).
