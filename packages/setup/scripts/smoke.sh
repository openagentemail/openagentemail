#!/usr/bin/env bash
set -euo pipefail

BUN_BIN="${BUN_BIN:-bun}"
REAL_DOCKER_CONFIG="${DOCKER_CONFIG:-$HOME/.docker}"
TMP_HOME="$(mktemp -d)"

cleanup() {
  HOME="$TMP_HOME" DOCKER_CONFIG="$REAL_DOCKER_CONFIG" \
    node dist/main.js demo --yes --json --teardown >/dev/null 2>&1 || true
  rm -rf "$TMP_HOME"
}
trap cleanup EXIT

"$BUN_BIN" build src/main.ts --target node --outfile dist/main.js

RESULT="$(HOME="$TMP_HOME" DOCKER_CONFIG="$REAL_DOCKER_CONFIG" \
  node dist/main.js demo --clients none --yes --json)"
node -e 'const result = JSON.parse(process.argv[1]); if (!result.ok || !result.address) process.exit(1)' "$RESULT"

if [[ -n "${OPENAGENTEMAIL_SMOKE_API_URL:-}" && -n "${OPENAGENTEMAIL_SMOKE_TOKEN:-}" ]]; then
  RESULT="$(node dist/main.js connect \
    --api-url "$OPENAGENTEMAIL_SMOKE_API_URL" \
    --token "$OPENAGENTEMAIL_SMOKE_TOKEN" \
    --clients none --yes --json --verify)"
  node -e 'const result = JSON.parse(process.argv[1]); if (!result.ok) process.exit(1)' "$RESULT"
fi

echo "setup CLI smoke test passed"
