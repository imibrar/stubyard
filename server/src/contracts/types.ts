// OpenAPI contract checks (C1): shared types. No imports, so every contracts module, the log repo and the web
// types can depend on this file.

export type ContractSeverity = 'error' | 'warn' | 'info';
export type ContractSubject = 'mock-request' | 'app-response' | 'provider-request';

export const CONTRACT_CHECKS = [
  { id: 'contract.unknown-operation', severity: 'error', label: 'Endpoint not in the spec' },
  { id: 'contract.method-not-allowed', severity: 'error', label: 'Method not in the spec' },
  { id: 'contract.param', severity: 'error', label: 'Parameter invalid or missing' },
  { id: 'contract.unknown-param', severity: 'warn', label: 'Undeclared parameter' },
  { id: 'contract.content-type', severity: 'error', label: 'Content type not accepted' },
  { id: 'contract.body-missing', severity: 'error', label: 'Required body missing' },
  { id: 'contract.body', severity: 'error', label: 'Body does not match the schema' },
  { id: 'contract.unknown-field', severity: 'warn', label: 'Undeclared body field' },
  { id: 'contract.read-only', severity: 'warn', label: 'readOnly field sent' },
  { id: 'contract.auth-missing', severity: 'warn', label: 'Credentials missing' },
  { id: 'contract.deprecated', severity: 'warn', label: 'Deprecated operation / parameter / field used' },
  { id: 'contract.response-status', severity: 'error', label: 'Status not declared' },
  { id: 'contract.response-body', severity: 'error', label: 'Response body does not match' },
  { id: 'contract.response-header', severity: 'warn', label: 'Response header missing / invalid' },
  { id: 'contract.unchecked', severity: 'info', label: 'Could not be checked' },
] as const;

export type ContractCheckId = (typeof CONTRACT_CHECKS)[number]['id'];

export interface ContractIssue {
  check: ContractCheckId;
  severity: ContractSeverity;
  side: 'request' | 'response';
  where: 'path' | 'query' | 'header' | 'cookie' | 'body' | 'status' | 'content-type' | 'auth' | 'operation';
  name?: string;
  pointer?: string;
  message: string;
  /** At most 80 chars, never credentials; card-like digits are masked on /pay. */
  actual?: string;
  expected?: string;
}

/** Stored in traffic_logs.contract. */
export interface ContractResult {
  v: 1;
  subject: ContractSubject;
  source: 'spec' | 'provider';
  spec: { id: string; name: string; version: string } | null;
  provider: { preset: string; instance: string } | null;
  operation: { key: string; operationId: string | null; deprecated: boolean } | null;
  mode: 'report' | 'strict';
  enforced: boolean;
  level: ContractSeverity | null;
  counts: { error: number; warn: number; info: number };
  /** At most 50 issues; `truncated` is set when more were found (counts stay exact). */
  issues: ContractIssue[];
  truncated?: boolean;
}

/** Maximum issues kept in one ContractResult. */
export const MAX_CONTRACT_ISSUES = 50;

// ---------------------------------------------------------------------------------------------------------------
// Normalized specs

/** A normalized OpenAPI 3.x document (3.0 input is converted to 3.1 shapes; `$ref`s are kept). Loosely typed. */
export interface SpecDocument {
  openapi: string;
  info?: { title?: string; version?: string; [k: string]: unknown };
  servers?: { url: string; [k: string]: unknown }[];
  paths?: Record<string, Record<string, unknown>>;
  components?: Record<string, Record<string, unknown>>;
  security?: Record<string, string[]>[];
  tags?: { name: string; [k: string]: unknown }[];
  [k: string]: unknown;
}

export type SpecRole = 'mock' | 'app';
export type SpecMode = 'off' | 'report' | 'strict';

export interface SpecSource {
  kind: 'upload' | 'url' | 'inline';
  url?: string;
  filename?: string;
}

export interface SpecOptions {
  unknownParams: 'ignore' | 'warn';
  unknownFields: 'ignore' | 'warn';
  checkAuth: boolean;
  include: { tags?: string[]; paths?: string[] };
}

/** An api_specs row. */
export interface SpecRecord {
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
  source: SpecSource;
  document: SpecDocument;
  options: SpecOptions;
  warnings: string[];
  /** Number of operations in the document. */
  operations: number;
  hash: string;
  createdAt: string;
  updatedAt: string;
}

/** A resolved parameter object (OpenAPI `in` + name + schema). */
export interface SpecParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  deprecated?: boolean;
  schema?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface CompiledOperation {
  /** "GET /users/{id}" */
  key: string;
  method: string;
  pathTemplate: string;
  /** Matches a concrete path (relative to the spec prefix); groups in `paramNames` order. */
  regex: RegExp;
  paramNames: string[];
  parameters: SpecParameter[];
  requestBody: Record<string, unknown> | null;
  responses: Record<string, unknown>;
  /** Effective security requirements (operation level, else document level); [] = none. */
  security: Record<string, string[]>[];
  deprecated: boolean;
  operationId: string | null;
  summary: string | null;
  tags: string[];
}

export interface CompiledSpec {
  spec: SpecRecord;
  operations: CompiledOperation[];
  /** By `key`. */
  byKey: Map<string, CompiledOperation>;
  warnings: string[];
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers

const RANK: Record<ContractSeverity, number> = { error: 3, warn: 2, info: 1 };

/** Worst severity among the issues, or null when there are none. */
export function levelOf(issues: readonly { severity: ContractSeverity }[]): ContractSeverity | null {
  let worst: ContractSeverity | null = null;
  for (const i of issues) if (!worst || RANK[i.severity] > RANK[worst]) worst = i.severity;
  return worst;
}

export function countIssues(issues: readonly { severity: ContractSeverity }[]): ContractResult['counts'] {
  const counts = { error: 0, warn: 0, info: 0 };
  for (const i of issues) counts[i.severity]++;
  return counts;
}

const LABELS = new Map<string, string>(CONTRACT_CHECKS.map((c) => [c.id, c.label]));

/** Human label of a check id (the id itself when unknown). */
export function checkLabel(id: string): string {
  return LABELS.get(id) ?? id;
}
