import { randomInt, randomUUID } from 'node:crypto';

/**
 * Template variables for outbound webhooks and inbound responses:
 *   {{uuid}} {{now}} {{timestamp}} {{timestampMs}} {{run.id}}
 *   {{faker.name|firstName|lastName|email|phone|amount|word|words|number|date|uuid|company|city|country|url|bool}}
 *   {{user.id|name|email|phone|whatsapp|role}}   (send as a test user)
 *   {{data.<path>}}                               (extra data / captured event, e.g. data.items[0].id)
 * Inbound responses additionally get {{body.*}} {{params.*}} {{query.*}} {{headers.*}} {{request.id}}.
 */

const FIRST = ['Ayesha', 'Bilal', 'Hamza', 'Sara', 'Omar', 'Fatima', 'Ali', 'Zara', 'Usman', 'Hina', 'James', 'Maria', 'Liam', 'Emma', 'Noah', 'Olivia'];
const LAST = ['Khan', 'Ahmed', 'Malik', 'Hussain', 'Raza', 'Iqbal', 'Smith', 'Garcia', 'Brown', 'Wilson', 'Taylor', 'Lee'];
const WORDS = ['alpha', 'bravo', 'delta', 'orbit', 'pixel', 'river', 'cedar', 'ember', 'falcon', 'harbor', 'maple', 'nova', 'quartz', 'summit', 'velvet', 'willow'];
const COMPANIES = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Hooli', 'Stark Industries', 'Wayne Enterprises', 'Soylent'];
const CITIES = ['Karachi', 'Lahore', 'Islamabad', 'London', 'Berlin', 'Dubai', 'Toronto', 'Austin'];
const COUNTRIES = ['PK', 'GB', 'DE', 'AE', 'CA', 'US'];

const pick = <T>(a: T[]): T => a[randomInt(a.length)];

export const FAKER: Record<string, () => unknown> = {
  name: () => `${pick(FIRST)} ${pick(LAST)}`,
  firstName: () => pick(FIRST),
  lastName: () => pick(LAST),
  email: () => `${pick(FIRST).toLowerCase()}.${pick(LAST).toLowerCase()}${randomInt(100)}@example.test`,
  phone: () => `+1555${String(randomInt(10_000_000)).padStart(7, '0')}`,
  amount: () => Math.round((randomInt(100, 100_000) / 100) * 100) / 100,
  word: () => pick(WORDS),
  words: () => `${pick(WORDS)} ${pick(WORDS)} ${pick(WORDS)}`,
  number: () => randomInt(1, 100_000),
  date: () => new Date(Date.now() - randomInt(0, 365 * 86_400_000)).toISOString().slice(0, 10),
  uuid: () => randomUUID(),
  company: () => pick(COMPANIES),
  city: () => pick(CITIES),
  country: () => pick(COUNTRIES),
  url: () => `https://${pick(WORDS)}.example.test/${pick(WORDS)}`,
  bool: () => randomInt(2) === 1,
};

export const TEMPLATE_VARIABLES: { name: string; description: string }[] = [
  { name: 'uuid', description: 'A UUID, the same everywhere in one send (URL, headers, body)' },
  { name: 'run.id', description: 'One id shared by every step of a sequence run' },
  { name: 'now', description: 'Current time, ISO 8601' },
  { name: 'timestamp', description: 'Current time, Unix seconds' },
  { name: 'timestampMs', description: 'Current time, Unix milliseconds' },
  ...Object.keys(FAKER).map((k) => ({ name: `faker.${k}`, description: `Random ${k} (new value each time)` })),
  { name: 'user.id', description: 'Test user id ("send as")' },
  { name: 'user.name', description: 'Test user name' },
  { name: 'user.email', description: 'Test user email' },
  { name: 'user.phone', description: 'Test user phone' },
  { name: 'user.whatsapp', description: 'Test user WhatsApp number' },
  { name: 'user.role', description: 'Test user role' },
  { name: 'data.<path>', description: 'Field from the data you pass (e.g. data.order.id, data.items[0].sku)' },
];

export interface TemplateContext {
  /** Stable for one render pass (one send). */
  uuid: string;
  now: Date;
  run?: { id: string };
  user?: Record<string, unknown> | null;
  data?: unknown;
  /** Extra roots (inbound responses: body, params, query, headers, request). */
  [root: string]: unknown;
}

export function newContext(extra: Partial<TemplateContext> = {}): TemplateContext {
  const uuid = randomUUID();
  return { uuid, now: new Date(), run: { id: uuid }, ...extra } as TemplateContext;
}

/** Read "a.b[0].c" from a value. */
export function getPath(v: unknown, path: string): unknown {
  if (!path) return v;
  let cur = v;
  for (const part of path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function lookup(expr: string, ctx: TemplateContext): { found: boolean; value: unknown } {
  const e = expr.trim();
  switch (e) {
    case 'uuid':
      return { found: true, value: ctx.uuid };
    case 'now':
      return { found: true, value: ctx.now.toISOString() };
    case 'timestamp':
      return { found: true, value: Math.floor(ctx.now.getTime() / 1000) };
    case 'timestampMs':
      return { found: true, value: ctx.now.getTime() };
  }
  if (e.startsWith('faker.')) {
    const f = FAKER[e.slice(6)];
    return f ? { found: true, value: f() } : { found: false, value: undefined };
  }
  const dot = e.search(/[.[]/);
  const root = dot === -1 ? e : e.slice(0, dot);
  const rest = dot === -1 ? '' : e.slice(dot).replace(/^\./, '');
  if (!(root in ctx) || ['now'].includes(root)) return { found: false, value: undefined };
  const value = getPath(ctx[root], rest);
  return { found: value !== undefined, value };
}

export interface RenderResult {
  text: string;
  /** Placeholders that had no value (rendered as empty). */
  missing: string[];
}

/**
 * Replace {{ var }} placeholders. In JSON mode, strings are JSON-escaped (so quotes in a name don't break the
 * payload) and objects/arrays are inserted as JSON.
 */
export function render(template: string, ctx: TemplateContext, opts: { json?: boolean } = {}): RenderResult {
  const missing: string[] = [];
  const text = template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_m, expr: string) => {
    const { found, value } = lookup(expr, ctx);
    if (!found) {
      missing.push(expr);
      return '';
    }
    if (value === null) return opts.json ? 'null' : '';
    if (typeof value === 'object') return JSON.stringify(value);
    const s = String(value);
    if (opts.json && typeof value === 'string') return JSON.stringify(s).slice(1, -1);
    return s;
  });
  return { text, missing: [...new Set(missing)] };
}

/** Heuristic: treat as JSON when the content type says so, or the template looks like a JSON document. */
export function looksJson(template: string, contentType?: string | null): boolean {
  if (contentType) return /[/+]json\b/i.test(contentType);
  const t = template.trim();
  return t.startsWith('{') || t.startsWith('[');
}
