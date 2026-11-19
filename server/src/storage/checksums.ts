import crypto from 'node:crypto';
import zlib from 'node:zlib';
import type { ChecksumAlgo, Digests } from './types.js';

/**
 * Checksums used by S3 (x-amz-checksum-*) and GCS (crc32c): CRC32 (zlib), CRC32C and CRC64NVME (table-driven,
 * reflected), SHA-1, SHA-256. Wire form is base64 of the big-endian value.
 */

const CRC32C_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32cUpdate(crc: number, buf: Uint8Array): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC32C_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** CRC-64/NVME: reflected poly 0x9A6C9329AC4BC9B5, init and xorout all ones. Two 32-bit halves for speed. */
const CRC64_HI = new Uint32Array(256);
const CRC64_LO = new Uint32Array(256);
(() => {
  const poly = 0x9a6c9329ac4bc9b5n;
  for (let i = 0; i < 256; i++) {
    let c = BigInt(i);
    for (let k = 0; k < 8; k++) c = c & 1n ? (c >> 1n) ^ poly : c >> 1n;
    CRC64_HI[i] = Number(c >> 32n) >>> 0;
    CRC64_LO[i] = Number(c & 0xffffffffn) >>> 0;
  }
})();

export class Crc64Nvme {
  private hi = 0xffffffff;
  private lo = 0xffffffff;
  update(buf: Uint8Array): this {
    let hi = this.hi;
    let lo = this.lo;
    for (let i = 0; i < buf.length; i++) {
      const idx = (lo ^ buf[i]) & 0xff;
      const nlo = ((lo >>> 8) | ((hi & 0xff) << 24)) >>> 0;
      const nhi = hi >>> 8;
      lo = (nlo ^ CRC64_LO[idx]) >>> 0;
      hi = (nhi ^ CRC64_HI[idx]) >>> 0;
    }
    this.hi = hi;
    this.lo = lo;
    return this;
  }
  digest(): Buffer {
    const out = Buffer.alloc(8);
    out.writeUInt32BE(~this.hi >>> 0, 0);
    out.writeUInt32BE(~this.lo >>> 0, 4);
    return out;
  }
}

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
};

interface Running {
  update(b: Buffer): void;
  digest(): Buffer;
}

export function checksumHasher(algo: ChecksumAlgo): Running {
  switch (algo) {
    case 'crc32': {
      let c = 0;
      return { update: (b) => (c = zlib.crc32(b, c)), digest: () => u32(c) };
    }
    case 'crc32c': {
      let c = 0;
      return { update: (b) => (c = crc32cUpdate(c, b)), digest: () => u32(c) };
    }
    case 'crc64nvme': {
      const h = new Crc64Nvme();
      return { update: (b) => h.update(b), digest: () => h.digest() };
    }
    case 'sha1':
    case 'sha256': {
      const h = crypto.createHash(algo);
      return { update: (b) => h.update(b), digest: () => h.digest() };
    }
  }
}

export function checksumOf(algo: ChecksumAlgo, data: Buffer): string {
  const h = checksumHasher(algo);
  h.update(data);
  return h.digest().toString('base64');
}

/** "x-amz-checksum-crc32" / "CRC32" / "crc64nvme" → algo. */
export function parseAlgo(v: string | null | undefined): ChecksumAlgo | null {
  if (!v) return null;
  const a = v.toLowerCase().replace(/^x-amz-checksum-/, '').replace(/-/g, '');
  return (['crc32', 'crc32c', 'crc64nvme', 'sha1', 'sha256'] as const).find((x) => x === a) ?? null;
}

/** MD5 always; SHA-256 (hex) and checksums on request; one pass over the bytes. */
export class MultiHasher {
  private md5 = crypto.createHash('md5');
  private sha?: crypto.Hash;
  private sums = new Map<ChecksumAlgo, Running>();
  size = 0;

  constructor(algos: ChecksumAlgo[] = [], sha256Hex = false) {
    if (sha256Hex) this.sha = crypto.createHash('sha256');
    for (const a of new Set(algos)) this.sums.set(a, checksumHasher(a));
  }

  update(b: Buffer): void {
    this.size += b.length;
    this.md5.update(b);
    this.sha?.update(b);
    for (const h of this.sums.values()) h.update(b);
  }

  digest(): Digests {
    const checksums: Digests['checksums'] = {};
    for (const [a, h] of this.sums) checksums[a] = h.digest().toString('base64');
    return { size: this.size, md5: this.md5.digest('hex'), sha256Hex: this.sha?.digest('hex'), checksums };
  }
}

/** S3 multipart ETag: md5 of the concatenated binary part MD5s, plus "-N". */
export function multipartEtag(partMd5Hex: string[]): string {
  const h = crypto.createHash('md5');
  for (const m of partMd5Hex) h.update(Buffer.from(m, 'hex'));
  return `"${h.digest('hex')}-${partMd5Hex.length}"`;
}

/** Composite checksum: checksum of the concatenated binary part checksums, plus "-N". */
export function compositeChecksum(algo: ChecksumAlgo, partChecksumsB64: string[]): string {
  const h = checksumHasher(algo);
  for (const c of partChecksumsB64) h.update(Buffer.from(c, 'base64'));
  return `${h.digest().toString('base64')}-${partChecksumsB64.length}`;
}
