/** Types and helpers of the scripted auto-replies API (/api/projects/:slug/auto-replies/…). */
import { api, qs, type Channel } from './api';

export type ArChannel = Channel | 'any';
export type FireStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled' | 'skipped';
export const FIRE_STATUSES: FireStatus[] = ['pending', 'sent', 'failed', 'cancelled', 'skipped'];

export interface ArText {
  equals?: string;
  contains?: string;
  regex?: string;
}

export interface ArMatch {
  to?: ArText;
  from?: ArText;
  subject?: ArText;
  body?: ArText;
  user?: string;
  role?: string;
  instance?: string;
  hasOtp?: boolean;
  hasLink?: boolean;
}

export interface ArReply {
  text: string;
  subject?: string;
  html?: string;
  channel?: Channel;
  instance?: string;
  button?: string;
  thread?: boolean;
}

export interface ArRuleInput {
  name?: string;
  channel?: ArChannel;
  match?: ArMatch;
  reply?: ArReply;
  delayMs?: number;
  jitterMs?: number;
  maxUses?: number | null;
  uses?: number;
  stop?: boolean;
  enabled?: boolean;
  position?: number;
}

export interface ArRule extends Required<Omit<ArRuleInput, 'position' | 'uses'>> {
  id: string;
  runId: string | null;
  run: string | null;
  runStatus: 'active' | 'stopped' | null;
  position: number;
  uses: number;
  maxUses: number | null;
  disabledReason: string | null;
  summary: string;
  usedUp: boolean;
  pendingFires: number;
  lastFire: { id: string; status: FireStatus; createdAt: string; firedAt: string | null; error: string | null } | null;
  warnings: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ReplyPlan {
  channel: Channel;
  text: string;
  subject?: string | null;
  html?: string | null;
  instance?: string | null;
  button?: string | null;
  contextMessageId?: string | null;
  inReplyTo?: string | null;
  to?: string | null;
}

export interface BriefMessage {
  id: string;
  channel: Channel;
  subject: string | null;
  text: string;
  status: string;
  createdAt: string;
}

export interface ArFire {
  id: string;
  ruleId: string;
  ruleName: string | null;
  runId: string | null;
  run: string | null;
  triggerMessageId: string;
  testUserId: string | null;
  user: { id: string; name: string } | null;
  jobId: string | null;
  status: FireStatus;
  dueAt: string;
  firedAt: string | null;
  plan: { captures: Record<string, string>; rendered?: ReplyPlan; warnings: string[] };
  replyMessageId: string | null;
  webhookStatus: number | null;
  webhookOk: boolean | null;
  error: string | null;
  trigger: BriefMessage | null;
  reply: BriefMessage | null;
  createdAt: string;
}

export interface ArTestResult {
  matched: boolean;
  reasons: string[];
  notes: string[];
  captures: Record<string, string>;
  plan: ReplyPlan | null;
  warnings: string[];
  message: { id: string | null; channel: Channel; to: string; from: string | null; subject: string | null; user: string | null };
}

export interface ArPreset {
  id: string;
  name: string;
  description: string;
  rule: ArRuleInput;
}

export interface ArReference {
  presets: ArPreset[];
  variables: { name: string; help: string }[];
  triggerStatuses: string[];
  loopGuard: { fires: number; windowSeconds: number };
}

export const arBase = (slug: string) => `/api/projects/${encodeURIComponent(slug)}/auto-replies`;

export const arApi = {
  list: (slug: string) => api.get<ArRule[]>(arBase(slug)),
  create: (slug: string, b: ArRuleInput, run?: string | null) => api.post<ArRule>(`${arBase(slug)}${qs({ run })}`, b),
  update: (slug: string, id: string, b: ArRuleInput) => api.patch<ArRule>(`${arBase(slug)}/${encodeURIComponent(id)}`, b),
  remove: (slug: string, id: string) => api.del<void>(`${arBase(slug)}/${encodeURIComponent(id)}`),
  reorder: (slug: string, ids: string[], run?: string | null) => api.post<ArRule[]>(`${arBase(slug)}/reorder${qs({ run })}`, { ids }),
  test: (slug: string, rule: ArRuleInput | string, message: string | Record<string, unknown>) => api.post<ArTestResult>(`${arBase(slug)}/test`, { rule, message }),
  fires: (slug: string, q: { rule?: string; status?: string; limit?: number } = {}) => api.get<ArFire[]>(`${arBase(slug)}/fires${qs(q)}`),
  cancel: (slug: string, id: string) => api.del<ArFire>(`${arBase(slug)}/fires/${encodeURIComponent(id)}`),
  flush: (slug: string) => api.post<{ fired: ArFire[] }>(`${arBase(slug)}/flush`, {}),
};

export const FIRE_KIND: Record<FireStatus, string> = { pending: 'accent', sending: 'accent', sent: 'ok', failed: 'bad', cancelled: '', skipped: 'warn' };

export function fmtDelay(ms: number, jitter = 0): string {
  const f = (x: number) => (x >= 3_600_000 ? `${+(x / 3_600_000).toFixed(1)} h` : x >= 60_000 ? `${+(x / 60_000).toFixed(1)} min` : x >= 1000 ? `${+(x / 1000).toFixed(1)} s` : `${x} ms`);
  if (!ms && !jitter) return 'right away';
  return `after ${f(ms)}${jitter ? ` (+0–${f(jitter)})` : ''}`;
}

export function replySummary(r: ArReply): string {
  const parts: string[] = [];
  if (r.channel) parts.push(`[${r.channel}]`);
  if (r.button) parts.push(`tap "${r.button}"`);
  if (r.subject) parts.push(`"${r.subject}"`);
  if (r.text) parts.push(r.text.length > 120 ? `${r.text.slice(0, 117)}…` : r.text);
  else if (r.html) parts.push('(HTML)');
  return parts.join(' ');
}
