import type { FastifyInstance } from 'fastify';
import type { Hub } from '../../hub.js';
import { AUTH_MCP_TOOLS } from '../../auth/mcp-tools.js';
import { STORAGE_MCP_TOOLS } from '../../storage/mcp-tools.js';
import { MCP_TESTER_MCP_TOOLS } from '../../mcptester/mcp-tools.js';
import { TIME_MCP_TOOLS } from '../../clock/mcp-tools.js';
import { SCHEDULE_MCP_TOOLS } from '../../schedules/mcp-tools.js';
import { CHAT_MCP_TOOLS } from '../../chat/mcp-tools.js';
import { PAYMENT_MCP_TOOLS } from '../../payments/mcp-tools.js';
import { PAYPAL_EXTRAS_MCP_TOOLS } from '../../payments/paypal/mcp-tools.js';
import { LLM_MCP_TOOLS } from '../../llmmocks/mcp-tools.js';
import { AUTO_REPLY_MCP_TOOLS } from '../../autoreplies/mcp-tools.js';
import { PERSONA_MCP_TOOLS } from '../../personas/mcp-tools.js';
import { PUSH_MCP_TOOLS } from '../../push/mcp-tools.js';
import { STORYBOARD_MCP_TOOLS } from '../../storyboards/mcp-tools.js';

/**
 * MCP server (Model Context Protocol, Streamable HTTP transport, JSON responses) at /mcp.
 * Lets AI agents use stubyard as tools:  claude mcp add --transport http stubyard http://localhost:4000/mcp
 * Tools call stubyard's own REST API internally, so behaviour and validation are identical.
 */

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

type Json = Record<string, unknown>;
interface Tool {
  name: string;
  description: string;
  inputSchema: Json;
  annotations?: Json;
  /** Returns [method, path, body?]. */
  call?: (a: Json) => [string, string, unknown?];
  /** Tools that combine several API calls. `api` throws on HTTP errors. */
  run?: (a: Json, ctx: RunCtx) => Promise<unknown>;
}

interface RunCtx {
  api: (method: string, url: string, body?: unknown) => Promise<any>;
  hub: Hub;
}

const s = (description: string, extra: Json = {}) => ({ type: 'string', description, ...extra });
const n = (description: string) => ({ type: 'number', description });
const enc = encodeURIComponent;
const q = (o: Json) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const str = p.toString();
  return str ? `?${str}` : '';
};
const obj = (properties: Json, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

const PROJECT = s('stubyard project slug, e.g. "hyper" (see list_projects)');
const USER = s('Test user: id, email, phone, name or role (e.g. "admin", "sales", "customer3@hyper.test")');
const CHANNEL = s('Channel', { enum: ['email', 'sms', 'whatsapp'] });
const RUN = s('Test run key or id (see start_run): scope the call to that run (its users, rules and messages)');

const TOOLS: Tool[] = [
  {
    name: 'list_projects',
    description: 'List stubyard projects (one per app under test) with counts.',
    inputSchema: obj({}),
    annotations: { readOnlyHint: true },
    call: () => ['GET', '/api/projects'],
  },
  {
    name: 'list_test_users',
    description: 'Test users of a project with role, email, phone, test password, unread counts and latest code. Use these addresses in test data.',
    inputSchema: obj({ project: PROJECT }, ['project']),
    annotations: { readOnlyHint: true },
    call: (a) => ['GET', `/api/projects/${enc(String(a.project))}/users`],
  },
  {
    name: 'get_latest_code',
    description: 'Latest OTP / verification code a test user received (email, SMS or WhatsApp), plus the first link in that message.',
    inputSchema: obj({ project: PROJECT, user: USER, channel: CHANNEL, run: RUN }, ['project', 'user']),
    annotations: { readOnlyHint: true },
    call: (a) => ['GET', `/api/projects/${enc(String(a.project))}/users/${enc(String(a.user))}/latest${q({ otp: 1, channel: a.channel, run: a.run })}`],
  },
  {
    name: 'wait_for_message',
    description:
      'Wait until a test user receives a message (optionally only one with a code) and return it, including otp, links and a `cursor`. ' +
      'Robust pattern (no stale code after "resend"): call with get_cursor_only=true BEFORE triggering the action, then wait with after=<cursor>. ' +
      'Without `after`, messages from the last 10 s also count. count / exactly wait for several messages (exactly fails if more arrive); ' +
      'expect_no_message asserts that nothing matching arrives within within_seconds (fails with the offending messages).',
    inputSchema: obj(
      {
        project: PROJECT,
        user: USER,
        to: s('Recipient address instead of a user (email or phone)'),
        channel: CHANNEL,
        code_only: { type: 'boolean', description: 'Only messages with a detected OTP code' },
        after: s('Cursor (or message id): only messages newer than it. Take it from get_cursor_only or a previous result'),
        after_message_id: s('Deprecated alias of `after`'),
        timeout_seconds: n('Max wait, default 30, max 120'),
        get_cursor_only: { type: 'boolean', description: 'Do not wait: return the current cursor for these filters (call before triggering the action)' },
        count: n('Wait until at least this many matching messages arrived; returns { count, messages, cursor }'),
        exactly: n('Wait until exactly this many arrived and no more within 2 s; fails when more arrive'),
        expect_no_message: { type: 'boolean', description: 'Negative assertion: succeed only if no matching message arrives within within_seconds' },
        within_seconds: n('For expect_no_message: how long to watch, default 5, max 120'),
        run: RUN,
      },
      ['project'],
    ),
    annotations: { readOnlyHint: true },
    call: (a) => {
      const base = `/api/projects/${enc(String(a.project))}/messages`;
      const filters = { user: a.user, to: a.to, channel: a.channel, otp: a.code_only ? 1 : undefined, run: a.run };
      const after = a.after ?? a.after_message_id;
      if (a.get_cursor_only) return ['GET', `${base}/cursor${q(filters)}`];
      if (a.expect_no_message) return ['GET', `${base}/expect-none${q({ ...filters, after, within: a.within_seconds ?? 5 })}`];
      return ['GET', `${base}/wait${q({ ...filters, after, count: a.count, exactly: a.exactly, timeout: a.timeout_seconds ?? 30 })}`];
    },
  },
  {
    name: 'get_messages',
    description:
      'Messages (newest first) for a project or one test user: status, applied scenario rule, otp, links, provider, and `lint` (content-check findings: ' +
      'unrendered placeholders, undefined/null, localhost links, missing List-Unsubscribe, SMS encoding…). lint="error"|"warn" returns only messages with such findings.',
    inputSchema: obj(
      { project: PROJECT, user: USER, channel: CHANNEL, search: s('Text search'), limit: n('Default 20'), run: RUN, lint: s('Only messages with content findings of at least this severity', { enum: ['error', 'warn', 'info'] }) },
      ['project'],
    ),
    annotations: { readOnlyHint: true },
    call: (a) => ['GET', `/api/projects/${enc(String(a.project))}/messages${q({ user: a.user, channel: a.channel, q: a.search, limit: a.limit ?? 20, run: a.run, lint: a.lint })}`],
  },
  {
    name: 'lint_report',
    description:
      'Content checks ("message lint") of captured outbound messages: counts per severity, per check and per test user, plus the newest messages with ' +
      'their findings (unrendered {{placeholders}}, undefined / NaN / [object Object], links to localhost or production, http links, missing ' +
      'List-Unsubscribe on marketing mail, missing text part, SMS UCS-2 caused by a curly quote, empty WhatsApp template parameters…). ' +
      'Pass `text`/`html`/`subject` (with `channel`) instead to check content without sending it.',
    inputSchema: obj(
      {
        project: PROJECT,
        user: USER,
        run: RUN,
        since: s('ISO timestamp: only messages since then'),
        limit: n('Recent messages with findings to include, default 20'),
        channel: CHANNEL,
        subject: s('Ad-hoc check: email subject'),
        text: s('Ad-hoc check: text / SMS body'),
        html: s('Ad-hoc check: email HTML'),
      },
      ['project'],
    ),
    annotations: { readOnlyHint: true },
    run: async (a, { api }) => {
      if (a.text !== undefined || a.html !== undefined || a.subject !== undefined) {
        return api('POST', `/api/lint/check${q({ project: a.project })}`, { channel: a.channel ?? 'email', subject: a.subject, text: a.text, html: a.html });
      }
      return api('GET', `/api/projects/${enc(String(a.project))}/lint${q({ user: a.user, run: a.run, since: a.since, limit: a.limit ?? 20 })}`);
    },
  },
  {
    name: 'get_2fa_code',
    description: 'Current authenticator-app (TOTP) code for a key, by label or by linked test user. Includes seconds remaining.',
    inputSchema: obj({ project: PROJECT, label: s('Key label, e.g. "Admin 2FA"'), user: USER, run: RUN }, ['project']),
    annotations: { readOnlyHint: true },
    call: (a) => ['GET', `/api/projects/${enc(String(a.project))}/authenticators/code${q({ label: a.label, user: a.user, run: a.run })}`],
  },
  {
    name: 'set_user_scenario',
    description:
      'Add a scenario rule for a test user, e.g. "next SMS fails", "emails bounce", "blocked for 10 minutes". Rules apply in order, first match wins; ' +
      'count/minutes make it temporary. Actions: deliver, fail, reject, rate_limit, delay, timeout, drop, blocked, fail_rate, bounce_hard, bounce_soft, defer, complaint, bounce_delayed.',
    inputSchema: obj(
      {
        project: PROJECT,
        user: USER,
        action: s('Rule action'),
        channel: s('Channel', { enum: ['all', 'email', 'sms', 'whatsapp'] }),
        count: n('Only the next N messages'),
        minutes: n('Only for X minutes'),
        after: n('Start after N messages went through normally'),
        error_code: s('Provider error code (default: the provider’s usual one)'),
        error_message: s('Error message'),
        delay_ms: n('For delay / bounce_delayed'),
        fail_rate: n('Percent, for fail_rate'),
        instance: s('Only via this provider instance slug'),
        run: RUN,
      },
      ['project', 'user', 'action'],
    ),
    call: (a) => [
      'POST',
      `/api/projects/${enc(String(a.project))}/users/${enc(String(a.user))}/rules${q({ run: a.run })}`,
      { action: a.action, channel: a.channel, count: a.count, minutes: a.minutes, after: a.after, errorCode: a.error_code, errorMessage: a.error_message, delayMs: a.delay_ms, failRate: a.fail_rate, instance: a.instance },
    ],
  },
  {
    name: 'reset_user_scenario',
    description: 'Remove all scenario rules of a test user (back to normal delivery).',
    inputSchema: obj({ project: PROJECT, user: USER }, ['project', 'user']),
    annotations: { destructiveHint: false, idempotentHint: true },
    call: (a) => ['DELETE', `/api/projects/${enc(String(a.project))}/users/${enc(String(a.user))}/rules`],
  },
  {
    name: 'set_provider_rule',
    description: 'Add a rule for everyone on a provider instance, e.g. action "down" for 10 minutes to test fallback. Actions: down, slow, rate_limit, timeout, fail_rate, reject, fail, drop.',
    inputSchema: obj(
      {
        project: PROJECT,
        instance: s('Provider instance slug, e.g. "sms-primary"'),
        action: s('Rule action'),
        count: n('Next N calls'),
        minutes: n('For X minutes'),
        delay_ms: n('For slow'),
        fail_rate: n('Percent'),
        run: s('Test run key or id: the rule only applies to messages of that run'),
      },
      ['project', 'instance', 'action'],
    ),
    call: (a) => [
      'POST',
      `/api/projects/${enc(String(a.project))}/providers/${enc(String(a.instance))}/rules${q({ run: a.run })}`,
      { action: a.action, count: a.count, minutes: a.minutes, delayMs: a.delay_ms, failRate: a.fail_rate },
    ],
  },
  {
    name: 'reset_provider_rules',
    description: 'Remove all rules of a provider instance (back to healthy).',
    inputSchema: obj({ project: PROJECT, instance: s('Provider instance slug') }, ['project', 'instance']),
    annotations: { idempotentHint: true },
    call: (a) => ['DELETE', `/api/projects/${enc(String(a.project))}/providers/${enc(String(a.instance))}/rules`],
  },
  {
    name: 'reply_as_user',
    description:
      'Simulate a test user replying by SMS, WhatsApp or email: stubyard sends the provider’s inbound webhook to the app (Twilio/Vonage/Meta inbound; email: SendGrid Inbound Parse, Mailgun route, SES receipt or JSON to the email instance’s inboundUrl). WhatsApp: "button" taps a button / list row of the last interactive message.',
    inputSchema: obj(
      {
        project: PROJECT,
        user: USER,
        channel: s('Channel', { enum: ['sms', 'whatsapp', 'email'] }),
        text: s('Reply text, e.g. "STOP" (email: the body)'),
        instance: s('Provider instance slug (default: the channel default)'),
        button: s('WhatsApp: id or title of a button / list row of the last interactive message'),
        subject: s('Email: subject (default "Re: <original subject>")'),
        in_reply_to: s('Email: stubyard message id being answered (threads with In-Reply-To / References)'),
      },
      ['project', 'user'],
    ),
    call: (a) => [
      'POST',
      `/api/projects/${enc(String(a.project))}/users/${enc(String(a.user))}/reply`,
      { channel: a.channel ?? 'sms', text: a.text ?? '', instance: a.instance, button: a.button, subject: a.subject, inReplyTo: a.in_reply_to },
    ],
  },
  {
    name: 'get_traffic',
    description: 'Recent requests stubyard received or sent for a project (API calls, SMTP sessions, callbacks), including errors and 404s. Use to debug "nothing arrived".',
    inputSchema: obj(
      { project: PROJECT, outcome: s('ok, unmatched, invalid, rejected, forced_error, internal_error, network_error'), search: s('Text search'), limit: n('Default 20'), run: RUN },
      ['project'],
    ),
    annotations: { readOnlyHint: true },
    call: (a) => ['GET', `/api/logs${q({ project: a.project, outcome: a.outcome, q: a.search, limit: a.limit ?? 20, run: a.run })}`],
  },
  {
    name: 'get_request',
    description: 'Full details of one logged request (headers, bodies, SMTP transcript) by its X-Hub-Request-Id.',
    inputSchema: obj({ id: s('Request / log id') }, ['id']),
    annotations: { readOnlyHint: true },
    call: (a) => ['GET', `/api/logs/${enc(String(a.id))}`],
  },
  {
    name: 'clear_inbox',
    description: 'Delete all messages of one test user (keeps the user and their rules).',
    inputSchema: obj({ project: PROJECT, user: USER }, ['project', 'user']),
    annotations: { destructiveHint: true },
    call: (a) => ['POST', `/api/projects/${enc(String(a.project))}/users/${enc(String(a.user))}/clear`],
  },
  {
    name: 'reset_project_data',
    description: 'Delete ALL messages and traffic logs of a project before a test run. Keeps users, providers, rules and settings. Ask the user first unless they asked for a clean run.',
    inputSchema: obj({ project: PROJECT }, ['project']),
    annotations: { destructiveHint: true },
    call: (a) => ['POST', `/api/projects/${enc(String(a.project))}/reset`],
  },

  // ---------- Test runs (parallel workers) ----------
  {
    name: 'start_run',
    description:
      'Start a test run for one test worker: its own ephemeral test users, rules and mock scenarios, and everything addressed to its users is attributed to it. ' +
      'Returns the run with `users` (with passwords), `urls.mockPrefix` / `urls.hookPrefix` (/run/<key>/mock/<project>…), `urls.smtpUsername` (project+key) and the X-Hub-Run header. ' +
      'Pass `run` (the key) to wait_for_message, get_messages, set_user_scenario… to stay inside the run. replace=true restarts a crashed worker’s run.',
    inputSchema: obj(
      {
        project: PROJECT,
        key: s('Run key, 1-24 lowercase letters/digits, e.g. "w3" (default: random)'),
        label: s('Label shown in the dashboard'),
        ttl_minutes: n('Stop automatically after this many minutes, default 120, max 1440'),
        users: { type: 'array', description: 'Users to mint, e.g. [{"role":"customer","count":2}]', items: obj({ role: s('Role'), count: n('How many'), name: s('Name') }, ['role']) },
        capture_unattributed: { type: 'boolean', description: 'Serial CI: messages / requests no other run claims belong to this run' },
        claims: { type: 'array', items: { type: 'string' }, description: 'Extra strings that attribute API-mock / webhook calls to this run (e.g. an order id prefix)' },
        replace: { type: 'boolean', description: 'Stop and purge an active run with the same key first' },
      },
      ['project'],
    ),
    call: (a) => [
      'POST',
      `/api/projects/${enc(String(a.project))}/runs`,
      { key: a.key, label: a.label, ttlMinutes: a.ttl_minutes, users: a.users, captureUnattributed: a.capture_unattributed, claims: a.claims, replace: a.replace },
    ],
  },
  {
    name: 'mint_test_user',
    description: 'Create ephemeral test users inside a run (addresses like customer1.w3@<project>.test, phone <prefix>9xxxxxx). They are deleted with the run.',
    inputSchema: obj(
      { project: PROJECT, run: s('Run key or id'), role: s('Role, default "user"'), name: s('Display name'), count: n('How many, default 1'), email: { type: 'boolean', description: 'Give an email address (default true)' }, phone: { type: 'boolean', description: 'Give a phone number (default true)' } },
      ['project', 'run'],
    ),
    call: (a) => ['POST', `/api/projects/${enc(String(a.project))}/runs/${enc(String(a.run))}/users`, { role: a.role, name: a.name, count: a.count, email: a.email, phone: a.phone }],
  },
  {
    name: 'stop_run',
    description: 'Stop a test run: freezes and returns its report and removes its rules and mock overrides. purge=true also deletes its users, messages, emails and logs.',
    inputSchema: obj({ project: PROJECT, run: s('Run key or id'), purge: { type: 'boolean', description: 'Also delete the run’s data' } }, ['project', 'run']),
    call: (a) => ['POST', `/api/projects/${enc(String(a.project))}/runs/${enc(String(a.run))}/stop${q({ purge: a.purge ? 1 : undefined })}`],
  },
  {
    name: 'get_run_report',
    description: 'Report of a test run: its users, messages (by channel / status, codes, applied rules), traffic with problems (404s, invalid requests, errors), rules, mock overrides and warnings.',
    inputSchema: obj({ project: PROJECT, run: s('Run key or id') }, ['project', 'run']),
    annotations: { readOnlyHint: true },
    call: (a) => ['GET', `/api/projects/${enc(String(a.project))}/runs/${enc(String(a.run))}/report`],
  },

  // ---------- Diagnostics ----------
  {
    name: 'doctor',
    description:
      'Check from inside stubyard that every URL it will call for a project (status callbacks, inbound URLs, email event webhooks, webhook templates) ' +
      'resolves, accepts a TCP connection and answers HTTP, whether the outbound allowlist blocks it, that Mailpit is up and the HTTPS names. ' +
      'Each failure has a hint, e.g. "ECONNREFUSED to host.docker.internal:3000: is your app listening on 0.0.0.0?". Run it when callbacks never arrive.',
    inputSchema: obj({ project: PROJECT }, ['project']),
    annotations: { readOnlyHint: true },
    call: (a) => ['GET', `/api/projects/${enc(String(a.project))}/doctor`],
  },

  // ---------- Webhooks ----------
  {
    name: 'list_webhooks',
    description:
      'Webhook setup of a project: receiving endpoints (/hook/<project>/<path>) with their most recent hits (schema check result, status), ' +
      'sending templates and sequences. Use the template / sequence names with send_webhook / run_webhook_sequence.',
    inputSchema: obj({ project: PROJECT, hits: n('Recent hits per endpoint, default 5 (0 = none)') }, ['project']),
    annotations: { readOnlyHint: true },
    run: async (a, { api }) => {
      const base = `/api/projects/${enc(String(a.project))}`;
      const hitCount = a.hits === undefined ? 5 : Math.max(0, Math.min(50, Number(a.hits) || 0));
      const [endpoints, templates, sequences] = await Promise.all([api('GET', `${base}/webhook-endpoints`), api('GET', `${base}/webhook-templates`), api('GET', `${base}/webhook-sequences`)]);
      const withHits = await Promise.all(
        (endpoints as Json[]).map(async (e) => ({
          ...e,
          url: `/hook/${String(a.project)}/${String(e.path ?? '').replace(/^\//, '')}`,
          ...(hitCount ? { recentHits: await api('GET', `${base}/webhook-endpoints/${enc(String(e.id))}/hits?limit=${hitCount}`) } : {}),
        })),
      );
      return { endpoints: withHits, templates, sequences };
    },
  },
  {
    name: 'send_webhook',
    description: 'Send a webhook template to the app now (rendered, signed), optionally as a test user and with extra template data. Returns the app’s response and the log id.',
    inputSchema: obj(
      { project: PROJECT, template: s('Template name or id (see list_webhooks)'), as_user: USER, data: { type: 'object', description: 'Values for {{data.*}} placeholders' } },
      ['project', 'template'],
    ),
    call: (a) => ['POST', `/api/projects/${enc(String(a.project))}/webhook-templates/${enc(String(a.template))}/send`, { asUser: a.as_user, data: a.data ?? {} }],
  },
  {
    name: 'run_webhook_sequence',
    description: 'Start a webhook sequence (several templates with delays, e.g. payment pending → succeeded). Returns the run plan; results via get_traffic.',
    inputSchema: obj({ project: PROJECT, sequence: s('Sequence name or id'), as_user: USER, data: { type: 'object', description: 'Values for {{data.*}} placeholders' } }, ['project', 'sequence']),
    call: (a) => ['POST', `/api/projects/${enc(String(a.project))}/webhook-sequences/${enc(String(a.sequence))}/run`, { asUser: a.as_user, data: a.data ?? {} }],
  },

  {
    name: 'webhook_security_check',
    description:
      'Security check of the app’s webhook handler for one template: sends a valid baseline, then bad signature, wrong secret, missing signature, ' +
      'body changed after signing, stale / future timestamps (Stripe, HMAC+timestamp), an exact replay, out-of-order events (if the template is in a ' +
      'sequence), a 1 MB body, malformed JSON and a wrong content-type. Reports per variant: expected, HTTP status, verdict ' +
      '(pass / fail = accepted although it should be rejected / warn = 5xx / info) and the traffic-log id. Takes a few seconds.',
    inputSchema: obj(
      { project: PROJECT, template: s('Template name or id (see list_webhooks)'), as_user: USER, data: { type: 'object', description: 'Values for {{data.*}} placeholders' } },
      ['project', 'template'],
    ),
    call: (a) => ['POST', `/api/projects/${enc(String(a.project))}/webhook-templates/${enc(String(a.template))}/security-check`, { asUser: a.as_user, data: a.data ?? {} }],
  },

  // ---------- API mocks ----------
  {
    name: 'list_api_mocks',
    description: 'API mocks of a project (/mock/<project>/api/...): routes, scenarios and the active scenario.',
    inputSchema: obj({ project: PROJECT }, ['project']),
    annotations: { readOnlyHint: true },
    call: (a) => ['GET', `/api/projects/${enc(String(a.project))}/mocks`],
  },
  {
    name: 'set_mock_scenario',
    description: 'Switch the active scenario of an API mock (e.g. "Card declined"); every request gets it from now on. Use the default scenario name to go back.',
    inputSchema: obj({ project: PROJECT, mock: s('Mock name or id'), scenario: s('Scenario name'), run: s('Test run key or id: only that run’s requests get the scenario') }, ['project', 'mock', 'scenario']),
    call: (a) => ['PATCH', `/api/projects/${enc(String(a.project))}/mocks/${enc(String(a.mock))}/active-scenario${q({ run: a.run })}`, { scenario: a.scenario }],
  },

  // ---------- Providers ----------
  {
    name: 'list_providers',
    description:
      'Provider instances of a project (SMTP, Twilio, Vonage, WhatsApp, SendGrid, Mailgun, SES, Generic) with their config and the base URLs to put in the app ' +
      '(from this machine and from containers on the stubyard network).',
    inputSchema: obj({ project: PROJECT }, ['project']),
    annotations: { readOnlyHint: true },
    run: async (a, { api, hub }) => {
      const slug = String(a.project);
      const list = (await api('GET', `/api/projects/${enc(slug)}/providers`)) as Json[];
      const c = hub.config;
      return {
        providers: list.map((p) => {
          const path = `/mock/${slug}/${String(p.slug)}`;
          const urls =
            p.preset === 'smtp'
              ? { smtp: `localhost:${c.smtpPort}`, smtpFromContainers: `stubyard:${c.smtpPort}`, smtpUsername: `${slug}.${String(p.slug)}` }
              : { https: `https://localhost:${c.httpsPort}${path}`, http: `http://localhost:${c.httpPort}${path}`, fromContainers: `https://stubyard:${c.httpsPort}${path}` };
          return { ...p, urls };
        }),
      };
    },
  },
  {
    name: 'set_provider_config',
    description:
      'Change a provider instance: config keys are merged (e.g. {"statusCallbackUrl":"http://host.docker.internal:3000/sms/status"}, ' +
      '{"inboundUrl":…}, {"eventWebhookUrl":…}), plus enabled / is_default / name. Run doctor afterwards to check the URLs are reachable.',
    inputSchema: obj(
      {
        project: PROJECT,
        instance: s('Provider instance slug'),
        config: { type: 'object', description: 'Config keys to set (merged into the current config)' },
        enabled: { type: 'boolean', description: 'Enable / disable the instance' },
        is_default: { type: 'boolean', description: 'Make it the default for its channel' },
        name: s('Display name'),
      },
      ['project', 'instance'],
    ),
    call: (a) => [
      'PATCH',
      `/api/projects/${enc(String(a.project))}/providers/${enc(String(a.instance))}`,
      { config: a.config, enabled: a.enabled, isDefault: a.is_default, name: a.name },
    ],
  },

  // ---------- Project setup ----------
  {
    name: 'create_project',
    description:
      'Create a stubyard project for an app (with an SMTP email instance) and generate test users, e.g. roles [{"role":"admin","count":1},{"role":"customer","count":9}]. ' +
      'Returns the project and its test users.',
    inputSchema: obj(
      {
        name: s('Project name, e.g. "Hyper"'),
        slug: s('URL slug (default: from the name)'),
        description: s('Description'),
        roles: { type: 'array', description: 'Test users to generate per role', items: obj({ role: s('Role name'), count: n('How many') }, ['role', 'count']) },
        admins: n('Shortcut: number of admin users'),
        customers: n('Shortcut: number of customer users'),
      },
      ['name'],
    ),
    run: async (a, { api }) => {
      const gen = a.roles || a.admins || a.customers ? { roles: a.roles, admins: a.admins, customers: a.customers } : undefined;
      const project = (await api('POST', '/api/projects', { name: a.name, slug: a.slug, description: a.description, generateUsers: gen })) as Json;
      const users = await api('GET', `/api/projects/${enc(String(project.slug))}/users`);
      return { project, users };
    },
  },
  {
    name: 'generate_users',
    description: 'Add generated test users to a project, e.g. roles [{"role":"sales","count":3}] (addresses like sales1@<project>.test).',
    inputSchema: obj(
      {
        project: PROJECT,
        roles: { type: 'array', description: 'Users per role', items: obj({ role: s('Role name'), count: n('How many') }, ['role', 'count']) },
        admins: n('Number of admin users'),
        customers: n('Number of customer users'),
      },
      ['project'],
    ),
    call: (a) => ['POST', `/api/projects/${enc(String(a.project))}/users/generate`, { roles: a.roles, admins: a.admins, customers: a.customers }],
  },
  {
    name: 'export_project',
    description: 'Export a project’s configuration (users, providers, rules, webhooks, mocks…) as stubyard JSON, e.g. to commit it as a STUBYARD_SEED file for CI.',
    inputSchema: obj({ project: PROJECT, include_secrets: { type: 'boolean', description: 'Include authenticator (TOTP) secrets' } }, ['project']),
    annotations: { readOnlyHint: true },
    call: (a) => ['GET', `/api/projects/${enc(String(a.project))}/export${q({ secrets: a.include_secrets ? 1 : undefined })}`],
  },
  // Login providers (fake OAuth / OIDC), see auth/mcp-tools.ts
  ...AUTH_MCP_TOOLS,
  // File storage simulator, see storage/mcp-tools.ts
  ...STORAGE_MCP_TOOLS,
  // MCP tester: test the agent's own MCP server through stubyard, see mcptester/mcp-tools.ts
  ...MCP_TESTER_MCP_TOOLS,
  // Scheduled actions (send later / repeat), see schedules/mcp-tools.ts
  ...SCHEDULE_MCP_TOOLS,
  ...PAYMENT_MCP_TOOLS,
  ...PAYPAL_EXTRAS_MCP_TOOLS,
  // LLM API mocks (scripted OpenAI / Anthropic replies, faults, record-to-mock), see llmmocks/mcp-tools.ts
  ...LLM_MCP_TOOLS,
  // Scripted auto-replies (test users answer by themselves), see autoreplies/mcp-tools.ts
  ...AUTO_REPLY_MCP_TOOLS,
  // AI personas (LLM-written replies of test users), see personas/mcp-tools.ts
  ...PERSONA_MCP_TOOLS,
  ...PUSH_MCP_TOOLS,
  // AI chat agents (ask an LLM to use your MCP server), see chat/mcp-tools.ts
  ...CHAT_MCP_TOOLS,
  // Per-feature clock offsets (time travel), see clock/mcp-tools.ts
  ...TIME_MCP_TOOLS,
  // Storyboards: manual test walkthroughs (ontology, guide, authoring, results), see storyboards/mcp-tools.ts
  ...STORYBOARD_MCP_TOOLS,
];

/** "stubyard answered <status>: <error>", plus the REST `details` (e.g. every validation issue with its path) as JSON. */
function httpErrorText(status: number, parsed: unknown, raw: string): string {
  const p = parsed as { error?: string; details?: unknown } | null;
  const head = `stubyard answered ${status}: ${p?.error ?? raw}`;
  return p && typeof p === 'object' && p.details !== undefined ? `${head}\n${JSON.stringify(p.details, null, 2)}` : head;
}

export async function registerMcpRoutes(app: FastifyInstance, hub: Hub): Promise<void> {
  const version = '0.13.0';

  /** Internal API call for composite tools; throws "stubyard answered <status>: <error>[\n<details JSON>]" on HTTP errors. */
  const injectJson = async (method: string, url: string, body?: unknown) => {
    const res = await app.inject({ method: method as 'GET', url, payload: body === undefined ? undefined : (body as object), headers: body === undefined ? {} : { 'content-type': 'application/json' } });
    let parsed: unknown = res.body;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      /* text */
    }
    if (res.statusCode >= 400) throw new Error(httpErrorText(res.statusCode, parsed, res.body));
    return parsed;
  };

  const callTool = async (name: string, args: Json) => {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return { content: [{ type: 'text', text: `Unknown tool "${name}"` }], isError: true };
    if (tool.run) {
      try {
        const out = await tool.run(args ?? {}, { api: injectJson, hub });
        // A string result (markdown, e.g. storyboard_guide) is sent as it is.
        if (typeof out === 'string') return { content: [{ type: 'text', text: out }] };
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], ...(out && typeof out === 'object' && !Array.isArray(out) ? { structuredContent: out } : {}) };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
    const [method, url, body] = tool.call!(args ?? {});
    const res = await app.inject({ method: method as 'GET', url, payload: body === undefined ? undefined : (body as object), headers: body === undefined ? {} : { 'content-type': 'application/json' } });
    let parsed: unknown = res.body;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      /* text */
    }
    const isError = res.statusCode >= 400;
    const text = isError ? httpErrorText(res.statusCode, parsed, res.body) : JSON.stringify(parsed, null, 2);
    return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}), ...(!isError && parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { structuredContent: parsed } : {}) };
  };

  const handle = async (msg: Json): Promise<Json | null> => {
    const id = msg.id;
    const method = String(msg.method ?? '');
    const params = (msg.params ?? {}) as Json;
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
    if (id === undefined || id === null) return null; // notification (e.g. notifications/initialized)
    switch (method) {
      case 'initialize': {
        const requested = String(params.protocolVersion ?? '');
        return ok({
          protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'stubyard', title: 'stubyard local testing hub', version },
          instructions:
            'stubyard is a local testing hub: the app sends email/SMS/WhatsApp to stubyard instead of real providers. ' +
            'Use test-user addresses from list_test_users in test data; read OTPs with wait_for_message / get_latest_code and 2FA codes with get_2fa_code. ' +
            'Simulate failures with set_user_scenario / set_provider_rule and reset them afterwards. Never use real phones or mailboxes. ' +
            'Callbacks not arriving? Run doctor. To author manual test walkthroughs, call describe_storyboards first. Full guide: GET /api/agent-guide.',
        });
      }
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, ...(annotations ? { annotations } : {}) })) });
      case 'tools/call':
        try {
          return ok(await callTool(String(params.name), (params.arguments ?? {}) as Json));
        } catch (err) {
          return ok({ content: [{ type: 'text', text: `Tool failed: ${(err as Error).message}` }], isError: true });
        }
      case 'resources/list':
        return ok({ resources: [] });
      case 'prompts/list':
        return ok({ prompts: [] });
      default:
        return fail(-32601, `Method not found: ${method}`);
    }
  };

  app.post('/mcp', async (req, reply) => {
    const body = req.body;
    if (req.bodyError || !body || typeof body !== 'object') {
      return reply.status(400).send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: req.bodyError ?? 'Parse error: expected a JSON-RPC message' } });
    }
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handle(m as Json)))).filter(Boolean);
      return out.length ? reply.send(out) : reply.status(202).send();
    }
    const res = await handle(body as Json);
    return res ? reply.send(res) : reply.status(202).send();
  });

  // No server-initiated stream; the spec allows 405 here.
  app.get('/mcp', async (_req, reply) => reply.status(405).header('allow', 'POST').send({ error: 'Use POST for MCP requests' }));
  app.delete('/mcp', async (_req, reply) => reply.status(204).send());

}
