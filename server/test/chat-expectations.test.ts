import { describe, expect, it } from 'vitest';
import { evaluateExpectations, normalizeExpectations, parseRegex, toolMatches } from '../src/chat/expectations.js';
import { clip, resultText, toolName } from '../src/chat/tools.js';
import { scrub } from '../src/chat/keys.js';

const run = (over: Partial<Parameters<typeof evaluateExpectations>[1]> = {}) => ({
  text: 'The SUM is 5.',
  toolCalls: [{ name: 'calc__add' }, { name: 'devhub__list_test_users' }],
  steps: 2,
  usage: { inputTokens: 40, outputTokens: 10 },
  finishReason: 'stop',
  durationMs: 12,
  ...over,
});

describe('chat expectations', () => {
  it('normalises and validates', () => {
    expect(normalizeExpectations({ contains: 'x', notContains: [], matches: '', maxSteps: '3', finishReason: 'stop' })).toEqual({ contains: ['x'], maxSteps: 3, finishReason: 'stop' });
    expect(normalizeExpectations(undefined)).toEqual({});
    expect(() => normalizeExpectations([])).toThrow(/object/);
    expect(() => normalizeExpectations({ matches: '([' })).toThrow(/regular expression/);
    expect(() => normalizeExpectations({ maxSteps: -1 })).toThrow(/positive/);
    expect(() => normalizeExpectations({ toolCalled: 5 })).toThrow(/list/);
  });

  it('text checks are case-insensitive; regex supports /re/flags', () => {
    expect(evaluateExpectations({ contains: ['sum is'], notContains: ['sorry'] }, run()).passed).toBe(true);
    expect(evaluateExpectations({ contains: ['product'] }, run()).checks[0]).toMatchObject({ id: 'contains:product', ok: false });
    expect(evaluateExpectations({ notContains: ['SUM'] }, run()).passed).toBe(false);
    expect(evaluateExpectations({ matches: 'sum is \\d' }, run()).passed).toBe(true);
    expect(evaluateExpectations({ matches: '/sum is \\d/' }, run()).passed).toBe(false);
    expect(parseRegex('/a+/gi').flags).toBe('i');
  });

  it('tool checks match the full name or the part after "__"', () => {
    expect(toolMatches('calc__add', 'add')).toBe(true);
    expect(toolMatches('calc__add', 'calc__add')).toBe(true);
    expect(toolMatches('calc__add', 'ad')).toBe(false);
    const r = evaluateExpectations({ toolCalled: ['add', 'list_test_users'], toolNotCalled: ['boom'] }, run());
    expect(r.passed).toBe(true);
    const r2 = evaluateExpectations({ toolCalled: ['boom'], toolNotCalled: ['add'] }, run());
    expect(r2.checks.map((c) => c.ok)).toEqual([false, false]);
    expect(r2.checks[0].detail).toContain('called: calc__add, devhub__list_test_users');
  });

  it('limits and finish reason; an error never passes', () => {
    expect(evaluateExpectations({ maxSteps: 2, maxTokens: 50, finishReason: 'stop' }, run()).passed).toBe(true);
    const r = evaluateExpectations({ maxSteps: 1, maxTokens: 49, finishReason: 'length' }, run());
    expect(r.checks.map((c) => [c.id, c.ok])).toEqual([
      ['maxSteps', false],
      ['maxTokens', false],
      ['finishReason', false],
    ]);
    expect(evaluateExpectations({}, run()).passed).toBe(true);
    expect(evaluateExpectations({}, run({ error: 'HTTP 401' })).passed).toBe(false);
  });
});

describe('chat tool helpers', () => {
  it('tool names are sanitised, ≤ 64 chars and unique', () => {
    const taken = new Set<string>();
    expect(toolName('My Server!', 'get weather', taken)).toBe('my_server__get_weather');
    expect(toolName('My Server!', 'get-weather?', taken)).toBe('my_server__get-weather');
    expect(toolName('my server', 'get weather', taken)).toBe('my_server__get_weather_2');
    const long = toolName('x'.repeat(40), 'y'.repeat(80), taken);
    expect(long.length).toBe(64);
    const long2 = toolName('x'.repeat(40), 'y'.repeat(80), taken);
    expect(long2.length).toBe(64);
    expect(long2.endsWith('_2')).toBe(true);
    expect([...taken].every((n) => /^[A-Za-z0-9_-]{1,64}$/.test(n))).toBe(true);
  });

  it('result text: text blocks joined, other blocks summarised, structuredContent fallback, clipping', () => {
    expect(resultText({ content: [{ type: 'text', text: 'a' }, { type: 'image', mimeType: 'image/png', data: 'x' }, { type: 'text', text: 'b' }] })).toBe('a\n[image image/png]\nb');
    expect(resultText({ content: [], structuredContent: { n: 1 } })).toBe('{"n":1}');
    const big = clip('z'.repeat(20_000));
    expect(big.length).toBeLessThan(16_500);
    expect(big).toContain('clipped: 20000 characters');
  });

  it('scrub removes keys and auth header values', () => {
    const t = scrub('key sk-abc12345 failed; Authorization: Bearer sk-other999 x-api-key: k-123 url?key=AIzaXYZ&x=1', ['sk-abc12345']);
    expect(t).not.toContain('sk-abc12345');
    expect(t).not.toContain('sk-other999');
    expect(t).not.toContain('k-123');
    expect(t).not.toContain('AIzaXYZ');
  });
});
