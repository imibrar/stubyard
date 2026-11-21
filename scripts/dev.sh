#!/usr/bin/env bash
# Run stubyard in watch mode inside the dev container:
#   server (tsx watch) on 4000/4443/1025/2197 and dashboard (Vite) on 5173 → open http://localhost:5173
# Host ports can be moved when another stubyard already uses them, e.g.
#   STUBYARD_DEV_HTTP_PORT=34000 STUBYARD_DEV_HTTPS_PORT=34443 STUBYARD_DEV_SMTP_PORT=31025 \
#   STUBYARD_DEV_APNS_PORT=32197 STUBYARD_DEV_WEB_PORT=35173 ./scripts/dev.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HTTP=${STUBYARD_DEV_HTTP_PORT:-4000}
HTTPS=${STUBYARD_DEV_HTTPS_PORT:-4443}
SMTP=${STUBYARD_DEV_SMTP_PORT:-1025}
APNS=${STUBYARD_DEV_APNS_PORT:-2197}
WEB=${STUBYARD_DEV_WEB_PORT:-5173}
export STUBYARD_DOCKER_ARGS="-p 127.0.0.1:$HTTP:4000 -p 127.0.0.1:$HTTPS:4443 -p 127.0.0.1:$SMTP:1025 -p 127.0.0.1:$APNS:2197 \
  -p 127.0.0.1:$WEB:5173 -e STUBYARD_HOST=0.0.0.0 -e STUBYARD_DATA_DIR=/app/data -e STUBYARD_LOG_LEVEL=${STUBYARD_LOG_LEVEL:-info} \
  --add-host=host.docker.internal:host-gateway --name stubyard-dev"
echo "stubyard dev: dashboard http://localhost:$WEB  API http://localhost:$HTTP  (data in ./data)"
exec "$ROOT/scripts/npm.sh" exec -c 'npm run dev -w server & npm run dev -w web & wait'
