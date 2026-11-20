#!/usr/bin/env bash
# Run npm inside the stubyard dev container (Node 24 + Mailpit); no Node needed on the host.
# STUBYARD_BOTO3=1 uses a variant with Python + pinned boto3 (docker/dev-boto3.Dockerfile) so the boto3 test runs too:
#   STUBYARD_BOTO3=1 ./scripts/npm.sh test -w server -- test/storage.sdk.test.ts
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE=stubyard-dev:latest
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker build -q -t "$IMAGE" -f "$ROOT/docker/dev.Dockerfile" "$ROOT/docker" >/dev/null
fi
if [ "${STUBYARD_BOTO3:-0}" = "1" ]; then
  BOTO3_VERSION="$(sed -n 's/^ARG BOTO3_VERSION=//p' "$ROOT/docker/dev-boto3.Dockerfile")"
  IMAGE="stubyard-dev-boto3:$BOTO3_VERSION"
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    docker build -q -t "$IMAGE" -f "$ROOT/docker/dev-boto3.Dockerfile" "$ROOT/docker" >/dev/null
  fi
fi
mkdir -p "$ROOT/.cache/npm"
TTY=""; [ -t 0 ] && [ -t 1 ] && TTY="-it"
exec docker run --rm $TTY --user "$(id -u):$(id -g)" \
  -e HOME=/tmp -e npm_config_cache=/app/.cache/npm -e npm_config_update_notifier=false \
  -v "$ROOT:/app" -w /app ${STUBYARD_DOCKER_ARGS:-} \
  "$IMAGE" npm "$@"
