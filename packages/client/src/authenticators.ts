/**
 * TOTP authenticator codes (browser-safe, fetch only).
 *
 *   import { getTotpCode, getTotpCodeBy } from '@stubyard/client/authenticators';
 *   const { code } = await getTotpCode({}, resolved.twoFactor.codePath);           // a codePath made by the hub
 *   const { code: c2 } = await getTotpCodeBy({ project: 'hyper' }, { user: 'admin' });
 */
import { hubJson, projectPath, query, type HubTarget } from './http.js';

export interface TotpCode {
  id: string;
  label: string;
  code: string;
  nextCode: string;
  /** Seconds left in the current period. */
  remaining: number;
  period: number;
  /** Epoch ms until which `code` is valid. */
  validUntil: number;
  /** stubyard's "totp" clock offset, when one is set. */
  offsetMs?: number;
}

/** The current code of the key a walkthrough resolve pointed at (`twoFactor.codePath`). */
export function getTotpCode(t: Pick<HubTarget, 'apiUrl' | 'fetch'>, codePath: string): Promise<TotpCode> {
  return hubJson<TotpCode>(t, 'GET', codePath);
}

/** The current code of a key found by label, or of the key linked to a user (id, email, name or role). */
export function getTotpCodeBy(t: HubTarget, o: { label?: string; user?: string }): Promise<TotpCode> {
  return hubJson<TotpCode>(t, 'GET', projectPath(t, `/authenticators/code${query({ label: o.label, user: o.user })}`));
}
