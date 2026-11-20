#!/usr/bin/env bash
# Run npm inside the stubyard dev container (Node 24 + Mailpit); no Node needed on the host.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE=stubyard-dev:latest
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker build -q -t "$IMAGE" -f "$ROOT/docker/dev.Dockerfile" "$ROOT/docker" >/dev/null
fi
mkdir -p "$ROOT/.cache/npm"
TTY=""; [ -t 0 ] && [ -t 1 ] && TTY="-it"
exec docker run --rm $TTY --user "$(id -u):$(id -g)" \
  -e HOME=/tmp -e npm_config_cache=/app/.cache/npm -e npm_config_update_notifier=false \
  -v "$ROOT:/app" -w /app ${STUBYARD_DOCKER_ARGS:-} \
  "$IMAGE" npm "$@"
