import { normalizeAppOrigins, type Project, type ProjectSettings } from '../repos/projects.js';
import type { UserInput } from '../repos/users.js';
import { HttpError, normalizeEmail, normalizePhone } from '../util.js';
import { Bundle, type DataEntry, type LoginRecipe, type UserSpec } from './schema.js';
import type { StoryboardServiceImpl } from './service.js';
import { canonical, dataSetContent, invalid, recipeContent, RESERVED_DATA_SET_SLUGS, RESERVED_STORYBOARD_SLUGS, storyboardContent } from './service.js';
import type { ImportMode, ImportResult, ValidationIssue } from './types.js';
import { recipeRolesOf, validateStoryboard, zodIssues, type StoredStoryboard, type ValidateContext, type ValidationUser } from './validate.js';

/** Storyboard bundles (docs/design/storyboards.md §3.6): export and transactional import. */

export const MASK = '***';
/** Data-set entries whose key or label looks secret: their literal values are masked on export without secrets. */
// "pin" only as its own word (pin, pin_code, pinCode, card-pin), not inside "shipping" or "spinner".
export const SECRET_KEY_RE = /pass(word)?|secret|token|otp|(?:^|[^a-zA-Z])[pP][iI][nN](?![a-z])/;
const SECRET_KEY_CI = /pass(word)?|secret|token|otp/i;
const isSecretKey = (k: string) => SECRET_KEY_CI.test(k) || SECRET_KEY_RE.test(k);

/** Literal (no "{{") values of secret-looking entries become "***"; templates and booleans stay. */
export function maskEntries(entries: DataEntry[]): DataEntry[] {
  return entries.map((e) => {
    if (!isSecretKey(e.key) && !(e.label && isSecretKey(e.label))) return e;
    const m = (v: string) => (v && !v.includes('{{') ? MASK : v);
    if (typeof e.value === 'string') return { ...e, value: m(e.value) };
    if (Array.isArray(e.value)) return { ...e, value: e.value.map(m) };
    return e;
  });
}

const isMasked = (v: DataEntry['value']) => v === MASK || (Array.isArray(v) && v.includes(MASK));

/** Masked values take the stored value of the same key; returns the indexes that stay masked (no stored value). */
export function unmaskEntries(entries: DataEntry[], stored: DataEntry[] | undefined): { entries: DataEntry[]; masked: number[] } {
  const masked: number[] = [];
  const out = entries.map((e, i) => {
    if (!isMasked(e.value)) return e;
    const old = stored?.find((x) => x.key === e.key);
    if (old && !isMasked(old.value)) return { ...e, value: old.value };
    masked.push(i);
    return e;
  });
  return { entries: out, masked };
}

const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];

export function exportBundle(svc: StoryboardServiceImpl, project: Project, opts: { storyboards?: string[]; secrets?: boolean } = {}): Bundle {
  const secrets = !!opts.secrets;
  const all = svc.repo.listStoryboards(project.id);
  const named = (opts.storyboards ?? []).map((s) => s.trim()).filter(Boolean);
  const sbs = named.length
    ? named.map((slug) => {
        const s = all.find((x) => x.slug === slug);
        if (!s) throw new HttpError(404, `Storyboard "${slug}" not found`);
        return s;
      })
    : all;
  const dataSets = new Set(sbs.flatMap((s) => s.steps.flatMap((st) => (st.kind === 'fill' ? [st.dataSet] : []))));
  const roles = new Set(sbs.flatMap((s) => [...s.actors.map((a) => a.role), ...recipeRolesOf(s)]));

  const users: UserSpec[] = [];
  for (const sb of sbs) {
    for (const a of sb.actors) {
      if (a.fresh || !a.user) continue;
      const u = svc.hub.users.resolve(project.id, a.user);
      if (!u?.email || users.some((x) => x.email === u.email)) continue;
      users.push({
        email: u.email,
        name: u.name,
        role: u.role,
        ...(u.phone ? { phone: u.phone } : {}),
        ...(secrets && u.password ? { password: u.password } : {}),
        ...(u.notes ? { notes: u.notes } : {}),
      });
    }
  }

  const s = project.settings;
  const proj: NonNullable<Bundle['project']> = {};
  if (s.appOrigins?.length) proj.appOrigins = s.appOrigins;
  if (s.roles?.length) proj.roles = s.roles;
  if (secrets && s.defaultPassword) proj.defaultPassword = s.defaultPassword;

  return {
    format: 'stubyard-storyboards',
    version: 1,
    ...(Object.keys(proj).length ? { project: proj } : {}),
    users,
    loginRecipes: svc.repo
      .listRecipes(project.id)
      .filter((r) => !named.length || roles.has(r.role))
      .map(recipeContent),
    dataSets: svc.repo
      .listDataSets(project.id)
      .filter((d) => !named.length || dataSets.has(d.slug))
      .map((d) => {
        const c = dataSetContent(d);
        return secrets ? c : { ...c, entries: maskEntries(c.entries) };
      }),
    storyboards: sbs.map(storyboardContent),
  };
}

/** "storyboards[0]" + "steps[3].url" → "storyboards[0].steps[3].url"; recipe and project paths stay as they are. */
function prefixed(prefix: string, issue: ValidationIssue): ValidationIssue {
  if (issue.path.startsWith('loginRecipes[') || issue.path.startsWith('project.')) return issue;
  return { ...issue, path: issue.path.startsWith('[') ? prefix + issue.path : `${prefix}.${issue.path}` };
}

type Collections = ImportResult['created'];
const empty = (): Collections => ({ users: [], loginRecipes: [], dataSets: [], storyboards: [] });

class DryRunRollback extends Error {}

/**
 * Order: project settings merge → users by email → recipes by role → data sets by slug → storyboards by slug. The whole
 * bundle is validated first (references are satisfied by DB ∪ bundle), then written in one transaction; a dry run
 * makes the same writes and rolls them back. "replace" removes the recipes, data sets and storyboards the bundle does
 * not have (the ones it has are updated in place, so ids, versions and walkthrough links survive).
 */
export function importBundle(svc: StoryboardServiceImpl, project: Project, raw: unknown, opts: { mode?: ImportMode; dryRun?: boolean } = {}): ImportResult {
  const hub = svc.hub;
  const mode = opts.mode ?? 'upsert';
  if (!['upsert', 'create-only', 'replace'].includes(mode)) throw new HttpError(400, 'mode must be "upsert", "create-only" or "replace"');
  const dryRun = !!opts.dryRun;
  const parsed = Bundle.safeParse(raw);
  if (!parsed.success) throw invalid('Bundle', zodIssues(parsed.error));
  const b = parsed.data;
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const seenIssue = new Set<string>();
  const addIssue = (list: ValidationIssue[], i: ValidationIssue) => {
    const k = `${i.code}|${i.path}|${i.message}`;
    if (!seenIssue.has(k)) {
      seenIssue.add(k);
      list.push(i);
    }
  };

  // Duplicates inside the bundle.
  const dupes = <T>(list: T[], key: (x: T) => string, path: (i: number) => string, what: string) => {
    const first = new Map<string, number>();
    list.forEach((x, i) => {
      const k = key(x);
      if (first.has(k)) addIssue(errors, { path: path(i), code: 'schema', message: `duplicate ${what} "${k}" (also at ${path(first.get(k)!)})` });
      else first.set(k, i);
    });
  };
  dupes(b.users, (u) => normalizeEmail(u.email) ?? '', (i) => `users[${i}].email`, 'user email');
  dupes(b.loginRecipes, (r) => r.role, (i) => `loginRecipes[${i}].role`, 'recipe role');
  dupes(b.dataSets, (d) => d.slug, (i) => `dataSets[${i}].slug`, 'data-set slug');
  dupes(b.storyboards, (s) => s.slug, (i) => `storyboards[${i}].slug`, 'storyboard slug');
  b.dataSets.forEach((d, i) => RESERVED_DATA_SET_SLUGS.includes(d.slug) && addIssue(errors, { path: `dataSets[${i}].slug`, code: 'schema', message: `"${d.slug}" is reserved` }));
  b.storyboards.forEach((s, i) => RESERVED_STORYBOARD_SLUGS.includes(s.slug) && addIssue(errors, { path: `storyboards[${i}].slug`, code: 'schema', message: `"${s.slug}" is reserved` }));

  // Project settings: appOrigins and roles are merged (union), defaultPassword replaced.
  const settings: ProjectSettings = { ...project.settings };
  if (b.project?.appOrigins) {
    const ok: string[] = [];
    b.project.appOrigins.forEach((o, i) => {
      try {
        ok.push(...normalizeAppOrigins([o]));
      } catch {
        addIssue(errors, { path: `project.appOrigins[${i}]`, code: 'schema', message: `"${o}" must be an origin like http://localhost:3183` });
      }
    });
    settings.appOrigins = union(settings.appOrigins ?? [], ok);
  }
  if (b.project?.roles) settings.roles = union(settings.roles ?? [], b.project.roles);
  if (b.project?.defaultPassword && b.project.defaultPassword !== MASK) settings.defaultPassword = b.project.defaultPassword;

  // What exists after the import: DB ∪ bundle (create-only keeps what is in the DB; replace drops what the bundle lacks).
  const keepDb = mode === 'create-only';
  const users: ValidationUser[] = hub.users.list(project.id).map((u) => ({ id: u.id, name: u.name, role: u.role, email: u.email, phone: u.phone, password: u.password }));
  b.users.forEach((u, i) => {
    const email = normalizeEmail(u.email);
    const at = users.findIndex((x) => x.email === email);
    const next: ValidationUser = { id: `bundle:users[${i}]`, name: u.name, role: u.role, email, phone: normalizePhone(u.phone) ?? null, password: u.password ?? null };
    if (at < 0) users.push(next);
    else if (!keepDb) users[at] = { ...users[at], name: u.name, role: u.role, phone: u.phone !== undefined ? next.phone : users[at].phone, password: u.password ?? users[at].password };
  });
  const recipes = new Map<string, LoginRecipe>(mode === 'replace' ? [] : svc.repo.listRecipes(project.id).map((r) => [r.role, r]));
  for (const r of b.loginRecipes) if (!(keepDb && recipes.has(r.role))) recipes.set(r.role, r);
  const dbDataSets = mode === 'replace' ? [] : svc.repo.listDataSets(project.id).map((d) => d.slug);
  const existingStoryboards = new Set(svc.repo.listStoryboards(project.id).map((s) => s.slug));
  const ctx: ValidateContext = {
    settings,
    dataSets: union(dbDataSets, b.dataSets.map((d) => d.slug)),
    recipes: [...recipes.values()],
    users,
    authenticators: hub.authenticators.list(project.id).map((a) => ({ label: a.label, testUserId: a.testUserId })),
  };
  const validated = new Map<number, StoredStoryboard>();
  b.storyboards.forEach((sb, i) => {
    if (keepDb && existingStoryboards.has(sb.slug)) return; // skipped below
    const v = validateStoryboard(ctx, sb);
    for (const e of v.errors) addIssue(errors, prefixed(`storyboards[${i}]`, e));
    for (const w of v.warnings) addIssue(warnings, prefixed(`storyboards[${i}]`, w));
    if (v.storyboard) validated.set(i, v.storyboard);
  });
  if (errors.length) throw invalid('Bundle', errors, warnings);

  const result: ImportResult = { ok: true, dryRun, created: empty(), updated: empty(), unchanged: empty(), skipped: [], warnings };
  const events: Parameters<StoryboardServiceImpl['changed']>[1][] = [];
  let usersChanged = false;
  let settingsChanged = false;
  const classify = (key: keyof Collections, id: string, r: { created: boolean; changed: boolean }) =>
    (r.created ? result.created : r.changed ? result.updated : result.unchanged)[key].push(id);
  /** Errors inside the transaction name the bundle item and roll everything back. */
  const at = <T>(path: string, fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof HttpError) throw new HttpError(e.statusCode === 409 ? 409 : 400, `Import failed at ${path}: ${e.message}`, { errors: [{ path, code: 'schema', message: e.message }], warnings });
      throw e;
    }
  };

  try {
    hub.db.transaction(() => {
      if (canonical(settings) !== canonical(project.settings)) {
        at('project', () => hub.projects.update(project.slug, { settings }));
        settingsChanged = true;
      }

      b.users.forEach((u, i) =>
        at(`users[${i}]`, () => {
          const email = normalizeEmail(u.email)!;
          const ex = hub.users.findByEmail(project.id, email);
          if (ex && mode === 'create-only') return result.skipped.push({ path: `users[${i}]`, reason: `user ${email} exists (create-only)` });
          const password = u.password !== undefined && u.password !== MASK ? u.password : undefined;
          if (ex) {
            const patch: UserInput = { name: u.name, role: u.role };
            if (u.phone !== undefined) patch.phone = u.phone;
            if (u.notes !== undefined) patch.notes = u.notes;
            if (password !== undefined) patch.password = password;
            const same =
              ex.name === u.name.trim() &&
              ex.role === u.role &&
              (patch.phone === undefined || normalizePhone(patch.phone) === ex.phone) &&
              (patch.notes === undefined || patch.notes === ex.notes) &&
              (password === undefined || (password || null) === ex.password);
            if (same) return result.unchanged.users.push(email);
            hub.users.update(project.id, ex.id, patch);
            result.updated.users.push(email);
          } else {
            hub.users.create(project.id, { name: u.name, role: u.role, email, phone: u.phone ?? null, notes: u.notes ?? '', password: password ?? null });
            result.created.users.push(email);
          }
          usersChanged = true;
        }),
      );

      if (mode === 'replace') {
        const keep = (list: { slug?: string; role?: string }[], k: 'slug' | 'role') => new Set(list.map((x) => String(x[k])));
        const sbKeep = keep(b.storyboards, 'slug');
        for (const s of svc.repo.listStoryboards(project.id)) if (!sbKeep.has(s.slug) && svc.repo.deleteStoryboard(project.id, s.slug)) events.push({ kind: 'storyboard', slug: s.slug, deleted: true });
        const dsKeep = keep(b.dataSets, 'slug');
        for (const d of svc.repo.listDataSets(project.id)) if (!dsKeep.has(d.slug) && svc.repo.deleteDataSet(project.id, d.slug)) events.push({ kind: 'dataSet', slug: d.slug, deleted: true });
        const rKeep = keep(b.loginRecipes, 'role');
        for (const r of svc.repo.listRecipes(project.id)) if (!rKeep.has(r.role) && svc.repo.deleteRecipe(project.id, r.role)) events.push({ kind: 'loginRecipe', slug: r.role, deleted: true });
      }

      b.loginRecipes.forEach((r, i) =>
        at(`loginRecipes[${i}]`, () => {
          if (keepDb && svc.repo.getRecipe(project.id, r.role)) return result.skipped.push({ path: `loginRecipes[${i}]`, reason: `login recipe "${r.role}" exists (create-only)` });
          const s = svc.saveRecipe(project, r);
          classify('loginRecipes', r.role, s);
          if (s.changed) events.push({ kind: 'loginRecipe', slug: r.role });
        }),
      );

      b.dataSets.forEach((d, i) =>
        at(`dataSets[${i}]`, () => {
          const ex = svc.repo.getDataSet(project.id, d.slug);
          if (keepDb && ex) return result.skipped.push({ path: `dataSets[${i}]`, reason: `data set "${d.slug}" exists (create-only)` });
          const un = unmaskEntries(d.entries, ex?.entries);
          for (const j of un.masked) {
            warnings.push({ path: `dataSets[${i}].entries[${j}].value`, code: 'masked_value', message: `the value of "${d.entries[j].key}" is masked ("${MASK}") and there is no stored value; it is imported as "${MASK}"` });
          }
          const s = svc.saveDataSet(project, { ...d, entries: un.entries });
          classify('dataSets', d.slug, s);
          if (s.changed) events.push({ kind: 'dataSet', slug: d.slug });
        }),
      );

      b.storyboards.forEach((sb, i) =>
        at(`storyboards[${i}]`, () => {
          const x = validated.get(i);
          if (!x) return result.skipped.push({ path: `storyboards[${i}]`, reason: `storyboard "${sb.slug}" exists (create-only)` });
          const s = svc.saveStoryboard(project, x);
          classify('storyboards', sb.slug, s);
          if (s.changed) events.push({ kind: 'storyboard', slug: sb.slug });
        }),
      );

      if (dryRun) throw new DryRunRollback();
    })();
  } catch (e) {
    if (!(e instanceof DryRunRollback)) throw e;
  }

  if (!dryRun) {
    if (settingsChanged) {
      const p = hub.projects.get(project.id);
      hub.bus.publish({ type: 'project.updated', projectId: project.id, data: p });
    }
    if (usersChanged) hub.bus.publish({ type: 'user.changed', projectId: project.id, data: { imported: true } });
    for (const ev of events) svc.changed(project.id, ev);
  }
  return result;
}
