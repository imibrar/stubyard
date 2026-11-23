// Summary and sign-off (§6.10.5): the steps with status, note, captured values and shots; verdict, signed-off-by,
// note → finishWalkthrough; the printable report; abandon / close.
import { HubShot } from '../HubShot';
import { useState } from 'react';
import type { Verdict, WalkthroughView } from '@stubyard/client/storyboard-types';
import { abandonWalkthrough, finishWalkthrough, summaryUrl } from '@stubyard/client/walkthroughs';
import { RunCleanup } from '../cleanupUi';
import { ErrorBox, useAction, usePanel } from '../context';
import { shotUrl, type HubTarget } from '../hub';
import { defaultVerdict, liveSteps, openRequiredSteps, STATUS_ICON } from '../state';

export function SummaryView({ w, t, apply }: { w: WalkthroughView; t: HubTarget; apply: (w: WalkthroughView) => void }) {
  const p = usePanel();
  const act = useAction();
  const [verdict, setVerdict] = useState<Verdict>(w.signoff.verdict ?? defaultVerdict(w));
  const [by, setBy] = useState(w.signoff.signedOffBy ?? p.settings.signedOffBy);
  const [note, setNote] = useState(w.signoff.note ?? '');
  const [allowIncomplete, setAllowIncomplete] = useState(false);
  const open = openRequiredSteps(w);
  const finished = w.status !== 'active';

  const signOff = () =>
    act.run('finish', async () => {
      if (by.trim() !== p.settings.signedOffBy) await p.updateSettings({ signedOffBy: by.trim() });
      apply(await finishWalkthrough(t, w.id, { verdict, signedOffBy: by.trim(), note: note.trim() || undefined, allowIncomplete: open.length > 0 ? allowIncomplete : undefined }));
    });

  return (
    <div className="stack">
      <table className="summary">
        <tbody>
          {liveSteps(w).map((s) => (
            <tr key={s.id} className={s.status}>
              <td className="icon">{STATUS_ICON[s.status]}</td>
              <td>
                <div>{s.title}</div>
                {s.note && <div className="muted small">{s.note}</div>}
                {s.kind === 'capture' && typeof s.data.value === 'string' && (
                  <div className="small">
                    <code>{s.var}</code> = {s.data.value}
                  </div>
                )}
                {s.shots.length > 0 && (
                  <div className="shots small-shots">
                    {s.shots.map((x) => (
                      <HubShot key={x.id} src={shotUrl(t, w.id, x.id)} />
                    ))}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <section className="card">
        {finished ? (
          <p>
            {w.status === 'finished' ? (
              <>
                Signed off as <strong>{w.signoff.verdict}</strong> by {w.signoff.signedOffBy}
                {w.signoff.signedOffAt && ` on ${new Date(w.signoff.signedOffAt).toLocaleString()}`}.
              </>
            ) : (
              'This walkthrough was abandoned.'
            )}
            {w.signoff.note && <span className="muted"> {w.signoff.note}</span>}
          </p>
        ) : (
          <>
            <h3>Sign off</h3>
            <label className="field">
              <span>Verdict</span>
              <select value={verdict} onChange={(e) => setVerdict(e.target.value as Verdict)}>
                <option value="pass">pass</option>
                <option value="partial">partial</option>
                <option value="fail">fail</option>
              </select>
            </label>
            <label className="field">
              <span>Signed off by</span>
              <input value={by} onChange={(e) => setBy(e.target.value)} placeholder="Your name" />
            </label>
            <label className="field">
              <span>Note</span>
              <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
            {open.length > 0 && (
              <label className="check">
                <input type="checkbox" checked={allowIncomplete} onChange={(e) => setAllowIncomplete(e.target.checked)} /> Finish anyway: {open.length} required
                step(s) not run will be marked skipped
              </label>
            )}
            <button className="primary" disabled={!by.trim() || (open.length > 0 && !allowIncomplete) || !!act.busy} onClick={() => void signOff()}>
              Sign off
            </button>
          </>
        )}
        <div className="row wrap">
          <button onClick={() => void chrome.tabs.create({ url: summaryUrl(t, w.id) })}>Open printable report</button>
          {!finished && (
            <button
              className="danger"
              disabled={!!act.busy}
              onClick={() => confirm('Abandon this walkthrough?') && void act.run('abandon', async () => apply(await abandonWalkthrough(t, w.id, note.trim() || undefined)))}
            >
              Abandon
            </button>
          )}
          {finished && <button onClick={() => void p.openWalkthrough(null)}>Close</button>}
        </div>
        <ErrorBox error={act.error} />
      </section>
      {finished && <RunCleanup t={t} w={w} />}
    </div>
  );
}
