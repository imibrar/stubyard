import type { DB } from '../db/index.js';
import { getPreset, type Channel } from '../providers/catalog.js';
import { HttpError, SLUG_RE, newId, nowIso, parseJson, slugify } from '../util.js';

export interface ProviderInstance {
  id: string;
  projectId: string;
  channel: Channel;
  slug: string;
  name: string;
  preset: string;
  labels: string[];
  isDefault: boolean;
  config: Record<string, unknown>;
  defaultAction: string;
  enabled: boolean;
  createdAt: string;
}

interface Row {
  id: string;
  project_id: string;
  channel: Channel;
  slug: string;
  name: string;
  preset: string;
  labels: string;
  is_default: number;
  config: string;
  default_action: string;
  enabled: number;
  created_at: string;
}

function toInstance(r: Row): ProviderInstance {
  return {
    id: r.id,
    projectId: r.project_id,
    channel: r.channel,
    slug: r.slug,
    name: r.name,
    preset: r.preset,
    labels: parseJson<string[]>(r.labels, []),
    isDefault: r.is_default === 1,
    config: parseJson<Record<string, unknown>>(r.config, {}),
    defaultAction: r.default_action,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
  };
}

export interface ProviderInput {
  preset?: string;
  slug?: string;
  name?: string;
  labels?: string[];
  isDefault?: boolean;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

export class ProviderRepo {
  constructor(private db: DB) {}

  list(projectId: string): ProviderInstance[] {
    return (
      this.db
        .prepare("SELECT * FROM provider_instances WHERE project_id = ? ORDER BY CASE channel WHEN 'email' THEN 0 WHEN 'sms' THEN 1 ELSE 2 END, is_default DESC, created_at")
        .all(projectId) as Row[]
    ).map(toInstance);
  }

  get(projectId: string, slug: string): ProviderInstance | null {
    const r = this.db.prepare('SELECT * FROM provider_instances WHERE project_id = ? AND slug = ?').get(projectId, slug) as Row | undefined;
    return r ? toInstance(r) : null;
  }

  getById(id: string): ProviderInstance | null {
    const r = this.db.prepare('SELECT * FROM provider_instances WHERE id = ?').get(id) as Row | undefined;
    return r ? toInstance(r) : null;
  }

  require(projectId: string, slug: string): ProviderInstance {
    const p = this.get(projectId, slug);
    if (!p) throw new HttpError(404, `Provider instance "${slug}" not found`);
    return p;
  }

  defaultFor(projectId: string, channel: Channel): ProviderInstance | null {
    const r = this.db
      .prepare('SELECT * FROM provider_instances WHERE project_id = ? AND channel = ? ORDER BY is_default DESC, created_at LIMIT 1')
      .get(projectId, channel) as Row | undefined;
    return r ? toInstance(r) : null;
  }

  create(projectId: string, input: ProviderInput): ProviderInstance {
    const preset = getPreset(input.preset ?? '');
    if (!preset) throw new HttpError(400, `Unknown provider preset "${input.preset}"`);
    const name = (input.name ?? preset.name).trim();
    const slug = (input.slug ?? slugify(name)).trim();
    if (!SLUG_RE.test(slug)) throw new HttpError(400, 'Provider slug must be lowercase letters, digits and dashes');
    if (slug === 'api') throw new HttpError(400, 'The slug "api" is reserved for API mocks (/mock/<project>/api/…)');
    if (this.get(projectId, slug)) throw new HttpError(409, `Provider instance "${slug}" already exists in this project`);
    const id = newId();
    const hasDefault = !!this.db
      .prepare('SELECT 1 FROM provider_instances WHERE project_id = ? AND channel = ? AND is_default = 1')
      .get(projectId, preset.channel);
    const makeDefault = input.isDefault ?? !hasDefault;
    this.db.transaction(() => {
      if (makeDefault) {
        this.db.prepare('UPDATE provider_instances SET is_default = 0 WHERE project_id = ? AND channel = ?').run(projectId, preset.channel);
      }
      this.db
        .prepare(
          `INSERT INTO provider_instances (id, project_id, channel, slug, name, preset, labels, is_default, config, enabled, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(id, projectId, preset.channel, slug, name, preset.id, JSON.stringify(normalizeLabels(input.labels)), makeDefault ? 1 : 0, JSON.stringify(cleanContractConfig(input.config ?? {})), input.enabled === false ? 0 : 1, nowIso());
    })();
    return this.getById(id)!;
  }

  update(projectId: string, slug: string, patch: ProviderInput): ProviderInstance {
    const p = this.require(projectId, slug);
    if (patch.preset && patch.preset !== p.preset) {
      const preset = getPreset(patch.preset);
      if (!preset || preset.channel !== p.channel) throw new HttpError(400, 'Preset must exist and belong to the same channel');
    }
    const name = patch.name !== undefined ? patch.name.trim() : p.name;
    if (!name) throw new HttpError(400, 'Provider name cannot be empty');
    this.db.transaction(() => {
      if (patch.isDefault) {
        this.db.prepare('UPDATE provider_instances SET is_default = 0 WHERE project_id = ? AND channel = ?').run(projectId, p.channel);
      }
      this.db
        .prepare('UPDATE provider_instances SET name=?, preset=?, labels=?, is_default=?, config=?, enabled=? WHERE id=?')
        .run(
          name,
          patch.preset ?? p.preset,
          JSON.stringify(patch.labels !== undefined ? normalizeLabels(patch.labels) : p.labels),
          patch.isDefault !== undefined ? (patch.isDefault ? 1 : 0) : p.isDefault ? 1 : 0,
          JSON.stringify(patch.config !== undefined ? cleanContractConfig({ ...p.config, ...patch.config }) : p.config),
          patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : p.enabled ? 1 : 0,
          p.id,
        );
    })();
    return this.getById(p.id)!;
  }

  delete(projectId: string, slug: string): ProviderInstance {
    const p = this.require(projectId, slug);
    this.db.prepare('DELETE FROM provider_instances WHERE id = ?').run(p.id);
    if (p.isDefault) {
      // Promote the oldest remaining instance of the channel to default.
      this.db
        .prepare(
          `UPDATE provider_instances SET is_default = 1 WHERE id = (
             SELECT id FROM provider_instances WHERE project_id = ? AND channel = ? ORDER BY created_at LIMIT 1)`,
        )
        .run(projectId, p.channel);
    }
    return p;
  }
}

function normalizeLabels(labels: string[] | undefined): string[] {
  if (!labels) return [];
  return [...new Set(labels.map((l) => String(l).trim().toLowerCase()).filter(Boolean))].slice(0, 10);
}

/** C1 provider contracts: contractMode is an alias stored as contract, true means strict, null clears (same rules as payments). */
function cleanContractConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out = { ...config };
  if (out.contractMode !== undefined) out.contract = out.contractMode;
  delete out.contractMode;
  if (out.contract === null) delete out.contract;
  if (out.contract !== undefined) {
    if (out.contract === true) out.contract = 'strict';
    if (out.contract !== 'off' && out.contract !== 'report' && out.contract !== 'strict') throw new HttpError(400, 'contract must be "off", "report" or "strict" (true means "strict")');
  }
  return out;
}
