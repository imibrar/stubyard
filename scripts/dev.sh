#!/usr/bin/env bash
# Run stubyard in watch mode inside the dev container:
#   server (tsx watch) on 4000/4443/1025 and dashboard (Vite) on 5173 → open http://localhost:5173
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export STUBYARD_DOCKER_ARGS="-p 127.0.0.1:4000:4000 -p 127.0.0.1:4443:4443 -p 127.0.0.1:1025:1025 -p 127.0.0.1:5173:5173 \
  -e STUBYARD_HOST=0.0.0.0 -e STUBYARD_DATA_DIR=/app/data -e STUBYARD_LOG_LEVEL=${STUBYARD_LOG_LEVEL:-info} --add-host=host.docker.internal:host-gateway --name stubyard-dev"
exec "$ROOT/scripts/npm.sh" exec -- sh -c 'npm run dev -w server & npm run dev -w web & wait'
