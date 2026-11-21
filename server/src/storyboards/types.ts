import type { Project } from '../repos/projects.js';
import type {
  Actor,
  Bundle,
  DataSet,
  FieldKind,
  Input,
  LoginRecipe,
  PageSnapshot,
  Step,
  StepKind,
  StepStatus,
  Storyboard,
  Verdict,
  WalkthroughStatus,
} from './schema.js';

/**
 * Service contracts of Storyboards (docs/design/storyboards.md §3, §8). Slice 1 implements StoryboardService
 * (storyboards/service.ts), Slice 2 WalkthroughService (storyboards/walkthroughs.ts); both hang off the Hub as
 * optional fields. Methods take the Project the route already resolved; inputs typed `unknown` are validated with
 * the zod schemas inside. Failures throw HttpError (400 carries details: {errors, warnings}).
 */

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

/** PATCH /data-sets/:slug. upsertEntries merges by key; removeKeys drops entries. */
export interface DataSetPatch {
  name?: string;
  description?: string;
  match?: DataSet['match'];
  entries?: unknown[];
  upsertEntries?: unknown[];
  removeKeys?: string[];
}

/** A data-set entry with its value rendered for one actor / walkthrough (sent to the extension). */
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
  version: number;
  steps: number;
  actors: { key: string; role: string; fresh: boolean }[];
  updatedAt: string;
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

/** POST /data-sets/from-snapshot. */
export interface FromSnapshotInput {
  snapshot: string;
  slug: string;
  name: string;
  include?: 'visible' | 'all';
  values?: Record<string, string>;
}

export type ImportMode = 'upsert' | 'create-only' | 'replace';
type BundleCollections = { users: string[]; loginRecipes: string[]; dataSets: string[]; storyboards: string[] };

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

/** Upserts say whether the row was new (201) and, for storyboards, whether the content changed (version bump). */
export interface Upserted<T> {
  view: T;
  created: boolean;
  changed: boolean;
}

export interface StoryboardService {
  // Discovery (§3.1)
  /** GET /api/storyboards/match?origin= — projects whose settings.appOrigins contain the normalised origin. */
  matchOrigin(origin: string): OriginMatch;

  // Login recipes (§3.2)
  listLoginRecipes(project: Project): LoginRecipeView[];
  getLoginRecipe(project: Project, role: string): LoginRecipeView | null;
  /** PUT /login-recipes/:role; body.role, when given, must equal `role`. */
  upsertLoginRecipe(project: Project, role: string, input: unknown): Upserted<LoginRecipeView>;
  /** 409 when a storyboard uses it, unless force. */
  deleteLoginRecipe(project: Project, role: string, opts?: { force?: boolean }): void;

  // Data sets (§3.3)
  /** With `url`: only data sets whose match.urlPattern matches, with matchScore, best first. */
  listDataSets(project: Project, opts?: { url?: string }): DataSetView[];
  getDataSet(project: Project, slug: string): DataSetView | null;
  upsertDataSet(project: Project, slug: string, input: unknown): Upserted<DataSetView>;
  patchDataSet(project: Project, slug: string, patch: DataSetPatch): DataSetView;
  deleteDataSet(project: Project, slug: string, opts?: { force?: boolean }): void;
  previewDataSet(project: Project, slug: string, opts: { storyboard?: string; actor?: string; walkthrough?: string }): { entries: RenderedEntry[]; warnings: string[] };
  dataSetFromSnapshot(project: Project, input: FromSnapshotInput): DataSetView;

  // Storyboards (§3.4)
  listStoryboards(project: Project, opts?: { tag?: string }): StoryboardBrief[];
  /** By slug or id. */
  getStoryboard(project: Project, slugOrId: string): StoryboardView | null;
  /** Validation first (400 with every issue); version bumps only when the content hash changes. */
  upsertStoryboard(project: Project, slug: string, input: unknown): Upserted<StoryboardView>;
  deleteStoryboard(project: Project, slug: string): void;
  /** Dry run: never throws for an invalid storyboard. */
  validateStoryboard(project: Project, input: { storyboard?: unknown; slug?: string }): ValidationResult;
  duplicateStoryboard(project: Project, slug: string, to: { slug: string; name?: string }): StoryboardView;

  // Page snapshots (§3.5)
  savePageSnapshot(project: Project, input: unknown): PageSnapshotView;
  listPageSnapshots(project: Project, opts?: { url?: string; limit?: number }): PageSnapshotBrief[];
  getPageSnapshot(project: Project, id: string): PageSnapshotView | null;
  deletePageSnapshot(project: Project, id: string): void;

  // Bundle (§3.6)
  exportBundle(project: Project, opts?: { storyboards?: string[]; secrets?: boolean }): Bundle;
  importBundle(project: Project, bundle: unknown, opts?: { mode?: ImportMode; dryRun?: boolean }): ImportResult;

  // Housekeeping (§8)
  /** POST /projects/:slug/reset: page snapshots go; storyboards, data sets and recipes stay. */
  resetProject(projectId: string): void;
}

// ---------------------------------------------------------------------------------------------------------------
// Walkthroughs (§3.7)

/** walkthroughs.actors as stored (JSON, no FK). */
export interface StoredWalkthroughActor {
  userId: string;
  email: string | null;
  name: string;
  role: string;
  created: boolean;
}

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

export interface WalkthroughView {
  id: string;
  key: string;
  label: string;
  status: WalkthroughStatus;
  executor: 'human';
  origin: string;
  storyboard: { id: string | null; slug: string; name: string; version: number };
  inputs: Input[];
  actors: Record<string, WalkthroughActor>;
  vars: Record<string, string>;
  currentStepId: string | null;
  steps: WalkthroughStepView[];
  counts: StepCounts;
  signoff: { verdict: Verdict | null; signedOffBy: string | null; signedOffAt: string | null; note: string };
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
  storyboard: { id: string | null; slug: string; name: string; version: number };
  verdict: Verdict | null;
  counts: StepCounts;
  startedAt: string;
  finishedAt: string | null;
  updatedAt: string;
}

/** The snapshot stored in walkthroughs.snapshot at start (and on refresh). */
export interface WalkthroughSnapshot {
  storyboard: { id: string; slug: string; name: string; version: number; intent: string; description: string };
  inputs: Input[];
  actors: Actor[];
  steps: StoredStep[];
}

export interface StartWalkthroughInput {
  storyboard: string;
  origin?: string;
  label?: string;
  vars?: Record<string, string>;
  /** Override of the user per actor key (id, email, name or role). */
  actors?: Record<string, string>;
}

export interface WalkthroughPatch {
  label?: string;
  /** null deletes the var. */
  vars?: Record<string, string | null>;
  currentStepId?: string | null;
  origin?: string;
}

export interface StepPatch {
  status?: Exclude<StepStatus, 'active'>;
  note?: string;
  /** Shallow-merged into the step data. */
  data?: Record<string, unknown>;
  /** Capture steps only: sets vars[step.var] and data.value. */
  value?: string;
}

export interface FinishInput {
  verdict: Verdict;
  signedOffBy: string;
  note?: string;
  allowIncomplete?: boolean;
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
}

/** POST /walkthroughs/:id/steps/:stepId/resolve. */
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
      dataSet: { slug: string; name: string; match: DataSet['match'] };
      formId: string | null;
      entries: RenderedEntry[];
    })
  | (ResolvedBase<'email'> & {
      channel: 'email' | 'sms' | 'whatsapp';
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
  signoff: WalkthroughView['signoff'];
  durationMs: number;
}

export interface WalkthroughService {
  start(project: Project, input: StartWalkthroughInput): WalkthroughView;
  list(project: Project, opts?: { storyboard?: string; status?: WalkthroughStatus; limit?: number }): WalkthroughBrief[];
  /** By id or key. */
  get(project: Project, idOrKey: string): WalkthroughView | null;
  patch(project: Project, idOrKey: string, patch: WalkthroughPatch): WalkthroughView;
  /** Re-snapshot from the current storyboard; 409 when it was deleted. */
  refresh(project: Project, idOrKey: string): WalkthroughView;
  resolveStep(project: Project, idOrKey: string, stepId: string): ResolvedStep;
  updateStep(project: Project, idOrKey: string, stepId: string, patch: StepPatch): WalkthroughView;
  /** 413 over the caps (600 KB each, 40 per walkthrough, 50 MB per project). */
  addShot(project: Project, idOrKey: string, stepId: string, dataUrl: string): { id: string; bytes: number };
  getShot(project: Project, idOrKey: string, shotId: string): { mime: string; data: Buffer } | null;
  deleteShot(project: Project, idOrKey: string, shotId: string): void;
  finish(project: Project, idOrKey: string, input: FinishInput): WalkthroughView;
  abandon(project: Project, idOrKey: string, note?: string): WalkthroughView;
  reopen(project: Project, idOrKey: string): WalkthroughView;
  /** users: also delete the fresh users this walkthrough created. */
  delete(project: Project, idOrKey: string, opts?: { users?: boolean }): { deleted: string; users: number };
  summary(project: Project, idOrKey: string): WalkthroughSummary;
  summaryHtml(project: Project, idOrKey: string): string;

  // Housekeeping (§8)
  /** POST /projects/:slug/reset: walkthroughs, their steps and shots go. */
  resetProject(projectId: string): void;
  /** Retention: non-active walkthroughs with updated_at < cutoff, and page snapshots older than the cutoff. */
  purgeOlderThan(projectId: string, cutoffIso: string): number;
}
