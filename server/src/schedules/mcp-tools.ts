/** MCP tools for scheduled actions (appended to the TOOLS list in http/routes/mcp.ts). */
type Json = Record<string, unknown>;
interface ScheduleTool {
  name: string;
  description: string;
  inputSchema: Json;
  annotations?: Json;
  run: (a: Json, ctx: { api: (method: string, url: string, body?: unknown) => Promise<any> }) => Promise<unknown>;
}

const s = (description: string, extra: Json = {}) => ({ type: 'string', description, ...extra });
const n = (description: string) => ({ type: 'number', description });
const obj = (properties: Json, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const enc = encodeURIComponent;
const PROJECT = s('stubyard project slug, e.g. "hyper"');
const RUN = s('Test run key or id (see start_run): the scheduled call runs inside that run; it is cancelled when the run stops');
const ACTIONS = ['webhook.send', 'webhook.sequence', 'user.reply', 'rule.set', 'rule.clear', 'mock.scenario'];
const base = (a: Json) => `/api/projects/${enc(String(a.project))}/schedules`;
const runQ = (a: Json) => (a.run ? `?run=${enc(String(a.run))}` : '');
const need = (a: Json, k: string, action: string) => {
  if (a[k] === undefined || a[k] === null || a[k] === '') throw new Error(`${action} needs "${k}"`);
  return enc(String(a[k]));
};

/** The REST call (method, suffix) of a schedule_action request. */
function target(a: Json): { method: string; path: string } {
  const act = String(a.action ?? '');
  switch (act) {
    case 'webhook.send':
      return { method: 'POST', path: `/webhook-templates/${need(a, 'template', act)}/send` };
    case 'webhook.sequence':
      return { method: 'POST', path: `/webhook-sequences/${need(a, 'sequence', act)}/run` };
    case 'user.reply':
      return { method: 'POST', path: `/users/${need(a, 'user', act)}/reply` };
    case 'mock.scenario':
      return { method: 'PATCH', path: `/mocks/${need(a, 'mock', act)}/active-scenario` };
    case 'rule.set': {
      const owner = a.user ? `/users/${enc(String(a.user))}` : a.instance ? `/providers/${enc(String(a.instance))}` : null;
      if (!owner) throw new Error('rule.set needs "user" or "instance"');
      return { method: 'POST', path: `${owner}/rules${a.preset ? `/preset/${enc(String(a.preset))}` : ''}` };
    }
    case 'rule.clear': {
      if (a.rule) return { method: 'DELETE', path: `/rules/${enc(String(a.rule))}` };
      if (a.user) return { method: 'DELETE', path: `/users/${enc(String(a.user))}/rules` };
      if (a.instance) return { method: 'DELETE', path: `/providers/${enc(String(a.instance))}/rules` };
      return { method: 'POST', path: '/rules/reset' };
    }
    default:
      throw new Error(`Unknown action "${act}". Use one of ${ACTIONS.join(', ')}`);
  }
}

const brief = (x: Json) => ({
  id: x.id,
  label: x.label,
  action: x.action,
  call: `${x.method} ${x.url}`,
  status: x.status,
  nextAt: x.nextAt,
  run: x.run,
  fired: x.fired,
  maxFires: x.maxFires,
  everyMs: x.everyMs,
  missed: x.missed,
  lastStatus: x.lastStatus,
  lastError: x.lastError,
  lastFiredAt: x.lastFiredAt,
});

export const SCHEDULE_MCP_TOOLS: ScheduleTool[] = [
  {
    name: 'schedule_action',
    description:
      'Do something later (or repeatedly): send a webhook template, run a webhook sequence, reply as a test user, set or clear delivery rules, or switch a mock scenario. ' +
      'Give delay_seconds or at (ISO time, max 30 days ahead); every_seconds (>= 1) + max_times (default 10, max 100) repeat it. ' +
      'body is what the matching REST call takes, e.g. webhook.send {"data":{…}}, user.reply {"channel":"sms","text":"STOP"}, rule.set {"action":"fail","channel":"sms"} (or preset), mock.scenario {"scenario":"Card declined"}. ' +
      'Returns the schedule id; see list_scheduled / flush_scheduled.',
    inputSchema: obj(
      {
        project: PROJECT,
        action: s('What to do', { enum: ACTIONS }),
        template: s('webhook.send: webhook template id or name'),
        sequence: s('webhook.sequence: webhook sequence id or name'),
        user: s('user.reply / rule.set / rule.clear: test user (id, email, phone, name or role)'),
        instance: s('rule.set / rule.clear: provider instance slug (instead of user)'),
        preset: s('rule.set: rule preset id (see GET /api/rule-presets) instead of a body'),
        rule: s('rule.clear: one rule id (without user/instance/rule: reset all rules of the project)'),
        mock: s('mock.scenario: mock id or name'),
        body: { type: 'object', description: 'JSON body of the REST call' },
        delay_seconds: n('Fire after this many seconds (0 = now)'),
        at: s('Fire at this ISO date-time instead'),
        every_seconds: n('Repeat every N seconds (fixed rate)'),
        max_times: n('Max fires when repeating (default 10, cap 100)'),
        label: s('Label shown in the dashboard'),
        run: RUN,
      },
      ['project', 'action'],
    ),
    run: async (a, { api }) => {
      const t = target(a);
      const req: Json = { ...t, body: a.body, label: a.label };
      if (a.at) req.at = a.at;
      else req.delaySeconds = a.delay_seconds ?? 0;
      if (a.every_seconds !== undefined) req.everyMs = Math.round(Number(a.every_seconds) * 1000);
      if (a.max_times !== undefined) req.maxFires = a.max_times;
      return brief(await api('POST', `${base(a)}${runQ(a)}`, req));
    },
  },
  {
    name: 'list_scheduled',
    description: 'Scheduled actions of a project (pending and paused first, then finished ones from the last 24 h) with next fire time, fire count and last result.',
    inputSchema: obj(
      { project: PROJECT, status: s('Filter: pending, paused, done, failed, cancelled, missed (comma-separated), "active" or "finished"'), run: RUN },
      ['project'],
    ),
    annotations: { readOnlyHint: true },
    run: async (a, { api }) => {
      const qs = new URLSearchParams();
      if (a.status) qs.set('status', String(a.status));
      if (a.run) qs.set('run', String(a.run));
      const list = (await api('GET', `${base(a)}${qs.size ? `?${qs}` : ''}`)) as Json[];
      return { schedules: list.map(brief) };
    },
  },
  {
    name: 'cancel_scheduled',
    description: 'Cancel a pending or paused scheduled action (a finished one is deleted).',
    inputSchema: obj({ project: PROJECT, id: s('Schedule id') }, ['project', 'id']),
    annotations: { destructiveHint: true },
    run: async (a, { api }) => {
      const r = await api('DELETE', `${base(a)}/${enc(String(a.id))}`);
      return r.schedule ? { cancelled: true, schedule: brief(r.schedule) } : r;
    },
  },
  {
    name: 'flush_scheduled',
    description: 'Fire every pending scheduled action of the project (or of one run) right now, once each, in time order, and return the results. Useful in tests instead of waiting.',
    inputSchema: obj({ project: PROJECT, run: RUN }, ['project']),
    run: async (a, { api }) => api('POST', `${base(a)}/flush`, a.run ? { run: a.run } : {}),
  },
];
