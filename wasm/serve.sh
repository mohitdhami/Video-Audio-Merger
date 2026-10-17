#!/bin/sh
# Serves this folder so the browser-only app can be opened at http://localhost:8080/
# (workers and .wasm files cannot be loaded from file://).
cd "$(dirname "$0")" || exit 1
port="${1:-8080}"
echo "serving $(pwd) on http://localhost:$port/"
exec python3 -m http.server "$port"
