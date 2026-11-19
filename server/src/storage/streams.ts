import { Transform, type TransformCallback } from 'node:stream';

/** Fails with code ENTITY_TOO_LARGE once more than `max` bytes went through. */
export class ByteLimit extends Transform {
  bytes = 0;
  constructor(private max: number) {
    super();
  }
  override _transform(chunk: Buffer, _e: BufferEncoding, cb: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.max > 0 && this.bytes > this.max) return cb(Object.assign(new Error(`Body larger than ${this.max} bytes`), { code: 'ENTITY_TOO_LARGE' }));
    cb(null, chunk);
  }
}

/** Passes at most `bytesPerSec` (approximately), in slices of up to 16 KiB. */
export class Throttle extends Transform {
  private start = Date.now();
  private sent = 0;
  constructor(private bytesPerSec: number) {
    super();
  }
  override _transform(chunk: Buffer, _e: BufferEncoding, cb: TransformCallback): void {
    const slice = 16 * 1024;
    const pushNext = (off: number) => {
      if (off >= chunk.length) return cb();
      const part = chunk.subarray(off, off + slice);
      this.sent += part.length;
      const due = this.start + (this.sent / this.bytesPerSec) * 1000;
      const wait = Math.max(0, due - Date.now());
      setTimeout(() => {
        this.push(part);
        pushNext(off + slice);
      }, wait);
    };
    pushNext(0);
  }
}

/** Destroys the socket after `afterBytes` bytes passed (reset scenario). */
export class ResetAfter extends Transform {
  private n = 0;
  constructor(
    private afterBytes: number,
    private onReset: () => void,
  ) {
    super();
  }
  override _transform(chunk: Buffer, _e: BufferEncoding, cb: TransformCallback): void {
    const left = this.afterBytes - this.n;
    if (left <= 0) {
      this.onReset();
      return cb();
    }
    this.n += chunk.length;
    if (chunk.length >= left) {
      this.push(chunk.subarray(0, left));
      setImmediate(this.onReset);
      return cb();
    }
    cb(null, chunk);
  }
}

/** Flips one byte in the middle of the stream (checksum_mismatch on download). */
export class FlipByte extends Transform {
  private pos = 0;
  private done = false;
  constructor(private at: number) {
    super();
  }
  override _transform(chunk: Buffer, _e: BufferEncoding, cb: TransformCallback): void {
    if (!this.done && this.at >= this.pos && this.at < this.pos + chunk.length) {
      const copy = Buffer.from(chunk);
      copy[this.at - this.pos] ^= 0xff;
      this.done = true;
      this.pos += chunk.length;
      return cb(null, copy);
    }
    this.pos += chunk.length;
    cb(null, chunk);
  }
}

/** Counts bytes going through (response sizes for the traffic log). */
export class Counter extends Transform {
  bytes = 0;
  override _transform(chunk: Buffer, _e: BufferEncoding, cb: TransformCallback): void {
    this.bytes += chunk.length;
    cb(null, chunk);
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
