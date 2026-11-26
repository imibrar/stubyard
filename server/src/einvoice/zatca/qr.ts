// ZATCA QR payload: TLV (1-byte tag, 1-byte length, value) concatenated and base64-encoded.
// Tags 1-5 are UTF-8 text; 6 (invoice hash) and 7 (signature) are base64 text in practice but some apps send
// raw bytes; 8 (public key) and 9 (certificate signature) are raw bytes.

export const QR_TAGS: Record<number, string> = {
  1: 'sellerName',
  2: 'vatNumber',
  3: 'timestamp',
  4: 'total',
  5: 'vatTotal',
  6: 'hash',
  7: 'signature',
  8: 'publicKey',
  9: 'certSignature',
};

export interface TlvField { tag: number; value: string | Uint8Array }
export interface DecodedTlv { tag: number; bytes: Buffer; text: string }
export type DecodeResult = { ok: true; fields: DecodedTlv[] } | { ok: false; error: string };

export function encodeTlv(fields: TlvField[]): string {
  const parts: Buffer[] = [];
  for (const f of fields) {
    if (!Number.isInteger(f.tag) || f.tag < 0 || f.tag > 255) throw new Error(`TLV tag out of range: ${f.tag}`);
    const bytes = typeof f.value === 'string' ? Buffer.from(f.value, 'utf8') : Buffer.from(f.value);
    if (bytes.length >= 256) throw new Error(`TLV tag ${f.tag} value is ${bytes.length} bytes (max 255)`);
    parts.push(Buffer.from([f.tag, bytes.length]), bytes);
  }
  return Buffer.concat(parts).toString('base64');
}

/** Decode a base64 TLV payload. Never throws: malformed input from apps gets a structured error. */
export function decodeTlv(b64: string): DecodeResult {
  const s = (b64 ?? '').trim();
  if (!s) return { ok: false, error: 'empty QR payload' };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s) || s.length % 4 === 1) return { ok: false, error: 'QR payload is not base64' };
  const buf = Buffer.from(s, 'base64');
  const fields: DecodedTlv[] = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 2 > buf.length) return { ok: false, error: `truncated TLV header at byte ${i}` };
    const tag = buf[i];
    const len = buf[i + 1];
    if (i + 2 + len > buf.length) {
      return { ok: false, error: `tag ${tag} length ${len} overflows payload (${buf.length - i - 2} bytes left)` };
    }
    const bytes = buf.subarray(i + 2, i + 2 + len);
    fields.push({ tag, bytes: Buffer.from(bytes), text: bytes.toString('utf8') });
    i += 2 + len;
  }
  return { ok: true, fields };
}

export interface QrInput {
  sellerName: string;
  vatNumber: string;
  timestamp: string;
  total: string;
  vatTotal: string;
  hash: string | Uint8Array;
  signature: string | Uint8Array;
  publicKey?: Uint8Array;
  certSignature?: Uint8Array;
}

/** Build the tags 1-9 QR payload (8 and 9 only when given). */
export function buildQr(q: QrInput): string {
  const fields: TlvField[] = [
    { tag: 1, value: q.sellerName },
    { tag: 2, value: q.vatNumber },
    { tag: 3, value: q.timestamp },
    { tag: 4, value: q.total },
    { tag: 5, value: q.vatTotal },
    { tag: 6, value: q.hash },
    { tag: 7, value: q.signature },
  ];
  if (q.publicKey) fields.push({ tag: 8, value: q.publicKey });
  if (q.certSignature) fields.push({ tag: 9, value: q.certSignature });
  return encodeTlv(fields);
}

/** Normalise a tag 6/7 value to base64 text: kept when it already is base64 text, else the raw bytes are encoded. */
export function asBase64(field: DecodedTlv): string {
  const t = field.text;
  if (t.length > 0 && t.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(t)
      && Buffer.from(t, 'base64').toString('base64') === t) return t;
  return field.bytes.toString('base64');
}
