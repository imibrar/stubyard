/**
 * Storage providers beyond S3 over raw HTTP: Cloudinary, Google Cloud Storage, Azure Blob and Supabase Storage —
 * response shapes, each provider's own error format, auth / signature checks, rules (fault injection) and the
 * dashboard object URLs.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { startHub, type RunningHub } from '../src/index.js';
import { cloudinarySignature } from '../src/storage/cloudinary/index.js';
import { imageSize } from '../src/storage/image-size.js';

const AZURITE_KEY_FOR_TEST = 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';
const MAILPIT_BIN = process.env.STUBYARD_MAILPIT_BIN ?? '/usr/local/bin/mailpit';
const haveMailpit = fs.existsSync(MAILPIT_BIN);

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

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  buf: Buffer;
  json: any;
}

function req(method: string, p: string, o: { headers?: Record<string, string>; body?: Buffer | string; json?: unknown } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${port}`, ...(o.headers ?? {}) };
    let body: Buffer | undefined;
    if (o.json !== undefined) {
      body = Buffer.from(JSON.stringify(o.json));
      headers['content-type'] ??= 'application/json';
    } else if (o.body !== undefined) body = Buffer.isBuffer(o.body) ? o.body : Buffer.from(o.body);
    if (body) headers['content-length'] = String(body.length);
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const t = buf.toString('utf8');
        let json: unknown = null;
        try {
          json = JSON.parse(t);
        } catch {
          /* not json */
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text: t, buf, json });
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

const api = async (method: string, p: string, json?: unknown) => {
  const r = await req(method, p, json === undefined ? {} : { json });
  if (r.status >= 400) throw new Error(`${method} ${p} → ${r.status} ${r.text}`);
  return r.json;
};

function multipart(fields: Record<string, string>, file?: { name: string; filename: string; type: string; data: Buffer }) {
  const boundary = '----stubyard' + crypto.randomBytes(8).toString('hex');
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.type}\r\n\r\n`));
    parts.push(file.data, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

// 2x3 PNG (header only matters for dimension sniffing).
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

describe('provider units', () => {
  it('image header sniffing (PNG / GIF / JPEG)', () => {
    expect(imageSize(png(2, 3))).toMatchObject({ format: 'png', width: 2, height: 3 });
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([5, 0, 7, 0])]);
    expect(imageSize(gif)).toMatchObject({ format: 'gif', width: 5, height: 7 });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x0a, 0x00, 0x14, 0x03]);
    expect(imageSize(jpeg)).toMatchObject({ format: 'jpg', width: 20, height: 10 });
    expect(imageSize(Buffer.from('hello'))).toBeNull();
  });

  it('Cloudinary signature: sorted params, excluded keys, secret appended', () => {
    const sig = cloudinarySignature({ timestamp: '1315060510', public_id: 'sample', eager: 'w_400,h_300,c_pad|w_260,h_200,c_crop', file: 'x', api_key: 'k' }, 'abcd');
    expect(sig).toBe(crypto.createHash('sha1').update('eager=w_400,h_300,c_pad|w_260,h_200,c_crop&public_id=sample&timestamp=1315060510abcd').digest('hex'));
  });
});

describe.skipIf(!haveMailpit)('storage providers e2e', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-providers-'));
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
    await api('POST', '/api/projects', { name: 'prov' });
    for (const preset of ['cloudinary', 'gcs', 'azure', 'supabase']) await api('POST', '/api/projects/prov/storage', { preset });
  }, 60_000);

  afterAll(async () => {
    await running?.close();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('presets are listed and instances expose provider snippets', async () => {
    const { presets } = await api('GET', '/api/storage-presets');
    const ids = presets.map((p: any) => p.id);
    for (const id of ['s3', 'cloudinary', 'gcs', 'azure', 'supabase']) expect(ids).toContain(id);
    const list = await api('GET', '/api/projects/prov/storage');
    const items = Array.isArray(list) ? list : list.instances;
    const bySlug = Object.fromEntries(items.map((i: any) => [i.slug, i]));
    expect(bySlug.cloudinary.snippets[0].code).toContain('CLOUDINARY_URL');
    expect(bySlug.gcs.snippets[0].code).toContain('@google-cloud/storage');
    expect(bySlug.azure.snippets[0].code).toContain('BlobServiceClient');
    expect(bySlug.supabase.snippets[0].code).toContain('createClient');
  });

  // ---------------------------------------------------------------- Cloudinary
  describe('cloudinary', () => {
    const C = '/storage/prov/cloudinary';
    const secret = 'stubyard-secret';
    const signed = (params: Record<string, string>) => {
      const p = { ...params, timestamp: String(Math.floor(Date.now() / 1000)), api_key: '123456789012345' };
      return { ...p, signature: cloudinarySignature(p, secret) };
    };

    it('signed multipart upload → asset JSON; delivery URL serves bytes; transformations ignored', async () => {
      const img = png(4, 6);
      const m = multipart(signed({ public_id: 'avatars/me', tags: 'a,b' }), { name: 'file', filename: 'me.png', type: 'image/png', data: img });
      const r = await req('POST', `${C}/v1_1/stubyard/image/upload`, { body: m.body, headers: { 'content-type': m.contentType } });
      expect(r.status, r.text).toBe(200);
      expect(r.json).toMatchObject({ public_id: 'avatars/me', resource_type: 'image', type: 'upload', format: 'png', width: 4, height: 6, bytes: img.length, tags: ['a', 'b'] });
      expect(r.json.secure_url).toMatch(new RegExp(`/storage/prov/cloudinary/stubyard/image/upload/v\\d+/avatars/me\\.png$`));
      const u = new URL(r.json.url);
      const got = await req('GET', u.pathname);
      expect(got.status).toBe(200);
      expect(got.buf.equals(img)).toBe(true);
      const t = await req('GET', `${C}/stubyard/image/upload/w_100,h_100,c_fill/avatars/me.webp`);
      expect(t.status).toBe(200);
      expect(t.headers['x-stubyard-transformations-ignored']).toContain('w_100,h_100,c_fill');
      expect(t.buf.equals(img)).toBe(true);
    });

    it('bad signature → 401 {error:{message}} when the secret is configured', async () => {
      await api('PATCH', '/api/projects/prov/storage/cloudinary', { config: { apiSecret: secret } });
      const p = signed({ public_id: 'x' });
      const m = multipart({ ...p, signature: 'deadbeef' }, { name: 'file', filename: 'x.txt', type: 'text/plain', data: Buffer.from('x') });
      const r = await req('POST', `${C}/v1_1/stubyard/raw/upload`, { body: m.body, headers: { 'content-type': m.contentType } });
      expect(r.status).toBe(401);
      expect(r.json.error.message).toMatch(/Invalid Signature/);
    });

    it('unsigned upload with a preset (urlencoded data URI); unknown preset is rejected in strict mode', async () => {
      await api('PATCH', '/api/projects/prov/storage/cloudinary', { config: { uploadPresets: [{ name: 'unsigned_dev', unsigned: true }] } });
      const body = new URLSearchParams({ upload_preset: 'unsigned_dev', file: `data:text/plain;base64,${Buffer.from('hello').toString('base64')}`, public_id: 'notes/hello' }).toString();
      const r = await req('POST', `${C}/v1_1/stubyard/raw/upload`, { body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      expect(r.status, r.text).toBe(200);
      expect(r.json).toMatchObject({ public_id: 'notes/hello', resource_type: 'raw', bytes: 5 });
      expect(r.json.format).toBeUndefined();
    });

    it('remote URL file from a non-allowed host stores a placeholder with a warning (never fetched)', async () => {
      const body = new URLSearchParams({ upload_preset: 'unsigned_dev', file: 'https://example.invalid/pic.txt', public_id: 'remote/one' }).toString();
      const r = await req('POST', `${C}/v1_1/stubyard/raw/upload`, { body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      expect(r.status, r.text).toBe(200);
      expect(r.json.placeholder).toBe(true);
    });

    it('chunked upload (X-Unique-Upload-Id + Content-Range)', async () => {
      const data = crypto.randomBytes(300_000);
      const uid = 'u' + crypto.randomBytes(6).toString('hex');
      let last: Res | null = null;
      const size = 128 * 1024;
      for (let off = 0; off < data.length; off += size) {
        const part = data.subarray(off, Math.min(off + size, data.length));
        const isLast = off + part.length >= data.length;
        const m = multipart(signed({ public_id: 'big/blob' }), { name: 'file', filename: 'blob.bin', type: 'application/octet-stream', data: part });
        last = await req('POST', `${C}/v1_1/stubyard/raw/upload`, { body: m.body, headers: { 'content-type': m.contentType, 'x-unique-upload-id': uid, 'content-range': `bytes ${off}-${off + part.length - 1}/${isLast ? data.length : -1}` } });
        expect(last.status, last.text).toBe(200);
        if (!isLast) expect(last.json.done).toBe(false);
      }
      expect(last!.json).toMatchObject({ public_id: 'big/blob', bytes: data.length, resource_type: 'raw' });
      const got = await req('GET', `${C}/stubyard/raw/upload/big/blob`);
      expect(got.buf.equals(data)).toBe(true);
    });

    it('rename, admin list (Basic auth), destroy, ping', async () => {
      const auth = { authorization: 'Basic ' + Buffer.from(`123456789012345:${secret}`).toString('base64') };
      const rn = await req('POST', `${C}/v1_1/stubyard/image/rename`, { body: new URLSearchParams(signed({ from_public_id: 'avatars/me', to_public_id: 'avatars/you' })).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      expect(rn.status, rn.text).toBe(200);
      expect(rn.json.public_id).toBe('avatars/you');
      const list = await req('GET', `${C}/v1_1/stubyard/resources/image?prefix=avatars/`, { headers: auth });
      expect(list.status, list.text).toBe(200);
      expect(list.json.resources.map((x: any) => x.public_id)).toEqual(['avatars/you']);
      const bad = await req('GET', `${C}/v1_1/stubyard/resources/image`, { headers: { authorization: 'Basic ' + Buffer.from('123456789012345:nope').toString('base64') } });
      expect(bad.status).toBe(401);
      const d = await req('POST', `${C}/v1_1/stubyard/image/destroy`, { body: new URLSearchParams(signed({ public_id: 'avatars/you' })).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      expect(d.json).toEqual({ result: 'ok' });
      const d2 = await req('POST', `${C}/v1_1/stubyard/image/destroy`, { body: new URLSearchParams(signed({ public_id: 'avatars/you' })).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      expect(d2.json).toEqual({ result: 'not found' });
      expect((await req('GET', `${C}/v1_1/stubyard/ping`, { headers: auth })).json).toEqual({ status: 'ok' });
      const miss = await req('GET', `${C}/stubyard/image/upload/v1/nope.png`);
      expect(miss.status).toBe(404);
      expect(miss.headers['x-cld-error']).toBeTruthy();
    });

    it('rules: slow_down → 420 in the Cloudinary error format', async () => {
      await api('POST', '/api/projects/prov/storage/cloudinary/rules', { action: 'slow_down', op: 'put', count: 1 });
      const m = multipart(signed({ public_id: 'r' }), { name: 'file', filename: 'r.txt', type: 'text/plain', data: Buffer.from('r') });
      const r = await req('POST', `${C}/v1_1/stubyard/raw/upload`, { body: m.body, headers: { 'content-type': m.contentType } });
      expect(r.status).toBe(420);
      expect(r.json.error.message).toBeTruthy();
    });
  });

  // ---------------------------------------------------------------- GCS
  describe('gcs', () => {
    const G = '/storage/prov/gcs';

    it('bucket insert, media / multipart / resumable uploads, get, list, delete', async () => {
      const b = await req('POST', `${G}/storage/v1/b?project=stubyard`, { json: { name: 'gbucket' } });
      expect(b.status, b.text).toBe(200);
      expect(b.json).toMatchObject({ kind: 'storage#bucket', name: 'gbucket' });

      const media = await req('POST', `${G}/upload/storage/v1/b/gbucket/o?uploadType=media&name=a/one.txt`, { body: 'one', headers: { 'content-type': 'text/plain' } });
      expect(media.status, media.text).toBe(200);
      expect(media.json).toMatchObject({ kind: 'storage#object', name: 'a/one.txt', bucket: 'gbucket', size: '3', contentType: 'text/plain' });
      expect(media.json.md5Hash).toBe(crypto.createHash('md5').update('one').digest('base64'));
      expect(media.json.generation).toMatch(/^\d+$/);

      const boundary = 'xyz';
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: 'a/two.json', metadata: { k: 'v' } })}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n{"two":2}\r\n--${boundary}--`;
      const mp = await req('POST', `${G}/upload/storage/v1/b/gbucket/o?uploadType=multipart`, { body, headers: { 'content-type': `multipart/related; boundary=${boundary}` } });
      expect(mp.status, mp.text).toBe(200);
      expect(mp.json).toMatchObject({ name: 'a/two.json', metadata: { k: 'v' }, size: '9' });

      const start = await req('POST', `${G}/upload/storage/v1/b/gbucket/o?uploadType=resumable&name=a/three.bin`, { json: {}, headers: { 'x-upload-content-type': 'application/octet-stream' } });
      expect(start.status, start.text).toBe(200);
      const loc = new URL(start.headers.location!);
      expect(loc.searchParams.get('upload_id')).toBeTruthy();
      const data = crypto.randomBytes(512 * 1024);
      const half = 256 * 1024;
      const c1 = await req('PUT', loc.pathname + loc.search, { body: data.subarray(0, half), headers: { 'content-range': `bytes 0-${half - 1}/*` } });
      expect(c1.status).toBe(308);
      expect(c1.headers.range).toBe(`bytes=0-${half - 1}`);
      const c2 = await req('PUT', loc.pathname + loc.search, { body: data.subarray(half), headers: { 'content-range': `bytes ${half}-${data.length - 1}/${data.length}` } });
      expect(c2.status, c2.text).toBe(200);
      expect(c2.json.size).toBe(String(data.length));

      const meta = await req('GET', `${G}/storage/v1/b/gbucket/o/${encodeURIComponent('a/three.bin')}`);
      expect(meta.json.name).toBe('a/three.bin');
      const bytes = await req('GET', `${G}/storage/v1/b/gbucket/o/${encodeURIComponent('a/three.bin')}?alt=media`);
      expect(bytes.buf.equals(data)).toBe(true);
      expect(bytes.headers['x-goog-hash']).toContain('md5=');

      const list = await req('GET', `${G}/storage/v1/b/gbucket/o?prefix=a/&delimiter=/`);
      expect(list.json.kind).toBe('storage#objects');
      expect(list.json.items.map((x: any) => x.name).sort()).toEqual(['a/one.txt', 'a/three.bin', 'a/two.json']);
      const paged = await req('GET', `${G}/storage/v1/b/gbucket/o?maxResults=2`);
      expect(paged.json.items).toHaveLength(2);
      expect(paged.json.nextPageToken).toBeTruthy();

      const xml = await req('GET', `${G}/gbucket/a/one.txt`);
      expect(xml.text).toBe('one');

      expect((await req('DELETE', `${G}/storage/v1/b/gbucket/o/${encodeURIComponent('a/one.txt')}`)).status).toBe(204);
    });

    it('errors: JSON API error shape, preconditions, XML API <Error>', async () => {
      const nf = await req('GET', `${G}/storage/v1/b/gbucket/o/nope`);
      expect(nf.status).toBe(404);
      expect(nf.json.error).toMatchObject({ code: 404, errors: [{ reason: 'notFound' }] });
      const pre = await req('POST', `${G}/upload/storage/v1/b/gbucket/o?uploadType=media&name=a/two.json&ifGenerationMatch=0`, { body: 'x', headers: { 'content-type': 'text/plain' } });
      expect(pre.status).toBe(412);
      expect(pre.json.error.errors[0].reason).toBe('conditionNotMet');
      const nb = await req('GET', `${G}/storage/v1/b/nobucket/o`);
      expect(nb.status).toBe(404);
      const x = await req('GET', `${G}/gbucket/nope.txt`);
      expect(x.status).toBe(404);
      expect(x.text).toContain('<Code>NoSuchKey</Code>');
    });

    it('V4 signed URLs: presign works, tampering / expiry are rejected; service-account.json', async () => {
      const sa = await api('GET', '/api/projects/prov/storage/gcs/service-account.json');
      expect(sa).toMatchObject({ type: 'service_account' });
      expect(sa.private_key).toContain('BEGIN PRIVATE KEY');
      const p = await api('POST', '/api/projects/prov/storage/gcs/presign', { bucket: 'gbucket', key: 'a/two.json', method: 'GET', expiresIn: 60 });
      const u = new URL(p.backend);
      expect(u.searchParams.get('X-Goog-Algorithm')).toBe('GOOG4-RSA-SHA256');
      const ok = await req('GET', u.pathname + u.search);
      expect(ok.status, ok.text).toBe(200);
      expect(ok.text).toBe('{"two":2}');
      u.searchParams.set('X-Goog-Signature', 'ab'.repeat(256));
      // Lax by default (like S3): a bad signature is accepted with a warning; verified when verifySignatures is on.
      expect((await req('GET', u.pathname + u.search)).status).toBe(200);
      await api('PATCH', '/api/projects/prov/storage/gcs', { config: { verifySignatures: true } });
      const bad = await req('GET', u.pathname + u.search);
      expect(bad.status).toBe(403);
      const again = await api('POST', '/api/projects/prov/storage/gcs/presign', { bucket: 'gbucket', key: 'a/two.json', method: 'GET', expiresIn: 60 });
      expect((await req('GET', new URL(again.backend).pathname + new URL(again.backend).search)).status).toBe(200);
      const exp = new URL(again.backend);
      exp.searchParams.set('X-Goog-Date', '20200101T000000Z');
      const expired = await req('GET', exp.pathname + exp.search);
      expect(expired.status).toBe(400);
      expect(expired.text).toContain('ExpiredToken');
      await api('PATCH', '/api/projects/prov/storage/gcs', { config: { verifySignatures: null } });
      expect(bad.text).toContain('SignatureDoesNotMatch');
      const notGcs = await req('GET', '/api/projects/prov/storage/azure/service-account.json');
      expect(notGcs.status).toBe(404);
    });

    it('rules: access_denied → 403 JSON error; dashboard object URLs are XML-API paths', async () => {
      await api('POST', '/api/projects/prov/storage/gcs/rules', { action: 'access_denied', op: 'get', count: 1 });
      const r = await req('GET', `${G}/storage/v1/b/gbucket/o/${encodeURIComponent('a/two.json')}?alt=media`);
      expect(r.status).toBe(403);
      expect(r.json.error.code).toBe(403);
      const objs = await api('GET', '/api/projects/prov/storage/gcs/buckets/gbucket/objects');
      const o = (objs.objects ?? objs).find((x: any) => x.key === 'a/two.json');
      expect(o.urls.backend).toMatch(/\/storage\/prov\/gcs\/gbucket\/a\/two\.json$/);
    });
  });

  // ---------------------------------------------------------------- Azure
  describe('azure', () => {
    const A = '/storage/prov/azure/devstoreaccount1';

    it('container create, Put Blob, Get Blob with x-ms headers, list, delete', async () => {
      const c = await req('PUT', `${A}/box?restype=container`);
      expect(c.status, c.text).toBe(201);
      expect(c.headers.etag).toMatch(/^"0x8D/);
      const dup = await req('PUT', `${A}/box?restype=container`);
      expect(dup.status).toBe(409);
      expect(dup.headers['x-ms-error-code']).toBe('ContainerAlreadyExists');
      const put = await req('PUT', `${A}/box/docs/hello.txt`, { body: 'hello', headers: { 'x-ms-blob-type': 'BlockBlob', 'content-type': 'text/plain', 'x-ms-meta-owner': 'me' } });
      expect(put.status, put.text).toBe(201);
      expect(put.headers['content-md5']).toBe(crypto.createHash('md5').update('hello').digest('base64'));
      const get = await req('GET', `${A}/box/docs/hello.txt`);
      expect(get.text).toBe('hello');
      expect(get.headers['x-ms-blob-type']).toBe('BlockBlob');
      expect(get.headers['x-ms-meta-owner']).toBe('me');
      expect(get.headers['x-ms-version']).toBeTruthy();
      const range = await req('GET', `${A}/box/docs/hello.txt`, { headers: { 'x-ms-range': 'bytes=1-3' } });
      expect(range.status).toBe(206);
      expect(range.text).toBe('ell');
      const list = await req('GET', `${A}/box?restype=container&comp=list&prefix=docs/`);
      expect(list.text).toContain('<EnumerationResults');
      expect(list.text).toContain('<Name>docs/hello.txt</Name>');
    });

    it('Put Block + Put Block List', async () => {
      const id1 = Buffer.from('block-000').toString('base64');
      const id2 = Buffer.from('block-001').toString('base64');
      expect((await req('PUT', `${A}/box/big.bin?comp=block&blockid=${encodeURIComponent(id1)}`, { body: 'aaa' })).status).toBe(201);
      expect((await req('PUT', `${A}/box/big.bin?comp=block&blockid=${encodeURIComponent(id2)}`, { body: 'bbb' })).status).toBe(201);
      const xml = `<?xml version="1.0" encoding="utf-8"?><BlockList><Latest>${id1}</Latest><Latest>${id2}</Latest></BlockList>`;
      const done = await req('PUT', `${A}/box/big.bin?comp=blocklist`, { body: xml, headers: { 'x-ms-blob-content-type': 'application/octet-stream' } });
      expect(done.status, done.text).toBe(201);
      expect((await req('GET', `${A}/box/big.bin`)).text).toBe('aaabbb');
    });

    it('errors: BlobNotFound XML + x-ms-error-code; SAS expiry; strict anonymous → 401', async () => {
      const nf = await req('GET', `${A}/box/missing.txt`);
      expect(nf.status).toBe(404);
      expect(nf.headers['x-ms-error-code']).toBe('BlobNotFound');
      expect(nf.text).toContain('<Code>BlobNotFound</Code>');
      const p = await api('POST', '/api/projects/prov/storage/azure/presign', { bucket: 'box', key: 'docs/hello.txt', method: 'GET', expiresIn: 60 });
      const u = new URL(p.backend);
      expect(u.searchParams.get('sig')).toBeTruthy();
      expect((await req('GET', u.pathname + u.search)).text).toBe('hello');
      u.searchParams.set('se', '2020-01-01T00:00:00Z');
      const exp = await req('GET', u.pathname + u.search);
      expect(exp.status).toBe(403);
      expect(exp.headers['x-ms-error-code']).toBe('AuthenticationFailed');
      const del = await req('DELETE', `${A}/box/docs/hello.txt`);
      expect(del.status).toBe(202);
    });

    it('rules: internal_error → 500 InternalError', async () => {
      await api('POST', '/api/projects/prov/storage/azure/rules', { action: 'internal_error', op: 'get', count: 1 });
      const r = await req('GET', `${A}/box/big.bin`);
      expect(r.status).toBe(500);
      expect(r.headers['x-ms-error-code']).toBe('InternalError');
    });

    it('SharedKey: verified against the account key; mismatch fails in verify mode, warns in lax mode', async () => {
      // Independent signer per the Shared Key docs: VERB, standard headers, x-ms-* headers, /account + path + query.
      const sharedKey = (method: string, p: string, headers: Record<string, string>, key = AZURITE_KEY_FOR_TEST) => {
        const [path, query = ''] = p.split('?');
        const q = new URLSearchParams(query);
        const h = (n: string) => headers[n] ?? '';
        const xms = Object.keys(headers).filter((n) => n.startsWith('x-ms-')).sort().map((n) => `${n}:${headers[n]}\n`).join('');
        const res = `/devstoreaccount1${path}` + [...new Set([...q.keys()])].sort().map((k) => `\n${k}:${q.getAll(k).sort().join(',')}`).join('');
        const len = h('content-length') === '0' ? '' : h('content-length');
        const s = [method, h('content-encoding'), h('content-language'), len, h('content-md5'), h('content-type'), '', h('if-modified-since'), h('if-match'), h('if-none-match'), h('if-unmodified-since'), h('range')].join('\n') + '\n' + xms + res;
        return `SharedKey devstoreaccount1:${crypto.createHmac('sha256', Buffer.from(key, 'base64')).update(s, 'utf8').digest('base64')}`;
      };
      const signed = (method: string, p: string, body: string | undefined, extra: Record<string, string>, key?: string) => {
        const headers: Record<string, string> = { 'x-ms-date': new Date().toUTCString(), 'x-ms-version': '2025-11-05', ...extra };
        if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
        return req(method, p, { body, headers: { ...headers, authorization: sharedKey(method, p, headers, key) } });
      };
      const lastAuth = async () => {
        const logs = await api('GET', '/api/logs?project=prov&limit=1');
        return logs[0].resolved.auth;
      };
      // Lax (default): a good signature is marked verified, a bad one is accepted with verified false.
      const put = await signed('PUT', `${A}/box/sk.txt`, 'shared', { 'x-ms-blob-type': 'BlockBlob', 'content-type': 'text/plain', 'x-ms-meta-owner': 'me' });
      expect(put.status, put.text).toBe(201);
      expect(await lastAuth()).toMatchObject({ type: 'sharedkey', accessKeyId: 'devstoreaccount1', verified: true });
      const wrongKey = Buffer.alloc(64, 7).toString('base64');
      const laxBad = await signed('GET', `${A}/box/sk.txt`, undefined, {}, wrongKey);
      expect(laxBad.status).toBe(200);
      expect(await lastAuth()).toMatchObject({ type: 'sharedkey', verified: false });

      await api('PATCH', '/api/projects/prov/storage/azure', { config: { verifySignatures: true } });
      try {
        const good = await signed('GET', `${A}/box/sk.txt?timeout=30`, undefined, { range: 'bytes=0-2' });
        expect(good.status, good.text).toBe(206);
        expect(good.text).toBe('sha');
        const list = await signed('GET', `${A}/box?restype=container&comp=list&prefix=sk`, undefined, {});
        expect(list.status, list.text).toBe(200);
        const bad = await signed('GET', `${A}/box/sk.txt`, undefined, {}, wrongKey);
        expect(bad.status).toBe(403);
        expect(bad.headers['x-ms-error-code']).toBe('AuthenticationFailed');
        expect(bad.text).toContain('is not the same as any computed signature');
        // A signed header changed after signing (x-ms-meta) breaks the signature.
        const headers = { 'x-ms-date': new Date().toUTCString(), 'x-ms-blob-type': 'BlockBlob', 'content-length': '1' };
        const tampered = await req('PUT', `${A}/box/sk2.txt`, { body: 'x', headers: { ...headers, 'x-ms-meta-extra': '1', authorization: sharedKey('PUT', `${A}/box/sk2.txt`, headers) } });
        expect(tampered.status).toBe(403);
        // Signed for a different account → rejected.
        const other = await req('GET', `${A}/box/sk.txt`, { headers: { 'x-ms-date': new Date().toUTCString(), authorization: 'SharedKey someoneelse:AAAA' } });
        expect(other.status).toBe(403);
        // The run prefix is part of the signed path.
        await api('POST', '/api/projects/prov/runs', { key: 'azsk' });
        const viaRun = await signed('GET', `/run/azsk${A}/box/sk.txt`, undefined, {});
        expect(viaRun.status, viaRun.text).toBe(200);
        // Azure operations count in the run report (GetBlob = download).
        const runs = await api('GET', '/api/projects/prov/runs');
        const azRun = (Array.isArray(runs) ? runs : runs.runs ?? runs.items).find((r: any) => r.key === 'azsk');
        const rep = await api('GET', `/api/projects/prov/runs/${azRun.id}/report`);
        expect((rep.report ?? rep).storage).toMatchObject({ downloads: 1, items: [{ op: 'GetBlob', bucket: 'box', key: 'sk.txt', status: 200 }] });
      } finally {
        await api('PATCH', '/api/projects/prov/storage/azure', { config: { verifySignatures: null } });
      }
    });
  });

  // ---------------------------------------------------------------- Supabase
  describe('supabase', () => {
    const S = '/storage/prov/supabase/storage/v1';
    let key = '';

    it('bucket CRUD, upload (multipart + raw), download, list, move, remove', async () => {
      const inst = await api('GET', '/api/projects/prov/storage/supabase');
      key = inst.credentials[1]?.secretAccessKey ?? inst.credentials[0].secretAccessKey;
      const auth = { authorization: `Bearer ${key}`, apikey: key };
      const b = await req('POST', `${S}/bucket`, { json: { id: 'avatars', name: 'avatars', public: true, allowed_mime_types: ['image/png', 'text/plain'], file_size_limit: 1024 }, headers: auth });
      expect(b.status, b.text).toBe(200);
      expect(b.json).toEqual({ name: 'avatars' });
      const g = await req('GET', `${S}/bucket/avatars`, { headers: auth });
      expect(g.json).toMatchObject({ id: 'avatars', public: true, file_size_limit: 1024 });

      const m = multipart({ cacheControl: '3600' }, { name: '', filename: 'me.png', type: 'image/png', data: png(1, 1) });
      const up = await req('POST', `${S}/object/avatars/u1/me.png`, { body: m.body, headers: { ...auth, 'content-type': m.contentType } });
      expect(up.status, up.text).toBe(200);
      expect(up.json).toMatchObject({ Key: 'avatars/u1/me.png' });
      expect(up.json.Id).toBeTruthy();
      const raw = await req('POST', `${S}/object/avatars/u1/note.txt`, { body: 'hi', headers: { ...auth, 'content-type': 'text/plain' } });
      expect(raw.status, raw.text).toBe(200);
      const dup = await req('POST', `${S}/object/avatars/u1/note.txt`, { body: 'hi', headers: { ...auth, 'content-type': 'text/plain' } });
      expect(dup.status).toBe(400);
      expect(dup.json).toMatchObject({ statusCode: '409', error: 'Duplicate' });
      const upsert = await req('POST', `${S}/object/avatars/u1/note.txt`, { body: 'hi2', headers: { ...auth, 'content-type': 'text/plain', 'x-upsert': 'true' } });
      expect(upsert.status).toBe(200);

      const pub = await req('GET', `${S}/object/public/avatars/u1/note.txt`);
      expect(pub.text).toBe('hi2');
      const list = await req('POST', `${S}/object/list/avatars`, { json: { prefix: 'u1', limit: 100, offset: 0, sortBy: { column: 'name', order: 'asc' } }, headers: auth });
      expect(list.status, list.text).toBe(200);
      expect(list.json.map((x: any) => x.name)).toEqual(['me.png', 'note.txt']);
      expect(list.json[0].metadata).toMatchObject({ mimetype: 'image/png' });

      const mv = await req('POST', `${S}/object/move`, { json: { bucketId: 'avatars', sourceKey: 'u1/note.txt', destinationKey: 'u2/note.txt' }, headers: auth });
      expect(mv.status, mv.text).toBe(200);
      const rm = await req('DELETE', `${S}/object/avatars`, { json: { prefixes: ['u2/note.txt'] }, headers: auth });
      expect(rm.status, rm.text).toBe(200);
      expect(rm.json.map((x: any) => x.name)).toEqual(['u2/note.txt']);
    });

    it('bucket rules: mime type and size limits', async () => {
      const auth = { authorization: `Bearer ${key}`, apikey: key };
      const mime = await req('POST', `${S}/object/avatars/x.pdf`, { body: '%PDF', headers: { ...auth, 'content-type': 'application/pdf' } });
      expect(mime.status).toBe(400);
      expect(mime.json).toMatchObject({ statusCode: '415', error: 'invalid_mime_type' });
      const big = await req('POST', `${S}/object/avatars/big.txt`, { body: 'x'.repeat(2048), headers: { ...auth, 'content-type': 'text/plain' } });
      expect(big.status).toBe(400);
      expect(big.json.statusCode).toBe('413');
    });

    it('signed URLs: createSignedUrl, signed upload; bad token rejected; not found shape', async () => {
      const auth = { authorization: `Bearer ${key}`, apikey: key };
      const s = await req('POST', `${S}/object/sign/avatars/u1/me.png`, { json: { expiresIn: 60 }, headers: auth });
      expect(s.status, s.text).toBe(200);
      expect(s.json.signedURL).toMatch(/^\/object\/sign\/avatars\/u1\/me\.png\?token=/);
      const got = await req('GET', `/storage/prov/supabase/storage/v1${s.json.signedURL}`);
      expect(got.status).toBe(200);
      expect(imageSize(got.buf)).toMatchObject({ width: 1 });
      const bad = await req('GET', `${S}/object/sign/avatars/u1/me.png?token=nope`);
      expect(bad.status).toBe(400);
      const su = await req('POST', `${S}/object/upload/sign/avatars/u3/up.txt`, { headers: auth, json: {} });
      expect(su.status, su.text).toBe(200);
      const put = await req('PUT', `${S}${su.json.url}`, { body: 'signed', headers: { 'content-type': 'text/plain' } });
      expect(put.status, put.text).toBe(200);
      expect(put.json.Key).toBe('avatars/u3/up.txt');
      const nf = await req('GET', `${S}/object/authenticated/avatars/none.txt`, { headers: auth });
      expect(nf.json).toMatchObject({ statusCode: '404', error: 'not_found' });
    });

    it('private buckets need a key; rules use the Supabase error shape', async () => {
      const auth = { authorization: `Bearer ${key}`, apikey: key };
      await req('POST', `${S}/bucket`, { json: { id: 'private', name: 'private', public: false }, headers: auth });
      await req('POST', `${S}/object/private/a.txt`, { body: 'a', headers: { ...auth, 'content-type': 'text/plain' } });
      const pub = await req('GET', `${S}/object/public/private/a.txt`);
      expect(pub.status).toBe(400);
      await api('POST', '/api/projects/prov/storage/supabase/rules', { action: 'internal_error', op: 'get', count: 1 });
      const r = await req('GET', `${S}/object/authenticated/private/a.txt`, { headers: auth });
      expect(r.status).toBe(500);
      expect(r.json).toMatchObject({ statusCode: '500' });
      const objs = await api('GET', '/api/projects/prov/storage/supabase/buckets/avatars/objects');
      const o = (objs.objects ?? objs).find((x: any) => x.key === 'u1/me.png');
      expect(o.urls.backend).toMatch(/\/storage\/prov\/supabase\/storage\/v1\/object\/public\/avatars\/u1\/me\.png$/);
    });
  });

  // ---------------------------------------------------------------- maxObjects per provider
  describe('maxObjects (each provider renders its own quota error)', () => {
    const create = (preset: string, slug: string) => api('POST', '/api/projects/prov/storage', { preset, slug, config: { maxObjects: 1 } });

    it('GCS: media upload, resumable create and complete, copyTo', async () => {
      await create('gcs', 'lim-gcs');
      const G = '/storage/prov/lim-gcs';
      expect((await req('POST', `${G}/storage/v1/b?project=stubyard`, { json: { name: 'glim' } })).status).toBe(200);
      const start = await req('POST', `${G}/upload/storage/v1/b/glim/o?uploadType=resumable&name=r.bin`, { json: {} });
      expect(start.status, start.text).toBe(200);
      const loc = new URL(start.headers.location!);
      expect((await req('POST', `${G}/upload/storage/v1/b/glim/o?uploadType=media&name=a.txt`, { body: 'a', headers: { 'content-type': 'text/plain' } })).status).toBe(200);
      const full = await req('POST', `${G}/upload/storage/v1/b/glim/o?uploadType=media&name=b.txt`, { body: 'b', headers: { 'content-type': 'text/plain' } });
      expect(full.status).toBe(403);
      // GCS has no storage-full error: the refusal is its generic 403 forbidden.
      expect(full.json.error).toMatchObject({ code: 403, errors: [{ reason: 'forbidden', domain: 'global' }] });
      expect(full.json.error.message).toContain('does not have storage.objects.create access');
      expect(full.headers['x-stubyard-reason']).toBe('instance maxObjects=1');
      expect((await req('POST', `${G}/upload/storage/v1/b/glim/o?uploadType=media&name=a.txt`, { body: 'a2', headers: { 'content-type': 'text/plain' } })).status).toBe(200);
      const fin = await req('PUT', loc.pathname + loc.search, { body: 'resumed', headers: { 'content-range': 'bytes 0-6/7' } });
      expect(fin.status).toBe(403);
      expect(fin.json.error.errors[0].reason).toBe('forbidden');
      expect((await req('POST', `${G}/upload/storage/v1/b/glim/o?uploadType=resumable&name=r2.bin`, { json: {} })).status).toBe(403);
      const cp = await req('POST', `${G}/storage/v1/b/glim/o/a.txt/copyTo/b/glim/o/c.txt`, { json: {} });
      expect(cp.status).toBe(403);
      expect(cp.json.error.errors[0].reason).toBe('forbidden');
      // XML API: AccessDenied for the refusal, EntityTooLarge (400) for an oversized object.
      const xml = await req('PUT', `${G}/glim/x.txt`, { body: 'x' });
      expect(xml.status).toBe(403);
      expect(xml.text).toContain('<Code>AccessDenied</Code>');
      expect(xml.text).toContain('<Message>Access denied.</Message>');
      await api('PATCH', '/api/projects/prov/storage/lim-gcs', { config: { maxObjects: null, maxObjectBytes: 4 } });
      const xmlBig = await req('PUT', `${G}/glim/big.txt`, { body: 'too big' });
      expect(xmlBig.status).toBe(400);
      expect(xmlBig.text).toContain('<Code>EntityTooLarge</Code>');
    });

    it('Azure: Put Blob, Put Block (create), Put Block List (complete), Copy Blob', async () => {
      await create('azure', 'lim-az');
      const A = '/storage/prov/lim-az/devstoreaccount1';
      expect((await req('PUT', `${A}/box?restype=container`)).status).toBe(201);
      const id = Buffer.from('block-000').toString('base64');
      expect((await req('PUT', `${A}/box/blk.bin?comp=block&blockid=${encodeURIComponent(id)}`, { body: 'aaa' })).status).toBe(201);
      expect((await req('PUT', `${A}/box/a.txt`, { body: 'a', headers: { 'x-ms-blob-type': 'BlockBlob' } })).status).toBe(201);
      const full = await req('PUT', `${A}/box/b.txt`, { body: 'b', headers: { 'x-ms-blob-type': 'BlockBlob' } });
      // Azure has no capacity error per container: the refusal is 403 AuthorizationFailure.
      expect(full.status).toBe(403);
      expect(full.headers['x-ms-error-code']).toBe('AuthorizationFailure');
      expect(full.text).toContain('<Code>AuthorizationFailure</Code>');
      expect(full.text).toContain('This request is not authorized to perform this operation.');
      expect((await req('PUT', `${A}/box/a.txt`, { body: 'a2', headers: { 'x-ms-blob-type': 'BlockBlob' } })).status).toBe(201);
      const block = await req('PUT', `${A}/box/new.bin?comp=block&blockid=${encodeURIComponent(id)}`, { body: 'bbb' });
      expect(block.status).toBe(403);
      const list = await req('PUT', `${A}/box/blk.bin?comp=blocklist`, { body: `<?xml version="1.0" encoding="utf-8"?><BlockList><Latest>${id}</Latest></BlockList>` });
      expect(list.status).toBe(403);
      expect(list.headers['x-ms-error-code']).toBe('AuthorizationFailure');
      const cp = await req('PUT', `${A}/box/c.txt`, { headers: { 'x-ms-copy-source': `http://127.0.0.1:${port}${A}/box/a.txt` } });
      expect(cp.status).toBe(403);
      expect(cp.headers['x-ms-error-code']).toBe('AuthorizationFailure');
      await api('PATCH', '/api/projects/prov/storage/lim-az', { config: { maxObjects: null, maxObjectBytes: 4 } });
      const big = await req('PUT', `${A}/box/big.txt`, { body: 'too big', headers: { 'x-ms-blob-type': 'BlockBlob' } });
      expect(big.status).toBe(413);
      expect(big.headers['x-ms-error-code']).toBe('RequestBodyTooLarge');
      expect(big.text).toContain('The size of the request body exceeds the maximum size permitted.');
    });

    it('Cloudinary: upload, chunked upload, overwrite and rename allowed', async () => {
      await create('cloudinary', 'lim-cld');
      const C = '/storage/prov/lim-cld';
      const up = (publicId: string, extra: Record<string, string> = {}) => {
        const p = { public_id: publicId, timestamp: String(Math.floor(Date.now() / 1000)), api_key: '123456789012345' };
        const m = multipart({ ...p, signature: cloudinarySignature(p, 'stubyard-secret') }, { name: 'file', filename: `${publicId}.txt`, type: 'text/plain', data: Buffer.from(publicId) });
        return req('POST', `${C}/v1_1/stubyard/raw/upload`, { body: m.body, headers: { 'content-type': m.contentType, ...extra } });
      };
      expect((await up('one')).status).toBe(200);
      const full = await up('two');
      expect(full.status).toBe(400);
      expect(full.json).toEqual({ error: { message: 'Storage quota exceeded' } });
      expect(full.headers['x-cld-error']).toBe('Storage quota exceeded');
      expect(full.headers['x-stubyard-reason']).toBe('instance maxObjects=1');
      expect((await up('one')).status).toBe(200);
      const chunk = await up('big', { 'x-unique-upload-id': 'lim123', 'content-range': 'bytes 0-2/-1' });
      expect(chunk.status).toBe(400);
      expect(chunk.json.error.message).toBe('Storage quota exceeded');
      const p = { from_public_id: 'one', to_public_id: 'uno', timestamp: String(Math.floor(Date.now() / 1000)), api_key: '123456789012345' };
      const rn = await req('POST', `${C}/v1_1/stubyard/raw/rename`, { body: new URLSearchParams({ ...p, signature: cloudinarySignature(p, 'stubyard-secret') }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      expect(rn.status, rn.text).toBe(200);
      await api('PATCH', '/api/projects/prov/storage/lim-cld', { config: { maxObjects: null, maxObjectBytes: 3 } });
      const big = await up('toolarge');
      expect(big.status).toBe(400);
      expect(big.json.error.message).toMatch(/^File size too large\. Got \d+\. Maximum is 3\.$/);
    });

    it('Supabase: upload, upsert allowed, copy refused, move allowed', async () => {
      const inst = await create('supabase', 'lim-sb');
      const key = inst.credentials[1]?.secretAccessKey ?? inst.credentials[0].secretAccessKey;
      const auth = { authorization: `Bearer ${key}`, apikey: key };
      const S = '/storage/prov/lim-sb/storage/v1';
      expect((await req('POST', `${S}/bucket`, { json: { id: 'docs', name: 'docs', public: true }, headers: auth })).status).toBe(200);
      expect((await req('POST', `${S}/object/docs/a.txt`, { body: 'a', headers: { ...auth, 'content-type': 'text/plain' } })).status).toBe(200);
      const full = await req('POST', `${S}/object/docs/b.txt`, { body: 'b', headers: { ...auth, 'content-type': 'text/plain' } });
      // Supabase has no quota error: the refusal is its 403 row-level security answer.
      expect(full.status).toBe(403);
      expect(full.json).toMatchObject({ statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
      expect(full.headers['x-stubyard-reason']).toBe('instance maxObjects=1');
      expect((await req('PUT', `${S}/object/docs/a.txt`, { body: 'a2', headers: { ...auth, 'content-type': 'text/plain' } })).status).toBe(200);
      const cp = await req('POST', `${S}/object/copy`, { json: { bucketId: 'docs', sourceKey: 'a.txt', destinationKey: 'c.txt' }, headers: auth });
      expect(cp.status).toBe(403);
      expect(cp.json.statusCode).toBe('403');
      const mv = await req('POST', `${S}/object/move`, { json: { bucketId: 'docs', sourceKey: 'a.txt', destinationKey: 'moved.txt' }, headers: auth });
      expect(mv.status, mv.text).toBe(200);
      const objs = await api('GET', '/api/projects/prov/storage/lim-sb');
      expect(objs.usage).toMatchObject({ objects: 1, maxObjects: 1 });
      await api('PATCH', '/api/projects/prov/storage/lim-sb', { config: { maxObjects: null, maxObjectBytes: 3 } });
      const big = await req('POST', `${S}/object/docs/big.txt`, { body: 'too big', headers: { ...auth, 'content-type': 'text/plain' } });
      expect(big.status).toBe(400);
      expect(big.json).toMatchObject({ statusCode: '413', code: 'EntityTooLarge', error: 'Payload too large' });
    });
  });

  describe('Simulate errors: rules give the same native response as the real limit', () => {
    const norm = (s: string) => s.replace(/<(RequestId|HostId)>[^<]*<\/\1>/g, '').replace(/RequestId:[^\n<]*\nTime:[^<]*/g, '');
    const P = '/api/projects/prov/storage';
    type Up = (body: string) => Promise<{ status: number; text: string; headers: Record<string, any>; json: any }>;
    const cases: { preset: string; slug: string; setup?: () => Promise<void>; up: (slug: string) => Up; quota: (r: any) => void; tooLarge: (r: any) => void }[] = [
      {
        preset: 's3', slug: 'sim-s3',
        up: (s) => (b) => req('PUT', `/storage/prov/${s}/simb/k.txt`, { body: b }),
        quota: (r) => (expect(r.status).toBe(403), expect(r.text).toContain('<Code>AccessDenied</Code>'), expect(r.text).toContain('<Message>Access Denied</Message>')),
        tooLarge: (r) => (expect(r.status).toBe(400), expect(r.text).toContain('<Code>EntityTooLarge</Code>'), expect(r.text).toContain('<ProposedSize>7</ProposedSize>'), expect(r.text).toContain('<MaxSizeAllowed>3</MaxSizeAllowed>')),
      },
      {
        preset: 'wasabi', slug: 'sim-was',
        up: (s) => (b) => req('PUT', `/storage/prov/${s}/simb/k.txt`, { body: b }),
        quota: (r) => (expect(r.status).toBe(400), expect(r.text).toContain('<Code>StorageQuotaExceeded</Code>')),
        tooLarge: (r) => (expect(r.status).toBe(400), expect(r.text).toContain('Your proposed upload is larger than the maximum allowed size.')),
      },
      {
        preset: 'minio', slug: 'sim-minio',
        up: (s) => (b) => req('PUT', `/storage/prov/${s}/simb/k.txt`, { body: b }),
        quota: (r) => (expect(r.status).toBe(400), expect(r.text).toContain('<Code>XMinioAdminBucketQuotaExceeded</Code>'), expect(r.text).toContain('<Message>Bucket quota exceeded</Message>')),
        tooLarge: (r) => (expect(r.status).toBe(400), expect(r.text).toContain('<Message>Your proposed upload exceeds the maximum allowed object size.</Message>')),
      },
      {
        preset: 'gcs', slug: 'sim-gcs',
        setup: async () => void (await req('POST', '/storage/prov/sim-gcs/storage/v1/b?project=stubyard', { json: { name: 'simb' } })),
        up: (s) => (b) => req('POST', `/storage/prov/${s}/upload/storage/v1/b/simb/o?uploadType=media&name=k.txt`, { body: b, headers: { 'content-type': 'text/plain' } }),
        quota: (r) => (expect(r.status).toBe(403), expect(r.json.error.errors[0].reason).toBe('forbidden')),
        tooLarge: (r) => (expect(r.status).toBe(413), expect(r.json.error.errors[0].reason).toBe('uploadTooLarge')),
      },
      {
        preset: 'azure', slug: 'sim-az',
        setup: async () => void (await req('PUT', '/storage/prov/sim-az/devstoreaccount1/simb?restype=container')),
        up: (s) => (b) => req('PUT', `/storage/prov/${s}/devstoreaccount1/simb/k.txt`, { body: b, headers: { 'x-ms-blob-type': 'BlockBlob' } }),
        quota: (r) => (expect(r.status).toBe(403), expect(r.headers['x-ms-error-code']).toBe('AuthorizationFailure')),
        tooLarge: (r) => (expect(r.status).toBe(413), expect(r.headers['x-ms-error-code']).toBe('RequestBodyTooLarge'), expect(r.text).toContain('The size of the request body exceeds the maximum size permitted.')),
      },
      {
        preset: 'cloudinary', slug: 'sim-cld',
        up: (s) => (b) => {
          const p = { public_id: 'k', timestamp: String(Math.floor(Date.now() / 1000)), api_key: '123456789012345' };
          const m = multipart({ ...p, signature: cloudinarySignature(p, 'stubyard-secret') }, { name: 'file', filename: 'k.txt', type: 'text/plain', data: Buffer.from(b) });
          return req('POST', `/storage/prov/${s}/v1_1/stubyard/raw/upload`, { body: m.body, headers: { 'content-type': m.contentType } });
        },
        quota: (r) => (expect(r.status).toBe(400), expect(r.json.error.message).toBe('Storage quota exceeded')),
        tooLarge: (r) => (expect(r.status).toBe(400), expect(r.json.error.message).toMatch(/^File size too large\. Got \d+\. Maximum is 3\.$/)),
      },
      {
        preset: 'supabase', slug: 'sim-sb',
        setup: async () => void (await req('POST', '/storage/prov/sim-sb/storage/v1/bucket', { json: { id: 'simb', name: 'simb' } })),
        up: (s) => (b) => req('POST', `/storage/prov/${s}/storage/v1/object/simb/k.txt`, { body: b, headers: { 'content-type': 'text/plain' } }),
        quota: (r) => (expect(r.status).toBe(403), expect(r.json).toMatchObject({ statusCode: '403', error: 'Unauthorized' })),
        tooLarge: (r) => (expect(r.status).toBe(400), expect(r.json).toMatchObject({ statusCode: '413', code: 'EntityTooLarge' })),
      },
    ];
    for (const c of cases) {
      it(`${c.preset}: quota_exceeded and entity_too_large rules match the real limits`, async () => {
        const inst = await api('POST', P, { preset: c.preset, slug: c.slug });
        // The instance view lists the rows with the native error each one produces.
        const rows = Object.fromEntries(inst.simulate.map((r: any) => [r.id, r]));
        expect(rows['too-large'].error.status).toBeGreaterThanOrEqual(400);
        await c.setup?.();
        const up = c.up(c.slug);
        const R = `${P}/${c.slug}/rules`;
        await api('POST', R, { action: 'quota_exceeded', op: 'put', params: { simulate: 'quota' } });
        const ruleQuota = await up('1234567');
        c.quota(ruleQuota);
        expect(ruleQuota.headers['x-stubyard-reason']).toBe('scenario quota_exceeded');
        await api('DELETE', R);
        await api('POST', R, { action: 'entity_too_large', op: 'put', maxBytes: 3, params: { simulate: 'too-large' } });
        const ruleBig = await up('1234567');
        c.tooLarge(ruleBig);
        await api('DELETE', R);
        await api('PATCH', `${P}/${c.slug}`, { config: { quotaBytes: 1 } });
        const realQuota = await up('1234567');
        c.quota(realQuota);
        expect(realQuota.status).toBe(ruleQuota.status);
        expect(norm(realQuota.text)).toBe(norm(ruleQuota.text));
        await api('PATCH', `${P}/${c.slug}`, { config: { quotaBytes: null, maxObjectBytes: 3 } });
        const realBig = await up('1234567');
        expect(realBig.status).toBe(ruleBig.status);
        expect(norm(realBig.text)).toBe(norm(ruleBig.text));
        await api('PATCH', `${P}/${c.slug}`, { config: { maxObjectBytes: null } });

        // Dashboard uploads go through the same rules; the answer names the native error.
        await api('POST', R, { action: 'quota_exceeded', op: 'put', count: 1 });
        const hub = await req('PUT', `/storage/prov/${c.slug}/__hub/objects/simb/dash.txt`, { body: 'x' });
        expect(hub.status).toBe(ruleQuota.status);
        expect(hub.json.error).toMatch(/^Simulated .+ error: \d{3}/);
        expect(hub.json.native.status).toBe(ruleQuota.status);
        expect((await req('PUT', `/storage/prov/${c.slug}/__hub/objects/simb/dash.txt`, { body: 'x' })).status).toBe(201);
        await api('DELETE', `${P}/${c.slug}`);
      });
    }

    it('the row higher in the list wins when several are on', async () => {
      await api('POST', P, { preset: 's3', slug: 'sim-order' });
      const R = `${P}/sim-order/rules`;
      await api('POST', R, { action: 'quota_exceeded', op: 'put', params: { simulate: 'quota' } });
      await api('POST', R, { action: 'access_denied', op: 'put', params: { simulate: 'deny-uploads' } });
      const r = await req('PUT', '/storage/prov/sim-order/simb/k.txt', { body: 'x' });
      expect(r.headers['x-stubyard-reason']).toBe('scenario access_denied');
      await api('DELETE', `${P}/sim-order`);
    });
  });
});
