#!/usr/bin/env bash
# devhub: load the image (first time only) and start it. macOS / Linux.
#   ./start.sh                     start
#   ./start.sh --reload            load a newer image from devhub-image.tar.gz
#   ./start.sh --restore FILE.tgz  restore a data backup into the devhub-data volume first (replaces existing data)
# Ports come from .env next to this script (DEVHUB_HTTP_PORT etc.), default 4000 / 4443 / 1025.
set -euo pipefail
cd "$(dirname "$0")"
PORT=4000
if [ -f .env ]; then
  p=$(sed -n 's/^[[:space:]]*DEVHUB_HTTP_PORT[[:space:]]*=[[:space:]]*\([0-9]*\).*/\1/p' .env | tail -1)
  [ -n "$p" ] && PORT=$p
fi
RELOAD=0; RESTORE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --reload) RELOAD=1 ;;
    --restore) RESTORE="${2:?--restore needs a file}"; shift ;;
  esac
  shift
done
if ! docker image inspect devhub:latest >/dev/null 2>&1 || [ "$RELOAD" = 1 ]; then
  echo "Loading devhub image (one time, ~30 s)…"
  docker load -i devhub-image.tar.gz
fi
if [ -n "$RESTORE" ]; then
  [ -f "$RESTORE" ] || { echo "Backup file not found: $RESTORE"; exit 1; }
  dir=$(cd "$(dirname "$RESTORE")" && pwd); file=$(basename "$RESTORE")
  echo "Restoring $file into the devhub-data volume…"
  docker compose down >/dev/null 2>&1 || true
  docker volume create devhub-data >/dev/null
  docker run --rm --user 0 --entrypoint sh -v devhub-data:/data -v "$dir:/backup:ro" devhub:latest \
    -c "rm -rf /data/* && tar xzf /backup/$file -C /data && chown -R node:node /data"
fi
docker compose up -d
echo -n "Waiting for devhub"
for i in $(seq 1 60); do
  if curl -sf "http://localhost:$PORT/api/system" >/dev/null; then echo; echo "devhub is running → http://localhost:$PORT"; exit 0; fi
  echo -n "."; sleep 1
done
echo; echo "devhub did not respond on port $PORT; check: docker compose logs devhub"; exit 1
