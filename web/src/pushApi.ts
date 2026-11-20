/** Types and helpers of the push API (/api/projects/:slug/push/…, data plane /push/<project>/<instance>/…). */
import { api, qs } from './api';

export type PushPreset = 'fcm' | 'apns';
export type PushPlatform = 'android' | 'ios' | 'web';
export type PushStatus = 'delivered' | 'collapsed' | 'dropped' | 'rejected' | 'validated' | 'no_subscribers';

export const pushBase = (slug: string) => `/api/projects/${encodeURIComponent(slug)}/push`;

export interface PushInstance {
  id: string;
  projectId: string;
  slug: string;
  name: string;
  preset: PushPreset;
  enabled: boolean;
  strict: boolean;
  config: {
    hasPrivateKey: boolean;
    unknownTokens?: 'accept' | 'reject';
    fcmProjectId?: string;
    clientEmail?: string;
    privateKeyId?: string;
    teamId?: string;
    keyId?: string;
    bundleIds?: string[];
    environment?: 'sandbox' | 'production';
  };
  devices: number;
  urls?: Record<string, string | number | null>;
  createdAt: string;
}

export interface PushDevice {
  id: string;
  platform: PushPlatform;
  token: string;
  appId: string | null;
  name: string;
  state: 'active' | 'unregistered';
  unregisteredAt: string | null;
  topics: string[];
  badge: number | null;
  auto: boolean;
  lastPushAt: string | null;
  createdAt: string;
  user: { id: string; name: string } | null;
  instance: { id: string; slug: string; preset: PushPreset } | null;
  run: string | null;
}

export interface PushLint {
  check: string;
  severity: 'error' | 'warn' | 'info';
  message: string;
}

export interface PushNotification {
  id: string;
  provider: PushPreset;
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
  expiresAt: string | null;
  status: PushStatus;
  errorCode: string | null;
  providerMessageId: string | null;
  logId: string | null;
  headers?: Record<string, string>;
  raw?: unknown;
  lint: PushLint[];
  openedAt: string | null;
  createdAt: string;
  user: { id: string; name: string } | null;
  device: { id: string; name: string; platform: PushPlatform; token: string } | null;
  instance: { id: string; slug: string; preset: PushPreset } | null;
  run: string | null;
  tap: { kind: string; value: string } | null;
}

export interface PushRule {
  id: string;
  fault: string;
  match: { token?: string; user?: string; topic?: string };
  remaining: number | null;
  hits: number;
  run: string | null;
  instance: string | null;
  userName: string | null;
  createdAt: string;
}

export interface PushOverview {
  instances: PushInstance[];
  devices: number;
  faults: number;
  unread: Record<string, number>;
  apnsPort: number | null;
}

export interface PushReference {
  faults: { fault: string; fcm: string; apns: string }[];
  limits: Record<string, number>;
  lint: { id: string; severity: string; title: string }[];
  apnsPort: number | null;
  apnsTransport: string;
}

export interface PushConnect {
  preset: PushPreset;
  urls: Record<string, string | number | null>;
  env: Record<string, string>;
  snippets: { title: string; code: string }[];
  serviceAccountUrl?: string;
  keyUrl?: string;
  caUrl?: string;
  teamId?: string;
  keyId?: string;
  bundleIds?: string[];
}

export interface NotificationQuery {
  user?: string;
  device?: string;
  provider?: string;
  status?: string;
  contains?: string;
  run?: string;
  limit?: number;
}

export const STATUS_KIND: Record<PushStatus, string> = {
  delivered: 'ok',
  collapsed: '',
  dropped: 'warn',
  rejected: 'bad',
  validated: 'accent',
  no_subscribers: 'warn',
};

export const pushApi = {
  createInstance: (slug: string, b: { preset: PushPreset; name?: string; slug?: string; config?: Record<string, unknown> }) => api.post<PushInstance>(`${pushBase(slug)}/instances`, b),
  updateInstance: (slug: string, id: string, b: Record<string, unknown>) => api.patch<PushInstance>(`${pushBase(slug)}/instances/${encodeURIComponent(id)}`, b),
  deleteInstance: (slug: string, id: string) => api.del(`${pushBase(slug)}/instances/${encodeURIComponent(id)}`),
  rotateKey: (slug: string, id: string) => api.post<PushInstance>(`${pushBase(slug)}/instances/${encodeURIComponent(id)}/rotate-key`),
  notifications: (slug: string, q: NotificationQuery) => api.get<PushNotification[]>(`${pushBase(slug)}/notifications${qs({ ...q })}`),
  notification: (slug: string, id: string) => api.get<PushNotification>(`${pushBase(slug)}/notifications/${encodeURIComponent(id)}`),
  open: (slug: string, id: string) => api.post<{ id: string; openedAt: string; tap: PushNotification['tap'] }>(`${pushBase(slug)}/notifications/${encodeURIComponent(id)}/open`),
  clear: (slug: string, user?: string) => api.del<{ deleted: number }>(`${pushBase(slug)}/notifications${qs({ user })}`),
  addDevice: (slug: string, b: { user?: string; platform: PushPlatform; instance?: string; name?: string; topics?: string[]; token?: string }) => api.post<PushDevice>(`${pushBase(slug)}/devices`, b),
  setRegistered: (slug: string, id: string, on: boolean) => api.post<PushDevice>(`${pushBase(slug)}/devices/${encodeURIComponent(id)}/${on ? 'register' : 'unregister'}`),
  topics: (slug: string, id: string, add: string[], remove: string[]) => api.post<PushDevice>(`${pushBase(slug)}/devices/${encodeURIComponent(id)}/topics`, { add, remove }),
  deleteDevice: (slug: string, id: string) => api.del(`${pushBase(slug)}/devices/${encodeURIComponent(id)}`),
  addFault: (slug: string, b: { fault: string; user?: string; token?: string; topic?: string; instance?: string; times?: number }) => api.post<PushRule>(`${pushBase(slug)}/faults`, b),
  deleteFault: (slug: string, id: string) => api.del(`${pushBase(slug)}/faults/${encodeURIComponent(id)}`),
  clearFaults: (slug: string) => api.del<{ deleted: number }>(`${pushBase(slug)}/faults`),
};

/** "a, b c" → ["a", "b", "c"] */
export const splitList = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
