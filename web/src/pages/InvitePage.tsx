import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { inviteApi, roleLabel, useAuth, type InviteInfo } from '../auth';
import { fmtDateTime } from '../components/ui';
import { AuthFrame, PasswordInput, useDocTitle } from './LoginPage';
import '../styles/team.css';

const MIN = 8;

/**
 * /invite#<token> (Teams): accept an invite link. Public: shown signed out too. The token stays in the fragment, so
 * it never reaches a server log; it is read once and the fragment is cleared.
 */
export default function InvitePage() {
  const auth = useAuth();
  const nav = useNavigate();
  const [token] = useState(() => decodeURIComponent(window.location.hash.replace(/^#/, '')).trim());
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  useDocTitle('Join stubyard');

  useEffect(() => {
    if (!token) {
      setCheckError('This link has no invite code. Open the full link you were sent.');
      return;
    }
    let live = true;
    inviteApi
      .check(token)
      .then((i) => {
        if (!live) return;
        setInfo(i);
        setName(i.name ?? '');
        setTimeout(() => nameRef.current?.focus(), 0);
      })
      .catch((e: Error & { status?: number }) => live && setCheckError(e.status === 404 ? 'This invite link is not valid any more: it was used, revoked or has expired. Ask your stubyard admin for a new one.' : e.message));
    return () => {
      live = false;
    };
  }, [token]);

  const submit = async () => {
    if (!info) return;
    if (password.length < MIN) return setError(`The password needs at least ${MIN} characters.`);
    if (password !== confirm) return setError('The two passwords do not match.');
    setBusy(true);
    setError(null);
    try {
      await inviteApi.accept({ token, name: name.trim(), password, ...(info.email ? {} : { email: email.trim() }) });
      window.history.replaceState(null, '', '/');
      nav('/', { replace: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame>
      {checkError ? (
        <div className="card login-card" role="alert">
          <div className="login-head">
            <h1>Invite not valid</h1>
            <p className="muted">{checkError}</p>
          </div>
          <a className="btn login-submit" href="/">
            {auth.user ? 'Go to stubyard' : 'Go to sign in'}
          </a>
        </div>
      ) : !info ? (
        <div className="card login-card">
          <p className="muted">Checking the invite…</p>
        </div>
      ) : (
        <form
          className="card login-card"
          aria-labelledby="invite-title"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="login-head">
            <h1 id="invite-title">Join stubyard</h1>
            <p className="muted">
              {info.project ? (
                <>
                  You are invited to <strong>{info.project.name}</strong>
                  {info.projectRole && <> as {roleLabel(info.projectRole)}</>}.
                </>
              ) : info.role === 'admin' ? (
                <>You are invited as an instance admin.</>
              ) : (
                <>You are invited to this stubyard.</>
              )}{' '}
              Choose your name and password.
            </p>
          </div>
          {auth.user && (
            <p className="login-notice" role="status">
              You are signed in as {auth.user.email}. Accepting signs you in as the new account.
            </p>
          )}
          {info.email ? (
            <label className="field">
              <span>E-mail</span>
              <input value={info.email} readOnly aria-readonly="true" autoComplete="username" />
            </label>
          ) : (
            <label className="field">
              <span>E-mail</span>
              <input type="email" name="email" autoComplete="username" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
          )}
          <label className="field">
            <span>Name</span>
            <input ref={nameRef} name="name" autoComplete="name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span>
              Password <span className="hint">At least {MIN} characters</span>
            </span>
            <PasswordInput name="new-password" autoComplete="new-password" minLength={MIN} value={password} onChange={setPassword} />
          </label>
          <label className="field">
            <span>Repeat the password</span>
            <PasswordInput name="confirm-password" autoComplete="new-password" minLength={MIN} value={confirm} onChange={setConfirm} />
          </label>
          {error && (
            <p className="error-box login-error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="btn primary login-submit" disabled={busy || !name.trim() || !password || !confirm || (!info.email && !email.trim())}>
            {busy ? 'Creating your account…' : 'Create account and sign in'}
          </button>
          <p className="muted small invite-expiry">This invite is valid until {fmtDateTime(info.expiresAt)} and works once.</p>
        </form>
      )}
    </AuthFrame>
  );
}
