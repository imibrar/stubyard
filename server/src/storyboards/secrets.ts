import type { Step } from './schema.js';

// Secret walkthrough vars (gap 11): a captured TOTP key or token must not show in clear where a run is displayed
// (dashboard Vars, summaries). Steps still render the raw value; only displays mask it.

/** What displays show instead of a secret value (same as actor passwords in summaries). */
export const SECRET_MASK = '***';

const SECRET_NAME = /secret|password|token|otp_?key/i;
const BASE32_KEY = /^[A-Z2-7]{16,}=*$/;

/** A var whose name or value looks secret: name like secret/password/token/otpKey, an otpauth:// URI or a base32 TOTP key. */
export function looksSecret(name: string, value: string | undefined): boolean {
  if (SECRET_NAME.test(name)) return true;
  if (!value) return false;
  const v = value.trim();
  return /^otpauth:\/\//i.test(v) || BASE32_KEY.test(v.replace(/\s+/g, ''));
}

/** Names of the secret vars of a run: capture steps with secret: true, plus every var that looks secret. */
export function secretVarNames(steps: Step[], vars: Record<string, string>): string[] {
  const out = new Set<string>();
  for (const s of steps) if (s.kind === 'capture' && s.secret) out.add(s.var);
  for (const [k, v] of Object.entries(vars)) if (looksSecret(k, v)) out.add(k);
  return [...out].sort();
}

/** The vars with secret values replaced by SECRET_MASK. */
export const maskVars = (vars: Record<string, string>, secret: Iterable<string>): Record<string, string> => {
  const s = new Set(secret);
  return Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, s.has(k) ? SECRET_MASK : v]));
};
