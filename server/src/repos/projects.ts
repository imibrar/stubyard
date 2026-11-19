import type { DB } from '../db/index.js';
import { HttpError, SLUG_RE, newId, nowIso, parseJson, slugify } from '../util.js';

export interface ProjectSettings {
  /** Regex (string) used to extract an OTP; first capture group (or whole match) is the code. */
  otpRegex?: string;
  /** Prefix used when generating test-user phone numbers, e.g. "+92300". */
  phonePrefix?: string;
  /** Email domain used when generating test users, default "<slug>.test". */
  emailDomain?: string;
  /** Password given to generated test users (shown in the UI for logging in to your app). Default "Password123!". */
  defaultPassword?: string;
  /** Roles offered when adding/generating users, in display order. */
  roles?: string[];
  /** Retention for messages/logs in days (phase 5). */
  retentionDays?: number;
  /** Phase 5: captured data (messages, emails, logs) older than this many days is removed automatically. */
  autoResetDays?: number;
  /** Duplicate-send warning window in seconds (phase 2). */
  duplicateWindowSeconds?: number;
}

export interface Project {
  id: string;
  slug: string;
  name: string;
  description: string;
  settings: ProjectSettings;
  createdAt: string;
  updatedAt: string;
}

interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  settings: string;
  created_at: string;
  updated_at: string;
}

function toProject(r: ProjectRow): Project {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    settings: parseJson<ProjectSettings>(r.settings, {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class ProjectRepo {
  constructor(private db: DB) {}

  list(): Project[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE').all() as ProjectRow[]).map(toProject);
  }

  get(id: string): Project | null {
    const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    return r ? toProject(r) : null;
  }

  getBySlug(slug: string): Project | null {
    const r = this.db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug) as ProjectRow | undefined;
    return r ? toProject(r) : null;
  }

  require(slug: string): Project {
    const p = this.getBySlug(slug);
    if (!p) throw new HttpError(404, `Project "${slug}" not found`);
    return p;
  }

  create(input: { name: string; slug?: string; description?: string; settings?: ProjectSettings }): Project {
    const name = (input.name ?? '').trim();
    if (!name) throw new HttpError(400, 'Project name is required');
    const slug = (input.slug ?? slugify(name)).trim();
    if (!SLUG_RE.test(slug)) {
      throw new HttpError(400, 'Slug must be lowercase letters, digits and dashes (max 48 chars)');
    }
    if (this.getBySlug(slug)) throw new HttpError(409, `A project with slug "${slug}" already exists`);
    const now = nowIso();
    const id = newId();
    this.db
      .prepare('INSERT INTO projects (id, slug, name, description, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, slug, name, input.description ?? '', JSON.stringify(input.settings ?? {}), now, now);
    return this.get(id)!;
  }

  update(slug: string, patch: { name?: string; description?: string; settings?: ProjectSettings }): Project {
    const p = this.require(slug);
    const name = patch.name !== undefined ? patch.name.trim() : p.name;
    if (!name) throw new HttpError(400, 'Project name cannot be empty');
    const settings = patch.settings !== undefined ? { ...p.settings, ...patch.settings } : p.settings;
    if (settings.otpRegex) {
      try {
        new RegExp(settings.otpRegex);
      } catch {
        throw new HttpError(400, 'otpRegex is not a valid regular expression');
      }
    }
    this.db
      .prepare('UPDATE projects SET name = ?, description = ?, settings = ?, updated_at = ? WHERE id = ?')
      .run(name, patch.description ?? p.description, JSON.stringify(settings), nowIso(), p.id);
    return this.get(p.id)!;
  }

  delete(slug: string): Project {
    const p = this.require(slug);
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
    return p;
  }
}
