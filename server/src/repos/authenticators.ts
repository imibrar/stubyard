import type { DB } from '../db/index.js';
import {
  base32Decode,
  checkAlgorithm,
  checkDigits,
  checkPeriod,
  normalizeSecret,
  parseOtpauth,
  totp,
  type TotpAlgorithm,
  type TotpCode,
} from '../totp/totp.js';
import { HttpError, newId, nowIso } from '../util.js';

export interface Authenticator {
  id: string;
  projectId: string;
  testUserId: string | null;
  label: string;
  issuer: string | null;
  account: string | null;
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
  /** Last 4 characters of the secret, for recognition only. */
  secretHint: string;
  createdAt: string;
}

export interface AuthenticatorWithSecret extends Authenticator {
  secret: string;
  otpauthUri: string;
}

interface Row {
  id: string;
  project_id: string;
  test_user_id: string | null;
  label: string;
  issuer: string | null;
  account: string | null;
  secret: string;
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
  created_at: string;
}

function toAuth(r: Row): Authenticator {
  return {
    id: r.id,
    projectId: r.project_id,
    testUserId: r.test_user_id,
    label: r.label,
    issuer: r.issuer,
    account: r.account,
    algorithm: r.algorithm,
    digits: r.digits,
    period: r.period,
    secretHint: '…' + r.secret.slice(-4),
    createdAt: r.created_at,
  };
}

export interface AuthenticatorInput {
  label?: string;
  /** Base32 secret key, or a full otpauth:// link (from the QR code). */
  secret?: string;
  testUserId?: string | null;
  issuer?: string | null;
  account?: string | null;
  algorithm?: string;
  digits?: number;
  period?: number;
}

export class AuthenticatorRepo {
  constructor(private db: DB) {}

  list(projectId: string): Authenticator[] {
    return (this.db.prepare('SELECT * FROM authenticators WHERE project_id = ? ORDER BY label COLLATE NOCASE').all(projectId) as Row[]).map(toAuth);
  }

  private row(projectId: string, id: string): Row {
    const r = this.db.prepare('SELECT * FROM authenticators WHERE project_id = ? AND id = ?').get(projectId, id) as Row | undefined;
    if (!r) throw new HttpError(404, `Authenticator "${id}" not found`);
    return r;
  }

  require(projectId: string, id: string): Authenticator {
    return toAuth(this.row(projectId, id));
  }

  findByLabel(projectId: string, label: string): Authenticator {
    const rows = this.db.prepare('SELECT * FROM authenticators WHERE project_id = ? AND label = ? COLLATE NOCASE').all(projectId, label) as Row[];
    if (rows.length === 0) throw new HttpError(404, `No authenticator labelled "${label}"`);
    if (rows.length > 1) throw new HttpError(409, `Several authenticators are labelled "${label}"; use the id instead`);
    return toAuth(rows[0]);
  }

  withSecret(projectId: string, id: string): AuthenticatorWithSecret {
    const r = this.row(projectId, id);
    const a = toAuth(r);
    const name = encodeURIComponent(a.issuer ? `${a.issuer}:${a.account ?? a.label}` : (a.account ?? a.label));
    const params = new URLSearchParams({ secret: r.secret, algorithm: a.algorithm, digits: String(a.digits), period: String(a.period) });
    if (a.issuer) params.set('issuer', a.issuer);
    return { ...a, secret: r.secret, otpauthUri: `otpauth://totp/${name}?${params}` };
  }

  code(projectId: string, id: string, nowMs = Date.now()): TotpCode {
    const r = this.row(projectId, id);
    return totp({ secret: r.secret, algorithm: r.algorithm, digits: r.digits, period: r.period }, nowMs);
  }

  codes(projectId: string, nowMs = Date.now()): Record<string, TotpCode> {
    const out: Record<string, TotpCode> = {};
    for (const r of this.db.prepare('SELECT * FROM authenticators WHERE project_id = ?').all(projectId) as Row[]) {
      out[r.id] = totp({ secret: r.secret, algorithm: r.algorithm, digits: r.digits, period: r.period }, nowMs);
    }
    return out;
  }

  create(projectId: string, input: AuthenticatorInput): Authenticator {
    const v = this.resolve(input);
    const label = (input.label ?? '').trim() || [v.issuer, v.account].filter(Boolean).join(' · ') || 'Authenticator';
    this.checkUser(projectId, input.testUserId);
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO authenticators (id, project_id, test_user_id, label, issuer, account, secret, algorithm, digits, period, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, projectId, input.testUserId ?? null, label, v.issuer, v.account, v.secret, v.algorithm, v.digits, v.period, nowIso());
    return this.require(projectId, id);
  }

  update(projectId: string, id: string, patch: AuthenticatorInput): Authenticator {
    const cur = this.row(projectId, id);
    const label = patch.label !== undefined ? patch.label.trim() : cur.label;
    if (!label) throw new HttpError(400, 'Label cannot be empty');
    if (patch.testUserId !== undefined) this.checkUser(projectId, patch.testUserId);
    let next = { secret: cur.secret, issuer: cur.issuer, account: cur.account, algorithm: cur.algorithm, digits: cur.digits, period: cur.period };
    if (patch.secret) next = this.resolve(patch);
    else {
      if (patch.issuer !== undefined) next.issuer = patch.issuer?.trim() || null;
      if (patch.account !== undefined) next.account = patch.account?.trim() || null;
      if (patch.algorithm !== undefined) next.algorithm = checkAlgorithm(patch.algorithm);
      if (patch.digits !== undefined) next.digits = checkDigits(Number(patch.digits));
      if (patch.period !== undefined) next.period = checkPeriod(Number(patch.period));
    }
    this.db
      .prepare('UPDATE authenticators SET label=?, test_user_id=?, issuer=?, account=?, secret=?, algorithm=?, digits=?, period=? WHERE id=?')
      .run(label, patch.testUserId !== undefined ? patch.testUserId : cur.test_user_id, next.issuer, next.account, next.secret, next.algorithm, next.digits, next.period, id);
    return this.require(projectId, id);
  }

  delete(projectId: string, id: string): Authenticator {
    const a = this.require(projectId, id);
    this.db.prepare('DELETE FROM authenticators WHERE id = ?').run(id);
    return a;
  }

  /** Accept either a raw base32 key (+ optional settings) or an otpauth:// link. */
  private resolve(input: AuthenticatorInput) {
    const raw = (input.secret ?? '').trim();
    if (!raw) throw new HttpError(400, 'Enter the secret key or the otpauth:// link from your app');
    if (raw.toLowerCase().startsWith('otpauth:')) {
      const p = parseOtpauth(raw);
      if (base32Decode(p.secret).length < 5) throw new HttpError(400, 'Secret key is too short');
      return {
        secret: p.secret,
        issuer: input.issuer?.trim() || p.issuer,
        account: input.account?.trim() || p.account,
        algorithm: p.algorithm,
        digits: p.digits,
        period: p.period,
      };
    }
    const secret = normalizeSecret(raw);
    if (base32Decode(secret).length < 5) throw new HttpError(400, 'Secret key is too short');
    return {
      secret,
      issuer: input.issuer?.trim() || null,
      account: input.account?.trim() || null,
      algorithm: checkAlgorithm(input.algorithm ?? 'SHA1'),
      digits: checkDigits(Number(input.digits ?? 6)),
      period: checkPeriod(Number(input.period ?? 30)),
    };
  }

  private checkUser(projectId: string, testUserId: string | null | undefined): void {
    if (!testUserId) return;
    const ok = this.db.prepare('SELECT 1 FROM test_users WHERE project_id = ? AND id = ?').get(projectId, testUserId);
    if (!ok) throw new HttpError(400, 'Linked test user does not exist in this project');
  }
}
