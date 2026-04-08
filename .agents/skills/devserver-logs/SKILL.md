---
name: devserver-logs
description: "Query runtime browser logs from the local devserver with curl GET /_logs."
---

# Devserver Logs

Use this skill when the user wants runtime log signal from a running local devserver.

## When to Use

- Validate runtime issues after a code change (especially rendering/WebGPU behavior).
- Check warnings/errors quickly without opening browser DevTools.
- Confirm there are no fresh runtime errors before finishing a task.

## Endpoint

- Route: `GET /_logs`
- Host/port: **`http://localhost:<port>/_logs`**, where **`<port>` comes from `.devserver.run`** (JSON written when the devserver starts). **Read it with `jq`:** run `jq -r .port .devserver.run` from the directory that contains the file (usually the repo root). `-r` emits the raw ASCII value—digits only for a number, no JSON string quotes. If that file is missing, `jq` fails, or the value is unusable, the devserver is not running—**do not guess a port**; skip `/_logs` or ask the user to start the server.
- Response: plain text (`text/plain; charset=utf-8`), one buffer line per line: **full** lines as stored (including `[timestamp] [level]`, `[Module]`, optional `[thread]`, message)—the devserver does not strip or rewrite them.
- **Module toggles vs errors:** In-app `log("Module").error` is **always** written to the browser console and the dev log ring buffer (Dev Tools **Logs** checkboxes do not suppress it). **`debug` / `info` / `warn`** from `log("Module")` only appear when that module is enabled in Dev Tools. `GET /_logs?module=…` still filters by the entry’s `module` field—errors from other modules are omitted when a non-empty `module` list is used.
- Empty result behavior: `200` with empty body when no matches, no connected browser, or bridge timeout

## Query Parameters

### `level` (minimum threshold)

- Single value, case-insensitive: `error`, `warning`, `info`, or `debug`
- **Cumulative** (includes everything at or above that severity):
  - `error` → errors only
  - `warning` → errors + warnings
  - `info` → errors + warnings + info (**default** when `level` is omitted, empty, or unrecognized)
  - `debug` → all four buckets
- Public name `warning` maps to the internal warn bucket (log lines still parse `warn` in the second bracketed token)

### `only` (exact buckets)

- Comma-separated list using the same tokens: `error`, `warning`, `info`, `debug`
- Keeps **only** those buckets (e.g. `only=error` → errors only; `only=error,debug` → errors and debug, **no** info or warning)
- **Precedence:** if the `only` query parameter is **present** and at least one token is valid, `only` wins and **`level` is ignored**
- If `only` is present but the list is empty or every token is invalid, fall back to the same default as missing `level` (**info** threshold)

### Other parameters (unchanged)

- **`n`**: optional integer `1..10000`, default `20`, applied **per bucket**
- **`module`**: optional comma-separated module names (e.g. `module=App,MdcExport,WelcomeScreen` or `module=Settings`)
  - Missing or empty → all modules
  - Non-empty → module-tagged / module-attributed lines only; generic mirrored `console` lines without module context are excluded

Legacy presence flags (`err`, `warn`, `info`, `debug` as separate boolean query keys) are **not** used; do not rely on them.

## Agent Workflow

1. Assign `port=$(jq -r .port .devserver.run)` from the repo root (or pass the full path to `.devserver.run` as `jq`'s file argument). If the file does not exist, `jq` errors, or `port` is empty, **stop**—the devserver is not running; do not assume any default port. See **Endpoint** for why `-r` is used.
2. **Default** runtime check: `curl` **`http://localhost:${port}/_logs`** with no `level` or `only` so the server applies default **info** threshold (errors, warnings, and info—no debug spam).
3. Add query parameters only when you have a reason:
   - Use `module=…` when the question is scoped to specific modules.
   - Use `level=debug` when you need debug-tier lines; use `only=…` when you need a non-contiguous mix (e.g. errors + debug only).
   - Use `n=` only when the user asks or when you need a different per-bucket cap.
4. If the body is empty or too narrow to be useful, **broaden**: drop `module`, raise threshold (`level=debug`), or drop `only` and retry—before concluding there is no signal.
5. Report relevant lines; note empty body explicitly.

## Examples

Use a subshell so `curl` always gets a clean port string:

`port=$(jq -r .port .devserver.run)` (run from the repo root, or pass the full path to `.devserver.run` as the second argument to `jq`).

- Default (info threshold, last 20 per included bucket):

  `curl -sS "http://localhost:${port}/_logs"`

- Include debug lines:

  `curl -sS "http://localhost:${port}/_logs?level=debug"`

- Errors only:

  `curl -sS "http://localhost:${port}/_logs?only=error"`

- Errors and warnings only (no info/debug):

  `curl -sS "http://localhost:${port}/_logs?only=error,warning"`

- Scoped modules:

  `curl -sS "http://localhost:${port}/_logs?module=App,MdcExport,WelcomeScreen"`

- Five errors per bucket:

  `curl -sS "http://localhost:${port}/_logs?only=error&n=5"`

## Notes

- Use shell **`jq -r .port .devserver.run`** for the port (raw ASCII number, no quotes) and `curl` for `/_logs`.
- Keep build/test commands compliant with project rules (`make build`, `make test`).
