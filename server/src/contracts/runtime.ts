// OpenAPI contracts (C1): runtime checks of live traffic (§3.4, §3.5).
// - checkMockRequest: a /mock/<project>/api request against the role=mock spec that covers its path (report or
//   strict; strict answers the stubyard-shaped contract error instead of the mock).
// - checkAppResponse: the app's answer to stubyard's own outbound calls (webhook deliveries, callbacks) against the
//   template's `contract` or an auto-matched role=app spec. Wired through TrafficLogger.outboundObserver.
// Provider contracts (§4) will build their ContractResult with `buildResult` + `recordContract` too.

import type { FastifyRequest } from 'fastify';
import type { Hub } from '../hub.js';
import type { Project } from '../repos/projects.js';
import type { OutboundRequest } from '../traffic/outbound.js';
import { findOperation } from './openapi.js';
import { capIssues, validateRequest, validateResponse, type ContractRequest } from './validate.js';
import {
  countIssues,
  levelOf,
  type CompiledOperation,
  type CompiledSpec,
  type ContractIssue,
  type ContractResult,
  type ContractSubject,
  type SpecRecord,
} from './types.js';

// ---------------------------------------------------------------------------------------------------------------
// "Does this project have specs?" (the fast path for projects without contracts)

interface SpecPresence {
  mock: boolean;
  app: boolean;
}

const presence = new WeakMap<Hub, Map<string, SpecPresence>>();

function specPresence(hub: Hub, projectId: string): SpecPresence {
  let byProject = presence.get(hub);
  if (!byProject) presence.set(hub, (byProject = new Map()));
  let p = byProject.get(projectId);
  if (!p) {
    const specs = hub.contracts.list(projectId).filter((s) => s.mode !== 'off');
    p = { mock: specs.some((s) => s.role === 'mock'), app: specs.some((s) => s.role === 'app') };
    byProject.set(projectId, p);
  }
  return p;
}

/** Hooks the contract checks into the hub's traffic (called by ContractService's constructor). */
export function installObserver(hub: Hub): void {
  presence.set(hub, new Map());
  // Specs change through ContractService (contracts.changed); project import / reset / delete write api_specs directly.
  hub.bus.subscribe((e) => {
    if (e.type === 'contracts.changed' && e.projectId) presence.get(hub)?.delete(e.projectId);
    else if (e.type.startsWith('project.')) presence.get(hub)?.clear();
  });
  hub.traffic.outboundObserver = (req, res) => {
    if (!req.projectId) return;
    checkAppResponse(hub, req.projectId, { req, ...res });
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Results

/** Credential headers: their values never appear in an issue. */
const SECRET_HEADERS = ['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'api-key'];

/** Values (at least 4 chars) taken from credential headers, so no issue can echo them. */
function secretValues(headers: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const name of SECRET_HEADERS) {
    const raw = headers[name];
    for (const v of Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]) {
      const s = String(v);
      const parts = name.endsWith('cookie') ? s.split(';').map((c) => c.slice(c.indexOf('=') + 1).trim()) : [s, s.replace(/^\S+\s+/, '')];
      for (const p of parts) if (p.length >= 4) out.push(p);
    }
  }
  return out;
}

/** Decision 9: no auth / cookie values in `actual` / `expected` (maskActual already masked card digits and clipped). */
function scrub(issues: ContractIssue[], secrets: string[]): ContractIssue[] {
  return issues.map((i) => {
    const secretName = i.name !== undefined && SECRET_HEADERS.includes(i.name.toLowerCase());
    const leaks = (s: string | undefined) => {
      if (s === undefined) return false;
      const head = s.replace(/…$/, '');
      return secrets.some((v) => s.includes(v) || (head.length >= 8 && v.includes(head)));
    };
    if (!(i.where === 'auth' || i.where === 'cookie' || secretName || leaks(i.actual) || leaks(i.expected))) return i;
    const { actual: _a, expected, ...rest } = i;
    return leaks(expected) || expected === undefined ? rest : { ...rest, expected };
  });
}

/** A ContractResult from the full issue list: counts and level over all of it, then capped to 50. */
export function buildResult(
  base: Pick<ContractResult, 'subject' | 'source' | 'spec' | 'provider' | 'operation' | 'mode'> & { enforced?: boolean },
  issues: ContractIssue[],
): ContractResult {
  const capped = capIssues(issues);
  return {
    v: 1,
    subject: base.subject,
    source: base.source,
    spec: base.spec,
    provider: base.provider,
    operation: base.operation,
    mode: base.mode,
    enforced: base.enforced ?? false,
    level: levelOf(issues),
    counts: countIssues(issues),
    issues: capped.issues,
    ...(capped.truncated ? { truncated: true } : {}),
  };
}

/** Store a result on its traffic log (publishes log.updated) and mirror a short form into `resolved.contract`. */
export function recordContract(hub: Hub, logId: string | null | undefined, result: ContractResult | null): void {
  if (!logId || !result) return;
  hub.traffic.update(logId, { contract: result, contractLevel: result.level });
  hub.traffic.mergeResolved(logId, { contract: { spec: result.spec?.name ?? result.provider?.preset ?? null, operation: result.operation?.key ?? null, level: result.level } });
}

const specRef = (s: SpecRecord): ContractResult['spec'] => ({ id: s.id, name: s.name, version: s.apiVersion });
const opRef = (op: CompiledOperation): ContractResult['operation'] => ({ key: op.key, operationId: op.operationId, deprecated: op.deprecated });

function issue(check: ContractIssue['check'], severity: ContractIssue['severity'], side: ContractIssue['side'], message: string, expected?: string): ContractIssue {
  return { check, severity, side, where: 'operation', message, ...(expected ? { expected: expected.length > 80 ? `${expected.slice(0, 79)}…` : expected } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------
// Mock requests (§3.4)

type MockReq = FastifyRequest<{ Params: { '*': string } }>;

export interface MockContractCheck {
  result: ContractResult | null;
  /** Strict mode with error-level issues: answer this instead of the mock (outcome `invalid`). */
  strictReply?: { status: number; body: Record<string, unknown> };
}

function headerOf(req: MockReq, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function queryOf(url: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const i = url.indexOf('?');
  if (i < 0) return out;
  for (const [k, v] of new URLSearchParams(url.slice(i + 1))) {
    const cur = out[k];
    out[k] = cur === undefined ? v : Array.isArray(cur) ? [...cur, v] : [cur, v];
  }
  return out;
}

/**
 * Check a /mock/<project>/api request against the role=mock spec covering its path. `result` is null when no spec
 * covers the path (or X-Hub-Contract: off). Unknown operations and wrong methods are issues too.
 */
export function checkMockRequest(hub: Hub, project: Project, req: MockReq): MockContractCheck {
  if (!hub.contracts || !specPresence(hub, project.id).mock) return { result: null };
  const override = headerOf(req, 'x-hub-contract')?.trim().toLowerCase();
  if (override === 'off') return { result: null };
  const path = '/' + (req.params['*'] ?? '');
  const match = hub.contracts.specForMockPath(project.id, req.method, path);
  if (!match) return { result: null };

  const { spec, compiled } = match;
  const mode: ContractResult['mode'] = override === 'strict' || override === 'report' ? override : spec.mode === 'strict' ? 'strict' : 'report';
  const base = { subject: 'mock-request' as ContractSubject, source: 'spec' as const, spec: specRef(spec), provider: null, mode };
  let issues: ContractIssue[];
  let operation: ContractResult['operation'] = null;
  let opLabel = `${req.method.toUpperCase()} ${path.split('?')[0]}`;
  if ('unknownOperation' in match) {
    issues = [issue('contract.unknown-operation', 'error', 'request', `${opLabel} is not in the spec "${spec.name}"`)];
  } else if ('methodNotAllowed' in match) {
    issues = [issue('contract.method-not-allowed', 'error', 'request', `${req.method.toUpperCase()} is not allowed here by the spec "${spec.name}"`, match.methodNotAllowed.join(', '))];
  } else {
    operation = opRef(match.op);
    opLabel = match.op.key;
    const rel = path.split('?')[0].slice(spec.prefix.length) || '/';
    const raw = req.rawBody ?? (typeof req.body === 'string' ? req.body : Buffer.isBuffer(req.body) ? req.body : undefined);
    const creq: ContractRequest = {
      method: req.method.toUpperCase(),
      path: rel,
      params: match.params,
      query: queryOf(req.url),
      headers: req.headers as ContractRequest['headers'],
      body: raw,
      contentType: headerOf(req, 'content-type'),
    };
    issues = validateRequest(compiled, match.op, creq, spec.options);
    // Strict mode enforces credentials too: a missing one is an error there (answered 401).
    if (mode === 'strict') issues = issues.map((i) => (i.check === 'contract.auth-missing' ? { ...i, severity: 'error' } : i));
  }
  issues = scrub(issues, secretValues(req.headers));

  const enforce = mode === 'strict' && levelOf(issues) === 'error';
  const result = buildResult({ ...base, operation, enforced: enforce }, issues);
  if (!enforce) return { result };
  const errors = issues.filter((i) => i.severity === 'error');
  const authOnly = errors.every((i) => i.check === 'contract.auth-missing');
  return {
    result,
    strictReply: {
      status: authOnly ? 401 : 400,
      body: {
        error: 'Request does not match the OpenAPI contract',
        spec: spec.name,
        operation: opLabel,
        issues: result.issues,
        ...(result.truncated ? { truncated: true } : {}),
        requestId: req.trafficLogId,
        hint: override === 'strict'
          ? 'Contract mode is strict for this request (X-Hub-Contract: strict). Send X-Hub-Contract: report to only record issues.'
          : 'Contract mode is strict. Send X-Hub-Contract: report to only record issues.',
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The app's responses to stubyard calls (§3.5)

export interface AppCall {
  req: OutboundRequest;
  logId: string;
  status: number;
  headers: Record<string, string>;
  /** The full response text (not clipped). */
  text: string;
}

/** The path of each `servers[].url` (absolute or relative), longest first. */
function serverPaths(spec: CompiledSpec): string[] {
  const out = new Set<string>();
  for (const s of spec.spec.document.servers ?? []) {
    if (typeof s?.url !== 'string') continue;
    let p: string;
    try {
      p = new URL(s.url, 'http://x').pathname;
    } catch {
      continue;
    }
    p = p.replace(/\/+$/, '');
    if (p && p !== '/') out.add(p);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** The operation for a concrete URL path: with each server path stripped, then as is. */
function matchPath(spec: CompiledSpec, method: string, path: string): { op: CompiledOperation } | { methodNotAllowed: string[] } | null {
  let notAllowed: { methodNotAllowed: string[] } | null = null;
  for (const prefix of [...serverPaths(spec), '']) {
    if (prefix && path !== prefix && !path.startsWith(prefix + '/')) continue;
    const m = findOperation(spec, method, path.slice(prefix.length) || '/');
    if (!m) continue;
    if ('op' in m) return { op: m.op };
    notAllowed ??= m;
  }
  return notAllowed;
}

/**
 * Check the app's response to an outbound call: against the call's explicit `contract` (a webhook template's), else
 * the first role=app spec whose operation matches method + path. Records the result on the call's log; null when
 * nothing applies. There is no strict mode for responses.
 */
export function checkAppResponse(hub: Hub, projectId: string, call: AppCall): ContractResult | null {
  if (!hub.contracts) return null;
  const explicit = call.req.contract;
  if (!explicit && !specPresence(hub, projectId).app) return null;
  const method = (call.req.method ?? 'POST').toUpperCase();
  let path: string;
  try {
    path = new URL(call.req.url).pathname;
  } catch {
    return null;
  }
  const base = { subject: 'app-response' as ContractSubject, source: 'spec' as const, provider: null };

  let target: { compiled: CompiledSpec; op: CompiledOperation } | null = null;
  if (explicit) {
    const spec = hub.contracts.specs.byName(projectId, explicit.spec);
    if (!spec) {
      const result = buildResult({ ...base, spec: null, operation: null, mode: 'report' }, [
        issue('contract.unchecked', 'info', 'response', `The template's contract spec "${explicit.spec}" is not imported in this project`),
      ]);
      recordContract(hub, call.logId, result);
      return result;
    }
    if (spec.mode === 'off') return null;
    const compiled = hub.contracts.compiled(spec);
    const mode: ContractResult['mode'] = spec.mode === 'strict' ? 'strict' : 'report';
    const named = explicit.operation ? compiled.byKey.get(explicit.operation) : undefined;
    const found = named ? { op: named } : explicit.operation ? null : matchPath(compiled, method, path);
    if (!found || !('op' in found)) {
      const what = explicit.operation ?? `${method} ${path}`;
      const result = buildResult({ ...base, spec: specRef(spec), operation: null, mode }, [
        found && 'methodNotAllowed' in found
          ? issue('contract.method-not-allowed', 'error', 'request', `${method} is not allowed for ${path} by the spec "${spec.name}"`, found.methodNotAllowed.join(', '))
          : issue('contract.unknown-operation', 'error', 'request', `${what} is not in the spec "${spec.name}"`),
      ]);
      recordContract(hub, call.logId, result);
      return result;
    }
    target = { compiled, op: found.op };
  } else {
    for (const compiled of hub.contracts.appSpecsFor(projectId)) {
      const m = matchPath(compiled, method, path);
      if (m && 'op' in m) {
        target = { compiled, op: m.op };
        break;
      }
    }
    if (!target) return null;
  }

  const { compiled, op } = target;
  const spec = compiled.spec;
  const contentType = Object.entries(call.headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1];
  const issues = validateResponse(compiled, op, { status: call.status, headers: call.headers, body: call.text, contentType }, spec.options);
  const result = buildResult(
    { ...base, spec: specRef(spec), operation: opRef(op), mode: spec.mode === 'strict' ? 'strict' : 'report' },
    scrub(issues, secretValues({ ...lowerKeys(call.req.headers ?? {}), ...lowerKeys(call.headers) })),
  );
  recordContract(hub, call.logId, result);
  return result;
}

function lowerKeys(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}
