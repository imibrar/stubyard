/**
 * stubyard push-notification helpers for tests (anything with a fetch).
 *
 *   import { registerDevice, pushCursor, waitForPush } from '@stubyard/client/push';
 *   const phone = await registerDevice({ project: 'chat', user: 'alice@example.test', platform: 'android' });
 *   // … save phone.token in your app as Alice's FCM token …
 *   const cursor = await pushCursor({ project: 'chat', user: 'alice@example.test' });
 *   // … Bob sends Alice a message, your backend calls FCM / APNs (pointed at stubyard) …
 *   const [push] = await waitForPush({ project: 'chat', user: 'alice@example.test', after: cursor, title: 'New message' });
 *   expect(push.data.chatId).toBe('42');
 */

import { hubFetchFn, trimSlashes } from './http.js';

export interface PushTarget {
  /** stubyard API base, default http://localhost:4000. */
  apiUrl?: string;
  project: string;
  /** API token for a hub with sign-in on; default the STUBYARD_TOKEN environment variable. */
  apiToken?: string;
  /** Run key: the device / notifications / faults belong to that run. */
  run?: string;
}

export type PushPlatform = 'android' | 'ios' | 'web';

export interface PushDevice {
  id: string;
  instance: { id: string; slug: string; preset: 'fcm' | 'apns' } | null;
  platform: PushPlatform;
  token: string;
  name: string;
  appId: string | null;
  topics: string[];
  state: 'active' | 'unregistered';
  unregisteredAt: string | null;
  badge: number | null;
  /** Created by the first push to an unknown token. */
  auto: boolean;
  user: { id: string; name: string } | null;
  run: string | null;
  lastPushAt: string | null;
  createdAt: string;
}

export interface PushNotification {
  id: string;
  provider: 'fcm' | 'apns';
  instance: { id: string; slug: string; preset: 'fcm' | 'apns' } | null;
  device: { id: string; name: string; platform: PushPlatform; token: string } | null;
  user: { id: string; name: string } | null;
  run: string | null;
  targetKind: 'token' | 'topic' | 'condition';
  target: string;
  groupId: string | null;
  title: string | null;
  body: string | null;
  image: string | null;
  data: Record<string, unknown>;
  badge: number | null;
  sound: string | null;
  category: string | null;
  threadId: string | null;
  collapseKey: string | null;
  priority: string | null;
  pushType: string | null;
  silent: boolean;
  status: 'delivered' | 'collapsed' | 'dropped' | 'rejected' | 'validated' | 'no_subscribers';
  errorCode: string | null;
  providerMessageId: string | null;
  lint: { check: string; severity: string; message: string }[];
  tap: { kind: string; value: string } | null;
  openedAt: string | null;
  createdAt: string;
}

export interface PushFilter extends PushTarget {
  /** Test user (id, email, phone or name). */
  user?: string;
  /** Device id or token. */
  device?: string;
  provider?: 'fcm' | 'apns';
  topic?: string;
  /** Text in title / body. */
  contains?: string;
  title?: string;
  /** Notifications whose data has this key. */
  dataKey?: string;
}

const api = (o: { apiUrl?: string }) => trimSlashes(o.apiUrl ?? 'http://localhost:4000');
const base = (o: PushTarget) => `${api(o)}/api/projects/${encodeURIComponent(o.project)}/push`;
const qs = (o: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
const filterQs = (o: PushFilter, extra: Record<string, unknown> = {}) =>
  qs({ run: o.run, user: o.user, device: o.device, provider: o.provider, topic: o.topic, contains: o.contains, title: o.title, dataKey: o.dataKey, ...extra });

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) throw new Error(`stubyard answered ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}
const send = (o: PushTarget, method: string, url: string, body?: unknown) =>
  hubFetchFn(o)(url, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

/** Register a fake device (stubyard makes a realistic FCM / APNs token unless you pass one). */
export async function registerDevice(
  o: PushTarget & { user?: string; platform?: PushPlatform; instance?: string; token?: string; name?: string; appId?: string; topics?: string[] },
): Promise<PushDevice> {
  return json(await send(o, 'POST', `${base(o)}/devices`, { run: o.run, user: o.user, platform: o.platform ?? 'android', instance: o.instance, token: o.token, name: o.name, appId: o.appId, topics: o.topics }));
}

/** The app was uninstalled: FCM answers UNREGISTERED (404), APNs 410 Unregistered. `reRegister` undoes it. */
export async function unregisterDevice(o: PushTarget & { device: string; reRegister?: boolean }): Promise<PushDevice> {
  return json(await send(o, 'POST', `${base(o)}/devices/${encodeURIComponent(o.device)}/${o.reRegister ? 'register' : 'unregister'}`));
}

/** Subscribe / unsubscribe a device to FCM topics. */
export async function subscribeTopic(o: PushTarget & { device: string; add?: string[]; remove?: string[] }): Promise<PushDevice> {
  return json(await send(o, 'POST', `${base(o)}/devices/${encodeURIComponent(o.device)}/topics`, { add: o.add, remove: o.remove }));
}

/** A cursor for "pushes after now": pass it as `after` to waitForPush. */
export async function pushCursor(o: PushFilter): Promise<string> {
  return (await json<{ cursor: string }>(await hubFetchFn(o)(`${base(o)}/notifications/cursor${filterQs(o)}`))).cursor;
}

/**
 * Wait until `count` (default 1) pushes match (`exactly`: no more than that within `settleMs`). Without `after`,
 * pushes of the last `lookbackSeconds` (default 10; in a run: since the run started) count. Throws on timeout.
 */
export async function waitForPush(o: PushFilter & { after?: string; count?: number; exactly?: number; timeoutMs?: number; settleMs?: number; lookbackSeconds?: number }): Promise<PushNotification[]> {
  const timeoutMs = o.timeoutMs ?? 10_000;
  const r = await json<{ timedOut: boolean; error?: string; notifications: PushNotification[] }>(
    await hubFetchFn(o)(
      `${base(o)}/notifications/wait${filterQs(o, { after: o.after, count: o.count, exactly: o.exactly, timeout: timeoutMs / 1000, settle: o.settleMs !== undefined ? o.settleMs / 1000 : undefined, lookback: o.lookbackSeconds })}`,
    ),
  );
  if (r.error) throw new Error(r.error);
  if (r.timedOut) throw new Error(`No matching push within ${timeoutMs} ms (got ${r.notifications.length} of ${o.exactly ?? o.count ?? 1})`);
  return r.notifications;
}

/** Newest first. */
export async function listPushes(o: PushFilter & { status?: string; limit?: number }): Promise<PushNotification[]> {
  return json(await hubFetchFn(o)(`${base(o)}/notifications${filterQs(o, { status: o.status, limit: o.limit })}`));
}

/** Simulate the user tapping the notification: returns what the app would open (click_action / link / category). */
export async function openPush(o: PushTarget & { id: string }): Promise<{ id: string; openedAt: string; tap: { kind: string; value: string } | null; data: Record<string, unknown> }> {
  return json(await send(o, 'POST', `${base(o)}/notifications/${encodeURIComponent(o.id)}/open`));
}

/** Make sends fail: "unregistered", "quota[:secs]", "unavailable", "internal", "auth", "timeout", "drop", "slow:<ms>", … */
export async function setPushFault(o: PushTarget & { fault: string; user?: string; token?: string; topic?: string; instance?: string; times?: number }): Promise<{ id: string; fault: string; remaining: number | null }> {
  return json(await send(o, 'POST', `${base(o)}/faults`, { run: o.run, fault: o.fault, user: o.user, token: o.token, topic: o.topic, instance: o.instance, times: o.times }));
}

/** Remove the fault rules (of the run when `run` is given). */
export async function resetPushFaults(o: PushTarget): Promise<number> {
  return (await json<{ deleted: number }>(await send(o, 'DELETE', `${base(o)}/faults${qs({ run: o.run })}`))).deleted;
}

/** The FCM service-account JSON (GOOGLE_APPLICATION_CREDENTIALS) of an FCM instance; token_uri points at stubyard. */
export async function fcmServiceAccount(o: PushTarget & { instance?: string }): Promise<Record<string, string>> {
  return json(await hubFetchFn(o)(`${base(o)}/instances/${encodeURIComponent(o.instance ?? 'fcm')}/service-account.json?download=0`));
}

/** APNs token-auth settings of an APNs instance: key (.p8 PEM), keyId, teamId, host / port of the HTTP/2 listener. */
export async function apnsConfig(o: PushTarget & { instance?: string }): Promise<{ key: string; keyId: string; teamId: string; bundleIds: string[]; host: string; port: number | null; caUrl: string }> {
  const slug = encodeURIComponent(o.instance ?? 'apns');
  const [c, key] = await Promise.all([json<any>(await hubFetchFn(o)(`${base(o)}/instances/${slug}/connect`)), hubFetchFn(o)(`${base(o)}/instances/${slug}/apns-key.p8?download=0`).then((r) => r.text())]);
  return { key, keyId: c.keyId, teamId: c.teamId, bundleIds: c.bundleIds, host: new URL(api(o)).hostname, port: c.urls.apnsPort ?? null, caUrl: c.caUrl };
}
