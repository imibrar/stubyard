import type { ServerResponse } from 'node:http';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  consumeStream,
  convertToModelMessages,
  dynamicTool,
  generateText,
  isStepCount,
  jsonSchema,
  pipeUIMessageStreamToResponse,
  streamText,
  toUIMessageStream,
  type JSONSchema7,
  type LanguageModel,
  type ToolSet,
  type UIMessage,
} from 'ai';
import type { ResolvedProvider } from './keys.js';

/**
 * The ONLY module that imports the Vercel AI SDK (ai, @ai-sdk/*). Everything else talks in plain JSON:
 * ToolSpec, UIMessage-shaped parts and the result objects below. AI SDK 7 names verified against the installed
 * .d.ts: isStepCount (stepCountIs is a deprecated alias), instructions (was system), onEnd (was onFinish),
 * toUIMessageStream / pipeUIMessageStreamToResponse as standalone helpers, consumeStream, dynamicTool, jsonSchema.
 */

export type Json = Record<string, unknown>;
export type ChatUIMessage = UIMessage;
export type ChatModel = LanguageModel;

/** A tool offered to the model. execute never throws: failures come back as text the model can read. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Json;
  execute(args: Json): Promise<string>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  input: unknown;
  output: unknown;
}

export interface ChatCall {
  model: LanguageModel;
  system?: string;
  messages: UIMessage[];
  tools: ToolSpec[];
  maxSteps: number;
  maxOutputTokens?: number | null;
  temperature?: number | null;
  abortSignal?: AbortSignal;
  /** Turns an error into text for the client / database (keys scrubbed). */
  errorText: (err: unknown) => string;
}

export interface StreamOutcome {
  message: UIMessage;
  usage: Usage;
  finishReason: string | null;
  steps: number;
  aborted: boolean;
  error: string | null;
  durationMs: number;
}

export interface OnceResult {
  text: string;
  toolCalls: ToolCallRecord[];
  steps: number;
  usage: Usage;
  finishReason: string;
  durationMs: number;
  /** Assistant message parts (UIMessage parts) for persistence. */
  parts: Json[];
}

type ModelFactory = (cfg: ResolvedProvider, modelId: string) => LanguageModel;
let testFactory: ModelFactory | null = null;

/** Tests only: build every model with `fn` (e.g. MockLanguageModelV4 from ai/test); null restores the real providers. */
export function __setModelFactoryForTests(fn: ModelFactory | null): void {
  testFactory = fn;
}

/** provider(modelId) for the provider kind; never a bare model string (that would route through the AI Gateway). */
export function resolveModel(cfg: ResolvedProvider, modelId: string, fetchImpl: typeof fetch): LanguageModel {
  if (testFactory) return testFactory(cfg, modelId);
  const common = { baseURL: cfg.baseUrl, headers: cfg.headers, fetch: fetchImpl };
  switch (cfg.kind) {
    case 'openai':
      return createOpenAI({ ...common, apiKey: cfg.apiKey ?? '' })(modelId);
    case 'anthropic':
      return createAnthropic({ ...common, apiKey: cfg.apiKey ?? '' })(modelId);
    case 'google':
      return createGoogle({ ...common, apiKey: cfg.apiKey ?? '' })(modelId);
    case 'openai-compatible':
      return createOpenAICompatible({ ...common, name: `devhub-${cfg.preset ?? 'custom'}`, apiKey: cfg.apiKey ?? undefined, includeUsage: true }).chatModel(modelId);
  }
}

function toToolSet(tools: ToolSpec[]): ToolSet {
  const set: ToolSet = {};
  for (const t of tools) {
    set[t.name] = dynamicTool({
      description: t.description,
      inputSchema: jsonSchema(t.inputSchema as JSONSchema7),
      execute: async (input) => t.execute((input && typeof input === 'object' ? input : {}) as Json),
    });
  }
  return set;
}

const usageOf = (u: { inputTokens?: number; outputTokens?: number } | undefined | null): Usage => ({ inputTokens: u?.inputTokens ?? 0, outputTokens: u?.outputTokens ?? 0 });

/** Streams one assistant turn as a UI message stream (the protocol useChat / DefaultChatTransport read). */
export async function streamChat(o: ChatCall & { generateMessageId: () => string; onEnd: (r: StreamOutcome) => void | Promise<void> }): Promise<{ pipeTo(res: ServerResponse): Promise<void> }> {
  const t0 = Date.now();
  const modelMessages = await convertToModelMessages(o.messages, { ignoreIncompleteToolCalls: true });
  let stats: { usage: Usage; finishReason: string | null; steps: number } | null = null;
  let error: string | null = null;
  let settle!: () => void;
  const settled = new Promise<void>((r) => (settle = r));
  const result = streamText({
    model: o.model,
    instructions: o.system || undefined,
    messages: modelMessages,
    tools: toToolSet(o.tools),
    stopWhen: isStepCount(o.maxSteps),
    maxOutputTokens: o.maxOutputTokens ?? undefined,
    temperature: o.temperature ?? undefined,
    abortSignal: o.abortSignal,
    maxRetries: 1,
    onEnd: (e) => {
      stats = { usage: usageOf(e.usage), finishReason: e.finishReason ?? null, steps: e.steps.length };
      settle();
    },
    onError: ({ error: err }) => {
      error = o.errorText(err);
      settle();
    },
    onAbort: (e) => {
      stats = { usage: { inputTokens: 0, outputTokens: 0 }, finishReason: 'aborted', steps: e.steps.length };
      settle();
    },
  });
  const ui = toUIMessageStream({
    stream: result.stream,
    originalMessages: o.messages,
    generateMessageId: o.generateMessageId,
    onError: (err) => (error = o.errorText(err)),
    onEnd: async ({ responseMessage, isAborted }) => {
      await Promise.race([settled, new Promise((r) => setTimeout(r, 2000))]);
      const s = stats as { usage: Usage; finishReason: string | null; steps: number } | null;
      await o.onEnd({
        message: responseMessage,
        usage: s?.usage ?? { inputTokens: 0, outputTokens: 0 },
        finishReason: isAborted ? 'aborted' : (s?.finishReason ?? (error ? 'error' : null)),
        steps: s?.steps ?? 0,
        aborted: isAborted,
        error,
        durationMs: Date.now() - t0,
      });
    },
  });
  return {
    // The tee'd copy is consumed independently, so onEnd (persistence) runs even when the client goes away.
    pipeTo: (res) => pipeUIMessageStreamToResponse({ response: res, stream: ui, consumeSseStream: ({ stream }) => void consumeStream({ stream }) }),
  };
}

/** One non-streaming turn (MCP ask_agent, saved prompts, provider test). Throws on provider errors. */
export async function runOnce(o: ChatCall): Promise<OnceResult> {
  const t0 = Date.now();
  const r = await generateText({
    model: o.model,
    instructions: o.system || undefined,
    messages: await convertToModelMessages(o.messages, { ignoreIncompleteToolCalls: true }),
    tools: toToolSet(o.tools),
    stopWhen: isStepCount(o.maxSteps),
    maxOutputTokens: o.maxOutputTokens ?? undefined,
    temperature: o.temperature ?? undefined,
    abortSignal: o.abortSignal,
    maxRetries: 1,
  });
  const toolCalls: ToolCallRecord[] = [];
  const parts: Json[] = [];
  for (const step of r.steps) {
    if (parts.length) parts.push({ type: 'step-start' });
    for (const c of step.toolCalls) {
      const res = step.toolResults.find((x) => x.toolCallId === c.toolCallId);
      toolCalls.push({ id: c.toolCallId, name: c.toolName, input: c.input, output: res?.output ?? null });
      parts.push({ type: 'dynamic-tool', toolName: c.toolName, toolCallId: c.toolCallId, state: 'output-available', input: c.input, output: res?.output ?? null });
    }
    if (step.text) parts.push({ type: 'text', text: step.text, state: 'done' });
  }
  return { text: r.text, toolCalls, steps: r.steps.length, usage: usageOf(r.usage), finishReason: String(r.finishReason ?? 'unknown'), durationMs: Date.now() - t0, parts };
}
