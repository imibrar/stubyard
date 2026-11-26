import type { RunVerdict, VerdictItem } from './verdict.js';

/**
 * A run verdict as JUnit XML (A2), for CI test reporters: one <testsuite> per run, one <testcase> per verdict item.
 * fail → <failure> with the evidence lines, pending → <skipped>, warn → passes with a <system-out> note.
 */

/** Characters XML 1.0 does not allow: control characters other than tab / LF / CR, U+FFFE / U+FFFF and lone surrogates. */
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Text or attribute value: invalid characters dropped, & < > " ' escaped. */
export function xmlEscape(v: unknown): string {
  return String(v ?? '')
    .replace(INVALID_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** classname / suite name segments: no dots or spaces inside a segment. */
const seg = (v: string) => v.replace(/[^A-Za-z0-9_-]+/g, '_') || '_';

function seconds(from: string, to: string | null | undefined): string {
  const ms = Date.parse(to ?? '') - Date.parse(from);
  return Number.isFinite(ms) && ms > 0 ? (ms / 1000).toFixed(3) : '0';
}

function evidenceLines(i: VerdictItem): string {
  const lines = [i.message, ...i.evidence.map((e) => `- ${e.summary} (${e.url})`)];
  if (i.more) lines.push(`… and ${i.more} more`);
  return lines.join('\n');
}

function testcase(i: VerdictItem, classPrefix: string): string {
  const attrs = `name="${xmlEscape(i.name)}" classname="${xmlEscape(`${classPrefix}.${seg(i.source === 'default' ? 'default' : i.kind)}`)}" time="0"`;
  switch (i.status) {
    case 'fail':
      return `    <testcase ${attrs}>\n      <failure type="expectation" message="${xmlEscape(i.message)}">${xmlEscape(evidenceLines(i))}</failure>\n    </testcase>`;
    case 'pending':
      return `    <testcase ${attrs}>\n      <skipped message="${xmlEscape(i.message)}"/>\n    </testcase>`;
    case 'warn':
      return `    <testcase ${attrs}>\n      <system-out>${xmlEscape(`warning: ${evidenceLines(i)}`)}</system-out>\n    </testcase>`;
    default:
      return `    <testcase ${attrs}/>`;
  }
}

export function renderVerdictJunit(v: RunVerdict, opts: { project: string }): string {
  const { run } = v;
  const tests = v.items.length;
  const failures = v.counts.fail;
  const skipped = v.counts.pending;
  const time = seconds(run.startedAt, run.stoppedAt ?? v.evaluatedAt);
  const name = `stubyard run ${run.key} (${opts.project})`;
  const props: [string, string][] = [
    ['run.id', run.id],
    ['run.key', run.key],
    ['run.status', run.status],
    ['run.startedAt', run.startedAt],
    ['run.stoppedAt', run.stoppedAt ?? ''],
    ['verdict', v.verdict],
    ['verdict.summary', v.summary],
    ['verdict.frozen', String(v.frozen)],
    ['verdict.evaluatedAt', v.evaluatedAt],
  ];
  const head = `tests="${tests}" failures="${failures}" errors="0" skipped="${skipped}" time="${time}"`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${xmlEscape(name)}" ${head}>`,
    `  <testsuite name="${xmlEscape(name)}" ${head} timestamp="${xmlEscape(run.startedAt)}">`,
    '    <properties>',
    ...props.map(([k, val]) => `      <property name="${xmlEscape(k)}" value="${xmlEscape(val)}"/>`),
    '    </properties>',
    ...v.items.map((i) => testcase(i, `stubyard.${seg(opts.project)}.${seg(run.key)}`)),
    ...(v.notes.length ? [`    <system-out>${xmlEscape(v.notes.join('\n'))}</system-out>`] : []),
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n');
}
