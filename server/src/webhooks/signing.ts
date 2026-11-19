import { createHmac } from 'node:crypto';

/**
 * Signing presets for outbound webhooks.
 *  - none
 *  - hmac:   <header>: <prefix><hex|base64 HMAC-SHA256(secret, body)>
 *            (with timestampHeader set: signs "<ts>.<body>" and sends <timestampHeader>: <ts>)
 *  - stripe: Stripe-Signature: t=<ts>,v1=<hex HMAC-SHA256(secret, "<ts>.<body>")>
 *  - basic:  Authorization: Basic base64(username:password)
 */
export type SigningPreset = 'none' | 'hmac' | 'stripe' | 'basic';

export interface SigningConfig {
  preset: SigningPreset;
  secret?: string;
  /** hmac: header name (default X-Signature). */
  header?: string;
  /** hmac: value prefix, e.g. "sha256=". */
  prefix?: string;
  /** hmac: hex (default) or base64. */
  encoding?: 'hex' | 'base64';
  /** hmac: also send a timestamp header and sign "<ts>.<body>". */
  timestampHeader?: string;
  /** basic */
  username?: string;
  password?: string;
}

export const SIGNING_PRESETS: { id: SigningPreset; name: string; description: string }[] = [
  { id: 'none', name: 'None', description: 'No signature' },
  { id: 'hmac', name: 'Generic HMAC-SHA256', description: 'HMAC-SHA256 of the raw body in a header of your choice (e.g. X-Signature: sha256=…)' },
  { id: 'stripe', name: 'Stripe', description: 'Stripe-Signature: t=<timestamp>,v1=<HMAC-SHA256 of "<timestamp>.<body>">' },
  { id: 'basic', name: 'Basic auth', description: 'Authorization: Basic with a username and password' },
];

export function normalizeSigning(input: unknown): SigningConfig {
  const s = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const preset = (s.preset ?? 'none') as SigningPreset;
  if (!SIGNING_PRESETS.some((p) => p.id === preset)) throw new Error(`Unknown signing preset "${String(preset)}" (use none, hmac, stripe or basic)`);
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
  const out: SigningConfig = { preset };
  if (preset === 'hmac' || preset === 'stripe') {
    out.secret = str(s.secret) ?? '';
    if (!out.secret) throw new Error(`A secret is required for ${preset} signing`);
  }
  if (preset === 'hmac') {
    out.header = str(s.header) ?? 'X-Signature';
    out.prefix = typeof s.prefix === 'string' ? s.prefix : 'sha256=';
    out.encoding = s.encoding === 'base64' ? 'base64' : 'hex';
    if (str(s.timestampHeader)) out.timestampHeader = str(s.timestampHeader);
  }
  if (preset === 'basic') {
    out.username = str(s.username) ?? '';
    out.password = typeof s.password === 'string' ? s.password : '';
  }
  return out;
}

/** Header names a preset writes (removed before re-signing a replay). */
export function signatureHeaders(cfg: SigningConfig): string[] {
  switch (cfg.preset) {
    case 'hmac':
      return [cfg.header ?? 'X-Signature', ...(cfg.timestampHeader ? [cfg.timestampHeader] : [])];
    case 'stripe':
      return ['Stripe-Signature'];
    case 'basic':
      return ['Authorization'];
    default:
      return [];
  }
}

export function hmacSha256(secret: string, payload: string, encoding: 'hex' | 'base64' = 'hex'): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest(encoding);
}

/** Headers to add for this body. `timestamp` is Unix seconds (fresh by default). */
export function sign(cfg: SigningConfig, body: string, timestamp = Math.floor(Date.now() / 1000)): Record<string, string> {
  switch (cfg.preset) {
    case 'hmac': {
      const payload = cfg.timestampHeader ? `${timestamp}.${body}` : body;
      const sig = `${cfg.prefix ?? ''}${hmacSha256(cfg.secret ?? '', payload, cfg.encoding ?? 'hex')}`;
      return { [cfg.header ?? 'X-Signature']: sig, ...(cfg.timestampHeader ? { [cfg.timestampHeader]: String(timestamp) } : {}) };
    }
    case 'stripe':
      return { 'Stripe-Signature': `t=${timestamp},v1=${hmacSha256(cfg.secret ?? '', `${timestamp}.${body}`)}` };
    case 'basic':
      return { Authorization: `Basic ${Buffer.from(`${cfg.username ?? ''}:${cfg.password ?? ''}`).toString('base64')}` };
    default:
      return {};
  }
}

