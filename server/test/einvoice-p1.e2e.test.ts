import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ZATCA_ENV_TEMPLATE } from '../src/einvoice/service.js';
import { buildCsr } from '../src/einvoice/zatca/csr.js';
import { FIRST_PIH, invoiceHash } from '../src/einvoice/zatca/hash.js';
import { ecdsaVerify } from '../src/einvoice/zatca/pki.js';
import { asBase64, decodeTlv } from '../src/einvoice/zatca/qr.js';
import { demoEgs, sample, type Egs, type Sample, type SampleOptions } from '../src/einvoice/zatca/sample.js';
import { buildApp } from '../src/http/app.js';
import { createHub } from '../src/index.js';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
type Cred = { token: string; secret: string };
const basic = (c: Cred) => `Basic ${b64(`${c.token}:${c.secret}`)}`;
const cred = (b: { binarySecurityToken: string; secret: string }): Cred => ({ token: b.binarySecurityToken, secret: b.secret });
const V2 = { 'accept-version': 'V2', 'accept-language': 'en' };
const API = '/api/projects/ksa/einvoice';
const HOLD_MS = 150;

type Endpoint = 'reporting' | 'clearance' | 'compliance';
const PATHS: Record<Endpoint, string> = { reporting: 'invoices/reporting/single', clearance: 'invoices/clearance/single', compliance: 'compliance/invoices' };

/** S11: phase 1 end to end over the real app (onboarding, reporting, clearance, auth, headers, chain, faults, REST). */
describe('e-invoicing phase 1 (fake ZATCA Fatoora)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let hub: ReturnType<typeof createHub>;
  let dataDir: string;
  let base = '';

  /** The main instance (simulation, compliance checks required) after onboarding. */
  let egs: Egs;
  let ccsid: Cred;
  let pcsid: Cred;
  /** The `chainerr` instance (chainCheck error). */
  let chainEgs: Egs;
  let chainPcsid: Cred;

  async function call<T = any>(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T; headers: Headers }> {
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
    return { status: r.status, body: parsed as T, headers: r.headers };
  }

  const project = () => hub.projects.getBySlug('ksa')!;
  const instanceId = (slug: string) => hub.einvoice.repo.instanceBySlug(project().id, slug)!.id;
  const certOf = (slug: string, token: string) => hub.einvoice.repo.csidByToken(instanceId(slug), token)!.certPem;
  const csidRow = (slug: string, token: string) => hub.einvoice.repo.csidByToken(instanceId(slug), token)!;

  const zp = (inst: string, env = 'simulation') => `/einvoice/ksa/${inst}/e-invoicing/${env}`;

  /** POST an invoice to one of the three invoice endpoints. Empty header values send the header empty (= missing). */
  const send = (inst: string, ep: Endpoint, s: Pick<Sample, 'xml' | 'invoiceHash' | 'uuid'>, auth: Cred | null, h: Record<string, string> = {}, prefix = '') =>
    call(
      'POST',
      `${prefix}${zp(inst)}/${PATHS[ep]}`,
      { invoiceHash: s.invoiceHash, uuid: s.uuid, invoice: b64(s.xml) },
      { ...V2, 'clearance-status': ep === 'clearance' ? '1' : '0', ...(auth ? { authorization: basic(auth) } : {}), ...h },
    );

  /** The next ICV / PIH of the instance's (only) chain in a scope. */
  async function next(inst: string, scope: 'production' | 'compliance' = 'production'): Promise<{ icv: number; pih: string }> {
    const r = await call('GET', `${API}/chains?instance=${inst}&scope=${scope}`);
    expect(r.status).toBe(200);
    return r.body[0]?.next ?? { icv: 1, pih: FIRST_PIH };
  }
  async function chainOf(inst: string, scope: 'production' | 'compliance' = 'production') {
    return (await call('GET', `${API}/chains?instance=${inst}&scope=${scope}`)).body[0];
  }

  /** A sample at the head of the chain. */
  async function mk(inst: string, e: Egs, type: SampleOptions['type'], number: string, extra: Partial<SampleOptions> = {}, scope: 'production' | 'compliance' = 'production') {
    const n = await next(inst, scope);
    return sample({ type, kind: '388', icv: n.icv, pih: n.pih, number, egs: e, ...extra });
  }

  /** The newest stored invoice of an instance. */
  async function latest(inst: string) {
    const r = await call('GET', `${API}/invoices?instance=${inst}&limit=1`);
    return r.body[0];
  }
  const lintChecks = (inv: { lint: { check: string }[] }) => inv.lint.map((l) => l.check);
  const codes = (vr: { errorMessages: { code: string }[]; warningMessages: { code: string }[] }) => [...vr.errorMessages, ...vr.warningMessages].map((m) => m.code);

  /** Onboarding without compliance checks (instances with requireComplianceChecks=false). */
  async function onboard(inst: string, env = 'simulation') {
    const e = demoEgs(undefined, { template: ZATCA_ENV_TEMPLATE[env as keyof typeof ZATCA_ENV_TEMPLATE] });
    const c = await call('POST', `${zp(inst, env)}/compliance`, { csr: b64(e.csrPem) }, { ...V2, otp: '123456' });
    expect(c.status).toBe(200);
    const p = await call('POST', `${zp(inst, env)}/production/csids`, { compliance_request_id: String(c.body.requestID) }, { ...V2, authorization: basic(cred(c.body)) });
    expect(p.status).toBe(200);
    const pc = cred(p.body);
    return { ccsid: cred(c.body), pcsid: pc, egs: { ...e, certPem: certOf(inst, pc.token) } };
  }

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-einv-p1-'));
    const config = loadConfig({ host: '127.0.0.1', httpPort: 0, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0, admin: null, timeoutHoldMs: HOLD_MS });
    hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger: pino({ level: 'silent' }) });
    ({ app } = await buildApp(hub, pino({ level: 'silent' })));
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
    expect((await call('POST', '/api/projects', { name: 'Ksa' })).status).toBe(201);
    for (const [slug, config] of [
      ['zatca', { env: 'simulation' }],
      ['strict', { env: 'core', strictCsr: true, otp: '654321' }],
      ['chainerr', { env: 'simulation', requireComplianceChecks: false, chainCheck: 'error' }],
      ['lax', { env: 'simulation', requireComplianceChecks: false, strictAuth: false }],
    ] as const) {
      expect((await call('POST', `${API}/instances`, { slug, config })).status).toBe(201);
    }
  });

  afterAll(async () => {
    await app?.close();
    hub?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------ onboarding

  it('onboards: dashboard OTP → CCSID → the 6 compliance checks (standard/simplified × 388/381/383) → PCSID', async () => {
    const inst = hub.einvoice.repo.instanceBySlug(project().id, 'zatca')!;
    egs = demoEgs({ keyPem: inst.config.caKeyPem!, certPem: inst.config.caCertPem! }, { template: ZATCA_ENV_TEMPLATE.simulation });

    // OTP: not 6 digits → Invalid-OTP; a dashboard OTP is accepted.
    const bad = await call('POST', `${zp('zatca')}/compliance`, { csr: b64(egs.csrPem) }, { ...V2, otp: '12ab' });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: 'Invalid-OTP' });
    const o = await call('POST', `${API}/instances/zatca/otp`);
    expect(o.status).toBe(201);
    expect(o.body.otp).toMatch(/^\d{6}$/);

    const c = await call('POST', `${zp('zatca')}/compliance`, { csr: b64(egs.csrPem) }, { ...V2, otp: o.body.otp });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ dispositionMessage: 'ISSUED', errors: null, tokenType: expect.stringContaining('X509v3') });
    expect(String(c.body.requestID)).toMatch(/^\d{13}$/);
    // binarySecurityToken = base64 of the base64 DER of the issued certificate.
    const der = Buffer.from(Buffer.from(c.body.binarySecurityToken, 'base64').toString('utf8'), 'base64');
    const cert = new X509Certificate(der);
    expect(cert.checkIssued(new X509Certificate(inst.config.caCertPem!))).toBe(true);
    ccsid = cred(c.body);
    const ccsidEgs = { ...egs, certPem: certOf('zatca', ccsid.token) };

    // Missing compliance checks: no PCSID yet.
    const early = await call('POST', `${zp('zatca')}/production/csids`, { compliance_request_id: String(c.body.requestID) }, { ...V2, authorization: basic(ccsid) });
    expect(early.status).toBe(400);
    expect(early.body).toMatchObject({ code: 'Missing-ComplianceSteps' });
    expect(early.body.message).toContain('standard:388');
    let list = await call('GET', `${API}/csids?instance=zatca&kind=compliance`);
    expect(list.body[0].progress).toMatchObject({ done: 0, needed: 6 });

    const kinds = [
      ['standard', '388'],
      ['standard', '381'],
      ['standard', '383'],
      ['simplified', '388'],
      ['simplified', '381'],
      ['simplified', '383'],
    ] as const;
    for (const [i, [type, kind]] of kinds.entries()) {
      const s = await mk('zatca', ccsidEgs, type, `CMP-${i + 1}`, { kind }, 'compliance');
      const r = await send('zatca', 'compliance', s, ccsid);
      expect(r.status, JSON.stringify(r.body.validationResults)).toBe(200);
      expect(r.body.validationResults.status).toBe('PASS');
      expect(r.body.validationResults.infoMessages[0]).toMatchObject({ code: 'XSD_ZATCA_VALID', status: 'PASS' });
      expect(r.body).toMatchObject({ qrSellertStatus: null, qrBuyertStatus: null });
      if (type === 'standard') expect(r.body).toMatchObject({ clearanceStatus: 'CLEARED', reportingStatus: null });
      else expect(r.body).toMatchObject({ reportingStatus: 'REPORTED', clearanceStatus: null });
      if (i === 4) {
        const five = await call('POST', `${zp('zatca')}/production/csids`, { compliance_request_id: String(c.body.requestID) }, { ...V2, authorization: basic(ccsid) });
        expect(five.status).toBe(400);
        expect(five.body.message).toContain('simplified:383');
        expect(five.body.message).not.toContain('standard:388');
      }
    }
    list = await call('GET', `${API}/csids?instance=zatca&kind=compliance`);
    expect(list.body[0].progress).toMatchObject({ done: 6, needed: 6 });
    const cc = await chainOf('zatca', 'compliance');
    expect(cc).toMatchObject({ scope: 'compliance', count: 6, lastIcv: 6, next: { icv: 7 } });

    // The compliance_request_id must be the CCSID's; the PCSID endpoint needs the CCSID.
    const wrongId = await call('POST', `${zp('zatca')}/production/csids`, { compliance_request_id: '1234567890123' }, { ...V2, authorization: basic(ccsid) });
    expect(wrongId.status).toBe(400);
    expect(wrongId.body).toMatchObject({ code: 'Invalid-Request-ID' });

    const p = await call('POST', `${zp('zatca')}/production/csids`, { compliance_request_id: String(c.body.requestID) }, { ...V2, authorization: basic(ccsid) });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ dispositionMessage: 'ISSUED' });
    pcsid = cred(p.body);
    expect(pcsid.token).not.toBe(ccsid.token);
    const row = csidRow('zatca', pcsid.token);
    expect(row).toMatchObject({ kind: 'production', status: 'active', parentId: csidRow('zatca', ccsid.token).id, env: 'simulation' });
    egs = { ...egs, certPem: row.certPem };

    // A PCSID can't ask for another PCSID.
    const withP = await call('POST', `${zp('zatca')}/production/csids`, { compliance_request_id: String(c.body.requestID) }, { ...V2, authorization: basic(pcsid) });
    expect(withP.status).toBe(401);
  });

  // ------------------------------------------------------------------ reporting

  it('reporting: 200 REPORTED, 202 with a warning, 400 NOT_REPORTED, 409 duplicate; the chain advances on each parsed invoice', async () => {
    const s1 = await mk('zatca', egs, 'simplified', 'INV-1');
    const r1 = await send('zatca', 'reporting', s1, pcsid);
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r1.body).toMatchObject({ reportingStatus: 'REPORTED', validationResults: { status: 'PASS', errorMessages: [], warningMessages: [] } });
    expect(await chainOf('zatca')).toMatchObject({ lastIcv: 1, lastHash: s1.invoiceHash, count: 1, lastNumber: 'INV-1', next: { icv: 2, pih: s1.invoiceHash } });

    // 202: a warning (the fault adds one) is still reported.
    const s2 = await mk('zatca', egs, 'simplified', 'INV-2');
    const r2 = await send('zatca', 'reporting', s2, pcsid, { 'x-hub-scenario': 'warning' });
    expect(r2.status).toBe(202);
    expect(r2.body).toMatchObject({ reportingStatus: 'REPORTED', validationResults: { status: 'WARNING' } });
    expect(r2.body.validationResults.warningMessages.map((m: any) => m.code)).toContain('BR-KSA-08');
    expect((await latest('zatca')).status).toBe('REPORTED');

    // 400: a total that does not add up.
    const s3 = await mk('zatca', egs, 'simplified', 'INV-3', { break: ['total-mismatch'] });
    const r3 = await send('zatca', 'reporting', s3, pcsid);
    expect(r3.status).toBe(400);
    expect(r3.body).toMatchObject({ reportingStatus: 'NOT_REPORTED', validationResults: { status: 'ERROR' } });
    expect(codes(r3.body.validationResults)).toContain('BR-CO-15');
    expect(await latest('zatca')).toMatchObject({ status: 'NOT_REPORTED', httpStatus: 400, icv: 3 });
    // NOT_REPORTED still advances the chain (it lives on the EGS).
    expect(await chainOf('zatca')).toMatchObject({ lastIcv: 3, count: 3 });

    // 409: the same hash again within 24 h; the chain stays.
    const dup = await send('zatca', 'reporting', s1, pcsid);
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ reportingStatus: 'REPORTED' });
    const d = await latest('zatca');
    expect(d.status).toBe('DUPLICATE');
    expect(lintChecks(d)).toContain('einv.duplicate-resubmitted');
    expect(await chainOf('zatca')).toMatchObject({ lastIcv: 3, count: 3 });

    // Resending the rejected head (same hash + ICV) is a retry: no chain findings, the chain does not move.
    const again = await send('zatca', 'reporting', s3, pcsid);
    expect(again.status).toBe(400);
    const a = await latest('zatca');
    expect(lintChecks(a).filter((c) => c.startsWith('einv.icv') || c === 'einv.pih-mismatch')).toEqual([]);
    expect(await chainOf('zatca')).toMatchObject({ lastIcv: 3, count: 3 });
  });

  it('retry rule: a 5xx does not advance the chain, the resend is accepted, a resend after acceptance is a duplicate', async () => {
    const s = await mk('zatca', egs, 'simplified', 'INV-4');
    const f = await send('zatca', 'reporting', s, pcsid, { 'x-hub-scenario': 'server_error' });
    expect(f.status).toBe(500);
    expect(await latest('zatca')).toMatchObject({ status: 'FAULT', fault: 'server_error', httpStatus: 500 });
    expect(await chainOf('zatca')).toMatchObject({ lastIcv: 3 });

    const ok = await send('zatca', 'reporting', s, pcsid);
    expect(ok.status).toBe(200);
    const inv = await latest('zatca');
    expect(lintChecks(inv)).not.toContain('einv.icv-repeat');
    expect(await chainOf('zatca')).toMatchObject({ lastIcv: 4, lastHash: s.invoiceHash });

    const dup = await send('zatca', 'reporting', s, pcsid);
    expect(dup.status).toBe(409);
  });

  it('wrong endpoint: a standard invoice on reporting and a simplified one on clearance are refused with BR-KSA-06', async () => {
    const st = await mk('zatca', egs, 'standard', 'INV-5');
    const r = await send('zatca', 'reporting', st, pcsid);
    expect(r.status).toBe(400);
    expect(codes(r.body.validationResults)).toContain('BR-KSA-06');
    expect(lintChecks(await latest('zatca'))).toContain('einv.wrong-endpoint');

    const si = await mk('zatca', egs, 'simplified', 'INV-6');
    const c = await send('zatca', 'clearance', si, pcsid);
    expect(c.status).toBe(400);
    expect(c.body).toMatchObject({ clearanceStatus: 'NOT_CLEARED', clearedInvoice: null });
    expect(codes(c.body.validationResults)).toContain('BR-KSA-06');
    expect(lintChecks(await latest('zatca'))).toContain('einv.wrong-endpoint');
  });

  // ------------------------------------------------------------------ clearance

  it('clearance: 200 CLEARED with a stamp verifiable with ca.pem, 208 duplicate, 400 NOT_CLEARED, 303 when switched off', async () => {
    const s = await mk('zatca', egs, 'standard', 'B2B-1');
    const r = await send('zatca', 'clearance', s, pcsid, { 'clearance-status': '' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ clearanceStatus: 'CLEARED', validationResults: { status: 'PASS' } });
    const cleared = Buffer.from(r.body.clearedInvoice, 'base64').toString('utf8');
    const inv = await latest('zatca');
    expect(inv).toMatchObject({ status: 'CLEARED', endpoint: 'clearance', docType: 'standard', hasClearedXml: true });
    // Without Clearance-Status (or 0) clearance still works, with a lint info.
    expect(lintChecks(inv)).toContain('einv.clearance-status-header');

    // The stamp: the hash is unchanged, the QR is regenerated and signed with the fake ZATCA CA.
    expect(invoiceHash(cleared)).toBe(s.invoiceHash);
    const ca = await call('GET', `${API}/instances/zatca/ca.pem?download=0`);
    expect(ca.status).toBe(200);
    const caPem = String(ca.body);
    expect(caPem).toContain('BEGIN CERTIFICATE');
    const qr = /<cbc:ID>QR<\/cbc:ID>[\s\S]*?<cbc:EmbeddedDocumentBinaryObject[^>]*>([^<]+)</.exec(cleared)![1];
    const tlv = decodeTlv(qr);
    if (!tlv.ok) throw new Error(tlv.error);
    const tag = (n: number) => tlv.fields.find((f) => f.tag === n)!;
    expect(tag(2).text).toBe(egs.vat);
    expect(asBase64(tag(6))).toBe(s.invoiceHash);
    expect(ecdsaVerify(caPem, Buffer.from(s.invoiceHash, 'base64'), asBase64(tag(7)))).toBe(true);
    expect(tag(8).bytes.equals(new X509Certificate(caPem).publicKey.export({ format: 'der', type: 'spki' }))).toBe(true);
    expect(tlv.fields.some((f) => f.tag === 9)).toBe(false);

    // GET …/xml?cleared=1 serves the same stamped XML.
    const x = await call('GET', `${API}/invoices/${inv.id}/xml?cleared=1`);
    expect(x.status).toBe(200);
    expect(x.headers.get('content-type')).toContain('application/xml');
    expect(x.body).toBe(cleared);

    // 208: the same hash again → the stored cleared invoice.
    const d = await send('zatca', 'clearance', s, pcsid);
    expect(d.status).toBe(208);
    expect(d.body).toMatchObject({ clearanceStatus: 'CLEARED', clearedInvoice: r.body.clearedInvoice });
    expect((await latest('zatca')).status).toBe('DUPLICATE');

    // 400: a line VAT error → NOT_CLEARED, clearedInvoice null, no cleared XML.
    const bad = await mk('zatca', egs, 'standard', 'B2B-2', { break: ['line-vat'] });
    const b = await send('zatca', 'clearance', bad, pcsid);
    expect(b.status).toBe(400);
    expect(b.body).toMatchObject({ clearanceStatus: 'NOT_CLEARED', clearedInvoice: null });
    expect(codes(b.body.validationResults)).toContain('BR-KSA-51');
    const bi = await latest('zatca');
    expect(bi.hasClearedXml).toBe(false);
    expect((await call('GET', `${API}/invoices/${bi.id}/xml?cleared=1`)).status).toBe(404);

    // 303: clearance switched off; stored, and the chain does not move.
    const head = await chainOf('zatca');
    expect((await call('PATCH', `${API}/instances/zatca`, { config: { clearanceEnabled: false } })).status).toBe(200);
    const off = await send('zatca', 'clearance', await mk('zatca', egs, 'standard', 'B2B-3'), pcsid);
    expect(off.status).toBe(303);
    expect(off.body).toMatchObject({ category: 'HTTP-Errors', code: '303' });
    expect(await latest('zatca')).toMatchObject({ status: 'ERROR', httpStatus: 303 });
    expect((await chainOf('zatca')).lastIcv).toBe(head.lastIcv);
    expect((await call('PATCH', `${API}/instances/zatca`, { config: { clearanceEnabled: true } })).status).toBe(200);
  });

  // ------------------------------------------------------------------ auth and headers

  it('401 for missing, unknown, wrong-secret and compliance credentials; 406 without Accept-Version V2', async () => {
    const n0 = await next('zatca');
    const s = await mk('zatca', egs, 'simplified', 'AUTH-1');
    const none = await send('zatca', 'reporting', s, null);
    expect(none.status).toBe(401);
    expect(none.body).toMatchObject({ status: 401, error: 'Unauthorized', message: '' });
    expect(typeof none.body.timestamp).toBe('string');
    expect(lintChecks(await latest('zatca'))).toContain('einv.unknown-csid');

    expect((await send('zatca', 'reporting', s, { token: b64('nope'), secret: 'x' })).status).toBe(401);
    expect((await send('zatca', 'reporting', s, { token: pcsid.token, secret: 'wrong' })).status).toBe(401);

    const withC = await send('zatca', 'reporting', s, ccsid);
    expect(withC.status).toBe(401);
    expect(lintChecks(await latest('zatca'))).toContain('einv.ccsid-in-production');

    const noV = await send('zatca', 'reporting', s, pcsid, { 'accept-version': '' });
    expect(noV.status).toBe(406);
    expect(typeof noV.body.message).toBe('string');
    expect(await latest('zatca')).toMatchObject({ status: 'ERROR', httpStatus: 406 });
    expect(lintChecks(await latest('zatca'))).toContain('einv.accept-version-missing');
    expect((await send('zatca', 'reporting', s, pcsid, { 'accept-version': 'V1' })).status).toBe(406);
    // Accept-Version is checked before auth; onboarding needs it too.
    expect((await call('POST', `${zp('zatca')}/compliance`, { csr: b64(egs.csrPem) }, { otp: '123456' })).status).toBe(406);

    // None of these moved the chain.
    expect(await next('zatca')).toEqual(n0);
    expect((await send('zatca', 'reporting', s, pcsid)).status).toBe(200);
  });

  it('strictAuth=false: unknown credentials are served, with einv.unknown-csid lint', async () => {
    const e = demoEgs({ keyPem: hub.einvoice.repo.getInstance(instanceId('lax'))!.config.caKeyPem!, certPem: hub.einvoice.repo.getInstance(instanceId('lax'))!.config.caCertPem! }, { template: ZATCA_ENV_TEMPLATE.simulation });
    const s = sample({ type: 'simplified', kind: '388', icv: 1, number: 'LAX-1', egs: e });
    const r = await send('lax', 'reporting', s, null);
    expect(r.status).not.toBe(401);
    expect(r.body.reportingStatus).toBeDefined();
    expect(lintChecks(await latest('lax'))).toContain('einv.unknown-csid');
  });

  // ------------------------------------------------------------------ CSR, OTP and environments

  it('strictCsr refuses the wrong template or curve; config.otp restricts the OTP; garbage CSRs are refused', async () => {
    const S = zp('strict', 'core');
    const simTemplate = demoEgs(undefined, { template: ZATCA_ENV_TEMPLATE.simulation });
    const okCsr = demoEgs(undefined, { template: ZATCA_ENV_TEMPLATE.core });

    const wrongOtp = await call('POST', `${S}/compliance`, { csr: b64(okCsr.csrPem) }, { ...V2, otp: '111111' });
    expect(wrongOtp.status).toBe(400);
    expect(wrongOtp.body).toMatchObject({ code: 'Invalid-OTP' });

    const tpl = await call('POST', `${S}/compliance`, { csr: b64(simTemplate.csrPem) }, { ...V2, otp: '654321' });
    expect(tpl.status).toBe(400);
    expect(tpl.body).toMatchObject({ code: 'Invalid-CSR' });
    expect(tpl.body.message).toContain('ZATCA-Code-Signing');

    const p256 = buildCsr({
      privateKey: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey,
      commonName: 'EGS-p256',
      vatNumber: '399999999900003',
      egsSerial: '1-x|2-y|3-z',
      orgUnit: 'Branch',
      org: 'Org',
      address: 'RRRD2929',
      industry: 'Supply',
      template: ZATCA_ENV_TEMPLATE.core,
    });
    const curve = await call('POST', `${S}/compliance`, { csr: b64(p256) }, { ...V2, otp: '654321' });
    expect(curve.status).toBe(400);
    expect(curve.body.message).toContain('secp256k1');

    expect((await call('POST', `${S}/compliance`, { csr: b64('not a csr') }, { ...V2, otp: '654321' })).body).toMatchObject({ code: 'Invalid-CSR' });
    expect((await call('POST', `${S}/compliance`, {}, { ...V2, otp: '654321' })).body).toMatchObject({ code: 'Invalid-CSR' });

    const ok = await call('POST', `${S}/compliance`, { csr: b64(okCsr.csrPem) }, { ...V2, otp: '654321' });
    expect(ok.status).toBe(200);
    // A dashboard OTP works next to config.otp.
    const o = await call('POST', `${API}/instances/strict/otp`);
    expect((await call('POST', `${S}/compliance`, { csr: b64(okCsr.csrPem) }, { ...V2, otp: o.body.otp })).status).toBe(200);
  });

  it('per-environment base URLs: the /e-invoicing/<env> segment sets the expected CSR template; without it the instance env applies', async () => {
    const dev = demoEgs(undefined, { template: ZATCA_ENV_TEMPLATE['developer-portal'] });
    const issue = async (p: string) => {
      const r = await call('POST', `${p}/compliance`, { csr: b64(dev.csrPem) }, { ...V2, otp: '123456' });
      expect(r.status).toBe(200);
      return csidRow('zatca', r.body.binarySecurityToken);
    };
    const onDev = await issue('/einvoice/ksa/zatca/e-invoicing/developer-portal');
    expect(onDev.env).toBe('developer-portal');
    expect(onDev.lint.map((l) => l.check)).not.toContain('einv.csr-template-env');
    const onCore = await issue('/einvoice/ksa/zatca/e-invoicing/core');
    expect(onCore.env).toBe('core');
    expect(onCore.lint.map((l) => l.check)).toContain('einv.csr-template-env');
    const bare = await issue('/einvoice/ksa/zatca');
    expect(bare.env).toBe('simulation');
    expect(bare.lint.map((l) => l.check)).toContain('einv.csr-template-env');
    // The CSR lint shows in GET /lint.
    const lint = await call('GET', `${API}/lint`);
    expect(lint.body.byCheck['einv.csr-template-env']).toBeGreaterThanOrEqual(2);

    const conn = await call('GET', `${API}/instances/zatca/connect`);
    expect(conn.status).toBe(200);
    expect(conn.body).toMatchObject({ env: 'simulation', csrTemplate: 'PREZATCA-Code-Signing', firstPih: FIRST_PIH });
    expect(conn.body.urls.reporting).toBe(`${base}/einvoice/ksa/zatca/e-invoicing/simulation/invoices/reporting/single`);
    expect(conn.body.urls.byEnv.core).toBe(`${base}/einvoice/ksa/zatca/e-invoicing/core`);
  });

  // ------------------------------------------------------------------ chain checks

  it('chainCheck error: a wrong PIH and an ICV repeat are stubyard-chain errors (a gap / reset stay warnings); off: no chain lint; chain reset starts over', async () => {
    ({ egs: chainEgs, pcsid: chainPcsid } = await onboard('chainerr'));
    const s1 = await mk('chainerr', chainEgs, 'simplified', 'CH-1');
    expect((await send('chainerr', 'reporting', s1, chainPcsid)).status).toBe(200);

    // An ICV gap is a warn-level finding: lint only, also with chainCheck error.
    const gap = await mk('chainerr', chainEgs, 'simplified', 'CH-2', { break: ['icv-gap'] });
    const g = await send('chainerr', 'reporting', gap, chainPcsid);
    expect(g.status).toBe(200);
    expect(codes(g.body.validationResults)).not.toContain('stubyard-chain');
    expect(lintChecks(await latest('chainerr'))).toContain('einv.icv-gap');
    expect((await chainOf('chainerr')).lastIcv).toBe(3);

    const pih = await mk('chainerr', chainEgs, 'simplified', 'CH-4', { break: ['pih-wrong'] });
    const p = await send('chainerr', 'reporting', pih, chainPcsid);
    expect(p.status).toBe(400);
    expect(p.body.reportingStatus).toBe('NOT_REPORTED');
    const msg = p.body.validationResults.errorMessages.find((m: any) => m.code === 'stubyard-chain').message;
    expect(msg).toContain('is not the hash of invoice CH-2 (ICV 3)');
    expect(lintChecks(await latest('chainerr'))).toContain('einv.pih-mismatch');
    // The refused invoice still advances the chain.
    expect((await chainOf('chainerr')).lastIcv).toBe(4);

    // An ICV repeat (not a retry: a different hash) is an error; going back to ICV 1 is a reset (warning).
    const n = await next('chainerr');
    const rep = sample({ type: 'simplified', kind: '388', icv: n.icv - 1, pih: n.pih, number: 'CH-5', egs: chainEgs });
    const rr = await send('chainerr', 'reporting', rep, chainPcsid);
    expect(rr.status).toBe(400);
    expect(codes(rr.body.validationResults)).toContain('stubyard-chain');
    expect(lintChecks(await latest('chainerr'))).toContain('einv.icv-repeat');
    const back = sample({ type: 'simplified', kind: '388', icv: 1, pih: (await next('chainerr')).pih, number: 'CH-6', egs: chainEgs });
    expect((await send('chainerr', 'reporting', back, chainPcsid)).status).toBe(200);
    expect(lintChecks(await latest('chainerr'))).toContain('einv.icv-reset');

    // chainCheck lint (the zatca instance): the same break is lint only.
    const lint = await mk('zatca', egs, 'simplified', 'LINT-1', { break: ['pih-wrong'] });
    const l = await send('zatca', 'reporting', lint, pcsid);
    expect(l.status).toBe(200);
    expect(lintChecks(await latest('zatca'))).toContain('einv.pih-mismatch');

    // chainCheck off: no chain lint at all.
    expect((await call('PATCH', `${API}/instances/chainerr`, { config: { chainCheck: 'off' } })).status).toBe(200);
    const off = await mk('chainerr', chainEgs, 'simplified', 'CH-7', { break: ['icv-gap'] });
    expect((await send('chainerr', 'reporting', off, chainPcsid)).status).toBe(200);
    expect(lintChecks(await latest('chainerr')).filter((c) => c.startsWith('einv.icv') || c === 'einv.pih-mismatch')).toEqual([]);

    const chain = await chainOf('chainerr');
    const reset = await call('POST', `${API}/chains/${chain.id}/reset`);
    expect(reset.status).toBe(200);
    expect(reset.body).toMatchObject({ lastIcv: null, lastHash: null, count: 0, next: { icv: 1, pih: FIRST_PIH } });
    const fresh = sample({ type: 'simplified', kind: '388', icv: 1, number: 'CH-8', egs: chainEgs });
    expect((await send('chainerr', 'reporting', fresh, chainPcsid)).status).toBe(200);
  });

  // ------------------------------------------------------------------ faults

  it('every fault of the catalog over X-Hub-Scenario', async () => {
    const s = await mk('zatca', egs, 'simplified', 'F-1');
    const st = await mk('zatca', egs, 'standard', 'F-1B');
    const head = await chainOf('zatca');
    const rep = (fault: string) => send('zatca', 'reporting', s, pcsid, { 'x-hub-scenario': fault });
    const clr = (fault: string) => send('zatca', 'clearance', st, pcsid, { 'x-hub-scenario': fault });

    const rj = await rep('reject');
    expect(rj.status).toBe(400);
    expect(rj.body).toMatchObject({ reportingStatus: 'NOT_REPORTED' });
    expect(rj.body.validationResults.errorMessages[0].code).toBe('BR-KSA-26');
    const rjc = await clr('reject:BR-KSA-37');
    expect(rjc.status).toBe(400);
    expect(rjc.body).toMatchObject({ clearanceStatus: 'NOT_CLEARED', clearedInvoice: null });
    expect(rjc.body.validationResults.errorMessages[0].code).toBe('BR-KSA-37');

    expect((await rep('duplicate')).status).toBe(409);
    const dc = await clr('duplicate');
    expect(dc.status).toBe(208);
    expect(dc.body.clearedInvoice).toEqual(expect.any(String));
    expect((await rep('unauthorized')).status).toBe(401);
    expect((await clr('clearance_off')).status).toBe(303);
    expect((await rep('too_large')).status).toBe(413);
    const rl = await rep('rate_limited:7');
    expect(rl.status).toBe(429);
    expect(rl.headers.get('retry-after')).toBe('7');
    expect((await rep('rate_limited')).headers.get('retry-after')).toBe('60');
    for (const [f, code] of [
      ['server_error', 500],
      ['unavailable', 503],
      ['gateway_timeout', 504],
    ] as const) {
      const r = await rep(f);
      expect(r.status).toBe(code);
      expect(r.body).toMatchObject({ category: 'HTTP-Errors', code: String(code) });
    }
    const faults = (await call('GET', `${API}/invoices?instance=zatca&status=FAULT&limit=50`)).body.map((i: any) => i.fault);
    expect(faults).toEqual(expect.arrayContaining(['reject', 'reject:BR-KSA-37', 'duplicate', 'unauthorized', 'clearance_off', 'too_large', 'rate_limited:7', 'server_error', 'unavailable', 'gateway_timeout']));
    // Faults never advance the chain.
    expect((await chainOf('zatca')).lastIcv).toBe(head.lastIcv);

    // timeout: the connection is closed without an answer after STUBYARD_TIMEOUT_HOLD_MS.
    const t0 = Date.now();
    await expect(rep('timeout')).rejects.toThrow();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(HOLD_MS - 20);
    expect((await latest('zatca')).fault).toBe('timeout');

    // A fault that does not apply to the endpoint is ignored.
    const notHere = await rep('clearance_off');
    expect(notHere.status).toBe(200);
    // slow: answers normally after the delay (the next invoice).
    const s2 = await mk('zatca', egs, 'simplified', 'F-2');
    const t1 = Date.now();
    const slow = await send('zatca', 'reporting', s2, pcsid, { 'x-hub-scenario': 'slow:300' });
    expect(slow.status).toBe(200);
    expect(Date.now() - t1).toBeGreaterThanOrEqual(280);
    // none: answers normally.
    const s3 = await mk('zatca', egs, 'simplified', 'F-3');
    expect((await send('zatca', 'reporting', s3, pcsid, { 'x-hub-scenario': 'none' })).status).toBe(200);
    // warning:CODE reports the named code as a warning (202).
    const s4 = await mk('zatca', egs, 'simplified', 'F-4');
    const wc = await send('zatca', 'reporting', s4, pcsid, { 'x-hub-scenario': 'warning:BR-KSA-37' });
    expect(wc.status).toBe(202);
    expect(wc.body.validationResults.warningMessages.map((m: any) => m.code)).toEqual(['BR-KSA-37']);
    expect(await latest('zatca')).toMatchObject({ status: 'REPORTED', fault: 'warning:BR-KSA-37' });
    // An unknown fault name is a 400 from stubyard (shape of an HttpError).
    expect((await send('zatca', 'reporting', s3, pcsid, { 'x-hub-scenario': 'bogus' })).status).toBe(400);

    // Onboarding faults.
    const C = `${zp('zatca')}/compliance`;
    expect((await call('POST', C, { csr: b64(egs.csrPem) }, { ...V2, otp: '123456', 'x-hub-scenario': 'otp_invalid' })).body).toMatchObject({ code: 'Invalid-OTP' });
    const ex = await call('POST', C, { csr: b64(egs.csrPem) }, { ...V2, otp: '123456', 'x-hub-scenario': 'otp_expired' });
    expect(ex.status).toBe(400);
    expect(ex.body).toMatchObject({ code: 'Expired-OTP' });
    const nc = await call('POST', `${zp('zatca')}/production/csids`, { compliance_request_id: '1' }, { ...V2, authorization: basic(ccsid), 'x-hub-scenario': 'not_compliant' });
    expect(nc.status).toBe(400);
    expect(nc.body).toMatchObject({ code: 'Missing-ComplianceSteps' });
    const rn = await call('PATCH', `${zp('zatca')}/production/csids`, { csr: b64(egs.csrPem) }, { ...V2, otp: '123456', authorization: basic(pcsid), 'x-hub-scenario': 'renewal_not_compliant' });
    expect(rn.status).toBe(428);
    // The PCSID was not renewed by the fault.
    expect(csidRow('zatca', pcsid.token).status).toBe('active');
  });

  it('fault rules: match + times, hits counted, run rules only inside the run, bad faults refused', async () => {
    expect((await call('POST', `${API}/faults`, { fault: 'bogus' })).status).toBe(400);
    const rule = await call('POST', `${API}/faults`, { fault: 'unavailable', endpoint: 'reporting', number: 'RULE-1', times: 1, instance: 'zatca' });
    expect(rule.status).toBe(201);
    const other = await mk('zatca', egs, 'simplified', 'RULE-0');
    expect((await send('zatca', 'reporting', other, pcsid)).status).toBe(200);
    const s = await mk('zatca', egs, 'simplified', 'RULE-1');
    expect((await send('zatca', 'reporting', s, pcsid)).status).toBe(503);
    expect((await send('zatca', 'reporting', s, pcsid)).status).toBe(200);
    const list = await call('GET', `${API}/faults`);
    expect(list.body.find((r: any) => r.id === rule.body.id)).toMatchObject({ hits: 1, remaining: 0 });
    expect((await call('DELETE', `${API}/faults/${rule.body.id}`)).status).toBe(204);

    expect((await call('POST', '/api/projects/ksa/runs', { key: 'p1' })).status).toBe(201);
    expect((await call('POST', `${API}/faults`, { fault: 'gateway_timeout', run: 'p1' })).status).toBe(201);
    const a = await mk('zatca', egs, 'simplified', 'RUN-1');
    expect((await send('zatca', 'reporting', a, pcsid)).status).toBe(200);
    const b = await mk('zatca', egs, 'simplified', 'RUN-2');
    expect((await send('zatca', 'reporting', b, pcsid, {}, '/run/p1')).status).toBe(504);
    expect((await call('GET', `${API}/invoices?run=p1`)).body.map((i: any) => i.number)).toEqual(['RUN-2']);
    expect((await call('POST', '/api/projects/ksa/runs/p1/stop', {})).status).toBe(200);
    expect((await call('DELETE', `${API}/faults`)).status).toBe(200);
    expect((await send('zatca', 'reporting', b, pcsid)).status).toBe(200);
  });

  // ------------------------------------------------------------------ REST views

  it('invoices over REST: filters, detail with XML and chain, cursor + wait, delete', async () => {
    const all = await call('GET', `${API}/invoices?instance=zatca&endpoint=clearance&status=CLEARED`);
    expect(all.status).toBe(200);
    expect(all.body.length).toBeGreaterThan(0);
    expect(all.body.every((i: any) => i.endpoint === 'clearance' && i.status === 'CLEARED' && i.instance === 'zatca' && i.xml === undefined)).toBe(true);
    expect((await call('GET', `${API}/invoices?number=INV-1`)).body.every((i: any) => i.number === 'INV-1')).toBe(true);
    expect((await call('GET', `${API}/invoices?docType=standard&instance=zatca`)).body.every((i: any) => i.docType === 'standard')).toBe(true);
    expect((await call('GET', `${API}/invoices?endpoint=nope`)).status).toBe(400);

    const one = (await call('GET', `${API}/invoices?instance=zatca&number=INV-1&status=REPORTED`)).body[0];
    const detail = await call('GET', `${API}/invoices/${one.id}`);
    expect(detail.body).toMatchObject({ number: 'INV-1', icv: 1, pih: FIRST_PIH, sellerVat: egs.vat, chain: { scope: 'production', vatNumber: egs.vat } });
    expect(detail.body.xml).toContain('<cbc:ID>INV-1</cbc:ID>');
    expect(detail.body.headers.authorization).toBe('Basic [redacted]');
    const xml = await call('GET', `${API}/invoices/${one.id}/xml`);
    expect(xml.body).toBe(detail.body.xml);
    expect((await call('GET', `${API}/invoices/nope`)).status).toBe(404);

    // Cursor: nothing after the newest → wait times out; a new invoice wakes it.
    const head = await call('GET', `${API}/invoices?limit=1`);
    const cursor = head.headers.get('x-stubyard-cursor')!;
    expect(cursor).toBe(head.body[0].id);
    const empty = await call('GET', `${API}/invoices/wait?after=${cursor}&timeout=1`);
    expect(empty.body).toMatchObject({ timedOut: true, invoices: [] });
    const waiting = call('GET', `${API}/invoices/wait?after=${cursor}&timeout=10&number=WAIT-1`);
    await new Promise((r) => setTimeout(r, 100));
    const s = await mk('zatca', egs, 'simplified', 'WAIT-1');
    expect((await send('zatca', 'reporting', s, pcsid)).status).toBe(200);
    const w = await waiting;
    expect(w.body.timedOut).toBe(false);
    expect(w.body.invoices.map((i: any) => i.number)).toEqual(['WAIT-1']);
    expect(w.headers.get('x-stubyard-cursor')).toBe(w.body.invoices[0].id);

    const del = await call('DELETE', `${API}/invoices?instance=lax`);
    expect(del.body.deleted).toBeGreaterThan(0);
    expect((await call('GET', `${API}/invoices?instance=lax`)).body).toEqual([]);
  });

  it('disabled instance → 503; unknown routes and instances → 404 listing the served routes', async () => {
    expect((await call('PATCH', `${API}/instances/lax`, { enabled: false })).status).toBe(200);
    const d = await call('POST', `${zp('lax')}/compliance`, { csr: b64(egs.csrPem) }, { ...V2, otp: '123456' });
    expect(d.status).toBe(503);
    expect(d.body).toMatchObject({ category: 'HTTP-Errors', code: '503' });
    expect((await call('PATCH', `${API}/instances/lax`, { enabled: true })).status).toBe(200);

    for (const [m, p] of [
      ['GET', '/compliance'],
      ['POST', '/invoices/reporting'],
      ['POST', '/production/csid'],
      ['DELETE', '/production/csids'],
    ]) {
      const r = await call(m, `${zp('zatca')}${p}`, m === 'GET' || m === 'DELETE' ? undefined : {}, V2);
      expect(r.status, `${m} ${p}`).toBe(404);
      expect(r.body.routes).toEqual(expect.arrayContaining(['POST /compliance', 'PATCH /production/csids', 'POST /invoices/clearance/single']));
    }
    const ui = await call('POST', `/einvoice/ksa/nope/compliance`, {}, V2);
    expect(ui.status).toBe(404);
    expect(ui.body.message).toContain('no e-invoicing instance "nope"');
  });

  // ------------------------------------------------------------------ renewal, revoke, expire

  it('renewal (PATCH production CSID): OTP + CSR with PCSID auth; the old PCSID is superseded and the chain continues', async () => {
    const inst = hub.einvoice.repo.getInstance(instanceId('zatca'))!;
    const renewed = demoEgs({ keyPem: inst.config.caKeyPem!, certPem: inst.config.caCertPem! }, { template: ZATCA_ENV_TEMPLATE.simulation });
    const P = `${zp('zatca')}/production/csids`;
    expect((await call('PATCH', P, { csr: b64(renewed.csrPem) }, { ...V2, authorization: basic(pcsid) })).body).toMatchObject({ code: 'Invalid-OTP' });
    expect((await call('PATCH', P, { csr: b64(renewed.csrPem) }, { ...V2, otp: '123456', authorization: basic(ccsid) })).status).toBe(401);

    const before = await chainOf('zatca');
    const r = await call('PATCH', P, { csr: b64(renewed.csrPem) }, { ...V2, otp: '123456', authorization: basic(pcsid) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ dispositionMessage: 'ISSUED' });
    const old = csidRow('zatca', pcsid.token);
    expect(old.status).toBe('superseded');
    const nextCred = cred(r.body);
    const row = csidRow('zatca', nextCred.token);
    expect(row).toMatchObject({ kind: 'production', status: 'active', parentId: old.id });

    const s = await mk('zatca', egs, 'simplified', 'OLD-1');
    expect((await send('zatca', 'reporting', s, pcsid)).status).toBe(401);
    pcsid = nextCred;
    egs = { ...renewed, certPem: row.certPem };
    const s2 = await mk('zatca', egs, 'simplified', 'NEW-1');
    expect((await send('zatca', 'reporting', s2, pcsid)).status).toBe(200);
    // Same EGS serial → same chain.
    const after = await chainOf('zatca');
    expect(after.id).toBe(before.id);
    expect(after.lastIcv).toBe(before.lastIcv + 1);
  });

  it('revoking or expiring a CSID over REST makes the next request 401', async () => {
    const id = csidRow('chainerr', chainPcsid.token).id;
    const rv = await call('POST', `${API}/csids/${id}/revoke`);
    expect(rv.status).toBe(200);
    expect(rv.body).toMatchObject({ status: 'revoked', instance: 'chainerr' });
    const s = await mk('chainerr', chainEgs, 'simplified', 'REV-1');
    expect((await send('chainerr', 'reporting', s, chainPcsid)).status).toBe(401);

    const ex = await call('POST', `${API}/csids/${csidRow('zatca', pcsid.token).id}/expire`);
    expect(ex.status).toBe(200);
    expect(ex.body.status).toBe('expired');
    const s2 = await mk('zatca', egs, 'simplified', 'EXP-1');
    expect((await send('zatca', 'reporting', s2, pcsid)).status).toBe(401);
    const detail = await call('GET', `${API}/csids/${ex.body.id}`);
    expect(detail.body).toMatchObject({ status: 'expired', certPem: expect.stringContaining('BEGIN CERTIFICATE') });
    expect(detail.body.secretHash).toBeUndefined();
  });

  // ------------------------------------------------------------------ reset and export

  it('POST /einvoice/reset clears invoices and chains, keeps instances and CSIDs, zeroes rule hits', async () => {
    const rule = await call('POST', `${API}/faults`, { fault: 'none', endpoint: 'reporting' });
    const lax = await onboard('lax');
    const s = sample({ type: 'simplified', kind: '388', icv: 1, number: 'RST-1', egs: lax.egs });
    expect((await send('lax', 'reporting', s, lax.pcsid)).status).toBe(200);
    expect((await call('GET', `${API}/faults`)).body.find((r: any) => r.id === rule.body.id).hits).toBeGreaterThan(0);

    expect((await call('POST', `${API}/reset`)).status).toBe(200);
    expect((await call('GET', `${API}/invoices`)).body).toEqual([]);
    expect((await call('GET', `${API}/chains`)).body).toEqual([]);
    expect((await call('GET', `${API}/faults`)).body.find((r: any) => r.id === rule.body.id).hits).toBe(0);
    expect((await call('GET', `${API}/instances`)).body.length).toBe(4);
    // The CSID still works; the chain starts over.
    expect((await send('lax', 'reporting', s, lax.pcsid)).status).toBe(200);
    expect(await chainOf('lax')).toMatchObject({ lastIcv: 1, count: 1 });
    expect((await call('DELETE', `${API}/faults`)).status).toBe(200);
  });

  it('export round trip: with ?secrets=1 the CA and production CSIDs survive; without, a new CA and no CSIDs', async () => {
    // strictAuth on, so a 200 proves the CSID came along.
    expect((await call('PATCH', `${API}/instances/lax`, { config: { strictAuth: true } })).status).toBe(200);
    const lax = await onboard('lax');
    expect((await call('POST', `${API}/faults`, { fault: 'reject', number: 'X-RULE', instance: 'lax' })).status).toBe(201);

    const ex = await call('GET', '/api/projects/ksa/export?secrets=1');
    expect(ex.status).toBe(200);
    expect(ex.body.einvoiceInstances.map((i: any) => i.slug).sort()).toEqual(['chainerr', 'lax', 'strict', 'zatca']);
    expect(ex.body.einvoiceCsids.length).toBeGreaterThan(0);
    expect(ex.body.einvoiceCsids.every((c: any) => c.secret)).toBe(true);
    const im = await call('POST', '/api/projects/import', { json: ex.body, slug: 'ksa2', mode: 'create' });
    expect(im.status).toBe(201);
    const caOf = (slug: string, inst: string) => hub.einvoice.repo.instanceBySlug(hub.projects.getBySlug(slug)!.id, inst)!.config.caCertPem;
    expect(caOf('ksa2', 'lax')).toBe(caOf('ksa', 'lax'));
    const s = sample({ type: 'simplified', kind: '388', icv: 1, number: 'EXP-OK', egs: lax.egs });
    const r = await call('POST', '/einvoice/ksa2/lax/e-invoicing/simulation/invoices/reporting/single', { invoiceHash: s.invoiceHash, uuid: s.uuid, invoice: b64(s.xml) }, { ...V2, authorization: basic(lax.pcsid) });
    expect(r.status).toBe(200);
    const rules = await call('GET', '/api/projects/ksa2/einvoice/faults');
    expect(rules.body).toEqual([expect.objectContaining({ fault: 'reject', instance: 'lax', match: { number: 'X-RULE' } })]);

    const plain = await call('GET', '/api/projects/ksa/export');
    expect(plain.body.einvoiceCsids).toBeUndefined();
    expect(JSON.stringify(plain.body.einvoiceInstances)).not.toContain('PRIVATE KEY');
    const im2 = await call('POST', '/api/projects/import', { json: plain.body, slug: 'ksa3', mode: 'create' });
    expect(im2.status).toBe(201);
    expect(JSON.stringify(im2.body.warnings)).toContain('new fake CA generated');
    expect(caOf('ksa3', 'lax')).not.toBe(caOf('ksa', 'lax'));
    const r3 = await call('POST', '/einvoice/ksa3/lax/e-invoicing/simulation/invoices/reporting/single', { invoiceHash: s.invoiceHash, uuid: s.uuid, invoice: b64(s.xml) }, { ...V2, authorization: basic(lax.pcsid) });
    expect(r3.status).toBe(401);
  });
});
