---
name: devserver
description: "Local devserver: GET /_logs, GET /_sceneSource, and agent automation (GET /_agent/capture-testcase, GET /_agent/render/testcase/…, POST /_agent/render) via curl; WebSocket bridge to a connected Chromium tab."
---

# Devserver HTTP / WebSocket bridge

Use this skill for **runtime log signal**, a **plain-text dump of the active CAD document**, and for **agent automation** that talks to a **connected browser tab** (Chromium with WebGPU) over the same devserver port (HTTP + WebSocket).

## When to use

- **Logs:** validate runtime after a change, check WebGPU or app errors, read dev log buffer without opening DevTools.
- **Scene source:** capture the **currently selected editor tab’s scene source** (including unsaved buffer content) for debugging, repro scripts, or diffing against disk.
- **Agent automation:** fetch a **testcase YAML** from the live editor, or request **PNG** renders from a **saved testcase file** (`GET`) or an **inline JSON body** (`POST`). Each successful render also writes a copy under **`.agents/imagelog/`** on the server.

## Port discovery (main devserver)

- **Run file:** **`.devserver.run`** in the repo root (JSON: `pid`, `port`), written when `make serve` / `make start` runs.
- **Port:** `port=$(jq -r .port .devserver.run)` — **`-r`** emits raw digits only. If the file is missing or `jq` fails, the server is not running — **do not guess a port**.

## Optional agent devserver (separate process)

- **Run file:** **`.devserver.agent.run`** when using **`make serve-agent`** or **`make start-agent`** (starts from **PORT=7000**; devserver may bind the next free port if busy — read **`port`** from the run file).
- Read the port the same way: `jq -r .port .devserver.agent.run`.
- **Logs file:** `.devserver.agent.log` (tail with **`make logs-agent`**).
- **Stop:** **`make stop-agent`**.

Use this when you want automation isolated from the default `.devserver.run` server.

---

## Bridge behavior (single tab)

RPCs (`/_logs`, `/_sceneSource`, `/_agent/capture-testcase`, `/_agent/render`) send over WebSocket to the **first connected client** in **OPEN** state — not a broadcast to every tab. If multiple tabs are open, only one receives each request; avoid parallel conflicting automation across several tabs on the same devserver.

---

## `GET /_sceneSource` (active document)

- **Route:** `GET /_sceneSource` only. Other methods → **405** with `Allow: GET`.
- **URL:** `http://localhost:<port>/_sceneSource`, where **`<port>`** is read from **`.devserver.run`**. If the file is missing or unusable, the devserver is not running—**do not guess a port**.
- **Response:** `text/plain; charset=utf-8`. Body is the **full Monaco model value** for the **active tab**. Unsaved edits are included. **No query parameters.**
- **How it works:** The devserver asks the connected browser (via WebSocket) to run `globalThis.__galacticadDevGetActiveSceneSource()`, which the app registers when the dev log bridge is present.
- **200 with empty body** when: no browser tab has an open WebSocket to this devserver, the bridge **times out** (~5s), the getter **throws**, there is **no editor model** (e.g. welcome screen only, or editor not ready), or the app was **not** loaded through this devserver’s injected bridge.
- **CORS:** `Access-Control-Allow-Origin: *` on success and 405 responses (same as `/_logs`).

### Examples (`/_sceneSource`)

After `port=$(jq -r .port .devserver.run)`:

- Print to terminal:

  `curl -sS "http://localhost:${port}/_sceneSource"`

- Save to a file:

  `curl -sS "http://localhost:${port}/_sceneSource" -o scene-dump.js`

---

## `GET /_logs`

- **Route:** `GET /_logs`
- **Host/port:** **`http://localhost:<port>/_logs`**, where **`<port>` comes from `.devserver.run`**. **Read it with `jq`:** `jq -r .port .devserver.run` from the directory that contains the file (usually the repo root). If that file is missing, `jq` fails, or the value is unusable, the devserver is not running—**do not guess a port**; skip `/_logs` or ask the user to start the server.
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

**Testcase format (disk / capture):** Root mapping with `schemaVersion: 1`, multiline string **`source`** (scene body UTF‑8, e.g. `.gcad`), `camera`, `viewCenter`, `resolutionScale`, `viewportWidth`, `viewportHeight`, optional `previewUvRect`, `meshExport`, optional `documentName` (provenance only). Implementation: `src/agent-autotest/agent-testcase.mts` (`parseAgentTestcaseYaml`, `serializeAgentTestcaseYaml`, `AgentRenderRequest`).

---

## Agent render: `GET | POST /_agent/render`

Runs the **agent render pipeline** in the browser (normal-vector **SDF** preview **or** **mesh** export + opaque normal RGB). WebSocket message **`agentRender`** → `globalThis.__galacticadAgentRender`. Response **`image/png`** on success.

**Prerequisites:** Same as capture-testcase — **connected Chromium tab** with WebGPU so the bridge can execute GPU work.

**HTTP errors:** Plain-text body. **`400`** when the browser reports a pipeline / scene / validation error (or invalid JSON / YAML). **`503`** when there is no connected tab, the bridge times out, or delivery fails. **`404`** on GET testcase when the file is missing — body includes the relative path and resolved filesystem path.

**Success headers:** `Content-Type: image/png`, `Content-Length`, `Access-Control-Allow-Origin: *`, **`Access-Control-Expose-Headers: Content-Disposition`**, and **`Content-Disposition: attachment; filename="<basename>-<mode>.png"`** where `<basename>` is the testcase stem for GET, or derived from optional POST `testcase` path / defaults to `render` for bare POST. `<mode>` is `sdf` or `mesh`. Browsers and **`curl -OJ`** can use the suggested filename.

**Imagelog:** On success the server writes **`repo/.agents/imagelog/<label>-<HHMM>-<role>.png`** (`label` / `role` from query or POST extras; see devserver implementation).

### `POST /_agent/render` (only at exact path `/_agent/render`)

- **Body:** JSON. Core fields match **`AgentRenderRequest`** (`src/agent-autotest/agent-testcase.mts`): **`mode`** (`"sdf"` \| `"mesh"`), **`sourceBase64`**, **`camera`**, **`viewCenter`**, **`resolutionScale`**, **`viewportWidth`**, **`viewportHeight`**, **`meshExport`**, optional **`previewUvRect`**, optional **`documentName`** (POST may include it; file-driven GET merge does **not** forward `documentName` from disk testcase so automation is not tied to the active tab name).
- **POST-only extras** (stripped before dispatch to the app): **`label`**, **`role`** (strings for imagelog filenames), optional **`testcase`** (relative path under `test/testcases/` — used only for **`Content-Disposition`** basename via stem of that path, not sent as part of `AgentRenderRequest`).

Example:

`curl -sS -X POST "http://localhost:${port}/_agent/render" -H 'Content-Type: application/json' -d @payload.json -OJ`

### `GET /_agent/render/testcase/<relative>`

- **Path:** **`/_agent/render/testcase/<relative>`** where **`<relative>`** is a path under **`./test/testcases/`** from the devserver’s current working directory (usually repo root). URL path segments may be percent-encoded. **`..`**, empty segments, and absolute paths are rejected (**400**).
- **File:** Read as UTF‑8 YAML; parsed with **`parseAgentTestcaseYaml`**. Prefer **`.yaml`** fixtures.
- **Query:** Optional **`mode=sdf|mesh`** (default **`sdf`** when omitted or invalid). Optional **`viewportWidth`**, **`viewportHeight`** (numbers). Optional **`label`**, **`role`** for imagelog (defaults derived from filename / mode).
- **Merged request:** **`parseAgentTestcaseYaml`** then **`mergeAgentRenderRequest`** builds the `AgentRenderRequest` (base64 from testcase `source`; does not inject testcase `documentName` into the wire payload).

Example:

`curl -sS -OJ "http://localhost:${port}/_agent/render/testcase/meshing/polygon-twisted.yaml?mode=mesh"`

**Wrong:** `GET /_agent/render` with no testcase path → **400** with a hint to use **`/_agent/render/testcase/...`**.

---

## Agent workflow (ordered)

1. Start a devserver (`make serve` or `make serve-agent`); read **`port`** from the matching **`.run`** file.
2. Open the app in **system Chromium** with WebGPU (helper: **`.agents/scripts/agent-open-chromium.sh`** — reads **`.devserver.agent.run`** by default; set **`RUN_FILE`** to use the interactive server). Leave **one** tab connected for predictable RPC.
3. Optional: **`GET /_agent/capture-testcase`** to save testcase YAML from the user’s session.
4. **`GET /_agent/render/testcase/…`** or **`POST /_agent/render`**; save PNG (`curl -OJ` respects **`Content-Disposition`**) and/or inspect **`.agents/imagelog/`**.
5. Optional: **`GET /_logs`** for runtime errors during the run.

---

## Standard check workflow (`/_logs` and optional `/_sceneSource`)

1. Assign `port=$(jq -r .port .devserver.run)` from the repo root. If the file does not exist, `jq` errors, or `port` is empty, **stop**—the devserver is not running; do not assume any default port.
2. **Default** runtime check: `curl` **`http://localhost:${port}/_logs`** with no `level` or `only` so the server applies default **info** threshold (errors, warnings, and info—no debug spam).
3. **Optional scene source:** `curl -sS "http://localhost:${port}/_sceneSource"` when you need the live editor buffer. If the body is empty, confirm a browser tab is open on this devserver URL and a document tab is active (not welcome-only with no model).
4. Add `/_logs` query parameters only when you have a reason (see **AGENTS.md**).
5. If the `/_logs` body is empty or too narrow to be useful, **broaden** filters before concluding there is no signal.
6. Report relevant lines or source; note empty body explicitly.

---

## Notes

- Use **`jq -r .port .devserver.run`** and **`curl`** for **`/_logs`**, **`/_sceneSource`**, and agent routes on the same host/port.
- **`make build`** / **`make test`** follow project rules; do not use `npm` / `npx` / `node` directly for builds.
- Cross-reference: **`AGENTS.md`** (devserver overview, log query parameters, agent automation summary).
