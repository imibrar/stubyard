import fs from 'node:fs';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostHttpBase, loadConfig } from '../src/config.js';
import { EINVOICE_LINT_CHECKS } from '../src/einvoice/lint.js';
import { ZATCA_ENV_TEMPLATE } from '../src/einvoice/service.js';
import { FIRST_PIH } from '../src/einvoice/zatca/hash.js';
import { ZATCA_RULES } from '../src/einvoice/zatca/rules/catalog.js';
import { BREAK_NAMES, BREAKS, demoEgs, sample, type BreakName, type Egs, type Sample, type SampleOptions } from '../src/einvoice/zatca/sample.js';
import { buildApp } from '../src/http/app.js';
import { createHub } from '../src/index.js';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
type Cred = { token: string; secret: string };
const basic = (c: Cred) => `Basic ${b64(`${c.token}:${c.secret}`)}`;
const cred = (b: { binarySecurityToken: string; secret: string }): Cred => ({ token: b.binarySecurityToken, secret: b.secret });
const V2 = { 'accept-version': 'V2', 'accept-language': 'en' };
const API = '/api/projects/ksa/einvoice';
const HOUR = 3_600_000;

type Endpoint = 'reporting' | 'clearance' | 'compliance';
const PATHS: Record<Endpoint, string> = { reporting: 'invoices/reporting/single', clearance: 'invoices/clearance/single', compliance: 'compliance/invoices' };
type Msg = { code: string; message: string };
type VR = { status: string; errorMessages: Msg[]; warningMessages: Msg[]; infoMessages: Msg[] };

/** The HTTP status a break alone gives: einv.* codes are lint only (200), ZATCA codes by their catalog severity. */
const statusOf = (code: string): number => {
  if (code.startsWith('einv.')) return 200;
  const r = ZATCA_RULES.find((x) => x.code === code);
  if (!r) throw new Error(`no catalog rule ${code}`);
  return r.severity === 'warning' ? 202 : 400;
};

/** S18: phase 2 (checks: 'full') end to end over the fake API; phase 1 cases are in einvoice-p1.e2e.test.ts. */
describe('e-invoicing phase 2 (fake ZATCA Fatoora, full checks)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let hub: ReturnType<typeof createHub>;
  let dataDir: string;
  let base = '';

  async function call<T = any>(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
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
    return { status: r.status, body: parsed as T };
  }

  const project = () => hub.projects.getBySlug('ksa')!;
  const instanceId = (slug: string) => hub.einvoice.repo.instanceBySlug(project().id, slug)!.id;
  const certOf = (slug: string, token: string) => hub.einvoice.repo.csidByToken(instanceId(slug), token)!.certPem;
  const zp = (inst: string) => `/einvoice/ksa/${inst}/e-invoicing/simulation`;

  const send = (inst: string, ep: Endpoint, s: Pick<Sample, 'xml' | 'invoiceHash' | 'uuid'>, auth: Cred) =>
    call(
      'POST',
      `${zp(inst)}/${PATHS[ep]}`,
      { invoiceHash: s.invoiceHash, uuid: s.uuid, invoice: b64(s.xml) },
      { ...V2, 'clearance-status': ep === 'clearance' ? '1' : '0', authorization: basic(auth) },
    );

  async function next(inst: string, scope: 'production' | 'compliance' = 'production'): Promise<{ icv: number; pih: string }> {
    const r = await call('GET', `${API}/chains?instance=${inst}&scope=${scope}`);
    expect(r.status).toBe(200);
    return r.body[0]?.next ?? { icv: 1, pih: FIRST_PIH };
  }

  async function latest(inst: string) {
    return (await call('GET', `${API}/invoices?instance=${inst}&limit=1`)).body[0];
  }
  const allCodes = (vr: VR) => [...vr.errorMessages, ...vr.warningMessages].map((m) => m.code);
  const count = <T>(xs: T[], x: T) => xs.filter((y) => y === x).length;

  /** An instance (no compliance checks needed) onboarded to a PCSID: its EGS signs with the PCSID certificate. */
  interface Onboarded {
    slug: string;
    egs: Egs;
    ccsid: Cred;
    ccsidEgs: Egs;
    pcsid: Cred;
  }
  async function instance(slug: string, config: Record<string, unknown> = {}): Promise<Onboarded> {
    expect((await call('POST', `${API}/instances`, { slug, config: { env: 'simulation', requireComplianceChecks: false, checks: 'full', ...config } })).status).toBe(201);
    const e = demoEgs(undefined, { template: ZATCA_ENV_TEMPLATE.simulation });
    const c = await call('POST', `${zp(slug)}/compliance`, { csr: b64(e.csrPem) }, { ...V2, otp: '123456' });
    expect(c.status).toBe(200);
    const p = await call('POST', `${zp(slug)}/production/csids`, { compliance_request_id: String(c.body.requestID) }, { ...V2, authorization: basic(cred(c.body)) });
    expect(p.status).toBe(200);
    const ccsid = cred(c.body);
    const pcsid = cred(p.body);
    return { slug, ccsid, pcsid, egs: { ...e, certPem: certOf(slug, pcsid.token) }, ccsidEgs: { ...e, certPem: certOf(slug, ccsid.token) } };
  }

  /** A sample at the head of the instance's production chain. */
  async function mk(o: Onboarded, type: SampleOptions['type'], number: string, extra: Partial<SampleOptions> = {}) {
    const n = await next(o.slug);
    return sample({ type, kind: '388', icv: n.icv, pih: n.pih, number, egs: o.egs, ...extra });
  }

  let full: Onboarded;
  let basicInst: Onboarded;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-einv-p2-'));
    const config = loadConfig({ host: '127.0.0.1', httpPort: 0, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0, admin: null });
    hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger: pino({ level: 'silent' }) });
    ({ app } = await buildApp(hub, pino({ level: 'silent' })));
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
    expect((await call('POST', '/api/projects', { name: 'Ksa' })).status).toBe(201);
    full = await instance('full');
    basicInst = await instance('basic', { checks: 'basic' });
  });

  afterAll(async () => {
    await app?.close();
    hub?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('valid samples pass with no findings on reporting, clearance and compliance', async () => {
    const r = await send('full', 'reporting', await mk(full, 'simplified', 'P2-OK-1'), full.pcsid);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ reportingStatus: 'REPORTED', validationResults: { status: 'PASS', errorMessages: [], warningMessages: [] } });
    expect((await latest('full')).lint.filter((l: any) => l.severity !== 'info')).toEqual([]);

    const c = await send('full', 'clearance', await mk(full, 'standard', 'P2-OK-2'), full.pcsid);
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body).toMatchObject({ clearanceStatus: 'CLEARED', validationResults: { status: 'PASS', errorMessages: [], warningMessages: [] } });
    expect((await latest('full')).lint.filter((l: any) => l.severity !== 'info')).toEqual([]);

    for (const type of ['standard', 'simplified'] as const) {
      const n = await next('full', 'compliance');
      const s = sample({ type, kind: '388', icv: n.icv, pih: n.pih, number: `P2-CMP-${type}`, egs: full.ccsidEgs });
      const k = await send('full', 'compliance', s, full.ccsid);
      expect(k.status, JSON.stringify(k.body)).toBe(200);
      expect(k.body.validationResults).toMatchObject({ status: 'PASS', errorMessages: [], warningMessages: [] });
    }
  });

  it('every sample break gives its code once, at the right HTTP status, in validationResults (ZATCA codes) and in lint', async () => {
    for (const name of BREAK_NAMES) {
      const code = BREAKS[name].code;
      const o = await instance(`brk-${name}`);
      // Chain breaks need a head to break against.
      if (name === 'pih-wrong' || name === 'icv-gap') expect((await send(o.slug, 'reporting', await mk(o, 'simplified', 'HEAD-1'), o.pcsid)).status).toBe(200);
      const s = await mk(o, 'simplified', `BRK-${name}`, { break: [name] });
      expect(s.expect).toEqual([code]);
      const r = await send(o.slug, 'reporting', s, o.pcsid);
      const vr = r.body.validationResults as VR;
      const why = `${name}: ${JSON.stringify(vr)}`;
      expect(r.status, why).toBe(statusOf(code));
      expect(r.body.reportingStatus, why).toBe(r.status === 400 ? 'NOT_REPORTED' : 'REPORTED');
      if (code.startsWith('einv.')) expect(allCodes(vr), why).not.toContain(code);
      else expect(count(allCodes(vr), code), why).toBe(1);
      const inv = await latest(o.slug);
      const checks = (inv.lint as { check: string }[]).map((l) => l.check);
      expect(count(checks, code), `${name}: ${JSON.stringify(inv.lint)}`).toBe(1);
      // Nothing else is reported (tampering also breaks QR tag 6; the minified hash is named by einv.hash-variant).
      const zatca = code.startsWith('einv.') ? [] : name === 'tamper-after-sign' ? [code, 'QRCODE_INVALID'] : [code];
      expect(allCodes(vr), why).toEqual(zatca);
      const extraLint = name === 'minified-hash' ? ['einv.hash-variant'] : [];
      expect(checks.filter((c) => c !== 'einv.signature-method').sort(), name).toEqual([...new Set([...zatca, code, ...extraLint])].sort());
    }
  });

  it('the pih-mismatch message names both invoices, their ICVs and the expected and received PIH', async () => {
    const o = await instance('pihmsg');
    const head = await mk(o, 'simplified', 'INV-41');
    expect((await send(o.slug, 'reporting', head, o.pcsid)).status).toBe(200);
    const s = await mk(o, 'simplified', 'INV-42', { break: ['pih-wrong'] });
    await send(o.slug, 'reporting', s, o.pcsid);
    const f = (await latest(o.slug)).lint.find((l: any) => l.check === 'einv.pih-mismatch');
    expect(f.message).toContain('PIH of invoice INV-42 (ICV 2) is not the hash of invoice INV-41 (ICV 1)');
    expect(f.message).toContain(`expected ${head.invoiceHash}`);
  });

  it('a warning-only invoice is reported with 202 WARNING; clearance of an invoice with errors is NOT_CLEARED', async () => {
    // BR-KSA-F-06: an item name longer than 1000 characters is a warning.
    const s = await mk(full, 'simplified', 'P2-WARN', { lines: [{ name: 'x'.repeat(1001), quantity: 1, price: '10.00' }] });
    const r = await send('full', 'reporting', s, full.pcsid);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body).toMatchObject({ reportingStatus: 'REPORTED', validationResults: { status: 'WARNING', errorMessages: [] } });
    expect(r.body.validationResults.warningMessages.map((m: Msg) => m.code)).toEqual(['BR-KSA-F-06']);
    expect((await latest('full')).lint.find((l: any) => l.check === 'BR-KSA-F-06')).toMatchObject({ severity: 'warn' });

    const bad = await mk(full, 'standard', 'P2-NC', { break: ['building-3-digits'] });
    const c = await send('full', 'clearance', bad, full.pcsid);
    expect(c.status).toBe(400);
    expect(c.body).toMatchObject({ clearanceStatus: 'NOT_CLEARED', clearedInvoice: null, validationResults: { status: 'ERROR' } });
    expect(allCodes(c.body.validationResults)).toContain('BR-KSA-37');
    expect(await latest('full')).toMatchObject({ status: 'NOT_CLEARED', httpStatus: 400 });

    // Compliance invoices run the same rules: the broken invoice fails and does not count as a passed check.
    const n = await next('full', 'compliance');
    const k = await send('full', 'compliance', sample({ type: 'simplified', kind: '388', icv: n.icv, pih: n.pih, number: 'P2-CMP-BAD', egs: full.ccsidEgs, break: ['postal-4-digits'] }), full.ccsid);
    expect(k.status).toBe(400);
    expect(allCodes(k.body.validationResults)).toContain('BR-KSA-66');
  });

  it("basic checks pass what full checks catch (same broken invoice on a 'basic' and a 'full' instance)", async () => {
    for (const name of ['total-mismatch', 'vat-14-digits', 'tamper-after-sign', 'qr-total'] as BreakName[]) {
      const sb = await mk(basicInst, 'simplified', `B-${name}`, { break: [name] });
      const rb = await send('basic', 'reporting', sb, basicInst.pcsid);
      expect(rb.status, `basic ${name}: ${JSON.stringify(rb.body)}`).toBe(200);
      expect(allCodes(rb.body.validationResults)).toEqual([]);

      const sf = await mk(full, 'simplified', `F-${name}`, { break: [name] });
      const rf = await send('full', 'reporting', sf, full.pcsid);
      expect(rf.status, `full ${name}`).toBe(400);
      expect(allCodes(rf.body.validationResults)).toContain(BREAKS[name].code);
    }
    // Phase 1 checks apply in both modes.
    const sb = await mk(basicInst, 'simplified', 'B-uuid', { break: ['wrong-uuid'] });
    expect((await send('basic', 'reporting', sb, basicInst.pcsid)).status).toBe(400);
  });

  it('signature and QR tampering after signing are caught by the crypto checks', async () => {
    const cases: [string, (xml: string) => string, string][] = [
      // A different (still base64) SignatureValue: the signature no longer verifies.
      ['signature value', (x) => x.replace(/(<ds:SignatureValue>)(.)/, (_m, a: string, c: string) => a + (c === 'A' ? 'B' : 'A')), 'invalid-signature'],
      // SigningTime edited: the SignedProperties digest no longer matches.
      ['signing time', (x) => x.replace(/(<xades:SigningTime>\d{4})/, (_m, a: string) => `${a.slice(0, -1)}${a.endsWith('9') ? '8' : '9'}`), 'signed-properties-hashing'],
      // A QR that is not the invoice's.
      ['qr payload', (x) => x.replace(/(<cbc:ID>QR<\/cbc:ID>\s*<cac:Attachment>\s*<cbc:EmbeddedDocumentBinaryObject[^>]*>)[^<]+/, `$1${b64('not a tlv qr')}`), 'QRCODE_INVALID'],
    ];
    for (const [what, tamper, code] of cases) {
      const s = await mk(full, 'simplified', `T-${code}`);
      const xml = tamper(s.xml);
      expect(xml, what).not.toBe(s.xml);
      // The signature parts and the QR are outside the invoice hash: the sent hash stays valid.
      const r = await send('full', 'reporting', { ...s, xml }, full.pcsid);
      const codes = allCodes(r.body.validationResults);
      expect(r.status, `${what}: ${JSON.stringify(r.body.validationResults)}`).toBe(400);
      expect(count(codes, code), `${what}: ${codes}`).toBe(1);
      expect(codes, what).not.toContain('invalid-invoice-hash');
    }
  });

  it('BR-KSA-04 compares the issue date with the einvoice clock (time offset)', async () => {
    const o = await instance('clock04');
    const s = await mk(o, 'simplified', 'FUTURE-1', { issueAt: new Date(Date.now() + 2 * 24 * HOUR) });
    const r = await send(o.slug, 'reporting', s, o.pcsid);
    expect(r.status).toBe(400);
    expect(allCodes(r.body.validationResults)).toContain('BR-KSA-04');
    // Three days ahead on the einvoice clock, the date is in the past: the resend (a retry of the head) passes.
    expect((await call('PUT', '/api/projects/ksa/time', { feature: 'einvoice', offset: '+3d' })).status).toBe(200);
    try {
      const again = await send(o.slug, 'reporting', s, o.pcsid);
      expect(again.status, JSON.stringify(again.body.validationResults)).toBe(200);
    } finally {
      expect((await call('DELETE', '/api/projects/ksa/time')).status).toBe(200);
    }
  });

  it('the 24 h duplicate window follows the einvoice clock', async () => {
    const o = await instance('dupclock');
    const s = await mk(o, 'simplified', 'DUP-1');
    expect((await send(o.slug, 'reporting', s, o.pcsid)).status).toBe(200);
    try {
      expect((await call('PUT', '/api/projects/ksa/time', { feature: 'einvoice', offset: '+23h' })).status).toBe(200);
      expect((await send(o.slug, 'reporting', s, o.pcsid)).status).toBe(409);
      // 25 h later on the einvoice clock the first report is out of the window: no duplicate.
      expect((await call('PUT', '/api/projects/ksa/time', { feature: 'einvoice', offset: '+25h' })).status).toBe(200);
      const late = await send(o.slug, 'reporting', s, o.pcsid);
      expect(late.status, JSON.stringify(late.body)).toBe(200);
      expect((await latest(o.slug)).status).toBe('REPORTED');
    } finally {
      expect((await call('DELETE', '/api/projects/ksa/time')).status).toBe(200);
    }
  });

  it('GET /einvoice/lint aggregates the findings, the einv.* lints included', async () => {
    const r = await call('GET', `${API}/lint`);
    expect(r.status).toBe(200);
    expect(r.body.level).toBe('error');
    const known = new Set<string>(EINVOICE_LINT_CHECKS.map((c) => c.id));
    for (const id of ['einv.pih-mismatch', 'einv.icv-gap', 'einv.first-pih-variant', 'einv.hash-variant']) {
      expect(known.has(id)).toBe(true);
      expect(r.body.byCheck[id], id).toBeGreaterThanOrEqual(1);
    }
    for (const code of ['BR-CO-15', 'BR-KSA-37', 'BR-KSA-F-06', 'invalid-signature']) expect(r.body.byCheck[code], code).toBeGreaterThanOrEqual(1);
    const f = r.body.findings.find((x: any) => x.check === 'einv.icv-gap');
    expect(f).toMatchObject({ severity: 'warn', instance: 'brk-icv-gap', number: 'BRK-icv-gap' });
    expect(r.body.counts.warn).toBeGreaterThanOrEqual(1);
  });

  it('POST /sample over app.inject (as the MCP tools call it) gives the host base URLs, like the instance view', async () => {
    const res = await app.inject({ method: 'POST', url: `${API}/sample`, payload: { instance: 'full', type: 'simplified' } });
    expect(res.statusCode).toBe(200);
    const s = res.json();
    const hostBase = hostHttpBase(hub.config);
    expect(s.endpoint).toBe(`${hostBase}/einvoice/ksa/full/e-invoicing/simulation/invoices/reporting/single`);
    const view = (await app.inject({ method: 'GET', url: `${API}/instances` })).json();
    expect(view.find((i: any) => i.slug === 'full').urls.reporting).toBe(s.endpoint);
    // Over a real socket the request's own host is kept.
    const real = await call('POST', `${API}/sample`, { instance: 'full', type: 'standard' });
    expect(real.body.endpoint).toBe(`${base}/einvoice/ksa/full/e-invoicing/simulation/invoices/clearance/single`);
  });
});
