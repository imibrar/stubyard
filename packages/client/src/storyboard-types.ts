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
  /** Keep pin: a shared fixture that walkthrough cleanup never deletes. */
  keep: boolean;
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
/** tracked: per-step evidence and a sign-off, kept in history. quick: same steps, nothing kept, hidden from history. */
export const RUN_MODES = ['tracked', 'quick'] as const;
/** Walkthrough recording: off, dom (rrweb DOM recording by the extension), video (a video of the tab, R2). */
export const RECORD_MODES = ['off', 'dom', 'video'] as const;

export type StepKind = (typeof STEP_KINDS)[number];
export type FieldKind = (typeof FIELD_KINDS)[number];
export type WalkthroughStatus = (typeof WALKTHROUGH_STATUSES)[number];
export type StepStatus = (typeof STEP_STATUSES)[number];
export type Verdict = (typeof VERDICTS)[number];
export type RunMode = (typeof RUN_MODES)[number];
export type RecordMode = (typeof RECORD_MODES)[number];

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
      /** Id of an earlier step: the message window starts where that step started (default: the previous step). */
      since?: string;
    })
  | (StepBase & { kind: 'instruction' })
  | (StepBase & { kind: 'capture'; var: string; selector?: string; attribute?: string; textPattern?: string; required: boolean; secret?: boolean })
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
  /** Record tracked runs of it (DOM recording by the extension); default off. */
  record: RecordMode;
  /** Strict masking in recordings: every input value and all page text (inputs are masked by default anyway). */
  recordMaskAllInputs: boolean;
  /** Selector lists for recordings (set only when one is not empty). */
  recordPrivacy?: RecordPrivacy;
}

/** Recording privacy lists of a storyboard (CSS selectors, at most 50 each). */
export interface RecordPrivacy {
  /** Inputs shown in clear in DOM recordings (never ones that look like passwords, codes, cards or keys). */
  unmaskSelectors: string[];
  /** More sensitive inputs: always masked, shown as dots while video records. */
  maskSelectors: string[];
  /** Elements whose text is masked. */
  maskTextSelectors: string[];
  /** Elements left out of DOM recordings. */
  blockSelectors: string[];
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
  record?: RecordMode;
  recordMaskAllInputs?: boolean;
  recordPrivacy?: Partial<RecordPrivacy>;
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
  | 'invalid_since'
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
  /** Vars whose values are secret (capture.secret, or a secret-looking name / value): displays mask them. */
  secretVars: string[];
  currentStepId: string | null;
  steps: WalkthroughStepView[];
  counts: StepCounts;
  signoff: WalkthroughSignoff;
  startedAt: string;
  finishedAt: string | null;
  updatedAt: string;
  /** Test data this run created: none | pending | cleaned | dismissed. */
  cleanupStatus: CleanupStatus;
  cleanupAt: string | null;
  /** Recording of the run's app pages by the extension. Missing from hubs before 0.15. */
  recording?: RecordingInfo;
  warnings: string[];
}

/** WalkthroughView.recording. */
export interface RecordingInfo {
  /** What the extension does now: off, dom (record the run's app pages with rrweb) or video (record the tab). */
  mode: 'off' | 'dom' | 'video';
  /** What was asked for at start. */
  requested: RecordMode;
  /** Strict masking: every input value and all page text. */
  maskAllInputs: boolean;
  /** Same as maskAllInputs (hubs from 0.15 with the privacy fixes). */
  maskAllText?: boolean;
  paused: boolean;
  pausedAt?: string | null;
  /** Why recording stopped by itself (the size cap), else null. */
  stopped: string | null;
  stoppedAt: string | null;
  /** Inputs that are sensitive (masked even when unmasked; dots while video records): defaults, storyboard, login fields. */
  maskSelectors: string[];
  /** DOM recordings mask every input; these are shown in clear unless they look sensitive. Missing on older hubs. */
  unmaskSelectors?: string[];
  /** Elements whose text is masked, besides contenteditable ones. */
  maskTextSelectors?: string[];
  /** Elements left out of DOM recordings (the widget and hidden inputs always are). */
  blockSelectors?: string[];
  segmentCount: number;
  /** Compressed bytes stored. */
  bytes: number;
  /** The per-walkthrough cap (project setting recordingMaxMb, default 50 MB). */
  maxBytes: number;
}

export type RecordingSegmentStatus = 'recording' | 'complete' | 'cut';

/** One recorded page load (or a resume after a pause). */
export interface RecordingSegment {
  no: number;
  id: string;
  stepId: string | null;
  url: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  bytes: number;
  /** Uncompressed bytes (missing on older hubs). */
  rawBytes?: number;
  /** rrweb events (dom) or WebM chunks (video). */
  events: number;
  status: RecordingSegmentStatus;
  /** dom: rrweb events (NDJSON); video: a WebM file (GET …/segments/:no, with Range support). Missing before R2: dom. */
  kind?: 'dom' | 'video';
  /** video: the MediaRecorder mime type. */
  mime?: string;
  /** video: step changes as offsets into the video (ms). */
  markers?: { at: number; stepId: string }[];
}

/** GET …/walkthroughs/:id/recording. */
export interface RecordingList extends RecordingInfo {
  walkthrough: { id: string; key: string; status: WalkthroughStatus };
  segments: RecordingSegment[];
}

/** POST …/walkthroughs/:id/recording/chunks (the extension's service worker sends these). */
export interface RecordingChunk {
  segment: { key: string; url?: string; startedAt?: string; stepId?: string | null };
  seq: number;
  /** rrweb events ({type, data, timestamp}). */
  events: unknown[];
  final?: boolean;
}

export interface RecordingChunkResult {
  segment: number;
  seq: number;
  /** false: nothing was stored (a retry of a stored seq, a heartbeat, or events after a pause). */
  stored: boolean;
  bytes: number;
  maxBytes: number;
  state: { mode: 'off' | 'dom' | 'video'; paused: boolean; stopped: string | null; currentStepId: string | null; status: WalkthroughStatus };
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
  cleanupStatus: CleanupStatus;
  cleanupAt: string | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Cleanup of the test data walkthroughs create (fresh users and their messages; quick runs' records)

/** none: nothing created. pending: data to clean. cleaned: removed (or Keep-pinned). dismissed: left in place on purpose. */
export type CleanupStatus = 'none' | 'pending' | 'cleaned' | 'dismissed';

export interface CleanupRunRef {
  id: string;
  key: string;
  label: string;
  status: WalkthroughStatus;
  mode: RunMode;
  storyboard: { slug: string; name: string } | null;
}

export interface CleanupUser {
  userId: string;
  name: string;
  email: string | null;
  role: string;
  /** false = already deleted (nothing to do). */
  exists: boolean;
  /** Keep pin: never deleted by cleanup. */
  keep: boolean;
  /** Messages in this user's inbox. */
  messages: number;
  /** Other runs that still need this user. */
  usedBy: CleanupRunRef[];
}

export interface CleanupItem {
  walkthrough: CleanupRunRef & { cleanupStatus: CleanupStatus; cleanupAt: string | null; startedAt: string; finishedAt: string | null };
  /** Its fresh users. */
  users: CleanupUser[];
  /** Captured values: information only, not removed by stubyard. */
  vars: Record<string, string>;
  /** Names of the vars that are secret: displays mask them. */
  secretVars: string[];
  /** Runs whose data this run reused. */
  uses: CleanupRunRef[];
  /** What a cleanup with defaults would remove now. */
  removable: { users: number; messages: number; record: boolean };
  warnings: string[];
  lastReport: CleanupRunResult | null;
}

export interface CleanupList {
  items: CleanupItem[];
  /** active: active runs with pending data (never in items). */
  counts: { pending: number; active: number; cleaned: number; dismissed: number };
  /** true when the 500-item cap cut the list. */
  truncated?: boolean;
}

export interface CleanupKept {
  userId: string;
  email: string | null;
  reason: 'keep' | 'skipped' | 'used-by' | 'used-by-active';
  usedBy?: CleanupRunRef[];
}

export interface CleanupRunResult {
  id: string;
  key: string;
  label: string;
  mode: RunMode;
  status: 'cleaned' | 'partial';
  removed: { users: number; messages: number; record: boolean };
  kept: CleanupKept[];
  vars: Record<string, string>;
}

export interface CleanupConflict {
  userId: string;
  email: string | null;
  walkthrough: CleanupRunRef;
  usedBy: CleanupRunRef[];
}

export interface CleanupResult {
  dryRun: boolean;
  runs: CleanupRunResult[];
  /** Only non-empty in a dryRun, or on the 409 body. */
  conflicts: CleanupConflict[];
  totals: { users: number; messages: number; records: number };
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
  /** step.target with its {{…}} rendered (hub 0.15+; older hubs leave it out: use step.target then). */
  target?: { selector: string | null; text: string | null } | null;
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
