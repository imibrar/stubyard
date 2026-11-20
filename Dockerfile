# syntax=docker/dockerfile:1
# stubyard — single container: Node (API, dashboard, SMTP front) + embedded Mailpit.

# ---- build: compile server and dashboard ----
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY packages/client/package.json packages/client/
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY server server
COPY web web
RUN npm run build -w server && npm run build -w web

# ---- deps: production dependencies of the server only ----
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY packages/client/package.json packages/client/
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev -w server --no-audit --no-fund

FROM axllent/mailpit:v1.27 AS mailpit

# ---- runtime ----
FROM node:24-bookworm-slim
LABEL org.opencontainers.image.title="stubyard" \
      org.opencontainers.image.description="Fake email, SMS, WhatsApp, payment, storage and login providers for local testing, in one container" \
      org.opencontainers.image.source="https://github.com/imibrar/stubyard" \
      org.opencontainers.image.licenses="MIT"
# STUBYARD_HOST=0.0.0.0: inside the container stubyard must listen on all interfaces, or published ports cannot reach it.
# Who can reach it is decided by the port publishing: `-p 127.0.0.1:4000:4000` (this machine only, recommended).
ENV NODE_ENV=production \
    STUBYARD_HOST=0.0.0.0 \
    STUBYARD_DATA_DIR=/data \
    STUBYARD_WEB_DIR=/app/web \
    STUBYARD_MAILPIT_BIN=/usr/local/bin/mailpit
COPY --from=mailpit /mailpit /usr/local/bin/mailpit
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=build /app/server/dist /app/server/dist
COPY server/package.json /app/server/package.json
COPY --from=build /app/web/dist /app/web
# Served at GET /api/agent-guide (host/ports rewritten per request)
COPY docs/AGENT_GUIDE.md /app/docs/AGENT_GUIDE.md
RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /app/server
VOLUME /data
# 4000 = dashboard + HTTP mocks, 4443 = HTTPS, 1025 = SMTP
EXPOSE 4000 4443 1025
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:4000/api/system').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
