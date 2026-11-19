/**
 * File storage simulator: the contract between the engine (service, store, pipeline helpers) and the protocol
 * modules (S3 family here; GCS, Azure Blob, Cloudinary and Supabase register the same way).
 *
 * A protocol module is registered once with `registerStorageProtocol(protocol)` (service.ts). The service resolves
 * project + instance from `/storage/<project>/<instance>/…`, answers CORS preflights, builds a `StorageCtx` and calls
 * `protocol.handle(ctx)`. The protocol classifies the operation (`ctx.setOp`), parses auth, asks for scenario
 * effects (`ctx.effects()`), streams bodies through `ctx.store` and answers through `ctx.reply`.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import type { Hub } from '../hub.js';
import type { Project } from '../repos/projects.js';
import type { Run } from '../repos/runs.js';
import type { RunVia } from '../runs/resolver.js';
import type { StorageBucket, StorageInstance, StorageObject, StorageRule, StorageUpload } from '../repos/storage.js';

/** Rule / log operation groups (storage_rules.op). */
export const STORAGE_OPS = ['any', 'put', 'get', 'head', 'delete', 'list', 'copy', 'multipart', 'bucket'] as const;
export type StorageOp = (typeof STORAGE_OPS)[number];

/** Scenario actions (section 5 of the spec). Each protocol maps them to its native error shape in errorFor. */
export const STORAGE_ACTIONS = [
  'access_denied',
  'slow_down',
  'internal_error',
  'quota_exceeded',
  'entity_too_large',
  'expired_url',
  'bad_signature',
  'checksum_mismatch',
  'not_found',
  'complete_error_200',
  'cors_blocked',
  'slow',
  'timeout',
  'reset',
] as const;
export type StorageAction = (typeof STORAGE_ACTIONS)[number];

/** Generic failure kinds; protocols translate them into native errors (S3 XML, GCS JSON, Azure XML, …). */
export type FaultKind =
  | StorageAction
  | 'no_such_bucket'
  | 'no_such_key'
  | 'no_such_upload'
  | 'bucket_exists'
  | 'bucket_not_empty'
  | 'invalid_bucket_name'
  | 'precondition_failed'
  | 'not_modified'
  | 'invalid_range'
  | 'bad_digest'
  | 'invalid_digest'
  | 'sha256_mismatch'
  | 'incomplete_body'
  | 'missing_content_length'
  | 'entity_too_small'
  | 'invalid_part'
  | 'invalid_part_order'
  | 'unknown_access_key'
  | 'clock_skew'
  | 'invalid_argument'
  | 'invalid_request'
  | 'malformed_xml'
  | 'not_implemented'
  | 'method_not_allowed'
  | 'policy_violation'
  | 'unknown_instance';

export interface StorageFault {
  kind: FaultKind;
  message?: string;
  /** Native code override (e.g. "InvalidAccessKeyId"); the protocol's default for `kind` otherwise. */
  code?: string;
  status?: number;
  /** Extra native fields (S3: added as XML elements of <Error>). */
  detail?: Record<string, string>;
  headers?: Record<string, string>;
  /** Reason shown in x-devhub-reason and the traffic log. */
  reason?: string;
}

/** Thrown by the store / helpers; caught by the service and rendered with protocol.errorFor. */
export class StorageFaultError extends Error {
  constructor(public fault: StorageFault) {
    super(fault.message ?? fault.kind);
  }
}

export const fault = (kind: FaultKind, message?: string, extra: Omit<StorageFault, 'kind' | 'message'> = {}): StorageFaultError =>
  new StorageFaultError({ kind, message, ...extra });

/** A rendered native error. */
export interface ProtocolError {
  status: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  contentType?: string;
}

export type ChecksumAlgo = 'crc32' | 'crc32c' | 'crc64nvme' | 'sha1' | 'sha256';
export const CHECKSUM_ALGOS: ChecksumAlgo[] = ['crc32', 'crc32c', 'crc64nvme', 'sha1', 'sha256'];

/** Digests computed in one pass while a body is written. Checksums are base64 (as on the wire). */
export interface Digests {
  size: number;
  md5: string; // hex
  sha256Hex?: string;
  checksums: Partial<Record<ChecksumAlgo, string>>;
}

/** Scenario effects for one request (from X-Hub-Scenario / hub_scenario or a rule). */
export interface StorageEffects {
  action: StorageAction;
  params: Record<string, unknown>;
  source: 'header' | 'query' | 'rule';
  rule?: StorageRule;
}

export interface Snippet {
  title: string;
  language: string;
  code: string;
}

export interface StoragePreset {
  id: string;
  name: string;
  /** Protocol module that serves it ("s3", "gcs", …). */
  protocol: string;
  description: string;
  region: string;
  /** Credentials devhub accepts out of the box (also used to sign control-API presigned URLs). */
  credentials: { accessKeyId: string; secretAccessKey: string }[];
  /** Native quota error, e.g. { code: "QuotaExceeded", status: 403 }. */
  quotaError?: { code: string; status: number };
  /** Preset quirks (data; protocols read them). */
  quirks?: Record<string, unknown>;
  /** Short notes shown in the dashboard / guide. */
  notes?: string[];
  docsUrl?: string;
}

/** Instance as returned by the control API (GET /api/projects/:slug/storage/:instance). */
export interface InstanceView extends StorageInstance {
  presetName: string;
  protocol: string;
  urls: { backend: string; docker: string; browser: string };
  credentials: { accessKeyId: string; secretAccessKey: string }[];
  region: string;
  snippets: Snippet[];
  usage: { objects: number; bytes: number; quotaBytes: number; maxObjectBytes: number };
  buckets: number;
}

export interface PresignInput {
  bucket: string;
  key: string;
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE';
  expiresIn: number;
  contentType?: string;
  scenario?: string;
}

export interface PresignResult {
  backend: string;
  browser: string;
  expiresAt: string;
  headers: Record<string, string>;
}

export interface PresignCtx {
  hub: Hub;
  project: Project;
  instance: StorageInstance;
  preset: StoragePreset;
  /** Bases without trailing slash: http://localhost:4000/storage/p/i and the browser base. */
  bases: { backend: string; browser: string };
}

export interface PutOptions {
  contentType?: string | null;
  /** Stored response headers (cache-control, content-disposition, content-encoding, content-language, expires). */
  headers?: Record<string, string>;
  metadata?: Record<string, string>;
  acl?: string | null;
  source?: string;
  runId?: string | null;
  logId?: string | null;
  extra?: Record<string, unknown>;
  /** Checksums to compute besides MD5. */
  algos?: ChecksumAlgo[];
  sha256?: boolean;
  /** Decide whether the written bytes are acceptable (digest checks); a returned fault aborts the commit. */
  verify?: (d: Digests) => StorageFault | null;
  /** Fail when an object with this key exists (If-None-Match: *). */
  ifNoneMatch?: boolean;
  /** Use this exact ETag (wire form, quoted) instead of "<md5>". */
  etag?: string;
  checksums?: Partial<Record<ChecksumAlgo, string>>;
  checksumType?: 'FULL_OBJECT' | 'COMPOSITE';
  parts?: number | null;
  /** Byte limit for this body (instance / global object limit by default). */
  maxBytes?: number;
}

export interface ListInput {
  prefix?: string;
  delimiter?: string;
  /** Exclusive start key (continuation token / start-after / marker). */
  after?: string;
  limit: number;
}

export interface ListOutput {
  objects: StorageObject[];
  prefixes: string[];
  truncated: boolean;
  /** Last key or common prefix emitted (next continuation). */
  last: string | null;
}

export interface ByteRange {
  start: number;
  end: number; // inclusive
}

/** Disk + rows for one instance. */
export interface ObjectStore {
  readonly instance: StorageInstance;
  bucket(name: string): StorageBucket | null;
  requireBucket(name: string): StorageBucket;
  /** Bucket, auto-created when the instance allows it (autoCreateBuckets, default true). */
  bucketOrCreate(name: string): StorageBucket;
  put(bucket: StorageBucket, key: string, body: Readable, opts?: PutOptions): Promise<StorageObject>;
  open(obj: StorageObject, range?: ByteRange | null): Readable;
  head(bucket: StorageBucket, key: string): StorageObject | null;
  remove(bucket: StorageBucket, key: string): boolean;
  copy(src: StorageObject, dst: StorageBucket, key: string, opts?: PutOptions & { replaceMetadata?: boolean }): Promise<StorageObject>;
  list(bucket: StorageBucket, input: ListInput): ListOutput;
  uploads: {
    create(bucket: StorageBucket, kind: StorageUpload['kind'], key: string, opts?: { contentType?: string | null; headers?: Record<string, string>; metadata?: Record<string, string>; state?: Record<string, unknown>; runId?: string | null }): StorageUpload;
    get(id: string): StorageUpload | null;
    putPart(upload: StorageUpload, partId: string, body: Readable, opts?: { algos?: ChecksumAlgo[]; sha256?: boolean; verify?: (d: Digests) => StorageFault | null; maxBytes?: number }): Promise<{ etag: string; size: number; md5: string; checksums: Partial<Record<ChecksumAlgo, string>> }>;
    copyPart(upload: StorageUpload, partId: string, src: StorageObject, range: ByteRange | null): Promise<{ etag: string; size: number; md5: string }>;
    parts(upload: StorageUpload): { partId: string; size: number; etag: string; md5: string; checksums: Partial<Record<ChecksumAlgo, string>>; createdAt: string }[];
    /** Concatenate the given parts (in order) into the object and remove the upload. */
    complete(upload: StorageUpload, partIds: string[], opts: PutOptions): Promise<StorageObject>;
    abort(upload: StorageUpload): void;
    list(bucket: StorageBucket): StorageUpload[];
  };
}

/** Per-request context handed to protocol.handle. */
export interface StorageCtx {
  hub: Hub;
  project: Project;
  instance: StorageInstance;
  preset: StoragePreset;
  protocol: StorageProtocol;
  store: ObjectStore;
  req: FastifyRequest;
  reply: FastifyReply;
  /** Path below the instance base, raw (still percent-encoded), always starting with "/". */
  path: string;
  query: URLSearchParams;
  /** Explicit run (X-Hub-Run / /run/<key>/): objects are attributed only to this one. */
  explicitRun: Run | null;
  /** Run used for the traffic log tag and run-scoped rules (explicit, claim or default run). */
  run: Run | null;
  runVia: RunVia | null;
  requestId: string;
  strict: boolean;
  warnings: string[];
  /** Traffic `resolved` record (kind: "storage"); merged into the log when the response is done. */
  resolved: Record<string, unknown>;
  /** Base URLs of this instance for the current request (scheme + Host of the request) and for browsers. */
  bases: { request: string; browser: string };
  /** CORS headers computed for this request (empty when blocked or not a CORS request). */
  corsHeaders: Record<string, string>;

  /** Record the classified operation (call before reading the body). */
  setOp(group: StorageOp, name: string, target?: { bucket?: string; key?: string }): void;
  /** Scenario effects for the current operation (header / query, then run, bucket, instance rules). */
  effects(bucket?: StorageBucket | null): StorageEffects | null;
  /** Apply transport effects that do not produce a native error (slow delay, timeout, reset before body). true = handled. */
  transport(e: StorageEffects | null): Promise<boolean>;
  /** Send "100 Continue" when the client waits for it. Call right before reading the body. */
  continue(): void;
  /** Request body stream (after continue(); throttled when a slow{bytesPerSec} effect is active). */
  body(e?: StorageEffects | null): Readable;
  /** Buffer a small control body (XML / JSON), logged as text. */
  readSmall(max?: number): Promise<Buffer>;
  /** Render a fault with protocol.errorFor and send it. */
  fail(f: StorageFault | StorageFaultError): FastifyReply;
  /** Send an object body (size used for the traffic log instead of the bytes). */
  sendBody(stream: Readable, size: number, e?: StorageEffects | null): FastifyReply;
  /** Note the request body size for the log (object uploads; the bytes are never stored). */
  noteRequestSize(size: number): void;
  /** Publish storage.changed for live dashboards. */
  changed(data: Record<string, unknown>): void;
}

/** A protocol module (S3 engine, GCS, Azure Blob, Cloudinary, Supabase). */
export interface StorageProtocol {
  id: string;
  presets: StoragePreset[];
  /** First path segments under the instance base the protocol uses itself (besides "__hub"). */
  reservedSegments?: string[];
  handle(ctx: StorageCtx): Promise<unknown>;
  errorFor(ctx: StorageCtx | null, fault: StorageFault): ProtocolError;
  presign(ctx: PresignCtx, input: PresignInput): PresignResult;
  snippets(view: InstanceView): Snippet[];
  /** Extra response headers on every response (e.g. x-amz-request-id). */
  commonHeaders?(ctx: StorageCtx): Record<string, string>;
}
