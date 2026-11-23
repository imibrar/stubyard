import { z } from 'zod';
import { TEMPLATE_VARIABLE_HELP } from './render.js';
import {
  Actor,
  Bundle,
  DataEntry,
  DataSet,
  FIELD_KINDS,
  Input,
  LoginRecipe,
  PageSnapshot,
  ROLE,
  RUN_MODES,
  STEP_KINDS,
  STEP_STATUSES,
  Step,
  Storyboard,
  TWO_FACTOR_KINDS,
  UserSpec,
  VERDICTS,
  WALKTHROUGH_STATUSES,
  type BundleInput,
  type StepKind,
} from './schema.js';
import type { ValidationCode } from './types.js';

/**
 * The storyboards ontology for MCP `describe_storyboards` (docs/design/storyboards.md §4.1). The prose is hand-written;
 * the shapes (jsonSchema, field types, required, defaults, enums, limits) are generated from the zod contract in
 * schema.ts, so they cannot drift. Every field of every schema must have a doc entry here: `ontologyDrift()` lists
 * the gaps and the MCP e2e test fails on any.
 */

type Json = Record<string, unknown>;
// JSON Schema nodes as z.toJSONSchema emits them.
type JS = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// ------------------------------------------------------------------------------------------------ the pilot bundle

/**
 * The Class PROvia pilot (design §9). docs/examples/classprovia-storyboards.json is this constant, byte for byte in
 * content (the MCP e2e test compares them); the examples below are cut from it.
 */
export const CLASS_PROVIA_PILOT = {
  format: 'stubyard-storyboards',
  version: 1,
  project: { appOrigins: ['http://localhost:3183'], roles: ['admin', 'participant'] },
  users: [
    {
      email: 'admin@classprovia.test',
      name: 'Class PROvia admin',
      role: 'admin',
      notes: 'Super admin. Password = SEED_USER_PASSWORD: set it in stubyard by hand, never in this file.',
    },
  ],
  loginRecipes: [
    {
      role: 'participant',
      name: 'Participant portal',
      loginUrl: '/auth/person/login',
      fields: { username: '#email', password: '#password', submit: 'button[type=submit]' },
      twoFactor: { kind: 'none' },
      logoutUrl: null,
      notes: 'Sign out from the user menu (top right).',
    },
    {
      role: 'admin',
      name: 'Staff (Admin)',
      loginUrl: '/auth/staff-user/login',
      fields: { username: '#email', password: '#password', submit: 'button[type=submit]' },
      twoFactor: { kind: 'totp', selector: '#code', authenticator: 'Class PROvia admin 2FA' },
      logoutUrl: null,
      notes: '2FA page: /auth/staff-user/2fa-challenge (6-box code input, id=code).',
    },
  ],
  dataSets: [
    {
      slug: 'person-sign-up',
      name: 'Participant sign-up',
      match: { urlPattern: '/auth/person/register' },
      entries: [
        { key: 'email', value: '{{user.email}}' },
        { key: 'password', value: '{{user.password}}' },
        { key: 'confirmPassword', value: '{{user.password}}' },
        { key: 'title', value: 'Dr', kind: 'radix-select', note: 'VERIFY id=title on the trigger' },
        { key: 'firstName', value: '{{user.firstName}}' },
        { key: 'lastName', value: '{{user.lastName}}' },
        { key: 'phone', value: '{{fake.phone}}', note: 'VERIFY: phone widget with country SA; may rewrite the value' },
        { key: 'nationality', value: 'Saudi' },
        { key: 'country', value: 'Saudi Arabia' },
        { key: 'organisationName', value: 'Flow Test Org {{unique}}' },
        { key: 'jobTitle', value: 'QA Tester' },
        { key: 'preferredLanguage', value: 'English', kind: 'radix-select' },
      ],
    },
    {
      slug: 'event-registration',
      name: 'Event registration form (Form Builder)',
      match: { urlPattern: '/register/*' },
      description: 'Profile block of the published registration form (fld-<fieldCode>). Fields of later steps: scan each step and add them.',
      entries: [
        { key: 'fld-title', value: 'Dr', kind: 'radix-select' },
        { key: 'fld-first_name', value: '{{user.firstName}}' },
        { key: 'fld-last_name', value: '{{user.lastName}}' },
        { key: 'fld-email', value: '{{user.email}}' },
        { key: 'fld-mobile', value: '{{fake.phone}}' },
        { key: 'fld-phone', value: '{{fake.phone}}', note: 'built-in fallback form' },
        { key: 'fld-country', value: 'Saudi Arabia', kind: 'radix-select', note: 'VERIFY option label' },
        { key: 'fld-organisation', value: 'Flow Test Org {{unique}}' },
        { key: 'fld-job_title', value: 'QA Tester' },
      ],
    },
  ],
  storyboards: [
    {
      slug: 'registration-approval',
      name: 'Registration needing approval',
      intent: 'A new participant registers in a category that needs approval, an admin approves it, and the participant is told.',
      tags: ['registration', 'REG-02', 'REG-03'],
      inputs: [{ name: 'event', label: 'Event code', default: 'HCE27' }],
      actors: [
        { key: 'participant', label: 'New participant', role: 'participant', fresh: true, name: '{{fake.firstName}} Flow-{{unique}}' },
        { key: 'admin', label: 'Admin', role: 'admin', user: 'admin@classprovia.test' },
      ],
      steps: [
        { id: 'signup-open', kind: 'open', actor: 'participant', title: 'Open sign-up', intent: 'Open the participant sign-up page.', url: '/auth/person/register' },
        { id: 'signup-fill', kind: 'fill', title: 'Fill sign-up form', intent: "Fill the new participant's account details.", dataSet: 'person-sign-up' },
        { id: 'signup-submit', kind: 'instruction', title: 'Create account', intent: "Click Create account and wait for the 'check your email' message.", target: { text: 'Create account' } },
        { id: 'confirm-email', kind: 'email', actor: 'participant', title: 'Confirm email address', intent: 'Open the confirmation link from the sign-up email.', link: { pattern: 'confirm-email' }, timeoutSec: 180 },
        { id: 'confirm-check', kind: 'check', title: 'Account confirmed', intent: 'Check the page says the email address is confirmed.', expect: 'A confirmation message is shown.' },
        { id: 'participant-login', kind: 'login', actor: 'participant', title: 'Log in as the participant', intent: 'Sign in with the new account.' },
        { id: 'register-open', kind: 'open', title: 'Open event registration', intent: 'Go to the list of events open for registration.', url: '/register' },
        { id: 'pick-category', kind: 'instruction', title: 'Choose event and category', intent: "Pick event {{vars.event}}, then a category marked 'Approval needed'." },
        { id: 'register-fill', kind: 'fill', title: 'Fill registration form', intent: 'Fill the registration form; on a multi-step form press Fill on each step and click Next yourself.', dataSet: 'event-registration' },
        { id: 'register-submit', kind: 'instruction', title: 'Submit registration', intent: 'Click Submit registration.', target: { text: 'Submit registration' } },
        { id: 'reg-no', kind: 'capture', title: 'Note the registration number', intent: 'Read the registration number shown after submitting.', var: 'regNo', textPattern: 'Registration number:\\s*([A-Z0-9]+-[A-Z]-\\d+)' },
        { id: 'pending-check', kind: 'check', title: 'Status is Pending review', intent: 'Check the registration waits for approval.', expect: 'Status badge shows Pending review; no pass is issued.', assert: { textPresent: 'Pending review' }, screenshot: 'required' },
        { id: 'participant-logout', kind: 'logout', title: 'Sign out participant', intent: 'Sign out from the user menu.' },
        { id: 'admin-login', kind: 'login', actor: 'admin', title: 'Log in as admin', intent: 'Sign in as the admin; the 2FA code is filled when the code page appears.' },
        { id: 'admin-open', kind: 'open', title: 'Open registrations', intent: 'Open the admin registrations list.', url: '/admin/registrations' },
        { id: 'admin-find', kind: 'instruction', title: 'Find the registration', intent: 'Search for {{vars.regNo}} and open the record.' },
        { id: 'approve', kind: 'instruction', title: 'Approve', intent: 'Click Approve on registration {{vars.regNo}} and confirm.', target: { text: 'Approve' } },
        { id: 'approved-check', kind: 'check', title: 'Approved', intent: 'Check the registration is approved or confirmed.', expect: 'Status becomes Approved / Confirmed (paid categories: waiting for payment).', screenshot: 'required' },
        { id: 'admin-logout', kind: 'logout', title: 'Sign out admin', intent: 'Sign out from the user menu.' },
        { id: 'decision-email', kind: 'email', actor: 'participant', title: 'Participant is told', intent: 'Check the participant received the decision email for {{vars.regNo}}.', match: { subject: '/confirmed|Complete your payment/', text: '{{vars.regNo}}' }, open: 'none' },
        { id: 'final-check', kind: 'check', title: 'Email content', intent: 'Check the email names the registration number and the right outcome.', expect: 'Email says registration {{vars.regNo}} is confirmed (free) or approved with a payment request (paid).' },
      ],
    },
  ],
} satisfies BundleInput;

const PILOT = CLASS_PROVIA_PILOT;
const PILOT_SB = PILOT.storyboards[0];
const pilotStep = (id: string) => PILOT_SB.steps.find((s) => s.id === id)!;

// ------------------------------------------------------------------------------------------------ JSON Schema helpers

const schemaCache = new Map<z.ZodType, JS>();
/** The input-side JSON Schema of a zod schema (what a client may send: fields with defaults are optional). */
export function jsonSchemaOf(s: z.ZodType): JS {
  let js = schemaCache.get(s);
  if (!js) {
    js = z.toJSONSchema(s, { io: 'input' }) as JS;
    schemaCache.set(s, js);
  }
  return js;
}

/** The step schema of one kind (an option of the Step discriminated union). */
export function stepSchemaOf(kind: StepKind): z.ZodType {
  const opts = (Step as unknown as { options: { shape: { kind: { value: string } } }[] }).options;
  const o = opts.find((x) => x.shape.kind.value === kind);
  if (!o) throw new Error(`no step schema for kind ${kind}`);
  return o as unknown as z.ZodType;
}

function typeOf(p: JS): string {
  if (p.const !== undefined) return JSON.stringify(p.const);
  if (p.enum) return (p.enum as unknown[]).map((v) => JSON.stringify(v)).join(' | ');
  const alt = (p.anyOf ?? p.oneOf) as JS[] | undefined;
  if (alt) return [...new Set(alt.map(typeOf))].join(' | ');
  if (p.type === 'array') return `${p.items ? typeOf(p.items as JS) : 'unknown'}[]`;
  if (p.type === 'integer') return 'integer';
  return String(p.type ?? 'any');
}

function limits(p: JS): string[] {
  const out: string[] = [];
  if (p.pattern) out.push(`pattern ${p.pattern}`);
  if (p.minLength !== undefined) out.push(`min length ${p.minLength}`);
  if (p.maxLength !== undefined) out.push(`max length ${p.maxLength}`);
  if (p.minimum !== undefined) out.push(`min ${p.minimum}`);
  if (p.maximum !== undefined) out.push(`max ${p.maximum}`);
  if (p.minItems !== undefined) out.push(`min ${p.minItems} items`);
  if (p.maxItems !== undefined) out.push(`max ${p.maxItems} items`);
  if (p.format) out.push(`format ${p.format}`);
  return out;
}

export interface FieldInfo {
  name: string;
  type: string;
  required: boolean;
  default?: unknown;
  enum?: unknown[];
  rules: string;
  refersTo?: string;
}

type FieldDoc = string | { rules: string; refersTo?: string };

/** Fields of a JSON Schema object, nested objects flattened as "a.b" (and "list[].x" for the arrays named in `arrays`). */
function schemaFields(js: JS, prefix = '', arrays: string[] = []): Omit<FieldInfo, 'rules' | 'refersTo'>[] {
  const props = (js.properties ?? {}) as Record<string, JS>;
  const req = new Set((js.required ?? []) as string[]);
  const out: Omit<FieldInfo, 'rules' | 'refersTo'>[] = [];
  for (const [k, p] of Object.entries(props)) {
    const name = prefix + k;
    const f: Omit<FieldInfo, 'rules' | 'refersTo'> = { name, type: typeOf(p), required: req.has(k) };
    if (p.default !== undefined) f.default = p.default;
    if (p.enum) f.enum = p.enum as unknown[];
    (f as Json).limits = limits(p);
    out.push(f);
    if (p.type === 'object' && p.properties) out.push(...schemaFields(p, `${name}.`, arrays));
    if (p.type === 'array' && arrays.includes(name) && (p.items as JS | undefined)?.properties) out.push(...schemaFields(p.items as JS, `${name}[].`, arrays));
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ objects

interface ObjectDef {
  name: string;
  is: string;
  key?: string;
  /** MCP tools that write / read it. */
  tools?: string[];
  /** zod source: jsonSchema and fields are generated from it. */
  schema?: z.ZodType;
  /** Hand-written JSON Schema, for objects that have no zod schema (REST-only or reserved). */
  jsonSchema?: JS;
  /** Array fields whose item fields are listed too ("fields[].key"). */
  arrays?: string[];
  docs: Record<string, FieldDoc>;
  validation: string[];
  example: unknown;
  pitfalls: string[];
}

const T = 'Template: text with {{variables}} (see describe_storyboards {object:"templateVariables"}).';
const URL_T = `${T} Absolute ("https://…") or relative ("/path"): a relative URL is prefixed with the walkthrough origin (app.origin, default the first project appOrigin).`;

/** Fields shared by every step kind. */
const STEP_BASE_DOCS: Record<string, FieldDoc> = {
  id: 'Stable step id (lowercase letters, digits, - and _). Give one: walkthrough results, captures and refreshes are keyed by it. Missing ids become s1, s2… by position (the next free number when taken). Must be unique in the storyboard (duplicate_step_id).',
  title: 'Short label shown in the side panel and the summary (2-6 words). Rendered like other templates when the step is resolved, so {{vars.x}} shows its value.',
  intent: 'One plain-language sentence: what the human does on this step and why. No CSS selectors. Rendered when the step is resolved, so {{vars.x}} (e.g. a captured registration number) shows its value; a variable with no value yet renders empty.',
  actor: { rules: 'Actor key of the user doing this step. Omitted = the previous step\'s actor (first step: the first actor). Must be one of actors[].key (unknown_actor).', refersTo: 'storyboard.actors[].key' },
  notes: 'Free text for the tester (shown under the intent). Not rendered.',
  optional: 'true = the walkthrough can be signed off without this step (finish marks it skipped "not run").',
  screenshot: '"off" (no button), "offer" (button shown), "required" (the panel asks for one before Done). Use "required" on checks that prove an outcome.',
  target: 'Hint for highlighting: the element the human should act on.',
  'target.selector': { rules: `CSS selector of the element to highlight. ${'A template'}: {{vars.regNo}} etc. are rendered (inserted as is, so quote them: [data-testid="pay-{{vars.regNo}}"]) and validated like urls.` },
  'target.text': { rules: 'Visible text of the element to highlight (e.g. the button label). Prefer this over a selector for buttons. A template, validated like urls.' },
  kind: `Step kind, the discriminator: ${STEP_KINDS.join(', ')}. Each kind adds its own fields (describe_storyboards {object:"step.<kind>"}).`,
};

const STEP_DOCS: Record<StepKind, Record<string, FieldDoc>> = {
  open: { url: { rules: `Page to open. ${URL_T} Validated: unknown_variable, var_not_captured, var_used_before_capture; relative_url_no_origin (warning) when the project has no appOrigins.` } },
  login: {
    actor: { rules: 'Required on login steps: who logs in. Must be one of actors[].key.', refersTo: 'storyboard.actors[].key' },
    recipe: { rules: 'Login recipe role to use instead of the actor\'s role (rare: e.g. an admin logging in through the participant portal). Default: the actor\'s role. No recipe for it = missing_login_recipe at steps[i].recipe.', refersTo: 'loginRecipe.role' },
    url: { rules: `Login page override. Default: the recipe's loginUrl. ${URL_T}` },
  },
  logout: { url: { rules: `Logout URL override. Default: the recipe logoutUrl of the actor's role; when both are missing the human signs out by hand (intent says how). ${URL_T}` } },
  fill: {
    dataSet: { rules: 'Slug of the data set whose entries are filled into the current page. Must exist in the project or the same bundle (missing_data_set). Create the data set FIRST.', refersTo: 'dataSet.slug' },
    url: { rules: `Optional: a page to open before filling (else the current page is filled; put an open step before). ${URL_T}` },
    formId: { rules: 'Optional: limit filling to the form with this id (default: the data set match.formId).' },
  },
  email: {
    actor: { rules: 'Required on email steps: whose inbox (or phone) to watch. Usually a fresh actor.', refersTo: 'storyboard.actors[].key' },
    channel: 'email (default), sms or whatsapp: the channel stubyard captured the message on.',
    match: 'Which message: every given filter must match; {} = the newest message the actor received since the previous step started (or the `since` step).',
    'match.subject': 'Substring of the subject, or /regex/flags (e.g. "/confirmed|Complete your payment/"). Not a template.',
    'match.text': { rules: `Substring that must be in the subject or body. ${T} Validated like urls (e.g. {{vars.regNo}} needs an earlier capture).` },
    link: 'Which link to open from the message. Omitted = the human picks one from the list.',
    'link.pattern': 'Substring of the link URL, or /regex/ (e.g. "confirm-email").',
    'link.index': '0-based index among the matching links (default: the first match).',
    timeoutSec: 'How long the panel waits for the message (5-600 s).',
    since: { rules: 'Optional id of an earlier step: the message window starts where that step started instead of at the previous step. Use it when one action sends two messages: the first email step follows the action, the second gets since:"<id of the action step>" so it still sees the message that arrived before it opened. Unknown or not earlier = invalid_since.', refersTo: 'storyboard.steps[].id' },
    open: '"same-tab" (default) or "new-tab": open the chosen link; "none": only show the message (for checks on the content).',
  },
  instruction: {},
  capture: {
    var: { rules: 'Name of the walkthrough var to set (KEY: lowercase first, camelCase ok, e.g. regNo). Later steps use it as {{vars.regNo}}.', refersTo: '{{vars.<var>}} in later steps' },
    selector: 'CSS selector of the element whose text (or `attribute`) is the value. capture needs selector or textPattern. A template (e.g. [data-id="{{vars.orderId}}"]).',
    attribute: 'Attribute to read instead of textContent / value (e.g. "href", "data-id").',
    textPattern: 'Regex run on the page text (or the selected element\'s text); capture group 1, else the whole match, is the value. JSON-escape backslashes: "Registration number:\\\\s*(\\\\S+)".',
    required: 'true (default) = the step cannot be Done without a value; the human can type it by hand.',
  },
  check: {
    expect: 'What the human must see for the check to pass, in plain words (required). Not rendered.',
    assert: 'Optional machine check run by the panel on the current page; the human still decides pass / fail.',
    'assert.textPresent': { rules: `Text that must be on the page. ${T}` },
    'assert.selector': { rules: 'CSS selector that must match an element. A template ({{vars.x}} inserted as is; quote it inside attribute selectors), validated like urls.' },
    'assert.urlMatches': { rules: 'Substring or /regex/ the current URL must match. A template, validated like urls.' },
  },
};

const VALIDATION_STEP = ['schema', 'duplicate_step_id', 'unknown_actor', 'unknown_variable', 'var_not_captured', 'var_used_before_capture', 'relative_url_no_origin'];

const STEP_EXAMPLES: Record<StepKind, unknown> = {
  open: pilotStep('signup-open'),
  login: pilotStep('admin-login'),
  logout: pilotStep('participant-logout'),
  fill: pilotStep('signup-fill'),
  email: pilotStep('confirm-email'),
  instruction: pilotStep('signup-submit'),
  capture: pilotStep('reg-no'),
  check: pilotStep('pending-check'),
};

const STEP_IS: Record<StepKind, string> = {
  open: 'Open a page (the panel navigates the tab). Use before a fill, and to jump to a known admin URL.',
  login: 'Log an actor in: the panel opens the recipe loginUrl, fills username (the user\'s email) and password, highlights submit, and fills the 2FA code (totp from stubyard\'s authenticator; email/sms OTP from the captured message). The human clicks the button.',
  logout: 'Sign the current actor out (opens step.url or the recipe logoutUrl, or the human does it by hand). Needed before another actor logs in: one browser profile = one session.',
  fill: 'Fill the current page\'s form from a data set (values rendered for the step actor). Never clicks Next / Submit: put an instruction step after it.',
  email: 'Wait for a message to the actor (email, SMS or WhatsApp captured by stubyard), then open a link from it or show it for a check.',
  instruction: 'A manual action described in `intent` (click a button, choose an option, search). Use target to highlight the element.',
  capture: 'Read a value from the page (selector and/or textPattern) into a walkthrough var used by later steps as {{vars.<var>}}.',
  check: 'A verification: the human confirms `expect`; `assert` adds an automatic hint. Use screenshot "required" for evidence.',
};

const STEP_PITFALLS: Record<StepKind, string[]> = {
  open: ['Relative URLs need project appOrigins (set_app_origins), else relative_url_no_origin.', 'A URL with an id the walkthrough captured: "/admin/registrations/{{vars.regId}}" (capture it first).'],
  login: [
    'A login step needs a login recipe for the actor role (upsert_login_recipe first): missing_login_recipe.',
    'Every switch of actor needs logout (previous actor) + login (next actor).',
    'totp 2FA: the recipe twoFactor.authenticator must name an existing authenticator label (list_authenticators), or the actor\'s test user must have one linked.',
    'Fresh actors log in with the project default password (no_password warning when none is set); the app must accept it.',
  ],
  logout: ['Without step.url and recipe logoutUrl the human signs out by hand: say how in intent (e.g. "Sign out from the user menu").'],
  fill: [
    'fill never clicks Next/Submit: add an instruction step after it.',
    'Open the page first (an open step, or fill.url).',
    'Wizard forms: one fill per wizard page (each with its own data set), or one data set holding every page\'s keys pressed on each page with an instruction "Click Next" between.',
  ],
  email: [
    'Put it right after the action that sends the message: the wait window starts where the previous step started.',
    'Use link.pattern for confirmation links so the right link opens.',
    'match.text "{{vars.x}}" needs a capture step before it.',
  ],
  instruction: ['Say what to click in intent and set target.text to the button label; there is no automatic clicking.'],
  capture: [
    'capture needs selector or textPattern (schema error at selector otherwise).',
    'Capture BEFORE the steps that use {{vars.<var>}}: var_used_before_capture.',
    'Escape regex backslashes twice in JSON ("\\\\d+").',
  ],
  check: ['Write expect as the observable outcome ("Status badge shows Pending review"), not the action.', 'Use assert.textPresent for text that must appear; it is rendered, so "{{vars.regNo}}" works there.'],
};

const OBJECTS: ObjectDef[] = [
  {
    name: 'project',
    is: 'A stubyard project = one app under test. Holds test users, authenticators, captured messages and all storyboard objects. Its settings tell the extension which app it belongs to (appOrigins) and give defaults for fresh users.',
    key: 'slug',
    tools: ['create_project', 'set_app_origins', 'list_projects'],
    jsonSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,47}$' },
        name: { type: 'string', minLength: 1 },
        settings: {
          type: 'object',
          properties: {
            appOrigins: { type: 'array', items: { type: 'string' } },
            roles: { type: 'array', items: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,47}$' } },
            emailDomain: { type: 'string' },
            phonePrefix: { type: 'string' },
            defaultPassword: { type: 'string' },
          },
        },
      },
      required: ['slug', 'name'],
    },
    docs: {
      slug: 'Project id used by every tool (`project` argument), e.g. "classprovia".',
      name: 'Display name.',
      settings: 'Project settings (only the ones storyboards use are listed).',
      'settings.appOrigins': 'Origins of the app under test, e.g. ["http://localhost:3183"]: the extension finds the project by the tab origin, and relative step URLs are prefixed with the first one. Each must be scheme://host[:port] with no path. Set with set_app_origins.',
      'settings.roles': { rules: 'Roles offered for test users and storyboard actors. An actor role that is neither here nor on any test user gives unknown_role (warning).', refersTo: 'actor.role, loginRecipe.role, testUser.role' },
      'settings.emailDomain': 'Domain of generated and fresh users (default "<slug>.test"): a fresh actor gets <role>.<walkthroughKey>@<emailDomain>. The app must send mail for it to stubyard.',
      'settings.phonePrefix': 'Prefix of generated phone numbers ({{fake.phone}}, fresh users).',
      'settings.defaultPassword': 'Password of users without their own (fresh actors always). Default "Password123!" (no_password warning). Must satisfy the app\'s password rules.',
    },
    validation: ['no_app_origins (warning): no appOrigins', 'relative_url_no_origin (warning)', 'appOrigins[i] must be an origin like http://localhost:3183 (400 on set_app_origins)'],
    example: { slug: 'classprovia', name: 'Class PROvia', settings: { appOrigins: ['http://localhost:3183'], roles: ['admin', 'participant'], emailDomain: 'classprovia.test' } },
    pitfalls: ['Set appOrigins before authoring: without them relative URLs cannot open and the extension cannot match the tab.', 'The project must receive the app\'s SMTP mail, or email steps wait forever.'],
  },
  {
    name: 'role',
    is: 'A user role name of the app (e.g. "admin", "participant"). Joins actors, test users and login recipes: one login recipe per role.',
    key: 'the role string',
    tools: ['set_app_origins (roles)', 'upsert_test_user', 'upsert_login_recipe'],
    schema: ROLE,
    docs: { value: 'Lowercase letters, digits and dashes, starting with a letter or digit (max 48).' },
    validation: ['unknown_role (warning): an actor role not in project roles and not on any test user', 'missing_login_recipe: a login step whose role has no recipe'],
    example: 'participant',
    pitfalls: ['Use the app\'s own role names; the same string must appear on the recipe, the actor and the test users.'],
  },
  {
    name: 'testUser',
    is: 'A stubyard test user: an account of the app under test with an email / phone that stubyard captures. Existing staff (admin) are test users you create once; participants created by a flow are "fresh" actors instead (a new test user per walkthrough).',
    key: 'email',
    tools: ['upsert_test_user', 'list_test_users'],
    schema: UserSpec,
    docs: {
      email: 'Login email of the account in the app; key of the upsert.',
      name: 'Full name ("First Last"): {{user.firstName}} / {{user.lastName}} split it at the first space.',
      role: { rules: 'Role of the account; actors without `user` take the first user with their role.', refersTo: 'role' },
      phone: 'Phone number (E.164) for SMS / WhatsApp steps.',
      password: 'The account password in the app. Omit it to use the project defaultPassword. Never put real passwords in a bundle; set them with upsert_test_user or the dashboard.',
      notes: 'Free text (e.g. where the account comes from).',
    },
    validation: ['missing_user: an actor ref (id, email, phone, name or role) that matches no test user', 'no_password (warning)'],
    example: PILOT.users[0],
    pitfalls: ['Staff accounts must already exist in the app with the same email and password: stubyard does not create them in the app.'],
  },
  {
    name: 'authenticator',
    is: 'A TOTP key (authenticator app) stored in stubyard, so login steps can fill 2FA codes. Created by a human in the dashboard or via REST from the app\'s 2FA setup QR (the secret is sensitive); storyboards only reference it by label.',
    key: 'label',
    tools: ['list_authenticators', 'get_2fa_code'],
    jsonSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', minLength: 1 },
        secret: { type: 'string', description: 'Base32 key or otpauth:// link' },
        testUserId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        issuer: { type: 'string' },
        account: { type: 'string' },
        algorithm: { type: 'string', enum: ['SHA1', 'SHA256', 'SHA512'] },
        digits: { type: 'integer' },
        period: { type: 'integer' },
      },
      required: ['secret'],
    },
    docs: {
      label: { rules: 'Name referenced by loginRecipe.twoFactor.authenticator (case-insensitive). Must be unique.', refersTo: 'loginRecipe.twoFactor.authenticator' },
      secret: 'Base32 secret or the otpauth:// link of the QR code. Never in bundles or tool calls you log.',
      testUserId: { rules: 'Linked test user: a totp recipe without an authenticator label uses the key linked to the actor\'s user.', refersTo: 'testUser' },
      issuer: 'Issuer shown in authenticator apps.',
      account: 'Account shown in authenticator apps.',
      algorithm: 'HMAC algorithm (default SHA1).',
      digits: 'Code length (default 6).',
      period: 'Seconds per code (default 30).',
    },
    validation: ['missing_authenticator (path loginRecipes[<role>].twoFactor.authenticator): no authenticator with that label, or no key linked to the actor\'s user; a warning for fresh actors'],
    example: { label: 'Class PROvia admin 2FA', secret: '<base32 secret from the app 2FA setup>', testUserId: '<id of admin@classprovia.test>' },
    pitfalls: ['Ask the owner to add the key in the stubyard dashboard (Authenticators) if list_authenticators does not show it; do not invent secrets.'],
  },
  {
    name: 'loginRecipe',
    is: 'How to log in as one role: login page, field selectors and the second factor. One per role per project; login and logout steps use the recipe of the actor\'s role.',
    key: 'role',
    tools: ['upsert_login_recipe', 'list_login_recipes', 'delete_login_recipe'],
    schema: LoginRecipe,
    docs: {
      role: { rules: 'The role this recipe logs in; key of the upsert (one recipe per role).', refersTo: 'role' },
      name: 'Display name (e.g. "Staff (Admin)").',
      loginUrl: { rules: `Login page. ${URL_T}` },
      fields: 'Selectors of the login form.',
      'fields.username': 'CSS selector of the username / email input. The value filled is the user\'s email (else phone).',
      'fields.password': 'CSS selector of the password input. The value is the user\'s password, else the project defaultPassword, else Password123!.',
      'fields.submit': 'CSS selector of the submit button: only highlighted, never clicked.',
      twoFactor: `Second factor, by kind (${TWO_FACTOR_KINDS.join(', ')}): {"kind":"none"}; {"kind":"totp","selector":"#code","authenticator":"<label>"} (code from stubyard; authenticator omitted = the key linked to the user); {"kind":"email-otp"|"sms-otp","selector":"#otp","subject":"<optional subject filter>"} (code read from the message stubyard captures).`,
      logoutUrl: { rules: `URL that signs the user out (null = sign out by hand from the UI). ${URL_T}` },
      notes: 'Hints for the tester (e.g. where the sign-out menu is).',
    },
    validation: ['schema', 'missing_login_recipe (on storyboards using the role)', 'missing_authenticator', 'delete: 409 while a storyboard uses it (force to override)'],
    example: PILOT.loginRecipes[1],
    pitfalls: [
      'The 2FA selector must be the input that receives the code; for a 6-box input use the first box or the container id the app uses for paste.',
      'The submit button is never clicked: the human presses it.',
      'logoutUrl only if the app has a GET logout route; otherwise leave null and describe the menu in notes.',
    ],
  },
  {
    name: 'dataSet',
    is: 'Named values for one form: each entry finds a field by key (id, name, data-testid, label or placeholder) and fills a template value rendered for the step actor. Fill steps reference it by slug; the extension also offers it on pages whose URL matches match.urlPattern.',
    key: 'slug',
    tools: ['upsert_data_set', 'patch_data_set_entries', 'data_set_from_snapshot', 'list_data_sets', 'get_data_set', 'preview_data_set', 'delete_data_set'],
    schema: DataSet,
    docs: {
      slug: { rules: 'Id referenced by fill steps (lowercase, digits, dashes; max 48). "from-snapshot" is reserved.', refersTo: 'step(fill).dataSet' },
      name: 'Display name.',
      description: 'What form it fills, what is missing.',
      match: 'Where the extension offers this data set.',
      'match.urlPattern': { rules: 'Glob on the URL path (+query only when the pattern has "?"): "*" = within one segment, "**" = anything incl. "/". "/register/*" matches /register/HCE27, not /register or /register/HCE27/step2 (use "/register/**"). Empty = every page. Origin, fragment and trailing "/" are ignored; case-sensitive.', refersTo: 'page URL path' },
      'match.formId': 'Only the form with this id is filled.',
      entries: { rules: 'Field values (max 300; keys unique). See describe_storyboards {object:"dataEntry"}.', refersTo: 'dataEntry' },
    },
    validation: ['schema (incl. duplicate entry keys at entries[i].key)', 'missing_data_set on storyboards using it', 'delete: 409 while a storyboard uses it (force to override)', 'Entry values are NOT checked for unknown variables at save: run preview_data_set and read its warnings'],
    example: PILOT.dataSets[0],
    pitfalls: [
      'Take keys from a page snapshot (save_page_snapshot → data_set_from_snapshot) instead of guessing.',
      'Use {{unique}} in anything the app requires to be unique (organisation names, usernames); {{user.email}} of a fresh actor is unique already.',
      'Radix selects: kind radix-select; value = visible option text.',
      'PUT (upsert_data_set) replaces all entries; use patch_data_set_entries to change a few.',
    ],
  },
  {
    name: 'dataEntry',
    is: 'One field of a data set: how to find the field (key or selector) and what to put in it.',
    key: 'key (unique in the data set)',
    tools: ['patch_data_set_entries'],
    schema: DataEntry,
    docs: {
      key: { rules: 'Finds the field: element id, name, data-testid, label text or placeholder (tried in that order). Form Builder fields are "fld-<fieldCode>".', refersTo: 'pageSnapshot.fields[].key' },
      value: { rules: `String ${T}; true/false for checkboxes; a string array for multi-selects / checkbox groups. Rendered for the fill step's actor ({{user.*}}).` },
      kind: `How to fill: ${FIELD_KINDS.join(', ')}. "auto" detects native inputs; Radix / custom widgets need radix-select, radix-checkbox or radix-radio; "skip" keeps the entry but never fills it; "otp" for code boxes.`,
      selector: 'CSS selector that overrides key matching (use when the key is ambiguous).',
      label: 'Human label (from a scan); shown in the panel.',
      note: 'Note for authors / testers (e.g. "VERIFY option label").',
    },
    validation: ['schema', 'duplicate key → schema issue at entries[i].key'],
    example: PILOT.dataSets[0].entries[3],
    pitfalls: ['Radix selects: kind radix-select; value = visible option text (not the option value).', 'Dates: native date inputs take YYYY-MM-DD ({{date.-30y}}).', 'Phone widgets may reformat the value: check with a walkthrough.'],
  },
  {
    name: 'storyboard',
    is: 'A business flow for manual testing: who takes part (actors), what is asked at start (inputs), and the ordered steps a human follows with the extension\'s help. A walkthrough is one run of it.',
    key: 'slug',
    tools: ['upsert_storyboard', 'validate_storyboard', 'get_storyboard', 'list_storyboards', 'delete_storyboard', 'import_storyboard_bundle', 'export_storyboard_bundle'],
    schema: Storyboard,
    docs: {
      slug: 'Id (lowercase, digits, dashes; max 48). "export", "import", "validate" and "match" are reserved.',
      name: 'Display name.',
      description: 'Longer description (shown in the dashboard).',
      intent: 'One sentence: the business outcome the flow proves.',
      tags: 'Up to 20 tags (e.g. requirement ids "REG-02"); list_storyboards filters by tag.',
      inputs: { rules: 'Values asked when a walkthrough starts, used as {{vars.<name>}}. See describe_storyboards {object:"input"}.', refersTo: 'input' },
      actors: { rules: '1-10 people taking part, each with a role. See describe_storyboards {object:"actor"}.', refersTo: 'actor' },
      steps: { rules: '1-150 steps in order. See describe_storyboards {object:"step"} and step.<kind>.', refersTo: 'step' },
      preferredMode:
        'Which start button the extension shows first: "tracked" (default; per-step Done/Skip/Fail, notes, screenshots, sign-off, kept in history) or "quick" (same steps and automation, no evidence or sign-off, not in history). Set "quick" for simple form-fill or smoke flows a human just wants to click through; the human can still pick the other mode.',
      record:
        'Record the run with the extension: "off" (default), "dom" (an rrweb DOM recording of the app pages, played back in the dashboard with step markers; every input value is masked by default; recordPrivacy can unmask plain fields) or "video" (a WebM video of the browser tab, started by the tester in the extension; password, code and card fields show as dots on screen (also when typed by hand); other text on the page is visible). Applies to tracked runs; a quick test records only when its start asks (record). The tester can override it when starting, and pause it during the run.',
      recordMaskAllInputs: 'true = strict masking: every input value (the unmask list does not apply) and all page text are masked. Default false: DOM recordings still mask every input value unless recordPrivacy.unmaskSelectors shows it, plus contenteditable text and text that looks like a secret.',
      recordPrivacy:
        'Selector lists for recordings, all optional (at most 50 CSS selectors each): unmaskSelectors (inputs shown in clear in DOM recordings, e.g. a search box; never applied to fields that look like passwords, codes, cards or keys), maskSelectors (more inputs that are sensitive: masked always, shown as dots while video records), maskTextSelectors (elements whose text is masked, e.g. an account number or an API key shown on the page), blockSelectors (elements left out of DOM recordings entirely). Hidden inputs are always left out.',
      'recordPrivacy.unmaskSelectors': 'CSS selectors of inputs shown in clear in DOM recordings (every other input is masked). Ignored with recordMaskAllInputs, and for fields that look like passwords, codes, card numbers or keys.',
      'recordPrivacy.maskSelectors': 'CSS selectors of more sensitive inputs: always masked in DOM recordings, dots on screen while video records.',
      'recordPrivacy.maskTextSelectors': 'CSS selectors of elements whose text is masked in DOM recordings (e.g. an account number or a key shown on the page).',
      'recordPrivacy.blockSelectors': 'CSS selectors of elements left out of DOM recordings entirely (a grey box of the same size is replayed).',
    },
    validation: ['Every code in validationCodes; PUT returns 400 with ALL issues {path, code, message, expected?}. The version goes up only when the content changes (re-PUT of the same content = unchanged).'],
    example: PILOT_SB,
    pitfalls: [
      'Run validate_storyboard until ok:true before upsert or import.',
      'Every step needs intent (what and why, one sentence, no selectors).',
      'Each switch of actor needs logout (previous actor) + login (next): one browser profile has one session.',
      'title, intent, expect and notes are rendered when the step is resolved (resolve returns them in text); a variable with no value yet renders empty.',
    ],
  },
  {
    name: 'actor',
    is: 'A person in the storyboard: a role, plus either an existing test user (user / first user with the role) or a fresh test user created per walkthrough (fresh: true).',
    key: 'key (unique in the storyboard)',
    schema: Actor,
    docs: {
      key: { rules: 'Actor key used by steps (step.actor) and {{users.<key>.*}}: lowercase first letter, then letters, digits, _.', refersTo: 'step.actor' },
      label: 'Display label ("New participant").',
      role: { rules: 'Role: picks the login recipe; for fresh actors also the new user\'s role.', refersTo: 'loginRecipe.role, role' },
      user: { rules: 'Existing test user (id, email, phone, name or role). Omitted = the first test user with `role`. Not allowed with fresh.', refersTo: 'testUser' },
      fresh: 'true = a new test user per walkthrough: email <role>.<walkthroughKey>@<emailDomain>, a generated phone, the project default password. Use for anyone the flow signs up.',
      name: { rules: `Fresh actors: name template (default "{{fake.firstName}} {{fake.lastName}}"). ${T} {{user.*}} is not available here.` },
    },
    validation: ['schema: "fresh actors cannot name an existing user" (path user); duplicate actor key', 'missing_user', 'unknown_role (warning)', 'no_password (warning)', 'missing_authenticator'],
    example: PILOT_SB.actors[0],
    pitfalls: ['One actor per role, plus fresh actors for anyone the flow creates.', 'A non-fresh actor whose role has no test user fails with missing_user: upsert_test_user first.'],
  },
  {
    name: 'input',
    is: 'A value asked when a walkthrough starts (e.g. the event code); steps use it as {{vars.<name>}}.',
    key: 'name',
    schema: Input,
    docs: {
      name: { rules: 'Var name (KEY: lowercase first, camelCase ok).', refersTo: '{{vars.<name>}}' },
      label: 'Question shown at start ("Event code").',
      required: 'true = the walkthrough cannot start without a value (400 listing the missing inputs).',
      default: 'Value used when none is given.',
      help: 'Hint shown under the field.',
    },
    validation: ['schema: duplicate input name', 'var_not_captured is not raised for {{vars.<name>}} of an input'],
    example: PILOT_SB.inputs[0],
    pitfalls: ['Give a default so a walkthrough can start with one click.'],
  },
  {
    name: 'step',
    is: `One thing the human does, in order. Kinds: ${STEP_KINDS.join(', ')}. The fields below are shared by every kind; describe_storyboards {object:"step.<kind>"} lists each kind's own fields.`,
    key: 'id (unique in the storyboard)',
    schema: stepSchemaOf('instruction'),
    docs: STEP_BASE_DOCS,
    validation: VALIDATION_STEP,
    example: pilotStep('signup-submit'),
    pitfalls: ['Every step needs intent (what and why, in one sentence, no selectors).', 'Give explicit ids: results, captures and refreshes are keyed by them.'],
  },
  ...STEP_KINDS.map(
    (kind): ObjectDef => ({
      name: `step.${kind}`,
      is: STEP_IS[kind],
      key: 'id',
      schema: stepSchemaOf(kind),
      docs: { ...STEP_BASE_DOCS, ...STEP_DOCS[kind] },
      validation: [
        ...VALIDATION_STEP,
        ...(kind === 'fill' ? ['missing_data_set (steps[i].dataSet)'] : []),
        ...(kind === 'login' ? ['missing_login_recipe (steps[i].recipe)', 'missing_authenticator', 'no_password (warning)'] : []),
        ...(kind === 'capture' ? ['schema: capture needs selector or textPattern (path selector)'] : []),
      ],
      example: STEP_EXAMPLES[kind],
      pitfalls: STEP_PITFALLS[kind],
    }),
  ),
  {
    name: 'pageSnapshot',
    is: 'The form fields scanned on one page (by the extension\'s Page data view, or pasted by an agent from the page source). Source of data-set keys: data_set_from_snapshot turns it into a data set. The newest 200 per project are kept.',
    key: 'id (server-assigned)',
    tools: ['save_page_snapshot', 'list_page_snapshots', 'get_page_snapshot', 'data_set_from_snapshot'],
    schema: PageSnapshot,
    arrays: ['fields'],
    docs: {
      url: 'Full URL of the scanned page (save_page_snapshot accepts "/path" and prefixes the first appOrigin).',
      urlPattern: { rules: 'Glob the data set made from it will match (save_page_snapshot default: the URL path). Use "/register/*" style for pages with ids.', refersTo: 'dataSet.match.urlPattern' },
      title: 'Page title.',
      formId: 'Form id the fields belong to (null = the whole page).',
      fields: 'Scanned fields (max 500).',
      'fields[].key': { rules: 'The key a data entry uses for this field (id, else name, else data-testid, else label / placeholder).', refersTo: 'dataEntry.key' },
      'fields[].id': 'Element id (null when none).',
      'fields[].name': 'name attribute.',
      'fields[].testId': 'data-testid attribute.',
      'fields[].kind': `Detected fill kind: ${FIELD_KINDS.join(', ')}.`,
      'fields[].inputType': 'type attribute of an <input>.',
      'fields[].label': 'Visible label text.',
      'fields[].placeholder': 'Placeholder text.',
      'fields[].value': 'Current value (becomes the entry value unless data_set_from_snapshot gets `values`).',
      'fields[].options': 'Options of selects / radios [{value, label}]; for radix-select fill the label.',
      'fields[].required': 'Marked required on the page.',
      'fields[].visible': 'Visible when scanned; data_set_from_snapshot takes only visible fields unless include "all".',
      'fields[].formId': 'Id of the enclosing form.',
      'fields[].duplicateKey': 'true when another field has the same key: give the entry a selector.',
      note: 'Free text.',
      source: '"extension" or "agent" (save_page_snapshot sets agent).',
    },
    validation: ['schema (400): url must be a full URL'],
    example: {
      url: 'http://localhost:3183/auth/person/register',
      urlPattern: '/auth/person/register',
      title: 'Create your account',
      formId: null,
      source: 'agent',
      fields: [
        { key: 'email', id: 'email', name: 'email', testId: null, kind: 'text', inputType: 'email', label: 'Email', placeholder: null, value: null, required: true, visible: true, formId: null },
        { key: 'title', id: 'title', name: null, testId: null, kind: 'radix-select', inputType: null, label: 'Title', placeholder: null, value: null, options: [{ value: 'dr', label: 'Dr' }, { value: 'mr', label: 'Mr' }], required: true, visible: true, formId: null },
      ],
    },
    pitfalls: ['Scan each page of a wizard separately (one snapshot per step page).', 'Pasting from source: Form Builder fields are id="fld-<fieldCode>"; Radix selects are <button role="combobox" id=…>.'],
  },
  {
    name: 'bundle',
    is: 'A JSON file with users, login recipes, data sets and storyboards (format "stubyard-storyboards", version 1): the unit of import / export. Import validates the whole bundle first (references satisfied by the project ∪ the bundle) and writes it in one transaction; dry_run validates and rolls back.',
    tools: ['import_storyboard_bundle', 'export_storyboard_bundle'],
    schema: Bundle,
    docs: {
      format: 'Always "stubyard-storyboards".',
      version: 'Always 1.',
      project: 'Project settings merged on import: appOrigins and roles are added (union), defaultPassword replaced.',
      'project.appOrigins': { rules: 'Added to the project appOrigins.', refersTo: 'project.settings.appOrigins' },
      'project.roles': { rules: 'Added to the project roles.', refersTo: 'project.settings.roles' },
      'project.defaultPassword': 'Replaces the project defaultPassword (exported only with secrets). Prefer setting it in the dashboard.',
      users: { rules: 'Test users upserted by email (passwords only if given; "***" is ignored).', refersTo: 'testUser' },
      loginRecipes: { rules: 'Upserted by role.', refersTo: 'loginRecipe' },
      dataSets: { rules: 'Upserted by slug. A "***" value keeps the stored value (masked_value warning when there is none).', refersTo: 'dataSet' },
      storyboards: { rules: 'Upserted by slug (version bumped only on change).', refersTo: 'storyboard' },
    },
    validation: [
      'All storyboard codes with paths prefixed by the collection: storyboards[0].steps[3].dataSet',
      'schema: duplicate email / role / slug inside the bundle; reserved slugs; project.appOrigins[i] not an origin',
      'masked_value (warning)',
      'Modes: upsert (default), create-only (existing items are skipped), replace (recipes, data sets and storyboards missing from the bundle are deleted)',
    ],
    example: { format: 'stubyard-storyboards', version: 1, project: PILOT.project, users: PILOT.users, loginRecipes: PILOT.loginRecipes.slice(0, 1), dataSets: [], storyboards: [] },
    pitfalls: ['Never put real passwords in a bundle.', 'Export masks secret-looking literal values (keys like password/token/otp/pin) as "***" unless include_secrets.'],
  },
  {
    name: 'templateVariables',
    is: 'Template variables: {{name}} placeholders rendered by the server when a step is resolved in a walkthrough (the extension never renders). Template fields: step url, loginUrl / logoutUrl, data entry values, actor name, email match.text, step target.selector / target.text, capture selector, check assert.textPresent / assert.selector / assert.urlMatches (and title / intent / expect / notes for display). An unknown variable renders empty with a warning; storyboard fields are validated (unknown_variable, var_not_captured, var_used_before_capture), data-set values are not (use preview_data_set).',
    jsonSchema: { type: 'string', maxLength: 2000, description: 'A template: text with {{variable}} placeholders' },
    docs: {},
    validation: ['unknown_variable', 'var_not_captured', 'var_used_before_capture'],
    example: 'Flow Test Org {{unique}}',
    pitfalls: [
      'fake.* values are fixed for the whole walkthrough (pressing Fill twice gives the same data); add a suffix for a second value: {{fake.firstName:2}}.',
      '{{user.*}} is the step actor; use {{users.<actorKey>.email}} for another actor.',
      'Use {{unique}} in anything the app requires to be unique: data is not reset between walkthroughs.',
    ],
  },
  {
    name: 'walkthrough',
    is: 'One human run through a storyboard, started from the extension or dashboard. It snapshots the storyboard at start, creates fresh users, and records per-step status, notes, data, captured vars, screenshots and a sign-off verdict. A quick test run (mode "quick") keeps none of that evidence and is not listed by default. The fresh users a run created stay until the human cleans them up (Cleanup in the extension or dashboard); users with a Keep pin are never removed. With recording on (storyboard record "dom", or the start override) the extension also records the app pages as segments (one per page load) for playback in the dashboard; list_walkthrough_recordings shows them, delete_walkthrough_recording removes them. Read-only for agents otherwise (get_walkthrough_result, list_walkthroughs).',
    key: 'id or key (6 chars)',
    tools: ['list_walkthroughs', 'get_walkthrough_result', 'list_walkthrough_recordings', 'delete_walkthrough_recording'],
    jsonSchema: {
      type: 'object',
      description: 'get_walkthrough_result (GET /walkthroughs/:id/summary); actor passwords are masked',
      properties: {
        walkthrough: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            key: { type: 'string' },
            label: { type: 'string' },
            status: { type: 'string', enum: [...WALKTHROUGH_STATUSES] },
            mode: { type: 'string', enum: [...RUN_MODES] },
            storyboard: { type: 'object' },
            verdict: { anyOf: [{ type: 'string', enum: [...VERDICTS] }, { type: 'null' }] },
            counts: { type: 'object' },
            startedAt: { type: 'string' },
            finishedAt: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            cleanupStatus: { type: 'string', enum: ['none', 'pending', 'cleaned', 'dismissed'] },
            cleanupAt: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          },
        },
        steps: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, kind: { type: 'string', enum: [...STEP_KINDS] }, status: { type: 'string', enum: [...STEP_STATUSES] }, note: { type: 'string' }, data: { type: 'object' }, shots: { type: 'integer' } } } },
        vars: { type: 'object' },
        actors: { type: 'object' },
        signoff: { type: 'object' },
        durationMs: { type: 'integer' },
      },
    },
    docs: {
      walkthrough: 'Brief: id, key, label, storyboard {id, slug, name, version}, timestamps.',
      'walkthrough.id': 'Walkthrough id.',
      'walkthrough.key': '6-char key; also {{unique}} inside it.',
      'walkthrough.label': 'Label given at start.',
      'walkthrough.status': `${WALKTHROUGH_STATUSES.join(' | ')}.`,
      'walkthrough.mode': 'tracked (results and sign-off, listed by default) | quick (a quick test: no screenshots or sign-off, listed only with mode quick / all; its record goes when the human cleans up its test data).',
      'walkthrough.cleanupStatus': 'Test data the run created (its fresh users and their messages): none (nothing created) | pending (still there) | cleaned (removed by the human\'s cleanup; tracked runs keep their record) | dismissed (left in place on purpose). Nothing is removed automatically.',
      'walkthrough.cleanupAt': 'ISO time of the cleanup or dismissal, or null.',
      'walkthrough.storyboard': 'The storyboard and version that was run.',
      'walkthrough.verdict': `Sign-off verdict: ${VERDICTS.join(' | ')} (null until finished).`,
      'walkthrough.counts': 'Steps per status.',
      'walkthrough.startedAt': 'ISO time.',
      'walkthrough.finishedAt': 'ISO time or null.',
      steps: `Per step: status (${STEP_STATUSES.join(', ')}), the tester's note, data (fill: {filled, unmatched, skipped, errors}; email: {messageId, subject, link}; check: {assertion}; capture: {value}), number of screenshots.`,
      vars: 'Inputs and captured values.',
      actors: 'Users per actor key ({userId, name, email, role, created}); passwords "***".',
      signoff: '{verdict, signedOffBy, signedOffAt, note}.',
      durationMs: 'Start to finish (or now).',
    },
    validation: [],
    example: {
      walkthrough: { key: 'k7m2qp', status: 'finished', verdict: 'pass', storyboard: { slug: 'registration-approval', version: 1 } },
      steps: [{ id: 'reg-no', title: 'Note the registration number', kind: 'capture', status: 'done', note: '', data: { value: 'HCE27-P-0042' }, shots: 0 }],
      vars: { event: 'HCE27', regNo: 'HCE27-P-0042' },
      signoff: { verdict: 'pass', signedOffBy: 'QA', note: '' },
    },
    pitfalls: ['Agents read results; humans run walkthroughs. Failed steps carry the tester\'s note: use it to fix the storyboard or file a bug.'],
  },
  {
    name: 'agentRun',
    is: 'RESERVED for v2: a walkthrough executed by an agent (executor "agent") through start_walkthrough / resolve_step / report_step. No tools exist yet; walkthroughs accept executor "human" only.',
    jsonSchema: { type: 'object', description: 'Reserved (v2); no fields yet', properties: { executor: { const: 'agent' } } },
    docs: { executor: 'Will be "agent" (v1 accepts "human" only).' },
    validation: [],
    example: { executor: 'agent', reserved: true },
    pitfalls: ['Do not try to run walkthroughs yourself in v1: hand the storyboard to a human with the extension.'],
  },
];

// ------------------------------------------------------------------------------------------------ overview

export const RELATIONS = [
  { from: 'storyboard.actors[].role', to: 'loginRecipe.role', cardinality: 'many-to-one', required: 'for login steps (logout steps only read its logoutUrl)', mustExistFirst: true },
  { from: 'storyboard.actors[].user', to: 'testUser (id | email | phone | name | role)', cardinality: 'many-to-one', required: 'unless fresh (omitted = first user with the role)', mustExistFirst: true },
  { from: 'storyboard.actors[] (fresh)', to: 'testUser created per walkthrough', cardinality: 'one-to-one per walkthrough', note: 'email <role>.<walkthroughKey>@<emailDomain>, project default password' },
  { from: 'step(fill).dataSet', to: 'dataSet.slug', cardinality: 'many-to-one', mustExistFirst: true },
  { from: 'step(login).recipe', to: 'loginRecipe.role', cardinality: 'many-to-one', required: 'optional override of the actor role', mustExistFirst: true },
  { from: 'step.actor', to: 'storyboard.actors[].key', cardinality: 'many-to-one', required: 'login and email steps; others inherit the previous step actor' },
  { from: 'loginRecipe.twoFactor.authenticator', to: 'authenticator.label', cardinality: 'many-to-one', required: 'for totp unless the actor user has a linked key', mustExistFirst: true },
  { from: 'authenticator.testUserId', to: 'testUser.id', cardinality: 'many-to-one' },
  { from: '{{vars.x}}', to: 'step(capture).var = x (an earlier step) | storyboard.inputs[].name = x', cardinality: 'many-to-one' },
  { from: '{{users.<key>.*}}', to: 'storyboard.actors[].key', cardinality: 'many-to-one' },
  { from: 'dataSet.match.urlPattern', to: 'page URL path (glob)', cardinality: 'one-to-many pages' },
  { from: 'dataSet.entries[].key', to: 'page field id | name | data-testid | label | placeholder (pageSnapshot.fields[].key)', cardinality: 'one-to-one field' },
  { from: 'dataSet (data_set_from_snapshot)', to: 'pageSnapshot.id', cardinality: 'created from one', note: 'copy; no live link' },
  { from: 'project.settings.appOrigins', to: 'the app under test (tab origin)', cardinality: 'one-to-many', note: 'relative URLs use the first one' },
  { from: 'walkthrough', to: 'storyboard (snapshot at start)', cardinality: 'many-to-one', note: 'results; read-only for agents' },
  { from: 'agentRun', to: 'walkthrough', note: "RESERVED for v2 (executor='agent'); no tools yet" },
];

export const BUILD_ORDER = [
  'project: create_project (once), then set_app_origins {origins, roles}',
  'test users: upsert_test_user for existing staff accounts (admin); decide which actors are fresh (anyone the flow signs up)',
  'authenticators: exist already (a human adds the TOTP key); check the label with list_authenticators',
  'login recipes: upsert_login_recipe, one per role',
  'page snapshots: save_page_snapshot (pasted fields) or ask the owner to "Send to stubyard" from the extension',
  'data sets: data_set_from_snapshot, then patch_data_set_entries / upsert_data_set; check with preview_data_set',
  'storyboards: write the steps (storyboard_guide {topic:"business-flow"})',
  'validate_storyboard until ok:true',
  'upsert_storyboard, or put everything in a bundle: import_storyboard_bundle {dry_run:true} until it has no errors, then without dry_run',
];

export const VALIDATION_CODES: Record<ValidationCode, { severity: 'error' | 'warning' | 'error or warning'; path: string; meaning: string; fix: string }> = {
  schema: { severity: 'error', path: 'steps[3].url', meaning: 'The shape is wrong: a missing required field, a wrong type, a bad pattern or length, an unknown step kind, a duplicate actor key / input name / data-set entry key, a reserved slug, or (bundles) a duplicate email / role / slug. Reference checks are skipped until the schema passes.', fix: 'Compare the value at `path` with describe_storyboards {object} jsonSchema and fix it.' },
  duplicate_step_id: { severity: 'error', path: 'steps[5].id', meaning: 'Two steps have the same id.', fix: 'Give every step a unique id.' },
  unknown_actor: { severity: 'error', path: 'steps[2].actor', meaning: 'step.actor is not one of actors[].key (`expected` lists them).', fix: 'Use an existing actor key or add the actor.' },
  missing_data_set: { severity: 'error', path: 'steps[4].dataSet', meaning: 'The fill step names a data set that is neither in the project nor in the same bundle (`expected` lists the slugs).', fix: 'Create it first (upsert_data_set / data_set_from_snapshot), include it in the bundle, or fix the slug.' },
  missing_login_recipe: { severity: 'error', path: 'steps[6].recipe', meaning: 'A login step\'s role (step.recipe, else the actor role) has no login recipe (`expected` lists the roles that have one).', fix: 'upsert_login_recipe for that role, or fix step.recipe / the actor role.' },
  unknown_role: { severity: 'warning', path: 'actors[1].role', meaning: 'The actor role is not in the project roles and no test user has it.', fix: 'Add it with set_app_origins {roles}, or create a test user with it; check the spelling.' },
  missing_user: { severity: 'error', path: 'actors[1].user', meaning: 'A non-fresh actor\'s user ref matches no test user, or (no `user`) no test user has the actor role.', fix: 'upsert_test_user, fix actor.user, or make the actor fresh: true.' },
  unknown_variable: { severity: 'error', path: 'steps[7].url', meaning: 'A {{x}} that is not a storyboard variable, {{users.<key>.*}} with an unknown actor key, or {{user.*}} where there is no step actor (actor name).', fix: 'Use a variable from describe_storyboards variables; {{users.<actorKey>.field}} for other actors.' },
  var_not_captured: { severity: 'error', path: 'steps[9].assert.textPresent', meaning: '{{vars.x}} with no capture step for x and no input named x (`expected` lists the known vars).', fix: 'Add a capture step {var:"x"} before it, or an input {name:"x"}.' },
  invalid_since: { severity: 'error', path: 'steps[12].since', meaning: 'An email step\'s since names no step of the storyboard, or a step that is not before it (`expected` lists the earlier step ids).', fix: 'Use the id of an earlier step (usually the one whose action sends the mail).' },
  var_used_before_capture: { severity: 'error', path: 'steps[2].url', meaning: '{{vars.x}} is used on or before the step that captures x.', fix: 'Move the capture step earlier, or make x an input.' },
  missing_authenticator: { severity: 'error or warning', path: 'loginRecipes[admin].twoFactor.authenticator', meaning: 'A totp recipe names an authenticator label that does not exist, or names none and the actor\'s user has no linked key. Only a warning for fresh actors (a fresh user never has a key).', fix: 'Fix the label (list_authenticators), or ask the owner to add / link the key in stubyard.' },
  no_password: { severity: 'warning', path: 'actors[0]', meaning: 'An actor that logs in has no password and the project has no defaultPassword: "Password123!" is used.', fix: 'Set the user password (upsert_test_user) or the project defaultPassword; fresh users need a default the app accepts.' },
  relative_url_no_origin: { severity: 'warning', path: 'steps[0].url', meaning: 'A relative URL ("/…") while the project has no appOrigins.', fix: 'set_app_origins.' },
  no_app_origins: { severity: 'warning', path: 'project.appOrigins', meaning: 'The project has no appOrigins: relative URLs cannot be opened and the extension cannot find the project.', fix: 'set_app_origins.' },
  masked_value: { severity: 'warning', path: 'dataSets[0].entries[2].value', meaning: 'Import only: a data-set value is "***" (masked by export) and there is no stored value to keep.', fix: 'Put the real value in the bundle or patch the entry afterwards.' },
};

export const ISSUE_FORMAT =
  'Validation issues are {path, code, message, expected?}. path uses dots and [index] ("steps[3].dataSet"); in bundles it starts with the collection ("storyboards[0].steps[3].dataSet"); recipe issues use loginRecipes[<role>]. A failed write answers "stubyard answered 400: <what> is invalid (N problems)" followed by the JSON {errors, warnings}: fix every error, warnings do not block.';

// ------------------------------------------------------------------------------------------------ describe

const def = (name: string) => OBJECTS.find((o) => o.name === name);
export const OBJECT_NAMES = OBJECTS.map((o) => o.name);

function jsonSchemaFor(o: ObjectDef): JS {
  return o.schema ? jsonSchemaOf(o.schema) : (o.jsonSchema ?? {});
}

function fieldsOf(o: ObjectDef): FieldInfo[] {
  if (o.name === 'templateVariables') return TEMPLATE_VARIABLE_HELP.map((v) => ({ name: `{{${v.name}}}`, type: 'variable', required: false, rules: v.help }));
  const js = jsonSchemaFor(o);
  const raw = js.properties ? schemaFields(js, '', o.arrays) : [{ name: 'value', type: typeOf(js), required: true, limits: limits(js) } as Omit<FieldInfo, 'rules'>];
  return raw.map((f) => {
    const { limits: lim, ...rest } = f as Omit<FieldInfo, 'rules'> & { limits?: string[] };
    const d = o.docs[f.name];
    const doc = typeof d === 'string' ? { rules: d } : (d ?? { rules: '' });
    const field: FieldInfo = { ...rest, rules: [doc.rules, ...(lim?.length ? [`(${lim.join('; ')})`] : [])].filter(Boolean).join(' ') };
    if (o.name === 'step' && f.name === 'kind') {
      field.type = STEP_KINDS.map((k) => JSON.stringify(k)).join(' | ');
      field.enum = [...STEP_KINDS];
    }
    if (doc.refersTo) field.refersTo = doc.refersTo;
    return field;
  });
}

/** Schema fields without docs and docs without schema fields, per object (empty = in sync). */
export function ontologyDrift(): string[] {
  const out: string[] = [];
  for (const o of OBJECTS) {
    if (o.name === 'templateVariables') continue;
    const js = jsonSchemaFor(o);
    const names = js.properties ? schemaFields(js, '', o.arrays).map((f) => f.name) : ['value'];
    for (const n of names) if (!(n in o.docs)) out.push(`${o.name}.${n}: no doc`);
    for (const n of Object.keys(o.docs)) if (!names.includes(n)) out.push(`${o.name}.${n}: doc for a field the schema does not have`);
  }
  return out;
}

/** The zod schema an object's example must satisfy (for tests); null for hand-written objects. */
export function exampleSchemaOf(name: string): z.ZodType | null {
  const o = def(name);
  if (!o?.schema) return null;
  return name.startsWith('step') ? Step : o.schema;
}

export function exampleOf(name: string): unknown {
  return def(name)?.example;
}

/** describe_storyboards: the overview (no object) or one object in full. */
export function describeStoryboards(object?: string): Json {
  if (object) {
    const o = def(object);
    if (!o) throw new Error(`Unknown object "${object}". Objects: ${OBJECT_NAMES.join(', ')}`);
    return {
      name: o.name,
      is: o.is,
      ...(o.key ? { key: o.key } : {}),
      ...(o.tools ? { tools: o.tools } : {}),
      fields: fieldsOf(o),
      jsonSchema: jsonSchemaFor(o),
      validation: o.validation,
      example: o.example,
      pitfalls: o.pitfalls,
      ...(o.name === 'templateVariables' ? { variables: TEMPLATE_VARIABLE_HELP } : {}),
    };
  }
  return {
    about:
      'Storyboards are manual test walkthroughs of business flows. A human runs them in Chrome with the stubyard extension, which opens pages, fills forms from data sets, logs actors in (incl. 2FA), waits for emails and records the results. You (an agent) author them with these tools. Call describe_storyboards {object} for any object below before writing it, and storyboard_guide {topic} for recipes.',
    objects: OBJECTS.map((o) => ({ name: o.name, is: o.is, ...(o.key ? { key: o.key } : {}), ...(o.tools ? { tools: o.tools } : {}) })),
    relations: RELATIONS,
    buildOrder: BUILD_ORDER,
    enums: {
      stepKinds: STEP_KINDS,
      fieldKinds: FIELD_KINDS,
      twoFactorKinds: TWO_FACTOR_KINDS,
      screenshot: ['off', 'offer', 'required'],
      emailChannel: ['email', 'sms', 'whatsapp'],
      emailOpen: ['same-tab', 'new-tab', 'none'],
      importMode: ['upsert', 'create-only', 'replace'],
      walkthroughStatus: WALKTHROUGH_STATUSES,
      runMode: RUN_MODES,
      stepStatus: STEP_STATUSES,
      verdict: VERDICTS,
    },
    variables: TEMPLATE_VARIABLE_HELP,
    validationCodes: Object.entries(VALIDATION_CODES).map(([code, v]) => ({ code, ...v })),
    issueFormat: ISSUE_FORMAT,
    reservedTools: ['start_walkthrough (executor "agent")', 'resolve_step', 'report_step'],
    example: 'docs/examples/classprovia-storyboards.json in the stubyard repo (the Class PROvia pilot); every object example comes from it.',
  };
}
