# Running devhub in CI

devhub runs in CI the same way it runs on your machine: one container, started before the app's tests, configured
from a committed project export. Tests read codes and messages through the REST API (the wait API is made for this).

A complete GitHub Actions workflow is in [`deploy/github-actions-example.yml`](../deploy/github-actions-example.yml).

## 1. Commit the project configuration

Export the project once from a working local devhub and commit it to the app's repository:

```bash
mkdir -p devhub
curl -s http://localhost:4000/api/projects/hyper/export > devhub/devhub-hyper.json
# with authenticator (TOTP) keys:  .../export?secrets=1
```

The export contains test users, provider instances (with their callback URLs), scenario rules, webhook endpoints /
templates / sequences, API mocks and authenticator keys (with `secrets=1`). Messages and logs are never exported.

Callback URLs in the export must work from where devhub runs in CI, for example `http://localhost:3000/...` with host
networking (below). URLs outside the [outbound allowlist](#outbound-allowlist) are not called.

## 2. Start devhub with `DEVHUB_SEED`

`DEVHUB_SEED` is a `.json` export, or a directory of them. At start, devhub imports each project whose slug doesn't
exist yet and skips the ones that do, so it's safe to keep the seed mounted. Each import is logged
(`DEVHUB_SEED: project created` / `skipped` / `import failed`). The seed is imported **before** devhub starts
listening, so once `/api/system` answers, the projects exist.

```bash
docker run -d --name devhub --network host \
  -e DEVHUB_HOST=127.0.0.1 -e DEVHUB_SEED=/config -e DEVHUB_CALLBACK_DELAY_MS=300 \
  -v "$PWD/devhub:/config:ro" devhub:ci

for i in $(seq 1 60); do curl -sf http://localhost:4000/api/system >/dev/null && break; sleep 1; done
```

- `--network host` (Linux runners): devhub shares the runner's network, so callbacks reach the app at
  `localhost:<port>` even when the app listens on 127.0.0.1 only. `DEVHUB_HOST=127.0.0.1` keeps devhub off other interfaces.
  Without host networking, publish the ports (`-p 127.0.0.1:4000:4000 …`), add
  `--add-host=host.docker.internal:host-gateway`, start the app on `0.0.0.0` and use `http://host.docker.internal:<port>`
  in callback URLs.
- `DEVHUB_CALLBACK_DELAY_MS=300` makes delivery reports arrive faster (default 1.5 s).
- `GET /api/projects/<p>/doctor` checks that devhub can reach every configured callback URL. Run it after the app has started
  (`jq -e .ok` fails the job early with a clear message rather than a test timeout).

## 3. Tests

The app sends to devhub as usual (SMTP `localhost:1025`, provider base URLs `http://localhost:4000/mock/<p>/<instance>`).
Tests read the results:

```bash
# Next code admin receives (call right after triggering it in the app)
curl -s "$DEVHUB_URL/api/projects/hyper/messages/wait?user=admin&otp=1&timeout=30" | jq -r .otp
```

```js
// e.g. in Playwright
const r = await fetch(`${process.env.DEVHUB_URL}/api/projects/hyper/messages/wait?user=admin&otp=1&timeout=30`);
const { otp } = await r.json();
```

Start each run clean with `POST /api/projects/<p>/reset` (messages and logs only; users and settings are kept). Use
scenario rules (`POST /api/projects/<p>/users/<user>/rules`) for failure tests and reset them afterwards.

When a job fails, upload `GET /api/logs?project=<p>` (every request in and out, with errors), the messages and the doctor
report as artifacts; the example workflow does this.

## 4. The devhub image

There is **no published image yet**. Until there is, build it in the workflow (the example uses
`docker/build-push-action` with `load: true` and the GitHub Actions cache, so it is only rebuilt when devhub changes),
or `docker load` a saved image (`docker save devhub:latest | gzip > devhub-image.tar.gz`, as in the portable bundle)
from a cache / artifact.

GitHub Actions `services:` containers are started before any step runs, so they need an image from a registry. They
work once an image is published (see below). The seed file isn't checked out yet when services start, so import it with
the API instead of `DEVHUB_SEED`:

```yaml
services:
  devhub:
    image: ghcr.io/<owner>/devhub:0.3
    ports: ["4000:4000", "4443:4443", "1025:1025"]
    options: >-
      --add-host=host.docker.internal:host-gateway
      --health-cmd "node -e \"fetch('http://127.0.0.1:4000/api/system').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""
      --health-interval 2s --health-retries 30
steps:
  - uses: actions/checkout@v4
  - run: curl -sf -X POST http://localhost:4000/api/projects/import -H 'content-type: application/json' --data @devhub/devhub-hyper.json
```

### Proposal: publishing to GHCR (not done)

- Workflow in the devhub repo, triggered on version tags (`v*`): `docker/setup-qemu-action` + `docker/setup-buildx-action`,
  `docker/login-action` to `ghcr.io` with `GITHUB_TOKEN` (`permissions: packages: write`), then `docker/build-push-action`
  with `platforms: linux/amd64,linux/arm64` (native arm64 for Apple Silicon) and tags `ghcr.io/<owner>/devhub:<version>`,
  `:<major>.<minor>` and `:latest`.
- Add OCI labels (`org.opencontainers.image.source`, `version`, `revision`) via `docker/metadata-action`, and make the
  package public so CI in other repositories can pull it without credentials.
- The portable bundle (`deploy/bundle`) can then reference the registry image instead of shipping a `.tar.gz`.

## Outbound allowlist

devhub calls your app (status callbacks, inbound messages, email events, webhook templates). So an imported or
copied config never calls a real or production URL, only these hosts are called by default:

`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`, `host.docker.internal`, `gateway.docker.internal`, `*.local`, `*.test`,
`*.internal`, `*.lan`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`, `fe80::/10`, and single-label names
(docker service names such as `app`). A name that resolves only to such private addresses is allowed too.

Other calls are not sent: the traffic log shows them as `network_error` / `blocked_by_allowlist` with the reason.
`DEVHUB_OUTBOUND_ALLOW=+staging.example.com,*.corp` adds entries, a value without `+` replaces the list, and `*` turns
the check off. `DEVHUB_OUTBOUND_INSECURE_TLS=1` (or a host list) accepts self-signed certificates when calling the app over HTTPS.
