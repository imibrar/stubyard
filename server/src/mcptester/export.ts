import { registerExportSection } from '../maintenance/export.js';

/**
 * Export / import of MCP tester targets and their saved calls. Header values (Authorization, API keys…) are secrets:
 * without ?secrets=1 only the header names are exported (values empty), like other secrets in the export.
 */
let registered = false;

export function registerMcpTesterExport(): void {
  if (registered) return;
  registered = true;

  registerExportSection({
    key: 'mcpTargets',
    table: 'mcp_targets',
    export: ({ hub, project, includeSecrets }) =>
      hub.mcpTester.repo.listTargets(project.id).map((t) => ({
        id: t.id,
        name: t.name,
        url: t.url,
        transport: t.transport,
        notes: t.notes,
        headers: includeSecrets ? t.headers : Object.fromEntries(Object.keys(t.headers).map((k) => [k, ''])),
        ...(includeSecrets || !Object.keys(t.headers).length ? {} : { headersMasked: true }),
      })),
    import: (ctx, rows) => {
      let n = 0;
      for (const r of rows) {
        const name = String(r.name ?? '');
        if (ctx.hub.mcpTester.repo.getTarget(ctx.project.id, name)) {
          ctx.warnings.push(`MCP target "${name}" exists already; skipped`);
          continue;
        }
        try {
          const t = ctx.hub.mcpTester.repo.createTarget(ctx.project.id, { name, url: r.url, transport: r.transport, headers: r.headers ?? {}, notes: r.notes });
          if (r.id) ctx.ids.set('mcpTargets', String(r.id), t.id);
          if (r.headersMasked) ctx.warnings.push(`MCP target "${name}": header values were not exported; fill them in (MCP tester → target)`);
          n++;
        } catch (err) {
          ctx.warnings.push(`MCP target "${name}" skipped: ${(err as Error).message}`);
        }
      }
      return n;
    },
  });

  registerExportSection({
    key: 'mcpSavedCalls',
    clear: () => undefined, // cascades from mcp_targets
    export: ({ hub, project }) =>
      hub.mcpTester.repo.listTargets(project.id).flatMap((t) =>
        hub.mcpTester.repo.listCalls(t.id).map((c) => ({ target: t.name, targetId: t.id, name: c.name, tool: c.tool, arguments: c.arguments, expect: c.expect, position: c.position })),
      ),
    import: (ctx, rows) => {
      let n = 0;
      for (const r of rows) {
        const tid = ctx.ids.get('mcpTargets', r.targetId as string);
        const t = tid ? ctx.hub.mcpTester.repo.getTarget(ctx.project.id, tid) : ctx.hub.mcpTester.repo.getTarget(ctx.project.id, String(r.target ?? ''));
        if (!t) {
          ctx.warnings.push(`Saved MCP call "${r.name}" skipped: its target is missing`);
          continue;
        }
        ctx.hub.mcpTester.repo.createCall(t, { name: r.name, tool: r.tool, arguments: r.arguments, expect: r.expect, position: r.position });
        n++;
      }
      return n;
    },
  });
}
