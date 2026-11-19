import crypto from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';

/**
 * Decoder for `Content-Encoding: aws-chunked` bodies (x-amz-content-sha256: STREAMING-…):
 *   <hex>[;chunk-signature=<sig>]\r\n<data>\r\n … 0[;chunk-signature=<sig>]\r\n[<trailer>:<value>\r\n…]\r\n
 * Handles signed and unsigned chunks and trailers (x-amz-checksum-*, x-amz-trailer-signature). Chunk headers may be
 * split across reads. Chunk signatures are recorded (with the SHA-256 of each chunk's data) for optional verification.
 */
export class AwsChunkedDecoder extends Transform {
  readonly trailers: Record<string, string> = {};
  readonly chunks: { size: number; signature: string | null; sha256: string | null }[] = [];
  decodedBytes = 0;
  private state: 'header' | 'data' | 'crlf' | 'trailer' | 'done' = 'header';
  private line = Buffer.alloc(0);
  private remaining = 0;
  private cur: { size: number; signature: string | null; hash: crypto.Hash | null } | null = null;
  private crlfLeft = 0;

  constructor(private opts: { hashChunks?: boolean } = {}) {
    super();
  }

  get complete(): boolean {
    return this.state === 'done';
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    try {
      this.consume(chunk);
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }

  override _flush(cb: TransformCallback): void {
    // Lenient end: the zero-size chunk was seen and only the final CRLF (or trailers' end) is missing.
    if (this.state === 'trailer' && this.line.length === 0) this.state = 'done';
    if (this.state === 'trailer' && this.line.length) {
      this.trailerLine(this.line.toString('latin1'));
      this.state = 'done';
    }
    if (this.state !== 'done') return cb(Object.assign(new Error('aws-chunked body ended before the final chunk'), { code: 'INCOMPLETE_CHUNKED' }));
    cb();
  }

  private consume(buf: Buffer): void {
    let i = 0;
    while (i < buf.length) {
      switch (this.state) {
        case 'header':
        case 'trailer': {
          const nl = buf.indexOf(0x0a, i);
          if (nl < 0) {
            this.line = Buffer.concat([this.line, buf.subarray(i)]);
            if (this.line.length > 64 * 1024) throw new Error('aws-chunked header line too long');
            return;
          }
          let line = Buffer.concat([this.line, buf.subarray(i, nl)]);
          this.line = Buffer.alloc(0);
          i = nl + 1;
          if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
          const text = line.toString('latin1');
          if (this.state === 'header') this.chunkHeader(text);
          else if (text === '') this.state = 'done';
          else this.trailerLine(text);
          break;
        }
        case 'data': {
          const n = Math.min(this.remaining, buf.length - i);
          const part = buf.subarray(i, i + n);
          this.cur?.hash?.update(part);
          this.decodedBytes += n;
          this.push(part);
          this.remaining -= n;
          i += n;
          if (this.remaining === 0) {
            this.endChunk();
            this.state = 'crlf';
            this.crlfLeft = 2;
          }
          break;
        }
        case 'crlf': {
          // Tolerate a bare \n.
          const c = buf[i];
          if (c === 0x0d || c === 0x0a) {
            i++;
            this.crlfLeft--;
            if (c === 0x0a) this.crlfLeft = 0;
          } else this.crlfLeft = 0;
          if (this.crlfLeft <= 0) this.state = 'header';
          break;
        }
        case 'done':
          return; // ignore anything after the terminator
      }
    }
  }

  private chunkHeader(text: string): void {
    if (text === '') return; // stray CRLF
    const [sizeHex, ...ext] = text.split(';');
    const size = Number.parseInt(sizeHex.trim(), 16);
    if (!Number.isFinite(size) || size < 0 || !/^[0-9a-f]+$/i.test(sizeHex.trim())) throw new Error(`Invalid aws-chunked chunk header "${text.slice(0, 80)}"`);
    let signature: string | null = null;
    for (const e of ext) {
      const [k, v] = e.split('=');
      if (k.trim() === 'chunk-signature') signature = (v ?? '').trim();
    }
    this.cur = { size, signature, hash: this.opts.hashChunks ? crypto.createHash('sha256') : null };
    if (size === 0) {
      this.endChunk();
      this.state = 'trailer';
      return;
    }
    this.remaining = size;
    this.state = 'data';
  }

  private endChunk(): void {
    if (!this.cur) return;
    this.chunks.push({ size: this.cur.size, signature: this.cur.signature, sha256: this.cur.hash ? this.cur.hash.digest('hex') : null });
    this.cur = null;
  }

  private trailerLine(text: string): void {
    const c = text.indexOf(':');
    if (c <= 0) return;
    this.trailers[text.slice(0, c).trim().toLowerCase()] = text.slice(c + 1).trim();
  }
}

/** True when the request body is aws-chunked encoded. */
export function isAwsChunked(headers: Record<string, string | string[] | undefined>): boolean {
  const sha = String(headers['x-amz-content-sha256'] ?? '');
  const enc = String(headers['content-encoding'] ?? '');
  return sha.startsWith('STREAMING-') || /\baws-chunked\b/i.test(enc);
}

/** Content-Encoding without aws-chunked (stored and returned on GET). */
export function storedEncoding(v: string | undefined): string | null {
  if (!v) return null;
  const rest = v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s.toLowerCase() !== 'aws-chunked');
  return rest.length ? rest.join(', ') : null;
}
