# Development image: Node 24 + the Mailpit binary (used by scripts/npm.sh and tests).
FROM axllent/mailpit:v1.27 AS mailpit
FROM node:24-bookworm-slim
COPY --from=mailpit /mailpit /usr/local/bin/mailpit
