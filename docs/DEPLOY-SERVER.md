# Running stubyard on a server for a team

stubyard is built to run on your own machine with no login. When a team shares one stubyard (from home, the office
and CI), run it on a server in **Teams mode**: everyone signs in with their own account, gets a role per project, and
every sign-in and change lands in the audit log. This guide sets that up with
[`deploy/docker-compose.server.yml`](../deploy/docker-compose.server.yml): stubyard plus Postgres 17 in two containers.

What lives where:

| Data | Where | Volume (default name) |
|---|---|---|
| Projects, inboxes, traffic, payments, storyboards, stored e-mails and files, the HTTPS CA | stubyard's SQLite file and data directory | `stubyard-server-data` |
| Users, project members, sessions, API tokens, invites, the audit log | Postgres, schema `stubyard` | `stubyard-server-pg` |

The app under test never signs in: SMTP, `/mock`, `/hook`, `/pay`, `/auth`, `/storage`, `/llm` and `/push` stay
open with their per-project keys, exactly as on a laptop. Only the dashboard, `/api`, `/mcp` and the browser
extension need a sign-in. Roles and what they can do: [GUIDE.md, "Teams"](GUIDE.md#teams-several-people-postgres).

Contents:

1. [Before you start](#1-before-you-start)
2. [Set up the server](#2-set-up-the-server)
3. [HTTPS](#3-https)
4. [Firewall](#4-firewall)
5. [First sign-in and adding people](#5-first-sign-in-and-adding-people)
6. [Backup and restore](#6-backup-and-restore)
7. [Upgrading from 0.15.0](#7-upgrading-from-0150)
8. [Moving from Single admin to Teams](#8-moving-from-single-admin-to-teams)

## 1. Before you start

- A Linux server (or VM) with Docker Engine and the Compose plugin (`docker compose version` prints v2). 2 GB RAM
  and a few GB of disk are plenty for a small team.
- A host name for it, for example `stubyard.example.com`: a DNS A (or AAAA) record pointing at the server, or an
  internal DNS name / `hosts` entry on a private network. An IP address works too, but names are easier with HTTPS.
- Decide how people reach it over HTTPS (section 3): stubyard's own CA on port 4443, or a reverse proxy such as Caddy
  with a public certificate on port 443.

## 2. Set up the server

**1. Get the two files.** Clone the repository, or copy just these two files into a directory on the server:

```bash
git clone https://github.com/imibrar/stubyard.git && cd stubyard
cp deploy/server.env.example deploy/.env
chmod 600 deploy/.env
```

**2. Pick the image.** `STUBYARD_IMAGE` in `deploy/.env` defaults to `ghcr.io/imibrar/stubyard:latest`. On a server,
pin the version you tested (`ghcr.io/imibrar/stubyard:<version>`). To run your own build:
`docker build -t stubyard:local .` and `STUBYARD_IMAGE=stubyard:local`.

**3. Database password.** Make a long random password and put it in two places: `POSTGRES_PASSWORD`, and inside
`STUBYARD_DATABASE_URL` (the host is `postgres`, the service name on the compose network; the database is not
published on any host port):

```bash
openssl rand -base64 24 | tr -d '/+='
# POSTGRES_PASSWORD=Xy…
# STUBYARD_DATABASE_URL=postgres://stubyard:Xy…@postgres:5432/stubyard
```

**4. The admin password hash.** The instance admin comes from the environment: `STUBYARD_ADMIN_EMAIL` plus a password
hash. Make the hash with the image itself, so the password never appears on a command line or in shell history:

```bash
docker run --rm -it ghcr.io/imibrar/stubyard:latest node dist/access/hash-password.js
# Password: ********   Again: ********
# scrypt:16384:8:1:…:…      <- put this in STUBYARD_ADMIN_PASSWORD_HASH
```

The hash has no `$` characters, so it is safe in `.env` as it is. This admin always signs in with this password,
cannot be disabled or demoted from the dashboard, and is the way back in if everything else is locked.

**5. Address and names.** In `deploy/.env`:

| Variable | Example | What |
|---|---|---|
| `STUBYARD_PUBLIC_URL` | `https://stubyard.example.com:4443` | The address people open. `https://` makes the session cookie Secure. |
| `STUBYARD_ALLOWED_HOSTS` | `stubyard.example.com,10.0.0.5` | Every name / IP people use. `/api` and `/mcp` refuse other Host names (DNS-rebinding guard). |
| `STUBYARD_TLS_NAMES` | `stubyard.example.com,10.0.0.5` | Names in stubyard's own HTTPS certificate (option A below). |
| `STUBYARD_TRUST_PROXY` | empty, or `true` | Only behind a reverse proxy (option B below). |

Every variable is explained in [`deploy/server.env.example`](../deploy/server.env.example).

**6. Start it.**

```bash
docker compose -f deploy/docker-compose.server.yml --env-file deploy/.env up -d
docker compose -f deploy/docker-compose.server.yml --env-file deploy/.env ps      # both "(healthy)" after ~20 s
docker compose -f deploy/docker-compose.server.yml --env-file deploy/.env logs stubyard | tail
```

The log says `Sign-in is on (Teams mode, users in Postgres; instance admin: …)`. stubyard waits up to 30 s for
Postgres and creates and migrates its schema itself. A missing required variable stops `docker compose` with a
message naming it.
## 3. HTTPS

Use HTTPS on a network: over plain HTTP, passwords and session cookies travel unencrypted (stubyard warns about it in
its log). Two ways:

**Option A: stubyard's own CA (port 4443).** Nothing else to install. stubyard made a certificate authority at its
first start (kept in the data volume) and serves HTTPS on 4443 with a certificate for `localhost`, `stubyard` and the
names in `STUBYARD_TLS_NAMES`.

- `STUBYARD_PUBLIC_URL=https://stubyard.example.com:4443`, `STUBYARD_TLS_NAMES=stubyard.example.com`.
- Each person installs the CA once: download `http://stubyard.example.com:4000/api/ca.crt` (or open the dashboard's
  **HTTPS setup** page, which has the steps per OS and checks whether your browser trusts it). Prefer trusting it in
  the browser or per process (`NODE_EXTRA_CA_CERTS`) over system-wide.
- Apps under test that call stubyard over HTTPS need the CA too; over plain HTTP (port 4000) they do not.

**Option B: a reverse proxy with a public certificate (Caddy).** People use `https://stubyard.example.com` with no CA
to install. Caddy gets a Let's Encrypt certificate by itself (the name must resolve publicly and ports 80 and 443 must
be reachable for that). On the server:

```
# /etc/caddy/Caddyfile
stubyard.example.com {
    reverse_proxy 127.0.0.1:4000 {
        flush_interval -1    # live updates (server-sent events) arrive at once
    }
}
```

and in `deploy/.env`:

```bash
STUBYARD_PUBLIC_URL=https://stubyard.example.com
STUBYARD_ALLOWED_HOSTS=stubyard.example.com
STUBYARD_WEB_BIND=127.0.0.1        # only Caddy (on this host) reaches ports 4000 / 4443
STUBYARD_TRUST_PROXY=true          # the client address comes from Caddy's X-Forwarded-For
```

`STUBYARD_TRUST_PROXY` makes sign-in limits and the audit log use the real client address. Set it only when every
request passes through the proxy: anyone who reaches stubyard directly could otherwise fake their address. With
`STUBYARD_WEB_BIND=127.0.0.1` only processes on the server reach the web ports. If other containers you do not
trust share the stubyard network, give the proxy's address instead of `true` (the network gateway, as Caddy on the
host connects through it: `docker network inspect stubyard-server -f '{{(index .IPAM.Config 0).Gateway}}'`).
nginx works the same way (`proxy_pass http://127.0.0.1:4000;`, `proxy_buffering off;`, and the usual
`X-Forwarded-For` / `X-Forwarded-Proto` headers).

## 4. Firewall

Open only what people and apps need:

| Port | Who needs it |
|---|---|
| 443 (and 80 for the certificate) | Everyone, with a reverse proxy (option B) |
| 4443 | Everyone, with stubyard's own HTTPS (option A) |
| 4000 | Apps that call stubyard over plain HTTP (`/mock`, `/pay`, …), and the CA download. Close it when nothing needs it. |
| 1025 | Apps that send e-mail over SMTP |
| 2197 | iOS apps using the fake APNs |
| 22 | You (SSH) |

**Docker and ufw / firewalld:** ports published by Docker bypass ufw and firewalld rules on the same host. Use a firewall
in front of the server (cloud security group, router), bind to 127.0.0.1 (`STUBYARD_WEB_BIND`), or add rules to
Docker's `DOCKER-USER` chain. Postgres is never published.

## 5. First sign-in and adding people

1. Open `STUBYARD_PUBLIC_URL` and sign in with `STUBYARD_ADMIN_EMAIL` and the password you hashed.
2. Create the projects (or import them: **Project → Settings → Data → Import**).
3. Add people in **Team** (account menu, or the top navigation):
   - **Add user**: e-mail, name, instance role, and (for a member) a first project with a role. stubyard shows a temporary password once;
     send it to the person yourself (stubyard's mail is fake and goes nowhere). They choose their own at the first
     sign-in.
   - **Invite link**: the link (`/invite#…`) works once, for 7 days; the person picks their name and password.
4. Per project, **Project → Members** sets roles (project admins can do this for their own projects).
5. Each person makes their own **API tokens** (account menu → API tokens) for the browser extension (0.6 and later:
   Settings → API token), `@stubyard/client` (`STUBYARD_TOKEN`), MCP clients (`Authorization: Bearer …`) and CI.
   A token can be narrowed to some projects and a highest role, for example a read-only token for CI.

Someone forgot their password? **Team → Reset password** gives a new temporary one (their sessions end and their API
tokens are revoked). Someone leaves? **Disable** them: every session and token stops at once.

**Audit log.** **System → Audit log** (instance admins) lists every sign-in (also failed ones), user, member, role,
token and invite change, project create / import / export / reset / delete, project and AI provider settings change,
clean-up run and factory reset, with filters and a CSV export. Project admins see their project's entries in
**Project → Settings → Audit log**. Entries are kept for `STUBYARD_AUDIT_RETENTION_DAYS` (default 365; 0 keeps them).

## 6. Backup and restore

Back up both parts together: Postgres (people and access) and the data volume (projects and everything in them). A
project's members are stored by its slug, so the two belong to the same moment.

**Back up** with a script (about a minute of downtime: stubyard is stopped first, so the SQLite files and Postgres are
copied at the same moment). Save it as `stubyard-backup.sh` next to the `deploy` directory and run it with
`bash stubyard-backup.sh` (from cron too); do not paste it into an interactive shell, where `set -e` would close the
shell on the first error.

```bash
#!/usr/bin/env bash
# stubyard-backup.sh: Postgres dump + data volume archive, made while stubyard is stopped.
set -euo pipefail
cd "$(dirname "$0")"
ENV_FILE=${ENV_FILE:-deploy/.env}
PROJECT=${PROJECT:-stubyard-server}                       # docker compose project name
DATA_VOLUME=${DATA_VOLUME:-stubyard-server-data}          # = STUBYARD_DATA_VOLUME in the .env file
OUT=${OUT:-backups}
dc() { docker compose -p "$PROJECT" -f deploy/docker-compose.server.yml --env-file "$ENV_FILE" "$@"; }

mkdir -p "$OUT"
stamp=$(date +%F-%H%M)
dc stop stubyard
trap 'dc start stubyard' EXIT                                # start it again, also when a step fails
# POSTGRES_USER / POSTGRES_DB are read inside the container, so non-default values work.
dc exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -n stubyard -Fc' > "$OUT/stubyard-pg-$stamp.dump"
docker run --rm -v "$DATA_VOLUME":/data:ro postgres:17-alpine tar czf - -C /data . > "$OUT/stubyard-data-$stamp.tgz"
echo "backup: $OUT/stubyard-pg-$stamp.dump $OUT/stubyard-data-$stamp.tgz"
```

Copy both files off the server. The data archive holds the HTTPS CA's private key and the dump holds password and
token hashes: store them like secrets. (`deploy/.env` is the third thing to keep, separately.)

**Restore** (onto the same server, or a new one with the same `deploy/.env`) with a second script,
`bash stubyard-restore.sh backups/stubyard-pg-<stamp>.dump backups/stubyard-data-<stamp>.tgz`. It replaces what
is there, in this order: stop both containers, **empty the data volume** and unpack the archive into it (never unpack
over old files: a stale SQLite `-wal` / `-shm` file next to the restored database can corrupt it), start Postgres
alone, drop the `stubyard` schema and restore the dump, then start stubyard (it migrates forward if the backup is
older).

```bash
#!/usr/bin/env bash
# stubyard-restore.sh <pg.dump> <data.tgz>: replaces the current data with a backup.
set -euo pipefail
cd "$(dirname "$0")"
DUMP=$(realpath "$1"); DATA=$(realpath "$2")
ENV_FILE=${ENV_FILE:-deploy/.env}
PROJECT=${PROJECT:-stubyard-server}
DATA_VOLUME=${DATA_VOLUME:-stubyard-server-data}
dc() { docker compose -p "$PROJECT" -f deploy/docker-compose.server.yml --env-file "$ENV_FILE" "$@"; }

dc down                                                      # both containers; volumes stay
docker volume create "$DATA_VOLUME" > /dev/null              # no-op when it exists
docker run --rm -v "$DATA_VOLUME":/data postgres:17-alpine find /data -mindepth 1 -delete    # empty it first
docker run --rm -i -v "$DATA_VOLUME":/data postgres:17-alpine tar xzf - -C /data < "$DATA"
dc up -d --wait postgres
dc exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "DROP SCHEMA IF EXISTS stubyard CASCADE"'
dc exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error' < "$DUMP"
dc up -d --wait
echo "restored from $DUMP and $DATA"
```

**Test a restore** now and then, without touching the real stack: copy `deploy/.env` to `deploy/restore-test.env`
and change the ports (`STUBYARD_HTTP_PORT`, `STUBYARD_HTTPS_PORT`, `STUBYARD_SMTP_PORT`, `STUBYARD_APNS_PORT`) and
the names (`STUBYARD_DATA_VOLUME=sy-restore-data`, `STUBYARD_PG_VOLUME=sy-restore-pg`,
`STUBYARD_NETWORK=sy-restore`). Then:

```bash
ENV_FILE=deploy/restore-test.env PROJECT=sy-restore DATA_VOLUME=sy-restore-data \
  bash stubyard-restore.sh backups/stubyard-pg-<stamp>.dump backups/stubyard-data-<stamp>.tgz
```

Sign in on the test ports as a member and check their projects and the audit log. Remove it with
`docker compose -p sy-restore -f deploy/docker-compose.server.yml --env-file deploy/restore-test.env down -v` plus
`docker volume rm sy-restore-data` (the script created it, so `down -v` leaves it). Never run `down -v` on the real
stack: it deletes both volumes.

## 7. Upgrading from 0.15.0

Back up first (section 6), then pull and restart:
`docker compose -f deploy/docker-compose.server.yml --env-file deploy/.env pull` and the same with `up -d`.
Migrations run at start.

- **SQLite migrations 28–30**: 28 the features board (`features`, `feature_counters`, `feature_tasks`,
  `feature_images`), 29 sign-in (`auth_sessions`, `api_tokens`), 30 `schedules.created_by`. Teams mode also
  creates the Postgres schema `stubyard` with its own migrations. There is no automatic way back: to return to
  0.15.0, restore the backup you made before.
- **New environment variables** (all optional; without them nothing changes):
  `STUBYARD_ADMIN_EMAIL`, `STUBYARD_ADMIN_PASSWORD_HASH` (or `STUBYARD_ADMIN_PASSWORD`),
  `STUBYARD_SESSION_TTL_HOURS`, `STUBYARD_COOKIE_SECURE`, `STUBYARD_TRUST_PROXY` (sign-in, Single admin mode);
  `STUBYARD_DATABASE_URL`, `STUBYARD_AUDIT_RETENTION_DAYS` (Teams mode). The `DEVHUB_` names work too.
- **Open mode (no admin configured): nothing to do.** stubyard behaves exactly as 0.15.0, without a login.
- **With sign-in on**, everything that talks to `/api` or `/mcp` needs a token: the browser extension 0.6.x (Settings
  → API token; older extensions get 401), `@stubyard/client` 0.9 (`STUBYARD_TOKEN` or `apiToken`), MCP clients
  (`--header "Authorization: Bearer …"`), scripts and CI. The app under test needs nothing.

## 8. Moving from Single admin to Teams

Single admin mode (`STUBYARD_ADMIN_EMAIL` and a password, no database) has one account and no audit log. To add
people, add Postgres:

1. Back up the data volume (section 6, the `tar` line; the local compose files call the volume `devhub-data`).
2. Stop the old container (`docker compose -f deploy/docker-compose.yml down`, without `-v`), so the ports are free.
3. Fill in `deploy/.env` as in section 2 with the **same** `STUBYARD_ADMIN_EMAIL` and hash, plus
   `STUBYARD_DATA_VOLUME=devhub-data` to keep using the existing data volume (and `STUBYARD_NETWORK=devhub` if
   app containers join that network). Compose warns that the volume was created outside this project; that is fine.
4. Start the server stack. The env admin becomes the first instance admin; projects and their data are unchanged.
5. Sign in again: Single admin sessions and API tokens are kept in SQLite and are not used in Teams mode, so make new
   API tokens for the extension, MCP clients and CI.
6. Add people and project members (section 5). Until then only the instance admin can see the projects.

Going back is the reverse: remove `STUBYARD_DATABASE_URL` and start without Postgres. Users, members and the audit
log stay in Postgres for later; the old Single admin tokens work again.
