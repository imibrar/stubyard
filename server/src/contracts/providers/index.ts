// Provider contracts (C1 §4): curated per-endpoint contracts for the built-in fakes, so an app that sends a request
// the real provider would reject finds out against stubyard too. Each provider file holds its operations as JSON
// Schema subsets; this module compiles them into a spec once, checks requests with the shared validator and records
// the result on the request's traffic log (subject 'provider-request', source 'provider').
//
// The mode is the instance's `config.contract`: 'off' (default), 'report' (record only) or 'strict' (also answer the
// provider's own error instead of the fake). `true` is an alias of 'strict'; `contractMode` is read as an alias key.

import type { Hub } from '../../hub.js';
import type { JsonSchema } from '../../webhooks/schema.js';
import { compileSpec, findOperation } from '../openapi.js';
import { buildResult, recordContract } from '../runtime.js';
import { validateRequest, type ContractRequest } from '../validate.js';
import type { CompiledSpec, ContractIssue, ContractResult, SpecDocument } from '../types.js';
import { moyasarContract } from './moyasar.js';
import { paypalContract } from './paypal.js';
import { stripeContract } from './stripe.js';

export interface ProviderOperation {
  method: string;
  /** OpenAPI path template below the instance base ("/v1/payment_intents/{intent}"). */
  path: string;
  operationId: string;
  encoding: 'json' | 'form';
  /** Object schema: each property is one query parameter (`required` lists the required ones). */
  query?: JsonSchema;
  /** Request body schema; the body is required when the schema lists required properties. */
  body?: JsonSchema;
  /** Names of deprecated query / top-level body params. */
  deprecated?: string[];
  /** Where the contract comes from (reference URL). */
  source: string;
}

export interface ProviderContract {
  /** Payment preset id (PaymentInstance.preset). */
  preset: string;
  title: string;
  version: string;
  operations: ProviderOperation[];
  /** Undeclared query params are errors (the provider rejects them), not warnings. */
  closed?: boolean;
  /** Requests the contract does not cover (Stripe: the fake Stripe.js's publishable-key calls). */
  skip?(req: ProviderRequest): boolean;
  /** The provider's own error answer for a request with error-level issues (strict mode). */
  strictError(issues: ContractIssue[], op: ProviderOperation): { status: number; headers?: Record<string, string>; body: unknown };
}

export type ProviderContractMode = 'off' | 'report' | 'strict';

/** Registered provider contracts, by preset. */
const CONTRACTS = new Map<string, ProviderContract>([stripeContract, paypalContract, moyasarContract].map((c) => [c.preset, c]));

export function providerContract(preset: string): ProviderContract | null {
  return CONTRACTS.get(preset) ?? null;
}

/** The instance's provider contract mode (config.contract; unknown values read as 'off'). */
export function contractModeOf(config: Record<string, unknown> | null | undefined): ProviderContractMode {
  const v = config?.contract ?? config?.contractMode;
  if (v === true || v === 'strict') return 'strict';
  return v === 'report' ? 'report' : 'off';
}

const MEDIA: Record<ProviderOperation['encoding'], string> = { json: 'application/json', form: 'application/x-www-form-urlencoded' };

type Obj = Record<string, unknown>;

function markDeprecated(schema: JsonSchema | undefined, names: string[] | undefined): JsonSchema | undefined {
  const props = (schema as Obj | undefined)?.properties as Record<string, Obj> | undefined;
  if (!schema || !props || !names?.length) return schema;
  return { ...(schema as Obj), properties: Object.fromEntries(Object.entries(props).map(([k, s]) => [k, names.includes(k) ? { ...s, deprecated: true } : s])) } as JsonSchema;
}

/** The contract as an OpenAPI 3.1 document, compiled once. */
const compiledCache = new WeakMap<ProviderContract, { compiled: CompiledSpec; byKey: Map<string, ProviderOperation> }>();

function compiledOf(pc: ProviderContract): { compiled: CompiledSpec; byKey: Map<string, ProviderOperation> } {
  const hit = compiledCache.get(pc);
  if (hit) return hit;
  const paths: Record<string, Obj> = {};
  const byKey = new Map<string, ProviderOperation>();
  for (const o of pc.operations) {
    const query = markDeprecated(o.query, o.deprecated) as Obj | undefined;
    const body = markDeprecated(o.body, o.deprecated) as Obj | undefined;
    const required = new Set(Array.isArray(query?.required) ? (query!.required as string[]) : []);
    const parameters = Object.entries((query?.properties as Record<string, Obj> | undefined) ?? {}).map(([name, schema]) => ({
      name,
      in: 'query',
      ...(required.has(name) ? { required: true } : {}),
      ...(schema.deprecated === true ? { deprecated: true } : {}),
      schema,
    }));
    const params = [...o.path.matchAll(/\{([^}]+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    const item = (paths[o.path] ??= {});
    item[o.method.toLowerCase()] = {
      operationId: o.operationId,
      parameters: [...params, ...parameters],
      ...(body
        ? { requestBody: { required: Array.isArray(body.required) && body.required.length > 0, content: { [MEDIA[o.encoding]]: { schema: body } } } }
        : {}),
      responses: { default: { description: 'Provider response' } },
    };
    byKey.set(`${o.method.toUpperCase()} ${o.path}`, o);
  }
  const doc: SpecDocument = { openapi: '3.1.0', info: { title: pc.title, version: pc.version }, paths };
  const out = { compiled: compileSpec(doc), byKey };
  compiledCache.set(pc, out);
  return out;
}

/** One request to a fake provider: as ContractRequest, without the path params (the contract finds them). */
export type ProviderRequest = Omit<ContractRequest, 'params'>;

export interface ProviderCheck {
  result: ContractResult | null;
  /** Strict mode with error-level issues: answer this instead of the fake (outcome `invalid`). */
  strictReply?: { status: number; headers?: Record<string, string>; body: unknown };
}

/**
 * Check a request to a fake provider against its contract and record the result on the traffic log. `result` is
 * null when the contract mode is off (the default), the preset has no contract, or the endpoint is not in it.
 */
export function checkProviderRequest(
  hub: Hub,
  inst: { preset: string; slug: string; config: Record<string, unknown> },
  req: ProviderRequest,
  logId: string | null | undefined,
): ProviderCheck {
  const mode = contractModeOf(inst.config);
  if (mode === 'off') return { result: null };
  const pc = providerContract(inst.preset);
  if (!pc || pc.skip?.(req)) return { result: null };
  const { compiled, byKey } = compiledOf(pc);
  const match = findOperation(compiled, req.method, req.path);
  if (!match || !('op' in match)) return { result: null };
  const pop = byKey.get(match.op.key)!;

  let issues = validateRequest(compiled, match.op, { ...req, params: match.params }, { unknownParams: 'warn', unknownFields: 'ignore', checkAuth: false });
  if (pc.closed) issues = issues.map((i) => (i.check === 'contract.unknown-param' ? { ...i, severity: 'error' } : i));
  const enforce = mode === 'strict' && issues.some((i) => i.severity === 'error');
  const result = buildResult(
    {
      subject: 'provider-request',
      source: 'provider',
      spec: null,
      provider: { preset: inst.preset, instance: inst.slug },
      operation: { key: match.op.key, operationId: match.op.operationId, deprecated: match.op.deprecated },
      mode,
      enforced: enforce,
    },
    issues,
  );
  recordContract(hub, logId, result);
  return enforce ? { result, strictReply: pc.strictError(issues, pop) } : { result };
}
