#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO_DIR="${TMPDIR:-/tmp}/akb-demo"
AKB=(node "$ROOT/apps/cli/dist/main.js")

rm -rf "$DEMO_DIR"
pnpm --dir "$ROOT" build

"${AKB[@]}" init "$DEMO_DIR"
cd "$DEMO_DIR"
"${AKB[@]}" ingest "$ROOT/examples/sample-vault"
"${AKB[@]}" index --rebuild
cp "$ROOT/examples/sample-vault/golden.yaml" .akb/eval/golden.yaml
"${AKB[@]}" search "garbage collection"
"${AKB[@]}" search "wear leveling" --format json
"${AKB[@]}" eval

echo "Demo complete. Start the MCP server with: akb mcp serve"
