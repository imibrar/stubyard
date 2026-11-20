/** MCP tools for scripted auto-replies (appended to the TOOLS list in http/routes/mcp.ts). */
type Json = Record<string, unknown>;
interface AutoReplyTool {
  name: string;
  description: string;
  inputSchema: Json;
  annotations?: Json;
  run: (a: Json, ctx: { api: (method: string, url: string, body?: unknown) => Promise<any> }) => Promise<unknown>;
}

const s = (description: string, extra: Json = {}) => ({ type: 'string', description, ...extra });
const n = (description: string) => ({ type: 'number', description });
const o = (description: string) => ({ type: 'object', description });
const obj = (properties: Json, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const enc = encodeURIComponent;
const PROJECT = s('stubyard project slug, e.g. "hyper"');
const RUN = s('Test run key or id: limit to / attach to that run');
const base = (a: Json) => `/api/projects/${enc(String(a.project))}/auto-replies`;
const qs = (q: Record<string, unknown>) => {
  const parts = Object.entries(q)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${enc(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
};
const RO = { readOnlyHint: true, openWorldHint: false };
const TEXT_COND = 'a string (contains, case-insensitive) or {equals|contains|regex}; regex is "/src/flags" or a plain pattern';

const briefRule = (r: Json) => ({
  id: r.id,
  name: r.name,
  enabled: r.enabled,
  channel: r.channel,
  summary: r.summary,
  match: r.match,
  reply: r.reply,
  delayMs: r.delayMs,
  jitterMs: r.jitterMs,
  uses: r.uses,
  maxUses: r.maxUses,
  usedUp: r.usedUp,
  stop: r.stop,
  run: r.run,
  pendingFires: r.pendingFires,
  lastFire: r.lastFire,
  ...(r.disabledReason ? { disabledReason: r.disabledReason } : {}),
  ...((r.warnings as unknown[] | undefined)?.length ? { warnings: r.warnings } : {}),
});

const briefFire = (f: Json) => ({
  id: f.id,
  status: f.status,
  rule: f.ruleName,
  ruleId: f.ruleId,
  user: (f.user as Json | null)?.name ?? null,
  run: f.run,
  dueAt: f.dueAt,
  firedAt: f.firedAt,
  trigger: f.trigger,
  reply: f.reply,
  webhookOk: f.webhookOk,
  webhookStatus: f.webhookStatus,
  error: f.error,
  captures: (f.plan as Json | undefined)?.captures,
  rendered: (f.plan as Json | undefined)?.rendered,
  warnings: (f.plan as Json | undefined)?.warnings,
});

export const AUTO_REPLY_MCP_TOOLS: AutoReplyTool[] = [
  {
    name: 'list_auto_replies',
    description:
      'List the scripted auto-reply rules of a project: a fake test user answers by itself when the app sends them an email, SMS or WhatsApp message (e.g. echoes the OTP back). Shows uses / maxUses, pending fires, the last fire and warnings (loop guard).',
    inputSchema: obj({ project: PROJECT, run: RUN }, ['project']),
    annotations: RO,
    run: async (a, { api }) => ((await api('GET', `${base(a)}${qs({ run: a.run })}`)) as Json[]).map(briefRule),
  },
  {
    name: 'list_auto_reply_fires',
    description: 'List auto-reply fires (each time a rule matched a message): status pending | sent | failed | cancelled | skipped, the trigger message, the reply message and whether the app accepted the inbound webhook.',
    inputSchema: obj({ project: PROJECT, rule: s('Rule id'), status: s('Comma-separated statuses'), run: RUN, limit: n('Max results (default 20)') }, ['project']),
    annotations: RO,
    run: async (a, { api }) => ((await api('GET', `${base(a)}/fires${qs({ rule: a.rule, status: a.status, run: a.run, limit: a.limit ?? 20 })}`)) as Json[]).map(briefFire),
  },
  {
    name: 'test_auto_reply',
    description:
      'Dry run: would a rule (saved id or inline {channel, match, reply}) answer a message (a stubyard message id, or {channel, to, from, subject, body})? Returns matched, the reasons it did not match, regex captures and the rendered reply. Nothing is sent.',
    inputSchema: obj({ project: PROJECT, rule: { description: 'Rule id, or an inline rule {channel, match, reply}' }, message: { description: 'Message id, or {channel, to, from, subject, body}' } }, ['project', 'rule', 'message']),
    annotations: RO,
    run: async (a, { api }) => api('POST', `${base(a)}/test`, { rule: a.rule, message: a.message }),
  },
  {
    name: 'wait_for_auto_reply',
    description:
      'Wait (long-poll) until an auto-reply was sent or failed. Pass "after" (a fire id from list_auto_reply_fires, or the "cursor" of an earlier wait) to ignore older fires. Returns the fire with the reply text and the webhook result; timedOut: true when nothing happened.',
    inputSchema: obj({ project: PROJECT, rule: s('Rule id'), user: s('Test user (id, email, phone, name)'), status: s('Comma-separated statuses (default sent,failed)'), after: s('Only fires newer than this fire id'), run: RUN, timeout_seconds: n('Max wait, ≤ 60 (default 10)') }, ['project']),
    annotations: RO,
    run: async (a, { api }) => {
      const r = (await api('POST', `${base(a)}/fires/wait`, {
        rule: a.rule,
        user: a.user,
        status: a.status,
        after: a.after,
        run: a.run,
        timeoutMs: Math.round(Number(a.timeout_seconds ?? 10) * 1000),
      })) as Json;
      return { timedOut: r.timedOut, fire: r.fire ? briefFire(r.fire as Json) : null };
    },
  },
  {
    name: 'set_auto_reply',
    description:
      'Create (or with id: update) a scripted auto-reply rule. When the app sends a matching message to a test user, that user answers by itself through the provider\'s inbound webhook, like a real phone or mailbox. ' +
      'Templates: {{otp}}, {{link}}, {{subject}}, {{body}}, {{body.1}} / {{$1}} (body regex groups), {{user.name}}, {{now}}, {{random.digits:6}}. ' +
      'Prefer reply_as_user for one manual reply right now, and schedule_action for a call at a fixed time. Example: match {hasOtp: true}, reply {text: "{{otp}}"}.',
    inputSchema: obj(
      {
        project: PROJECT,
        id: s('Rule id to update (default: create)'),
        name: s('Rule name'),
        channel: s('email | sms | whatsapp | any (default any)', { enum: ['email', 'sms', 'whatsapp', 'any'] }),
        match: o(`Conditions, all must hold: to, from, subject, body (${TEXT_COND}), user, role, instance, hasOtp, hasLink. {} matches every delivered message.`),
        reply: o('{text, subject?, html?, channel?, instance?, button? (WhatsApp: id, title or "#1"), thread? (email, default true)}'),
        delay_seconds: n('Wait before replying (default 0)'),
        jitter_seconds: n('Random extra delay 0..n seconds'),
        max_uses: n('Stop after n replies (default unlimited)'),
        stop: { type: 'boolean', description: 'Default true: later rules are not evaluated after this one matched' },
        enabled: { type: 'boolean', description: 'Default true' },
        run: RUN,
      },
      ['project'],
    ),
    run: async (a, { api }) => {
      const body: Json = {};
      for (const k of ['name', 'channel', 'match', 'reply', 'stop', 'enabled']) if (a[k] !== undefined) body[k] = a[k];
      if (a.delay_seconds !== undefined) body.delaySeconds = a.delay_seconds;
      if (a.jitter_seconds !== undefined) body.jitterSeconds = a.jitter_seconds;
      if (a.max_uses !== undefined) body.maxUses = a.max_uses;
      const r = a.id ? await api('PATCH', `${base(a)}/${enc(String(a.id))}`, body) : await api('POST', `${base(a)}${qs({ run: a.run })}`, body);
      return briefRule(r as Json);
    },
  },
  {
    name: 'delete_auto_reply',
    description: 'Delete one auto-reply rule (id), or every project rule (all: true; with run: every rule of that run). Pending fires of deleted rules are dropped.',
    inputSchema: obj({ project: PROJECT, id: s('Rule id'), all: { type: 'boolean', description: 'Delete all rules in scope' }, run: RUN }, ['project']),
    annotations: { destructiveHint: true },
    run: async (a, { api }) => {
      if (a.id) {
        await api('DELETE', `${base(a)}/${enc(String(a.id))}`);
        return { deleted: 1 };
      }
      if (a.all !== true) throw new Error('Pass id, or all: true');
      return api('DELETE', `${base(a)}${qs({ run: a.run })}`);
    },
  },
  {
    name: 'flush_auto_replies',
    description: 'Send every pending (delayed) auto-reply now, in due order, and return the results. Use it in tests instead of sleeping through a delay.',
    inputSchema: obj({ project: PROJECT, run: RUN }, ['project']),
    run: async (a, { api }) => {
      const r = (await api('POST', `${base(a)}/flush`, { run: a.run })) as { fired: Json[] };
      return { fired: r.fired.map(briefFire) };
    },
  },
];
