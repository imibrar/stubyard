import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ContractLevel, ContractResult } from '../api';
import { contractsApi, issuesPath, specDetailPath, type ApiSpec, type ApiSpecDetail, type ContractCheckResult, type ContractSummary, type SpecOperation } from '../contractsApi';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import { projectPath } from '../nav';
import { CONTRACT_CHECK_LABEL, CONTRACT_LEVEL_KIND, CONTRACT_LEVEL_LABEL, ContractIssues } from './ContractIssues';
import { LogDrawer } from './TrafficLog';
import { Badge, Empty, ErrorBox, timeAgo } from './ui';

const LEVEL_RANK: Record<ContractLevel, number> = { error: 3, warn: 2, info: 1 };

/** A sample request for an operation: its path with {params} kept, plus a body placeholder for write methods. */
function sampleRequest(op: SpecOperation | undefined, prefix: string): string {
  if (!op) return '';
  const withBody = !['GET', 'HEAD', 'DELETE', 'OPTIONS'].includes(op.method);
  return JSON.stringify({ path: `${prefix}${op.path}`, query: {}, headers: {}, ...(withBody ? { body: {} } : {}) }, null, 2);
}

/** The check answer as one ContractResult so <ContractIssues/> renders it like a logged request. */
function toResult(spec: ApiSpec, r: ContractCheckResult): ContractResult {
  const sides = [r.request, r.response].filter((x) => !!x);
  const counts = { error: 0, warn: 0, info: 0 };
  for (const s of sides) for (const k of ['error', 'warn', 'info'] as const) counts[k] += s.counts[k];
  const level = sides.reduce<ContractLevel | null>((w, s) => (s.level && (!w || LEVEL_RANK[s.level] > LEVEL_RANK[w]) ? s.level : w), null);
  return {
    v: 1,
    subject: spec.role === 'app' ? 'app-response' : 'mock-request',
    source: 'spec',
    spec: { id: spec.id, name: spec.name, version: spec.apiVersion },
    provider: null,
    operation: r.operation,
    mode: spec.mode === 'strict' ? 'strict' : 'report',
    enforced: false,
    level,
    counts,
    issues: sides.flatMap((s) => s.issues),
    ...(sides.some((s) => s.truncated) ? { truncated: true } : {}),
  };
}

function parseJson(label: string, text: string): Record<string, unknown> | undefined {
  if (!text.trim()) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new Error(`${label} is not valid JSON: ${(e as Error).message}`);
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${label} must be a JSON object`);
  return v as Record<string, unknown>;
}

/** "Check a request": validate a sample request and/or response against one operation (nothing is logged). */
export function ContractCheck({ slug, specs }: { slug: string; specs: ApiSpec[] }) {
  const [specId, setSpecId] = useState(specs[0]?.id ?? '');
  const spec = specs.find((s) => s.id === specId) ?? specs[0];
  const detail = useFetch<ApiSpecDetail>(spec ? specDetailPath(slug, spec.id) : null, [spec?.id, spec?.updatedAt]);
  const ops = detail.data?.operationList ?? [];
  const [opKey, setOpKey] = useState('');
  const op = ops.find((o) => o.key === opKey);
  const [request, setRequest] = useState('');
  const [response, setResponse] = useState('');
  const [result, setResult] = useState<ContractResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pickOp = (key: string) => {
    setOpKey(key);
    setResult(null);
    const o = ops.find((x) => x.key === key);
    setRequest(sampleRequest(o, spec?.role === 'mock' ? (spec.prefix ?? '') : ''));
    setResponse(o ? JSON.stringify({ status: 200, headers: {}, body: {} }, null, 2) : '');
  };

  const check = async () => {
    if (!spec || !op) return;
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      const rq = parseJson('Request', request);
      const rs = parseJson('Response', response);
      if (!rq && !rs) throw new Error('Enter a request and/or a response to check');
      const r = await contractsApi.check(slug, { spec: spec.id, operation: op.key, request: rq, response: rs as { status: number } | undefined });
      setResult(toResult(spec, r));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="contract-check-title">
      <div className="card-head">
        <h3 id="contract-check-title">Check a request</h3>
        <span className="faint small">Validates a sample against the spec; nothing is logged</span>
      </div>
      <div className="card-pad form">
        <ErrorBox error={error ?? detail.error} />
        <div className="form form-2">
          <label className="field">
            Spec
            <select
              value={spec?.id ?? ''}
              onChange={(e) => {
                setSpecId(e.target.value);
                setOpKey('');
                setRequest('');
                setResponse('');
                setResult(null);
              }}
            >
              {specs.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Operation
            <select value={opKey} onChange={(e) => pickOp(e.target.value)} disabled={ops.length === 0}>
              <option value="">{detail.loading ? 'Loading…' : 'Choose an operation'}</option>
              {ops.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.key}
                  {o.operationId ? ` (${o.operationId})` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Request <span className="hint">{'{ path, query, headers, body } — empty to skip'}</span>
            <textarea className="mono" rows={8} value={request} onChange={(e) => setRequest(e.target.value)} spellCheck={false} disabled={!op} />
          </label>
          <label className="field">
            Response <span className="hint">{'{ status, headers, body } — empty to skip'}</span>
            <textarea className="mono" rows={8} value={response} onChange={(e) => setResponse(e.target.value)} spellCheck={false} disabled={!op} />
          </label>
        </div>
        <div className="row">
          <span className="spacer" />
          <button className="btn primary" onClick={() => void check()} disabled={busy || !op}>
            Check
          </button>
        </div>
        {result && (
          <div aria-live="polite">
            <ContractIssues result={result} />
          </div>
        )}
      </div>
    </section>
  );
}

/** The newest contract violations in this project's traffic (GET /contracts/issues). */
export function RecentContractIssues({ slug }: { slug: string }) {
  const summary = useFetch<ContractSummary>(issuesPath(slug, { limit: 20 }), [slug]);
  const reload = useDebounced(() => void summary.reload(), 1000);
  useHubEvents(slug, (e) => {
    if (e.type === 'log.created' || e.type === 'log.updated' || e.type === 'contracts.changed' || e.type === 'project.reset') reload();
  });
  const [logId, setLogId] = useState<string | null>(null);
  const s = summary.data;
  const list = s?.violations ?? [];
  return (
    <section className="card" aria-labelledby="contract-recent-title">
      <div className="card-head">
        <h3 id="contract-recent-title">Recent contract issues</h3>
        {s && (
          <span className="faint small">
            {s.withIssues} of {s.checked} checked request{s.checked === 1 ? '' : 's'} with issues
          </span>
        )}
        <span className="spacer" />
        <Link className="btn sm" to={`${projectPath(slug, 'traffic')}?contract=issues`}>
          Open in traffic
        </Link>
      </div>
      <ErrorBox error={summary.error} />
      {list.length === 0 && !summary.loading ? (
        <Empty title="No contract issues">
          <p className="muted small">Requests that break an imported spec, or a built-in provider contract, show up here.</p>
        </Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Level</th>
                <th scope="col">Request</th>
                <th scope="col">Contract</th>
                <th scope="col">First issue</th>
              </tr>
            </thead>
            <tbody>
              {list.map((v) => {
                const first = v.issues[0];
                return (
                  <tr key={v.logId} className="clickable" onClick={() => setLogId(v.logId)}>
                    <td className="small faint" title={v.receivedAt}>
                      {timeAgo(v.receivedAt)}
                    </td>
                    <td>
                      <Badge kind={CONTRACT_LEVEL_KIND[v.level]}>{CONTRACT_LEVEL_LABEL[v.level]}</Badge>
                    </td>
                    <td className="mono small ellipsis cell-fill">
                      <button className="btn xs ghost mono" onClick={() => setLogId(v.logId)} aria-label={`Open log ${v.method ?? ''} ${v.url ?? ''}`}>
                        <span className="method">{v.method}</span> {v.url}
                      </button>
                    </td>
                    <td className="small">
                      <span className="mono">{v.spec ?? v.provider}</span>
                      {v.operation && <div className="faint mono">{v.operation}</div>}
                    </td>
                    <td className="small">
                      {first ? (
                        <>
                          {CONTRACT_CHECK_LABEL[first.check] ?? first.check}
                          <div className="muted">{first.message}</div>
                          {v.issues.length > 1 && <div className="faint">+ {v.issues.length - 1} more</div>}
                        </>
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {logId && <LogDrawer id={logId} onClose={() => setLogId(null)} />}
    </section>
  );
}
