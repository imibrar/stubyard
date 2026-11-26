/** Types and helpers of the Nafath API (/api/projects/:slug/nafath/…, data plane /nafath/<project>/<instance>/…). */
import { api, qs, type Snippet } from './api';

export type NafathStatus = 'WAITING' | 'COMPLETED' | 'REJECTED' | 'EXPIRED';
export const NAFATH_STATUSES: readonly NafathStatus[] = ['WAITING', 'COMPLETED', 'REJECTED', 'EXPIRED'];
export type AutoDecision = 'none' | 'approve' | 'reject' | 'wrong_number' | 'expire';
export const AUTO_DECISIONS: readonly AutoDecision[] = ['none', 'approve', 'reject', 'wrong_number', 'expire'];
export const AUTO_DECISION_LABEL: Record<AutoDecision, string> = {
  none: 'None (a person decides)',
  approve: 'Approve',
  reject: 'Reject',
  wrong_number: 'Pick a wrong number',
  expire: 'Let it expire',
};

export const nafathBase = (slug: string) => `/api/projects/${encodeURIComponent(slug)}/nafath`;
const inst = (slug: string, id: string) => `${nafathBase(slug)}/instances/${encodeURIComponent(id)}`;
const req = (slug: string, id: string) => `${nafathBase(slug)}/requests/${encodeURIComponent(id)}`;

/** NafathConfig in server/src/nafath/types.ts. */
export interface NafathConfig {
  callbackUrl: string | null;
  ttlSeconds: number;
  autoDecision: AutoDecision;
  autoDelayMs: number;
  services: string[];
  callbackFields: 'default' | 'compat';
  callbackOnExpired: boolean;
  wrongNumberCooldownSeconds: number;
  statusLagMs: number;
}
/** NAFATH_DEFAULTS in server/src/nafath/types.ts. */
export const NAFATH_DEFAULTS: NafathConfig = {
  callbackUrl: null,
  ttlSeconds: 200,
  autoDecision: 'none',
  autoDelayMs: 3000,
  services: [],
  callbackFields: 'default',
  callbackOnExpired: false,
  wrongNumberCooldownSeconds: 0,
  statusLagMs: 0,
};

export interface NafathUrls {
  base: string;
  request: string;
  status: string;
  info: string;
  jwk: string;
  sandboxBase: string;
  stagingBase: string;
}

/** A signing key as the API shows it (the private key is never sent). */
export interface NafathKeyView {
  kid: string;
  publicJwk: Record<string, unknown>;
  status: 'active' | 'retired';
  createdAt: string;
}

export interface NafathInstance {
  id: string;
  projectId: string;
  slug: string;
  name: string;
  preset: 'nafath';
  appId: string;
  /** Only in the create / update answers; read it from GET …/connect (project.providers). */
  appKey?: string;
  config: NafathConfig;
  keys: NafathKeyView[];
  strict: boolean;
  enabled: boolean;
  createdAt: string;
  urls: NafathUrls;
}

export interface NafathCallbackAttempt {
  at: string;
  url: string;
  status: number | null;
  error?: string | null;
  duplicate?: boolean;
}

export interface NafathRequest {
  id: string;
  projectId: string;
  instanceId: string;
  testUserId: string | null;
  runId: string | null;
  transId: string;
  random: string;
  choices: string[];
  nationalId: string;
  service: string | null;
  locale: string | null;
  requestId: string | null;
  status: NafathStatus;
  reason: string | null;
  decidedBy: string | null;
  chosen: string | null;
  token: string | null;
  callback: NafathCallbackAttempt[];
  logId: string | null;
  polls: number;
  createdAt: string;
  expiresAt: string;
  /** Seconds left on the project's auth clock when the server answered (WAITING only, else null). */
  expiresInSeconds?: number | null;
  decidedAt: string | null;
}

export interface NafathRule {
  id: string;
  projectId: string;
  runId: string | null;
  instanceId: string | null;
  match: { user?: string; nationalId?: string; service?: string };
  fault: string;
  remaining: number | null;
  hits: number;
  createdAt: string;
}

export interface NafathOverview {
  instances: NafathInstance[];
  waiting: number;
  faults: number;
  reference: {
    faults: { fault: string; stage: string; effect: string }[];
    faultKinds: string[];
    statuses: NafathStatus[];
    errors: Record<string, { status: number; code: string; message: string }>;
    autoDecisions: AutoDecision[];
  };
}

export interface NafathConnect {
  instance: string;
  appId: string;
  appKey: string;
  urls: NafathUrls;
  env: Record<string, string>;
  dotenv: string;
  hosts: { id: string; label: string; baseUrl: string }[];
  hostMode: { hosts: string[]; hostsEntry: string; caUrl: string };
  callbackUrl: string | null;
  snippets: Snippet[];
}

export interface NafathCallbackResult {
  ok: boolean;
  status: number | null;
  error: string | null;
  attempt: number;
  logId: string | null;
  retry: unknown;
  skipped?: string;
}

export interface NafathInstanceInput {
  name?: string;
  slug?: string;
  appId?: string;
  appKey?: string;
  strict?: boolean;
  enabled?: boolean;
  config?: Partial<NafathConfig>;
}

export interface NafathFaultInput {
  fault: string;
  instance?: string;
  user?: string;
  nationalId?: string;
  service?: string;
  times?: number;
  run?: string;
}

export interface NafathRequestQuery {
  user?: string;
  status?: string;
  instance?: string;
  nationalId?: string;
  limit?: number;
  run?: string;
}

export const nafathApi = {
  overview: (slug: string) => api.get<NafathOverview>(nafathBase(slug)),

  instances: (slug: string) => api.get<NafathInstance[]>(`${nafathBase(slug)}/instances`),
  instance: (slug: string, id: string) => api.get<NafathInstance>(inst(slug, id)),
  createInstance: (slug: string, b: NafathInstanceInput) => api.post<NafathInstance>(`${nafathBase(slug)}/instances`, b),
  updateInstance: (slug: string, id: string, b: NafathInstanceInput) => api.patch<NafathInstance>(inst(slug, id), b),
  deleteInstance: (slug: string, id: string) => api.del(inst(slug, id)),
  connect: (slug: string, id: string) => api.get<NafathConnect>(`${inst(slug, id)}/connect`),
  rotateKeys: (slug: string, id: string, dropOld = false) => api.post<NafathInstance>(`${inst(slug, id)}/keys/rotate`, { dropOld }),

  requests: (slug: string, q: NafathRequestQuery = {}) => api.get<NafathRequest[]>(`${nafathBase(slug)}/requests${qs({ ...q })}`),
  request: (slug: string, id: string) => api.get<NafathRequest>(req(slug, id)),
  startRequest: (slug: string, b: { user: string; instance?: string; service?: string; run?: string }) => api.post<NafathRequest & { warnings: string[] }>(`${nafathBase(slug)}/requests`, b),
  resetRequests: (slug: string, q: { user?: string; run?: string } = {}) => api.del<{ deleted: number; schedulesCancelled: number }>(`${nafathBase(slug)}/requests${qs({ ...q })}`),
  approve: (slug: string, id: string) => api.post<NafathRequest>(`${req(slug, id)}/approve`),
  reject: (slug: string, id: string) => api.post<NafathRequest>(`${req(slug, id)}/reject`),
  choose: (slug: string, id: string, number: string) => api.post<NafathRequest>(`${req(slug, id)}/choose`, { number }),
  resendCallback: (slug: string, id: string) => api.post<NafathCallbackResult>(`${req(slug, id)}/callback/resend`),

  faults: (slug: string, run?: string) => api.get<NafathRule[]>(`${nafathBase(slug)}/faults${qs({ run })}`),
  addFault: (slug: string, b: NafathFaultInput) => api.post<NafathRule | { cleared: true }>(`${nafathBase(slug)}/faults`, b),
  deleteFault: (slug: string, id: string) => api.del(`${nafathBase(slug)}/faults/${encodeURIComponent(id)}`),
  clearFaults: (slug: string, q: { user?: string; run?: string } = {}) => api.del<{ deleted: number }>(`${nafathBase(slug)}/faults${qs({ ...q })}`),
};
