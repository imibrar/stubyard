// Login step (§6.7): Go to login, Fill login (username + password, highlight the submit button), then the 2FA
// wait: poll the code field until it shows, fetch the TOTP code (or wait for the OTP message) and type it in.
// The human clicks Log in and Verify.
import { useEffect, useState } from 'react';
import { getTotpCode } from '@stubyard/client/authenticators';
import { waitForMessagePath } from '@stubyard/client/messages';
import { updateStep } from '@stubyard/client/walkthroughs';
import { ErrorBox, useAbortable, useAction, usePanel } from '../context';
import { totpDelayMs } from '../state';
import { openUrl, samePage, sendToTab, sleep } from '../tabs';
import type { ResolvedOf, StepProps } from './StepCard';

const TWO_FACTOR_WAIT_MS = 5 * 60_000;

export function LoginControls({ t, w, step, resolved, apply, quick }: StepProps<ResolvedOf<'login'>>) {
  const p = usePanel();
  const act = useAction();
  const twoFa = useAction();
  const abort = useAbortable();
  const [status, setStatus] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [code, setCode] = useState<{ code: string; validUntil: number } | null>(null);
  const tf = resolved.twoFactor;
  const url = resolved.url;
  const here = !!url && !!p.tab && samePage(p.tab.url, url);

  const setField = async (tabId: number, selector: string, value: string, what: string) => {
    const r = await sendToTab(tabId, { type: 'setValue', selector, value });
    if (!r.ok) throw new Error(`Could not fill the ${what} (${selector}): ${r.error ?? 'not found'}`);
  };

  const runTwoFactor = () =>
    twoFa.run('2fa', async () => {
      if (tf.kind === 'none' || !p.tab) return;
      const signal = abort.start();
      const tabId = p.tab.id;
      const deadline = Date.now() + TWO_FACTOR_WAIT_MS;
      setCode(null);
      setStatus('Waiting for the code field…');
      for (;;) {
        if (Date.now() > deadline) throw new Error('The 2FA code field did not appear within 5 minutes.');
        try {
          const pr = await sendToTab(tabId, { type: 'probe', selector: tf.selector });
          if (pr.visible) break;
        } catch {
          /* navigating: the content script is re-injected on the next try */
        }
        await sleep(1000, signal);
      }
      let value: string;
      if (tf.kind === 'totp') {
        setStatus(`Getting the code of ${tf.label}…`);
        let c = await getTotpCode(t, tf.codePath);
        const delay = totpDelayMs(c, Date.now());
        if (delay) {
          setStatus('The code is about to expire: waiting for the next one…');
          await sleep(delay, signal);
          c = await getTotpCode(t, tf.codePath);
        }
        setCode({ code: c.code, validUntil: c.validUntil });
        value = c.code;
      } else {
        setStatus(`Waiting for the ${tf.kind === 'email-otp' ? 'email' : 'SMS'} with the code…`);
        let otp: string | null = null;
        while (!otp) {
          if (Date.now() > deadline) throw new Error('No code message arrived within 5 minutes.');
          const msg = await waitForMessagePath(t, tf.waitPath, { signal });
          otp = msg?.otp ?? null;
          if (msg && !otp) throw new Error(`The message "${msg.subject ?? msg.id}" has no code in it.`);
        }
        setCode({ code: otp, validUntil: 0 });
        value = otp;
      }
      await setField(tabId, tf.selector, value, '2FA code');
      setStatus(`Code filled. Click Verify in the page, then press ${quick ? 'Next' : 'Done'}.`);
      apply(await updateStep(t, w.id, step.id, { data: { twoFactorFilled: true } }));
    });

  useEffect(() => {
    if (twoFa.error) setStatus(null);
  }, [twoFa.error]);

  const fillLogin = () =>
    act.run('fill', async () => {
      if (!p.tab) throw new Error('No tab.');
      const tabId = p.tab.id;
      await setField(tabId, resolved.selectors.username, resolved.username, 'username');
      await setField(tabId, resolved.selectors.password, resolved.password, 'password');
      await sendToTab(tabId, { type: 'highlight', selector: resolved.selectors.submit ?? 'button[type=submit]' }).catch(() => {});
      p.notify('Click Log in in the page.');
      if (tf.kind !== 'none') void runTwoFactor();
    });

  return (
    <div className="controls">
      <dl className="creds">
        <dt>User</dt>
        <dd>
          {resolved.actor?.name ?? '?'} <span className="muted">({resolved.actor?.role})</span>
        </dd>
        <dt>Username</dt>
        <dd>
          <code>{resolved.username}</code> <button className="link" onClick={() => void navigator.clipboard.writeText(resolved.username)}>copy</button>
        </dd>
        <dt>Password</dt>
        <dd>
          <code>{showPassword ? resolved.password : '••••••••'}</code>{' '}
          <button className="link" onClick={() => setShowPassword((s) => !s)}>{showPassword ? 'hide' : 'show'}</button>{' '}
          <button className="link" onClick={() => void navigator.clipboard.writeText(resolved.password)}>copy</button>
        </dd>
        <dt>2FA</dt>
        <dd>{tf.kind === 'none' ? 'none' : tf.kind === 'totp' ? `authenticator app (${tf.label})` : tf.kind}</dd>
      </dl>
      <div className="row wrap">
        {url && !here && (
          <button disabled={!p.tab || !!act.busy} onClick={() => void act.run('go', () => openUrl(p.tab!.id, url))}>
            Go to login
          </button>
        )}
        <button className="primary" disabled={!p.tab || !!act.busy} onClick={() => void fillLogin()}>
          Fill login
        </button>
        {tf.kind !== 'none' &&
          (twoFa.busy ? (
            <button onClick={() => abort.cancel()}>Cancel 2FA wait</button>
          ) : (
            <button disabled={!p.tab} onClick={() => void runTwoFactor()}>Fill 2FA code</button>
          ))}
      </div>
      {status && <p className="status">{status}</p>}
      {code && <CodeView code={code.code} validUntil={code.validUntil} />}
      {step.data.twoFactorFilled === true && !status && <p className="muted small">The 2FA code was filled earlier.</p>}
      <ErrorBox error={act.error ?? twoFa.error} />
    </div>
  );
}

function CodeView({ code, validUntil }: { code: string; validUntil: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!validUntil) return;
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [validUntil]);
  const left = validUntil ? Math.max(0, Math.ceil((validUntil - now) / 1000)) : null;
  return (
    <div className="code">
      <code>{code}</code>
      {left !== null && <span className={left < 5 ? 'muted bad' : 'muted'}> valid {left}s</span>}
    </div>
  );
}
