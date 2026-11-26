import fs from 'node:fs';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fastify, { type FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { EinvoiceService } from '../src/einvoice/service.js';
import type { EinvoiceInstance } from '../src/einvoice/types.js';
import { registerZatcaApi } from '../src/einvoice/zatca/api.js';
import { demoEgs, sample, type Egs } from '../src/einvoice/zatca/sample.js';
import type { Hub } from '../src/hub.js';
import { createHub } from '../src/index.js';
import type { Project } from '../src/repos/projects.js';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const basic = (c: { token: string; secret: string }) => `Basic ${b64(`${c.token}:${c.secret}`)}`;
const V2 = { 'accept-version': 'V2', 'accept-language': 'en' };

let hub: Hub;
let app: FastifyInstance;
let svc: EinvoiceService;
let project: Project;
let inst: EinvoiceInstance;
let egs: Egs;
let dataDir: string;
let base = '';
let pcsid: { token: string; secret: string };
const P = () => `/einvoice/${project.slug}/zatca`;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-einv-api-'));
  const config = loadConfig({ host: '127.0.0.1', httpPort: 0, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0, timeoutHoldMs: 200 });
  hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger: pino({ level: 'silent' }) });
  svc = new EinvoiceService({ db: hub.db, timeoutHoldMs: 200 });
  project = hub.projects.create({ name: 'Einv Api' });
  inst = svc.createInstance(project, { slug: 'zatca', config: { checks: 'basic', requireComplianceChecks: false } });
  egs = demoEgs({ keyPem: inst.config.caKeyPem!, certPem: inst.config.caCertPem! });

  app = fastify();
  // The traffic hooks of http/app.ts, reduced to what the plugin relies on.
  app.addHook('onRequest', async (req, reply) => {
    req.trafficLogId = hub.traffic.start({ direction: 'inbound', protocol: 'http', method: req.method, url: req.url, reqHeaders: { ...req.headers } });
    reply.header('x-hub-request-id', req.trafficLogId);
  });
  app.addHook('onResponse', async (req, reply) => {
    const id = req.trafficLogId!;
    hub.traffic.finish(id, { outcome: req.trafficOutcome ?? 'ok', resStatus: reply.statusCode });
    if (req.trafficResolved) hub.traffic.mergeResolved(id, req.trafficResolved);
  });
  await registerZatcaApi(app, hub, svc);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
});

afterAll(async () => {
  await app?.close();
  hub?.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const logOf = (r: { headers: Record<string, unknown> }) => hub.logs.get(String(r.headers['x-hub-request-id']))!;

describe('fake ZATCA endpoints (/einvoice/<project>/<instance>/…)', () => {
  it('/compliance: OTP + CSR → 200 CCSID, then /production/csids → PCSID', async () => {
    const r = await app.inject({ method: 'POST', url: `${P()}/compliance`, headers: { ...V2, otp: '123456' }, payload: { csr: b64(egs.csrPem) } });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b).toMatchObject({ dispositionMessage: 'ISSUED', errors: null });
    expect(String(b.requestID)).toMatch(/^\d{13}$/);
    const row = svc.repo.csidByToken(inst.id, b.binarySecurityToken)!;
    expect(row).toMatchObject({ kind: 'compliance', egsSerial: egs.egsSerial });

    const p = await app.inject({ method: 'POST', url: `${P()}/production/csids`, headers: { ...V2, authorization: basic({ token: b.binarySecurityToken, secret: b.secret }) }, payload: { compliance_request_id: String(b.requestID) } });
    expect(p.statusCode).toBe(200);
    pcsid = { token: p.json().binarySecurityToken, secret: p.json().secret };
    expect(svc.repo.csidByToken(inst.id, pcsid.token)).toMatchObject({ kind: 'production', status: 'active' });
  });

  it('reporting a signed sample (real /e-invoicing/<env> prefix) → 200 REPORTED, traffic log resolved', async () => {
    const s = sample({ type: 'simplified', kind: '388', icv: 1, number: 'INV-1', egs });
    const r = await app.inject({
      method: 'POST',
      url: `${P()}/e-invoicing/simulation/invoices/reporting/single`,
      headers: { ...V2, 'clearance-status': '0', authorization: basic(pcsid) },
      payload: { invoiceHash: s.invoiceHash, uuid: s.uuid, invoice: b64(s.xml) },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ reportingStatus: 'REPORTED', validationResults: { status: 'PASS' } });

    const full = logOf(r);
    expect(full.projectId).toBe(project.id);
    expect(full.resolved).toMatchObject({ kind: 'einvoice', preset: 'zatca', project: project.slug, instance: 'zatca', env: 'simulation', endpoint: 'reporting', status: 200, invoiceStatus: 'REPORTED', number: 'INV-1' });
    const inv = svc.repo.getInvoice(full.resolved.invoiceId as string)!;
    expect(inv).toMatchObject({ status: 'REPORTED', logId: full.id, endpoint: 'reporting' });
  });

  it('X-Hub-Scenario: timeout holds the request, then closes the connection', async () => {
    const s = sample({ type: 'simplified', kind: '388', icv: 2, number: 'INV-T', egs });
    const t0 = Date.now();
    const res = await fetch(`${base}${P()}/invoices/reporting/single`, {
      method: 'POST',
      headers: { ...V2, 'content-type': 'application/json', authorization: basic(pcsid), 'x-hub-scenario': 'timeout' },
      body: JSON.stringify({ invoiceHash: s.invoiceHash, uuid: s.uuid, invoice: b64(s.xml) }),
    }).catch((e) => e);
    expect(res).toBeInstanceOf(Error);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
    const [row] = svc.repo.listInvoices(project.id, { number: 'INV-T' });
    expect(row).toMatchObject({ status: 'FAULT', fault: 'timeout', number: 'INV-T' });
  });

  it('X-Hub-Scenario: slow:<ms> answers after the delay', async () => {
    const t0 = Date.now();
    const r = await app.inject({ method: 'POST', url: `${P()}/compliance`, headers: { ...V2, otp: '123456', 'x-hub-scenario': 'slow:150' }, payload: { csr: b64(egs.csrPem) } });
    expect(r.statusCode).toBe(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
  });

  it('unknown routes, projects and instances → 404 (unmatched in the log)', async () => {
    const r = await app.inject({ method: 'GET', url: `${P()}/nope` });
    expect(r.statusCode).toBe(404);
    expect(r.json().routes).toContain('POST /compliance');
    const log = logOf(r);
    expect(log.outcome).toBe('unmatched');
    expect(log.resolved).toMatchObject({ kind: 'einvoice', instance: 'zatca', endpoint: null, status: 404 });

    expect((await app.inject({ method: 'POST', url: '/einvoice/no-such-project/zatca/compliance' })).statusCode).toBe(404);
    const i = await app.inject({ method: 'POST', url: `/einvoice/${project.slug}/other/compliance` });
    expect(i.statusCode).toBe(404);
    expect(logOf(i).resolved).toMatchObject({ unknownInstance: 'other' });
  });

  it('a disabled instance answers 503', async () => {
    svc.updateInstance(project, 'zatca', { enabled: false });
    const r = await app.inject({ method: 'POST', url: `${P()}/compliance`, headers: V2 });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ category: 'HTTP-Errors', code: '503' });
    svc.updateInstance(project, 'zatca', { enabled: true });
  });
});
