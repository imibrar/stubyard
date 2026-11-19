#!/usr/bin/env bash
# Run devhub in watch mode inside the dev container:
#   server (tsx watch) on 4000/4443/1025 and dashboard (Vite) on 5173 → open http://localhost:5173
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export DEVHUB_DOCKER_ARGS="-p 127.0.0.1:4000:4000 -p 127.0.0.1:4443:4443 -p 127.0.0.1:1025:1025 -p 127.0.0.1:5173:5173 \
  -e DEVHUB_DATA_DIR=/app/data -e DEVHUB_LOG_LEVEL=${DEVHUB_LOG_LEVEL:-info} --add-host=host.docker.internal:host-gateway --name devhub-dev"
exec "$ROOT/scripts/npm.sh" exec -- sh -c 'npm run dev -w server & npm run dev -w web & wait'
