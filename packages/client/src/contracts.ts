/**
 * OpenAPI contracts (browser-safe, fetch only): import a spec as mocks, check samples against it, read the contract
 * issues found in traffic, and fail a test when there are any.
 *
 *   import { importOpenApi, expectNoContractIssues } from '@stubyard/client/contracts';
 *   const t = { project: 'hyper' };
 *   await importOpenApi(t, { spec: fs.readFileSync('openapi.yaml', 'utf8'), name: 'crm', prefix: '/crm' });
 *   // … run the test against /mock/hyper/api/crm …
 *   await expectNoContractIssues(t, { run: 'w1' });   // throws listing up to 10 issues with their log ids
 */
import { hubJson, projectPath, query, seg, type HubTarget } from './http.js';

export type ContractSeverity = 'error' | 'warn' | 'info';
export type ContractSubject = 'mock-request' | 'app-response' | 'provider-request';
export type SpecMode = 'off' | 'report' | 'strict';
export type SpecRole = 'mock' | 'app';
export type RemoveMissing = 'disable' | 'delete' | 'keep';

export interface ContractCheck {
  id: string;
  severity: ContractSeverity;
  label: string;
}

export interface ContractIssue {
  check: string;
  severity: ContractSeverity;
  side: 'request' | 'response';
  where: 'path' | 'query' | 'header' | 'cookie' | 'body' | 'status' | 'content-type' | 'auth' | 'operation';
  name?: string;
  pointer?: string;
  message: string;
  actual?: string;
  expected?: string;
}

export interface SpecOptions {
  unknownFields: 'ignore' | 'warn';
  checkAuth: boolean;
  include: { tags?: string[]; paths?: string[] };
}

/** A spec without its document. */
export interface ApiSpec {
  id: string;
  projectId: string;
  name: string;
  role: SpecRole;
  /** Below /mock/<project>/api (role=mock). */
  prefix: string;
  mode: SpecMode;
  openapiVersion: string;
  title: string;
  apiVersion: string;
  source: { kind: 'upload' | 'url' | 'inline'; url?: string; filename?: string };
  options: SpecOptions;
  warnings: string[];
  /** Number of operations in the document. */
  operations: number;
  hash: string;
  createdAt: string;
  updatedAt: string;
}

/** A list row (GET …/contracts/specs). */
export interface ApiSpecItem extends ApiSpec {
  mocks: number;
  issues24h: { checked: number; withIssues: number; error: number; warn: number };
  /** Where its mocks answer (role=mock), else null. */
  mockBaseUrl: string | null;
}

export interface SpecOperation {
  key: string;
  method: string;
  path: string;
  operationId: string | null;
  summary: string | null;
  tags: string[];
  deprecated: boolean;
  mock: { id: string; name: string; enabled: boolean; edited: boolean } | null;
}

export interface ApiSpecDetail extends ApiSpecItem {
  operationList: SpecOperation[];
  /** With `document: true`. */
  document?: Record<string, unknown>;
}

export interface ImportedMock {
  id: string | null;
  name: string;
  method: string;
  path: string;
  specOperation: string;
}

export interface SpecImportResult {
  spec: ApiSpec;
  dryRun: boolean;
  /** True when a re-import found the same document and nothing to change. */
  unchanged: boolean;
  created: ImportedMock[];
  updated: (ImportedMock & { overwritten: boolean })[];
  kept: { id: string; name: string; specOperation: string; reason: 'edited' }[];
  removed: { id: string; name: string; specOperation: string; action: RemoveMissing }[];
  warnings: string[];
}

export interface ImportOpenApiInput {
  /** The OpenAPI 3.x document as JSON or YAML text (or an object, sent as JSON). */
  spec?: string | Record<string, unknown>;
  /** Or a URL stubyard fetches the document from. */
  url?: string;
  /** Records where the text came from. */
  filename?: string;
  /** Default: from info.title. An existing name re-imports. */
  name?: string;
  role?: SpecRole;
  prefix?: string;
  mode?: SpecMode;
  options?: Partial<SpecOptions>;
  include?: { tags?: string[]; paths?: string[] };
  dryRun?: boolean;
  overwriteEdited?: boolean;
  removeMissing?: RemoveMissing;
}

export interface ReimportInput {
  spec?: string | Record<string, unknown>;
  url?: string;
  filename?: string;
  overwriteEdited?: boolean;
  removeMissing?: RemoveMissing;
  dryRun?: boolean;
}

export type SpecPatch = Partial<{ name: string; role: SpecRole; prefix: string; mode: SpecMode; options: Partial<SpecOptions> }>;

export interface ContractCheckInput {
  /** Spec name or id. */
  spec: string;
  /** "POST /users" or an operationId; or pass method + path. */
  operation?: string;
  method?: string;
  /** May include the spec prefix. */
  path?: string;
  request?: { path?: string; method?: string; params?: Record<string, unknown>; query?: string | Record<string, unknown>; headers?: Record<string, unknown>; body?: unknown; contentType?: string };
  response?: { status: number; headers?: Record<string, unknown>; body?: unknown; contentType?: string };
}

export interface ContractSideResult {
  side: 'request' | 'response';
  level: ContractSeverity | null;
  counts: { error: number; warn: number; info: number };
  issues: ContractIssue[];
  truncated?: boolean;
}

export interface ContractCheckResult {
  spec: string;
  operation: { key: string; operationId: string | null; deprecated: boolean };
  request?: ContractSideResult;
  response?: ContractSideResult;
}

export interface ContractViolation {
  logId: string;
  receivedAt: string;
  method: string | null;
  url: string | null;
  subject: ContractSubject;
  spec: string | null;
  provider: string | null;
  operation: string | null;
  level: ContractSeverity;
  issues: ContractIssue[];
}

/** GET …/contracts/issues. */
export interface ContractIssues {
  project: string;
  run?: string;
  /** Logs with a contract result. */
  checked: number;
  /** Logs whose worst issue is error or warn. */
  withIssues: number;
  error: number;
  warn: number;
  info: number;
  byCheck: { check: string; label: string; count: number }[];
  bySource: { spec: string | null; provider: string | null; checked: number; withIssues: number }[];
  /** Newest first. */
  violations: ContractViolation[];
}

export interface ContractIssuesQuery {
  /** Test run key or id. */
  run?: string;
  /** Spec name. */
  spec?: string;
  /** Lowest level listed in violations (default warn); counts are not filtered by it. */
  level?: ContractSeverity;
  subject?: ContractSubject;
  /** ISO timestamps. */
  since?: string;
  until?: string;
  /** Max violations (default 50, max 500). */
  limit?: number;
}

const base = (t: HubTarget, suffix = '') => projectPath(t, `/contracts${suffix}`);
const one = (t: HubTarget, ref: string, suffix = '') => base(t, `/specs/${seg(ref)}${suffix}`);
const textOf = (v: string | Record<string, unknown> | undefined) => (v === undefined || typeof v === 'string' ? v : JSON.stringify(v));

/** The contract check catalog (id, severity, label). */
export function listContractChecks(t: HubTarget): Promise<ContractCheck[]> {
  return hubJson(t, 'GET', base(t, '/checks'));
}
/** Import a spec (text or url); an existing name re-imports. dryRun previews the mocks without writing. */
export function importOpenApi(t: HubTarget, input: ImportOpenApiInput): Promise<SpecImportResult> {
  return hubJson(t, 'POST', base(t, '/specs'), { ...input, spec: textOf(input.spec) });
}
export function listApiSpecs(t: HubTarget): Promise<ApiSpecItem[]> {
  return hubJson(t, 'GET', base(t, '/specs'));
}
/** By name or id, with its operations; `document` adds the normalized document. */
export function getApiSpec(t: HubTarget, ref: string, o: { document?: boolean } = {}): Promise<ApiSpecDetail> {
  return hubJson(t, 'GET', one(t, ref, query({ document: o.document })));
}
export function listSpecOperations(t: HubTarget, ref: string): Promise<SpecOperation[]> {
  return hubJson(t, 'GET', one(t, ref, '/operations'));
}
/** mode, prefix, role, options, name (metadata only; mock paths follow a prefix change on the next re-import). */
export function updateApiSpec(t: HubTarget, ref: string, patch: SpecPatch): Promise<ApiSpecItem> {
  return hubJson(t, 'PATCH', one(t, ref), patch);
}
/** New text or url, else the stored url again, else the stored document. */
export function reimportOpenApi(t: HubTarget, ref: string, input: ReimportInput = {}): Promise<SpecImportResult> {
  return hubJson(t, 'POST', one(t, ref, '/reimport'), { ...input, spec: textOf(input.spec) });
}
/** mocks: keep (default; they become hand-made mocks) or delete. */
export function deleteApiSpec(t: HubTarget, ref: string, o: { mocks?: 'keep' | 'delete' } = {}): Promise<Record<string, unknown>> {
  return hubJson(t, 'DELETE', one(t, ref, query({ mocks: o.mocks })));
}
/** Check a sample request and/or response against an operation; nothing is logged. */
export function checkContract(t: HubTarget, input: ContractCheckInput): Promise<ContractCheckResult> {
  return hubJson(t, 'POST', base(t, '/check'), input);
}
/** Contract results over the project's traffic (optionally one run, spec, level, subject or time window). */
export function contractIssues(t: HubTarget, q: ContractIssuesQuery = {}): Promise<ContractIssues> {
  return hubJson(t, 'GET', base(t, `/issues${query({ ...q })}`));
}
/** Traffic logs with a contract result: checked (any) | issues (error or warn) | error | warn. */
export function contractLogs(t: HubTarget, o: { contract?: 'checked' | 'issues' | 'error' | 'warn'; run?: string; limit?: number } = {}): Promise<Record<string, unknown>[]> {
  return hubJson(t, 'GET', `/api/logs${query({ project: t.project, contract: o.contract ?? 'issues', run: o.run, limit: o.limit })}`);
}

/**
 * The contract issues, or throws an Error listing up to 10 violations with their log ids when any request broke the
 * contract at `level` or worse (default warn: error and warn count).
 */
export async function expectNoContractIssues(t: HubTarget, q: Omit<ContractIssuesQuery, 'limit'> = {}): Promise<ContractIssues> {
  const level = q.level ?? 'warn';
  const r = await contractIssues(t, { ...q, level, limit: 10 });
  const failing = level === 'error' ? r.error : level === 'warn' ? r.withIssues : r.error + r.warn + r.info;
  if (!failing && !r.violations.length) return r;
  const lines = r.violations.map((v) => {
    const first = v.issues[0];
    const what = `${v.method ?? ''} ${v.url ?? ''}`.trim();
    const src = v.spec ?? v.provider ?? '?';
    const more = v.issues.length > 1 ? ` (+${v.issues.length - 1} more)` : '';
    return `  [${v.level}] ${v.logId} ${what} (${src}${v.operation ? ` ${v.operation}` : ''}): ${first ? `${first.check}: ${first.message}` : 'no details'}${more}`;
  });
  const scope = q.run ? ` in run "${q.run}"` : '';
  const total = Math.max(failing, r.violations.length);
  const extra = total > r.violations.length ? `\n  … and ${total - r.violations.length} more` : '';
  throw new Error(`${total} request(s)${scope} broke the API contract (error ${r.error}, warn ${r.warn}):\n${lines.join('\n')}${extra}`);
}
