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
/** tracked: per-step evidence and a sign-off, kept in history. quick: same steps, nothing kept, deleted after 24 h. */
export type RunMode = 'tracked' | 'quick';

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
  var?: string;
  selector?: string;
  attribute?: string;
  textPattern?: string;
  required?: boolean;
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
  steps: WalkthroughStep[];
  counts: StepCounts;
  signoff: { verdict: Verdict | null; signedOffBy: string | null; signedOffAt: string | null; note: string };
  startedAt: string;
  finishedAt: string | null;
  updatedAt: string;
  warnings: string[];
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

  listWalkthroughs: (slug: string, q: { storyboard?: string; status?: string; mode?: RunMode | 'all'; limit?: number } = {}) => api.get<WalkthroughBrief[]>(`${sbPaths.walkthroughs(slug)}${qs(q)}`),
  getWalkthrough: (slug: string, id: string) => api.get<WalkthroughView>(`${sbPaths.walkthroughs(slug)}/${e(id)}`),
  deleteWalkthrough: (slug: string, id: string, users: boolean) => api.del<{ deleted: string; users: number }>(`${sbPaths.walkthroughs(slug)}/${e(id)}${qs({ users: users ? 1 : undefined })}`),
  abandon: (slug: string, id: string, note?: string) => api.post<WalkthroughView>(`${sbPaths.walkthroughs(slug)}/${e(id)}/abandon`, note ? { note } : {}),
  reopen: (slug: string, id: string) => api.post<WalkthroughView>(`${sbPaths.walkthroughs(slug)}/${e(id)}/reopen`, {}),
};

// ---------- helpers ----------

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

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
