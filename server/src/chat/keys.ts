import { envVar } from '../config.js';
import type { DB } from '../db/index.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';

/**
 * AI model providers (table ai_providers, global) plus providers that come from environment variables.
 * Keys are write-only: nothing here returns a key; view() gives { hasKey, source, keyHint } (last 4 chars).
 * Environment keys win over stored ones for the same kind / preset, but only for a provider that calls the kind's
 * default host (envKeyFor). Changing the base URL host clears the stored key and header values. process.env is read on every call, so a
 * restart is not needed after changing it (and tests can set it).
 */

export type ProviderKind = 'openai' | 'anthropic' | 'google' | 'openai-compatible';
export type ProviderPreset = 'openrouter' | 'ollama' | 'custom' | null;
export const PROVIDER_KINDS: ProviderKind[] = ['openai', 'anthropic', 'google', 'openai-compatible'];
const PRESETS = ['openrouter', 'ollama', 'custom'];

export interface AiProvider {
  id: string;
  name: string;
  kind: ProviderKind;
  preset: ProviderPreset;
  baseUrl: string | null;
  /** Clear text, server side only. */
  apiKey: string | null;
  headers: Record<string, string>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /** Virtual provider from environment variables (id / name "env:<id>"), read-only. */
  env?: boolean;
}

/** Everything engine.ts needs to build a model (key included: never send this to a client). */
export interface ResolvedProvider {
  id: string;
  name: string;
  kind: ProviderKind;
  preset: ProviderPreset;
  baseUrl: string;
  apiKey: string | null;
  headers: Record<string, string>;
  keySource: 'env' | 'stored' | null;
}

interface Row {
  id: string;
  name: string;
  kind: ProviderKind;
  preset: string | null;
  base_url: string | null;
  api_key: string | null;
  headers: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/** Default base URL per kind / preset. */
export function defaultBaseUrl(kind: ProviderKind, preset: ProviderPreset): string | null {
  if (kind === 'openai') return 'https://api.openai.com/v1';
  if (kind === 'anthropic') return 'https://api.anthropic.com/v1';
  if (kind === 'google') return 'https://generativelanguage.googleapis.com/v1beta';
  if (preset === 'openrouter') return 'https://openrouter.ai/api/v1';
  if (preset === 'ollama') return env('STUBYARD_OLLAMA_URL') || 'http://host.docker.internal:11434/v1';
  return null;
}

const env = (k: string): string | null => {
  const v = envVar(k);
  return v && v.trim() ? v.trim() : null;
};

/** The environment key for a kind / preset (STUBYARD_OPENAI_API_KEY wins over OPENAI_API_KEY). */
export function envKey(kind: ProviderKind, preset: ProviderPreset): { name: string; value: string } | null {
  const pick = (...names: string[]) => {
    for (const n of names) {
      const v = env(n);
      if (v) return { name: n, value: v };
    }
    return null;
  };
  if (kind === 'openai') return pick('STUBYARD_OPENAI_API_KEY', 'OPENAI_API_KEY');
  if (kind === 'anthropic') return pick('ANTHROPIC_API_KEY');
  if (kind === 'google') return pick('GOOGLE_GENERATIVE_AI_API_KEY');
  if (preset === 'openrouter') return pick('OPENROUTER_API_KEY');
  return null;
}

const hostOf = (u: string | null): string | null => {
  if (!u) return null;
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return null;
  }
};

/** Host the provider will really call (its base URL, else the kind / preset default). */
export function effectiveHost(p: { kind: ProviderKind; preset: ProviderPreset; baseUrl: string | null }): string | null {
  return hostOf(p.baseUrl || defaultBaseUrl(p.kind, p.preset));
}

/**
 * The environment key that applies to a provider: only when it calls the kind's default host (api.openai.com,
 * api.anthropic.com, generativelanguage.googleapis.com, openrouter.ai), so a custom base URL never receives it.
 */
export function envKeyFor(p: { kind: ProviderKind; preset: ProviderPreset; baseUrl: string | null }): { name: string; value: string } | null {
  const k = envKey(p.kind, p.preset);
  if (!k) return null;
  const def = hostOf(defaultBaseUrl(p.kind, p.preset));
  return def && effectiveHost(p) === def ? k : null;
}

/** Providers defined only by the environment: env:openai, env:anthropic, env:google, env:openrouter, env:ollama. */
const ENV_PROVIDERS: { id: string; label: string; kind: ProviderKind; preset: ProviderPreset; present: () => boolean }[] = [
  { id: 'openai', label: 'OpenAI', kind: 'openai', preset: null, present: () => !!envKey('openai', null) },
  { id: 'anthropic', label: 'Anthropic', kind: 'anthropic', preset: null, present: () => !!envKey('anthropic', null) },
  { id: 'google', label: 'Google', kind: 'google', preset: null, present: () => !!envKey('google', null) },
  { id: 'openrouter', label: 'OpenRouter', kind: 'openai-compatible', preset: 'openrouter', present: () => !!envKey('openai-compatible', 'openrouter') },
  { id: 'ollama', label: 'Ollama', kind: 'openai-compatible', preset: 'ollama', present: () => !!env('STUBYARD_OLLAMA_URL') },
];

const toProvider = (r: Row): AiProvider => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  preset: (r.preset as ProviderPreset) ?? null,
  baseUrl: r.base_url,
  apiKey: r.api_key,
  headers: parseJson<Record<string, string>>(r.headers, {}),
  enabled: !!r.enabled,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export interface AiProviderInput {
  name?: unknown;
  kind?: unknown;
  preset?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  headers?: unknown;
  enabled?: unknown;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,47}$/;

function checkUrl(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim().replace(/\/+$/, '');
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
  } catch {
    throw new HttpError(400, `baseUrl "${s}" is not an http(s) URL`);
  }
  return s;
}

function checkHeaders(h: unknown, prev: Record<string, string> = {}): Record<string, string> {
  if (h === undefined) return prev;
  if (h === null) return {};
  if (typeof h !== 'object' || Array.isArray(h)) throw new HttpError(400, 'headers must be an object of name → value');
  const out: Record<string, string> = {};
  for (const [k0, v] of Object.entries(h as Record<string, unknown>)) {
    const k = k0.trim();
    if (!k) continue;
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k)) throw new HttpError(400, `Invalid header name "${k}"`);
    const val = v === null || v === undefined ? '' : String(v);
    // A masked value sent back unchanged keeps the stored one.
    const prevKey = Object.keys(prev).find((p) => p.toLowerCase() === k.toLowerCase());
    out[k] = isMaskedValue(val) && prevKey ? prev[prevKey] : val;
  }
  return out;
}

const MASK = '••••';
const isMaskedValue = (v: string) => v.startsWith(MASK);
export const keyHint = (k: string | null) => (k ? `${MASK}${k.slice(-4)}` : null);

export class AiProviderRepo {
  constructor(private db: DB) {}

  listStored(): AiProvider[] {
    return (this.db.prepare('SELECT * FROM ai_providers ORDER BY name COLLATE NOCASE').all() as unknown as Row[]).map(toProvider);
  }

  envProviders(): AiProvider[] {
    const at = new Date(0).toISOString();
    return ENV_PROVIDERS.filter((p) => p.present()).map((p) => ({
      id: `env:${p.id}`,
      name: `env:${p.id}`,
      kind: p.kind,
      preset: p.preset,
      baseUrl: defaultBaseUrl(p.kind, p.preset),
      apiKey: null,
      headers: {},
      enabled: true,
      createdAt: at,
      updatedAt: at,
      env: true,
    }));
  }

  /** Stored providers first, then environment ones. */
  list(): AiProvider[] {
    return [...this.listStored(), ...this.envProviders()];
  }

  /** By id or (case-insensitive) name; "env:<id>" for environment providers. */
  get(ref: string): AiProvider | null {
    if (ref.startsWith('env:')) return this.envProviders().find((p) => p.id === ref) ?? null;
    const r = this.db.prepare('SELECT * FROM ai_providers WHERE id = ? OR name = ? COLLATE NOCASE').get(ref, ref) as Row | undefined;
    return r ? toProvider(r) : null;
  }

  require(ref: string): AiProvider {
    const p = this.get(ref);
    if (!p) throw new HttpError(404, `AI provider "${ref}" not found${ref.startsWith('env:') ? ' (is its environment variable set?)' : ''}`);
    return p;
  }

  create(input: AiProviderInput): AiProvider {
    const name = String(input.name ?? '').trim();
    if (!NAME_RE.test(name)) throw new HttpError(400, 'name is required (letters, digits, space . _ -; max 48)');
    if (name.toLowerCase().startsWith('env:')) throw new HttpError(400, 'names starting with "env:" are reserved');
    if (this.get(name)) throw new HttpError(409, `An AI provider named "${name}" exists already`);
    const kind = String(input.kind ?? '') as ProviderKind;
    if (!PROVIDER_KINDS.includes(kind)) throw new HttpError(400, `kind must be one of ${PROVIDER_KINDS.join(', ')}`);
    let preset = input.preset === undefined || input.preset === null || input.preset === '' ? null : String(input.preset);
    if (preset && !PRESETS.includes(preset)) throw new HttpError(400, `preset must be one of ${PRESETS.join(', ')}`);
    if (kind !== 'openai-compatible') preset = null;
    else if (!preset) preset = 'custom';
    const baseUrl = checkUrl(input.baseUrl);
    if (kind === 'openai-compatible' && preset === 'custom' && !baseUrl) throw new HttpError(400, 'baseUrl is required for a custom OpenAI-compatible provider');
    const apiKey = input.apiKey === undefined || input.apiKey === null || input.apiKey === '' ? null : String(input.apiKey).trim();
    const at = nowIso();
    const id = newId();
    this.db
      .prepare('INSERT INTO ai_providers (id, name, kind, preset, base_url, api_key, headers, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, name, kind, preset, baseUrl, apiKey, checkHeaders(input.headers), input.enabled === false ? 0 : 1, at, at);
    return this.require(id);
  }

  update(ref: string, input: AiProviderInput): AiProvider {
    const p = this.require(ref);
    if (p.env) throw new HttpError(400, `"${p.name}" comes from environment variables and is read-only`);
    const name = input.name === undefined ? p.name : String(input.name).trim();
    if (!NAME_RE.test(name)) throw new HttpError(400, 'invalid name');
    if (name.toLowerCase().startsWith('env:')) throw new HttpError(400, 'names starting with "env:" are reserved');
    const other = this.get(name);
    if (other && other.id !== p.id) throw new HttpError(409, `An AI provider named "${name}" exists already`);
    const baseUrl = input.baseUrl === undefined ? p.baseUrl : checkUrl(input.baseUrl);
    // A new host must not inherit the stored key / header values (they were meant for the old host): both are
    // cleared unless sent again in this request. Masked header values sent back are dropped.
    const hostChanged = effectiveHost({ ...p, baseUrl }) !== effectiveHost(p);
    // Write-only key: undefined keeps it, '' / null clears it.
    const keptKey = hostChanged ? null : p.apiKey;
    const apiKey = input.apiKey === undefined ? keptKey : input.apiKey === null || input.apiKey === '' ? null : String(input.apiKey).trim();
    const headers = hostChanged
      ? Object.fromEntries(Object.entries(checkHeaders(input.headers ?? {}, {})).filter(([, v]) => !isMaskedValue(v)))
      : checkHeaders(input.headers, p.headers);
    const enabled = input.enabled === undefined ? p.enabled : input.enabled === true;
    this.db
      .prepare('UPDATE ai_providers SET name = ?, base_url = ?, api_key = ?, headers = ?, enabled = ?, updated_at = ? WHERE id = ?')
      .run(name, baseUrl, apiKey, headers, enabled ? 1 : 0, nowIso(), p.id);
    return this.require(p.id);
  }

  delete(ref: string): boolean {
    const p = this.require(ref);
    if (p.env) throw new HttpError(400, `"${p.name}" comes from environment variables; unset the variable to remove it`);
    return this.db.prepare('DELETE FROM ai_providers WHERE id = ?').run(p.id).changes > 0;
  }

  /** Effective settings (environment key wins over the stored one). */
  resolve(p: AiProvider): ResolvedProvider {
    const fromEnv = envKeyFor(p);
    const apiKey = fromEnv?.value ?? p.apiKey ?? null;
    const baseUrl = p.baseUrl || defaultBaseUrl(p.kind, p.preset);
    if (!baseUrl) throw new HttpError(400, `AI provider "${p.name}" has no base URL`);
    return { id: p.id, name: p.name, kind: p.kind, preset: p.preset, baseUrl, apiKey, headers: p.headers, keySource: fromEnv ? 'env' : p.apiKey ? 'stored' : null };
  }

  /** API view: never the key, header values masked. */
  view(p: AiProvider) {
    const fromEnv = envKeyFor(p);
    const key = fromEnv?.value ?? p.apiKey;
    return {
      id: p.id,
      name: p.name,
      kind: p.kind,
      preset: p.preset,
      baseUrl: p.baseUrl,
      effectiveBaseUrl: p.baseUrl || defaultBaseUrl(p.kind, p.preset),
      enabled: p.enabled,
      env: !!p.env,
      hasKey: !!key,
      source: fromEnv ? ('env' as const) : p.apiKey ? ('stored' as const) : null,
      envVar: fromEnv?.name ?? null,
      keyHint: keyHint(key ?? null),
      needsKey: !(p.kind === 'openai-compatible' && p.preset !== 'openrouter'),
      headerNames: Object.keys(p.headers),
      headers: Object.fromEntries(Object.entries(p.headers).map(([k, v]) => [k, v ? `${MASK}${v.length > 8 ? v.slice(-4) : ''}` : ''])),
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  /** Every secret string of every provider (for scrubbing error text). */
  secrets(): string[] {
    const out = new Set<string>();
    for (const p of this.listStored()) {
      if (p.apiKey) out.add(p.apiKey);
      for (const v of Object.values(p.headers)) if (v && v.length >= 8) out.add(v);
    }
    for (const n of ['STUBYARD_OPENAI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'OPENROUTER_API_KEY']) {
      const v = env(n);
      if (v) out.add(v);
    }
    return [...out].filter((s) => s.length >= 4);
  }
}

/** Remove keys and auth header values from text that may be shown or logged. */
export function scrub(text: string, secrets: string[]): string {
  let t = text;
  for (const s of secrets) if (s) t = t.split(s).join(MASK);
  return t
    .replace(/(authorization|x-api-key|x-goog-api-key|api-key)(["']?\s*[:=]\s*["']?)(bearer\s+)?[^\s"',}]+/gi, (_m, h, sep, b) => `${h}${sep}${b ?? ''}${MASK}`)
    .replace(/([?&]key=)[^&\s"']+/gi, `$1${MASK}`);
}

/**
 * fetch for one provider: refuses every host except the provider's base URL host (chat egress does not use the
 * outbound allowlist, so it is pinned here). Never logs headers or bodies.
 */
export function egressFetch(p: { name: string; baseUrl: string }): typeof fetch {
  const allowed = new URL(p.baseUrl).host.toLowerCase();
  const f = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    let host: string;
    try {
      host = new URL(url).host.toLowerCase();
    } catch {
      throw new Error(`stubyard blocked a chat request to an invalid URL for provider "${p.name}"`);
    }
    if (host !== allowed) throw new Error(`stubyard blocked a chat request to ${host}: provider "${p.name}" may only call ${allowed}`);
    // No redirects: a 3xx could point at another host (and carry the key there).
    return fetch(input, { ...init, redirect: 'error' });
  }) as typeof fetch;
  return f;
}
