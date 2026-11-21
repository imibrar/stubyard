import { randomInt, randomUUID } from 'node:crypto';
import type { Channel } from '../providers/catalog.js';

/** Everything a reply template can read. */
export interface TemplateVars {
  otp: string | null;
  links: string[];
  subject: string | null;
  body: string | null;
  from: string | null;
  to: string | null;
  channel: Channel;
  user: { name: string; email: string | null; phone: string | null; role: string } | null;
  /** body.1, body.<name>, subject.1 … from the match regexes. */
  captures: Record<string, string>;
  /** Fixed "now" for one render (tests); default: the current time. */
  now?: Date;
  /** Extra variables, consulted before the built-in ones (storyboards); undefined = not handled here. */
  extra?: (name: string) => string | undefined;
}

/** Variables shown in the dashboard picker and in GET /api/auto-reply-presets. */
export const TEMPLATE_VARIABLES: { name: string; help: string }[] = [
  { name: 'otp', help: 'The code in the message (stubyard detected it, or the project OTP regex finds it)' },
  { name: 'link', help: 'First link in the message (same as links.0)' },
  { name: 'links.0', help: 'Links by position, 0 = first' },
  { name: 'subject', help: 'Subject of the message (email)' },
  { name: 'body', help: 'Text of the message' },
  { name: 'from', help: 'Sender address / number of the message' },
  { name: 'to', help: "The test user's address / number the message went to" },
  { name: 'channel', help: 'email, sms or whatsapp' },
  { name: 'user.name', help: 'Test user name (also user.email, user.phone, user.role)' },
  { name: 'body.1', help: 'Capture group 1 of the body regex ($1 is the same); named groups: body.<name>' },
  { name: 'subject.1', help: 'Capture group 1 of the subject regex; named groups: subject.<name>' },
  { name: 'now', help: 'Send time, ISO 8601' },
  { name: 'uuid', help: 'A random UUID' },
  { name: 'random.digits:6', help: 'N random digits' },
];

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Value of one variable; undefined = unknown variable. */
function lookup(name: string, v: TemplateVars): string | undefined {
  const n = name.trim();
  const x = v.extra?.(n);
  if (x !== undefined) return x;
  switch (n) {
    case 'otp':
      return v.otp ?? '';
    case 'link':
      return v.links[0] ?? '';
    case 'subject':
      return v.subject ?? '';
    case 'body':
      return v.body ?? '';
    case 'from':
      return v.from ?? '';
    case 'to':
      return v.to ?? '';
    case 'channel':
      return v.channel;
    case 'now':
      return (v.now ?? new Date()).toISOString();
    case 'uuid':
      return randomUUID();
    case 'user.name':
      return v.user?.name ?? '';
    case 'user.email':
      return v.user?.email ?? '';
    case 'user.phone':
      return v.user?.phone ?? '';
    case 'user.role':
      return v.user?.role ?? '';
  }
  let m = /^links\.(\d+)$/.exec(n);
  if (m) return v.links[Number(m[1])] ?? '';
  m = /^random\.digits:(\d{1,2})$/.exec(n);
  if (m) {
    const len = Math.min(32, Math.max(1, Number(m[1])));
    let s = '';
    for (let i = 0; i < len; i++) s += String(randomInt(10));
    return s;
  }
  m = /^\$(\d+)$/.exec(n);
  if (m) return v.captures[`body.${m[1]}`];
  m = /^(body|subject)\.([A-Za-z0-9_]+)$/.exec(n);
  if (m) return v.captures[`${m[1]}.${m[2]}`];
  return undefined;
}

/**
 * Renders {{variable}} placeholders. Unknown variables (and capture groups that did not take part in the match)
 * become empty text and add a warning. `html`: values are HTML-escaped.
 */
export function render(template: string | null | undefined, vars: TemplateVars, opts: { html?: boolean; field?: string } = {}): { text: string; warnings: string[] } {
  const warnings: string[] = [];
  if (!template) return { text: '', warnings };
  const text = template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_all, name: string) => {
    const val = lookup(name, vars);
    if (val === undefined) {
      warnings.push(`${opts.field ?? 'template'}: {{${name}}} is not a known variable or capture; left empty`);
      return '';
    }
    return opts.html ? escapeHtml(val) : val;
  });
  return { text, warnings };
}

/** Variables used by a template ("{{otp}} {{body.1}}" → ["otp", "body.1"]), for checks at save time. */
export function variablesOf(template: string | null | undefined): string[] {
  return [...(template ?? '').matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((m) => m[1]);
}
