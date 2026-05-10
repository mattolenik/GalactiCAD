---
name: devserver
description: "Local devserver: GET /_logs, GET /_sceneSource, agent render (JSON, YAML testcase-body, GET testcase file), WebSocket bridge. Mirror interactive session via .devserver.run capture + .devserver.agent.run render. make start-agent — do not launch Chromium yourself."
---

# Devserver HTTP / WebSocket bridge

Use this skill for **runtime log signal**, a **plain-text dump of the active CAD document**, and for **agent automation** that talks to a **connected browser tab** (Chromium with WebGPU) over the same devserver port (HTTP + WebSocket).

## Cursor agents (read first)

- **Default for automation:** run **`make start-agent`** when you need **`/_logs`**, **`/_sceneSource`**, **`/_agent/*`**, or a **self-contained** headless render. Read **`port`** from **`.devserver.agent.run`**.
- **Mirroring a human’s interactive tab** ( **`make serve`** / **`make start`** ): that browser talks to **`.devserver.run`**. To copy their scene + camera + export + mesh debug overlays into the agent stack, use **two ports** — capture from **`.devserver.run`**, render on **`.devserver.agent.run`** (see **Mirror interactive → agent** below).
- **Port:** read **`port`** from **`.devserver.agent.run`** only: `jq -r .port .devserver.agent.run`. If the file is missing after **`make start-agent`**, the agent HTTP bridge is unavailable — **do not guess a port**.
- **Do not** launch Chromium or Chrome yourself. The **`AGENT=true`** devserver starts **headless** Chromium for the WebSocket bridge.
- **Test images on disk:** When saving PNGs or similar into the repo yourself (not relying on the server’s **`.agents/imagelog/`** mirror), use **`.agents/testimages/`** — do not drop files loose under **`.agents/`** root.
- **Logs:** **`.devserver.agent.log`** (tail with **`make logs-agent`**). **Stop:** **`make stop-agent`**.

**Humans / interactive sessions** use **`make serve`** / **`make start`** and **`.devserver.run`**. Use that port for **`/_sceneSource`** and **`/_agent/capture-testcase`** when the goal is “what the user sees right now.” Use **`make start-agent`** and **`.devserver.agent.run`** for headless **`/_agent/render`** and for **`/_logs`** after those renders (the interactive tab does not receive agent render RPCs).

## When to use

- **Logs:** validate runtime after a change, check WebGPU or app errors, read dev log buffer without opening DevTools.
- **Scene source:** capture the **currently selected editor tab’s scene source** (including unsaved buffer content) for debugging, repro scripts, or diffing against disk.
- **Agent automation:** fetch a **testcase YAML** from the live editor, or request **PNG** renders from a **saved testcase file** (`GET`) or an **inline JSON body** (`POST`). Each successful render also writes a copy under **`.agents/imagelog/`** on the server. When you intentionally save PNGs or other test images into the repo yourself (e.g. **`curl -o`** to a fixed path), use **`.agents/testimages/`** — not loose files under **`.agents/`** root (keeps skills/scripts separate from disposable captures).

## Port discovery (interactive devserver — not the default for Cursor agents)

- **Run file:** **`.devserver.run`** in the repo root (JSON: `pid`, `port`), written when **`make serve`** / **`make start`** runs (without **`AGENT=true`**).
- **Port:** `port=$(jq -r .port .devserver.run)` — **`-r`** emits raw digits only. If the file is missing or `jq` fails, this server is not running — **do not guess a port**.

## Agent devserver (**`.devserver.agent.run`**)

- **Start:** **`make start-agent`** or **`make serve-agent`** ( **`AGENT=true`** ; default **PORT=7900** unless overridden; devserver may bind the next free port if busy — always read **`port`** from the run file).
- **Run file:** **`.devserver.agent.run`**. Read the port: `jq -r .port .devserver.agent.run`.
- **Logs file:** **`.devserver.agent.log`** ( **`make logs-agent`** ).
- **Stop:** **`make stop-agent`**.

Cursor agents use **`.devserver.agent.run`** for **`/_agent/render`** and for **`/_logs`** after a headless render; use **`.devserver.run`** only when you need to **read** the human’s interactive tab (**`/_sceneSource`**, **`/_agent/capture-testcase`**). See **Mirror interactive → agent** above.

---

## Bridge behavior (single tab)

RPCs (`/_logs`, `/_sceneSource`, `/_agent/capture-testcase`, `/_agent/render`) send over WebSocket to the **first connected client** in **OPEN** state — not a broadcast to every tab. If multiple tabs are open, only one receives each request; avoid parallel conflicting automation across several tabs on the same devserver.

---

## `GET /_sceneSource` (active document)

- **Route:** `GET /_sceneSource` only. Other methods → **405** with `Allow: GET`.
- **URL:** `http://localhost:<port>/_sceneSource`, where **`<port>`** is read from **`.devserver.agent.run`** (agents) or **`.devserver.run`** (interactive). If the file is missing or unusable, the devserver is not running—**do not guess a port**.
- **Response:** `text/plain; charset=utf-8`. Body is the **full Monaco model value** for the **active tab**. Unsaved edits are included. **No query parameters.**
- **How it works:** The devserver asks the connected browser (via WebSocket) to run `globalThis.__galacticadDevGetActiveSceneSource()`, which the app registers when the dev log bridge is present.
- **200 with empty body** when: no browser tab has an open WebSocket to this devserver, the bridge **times out** (~5s), the getter **throws**, there is **no editor model** (e.g. welcome screen only, or editor not ready), or the app was **not** loaded through this devserver’s injected bridge.
- **CORS:** `Access-Control-Allow-Origin: *` on success and 405 responses (same as `/_logs`).

### Examples (`/_sceneSource`)

After `port=$(jq -r .port .devserver.agent.run)` (agents) or the matching **`.run`** file for your stack:

- Print to terminal:

    `curl -sS "http://localhost:${port}/_sceneSource"`

- Save to a file:

    `curl -sS "http://localhost:${port}/_sceneSource" -o scene-dump.js`

---

## `GET /_logs`

- **Route:** `GET /_logs`
- **Host/port:** **`http://localhost:<port>/_logs`**, where **`<port>`** comes from **`.devserver.agent.run`** (agents) or **`.devserver.run`** (interactive). **Read it with `jq`:** e.g. `jq -r .port .devserver.agent.run` from the repo root. If that file is missing, `jq` fails, or the value is unusable, the devserver is not running—**do not guess a port**; skip `/_logs` or run **`make start-agent`** (agents) before concluding there is no signal.
- **Response:** plain text (`text/plain; charset=utf-8`), one buffer line per line: **full** lines as stored (including `[timestamp] [level]`, `[Module]`, optional `[thread]`, message)—the devserver does not strip or rewrite them.
- **Module toggles vs errors:** In-app `log("Module").error` is **always** written to the browser console and the dev log ring buffer (Dev Tools **Logs** checkboxes do not suppress it). **`debug` / `info` / `warn`** from `log("Module")` only appear when that module is enabled in Dev Tools. `GET /_logs?module=…` still filters by the entry’s `module` field—errors from other modules are omitted when a non-empty `module` list is used.
- **Empty result behavior:** `200` with empty body when no matches, no connected browser, or bridge timeout

### Query Parameters (`/_logs` only)

Full documentation of `level`, `only`, `module`, `n` is unchanged from historical usage (see **AGENTS.md**).

Default check:

`curl -sS "http://localhost:${port}/_logs"`

---

## `GET /_agent/capture-testcase`

- **Purpose:** Serialize the **current** editor scene + camera + mesh export settings into **YAML** (same schema as Dev Tools **Export agent testcase**), via the WebSocket bridge (`exportAgentTestcase` → `__galacticadExportAgentTestcase`).
- **Requires:** devserver running **and** a **browser tab** connected to that server’s origin (WebSocket open), with an **active document**.
- **Response:** `200` + **`application/x-yaml`** body, or **`503`** if no browser, timeout, or capture failed.

Example:

`curl -sS "http://localhost:${port}/_agent/capture-testcase" -o testcase.yaml`

**Testcase format (disk / capture):** Root mapping with `schemaVersion: 1`, multiline string **`source`** (scene body UTF‑8, e.g. `.gcad`), `camera`, `viewCenter`, `resolutionScale`, `viewportWidth`, `viewportHeight`, optional `previewUvRect`, `meshExport`, optional **`meshOverlay`** (mesh-viewer debug toggles when any are on), optional `documentName` (provenance only). Implementation: `src/agent-autotest/agent-testcase.mts` (`parseAgentTestcaseYaml`, `serializeAgentTestcaseYaml`, `AgentRenderRequest`).

---

## Agent render: `GET | POST /_agent/render`

Runs the **agent render pipeline** in the browser (normal-vector **SDF** preview **or** **mesh** export + opaque normal RGB). WebSocket message **`agentRender`** → `globalThis.__galacticadAgentRender`. Response **`image/png`** on success.

**Prerequisites:** Same as capture-testcase — **connected Chromium tab** with WebGPU so the bridge can execute GPU work.

**HTTP errors:** Plain-text body. **`400`** when the browser reports a pipeline / scene / validation error (or invalid JSON / YAML). **`503`** when there is no connected tab, the bridge times out, or delivery fails. **`404`** on GET testcase when the file is missing — body includes the relative path and resolved filesystem path.

**Success headers:** `Content-Type: image/png`, `Content-Length`, `Access-Control-Allow-Origin: *`, **`Access-Control-Expose-Headers: Content-Disposition`**, and **`Content-Disposition: attachment; filename="<basename>-<mode>.png"`** where `<basename>` is the testcase stem for GET, or derived from optional POST `testcase` path / defaults to `render` for bare POST. `<mode>` is `sdf` or `mesh`. Browsers and **`curl -OJ`** can use the suggested filename.

**Imagelog:** On success the server writes **`repo/.agents/imagelog/<label>-<HHMM>-<role>.png`** (`label` / `role` from query or POST extras; see devserver implementation). That path is server-owned. For **agent-chosen** on-disk paths (manual **`curl -o`**, copies, composites), write under **`repo/.agents/testimages/`** (create it if missing); do **not** scatter PNGs under **`repo/.agents/`** root.

### `POST /_agent/render` (only at exact path `/_agent/render`)

- **Body:** JSON. Core fields match **`AgentRenderRequest`** (`src/agent-autotest/agent-testcase.mts`): **`mode`** (`"sdf"` \| `"mesh"`), **`sourceBase64`**, **`camera`**, **`viewCenter`**, **`resolutionScale`**, **`viewportWidth`**, **`viewportHeight`**, **`meshExport`**, optional **`previewUvRect`**, optional **`documentName`** (POST may include it; file-driven GET merge does **not** forward `documentName` from disk testcase so automation is not tied to the active tab name), optional **`meshOverlay`** (mesh-only debug glyphs / markers — see `AgentMeshOverlay` interface, mirrors mesh-viewer GUI checkboxes).
- **POST-only extras** (stripped before dispatch to the app): **`label`**, **`role`** (strings for imagelog filenames), optional **`testcase`** (relative path under `test/testcases/` — used only for **`Content-Disposition`** basename via stem of that path, not sent as part of `AgentRenderRequest`).

Example:

`curl -sS -X POST "http://localhost:${port}/_agent/render" -H 'Content-Type: application/json' -d @payload.json -OJ`

### `GET /_agent/render/testcase/<relative>`

- **Path:** **`/_agent/render/testcase/<relative>`** where **`<relative>`** is a path under **`./test/testcases/`** from the devserver’s current working directory (usually repo root). URL path segments may be percent-encoded. **`..`**, empty segments, and absolute paths are rejected (**400**).
- **File:** Read as UTF‑8 YAML; parsed with **`parseAgentTestcaseYaml`**. Prefer **`.yaml`** fixtures.
- **Query:** Optional **`mode=sdf|mesh`** (default **`sdf`** when omitted or invalid). Optional **`viewportWidth`**, **`viewportHeight`** (numbers; **override** the testcase YAML—**omit** for faithful replay unless the user asks for a different size). Optional **`label`**, **`role`** for imagelog (defaults derived from filename / mode).
- **Mesh-overlay query flags** (`mode=mesh` only; each accepts `1` / `true` / `yes` / `on`, otherwise off): **`debugPoints`** (raw per-edge sample squares), **`glyphLine`** / **`glyphCorner`** / **`glyphSeam`** / **`glyphRing`** (per-class feature glyphs), **`cellVertices`** (per-cell-component vertex markers, MDC QEF debug), **`qefPlanes`** (per-(cell, component) QEF input plane normals as short blue sticks). Each flag also accepts the dotted alias matching the API field (`mdcDebugPoints`, `featureGlyphs.line` … `mdcCellVertices`, `mdcQefPlanes`). Overlays default to off so existing testcase URLs keep producing clean meshes; the overlay 2D canvas is composited into the captured PNG.
- **Merged request:** **`parseAgentTestcaseYaml`** then **`mergeAgentRenderRequest`** builds the `AgentRenderRequest` (base64 from testcase `source`; does not inject testcase `documentName` into the wire payload). If the testcase YAML includes **`meshOverlay`**, it is used for **`mode=mesh`** unless query flags supply a replacement overlay (any overlay query flag present still wins and replaces the whole overlay, same as before).

### `POST /_agent/render/testcase-body`

- **Purpose:** Feed **inline testcase YAML** (same schema as **`GET /_agent/capture-testcase`**) without saving under **`test/testcases/`** and without building JSON **`sourceBase64`** yourself. Use this to **pipe** a capture from the interactive devserver into the agent devserver.
- **Route:** **`POST`** only at exactly **`/_agent/render/testcase-body`**. **Body:** raw UTF‑8 YAML ( **`Content-Type`** may be anything; the server reads the body as text).
- **Query:** Same as GET testcase render: **`mode=sdf|mesh`**, optional **`viewportWidth`**, **`viewportHeight`**, optional **`label`**, **`role`**, and the same **mesh-overlay flags** as **`GET /_agent/render/testcase/...`** when you want to override captured overlays.
- **Responses / errors:** Same success / **`400`** / **`503`** behavior as other agent render routes.

Example — mirror the user’s session on the agent stack (read both ports from the run files):

```bash
user_port=$(jq -r .port .devserver.run)
agent_port=$(jq -r .port .devserver.agent.run)
curl -sS "http://localhost:${user_port}/_agent/capture-testcase" \
  | curl -sS -X POST "http://localhost:${agent_port}/_agent/render/testcase-body?mode=mesh" \
    -H "Content-Type: application/x-yaml" --data-binary @- -OJ
```

Then pull logs from the **agent** port (e.g. **`MdcExport`** when enabled in the headless tab’s Dev Tools):

`curl -sS "http://localhost:${agent_port}/_logs?module=MdcExport&level=debug"`

After you change code, the interactive browser may livereload on its own; the **agent** headless tab does **not**. Trigger a reload there with **`GET`** or **`POST /_refresh`** on the **agent** port before re-running **`testcase-body`** or **`POST /_agent/render`**.

Example (clean mesh, no overlay):

`curl -sS -OJ "http://localhost:${port}/_agent/render/testcase/meshing/polygon-twisted.yaml?mode=mesh"`

Example (per-cell vertex markers and QEF input plane normals — useful for diagnosing single-cell vertex misplacement that surfaces as a "chip" only after crease-split shading):

`curl -sS -OJ "http://localhost:${port}/_agent/render/testcase/meshing/polygon-twisted.yaml?mode=mesh&cellVertices=1&qefPlanes=1"`

**Wrong:** `GET /_agent/render` with no testcase path → **400** with a hint to use **`/_agent/render/testcase/...`**.

---

## Agent workflow (ordered)

### A — Single devserver (headless only)

1. Run **`make start-agent`** if **`.devserver.agent.run`** is not present; read **`port`** from that file. **Do not** launch Chromium yourself—the agent devserver starts headless Chrome for the bridge.
2. Optional: **`GET /_agent/capture-testcase`** (same port) to dump YAML from the headless session.
3. **`GET /_agent/render/testcase/…`**, **`POST /_agent/render/testcase-body`**, or **`POST /_agent/render`**; save PNG (`curl -OJ` respects **`Content-Disposition`**) and/or inspect **`.agents/imagelog/`**. If you save to an explicit path, target **`.agents/testimages/`** (not **`.agents/`** root). For faithful replay, **omit** **`viewportWidth`** / **`viewportHeight`** overrides unless the user asked for a different resolution.
4. Optional: **`GET /_logs`** on the **same** port for runtime errors and dev-log lines from that browser.

### B — Mirror interactive → agent (what the user sees)

Use this when the human runs **`make serve`** / **`make start`** and you want the **same** scene text, camera, viewport crop, **`meshExport`** levers, and **mesh debug overlay** flags as in their tab, then render and inspect logs **without** asking them to switch to the agent devserver.

1. **Interactive port:** `user_port=$(jq -r .port .devserver.run)` — if missing, the user’s devserver is not running; you cannot capture their session.
2. **Capture:** prefer **`GET http://localhost:${user_port}/_agent/capture-testcase`** (full snapshot). Use **`GET /_sceneSource`** only if you need **text only** (no camera / export / overlays).
3. **Agent stack:** run **`make start-agent`** if **`.devserver.agent.run`** is absent; `agent_port=$(jq -r .port .devserver.agent.run)`.
4. **Render:** pipe YAML to **`POST http://localhost:${agent_port}/_agent/render/testcase-body?mode=sdf`** or **`mode=mesh`** (see example under **`POST /_agent/render/testcase-body`**). For **stats / diagnostics first**, fetch **`/_logs`** on **`agent_port`**; open the PNG only when the task needs pixels (e.g. meshing visual QA). **Dev Tools log-module checkboxes are per browser profile** — `debug` / `info` / `warn` lines follow what is enabled in **that** tab; use **`user_port`** for **`/_logs`** if you need the human’s toggle mix, **`agent_port`** for logs from the headless render itself.
5. **Iterate:** after local code changes, call **`/_refresh`** on **`agent_port`**, then repeat capture (if the user changed the doc) or re-POST the same YAML file.

**Note:** Each HTTP server has its **own** WebSocket client. The interactive tab never executes **`/_agent/render`** for you; only the headless agent tab does.

---

## Standard check workflow (`/_logs` and optional `/_sceneSource`)

1. Assign `port=$(jq -r .port .devserver.agent.run)` from the repo root (**agents**). If the file does not exist, run **`make start-agent`** and retry once; if `jq` still errors or `port` is empty, **stop**—do not assume any default port. _(Interactive: use **`.devserver.run`** instead.)_
2. **Default** runtime check: `curl` **`http://localhost:${port}/_logs`** with no `level` or `only` so the server applies default **info** threshold (errors, warnings, and info—no debug spam).
3. **Optional scene source:** `curl -sS "http://localhost:${port}/_sceneSource"` when you need the live editor buffer. If the body is empty, confirm a browser tab is open on this devserver URL and a document tab is active (not welcome-only with no model).
4. Add `/_logs` query parameters only when you have a reason (see **AGENTS.md**).
5. If the `/_logs` body is empty or too narrow to be useful, **broaden** filters before concluding there is no signal.
6. Report relevant lines or source; note empty body explicitly.

---

## Notes

- **Agents:** **`jq -r .port .devserver.agent.run`** after **`make start-agent`**. **Interactive:** **`.devserver.run`**. Then **`curl`** **`/_logs`**, **`/_sceneSource`**, and agent routes on that host/port.
- **`make build`** / **`make test`** follow project rules; do not use `npm` / `npx` / `node` directly for builds.
- Cross-reference: **`AGENTS.md`** (devserver overview, log query parameters, agent automation summary).
