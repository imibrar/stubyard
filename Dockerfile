# syntax=docker/dockerfile:1
# devhub — single container: Node (API, dashboard, SMTP front) + embedded Mailpit.

# ---- build: compile server and dashboard ----
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
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
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev -w server --no-audit --no-fund

FROM axllent/mailpit:v1.27 AS mailpit

# ---- runtime ----
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    DEVHUB_DATA_DIR=/data \
    DEVHUB_WEB_DIR=/app/web \
    DEVHUB_MAILPIT_BIN=/usr/local/bin/mailpit
COPY --from=mailpit /mailpit /usr/local/bin/mailpit
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=build /app/server/dist /app/server/dist
COPY server/package.json /app/server/package.json
COPY --from=build /app/web/dist /app/web
RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /app/server
VOLUME /data
# 4000 = dashboard + HTTP mocks, 4443 = HTTPS, 1025 = SMTP
EXPOSE 4000 4443 1025
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:4000/api/system').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
