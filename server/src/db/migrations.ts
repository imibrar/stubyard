/**
 * Versioned schema migrations. Never edit an applied migration; add a new one.
 * JSON columns are stored as TEXT.
 */
export const migrations: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE test_users (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  email TEXT,
  phone TEXT,
  whatsapp TEXT,
  marketing_opt_out INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (project_id, email),
  UNIQUE (project_id, phone),
  UNIQUE (project_id, whatsapp)
);
CREATE INDEX idx_test_users_project ON test_users(project_id);

CREATE TABLE provider_instances (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('email','sms','whatsapp')),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  preset TEXT NOT NULL,
  labels TEXT NOT NULL DEFAULT '[]',
  is_default INTEGER NOT NULL DEFAULT 0,
  config TEXT NOT NULL DEFAULT '{}',
  default_action TEXT NOT NULL DEFAULT 'deliver',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, slug)
);
CREATE INDEX idx_provider_instances_project ON provider_instances(project_id);

CREATE TABLE traffic_logs (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  protocol TEXT NOT NULL CHECK (protocol IN ('http','smtp')),
  method TEXT,
  url TEXT,
  client_ip TEXT,
  req_headers TEXT,
  req_body TEXT,
  req_body_size INTEGER,
  req_truncated INTEGER NOT NULL DEFAULT 0,
  res_status INTEGER,
  res_headers TEXT,
  res_body TEXT,
  res_body_size INTEGER,
  res_truncated INTEGER NOT NULL DEFAULT 0,
  error_type TEXT,
  error_message TEXT,
  outcome TEXT NOT NULL DEFAULT 'pending',
  resolved TEXT NOT NULL DEFAULT '{}',
  transcript TEXT,
  parent_log_id TEXT,
  received_at TEXT NOT NULL,
  responded_at TEXT,
  duration_ms INTEGER
);
CREATE INDEX idx_traffic_logs_project_time ON traffic_logs(project_id, received_at);
CREATE INDEX idx_traffic_logs_time ON traffic_logs(received_at);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  test_user_id TEXT REFERENCES test_users(id) ON DELETE SET NULL,
  provider_instance_id TEXT REFERENCES provider_instances(id) ON DELETE SET NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email','sms','whatsapp')),
  direction TEXT NOT NULL CHECK (direction IN ('outbound','inbound')),
  from_addr TEXT,
  to_addr TEXT NOT NULL,
  subject TEXT,
  body_text TEXT,
  has_html INTEGER NOT NULL DEFAULT 0,
  attachments INTEGER NOT NULL DEFAULT 0,
  mailpit_id TEXT,
  message_id_header TEXT,
  status TEXT NOT NULL,
  status_detail TEXT,
  applied_rule TEXT,
  otp TEXT,
  links TEXT NOT NULL DEFAULT '[]',
  duplicate_of_id TEXT,
  log_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_messages_project_time ON messages(project_id, created_at);
CREATE INDEX idx_messages_user_time ON messages(test_user_id, created_at);
`,
  },
  {
    version: 2,
    sql: `
CREATE TABLE authenticators (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  test_user_id TEXT REFERENCES test_users(id) ON DELETE SET NULL,
  label TEXT NOT NULL,
  issuer TEXT,
  account TEXT,
  secret TEXT NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'SHA1',
  digits INTEGER NOT NULL DEFAULT 6,
  period INTEGER NOT NULL DEFAULT 30,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_authenticators_project ON authenticators(project_id);
`,
  },
  {
    version: 3,
    sql: `
-- pinned: 0 = not pinned, otherwise the position in the pinned bar (1, 2, 3…)
ALTER TABLE test_users ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
-- Test password for the app under test (shown in the UI so you can log in as this user).
ALTER TABLE test_users ADD COLUMN password TEXT;
CREATE INDEX idx_messages_project_otp ON messages(project_id, otp) WHERE otp IS NOT NULL;
`,
  },
  {
    version: 4,
    sql: `
-- Scenario rules. scope "user": a test user's rules (optionally limited to one instance);
-- scope "instance": rules for everyone on a provider instance (down, slow, fail_rate…).
CREATE TABLE rules (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('user','instance')),
  test_user_id TEXT REFERENCES test_users(id) ON DELETE CASCADE,
  provider_instance_id TEXT REFERENCES provider_instances(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'all' CHECK (channel IN ('all','email','sms','whatsapp')),
  position INTEGER NOT NULL DEFAULT 0,
  action TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  delay_ms INTEGER,
  fail_rate REAL,
  remaining_count INTEGER,
  skip_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  label TEXT,
  hits INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_rules_user ON rules(test_user_id, position);
CREATE INDEX idx_rules_instance ON rules(provider_instance_id, position);

-- Work to do later: status callbacks, delayed deliveries, delayed bounces.
CREATE TABLE scheduled_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  run_at TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_jobs_due ON scheduled_jobs(status, run_at);

ALTER TABLE messages ADD COLUMN provider_message_id TEXT;
CREATE INDEX idx_messages_provider_id ON messages(provider_message_id) WHERE provider_message_id IS NOT NULL;
`,
  },
  {
    version: 5,
    sql: `
-- Phase 3: webhooks. Inbound endpoints under /hook/<project>/<path>; outbound templates and sequences.
CREATE TABLE webhook_endpoints (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'ANY',
  json_schema TEXT,
  response TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, path, method)
);
CREATE INDEX idx_webhook_endpoints_project ON webhook_endpoints(project_id);

CREATE TABLE webhook_templates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  target_url TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'POST',
  headers TEXT NOT NULL DEFAULT '{}',
  body_template TEXT NOT NULL DEFAULT '',
  signing TEXT NOT NULL DEFAULT '{"preset":"none"}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, name)
);
CREATE INDEX idx_webhook_templates_project ON webhook_templates(project_id);

-- steps: [{ templateId, delayMs, repeat }]
CREATE TABLE webhook_sequences (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  steps TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, name)
);
`,
  },
  {
    version: 7,
    sql: `
-- Phase 5: rule-based API mocks under /mock/<project>/api/…  (match + scenarios are JSON).
CREATE TABLE api_mocks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL DEFAULT 'ANY',
  path TEXT NOT NULL,
  match TEXT NOT NULL DEFAULT '{}',
  scenarios TEXT NOT NULL DEFAULT '[]',
  active_scenario TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  hits INTEGER NOT NULL DEFAULT 0,
  last_hit_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, name)
);
CREATE INDEX idx_api_mocks_project ON api_mocks(project_id, position);
`,
  },
  {
    version: 8,
    sql: `
-- Test runs: isolation of parallel test workers (ephemeral users, run-scoped rules / mock scenarios, attribution).
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','stopped')),
  capture_unattributed INTEGER NOT NULL DEFAULT 0,
  claims TEXT NOT NULL DEFAULT '[]',
  meta TEXT NOT NULL DEFAULT '{}',
  report TEXT,
  started_at TEXT NOT NULL, stopped_at TEXT, expires_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_runs_active_key ON runs(project_id, key) WHERE status = 'active';
ALTER TABLE test_users     ADD COLUMN run_id TEXT REFERENCES runs(id) ON DELETE CASCADE;
ALTER TABLE rules          ADD COLUMN run_id TEXT REFERENCES runs(id) ON DELETE CASCADE;
ALTER TABLE authenticators ADD COLUMN run_id TEXT REFERENCES runs(id) ON DELETE CASCADE;
ALTER TABLE messages       ADD COLUMN run_id TEXT REFERENCES runs(id) ON DELETE SET NULL;
ALTER TABLE traffic_logs   ADD COLUMN run_id TEXT REFERENCES runs(id) ON DELETE SET NULL;
CREATE INDEX idx_messages_run ON messages(run_id, id) WHERE run_id IS NOT NULL;
CREATE INDEX idx_logs_run ON traffic_logs(run_id, id) WHERE run_id IS NOT NULL;
CREATE INDEX idx_users_run ON test_users(run_id) WHERE run_id IS NOT NULL;
CREATE TABLE run_mock_scenarios (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  mock_id TEXT NOT NULL REFERENCES api_mocks(id) ON DELETE CASCADE,
  scenario TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, mock_id)
);
`,
  },
  {
    version: 9,
    sql: `
-- Login providers: fake OAuth 2.0 / OpenID Connect identity providers under /auth/<project>/<provider>/…
CREATE TABLE auth_providers (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug TEXT NOT NULL, name TEXT NOT NULL, preset TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (project_id, slug));
CREATE TABLE auth_keys (
  id TEXT PRIMARY KEY, auth_provider_id TEXT NOT NULL REFERENCES auth_providers(id) ON DELETE CASCADE,
  kid TEXT NOT NULL, alg TEXT NOT NULL DEFAULT 'RS256', private_pem TEXT NOT NULL, public_jwk TEXT NOT NULL,
  cert_pem TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  created_at TEXT NOT NULL, retired_at TEXT, UNIQUE (auth_provider_id, kid));
CREATE TABLE auth_identities (
  id TEXT PRIMARY KEY, auth_provider_id TEXT NOT NULL REFERENCES auth_providers(id) ON DELETE CASCADE,
  test_user_id TEXT NOT NULL REFERENCES test_users(id) ON DELETE CASCADE,
  sub TEXT NOT NULL, claims TEXT NOT NULL DEFAULT '{}', consented INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
  UNIQUE (auth_provider_id, test_user_id), UNIQUE (auth_provider_id, sub));
CREATE TABLE auth_grants (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  auth_provider_id TEXT NOT NULL REFERENCES auth_providers(id) ON DELETE CASCADE,
  test_user_id TEXT REFERENCES test_users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('pending','code','access','refresh','session')),
  token TEXT NOT NULL UNIQUE, client_id TEXT, redirect_uri TEXT, scope TEXT, nonce TEXT,
  code_challenge TEXT, code_challenge_method TEXT, family_id TEXT, parent_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','used','revoked')),
  params TEXT NOT NULL DEFAULT '{}', log_id TEXT, created_at TEXT NOT NULL, expires_at TEXT, used_at TEXT);
CREATE INDEX idx_auth_grants_family ON auth_grants(family_id);
CREATE INDEX idx_auth_grants_expiry ON auth_grants(expires_at);
CREATE TABLE auth_rules (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  auth_provider_id TEXT NOT NULL REFERENCES auth_providers(id) ON DELETE CASCADE,
  test_user_id TEXT REFERENCES test_users(id) ON DELETE CASCADE,
  stage TEXT NOT NULL DEFAULT 'any' CHECK (stage IN ('any','authorize','token','refresh','userinfo','jwks')),
  action TEXT NOT NULL, params TEXT NOT NULL DEFAULT '{}', position INTEGER NOT NULL DEFAULT 0,
  remaining_count INTEGER, skip_count INTEGER NOT NULL DEFAULT 0, expires_at TEXT, label TEXT,
  hits INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
`,
  },
];
