// Email step (§6.8): wait for the message (long poll, subject filter), show it, pick a link, open it.
// The chosen message and link are stored in the step's data, so a reopened panel shows them again.
import { useEffect, useMemo, useState } from 'react';
import { hubJson } from '@stubyard/client/http';
import { getMessage, waitForMessagePath } from '@stubyard/client/messages';
import type { HubMessage } from '@stubyard/client/storyboard-types';
import { updateStep } from '@stubyard/client/walkthroughs';
import { ErrorBox, useAbortable, useAction } from '../context';
import { useStepHost } from '../../run/host';
import { listPathFromWait, rankLinks, subjectMatches, waitPathAfter } from '../state';
import { openUrl } from '../tabs';
import type { ResolvedOf, StepProps } from './StepCard';

export function EmailControls({ t, w, step, resolved, apply }: StepProps<ResolvedOf<'email'>>) {
  const p = useStepHost();
  const act = useAction();
  const abort = useAbortable();
  const [message, setMessage] = useState<HubMessage | null>(null);
  const [chosen, setChosen] = useState<string | null>(typeof step.data.link === 'string' ? step.data.link : null);
  const timeoutSec = step.kind === 'email' ? step.timeoutSec : 60;

  // A message picked earlier (panel reopened): show it again.
  useEffect(() => {
    const id = step.data.messageId;
    if (typeof id !== 'string' || message) return;
    getMessage(t, id).then(setMessage, () => {});
  }, [step.id]);

  const ranked = useMemo(() => rankLinks(message?.links ?? [], resolved.linkPattern, resolved.linkIndex), [message, resolved.linkPattern, resolved.linkIndex]);
  useEffect(() => {
    if (!chosen && ranked.preselected) setChosen(ranked.preselected);
  }, [ranked.preselected, chosen]);

  const wait = () =>
    act.run('wait', async () => {
      const signal = abort.start();
      const deadline = Date.now() + timeoutSec * 1000;
      let path = resolved.waitPath;
      let found: HubMessage | null = null;
      while (!found) {
        if (Date.now() > deadline) throw new Error(`No matching ${resolved.channel} arrived within ${timeoutSec}s. Press Wait again to keep waiting.`);
        const msg = await waitForMessagePath(t, path, { signal });
        if (!msg) continue;
        if (subjectMatches(msg.subject, resolved.subject)) found = msg;
        else {
          // The newest message does not match: an older one since the step started may; else wait for a newer one.
          const recent = await hubJson<HubMessage[]>(t, 'GET', listPathFromWait(resolved.waitPath), undefined, { signal }).catch(() => []);
          found = (Array.isArray(recent) ? recent : []).find((m) => subjectMatches(m.subject, resolved.subject)) ?? null;
          path = waitPathAfter(resolved.waitPath, msg.cursor ?? msg.id);
        }
      }
      const full = await getMessage(t, found.id).catch(() => found);
      setMessage(full);
      setChosen(null);
      apply(await updateStep(t, w.id, step.id, { data: { messageId: full.id, subject: full.subject } }));
    });

  const open = (where: 'same-tab' | 'new-tab') =>
    act.run('open', async () => {
      if (!chosen || !p.tab) return;
      await openUrl(p.tab.id, chosen, where);
      apply(await updateStep(t, w.id, step.id, { data: { messageId: message?.id, subject: message?.subject ?? null, link: chosen } }));
    });

  const to = resolved.channel === 'email' ? resolved.user.email : resolved.user.phone;
  const preferred = resolved.open === 'new-tab' ? 'new-tab' : 'same-tab';

  return (
    <div className="controls">
      <div className="muted small">
        {resolved.channel} to <strong>{to ?? '?'}</strong>
        {resolved.subject ? ` · subject “${resolved.subject}”` : ''} · up to {timeoutSec}s
      </div>
      <div className="row">
        {act.busy === 'wait' ? (
          <button onClick={() => abort.cancel()}>Cancel</button>
        ) : (
          <button className={message ? '' : 'primary'} disabled={!!act.busy} onClick={() => void wait()}>
            {message ? 'Wait again' : 'Wait for message'}
          </button>
        )}
        {act.busy === 'wait' && <span className="muted">Waiting…</span>}
      </div>
      {message && (
        <div className="message">
          <div>
            <strong>{message.subject ?? '(no subject)'}</strong>
          </div>
          <div className="muted small">
            from {message.from ?? '?'} · {new Date(message.createdAt).toLocaleString()}
          </div>
          {message.otp && (
            <div>
              Code: <code>{message.otp}</code>
            </div>
          )}
          {message.bodyText && <p className="excerpt">{message.bodyText.length > 400 ? `${message.bodyText.slice(0, 399)}…` : message.bodyText}</p>}
          {ranked.links.length > 0 ? (
            <>
              <div className="muted small">Links</div>
              <ul className="links">
                {ranked.links.map((l) => (
                  <li key={l.url}>
                    <label title={l.url}>
                      <input type="radio" name={`link-${step.id}`} checked={chosen === l.url} onChange={() => setChosen(l.url)} /> {l.label}
                    </label>
                  </li>
                ))}
              </ul>
              <div className="row wrap">
                <button className="primary" disabled={!chosen || !!act.busy} onClick={() => void open(preferred)}>
                  Open link{preferred === 'new-tab' ? ' in a new tab' : ''}
                </button>
                <button disabled={!chosen || !!act.busy} onClick={() => void open(preferred === 'new-tab' ? 'same-tab' : 'new-tab')}>
                  {preferred === 'new-tab' ? 'Open here' : 'New tab'}
                </button>
              </div>
            </>
          ) : (
            <p className="muted small">The message has no links.</p>
          )}
        </div>
      )}
      <ErrorBox error={act.error} />
    </div>
  );
}
