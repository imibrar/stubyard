import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from 'pino';
import type { Hub } from '../hub.js';
import { importProject } from './export.js';

export interface SeedResult {
  file: string;
  slug: string | null;
  status: 'created' | 'skipped' | 'failed';
  message?: string;
  imported?: Record<string, number>;
  warnings?: string[];
}

/** The .json files of STUBYARD_SEED: one file, or every *.json in a directory (sorted by name). */
export function seedFiles(seedPath: string): string[] {
  const st = fs.statSync(seedPath);
  if (!st.isDirectory()) return [seedPath];
  return fs
    .readdirSync(seedPath)
    .filter((f) => f.toLowerCase().endsWith('.json'))
    .sort()
    .map((f) => path.join(seedPath, f));
}

/**
 * Import project exports at boot (STUBYARD_SEED). A project whose slug already exists is left alone, so the seed is
 * safe to keep mounted: it only fills an empty / fresh stubyard. A file may hold one export or an array of exports.
 */
export function seedProjects(hub: Hub, seedPath: string, log?: Pick<Logger, 'info' | 'warn' | 'error'>): SeedResult[] {
  const results: SeedResult[] = [];
  let files: string[];
  try {
    files = seedFiles(seedPath);
  } catch (err) {
    log?.error({ seed: seedPath, err: (err as Error).message }, 'STUBYARD_SEED: cannot read seed path');
    return [{ file: seedPath, slug: null, status: 'failed', message: (err as Error).message }];
  }
  for (const file of files) {
    let docs: unknown[];
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      docs = Array.isArray(parsed) ? parsed : [parsed];
    } catch (err) {
      results.push({ file, slug: null, status: 'failed', message: `not valid JSON: ${(err as Error).message}` });
      continue;
    }
    for (const doc of docs) {
      const slug = String((doc as { project?: { slug?: unknown } })?.project?.slug ?? '').trim().toLowerCase() || null;
      if (slug && hub.projects.getBySlug(slug)) {
        results.push({ file, slug, status: 'skipped', message: 'project already exists' });
        continue;
      }
      try {
        const r = importProject(hub, doc, { mode: 'create' });
        hub.bus.publish({ type: 'project.created', projectId: r.project.id, data: r.project });
        results.push({ file, slug: r.project.slug, status: 'created', imported: r.imported, warnings: r.warnings });
      } catch (err) {
        results.push({ file, slug, status: 'failed', message: (err as Error).message });
      }
    }
  }
  for (const r of results) {
    const line = { seed: path.basename(r.file), project: r.slug, ...(r.imported ? { imported: r.imported } : {}), ...(r.message ? { reason: r.message } : {}) };
    if (r.status === 'failed') log?.error(line, 'STUBYARD_SEED: import failed');
    else log?.info(line, r.status === 'created' ? 'STUBYARD_SEED: project created' : 'STUBYARD_SEED: project exists, skipped');
  }
  return results;
}
