import type { FastifyInstance } from 'fastify';
import type { Hub } from '../../hub.js';

/**
 * MCP server (Model Context Protocol, Streamable HTTP transport, JSON responses) at /mcp.
 * Lets AI agents use devhub as tools:  claude mcp add --transport http devhub http://localhost:4000/mcp
 * Tools call devhub's own REST API internally, so behaviour and validation are identical.
 */

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

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

const PROJECT = s('devhub project slug, e.g. "hyper" (see list_projects)');
const USER = s('Test user: id, email, phone, name or role (e.g. "admin", "sales", "customer3@hyper.test")');
const CHANNEL = s('Channel', { enum: ['email', 'sms', 'whatsapp'] });

const TOOLS: Tool[] = [
  {
    name: 'list_projects',
    description: 'List devhub projects (one per app under test) with counts.',
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
    inputSchema: obj({ project: PROJECT, user: USER, channel: CHANNEL }, ['project', 'user']),
    annotations: { readOnlyHint: true },
    call: (a) => ['GET', `/api/projects/${enc(String(a.project))}/users/${enc(String(a.user))}/latest${q({ otp: 1, channel: a.channel })}`],
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
      },
      ['project'],
    ),
    annotations: { readOnlyHint: true },
    call: (a) => {
      const base = `/api/projects/${enc(String(a.project))}/messages`;
      const filters = { user: a.user, to: a.to, channel: a.channel, otp: a.code_only ? 1 : undefined };
      const after = a.after ?? a.after_message_id;
      if (a.get_cursor_only) return ['GET', `${base}/cursor${q(filters)}`];
      if (a.expect_no_message) return ['GET', `${base}/expect-none${q({ ...filters, after, within: a.within_seconds ?? 5 })}`];
      return ['GET', `${base}/wait${q({ ...filters, after, count: a.count, exactly: a.exactly, timeout: a.timeout_seconds ?? 30 })}`];
    },
  },
  {
    name: 'get_messages',
    description: 'Messages (newest first) for a project or one test user: status, applied scenario rule, otp, links, provider.',
    inputSchema: obj({ project: PROJECT, user: USER, channel: CHANNEL, search: s('Text search'), limit: n('Default 20') }, ['project']),
    annotations: { readOnlyHint: true },
    call: (a) => ['GET', `/api/projects/${enc(String(a.project))}/messages${q({ user: a.user, channel: a.channel, q: a.search, limit: a.limit ?? 20 })}`],
  },
  {
    name: 'get_2fa_code',
    description: 'Current authenticator-app (TOTP) code for a key, by label or by linked test user. Includes seconds remaining.',
    inputSchema: obj({ project: PROJECT, label: s('Key label, e.g. "Admin 2FA"'), user: USER }, ['project']),
    annotations: { readOnlyHint: true },
    call: (a) => ['GET', `/api/projects/${enc(String(a.project))}/authenticators/code${q({ label: a.label, user: a.user })}`],
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
      },
      ['project', 'user', 'action'],
    ),
    call: (a) => [
      'POST',
      `/api/projects/${enc(String(a.project))}/users/${enc(String(a.user))}/rules`,
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
      { project: PROJECT, instance: s('Provider instance slug, e.g. "sms-primary"'), action: s('Rule action'), count: n('Next N calls'), minutes: n('For X minutes'), delay_ms: n('For slow'), fail_rate: n('Percent') },
      ['project', 'instance', 'action'],
    ),
    call: (a) => [
      'POST',
      `/api/projects/${enc(String(a.project))}/providers/${enc(String(a.instance))}/rules`,
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
    description: 'Simulate a test user replying by SMS or WhatsApp: devhub sends the provider’s inbound webhook to the app.',
    inputSchema: obj({ project: PROJECT, user: USER, channel: s('Channel', { enum: ['sms', 'whatsapp'] }), text: s('Reply text, e.g. "STOP"'), instance: s('Provider instance slug (default: the channel default)') }, [
      'project',
      'user',
      'text',
    ]),
    call: (a) => ['POST', `/api/projects/${enc(String(a.project))}/users/${enc(String(a.user))}/reply`, { channel: a.channel ?? 'sms', text: a.text, instance: a.instance }],
  },
  {
    name: 'get_traffic',
    description: 'Recent requests devhub received or sent for a project (API calls, SMTP sessions, callbacks), including errors and 404s. Use to debug "nothing arrived".',
    inputSchema: obj({ project: PROJECT, outcome: s('ok, unmatched, invalid, rejected, forced_error, internal_error, network_error'), search: s('Text search'), limit: n('Default 20') }, ['project']),
    annotations: { readOnlyHint: true },
    call: (a) => ['GET', `/api/logs${q({ project: a.project, outcome: a.outcome, q: a.search, limit: a.limit ?? 20 })}`],
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

  // ---------- Diagnostics ----------
  {
    name: 'doctor',
    description:
      'Check from inside devhub that every URL it will call for a project (status callbacks, inbound URLs, email event webhooks, webhook templates) ' +
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
    inputSchema: obj({ project: PROJECT, mock: s('Mock name or id'), scenario: s('Scenario name') }, ['project', 'mock', 'scenario']),
    call: (a) => ['PATCH', `/api/projects/${enc(String(a.project))}/mocks/${enc(String(a.mock))}/active-scenario`, { scenario: a.scenario }],
  },

  // ---------- Providers ----------
  {
    name: 'list_providers',
    description:
      'Provider instances of a project (SMTP, Twilio, Vonage, WhatsApp, SendGrid, Mailgun, SES, Generic) with their config and the base URLs to put in the app ' +
      '(from this machine and from containers on the devhub network).',
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
              ? { smtp: `localhost:${c.smtpPort}`, smtpFromContainers: `devhub:${c.smtpPort}`, smtpUsername: `${slug}.${String(p.slug)}` }
              : { https: `https://localhost:${c.httpsPort}${path}`, http: `http://localhost:${c.httpPort}${path}`, fromContainers: `https://devhub:${c.httpsPort}${path}` };
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
      'Create a devhub project for an app (with an SMTP email instance) and generate test users, e.g. roles [{"role":"admin","count":1},{"role":"customer","count":9}]. ' +
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
    description: 'Export a project’s configuration (users, providers, rules, webhooks, mocks…) as devhub JSON, e.g. to commit it as a DEVHUB_SEED file for CI.',
    inputSchema: obj({ project: PROJECT, include_secrets: { type: 'boolean', description: 'Include authenticator (TOTP) secrets' } }, ['project']),
    annotations: { readOnlyHint: true },
    call: (a) => ['GET', `/api/projects/${enc(String(a.project))}/export${q({ secrets: a.include_secrets ? 1 : undefined })}`],
  },
];

export async function registerMcpRoutes(app: FastifyInstance, hub: Hub): Promise<void> {
  const version = '0.4.0';

  /** Internal API call for composite tools; throws "devhub answered <status>: <error>" on HTTP errors. */
  const injectJson = async (method: string, url: string, body?: unknown) => {
    const res = await app.inject({ method: method as 'GET', url, payload: body === undefined ? undefined : (body as object), headers: body === undefined ? {} : { 'content-type': 'application/json' } });
    let parsed: unknown = res.body;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      /* text */
    }
    if (res.statusCode >= 400) throw new Error(`devhub answered ${res.statusCode}: ${(parsed as { error?: string })?.error ?? res.body}`);
    return parsed;
  };

  const callTool = async (name: string, args: Json) => {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return { content: [{ type: 'text', text: `Unknown tool "${name}"` }], isError: true };
    if (tool.run) {
      try {
        const out = await tool.run(args ?? {}, { api: injectJson, hub });
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
    const text = isError
      ? `devhub answered ${res.statusCode}: ${(parsed as { error?: string })?.error ?? res.body}`
      : JSON.stringify(parsed, null, 2);
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
          serverInfo: { name: 'devhub', title: 'devhub local testing hub', version },
          instructions:
            'devhub is a local testing hub: the app sends email/SMS/WhatsApp to devhub instead of real providers. ' +
            'Use test-user addresses from list_test_users in test data; read OTPs with wait_for_message / get_latest_code and 2FA codes with get_2fa_code. ' +
            'Simulate failures with set_user_scenario / set_provider_rule and reset them afterwards. Never use real phones or mailboxes. ' +
            'Callbacks not arriving? Run doctor. Full guide: GET /api/agent-guide.',
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
