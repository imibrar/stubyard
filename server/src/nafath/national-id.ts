/**
 * Saudi national IDs and Iqama numbers for fake Nafath.
 *
 * 10 digits: the first digit is 1 for a citizen (Nafath claim `nin`) or 2 for a resident (claim `iqamaNumber`), and the
 * last digit is a Luhn check digit. The Luhn rule follows the public validators (open-source form libraries); it is not
 * checked against an official source.
 */

export type NationalIdKind = 'citizen' | 'resident';

export const NATIONAL_ID_RE = /^[12]\d{9}$/;

/** Luhn sum of the digits; a valid number sums to a multiple of 10. */
function luhnSum(digits: string): number {
  let sum = 0;
  // From the right: the check digit counts as is, every second digit before it is doubled.
  for (let i = digits.length - 1, double = false; i >= 0; i--, double = !double) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum;
}

/** A 10-digit national ID / Iqama number with a valid check digit. */
export function isNationalId(s: string | null | undefined): boolean {
  return typeof s === 'string' && NATIONAL_ID_RE.test(s) && luhnSum(s) % 10 === 0;
}

/** citizen (1…) or resident (2…); null when `s` is not a valid ID. */
export function nationalIdKind(s: string | null | undefined): NationalIdKind | null {
  if (!isNationalId(s)) return null;
  return s![0] === '1' ? 'citizen' : 'resident';
}

/** A random valid ID of this kind. `rnd` returns [0, 1) like Math.random (pass a seeded one in tests). */
export function generateNationalId(kind: NationalIdKind, rnd: () => number = Math.random): string {
  let body = kind === 'citizen' ? '1' : '2';
  for (let i = 0; i < 8; i++) body += String(Math.min(9, Math.floor(rnd() * 10)));
  // The check digit that makes the sum (with it counted undoubled) a multiple of 10.
  const check = (10 - (luhnSum(body + '0') % 10)) % 10;
  return body + check;
}
