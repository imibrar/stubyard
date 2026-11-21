import type { Hub } from '../hub.js';
import { registerExportSection, type ImportContext } from '../maintenance/export.js';
import { MASK, maskEntries } from './bundle.js';
import { DataSet, LoginRecipe, Storyboard } from './schema.js';
import { dataSetContent, recipeContent, storyboardContent, type StoryboardServiceImpl } from './service.js';
import { assignStepIds } from './validate.js';

/**
 * Project export / import of storyboards (docs/design/storyboards.md §8): login recipes, data sets (secret-looking
 * literal values masked without ?secrets=1) and storyboards, right after the users. Walkthroughs and page snapshots are
 * not exported. On import an existing role / slug is skipped with a warning, as personas do.
 */
let registered = false;

const svcOf = (hub: Hub): StoryboardServiceImpl => {
  if (!hub.storyboards) throw new Error('storyboards service missing');
  return hub.storyboards as StoryboardServiceImpl;
};

const label = (r: Record<string, unknown>, k: string) => String(r[k] ?? '?');
const firstIssue = (e: { issues: { path: PropertyKey[]; message: string }[] }) => {
  const i = e.issues[0];
  return `${i.path.map(String).join('.') || 'value'}: ${i.message}`;
};

export function registerStoryboardExport(): void {
  if (registered) return;
  registered = true;

  registerExportSection(
    {
      key: 'loginRecipes',
      table: 'login_recipes',
      export: ({ hub, project }) => svcOf(hub).repo.listRecipes(project.id).map(recipeContent),
      import: (ctx, rows) => {
        const svc = svcOf(ctx.hub);
        let n = 0;
        for (const r of rows) {
          const p = LoginRecipe.safeParse(r);
          if (!p.success) {
            ctx.warnings.push(`Login recipe "${label(r, 'role')}" skipped: ${firstIssue(p.error)}`);
            continue;
          }
          if (svc.repo.getRecipe(ctx.project.id, p.data.role)) {
            ctx.warnings.push(`Login recipe "${p.data.role}" skipped: it exists`);
            continue;
          }
          svc.repo.saveRecipe(ctx.project.id, p.data);
          n++;
        }
        if (n) svc.changed(ctx.project.id, { kind: 'loginRecipe', imported: n });
        return n;
      },
    },
    { after: 'users' },
  );

  registerExportSection(
    {
      key: 'dataSets',
      table: 'data_sets',
      export: ({ hub, project, includeSecrets }) =>
        svcOf(hub)
          .repo.listDataSets(project.id)
          .map((d) => {
            const c = dataSetContent(d);
            return includeSecrets ? c : { ...c, entries: maskEntries(c.entries) };
          }),
      import: (ctx: ImportContext, rows) => {
        const svc = svcOf(ctx.hub);
        let n = 0;
        for (const r of rows) {
          const p = DataSet.safeParse(r);
          if (!p.success) {
            ctx.warnings.push(`Data set "${label(r, 'slug')}" skipped: ${firstIssue(p.error)}`);
            continue;
          }
          if (svc.repo.getDataSet(ctx.project.id, p.data.slug)) {
            ctx.warnings.push(`Data set "${p.data.slug}" skipped: it exists`);
            continue;
          }
          const masked = p.data.entries.filter((e) => e.value === MASK || (Array.isArray(e.value) && e.value.includes(MASK))).map((e) => e.key);
          if (masked.length) ctx.warnings.push(`Data set "${p.data.slug}": masked values ("${MASK}") for ${masked.join(', ')}; export with secrets or re-enter them`);
          svc.repo.saveDataSet(ctx.project.id, p.data);
          n++;
        }
        if (n) svc.changed(ctx.project.id, { kind: 'dataSet', imported: n });
        return n;
      },
    },
    { after: 'loginRecipes' },
  );

  registerExportSection(
    {
      key: 'storyboards',
      table: 'storyboards',
      export: ({ hub, project }) => svcOf(hub).repo.listStoryboards(project.id).map(storyboardContent),
      import: (ctx, rows) => {
        const svc = svcOf(ctx.hub);
        let n = 0;
        for (const r of rows) {
          const p = Storyboard.safeParse(r);
          if (!p.success) {
            ctx.warnings.push(`Storyboard "${label(r, 'slug')}" skipped: ${firstIssue(p.error)}`);
            continue;
          }
          if (svc.repo.getStoryboard(ctx.project.id, p.data.slug)) {
            ctx.warnings.push(`Storyboard "${p.data.slug}" skipped: it exists`);
            continue;
          }
          // References are not checked here: a storyboard whose recipe or user is missing shows that in its warnings.
          svc.saveStoryboard(ctx.project, { ...p.data, steps: assignStepIds(p.data.steps) });
          n++;
        }
        if (n) svc.changed(ctx.project.id, { kind: 'storyboard', imported: n });
        return n;
      },
    },
    { after: 'dataSets' },
  );
}
