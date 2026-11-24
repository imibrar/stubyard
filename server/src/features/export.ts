import type { Hub } from '../hub.js';
import { registerExportSection } from '../maintenance/export.js';
import type { ExportedFeature, FeatureService } from './service.js';

/**
 * Project export / import of the features board: one row per feature in board order, with its tasks and subtasks
 * nested and its images as data URLs (?images=0 leaves the images out; the row then says imagesLeftOut). The
 * storyboard link is the storyboard slug, so the section comes after "storyboards". On import every feature gets a
 * new key (F-1, F-2… in file order); "replace" mode empties the board first (images and tasks go with it).
 */
let registered = false;

const svcOf = (hub: Hub): FeatureService => {
  if (!hub.features) throw new Error('features service missing');
  return hub.features;
};

export function registerFeatureExport(): void {
  if (registered) return;
  registered = true;
  registerExportSection(
    {
      key: 'features',
      table: 'features',
      export: ({ hub, project, includeImages }) => svcOf(hub).exportRows(project, { images: includeImages !== false }),
      clear: (ctx) => {
        ctx.hub.db.prepare('DELETE FROM features WHERE project_id = ?').run(ctx.project.id);
        ctx.hub.db.prepare('DELETE FROM feature_counters WHERE project_id = ?').run(ctx.project.id);
      },
      import: (ctx, rows) => {
        const svc = svcOf(ctx.hub);
        let n = 0;
        for (const r of rows) {
          if (!r || typeof r !== 'object' || typeof r.title !== 'string') {
            ctx.warnings.push('A feature without a title was skipped');
            continue;
          }
          try {
            svc.importRow(ctx.project, r as unknown as ExportedFeature, ctx.warnings);
            n++;
          } catch (err) {
            ctx.warnings.push(`Feature "${String(r.title)}" skipped: ${(err as Error).message}`);
          }
        }
        if (n) svc.changed(ctx.project, { kind: 'imported', imported: n });
        return n;
      },
    },
    { after: 'storyboards' },
  );
}
