import { registerExportSection } from '../maintenance/export.js';

/** Export / import of auto-reply rules: project-level rules only (no run rules, no fires, uses start at 0). */
let registered = false;

export function registerAutoReplyExport(): void {
  if (registered) return;
  registered = true;

  registerExportSection({
    key: 'autoReplies',
    table: 'auto_reply_rules',
    export: ({ hub, project }) =>
      hub.autoReplies.repo
        .listRules(project.id)
        .map((r) => ({ name: r.name, position: r.position, enabled: r.enabled, channel: r.channel, match: r.match, reply: r.reply, delayMs: r.delayMs, jitterMs: r.jitterMs, maxUses: r.maxUses, stop: r.stop })),
    // Replace mode: only project rules go (run rules belong to live test runs).
    clear: (ctx) => {
      ctx.hub.db.prepare('DELETE FROM auto_reply_rules WHERE project_id = ? AND run_id IS NULL').run(ctx.project.id);
    },
    import: (ctx, rows) => {
      let n = 0;
      for (const r of rows) {
        try {
          ctx.hub.autoReplies.createRule(ctx.project, { name: r.name, position: r.position, enabled: r.enabled, channel: r.channel, match: r.match, reply: r.reply, delayMs: r.delayMs, jitterMs: r.jitterMs, maxUses: r.maxUses, stop: r.stop }, null);
          n++;
        } catch (e) {
          ctx.warnings.push(`Auto-reply "${String(r.name)}" skipped: ${(e as Error).message}`);
        }
      }
      return n;
    },
  });
}
