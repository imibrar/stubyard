// ZATCA QR TLV encoding/decoding and the BigInt fixed-point decimals used for VAT arithmetic.
import { describe, expect, it } from 'vitest';
import { asBase64, buildQr, decodeTlv, encodeTlv, QR_TAGS } from '../src/einvoice/zatca/qr.js';
import * as dec from '../src/einvoice/zatca/dec.js';

describe('QR TLV', () => {
  it('round trips tags 1-9 with an Arabic seller name (length counted in bytes)', () => {
    const seller = 'شركة الاختبار';
    const pk = new Uint8Array([1, 2, 3, 250]);
    const b64 = buildQr({
      sellerName: seller, vatNumber: '300000000000003', timestamp: '2026-11-26T10:00:00Z',
      total: '115.00', vatTotal: '15.00', hash: 'aGFzaA==', signature: new Uint8Array([9, 8, 7]),
      publicKey: pk, certSignature: new Uint8Array([0]),
    });
    const r = decodeTlv(b64);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields.map((f) => f.tag)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(r.fields[0].text).toBe(seller);
    expect(r.fields[0].bytes.length).toBe(Buffer.byteLength(seller, 'utf8'));
    expect(r.fields[0].bytes.length).toBeGreaterThan(seller.length);
    expect(Buffer.from(b64, 'base64')[1]).toBe(Buffer.byteLength(seller, 'utf8'));
    expect([...r.fields[7].bytes]).toEqual([...pk]);
    expect(asBase64(r.fields[5])).toBe('aGFzaA==');
    expect(asBase64(r.fields[6])).toBe(Buffer.from([9, 8, 7]).toString('base64'));
    expect(QR_TAGS[1]).toBe('sellerName');
  });

  it('rejects values of 256 bytes or more', () => {
    expect(() => encodeTlv([{ tag: 1, value: 'a'.repeat(255) }])).not.toThrow();
    expect(() => encodeTlv([{ tag: 1, value: 'a'.repeat(256) }])).toThrow(/max 255/);
    expect(() => encodeTlv([{ tag: 1, value: 'ش'.repeat(128) }])).toThrow();
  });

  it('returns structured errors for malformed payloads', () => {
    expect(decodeTlv('').ok).toBe(false);
    expect(decodeTlv('not base64!').ok).toBe(false);
    const overflow = decodeTlv(Buffer.from([1, 10, 65, 66]).toString('base64'));
    expect(overflow).toMatchObject({ ok: false, error: expect.stringMatching(/overflows/) });
    const truncated = decodeTlv(Buffer.from([1, 1, 65, 2]).toString('base64'));
    expect(truncated).toMatchObject({ ok: false, error: expect.stringMatching(/truncated/) });
  });
});

describe('dec', () => {
  const p = dec.parse;
  it('adds exactly', () => {
    expect(dec.fmt2(dec.add(p('0.1'), p('0.2')))).toBe('0.30');
    expect(dec.eq(dec.add(p('0.1'), p('0.2')), p('0.3'))).toBe(true);
    expect(dec.toString(dec.sub(p(1), p('1.5')), 1)).toBe('-0.5');
  });

  it('rounds half away from zero', () => {
    expect(dec.fmt2(p('2.345'))).toBe('2.35');
    expect(dec.fmt2(p('-2.345'))).toBe('-2.35');
    expect(dec.round(p('2.344'), 2)).toBe(p('2.34'));
    expect(dec.round(p('-0.5'), 0)).toBe(p('-1'));
  });

  it('mul/div round at scale', () => {
    expect(dec.mul(p('0.000001'), p('0.5'))).toBe(p('0.000001'));
    expect(dec.div(p(2), p(3))).toBe(p('0.666667'));
    expect(dec.div(p(-2), p(3))).toBe(p('-0.666667'));
    expect(() => dec.div(p(1), p(0))).toThrow();
  });

  it('ZATCA line example: 10.125 x 3 rounded per part', () => {
    const line = dec.mul(p('10.125'), p(3));
    expect(dec.toString(line, 3)).toBe('30.375');
    expect(dec.fmt2(line)).toBe('30.38');
    const vat = dec.round(dec.mul(dec.round(line, 2), p('0.15')), 2);
    expect(dec.fmt2(vat)).toBe('4.56');
  });

  it('helpers', () => {
    expect(dec.fromMinor(12345)).toBe(p('123.45'));
    expect(dec.places(p('1.250'))).toBe(2);
    expect(dec.compare(p(1), p(2))).toBe(-1);
  });

  it('rejects bad input', () => {
    expect(() => p('1e5')).toThrow();
    expect(() => p(1e21)).toThrow();
    expect(() => p('1.1234567')).toThrow(/fraction/);
    expect(() => p('')).toThrow();
    expect(() => p('abc')).toThrow();
    expect(dec.tryParse('1.0000001').ok).toBe(false);
  });
});
