#!/usr/bin/env bash
# Refresh the portable bundle (deploy/bundle) from the sources, optionally with the image and the tarball.
#
#   deploy/make-bundle.sh            copy the docs into deploy/bundle (AGENT_GUIDE.md, AGENTS.snippet.md, app example)
#   deploy/make-bundle.sh --image    also `docker save devhub:latest` → deploy/bundle/devhub-image.tar.gz
#   deploy/make-bundle.sh --tar      also pack deploy/bundle → deploy/devhub-bundle.tar.gz
#
# docs/AGENT_GUIDE.md is the single source of the agent guide; the bundle copy is generated here, never edited.
# (A running devhub also serves it at /api/agent-guide.) deploy/bundle/docker-compose.yml is maintained by hand
# (it uses the loaded image instead of building), so keep it in step with deploy/docker-compose.yml.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
B="$ROOT/deploy/bundle"
{
  echo '<!-- Generated from docs/AGENT_GUIDE.md by deploy/make-bundle.sh. Do not edit; a running devhub serves the same guide at http://localhost:4000/api/agent-guide -->'
  echo
  cat "$ROOT/docs/AGENT_GUIDE.md"
} > "$B/AGENT_GUIDE.md"
cp "$ROOT/deploy/AGENTS.snippet.md" "$B/AGENTS.snippet.md"
cp "$ROOT/deploy/docker-compose.app-example.yml" "$B/docker-compose.app-example.yml"
echo "bundle docs refreshed"
for arg in "$@"; do
  case "$arg" in
    --image) docker save devhub:latest | gzip > "$B/devhub-image.tar.gz"; echo "image saved" ;;
    --tar) tar -C "$ROOT/deploy" --exclude='bundle/.env' -czf "$ROOT/deploy/devhub-bundle.tar.gz" --transform 's,^bundle,devhub-bundle,' bundle; echo "deploy/devhub-bundle.tar.gz written" ;;
    *) echo "unknown option $arg" >&2; exit 2 ;;
  esac
done
