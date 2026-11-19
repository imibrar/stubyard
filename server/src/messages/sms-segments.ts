/**
 * SMS segment maths (3GPP TS 23.038 / 23.040), as carriers and Twilio/Vonage bill it.
 *
 * - GSM-7: 160 septets in one SMS, 153 per part when concatenated (the UDH takes 7).
 *   Characters of the extension table (^ { } [ ] ~ \ | € and form feed) take two septets.
 * - UCS-2 (anything outside GSM-7: Urdu, Arabic, Chinese, emoji, curly quotes…): 70 UTF-16 units in one SMS,
 *   67 per part. Emoji and other astral characters take two units.
 * - A two-unit character (extension escape, surrogate pair) is never split across parts.
 */

const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXTENSION = '\f^{}\\[~]|€';

const BASIC = new Set(GSM7_BASIC);
const EXTENSION = new Set(GSM7_EXTENSION);

export type SmsEncoding = 'GSM-7' | 'UCS-2';

export interface SmsSegmentInfo {
  encoding: SmsEncoding;
  /** Number of SMS parts the message is billed as. */
  segments: number;
  /** Characters (Unicode code points). */
  characters: number;
  /** Septets (GSM-7) or UTF-16 code units (UCS-2) used. */
  units: number;
  /** Units available per part for this message (160/153 or 70/67). */
  perSegment: number;
}

export function isGsm7(text: string): boolean {
  for (const ch of text) if (!BASIC.has(ch) && !EXTENSION.has(ch)) return false;
  return true;
}

/** Encoding and number of segments for an SMS body. An empty body is one segment. */
export function smsSegments(text: string): SmsSegmentInfo {
  const chars = [...(text ?? '')];
  const gsm = chars.every((c) => BASIC.has(c) || EXTENSION.has(c));
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  const width = (c: string) => (gsm ? (EXTENSION.has(c) ? 2 : 1) : c.length);
  const units = chars.reduce((n, c) => n + width(c), 0);
  if (units <= single) return { encoding: gsm ? 'GSM-7' : 'UCS-2', segments: 1, characters: chars.length, units, perSegment: single };
  let segments = 1;
  let used = 0;
  for (const c of chars) {
    const w = width(c);
    if (used + w > multi) {
      segments++;
      used = 0;
    }
    used += w;
  }
  return { encoding: gsm ? 'GSM-7' : 'UCS-2', segments, characters: chars.length, units, perSegment: multi };
}
