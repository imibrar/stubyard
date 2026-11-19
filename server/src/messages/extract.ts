/**
 * OTP and link extraction for email/SMS/WhatsApp bodies.
 * A project may override the OTP regex; the first capture group (or the whole match) is the code.
 *
 * Built-in detection scores candidates instead of taking the first number:
 *  - numeric codes (4–8 digits, or "123-456" / "123 456" when next to a keyword) and alphanumeric codes
 *    ("A7K-92Q", "X4F9P2": upper-case letters + digits) count when they are close to a keyword
 *    (code, OTP, PIN, passcode, verification, کوڈ, código, код, 验证码, …) in the same sentence;
 *    the closest one wins, "keyword is 1234" / "1234 is your code" get a bonus;
 *  - years, dates, times, phone numbers, prices, amounts, durations, order / card / reference numbers
 *    and numbers inside links are never codes (a year only when written right after the keyword: "PIN: 2019");
 *  - without any keyword, a lone 6-digit number still counts ("Here it is: 654321").
 */

// Keyword stems. "code" also matches inside words (Bestätigungscode, Sicherheitscode) except post/zip/bar codes.
const KEYWORD_RE = new RegExp(
  [
    String.raw`(?<![\p{L}\p{N}])(?:otp|totp|2fa|mfa|one[\s-]?time(?:[\s-]?(?:password|passcode|pin|code))?|pin|passcode|password|passwort|verification|verify|token)(?![\p{L}])`,
    String.raw`(?<!post|zip|bar|qr|area|country|dial|promo|coupon|discount|voucher|referral|gift|source|morse|dress|zip\s|post\s|area\s|promo\s|coupon\s|discount\s|voucher\s|referral\s|gift\s|source\s|dress\s|qr\s)(?:code|codes|codigo|código|kode|kod|code)(?![\p{L}])`,
    String.raw`(?<![\p{L}])(?:код[а-я]*|кодом|کوڈ|کد|رمز|验证码|驗證碼|校验码|認証コード|確認コード|コード|인증번호|비밀번호|ओटीपी|कोड|पिन|mã|clave|contraseña|senha|mot\s+de\s+passe)(?![\p{L}])`,
  ].join('|'),
  'giu',
);
// Numeric: 4–8 digits not glued to letters/digits; split: 3+3 digits joined by "-" or a space.
const NUM_RE = /(?<![\p{L}\p{N}])\d{4,8}(?![\p{L}\p{N}])/gu;
const SPLIT_RE = /(?<![\p{L}\p{N}\-])\d{3}[- ]\d{3}(?![\p{L}\p{N}]|-\d)/gu;
// Alphanumeric: groups of upper-case letters and digits, optionally joined by one "-".
const ALNUM_RE = /(?<![\p{L}\p{N}\-])[A-Z0-9]{2,10}(?:-[A-Z0-9]{2,8})?(?![\p{L}\p{N}]|-[\p{L}\p{N}])/gu;
const URL_LIKE = /\b(?:https?:\/\/|www\.)\S+|[\w.+-]+@[\w-]+\.[\w.-]+/gi;

/** A digit group that belongs to a longer number: date, time, phone, decimal, thousands, IP. */
const GLUED_BEFORE = /(?:\d[\/.:,-]|\d |\+\s?|\(\d+\)\s?)$/;
const GLUED_AFTER = /^(?:[\/.:,-]\d| \d)/;
const MONEY_BEFORE = /(?:[$€£¥₹₨₦₱﷼]|\b(?:rs|pkr|usd|eur|inr|gbp|aed|sar|cad|aud|chf|jpy|kes|ngn|try|brl|mxn)\.?)\s*$/i;
const UNIT_AFTER =
  /^\s*(?:%|percent|[$€£¥₹]|(?:usd|eur|pkr|inr|gbp|aed|sar|rs|rupees?|dollars?|euros?|pounds?|mins?|minutes?|secs?|seconds?|hours?|hrs?|days?|weeks?|months?|years?|km|kg|mb|gb|kb|points|pts|miles|items?|pcs)\b)/i;
/** Order / card / reference numbers: the label sits right before the number. */
const LABEL_BEFORE =
  /(?:#|\b(?:order|orders|invoice|inv|ref|reference|account|acct|a\/c|card|ending|ending\s+(?:in|with)|booking|ticket|tracking|transaction|txn|trx|id|policy|customer|member|shipment|parcel|room|flight|seat|case|claim|batch|lot|serial|sku|item|ext|extension|tel|phone|mobile|call|fax|box|suite|apt|unit|zip|postcode|postal|year|since|until|dated)\b)[\s:#.\-]*(?:no\.?\s*|number\s*)?$/i;
const SENTENCE_END = /[.!?。](?:\s|$)|\n\s*\n/;
const CONNECT_AFTER = /(?:\b(?:is|es|est|ist|lautet|é|era)\b|:|=|ہے)\W{0,3}$/iu;
const CONNECT_BEFORE = /^\W{0,3}(?:(?:is|as|es|est|ist)\b|ہے)/iu;

interface Candidate {
  value: string;
  start: number;
  end: number;
  kind: 'num' | 'alnum';
  year: boolean;
}

/** Replace links and email addresses with spaces (keeps offsets) so numbers inside them are ignored. */
function blankUrls(text: string): string {
  return text.replace(URL_LIKE, (m) => ' '.repeat(m.length));
}

function numericExcluded(t: string, start: number, end: number): boolean {
  const before = t.slice(Math.max(0, start - 24), start);
  const after = t.slice(end, end + 16);
  return GLUED_BEFORE.test(before) || GLUED_AFTER.test(after) || MONEY_BEFORE.test(before) || UNIT_AFTER.test(after) || LABEL_BEFORE.test(before);
}

function candidates(t: string): Candidate[] {
  const out: Candidate[] = [];
  for (const m of t.matchAll(NUM_RE)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (numericExcluded(t, start, end)) continue;
    const n = Number(m[0]);
    out.push({ value: m[0], start, end, kind: 'num', year: m[0].length === 4 && n >= 1900 && n <= 2099 });
  }
  for (const m of t.matchAll(SPLIT_RE)) {
    const start = m.index!;
    const end = start + m[0].length;
    const before = t.slice(Math.max(0, start - 24), start);
    const after = t.slice(end, end + 16);
    if (/[\d+(]\s?$/.test(before) || MONEY_BEFORE.test(before) || UNIT_AFTER.test(after) || LABEL_BEFORE.test(before) || GLUED_AFTER.test(after)) continue;
    out.push({ value: m[0].replace(/\D/g, ''), start, end, kind: 'num', year: false });
  }
  for (const m of t.matchAll(ALNUM_RE)) {
    const v = m[0];
    const chars = v.replace(/-/g, '');
    if (chars.length < 4 || chars.length > 10 || !/\d/.test(v) || !/[A-Z]/.test(v)) continue;
    if (v.split('-').some((g) => g.length < 2)) continue;
    const start = m.index!;
    const before = t.slice(Math.max(0, start - 24), start);
    if (LABEL_BEFORE.test(before) || MONEY_BEFORE.test(before)) continue;
    out.push({ value: v, start, end: start + v.length, kind: 'alnum', year: false });
  }
  return out;
}

function anchorScore(t: string, c: Candidate, keywords: { start: number; end: number }[]): number {
  let best = -Infinity;
  const maxGap = c.kind === 'alnum' ? 25 : 40;
  for (const k of keywords) {
    if (k.end <= c.start) {
      const gap = t.slice(k.end, c.start);
      if (gap.length > maxGap || SENTENCE_END.test(gap)) continue;
      // A year counts only right after the keyword: "PIN: 2019", "code is 2024".
      if (c.year && !/^\W{0,3}(?:is\W{0,3})?$/i.test(gap)) continue;
      let s = 100 - gap.length + (CONNECT_AFTER.test(gap) ? 10 : 0);
      if (gap.includes('\n')) s -= 5;
      best = Math.max(best, s);
    } else if (c.end <= k.start) {
      if (c.year) continue;
      const gap = t.slice(c.end, k.start);
      if (gap.length > maxGap || SENTENCE_END.test(gap) || gap.includes('\n')) continue;
      best = Math.max(best, 90 - gap.length + (CONNECT_BEFORE.test(gap) ? 10 : 0));
    }
  }
  if (best === -Infinity) return best;
  if (c.kind === 'num' && c.value.length === 6) best += 3;
  if (c.kind === 'alnum') best -= 5;
  return best;
}

/** Keywords that are part of a marketing phrase ("promo code SAVE20") do not anchor codes. */
function keywordsIn(t: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const m of t.matchAll(KEYWORD_RE)) {
    const start = m.index!;
    const before = t.slice(Math.max(0, start - 20), start);
    if (/\b(?:promo|promotion|promotional|coupon|discount|voucher|referral|invite|gift|redeem|offer|sale)\b[\s\w-]{0,8}$/i.test(before)) continue;
    out.push({ start, end: start + m[0].length });
  }
  return out;
}

export function extractOtp(text: string | null | undefined, customRegex?: string): string | null {
  if (!text) return null;
  if (customRegex) {
    try {
      const m = new RegExp(customRegex, 'i').exec(text);
      if (m) return (m[1] ?? m[0]).trim();
    } catch {
      // invalid custom regex is rejected at save time; ignore here
    }
  }
  const t = blankUrls(text);
  const cands = candidates(t);
  if (!cands.length) return null;
  const keywords = keywordsIn(t);
  let best: Candidate | null = null;
  let bestScore = -Infinity;
  for (const c of cands) {
    const s = anchorScore(t, c, keywords);
    if (s > bestScore || (s === bestScore && best && c.start < best.start)) {
      best = c;
      bestScore = s;
    }
  }
  if (best && bestScore > -Infinity) return best.value;
  // No keyword anywhere near: only a lone 6-digit number is taken as a code.
  const lone = cands.find((c) => c.kind === 'num' && /^\d{6}$/.test(c.value) && t.slice(c.start, c.end) === c.value);
  return lone?.value ?? null;
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'()]+[^\s<>"'().,;:!?]/gi;

export function extractLinks(text: string | null | undefined, html?: string | null): string[] {
  const found = new Set<string>();
  for (const src of [text ?? '', html ?? '']) {
    for (const m of src.matchAll(URL_RE)) found.add(m[0].replace(/&amp;/g, '&'));
  }
  // href="..." in HTML may contain URLs not present as plain text
  if (html) {
    for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
      const u = m[1].replace(/&amp;/g, '&');
      if (/^https?:\/\//i.test(u)) found.add(u);
    }
  }
  return [...found].slice(0, 50);
}

/** Strip HTML to readable text (used when an email has no text part). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h\d|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
