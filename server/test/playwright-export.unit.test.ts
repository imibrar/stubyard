import { transformSync } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { playwrightFileName, playwrightSpec, type ExportableStoryboard, type PlaywrightExportOptions } from '../src/storyboards/playwright-export.js';
import { DataSet, Step, STEP_KINDS } from '../src/storyboards/schema.js';
import type { StoredStep } from '../src/storyboards/types.js';

/** The Playwright export (A1 part 2): every step kind maps to code, step ids stay, and the output is valid TypeScript. */

const step = (s: Record<string, unknown>): StoredStep => Step.parse({ title: 'T', intent: 'Do it.', ...s }) as StoredStep;

const SB: ExportableStoryboard = {
  slug: 'signup',
  name: 'Sign up and confirm',
  version: 3,
  inputs: [
    { name: 'event', label: 'Event', required: true },
    { name: 'regNo', label: 'Reg', required: false, default: 'R-1' },
  ],
  steps: [
    step({ id: 'open', kind: 'open', title: 'Open the register page', intent: 'Start */ registration\nnow', url: '/register/{{vars.event}}' }),
    step({ id: 'form', kind: 'fill', title: 'Fill "the" form', dataSet: 'signup', formId: 'reg' }),
    step({ id: 'other-form', kind: 'fill', dataSet: 'missing' }),
    step({ id: 'confirm', kind: 'email', actor: 'participant', match: { subject: 'Confirm' }, link: { pattern: '/confirm' }, timeoutSec: 90 }),
    step({ id: 'sms-code', kind: 'email', actor: 'participant', channel: 'sms', open: 'none', target: { selector: '#code' } }),
    step({ id: 'regno', kind: 'capture', var: 'regNo', textPattern: 'Registration number: (\\S+)' }),
    step({ id: 'amount', kind: 'capture', var: 'amount', selector: '[data-testid="amount"]', attribute: 'data-value', required: false }),
    step({ id: 'admin-login', kind: 'login', actor: 'admin' }),
    step({ id: 'find', kind: 'check', expect: 'The registration is listed', assert: { textPresent: '{{vars.regNo}}', selector: '#list', urlMatches: '/admin/' } }),
    step({ id: 'eyeball', kind: 'check', expect: 'It looks right' }),
    step({ id: 'next', kind: 'instruction', title: 'Click Next', target: { selector: 'button[type=submit]' } }),
    step({ id: 'think', kind: 'instruction', title: 'Decide', optional: true }),
    step({ id: 'bye', kind: 'logout' }),
  ],
};

const DS = DataSet.parse({
  slug: 'signup',
  name: 'Sign-up',
  entries: [
    { key: 'email', value: '{{user.email}}', kind: 'text', label: 'Email' },
    { key: 'auto', value: 'x' },
    { key: 'country', value: 'SA', kind: 'select' },
    { key: 'terms', value: true, kind: 'checkbox' },
    { key: 'days', value: ['mon', 'tue'], kind: 'checkbox' },
    { key: 'size', value: 'L', kind: 'radio' },
    { key: 'plan', value: 'Gold', kind: 'radix-select' },
    { key: 'agree', value: true, kind: 'radix-checkbox' },
    { key: 'topics', value: ['A', 'B'], kind: 'radix-checkbox' },
    { key: 'tier', value: 'Pro', kind: 'radix-radio' },
    { key: 'born', value: '2000-01-01', kind: 'date' },
    { key: 'pin', value: '1234', kind: 'otp' },
    { key: 'hidden', value: 'h', kind: 'skip' },
  ],
});

const OPTS: PlaywrightExportOptions = {
  project: 'agent',
  hubUrl: 'http://localhost:4000',
  hubVersion: '9.9.9',
  appOrigin: 'http://app.test:3184',
  dataSets: { signup: DS },
  exportedAt: new Date('2026-11-26T10:00:00Z'),
};

/**
 * Syntax errors of a TypeScript file. TypeScript 7 (this repo's tsc) is a native binary without transpileModule, so
 * esbuild parses it (vite's dependency); it reports TypeScript syntax errors, not type errors.
 */
function diagnostics(code: string): string[] {
  try {
    transformSync(code, { loader: 'ts', sourcefile: 'signup.spec.ts', format: 'esm', target: 'es2022' });
    return [];
  } catch (err) {
    const errors = (err as { errors?: { text: string; location?: { line: number } | null }[] }).errors;
    return errors ? errors.map((e) => `${e.location?.line ?? '?'}: ${e.text}`) : [String(err)];
  }
}

describe('playwright export', () => {
  const spec = playwrightSpec(SB, OPTS);

  it('covers every step kind', () => {
    expect(new Set(SB.steps.map((s) => s.kind))).toEqual(new Set(STEP_KINDS));
  });

  it('is valid TypeScript', () => {
    expect(diagnostics(spec)).toEqual([]);
  });

  it('has the header, imports, env and runner', () => {
    expect(playwrightFileName('signup')).toBe('signup.spec.ts');
    expect(spec).toContain('// Sign up and confirm: storyboard "signup" version 3 of project "agent" as a Playwright test.');
    expect(spec).toContain('// Exported from stubyard 9.9.9 on 2026-11-26T10:00:00.000Z.');
    expect(spec).toContain("from '@playwright/test'");
    expect(spec).toContain("} from '@stubyard/client';");
    expect(spec).toContain('npm i -D @playwright/test http://localhost:4000/api/client.tgz');
    expect(spec).toContain('apiUrl: process.env.STUBYARD_URL ?? "http://localhost:4000", project: "agent", apiToken: process.env.STUBYARD_TOKEN');
    expect(spec).toContain('const APP_URL = process.env.APP_URL ?? "http://app.test:3184";');
    expect(spec).toContain(`const RUNNER = { name: 'playwright-export', version: "9.9.9" };`);
    expect(spec).toContain('"event": process.env.STUBYARD_INPUT_EVENT, // required');
    expect(spec).toContain('"regNo": process.env.STUBYARD_INPUT_REG_NO ?? "R-1",');
    expect(spec).toContain('startAgentWalkthrough(HUB, { storyboard: STORYBOARD, origin: APP_URL, vars: INPUTS');
    expect(spec).toContain('await run.finish();');
    expect(spec).toContain("verdict: failed ? 'fail' : partial ? 'partial' : 'pass', allowIncomplete: true");
  });

  it('addresses every step by id, one test.step each, with resolve → report', () => {
    for (const s of SB.steps) {
      expect(spec).toContain(`await run.step(${JSON.stringify(s.id)}, ${JSON.stringify(s.kind)}, ${JSON.stringify(s.title)}, async (r) => {`);
      expect(spec).toContain(`// Step ${JSON.stringify(s.id)} (${s.kind}`);
    }
    expect(spec).toContain('await test.step(title, async () => {');
    expect(spec).toContain('r = await resolveStep(HUB, this.w.id, id);');
    expect(spec).toContain('await reportStep(HUB, this.w.id, id,');
    expect(spec).toContain("const jpeg = await this.page.screenshot({ type: 'jpeg', quality: 60 });");
    // Multi-line intents stay on one comment line.
    expect(spec).toContain('// Step "open" (open): Start */ registration now');
    expect(spec).toContain('// Step "think" (instruction, optional): Do it.');
    expect(spec).toContain('    }, { optional: true });');
  });

  it('maps each step kind to Playwright code', () => {
    // open / login / logout
    expect(spec).toContain('await page.goto(r.url ?? APP_URL);');
    expect(spec).toContain('await page.locator(r.selectors.username).fill(r.username);');
    expect(spec).toContain('await secondFactor(page, r);');
    expect(spec).toContain('code = c.code;');
    expect(spec).toContain('else await page.context().clearCookies(); // TODO');
    // fill, by field kind
    expect(spec).toContain('if ("email" in v) await field(form, r, "email").fill(str(v["email"]));');
    expect(spec).toContain('if ("auto" in v) await fillAuto(field(form, r, "auto"), v["auto"]);');
    expect(spec).toContain('if ("country" in v) await field(form, r, "country").selectOption(list(v["country"]));');
    expect(spec).toContain('if ("terms" in v) await field(form, r, "terms").setChecked(on(v["terms"]));');
    expect(spec).toContain('input[type="checkbox"][name=${css("days")}][value=${css(x)}]');
    expect(spec).toContain('input[type="radio"][name=${css("size")}]');
    expect(spec).toContain(`await page.getByRole('option', { name: str(v["plan"]), exact: true }).click();`);
    expect(spec).toContain('// plan: radix-select. TODO: best effort');
    expect(spec).toContain('if ("agree" in v) await setToggle(field(form, r, "agree"), on(v["agree"]));');
    expect(spec).toContain(`await setToggle(form.getByRole('checkbox', { name: x, exact: true }), true);`);
    expect(spec).toContain(`if ("tier" in v) await form.getByRole('radio', { name: str(v["tier"]), exact: true }).click();`);
    expect(spec).toContain('if ("born" in v) await field(form, r, "born").fill(str(v["born"]));');
    expect(spec).toContain('// hidden: skip, left alone');
    expect(spec).not.toContain('field(form, r, "hidden")');
    expect(spec).toContain('// Email (email): text');
    expect(spec).toContain('const exported = new Set(["email","auto","country","terms","days","size","plan","agree","topics","tier","born","pin","hidden"]);');
    expect(spec).toContain('// TODO: data set "missing" was not found at export');
    // email: link, and an SMS code into the target
    expect(spec).toContain('const msg = await waitForStepMessage(r, 90);');
    expect(spec).toContain('const link = pickLink(msg.links, r.linkPattern, r.linkIndex);');
    expect(spec).toContain('await page.goto(link);');
    expect(spec).toContain('const msg = await waitForStepMessage(r, 120);');
    expect(spec).toContain(".first().fill(msg.otp);");
    // capture: pattern over the page, attribute of a selector; the value goes to the hub
    expect(spec).toContain("const raw = await page.locator('body').innerText();");
    expect(spec).toContain('const m = toRegExp(r.textPattern!).exec(raw);');
    expect(spec).toContain("const raw = (await page.locator(r.selector!).first().getAttribute(r.attribute!)) ?? '';");
    expect(spec).toContain('return { value }; // stored by the hub as {{vars.regNo}}');
    expect(spec).toContain('if (!value) throw new Error("Nothing to capture into vars.regNo");');
    expect(spec).toContain(`if (!value) return { status: 'skipped', note: "Nothing to capture into vars.amount (optional)" };`);
    // check: the assert, or a TODO + skipped
    expect(spec).toContain('await expect(page).toHaveURL(urlMatcher(r.assert!.urlMatches!));');
    expect(spec).toContain('await expect(page.locator(r.assert!.selector!).first()).toBeVisible();');
    expect(spec).toContain("await expect(page.locator('body')).toContainText(r.assert!.textPresent!, { ignoreCase: true });");
    expect(spec).toContain("// TODO: automate this check (the step has no assert: the person judged it).");
    expect(spec).toContain("return { status: 'skipped', note: 'No assert to automate' };");
    // instruction: a target click (TODO), or TODO + skipped
    expect(spec).toContain("await page.locator(r.target?.selector ?? r.step.target?.selector ?? '').first().click();");
    expect(spec).toContain("return { status: 'skipped', note: 'Instruction not automated' };");
  });

  it('gives unknown step kinds a TODO and reports them skipped', () => {
    const odd = { ...SB, steps: [{ ...SB.steps[0], kind: 'teleport' } as unknown as StoredStep] };
    const out = playwrightSpec(odd, OPTS);
    expect(out).toContain('// TODO: automate this step (kind "teleport" is not known to this exporter).');
    expect(out).toContain("return { status: 'skipped', note: 'Not automated in the Playwright export' };");
    expect(diagnostics(out)).toEqual([]);
  });

  it('without inputs or an app origin it is still valid', () => {
    const out = playwrightSpec({ ...SB, inputs: [], version: undefined }, { ...OPTS, appOrigin: '', dataSets: {} });
    expect(out).toContain('const INPUTS: Record<string, string> = {};');
    expect(out).toContain('const APP_URL = process.env.APP_URL ?? "";');
    expect(diagnostics(out)).toEqual([]);
  });
});
