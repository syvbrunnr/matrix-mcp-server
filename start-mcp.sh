#!/bin/bash
# Hot-reload wrapper for Matrix MCP server.
# Restarts the server on clean exit (code 0) — used by the restart-server tool.
# Exits permanently on non-zero exit code (crash or signal).
# From Claude Code's perspective the subprocess never dies, so no /mcp needed.

DIST="$(dirname "$0")/dist/stdio-server.js"

while true; do
  node "$DIST"
  EXIT_CODE=$?
  # Clean exit = hot reload requested → restart with new dist/
  [[ $EXIT_CODE -ne 0 ]] && exit $EXIT_CODE
done
