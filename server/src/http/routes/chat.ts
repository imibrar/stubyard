import type { FastifyInstance } from 'fastify';
import type { Hub } from '../../hub.js';
import { normalizeExpectations } from '../../chat/expectations.js';
import type { InjectFn } from '../../chat/tools.js';
import { HttpError } from '../../util.js';

type P = { slug: string; id: string };
type Q = Record<string, string | undefined>;
type Json = Record<string, unknown>;

const body = (req: { body?: unknown }): Json => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) && !Buffer.isBuffer(req.body) ? (req.body as Json) : {});

/** Provider presets offered by the dashboard (kind + preset + default base URL + env var). */
export const AI_PROVIDER_PRESETS = [
  { id: 'openai', label: 'OpenAI', kind: 'openai', preset: null, baseUrl: 'https://api.openai.com/v1', envVar: 'DEVHUB_OPENAI_API_KEY or OPENAI_API_KEY', needsKey: true, modelHint: 'gpt-5-mini' },
  { id: 'anthropic', label: 'Anthropic', kind: 'anthropic', preset: null, baseUrl: 'https://api.anthropic.com/v1', envVar: 'ANTHROPIC_API_KEY', needsKey: true, modelHint: 'claude-sonnet-4-5' },
  { id: 'google', label: 'Google', kind: 'google', preset: null, baseUrl: 'https://generativelanguage.googleapis.com/v1beta', envVar: 'GOOGLE_GENERATIVE_AI_API_KEY', needsKey: true, modelHint: 'gemini-2.5-flash' },
  { id: 'openrouter', label: 'OpenRouter', kind: 'openai-compatible', preset: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', envVar: 'OPENROUTER_API_KEY', needsKey: true, modelHint: 'openai/gpt-5-mini' },
  { id: 'ollama', label: 'Ollama', kind: 'openai-compatible', preset: 'ollama', baseUrl: 'http://host.docker.internal:11434/v1', envVar: 'DEVHUB_OLLAMA_URL (base URL)', needsKey: false, modelHint: 'llama3.2' },
  { id: 'custom', label: 'OpenAI-compatible (custom)', kind: 'openai-compatible', preset: 'custom', baseUrl: '', envVar: null, needsKey: false, modelHint: '' },
];

/**
 * AI chat v1: /api/system/ai-providers (global, keys write-only) and /api/projects/:slug/chat/… (agents,
 * conversations with a streamed UI-message endpoint, saved prompts with deterministic expectations).
 */
export async function registerChatRoutes(app: FastifyInstance, hub: Hub): Promise<void> {
  const svc = hub.chat;
  if (!svc) return;
  svc.attach(((o) => app.inject({ method: o.method as 'POST', url: o.url, payload: o.payload as object, headers: o.headers })) as InjectFn);
  const proj = (slug: string) => hub.projects.require(slug);
  const prov = svc.providers;

  // ---------------------------------------------------------------- AI providers (global)
  const PB = '/api/system/ai-providers';
  app.get(PB, async () => ({ providers: prov.list().map((p) => prov.view(p)), presets: AI_PROVIDER_PRESETS }));
  app.post(PB, async (req, reply) => {
    const p = prov.create(body(req));
    svc.publish(null, { kind: 'provider' });
    return reply.status(201).send(prov.view(p));
  });
  app.get<{ Params: P }>(`${PB}/:id`, async (req) => prov.view(prov.require(req.params.id)));
  app.patch<{ Params: P }>(`${PB}/:id`, async (req) => {
    const p = prov.update(req.params.id, body(req));
    svc.publish(null, { kind: 'provider' });
    return prov.view(p);
  });
  app.delete<{ Params: P }>(`${PB}/:id`, async (req) => {
    const deleted = prov.delete(req.params.id);
    svc.publish(null, { kind: 'provider' });
    return { deleted };
  });
  app.post<{ Params: P }>(`${PB}/:id/test`, async (req) => svc.testProvider(req.params.id, String(body(req).model ?? '').trim()));
  app.get<{ Params: P }>(`${PB}/:id/models`, async (req) => svc.listModels(req.params.id));

  // ---------------------------------------------------------------- agents
  const B = '/api/projects/:slug/chat';
  app.get<{ Params: P }>(`${B}/builtin-tools`, async () => ({ tools: await svc.builtinCatalog() }));
  app.get<{ Params: P }>(`${B}/agents`, async (req) => svc.repo.listAgents(proj(req.params.slug).id).map((a) => svc.agentView(a)));
  app.post<{ Params: P }>(`${B}/agents`, async (req, reply) => {
    const p = proj(req.params.slug);
    const a = svc.repo.createAgent(p.id, body(req));
    svc.publish(p.id, { agent: a.id, kind: 'agent' });
    return reply.status(201).send(svc.agentView(a));
  });
  app.get<{ Params: P }>(`${B}/agents/:id`, async (req) => svc.agentView(svc.repo.requireAgent(proj(req.params.slug).id, req.params.id)));
  app.patch<{ Params: P }>(`${B}/agents/:id`, async (req) => {
    const p = proj(req.params.slug);
    const a = svc.repo.updateAgent(p.id, req.params.id, body(req));
    svc.publish(p.id, { agent: a.id, kind: 'agent' });
    return svc.agentView(a);
  });
  app.delete<{ Params: P }>(`${B}/agents/:id`, async (req) => {
    const p = proj(req.params.slug);
    const deleted = svc.repo.deleteAgent(p.id, req.params.id);
    svc.publish(p.id, { kind: 'agent' });
    return { deleted };
  });
  /** The tools the agent gets right now (connects to its MCP tester targets), plus per-target errors. */
  app.get<{ Params: P }>(`${B}/agents/:id/tools`, async (req) => {
    const p = proj(req.params.slug);
    const a = svc.repo.requireAgent(p.id, req.params.id);
    const built = await svc.tools(p, a);
    return { agent: a.slug, tools: built.tools.map((t) => ({ ...built.info.find((i) => i.name === t.name)!, inputSchema: t.inputSchema })), errors: built.errors };
  });
  app.post<{ Params: P }>(`${B}/agents/:id/ask`, async (req) => {
    const p = proj(req.params.slug);
    const b = body(req);
    return svc.ask(p, req.params.id, String(b.prompt ?? ''), { conversation: b.conversation ? String(b.conversation) : undefined });
  });

  // ---------------------------------------------------------------- conversations
  app.get<{ Params: P; Querystring: Q }>(`${B}/conversations`, async (req) => {
    const p = proj(req.params.slug);
    const agentId = req.query.agent ? svc.repo.requireAgent(p.id, req.query.agent).id : undefined;
    return svc.repo.listConversations(p.id, { agentId, limit: req.query.limit ? Number(req.query.limit) : undefined }).map((c) => {
      const agent = c.agentId ? svc.repo.getAgent(p.id, c.agentId) : null;
      return { ...c, agent: agent ? { id: agent.id, slug: agent.slug, name: agent.name } : null };
    });
  });
  app.post<{ Params: P }>(`${B}/conversations`, async (req, reply) => {
    const p = proj(req.params.slug);
    const b = body(req);
    const agent = b.agent ? svc.repo.requireAgent(p.id, String(b.agent)) : null;
    const c = svc.repo.createConversation(p.id, agent?.id ?? null, String(b.title ?? ''));
    svc.publish(p.id, { conversation: c.id, kind: 'conversation' });
    return reply.status(201).send(svc.conversationView(c));
  });
  app.get<{ Params: P }>(`${B}/conversations/:id`, async (req) => {
    const p = proj(req.params.slug);
    return svc.conversationView(svc.repo.requireConversation(p.id, req.params.id));
  });
  app.patch<{ Params: P }>(`${B}/conversations/:id`, async (req) => {
    const p = proj(req.params.slug);
    const b = body(req);
    const agentId = b.agent === undefined ? undefined : b.agent === null ? null : svc.repo.requireAgent(p.id, String(b.agent)).id;
    const c = svc.repo.updateConversation(p.id, req.params.id, { title: b.title, agentId });
    svc.publish(p.id, { conversation: c.id, kind: 'conversation' });
    return svc.conversationView(c);
  });
  app.delete<{ Params: P }>(`${B}/conversations/:id`, async (req) => {
    const p = proj(req.params.slug);
    const deleted = svc.repo.deleteConversation(p.id, req.params.id);
    svc.publish(p.id, { kind: 'conversation' });
    return { deleted };
  });

  /**
   * Streamed turn (AI SDK UI message stream, what useChat + DefaultChatTransport read). Body: { message: UIMessage,
   * agent?, trigger? }; only the new message is sent, the history comes from the database. Errors before the stream
   * starts are normal JSON 4xx; once streaming, errors arrive as an "error" chunk.
   */
  app.post<{ Params: P }>(`${B}/conversations/:id/stream`, async (req, reply) => {
    const p = proj(req.params.slug);
    const controller = new AbortController();
    const stream = await svc.prepareStream(p, req.params.id, body(req), controller.signal);
    reply.hijack();
    const res = reply.raw;
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    try {
      await stream.pipeTo(res);
    } catch (err) {
      req.log.warn({ msg: svc.errorText(err) }, 'chat stream failed');
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      if (!res.writableEnded) res.end();
    }
  });

  // ---------------------------------------------------------------- saved prompts
  app.get<{ Params: P; Querystring: Q }>(`${B}/prompts`, async (req) => {
    const p = proj(req.params.slug);
    const agentId = req.query.agent ? svc.repo.requireAgent(p.id, req.query.agent).id : undefined;
    return svc.repo.listPrompts(p.id, agentId);
  });
  app.post<{ Params: P }>(`${B}/prompts`, async (req, reply) => {
    const p = proj(req.params.slug);
    const b = body(req);
    if (!b.agent) throw new HttpError(400, 'agent is required (slug or id)');
    const a = svc.repo.requireAgent(p.id, String(b.agent));
    const sp = svc.repo.createPrompt(p.id, a.id, { name: b.name, prompt: b.prompt, expectations: normalizeExpectations(b.expectations), sort: b.sort });
    svc.publish(p.id, { prompt: sp.id, kind: 'prompt' });
    return reply.status(201).send(sp);
  });
  app.post<{ Params: P }>(`${B}/prompts/run`, async (req) => {
    const p = proj(req.params.slug);
    const b = body(req);
    const ids = Array.isArray(b.ids) ? b.ids.map(String) : undefined;
    return svc.runPrompts(p, { ids, agent: b.agent ? String(b.agent) : undefined });
  });
  app.get<{ Params: P }>(`${B}/prompts/:id`, async (req) => svc.repo.requirePrompt(proj(req.params.slug).id, req.params.id));
  app.patch<{ Params: P }>(`${B}/prompts/:id`, async (req) => {
    const p = proj(req.params.slug);
    const b = body(req);
    const agentId = b.agent ? svc.repo.requireAgent(p.id, String(b.agent)).id : undefined;
    const sp = svc.repo.updatePrompt(p.id, req.params.id, { name: b.name, prompt: b.prompt, expectations: b.expectations === undefined ? undefined : normalizeExpectations(b.expectations), sort: b.sort, agentId });
    svc.publish(p.id, { prompt: sp.id, kind: 'prompt' });
    return sp;
  });
  app.delete<{ Params: P }>(`${B}/prompts/:id`, async (req) => {
    const p = proj(req.params.slug);
    const deleted = svc.repo.deletePrompt(p.id, req.params.id);
    svc.publish(p.id, { kind: 'prompt' });
    return { deleted };
  });
  app.post<{ Params: P }>(`${B}/prompts/:id/run`, async (req) => svc.runPrompt(proj(req.params.slug), req.params.id));
}
