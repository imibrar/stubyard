/**
 * File storage simulator: unit pieces (aws-chunked, checksums, SigV4, XML, listing, ranges, ETags) and end-to-end
 * behaviour over HTTP (streaming without buffering, Expect: 100-continue, traffic log without bytes, rules incl.
 * run scoping and hub_scenario, CORS, CSP sandbox, quotas, lifecycle: export/import, run purge, project delete,
 * orphan sweep, control API, __hub uploads, MCP tools).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { startHub, type RunningHub } from '../src/index.js';
import { AwsChunkedDecoder } from '../src/storage/aws-chunked.js';
import { checksumOf, compositeChecksum, multipartEtag } from '../src/storage/checksums.js';
import { parseRange } from '../src/storage/s3/common.js';
import { parseSigV4, presignUrl, verifySigV4 } from '../src/storage/sigv4.js';
import { successor } from '../src/storage/store.js';
import { el, parseXml, text, xmlDoc } from '../src/storage/xml.js';

const MAILPIT_BIN = process.env.STUBYARD_MAILPIT_BIN ?? '/usr/local/bin/mailpit';
const haveMailpit = fs.existsSync(MAILPIT_BIN);

// ---------------------------------------------------------------- unit

describe('storage units', () => {
  it('CRC32 / CRC32C / CRC64NVME match the published check values', () => {
    const v = Buffer.from('123456789');
    expect(Buffer.from(checksumOf('crc32', v), 'base64').toString('hex')).toBe('cbf43926');
    expect(Buffer.from(checksumOf('crc32c', v), 'base64').toString('hex')).toBe('e3069283');
    expect(Buffer.from(checksumOf('crc64nvme', v), 'base64').toString('hex')).toBe('ae8b14860a799888');
    expect(checksumOf('sha256', Buffer.from(''))).toBe(crypto.createHash('sha256').digest('base64'));
  });

  it('multipart ETag and composite checksum', () => {
    const a = crypto.createHash('md5').update('a').digest('hex');
    const b = crypto.createHash('md5').update('b').digest('hex');
    const expected = crypto.createHash('md5').update(Buffer.concat([Buffer.from(a, 'hex'), Buffer.from(b, 'hex')])).digest('hex');
    expect(multipartEtag([a, b])).toBe(`"${expected}-2"`);
    expect(compositeChecksum('crc32', [checksumOf('crc32', Buffer.from('a')), checksumOf('crc32', Buffer.from('b'))])).toMatch(/^[A-Za-z0-9+/=]+-2$/);
  });

  const decode = async (chunks: Buffer[]) => {
    const d = new AwsChunkedDecoder();
    const out: Buffer[] = [];
    d.on('data', (c) => out.push(c));
    await new Promise<void>((resolve, reject) => {
      d.on('end', resolve);
      d.on('error', reject);
      for (const c of chunks) d.write(c);
      d.end();
    });
    return { data: Buffer.concat(out).toString(), trailers: d.trailers, chunks: d.chunks };
  };

  it('aws-chunked: signed chunks, trailers, split at every byte', async () => {
    const crc = checksumOf('crc32', Buffer.from('hello world'));
    const body = Buffer.from(`5;chunk-signature=aaa\r\nhello\r\n6;chunk-signature=bbb\r\n world\r\n0;chunk-signature=ccc\r\nx-amz-checksum-crc32:${crc}\r\nx-amz-trailer-signature:ddd\r\n\r\n`);
    const whole = await decode([body]);
    expect(whole.data).toBe('hello world');
    expect(whole.trailers['x-amz-checksum-crc32']).toBe(crc);
    expect(whole.chunks.map((c) => c.signature)).toEqual(['aaa', 'bbb', 'ccc']);
    const bytes = await decode([...body].map((b) => Buffer.from([b])));
    expect(bytes.data).toBe('hello world');
    expect(bytes.trailers['x-amz-trailer-signature']).toBe('ddd');
  });

  it('aws-chunked: unsigned with trailer; truncated input fails', async () => {
    const r = await decode([Buffer.from('3\r\nabc\r\n0\r\nx-amz-checksum-crc32c:AAAAAA==\r\n\r\n')]);
    expect(r.data).toBe('abc');
    await expect(decode([Buffer.from('a\r\nabc')])).rejects.toThrow(/ended before/);
  });

  it('SigV4: AWS documentation vectors (header and presigned)', () => {
    const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const headers = {
      host: 'examplebucket.s3.amazonaws.com',
      range: 'bytes=0-9',
      'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'x-amz-date': '20130524T000000Z',
      authorization:
        'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    };
    const a = parseSigV4(headers, new URLSearchParams());
    expect(a.accessKeyId).toBe('AKIAIOSFODNN7EXAMPLE');
    // The request reached stubyard on another host: the candidate list still finds the signed one.
    expect(verifySigV4(a, { method: 'GET', rawUrl: '/test.txt', headers: { ...headers, host: 'localhost:4000' }, secret, hosts: ['localhost:4000', 'examplebucket.s3.amazonaws.com'] })).toMatchObject({ ok: true, host: 'examplebucket.s3.amazonaws.com' });
    expect(verifySigV4(a, { method: 'GET', rawUrl: '/test.txt', headers, secret: 'nope', hosts: [headers.host] }).ok).toBe(false);
    const raw = '/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404';
    const q = new URLSearchParams(raw.split('?')[1]);
    const p = parseSigV4({ host: 'examplebucket.s3.amazonaws.com' }, q);
    expect(p.type).toBe('sigv4-query');
    expect(p.expiresAt).toBe('2013-05-25T00:00:00.000Z');
    expect(verifySigV4(p, { method: 'GET', rawUrl: raw, headers: { host: 'examplebucket.s3.amazonaws.com' }, secret, hosts: ['examplebucket.s3.amazonaws.com'] }).ok).toBe(true);
    // Our own presigner round-trips.
    const url = new URL(presignUrl({ method: 'GET', url: 'http://localhost:4000/storage/p/s3/b/a%20b.txt', accessKeyId: 'k', secret: 's', region: 'us-east-1', expiresIn: 60 }));
    const pp = parseSigV4({ host: url.host }, url.searchParams);
    expect(verifySigV4(pp, { method: 'GET', rawUrl: url.pathname + url.search, headers: { host: url.host }, secret: 's', hosts: [url.host] }).ok).toBe(true);
  });

  it('XML round trip and escaping', () => {
    const doc = xmlDoc(el('Delete', el('Object', el('Key', 'a&b <c> "d"')), el('Quiet', true)));
    const parsed = parseXml(doc);
    expect(parsed.name).toBe('Delete');
    expect(text(parsed.children[0], 'Key')).toBe('a&b <c> "d"');
    expect(text(parsed, 'Quiet')).toBe('true');
    expect(() => parseXml('<a><b></a>')).toThrow();
  });

  it('Range parsing', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=95-', 100)).toEqual({ start: 95, end: 99 });
    expect(parseRange('bytes=90-200', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBe('invalid');
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
  });

  it('successor() orders after every string with the prefix', () => {
    expect(successor('a/')).toBe('a0');
    expect(Buffer.compare(Buffer.from(successor('é/')), Buffer.from('é/zzz'))).toBe(1);
  });
});

// ---------------------------------------------------------------- end to end

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
      headers['content-type'] = 'application/json';
    } else if (o.body !== undefined) body = Buffer.isBuffer(o.body) ? o.body : Buffer.from(o.body);
    if (body) headers['content-length'] = String(body.length);
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('aborted')));
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

const B = '/storage/e2e/s3';

describe.skipIf(!haveMailpit)('storage e2e', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-storage-'));
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
        maxEmailBytes: 1024 * 1024, // global body limit 1 MB: storage must not be affected
        storageDomain: 's3.localhost',
      }),
      { tls: false },
    );
    await api('POST', '/api/projects', { name: 'e2e' });
    await api('POST', '/api/projects/e2e/storage', { preset: 's3' });
  }, 60_000);

  afterAll(async () => {
    await running?.close();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('unknown project / instance answer S3 XML with a hint', async () => {
    const r = await req('GET', '/storage/nope/s3/b/k');
    expect(r.status).toBe(404);
    expect(r.text).toContain('<Code>NoSuchBucket</Code>');
    expect(r.text).toContain('no project &quot;nope&quot;');
    const r2 = await req('GET', '/storage/e2e/missing/b/k');
    expect(r2.text).toContain('POST /api/projects/e2e/storage');
  });

  it('streams bodies larger than the global body limit; traffic log keeps sizes, never bytes', async () => {
    const data = crypto.randomBytes(3 * 1024 * 1024);
    const put = await req('PUT', `${B}/big/blob.bin`, { body: data, headers: { 'content-type': 'application/octet-stream' } });
    expect(put.status).toBe(200);
    expect(put.headers.etag).toBe(`"${crypto.createHash('md5').update(data).digest('hex')}"`);
    const get = await req('GET', `${B}/big/blob.bin`);
    expect(get.buf.equals(data)).toBe(true);
    const logs = running.hub.db.prepare(`SELECT method, req_body, req_body_size, res_body, res_body_size FROM traffic_logs WHERE url LIKE '%/big/blob.bin' ORDER BY id`).all() as any[];
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ method: 'PUT', req_body: null, req_body_size: data.length });
    expect(logs[1]).toMatchObject({ method: 'GET', res_body: null, res_body_size: data.length });
    // Files are named by id, never by key.
    const files = fs.readdirSync(path.join(dataDir, 'storage'), { recursive: true }).map(String);
    expect(files.some((f) => f.includes('blob'))).toBe(false);
  });

  it('S3 basics over raw HTTP: errors, Range, conditional GET, CSP sandbox, key traversal', async () => {
    expect((await req('GET', `${B}/big/missing`)).text).toContain('<Code>NoSuchKey</Code>');
    const head = await req('HEAD', `${B}/big/missing`);
    expect(head.status).toBe(404);
    expect(head.text).toBe('');
    await req('PUT', `${B}/web/page.html`, { body: '<script>alert(1)</script>', headers: { 'content-type': 'text/html' } });
    const html = await req('GET', `${B}/web/page.html`);
    expect(html.headers['content-security-policy']).toBe('sandbox');
    expect(html.headers['x-content-type-options']).toBe('nosniff');
    const etag = html.headers.etag as string;
    expect((await req('GET', `${B}/web/page.html`, { headers: { 'if-none-match': etag } })).status).toBe(304);
    expect((await req('GET', `${B}/web/page.html`, { headers: { 'if-match': '"nope"' } })).status).toBe(412);
    const rng = await req('GET', `${B}/web/page.html`, { headers: { range: 'bytes=0-7' } });
    expect(rng.status).toBe(206);
    expect(rng.text).toBe('<script>');
    expect((await req('GET', `${B}/web/page.html`, { headers: { range: 'bytes=999-' } })).status).toBe(416);
    // "../" in a key is just a key.
    const t = await req('PUT', `${B}/web/..%2F..%2F..%2Fescape.txt`, { body: 'x' });
    expect(t.status).toBe(200);
    expect(fs.existsSync(path.join(dataDir, 'escape.txt'))).toBe(false);
    expect((await req('GET', `${B}/web/..%2F..%2F..%2Fescape.txt`)).text).toBe('x');
    // Bad Content-MD5 → BadDigest, nothing stored.
    const bad = await req('PUT', `${B}/web/md5.txt`, { body: 'abc', headers: { 'content-md5': crypto.createHash('md5').update('xyz').digest('base64') } });
    expect(bad.status).toBe(400);
    expect(bad.text).toContain('BadDigest');
    expect((await req('HEAD', `${B}/web/md5.txt`)).status).toBe(404);
    // Wrong hex SHA-256 → XAmzContentSHA256Mismatch.
    const sha = await req('PUT', `${B}/web/sha.txt`, { body: 'abc', headers: { 'x-amz-content-sha256': 'a'.repeat(64) } });
    expect(sha.text).toContain('XAmzContentSHA256Mismatch');
  });

  it('listing: 2,500 keys with delimiter, non-ASCII keys, encoding-type=url', async () => {
    const st = running.hub.storage;
    const p = running.hub.projects.getBySlug('e2e')!;
    const inst = st.repo.getInstance(p.id, 's3')!;
    const store = st.store(inst);
    const bucket = store.bucketOrCreate('many');
    for (let i = 0; i < 2500; i++) await store.put(bucket, `d${i % 5}/f${String(i).padStart(4, '0')}`, Readable.from([Buffer.from('x')]));
    for (const k of ['ü/1', 'z', 'é', 'a b']) await store.put(bucket, k, Readable.from([Buffer.from('x')]));
    const top = await req('GET', `${B}/many?list-type=2&delimiter=/&max-keys=1000`);
    const doc = parseXml(top.text);
    expect(doc.children.filter((c) => c.name === 'CommonPrefixes').map((c) => text(c, 'Prefix'))).toEqual(['d0/', 'd1/', 'd2/', 'd3/', 'd4/', 'ü/']);
    expect(doc.children.filter((c) => c.name === 'Contents').map((c) => text(c, 'Key'))).toEqual(['a b', 'z', 'é']);
    let token: string | undefined;
    let n = 0;
    let pages = 0;
    do {
      const r = await req('GET', `${B}/many?list-type=2&prefix=d3/&max-keys=150${token ? `&continuation-token=${encodeURIComponent(token)}` : ''}`);
      const d = parseXml(r.text);
      n += d.children.filter((c) => c.name === 'Contents').length;
      token = text(d, 'NextContinuationToken');
      pages++;
    } while (token);
    expect(n).toBe(500);
    expect(pages).toBe(4);
    const enc = await req('GET', `${B}/many?list-type=2&prefix=%C3%BC&encoding-type=url`);
    expect(enc.text).toContain('<Key>%C3%BC/1</Key>');
  });

  it('Expect: 100-continue — a rejected upload is never sent', async () => {
    const rule = await api('POST', '/api/projects/e2e/storage/s3/rules', { action: 'access_denied', op: 'put', count: 1 });
    const result = await new Promise<{ status: number; continued: boolean; body: string }>((resolve, reject) => {
      let continued = false;
      const r = http.request({ host: '127.0.0.1', port, method: 'PUT', path: `${B}/exp/big.bin`, headers: { expect: '100-continue', 'content-length': String(50 * 1024 * 1024) } }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode!, continued, body: b }));
      });
      r.on('continue', () => {
        continued = true;
        r.write(Buffer.alloc(1024));
      });
      r.on('error', reject);
    });
    expect(result).toMatchObject({ status: 403, continued: false });
    expect(result.body).toContain('AccessDenied');
    expect((await api('GET', '/api/projects/e2e/storage/s3/rules')).find((x: any) => x.id === rule.id).hits).toBe(1);
    // Accepted upload: 100 Continue is sent, then the body.
    const ok = await new Promise<{ status: number; continued: boolean }>((resolve, reject) => {
      let continued = false;
      const r = http.request({ host: '127.0.0.1', port, method: 'PUT', path: `${B}/exp/ok.bin`, headers: { expect: '100-continue', 'content-length': '5' } }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode!, continued }));
      });
      r.on('continue', () => {
        continued = true;
        r.end('hello');
      });
      r.on('error', reject);
    });
    expect(ok).toEqual({ status: 200, continued: true });
  });

  it('client abort mid-upload leaves no tmp file and no object', async () => {
    await new Promise<void>((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => {
        s.write(`PUT ${B}/abort/x.bin HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 1000000\r\n\r\n`);
        s.write(Buffer.alloc(10_000));
        setTimeout(() => {
          s.destroy();
          resolve();
        }, 150);
      });
    });
    await new Promise((r) => setTimeout(r, 200));
    const p = running.hub.projects.getBySlug('e2e')!;
    const tmp = path.join(dataDir, 'storage', p.id, 'tmp');
    expect(fs.existsSync(tmp) ? fs.readdirSync(tmp) : []).toEqual([]);
    expect((await req('HEAD', `${B}/abort/x.bin`)).status).toBe(404);
  });

  it('rules: hub_scenario on a presigned URL, run scoping, complete_error_200, checksum_mismatch download', async () => {
    const pre = await api('POST', '/api/projects/e2e/storage/s3/presign', { bucket: 'web', key: 'page.html', method: 'GET', expiresIn: 60, scenario: 'slow_down' });
    const u = new URL(pre.backend);
    const r = await req('GET', u.pathname + u.search);
    expect(r.status).toBe(503);
    expect(r.text).toContain('<Code>SlowDown</Code>');
    expect(r.headers['retry-after']).toBe('1');
    const plain = await api('POST', '/api/projects/e2e/storage/s3/presign', { bucket: 'web', key: 'page.html', method: 'GET', expiresIn: 60 });
    expect(pre.browser).toContain('/storage/e2e/s3/web/page.html');
    const pu = new URL(plain.backend);
    expect((await req('GET', pu.pathname + pu.search)).status).toBe(200);

    // Run-scoped rule: only that run's requests fail; it goes when the run stops.
    await api('POST', '/api/projects/e2e/runs', { key: 'w1' });
    await api('POST', '/api/projects/e2e/runs', { key: 'w2' });
    await api('POST', '/api/projects/e2e/storage/s3/rules?run=w1', { action: 'access_denied', op: 'get' });
    expect((await req('GET', `/run/w1${B}/web/page.html`)).status).toBe(403);
    expect((await req('GET', `${B}/web/page.html`, { headers: { 'x-hub-run': 'w2' } })).status).toBe(200);
    expect((await req('GET', `${B}/web/page.html`)).status).toBe(200);
    // Objects uploaded inside a run are attributed to it and purged with it.
    expect((await req('PUT', `/run/w1${B}/runfiles/a.txt`, { body: 'run file' })).status).toBe(200);
    const listed = await api('GET', '/api/projects/e2e/storage/s3/buckets/runfiles/objects?run=w1');
    expect(listed.objects.map((o: any) => o.key)).toEqual(['a.txt']);
    const stopped = await api('POST', '/api/projects/e2e/runs/w1/stop', { purge: true });
    expect(stopped.report.storage.uploads).toBe(1);
    expect(running.hub.storage.repo.listRules(running.hub.storage.repo.getInstance(running.hub.projects.getBySlug('e2e')!.id, 's3')!.id, { runId: 'all' }).filter((x) => x.runId)).toHaveLength(0);
    expect((await req('HEAD', `${B}/runfiles/a.txt`)).status).toBe(404);
    await api('POST', '/api/projects/e2e/runs/w2/stop', {});

    // complete_error_200
    await api('POST', '/api/projects/e2e/storage/s3/rules', { action: 'complete_error_200', count: 1 });
    const init = await req('POST', `${B}/mpu/x.bin?uploads`);
    const uploadId = text(parseXml(init.text), 'UploadId')!;
    const part = await req('PUT', `${B}/mpu/x.bin?partNumber=1&uploadId=${uploadId}`, { body: 'part one' });
    const complete = await req('POST', `${B}/mpu/x.bin?uploadId=${uploadId}`, { body: `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>${part.headers.etag}</ETag></Part></CompleteMultipartUpload>` });
    expect(complete.status).toBe(200);
    expect(complete.text).toContain('<Error><Code>InternalError</Code>');
    const again = await req('POST', `${B}/mpu/x.bin?uploadId=${uploadId}`, { body: `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>${part.headers.etag}</ETag></Part></CompleteMultipartUpload>` });
    expect(again.text).toContain('<CompleteMultipartUploadResult');
    expect(again.text).toContain(`<Location>http://127.0.0.1:${port}${B}/mpu/x.bin</Location>`);

    // checksum_mismatch on download: one byte flipped, headers intact.
    await api('POST', '/api/projects/e2e/storage/s3/rules', { action: 'checksum_mismatch', op: 'get', count: 1 });
    const flipped = await req('GET', `${B}/big/blob.bin`);
    const good = await req('GET', `${B}/big/blob.bin`);
    expect(flipped.buf.length).toBe(good.buf.length);
    expect(flipped.buf.equals(good.buf)).toBe(false);

    // reset: socket destroyed mid-download.
    await api('POST', '/api/projects/e2e/storage/s3/rules', { action: 'reset', op: 'get', afterBytes: 1000, count: 1 });
    await expect(req('GET', `${B}/big/blob.bin`)).rejects.toThrow();
  });

  it('CORS: permissive preflight, S3 rules enforced, cors_blocked', async () => {
    const pf = await req('OPTIONS', `${B}/web/page.html`, { headers: { origin: 'http://app.test', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type' } });
    expect(pf.status).toBe(200);
    expect(pf.headers['access-control-allow-origin']).toBe('http://app.test');
    expect(String(pf.headers['access-control-expose-headers'])).toContain('ETag');
    const corsXml = '<CORSConfiguration><CORSRule><AllowedOrigin>http://good.test</AllowedOrigin><AllowedMethod>GET</AllowedMethod></CORSRule></CORSConfiguration>';
    expect((await req('PUT', `${B}/web?cors`, { body: corsXml })).status).toBe(200);
    expect((await req('OPTIONS', `${B}/web/page.html`, { headers: { origin: 'http://evil.test', 'access-control-request-method': 'GET' } })).status).toBe(403);
    const ok = await req('OPTIONS', `${B}/web/page.html`, { headers: { origin: 'http://good.test', 'access-control-request-method': 'GET' } });
    expect(ok.headers['access-control-allow-origin']).toBe('http://good.test');
    expect((await req('GET', `${B}/web?cors`)).text).toContain('<AllowedOrigin>http://good.test</AllowedOrigin>');
    await req('DELETE', `${B}/web?cors`);
    await api('POST', '/api/projects/e2e/storage/s3/rules', { action: 'cors_blocked', count: 1 });
    expect((await req('OPTIONS', `${B}/web/page.html`, { headers: { origin: 'http://app.test', 'access-control-request-method': 'GET' } })).status).toBe(403);
  });

  it('quota refusal and entity_too_large', async () => {
    await api('PATCH', '/api/projects/e2e/storage/s3', { config: { maxObjectBytes: 1000 } });
    const big = await req('PUT', `${B}/quota/big.bin`, { body: Buffer.alloc(2000) });
    expect(big.status).toBe(400);
    expect(big.text).toContain('EntityTooLarge');
    await api('PATCH', '/api/projects/e2e/storage/s3', { config: { maxObjectBytes: null, quotaBytes: 1 } });
    const q = await req('PUT', `${B}/quota/small.bin`, { body: Buffer.alloc(100) });
    expect(q.status).toBe(403);
    expect(q.text).toContain('QuotaExceeded');
    expect(String(q.headers['x-stubyard-reason'])).toContain('quotaBytes');
    await api('PATCH', '/api/projects/e2e/storage/s3', { config: { quotaBytes: null } });
    expect((await req('PUT', `${B}/quota/small.bin`, { body: Buffer.alloc(100) })).status).toBe(200);
  });

  it('virtual-hosted style via STUBYARD_STORAGE_DOMAIN', async () => {
    const r = await req('GET', '/page.html', { headers: { host: `web.s3.e2e.s3.localhost:${port}` } });
    expect(r.status).toBe(200);
    expect(r.text).toContain('<script>');
  });

  it('control API: instances, buckets, objects, __hub upload, content (sandboxed), delete, uploads', async () => {
    const list = await api('GET', '/api/projects/e2e/storage');
    expect(list[0]).toMatchObject({ slug: 's3', preset: 's3', region: 'us-east-1', urls: { backend: `http://localhost:${port}/storage/e2e/s3` } });
    expect(list[0].snippets.map((s: any) => s.title)).toContain('Python — boto3');
    const presets = await api('GET', '/api/storage-presets');
    expect(presets.presets.map((p: any) => p.id)).toEqual(expect.arrayContaining(['s3', 'r2', 'spaces', 'b2', 'minio', 'wasabi']));
    await api('POST', '/api/projects/e2e/storage/s3/buckets', { name: 'dash' });
    const up = await req('PUT', `${B}/__hub/objects/dash/folder/note.svg`, { body: '<svg xmlns="http://www.w3.org/2000/svg"/>', headers: { 'content-type': 'image/svg+xml' } });
    expect(up.status).toBe(201);
    expect(up.json).toMatchObject({ key: 'folder/note.svg', source: 'dashboard' });
    const folder = await api('GET', '/api/projects/e2e/storage/s3/buckets/dash/objects?delimiter=/');
    expect(folder.prefixes).toEqual(['folder/']);
    const content = await req('GET', '/api/projects/e2e/storage/s3/buckets/dash/object/content?key=folder/note.svg');
    expect(content.headers['content-security-policy']).toBe('sandbox');
    const wait = api('GET', '/api/projects/e2e/storage/s3/buckets/dash/objects/wait?prefix=late/&timeoutMs=5000');
    setTimeout(() => void req('PUT', `${B}/dash/late/a.txt`, { body: 'late' }), 200);
    expect((await wait).objects.map((o: any) => o.key)).toEqual(['late/a.txt']);
    expect((await req('DELETE', '/api/projects/e2e/storage/s3/buckets/dash')).status).toBe(409);
    const init = await req('POST', `${B}/dash/pending.bin?uploads`);
    expect(init.status).toBe(200);
    const ups = await api('GET', '/api/projects/e2e/storage/s3/uploads');
    expect(ups.some((u: any) => u.key === 'pending.bin')).toBe(true);
    await api('DELETE', `/api/projects/e2e/storage/s3/uploads/${ups.find((u: any) => u.key === 'pending.bin').id}`);
    expect((await api('DELETE', '/api/projects/e2e/storage/s3/buckets/dash?force=1')).objects).toBe(2);
  });

  it('MCP tools', async () => {
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await api('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
      expect(r.result.isError).toBeFalsy();
      return JSON.parse(r.result.content[0].text);
    };
    const tools = (await api('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.map((t: any) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['list_storage', 'list_files', 'get_file', 'get_file_url', 'wait_for_upload', 'delete_files', 'set_storage_scenario', 'reset_storage_scenarios']));
    expect((await call('list_storage', { project: 'e2e' })).instances[0].slug).toBe('s3');
    await req('PUT', `${B}/mcp/data.json`, { body: '{"hello":"world"}', headers: { 'content-type': 'application/json' } });
    expect((await call('list_files', { project: 'e2e', instance: 's3', bucket: 'mcp' })).files[0].key).toBe('data.json');
    expect((await call('get_file', { project: 'e2e', instance: 's3', bucket: 'mcp', key: 'data.json' })).preview).toContain('world');
    expect((await call('get_file_url', { project: 'e2e', instance: 's3', bucket: 'mcp', key: 'data.json' })).browser).toContain('X-Amz-Signature=');
    await call('set_storage_scenario', { project: 'e2e', instance: 's3', action: 'not_found', op: 'get', count: 1 });
    expect((await req('GET', `${B}/mcp/data.json`)).status).toBe(404);
    await call('set_storage_scenario', { project: 'e2e', instance: 's3', action: 'access_denied' });
    await call('reset_storage_scenarios', { project: 'e2e', instance: 's3' });
    expect((await req('GET', `${B}/mcp/data.json`)).status).toBe(200);
    expect((await call('delete_files', { project: 'e2e', instance: 's3', bucket: 'mcp', prefix: '' })).deleted).toBe(1);
  });

  it('lifecycle: export → import keeps config, no objects; sweep; project delete removes files', async () => {
    await api('PATCH', '/api/projects/e2e/storage/s3/buckets/web', { public: true });
    await api('POST', '/api/projects/e2e/storage/s3/rules', { action: 'slow_down', op: 'put', label: 'kept' });
    const exp = await api('GET', '/api/projects/e2e/export');
    expect(exp.storageInstances[0]).toMatchObject({ slug: 's3' });
    expect(exp.storageInstances[0].config.credentials).toBeUndefined();
    expect(exp.storageBuckets.find((b: any) => b.name === 'web').public).toBe(true);
    expect(exp.storageRules.map((r: any) => r.label)).toContain('kept');
    expect(JSON.stringify(exp)).not.toContain('blob.bin');
    const imported = await api('POST', '/api/projects/import', { json: exp, slug: 'e2e-copy', name: 'e2e copy' });
    expect(imported).toBeTruthy();
    const copy = running.hub.projects.getBySlug('e2e-copy')!;
    const ci = running.hub.storage.repo.getInstance(copy.id, 's3')!;
    expect(running.hub.storage.repo.listBuckets(ci.id).map((b) => b.name)).toContain('web');
    expect(running.hub.storage.repo.usage({ projectId: copy.id }).objects).toBe(0);
    expect(running.hub.storage.repo.listRules(ci.id).map((r) => r.label)).toContain('kept');

    // Orphans (file without a row, older than an hour) are swept.
    const p = running.hub.projects.getBySlug('e2e')!;
    const inst = running.hub.storage.repo.getInstance(p.id, 's3')!;
    const orphan = path.join(dataDir, 'storage', p.id, inst.id, 'objects', 'zz', 'orphanzz');
    fs.mkdirSync(path.dirname(orphan), { recursive: true });
    fs.writeFileSync(orphan, 'x');
    const past = new Date(Date.now() - 2 * 3600_000);
    fs.utimesSync(orphan, past, past);
    const report = await running.hub.maintenance.run();
    expect(report.storage!.orphansSwept).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(orphan)).toBe(false);

    // Reset with { storage: true } removes every object; project delete removes the directory.
    await api('DELETE', '/api/projects/e2e/storage/s3/rules');
    const reset = await api('POST', '/api/projects/e2e/reset', { storage: true });
    expect(reset.storage.objects).toBeGreaterThan(0);
    expect(running.hub.storage.repo.usage({ projectId: p.id }).objects).toBe(0);
    await req('PUT', `${B}/web/again.txt`, { body: 'x' });
    expect(fs.existsSync(path.join(dataDir, 'storage', p.id))).toBe(true);
    await api('DELETE', '/api/projects/e2e');
    expect(fs.existsSync(path.join(dataDir, 'storage', p.id))).toBe(false);
  });
});
