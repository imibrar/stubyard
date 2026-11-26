import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db/index.js';
import { EinvoiceRepo, type InvoiceInsert } from '../src/einvoice/repo.js';
import { ZATCA_CONFIG_DEFAULTS, zatcaConfig, type EinvoiceInstance } from '../src/einvoice/types.js';
import { ProjectRepo } from '../src/repos/projects.js';
import { RunRepo } from '../src/repos/runs.js';
import { HttpError } from '../src/util.js';

let db: DB;
let repo: EinvoiceRepo;
let projectId: string;
let inst: EinvoiceInstance;

const future = () => new Date(Date.now() + 3600_000).toISOString();

function invoice(p: Partial<InvoiceInsert> = {}): InvoiceInsert {
  return {
    projectId, instanceId: inst.id, runId: null, csidId: null, chainId: null, endpoint: 'reporting', docType: 'simplified',
    typeCode: '388', typeName: '0200000', number: 'INV-1', uuid: 'u-1', icv: 1, pih: 'pih', invoiceHash: 'h1', computedHash: 'h1',
    issueAt: '2026-11-26T10:00:00', sellerVat: '399999999900003', sellerName: 'Acme Trading', buyerName: null, buyerVat: null,
    currency: 'SAR', totalExcl: '100.00', vatTotal: '15.00', totalIncl: '115.00', status: 'REPORTED', httpStatus: 200,
    validation: null, lint: [], lintLevel: null, fault: null, duplicateOf: null, xml: '<Invoice/>', clearedXml: null, headers: {}, logId: null,
    ...p,
  };
}

function csid(p: Record<string, unknown> = {}) {
  return repo.insertCsid({
    projectId, instanceId: inst.id, runId: null, kind: 'compliance', requestId: '1234567890123', parentId: null, token: 'tok-1',
    secretHash: 'sh', secret: 's3cret', certPem: 'CERT', csrPem: 'CSR', commonName: 'TST-886431145-399999999900003',
    vatNumber: '399999999900003', egsSerial: '1-TST|2-TST|3-ed22f1d8', orgUnit: 'Riyadh', invoiceTypes: '1100', env: 'developer-portal',
    expiresAt: null, ...p,
  });
}

beforeEach(() => {
  db = openDb(':memory:');
  repo = new EinvoiceRepo(db);
  projectId = new ProjectRepo(db).create({ name: 'Hyper' }).id;
  inst = repo.insertInstance({ projectId, slug: 'zatca', name: 'ZATCA', config: zatcaConfig({}) });
});

describe('zatcaConfig', () => {
  it('fills defaults, keeps prev values and validates', () => {
    expect(zatcaConfig(undefined)).toEqual(ZATCA_CONFIG_DEFAULTS);
    const c = zatcaConfig({ env: 'simulation', otp: '123456', checks: 'basic', chainCheck: 'error', reportingWindowHours: '48', junk: 1 });
    expect(c).toMatchObject({ env: 'simulation', otp: '123456', checks: 'basic', chainCheck: 'error', reportingWindowHours: 48, strictAuth: true });
    expect(c).not.toHaveProperty('junk');
    expect(zatcaConfig({ strictAuth: false }, c)).toMatchObject({ env: 'simulation', strictAuth: false });
    expect(zatcaConfig({ otp: null }, c).otp).toBe('');
    for (const bad of [{ env: 'prod' }, { otp: '12345' }, { strictCsr: 'yes' }, { checks: 'all' }, { chainCheck: 'warn' }, { reportingWindowHours: 0 }, { caKeyPem: 'x' }]) {
      expect(() => zatcaConfig(bad)).toThrow(HttpError);
    }
    expect(() => zatcaConfig([] as never)).toThrow(/object/);
  });
});

describe('instances', () => {
  it('CRUD with a unique slug per project', () => {
    expect(inst).toMatchObject({ slug: 'zatca', preset: 'zatca', enabled: true, config: ZATCA_CONFIG_DEFAULTS });
    expect(() => repo.insertInstance({ projectId, slug: 'zatca', name: 'Dup', config: zatcaConfig({}) })).toThrow(/already exists/);
    const other = new ProjectRepo(db).create({ name: 'Other' }).id;
    expect(() => repo.insertInstance({ projectId: other, slug: 'zatca', name: 'Z', config: zatcaConfig({}) })).not.toThrow();
    const b = repo.insertInstance({ projectId, slug: 'second', name: 'B', config: zatcaConfig({ env: 'core' }), enabled: false });
    expect(b.enabled).toBe(false);
    expect(repo.listInstances(projectId).map((i) => i.slug)).toEqual(['zatca', 'second']);
    expect(repo.instanceBySlug(projectId, 'second')?.id).toBe(b.id);
    expect(() => repo.updateInstance(b.id, { slug: 'zatca' })).toThrow(/already exists/);
    const u = repo.updateInstance(b.id, { name: 'Renamed', enabled: true, config: zatcaConfig({ clearanceEnabled: false }, b.config) });
    expect(u).toMatchObject({ name: 'Renamed', enabled: true, config: { env: 'core', clearanceEnabled: false } });
    repo.deleteInstance(b.id);
    expect(repo.getInstance(b.id)).toBeNull();
  });

  it('deleting an instance cascades to its rows', () => {
    csid();
    repo.insertInvoice(invoice());
    repo.chainFor({ projectId, instanceId: inst.id, scope: 'production', vatNumber: 'v', egsKey: 'e' });
    repo.insertRule({ projectId, runId: null, instanceId: inst.id, match: {}, fault: 'reject', remaining: null });
    repo.deleteInstance(inst.id);
    const n = db.prepare('SELECT (SELECT COUNT(*) FROM einvoice_csids) c, (SELECT COUNT(*) FROM einvoices) i, (SELECT COUNT(*) FROM einvoice_chains) ch, (SELECT COUNT(*) FROM einvoice_rules) r').get();
    expect(n).toEqual({ c: 0, i: 0, ch: 0, r: 0 });
  });
});

describe('CSIDs', () => {
  it('inserts, looks up by token and request id, updates and marks checks', () => {
    const c = csid();
    expect(c).toMatchObject({ kind: 'compliance', status: 'active', checks: {}, lint: [], token: 'tok-1' });
    const p = csid({ kind: 'production', parentId: c.id, token: 'tok-2', requestId: '9999999999999' });
    expect(repo.csidByToken(inst.id, 'tok-2')?.id).toBe(p.id);
    expect(repo.csidByToken(inst.id, 'nope')).toBeNull();
    expect(repo.csidByRequestId(inst.id, '1234567890123')?.id).toBe(c.id);
    expect(repo.csidByRequestId(inst.id, '1234567890123', 'production')).toBeNull();
    expect(repo.listCsids(projectId, { kind: 'production' }).map((x) => x.id)).toEqual([p.id]);
    expect(repo.listCsids(projectId).map((x) => x.id)).toEqual([p.id, c.id]);

    const m1 = repo.markCheck(c.id, 'simplified:388', '2026-11-26T10:00:00.000Z');
    repo.markCheck(c.id, 'simplified:388', '2026-11-27T10:00:00.000Z');
    const m2 = repo.markCheck(c.id, 'standard:381', '2026-11-26T11:00:00.000Z');
    expect(m1.checks).toEqual({ 'simplified:388': '2026-11-26T10:00:00.000Z' });
    expect(m2.checks).toEqual({ 'simplified:388': '2026-11-26T10:00:00.000Z', 'standard:381': '2026-11-26T11:00:00.000Z' });

    const u = repo.updateCsid(c.id, { status: 'superseded', lint: [{ check: 'einv.csr', severity: 'warn', message: 'm' }], expiresAt: '2027-01-01T00:00:00.000Z' });
    expect(u).toMatchObject({ status: 'superseded', expiresAt: '2027-01-01T00:00:00.000Z', lint: [{ severity: 'warn' }] });
    expect(repo.listCsids(projectId, { status: 'active' }).map((x) => x.id)).toEqual([p.id]);
    repo.deleteCsid(p.id);
    expect(repo.getCsid(p.id)).toBeNull();
  });
});

describe('chains', () => {
  it('get-or-create, advance and reset', () => {
    const key = { projectId, instanceId: inst.id, scope: 'production' as const, vatNumber: '399999999900003', egsKey: 'egs-1' };
    const c = repo.chainFor({ ...key, sellerName: 'Acme' });
    expect(c).toMatchObject({ lastIcv: null, lastHash: null, lastInvoiceId: null, count: 0, sellerName: 'Acme' });
    expect(repo.chainFor(key).id).toBe(c.id);
    expect(repo.chainFor(key).sellerName).toBe('Acme');
    expect(repo.chainFor({ ...key, sellerName: 'Acme 2' }).sellerName).toBe('Acme 2');
    const comp = repo.chainFor({ ...key, scope: 'compliance' });
    expect(comp.id).not.toBe(c.id);

    const i1 = repo.insertInvoice(invoice({ chainId: c.id }));
    repo.advanceChain(c.id, 1, 'h1', i1.id);
    const a2 = repo.advanceChain(c.id, 2, 'h2', 'inv-2');
    expect(a2).toMatchObject({ lastIcv: 2, lastHash: 'h2', lastInvoiceId: 'inv-2', count: 2 });
    expect(repo.findChain(inst.id, 'production', key.vatNumber, 'egs-1')?.count).toBe(2);
    expect(repo.listChains(projectId, { scope: 'production' }).map((x) => x.id)).toEqual([c.id]);
    expect(repo.listChains(projectId, { instanceId: inst.id })).toHaveLength(2);

    expect(repo.resetChain(c.id)).toMatchObject({ lastIcv: null, lastHash: null, lastInvoiceId: null, count: 0 });
    expect(repo.deleteChains(projectId, inst.id)).toBe(2);
    expect(repo.getChain(c.id)).toBeNull();
  });
});

describe('invoices', () => {
  it('round-trips every column with JSON parsed', () => {
    const v = { infoMessages: [], warningMessages: [], errorMessages: [], status: 'PASS' as const };
    const lint = [{ check: 'BR-KSA-08', severity: 'warn' as const, message: 'w' }];
    const i = repo.insertInvoice(invoice({ validation: v, lint, lintLevel: 'warn', headers: { 'accept-version': 'V2' } }));
    const got = repo.getInvoice(i.id)!;
    expect(got).toMatchObject({ ...invoice(), validation: v, lint, lintLevel: 'warn', headers: { 'accept-version': 'V2' } });
    expect(got.lint).toHaveLength(1);
    expect(repo.getInvoice(repo.insertInvoice(invoice()).id)!.validation).toBeNull();
    const u = repo.updateInvoice(i.id, { clearedXml: '<Cleared/>', duplicateOf: 'x', logId: 'log' });
    expect(u).toMatchObject({ clearedXml: '<Cleared/>', duplicateOf: 'x', logId: 'log' });
  });

  it('lists with filters and an id cursor', () => {
    const run = new RunRepo(db).create(projectId, { key: 'r1', expiresAt: future() });
    const a = repo.insertInvoice(invoice({ number: 'A', endpoint: 'reporting' }));
    const b = repo.insertInvoice(invoice({ number: 'B', endpoint: 'clearance', docType: 'standard', status: 'CLEARED', runId: run.id }));
    const c = repo.insertInvoice(invoice({ number: 'C', status: 'NOT_REPORTED', sellerVat: '311111111100003', sellerName: 'Other Co' }));
    const ids = (f: Parameters<EinvoiceRepo['listInvoices']>[1]) => repo.listInvoices(projectId, f).map((x) => x.number);
    expect(ids({})).toEqual(['C', 'B', 'A']);
    expect(ids({ asc: true })).toEqual(['A', 'B', 'C']);
    expect(ids({ endpoint: 'clearance' })).toEqual(['B']);
    expect(ids({ status: ['REPORTED', 'NOT_REPORTED'] })).toEqual(['C', 'A']);
    expect(ids({ docType: 'standard' })).toEqual(['B']);
    expect(ids({ seller: '311111111100003' })).toEqual(['C']);
    expect(ids({ seller: 'other' })).toEqual(['C']);
    expect(ids({ number: 'A' })).toEqual(['A']);
    expect(ids({ runId: run.id })).toEqual(['B']);
    expect(ids({ after: a.id, asc: true })).toEqual(['B', 'C']);
    expect(ids({ limit: 1 })).toEqual(['C']);
    expect(ids({ instanceId: inst.id })).toHaveLength(3);
    expect(ids({ since: '2999-01-01T00:00:00.000Z' })).toEqual([]);

    expect(repo.deleteInvoices(projectId, { runId: run.id })).toBe(1);
    expect(repo.getInvoice(b.id)).toBeNull();
    expect(repo.deleteOlderThan(projectId, '2000-01-01T00:00:00.000Z')).toBe(0);
    expect(repo.deleteInvoices(projectId)).toBe(2);
    expect(repo.getInvoice(c.id)).toBeNull();
  });

  it('finds an earlier submission by hash within the window', () => {
    const first = repo.insertInvoice(invoice({ invoiceHash: 'H', status: 'NOT_REPORTED' }));
    repo.insertInvoice(invoice({ invoiceHash: 'H', status: 'FAULT', fault: 'server_error', httpStatus: 500 }));
    repo.insertInvoice(invoice({ invoiceHash: 'H', status: 'DUPLICATE', httpStatus: 409, duplicateOf: first.id }));
    const past = new Date(Date.now() - 3600_000).toISOString();
    expect(repo.findByHash(inst.id, 'H', past)?.id).toBe(first.id);
    expect(repo.findByHash(inst.id, 'H', past, ['REPORTED', 'CLEARED'])).toBeNull();
    expect(repo.findByHash(inst.id, 'H', new Date(Date.now() + 60_000).toISOString())).toBeNull();
    expect(repo.findByHash(inst.id, 'other', past)).toBeNull();
    const ok = repo.insertInvoice(invoice({ invoiceHash: 'H', status: 'REPORTED' }));
    expect(repo.findByHash(inst.id, 'H', past, ['REPORTED', 'CLEARED'])?.id).toBe(ok.id);
    // Old rows fall out of the window.
    db.prepare("UPDATE einvoices SET created_at = '2020-01-01T00:00:00.000Z'").run();
    expect(repo.findByHash(inst.id, 'H', past)).toBeNull();
  });
});

describe('rules', () => {
  it('lists run rules first, consumes hits and deletes', () => {
    const run = new RunRepo(db).create(projectId, { key: 'r1', expiresAt: future() });
    const p = repo.insertRule({ projectId, runId: null, instanceId: null, match: { endpoint: 'reporting' }, fault: 'reject:BR-KSA-26', remaining: null });
    const r = repo.insertRule({ projectId, runId: run.id, instanceId: inst.id, match: { number: 'INV-1', docType: 'simplified' }, fault: 'server_error', remaining: 2 });
    expect(repo.listRules(projectId).map((x) => x.id)).toEqual([r.id, p.id]);
    expect(repo.listRules(projectId, { runId: run.id }).map((x) => x.id)).toEqual([r.id]);
    expect(repo.listRules(projectId, { instanceId: 'other' }).map((x) => x.id)).toEqual([p.id]);
    expect(repo.getRule(r.id)?.match).toEqual({ number: 'INV-1', docType: 'simplified' });

    expect(repo.consumeRule(r.id)).toBe(true);
    expect(repo.consumeRule(r.id)).toBe(true);
    expect(repo.consumeRule(r.id)).toBe(false);
    expect(repo.getRule(r.id)).toMatchObject({ remaining: 0, hits: 2 });
    for (let i = 0; i < 3; i++) expect(repo.consumeRule(p.id)).toBe(true);
    expect(repo.getRule(p.id)).toMatchObject({ remaining: null, hits: 3 });

    expect(repo.deleteRules(projectId, run.id)).toBe(1);
    expect(repo.deleteRules(projectId)).toBe(1);
    const q = repo.insertRule({ projectId, runId: null, instanceId: null, match: {}, fault: 'none', remaining: 1 });
    repo.deleteRule(q.id);
    expect(repo.getRule(q.id)).toBeNull();
  });
});

describe('runs and reset', () => {
  it('counts per run, purges a run and resets a project', () => {
    const runs = new RunRepo(db);
    const run = runs.create(projectId, { key: 'r1', expiresAt: future() });
    const err = { check: 'BR-KSA-26', severity: 'error' as const, message: 'e' };
    const warn = { check: 'BR-KSA-08', severity: 'warn' as const, message: 'w' };
    repo.insertInvoice(invoice({ runId: run.id, status: 'REPORTED', lint: [warn] }));
    repo.insertInvoice(invoice({ runId: run.id, status: 'NOT_REPORTED', lint: [err, err, warn] }));
    repo.insertInvoice(invoice({ runId: run.id, status: 'NOT_REPORTED', lint: [err] }));
    repo.insertInvoice(invoice({ status: 'REPORTED', lint: [err] }));
    const runCsid = csid({ runId: run.id, lint: [err] });
    const keep = csid({ token: 'tok-keep' });
    const rule = repo.insertRule({ projectId, runId: run.id, instanceId: null, match: {}, fault: 'reject', remaining: null });
    const prule = repo.insertRule({ projectId, runId: null, instanceId: null, match: {}, fault: 'warning', remaining: null });
    repo.consumeRule(prule.id);

    expect(repo.countsForRun(run.id)).toEqual({ invoices: 3, byStatus: { REPORTED: 1, NOT_REPORTED: 2 }, lintErrors: 3, csidLintErrors: 1 });
    expect(repo.countsForRun('none')).toEqual({ invoices: 0, byStatus: {}, lintErrors: 0, csidLintErrors: 0 });

    repo.purgeRun(run.id);
    expect(repo.countsForRun(run.id).invoices).toBe(0);
    expect(repo.getCsid(runCsid.id)).toBeNull();
    expect(repo.getRule(rule.id)).toBeNull();
    expect(repo.listInvoices(projectId)).toHaveLength(1);

    const run2 = runs.create(projectId, { key: 'r2', expiresAt: future() });
    const runCsid2 = csid({ runId: run2.id, token: 'tok-r2' });
    repo.chainFor({ projectId, instanceId: inst.id, scope: 'production', vatNumber: 'v', egsKey: 'e' });
    repo.resetProject(projectId);
    expect(repo.listInvoices(projectId)).toHaveLength(0);
    expect(repo.listChains(projectId)).toHaveLength(0);
    expect(repo.getCsid(runCsid2.id)).toBeNull();
    expect(repo.getCsid(keep.id)).not.toBeNull();
    expect(repo.getRule(prule.id)?.hits).toBe(0);
  });
});
