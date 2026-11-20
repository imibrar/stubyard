/** MCP tools for push notifications (appended to the TOOLS list in http/routes/mcp.ts). */
type Json = Record<string, unknown>;
interface PushTool {
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
const RUN = s('Test run key or id');
const USER = s('Test user: id, email, phone or name');
const FAULT = s('unregistered | bad_token | quota[:secs] | unavailable | internal | auth | sender_mismatch | payload_too_large | topic_disallowed | timeout | drop | slow:<ms> | none (clears)');
const base = (a: Json) => `/api/projects/${enc(String(a.project))}/push`;
const qs = (q: Record<string, unknown>) => {
  const parts = Object.entries(q)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${enc(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
};
const RO = { readOnlyHint: true, openWorldHint: false };

const briefDevice = (d: Json) => ({ id: d.id, name: d.name, platform: d.platform, token: d.token, user: (d.user as Json | null)?.name ?? null, instance: (d.instance as Json | null)?.slug ?? null, state: d.state, topics: d.topics, run: d.run });
const briefPush = (p: Json) => ({
  id: p.id,
  provider: p.provider,
  status: p.status,
  errorCode: p.errorCode,
  title: p.title,
  body: p.body,
  data: p.data,
  silent: p.silent,
  target: p.targetKind === 'token' ? 'device' : `${String(p.targetKind)}: ${String(p.target)}`,
  user: (p.user as Json | null)?.name ?? null,
  device: (p.device as Json | null)?.name ?? null,
  lint: ((p.lint as Json[] | undefined) ?? []).map((l) => l.check),
  createdAt: p.createdAt,
});

export const PUSH_MCP_TOOLS: PushTool[] = [
  {
    name: 'list_push_devices',
    description: 'Fake phones / browsers registered for push notifications in a project: token, platform, test user, topics, state (active | unregistered).',
    inputSchema: obj({ project: PROJECT, user: USER, platform: s('ios | android | web'), run: RUN }, ['project']),
    annotations: RO,
    run: async (a, { api }) => ((await api('GET', `${base(a)}/devices${qs({ user: a.user, platform: a.platform, run: a.run })}`)) as Json[]).map(briefDevice),
  },
  {
    name: 'list_push_notifications',
    description: 'Push notifications your app sent through the fake FCM / APNs, newest first: title, body, data, status (delivered | collapsed | rejected | dropped | validated | no_subscribers), lint.',
    inputSchema: obj({ project: PROJECT, user: USER, device: s('Device id or token'), status: s('Comma list of statuses'), contains: s('Text in title, body or data'), run: RUN, limit: n('Max results (default 20)') }, ['project']),
    annotations: RO,
    run: async (a, { api }) => ((await api('GET', `${base(a)}/notifications${qs({ user: a.user, device: a.device, status: a.status, contains: a.contains, run: a.run, limit: a.limit ?? 20 })}`)) as Json[]).map(briefPush),
  },
  {
    name: 'get_push_notification',
    description: 'One push notification with the raw request payload, headers, lint findings and the tap target.',
    inputSchema: obj({ project: PROJECT, id: s('Notification id') }, ['project', 'id']),
    annotations: RO,
    run: async (a, { api }) => api('GET', `${base(a)}/notifications/${enc(String(a.id))}`),
  },
  {
    name: 'wait_for_push',
    description: 'Wait (up to timeout_seconds, default 10, max 60) for a push notification to a user or device, e.g. after triggering "new message" in the app. Pass after = the cursor from list_push_notifications / an earlier wait to skip older pushes.',
    inputSchema: obj({ project: PROJECT, user: USER, device: s('Device id or token'), contains: s('Text in title, body or data'), after: s('Cursor (notification id)'), timeout_seconds: n('Max wait (default 10, max 60)'), run: RUN }, ['project']),
    annotations: RO,
    run: async (a, { api }) => {
      const r = (await api('GET', `${base(a)}/notifications/wait${qs({ user: a.user, device: a.device, contains: a.contains, after: a.after, run: a.run, timeout: Math.min(60, Number(a.timeout_seconds ?? 10)) })}`)) as Json;
      return { timedOut: r.timedOut, cursor: r.cursor, notifications: ((r.notifications as Json[]) ?? []).map(briefPush) };
    },
  },
  {
    name: 'register_push_device',
    description:
      'Register a fake device for a test user and get its push token: plant the token in your app (as if the phone had called FCM getToken() / registerForRemoteNotifications). The device is attached to the project\'s FCM or APNs instance (default by platform).',
    inputSchema: obj({ project: PROJECT, user: USER, platform: s('ios | android | web', { enum: ['ios', 'android', 'web'] }), instance: s('Push instance slug (default: the APNs instance for ios, else FCM)'), topics: { type: 'array', items: { type: 'string' }, description: 'FCM topics to subscribe' }, name: s('Device name'), run: RUN }, ['project', 'platform']),
    run: async (a, { api }) => briefDevice(await api('POST', `${base(a)}/devices${qs({ run: a.run })}`, { user: a.user, platform: a.platform, instance: a.instance, topics: a.topics, name: a.name })),
  },
  {
    name: 'unregister_push_device',
    description: 'Mark a device as uninstalled: FCM then answers 404 UNREGISTERED and APNs 410 Unregistered for its token (test your token clean-up). re_register: true makes it active again.',
    inputSchema: obj({ project: PROJECT, device: s('Device id or token'), re_register: { type: 'boolean', description: 'Activate again instead' } }, ['project', 'device']),
    run: async (a, { api }) => briefDevice(await api('POST', `${base(a)}/devices/${enc(String(a.device))}/${a.re_register ? 'register' : 'unregister'}`)),
  },
  {
    name: 'set_push_fault',
    description: 'Make FCM / APNs sends fail on purpose, each in the provider\'s own error shape, for the next `times` sends (default all), optionally only for one token, user, topic or run. fault "none" removes the fault rules (of the run, if given).',
    inputSchema: obj({ project: PROJECT, fault: FAULT, instance: s('Push instance slug'), token: s('Only this device token'), user: USER, topic: s('Only sends to this topic'), times: n('Number of sends (default: all until removed)'), run: RUN }, ['project', 'fault']),
    run: async (a, { api }) => {
      if (String(a.fault).toLowerCase() === 'none') return api('DELETE', `${base(a)}/faults${qs({ run: a.run })}`);
      return api('POST', `${base(a)}/faults${qs({ run: a.run })}`, { fault: a.fault, instance: a.instance, token: a.token, user: a.user, topic: a.topic, times: a.times });
    },
  },
  {
    name: 'reset_push',
    description: 'Delete the push notifications of a project (or of one user / run) and remove its fault rules. Instances and registered devices stay.',
    inputSchema: obj({ project: PROJECT, user: USER, run: RUN }, ['project']),
    annotations: { destructiveHint: true },
    run: async (a, { api }) => {
      const notifications = await api('DELETE', `${base(a)}/notifications${qs({ user: a.user, run: a.run })}`);
      const faults = a.user ? null : await api('DELETE', `${base(a)}/faults${qs({ run: a.run })}`);
      return { notifications, faults };
    },
  },
];
