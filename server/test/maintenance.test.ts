import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import type { Hub } from '../src/hub.js';
import { createHub } from '../src/index.js';
import { exportProject, importProject, registerExportSection, EXPORT_SECTIONS } from '../src/maintenance/export.js';
import { matchMock, matchPath, renderTemplate } from '../src/mocks/match.js';
import { pickScenario } from '../src/mocks/handler.js';
import { newId } from '../src/util.js';

describe('mock matching and templating', () => {
  it('matches path patterns with params and wildcards', () => {
    expect(matchPath('/users/:id', '/users/42')).toEqual({ id: '42' });
    expect(matchPath('/users/:id', '/users/42/')).toEqual({ id: '42' });
    expect(matchPath('/users/:id', '/users')).toBeNull();
    expect(matchPath('/a/:x/b/:y', '/a/1/b/hello%20world')).toEqual({ x: '1', y: 'hello world' });
    expect(matchPath('/files/*', '/files/a/b/c.txt')).toEqual({ '*': 'a/b/c.txt' });
    expect(matchPath('/files/*', '/files')).toEqual({ '*': '' });
    expect(matchPath('/img/*.png', '/img/logo.png')).toEqual({});
    expect(matchPath('/img/*.png', '/img/logo.jpg')).toBeNull();
    expect(matchPath('/', '/')).toEqual({});
  });

  it('checks method, query, headers and body', () => {
    const req = { method: 'POST', path: '/pay', query: { mode: 'test' }, headers: { 'x-tenant': 'acme' }, rawBody: '{"a":{"b":[{"c":5}]}}', body: { a: { b: [{ c: 5 }] } } };
    expect(matchMock({ method: 'POST', path: '/pay', match: { query: { mode: 'test' }, headers: { 'X-Tenant': '*' }, bodyJson: { 'a.b.0.c': 5 } } }, req).ok).toBe(true);
    expect(matchMock({ method: 'POST', path: '/pay', match: { bodyJson: { 'a.b[0].c': '5' } } }, req).ok).toBe(true);
    expect(matchMock({ method: 'GET,HEAD', path: '/pay', match: {} }, req).reason).toBe('method is GET,HEAD');
    expect(matchMock({ method: 'ANY', path: '/pay', match: { query: { mode: 'live' } } }, req).reason).toMatch(/query "mode"/);
    expect(matchMock({ method: 'ANY', path: '/pay', match: { bodyContains: 'zzz' } }, req).ok).toBe(false);
  });

  it('renders templates', () => {
    const out = renderTemplate('{{params.id}}|{{query.q}}|{{headers.x-a}}|{{body.user.name}}|{{body.list}}|{{missing.x}}|{{ uuid }}', {
      params: { id: '7' },
      query: { q: ['first', 'second'] },
      headers: { 'x-a': 'h' },
      body: { user: { name: 'Sara' }, list: [1, 2] },
      method: 'GET',
      path: '/x',
    });
    const [id, q, h, name, list, missing, uuid] = out.split('|');
    expect([id, q, h, name, list, missing]).toEqual(['7', 'first', 'h', 'Sara', '[1,2]', '']);
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('picks scenarios from the X-Hub-Scenario header', () => {
    const mock = {
      activeScenario: 'OK',
      scenarios: [
        { name: 'OK', status: 200, headers: {}, body: '', delayMs: 0, behaviour: 'respond' as const },
        { name: 'Card declined', status: 402, headers: {}, body: '', delayMs: 0, behaviour: 'respond' as const },
      ],
    } as Parameters<typeof pickScenario>[0];
    expect(pickScenario(mock, null).scenario.name).toBe('OK');
    expect(pickScenario(mock, 'card DECLINED').scenario.status).toBe(402);
    expect(pickScenario(mock, 'timeout').scenario.behaviour).toBe('timeout');
    expect(pickScenario(mock, 'status:418').scenario.status).toBe(418);
    expect(pickScenario(mock, 'delay:250').scenario.delayMs).toBe(250);
    expect(pickScenario(mock, 'what').unknownHeader).toBe('what');
  });
});

describe('maintenance and export (in-memory hub)', () => {
  let hub: Hub;
  let dir: string;
  const make = (overrides: Partial<Config> = {}) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-maint-'));
    hub = createHub(loadConfig({ dataDir: dir, logLevel: 'silent', maintenanceIntervalMs: 0, ...overrides }), {
      mailpit: null,
      tls: false,
      dbFile: ':memory:',
      logger: pino({ level: 'silent' }),
    });
  };
  const addLog = (projectId: string | null, receivedAt: string, body = '') =>
    hub.db
      .prepare("INSERT INTO traffic_logs (id, project_id, direction, protocol, method, url, req_body, received_at, outcome) VALUES (?,?, 'inbound','http','GET','/x',?,?, 'ok')")
      .run(newId(), projectId, body, receivedAt);
  const count = (sql: string, ...args: unknown[]) => (hub.db.prepare(sql).get(...args) as { n: number }).n;

  beforeEach(() => make());
  afterEach(() => {
    hub.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('deletes logs past the global and per-project retention', () => {
    const a = hub.projects.create({ name: 'A' });
    const b = hub.projects.create({ name: 'B', settings: { retentionDays: 1 } });
    const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    addLog(a.id, days(8));
    addLog(a.id, days(2));
    addLog(b.id, days(2));
    addLog(b.id, days(0));
    addLog(null, days(30));
    expect(hub.maintenance.pruneExpiredLogs()).toBe(3);
    expect(count('SELECT COUNT(*) AS n FROM traffic_logs WHERE project_id = ?', a.id)).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM traffic_logs WHERE project_id = ?', b.id)).toBe(1);
  });

  it('deletes the oldest logs first when the database is over the size limit', () => {
    hub.db.close();
    make({ maxDbMb: 1 }); // the empty schema alone is ~0.6 MB since chat + payments tables
    const p = hub.projects.create({ name: 'Big' });
    const big = 'x'.repeat(20_000);
    for (let i = 0; i < 200; i++) addLog(p.id, new Date(Date.now() - (200 - i) * 1000).toISOString(), big); // ~4 MB
    const newest = hub.db.prepare('SELECT id FROM traffic_logs ORDER BY received_at DESC LIMIT 1').get() as { id: string };
    expect(hub.maintenance.storage().usedBytes).toBeGreaterThan(1024 * 1024);
    const r = hub.maintenance.pruneForSize();
    expect(r.deleted).toBeGreaterThan(100);
    expect(r.vacuumed).toBe(true);
    expect(hub.maintenance.storage().fileBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(hub.logs.get(newest.id)).not.toBeNull();
  });

  it('auto-resets data older than settings.autoResetDays', async () => {
    const p = hub.projects.create({ name: 'Auto', settings: { autoResetDays: 2 } });
    const keep = hub.projects.create({ name: 'Keep' });
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
    for (const proj of [p, keep]) {
      hub.db.prepare("INSERT INTO messages (id, project_id, channel, direction, to_addr, status, created_at) VALUES (?, ?, 'sms', 'outbound', '+1', 'delivered', ?)").run(newId(), proj.id, old);
      hub.db.prepare("INSERT INTO messages (id, project_id, channel, direction, to_addr, status, created_at) VALUES (?, ?, 'sms', 'outbound', '+1', 'delivered', ?)").run(newId(), proj.id, new Date().toISOString());
      addLog(proj.id, old);
    }
    const r = await hub.maintenance.run();
    expect(r.autoReset).toEqual([{ project: 'auto', messages: 1, logs: 1 }]);
    expect(count('SELECT COUNT(*) AS n FROM messages WHERE project_id = ?', p.id)).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM messages WHERE project_id = ?', keep.id)).toBe(2);
  });

  it('lets other modules register export sections', () => {
    const before = EXPORT_SECTIONS.length;
    const seen: unknown[] = [];
    registerExportSection({ key: 'extras', export: () => [{ id: 'e1', v: 1 }], import: (_ctx, rows) => (seen.push(...rows), rows.length) }, { after: 'providers' });
    try {
      const p = hub.projects.create({ name: 'Src' });
      hub.users.create(p.id, { name: 'U', email: 'u@x.test' });
      const file = exportProject(hub, p);
      expect(file.extras).toEqual([{ id: 'e1', v: 1 }]);
      const r = importProject(hub, file, { slug: 'dst' });
      expect(r.imported).toMatchObject({ users: 1, extras: 1 });
      expect(seen).toEqual([{ id: 'e1', v: 1 }]);
      expect(hub.providers.defaultFor(r.project.id, 'email')?.slug).toBe('mail');
    } finally {
      EXPORT_SECTIONS.splice(EXPORT_SECTIONS.findIndex((s) => s.key === 'extras'), 1);
    }
    expect(EXPORT_SECTIONS.length).toBe(before);
  });
});
