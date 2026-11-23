/**
 * Features board (migration 28): feature CRUD and keys, tasks / subtasks with the two-level limit, reorder, toggle,
 * images (types checked from the bytes, size and count caps, raw and data-URL uploads, serving headers), cascade
 * deletes, the storyboard link, project reset / export / import, MCP tools and the features.changed event.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { DB, migrate } from '../src/db/index.js';
import { migrations } from '../src/db/migrations.js';
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

async function api<T = any>(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T; headers: Headers }> {
  const raw = body instanceof Uint8Array;
  const r = await fetch(base + p, {
    method,
    headers: body !== undefined && !raw ? { 'content-type': 'application/json', ...headers } : headers,
    body: body === undefined ? undefined : raw ? (body as Uint8Array<ArrayBuffer>) : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: r.status, body: parsed as T, headers: r.headers };
}
const mcp = async (name: string, args: Record<string, unknown>) => {
  const r = await api('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  if (r.body.result.isError) throw new Error(r.body.result.content[0].text);
  return JSON.parse(r.body.result.content[0].text);
};

const F = '/api/projects/feat/features';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
// JPEG: SOI, APP0 (JFIF), SOF0 2x3 px, padding.
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  Buffer.from('JFIF\0', 'binary'),
  Buffer.from([0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x03, 0x00, 0x02, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]),
  Buffer.alloc(32),
]);
// WebP VP8X, 4x5 px.
const WEBP = (() => {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(22, 4);
  b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii');
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(3, 24, 3);
  b.writeUIntLE(4, 27, 3);
  return b;
})();
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const dataUrl = (mime: string, b: Buffer) => `data:${mime};base64,${b.toString('base64')}`;

describe('features board', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-features-'));
    const httpPort = await freePort();
    const config = loadConfig({ host: '127.0.0.1', httpPort, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0 });
    hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger: pino({ level: 'silent' }) });
    const { app } = await buildApp(hub, pino({ level: 'silent' }));
    await app.listen({ port: httpPort, host: '127.0.0.1' });
    close = async () => {
      await app.close();
      hub.db.close();
    };
    base = `http://127.0.0.1:${httpPort}`;
    expect((await api('POST', '/api/projects', { name: 'Feat', slug: 'feat' })).status).toBe(201);
    expect((await api('POST', '/api/projects', { name: 'Other', slug: 'other' })).status).toBe(201);
  });

  afterAll(async () => {
    await close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('migration 28 creates the tables on a fresh database and is recorded once', () => {
    expect(Math.max(...migrations.map((m) => m.version))).toBe(28);
    const db = new DB(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
    migrate(db); // idempotent
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'feature%' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(['feature_counters', 'feature_images', 'feature_tasks', 'features']);
    expect((db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 28').get() as { n: number }).n).toBe(1);
    db.close();
  });

  it('creates, reads, updates and lists features with keys and validation', async () => {
    const a = await api('POST', F, { title: '  Sign-up with Google  ', details: '# Why\nUsers asked.', priority: 'high' });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ key: 'F-1', number: 1, title: 'Sign-up with Google', status: 'idea', priority: 'high', progress: { done: 0, total: 0 }, imageCount: 0, tasks: [], images: [], storyboard: null });
    const b = await api('POST', F, { title: 'Dark mode', status: 'planned' });
    expect(b.body.key).toBe('F-2');

    // Lookups by key (any case), number and id
    expect((await api('GET', `${F}/f-1`)).body.id).toBe(a.body.id);
    expect((await api('GET', `${F}/1`)).body.id).toBe(a.body.id);
    expect((await api('GET', `${F}/${a.body.id}`)).body.key).toBe('F-1');
    expect((await api('GET', `${F}/F-99`)).status).toBe(404);
    // Projects are separate
    expect((await api('GET', `/api/projects/other/features/${a.body.id}`)).status).toBe(404);

    // Validation: clear 400s
    const noTitle = await api('POST', F, { title: '   ' });
    expect(noTitle.status).toBe(400);
    expect(noTitle.body.error).toMatch(/title is required/);
    const badStatus = await api('POST', F, { title: 'x', status: 'doing' });
    expect(badStatus.status).toBe(400);
    expect(badStatus.body.error).toMatch(/status/);
    const extra = await api('POST', F, { title: 'x', colour: 'red' });
    expect(extra.status).toBe(400);
    expect(extra.body.error).toMatch(/colour/);
    expect((await api('POST', F, { title: 'x'.repeat(201) })).status).toBe(400);
    expect((await api('PATCH', `${F}/F-1`, { priority: 'urgent' })).status).toBe(400);
    expect((await api('POST', F, { title: 'x', storyboard: 'nope' })).body.error).toMatch(/Storyboard "nope" not found/);

    const up = await api('PATCH', `${F}/F-1`, { status: 'in_progress', details: 'Updated **text**' });
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ status: 'in_progress', details: 'Updated **text**', title: 'Sign-up with Google' });

    const list = await api('GET', F);
    expect(list.body.features.map((f: any) => f.key)).toEqual(['F-1', 'F-2']);
    expect(list.body.features[0].details).toBeUndefined(); // brief rows
    expect(list.body.counts).toMatchObject({ all: 2, in_progress: 1, planned: 1, idea: 0, done: 0 });
    expect((await api('GET', `${F}?status=planned`)).body.features.map((f: any) => f.key)).toEqual(['F-2']);
    expect((await api('GET', `${F}?status=planned,in_progress`)).body.features).toHaveLength(2);
    expect((await api('GET', `${F}?status=later`)).status).toBe(400);
    expect((await api('GET', `${F}?q=google`)).body.features.map((f: any) => f.key)).toEqual(['F-1']);
    expect((await api('GET', `${F}?q=f-2`)).body.features.map((f: any) => f.key)).toEqual(['F-2']);
    expect((await api('GET', `${F}?q=100%25`)).body.features).toEqual([]); // % is literal
    expect((await api('GET', `${F}?full=1`)).body.features[0].details).toBe('Updated **text**');
  });

  it('reorders features by slots (a filtered subset keeps the others in place)', async () => {
    await api('POST', F, { title: 'Third', status: 'planned' });
    await api('POST', F, { title: 'Fourth' });
    const keys = async () => (await api('GET', F)).body.features.map((f: any) => f.key);
    expect(await keys()).toEqual(['F-1', 'F-2', 'F-3', 'F-4']);
    // Swap F-2 and F-3 (one "up" move)
    const r = await api('POST', `${F}/reorder`, { ids: ['F-3', 'F-2'] });
    expect(r.status).toBe(200);
    expect(r.body.features.map((f: any) => f.key)).toEqual(['F-1', 'F-3', 'F-2', 'F-4']);
    // Full order
    await api('POST', `${F}/reorder`, { ids: ['F-4', 'F-3', 'F-2', 'F-1'] });
    expect(await keys()).toEqual(['F-4', 'F-3', 'F-2', 'F-1']);
    expect((await api('POST', `${F}/reorder`, { ids: ['F-1', 'F-1'] })).status).toBe(400);
    expect((await api('POST', `${F}/reorder`, { ids: ['F-77'] })).status).toBe(404);
    expect((await api('POST', `${F}/reorder`, { ids: [] })).status).toBe(400);
    await api('POST', `${F}/reorder`, { ids: ['F-1', 'F-2', 'F-3', 'F-4'] });
    expect(await keys()).toEqual(['F-1', 'F-2', 'F-3', 'F-4']);
  });

  it('tasks and subtasks: add, nest two levels only, toggle, edit, move, reorder, delete', async () => {
    const T = `${F}/F-1/tasks`;
    const t1 = await api('POST', T, { title: 'Backend', assignee: 'Ali', note: 'OAuth *client*' });
    expect(t1.status).toBe(201);
    expect(t1.body.task).toMatchObject({ title: 'Backend', done: false, assignee: 'Ali', note: 'OAuth *client*', parentTaskId: null, position: 0, subtasks: [] });
    expect(t1.body.feature.progress).toEqual({ done: 0, total: 1 });
    const t2 = (await api('POST', T, { title: 'Frontend', subtasks: [{ title: 'Button' }, { title: 'Callback page', done: true }] })).body;
    expect(t2.task.subtasks.map((s: any) => s.title)).toEqual(['Button', 'Callback page']);
    expect(t2.feature.progress).toEqual({ done: 1, total: 4 });
    const s1 = (await api('POST', T, { title: 'Token exchange', parentTaskId: t1.body.task.id })).body.task;
    expect(s1.parentTaskId).toBe(t1.body.task.id);

    // Depth limit: no sub-subtasks, by any route
    const deep = await api('POST', T, { title: 'Too deep', parentTaskId: s1.id });
    expect(deep.status).toBe(400);
    expect(deep.body.error).toMatch(/Subtasks cannot have subtasks/);
    expect((await api('POST', T, { title: 'x', parentTaskId: t1.body.task.id, subtasks: [{ title: 'y' }] })).status).toBe(400);
    expect((await api('POST', T, { title: 'x', subtasks: [{ title: 'y', subtasks: [{ title: 'z' }] }] })).status).toBe(400);
    expect((await api('POST', F, { title: 'Deep', tasks: [{ title: 'a', subtasks: [{ title: 'b', subtasks: [] }] }] })).status).toBe(400);
    // A task with subtasks cannot become a subtask; a subtask cannot become a parent
    expect((await api('PATCH', `${T}/${t2.task.id}`, { parentTaskId: t1.body.task.id })).body.error).toMatch(/cannot become a subtask/);
    expect((await api('PATCH', `${T}/${t1.body.task.id}`, { parentTaskId: t1.body.task.id })).status).toBe(400);
    expect((await api('POST', T, { title: 'x', parentTaskId: 'nope' })).body.error).toMatch(/not a task of this feature/);
    // A task of another feature is not a parent here
    const other = (await api('POST', `${F}/F-2/tasks`, { title: 'Other feature task' })).body.task;
    expect((await api('POST', T, { title: 'x', parentTaskId: other.id })).status).toBe(400);
    expect((await api('PATCH', `${T}/${other.id}`, { done: true })).status).toBe(404);

    // Toggle, set done, edit
    const tg = await api('POST', `${T}/${s1.id}/toggle`);
    expect(tg.body.task.done).toBe(true);
    expect(tg.body.task.doneAt).toBeTruthy();
    expect((await api('POST', `${T}/${s1.id}/toggle`)).body.task.done).toBe(false);
    expect((await api('POST', `${T}/${s1.id}/toggle`, { done: true })).body.task.done).toBe(true);
    expect((await api('POST', `${T}/${s1.id}/toggle`, { done: 'yes' })).status).toBe(400);
    const ed = await api('PATCH', `${T}/${t1.body.task.id}`, { title: 'Backend API', assignee: '', note: '' });
    expect(ed.body.task).toMatchObject({ title: 'Backend API', assignee: '', note: '' });
    expect((await api('PATCH', `${T}/${t1.body.task.id}`, { title: '' })).status).toBe(400);
    expect((await api('PATCH', `${T}/${t1.body.task.id}`, { owner: 'x' })).status).toBe(400);

    // Insert at a position, reorder a level
    const t0 = (await api('POST', T, { title: 'Design', position: 0 })).body.task;
    let tasks = (await api('GET', T)).body;
    expect(tasks.map((t: any) => t.title)).toEqual(['Design', 'Backend API', 'Frontend']);
    expect(tasks.map((t: any) => t.position)).toEqual([0, 1, 2]);
    const re = await api('POST', `${T}/reorder`, { ids: [t2.task.id, t0.id, t1.body.task.id] });
    expect(re.body.tasks.map((t: any) => t.title)).toEqual(['Frontend', 'Design', 'Backend API']);
    const subs = re.body.tasks[0].subtasks.map((s: any) => s.id);
    const re2 = await api('POST', `${T}/reorder`, { parentTaskId: t2.task.id, ids: [...subs].reverse() });
    expect(re2.body.tasks[0].subtasks.map((s: any) => s.title)).toEqual(['Callback page', 'Button']);
    expect((await api('POST', `${T}/reorder`, { ids: [t0.id] })).body.error).toMatch(/send every top-level task \(3\)/);
    expect((await api('POST', `${T}/reorder`, { ids: [t0.id, t0.id, t2.task.id] })).status).toBe(400);
    expect((await api('POST', `${T}/reorder`, { parentTaskId: t2.task.id, ids: [t0.id, ...subs] })).body.error).toMatch(/not a subtask of that task/);

    // Move: a subtask to the top level, a task under another
    const mv = await api('PATCH', `${T}/${s1.id}`, { parentTaskId: null });
    expect(mv.body.task.parentTaskId).toBeNull();
    tasks = (await api('GET', T)).body;
    expect(tasks.map((t: any) => t.title)).toEqual(['Frontend', 'Design', 'Backend API', 'Token exchange']);
    await api('PATCH', `${T}/${s1.id}`, { parentTaskId: t1.body.task.id });
    tasks = (await api('GET', T)).body;
    expect(tasks.map((t: any) => t.title)).toEqual(['Frontend', 'Design', 'Backend API']);
    expect(tasks.map((t: any) => t.position)).toEqual([0, 1, 2]);
    expect(tasks[2].subtasks.map((s: any) => s.title)).toEqual(['Token exchange']);

    // Delete a task with subtasks: they go too
    const del = await api('DELETE', `${T}/${t2.task.id}`);
    expect(del.body).toMatchObject({ deleted: t2.task.id, subtasks: 2 });
    expect(del.body.feature.progress).toEqual({ done: 1, total: 3 });
    expect((hub.db.prepare('SELECT COUNT(*) AS n FROM feature_tasks WHERE parent_task_id = ?').get(t2.task.id) as { n: number }).n).toBe(0);
    expect((await api('DELETE', `${T}/${t2.task.id}`)).status).toBe(404);

    // Create with a task tree
    const tree = await api('POST', F, { title: 'Payments', tasks: [{ title: 'Stripe', subtasks: [{ title: 'Webhook', done: true }, { title: 'Refunds' }] }, { title: 'PayPal', assignee: 'Sara' }] });
    expect(tree.status).toBe(201);
    expect(tree.body.progress).toEqual({ done: 1, total: 4 });
    expect(tree.body.tasks[0].subtasks).toHaveLength(2);
    expect(tree.body.tasks[1].assignee).toBe('Sara');
    // Task limit
    hub.features!.limits.tasksPerFeature = 5;
    expect((await api('POST', `${F}/${tree.body.key}/tasks`, { title: 'one more', subtasks: [{ title: 'and another' }] })).status).toBe(409);
    hub.features!.limits.tasksPerFeature = 500;
  });

  it('images: PNG / JPEG / WebP / GIF by bytes, raw or data URL; served with nosniff; limits; delete', async () => {
    const I = `${F}/F-2/images`;
    const png = await api('POST', `${I}?name=mock-up.png`, new Uint8Array(PNG), { 'content-type': 'image/png' });
    expect(png.status).toBe(201);
    expect(png.body).toMatchObject({ name: 'mock-up.png', mime: 'image/png', bytes: PNG.length, width: 1, height: 1 });
    expect(png.body.markdown).toBe(`![mock-up.png](image:${png.body.id})`);
    const jpg = await api('POST', I, { dataUrl: dataUrl('image/jpeg', JPEG), name: 'C:\\Users\\me\\photo.jpg' });
    expect(jpg.status).toBe(201);
    expect(jpg.body).toMatchObject({ name: 'photo.jpg', mime: 'image/jpeg', width: 2, height: 3 });
    const webp = await api('POST', I, new Uint8Array(WEBP), { 'content-type': 'image/webp' });
    expect(webp.body).toMatchObject({ mime: 'image/webp', width: 4, height: 5, name: 'image-3.webp' });
    const gif = await api('POST', I, { dataUrl: dataUrl('image/gif', GIF) });
    expect(gif.body.mime).toBe('image/gif');

    // Served bytes and headers
    const got = await fetch(base + png.body.url);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(got.headers.get('content-disposition')).toMatch(/^inline; filename="mock-up.png"/);
    expect(Buffer.from(await got.arrayBuffer()).equals(PNG)).toBe(true);
    expect((await fetch(`${base}${png.body.url}?download=1`)).headers.get('content-disposition')).toMatch(/^attachment/);

    // Type checks: SVG / HTML / text never stored, even with an image content type; declared type must match
    const svgRaw = await api('POST', I, new Uint8Array(SVG), { 'content-type': 'image/png' });
    expect(svgRaw.status).toBe(415);
    expect(svgRaw.body.error).toMatch(/Only PNG, JPEG, WebP or GIF/);
    expect((await api('POST', I, new Uint8Array(SVG), { 'content-type': 'image/svg+xml' })).status).toBe(415); // guard: JSON only
    expect((await api('POST', I, { dataUrl: dataUrl('image/svg+xml', SVG) })).status).toBe(415);
    const mismatch = await api('POST', I, { dataUrl: dataUrl('image/jpeg', PNG) });
    expect(mismatch.status).toBe(415);
    expect(mismatch.body.error).toMatch(/PNG but was sent as image\/jpeg/);
    expect((await api('POST', I, { dataUrl: 'https://example.com/x.png' })).status).toBe(400);
    expect((await api('POST', I, { dataUrl: 'data:image/png;base64,' })).status).toBe(400);
    expect((await api('POST', I, new Uint8Array(PNG), { 'content-type': 'text/plain' })).status).toBe(415);

    // Size cap: 5 MB each (a raw upload just over it gets the service's own 413)
    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024 + 1 - PNG.length)]);
    const tooBig = await api('POST', I, new Uint8Array(big), { 'content-type': 'image/png' });
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.error).toMatch(/at most 5 MB each/);
    const exact = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024 - PNG.length)]);
    const okBig = await api('POST', I, new Uint8Array(exact), { 'content-type': 'image/png' });
    expect(okBig.status).toBe(201);
    expect((await api('DELETE', `${I}/${okBig.body.id}`)).body).toEqual({ deleted: okBig.body.id });

    // Count cap: 20 per feature
    const have = (await api('GET', I)).body.length;
    expect(have).toBe(4);
    for (let i = have; i < 20; i++) expect((await api('POST', I, { dataUrl: dataUrl('image/png', PNG) })).status).toBe(201);
    const full = await api('POST', I, { dataUrl: dataUrl('image/png', PNG) });
    expect(full.status).toBe(409);
    expect(full.body.error).toMatch(/at most 20/);
    // Project cap
    hub.features!.limits.projectImageBytes = 100;
    expect((await api('POST', `${F}/F-3/images`, { dataUrl: dataUrl('image/png', PNG) })).status).toBe(413);
    hub.features!.limits.projectImageBytes = 200 * 1024 * 1024;

    expect((await api('GET', `${F}/F-2`)).body.imageCount).toBe(20);
    expect((await api('GET', F)).body.features.find((f: any) => f.key === 'F-2').imageCount).toBe(20);
    // Delete one image; 404 for unknown and for an image of another feature
    expect((await api('DELETE', `${I}/${gif.body.id}`)).status).toBe(200);
    expect((await api('DELETE', `${I}/${gif.body.id}`)).status).toBe(404);
    expect((await api('GET', `${F}/F-1/images/${png.body.id}`)).status).toBe(404);
  });

  it('deleting a feature removes its tasks and images; numbers are not reused', async () => {
    const f = (await api('POST', F, { title: 'Temporary', tasks: [{ title: 'a', subtasks: [{ title: 'b' }] }] })).body;
    await api('POST', `${F}/${f.key}/images`, { dataUrl: dataUrl('image/png', PNG) });
    const d = await api('DELETE', `${F}/${f.key}`);
    expect(d.body).toEqual({ deleted: f.id, key: f.key, tasks: 2, images: 1 });
    expect((hub.db.prepare('SELECT COUNT(*) AS n FROM feature_tasks WHERE feature_id = ?').get(f.id) as { n: number }).n).toBe(0);
    expect((hub.db.prepare('SELECT COUNT(*) AS n FROM feature_images WHERE feature_id = ?').get(f.id) as { n: number }).n).toBe(0);
    expect((await api('GET', `${F}/${f.key}`)).status).toBe(404);
    const next = (await api('POST', F, { title: 'After delete' })).body;
    expect(next.number).toBe(f.number + 1);
    await api('DELETE', `${F}/${next.key}`);
  });

  it('links a storyboard (slug or id), unlinks, and survives the storyboard being deleted', async () => {
    const sb = await api('PUT', '/api/projects/feat/storyboards/signup-flow', { slug: 'signup-flow', name: 'Sign-up flow', actors: [{ key: 'u', role: 'admin', fresh: true }], steps: [{ id: 'open', kind: 'instruction', title: 'Open the page', intent: 'Start' }] });
    expect(sb.status, JSON.stringify(sb.body)).toBeLessThan(300);
    const l = await api('PATCH', `${F}/F-1`, { storyboard: 'signup-flow' });
    expect(l.body.storyboard).toMatchObject({ slug: 'signup-flow', name: 'Sign-up flow' });
    expect((await api('PATCH', `${F}/F-1`, { storyboard: '' })).body.storyboard).toBeNull();
    expect((await api('PATCH', `${F}/F-1`, { storyboard: l.body.storyboard.id })).body.storyboard.slug).toBe('signup-flow');
    const tmp = await api('PUT', '/api/projects/feat/storyboards/tmp-flow', { slug: 'tmp-flow', name: 'Tmp', actors: [{ key: 'u', role: 'admin', fresh: true }], steps: [{ id: 'a', kind: 'instruction', title: 'A', intent: 'A' }] });
    expect(tmp.status, JSON.stringify(tmp.body)).toBeLessThan(300);
    await api('PATCH', `${F}/F-4`, { storyboard: 'tmp-flow' });
    expect((await api('DELETE', '/api/projects/feat/storyboards/tmp-flow')).status).toBe(200);
    expect((await api('GET', `${F}/F-4`)).body.storyboard).toBeNull();
  });

  it('project reset keeps the board; export / import carries features, tasks, images and the storyboard link', async () => {
    const before = (await api('GET', `${F}?full=1`)).body.features;
    expect((await api('POST', '/api/projects/feat/reset', {})).status).toBe(200);
    expect((await api('GET', `${F}?full=1`)).body.features).toEqual(before);

    // Details referencing an image: the reference moves to the new id on import
    const img = (await api('GET', `${F}/F-2/images`)).body[0];
    await api('PATCH', `${F}/F-2`, { details: `Look: ${img.markdown}` });

    const exp = (await api('GET', '/api/projects/feat/export')).body;
    expect(exp.features.map((f: any) => f.title)).toEqual(before.map((f: any) => f.title));
    const f1 = exp.features.find((f: any) => f.key === 'F-1');
    expect(f1.storyboard).toBe('signup-flow');
    expect(f1.tasks.find((t: any) => t.title === 'Backend API').subtasks[0]).toMatchObject({ title: 'Token exchange', done: true });
    const f2 = exp.features.find((f: any) => f.key === 'F-2');
    expect(f2.images).toHaveLength(19);
    expect(f2.images[0].dataUrl).toMatch(/^data:image\/png;base64,/);
    // ?images=0 leaves them out and says so
    const lean = (await api('GET', '/api/projects/feat/export?images=0')).body;
    expect(lean.features.find((f: any) => f.key === 'F-2')).toMatchObject({ imagesLeftOut: 19 });
    expect(lean.features.find((f: any) => f.key === 'F-2').images).toBeUndefined();

    const imp = await api('POST', '/api/projects/import', { json: exp, slug: 'feat-copy' });
    expect(imp.status).toBe(201);
    expect(imp.body.imported.features).toBe(before.length);
    const copy = (await api('GET', '/api/projects/feat-copy/features?full=1')).body.features;
    expect(copy.map((f: any) => [f.key, f.title, f.status, f.priority, f.progress])).toEqual(before.map((f: any) => [f.key, f.title, f.status, f.priority, f.progress]));
    expect(copy[0].storyboard?.slug).toBe('signup-flow');
    expect(copy[0].tasks.map((t: any) => t.title)).toEqual(before[0].tasks.map((t: any) => t.title));
    const c2 = copy.find((f: any) => f.key === 'F-2');
    expect(c2.images).toHaveLength(19);
    expect(c2.details).toBe(`Look: ${c2.images[0].markdown}`);
    expect(c2.images[0].id).not.toBe(img.id);
    const bytes = Buffer.from(await (await fetch(base + c2.images[0].url)).arrayBuffer());
    expect(bytes.equals(PNG)).toBe(true);

    // Replace mode empties the board first and numbers from F-1 again
    await api('POST', '/api/projects/feat-copy/features', { title: 'Only in the copy' });
    const rep = await api('POST', '/api/projects/import', { json: lean, slug: 'feat-copy', mode: 'replace' });
    expect(rep.status).toBe(200);
    const after = (await api('GET', '/api/projects/feat-copy/features')).body.features;
    expect(after.map((f: any) => f.title)).toEqual(before.map((f: any) => f.title));
    expect(after[0].key).toBe('F-1');
    expect(after.find((f: any) => f.key === 'F-2').imageCount).toBe(0);

    // A bad row is a warning, not a failed import
    const bad = await api('POST', '/api/projects/import', { json: { ...lean, features: [{ title: 'Fine' }, { title: 'Bad', status: 'nope' }, { nope: 1 }] }, slug: 'feat-bad' });
    expect(bad.status).toBe(201);
    expect(bad.body.imported.features).toBe(1);
    expect(bad.body.warnings.join('\n')).toMatch(/Feature "Bad" skipped/);

    // Deleting the project removes its board
    const copyId = hub.projects.require('feat-copy').id;
    expect((await api('DELETE', '/api/projects/feat-copy')).status).toBeLessThan(300);
    expect((hub.db.prepare('SELECT COUNT(*) AS n FROM features WHERE project_id = ?').get(copyId) as { n: number }).n).toBe(0);
    expect((hub.db.prepare('SELECT COUNT(*) AS n FROM feature_images WHERE project_id = ?').get(copyId) as { n: number }).n).toBe(0);
  });

  it('MCP tools read and update the board', async () => {
    const tools = (await api('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).body.result.tools.map((t: { name: string }) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['list_features', 'get_feature', 'upsert_feature', 'delete_feature', 'add_task', 'update_task', 'delete_task', 'add_feature_image']));
    const created = await mcp('upsert_feature', { project: 'other', title: 'Agent feature', details: 'From MCP', tasks: [{ title: 'Step 1', subtasks: [{ title: 'Sub' }] }] });
    expect(created).toMatchObject({ key: 'F-1', title: 'Agent feature', progress: { done: 0, total: 2 } });
    const upd = await mcp('upsert_feature', { project: 'other', feature: 'F-1', status: 'in_progress' });
    expect(upd.status).toBe('in_progress');
    await expect(mcp('upsert_feature', { project: 'other', feature: 'F-1', tasks: [{ title: 'x' }] })).rejects.toThrow(/use add_task/);
    const t = await mcp('add_task', { project: 'other', feature: 'F-1', title: 'Step 2', assignee: 'agent' });
    const sub = await mcp('add_task', { project: 'other', feature: 'F-1', title: 'Step 2a', parent: t.task.id });
    expect(sub.task.parentTaskId).toBe(t.task.id);
    await expect(mcp('add_task', { project: 'other', feature: 'F-1', title: 'deep', parent: sub.task.id })).rejects.toThrow(/Subtasks cannot have subtasks/);
    const done = await mcp('update_task', { project: 'other', feature: 'F-1', task: sub.task.id, done: true });
    expect(done.feature.progress).toEqual({ done: 1, total: 4 });
    const moved = await mcp('update_task', { project: 'other', feature: 'F-1', task: sub.task.id, parent: '' });
    expect(moved.task.parentTaskId).toBeNull();
    const img = await mcp('add_feature_image', { project: 'other', feature: 'F-1', data_url: dataUrl('image/png', PNG), name: 'shot.png' });
    expect(img.markdown).toMatch(/^!\[shot\.png\]\(image:/);
    const list = await mcp('list_features', { project: 'other', status: 'in_progress' });
    expect(list.features).toEqual([expect.objectContaining({ key: 'F-1', images: 1, progress: { done: 1, total: 4 } })]);
    const got = await mcp('get_feature', { project: 'other', feature: 'F-1' });
    expect(got.tasks.map((x: any) => x.title)).toEqual(['Step 1', 'Step 2', 'Step 2a']);
    expect(await mcp('delete_task', { project: 'other', feature: 'F-1', task: t.task.id })).toMatchObject({ deleted: t.task.id });
    expect(await mcp('delete_feature', { project: 'other', feature: 'F-1' })).toMatchObject({ key: 'F-1', images: 1 });
    expect((await mcp('list_features', { project: 'other' })).features).toEqual([]);
  });

  it('@stubyard/client features helpers drive the board', async () => {
    const c: any = await import(new URL('../../packages/client/src/index.ts', import.meta.url).pathname);
    const t = { apiUrl: base, project: 'other' };
    const f = await c.createFeature(t, { title: 'Client feature', priority: 'low', tasks: [{ title: 'One', subtasks: [{ title: 'One a' }] }] });
    expect(f).toMatchObject({ key: 'F-2', priority: 'low', progress: { done: 0, total: 2 } });
    const two = await c.addTask(t, f.key, { title: 'Two', assignee: 'QA' });
    await c.addTask(t, f.key, { title: 'Two a', parentTaskId: two.task.id });
    const tg = await c.toggleTask(t, f.key, two.task.id);
    expect(tg.task.done).toBe(true);
    expect((await c.toggleTask(t, f.key, two.task.id, true)).task.done).toBe(true);
    await c.updateTask(t, f.key, two.task.id, { title: 'Two!' });
    const re = await c.reorderTasks(t, f.key, [two.task.id, f.tasks[0].id]);
    expect(re.tasks.map((x: any) => x.title)).toEqual(['Two!', 'One']);
    await c.updateFeature(t, f.key, { status: 'done' });
    const img = await c.addFeatureImage(t, f.key, dataUrl('image/png', PNG), 'a.png');
    expect((await c.listFeatureImages(t, f.key)).map((i: any) => i.id)).toEqual([img.id]);
    await c.deleteFeatureImage(t, f.key, img.id);
    const g = await c.createFeature(t, { title: 'Second' });
    expect((await c.reorderFeatures(t, [g.key, f.key])).map((x: any) => x.key)).toEqual([g.key, f.key]);
    const l = await c.listFeatures(t, { status: ['done'] });
    expect(l.features.map((x: any) => x.key)).toEqual([f.key]);
    expect(l.counts).toMatchObject({ done: 1, idea: 1, all: 2 });
    expect((await c.getFeature(t, f.key)).tasks[0].subtasks[0].title).toBe('Two a');
    await expect(c.addTask(t, f.key, { title: 'deep', parentTaskId: re.tasks[0].subtasks[0].id })).rejects.toMatchObject({ status: 400 });
    expect((await c.deleteTask(t, f.key, two.task.id)).subtasks).toBe(1);
    expect(await c.deleteFeature(t, f.key)).toMatchObject({ key: f.key });
    await c.deleteFeature(t, g.key);
  });

  it('publishes features.changed on the project stream', async () => {
    const seen: { type: string; data: any }[] = [];
    const off = hub.bus.subscribe((e) => {
      if (e.type === 'features.changed') seen.push(e as { type: string; data: any });
    });
    const f = (await api('POST', F, { title: 'Evented' })).body;
    await api('POST', `${F}/${f.key}/tasks`, { title: 'a' });
    await api('DELETE', `${F}/${f.key}`);
    off();
    expect(seen.map((e) => e.data.kind)).toEqual(['created', 'task.created', 'deleted']);
    expect(seen[0].data).toMatchObject({ id: f.id, key: f.key });
    const ref = (await api('GET', '/api/features/reference')).body;
    expect(ref.statuses).toEqual(['idea', 'planned', 'in_progress', 'done']);
  });
});
