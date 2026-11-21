import type { z } from 'zod';
import { variablesOf } from '../autoreplies/template.js';
import type { ProjectSettings } from '../repos/projects.js';
import { normalizeEmail, normalizePhone } from '../util.js';
import { DEFAULT_PASSWORD, parseVariable } from './render.js';
import { Storyboard, type LoginRecipe } from './schema.js';
import type { StoredStep, StoryboardRefs, ValidationIssue, ValidationResult } from './types.js';

/**
 * Reference validation of a storyboard (docs/design/storyboards.md §1.4). Pure: the caller hands in what exists
 * (data sets, recipes, users, authenticators, settings) - from the DB, or DB ∪ bundle for an import.
 */

/** A test user as validation sees it (DB users, or users a bundle is about to create). */
export interface ValidationUser {
  id: string;
  name: string;
  role: string;
  email: string | null;
  phone: string | null;
  password: string | null;
}

export interface ValidateContext {
  settings: ProjectSettings;
  /** Slugs of the data sets that exist (or will exist). */
  dataSets: string[];
  recipes: LoginRecipe[];
  users: ValidationUser[];
  authenticators: { label: string; testUserId: string | null }[];
}

/** A parsed storyboard whose steps all have ids. */
export type StoredStoryboard = Omit<Storyboard, 'steps'> & { steps: StoredStep[] };

/** zod path → "steps[3].url". */
export function formatPath(path: readonly PropertyKey[], prefix = ''): string {
  let out = prefix;
  for (const p of path) {
    if (typeof p === 'number') out += `[${p}]`;
    else out += out ? `.${String(p)}` : String(p);
  }
  return out;
}

/** Every zod issue as a ValidationIssue (code "schema"); `prefix` = "storyboards[0]" for bundles. */
export function zodIssues(error: z.ZodError, prefix = ''): ValidationIssue[] {
  return error.issues.map((i) => ({ path: formatPath(i.path, prefix) || prefix || '(root)', code: 'schema' as const, message: i.message }));
}

/** "Storyboard is invalid (3 problems)". */
export const invalidMessage = (what: string, n: number) => `${what} is invalid (${n} problem${n === 1 ? '' : 's'})`;

/** Same lookup as UserRepo.resolve (id, email, phone, name, role, email local part), on a list. */
export function resolveUserRef(users: ValidationUser[], ref: string): ValidationUser | null {
  const r = ref.trim();
  if (!r) return null;
  const byId = users.find((u) => u.id === r);
  if (byId) return byId;
  if (r.includes('@')) {
    const e = normalizeEmail(r);
    return users.find((u) => u.email === e) ?? null;
  }
  if (/^[+\d][\d\s\-().]{5,}$/.test(r)) {
    const p = normalizePhone(r);
    return users.find((u) => u.phone === p) ?? null;
  }
  const lower = r.toLowerCase();
  return users.find((u) => u.name.toLowerCase() === lower) ?? users.find((u) => u.role === lower) ?? users.find((u) => u.email?.split('@')[0] === lower) ?? null;
}

/** Step ids: explicit ones stay; missing ones become s<position> (the next free number when taken). */
export function assignStepIds(steps: Storyboard['steps']): StoredStep[] {
  const taken = new Set(steps.map((s) => s.id).filter((x): x is string => !!x));
  return steps.map((s, i) => {
    if (s.id) return s as StoredStep;
    let n = i + 1;
    while (taken.has(`s${n}`)) n++;
    taken.add(`s${n}`);
    return { ...s, id: `s${n}` } as StoredStep;
  });
}

/** The actor key of every step: its own, else the previous step's (first step: the first actor). */
export function effectiveActors(sb: Pick<Storyboard, 'actors' | 'steps'>): (string | null)[] {
  let cur: string | null = sb.actors[0]?.key ?? null;
  return sb.steps.map((s) => {
    if (s.actor) cur = s.actor;
    return cur;
  });
}

/** Recipe roles the storyboard's login and logout steps use (step.recipe, else the actor's role). */
export function recipeRolesOf(sb: Pick<Storyboard, 'actors' | 'steps'>): string[] {
  const actors = new Map(sb.actors.map((a) => [a.key, a]));
  const eff = effectiveActors(sb);
  const out = new Set<string>();
  sb.steps.forEach((s, i) => {
    if (s.kind !== 'login' && s.kind !== 'logout') return;
    const role = (s.kind === 'login' ? s.recipe : undefined) ?? actors.get(eff[i] ?? '')?.role;
    if (role) out.add(role);
  });
  return [...out];
}

export function refsOf(sb: Pick<Storyboard, 'actors' | 'steps' | 'inputs'>): StoryboardRefs {
  const uniq = (xs: string[]) => [...new Set(xs)];
  return {
    dataSets: uniq(sb.steps.flatMap((s) => (s.kind === 'fill' ? [s.dataSet] : []))),
    roles: uniq([...sb.actors.map((a) => a.role), ...sb.steps.flatMap((s) => (s.kind === 'login' && s.recipe ? [s.recipe] : []))]),
    vars: { captured: uniq(sb.steps.flatMap((s) => (s.kind === 'capture' ? [s.var] : []))), inputs: sb.inputs.map((x) => x.name) },
  };
}

const EMPTY_REFS: StoryboardRefs = { dataSets: [], roles: [], vars: { captured: [], inputs: [] } };

/** Template fields of a step, with their path below the step. */
function templatesOf(s: StoredStep): { field: string; text: string }[] {
  const out: { field: string; text: string }[] = [];
  if ('url' in s && typeof s.url === 'string') out.push({ field: 'url', text: s.url });
  if (s.kind === 'email' && s.match.text) out.push({ field: 'match.text', text: s.match.text });
  if (s.kind === 'check' && s.assert?.textPresent) out.push({ field: 'assert.textPresent', text: s.assert.textPresent });
  return out;
}

/**
 * Validates a storyboard: zod first (code "schema"; nothing else is checked when that fails), then the references.
 * Returns the parsed storyboard with step ids assigned when the schema passed.
 */
export function validateStoryboard(ctx: ValidateContext, input: unknown): ValidationResult & { storyboard: StoredStoryboard | null } {
  const parsed = Storyboard.safeParse(input);
  if (!parsed.success) return { ok: false, errors: zodIssues(parsed.error), warnings: [], refs: EMPTY_REFS, storyboard: null };
  const raw = parsed.data;
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const seen = new Set<string>();
  const add = (list: ValidationIssue[], issue: ValidationIssue) => {
    const k = `${issue.code}|${issue.path}|${issue.message}`;
    if (seen.has(k)) return;
    seen.add(k);
    list.push(issue);
  };
  const err = (path: string, code: ValidationIssue['code'], message: string, expected?: string[]) => add(errors, { path, code, message, ...(expected ? { expected } : {}) });
  const warn = (path: string, code: ValidationIssue['code'], message: string, expected?: string[]) => add(warnings, { path, code, message, ...(expected ? { expected } : {}) });

  // Unique keys inside the storyboard.
  const dupes = <T>(list: T[], key: (x: T) => string, path: (i: number) => string, what: string) => {
    const first = new Map<string, number>();
    list.forEach((x, i) => {
      const k = key(x);
      if (first.has(k)) err(path(i), 'schema', `duplicate ${what} "${k}" (also at ${path(first.get(k)!)})`);
      else first.set(k, i);
    });
  };
  dupes(raw.actors, (a) => a.key, (i) => `actors[${i}].key`, 'actor key');
  dupes(raw.inputs, (x) => x.name, (i) => `inputs[${i}].name`, 'input name');
  const explicit: { id: string; i: number }[] = raw.steps.flatMap((s, i) => (s.id ? [{ id: s.id, i }] : []));
  const firstId = new Map<string, number>();
  for (const { id, i } of explicit) {
    if (firstId.has(id)) err(`steps[${i}].id`, 'duplicate_step_id', `step id "${id}" is also used by steps[${firstId.get(id)}]`);
    else firstId.set(id, i);
  }
  const sb: StoredStoryboard = { ...raw, steps: assignStepIds(raw.steps) };

  const settings = ctx.settings;
  const actorKeys = sb.actors.map((a) => a.key);
  const actorByKey = new Map(sb.actors.map((a) => [a.key, a]));
  const recipeByRole = new Map(ctx.recipes.map((r) => [r.role, r]));
  const hasOrigins = (settings.appOrigins?.length ?? 0) > 0;
  const userRoles = new Set(ctx.users.map((u) => u.role));
  if (!hasOrigins) warn('project.appOrigins', 'no_app_origins', 'The project has no appOrigins: relative URLs cannot be opened and the extension cannot find the project');

  // Actors: roles and users.
  const actorUser = new Map<string, ValidationUser | null>();
  sb.actors.forEach((a, i) => {
    if (!(settings.roles ?? []).includes(a.role) && !userRoles.has(a.role)) {
      warn(`actors[${i}].role`, 'unknown_role', `role "${a.role}" is not in the project roles and no test user has it`, settings.roles ?? []);
    }
    if (a.fresh) return actorUser.set(a.key, null);
    const u = resolveUserRef(ctx.users, a.user ?? a.role);
    actorUser.set(a.key, u);
    if (!u) {
      if (a.user) err(`actors[${i}].user`, 'missing_user', `"${a.user}" does not match a test user (id, email, phone, name or role)`);
      else err(`actors[${i}].user`, 'missing_user', `no test user has the role "${a.role}"; add one, name a user, or make the actor fresh`, [...userRoles]);
    }
  });

  // Variables: inputs, and the first capture step of each var.
  const inputs = new Set(sb.inputs.map((x) => x.name));
  const captureAt = new Map<string, number>();
  sb.steps.forEach((s, i) => {
    if (s.kind === 'capture' && !captureAt.has(s.var)) captureAt.set(s.var, i);
  });
  /** at = the step index using the template (-1 = before every step, e.g. an actor name). */
  const checkTemplate = (path: string, text: string, at: number, allowUser: boolean) => {
    for (const name of variablesOf(text)) {
      const v = parseVariable(name);
      if (!v) {
        err(path, 'unknown_variable', `{{${name}}} is not a storyboard variable`);
        continue;
      }
      if (v.t === 'user' && v.actor && !actorByKey.has(v.actor)) err(path, 'unknown_variable', `{{${name}}} refers to actor "${v.actor}", which the storyboard does not have`, actorKeys);
      else if (v.t === 'user' && !v.actor && !allowUser) err(path, 'unknown_variable', `{{${name}}} has no actor here; use {{users.<actorKey>.…}}`);
      else if (v.t === 'vars' && !inputs.has(v.name)) {
        const c = captureAt.get(v.name);
        if (c === undefined) err(path, 'var_not_captured', `{{vars.${v.name}}} is neither an input nor captured by a capture step`, [...inputs, ...captureAt.keys()]);
        else if (c >= at) err(path, 'var_used_before_capture', `{{vars.${v.name}}} is used before steps[${c}] captures it`);
      }
    }
  };
  sb.actors.forEach((a, i) => {
    if (a.name) checkTemplate(`actors[${i}].name`, a.name, -1, false);
  });

  const loginActors = new Set<string>();
  sb.steps.forEach((s, i) => {
    const p = `steps[${i}]`;
    if (s.actor && !actorByKey.has(s.actor)) err(`${p}.actor`, 'unknown_actor', `actor "${s.actor}" is not in actors[].key`, actorKeys);
    for (const t of templatesOf(s)) {
      checkTemplate(`${p}.${t.field}`, t.text, i, true);
      if (t.field === 'url' && t.text.trim().startsWith('/') && !hasOrigins) warn(`${p}.url`, 'relative_url_no_origin', `"${t.text}" is relative and the project has no appOrigins`);
    }
    if (s.kind === 'fill' && !ctx.dataSets.includes(s.dataSet)) err(`${p}.dataSet`, 'missing_data_set', `data set "${s.dataSet}" does not exist`, ctx.dataSets);
    if (s.kind === 'login') {
      const actor = actorByKey.get(s.actor);
      if (actor) loginActors.add(actor.key);
      const role = s.recipe ?? actor?.role;
      if (!role) return;
      const recipe = recipeByRole.get(role);
      if (!recipe) return err(`${p}.recipe`, 'missing_login_recipe', `no login recipe for role "${role}"${s.recipe ? '' : ` (actor "${s.actor}")`}`, [...recipeByRole.keys()]);
      if (recipe.twoFactor.kind === 'totp' && actor) {
        const path = `loginRecipes[${role}].twoFactor.authenticator`;
        const label = recipe.twoFactor.authenticator;
        if (label) {
          if (!ctx.authenticators.some((a) => a.label.toLowerCase() === label.toLowerCase())) {
            err(path, 'missing_authenticator', `no authenticator labelled "${label}"`, ctx.authenticators.map((a) => a.label));
          }
        } else if (actor.fresh) {
          warn(path, 'missing_authenticator', `actor "${actor.key}" is a fresh user, who has no linked authenticator; name one in twoFactor.authenticator`);
        } else {
          const u = actorUser.get(actor.key);
          if (u && !ctx.authenticators.some((a) => a.testUserId === u.id)) {
            err(path, 'missing_authenticator', `no authenticator is linked to ${u.email ?? u.name} (actor "${actor.key}"); link one or name it in twoFactor.authenticator`);
          }
        }
      }
    }
  });

  // Passwords of the actors that log in.
  if (!settings.defaultPassword) {
    sb.actors.forEach((a, i) => {
      if (!loginActors.has(a.key)) return;
      const u = actorUser.get(a.key);
      if (a.fresh || (u && !u.password)) warn(`actors[${i}]`, 'no_password', `actor "${a.key}" has no password and the project has no defaultPassword; ${DEFAULT_PASSWORD} is used`);
    });
  }

  return { ok: errors.length === 0, errors, warnings, refs: refsOf(sb), storyboard: sb };
}
