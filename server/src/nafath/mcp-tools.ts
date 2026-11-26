/**
 * MCP tools for fake Nafath (B5 §6), spread into TOOLS in http/routes/mcp.ts. approve_nafath is composite (it finds the
 * WAITING request, then decides it) and has a COMPOSITE_ROUTE line; the others are single-call tools.
 */
import { FAULT_HELP } from './faults.js';
import { AUTO_DECISIONS, NAFATH_STATUSES } from './types.js';

type Json = Record<string, unknown>;
interface NafathTool {
  name: string;
  description: string;
  inputSchema: Json;
  annotations?: Json;
  call?: (a: Json) => [string, string, unknown?];
  run?: (a: Json, ctx: { api: (method: string, url: string, body?: unknown) => Promise<any> }) => Promise<unknown>;
}

const s = (description: string, extra: Json = {}) => ({ type: 'string', description, ...extra });
const n = (description: string) => ({ type: 'number', description });
const b = (description: string) => ({ type: 'boolean', description });
const obj = (properties: Json, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const enc = encodeURIComponent;
const qs = (q: Record<string, unknown>) => {
  const parts = Object.entries(q)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${enc(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
};
const PROJECT = s('stubyard project slug, e.g. "hyper"');
const USER = s('Test user: id, email, national ID, phone, name or role ("unassigned": requests for unknown IDs)');
const NATIONAL_ID = s('National ID or Iqama number (10 digits)');
const RUN = s('Test run key or id: only that run\'s requests');
const RO = { readOnlyHint: true, openWorldHint: false };
const base = (a: Json) => `/api/projects/${enc(String(a.project))}/nafath`;

export const NAFATH_MCP_TOOLS: NafathTool[] = [
  {
    name: 'list_nafath_requests',
    description: 'Nafath requests your app started (newest first): transId, the number shown (random), the three choices, national ID, user, status (WAITING | COMPLETED | REJECTED | EXPIRED), reason, decidedBy, callback attempts.',
    inputSchema: obj(
      {
        project: PROJECT,
        user: USER,
        status: s(`Status, comma separated (${NAFATH_STATUSES.join(', ')})`),
        run: RUN,
        limit: n('Max requests (default 100, max 500)'),
      },
      ['project'],
    ),
    annotations: RO,
    call: (a) => ['GET', `${base(a)}/requests${qs({ user: a.user, status: a.status, run: a.run, limit: a.limit })}`],
  },
  {
    name: 'wait_for_nafath_request',
    description:
      'Wait until your app starts a Nafath request (POST /api/v1/mfa/request), e.g. after clicking "Log in with Nafath". Without a cursor, requests of the last 10 seconds count (with status, any matching one). ' +
      'Answers { timedOut, request, cursor }; pass cursor as after to wait for the next one. Then decide it with approve_nafath.',
    inputSchema: obj(
      {
        project: PROJECT,
        user: USER,
        national_id: NATIONAL_ID,
        status: s('Only requests in this status, e.g. "WAITING"'),
        after: s('Cursor: only requests after this request id'),
        timeout_seconds: n('Seconds to wait (default 30, max 120)'),
        run: RUN,
      },
      ['project'],
    ),
    annotations: RO,
    call: (a) => ['GET', `${base(a)}/requests/wait${qs({ user: a.user, nationalId: a.national_id, status: a.status, after: a.after, timeout: a.timeout_seconds, run: a.run })}`],
  },
  {
    name: 'approve_nafath',
    description:
      'Act as the person in the Nafath app: decide a WAITING request. decision approve (default) taps the right number, or `number` if given (a wrong one fails like wrong_number); reject taps Reject; wrong_number taps a wrong number. ' +
      'Pick the request by id, else the WAITING request of user (or of the project), waiting up to wait_seconds (default 10, max 120) for the app to start it. Answers the decided request (status, reason, token).',
    inputSchema: obj(
      {
        project: PROJECT,
        id: s('Request id or transId (see list_nafath_requests)'),
        user: USER,
        decision: s('approve | reject | wrong_number (default approve)', { enum: ['approve', 'reject', 'wrong_number'] }),
        number: s('The 2-digit number to tap (default: the right one)'),
        wait_seconds: n('Seconds to wait for a WAITING request when no id is given (default 10, max 120)'),
        run: RUN,
      },
      ['project'],
    ),
    run: async (a, { api }) => {
      const decision = String(a.decision ?? 'approve');
      if (!['approve', 'reject', 'wrong_number'].includes(decision)) throw new Error('decision must be one of: approve, reject, wrong_number');
      let r: Json;
      if (a.id) r = await api('GET', `${base(a)}/requests/${enc(String(a.id))}`);
      else {
        const timeout = Math.min(Math.max(Number(a.wait_seconds ?? 10) || 0, 0), 120);
        const w = (await api('GET', `${base(a)}/requests/wait${qs({ user: a.user, status: 'WAITING', timeout, run: a.run })}`)) as Json;
        if (!w.request) throw new Error(`No WAITING Nafath request${a.user ? ` for "${String(a.user)}"` : ''} within ${timeout} s: start the login in the app first (or raise wait_seconds)`);
        r = w.request as Json;
      }
      const url = `${base(a)}/requests/${enc(String(r.id))}`;
      if (decision === 'reject') return api('POST', `${url}/reject`);
      const random = String(r.random);
      const number = decision === 'wrong_number' ? (a.number !== undefined && String(a.number) !== random ? String(a.number) : (r.choices as string[]).find((c) => c !== random)) : (a.number ?? random);
      return api('POST', `${url}/choose`, { number });
    },
  },
  {
    name: 'set_nafath_fault',
    description:
      `Make fake Nafath fail or decide on purpose. fault: ${FAULT_HELP.map((f) => f.fault).join(' | ')} (none clears the fault rules, of the run or user if given). ` +
      'Match by instance, user or national_id; times: only the next N requests (default every request). Inside a run (run) it is cleared with the run.',
    inputSchema: obj(
      {
        project: PROJECT,
        fault: s('Fault, e.g. "rejected", "approve:2000", "down", "bad_signature", "none"'),
        instance: s('Nafath instance slug or id'),
        user: USER,
        national_id: NATIONAL_ID,
        times: n('Only the next N matching requests'),
        run: s('Active test run key or id: the fault only applies to that run'),
      },
      ['project', 'fault'],
    ),
    call: (a) => ['POST', `${base(a)}/faults`, { fault: a.fault, instance: a.instance, user: a.user, nationalId: a.national_id, times: a.times, run: a.run }],
  },
  {
    name: 'reset_nafath',
    description: 'Delete the Nafath requests of a project (or of one user / run) and cancel their pending decisions and callbacks. Instances and fault rules stay (clear faults with set_nafath_fault "none").',
    inputSchema: obj({ project: PROJECT, user: USER, run: RUN }, ['project']),
    annotations: { destructiveHint: true },
    call: (a) => ['DELETE', `${base(a)}/requests${qs({ user: a.user, run: a.run })}`],
  },
  {
    name: 'create_nafath_instance',
    description:
      'Create a fake Nafath instance (its own APP-ID, APP-KEY and signing key). The answer has the URLs your app points at (request, status, info, jwk) and the credentials. ' +
      `auto_decision (${AUTO_DECISIONS.join(' | ')}) decides every request by itself after a delay; strict checks credentials and unknown IDs like real Nafath.`,
    inputSchema: obj(
      {
        project: PROJECT,
        slug: s('Instance slug (default "nafath", then "nafath-2", …)'),
        callback_url: s('Your app\'s callback URL (stubyard posts the signed result there)'),
        auto_decision: s('Decide by itself (default none)', { enum: [...AUTO_DECISIONS] }),
        strict: b('Strict mode (default false)'),
      },
      ['project'],
    ),
    call: (a) => {
      const config: Json = {};
      if (a.callback_url !== undefined) config.callbackUrl = a.callback_url;
      if (a.auto_decision !== undefined) config.autoDecision = a.auto_decision;
      return ['POST', `${base(a)}/instances`, { slug: a.slug, strict: a.strict, config: Object.keys(config).length ? config : undefined }];
    },
  },
];
