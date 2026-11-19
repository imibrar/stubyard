/**
 * File storage simulator — S3 SDK conformance with the real AWS SDK v3 (and boto3 when Python + boto3 exist).
 * Each test settles a "verify" claim of the storage spec: path-prefixed endpoints, aws-chunked uploads with
 * trailing checksums, checksum validation on download, lib-storage multipart, presigned URLs used through
 * another Host, POST policy uploads, error mapping (403 rule, SlowDown with SDK retries).
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  paginateListObjectsV2,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { loadConfig } from '../src/config.js';
import { startHub, type RunningHub } from '../src/index.js';

const MAILPIT_BIN = process.env.DEVHUB_MAILPIT_BIN ?? '/usr/local/bin/mailpit';
const enabled = fs.existsSync(MAILPIT_BIN) && process.env.DEVHUB_SDK_TESTS !== '0';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

let running: RunningHub;
let dataDir: string;
let port: number;
let api: string;
const creds = { accessKeyId: 'devhub', secretAccessKey: 'devhub-secret' };

async function j<T = any>(method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(api + p, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (res.status >= 400) throw new Error(`${method} ${p} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : (undefined as T);
}

const client = (instance: string, extra: Record<string, unknown> = {}) =>
  new S3Client({ endpoint: `http://127.0.0.1:${port}/storage/sdk/${instance}`, forcePathStyle: true, region: 'us-east-1', credentials: creds, ...extra });

describe.skipIf(!enabled)('storage: AWS SDK v3 conformance', () => {
  let s3: S3Client;
  let strict: S3Client;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devhub-storage-sdk-'));
    const [httpPort, httpsPort, smtpPort, mpHttp, mpSmtp] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
    port = httpPort;
    running = await startHub(
      loadConfig({
        host: '127.0.0.1',
        httpPort,
        httpsPort,
        smtpPort,
        dataDir,
        webDir: path.join(dataDir, 'no-web'),
        mailpitBin: MAILPIT_BIN,
        mailpitUrl: `http://127.0.0.1:${mpHttp}`,
        mailpitSmtpHost: '127.0.0.1',
        mailpitSmtpPort: mpSmtp,
        spawnMailpit: true,
        logLevel: 'silent',
        maintenanceIntervalMs: 0,
      }),
      { tls: false },
    );
    api = `http://127.0.0.1:${httpPort}`;
    await j('POST', '/api/projects', { name: 'sdk' });
    await j('POST', '/api/projects/sdk/storage', { preset: 's3' });
    // Signatures verified: proves devhub's SigV4 canonicalisation matches the SDK's.
    await j('POST', '/api/projects/sdk/storage', { preset: 's3', slug: 'strict', config: { strict: true, verifySignatures: true } });
    s3 = client('s3');
    strict = client('strict');
    await s3.send(new CreateBucketCommand({ Bucket: 'uploads' }));
    await strict.send(new CreateBucketCommand({ Bucket: 'secure' }));
  }, 60_000);

  afterAll(async () => {
    await running?.close();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('PutObject (Buffer) / GetObject with checksum validation / HeadObject through a path-prefixed endpoint', async () => {
    const put = await s3.send(new PutObjectCommand({ Bucket: 'uploads', Key: 'docs/hello.txt', Body: Buffer.from('hello world'), ContentType: 'text/plain', Metadata: { owner: 'alice' } }));
    expect(put.ETag).toBe(`"${crypto.createHash('md5').update('hello world').digest('hex')}"`);
    const get = await s3.send(new GetObjectCommand({ Bucket: 'uploads', Key: 'docs/hello.txt', ChecksumMode: 'ENABLED' }));
    expect(await get.Body!.transformToString()).toBe('hello world');
    expect(get.ContentType).toBe('text/plain');
    expect(get.Metadata).toEqual({ owner: 'alice' });
    const head = await s3.send(new HeadObjectCommand({ Bucket: 'uploads', Key: 'docs/hello.txt' }));
    expect(head.ContentLength).toBe(11);
  });

  it('PutObject from a stream is sent aws-chunked with a trailing CRC32 and stored decoded', async () => {
    const data = crypto.randomBytes(300 * 1024);
    const put = await s3.send(new PutObjectCommand({ Bucket: 'uploads', Key: 'stream.bin', Body: Readable.from([data.subarray(0, 100_000), data.subarray(100_000)]), ContentLength: data.length, ChecksumAlgorithm: 'CRC32' }));
    expect(put.ChecksumCRC32).toBeTruthy();
    const logs = running.hub.db.prepare(`SELECT req_headers, resolved, req_body, req_body_size FROM traffic_logs WHERE json_extract(resolved, '$.key') = 'stream.bin' ORDER BY id DESC LIMIT 1`).get() as { req_headers: string; resolved: string; req_body: string | null; req_body_size: number };
    const headers = JSON.parse(logs.req_headers);
    expect(String(headers['content-encoding'] ?? headers['x-amz-content-sha256'])).toMatch(/aws-chunked|STREAMING/);
    expect(JSON.parse(logs.resolved).checksum).toMatchObject({ algo: 'crc32', ok: true, source: 'trailer' });
    expect(logs.req_body).toBeNull(); // object bytes never reach the log
    expect(logs.req_body_size).toBe(data.length);
    const get = await s3.send(new GetObjectCommand({ Bucket: 'uploads', Key: 'stream.bin', ChecksumMode: 'ENABLED' }));
    expect(get.ChecksumCRC32).toBe(put.ChecksumCRC32);
    expect(Buffer.from(await get.Body!.transformToByteArray()).equals(data)).toBe(true);
  });

  it('Range requests return 206 with Content-Range', async () => {
    const r = await s3.send(new GetObjectCommand({ Bucket: 'uploads', Key: 'docs/hello.txt', Range: 'bytes=6-10' }));
    expect(r.ContentRange).toBe('bytes 6-10/11');
    expect(await r.Body!.transformToString()).toBe('world');
  });

  it('CopyObject keeps the bytes and metadata', async () => {
    const c = await s3.send(new CopyObjectCommand({ Bucket: 'uploads', Key: 'docs/copy.txt', CopySource: 'uploads/docs/hello.txt' }));
    expect(c.CopyObjectResult?.ETag).toBeTruthy();
    const g = await s3.send(new GetObjectCommand({ Bucket: 'uploads', Key: 'docs/copy.txt' }));
    expect(await g.Body!.transformToString()).toBe('hello world');
    expect(g.Metadata).toEqual({ owner: 'alice' });
  });

  it('ListObjectsV2 paginator with delimiter and DeleteObjects', async () => {
    for (let i = 0; i < 25; i++) await s3.send(new PutObjectCommand({ Bucket: 'uploads', Key: `many/k${String(i).padStart(2, '0')}`, Body: 'x' }));
    for (let i = 0; i < 3; i++) await s3.send(new PutObjectCommand({ Bucket: 'uploads', Key: `many/sub${i}/a`, Body: 'x' }));
    const keys: string[] = [];
    const prefixes: string[] = [];
    let pages = 0;
    for await (const page of paginateListObjectsV2({ client: s3, pageSize: 10 }, { Bucket: 'uploads', Prefix: 'many/', Delimiter: '/' })) {
      pages++;
      keys.push(...(page.Contents ?? []).map((c) => c.Key!));
      prefixes.push(...(page.CommonPrefixes ?? []).map((p) => p.Prefix!));
    }
    expect(pages).toBe(3);
    expect(keys).toHaveLength(25);
    expect(prefixes).toEqual(['many/sub0/', 'many/sub1/', 'many/sub2/']);
    const del = await s3.send(new DeleteObjectsCommand({ Bucket: 'uploads', Delete: { Objects: keys.map((Key) => ({ Key })) } }));
    expect(del.Deleted).toHaveLength(25);
    const after = await s3.send(new ListObjectsV2Command({ Bucket: 'uploads', Prefix: 'many/' }));
    expect(after.KeyCount).toBe(3);
  });

  it('lib-storage Upload: multipart with default checksums (3 parts)', async () => {
    const data = crypto.randomBytes(5 * 1024 * 1024 * 2 + 123_456);
    const up = new Upload({ client: s3, params: { Bucket: 'uploads', Key: 'big/file.bin', Body: Readable.from([data]), ContentType: 'application/octet-stream' }, partSize: 5 * 1024 * 1024, queueSize: 2 });
    const out = await up.done();
    expect(out.ETag).toMatch(/-3"$/);
    const head = await s3.send(new HeadObjectCommand({ Bucket: 'uploads', Key: 'big/file.bin' }));
    expect(head.ContentLength).toBe(data.length);
    const got = await s3.send(new GetObjectCommand({ Bucket: 'uploads', Key: 'big/file.bin', ChecksumMode: 'ENABLED' }));
    const bytes = Buffer.from(await got.Body!.transformToByteArray());
    expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(crypto.createHash('sha256').update(data).digest('hex'));
  });

  it('signatures verify (strict instance): header auth, aws-chunked, multipart, presigned', async () => {
    await strict.send(new PutObjectCommand({ Bucket: 'secure', Key: 'a.txt', Body: 'signed' }));
    await strict.send(new PutObjectCommand({ Bucket: 'secure', Key: 'b.bin', Body: Readable.from([crypto.randomBytes(70_000)]), ContentLength: 70_000 }));
    const g = await strict.send(new GetObjectCommand({ Bucket: 'secure', Key: 'a.txt' }));
    expect(await g.Body!.transformToString()).toBe('signed');
    const up = new Upload({ client: strict, params: { Bucket: 'secure', Key: 'mp.bin', Body: crypto.randomBytes(5 * 1024 * 1024 + 10) }, partSize: 5 * 1024 * 1024 });
    await up.done();
    const url = await getSignedUrl(strict, new GetObjectCommand({ Bucket: 'secure', Key: 'a.txt' }), { expiresIn: 60 });
    expect((await fetch(url)).status).toBe(200);
    // Wrong secret → SignatureDoesNotMatch in strict mode.
    const bad = new S3Client({ endpoint: `http://127.0.0.1:${port}/storage/sdk/strict`, forcePathStyle: true, region: 'us-east-1', credentials: { accessKeyId: 'devhub', secretAccessKey: 'wrong' } });
    const err = await bad.send(new GetObjectCommand({ Bucket: 'secure', Key: 'a.txt' })).catch((e) => e);
    expect(err).toBeInstanceOf(S3ServiceException);
    expect(err.name).toBe('SignatureDoesNotMatch');
    expect(err.$metadata.httpStatusCode).toBe(403);
    const unknown = new S3Client({ endpoint: `http://127.0.0.1:${port}/storage/sdk/strict`, forcePathStyle: true, region: 'us-east-1', credentials: { accessKeyId: 'nobody', secretAccessKey: 'x' } });
    expect((await unknown.send(new GetObjectCommand({ Bucket: 'secure', Key: 'a.txt' })).catch((e) => e)).name).toBe('InvalidAccessKeyId');
    const rows = running.hub.db.prepare(`SELECT method, url, res_status, req_headers, resolved FROM traffic_logs WHERE json_extract(resolved, '$.instance') = 'strict' ORDER BY id`).all() as any[];
    if (process.env.STORAGE_DEBUG) for (const r of rows) console.log(r.method, r.url, r.res_status, JSON.parse(r.resolved).auth, JSON.parse(r.resolved).warnings, JSON.parse(r.req_headers)['x-amz-content-sha256'], JSON.parse(r.req_headers)['x-amz-checksum-algorithm'] ?? '', JSON.parse(r.req_headers)['x-amz-checksum-type'] ?? '');
    const ok = rows.filter((r) => r.res_status < 300);
    expect(ok.length).toBeGreaterThan(5);
    for (const r of ok) expect(JSON.parse(r.resolved).auth.verified).toBe(true);
  });

  it('getSignedUrl GET and PUT, fetched through a different Host', async () => {
    // Signed for "devhub:<port>" (what a backend in Docker would use), fetched on 127.0.0.1.
    const signer = new S3Client({ endpoint: `http://devhub:${port}/storage/sdk/strict`, forcePathStyle: true, region: 'us-east-1', credentials: creds });
    const putUrl = await getSignedUrl(signer, new PutObjectCommand({ Bucket: 'secure', Key: 'presigned/up.txt', ContentType: 'text/plain' }), { expiresIn: 300 });
    const local = (u: string) => u.replace(`http://devhub:${port}`, `http://127.0.0.1:${port}`);
    const put = await fetch(local(putUrl), { method: 'PUT', body: 'from the browser', headers: { 'content-type': 'text/plain' } });
    expect(put.status).toBe(200);
    const getUrl = await getSignedUrl(signer, new GetObjectCommand({ Bucket: 'secure', Key: 'presigned/up.txt' }), { expiresIn: 300 });
    const get = await fetch(local(getUrl));
    expect(get.status).toBe(200);
    expect(await get.text()).toBe('from the browser');
    expect(get.headers.get('content-type')).toBe('text/plain');
    // Expired URL → 403 AccessDenied "Request has expired".
    const old = await getSignedUrl(signer, new GetObjectCommand({ Bucket: 'secure', Key: 'presigned/up.txt' }), { expiresIn: 1, signingDate: new Date(Date.now() - 3600_000) });
    const exp = await fetch(local(old));
    expect(exp.status).toBe(403);
    const body = await exp.text();
    expect(body).toContain('<Code>AccessDenied</Code>');
    expect(body).toContain('Request has expired');
  });

  it('createPresignedPost with a browser-style FormData', async () => {
    const { url, fields } = await createPresignedPost(s3, {
      Bucket: 'uploads',
      Key: 'posted/${filename}',
      Conditions: [['content-length-range', 1, 1024 * 1024], ['starts-with', '$key', 'posted/']],
      Fields: { success_action_status: '201' },
      Expires: 300,
    });
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append('Content-Type', 'image/png');
    form.append('file', new Blob([Buffer.from('fake png bytes')], { type: 'image/png' }), 'avatar.png');
    const res = await fetch(url, { method: 'POST', body: form });
    expect(res.status).toBe(201);
    const xml = await res.text();
    expect(xml).toContain('<Key>posted/avatar.png</Key>');
    const head = await s3.send(new HeadObjectCommand({ Bucket: 'uploads', Key: 'posted/avatar.png' }));
    expect(head.ContentType).toBe('image/png');
    // content-length-range is always enforced.
    const big = new FormData();
    for (const [k, v] of Object.entries(fields)) big.append(k, v);
    big.append('file', new Blob([Buffer.alloc(1024 * 1024 + 1)]), 'big.bin');
    const r2 = await fetch(url, { method: 'POST', body: big });
    expect(r2.status).toBe(400);
    expect(await r2.text()).toContain('EntityTooLarge');
  });

  it('error mapping: 403 rule → AccessDenied; SlowDown survives the SDK retries only while the rule lasts', async () => {
    const rule = await j('POST', '/api/projects/sdk/storage/s3/rules', { action: 'access_denied', op: 'put', count: 1 });
    const e1 = await s3.send(new PutObjectCommand({ Bucket: 'uploads', Key: 'denied.txt', Body: 'x' })).catch((e) => e);
    expect(e1).toBeInstanceOf(S3ServiceException);
    expect(e1.name).toBe('AccessDenied');
    expect(e1.$metadata.httpStatusCode).toBe(403);
    await s3.send(new PutObjectCommand({ Bucket: 'uploads', Key: 'denied.txt', Body: 'x' })); // count used up
    expect((await j('GET', '/api/projects/sdk/storage/s3/rules')).find((r: any) => r.id === rule.id).hits).toBe(1);

    const sd = await j('POST', '/api/projects/sdk/storage/s3/rules', { action: 'slow_down', op: 'get', count: 3 });
    const c3 = client('s3', { maxAttempts: 3, retryStrategy: undefined });
    const e2 = await c3.send(new GetObjectCommand({ Bucket: 'uploads', Key: 'denied.txt' })).catch((e) => e);
    expect(e2.name).toBe('SlowDown');
    expect(e2.$metadata.httpStatusCode).toBe(503);
    expect(e2.$metadata.attempts).toBe(3);
    expect((await j('GET', '/api/projects/sdk/storage/s3/rules')).find((r: any) => r.id === sd.id).hits).toBe(3);
    // A count of 2 is invisible to the app: the third attempt succeeds.
    await j('POST', '/api/projects/sdk/storage/s3/rules', { action: 'slow_down', op: 'get', count: 2 });
    const ok = await c3.send(new GetObjectCommand({ Bucket: 'uploads', Key: 'denied.txt' }));
    expect(ok.$metadata.attempts).toBe(3);
    // NoSuchKey / NoSuchBucket map to the SDK's modelled exceptions.
    expect((await s3.send(new GetObjectCommand({ Bucket: 'uploads', Key: 'missing' })).catch((e) => e)).name).toBe('NoSuchKey');
    expect((await s3.send(new HeadObjectCommand({ Bucket: 'uploads', Key: 'missing' })).catch((e) => e)).$metadata.httpStatusCode).toBe(404);
    expect((await s3.send(new ListObjectsV2Command({ Bucket: 'nope-bucket' })).catch((e) => e)).name).toBe('NoSuchBucket');
    await s3.send(new DeleteObjectCommand({ Bucket: 'uploads', Key: 'denied.txt' }));
  });

  const python = (() => {
    try {
      execFileSync('python3', ['-c', 'import boto3'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!python)('boto3: upload_file, list_objects_v2 (encoding-type=url), Expect: 100-continue, presigned URL', async () => {
    const script = `
import boto3, sys, urllib.request
from botocore.config import Config
s3 = boto3.client("s3", endpoint_url=sys.argv[1], region_name="us-east-1", aws_access_key_id="devhub", aws_secret_access_key="devhub-secret", config=Config(s3={"addressing_style": "path"}))
open("/tmp/devhub-boto.txt", "w").write("boto body ü")
s3.upload_file("/tmp/devhub-boto.txt", "uploads", "boto/ü file.txt")
r = s3.list_objects_v2(Bucket="uploads", Prefix="boto/")
assert r["Contents"][0]["Key"] == "boto/ü file.txt", r
url = s3.generate_presigned_url("get_object", Params={"Bucket": "uploads", "Key": "boto/ü file.txt"}, ExpiresIn=60)
print(urllib.request.urlopen(url).read().decode())
`;
    const out = execFileSync('python3', ['-c', script, `http://127.0.0.1:${port}/storage/sdk/s3`], { encoding: 'utf8' });
    expect(out.trim()).toBe('boto body ü');
  });
});
