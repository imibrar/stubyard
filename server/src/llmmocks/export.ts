import { registerExportSection } from '../maintenance/export.js';
import type { LlmSettings } from './repo.js';

/** Export / import of LLM mocks (project-level, not run-scoped) and LLM settings. Calls and recordings are test data. */
let registered = false;

export function registerLlmExport(): void {
  if (registered) return;
  registered = true;

  registerExportSection({
    key: 'llmMocks',
    table: 'llm_mocks',
    export: ({ hub, project }) =>
      hub.llm.repo
        .listMocks(project.id, { all: true })
        .filter((m) => !m.runId)
        .map((m) => ({ name: m.name, position: m.position, enabled: m.enabled, provider: m.provider, match: m.match, responses: m.responses, mode: m.mode, fault: m.fault, times: m.remaining, source: m.source, requestHash: m.requestHash })),
    import: (ctx, rows) => {
      let n = 0;
      for (const r of rows) {
        try {
          const m = ctx.hub.llm.createMock(ctx.project, { name: r.name, position: r.position, enabled: r.enabled, provider: r.provider, match: r.match, responses: r.responses, mode: r.mode, fault: r.fault, times: r.times });
          if (r.source === 'recorded' || r.requestHash) {
            ctx.hub.db.prepare('UPDATE llm_mocks SET source = ?, request_hash = ? WHERE id = ?').run(r.source === 'recorded' ? 'recorded' : 'manual', r.requestHash ? String(r.requestHash) : null, m.id);
          }
          n++;
        } catch (e) {
          ctx.warnings.push(`LLM mock "${String(r.name)}" skipped: ${(e as Error).message}`);
        }
      }
      return n;
    },
  });

  registerExportSection({
    key: 'llmSettings',
    table: 'llm_settings',
    export: ({ hub, project }) => [hub.llm.settings(project.id)],
    import: (ctx, rows) => {
      if (!rows[0]) return 0;
      ctx.hub.llm.updateSettings(ctx.project, rows[0] as Partial<LlmSettings> as Record<string, unknown>);
      return 1;
    },
  });
}
