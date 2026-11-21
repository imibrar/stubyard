/**
 * Hand-written mirror of the stubyard Storyboards contract (server/src/storyboards/schema.ts and types.ts;
 * docs/design/storyboards.md §1.3 and §3). No import from the server: this package is browser-safe and stand-alone.
 * Parsed types (`Storyboard`, `DataSet` …) are what the hub returns; `*Input` types are what a client may send
 * (fields with a server default are optional).
 */

export type Channel = 'email' | 'sms' | 'whatsapp';

// ---------------------------------------------------------------------------------------------------------------
// Users and messages (existing routes)

export interface HubUser {
  id: string;
  projectId: string;
  name: string;
  role: string;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  marketingOptOut: boolean;
  notes: string;
  pinned: number;
  /** The effective password (user password, else the project default). */
  password: string;
  runId: string | null;
  createdAt: string;
  [k: string]: unknown;
}

export interface HubMessage {
  id: string;
  projectId: string;
  testUserId: string | null;
  providerInstanceId: string | null;
  channel: Channel;
  direction: 'outbound' | 'inbound';
  from: string | null;
  to: string;
  subject: string | null;
  bodyText: string | null;
  hasHtml: boolean;
  attachments: number;
  mailpitId: string | null;
  status: string;
  otp: string | null;
  links: string[];
  metadata: Record<string, unknown>;
  runId: string | null;
  readAt: string | null;
  createdAt: string;
  /** Set by /messages/wait: the newest message id the answer covers. */
  cursor?: string;
  /** Set by GET /api/messages/:id for email: paths of the rendered views. */
  mailpit?: { html: string; text: string; raw: string; detail: string; part: string } | null;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------------------------------------------
// Enumerations

export const STEP_KINDS = ['open', 'login', 'logout', 'fill', 'email', 'instruction', 'capture', 'check'] as const;
export const FIELD_KINDS = ['auto', 'text', 'select', 'radio', 'checkbox', 'radix-select', 'radix-checkbox', 'radix-radio', 'date', 'otp', 'skip'] as const;
export const TWO_FACTOR_KINDS = ['none', 'totp', 'email-otp', 'sms-otp'] as const;
export const WALKTHROUGH_STATUSES = ['active', 'finished', 'abandoned'] as const;
export const STEP_STATUSES = ['pending', 'active', 'done', 'skipped', 'failed'] as const;
export const VERDICTS = ['pass', 'fail', 'partial'] as const;
/** tracked: per-step evidence and a sign-off, kept in history. quick: same steps, nothing kept, deleted after 24 h. */
export const RUN_MODES = ['tracked', 'quick'] as const;

export type StepKind = (typeof STEP_KINDS)[number];
export type FieldKind = (typeof FIELD_KINDS)[number];
export type WalkthroughStatus = (typeof WALKTHROUGH_STATUSES)[number];
export type StepStatus = (typeof STEP_STATUSES)[number];
export type Verdict = (typeof VERDICTS)[number];
export type RunMode = (typeof RUN_MODES)[number];

// ---------------------------------------------------------------------------------------------------------------
// Authoring objects (§1.3)

export type TwoFactor =
  | { kind: 'none' }
  | { kind: 'totp'; selector: string; authenticator?: string }
  | { kind: 'email-otp' | 'sms-otp'; selector: string; subject?: string };

export interface LoginRecipe {
  role: string;
  name: string;
  /** Absolute, or "/path" (resolved against the walkthrough origin). */
  loginUrl: string;
  fields: { username: string; password: string; submit?: string };
  twoFactor: TwoFactor;
  logoutUrl: string | null;
  notes: string;
}

export interface LoginRecipeInput {
  role: string;
  name?: string;
  loginUrl: string;
  fields?: { username?: string; password?: string; submit?: string };
  twoFactor?: { kind: 'none' } | { kind: 'totp'; selector?: string; authenticator?: string } | { kind: 'email-otp' | 'sms-otp'; selector: string; subject?: string };
  logoutUrl?: string | null;
  notes?: string;
}

export interface DataEntry {
  /** Element id, name, data-testid, label text or placeholder. */
  key: string;
  value: string | boolean | string[];
  kind: FieldKind;
  selector?: string;
  label?: string;
  note?: string;
}

export type DataEntryInput = Omit<DataEntry, 'kind'> & { kind?: FieldKind };

export interface DataSetMatch {
  urlPattern?: string;
  formId?: string;
}

export interface DataSet {
  slug: string;
  name: string;
  description: string;
  match: DataSetMatch;
  entries: DataEntry[];
}

export interface DataSetInput {
  slug: string;
  name: string;
  description?: string;
  match?: DataSetMatch;
  entries: DataEntryInput[];
}

export interface Actor {
  key: string;
  label: string;
  role: string;
  user?: string;
  fresh: boolean;
  name?: string;
}

export type ActorInput = Omit<Actor, 'label' | 'fresh'> & { label?: string; fresh?: boolean };

export interface Input {
  name: string;
  label: string;
  required: boolean;
  default?: string;
  help?: string;
}

export type InputInput = Omit<Input, 'required'> & { required?: boolean };

interface StepBase {
  id?: string;
  title: string;
  intent: string;
  actor?: string;
  notes: string;
  optional: boolean;
  screenshot: 'off' | 'offer' | 'required';
  target?: { selector?: string; text?: string };
}

export type Step =
  | (StepBase & { kind: 'open'; url: string })
  | (StepBase & { kind: 'login'; actor: string; recipe?: string; url?: string })
  | (StepBase & { kind: 'logout'; url?: string })
  | (StepBase & { kind: 'fill'; dataSet: string; url?: string; formId?: string })
  | (StepBase & {
      kind: 'email';
      actor: string;
      channel: Channel;
      match: { subject?: string; text?: string };
      link?: { pattern?: string; index?: number };
      timeoutSec: number;
      open: 'same-tab' | 'new-tab' | 'none';
    })
  | (StepBase & { kind: 'instruction' })
  | (StepBase & { kind: 'capture'; var: string; selector?: string; attribute?: string; textPattern?: string; required: boolean })
  | (StepBase & { kind: 'check'; expect: string; assert?: { textPresent?: string; selector?: string; urlMatches?: string } });

export type StepOf<K extends StepKind> = Extract<Step, { kind: K }>;

/** Step fields the hub fills with a default. */
type StepDefaults = 'notes' | 'optional' | 'screenshot' | 'channel' | 'match' | 'timeoutSec' | 'open' | 'required';
type LooseStep<S> = S extends unknown ? Omit<S, Extract<keyof S, StepDefaults>> & Partial<Pick<S, Extract<keyof S, StepDefaults>>> : never;
/** A step as a client may send it (defaulted fields optional). */
export type StepInput = LooseStep<Step>;

export interface Storyboard {
  slug: string;
  name: string;
  description: string;
  intent: string;
  tags: string[];
  inputs: Input[];
  actors: Actor[];
  steps: Step[];
  /** Which start button the extension shows first (a hint). */
  preferredMode: RunMode;
}

export interface StoryboardInput {
  slug: string;
  name: string;
  description?: string;
  intent?: string;
  tags?: string[];
  inputs?: InputInput[];
  actors: ActorInput[];
  steps: StepInput[];
  preferredMode?: RunMode;
}

export interface UserSpec {
  email: string;
  name: string;
  role: string;
  phone?: string;
  password?: string;
  notes?: string;
}

export interface StoryboardBundle {
  format: 'stubyard-storyboards';
  version: 1;
  project?: { appOrigins?: string[]; roles?: string[]; defaultPassword?: string };
  users?: UserSpec[];
  loginRecipes?: LoginRecipeInput[];
  dataSets?: DataSetInput[];
  storyboards?: StoryboardInput[];
}

export interface ScannedField {
  key: string;
  id: string | null;
  name: string | null;
  testId: string | null;
  kind: FieldKind;
  inputType: string | null;
  label: string | null;
  placeholder: string | null;
  value: string | boolean | string[] | null;
  options?: { value: string; label: string }[];
  required: boolean;
  visible: boolean;
  formId: string | null;
  duplicateKey: boolean;
}

export interface PageSnapshot {
  url: string;
  urlPattern: string;
  title: string;
  formId: string | null;
  fields: ScannedField[];
  note: string;
  source: 'extension' | 'agent';
}

export interface PageSnapshotInput {
  url: string;
  urlPattern?: string;
  title?: string;
  formId?: string | null;
  fields: (Omit<ScannedField, 'duplicateKey'> & { duplicateKey?: boolean })[];
  note?: string;
  source?: 'extension' | 'agent';
}

// ---------------------------------------------------------------------------------------------------------------
// Validation (§1.4)

export type ValidationCode =
  | 'schema'
  | 'duplicate_step_id'
  | 'unknown_actor'
  | 'missing_data_set'
  | 'missing_login_recipe'
  | 'unknown_role'
  | 'missing_user'
  | 'unknown_variable'
  | 'var_not_captured'
  | 'var_used_before_capture'
  | 'missing_authenticator'
  | 'no_password'
  | 'relative_url_no_origin'
  | 'no_app_origins';

export interface ValidationIssue {
  /** "steps[3].url", "loginRecipes[admin].twoFactor.authenticator"; bundle imports prefix "storyboards[0]." */
  path: string;
  code: ValidationCode;
  message: string;
  expected?: string[];
}

export interface StoryboardRefs {
  dataSets: string[];
  roles: string[];
  vars: { captured: string[]; inputs: string[] };
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  refs: StoryboardRefs;
}

// ---------------------------------------------------------------------------------------------------------------
// Authoring views (§3.2 – §3.6)

export interface ServerFields {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export type LoginRecipeView = LoginRecipe & ServerFields & { users: number };

export type DataSetView = DataSet & ServerFields & { usedBy: string[]; matchScore?: number };

/** A data-set entry with its value rendered for one actor / walkthrough. */
export interface RenderedEntry {
  key: string;
  value: string | boolean | string[];
  kind: FieldKind;
  selector?: string;
  label?: string;
}

/** A stored step: the id is always set. */
export type StoredStep = Step & { id: string };

export type StoryboardView = Omit<Storyboard, 'steps'> &
  ServerFields & { steps: StoredStep[]; version: number; refs: StoryboardRefs; warnings: ValidationIssue[] };

export interface StoryboardBrief {
  id: string;
  slug: string;
  name: string;
  description: string;
  tags: string[];
  preferredMode: RunMode;
  version: number;
  steps: number;
  actors: { key: string; role: string; fresh: boolean }[];
  updatedAt: string;
  /** The newest tracked walkthrough (quick test runs are ignored). */
  lastWalkthrough?: { id: string; status: WalkthroughStatus; verdict: Verdict | null; startedAt: string };
}

export type PageSnapshotView = PageSnapshot & { id: string; createdAt: string };

export interface PageSnapshotBrief {
  id: string;
  url: string;
  urlPattern: string;
  title: string;
  formId: string | null;
  fields: number;
  source: PageSnapshot['source'];
  createdAt: string;
}

export type ImportMode = 'upsert' | 'create-only' | 'replace';
export interface BundleCollections {
  users: string[];
  loginRecipes: string[];
  dataSets: string[];
  storyboards: string[];
}

/** POST /storyboards/import (200). The lists hold the keys: user email, recipe role, data-set / storyboard slug. */
export interface ImportResult {
  ok: true;
  dryRun: boolean;
  created: BundleCollections;
  updated: BundleCollections;
  unchanged: BundleCollections;
  skipped: { path: string; reason: string }[];
  warnings: ValidationIssue[];
}

export interface OriginMatch {
  origin: string;
  projects: { slug: string; name: string; storyboards: number }[];
}

// ---------------------------------------------------------------------------------------------------------------
// Walkthroughs (§3.7)

export interface WalkthroughActor {
  userId: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: string;
  password: string;
  created: boolean;
  /** The user was deleted after the start. */
  missing?: true;
}

export type WalkthroughStepView = StoredStep & {
  position: number;
  status: StepStatus;
  note: string;
  data: Record<string, unknown>;
  startedAt: string | null;
  finishedAt: string | null;
  shots: { id: string; bytes: number; createdAt: string }[];
};

export type StepCounts = Record<StepStatus, number>;

export interface WalkthroughSignoff {
  verdict: Verdict | null;
  signedOffBy: string | null;
  signedOffAt: string | null;
  note: string;
}

export interface WalkthroughView {
  id: string;
  key: string;
  label: string;
  status: WalkthroughStatus;
  mode: RunMode;
  executor: 'human';
  origin: string;
  storyboard: { id: string | null; slug: string; name: string; version: number };
  inputs: Input[];
  actors: Record<string, WalkthroughActor>;
  vars: Record<string, string>;
  currentStepId: string | null;
  steps: WalkthroughStepView[];
  counts: StepCounts;
  signoff: WalkthroughSignoff;
  startedAt: string;
  finishedAt: string | null;
  updatedAt: string;
  warnings: string[];
}

export interface WalkthroughBrief {
  id: string;
  key: string;
  label: string;
  status: WalkthroughStatus;
  mode: RunMode;
  storyboard: { id: string | null; slug: string; name: string; version: number };
  verdict: Verdict | null;
  counts: StepCounts;
  startedAt: string;
  finishedAt: string | null;
  updatedAt: string;
}

export type ResolvedTwoFactor =
  | { kind: 'none' }
  | { kind: 'totp'; selector: string; codePath: string; label: string }
  | { kind: 'email-otp' | 'sms-otp'; selector: string; waitPath: string };

interface ResolvedBase<K extends StepKind> {
  step: Extract<StoredStep, { kind: K }>;
  actor: { key: string; userId: string; name: string; email: string | null; role: string } | null;
  url: string | null;
  warnings: string[];
  /** title / intent / expect (check) / notes rendered for display; variables without a value render as ''. */
  text: ResolvedText;
}

export interface ResolvedText {
  title?: string;
  intent: string;
  expect?: string;
  notes?: string;
}

/** POST /walkthroughs/:id/steps/:stepId/resolve. Narrow on `step.kind`. */
export type ResolvedStep =
  | ResolvedBase<'open'>
  | (ResolvedBase<'login'> & {
      username: string;
      password: string;
      selectors: { username: string; password: string; submit?: string };
      twoFactor: ResolvedTwoFactor;
    })
  | ResolvedBase<'logout'>
  | (ResolvedBase<'fill'> & {
      dataSet: { slug: string; name: string; match: DataSetMatch };
      formId: string | null;
      entries: RenderedEntry[];
    })
  | (ResolvedBase<'email'> & {
      channel: Channel;
      user: { id: string; email: string | null; phone: string | null };
      waitPath: string;
      subject: string | null;
      linkPattern: string | null;
      linkIndex: number | null;
      open: 'same-tab' | 'new-tab' | 'none';
    })
  | (ResolvedBase<'capture'> & {
      var: string;
      selector: string | null;
      attribute: string | null;
      textPattern: string | null;
      required: boolean;
    })
  | (ResolvedBase<'check'> & {
      expect: string;
      assert: { textPresent: string | null; selector: string | null; urlMatches: string | null } | null;
    })
  | ResolvedBase<'instruction'>;

export interface WalkthroughSummary {
  walkthrough: WalkthroughBrief;
  steps: { id: string; title: string; kind: StepKind; status: StepStatus; note: string; data: Record<string, unknown>; shots: number }[];
  vars: Record<string, string>;
  actors: Record<string, WalkthroughActor>;
  signoff: WalkthroughSignoff;
  durationMs: number;
}
