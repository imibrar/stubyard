// Fixed-point decimals on BigInt (scale 10^6) for ZATCA VAT arithmetic. No floating point anywhere:
// numbers are only accepted when their decimal string form is plain (no exponent).

export const SCALE_DIGITS = 6;
const SCALE = 10n ** BigInt(SCALE_DIGITS);

/** A decimal value stored as an integer count of 10^-6 units. */
export type Dec = bigint;

export type ParseResult = { ok: true; value: Dec } | { ok: false; error: string };

const DEC_RE = /^([+-])?(\d+)(?:\.(\d*))?$/;

/** Parse "123.45" / 12 / "-0.5". Rejects exponents, blanks and more than 6 fraction digits. */
export function tryParse(input: string | number): ParseResult {
  const s = typeof input === 'number' ? String(input) : input.trim();
  if (typeof input === 'number' && !Number.isFinite(input)) return { ok: false, error: `not a finite number: ${s}` };
  const m = DEC_RE.exec(s);
  if (!m) return { ok: false, error: `not a plain decimal: "${s}"` };
  const frac = m[3] ?? '';
  if (frac.length > SCALE_DIGITS) return { ok: false, error: `more than ${SCALE_DIGITS} fraction digits: "${s}"` };
  const v = BigInt(m[2]) * SCALE + BigInt(frac.padEnd(SCALE_DIGITS, '0') || '0');
  return { ok: true, value: m[1] === '-' ? -v : v };
}

/** Like tryParse but throws on bad input. */
export function parse(input: string | number): Dec {
  const r = tryParse(input);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

/** Integer division of n by d rounding half away from zero. */
function divHalfUp(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new Error('division by zero');
  const neg = n < 0n !== d < 0n;
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  let q = an / ad;
  if ((an % ad) * 2n >= ad) q += 1n;
  return neg ? -q : q;
}

export const add = (a: Dec, b: Dec): Dec => a + b;
export const sub = (a: Dec, b: Dec): Dec => a - b;
/** Product, rounded half-up at the 10^-6 scale. */
export const mul = (a: Dec, b: Dec): Dec => divHalfUp(a * b, SCALE);
/** Quotient, rounded half-up at the 10^-6 scale. */
export const div = (a: Dec, b: Dec): Dec => divHalfUp(a * SCALE, b);

/** Round to `places` (0..6) fraction digits, half away from zero. */
export function round(d: Dec, places: number): Dec {
  const unit = 10n ** BigInt(SCALE_DIGITS - checkPlaces(places));
  return divHalfUp(d, unit) * unit;
}

/** Number of significant fraction digits (0..6). */
export function places(d: Dec): number {
  let frac = (d < 0n ? -d : d) % SCALE;
  if (frac === 0n) return 0;
  let p = SCALE_DIGITS;
  while (frac % 10n === 0n) { frac /= 10n; p--; }
  return p;
}

/** Build from an integer amount in minor units (e.g. halalas with places = 2). */
export function fromMinor(minor: bigint | number, minorPlaces = 2): Dec {
  const m = typeof minor === 'number' ? BigInt(minor) : minor;
  return m * 10n ** BigInt(SCALE_DIGITS - checkPlaces(minorPlaces));
}

export const compare = (a: Dec, b: Dec): -1 | 0 | 1 => (a < b ? -1 : a > b ? 1 : 0);
export const eq = (a: Dec, b: Dec): boolean => a === b;

/** Format with exactly `places` fraction digits (rounded half-up). */
export function toString(d: Dec, placesOut = 2): string {
  const p = checkPlaces(placesOut);
  const r = round(d, p);
  const neg = r < 0n;
  const a = neg ? -r : r;
  const int = (a / SCALE).toString();
  const frac = (a % SCALE).toString().padStart(SCALE_DIGITS, '0').slice(0, p);
  return (neg ? '-' : '') + int + (p > 0 ? '.' + frac : '');
}

/** "123.45" */
export const fmt2 = (d: Dec): string => toString(d, 2);

function checkPlaces(p: number): number {
  if (!Number.isInteger(p) || p < 0 || p > SCALE_DIGITS) throw new Error(`places must be 0..${SCALE_DIGITS}: ${p}`);
  return p;
}
