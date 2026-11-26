/** MCP tools for OpenAPI contracts (C1 §6), spread into TOOLS in http/routes/mcp.ts. All single-call tools. */
import { SPEC_MODES } from './repo.js';

type Json = Record<string, unknown>;
interface ContractTool {
  name: string;
  description: string;
  inputSchema: Json;
  annotations?: Json;
  call: (a: Json) => [string, string, unknown?];
}

const s = (description: string, extra: Json = {}) => ({ type: 'string', description, ...extra });
const n = (description: string) => ({ type: 'number', description });
const b = (description: string) => ({ type: 'boolean', description });
const o = (description: string) => ({ type: 'object', description });
const obj = (properties: Json, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const enc = encodeURIComponent;
const qs = (q: Record<string, unknown>) => {
  const parts = Object.entries(q)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${enc(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
};
const PROJECT = s('stubyard project slug, e.g. "hyper"');
const SPEC = s('Spec name or id (see list_api_specs)');
const MODE = s('off: no checks | report: log issues, answer as usual | strict: answer 400 on a request that breaks the spec', { enum: [...SPEC_MODES] });
const TEXT = s('The OpenAPI 3.x document, JSON or YAML text');
const URL_ = s('Or a URL to fetch the document from (http/https)');
const REMOVE_MISSING = s('Mocks of operations no longer in the spec: disable (default) | delete | keep', { enum: ['disable', 'delete', 'keep'] });
const RO = { readOnlyHint: true, openWorldHint: false };
const base = (a: Json) => `/api/projects/${enc(String(a.project))}/contracts`;
const spec = (a: Json, suffix = '') => `${base(a)}/specs/${enc(String(a.spec))}${suffix}`;
/** Some clients send the document as a JSON object instead of text. */
const textOf = (v: unknown) => (v === undefined || v === null || typeof v === 'string' ? v : JSON.stringify(v));

export const CONTRACT_MCP_TOOLS: ContractTool[] = [
  {
    name: 'import_openapi',
    description:
      'Import an OpenAPI 3.x spec (JSON or YAML text, or a URL): stubyard creates one mock per operation (example responses) under /mock/<project>/api<prefix> and checks requests to them against the spec (mode report by default). ' +
      'An existing name re-imports (edited mocks are kept unless overwrite_edited). dry_run previews the mocks without writing. The answer lists created / updated / kept / removed mocks and warnings; mockBaseUrl is in list_api_specs.',
    inputSchema: obj(
      {
        project: PROJECT,
        text: TEXT,
        url: URL_,
        name: s('Spec name (default: from info.title); an existing name re-imports'),
        prefix: s('Path prefix below /mock/<project>/api, e.g. "/crm"'),
        mode: MODE,
        role: s('mock: stubyard serves it (default) | app: your app\'s own API, checks its responses to webhooks', { enum: ['mock', 'app'] }),
        include: o('Only these operations: { tags?: string[], paths?: string[] }'),
        dry_run: b('Preview only, nothing is written'),
        overwrite_edited: b('Re-import: overwrite mocks edited by hand'),
        remove_missing: REMOVE_MISSING,
      },
      ['project'],
    ),
    call: (a) => [
      'POST',
      `${base(a)}/specs`,
      { spec: textOf(a.text), url: a.url, name: a.name, prefix: a.prefix, mode: a.mode, role: a.role, include: a.include, dryRun: a.dry_run, overwriteEdited: a.overwrite_edited, removeMissing: a.remove_missing },
    ],
  },
  {
    name: 'list_api_specs',
    description: 'OpenAPI specs of a project: name, title + version, operations, prefix, mode, mock count, issues in the last 24 h and mockBaseUrl (where its mocks answer).',
    inputSchema: obj({ project: PROJECT }, ['project']),
    annotations: RO,
    call: (a) => ['GET', `${base(a)}/specs`],
  },
  {
    name: 'get_api_spec',
    description: 'One OpenAPI spec with its operations (method, path, operationId, the mock made from it and whether that mock was edited). document: true adds the normalized document.',
    inputSchema: obj({ project: PROJECT, spec: SPEC, document: b('Include the normalized OpenAPI document') }, ['project', 'spec']),
    annotations: RO,
    call: (a) => ['GET', spec(a, qs({ document: a.document ? 1 : undefined }))],
  },
  {
    name: 'set_contract_mode',
    description:
      'Change how a spec checks traffic: mode off | report | strict (strict answers 400 with the issues; a request can override with the header X-Hub-Contract: report). Optionally also the prefix or the check options ({ unknownFields: "ignore" | "warn", checkAuth: boolean }).',
    inputSchema: obj({ project: PROJECT, spec: SPEC, mode: MODE, prefix: s('New path prefix (mock paths follow on the next re-import)'), options: o('Check options, e.g. { "unknownFields": "warn", "checkAuth": true }') }, ['project', 'spec']),
    call: (a) => ['PATCH', spec(a), { mode: a.mode, prefix: a.prefix, options: a.options }],
  },
  {
    name: 'reimport_openapi',
    description: 'Re-import a spec: new text or url, else its stored URL again, else the stored document. Mocks edited by hand are kept unless overwrite_edited; dry_run previews the changes.',
    inputSchema: obj({ project: PROJECT, spec: SPEC, text: TEXT, url: URL_, overwrite_edited: b('Overwrite mocks edited by hand'), remove_missing: REMOVE_MISSING, dry_run: b('Preview only, nothing is written') }, ['project', 'spec']),
    call: (a) => ['POST', spec(a, '/reimport'), { spec: textOf(a.text), url: a.url, overwriteEdited: a.overwrite_edited, removeMissing: a.remove_missing, dryRun: a.dry_run }],
  },
  {
    name: 'delete_api_spec',
    description: 'Delete a spec. mocks: keep (default; its mocks stay as hand-made mocks) or delete (its mocks go too).',
    inputSchema: obj({ project: PROJECT, spec: SPEC, mocks: s('keep (default) | delete', { enum: ['keep', 'delete'] }) }, ['project', 'spec']),
    annotations: { destructiveHint: true },
    call: (a) => ['DELETE', spec(a, qs({ mocks: a.mocks }))],
  },
  {
    name: 'check_contract',
    description:
      'Check a sample request and/or response against a spec operation without sending anything (nothing is logged). operation: "POST /users" or an operationId, or pass method + path (the path may include the spec prefix). ' +
      'request: { path?, params?, query?, headers?, body?, contentType? }; response: { status, headers?, body?, contentType? }. Answers the issues per side (check, where, pointer, message).',
    inputSchema: obj(
      {
        project: PROJECT,
        spec: SPEC,
        operation: s('"METHOD /path/{param}" or an operationId'),
        method: s('HTTP method (with path, instead of operation)'),
        path: s('Request path, e.g. "/crm/users/7" (with method, instead of operation)'),
        request: o('Sample request: { path?, params?, query?, headers?, body?, contentType? }'),
        response: o('Sample response: { status, headers?, body?, contentType? }'),
      },
      ['project', 'spec'],
    ),
    annotations: RO,
    call: (a) => ['POST', `${base(a)}/check`, { spec: a.spec, operation: a.operation, method: a.method, path: a.path, request: a.request, response: a.response }],
  },
  {
    name: 'get_contract_issues',
    description:
      'Contract issues found in real traffic (requests to spec mocks, your app\'s responses, provider requests): counts, issues per check and per spec, and the newest violations with their log id (see get_request). Filter by run, spec, level (lowest level listed, default warn), subject or time.',
    inputSchema: obj(
      {
        project: PROJECT,
        run: s('Test run key or id: only that run\'s traffic'),
        spec: s('Spec name'),
        level: s('Lowest level listed in violations (default warn)', { enum: ['error', 'warn', 'info'] }),
        subject: s('mock-request | app-response | provider-request', { enum: ['mock-request', 'app-response', 'provider-request'] }),
        since: s('ISO timestamp'),
        until: s('ISO timestamp'),
        limit: n('Max violations (default 50, max 500)'),
      },
      ['project'],
    ),
    annotations: RO,
    call: (a) => ['GET', `${base(a)}/issues${qs({ run: a.run, spec: a.spec, level: a.level, subject: a.subject, since: a.since, until: a.until, limit: a.limit })}`],
  },
];
