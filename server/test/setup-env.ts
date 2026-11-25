// Runs before every test file (vitest.config.ts setupFiles). loadConfig() reads STUBYARD_* (and the legacy DEVHUB_*)
// from the environment, so a shell that runs a real stubyard (the dev container sets STUBYARD_PUBLIC_URL, STUBYARD_SEED,
// STUBYARD_ALLOWED_HOSTS, STUBYARD_DATA_DIR, ...) would leak into every test hub. Clear them so the suite behaves as in
// CI; keep only the knobs the tests themselves read.
const KEEP = new Set(['STUBYARD_MAILPIT_BIN', 'STUBYARD_TEST_DATABASE_URL', 'STUBYARD_SDK_TESTS']);

for (const name of Object.keys(process.env)) {
  if (/^(STUBYARD|DEVHUB)_/.test(name) && !KEEP.has(name)) delete process.env[name];
}
