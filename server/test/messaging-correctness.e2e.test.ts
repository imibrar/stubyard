import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { startHub, type RunningHub } from '../src/index.js';
import { Scheduler } from '../src/jobs/scheduler.js';
import { smsSegments } from '../src/messages/sms-segments.js';
import { MessageRepo } from '../src/repos/messages.js';
import { ProjectRepo } from '../src/repos/projects.js';
import { RuleRepo } from '../src/repos/rules.js';
import { UserRepo } from '../src/repos/users.js';
import { RuleEngine } from '../src/rules/engine.js';

const MAILPIT_BIN = process.env.STUBYARD_MAILPIT_BIN ?? '/usr/local/bin/mailpit';
const haveMailpit = fs.existsSync(MAILPIT_BIN);

// ---------------- unit: SMS segments ----------------

describe('smsSegments', () => {
  it.each([
    ['', 'GSM-7', 1],
    ['a'.repeat(160), 'GSM-7', 1],
    ['a'.repeat(161), 'GSM-7', 2],
    ['a'.repeat(306), 'GSM-7', 2],
    ['a'.repeat(307), 'GSM-7', 3],
    // Extension characters take two septets: 80 × "€" = 160 septets, 81 do not fit.
    ['€'.repeat(80), 'GSM-7', 1],
    ['€'.repeat(81), 'GSM-7', 2],
    ['{}[]~^|\\', 'GSM-7', 1],
    ['é à ü Ñ £ ¥ § ¿ ¡ Δ', 'GSM-7', 1],
    ['ا'.repeat(70), 'UCS-2', 1],
    ['ا'.repeat(71), 'UCS-2', 2],
    ['ا'.repeat(134), 'UCS-2', 2],
    ['ا'.repeat(135), 'UCS-2', 3],
    // One non-GSM character switches the whole message to UCS-2.
    ['a'.repeat(69) + 'ç', 'UCS-2', 1],
    ['a'.repeat(70) + 'ç', 'UCS-2', 2],
    // Emoji are two UTF-16 units: 35 fit in one SMS.
    ['😀'.repeat(35), 'UCS-2', 1],
    ['😀'.repeat(36), 'UCS-2', 2],
  ])('%#: %s → %s × %d', (text, encoding, segments) => {
    expect(smsSegments(text)).toMatchObject({ encoding, segments });
  });

  it('never splits an emoji or an extension character across parts', () => {
    // 66 units + one emoji (2 units) does not fit 67: the emoji starts part 2.
    expect(smsSegments('ا'.repeat(66) + '😀' + 'ا'.repeat(10)).segments).toBe(2);
    expect(smsSegments('ا'.repeat(66) + '😀' + 'ا'.repeat(66)).segments).toBe(3);
    // 152 septets + "€" (2) does not fit 153.
    expect(smsSegments('a'.repeat(152) + '€' + 'a'.repeat(10)).segments).toBe(2);
    expect(smsSegments('a'.repeat(152) + '€' + 'a'.repeat(152)).segments).toBe(3);
  });

  it('reports characters and units', () => {
    expect(smsSegments('Hi €')).toEqual({ encoding: 'GSM-7', segments: 1, characters: 4, units: 5, perSegment: 160 });
    expect(smsSegments('کوڈ 😀')).toEqual({ encoding: 'UCS-2', segments: 1, characters: 5, units: 6, perSegment: 70 });
  });
});

// ---------------- unit: rule engine peek / scheduler purge / monotonic ids ----------------

describe('rule engine peek', () => {
  it('only uses up "next N" / "after N" rules on commit', () => {
    const db = openDb(':memory:');
    const p = new ProjectRepo(db).create({ name: 'P' });
    const u = new UserRepo(db).create(p.id, { name: 'A', email: 'a@p.test' });
    const rules = new RuleRepo(db);
    rules.add(p.id, { scope: 'user', testUserId: u.id }, { channel: 'email', action: 'fail', count: 1 });
    const engine = new RuleEngine(rules);
    const input = { projectId: p.id, channel: 'email' as const, instance: null, user: u };
    const a = engine.peek(input);
    expect(a.decision.action).toBe('fail');
    // Not committed: the rule still applies.
    const b = engine.peek(input);
    expect(b.decision.action).toBe('fail');
    b.commit();
    b.commit(); // idempotent
    expect(engine.peek(input).decision.action).toBe('deliver');
    expect(rules.list(p.id, { scope: 'user', testUserId: u.id })[0]).toMatchObject({ hits: 1, active: false });
  });
});

describe('scheduler purge', () => {
  it('deletes finished jobs older than 24 h, keeps pending and recent ones', () => {
    const db = openDb(':memory:');
    const s = new Scheduler(db, pino({ level: 'silent' }) as never);
    const old = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const ins = db.prepare('INSERT INTO scheduled_jobs (id, project_id, type, run_at, payload, status, created_at) VALUES (?,?,?,?,?,?,?)');
    ins.run('a', null, 'x', old, '{}', 'done', old);
    ins.run('b', null, 'x', old, '{}', 'failed', old);
    ins.run('c', null, 'x', old, '{}', 'pending', old);
    ins.run('d', null, 'x', new Date().toISOString(), '{}', 'done', old);
    expect(s.purgeFinished()).toBe(2);
    const left = (db.prepare('SELECT id FROM scheduled_jobs ORDER BY id').all() as { id: string }[]).map((r) => r.id);
    expect(left).toEqual(['c', 'd']);
    // Periodic: a tick an hour later purges again.
    expect(s.purgeFinished(0, Date.now() + 3_600_000)).toBe(1);
  });
});

describe('message ids', () => {
  it('are strictly increasing, even within one millisecond', () => {
    const db = openDb(':memory:');
    const p = new ProjectRepo(db).create({ name: 'P' });
    const repo = new MessageRepo(db);
    const ids = Array.from({ length: 200 }, () =>
      repo.insert({
        projectId: p.id, testUserId: null, providerInstanceId: null, channel: 'sms', direction: 'outbound', from: null, to: '+1', subject: null,
        bodyText: 'x', hasHtml: false, attachments: 0, mailpitId: null, messageIdHeader: null, status: 'delivered', otp: null, links: [], logId: null,
      }).id,
    );
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect(repo.cursor(p.id)).toBe(ids.at(-1));
    // A new repo (restart) continues after the newest stored id.
    expect(new MessageRepo(db).cursor(p.id)).toBe(ids.at(-1));
  });
});

// ---------------- end to end ----------------

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

let running: RunningHub;
let base: string;
let smtpPort: number;
let dataDir: string;

async function api<T = any>(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T; headers: Headers }> {
  const r = await fetch(base + p, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: r.status, body: parsed as T, headers: r.headers };
}

const mail = (to: string, text: string, subject = 'Code') =>
  nodemailer
    .createTransport({ host: '127.0.0.1', port: smtpPort, secure: false, ignoreTLS: true, auth: { user: 'mc', pass: 'x' } })
    .sendMail({ from: 'app@mc.app', to, subject, text });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A raw SMTP conversation: sends each command and collects the reply lines. */
async function smtpTalk(commands: string[]): Promise<string[]> {
  const sock = net.connect(smtpPort, '127.0.0.1');
  const replies: string[] = [];
  let buf = '';
  let waiter: ((line: string) => void) | null = null;
  sock.on('data', (d) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (/^\d{3} /.test(line) && waiter) {
        const w = waiter;
        waiter = null;
        w(line);
      }
    }
  });
  const next = () => new Promise<string>((r) => (waiter = r));
  await next(); // banner
  for (const c of commands) {
    const p = next();
    sock.write(c + '\r\n');
    replies.push(await p);
  }
  sock.end();
  return replies;
}

describe.skipIf(!haveMailpit)('messaging correctness (end to end)', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-mc-'));
    const [httpPort, httpsPort, smtp, mpHttp, mpSmtp] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
    smtpPort = smtp;
    const config = loadConfig({
      host: '127.0.0.1',
      httpPort,
      httpsPort,
      smtpPort,
      dataDir,
      webDir: path.join(dataDir, 'no-web'),
      mailpitBin: MAILPIT_BIN,
      mailpitUrl: `http://127.0.0.1:${mpHttp}`,
      mailpitSmtpHost: '127.0.0.1',
      mailpitSmtpPort: mpSmtp,
      spawnMailpit: true,
      logLevel: 'silent',
      callbackDelayMs: 100,
      timeoutHoldMs: 300,
    });
    running = await startHub(config, { logger: pino({ level: 'silent' }) });
    base = `http://127.0.0.1:${httpPort}`;
    const r = await api('POST', '/api/projects', { name: 'MC', generateUsers: { admins: 1, customers: 6 } });
    expect(r.status).toBe(201);
  });

  afterAll(async () => {
    await running?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('wait with a cursor never returns the stale code after "resend"', async () => {
    await mail('customer1@mc.test', 'Your code is 1111');
    // The default 10 s lookback would hand back the old code…
    const stale = await api('GET', '/api/projects/mc/messages/wait?user=customer1&otp=1&timeout=1');
    expect(stale.body.otp).toBe('1111');
    expect(stale.body.cursor).toBe(stale.body.id);
    expect(stale.headers.get('x-stubyard-cursor')).toBe(stale.body.id);

    // …so: take the cursor first, trigger "resend", wait after the cursor.
    const cur = await api('GET', '/api/projects/mc/messages/cursor?user=customer1');
    expect(cur.status).toBe(200);
    expect(cur.body.cursor).toBe(stale.body.id);
    const pending = api('GET', `/api/projects/mc/messages/wait?user=customer1&otp=1&after=${cur.body.cursor}&timeout=5`);
    await sleep(100);
    await mail('customer1@mc.test', 'Your code is 2222');
    const fresh = await pending;
    expect(fresh.status).toBe(200);
    expect(fresh.body.otp).toBe('2222');
    expect(fresh.body.cursor > cur.body.cursor).toBe(true);

    // Already arrived before the wait call: still found (no race between trigger and wait).
    const cur2 = (await api('GET', '/api/projects/mc/messages/cursor?user=customer1')).body.cursor;
    await mail('customer1@mc.test', 'Your code is 3333');
    expect((await api('GET', `/api/projects/mc/messages/wait?user=customer1&after=${cur2}&timeout=2`)).body.otp).toBe('3333');

    // Timeout keeps a usable cursor.
    const t = await api('GET', `/api/projects/mc/messages/wait?user=customer1&after=${fresh.body.cursor}&channel=sms&timeout=0.2`);
    expect(t.status).toBe(408);
    expect(t.body.cursor >= fresh.body.cursor).toBe(true);

    // Project-wide cursor of an empty filter, and the list header.
    expect((await api('GET', '/api/projects/mc/messages/cursor?user=customer6')).body).toEqual({ cursor: '0', newestAt: null });
    const list = await api('GET', '/api/projects/mc/messages?user=customer1');
    expect(list.headers.get('x-stubyard-cursor')).toBe(list.body[0].id);
  });

  it('expect-none: 200 when nothing arrives, 409 with the offending message otherwise', async () => {
    const quiet = await api('GET', '/api/projects/mc/messages/expect-none?user=customer2&within=0.3');
    expect(quiet.status).toBe(200);
    expect(quiet.body).toMatchObject({ ok: true, count: 0, within: 0.3 });

    const pending = api('GET', '/api/projects/mc/messages/expect-none?user=customer2&within=5');
    await sleep(100);
    await mail('customer2@mc.test', 'Unexpected 5544', 'Surprise');
    const loud = await pending;
    expect(loud.status).toBe(409);
    expect(loud.body.count).toBe(1);
    expect(loud.body.messages[0]).toMatchObject({ subject: 'Surprise' });
    expect(loud.body.error).toMatch(/Expected no matching message.*Surprise/);

    // With a cursor taken before the action, a message that arrived before the call is caught too.
    const cur = (await api('GET', '/api/projects/mc/messages/cursor?user=customer2')).body.cursor;
    await mail('customer2@mc.test', 'Second one');
    const caught = await api('GET', `/api/projects/mc/messages/expect-none?user=customer2&after=${cur}&within=1`);
    expect(caught.status).toBe(409);
    // Other users are not affected.
    expect((await api('GET', `/api/projects/mc/messages/expect-none?user=customer3&after=${cur}&within=0.2`)).status).toBe(200);
  });

  it('count / exactly: wait for N messages, report too many', async () => {
    const cur = (await api('GET', '/api/projects/mc/messages/cursor')).body.cursor;
    const pending = api('GET', `/api/projects/mc/messages/wait?user=customer3&after=${cur}&count=2&timeout=5`);
    await mail('customer3@mc.test', 'one');
    await mail('customer3@mc.test', 'two');
    const two = await pending;
    expect(two.status).toBe(200);
    expect(two.body).toMatchObject({ expected: 2, count: 2 });
    expect(two.body.messages.map((m: any) => m.bodyText)).toEqual(['one', 'two']);
    expect(two.body.cursor).toBe(two.body.messages[1].id);

    const tooMany = await api('GET', `/api/projects/mc/messages/wait?user=customer3&after=${cur}&exactly=1&timeout=1`);
    expect(tooMany.status).toBe(409);
    expect(tooMany.body).toMatchObject({ expected: 1, count: 2 });
    expect(tooMany.body.error).toMatch(/Expected exactly 1 matching message, got 2/);

    const exact = await api('GET', `/api/projects/mc/messages/wait?user=customer3&after=${cur}&exactly=2&settle=0.2&timeout=1`);
    expect(exact.status).toBe(200);
    expect(exact.body.count).toBe(2);

    // exactly=1 notices a second message arriving during the settle time.
    const cur2 = exact.body.cursor;
    const settling = api('GET', `/api/projects/mc/messages/wait?user=customer3&after=${cur2}&exactly=1&settle=3&timeout=5`);
    await mail('customer3@mc.test', 'first');
    await sleep(100);
    await mail('customer3@mc.test', 'duplicate');
    const dup = await settling;
    expect(dup.status).toBe(409);
    expect(dup.body.count).toBe(2);

    const short = await api('GET', `/api/projects/mc/messages/wait?user=customer3&after=${cur}&count=9&timeout=0.2`);
    expect(short.status).toBe(408);
    expect(short.body).toMatchObject({ expected: 9, count: 4 });

    expect((await api('GET', '/api/projects/mc/messages/wait?count=1&exactly=1')).status).toBe(400);
    expect((await api('GET', '/api/projects/mc/messages/wait?exactly=0')).status).toBe(400);
    expect((await api('GET', '/api/projects/mc/messages/wait?count=abc')).status).toBe(400);
  });

  it('SMTP: an abandoned transaction does not use up "fail next 1"; refusals are used up when returned', async () => {
    const add = await api('POST', '/api/projects/mc/users/customer4/rules', { channel: 'email', action: 'fail', count: 1 });
    expect(add.status).toBe(201);
    const replies = await smtpTalk(['EHLO test', 'MAIL FROM:<app@mc.app>', 'RCPT TO:<customer4@mc.test>', 'RSET', 'MAIL FROM:<app@mc.app>', 'RCPT TO:<customer4@mc.test>', 'QUIT']);
    expect(replies[2]).toMatch(/^250/);
    expect(replies[5]).toMatch(/^250/);
    let [rule] = (await api('GET', '/api/projects/mc/users/customer4/rules')).body;
    expect(rule).toMatchObject({ active: true, hits: 0, remainingCount: 1 });

    // A real send uses it up (DATA accepted), the next one is delivered.
    await mail('customer4@mc.test', 'first try');
    await mail('customer4@mc.test', 'second try');
    const msgs = (await api('GET', '/api/projects/mc/messages?user=customer4')).body;
    // "fail" = accepted, then bounced (failed → bounced once the DSN went out).
    expect(msgs.map((m: any) => [m.bodyText, m.status === 'bounced' ? 'failed' : m.status])).toEqual([
      ['second try', 'delivered'],
      ['first try', 'failed'],
    ]);
    [rule] = (await api('GET', '/api/projects/mc/users/customer4/rules')).body;
    expect(rule).toMatchObject({ active: false, hits: 1, remainingCount: 0 });

    // Refusal at RCPT TO counts when it is returned, even without DATA.
    await api('POST', '/api/projects/mc/users/customer5/rules', { channel: 'email', action: 'reject', count: 1 });
    const r2 = await smtpTalk(['EHLO test', 'MAIL FROM:<app@mc.app>', 'RCPT TO:<customer5@mc.test>', 'RCPT TO:<customer5@mc.test>', 'QUIT']);
    expect(r2[2]).toMatch(/^550/);
    expect(r2[3]).toMatch(/^250/);
    const [rule5] = (await api('GET', '/api/projects/mc/users/customer5/rules')).body;
    expect(rule5).toMatchObject({ active: false, hits: 1 });
  });

  it('SMS: num_segments and metadata.segments / encoding follow GSM-7 and UCS-2', async () => {
    const created = await api('POST', '/api/projects/mc/providers', { preset: 'twilio', slug: 'sms' });
    expect(created.status).toBe(201);
    const phone = (await api('GET', '/api/projects/mc/users/customer1')).body.phone;
    const send = (body: string) =>
      api('POST', '/mock/mc/sms/2010-04-01/Accounts/ACtest/Messages.json', new URLSearchParams({ To: phone, From: '+15550001111', Body: body }).toString(), {
        'content-type': 'application/x-www-form-urlencoded',
      });
    const cases: [string, number, string][] = [
      ['a'.repeat(160), 1, 'GSM-7'],
      ['a'.repeat(161), 2, 'GSM-7'],
      ['آپ کا کوڈ 482193 ہے', 1, 'UCS-2'],
      ['ک'.repeat(71), 2, 'UCS-2'],
      ['Your code is 1234 😀', 1, 'UCS-2'],
    ];
    for (const [body, segments, encoding] of cases) {
      const r = await send(body);
      expect(r.status).toBe(201);
      expect(r.body.num_segments).toBe(String(segments));
      const [m] = (await api('GET', '/api/projects/mc/messages?user=customer1&channel=sms&limit=1')).body;
      expect(m.metadata).toMatchObject({ segments, encoding });
    }
  });
});
