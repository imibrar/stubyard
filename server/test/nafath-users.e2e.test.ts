import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import { createHub } from '../src/index.js';
import { generateNationalId, isNationalId, NATIONAL_ID_RE, nationalIdKind } from '../src/nafath/national-id.js';

describe('national IDs', () => {
  it('checks the Luhn digit and the kind', () => {
    // Published sample numbers that pass the public validators.
    for (const id of ['1000000008', '2000000006', '1234567897']) expect(isNationalId(id)).toBe(true);
    expect(isNationalId('1000000009')).toBe(false); // wrong check digit
    expect(isNationalId('3000000004')).toBe(false); // passes Luhn but starts with 3
    expect(isNationalId('100000000')).toBe(false);
    expect(isNationalId('10000000080')).toBe(false);
    expect(isNationalId('')).toBe(false);
    expect(isNationalId(null)).toBe(false);
    expect(nationalIdKind('1000000008')).toBe('citizen');
    expect(nationalIdKind('2000000006')).toBe('resident');
    expect(nationalIdKind('1000000009')).toBeNull();
  });

  it('generates valid IDs of the asked kind', () => {
    for (let i = 0; i < 200; i++) {
      const c = generateNationalId('citizen');
      const r = generateNationalId('resident');
      expect(c).toMatch(NATIONAL_ID_RE);
      expect(isNationalId(c) && nationalIdKind(c)).toBe('citizen');
      expect(isNationalId(r) && nationalIdKind(r)).toBe('resident');
    }
    // A fixed source gives a fixed ID; rnd() = 0.999… still yields digits 0-9.
    expect(generateNationalId('citizen', () => 0)).toBe('1000000008');
    expect(isNationalId(generateNationalId('resident', () => 0.9999999))).toBe(true);
  });
});

describe('test users with national IDs (HTTP)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let hub: ReturnType<typeof createHub>;
  let dataDir: string;
  let base = '';

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

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-nafath-users-'));
    const config = loadConfig({ host: '127.0.0.1', httpPort: 0, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0, admin: null });
    hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger: pino({ level: 'silent' }) });
    ({ app } = await buildApp(hub, pino({ level: 'silent' })));
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
    expect((await api('POST', '/api/projects', { name: 'Ksa' })).status).toBe(201);
  });
  afterAll(async () => {
    await app.close();
    hub.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('creates and patches a user with a national ID and identity; 400 when invalid, 409 when taken', async () => {
    const identity = { firstNameAr: 'محمد', englishFirstName: 'Mohammed', gender: 'M', dateOfBirthG: '1990-01-01' };
    const a = await api('POST', '/api/projects/ksa/users', { name: 'Mohammed', nationalId: '1000000008', identity });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ nationalId: '1000000008', identity });
    const plain = await api('POST', '/api/projects/ksa/users', { name: 'Plain' });
    expect(plain.body).toMatchObject({ nationalId: null, identity: {} });

    expect((await api('POST', '/api/projects/ksa/users', { name: 'Bad', nationalId: '1000000009' })).status).toBe(400);
    expect((await api('POST', '/api/projects/ksa/users', { name: 'Bad', nationalId: '3000000004' })).status).toBe(400);
    expect((await api('POST', '/api/projects/ksa/users', { name: 'Bad', identity: ['x'] })).status).toBe(400);
    expect((await api('POST', '/api/projects/ksa/users', { name: 'Bad', identity: 'x' })).status).toBe(400);
    expect((await api('POST', '/api/projects/ksa/users', { name: 'Bad', identity: { blob: 'x'.repeat(9000) } })).status).toBe(400);
    const dup = await api('POST', '/api/projects/ksa/users', { name: 'Dup', nationalId: '1000000008' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatch(/National ID 1000000008/);

    expect((await api('PATCH', `/api/projects/ksa/users/${plain.body.id}`, { nationalId: '1000000008' })).status).toBe(409);
    expect((await api('PATCH', `/api/projects/ksa/users/${plain.body.id}`, { nationalId: 'abc' })).status).toBe(400);
    const p = await api('PATCH', `/api/projects/ksa/users/${plain.body.id}`, { nationalId: '2000000006', identity: { gender: 'F' } });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ nationalId: '2000000006', identity: { gender: 'F' } });
    // Other fields leave them alone; null clears the ID.
    expect((await api('PATCH', `/api/projects/ksa/users/${plain.body.id}`, { notes: 'n' })).body).toMatchObject({ nationalId: '2000000006', identity: { gender: 'F' } });
    expect((await api('PATCH', `/api/projects/ksa/users/${plain.body.id}`, { nationalId: null })).body.nationalId).toBeNull();

    // The same ID is fine in another project.
    expect((await api('POST', '/api/projects', { name: 'Other' })).status).toBe(201);
    expect((await api('POST', '/api/projects/other/users', { name: 'Twin', nationalId: '1000000008' })).status).toBe(201);
  });

  it('resolves a national ID before a phone number with the same digits', async () => {
    // A phone of 10 digits that is also a valid national ID.
    const byPhone = await api('POST', '/api/projects/ksa/users', { name: 'Phone owner', phone: '1234567897' });
    expect(byPhone.status).toBe(201);
    expect(byPhone.body.phone).toBe('+1234567897');
    expect((await api('GET', '/api/projects/ksa/users/1234567897')).body.id).toBe(byPhone.body.id);
    const byId = await api('POST', '/api/projects/ksa/users', { name: 'ID owner', nationalId: '1234567897' });
    expect(byId.status).toBe(201);
    expect((await api('GET', '/api/projects/ksa/users/1234567897')).body.id).toBe(byId.body.id);
    expect(hub.users.findByNationalId(hub.projects.require('ksa').id, '1234567897')?.id).toBe(byId.body.id);
  });

  it('generates users with unique national IDs: customers alternate citizen / resident, staff are citizens', async () => {
    expect((await api('POST', '/api/projects', { name: 'Gen' })).status).toBe(201);
    const r = await api('POST', '/api/projects/gen/users/generate', { roles: [{ role: 'admin', count: 1 }, { role: 'sales', count: 2 }, { role: 'customer', count: 4 }] });
    expect(r.status).toBe(201);
    const users = r.body as { role: string; nationalId: string }[];
    expect(users).toHaveLength(7);
    for (const u of users) expect(isNationalId(u.nationalId)).toBe(true);
    expect(new Set(users.map((u) => u.nationalId)).size).toBe(7);
    expect(users.filter((u) => u.role !== 'customer').map((u) => nationalIdKind(u.nationalId))).toEqual(['citizen', 'citizen', 'citizen']);
    expect(users.filter((u) => u.role === 'customer').map((u) => nationalIdKind(u.nationalId))).toEqual(['citizen', 'resident', 'citizen', 'resident']);
    // Numbering continues: the fifth customer is a citizen, the sixth a resident.
    const more = await api('POST', '/api/projects/gen/users/generate', { roles: [{ role: 'customer', count: 2 }] });
    expect(more.body.map((u: { nationalId: string }) => nationalIdKind(u.nationalId))).toEqual(['citizen', 'resident']);
  });

  it('ensureNationalIds fills the users that have none and keeps the rest', async () => {
    expect((await api('POST', '/api/projects', { name: 'Fill' })).status).toBe(201);
    const pid = hub.projects.require('fill').id;
    const kept = await api('POST', '/api/projects/fill/users', { name: 'Has one', role: 'customer', nationalId: '2000000006' });
    for (const [name, role] of [['Admin', 'admin'], ['C2', 'customer'], ['C3', 'customer']]) {
      expect((await api('POST', '/api/projects/fill/users', { name, role })).status).toBe(201);
    }
    expect(hub.users.ensureNationalIds(pid)).toBe(3);
    const all = hub.users.list(pid, { all: true });
    expect(all.every((u) => isNationalId(u.nationalId))).toBe(true);
    expect(new Set(all.map((u) => u.nationalId)).size).toBe(4);
    expect(all.find((u) => u.id === kept.body.id)?.nationalId).toBe('2000000006');
    expect(nationalIdKind(all.find((u) => u.name === 'Admin')!.nationalId)).toBe('citizen');
    // Customers are numbered in list order: "Has one" (1), C2 (2) = resident, C3 (3) = citizen.
    expect(nationalIdKind(all.find((u) => u.name === 'C2')!.nationalId)).toBe('resident');
    expect(nationalIdKind(all.find((u) => u.name === 'C3')!.nationalId)).toBe('citizen');
    expect(hub.users.ensureNationalIds(pid)).toBe(0);
  });

  it('keeps national IDs and identity through export and import; older files without them still import', async () => {
    const file = (await api('GET', '/api/projects/ksa/export')).body;
    const exported = (file.users as { name: string; nationalId: string | null; identity: unknown }[]).find((u) => u.name === 'Mohammed');
    expect(exported).toMatchObject({ nationalId: '1000000008', identity: { englishFirstName: 'Mohammed' } });
    const imp = await api('POST', '/api/projects/import', { json: file, slug: 'ksa-copy' });
    expect(imp.status).toBe(201);
    const users = (await api('GET', '/api/projects/ksa-copy/users')).body as { name: string; nationalId: string | null; identity: unknown }[];
    expect(users.find((u) => u.name === 'Mohammed')).toMatchObject({ nationalId: '1000000008', identity: { firstNameAr: 'محمد', gender: 'M' } });
    expect(users.find((u) => u.name === 'ID owner')?.nationalId).toBe('1234567897');

    const old = { ...file, users: (file.users as Record<string, unknown>[]).map(({ nationalId: _n, identity: _i, ...rest }) => rest) };
    const imp2 = await api('POST', '/api/projects/import', { json: old, slug: 'ksa-old' });
    expect(imp2.status).toBe(201);
    const oldUsers = (await api('GET', '/api/projects/ksa-old/users')).body as { nationalId: string | null; identity: unknown }[];
    expect(oldUsers.length).toBe(users.length);
    expect(oldUsers.every((u) => u.nationalId === null && JSON.stringify(u.identity) === '{}')).toBe(true);
  });
});
