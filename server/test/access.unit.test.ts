import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { DB, migrate } from '../src/db/index.js';
import { adminPasswordHash, checkHash, hashPassword, parseHash, safeEqual, verifyPassword, verifyPasswordAsync } from '../src/access/password.js';
import { LoginLimiter } from '../src/access/limiter.js';
import { authWarnings } from '../src/access/service.js';
import { allows, ROLE_PERMISSIONS } from '../src/access/permissions.js';

/** Sign-in building blocks: password hashes, the login limiter, the admin settings from the environment. */

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const CLEAR = { STUBYARD_TRUST_PROXY: undefined as string | undefined, STUBYARD_ADMIN_EMAIL: undefined, STUBYARD_ADMIN_PASSWORD: undefined, STUBYARD_ADMIN_PASSWORD_HASH: undefined, DEVHUB_ADMIN_EMAIL: undefined, DEVHUB_ADMIN_PASSWORD: undefined, STUBYARD_COOKIE_SECURE: undefined, STUBYARD_SESSION_TTL_HOURS: undefined, STUBYARD_PUBLIC_URL: undefined };

describe('password hashes (scrypt)', () => {
  it('round-trips and rejects wrong or malformed input', () => {
    const h = hashPassword('s3cret-pass');
    expect(h).toMatch(/^scrypt:16384:8:1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    expect(h).not.toContain('$');
    expect(verifyPassword('s3cret-pass', h)).toBe(true);
    expect(verifyPassword('s3cret-pasS', h)).toBe(false);
    expect(verifyPassword('s3cret-pass', 'scrypt:16384:8:1:abc')).toBe(false);
    expect(verifyPassword('s3cret-pass', 'bcrypt$2b$10$abc')).toBe(false);
    expect(hashPassword('same-pass')).not.toBe(hashPassword('same-pass')); // random salt
  });

  it('refuses hashes with absurd cost parameters', () => {
    expect(parseHash('scrypt:3:8:1:AAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAA')).toBeNull(); // N not a power of two
    expect(parseHash('scrypt:4194304:8:1:AAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAA')).toBeNull(); // N too large
    expect(parseHash('scrypt:16384:8:1:AAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAA')).not.toBeNull();
    // 128 * N * r must stay within 256 MiB, and p within 4.
    expect(parseHash('scrypt:262144:8:4:AAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAA')).not.toBeNull(); // exactly 256 MiB
    expect(checkHash('scrypt:524288:8:1:AAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAA')).toEqual({ error: expect.stringMatching(/512 MiB.*at most 256 MiB/) });
    expect(checkHash('scrypt:16384:32:1:AAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAA')).toEqual({ hash: expect.anything() }); // 64 MiB
    expect(checkHash('scrypt:16384:8:5:AAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAA')).toEqual({ error: expect.stringMatching(/p = 5; at most 4/) });
    expect(() => adminPasswordHash('a@b.test', '', 'scrypt:1048576:8:1:AAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAA')).toThrow(/STUBYARD_ADMIN_PASSWORD_HASH is refused: its cost needs 1024 MiB/);
  });

  it('checks passwords off the event loop', async () => {
    const h = hashPassword('async-check-pw');
    let ticked = false;
    setImmediate(() => (ticked = true));
    const p = verifyPasswordAsync('async-check-pw', h);
    expect(ticked).toBe(false);
    expect(await p).toBe(true);
    expect(ticked).toBe(true); // the event loop ran while scrypt worked
    expect(await verifyPasswordAsync('wrong-password', h)).toBe(false);
    expect(await verifyPasswordAsync('x', 'garbage')).toBe(false);
  });

  it('hashes a plain env password the same way on every start (sessions survive a restart)', () => {
    const a = adminPasswordHash('a@b.test', 'long enough', '');
    expect(adminPasswordHash('a@b.test', 'long enough', '')).toBe(a);
    expect(verifyPassword('long enough', a)).toBe(true);
    expect(adminPasswordHash('c@b.test', 'long enough', '')).not.toBe(a);
    expect(() => adminPasswordHash('a@b.test', 'short', '')).toThrow(/at least 8/);
    expect(() => adminPasswordHash('a@b.test', '', 'nope')).toThrow(/not a stubyard scrypt hash/);
  });

  it('compares strings in constant time', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('login limiter', () => {
  it('blocks after 5 failures per e-mail + IP within 15 minutes, then lets go', () => {
    let now = 1_000_000;
    const l = new LoginLimiter(5, 15 * 60_000, () => now);
    for (let i = 0; i < 4; i++) l.fail('A@x.test', '1.2.3.4');
    expect(l.retryAfter('a@x.test', '1.2.3.4')).toBe(0);
    l.fail('a@x.test', '1.2.3.4');
    expect(l.retryAfter('a@x.test', '1.2.3.4')).toBe(900);
    expect(l.retryAfter('a@x.test', '5.6.7.8')).toBe(0);
    expect(l.retryAfter('b@x.test', '1.2.3.4')).toBe(0);
    now += 10 * 60_000;
    expect(l.retryAfter('a@x.test', '1.2.3.4')).toBe(300);
    now += 5 * 60_000 + 1;
    expect(l.retryAfter('a@x.test', '1.2.3.4')).toBe(0);
    l.fail('a@x.test', '1.2.3.4');
    l.succeed('a@x.test', '1.2.3.4');
    expect(l.retryAfter('a@x.test', '1.2.3.4')).toBe(0);
  });

  it('limits failures per IP across made-up e-mails, but not for the admin e-mail', () => {
    let now = 0;
    const l = new LoginLimiter(5, 15 * 60_000, () => now, 10_000, 20);
    for (let i = 0; i < 20; i++) l.fail(`random${i}@x.test`, '6.6.6.6');
    expect(l.retryAfter('fresh@x.test', '6.6.6.6')).toBe(900);
    expect(l.retryAfter('fresh@x.test', '7.7.7.7')).toBe(0);
    expect(l.retryAfter('admin@x.test', '6.6.6.6', true)).toBe(0);
  });

  it('slows the admin e-mail down step by step instead of locking it out', () => {
    let now = 0;
    const l = new LoginLimiter(5, 15 * 60_000, () => now);
    for (let i = 0; i < 5; i++) l.fail('admin@x.test', '1.1.1.1');
    expect(l.retryAfter('admin@x.test', '1.1.1.1', true)).toBe(2);
    now += 2000;
    expect(l.retryAfter('admin@x.test', '1.1.1.1', true)).toBe(0);
    l.fail('admin@x.test', '1.1.1.1');
    expect(l.retryAfter('admin@x.test', '1.1.1.1', true)).toBe(4);
    for (let i = 0; i < 10; i++) l.fail('admin@x.test', '1.1.1.1');
    expect(l.retryAfter('admin@x.test', '1.1.1.1', true)).toBe(60); // capped
    // The same failures from a non-admin e-mail would be a 15-minute block.
    expect(l.retryAfter('admin@x.test', '1.1.1.1', false)).toBeGreaterThan(800);
  });

  it('bounds the number of tracked pairs', () => {
    const l = new LoginLimiter(5, 60_000, Date.now, 100);
    for (let i = 0; i < 500; i++) l.fail(`u${i}@x.test`, '1.1.1.1');
    expect((l as unknown as { failures: Map<string, number[]> }).failures.size).toBeLessThanOrEqual(100);
  });
});

describe('admin settings from the environment', () => {
  it('is Open mode without settings', () => {
    withEnv(CLEAR, () => {
      const c = loadConfig();
      expect(c.admin).toBeNull();
      expect(c.sessionTtlHours).toBe(168);
      expect(c.cookieSecure).toBe(false);
    });
  });

  it('turns on Single admin mode with an e-mail and a password (never kept in plain text)', () => {
    withEnv({ ...CLEAR, STUBYARD_ADMIN_EMAIL: 'Boss@Example.test', STUBYARD_ADMIN_PASSWORD: 'hunter2-hunter2' }, () => {
      const c = loadConfig();
      expect(c.admin?.email).toBe('boss@example.test');
      expect(verifyPassword('hunter2-hunter2', c.admin!.passwordHash)).toBe(true);
      expect(JSON.stringify(c)).not.toContain('hunter2');
    });
  });

  it('accepts a ready hash, and the legacy DEVHUB_ names', () => {
    const hash = hashPassword('from-a-hash');
    withEnv({ ...CLEAR, STUBYARD_ADMIN_EMAIL: 'a@b.test', STUBYARD_ADMIN_PASSWORD_HASH: hash }, () => {
      expect(loadConfig().admin).toEqual({ email: 'a@b.test', passwordHash: hash });
    });
    withEnv({ ...CLEAR, DEVHUB_ADMIN_EMAIL: 'old@b.test', DEVHUB_ADMIN_PASSWORD: 'legacy-password' }, () => {
      expect(loadConfig().admin?.email).toBe('old@b.test');
    });
  });

  it('refuses half or conflicting settings', () => {
    withEnv({ ...CLEAR, STUBYARD_ADMIN_EMAIL: 'a@b.test' }, () => expect(() => loadConfig()).toThrow(/neither/));
    withEnv({ ...CLEAR, STUBYARD_ADMIN_PASSWORD: 'long enough pw' }, () => expect(() => loadConfig()).toThrow(/STUBYARD_ADMIN_EMAIL is not/));
    withEnv({ ...CLEAR, STUBYARD_ADMIN_EMAIL: 'a@b.test', STUBYARD_ADMIN_PASSWORD: 'long enough pw', STUBYARD_ADMIN_PASSWORD_HASH: hashPassword('x-long-pw') }, () => expect(() => loadConfig()).toThrow(/not both/));
    withEnv({ ...CLEAR, STUBYARD_ADMIN_EMAIL: 'not-an-email', STUBYARD_ADMIN_PASSWORD: 'long enough pw' }, () => expect(() => loadConfig()).toThrow(/e-mail address/));
    withEnv({ ...CLEAR, STUBYARD_ADMIN_EMAIL: 'a@b.test', STUBYARD_ADMIN_PASSWORD: 'short' }, () => expect(() => loadConfig()).toThrow(/at least 8/));
  });

  it('reads the session TTL and the Secure flag', () => {
    withEnv({ ...CLEAR, STUBYARD_SESSION_TTL_HOURS: '12', STUBYARD_COOKIE_SECURE: '1' }, () => {
      const c = loadConfig();
      expect(c.sessionTtlHours).toBe(12);
      expect(c.cookieSecure).toBe(true);
    });
    withEnv({ ...CLEAR, STUBYARD_PUBLIC_URL: 'https://hub.example.com' }, () => expect(loadConfig().cookieSecure).toBe(true));
    withEnv({ ...CLEAR, STUBYARD_PUBLIC_URL: 'https://hub.example.com', STUBYARD_COOKIE_SECURE: 'off' }, () => expect(loadConfig().cookieSecure).toBe(false));
    withEnv({ ...CLEAR, STUBYARD_SESSION_TTL_HOURS: '0' }, () => expect(() => loadConfig()).toThrow(/positive/));
  });

  it('reads STUBYARD_TRUST_PROXY', () => {
    const tp = (v: string | undefined) => withEnv({ ...CLEAR, STUBYARD_TRUST_PROXY: v }, () => loadConfig().trustProxy);
    expect(tp(undefined)).toBe(false);
    expect(tp('off')).toBe(false);
    expect(tp('true')).toBe(true);
    expect(tp('1')).toBe(1);
    expect(tp('10.0.0.0/8, 192.168.1.5,loopback')).toEqual(['10.0.0.0/8', '192.168.1.5', 'loopback']);
    expect(() => tp('proxy.example.com')).toThrow(/STUBYARD_TRUST_PROXY/);
  });

  it('warns when sign-in runs over plain HTTP to another machine', () => {
    const admin = { email: 'a@b.test', passwordHash: hashPassword('whatever-pw') };
    const base = withEnv(CLEAR, () => loadConfig({ admin }));
    expect(authWarnings({ ...base, admin: null, publicUrl: 'http://10.0.0.5:4000' })).toEqual([]);
    expect(authWarnings({ ...base, publicUrl: 'http://localhost:4000' })).toEqual([]);
    expect(authWarnings({ ...base, publicUrl: 'https://hub.example.com', cookieSecure: true })).toEqual([]);
    expect(authWarnings({ ...base, publicUrl: 'http://10.0.0.5:4000' })[0]).toMatch(/plain HTTP/);
    expect(authWarnings({ ...base, publicUrl: null, allowedHosts: ['hub.lan'] })[0]).toMatch(/hub\.lan/);
  });
});

describe('migration 29', () => {
  it('creates auth_sessions and api_tokens once', () => {
    const db = new DB(':memory:');
    migrate(db);
    migrate(db);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('auth_sessions', 'api_tokens') ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(['api_tokens', 'auth_sessions']);
    expect((db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 29').get() as { n: number }).n).toBe(1);
    db.close();
  });
});

describe('roles', () => {
  it('gives the single admin every permission, and the plan\'s matrix to the project roles', () => {
    expect([...ROLE_PERMISSIONS.admin]).toContain('instance.admin');
    expect(allows('admin', 'project.reset')).toBe(true);
    expect(allows('project_admin', 'instance.admin')).toBe(false);
    expect(allows('project_admin', 'project.reset')).toBe(true);
    expect(allows('developer', 'project.providers')).toBe(true);
    expect(allows('project_manager', 'project.providers')).toBe(false);
    expect(allows('designer', 'features.details')).toBe(true);
    expect(allows('designer', 'features.edit')).toBe(false);
    expect(allows('qa', 'walkthroughs.run')).toBe(true);
    expect(allows('viewer', 'project.view')).toBe(true);
    expect(allows('viewer', 'walkthroughs.run')).toBe(false);
  });
});
