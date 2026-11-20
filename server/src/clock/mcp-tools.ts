/** MCP tools for per-feature time offsets (appended to the TOOLS list in http/routes/mcp.ts). */
import { TIME_FEATURES } from './clock.js';

type Json = Record<string, unknown>;
interface TimeTool {
  name: string;
  description: string;
  inputSchema: Json;
  annotations?: Json;
  call: (a: Json) => [string, string, unknown?];
}

const s = (description: string, extra: Json = {}) => ({ type: 'string', description, ...extra });
const obj = (properties: Json, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const enc = encodeURIComponent;
const PROJECT = s('stubyard project slug, e.g. "hyper"');
const RUN = s('Test run key or id: set / read that (active) run\'s override instead of the project setting');
const url = (a: Json) => `/api/projects/${enc(String(a.project))}/time${a.run ? `?run=${enc(String(a.run))}` : ''}`;

export const TIME_MCP_TOOLS: TimeTool[] = [
  {
    name: 'set_time_offset',
    description:
      'Shift stubyard\'s clock for one feature (time travel for expiry tests; the app\'s clock is not touched). ' +
      'Features: totp (authenticator codes), auth (login-provider token iat/exp and code/refresh/access expiry), verify (Twilio/Vonage Verify code expiry on check), webhooks (signed timestamp of sent webhooks). ' +
      'offset: "+2h", "-90s", "1d", "1h30m" or 0 to clear. With run: only that test run sees the offset (it ends with the run). ' +
      'Example: feature "auth", offset "+2h" makes codes and tokens issued before look expired.',
    inputSchema: obj(
      {
        project: PROJECT,
        feature: s('Feature to shift', { enum: [...TIME_FEATURES] }),
        offset: { type: ['string', 'number'], description: 'Signed offset like "+2h", "-90s", "1d" (number = milliseconds); 0 or "" clears' },
        run: RUN,
      },
      ['project', 'feature', 'offset'],
    ),
    call: (a) => ['PUT', url(a), { offsets: { [String(a.feature)]: a.offset ?? 0 } }],
  },
  {
    name: 'get_time_offsets',
    description: 'stubyard\'s clock offsets of a project (and of a run when given): stored offsets, the effective offset and time per feature, and the real server time.',
    inputSchema: obj({ project: PROJECT, run: RUN }, ['project']),
    annotations: { readOnlyHint: true },
    call: (a) => ['GET', url(a)],
  },
];
