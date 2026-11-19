#!/usr/bin/env bash
# devhub: load the image (first time only) and start it. macOS / Linux.
set -euo pipefail
cd "$(dirname "$0")"
if ! docker image inspect devhub:latest >/dev/null 2>&1 || [ "${1:-}" = "--reload" ]; then
  echo "Loading devhub image (one time, ~30 s)…"
  docker load -i devhub-image.tar.gz
fi
docker compose up -d
echo -n "Waiting for devhub"
for i in $(seq 1 60); do
  if curl -sf http://localhost:4000/api/system >/dev/null; then echo; echo "devhub is running → http://localhost:4000"; exit 0; fi
  echo -n "."; sleep 1
done
echo; echo "devhub did not respond; check: docker compose logs devhub"; exit 1
