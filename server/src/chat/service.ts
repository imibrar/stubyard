import type { ServerResponse } from 'node:http';
import type { Hub } from '../hub.js';
import type { Project } from '../repos/projects.js';
import { HttpError, newId } from '../util.js';
import { resolveModel, runOnce, streamChat, type ChatModel, type ChatUIMessage, type OnceResult } from './engine.js';
import { evaluateExpectations, type ExpectationResult } from './expectations.js';
import { AiProviderRepo, egressFetch, scrub, type AiProvider, type ResolvedProvider } from './keys.js';
import { ChatRepo, type ChatAgent, type Conversation } from './repo.js';
import { buildTools, builtinCatalog, type BuiltTools, type InjectFn } from './tools.js';

type Json = Record<string, unknown>;

const ONCE_TIMEOUT_MS = 5 * 60_000;
const MAX_PARTS = 200;

interface ModelHandle {
  model: ChatModel;
  provider: AiProvider;
  resolved: ResolvedProvider;
}

/** Chat v1: agents (provider + model + instructions + tool allowlist), streamed conversations, saved prompts. */
export class ChatService {
  readonly repo: ChatRepo;
  readonly providers: AiProviderRepo;
  private inject: InjectFn | null = null;

  constructor(private hub: Hub) {
    this.repo = new ChatRepo(hub.db);
    this.providers = new AiProviderRepo(hub.db);
  }

  /** Routes hand over app.inject so built-in tools can call /mcp in-process. */
  attach(inject: InjectFn): void {
    this.inject = inject;
  }

  private requireInject(): InjectFn {
    if (!this.inject) throw new HttpError(500, 'chat service is not attached to the HTTP app');
    return this.inject;
  }

  publish(projectId: string | null, data: Json): void {
    this.hub.bus.publish({ type: 'chat.changed', projectId, data });
  }

  /** Error → short text, keys and auth headers removed. */
  errorText = (err: unknown): string => {
    const e = err as { message?: string; statusCode?: number };
    const msg = e?.message ? String(e.message) : String(err);
    const status = typeof e?.statusCode === 'number' ? ` (HTTP ${e.statusCode})` : '';
    return scrub(`${msg}${status}`, this.providers.secrets()).slice(0, 2000);
  };

  // ------------------------------------------------------------------ providers / models

  /** The model of an agent; 400 with a helpful message when the provider can't be used. */
  modelFor(providerRef: string, modelId: string): ModelHandle {
    const provider = this.providers.get(providerRef);
    if (!provider) throw new HttpError(400, `AI provider "${providerRef}" not found. Add it under System → AI providers${providerRef.startsWith('env:') ? ' or set its environment variable' : ''}.`);
    if (!provider.enabled) throw new HttpError(400, `AI provider "${provider.name}" is disabled`);
    const resolved = this.providers.resolve(provider);
    const needsKey = !(resolved.kind === 'openai-compatible' && resolved.preset !== 'openrouter');
    if (needsKey && !resolved.apiKey) throw new HttpError(400, `AI provider "${provider.name}" has no API key (add one under System → AI providers or set its environment variable)`);
    const model = resolveModel(resolved, modelId, egressFetch({ name: provider.name, baseUrl: resolved.baseUrl }));
    return { model, provider, resolved };
  }

  providerStatus(agent: ChatAgent): { ok: boolean; error: string | null } {
    try {
      this.modelFor(agent.provider, agent.model);
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async testProvider(ref: string, modelId: string): Promise<Json> {
    if (!modelId) throw new HttpError(400, 'model is required, e.g. {"model":"gpt-5-mini"}');
    const p = this.providers.require(ref);
    const h = this.modelFor(p.id, modelId);
    try {
      const r = await runOnce({
        model: h.model,
        messages: [{ id: 'test', role: 'user', parts: [{ type: 'text', text: 'Reply with the single word OK.' }] }],
        tools: [],
        maxSteps: 1,
        maxOutputTokens: 64,
        abortSignal: AbortSignal.timeout(60_000),
        errorText: this.errorText,
      });
      return { ok: true, provider: p.name, model: modelId, text: r.text.slice(0, 200), usage: r.usage, finishReason: r.finishReason, durationMs: r.durationMs };
    } catch (err) {
      return { ok: false, provider: p.name, model: modelId, error: this.errorText(err) };
    }
  }

  /** Model ids from the provider's model list endpoint. */
  async listModels(ref: string): Promise<{ provider: string; models: { id: string; name?: string }[] }> {
    const p = this.providers.require(ref);
    const r = this.providers.resolve(p);
    const f = egressFetch({ name: p.name, baseUrl: r.baseUrl });
    const headers: Record<string, string> = { ...r.headers, accept: 'application/json' };
    if (r.kind === 'anthropic') {
      if (r.apiKey) headers['x-api-key'] = r.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else if (r.kind === 'google') {
      if (r.apiKey) headers['x-goog-api-key'] = r.apiKey;
    } else if (r.apiKey) headers.authorization = `Bearer ${r.apiKey}`;
    let res: Response;
    try {
      res = await f(`${r.baseUrl.replace(/\/+$/, '')}/models${r.kind === 'google' ? '?pageSize=1000' : ''}`, { headers, signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      throw new HttpError(502, `Could not reach ${p.name}: ${this.errorText(err)}`);
    }
    const text = await res.text();
    if (!res.ok) throw new HttpError(502, `${p.name} answered ${res.status}: ${scrub(text.slice(0, 300), this.providers.secrets())}`);
    let body: Json;
    try {
      body = JSON.parse(text) as Json;
    } catch {
      throw new HttpError(502, `${p.name} returned no JSON model list`);
    }
    let models: { id: string; name?: string }[];
    if (r.kind === 'google') {
      models = ((body.models ?? []) as Json[])
        .filter((m) => !Array.isArray(m.supportedGenerationMethods) || (m.supportedGenerationMethods as string[]).includes('generateContent'))
        .map((m) => ({ id: String(m.name ?? '').replace(/^models\//, ''), name: m.displayName ? String(m.displayName) : undefined }));
    } else {
      models = ((body.data ?? body.models ?? []) as Json[]).map((m) => ({ id: String(m.id ?? m.name ?? ''), name: m.display_name ? String(m.display_name) : m.name && m.name !== m.id ? String(m.name) : undefined }));
    }
    return { provider: p.name, models: models.filter((m) => m.id).sort((a, b) => a.id.localeCompare(b.id)) };
  }

  // ------------------------------------------------------------------ agents / tools

  agentView(agent: ChatAgent) {
    const st = this.providerStatus(agent);
    return { ...agent, providerOk: st.ok, providerError: st.error, prompts: this.repo.listPrompts(agent.projectId, agent.id).length };
  }

  tools(project: Project, agent: ChatAgent): Promise<BuiltTools> {
    return buildTools(this.hub, this.requireInject(), project, agent);
  }

  /** devhub tools an agent may be given (for the allowlist editor). */
  async builtinCatalog(): Promise<{ name: string; description: string }[]> {
    return (await builtinCatalog(this.requireInject())).map((t) => ({ name: `devhub__${String(t.name)}`, tool: String(t.name), description: String(t.description ?? '') }));
  }

  private agentForConversation(project: Project, conv: Conversation, ref?: unknown): ChatAgent {
    const r = ref ? String(ref) : conv.agentId;
    if (!r) throw new HttpError(400, 'This conversation has no agent: pass "agent" (id or slug)');
    const agent = this.repo.requireAgent(project.id, r);
    if (agent.id !== conv.agentId) this.repo.updateConversation(project.id, conv.id, { agentId: agent.id });
    return agent;
  }

  history(conv: Conversation): ChatUIMessage[] {
    return this.repo
      .messages(conv.id)
      .filter((m) => m.role !== 'system')
      .map((m) => ({ id: m.id, role: m.role, parts: m.parts }) as unknown as ChatUIMessage);
  }

  conversationView(conv: Conversation) {
    const agent = conv.agentId ? this.repo.getAgent(conv.projectId, conv.agentId) : null;
    return { ...conv, agent: agent ? { id: agent.id, slug: agent.slug, name: agent.name } : null, messages: this.repo.messages(conv.id) };
  }

  private titleFrom(text: string): string {
    const t = text.replace(/\s+/g, ' ').trim();
    return t.length > 60 ? `${t.slice(0, 57)}…` : t;
  }

  // ------------------------------------------------------------------ streaming

  /**
   * Validates and prepares one streamed turn: everything that can fail with a normal JSON 4xx happens here, before
   * the response is hijacked. Persists the user message; returns the function that streams the reply.
   */
  async prepareStream(project: Project, convId: string, body: Json, abortSignal: AbortSignal): Promise<{ pipeTo(res: ServerResponse): Promise<void> }> {
    const conv = this.repo.requireConversation(project.id, convId);
    const agent = this.agentForConversation(project, conv, body.agent);
    const h = this.modelFor(agent.provider, agent.model);
    const trigger = String(body.trigger ?? 'submit-message');
    if (trigger === 'regenerate-message') {
      const msgs = this.repo.messages(conv.id);
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
      if (!lastUser) throw new HttpError(400, 'Nothing to regenerate: the conversation has no user message');
      this.repo.deleteMessagesAfter(conv.id, lastUser.seq);
    } else {
      const msg = body.message as Json | undefined;
      if (!msg || typeof msg !== 'object' || !Array.isArray(msg.parts)) throw new HttpError(400, 'message is required: a UIMessage { id, role: "user", parts: [{ type: "text", text }] }');
      if (msg.role !== undefined && msg.role !== 'user') throw new HttpError(400, 'message.role must be "user"');
      const parts = (msg.parts as Json[]).filter((p) => p && typeof p === 'object' && (p.type === 'text' || p.type === 'file')).slice(0, MAX_PARTS);
      const text = parts.filter((p) => p.type === 'text').map((p) => String(p.text ?? '')).join('\n');
      if (!text.trim() && !parts.length) throw new HttpError(400, 'message has no text');
      this.repo.addMessage(conv, { id: typeof msg.id === 'string' ? msg.id : undefined, role: 'user', parts });
      if (!conv.title && text.trim()) this.repo.updateConversation(project.id, conv.id, { title: this.titleFrom(text) });
    }
    const built = await this.tools(project, agent);
    const messages = this.history(conv);
    this.publish(project.id, { conversation: conv.id, kind: 'user' });
    return streamChat({
      model: h.model,
      system: agent.instructions,
      messages,
      tools: built.tools,
      maxSteps: agent.maxSteps,
      maxOutputTokens: agent.maxOutputTokens,
      temperature: agent.temperature,
      abortSignal,
      errorText: this.errorText,
      generateMessageId: newId,
      onEnd: (o) => {
        const parts = (o.message?.parts ?? []) as unknown as Json[];
        if (!parts.length && !o.error) return;
        // The conversation may have been deleted (or the project reset) while the reply streamed: drop the turn.
        if (!this.repo.getConversation(project.id, conv.id)) return;
        try {
          this.repo.addMessage(conv, {
            id: o.message?.id,
            role: 'assistant',
            parts,
            provider: h.provider.name,
            model: agent.model,
            tokensIn: o.usage.inputTokens,
            tokensOut: o.usage.outputTokens,
            finishReason: o.finishReason,
            steps: o.steps,
            durationMs: o.durationMs,
            error: o.error,
          });
          this.repo.addTokens(conv.id, o.usage.inputTokens, o.usage.outputTokens);
        } catch {
          // Deleted between the check and the insert (foreign key): nothing to keep.
          return;
        }
        this.publish(project.id, { conversation: conv.id, kind: 'assistant' });
      },
    });
  }

  // ------------------------------------------------------------------ one-shot runs

  private async once(project: Project, agent: ChatAgent, messages: ChatUIMessage[]): Promise<{ result: OnceResult | null; error: string | null; provider: string; built: BuiltTools }> {
    const h = this.modelFor(agent.provider, agent.model);
    const built = await this.tools(project, agent);
    const t0 = Date.now();
    try {
      const result = await runOnce({
        model: h.model,
        system: agent.instructions,
        messages,
        tools: built.tools,
        maxSteps: agent.maxSteps,
        maxOutputTokens: agent.maxOutputTokens,
        temperature: agent.temperature,
        abortSignal: AbortSignal.timeout(ONCE_TIMEOUT_MS),
        errorText: this.errorText,
      });
      return { result, error: null, provider: h.provider.name, built };
    } catch (err) {
      return { result: { text: '', toolCalls: [], steps: 0, usage: { inputTokens: 0, outputTokens: 0 }, finishReason: 'error', durationMs: Date.now() - t0, parts: [] }, error: this.errorText(err), provider: h.provider.name, built };
    }
  }

  /** Ask an agent one question (MCP ask_agent); stored as a conversation (new, or appended to `conversation`). */
  async ask(project: Project, agentRef: string, prompt: string, opts: { conversation?: string } = {}) {
    if (!prompt?.trim()) throw new HttpError(400, 'prompt is required');
    const agent = this.repo.requireAgent(project.id, agentRef);
    const conv = opts.conversation ? this.repo.requireConversation(project.id, opts.conversation) : this.repo.createConversation(project.id, agent.id, this.titleFrom(prompt));
    this.modelFor(agent.provider, agent.model);
    this.repo.addMessage(conv, { role: 'user', parts: [{ type: 'text', text: prompt }] });
    const { result, error, provider, built } = await this.once(project, agent, this.history(conv));
    const r = result!;
    const msg = this.repo.addMessage(conv, {
      role: 'assistant',
      parts: r.parts.length ? r.parts : error ? [] : [{ type: 'text', text: r.text, state: 'done' }],
      provider,
      model: agent.model,
      tokensIn: r.usage.inputTokens,
      tokensOut: r.usage.outputTokens,
      finishReason: r.finishReason,
      steps: r.steps,
      durationMs: r.durationMs,
      error,
    });
    this.repo.addTokens(conv.id, r.usage.inputTokens, r.usage.outputTokens);
    this.publish(project.id, { conversation: conv.id, kind: 'assistant' });
    return {
      conversation: conv.id,
      message: msg.id,
      agent: agent.slug,
      text: r.text,
      toolCalls: r.toolCalls,
      steps: r.steps,
      usage: r.usage,
      finishReason: r.finishReason,
      durationMs: r.durationMs,
      error,
      ...(built.errors.length ? { toolErrors: built.errors } : {}),
    };
  }

  async runPrompt(project: Project, ref: string): Promise<ExpectationResult & { id: string; name: string; agent: string }> {
    const p = this.repo.requirePrompt(project.id, ref);
    const agent = this.repo.requireAgent(project.id, p.agentId);
    const { result, error } = await this.once(project, agent, [{ id: 'prompt', role: 'user', parts: [{ type: 'text', text: p.prompt }] } as ChatUIMessage]);
    const r = result!;
    const obs = { text: r.text, toolCalls: r.toolCalls.map((c) => ({ name: c.name, input: c.input, output: typeof c.output === 'string' ? c.output.slice(0, 2000) : c.output })), steps: r.steps, usage: r.usage, finishReason: r.finishReason, durationMs: r.durationMs, error };
    const ev = evaluateExpectations(p.expectations, obs);
    const saved: ExpectationResult = { ...obs, text: obs.text.slice(0, 8000), ...ev, ranAt: new Date().toISOString() };
    this.repo.setPromptResult(p.id, saved);
    this.publish(project.id, { prompt: p.id, kind: 'prompt' });
    return { id: p.id, name: p.name, agent: agent.slug, ...saved };
  }

  /** Run saved prompts one after another (all of the project, or `ids`, or one agent's). */
  async runPrompts(project: Project, opts: { ids?: string[]; agent?: string } = {}) {
    const agentId = opts.agent ? this.repo.requireAgent(project.id, opts.agent).id : undefined;
    let prompts = this.repo.listPrompts(project.id, agentId);
    if (opts.ids?.length) {
      const ids = new Set(opts.ids.map((i) => this.repo.requirePrompt(project.id, i).id));
      prompts = prompts.filter((p) => ids.has(p.id));
    }
    const t0 = Date.now();
    const results = [];
    for (const p of prompts) results.push(await this.runPrompt(project, p.id));
    return { passed: results.filter((r) => r.passed).length, failed: results.filter((r) => !r.passed).length, durationMs: Date.now() - t0, results };
  }

  /** Project reset: conversations go, agents and saved prompts stay. */
  resetProject(projectId: string): number {
    const n = this.repo.deleteConversations(projectId);
    if (n) this.publish(projectId, { kind: 'reset' });
    return n;
  }
}
