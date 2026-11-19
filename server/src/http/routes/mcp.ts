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
  call: (a: Json) => [string, string, unknown?];
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
      'Wait until a test user receives a message (optionally only one with a code) and return it, including otp and links. ' +
      'Call it right after triggering the action in the app; messages from the last 10 s also count unless `after_message_id` is given.',
    inputSchema: obj(
      {
        project: PROJECT,
        user: USER,
        to: s('Recipient address instead of a user (email or phone)'),
        channel: CHANNEL,
        code_only: { type: 'boolean', description: 'Only messages with a detected OTP code' },
        after_message_id: s('Only messages newer than this message id'),
        timeout_seconds: n('Max wait, default 30, max 120'),
      },
      ['project'],
    ),
    annotations: { readOnlyHint: true },
    call: (a) => [
      'GET',
      `/api/projects/${enc(String(a.project))}/messages/wait${q({ user: a.user, to: a.to, channel: a.channel, otp: a.code_only ? 1 : undefined, after: a.after_message_id, timeout: a.timeout_seconds ?? 30 })}`,
    ],
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
];

export async function registerMcpRoutes(app: FastifyInstance, hub: Hub): Promise<void> {
  const version = '0.2.0';

  const callTool = async (name: string, args: Json) => {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return { content: [{ type: 'text', text: `Unknown tool "${name}"` }], isError: true };
    const [method, url, body] = tool.call(args ?? {});
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
            'Simulate failures with set_user_scenario / set_provider_rule and reset them afterwards. Never use real phones or mailboxes.',
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

  void hub;
}
