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
- Host/port: from `.devserver.run` JSON field `port`; fallback `6900` if the file is missing
- Response: plain text (`text/plain; charset=utf-8`)
- Empty result behavior: `200` with empty body when no matches, no connected browser, or bridge timeout

## Query Parameters

- **Severity flags** (presence enables bucket): `err`, `warn`, `info`, `debug`
- **Default levels** (no severity flags): all four buckets
- **`n`**: optional, integer `1..10000`, default `20`, applied per bucket
- **`module`**: optional comma-separated names (for example `module=MdcExport,WelcomeScreen`)
  - Missing or empty `module` means all modules
  - Non-empty `module` filters to module-tagged/module-attributed lines only
  - Generic mirrored console lines without module context are excluded when module filter is active

## Agent Workflow

1. Read `.devserver.run` to get `port` (fallback `6900`).
2. Default runtime check command (unless user asks otherwise):
   - `curl -sS "http://localhost:<port>/_logs?warn&err"`
3. For deeper checks, add:
   - `&info` and/or `&debug`
   - `&module=...`
   - `&n=...` only when requested
4. Report key lines to the user; if body is empty, state that no matching lines were returned.

## Examples

- Default warn+error:
  - `curl -sS "http://localhost:6900/_logs?warn&err"`
- Errors only, last 5 per error bucket:
  - `curl -sS "http://localhost:6900/_logs?err&n=5"`
- Warn+error for specific modules:
  - `curl -sS "http://localhost:6900/_logs?warn&err&module=MdcExport,WelcomeScreen"`

## Notes

- Use shell `curl` for this workflow.
- Keep build/test commands compliant with project rules (`make build`, `make test`).
