# Dev image + Python boto3 for the boto3 conformance test (server/test/storage.sdk.test.ts).
# Used by scripts/npm.sh when STUBYARD_BOTO3=1. Keep BOTO3_VERSION in step with .github/workflows/ci.yml.
FROM stubyard-dev:latest
ARG BOTO3_VERSION=1.44.7
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip \
  && rm -rf /var/lib/apt/lists/* \
  && pip3 install --break-system-packages --no-cache-dir "boto3==${BOTO3_VERSION}"
