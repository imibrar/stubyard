import crypto from 'node:crypto';
import { XMLSerializer } from '@xmldom/xmldom';
import type { DB } from '../db/index.js';
import type { Hub } from '../hub.js';
import type { Project } from '../repos/projects.js';
import { HttpError, SLUG_RE } from '../util.js';
import { faultAppliesTo, parseFault, type EinvoiceFault } from './faults.js';
import { finding, lintFromRule, lintLevel, mergeFindings, type EinvoiceLintFinding } from './lint.js';
import { EinvoiceRepo } from './repo.js';
import {
  DOC_KINDS,
  zatcaConfig,
  type ChainScope,
  type Csid,
  type CsidKind,
  type DocKind,
  type Einvoice,
  type EinvoiceInstance,
  type EinvoiceRule,
  type EinvoiceRunCounts,
  type EinvoiceService as EinvoiceServiceApi,
  type EinvoiceStatus,
  type ZatcaAnswer,
  type ZatcaCall,
  type ZatcaConfig,
  type ZatcaEnv,
} from './types.js';
import { binarySecurityToken, certInfo, createCa, ecdsaSign, issueCert, parseCsr, type Ca, type ParsedCsr } from './zatca/pki.js';
import { buildQr } from './zatca/qr.js';
import {
  clearanceBody,
  clearanceOffBody,
  complianceInvoiceBody,
  csidBody,
  duplicateClearanceBody,
  duplicateReportingBody,
  httpErrorBody,
  httpStatusFor,
  notAcceptableBody,
  reportingBody,
  unauthorizedBody,
  validationResults,
  type ValidationResults,
  type ZatcaEndpoint,
} from './zatca/responses.js';
import { ruleFinding, type RuleFinding } from './zatca/rules/catalog.js';
import { parseInvoice, qrRefs, validateInvoice, type ExtractedInvoice, type ParsedInvoice } from './zatca/validate.js';
import { NS, children, parseXml } from './zatca/xml.js';

type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => !!v && typeof v === 'object' && !Array.isArray(v);

const DAY_MS = 86_400_000;
const OTP_TTL_MS = 3600_000;
const DUPLICATE_WINDOW_MS = DAY_MS;
const PCSID_DAYS = 365;

export const ZATCA_ENV_TEMPLATE: Record<ZatcaEnv, string> = {
  'developer-portal': 'TSTZATCA-Code-Signing',
  simulation: 'PREZATCA-Code-Signing',
  core: 'ZATCA-Code-Signing',
};

/** The served routes (404 answers list them). */
export const ZATCA_ROUTES: { method: string; path: string; endpoint: ZatcaEndpoint }[] = [
  { method: 'POST', path: '/compliance', endpoint: 'compliance' },
  { method: 'POST', path: '/compliance/invoices', endpoint: 'compliance_invoices' },
  { method: 'POST', path: '/production/csids', endpoint: 'csids' },
  { method: 'PATCH', path: '/production/csids', endpoint: 'csids_renew' },
  { method: 'POST', path: '/invoices/reporting/single', endpoint: 'reporting' },
  { method: 'POST', path: '/invoices/clearance/single', endpoint: 'clearance' },
];

const INVOICE_ENDPOINTS: readonly ZatcaEndpoint[] = ['compliance_invoices', 'reporting', 'clearance'];
const JSON_HEADERS = { 'content-type': 'application/json' };

export interface EinvoiceDeps {
  db: DB;
  /** ms since the epoch for a project / run (the clock with its 'einvoice' offset); default Date.now. */
  now?: (projectId: string, runId: string | null) => number;
  /** Event sink ('einvoice.changed'). */
  publish?: (e: { type: 'einvoice.changed'; projectId: string | null; data: unknown }) => void;
  /** How long the timeout fault holds a request (STUBYARD_TIMEOUT_HOLD_MS). */
  timeoutHoldMs?: number;
}

/** Path after /einvoice/<project>/<instance>: the endpoint and the real /e-invoicing/<env> prefix, when present. */
export function routeOf(method: string, path: string): { endpoint: ZatcaEndpoint | null; env: ZatcaEnv | null } {
  let p = (path.split('?')[0] || '/').replace(/\/+$/, '') || '/';
  if (!p.startsWith('/')) p = `/${p}`;
  let env: ZatcaEnv | null = null;
  const m = /^\/e-invoicing\/(developer-portal|simulation|core)(\/.*)?$/.exec(p);
  if (m) {
    env = m[1] as ZatcaEnv;
    p = m[2] || '/';
  }
  const r = ZATCA_ROUTES.find((x) => x.method === method.toUpperCase() && x.path === p);
  return { endpoint: r?.endpoint ?? null, env };
}

/** The doc kinds a CSR `title` (TSCZ flags: T standard, S simplified) declares; malformed → all six. */
export function declaredKinds(invoiceTypes: string | null): DocKind[] {
  const t = invoiceTypes ?? '';
  if (!/^[01]{4}$/.test(t) || !/1/.test(t.slice(0, 2))) return [...DOC_KINDS];
  return DOC_KINDS.filter((k) => (k.startsWith('standard') ? t[0] === '1' : t[1] === '1'));
}

/** Onboarding error bodies (/compliance, /production/csids). The shape is assumed: `{code, message}`. */
export const onboardingError = (code: string, message: string) => ({ code, message });

const sha256hex = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const randomDigits = (n: number) => String(crypto.randomInt(1, 10)) + Array.from({ length: n - 1 }, () => crypto.randomInt(0, 10)).join('');

/** One request while it is handled. */
interface Ctx {
  project: Project;
  instance: EinvoiceInstance;
  call: ZatcaCall;
  endpoint: ZatcaEndpoint;
  env: ZatcaEnv;
  headers: Record<string, string>;
  body: J;
  nowMs: number;
  /** Invoice endpoints: the decoded / parsed invoice (null when the body has none). */
  parsed: ParsedInvoice | null;
  auth: AuthResult | null;
  fault: EinvoiceFault | null;
  /** Request-level lint (headers, auth) added to the stored row. */
  lint: EinvoiceLintFinding[];
}

interface AuthResult {
  /** The CSID the token names (also when it is the wrong kind or inactive). */
  csid: Csid | null;
  ok: boolean;
  problem: string | null;
}

/** hub.einvoice: the fake ZATCA Fatoora API (instances, CSIDs, EGS chains, invoices, fault rules). */
export class EinvoiceService implements EinvoiceServiceApi {
  readonly repo: EinvoiceRepo;
  /** OTPs issued from the dashboard: instance id → otp → expiry (ms). Memory only, like the push access tokens. */
  readonly otps = new Map<string, Map<string, number>>();
  private readonly nowFn: (projectId: string, runId: string | null) => number;
  private readonly publish: NonNullable<EinvoiceDeps['publish']>;
  private readonly timeoutHoldMs: number;

  constructor(deps: EinvoiceDeps) {
    this.repo = new EinvoiceRepo(deps.db);
    this.nowFn = deps.now ?? (() => Date.now());
    this.publish = deps.publish ?? (() => {});
    this.timeoutHoldMs = deps.timeoutHoldMs ?? 120_000;
  }

  static fromHub(hub: Hub): EinvoiceService {
    return new EinvoiceService({
      db: hub.db,
      now: (projectId, runId) => hub.clock.now(projectId, 'einvoice', runId),
      publish: (e) => hub.bus.publish(e),
      timeoutHoldMs: hub.config.timeoutHoldMs,
    });
  }

  // ------------------------------------------------------------------ instances

  listInstances(projectId: string): EinvoiceInstance[] {
    return this.repo.listInstances(projectId);
  }

  getInstance(project: Project, ref: string): EinvoiceInstance {
    const i = this.repo.instanceBySlug(project.id, ref.toLowerCase()) ?? this.repo.getInstance(ref);
    if (!i || i.projectId !== project.id) throw new HttpError(404, `E-invoicing instance "${ref}" not found in project ${project.slug}`);
    return i;
  }

  private uniqueSlug(projectId: string, base: string): string {
    let s = base;
    for (let n = 2; this.repo.instanceBySlug(projectId, s); n++) s = `${base}-${n}`;
    return s;
  }

  /** The config with a fake CA (generated when it has none). */
  private withCa(c: ZatcaConfig): ZatcaConfig {
    if (c.caKeyPem && c.caCertPem) return c;
    const ca = createCa();
    return { ...c, caKeyPem: ca.keyPem, caCertPem: ca.certPem };
  }

  createInstance(project: Project, input: { slug?: string; name?: string; enabled?: boolean; config?: Record<string, unknown> }): EinvoiceInstance {
    const slug = input.slug ? String(input.slug).toLowerCase() : this.uniqueSlug(project.id, 'zatca');
    if (!SLUG_RE.test(slug)) throw new HttpError(400, 'slug: lowercase letters, digits and dashes (max 48)');
    if (this.repo.instanceBySlug(project.id, slug)) throw new HttpError(409, `E-invoicing instance "${slug}" already exists`);
    const config = this.withCa(zatcaConfig(isObj(input.config) ? input.config : {}));
    const inst = this.repo.insertInstance({
      projectId: project.id,
      slug,
      name: input.name ? String(input.name).slice(0, 120) : 'ZATCA Fatoora',
      config,
      enabled: input.enabled !== false,
    });
    this.changed(project.id, { instance: inst.id });
    return inst;
  }

  updateInstance(project: Project, ref: string, input: { slug?: string; name?: string; enabled?: boolean; config?: Record<string, unknown> }): EinvoiceInstance {
    const cur = this.getInstance(project, ref);
    const patch: Parameters<EinvoiceRepo['updateInstance']>[1] = {};
    if (input.name !== undefined) patch.name = String(input.name).slice(0, 120);
    if (input.slug !== undefined && input.slug !== cur.slug) {
      const s = String(input.slug).toLowerCase();
      if (!SLUG_RE.test(s)) throw new HttpError(400, 'slug: lowercase letters, digits and dashes (max 48)');
      if (this.repo.instanceBySlug(project.id, s)) throw new HttpError(409, `E-invoicing instance "${s}" already exists`);
      patch.slug = s;
    }
    if (input.enabled !== undefined) patch.enabled = input.enabled !== false;
    if (isObj(input.config)) patch.config = this.withCa(zatcaConfig(input.config, cur.config));
    const next = this.repo.updateInstance(cur.id, patch);
    this.changed(project.id, { instance: cur.id });
    return next;
  }

  deleteInstance(project: Project, ref: string): void {
    const cur = this.getInstance(project, ref);
    this.repo.deleteInstance(cur.id);
    this.otps.delete(cur.id);
    this.changed(project.id, { instance: cur.id, deleted: true });
  }

  /** Instance as shown by the API: the CA private key is never included. */
  viewInstance(i: EinvoiceInstance) {
    const { caKeyPem, ...config } = i.config;
    return { ...i, config: { ...config, hasCaKey: !!caKeyPem } };
  }

  /** A dashboard OTP: 6 digits, valid 1 h, accepted by /compliance and the renewal even when config.otp is set. */
  issueOtp(instance: EinvoiceInstance, runId: string | null = null): { otp: string; expiresAt: string } {
    const now = this.nowFn(instance.projectId, runId);
    const list = this.otps.get(instance.id) ?? new Map<string, number>();
    for (const [o, exp] of list) if (exp < now - OTP_TTL_MS) list.delete(o);
    const otp = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    list.set(otp, now + OTP_TTL_MS);
    this.otps.set(instance.id, list);
    this.changed(instance.projectId, { instance: instance.id, otp: true });
    return { otp, expiresAt: new Date(now + OTP_TTL_MS).toISOString() };
  }

  private checkOtp(instance: EinvoiceInstance, otp: string | undefined, nowMs: number): 'ok' | 'invalid' | 'expired' {
    const v = (otp ?? '').trim();
    if (!/^\d{6}$/.test(v)) return 'invalid';
    const issued = this.otps.get(instance.id)?.get(v);
    if (issued !== undefined) return issued >= nowMs ? 'ok' : 'expired';
    if (!instance.config.otp || instance.config.otp === v) return 'ok';
    return 'invalid';
  }

  private ca(instance: EinvoiceInstance): Ca {
    let c = instance.config;
    if (!c.caKeyPem || !c.caCertPem) {
      c = this.withCa(c);
      this.repo.updateInstance(instance.id, { config: c });
      instance.config = c;
    }
    return { keyPem: c.caKeyPem!, certPem: c.caCertPem! };
  }

  // ------------------------------------------------------------------ the fake API

  async handle(project: Project, instance: EinvoiceInstance, call: ZatcaCall): Promise<ZatcaAnswer> {
    const route = routeOf(call.method, call.path);
    const env = route.env ?? instance.config.env;
    if (!route.endpoint) {
      return {
        status: 404,
        headers: { ...JSON_HEADERS },
        body: { message: `No Fatoora route ${call.method.toUpperCase()} ${call.path}`, routes: ZATCA_ROUTES.map((r) => `${r.method} ${r.path}`) },
        resolved: { env, endpoint: null },
      };
    }
    const endpoint = route.endpoint;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(call.headers ?? {})) if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
    let body: J = {};
    if (isObj(call.body)) body = call.body;
    else if (typeof call.body === 'string' && call.body.trim()) {
      try {
        const b = JSON.parse(call.body);
        if (isObj(b)) body = b;
      } catch {
        body = {};
      }
    }
    const isInvoice = INVOICE_ENDPOINTS.includes(endpoint);
    const ctx: Ctx = {
      project,
      instance,
      call,
      endpoint,
      env,
      headers,
      body,
      nowMs: this.nowFn(project.id, call.runId),
      parsed: isInvoice ? parseInvoice(typeof body.invoice === 'string' ? body.invoice : '') : null,
      auth: endpoint === 'compliance' ? null : this.resolveAuth(instance, headers.authorization, endpoint),
      fault: null,
      lint: [],
    };
    const x = ctx.parsed?.ok ? ctx.parsed.extracted : null;
    const picked = this.pickFault(ctx, { docType: x?.docType ?? null, number: x?.number ?? null, seller: x?.sellerVat ?? null });
    ctx.fault = picked;
    if (picked && picked.kind !== 'slow' && picked.kind !== 'warning') return this.faultAnswer(ctx, picked);

    const answer = await this.serve(ctx);
    if (picked?.kind === 'slow') answer.holdMs = picked.arg ?? 0;
    return answer;
  }

  private async serve(ctx: Ctx): Promise<ZatcaAnswer> {
    const av = ctx.headers['accept-version'];
    if (!av || av.trim().toUpperCase() !== 'V2') {
      ctx.lint.push(finding('einv.accept-version-missing', av ? `Accept-Version "${av}" is not supported: send Accept-Version: V2` : 'The request has no Accept-Version header: send Accept-Version: V2'));
      return this.refuse(ctx, 406, notAcceptableBody());
    }

    if (ctx.auth && !ctx.auth.ok) {
      const a = ctx.auth;
      if (!a.csid) ctx.lint.push(finding('einv.unknown-csid', `Unauthorized: ${a.problem}`));
      if (a.csid?.kind === 'compliance' && (ctx.endpoint === 'reporting' || ctx.endpoint === 'clearance')) {
        ctx.lint.push(finding('einv.ccsid-in-production', `The compliance CSID ${a.csid.requestId} was used for ${ctx.endpoint}; use the production CSID (PCSID)`));
      }
      if (ctx.instance.config.strictAuth) return this.refuse(ctx, 401, unauthorizedBody(new Date(ctx.nowMs)));
    }

    switch (ctx.endpoint) {
      case 'compliance':
        return this.compliance(ctx);
      case 'csids':
        return this.productionCsid(ctx);
      case 'csids_renew':
        return this.renewCsid(ctx);
      default:
        return this.invoice(ctx);
    }
  }

  /** Basic auth: base64(binarySecurityToken:secret), matched against the CSIDs of the instance. */
  private resolveAuth(instance: EinvoiceInstance, header: string | undefined, endpoint: ZatcaEndpoint): AuthResult {
    const m = /^Basic\s+(\S+)$/i.exec((header ?? '').trim());
    if (!m) return { csid: null, ok: false, problem: header ? 'the Authorization header is not Basic' : 'no Authorization header' };
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i < 0) return { csid: null, ok: false, problem: 'the Basic credentials have no ":" between the token and the secret' };
    const token = decoded.slice(0, i).trim();
    const secret = decoded.slice(i + 1);
    const csid = this.repo.csidByToken(instance.id, token);
    if (!csid) return { csid: null, ok: false, problem: 'the binarySecurityToken is not a CSID issued by this instance' };
    if (sha256hex(secret) !== csid.secretHash) return { csid, ok: false, problem: 'the secret does not match the CSID' };
    if (csid.status !== 'active') return { csid, ok: false, problem: `the CSID is ${csid.status}` };
    if (csid.expiresAt && Date.parse(csid.expiresAt) < this.nowFn(instance.projectId, null)) return { csid, ok: false, problem: 'the CSID has expired' };
    const needs: CsidKind = endpoint === 'compliance_invoices' || endpoint === 'csids' ? 'compliance' : 'production';
    const kindOk = needs === 'compliance' ? csid.kind === 'compliance' : csid.kind === 'production' || csid.kind === 'demo';
    if (!kindOk) return { csid, ok: false, problem: `a ${csid.kind} CSID was used; this endpoint needs the ${needs} CSID` };
    return { csid, ok: true, problem: null };
  }

  // ------------------------------------------------------------------ onboarding

  private otpAnswer(ctx: Ctx, kind: 'invalid' | 'expired'): ZatcaAnswer {
    return this.reply(
      ctx,
      400,
      kind === 'invalid' ? onboardingError('Invalid-OTP', 'The provided OTP is invalid') : onboardingError('Expired-OTP', 'The provided OTP has expired'),
    );
  }

  /** CSR integration lint: curve, template of the environment, subject fields. */
  private csrLint(csr: ParsedCsr, env: ZatcaEnv): EinvoiceLintFinding[] {
    const out: EinvoiceLintFinding[] = [];
    if (csr.curve !== 'secp256k1') out.push(finding('einv.csr-curve', `The CSR key is on ${csr.curve}, not secp256k1`));
    const want = ZATCA_ENV_TEMPLATE[env];
    if (csr.template !== want) out.push(finding('einv.csr-template-env', `The CSR certificate template is ${csr.template ?? '(none)'}; the ${env} environment expects ${want}`));
    const field = (ok: boolean, msg: string) => ok || out.push(finding('einv.csr-fields', msg));
    field(!!csr.subject.CN, 'The CSR subject has no common name (CN)');
    field(!!csr.egsSerial, 'The CSR has no EGS serial number (SAN SN, "1-Manufacturer|2-Model|3-Serial")');
    field(!!csr.vatNumber && /^3\d{13}3$/.test(csr.vatNumber), `The CSR VAT number (SAN UID / organizationIdentifier) ${csr.vatNumber ?? '(none)'} is not 15 digits starting and ending with 3`);
    field(!!csr.subject.OU, 'The CSR subject has no organizational unit (OU)');
    field(csr.subject.C === 'SA', `The CSR country is ${csr.subject.C ?? '(none)'}, not SA`);
    field(!!csr.invoiceTypes && /^[01]{4}$/.test(csr.invoiceTypes) && /1/.test(csr.invoiceTypes.slice(0, 2)), `The CSR invoice type (SAN title) ${csr.invoiceTypes ?? '(none)'} is not 4 digits TSCZ declaring standard and / or simplified (e.g. 1100)`);
    return out;
  }

  /** Parses + lints a CSR; an answer when it is refused. */
  private readCsr(ctx: Ctx): { csr: ParsedCsr; lint: EinvoiceLintFinding[] } | ZatcaAnswer {
    const text = typeof ctx.body.csr === 'string' ? ctx.body.csr : '';
    if (!text) return this.reply(ctx, 400, onboardingError('Invalid-CSR', 'The request body has no csr (base64 of the CSR PEM)'));
    let csr: ParsedCsr;
    try {
      csr = parseCsr(text);
    } catch (e) {
      return this.reply(ctx, 400, onboardingError('Invalid-CSR', `The CSR could not be read: ${(e as Error).message}`));
    }
    if (!csr.popValid) return this.reply(ctx, 400, onboardingError('Invalid-CSR', 'The CSR signature does not verify with its public key (ECDSA-SHA256 expected)'));
    const lint = this.csrLint(csr, ctx.env);
    if (ctx.instance.config.strictCsr) {
      const hard = lint.filter((l) => l.check === 'einv.csr-curve' || l.check === 'einv.csr-template-env');
      if (hard.length) return this.reply(ctx, 400, onboardingError('Invalid-CSR', hard.map((l) => l.message).join('; ')));
    }
    return { csr, lint };
  }

  private issueCsid(ctx: Ctx, csr: ParsedCsr, kind: CsidKind, parentId: string | null, lint: EinvoiceLintFinding[]): Csid {
    const ca = this.ca(ctx.instance);
    const certPem = issueCert(ca, csr, { template: csr.template ?? ZATCA_ENV_TEMPLATE[ctx.env], days: kind === 'compliance' ? 30 : PCSID_DAYS });
    const secret = crypto.randomBytes(32).toString('base64');
    const csid = this.repo.insertCsid({
      projectId: ctx.project.id,
      instanceId: ctx.instance.id,
      runId: ctx.call.runId,
      kind,
      requestId: randomDigits(13),
      parentId,
      token: binarySecurityToken(certPem),
      secretHash: sha256hex(secret),
      secret,
      certPem,
      csrPem: csr.pem,
      commonName: csr.subject.CN ?? null,
      vatNumber: csr.vatNumber,
      egsSerial: csr.egsSerial,
      orgUnit: csr.subject.OU ?? null,
      invoiceTypes: csr.invoiceTypes,
      env: ctx.env,
      lint,
      expiresAt: kind === 'compliance' ? null : certInfo(certPem).notAfter.toISOString(),
    });
    this.changed(ctx.project.id, { csid: csid.id, kind });
    return csid;
  }

  private csidAnswer(ctx: Ctx, csid: Csid): ZatcaAnswer {
    return this.reply(ctx, 200, csidBody({ requestID: Number(csid.requestId), token: csid.token, secret: csid.secret }), { csidId: csid.id });
  }

  /** POST /compliance: OTP + CSR → a compliance CSID. */
  private compliance(ctx: Ctx): ZatcaAnswer {
    const otp = this.checkOtp(ctx.instance, ctx.headers.otp, ctx.nowMs);
    if (otp !== 'ok') return this.otpAnswer(ctx, otp);
    const r = this.readCsr(ctx);
    if (!('csr' in r)) return r;
    return this.csidAnswer(ctx, this.issueCsid(ctx, r.csr, 'compliance', null, r.lint));
  }

  /** POST /production/csids: {compliance_request_id} with CCSID auth → a production CSID. */
  private productionCsid(ctx: Ctx): ZatcaAnswer {
    const reqId = ctx.body.compliance_request_id;
    if (reqId === undefined || reqId === null || reqId === '') return this.reply(ctx, 400, onboardingError('Invalid-Request-ID', 'The request body has no compliance_request_id'));
    const ccsid = this.repo.csidByRequestId(ctx.instance.id, String(reqId), 'compliance');
    const auth = ctx.auth?.csid ?? null;
    if (!ccsid || (auth && ctx.auth?.ok && auth.id !== ccsid.id)) {
      return this.reply(ctx, 400, onboardingError('Invalid-Request-ID', `compliance_request_id ${String(reqId)} is not the request id of the compliance CSID used for this request`));
    }
    if (ctx.instance.config.requireComplianceChecks) {
      const missing = declaredKinds(ccsid.invoiceTypes).filter((k) => !ccsid.checks[k]);
      if (missing.length) return this.reply(ctx, 400, notCompliantBody(missing), { csidId: ccsid.id });
    }
    let csr: ParsedCsr;
    try {
      csr = parseCsr(ccsid.csrPem);
    } catch (e) {
      return this.reply(ctx, 400, onboardingError('Invalid-CSR', `The CSR of the compliance CSID could not be read: ${(e as Error).message}`));
    }
    return this.csidAnswer(ctx, this.issueCsid(ctx, csr, 'production', ccsid.id, ccsid.lint));
  }

  /** PATCH /production/csids: OTP + {csr} with PCSID auth → a new PCSID; the old one is superseded. */
  private renewCsid(ctx: Ctx): ZatcaAnswer {
    const otp = this.checkOtp(ctx.instance, ctx.headers.otp, ctx.nowMs);
    if (otp !== 'ok') return this.otpAnswer(ctx, otp);
    const r = this.readCsr(ctx);
    if (!('csr' in r)) return r;
    const old = ctx.auth?.csid ?? null;
    const next = this.issueCsid(ctx, r.csr, 'production', old?.id ?? null, r.lint);
    if (old && old.kind !== 'compliance') this.repo.updateCsid(old.id, { status: 'superseded' });
    return this.csidAnswer(ctx, next);
  }

  // ------------------------------------------------------------------ invoices

  /** The EGS chain of the request: keyed by the CSID's VAT + EGS serial (certificate serial as fallback). */
  private chainOf(ctx: Ctx, x: ExtractedInvoice) {
    const csid = ctx.auth?.csid ?? null;
    const vatNumber = csid?.vatNumber ?? x.sellerVat;
    if (!vatNumber) return null;
    let egsKey = csid?.egsSerial ?? null;
    if (!egsKey && csid) {
      try {
        egsKey = certInfo(csid.certPem).serial;
      } catch {
        egsKey = null;
      }
    }
    const scope: ChainScope = ctx.endpoint === 'compliance_invoices' ? 'compliance' : 'production';
    return this.repo.chainFor({ projectId: ctx.project.id, instanceId: ctx.instance.id, scope, vatNumber, egsKey: egsKey ?? 'unknown-egs', sellerName: x.sellerName });
  }

  private async invoice(ctx: Ctx): Promise<ZatcaAnswer> {
    const { endpoint, instance } = ctx;
    if (endpoint === 'clearance' && !instance.config.clearanceEnabled) return this.refuse(ctx, 303, clearanceOffBody());
    if (endpoint === 'clearance') {
      const cs = ctx.headers['clearance-status'];
      if (!cs || cs.trim() === '0') ctx.lint.push(finding('einv.clearance-status-header', cs ? 'Clearance-Status is 0 on a clearance request: send Clearance-Status: 1' : 'The clearance request has no Clearance-Status header: send Clearance-Status: 1'));
    }
    const sentHash = typeof ctx.body.invoiceHash === 'string' ? ctx.body.invoiceHash : null;

    // Duplicate: the same hash already accepted within 24 h.
    if ((endpoint === 'reporting' || endpoint === 'clearance') && sentHash) {
      const orig = this.repo.findByHash(instance.id, sentHash, new Date(ctx.nowMs - DUPLICATE_WINDOW_MS).toISOString(), ['REPORTED', 'CLEARED']);
      if (orig) {
        ctx.lint.push(finding('einv.duplicate-resubmitted', `Invoice ${orig.number ?? '(no number)'} was already ${orig.status === 'CLEARED' ? 'cleared' : 'reported'} (same invoice hash); treat the ${endpoint === 'reporting' ? '409' : '208'} as success and stop resending`));
        const status = endpoint === 'reporting' ? 409 : 208;
        const results = orig.validation ?? validationResults([]);
        const body = endpoint === 'reporting' ? duplicateReportingBody(results) : duplicateClearanceBody(orig.clearedXml ? b64(orig.clearedXml) : null, results);
        const row = this.store(ctx, { status: 'DUPLICATE', httpStatus: status, validation: results, duplicateOf: orig.id, clearedXml: orig.clearedXml });
        return this.reply(ctx, status, body, { invoiceId: row.id });
      }
    }

    const x = ctx.parsed?.ok ? ctx.parsed.extracted : null;
    const chain = x ? this.chainOf(ctx, x) : null;
    const head = chain?.lastInvoiceId ? this.repo.getInvoice(chain.lastInvoiceId) : null;
    const v = validateInvoice({
      xml: typeof ctx.body.invoice === 'string' ? ctx.body.invoice : '',
      invoiceHash: sentHash,
      uuid: typeof ctx.body.uuid === 'string' ? ctx.body.uuid : null,
      endpoint,
      csid: ctx.auth?.csid ?? null,
      config: instance.config,
      chain: chain ? { lastIcv: chain.lastIcv, lastHash: chain.lastHash, lastNumber: head?.number ?? null } : null,
      nowMs: ctx.nowMs,
    });
    if (ctx.fault?.kind === 'warning') {
      const f: RuleFinding = { ...ruleFinding(ctx.fault.code!), severity: 'warning' };
      v.findings.push(f);
      v.lint.push(lintFromRule(f));
    }
    const results = validationResults(v.findings);
    const http = httpStatusFor(endpoint, results);
    const ok = results.status !== 'ERROR';
    let clearedXml: string | null = null;
    let stamped = false;
    if (endpoint === 'clearance' && ok && v.xmlText) {
      clearedXml = this.stamp(instance, v.xmlText, v.extracted);
      stamped = clearedXml !== null;
    }
    const status: EinvoiceStatus =
      endpoint === 'reporting' ? (ok ? 'REPORTED' : 'NOT_REPORTED') : endpoint === 'clearance' ? (ok ? 'CLEARED' : 'NOT_CLEARED') : results.status;
    const row = this.store(ctx, { status, httpStatus: http, validation: results, lint: v.lint, chainId: chain?.id ?? null, clearedXml, extracted: v.extracted, xml: v.xmlText });
    if (chain && v.parsed && !v.retryOfHead) this.repo.advanceChain(chain.id, v.extracted.icv, v.extracted.computedHash, row.id);

    const csid = ctx.auth?.csid ?? null;
    if (endpoint === 'compliance_invoices' && ok && csid?.kind === 'compliance' && v.extracted.docType && v.extracted.typeCode) {
      const kind = `${v.extracted.docType}:${v.extracted.typeCode}` as DocKind;
      if (DOC_KINDS.includes(kind)) this.repo.markCheck(csid.id, kind);
    }

    const body =
      endpoint === 'reporting'
        ? reportingBody(results)
        : endpoint === 'clearance'
          ? clearanceBody(results, clearedXml ? b64(clearedXml) : null)
          : complianceInvoiceBody(results, v.extracted.docType ?? 'simplified');
    return this.reply(ctx, http, body, { invoiceId: row.id, ...(stamped ? { stamp: 'stubyard-fake' } : {}) });
  }

  /**
   * The cleared invoice: the submitted XML with the QR (tags 1-8) regenerated and signed with the instance's fake
   * ZATCA CA key (tag 6 = the invoice hash, 7 = ECDSA over the hash bytes, 8 = the CA public key). The QR is not part
   * of the hash, so the invoice hash is unchanged. Null when the XML can't be stamped.
   * TODO(B6): the full platform stamp (a second XAdES signature by the fake ZATCA key) is not added yet.
   */
  stamp(instance: EinvoiceInstance, xml: string, x: ExtractedInvoice): string | null {
    if (!x.computedHash) return null;
    try {
      const ca = this.ca(instance);
      const doc = parseXml(xml);
      const root = doc.documentElement!;
      const qr = buildQr({
        sellerName: x.sellerName ?? '',
        vatNumber: x.sellerVat ?? '',
        timestamp: x.issueAt ?? '',
        total: x.totals.incl ?? '0.00',
        vatTotal: x.totals.vat ?? '0.00',
        hash: x.computedHash,
        signature: ecdsaSign(ca.keyPem, Buffer.from(x.computedHash, 'base64')),
        publicKey: certInfo(ca.certPem).spkiDer,
      });
      const ref = qrRefs(doc)[0];
      if (ref) {
        const obj = children(ref, 'cac:Attachment').flatMap((a) => children(a, 'cbc:EmbeddedDocumentBinaryObject'))[0];
        if (obj) {
          while (obj.firstChild) obj.removeChild(obj.firstChild);
          obj.appendChild(doc.createTextNode(qr));
        } else {
          const att = children(ref, 'cac:Attachment')[0] ?? ref.appendChild(doc.createElementNS(NS.cac, 'cac:Attachment'));
          att.appendChild(binaryObject(doc, qr));
        }
      } else {
        const el = doc.createElementNS(NS.cac, 'cac:AdditionalDocumentReference');
        const id = doc.createElementNS(NS.cbc, 'cbc:ID');
        id.appendChild(doc.createTextNode('QR'));
        const att = doc.createElementNS(NS.cac, 'cac:Attachment');
        att.appendChild(binaryObject(doc, qr));
        el.appendChild(id);
        el.appendChild(att);
        const refs = children(root, 'cac:AdditionalDocumentReference');
        const anchor = refs.length ? refs[refs.length - 1].nextSibling : (children(root, 'cac:Signature')[0] ?? children(root, 'cac:AccountingSupplierParty')[0] ?? null);
        root.insertBefore(el, anchor);
      }
      return new XMLSerializer().serializeToString(doc);
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------ faults

  /** The fault for one request: X-Hub-Scenario, else the first matching run rule, then project rule. */
  private pickFault(ctx: Ctx, m: { docType: string | null; number: string | null; seller: string | null }): EinvoiceFault | null {
    const header = ctx.headers['x-hub-scenario'];
    if (header) {
      const spec = header.split(',')[0].trim();
      if (spec && spec.toLowerCase() !== 'none') {
        const f = parseFault(spec);
        if (faultAppliesTo(f, ctx.endpoint)) return f;
      }
    }
    const csid = ctx.auth?.csid ?? null;
    const rules = this.repo.listRules(ctx.project.id, { instanceId: ctx.instance.id }).filter((r) => r.remaining !== 0 && (!r.runId || r.runId === ctx.call.runId));
    for (const r of rules) {
      if (!ruleMatches(r, ctx.endpoint, m, csid)) continue;
      let f: EinvoiceFault;
      try {
        f = parseFault(r.fault);
      } catch {
        continue;
      }
      if (!faultAppliesTo(f, ctx.endpoint)) continue;
      if (!this.repo.consumeRule(r.id)) continue;
      this.changed(ctx.project.id, { rule: r.id, hit: true });
      return f.kind === 'none' ? null : f;
    }
    return null;
  }

  private faultAnswer(ctx: Ctx, f: EinvoiceFault): ZatcaAnswer {
    const isInvoice = INVOICE_ENDPOINTS.includes(ctx.endpoint);
    let status: number;
    let body: unknown;
    let validation: ValidationResults | null = null;
    const extra: { headers?: Record<string, string>; holdMs?: number; close?: boolean } = {};
    switch (f.kind) {
      case 'reject': {
        validation = validationResults([{ ...ruleFinding(f.code!), severity: 'error' }]);
        status = 400;
        const docType = ctx.parsed?.ok ? (ctx.parsed.extracted.docType ?? 'simplified') : 'simplified';
        body = ctx.endpoint === 'reporting' ? reportingBody(validation) : ctx.endpoint === 'clearance' ? clearanceBody(validation, null) : complianceInvoiceBody(validation, docType);
        break;
      }
      case 'duplicate': {
        validation = validationResults([]);
        if (ctx.endpoint === 'reporting') {
          status = 409;
          body = duplicateReportingBody(validation);
        } else {
          status = 208;
          const p = ctx.parsed;
          const cleared = p?.ok ? this.stamp(ctx.instance, p.xml, p.extracted) : null;
          body = duplicateClearanceBody(cleared ? b64(cleared) : null, validation);
        }
        break;
      }
      case 'unauthorized':
        status = 401;
        body = unauthorizedBody(new Date(ctx.nowMs));
        break;
      case 'clearance_off':
        status = 303;
        body = clearanceOffBody();
        break;
      case 'otp_invalid':
        status = 400;
        body = onboardingError('Invalid-OTP', 'The provided OTP is invalid');
        break;
      case 'otp_expired':
        status = 400;
        body = onboardingError('Expired-OTP', 'The provided OTP has expired');
        break;
      case 'not_compliant':
        status = 400;
        body = notCompliantBody([]);
        break;
      case 'renewal_not_compliant':
        status = 428;
        body = onboardingError('Renewal-Not-Compliant', 'The CSID was renewed but the compliance checks of the new CSR are not complete');
        break;
      case 'too_large':
        status = 413;
        body = httpErrorBody(413, 'Payload Too Large');
        break;
      case 'rate_limited': {
        status = 429;
        const secs = f.arg ?? 60;
        extra.headers = { 'retry-after': String(secs) };
        body = httpErrorBody(429, `Too Many Requests: retry after ${secs} seconds`);
        break;
      }
      case 'server_error':
        status = 500;
        body = httpErrorBody(500, 'Internal Server Error');
        break;
      case 'unavailable':
        status = 503;
        body = httpErrorBody(503, 'Service Unavailable');
        break;
      case 'gateway_timeout':
        status = 504;
        body = httpErrorBody(504, 'Gateway Timeout');
        break;
      case 'timeout':
        status = 504;
        body = null;
        extra.holdMs = this.timeoutHoldMs;
        extra.close = true;
        break;
      default:
        status = 500;
        body = httpErrorBody(500, 'Internal Server Error');
    }
    let invoiceId: string | undefined;
    if (isInvoice) invoiceId = this.store(ctx, { status: 'FAULT', httpStatus: status, validation }).id;
    const a = this.reply(ctx, status, body, { invoiceId, headers: extra.headers });
    if (extra.holdMs !== undefined) a.holdMs = extra.holdMs;
    if (extra.close) a.close = true;
    return a;
  }

  // ------------------------------------------------------------------ storage and answers

  /** Stores the request as an invoice row (invoice endpoints only). */
  private store(
    ctx: Ctx,
    p: {
      status: EinvoiceStatus;
      httpStatus: number;
      validation?: ValidationResults | null;
      lint?: EinvoiceLintFinding[];
      chainId?: string | null;
      duplicateOf?: string | null;
      clearedXml?: string | null;
      extracted?: ExtractedInvoice;
      xml?: string | null;
    },
  ): Einvoice {
    const parsed = ctx.parsed;
    const x = p.extracted ?? (parsed?.ok ? parsed.extracted : null);
    const lint = mergeFindings(ctx.lint, p.lint ?? []);
    const headers = { ...ctx.headers };
    if (headers.authorization) headers.authorization = headers.authorization.replace(/^(\S+\s+).*/, '$1[redacted]');
    const row = this.repo.insertInvoice({
      projectId: ctx.project.id,
      instanceId: ctx.instance.id,
      runId: ctx.call.runId,
      csidId: ctx.auth?.csid?.id ?? null,
      chainId: p.chainId ?? null,
      endpoint: ctx.endpoint,
      docType: x?.docType ?? null,
      typeCode: x?.typeCode ?? null,
      typeName: x?.typeName ?? null,
      number: x?.number ?? null,
      uuid: x?.uuid ?? (typeof ctx.body.uuid === 'string' ? ctx.body.uuid : null),
      icv: x?.icv ?? null,
      pih: x?.pih ?? null,
      invoiceHash: typeof ctx.body.invoiceHash === 'string' ? ctx.body.invoiceHash : null,
      computedHash: x?.computedHash ?? null,
      issueAt: x?.issueAt ?? null,
      sellerVat: x?.sellerVat ?? null,
      sellerName: x?.sellerName ?? null,
      buyerName: x?.buyerName ?? null,
      buyerVat: x?.buyerVat ?? null,
      currency: x?.currency ?? null,
      totalExcl: x?.totals.excl ?? null,
      vatTotal: x?.totals.vat ?? null,
      totalIncl: x?.totals.incl ?? null,
      status: p.status,
      httpStatus: p.httpStatus,
      validation: p.validation ?? null,
      lint,
      lintLevel: lintLevel(lint),
      fault: ctx.fault?.spec ?? null,
      duplicateOf: p.duplicateOf ?? null,
      xml: p.xml ?? parsed?.xml ?? null,
      clearedXml: p.clearedXml ?? null,
      headers,
      logId: ctx.call.logId,
    });
    this.changed(ctx.project.id, { invoice: row.id, status: row.status });
    return row;
  }

  /** A refusal before validation (406, 401, 303): stored for invoice endpoints. */
  private refuse(ctx: Ctx, status: number, body: unknown): ZatcaAnswer {
    let invoiceId: string | undefined;
    if (INVOICE_ENDPOINTS.includes(ctx.endpoint)) invoiceId = this.store(ctx, { status: 'ERROR', httpStatus: status }).id;
    return this.reply(ctx, status, body, { invoiceId });
  }

  private reply(ctx: Ctx, status: number, body: unknown, o: { invoiceId?: string; csidId?: string; headers?: Record<string, string>; stamp?: string } = {}): ZatcaAnswer {
    // `stamp` is an extra field of `resolved` (the traffic log keeps it as is).
    const resolved = {
      env: ctx.env,
      endpoint: ctx.endpoint,
      csidId: o.csidId ?? ctx.auth?.csid?.id ?? null,
      invoiceId: o.invoiceId ?? null,
      fault: ctx.fault?.spec ?? null,
      ...(o.stamp ? { stamp: o.stamp } : {}),
    };
    return { status, headers: { ...JSON_HEADERS, ...(o.headers ?? {}) }, body, resolved };
  }

  // ------------------------------------------------------------------ runs, reset

  countsForRun(runId: string): EinvoiceRunCounts {
    return this.repo.countsForRun(runId);
  }

  /** A run is purged: its invoices, CSIDs and fault rules go. */
  purgeRun(runId: string): void {
    this.repo.purgeRun(runId);
  }

  /** Project reset: invoices, chains and run CSIDs go; rule hits back to 0. Instances and other CSIDs stay. */
  resetProject(projectId: string): void {
    this.repo.resetProject(projectId);
    this.changed(projectId, { reset: true });
  }

  changed(projectId: string, data: unknown): void {
    this.publish({ type: 'einvoice.changed', projectId, data });
  }
}

function ruleMatches(r: EinvoiceRule, endpoint: ZatcaEndpoint, m: { docType: string | null; number: string | null; seller: string | null }, csid: Csid | null): boolean {
  const w = r.match;
  if (w.endpoint && w.endpoint !== endpoint) return false;
  if (w.docType && w.docType !== m.docType) return false;
  if (w.number && w.number !== m.number) return false;
  if (w.seller && w.seller !== m.seller) return false;
  if (w.csid && (!csid || (w.csid !== csid.id && w.csid !== csid.token && w.csid !== csid.requestId))) return false;
  return true;
}

/** 400 on the PCSID request: compliance checks missing (shape assumed). */
export function notCompliantBody(missing: DocKind[]) {
  return onboardingError(
    'Missing-ComplianceSteps',
    missing.length ? `The compliance checks are not complete: missing ${missing.join(', ')}` : 'The compliance checks are not complete',
  );
}

const b64 = (xml: string) => Buffer.from(xml, 'utf8').toString('base64');

function binaryObject(doc: ReturnType<typeof parseXml>, value: string) {
  const obj = doc.createElementNS(NS.cbc, 'cbc:EmbeddedDocumentBinaryObject');
  obj.setAttribute('mimeCode', 'text/plain');
  obj.appendChild(doc.createTextNode(value));
  return obj;
}
