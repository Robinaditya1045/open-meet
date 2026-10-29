#!/usr/bin/env bash
# Runs the Go server and the Vite dev server together; Ctrl-C stops both.
set -euo pipefail
cd "$(dirname "$0")"

[ -d web/node_modules ] || (cd web && npm install)

(cd server && go run ./cmd/meet) &
server=$!
(cd web && npm run dev -- --strictPort) &
web=$!

trap 'kill $server $web 2>/dev/null; wait 2>/dev/null' INT TERM EXIT
echo "meet: API on http://localhost:8088, app on http://localhost:5188"
wait -n $server $web
