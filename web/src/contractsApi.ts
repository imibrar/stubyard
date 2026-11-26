/**
 * OpenAPI contracts (C1): typed client for /api/projects/:slug/contracts (server/src/http/routes/contracts.ts).
 * The issue / result types live in api.ts (shared with the traffic view); the spec types mirror the server's
 * SpecRecord, SpecImportResult and ContractSummary.
 */
import { api, qs, type ContractIssue, type ContractLevel, type ContractSubject } from './api';

export type SpecRole = 'mock' | 'app';
export type SpecMode = 'off' | 'report' | 'strict';
export type RemoveMissing = 'disable' | 'delete' | 'keep';

export interface SpecOptions {
  unknownParams: 'ignore' | 'warn';
  unknownFields: 'ignore' | 'warn';
  checkAuth: boolean;
  include: { tags?: string[]; paths?: string[] };
}

export interface SpecInclude {
  tags?: string[];
  /** Globs on the OpenAPI path template ("/users/*"). */
  paths?: string[];
  /** operationIds or operation keys ("GET /users/{id}"); applies to one import only. */
  operations?: string[];
}

/** A spec without its document (GET /specs rows, PATCH answer). */
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
  /** Mocks generated from the spec. */
  mocks: number;
  issues24h: { checked: number; withIssues: number; error: number; warn: number };
  /** Where the spec's mocks answer (role=mock), else null. */
  mockBaseUrl: string | null;
}

export interface SpecOperation {
  key: string;
  method: string;
  path: string;
  operationId: string | null;
  summary: string;
  tags: string[];
  deprecated: boolean;
  mock: { id: string; name: string; enabled: boolean; edited: boolean } | null;
}

export interface ApiSpecDetail extends ApiSpec {
  operationList: SpecOperation[];
  document?: unknown;
}

export interface ImportedMock {
  /** null in a dry run for mocks still to be created. */
  id: string | null;
  name: string;
  method: string;
  path: string;
  specOperation: string;
}

export interface SpecImportResult {
  spec: Omit<ApiSpec, 'mocks' | 'issues24h' | 'mockBaseUrl'>;
  dryRun: boolean;
  /** A re-import found the same document and nothing to change. */
  unchanged: boolean;
  created: ImportedMock[];
  updated: (ImportedMock & { overwritten: boolean })[];
  kept: { id: string; name: string; specOperation: string; reason: 'edited' }[];
  removed: { id: string; name: string; specOperation: string; action: RemoveMissing }[];
  warnings: string[];
}

/** The import source: the document text (pasted or read from a file) or a URL the hub fetches. */
export type SpecSourceInput = { spec: string; filename?: string } | { url: string };

export interface SpecImportInput {
  name?: string;
  role?: SpecRole;
  prefix?: string;
  mode?: SpecMode;
  options?: Partial<SpecOptions>;
  include?: SpecInclude;
  dryRun?: boolean;
  overwriteEdited?: boolean;
  removeMissing?: RemoveMissing;
}

export interface SpecReimportInput {
  overwriteEdited?: boolean;
  removeMissing?: RemoveMissing;
  dryRun?: boolean;
}

export interface SpecPatch {
  name?: string;
  role?: SpecRole;
  prefix?: string;
  mode?: SpecMode;
  options?: Partial<SpecOptions>;
}

export interface ContractCheckDef {
  id: string;
  label: string;
  [k: string]: unknown;
}

export interface ContractCheckRequest {
  path?: string;
  method?: string;
  params?: Record<string, string>;
  query?: Record<string, string | string[]> | string;
  headers?: Record<string, string>;
  body?: unknown;
  contentType?: string;
}

export interface ContractCheckResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  contentType?: string;
}

export interface ContractCheckSide {
  side: 'request' | 'response';
  level: ContractLevel | null;
  counts: { error: number; warn: number; info: number };
  issues: ContractIssue[];
  truncated?: boolean;
}

export interface ContractCheckResult {
  spec: string;
  operation: { key: string; operationId: string | null; deprecated: boolean };
  request?: ContractCheckSide;
  response?: ContractCheckSide;
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
  level: ContractLevel;
  issues: ContractIssue[];
}

export interface ContractSummary {
  project: string;
  run?: string;
  checked: number;
  withIssues: number;
  error: number;
  warn: number;
  info: number;
  byCheck: { check: string; label: string; count: number }[];
  bySource: { spec: string | null; provider: string | null; checked: number; withIssues: number }[];
  violations: ContractViolation[];
}

export interface ContractIssuesQuery {
  run?: string;
  since?: string;
  until?: string;
  level?: ContractLevel;
  spec?: string;
  subject?: ContractSubject;
  limit?: number;
}

const base = (slug: string) => `/api/projects/${encodeURIComponent(slug)}/contracts`;
const specPath = (slug: string, spec: string) => `${base(slug)}/specs/${encodeURIComponent(spec)}`;

/** GET /specs: the project's specs with mock counts, 24 h issues and the mock base URL. */
export const specsPath = (slug: string) => `${base(slug)}/specs`;
export const specDetailPath = (slug: string, spec: string) => specPath(slug, spec);
export const issuesPath = (slug: string, q: ContractIssuesQuery = {}) => `${base(slug)}/issues${qs({ ...q })}`;
/** The stored document as a JSON file (content-disposition: attachment). */
export const specDownloadUrl = (slug: string, spec: string) => `${specPath(slug, spec)}?download=1`;

export const contractsApi = {
  checks: (slug: string) => api.get<ContractCheckDef[]>(`${base(slug)}/checks`),
  specs: (slug: string) => api.get<ApiSpec[]>(specsPath(slug)),
  /** Import, or re-import when `name` is an existing spec; 201 created / 200 otherwise (dryRun writes nothing). */
  importSpec: (slug: string, source: SpecSourceInput, input: SpecImportInput = {}) => api.post<SpecImportResult>(specsPath(slug), { ...source, ...input }),
  spec: (slug: string, spec: string, opts: { document?: boolean } = {}) => api.get<ApiSpecDetail>(`${specPath(slug, spec)}${qs({ document: opts.document ? 1 : undefined })}`),
  operations: (slug: string, spec: string) => api.get<SpecOperation[]>(`${specPath(slug, spec)}/operations`),
  update: (slug: string, spec: string, patch: SpecPatch) => api.patch<ApiSpec>(specPath(slug, spec), patch),
  /** Without a source: the stored URL again, else the stored document. */
  reimport: (slug: string, spec: string, input: SpecReimportInput = {}, source?: SpecSourceInput) => api.post<SpecImportResult>(`${specPath(slug, spec)}/reimport`, { ...(source ?? {}), ...input }),
  /** mocks=keep (default) turns the spec's mocks into hand-made mocks; delete removes them. */
  remove: (slug: string, spec: string, mocks: 'keep' | 'delete' = 'keep') =>
    api.del<{ spec: Omit<ApiSpec, 'mocks' | 'issues24h' | 'mockBaseUrl'>; mocksDeleted: number; mocksKept: number }>(`${specPath(slug, spec)}${qs({ mocks })}`),
  /** Check a sample request and/or response against one operation; nothing is logged. */
  check: (slug: string, body: { spec: string; operation?: string; method?: string; path?: string; request?: ContractCheckRequest; response?: ContractCheckResponse }) =>
    api.post<ContractCheckResult>(`${base(slug)}/check`, body),
  issues: (slug: string, q: ContractIssuesQuery = {}) => api.get<ContractSummary>(issuesPath(slug, q)),
};
