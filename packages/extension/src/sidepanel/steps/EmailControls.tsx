// Email step (§6.8): wait for the message (long poll, subject filter), show it, pick a link, open it.
// The chosen message and link are stored in the step's data, so a reopened panel shows them again.
// The wait is shared by the side panel and the on-page widget (run/waits.ts, step.data.emailWaitPending): the view that
// started it runs it (also while the widget is collapsed, and again after its page reloaded); the other one shows
// "Waiting … in the page widget" and picks the message up when it arrives. In the widget (compact) the picker shows at
// most 5 links, then "more in the panel".
import { useEffect, useMemo, useState } from 'react';
import { hubJson } from '@stubyard/client/http';
import { getMessage, waitForMessagePath } from '@stubyard/client/messages';
import type { HubMessage } from '@stubyard/client/storyboard-types';
import { updateStep } from '@stubyard/client/walkthroughs';
import { ErrorBox, useAction } from '../context';
import { CopyButton } from '../../run/CopyButton';
import { useStepHost } from '../../run/host';
import { useSharedWait } from '../../run/useSharedWait';
import { listPathFromWait, pickerLinks, rankLinks, subjectMatches, waitPathAfter } from '../state';
import { openUrl } from '../tabs';
import type { ResolvedOf, StepProps } from './StepCard';

/** Links shown by the compact (widget) picker before "more in the panel". */
export const COMPACT_LINKS = 5;

export function EmailControls({ t, w, step, resolved, apply }: StepProps<ResolvedOf<'email'>>) {
  const p = useStepHost();
  const act = useAction();
  const [message, setMessage] = useState<HubMessage | null>(null);
  const [chosen, setChosen] = useState<string | null>(typeof step.data.link === 'string' ? step.data.link : null);
  const timeoutSec = step.kind === 'email' ? step.timeoutSec : 60;
  const messageId = typeof step.data.messageId === 'string' ? step.data.messageId : null;

  // A message picked earlier (panel reopened), or found by the other view's wait: show it.
  useEffect(() => {
    if (!messageId || message?.id === messageId) return;
    let live = true;
    getMessage(t, messageId).then(
      (m) => {
        if (!live) return;
        setMessage(m);
        setChosen(typeof step.data.link === 'string' ? step.data.link : null);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [step.id, messageId]);

  const ranked = useMemo(() => rankLinks(message?.links ?? [], resolved.linkPattern, resolved.linkIndex), [message, resolved.linkPattern, resolved.linkIndex]);
  useEffect(() => {
    if (!chosen && ranked.preselected) setChosen(ranked.preselected);
  }, [ranked.preselected, chosen]);

  const wait = useSharedWait({
    kind: 'email',
    t,
    w,
    step,
    apply,
    ms: timeoutSec * 1000,
    task: async ({ signal, pending, mine }) => {
      let path = resolved.waitPath;
      let found: HubMessage | null = null;
      while (!found) {
        if (Date.now() > pending.until) throw new Error(`No matching ${resolved.channel} arrived within ${timeoutSec}s. Press Wait again to keep waiting.`);
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
      if (!(await mine())) return null;
      setMessage(full);
      setChosen(null);
      return { messageId: full.id, subject: full.subject, link: null };
    },
  });

  const open = (where: 'same-tab' | 'new-tab') =>
    act.run('open', async () => {
      if (!chosen || !p.tab) return;
      await openUrl(p.tab.id, chosen, where);
      apply(await updateStep(t, w.id, step.id, { data: { messageId: message?.id, subject: message?.subject ?? null, link: chosen } }));
    });

  const to = resolved.channel === 'email' ? resolved.user.email : resolved.user.phone;
  const preferred = resolved.open === 'new-tab' ? 'new-tab' : 'same-tab';
  const { shown, more } = p.compact ? pickerLinks(ranked.links, chosen ?? ranked.preselected, COMPACT_LINKS) : { shown: ranked.links, more: 0 };
  const excerptMax = p.compact ? 160 : 400;
  const what = resolved.channel === 'email' ? 'email' : 'message';

  return (
    <div className="controls">
      <div className="muted small" dir="auto">
        {resolved.channel} to <strong>{to ?? '?'}</strong>
        {resolved.subject ? ` · subject “${resolved.subject}”` : ''} · up to {timeoutSec}s
      </div>
      {wait.role === 'elsewhere' ? (
        <p className="status" role="status">
          Waiting for the {what} in {wait.where}.{' '}
          <button className="link" onClick={() => void wait.takeOver().catch(() => {})}>
            Wait here instead
          </button>
        </p>
      ) : (
        <div className="row">
          {wait.running ? (
            <button onClick={() => wait.cancel()}>Cancel</button>
          ) : (
            <button className={message ? '' : 'primary'} disabled={!!act.busy || !p.tab} onClick={() => void wait.start().catch(() => {})}>
              {message ? 'Wait again' : 'Wait for message'}
            </button>
          )}
          {wait.running && <span className="muted">Waiting…</span>}
        </div>
      )}
      {message && (
        <div className="message">
          <div dir="auto">
            <strong>{message.subject ?? '(no subject)'}</strong>
          </div>
          <div className="muted small">
            from {message.from ?? '?'} · {new Date(message.createdAt).toLocaleString()}
          </div>
          {message.otp && (
            <div>
              Code: <code>{message.otp}</code> <CopyButton text={message.otp} what="code" />
            </div>
          )}
          {message.bodyText &&
            (p.compact ? (
              <details className="excerpt-fold">
                <summary className="muted small">Show the text</summary>
                <p className="excerpt" dir="auto">
                  {message.bodyText.length > excerptMax ? `${message.bodyText.slice(0, excerptMax - 1)}…` : message.bodyText}
                </p>
              </details>
            ) : (
              <p className="excerpt" dir="auto">
                {message.bodyText.length > excerptMax ? `${message.bodyText.slice(0, excerptMax - 1)}…` : message.bodyText}
              </p>
            ))}
          {ranked.links.length > 0 ? (
            <>
              <div className="muted small">Links</div>
              <ul className="links">
                {shown.map((l) => (
                  <li key={l.url}>
                    <label title={l.url}>
                      <input type="radio" name={`link-${step.id}`} checked={chosen === l.url} onChange={() => setChosen(l.url)} /> {l.label}
                    </label>
                  </li>
                ))}
              </ul>
              {more > 0 && (
                <p className="muted small">
                  {more} more link{more === 1 ? '' : 's'} in the panel.{' '}
                  {p.openPanel && (
                    <button className="link small" onClick={p.openPanel}>
                      Choose in panel
                    </button>
                  )}
                </p>
              )}
              <div className="row wrap">
                <button className="primary" disabled={!chosen || !!act.busy} onClick={() => void open(preferred)}>
                  Open link{preferred === 'new-tab' ? ' in a new tab' : ''}
                </button>
                <button disabled={!chosen || !!act.busy} onClick={() => void open(preferred === 'new-tab' ? 'same-tab' : 'new-tab')}>
                  {preferred === 'new-tab' ? 'Open here' : 'New tab'}
                </button>
                {chosen && <CopyButton text={chosen} what="link" label="copy link" />}
              </div>
            </>
          ) : (
            <p className="muted small">The message has no links.</p>
          )}
        </div>
      )}
      <ErrorBox error={act.error ?? wait.error} />
    </div>
  );
}
