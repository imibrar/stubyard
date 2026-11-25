/** Types and helpers of the Storyboards API (/api/projects/:slug/{storyboards,data-sets,login-recipes,page-snapshots,walkthroughs}; docs/design/storyboards.md §1.3, §3). */
import { api, ApiError, qs } from './api';

export const STEP_KINDS = ['open', 'login', 'logout', 'fill', 'email', 'instruction', 'capture', 'check'] as const;
export type StepKind = (typeof STEP_KINDS)[number];
export const FIELD_KINDS = ['auto', 'text', 'select', 'radio', 'checkbox', 'radix-select', 'radix-checkbox', 'radix-radio', 'date', 'otp', 'skip'] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];
export const TWO_FACTOR_KINDS = ['none', 'totp', 'email-otp', 'sms-otp'] as const;
export type TwoFactorKind = (typeof TWO_FACTOR_KINDS)[number];
export type WalkthroughStatus = 'active' | 'finished' | 'abandoned';
export type StepStatus = 'pending' | 'active' | 'done' | 'skipped' | 'failed';
export type Verdict = 'pass' | 'fail' | 'partial';
/** tracked: per-step evidence and a sign-off, kept in history. quick: same steps, no evidence; removed when you clean up its test data. */
export type RunMode = 'tracked' | 'quick';
export type RecordMode = 'off' | 'dom' | 'video';

// ---------- authoring shapes (input side of the zod schemas) ----------

export interface LoginRecipe {
  role: string;
  name?: string;
  loginUrl: string;
  fields?: { username?: string; password?: string; submit?: string };
  twoFactor?: { kind: TwoFactorKind; selector?: string; authenticator?: string; subject?: string };
  logoutUrl?: string | null;
  notes?: string;
}

export interface DataEntry {
  key: string;
  value: string | boolean | string[];
  kind?: FieldKind;
  selector?: string;
  label?: string;
  note?: string;
}

export interface DataSet {
  slug: string;
  name: string;
  description?: string;
  match?: { urlPattern?: string; formId?: string };
  entries: DataEntry[];
}

export interface Actor {
  key: string;
  label?: string;
  role: string;
  user?: string;
  fresh?: boolean;
  name?: string;
}

export interface Input {
  name: string;
  label: string;
  required?: boolean;
  default?: string;
  help?: string;
}

/** One step, loosely typed: the base fields plus every kind-specific field (the server validates the union). */
export interface Step {
  id?: string;
  kind: StepKind;
  title: string;
  intent: string;
  actor?: string;
  notes?: string;
  optional?: boolean;
  screenshot?: 'off' | 'offer' | 'required';
  target?: { selector?: string; text?: string };
  url?: string;
  recipe?: string;
  dataSet?: string;
  formId?: string;
  channel?: 'email' | 'sms' | 'whatsapp';
  match?: { subject?: string; text?: string };
  link?: { pattern?: string; index?: number };
  timeoutSec?: number;
  open?: 'same-tab' | 'new-tab' | 'none';
  since?: string;
  var?: string;
  selector?: string;
  attribute?: string;
  textPattern?: string;
  required?: boolean;
  secret?: boolean;
  expect?: string;
  assert?: { textPresent?: string; selector?: string; urlMatches?: string };
}

export interface Storyboard {
  slug: string;
  name: string;
  description?: string;
  intent?: string;
  tags?: string[];
  inputs?: Input[];
  actors: Actor[];
  steps: Step[];
  /** Which start button the extension shows first; default tracked. */
  preferredMode?: RunMode;
  /** Record tracked runs: 'dom' (rrweb DOM recording by the extension) or 'video' (a video of the tab). Default off. */
  record?: RecordMode;
  /** Strict masking in recordings: every input value and all page text (inputs are masked by default anyway). */
  recordMaskAllInputs?: boolean;
  /** Selector lists for recordings (unmask / mask inputs, mask text, block elements). */
  recordPrivacy?: Partial<RecordPrivacy>;
}

export interface RecordPrivacy {
  unmaskSelectors: string[];
  maskSelectors: string[];
  maskTextSelectors: string[];
  blockSelectors: string[];
}

export interface UserSpec {
  email: string;
  name: string;
  role: string;
  phone?: string;
  password?: string;
  notes?: string;
}

export interface Bundle {
  format: 'stubyard-storyboards';
  version: 1;
  project?: { appOrigins?: string[]; roles?: string[]; defaultPassword?: string };
  users?: UserSpec[];
  loginRecipes?: LoginRecipe[];
  dataSets?: DataSet[];
  storyboards?: Storyboard[];
}

// ---------- views ----------

export interface ServerFields {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface ValidationIssue {
  path: string;
  code: string;
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

export type LoginRecipeView = LoginRecipe & ServerFields & { users: number };
export type DataSetView = DataSet & ServerFields & { usedBy: string[]; matchScore?: number };
export type StoryboardView = Storyboard & ServerFields & { steps: (Step & { id: string })[]; version: number; refs: StoryboardRefs; warnings: ValidationIssue[] };

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
  lastWalkthrough?: { id: string; status: WalkthroughStatus; verdict: Verdict | null; startedAt: string };
}

export interface RenderedEntry {
  key: string;
  value: string | boolean | string[];
  kind: FieldKind;
  selector?: string;
  label?: string;
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

export interface PageSnapshotBrief {
  id: string;
  url: string;
  urlPattern: string;
  title: string;
  formId: string | null;
  fields: number;
  source: 'extension' | 'agent';
  createdAt: string;
}

export interface PageSnapshotView {
  id: string;
  url: string;
  urlPattern: string;
  title: string;
  formId: string | null;
  fields: ScannedField[];
  note: string;
  source: 'extension' | 'agent';
  createdAt: string;
}

type Collections = { users: string[]; loginRecipes: string[]; dataSets: string[]; storyboards: string[] };
export type ImportMode = 'upsert' | 'create-only' | 'replace';
export interface ImportResult {
  ok: true;
  dryRun: boolean;
  created: Collections;
  updated: Collections;
  unchanged: Collections;
  skipped: { path: string; reason: string }[];
  warnings: ValidationIssue[];
}

export interface WalkthroughActor {
  userId: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: string;
  password: string;
  created: boolean;
  missing?: true;
}

export type WalkthroughStep = Step & {
  id: string;
  position: number;
  status: StepStatus;
  note: string;
  data: Record<string, unknown>;
  startedAt: string | null;
  finishedAt: string | null;
  shots: { id: string; bytes: number; createdAt: string }[];
};

export type StepCounts = Record<StepStatus, number>;

/** Who runs a walkthrough: a tester with the extension, or an agent in its own browser (MCP start_walkthrough). */
export type WalkthroughExecutor = 'human' | 'agent';
export interface WalkthroughRunner {
  name: string;
  version: string | null;
}

export interface WalkthroughBrief {
  id: string;
  key: string;
  label: string;
  status: WalkthroughStatus;
  mode: RunMode;
  executor?: WalkthroughExecutor;
  runner?: WalkthroughRunner | null;
  storyboard: { id: string | null; slug: string; name: string; version: number };
  verdict: Verdict | null;
  counts: StepCounts;
  startedAt: string;
  finishedAt: string | null;
  updatedAt: string;
  cleanupStatus: CleanupStatus;
  cleanupAt: string | null;
}

export interface WalkthroughView {
  id: string;
  key: string;
  label: string;
  status: WalkthroughStatus;
  mode: RunMode;
  executor: WalkthroughExecutor;
  runner?: WalkthroughRunner | null;
  origin: string;
  storyboard: { id: string | null; slug: string; name: string; version: number };
  inputs: Input[];
  actors: Record<string, WalkthroughActor>;
  vars: Record<string, string>;
  /** Vars whose values are secret (capture.secret, or a secret-looking name / value): displays mask them. */
  secretVars: string[];
  currentStepId: string | null;
  steps: WalkthroughStep[];
  counts: StepCounts;
  /** verdictBy 'agent': an agent finished the run; signedOffBy stays null until a person signs it off. */
  signoff: { verdict: Verdict | null; verdictBy?: 'human' | 'agent' | null; signedOffBy: string | null; signedOffAt: string | null; note: string };
  startedAt: string;
  finishedAt: string | null;
  updatedAt: string;
  warnings: string[];
  cleanupStatus: CleanupStatus;
  cleanupAt: string | null;
  /** Walkthrough recording (missing on hubs before 0.15). */
  recording?: RecordingInfo;
}

// ---------- recording (walkthrough recording R1: rrweb DOM recordings the extension uploads) ----------

export interface RecordingInfo {
  mode: 'off' | 'dom' | 'video';
  requested: RecordMode;
  /** Strict masking: every input value and all page text. */
  maskAllInputs: boolean;
  maskAllText?: boolean;
  paused: boolean;
  pausedAt?: string | null;
  stopped: string | null;
  stoppedAt: string | null;
  maskSelectors: string[];
  unmaskSelectors?: string[];
  maskTextSelectors?: string[];
  blockSelectors?: string[];
  segmentCount: number;
  bytes: number;
  maxBytes: number;
}

export type RecordingSegmentStatus = 'recording' | 'complete' | 'cut';

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
  events: number;
  status: RecordingSegmentStatus;
  /** dom (rrweb NDJSON) or video (a WebM file); missing before R2: dom. */
  kind?: 'dom' | 'video';
  mime?: string;
  /** video: step changes as offsets into the video (ms). */
  markers?: { at: number; stepId: string }[];
}

export interface RecordingList extends RecordingInfo {
  walkthrough: { id: string; key: string; status: WalkthroughStatus };
  segments: RecordingSegment[];
}

// ---------- cleanup (docs/design/storyboards.md, cleanup section) ----------

/** none: nothing created · pending: test data to clean · cleaned: done · dismissed: the user chose to leave it. */
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

export type CleanupKeptReason = 'keep' | 'skipped' | 'used-by' | 'used-by-active';
export interface CleanupKept {
  userId: string;
  email: string | null;
  reason: CleanupKeptReason;
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

export type CleanupOnConflict = 'ask' | 'keep' | 'include';
export interface CleanupRequest {
  /** 1..100 walkthrough ids or keys. */
  walkthroughs: string[];
  skipUsers?: string[];
  onConflict?: CleanupOnConflict;
  dryRun?: boolean;
}

export type CleanupFilter = 'pending' | 'cleaned' | 'dismissed' | 'all';
export interface CleanupList {
  items: CleanupItem[];
  /** active: active runs with pending data (not in items). */
  counts: { pending: number; active: number; cleaned: number; dismissed: number };
  /** true when the 500-item cap cut the list. */
  truncated?: boolean;
}

export interface StoryboardSchemaDoc {
  schemas: Record<string, unknown>;
  variables: { name: string; help: string }[];
  fieldKinds: FieldKind[];
  stepKinds: StepKind[];
}

// ---------- calls ----------

const P = (slug: string) => `/api/projects/${encodeURIComponent(slug)}`;
const e = (s: string) => encodeURIComponent(s);
export const sbPaths = {
  storyboards: (slug: string) => `${P(slug)}/storyboards`,
  dataSets: (slug: string) => `${P(slug)}/data-sets`,
  recipes: (slug: string) => `${P(slug)}/login-recipes`,
  snapshots: (slug: string) => `${P(slug)}/page-snapshots`,
  walkthroughs: (slug: string) => `${P(slug)}/walkthroughs`,
  shot: (slug: string, wid: string, shotId: string) => `${P(slug)}/walkthroughs/${e(wid)}/shots/${e(shotId)}`,
  summaryHtml: (slug: string, wid: string) => `${P(slug)}/walkthroughs/${e(wid)}/summary.html`,
  summaryJson: (slug: string, wid: string) => `${P(slug)}/walkthroughs/${e(wid)}/summary`,
  cleanup: (slug: string) => `${P(slug)}/cleanup`,
  walkthroughCleanup: (slug: string, wid: string) => `${P(slug)}/walkthroughs/${e(wid)}/cleanup`,
  recording: (slug: string, wid: string) => `${P(slug)}/walkthroughs/${e(wid)}/recording`,
  /** NDJSON, one rrweb event per line (gzip on the wire). */
  /** The hub's replay page (strict CSP): the dashboard mounts the DOM player into it. */
  recordingPlayer: (slug: string, wid: string) => `${P(slug)}/walkthroughs/${e(wid)}/recording/player`,
  recordingSegment: (slug: string, wid: string, no: number) => `${P(slug)}/walkthroughs/${e(wid)}/recording/segments/${no}`,
};

export const sbApi = {
  schema: () => api.get<StoryboardSchemaDoc>('/api/storyboard-schema'),

  listStoryboards: (slug: string, tag?: string) => api.get<StoryboardBrief[]>(`${sbPaths.storyboards(slug)}${qs({ tag })}`),
  getStoryboard: (slug: string, key: string) => api.get<StoryboardView>(`${sbPaths.storyboards(slug)}/${e(key)}`),
  putStoryboard: (slug: string, key: string, b: Storyboard) => api.put<StoryboardView>(`${sbPaths.storyboards(slug)}/${e(key)}`, b),
  deleteStoryboard: (slug: string, key: string) => api.del<{ deleted: string }>(`${sbPaths.storyboards(slug)}/${e(key)}`),
  validate: (slug: string, storyboard: unknown) => api.post<ValidationResult>(`${sbPaths.storyboards(slug)}/validate`, { storyboard }),
  duplicate: (slug: string, key: string, to: { slug: string; name?: string }) => api.post<StoryboardView>(`${sbPaths.storyboards(slug)}/${e(key)}/duplicate`, to),
  exportBundle: (slug: string, q: { storyboards?: string; secrets?: boolean } = {}) => api.get<Bundle>(`${sbPaths.storyboards(slug)}/export${qs({ storyboards: q.storyboards, secrets: q.secrets ? 1 : undefined })}`),
  importBundle: (slug: string, bundle: unknown, opts: { mode?: ImportMode; dryRun?: boolean }) => api.post<ImportResult>(`${sbPaths.storyboards(slug)}/import`, { bundle, ...opts }),

  listDataSets: (slug: string) => api.get<DataSetView[]>(sbPaths.dataSets(slug)),
  getDataSet: (slug: string, key: string) => api.get<DataSetView>(`${sbPaths.dataSets(slug)}/${e(key)}`),
  putDataSet: (slug: string, key: string, b: DataSet) => api.put<DataSetView>(`${sbPaths.dataSets(slug)}/${e(key)}`, b),
  deleteDataSet: (slug: string, key: string, force = false) => api.del<{ deleted: string }>(`${sbPaths.dataSets(slug)}/${e(key)}${qs({ force: force ? 1 : undefined })}`),
  previewDataSet: (slug: string, key: string, b: { storyboard?: string; actor?: string; walkthrough?: string }) =>
    api.post<{ entries: RenderedEntry[]; warnings: string[] }>(`${sbPaths.dataSets(slug)}/${e(key)}/preview`, b),
  fromSnapshot: (slug: string, b: { snapshot: string; slug: string; name: string; include?: 'visible' | 'all' }) => api.post<DataSetView>(`${sbPaths.dataSets(slug)}/from-snapshot`, b),

  listRecipes: (slug: string) => api.get<LoginRecipeView[]>(sbPaths.recipes(slug)),
  putRecipe: (slug: string, role: string, b: LoginRecipe) => api.put<LoginRecipeView>(`${sbPaths.recipes(slug)}/${e(role)}`, b),
  deleteRecipe: (slug: string, role: string, force = false) => api.del<{ deleted: string }>(`${sbPaths.recipes(slug)}/${e(role)}${qs({ force: force ? 1 : undefined })}`),

  listSnapshots: (slug: string, limit = 200) => api.get<PageSnapshotBrief[]>(`${sbPaths.snapshots(slug)}${qs({ limit })}`),
  getSnapshot: (slug: string, id: string) => api.get<PageSnapshotView>(`${sbPaths.snapshots(slug)}/${e(id)}`),
  deleteSnapshot: (slug: string, id: string) => api.del<{ deleted: string }>(`${sbPaths.snapshots(slug)}/${e(id)}`),

  listWalkthroughs: (slug: string, q: { storyboard?: string; status?: string; mode?: RunMode | 'all'; executor?: WalkthroughExecutor; limit?: number } = {}) => api.get<WalkthroughBrief[]>(`${sbPaths.walkthroughs(slug)}${qs(q)}`),
  getWalkthrough: (slug: string, id: string) => api.get<WalkthroughView>(`${sbPaths.walkthroughs(slug)}/${e(id)}`),
  /** 409 when the run has test data to clean up (unless users or force), or when users=1 meets a user other runs still need (details.kept, unless force). */
  deleteWalkthrough: (slug: string, id: string, o: { users?: boolean; force?: boolean } = {}) =>
    api.del<{ deleted: string; users: number; kept?: CleanupKept[] }>(`${sbPaths.walkthroughs(slug)}/${e(id)}${qs({ users: o.users ? 1 : undefined, force: o.force ? 1 : undefined })}`),
  /** A person signs off a finished agent run (verdict defaults to the agent's). */
  signoff: (slug: string, id: string, b: { signedOffBy: string; verdict?: Verdict; note?: string }) => api.post<WalkthroughView>(`${sbPaths.walkthroughs(slug)}/${e(id)}/signoff`, b),
  abandon: (slug: string, id: string, note?: string) => api.post<WalkthroughView>(`${sbPaths.walkthroughs(slug)}/${e(id)}/abandon`, note ? { note } : {}),
  reopen: (slug: string, id: string) => api.post<WalkthroughView>(`${sbPaths.walkthroughs(slug)}/${e(id)}/reopen`, {}),

  listCleanup: (slug: string, q: { status?: CleanupFilter; mode?: RunMode | 'all' } = {}) => api.get<CleanupList>(`${sbPaths.cleanup(slug)}${qs(q)}`),
  getCleanup: (slug: string, id: string) => api.get<CleanupItem>(sbPaths.walkthroughCleanup(slug, id)),
  /** dryRun: the same result as cleanupRuns, nothing changes; conflicts come back in the body (200). */
  cleanupPreview: (slug: string, req: Omit<CleanupRequest, 'dryRun'>) => api.post<CleanupResult>(sbPaths.cleanup(slug), { ...req, dryRun: true }),
  /** 409 with { error, conflicts } when onConflict is ask (the default) and another run still needs a user: see conflictsOf. */
  cleanupRuns: (slug: string, req: Omit<CleanupRequest, 'dryRun'>) => api.post<CleanupResult>(sbPaths.cleanup(slug), { ...req, dryRun: false }),
  dismissCleanup: (slug: string, id: string, note?: string) => api.post<CleanupItem>(`${sbPaths.walkthroughCleanup(slug, id)}/dismiss`, note ? { note } : {}),
  reopenCleanup: (slug: string, id: string) => api.post<CleanupItem>(`${sbPaths.walkthroughCleanup(slug, id)}/reopen`, {}),

  getRecording: (slug: string, id: string) => api.get<RecordingList>(sbPaths.recording(slug, id)),
  setRecording: (slug: string, id: string, b: { paused?: boolean; mode?: RecordMode; maskAllInputs?: boolean }) => api.patch<WalkthroughView>(sbPaths.recording(slug, id), b),
  deleteRecording: (slug: string, id: string) => api.del<{ deleted: number; bytes: number }>(sbPaths.recording(slug, id)),
  /**
   * The rrweb events of one segment, in order. The NDJSON is parsed as it streams in (no copy of the whole text);
   * past maxBytes (uncompressed) it stops with an error instead of filling the tab's memory.
   */
  recordingEvents: async (slug: string, id: string, no: number, maxBytes = RECORDING_EVENTS_MAX_BYTES): Promise<unknown[]> => {
    const res = await fetch(sbPaths.recordingSegment(slug, id, no));
    if (!res.ok) {
      const text = await res.text();
      let msg = `HTTP ${res.status}`;
      try {
        msg = (JSON.parse(text) as { error?: string }).error ?? msg;
      } catch {
        /* not JSON */
      }
      throw new ApiError(res.status, msg);
    }
    return parseNdjsonStream(res, maxBytes);
  },
};

// ---------- helpers ----------

/** The most a segment's events may be (uncompressed) for the dashboard player; the hub caps a segment at 32 MB. */
export const RECORDING_EVENTS_MAX_BYTES = 48 * 1024 * 1024;

/** NDJSON from a response body, line by line (blank lines skipped). */
export async function parseNdjsonStream(res: Response, maxBytes = RECORDING_EVENTS_MAX_BYTES): Promise<unknown[]> {
  const out: unknown[] = [];
  const push = (line: string) => {
    if (line.trim()) out.push(JSON.parse(line));
  };
  if (!res.body) {
    for (const line of (await res.text()).split('\n')) push(line);
    return out;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let rest = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel();
      throw new Error(`This segment is over ${Math.round(maxBytes / 1024 / 1024)} MB of events: too large to play here.`);
    }
    const lines = (rest + dec.decode(value, { stream: true })).split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) push(line);
  }
  push(rest + dec.decode());
  return out;
}

/** The conflicts of a 409 from cleanupRuns (body { error, conflicts }), or null for other failures. */
export function conflictsOf(err: unknown): CleanupConflict[] | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const b = err.body as { conflicts?: CleanupConflict[] } | undefined;
  return Array.isArray(b?.conflicts) && b.conflicts.length ? b.conflicts : null;
}

/** The {errors, warnings} of a 400 from a write, or null for other failures. */
export function issuesOf(err: unknown): { errors: ValidationIssue[]; warnings: ValidationIssue[] } | null {
  if (!(err instanceof ApiError) || err.status !== 400) return null;
  const d = err.details as { errors?: ValidationIssue[]; warnings?: ValidationIssue[] } | undefined;
  if (!d || !Array.isArray(d.errors)) return null;
  return { errors: d.errors, warnings: Array.isArray(d.warnings) ? d.warnings : [] };
}

/** The authoring part of a storyboard view (server fields dropped). */
export function toStoryboardInput(v: StoryboardView): Storyboard {
  return {
    slug: v.slug,
    name: v.name,
    description: v.description ?? '',
    intent: v.intent ?? '',
    tags: v.tags ?? [],
    inputs: v.inputs ?? [],
    actors: v.actors,
    steps: v.steps,
    preferredMode: v.preferredMode ?? 'tracked',
  };
}

export function toDataSetInput(v: DataSetView): DataSet {
  return { slug: v.slug, name: v.name, description: v.description ?? '', match: v.match ?? {}, entries: v.entries };
}

export function toRecipeInput(v: LoginRecipeView): LoginRecipe {
  return { role: v.role, name: v.name ?? '', loginUrl: v.loginUrl, fields: v.fields ?? {}, twoFactor: v.twoFactor ?? { kind: 'none' }, logoutUrl: v.logoutUrl ?? null, notes: v.notes ?? '' };
}

export const STEP_KIND_LABEL: Record<StepKind, string> = {
  open: 'Open page',
  login: 'Log in',
  logout: 'Log out',
  fill: 'Fill form',
  email: 'Email / SMS',
  instruction: 'Instruction',
  capture: 'Capture value',
  check: 'Check',
};

export const STEP_KIND_HELP: Record<StepKind, string> = {
  open: 'Open a URL in the tab',
  login: "Log the actor in with their role's login recipe",
  logout: 'Log out (step URL or the recipe logout URL)',
  fill: 'Fill the form on the page from a data set',
  email: 'Wait for a message to the actor and open a link from it',
  instruction: 'Free text: the human does something by hand',
  capture: 'Read a value from the page into vars.<name>',
  check: 'Something the human confirms (with an optional assertion)',
};

export const WT_STATUS_KIND: Record<WalkthroughStatus, string> = { active: 'accent', finished: 'ok', abandoned: '' };
export const STEP_STATUS_KIND: Record<StepStatus, string> = { pending: '', active: 'accent', done: 'ok', skipped: 'warn', failed: 'bad' };
export const VERDICT_KIND: Record<Verdict, string> = { pass: 'ok', fail: 'bad', partial: 'warn' };

/** "agent" or "agent · playwright-mcp 1.2" for the agent badge. */
export const runnerLabel = (r: WalkthroughRunner | null | undefined): string => (r ? `agent · ${r.name}${r.version ? ` ${r.version}` : ''}` : 'agent');
export const CLEANUP_STATUS_KIND: Record<CleanupStatus, string> = { none: '', pending: 'warn', cleaned: 'ok', dismissed: '' };
export const CLEANUP_STATUS_LABEL: Record<CleanupStatus, string> = { none: 'no test data', pending: 'data to clean', cleaned: 'cleaned', dismissed: 'left as is' };
export const KEPT_REASON_LABEL: Record<CleanupKeptReason, string> = {
  keep: 'Keep pin',
  skipped: 'you left it out',
  'used-by': 'used by another run',
  'used-by-active': 'used by an active run',
};

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
