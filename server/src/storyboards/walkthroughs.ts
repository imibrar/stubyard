import { randomBytes } from 'node:crypto';
import type { Hub } from '../hub.js';
import type { Project } from '../repos/projects.js';
import type { TestUser } from '../repos/users.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { WalkthroughCleanup } from './cleanup.js';
import { effectiveRecord, infoFromState, newRecordingState, recordingState, type RecordingInfo, type RecordingState } from './recordings.js';
import { fakePhone, seededRandom, seedOf } from './fake.js';
import { emailDomainOf, passwordOf, phonePrefixOf, renderEntries, renderFor, renderUrl, type RenderContext, type RenderUser } from './render.js';
import {
  EMPTY_RECORD_PRIVACY,
  KEY,
  RECORD_MODES,
  RUN_MODES,
  STEP_STATUSES,
  VERDICTS,
  WALKTHROUGH_STATUSES,
  type Actor,
  type DataSet,
  type Input,
  type LoginRecipe,
  type RecordMode,
  type RecordPrivacy,
  type RunMode,
  type StepStatus,
  type Verdict,
  type WalkthroughStatus,
} from './schema.js';
import type {
  CleanupInput,
  CleanupItem,
  CleanupKept,
  CleanupList,
  CleanupListStatus,
  CleanupLog,
  CleanupResult,
  CleanupStatus,
  FinishInput,
  ResolvedStep,
  ResolvedTwoFactor,
  StartWalkthroughInput,
  StepCounts,
  StepPatch,
  StoredStep,
  StoredWalkthroughActor,
  WalkthroughActor,
  WalkthroughBrief,
  WalkthroughListMode,
  WalkthroughPatch,
  WalkthroughService,
  WalkthroughSnapshot,
  WalkthroughStepView,
  WalkthroughSummary,
  WalkthroughView,
} from './types.js';

/**
 * Walkthroughs (docs/design/storyboards.md §3.7): one human run through a storyboard. The storyboard is copied into
 * walkthroughs.snapshot at start, so later edits never change a run in progress (POST …/refresh re-snapshots).
 * Fresh actors become project test users (run_id NULL) so a walkthrough can span days; their ids are recorded and
 * DELETE …?users=1 removes them (by the cleanup rules, cleanup.ts). Screenshots are BLOBs in walkthrough_shots (never exported, CASCADE on delete).
 * A walkthrough runs tracked (default) or quick (migration 25): a quick test run takes no screenshots, finishes without a
 * sign-off, and is left out of the default list and the storyboard's lastWalkthrough. Nothing is deleted automatically:
 * the test data a run created is removed by a manual cleanup (cleanup.ts, migration 26).
 */

/** Screenshot caps (§1.1). Mutable for tests. */
export interface ShotCaps {
  shotBytes: number;
  shotsPerWalkthrough: number;
  projectBytes: number;
}
export const DEFAULT_SHOT_CAPS: ShotCaps = { shotBytes: 600 * 1024, shotsPerWalkthrough: 40, projectBytes: 50 * 1024 * 1024 };

const FINAL_STATUSES: StepStatus[] = ['done', 'skipped', 'failed'];
const DEFAULT_FRESH_NAME = '{{fake.firstName}} {{fake.lastName}}';

interface WalkthroughRow {
  id: string;
  project_id: string;
  storyboard_id: string | null;
  key: string;
  label: string;
  executor: string;
  status: WalkthroughStatus;
  mode: RunMode;
  origin: string;
  snapshot: string;
  actors: string;
  vars: string;
  current_step_id: string | null;
  verdict: Verdict | null;
  signed_off_by: string | null;
  signed_off_at: string | null;
  summary_note: string;
  started_at: string;
  finished_at: string | null;
  updated_at: string;
  cleanup_status: CleanupStatus;
  cleanup_at: string | null;
  /** Migration 27: off | dom, and the recording state (JSON, recordings.ts). */
  record: string;
  recording: string;
}

interface StepRow {
  walkthrough_id: string;
  project_id: string;
  step_id: string;
  position: number;
  status: StepStatus;
  note: string;
  data: string;
  started_at: string | null;
  finished_at: string | null;
}

interface ShotRow {
  id: string;
  step_id: string;
  bytes: number;
  created_at: string;
}

/** What a walkthrough needs from the authoring side (Slice 1's StoryboardService). */
interface StoryboardData {
  id: string;
  slug: string;
  name: string;
  version: number;
  intent: string;
  description: string;
  inputs: Input[];
  actors: Actor[];
  steps: StoredStep[];
  record: RecordMode;
  recordMaskAllInputs: boolean;
  recordPrivacy?: RecordPrivacy;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** "http://localhost:3183/x" → "http://localhost:3183"; '' stays ''. 400 for anything that is not http(s). */
function normalizeOrigin(raw: string, field = 'origin'): string {
  const s = raw.trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin;
  } catch {
    /* fall through */
  }
  throw new HttpError(400, `${field} must be an origin like http://localhost:3183`);
}

function randomKey(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(6);
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export class WalkthroughServiceImpl implements WalkthroughService {
  caps: ShotCaps = { ...DEFAULT_SHOT_CAPS };
  private cleanupSvc: WalkthroughCleanup;

  constructor(private hub: Hub) {
    this.cleanupSvc = new WalkthroughCleanup(hub);
    // After migrations: actor dependencies of runs from before migration 26, and pending runs with nothing left.
    this.cleanupSvc.backfill();
  }

  // -------------------------------------------------------------------------------------------------------------
  // Authoring data (through Slice 1's service)

  private storyboards() {
    const s = this.hub.storyboards;
    if (!s) throw new HttpError(503, 'Storyboards are not available');
    return s;
  }

  private storyboardData(project: Project, slugOrId: string): StoryboardData | null {
    const v = this.storyboards().getStoryboard(project, slugOrId);
    if (!v) return null;
    return { id: v.id, slug: v.slug, name: v.name, version: v.version, intent: v.intent, description: v.description, inputs: v.inputs, actors: v.actors, steps: v.steps, record: v.record ?? 'off', recordMaskAllInputs: v.recordMaskAllInputs ?? false, recordPrivacy: v.recordPrivacy };
  }

  private loginRecipe(project: Project, role: string): LoginRecipe | null {
    return this.storyboards().getLoginRecipe(project, role);
  }

  private dataSet(project: Project, slug: string): DataSet | null {
    return this.storyboards().getDataSet(project, slug);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Rows

  private row(project: Project, idOrKey: string): WalkthroughRow | null {
    return (this.hub.db.prepare('SELECT * FROM walkthroughs WHERE project_id = ? AND (id = ? OR key = ?)').get(project.id, idOrKey, idOrKey) as WalkthroughRow | undefined) ?? null;
  }

  private requireRow(project: Project, idOrKey: string): WalkthroughRow {
    const r = this.row(project, idOrKey);
    if (!r) throw new HttpError(404, `Walkthrough "${idOrKey}" not found`);
    return r;
  }

  private requireActive(project: Project, idOrKey: string): WalkthroughRow {
    const r = this.requireRow(project, idOrKey);
    if (r.status !== 'active') throw new HttpError(409, `Walkthrough ${r.key} is ${r.status}; reopen it first`);
    return r;
  }

  private stepRows(walkthroughId: string): StepRow[] {
    return this.hub.db.prepare('SELECT * FROM walkthrough_steps WHERE walkthrough_id = ? ORDER BY position, step_id').all(walkthroughId) as StepRow[];
  }

  private stepRow(walkthroughId: string, stepId: string): StepRow | null {
    return (this.hub.db.prepare('SELECT * FROM walkthrough_steps WHERE walkthrough_id = ? AND step_id = ?').get(walkthroughId, stepId) as StepRow | undefined) ?? null;
  }

  private touch(id: string, now = nowIso()): void {
    this.hub.db.prepare('UPDATE walkthroughs SET updated_at = ? WHERE id = ?').run(now, id);
  }

  private publish(project: Project, data: { id: string; stepId?: string; status: string; deleted?: boolean; cleanup?: CleanupStatus }): void {
    this.hub.bus.publish({ type: 'walkthrough.changed', projectId: project.id, data });
  }

  private snapshotOf(r: WalkthroughRow): WalkthroughSnapshot {
    return parseJson<WalkthroughSnapshot>(r.snapshot, { storyboard: { id: '', slug: '', name: '', version: 0, intent: '', description: '' }, inputs: [], actors: [], steps: [] });
  }

  private storedActors(r: WalkthroughRow): Record<string, StoredWalkthroughActor> {
    return parseJson<Record<string, StoredWalkthroughActor>>(r.actors, {});
  }

  // -------------------------------------------------------------------------------------------------------------
  // Actors

  private renderUser(u: TestUser): RenderUser {
    return { name: u.name, email: u.email, phone: u.phone, role: u.role, password: u.password };
  }

  /** Users of the walkthrough's actors as templates see them (null = deleted since the start). */
  private renderActors(project: Project, stored: Record<string, StoredWalkthroughActor>): Record<string, RenderUser | null> {
    const out: Record<string, RenderUser | null> = {};
    for (const [key, a] of Object.entries(stored)) {
      const u = this.hub.users.get(project.id, a.userId);
      out[key] = u ? this.renderUser(u) : null;
    }
    return out;
  }

  private renderContext(project: Project, r: WalkthroughRow, opts: { actors?: Record<string, RenderUser | null>; vars?: Record<string, string>; actor?: string | null } = {}): RenderContext {
    return {
      project: { slug: project.slug, name: project.name, settings: project.settings },
      walkthrough: { id: r.id, key: r.key, startedAt: r.started_at, origin: r.origin },
      actors: opts.actors ?? this.renderActors(project, this.storedActors(r)),
      actor: opts.actor ?? null,
      vars: opts.vars ?? parseJson<Record<string, string>>(r.vars, {}),
    };
  }

  /**
   * Resolves the users of actors not yet in `stored`: overrides / existing refs first (nothing is created when one
   * fails), then fresh users. Returns the new entries. An existing user that is another walkthrough's fresh user is
   * added to `uses` (recorded as an actor dependency once the walkthrough row exists).
   */
  private resolveActors(
    project: Project,
    w: { id: string; key: string; startedAt: string; origin: string; vars: Record<string, string>; storyboardSlug: string },
    actors: Actor[],
    stored: Record<string, StoredWalkthroughActor>,
    overrides: Record<string, string>,
    uses: { sourceId: string; userId: string }[] = [],
  ): Record<string, StoredWalkthroughActor> {
    const out: Record<string, StoredWalkthroughActor> = {};
    const problems: string[] = [];
    for (const a of actors) {
      if (stored[a.key]) continue;
      const override = overrides[a.key];
      if (a.fresh && override === undefined) continue;
      const ref = override ?? a.user ?? a.role;
      const u = this.hub.users.resolve(project.id, ref);
      if (!u) problems.push(`actors.${a.key}: no test user matches "${ref}"`);
      else {
        out[a.key] = { userId: u.id, email: u.email, name: u.name, role: u.role, created: false };
        const source = this.cleanupSvc.creatorOf(project.id, u.id, w.id);
        if (source && !uses.some((x) => x.sourceId === source && x.userId === u.id)) uses.push({ sourceId: source, userId: u.id });
      }
    }
    if (problems.length) throw new HttpError(400, `Cannot resolve ${problems.length === 1 ? 'an actor' : `${problems.length} actors`}: ${problems.join('; ')}`, { errors: problems });

    const ctxBase = {
      project: { slug: project.slug, name: project.name, settings: project.settings },
      walkthrough: { id: w.id, key: w.key, startedAt: w.startedAt, origin: w.origin },
      actors: {},
      vars: w.vars,
    };
    const domain = emailDomainOf(ctxBase.project);
    // Fresh actors of one run get distinct names: fake values are seeded per walkthrough, so two actors with the default
    // name would both be the same person. A name already taken in this run is re-rolled with another seed (a few tries).
    const taken = new Set([...Object.values(stored), ...Object.values(out)].map((x) => x.name.trim().toLowerCase()));
    for (const a of actors) {
      if (stored[a.key] || out[a.key] || !a.fresh) continue;
      const nameOf = (i: number) => {
        const ctx = i === 0 ? ctxBase : { ...ctxBase, walkthrough: { ...ctxBase.walkthrough, id: `${w.id}:${a.key}:${i}` } };
        return renderFor(ctx, a.name || DEFAULT_FRESH_NAME, `actors.${a.key}.name`).text.trim() || `Fresh ${a.role}`;
      };
      let name = nameOf(0);
      for (let i = 1; i <= 5 && taken.has(name.toLowerCase()); i++) name = nameOf(i);
      taken.add(name.toLowerCase());
      let email = `${a.role}.${w.key}@${domain}`.toLowerCase();
      for (let i = 2; this.hub.users.findByEmail(project.id, email); i++) email = `${a.role}.${w.key}-${i}@${domain}`.toLowerCase();
      // A phone number too, so sms / whatsapp steps work for fresh actors (same shape as users.generate).
      const rnd = seededRandom(seedOf(w.id, `actor.${a.key}.phone`));
      let phone = fakePhone(phonePrefixOf(ctxBase.project), rnd);
      for (let i = 0; i < 20 && (this.hub.users.findByPhone(project.id, phone, 'sms') || this.hub.users.findByPhone(project.id, phone, 'whatsapp')); i++) {
        phone = fakePhone(phonePrefixOf(ctxBase.project), rnd);
      }
      const u = this.hub.users.create(project.id, {
        name,
        role: a.role,
        email,
        phone,
        password: null,
        notes: `Created by walkthrough ${w.key} (${w.storyboardSlug})`,
      });
      out[a.key] = { userId: u.id, email: u.email, name: u.name, role: u.role, created: true };
    }
    return out;
  }

  /** Effective actor key per step: the step's own, else the previous step's, else the first actor. */
  private stepActors(snapshot: WalkthroughSnapshot): Map<string, string | null> {
    const out = new Map<string, string | null>();
    let prev: string | null = snapshot.actors[0]?.key ?? null;
    for (const s of snapshot.steps) {
      const a: string | null = s.actor ?? prev;
      out.set(s.id, a);
      prev = a;
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Views

  private actorViews(project: Project, r: WalkthroughRow): Record<string, WalkthroughActor> {
    const out: Record<string, WalkthroughActor> = {};
    const ctxProject = { slug: project.slug, name: project.name, settings: project.settings };
    for (const [key, a] of Object.entries(this.storedActors(r))) {
      const u = this.hub.users.get(project.id, a.userId);
      if (u) {
        out[key] = { userId: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, password: passwordOf(this.renderUser(u), ctxProject), created: a.created };
      } else {
        out[key] = { userId: a.userId, name: a.name, email: a.email, phone: null, role: a.role, password: passwordOf({ name: a.name, email: a.email, phone: null, role: a.role, password: null }, ctxProject), created: a.created, missing: true };
      }
    }
    return out;
  }

  private shotsByStep(walkthroughId: string): Map<string, { id: string; bytes: number; createdAt: string }[]> {
    const rows = this.hub.db.prepare('SELECT id, step_id, bytes, created_at FROM walkthrough_shots WHERE walkthrough_id = ? ORDER BY created_at, id').all(walkthroughId) as ShotRow[];
    const out = new Map<string, { id: string; bytes: number; createdAt: string }[]>();
    for (const s of rows) {
      const list = out.get(s.step_id) ?? [];
      list.push({ id: s.id, bytes: s.bytes, createdAt: s.created_at });
      out.set(s.step_id, list);
    }
    return out;
  }

  private stepViews(r: WalkthroughRow): WalkthroughStepView[] {
    const snapshot = this.snapshotOf(r);
    const defs = new Map(snapshot.steps.map((s) => [s.id, s]));
    const shots = this.shotsByStep(r.id);
    const out: WalkthroughStepView[] = [];
    for (const row of this.stepRows(r.id)) {
      const def = defs.get(row.step_id);
      if (!def) continue;
      out.push({
        ...def,
        position: row.position,
        status: row.status,
        note: row.note,
        data: parseJson<Record<string, unknown>>(row.data, {}),
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        shots: shots.get(row.step_id) ?? [],
      });
    }
    return out;
  }

  private countsOf(statuses: StepStatus[]): StepCounts {
    const c = Object.fromEntries(STEP_STATUSES.map((s) => [s, 0])) as StepCounts;
    for (const s of statuses) c[s]++;
    return c;
  }

  private brief(r: WalkthroughRow): WalkthroughBrief {
    const snap = this.snapshotOf(r);
    const statuses = (this.hub.db.prepare('SELECT status FROM walkthrough_steps WHERE walkthrough_id = ?').all(r.id) as { status: StepStatus }[]).map((x) => x.status);
    return {
      id: r.id,
      key: r.key,
      label: r.label,
      status: r.status,
      mode: r.mode,
      storyboard: { id: r.storyboard_id, slug: snap.storyboard.slug, name: snap.storyboard.name, version: snap.storyboard.version },
      verdict: r.verdict,
      counts: this.countsOf(statuses),
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      updatedAt: r.updated_at,
      cleanupStatus: r.cleanup_status,
      cleanupAt: r.cleanup_at,
    };
  }

  private view(project: Project, r: WalkthroughRow): WalkthroughView {
    const snap = this.snapshotOf(r);
    const steps = this.stepViews(r);
    const actors = this.actorViews(project, r);
    const warnings: string[] = [];
    for (const [key, a] of Object.entries(actors)) if (a.missing) warnings.push(`actors.${key}: test user ${a.email ?? a.userId} was deleted`);
    if (!r.storyboard_id) warnings.push(`storyboard "${snap.storyboard.slug}" was deleted; this walkthrough keeps its copy`);
    else {
      const current = this.hub.storyboards?.getStoryboard(project, r.storyboard_id);
      if (current && current.version !== snap.storyboard.version) {
        warnings.push(`storyboard "${current.slug}" changed since this walkthrough copied it (v${snap.storyboard.version} → v${current.version}); POST …/refresh to update`);
      }
    }
    return {
      id: r.id,
      key: r.key,
      label: r.label,
      status: r.status,
      mode: r.mode,
      executor: 'human',
      origin: r.origin,
      storyboard: { id: r.storyboard_id, slug: snap.storyboard.slug, name: snap.storyboard.name, version: snap.storyboard.version },
      inputs: snap.inputs,
      actors,
      vars: parseJson<Record<string, string>>(r.vars, {}),
      currentStepId: r.current_step_id,
      steps,
      counts: this.countsOf(steps.map((s) => s.status)),
      signoff: { verdict: r.verdict, signedOffBy: r.signed_off_by, signedOffAt: r.signed_off_at, note: r.summary_note },
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      updatedAt: r.updated_at,
      cleanupStatus: r.cleanup_status,
      cleanupAt: r.cleanup_at,
      recording: this.recordingInfo(project, r),
      warnings,
    };
  }

  /** WalkthroughView.recording (recordings.ts); without a recording service, a stored state with no segments. */
  private recordingInfo(project: Project, r: WalkthroughRow): RecordingInfo {
    const masks = this.maskSelectors(project, r);
    if (this.hub.recordings) return this.hub.recordings.info(project, r, masks);
    const s = recordingState(r.recording);
    return { ...infoFromState(r.record, s, masks), segmentCount: 0, bytes: 0, maxBytes: 0 };
  }

  /**
   * Input fields a recording must mask besides password inputs: the 2FA code field (and the password field) of every
   * login recipe the run's login steps use. Only computed for runs that record.
   */
  maskSelectors(project: Project, r: WalkthroughRow): string[] {
    if (r.record !== 'dom' && r.record !== 'video') return [];
    const snap = this.snapshotOf(r);
    const actorOf = this.stepActors(snap);
    // The storyboard's own list (fixed at start), then the login recipes' password and 2FA fields.
    const out = new Set<string>(recordingState(r.recording).maskSelectors);
    for (const s of snap.steps) {
      if (s.kind !== 'login') continue;
      const key = actorOf.get(s.id) ?? null;
      const role = s.recipe ?? snap.actors.find((a) => a.key === key)?.role;
      const recipe = role ? this.loginRecipe(project, role) : null;
      if (!recipe) continue;
      if (recipe.fields.password) out.add(recipe.fields.password);
      if (recipe.twoFactor.kind !== 'none' && recipe.twoFactor.selector) out.add(recipe.twoFactor.selector);
    }
    return [...out];
  }

  /** The mask selectors of a walkthrough (GET …/recording). */
  recordingMasks(project: Project, idOrKey: string): string[] {
    return this.maskSelectors(project, this.requireRow(project, idOrKey));
  }

  private viewById(project: Project, id: string): WalkthroughView {
    return this.view(project, this.requireRow(project, id));
  }

  // -------------------------------------------------------------------------------------------------------------
  // Start / list / get / patch / refresh

  start(project: Project, input: StartWalkthroughInput): WalkthroughView {
    const b = (isObj(input) ? input : {}) as Partial<StartWalkthroughInput> & Record<string, unknown>;
    if (typeof b.storyboard !== 'string' || !b.storyboard.trim()) throw new HttpError(400, 'storyboard (slug or id) is required');
    if (b.label !== undefined && (typeof b.label !== 'string' || b.label.length > 200)) throw new HttpError(400, 'label must be a string of at most 200 characters');
    if (b.origin !== undefined && typeof b.origin !== 'string') throw new HttpError(400, 'origin must be a string');
    if (b.mode !== undefined && !(RUN_MODES as readonly unknown[]).includes(b.mode)) throw new HttpError(400, `mode must be one of ${RUN_MODES.join(', ')}`);
    const mode: RunMode = b.mode ?? 'tracked';
    if (b.record !== undefined && !(RECORD_MODES as readonly unknown[]).includes(b.record)) throw new HttpError(400, `record must be one of ${RECORD_MODES.join(', ')}`);
    if (b.maskAllInputs !== undefined && typeof b.maskAllInputs !== 'boolean') throw new HttpError(400, 'maskAllInputs must be true or false');
    const givenVars = this.stringMap(b.vars, 'vars');
    const overrides = this.stringMap(b.actors, 'actors');
    const declared = this.cleanupSvc.resolveUses(project, b.uses);

    const sb = this.storyboardData(project, b.storyboard.trim());
    if (!sb) throw new HttpError(404, `Storyboard "${b.storyboard}" not found`);
    const unknownActors = Object.keys(overrides).filter((k) => !sb.actors.some((a) => a.key === k));
    if (unknownActors.length) throw new HttpError(400, `actors: ${unknownActors.join(', ')} ${unknownActors.length === 1 ? 'is not an actor' : 'are not actors'} of storyboard "${sb.slug}"`, { expected: sb.actors.map((a) => a.key) });

    const vars: Record<string, string> = { ...givenVars };
    const missing: string[] = [];
    for (const i of sb.inputs) {
      if ((vars[i.name] === undefined || vars[i.name] === '') && i.default !== undefined) vars[i.name] = i.default;
      if (i.required && !(vars[i.name] ?? '').trim()) missing.push(i.name);
    }
    if (missing.length) {
      throw new HttpError(400, `Missing required input${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`, {
        missing,
        inputs: sb.inputs.filter((i) => missing.includes(i.name)).map((i) => ({ name: i.name, label: i.label, help: i.help })),
      });
    }

    const origin = normalizeOrigin(b.origin ?? '') || project.settings.appOrigins?.[0] || '';
    // Recording: the start override, else the storyboard's setting for tracked runs (a quick test records only when asked).
    const requested: RecordMode = b.record ?? (mode === 'tracked' ? sb.record : 'off');
    const record = effectiveRecord(requested);
    const recState: RecordingState = { ...newRecordingState(requested, b.maskAllInputs ?? sb.recordMaskAllInputs), ...(sb.recordPrivacy ?? EMPTY_RECORD_PRIVACY) };
    // Video (R2): nothing masks a video, so say so once at start.
    const startWarnings = record === 'video' ? ['This run records a video of the tab: passwords and codes typed by hand are visible in it (the extension shows its own fills as dots). Start it with Record video in the extension.'] : [];
    const id = newId();
    const now = nowIso();
    const snapshot: WalkthroughSnapshot = {
      storyboard: { id: sb.id, slug: sb.slug, name: sb.name, version: sb.version, intent: sb.intent, description: sb.description },
      inputs: sb.inputs,
      actors: sb.actors,
      steps: sb.steps,
    };

    this.hub.db.transaction(() => {
      let key = randomKey();
      for (let i = 0; this.hub.db.prepare('SELECT 1 FROM walkthroughs WHERE project_id = ? AND key = ?').get(project.id, key); i++) {
        if (i > 20) throw new HttpError(500, 'Could not pick a unique walkthrough key');
        key = randomKey();
      }
      const uses: { sourceId: string; userId: string }[] = [];
      const actors = this.resolveActors(project, { id, key, startedAt: now, origin, vars, storyboardSlug: sb.slug }, sb.actors, {}, overrides, uses);
      // A run that created users has test data to clean up from the start.
      const cleanup: CleanupStatus = Object.values(actors).some((a) => a.created) ? 'pending' : 'none';
      this.hub.db
        .prepare(
          `INSERT INTO walkthroughs (id, project_id, storyboard_id, key, label, executor, status, mode, origin, snapshot, actors, vars, current_step_id, summary_note, started_at, updated_at, cleanup_status, record, recording)
           VALUES (?,?,?,?,?,'human','active',?,?,?,?,?,?,'',?,?,?,?,?)`,
        )
        .run(id, project.id, sb.id, key, (b.label ?? '').trim(), mode, origin, JSON.stringify(snapshot), JSON.stringify(actors), JSON.stringify(vars), sb.steps[0]?.id ?? null, now, now, cleanup, record, JSON.stringify(recState));
      const ins = this.hub.db.prepare('INSERT INTO walkthrough_steps (walkthrough_id, project_id, step_id, position, status) VALUES (?,?,?,?,?)');
      sb.steps.forEach((s, i) => ins.run(id, project.id, s.id, i, 'pending'));
      for (const u of uses) this.cleanupSvc.recordUse(project.id, id, u.sourceId, 'actor', u.userId);
      for (const source of declared) this.cleanupSvc.recordUse(project.id, id, source, 'declared', null);
    })();
    this.publish(project, { id, status: 'active' });
    const v = this.viewById(project, id);
    if (startWarnings.length) v.warnings.push(...startWarnings);
    return v;
  }

  private stringMap(v: unknown, field: string): Record<string, string> {
    if (v === undefined || v === null) return {};
    if (!isObj(v)) throw new HttpError(400, `${field} must be an object of strings`);
    const out: Record<string, string> = {};
    for (const [k, x] of Object.entries(v)) {
      if (typeof x !== 'string') throw new HttpError(400, `${field}.${k} must be a string`);
      out[k] = x;
    }
    return out;
  }

  list(project: Project, opts: { storyboard?: string; status?: WalkthroughStatus; mode?: WalkthroughListMode; limit?: number } = {}): WalkthroughBrief[] {
    const where = ['project_id = ?'];
    const args: unknown[] = [project.id];
    const mode = opts.mode ?? 'tracked';
    if (mode !== 'all' && !(RUN_MODES as readonly string[]).includes(mode)) throw new HttpError(400, `mode must be one of ${RUN_MODES.join(', ')}, all`);
    if (mode !== 'all') {
      where.push('mode = ?');
      args.push(mode);
    }
    if (opts.status !== undefined) {
      if (!(WALKTHROUGH_STATUSES as readonly string[]).includes(opts.status)) throw new HttpError(400, `status must be one of ${WALKTHROUGH_STATUSES.join(', ')}`);
      where.push('status = ?');
      args.push(opts.status);
    }
    if (opts.storyboard) {
      where.push("(storyboard_id = ? OR json_extract(snapshot, '$.storyboard.slug') = ? OR json_extract(snapshot, '$.storyboard.id') = ?)");
      args.push(opts.storyboard, opts.storyboard, opts.storyboard);
    }
    const limit = Math.min(Math.max(Math.floor(Number(opts.limit ?? 50)) || 50, 1), 500);
    const rows = this.hub.db.prepare(`SELECT * FROM walkthroughs WHERE ${where.join(' AND ')} ORDER BY started_at DESC, id DESC LIMIT ?`).all(...args, limit) as WalkthroughRow[];
    return rows.map((r) => this.brief(r));
  }

  get(project: Project, idOrKey: string): WalkthroughView | null {
    const r = this.row(project, idOrKey);
    return r ? this.view(project, r) : null;
  }

  patch(project: Project, idOrKey: string, patch: WalkthroughPatch): WalkthroughView {
    const r = this.requireRow(project, idOrKey);
    const p = (isObj(patch) ? patch : {}) as Record<string, unknown>;
    let label = r.label;
    if (p.label !== undefined) {
      if (typeof p.label !== 'string' || p.label.length > 200) throw new HttpError(400, 'label must be a string of at most 200 characters');
      label = p.label.trim();
    }
    const vars = parseJson<Record<string, string>>(r.vars, {});
    if (p.vars !== undefined) {
      if (!isObj(p.vars)) throw new HttpError(400, 'vars must be an object of strings (null deletes a var)');
      for (const [k, v] of Object.entries(p.vars)) {
        if (!KEY.safeParse(k).success) throw new HttpError(400, `vars.${k}: a var name starts with a lowercase letter, then letters, digits, _`);
        if (v === null) delete vars[k];
        else if (typeof v === 'string') vars[k] = v;
        else throw new HttpError(400, `vars.${k} must be a string or null`);
      }
    }
    let current = r.current_step_id;
    if (p.currentStepId !== undefined) {
      if (p.currentStepId === null) current = null;
      else if (typeof p.currentStepId !== 'string' || !this.stepRow(r.id, p.currentStepId)) throw new HttpError(400, `currentStepId "${String(p.currentStepId)}" is not a step of this walkthrough`);
      else current = p.currentStepId;
    }
    let origin = r.origin;
    if (p.origin !== undefined) {
      if (typeof p.origin !== 'string') throw new HttpError(400, 'origin must be a string');
      origin = normalizeOrigin(p.origin);
    }
    this.hub.db
      .prepare('UPDATE walkthroughs SET label = ?, vars = ?, current_step_id = ?, origin = ?, updated_at = ? WHERE id = ?')
      .run(label, JSON.stringify(vars), current, origin, nowIso(), r.id);
    this.publish(project, { id: r.id, status: r.status });
    return this.viewById(project, r.id);
  }

  refresh(project: Project, idOrKey: string): WalkthroughView {
    const r = this.requireActive(project, idOrKey);
    const sb = r.storyboard_id ? this.storyboardData(project, r.storyboard_id) : null;
    if (!sb) throw new HttpError(409, 'The storyboard of this walkthrough was deleted; it cannot be refreshed');
    const old = this.snapshotOf(r);
    const rows = new Map(this.stepRows(r.id).map((s) => [s.step_id, s]));
    const newIds = new Set(sb.steps.map((s) => s.id));
    // Removed steps keep their definition and row (data.removed = true), after the current ones.
    const removed = old.steps.filter((s) => !newIds.has(s.id));
    const snapshot: WalkthroughSnapshot = {
      storyboard: { id: sb.id, slug: sb.slug, name: sb.name, version: sb.version, intent: sb.intent, description: sb.description },
      inputs: sb.inputs,
      actors: [...sb.actors, ...old.actors.filter((a) => !sb.actors.some((x) => x.key === a.key))],
      steps: [...sb.steps, ...removed],
    };
    this.hub.db.transaction(() => {
      const stored = this.storedActors(r);
      const uses: { sourceId: string; userId: string }[] = [];
      const added = this.resolveActors(
        project,
        { id: r.id, key: r.key, startedAt: r.started_at, origin: r.origin, vars: parseJson<Record<string, string>>(r.vars, {}), storyboardSlug: sb.slug },
        sb.actors,
        stored,
        {},
        uses,
      );
      for (const u of uses) this.cleanupSvc.recordUse(project.id, r.id, u.sourceId, 'actor', u.userId);
      // Fresh users created by later actors: the run has (new) data to clean up.
      if (Object.values(added).some((a) => a.created)) this.hub.db.prepare("UPDATE walkthroughs SET cleanup_status = 'pending', cleanup_at = NULL WHERE id = ?").run(r.id);
      const ins = this.hub.db.prepare('INSERT INTO walkthrough_steps (walkthrough_id, project_id, step_id, position, status) VALUES (?,?,?,?,?)');
      const upd = this.hub.db.prepare('UPDATE walkthrough_steps SET position = ?, data = ? WHERE walkthrough_id = ? AND step_id = ?');
      snapshot.steps.forEach((s, i) => {
        const row = rows.get(s.id);
        if (!row) return void ins.run(r.id, project.id, s.id, i, 'pending');
        const data = parseJson<Record<string, unknown>>(row.data, {});
        if (newIds.has(s.id)) delete data.removed;
        else data.removed = true;
        upd.run(i, JSON.stringify(data), r.id, s.id);
      });
      this.hub.db
        .prepare('UPDATE walkthroughs SET snapshot = ?, actors = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(snapshot), JSON.stringify({ ...stored, ...added }), nowIso(), r.id);
    })();
    this.publish(project, { id: r.id, status: r.status });
    return this.viewById(project, r.id);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Steps

  resolveStep(project: Project, idOrKey: string, stepId: string): ResolvedStep {
    const r = this.requireActive(project, idOrKey);
    const snapshot = this.snapshotOf(r);
    const step = snapshot.steps.find((s) => s.id === stepId);
    const row = this.stepRow(r.id, stepId);
    if (!step || !row) throw new HttpError(404, `Step "${stepId}" is not part of walkthrough ${r.key}`);

    const now = nowIso();
    const startedAt = row.started_at ?? now;
    const status: StepStatus = row.status === 'pending' ? 'active' : row.status;
    this.hub.db.prepare('UPDATE walkthrough_steps SET status = ?, started_at = ? WHERE walkthrough_id = ? AND step_id = ?').run(status, startedAt, r.id, stepId);
    this.hub.db.prepare('UPDATE walkthroughs SET current_step_id = ?, updated_at = ? WHERE id = ?').run(stepId, now, r.id);

    const stored = this.storedActors(r);
    const actorKey = this.stepActors(snapshot).get(stepId) ?? null;
    const ctx = this.renderContext(project, r, { actor: actorKey });
    const warnings: string[] = [];
    if (parseJson<Record<string, unknown>>(row.data, {}).removed) warnings.push('this step was removed from the storyboard');
    const a = actorKey ? stored[actorKey] : undefined;
    const user = a ? this.hub.users.get(project.id, a.userId) : null;
    if (actorKey && !a) warnings.push(`actor "${actorKey}" has no user in this walkthrough`);
    if (a && !user) warnings.push(`actor "${actorKey}": test user ${a.email ?? a.userId} was deleted`);
    const actor = actorKey && user ? { key: actorKey, userId: user.id, name: user.name, email: user.email, role: user.role } : null;
    const url = (template: string | null | undefined, field: string) => {
      const x = renderUrl(ctx, template, field);
      warnings.push(...x.warnings);
      return x.url;
    };
    const text = (template: string | null | undefined, field: string) => {
      const x = renderFor(ctx, template, field);
      warnings.push(...x.warnings);
      return x.text;
    };
    const p = project.slug;
    const enc = encodeURIComponent;
    const requireUser = () => {
      if (!user) throw new HttpError(409, `Step "${stepId}" needs the user of actor "${actorKey ?? '?'}", which is not available`, { code: 'missing_user' });
      return user;
    };

    // Display text: rendered with the same context; warnings dropped (a variable without a value renders as '').
    const shown = (template: string | null | undefined) => renderFor(ctx, template).text;
    const raw = step as { title?: string; intent?: string; expect?: string; notes?: string };
    const display: ResolvedStep['text'] = { intent: shown(raw.intent) };
    if (raw.title !== undefined) display.title = shown(raw.title);
    if (raw.expect !== undefined) display.expect = shown(raw.expect);
    if (raw.notes !== undefined) display.notes = shown(raw.notes);

    let out: ResolvedStep;
    switch (step.kind) {
      case 'open':
        out = { step, text: display, actor, url: url(step.url, 'url'), warnings };
        break;
      case 'login': {
        const role = step.recipe ?? a?.role ?? snapshot.actors.find((x) => x.key === actorKey)?.role ?? '';
        const recipe = role ? this.loginRecipe(project, role) : null;
        if (!recipe) throw new HttpError(409, `No login recipe for role "${role}"`, { code: 'missing_login_recipe', role });
        const u = requireUser();
        let twoFactor: ResolvedTwoFactor = { kind: 'none' };
        const tf = recipe.twoFactor;
        if (tf.kind === 'totp') {
          let auth = null;
          if (tf.authenticator) {
            try {
              auth = this.hub.authenticators.findByLabel(project.id, tf.authenticator);
            } catch (err) {
              warnings.push(`twoFactor: ${(err as Error).message}`);
            }
          } else auth = this.hub.authenticators.list(project.id).find((x) => x.testUserId === u.id) ?? null;
          if (auth) twoFactor = { kind: 'totp', selector: tf.selector, codePath: `/api/projects/${p}/authenticators/${auth.id}/code`, label: auth.label };
          else warnings.push(`twoFactor: no authenticator ${tf.authenticator ? `labelled "${tf.authenticator}"` : `is linked to ${u.email ?? u.name}`}; enter the code by hand`);
        } else if (tf.kind === 'email-otp' || tf.kind === 'sms-otp') {
          const channel = tf.kind === 'email-otp' ? 'email' : 'sms';
          const cursor = this.hub.messages.cursor(project.id, { testUserId: u.id, channel });
          const q = tf.subject ? `&q=${enc(tf.subject)}` : '';
          twoFactor = { kind: tf.kind, selector: tf.selector, waitPath: `/api/projects/${p}/messages/wait?user=${enc(u.id)}&channel=${channel}&otp=1&after=${enc(cursor)}${q}&timeout=60` };
        }
        const selectors: { username: string; password: string; submit?: string } = { username: recipe.fields.username, password: recipe.fields.password };
        if (recipe.fields.submit) selectors.submit = recipe.fields.submit;
        out = {
          step,
          text: display,
          actor,
          url: url(step.url ?? recipe.loginUrl, step.url ? 'url' : 'loginRecipe.loginUrl'),
          warnings,
          username: u.email ?? u.phone ?? '',
          password: passwordOf(this.renderUser(u), ctx.project),
          selectors,
          twoFactor,
        };
        break;
      }
      case 'logout': {
        const role = a?.role ?? snapshot.actors.find((x) => x.key === actorKey)?.role;
        const recipe = step.url === undefined && role ? this.loginRecipe(project, role) : null;
        out = { step, text: display, actor, url: url(step.url ?? recipe?.logoutUrl ?? null, step.url ? 'url' : 'loginRecipe.logoutUrl'), warnings };
        break;
      }
      case 'fill': {
        const ds = this.dataSet(project, step.dataSet);
        if (!ds) throw new HttpError(409, `Data set "${step.dataSet}" not found`, { code: 'missing_data_set', dataSet: step.dataSet });
        const rendered = renderEntries(ctx, ds.entries, `dataSets.${ds.slug}.entries`);
        warnings.push(...rendered.warnings);
        out = {
          step,
          text: display,
          actor,
          url: url(step.url ?? null, 'url'),
          warnings,
          dataSet: { slug: ds.slug, name: ds.name, match: ds.match },
          formId: step.formId ?? ds.match.formId ?? null,
          entries: rendered.entries,
        };
        break;
      }
      case 'email': {
        const u = requireUser();
        const q = step.match.text ? text(step.match.text, 'match.text').trim() : '';
        // The window starts where the previous step started (else the walkthrough start): the app usually sends the
        // mail while that step is done, before the human opens this one. Stable across re-resolves.
        const since = this.emailSince(r, row);
        out = {
          step,
          text: display,
          actor,
          url: null,
          warnings,
          channel: step.channel,
          user: { id: u.id, email: u.email, phone: u.phone },
          waitPath: `/api/projects/${p}/messages/wait?user=${enc(u.id)}&channel=${step.channel}&since=${enc(since)}${q ? `&q=${enc(q)}` : ''}&timeout=60`,
          subject: step.match.subject ?? null,
          linkPattern: step.link?.pattern ?? null,
          linkIndex: step.link?.index ?? null,
          open: step.open,
        };
        break;
      }
      case 'capture':
        out = { step, text: display, actor, url: null, warnings, var: step.var, selector: step.selector ?? null, attribute: step.attribute ?? null, textPattern: step.textPattern ?? null, required: step.required };
        break;
      case 'check':
        out = {
          step,
          text: display,
          actor,
          url: null,
          warnings,
          expect: step.expect,
          assert: step.assert
            ? { textPresent: step.assert.textPresent !== undefined ? text(step.assert.textPresent, 'assert.textPresent') : null, selector: step.assert.selector ?? null, urlMatches: step.assert.urlMatches ?? null }
            : null,
        };
        break;
      case 'instruction':
        out = { step, text: display, actor, url: null, warnings };
        break;
    }
    this.publish(project, { id: r.id, stepId, status });
    return out;
  }

  /** Start of an email step's message window: the nearest earlier step that was started, else the walkthrough start. */
  private emailSince(r: WalkthroughRow, row: StepRow): string {
    const prev = this.hub.db
      .prepare('SELECT started_at FROM walkthrough_steps WHERE walkthrough_id = ? AND position < ? AND started_at IS NOT NULL ORDER BY position DESC LIMIT 1')
      .get(r.id, row.position) as { started_at: string } | undefined;
    return prev?.started_at ?? r.started_at;
  }

  updateStep(project: Project, idOrKey: string, stepId: string, patch: StepPatch): WalkthroughView {
    const r = this.requireActive(project, idOrKey);
    const snapshot = this.snapshotOf(r);
    const step = snapshot.steps.find((s) => s.id === stepId);
    const row = this.stepRow(r.id, stepId);
    if (!step || !row) throw new HttpError(404, `Step "${stepId}" is not part of walkthrough ${r.key}`);
    const p = (isObj(patch) ? patch : {}) as Record<string, unknown>;

    let status = row.status;
    if (p.status !== undefined) {
      const allowed: StepStatus[] = ['pending', 'done', 'skipped', 'failed'];
      if (typeof p.status !== 'string' || !(allowed as string[]).includes(p.status)) throw new HttpError(400, `status must be one of ${allowed.join(', ')}`);
      status = p.status as StepStatus;
    }
    let note = row.note;
    if (p.note !== undefined) {
      if (typeof p.note !== 'string' || p.note.length > 4000) throw new HttpError(400, 'note must be a string of at most 4000 characters');
      note = p.note;
    }
    const data = parseJson<Record<string, unknown>>(row.data, {});
    if (p.data !== undefined) {
      if (!isObj(p.data)) throw new HttpError(400, 'data must be an object');
      Object.assign(data, p.data);
    }
    const vars = parseJson<Record<string, string>>(r.vars, {});
    if (p.value !== undefined) {
      if (step.kind !== 'capture') throw new HttpError(400, 'value is only for capture steps');
      if (typeof p.value !== 'string' || p.value.length > 2000) throw new HttpError(400, 'value must be a string of at most 2000 characters');
      vars[step.var] = p.value;
      data.value = p.value;
    }
    if (JSON.stringify(data).length > 64 * 1024) throw new HttpError(413, 'Step data is larger than 64 KB');

    const now = nowIso();
    const final = FINAL_STATUSES.includes(status);
    const statusChanged = p.status !== undefined && status !== row.status;
    const finishedAt = final ? (statusChanged || !row.finished_at ? now : row.finished_at) : null;
    const startedAt = row.started_at ?? (status === 'pending' ? null : now);
    let current = r.current_step_id;
    if (final && p.status !== undefined) current = this.nextPending(r.id, row.position, stepId);
    this.hub.db.transaction(() => {
      this.hub.db
        .prepare('UPDATE walkthrough_steps SET status = ?, note = ?, data = ?, started_at = ?, finished_at = ? WHERE walkthrough_id = ? AND step_id = ?')
        .run(status, note, JSON.stringify(data), startedAt, finishedAt, r.id, stepId);
      this.hub.db.prepare('UPDATE walkthroughs SET vars = ?, current_step_id = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(vars), current, now, r.id);
    })();
    this.publish(project, { id: r.id, stepId, status });
    return this.viewById(project, r.id);
  }

  /** The next pending step after `position` (else the first pending one anywhere, else null). */
  private nextPending(walkthroughId: string, position: number, except: string): string | null {
    const rows = this.stepRows(walkthroughId).filter((s) => s.status === 'pending' && s.step_id !== except && !parseJson<Record<string, unknown>>(s.data, {}).removed);
    return (rows.find((s) => s.position > position) ?? rows[0])?.step_id ?? null;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Screenshots

  addShot(project: Project, idOrKey: string, stepId: string, dataUrl: string): { id: string; bytes: number } {
    const r = this.requireRow(project, idOrKey);
    if (r.mode === 'quick') throw new HttpError(409, "Quick test runs don't keep screenshots");
    if (!this.stepRow(r.id, stepId)) throw new HttpError(404, `Step "${stepId}" is not part of walkthrough ${r.key}`);
    const m = typeof dataUrl === 'string' ? /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl) : null;
    if (!m) throw new HttpError(400, 'dataUrl must be "data:image/jpeg;base64,…" or "data:image/png;base64,…"');
    const data = Buffer.from(m[2], 'base64');
    if (!data.length) throw new HttpError(400, 'The screenshot is empty');
    const caps = this.caps;
    const kb = (n: number) => `${Math.round(n / 1024)} KB`;
    if (data.length > caps.shotBytes) throw new HttpError(413, `Screenshot is ${kb(data.length)}; at most ${kb(caps.shotBytes)} each (send a smaller JPEG)`);
    const perWt = (this.hub.db.prepare('SELECT COUNT(*) AS n FROM walkthrough_shots WHERE walkthrough_id = ?').get(r.id) as { n: number }).n;
    if (perWt >= caps.shotsPerWalkthrough) throw new HttpError(413, `Walkthrough ${r.key} already has ${perWt} screenshots (at most ${caps.shotsPerWalkthrough}); delete some first`);
    const total = (this.hub.db.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM walkthrough_shots WHERE project_id = ?').get(project.id) as { n: number }).n;
    if (total + data.length > caps.projectBytes) {
      throw new HttpError(413, `Screenshots of this project would take ${kb(total + data.length)}; at most ${Math.round(caps.projectBytes / 1024 / 1024)} MB (delete old walkthroughs)`);
    }
    const id = newId();
    const now = nowIso();
    this.hub.db
      .prepare('INSERT INTO walkthrough_shots (id, walkthrough_id, project_id, step_id, mime, bytes, data, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, r.id, project.id, stepId, m[1], data.length, data, now);
    this.touch(r.id, now);
    this.publish(project, { id: r.id, stepId, status: r.status });
    return { id, bytes: data.length };
  }

  getShot(project: Project, idOrKey: string, shotId: string): { mime: string; data: Buffer } | null {
    const r = this.requireRow(project, idOrKey);
    const s = this.hub.db.prepare('SELECT mime, data FROM walkthrough_shots WHERE walkthrough_id = ? AND id = ?').get(r.id, shotId) as { mime: string; data: Uint8Array } | undefined;
    return s ? { mime: s.mime, data: Buffer.from(s.data) } : null;
  }

  deleteShot(project: Project, idOrKey: string, shotId: string): void {
    const r = this.requireRow(project, idOrKey);
    const s = this.hub.db.prepare('SELECT step_id FROM walkthrough_shots WHERE walkthrough_id = ? AND id = ?').get(r.id, shotId) as { step_id: string } | undefined;
    if (!s) throw new HttpError(404, `Screenshot "${shotId}" not found`);
    this.hub.db.prepare('DELETE FROM walkthrough_shots WHERE id = ?').run(shotId);
    this.touch(r.id);
    this.publish(project, { id: r.id, stepId: s.step_id, status: r.status });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Finish / abandon / reopen / delete

  finish(project: Project, idOrKey: string, input: FinishInput): WalkthroughView {
    const r = this.requireActive(project, idOrKey);
    const b = (isObj(input) ? input : {}) as Record<string, unknown>;
    // Quick test runs: no sign-off (verdict and signedOffBy optional) and open steps are skipped (allowIncomplete implied).
    const quick = r.mode === 'quick';
    let verdict: Verdict | null = null;
    if (!quick || b.verdict !== undefined) {
      if (typeof b.verdict !== 'string' || !(VERDICTS as readonly string[]).includes(b.verdict)) throw new HttpError(400, `verdict must be one of ${VERDICTS.join(', ')}`);
      verdict = b.verdict as Verdict;
    }
    if (b.signedOffBy !== undefined && typeof b.signedOffBy !== 'string') throw new HttpError(400, 'signedOffBy must be a string');
    const by = typeof b.signedOffBy === 'string' ? b.signedOffBy.trim() : '';
    if (by.length > 100 || (!quick && !by)) throw new HttpError(400, 'signedOffBy is required (1 to 100 characters)');
    if (b.note !== undefined && (typeof b.note !== 'string' || b.note.length > 4000)) throw new HttpError(400, 'note must be a string of at most 4000 characters');
    const snapshot = this.snapshotOf(r);
    const optional = new Set(snapshot.steps.filter((s) => s.optional).map((s) => s.id));
    const open = this.stepRows(r.id).filter((s) => (s.status === 'pending' || s.status === 'active') && !parseJson<Record<string, unknown>>(s.data, {}).removed);
    const incomplete = open.filter((s) => !optional.has(s.step_id)).map((s) => s.step_id);
    if (incomplete.length && b.allowIncomplete !== true && !quick) {
      throw new HttpError(409, `${incomplete.length} required step${incomplete.length === 1 ? ' is' : 's are'} not finished: ${incomplete.join(', ')} (allowIncomplete: true marks them skipped)`, { incomplete });
    }
    const now = nowIso();
    this.hub.db.transaction(() => {
      // Steps left open (optional ones, or required ones with allowIncomplete) are recorded as skipped, "not run".
      const upd = this.hub.db.prepare("UPDATE walkthrough_steps SET status = 'skipped', note = CASE WHEN note = '' THEN 'not run' ELSE note END, finished_at = ? WHERE walkthrough_id = ? AND step_id = ?");
      for (const s of open) upd.run(now, r.id, s.step_id);
      this.hub.db
        .prepare("UPDATE walkthroughs SET status = 'finished', verdict = ?, signed_off_by = ?, signed_off_at = ?, summary_note = ?, finished_at = ?, current_step_id = NULL, updated_at = ? WHERE id = ?")
        .run(verdict, by, now, typeof b.note === 'string' ? b.note : '', now, now, r.id);
    })();
    this.publish(project, { id: r.id, status: 'finished' });
    return this.viewById(project, r.id);
  }

  abandon(project: Project, idOrKey: string, note?: string): WalkthroughView {
    const r = this.requireActive(project, idOrKey);
    if (note !== undefined && (typeof note !== 'string' || note.length > 4000)) throw new HttpError(400, 'note must be a string of at most 4000 characters');
    const now = nowIso();
    this.hub.db
      .prepare("UPDATE walkthroughs SET status = 'abandoned', summary_note = ?, finished_at = ?, updated_at = ? WHERE id = ?")
      .run(note ?? r.summary_note, now, now, r.id);
    this.publish(project, { id: r.id, status: 'abandoned' });
    return this.viewById(project, r.id);
  }

  reopen(project: Project, idOrKey: string): WalkthroughView {
    const r = this.requireRow(project, idOrKey);
    if (r.status !== 'active' && r.cleanup_status === 'cleaned') throw new HttpError(409, 'Its test data was cleaned up; start a new run', { code: 'cleaned' });
    if (r.status !== 'active') {
      const current = r.current_step_id ?? this.nextPending(r.id, -1, '');
      this.hub.db
        .prepare("UPDATE walkthroughs SET status = 'active', verdict = NULL, signed_off_by = NULL, signed_off_at = NULL, finished_at = NULL, current_step_id = ?, updated_at = ? WHERE id = ?")
        .run(current, nowIso(), r.id);
      this.publish(project, { id: r.id, status: 'active' });
    }
    return this.viewById(project, r.id);
  }

  delete(project: Project, idOrKey: string, opts: { users?: boolean; force?: boolean; log?: CleanupLog } = {}): Promise<{ deleted: string; users: number; kept: CleanupKept[] }> {
    return this.cleanupSvc.deleteRun(project, idOrKey, opts);
  }

  cleanupUserChanged(project: Project, userId: string, change: 'deleted' | 'kept' | 'unkept'): void {
    this.cleanupSvc.userChanged(project, userId, change);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Cleanup of test data (cleanup.ts)

  listCleanup(project: Project, opts: { status?: CleanupListStatus; mode?: WalkthroughListMode } = {}): CleanupList {
    return this.cleanupSvc.list(project, opts);
  }

  cleanupItem(project: Project, idOrKey: string): CleanupItem {
    return this.cleanupSvc.get(project, idOrKey);
  }

  cleanup(project: Project, input: CleanupInput, opts: { log?: CleanupLog } = {}): Promise<CleanupResult> {
    return this.cleanupSvc.cleanup(project, input, opts);
  }

  dismissCleanup(project: Project, idOrKey: string, note?: string): CleanupItem {
    return this.cleanupSvc.dismiss(project, idOrKey, note);
  }

  reopenCleanup(project: Project, idOrKey: string): CleanupItem {
    return this.cleanupSvc.reopen(project, idOrKey);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Summary

  summary(project: Project, idOrKey: string): WalkthroughSummary {
    const r = this.requireRow(project, idOrKey);
    const v = this.view(project, r);
    // Reports get shared: actor passwords are masked here (the view and resolve carry them for the extension).
    const actors = Object.fromEntries(Object.entries(v.actors).map(([k, a]) => [k, { ...a, password: '***' }]));
    const end = r.finished_at ? Date.parse(r.finished_at) : Date.now();
    return {
      walkthrough: this.brief(r),
      steps: v.steps.map((s) => ({ id: s.id, title: s.title, kind: s.kind, status: s.status, note: s.note, data: s.data, shots: s.shots.length })),
      vars: v.vars,
      actors,
      signoff: v.signoff,
      durationMs: Math.max(0, end - Date.parse(r.started_at)),
    };
  }

  summaryHtml(project: Project, idOrKey: string): string {
    const r = this.requireRow(project, idOrKey);
    const v = this.view(project, r);
    const s = this.summary(project, idOrKey);
    const shots = this.hub.db.prepare('SELECT id, step_id, mime, data FROM walkthrough_shots WHERE walkthrough_id = ? ORDER BY created_at, id').all(r.id) as { id: string; step_id: string; mime: string; data: Uint8Array }[];
    const shotsOf = new Map<string, string[]>();
    for (const x of shots) {
      const list = shotsOf.get(x.step_id) ?? [];
      // mime is image/jpeg or image/png (checked on upload); base64 needs no escaping.
      list.push(`<img alt="Screenshot of step ${esc(x.step_id)}" src="data:${esc(x.mime)};base64,${Buffer.from(x.data).toString('base64')}">`);
      shotsOf.set(x.step_id, list);
    }
    const time = (iso: string | null) => (iso ? `<time datetime="${esc(iso)}">${esc(iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z'))}</time>` : '<span class="faint">–</span>');
    const mins = Math.round(s.durationMs / 60000);
    const duration = mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`;
    const verdict = v.signoff.verdict;
    const pill = (text: string, kind: string) => `<span class="pill ${kind}">${esc(text)}</span>`;
    const statusKind = (st: string) => (st === 'done' || st === 'pass' ? 'ok' : st === 'failed' || st === 'fail' ? 'bad' : st === 'skipped' || st === 'partial' ? 'warn' : '');
    const dataText = (d: Record<string, unknown>) => {
      const keys = Object.keys(d);
      return keys.length ? `<pre>${esc(JSON.stringify(d, null, 2))}</pre>` : '';
    };
    const steps = v.steps
      .map(
        (st, i) => `<li class="step"><div class="head"><span class="n">${i + 1}</span><b>${esc(st.title)}</b> <span class="faint">${esc(st.kind)}${st.optional ? ' · optional' : ''}</span> ${pill(st.status, statusKind(st.status))}</div>
<p class="intent">${esc(st.intent)}</p>${st.note ? `<p class="note">${esc(st.note)}</p>` : ''}${dataText(st.data)}${(shotsOf.get(st.id) ?? []).join('')}</li>`,
      )
      .join('\n');
    const actors = Object.entries(v.actors)
      .map(([k, a]) => `<tr><td>${esc(k)}</td><td>${esc(a.name)}</td><td>${esc(a.email ?? '')}</td><td>${esc(a.role)}</td><td>${a.created ? 'fresh' : 'existing'}${a.missing ? ' (deleted)' : ''}</td></tr>`)
      .join('');
    const vars = Object.entries(v.vars)
      .map(([k, x]) => `<tr><td>${esc(k)}</td><td class="mono">${esc(x)}</td></tr>`)
      .join('');
    const c = v.counts;
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Walkthrough ${esc(v.key)} · ${esc(v.storyboard.name)}</title>
<style>
:root{color-scheme:light dark;--fg:#1d2433;--muted:#5b6577;--line:#d9dee7;--bg:#fff;--ok:#1f7a44;--bad:#b42318;--warn:#a15c07}
@media (prefers-color-scheme:dark){:root{--fg:#e6e9ef;--muted:#9aa3b2;--line:#323a48;--bg:#14181f}}
body{font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:var(--fg);background:var(--bg);margin:0 auto;max-width:960px;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:24px 0 8px}.faint{color:var(--muted)}.mono,pre{font-family:ui-monospace,Menlo,monospace}
.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:0 8px;font-size:12px}.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}
ol{list-style:none;padding:0}.step{border:1px solid var(--line);border-radius:8px;padding:12px;margin:0 0 12px;break-inside:avoid}
.step .n{display:inline-block;min-width:24px;font-weight:600}.intent{margin:6px 0}.note{white-space:pre-wrap;border-left:3px solid var(--line);padding-left:8px}
pre{font-size:12px;white-space:pre-wrap;word-break:break-word;background:rgba(127,127,127,.08);padding:8px;border-radius:6px}
img{display:block;max-width:100%;border:1px solid var(--line);border-radius:6px;margin:8px 0}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:0}dt{color:var(--muted)}dd{margin:0}
@media print{body{max-width:none}}
</style></head><body>
<h1>${esc(v.storyboard.name)} ${verdict ? pill(verdict, statusKind(verdict)) : pill(v.status, '')}</h1>
<p class="faint">Walkthrough <span class="mono">${esc(v.key)}</span>${v.label ? ` · ${esc(v.label)}` : ''} · ${esc(project.name)} · storyboard <span class="mono">${esc(v.storyboard.slug)}</span> v${v.storyboard.version}</p>
<dl><dt>Status</dt><dd>${esc(v.status)}</dd><dt>Started</dt><dd>${time(v.startedAt)}</dd><dt>Finished</dt><dd>${time(v.finishedAt)}</dd><dt>Duration</dt><dd>${esc(duration)}</dd>
<dt>Origin</dt><dd class="mono">${esc(v.origin || '–')}</dd><dt>Steps</dt><dd>${c.done} done, ${c.failed} failed, ${c.skipped} skipped, ${c.pending + c.active} open</dd>
<dt>Signed off</dt><dd>${v.signoff.signedOffBy ? `${esc(v.signoff.signedOffBy)} · ${time(v.signoff.signedOffAt)}` : '<span class="faint">–</span>'}</dd></dl>
${v.signoff.note ? `<p class="note">${esc(v.signoff.note)}</p>` : ''}
${v.warnings.length ? `<h2>Warnings</h2><ul>${v.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
<h2>Actors</h2><table><thead><tr><th>Actor</th><th>Name</th><th>Email</th><th>Role</th><th>User</th></tr></thead><tbody>${actors}</tbody></table>
${vars ? `<h2>Vars</h2><table><tbody>${vars}</tbody></table>` : ''}
<h2>Steps</h2><ol>
${steps}
</ol>
</body></html>`;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Housekeeping

  resetProject(projectId: string): void {
    this.hub.db.transaction(() => {
      this.hub.db.prepare('DELETE FROM walkthrough_shots WHERE project_id = ?').run(projectId);
      this.hub.db.prepare('DELETE FROM walkthrough_steps WHERE project_id = ?').run(projectId);
      this.hub.db.prepare('DELETE FROM walkthroughs WHERE project_id = ?').run(projectId);
    })();
  }

  purgeOlderThan(projectId: string, cutoffIso: string): number {
    return this.hub.db.transaction(() => {
      // Runs with test data still to clean stay, so their users remain traceable to a run.
      const w = this.hub.db
        .prepare("DELETE FROM walkthroughs WHERE project_id = ? AND status != 'active' AND cleanup_status != 'pending' AND updated_at < ?")
        .run(projectId, cutoffIso).changes;
      const s = this.hub.db.prepare('DELETE FROM page_snapshots WHERE project_id = ? AND created_at < ?').run(projectId, cutoffIso).changes;
      return w + s;
    })();
  }
}
