import { z } from 'zod';

/**
 * Storyboards contract (docs/design/storyboards.md §1.3). This file is the single source of the shapes: REST
 * validation, the MCP ontology (z.toJSONSchema) and the hand-written client/web/extension mirrors all follow it.
 * A change here must be made in the design document too.
 */

export const SLUG = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/, 'lowercase letters, digits, dashes; max 48');
export const KEY = z.string().regex(/^[a-z][a-zA-Z0-9_]{0,31}$/, 'lowercase letter first, then letters, digits, _'); // camelCase ok: vars.regNo
export const STEP_ID = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/);
export const TEMPLATE = z.string().max(2000); // may contain {{…}}
export const SELECTOR = z.string().min(1).max(500); // CSS selector (checked with a parse attempt in the extension only)
export const ROLE = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/); // same normalisation as test_users.role

/** Duplicate entry keys in a data set → one issue per duplicate at entries[i].key. */
export function uniqueKeys(ds: { entries: { key: string }[] }, ctx: z.RefinementCtx): void {
  const seen = new Map<string, number>();
  ds.entries.forEach((e, i) => {
    const first = seen.get(e.key);
    if (first === undefined) seen.set(e.key, i);
    else ctx.addIssue({ code: 'custom', message: `duplicate key "${e.key}" (also entries[${first}].key)`, path: ['entries', i, 'key'] });
  });
}

export const TWO_FACTOR_KINDS = ['none', 'totp', 'email-otp', 'sms-otp'] as const;

export const LoginRecipe = z.object({
  role: ROLE,
  name: z.string().max(100).default(''),
  loginUrl: TEMPLATE, // absolute, or "/path" (resolved against the walkthrough origin)
  fields: z
    .object({
      username: SELECTOR.default('#email'),
      password: SELECTOR.default('#password'),
      submit: SELECTOR.optional(), // only highlighted, never clicked
    })
    // prefault (not default): zod 4 returns a default as-is, prefault parses it so the inner defaults apply.
    .prefault({}),
  twoFactor: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('none') }),
      z.object({
        kind: z.literal('totp'),
        selector: SELECTOR.default('#code'),
        authenticator: z.string().max(200).optional(), // label; default: the key linked to the user
      }),
      z.object({
        kind: z.enum(['email-otp', 'sms-otp']),
        selector: SELECTOR,
        subject: z.string().max(200).optional(), // optional subject filter for the OTP message
      }),
    ])
    .default({ kind: 'none' }),
  logoutUrl: TEMPLATE.nullable().default(null),
  notes: z.string().max(2000).default(''),
});

export const FIELD_KINDS = ['auto', 'text', 'select', 'radio', 'checkbox', 'radix-select', 'radix-checkbox', 'radix-radio', 'date', 'otp', 'skip'] as const;
export const DataEntry = z.object({
  key: z.string().min(1).max(200), // element id, name, data-testid, label text or placeholder
  value: z.union([TEMPLATE, z.boolean(), z.array(TEMPLATE).max(50)]),
  kind: z.enum(FIELD_KINDS).default('auto'),
  selector: SELECTOR.optional(), // overrides key matching
  label: z.string().max(200).optional(), // human label (from a scan)
  note: z.string().max(500).optional(),
});
export const DataSet = z
  .object({
    slug: SLUG,
    name: z.string().min(1).max(100),
    description: z.string().max(2000).default(''),
    match: z
      .object({
        urlPattern: z.string().max(500).optional(), // glob on path(+query): "/register/*", "*" = one segment, "**" = any
        formId: z.string().max(200).optional(),
      })
      .default({}),
    entries: z.array(DataEntry).max(300),
  })
  .superRefine(uniqueKeys); // duplicate entry key -> issue at entries[i].key

export const Actor = z
  .object({
    key: KEY,
    label: z.string().max(100).default(''),
    role: ROLE, // picks the login recipe; for fresh users also their role
    user: z.string().max(200).optional(), // existing test user ref (id, email, name, role); omitted = first user with `role`
    fresh: z.boolean().default(false), // create a new test user per walkthrough
    name: TEMPLATE.optional(), // fresh users: name template, default "{{fake.firstName}} {{fake.lastName}}"
  })
  .refine((a) => !(a.fresh && a.user), { message: 'fresh actors cannot name an existing user', path: ['user'] });

export const Input = z.object({
  name: KEY,
  label: z.string().max(100),
  required: z.boolean().default(false),
  default: z.string().max(500).optional(),
  help: z.string().max(500).optional(),
});

export const STEP_KINDS = ['open', 'login', 'logout', 'fill', 'email', 'instruction', 'capture', 'check'] as const;

const Base = {
  id: STEP_ID.optional(), // assigned s1, s2… when missing; stable afterwards
  title: z.string().min(1).max(200),
  intent: z.string().min(1).max(1000), // one plain-language sentence: what the user does and why (agent-friendly)
  actor: KEY.optional(), // default: the previous step's actor (first step: first actor)
  notes: z.string().max(4000).default(''),
  optional: z.boolean().default(false),
  screenshot: z.enum(['off', 'offer', 'required']).default('offer'),
  target: z.object({ selector: SELECTOR.optional(), text: z.string().max(200).optional() }).optional(), // hint for highlight / future agent
};
export const Step = z.discriminatedUnion('kind', [
  z.object({ ...Base, kind: z.literal('open'), url: TEMPLATE }),
  z.object({ ...Base, kind: z.literal('login'), actor: KEY, recipe: ROLE.optional(), url: TEMPLATE.optional() }),
  z.object({ ...Base, kind: z.literal('logout'), url: TEMPLATE.optional() }),
  z.object({ ...Base, kind: z.literal('fill'), dataSet: SLUG, url: TEMPLATE.optional(), formId: z.string().max(200).optional() }),
  z.object({
    ...Base,
    kind: z.literal('email'),
    actor: KEY,
    channel: z.enum(['email', 'sms', 'whatsapp']).default('email'),
    match: z
      .object({
        subject: z.string().max(300).optional(), // substring, or /regex/flags
        text: TEMPLATE.optional(), // substring that must be in subject or body
      })
      .default({}),
    link: z
      .object({
        pattern: z.string().max(300).optional(), // substring or /regex/ on the URL
        index: z.number().int().min(0).max(50).optional(), // omitted = human picks
      })
      .optional(),
    timeoutSec: z.number().int().min(5).max(600).default(120),
    open: z.enum(['same-tab', 'new-tab', 'none']).default('same-tab'),
  }),
  z.object({ ...Base, kind: z.literal('instruction') }),
  z
    .object({
      ...Base,
      kind: z.literal('capture'),
      var: KEY,
      selector: SELECTOR.optional(),
      attribute: z.string().max(100).optional(), // default: textContent / value
      textPattern: z.string().max(300).optional(), // regex; group 1 (or whole match) is the value
      required: z.boolean().default(true),
    })
    .refine((s) => s.selector || s.textPattern, { message: 'capture needs selector or textPattern', path: ['selector'] }),
  z.object({
    ...Base,
    kind: z.literal('check'),
    expect: z.string().min(1).max(1000),
    assert: z
      .object({ textPresent: TEMPLATE.optional(), selector: SELECTOR.optional(), urlMatches: z.string().max(300).optional() })
      .optional(),
  }),
]);
/** Walkthrough recording: off, dom (rrweb DOM recording), video (reserved: recorded as dom for now). */
export const RECORD_MODES = ['off', 'dom', 'video'] as const;
export type RecordMode = (typeof RECORD_MODES)[number];
/** How a walkthrough runs: tracked (evidence + sign-off, kept in history) or quick (same steps, nothing kept). */
export const RUN_MODES = ['tracked', 'quick'] as const;

export const Storyboard = z.object({
  slug: SLUG,
  name: z.string().min(1).max(150),
  description: z.string().max(4000).default(''),
  intent: z.string().max(1000).default(''),
  tags: z.array(z.string().max(40)).max(20).default([]),
  inputs: z.array(Input).max(20).default([]),
  actors: z.array(Actor).min(1).max(10),
  steps: z.array(Step).min(1).max(150),
  preferredMode: z.enum(['quick', 'tracked']).default('tracked'), // hint: which start button the extension shows first
  // Walkthrough recording (migration 27): 'dom' records the app pages of tracked runs with rrweb; 'video' is reserved
  // for a later release and records the DOM for now. A run can override it at start (StartWalkthroughInput.record).
  record: z.enum(RECORD_MODES).default('off'),
  recordMaskAllInputs: z.boolean().default(false), // mask every input value in recordings (passwords and codes always are)
});
export const UserSpec = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(100),
  role: ROLE,
  phone: z.string().optional(),
  password: z.string().optional(),
  notes: z.string().optional(),
});
export const Bundle = z.object({
  format: z.literal('stubyard-storyboards'),
  version: z.literal(1),
  project: z
    .object({ appOrigins: z.array(z.string()).optional(), roles: z.array(ROLE).optional(), defaultPassword: z.string().optional() })
    .optional(),
  users: z.array(UserSpec).default([]),
  loginRecipes: z.array(LoginRecipe).default([]),
  dataSets: z.array(DataSet).default([]),
  storyboards: z.array(Storyboard).default([]),
});
export const ScannedField = z.object({
  key: z.string(),
  id: z.string().nullable(),
  name: z.string().nullable(),
  testId: z.string().nullable(),
  kind: z.enum(FIELD_KINDS),
  inputType: z.string().nullable(),
  label: z.string().nullable(),
  placeholder: z.string().nullable(),
  value: z.union([z.string(), z.boolean(), z.array(z.string())]).nullable(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).max(400).optional(),
  required: z.boolean(),
  visible: z.boolean(),
  formId: z.string().nullable(),
  duplicateKey: z.boolean().default(false),
});
export const PageSnapshot = z.object({
  url: z.string().url(),
  urlPattern: z.string().default(''),
  title: z.string().default(''),
  formId: z.string().nullable().default(null),
  fields: z.array(ScannedField).max(500),
  note: z.string().max(2000).default(''),
  source: z.enum(['extension', 'agent']).default('agent'),
});

/** Enumerations shown by GET /api/storyboard-schema and the MCP ontology. */
export const WALKTHROUGH_STATUSES = ['active', 'finished', 'abandoned'] as const;
export const STEP_STATUSES = ['pending', 'active', 'done', 'skipped', 'failed'] as const;
export const VERDICTS = ['pass', 'fail', 'partial'] as const;

/** The schemas published as JSON Schema (GET /api/storyboard-schema, describe_storyboards). */
export const STORYBOARD_SCHEMAS = { LoginRecipe, DataEntry, DataSet, Actor, Step, Storyboard, Bundle, PageSnapshot } as const;

// Parsed (output) types: what the server stores and returns. *Input types: what a client may send (defaults optional).
export type LoginRecipe = z.infer<typeof LoginRecipe>;
export type LoginRecipeInput = z.input<typeof LoginRecipe>;
export type TwoFactor = LoginRecipe['twoFactor'];
export type FieldKind = (typeof FIELD_KINDS)[number];
export type DataEntry = z.infer<typeof DataEntry>;
export type DataEntryInput = z.input<typeof DataEntry>;
export type DataSet = z.infer<typeof DataSet>;
export type DataSetInput = z.input<typeof DataSet>;
export type Actor = z.infer<typeof Actor>;
export type Input = z.infer<typeof Input>;
export type StepKind = (typeof STEP_KINDS)[number];
export type Step = z.infer<typeof Step>;
export type StepInput = z.input<typeof Step>;
export type StepOf<K extends StepKind> = Extract<Step, { kind: K }>;
export type Storyboard = z.infer<typeof Storyboard>;
export type StoryboardInput = z.input<typeof Storyboard>;
export type UserSpec = z.infer<typeof UserSpec>;
export type Bundle = z.infer<typeof Bundle>;
export type BundleInput = z.input<typeof Bundle>;
export type ScannedField = z.infer<typeof ScannedField>;
export type PageSnapshot = z.infer<typeof PageSnapshot>;
export type PageSnapshotInput = z.input<typeof PageSnapshot>;
export type WalkthroughStatus = (typeof WALKTHROUGH_STATUSES)[number];
export type StepStatus = (typeof STEP_STATUSES)[number];
export type Verdict = (typeof VERDICTS)[number];
export type RunMode = (typeof RUN_MODES)[number];
