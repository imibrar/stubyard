/**
 * Content checks ("message lint") for captured outbound messages: unrendered template placeholders, leaked
 * `undefined` / `null` values, links that will not work for real users, missing email headers, SMS encoding traps…
 *
 * Synchronous and regex based (runs on every capture). Every check is written for a low false-positive rate:
 * ambiguous patterns (`:name`, `__name__`, `null`, `undefined`) only fire in contexts that look like a template slot.
 */
import { isGsm7, smsSegments } from '../messages/sms-segments.js';

export type LintSeverity = 'error' | 'warn' | 'info';
export type LintChannel = 'email' | 'sms' | 'whatsapp';

export interface LintFinding {
  check: string;
  severity: LintSeverity;
  message: string;
  /** The offending text (token, URL, header…), shortened. */
  excerpt?: string;
  /** Where it was found. */
  where?: 'subject' | 'text' | 'html' | 'link' | 'headers' | 'template';
}

export interface LintCheckInfo {
  id: string;
  label: string;
  channels: LintChannel[];
  /** Highest severity it can produce. */
  severity: LintSeverity;
  description: string;
}

const ALL: LintChannel[] = ['email', 'sms', 'whatsapp'];

export const LINT_CHECKS: LintCheckInfo[] = [
  { id: 'placeholder', label: 'Unrendered placeholders', channels: ALL, severity: 'error', description: '{{name}}, ${var}, %s, %(name)s, {name}, :name, __NAME__, *|FNAME|* left in the text' },
  { id: 'leaked-value', label: 'Leaked values', channels: ALL, severity: 'error', description: 'undefined, NaN, [object Object], Invalid Date (error); null, {} / [] as standalone tokens (warn)' },
  { id: 'encoding-error', label: 'Broken characters', channels: ALL, severity: 'error', description: 'Replacement character � or mojibake (â€™, Ã©): a charset bug' },
  { id: 'mixed-scripts', label: 'Mixed scripts in a word', channels: ALL, severity: 'info', description: 'A word mixing Latin with Cyrillic / Greek letters (look-alike characters)' },
  { id: 'link-local', label: 'Local links', channels: ALL, severity: 'warn', description: 'Links to localhost, 127.0.0.1, private IPs, *.local, *.test, *.internal: will not work for real users' },
  { id: 'link-production', label: 'Production links', channels: ALL, severity: 'warn', description: 'Links to a domain listed in the project setting productionDomains' },
  { id: 'link-http', label: 'Plain http links', channels: ALL, severity: 'info', description: 'Links with http:// instead of https://' },
  { id: 'link-broken', label: 'Broken-looking links', channels: ALL, severity: 'warn', description: 'Spaces, unbalanced brackets, a doubled scheme, no host, empty href' },
  { id: 'link-tracking', label: 'Duplicated tracking parameters', channels: ALL, severity: 'warn', description: 'utm_* / gclid / fbclid… twice, or appended with a second "?"' },
  { id: 'mailto-empty', label: 'mailto: without address', channels: ['email'], severity: 'warn', description: 'A mailto: link with no recipient' },
  { id: 'email-unsubscribe', label: 'List-Unsubscribe (marketing)', channels: ['email'], severity: 'error', description: 'Mail through an instance labelled "marketing" needs List-Unsubscribe and List-Unsubscribe-Post: List-Unsubscribe=One-Click' },
  { id: 'email-text-part', label: 'Plain-text part', channels: ['email'], severity: 'warn', description: 'HTML email without a text/plain alternative' },
  { id: 'email-subject', label: 'Subject length', channels: ['email'], severity: 'warn', description: 'Empty subject or longer than 120 characters' },
  { id: 'email-from-name', label: 'From display name', channels: ['email'], severity: 'info', description: 'From header has only an address, no name' },
  { id: 'email-img-alt', label: 'Image alt text', channels: ['email'], severity: 'info', description: '<img> without an alt attribute (tracking pixels are ignored)' },
  { id: 'email-size', label: 'HTML size', channels: ['email'], severity: 'warn', description: 'HTML over 102 KB: Gmail clips the message' },
  { id: 'sms-encoding', label: 'SMS encoding', channels: ['sms'], severity: 'warn', description: 'UCS-2 only because of a "smart" character (curly quote, dash, emoji): fewer characters per SMS' },
  { id: 'sms-segments', label: 'SMS segments', channels: ['sms'], severity: 'warn', description: 'More than 1 segment (info), more than 3 (warn)' },
  { id: 'wa-template-params', label: 'WhatsApp template parameters', channels: ['whatsapp'], severity: 'error', description: 'Template message with an empty parameter' },
  { id: 'wa-length', label: 'WhatsApp text length', channels: ['whatsapp'], severity: 'error', description: 'Text over 4096 characters' },
];

export const LINT_CHECK_IDS = new Set(LINT_CHECKS.map((c) => c.id));

export interface LintInput {
  channel: LintChannel;
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  /** Email headers as captured (null = unknown, header checks are skipped). */
  headers?: Record<string, string | string[] | undefined> | null;
  /** Email: was there a text/plain part (undefined = unknown). */
  hasTextPart?: boolean;
  /** Email: display name of From (null = none, undefined = unknown). */
  fromName?: string | null;
  /** Labels of the provider instance (e.g. ["marketing"]). */
  instanceLabels?: string[];
  /** WhatsApp template: its parameters as sent (empty strings kept). */
  waTemplate?: { name: string; params: (string | null)[] } | null;
  /** Project settings. */
  disabled?: string[];
  productionDomains?: string[];
}

const SEVERITY_RANK: Record<LintSeverity, number> = { error: 3, warn: 2, info: 1 };

export function highestSeverity(findings: LintFinding[]): LintSeverity | null {
  let best: LintSeverity | null = null;
  for (const f of findings) if (!best || SEVERITY_RANK[f.severity] > SEVERITY_RANK[best]) best = f.severity;
  return best;
}

const MAX_PER_CHECK = 8;
const MAX_SCAN = 300 * 1024;
const short = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Run every enabled check. Order: errors first, then warnings, then info. */
export function lintMessage(input: LintInput): LintFinding[] {
  const disabled = new Set(input.disabled ?? []);
  const out: LintFinding[] = [];
  const seen = new Set<string>();
  const perCheck = new Map<string, number>();
  const add = (f: LintFinding) => {
    if (disabled.has(f.check)) return;
    // Leaked values: one finding per kind (the same NaN in the text and the HTML part is one problem).
    const key = `${f.check}\u0000${f.check === 'leaked-value' ? f.message : (f.excerpt ?? f.message)}`;
    if (seen.has(key)) return;
    const n = perCheck.get(f.check) ?? 0;
    if (n >= MAX_PER_CHECK) return;
    seen.add(key);
    perCheck.set(f.check, n + 1);
    out.push(f);
  };

  // Content checks look at the first 300 KB (the size check uses the full HTML); regexes below are bounded per tag.
  const html = input.html ? stripNonContent(input.html.slice(0, MAX_SCAN)) : null;
  // HTML-only email: the "text" is derived from the HTML (mailparser even wraps long URLs), so the HTML is checked instead.
  const derivedText = input.channel === 'email' && !!input.html && input.hasTextPart === false;
  const text = input.text && !derivedText ? input.text.slice(0, MAX_SCAN) : null;
  const htmlText = html ? htmlVisibleText(html) : null;
  const attrs = html ? htmlAttributeValues(html) : [];
  const sources: { text: string; where: LintFinding['where'] }[] = [];
  if (input.subject) sources.push({ text: input.subject, where: 'subject' });
  if (text) sources.push({ text, where: 'text' });
  if (htmlText) sources.push({ text: htmlText, where: 'html' });
  for (const a of attrs) sources.push({ text: a, where: 'html' });

  for (const s of sources) {
    for (const p of findPlaceholders(s.text)) add({ check: 'placeholder', severity: 'error', message: `Unrendered ${p.kind} placeholder`, excerpt: p.token, where: s.where });
    for (const l of findLeakedValues(s.text)) add({ check: 'leaked-value', severity: l.severity, message: l.message, excerpt: l.excerpt, where: s.where });
    for (const e of findEncodingErrors(s.text)) add({ check: 'encoding-error', severity: 'error', message: e.message, excerpt: e.excerpt, where: s.where });
    for (const w of findMixedScriptWords(s.text)) add({ check: 'mixed-scripts', severity: 'info', message: `Word mixes ${w.scripts.join(' and ')} letters (look-alike characters?)`, excerpt: w.word, where: s.where });
  }

  const links = collectLinks(text ?? '', html);
  for (const f of checkLinks(links, input.productionDomains ?? [], input.channel)) add(f);

  if (input.channel === 'email') for (const f of checkEmail(input, html)) add(f);
  if (input.channel === 'sms') for (const f of checkSms(input.text ?? '')) add(f);
  if (input.channel === 'whatsapp') for (const f of checkWhatsApp(input)) add(f);

  return out.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

// ------------------------------------------------------------------------------------------------
// Placeholders
// ------------------------------------------------------------------------------------------------

/** Names that commonly appear as Laravel-style :name or __name__ slots (single words need to be one of these). */
const SLOT_NAMES = new Set(
  'attribute name count code token link url email user username amount date time minutes seconds hours days app value values min max size other otp company order number phone total price product expires expiry first last firstname lastname fullname'.split(
    ' ',
  ),
);

const URL_IN_TEXT = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
// Lookbehind: only start at a token boundary (otherwise [\w.+-]+ backtracks quadratically on long words).
const EMAIL_IN_TEXT = /(?<![\w.+-])[\w.+-]{1,64}@[\w-]+(?:\.[\w-]+)+/g;

export interface PlaceholderHit {
  token: string;
  kind: string;
}

export function findPlaceholders(text: string): PlaceholderHit[] {
  const hits: PlaceholderHit[] = [];
  const push = (token: string, kind: string) => hits.push({ token: short(token, 60), kind });
  // Patterns that are unambiguous anywhere (including inside URLs).
  for (const m of text.matchAll(/\{\{\{?[^{}\n]{1,80}?\}?\}\}/g)) push(m[0], 'mustache/handlebars');
  for (const m of text.matchAll(/\{%-?\s*[^%\n]{1,80}?-?%\}/g)) push(m[0], 'jinja/liquid tag');
  for (const m of text.matchAll(/\{!!\s*[^!\n]{1,80}?!!\}/g)) push(m[0], 'blade');
  for (const m of text.matchAll(/%7B%7B[^\s]{1,80}?%7D%7D/gi)) push(m[0], 'URL-encoded mustache');
  for (const m of text.matchAll(/\$\{\s*[A-Za-z_$][\w$.[\]'"]{0,60}\s*\}/g)) push(m[0], 'template literal');
  for (const m of text.matchAll(/#\{\s*[A-Za-z_@][\w.@]{0,60}\s*\}/g)) push(m[0], 'Ruby interpolation');
  for (const m of text.matchAll(/\*\|[A-Z0-9_:]{1,40}\|\*/g)) push(m[0], 'Mailchimp merge tag');
  for (const m of text.matchAll(/%%[A-Za-z_][\w.]{0,40}%%/g)) push(m[0], 'merge tag');
  for (const m of text.matchAll(/\[\[\s*[A-Za-z_][\w.]{0,40}\s*\]\]/g)) push(m[0], 'merge tag');
  // {name} / {0}: single braces around an identifier, not part of {{ }} / ${ } / #{ }.
  for (const m of text.matchAll(/(?<![{$#%\\\w])\{\s?([A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)*|\d{1,2})\s?\}(?!\})/g)) {
    const id = m[1];
    if (/^\d+$/.test(id) || id.length >= 2) push(m[0], 'brace');
  }

  // The rest is ambiguous inside URLs / email addresses (percent-encoding, ports, user:pass): scan text without them.
  const plain = text.replace(URL_IN_TEXT, ' ').replace(EMAIL_IN_TEXT, ' ');
  // printf: %s %d %i %f %@ %1$s %(name)s %-5s %.2f — not %% and not after a digit/letter ("50%s").
  for (const m of plain.matchAll(/(?<![\w%])%(?:\(([A-Za-z_]\w*)\))?(?:\d+\$)?[-+0#]?\d*(?:\.\d+)?[sdif@](?![A-Za-z0-9])/g)) push(m[0], 'printf');
  // Laravel :name — only after whitespace/bracket/quote, snake_case or a known slot name, never :emoji: or a time.
  for (const m of plain.matchAll(/(?<=^|[\s(["'“])(:([a-z][a-z0-9]*(?:_[a-z0-9]+)*))(?![\w:/])/g)) {
    const name = m[2];
    if (name.includes('_') || SLOT_NAMES.has(name)) push(m[1], 'Laravel-style');
  }
  // __NAME__ / __first_name__ / __name__ (markdown __bold__ words are not flagged).
  for (const m of plain.matchAll(/(?<!\w)__([A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*)__(?!\w)/g)) {
    const name = m[1];
    if (/^[A-Z0-9_]+$/.test(name) || name.includes('_') || SLOT_NAMES.has(name.toLowerCase())) push(m[0], 'double-underscore');
  }
  return hits;
}

// ------------------------------------------------------------------------------------------------
// Leaked values
// ------------------------------------------------------------------------------------------------

export function findLeakedValues(text: string): { severity: LintSeverity; message: string; excerpt: string }[] {
  const out: { severity: LintSeverity; message: string; excerpt: string }[] = [];
  const ctx = (i: number, len: number) => short(text.slice(Math.max(0, i - 20), i + len + 20).replace(/\s+/g, ' ').trim(), 70);
  for (const m of text.matchAll(/\[object Object\]|%5Bobject%20Object%5D/gi)) out.push({ severity: 'error', message: 'An object was printed as text ([object Object])', excerpt: ctx(m.index!, m[0].length) });
  for (const m of text.matchAll(/\bInvalid Date\b/g)) out.push({ severity: 'error', message: 'A date failed to format (Invalid Date)', excerpt: ctx(m.index!, m[0].length) });
  for (const m of text.matchAll(/(?<![\w.])NaN(?!\w)/g)) out.push({ severity: 'error', message: 'A number failed to compute (NaN)', excerpt: ctx(m.index!, 3) });
  // undefined / null as a value, not as an English word ("an undefined error", "null and void").
  const englishBefore = /\b(?:an?|is|are|was|were|be|been|remains?|left|as|the|of|or|and|not)\s+$/i;
  for (const m of text.matchAll(/(?<![\w.$-])undefined(?![\w-])/g)) {
    if (englishBefore.test(text.slice(Math.max(0, m.index! - 12), m.index!))) continue;
    out.push({ severity: 'error', message: 'A missing value was printed as "undefined"', excerpt: ctx(m.index!, 9) });
  }
  for (const m of text.matchAll(/(?<![\w.$-])(?:null|NULL)(?![\w-])/g)) {
    if (englishBefore.test(text.slice(Math.max(0, m.index! - 12), m.index!))) continue;
    if (/^\s+(?:and void|hypothesis|pointer|byte|character|terminator|value|safe)/i.test(text.slice(m.index! + 4, m.index! + 20))) continue;
    out.push({ severity: 'warn', message: 'A missing value was printed as "null"', excerpt: ctx(m.index!, 4) });
  }
  for (const m of text.matchAll(/(?<=^|[\s:=(])(\{\}|\[\])(?=$|[\s.,;!?)])/g)) out.push({ severity: 'warn', message: `An empty object/array was printed (${m[0]})`, excerpt: ctx(m.index!, 2) });
  return out;
}

// ------------------------------------------------------------------------------------------------
// Charset
// ------------------------------------------------------------------------------------------------

export function findEncodingErrors(text: string): { message: string; excerpt: string }[] {
  const out: { message: string; excerpt: string }[] = [];
  const ctx = (i: number) => short(text.slice(Math.max(0, i - 15), i + 15).replace(/\s+/g, ' ').trim(), 50);
  const r = text.indexOf('\uFFFD');
  if (r >= 0) out.push({ message: 'Replacement character � (text decoded with the wrong charset)', excerpt: ctx(r) });
  // UTF-8 read as Latin-1 / Windows-1252: â€™ â€œ â€" Ã© Ã¨ Ã¶ …
  const moji = /â€[™œ\u009d˜“”¦¢\u0093\u0094]|Ã[©¨¢¤¶¼§¡³±ª«º]/.exec(text);
  if (moji) out.push({ message: `Mojibake "${moji[0]}" (UTF-8 shown as Latin-1)`, excerpt: ctx(moji.index) });
  return out;
}

const SCRIPT_RES: [string, RegExp][] = [
  ['Latin', /\p{Script=Latin}/u],
  ['Cyrillic', /\p{Script=Cyrillic}/u],
  ['Greek', /\p{Script=Greek}/u],
];

/** Words that mix Latin with Cyrillic/Greek letters ("Pаypal" with a Cyrillic а). Mixed sentences are fine. */
export function findMixedScriptWords(text: string): { word: string; scripts: string[] }[] {
  const out: { word: string; scripts: string[] }[] = [];
  for (const m of text.matchAll(/[\p{L}\p{M}]{3,}/gu)) {
    const scripts = SCRIPT_RES.filter(([, re]) => re.test(m[0])).map(([n]) => n);
    if (scripts.length > 1) out.push({ word: short(m[0], 40), scripts });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// HTML helpers (light regex approach; email HTML is not parsed into a DOM)
// ------------------------------------------------------------------------------------------------

/** Drop comments (incl. MSO conditionals), <style>, <script>, <head>: never shown as content. */
export function stripNonContent(html: string): string {
  // Linear scans with indexOf (lazy regexes over unclosed comments / tags are quadratic).
  let out = '';
  let pos = 0;
  for (;;) {
    const i = html.indexOf('<!--', pos);
    if (i < 0) break;
    out += html.slice(pos, i) + ' ';
    const j = html.indexOf('-->', i + 4);
    pos = j < 0 ? html.length : j + 3; // an unclosed comment hides the rest, as in a browser
  }
  out += html.slice(pos);
  const lowerHtml = out.toLowerCase();
  let res = '';
  pos = 0;
  const open = /<(script|style|head|title)\b/gi;
  for (let m = open.exec(out); m; m = open.exec(out)) {
    if (m.index < pos) continue;
    res += out.slice(pos, m.index) + ' ';
    const close = lowerHtml.indexOf(`</${m[1].toLowerCase()}`, m.index + m[0].length);
    if (close < 0) {
      pos = out.length;
      break;
    }
    const end = out.indexOf('>', close);
    pos = end < 0 ? out.length : end + 1;
    open.lastIndex = pos;
  }
  return res + out.slice(pos);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

export function htmlVisibleText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|td|th|h\d|li|table)>/gi, '\n')
      .replace(/<[^<>]{1,4000}>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n');
}

/** Values of attributes a reader sees or follows: href, src, alt, title, value. */
export function htmlAttributeValues(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/\s(?:href|src|alt|title|value)\s*=\s*(?:"([^"]{0,4000})"|'([^']{0,4000})')/gi)) {
    const v = decodeEntities(m[1] ?? m[2] ?? '');
    if (v.trim()) out.push(v);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// Links
// ------------------------------------------------------------------------------------------------

export interface FoundLink {
  url: string;
  source: 'text' | 'href' | 'src';
}

/** Trim punctuation that ends a sentence rather than the URL; a trailing ")" only when unbalanced. */
function trimTextUrl(u: string): string {
  let s = u;
  for (;;) {
    const last = s.at(-1);
    if (!last) return s;
    if ('.,;:!?\'"'.includes(last)) s = s.slice(0, -1);
    else if (last === ')' && (s.match(/\(/g)?.length ?? 0) < (s.match(/\)/g)?.length ?? 0)) s = s.slice(0, -1);
    else if (last === ']' && (s.match(/\[/g)?.length ?? 0) < (s.match(/\]/g)?.length ?? 0)) s = s.slice(0, -1);
    else return s;
  }
}

export function collectLinks(text: string, html: string | null): FoundLink[] {
  const out: FoundLink[] = [];
  const seen = new Set<string>();
  const push = (full: string, source: FoundLink['source']) => {
    const url = full.slice(0, 2048);
    const key = `${source}:${url}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ url, source });
  };
  for (const m of text.matchAll(/\b(?:https?:\/\/|mailto:)[^\s<>"']*/gi)) push(trimTextUrl(m[0]), 'text');
  if (html) {
    for (const m of html.matchAll(/<(a|area|img|link)\b[^<>]{0,2000}?\s(href|src)\s*=\s*(?:"([^"]{0,4000})"|'([^']{0,4000})'|([^\s>]+))/gi)) {
      const raw = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
      push(raw, m[2].toLowerCase() === 'src' ? 'src' : 'href');
    }
    for (const m of htmlVisibleText(html).matchAll(/\b(?:https?:\/\/|mailto:)[^\s<>"']*/gi)) push(trimTextUrl(m[0]), 'text');
  }
  return out;
}

const TRACKING_PARAM = /^(?:utm_[a-z_]+|gclid|fbclid|msclkid|dclid|yclid|igshid|mc_cid|mc_eid|_hsenc|_hsmi|mkt_tok)$/i;
const LOCAL_SUFFIXES = ['.local', '.localhost', '.test', '.internal', '.example', '.invalid', '.lan', '.home.arpa'];

export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === 'localhost' || h === '0.0.0.0' || h === '::1' || h === '::') return true;
  if (LOCAL_SUFFIXES.some((s) => h.endsWith(s))) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
  }
  return !h.includes('.') && !h.includes(':'); // single-label host ("stubyard", "app")
}

const hasPlaceholder = (u: string) => /\{\{|\$\{|%7B%7B|\{%|#\{/i.test(u);

export function checkLinks(links: FoundLink[], productionDomains: string[], channel: LintChannel): LintFinding[] {
  const out: LintFinding[] = [];
  const prod = productionDomains.map((d) => d.trim().toLowerCase().replace(/^\*?\./, '')).filter(Boolean);
  for (const { url: rawUrl, source } of links) {
    const raw = rawUrl.trim();
    const label = short(raw);
    if (source !== 'text' && raw === '') {
      out.push({ check: 'link-broken', severity: 'warn', message: `Empty ${source} attribute`, excerpt: `${source}=""`, where: 'link' });
      continue;
    }
    if (/^mailto:/i.test(raw)) {
      const addr = decodeURIComponentSafe(raw.slice(7).split('?')[0]).trim();
      if (!addr && channel === 'email') out.push({ check: 'mailto-empty', severity: 'warn', message: 'mailto: link without an address', excerpt: label, where: 'link' });
      continue;
    }
    if (!/^https?:/i.test(raw)) continue; // tel:, sms:, #anchor, relative, cid:…
    if (hasPlaceholder(raw)) continue; // reported as a placeholder already

    // Broken-looking
    const broken: string[] = [];
    if (/\s/.test(raw)) broken.push('contains spaces');
    if (/^https?:\/\/(?:https?:)?\/\//i.test(raw) || /^https?:\/\/https?[:/]/i.test(raw)) broken.push('doubled scheme');
    if (/^https?:\/?[^/]/i.test(raw) || /^https?:\/\/(?:[/?#]|$)/i.test(raw)) broken.push('no host');
    for (const [o, c] of [['(', ')'], ['[', ']'], ['{', '}']] as const) {
      if ((raw.split(o).length - 1) !== (raw.split(c).length - 1)) broken.push(`unbalanced ${o}${c}`);
    }
    let parsed: URL | null = null;
    try {
      parsed = new URL(raw);
    } catch {
      if (!broken.length) broken.push('not a valid URL');
    }
    if (broken.length) {
      out.push({ check: 'link-broken', severity: 'warn', message: `Broken-looking link (${broken.join(', ')})`, excerpt: label, where: 'link' });
      if (!parsed) continue;
    }
    if (!parsed) continue;
    const host = parsed.hostname;
    if (!host) continue;

    if (isLocalHost(host)) {
      out.push({ check: 'link-local', severity: 'warn', message: `Link to ${host}: will not work for real users`, excerpt: label, where: 'link' });
    } else {
      if (parsed.protocol === 'http:') out.push({ check: 'link-http', severity: 'info', message: 'Link uses http:// (not https)', excerpt: label, where: 'link' });
      const h = host.toLowerCase();
      // Images from the production CDN are normal; links that send the user to production are not.
      const hit = source === 'src' ? undefined : prod.find((d) => h === d || h.endsWith(`.${d}`));
      if (hit) out.push({ check: 'link-production', severity: 'warn', message: `Link to production domain ${hit}`, excerpt: label, where: 'link' });
    }

    // Tracking parameters
    const qIndex = raw.indexOf('?');
    if (qIndex >= 0 && /\?[^#]*\?(?:utm_|gclid|fbclid|mc_)/i.test(raw.slice(qIndex))) {
      out.push({ check: 'link-tracking', severity: 'warn', message: 'Tracking parameters appended with a second "?"', excerpt: label, where: 'link' });
    } else {
      const counts = new Map<string, number>();
      for (const k of parsed.searchParams.keys()) if (TRACKING_PARAM.test(k)) counts.set(k.toLowerCase(), (counts.get(k.toLowerCase()) ?? 0) + 1);
      const dup = [...counts].filter(([, n]) => n > 1).map(([k]) => k);
      if (dup.length) out.push({ check: 'link-tracking', severity: 'warn', message: `Tracking parameter repeated: ${dup.join(', ')}`, excerpt: label, where: 'link' });
    }
  }
  return out;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ------------------------------------------------------------------------------------------------
// Email
// ------------------------------------------------------------------------------------------------

function header(h: LintInput['headers'], name: string): string | undefined {
  if (!h) return undefined;
  const k = Object.keys(h).find((x) => x.toLowerCase() === name.toLowerCase());
  const v = k ? h[k] : undefined;
  return Array.isArray(v) ? v.join(', ') : v;
}

export const GMAIL_CLIP_BYTES = 102 * 1024;

function checkEmail(input: LintInput, html: string | null): LintFinding[] {
  const out: LintFinding[] = [];
  const marketing = (input.instanceLabels ?? []).some((l) => l.toLowerCase() === 'marketing');
  if (marketing && input.headers) {
    const lu = header(input.headers, 'List-Unsubscribe');
    const post = header(input.headers, 'List-Unsubscribe-Post');
    if (!lu) {
      out.push({ check: 'email-unsubscribe', severity: 'error', message: 'Marketing email without a List-Unsubscribe header (Gmail / Yahoo bulk-sender rules)', where: 'headers' });
    } else {
      if (!/<https:\/\/[^<>]+>/i.test(lu)) {
        out.push({ check: 'email-unsubscribe', severity: /<mailto:[^<>]+>/i.test(lu) ? 'warn' : 'error', message: 'List-Unsubscribe has no <https://…> URL (one-click unsubscribe needs one)', excerpt: short(lu), where: 'headers' });
      }
      if (!post || !/^\s*List-Unsubscribe=One-Click\s*$/i.test(post)) {
        out.push({ check: 'email-unsubscribe', severity: 'error', message: 'Missing List-Unsubscribe-Post: List-Unsubscribe=One-Click', excerpt: post ? short(post) : undefined, where: 'headers' });
      }
    }
  }
  if (input.html && input.hasTextPart === false) {
    out.push({ check: 'email-text-part', severity: 'warn', message: 'HTML email without a plain-text part (spam score, text-only clients)' });
  }
  const subject = (input.subject ?? '').trim();
  if (!subject) out.push({ check: 'email-subject', severity: 'warn', message: 'Empty subject', where: 'subject' });
  else if ([...subject].length > 120) out.push({ check: 'email-subject', severity: 'warn', message: `Subject is ${[...subject].length} characters (over 120 gets cut off)`, excerpt: short(subject, 60), where: 'subject' });
  if (input.fromName !== undefined && !(input.fromName ?? '').trim()) {
    out.push({ check: 'email-from-name', severity: 'info', message: 'From has no display name (shows as a bare address)' });
  }
  if (html) {
    let missing = 0;
    for (const m of html.matchAll(/<img\b[^<>]{0,4000}>/gi)) {
      const tag = m[0];
      if (/\salt\s*=/i.test(tag)) continue;
      // Tracking pixels / spacers.
      if (/\s(?:width|height)\s*=\s*["']?[01](?:px)?["'\s/>]/i.test(tag) || /display\s*:\s*none/i.test(tag)) continue;
      missing++;
    }
    if (missing) out.push({ check: 'email-img-alt', severity: 'info', message: `${missing} image${missing === 1 ? '' : 's'} without alt text`, where: 'html' });
  }
  if (input.html) {
    const bytes = Buffer.byteLength(input.html, 'utf8');
    if (bytes > GMAIL_CLIP_BYTES) out.push({ check: 'email-size', severity: 'warn', message: `HTML is ${Math.round(bytes / 1024)} KB: Gmail clips messages over 102 KB`, where: 'html' });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// SMS
// ------------------------------------------------------------------------------------------------

/** "Smart" characters word processors / CMSs insert, and their GSM-7 replacement. */
const SMART: Record<string, string> = {
  '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'", '\u2032': "'", '\u00B4': "'", '\u2039': "'", '\u203A': "'",
  '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u201F': '"', '\u2033': '"', '\u00AB': '"', '\u00BB': '"',
  '\u2013': '-', '\u2014': '-', '\u2012': '-', '\u2015': '-', '\u2212': '-', '\u2010': '-', '\u2011': '-',
  '\u2026': '...', '\u00A0': ' ', '\u2009': ' ', '\u202F': ' ', '\u2007': ' ', '\u200B': '', '\uFEFF': '', '\u2022': '*', '\u00B7': '.',
};
const EMOJI_RE = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u200D|\uFE0F|\u20E3)$/u;

const codepoint = (c: string) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;

export function checkSms(text: string): LintFinding[] {
  const out: LintFinding[] = [];
  const info = smsSegments(text);
  if (info.encoding === 'UCS-2') {
    const offenders = [...new Set([...text].filter((c) => !isGsm7(c)))];
    const allSmart = offenders.every((c) => c in SMART || EMOJI_RE.test(c));
    if (allSmart && offenders.length) {
      const fixed = [...text].map((c) => (c in SMART ? SMART[c] : EMOJI_RE.test(c) ? '' : c)).join('');
      const asGsm = smsSegments(fixed);
      const list = offenders.filter((c) => !/[\u200D\uFE0F\u20E3]/.test(c)).slice(0, 5).map((c) => `${c} (${codepoint(c)})`).join(', ') || offenders.map(codepoint).join(', ');
      const cost =
        asGsm.segments < info.segments
          ? `${info.segments} segments instead of ${asGsm.segments} as GSM-7`
          : `${info.segments} segment${info.segments === 1 ? '' : 's'} either way, but only 70 characters per SMS instead of 160`;
      out.push({
        check: 'sms-encoding',
        severity: asGsm.segments < info.segments ? 'warn' : 'info',
        message: `UCS-2 encoding only because of ${list}: ${cost}`,
        excerpt: offenders.slice(0, 5).join(' '),
        where: 'text',
      });
    }
  }
  if (info.segments > 3) out.push({ check: 'sms-segments', severity: 'warn', message: `${info.segments} segments (${info.encoding}, ${info.characters} characters): billed as ${info.segments} SMS` });
  else if (info.segments > 1) out.push({ check: 'sms-segments', severity: 'info', message: `${info.segments} segments (${info.encoding}, ${info.characters} characters)` });
  return out;
}

// ------------------------------------------------------------------------------------------------
// WhatsApp
// ------------------------------------------------------------------------------------------------

export const WA_TEXT_MAX = 4096;

function checkWhatsApp(input: LintInput): LintFinding[] {
  const out: LintFinding[] = [];
  const t = input.waTemplate;
  if (t) {
    const empty = t.params.map((p, i) => ({ p, i })).filter(({ p }) => p === null || p.trim() === '');
    if (empty.length) {
      out.push({
        check: 'wa-template-params',
        severity: 'error',
        message: `Template "${t.name}" has ${empty.length === 1 ? 'an empty parameter' : `${empty.length} empty parameters`} (#${empty.map((e) => e.i + 1).join(', #')})`,
        excerpt: t.name,
        where: 'template',
      });
    }
  }
  const len = [...(input.text ?? '')].length;
  if (len > WA_TEXT_MAX) out.push({ check: 'wa-length', severity: 'error', message: `Text is ${len} characters (WhatsApp allows ${WA_TEXT_MAX})`, where: 'text' });
  return out;
}

// ------------------------------------------------------------------------------------------------
// Raw MIME helpers (for the capture paths)
// ------------------------------------------------------------------------------------------------

/** Top-level header block of a raw message as { name: value | value[] } (folded lines joined). */
export function parseHeaderBlock(raw: string | Buffer): Record<string, string | string[]> {
  const src = typeof raw === 'string' ? raw : raw.subarray(0, 256 * 1024).toString('latin1');
  const end = src.search(/\r?\n\r?\n/);
  const head = (end >= 0 ? src.slice(0, end) : src).replace(/\r?\n[ \t]+/g, ' ');
  const out: Record<string, string | string[]> = {};
  for (const line of head.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    const cur = out[k];
    out[k] = cur === undefined ? v : Array.isArray(cur) ? [...cur, v] : [cur, v];
  }
  return out;
}

/**
 * Does a raw MIME message carry a text/plain part? (mailparser invents `text` from the HTML, so it cannot tell.)
 * A message without any Content-Type is plain text by definition.
 */
export function mimeHasTextPart(raw: string | Buffer): boolean {
  const src = typeof raw === 'string' ? raw : raw.toString('latin1');
  if (!/^content-type:/im.test(src)) return true;
  return /^content-type:\s*text\/plain/im.test(src);
}
