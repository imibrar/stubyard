import { useEffect, useRef, useState } from 'react';
import { signIn, useAuth } from '../auth';
import { Icon } from '../components/people';
import { applyTheme } from '../components/StatusMenu';

/** The sign-in page of Single admin mode (Canvas design). Shown in place of any page; the URL stays. */
export default function LoginPage() {
  const auth = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState(() => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'));
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => emailRef.current?.focus(), []);
  useEffect(() => {
    const prev = document.title;
    document.title = 'Sign in · stubyard';
    return () => void (document.title = prev);
  }, []);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      setPassword('');
    } catch (e) {
      const err = e as Error & { status?: number; retryAfter?: number };
      setError(err.status === 429 && err.retryAfter ? `Too many failed attempts. Try again in ${Math.ceil(err.retryAfter / 60)} min.` : err.message);
    } finally {
      setBusy(false);
    }
  };

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try {
      localStorage.setItem('stubyard.theme', JSON.stringify(next));
    } catch {
      /* storage unavailable */
    }
    setTheme(next);
  };

  return (
    <div className="login-page">
      <button type="button" className="icon-btn login-theme" onClick={toggleTheme} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} aria-label="Switch theme">
        <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
      </button>
      <main className="login-main">
        <div className="login-brand">
          <img src="/brand/stubyard-mark.svg" alt="" width={40} height={40} />
          <span className="brand-name">
            stub<span className="brand-accent">yard</span>
          </span>
        </div>
        <form
          className="card login-card"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          aria-labelledby="login-title"
        >
          <div className="login-head">
            <h1 id="login-title">Sign in</h1>
            <p className="muted">This stubyard is protected. Sign in with the admin account.</p>
          </div>
          {auth.notice && !error && (
            <p className="login-notice" role="status">
              {auth.notice}
            </p>
          )}
          <label className="field">
            <span>E-mail</span>
            <input ref={emailRef} type="email" name="email" autoComplete="username" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="field">
            <span>Password</span>
            <span className="login-password">
              <input type={show ? 'text' : 'password'} name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
              <button type="button" className="btn ghost sm" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}>
                <Icon name={show ? 'eyeOff' : 'eye'} size={15} />
              </button>
            </span>
          </label>
          {error && (
            <p className="error-box login-error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="btn primary login-submit" disabled={busy || !email.trim() || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="muted small login-foot">
          <Icon name="lock" size={13} /> Apps under test keep using stubyard without signing in. Scripts, the browser extension and MCP use an API token.
        </p>
      </main>
    </div>
  );
}
