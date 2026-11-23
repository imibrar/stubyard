import type { FastifyRequest } from 'fastify';
import type { Hub } from '../hub.js';
import { HttpError } from '../util.js';
import type { Permission } from './permissions.js';

/**
 * Per-record checks for routes whose project is not in the URL (permission table scope "record": a message, a traffic
 * log) and filters for cross-project lists. In Open mode, and for stubyard's own calls, everything passes.
 */

/** The slug of a project id (null for none / unknown). */
export function slugOfProject(hub: Hub, projectId: string | null | undefined): string | null {
  return projectId ? (hub.projects.get(projectId)?.slug ?? null) : null;
}

/**
 * Throws unless the caller may use `permission` on a record of this project: 404 `notFound` when they cannot see the
 * project at all (or the record has no project and they are not an instance admin), 403 when they see it but their role
 * lacks the permission.
 */
export function requireRecordAccess(hub: Hub, req: FastifyRequest, projectId: string | null | undefined, permission: Permission, notFound: string): void {
  const p = req.principal;
  if (!hub.access.enabled || !p) return;
  const slug = slugOfProject(hub, projectId);
  if (!hub.access.can(p, 'project.view', slug)) throw new HttpError(404, notFound);
  if (!hub.access.can(p, permission, slug)) throw new HttpError(403, `You do not have the "${permission}" permission in project "${slug ?? '(none)'}"`);
}

/** Project ids the caller may see, or null for all (Open mode, instance admins, stubyard itself). */
export function visibleProjectIds(hub: Hub, req: FastifyRequest): string[] | null {
  const slugs = hub.access.visibleSlugs(req.principal);
  if (slugs === null) return null;
  return hub.projects.list().filter((p) => slugs.has(p.slug)).map((p) => p.id);
}

/** Throws 404 (as for an unknown project) unless the caller may see the project. */
export function requireProjectVisible(hub: Hub, req: FastifyRequest, slug: string): void {
  if (!hub.access.sees(req.principal, slug)) throw new HttpError(404, `Project "${slug}" not found`);
}
