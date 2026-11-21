/**
 * The @stubyard/client SSE parser (packages/client/src/stream.ts) and subscribe() over a fake fetch: split chunks
 * (also inside a CRLF and inside a multi-byte character), comments, multi-line data, retry, reconnect, abort.
 */
import { beforeAll, describe, expect, it } from 'vitest';

// Dynamic import: the helper lives in the packages/client workspace (outside this tsconfig's rootDir).
let c: any;
beforeAll(async () => {
  c = await import(new URL('../../packages/client/src/stream.ts', import.meta.url).pathname);
});

type Ev = { event: string; data: string; id: string };
function parse(chunks: string[]): { events: Ev[]; retries: number[] } {
  const events: Ev[] = [];
  const retries: number[] = [];
  const p = c.createSseParser((e: Ev) => events.push(e), (ms: number) => retries.push(ms));
  for (const ch of chunks) p.push(ch);
  p.end();
  return { events, retries };
}

/** Every way to cut the text into two chunks gives the same events. */
function everySplit(text: string): Ev[][] {
  const out: Ev[][] = [];
  for (let i = 0; i <= text.length; i++) out.push(parse([text.slice(0, i), text.slice(i)]).events);
  return out;
}

describe('createSseParser', () => {
  it('parses the hub stream: retry, ready, a JSON event, a ping comment', () => {
    const text = 'retry: 2000\n\nevent: ready\ndata: {}\n\n: ping\n\nevent: walkthrough.changed\ndata: {"projectId":"p1","data":{"id":"w1"}}\n\n';
    const { events, retries } = parse([text]);
    expect(retries).toEqual([2000]);
    expect(events).toEqual([
      { event: 'ready', data: '{}', id: '' },
      { event: 'walkthrough.changed', data: '{"projectId":"p1","data":{"id":"w1"}}', id: '' },
    ]);
    for (const evs of everySplit(text)) expect(evs).toEqual(events);
  });

  it('handles one character per chunk', () => {
    const text = 'event: a\ndata: x\n\n:c\nevent: b\ndata: y\n\n';
    expect(parse([...text]).events.map((e) => `${e.event}=${e.data}`)).toEqual(['a=x', 'b=y']);
  });

  it('joins multi-line data with \\n, strips only one leading space, keeps colons in the value', () => {
    const text = 'data: line 1\ndata:line 2\ndata:  two spaces\ndata: a: b\n\n';
    expect(parse([text]).events).toEqual([{ event: 'message', data: 'line 1\nline 2\n two spaces\na: b', id: '' }]);
  });

  it('accepts CRLF and CR line ends, also when \\r and \\n arrive in different chunks', () => {
    const crlf = 'event: a\r\ndata: 1\r\n\r\nevent: b\r\ndata: 2\r\n\r\n';
    expect(parse([crlf]).events.map((e) => e.data)).toEqual(['1', '2']);
    for (const evs of everySplit(crlf)) expect(evs.map((e) => e.data)).toEqual(['1', '2']);
    expect(parse(['data: 1\r', '\r', 'data: 2\r\r']).events.map((e) => e.data)).toEqual(['1', '2']);
    // The \n after a chunk-final \r is not a second (blank) line: "data: x" stays one event with the next data line.
    expect(parse(['data: x\r', '\ndata: y\r\n\r\n']).events.map((e) => e.data)).toEqual(['x\ny']);
  });

  it('ignores comments, unknown fields, events without data, and an unfinished event at the end', () => {
    const text = ': hello\nfoo: bar\nevent: empty\n\nevent: real\nid: 7\ndata\n\nevent: half\ndata: never';
    const { events } = parse([text]);
    expect(events).toEqual([{ event: 'real', data: '', id: '7' }]);
  });

  it('keeps the last id across events and ignores a non-numeric retry', () => {
    const { events, retries } = parse(['id: 1\ndata: a\n\ndata: b\n\nretry: soon\nretry: 50\n\n']);
    expect(events.map((e) => e.id)).toEqual(['1', '1']);
    expect(retries).toEqual([50]);
  });
});

/** A fetch whose responses stream the given chunks (as UTF-8 bytes, cut where the strings are cut). */
function fakeFetch(responses: (string[] | number)[], calls: string[]) {
  return async (url: string, init?: RequestInit) => {
    calls.push(url);
    const next = responses.shift();
    if (next === undefined) {
      // Hang until aborted, like an idle stream.
      return new Response(
        new ReadableStream({
          start(ctrl) {
            init?.signal?.addEventListener('abort', () => ctrl.error(new DOMException('aborted', 'AbortError')));
          },
        }),
        { status: 200 },
      );
    }
    if (typeof next === 'number') return new Response(JSON.stringify({ error: 'nope' }), { status: next });
    const enc = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(ctrl) {
          for (const ch of next) ctrl.enqueue(enc.encode(ch));
          ctrl.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  };
}

describe('subscribe (fake fetch)', () => {
  it('filters by type, unwraps {projectId, data}, survives a split multi-byte character, reconnects after errors and stops on abort', async () => {
    const calls: string[] = [];
    // "é" is two bytes in UTF-8: the third connection cuts between them.
    const enc = new TextEncoder();
    const evText = 'event: walkthrough.changed\ndata: {"projectId":"p1","data":{"label":"café"}}\n\n';
    const bytes = enc.encode(evText);
    const cut = bytes.indexOf(0xc3) + 1;
    const responses: (string[] | number)[] = [
      ['retry: 5\n\nevent: ready\ndata: {}\n\n', ': ping\n\nevent: message.created\ndata: {"projectId":"p1","data":{"id":"m1"}}\n\n'],
      503,
    ];
    const f0 = fakeFetch(responses, calls);
    // Wrap: the third connection streams raw bytes cut inside "é".
    let n = 0;
    const f = async (url: string, init?: RequestInit) => {
      n++;
      if (n === 3) {
        calls.push(url);
        return new Response(
          new ReadableStream({
            start(ctrl) {
              ctrl.enqueue(bytes.slice(0, cut));
              ctrl.enqueue(bytes.slice(cut));
              ctrl.close();
            },
          }),
          { status: 200 },
        );
      }
      return f0(url, init);
    };

    const events: any[] = [];
    const errors: unknown[] = [];
    const ac = new AbortController();
    c.subscribe(
      { apiUrl: 'http://hub.test/', project: 'demo', run: 'w1', fetch: f },
      { types: ['walkthrough.changed', 'message.created'], onEvent: (e: any) => events.push(e), onError: (e: unknown) => errors.push(e), signal: ac.signal },
    );
    const deadline = Date.now() + 3000;
    while (events.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    ac.abort();

    expect(calls[0]).toBe('http://hub.test/api/stream?project=demo&run=w1');
    expect(events).toEqual([
      { type: 'message.created', projectId: 'p1', data: { id: 'm1' } },
      { type: 'walkthrough.changed', projectId: 'p1', data: { label: 'café' } },
    ]);
    expect(errors.map(String).join('\n')).toContain('503');
    const before = calls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.length).toBe(before); // no reconnect after abort
  });
});
