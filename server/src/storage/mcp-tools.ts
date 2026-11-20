import { STORAGE_ACTIONS, STORAGE_OPS } from './types.js';

/** MCP tools for the file storage simulator (appended to the TOOLS list in http/routes/mcp.ts). */
type Json = Record<string, unknown>;
interface StorageTool {
  name: string;
  description: string;
  inputSchema: Json;
  annotations?: Json;
  call?: (a: Json) => [string, string, unknown?];
  run?: (a: Json, ctx: { api: (method: string, url: string, body?: unknown) => Promise<any> }) => Promise<unknown>;
}

const s = (description: string, extra: Json = {}) => ({ type: 'string', description, ...extra });
const n = (description: string) => ({ type: 'number', description });
const obj = (properties: Json, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const enc = encodeURIComponent;
const PROJECT = s('stubyard project slug, e.g. "hyper"');
const INSTANCE = s('Storage instance slug, e.g. "s3" (see list_storage)');
const BUCKET = s('Bucket name');
const RUN = s('Test run key: scope the rule to that run (deleted when the run stops)');
const qs = (o: Json) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const str = p.toString();
  return str ? `?${str}` : '';
};
const base = (a: Json) => `/api/projects/${enc(String(a.project))}/storage`;
const inst = (a: Json) => `${base(a)}/${enc(String(a.instance))}`;
const bucket = (a: Json) => `${inst(a)}/buckets/${enc(String(a.bucket))}`;

const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-ndjson|csv|yaml)|image\/svg)/i;

export const STORAGE_MCP_TOOLS: StorageTool[] = [
  {
    name: 'list_storage',
    description: 'Fake file storage instances of a project (S3, Cloudflare R2, DigitalOcean Spaces, Backblaze B2, MinIO, Wasabi, …) with endpoints (backend / Docker / browser), credentials, usage and buckets.',
    inputSchema: obj({ project: PROJECT }, ['project']),
    annotations: { readOnlyHint: true },
    run: async (a, { api }) => {
      const list = (await api('GET', base(a))) as Json[];
      const out = [];
      for (const i of list) {
        const buckets = (await api('GET', `${base(a)}/${enc(String(i.slug))}/buckets`)) as Json[];
        out.push({ slug: i.slug, preset: i.preset, name: i.name, strict: (i.config as Json)?.strict === true, urls: i.urls, region: i.region, credentials: i.credentials, usage: i.usage, buckets: buckets.map((b) => ({ name: b.name, objects: b.objects, bytes: b.bytes, public: b.public })) });
      }
      return { instances: out };
    },
  },
  {
    name: 'list_files',
    description: 'Objects in a bucket (folder view with delimiter "/" by default). prefix narrows to a folder; search matches any part of the key; run lists only files uploaded inside that test run.',
    inputSchema: obj({ project: PROJECT, instance: INSTANCE, bucket: BUCKET, prefix: s('Key prefix (folder), e.g. "avatars/"'), delimiter: s('Default "/"; "" for a flat list'), search: s('Substring of the key'), run: s('Test run key'), limit: n('Max items (default 200)'), cursor: s('Cursor from the previous page') }, ['project', 'instance', 'bucket']),
    annotations: { readOnlyHint: true },
    run: async (a, { api }) => {
      const r = (await api('GET', `${bucket(a)}/objects${qs({ prefix: a.prefix, delimiter: a.delimiter ?? '/', search: a.search, run: a.run, limit: a.limit, cursor: a.cursor })}`)) as Json;
      return {
        folders: r.prefixes,
        files: (r.objects as Json[]).map((o) => ({ key: o.key, size: o.size, contentType: o.contentType, etag: o.etag, modified: o.updatedAt, source: o.source, runId: o.runId })),
        truncated: r.truncated,
        cursor: r.cursor,
      };
    },
  },
  {
    name: 'get_file',
    description: 'Metadata of one stored file (size, type, ETag, checksums, user metadata, URLs) plus a text preview (first 64 KB) for text / JSON / XML / CSV files.',
    inputSchema: obj({ project: PROJECT, instance: INSTANCE, bucket: BUCKET, key: s('Object key') }, ['project', 'instance', 'bucket', 'key']),
    annotations: { readOnlyHint: true },
    run: async (a, { api }) => {
      const o = (await api('GET', `${bucket(a)}/object${qs({ key: a.key })}`)) as Json;
      let preview: string | null = null;
      if (TEXT_TYPES.test(String(o.contentType ?? '')) && Number(o.size) > 0) {
        const txt = await api('GET', `${bucket(a)}/object/content${qs({ key: a.key })}`);
        const str = typeof txt === 'string' ? txt : JSON.stringify(txt);
        preview = str.slice(0, 64 * 1024);
      }
      return { ...o, preview };
    },
  },
  {
    name: 'get_file_url',
    description: 'Presigned URL for a stored file (GET by default, PUT for an upload URL), for the backend and for the browser. scenario (e.g. "slow_down", "expired_url") is baked into the URL via hub_scenario.',
    inputSchema: obj({ project: PROJECT, instance: INSTANCE, bucket: BUCKET, key: s('Object key'), method: s('HTTP method', { enum: ['GET', 'PUT', 'HEAD', 'DELETE'] }), expires_in: n('Seconds (default 900)'), content_type: s('For PUT'), scenario: s('Scenario for requests made with this URL') }, ['project', 'instance', 'bucket', 'key']),
    call: (a) => ['POST', `${inst(a)}/presign`, { bucket: a.bucket, key: a.key, method: a.method, expiresIn: a.expires_in, contentType: a.content_type, scenario: a.scenario }],
  },
  {
    name: 'wait_for_upload',
    description: 'Wait until the app has uploaded file(s) to a bucket (optionally under a prefix) and return them. Starts counting at the call unless `after` (ISO time / cursor from a previous call) is given.',
    inputSchema: obj({ project: PROJECT, instance: INSTANCE, bucket: BUCKET, prefix: s('Key prefix'), count: n('How many files to wait for (default 1)'), timeout_ms: n('Max wait (default 10000, max 120000)'), after: s('Only files written after this time / cursor') }, ['project', 'instance', 'bucket']),
    annotations: { readOnlyHint: true },
    call: (a) => ['GET', `${bucket(a)}/objects/wait${qs({ prefix: a.prefix, count: a.count, timeoutMs: a.timeout_ms ?? 10000, after: a.after })}`],
  },
  {
    name: 'delete_files',
    description: 'Delete files from a bucket: the given keys, or everything under a prefix ("" = empty the bucket).',
    inputSchema: obj({ project: PROJECT, instance: INSTANCE, bucket: BUCKET, keys: { type: 'array', items: { type: 'string' }, description: 'Keys to delete' }, prefix: s('Delete every key starting with this') }, ['project', 'instance', 'bucket']),
    annotations: { destructiveHint: true },
    call: (a) => ['POST', `${bucket(a)}/objects/delete`, a.keys ? { keys: a.keys } : { prefix: a.prefix ?? '' }],
  },
  {
    name: 'set_storage_scenario',
    description:
      'Make storage requests fail or behave differently (S3 family errors in the native XML shape). ' +
      `Actions: ${STORAGE_ACTIONS.join(', ')}. op: ${STORAGE_OPS.join(', ')} (default any). count = next N requests only (note: SDKs retry 5xx / 503 up to 3 times), minutes = for a while. ` +
      'Params: delay_ms / bytes_per_sec for slow, after_bytes for reset, max_bytes for entity_too_large.',
    inputSchema: obj(
      {
        project: PROJECT,
        instance: INSTANCE,
        action: s('Scenario action', { enum: [...STORAGE_ACTIONS] }),
        op: s('Operation group', { enum: [...STORAGE_OPS] }),
        bucket: s('Only this bucket'),
        key_prefix: s('Only keys starting with this'),
        count: n('Only the next N matching requests'),
        after: n('Skip the first N matching requests'),
        minutes: n('Only for this many minutes'),
        fail_rate: n('Probability 0..1'),
        delay_ms: n('slow: delay before the response'),
        bytes_per_sec: n('slow: throttle the body'),
        after_bytes: n('reset: bytes before the connection is cut'),
        max_bytes: n('entity_too_large: size limit'),
        label: s('Label shown in the dashboard'),
        run: RUN,
      },
      ['project', 'instance', 'action'],
    ),
    call: (a) => [
      'POST',
      `${inst(a)}/rules${qs({ run: a.run })}`,
      { action: a.action, op: a.op, bucket: a.bucket, keyPrefix: a.key_prefix, count: a.count, after: a.after, minutes: a.minutes, failRate: a.fail_rate, delayMs: a.delay_ms, bytesPerSec: a.bytes_per_sec, afterBytes: a.after_bytes, maxBytes: a.max_bytes, label: a.label },
    ],
  },
  {
    name: 'reset_storage_scenarios',
    description: 'Remove storage scenario rules of an instance (project-level ones, or those of one test run with run).',
    inputSchema: obj({ project: PROJECT, instance: INSTANCE, run: RUN }, ['project', 'instance']),
    call: (a) => ['DELETE', `${inst(a)}/rules${qs({ run: a.run })}`],
  },
];
