/**
 * LLM API mocks: the canonical request / response every provider format is read into and rendered from.
 * One canonical response renders to OpenAI Chat Completions, OpenAI Responses and Anthropic Messages, streamed or not.
 */

export type LlmProvider = 'openai' | 'anthropic';
/** chat = OpenAI /v1/chat/completions, responses = OpenAI /v1/responses, messages = Anthropic /v1/messages. */
export type LlmEndpoint = 'chat' | 'responses' | 'messages' | 'embeddings' | 'count_tokens' | 'models';
export const LLM_ENDPOINTS: LlmEndpoint[] = ['chat', 'responses', 'messages', 'embeddings', 'count_tokens', 'models'];

export interface CanonToolCall {
  /** Provider id (call_… / toolu_… / fc call_id); generated when missing. */
  id?: string;
  name: string;
  /** JSON object or a JSON string. */
  arguments: unknown;
}

export interface CanonToolResult {
  id?: string;
  /** Tool name, looked up from the assistant call with the same id. */
  name?: string;
  content: string;
  isError?: boolean;
}

export interface CanonMessage {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  toolCalls?: CanonToolCall[];
  toolResults?: CanonToolResult[];
}

export interface CanonRequest {
  provider: LlmProvider;
  endpoint: LlmEndpoint;
  model: string;
  system: string;
  messages: CanonMessage[];
  /** Tool names offered to the model. */
  tools: string[];
  stream: boolean;
  /** OpenAI chat stream_options.include_usage. */
  includeUsage?: boolean;
  maxTokens?: number | null;
}

/** Normalised stop reason (provider names are accepted on input and mapped). */
export type StopReason = 'stop' | 'tool_calls' | 'length' | 'stop_sequence';

export interface RawReply {
  provider: LlmProvider;
  endpoint: LlmEndpoint;
  stream: boolean;
  status: number;
  contentType: string;
  /** Exact upstream body bytes (UTF-8). */
  body: string;
}

/** What a mock answers. */
export interface CanonResponse {
  text?: string;
  toolCalls?: { name: string; arguments: unknown; id?: string }[];
  stopReason?: StopReason | string;
  usage?: { input?: number; output?: number };
  /** Streaming: characters per chunk and the pause between chunks. */
  chunk?: { size?: number; delayMs?: number };
  /** Recorded exact reply, replayed byte for byte when provider, endpoint and stream mode are the same. */
  raw?: RawReply;
}

export interface LlmMatchText {
  contains?: string;
  equals?: string;
  regex?: string;
}

export interface LlmMatch {
  endpoint?: LlmEndpoint | LlmEndpoint[];
  /** Glob: "gpt-5*", "claude-*". */
  model?: string;
  lastUser?: LlmMatchText;
  system?: { contains?: string };
  toolResult?: { name?: string; contains?: string };
  /** The request offers this tool. */
  hasTool?: string;
  /** Number of assistant messages so far (0 = first turn). */
  turn?: number;
  stream?: boolean;
}
