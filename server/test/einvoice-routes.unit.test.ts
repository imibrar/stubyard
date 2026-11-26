import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fastify, { type FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { EinvoiceService } from '../src/einvoice/service.js';
import { registerZatcaApi } from '../src/einvoice/zatca/api.js';
import { FIRST_PIH } from '../src/einvoice/zatca/hash.js';
import type { Hub } from '../src/hub.js';
import { registerEinvoiceRoutes } from '../src/http/routes/einvoice.js';
import { createHub } from '../src/index.js';
import type { Project } from '../src/repos/projects.js';
import { HttpError } from '../src/util.js';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const basic = (c: { binarySecurityToken: string; secret: string }) => `Basic ${b64(`${c.binarySecurityToken}:${c.secret}`)}`;
const V2 = { 'accept-version': 'V2', 'accept-language': 'en' };

let hub: Hub;
let app: FastifyInstance;
let svc: EinvoiceService;
let project: Project;
let dataDir: string;
const A = () => `/api/projects/${project.slug}/einvoice`;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-einv-routes-'));
  const config = loadConfig({ host: '127.0.0.1', httpPort: 0, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0, timeoutHoldMs: 200 });
  hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger: pino({ level: 'silent' }) });
  svc = new EinvoiceService({ db: hub.db, timeoutHoldMs: 200 });
  project = hub.projects.create({ name: 'Einv Routes' });

  app = fastify();
  // The error shape of http/app.ts (auth / permissions are app-wide there, not part of these routes).
  app.setErrorHandler((err, _req, reply) => {
    const status = err instanceof HttpError ? err.statusCode : (err as { statusCode?: number }).statusCode ?? 500;
    reply.status(status).send({ error: (err as Error).message });
  });
  await registerZatcaApi(app, hub, svc);
  await registerEinvoiceRoutes(app, hub, svc);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  hub?.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('einvoice control API', () => {
  it('instances: create, list, get, patch, otp, connect, ca.pem; the CA key is never shown', async () => {
    const c = await app.inject({ method: 'POST', url: `${A()}/instances`, payload: { slug: 'zatca', config: { checks: 'basic', requireComplianceChecks: false, env: 'simulation' } } });
    expect(c.statusCode).toBe(201);
    const inst = c.json();
    expect(inst.config.caKeyPem).toBeUndefined();
    expect(inst.config.hasCaKey).toBe(true);
    expect(inst.urls.envBase).toMatch(new RegExp(`/einvoice/${project.slug}/zatca/e-invoicing/simulation$`));

    expect((await app.inject({ method: 'POST', url: `${A()}/instances`, payload: { slug: 'zatca' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: `${A()}/instances` })).json()).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: `${A()}/instances/zatca` })).json().id).toBe(inst.id);
    expect((await app.inject({ method: 'GET', url: `${A()}/instances/nope` })).statusCode).toBe(404);

    const p = await app.inject({ method: 'PATCH', url: `${A()}/instances/zatca`, payload: { name: 'Fatoora sim', config: { otp: '654321' } } });
    expect(p.json()).toMatchObject({ name: 'Fatoora sim', config: { otp: '654321', env: 'simulation' } });
    expect((await app.inject({ method: 'PUT', url: `${A()}/instances/zatca`, payload: { config: { otp: 'abc' } } })).statusCode).toBe(400);

    const o = await app.inject({ method: 'POST', url: `${A()}/instances/zatca/otp` });
    expect(o.statusCode).toBe(201);
    const { otp } = o.json();
    expect(otp).toMatch(/^\d{6}$/);
    const csr = (await app.inject({ method: 'POST', url: `${A()}/sample` })).json().egs; // creates the demo EGS
    expect(csr.vat).toMatch(/^3\d{13}3$/);

    const k = await app.inject({ method: 'GET', url: `${A()}/instances/zatca/connect` });
    expect(k.statusCode).toBe(200);
    const conn = k.json();
    expect(conn).toMatchObject({ env: 'simulation', csrTemplate: 'PREZATCA-Code-Signing', firstPih: FIRST_PIH });
    expect(conn.dotenv).toMatchObject({ ZATCA_BASE_URL: inst.urls.envBase, ZATCA_OTP: '654321' });
    const ids = conn.snippets.map((s: { id: string }) => s.id);
    expect(ids).toEqual(expect.arrayContaining(['env', 'curl', 'node', 'python', 'php', 'csharp', 'sdk']));
    for (const s of conn.snippets) expect(s.code).toContain(inst.urls.envBase);

    const pem = await app.inject({ method: 'GET', url: `${A()}/instances/zatca/ca.pem` });
    expect(pem.statusCode).toBe(200);
    expect(pem.headers['content-type']).toContain('application/x-pem-file');
    expect(pem.headers['content-disposition']).toContain('zatca-fake-ca.pem');
    expect(pem.body).toContain('-----BEGIN CERTIFICATE-----');
    expect(pem.body).not.toContain('PRIVATE KEY');

    // a throwaway instance can be deleted
    await app.inject({ method: 'POST', url: `${A()}/instances`, payload: { slug: 'tmp' } });
    expect((await app.inject({ method: 'DELETE', url: `${A()}/instances/tmp` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `${A()}/instances/tmp` })).statusCode).toBe(404);
  });

  it('POST /sample then POST /validate: a valid sample has no errors, a break gives its code', async () => {
    const s = (await app.inject({ method: 'POST', url: `${A()}/sample`, payload: { type: 'simplified', icv: 1 } })).json();
    expect(s).toMatchObject({ instance: 'zatca', breaks: [], expect: [] });
    expect(s.xml).toContain('<Invoice');
    const v = await app.inject({ method: 'POST', url: `${A()}/validate`, payload: { invoice: s.invoice, invoiceHash: s.invoiceHash, uuid: s.uuid } });
    expect(v.statusCode).toBe(200);
    expect(v.json()).toMatchObject({ status: 'PASS', parsed: true, validationResults: { status: 'PASS', errorMessages: [] } });
    expect(v.json().extracted.icv).toBe(1);

    const bad = (await app.inject({ method: 'POST', url: `${A()}/sample`, payload: { break: ['wrong-uuid'] } })).json();
    expect(bad.expect).toEqual(['invalid-uuid']);
    const bv = (await app.inject({ method: 'POST', url: `${A()}/validate`, payload: { xml: bad.xml, invoiceHash: bad.invoiceHash, uuid: bad.uuid } })).json();
    expect(bv.status).toBe('ERROR');
    expect(bv.findings.map((f: { code: string }) => f.code)).toContain('invalid-uuid');

    const mh = (await app.inject({ method: 'POST', url: `${A()}/sample`, payload: { break: 'minified-hash' } })).json();
    const mv = (await app.inject({ method: 'POST', url: `${A()}/validate`, payload: { xml: mh.xml, invoiceHash: mh.invoiceHash } })).json();
    expect(mv.validationResults.errorMessages.map((m: { code: string }) => m.code)).toContain('invalid-invoice-hash');
    expect(mv.lint.map((f: { check: string }) => f.check)).toContain('einv.hash-variant');

    expect((await app.inject({ method: 'POST', url: `${A()}/sample`, payload: { break: ['nope'] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `${A()}/validate`, payload: {} })).statusCode).toBe(400);
    // a dry run stores nothing
    expect((await app.inject({ method: 'GET', url: `${A()}/invoices` })).json()).toEqual([]);
  });

  it('invoices: list / get / xml / wait after reporting a sample through the fake API; chains and reset', async () => {
    const s = (await app.inject({ method: 'POST', url: `${A()}/sample`, payload: { icv: 1, number: 'INV-R1' } })).json();
    const r = await app.inject({
      method: 'POST',
      url: `/einvoice/${project.slug}/zatca/invoices/reporting/single`,
      headers: { ...V2, 'clearance-status': '0', authorization: basic(s.auth) },
      payload: { invoiceHash: s.invoiceHash, uuid: s.uuid, invoice: s.invoice },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().reportingStatus).toBe('REPORTED');

    const l = await app.inject({ method: 'GET', url: `${A()}/invoices?status=reported&endpoint=reporting` });
    const list = l.json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ number: 'INV-R1', status: 'REPORTED', instance: 'zatca', hasXml: true });
    expect(list[0].xml).toBeUndefined();
    expect(l.headers['x-stubyard-cursor']).toBe(list[0].id);
    expect((await app.inject({ method: 'GET', url: `${A()}/invoices?number=nope` })).json()).toEqual([]);
    expect((await app.inject({ method: 'GET', url: `${A()}/invoices?endpoint=bogus` })).statusCode).toBe(400);

    const g = (await app.inject({ method: 'GET', url: `${A()}/invoices/${list[0].id}` })).json();
    expect(g.xml).toContain('INV-R1');
    expect(g.chain).toMatchObject({ scope: 'production' });
    const x = await app.inject({ method: 'GET', url: `${A()}/invoices/${list[0].id}/xml` });
    expect(x.headers['content-type']).toContain('application/xml');
    expect(x.body).toBe(g.xml);
    expect((await app.inject({ method: 'GET', url: `${A()}/invoices/${list[0].id}/xml?cleared=1` })).statusCode).toBe(404);

    const w = (await app.inject({ method: 'GET', url: `${A()}/invoices/wait?number=INV-R1&timeout=1` })).json();
    expect(w).toMatchObject({ timedOut: false, invoices: [{ number: 'INV-R1' }] });
    const w2 = (await app.inject({ method: 'GET', url: `${A()}/invoices/wait?after=${list[0].id}&timeout=0.2` })).json();
    expect(w2).toMatchObject({ timedOut: true, invoices: [] });

    const chains = (await app.inject({ method: 'GET', url: `${A()}/chains` })).json();
    expect(chains).toHaveLength(1);
    expect(chains[0]).toMatchObject({ lastIcv: 1, count: 1, lastNumber: 'INV-R1', next: { icv: 2, pih: s.invoiceHash } });
    const rc = (await app.inject({ method: 'POST', url: `${A()}/chains/${chains[0].id}/reset` })).json();
    expect(rc).toMatchObject({ lastIcv: null, count: 0, next: { icv: 1, pih: FIRST_PIH } });
    expect((await app.inject({ method: 'POST', url: `${A()}/chains/nope/reset` })).statusCode).toBe(404);

    const lint = (await app.inject({ method: 'GET', url: `${A()}/lint` })).json();
    expect(lint).toMatchObject({ invoices: 1 });
    expect(lint.counts).toHaveProperty('error');

    expect((await app.inject({ method: 'POST', url: `${A()}/reset` })).json()).toEqual({ reset: true });
    expect((await app.inject({ method: 'GET', url: `${A()}/invoices` })).json()).toEqual([]);
    expect((await app.inject({ method: 'GET', url: `${A()}/chains` })).json()).toEqual([]);
  });

  it('faults: add, list, delete one, clear', async () => {
    const a = await app.inject({ method: 'POST', url: `${A()}/faults`, payload: { fault: 'reject:br-ksa-37', endpoint: 'reporting', times: 1, instance: 'zatca' } });
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ fault: 'reject:BR-KSA-37', remaining: 1, instance: 'zatca', match: { endpoint: 'reporting' } });
    expect((await app.inject({ method: 'POST', url: `${A()}/faults`, payload: { fault: 'nope' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `${A()}/faults`, payload: { fault: 'server_error', endpoint: 'x' } })).statusCode).toBe(400);
    await app.inject({ method: 'POST', url: `${A()}/faults`, payload: { fault: 'unavailable' } });
    expect((await app.inject({ method: 'GET', url: `${A()}/faults` })).json()).toHaveLength(2);

    // the rule applies to the fake API
    const s = (await app.inject({ method: 'POST', url: `${A()}/sample`, payload: { icv: 1 } })).json();
    expect((await app.inject({ method: 'DELETE', url: `${A()}/faults/${(await app.inject({ method: 'GET', url: `${A()}/faults` })).json()[1].id}` })).statusCode).toBe(204);
    const r = await app.inject({
      method: 'POST',
      url: `/einvoice/${project.slug}/zatca/invoices/reporting/single`,
      headers: { ...V2, authorization: basic(s.auth) },
      payload: { invoiceHash: s.invoiceHash, uuid: s.uuid, invoice: s.invoice },
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.stringify(r.json())).toContain('BR-KSA-37');
    expect((await app.inject({ method: 'GET', url: `${A()}/faults` })).json()[0]).toMatchObject({ remaining: 0, hits: 1 });

    expect((await app.inject({ method: 'DELETE', url: `${A()}/faults/nope` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `${A()}/faults` })).json()).toEqual({ deleted: 1 });
    expect((await app.inject({ method: 'GET', url: `${A()}/faults` })).json()).toEqual([]);
  });

  it('CSIDs: onboarding through the fake API, list / get, revoke, expire', async () => {
    const otp = (await app.inject({ method: 'POST', url: `${A()}/instances/zatca/otp` })).json().otp;
    const { csrPem } = svc.repo.listCsids(project.id, { kind: 'demo' })[0];
    const c = await app.inject({ method: 'POST', url: `/einvoice/${project.slug}/zatca/compliance`, headers: { ...V2, otp }, payload: { csr: b64(csrPem) } });
    expect(c.statusCode).toBe(200);

    const list = (await app.inject({ method: 'GET', url: `${A()}/csids?kind=compliance` })).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'compliance', status: 'active', instance: 'zatca', progress: { done: 0, needed: 6 } });
    expect(list[0].secretHash).toBeUndefined();
    expect(list[0].certPem).toBeUndefined();
    const one = (await app.inject({ method: 'GET', url: `${A()}/csids/${list[0].id}` })).json();
    expect(one.certPem).toContain('BEGIN CERTIFICATE');

    expect((await app.inject({ method: 'POST', url: `${A()}/csids/${list[0].id}/revoke` })).json()).toMatchObject({ status: 'revoked' });
    const demo = (await app.inject({ method: 'GET', url: `${A()}/csids?kind=demo` })).json()[0];
    const e = (await app.inject({ method: 'POST', url: `${A()}/csids/${demo.id}/expire` })).json();
    expect(e.status).toBe('expired');
    expect(Date.parse(e.expiresAt)).toBeLessThanOrEqual(Date.now());
    expect((await app.inject({ method: 'POST', url: `${A()}/csids/nope/revoke` })).statusCode).toBe(404);

    // an expired demo CSID gets replaced by the next sample
    const s = (await app.inject({ method: 'POST', url: `${A()}/sample` })).json();
    expect(s.auth.binarySecurityToken).not.toBe(demo.token);
    expect((await app.inject({ method: 'GET', url: `${A()}/csids?kind=demo&status=active` })).json()).toHaveLength(1);
  });

  it('overview and GET /api/einvoice-reference', async () => {
    const o = (await app.inject({ method: 'GET', url: A() })).json();
    expect(o.instances).toHaveLength(1);
    expect(o.instances[0].config.caKeyPem).toBeUndefined();
    expect(o).toHaveProperty('csids.active');

    const ref = (await app.inject({ method: 'GET', url: '/api/einvoice-reference' })).json();
    expect(ref.rules.length).toBeGreaterThan(10);
    expect(ref.faults.map((f: { fault: string }) => f.fault)).toContain('timeout');
    expect(ref.lint.map((c: { id: string }) => c.id)).toContain('einv.pih-mismatch');
    expect(ref.breaks.map((x: { name: string }) => x.name)).toContain('wrong-uuid');
    expect(ref.firstPih).toBe(FIRST_PIH);
    expect(ref.configDefaults.caKeyPem).toBeUndefined();
    expect(ref.snippets.find((s: { id: string }) => s.id === 'node').code).toContain('<stubyard>/einvoice/<project>/<instance>');
  });
});
