import { useState } from 'react';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import { ApiError } from '../api';
import { sbApi, sbPaths, STEP_KIND_LABEL, STEP_STATUS_KIND, VERDICT_KIND, WT_STATUS_KIND, type CleanupKept, type WalkthroughView } from '../storyboardsApi';
import { CleanupStatusBadge, WalkthroughCleanup } from './Cleanup';
import { Icon, Menu } from './people';
import { Badge, Drawer, ErrorBox, fmtBytes, fmtDateTime, Modal, useToast } from './ui';
import { Tabs } from './layout/Tabs';
import { RecordingTab } from './RecordingTab';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const dots = (v: string) => '•'.repeat(Math.min(v.length, 10));

function duration(from: string, to: string | null): string {
  const ms = (to ? new Date(to).getTime() : Date.now()) - new Date(from).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return `${Math.round(ms / 1000)}s`;
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** One walkthrough: actors, vars, step results with notes and screenshots, sign-off; links to the summary. */
export function WalkthroughDrawer({ slug, id, onClose, onChanged }: { slug: string; id: string; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const wt = useFetch<WalkthroughView>(`${sbPaths.walkthroughs(slug)}/${encodeURIComponent(id)}`, [slug, id]);
  const reload = useDebounced(() => void wt.reload(), 200);
  useHubEvents(slug, (e) => {
    if (e.type === 'walkthrough.changed' && (e.data as { id?: string } | null)?.id === id) reload();
  });
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [withUsers, setWithUsers] = useState(true);
  /** Users other runs still need (the server's 409 on DELETE ?users=1): shown with a "Delete anyway" choice. */
  const [inUse, setInUse] = useState<CleanupKept[] | null>(null);
  const [tab, setTab] = useState<'details' | 'recording'>('details');
  /** Secret vars (w.secretVars) show as dots until revealed, like passwords elsewhere in the dashboard. */
  const [showSecrets, setShowSecrets] = useState(false);
  const w = wt.data;
  const isSecret = (k: string) => !!w?.secretVars?.includes(k);
  const created = w ? Object.values(w.actors).filter((a) => a.created && !a.missing).length : 0;

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setError(null);
    try {
      await fn();
      toast(done);
      void wt.reload();
      onChanged();
    } catch (e) {
      setError(errText(e));
    }
  };
  const pending = w?.cleanupStatus === 'pending';
  const closeDelete = () => (setConfirmDelete(false), setInUse(null));
  const remove = async (force = false) => {
    setError(null);
    const users = withUsers && created > 0;
    try {
      // A run with test data to clean up needs users=1 or force=1 (the data then stays, no longer traceable to a run).
      const r = await sbApi.deleteWalkthrough(slug, id, { users, force: force || (pending && !users) });
      const kept = r.kept?.length ?? 0;
      toast(`Walkthrough deleted${r.users ? ` with ${r.users} user${r.users === 1 ? '' : 's'}` : ''}${kept ? `; ${kept} kept (Keep pin or used by another run)` : ''}`);
      onChanged();
      onClose();
    } catch (e) {
      const kept = e instanceof ApiError && e.status === 409 ? (e.details as { kept?: CleanupKept[] } | undefined)?.kept : undefined;
      if (kept?.length) return setInUse(kept);
      closeDelete();
      setError(errText(e));
    }
  };

  return (
    <Drawer
      title={
        w ? (
          <span className="row" style={{ gap: 6 }}>
            <strong className="ellipsis">{w.label || w.storyboard.name}</strong>
            <code className="faint small">{w.key}</code>
            <Badge kind={WT_STATUS_KIND[w.status]}>{w.status}</Badge>
            {w.signoff.verdict && <Badge kind={VERDICT_KIND[w.signoff.verdict]}>{w.signoff.verdict}</Badge>}
            {w.cleanupStatus && <CleanupStatusBadge status={w.cleanupStatus} />}
          </span>
        ) : (
          <strong>Walkthrough</strong>
        )
      }
      onClose={onClose}
      actions={
        w && (
          <>
            <a className="btn sm" href={sbPaths.summaryHtml(slug, w.id)} target="_blank" rel="noreferrer">
              Summary
            </a>
            <Menu label={<span aria-label="More actions">⋯</span>} className="btn sm ghost" floating>
              {(c) => (
                <>
                  <button onClick={() => (c(), window.open(sbPaths.summaryJson(slug, w.id), '_blank', 'noopener'))}>Summary as JSON</button>
                  {w.status === 'active' ? (
                    <button onClick={() => (c(), void act(() => sbApi.abandon(slug, w.id), 'Walkthrough abandoned'))}>Abandon</button>
                  ) : w.cleanupStatus === 'cleaned' ? null : (
                    <button onClick={() => (c(), void act(() => sbApi.reopen(slug, w.id), 'Walkthrough reopened'))}>Reopen</button>
                  )}
                  <button onClick={() => (c(), setConfirmDelete(true))}>Delete…</button>
                </>
              )}
            </Menu>
          </>
        )
      }
    >
      <ErrorBox error={error ?? wt.error} />
      {!w && !wt.error && <p className="muted">Loading…</p>}
      {w && (
        <Tabs
          variant="segmented"
          label="Walkthrough"
          value={tab}
          onChange={setTab}
          items={[
            { id: 'details', label: 'Details' },
            {
              id: 'recording',
              label: 'Recording',
              count: w.recording?.segmentCount ?? 0,
              extra: w.recording?.mode === 'dom' && w.status === 'active' && !w.recording.paused && !w.recording.stopped ? <span className="rec-live-tab" aria-label="recording now" /> : undefined,
            },
          ]}
        />
      )}
      {w && tab === 'recording' && <RecordingTab slug={slug} w={w} onChanged={() => (void wt.reload(), onChanged())} />}
      {w && tab === 'details' && (
        <>
          <dl className="sb-dl">
            <dt>Storyboard</dt>
            <dd>
              {w.storyboard.name} <span className="faint">v{w.storyboard.version}</span>
              {!w.storyboard.id && <span className="faint"> (deleted)</span>}
            </dd>
            <dt>Origin</dt>
            <dd>
              <code>{w.origin || '—'}</code>
            </dd>
            <dt>Started</dt>
            <dd>
              {fmtDateTime(w.startedAt)} <span className="faint">· {duration(w.startedAt, w.finishedAt)}</span>
            </dd>
            {w.finishedAt && (
              <>
                <dt>Finished</dt>
                <dd>{fmtDateTime(w.finishedAt)}</dd>
              </>
            )}
            <dt>Steps</dt>
            <dd className="row" style={{ gap: 4 }}>
              {(['done', 'failed', 'skipped', 'active', 'pending'] as const).map((k) =>
                w.counts[k] ? (
                  <Badge key={k} kind={STEP_STATUS_KIND[k]}>
                    {w.counts[k]} {k}
                  </Badge>
                ) : null,
              )}
            </dd>
          </dl>

          {w.warnings.length > 0 && (
            <ul className="sb-warn-list">
              {w.warnings.map((x) => (
                <li key={x}>⚠ {x}</li>
              ))}
            </ul>
          )}

          {(w.signoff.verdict || w.signoff.note) && (
            <section>
              <h3 className="section-title">Sign-off</h3>
              <div className="sb-signoff">
                {w.signoff.verdict && <Badge kind={VERDICT_KIND[w.signoff.verdict]}>{w.signoff.verdict}</Badge>}
                {w.signoff.signedOffBy && <span className="small">by {w.signoff.signedOffBy}</span>}
                {w.signoff.signedOffAt && <span className="faint small">{fmtDateTime(w.signoff.signedOffAt)}</span>}
                {w.signoff.note && <p className="sb-note">{w.signoff.note}</p>}
              </div>
            </section>
          )}

          <section>
            <h3 className="section-title">Actors</h3>
            <div className="sb-actors">
              {Object.entries(w.actors).map(([key, a]) => (
                <div key={key} className="sb-actor">
                  <div className="row" style={{ gap: 6 }}>
                    <code>{key}</code>
                    <strong className="ellipsis">{a.name}</strong>
                    <span className="faint small">{a.role}</span>
                    {a.created && <Badge kind="accent">fresh</Badge>}
                    {a.missing && <Badge kind="bad">deleted</Badge>}
                  </div>
                  <span className="small muted sb-wrap">{[a.email, a.phone].filter(Boolean).join(' · ')}</span>
                </div>
              ))}
            </div>
          </section>

          <WalkthroughCleanup id={w.id} onRemoved={() => (onChanged(), onClose())} onChanged={() => (void wt.reload(), onChanged())} />

          {Object.keys(w.vars).length > 0 && (
            <section>
              <h3 className="section-title">Vars</h3>
              <dl className="sb-dl">
                {Object.entries(w.vars).map(([k, v]) => {
                  const secret = isSecret(k);
                  return (
                    <div key={k} style={{ display: 'contents' }}>
                      <dt>
                        <code>{k}</code>
                      </dt>
                      <dd className="row" style={{ gap: 4 }}>
                        <code>{secret && !showSecrets ? dots(v) : v}</code>
                        {secret && (
                          <button className="btn xs ghost" onClick={() => setShowSecrets(!showSecrets)} title={showSecrets ? 'Hide' : 'Show'} aria-label={showSecrets ? 'Hide secret' : 'Show secret'}>
                            <Icon name={showSecrets ? 'eyeOff' : 'eye'} size={13} />
                          </button>
                        )}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </section>
          )}

          <section>
            <h3 className="section-title">Steps</h3>
            <ol className="sb-wt-steps">
              {w.steps.map((s, i) => (
                <li key={s.id} className={`sb-wt-step st-${s.status} ${w.currentStepId === s.id ? 'current' : ''}`}>
                  <div className="row sb-wt-step-head">
                    <span className="sb-step-pos">{i + 1}</span>
                    <span className={`sb-kind k-${s.kind}`}>{STEP_KIND_LABEL[s.kind] ?? s.kind}</span>
                    <strong className="grow sb-wrap">{s.title}</strong>
                    {s.optional && <Badge>optional</Badge>}
                    {s.data?.removed === true && <Badge kind="warn">removed</Badge>}
                    <Badge kind={STEP_STATUS_KIND[s.status]}>{s.status}</Badge>
                  </div>
                  {s.intent && <p className="small muted sb-wt-intent">{s.intent}</p>}
                  {s.note && <p className="sb-note">{s.note}</p>}
                  {s.data && Object.keys(s.data).filter((k) => k !== 'removed').length > 0 && (
                    <details className="sb-data">
                      <summary className="small">Result data</summary>
                      <pre className="sb-pre">{JSON.stringify(s.kind === 'capture' && s.var && isSecret(s.var) && !showSecrets && typeof s.data.value === 'string' ? { ...s.data, value: dots(s.data.value) } : s.data, null, 2)}</pre>
                    </details>
                  )}
                  {s.shots.length > 0 && (
                    <div className="sb-shots">
                      {s.shots.map((shot) => (
                        <a key={shot.id} href={sbPaths.shot(slug, w.id, shot.id)} target="_blank" rel="noreferrer" className="sb-shot" title={`${fmtBytes(shot.bytes)} · ${fmtDateTime(shot.createdAt)}`}>
                          <img src={sbPaths.shot(slug, w.id, shot.id)} alt={`Screenshot of step ${i + 1}`} loading="lazy" />
                        </a>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          </section>
        </>
      )}
      {confirmDelete && w && (
        <Modal
          title={inUse ? 'Other runs still use these users' : 'Delete this walkthrough?'}
          onClose={closeDelete}
          footer={
            <>
              <button className="btn" onClick={closeDelete}>
                Cancel
              </button>
              <button className="btn primary" style={{ background: 'var(--bad)', borderColor: 'var(--bad)' }} onClick={() => void remove(!!inUse)}>
                {inUse ? 'Delete anyway' : 'Delete'}
              </button>
            </>
          }
        >
          {inUse ? (
            <div className="stack">
              <ul className="cu-list small">
                {inUse.map((k) => (
                  <li key={k.userId}>
                    <code>{k.email ?? k.userId}</code> is still used by {(k.usedBy ?? []).map((r) => r.label || r.key).join(', ') || 'another run'}
                    {k.reason === 'used-by-active' && <span className="faint"> (active)</span>}
                  </li>
                ))}
              </ul>
              <p className="small muted" style={{ margin: 0 }}>
                <strong>Delete anyway</strong> deletes this walkthrough and its other test users; these users and their messages stay for the runs that use them. To clean up those runs as well, cancel and use <strong>Clean up</strong> in the Test data section.
              </p>
            </div>
          ) : (
          <div className="stack">
            <p style={{ margin: 0 }}>The step results, notes and {w.steps.reduce((n, s) => n + s.shots.length, 0)} screenshots are removed. It cannot be undone.</p>
            {pending && (
              <p className="small muted" style={{ margin: 0 }}>
                This run still has test data to clean up. To keep the record and remove only the test data, cancel and use <strong>Clean up</strong> in the Test data section.
              </p>
            )}
            {created > 0 && (
              <label className="sb-check">
                <input type="checkbox" checked={withUsers} onChange={(e) => setWithUsers(e.target.checked)} /> Also delete the {created} test user{created === 1 ? '' : 's'} it created and their messages
              </label>
            )}
            {created > 0 && withUsers && (
              <p className="small muted" style={{ margin: 0 }}>
                Users with a Keep pin stay. If another run still needs a user, you are asked first.
              </p>
            )}
            {pending && !(created > 0 && withUsers) && (
              <p className="small" style={{ margin: 0, color: 'var(--warn)' }}>
                The test data stays: its users and their messages are no longer traceable to a run, and no cleanup will list them.
              </p>
            )}
          </div>
          )}
        </Modal>
      )}
    </Drawer>
  );
}
