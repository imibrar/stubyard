import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db/index.js';
import { EinvoiceService } from '../src/einvoice/service.js';
import type { Csid, EinvoiceInstance, ZatcaAnswer } from '../src/einvoice/types.js';
import { buildCsr } from '../src/einvoice/zatca/csr.js';
import { FIRST_PIH, hashVariants, invoiceHash } from '../src/einvoice/zatca/hash.js';
import { certFromToken, certInfo, certIssuedBy, ecdsaVerify } from '../src/einvoice/zatca/pki.js';
import { decodeTlv } from '../src/einvoice/zatca/qr.js';
import { ProjectRepo, type Project } from '../src/repos/projects.js';
import { RunRepo } from '../src/repos/runs.js';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const VAT = '399999999900003';
const EGS = '1-TST|2-TST|3-ed22f1d8-e6a2-1118-9b58-d9a8f11e445f';

let db: DB;
let svc: EinvoiceService;
let project: Project;
let inst: EinvoiceInstance;
let runId: string;
const events: unknown[] = [];

function csrPem(invoiceTypes = '1100') {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  return buildCsr({
    privateKey, commonName: 'TST-886431145-399999999900003', vatNumber: VAT, egsSerial: EGS, orgUnit: 'Riyadh Branch',
    org: 'Acme Trading', invoiceTypes, address: 'RRRD2929', industry: 'Retail', template: 'TSTZATCA-Code-Signing',
  });
}

/** A minimal UBL invoice (no signature): enough for the phase 1 checks. */
function ubl(o: { number: string; icv: number; pih: string; kind?: 'standard' | 'simplified'; code?: string; uuid?: string }) {
  const uuid = o.uuid ?? randomUUID();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
    <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
    <cbc:ID>${o.number}</cbc:ID>
    <cbc:UUID>${uuid}</cbc:UUID>
    <cbc:IssueDate>2026-11-26</cbc:IssueDate>
    <cbc:IssueTime>10:00:00</cbc:IssueTime>
    <cbc:InvoiceTypeCode name="${o.kind === 'standard' ? '0100000' : '0200000'}">${o.code ?? '388'}</cbc:InvoiceTypeCode>
    <cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode>
    <cac:AdditionalDocumentReference>
        <cbc:ID>ICV</cbc:ID>
        <cbc:UUID>${o.icv}</cbc:UUID>
    </cac:AdditionalDocumentReference>
    <cac:AdditionalDocumentReference>
        <cbc:ID>PIH</cbc:ID>
        <cac:Attachment>
            <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${o.pih}</cbc:EmbeddedDocumentBinaryObject>
        </cac:Attachment>
    </cac:AdditionalDocumentReference>
    <cac:AdditionalDocumentReference>
        <cbc:ID>QR</cbc:ID>
        <cac:Attachment>
            <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">AQVBY21lIA==</cbc:EmbeddedDocumentBinaryObject>
        </cac:Attachment>
    </cac:AdditionalDocumentReference>
    <cac:AccountingSupplierParty>
        <cac:Party>
            <cac:PartyTaxScheme>
                <cbc:CompanyID>${VAT}</cbc:CompanyID>
            </cac:PartyTaxScheme>
            <cac:PartyLegalEntity>
                <cbc:RegistrationName>Acme Trading</cbc:RegistrationName>
            </cac:PartyLegalEntity>
        </cac:Party>
    </cac:AccountingSupplierParty>
    <cac:TaxTotal>
        <cbc:TaxAmount currencyID="SAR">15.00</cbc:TaxAmount>
    </cac:TaxTotal>
    <cac:LegalMonetaryTotal>
        <cbc:TaxExclusiveAmount currencyID="SAR">100.00</cbc:TaxExclusiveAmount>
        <cbc:TaxInclusiveAmount currencyID="SAR">115.00</cbc:TaxInclusiveAmount>
    </cac:LegalMonetaryTotal>
</Invoice>
`;
  const hash = invoiceHash(xml);
  return { xml, hash, uuid, body: { invoiceHash: hash, uuid, invoice: b64(xml) } };
}

const basic = (c: { token: string; secret: string }) => `Basic ${b64(`${c.token}:${c.secret}`)}`;

function call(path: string, o: { method?: string; headers?: Record<string, string>; body?: unknown; run?: string | null; instance?: EinvoiceInstance } = {}): Promise<ZatcaAnswer> {
  return svc.handle(project, o.instance ?? inst, {
    method: o.method ?? 'POST',
    path,
    headers: { 'accept-version': 'V2', 'accept-language': 'en', ...(o.headers ?? {}) },
    body: o.body ?? {},
    runId: o.run ?? null,
    logId: null,
  });
}

const bodyOf = (a: ZatcaAnswer) => a.body as Record<string, any>;
const invoiceOf = (a: ZatcaAnswer) => svc.repo.getInvoice(a.resolved.invoiceId!)!;
const chains = () => svc.repo.listChains(project.id, { instanceId: inst.id, scope: 'production' });

let ccsid: { token: string; secret: string; requestID: number };
let pcsid: { token: string; secret: string };
let h1: string;
let h2: string;
let h3: string;

beforeAll(() => {
  db = openDb(':memory:');
  svc = new EinvoiceService({ db, publish: (e) => events.push(e), timeoutHoldMs: 1234 });
  project = new ProjectRepo(db).create({ name: 'Hyper' });
  runId = new RunRepo(db).create(project.id, { key: 'run-1', expiresAt: new Date(Date.now() + 3600_000).toISOString() }).id;
  inst = svc.createInstance(project, { config: { checks: 'basic' } });
});

describe('EinvoiceService (phase 1)', () => {
  it('creates an instance with a fake CA and validates slugs', () => {
    expect(inst).toMatchObject({ slug: 'zatca', preset: 'zatca', name: 'ZATCA Fatoora' });
    expect(inst.config.caKeyPem).toContain('PRIVATE KEY');
    expect(inst.config.caCertPem).toContain('CERTIFICATE');
    expect(svc.viewInstance(inst).config).not.toHaveProperty('caKeyPem');
    expect(() => svc.createInstance(project, { slug: 'Bad Slug' })).toThrow(/slug/);
    expect(() => svc.createInstance(project, { slug: 'zatca' })).toThrow(/already exists/);
    expect(svc.getInstance(project, 'zatca').id).toBe(inst.id);
    expect(events.length).toBeGreaterThan(0);
  });

  it('routes the real /e-invoicing/<env> prefix and answers 404 for unknown paths', async () => {
    const a = await call('/e-invoicing/simulation/nope');
    expect(a.status).toBe(404);
    expect(a.resolved.env).toBe('simulation');
    expect(bodyOf(a).routes).toContain('POST /invoices/reporting/single');
  });

  it('/compliance: OTP check, CSR → CCSID signed by the instance CA', async () => {
    const csr = csrPem();
    expect((await call('/compliance', { body: { csr: b64(csr) } })).status).toBe(400);
    expect(bodyOf(await call('/compliance', { headers: { otp: '12ab56' }, body: { csr: b64(csr) } })).code).toBe('Invalid-OTP');
    expect(bodyOf(await call('/compliance', { headers: { otp: '123456' }, body: { csr: 'bm90IGEgY3Ny' } })).code).toBe('Invalid-CSR');

    const a = await call('/e-invoicing/developer-portal/compliance', { headers: { otp: '123456' }, body: { csr: b64(csr) } });
    expect(a.status).toBe(200);
    const b = bodyOf(a);
    expect(String(b.requestID)).toMatch(/^\d{13}$/);
    expect(b).toMatchObject({ dispositionMessage: 'ISSUED', errors: null });
    const cert = certFromToken(b.binarySecurityToken);
    expect(certIssuedBy(cert, inst.config.caCertPem!)).toBe(true);
    expect(certInfo(cert).egsSerial).toBe(EGS);
    ccsid = { token: b.binarySecurityToken, secret: b.secret, requestID: b.requestID };
    const row = svc.repo.csidByToken(inst.id, ccsid.token)!;
    expect(row).toMatchObject({ kind: 'compliance', vatNumber: VAT, egsSerial: EGS, invoiceTypes: '1100', env: 'developer-portal', lint: [] });
  });

  it('config.otp: only that value or a dashboard OTP', async () => {
    const other = svc.createInstance(project, { slug: 'otp', config: { otp: '111111' } });
    const csr = b64(csrPem());
    expect((await call('/compliance', { instance: other, headers: { otp: '222222' }, body: { csr } })).status).toBe(400);
    expect((await call('/compliance', { instance: other, headers: { otp: '111111' }, body: { csr } })).status).toBe(200);
    const { otp } = svc.issueOtp(other);
    expect((await call('/compliance', { instance: other, headers: { otp }, body: { csr } })).status).toBe(200);
  });

  it('PCSID refused until the compliance checks of every declared kind passed', async () => {
    const a = await call('/production/csids', { headers: { authorization: basic(ccsid) }, body: { compliance_request_id: String(ccsid.requestID) } });
    expect(a.status).toBe(400);
    expect(bodyOf(a)).toMatchObject({ code: 'Missing-ComplianceSteps' });
    expect(bodyOf(a).message).toContain('standard:388');
  });

  it('compliance invoices mark the six kinds on the CCSID', async () => {
    let pih = FIRST_PIH;
    let icv = 1;
    for (const kind of ['standard', 'simplified'] as const) {
      for (const code of ['388', '381', '383']) {
        const inv = ubl({ number: `C-${icv}`, icv, pih, kind, code });
        const a = await call('/compliance/invoices', { headers: { authorization: basic(ccsid) }, body: inv.body });
        expect(a.status).toBe(200);
        const b = bodyOf(a);
        expect(b.validationResults.status).toBe('PASS');
        expect(b.validationResults.infoMessages[0].code).toBe('XSD_ZATCA_VALID');
        if (kind === 'standard') expect(b).toMatchObject({ clearanceStatus: 'CLEARED', reportingStatus: null, qrSellertStatus: null });
        else expect(b).toMatchObject({ reportingStatus: 'REPORTED', clearanceStatus: null });
        expect(invoiceOf(a)).toMatchObject({ status: 'PASS', endpoint: 'compliance_invoices', docType: kind, typeCode: code, icv, lint: [] });
        pih = inv.hash;
        icv++;
      }
    }
    const c = svc.repo.csidByToken(inst.id, ccsid.token)!;
    expect(Object.keys(c.checks).sort()).toEqual(['simplified:381', 'simplified:383', 'simplified:388', 'standard:381', 'standard:383', 'standard:388']);
    const [chain] = svc.repo.listChains(project.id, { scope: 'compliance' });
    expect(chain).toMatchObject({ vatNumber: VAT, egsKey: EGS, count: 6, lastIcv: 6 });
  });

  it('/production/csids issues the PCSID', async () => {
    const a = await call('/production/csids', { headers: { authorization: basic(ccsid) }, body: { compliance_request_id: ccsid.requestID }, run: runId });
    expect(a.status).toBe(200);
    pcsid = { token: bodyOf(a).binarySecurityToken, secret: bodyOf(a).secret };
    const row = svc.repo.csidByToken(inst.id, pcsid.token)!;
    expect(row).toMatchObject({ kind: 'production', runId, status: 'active' });
    expect(row.parentId).toBe(svc.repo.csidByToken(inst.id, ccsid.token)!.id);
  });

  it('reporting a simplified invoice, then the same hash again → 409', async () => {
    const inv = ubl({ number: 'INV-1', icv: 1, pih: FIRST_PIH });
    h1 = inv.hash;
    const a = await call('/invoices/reporting/single', { headers: { authorization: basic(pcsid), 'clearance-status': '0' }, body: inv.body, run: runId });
    expect(a.status).toBe(200);
    expect(bodyOf(a)).toMatchObject({ reportingStatus: 'REPORTED', validationResults: { status: 'PASS' } });
    const row = invoiceOf(a);
    expect(row).toMatchObject({
      status: 'REPORTED', httpStatus: 200, runId, number: 'INV-1', uuid: inv.uuid, icv: 1, pih: FIRST_PIH, invoiceHash: h1, computedHash: h1,
      sellerVat: VAT, sellerName: 'Acme Trading', totalExcl: '100.00', vatTotal: '15.00', totalIncl: '115.00', currency: 'SAR', typeName: '0200000',
      issueAt: '2026-11-26T10:00:00', lint: [],
    });
    expect(row.headers.authorization).toBe('Basic [redacted]');
    expect(chains()[0]).toMatchObject({ count: 1, lastIcv: 1, lastHash: h1 });

    const d = await call('/invoices/reporting/single', { headers: { authorization: basic(pcsid) }, body: inv.body, run: runId });
    expect(d.status).toBe(409);
    expect(bodyOf(d).reportingStatus).toBe('REPORTED');
    expect(invoiceOf(d)).toMatchObject({ status: 'DUPLICATE', duplicateOf: row.id });
    expect(invoiceOf(d).lint.map((l) => l.check)).toContain('einv.duplicate-resubmitted');
    expect(chains()[0].count).toBe(1);
  });

  it('a standard invoice on reporting is rejected with einv.wrong-endpoint', async () => {
    const inv = ubl({ number: 'X-1', icv: 2, pih: h1, kind: 'standard' });
    const a = await call('/invoices/reporting/single', { headers: { authorization: basic(pcsid) }, body: inv.body });
    expect(a.status).toBe(400);
    expect(bodyOf(a).reportingStatus).toBe('NOT_REPORTED');
    expect(invoiceOf(a).lint.map((l) => l.check)).toContain('einv.wrong-endpoint');
    // rejected invoices advance the chain; the retry of the head does not
    expect(chains()[0]).toMatchObject({ count: 2, lastIcv: 2 });
    const retry = await call('/invoices/reporting/single', { headers: { authorization: basic(pcsid) }, body: inv.body });
    expect(retry.status).toBe(400);
    expect(invoiceOf(retry).lint.map((l) => l.check)).not.toContain('einv.icv-repeat');
    expect(chains()[0]).toMatchObject({ count: 2, lastIcv: 2 });
    h1 = inv.hash;
  });

  it('clearance of a standard invoice → CLEARED with a stamped QR, then 208', async () => {
    const inv = ubl({ number: 'INV-3', icv: 3, pih: h1, kind: 'standard' });
    h2 = inv.hash;
    const a = await call('/invoices/clearance/single', { headers: { authorization: basic(pcsid), 'clearance-status': '1' }, body: inv.body });
    expect(a.status).toBe(200);
    const b = bodyOf(a);
    expect(b.clearanceStatus).toBe('CLEARED');
    expect((a.resolved as Record<string, unknown>).stamp).toBe('stubyard-fake');
    const cleared = Buffer.from(b.clearedInvoice, 'base64').toString('utf8');
    expect(invoiceHash(cleared)).toBe(h2);
    const qr = /<cbc:ID>QR<\/cbc:ID>\s*<cac:Attachment>\s*<cbc:EmbeddedDocumentBinaryObject[^>]*>([^<]+)</.exec(cleared)![1];
    const tlv = decodeTlv(qr);
    if (!tlv.ok) throw new Error(tlv.error);
    const tag = (n: number) => tlv.fields.find((f) => f.tag === n)!;
    expect(tag(1).text).toBe('Acme Trading');
    expect(tag(2).text).toBe(VAT);
    expect(tag(4).text).toBe('115.00');
    expect(tag(6).text).toBe(h2);
    expect(tag(8).bytes.equals(certInfo(inst.config.caCertPem!).spkiDer)).toBe(true);
    expect(ecdsaVerify(inst.config.caCertPem!, Buffer.from(h2, 'base64'), tag(7).text)).toBe(true);
    expect(invoiceOf(a).clearedXml).toBe(cleared);
    expect(chains()[0]).toMatchObject({ count: 3, lastIcv: 3 });

    const d = await call('/invoices/clearance/single', { headers: { authorization: basic(pcsid), 'clearance-status': '1' }, body: inv.body });
    expect(d.status).toBe(208);
    expect(bodyOf(d).clearedInvoice).toBe(b.clearedInvoice);
    expect(invoiceOf(d).status).toBe('DUPLICATE');
  });

  it('clearance off → 303; missing Clearance-Status → lint info', async () => {
    inst = svc.updateInstance(project, inst.id, { config: { clearanceEnabled: false } });
    const inv = ubl({ number: 'INV-4', icv: 4, pih: h2, kind: 'standard' });
    const a = await call('/invoices/clearance/single', { headers: { authorization: basic(pcsid) }, body: inv.body });
    expect(a.status).toBe(303);
    expect(chains()[0].count).toBe(3);
    inst = svc.updateInstance(project, inst.id, { config: { clearanceEnabled: true } });
    expect(inst.config.caKeyPem).toBeTruthy();
    const ok = await call('/invoices/clearance/single', { headers: { authorization: basic(pcsid) }, body: inv.body });
    expect(ok.status).toBe(200);
    expect(invoiceOf(ok).lint.map((l) => l.check)).toEqual(['einv.clearance-status-header']);
    h3 = inv.hash;
  });

  it('wrong auth → 401 (CCSID for reporting, unknown token)', async () => {
    const inv = ubl({ number: 'INV-5', icv: 5, pih: h3 });
    const a = await call('/invoices/reporting/single', { headers: { authorization: basic(ccsid) }, body: inv.body });
    expect(a.status).toBe(401);
    expect(bodyOf(a)).toMatchObject({ status: 401, error: 'Unauthorized', message: '' });
    expect(invoiceOf(a).lint.map((l) => l.check)).toContain('einv.ccsid-in-production');
    const u = await call('/invoices/reporting/single', { headers: { authorization: basic({ token: 'bm9wZQ==', secret: 'x' }) }, body: inv.body });
    expect(u.status).toBe(401);
    expect(invoiceOf(u).lint.map((l) => l.check)).toContain('einv.unknown-csid');
    const s = await call('/invoices/reporting/single', { headers: { authorization: basic({ token: pcsid.token, secret: 'wrong' }) }, body: inv.body });
    expect(s.status).toBe(401);
    expect(chains()[0].count).toBe(4);
  });

  it('missing Accept-Version → 406 + lint', async () => {
    const inv = ubl({ number: 'INV-5', icv: 5, pih: h3 });
    const a = await svc.handle(project, inst, { method: 'POST', path: '/invoices/reporting/single', headers: { authorization: basic(pcsid) }, body: inv.body, runId: null, logId: null });
    expect(a.status).toBe(406);
    expect(bodyOf(a).message).toMatch(/Accept-Version/);
    expect(invoiceOf(a).lint.map((l) => l.check)).toEqual(['einv.accept-version-missing']);
  });

  it('faults: reject, server_error, timeout and a run rule; the chain does not advance', async () => {
    const inv = ubl({ number: 'INV-5', icv: 5, pih: h3 });
    const auth = { authorization: basic(pcsid) };
    const r = await call('/invoices/reporting/single', { headers: { ...auth, 'x-hub-scenario': 'reject' }, body: inv.body });
    expect(r.status).toBe(400);
    expect(bodyOf(r)).toMatchObject({ reportingStatus: 'NOT_REPORTED' });
    expect(bodyOf(r).validationResults.errorMessages[0].code).toBe('BR-KSA-26');
    expect(invoiceOf(r)).toMatchObject({ status: 'FAULT', fault: 'reject', number: 'INV-5' });

    const s = await call('/invoices/reporting/single', { headers: { ...auth, 'x-hub-scenario': 'server_error' }, body: inv.body });
    expect(s.status).toBe(500);
    expect(bodyOf(s)).toEqual({ category: 'HTTP-Errors', code: '500', message: 'Internal Server Error' });

    const t = await call('/invoices/reporting/single', { headers: { ...auth, 'x-hub-scenario': 'timeout' }, body: inv.body });
    expect(t).toMatchObject({ holdMs: 1234, close: true });
    expect(invoiceOf(t).status).toBe('FAULT');

    const rl = await call('/invoices/reporting/single', { headers: { ...auth, 'x-hub-scenario': 'rate_limited:5' }, body: inv.body });
    expect(rl.status).toBe(429);
    expect(rl.headers['retry-after']).toBe('5');

    svc.repo.insertRule({ projectId: project.id, runId: null, instanceId: inst.id, match: { endpoint: 'reporting' }, fault: 'gateway_timeout', remaining: 1 });
    svc.repo.insertRule({ projectId: project.id, runId, instanceId: null, match: { number: 'INV-5' }, fault: 'unavailable', remaining: 1 });
    expect((await call('/invoices/reporting/single', { headers: auth, body: inv.body, run: runId })).status).toBe(503);
    expect((await call('/invoices/reporting/single', { headers: auth, body: inv.body, run: runId })).status).toBe(504);
    expect(chains()[0]).toMatchObject({ count: 4, lastIcv: 4, lastHash: h3 });

    const w = await call('/invoices/reporting/single', { headers: { ...auth, 'x-hub-scenario': 'slow:20' }, body: inv.body });
    expect(w.status).toBe(200);
    expect(w.holdMs).toBe(20);
    expect(invoiceOf(w)).toMatchObject({ status: 'REPORTED', fault: 'slow:20', lint: [] });
    expect(chains()[0]).toMatchObject({ count: 5, lastIcv: 5 });
    h3 = inv.hash;
  });

  it('PIH mismatch lint names both invoices', async () => {
    const inv = ubl({ number: 'INV-6', icv: 6, pih: 'd3Jvbmc=' });
    const a = await call('/invoices/reporting/single', { headers: { authorization: basic(pcsid) }, body: inv.body });
    expect(a.status).toBe(200);
    const lint = invoiceOf(a).lint.find((l) => l.check === 'einv.pih-mismatch')!;
    expect(lint.message).toBe(`PIH of invoice INV-6 (ICV 6) is not the hash of invoice INV-5 (ICV 5): expected ${h3}, got d3Jvbmc=`);
    expect(invoiceOf(a).lintLevel).toBe('error');

    const gap = ubl({ number: 'INV-9', icv: 9, pih: inv.hash });
    const g = await call('/invoices/reporting/single', { headers: { authorization: basic(pcsid) }, body: gap.body });
    expect(invoiceOf(g).lint.map((l) => l.check)).toEqual(['einv.icv-gap']);
    h3 = gap.hash;
  });

  it("chainCheck 'error' adds a stubyard-chain error", async () => {
    inst = svc.updateInstance(project, inst.id, { config: { chainCheck: 'error' } });
    const inv = ubl({ number: 'INV-10', icv: 10, pih: FIRST_PIH });
    const a = await call('/invoices/reporting/single', { headers: { authorization: basic(pcsid) }, body: inv.body });
    expect(a.status).toBe(400);
    expect(bodyOf(a).validationResults.errorMessages.map((m: { code: string }) => m.code)).toEqual(['stubyard-chain']);
    inst = svc.updateInstance(project, inst.id, { config: { chainCheck: 'lint' } });
    h3 = inv.hash;
  });

  it('hash and uuid checks; einv.hash-variant names the wrong method', async () => {
    const inv = ubl({ number: 'INV-11', icv: 11, pih: h3 });
    const hex = hashVariants(inv.xml).find((v) => v.variant === 'hex-digest')!.hash;
    const a = await call('/invoices/reporting/single', { headers: { authorization: basic(pcsid) }, body: { ...inv.body, invoiceHash: hex, uuid: randomUUID() } });
    expect(a.status).toBe(400);
    const codes = bodyOf(a).validationResults.errorMessages.map((m: { code: string }) => m.code);
    expect(codes).toEqual(['invalid-uuid', 'invalid-invoice-hash']);
    expect(invoiceOf(a).lint.find((l) => l.check === 'einv.hash-variant')!.message).toContain('hex-digest');

    const bad = await call('/invoices/reporting/single', { headers: { authorization: basic(pcsid) }, body: { invoiceHash: 'x', uuid: 'y', invoice: b64('<Invoice') } });
    expect(bad.status).toBe(400);
    expect(bodyOf(bad).validationResults.errorMessages[0].code).toBe('XSD_ZATCA_INVALID');
    expect(bodyOf(bad).validationResults.infoMessages).toEqual([]);
    h3 = inv.hash;
  });

  it('renewal: new PCSID, the old one superseded, the chain survives', async () => {
    const before = chains();
    const a = await call('/production/csids', { method: 'PATCH', headers: { authorization: basic(pcsid), otp: '654321' }, body: { csr: b64(csrPem()) } });
    expect(a.status).toBe(200);
    const old = svc.repo.csidByToken(inst.id, pcsid.token)!;
    expect(old.status).toBe('superseded');
    const next = { token: bodyOf(a).binarySecurityToken, secret: bodyOf(a).secret };
    expect(svc.repo.csidByToken(inst.id, next.token)!.parentId).toBe(old.id);
    expect((await call('/invoices/reporting/single', { headers: { authorization: basic(pcsid) }, body: ubl({ number: 'INV-12', icv: 12, pih: h3 }).body })).status).toBe(401);
    const r = await call('/invoices/reporting/single', { headers: { authorization: basic(next) }, body: ubl({ number: 'INV-12', icv: 12, pih: h3 }).body });
    expect(r.status).toBe(200);
    expect(invoiceOf(r).lint).toEqual([]);
    expect(chains()).toHaveLength(1);
    expect(chains()[0]).toMatchObject({ id: before[0].id, lastIcv: 12 });
  });

  it('countsForRun, purgeRun and resetProject', () => {
    const c = svc.countsForRun(runId);
    expect(c.byStatus).toEqual({ REPORTED: 1, DUPLICATE: 1, FAULT: 2 });
    expect(c.invoices).toBe(4);
    svc.purgeRun(runId);
    expect(svc.countsForRun(runId).invoices).toBe(0);
    expect(svc.repo.csidByToken(inst.id, pcsid.token)).toBeNull();
    const n = events.length;
    svc.resetProject(project.id);
    expect(events.length).toBe(n + 1);
    expect(events.at(-1)).toMatchObject({ type: 'einvoice.changed', projectId: project.id });
    expect(svc.repo.listInvoices(project.id)).toHaveLength(0);
    expect(svc.repo.listChains(project.id)).toHaveLength(0);
  });
});
