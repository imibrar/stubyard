import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type LintFinding, type LintSeverity } from '../api';
import { useGate } from '../auth';
import { useProject } from '../context';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import { Badge, ErrorBox, useToast } from './ui';
import '../styles/lint.css';

/** Content checks ("message lint"): badges, finding lists, counters and the project settings card. */

export const LINT_KIND: Record<LintSeverity, string> = { error: 'bad', warn: 'warn', info: '' };
const LABEL: Record<LintSeverity, [string, string]> = { error: ['error', 'errors'], warn: ['warning', 'warnings'], info: ['note', 'notes'] };
const ORDER: LintSeverity[] = ['error', 'warn', 'info'];

export interface LintCounts {
  error: number;
  warn: number;
  info: number;
}

export function countFindings(findings: LintFinding[] | undefined): LintCounts {
  const c: LintCounts = { error: 0, warn: 0, info: 0 };
  for (const f of findings ?? []) c[f.severity]++;
  return c;
}

const label = (n: number, s: LintSeverity) => `${n} ${LABEL[s][n === 1 ? 0 : 1]}`;

/** "2 errors · 1 warning" as badges; info only when nothing worse (keeps message rows quiet). */
export function LintBadges({ findings, showInfo }: { findings: LintFinding[] | undefined; showInfo?: boolean }) {
  const c = countFindings(findings);
  const shown = ORDER.filter((s) => c[s] > 0 && (s !== 'info' || showInfo || (!c.error && !c.warn)));
  if (!shown.length) return null;
  const title = (findings ?? []).map((f) => `${f.severity}: ${f.message}${f.excerpt ? ` (${f.excerpt})` : ''}`).join('\n');
  return (
    <>
      {shown.map((s) => (
        <Badge key={s} kind={LINT_KIND[s]} title={title}>
          {label(c[s], s)}
        </Badge>
      ))}
    </>
  );
}

/** Findings of one message (message viewer). */
export function LintList({ findings }: { findings: LintFinding[] }) {
  return (
    <ul className="lint-list">
      {findings.map((f, i) => (
        <li key={i}>
          <Badge kind={LINT_KIND[f.severity]}>{f.severity}</Badge>
          <span className="lint-msg">
            {f.message}
            {f.excerpt && (
              <>
                {' '}
                <code className="lint-excerpt">{f.excerpt}</code>
              </>
            )}
            <span className="faint small"> · {f.check}{f.where ? ` · ${f.where}` : ''}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

interface CheckInfo {
  id: string;
  label: string;
  channels: string[];
  severity: LintSeverity;
  description: string;
  enabled: boolean;
}

interface LintSummary {
  checks: CheckInfo[];
  productionDomains: string[];
  totals: { messages: number; withFindings: number } & LintCounts;
  byCheck: ({ check: string; label: string; count: number } & LintCounts)[];
  byUser: ({ testUserId: string | null; name: string } & LintCounts)[];
}

function useLintSummary(slug: string, user?: string | null) {
  const path = `/api/projects/${slug}/lint?limit=0${user ? `&user=${encodeURIComponent(user)}` : ''}`;
  const s = useFetch<LintSummary>(path, [path]);
  const reload = useDebounced(() => void s.reload(), 400);
  useHubEvents(slug, (e) => {
    if (e.type === 'message.created' || e.type === 'project.reset' || e.type === 'project.updated') reload();
  });
  return s;
}

/** Per-user / per-project counter: "Content checks: 2 errors · 1 warning". Click filters (optional). */
export function LintCounter({ user, active, onToggle }: { user?: string | null; active?: boolean; onToggle?: () => void }) {
  const { slug } = useProject();
  const s = useLintSummary(slug, user);
  const t = s.data?.totals;
  if (!t || !t.withFindings) return null;
  const parts = ORDER.filter((k) => t[k] > 0);
  const body = (
    <>
      <span className="faint small">Content</span>
      {parts.map((k) => (
        <Badge key={k} kind={LINT_KIND[k]}>
          {label(t[k], k)}
        </Badge>
      ))}
    </>
  );
  if (!onToggle) return <span className="row nowrap lint-counter">{body}</span>;
  return (
    <button
      className={`btn xs ${active ? 'primary' : 'ghost'} lint-counter`}
      onClick={onToggle}
      aria-pressed={!!active}
      title={active ? 'Show all messages' : 'Show only messages with content warnings or errors'}
    >
      {body}
    </button>
  );
}

/** Settings card: counters, per-user table, enable / disable checks, production domains. */
export function ContentChecksCard() {
  const { slug } = useProject();
  const gate = useGate(slug)('project.settings');
  const toast = useToast();
  const s = useLintSummary(slug);
  const [domains, setDomains] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (s.data) setDomains(s.data.productionDomains.join(', '));
  }, [s.data?.productionDomains.join(',')]);
  const data = s.data;

  const save = async (patch: { lintDisabled?: string[]; productionDomains?: string[] }, msg: string) => {
    setError(null);
    try {
      await api.patch(`/api/projects/${slug}`, { settings: patch });
      toast(msg);
      void s.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const toggle = (c: CheckInfo) => {
    if (!data) return;
    const disabled = data.checks.filter((x) => (x.id === c.id ? x.enabled : !x.enabled)).map((x) => x.id);
    void save({ lintDisabled: disabled }, `${c.label}: ${c.enabled ? 'off' : 'on'}`);
  };
  const t = data?.totals;
  const users = (data?.byUser ?? []).slice(0, 8);

  return (
    <div className="card card-pad stack">
      <div className="row">
        <h2 className="grow">Content checks</h2>
        {t && (
          <span className="small faint">
            {t.withFindings} of {t.messages} messages with findings
          </span>
        )}
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        Every captured email, SMS and WhatsApp is checked for unrendered placeholders, leaked <code>undefined</code>, links to localhost or
        production, missing List-Unsubscribe on marketing mail, SMS encoding traps and more. Applies to new messages.
      </p>
      <ErrorBox error={error ?? s.error} />
      {t && t.withFindings > 0 && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {ORDER.filter((k) => t[k] > 0).map((k) => (
            <Badge key={k} kind={LINT_KIND[k]}>
              {label(t[k], k)}
            </Badge>
          ))}
          {data!.byCheck.slice(0, 6).map((c) => (
            <span key={c.check} className="small faint nowrap">
              {c.label} ×{c.count}
            </span>
          ))}
        </div>
      )}
      {users.length > 0 && (
        <div className="table-wrap">
          <table>
            <tbody>
              {users.map((u) => (
                <tr key={u.testUserId ?? 'none'}>
                  <td className="cell-fill ellipsis">
                    {u.testUserId ? <Link to={`/p/${slug}/users/${u.testUserId}`}>{u.name}</Link> : <Link to={`/p/${slug}/unassigned`}>Unassigned</Link>}
                  </td>
                  {ORDER.map((k) => (
                    <td key={k} className="nowrap">
                      {u[k] > 0 ? <Badge kind={LINT_KIND[k]}>{label(u[k], k)}</Badge> : null}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <label className="field">
        Production domains <span className="hint">Comma-separated. Links to them in captured messages are flagged.</span>
        <div className="row nowrap">
          <input className="grow" value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="myapp.com, api.myapp.com" />
          <button
            className="btn"
            {...gate}
            onClick={() =>
              void save(
                {
                  productionDomains: domains
                    .split(',')
                    .map((d) => d.trim().toLowerCase())
                    .filter(Boolean),
                },
                'Production domains saved',
              )
            }
          >
            Save
          </button>
        </div>
      </label>
      {data && (
        <details>
          <summary className="small">
            Checks ({data.checks.filter((c) => c.enabled).length} of {data.checks.length} on)
          </summary>
          <div className="lint-checks">
            {data.checks.map((c) => (
              <label key={c.id} className="lint-check" title={c.description}>
                <input type="checkbox" checked={c.enabled} onChange={() => toggle(c)} {...gate} />
                <span className="grow">
                  {c.label}
                  <span className="faint small"> · {c.channels.length === 3 ? 'all channels' : c.channels.join(', ')}</span>
                  <div className="faint small">{c.description}</div>
                </span>
                <Badge kind={LINT_KIND[c.severity]}>{c.severity}</Badge>
              </label>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
