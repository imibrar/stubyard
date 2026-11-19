import { describe, expect, it } from 'vitest';
import {
  checkSms,
  collectLinks,
  findEncodingErrors,
  findLeakedValues,
  findMixedScriptWords,
  findPlaceholders,
  highestSeverity,
  isLocalHost,
  lintMessage,
  mimeHasTextPart,
  parseHeaderBlock,
  type LintInput,
} from '../src/lint/checks.js';
import { judgeReject, malformed, oversized, tamper } from '../src/webhooks/security.js';

const tokens = (text: string) => findPlaceholders(text).map((p) => p.token);
const checks = (input: LintInput) => lintMessage(input).map((f) => f.check);
const email = (over: Partial<LintInput> = {}): LintInput => ({ channel: 'email', subject: 'Your code', text: 'Your code is 123456.', fromName: 'Hyper', hasTextPart: true, ...over });

describe('placeholders', () => {
  it.each([
    ['Hi {{name}}, welcome', '{{name}}'],
    ['Hi {{ user.first_name }}!', '{{ user.first_name }}'],
    ['Hi {{{raw}}}', '{{{raw}}}'],
    ['{% if vip %}VIP{% endif %}', '{% if vip %}'],
    ['Hello {!! $name !!}', '{!! $name !!}'],
    ['Reset: https://app.io/r?t=%7B%7Btoken%7D%7D', '%7B%7Btoken%7D%7D'],
    ['Hello ${firstName}', '${firstName}'],
    ['Hello ${ user.name }', '${ user.name }'],
    ['Hello #{name}', '#{name}'],
    ['Hello *|FNAME|*', '*|FNAME|*'],
    ['Hello %%FirstName%%', '%%FirstName%%'],
    ['Hello [[name]]', '[[name]]'],
    ['Dear {name}, thanks', '{name}'],
    ['Order {order.id} shipped', '{order.id}'],
    ['Hello {0}, you have {1} items', '{0}'],
    ['Your code is %s', '%s'],
    ['You have %d new messages', '%d'],
    ['Total: %.2f', '%.2f'],
    ['Hi %(name)s!', '%(name)s'],
    ['Hi %1$s', '%1$s'],
    ['Hi %@', '%@'],
    ['Welcome :name to the app', ':name'],
    ['Your code :code expires in :minutes minutes', ':code'],
    ['Hello :first_name', ':first_name'],
    ['Hello __NAME__', '__NAME__'],
    ['Hello __first_name__', '__first_name__'],
    ['Hello __name__', '__name__'],
  ])('flags %j', (text, token) => {
    expect(tokens(text)).toContain(token);
  });

  it.each([
    'Your code is 123456. It expires in 10 minutes.',
    'Save 50% on everything',
    '100%sure deals', // no space, after a digit
    'Up to 20% discount on shoes',
    'Use %% to escape',
    'Meeting at 10:30, see you',
    'Note: bring your ID',
    'Ratio 3:2 in the chart',
    'Great news :smile: today',
    'Visit https://example.org/path%2d1?x=%20y',
    'Mail me at a%s@b.com',
    'This is __important__ news', // markdown bold
    'Price: {}', // handled by leaked-value, not as a placeholder
    'JSON looks like {"a": 1}',
    'Set {x} in math class', // single-letter identifiers ignored
    'Time 12:45:00 UTC',
    'Order #12345 confirmed',
    'Shop at https://shop.test/?q=:name', // ambiguous inside URLs: skipped
  ])('does not flag %j', (text) => {
    expect(tokens(text)).toEqual([]);
  });
});

describe('leaked values', () => {
  const found = (t: string) => findLeakedValues(t).map((f) => [f.severity, f.message.match(/\(([^)]+)\)|"([^"]+)"/)?.slice(1).find(Boolean)]);
  it.each([
    ['Hi undefined, welcome', 'error'],
    ['Reset: https://app.io/reset/undefined', 'error'],
    ['token=undefined&x=1', 'error'],
    ['Total: NaN PKR', 'error'],
    ['Hello [object Object]', 'error'],
    ['Delivery on Invalid Date', 'error'],
    ['Hi null, welcome', 'warn'],
    ['Phone: NULL', 'warn'],
    ['Items: [] today', 'warn'],
    ['Data: {}', 'warn'],
  ])('flags %j', (text, severity) => {
    const f = findLeakedValues(text);
    expect(f.length).toBeGreaterThan(0);
    expect(f[0].severity).toBe(severity);
  });
  it.each([
    'The behaviour is undefined in this case',
    'An undefined error occurred',
    'This contract is null and void',
    'Banana bread recipe', // "nan" inside a word
    'Nan and Grandpa say hi',
    'The null hypothesis was rejected',
    'Use the array syntax a[] in PHP',
    'undefinedBehaviour is a variable name',
    'Your code is 123456',
  ])('does not flag %j', (text) => {
    expect(found(text)).toEqual([]);
  });
});

describe('charset and scripts', () => {
  it('flags the replacement character and mojibake', () => {
    expect(findEncodingErrors('Caf� au lait')).toHaveLength(1);
    expect(findEncodingErrors('Itâ€™s ready')).toHaveLength(1);
    expect(findEncodingErrors('CafÃ© opens')).toHaveLength(1);
  });
  it('does not flag proper text in any script', () => {
    expect(findEncodingErrors('It’s ready — café, naïve, Ünïcode')).toEqual([]);
    expect(findEncodingErrors('آپ کا کوڈ 123456 ہے')).toEqual([]);
    expect(findEncodingErrors('Ваш код 123456')).toEqual([]);
  });
  it('flags words mixing Latin with Cyrillic / Greek only', () => {
    expect(findMixedScriptWords('Log in to Pаypal now').map((w) => w.word)).toEqual(['Pаypal']); // Cyrillic а
    expect(findMixedScriptWords('Ваш код: 1234, your code')).toEqual([]); // separate words are fine
    expect(findMixedScriptWords('آپ کا code 1234 ہے')).toEqual([]); // Urdu + English sentence
    expect(findMixedScriptWords('Ωmega sale')).toHaveLength(1);
  });
});

describe('links', () => {
  it('knows local hosts', () => {
    for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.1.5', '172.20.0.2', 'app.local', 'shop.test', 'host.docker.internal', 'devhub', '[::1]', 'api.localhost'])
      expect(isLocalHost(h), h).toBe(true);
    for (const h of ['example.com', 'app.hyper.pk', '8.8.8.8', '172.32.0.1', 'testing.com', 'localhost.company.com'])
      expect(isLocalHost(h), h).toBe(false);
  });

  const linkChecks = (text: string, html: string | null = null, productionDomains: string[] = []) =>
    lintMessage({ channel: 'email', subject: 's', text, html, productionDomains, fromName: 'x', hasTextPart: true }).filter((f) => f.check.startsWith('link') || f.check === 'mailto-empty');

  it.each([
    ['Verify: http://localhost:3000/verify?t=1', 'link-local', 'warn'],
    ['Verify: https://127.0.0.1/verify', 'link-local', 'warn'],
    ['Open https://app.test/x', 'link-local', 'warn'],
    ['Open http://example.org/x', 'link-http', 'info'],
    ['Open https://app.hyper.pk/x', 'link-production', 'warn'],
    ['Open https://example.org/x?utm_source=a&utm_source=b', 'link-tracking', 'warn'],
    ['Open https://example.org/x?a=1?utm_source=mail', 'link-tracking', 'warn'],
    ['Open https://https://example.org/x', 'link-broken', 'warn'],
    ['Open https://example.org/(x', 'link-broken', 'warn'],
  ])('%j → %s', (text, check, severity) => {
    const f = linkChecks(text, null, ['hyper.pk']);
    expect(f.map((x) => x.check)).toContain(check);
    expect(f.find((x) => x.check === check)!.severity).toBe(severity);
  });

  it('checks hrefs and img src in HTML', () => {
    const f = linkChecks('', '<a href="https://example.org/a b">x</a><a href="">e</a><a href="mailto:">mail</a><img src="http://localhost/logo.png" alt="logo">');
    expect(f.map((x) => x.check).sort()).toEqual(['link-broken', 'link-broken', 'link-local', 'mailto-empty']);
  });

  it.each([
    'Visit https://example.org/a.',
    'Visit https://example.org/wiki/Foo_(bar)',
    '(see https://example.org/x)',
    'Mail support@example.org or mailto:support@example.org',
    'Call tel:+923001234567',
    'Open https://example.org/?utm_source=a&utm_medium=b',
    'Use https://example.org/x?redirect=/y?z=1',
    'Open https://app.hyper.pk.evil.org/', // not a production subdomain
  ])('does not flag %j', (text) => {
    expect(linkChecks(text, null, ['hyper.pk'])).toEqual([]);
  });

  it('trims sentence punctuation and decodes entities', () => {
    expect(collectLinks('See https://example.org/x).', null).map((l) => l.url)).toEqual(['https://example.org/x']);
    expect(collectLinks('', '<a href="https://example.org/?a=1&amp;b=2">x</a>').map((l) => l.url)).toContain('https://example.org/?a=1&b=2');
  });

  it('skips placeholder URLs in link checks (reported as placeholders)', () => {
    const f = lintMessage(email({ text: 'Reset: http://localhost/{{token}}' }));
    expect(f.map((x) => x.check)).toEqual(['placeholder']);
  });
});

describe('email', () => {
  const marketing = (headers: Record<string, string>) => lintMessage(email({ instanceLabels: ['marketing'], headers })).filter((f) => f.check === 'email-unsubscribe');
  it('requires one-click List-Unsubscribe on marketing instances', () => {
    expect(marketing({})).toHaveLength(1);
    expect(marketing({})[0].severity).toBe('error');
    expect(marketing({ 'List-Unsubscribe': '<https://x.io/u?id=1>' }).map((f) => f.message)).toEqual(['Missing List-Unsubscribe-Post: List-Unsubscribe=One-Click']);
    expect(marketing({ 'list-unsubscribe': '<mailto:u@x.io>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' })[0].severity).toBe('warn');
    expect(marketing({ 'List-Unsubscribe': '<mailto:u@x.io>, <https://x.io/u>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' })).toEqual([]);
  });
  it('does not require List-Unsubscribe on transactional instances or when headers are unknown', () => {
    expect(checks(email({ instanceLabels: ['primary'], headers: {} }))).not.toContain('email-unsubscribe');
    expect(checks(email({ instanceLabels: ['marketing'], headers: null }))).not.toContain('email-unsubscribe');
  });
  it('flags a missing text part, subject problems, a bare From and images without alt', () => {
    const f = lintMessage(email({ subject: '', fromName: null, html: '<p>Hi</p><img src="https://cdn.x.io/a.png"><img src="https://x.io/p.gif" width="1" height="1">', hasTextPart: false }));
    const by = Object.fromEntries(f.map((x) => [x.check, x]));
    expect(by['email-text-part'].severity).toBe('warn');
    expect(by['email-subject'].message).toBe('Empty subject');
    expect(by['email-from-name'].severity).toBe('info');
    expect(by['email-img-alt'].message).toBe('1 image without alt text'); // the 1×1 pixel is ignored
    expect(checks(email({ subject: 'x'.repeat(121) }))).toContain('email-subject');
    expect(checks(email({ subject: 'x'.repeat(120) }))).not.toContain('email-subject');
  });
  it('a clean transactional email has no findings', () => {
    expect(lintMessage(email({ html: '<p>Your code is <b>123456</b></p><img src="https://cdn.x.io/logo.png" alt="">', text: 'Your code is 123456' }))).toEqual([]);
  });
  it('flags HTML over 102 KB (Gmail clipping)', () => {
    expect(checks(email({ html: `<p>${'a'.repeat(103 * 1024)}</p>` }))).toContain('email-size');
    expect(checks(email({ html: `<p>${'a'.repeat(100 * 1024)}</p>` }))).not.toContain('email-size');
  });
  it('ignores placeholders in <style>, <script> and comments but sees attributes', () => {
    const html = '<style>.a{color:red}</style><!--[if mso]>{{mso}}<![endif]--><script>var x = {{y}};</script><p>Hi</p><a href="https://x.io/{{id}}">go</a>';
    expect(lintMessage(email({ html })).filter((f) => f.check === 'placeholder').map((f) => f.excerpt)).toEqual(['{{id}}']);
  });
  it('HTML-only email: checks the HTML, not the text mailparser derived from it (wrapped URLs)', () => {
    const f = lintMessage(email({ html: '<p>Total NaN</p><a href="http://localhost:3000/c?t=1">c</a>', text: 'Total NaN\n[http://localhost:3000/c?t\n=1]', hasTextPart: false }));
    expect(f.filter((x) => x.check === 'link-local').map((x) => x.excerpt)).toEqual(['http://localhost:3000/c?t=1']);
    expect(f.filter((x) => x.check === 'leaked-value')).toHaveLength(1);
  });
  it('images from a production CDN are fine, links to production are not', () => {
    const f = lintMessage(email({ html: '<img src="https://cdn.hyper.app/logo.png" alt=""><a href="https://hyper.app/login">x</a>', productionDomains: ['hyper.app'] }));
    expect(f.map((x) => x.excerpt)).toEqual(['https://hyper.app/login']);
  });
  it('parses raw headers and detects a text part', () => {
    const raw = 'From: A <a@x.io>\r\nList-Unsubscribe: <https://x.io/u>,\r\n <mailto:u@x.io>\r\nContent-Type: text/html\r\n\r\n<p>x</p>';
    expect(parseHeaderBlock(raw)['List-Unsubscribe']).toBe('<https://x.io/u>, <mailto:u@x.io>');
    expect(mimeHasTextPart(raw)).toBe(false);
    expect(mimeHasTextPart('Subject: x\r\n\r\nplain body')).toBe(true);
    expect(mimeHasTextPart('Content-Type: multipart/alternative; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nx\r\n--b--')).toBe(true);
  });
});

describe('SMS', () => {
  it('warns when a single curly quote forces UCS-2 and costs segments', () => {
    const text = `Your order is ready. We’ll deliver it tomorrow. ${'Thanks for shopping with us. '.repeat(3)}`; // > 70, < 160 chars
    const f = checkSms(text).find((x) => x.check === 'sms-encoding')!;
    expect(f.severity).toBe('warn');
    expect(f.message).toContain('’ (U+2019)');
    expect(f.message).toMatch(/[2-3] segments instead of 1 as GSM-7/);
  });
  it('emoji and dashes count as smart characters; info when it costs nothing', () => {
    const f = checkSms('Code 1234 – valid 10 min 👍').find((x) => x.check === 'sms-encoding')!;
    expect(f.severity).toBe('info');
    expect(f.message).toMatch(/– \(U\+2013\).*👍 \(U\+1F44D\)/);
  });
  it('does not flag real non-Latin text or plain GSM-7', () => {
    expect(checkSms('آپ کا کوڈ 123456 ہے').filter((x) => x.check === 'sms-encoding')).toEqual([]);
    expect(checkSms('Ваш код 123456 – спасибо').filter((x) => x.check === 'sms-encoding')).toEqual([]);
    expect(checkSms('Your code is 123456. Don\'t share it, {really}.')).toEqual([]);
  });
  it('segments: info over 1, warn over 3', () => {
    expect(checkSms('a'.repeat(161)).map((f) => [f.check, f.severity])).toEqual([['sms-segments', 'info']]);
    expect(checkSms('a'.repeat(153 * 3 + 1)).map((f) => [f.check, f.severity])).toEqual([['sms-segments', 'warn']]);
    expect(checkSms('a'.repeat(160))).toEqual([]);
  });
  it('placeholders apply to SMS too', () => {
    expect(checks({ channel: 'sms', text: 'Your code is {{code}}' })).toEqual(['placeholder']);
  });
});

describe('WhatsApp', () => {
  it('flags empty template parameters', () => {
    const f = lintMessage({ channel: 'whatsapp', text: '[template otp · en] ', waTemplate: { name: 'otp', params: ['Ali', '', null] } });
    expect(f.map((x) => [x.check, x.severity])).toEqual([['wa-template-params', 'error']]);
    expect(f[0].message).toContain('#2, #3');
    expect(lintMessage({ channel: 'whatsapp', text: 'x', waTemplate: { name: 'otp', params: ['Ali', '1234'] } })).toEqual([]);
  });
  it('flags text over 4096 characters', () => {
    expect(checks({ channel: 'whatsapp', text: 'a'.repeat(4097) })).toEqual(['wa-length']);
    expect(checks({ channel: 'whatsapp', text: 'a'.repeat(4096) })).toEqual([]);
  });
});

describe('settings and ordering', () => {
  it('disabled checks are skipped', () => {
    expect(checks({ channel: 'sms', text: 'Hi {{name}} http://localhost/x', disabled: ['placeholder'] })).toEqual(['link-local']);
  });
  it('sorts errors first and reports the highest severity', () => {
    const f = lintMessage({ channel: 'sms', text: 'Open http://example.org now, null, {{name}}' });
    expect(f.map((x) => x.severity)).toEqual(['error', 'warn', 'info']);
    expect(highestSeverity(f)).toBe('error');
    expect(highestSeverity([])).toBeNull();
  });
  it('dedupes repeated tokens and caps findings per check', () => {
    const f = lintMessage({ channel: 'sms', text: Array.from({ length: 20 }, (_, i) => `{{v${i}}} {{v0}}`).join(' ') });
    expect(f.filter((x) => x.check === 'placeholder')).toHaveLength(8);
  });
});

describe('webhook security helpers', () => {
  it('tampers, pads and breaks bodies', () => {
    expect(JSON.parse(tamper('{"id":"evt_1"}'))).toEqual({ id: 'evt_1', devhub_tampered: true });
    expect(tamper('a=1')).toBe('a=1x');
    const big = oversized('{"id":1}');
    expect(big.length).toBeGreaterThan(1024 * 1024);
    expect(JSON.parse(big).id).toBe(1);
    for (const b of ['{"id":"evt_1","type":"x","data":{"a":[1,2]}}', '{}', '[1,2,3]']) expect(() => JSON.parse(malformed(b))).toThrow();
  });
  it('judges variants that must be rejected', () => {
    expect(judgeReject('security', { status: 200, error: null }).verdict).toBe('fail');
    expect(judgeReject('security', { status: 401, error: null }).verdict).toBe('pass');
    expect(judgeReject('security', { status: 500, error: null }).verdict).toBe('warn');
    expect(judgeReject('security', { status: null, error: 'ECONNREFUSED' }).verdict).toBe('error');
    expect(judgeReject('input', { status: 204, error: null }).verdict).toBe('fail');
    expect(judgeReject('size', { status: 200, error: null }).verdict).toBe('warn');
    expect(judgeReject('size', { status: 413, error: null }).verdict).toBe('pass');
    expect(judgeReject('contentType', { status: 200, error: null }).verdict).toBe('info');
    expect(judgeReject('contentType', { status: 502, error: null }).verdict).toBe('warn');
  });
});
