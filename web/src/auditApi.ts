/**
 * Audit log (Teams mode, T3): GET /api/audit (instance admins) and GET /api/projects/:slug/audit (project admins, that
 * project only, without client addresses). Newest first, paged by id; ?format=csv downloads the filtered rows.
 */
import { api, qs } from './api';

export interface AuditEntry {
  id: number;
  at: string;
  user: { id: string | null; email: string | null } | null;
  action: string;
  project: string | null;
  target: string | null;
  detail: Record<string, unknown>;
  /** Only in the instance-wide view. */
  ip?: string | null;
}

export interface AuditFilters {
  user?: string;
  project?: string;
  action?: string;
  from?: string;
  to?: string;
  q?: string;
}

const enc = encodeURIComponent;
const base = (slug: string | null) => (slug ? `/api/projects/${enc(slug)}/audit` : '/api/audit');

export const auditApi = {
  page: (slug: string | null, f: AuditFilters, before?: number | null, limit = 100) =>
    api.get<{ entries: AuditEntry[]; nextBefore: number | null }>(base(slug) + qs({ ...f, before: before ?? undefined, limit })),
  actions: async (slug: string | null) => (await api.get<{ actions: string[] }>(`${base(slug)}/actions`)).actions,
  csvUrl: (slug: string | null, f: AuditFilters) => base(slug) + qs({ ...f, format: 'csv' }),
};

/** Readable names of the actions stubyard writes (unknown ones show their id). */
export const AUDIT_ACTIONS: Record<string, string> = {
  'auth.login': 'Signed in',
  'auth.login_failed': 'Sign-in failed',
  'auth.logout': 'Signed out',
  'user.create': 'User created',
  'user.update': 'User renamed',
  'user.role': 'Instance role changed',
  'user.disable': 'User disabled',
  'user.enable': 'User enabled',
  'user.password_reset': 'Password reset',
  'user.password_change': 'Password changed',
  'user.env_admin_replaced': 'Env admin replaced',
  'member.add': 'Member added',
  'member.role': 'Member role changed',
  'member.remove': 'Member removed',
  'token.create': 'API token created',
  'token.revoke': 'API token revoked',
  'invite.create': 'Invite link created',
  'invite.revoke': 'Invite link revoked',
  'invite.accept': 'Invite accepted',
  'project.create': 'Project created',
  'project.import': 'Project imported',
  'project.settings': 'Project settings changed',
  'project.export': 'Project exported',
  'project.reset': 'Project data reset',
  'project.delete': 'Project deleted',
  'system.ai_providers': 'AI providers changed',
  'system.maintenance': 'Clean-up run',
  'system.factory_reset': 'Factory reset',
};

/** Action groups for the filter (prefix filters). */
export const AUDIT_GROUPS: { prefix: string; label: string }[] = [
  { prefix: 'auth.', label: 'Sign-ins' },
  { prefix: 'user.', label: 'Users' },
  { prefix: 'member.', label: 'Members' },
  { prefix: 'token.', label: 'API tokens' },
  { prefix: 'invite.', label: 'Invites' },
  { prefix: 'project.', label: 'Projects' },
  { prefix: 'system.', label: 'System' },
];

export const actionLabel = (a: string) => AUDIT_ACTIONS[a] ?? a;

/** How an action reads at a glance: failures and destructive actions stand out. */
export function actionTone(a: string): 'bad' | 'warn' | 'info' | 'neutral' {
  if (a === 'auth.login_failed' || a === 'project.delete' || a === 'system.factory_reset' || a === 'user.disable') return 'bad';
  if (a === 'project.reset' || a === 'user.password_reset' || a === 'token.revoke' || a === 'member.remove' || a === 'invite.revoke' || a === 'user.env_admin_replaced' || a === 'project.export') return 'warn';
  if (a.startsWith('auth.')) return 'neutral';
  return 'info';
}
