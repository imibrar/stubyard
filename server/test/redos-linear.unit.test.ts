// Inputs that made the old regexes polynomial (CodeQL js/polynomial-redos): each fixed function must finish fast on
// ~100k adversarial characters and still give the same results on ordinary input.
import { describe, expect, it } from 'vitest';
import { render, variablesOf } from '../src/autoreplies/template.js';
import { lintMessage, type LintInput } from '../src/lint/checks.js';
import { extractOtp, htmlToText } from '../src/messages/extract.js';
import { looksLikeEmail, trimEnd, trimStart } from '../src/util.js';
import { validateSchema } from '../src/webhooks/schema.js';
import { normalizeSecret } from '../src/totp/totp.js';
import { normalizeHookPath } from '../src/repos/webhooks.js';

const N = 100_000;

function fast<T>(fn: () => T, ms = 200): T {
  const t0 = performance.now();
  const out = fn();
  expect(performance.now() - t0).toBeLessThan(ms);
  return out;
}

const vars = {
  otp: '1234',
  links: [],
  subject: null,
  body: null,
  from: null,
  to: null,
  channel: 'email' as const,
  user: null,
  captures: {},
};

describe('autoreply templates', () => {
  it('render / variablesOf are linear on "{{{{" + spaces', () => {
    const t = '{{{{' + ' '.repeat(N);
    expect(fast(() => render(t, vars)).text).toBe(t);
    expect(fast(() => variablesOf(t))).toEqual([]);
    const closed = '{{' + ' '.repeat(N) + 'otp' + ' '.repeat(N) + '}}';
    expect(fast(() => render(closed, vars)).text).toBe('1234');
  });

  it('keeps the old placeholder results', () => {
    expect(render('{{otp}} {{ otp }} {{\totp\n}}', vars).text).toBe('1234 1234 1234');
    expect(render('a {{}} b', vars)).toEqual({ text: 'a {{}} b', warnings: [] });
    expect(render('a {{ }} b', vars)).toEqual({ text: 'a  b', warnings: ['template: {{ }} is not a known variable or capture; left empty'] });
    expect(render('{{{otp}}}', vars).text).toBe('{1234}');
    expect(variablesOf('{{otp}} {{ body.1 }} {{}} {{  }} {{ a b }}')).toEqual(['otp', 'body.1', ' ', 'a b']);
  });
});

describe('lint List-Unsubscribe', () => {
  const marketing = (lu: string) =>
    lintMessage({ channel: 'email', subject: 's', text: 't', fromName: 'f', hasTextPart: true, instanceLabels: ['marketing'], headers: { 'List-Unsubscribe': lu, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } } as LintInput).filter((f) => f.check === 'email-unsubscribe');

  it('is linear on repeated "<https://" and "<mailto:"', () => {
    expect(fast(() => marketing('<https://'.repeat(N / 9)))[0].severity).toBe('error');
    expect(fast(() => marketing('<mailto:'.repeat(N / 8)))[0].severity).toBe('error');
  });

  it('keeps the old results', () => {
    expect(marketing('<https://x.io/u>')).toEqual([]);
    expect(marketing('<mailto:u@x.io>, <https://x.io/u>')).toEqual([]);
    expect(marketing('<mailto:u@x.io>')[0].severity).toBe('warn');
    expect(marketing('https://x.io/u')[0].severity).toBe('error');
  });
});

describe('extract', () => {
  it('extractOtp is linear on long runs of email characters', () => {
    expect(fast(() => extractOtp('a'.repeat(N)))).toBeNull();
    expect(fast(() => extractOtp('+'.repeat(N)))).toBeNull();
    expect(fast(() => extractOtp('a.'.repeat(N / 2)))).toBeNull();
    expect(fast(() => extractOtp('a@b.c+'.repeat(N / 6)))).toBeNull();
  });

  it('extractOtp still skips numbers inside email addresses', () => {
    expect(extractOtp('Your code is 482913. Reply to support4821@acme.test')).toBe('482913');
    expect(extractOtp('Your code is in a@b.co+123456@c.co')).toBeNull();
  });

  it('htmlToText is linear on repeated "<style", "<script>" and "<"', () => {
    fast(() => htmlToText('<style'.repeat(N / 6)));
    fast(() => htmlToText('<script>'.repeat(N / 8)));
    fast(() => htmlToText('<style>x'.repeat(N / 8) + '>'));
    expect(fast(() => htmlToText('<'.repeat(N)))).toBe('<'.repeat(N));
    expect(fast(() => htmlToText('<'.repeat(N) + '>'))).toBe('');
    fast(() => htmlToText('<>'.repeat(N / 2)));
  });

  it('htmlToText keeps the old results', () => {
    expect(htmlToText('<style>p{}</style><p>Hello&nbsp;<b>World</b></p><br>Bye &amp; thanks')).toBe('Hello World\n\nBye & thanks');
    expect(htmlToText('a<>b <script src="x">alert(1)</script>c')).toBe('a<>b c');
    expect(htmlToText('1 < 2 and <b>3</b> > 2')).toBe('1 3 > 2');
  });
});

describe('email checks', () => {
  const bad = '!@!.' + '!.'.repeat(N / 2);
  it('looksLikeEmail and format:email are fast and reject > 320 chars', () => {
    expect(fast(() => looksLikeEmail(bad))).toBe(false);
    expect(fast(() => validateSchema({ type: 'string', format: 'email' }, bad))).toHaveLength(1);
    expect(looksLikeEmail('a'.repeat(300) + '@b.io')).toBe(true);
    expect(looksLikeEmail('a'.repeat(320) + '@b.io')).toBe(false);
  });

  it('keeps the old results up to 320 chars', () => {
    expect(looksLikeEmail('u@a.test')).toBe(true);
    expect(looksLikeEmail('u@a')).toBe(false);
    expect(looksLikeEmail('u @a.test')).toBe(false);
    expect(looksLikeEmail('u@@a.test')).toBe(false);
    expect(validateSchema({ type: 'string', format: 'email' }, 'u@a.test')).toEqual([]);
  });

  it('ignores formats that are not own keys of the format table', () => {
    for (const format of ['__proto__', 'constructor', '__defineGetter__', 'toString', 'nope']) {
      expect(validateSchema({ type: 'string', format }, 'x')).toEqual([]);
    }
  });
});

describe('trim helpers', () => {
  it('are linear on long runs', () => {
    expect(fast(() => trimEnd('/'.repeat(N) + 'a', '/'))).toBe('/'.repeat(N) + 'a');
    expect(fast(() => trimEnd('a' + '/'.repeat(N), '/'))).toBe('a');
    expect(fast(() => normalizeSecret('='.repeat(N) + 'A'))).toBe('='.repeat(N) + 'A');
    expect(fast(() => normalizeHookPath('/'.repeat(N) + 'a' + '/'.repeat(N)))).toBe('a');
  });

  it('match the old regex results', () => {
    for (const s of ['', '/', '//', 'a', 'a/', 'a//', '/a/b//', 'http://x.io/']) {
      expect(trimEnd(s, '/')).toBe(s.replace(/\/+$/, ''));
      expect(trimStart(s, '/')).toBe(s.replace(/^\/+/, ''));
    }
    expect(trimEnd('ab=-=', '=-')).toBe('ab');
    expect(normalizeSecret('jbsw y3dp-ehpk 3pxp==')).toBe('JBSWY3DPEHPK3PXP');
    expect(normalizeHookPath('//a//b/')).toBe('a/b');
  });
});
