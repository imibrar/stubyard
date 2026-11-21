/**
 * storyboard_guide (docs/design/storyboards.md §4.2): markdown recipes for agents writing storyboards. The shapes are
 * in describe_storyboards (ontology.ts); these topics explain how to use them well. Examples follow the Class PROvia
 * pilot (docs/examples/classprovia-storyboards.json).
 */

export const GUIDE_TOPICS = ['business-flow', 'forms', 'login', 'email', 'variables', 'multi-step-forms', 'checklist'] as const;
export type GuideTopic = (typeof GUIDE_TOPICS)[number];

const GUIDE: Record<GuideTopic, { summary: string; markdown: string }> = {
  'business-flow': {
    summary: 'Turn a business flow into actors and steps.',
    markdown: `# Writing a business flow as a storyboard

A storyboard is the script a human tester follows in Chrome with the stubyard extension. The panel shows one step at a time, does the mechanical part (open, fill, log in, wait for the email) and the human does the rest.

## 1. Actors
- One actor per role that takes part (\`{key:"admin", role:"admin", user:"admin@classprovia.test"}\`). The role picks the login recipe.
- A **fresh** actor for anyone the flow creates (sign-up, invitation): \`{key:"participant", role:"participant", fresh:true, name:"{{fake.firstName}} Flow-{{unique}}"}\`. Each walkthrough creates a new test user \`<role>.<walkthroughKey>@<emailDomain>\` with the project default password, so the flow can run again and again.
- Non-fresh actors need a test user with that role (\`upsert_test_user\`), else \`missing_user\`.

## 2. Steps, in the order the human does them
| Need | Step |
|---|---|
| go to a page | \`open {url}\` |
| fill a form | \`fill {dataSet}\` (after an \`open\`) |
| click a button, choose something, search | \`instruction {intent, target:{text}}\` |
| sign in / out | \`login {actor}\` / \`logout\` |
| a mail or SMS arrives | \`email {actor, match, link}\` |
| remember a number for later | \`capture {var, textPattern}\` |
| verify an outcome | \`check {expect, assert, screenshot:"required"}\` |

Rules:
- **Every step has \`intent\`**: one plain sentence, what the human does and why, no selectors.
- **Switching actor = \`logout\` (previous actor) + \`login\` (next actor)**: one browser profile has one session.
- \`open\` before \`fill\` (or give \`fill.url\`). \`fill\` never clicks Next / Submit: add an \`instruction\` after it.
- After any action that sends mail, add an \`email\` step for the receiver.
- \`capture\` values the app generates (registration number, order id) and use them later as \`{{vars.regNo}}\` in URLs, \`email.match.text\` and \`check.assert.textPresent\`.
- End each phase with a \`check\` whose \`expect\` is the observable outcome; \`screenshot:"required"\` where evidence matters.
- \`step.actor\` is inherited from the previous step: set it on the first step of each actor and on every \`login\` / \`email\` step.
- Give every step an explicit \`id\` (kebab-case): results and captures are keyed by it.
- \`title\`, \`intent\`, \`expect\` and \`notes\` are rendered too (resolve returns them in \`text\`), so \`{{vars.regNo}}\` in an intent shows the captured value.

## 3. Skeleton (Class PROvia "registration needing approval")
signup-open (open) → signup-fill (fill) → signup-submit (instruction) → confirm-email (email + link) → confirm-check (check) → participant-login (login) → register-open (open) → pick-category (instruction) → register-fill (fill) → register-submit (instruction) → reg-no (capture) → pending-check (check) → participant-logout (logout) → admin-login (login, totp) → admin-open (open) → admin-find (instruction) → approve (instruction) → approved-check (check) → admin-logout (logout) → decision-email (email, open:"none") → final-check (check).

The full JSON is \`describe_storyboards {object:"storyboard"}\` → \`example\`.

## 4. Then
\`validate_storyboard\` until \`ok: true\` (see topic \`checklist\`).`,
  },
  forms: {
    summary: 'Data sets: keys from a page snapshot, values from templates.',
    markdown: `# Forms and data sets

A data set is the values for one form. Each entry's \`key\` finds a field by element **id, name, data-testid, label text or placeholder** (in that order); \`selector\` overrides the lookup.

## Get the keys from the page, never guess
1. Ask the owner to press **Send to stubyard** in the extension's Page data view on that page, **or** paste the fields yourself from the page source with \`save_page_snapshot {project, url, urlPattern, fields:[{key, label?, kind?, id?, name?, options?, required?}]}\`.
2. \`data_set_from_snapshot {project, snapshot, slug, name, values:{email:"{{user.email}}", …}}\` makes the data set (keys and kinds from the snapshot; values from \`values\`, else the scanned value).
3. Adjust with \`patch_data_set_entries {upsert:[…], remove:[…]}\` (merges by key) or replace it with \`upsert_data_set\`.
4. \`preview_data_set {project, slug, storyboard?, actor?}\` shows the rendered values and any template warnings (data values are not checked at save).

## Values
- Templates: \`{{user.email}}\`, \`{{user.password}}\`, \`{{user.firstName}}\` (the fill step's actor), \`{{fake.phone}}\`, \`{{date.-30y}}\`, \`Flow Test Org {{unique}}\`.
- Checkboxes: \`true\` / \`false\`. Multi-selects and checkbox groups: a string array.
- **Use \`{{unique}}\` in anything the app requires to be unique** (organisation, username): data is not reset between walkthroughs.

## Kinds
\`auto\` handles native inputs, selects, radios and checkboxes. Custom widgets need an explicit kind:
- **Radix selects: kind \`radix-select\`; value = the visible option text** ("Saudi Arabia", not "SA").
- \`radix-checkbox\`, \`radix-radio\` for Radix toggles; \`date\` for date pickers; \`otp\` for code boxes; \`skip\` keeps an entry without filling it.

## Matching pages
\`match.urlPattern\` is a glob on the path: \`*\` stays inside one segment, \`**\` crosses \`/\`. \`/register/*\` matches \`/register/HCE27\`, not \`/register/HCE27/step2\` (use \`/register/**\`). \`match.formId\` limits filling to one form.

## Class PROvia specifics
- Form Builder fields have ids \`fld-<fieldCode>\` (\`fld-first_name\`, \`fld-country\`).
- Sign-up page \`/auth/person/register\`: keys email, password, confirmPassword, title (radix-select), firstName, lastName, phone, nationality, country, organisationName, jobTitle, preferredLanguage (radix-select).`,
  },
  login: {
    summary: 'Login recipes, passwords and 2FA.',
    markdown: `# Login

## One login recipe per role
\`upsert_login_recipe {project, recipe:{role, name, loginUrl, fields:{username, password, submit}, twoFactor, logoutUrl, notes}}\`
- \`loginUrl\`: "/auth/staff-user/login" (relative = the walkthrough origin).
- \`fields\`: CSS selectors (defaults \`#email\`, \`#password\`). \`submit\` is only highlighted: the human clicks it.
- The username filled is the test user's email (else phone); the password is the user's password, else the project \`defaultPassword\`, else \`Password123!\`.
- \`logoutUrl\`: only when the app has a GET sign-out URL; else \`null\` and say in the logout step's intent how to sign out.

## Second factor
- \`{"kind":"none"}\`
- \`{"kind":"totp","selector":"#code","authenticator":"Class PROvia admin 2FA"}\`: stubyard computes the code from a stored authenticator. The label must exist (\`list_authenticators\`); without a label the key linked to the actor's user is used. Missing → \`missing_authenticator\`. A human adds the key (the secret comes from the app's 2FA setup QR); never invent one.
- \`{"kind":"email-otp","selector":"#otp","subject":"code"}\` / \`sms-otp\`: the code is read from the message stubyard captures after the login is submitted.

## In the storyboard
- \`login {actor:"admin"}\` uses the recipe of the actor's role (\`recipe\` overrides the role).
- Before a different actor logs in, add \`logout\` for the current one.
- Existing staff: \`upsert_test_user {email, name, role, password?}\` with the password they really have in the app (set it by hand; never commit it to a bundle).
- Fresh actors log in with the project default password: make sure the app's password rules accept it.`,
  },
  email: {
    summary: 'Waiting for emails / SMS and opening links.',
    markdown: `# Email, SMS and WhatsApp steps

The app sends its mail to stubyard (SMTP or a provider mock). An \`email\` step waits for a message to the actor and opens a link from it.

\`\`\`json
{ "id": "confirm-email", "kind": "email", "actor": "participant", "title": "Confirm email address",
  "intent": "Open the confirmation link from the sign-up email.", "link": { "pattern": "confirm-email" }, "timeoutSec": 180 }
\`\`\`

- \`actor\` is required: whose inbox. Fresh actors have a unique address per walkthrough, so the right mail is found.
- The wait window starts where the **previous** step started: put the email step right after the step whose action sends it.
- \`match.subject\`: substring or \`/regex/flags\` ("/confirmed|Complete your payment/"). \`match.text\`: substring of subject or body, a template ("{{vars.regNo}}").
- \`link.pattern\`: substring or /regex/ of the link to open; \`link.index\` picks among matches; no \`link\` = the human picks.
- \`open\`: "same-tab" (default), "new-tab", or "none" to only show the message, then follow with a \`check\` on its content.
- \`channel\`: "sms" / "whatsapp" for text messages (fresh users get a phone number).
- The project must receive the app's mail (SMTP host/port of stubyard, project emailDomain), or the step times out.`,
  },
  variables: {
    summary: 'Template variables, inputs and captures.',
    markdown: `# Variables

Templates are rendered by the server when a walkthrough resolves a step. Rendered fields: step \`url\`, recipe \`loginUrl\` / \`logoutUrl\`, data-entry values, fresh actor \`name\`, email \`match.text\`, check \`assert.textPresent\`. Not rendered: title, intent, expect, notes.

| Variable | Value |
|---|---|
| \`{{user.email}}\` … name, phone, role, password, firstName, lastName | the step's actor |
| \`{{users.admin.email}}\` | any actor by key |
| \`{{vars.x}}\` | an input (given at start) or a value captured earlier |
| \`{{unique}}\` | the walkthrough key (6 chars): use it in anything that must be unique |
| \`{{fake.firstName}}\`, lastName, fullName, company, jobTitle, city, word, email, phone, \`fake.digits:6\` | fake data, fixed for the walkthrough; \`fake.firstName:2\` gives another |
| \`{{date.today}}\`, \`{{date.+7d}}\`, \`{{date.-18y}}\`, \`{{datetime.now}}\` | UTC dates (units h d w m y) |
| \`{{project.emailDomain}}\`, \`{{app.origin}}\`, \`{{walkthrough.key}}\`, \`{{uuid}}\`, \`{{random.digits:6}}\`, \`{{now}}\` | — |

The full list: \`describe_storyboards {object:"templateVariables"}\`.

## Inputs and captures
- \`inputs:[{name:"event", label:"Event code", default:"HCE27"}]\` → \`{{vars.event}}\` from the first step.
- \`capture {var:"regNo", textPattern:"Registration number:\\\\s*([A-Z0-9-]+)"}\` → \`{{vars.regNo}}\` in **later** steps (\`var_used_before_capture\` otherwise). Group 1 (or the whole match) is the value; the human can correct it.
- An unknown \`{{x}}\` is \`unknown_variable\`; \`{{vars.x}}\` with neither input nor capture is \`var_not_captured\`.`,
  },
  'multi-step-forms': {
    summary: 'Wizards and forms spread over several pages.',
    markdown: `# Multi-step forms (wizards)

\`fill\` fills the fields visible now and never clicks Next. Two patterns:

1. **One data set per wizard page** (best when pages differ a lot): snapshot each page, make one data set each, and write
   \`fill (page 1) → instruction "Click Next" → fill (page 2) → instruction "Click Next" → …\`.
2. **One data set with every page's keys** (Class PROvia Form Builder, \`event-registration\`): a single \`fill\` step whose intent says "press Fill on each step and click Next yourself". Keys not on the current page show as unmatched, which is fine.

Tips:
- Scan every page: the snapshot only holds what was visible.
- If the URL changes per page, use \`match.urlPattern\` with \`**\` ("/register/**").
- Required radio groups and Radix widgets need explicit kinds (topic \`forms\`).
- End with an \`instruction\` for the final Submit and a \`check\` or \`capture\` on the result page.`,
  },
  checklist: {
    summary: 'Before you hand a storyboard over.',
    markdown: `# Checklist

1. \`set_app_origins\` done (no \`no_app_origins\`), roles listed.
2. Test users exist for every non-fresh actor; fresh actors for everyone the flow creates.
3. A login recipe per role that logs in; totp recipes name an existing authenticator.
4. Data sets made from page snapshots; \`preview_data_set\` shows no warnings; \`{{unique}}\` in unique fields.
5. Every step: explicit \`id\`, \`title\`, one-sentence \`intent\`; \`open\` before \`fill\`; \`instruction\` after \`fill\` for Next/Submit; \`logout\` + \`login\` on each actor switch; \`email\` after actions that send mail; \`capture\` before \`{{vars.x}}\`; \`check\` with \`expect\` (and \`screenshot:"required"\`) for outcomes.
6. \`validate_storyboard {project, storyboard}\` → repeat until \`ok: true\`. Read every issue's \`path\` and \`code\`; \`describe_storyboards\` → validationCodes says how to fix each. Warnings do not block but read them.
7. Save: \`upsert_storyboard\`, or a bundle: \`import_storyboard_bundle {bundle, dry_run:true}\` until no errors, then without dry_run. Re-running is safe: unchanged items stay unchanged (same version).
8. Never put real passwords in a bundle.
9. \`preferredMode\`: \`"quick"\` for simple form-fill or smoke flows a human just wants to click through (no step verdicts, notes, screenshots or sign-off); leave the default \`"tracked"\` where evidence and a sign-off matter.
10. After the owner runs it: \`list_walkthroughs\`, \`get_walkthrough_result\` for failed steps and notes.`,
  },
};

/** storyboard_guide: one topic as markdown, or (no topic) the topic list. */
export function storyboardGuide(topic?: string): string {
  if (!topic) {
    return [
      '# Storyboard guide',
      '',
      'Call storyboard_guide {topic} for one of:',
      ...GUIDE_TOPICS.map((t) => `- \`${t}\`: ${GUIDE[t].summary}`),
      '',
      'Shapes, relations, enums and validation codes: describe_storyboards.',
    ].join('\n');
  }
  const g = GUIDE[topic as GuideTopic];
  if (!g) throw new Error(`Unknown topic "${topic}". Topics: ${GUIDE_TOPICS.join(', ')}`);
  return g.markdown;
}
