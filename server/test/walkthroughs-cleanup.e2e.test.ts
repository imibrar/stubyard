import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { DB, migrate } from '../src/db/index.js';
import { migrations } from '../src/db/migrations.js';
import type { Hub } from '../src/hub.js';
import { startHub, type RunningHub } from '../src/index.js';
import { WalkthroughServiceImpl } from '../src/storyboards/walkthroughs.js';

/**
 * Manual cleanup of walkthrough test data (migration 26, storyboards/cleanup.ts): fresh users and their messages,
 * quick runs' records, dependencies between runs, Keep pins, dismiss / reopen, DELETE ?users=1 and retention.
 */

const MAILPIT_BIN = process.env.STUBYARD_MAILPIT_BIN ?? '/usr/local/bin/mailpit';
const haveMailpit = fs.existsSync(MAILPIT_BIN);

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const STEPS = [
  { id: 'open', kind: 'open', title: 'Open the app', intent: 'Start', url: '/' },
  { id: 'look', kind: 'instruction', title: 'Look around', intent: 'Check the page' },
];

describe('migration 26', () => {
  it('adds the cleanup columns, keep and walkthrough_uses, and marks runs that created users pending', () => {
    const db = new DB(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const m of [...migrations].sort((a, b) => a.version - b.version).filter((m) => m.version < 26)) {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(m.version, new Date().toISOString());
    }
    const now = new Date().toISOString();
    db.prepare("INSERT INTO projects (id, slug, name, settings, created_at, updated_at) VALUES ('p1', 'old', 'Old', '{}', ?, ?)").run(now, now);
    db.prepare("INSERT INTO test_users (id, project_id, name, role, created_at) VALUES ('u1', 'p1', 'Fresh', 'member', ?)").run(now);
    const ins = db.prepare("INSERT INTO walkthroughs (id, project_id, key, status, snapshot, actors, started_at, updated_at) VALUES (?, 'p1', ?, 'finished', '{}', ?, ?, ?)");
    ins.run('w1', 'k1', JSON.stringify({ member: { userId: 'u1', email: null, name: 'Fresh', role: 'member', created: true } }), now, now);
    ins.run('w2', 'k2', JSON.stringify({ member: { userId: 'u1', email: null, name: 'Fresh', role: 'member', created: false } }), now, now);
    ins.run('w3', 'k3', '{}', now, now);

    migrate(db);
    const rows = db.prepare('SELECT id, cleanup_status, cleanup_at, cleanup_report FROM walkthroughs ORDER BY id').all() as { id: string; cleanup_status: string; cleanup_at: string | null; cleanup_report: string | null }[];
    expect(rows).toEqual([
      { id: 'w1', cleanup_status: 'pending', cleanup_at: null, cleanup_report: null },
      { id: 'w2', cleanup_status: 'none', cleanup_at: null, cleanup_report: null },
      { id: 'w3', cleanup_status: 'none', cleanup_at: null, cleanup_report: null },
    ]);
    expect((db.prepare("SELECT keep FROM test_users WHERE id = 'u1'").get() as { keep: number }).keep).toBe(0);
    db.prepare("INSERT INTO walkthrough_uses (walkthrough_id, project_id, source_walkthrough_id, user_id, kind, created_at) VALUES ('w2', 'p1', 'w1', 'u1', 'actor', ?)").run(now);
    // One row per (run, source, kind, user): NULL users count as equal.
    expect(() => db.prepare("INSERT INTO walkthrough_uses (walkthrough_id, project_id, source_walkthrough_id, user_id, kind, created_at) VALUES ('w2', 'p1', 'w1', 'u1', 'actor', ?)").run(now)).toThrow(/UNIQUE/);
    db.prepare("INSERT INTO walkthrough_uses (walkthrough_id, project_id, source_walkthrough_id, user_id, kind, created_at) VALUES ('w3', 'p1', 'w1', NULL, 'declared', ?)").run(now);
    expect(() => db.prepare("INSERT INTO walkthrough_uses (walkthrough_id, project_id, source_walkthrough_id, user_id, kind, created_at) VALUES ('w3', 'p1', 'w1', NULL, 'declared', ?)").run(now)).toThrow(/UNIQUE/);
    // Cascades with the source run.
    db.exec("DELETE FROM walkthroughs WHERE id = 'w1'");
    expect((db.prepare('SELECT COUNT(*) AS n FROM walkthrough_uses').get() as { n: number }).n).toBe(0);
    db.close();
  });
});

describe.skipIf(!haveMailpit)('walkthrough cleanup', () => {
  let running: RunningHub;
  let hub: Hub;
  let base: string;
  let dataDir: string;
  let smtpPort: number;
  let mailpitUrl: string;

  async function api<T = any>(method: string, p: string, body?: unknown): Promise<{ status: number; body: T }> {
    const r = await fetch(base + p, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* text */
    }
    return { status: r.status, body: parsed as T };
  }
  const ok = async <T = any>(method: string, p: string, body?: unknown, status = 200): Promise<T> => {
    const r = await api<T>(method, p, body);
    expect(r.status, `${method} ${p}: ${JSON.stringify(r.body)}`).toBe(status);
    return r.body;
  };

  /** A project with storyboards: signup (a fresh member), reuse (an existing member), plain (the admin only). */
  async function project(slug: string) {
    await ok('POST', '/api/projects', { name: slug, slug, generateUsers: { admins: 1, customers: 0 } }, 201);
    const PB = `/api/projects/${slug}`;
    await ok('POST', `${PB}/users`, { name: 'Member', role: 'member', email: `member@${slug}.test` }, 201);
    await ok('PUT', `${PB}/storyboards/signup`, { name: 'Sign up', actors: [{ key: 'member', role: 'member', fresh: true }], steps: STEPS }, 201);
    await ok('PUT', `${PB}/storyboards/reuse`, { name: 'Reuse', actors: [{ key: 'member', role: 'member' }], steps: STEPS }, 201);
    await ok('PUT', `${PB}/storyboards/plain`, { name: 'Plain', actors: [{ key: 'admin', role: 'admin' }], steps: STEPS }, 201);
    // Reuses a member and creates a fresh guest (so it has data of its own: cleanup pending).
    await ok('PUT', `${PB}/storyboards/mixed`, { name: 'Mixed', actors: [{ key: 'member', role: 'member' }, { key: 'guest', role: 'guest', fresh: true }], steps: STEPS }, 201);
    await ok('PUT', `${PB}/storyboards/plainfresh`, { name: 'Plain fresh', actors: [{ key: 'admin', role: 'admin' }, { key: 'guest', role: 'guest', fresh: true }], steps: STEPS }, 201);
    const W = `${PB}/walkthroughs`;
    const start = (storyboard: string, extra: Record<string, unknown> = {}) => ok('POST', W, { storyboard, ...extra }, 201);
    const finish = (w: any) => ok('POST', `${W}/${w.id}/finish`, w.mode === 'quick' ? {} : { verdict: 'pass', signedOffBy: 'QA', allowIncomplete: true });
    const cleanup = (body: unknown) => api('POST', `${PB}/cleanup`, body);
    const user = (id: string) => api('GET', `${PB}/users/${id}`);
    return { PB, W, start, finish, cleanup, user };
  }

  const mailer = () => nodemailer.createTransport({ host: '127.0.0.1', port: smtpPort, secure: false, ignoreTLS: true });
  async function sendMail(slug: string, userId: string, to: string, subject: string): Promise<{ id: string; mailpitId: string }> {
    await mailer().sendMail({ from: 'noreply@app.test', to, subject, text: `Hello ${to}` });
    const m = await ok('GET', `/api/projects/${slug}/messages/wait?user=${userId}&channel=email&q=${encodeURIComponent(subject)}&timeout=10`);
    let mailpitId = m.mailpitId as string | null;
    for (let i = 0; !mailpitId && i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      mailpitId = (hub.db.prepare('SELECT mailpit_id FROM messages WHERE id = ?').get(m.id) as { mailpit_id: string | null }).mailpit_id;
    }
    expect(mailpitId).toBeTruthy();
    return { id: m.id, mailpitId: mailpitId! };
  }
  const inMailpit = async (id: string) => (await fetch(`${hub.mailpit!.baseUrl}/api/v1/message/${id}`)).status === 200;
  /** Mailpit stores a relayed message shortly after it is queued. */
  const arrivesInMailpit = async (id: string) => {
    for (let i = 0; i < 50; i++) {
      if (await inMailpit(id)) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };
  const count = (sql: string, ...args: unknown[]) => (hub.db.prepare(sql).get(...(args as never[])) as { n: number }).n;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-cleanup-'));
    const [httpPort, httpsPort, smtp, mpHttp, mpSmtp] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
    smtpPort = smtp;
    mailpitUrl = `http://127.0.0.1:${mpHttp}`;
    const config = loadConfig({
      host: '127.0.0.1',
      httpPort,
      httpsPort,
      smtpPort,
      apnsPort: 0,
      dataDir,
      webDir: path.join(dataDir, 'no-web'),
      mailpitBin: MAILPIT_BIN,
      mailpitUrl,
      mailpitSmtpHost: '127.0.0.1',
      mailpitSmtpPort: mpSmtp,
      spawnMailpit: true,
      logLevel: 'silent',
      maintenanceIntervalMs: 0,
    });
    running = await startHub(config, { logger: pino({ level: 'silent' }) });
    hub = running.hub;
    base = `http://127.0.0.1:${httpPort}`;
  }, 60_000);

  afterAll(async () => {
    await running?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('a run is pending as soon as it creates a fresh user (at start or on refresh); none otherwise', async () => {
    const p = await project('cl-pending');
    const a = await p.start('signup');
    expect(a.cleanupStatus).toBe('pending');
    expect(a.cleanupAt).toBeNull();
    const b = await p.start('plain');
    expect(b.cleanupStatus).toBe('none');
    expect((await ok('GET', p.W)).find((x: any) => x.id === a.id)).toMatchObject({ cleanupStatus: 'pending', cleanupAt: null });
    // A later fresh actor (storyboard edited, run refreshed) makes the run pending.
    await ok('PUT', `${p.PB}/storyboards/plain`, { name: 'Plain', actors: [{ key: 'admin', role: 'admin' }, { key: 'guest', role: 'guest', fresh: true }], steps: STEPS });
    const refreshed = await ok('POST', `${p.W}/${b.id}/refresh`, {});
    expect(refreshed.actors.guest.created).toBe(true);
    expect(refreshed.cleanupStatus).toBe('pending');
  });

  it('records actor and declared dependencies; uses is validated', async () => {
    const p = await project('cl-deps');
    const a = await p.start('signup');
    const member = a.actors.member;
    const b = await p.start('reuse', { actors: { member: member.email } });
    expect(b.actors.member).toMatchObject({ userId: member.userId, created: false });
    const c = await p.start('plain', { uses: [a.key], mode: 'quick' });
    const rows = hub.db.prepare('SELECT walkthrough_id, source_walkthrough_id, user_id, kind FROM walkthrough_uses WHERE source_walkthrough_id = ? ORDER BY kind').all(a.id);
    expect(rows).toEqual([
      { walkthrough_id: b.id, source_walkthrough_id: a.id, user_id: member.userId, kind: 'actor' },
      { walkthrough_id: c.id, source_walkthrough_id: a.id, user_id: null, kind: 'declared' },
    ]);
    // A run using an existing non-fresh user records nothing.
    await p.start('plain');
    expect(count('SELECT COUNT(*) AS n FROM walkthrough_uses w JOIN walkthroughs x ON x.id = w.walkthrough_id WHERE x.project_id = (SELECT id FROM projects WHERE slug = ?)', 'cl-deps')).toBe(2);

    const bad = await api('POST', p.W, { storyboard: 'plain', uses: ['nope42'] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('nope42');
    expect((await api('POST', p.W, { storyboard: 'plain', uses: 'x' })).status).toBe(400);
    expect((await api('POST', p.W, { storyboard: 'plain', uses: Array.from({ length: 21 }, () => a.id) })).status).toBe(400);

    const item = await ok('GET', `${p.W}/${a.key}/cleanup`);
    expect(item.walkthrough).toMatchObject({ id: a.id, key: a.key, status: 'active', mode: 'tracked', cleanupStatus: 'pending', storyboard: { slug: 'signup', name: 'Sign up' } });
    expect(item.warnings[0]).toBe('Still active: finish or abandon it before cleaning up');
    expect(item.users).toHaveLength(1);
    expect(item.users[0]).toMatchObject({ userId: member.userId, email: member.email, role: 'member', exists: true, keep: false, messages: 0 });
    expect(item.users[0].usedBy.map((x: any) => x.key).sort()).toEqual([b.key, c.key].sort());
    expect(item.warnings).toContain(`User ${member.email} is used by runs ${b.key}, ${c.key}`);
    expect((await ok('GET', `${p.W}/${b.id}/cleanup`)).uses.map((x: any) => x.id)).toEqual([a.id]);
    expect((await ok('GET', `${p.W}/${c.id}/cleanup`)).uses.map((x: any) => x.id)).toEqual([a.id]);
  });

  it('list: non-active runs by cleanup status and mode, newest finished first, with counts', async () => {
    const p = await project('cl-list');
    const t1 = await p.start('signup');
    const q1 = await p.start('signup', { mode: 'quick' });
    const act = await p.start('signup');
    await p.start('plain'); // none: never listed
    await p.finish(t1);
    await new Promise((r) => setTimeout(r, 5));
    await p.finish(q1);
    const list = await ok('GET', `${p.PB}/cleanup`);
    expect(list.items.map((i: any) => i.walkthrough.id)).toEqual([q1.id, t1.id]);
    expect(list.counts).toEqual({ pending: 2, active: 1, cleaned: 0, dismissed: 0 });
    expect(list.truncated).toBe(false);
    expect(list.items.some((i: any) => i.walkthrough.id === act.id)).toBe(false);
    expect((await ok('GET', `${p.PB}/cleanup?mode=quick`)).items.map((i: any) => i.walkthrough.id)).toEqual([q1.id]);
    expect((await ok('GET', `${p.PB}/cleanup?mode=tracked`)).counts).toEqual({ pending: 1, active: 1, cleaned: 0, dismissed: 0 });
    expect((await ok('GET', `${p.PB}/cleanup?status=cleaned`)).items).toEqual([]);
    expect((await ok('GET', `${p.PB}/cleanup?status=all`)).items).toHaveLength(2);
    expect((await api('GET', `${p.PB}/cleanup?status=bogus`)).status).toBe(400);
    expect((await api('GET', `${p.PB}/cleanup?mode=bogus`)).status).toBe(400);
  });

  it('preview and dryRun change nothing; ask answers 409 with the conflicts; keep and include', async () => {
    const p = await project('cl-conf');
    const a = await p.start('signup');
    const m = a.actors.member;
    await p.finish(a);
    const b = await p.start('mixed', { actors: { member: m.userId } });
    const c = await p.start('plainfresh', { uses: [a.id], mode: 'quick' });

    // Active runs cannot be cleaned; unknown runs are 404.
    const active = await p.cleanup({ walkthroughs: [a.id, b.id] });
    expect(active.status).toBe(409);
    expect(active.body.error).toBe(`Walkthrough ${b.key} is still active: finish or abandon it first`);
    expect((await p.cleanup({ walkthroughs: ['nope'] })).status).toBe(404);
    expect((await p.cleanup({ walkthroughs: [] })).status).toBe(400);
    expect((await p.cleanup({ walkthroughs: [a.id], onConflict: 'maybe' })).status).toBe(400);

    // Preview: the user is used by B and C.
    const preview = await ok('GET', `${p.W}/${a.id}/cleanup`);
    expect(preview.removable).toEqual({ users: 0, messages: 0, record: false });

    const dry = await p.cleanup({ walkthroughs: [a.id], dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body.dryRun).toBe(true);
    expect(dry.body.conflicts).toHaveLength(1);
    expect(dry.body.conflicts[0]).toMatchObject({ userId: m.userId, email: m.email, walkthrough: { id: a.id } });
    expect(dry.body.conflicts[0].usedBy.map((x: any) => x.id).sort()).toEqual([b.id, c.id].sort());
    expect(dry.body.runs[0]).toMatchObject({ id: a.id, status: 'partial', removed: { users: 0, messages: 0, record: false } });
    expect(dry.body.runs[0].kept[0]).toMatchObject({ userId: m.userId, reason: 'used-by' });

    const ask = await p.cleanup({ walkthroughs: [a.id] });
    expect(ask.status).toBe(409);
    expect(ask.body.error).toContain(`is also used by runs ${b.key}, ${c.key}`);
    expect(ask.body.conflicts).toHaveLength(1);
    expect(ask.body.conflicts[0].usedBy).toHaveLength(2);
    expect((await p.user(m.userId)).status).toBe(200);
    expect((await ok('GET', `${p.W}/${a.id}`)).cleanupStatus).toBe('pending');

    // keep: the shared user stays, the run is partial and stays pending with its report.
    await p.finish(b);
    await p.finish(c);
    const kept = await p.cleanup({ walkthroughs: [a.id], onConflict: 'keep' });
    expect(kept.status).toBe(200);
    expect(kept.body.conflicts).toEqual([]);
    expect(kept.body.runs).toHaveLength(1);
    expect(kept.body.runs[0]).toMatchObject({ status: 'partial', kept: [{ userId: m.userId, reason: 'used-by' }] });
    expect((await p.user(m.userId)).status).toBe(200);
    const afterKeep = await ok('GET', `${p.W}/${a.id}/cleanup`);
    expect(afterKeep.walkthrough.cleanupStatus).toBe('pending');
    expect(afterKeep.lastReport).toMatchObject({ id: a.id, status: 'partial' });

    // include dryRun: B and C join the selection.
    const incDry = await p.cleanup({ walkthroughs: [a.id], onConflict: 'include', dryRun: true });
    expect(incDry.body.runs.map((r: any) => r.id).sort()).toEqual([a.id, b.id, c.id].sort());
    expect(incDry.body.conflicts).toEqual([]);
    expect(incDry.body.totals).toEqual({ users: 3, messages: 0, records: 1 });
    expect((await p.user(m.userId)).status).toBe(200);

    // include with an active dependent: it keeps the user (used-by-active); the non-active one is cleaned.
    await ok('POST', `${p.W}/${c.id}/reopen`, {});
    const inc1 = await p.cleanup({ walkthroughs: [a.id], onConflict: 'include' });
    expect(inc1.status).toBe(200);
    const byId = Object.fromEntries(inc1.body.runs.map((r: any) => [r.id, r]));
    expect(Object.keys(byId).sort()).toEqual([a.id, b.id].sort());
    expect(byId[a.id]).toMatchObject({ status: 'partial', kept: [{ userId: m.userId, reason: 'used-by-active' }] });
    expect(byId[a.id].kept[0].usedBy.map((x: any) => x.id)).toEqual([c.id]);
    expect(byId[b.id]).toMatchObject({ status: 'cleaned', removed: { users: 1, record: false } });
    expect((await ok('GET', `${p.W}/${b.id}`)).cleanupStatus).toBe('cleaned');

    // Once C is done, include cleans A and C (a quick run: its record goes too).
    await p.finish(c);
    const events: any[] = [];
    const off = hub.bus.subscribe((e) => events.push(e));
    try {
      const inc2 = await p.cleanup({ walkthroughs: [a.key], onConflict: 'include' });
      expect(inc2.status).toBe(200);
      expect(inc2.body.totals).toEqual({ users: 2, messages: 0, records: 1 });
    } finally {
      off();
    }
    expect((await p.user(m.userId)).status).toBe(404);
    expect((await api('GET', `${p.W}/${c.id}`)).status).toBe(404);
    const aView = await ok('GET', `${p.W}/${a.id}`);
    expect(aView.cleanupStatus).toBe('cleaned');
    expect(aView.cleanupAt).toBeTruthy();
    expect(events).toContainEqual(expect.objectContaining({ type: 'walkthrough.changed', data: { id: a.id, status: 'finished', cleanup: 'cleaned' } }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'walkthrough.changed', data: { id: c.id, status: 'finished', cleanup: 'cleaned', deleted: true } }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'user.changed', data: { deleted: m.userId } }));
  });

  it('removes messages and their Mailpit copies; quick records go, tracked runs keep their evidence', async () => {
    const slug = 'cl-msg';
    const p = await project(slug);
    const q = await p.start('signup', { mode: 'quick' });
    await ok('PATCH', `${p.W}/${q.id}`, { vars: { orderId: 'ORD-1' } });
    const t = await p.start('signup');
    await ok('PATCH', `${p.W}/${t.id}/steps/open`, { status: 'done', note: 'looked fine' });
    await ok('POST', `${p.W}/${t.id}/steps/open/shots`, { dataUrl: PNG }, 201);
    const mq = await sendMail(slug, q.actors.member.userId, q.actors.member.email, 'Welcome Q');
    const mt = await sendMail(slug, t.actors.member.userId, t.actors.member.email, 'Welcome T');
    expect(await arrivesInMailpit(mq.mailpitId)).toBe(true);
    expect(await arrivesInMailpit(mt.mailpitId)).toBe(true);
    await p.finish(q);
    await p.finish(t);

    const preview = await ok('GET', `${p.W}/${q.id}/cleanup`);
    expect(preview.removable).toEqual({ users: 1, messages: 1, record: true });
    expect(preview.vars).toEqual({ orderId: 'ORD-1' });
    expect(preview.users[0].messages).toBe(1);
    expect((await ok('GET', `${p.W}/${t.id}/cleanup`)).removable).toEqual({ users: 1, messages: 1, record: false });

    // dryRun: same numbers, nothing changes.
    const dry = await ok('POST', `${p.PB}/cleanup`, { walkthroughs: [q.id, t.id], dryRun: true });
    expect(dry.totals).toEqual({ users: 2, messages: 2, records: 1 });
    expect(count('SELECT COUNT(*) AS n FROM messages WHERE id IN (?, ?)', mq.id, mt.id)).toBe(2);
    expect((await p.user(q.actors.member.userId)).status).toBe(200);
    expect((await ok('GET', `${p.W}/${q.id}`)).cleanupStatus).toBe('pending');

    const res = await ok('POST', `${p.PB}/cleanup`, { walkthroughs: [q.id, t.id] });
    expect(res.dryRun).toBe(false);
    expect(res.totals).toEqual({ users: 2, messages: 2, records: 1 });
    const qr = res.runs.find((r: any) => r.id === q.id);
    expect(qr).toMatchObject({ key: q.key, mode: 'quick', status: 'cleaned', removed: { users: 1, messages: 1, record: true }, kept: [], vars: { orderId: 'ORD-1' } });

    // Messages gone (none left in Unassigned), Mailpit copies too.
    expect(count('SELECT COUNT(*) AS n FROM messages WHERE id IN (?, ?)', mq.id, mt.id)).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM messages WHERE project_id = (SELECT id FROM projects WHERE slug = ?) AND test_user_id IS NULL', slug)).toBe(0);
    expect(await inMailpit(mq.mailpitId)).toBe(false);
    expect(await inMailpit(mt.mailpitId)).toBe(false);

    // Quick record deleted (steps cascade); tracked record kept with its evidence.
    expect((await api('GET', `${p.W}/${q.id}`)).status).toBe(404);
    expect(count('SELECT COUNT(*) AS n FROM walkthrough_steps WHERE walkthrough_id = ?', q.id)).toBe(0);
    const tv = await ok('GET', `${p.W}/${t.id}`);
    expect(tv).toMatchObject({ status: 'finished', cleanupStatus: 'cleaned', signoff: { verdict: 'pass', signedOffBy: 'QA' } });
    expect(tv.steps[0]).toMatchObject({ status: 'done', note: 'looked fine' });
    expect(tv.steps[0].shots).toHaveLength(1);
    expect(tv.actors.member.missing).toBe(true);
    const ti = await ok('GET', `${p.W}/${t.id}/cleanup`);
    expect(ti.lastReport).toMatchObject({ id: t.id, status: 'cleaned', removed: { users: 1, messages: 1, record: false } });
    expect(ti.users[0]).toMatchObject({ exists: false });
    const listed = await ok('GET', `${p.PB}/cleanup?status=cleaned`);
    expect(listed.items.map((i: any) => i.walkthrough.id)).toEqual([t.id]);
    expect(listed.counts).toMatchObject({ pending: 0, cleaned: 1 });
  });

  it('Keep-pinned users are never deleted; skipped users make a partial run', async () => {
    const p = await project('cl-keep');
    const k = await p.start('signup');
    await p.finish(k);
    const ku = k.actors.member.userId;
    expect((await ok('PATCH', `${p.PB}/users/${ku}`, { keep: true })).keep).toBe(true);
    expect((await ok('GET', `${p.PB}/users/${ku}`)).keep).toBe(true);
    expect((await ok('GET', `${p.PB}/users`)).find((u: any) => u.id === ku).keep).toBe(true);
    const item = await ok('GET', `${p.W}/${k.id}/cleanup`);
    expect(item.users[0]).toMatchObject({ keep: true });
    expect(item.removable).toEqual({ users: 0, messages: 0, record: false });
    const res = await ok('POST', `${p.PB}/cleanup`, { walkthroughs: [k.id] });
    expect(res.runs[0]).toMatchObject({ status: 'cleaned', removed: { users: 0 }, kept: [{ userId: ku, reason: 'keep' }] });
    expect((await p.user(ku)).status).toBe(200);
    expect((await ok('GET', `${p.W}/${k.id}`)).cleanupStatus).toBe('cleaned');
    // DELETE ?users=1 never deletes it either.
    const d = await ok('DELETE', `${p.W}/${k.id}?users=1`);
    expect(d).toEqual({ deleted: k.id, users: 0, kept: [{ userId: ku, email: k.actors.member.email, reason: 'keep' }] });
    expect((await p.user(ku)).status).toBe(200);

    // Un-keeping the user of a cleaned run makes the run pending again.
    const k2 = await p.start('signup');
    await p.finish(k2);
    const k2u = k2.actors.member.userId;
    await ok('PATCH', `${p.PB}/users/${k2u}`, { keep: true });
    expect((await ok('GET', `${p.W}/${k2.id}`)).cleanupStatus).toBe('cleaned'); // settled: nothing left to remove
    await ok('PATCH', `${p.PB}/users/${k2u}`, { keep: false });
    expect((await ok('GET', `${p.W}/${k2.id}`)).cleanupStatus).toBe('pending');

    // Quick run with a kept user: cleaned, but its record stays while the user does (hidden from history as before).
    const q = await p.start('signup', { mode: 'quick' });
    const qu = q.actors.member.userId;
    await ok('PATCH', `${p.PB}/users/${qu}`, { keep: true });
    await p.finish(q);
    expect((await ok('GET', `${p.W}/${q.id}/cleanup`)).removable).toEqual({ users: 0, messages: 0, record: false });
    const qr = await ok('POST', `${p.PB}/cleanup`, { walkthroughs: [q.id] });
    expect(qr.runs[0]).toMatchObject({ status: 'cleaned', removed: { users: 0, record: false }, kept: [{ userId: qu, reason: 'keep' }] });
    expect((await p.user(qu)).status).toBe(200);
    expect((await ok('GET', `${p.W}/${q.id}`)).cleanupStatus).toBe('cleaned');
    expect((await ok('GET', p.W)).some((x: any) => x.id === q.id)).toBe(false); // quick runs stay out of the history
    // Un-keep: pending again, and the next cleanup removes the user and the record.
    await ok('PATCH', `${p.PB}/users/${qu}`, { keep: false });
    expect((await ok('GET', `${p.W}/${q.id}`)).cleanupStatus).toBe('pending');
    const qr2 = await ok('POST', `${p.PB}/cleanup`, { walkthroughs: [q.id] });
    expect(qr2.runs[0]).toMatchObject({ status: 'cleaned', removed: { users: 1, record: true } });
    expect((await api('GET', `${p.W}/${q.id}`)).status).toBe(404);

    // skipUsers: partial, stays pending with its report; a second cleanup finishes it.
    const s = await p.start('signup');
    await p.finish(s);
    const su = s.actors.member.userId;
    const partial = await ok('POST', `${p.PB}/cleanup`, { walkthroughs: [s.id], skipUsers: [su] });
    expect(partial.runs[0]).toMatchObject({ status: 'partial', removed: { users: 0 }, kept: [{ userId: su, reason: 'skipped' }] });
    const si = await ok('GET', `${p.W}/${s.id}/cleanup`);
    expect(si.walkthrough.cleanupStatus).toBe('pending');
    expect(si.lastReport).toMatchObject({ status: 'partial' });
    expect((await p.user(su)).status).toBe(200);
    const full = await ok('POST', `${p.PB}/cleanup`, { walkthroughs: [s.id] });
    expect(full.runs[0]).toMatchObject({ status: 'cleaned', removed: { users: 1 } });
    expect((await p.user(su)).status).toBe(404);
  });

  it('DELETE ?users=1 keeps users other runs still need and deletes the others with their messages', async () => {
    const slug = 'cl-del';
    const p = await project(slug);
    const a = await p.start('signup');
    await p.finish(a);
    const au = a.actors.member;
    const b = await p.start('reuse', { actors: { member: au.userId } });
    // Pending data: a plain DELETE is refused.
    const plain = await api('DELETE', `${p.W}/${a.id}`);
    expect(plain.status).toBe(409);
    expect(plain.body.error).toBe(`Walkthrough ${a.key} has test data to clean up: use Clean up, ?users=1, or ?force=1`);
    // users=1 with a user another run still needs: 409 listing it, unless force=1.
    const used = await api('DELETE', `${p.W}/${a.id}?users=1`);
    expect(used.status).toBe(409);
    expect(used.body.error).toContain(au.email);
    expect(used.body.details.kept[0]).toMatchObject({ userId: au.userId, reason: 'used-by-active' });
    expect((await api('GET', `${p.W}/${a.id}`)).status).toBe(200);
    const d = await ok('DELETE', `${p.W}/${a.id}?users=1&force=1`);
    expect(d.users).toBe(0);
    expect(d.kept).toHaveLength(1);
    expect(d.kept[0]).toMatchObject({ userId: au.userId, reason: 'used-by-active' });
    expect(d.kept[0].usedBy.map((x: any) => x.id)).toEqual([b.id]);
    expect((await p.user(au.userId)).status).toBe(200);
    expect((await api('GET', `${p.W}/${a.id}`)).status).toBe(404);

    const c = await p.start('signup');
    const cu = c.actors.member;
    const mail = await sendMail(slug, cu.userId, cu.email, 'Hi C');
    expect(await arrivesInMailpit(mail.mailpitId)).toBe(true);
    const dc = await ok('DELETE', `${p.W}/${c.id}?users=1`);
    expect(dc).toEqual({ deleted: c.id, users: 1, kept: [] });
    expect((await p.user(cu.userId)).status).toBe(404);
    expect(count('SELECT COUNT(*) AS n FROM messages WHERE id = ?', mail.id)).toBe(0);
    expect(await inMailpit(mail.mailpitId)).toBe(false);

    // force=1 alone: the record goes, the test data stays.
    const e = await p.start('signup');
    const f = await ok('DELETE', `${p.W}/${e.id}?force=1`);
    expect(f).toEqual({ deleted: e.id, users: 0, kept: [] });
    expect((await p.user(e.actors.member.userId)).status).toBe(200);
    // A run without data to clean deletes as before.
    const none = await p.start('plain');
    expect(await ok('DELETE', `${p.W}/${none.id}`)).toEqual({ deleted: none.id, users: 0, kept: [] });
  });

  it('dismiss and reopen', async () => {
    const p = await project('cl-dismiss');
    const a = await p.start('signup');
    expect((await api('POST', `${p.W}/${a.id}/cleanup/dismiss`, {})).status).toBe(409); // still active
    await p.finish(a);
    expect((await api('POST', `${p.W}/${a.id}/cleanup/reopen`, {})).status).toBe(409); // not dismissed
    expect((await api('POST', `${p.W}/${a.id}/cleanup/dismiss`, { note: 42 })).status).toBe(400);
    const dis = await ok('POST', `${p.W}/${a.id}/cleanup/dismiss`, { note: 'shared demo user' });
    expect(dis.walkthrough.cleanupStatus).toBe('dismissed');
    expect(dis.walkthrough.cleanupAt).toBeTruthy();
    expect(dis.warnings).toContain('Dismissed: the data stays (shared demo user)');
    expect((await p.user(a.actors.member.userId)).status).toBe(200);
    expect((await ok('GET', `${p.PB}/cleanup`)).items).toEqual([]);
    const dl = await ok('GET', `${p.PB}/cleanup?status=dismissed`);
    expect(dl.items.map((i: any) => i.walkthrough.id)).toEqual([a.id]);
    expect(dl.counts).toEqual({ pending: 0, active: 0, cleaned: 0, dismissed: 1 });
    const re = await ok('POST', `${p.W}/${a.key}/cleanup/reopen`, {});
    expect(re.walkthrough).toMatchObject({ cleanupStatus: 'pending', cleanupAt: null });
    expect((await ok('GET', `${p.PB}/cleanup`)).items.map((i: any) => i.walkthrough.id)).toEqual([a.id]);
    expect((await api('POST', `${p.W}/${a.id}/cleanup/reopen`, {})).status).toBe(409);
    // A cleaned run cannot be dismissed, nor reopened as a walkthrough.
    await ok('POST', `${p.PB}/cleanup`, { walkthroughs: [a.id] });
    expect((await api('POST', `${p.W}/${a.id}/cleanup/dismiss`, {})).status).toBe(409);
    const reopen = await api('POST', `${p.W}/${a.id}/reopen`, {});
    expect(reopen.status).toBe(409);
    expect(reopen.body.error).toBe('Its test data was cleaned up; start a new run');
    // A run that created nothing (none) has nothing to dismiss; it can still be reopened.
    const n = await p.start('plain');
    await p.finish(n);
    expect((await api('POST', `${p.W}/${n.id}/cleanup/dismiss`, {})).status).toBe(409);
    expect((await ok('POST', `${p.W}/${n.id}/reopen`, {})).status).toBe('active');
  });

  it('retention skips runs with pending cleanup; quick runs are no longer deleted automatically', async () => {
    const p = await project('cl-ret');
    const t = await p.start('signup');
    await p.finish(t);
    const q = await p.start('signup', { mode: 'quick' });
    await p.finish(q);
    const none = await p.start('plain');
    await p.finish(none);
    const report = await hub.maintenance.run(Date.now() + 400 * 86_400_000);
    expect(report.error).toBeUndefined();
    expect('quickRunsPurged' in report).toBe(false);
    expect((await api('GET', `${p.W}/${t.id}`)).status).toBe(200);
    expect((await api('GET', `${p.W}/${q.id}`)).status).toBe(200);
    expect((await api('GET', `${p.W}/${none.id}`)).status).toBe(404); // nothing to clean: retention applies
    // Once cleaned, the tracked run is subject to retention again.
    await ok('POST', `${p.PB}/cleanup`, { walkthroughs: [t.id] });
    await hub.maintenance.run(Date.now() + 400 * 86_400_000);
    expect((await api('GET', `${p.W}/${t.id}`)).status).toBe(404);
  });

  it('include pulls in dependents only through users that will be deleted', async () => {
    const p = await project('cl-incl');
    const a = await p.start('signup');
    await p.finish(a);
    const m = a.actors.member;
    const b = await p.start('mixed', { actors: { member: m.userId } });
    await p.finish(b);
    // The shared user is skipped: B is not cleaned along.
    const skipped = await ok('POST', `${p.PB}/cleanup`, { walkthroughs: [a.id], onConflict: 'include', skipUsers: [m.userId], dryRun: true });
    expect(skipped.runs.map((r: any) => r.id)).toEqual([a.id]);
    // Keep-pinned: same.
    await ok('PATCH', `${p.PB}/users/${m.userId}`, { keep: true });
    const kept = await ok('POST', `${p.PB}/cleanup`, { walkthroughs: [a.id], onConflict: 'include', dryRun: true });
    expect(kept.runs.map((r: any) => r.id)).toEqual([a.id]);
    await ok('PATCH', `${p.PB}/users/${m.userId}`, { keep: false });
    const both = await ok('POST', `${p.PB}/cleanup`, { walkthroughs: [a.id], onConflict: 'include', dryRun: true });
    expect(both.runs.map((r: any) => r.id).sort()).toEqual([a.id, b.id].sort());
    // skipUsers is capped.
    expect((await p.cleanup({ walkthroughs: [a.id], skipUsers: Array.from({ length: 501 }, (_, i) => `u${i}`) })).status).toBe(400);
  });

  it('a finished run that created nothing (none) does not block, and cleanup leaves its status alone', async () => {
    const p = await project('cl-none');
    const a = await p.start('signup');
    await p.finish(a);
    const m = a.actors.member;
    const b = await p.start('reuse', { actors: { member: m.userId } });
    expect(b.cleanupStatus).toBe('none');
    // Active: it still needs the user.
    expect((await ok('GET', `${p.W}/${a.id}/cleanup`)).users[0].usedBy.map((x: any) => x.id)).toEqual([b.id]);
    await p.finish(b);
    const item = await ok('GET', `${p.W}/${a.id}/cleanup`);
    expect(item.users[0].usedBy).toEqual([]);
    expect(item.removable).toEqual({ users: 1, messages: 0, record: false });
    // Selecting the none run explicitly changes nothing about it.
    const res = await ok('POST', `${p.PB}/cleanup`, { walkthroughs: [a.id, b.id] });
    expect(res.totals.users).toBe(1);
    expect((await ok('GET', `${p.W}/${b.id}`)).cleanupStatus).toBe('none');
    expect((await ok('GET', `${p.W}/${a.id}`)).cleanupStatus).toBe('cleaned');
  });

  it('pending runs settle to cleaned when nothing is left (user deleted through the API or elsewhere)', async () => {
    const p = await project('cl-settle');
    const a = await p.start('signup');
    await p.finish(a);
    await ok('DELETE', `${p.PB}/users/${a.actors.member.userId}`);
    expect((await ok('GET', `${p.W}/${a.id}`)).cleanupStatus).toBe('cleaned');
    // Deleted behind the API's back: listing settles it.
    const b = await p.start('signup', { mode: 'quick' });
    await p.finish(b);
    hub.users.delete(hub.projects.require('cl-settle').id, b.actors.member.userId);
    const list = await ok('GET', `${p.PB}/cleanup`);
    expect(list.items).toEqual([]);
    expect(list.counts.pending).toBe(0);
    expect((await ok('GET', `${p.W}/${b.id}`)).cleanupStatus).toBe('cleaned');
    // An active run stays pending until it ends.
    const c = await p.start('signup');
    hub.users.delete(hub.projects.require('cl-settle').id, c.actors.member.userId);
    expect((await ok('GET', `${p.W}/${c.id}/cleanup`)).walkthrough.cleanupStatus).toBe('pending');
    await p.finish(c);
    expect((await ok('GET', `${p.W}/${c.id}/cleanup`)).walkthrough.cleanupStatus).toBe('cleaned');
  });

  it('startup backfills actor dependencies of older runs (idempotent) and settles runs with nothing left', async () => {
    const p = await project('cl-backfill');
    const a = await p.start('signup');
    await p.finish(a);
    const m = a.actors.member;
    const b = await p.start('reuse', { actors: { member: m.userId } });
    const c = await p.start('signup');
    await p.finish(c);
    // As before migration 26: no dependency rows, and a pending run whose user is gone.
    hub.db.prepare('DELETE FROM walkthrough_uses WHERE walkthrough_id = ?').run(b.id);
    hub.users.delete(hub.projects.require('cl-backfill').id, c.actors.member.userId);
    const uses = () => hub.db.prepare('SELECT walkthrough_id, source_walkthrough_id, user_id, kind FROM walkthrough_uses WHERE walkthrough_id = ?').all(b.id);
    expect(uses()).toEqual([]);
    new WalkthroughServiceImpl(hub);
    expect(uses()).toEqual([{ walkthrough_id: b.id, source_walkthrough_id: a.id, user_id: m.userId, kind: 'actor' }]);
    new WalkthroughServiceImpl(hub);
    expect(uses()).toHaveLength(1);
    expect((hub.db.prepare('SELECT cleanup_status FROM walkthroughs WHERE id = ?').get(c.id) as { cleanup_status: string }).cleanup_status).toBe('cleaned');
    expect((await ok('GET', `${p.W}/${a.id}/cleanup`)).users[0].usedBy.map((x: any) => x.id)).toEqual([b.id]);
  });

  it('fresh actors of one run get distinct names', async () => {
    const p = await project('cl-names');
    await ok('PUT', `${p.PB}/storyboards/pair`, { name: 'Pair', actors: [{ key: 'buyer', role: 'member', fresh: true }, { key: 'seller', role: 'member', fresh: true }, { key: 'third', role: 'guest', fresh: true }], steps: STEPS }, 201);
    for (let i = 0; i < 3; i++) {
      const w = await p.start('pair');
      const names = Object.values(w.actors).map((x: any) => x.name);
      expect(new Set(names).size).toBe(3);
    }
  });

  it('GET /cleanup reports truncated when the 500 cap cuts the list', async () => {
    const p = await project('cl-cap');
    const pid = hub.projects.require('cl-cap').id;
    const now = new Date().toISOString();
    const ins = hub.db.prepare("INSERT INTO walkthroughs (id, project_id, key, status, snapshot, actors, started_at, updated_at, finished_at, cleanup_status) VALUES (?, ?, ?, 'finished', '{}', '{}', ?, ?, ?, 'cleaned')");
    hub.db.transaction(() => {
      for (let i = 0; i < 501; i++) ins.run(`cap-${i}`, pid, `cap${i}`, now, now, now);
    })();
    const list = await ok('GET', `${p.PB}/cleanup?status=cleaned`);
    expect(list.items).toHaveLength(500);
    expect(list.truncated).toBe(true);
    expect((await ok('GET', `${p.PB}/cleanup`)).truncated).toBe(false);
  });

  it('export and import carry keep', async () => {
    await ok('POST', '/api/projects', { name: 'Keep src', slug: 'cl-exp' }, 201);
    const u = await ok('POST', '/api/projects/cl-exp/users', { name: 'Fixture', role: 'member', email: 'fixture@cl.test', keep: true }, 201);
    expect(u.keep).toBe(true);
    await ok('POST', '/api/projects/cl-exp/users', { name: 'Plain', role: 'member', email: 'plain@cl.test' }, 201);
    const ex = await ok('GET', '/api/projects/cl-exp/export');
    expect(ex.users.find((x: any) => x.email === 'fixture@cl.test').keep).toBe(true);
    expect(ex.users.find((x: any) => x.email === 'plain@cl.test').keep).toBe(false);
    const imp = await api('POST', '/api/projects/import', { ...ex, project: { ...ex.project, name: 'Keep copy', slug: 'cl-exp2' } });
    expect(imp.status).toBeLessThan(300);
    const users = await ok('GET', '/api/projects/cl-exp2/users');
    expect(users.find((x: any) => x.email === 'fixture@cl.test').keep).toBe(true);
    expect(users.find((x: any) => x.email === 'plain@cl.test').keep).toBe(false);
  });
});
