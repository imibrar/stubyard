import { describe, expect, it } from 'vitest';
import type { RunReport } from '../src/runs/report.js';
import { renderRunReportHtml } from '../src/runs/report-html.js';
import type { RunVerdict } from '../src/runs/verdict.js';

const ctx = { project: { slug: 'p', name: 'P' }, version: '1.0', generatedAt: '2026-01-01T00:02:00.000Z' };

const base = (): RunReport => ({
  run: { id: 'r1', key: 'k1', label: '', status: 'stopped', startedAt: '2026-01-01T00:00:00.000Z', stoppedAt: '2026-01-01T00:01:00.000Z', durationMs: 60_000, meta: {} },
  users: [],
  messages: { total: 0, byChannel: {}, byStatus: {}, items: [] },
  lint: { messages: 0, error: 0, warn: 0, info: 0, byCheck: {}, items: [] },
  traffic: { total: 0, byOutcome: {}, problems: [] },
  rules: [],
  mocks: [],
  warnings: [],
});

const verdict: RunVerdict = {
  run: { id: 'r1', key: 'k1', status: 'stopped', startedAt: '2026-01-01T00:00:00.000Z', stoppedAt: '2026-01-01T00:01:00.000Z' },
  verdict: 'fail',
  summary: '1 of 3 checks failed: expected exactly 1 sms, got 0',
  counts: { pass: 1, fail: 1, warn: 0, pending: 1 },
  items: [
    { id: 'e1', name: '<script>alert(1)</script>', kind: 'message', source: 'declared', status: 'fail', expected: 'exactly 1', actual: 0, message: 'expected exactly 1 sms, got 0', evidence: [] },
    {
      id: 'default:providerCalls',
      name: 'No failed calls from the app to stubyard',
      kind: 'provider_call',
      source: 'default',
      status: 'pass',
      expected: '0',
      actual: 0,
      message: 'no failed calls',
      evidence: [{ type: 'log', id: 'log_1', summary: 'inbound POST /x → 200 (ok) <b>', url: '/api/logs/log_1' }],
      more: 2,
    },
    { id: 'e2', name: 'payment captured', kind: 'payment', source: 'declared', status: 'pending', expected: 'at least 1', actual: 0, message: 'waiting for a payment', evidence: [] },
  ],
  evaluatedAt: '2026-01-01T00:01:00.000Z',
  frozen: true,
  notes: ['Only the first 5000 messages of the run were checked & more'],
};

describe('run report HTML: verdict section', () => {
  it('renders the verdict with every value escaped', () => {
    const html = renderRunReportHtml({ ...base(), verdict }, ctx);
    expect(html).toContain('id="verdict"');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('checked &amp; more');
    // Status as text, not colour alone.
    expect(html).toContain('<span class="pill bad">FAIL</span>');
    expect(html).toMatch(/<span class="pill bad">fail<\/span>/);
    expect(html).toMatch(/<span class="pill ok">pass<\/span>/);
    expect(html).toMatch(/<span class="pill warn">pending<\/span>/);
    expect(html).toContain('payment captured');
    expect(html).toContain('log_1');
    expect(html).toContain('+2 more');
    // At the top: before the Run section.
    expect(html.indexOf('id="verdict"')).toBeLessThan(html.indexOf('id="run"'));
  });

  it('renders a report without a verdict (pre-A2) with no verdict section', () => {
    const html = renderRunReportHtml(base(), ctx);
    expect(html).not.toContain('id="verdict"');
    expect(html).toContain('id="run"');
  });
});
