// Walkthrough recording R1 in the extension: the masking rules and rrweb options (shared/recording.ts), the recorder's
// chunks, flushes, segments per page load and pause (content/recorder.ts, with a fake rrweb and fake timers), the
// content request wiring, and the service worker's sync and chunk relay (background/recordingSync.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WalkthroughView } from '@stubyard/client/storyboard-types';
import { handleRecordingChunk, recordingConfig, type RecordingDeps, syncRecordingTab, syncRecordingTabs } from '../src/background/recordingSync';
import { Recorder, type RecorderDeps, type RrwebRecord } from '../src/content/recorder';
import { CONTENT_VERSION, type ContentRequest } from '../src/shared/protocol';
import {
  FLUSH_EVENTS,
  FLUSH_MS,
  HEARTBEAT_MS,
  isSensitiveInput,
  MAX_EVENT_BYTES,
  maskSecretsInText,
  NOTE_EVENT_TAG,
  RECORD_BLOCK_SELECTOR,
  type RecordingChunkMessage,
  type RecordingChunkReply,
  type RecordingConfig,
  recordOptions,
  redactUrl,
  type SensitiveMemory,
  STEP_EVENT_TAG,
} from '../src/shared/recording';
import { SensitiveTracker } from '../src/content/sensitive';
import { defaultSettings, type Settings } from '../src/shared/settings';
import { recordingUiState } from '../src/run/RecordingBar';
import { defaultRecording, startBody } from '../src/sidepanel/state';

const el = (html: string) => {
  document.body.innerHTML = html;
  return document.body.firstElementChild!;
};

describe('masking', () => {
  it('always masks passwords, one-time codes, card fields and OTP-looking names', () => {
    for (const html of [
      // Found by the security review of R1: split code boxes, a card field without autocomplete, a text input shown
      // as dots, an API key field, a card expiry.
      '<input class="d" maxlength="1" inputmode="numeric">',
      '<input maxlength="6" inputmode="numeric" name="x">',
      '<input id="card" name="cardnumber" placeholder="Card number">',
      '<input name="password" type="text" style="-webkit-text-security:disc">',
      '<input style="-webkit-text-security: circle">',
      '<input id="apikey" name="api_key">',
      '<input autocomplete="cc-exp">',
      '<input name="ccExp">',
      '<input name="expiry">',
      '<input name="iban">',
      '<input name="clientSecret">',
      '<input name="access_token">',
      '<input id="pw2" type="text" name="pw2" autocomplete="current-password">',
      '<input placeholder="Recovery code">',
      '<input type="password">',
      '<input type="text" data-rr-is-password>',
      '<input autocomplete="one-time-code">',
      '<input autocomplete="cc-number">',
      '<input name="totp">',
      '<input id="mfaCode">',
      '<input name="otp_code">',
      '<input placeholder="2FA code">',
      '<input name="verification-code">',
      '<input name="cvv">',
    ])
      expect(isSensitiveInput(el(html), []), html).toBe(true);
    for (const html of ['<input type="text" name="email">', '<input name="topic">', '<input name="description">', '<input name="shipping">', '<textarea name="notes"></textarea>'])
      expect(isSensitiveInput(el(html), []), html).toBe(false);
  });

  it('masks the run selectors (the 2FA field of the login recipe) and fields stubyard filled as secrets', () => {
    expect(isSensitiveInput(el('<input id="code-box">'), ['#code-box'])).toBe(true);
    expect(isSensitiveInput(el('<input id="x">'), ['##bad', '#x'])).toBe(true); // an invalid selector is skipped
    const plain = el('<input id="plain">');
    const marked = new WeakSet<Element>([plain]);
    const mem: SensitiveMemory = { isMarked: (e) => marked.has(e), isSecretValue: (v) => v === 'hunter2!', secretValues: () => ['hunter2!'] };
    expect(isSensitiveInput(plain, [], mem)).toBe(true);
    expect(isSensitiveInput(plain, [])).toBe(false);
    // A field holding a value the extension typed as a secret (a password copied into a text field).
    const copy = el('<input id="copy">') as HTMLInputElement;
    copy.value = 'hunter2!';
    expect(isSensitiveInput(copy, [], mem)).toBe(true);
  });

  it('masks every input by default; the unmask list shows plain fields only, never sensitive ones', () => {
    const o = recordOptions({ maskAllInputs: false, maskSelectors: [], unmaskSelectors: ['input', 'textarea'] });
    expect(o.maskInputFn('alice@example.com', el('<input type="email">') as HTMLElement)).toBe('alice@example.com');
    expect(o.maskInputFn('notes', el('<textarea></textarea>') as HTMLElement)).toBe('notes');
    for (const html of ['<input type="password">', '<input maxlength="1" inputmode="numeric">', '<input name="cardnumber">', '<input name="api_key">', '<input autocomplete="cc-exp">'])
      expect(o.maskInputFn('4242424242424242', el(html) as HTMLElement), html).toBe('****************');
    const strict = recordOptions({ maskAllInputs: true, maskSelectors: [], unmaskSelectors: ['input'] });
    expect(strict.maskInputFn('alice', el('<input type="text">') as HTMLElement)).toBe('*****');
    const none = recordOptions({ maskAllInputs: false, maskSelectors: [] });
    expect(none.maskInputFn('alice@example.com', el('<input type="email" name="email">') as HTMLElement)).toBe('*****************');
  });

  it('blocks hidden inputs and the storyboard block list; masks contenteditable and mask-text elements; strict masks all text', () => {
    const o = recordOptions({ maskAllInputs: false, maskSelectors: [], blockSelectors: ['.secret-panel', '##bad'], maskTextSelectors: ['#acct'] });
    expect(o.blockSelector).toContain('input[type="hidden" i]');
    expect(o.blockSelector).toContain('.secret-panel');
    expect(o.blockSelector).not.toContain('##bad'); // an invalid selector would break rrweb's matching: left out
    expect(el('<input type="hidden" name="csrf" value="x">').matches(o.blockSelector)).toBe(true);
    expect(o.maskTextSelector).toBe('*');
    document.body.innerHTML = '<div id="ce" contenteditable="true"><b>secret note</b></div><p id="acct">DE89 3704</p><p id="plain">Hello world</p><div contenteditable="false"><i>shown</i></div>';
    const $ = (s: string) => document.querySelector(s) as HTMLElement;
    expect(o.maskTextFn('secret note', $('#ce b'))).toBe('****** ****');
    expect(o.maskTextFn('DE89 3704', $('#acct'))).toBe('**** ****');
    expect(o.maskTextFn('Hello world', $('#plain'))).toBe('Hello world');
    expect(o.maskTextFn('shown', $('[contenteditable=false] i'))).toBe('shown');
    const strict = recordOptions({ maskAllInputs: true, maskSelectors: [] });
    expect(strict.maskTextFn('Hello world', $('#plain'))).toBe('***** *****');
  });

  it('masks what looks like a secret in page text', () => {
    expect(maskSecretsInText('Your authenticator key: JBSWY3DP-TOTP-SEED-TEXT')).toBe('Your authenticator key: ***********************');
    expect(maskSecretsInText('Scan otpauth://totp/App:ada?secret=JBSWY3DPEHPK3PXP now')).not.toContain('JBSWY3DPEHPK3PXP');
    expect(maskSecretsInText('Seed JBSWY3DPEHPK3PXP')).not.toContain('JBSWY3DPEHPK3PXP');
    expect(maskSecretsInText('JBSW Y3DP EHPK 3PXP')).not.toContain('EHPK');
    expect(maskSecretsInText('key sk_live_APIKEY_abc123 here')).not.toContain('sk_live_');
    expect(maskSecretsInText('t eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')).not.toContain('eyJ');
    expect(maskSecretsInText('Card 4242 4242 4242 4242 on file')).toBe('Card ******************* on file');
    expect(maskSecretsInText('Order 1234567890123 shipped')).toBe('Order 1234567890123 shipped'); // not a card (Luhn)
    expect(maskSecretsInText('Welcome back, hunter2-Sekr3t! is wrong', ['hunter2-Sekr3t!'])).toBe('Welcome back, *************** is wrong');
    expect(maskSecretsInText('Plain text about orders and invoices, 12 items.')).toBe('Plain text about orders and invoices, 12 items.');
  });

  it('redacts URLs: query values, fragments and token-like path segments; non-http(s) is dropped', () => {
    expect(redactUrl('http://127.0.0.1:48111/leak?reset_token=URLTOKEN-RESET-9f8e7d')).toBe('http://127.0.0.1:48111/leak?reset_token=*');
    expect(redactUrl('https://app.test/cb?code=abc&state=xyz&empty=#access_token=t0k&token_type=bearer')).toBe('https://app.test/cb?code=*&state=*&empty=#access_token=*&token_type=*');
    expect(redactUrl('https://app.test/#/reset/9f8e7d6c5b4a39281706f5e4d3c2b1a0?x=1')).toBe('https://app.test/#/reset/*?x=*');
    expect(redactUrl('https://app.test/reset/aB3dE5fG7hJ9kL1mN3pQ5rS7')).toBe('https://app.test/reset/*');
    expect(redactUrl('https://app.test/blog/my-long-post-title-from-2024')).toBe('https://app.test/blog/my-long-post-title-from-2024');
    expect(redactUrl('https://app.test/orders/42#details')).toBe('https://app.test/orders/42#details');
    expect(redactUrl('https://u:p@app.test/x')).toBe('https://app.test/x');
    expect(redactUrl('javascript:alert(1)')).toBe('');
    expect(redactUrl('http://x/✓')).toBe('http://x/%E2%9C%93');
  });

  it('builds the rrweb options: widget blocked, sampling, per-element mask, maskAllInputs', () => {
    const o = recordOptions({ maskAllInputs: false, maskSelectors: ['#code'], unmaskSelectors: ['input[type=email]'] });
    expect(o.blockSelector).toBe(RECORD_BLOCK_SELECTOR);
    expect(o.blockSelector).toContain('[data-stubyard-widget]');
    expect(o.sampling).toMatchObject({ mousemove: 50, scroll: 150, input: 'last' });
    expect(o.recordCanvas).toBe(false);
    expect(o.maskAllInputs).toBe(true); // rrweb sends every value through maskInputFn
    expect(o.maskInputOptions.text && o.maskInputOptions.email && o.maskInputOptions.password).toBe(true);
    expect(o.maskInputFn('alice@example.com', el('<input type="email">') as HTMLElement)).toBe('alice@example.com');
    expect(o.maskInputFn('s3cret', el('<input type="password">') as HTMLElement)).toBe('******');
    expect(o.maskInputFn('123456', el('<input id="code">') as HTMLElement)).toBe('******');
    const all = recordOptions({ maskAllInputs: true, maskSelectors: [] });
    expect(all.maskAllInputs).toBe(true);
    expect(all.maskInputFn('alice', el('<input type="text">') as HTMLElement)).toBe('*****');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The recorder

interface FakeRrweb extends RrwebRecord {
  starts: Record<string, unknown>[];
  stops: number;
  emit: ((e: unknown) => void) | null;
  custom: { tag: string; payload: unknown }[];
}
function fakeRrweb(): FakeRrweb {
  const f = ((opts: Record<string, unknown> & { emit: (e: unknown) => void }) => {
    f.starts.push(opts);
    f.emit = opts.emit;
    opts.emit({ type: 4, timestamp: 1, data: { href: 'x' } }); // Meta
    opts.emit({ type: 2, timestamp: 1, data: {} }); // FullSnapshot
    return () => {
      f.stops++;
      f.emit = null;
    };
  }) as FakeRrweb;
  f.starts = [];
  f.stops = 0;
  f.emit = null;
  f.custom = [];
  f.addCustomEvent = (tag, payload) => {
    f.custom.push({ tag, payload });
    f.emit?.({ type: 5, timestamp: 2, data: { tag, payload } });
  };
  return f;
}

const CFG: RecordingConfig = { project: 'p', walkthroughId: 'w1', stepId: 's1', paused: false, maskAllInputs: false, maskSelectors: [], unmaskSelectors: [], maskTextSelectors: [], blockSelectors: [] };
const okReply = (o: Partial<Extract<RecordingChunkReply, { ok: true }>['state']> = {}): RecordingChunkReply => ({
  ok: true,
  state: { mode: 'dom', paused: false, stopped: null, currentStepId: 's1', status: 'active', ...o },
});

let rr: FakeRrweb;
let chunks: RecordingChunkMessage[];
let reply: (m: RecordingChunkMessage) => RecordingChunkReply | undefined;
let rec: Recorder;
let keys: number;
let stops: string[];

const flushAsync = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.useRealTimers();
  rr = fakeRrweb();
  chunks = [];
  reply = () => okReply();
  keys = 0;
  stops = [];
  const deps: RecorderDeps = {
    record: rr,
    send: async (m) => {
      chunks.push(structuredClone(m));
      return reply(m);
    },
    win: window,
    newKey: () => `seg${++keys}`,
    onStop: (r) => stops.push(r),
  };
  rec = new Recorder(deps);
});

describe('recorder', () => {
  afterEach(() => rec.stop()); // its page listeners go with it
  it('starts one segment with a step marker, flushes every 5 s with heartbeats between, and sends a final chunk on stop', async () => {
    vi.useFakeTimers();
    const real = (c: RecordingChunkMessage) => c.events.length > 0 || c.final;
    expect(rec.apply(CFG)).toEqual({ recording: true });
    expect(rr.starts).toHaveLength(1);
    expect(rr.starts[0]).toMatchObject({ blockSelector: RECORD_BLOCK_SELECTOR });
    expect(rr.custom).toEqual([{ tag: STEP_EVENT_TAG, payload: { stepId: 's1' } }]);
    expect(chunks).toHaveLength(0);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(chunks).toEqual([expect.objectContaining({ seq: 0, events: [], final: false })]); // a heartbeat
    vi.advanceTimersByTime(HEARTBEAT_MS * 2); // 6 s: the chunk is due
    const sent = chunks.filter(real);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'recording.chunk', project: 'p', walkthroughId: 'w1', seq: 0, final: false, segment: { key: 'seg1', stepId: 's1', url: location.href } });
    expect(sent[0].events).toHaveLength(3); // meta, snapshot, step marker
    vi.advanceTimersByTime(FLUSH_MS * 2); // nothing new: heartbeats only
    expect(chunks.filter(real)).toHaveLength(1);
    expect(chunks.filter((c) => !real(c)).every((c) => c.events.length === 0 && !c.final)).toBe(true);
    rr.emit!({ type: 3, timestamp: 3, data: {} });
    vi.advanceTimersByTime(FLUSH_MS + HEARTBEAT_MS);
    expect(chunks.filter(real).map((c) => c.seq)).toEqual([0, 1]);
    rec.stop();
    expect(rr.stops).toBe(1);
    expect(chunks.at(-1)).toMatchObject({ seq: 2, final: true, events: [] });
    const n = chunks.length;
    vi.advanceTimersByTime(FLUSH_MS * 3);
    expect(chunks).toHaveLength(n); // the timer is gone
  });

  it('redacts the URL of the segment and of rrweb Meta events', () => {
    history.replaceState(null, '', '/leak?reset_token=URLTOKEN-RESET-9f8e7d#access_token=abc');
    rec.apply(CFG);
    rec.flush();
    history.replaceState(null, '', '/');
    expect(chunks[0].segment.url).toMatch(/\/leak\?reset_token=\*#access_token=\*$/);
    rr.emit!({ type: 4, timestamp: 4, data: { href: 'http://app.test/cb?code=SECRETCODE', width: 1, height: 1 } });
    rec.flush();
    expect(JSON.stringify(chunks)).not.toContain('SECRETCODE');
    expect(JSON.stringify(chunks)).not.toContain('URLTOKEN');
  });

  it('a page snapshot too large to upload becomes a note: the segment ends, the page is not recorded further', async () => {
    const big = fakeRrweb();
    const r = new Recorder({ record: Object.assign(((o: Record<string, unknown> & { emit: (e: unknown) => void }) => {
      o.emit({ type: 4, timestamp: 1, data: { href: 'http://app.test/big' } });
      o.emit({ type: 2, timestamp: 1, data: { node: { text: 'x'.repeat(MAX_EVENT_BYTES + 10) } } });
      return () => {};
    }) as RrwebRecord, { addCustomEvent: big.addCustomEvent }), send: async (m) => (chunks.push(structuredClone(m)), okReply()), win: window, newKey: () => 'bigseg', onStop: (s) => stops.push(s) });
    r.apply(CFG);
    await flushAsync();
    expect(r.active).toBe(false);
    const last = chunks.at(-1)!;
    expect(last).toMatchObject({ final: true, segment: { key: 'bigseg' } });
    const note = (last.events as { type: number; data: { tag?: string; payload?: { kind?: string; reason?: string } } }[]).find((e) => e.type === 5 && e.data.tag === NOTE_EVENT_TAG);
    expect(note?.data.payload).toMatchObject({ kind: 'too-large' });
    expect(note?.data.payload?.reason).toMatch(/not recorded/);
    expect(JSON.stringify(chunks).length).toBeLessThan(10_000); // the snapshot itself never left
    expect(stops.at(-1)).toMatch(/page snapshot/);
    r.stop();
  });

  it('a full segment (413 segmentFull) starts a new segment and goes on', async () => {
    reply = (m) => (m.seq === 0 && m.segment.key === 'seg1' && m.events.length ? { ok: false, error: 'full', stop: false, status: 413, segmentFull: true } : okReply());
    rec.apply(CFG);
    rec.flush();
    await flushAsync();
    expect(rec.active).toBe(true);
    expect(rec.segmentKey).toBe('seg2');
    expect(rr.starts).toHaveLength(2);
    expect(stops).toEqual([]);
  });

  it('the heartbeat reply carries a pause made on the hub: the recorder stops within one tick', async () => {
    vi.useFakeTimers();
    rec.apply(CFG);
    reply = () => okReply({ paused: true });
    vi.advanceTimersByTime(HEARTBEAT_MS);
    vi.useRealTimers();
    await flushAsync();
    expect(rec.active).toBe(false);
  });

  it('sends early once a chunk holds FLUSH_EVENTS events', () => {
    rec.apply(CFG);
    for (let i = 0; i < FLUSH_EVENTS; i++) rr.emit!({ type: 3, timestamp: i, data: {} });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].events).toHaveLength(FLUSH_EVENTS);
  });

  it('is idempotent and turns step changes into markers in the same segment', () => {
    rec.apply(CFG);
    rec.apply(CFG);
    expect(rr.starts).toHaveLength(1);
    rec.apply({ ...CFG, stepId: 's2' });
    expect(rr.starts).toHaveLength(1);
    expect(rr.custom.map((c) => c.payload)).toEqual([{ stepId: 's1' }, { stepId: 's2' }]);
  });

  it('pause ends the segment (final chunk); resume starts a new one', () => {
    rec.apply(CFG);
    rec.apply({ ...CFG, paused: true });
    expect(rec.active).toBe(false);
    expect(rr.stops).toBe(1);
    expect(chunks.at(-1)).toMatchObject({ final: true, segment: { key: 'seg1' } });
    rr.emit?.({ type: 3, timestamp: 9, data: {} }); // nothing records while paused
    rec.apply({ ...CFG, paused: false, stepId: 's3' });
    expect(rec.active).toBe(true);
    expect(rec.segmentKey).toBe('seg2');
    rec.flush();
    expect(chunks.at(-1)).toMatchObject({ seq: 0, segment: { key: 'seg2', stepId: 's3' } });
  });

  it('one segment per page load: pagehide sends the final chunk, a bfcache restore starts a new segment', () => {
    rec.apply(CFG);
    window.dispatchEvent(new Event('pagehide'));
    expect(rec.active).toBe(false);
    expect(chunks.at(-1)).toMatchObject({ final: true, segment: { key: 'seg1' } });
    const ev = new Event('pageshow') as Event & { persisted?: boolean };
    Object.defineProperty(ev, 'persisted', { value: true });
    window.dispatchEvent(ev);
    expect(rec.segmentKey).toBe('seg2');
    expect(rr.starts).toHaveLength(2);
  });

  it('flushes (not final) when the page is hidden', () => {
    rec.apply(CFG);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].final).toBe(false);
    expect(rec.active).toBe(true);
  });

  it('stops for good when the hub refuses (cap reached) and ignores later configs of that run', async () => {
    reply = () => ({ ok: false, error: 'Recording stopped: limit', stop: true, status: 413 });
    rec.apply(CFG);
    rec.flush();
    await flushAsync();
    expect(rec.active).toBe(false);
    expect(stops).toEqual(['Recording stopped: limit']);
    expect(rec.apply({ ...CFG, stepId: 's2' })).toEqual({ recording: false });
    expect(rr.starts).toHaveLength(1);
    // Another run records again.
    reply = () => okReply();
    expect(rec.apply({ ...CFG, walkthroughId: 'w2' })).toEqual({ recording: true });
  });

  it('keeps chunks that failed for a network reason and sends them again with the next flush', async () => {
    let fail = true;
    reply = () => (fail ? undefined : okReply());
    rec.apply(CFG);
    rec.flush();
    await flushAsync();
    fail = false;
    rr.emit!({ type: 3, timestamp: 5, data: {} });
    rec.flush();
    await flushAsync();
    expect(chunks.map((c) => c.seq)).toEqual([0, 0, 1]);
  });

  it('follows the hub state from a chunk reply: a pause made elsewhere, a step change', async () => {
    reply = () => okReply({ currentStepId: 's9' });
    rec.apply(CFG);
    rec.flush();
    await flushAsync();
    expect(rec.config?.stepId).toBe('s9');
    expect(rr.custom.at(-1)?.payload).toEqual({ stepId: 's9' });
    reply = () => okReply({ currentStepId: 's9', paused: true });
    rr.emit!({ type: 3, timestamp: 5, data: {} });
    rec.flush();
    await flushAsync();
    expect(rec.active).toBe(false);
    reply = () => okReply({ mode: 'off' });
    rec.apply({ ...CFG, stepId: 's9' });
    rec.flush();
    await flushAsync();
    expect(rec.active).toBe(false);
    expect(stops.at(-1)).toBe('recording is off');
  });

  it('a changed mask config starts a fresh segment with the new options', () => {
    rec.apply(CFG);
    rec.apply({ ...CFG, maskAllInputs: true });
    expect(rr.starts).toHaveLength(2);
    expect(rr.starts[1]).toMatchObject({ maskAllInputs: true });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The content requests

describe('content requests', () => {
  it('recording.start / recording.stop drive the page recorder; setValue secret marks the field', async () => {
    const { installContent, handleRequest, pageRecorder, pageTracker } = await import('../src/content/index');
    const rrc = fakeRrweb();
    const sent: unknown[] = [];
    const runtime = {
      onMessage: { addListener: () => {}, removeListener: () => {} },
      sendMessage: async (m: unknown) => {
        sent.push(m);
        return okReply();
      },
      getURL: (p: string) => `chrome-extension://x/${p}`,
      id: 'x',
    };
    const inst = installContent(window, runtime as never, `test-${Math.random()}`, undefined, undefined, { record: rrc });
    expect(inst).not.toBeNull();
    const r1 = await handleRequest({ type: 'recording.start', config: CFG } as ContentRequest);
    expect(r1).toMatchObject({ ok: true, recording: true });
    expect(rrc.starts).toHaveLength(1);
    document.body.innerHTML = '<input id="pw2" type="text">';
    await handleRequest({ type: 'setValue', selector: '#pw2', value: 'hunter2', secret: true } as ContentRequest);
    expect(pageTracker()!.isMarked(document.getElementById('pw2')!)).toBe(true);
    expect(pageTracker()!.isSecretValue('hunter2')).toBe(true);
    expect(pageRecorder()).not.toBeNull();
    // A fill carries no secret flag: an entry whose field is sensitive is remembered as a secret too.
    document.body.innerHTML = '<form><input id="em" name="email"><input id="pwf" name="password" type="password"></form>';
    await handleRequest({ type: 'fill', entries: [{ key: 'email', selector: '#em', value: 'a@b.test', kind: 'auto' }, { key: 'password', selector: '#pwf', value: 'Fill-Secret-1', kind: 'auto' }] } as ContentRequest);
    expect(pageTracker()!.isSecretValue('Fill-Secret-1')).toBe(true);
    expect(pageTracker()!.isSecretValue('a@b.test')).toBe(false);
    const r2 = await handleRequest({ type: 'recording.stop' } as ContentRequest);
    expect(r2).toMatchObject({ ok: true, recording: false });
    await flushAsync();
    expect(sent.some((m) => (m as { type?: string }).type === 'recording.chunk')).toBe(true);
    inst!.dispose();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The service worker

const APP = 'http://localhost:3183';
const view = (o: Partial<WalkthroughView> & { rec?: Partial<NonNullable<WalkthroughView['recording']>> } = {}): WalkthroughView =>
  ({
    id: 'w1',
    status: 'active',
    currentStepId: 's1',
    ...o,
    recording: { mode: 'dom', requested: 'dom', maskAllInputs: false, paused: false, stopped: null, stoppedAt: null, maskSelectors: ['#totp'], segmentCount: 0, bytes: 0, maxBytes: 1, ...o.rec },
  }) as unknown as WalkthroughView;

describe('service worker', () => {
  let settings: Settings;
  let versions: Record<number, string | null>;
  let sent: { tabId: number; msg: ContentRequest }[];
  let injected: number[];
  let reads: number;
  let w: WalkthroughView;
  let deps: RecordingDeps;
  let uploads: unknown[];
  let uploadErr: (Error & { status?: number }) | null;

  beforeEach(() => {
    settings = { ...defaultSettings(), apiUrl: 'http://hub:4000', activeWalkthroughByWindow: { '1': { project: 'p', id: 'w1', origins: [APP] } } };
    versions = {};
    sent = [];
    injected = [];
    reads = 0;
    uploads = [];
    uploadErr = null;
    w = view();
    deps = {
      loadSettings: async () => structuredClone(settings),
      ping: async (id) => versions[id] ?? null,
      inject: async (id) => {
        injected.push(id);
        versions[id] = CONTENT_VERSION;
      },
      send: async (tabId, msg) => void sent.push({ tabId, msg }),
      getWalkthrough: async () => {
        reads++;
        return w;
      },
      upload: async (apiUrl, project, id, chunk) => {
        if (uploadErr) throw uploadErr;
        uploads.push({ apiUrl, project, id, chunk });
        return { state: { mode: 'dom', paused: false, stopped: null, currentStepId: 's1', status: 'active' } };
      },
    };
  });

  it('config: only active runs that record (dom, not stopped)', () => {
    const a = { project: 'p', id: 'w1' };
    expect(recordingConfig(a, view())).toEqual({ project: 'p', walkthroughId: 'w1', stepId: 's1', paused: false, maskAllInputs: false, maskSelectors: ['#totp'], unmaskSelectors: [], maskTextSelectors: [], blockSelectors: [] });
    expect(recordingConfig(a, view({ rec: { unmaskSelectors: ['#q'], maskTextSelectors: ['#k'], blockSelectors: ['.b'] } }))).toMatchObject({ unmaskSelectors: ['#q'], maskTextSelectors: ['#k'], blockSelectors: ['.b'] });
    // Strict masking: the unmask list does not apply.
    expect(recordingConfig(a, view({ rec: { maskAllInputs: true, unmaskSelectors: ['#q'] } }))).toMatchObject({ unmaskSelectors: [] });
    expect(recordingConfig(a, view({ rec: { mode: 'off' } }))).toBeNull();
    expect(recordingConfig(a, view({ rec: { stopped: 'cap' } }))).toBeNull();
    expect(recordingConfig(a, view({ status: 'passed' as never }))).toBeNull();
    expect(recordingConfig(a, null)).toBeNull();
  });

  it('starts the recorder on app-origin tabs of the run window (injecting), stops it elsewhere, one hub read per pass', async () => {
    versions[3] = CONTENT_VERSION;
    versions[4] = CONTENT_VERSION;
    const r = await syncRecordingTabs(
      [
        { id: 2, windowId: 1, url: `${APP}/a` },
        { id: 3, windowId: 1, url: 'https://other.example/' },
        { id: 4, windowId: 9, url: `${APP}/b` },
        { id: 5, windowId: 9, url: `${APP}/c` },
      ],
      deps,
    );
    expect(r).toEqual(['recording', 'stopped', 'stopped', 'none']);
    expect(injected).toEqual([2]);
    expect(reads).toBe(1);
    expect(sent.find((s) => s.tabId === 2)?.msg).toMatchObject({ type: 'recording.start', config: { walkthroughId: 'w1', maskSelectors: ['#totp'] } });
    expect(sent.filter((s) => s.msg.type === 'recording.stop').map((s) => s.tabId)).toEqual([3, 4]);
  });

  it('stops when the run no longer records, and needs the run origins', async () => {
    versions[2] = CONTENT_VERSION;
    w = view({ rec: { mode: 'off' } });
    expect(await syncRecordingTab({ id: 2, windowId: 1, url: `${APP}/a` }, deps)).toBe('stopped');
    w = view();
    settings.activeWalkthroughByWindow['1'] = { project: 'p', id: 'w1' }; // an older panel: no origins
    expect(await syncRecordingTab({ id: 2, windowId: 1, url: `${APP}/a` }, deps)).toBe('stopped');
  });

  it('relays chunks only from the top frame of a run app page, with the settings hub URL', async () => {
    const msg: RecordingChunkMessage = { type: 'recording.chunk', project: 'p', walkthroughId: 'w1', segment: { key: 'k1', url: `${APP}/a`, startedAt: 'x', stepId: 's1' }, seq: 0, events: [{ type: 4, timestamp: 1 }], final: false };
    const top = { id: 'ext', tab: { id: 2, windowId: 1, url: `${APP}/a` }, frameId: 0, url: `${APP}/a` };
    expect(await handleRecordingChunk(msg, top, deps)).toMatchObject({ ok: true, state: { mode: 'dom' } });
    expect(uploads).toEqual([{ apiUrl: 'http://hub:4000', project: 'p', id: 'w1', chunk: { segment: msg.segment, seq: 0, events: msg.events, final: false } }]);
    expect(await handleRecordingChunk(msg, { ...top, frameId: 3 }, deps)).toMatchObject({ ok: false, stop: true });
    expect(await handleRecordingChunk(msg, { ...top, url: 'https://evil.example/' }, deps)).toMatchObject({ ok: false, stop: true });
    expect(await handleRecordingChunk({ ...msg, walkthroughId: 'w2' }, top, deps)).toMatchObject({ ok: false, stop: true });
    expect(await handleRecordingChunk(msg, { ...top, tab: { ...top.tab, windowId: 9 } }, deps)).toMatchObject({ ok: false, stop: true });
    expect(uploads).toHaveLength(1);
    uploadErr = Object.assign(new Error('Recording stopped: limit'), { status: 413 });
    expect(await handleRecordingChunk(msg, top, deps)).toEqual({ ok: false, error: 'Recording stopped: limit', stop: true, status: 413 });
    uploadErr = Object.assign(new Error('full'), { status: 413, details: { segmentFull: true } });
    expect(await handleRecordingChunk(msg, top, deps)).toMatchObject({ ok: false, stop: false, segmentFull: true });
    uploadErr = Object.assign(new Error('too large'), { status: 413, details: { chunkTooLarge: true } });
    expect(await handleRecordingChunk(msg, top, deps)).toMatchObject({ ok: false, stop: false, tooLarge: true });
    uploadErr = Object.assign(new Error('ended'), { status: 409 });
    expect(await handleRecordingChunk(msg, top, deps)).toMatchObject({ ok: false, stop: true, status: 409 });
    uploadErr = new Error('fetch failed');
    expect(await handleRecordingChunk(msg, top, deps)).toMatchObject({ ok: false, stop: false });
  });
});

describe('views', () => {
  it('recording UI state and the Start screen choice', () => {
    expect(recordingUiState(view())).toBe('on');
    expect(recordingUiState(view({ rec: { paused: true } }))).toBe('paused');
    expect(recordingUiState(view({ rec: { stopped: 'cap' } }))).toBe('stopped');
    expect(recordingUiState(view({ rec: { mode: 'off' } }))).toBe('off');
    expect(recordingUiState(view({ status: 'passed' as never }))).toBe('off');
    expect(defaultRecording('dom', 'tracked')).toBe('dom');
    expect(defaultRecording('video', 'tracked')).toBe('video');
    expect(defaultRecording('dom', 'quick')).toBe('off');
    const base = { storyboard: 's', origin: '', label: '', vars: {}, actors: {}, mode: 'tracked' as const };
    expect(startBody(base)).not.toHaveProperty('record');
    expect(startBody({ ...base, record: 'default' })).not.toHaveProperty('record');
    expect(startBody({ ...base, record: 'off' })).toMatchObject({ record: 'off' });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The page's sensitive-field memory (finding 2: show-password toggles and swapped inputs)

describe('sensitive tracker', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  let tr: SensitiveTracker;
  afterEach(() => tr?.stop());

  it('a password input stays sensitive after a show-password toggle', async () => {
    document.body.innerHTML = '<form id="login"><input id="pw" type="password" name="password"></form>';
    tr = new SensitiveTracker(document);
    tr.start();
    const pw = document.getElementById('pw') as HTMLInputElement;
    pw.type = 'text';
    await tick();
    expect(tr.isMarked(pw)).toBe(true);
    expect(isSensitiveInput(pw, [], tr)).toBe(true);
  });

  it('an input that replaces a password input (same id, name or place) is sensitive', async () => {
    document.body.innerHTML = '<form id="f"><input id="user" name="user"><span id="w"><input id="pw2" type="password" name="pw2"></span></form>';
    tr = new SensitiveTracker(document);
    tr.start();
    const old = document.getElementById('pw2') as HTMLInputElement;
    const n = document.createElement('input');
    n.id = 'pw2';
    n.type = 'text';
    n.value = 'swapPw-7Qz';
    old.replaceWith(n);
    await tick();
    expect(tr.isMarked(n)).toBe(true);
    // Same place, other id and name: still the password's place in the form.
    const m = document.createElement('input');
    m.id = 'other';
    n.replaceWith(m);
    await tick();
    expect(tr.isMarked(m)).toBe(true);
    // A plain field elsewhere is not.
    expect(tr.isMarked(document.getElementById('user')!)).toBe(false);
  });

  it('a field shown in clear before a new segment (paused, then resumed) is still known: rrweb masks it', async () => {
    document.body.innerHTML = '<input id="pw4" type="password" name="pw4">';
    tr = new SensitiveTracker(document);
    tr.start();
    const pw4 = document.getElementById('pw4') as HTMLInputElement;
    pw4.value = 'paused-show-pw-22';
    pw4.setAttribute('type', 'text');
    await tick();
    const o = recordOptions({ maskAllInputs: false, maskSelectors: [], unmaskSelectors: ['input'] }, tr);
    expect(o.maskInputFn(pw4.value, pw4)).toBe('*****************');
  });

  it('remembers values typed as secrets (at least 4 characters)', () => {
    tr = new SensitiveTracker(document);
    tr.rememberValue('abc');
    tr.mark(el('<input id="a">'), 'Typed-Secret-9');
    expect(tr.isSecretValue('abc')).toBe(false);
    expect(tr.isSecretValue('Typed-Secret-9')).toBe(true);
    expect(tr.secretValues()).toEqual(['Typed-Secret-9']);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Video mode: dots on sensitive fields while the tab is recorded as video (typing by hand included)

describe('video mode dots', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const widget = { isCollapsed: () => null, toggle: () => ({ ok: true as const, mounted: true, collapsed: true }) };
  // happy-dom drops -webkit-text-security from el.style: the attribute set next to the style is checked.
  const dotted = (e: Element) => e.hasAttribute('data-stubyard-video-dots');

  it('covers passwords (also when shown), split code boxes, card, key and mask-selector fields, not plain ones', async () => {
    const { setVideoMode, setVideoTracker, resetVideoMode } = await import('../src/content/videoMode');
    document.body.innerHTML = '<input id="pw" type="password"><input class="d" maxlength="1" inputmode="numeric"><input id="card" name="cardnumber"><input id="key" name="api_key"><input id="acct" name="acct"><input id="note" name="note">';
    const tr = new SensitiveTracker(document);
    tr.start();
    setVideoTracker(tr);
    const r = setVideoMode(true, widget, { maskSelectors: ['#acct'] });
    expect(r.on).toBe(true);
    const $ = (s: string) => document.querySelector(s)!;
    for (const s of ['#pw', '.d', '#card', '#key', '#acct']) expect(dotted($(s)), s).toBe(true);
    expect(dotted($('#note'))).toBe(false);
    // A show-password toggle while video runs: the field keeps its dots.
    ($('#pw') as HTMLInputElement).type = 'text';
    await tick();
    expect(dotted($('#pw'))).toBe(true);
    // A sensitive field added later, and one focused by hand.
    const added = document.createElement('input');
    added.name = 'otp_code';
    document.body.append(added);
    await tick();
    expect(dotted(added)).toBe(true);
    setVideoMode(false, widget);
    expect(dotted($('#card'))).toBe(false);
    resetVideoMode();
    setVideoTracker(null);
    tr.stop();
  });
});
