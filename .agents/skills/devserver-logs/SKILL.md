---
name: devserver-logs
description: "Query runtime browser logs (GET /_logs), active scene source (GET /_sceneSource), and agent automation (GET /_agent/capture-testcase, GET /_agent/render/testcase/…, POST /_agent/render) from the local devserver with curl."
---

# Devserver HTTP / WebSocket bridge

Use this skill for **runtime log signal**, a **plain-text dump of the active CAD document**, and for **agent automation** that talks to a **connected browser tab** (Chromium with WebGPU) over the same devserver port (HTTP + WebSocket).

## When to use

- **Logs:** validate runtime after a change, check WebGPU or app errors, read dev log buffer without opening DevTools.
- **Scene source:** capture the **currently selected editor tab’s scene source** (including unsaved buffer content) for debugging, repro scripts, or diffing against disk.
- **Agent automation:** fetch a **testcase JSON** from the live editor, or request **PNG** renders via **`GET /_agent/render/testcase/<path>`** (file under `test/testcases/`) or **`POST /_agent/render`** with an inline JSON body. Each successful render also writes a copy under **`.agents/imagelog/`** on the server.

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

## `GET /_sceneSource` (active document)

- **Route:** `GET /_sceneSource` only. Other methods → **405** with `Allow: GET`.
- **URL:** `http://localhost:<port>/_sceneSource`, where **`<port>`** is read from **`.devserver.run`** (same as `/_logs`). Use `jq -r .port .devserver.run` from the repo root (or pass the file path to `jq`). If the file is missing or unusable, the devserver is not running—**do not guess a port**.
- **Response:** `text/plain; charset=utf-8`. Body is the **full Monaco model value** for the **active tab** (the tab whose model is bound to the editor). Unsaved edits are included. **No query parameters.**
- **How it works:** The devserver asks the connected browser (via WebSocket) to run `globalThis.__galacticadDevGetActiveSceneSource()`, which the app registers when the dev log bridge is present. Same “broadcast to all clients; **first successful response wins**” behavior as `/_logs`.
- **200 with empty body** when: no browser tab has an open WebSocket to this devserver, the bridge **times out** (~5s), the getter **throws**, there is **no editor model** (e.g. welcome screen only, or editor not ready), or the app was **not** loaded through this devserver’s injected bridge (no `__galacticadDevLogPush` / getter never installed).
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
- **Host/port:** **`http://localhost:<port>/_logs`**, where **`<port>` comes from `.devserver.run`** (JSON written when the devserver starts). **Read it with `jq`:** run `jq -r .port .devserver.run` from the directory that contains the file (usually the repo root). `-r` emits the raw ASCII value—digits only for a number, no JSON string quotes. If that file is missing, `jq` fails, or the value is unusable, the devserver is not running—**do not guess a port**; skip `/_logs` or ask the user to start the server.
- **Response:** plain text (`text/plain; charset=utf-8`), one buffer line per line: **full** lines as stored (including `[timestamp] [level]`, `[Module]`, optional `[thread]`, message)—the devserver does not strip or rewrite them.
- **Module toggles vs errors:** In-app `log("Module").error` is **always** written to the browser console and the dev log ring buffer (Dev Tools **Logs** checkboxes do not suppress it). **`debug` / `info` / `warn`** from `log("Module")` only appear when that module is enabled in Dev Tools. `GET /_logs?module=…` still filters by the entry’s `module` field—errors from other modules are omitted when a non-empty `module` list is used.
- **Empty result behavior:** `200` with empty body when no matches, no connected browser, or bridge timeout

### Query Parameters (`/_logs` only)

Full documentation of `level`, `only`, `module`, `n` is unchanged from historical usage.

Default check:

`curl -sS "http://localhost:${port}/_logs"`

---

## `GET /_agent/capture-testcase`

- **Purpose:** Serialize the **current** editor scene + camera + mesh export settings into JSON (same schema as Dev Tools **Export agent testcase**), via the WebSocket bridge (`exportAgentTestcase` → `__galacticadExportAgentTestcase`).
- **Requires:** devserver running **and** a **browser tab** connected to that server’s origin (WebSocket open), with an **active document**.
- **Response:** `200` + `application/json` body, or **`503`** if no browser, timeout, or capture failed.

Example:

`curl -sS "http://localhost:${port}/_agent/capture-testcase" -o testcase.json`

---

## `GET | POST /_agent/render`

Runs the **agent render pipeline** in the browser (normal-vector SDF preview **or** mesh export + opaque normal RGB). Uses **`agentRender`** over WebSocket (`__galacticadAgentRender`). Response is **`image/png`** on success; on failure, plain-text body with **`400`** when the browser reports a pipeline / scene error, or **`503`** when there is no connected tab, the bridge times out, or the message cannot be delivered.

**Prerequisites:** Same as capture-testcase — **connected Chromium tab** with WebGPU so the bridge can execute GPU work.

### POST

- **Body:** JSON matching **`AgentRenderRequest`** (see `src/agent-autotest/agent-testcase.mts`): `mode` (`"sdf"` \| `"mesh"`), `sourceBase64`, `camera`, `viewCenter`, `resolutionScale`, `viewportWidth`, `viewportHeight`, `meshExport`, optional `documentName`.
- **Optional:** `label` and `role` (strings for **`.agents/imagelog/`** filenames). Optional **`testcase`** (relative path under `test/testcases/`, same shape as GET path) for **`Content-Disposition`** basename only; removed before dispatch. Not part of `AgentRenderRequest`.

Example (conceptual — embed real base64):

`curl -sS -X POST "http://localhost:${port}/_agent/render" -H 'Content-Type: application/json' -d @payload.json -o out.png`

### GET

- **Path:** **`/_agent/render/testcase/<relative>`** where `<relative>` is the path under **`$PWD/test/testcases/`** (slashes OK), e.g. `meshing/my-case.json` → `/_agent/render/testcase/meshing/my-case.json`.
- **Query:** optional `mode=sdf|mesh`, `viewportWidth`, `viewportHeight`, `label`, `role`.
- **Filename:** successful responses set **`Content-Disposition`** to **`<basename>-<mode>.png`** (e.g. `my-case-sdf.png`). Use **`curl -OJ`** to save under that name.

Example:

`curl -sS -OJ "http://localhost:${port}/_agent/render/testcase/meshing/my-case.json?mode=sdf"`

### Imagelog files

On success the server writes **`repo/.agents/imagelog/<label>-<HHMM>-<role>.png`** (short slug + local time + role).

---

## Agent workflow (ordered)

1. Start a devserver (`make serve` or `make serve-agent`); read **`port`** from the matching **`.run`** file.
2. Open the app in **system Chromium** with WebGPU (helper: **`.agents/scripts/agent-open-chromium.sh`** — reads **`.devserver.agent.run`** by default; set **`RUN_FILE`** to use the interactive server). Leave the tab open.
3. Optional: **`GET /_agent/capture-testcase`** to save a testcase JSON from the user’s session.
4. **`GET /_agent/render/testcase/…`** (file under `test/testcases/`) or **`POST /_agent/render`** with inline JSON body; save PNG (`curl -OJ` respects **`Content-Disposition`**) and/or inspect **`.agents/imagelog/`**.
5. Optional: **`GET /_logs`** for runtime errors during the run.

---

## Standard check workflow (`/_logs` and optional `/_sceneSource`)

1. Assign `port=$(jq -r .port .devserver.run)` from the repo root (or pass the full path to `.devserver.run` as `jq`'s file argument). If the file does not exist, `jq` errors, or `port` is empty, **stop**—the devserver is not running; do not assume any default port. See **`/_logs`** host/port notes for why `-r` is used.
2. **Default** runtime check: `curl` **`http://localhost:${port}/_logs`** with no `level` or `only` so the server applies default **info** threshold (errors, warnings, and info—no debug spam).
3. **Optional scene source:** `curl -sS "http://localhost:${port}/_sceneSource"` when you need the live editor buffer. If the body is empty, confirm a browser tab is open on this devserver URL and a document tab is active (not welcome-only with no model).
4. Add `/_logs` query parameters only when you have a reason:
   - Use `module=…` when the question is scoped to specific modules.
   - Use `level=debug` when you need debug-tier lines; use `only=…` when you need a non-contiguous mix (e.g. errors + debug only).
   - Use `n=` only when the user asks or when you need a different per-bucket cap.
5. If the `/_logs` body is empty or too narrow to be useful, **broaden**: drop `module`, raise threshold (`level=debug`), or drop `only` and retry—before concluding there is no signal.
6. Report relevant lines or source; note empty body explicitly.

---

## Notes

- Use shell **`jq -r .port .devserver.run`** for the port (raw ASCII number, no quotes) and **`curl`** for **`/_logs`**, **`/_sceneSource`**, and agent routes on the same host/port.
- **`make build`** / **`make test`** follow project rules; do not use `npm` / `npx` / `node` directly for builds.
- Cross-reference: **`AGENTS.md`** (devserver logs endpoint and agent automation overview).
