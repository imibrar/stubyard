import fs from 'node:fs';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routeAccess } from '../src/access/permissions.js';
import { loadConfig } from '../src/config.js';
import { ZATCA_ENV_TEMPLATE } from '../src/einvoice/service.js';
import { demoEgs, sample, type Egs } from '../src/einvoice/zatca/sample.js';
import { buildApp } from '../src/http/app.js';
import { createHub } from '../src/index.js';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const basic = (c: { token: string; secret: string }) => `Basic ${b64(`${c.token}:${c.secret}`)}`;
const V2 = { 'accept-version': 'V2', 'accept-language': 'en' };

/** S10: hub.einvoice wired into the real app (traffic log, run prefix, redaction, clock, reset, run purge, permissions). */
describe('e-invoicing wiring (buildApp)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let hub: ReturnType<typeof createHub>;
  let dataDir: string;
  let base = '';
  let egs: Egs;
  let pcsid: { token: string; secret: string };
  const Z = '/einvoice/ksa/zatca/e-invoicing/simulation';

  async function call<T = any>(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T; logId: string | null }> {
    const r = await fetch(base + p, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* text */
    }
    return { status: r.status, body: parsed as T, logId: r.headers.get('x-hub-request-id') };
  }

  /** The traffic row once onResponse has finished it. */
  async function logOf(id: string | null) {
    expect(id).toBeTruthy();
    for (let i = 0; i < 50; i++) {
      const l = hub.logs.get(id!);
      if (l && l.outcome && l.resolved && Object.keys(l.resolved).length) return l;
      await new Promise((r) => setTimeout(r, 20));
    }
    return hub.logs.get(id!)!;
  }

  const project = () => hub.projects.getBySlug('ksa')!;
  const report = (s: ReturnType<typeof sample>, prefix = '') =>
    call('POST', `${prefix}${Z}/invoices/reporting/single`, { invoiceHash: s.invoiceHash, uuid: s.uuid, invoice: b64(s.xml) }, { ...V2, 'clearance-status': '0', authorization: basic(pcsid) });

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-einv-wiring-'));
    const config = loadConfig({ host: '127.0.0.1', httpPort: 0, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0, admin: null });
    hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger: pino({ level: 'silent' }) });
    ({ app } = await buildApp(hub, pino({ level: 'silent' })));
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
    expect((await call('POST', '/api/projects', { name: 'Ksa' })).status).toBe(201);
  });

  afterAll(async () => {
    await app?.close();
    hub?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('creates an instance over REST; the overview and providerCounts see it', async () => {
    const r = await call('POST', '/api/projects/ksa/einvoice/instances', { slug: 'zatca', config: { env: 'simulation', requireComplianceChecks: false } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ slug: 'zatca', preset: 'zatca' });
    const inst = hub.einvoice.repo.instanceBySlug(project().id, 'zatca')!;
    egs = demoEgs({ keyPem: inst.config.caKeyPem!, certPem: inst.config.caCertPem! }, { template: ZATCA_ENV_TEMPLATE.simulation });
    const detail = await call('GET', '/api/projects/ksa/overview');
    expect(detail.body.providerCounts).toMatchObject({ einvoice: 1 });
  });

  it('onboards through the app URL: OTP + CSR → CCSID → PCSID; Authorization and secrets are redacted in the log', async () => {
    const c = await call('POST', `${Z}/compliance`, { csr: b64(egs.csrPem) }, { ...V2, otp: '123456' });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ dispositionMessage: 'ISSUED' });
    const cLog = await logOf(c.logId);
    expect(cLog.projectId).toBe(project().id);
    expect(cLog.resolved).toMatchObject({ kind: 'einvoice', instance: 'zatca', endpoint: 'compliance' });
    expect(cLog.resBody).toContain('"secret":"[redacted]"');
    expect(cLog.resBody).not.toContain(c.body.secret);

    const p = await call('POST', `${Z}/production/csids`, { compliance_request_id: String(c.body.requestID) }, { ...V2, authorization: basic({ token: c.body.binarySecurityToken, secret: c.body.secret }) });
    expect(p.status).toBe(200);
    pcsid = { token: p.body.binarySecurityToken, secret: p.body.secret };
    // Invoices are signed with the PCSID's certificate (ZATCA checks it against the CSID of the request).
    const row = hub.einvoice.repo.csidByToken(hub.einvoice.repo.instanceBySlug(project().id, 'zatca')!.id, pcsid.token)!;
    egs = { ...egs, certPem: row.certPem };
    const pLog = await logOf(p.logId);
    const auth = String(pLog.reqHeaders?.authorization);
    expect(auth).toMatch(/^Basic /);
    expect(auth).not.toContain(b64(`${c.body.binarySecurityToken}:${c.body.secret}`));
    expect(pLog.resBody).not.toContain(pcsid.secret);
  });

  it('/run/<key>/einvoice/… attributes the invoice and the traffic row to the run; the report counts it', async () => {
    expect((await call('POST', '/api/projects/ksa/runs', { key: 'r1' })).status).toBe(201);
    const s = sample({ type: 'simplified', kind: '388', icv: 1, number: 'INV-R1', egs });
    const r = await report(s, '/run/r1');
    expect([200, 202]).toContain(r.status);
    const log = await logOf(r.logId);
    const run = hub.runs.repo.get(log.runId!)!;
    expect(run.key).toBe('r1');
    expect(log.resolved).toMatchObject({ kind: 'einvoice', endpoint: 'reporting', run: 'r1', number: 'INV-R1' });
    expect(String(log.reqHeaders?.authorization)).not.toContain(b64(`${pcsid.token}:${pcsid.secret}`));
    const inv = hub.einvoice.repo.getInvoice(log.resolved.invoiceId as string)!;
    expect(inv.runId).toBe(run.id);

    const rep = await call('GET', '/api/projects/ksa/runs/r1/report');
    expect(rep.body.einvoice).toMatchObject({ invoices: 1 });

    // Unknown run key → 404 "Unknown run" from the run hook.
    const u = await report(s, '/run/nope');
    expect(u.status).toBe(404);
    expect(u.body).toMatchObject({ error: 'Unknown run' });
  });

  it('run stop with purge removes the run invoices', async () => {
    const run = hub.runs.repo.list(project().id).find((r) => r.key === 'r1')!;
    expect(hub.einvoice.repo.listInvoices(project().id, { runId: run.id })).toHaveLength(1);
    const s = await call('POST', '/api/projects/ksa/runs/r1/stop', { purge: true });
    expect(s.status).toBe(200);
    expect(s.body.report.einvoice).toMatchObject({ invoices: 1 });
    expect(hub.einvoice.repo.listInvoices(project().id, { runId: run.id })).toHaveLength(0);
  });

  it('the einvoice time offset expires dashboard OTPs and moves "today" for BR-KSA-04', async () => {
    const o = await call('POST', '/api/projects/ksa/einvoice/instances/zatca/otp');
    expect(o.status).toBe(201);
    const t = await call('GET', '/api/projects/ksa/time');
    expect(t.body.features).toContain('einvoice');
    expect((await call('PUT', '/api/projects/ksa/time', { feature: 'einvoice', offset: '+2h' })).status).toBe(200);
    const c = await call('POST', `${Z}/compliance`, { csr: b64(egs.csrPem) }, { ...V2, otp: o.body.otp });
    expect(c.status).toBe(400);
    expect(c.body).toMatchObject({ code: 'Expired-OTP' });

    // Dry run: an invoice issued today is "in the future" three days back.
    const s = sample({ type: 'simplified', kind: '388', icv: 9, number: 'INV-D', egs });
    const now = await call('POST', '/api/projects/ksa/einvoice/validate', { xml: s.xml, invoiceHash: s.invoiceHash, uuid: s.uuid });
    expect(now.status).toBe(200);
    expect(JSON.stringify(now.body.findings)).not.toContain('BR-KSA-04');
    expect((await call('PUT', '/api/projects/ksa/time', { feature: 'einvoice', offset: '-3d' })).status).toBe(200);
    const back = await call('POST', '/api/projects/ksa/einvoice/validate', { xml: s.xml, invoiceHash: s.invoiceHash, uuid: s.uuid });
    expect(JSON.stringify(back.body.findings)).toContain('BR-KSA-04');
    expect((await call('DELETE', '/api/projects/ksa/time')).status).toBe(200);
  });

  it('project reset clears the invoices', async () => {
    const s = sample({ type: 'simplified', kind: '388', icv: 1, number: 'INV-P1', egs });
    expect([200, 202]).toContain((await report(s)).status);
    expect(hub.einvoice.repo.listInvoices(project().id, {}).length).toBeGreaterThan(0);
    expect((await call('POST', '/api/projects/ksa/reset')).status).toBe(200);
    expect(hub.einvoice.repo.listInvoices(project().id, {})).toHaveLength(0);
  });

  it('404s for unknown projects carry the e-invoicing hint; the routes are mapped for access', async () => {
    const r = await call('GET', '/einvoice/ksa');
    expect(r.status).toBe(404);
    expect(r.body.hint).toContain('E-invoicing URLs look like');
    const log = await logOf(r.logId);
    expect(log.projectId).toBe(project().id);

    const B = '/api/projects/:slug/einvoice';
    expect(routeAccess('GET', B)).toMatchObject({ permission: 'project.view' });
    expect(routeAccess('POST', `${B}/instances`)).toMatchObject({ permission: 'project.providers' });
    expect(routeAccess('DELETE', `${B}/invoices`)).toMatchObject({ permission: 'walkthroughs.run' });
    expect(routeAccess('POST', `${B}/chains/:id/reset`)).toMatchObject({ permission: 'walkthroughs.run' });
    expect(routeAccess('POST', `${B}/validate`)).toMatchObject({ permission: 'project.view' });
    expect(routeAccess('POST', `${B}/sample`)).toMatchObject({ permission: 'walkthroughs.run' });
    expect(routeAccess('POST', `${B}/reset`)).toMatchObject({ permission: 'walkthroughs.run' });
    expect(routeAccess('GET', `${B}/instances/:id/connect`)).toMatchObject({ permission: 'project.providers' });
    expect(routeAccess('GET', '/api/einvoice-reference')).toMatchObject({ permission: 'authenticated', scope: 'none' });
    expect(routeAccess('POST', '/einvoice/:project/:instance/*')).toBe('open');
  });
});
