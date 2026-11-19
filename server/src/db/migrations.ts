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
];
