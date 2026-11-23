#!/usr/bin/env bash
# Run stubyard in watch mode inside the dev container:
#   server (tsx watch) on 4000/4443/1025/2197 and dashboard (Vite) on 5173 → open http://localhost:5173
# Host ports can be moved when another stubyard already uses them, e.g.
#   STUBYARD_DEV_HTTP_PORT=34000 STUBYARD_DEV_HTTPS_PORT=34443 STUBYARD_DEV_SMTP_PORT=31025 \
#   STUBYARD_DEV_APNS_PORT=32197 STUBYARD_DEV_WEB_PORT=35173 ./scripts/dev.sh
# STUBYARD_DEV_BIND=0.0.0.0 opens the ports to other machines on the network (default 127.0.0.1, this machine only);
# set STUBYARD_PUBLIC_URL (e.g. http://192.168.0.10:4000) too, so login and payment pages redirect to that address,
# and STUBYARD_ALLOWED_HOSTS=192.168.0.10 so the API accepts requests made to that address.
# STUBYARD_DEV_SEED=1 imports the sample projects in samples/seed at start (see samples/README.md).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SEED=""
PUB=""
[ -n "${STUBYARD_PUBLIC_URL:-}" ] && PUB="-e STUBYARD_PUBLIC_URL=$STUBYARD_PUBLIC_URL"
[ -n "${STUBYARD_ALLOWED_HOSTS:-}" ] && PUB="$PUB -e STUBYARD_ALLOWED_HOSTS=$STUBYARD_ALLOWED_HOSTS"
BIND=${STUBYARD_DEV_BIND:-127.0.0.1}
[ "${STUBYARD_DEV_SEED:-0}" = "1" ] && SEED="-e STUBYARD_SEED=/app/samples/seed"
HTTP=${STUBYARD_DEV_HTTP_PORT:-4000}
HTTPS=${STUBYARD_DEV_HTTPS_PORT:-4443}
SMTP=${STUBYARD_DEV_SMTP_PORT:-1025}
APNS=${STUBYARD_DEV_APNS_PORT:-2197}
WEB=${STUBYARD_DEV_WEB_PORT:-5173}
export STUBYARD_DOCKER_ARGS="-p $BIND:$HTTP:4000 -p $BIND:$HTTPS:4443 -p $BIND:$SMTP:1025 -p $BIND:$APNS:2197 \
  -p $BIND:$WEB:5173 -e STUBYARD_HOST=0.0.0.0 -e STUBYARD_DATA_DIR=/app/data -e STUBYARD_LOG_LEVEL=${STUBYARD_LOG_LEVEL:-info} \
  --add-host=host.docker.internal:host-gateway --name stubyard-dev $SEED $PUB"
echo "stubyard dev (ports on $BIND): dashboard http://localhost:$WEB  API http://localhost:$HTTP  (data in ./data)"
exec "$ROOT/scripts/npm.sh" exec -c 'npm run dev -w server & npm run dev -w web & wait'
