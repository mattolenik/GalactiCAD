#!/usr/bin/env bash
# Open the bundled app in system Chromium so WebGPU initializes and the devserver WS bridge connects.
# Requires an active devserver; port is read from RUN_FILE (default: repo .devserver.agent.run).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_FILE="${RUN_FILE:-$ROOT/.devserver.agent.run}"
if [[ ! -f "$RUN_FILE" ]]; then
    echo "Missing $RUN_FILE — start the server with: make serve   or   make serve-agent" >&2
    exit 1
fi
PORT="$(jq -r .port "$RUN_FILE")"
URL="${1:-http://localhost:$PORT/}"
CHROME="${CHROME:-chromium}"
if ! command -v "$CHROME" >/dev/null 2>&1; then
    CHROME="google-chrome-stable"
fi
if ! command -v "$CHROME" >/dev/null 2>&1; then
    echo "Set CHROME to a WebGPU-capable browser (e.g. export CHROME=/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome)" >&2
    exit 1
fi
echo "Opening $URL with $CHROME (keep this window open for agent /_agent/render requests)"
exec "$CHROME" "$URL"
