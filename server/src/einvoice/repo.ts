import type { DB } from '../db/index.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import type { EinvoiceLintFinding } from './lint.js';
import type { ValidationResults } from './zatca/responses.js';
import {
  ZATCA_CONFIG_DEFAULTS,
  type Chain,
  type ChainScope,
  type Csid,
  type CsidStatus,
  type DocKind,
  type Einvoice,
  type EinvoiceInstance,
  type EinvoiceRule,
  type EinvoiceRunCounts,
  type EinvoiceStatus,
} from './types.js';

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function toInstance(r: Row): EinvoiceInstance {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    slug: String(r.slug),
    preset: r.preset as EinvoiceInstance['preset'],
    name: String(r.name),
    config: { ...ZATCA_CONFIG_DEFAULTS, ...parseJson(r.config as string, {}) },
    enabled: !!r.enabled,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function toCsid(r: Row): Csid {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    instanceId: String(r.instance_id),
    runId: str(r.run_id),
    kind: r.kind as Csid['kind'],
    requestId: String(r.request_id),
    parentId: str(r.parent_id),
    token: String(r.token),
    secretHash: String(r.secret_hash),
    secret: String(r.secret),
    certPem: String(r.cert_pem),
    csrPem: String(r.csr_pem),
    commonName: str(r.common_name),
    vatNumber: str(r.vat_number),
    egsSerial: str(r.egs_serial),
    orgUnit: str(r.org_unit),
    invoiceTypes: str(r.invoice_types),
    env: str(r.env),
    checks: parseJson(r.checks as string, {}),
    status: r.status as CsidStatus,
    lint: parseJson(r.lint as string, [] as EinvoiceLintFinding[]),
    expiresAt: str(r.expires_at),
    createdAt: String(r.created_at),
  };
}

function toChain(r: Row): Chain {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    instanceId: String(r.instance_id),
    scope: r.scope as ChainScope,
    vatNumber: String(r.vat_number),
    egsKey: String(r.egs_key),
    sellerName: str(r.seller_name),
    lastIcv: num(r.last_icv),
    lastHash: str(r.last_hash),
    lastInvoiceId: str(r.last_invoice_id),
    count: Number(r.count ?? 0),
    updatedAt: String(r.updated_at),
  };
}

function toInvoice(r: Row): Einvoice {
  const validation = parseJson<ValidationResults | null>(r.validation as string, null);
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    instanceId: String(r.instance_id),
    runId: str(r.run_id),
    csidId: str(r.csid_id),
    chainId: str(r.chain_id),
    endpoint: r.endpoint as Einvoice['endpoint'],
    docType: str(r.doc_type) as Einvoice['docType'],
    typeCode: str(r.type_code),
    typeName: str(r.type_name),
    number: str(r.number),
    uuid: str(r.uuid),
    icv: num(r.icv),
    pih: str(r.pih),
    invoiceHash: str(r.invoice_hash),
    computedHash: str(r.computed_hash),
    issueAt: str(r.issue_at),
    sellerVat: str(r.seller_vat),
    sellerName: str(r.seller_name),
    buyerName: str(r.buyer_name),
    buyerVat: str(r.buyer_vat),
    currency: str(r.currency),
    totalExcl: str(r.total_excl),
    vatTotal: str(r.vat_total),
    totalIncl: str(r.total_incl),
    status: r.status as EinvoiceStatus,
    httpStatus: Number(r.http_status),
    validation: validation && validation.status ? validation : null,
    lint: parseJson(r.lint as string, [] as EinvoiceLintFinding[]),
    lintLevel: str(r.lint_level) as Einvoice['lintLevel'],
    fault: str(r.fault),
    duplicateOf: str(r.duplicate_of),
    xml: str(r.xml),
    clearedXml: str(r.cleared_xml),
    headers: parseJson(r.headers as string, {}),
    logId: str(r.log_id),
    createdAt: String(r.created_at),
  };
}

function toRule(r: Row): EinvoiceRule {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    runId: str(r.run_id),
    instanceId: str(r.instance_id),
    match: parseJson(r.match as string, {}),
    fault: String(r.fault),
    remaining: num(r.remaining),
    hits: Number(r.hits ?? 0),
    createdAt: String(r.created_at),
  };
}

export interface InvoiceFilter {
  instanceId?: string;
  endpoint?: string;
  status?: string[];
  docType?: string;
  /** Seller VAT number, or part of the seller name. */
  seller?: string;
  number?: string;
  runId?: string | null;
  /** Id cursor: rows created after this invoice (compared by rowid). */
  after?: string;
  since?: string;
  limit?: number;
  /** Oldest first (wait) instead of newest first. */
  asc?: boolean;
}

export type InvoiceInsert = Omit<Einvoice, 'id' | 'createdAt'>;
export type CsidInsert = Omit<Csid, 'id' | 'createdAt' | 'checks' | 'status' | 'lint'> & Partial<Pick<Csid, 'checks' | 'status' | 'lint'>>;

const INVOICE_COLS: [keyof InvoiceInsert, string][] = [
  ['projectId', 'project_id'], ['instanceId', 'instance_id'], ['runId', 'run_id'], ['csidId', 'csid_id'], ['chainId', 'chain_id'],
  ['endpoint', 'endpoint'], ['docType', 'doc_type'], ['typeCode', 'type_code'], ['typeName', 'type_name'], ['number', 'number'],
  ['uuid', 'uuid'], ['icv', 'icv'], ['pih', 'pih'], ['invoiceHash', 'invoice_hash'], ['computedHash', 'computed_hash'],
  ['issueAt', 'issue_at'], ['sellerVat', 'seller_vat'], ['sellerName', 'seller_name'], ['buyerName', 'buyer_name'],
  ['buyerVat', 'buyer_vat'], ['currency', 'currency'], ['totalExcl', 'total_excl'], ['vatTotal', 'vat_total'],
  ['totalIncl', 'total_incl'], ['status', 'status'], ['httpStatus', 'http_status'], ['validation', 'validation'], ['lint', 'lint'],
  ['lintLevel', 'lint_level'], ['fault', 'fault'], ['duplicateOf', 'duplicate_of'], ['xml', 'xml'], ['clearedXml', 'cleared_xml'],
  ['headers', 'headers'], ['logId', 'log_id'],
];
const JSON_DEFAULTS: Partial<Record<keyof InvoiceInsert, unknown>> = { validation: {}, lint: [], headers: {} };

/** SQL access for einvoice_instances, einvoice_csids, einvoice_chains, einvoices and einvoice_rules (migration 35). */
export class EinvoiceRepo {
  constructor(private db: DB) {}

  // ---------------- instances
  listInstances(projectId: string): EinvoiceInstance[] {
    return (this.db.prepare('SELECT * FROM einvoice_instances WHERE project_id = ? ORDER BY created_at, slug').all(projectId) as Row[]).map(toInstance);
  }
  getInstance(id: string): EinvoiceInstance | null {
    const r = this.db.prepare('SELECT * FROM einvoice_instances WHERE id = ?').get(id) as Row | undefined;
    return r ? toInstance(r) : null;
  }
  instanceBySlug(projectId: string, slug: string): EinvoiceInstance | null {
    const r = this.db.prepare('SELECT * FROM einvoice_instances WHERE project_id = ? AND slug = ?').get(projectId, slug) as Row | undefined;
    return r ? toInstance(r) : null;
  }
  insertInstance(i: Pick<EinvoiceInstance, 'projectId' | 'slug' | 'name' | 'config'> & Partial<Pick<EinvoiceInstance, 'preset' | 'enabled'>>): EinvoiceInstance {
    if (this.instanceBySlug(i.projectId, i.slug)) throw new HttpError(409, `E-invoicing instance "${i.slug}" already exists`);
    const id = newId();
    const now = nowIso();
    this.db
      .prepare('INSERT INTO einvoice_instances (id, project_id, slug, preset, name, config, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, i.projectId, i.slug, i.preset ?? 'zatca', i.name, JSON.stringify(i.config), i.enabled === false ? 0 : 1, now, now);
    return this.getInstance(id)!;
  }
  updateInstance(id: string, p: Partial<Pick<EinvoiceInstance, 'name' | 'slug' | 'config' | 'enabled'>>): EinvoiceInstance {
    const cur = this.getInstance(id)!;
    if (p.slug !== undefined && p.slug !== cur.slug && this.instanceBySlug(cur.projectId, p.slug)) throw new HttpError(409, `E-invoicing instance "${p.slug}" already exists`);
    const n = { ...cur, ...p };
    this.db
      .prepare('UPDATE einvoice_instances SET name = ?, slug = ?, config = ?, enabled = ?, updated_at = ? WHERE id = ?')
      .run(n.name, n.slug, JSON.stringify(n.config), n.enabled ? 1 : 0, nowIso(), id);
    return this.getInstance(id)!;
  }
  /** Cascades to the instance's CSIDs, chains, invoices and rules. */
  deleteInstance(id: string): void {
    this.db.prepare('DELETE FROM einvoice_instances WHERE id = ?').run(id);
  }

  // ---------------- CSIDs
  insertCsid(c: CsidInsert): Csid {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO einvoice_csids (id, project_id, instance_id, run_id, kind, request_id, parent_id, token, secret_hash, secret, cert_pem, csr_pem,
          common_name, vat_number, egs_serial, org_unit, invoice_types, env, checks, status, lint, expires_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, c.projectId, c.instanceId, c.runId, c.kind, c.requestId, c.parentId, c.token, c.secretHash, c.secret, c.certPem, c.csrPem,
        c.commonName, c.vatNumber, c.egsSerial, c.orgUnit, c.invoiceTypes, c.env, JSON.stringify(c.checks ?? {}), c.status ?? 'active',
        JSON.stringify(c.lint ?? []), c.expiresAt, nowIso(),
      );
    return this.getCsid(id)!;
  }
  getCsid(id: string): Csid | null {
    const r = this.db.prepare('SELECT * FROM einvoice_csids WHERE id = ?').get(id) as Row | undefined;
    return r ? toCsid(r) : null;
  }
  /** The newest CSID of the instance with this binarySecurityToken (any status: the caller checks it). */
  csidByToken(instanceId: string, token: string): Csid | null {
    const r = this.db.prepare('SELECT * FROM einvoice_csids WHERE instance_id = ? AND token = ? ORDER BY rowid DESC LIMIT 1').get(instanceId, token) as Row | undefined;
    return r ? toCsid(r) : null;
  }
  csidByRequestId(instanceId: string, requestId: string, kind?: Csid['kind']): Csid | null {
    const r = (
      kind
        ? this.db.prepare('SELECT * FROM einvoice_csids WHERE instance_id = ? AND request_id = ? AND kind = ? ORDER BY rowid DESC LIMIT 1').get(instanceId, requestId, kind)
        : this.db.prepare('SELECT * FROM einvoice_csids WHERE instance_id = ? AND request_id = ? ORDER BY rowid DESC LIMIT 1').get(instanceId, requestId)
    ) as Row | undefined;
    return r ? toCsid(r) : null;
  }
  listCsids(projectId: string, f: { instanceId?: string; kind?: string; status?: string; runId?: string | null } = {}): Csid[] {
    const where = ['project_id = ?'];
    const args: unknown[] = [projectId];
    if (f.instanceId) (where.push('instance_id = ?'), args.push(f.instanceId));
    if (f.kind) (where.push('kind = ?'), args.push(f.kind));
    if (f.status) (where.push('status = ?'), args.push(f.status));
    if (f.runId) (where.push('run_id = ?'), args.push(f.runId));
    return (this.db.prepare(`SELECT * FROM einvoice_csids WHERE ${where.join(' AND ')} ORDER BY rowid DESC`).all(...args) as Row[]).map(toCsid);
  }
  updateCsid(id: string, p: Partial<Pick<Csid, 'status' | 'checks' | 'lint' | 'expiresAt'>>): Csid {
    if (p.status !== undefined) this.db.prepare('UPDATE einvoice_csids SET status = ? WHERE id = ?').run(p.status, id);
    if (p.checks !== undefined) this.db.prepare('UPDATE einvoice_csids SET checks = ? WHERE id = ?').run(JSON.stringify(p.checks), id);
    if (p.lint !== undefined) this.db.prepare('UPDATE einvoice_csids SET lint = ? WHERE id = ?').run(JSON.stringify(p.lint), id);
    if (p.expiresAt !== undefined) this.db.prepare('UPDATE einvoice_csids SET expires_at = ? WHERE id = ?').run(p.expiresAt, id);
    return this.getCsid(id)!;
  }
  /** Marks a compliance check (doc kind) as passed; the first pass time is kept. */
  markCheck(id: string, kind: DocKind, at: string = nowIso()): Csid {
    this.db.prepare("UPDATE einvoice_csids SET checks = json_set(checks, '$.\"' || ? || '\"', COALESCE(json_extract(checks, '$.\"' || ? || '\"'), ?)) WHERE id = ?").run(kind, kind, at, id);
    return this.getCsid(id)!;
  }
  deleteCsid(id: string): void {
    this.db.prepare('DELETE FROM einvoice_csids WHERE id = ?').run(id);
  }

  // ---------------- chains
  getChain(id: string): Chain | null {
    const r = this.db.prepare('SELECT * FROM einvoice_chains WHERE id = ?').get(id) as Row | undefined;
    return r ? toChain(r) : null;
  }
  findChain(instanceId: string, scope: ChainScope, vatNumber: string, egsKey: string): Chain | null {
    const r = this.db
      .prepare('SELECT * FROM einvoice_chains WHERE instance_id = ? AND scope = ? AND vat_number = ? AND egs_key = ?')
      .get(instanceId, scope, vatNumber, egsKey) as Row | undefined;
    return r ? toChain(r) : null;
  }
  /** The chain of an EGS unit, created empty on first use (seller name refreshed when given). */
  chainFor(c: { projectId: string; instanceId: string; scope: ChainScope; vatNumber: string; egsKey: string; sellerName?: string | null }): Chain {
    this.db
      .prepare(
        `INSERT INTO einvoice_chains (id, project_id, instance_id, scope, vat_number, egs_key, seller_name, count, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
          ON CONFLICT (instance_id, scope, vat_number, egs_key) DO UPDATE SET seller_name = COALESCE(excluded.seller_name, seller_name)`,
      )
      .run(newId(), c.projectId, c.instanceId, c.scope, c.vatNumber, c.egsKey, c.sellerName ?? null, nowIso());
    return this.findChain(c.instanceId, c.scope, c.vatNumber, c.egsKey)!;
  }
  listChains(projectId: string, f: { instanceId?: string; scope?: ChainScope } = {}): Chain[] {
    const where = ['project_id = ?'];
    const args: unknown[] = [projectId];
    if (f.instanceId) (where.push('instance_id = ?'), args.push(f.instanceId));
    if (f.scope) (where.push('scope = ?'), args.push(f.scope));
    return (this.db.prepare(`SELECT * FROM einvoice_chains WHERE ${where.join(' AND ')} ORDER BY vat_number, egs_key, scope`).all(...args) as Row[]).map(toChain);
  }
  /** The chain head moves to this invoice (ICV, hash) and the count goes up by one. */
  advanceChain(chainId: string, icv: number | null, hash: string | null, invoiceId: string): Chain {
    this.db
      .prepare('UPDATE einvoice_chains SET last_icv = ?, last_hash = ?, last_invoice_id = ?, count = count + 1, updated_at = ? WHERE id = ?')
      .run(icv, hash, invoiceId, nowIso(), chainId);
    return this.getChain(chainId)!;
  }
  /** Empties the chain: the next invoice is expected to carry the first-PIH value. */
  resetChain(chainId: string): Chain {
    this.db.prepare('UPDATE einvoice_chains SET last_icv = NULL, last_hash = NULL, last_invoice_id = NULL, count = 0, updated_at = ? WHERE id = ?').run(nowIso(), chainId);
    return this.getChain(chainId)!;
  }
  deleteChains(projectId: string, instanceId?: string): number {
    return instanceId
      ? this.db.prepare('DELETE FROM einvoice_chains WHERE project_id = ? AND instance_id = ?').run(projectId, instanceId).changes
      : this.db.prepare('DELETE FROM einvoice_chains WHERE project_id = ?').run(projectId).changes;
  }

  // ---------------- invoices
  insertInvoice(i: InvoiceInsert): Einvoice {
    const id = newId();
    const vals = INVOICE_COLS.map(([k]) => {
      const v = i[k] ?? (k in JSON_DEFAULTS ? JSON_DEFAULTS[k] : null);
      return k in JSON_DEFAULTS ? JSON.stringify(v) : v;
    });
    this.db
      .prepare(`INSERT INTO einvoices (id, ${INVOICE_COLS.map(([, c]) => c).join(', ')}, created_at) VALUES (?, ${INVOICE_COLS.map(() => '?').join(', ')}, ?)`)
      .run(id, ...(vals as never[]), nowIso());
    return this.getInvoice(id)!;
  }
  getInvoice(id: string): Einvoice | null {
    const r = this.db.prepare('SELECT * FROM einvoices WHERE id = ?').get(id) as Row | undefined;
    return r ? toInvoice(r) : null;
  }
  updateInvoice(id: string, p: Partial<Pick<Einvoice, 'clearedXml' | 'chainId' | 'duplicateOf' | 'logId'>>): Einvoice {
    const cols: Record<string, string> = { clearedXml: 'cleared_xml', chainId: 'chain_id', duplicateOf: 'duplicate_of', logId: 'log_id' };
    for (const [k, v] of Object.entries(p)) if (v !== undefined && cols[k]) this.db.prepare(`UPDATE einvoices SET ${cols[k]} = ? WHERE id = ?`).run(v, id);
    return this.getInvoice(id)!;
  }
  private rowid(id: string): number | null {
    const r = this.db.prepare('SELECT rowid AS r FROM einvoices WHERE id = ?').get(id) as { r: number } | undefined;
    return r ? Number(r.r) : null;
  }
  listInvoices(projectId: string, f: InvoiceFilter = {}): Einvoice[] {
    const where = ['project_id = ?'];
    const args: unknown[] = [projectId];
    if (f.instanceId) (where.push('instance_id = ?'), args.push(f.instanceId));
    if (f.endpoint) (where.push('endpoint = ?'), args.push(f.endpoint));
    if (f.status?.length) (where.push(`status IN (${f.status.map(() => '?').join(', ')})`), args.push(...f.status));
    if (f.docType) (where.push('doc_type = ?'), args.push(f.docType));
    if (f.seller) (where.push("(seller_vat = ? OR LOWER(COALESCE(seller_name, '')) LIKE ?)"), args.push(f.seller, `%${f.seller.toLowerCase()}%`));
    if (f.number) (where.push('number = ?'), args.push(f.number));
    if (f.runId) (where.push('run_id = ?'), args.push(f.runId));
    if (f.since) (where.push('created_at >= ?'), args.push(f.since));
    if (f.after) {
      const r = this.rowid(f.after);
      if (r !== null) (where.push('rowid > ?'), args.push(r));
    }
    const limit = Math.min(Math.max(f.limit ?? 100, 1), 1000);
    const order = f.asc ? 'rowid ASC' : 'rowid DESC';
    return (this.db.prepare(`SELECT * FROM einvoices WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${limit}`).all(...args) as Row[]).map(toInvoice);
  }
  /**
   * The newest invoice of the instance with this invoice hash submitted at or after `sinceIso` (duplicate detection).
   * Fault answers and duplicate answers are never the original; `statuses` narrows further (e.g. only accepted ones).
   */
  findByHash(instanceId: string, hash: string, sinceIso: string, statuses?: EinvoiceStatus[]): Einvoice | null {
    const where = ['instance_id = ?', 'invoice_hash = ?', 'created_at >= ?', "status NOT IN ('FAULT', 'DUPLICATE')"];
    const args: unknown[] = [instanceId, hash, sinceIso];
    if (statuses?.length) (where.push(`status IN (${statuses.map(() => '?').join(', ')})`), args.push(...statuses));
    const r = this.db.prepare(`SELECT * FROM einvoices WHERE ${where.join(' AND ')} ORDER BY rowid DESC LIMIT 1`).get(...args) as Row | undefined;
    return r ? toInvoice(r) : null;
  }
  deleteInvoices(projectId: string, f: { runId?: string; instanceId?: string } = {}): number {
    const where = ['project_id = ?'];
    const args: unknown[] = [projectId];
    if (f.runId) (where.push('run_id = ?'), args.push(f.runId));
    if (f.instanceId) (where.push('instance_id = ?'), args.push(f.instanceId));
    return this.db.prepare(`DELETE FROM einvoices WHERE ${where.join(' AND ')}`).run(...args).changes;
  }
  deleteOlderThan(projectId: string, cutoffIso: string): number {
    return this.db.prepare('DELETE FROM einvoices WHERE project_id = ? AND created_at < ?').run(projectId, cutoffIso).changes;
  }

  // ---------------- rules
  /** Run rules first (when no run filter), then project rules, oldest first. */
  listRules(projectId: string, f: { runId?: string | null; instanceId?: string } = {}): EinvoiceRule[] {
    const where = ['project_id = ?'];
    const args: unknown[] = [projectId];
    if (f.runId) (where.push('run_id = ?'), args.push(f.runId));
    if (f.instanceId) (where.push('(instance_id IS NULL OR instance_id = ?)'), args.push(f.instanceId));
    return (this.db.prepare(`SELECT * FROM einvoice_rules WHERE ${where.join(' AND ')} ORDER BY (run_id IS NULL), created_at, rowid`).all(...args) as Row[]).map(toRule);
  }
  getRule(id: string): EinvoiceRule | null {
    const r = this.db.prepare('SELECT * FROM einvoice_rules WHERE id = ?').get(id) as Row | undefined;
    return r ? toRule(r) : null;
  }
  insertRule(r: Omit<EinvoiceRule, 'id' | 'createdAt' | 'hits'>): EinvoiceRule {
    const id = newId();
    this.db
      .prepare('INSERT INTO einvoice_rules (id, project_id, run_id, instance_id, match, fault, remaining, hits, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)')
      .run(id, r.projectId, r.runId, r.instanceId, JSON.stringify(r.match ?? {}), r.fault, r.remaining, nowIso());
    return this.getRule(id)!;
  }
  /**
   * Uses one hit of the rule: false when it has none left (remaining 0), so two concurrent requests can't both take
   * the last hit. Null remaining = unlimited.
   */
  consumeRule(id: string): boolean {
    return (
      this.db
        .prepare('UPDATE einvoice_rules SET hits = hits + 1, remaining = CASE WHEN remaining IS NULL THEN NULL ELSE remaining - 1 END WHERE id = ? AND (remaining IS NULL OR remaining > 0)')
        .run(id).changes > 0
    );
  }
  deleteRule(id: string): void {
    this.db.prepare('DELETE FROM einvoice_rules WHERE id = ?').run(id);
  }
  /** Project rules (no run) or one run's rules. */
  deleteRules(projectId: string, runId?: string | null): number {
    return runId
      ? this.db.prepare('DELETE FROM einvoice_rules WHERE project_id = ? AND run_id = ?').run(projectId, runId).changes
      : this.db.prepare('DELETE FROM einvoice_rules WHERE project_id = ? AND run_id IS NULL').run(projectId).changes;
  }

  // ---------------- runs / reset
  countsForRun(runId: string): EinvoiceRunCounts {
    const rows = this.db.prepare('SELECT status AS s, COUNT(*) AS n FROM einvoices WHERE run_id = ? GROUP BY status').all(runId) as { s: EinvoiceStatus; n: number }[];
    const errors = (table: string) =>
      Number(
        (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} t, json_each(t.lint) j WHERE t.run_id = ? AND json_extract(j.value, '$.severity') = 'error'`).get(runId) as { n: number }).n,
      );
    return {
      invoices: rows.reduce((a, r) => a + Number(r.n), 0),
      byStatus: Object.fromEntries(rows.map((r) => [r.s, Number(r.n)])),
      lintErrors: errors('einvoices'),
      csidLintErrors: errors('einvoice_csids'),
    };
  }
  purgeRun(runId: string): void {
    this.db.prepare('DELETE FROM einvoices WHERE run_id = ?').run(runId);
    this.db.prepare('DELETE FROM einvoice_csids WHERE run_id = ?').run(runId);
    this.db.prepare('DELETE FROM einvoice_rules WHERE run_id = ?').run(runId);
  }
  /** POST /reset: invoices, chains and run CSIDs go; rule hits back to 0. */
  resetProject(projectId: string): void {
    this.db.prepare('DELETE FROM einvoices WHERE project_id = ?').run(projectId);
    this.db.prepare('DELETE FROM einvoice_chains WHERE project_id = ?').run(projectId);
    this.db.prepare('DELETE FROM einvoice_csids WHERE project_id = ? AND run_id IS NOT NULL').run(projectId);
    this.db.prepare('UPDATE einvoice_rules SET hits = 0 WHERE project_id = ?').run(projectId);
  }
}
