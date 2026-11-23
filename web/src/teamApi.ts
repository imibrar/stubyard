/**
 * Teams mode (T2): instance users and invite links (instance admins), project members (project admins; readable by
 * every member). In Open and Single admin modes these routes answer 404 ("Teams mode only").
 */
import { api } from './api';
import type { InstanceRole, ProjectRole } from './auth';

export interface TeamUser {
  id: string;
  email: string;
  name: string;
  role: InstanceRole;
  disabled: boolean;
  mustChangePassword: boolean;
  envAdmin: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  projects: { slug: string; role: ProjectRole }[];
}

export interface TeamInvite {
  id: string;
  email: string | null;
  name: string | null;
  role: InstanceRole;
  /** Project slug. */
  project: string | null;
  projectRole: ProjectRole | null;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  createdBy: string | null;
}

export interface ProjectMember {
  userId: string;
  email: string;
  name: string;
  role: ProjectRole;
  disabled: boolean;
  addedAt: string;
  addedBy: string | null;
}

const enc = encodeURIComponent;

export const teamApi = {
  users: async () => (await api.get<{ users: TeamUser[] }>('/api/team/users')).users,
  createUser: (body: { email: string; name?: string; role?: InstanceRole; password?: string; projects?: { slug: string; role: ProjectRole }[] }) =>
    api.post<{ user: TeamUser; temporaryPassword?: string }>('/api/team/users', body),
  updateUser: async (id: string, body: { name?: string; role?: InstanceRole; disabled?: boolean }) => (await api.patch<{ user: TeamUser }>(`/api/team/users/${enc(id)}`, body)).user,
  resetPassword: (id: string, password?: string) => api.post<{ user: TeamUser; temporaryPassword?: string }>(`/api/team/users/${enc(id)}/reset-password`, password ? { password } : {}),
  invites: async () => (await api.get<{ invites: TeamInvite[] }>('/api/team/invites')).invites,
  createInvite: (body: { email?: string; name?: string; role?: InstanceRole; project?: string; projectRole?: ProjectRole }) =>
    api.post<{ invite: TeamInvite; token: string; path: string }>('/api/team/invites', body),
  revokeInvite: async (id: string) => (await api.del<{ invite: TeamInvite }>(`/api/team/invites/${enc(id)}`)).invite,
};

export const membersApi = {
  list: (slug: string) => api.get<{ members: ProjectMember[]; canManage: boolean }>(`/api/projects/${enc(slug)}/members`),
  candidates: async (slug: string) => (await api.get<{ users: { id: string; email: string; name: string }[] }>(`/api/projects/${enc(slug)}/members/candidates`)).users,
  add: async (slug: string, userId: string, role: ProjectRole) => (await api.post<{ member: ProjectMember }>(`/api/projects/${enc(slug)}/members`, { userId, role })).member,
  setRole: async (slug: string, userId: string, role: ProjectRole) => (await api.patch<{ member: ProjectMember }>(`/api/projects/${enc(slug)}/members/${enc(userId)}`, { role })).member,
  remove: (slug: string, userId: string) => api.del<{ removed: string }>(`/api/projects/${enc(slug)}/members/${enc(userId)}`),
};
