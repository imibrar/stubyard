/**
 * Versioned schema migrations. Never edit an applied migration; add a new one.
 * JSON columns are stored as TEXT.
 */
export const migrations: { version: number; sql: string; foreignKeysOff?: boolean }[] = [
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
  {
    version: 10,
    sql: `
-- Phase 6.5: Verify APIs (Twilio Verify v2, Vonage Verify v2) and WhatsApp media.
CREATE TABLE verify_services (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider_instance_id TEXT NOT NULL REFERENCES provider_instances(id) ON DELETE CASCADE,
  friendly_name TEXT NOT NULL, code_length INTEGER NOT NULL DEFAULT 6, config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX idx_verify_services_instance ON verify_services(provider_instance_id);
CREATE TABLE verifications (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider_instance_id TEXT NOT NULL REFERENCES provider_instances(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('twilio','vonage')), service_id TEXT,
  to_addr TEXT NOT NULL, channel TEXT NOT NULL, code TEXT NOT NULL, status TEXT NOT NULL,
  send_attempts TEXT NOT NULL DEFAULT '[]', check_attempts INTEGER NOT NULL DEFAULT 0,
  message_ids TEXT NOT NULL DEFAULT '[]', params TEXT NOT NULL DEFAULT '{}',
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL, log_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE INDEX idx_verifications_lookup ON verifications(provider_instance_id, to_addr, status);
CREATE TABLE wa_media (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider_instance_id TEXT NOT NULL REFERENCES provider_instances(id) ON DELETE CASCADE,
  mime_type TEXT NOT NULL, sha256 TEXT NOT NULL, file_size INTEGER NOT NULL, filename TEXT,
  data BLOB NOT NULL, created_at TEXT NOT NULL);
`,
  },
  {
    version: 11,
    sql: `
-- File storage simulator (S3 family, GCS, Azure Blob, Cloudinary, Supabase) under /storage/<project>/<instance>/…
CREATE TABLE storage_instances (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug TEXT NOT NULL, name TEXT NOT NULL, preset TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (project_id, slug));
CREATE TABLE storage_buckets (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL REFERENCES storage_instances(id) ON DELETE CASCADE,
  name TEXT NOT NULL, region TEXT, public INTEGER NOT NULL DEFAULT 0,
  cors TEXT NOT NULL DEFAULT '{"mode":"permissive"}', config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, UNIQUE (instance_id, name));
CREATE TABLE storage_objects (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  bucket_id TEXT NOT NULL REFERENCES storage_buckets(id) ON DELETE CASCADE,
  key TEXT NOT NULL, size INTEGER NOT NULL, etag TEXT NOT NULL, md5 TEXT,
  content_type TEXT, headers TEXT NOT NULL DEFAULT '{}', metadata TEXT NOT NULL DEFAULT '{}',
  checksums TEXT NOT NULL DEFAULT '{}', parts INTEGER, acl TEXT, extra TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'api', run_id TEXT REFERENCES runs(id) ON DELETE CASCADE, log_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (bucket_id, key));
CREATE INDEX idx_storage_objects_run ON storage_objects(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX idx_storage_objects_project ON storage_objects(project_id);
CREATE TABLE storage_uploads (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  bucket_id TEXT NOT NULL REFERENCES storage_buckets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('s3-multipart','azure-blocks','gcs-resumable','cloudinary-chunked','supabase-signed')),
  key TEXT NOT NULL, content_type TEXT, headers TEXT NOT NULL DEFAULT '{}', metadata TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT '{}', run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE INDEX idx_storage_uploads_key ON storage_uploads(bucket_id, key);
CREATE TABLE storage_parts (
  upload_id TEXT NOT NULL REFERENCES storage_uploads(id) ON DELETE CASCADE,
  part_id TEXT NOT NULL, size INTEGER NOT NULL, etag TEXT NOT NULL, md5 TEXT NOT NULL,
  checksums TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, PRIMARY KEY (upload_id, part_id));
CREATE TABLE storage_rules (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL REFERENCES storage_instances(id) ON DELETE CASCADE,
  bucket_id TEXT REFERENCES storage_buckets(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  op TEXT NOT NULL DEFAULT 'any' CHECK (op IN ('any','put','get','head','delete','list','copy','multipart','bucket')),
  key_prefix TEXT, action TEXT NOT NULL, params TEXT NOT NULL DEFAULT '{}', position INTEGER NOT NULL DEFAULT 0,
  remaining_count INTEGER, skip_count INTEGER NOT NULL DEFAULT 0, fail_rate REAL, expires_at TEXT, label TEXT,
  hits INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
`,
  },
  {
    version: 12,
    sql: `
-- Content checks ("message lint"): findings per message and the highest severity (error > warn > info) for filtering.
ALTER TABLE messages ADD COLUMN lint TEXT NOT NULL DEFAULT '[]';
ALTER TABLE messages ADD COLUMN lint_level TEXT;
CREATE INDEX idx_messages_lint ON messages(project_id, lint_level) WHERE lint_level IS NOT NULL;
-- Webhook security suite: latest result per template.
CREATE TABLE webhook_security_checks (
  template_id TEXT PRIMARY KEY REFERENCES webhook_templates(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  result TEXT NOT NULL, created_at TEXT NOT NULL);
`,
  },
  {
    version: 13,
    sql: `
-- MCP tester: saved MCP server targets (Streamable HTTP / legacy HTTP+SSE) and saved tool calls (mini regression suite).
CREATE TABLE mcp_targets (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, url TEXT NOT NULL,
  transport TEXT NOT NULL DEFAULT 'auto' CHECK (transport IN ('auto','streamable','sse')),
  headers TEXT NOT NULL DEFAULT '{}', notes TEXT NOT NULL DEFAULT '',
  last_connected_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (project_id, name));
CREATE TABLE mcp_saved_calls (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES mcp_targets(id) ON DELETE CASCADE,
  name TEXT NOT NULL, tool TEXT NOT NULL, arguments TEXT NOT NULL DEFAULT '{}', expect TEXT NOT NULL DEFAULT '{}',
  position INTEGER NOT NULL DEFAULT 0, last_result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX idx_mcp_saved_calls_target ON mcp_saved_calls(target_id, position);
`,
  },
  {
    version: 14,
    sql: `
-- Scheduling v1: allowlisted dashboard API calls made later, once or on a fixed-rate repeat (fired via scheduled_jobs "schedule.fire").
CREATE TABLE schedules (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '', action TEXT NOT NULL,
  method TEXT NOT NULL, path TEXT NOT NULL, body TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paused','done','failed','cancelled','missed')),
  next_at TEXT, every_ms INTEGER, max_fires INTEGER NOT NULL DEFAULT 1,
  fired INTEGER NOT NULL DEFAULT 0, missed INTEGER NOT NULL DEFAULT 0, gen INTEGER NOT NULL DEFAULT 0, job_id TEXT,
  last_fired_at TEXT, last_status INTEGER, last_result TEXT, last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX idx_schedules_project ON schedules(project_id, status, next_at);
CREATE INDEX idx_schedules_run ON schedules(run_id) WHERE run_id IS NOT NULL;
`,
  },
  {
    version: 15,
    sql: `
-- AI chat v1: model providers (global; keys write-only), per-project agents, conversations, messages and saved prompts.
CREATE TABLE ai_providers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kind TEXT NOT NULL CHECK (kind IN ('openai','anthropic','google','openai-compatible')),
  preset TEXT CHECK (preset IN ('openrouter','ollama','custom')),
  base_url TEXT, api_key TEXT, headers TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE chat_agents (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug TEXT NOT NULL, name TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '', tools TEXT NOT NULL DEFAULT '{"builtin":true,"targets":[]}',
  max_steps INTEGER NOT NULL DEFAULT 10, max_output_tokens INTEGER, temperature REAL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (project_id, slug));
CREATE TABLE chat_conversations (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES chat_agents(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT '', tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX idx_chat_conversations_project ON chat_conversations(project_id, updated_at);
CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, role TEXT NOT NULL CHECK (role IN ('user','assistant','system')), parts TEXT NOT NULL DEFAULT '[]',
  provider TEXT, model TEXT, tokens_in INTEGER, tokens_out INTEGER, finish_reason TEXT, steps INTEGER, duration_ms INTEGER, error TEXT,
  created_at TEXT NOT NULL, UNIQUE (conversation_id, seq));
CREATE TABLE chat_prompts (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES chat_agents(id) ON DELETE CASCADE,
  name TEXT NOT NULL, prompt TEXT NOT NULL, expectations TEXT NOT NULL DEFAULT '{}',
  last_result TEXT, last_run_at TEXT, sort INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX idx_chat_prompts_agent ON chat_prompts(agent_id, sort);
`,
  },
  {
    version: 16,
    sql: `
-- Payments 1a: fake payment gateways (Stripe Checkout, PayTabs, PayPal Standard) under /pay/<project>/<instance>/….
CREATE TABLE payment_instances (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug TEXT NOT NULL, preset TEXT NOT NULL CHECK (preset IN ('stripe-checkout','paytabs','paypal')),
  name TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (project_id, slug));
CREATE TABLE payments (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL REFERENCES payment_instances(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE, test_user_id TEXT REFERENCES test_users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('checkout_session','hpp','order')),
  provider_ref TEXT NOT NULL, secondary_ref TEXT, status TEXT NOT NULL,
  amount INTEGER NOT NULL, currency TEXT NOT NULL, reference TEXT, customer_email TEXT,
  return_url TEXT, cancel_url TEXT, callback_url TEXT, refunded INTEGER NOT NULL DEFAULT 0,
  preset_outcome TEXT, outcome TEXT, outcome_via TEXT, method TEXT, card_brand TEXT, card_last4 TEXT,
  request TEXT NOT NULL DEFAULT '{}', provider_data TEXT NOT NULL DEFAULT '{}', idempotency_key TEXT,
  lint TEXT NOT NULL DEFAULT '[]', lint_level TEXT, log_id TEXT, expires_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX idx_payments_project ON payments(project_id, created_at);
CREATE INDEX idx_payments_ref ON payments(instance_id, provider_ref);
CREATE INDEX idx_payments_run ON payments(run_id) WHERE run_id IS NOT NULL;
CREATE TABLE payment_events (
  id TEXT PRIMARY KEY, payment_id TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
CREATE INDEX idx_payment_events_payment ON payment_events(payment_id, seq);
CREATE TABLE payment_refunds (
  id TEXT PRIMARY KEY, payment_id TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  provider_ref TEXT NOT NULL, amount INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE payment_rules (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  instance_id TEXT REFERENCES payment_instances(id) ON DELETE CASCADE,
  test_user_id TEXT REFERENCES test_users(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL, params TEXT NOT NULL DEFAULT '{}', remaining INTEGER, skip_count INTEGER NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0, expires_at TEXT, label TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE INDEX idx_payment_rules_project ON payment_rules(project_id);
`,
  },
  {
    version: 17,
    sql: `
-- LLM API mocks (/llm/<project>/<openai|anthropic>/…): scripted replies, fault rules, record-to-mock, call log.
CREATE TABLE llm_mocks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
  provider TEXT NOT NULL DEFAULT 'any', match TEXT NOT NULL DEFAULT '{}', responses TEXT NOT NULL DEFAULT '[]',
  mode TEXT NOT NULL DEFAULT 'first', fault TEXT, remaining INTEGER, hits INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual', recording_id TEXT, request_hash TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX idx_llm_mocks_project ON llm_mocks(project_id, position);
CREATE INDEX idx_llm_mocks_hash ON llm_mocks(project_id, request_hash);
CREATE TABLE llm_recordings (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  name TEXT NOT NULL DEFAULT '', provider_ref TEXT NOT NULL, kind TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'new',
  status TEXT NOT NULL DEFAULT 'active', calls INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, stopped_at TEXT);
CREATE INDEX idx_llm_recordings_project ON llm_recordings(project_id, status);
CREATE TABLE llm_calls (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL, log_id TEXT,
  provider TEXT NOT NULL, endpoint TEXT NOT NULL, model TEXT, stream INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL, mock_id TEXT, fault TEXT, status INTEGER, tokens_in INTEGER, tokens_out INTEGER, duration_ms INTEGER,
  request TEXT, response TEXT, created_at TEXT NOT NULL);
CREATE INDEX idx_llm_calls_project ON llm_calls(project_id, created_at);
CREATE INDEX idx_llm_calls_run ON llm_calls(run_id) WHERE run_id IS NOT NULL;
CREATE TABLE llm_settings (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, config TEXT NOT NULL DEFAULT '{}');
`,
  },
  {
    version: 18,
    // Rebuilds payment_instances (drops the preset CHECK of 16): run with foreign keys off so DROP TABLE does not cascade.
    foreignKeysOff: true,
    sql: `
-- Payments 1b: HyperPay COPYandPAY + PayPal Expanded. New gateways need no CHECK change any more; vault tokens.
CREATE TABLE payment_instances_new (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug TEXT NOT NULL, preset TEXT NOT NULL,
  name TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (project_id, slug));
INSERT INTO payment_instances_new (id, project_id, slug, preset, name, config, enabled, created_at, updated_at)
  SELECT id, project_id, slug, preset, name, config, enabled, created_at, updated_at FROM payment_instances;
DROP TABLE payment_instances;
ALTER TABLE payment_instances_new RENAME TO payment_instances;
CREATE TABLE payment_tokens (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL REFERENCES payment_instances(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, provider_ref TEXT NOT NULL, customer_id TEXT, status TEXT NOT NULL, source TEXT NOT NULL,
  card_brand TEXT, card_last4 TEXT, expiry TEXT, data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX idx_payment_tokens_ref ON payment_tokens(instance_id, provider_ref);
CREATE INDEX idx_payment_tokens_project ON payment_tokens(project_id, created_at);
`,
  },
  {
    version: 19,
    sql: `
-- LLM recordings stop by themselves: after max_calls forwarded requests or at expires_at.
ALTER TABLE llm_recordings ADD COLUMN max_calls INTEGER NOT NULL DEFAULT 200;
ALTER TABLE llm_recordings ADD COLUMN expires_at TEXT;
ALTER TABLE llm_recordings ADD COLUMN forwarded INTEGER NOT NULL DEFAULT 0;
ALTER TABLE llm_recordings ADD COLUMN stop_reason TEXT;
`,
  },
  {
    version: 20,
    sql: `
-- Scripted auto-replies: a fake test user answers by itself when the app messages them.
CREATE TABLE auto_reply_rules (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
  channel TEXT NOT NULL DEFAULT 'any', match TEXT NOT NULL DEFAULT '{}', reply TEXT NOT NULL DEFAULT '{}',
  delay_ms INTEGER NOT NULL DEFAULT 0, jitter_ms INTEGER NOT NULL DEFAULT 0, max_uses INTEGER, uses INTEGER NOT NULL DEFAULT 0,
  stop INTEGER NOT NULL DEFAULT 1, disabled_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX idx_auto_reply_rules_project ON auto_reply_rules(project_id, position);
CREATE TABLE auto_reply_fires (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL REFERENCES auto_reply_rules(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  trigger_message_id TEXT NOT NULL, test_user_id TEXT, job_id TEXT, status TEXT NOT NULL,
  due_at TEXT NOT NULL, fired_at TEXT, plan TEXT NOT NULL DEFAULT '{}', reply_message_id TEXT,
  webhook_status INTEGER, webhook_ok INTEGER, error TEXT, created_at TEXT NOT NULL,
  UNIQUE (rule_id, trigger_message_id));
CREATE INDEX idx_auto_reply_fires_project ON auto_reply_fires(project_id, created_at);
CREATE INDEX idx_auto_reply_fires_status ON auto_reply_fires(project_id, status);
`,
  },
  {
    version: 21,
    sql: `
-- AI chat extras: model matrix runs (one prompt across 2-6 models; newest 50 per project, not exported).
CREATE TABLE chat_matrix_runs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES chat_agents(id) ON DELETE SET NULL,
  prompt_id TEXT REFERENCES chat_prompts(id) ON DELETE SET NULL,
  name TEXT NOT NULL DEFAULT '', prompt TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL,
  columns TEXT NOT NULL DEFAULT '[]', tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, finished_at TEXT);
CREATE INDEX idx_chat_matrix_runs_project ON chat_matrix_runs(project_id, created_at);
`,
  },
  {
    version: 22,
    sql: `
-- Push notifications: fake FCM HTTP v1 and APNs (instances, devices, notifications, fault rules).
CREATE TABLE push_instances (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug TEXT NOT NULL, name TEXT NOT NULL, preset TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}',
  strict INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
  UNIQUE (project_id, slug));
CREATE TABLE push_devices (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  test_user_id TEXT REFERENCES test_users(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  instance_id TEXT, platform TEXT NOT NULL, token TEXT NOT NULL, app_id TEXT, name TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'active', unregistered_at TEXT, topics TEXT NOT NULL DEFAULT '[]', badge INTEGER,
  auto INTEGER NOT NULL DEFAULT 0, last_push_at TEXT, created_at TEXT NOT NULL,
  UNIQUE (project_id, token));
CREATE INDEX idx_push_devices_user ON push_devices(project_id, test_user_id);
CREATE TABLE push_notifications (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  instance_id TEXT, device_id TEXT REFERENCES push_devices(id) ON DELETE SET NULL, test_user_id TEXT,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL, log_id TEXT, group_id TEXT,
  provider TEXT NOT NULL, target_kind TEXT NOT NULL, target TEXT NOT NULL DEFAULT '',
  title TEXT, body TEXT, image TEXT, data TEXT NOT NULL DEFAULT '{}', badge INTEGER, sound TEXT, category TEXT, thread_id TEXT,
  collapse_key TEXT, priority TEXT, push_type TEXT, silent INTEGER NOT NULL DEFAULT 0, expires_at TEXT,
  status TEXT NOT NULL, error_code TEXT, provider_message_id TEXT, headers TEXT NOT NULL DEFAULT '{}', raw TEXT, lint TEXT NOT NULL DEFAULT '[]',
  opened_at TEXT, created_at TEXT NOT NULL);
CREATE INDEX idx_push_notifications_project ON push_notifications(project_id, created_at);
CREATE INDEX idx_push_notifications_device ON push_notifications(device_id, created_at);
CREATE INDEX idx_push_notifications_run ON push_notifications(run_id) WHERE run_id IS NOT NULL;
CREATE TABLE push_rules (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE, instance_id TEXT,
  match TEXT NOT NULL DEFAULT '{}', fault TEXT NOT NULL, remaining INTEGER, hits INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE INDEX idx_push_rules_project ON push_rules(project_id, created_at);
`,
  },
  {
    version: 23,
    sql: `
-- AI personas: test users whose replies an LLM writes in character (threads = one conversation per user, channel, run).
CREATE TABLE personas (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  slug TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  provider TEXT NOT NULL, model TEXT NOT NULL, prompt TEXT NOT NULL DEFAULT '',
  goals TEXT NOT NULL DEFAULT '[]', style TEXT NOT NULL DEFAULT '{}', limits TEXT NOT NULL DEFAULT '{}',
  fallback TEXT, opener TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (project_id, slug));
CREATE INDEX idx_personas_project ON personas(project_id);
CREATE TABLE persona_threads (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  test_user_id TEXT NOT NULL REFERENCES test_users(id) ON DELETE CASCADE, channel TEXT NOT NULL,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'active', stop_reason TEXT, replies INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0,
  fallback_sent INTEGER NOT NULL DEFAULT 0, goals TEXT NOT NULL DEFAULT '{}', notes TEXT NOT NULL DEFAULT '',
  last_turn_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
-- NULL run_ids are distinct in a plain UNIQUE constraint, so the key uses COALESCE.
CREATE UNIQUE INDEX idx_persona_threads_key ON persona_threads(persona_id, test_user_id, channel, COALESCE(run_id, ''));
CREATE INDEX idx_persona_threads_project ON persona_threads(project_id, updated_at);
CREATE TABLE persona_turns (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  thread_id TEXT REFERENCES persona_threads(id) ON DELETE CASCADE,
  fire_id TEXT, trigger_message_id TEXT, reply_message_id TEXT,
  status TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', raw TEXT, controls TEXT, warnings TEXT NOT NULL DEFAULT '[]',
  provider TEXT, model TEXT, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0, finish_reason TEXT, error TEXT, called INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL);
CREATE INDEX idx_persona_turns_thread ON persona_turns(thread_id, created_at);
CREATE INDEX idx_persona_turns_project ON persona_turns(project_id, created_at);
-- dailyCalls counter (turns are pruned to the newest 500 per project, so they cannot carry the count).
CREATE TABLE persona_daily (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, day TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, day));
`,
  },
  {
    version: 24,
    sql: `
-- Storyboards: per-project manual walkthroughs (steps), data sets for form filling, login recipes per role,
-- page snapshots (scanned form fields), walkthroughs (one human run through a storyboard) and their screenshots.
CREATE TABLE login_recipes (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', login_url TEXT NOT NULL,
  fields TEXT NOT NULL DEFAULT '{}', two_factor TEXT NOT NULL DEFAULT '{"kind":"none"}',
  logout_url TEXT, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (project_id, role));
CREATE TABLE data_sets (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  match TEXT NOT NULL DEFAULT '{}', entries TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (project_id, slug));
CREATE TABLE storyboards (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', intent TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]', inputs TEXT NOT NULL DEFAULT '[]', actors TEXT NOT NULL DEFAULT '[]',
  steps TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 1, content_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (project_id, slug));
CREATE TABLE page_snapshots (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'extension', url TEXT NOT NULL, url_pattern TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '', form_id TEXT, fields TEXT NOT NULL DEFAULT '[]', note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL);
CREATE INDEX idx_page_snapshots_project ON page_snapshots(project_id, created_at);
CREATE TABLE walkthroughs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  storyboard_id TEXT REFERENCES storyboards(id) ON DELETE SET NULL,
  key TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', executor TEXT NOT NULL DEFAULT 'human',
  status TEXT NOT NULL DEFAULT 'active', origin TEXT NOT NULL DEFAULT '',
  snapshot TEXT NOT NULL, actors TEXT NOT NULL DEFAULT '{}', vars TEXT NOT NULL DEFAULT '{}',
  current_step_id TEXT, verdict TEXT, signed_off_by TEXT, signed_off_at TEXT, summary_note TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL, finished_at TEXT, updated_at TEXT NOT NULL,
  UNIQUE (project_id, key));
CREATE INDEX idx_walkthroughs_project ON walkthroughs(project_id, updated_at);
CREATE INDEX idx_walkthroughs_storyboard ON walkthroughs(storyboard_id);
CREATE TABLE walkthrough_steps (
  walkthrough_id TEXT NOT NULL REFERENCES walkthroughs(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL, position INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  note TEXT NOT NULL DEFAULT '', data TEXT NOT NULL DEFAULT '{}', started_at TEXT, finished_at TEXT,
  PRIMARY KEY (walkthrough_id, step_id));
CREATE TABLE walkthrough_shots (
  id TEXT PRIMARY KEY, walkthrough_id TEXT NOT NULL REFERENCES walkthroughs(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, data BLOB NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX idx_walkthrough_shots_wt ON walkthrough_shots(walkthrough_id, step_id);
`,
  },
  {
    version: 25,
    sql: `
-- Storyboards: "quick test" runs. A walkthrough runs tracked (per-step verdicts, notes, screenshots, sign-off; kept in
-- history) or quick (same steps, no evidence, hidden from history, deleted 24 h after its last change).
-- preferred_mode is a hint for the extension: which start button it shows first.
ALTER TABLE walkthroughs ADD COLUMN mode TEXT NOT NULL DEFAULT 'tracked';
ALTER TABLE storyboards ADD COLUMN preferred_mode TEXT NOT NULL DEFAULT 'tracked';
`,
  },
];
