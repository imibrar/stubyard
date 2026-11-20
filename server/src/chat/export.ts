import { registerExportSection } from '../maintenance/export.js';
import { normalizeExpectations } from './expectations.js';

/**
 * Export / import of chat agents and their saved prompts. Conversations are captured data and are not exported;
 * AI providers are global (System page) and never exported (they hold keys). Agents refer to providers by name.
 */
let registered = false;

export function registerChatExport(): void {
  if (registered) return;
  registered = true;

  registerExportSection({
    key: 'chatAgents',
    table: 'chat_agents',
    export: ({ hub, project }) =>
      hub.chat.repo.listAgents(project.id).map((a) => ({
        id: a.id,
        slug: a.slug,
        name: a.name,
        provider: a.provider,
        model: a.model,
        instructions: a.instructions,
        tools: a.tools,
        maxSteps: a.maxSteps,
        maxOutputTokens: a.maxOutputTokens,
        temperature: a.temperature,
      })),
    import: (ctx, rows) => {
      let n = 0;
      for (const r of rows) {
        const slug = String(r.slug ?? '');
        if (slug && ctx.hub.chat.repo.getAgent(ctx.project.id, slug)) {
          ctx.warnings.push(`Chat agent "${slug}" exists already; skipped`);
          continue;
        }
        try {
          const a = ctx.hub.chat.repo.createAgent(ctx.project.id, r);
          if (r.id) ctx.ids.set('chatAgents', String(r.id), a.id);
          if (!ctx.hub.chat.providers.get(a.provider, { includeMock: true })) ctx.warnings.push(`Chat agent "${a.slug}": AI provider "${a.provider}" does not exist here; add it under System → AI providers`);
          n++;
        } catch (err) {
          ctx.warnings.push(`Chat agent "${slug || String(r.name ?? '')}" skipped: ${(err as Error).message}`);
        }
      }
      return n;
    },
  });

  registerExportSection({
    key: 'chatPrompts',
    clear: () => undefined, // cascades from chat_agents
    export: ({ hub, project }) =>
      hub.chat.repo.listPrompts(project.id).map((p) => {
        const agent = hub.chat.repo.getAgent(project.id, p.agentId);
        return { agentId: p.agentId, agent: agent?.slug ?? null, name: p.name, prompt: p.prompt, expectations: p.expectations, sort: p.sort };
      }),
    import: (ctx, rows) => {
      let n = 0;
      for (const r of rows) {
        const aid = ctx.ids.get('chatAgents', r.agentId as string);
        const agent = aid ? ctx.hub.chat.repo.getAgent(ctx.project.id, aid) : r.agent ? ctx.hub.chat.repo.getAgent(ctx.project.id, String(r.agent)) : null;
        if (!agent) {
          ctx.warnings.push(`Saved chat prompt "${String(r.name ?? '')}" skipped: its agent is missing`);
          continue;
        }
        try {
          ctx.hub.chat.repo.createPrompt(ctx.project.id, agent.id, { name: r.name, prompt: r.prompt, expectations: normalizeExpectations(r.expectations), sort: r.sort });
          n++;
        } catch (err) {
          ctx.warnings.push(`Saved chat prompt "${String(r.name ?? '')}" skipped: ${(err as Error).message}`);
        }
      }
      return n;
    },
  });
}
