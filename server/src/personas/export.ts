import { EXPORT_SECTIONS, registerExportSection } from '../maintenance/export.js';
import { LIMIT_DEFAULTS } from './types.js';

/** Export / import of personas: project-level personas only (no threads, turns or test-run personas). */
let registered = false;

export function registerPersonaExport(): void {
  if (registered) return;
  registered = true;
  // Personas import before the auto-reply rules that refer to them (rules export the persona slug).
  const at = EXPORT_SECTIONS.findIndex((x) => x.key === 'autoReplies');
  const after = at > 0 ? EXPORT_SECTIONS[at - 1].key : undefined;

  registerExportSection(
    {
      key: 'personas',
      table: 'personas',
      export: ({ hub, project }) =>
        hub.personas.repo.list(project.id).map((p) => ({ slug: p.slug, name: p.name, enabled: p.enabled, provider: p.provider, model: p.model, prompt: p.prompt, goals: p.goals, style: p.style, limits: p.limits, fallback: p.fallback, opener: p.opener })),
      clear: (ctx) => {
        ctx.hub.db.prepare('DELETE FROM personas WHERE project_id = ? AND run_id IS NULL').run(ctx.project.id);
      },
      import: (ctx, rows) => {
        let n = 0;
        const svc = ctx.hub.personas;
        for (const r of rows) {
          try {
            const provider = String(r.provider ?? '');
            if (!ctx.hub.chat.providers.get(provider, { includeMock: true })) ctx.warnings.push(`Persona "${String(r.name)}": AI provider "${provider}" does not exist here; add it under System → AI providers`);
            const f = svc.fields(ctx.project, { name: r.name, slug: r.slug, enabled: r.enabled, provider: r.provider, model: r.model, prompt: r.prompt, goals: r.goals, style: r.style, limits: r.limits, fallback: r.fallback, opener: r.opener }, null, { checkProvider: false });
            const existing = f.slug ? svc.repo.get(ctx.project.id, f.slug) : null;
            if (existing) {
              ctx.warnings.push(`Persona "${String(r.name)}" skipped: slug "${f.slug}" exists`);
              continue;
            }
            svc.repo.create(ctx.project.id, null, {
              slug: f.slug ?? String(r.slug ?? 'persona'),
              name: f.name ?? 'Persona',
              enabled: f.enabled ?? true,
              provider: f.provider!,
              model: f.model!,
              prompt: f.prompt ?? '',
              goals: f.goals ?? [],
              style: f.style ?? {},
              limits: f.limits ?? { ...LIMIT_DEFAULTS },
              fallback: f.fallback ?? null,
              opener: f.opener ?? null,
            });
            n++;
          } catch (e) {
            ctx.warnings.push(`Persona "${String(r.name)}" skipped: ${(e as Error).message}`);
          }
        }
        if (n) svc.changed(ctx.project.id, { imported: n });
        return n;
      },
    },
    { after },
  );
}
