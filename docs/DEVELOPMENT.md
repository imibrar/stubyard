# Developing stubyard

A handoff guide for anyone working on stubyard itself: what you need, how to run it from source, where things live,
how to add a feature and how a release is made. For *using* stubyard, see [GUIDE.md](GUIDE.md); for the full
API reference, see [AGENT_GUIDE.md](AGENT_GUIDE.md).

## Branches

| Branch | Purpose |
|---|---|
| `main` | Released code. Every release is a commit on `main` plus a `vX.Y.Z` tag. |
| `dev` | Day-to-day development. Work here (or on short feature branches off `dev`), merge to `main` when releasing. |

```bash
git checkout dev && git pull
git checkout -b feature/my-thing      # optional, for bigger changes
# … work, commit …
git checkout dev && git merge feature/my-thing
```

CI (`.github/workflows/ci.yml`) runs on every push to every branch: typecheck, tests, build.

## What you need

- **Docker** (Docker Desktop on macOS/Windows, Docker Engine on Linux). That is all: Node is *not* required on
  the host. `scripts/npm.sh` runs npm inside a dev container (`docker/dev.Dockerfile`: Node 24 + the Mailpit binary).
- **git**.
- Optional: Node 24 on the host if you prefer running npm directly (then install Mailpit too, or the e2e tests that
  need it are skipped).
- Optional: an API key for Anthropic / OpenAI / Google / OpenRouter, only to try AI chat and personas against real
  models. Tests never need one (they use the built-in `mock:*` providers).

## First run

```bash
git clone https://github.com/imibrar/stubyard.git && cd stubyard
git checkout dev
./scripts/npm.sh ci                 # install all workspaces (first call also builds the dev image)
./scripts/npm.sh run typecheck
./scripts/npm.sh test               # full server test suite
./scripts/dev.sh                    # watch mode → http://localhost:5173 (dashboard), :4000 (API)
```

`scripts/dev.sh` runs the server with `tsx watch` and the dashboard with Vite (which proxies `/api` to the server).
Dev data goes to `./data` (git-ignored); delete it for a clean start.

**Ports already taken** (for example a stubyard container is running on the same machine)? Move the dev ports:

```bash
STUBYARD_DEV_HTTP_PORT=34000 STUBYARD_DEV_HTTPS_PORT=34443 STUBYARD_DEV_SMTP_PORT=31025 \
STUBYARD_DEV_APNS_PORT=32197 STUBYARD_DEV_WEB_PORT=35173 ./scripts/dev.sh
```

To run the production image from your checkout instead: `docker compose up -d --build` (root `docker-compose.yml`
includes `deploy/docker-compose.yml`).

## Everyday commands

All of these work as `./scripts/npm.sh …` (or plain `npm …` with Node on the host).

| Command | What it does |
|---|---|
| `run typecheck` | `tsc --noEmit` for server, web and `@stubyard/client` |
| `test` | All server tests (vitest, files run one after another) |
| `test -w server -- test/personas.e2e.test.ts` | One test file |
| `test -w server -- -t "refund"` | Tests whose name matches |
| `run build` | Compile server (`server/dist`) and dashboard (`web/dist`) |
| `run test:sdk -w server` | Real-SDK conformance tests only |

`STUBYARD_BOTO3=1 ./scripts/npm.sh test -w server -- test/storage.sdk.test.ts` uses a dev image with Python and a
pinned boto3 (`docker/dev-boto3.Dockerfile`) so the boto3 S3 test runs instead of being skipped. CI installs the
same pinned version.

## Repository layout

```
server/                 Fastify server, Node built-in SQLite (node:sqlite), TypeScript ESM
  src/index.ts          createHub(): wires every repo/service into the Hub, starts HTTP/HTTPS/SMTP/APNs
  src/hub.ts            Hub interface: the one object route handlers and services receive
  src/config.ts         all STUBYARD_* environment variables (DEVHUB_* still read as a fallback)
  src/db/migrations.ts  ordered SQL migrations (append only)
  src/http/app.ts       buildApp(): registers the guard, hooks and every route module
  src/http/routes/      REST API (/api/…) and provider endpoints, one file per area
  src/repos/            table access (one repo per area)
  src/<feature>/        feature services: payments/, chat/, personas/, push/, storage/, auth/, webhooks/, …
  test/                 vitest suites: *.e2e.test.ts start a full hub; *.sdk.test.ts drive it with real vendor SDKs
web/                    React 19 + Vite dashboard
  src/App.tsx           top-level routes; project pages are tabs inside pages/ProjectPage.tsx
  src/pages/            one page per area; src/*Api.ts are the typed API clients
packages/client/        @stubyard/client: the test helper library apps use in their own tests
docs/                   GUIDE.md (users), AGENT_GUIDE.md (full reference, also served at /api/agent-guide),
                        CI.md, CONCEPT.md, PLAN.md, DEVELOPMENT.md (this file)
deploy/                 compose files, the offline Windows/macOS/Linux bundle (deploy/bundle), make-bundle.sh
docker/                 dev images used by scripts/npm.sh
Dockerfile              production image (multi-stage; exposes 4000 4443 1025 2197)
```

Ports inside the container: 4000 HTTP (dashboard, API, provider endpoints), 4443 HTTPS (local CA), 1025 SMTP,
2197 fake APNs (HTTP/2).

## Adding a feature (the usual path)

1. **Migration** — append a new `{ version: N, sql: \`…\` }` entry at the end of `server/src/db/migrations.ts`.
   Never edit or renumber an existing one (live installs have already applied it). Versions used: 1–5, 7–23;
   **the next free number is 24**. Every per-project table gets `project_id … REFERENCES projects(id) ON DELETE
   CASCADE` (and `run_id … REFERENCES runs(id) ON DELETE CASCADE` if it is run-scoped).
2. **Repo / service** — table access in `server/src/repos/` or a `server/src/<feature>/service.ts`.
3. **Wire it** — add the field to `Hub` in `hub.ts` and construct it in `createHub()` in `index.ts`.
4. **Routes** — a `registerXxxRoutes(app, hub)` module in `server/src/http/routes/`, registered in `http/app.ts`.
   Validate input with zod; throw `HttpError` for 4xx.
5. **Housekeeping hooks** if the feature stores data:
   - retention purge in `server/src/maintenance/retention.ts` (`purgePerProject`),
   - project export/import (see `personas/export.ts` for the pattern) — mask secrets unless `?secrets=1`,
   - project reset.
6. **Outbound calls** (webhooks, callbacks) must go through the outbound allowlist (`STUBYARD_OUTBOUND_ALLOW`) and
   URL check (`rejectUrl`); never call arbitrary hosts.
7. **Dashboard** — a page in `web/src/pages/`, its API client in `web/src/<feature>Api.ts`, a tab in
   `ProjectPage.tsx`. Check it at 390, 768, 1280 and 1920 px wide.
8. **Tests** — an `*.e2e.test.ts` that starts a hub on free ports with a temp data dir (copy the setup at the top of an
   existing suite such as `test/personas.e2e.test.ts`). Use real vendor SDKs in `*.sdk.test.ts` where one exists.
9. **Docs** — the reference section in `docs/AGENT_GUIDE.md` (the single source; the bundle copy is generated),
   a short walkthrough in `docs/GUIDE.md`, and a line in `CHANGELOG.md`.

### Conventions

- TypeScript strict, ESM, `.js` suffix in relative imports.
- Everything a provider receives or sends is written to the traffic log; keep it that way for new endpoints.
- Mask card numbers, tokens and secrets in logs and exports.
- Keep dependencies pinned in the AI packages (`ai`, `@ai-sdk/*`, `zod`) — they move fast.
- Env vars are `STUBYARD_*`; read them through `envVar()` in `config.ts` so the old `DEVHUB_*` names keep working.
  The Docker volume (`devhub-data`) and network (`devhub`) keep their pre-rename names on purpose, so do not
  rename them.

## Making a release

1. On `dev`: typecheck, run the test suite **twice** (to catch flaky tests), build.
2. Bump the version in all of these places:
   - `package.json`, `server/package.json`, `web/package.json`
   - `VERSION` in `server/src/http/routes/api.ts` and `version` in `server/src/http/routes/mcp.ts`
   - `packages/client/package.json` only if the client changed (it has its own version)
3. Add the release to `CHANGELOG.md`; refresh the bundle docs with `deploy/make-bundle.sh`.
4. Build the image and smoke-test it on spare ports:
   ```bash
   docker build -t stubyard:latest .
   docker run -d --rm --name stubyard-smoke -p 127.0.0.1:25000:4000 stubyard:latest
   curl -s http://127.0.0.1:25000/api/system      # name + version
   docker stop stubyard-smoke
   ```
5. Merge `dev` into `main`, then tag and push:
   ```bash
   git checkout main && git merge --ff-only dev
   git tag v0.14.0 && git push origin main v0.14.0
   git checkout dev
   ```
   The `v*` tag triggers `.github/workflows/release.yml`, which publishes `ghcr.io/imibrar/stubyard:<version>` and
   `:latest` for amd64 and arm64.
6. Offline bundle (optional): `deploy/make-bundle.sh --image --tar` → `deploy/stubyard-bundle.tar.gz`.

### Upgrading a running instance

Data lives in the Docker volume, so an upgrade is: back up, then replace the container.

```bash
docker run --rm -v devhub-data:/data -v "$PWD":/backup alpine tar czf /backup/stubyard-data-backup.tgz -C /data .
docker compose -f deploy/docker-compose.yml up -d --build      # migrations run automatically at start
```

Never use `docker compose down -v` on an instance whose data you want: `-v` deletes the volume (projects, emails,
the HTTPS CA).

## Gotchas

- **e2e tests need Mailpit.** Present in the dev image and in CI; with host Node and no Mailpit, those suites skip.
- **Tests run one file at a time** (`fileParallelism: false`) because e2e suites start full hubs; timeouts are raised
  in `server/vitest.config.ts`.
- **Never commit secrets.** `.env` files and `deploy/bundle/.env` are git-ignored and excluded from the bundle
  tarball; keep it that way.
- **Behind an SSH tunnel with different ports**, set `STUBYARD_PUBLIC_URL` (e.g. `https://localhost:24443`) so login
  and payment pages redirect the browser to the right address.
- **HTTPS CA:** each data directory has its own CA. Deleting `./data` (dev) or the volume makes a new one, which
  browsers and apps must trust again.

## Where to look next

- [CONCEPT.md](CONCEPT.md) — the original design and principles.
- [PLAN.md](PLAN.md) — the roadmap history.
- [CHANGELOG.md](../CHANGELOG.md) — what each release added.
- [CI.md](CI.md) — running stubyard inside other projects' CI.
