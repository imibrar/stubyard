import type { DataEntry, Input, StepOf } from './schema.js';
import type { StoredStep } from './types.js';

/**
 * A storyboard as a Playwright spec (feature A1, second part): GET /api/projects/:p/storyboards/:slug/export?format=playwright
 * and the MCP tool export_storyboard_playwright. Pure: storyboard + hub facts in, TypeScript text out.
 *
 * The spec runs the storyboard as an agent walkthrough (executor "agent", runner "playwright-export"): each step is
 * resolved by the hub at run time (data sets, fresh users, vars, codes and email links are never baked in), acted on
 * with Playwright, screenshotted and reported. Steps are addressed by id, so cosmetic storyboard edits need no new
 * export. What cannot be automated with certainty is marked `// TODO` in the output.
 */

export interface PlaywrightExportOptions {
  project: string;
  /** Default STUBYARD_URL of the spec (the hub as the host reaches it). */
  hubUrl: string;
  hubVersion: string;
  /** Default APP_URL (the project's first app origin). */
  appOrigin: string;
  /** The data sets the fill steps use, by slug: their fields become explicit lines (values still come from the hub). */
  dataSets?: Record<string, { slug: string; name: string; entries: DataEntry[] }>;
  exportedAt?: Date;
}

export interface ExportableStoryboard {
  slug: string;
  name: string;
  version?: number;
  inputs: Input[];
  steps: StoredStep[];
}

/** File name of the spec. */
export const playwrightFileName = (slug: string): string => `${slug}.spec.ts`;

const lit = (v: unknown): string => JSON.stringify(v);
/** Text safe inside a // comment (no line breaks). */
const LINE_BREAKS = new RegExp(`[\\r\\n${String.fromCharCode(0x2028, 0x2029)}]+`, 'g'); // U+2028/9 end a comment too
const flat = (s: string): string => s.replace(LINE_BREAKS, ' ').trim();
const envName = (name: string): string => `STUBYARD_INPUT_${name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`;

/** The lines of one step's body (inside `async (r) => { … }`), without indentation. */
function stepBody(step: StoredStep, o: PlaywrightExportOptions): string[] {
  switch (step.kind) {
    case 'open':
      return ['await page.goto(r.url ?? APP_URL);'];
    case 'login':
      return [
        'if (r.url) await page.goto(r.url);',
        'await page.locator(r.selectors.username).fill(r.username);',
        'await page.locator(r.selectors.password).fill(r.password);',
        'if (r.selectors.submit) await page.locator(r.selectors.submit).click();',
        "else await page.locator(r.selectors.password).press('Enter');",
        '// 2FA from the login recipe: the TOTP code of the linked authenticator, or the email / SMS code that arrives.',
        'await secondFactor(page, r);',
      ];
    case 'logout':
      return [
        'if (r.url) await page.goto(r.url);',
        "else await page.context().clearCookies(); // TODO: the login recipe has no logoutUrl: sign out the app's way if cookies are not enough",
      ];
    case 'fill':
      return fillBody(step, o);
    case 'email':
      return emailBody(step);
    case 'capture':
      return captureBody(step);
    case 'check':
      return checkBody(step);
    case 'instruction':
      return instructionBody(step);
    default:
      return [
        `// TODO: automate this step (kind ${lit((step as { kind: string }).kind)} is not known to this exporter).`,
        "return { status: 'skipped', note: 'Not automated in the Playwright export' };",
      ];
  }
}

function fillBody(step: StepOf<'fill'>, o: PlaywrightExportOptions): string[] {
  const out = [
    'if (r.url) await page.goto(r.url);',
    'const form = formScope(page, r.formId);',
    "// Values come from the hub at run time. A field this page does not show (wizard forms) makes the step fail: remove its line. Never submits (the storyboard's next step does).",
  ];
  const ds = o.dataSets?.[step.dataSet];
  if (!ds) {
    out.push(`// TODO: data set ${lit(step.dataSet)} was not found at export: every entry is filled by type.`);
    out.push("for (const e of r.entries) if (e.kind !== 'skip') await fillAuto(field(form, r, e.key), e.value);");
    out.push('return { data: { entries: r.entries.length } };');
    return out;
  }
  out.push('const v = values(r);');
  for (const e of ds.entries) out.push(...entryLines(e));
  out.push(`const exported = new Set(${lit(ds.entries.map((e) => e.key))});`);
  out.push('// Entries added to the data set after the export: filled by type.');
  out.push("for (const e of r.entries) if (!exported.has(e.key) && e.kind !== 'skip') await fillAuto(field(form, r, e.key), e.value);");
  out.push('return { data: { entries: r.entries.length } };');
  return out;
}

/** The lines for one data entry, by its field kind. */
function entryLines(e: DataEntry): string[] {
  const k = lit(e.key);
  const label = `// ${flat(e.label ? `${e.label} (${e.key})` : e.key)}: ${e.kind}`;
  const guard = `if (${k} in v)`;
  const group = Array.isArray(e.value);
  switch (e.kind) {
    case 'skip':
      return [`${label}, left alone`];
    case 'text':
    case 'date':
    case 'otp':
      return [label, `${guard} await field(form, r, ${k}).fill(str(v[${k}]));`];
    case 'select':
      return [label, `${guard} await field(form, r, ${k}).selectOption(list(v[${k}]));`];
    case 'checkbox':
      return group
        ? [
            `${label} group. TODO: check that the boxes are input[name=${flat(e.key)}] with these values`,
            `${guard} for (const x of list(v[${k}])) await form.locator(\`input[type="checkbox"][name=\${css(${k})}][value=\${css(x)}]\`).check();`,
          ]
        : [label, `${guard} await field(form, r, ${k}).setChecked(on(v[${k}]));`];
    case 'radio':
      return [
        label,
        `${guard} await form.locator(\`input[type="radio"][name=\${css(${k})}][value=\${css(str(v[${k}]))}]\`).or(form.getByRole('radio', { name: str(v[${k}]), exact: true })).first().check();`,
      ];
    case 'radix-select':
      return [
        `${label}. TODO: best effort (open the trigger, click the option): check both against the app`,
        `${guard} {`,
        `  await field(form, r, ${k}).click();`,
        `  await page.getByRole('option', { name: str(v[${k}]), exact: true }).click();`,
        '}',
      ];
    case 'radix-checkbox':
      return group
        ? [
            `${label} group. TODO: best effort (click each option by its label): check against the app`,
            `${guard} for (const x of list(v[${k}])) await setToggle(form.getByRole('checkbox', { name: x, exact: true }), true);`,
          ]
        : [`${label}. TODO: best effort (click when aria-checked differs): check against the app`, `${guard} await setToggle(field(form, r, ${k}), on(v[${k}]));`];
    case 'radix-radio':
      return [`${label}. TODO: best effort (click the option by its label): check against the app`, `${guard} await form.getByRole('radio', { name: str(v[${k}]), exact: true }).click();`];
    default:
      // auto: input, textarea, select, checkbox or radio decided on the page
      return [label, `${guard} await fillAuto(field(form, r, ${k}), v[${k}]);`];
  }
}

function emailBody(step: StepOf<'email'>): string[] {
  const what = step.channel === 'email' ? 'email' : step.channel === 'sms' ? 'SMS' : 'WhatsApp message';
  const out = [
    `// Waits up to ${step.timeoutSec}s for the ${what} to the actor${step.match.subject ? ` (subject ${flat(step.match.subject)})` : ''}.`,
    `const msg = await waitForStepMessage(r, ${step.timeoutSec});`,
    'const data = { messageId: msg.id, subject: msg.subject };',
  ];
  if (step.open === 'none') {
    if (step.target?.selector) {
      out.push(
        "if (!msg.otp) throw new Error(`No code in \"${msg.subject ?? 'the message'}\"`);",
        "await page.locator(r.target?.selector ?? r.step.target?.selector ?? '').first().fill(msg.otp);",
        'return { data: { ...data, code: true } };',
      );
    } else {
      out.push('// TODO: the step opens nothing and has no target selector: use msg.otp or msg.links where the app needs them.', 'return { data };');
    }
    return out;
  }
  out.push(
    'const link = pickLink(msg.links, r.linkPattern, r.linkIndex);',
    'if (link) {',
    step.open === 'new-tab' ? '  // The storyboard opens it in a new tab; this test keeps one page so the next steps see it.' : '',
    '  await page.goto(link);',
    '  return { data: { ...data, link } };',
    '}',
    step.target?.selector
      ? "if (msg.otp) {\n  await page.locator(r.target?.selector ?? r.step.target?.selector ?? '').first().fill(msg.otp);\n  return { data: { ...data, code: true } };\n}"
      : '',
    "throw new Error(`No link to open in \"${msg.subject ?? 'the message'}\" (links: ${msg.links.join(', ') || 'none'})`);",
  );
  return out.filter(Boolean).flatMap((l) => l.split('\n'));
}

function captureBody(step: StepOf<'capture'>): string[] {
  const out: string[] = [];
  if (step.selector) {
    out.push(step.attribute ? 'const raw = (await page.locator(r.selector!).first().getAttribute(r.attribute!)) ?? \'\';' : 'const raw = await readValue(page.locator(r.selector!).first());');
  } else {
    out.push("const raw = await page.locator('body').innerText();");
  }
  if (step.textPattern) {
    out.push('const m = toRegExp(r.textPattern!).exec(raw);', "const value = m ? (m[1] ?? m[0]).trim() : '';");
  } else {
    out.push("const value = raw.replace(/\\s+/g, ' ').trim();");
  }
  out.push(step.required ? `if (!value) throw new Error(${lit(`Nothing to capture into vars.${step.var}`)});` : `if (!value) return { status: 'skipped', note: ${lit(`Nothing to capture into vars.${step.var} (optional)`)} };`);
  out.push(`return { value }; // stored by the hub as {{vars.${step.var}}}`);
  return out;
}

function checkBody(step: StepOf<'check'>): string[] {
  const out = [`// Expect: ${flat(step.expect)}`];
  const a = step.assert;
  if (!a || (!a.textPresent && !a.selector && !a.urlMatches)) {
    out.push('// TODO: automate this check (the step has no assert: the person judged it).', "return { status: 'skipped', note: 'No assert to automate' };");
    return out;
  }
  if (a.urlMatches) out.push('await expect(page).toHaveURL(urlMatcher(r.assert!.urlMatches!));');
  if (a.selector) out.push('await expect(page.locator(r.assert!.selector!).first()).toBeVisible();');
  if (a.textPresent) out.push("await expect(page.locator('body')).toContainText(r.assert!.textPresent!, { ignoreCase: true });");
  return out;
}

function instructionBody(step: StepOf<'instruction'>): string[] {
  const t = step.target;
  if (t?.selector || t?.text) {
    const loc = t.selector ? "page.locator(r.target?.selector ?? r.step.target?.selector ?? '').first()" : "page.getByText(r.target?.text ?? r.step.target?.text ?? '', { exact: true }).first()";
    return ['// TODO: the step highlights this element; a click is a guess at what the intent asks.', `await ${loc}.click();`];
  }
  return ['// TODO: automate (an instruction has no machine-readable action).', "return { status: 'skipped', note: 'Instruction not automated' };"];
}

/** The Playwright spec of a storyboard. */
export function playwrightSpec(sb: ExportableStoryboard, o: PlaywrightExportOptions): string {
  const at = (o.exportedAt ?? new Date()).toISOString();
  const emailWait = sb.steps.reduce((n, s) => n + (s.kind === 'email' ? s.timeoutSec : 0), 0);
  const timeoutSec = 60 + sb.steps.length * 15 + emailWait;
  const L: string[] = [];
  L.push(
    `// ${flat(sb.name)}: storyboard ${lit(sb.slug)}${sb.version !== undefined ? ` version ${sb.version}` : ''} of project ${lit(o.project)} as a Playwright test.`,
    `// Exported from stubyard ${o.hubVersion} on ${at}.`,
    '//',
    '// Each run is an agent walkthrough in stubyard (runner "playwright-export"): the hub resolves every step at run time',
    '// (data sets, fresh users, vars, codes, email links), and the test reports each result with a screenshot. Steps are',
    '// addressed by id: edits to titles, intents or data set values need no new export; added, removed or re-kinded',
    '// steps do. Lines marked TODO could not be automated with certainty.',
    '//',
    `//   npm i -D @playwright/test ${o.hubUrl}/api/client.tgz`,
    `//   STUBYARD_URL=${o.hubUrl} APP_URL=${o.appOrigin || 'http://localhost:3000'} npx playwright test ${playwrightFileName(sb.slug)}`,
    '//',
    '// Env: STUBYARD_URL (the hub), STUBYARD_TOKEN (API token when the hub has sign-in on), APP_URL (the app origin),',
    `// STUBYARD_INPUT_<NAME> (storyboard inputs).`,
    "import { test, expect, type Locator, type Page } from '@playwright/test';",
    'import {',
    '  finishWalkthrough,',
    '  getTotpCode,',
    '  reportStep,',
    '  resolveStep,',
    '  startAgentWalkthrough,',
    '  waitForMessagePath,',
    '  type HubMessage,',
    '  type HubTarget,',
    '  type RenderedEntry,',
    '  type ResolvedStep,',
    '  type WalkthroughView,',
    "} from '@stubyard/client';",
    '',
    `const HUB: HubTarget = { apiUrl: process.env.STUBYARD_URL ?? ${lit(o.hubUrl)}, project: ${lit(o.project)}, apiToken: process.env.STUBYARD_TOKEN };`,
    `const APP_URL = process.env.APP_URL ?? ${lit(o.appOrigin)};`,
    `const STORYBOARD = ${lit(sb.slug)};`,
    `const RUNNER = { name: 'playwright-export', version: ${lit(o.hubVersion)} };`,
  );
  if (sb.inputs.length) {
    L.push('/** Storyboard inputs: STUBYARD_INPUT_<NAME>, else the input\'s default. */', 'const INPUTS = defined({');
    for (const i of sb.inputs) L.push(`  ${lit(i.name)}: process.env.${envName(i.name)}${i.default !== undefined ? ` ?? ${lit(i.default)}` : ''},${i.required ? ' // required' : ''}`);
    L.push('});');
  } else {
    L.push('const INPUTS: Record<string, string> = {};');
  }
  L.push('', `test(${lit(sb.name)}, async ({ page }) => {`, `  test.setTimeout(${timeoutSec * 1000});`, '  const run = await Run.start(page);', '  try {');
  for (const s of sb.steps) {
    L.push(`    // Step ${lit(s.id)} (${s.kind}${s.optional ? ', optional' : ''}): ${flat(s.intent)}`);
    L.push(`    await run.step(${lit(s.id)}, ${lit(s.kind)}, ${lit(s.title)}, async (r) => {`);
    for (const line of stepBody(s, o)) L.push(line ? `      ${line}` : '');
    L.push(s.optional ? '    }, { optional: true });' : '    });');
  }
  L.push('  } finally {', '    await run.finish();', '  }', '});', '');
  L.push(...HELPERS);
  return `${L.join('\n')}\n`;
}

/** The runtime helpers appended to every spec. */
const HELPERS = `// ---------------------------------------------------------------- helpers (generated by stubyard; edit freely)

type Kind = ResolvedStep['step']['kind'];
type Resolved<K extends Kind> = Extract<ResolvedStep, { step: { kind: K } }>;
type Outcome = { status?: 'done' | 'skipped'; note?: string; data?: Record<string, unknown>; value?: string };
type Value = RenderedEntry['value'];

/** One walkthrough per test: resolve → act → screenshot → report, then the verdict from the steps. */
class Run {
  private readonly statuses: string[] = [];
  private readonly page: Page;
  readonly w: WalkthroughView;

  private constructor(page: Page, w: WalkthroughView) {
    this.page = page;
    this.w = w;
  }

  static async start(page: Page): Promise<Run> {
    const w = await startAgentWalkthrough(HUB, { storyboard: STORYBOARD, origin: APP_URL, vars: INPUTS, label: \`Playwright \${new Date().toISOString()}\`, runner: RUNNER });
    return new Run(page, w);
  }

  async step<K extends Kind>(id: string, kind: K, title: string, body: (r: Resolved<K>) => Promise<Outcome | void>, o: { optional?: boolean } = {}): Promise<void> {
    await test.step(title, async () => {
      let r: ResolvedStep | null = null;
      let outcome: Outcome = {};
      let error: unknown = null;
      try {
        r = await resolveStep(HUB, this.w.id, id);
        if (r.step.kind !== kind) throw new Error(\`Step "\${id}" is a \${r.step.kind} step now (this test expects \${kind}): export the storyboard again\`);
        outcome = (await body(r as Resolved<K>)) ?? {};
      } catch (err) {
        error = err;
      }
      const screenshot = r?.step.screenshot === 'off' ? undefined : await this.shot();
      const status = error ? 'failed' : (outcome.status ?? 'done');
      this.statuses.push(status);
      try {
        await reportStep(HUB, this.w.id, id, error ? { status: 'failed', note: message(error), screenshot } : { status: outcome.status ?? 'done', note: outcome.note, data: outcome.data, value: outcome.value, screenshot });
      } catch (err) {
        console.warn(\`stubyard: step \${id} not reported: \${message(err)}\`);
      }
      if (error && !o.optional) throw error;
    });
  }

  /** Finishes the walkthrough: fail when a step failed, partial when one was skipped or never ran, else pass. */
  async finish(): Promise<void> {
    const failed = this.statuses.includes('failed');
    const partial = this.statuses.includes('skipped') || this.statuses.length < this.w.steps.length;
    try {
      await finishWalkthrough(HUB, this.w.id, { verdict: failed ? 'fail' : partial ? 'partial' : 'pass', allowIncomplete: true, note: \`Playwright export: \${this.statuses.length} of \${this.w.steps.length} steps run\` });
    } catch (err) {
      console.warn(\`stubyard: walkthrough \${this.w.key} not finished: \${message(err)}\`);
    }
  }

  /** A JPEG of the page as a data URL (none over the hub's 600 KB cap or when the page is gone). */
  private async shot(): Promise<string | undefined> {
    try {
      const jpeg = await this.page.screenshot({ type: 'jpeg', quality: 60 });
      return jpeg.length <= 440_000 ? \`data:image/jpeg;base64,\${jpeg.toString('base64')}\` : undefined;
    } catch {
      return undefined;
    }
  }
}

function message(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 4000);
}

function defined(o: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(o).filter((e): e is [string, string] => e[1] !== undefined && e[1] !== ''));
}

const css = (s: string): string => JSON.stringify(s);
const str = (x: Value | undefined): string => (Array.isArray(x) ? x.join(', ') : String(x ?? ''));
const list = (x: Value | undefined): string[] => (Array.isArray(x) ? x : [String(x ?? '')]);
const on = (x: Value | undefined): boolean => x === true || (typeof x === 'string' && /^(true|on|yes|1|checked)$/i.test(x));

/** "/regex/flags" → RegExp, anything else a plain regex source. */
function toRegExp(s: string): RegExp {
  const m = /^\\/(.+)\\/([dgimsuvy]*)$/.exec(s);
  return m ? new RegExp(m[1], m[2]) : new RegExp(s);
}

/** urlMatches: "/regex/flags", else a substring of the URL. */
function urlMatcher(s: string): RegExp {
  const m = /^\\/(.+)\\/([dgimsuvy]*)$/.exec(s);
  return m ? new RegExp(m[1], m[2]) : new RegExp(s.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'));
}

/** Substring (case-insensitive) or /regex/flags, as stubyard matches subjects and links. */
function matches(text: string | null | undefined, pattern: string | null | undefined): boolean {
  if (!pattern) return true;
  const m = /^\\/(.*)\\/([a-z]*)$/s.exec(pattern);
  if (m) return new RegExp(m[1], m[2]).test(text ?? '');
  return (text ?? '').toLowerCase().includes(pattern.toLowerCase());
}

/** The link an email step opens: link.pattern / link.index, else the only link that is not an unsubscribe link. */
function pickLink(links: string[], pattern: string | null, index: number | null): string | null {
  const unique = [...new Set(links)];
  const candidates = pattern ? unique.filter((l) => matches(l, pattern)) : unique;
  if (index !== null) return candidates[index] ?? null;
  if (pattern) return candidates[0] ?? null;
  const normal = unique.filter((l) => !/unsubscribe/i.test(l));
  return normal.length === 1 ? normal[0] : null;
}

function withQuery(path: string, set: Record<string, string>): string {
  const u = new URL(path, 'http://x');
  for (const [k, v] of Object.entries(set)) u.searchParams.set(k, v);
  return \`\${u.pathname}\${u.search}\`;
}

/** The email step's message: waits on the hub (long poll) up to \`seconds\`, skipping newer ones whose subject does not match. */
async function waitForStepMessage(r: Resolved<'email'>, seconds: number): Promise<HubMessage> {
  const until = Date.now() + seconds * 1000;
  let path = r.waitPath;
  while (Date.now() < until) {
    const left = Math.min(60, Math.max(1, Math.ceil((until - Date.now()) / 1000)));
    const msg = await waitForMessagePath(HUB, withQuery(path, { timeout: String(left) }));
    if (!msg) continue;
    if (matches(msg.subject, r.subject)) return msg;
    path = withQuery(r.waitPath, { after: String(msg.cursor ?? msg.id) });
  }
  throw new Error(\`No \${r.channel} message\${r.subject ? \` matching "\${r.subject}"\` : ''} within \${seconds}s\`);
}

/** The login recipe's second factor: the current TOTP code, or the email / SMS code that arrives. */
async function secondFactor(page: Page, r: Resolved<'login'>): Promise<void> {
  const tf = r.twoFactor;
  if (tf.kind === 'none') return;
  let code: string;
  if (tf.kind === 'totp') {
    let c = await getTotpCode(HUB, tf.codePath);
    if (c.remaining < 3) {
      await page.waitForTimeout(c.remaining * 1000 + 500);
      c = await getTotpCode(HUB, tf.codePath);
    }
    code = c.code;
  } else {
    const msg = await waitForMessagePath(HUB, tf.waitPath);
    if (!msg?.otp) throw new Error(\`No \${tf.kind === 'email-otp' ? 'email' : 'SMS'} code arrived\`);
    code = msg.otp;
  }
  await page.locator(tf.selector).fill(code);
  await page.locator(tf.selector).press('Enter');
}

/** The form a fill step works in (form#id or form[name]), else the whole page. */
function formScope(page: Page, formId: string | null): Locator {
  return formId ? page.locator(\`form[id=\${css(formId)}], form[name=\${css(formId)}]\`).first() : page.locator('body');
}

function values(r: Resolved<'fill'>): Record<string, Value> {
  return Object.fromEntries(r.entries.map((e) => [e.key, e.value]));
}

/** The field of a data entry: its selector, else id, name, data-testid, label or placeholder (as the extension matches). */
function field(scope: Locator, r: Resolved<'fill'>, key: string): Locator {
  const selector = r.entries.find((e) => e.key === key)?.selector;
  if (selector) return scope.locator(selector).first();
  const k = css(key);
  return scope
    .locator(\`[id=\${k}], [name=\${k}], [data-testid=\${k}]\`)
    .or(scope.getByLabel(key, { exact: true }))
    .or(scope.getByPlaceholder(key, { exact: true }))
    .first();
}

/** Fills a field by what it is on the page: select, checkbox / radio, or text. */
async function fillAuto(loc: Locator, value: Value): Promise<void> {
  const [tag, type] = await loc.evaluate((el) => [el.tagName.toLowerCase(), (el.getAttribute('type') ?? '').toLowerCase()]);
  if (tag === 'select') await loc.selectOption(list(value));
  else if (type === 'checkbox' || type === 'radio') await loc.setChecked(on(value));
  else await loc.fill(str(value));
}

/** Radix-style toggles (button role=checkbox): click when the state differs. */
async function setToggle(loc: Locator, want: boolean): Promise<void> {
  const state = (await loc.getAttribute('aria-checked')) ?? (await loc.getAttribute('data-state'));
  if ((state === 'true' || state === 'checked') !== want) await loc.click();
}

/** An input's value, else the element's text. */
async function readValue(loc: Locator): Promise<string> {
  const tag = await loc.evaluate((el) => el.tagName.toLowerCase());
  return tag === 'input' || tag === 'textarea' || tag === 'select' ? loc.inputValue() : loc.innerText();
}
`.split('\n');
