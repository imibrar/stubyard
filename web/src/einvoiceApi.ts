/** Types and helpers of the e-invoicing API (/api/projects/:slug/einvoice/…, data plane /einvoice/<project>/<instance>/…). */
import { api, qs } from './api';

export type EinvoicePreset = 'zatca';
export type ZatcaEnv = 'developer-portal' | 'simulation' | 'core';
export const ZATCA_ENVS: readonly ZatcaEnv[] = ['developer-portal', 'simulation', 'core'];
export const ZATCA_ENV_LABEL: Record<ZatcaEnv, string> = { 'developer-portal': 'Developer portal', simulation: 'Simulation', core: 'Core (production)' };

export type DocType = 'standard' | 'simplified';
export type DocKind = `${DocType}:${'388' | '381' | '383'}`;
export type ZatcaEndpoint = 'compliance' | 'compliance_invoices' | 'csids' | 'csids_renew' | 'reporting' | 'clearance';
export type CsidKind = 'compliance' | 'production' | 'demo';
export type CsidStatus = 'active' | 'superseded' | 'revoked' | 'expired';
export type ChainScope = 'compliance' | 'production';
export type EinvoiceStatus = 'REPORTED' | 'NOT_REPORTED' | 'CLEARED' | 'NOT_CLEARED' | 'PASS' | 'WARNING' | 'ERROR' | 'DUPLICATE' | 'FAULT';

export const einvoiceBase = (slug: string) => `/api/projects/${encodeURIComponent(slug)}/einvoice`;
const inst = (slug: string, id: string) => `${einvoiceBase(slug)}/instances/${encodeURIComponent(id)}`;

/** ZatcaConfig as the API shows it: the CA key is never sent, only whether there is one. */
export interface ZatcaConfigView {
  env: ZatcaEnv;
  /** '' accepts any 6 digits. */
  otp: string;
  strictAuth: boolean;
  strictCsr: boolean;
  requireComplianceChecks: boolean;
  clearanceEnabled: boolean;
  checks: 'basic' | 'full';
  chainCheck: 'lint' | 'error' | 'off';
  reportingWindowHours: number;
  caCertPem: string | null;
  hasCaKey: boolean;
}
export type ZatcaConfigInput = Partial<Omit<ZatcaConfigView, 'hasCaKey' | 'caCertPem'>> & { caKeyPem?: string | null; caCertPem?: string | null };

export interface EinvoiceUrls {
  base: string;
  envBase: string;
  byEnv: Record<ZatcaEnv, string>;
  compliance: string;
  complianceInvoices: string;
  productionCsids: string;
  reporting: string;
  clearance: string;
  caPem: string;
  otp: string;
}

export interface EinvoiceInstance {
  id: string;
  projectId: string;
  slug: string;
  preset: EinvoicePreset;
  name: string;
  config: ZatcaConfigView;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  urls: EinvoiceUrls;
}

export interface EinvoiceOverview {
  instances: EinvoiceInstance[];
  csids: { active: number; compliance: number; production: number };
  chains: number;
  faults: number;
  lastInvoiceAt: string | null;
}

export interface EinvoiceLintFinding {
  check: string;
  severity: 'error' | 'warn' | 'info';
  message: string;
  path?: string;
}

export interface ValidationMessage {
  type: 'INFO' | 'WARNING' | 'ERROR';
  code: string;
  category: string;
  message: string;
  status: 'PASS' | 'WARNING' | 'ERROR';
}
export interface ValidationResults {
  infoMessages: ValidationMessage[];
  warningMessages: ValidationMessage[];
  errorMessages: ValidationMessage[];
  status: 'PASS' | 'WARNING' | 'ERROR';
}

export interface EinvoiceSnippet {
  id: string;
  title: string;
  lang: string;
  code: string;
}

export interface EinvoiceConnect {
  preset: EinvoicePreset;
  env: ZatcaEnv;
  csrTemplate: string;
  urls: EinvoiceUrls;
  dotenv: Record<string, string>;
  firstPih: string;
  snippets: EinvoiceSnippet[];
}

export interface EinvoiceOtp {
  otp: string;
  expiresAt: string;
}

export interface EinvoiceCsid {
  id: string;
  projectId: string;
  instanceId: string;
  runId: string | null;
  kind: CsidKind;
  requestId: string;
  parentId: string | null;
  token: string;
  secret: string;
  commonName: string | null;
  vatNumber: string | null;
  egsSerial: string | null;
  orgUnit: string | null;
  invoiceTypes: string | null;
  env: string | null;
  checks: Partial<Record<DocKind, string>>;
  status: CsidStatus;
  lint: EinvoiceLintFinding[];
  expiresAt: string | null;
  createdAt: string;
  instance: string | null;
  run: string | null;
  /** Compliance CSIDs: checks passed of the kinds the CSR declared. */
  progress?: { done: number; needed: number; kinds: DocKind[] };
  /** GET /csids/:id only. */
  certPem?: string;
  csrPem?: string;
}

export interface EinvoiceChain {
  id: string;
  projectId: string;
  instanceId: string;
  scope: ChainScope;
  vatNumber: string;
  egsKey: string;
  sellerName: string | null;
  lastIcv: number | null;
  lastHash: string | null;
  lastInvoiceId: string | null;
  count: number;
  updatedAt: string;
  instance: string | null;
  lastNumber: string | null;
  /** What the next invoice of the chain must carry. */
  next: { icv: number; pih: string };
}

export interface Einvoice {
  id: string;
  projectId: string;
  instanceId: string;
  runId: string | null;
  csidId: string | null;
  chainId: string | null;
  endpoint: ZatcaEndpoint;
  docType: DocType | null;
  typeCode: string | null;
  typeName: string | null;
  number: string | null;
  uuid: string | null;
  icv: number | null;
  pih: string | null;
  invoiceHash: string | null;
  computedHash: string | null;
  issueAt: string | null;
  sellerVat: string | null;
  sellerName: string | null;
  buyerName: string | null;
  buyerVat: string | null;
  currency: string | null;
  totalExcl: string | null;
  vatTotal: string | null;
  totalIncl: string | null;
  status: EinvoiceStatus;
  httpStatus: number;
  validation: ValidationResults | null;
  lint: EinvoiceLintFinding[];
  lintLevel: EinvoiceLintFinding['severity'] | null;
  fault: string | null;
  duplicateOf: string | null;
  headers: Record<string, string>;
  logId: string | null;
  createdAt: string;
  instance: string | null;
  run: string | null;
  hasXml: boolean;
  hasClearedXml: boolean;
}

/** GET /invoices/:id: the XML and the chain it joined. */
export interface EinvoiceDetail extends Einvoice {
  xml: string | null;
  clearedXml: string | null;
  chain: { id: string; vatNumber: string; egsKey: string; scope: ChainScope } | null;
}

export interface EinvoiceWait {
  timedOut: boolean;
  error?: string;
  invoices: Einvoice[];
  cursor: string;
}

export interface EinvoiceRule {
  id: string;
  projectId: string;
  runId: string | null;
  instanceId: string | null;
  match: { endpoint?: ZatcaEndpoint; docType?: DocType; number?: string; seller?: string; csid?: string };
  fault: string;
  remaining: number | null;
  hits: number;
  createdAt: string;
  run: string | null;
  instance: string | null;
}

export interface EinvoiceLintReport {
  invoices: number;
  level: EinvoiceLintFinding['severity'] | null;
  counts: Record<string, number>;
  byCheck: Record<string, number>;
  findings: (EinvoiceLintFinding & { invoice: string | null; number: string | null; csid: string | null; instance: string | null })[];
}

export interface EinvoiceValidateResult {
  instance: string | null;
  checks: 'basic' | 'full';
  status: ValidationResults['status'];
  validationResults: ValidationResults;
  findings: unknown[];
  lint: EinvoiceLintFinding[];
  lintLevel: EinvoiceLintFinding['severity'] | null;
  parsed: unknown;
  extracted: unknown;
}

export interface EinvoiceSample {
  instance: string;
  type: DocType;
  kind: '388' | '381' | '383';
  breaks: string[];
  expect: unknown;
  xml: string;
  invoice: string;
  invoiceHash: string;
  uuid: string;
  endpoint: string;
  egs: { vat: string; egsSerial: string; certPem: string };
  auth: { binarySecurityToken: string; secret: string };
}

export interface EinvoiceReference {
  rules: { code: string; category: string; severity: string; message: string; verified: boolean }[];
  faults: { fault: string; answer: string }[];
  faultKinds: string[];
  lint: { id: string; severity: EinvoiceLintFinding['severity']; label: string; description: string }[];
  breaks: { name: string; code: string; description: string }[];
  envs: { env: ZatcaEnv; csrTemplate: string }[];
  routes: { method: string; path: string; endpoint: ZatcaEndpoint }[];
  docKinds: DocKind[];
  firstPih: string;
  configDefaults: Omit<ZatcaConfigView, 'caCertPem' | 'hasCaKey'>;
  snippets: EinvoiceSnippet[];
}

export interface InvoiceQuery {
  instance?: string;
  endpoint?: ZatcaEndpoint;
  /** Comma separated. */
  status?: string;
  docType?: DocType;
  seller?: string;
  number?: string;
  after?: string;
  since?: string;
  run?: string;
  limit?: number;
}

export interface WaitQuery extends Omit<InvoiceQuery, 'limit'> {
  count?: number;
  exactly?: number;
  timeout?: number;
  settle?: number;
  lookback?: number;
}

export interface FaultInput {
  fault: string;
  run?: string;
  instance?: string;
  endpoint?: ZatcaEndpoint;
  docType?: DocType;
  number?: string;
  seller?: string;
  csid?: string;
  times?: number;
}

export interface SampleInput {
  instance?: string;
  type?: DocType;
  kind?: '388' | '381' | '383';
  break?: string | string[];
  icv?: number;
  pih?: string;
  number?: string;
  lang?: 'ar' | 'en';
  issueAt?: string;
  billingRef?: string;
  reason?: string;
}

export interface ValidateInput {
  /** XML text or base64. */
  xml?: string;
  /** base64, as in the ZATCA body. */
  invoice?: string;
  invoiceHash?: string;
  uuid?: string;
  endpoint?: ZatcaEndpoint;
  instance?: string;
}

export const STATUS_KIND: Record<EinvoiceStatus, string> = {
  REPORTED: 'ok',
  CLEARED: 'ok',
  PASS: 'ok',
  WARNING: 'warn',
  NOT_REPORTED: 'bad',
  NOT_CLEARED: 'bad',
  ERROR: 'bad',
  DUPLICATE: 'warn',
  FAULT: 'accent',
};

/** Download link of the instance's fake ZATCA CA (attachment). */
export const caPemUrl = (slug: string, id: string) => `${inst(slug, id)}/ca.pem`;
/** Raw / downloadable XML of an invoice (cleared: the stamped copy of a clearance). */
export const invoiceXmlUrl = (slug: string, id: string, o: { cleared?: boolean; download?: boolean } = {}) =>
  `${einvoiceBase(slug)}/invoices/${encodeURIComponent(id)}/xml${qs({ cleared: o.cleared ? '1' : undefined, download: o.download ? '1' : undefined })}`;

export const einvoiceApi = {
  overview: (slug: string) => api.get<EinvoiceOverview>(einvoiceBase(slug)),
  reference: () => api.get<EinvoiceReference>('/api/einvoice-reference'),

  instances: (slug: string) => api.get<EinvoiceInstance[]>(`${einvoiceBase(slug)}/instances`),
  instance: (slug: string, id: string) => api.get<EinvoiceInstance>(inst(slug, id)),
  createInstance: (slug: string, b: { name?: string; slug?: string; config?: ZatcaConfigInput }) => api.post<EinvoiceInstance>(`${einvoiceBase(slug)}/instances`, b),
  updateInstance: (slug: string, id: string, b: { name?: string; slug?: string; enabled?: boolean; config?: ZatcaConfigInput }) => api.patch<EinvoiceInstance>(inst(slug, id), b),
  deleteInstance: (slug: string, id: string) => api.del(inst(slug, id)),
  issueOtp: (slug: string, id: string, run?: string) => api.post<EinvoiceOtp>(`${inst(slug, id)}/otp${qs({ run })}`),
  connect: (slug: string, id: string) => api.get<EinvoiceConnect>(`${inst(slug, id)}/connect`),

  csids: (slug: string, q: { instance?: string; kind?: CsidKind; status?: CsidStatus; run?: string } = {}) => api.get<EinvoiceCsid[]>(`${einvoiceBase(slug)}/csids${qs({ ...q })}`),
  csid: (slug: string, id: string) => api.get<EinvoiceCsid>(`${einvoiceBase(slug)}/csids/${encodeURIComponent(id)}`),
  revokeCsid: (slug: string, id: string) => api.post<EinvoiceCsid>(`${einvoiceBase(slug)}/csids/${encodeURIComponent(id)}/revoke`),
  expireCsid: (slug: string, id: string) => api.post<EinvoiceCsid>(`${einvoiceBase(slug)}/csids/${encodeURIComponent(id)}/expire`),

  invoices: (slug: string, q: InvoiceQuery = {}) => api.get<Einvoice[]>(`${einvoiceBase(slug)}/invoices${qs({ ...q })}`),
  waitInvoices: (slug: string, q: WaitQuery = {}) => api.get<EinvoiceWait>(`${einvoiceBase(slug)}/invoices/wait${qs({ ...q })}`),
  invoice: (slug: string, id: string) => api.get<EinvoiceDetail>(`${einvoiceBase(slug)}/invoices/${encodeURIComponent(id)}`),
  /** The XML as text (the route answers application/xml, not JSON). */
  invoiceXml: async (slug: string, id: string, cleared = false) => {
    const res = await fetch(invoiceXmlUrl(slug, id, { cleared }));
    if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
    return res.text();
  },
  clearInvoices: (slug: string, q: { instance?: string; run?: string } = {}) => api.del<{ deleted: number }>(`${einvoiceBase(slug)}/invoices${qs({ ...q })}`),

  chains: (slug: string, q: { instance?: string; scope?: ChainScope } = {}) => api.get<EinvoiceChain[]>(`${einvoiceBase(slug)}/chains${qs({ ...q })}`),
  resetChain: (slug: string, id: string) => api.post<EinvoiceChain>(`${einvoiceBase(slug)}/chains/${encodeURIComponent(id)}/reset`),

  faults: (slug: string, run?: string) => api.get<EinvoiceRule[]>(`${einvoiceBase(slug)}/faults${qs({ run })}`),
  addFault: (slug: string, b: FaultInput) => api.post<EinvoiceRule>(`${einvoiceBase(slug)}/faults`, b),
  deleteFault: (slug: string, id: string) => api.del(`${einvoiceBase(slug)}/faults/${encodeURIComponent(id)}`),
  clearFaults: (slug: string, run?: string) => api.del<{ deleted: number }>(`${einvoiceBase(slug)}/faults${qs({ run })}`),

  lint: (slug: string, run?: string) => api.get<EinvoiceLintReport>(`${einvoiceBase(slug)}/lint${qs({ run })}`),
  validate: (slug: string, b: ValidateInput) => api.post<EinvoiceValidateResult>(`${einvoiceBase(slug)}/validate`, b),
  sample: (slug: string, b: SampleInput = {}) => api.post<EinvoiceSample>(`${einvoiceBase(slug)}/sample`, b),
  reset: (slug: string) => api.post<{ reset: true }>(`${einvoiceBase(slug)}/reset`),
};
