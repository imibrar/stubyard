import { createHmac, createSign, randomUUID } from 'node:crypto';
import { crc32 } from 'node:zlib';

/**
 * Signing presets for outbound webhooks.
 *  - none
 *  - hmac:   <header>: <prefix><hex|base64 HMAC-SHA256(secret, body)>
 *            (with timestampHeader set: signs "<ts>.<body>" and sends <timestampHeader>: <ts>)
 *  - stripe: Stripe-Signature: t=<ts>,v1=<hex HMAC-SHA256(secret, "<ts>.<body>")>
 *  - basic:  Authorization: Basic base64(username:password)
 *  - paytabs: Signature: <hex HMAC-SHA256(server key, body)>
 *  - paypal: PAYPAL-TRANSMISSION-ID / -TIME / -SIG (RSA-SHA256 over "<id>|<time>|<webhookId>|<crc32(body)>"), PAYPAL-CERT-URL, PAYPAL-AUTH-ALGO
 */
export type SigningPreset = 'none' | 'hmac' | 'stripe' | 'basic' | 'paytabs' | 'paypal';

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
  /** paypal: PEM private key, webhook id and the cert URL announced in PAYPAL-CERT-URL. */
  privateKey?: string;
  webhookId?: string;
  certUrl?: string;
}

export const SIGNING_PRESETS: { id: SigningPreset; name: string; description: string }[] = [
  { id: 'none', name: 'None', description: 'No signature' },
  { id: 'hmac', name: 'Generic HMAC-SHA256', description: 'HMAC-SHA256 of the raw body in a header of your choice (e.g. X-Signature: sha256=…)' },
  { id: 'stripe', name: 'Stripe', description: 'Stripe-Signature: t=<timestamp>,v1=<HMAC-SHA256 of "<timestamp>.<body>">' },
  { id: 'basic', name: 'Basic auth', description: 'Authorization: Basic with a username and password' },
  { id: 'paytabs', name: 'PayTabs', description: 'Signature: <hex HMAC-SHA256 of the raw body with the server key>' },
  { id: 'paypal', name: 'PayPal', description: 'PAYPAL-TRANSMISSION-SIG: RSA-SHA256 of "<transmission id>|<time>|<webhook id>|<crc32 of body>" (needs a PEM private key and webhook id)' },
];

export function normalizeSigning(input: unknown): SigningConfig {
  const s = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const preset = (s.preset ?? 'none') as SigningPreset;
  if (!SIGNING_PRESETS.some((p) => p.id === preset)) throw new Error(`Unknown signing preset "${String(preset)}" (use none, hmac, stripe, basic, paytabs or paypal)`);
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
  const out: SigningConfig = { preset };
  if (preset === 'hmac' || preset === 'stripe' || preset === 'paytabs') {
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
  if (preset === 'paypal') {
    out.privateKey = str(s.privateKey) ?? '';
    out.webhookId = str(s.webhookId) ?? '';
    if (!out.privateKey || !out.webhookId) throw new Error('PayPal signing needs privateKey (PEM) and webhookId');
    if (str(s.certUrl)) out.certUrl = str(s.certUrl);
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
    case 'paytabs':
      return ['Signature'];
    case 'paypal':
      return PAYPAL_SIGNATURE_HEADERS;
    default:
      return [];
  }
}

export const PAYPAL_SIGNATURE_HEADERS = ['PAYPAL-TRANSMISSION-ID', 'PAYPAL-TRANSMISSION-TIME', 'PAYPAL-TRANSMISSION-SIG', 'PAYPAL-CERT-URL', 'PAYPAL-AUTH-ALGO'];

/** The string PayPal signs: "<transmission id>|<time>|<webhook id>|<CRC32 of the raw body, unsigned decimal>". */
export function paypalSignedString(transmissionId: string, time: string, webhookId: string, body: string): string {
  return `${transmissionId}|${time}|${webhookId}|${crc32(Buffer.from(body, 'utf8')) >>> 0}`;
}

/** PayPal webhook headers for a body (fresh transmission id / time unless given). */
export function paypalSign(cfg: Pick<SigningConfig, 'privateKey' | 'webhookId' | 'certUrl'>, body: string, opts: { transmissionId?: string; time?: string } = {}): Record<string, string> {
  const id = opts.transmissionId ?? randomUUID();
  const time = opts.time ?? new Date().toISOString();
  const sig = createSign('RSA-SHA256').update(paypalSignedString(id, time, cfg.webhookId ?? '', body)).sign(cfg.privateKey ?? '', 'base64');
  return {
    'PAYPAL-TRANSMISSION-ID': id,
    'PAYPAL-TRANSMISSION-TIME': time,
    'PAYPAL-TRANSMISSION-SIG': sig,
    'PAYPAL-CERT-URL': cfg.certUrl ?? '',
    'PAYPAL-AUTH-ALGO': 'SHA256withRSA',
  };
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
    case 'paytabs':
      return { Signature: hmacSha256(cfg.secret ?? '', body) };
    case 'paypal':
      return paypalSign(cfg, body, { time: new Date(timestamp * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') });
    default:
      return {};
  }
}

