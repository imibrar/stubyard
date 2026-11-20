/**
 * Storage providers with their real SDKs: cloudinary (Node), @google-cloud/storage, @azure/storage-blob and
 * @supabase/supabase-js, all pointed at a path-prefixed stubyard endpoint. These tests settle which repointing
 * settings actually work (see docs/drafts/storage-providers.md).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Storage } from '@google-cloud/storage';
import { BlobSASPermissions, BlobServiceClient, generateBlobSASQueryParameters, RestError, StorageSharedKeyCredential } from '@azure/storage-blob';
import { createClient } from '@supabase/supabase-js';
import { loadConfig } from '../src/config.js';
import { startHub, type RunningHub } from '../src/index.js';

const MAILPIT_BIN = process.env.STUBYARD_MAILPIT_BIN ?? '/usr/local/bin/mailpit';
const enabled = fs.existsSync(MAILPIT_BIN) && process.env.STUBYARD_SDK_TESTS !== '0';

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
let base: string;

async function j(method: string, p: string, body?: unknown) {
  const r = await fetch(`http://127.0.0.1:${new URL(base).port}${p}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (r.status >= 400) throw new Error(`${method} ${p} → ${r.status} ${t}`);
  return t ? JSON.parse(t) : null;
}

function png(w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type), data, Buffer.alloc(4)]);
  };
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0))]);
}

describe.skipIf(!enabled)('storage providers: real SDKs', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-providers-sdk-'));
    const [httpPort, httpsPort, smtpPort, mpHttp, mpSmtp] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
    base = `http://127.0.0.1:${httpPort}`;
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
        publicUrl: `http://127.0.0.1:${httpPort}`,
      }),
      { tls: false },
    );
    await j('POST', '/api/projects', { name: 'sdk' });
    for (const preset of ['cloudinary', 'gcs', 'azure', 'supabase']) await j('POST', '/api/projects/sdk/storage', { preset });
    // A second GCS instance: root-level JSON API calls must be routed by the apiKey, not by "the only instance".
    await j('POST', '/api/projects/sdk/storage', { preset: 'gcs', slug: 'gcs2', name: 'GCS 2' });
  }, 60_000);

  afterAll(async () => {
    await running?.close();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------- Cloudinary
  it('cloudinary: upload (file, data URI), upload_large, rename, resources, destroy, delivery url, errors', async () => {
    const endpoint = `${base}/storage/sdk/cloudinary`;
    // The SDK picks the http / https module when it is first loaded, from CLOUDINARY_URL: set it before the import.
    process.env.CLOUDINARY_URL = `cloudinary://123456789012345:stubyard-secret@stubyard?upload_prefix=${endpoint}`;
    const { v2: cloudinary } = await import('cloudinary');
    await j('PATCH', '/api/projects/sdk/storage/cloudinary', { config: { apiSecret: 'stubyard-secret' } });

    const file = path.join(dataDir, 'photo.png');
    fs.writeFileSync(file, png(8, 5));
    const up = await cloudinary.uploader.upload(file, { public_id: 'sdk/photo', tags: ['t1'] });
    expect(up).toMatchObject({ public_id: 'sdk/photo', width: 8, height: 5, format: 'png', resource_type: 'image', tags: ['t1'] });
    expect((await fetch(up.secure_url)).status).toBe(200);

    const data = await cloudinary.uploader.upload(`data:text/plain;base64,${Buffer.from('hi').toString('base64')}`, { resource_type: 'raw', public_id: 'sdk/hi.txt' });
    expect(data).toMatchObject({ public_id: 'sdk/hi.txt', bytes: 2, resource_type: 'raw' });

    const bigFile = path.join(dataDir, 'big.bin');
    const big = crypto.randomBytes(2_500_000);
    fs.writeFileSync(bigFile, big);
    const large = await new Promise<any>((resolve, reject) =>
      cloudinary.uploader.upload_large(bigFile, { resource_type: 'raw', public_id: 'sdk/big.bin', chunk_size: 1_000_000 }, (err: unknown, res: unknown) => (err ? reject(err) : resolve(res))),
    );
    expect(large).toMatchObject({ public_id: 'sdk/big.bin', bytes: big.length });
    const got = Buffer.from(await (await fetch(large.secure_url)).arrayBuffer());
    expect(got.equals(big)).toBe(true);

    const rn = await cloudinary.uploader.rename('sdk/photo', 'sdk/renamed');
    expect(rn.public_id).toBe('sdk/renamed');
    const list = await cloudinary.api.resources({ type: 'upload', prefix: 'sdk/', max_results: 10 });
    expect(list.resources.map((r: any) => r.public_id)).toEqual(['sdk/renamed']);
    const one = await cloudinary.api.resource('sdk/renamed');
    expect(one.width).toBe(8);
    expect(await cloudinary.api.ping()).toMatchObject({ status: 'ok' });

    // Delivery URLs: cname (http) points cloudinary.url() at stubyard; transformations are ignored.
    const url = cloudinary.url('sdk/renamed', { secure: false, cname: `${new URL(endpoint).host}${new URL(endpoint).pathname}`, width: 100, crop: 'scale', format: 'png' });
    expect(url).toContain('/storage/sdk/cloudinary/stubyard/image/upload/c_scale,w_100/v1/sdk/renamed.png');
    const d = await fetch(url);
    expect(d.status).toBe(200);
    expect(d.headers.get('x-stubyard-transformations-ignored')).toContain('c_scale,w_100');

    expect(await cloudinary.uploader.destroy('sdk/renamed')).toEqual({ result: 'ok' });
    await expect(cloudinary.api.resource('sdk/nope')).rejects.toMatchObject({ error: { http_code: 404 } });

    // Wrong secret → the SDK surfaces the 401 error message.
    cloudinary.config({ api_secret: 'wrong' });
    await expect(cloudinary.uploader.upload(file)).rejects.toMatchObject({ http_code: 401 });
    cloudinary.config({ api_secret: 'stubyard-secret' });
  }, 60_000);

  // ---------------------------------------------------------------- GCS
  it('gcs: buckets, save (simple + resumable), download, metadata, list, delete, 404, V4 signed URLs', async () => {
    const endpoint = `${base}/storage/sdk/gcs`;
    // v9 always goes through google-auth-library (an apiKey satisfies it offline) and sends JSON API calls to
    // "/storage/v1/…" at the origin: the apiKey "<project>/<instance>" (x-goog-api-key) routes them to the instance.
    const storage = new Storage({ apiEndpoint: endpoint, projectId: 'stubyard', apiKey: 'sdk/gcs' });
    const [bucket] = await storage.createBucket('sdk-bucket');
    expect(bucket.name).toBe('sdk-bucket');
    const [buckets] = await storage.getBuckets();
    expect(buckets.map((b) => b.name)).toContain('sdk-bucket');

    await bucket.file('docs/a.txt').save('hello gcs', { contentType: 'text/plain', resumable: false, metadata: { metadata: { owner: 'me' } } });
    const big = crypto.randomBytes(1_200_000);
    await bucket.file('docs/big.bin').save(big, { resumable: true, chunkSize: 256 * 1024 * 2 });
    const [dl] = await bucket.file('docs/big.bin').download();
    expect(dl.equals(big)).toBe(true);
    const [validated] = await bucket.file('docs/a.txt').download({ validation: 'crc32c' });
    expect(validated.toString()).toBe('hello gcs');
    const [meta] = await bucket.file('docs/a.txt').getMetadata();
    expect(meta).toMatchObject({ name: 'docs/a.txt', contentType: 'text/plain', size: '9', metadata: { owner: 'me' } });
    const [files] = await bucket.getFiles({ prefix: 'docs/' });
    expect(files.map((f) => f.name).sort()).toEqual(['docs/a.txt', 'docs/big.bin']);
    const [exists] = await bucket.file('docs/none').exists();
    expect(exists).toBe(false);
    await expect(bucket.file('docs/none').download()).rejects.toMatchObject({ code: 404 });
    await expect(bucket.file('docs/a.txt').save('x', { resumable: false, preconditionOpts: { ifGenerationMatch: 0 } })).rejects.toMatchObject({ code: 412 });

    // V4 signed URLs need a key: the instance's fake service account. The client drops the endpoint path
    // (it signs "/<bucket>/<object>"), so the instance path is put back before use.
    const sa = await j('GET', '/api/projects/sdk/storage/gcs/service-account.json');
    await j('PATCH', '/api/projects/sdk/storage/gcs', { config: { verifySignatures: true } });
    const signer = new Storage({ apiEndpoint: endpoint, projectId: 'stubyard', credentials: sa });
    const [signed] = await signer.bucket('sdk-bucket').file('docs/a.txt').getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + 60_000 });
    const fixed = signed.replace(new URL(signed).origin, endpoint);
    const r = await fetch(fixed);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('hello gcs');
    const [putUrl] = await signer.bucket('sdk-bucket').file('docs/up.txt').getSignedUrl({ version: 'v4', action: 'write', expires: Date.now() + 60_000, contentType: 'text/plain' });
    const put = await fetch(putUrl.replace(new URL(putUrl).origin, endpoint), { method: 'PUT', body: 'signed put', headers: { 'content-type': 'text/plain' } });
    expect(put.status).toBe(200);
    expect((await bucket.file('docs/up.txt').download())[0].toString()).toBe('signed put');
    const bad = await fetch(fixed.replace(/X-Goog-Signature=[0-9a-f]{8}/, 'X-Goog-Signature=00000000'));
    expect(bad.status).toBe(403);

    await bucket.file('docs/a.txt').delete();
    await bucket.deleteFiles({ force: true });
    await bucket.delete();
  }, 60_000);

  // ---------------------------------------------------------------- Azure
  it('azure: container, uploadData (single + blocks), download, list, properties, SAS, errors', async () => {
    const inst = await j('GET', '/api/projects/sdk/storage/azure');
    const account = inst.credentials[0].accessKeyId;
    const key = inst.credentials[0].secretAccessKey;
    const blobEndpoint = `${base}/storage/sdk/azure/${account}`;
    const service = BlobServiceClient.fromConnectionString(`DefaultEndpointsProtocol=http;AccountName=${account};AccountKey=${key};BlobEndpoint=${blobEndpoint};`);
    const container = service.getContainerClient('sdk-box');
    await container.create();
    expect((await container.createIfNotExists()).succeeded).toBe(false);

    const small = container.getBlockBlobClient('docs/hello.txt');
    await small.uploadData(Buffer.from('hello azure'), { blobHTTPHeaders: { blobContentType: 'text/plain' }, metadata: { owner: 'me' } });
    const big = crypto.randomBytes(3_000_000);
    await container.getBlockBlobClient('docs/big.bin').uploadData(big, { blockSize: 1024 * 1024, maxSingleShotSize: 1024 * 1024 });
    const dl = await container.getBlockBlobClient('docs/big.bin').downloadToBuffer();
    expect(dl.equals(big)).toBe(true);
    const props = await small.getProperties();
    expect(props).toMatchObject({ contentType: 'text/plain', contentLength: 11, metadata: { owner: 'me' } });
    const names: string[] = [];
    for await (const b of container.listBlobsFlat({ prefix: 'docs/' })) names.push(b.name);
    expect(names.sort()).toEqual(['docs/big.bin', 'docs/hello.txt']);
    const containers: string[] = [];
    for await (const c of service.listContainers()) containers.push(c.name);
    expect(containers).toContain('sdk-box');

    await expect(container.getBlockBlobClient('nope').download()).rejects.toSatisfy((e: unknown) => e instanceof RestError && e.statusCode === 404 && (e as RestError).code === 'BlobNotFound');

    // SAS: pass container / blob explicitly (the client misparses a path-prefixed endpoint); verified in verify mode.
    await j('PATCH', '/api/projects/sdk/storage/azure', { config: { verifySignatures: true } });
    const cred = new StorageSharedKeyCredential(account, key);
    const sas = generateBlobSASQueryParameters({ containerName: 'sdk-box', blobName: 'docs/hello.txt', permissions: BlobSASPermissions.parse('r'), expiresOn: new Date(Date.now() + 60_000) }, cred).toString();
    const r = await fetch(`${blobEndpoint}/sdk-box/docs/hello.txt?${sas}`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('hello azure');
    const tampered = await fetch(`${blobEndpoint}/sdk-box/docs/hello.txt?${sas.replace(/sp=r/, 'sp=rw')}`);
    expect(tampered.status).toBe(403);
    expect(tampered.headers.get('x-ms-error-code')).toBe('AuthenticationFailed');

    // SharedKey is verified too in verify mode: the SDK's own signatures pass, a wrong key fails.
    const verified = container.getBlockBlobClient('docs/verified.txt');
    await verified.uploadData(Buffer.from('signed'), { blobHTTPHeaders: { blobContentType: 'text/plain', blobContentLanguage: 'en' }, metadata: { 'x-y': '1', xa: '2' } });
    expect((await verified.downloadToBuffer(0, 3)).toString()).toBe('sig');
    expect((await verified.getProperties()).contentLanguage).toBe('en');
    const wrong = new BlobServiceClient(blobEndpoint, new StorageSharedKeyCredential(account, Buffer.alloc(64, 1).toString('base64')));
    await expect(wrong.getContainerClient('sdk-box').getBlockBlobClient('docs/verified.txt').download()).rejects.toSatisfy((e: unknown) => e instanceof RestError && e.statusCode === 403);
    await verified.delete();

    await small.delete();
    await container.delete();
  }, 60_000);

  // ---------------------------------------------------------------- Supabase
  it('supabase: buckets, upload / upsert, download, list, signed URLs, signed upload, move, remove, errors', async () => {
    const inst = await j('GET', '/api/projects/sdk/storage/supabase');
    const serviceKey = inst.credentials[0].secretAccessKey;
    const supabase = createClient(`${base}/storage/sdk/supabase`, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const cb = await supabase.storage.createBucket('sdk-avatars', { public: true });
    expect(cb.error).toBeNull();
    const lb = await supabase.storage.listBuckets();
    expect(lb.data?.map((b) => b.name)).toContain('sdk-avatars');
    const from = supabase.storage.from('sdk-avatars');

    const up = await from.upload('u1/cat.png', png(3, 3), { contentType: 'image/png' });
    expect(up.error).toBeNull();
    expect(up.data).toMatchObject({ path: 'u1/cat.png', fullPath: 'sdk-avatars/u1/cat.png' });
    const dup = await from.upload('u1/cat.png', png(3, 3), { contentType: 'image/png' });
    expect(dup.error).toBeTruthy();
    expect((dup.error as any).statusCode).toBe('409');
    expect((await from.upload('u1/cat.png', png(4, 4), { contentType: 'image/png', upsert: true })).error).toBeNull();
    const blob = new Blob(['note'], { type: 'text/plain' });
    expect((await from.upload('u1/note.txt', blob)).error).toBeNull();

    const dl = await from.download('u1/note.txt');
    expect(await dl.data!.text()).toBe('note');
    const list = await from.list('u1', { sortBy: { column: 'name', order: 'asc' } });
    expect(list.data?.map((x) => x.name)).toEqual(['cat.png', 'note.txt']);

    const pub = from.getPublicUrl('u1/note.txt');
    expect(await (await fetch(pub.data.publicUrl)).text()).toBe('note');
    const signed = await from.createSignedUrl('u1/note.txt', 60);
    expect(signed.error).toBeNull();
    expect(await (await fetch(signed.data!.signedUrl)).text()).toBe('note');
    const many = await from.createSignedUrls(['u1/note.txt', 'u1/cat.png'], 60);
    expect(many.data?.every((x) => !!x.signedUrl)).toBe(true);

    const su = await from.createSignedUploadUrl('u2/up.txt');
    expect(su.error).toBeNull();
    const sup = await from.uploadToSignedUrl('u2/up.txt', su.data!.token, new Blob(['signed'], { type: 'text/plain' }));
    expect(sup.error).toBeNull();
    expect(await (await from.download('u2/up.txt')).data!.text()).toBe('signed');

    expect((await from.move('u1/note.txt', 'u3/note.txt')).error).toBeNull();
    expect((await from.copy('u3/note.txt', 'u3/copy.txt')).error).toBeNull();
    const rm = await from.remove(['u3/note.txt', 'u3/copy.txt']);
    expect(rm.data?.map((x) => x.name).sort()).toEqual(['u3/copy.txt', 'u3/note.txt']);

    const nf = await from.download('missing.txt');
    expect(nf.error).toBeTruthy();
    const nb = await supabase.storage.from('no-such-bucket').list();
    expect(nb.error).toBeTruthy();

    expect((await supabase.storage.emptyBucket('sdk-avatars')).error).toBeNull();
    expect((await supabase.storage.deleteBucket('sdk-avatars')).error).toBeNull();
  }, 60_000);
});
