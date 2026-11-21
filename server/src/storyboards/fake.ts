import { createHash } from 'node:crypto';
import { FIRST_NAMES } from '../repos/users.js';

/**
 * Deterministic fake data for storyboard templates ({{fake.firstName}}, {{fake.phone}} …). Every value comes from a
 * PRNG seeded with sha256(seed + '|' + name), so one walkthrough always renders the same value for the same name:
 * pressing Fill twice is idempotent. A suffix gives another value: {{fake.firstName:2}}.
 */

export { FIRST_NAMES };

export const LAST_NAMES = [
  'Khan', 'Ahmed', 'Malik', 'Hussain', 'Siddiqui', 'Qureshi', 'Haddad', 'Rahman', 'Farouk', 'Nasser',
  'Smith', 'Jones', 'Brown', 'Taylor', 'Wilson', 'Clarke', 'Walker', 'Moreau', 'Rossi', 'Novak',
];

export const COMPANIES = [
  'Northwind Labs', 'Blue Harbor Trading', 'Cedar & Pine Consulting', 'Falcon Logistics', 'Greenfield Health',
  'Summit Analytics', 'Oasis Events', 'Crescent Engineering', 'Silverline Media', 'Atlas Medical Group',
];

export const JOB_TITLES = [
  'QA Engineer', 'Project Manager', 'Consultant', 'Operations Lead', 'Physician', 'Pharmacist',
  'Marketing Specialist', 'Research Associate', 'Software Developer', 'Office Manager',
];

export const CITIES = ['Riyadh', 'Jeddah', 'Dubai', 'Doha', 'Karachi', 'Lahore', 'London', 'Manchester', 'Berlin', 'Toronto'];

export const WORDS = ['amber', 'birch', 'cobalt', 'delta', 'ember', 'fjord', 'granite', 'harbor', 'indigo', 'juniper', 'kestrel', 'lumen'];

/** A PRNG (mulberry32) seeded with the first 4 bytes of sha256(seed): numbers in [0, 1). */
export function seededRandom(seed: string): () => number {
  let a = createHash('sha256').update(seed).digest().readUInt32BE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seed of one template variable in one walkthrough. */
export const seedOf = (walkthroughId: string, name: string) => `${walkthroughId}|${name}`;

export function pick<T>(list: readonly T[], rnd: () => number): T {
  return list[Math.floor(rnd() * list.length)];
}

/** N digits (1..32). */
export function digits(n: number, rnd: () => number): string {
  const len = Math.min(32, Math.max(1, Math.floor(n)));
  let s = '';
  for (let i = 0; i < len; i++) s += String(Math.floor(rnd() * 10));
  return s;
}

/** A version 4 UUID from the PRNG. */
export function uuidFrom(rnd: () => number): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(rnd() * 16).toString(16));
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Same shape as users.generate: '+' + prefix digits + digits padded so the number has 12 digits (at least 4 random). */
export function fakePhone(phonePrefix: string, rnd: () => number): string {
  const prefixDigits = phonePrefix.replace(/[^\d]/g, '');
  const width = Math.max(4, 12 - prefixDigits.length);
  return '+' + prefixDigits + digits(width, rnd);
}

export interface FakeContext {
  /** Seed base (the walkthrough id; "preview" while authoring). */
  seed: string;
  /** The walkthrough key ({{unique}}). */
  unique: string;
  emailDomain: string;
  phonePrefix: string;
}

export const FAKE_GENERATORS = ['firstName', 'lastName', 'fullName', 'company', 'jobTitle', 'city', 'word', 'email', 'phone', 'digits'] as const;
export type FakeGenerator = (typeof FAKE_GENERATORS)[number];

const SUFFIX = '[A-Za-z0-9_-]{1,32}';
const FAKE_RE = new RegExp(`^fake\\.([A-Za-z]+)(?::(\\d{1,2}))?(?::(${SUFFIX}))?$`);

/** "fake.firstName:2" → {gen:'firstName', n:null, suffix:'2'}; "fake.digits:6:b" → {gen:'digits', n:6, suffix:'b'}; null when not a fake variable. */
export function parseFake(name: string): { gen: FakeGenerator; n: number | null; suffix: string | null } | null {
  const m = FAKE_RE.exec(name);
  if (!m || !(FAKE_GENERATORS as readonly string[]).includes(m[1])) return null;
  const gen = m[1] as FakeGenerator;
  let n = m[2] === undefined ? null : Number(m[2]);
  let suffix = m[3] ?? null;
  if (gen === 'digits') {
    if (n === null || n < 1 || n > 32) return null;
  } else if (n !== null) {
    // "fake.firstName:2": a numeric part is the suffix, not a length.
    if (suffix !== null) return null;
    suffix = m[2];
    n = null;
  }
  return { gen, n, suffix };
}

/**
 * Value of a fake variable (name without braces), or undefined when the name is not one.
 * fullName and email reuse fake.firstName / fake.lastName (with the same suffix), so they agree with each other.
 */
export function fakeValue(name: string, ctx: FakeContext): string | undefined {
  const f = parseFake(name.trim());
  if (!f) return undefined;
  const sfx = f.suffix === null ? '' : `:${f.suffix}`;
  const rnd = (n: string) => seededRandom(seedOf(ctx.seed, n));
  const first = () => pick(FIRST_NAMES, rnd(`fake.firstName${sfx}`));
  const last = () => pick(LAST_NAMES, rnd(`fake.lastName${sfx}`));
  switch (f.gen) {
    case 'firstName':
      return first();
    case 'lastName':
      return last();
    case 'fullName':
      return `${first()} ${last()}`;
    case 'company':
      return pick(COMPANIES, rnd(`fake.company${sfx}`));
    case 'jobTitle':
      return pick(JOB_TITLES, rnd(`fake.jobTitle${sfx}`));
    case 'city':
      return pick(CITIES, rnd(`fake.city${sfx}`));
    case 'word':
      return pick(WORDS, rnd(`fake.word${sfx}`));
    case 'email':
      return `${first()}.${last()}.${ctx.unique}${f.suffix === null ? '' : `.${f.suffix}`}`.toLowerCase().replace(/[^a-z0-9._-]/g, '') + `@${ctx.emailDomain}`;
    case 'phone':
      return fakePhone(ctx.phonePrefix, rnd(`fake.phone${sfx}`));
    case 'digits':
      return digits(f.n!, rnd(`fake.digits:${f.n}${sfx}`));
  }
}
