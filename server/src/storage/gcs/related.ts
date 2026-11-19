/**
 * Streaming multipart/related parser for GCS `uploadType=multipart`: the first part (JSON metadata) and the
 * second part's headers are buffered (≤ 1 MiB); the media part is streamed through until the closing boundary.
 */
import { Transform, type TransformCallback } from 'node:stream';

export interface RelatedHead {
  metadata: Record<string, unknown>;
  mediaType: string | null;
}

export class RelatedParser extends Transform {
  private buf: Buffer = Buffer.alloc(0);
  private state: 'head' | 'media' | 'done' = 'head';
  private readonly delim: Buffer;
  private readonly open: Buffer;
  head: Promise<RelatedHead>;
  private resolveHead!: (h: RelatedHead) => void;
  private rejectHead!: (e: Error) => void;

  constructor(boundary: string) {
    super();
    this.open = Buffer.from(`--${boundary}`);
    this.delim = Buffer.from(`\r\n--${boundary}`);
    this.head = new Promise((res, rej) => {
      this.resolveHead = res;
      this.rejectHead = rej;
    });
    this.head.catch(() => undefined);
  }

  private fail(msg: string, cb: TransformCallback) {
    const err = Object.assign(new Error(msg), { code: 'BAD_MULTIPART' });
    this.rejectHead(err);
    cb(err);
  }

  override _transform(chunk: Buffer, _e: BufferEncoding, cb: TransformCallback): void {
    if (this.state === 'done') return cb();
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (this.state === 'head') {
      // --b\r\n<headers>\r\n\r\n<json>\r\n--b\r\n<headers>\r\n\r\n
      const s = this.buf.indexOf(this.open);
      if (s < 0) return this.buf.length > 1 << 20 ? this.fail('multipart/related: opening boundary not found', cb) : cb();
      const h1 = this.buf.indexOf('\r\n\r\n', s);
      if (h1 < 0) return this.buf.length > 1 << 20 ? this.fail('multipart/related: part headers too long', cb) : cb();
      const end1 = this.buf.indexOf(this.delim, h1 + 4);
      if (end1 < 0) return this.buf.length > 1 << 20 ? this.fail('multipart/related: metadata part too long', cb) : cb();
      const h2 = this.buf.indexOf('\r\n\r\n', end1 + this.delim.length);
      if (h2 < 0) return this.buf.length > 1 << 20 ? this.fail('multipart/related: media part headers too long', cb) : cb();
      let metadata: Record<string, unknown> = {};
      const json = this.buf.subarray(h1 + 4, end1).toString('utf8').trim();
      try {
        metadata = json ? JSON.parse(json) : {};
      } catch {
        return this.fail('multipart/related: the first part is not JSON metadata', cb);
      }
      const mediaHeaders = this.buf.subarray(end1 + this.delim.length, h2).toString('latin1');
      const ct = /^content-type:\s*(.+)$/im.exec(mediaHeaders)?.[1]?.trim() ?? null;
      this.buf = this.buf.subarray(h2 + 4);
      this.state = 'media';
      this.resolveHead({ metadata, mediaType: ct });
    }
    this.pushMedia();
    cb();
  }

  private pushMedia() {
    const idx = this.buf.indexOf(this.delim);
    if (idx >= 0) {
      if (idx > 0) this.push(this.buf.subarray(0, idx));
      this.buf = Buffer.alloc(0);
      this.state = 'done';
      return;
    }
    const keep = this.delim.length - 1;
    if (this.buf.length > keep) {
      this.push(this.buf.subarray(0, this.buf.length - keep));
      this.buf = Buffer.from(this.buf.subarray(this.buf.length - keep));
    }
  }

  override _flush(cb: TransformCallback): void {
    if (this.state === 'head') return this.fail('multipart/related body ended before the media part', cb);
    if (this.state === 'media') return this.fail('multipart/related body ended before the closing boundary', cb);
    cb();
  }
}
