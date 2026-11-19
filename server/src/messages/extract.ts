/**
 * OTP and link extraction for email/SMS/WhatsApp bodies.
 * A project may override the OTP regex; the first capture group (or the whole match) is the code.
 */

const KEYWORD_OTP =
  /(?:otp|one[\s-]?time|code|pin|passcode|password|verification|verify|token|کوڈ)\D{0,40}?\b(\d{4,8})\b/i;
const CODE_FIRST = /\b(\d{4,8})\b\D{0,30}(?:is your|is the|as your)\s+(?:otp|code|pin|verification)/i;
const STANDALONE_6 = /(?<![\d.,:/+-])(\d{6})(?![\d,:/-]|\.\d)/;

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
  for (const re of [CODE_FIRST, KEYWORD_OTP, STANDALONE_6]) {
    const m = re.exec(text);
    if (m) return m[1];
  }
  return null;
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
