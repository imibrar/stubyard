import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useProjectMaybe } from '../context';
import { providersPath } from './providerLayout';
import { Badge, ErrorBox } from './ui';

type Status = 'ok' | 'warn' | 'fail' | 'skip';

interface DoctorCheck {
  kind: string;
  label: string;
  url?: string;
  source?: string;
  status: Status;
  message: string;
  hint?: string;
  steps?: { step: string; status: Status; detail: string }[];
}

interface DoctorReport {
  ok: boolean;
  summary: Record<Status, number>;
  checks: DoctorCheck[];
  checkedAt: string;
}

const KIND: Record<Status, string> = { ok: 'ok', warn: 'warn', fail: 'bad', skip: '' };

/** "Check connection" on the Connect-your-app page: GET /api/projects/:slug/doctor. */
export function DoctorPanel({ slug }: { slug: string }) {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const project = useProjectMaybe();
  /** Checks of a provider's config URL ("provider <slug> (<preset>) config.<key>") link to that provider. */
  const providerLink = (source?: string) => {
    const inst = /^provider (\S+) \(/.exec(source ?? '')?.[1];
    const p = inst ? project?.overview.providers.find((x) => x.slug === inst) : undefined;
    return p ? providersPath(slug, p.channel, p.slug) : null;
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await api.get<DoctorReport>(`/api/projects/${slug}/doctor`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card card-pad stack" style={{ marginTop: 16 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div>
          <h2>Check the connection</h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            From inside stubyard, tries every URL it will call for this project (status callbacks, inbound URLs, event webhooks, webhook templates), plus
            Mailpit and the HTTPS names. Also available as <code>GET /api/projects/{slug}/doctor</code> and the MCP tool <code>doctor</code>.
          </p>
        </div>
        <button className="btn primary" onClick={() => void run()} disabled={busy}>
          {busy ? 'Checking…' : report ? 'Check again' : 'Run checks'}
        </button>
      </div>
      <ErrorBox error={error} />
      {report && (
        <>
          <div className="row" style={{ gap: 6 }}>
            <Badge kind={report.ok ? 'ok' : 'bad'}>{report.ok ? 'No blocking problems' : 'Problems found'}</Badge>
            {(['ok', 'warn', 'fail', 'skip'] as Status[]).map((s) => (report.summary[s] ? <Badge key={s} kind={KIND[s]}>{`${report.summary[s]} ${s}`}</Badge> : null))}
          </div>
          <table>
            <tbody>
              {report.checks.map((c, i) => (
                <tr key={i}>
                  <td style={{ width: 70, verticalAlign: 'top' }}>
                    <Badge kind={KIND[c.status]}>{c.status}</Badge>
                  </td>
                  <td>
                    <div>
                      <strong>{c.label}</strong>
                      {c.url && (
                        <>
                          {' '}
                          <code className="small">{c.url}</code>
                        </>
                      )}
                      {providerLink(c.source) && (
                        <>
                          {' '}
                          <Link to={providerLink(c.source)!} className="small">
                            Edit provider
                          </Link>
                        </>
                      )}
                    </div>
                    <div className="small">{c.message}</div>
                    {c.hint && <div className="small muted">{c.hint}</div>}
                    {c.steps && c.steps.length > 0 && (
                      <div className="small faint">{c.steps.map((s) => `${s.step}: ${s.status === 'ok' ? '✓' : s.status === 'skip' ? '–' : '✗'} ${s.detail}`).join(' · ')}</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
