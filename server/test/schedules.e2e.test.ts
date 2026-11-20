import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import type { Hub } from '../src/hub.js';
import { createHub } from '../src/index.js';

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

let hub: Hub;
let close: () => Promise<void>;
let base: string;
let dataDir: string;
let appServer: http.Server;
let appUrl: string;
const received: { path: string; body: string }[] = [];

async function api<T = any>(method: string, p: string, body?: unknown): Promise<{ status: number; body: T }> {
  const r = await fetch(base + p, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: r.status, body: parsed as T };
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 6000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 40));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SCH = '/api/projects/sched/schedules';
const get = async (id: string) => (await api('GET', `${SCH}/${id}`)).body;
const settled = (id: string, status: string, timeoutMs?: number) => waitFor(async () => ((await get(id)).status === status ? get(id) : null), timeoutMs);
const hits = (p: string) => received.filter((r) => r.path === p).length;

const mcp = async (name: string, args: Record<string, unknown>) => {
  const r = await api('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  if (r.body.result.isError) throw new Error(r.body.result.content[0].text);
  return JSON.parse(r.body.result.content[0].text);
};

let tpl: string; // template -> /hook-a
const send = (extra: Record<string, unknown>) => api('POST', SCH, { method: 'POST', path: `/webhook-templates/${tpl}/send`, body: { data: { n: 1 } }, ...extra });

describe('scheduled actions', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-sched-'));
    const httpPort = await freePort();
    const config = loadConfig({ host: '127.0.0.1', httpPort, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0 });
    hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger: pino({ level: 'silent' }) });
    const { app } = await buildApp(hub, pino({ level: 'silent' }));
    await app.listen({ port: httpPort, host: '127.0.0.1' });
    hub.scheduler.start(30);
    close = async () => {
      await hub.scheduler.stop();
      await app.close();
      hub.db.close();
    };
    base = `http://127.0.0.1:${httpPort}`;
    appServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ path: req.url ?? '', body });
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', () => r()));
    appUrl = `http://127.0.0.1:${(appServer.address() as net.AddressInfo).port}`;
    expect((await api('POST', '/api/projects', { name: 'Sched', slug: 'sched', generateUsers: { admins: 1, customers: 2 } })).status).toBe(201);
    expect((await api('POST', '/api/projects', { name: 'Other', slug: 'other' })).status).toBe(201);
    const t = await api('POST', '/api/projects/sched/webhook-templates', { name: 'order.paid', targetUrl: `${appUrl}/hook-a`, bodyTemplate: '{"n":{{data.n}}}' });
    expect(t.status).toBe(201);
    tpl = t.body.id;
  });

  afterAll(async () => {
    appServer?.close();
    await close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('rejects calls outside the allowlist and bad timing', async () => {
    const bad = async (b: Record<string, unknown>) => (await api('POST', SCH, { delayMs: 1000, ...b })).status;
    expect(await bad({ method: 'GET', path: `/webhook-templates/${tpl}/send` })).toBe(400);
    expect(await bad({ method: 'POST', path: '/reset' })).toBe(400);
    expect(await bad({ method: 'DELETE', path: '/users/admin' })).toBe(400);
    expect(await bad({ method: 'POST', path: `/webhook-templates/${tpl}/send?x=1` })).toBe(400);
    expect(await bad({ method: 'POST', path: `/api/projects/other/webhook-templates/${tpl}/send` })).toBe(400);
    expect(await bad({ method: 'POST', path: '/mock/sched/sms/x' })).toBe(400);
    expect(await bad({ method: 'POST', path: '/users/../reset/reply' })).toBe(400);
    const r = await api('POST', SCH, { method: 'POST', path: '/system/maintenance', delayMs: 10 });
    expect(r.body.error).toMatch(/Allowed: POST \/webhook-templates/);
    // Timing
    const ok = { method: 'POST', path: `/webhook-templates/${tpl}/send` };
    expect((await api('POST', SCH, ok)).status).toBe(400); // no time
    expect((await api('POST', SCH, { ...ok, delayMs: 10, at: new Date().toISOString() })).status).toBe(400); // two times
    expect((await api('POST', SCH, { ...ok, delaySeconds: 31 * 86400 })).status).toBe(400);
    expect((await api('POST', SCH, { ...ok, at: new Date(Date.now() - 3_600_000).toISOString() })).status).toBe(400);
    expect((await api('POST', SCH, { ...ok, delayMs: 10, everyMs: 500 })).status).toBe(400);
    expect((await api('POST', SCH, { ...ok, delayMs: 10, everyMs: 1000, maxFires: 101 })).status).toBe(400);
    expect((await api('POST', SCH, { ...ok, delayMs: 10, maxFires: 3 })).status).toBe(400); // repeat needs everyMs
    // Full path form is accepted and normalised to the suffix.
    const full = await api('POST', SCH, { method: 'post', path: `/api/projects/sched/webhook-templates/${tpl}/send`, delaySeconds: 600 });
    expect(full.status).toBe(201);
    expect(full.body).toMatchObject({ action: 'webhook.send', method: 'POST', path: `/webhook-templates/${tpl}/send`, url: `/api/projects/sched/webhook-templates/${tpl}/send`, maxFires: 1 });
    expect((await api('DELETE', `${SCH}/${full.body.id}`)).body.cancelled).toBe(true);
  });

  it('fires a delayed webhook send once and records the result', async () => {
    const before = hits('/hook-a');
    const r = await send({ delayMs: 250, label: 'pay later' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'pending', fired: 0, label: 'pay later', run: null });
    // The internal job is visible in /jobs.
    const jobs = (await api('GET', '/api/projects/sched/jobs')).body as any[];
    expect(jobs.some((j) => j.type === 'schedule.fire' && j.payload.scheduleId === r.body.id)).toBe(true);
    const done = await settled(r.body.id, 'done');
    expect(done).toMatchObject({ fired: 1, lastStatus: 200, lastError: null, nextAt: null });
    expect(done.lastResult.ok).toBe(true);
    await sleep(200);
    expect(hits('/hook-a')).toBe(before + 1);
    expect(JSON.parse(received.filter((x) => x.path === '/hook-a').at(-1)!.body)).toEqual({ n: 1 });
  });

  it('repeats at a fixed rate up to maxFires', async () => {
    const before = hits('/hook-a');
    const r = await send({ delayMs: 0, everyMs: 1000, maxFires: 2 });
    expect(r.body.repeat).toEqual({ everyMs: 1000, fired: 0, max: 2 });
    const done = await settled(r.body.id, 'done', 5000);
    expect(done.fired).toBe(2);
    await sleep(1200);
    expect(hits('/hook-a')).toBe(before + 2);
    expect((await api('GET', `${SCH}?status=finished`)).body.some((x: any) => x.id === r.body.id)).toBe(true);
  });

  it('records a failing call as failed and stops', async () => {
    const r = await api('POST', SCH, { method: 'POST', path: '/webhook-templates/nope/send', delayMs: 0, everyMs: 1000, maxFires: 5 });
    const f = await settled(r.body.id, 'failed');
    expect(f.fired).toBe(1);
    expect(f.lastStatus).toBe(404);
    expect(f.lastError).toMatch(/404/);
  });

  it('pauses, resumes, edits (old job is a no-op) and cancels', async () => {
    const before = hits('/hook-a');
    const r = await send({ delaySeconds: 60 });
    const id = r.body.id;
    expect((await api('POST', `${SCH}/${id}/pause`)).body.status).toBe('paused');
    let jobs = (await api('GET', '/api/projects/sched/jobs')).body as any[];
    expect(jobs.some((j) => j.payload.scheduleId === id)).toBe(false);
    expect((await api('PATCH', `${SCH}/${id}`, { label: 'edited while paused' })).body.label).toBe('edited while paused');
    expect((await api('POST', `${SCH}/${id}/resume`)).body.status).toBe('pending');
    jobs = (await api('GET', '/api/projects/sched/jobs')).body as any[];
    expect(jobs.filter((j) => j.payload.scheduleId === id)).toHaveLength(1);
    const oldJob = hub.schedules.repo.get(id)!.jobId!;

    // Edit: action / target are fixed; time moves; the old job is replaced.
    expect((await api('PATCH', `${SCH}/${id}`, { path: '/webhook-sequences/x/run' })).status).toBe(400);
    const e = await api('PATCH', `${SCH}/${id}`, { delayMs: 200, body: { data: { n: 7 } } });
    expect(e.status).toBe(200);
    expect(hub.schedules.repo.get(id)!.jobId).not.toBe(oldJob);
    // Re-queue the stale job right now: the gen guard makes it a no-op.
    hub.db.prepare("INSERT INTO scheduled_jobs (id, project_id, type, run_at, payload, created_at) VALUES ('stale1', ?, 'schedule.fire', ?, ?, ?)").run(
      hub.projects.require('sched').id,
      new Date().toISOString(),
      JSON.stringify({ scheduleId: id, gen: 0, seq: 0 }),
      new Date().toISOString(),
    );
    const done = await settled(id, 'done');
    expect(done.fired).toBe(1);
    await sleep(200);
    expect(hits('/hook-a')).toBe(before + 1);
    expect(JSON.parse(received.filter((x) => x.path === '/hook-a').at(-1)!.body)).toEqual({ n: 7 });
    expect((await api('PATCH', `${SCH}/${id}`, { label: 'x' })).status).toBe(409);

    // Cancel, then delete the finished row.
    const c = await send({ delaySeconds: 60 });
    const del = await api('DELETE', `${SCH}/${c.body.id}`);
    expect(del.body).toMatchObject({ cancelled: true, schedule: { status: 'cancelled' } });
    expect((await api('DELETE', `${SCH}/${c.body.id}`)).body).toEqual({ deleted: c.body.id });
    expect((await api('GET', `${SCH}/${c.body.id}`)).status).toBe(404);
  });

  it('runs now and flushes all pending ones', async () => {
    const before = hits('/hook-a');
    const a = await send({ delaySeconds: 60 });
    const rn = await api('POST', `${SCH}/${a.body.id}/run-now`);
    expect(rn.body.fire).toMatchObject({ ok: true, status: 200 });
    expect(rn.body.schedule.status).toBe('done');

    const rec = await send({ delaySeconds: 60, everyMs: 60_000, maxFires: 3 });
    const b = await send({ delaySeconds: 30 });
    const fl = await api('POST', `${SCH}/flush`, {});
    expect(fl.body.fired).toBe(2);
    expect(fl.body.results.map((x: any) => x.id)).toEqual([b.body.id, rec.body.id]); // next_at order
    expect((await get(b.body.id)).status).toBe('done');
    const r2 = await get(rec.body.id);
    expect(r2).toMatchObject({ status: 'pending', fired: 1 });
    expect(hub.db.prepare("SELECT COUNT(*) AS n FROM scheduled_jobs WHERE status = 'pending' AND payload LIKE ?").get(`%${rec.body.id}%`)).toEqual({ n: 1 });
    await sleep(200);
    expect(hits('/hook-a')).toBe(before + 3);
    await api('DELETE', `${SCH}/${rec.body.id}`);
  });

  const backdate = (id: string) => {
    const past = new Date(Date.now() - 20 * 60_000).toISOString();
    hub.db.prepare('UPDATE schedules SET next_at = ? WHERE id = ?').run(past, id);
    hub.db.prepare('UPDATE scheduled_jobs SET run_at = ? WHERE id = ?').run(past, hub.schedules.repo.get(id)!.jobId);
  };

  it('marks a late one-shot as missed and skips missed recurring slots without a burst', async () => {
    const before = hits('/hook-a');
    const one = await send({ delaySeconds: 60 });
    backdate(one.body.id);
    const m = await settled(one.body.id, 'missed');
    expect(m).toMatchObject({ fired: 0, missed: 1 });

    const rec = await send({ delaySeconds: 60, everyMs: 60_000, maxFires: 5 });
    backdate(rec.body.id);
    const r = await waitFor(async () => {
      const x = await get(rec.body.id);
      return x.missed > 0 ? x : null;
    });
    expect(r).toMatchObject({ status: 'pending', fired: 0, missed: 21 });
    expect(Date.parse(r.nextAt)).toBeGreaterThan(Date.now());
    await sleep(200);
    expect(hits('/hook-a')).toBe(before);
    await api('DELETE', `${SCH}/${rec.body.id}`);
  });

  it('runs inside a test run (X-Hub-Run) and is cancelled when the run stops', async () => {
    expect((await api('POST', '/api/projects/sched/runs', { key: 'r1', users: [{ role: 'customer', count: 1 }] })).status).toBe(201);
    const r = await api('POST', `${SCH}?run=r1`, { method: 'POST', path: '/users/customer/rules/preset/blocked', delayMs: 0 });
    expect(r.status).toBe(201);
    expect(r.body.run).toBe('r1');
    await settled(r.body.id, 'done');
    const inRun = (await api('GET', '/api/projects/sched/users/customer/rules?run=r1')).body as any[];
    expect(inRun.length).toBe(1);
    expect(inRun[0].runId).toBeTruthy();
    expect(((await api('GET', '/api/projects/sched/users/customer/rules')).body as any[]).length).toBe(0);

    const later = await api('POST', `${SCH}?run=r1`, { method: 'DELETE', path: '/users/customer/rules', delaySeconds: 60 });
    expect((await api('GET', `${SCH}?run=r1&status=pending`)).body.map((x: any) => x.id)).toEqual([later.body.id]);
    expect((await api('POST', '/api/projects/sched/runs/r1/stop', {})).status).toBe(200);
    expect(await get(later.body.id)).toMatchObject({ status: 'cancelled', lastError: 'Run stopped' });
    // A stopped run cannot get new schedules.
    expect((await api('POST', `${SCH}?run=r1`, { method: 'POST', path: '/rules/reset', delayMs: 0 })).status).toBe(409);
  });

  it('project reset cancels pending schedules; maintenance purges old finished ones', async () => {
    const a = await send({ delaySeconds: 60 });
    const b = await send({ delaySeconds: 60 });
    await api('POST', `${SCH}/${b.body.id}/pause`);
    expect((await api('POST', '/api/projects/sched/reset', {})).status).toBe(200);
    expect((await get(a.body.id)).status).toBe('cancelled');
    expect((await get(b.body.id)).status).toBe('cancelled');
    expect((await api('GET', `${SCH}?status=active`)).body).toEqual([]);

    hub.db.prepare('UPDATE schedules SET updated_at = ? WHERE id = ?').run(new Date(Date.now() - 2 * 86_400_000).toISOString(), a.body.id);
    const rep = await hub.maintenance.run();
    expect(rep.schedules).toBe(1);
    expect((await api('GET', `${SCH}/${a.body.id}`)).status).toBe(404);
    expect((await api('GET', `${SCH}/${b.body.id}`)).status).toBe(200);
  });

  it('does not fire twice after crash recovery', async () => {
    const before = hits('/hook-a');
    const r = await send({ delaySeconds: 60 });
    const id = r.body.id;
    const s = hub.schedules.repo.get(id)!;
    // Simulate a crash mid-fire: the fire was claimed, the job was left "running" and is reset to pending at start.
    expect(hub.schedules.repo.claimFire(id, 0, new Date().toISOString())).toBe(true);
    hub.db.prepare("UPDATE scheduled_jobs SET status = 'pending', run_at = ? WHERE id = ?").run(new Date().toISOString(), s.jobId);
    await waitFor(async () => (hub.db.prepare('SELECT status FROM scheduled_jobs WHERE id = ?').get(s.jobId) as { status: string }).status === 'done');
    expect(hub.schedules.repo.get(id)).toMatchObject({ fired: 1, status: 'pending', lastStatus: null });
    // Startup recovery finishes it instead of firing again.
    expect(hub.schedules.recover()).toBe(1);
    expect(await get(id)).toMatchObject({ status: 'done', fired: 1 });
    await sleep(150);
    expect(hits('/hook-a')).toBe(before);

    // A recurring one whose job vanished gets a fresh job.
    const rec = await send({ delaySeconds: 60, everyMs: 60_000, maxFires: 3 });
    hub.db.prepare('DELETE FROM scheduled_jobs WHERE id = ?').run(hub.schedules.repo.get(rec.body.id)!.jobId);
    expect(hub.schedules.recover()).toBe(1);
    expect(hub.schedules.recover()).toBe(0);
    await api('DELETE', `${SCH}/${rec.body.id}`);
  });

  it('limits pending / paused schedules per project (409)', async () => {
    const p = hub.projects.require('other');
    const at = new Date(Date.now() + 3_600_000).toISOString();
    hub.db.transaction(() => {
      for (let i = 0; i < 500; i++) hub.schedules.repo.create({ projectId: p.id, runId: null, label: '', action: 'rule.clear', method: 'POST', path: '/rules/reset', body: null, nextAt: at, everyMs: null, maxFires: 1 });
    })();
    const r = await api('POST', '/api/projects/other/schedules', { method: 'POST', path: '/rules/reset', delaySeconds: 60 });
    expect(r.status).toBe(409);
    hub.db.prepare('DELETE FROM schedules WHERE project_id = ?').run(p.id);
    expect((await api('POST', '/api/projects/other/schedules', { method: 'POST', path: '/rules/reset', delaySeconds: 60 })).status).toBe(201);
  });

  it('MCP: schedule_action, list_scheduled, flush_scheduled, cancel_scheduled', async () => {
    const list = await api('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = (list.body.result.tools as any[]).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['schedule_action', 'list_scheduled', 'cancel_scheduled', 'flush_scheduled']));
    expect((list.body.result.tools as any[]).find((t) => t.name === 'list_scheduled').annotations).toEqual({ readOnlyHint: true });

    const before = hits('/hook-a');
    const a = await mcp('schedule_action', { project: 'sched', action: 'webhook.send', template: 'order.paid', body: { data: { n: 3 } }, delay_seconds: 120, label: 'mcp' });
    expect(a).toMatchObject({ action: 'webhook.send', status: 'pending', label: 'mcp' });
    const b = await mcp('schedule_action', { project: 'sched', action: 'rule.set', user: 'admin', preset: 'blocked', delay_seconds: 300, every_seconds: 60, max_times: 2 });
    expect(b).toMatchObject({ action: 'rule.set', everyMs: 60_000, maxFires: 2 });
    await expect(mcp('schedule_action', { project: 'sched', action: 'webhook.send', delay_seconds: 1 })).rejects.toThrow(/needs "template"/);
    const l = await mcp('list_scheduled', { project: 'sched', status: 'pending' });
    expect(l.schedules.map((x: any) => x.id)).toEqual([a.id, b.id]);
    expect((await mcp('cancel_scheduled', { project: 'sched', id: b.id })).cancelled).toBe(true);
    const f = await mcp('flush_scheduled', { project: 'sched' });
    expect(f.fired).toBe(1);
    expect(f.results[0]).toMatchObject({ id: a.id, ok: true });
    await sleep(150);
    expect(hits('/hook-a')).toBe(before + 1);
  });
});
